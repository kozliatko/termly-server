/**
 * The service worker, run outside a browser.
 *
 * `sw.js` decides what is served from the network, what is served from a cache,
 * and what a new build is allowed to do to a page that is already running. None
 * of that was reachable from a test, and all of it fails silently: a worker that
 * caches the wrong thing looks fine until someone is stuck on a broken build.
 *
 * The file is a plain script over `self`, `caches` and `fetch`, so it runs under
 * a function wrapper with those three supplied. Nothing here touches jsdom - the
 * page's half of the update handshake is in test-ui.
 */
import { readFile } from 'node:fs/promises';

const ORIGIN = 'https://termly.test';

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
};

const keyOf = input => new URL(input.url ?? input, ORIGIN).href;

class FakeCache {
  constructor() { this.entries = new Map(); }
  // A real Cache hands out a fresh body every time; without the clone the second
  // read of an entry throws and the failure looks like a worker bug.
  async match(input) { return this.entries.get(keyOf(input))?.clone(); }
  async put(input, response) { this.entries.set(keyOf(input), response); }
  async add(input) {
    const response = await worldFetch({ url: keyOf(input), method: 'GET' });
    if (!response.ok) throw new Error(`add failed: ${keyOf(input)}`);
    this.entries.set(keyOf(input), response);
  }
  has(path) { return this.entries.has(keyOf(path)); }
}

const caches = {
  stores: new Map(),
  async open(name) {
    if (!this.stores.has(name)) this.stores.set(name, new FakeCache());
    return this.stores.get(name);
  },
  async keys() { return [...this.stores.keys()]; },
  async delete(name) { return this.stores.delete(name); }
};

/** What the network is doing right now. Tests move this around. */
const world = { offline: false, stall: false, requests: [], serve: () => ({ status: 200, body: 'ok' }) };

async function worldFetch(request) {
  world.requests.push(new URL(keyOf(request)).pathname);
  if (world.offline) throw new TypeError('Failed to fetch');
  // Connected, and moving nothing: a captive portal, a tunnel, a radio that
  // holds the link. `fetch` does not reject here - it simply never settles.
  if (world.stall) return new Promise(() => {});
  const { status, body } = world.serve(new URL(keyOf(request)).pathname);
  return new Response(body, { status });
}

// ---- load the worker -------------------------------------------------------

const listeners = new Map();
const self = {
  location: { origin: ORIGIN },
  addEventListener: (type, fn) => listeners.set(type, fn),
  skipWaiting: () => { self.skipWaitings++; },
  skipWaitings: 0,
  clients: { claim: async () => { self.claims++; } },
  claims: 0
};

const source = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
// eslint-disable-next-line no-new-func
new Function('self', 'caches', 'fetch', 'Response', 'URL', source)(
  self, caches, worldFetch, Response, URL);

/** Fire a lifecycle event and wait for whatever it registered. */
async function lifecycle(type, data) {
  const waits = [];
  await listeners.get(type)({ data, waitUntil: p => waits.push(p) });
  await Promise.all(waits);
}

/**
 * Fire a fetch event; null means the worker let it through to the network.
 *
 * A plain object rather than a real Request: `mode: 'navigate'` is exactly the
 * case worth testing and the constructor refuses to produce it, which is why the
 * spec reserves it for the browser. The worker only reads url, method and mode.
 */
async function request(path, { method = 'GET', mode = 'no-cors' } = {}) {
  const url = /^https?:/.test(path) ? path : ORIGIN + path;
  let handled = null;
  listeners.get('fetch')({
    request: { url, method, mode },
    respondWith: promise => { handled = promise; }
  });
  return handled ? await handled : null;
}

// ---- install ---------------------------------------------------------------

world.serve = path => path === '/icons/icon-192.png'
  ? { status: 404, body: 'gone' }
  : { status: 200, body: `body of ${path}` };

await lifecycle('install');
const cache = await caches.open('termly-shell');

check('the shell is precached', cache.has('/') && cache.has('/app.js') && cache.has('/vendor/xterm.js'));
check('one asset 404ing does not abort the install', cache.has('/app.css'),
  'the other entries are still there');
check('and the failed one is simply absent', !cache.has('/icons/icon-192.png'));

// The regression this file exists for: a worker that takes over on install
// replaces itself under a page still running the old sources.
check('installing does not seize the page', self.skipWaitings === 0);

await lifecycle('message', { type: 'skip-waiting' });
check('the page can ask for the handover', self.skipWaitings === 1);

await lifecycle('message', { type: 'something-else' });
check('and only that message causes one', self.skipWaitings === 1);
await lifecycle('message', undefined);
check('a message with no payload is not a crash', self.skipWaitings === 1);

// ---- activate --------------------------------------------------------------

