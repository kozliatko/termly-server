#!/usr/bin/env node
/**
 * Mock Termly mobile client - exercises the full pairing + E2EE + relay flow
 * against a local server, so the server can be tested without an iPhone.
 *
 * Usage: node mock-mobile.js <PAIRING_CODE> [ws://host:port]
 */

const WebSocket = require('ws');
const crypto = require('crypto');

const code = process.argv[2];
const base = process.argv[3] || 'ws://localhost:3000';

if (!code) {
  console.error('usage: node mock-mobile.js <CODE> [wsBase]');
  process.exit(2);
}

// Same primitives as lib/crypto in the CLI: RFC 3526 group 14 + HKDF-SHA256.
const dh = crypto.getDiffieHellman('modp14');
const myPublicKey = dh.generateKeys().toString('base64');

let aesKey = null;
let sessionId = null;
const received = [];
const checks = [];

function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
}

function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    data: Buffer.concat([body, cipher.getAuthTag()]).toString('base64'),
    iv: iv.toString('base64')
  };
}

function decrypt(dataB64, ivB64) {
  const combined = Buffer.from(dataB64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(combined.subarray(-16));
  return Buffer.concat([decipher.update(combined.subarray(0, -16)), decipher.final()]).toString('utf8');
}

const url = `${base}/ws/agent?code=${code}`;
console.log(`[mobile] connecting to ${url}`);
const ws = new WebSocket(url);

ws.on('open', () => {
  console.log('[mobile] connected, sending mobile_pairing');
  ws.send(JSON.stringify({
    type: 'mobile_pairing',
    code,
    publicKey: myPublicKey,
    deviceName: 'Mock iPhone',
    timestamp: new Date().toISOString()
  }));
});

ws.on('message', raw => {
  const msg = JSON.parse(raw.toString());

  switch (msg.type) {
    case 'pairing_ack': {
      sessionId = msg.sessionId;
      check('pairing_ack received', true, `sessionId=${String(sessionId).slice(0, 8)}`);
      check('pairing_ack carries CLI public key', Boolean(msg.publicKey));

      const shared = dh.computeSecret(Buffer.from(msg.publicKey, 'base64'));
      aesKey = crypto.hkdfSync('sha256', shared, '', 'termly-session-key', 32);
      aesKey = Buffer.from(aesKey);
      check('AES key derived', aesKey.length === 32, `${aesKey.length} bytes`);

      // The CLI only streams output once it has seen client_connected, which
      // the server sends on our behalf. Give the PTY a moment, then type.
      setTimeout(() => {
        const enc = encrypt('echo TERMLY_RELAY_OK\r');
        console.log('[mobile] sending input: echo TERMLY_RELAY_OK');
        ws.send(JSON.stringify({ type: 'input', sessionId, encrypted: true, ...enc }));
      }, 1500);

      // Then ask for everything from the start of the buffer.
      setTimeout(() => {
        console.log('[mobile] sending catchup_request lastSeq=0');
        ws.send(JSON.stringify({ type: 'catchup_request', sessionId, lastSeq: 0 }));
      }, 4000);
      break;
    }

    case 'output': {
      let text;
      try {
        text = msg.encrypted ? decrypt(msg.data, msg.iv) : msg.data;
      } catch (err) {
        check('output decrypts', false, err.message);
        break;
      }
      received.push({ seq: msg.seq, text });
      process.stdout.write(`[out seq=${msg.seq}] ${JSON.stringify(text.slice(0, 120))}\n`);
      break;
    }

    case 'catchup_batch': {
      let ok = true;
      let count = 0;
      for (const item of msg.batch || []) {
        try {
          if (item.encrypted) decrypt(item.data, item.iv);
          count++;
        } catch { ok = false; }
      }
      check(`catchup_batch ${msg.batchIndex + 1}/${msg.totalBatches} decrypts`, ok, `${count} messages`);
      break;
    }

    case 'sync_complete':
      check('sync_complete received', true, `currentSeq=${msg.currentSeq}`);
      finish();
      break;

    case 'cli_disconnected':
      console.log('[mobile] cli_disconnected');
      break;

    default:
      console.log(`[mobile] <- ${msg.type}`);
  }
});

ws.on('close', (codeNum, reason) => {
  console.log(`[mobile] closed ${codeNum} ${reason}`);
  finish();
});

ws.on('error', err => {
  check('websocket error-free', false, err.message);
  finish();
});

let done = false;
function finish() {
  if (done) return;
  done = true;

  const decrypted = received.map(r => r.text).join('');
  check('live output relayed and decrypted', received.length > 0, `${received.length} chunks`);
  check('input reached the PTY', decrypted.includes('TERMLY_RELAY_OK'),
    decrypted.includes('TERMLY_RELAY_OK') ? 'echo visible in output' : 'marker not found');

  const seqs = received.map(r => r.seq);
  check('sequence numbers increase', seqs.every((s, i) => i === 0 || s > seqs[i - 1]),
    seqs.length ? `${seqs[0]}..${seqs[seqs.length - 1]}` : 'none');

  const failed = checks.filter(c => !c.ok);
  console.log(`\n=== ${checks.length - failed.length}/${checks.length} checks passed ===`);

  try { ws.close(); } catch {}
  process.exit(failed.length ? 1 : 0);
}

setTimeout(() => { console.log('[mobile] timeout'); finish(); }, 20000);
