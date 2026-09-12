/**
 * Termly web client - the pairing handshake and relay protocol, without any UI.
 *
 * Mirrors what the official mobile app is supposed to do: connect to
 * /ws/agent?code=..., complete the modp14 exchange, then relay encrypted input
 * and decrypt output. The UI layer subscribes through the `on` callbacks.
 */

import {
  generateKeyPair, computeSharedSecret, deriveAESKey, encrypt, decrypt,
  fingerprint, exportPrivateKey, importPrivateKey, derivePublicKey
} from './termly-crypto.js';

// The relay drops a socket that goes quiet, and phones suspend sockets whenever
// the screen locks, so reconnecting is the normal case rather than an error.
const RECONNECT_BASE = 1000;
const RECONNECT_MAX = 15000;

// A backgrounded phone can come back on a different network with a socket that
// still reports OPEN but is dead. catchup_request is the protocol's own cheap
// round-trip, so it doubles as a liveness probe - and fetches anything missed.
const PROBE_TIMEOUT = 6000;

export class TermlyClient {
  constructor(handlers = {}) {
    this.on = handlers;
    this.ws = null;
    this.keys = null;
    this.aesKey = null;
    this.sessionId = null;
    this.cliPublicKey = null;
    this.code = null;
    this.lastSeq = 0;
    this.attempt = 0;
    this.closedByUser = false;
    // The relay is reachable but the CLI behind it may not be. These are two
    // different kinds of "down" and the UI has to tell them apart.
    this.cliOnline = true;
    this.reconnectTimer = null;
    this.probeTimer = null;
    // Frames are handled one at a time - see the onmessage handler.
    this.inbox = Promise.resolve();

    this._wake = () => this.wake();
    addEventListener('online', this._wake);
    addEventListener('visibilitychange', () => { if (!document.hidden) this.wake(); });
  }

  get wsBase() {
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${scheme}//${location.host}`;
  }

  get connected() {
    return this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  /** State the UI should persist so a cold start can resume. */
  snapshot() {
    if (!this.sessionId || !this.keys || !this.cliPublicKey) return null;
    return {
      sessionId: this.sessionId,
      privateKey: exportPrivateKey(this.keys.privateKey),
      cliPublicKey: this.cliPublicKey,
      lastSeq: this.lastSeq
    };
  }

  connect(code) {
    this.code = code;
    this.closedByUser = false;
    // A fresh pairing needs a fresh key pair; a resume must keep the old one,
    // because the CLI still holds the key derived from it.
    this.keys = generateKeyPair();
    this.aesKey = null;
    this.sessionId = null;
    this.cliPublicKey = null;
    this.lastSeq = 0;
    this._open(`${this.wsBase}/ws/agent?code=${encodeURIComponent(code)}`);
  }

  /** Resume a session saved before a reload, without a pairing code. */
  async restore(saved) {
    const privateKey = importPrivateKey(saved.privateKey);
    this.keys = { privateKey, publicKey: derivePublicKey(privateKey) };
    this.cliPublicKey = saved.cliPublicKey;
    this.sessionId = saved.sessionId;
    this.lastSeq = saved.lastSeq || 0;
    this.closedByUser = false;

    // Re-derive rather than store the AES key: one secret at rest, not two.
    this.aesKey = await deriveAESKey(computeSharedSecret(privateKey, saved.cliPublicKey));

    this.emit('paired', {
      sessionId: this.sessionId,
      fingerprint: await fingerprint(saved.cliPublicKey),
      restored: true
    });
    this._open(`${this.wsBase}/ws/agent?sessionId=${encodeURIComponent(this.sessionId)}`);
  }

  /** Called when the tab becomes visible or the network returns. */
  wake() {
    if (this.closedByUser || !this.sessionId) return;
    if (!this.connected) {
      this._reconnectNow();
      return;
    }
    this._probe();
  }

  _probe() {
    if (this.probeTimer) return;
    this.send({ type: 'catchup_request', sessionId: this.sessionId, lastSeq: this.lastSeq });
    this.probeTimer = setTimeout(() => {
      this.probeTimer = null;
      this.emit('log', 'liveness probe timed out, forcing reconnect');
      // Close it ourselves so onclose runs the normal reconnect path.
      try { this.ws.close(); } catch { /* already gone */ }
    }, PROBE_TIMEOUT);
  }

  _clearProbe() {
    if (this.probeTimer) {
      clearTimeout(this.probeTimer);
      this.probeTimer = null;
    }
  }

  _open(url) {
    this.emit('status', this.aesKey ? 'resuming' : 'connecting');
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      // On a resume the session is already paired, so re-sending mobile_pairing
      // would hand the CLI a public key it never agreed to.
      if (this.aesKey) {
        this.emit('status', 'resuming');
        this.send({ type: 'catchup_request', sessionId: this.sessionId, lastSeq: this.lastSeq });
        return;
      }
      this.send({
        type: 'mobile_pairing',
        code: this.code,
        publicKey: this.keys.publicKey,
        deviceName: deviceName(),
        timestamp: new Date().toISOString()
      });
    };

    /*
     * One frame at a time.
     *
     * Handling a frame is asynchronous - output waits on an AES-GCM decrypt,
     * pairing waits on a DH derive - so calling the handler straight from
     * onmessage runs every frame in a burst concurrently, and they finish in
     * whatever order the crypto happens to finish in. Short frames finish
     * first, reliably: `cat` a large file and the next shell prompt is written
     * into the middle of it. Worse, the first output after pairing could be
     * decrypted before the key it needs existed, and was then dropped in
     * silence.
     *
     * Chaining keeps the wire order. The catch is what keeps the chain usable:
     * one rejected handler must not wedge every frame after it.
     */
    ws.onmessage = ev => {
      this.inbox = this.inbox.then(() => {
        // Queued work can outlive the socket it came from. Acting on a frame
        // from a connection already replaced would rewrite the state of the
        // live one.
        if (ws !== this.ws) return;
        return this._handle(ev.data);
      }).catch(err => this.emit('log', `handler failed: ${err?.message || err}`));
    };

    ws.onclose = ev => {
      this._clearProbe();
      if (ws !== this.ws) return;
      this.emit('status', 'disconnected');
      // 4000 is the relay's own rejection. Retrying a rejected pairing code or
      // a dead session only burns the rate limit.
      if (ev.code === 4000) {
        const { error, message } = parseCloseReason(ev.reason);
        if (error === 'session_not_found' || error === 'session_expired') {
          this.emit('sessionLost', message);
        } else {
          this.emit('fatal', message);
        }
        return;
      }
      if (!this.closedByUser) this._scheduleReconnect();
    };

    ws.onerror = () => this.emit('log', 'socket error');
  }

