/**
 * Service worker: makes the app installable and lets the shell open instantly.
 *
 * It deliberately does NOT try to make the terminal work offline - a relay
 * session is live by definition. What it buys is a shell that loads without a
 * round-trip and an install prompt on Android, which Chrome withholds unless a
 * worker with a fetch handler is registered.
 *
 * Staleness rule: the client sources are network-first, so a deploy takes
 * effect on the next load even though this file did not change. Only the
 * vendored bundle and icons are served from cache first, and those revalidate
 * in the background.
 *
 * Patience rule: network-first is bounded. A network that has stopped answering
 * without saying so must not be allowed to hold the shell back indefinitely -
 * see NETWORK_DEADLINE.
 *
 * Update rule: a new worker waits for the page to ask for it. See the message
 * handler below.
 */

const CACHE = 'termly-shell';

const SHELL = [
  '/',
  '/app.js',
  '/app.css',
  '/termly-client.js',
  '/termly-crypto.js',
  '/termly-session.js',
  '/paste.js',
  '/manifest.webmanifest',
  '/vendor/xterm.js',
  '/vendor/xterm.css',
  '/vendor/addon-fit.js',
  '/vendor/addon-web-links.js',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/apple-touch-icon.png'
];

const IMMUTABLE = /^\/(vendor|icons)\//;

/*
 * How long the network gets before the cache answers on its behalf.
 *
 * Offline is the failure that is easy to handle: `fetch` rejects and the catch
 * below takes over. The failure a phone actually meets is the other one - a lift,
 * a tunnel, a captive portal - where the radio holds the link, the request is
 * accepted, and nothing ever comes back. `fetch` does not reject for that. It
 * simply never settles, and a worker that waits on it shows a blank screen with
 * a warm cache sitting right behind it, for as long as the user is willing to
 * stare at it.
 *
 * Three seconds is chosen to lose the race on a healthy connection. That matters:
 * the sources are network-first precisely so a deploy lands on the next load, and
 * a deadline short enough to beat a working network would quietly turn the whole
 * shell cache-first and pin phones to old builds.
 */
const NETWORK_DEADLINE = 3000;

/*
 * A stall belongs to the connection, not to one file.
 *
 * A page load asks for a dozen things at once. Paying the deadline on each of
 * them independently is both slow and wrong: the ones that happen to answer come
 * from the new build and the ones that time out come from the old one, and the
 * page is assembled out of two builds that were never tested together. So the
 * first timeout puts the worker in cache-answering mode for long enough to cover
 * the rest of the burst, and the window is left to expire on its own rather than
 * being cleared by a straggler that would re-mix the very load it arrived in.
 *
 * Only a timeout arms it. A `fetch` that rejects at once is the network being
 * absent, not the network being slow, and the cache answers that case without
 * any waiting to skip - treating it as a stall would keep serving stale sources
 * for ten seconds after the connection came back.
 */
const STALL_WINDOW = 10000;
const TIMED_OUT = Symbol('the network did not answer in time');
let stalledUntil = 0;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // One failed asset must not abort the whole install.
    await Promise.allSettled(SHELL.map(url => cache.add(url)));
  })());
});

/**
 * A new worker waits instead of replacing the running one.
 *
 * Calling skipWaiting() here would hand a page that is already running the old
 * build a cache serving the new one, in the middle of a live terminal session.
 * The page offers the update, and asks for the swap only once the user takes
 * it - at which point the page reloads, so both halves are the same build.
 *
 * The cache is deliberately not versioned along with it. The client sources are
 * network-first, so a stale entry can only be served offline, and the two
 * cache-first trees are addressed by path: a bumped vendor bundle is a new
 * filename. Versioning would buy build isolation at the cost of a manual bump
 * that will one day be forgotten, which is exactly this behaviour again.
 */
self.addEventListener('message', event => {
  if (event.data?.type === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(n => n !== CACHE).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // The API and the relay socket are live state; caching either would be a bug.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/')) return;

  event.respondWith(IMMUTABLE.test(url.pathname)
    ? staleWhileRevalidate(request)
    : networkFirst(request));
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);

  // Started before anything is awaited, and never abandoned: whichever copy is
  // served, the cache ends up holding the newest one the network managed to
  // deliver. A rejection is folded into `null` here so that the loss of the
  // network reads the same as running out of patience with it.
  const network = fetch(request)
    .then(response => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);

  // A pairing link is a different cache key from the page it opens, so a
  // navigation falls back to the shell itself.
  const cached = await cache.match(request)
    || (request.mode === 'navigate' ? await cache.match('/') : null);

  if (cached) {
    if (Date.now() < stalledUntil) return cached;

    const response = await Promise.race([
      network,
      new Promise(resolve => setTimeout(resolve, NETWORK_DEADLINE, TIMED_OUT))
    ]);
    if (response === TIMED_OUT) stalledUntil = Date.now() + STALL_WINDOW;
    else if (response) return response;

    return cached;
  }

  // Nothing cached. The network is the only answer there is, however long it
  // takes - giving up early would turn a slow load into a broken one.
  return (await network) || new Response(
    'Termly is offline and this page is not cached yet.',
    { status: 503, headers: { 'Content-Type': 'text/plain' } }
  );
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);

  // Path-addressed assets keep their URL across versions, so a cache hit still
  // has to be refreshed in the background or a bumped xterm would never land.
  const network = fetch(request)
    .then(response => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);

  return cached || (await network) || new Response('', { status: 504 });
}
