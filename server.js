#!/usr/bin/env node
/**
 * termly-local-server — self-hosted zero-knowledge relay for the Termly CLI.
 *
 * Derived from PR #49 (termly-dev/termly-cli) by B-A-M-N, with protocol and
 * robustness fixes verified against the CLI source (v1.9.5).
 *
 * The server never sees plaintext or key material: the CLI and the web client
 * perform a Diffie-Hellman exchange through it and encrypt everything with a
 * key this process never derives. Its whole job is to pair two sockets and
 * forward JSON between them.
 */

const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const http = require('http');
const path = require('path');
const os = require('os');
const { randomUUID } = require('node:crypto');
const history = require('./history');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// The stock CLI's `local` environment is hardcoded to port 3000
// (lib/config/environment.js), so that is the only default that works without
// patching the client.
const PORT = Number(process.env.TERMLY_LOCAL_PORT || 3000);

// Binding to all interfaces exposes an unauthenticated terminal relay to the
// whole network, so it must be opted into explicitly.
const BIND = process.env.TERMLY_BIND || '127.0.0.1';

// The CLI force-closes the socket after HEARTBEAT_TIMEOUT (13s) without any
// message from us, and its own constants file documents "server pings every
// ~5s". Anything at or above 13s puts the client in a permanent reconnect loop.
const HEARTBEAT_INTERVAL = Number(process.env.TERMLY_HEARTBEAT_MS || 5000);

// The CLI's pairing UI promises "Code expires in 5 minutes".
const PAIRING_TTL = Number(process.env.TERMLY_PAIRING_TTL_MS || 5 * 60 * 1000);

// How long a paired session survives with neither side connected.
const SESSION_TTL = Number(process.env.TERMLY_SESSION_TTL_MS || 5 * 60 * 1000);

// A catchup batch carries up to 100 buffered chunks; 4 MB is comfortably above
// anything the 100 KB CircularBuffer can produce, and well below a memory risk.
const MAX_PAYLOAD = 4 * 1024 * 1024;

/*
 * How far behind a peer may fall before the relay stops holding output for it.
 *
 * `ws.send` queues whatever the socket cannot write yet, with no ceiling. A
 * phone that stops reading - a tunnel, a lift, a dying battery - keeps its
 * socket open while the CLI keeps producing, and the relay holds all of it:
 * measured at roughly 1.3 MB of process memory per MB flooded, growing without
 * limit until the process dies. One session is enough to take the relay down.
 *
 * A size alone cannot make this call, though. `cat` of a large file puts
 * megabytes into the queue of a phone that is draining it perfectly well - just
 * slower than the file is being read - and cutting that phone off is worse than
 * useless: the CLI's replay buffer is 100 KB, so a drop under a flood is exactly
 * where output is lost, and the CLI is still producing when the phone comes
 * back, so it happens again. What separates a burst from a stall is not how much
 * is queued but whether it is going down.
 *
 * So the cap is not a limit on the peer, it is a limit on the relay: cross it
 * and the relay stops reading from the other side of the session. TCP carries
 * that back to the CLI, which slows down at the source and keeps what it has not
 * sent yet, where the replay buffer is. Nothing is dropped and nothing needs
 * replaying. Only a backlog that stops moving altogether - a phone that is gone
 * rather than slow - is still cut loose, because otherwise it would hold the
 * CLI throttled forever and freeze the terminal the user is looking at.
 */
const MAX_BUFFERED = Number(process.env.TERMLY_MAX_BUFFERED_BYTES || 4 * 1024 * 1024);
const MAX_BUFFERED_MS = Number(process.env.TERMLY_MAX_BUFFERED_MS || 10000);

/*
 * Where the backlog is considered drained again, and how often it is looked at
 * while it is not. Resuming at the same mark that paused would restart the
 * source into a queue that is still full, so the two are kept apart.
 */
const RESUME_BUFFERED = Math.floor(MAX_BUFFERED / 2);
const BACKLOG_POLL_MS = 250;

const PAIRING_RATE_LIMIT = 30;              // registrations ...
const PAIRING_RATE_WINDOW = 60 * 1000;      // ... per IP per minute