  _scheduleReconnect() {
    // Without a session there is nothing to resume - the code is single-use and
    // has already been consumed by the pairing.
    if (!this.sessionId) {
      this.emit('fatal', 'Connection lost before pairing completed.');
      return;
    }
    if (this.reconnectTimer) return;

    // Offline is not a failure to retry against; `online` will wake us.
    if (navigator.onLine === false) {
      this.emit('status', 'offline');
      return;
    }

    const delay = Math.min(RECONNECT_BASE * 2 ** this.attempt++, RECONNECT_MAX);
    this.emit('status', `reconnecting in ${Math.round(delay / 1000)}s`);
    this.reconnectTimer = setTimeout(() => this._reconnectNow(), delay);
  }

  // Waiting out a 15s backoff is infuriating when you are standing there
  // watching it, and the user tapping "retry" is evidence the network is back.
  retryNow() {
    if (this.connected) { this._probe(); return; }
    this.attempt = 0;
    this._reconnectNow();
  }

  _reconnectNow() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.closedByUser || !this.sessionId) return;
    if (this.connected) return;
    this._open(`${this.wsBase}/ws/agent?sessionId=${encodeURIComponent(this.sessionId)}`);
  }

  async _handle(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      this.emit('log', 'unparseable message');
      return;
    }

    switch (msg.type) {
      case 'pairing_ack': {
        this.sessionId = msg.sessionId;
        if (!msg.publicKey) {
          this.emit('fatal', 'Relay sent no CLI public key.');
          return;
        }
        this.cliPublicKey = msg.publicKey;
        this.aesKey = await deriveAESKey(computeSharedSecret(this.keys.privateKey, msg.publicKey));
        // Before `paired`, not after: that handler is where the app first
        // measures itself, and it should already know whose grid to draw.
        this._announceSize(msg);
        this.emit('paired', {
          sessionId: msg.sessionId,
          fingerprint: await fingerprint(msg.publicKey),
          restored: false
        });
        this.emit('status', 'connected');
        this.emit('persist');
        break;
      }

      case 'output': {
        const text = await this._plain(msg);
        if (text === null) break;
        const missed = this._gap(msg.seq);
        if (missed) this.emit('gap', missed);
        if (msg.seq) this.lastSeq = Math.max(this.lastSeq, msg.seq);
        this.emit('output', text);
        break;
      }

      case 'catchup_batch': {
        const resumesAt = (msg.batch || []).find(item => item.seq)?.seq;
        const behind = this._gap(resumesAt);
        if (behind) this.emit('gap', behind);
        let chunk = '';
        for (const item of msg.batch || []) {
          const text = await this._plain(item);
          if (text === null) continue;
          if (item.seq) this.lastSeq = Math.max(this.lastSeq, item.seq);
          chunk += text;
        }
        // One write per batch instead of one per message: replaying a full
        // buffer message-by-message visibly stutters on a phone.
        if (chunk) this.emit('output', chunk);
        break;
      }

      case 'sync_complete':
        this._clearProbe();
        this.lastSeq = Math.max(this.lastSeq, msg.currentSeq || 0);
        this.emit('status', 'connected');
        this.emit('persist');
        this.emit('log', `synced to seq ${this.lastSeq}`);
        break;

      case 'cli_disconnected':
        this.cliOnline = false;
        this.emit('cliOffline');
        this.emit('status', 'CLI offline');
        break;

      case 'cli_reconnected':
        this.cliOnline = true;
        this.emit('cliOnline');
        this.emit('status', 'connected');
        // Output produced between the CLI's restart and this notice was never
        // relayed to us, so pull it rather than leaving a hole in the scrollback.
        this._probe();
        break;

      // The size of the terminal the CLI is running in. Sent again whenever a
      // socket attaches, because a restored session never sees another
      // pairing_ack and would otherwise have nothing to draw but a guess.
      case 'session_info':
        this._announceSize(msg);
        break;

      case 'client_connected':
      case 'pairing_complete':
        break;

      default:
        this.emit('log', `unhandled ${msg.type}`);
    }
  }

  /*
   * How many chunks never made it, counted from the sequence numbers.
   *
   * Sequence numbers are the only record of what the CLI produced. Its replay
   * buffer holds 100 KB, so after a long disconnection - or after the relay
   * drops a phone that stopped keeping up - what comes back starts later than
   * where the phone left off. Splicing that on silently is worse than showing a
   * hole, because the scrollback then reads as continuous text that never
   * existed in that order.
   *
   * A sequence at or below where we already are is not a gap: that is the CLI
   * having restarted and begun counting from one again, which the resume path
   * already deals with. Neither is anything before the first frame of a session,
   * where there is no earlier position to be missing from.
   */
  _gap(nextSeq) {
    if (!nextSeq || !this.lastSeq) return 0;
    return nextSeq > this.lastSeq + 1 ? nextSeq - this.lastSeq - 1 : 0;
  }

  // Output arrives encrypted once pairing is done, but catchup entries written
  // before the key existed can still be plain.
  async _plain(msg) {
    if (!msg.encrypted) return msg.data ?? '';
    if (!this.aesKey) return null;
    try {
      return await decrypt(msg.data, msg.iv, this.aesKey);
    } catch {
      this.emit('log', 'failed to decrypt a chunk');
      return null;
    }
  }

  async sendInput(text) {
    if (!this.aesKey) return false;
    if (!this.connected) {
      // Silently dropping keystrokes is worse than saying the line is down.
      this.emit('inputDropped', 'Line is down');
      this.wake();
      return false;
    }
    if (!this.cliOnline) {
      // The relay would accept this and drop it on the floor: there is no CLI
      // socket to forward it to.
      this.emit('inputDropped', 'CLI is offline');
      return false;
    }
    const sealed = await encrypt(text, this.aesKey);
    this.send({ type: 'input', sessionId: this.sessionId, encrypted: true, ...sealed });
    return true;
  }

  /*
   * A relay that knows nothing says nothing, and older ones do not send this at
   * all - so anything that is not a pair of positive integers is dropped here
   * rather than passed up as a size the UI would trust.
   */
  _announceSize(msg) {
    const cols = Number(msg.cols), rows = Number(msg.rows);
    if (!Number.isInteger(cols) || !Number.isInteger(rows)) return;
    if (cols < 1 || rows < 1 || cols > 1000 || rows > 1000) return;
    this.emit('cliSize', { cols, rows });
  }

  sendResize(cols, rows) {
    if (!this.sessionId) return;
    this.send({ type: 'resize', sessionId: this.sessionId, cols, rows });
  }

  send(obj) {
    if (this.connected) this.ws.send(JSON.stringify(obj));
  }

  disconnect() {
    this.closedByUser = true;
    this._clearProbe();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    removeEventListener('online', this._wake);
    if (this.ws) {
      try { this.ws.close(1000, 'client closed'); } catch { /* already gone */ }
    }
  }

  emit(event, payload) {
    const fn = this.on[event];
    if (fn) fn(payload);
  }
}

function parseCloseReason(reason) {
  try {
    const parsed = JSON.parse(reason);
    return { error: parsed.error, message: parsed.message || parsed.error || reason };
  } catch {
    return { error: null, message: reason || 'Connection refused by relay.' };
  }
}

function deviceName() {
  const ua = navigator.userAgent;
  if (/iPhone|iPad/.test(ua)) return 'iOS browser';
  if (/Android/.test(ua)) return 'Android browser';
  return 'Web browser';
}
