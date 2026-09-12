/**
 * What the relay does when a peer stops reading.
 *
 * Every other suite has both sides draining their sockets as fast as the relay
 * fills them. A phone does not always do that: it goes into a tunnel, into a
 * pocket, onto a dying battery, and its socket stays open while it reads
 * nothing. `ws.send` queues the difference, without a ceiling.
 *
 * This suite floods a session and watches the relay's own resident memory, so
 * the numbers are the process's rather than a stand-in for it. It runs its own
 * relay on a port of its own - the flood would otherwise disturb every other
 * suite sharing one.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import crypto from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const PORT = 3114;
const CAP = 1024 * 1024;          // the relay's per-peer backlog cap, for this run
const CHUNK = 'X'.repeat(64 * 1024);
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
    // Smaller than the shipped 4 MB so a run costs seconds rather than minutes.
    TERMLY_MAX_BUFFERED_BYTES: String(CAP),
    // The grace a backlog gets to drain before it counts as a stall, turned
    // down from ten seconds so a run costs seconds rather than minutes.
    TERMLY_MAX_BUFFERED_MS: '1500'
  },
  stdio: ['ignore', 'ignore', 'inherit']
});
process.on('exit', () => { try { server.kill('SIGKILL'); } catch {} });

for (let i = 0; ; i++) {
  await sleep(150);
  if (await fetch(`${base}/api/health`).then(() => true, () => false)) break;
  if (i > 40) { console.error('the relay never came up'); process.exit(2); }
}

/** Resident memory of the relay itself, in MB. */
const rss = () => Number(/VmRSS:\s+(\d+)/
  .exec(fs.readFileSync(`/proc/${server.pid}/status`, 'utf8'))[1]) / 1024;

const open = url => new Promise((resolve, reject) => {
  const ws = new WebSocket(url);
  ws.once('open', () => resolve(ws));
  ws.once('error', reject);
});

let codeSeq = 0;
/** A registered code, a CLI on it, and a mobile paired to it. */
async function session() {
  const code = `BP${String(++codeSeq).padStart(4, '0')}`;
  const dh = crypto.getDiffieHellman('modp14');
  dh.generateKeys();
  const reg = await fetch(`${base}/api/pairing`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code,
      publicKey: dh.getPublicKey().toString('base64'),
      projectName: 'backpressure',
      aiTool: 'demo',
      aiToolVersion: '1.0.0'
    })
  }).then(r => r.json());

  const cli = await open(`${wsBase}?code=${code}`);
  const mobile = await open(`${wsBase}?code=${code}`);
  mobile.send(JSON.stringify({
    type: 'mobile_pairing', code, publicKey: 'AA==', deviceName: 'backpressure'
  }));
  await sleep(200);
  return { cli, mobile, sessionId: reg.sessionId };
}

/** Push `frames` chunks of output down the CLI socket, yielding periodically. */
async function flood(cli, frames, from = 1) {
  for (let i = 0; i < frames; i++) {
    cli.send(JSON.stringify({ type: 'output', seq: from + i, data: CHUNK }));
    if (i % 100 === 99) await sleep(30);
  }
}

// ---- a phone that keeps up is left alone ----------------------------------
{
  const { cli, mobile } = await session();
  let received = 0;
  mobile.on('message', () => { received++; });

  await flood(cli, 300);
  for (let i = 0; i < 100 && received < 300; i++) await sleep(50);

  check('a phone that drains its socket is never dropped',
    mobile.readyState === WebSocket.OPEN);
  check('and gets every frame, ~19 MB of them',
    received >= 300, `received ${received}/300`);
  cli.close();
  mobile.close();
  await sleep(200);
}

