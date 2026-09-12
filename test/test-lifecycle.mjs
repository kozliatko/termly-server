/**
 * What the relay does with a session over time.
 *
 * The protocol suites all pair, talk and stop. Nothing covered the other axis:
 * when a session is reaped, when a reap is called off, and whether anything is
 * left behind afterwards. Those are the failures that never show up in a test
 * run and then show up as a relay that has been up for a week.
 *
 * It starts its own relay with the timers turned down from minutes to
 * milliseconds, on a port of its own, so it neither waits nor collides with the
 * one the rest of the suite uses.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import crypto from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const PORT = 3111;
const SESSION_TTL = 700;
const PAIRING_TTL = 1200;
const HEARTBEAT = 300;

const base = `http://127.0.0.1:${PORT}`;
const wsBase = `ws://127.0.0.1:${PORT}/ws/agent`;

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

const server = spawn('node', [path.join(root, 'server.js')], {
  cwd: root,
  env: {
    ...process.env,
    TERMLY_LOCAL_PORT: String(PORT),
    TERMLY_LOG_LEVEL: 'error',
    TERMLY_SESSION_TTL_MS: String(SESSION_TTL),
    TERMLY_PAIRING_TTL_MS: String(PAIRING_TTL),
    TERMLY_HEARTBEAT_MS: String(HEARTBEAT),
    // The deployed shape: Caddy in front, so the client address is whatever
    // X-Forwarded-For says. It is also the only way to be two clients at once
    // from one machine.
    TERMLY_TRUST_PROXY: '1'
  },
  stdio: ['ignore', 'ignore', 'inherit']
});
process.on('exit', () => { try { server.kill('SIGKILL'); } catch {} });

for (let i = 0; ; i++) {
  await sleep(150);
  if (await fetch(`${base}/api/health`).then(() => true, () => false)) break;
  if (i > 40) { console.error('the relay never came up'); process.exit(2); }
}

const health = () => fetch(`${base}/api/health`).then(r => r.json());

let codeSeed = 0;
const nextCode = () => `LC${String(++codeSeed).padStart(4, '0')}`;

/** Register a pairing the way `termly start` does, and return its code. */
async function register(code = nextCode(), from = null, extra = {}) {
  const dh = crypto.getDiffieHellman('modp14');
  dh.generateKeys();
  const res = await fetch(`${base}/api/pairing`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(from ? { 'X-Forwarded-For': from } : {})
    },
    body: JSON.stringify({
      code,
      publicKey: dh.getPublicKey().toString('base64'),
      projectName: 'lifecycle',
      aiTool: 'demo',
      aiToolVersion: '1.0.0',
      ...extra
    })
  });
  const body = await res.json();
  return { code, sessionId: body.sessionId, dh };
}

/** Open a socket and wait for it to be usable, or for the relay to refuse it. */
function connect(query, from = null) {
  const ws = new WebSocket(`${wsBase}?${query}`,
    from ? { headers: { 'X-Forwarded-For': from } } : undefined);
  ws.received = [];
  ws.closeInfo = null;
  ws.on('message', raw => {
    try { ws.received.push(JSON.parse(raw.toString())); } catch { /* not ours */ }
  });
  ws.on('close', (code, reason) => { ws.closeInfo = { code, reason: reason.toString() }; });
  ws.on('error', () => { /* a refused socket closes; the test reads closeInfo */ });
  return new Promise(resolve => {
    ws.once('open', () => resolve(ws));
    ws.once('close', () => resolve(ws));
  });
}

/**
 * Connect expecting a refusal, and return why.
 *
 * The HTTP upgrade completes before the relay looks at the query string, so a
 * socket the relay is about to reject reports itself open first. Reading
 * readyState straight after connecting says nothing.
 */
async function refused(query, from = null) {
  const ws = await connect(query, from);
  if (!ws.closeInfo) await new Promise(done => { ws.once('close', done); setTimeout(done, 800); });
  return ws.closeInfo;
}

// ---- an unclaimed code does not live forever -------------------------------

