/**
 * The operator-facing dashboard endpoints: does the live session list reflect
 * what is actually open, and does the historical log the relay writes to disk
 * actually survive a restart of the process that writes it.
 *
 * Runs its own relay, on its own port, pointed at a scratch TERMLY_DATA_DIR -
 * same shape as test-lifecycle.mjs - because this suite restarts that process
 * partway through, which nothing else in the suite needs to do.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { WebSocket } from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const PORT = 3112;
const SESSION_TTL = 700;
const PAIRING_TTL = 1200;
const HEARTBEAT = 300;
const base = `http://127.0.0.1:${PORT}`;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'termly-dashboard-'));

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

function spawnServer() {
  const child = spawn('node', [path.join(root, 'server.js')], {
    cwd: root,
    env: {
      ...process.env,
      TERMLY_LOCAL_PORT: String(PORT),
      TERMLY_LOG_LEVEL: 'error',
      TERMLY_SESSION_TTL_MS: String(SESSION_TTL),
      TERMLY_PAIRING_TTL_MS: String(PAIRING_TTL),
      TERMLY_HEARTBEAT_MS: String(HEARTBEAT),
      TERMLY_TRUST_PROXY: '1',
      TERMLY_DATA_DIR: dataDir
    },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  process.on('exit', () => { try { child.kill('SIGKILL'); } catch {} });
  return child;
}

async function waitUp() {
  for (let i = 0; ; i++) {
    await sleep(150);
    if (await fetch(`${base}/api/health`).then(() => true, () => false)) return;
    if (i > 40) { console.error('the relay never came up'); process.exit(2); }
  }
}

let server = spawnServer();
await waitUp();

let codeSeed = 0;
const nextCode = () => `DB${String(++codeSeed).padStart(4, '0')}`;

async function register(code = nextCode(), extra = {}) {
  const dh = crypto.getDiffieHellman('modp14');
  dh.generateKeys();
  const res = await fetch(`${base}/api/pairing`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code,
      publicKey: dh.getPublicKey().toString('base64'),
      projectName: 'dashboard-test',
      aiTool: 'demo',
      aiToolVersion: '1.0.0',
      ...extra
    })
  });
  const body = await res.json();
  return { code, sessionId: body.sessionId, dh };
}

function connect(query) {
  return new Promise(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/agent?${query}`);
    ws.received = [];
    ws.closeInfo = null;
    ws.on('message', raw => { try { ws.received.push(JSON.parse(raw.toString())); } catch {} });
    ws.on('close', (code, reason) => { ws.closeInfo = { code, reason: reason.toString() }; });
    ws.once('open', () => resolve(ws));
    ws.once('close', () => resolve(ws));
  });
}

const dashSessions = () => fetch(`${base}/api/dashboard/sessions`).then(r => r.json());
const dashStats = () => fetch(`${base}/api/dashboard/stats`).then(r => r.json());
const kill = (shortId, headers = { 'X-Termly-Dashboard': '1' }) =>
  fetch(`${base}/api/dashboard/sessions/${shortId}/kill`, { method: 'POST', headers });

// ---- the live view reflects an open session --------------------------------

const one = await register(nextCode(), { projectName: 'proj-one' });
const cli = await connect(`code=${one.code}`);
await sleep(120);

let sessions = await dashSessions();
let mine = sessions.sessions.find(s => s.projectName === 'proj-one');
check('an open session shows up in the live list', mine != null);
check('its sessionId is truncated the way logs truncate it, not the full credential',
  mine && mine.sessionId === one.sessionId.slice(0, 8) && mine.sessionId.length < one.sessionId.length,
  mine ? mine.sessionId : 'missing');
check('it is not yet paired', mine && mine.paired === false);
check('the CLI socket is reported connected', mine && mine.cliConnected === true);
check('and no peer is attached yet', mine && mine.peerConnected === false);

const phone = await connect(`sessionId=${one.sessionId}`);
phone.send(JSON.stringify({ type: 'mobile_pairing', code: one.code, publicKey: 'AAAA', deviceName: 'test' }));
await sleep(150);

sessions = await dashSessions();
mine = sessions.sessions.find(s => s.projectName === 'proj-one');
check('pairing is reflected live', mine && mine.paired === true && mine.peerConnected === true);

// ---- killing a session from the dashboard -----------------------------------

const stats0 = await dashStats();
const noHeader = await kill(mine.sessionId, {});
check('a kill request with no header is refused', noHeader.status === 400);
sessions = await dashSessions();
check('and the session is untouched', sessions.sessions.some(s => s.projectName === 'proj-one'));

const unknown = await kill('deadbeef');
check('killing an id nobody registered is a 404, not a silent no-op', unknown.status === 404);

const killed = await kill(mine.sessionId);
check('a proper kill request succeeds', killed.status === 200);
await sleep(150);

check('the CLI socket is closed with the reason the client already understands',
  cli.closeInfo !== null && /session_expired/.test(cli.closeInfo.reason));
check('so is the paired phone', phone.closeInfo !== null && /session_expired/.test(phone.closeInfo.reason));

sessions = await dashSessions();
check('and the session is gone from the live list immediately, not after a reap delay',
  !sessions.sessions.some(s => s.projectName === 'proj-one'));

const statsAfterKill = await dashStats();
check('the kill is recorded in history as a closed, successfully-paired session',
  stats0.pairSuccessRate === null && statsAfterKill.pairSuccessRate === 1,
  `${stats0.pairSuccessRate} -> ${statsAfterKill.pairSuccessRate}`);

// ---- history accumulates across the three lifecycle transitions ------------

let stats = await dashStats();
check('the paired session counted toward total sessions ever', stats.totalSessionsEver >= 1,
  String(stats.totalSessionsEver));
check('and toward a successful pairing', stats.byAiTool.demo >= 1, JSON.stringify(stats.byAiTool));

const abandoned = await register();
await connect(`code=${abandoned.code}`);
await sleep(PAIRING_TTL + 500);

const afterAbandon = await dashStats();
check('an abandoned pairing is also recorded, not just successful ones',
  afterAbandon.totalSessionsEver === stats.totalSessionsEver + 1,
  `${stats.totalSessionsEver} -> ${afterAbandon.totalSessionsEver}`);
check('and it counts against the pair success rate',
  afterAbandon.pairSuccessRate < 1,
  String(afterAbandon.pairSuccessRate));

// ---- the point of writing to disk: it survives the process that wrote it ---

const beforeRestart = await dashStats();
server.kill('SIGKILL');
await sleep(200);

check('the event file is actually on the disk this test controls',
  fs.existsSync(path.join(dataDir, 'events.jsonl')));

server = spawnServer();
await waitUp();

const afterRestart = await dashStats();
check('history survives a full restart of the relay process',
  afterRestart.totalSessionsEver === beforeRestart.totalSessionsEver,
  `${beforeRestart.totalSessionsEver} -> ${afterRestart.totalSessionsEver}`);

server.kill('SIGKILL');
fs.rmSync(dataDir, { recursive: true, force: true });

const passed = checks.filter(Boolean).length;
console.log(`\n=== ${passed}/${checks.length} checks passed ===`);
process.exit(passed === checks.length ? 0 : 1);