caches.stores.set('termly-shell-v0', new FakeCache());
await lifecycle('activate');
check('an older cache is cleaned up', !caches.stores.has('termly-shell-v0'));
check('the current one is kept', caches.stores.has('termly-shell'));
check('and open pages are claimed', self.claims === 1);

// ---- what the worker refuses to touch --------------------------------------

check('a POST is left to the network', await request('/api/pair', { method: 'POST' }) === null);
check('another origin is left alone', await request('https://cdn.example.com/x.js') === null);
check('the API is live state, not a cache entry', await request('/api/health') === null);
check('so is the relay socket', await request('/ws/agent?code=ABC123') === null);

// ---- sources: network first ------------------------------------------------

world.serve = () => ({ status: 200, body: 'new build' });
check('a source comes from the network', await (await request('/app.js')).text() === 'new build');
check('and is kept in case the network goes', await (await cache.match('/app.js')).text() === 'new build');

world.serve = () => ({ status: 500, body: 'boom' });
await request('/app.js');
check('a failed response never replaces a good cache entry',
  await (await cache.match('/app.js')).text() === 'new build');

world.offline = true;
check('offline, the cached source is served', await (await request('/app.js')).text() === 'new build');

// A pairing link is a different cache key from the page it opens.
check('offline, a navigation with a query string still finds the shell',
  (await request('/?code=ABC123', { mode: 'navigate' })).ok);

const missing = await request('/never-seen.js');
check('offline and uncached is an explanation, not a hang', missing.status === 503);
check('and it says so in words', /offline/i.test(await missing.text()));

// ---- a network that is up but not answering --------------------------------

/*
 * Offline is the easy failure: `fetch` rejects and the cache takes over. The
 * failure a phone actually meets is the other one - the radio holds the link,
 * the request is accepted, and nothing ever comes back. `fetch` does not reject
 * for that, so a worker that only catches rejections waits for it forever, and
 * the app is a blank screen with a warm cache sitting right behind it.
 */

world.offline = false;
world.stall = true;
world.requests = [];

const raced = (promise, ms) =>
  Promise.race([promise, new Promise(r => setTimeout(r, ms, '__timed out__'))]);

const began = Date.now();
const stalledSource = await raced(request('/app.js'), 8000);
check('a stalled network does not hold the page hostage',
  stalledSource !== '__timed out__',
  stalledSource === '__timed out__' ? 'no answer in 8s' : `answered in ${Date.now() - began} ms`);
check('and what it answers with is the cached build',
  stalledSource !== '__timed out__' && await stalledSource.text() === 'new build');
// The offline checks just above ended with a fetch that rejected at once. If that
// counted as a stall, this request would have skipped the network entirely.
check('and it waited on the network first, rather than writing it off in advance',
  Date.now() - began > 1000, `waited ${Date.now() - began} ms`);
check('while the network request is left running, so the cache still refreshes',
  world.requests.includes('/app.js'));

// A stall is a property of the connection, not of one file. Having paid the wait
// once, the rest of the page load must not pay it again.
const second = Date.now();
const alsoStalled = await raced(request('/app.css'), 8000);
check('a second request during the same stall is not made to wait all over again',
  alsoStalled !== '__timed out__' && Date.now() - second < 500,
  `${Date.now() - second} ms`);

// Nothing cached means there is nothing better than the network, however slow it
// is being. Answering with an error would turn a slow load into a broken one.
const nothingToFallBackOn = await raced(request('/never-cached.js'), 1500);
check('with no cached copy the request is left with the network, not failed early',
  nothingToFallBackOn === '__timed out__');

world.stall = false;

// ---- vendored assets: cache first, refreshed behind you --------------------

world.offline = false;
world.serve = () => ({ status: 200, body: 'xterm v2' });
world.requests = [];

const vendored = await request('/vendor/xterm.js');
check('a vendored asset is served from the cache', await vendored.text() === 'body of /vendor/xterm.js');
check('without waiting for the network', world.requests.includes('/vendor/xterm.js'));

await new Promise(r => setTimeout(r, 10));
check('but it is refreshed for next time',
  await (await cache.match('/vendor/xterm.js')).text() === 'xterm v2');

world.requests = [];
const uncachedIcon = await request('/icons/icon-192.png');
check('a vendored asset that is not cached falls back to the network',
  await uncachedIcon.text() === 'xterm v2');
check('and is cached from there', cache.has('/icons/icon-192.png'));

world.offline = true;
const lostIcon = await request('/icons/nothing.png');
check('offline with neither cache nor network is a 504, not an exception',
  lostIcon.status === 504);

const passed = checks.filter(Boolean).length;
console.log(`\n=== ${passed}/${checks.length} checks passed ===`);
process.exit(passed === checks.length ? 0 : 1);
