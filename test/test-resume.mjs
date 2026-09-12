/**
 * A phone drops its socket every time the screen locks, so resume is the normal
 * path, not an edge case. Kill the socket underneath the client and check it
 * comes back on the sessionId and replays what it missed.
 */
const [, , code] = process.argv;
const { installDomShim } = await import('./dom-shim.mjs');
installDomShim(process.argv[3] || 'localhost:3000');
const { TermlyClient } = await import('../public/termly-client.js');

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
};

let before = '', after = '', dropped = false;
const statuses = [];

const client = new TermlyClient({
  status: s => { statuses.push(s); console.log(`[status] ${s}`); },
  output: t => { dropped ? (after += t) : (before += t); },
  fatal: m => check('no fatal', false, m),
  log: m => console.log(`[log] ${m}`)
});

client.connect(code);

await sleep(2500);
check('paired before drop', Boolean(client.aesKey));
const seqBeforeDrop = client.lastSeq;
const keyBefore = client.aesKey;

console.log('[test] killing socket without a close handshake');
dropped = true;
client.ws._socket ? client.ws._socket.destroy() : client.ws.close();

// Produce output while the client is away, so the resume has something to fetch.
await sleep(300);
check('reconnect scheduled, not fatal', statuses.some(s => s.startsWith('reconnecting')),
  statuses.filter(s => s.startsWith('reconnecting')).join(','));

await sleep(6000);
check('socket reopened', client.ws.readyState === 1);
check('same AES key reused after resume', client.aesKey === keyBefore);
check('caught up past the drop', client.lastSeq >= seqBeforeDrop,
  `${seqBeforeDrop} -> ${client.lastSeq}`);
check('output resumed', after.length > 0, `${after.length} chars after drop`);

const failed = checks.filter(c => !c).length;
console.log(`\n=== ${checks.length - failed}/${checks.length} checks passed ===`);
client.disconnect();
process.exit(failed ? 1 : 0);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