// A pairing code is the only credential guarding an interactive terminal, and
// the code space is small (36^6). Guesses arrive over the WebSocket, not the
// REST API, so that is where the guessing has to be capped.
const CODE_ATTEMPT_LIMIT = 10;
const CODE_ATTEMPT_WINDOW = 60 * 1000;
// The flood ceiling over all connection attempts. Deliberately far above
// CODE_ATTEMPT_LIMIT: reaching an existing session is not the guessing surface,
// and a phone on a flaky network legitimately reconnects often.
const SESSION_ATTEMPT_LIMIT = 60;
const SESSION_ATTEMPT_WINDOW = 60 * 1000;

const CODE_PATTERN = /^[A-Z0-9]{6}$/;

// Set this only when a reverse proxy really is in front; otherwise a client can
// forge X-Forwarded-For and escape every per-IP limit below.
const TRUST_PROXY = process.env.TERMLY_TRUST_PROXY === '1';

/*
 * Origins allowed to open a WebSocket, beyond the one serving the page.
 *
 * WebSockets are not covered by the same-origin policy: any page on the web may
 * dial this relay, and the browser attaches the victim's cookies, address and
 * network position to that connection. The pairing code is the only thing
 * standing in the way, so a page that has one - or that can reach a session
 * another way - is otherwise indistinguishable from the real client.
 *
 * The CLI does not send Origin at all (`ws` omits it for non-browser clients),
 * which is what makes this checkable: a request with no Origin is not a browser
 * and is left alone; a request with one has to name an origin we serve.
 */
const ALLOWED_ORIGINS = new Set(
  (process.env.TERMLY_ALLOWED_ORIGINS || '')
    .split(',')
    .map(o => o.trim().replace(/\/$/, ''))
    .filter(Boolean)
);

// Message types only ever produced by one side. Used to correct a
// misclassified peer.
const CLI_ONLY = new Set(['output', 'catchup_batch', 'sync_complete', 'pong']);
const MOBILE_ONLY = new Set(['mobile_pairing', 'input', 'resize', 'catchup_request']);

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const LOG_LEVEL = LEVELS[process.env.TERMLY_LOG_LEVEL] ?? LEVELS.info;

function log(level, tag, message) {
  if (LEVELS[level] > LOG_LEVEL) return;
  const stamp = new Date().toISOString().slice(11, 23);
  const stream = level === 'error' || level === 'warn' ? console.error : console.log;
  stream(`${stamp} [${tag}] ${message}`);
}

const logger = {
  error: (tag, m) => log('error', tag, m),
  warn: (tag, m) => log('warn', tag, m),
  info: (tag, m) => log('info', tag, m),
  debug: (tag, m) => log('debug', tag, m)
};

// ---------------------------------------------------------------------------
// Session registry
// ---------------------------------------------------------------------------

const sessionsByCode = new Map();   // pairing code -> Session (dropped once paired)
const sessionsById = new Map();     // session id -> Session

/**
 * A terminal dimension, or null.
 *
 * Null is a perfectly good answer: an older CLI does not send one, and a client
 * that is told nothing measures its own window, which is what it has always
 * done. Passing on a string or a negative would be worse than saying nothing -
 * the client would trust it and draw a grid nobody can use.
 */
function terminalExtent(value) {
  return Number.isInteger(value) && value > 0 && value <= 1000 ? value : null;
}

class Session {
  constructor(fields) {
    this.sessionId = randomUUID();
    this.code = fields.code;
    this.projectName = fields.projectName || null;
    this.workingDir = fields.workingDir || null;
    this.computerName = fields.computerName || null;
    this.aiTool = fields.aiTool || 'unknown';
    this.aiToolVersion = fields.aiToolVersion || '0.0.0';
    this.tools = fields.tools || [];

    // The size of the terminal `termly start` was run in. The relay does not
    // use it - it carries it, so the phone can draw that grid instead of
    // imposing its own on a pty the user is also sitting in front of.
    this.cols = terminalExtent(fields.cols);
    this.rows = terminalExtent(fields.rows);

    this.cliPublicKey = fields.publicKey;
    this.mobilePublicKey = null;
    this.paired = false;
    this.pairedAt = null;

    this.cliWs = null;
    this.mobileWs = null;

    // Highest seq the mobile has confirmed receiving, learned from its
    // catchup_request. Purely informational - the CLI owns the real buffer.
    this.lastMobileSeq = 0;

    this.createdAt = Date.now();

    this.heartbeatTimer = null;
    this.reapTimer = null;
    this.pairingTimer = null;
    this.lastPong = Date.now();
  }