await register();
check('a registered code is waiting to be claimed', (await health()).sessions.awaitingPairing === 1);

await sleep(PAIRING_TTL + 400);
const afterPairing = await health();
check('an unclaimed code expires', afterPairing.sessions.awaitingPairing === 0);
check('and takes its session with it', afterPairing.sessions.total === 0,
  `${afterPairing.sessions.total} left`);

// ---- a session with nobody on it is reaped ---------------------------------

const one = await register();
const cli = await connect(`code=${one.code}`);
check('the CLI attaches to its own code', cli.readyState === WebSocket.OPEN);

cli.close();
await sleep(120);
check('the session outlives a disconnect', (await health()).sessions.total === 1);

await sleep(SESSION_TTL + 400);
check('but not indefinitely', (await health()).sessions.total === 0);

// ---- coming back calls the reap off, twice ---------------------------------

// Paired, so that the pairing deadline plays no part in what follows: what is
// under test is the reap, and an unpaired session has two clocks on it.
const two = await register();
const cli2 = await connect(`code=${two.code}`);
const phone = await connect(`sessionId=${two.sessionId}`);
phone.send(JSON.stringify({ type: 'mobile_pairing', code: two.code, publicKey: 'AAAA', deviceName: 'test' }));
await sleep(120);
check('pairing takes the code out of circulation', (await health()).sessions.paired === 1);
phone.close();
cli2.close();
await sleep(SESSION_TTL / 2);

const back = await connect(`sessionId=${two.sessionId}`);
check('a reconnect within the window finds the session', back.readyState === WebSocket.OPEN);

await sleep(SESSION_TTL + 300);
check('and the pending reap is called off', (await health()).sessions.total === 1,
  'the session survives past the deadline it was on');

// The second cycle is the one that rots: a reap timer that is cleared but not
// forgotten leaves the session unreapable for the rest of the process's life.
back.close();
await sleep(SESSION_TTL + 400);
check('a second disconnect is reaped like the first', (await health()).sessions.total === 0,
  'a session that survives one reconnect must still be collectable');

// ---- churn leaves nothing behind -------------------------------------------

for (let i = 0; i < 8; i++) {
  const s = await register();
  const c = await connect(`code=${s.code}`);
  const m = await connect(`sessionId=${s.sessionId}`);
  c.close();
  m.close();
}
await sleep(SESSION_TTL + 600);
const afterChurn = await health();
check('eight pair-and-drop cycles leave nothing behind',
  afterChurn.sessions.total === 0 && afterChurn.sessions.awaitingPairing === 0,
  `${afterChurn.sessions.total} sessions, ${afterChurn.sessions.awaitingPairing} codes`);

// ---- a replaced peer does not take the session with it ---------------------

const three = await register();
const cli3 = await connect(`code=${three.code}`);
const mobileA = await connect(`sessionId=${three.sessionId}`);
mobileA.send(JSON.stringify({ type: 'mobile_pairing', code: three.code, publicKey: 'AAAA', deviceName: 'test' }));
await sleep(120);
const mobileB = await connect(`sessionId=${three.sessionId}`);
await sleep(150);

check('a second mobile displaces the first',
  mobileA.closeInfo !== null && /session_expired/.test(mobileA.closeInfo.reason));
check('the newcomer is the one left holding the session',
  mobileB.readyState === WebSocket.OPEN);
check('and the CLI is never told the mobile left',
  !cli3.received.some(m => m.type === 'client_disconnected'));

await sleep(SESSION_TTL + 300);
check('the displaced socket did not schedule a reap of a live session',
  (await health()).sessions.total === 1);

// ---- a CLI that stops answering is not held forever ------------------------

check('a live CLI is pinged', cli3.received.some(m => m.type === 'ping'));

mobileB.close();
// This socket never answers a ping, which is what a wedged ornetwork-partitioned CLI
// looks like from here.
await sleep(HEARTBEAT * 5 + 400);
check('an unresponsive CLI is dropped', cli3.readyState === WebSocket.CLOSED);

