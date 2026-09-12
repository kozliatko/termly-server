/**
 * Paste planning, and the fact that a pasted chunk survives the round trip.
 *
 * The first half is pure: chunk boundaries, the size ceiling and the bracketed
 * paste markers. The second half sends a real multi-chunk paste through the
 * relay and reads it back off a CLI socket, because "it is chunked correctly"
 * and "it arrives intact" are different claims.
 */
import { installDomShim } from './dom-shim.mjs';
import { startCli } from './cli-harness.mjs';
import { WebSocket } from 'ws';

const host = process.argv[2] || 'localhost:3000';
const secure = !/^(localhost|127\.|\[::1\])/.test(host);
installDomShim(host);

const { planPaste, PASTE_CHUNK, PASTE_LIMIT } = await import('../public/paste.js');
const { TermlyClient } = await import('../public/termly-client.js');

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- planning ------------------------------------------------------------
check('empty clipboard writes nothing', planPaste('').writes.length === 0);

const short = planPaste('ls -la\n');
check('a short paste is one write', short.ok && short.writes.length === 1);
check('and is passed through untouched', short.writes[0] === 'ls -la\n');

const exact = planPaste('x'.repeat(PASTE_CHUNK));
check('a chunk-sized paste is not split', exact.writes.length === 1,
  `${exact.writes.length} write(s)`);

const overBy1 = planPaste('x'.repeat(PASTE_CHUNK + 1));
check('one byte more is', overBy1.writes.length === 2, `${overBy1.writes.length} writes`);
check('and the tail carries the odd byte', overBy1.writes[1] === 'x');

const big = 'y'.repeat(PASTE_CHUNK * 3 + 7);
const plan = planPaste(big);
check('a long paste is split into ceil(n/chunk) writes', plan.writes.length === 4,
  `${plan.writes.length} writes`);
check('and reassembles byte for byte', plan.writes.join('') === big);
check('with no chunk over the limit', plan.writes.every(w => w.length <= PASTE_CHUNK));

const bracketed = planPaste('abc', { bracketed: true });
check('bracketed paste wraps the whole thing, not each chunk',
  bracketed.writes[0] === '\x1b[200~' &&
  bracketed.writes.at(-1) === '\x1b[201~' &&
  bracketed.writes.length === 3);

const wrapped = planPaste(big, { bracketed: true });
check('the markers stay outside every chunk of a long paste',
  wrapped.writes.slice(1, -1).join('') === big && wrapped.writes.length === 6,
  `${wrapped.writes.length} writes`);

const huge = planPaste('z'.repeat(PASTE_LIMIT + 1));
check('an oversized paste is refused, not truncated',
  huge.ok === false && huge.reason === 'too-large' && huge.writes.length === 0);
check('and reports how big it was', huge.size === PASTE_LIMIT + 1);

// ---- the round trip ------------------------------------------------------
const cli = await startCli(`${secure ? 'wss' : 'ws'}://${host}`);

const client = new TermlyClient({
  fatal: m => check('no fatal', false, m),
  log: () => {}, output: () => {}
});
client.connect(cli.code);
await sleep(2500);
check('paired', Boolean(client.aesKey));

// Take the CLI's place so the paste can be read back exactly as sent, without
// a tty's line discipline in the way.
cli.kill();
await sleep(1200);

const url = `${secure ? 'wss' : 'ws'}://${host}/ws/agent?sessionId=${encodeURIComponent(client.sessionId)}`;
const cliSocket = new WebSocket(url);
await new Promise((resolve, reject) => {
  cliSocket.once('open', resolve);
  cliSocket.once('error', reject);
});
// One CLI-only message so the relay classifies this socket as the CLI.
cliSocket.send(JSON.stringify({
  type: 'output', sessionId: client.sessionId, seq: client.lastSeq + 1,
  encrypted: false, data: ''
}));
await sleep(600);

const payload = Array.from({ length: 2600 }, (_, i) => String.fromCharCode(97 + (i % 26))).join('');
const received = [];
cliSocket.on('message', raw => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'input') received.push(msg);
});

const sent = planPaste(payload, { bracketed: true });
for (const write of sent.writes) {
  await client.sendInput(write);
  await sleep(20);
}
await sleep(1500);

check('every write reached the relay', received.length === sent.writes.length,
  `${received.length}/${sent.writes.length}`);
check('and each one was encrypted', received.every(m => m.encrypted === true));

const { deriveAESKey, computeSharedSecret, decrypt } = await import('../public/termly-crypto.js');
const key = await deriveAESKey(computeSharedSecret(client.keys.privateKey, client.cliPublicKey));
const rebuilt = [];
for (const msg of received) rebuilt.push(await decrypt(msg.data, msg.iv, key));

check('the paste decrypts to exactly what was copied',
  rebuilt.join('') === `\x1b[200~${payload}\x1b[201~`,
  `${rebuilt.join('').length} chars`);

cliSocket.close();
client.disconnect();

const passed = checks.filter(Boolean).length;
console.log(`\n=== ${passed}/${checks.length} checks passed ===`);
process.exit(passed === checks.length ? 0 : 1);