  destroy(reason) {
    history.record('closed', {
      sessionId: this.sessionId,
      paired: this.paired,
      durationMs: Date.now() - this.createdAt,
      reason
    });

    clearInterval(this.heartbeatTimer);
    clearTimeout(this.reapTimer);
    clearTimeout(this.pairingTimer);
    this.heartbeatTimer = this.reapTimer = this.pairingTimer = null;

    sessionsByCode.delete(this.code);
    sessionsById.delete(this.sessionId);

    logger.info('cleanup', `Session ${short(this.sessionId)} removed (${reason})`);
  }
}

function short(id) {
  return String(id).slice(0, 8);
}

// Close a socket with a reason the CLI can parse. lib/network/websocket.js
// JSON-decodes the close reason and recognises session_expired,
// session_not_found and pairing_expired, exiting with a clear message instead
// of retrying forever.
function closeWithReason(ws, error, message) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.close(4000, JSON.stringify({ error, message }));
}

// The upgrade request carries no Express helpers, so the proxy header has to be
// read directly. The left-most entry is the original client.
function clientAddress(req) {
  if (TRUST_PROXY) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) return String(forwarded).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function sendJSON(ws, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(payload));
  throttleSource(ws);
  return true;
}

/** The socket whose output is filling this one's queue. */
function sourceFor(target) {
  const session = target._session;
  if (!session) return null;
  return target._role === 'cli' ? session.mobileWs : session.cliWs;
}

function pauseSocket(ws) {
  // `ws._socket` is the TCP socket underneath. Not reading it is the whole
  // mechanism: the kernel window closes, and the sender finds out without a
  // single byte of protocol being added for it.
  if (ws?._socket && !ws._socket.isPaused()) ws._socket.pause();
}

function resumeSocket(ws) {
  if (ws?._socket && ws._socket.isPaused()) ws._socket.resume();
}

/**
 * Stop reading the source once this peer is far enough behind, and start
 * watching for it to catch up.
 */
function throttleSource(target) {
  if (target._backlogTimer || target.bufferedAmount <= MAX_BUFFERED) return;

  const source = sourceFor(target);
  if (!source) return;

  pauseSocket(source);
  target._behindSince = Date.now();
  target._behindLow = target.bufferedAmount;
  target._backlogTimer = setInterval(() => watchBacklog(target), BACKLOG_POLL_MS);
  // The relay should not be held open by a poll that is only housekeeping.
  target._backlogTimer.unref?.();
}

/*
 * Decide, every poll, whether the peer is slow or gone.
 *
 * Slow means the backlog is coming down: the source stays paused until it is
 * under the low-water mark, and then everything continues. Gone means it has not
 * reached a new low in MAX_BUFFERED_MS, and the only way to free both the memory
 * and the CLI is to destroy the socket.
 *
 * `terminate` rather than `close`: a close frame queues behind everything
 * already waiting, so asking a peer that is not reading to close politely frees
 * nothing. Destroying the socket is also what the client reads as a dropped
 * connection, which is the state it already knows how to recover from -
 * reconnect, ask for the missing seqs, carry on.
 */
function watchBacklog(target) {
  const behind = target.bufferedAmount;

  if (target.readyState !== WebSocket.OPEN || behind <= RESUME_BUFFERED) {
    return releaseSource(target);
  }

  const now = Date.now();
  if (behind < target._behindLow) {
    // It is going down. That is not a stall, however far behind it still is.
    target._behindLow = behind;
    target._behindSince = now;
  }

  if (now - target._behindSince < MAX_BUFFERED_MS) return;

  logger.warn('ws', `${target._peerId || 'peer'} is ${Math.round(behind / 1024)} KB behind`
    + ` and has not moved for ${now - target._behindSince} ms - dropping it to resync`);
  target.terminate();
  releaseSource(target);
}

/** Let the source run again, whether the peer caught up or was cut loose. */
function releaseSource(target) {
  clearInterval(target._backlogTimer);
  target._backlogTimer = null;
  target._behindSince = 0;
  target._behindLow = 0;
  resumeSocket(sourceFor(target));
}

// ---------------------------------------------------------------------------
// REST API
// ---------------------------------------------------------------------------

const app = express();
app.disable('x-powered-by');

// Only when explicitly told there is a proxy in front: trusting the header
// unconditionally would let any client forge its own source address.
if (TRUST_PROXY) {
  app.set('trust proxy', true);
}

// The web client persists the session's Diffie-Hellman private key in
// localStorage, which turns XSS from an annoyance into a key-disclosure bug.
// The page is built to need no inline script and no inline style, so the policy
// can be strict rather than decorative.
const CSP_BASE = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "media-src 'self' blob:",
  "worker-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'"
];