await sleep(SESSION_TTL + 400);
check('and its session is reaped afterwards', (await health()).sessions.total === 0);

// ---- resuming something that is gone ---------------------------------------

const stale = await refused(`sessionId=${three.sessionId}`);
check('a reaped session id is refused, not resurrected',
  stale !== null && /session_not_found/.test(stale.reason),
  stale ? stale.reason : 'the socket stayed open');

// A socket the relay is about to reject still opens first, which is worth
// stating once: "connected" is not "accepted" anywhere in this protocol.
const gibberish = await refused('sessionId=not-a-real-id');
check('so is an id that was never issued',
  gibberish !== null && /session_not_found/.test(gibberish.reason));
const empty = await refused('');
check('and a socket with no credential at all is a bad request',
  empty !== null && /bad_request/.test(empty.reason));

// ---- an id the relay never minted is not a credential ----------------------

/*
 * The relay used to accept a sessionId it had never seen, and work out which
 * session was meant from the source address alone: the CLI called itself by a
 * local uuid until pairing_complete, so an unknown id was normal.
 *
 * It is not normal any more - the CLI adopts the id the relay mints at
 * registration - and the guessing it required was an authentication bypass.
 * Anyone sharing the address, which on the web means any page the user visits,
 * could walk into a session waiting to be paired without knowing its code.
 */
const CLI_IP = '198.51.100.7';
const STRANGER = '203.0.113.9';

const four = await register(nextCode(), CLI_IP);
const cli4 = await connect(`code=${four.code}`, CLI_IP);
cli4.close();
await sleep(100);

const invented = await refused(`sessionId=${crypto.randomUUID()}`, CLI_IP);
check('an invented session id is refused even from the address that registered the code',
  invented !== null && /session_not_found/.test(invented.reason),
  invented ? invented.reason : 'an id the relay never issued was accepted');

const outsider = await refused(`sessionId=${crypto.randomUUID()}`, STRANGER);
check('and from anywhere else',
  outsider !== null && /session_not_found/.test(outsider.reason),
  outsider ? outsider.reason : 'a stranger walked into a session waiting to be paired');

// What the CLI actually holds now: the id from the registration response.
const minted = await connect(`sessionId=${four.sessionId}`, CLI_IP);
check('the id the relay minted at registration is what reconnects',
  minted.readyState === WebSocket.OPEN && minted.closeInfo === null,
  minted.closeInfo ? minted.closeInfo.reason : '');
minted.close();
await sleep(100);

// ---- who is allowed to open a socket at all --------------------------------

/*
 * WebSockets ignore the same-origin policy, so without this any page on the web
 * could dial the relay from the victim's own browser - their address, their
 * network position - and the relay would answer. The CLI sends no Origin at
 * all, which is what makes the check safe to apply.
 */
function connectFrom(query, origin) {
  const ws = new WebSocket(`${wsBase}?${query}`, {
    headers: { 'X-Forwarded-For': CLI_IP, ...(origin ? { Origin: origin } : {}) }
  });
  ws.refusedAtHandshake = false;
  ws.closeInfo = null;
  ws.on('close', (c, r) => { ws.closeInfo = { code: c, reason: r.toString() }; });
  ws.on('error', err => { ws.refusedAtHandshake = /403/.test(err.message); });
  return new Promise(resolve => {
    ws.once('open', () => resolve(ws));
    ws.once('close', () => resolve(ws));
    ws.once('error', () => setTimeout(() => resolve(ws), 50));
  });
}

const five = await register(nextCode(), CLI_IP);

const evil = await connectFrom(`code=${five.code}`, 'https://evil.example.com');
check('a page on another origin is refused at the handshake',
  evil.refusedAtHandshake && evil.readyState !== WebSocket.OPEN,
  evil.refusedAtHandshake ? '' : 'the upgrade completed for a cross-origin page');

