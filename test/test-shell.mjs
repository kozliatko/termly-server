/**
 * The service worker's shell list must match what the page really loads.
 *
 * A missing entry does not fail anywhere visible: the page works online and
 * breaks only offline, on someone else's phone. So derive the truth from the
 * HTML and the import graph rather than trusting the list to stay in step.
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pub = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
};

const html = await readFile(path.join(pub, 'index.html'), 'utf8');

// Everything the document pulls in directly.
const direct = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map(m => m[1]);

// Then follow the ES module graph from the entry points.
const seen = new Set();
async function follow(url) {
  if (seen.has(url) || !url.endsWith('.js')) return;
  seen.add(url);
  const file = path.join(pub, url);
  if (!existsSync(file)) return;
  const source = await readFile(file, 'utf8');
  for (const m of source.matchAll(/from\s+'\.\/([a-zA-Z0-9._-]+)'/g)) {
    await follow(`/${m[1]}`);
  }
}
for (const url of direct) await follow(url);

/*
 * Vendored files are served by their own cache-first rule, but they still have
 * to be precached by name - the rule says how they are served, not that they
 * are there. Excluding them here is how an addon added to the page but not to
 * the shell list stayed invisible, so they are checked like everything else.
 */
const needed = [...new Set([...direct, ...seen])];

const sw = await readFile(path.join(pub, 'sw.js'), 'utf8');
// Only the SHELL array: the worker also names /api/ and /ws/ in its bypass
// rules, and those are paths it must never cache.
const shellBlock = sw.match(/const SHELL\s*=\s*\[([\s\S]*?)\];/);
const shell = shellBlock ? [...shellBlock[1].matchAll(/'(\/[^']*)'/g)].map(m => m[1]) : [];

check('the shell list is not empty', shell.length > 0, `${shell.length} entries`);

const missing = needed.filter(u => !shell.includes(u));
check('every file the page loads is in the shell list', missing.length === 0,
  missing.join(', ') || `checked ${needed.length}`);

const dangling = shell.filter(u => u !== '/' && !existsSync(path.join(pub, u)));
check('every shell entry exists on disk', dangling.length === 0, dangling.join(', '));

check('the document itself is cached', shell.includes('/'));
check('the manifest is cached', shell.includes('/manifest.webmanifest'));

// A service worker that caches itself can never be replaced.
check('the worker does not cache itself', !shell.includes('/sw.js'));

// These would break the strict CSP, which forbids inline script and style.
check('no inline script in the document', !/<script(?![^>]*src)[^>]*>[\s\S]*?\S/.test(html));
check('no inline style attribute', !/\sstyle="/.test(html));
check('no inline event handler', !/\son(?:click|load|error|submit|change|input)=/.test(html));

const passed = checks.filter(Boolean).length;
console.log(`\n=== ${passed}/${checks.length} checks passed ===`);
process.exit(passed === checks.length ? 0 : 1);