// CSP3 says connect-src 'self' also covers the same-origin ws:/wss: URL, but
// Safari did not implement that until 15.4 - it blocked the socket and reported
// nothing to the page. Since this app is aimed at phones, name the origin
// explicitly rather than rely on a rule older iOS gets wrong.
const HOST_RE = /^[A-Za-z0-9.\-]+(:\d{1,5})?$/;

function cspFor(req) {
  const host = req.headers.host;
  const sockets = HOST_RE.test(host || '')
    ? ` ws://${host} wss://${host}`
    : '';
  return [...CSP_BASE, `connect-src 'self'${sockets}`].join('; ');
}

app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', cspFor(req));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // The QR scanner needs the camera; nothing else needs anything.
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
  // Only meaningful once the connection is already TLS, which is the proxy's job
  // to tell us about.
  if (TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
});

app.use(express.json({ limit: '256kb' }));

app.use((req, res, next) => {
  res.on('finish', () => {
    const level = res.statusCode === 404 ? 'warn' : 'debug';
    logger[level]('http', `${req.method} ${req.originalUrl} -> ${res.statusCode} from ${clientAddress(req)}`);
  });
  next();
});

const rateBuckets = new Map();

/*
 * Fixed-window counters, one small object per bucket.
 *
 * This used to keep every hit as a timestamp and re-filter the whole array on
 * each call, which made the limiter quadratic in the number of attempts - and
 * it appended even for callers it had already rejected, so an attacker grew
 * their own bucket with every refused request. 50k attempts inside one window
 * cost ~49 s of a single-threaded event loop: the limiter was a better denial
 * of service than the flood it was meant to stop.
 *
 * A fixed window is coarser than a sliding one - a caller can spend its budget
 * at the end of one window and again at the start of the next - but it is O(1)
 * in both time and memory, and a factor of two on a flood ceiling is worth far
 * less than not falling over.
 */
function rateLimited(bucket, limit, window) {
  const now = Date.now();
  const entry = rateBuckets.get(bucket);

  if (!entry || now - entry.start >= window) {
    rateBuckets.set(bucket, { start: now, count: 1 });
    return 1 > limit;
  }

  // Stop counting at the ceiling. Past it the answer cannot change, and a
  // counter that keeps climbing is just something for a flood to push on.
  if (entry.count > limit) return true;

  entry.count += 1;
  return entry.count > limit;
}

// Windows are only rolled over when touched, so idle buckets need sweeping.
setInterval(() => {
  const now = Date.now();
  const longest = Math.max(PAIRING_RATE_WINDOW, CODE_ATTEMPT_WINDOW, SESSION_ATTEMPT_WINDOW);
  for (const [bucket, entry] of rateBuckets) {
    if (now - entry.start > longest) rateBuckets.delete(bucket);
  }
}, 60 * 1000).unref();

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    termlyLocal: true,
    uptimeSeconds: Math.round(process.uptime()),
    sessions: {
      total: new Set(sessionsById.values()).size,
      awaitingPairing: sessionsByCode.size,
      paired: [...new Set(sessionsById.values())].filter(s => s.paired).length
    }
  });
});

// The CLI hard-exits when semver.lt(current, minVersion), so a permissive
// floor is what keeps a self-hosted setup from being remotely killable.
app.get('/api/cli/version', (req, res) => {
  res.json({
    currentVersion: req.query.currentVersion || '0.0.0',
    minVersion: '0.0.0',
    updateCommand: '',
    isLatest: true,
    local: true
  });
});