const samePage = await connectFrom(`code=${five.code}`, `http://127.0.0.1:${PORT}`);
check('the page this relay serves is let in',
  samePage.readyState === WebSocket.OPEN,
  samePage.closeInfo ? samePage.closeInfo.reason : '');
samePage.close();
await sleep(100);

const six = await register(nextCode(), CLI_IP);
const noOrigin = await connectFrom(`code=${six.code}`, null);
check('and so is a client that sends no Origin, which is what the CLI is',
  noOrigin.readyState === WebSocket.OPEN,
  noOrigin.closeInfo ? noOrigin.closeInfo.reason : '');
noOrigin.close();
await sleep(100);

// ---- the size of the terminal the CLI is running in ------------------------
/*
 * The web client used to measure the browser window and resize the CLI's pty to
 * match. That reflows the terminal the user is also sitting in front of, and
 * the CLI ignores its own SIGWINCH while a phone is attached, so the pty ends
 * up at the phone's size until the phone leaves.
 *
 * The size the CLI started with is the one that matters, so it says what it is
 * at registration and the relay carries it to whoever pairs - both on the
 * pairing itself and again on a reconnect, since a restored PWA has to draw the
 * right grid before it has been told anything.
 */
{
  const sized = await register(nextCode(), null, { cols: 140, rows: 50 });
  await connect(`code=${sized.code}`);
  const phone = await connect(`code=${sized.code}`);
  const phoneDh = crypto.getDiffieHellman('modp14');
  phoneDh.generateKeys();
  phone.send(JSON.stringify({
    type: 'mobile_pairing',
    publicKey: phoneDh.getPublicKey().toString('base64')
  }));
  await sleep(250);

  const ack = phone.received.find(m => m.type === 'pairing_ack');
  check('the size the CLI started in reaches the phone that pairs with it',
    ack?.cols === 140 && ack?.rows === 50,
    ack ? `${ack.cols}x${ack.rows}` : 'no pairing_ack');

  phone.close();
  await sleep(150);
  const back = await connect(`sessionId=${sized.sessionId}`);
  await sleep(250);
  const info = back.received.find(m => m.type === 'session_info');
  check('and again when it comes back to a session it already paired with',
    info?.cols === 140 && info?.rows === 50,
    info ? `${info.cols}x${info.rows}` : 'no session_info');
  back.close();

  // A number is the only thing worth carrying. Anything else and the client is
  // better off measuring the window, which is what it does when nobody told it.
  const junk = await register(nextCode(), null, { cols: 'lots', rows: -3 });
  await connect(`code=${junk.code}`);
  const other = await connect(`code=${junk.code}`);
  const otherDh = crypto.getDiffieHellman('modp14');
  otherDh.generateKeys();
  other.send(JSON.stringify({
    type: 'mobile_pairing',
    publicKey: otherDh.getPublicKey().toString('base64')
  }));
  await sleep(250);
  const junkAck = other.received.find(m => m.type === 'pairing_ack');
  check('a size that is not a size is not passed off as one',
    junkAck != null && junkAck.cols == null && junkAck.rows == null,
    junkAck ? `${junkAck.cols}x${junkAck.rows}` : 'no pairing_ack');
  other.close();

  // An unpatched CLI says nothing, and that has to stay a working pairing.
  const silent = await register();
  await connect(`code=${silent.code}`);
  const oldPhone = await connect(`code=${silent.code}`);
  const oldDh = crypto.getDiffieHellman('modp14');
  oldDh.generateKeys();
  oldPhone.send(JSON.stringify({
    type: 'mobile_pairing',
    publicKey: oldDh.getPublicKey().toString('base64')
  }));
  await sleep(250);
  const silentAck = oldPhone.received.find(m => m.type === 'pairing_ack');
  check('a CLI that never mentions its size still pairs',
    silentAck?.publicKey != null && silentAck.cols == null);
  oldPhone.close();
}

server.kill('SIGKILL');
const passed = checks.filter(Boolean).length;
console.log(`\n=== ${passed}/${checks.length} checks passed ===`);
process.exit(passed === checks.length ? 0 : 1);
