#!/usr/bin/env node
/**
 * Runs the whole suite against a relay, minting a fresh CLI session for each
 * test that needs one.
 *
 * Pairing codes are single-use, so every protocol test needs its own `termly
 * start`. Doing that by hand is where stale-code false failures come from.
 *
 * Usage:
 *   node test/run-all.mjs                      # against a local server it starts
 *   node test/run-all.mjs termly.example.com   # against a deployed relay
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startCli } from './cli-harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const host = process.argv[2] || null;
const secure = host && !/^(localhost|127\.)/.test(host);
const relayHost = host || 'localhost:3000';
const serverUrl = `${secure ? 'wss' : 'ws'}://${relayHost}`;

const children = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));

process.on('exit', () => children.forEach(c => { try { c.kill('SIGKILL'); } catch {} }));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(130));

let server = null;
if (!host) {
  // A relay left over from an earlier run answers /api/health just as happily
  // as a fresh one, so the suite would silently test stale code. Refuse instead.
  const stale = await fetch('http://localhost:3000/api/health').then(() => true, () => false);
  if (stale) {
    console.error('✗ something is already listening on :3000.');
    console.error('  It would answer the tests with whatever code it was started from.');
    console.error('  Stop it, or point the suite at a host: node test/run-all.mjs <host>');
    process.exit(2);
  }

  console.log('› starting a local relay on :3000');
  server = spawn('node', [path.join(root, 'server.js')], {
    cwd: root,
    env: { ...process.env, TERMLY_LOG_LEVEL: 'warn' },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  children.push(server);

  for (let i = 0; ; i++) {
    await sleep(300);
    if (await fetch('http://localhost:3000/api/health').then(() => true, () => false)) break;
    if (i > 20) { console.error('✗ the relay never came up'); process.exit(2); }
  }
}

async function run(script, needsCode) {
  const label = path.basename(script, '.mjs');
  let session = null;
  const args = [path.join(here, script)];

  if (needsCode) {
    session = await startCli(serverUrl);
    args.push(session.code, relayHost);
  } else if (!needsCode && !['test-interop.mjs', 'test-shell.mjs', 'test-ui.mjs', 'test-sw.mjs', 'test-lifecycle.mjs', 'test-backpressure.mjs', 'test-history.mjs', 'test-dashboard.mjs'].includes(script)) {
    args.push(relayHost);
  }

  process.stdout.write(`\n──── ${label} ${'─'.repeat(Math.max(0, 46 - label.length))}\n`);
  const child = spawn('node', args, { cwd: root, stdio: 'inherit' });
  const [code] = await once(child, 'exit');

  if (session) session.kill();
  return { label, ok: code === 0 };
}

const results = [];
results.push(await run('test-shell.mjs', false));
results.push(await run('test-interop.mjs', false));
results.push(await run('test-ui.mjs', false));
results.push(await run('test-sw.mjs', false));
results.push(await run('test-lifecycle.mjs', false));
results.push(await run('test-backpressure.mjs', false));
results.push(await run('test-history.mjs', false));
results.push(await run('test-dashboard.mjs', false));
results.push(await run('test-webclient.mjs', true));
results.push(await run('test-browser.mjs', true));
results.push(await run('test-resume.mjs', true));
results.push(await run('test-restore.mjs', true));
results.push(await run('test-paste.mjs', false));
results.push(await run('test-cli-restart.mjs', false));
// Last: it deliberately burns the IP's budget, which would fail every suite
// scheduled after it.
results.push(await run('test-ratelimit.mjs', false));

console.log(`\n════ summary (${serverUrl}) ${'═'.repeat(20)}`);
for (const { label, ok } of results) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);

const failed = results.filter(r => !r.ok).length;
console.log(`  ${results.length - failed}/${results.length} suites passed`);
if (server) server.kill();
process.exit(failed ? 1 : 0);
