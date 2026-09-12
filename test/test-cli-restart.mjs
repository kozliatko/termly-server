/**
 * What the phone sees when the CLI end goes away and comes back.
 *
 * The relay tells the mobile `cli_disconnected` when the CLI's socket drops,
 * but for a long time it told nobody when the CLI returned: the phone stayed on
 * "CLI offline" over a session that was perfectly alive, and the only way out
 * was a manual reload. This exercises the full round trip, including that
 * keystrokes typed while the CLI is gone are refused loudly instead of being
 * accepted by the relay and dropped on the floor.
 *
 * It owns its own `termly start` because it has to kill it mid-session.
 */
import { installDomShim } from './dom-shim.mjs';
import { startCli } from './cli-harness.mjs';

const host = process.argv[2] || 'localhost:3000';
const secure = !/^(localhost|127\.|\[::1\])/.test(host);
installDomShim(host);

const { TermlyClient } = await import('../public/termly-client.js');

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

const events = [];
let output = '';

const first = await startCli(`${secure ? 'wss' : 'ws'}://${host}`);

const client = new TermlyClient({
  output: t => { output += t; },
  cliOffline: () => events.push('offline'),
  cliOnline: () => events.push('online'),
  inputDropped: why => events.push(`dropped:${why}`),
  fatal: m => check('no fatal', false, m),
  log: () => {}
});
client.connect(first.code);
await sleep(2500);

check('paired', Boolean(client.aesKey));
check('CLI starts out present', client.cliOnline === true);
const seqBeforeKill = client.lastSeq;

// ---- the CLI goes away ----------------------------------------------------
console.log('[test] killing the CLI process');
first.kill();
await sleep(2000);

check('mobile was told the CLI left', events.includes('offline'));
check('client state reflects it', client.cliOnline === false);
check('socket to the relay is still up', client.connected === true,
  'the relay is fine; only the far end is gone');

const accepted = await client.sendInput('echo SHOULD_NOT_ARRIVE\r');
check('keystrokes are refused while the CLI is gone', accepted === false);
check('and the reason names the CLI, not the line',
  events.includes('dropped:CLI is offline'),
  events.filter(e => e.startsWith('dropped')).join(', ') || 'nothing dropped');

// ---- the CLI comes back ---------------------------------------------------
// A restarted `termly start` mints a new session, so what is simulated here is
// the CLI's own reconnect: the same session id, a fresh socket. The relay
// classifies it by the first CLI-only message it sends.
console.log('[test] reattaching a CLI socket to the same session');
const { WebSocket } = await import('ws');
const url = `${secure ? 'wss' : 'ws'}://${host}/ws/agent?sessionId=${encodeURIComponent(client.sessionId)}`;
const cliSocket = new WebSocket(url);
await new Promise((resolve, reject) => {
  cliSocket.once('open', resolve);
  cliSocket.once('error', reject);
});
cliSocket.send(JSON.stringify({
  type: 'output', sessionId: client.sessionId, seq: seqBeforeKill + 1,
  encrypted: false, data: 'BACK_FROM_THE_DEAD\r\n'
}));
await sleep(2000);

check('mobile was told the CLI returned', events.includes('online'));
check('client state reflects it', client.cliOnline === true);
check('output flows again', output.includes('BACK_FROM_THE_DEAD'));

const acceptedNow = await client.sendInput('echo OK\r');
check('keystrokes are accepted again', acceptedNow === true);

// The relay must actually forward it to the reattached socket.
const forwarded = await new Promise(resolve => {
  const timer = setTimeout(() => resolve(false), 3000);
  cliSocket.on('message', raw => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'input') { clearTimeout(timer); resolve(true); }
  });
});
check('and the relay forwards them to the new CLI socket', forwarded);

check('order was offline then online', events.indexOf('offline') < events.indexOf('online'),
  events.join(' → '));

cliSocket.close();
client.disconnect();

const passed = checks.filter(Boolean).length;
console.log(`\n=== ${passed}/${checks.length} checks passed ===`);
process.exit(passed === checks.length ? 0 : 1);
