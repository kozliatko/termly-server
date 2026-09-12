/**
 * The PWA cold-start path.
 *
 * An installed PWA on iOS is killed and restarted far more readily than a tab.
 * When that happens the page loses everything in memory, and the pairing code
 * is already spent - so if the saved blob cannot rebuild the session, the only
 * recovery is walking back to the desktop. This test throws the client away
 * entirely and rebuilds from storage alone.
 */
import { installDomShim } from './dom-shim.mjs';

const [, , code, host] = process.argv;
if (!code) { console.error('usage: node test/test-restore.mjs <CODE> [host]'); process.exit(2); }
installDomShim(host || 'localhost:3000');

const { TermlyClient } = await import('../public/termly-client.js');
const { saveSession, loadSession, clearSession } = await import('../public/termly-session.js');

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
};

// ---- first run: pair and save --------------------------------------------
let firstOutput = '';
const first = new TermlyClient({
  output: t => { firstOutput += t; },
  persist: () => saveSession(first.snapshot()),
  fatal: m => check('no fatal on first run', false, m),
  log: () => {}
});
first.connect(code);
await sleep(2500);

check('paired on first run', Boolean(first.aesKey));
check('session written to storage', Boolean(loadSession()));
const stored = loadSession();
check('stored blob carries the private key', Boolean(stored?.privateKey));
check('stored blob carries the CLI public key', Boolean(stored?.cliPublicKey));
check('AES key itself is NOT stored', !JSON.stringify(stored).includes('aesKey'));

const seqBefore = first.lastSeq;
const fpBefore = await fingerprintOf(stored.cliPublicKey);

// ---- simulate the kill: drop every reference ------------------------------
console.log('[test] discarding the client, as a PWA cold start would');
first.disconnect();
await sleep(700);

// ---- second run: rebuild from storage alone -------------------------------
let secondOutput = '';
let restoredFp = null;
const second = new TermlyClient({
  output: t => { secondOutput += t; },
  paired: info => { restoredFp = info; },
  persist: () => saveSession(second.snapshot()),
  fatal: m => check('no fatal on restore', false, m),
  sessionLost: m => check('session survived the restart', false, m),
  log: m => console.log(`[log] ${m}`)
});

const blob = loadSession();
check('blob still loadable after teardown', Boolean(blob));
await second.restore(blob);
await sleep(4000);

check('restore reported it was restored', restoredFp?.restored === true);
check('fingerprint identical after restore', restoredFp?.fingerprint === fpBefore,
  restoredFp?.fingerprint?.slice(0, 17));
check('socket open after restore', second.connected);

// The real proof: a key rebuilt from storage still decrypts live traffic.
check('decrypts output after restore', secondOutput.length > 0, `${secondOutput.length} chars`);
check('caught up past the restart', second.lastSeq >= seqBefore, `${seqBefore} -> ${second.lastSeq}`);

const marker = `RESTORE_OK_${Date.now() % 100000}`;
await second.sendInput(`echo ${marker}\r`);
await sleep(2500);
check('input encrypted with the rebuilt key reaches the PTY',
  secondOutput.includes(marker), marker);

// ---- logout must leave nothing behind -------------------------------------
clearSession();
check('clearSession wipes the blob', loadSession() === null);

const failed = checks.filter(c => !c).length;
console.log(`\n=== ${checks.length - failed}/${checks.length} checks passed ===`);
second.disconnect();
process.exit(failed ? 1 : 0);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function fingerprintOf(key) {
  const { fingerprint } = await import('../public/termly-crypto.js');
  return fingerprint(key);
}
