/**
 * The rate limiter must stop code guessing without locking a user out of a
 * session they already hold.
 *
 * These are separate risks that were originally charged to one counter: a
 * six-character code is guessable and deserves a tight budget, while a session
 * id is a 128-bit UUID that a phone on a flaky network re-presents legitimately
 * and often - and every phone behind one NAT shares the count.
 */
import { startCli } from './cli-harness.mjs';
import { WebSocket } from 'ws';

const host = process.argv[2] || 'localhost:3000';
const secure = !/^(localhost|127\.|\[::1\])/.test(host);
const base = `${secure ? 'wss' : 'ws'}://${host}/ws/agent`;

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
};

// Resolves to the close reason the relay gave, or 'open' if it let us in.
function probe(query) {
  return new Promise(resolve => {
    const ws = new WebSocket(`${base}?${query}`);
    const done = v => { try { ws.close(); } catch {} resolve(v); };
    ws.on('close', (codeNum, reason) => resolve(String(reason || codeNum)));
    ws.on('error', () => resolve('error'));
    ws.on('open', () => setTimeout(() => done('open'), 250));
  });
}

// ---- establish a real session first --------------------------------------
// Order matters: pairing needs the code budget, and the point of the test is
// what happens to an *already held* session once that budget is gone.
const clis = [];

/** A CLI of its own plus the phone-side handshake, returning the session id. */
async function pairSession() {
  const cli = await startCli(`${secure ? 'wss' : 'ws'}://${host}`);
  clis.push(cli);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base}?code=${cli.code}`);
    ws.on('error', reject);
    ws.on('message', raw => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'pairing_ack') { ws.close(); resolve(msg.sessionId); }
    });
    ws.on('open', () => ws.send(JSON.stringify({
      type: 'mobile_pairing', code: cli.code,
      // Any group element works: this test never decrypts anything.
      publicKey: Buffer.alloc(256, 2).toString('base64'), deviceName: 'ratelimit-test'
    })));
    setTimeout(() => reject(new Error('never paired')), 15000);
  });
}

let paired = await pairSession();
check('paired a real session', Boolean(paired));

// ---- guessing codes must get cut off -------------------------------------

// The relay's windows. Nothing here reads them from the server; they only need
// to be no shorter than the real ones for the wait below to work.
const RATE_WINDOW = 60 * 1000;

/** Wrong codes until the relay stops taking them. `run` keeps the codes unique. */
async function countGuesses(run) {
  for (let i = 1; i <= 20; i++) {
    const reason = await probe(`code=ZZ${run}${String(i).padStart(3, '0')}`);
    if (/rate|Too many/i.test(reason)) return i;
  }
  return null;
}

let blockedAt = await countGuesses(1);

/*
 * Being blocked on the very first guess means the budget was already gone when
 * this run started - the suite spends every counter it touches, so a local pass
 * followed by one against the deployed relay inside the same minute lands here.
 * That is a dirty window, not a finding. Wait for it to roll over and count
 * again; the session paired above outlives the wait, so the rest still holds.
 */
if (blockedAt === 1) {
  console.log('      (the code budget was already spent - waiting out the window)');
  await new Promise(resolve => setTimeout(resolve, RATE_WINDOW + 5000));
  // The pairing has to happen in the same window as the guesses, or the count
  // below says nothing about whether a pairing is charged for them.
  paired = await pairSession();
  blockedAt = await countGuesses(2);
}
check('code guessing is cut off', blockedAt !== null, `after ${blockedAt} tries`);
check('and the budget is tight', blockedAt !== null && blockedAt <= 12,
  `blocked at ${blockedAt}`);
check('a correct code was never charged for the guesses', blockedAt > 10,
  `a legitimate pairing had already happened, yet ${blockedAt - 1} wrong guesses still fit`);

// ---- and it must still be resumable from the same IP ---------------------
// The IP has just burned its entire code budget; a user whose phone dropped is
// in exactly this position, and must not be locked out of a live session.
let resumeFailures = 0;
for (let i = 0; i < 15; i++) {
  const reason = await probe(`sessionId=${encodeURIComponent(paired)}`);
  if (reason !== 'open') resumeFailures++;
}
check('a held session resumes despite the spent code budget',
  resumeFailures === 0, `${15 - resumeFailures}/15 reconnects accepted`);

// ---- but probing for session ids is still an attack ----------------------
let sessionProbeBlocked = false;
for (let i = 0; i < 25; i++) {
  const reason = await probe(`sessionId=00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
  if (/rate|Too many/i.test(reason)) { sessionProbeBlocked = true; break; }
}
check('guessing session ids is still cut off', sessionProbeBlocked);

for (const cli of clis) cli.kill();
const passed = checks.filter(Boolean).length;
console.log(`\n=== ${passed}/${checks.length} checks passed ===`);
process.exit(passed === checks.length ? 0 : 1);