function registerPairing(req, res, batch) {
  const ip = req.ip || 'unknown';

  if (rateLimited(`http:${ip}`, PAIRING_RATE_LIMIT, PAIRING_RATE_WINDOW)) {
    logger.warn('pairing', `Rate limit hit from ${ip}`);
    return res.status(429).json({ error: 'Too many pairing registrations' });
  }

  const { code, publicKey, projectName, workingDir, computerName, tools, cols, rows } = req.body || {};
  const details = [];

  if (!code) details.push({ field: 'code', message: 'Required' });
  else if (!CODE_PATTERN.test(code)) details.push({ field: 'code', message: 'Must be 6 uppercase alphanumerics' });
  if (!publicKey) details.push({ field: 'publicKey', message: 'Required' });
  else if (typeof publicKey !== 'string' || publicKey.length > 2048) {
    details.push({ field: 'publicKey', message: 'Must be a base64 string under 2048 chars' });
  }

  if (details.length) {
    return res.status(400).json({ error: 'Validation failed', details });
  }

  if (sessionsByCode.has(code)) {
    return res.status(409).json({ error: 'Pairing code already registered' });
  }

  const primary = batch && tools && tools.length ? tools[0] : req.body;
  const session = new Session({
    code,
    publicKey,
    projectName,
    workingDir,
    computerName,
    aiTool: primary.aiTool,
    aiToolVersion: primary.aiToolVersion,
    tools: batch ? tools || [] : [],
    cols,
    rows
  });

  sessionsByCode.set(code, session);
  sessionsById.set(session.sessionId, session);

  // An unclaimed code must not live forever: it is the only credential
  // standing between the network and an interactive terminal.
  session.pairingTimer = setTimeout(() => {
    if (session.paired) return;
    logger.warn('pairing', `Code ${code} expired unclaimed`);
    closeWithReason(session.cliWs, 'pairing_expired', 'Pairing code expired - run termly start again');
    session.destroy('pairing expired');
  }, PAIRING_TTL);

  logger.info('pairing', `Registered code=${code} session=${short(session.sessionId)} tool=${session.aiTool} project=${session.projectName || '.'}`);
  history.record('created', { sessionId: session.sessionId, aiTool: session.aiTool });

  res.json({
    success: true,
    sessionId: session.sessionId,
    message: 'Pairing code registered. Waiting for mobile connection.'
  });
}

app.post('/api/pairing', (req, res) => registerPairing(req, res, false));
app.post('/api/pairing/batch', (req, res) => registerPairing(req, res, true));

/*
 * Metadata for the operator's own dashboard - never terminal content, which
 * this process cannot see anyway. Nothing here is a secret on the wire the way
 * a pairing code is, but the whole point of a dashboard is to show who is
 * using the relay, so it is not meant for the same audience as `/`. Gate
 * `/dashboard*` and `/api/dashboard*` at the proxy; the app does not
 * duplicate that check.
 */
app.get('/api/dashboard/sessions', (req, res) => {
  const sessions = [...new Set(sessionsById.values())].map(s => ({
    sessionId: short(s.sessionId),
    createdAt: s.createdAt,
    ageMs: Date.now() - s.createdAt,
    paired: s.paired,
    cliConnected: !!(s.cliWs && s.cliWs.readyState === WebSocket.OPEN),
    peerConnected: !!(s.mobileWs && s.mobileWs.readyState === WebSocket.OPEN),
    aiTool: s.aiTool,
    aiToolVersion: s.aiToolVersion,
    projectName: s.projectName,
    computerName: s.computerName,
    cols: s.cols,
    rows: s.rows
  }));
  res.json({ sessions, count: sessions.length });
});

app.get('/api/dashboard/stats', (req, res) => {
  res.json(history.stats());
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// The web client — the only client this relay ships with. Mounted after the
// API routes, so a file can never shadow an endpoint.
// public/package.json only marks the directory as ESM for Node's loader; it is
// not part of the client and has no business being served.
app.use('/package.json', (req, res) => res.status(404).json({ error: 'not_found' }));

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    const name = path.basename(filePath);

    // A stale service worker outlives every other kind of stale asset, because
    // it decides what the next load is allowed to see.
    if (name === 'sw.js') {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Service-Worker-Allowed', '/');
      return;
    }

    // Vendored bundle and icons change only when the project does, and the
    // service worker revalidates them in the background anyway.
    const dir = `${path.sep}${path.basename(path.dirname(filePath))}${path.sep}`;
    if (dir === `${path.sep}vendor${path.sep}` || dir === `${path.sep}icons${path.sep}`) {
      res.setHeader('Cache-Control', 'public, max-age=604800');
      return;
    }

    // Everything else is revalidated, so a deploy lands on the next load.
    res.setHeader('Cache-Control', 'no-cache');
  }
}));

app.use((req, res) => {
  logger.warn('http', `No route for ${req.method} ${req.originalUrl}`);
  res.status(404).json({
    error: 'not_found',
    message: `No route for ${req.method} ${req.path}`,
    available: ['/', '/api/health', '/api/cli/version', '/api/pairing', '/api/pairing/batch', '/ws/agent']
  });
});

// ---------------------------------------------------------------------------
// WebSocket relay
// ---------------------------------------------------------------------------

const server = http.createServer(app);

