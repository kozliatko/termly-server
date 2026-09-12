# termly-local-server

[![License: MIT](https://img.shields.io/github/license/kozliatko/termly-server)](LICENSE)
[![Node.js >=22](https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white)](package.json)
[![PWA installable](https://img.shields.io/badge/PWA-installable-5A0FC8?logo=pwa&logoColor=white)](#installing-it-as-an-app)
[![Last commit](https://img.shields.io/github/last-commit/kozliatko/termly-server)](https://github.com/kozliatko/termly-server/commits/main)

A self-hosted relay for the [Termly CLI](https://github.com/termly-dev/termly-cli).
It pairs your CLI with a phone and forwards messages between them, and it
serves its own web client at `/` so no app install is required.

The relay is **zero-knowledge**: the CLI and the phone perform a Diffie-Hellman
exchange through it and encrypt everything with a key this process never
derives. It sees pairing codes and public keys, never terminal contents.

## Running

```bash
npm install
npm start                 # loopback only, port 3000
npm run start:lan         # bind 0.0.0.0 so a phone on the LAN can reach it
npm run start:debug       # verbose logging, including heartbeats
```

Then point the CLI at it:

```bash
TERMLY_ENV=local termly start
```

`local` is hardcoded to `ws://localhost:3000` in the CLI, so **port 3000 is the
only default that works without patching the client.**

### Docker

```bash
docker compose up -d
```

Caddy picks the container up from its labels, issues a certificate and serves
the relay at `https://termly.kozliatko.sk`. The domain is set in the `caddy`
label in `docker-compose.yml`; `.env` is optional and only overrides timing and
log level. The service publishes no ports: it is
reachable only through the proxy, on the shared external `caddy` network.

`TERMLY_TRUST_PROXY=1` is set in compose because Caddy terminates the client
connection. Without it every socket would look like it came from the proxy and
the per-IP limits would collapse into a single bucket. Do **not** set it when
running the relay directly on a public port — a client could then forge
`X-Forwarded-For` and escape those limits.

### Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `TERMLY_LOCAL_PORT` | `3000` | Listen port |
| `TERMLY_BIND` | `127.0.0.1` | Bind address; `0.0.0.0` to expose on the LAN |
| `TERMLY_HEARTBEAT_MS` | `5000` | Ping interval, must stay well under the CLI's 13 s timeout |
| `TERMLY_PAIRING_TTL_MS` | `300000` | How long an unclaimed pairing code lives |
| `TERMLY_SESSION_TTL_MS` | `300000` | How long an idle session survives with nobody connected |
| `TERMLY_LOG_LEVEL` | `info` | `error`, `warn`, `info`, `debug` |
| `TERMLY_TRUST_PROXY` | unset | `1` to read the client address from `X-Forwarded-For`; only behind a real proxy |
| `TERMLY_ALLOWED_ORIGINS` | unset | Extra origins allowed to open a WebSocket, comma-separated; the page this relay serves is always allowed and the CLI sends no `Origin` at all |
| `TERMLY_MAX_BUFFERED_BYTES` | `4194304` | Backlog a peer may carry before it is watched for a stall; eight times this is dropped on sight |
| `TERMLY_MAX_BUFFERED_MS` | `10000` | How long a backlog over that cap may persist before the peer is dropped to resync |

## Pointing the CLI at it

The stock CLI cannot reach a self-hosted server on a domain. `TERMLY_ENV=local`
is hardcoded to `ws://localhost:3000`, and that same string is embedded in the
pairing QR code — so a phone scanning it would try to reach *its own*
localhost.

The `feature/self-hosted-server-url` branch of the CLI adds an override:

```bash
TERMLY_SERVER_URL=wss://termly.kozliatko.sk termly start
```

The URL flows into the QR code, so the phone connects to the same relay. The
HTTP origin is derived from it (`wss://` -> `https://`); set `TERMLY_API_URL`
only if the REST API lives somewhere else. With neither variable set the CLI
behaves exactly as before.

Without that patch, the only way to use this server is on the same machine:

```bash
ssh -L 3000:localhost:3000 user@server   # then TERMLY_ENV=local termly start
```

which works for the CLI but still leaves the phone unable to connect.

## Security

There is no authentication beyond the 6-character pairing code, and a paired
session is a **fully interactive terminal on the host**. Anyone who can reach
the server and guess a live code within its 5-minute window gets that terminal.

What limits that: codes expire after 5 minutes, are single-use, and failed
lookups are capped at 10 per IP per minute over the WebSocket — the only place
guesses can actually be made. The cap counts *misses* rather than attempts, so
guessing is still capped at ten a minute while a phone reconnecting to a session
it already holds is never charged for it; a separate, much looser ceiling caps
raw connection volume. That leaves brute force impractical, but it is not
authentication, and a public deployment is still a terminal behind a short
secret. Prefer a private network or a VPN if that trade is not acceptable.

The relay has no TLS of its own; behind Caddy it does not need any, and iOS App
Transport Security will refuse a cleartext `ws://` connection anyway.

Every response carries a strict CSP - no `unsafe-inline`, no third-party origin,
`object-src`/`base-uri`/`form-action` at `'none'`, framing denied - plus
`nosniff`, `Referrer-Policy: no-referrer`, and a `Permissions-Policy` that
grants only the camera the QR scanner needs. `connect-src` names this origin's
`ws://`/`wss://` explicitly rather than leaning on `'self'`, which Safari did
not extend to WebSockets before 15.4. HSTS is sent only when the proxy reports
the request arrived over HTTPS. This matters more than it would for a static
page: the web client stores a Diffie-Hellman private exponent in `localStorage`,
so script injection on this origin would disclose a session key.

## Protocol

Three HTTP endpoints and one WebSocket path, all derived from the CLI source:

- `GET /api/health` — status and session counts
- `GET /api/cli/version` — reports `minVersion: 0.0.0`; the CLI hard-exits when
  its version is below this, so a permissive floor keeps a self-hosted setup
  from being remotely killable
- `POST /api/pairing`, `POST /api/pairing/batch` — register a pairing code
- `ws://…/ws/agent?code=<CODE>` (first connect) or `?sessionId=<uuid>` (reconnect)

Both the CLI and the web client use the same `/ws/agent` path. The server tells
them apart by connection order — the CLI mints the code, so it always arrives
first — and corrects itself if a peer sends a message only the other side
produces.

## Web client

The relay serves a browser terminal at `/`. Open it on the phone, type the
six-character pairing code, and the session runs in the browser — this is the
only client this relay ships with, and the only one verified to work against a
self-hosted deployment.

| File | Role |
| --- | --- |
| `public/index.html` | Layout, pairing screen, terminal, menu |
| `public/app.css` | All styling - kept out of the HTML so the page needs no `unsafe-inline` |
| `public/app.js` | UI wiring: xterm, key bar, viewport, wake lock, install prompt |
| `public/termly-client.js` | Pairing handshake, relay protocol, resume, liveness probe |
| `public/termly-crypto.js` | modp14 DH via BigInt, HKDF-SHA256, AES-256-GCM |
| `public/termly-session.js` | Session persistence in `localStorage` |
| `public/paste.js` | Splits clipboard text into writes a tty will actually accept |
| `public/sw.js` | Service worker: caches the app shell |
| `public/manifest.webmanifest` | Install metadata and icons |

Browsers have no finite-field Diffie-Hellman - Web Crypto offers ECDH only - so
`termly-crypto.js` implements the modp14 group with BigInt `modPow`. Its output
is checked byte for byte against `node:crypto` before anything is built on top
of it; in particular, Node's `computeSecret()` zero-pads the shared secret to
the prime width, and a browser that did not pad would derive a different AES key
in roughly one session in 256.

`?code=ABC123` in the URL prefills the field. On browsers with `BarcodeDetector`
(Chrome/Android; not iOS Safari) a scan button appears and reads the CLI's QR
directly.

xterm.js is vendored into `public/vendor/` rather than loaded from a CDN, so the
page has no third-party origins. Refresh it with `npm run vendor` after bumping
the `@xterm/*` devDependencies. Two addons ride along: `addon-fit` sizes the grid
to the viewport, and `addon-web-links` turns `http(s)` URLs in the scrollback into
clickable links. The link handler opens a blank tab, clears its `opener` and only
then navigates, so the new tab cannot reach back into the page; the CSP needs no
change for it, since opening a tab is not a fetch.

### Installing it as an app

The page is a PWA: `manifest.webmanifest`, maskable icons and a service worker
that caches the app shell. Android/Chrome offers an install prompt, which the
page surfaces as an **Add to home screen** button; iOS has no prompt, so the
page shows the Share -> Add to Home Screen hint instead.

Installing is only worth doing because the session survives a cold start, which
took the three things below. A standalone PWA on iOS is killed and relaunched
aggressively, so without them installing would have been *worse* than a tab.

#### How a fix reaches an installed app

An installed PWA is opened, not navigated, and Chrome only looks for a new
worker on a navigation — so without help, the build it was installed with can
outlive every deploy. The page calls `registration.update()` every time it comes
back to the foreground, which is the only moment an app like this reliably has.

When a new worker has installed, it **waits**. Calling `skipWaiting()` on
install would hand a page that is already running the old sources a cache
serving the new ones, mid-session. Instead:

- Nothing at stake — no session, no half-typed pairing code — and the page takes
  the update immediately.
- Otherwise the banner offers a **Reload** button, and waits. A connection
  problem may take the banner over in the meantime; the update notice comes back
  when the line is quiet again rather than being lost to it.
- Taking it posts `{type:'skip-waiting'}` to the waiting worker and reloads on
  `controllerchange`, so the page and its worker are always the same build.

The cache is deliberately not versioned alongside this. The client sources are
network-first, so a stale entry can only ever be served offline, and the two
cache-first trees are addressed by path — a bumped vendor bundle is a new
filename. Versioning would buy build isolation at the price of a manual bump
that will one day be forgotten, which is this behaviour again.

**Session persistence.** `termly-session.js` keeps the session id, the DH
private exponent, the CLI's public key and the last sequence number in
`localStorage`. On load the client re-derives the AES key and reconnects with
`?sessionId=`, then a `catchup_request` replays whatever was missed. The AES key
itself is never stored - one secret at rest, not two. The blob is bound to
`location.host` and expires after 12 hours; **End session** in the menu wipes it.

**Liveness probing.** A phone that wakes on a different network often has a
socket that still reports `OPEN` but is dead. On `visibilitychange` and on the
`online` event the client sends a `catchup_request` and gives it 6 seconds; no
answer means reconnect. The probe is not extra protocol - it is the same message
that fetches anything missed while the screen was off.

**Wake lock.** A long-running agent is useless if the screen sleeps and the tab
is frozen. The client takes a `navigator.wakeLock` screen lock while a session
is open and re-acquires it when the page becomes visible again. It is on by
default and can be turned off in the menu.

Because the private exponent lives in `localStorage`, an XSS bug on this origin
would be a key disclosure, not just a nuisance. The server therefore sends a
strict CSP with no `unsafe-inline` anywhere, which is why the CSS is a separate
file and the HTML carries no inline handlers.

Two smaller things that matter on a real phone: the terminal height follows
`visualViewport` (multiplied by its `scale`, so pinching does not read as a
keyboard and reflow the terminal mid-gesture); and the
key bar handles `pointerdown` with `preventDefault` rather than `click`, because
the default action of a press moves focus and that closes the keyboard. It
listens for `click` as well, which only a keyboard can reach — `preventDefault`
on `pointerdown` suppresses the synthetic click a tap would otherwise produce.

### When the browser withholds something

The page has to survive being opened somewhere less capable than a fresh Chrome
on HTTPS.

**Blocked site data.** A browser told to block it throws on `localStorage`
itself, not merely on the write. Every read here is wrapped, including the two
preference reads that run at import - an exception there is a page that never
boots, not a forgotten font size.

**No HTTPS.** `crypto.subtle` exists only in a secure context, so a relay
reached at `http://192.168.1.10:3000` - the way most people try a self-hosted
thing first - has no encryption to offer. The page now says so in the error
region, leaves **Connect** disabled, offers no scanner, and does not surface a
saved session it could not decrypt, instead of failing with a TypeError from
inside the handshake.

**No camera, no clipboard, no service worker.** Each is a button that is not
offered rather than one that breaks: the scanner needs `BarcodeDetector` and
`getUserMedia`, **Paste** needs `clipboard.readText` (Firefox has none), and a
refused worker registration costs the offline shell and nothing else.

### Output that never arrives

The CLI replays from a 100 KB circular buffer whose `getAfter` returns whatever
survived eviction, without saying that anything was evicted - and the relay now
also drops a phone that has stopped draining its socket. Both reach the phone
identically: a sequence number further along than the one it left off at.
Splicing that on silently is worse than showing a hole, because the scrollback
then reads as continuous text that never existed in that order. The client
compares each incoming seq against the last one it drew and writes a dim
`— n chunks of output missing here —` exactly where the hole is. A sequence at
or below the current one is a CLI that restarted and began counting again, not a
gap, and is not marked.

### When a phone reads slowly, and when it stops reading

`ws.send` queues whatever the socket cannot write yet and has no ceiling of its
own, so a phone that keeps its connection open while draining nothing costs the
relay roughly 1.3 MB per MB the CLI produces, without limit.

The obvious answer - cap the queue, drop whoever exceeds it - is wrong, and
wrong in the ordinary case rather than a corner of it. A phone on a mobile link
drains everything it is sent, just slower than a local `cat` fills the queue.
Any large output puts it over any fixed ceiling. Dropping it there is precisely
where output is lost, because the CLI's replay buffer is 100 KB and the backlog
that triggered the drop was measured in megabytes - and then the CLI carries on
producing, and it happens again.

So over `TERMLY_MAX_BUFFERED_BYTES` (4 MB) the relay stops reading the *source*
instead: `ws._socket.pause()` on the other half of the session closes the TCP
window, and the CLI's own `write` starts blocking. No protocol was added for
this; the pressure travels back down the connection the way TCP has always
carried it. Reading resumes at half the cap, so the source is not let go into a
queue that is still full.

A peer that has genuinely gone is a different thing, and is told apart by
whether the backlog ever reaches a new low. If it does not for
`TERMLY_MAX_BUFFERED_MS` (10 s), the socket is destroyed rather than closed - a
close frame would queue behind the backlog it is meant to release - and the
source is let go. The phone sees a dropped connection, which is the one failure
it already knows how to recover from: reconnect, ask for everything after the
last seq it drew, carry on. Slow is forgiven indefinitely; absent is not.

### Bursts of output

Every frame off the socket is handled to completion before the next one starts.
Handling is asynchronous - output waits on an AES-GCM decrypt, pairing on a DH
derive - so running frames concurrently means they finish in whatever order the
crypto finishes in, and short frames finish first. The suite delivers a 400 KB
frame and a two-character prompt back to back and checks the prompt lands
behind the file, does the same across a catchup batch and the live output
following it, and checks that output arriving immediately after `pairing_ack`
is not decrypted before the key it needs exists.

### A network that is up but not answering

Offline is the failure that is easy to handle, and the one everybody tests: the
request rejects, and the cached shell is served instead. The failure a phone
actually meets is the other one. In a lift, in a tunnel, on a captive portal that
has not shown its login page yet, the radio holds the link and the request is
accepted — and nothing ever comes back. `fetch` does not reject for that. It
simply never settles.

The client sources are network-first so that a deploy lands on the next load, and
network-first with no deadline means exactly this: an app that is a blank screen,
for as long as the user is willing to look at it, with a warm cache sitting right
behind it. So the wait is bounded. If the network has not answered within three
seconds and there is a cached copy, the cached copy is served and the network
request is left running, so the cache is up to date whichever one wins.

Three seconds is deliberately long enough to lose the race on a working
connection — a deadline that beat a healthy network would quietly turn the whole
shell cache-first and pin phones to old builds. And because a stall belongs to
the connection rather than to one file, the first timeout puts the worker in
cache-answering mode for the next ten seconds, so the dozen requests of a single
page load are not each made to wait, and the page is not assembled out of two
different builds. A `fetch` that rejects at once is the network being absent
rather than slow; the cache answers that with no waiting to skip, so it does not
arm the window.

With nothing cached there is no better answer than the network, however slow it
is being, and the request is left with it — giving up early would turn a slow
load into a broken one.

### Whose terminal it is

Measuring the browser window and resizing the CLI to match is the obvious thing
to do, and it is wrong. The CLI starts its pty at the size of the terminal
`termly start` was run in and then ignores its own `SIGWINCH` for as long as a
phone is attached, so a size sent from the browser sticks to the pty until the
phone leaves. The user's own terminal reflows underneath them, and any
full-screen program running in it redraws at a width that is not theirs. A phone
is a second window onto that session, not the authority on how wide it is.

So the CLI states its size when it registers the pairing code, the relay carries
it to whoever pairs - in `pairing_ack`, and again as `session_info` on every
reconnect, since a restored PWA has never seen a `pairing_ack` - and the web
client draws that grid, shrinking the text until it fits rather than changing the
number of columns. Below a floor of 5px the grid stops shrinking and the
terminal pans instead, because at that point the answer is a scrollbar and not
smaller letters.

Nothing is guessed. An older CLI says nothing, a value that is not a positive
integer is discarded at both ends, and either way the client falls back to
measuring its own window exactly as before. The menu says which of the three it
is doing - `140 × 50 · from CLI`, `browser window`, or a size pinned by hand for
a CLI that cannot be patched.

### What a real browser is for

Every UI suite here runs in jsdom against a stand-in terminal. That covers the
logic and none of the engine: xterm never parses an escape sequence, and an API a
real V8 implements differently would pass straight through. `test-browser.mjs`
loads the shipped page in headless Chrome and drives it over the DevTools
protocol, using the `ws` dependency already in the project rather than adding a
browser-automation stack.

The question that prompted it was whether an escape sequence split across a chunk
boundary survives — output arrives in whatever pieces the pty produced, and after
a gap the client now injects a marker of its own into that stream. The vendored
xterm answers for itself: `\x1b[3` followed by `1mRED` in two separate writes
renders `RED` in red, and an ESC after an unfinished sequence aborts it rather
than swallowing what follows. Both are now checks rather than assumptions.

### Without a pointer

Everything the session offers is reachable from a keyboard, and says what it is
to a screen reader. The `•••` popup is a real `role="menu"`: arrows walk it and
wrap, `Home`/`End` jump to the ends, `Escape` closes it and hands focus back to
the button that opened it, and `ArrowDown`/`ArrowUp` on that button open it onto
the first or last item. Tabbing past the end closes it rather than leaving it
floating over the terminal - but only when the focus went somewhere, since a
blur with no `relatedTarget` is the window losing focus, or a browser that does
not focus a button when it is tapped.

The page does not block zooming. It used to carry `user-scalable=no`, which is
the sort of thing that gets pasted in to stop iOS zooming a small input on
focus - a problem this page does not have, since the code field is 30px and the
buttons 16px. What it did have was 13px of terminal output that a low-vision
user could not pinch. The layout measurement was the reason it looked necessary,
and that is fixed above rather than papered over.

Colours were checked rather than assumed: every foreground token clears 4.5:1
against all three backgrounds it can appear on, and the one colour that carries
white text - `--accent` on a button - is 4.6:1.

### On-screen keys

A phone keyboard has no Esc, Tab or Ctrl, which makes a TUI unusable. The key
bar supplies them; `Ctrl` is a latch rather than a held key, so tapping it and
then a letter - or another bar key - sends the control code. `PgUp`/`PgDn` are
there because scrolling a pager by dragging the terminal is hopeless on a phone.

`Paste` appears where the browser exposes `clipboard.readText` (Firefox does
not, so it gets no button rather than a broken one). Clipboard text is split
into 1 KB writes: a tty in canonical mode takes about 4096 bytes per line and
silently drops the rest, so a single large write loses data no matter what the
relay would carry. If the app has bracketed paste on, the whole paste is wrapped
once - not each chunk - so an editor still knows it was pasted rather than typed.
Anything past 100 KB is refused outright instead of arriving truncated.

**Copy selection** is in the menu; press and hold to select first. A **Jump to
latest** button appears when output arrives below a scrolled-up viewport, which
a phone has no scrollbar to reveal. While a reconnect is counting down the
status banner carries a **Retry now** button: a user pressing it is better
evidence the network is back than the backoff timer is.

### Scanning a pairing code

Where the browser has `BarcodeDetector` — Chrome on Android — a **Scan QR code**
button appears. It accepts a JSON pairing payload, a link carrying
`?code=`/`#code=`, or a payload that is exactly six alphanumerics, and ignores
everything else. That last part is the whole point: the camera sees every QR in
front of it, and a looser reading turns `https://example.com/x` into `HTTPSE`
and pairs against nonsense.

The scan is cancellable: while it runs the button reads **Stop scanning**, and
tapping it releases the camera. So does backgrounding the app, and so does
starting a session by any other route. A camera that can only be stopped by
finding a valid code is a camera that stays on.

### Keyboard and screen reader

Every on-screen key has a spoken name — `↑` is "Up arrow", `^C` is "Control C,
interrupt" — and the Ctrl latch reports `aria-pressed`. The menu closes on
Escape and returns focus to its trigger, which reports `aria-expanded`. The
reconnect retry is a real button inside the status region rather than a click
handler on the message. Button text and the key fingerprint meet WCAG AA
contrast, and `:focus-visible` draws an explicit ring, because the browser
default is close to invisible on this background.

## Testing without a phone

`mock-mobile.js` performs the full mobile side of the protocol: DH handshake,
HKDF key derivation, AES-256-GCM decryption of live output, sending input, and
requesting a catchup replay.

```bash
# terminal 1
npm run start:debug

# terminal 2 - note the pairing code it prints
TERMLY_ENV=local termly start ./some-project --ai demo

# terminal 3
node mock-mobile.js <PAIRING_CODE>
```

It exits non-zero if any check fails.

The web client has its own harness, which imports the shipped browser sources
with only `location` stubbed - so it exercises the same files the phone loads:

```bash
npm test                          # everything, against a relay it starts itself
npm test -- termly.example.com    # everything, against a deployed relay
```

`test/run-all.mjs` mints a fresh `termly start` for each suite that needs one,
because a pairing code is single-use and reusing a spent one looks exactly like
a protocol failure. It also refuses to start when something is already listening
on :3000, since a stale relay answers `/api/health` just as happily as a fresh
one and the suite would silently validate old code. The suites can also be run
one at a time:

| Suite | Checks |
| --- | --- |
| `test-interop.mjs` | 10 - browser crypto byte-for-byte against `node:crypto` |
| `test-ui.mjs` | 180 - the UI layer in a jsdom document: pairing, QR, key bar, clipboard, banners, settings, ARIA, scanner lifecycle, soft keyboard, updates, keyboard navigation, degraded browsers, frame ordering under load, gaps in the replay, whose terminal size wins |
| `test-sw.mjs` | 33 - the service worker: precache, cache routing, the offline fallbacks, a network that is up but not answering, and the update handshake |
| `test-lifecycle.mjs` | 31 - a session over time: when it is reaped, when a reap is called off, what is left behind, who may claim it, and the terminal size it carries |
| `test-backpressure.mjs` | 10 - a peer that reads slowly is throttled rather than dropped and gets all ~56 MB, a peer that reads nothing is dropped and its session survives, and the relay's own resident memory stops tracking the flood |
| `test-webclient.mjs <CODE>` | 7 - pairing, input, output, resize, catchup |
| `test-browser.mjs <CODE>` | 16 - the shipped page in real Chrome: it boots, pairs through the form, types on a real keyboard, and xterm parses what the CLI actually sent, then draws a pinned grid at a font small enough to fit it. Skips with a message when no Chromium is installed |
| `test-resume.mjs <CODE>` | 6 - socket drop, reconnect, same key, catch up |
| `test-restore.mjs <CODE>` | 13 - PWA cold start: rebuild the key from storage alone |
| `test-shell.mjs` | 9 - the worker's cache list matches what the page loads |
| `test-paste.mjs [host]` | 15 - chunking, bracketed markers, and the round trip |
| `test-cli-restart.mjs [host]` | 13 - the CLI end dropping and coming back |
| `test-ratelimit.mjs [host]` | 6 - guessing is capped, holding a session is not. Spends every counter it touches, so it waits out the window and re-pairs if a previous run left the budget dirty |

`test-ui.mjs` loads the shipped `index.html` into jsdom and stubs the things
Node has no equivalent for — xterm, the WebSocket, the clipboard, the camera,
the visual viewport and a service worker registration — so `app.js` runs
unmodified. `test-sw.mjs` needs none of that: `sw.js` is a plain script over
`self`, `caches` and `fetch`, so it runs under a function wrapper with those
three supplied. The relay protocol underneath it is stubbed too: this
suite asserts the wiring (which tap sends what, which state follows which
message), not the crypto or the transport, both of which have their own suites.

What all of that shares is that no browser is involved, so nothing it asserts is
evidence about a browser. The stand-in terminal accepts every escape sequence
without parsing one, and an API that only a real engine implements differently —
or refuses outright — passes straight through. `test-browser.mjs` closes that:
it drives headless Chrome over the DevTools protocol using the `ws` dependency
the project already has, loads the page from the relay exactly as a phone would,
and collects `Runtime.exceptionThrown` so anything the engine objected to fails
the run. It is also the only place the vendored xterm parses anything, which is
where the split-escape question below is settled.

## Relationship to PR #49

This started from the `termly-local-server/server.js` proposed in
[termly-dev/termly-cli#49](https://github.com/termly-dev/termly-cli/pull/49) and
fixes the protocol mismatches that kept it from completing a session. See
`FIXES.md` for the list.