// ---- a phone on a slow link, reading every byte of it ----------------------
/*
 * The case that is not a stall and must never be treated as one.
 *
 * A phone on a mobile link drains its socket perfectly well; it just drains it
 * slower than a `cat` of a large file fills it. The backlog therefore climbs
 * past any fixed ceiling while the connection is entirely healthy, and cutting
 * it off there is the worst possible response: the CLI's replay buffer is 100 KB,
 * so a drop under a flood is exactly where output is lost - and the CLI is still
 * producing when the phone comes back, so it happens again, and again.
 *
 * The relay's answer is to stop reading from the CLI instead. TCP carries that
 * back to the CLI process, which slows down at the source and keeps what it has
 * not sent yet. Nothing is dropped and nothing needs replaying.
 */
{
  const { cli, mobile } = await session();
  let received = 0;
  mobile.on('message', () => { received++; });

  // Read slowly: 15 ms of not reading for every 5 ms of reading is a link a few
  // times slower than the sender, which is all it takes to build a backlog.
  const slow = setInterval(() => {
    mobile._socket.pause();
    setTimeout(() => mobile._socket.resume(), 15);
  }, 20);

  const FRAMES = 900;             // ~56 MB, far past the 8 MB ceiling
  let cliBacklogPeak = 0;
  const watch = setInterval(() => {
    cliBacklogPeak = Math.max(cliBacklogPeak, cli.bufferedAmount);
  }, 50);

  await flood(cli, FRAMES);
  for (let i = 0; i < 300 && received < FRAMES && mobile.readyState === WebSocket.OPEN; i++) {
    await sleep(50);
  }
  clearInterval(slow);
  clearInterval(watch);
  mobile._socket.resume();

  check('a phone that is merely slow is not cut off',
    mobile.readyState === WebSocket.OPEN,
    mobile.readyState === WebSocket.OPEN ? `${received}/${FRAMES} frames` : 'it was dropped');

  for (let i = 0; i < 200 && received < FRAMES; i++) await sleep(50);
  check('and every frame reaches it, ~56 MB of them',
    received >= FRAMES, `received ${received}/${FRAMES}`);

  /*
   * The observable signature of pushing back rather than dropping: with the
   * relay refusing to read, the CLI's own send queue is what grows. Without it
   * the relay swallows everything at full speed and the CLI never queues a byte.
   */
  check('and the relay pushes back on the CLI instead of swallowing the flood',
    cliBacklogPeak > CAP, `CLI queued up to ${Math.round(cliBacklogPeak / 1024)} KB`);

  cli.close();
  mobile.close();
  await sleep(200);
}

// ---- a phone that has stopped reading --------------------------------------
{
  const { cli, mobile, sessionId } = await session();
  const before = rss();

  // A socket that is not being read: the relay's writes back up in the kernel
  // and then in the relay's own queue. This is the state a phone is in when it
  // has signal but nothing is draining the connection.
  let mobileClosed = false;
  mobile.on('close', () => { mobileClosed = true; });
  mobile._socket.pause();

  await flood(cli, 1800);         // ~112 MB, far past the cap
  await sleep(3000);
  const after = rss();

  /*
   * Slow is forgiven; gone is not. A backlog that never moves is a peer that is
   * not there, and leaving it alone would hold the CLI throttled indefinitely -
   * which the user would experience as their terminal freezing because of a
   * phone in a drawer.
   *
   * The socket has to be resumed to see it: a paused socket never reads the
   * close, so this end goes on believing it is connected long after the relay
   * destroyed it. That is a property of the test, not of the relay - a real
   * phone is not paused, it is absent.
   */
  mobile._socket.resume();
  for (let i = 0; i < 60 && !mobileClosed; i++) await sleep(50);
  check('a phone whose backlog never moves is cut loose', mobileClosed);

  await sleep(400);
  check('and the CLI it was throttling is let go again',
    cli.bufferedAmount === 0, `${Math.round(cli.bufferedAmount / 1024)} KB still queued`);

  /*
   * The number that matters is not the delta itself - decoding 112 MB of frames
   * churns the heap whatever happens to them afterwards - but that the delta
   * stops tracking the flood. Held, this run costs the relay upwards of 130 MB
   * and keeps climbing with every frame; dropped, it settles around 30 and
   * stays there however much more is sent.
   */
  check('the relay does not hold a flood for a peer that is not reading it',
    after - before < 50,
    `${before.toFixed(0)} MB -> ${after.toFixed(0)} MB across ~112 MB flooded`);

  /*
   * The reconnect is the reason dropping is acceptable at all. The relay keeps
   * no replay buffer - the CLI does - so a phone that comes back asks for
   * everything after the last seq it drew, and the CLI answers. Losing the
   * socket costs it exactly what a lost signal would have.
   */
  const resumed = await open(`${wsBase}?sessionId=${sessionId}`);
  const asked = new Promise(resolve => {
    cli.on('message', raw => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'catchup_request') resolve(msg);
    });
  });
  resumed.send(JSON.stringify({ type: 'catchup_request', sessionId, lastSeq: 12 }));

  const request = await Promise.race([asked, sleep(3000).then(() => null)]);
  check('the session survives the drop and the phone can rejoin it',
    resumed.readyState === WebSocket.OPEN);
  check('and its catchup request reaches the CLI that holds the buffer',
    request?.lastSeq === 12, request ? `lastSeq ${request.lastSeq}` : 'never arrived');

  cli.close();
  resumed.close();
  try { mobile.terminate(); } catch {}
  await sleep(200);
}

const failed = checks.filter(ok => !ok).length;
console.log(`\n=== ${checks.length - failed}/${checks.length} checks passed ===`);
server.kill('SIGKILL');
process.exit(failed ? 1 : 0);