/**
 * Is this upgrade allowed to come from where it says it comes from?
 *
 * Same-origin is the ordinary case: the page doing the asking is the one this
 * relay served. Anything else has to be named in TERMLY_ALLOWED_ORIGINS.
 */
function originAllowed(req) {
  const origin = req.headers.origin;

  // Not a browser. The CLI connects with no Origin header at all.
  if (!origin) return true;

  const normalised = origin.replace(/\/$/, '');
  if (ALLOWED_ORIGINS.has(normalised)) return true;

  const host = req.headers.host;
  if (!host) return false;

  // Behind TLS the page is https:// while the proxy speaks http:// to us, so
  // the scheme cannot be inferred from this connection - match on host alone.
  try {
    return new URL(normalised).host === host;
  } catch {
    return false;
  }
}

const wss = new WebSocketServer({
  server,
  path: '/ws/agent',
  maxPayload: MAX_PAYLOAD,
  verifyClient({ req }, accept) {
    if (originAllowed(req)) return accept(true);

    logger.warn('ws', `Refusing upgrade from origin ${req.headers.origin} (host ${req.headers.host})`);
    // 403 rather than a close frame: the handshake never completes, so the
    // page learns nothing about whether the session it named exists.
    accept(false, 403, 'Forbidden');
  }
});

server.on('upgrade', req => {
  logger.info('ws', `Upgrade ${req.url} from ${clientAddress(req)} ua=${req.headers['user-agent'] || 'none'}`);
});

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const code = url.searchParams.get('code');
  const sessionId = url.searchParams.get('sessionId');

  if (!code && !sessionId) {
    return closeWithReason(ws, 'bad_request', 'Missing code or sessionId');
  }

  const ip = clientAddress(req);

  // A loose bucket over every attempt, so no IP can simply flood the relay.
  if (rateLimited(`ws:${ip}`, SESSION_ATTEMPT_LIMIT, SESSION_ATTEMPT_WINDOW)) {
    logger.warn('ws', `Flooding from ${ip}`);
    return closeWithReason(ws, 'rate_limited', 'Too many attempts - try again later');
  }

  const session = code ? sessionsByCode.get(code) : sessionsById.get(sessionId);

  if (!session) {
    // Only *misses* pay into the strict bucket. Guessing is nothing but misses,
    // so this still caps it at CODE_ATTEMPT_LIMIT per minute; a legitimate
    // pairing or resume hits an existing session and never reaches this line.
    //
    // Charging every attempt instead - as this once did - locks a user out of a
    // session they already hold after a handful of network drops, and makes
    // every phone behind one NAT share the count.
    const guessing = rateLimited(`ws:miss:${ip}`, CODE_ATTEMPT_LIMIT, CODE_ATTEMPT_WINDOW);
    logger.warn('ws', `Rejecting unknown ${code ? `code=${code}` : `sessionId=${short(sessionId)}`}`);
    return guessing
      ? closeWithReason(ws, 'rate_limited', 'Too many attempts - try again later')
      : closeWithReason(ws, 'session_not_found', 'Session not found or expired');
  }

  ws._peerId = randomUUID().slice(0, 8);
  ws._session = session;

  // The CLI always connects first - it is what mints the pairing code - so the
  // first socket on a session is the CLI and any later one is the mobile.
  // classifyByMessage() corrects this if the assumption ever fails.
  attachPeer(session, ws, session.cliWs ? 'mobile' : 'cli');

  ws.on('message', (raw, isBinary) => {
    if (isBinary) {
      // Nothing in the protocol uses binary frames, but relay rather than drop.
      const target = ws._role === 'cli' ? session.mobileWs : session.cliWs;
      if (target && target.readyState === WebSocket.OPEN) {
        target.send(raw, { binary: true });
        throttleSource(target);
      }
      return;
    }

    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      logger.warn('ws', `Dropping unparseable frame from ${ws._peerId}`);
      return;
    }

    handleMessage(session, ws, msg);
  });

  ws.on('close', () => handleDisconnect(session, ws));
  ws.on('error', err => logger.warn('ws', `Socket error on ${short(session.sessionId)}: ${err.message}`));
});

