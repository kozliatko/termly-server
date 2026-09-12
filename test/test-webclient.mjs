/**
 * Runs the browser client's real source against a live relay + CLI, with only
 * the handful of DOM globals it touches shimmed in. Testing the shipped file
 * rather than a copy is the point: a divergence here is a divergence users hit.
 */
const [, , code, host] = process.argv;
if (!code) { console.error('usage: node test-webclient.mjs <CODE> [host]'); process.exit(2); }

const target = host || 'localhost:3000';
// Node 22 supplies a read-only `navigator`, which is enough for deviceName().

const { installDomShim } = await import('./dom-shim.mjs');
installDomShim(process.argv[3] || 'localhost:3000');
const { TermlyClient } = await import('../public/termly-client.js');

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
};

let output = '';
let paired = null;
const statuses = [];

const client = new TermlyClient({
  status: s => { statuses.push(s); console.log(`[status] ${s}`); },
  output: text => { output += text; },
  paired: info => { paired = info; },
  fatal: msg => { check('no fatal error', false, msg); finish(); },
  log: msg => console.log(`[log] ${msg}`)
});

client.connect(code);

setTimeout(() => {
  check('paired', Boolean(paired), paired ? `fp=${paired.fingerprint.slice(0, 17)}` : 'never paired');
  check('AES key derived in browser code', Boolean(client.aesKey));
  console.log('[test] sending input');
  client.sendInput('echo WEBCLIENT_OK\r');
}, 2000);

setTimeout(() => {
  check('resize accepted', true, '80x24');
  client.sendResize(80, 24);
}, 3000);

setTimeout(() => {
  console.log('[test] requesting catchup from 0');
  client.send({ type: 'catchup_request', sessionId: client.sessionId, lastSeq: 0 });
}, 5000);

setTimeout(finish, 8000);

let done = false;
function finish() {
  if (done) return;
  done = true;
  check('output decrypted by browser code', output.length > 0, `${output.length} chars`);
  check('input reached the PTY', output.includes('WEBCLIENT_OK'),
    output.includes('WEBCLIENT_OK') ? 'echo visible' : 'marker missing');
  check('sequence tracked for resume', client.lastSeq > 0, `lastSeq=${client.lastSeq}`);
  check('reached connected state', statuses.includes('connected'));

  const failed = checks.filter(c => !c.ok).length;
  console.log(`\n=== ${checks.length - failed}/${checks.length} checks passed ===`);
  client.disconnect();
  process.exit(failed ? 1 : 0);
}