function attachPeer(session, ws, role) {
  ws._role = role;
  // Backpressure needs the other half of the session, and looking it up through
  // here rather than caching the socket keeps it correct across a reconnect.
  ws._session = session;

  // Cancel a pending reap: the session is in use again.
  clearTimeout(session.reapTimer);
  session.reapTimer = null;

  if (role === 'cli') {
    if (session.cliWs && session.cliWs !== ws) {
      closeWithReason(session.cliWs, 'session_expired', 'Replaced by a newer CLI connection');
    }
    session.cliWs = ws;
    session.lastPong = Date.now();
    startHeartbeat(session);
    logger.info('ws', `CLI connected: session=${short(session.sessionId)} peer=${ws._peerId}`);

    // A freshly started CLI process has mobileConnected=false and would never
    // stream output to an already-attached mobile without this.
    if (session.mobileWs) {
      sendJSON(ws, { type: 'client_connected', timestamp: new Date().toISOString() });
      // The mobile was told cli_disconnected when this socket dropped; without
      // the matching notice it stays on "CLI offline" forever even though the
      // session is live again. Clients that do not know the type ignore it.
      sendJSON(session.mobileWs, { type: 'cli_reconnected', timestamp: new Date().toISOString() });
    }
    return;
  }

  if (session.mobileWs && session.mobileWs !== ws) {
    closeWithReason(session.mobileWs, 'session_expired', 'Replaced by a newer mobile connection');
  }
  session.mobileWs = ws;
  logger.info('ws', `Mobile connected: session=${short(session.sessionId)} peer=${ws._peerId}`);

  // A phone that comes back to a session it already paired with never sees
  // another pairing_ack, so this is the only place it can be told the size
  // again after a cold start. Clients that do not know the type ignore it.
  if (session.cols || session.rows) {
    sendJSON(ws, {
      type: 'session_info',
      cols: session.cols,
      rows: session.rows,
      timestamp: new Date().toISOString()
    });
  }

  // For a first-time pairing the CLI has no key yet, so client_connected waits
  // until mobile_pairing completes. A reconnecting mobile on an already-paired
  // session needs it immediately.
  if (session.paired) {
    sendJSON(session.cliWs, { type: 'client_connected', timestamp: new Date().toISOString() });
  }
}

// Guard against the first-socket heuristic being wrong, e.g. a mobile that
// reconnects while the CLI is briefly absent.
function classifyByMessage(session, ws, type) {
  const shouldBe = CLI_ONLY.has(type) ? 'cli' : MOBILE_ONLY.has(type) ? 'mobile' : null;

  if (!shouldBe || shouldBe === ws._role) return;

  logger.warn('ws', `Reclassifying peer ${ws._peerId} from ${ws._role} to ${shouldBe} (saw "${type}")`);

  if (ws._role === 'cli' && session.cliWs === ws) session.cliWs = null;
  if (ws._role === 'mobile' && session.mobileWs === ws) session.mobileWs = null;

  attachPeer(session, ws, shouldBe);
}

function handleMessage(session, ws, msg) {
  classifyByMessage(session, ws, msg.type);

  const toMobile = payload => sendJSON(session.mobileWs, payload);
  const toCli = payload => sendJSON(session.cliWs, payload);

  switch (msg.type) {
    case 'pong':
      session.lastPong = Date.now();
      logger.debug('hb', `pong from ${short(session.sessionId)} status=${msg.status || 'n/a'}`);
      break;

    // CLI -> mobile
    case 'output':
    case 'catchup_batch':
    case 'sync_complete':
      toMobile(msg);
      break;

    // mobile -> CLI
    case 'input':
    case 'resize':
      toCli(msg);
      break;

    case 'catchup_request':
      session.lastMobileSeq = Number(msg.lastSeq) || 0;
      toCli({
        type: 'catchup_request',
        lastSeq: session.lastMobileSeq,
        timestamp: new Date().toISOString()
      });
      break;

    case 'mobile_pairing': {
      if (!msg.publicKey) {
        logger.warn('pairing', 'mobile_pairing without publicKey, ignoring');
        break;
      }

      session.mobilePublicKey = msg.publicKey;
      session.paired = true;
      session.pairedAt = Date.now();

      // The code has done its job; leaving it live would let a second peer
      // claim the same session.
      clearTimeout(session.pairingTimer);
      session.pairingTimer = null;
      sessionsByCode.delete(session.code);

      logger.info('pairing', `Mobile paired with session ${short(session.sessionId)}`);
      history.record('paired', {
        sessionId: session.sessionId,
        msToPair: session.pairedAt - session.createdAt
      });

      // The CLI reads `publicKey` here (handlePairingComplete -> onPaired);
      // any other field name leaves it without an AES key.
      toCli({
        type: 'pairing_complete',
        sessionId: session.sessionId,
        publicKey: msg.publicKey,
        mobilePublicKey: msg.publicKey,
        deviceName: msg.deviceName || null,
        timestamp: new Date().toISOString()
      });

      toMobile({
        type: 'pairing_ack',
        sessionId: session.sessionId,
        publicKey: session.cliPublicKey,
        cols: session.cols,
        rows: session.rows,
        timestamp: new Date().toISOString()
      });

      // Only now may the CLI start streaming: client_connected flips the flag
      // that gates sendOutput(), and output sent before the key exchange would
      // be dropped unencrypted.
      toCli({ type: 'client_connected', timestamp: new Date().toISOString() });
      break;
    }

    default:
      // Forward anything unrecognised, but only once the peer's side is known,
      // so an unclassified socket can never be sent its own message back.
      if (ws._role === 'cli') toMobile(msg);
      else if (ws._role === 'mobile') toCli(msg);
      else logger.debug('ws', `Dropping "${msg.type}" from unclassified peer`);
      break;
  }
}

function handleDisconnect(session, ws) {
  if (session.cliWs === ws) {
    session.cliWs = null;
    clearInterval(session.heartbeatTimer);
    session.heartbeatTimer = null;
    logger.info('ws', `CLI disconnected: session=${short(session.sessionId)}`);
    sendJSON(session.mobileWs, { type: 'cli_disconnected', timestamp: new Date().toISOString() });
  } else if (session.mobileWs === ws) {
    session.mobileWs = null;
    logger.info('ws', `Mobile disconnected: session=${short(session.sessionId)}`);
    sendJSON(session.cliWs, { type: 'client_disconnected', timestamp: new Date().toISOString() });
  }

  // One reap timer per session, replaced rather than stacked.
  if (!session.cliWs && !session.mobileWs && !session.reapTimer) {
    session.reapTimer = setTimeout(() => {
      if (!session.cliWs && !session.mobileWs) session.destroy('idle');
    }, SESSION_TTL);
  }
}

function startHeartbeat(session) {
  if (session.heartbeatTimer) return;

  session.heartbeatTimer = setInterval(() => {
    const ws = session.cliWs;

    if (!ws || ws.readyState !== WebSocket.OPEN) {
      clearInterval(session.heartbeatTimer);
      session.heartbeatTimer = null;
      return;
    }

    if (Date.now() - session.lastPong > HEARTBEAT_INTERVAL * 4) {
      logger.warn('hb', `CLI unresponsive on ${short(session.sessionId)}, closing`);
      ws.terminate();
      return;
    }

    sendJSON(ws, { type: 'ping', timestamp: new Date().toISOString() });
  }, HEARTBEAT_INTERVAL);
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter(i => i && i.family === 'IPv4' && !i.internal)
    .map(i => i.address);
}

server.listen(PORT, BIND, () => {
  logger.info('start', `Listening on http://${BIND}:${PORT} (ws://${BIND}:${PORT}/ws/agent)`);

  // TERMLY_ENV=local only works when the CLI can reach port 3000 on its own
  // machine; anywhere else the URL has to be given explicitly, because it is
  // also what ends up in the pairing QR code the phone scans.
  if (BIND === '127.0.0.1' && PORT === 3000) {
    logger.info('start', 'Point the CLI at it with: TERMLY_ENV=local termly start');
  } else {
    logger.info('start', `Point the CLI at it with: TERMLY_SERVER_URL=ws://<host>:${PORT} termly start`);
    logger.info('start', '(behind TLS, use wss://<domain> with no port)');
  }

  if (BIND === '0.0.0.0') {
    const addrs = lanAddresses();
    logger.warn('start', 'Bound to all interfaces - anyone who can reach this port and guess a');
    logger.warn('start', '6-character pairing code within 5 minutes gets an interactive terminal.');
    if (addrs.length) logger.info('start', `Reachable at: ${addrs.map(a => `ws://${a}:${PORT}`).join(', ')}`);
  } else {
    logger.info('start', 'Loopback only. Set TERMLY_BIND=0.0.0.0 to allow phones on the LAN.');
  }
});

function shutdown(signal) {
  logger.info('stop', `${signal} received, closing ${new Set(sessionsById.values()).size} session(s)`);

  for (const session of new Set(sessionsById.values())) {
    closeWithReason(session.cliWs, 'session_expired', 'Server shutting down');
    closeWithReason(session.mobileWs, 'session_expired', 'Server shutting down');
    session.destroy('shutdown');
  }

  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = { app, server, wss };
