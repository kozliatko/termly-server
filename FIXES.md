# Changes against PR #49's `termly-local-server/server.js`

Every claim below was checked against the CLI source (`@termly-dev/cli` 1.9.5)
and, where marked *reproduced*, observed by running the real CLI against the
original file.

## Blocking bugs — the original could never complete a session

### 1. Heartbeat interval exceeded the CLI's timeout *(reproduced)*

The original pinged every 30 s. `lib/network/constants.js` sets
`HEARTBEAT_TIMEOUT: 13000`, doubled to 26 s only for a fresh connection, and the
CLI force-reconnects when nothing arrives in that window. The observed result
was an endless loop:

```
Lenient heartbeat check scheduled in 26.0s
⚠️  No response from server for 26.0s - forcing reconnection
```

Ping interval is now 5 s (`TERMLY_HEARTBEAT_MS`), matching the CLI's own comment
that the server pings every ~5 s.

### 2. `pairing_complete` carried the wrong field name *(reproduced)*

The original sent `mobilePublicKey`. `handlePairingComplete()` reads
`message.publicKey` and passes it to `computeSharedSecret()`, so the CLI died
with:

```
Failed to parse message: The first argument must be of type string or an
instance of Buffer... Received undefined
Received input but no encryption key set
```

The session paired, then relayed nothing, because the CLI never had an AES key.
Both field names are now sent, `publicKey` being the one that matters.

### 3. Peer classification branch was unreachable *(reproduced)*

Line 144 assigned `session.cliWs = ws` whenever `code` was present, so line
164's `if (code && !sessionId && !session.cliWs)` could never be true and every
CLI fell through to the "deferred" path — visible as both `CLI connected` and
`Peer connected (deferred)` for a single socket.

Classification is now explicit: the first socket on a session is the CLI (it
mints the code, so it always arrives first), and `classifyByMessage()` corrects
the assignment if a peer sends something only the other side produces.

### 4. Session ID mismatch on pre-pairing reconnect *(reproduced)*

The CLI adopts the server's session ID only when `pairing_complete` arrives.
Before that it reconnects with its own locally generated UUID, which the server
has never seen, and the original answered `close(4004, 'Session not found')`.
It cannot re-identify the client any other way — the CLI sends nothing on open.

`adoptOrphanReconnect()` now accepts such an ID as an alias when exactly one
unpaired session is missing its CLI, so the attribution is unambiguous.

### 5. `client_connected` arrived before the key exchange

The original announced the mobile as soon as its socket opened. `sendOutput()`
is gated on `mobileConnected && aesKey`, so output produced between those two
events was silently dropped. It is now sent after `pairing_complete`, and
immediately on connect only for a mobile rejoining an already-paired session.

## Correctness and lifecycle

### 6. Pairing codes never expired

The CLI's UI promises "Code expires in 5 minutes". The original kept a code
valid forever. Unclaimed codes are now reaped after `TERMLY_PAIRING_TTL_MS`,
and the CLI is closed with `pairing_expired`, a reason it handles specifically.

### 7. A used pairing code stayed live

`sessionsByCode` was never pruned after pairing, so a second peer could claim
the same session with a code that had already been spent. The entry is now
deleted on `mobile_pairing`.

### 8. Cleanup timers piled up

A 5-minute `setTimeout` was scheduled on every disconnect and never cancelled,
so a flapping connection accumulated timers that could destroy a session that
had since come back. There is now one reap timer per session, cleared whenever a
peer attaches.

### 9. Unclassified peers were sent their own messages

The original's default relay case (`ws._isCli ? mobileWs : cliWs`) echoed a
`null`-classified peer's message straight back to the CLI. Forwarding now
happens only once a peer's side is known.

### 10. Close reasons the CLI understands were never used

`lib/network/websocket.js` JSON-decodes the close reason and handles
`session_expired`, `session_not_found` and `pairing_expired` by exiting with a
clear message instead of retrying. The original closed with bare numeric codes,
so the CLI retried against a session that was gone. All closes now carry a
structured reason.

### 11. `catchup_batch` and `sync_complete` were only handled by accident

They worked through the `default` case. They are now explicit, alongside
`catchup_request` — which also records the mobile's `lastSeq`.

### 12. Binary frames were dropped

The original had a comment saying it would relay them and then did not. They are
now forwarded as binary.

## Hardening

### 13. Bound to `0.0.0.0` by default

A paired session is an interactive terminal, and the only credential is a
six-character code. The default is now loopback; `TERMLY_BIND=0.0.0.0` is an
explicit opt-in that logs a warning explaining the exposure.

### 14. No payload limit

`WebSocketServer` defaults to a 100 MB `maxPayload`. It is now 4 MB, well above
the largest possible catchup batch (100 chunks from a 100 KB buffer).

### 15. No input validation or rate limiting

Pairing codes are now checked against `/^[A-Z0-9]{6}$/`, public keys are
length-capped, duplicate codes are rejected with 409, and registrations are
limited to 30 per IP per minute.

More importantly, code *guesses* arrive over the WebSocket rather than the REST
API, so limiting only `/api/pairing` left the six-character code space open to
unlimited brute force. WebSocket connections are now capped at 10 per IP per
minute. Behind a proxy the client address comes from `X-Forwarded-For`, but only
when `TERMLY_TRUST_PROXY=1` says a proxy is genuinely in front — otherwise a
client could forge the header and escape the limit entirely.

### 16. Default port did not match the CLI

The original defaulted to 3001; the CLI's `local` environment is hardcoded to
3000, so an unmodified client could not reach it.

## Known limitations

- **No TLS.** A page served over `https://` cannot open a cleartext `ws://`
  connection (mixed content); a LAN deployment wants a `wss://` proxy in front.
- **No authentication** beyond the pairing code.
- **`lastMobileSeq` is advisory.** It records what the mobile asked to resume
  from; the CLI owns the real buffer and decides what to replay.
- **`TERMLY_ENV=local` cannot reach this server on a domain.** The CLI hardcodes
  `ws://localhost:3000` for that environment and embeds it in the pairing QR
  code, so the phone would dial its own localhost. The CLI branch
  `feature/self-hosted-server-url` adds a `TERMLY_SERVER_URL` override; see the
  README.

## Web client and PWA

The browser client under `public/` is the supported way to pair with a
self-hosted relay, and the only one verified end-to-end: `mock-mobile.js`
exercises the wire protocol, and `test-browser.mjs` runs the shipped page
itself in a real browser engine.

### 17. Finite-field DH in the browser

Web Crypto has ECDH but not modp14, so the group is implemented with BigInt
`modPow`. Node's `computeSecret()` zero-pads the shared secret to the prime
width (`DH_compute_key_padded`); a browser that stripped leading zeros instead
would derive a different AES key in roughly one session in 256. Caught by a
300-round interop test that failed once, then pinned by a regression test that
hunts specifically for leading-zero secrets.

### 18. Session survives a cold start

The DH private exponent, session id, CLI public key and last sequence number are
persisted; the AES key is re-derived on load rather than stored. Without this a
standalone PWA on iOS — which is killed and relaunched aggressively — would drop
the session on every switch away, making an installed app worse than a tab.
The server side already allowed it: the reap timer only arms when both peers are
gone, so a session outlives any client while the CLI holds its socket.

### 19. Dead sockets after a network change

A backgrounded phone often resumes with a socket that still reports `OPEN`. The
client probes with `catchup_request` — the protocol's own cheap round-trip — on
`visibilitychange` and `online`, and reconnects if nothing answers in 6s. The
server's heartbeat cannot cover this: it pings the CLI only, never the mobile.

### 20. Security headers

Storing a private exponent in `localStorage` turns XSS into key disclosure, so
the CSP allows no inline script or style and no third-party origin. `connect-src`
names the origin's `ws://`/`wss://` explicitly because Safari before 15.4 did not
treat `'self'` as covering WebSockets. `sw.js` is served `no-store` with
`Service-Worker-Allowed: /`; hashed-by-path assets (`/vendor/`, `/icons/`) get a
week, everything else `no-cache`.

### 21. The phone was never told the CLI came back

The relay sent `cli_disconnected` when the CLI's socket dropped but nothing when
it reattached — it notified only the CLI. The phone stayed on "CLI offline" over
a session that was live again, and the only way out was a manual reload. It now
sends `cli_reconnected` to the mobile, which the web client answers with a
`catchup_request` so the output produced in between is not simply lost.

Keystrokes typed while the CLI is gone used to be accepted and dropped on the
floor; they are now refused with the reason named, since "the relay is down" and
"the CLI is down" call for different reactions from the user.

### 22. Rate limiting locked users out of their own sessions

Every WebSocket connection was charged to one 10-per-IP-per-minute counter meant
for guessing pairing codes. A phone on a flaky network reconnects with backoff
(1s, 2s, 4s…) and the CLI reconnects on its own; between them a legitimate
session could exhaust the budget in under a minute and be refused entry to a
session it already held. Several phones behind one NAT shared the count.

The counter now charges only *failed* lookups. Guessing is nothing but failures,
so it is still capped at ten a minute; reaching an existing session — the thing
a real user does — never pays into it. A separate, much looser ceiling caps raw
connection volume so an IP still cannot flood the relay.

### 23. Clipboard, scrollback and reconnect controls

A phone keyboard cannot paste into a canvas terminal and a phone has no
scrollbar, so three things a desktop user takes for granted were simply absent.

Paste splits clipboard text into 1 KB writes, because a tty in canonical mode
accepts about 4096 bytes per line and drops the rest — a single large write
loses data regardless of what the relay carries. Bracketed paste markers wrap
the whole paste rather than each chunk. Text past 100 KB is refused rather than
silently truncated. The planning is a pure function in `public/paste.js` so its
boundary cases are testable without a DOM.

**Jump to latest** appears when output arrives below a scrolled-up viewport,
which xterm holds correctly but silently. The reconnect banner is tappable, so a
user who can see the network is back need not wait out a 15 s backoff.

### 24. The worker's cache list could go stale unnoticed

A module missing from the service worker's shell list breaks nothing online and
everything offline, on someone else's phone. `test-shell.mjs` derives the truth
from the HTML and the import graph and compares it to the list — it caught
`paste.js` the moment that file was added.

### 25. Three UI defects the DOM harness found

`app.js` decides what every element does and was the last sizeable file with no
test — everything else in `public/` is reachable from Node, but the UI layer
touches `document` at import. `test/dom-harness.mjs` puts the shipped
`index.html` in a jsdom window and stubs xterm, the WebSocket and the clipboard,
so `test-ui.mjs` runs the real module against a real document. Writing it turned
up three things, none of which is visible by reading the file:

**A latched Ctrl could get stuck.** Ctrl is a latch on a phone because there is
nothing to hold. Tapping it and then tapping a key with no control code — `|`,
`~`, `/`, `-`, or any arrow — sent the literal key and left the latch armed, so
the *next* keystroke silently became a control character. Any on-screen key now
clears the latch whether or not it maps.

**The geometry could be sent before there was a session to send it to.** The
real `cols`/`rows` went out on a 600 ms timer after the session view opened. A
handshake slower than that — a phone on a bad link — meant `sendResize` fired
with no `sessionId` and returned early, and the CLI kept rendering into the
default 80x24 until the next viewport change. It is now sent when pairing
completes, with the timer kept only for the font settling afterwards.

**The CLI-offline banner overwrote itself.** `cli_disconnected` raised
"The CLI disconnected — waiting for it to come back" and then, one line later,
the status update for the same event replaced it with the bare "CLI offline".
`setStatus` now leaves that banner to the handler that owns it.

### 26. A QR code that was not a pairing code still paired

The scanner took whatever the camera decoded, stripped it to alphanumerics and
paired if six characters survived. Six characters survive almost anything:
`https://example.com/x` becomes `HTTPSE`, and `call me back tomorrow` becomes
`CALLME`. The camera sees every QR in front of it, so pointing the phone at a
poster was enough to spend a rate-limit attempt on nonsense and report only
"Session not found".

Parsing is now explicit about what it accepts: a JSON pairing payload with a
`code`, a pairing URL carrying `?code=`/`#code=` — the same shape the page
already accepts in its own address bar, so a QR that is just a link now works —
or a payload that is *exactly* six alphanumerics. Anything else keeps scanning.

### 27. Accessibility pass

The interface was usable with a finger and nothing else.

**The retry was unreachable.** The reconnect banner said "tap to retry now" and
listened for a click on a `role="status"` div — no keyboard access, no button
semantics, nothing for a screen reader to activate. Retry is now a real
`<button>` inside the banner, so the status text is still announced as one
message and the action is focusable.

**The key bar was mute.** `↑`, `⏎`, `^C`, `|` are glyphs a screen reader spells
out or skips. Each key now carries an `aria-label` ("Up arrow", "Control C,
interrupt"), and Ctrl — a latch, since there is nothing to hold on a phone —
reports `aria-pressed`.

**The key bar was also finger-only.** It listened for `pointerdown` alone, to
`preventDefault` the focus change that would drop the soft keyboard. A keyboard
user got nothing. It now also listens for `click`, which a touch cannot reach:
`preventDefault` on `pointerdown` suppresses the synthetic click, so a tap still
sends exactly one keystroke.

**The menu was a keyboard trap.** It could only be dismissed by clicking
elsewhere. Escape now closes it and returns focus to the trigger, which reports
`aria-expanded`, and opening it moves focus to the first item.

**Contrast and focus.** White on `#2f81f7` is 3.8:1, under the 4.5:1 that button
text needs; the button fill is now `#1f6feb` at 4.6:1. The key fingerprint was
10px at 0.7 opacity — under 4:1 — and is now 11px at full strength. Nothing
defined a focus ring, and the browser default is close to invisible on this
ground, so `:focus-visible` now draws an explicit one.

## 28. The QR scanner could not be turned off

Starting a scan opened the camera and a `requestAnimationFrame` loop that ran
until a valid code appeared in front of it. Nothing else ended it:

- **No way to cancel.** Point it at the wrong thing and the only exit was
  reloading the page. The camera indicator stayed lit the whole time.
- **A second tap opened a second camera.** The permission prompt is slow enough
  that double-tapping happens by accident, and each tap started its own stream
  and its own frame loop. Stopping one left the other running.
- **Backgrounding the app left it recording.** Switching away from a PWA does
  not stop `getUserMedia`; the frames just went nowhere.
- **Resuming a stored session left it running behind the terminal.** The session
  view covers the preview, so the camera kept going with nothing on screen to
  suggest it.

There is now a single `scanning` session object. The button toggles it and
relabels itself, `visibilitychange` stops it, `startSession` stops it, a stream
obtained after another scan already started is stopped immediately, and the
frame loop exits as soon as it is no longer the current session or the stream
goes inactive.

## 29. A deploy could not reach an installed app

The worker called `skipWaiting()` in its `install` handler and `clients.claim()`
in `activate`, and the page did nothing else about updates. Three problems, in
increasing order of how long they hide:

- **A new worker took over a running page.** The page was still executing the
  old modules while its cache started answering with the new build. Nothing
  reloaded, so the two halves stayed out of step for the rest of the session.
- **Nothing told the user a new build existed.** Sources are network-first, so a
  reload picks the new build up — but a phone terminal is not reloaded, and
  nothing suggested it should be.
- **An installed app never looked.** Chrome checks for a new worker on
  navigation. An installed PWA is opened, not navigated, so a device could sit
  on the build it was installed with indefinitely.

The worker now waits and swaps only when the page asks
(`{type:'skip-waiting'}`); the page calls `registration.update()` whenever it
returns to the foreground, applies an update silently when nothing is at stake,
otherwise offers a **Reload** button in the banner, and reloads on
`controllerchange` so the page and its worker are never different builds.

The banner's button became generic in the process — a `{label, run}` action
rather than a hardwired retry — and `hideBanner` re-shows a pending update, so a
reconnect landing on top of the notice no longer swallows it.

**Registration could be missed entirely.** It was attached to `load`. A listener
added after that event has already fired never runs, which is what happens to a
module imported late. It now checks `document.readyState` first, and registers
`once` so a stray second `load` cannot register twice.

## 30. A session waiting to be paired could be claimed by anyone

The CLI calls itself by a locally generated UUID until `pairing_complete` tells
it otherwise. So a reconnect before pairing arrives with an id the relay has
never issued, and the relay has to accept it - there is nothing else to go on.

It accepted it far too broadly. Any unpaired session whose CLI socket happened
to be absent would take any id from any address, so a stranger could walk into
someone's session in the window between `termly start` and the phone pairing.
And every id ever offered was kept: a throwaway probe reconnected five times
under five invented ids, and afterwards **all five still opened the session** -
each one a working credential for the life of the session, and one more entry in
`sessionsById` that nothing ever removed.

Adoption is now bounded on both axes. The address that registered the code over
HTTP is recorded on the session, and only that address may be adopted; and a
session grants at most one such id at a time, retiring the previous one. The id
from the last restart therefore stops working the moment the CLI is attached
again, which is what `test-lifecycle.mjs` checks - along with the stranger being
turned away. Both checks fail against the relay as it was.

## 31. The session menu was a popup only a mouse could use

`•••` opened a `<div>` of buttons. It had an `aria-label` and it focused its
first item, which was enough to look considered and not enough to use: nothing
told a screen reader it was a menu or that the buttons in it were menu items,
the arrow keys did nothing, and tabbing past the last item left the menu open
and floating over the terminal with focus somewhere behind it.

It is now `role="menu"` with `role="menuitem"` children and `role="separator"`
dividers, `aria-haspopup="menu"` on the button, arrows that walk and wrap,
`Home`/`End`, `ArrowDown`/`ArrowUp` on the button to open onto the first or last
item, and a `focusout` that closes it when focus actually leaves. That last
condition matters: a blur with no `relatedTarget` is the window losing focus or
a browser that does not focus a tapped button, and closing on those would have
made the font-size buttons unusable on a phone. Dismissing by pointer stays with
the document click handler.

## 32. The page forbade zooming, because the layout could not survive it

The viewport meta carried `maximum-scale=1, user-scalable=no` - a WCAG 1.4.4
failure, on a page whose whole content is 13px of terminal output.

The reason it was there was real, though. `visualViewport.height` is the height
in CSS pixels *after* the pinch-zoom scale, so a page zoomed to 2x reports half
its height. The layout reads that height to keep the soft keyboard off the
cursor line, so allowing zoom would have meant the terminal reflowing under the
reader's fingers, every pinch and every pan.

Multiplying the scale back out makes the measurement zoom-invariant, which
leaves the keyboard case identical and lets the restriction go. The same change
skips the work entirely when the height has not moved - panning a zoomed page
fires `scroll` continuously, and each of those was refitting the terminal and
sending a resize down the wire for a size nothing had changed.

Contrast was audited at the same time and needed nothing: every foreground token
clears 4.5:1 on all three backgrounds, and `--accent` under white text is 4.6:1.

## 33. The rate-limit suite could not be run twice in a minute

It deliberately spends every counter it touches, and the relay's windows are one
minute wide. So a local pass followed by one against the deployed relay reported
the relay refusing the very first guess - a false failure that looks exactly
like a regression in the limiter.

It now recognises that shape (blocked on attempt one), waits the window out, and
re-pairs before counting again. The re-pairing is the part worth stating: the
check is that a legitimate pairing is not charged for the guesses, and a pairing
that happened in a previous window demonstrates nothing about the one being
counted. Without it the retry came up exactly one short.

## 34. Blocking site data made the page blank

`termly-session.js` had always probed `localStorage` before trusting it, because
Safari in private mode throws on write. The two preferences beside it did not:
`fontSize` and `wakeLock` were read with a bare `localStorage.getItem` at module
scope.

In a browser set to block site data the property access itself throws. That is
an exception during import, so nothing after it runs and nothing renders - not
a lost preference, a blank page and no terminal. Both reads and both writes now
go through a guarded pair, and the suite runs a whole session in a document
where touching `localStorage` throws.

## 35. Over plain http the app failed inside the handshake

`crypto.subtle` is only defined in a secure context. A self-hosted relay opened
at `http://<lan-ip>:3000` - the first thing anyone tries on their own network -
therefore has no WebCrypto at all, and every call in `termly-crypto.js` was a
call on `undefined`. The page offered a Connect button, took a code, and threw a
TypeError from inside pairing.

It now checks once, up front: the error region explains that the relay has to be
reached over HTTPS or from localhost, **Connect** stays disabled, the scanner is
not offered, and a stored session is not surfaced on an origin that could not
decrypt it.

## 36. Fast output could arrive in the terminal out of order

`ws.onmessage` called an `async` handler without waiting for it, so every frame
in a burst was handled concurrently. The output path awaits an AES-GCM decrypt
before it writes anything, and a short frame finishes that decrypt before a long
one that started first - measurably and repeatably, not as a rare race. `cat` a
large file and the shell prompt that follows it was written into the middle of
it; a catchup batch, which decrypts every entry it holds, could be overtaken
entirely by the live output that belonged after it.

The same gap silently dropped output. `pairing_ack` awaits the DH derive before
the AES key exists, so the first frame the CLI sent behind it reached the
decrypt with no key and was discarded without a word.

Frames are now handled one at a time, chained through a promise the socket
appends to, so the wire order is the order they are drawn in. A rejected handler
is caught rather than left to wedge the queue, and queued work checks that the
connection it came from is still the live one before acting on it.

## 37. One phone in a tunnel could take the relay down

Nothing on the forwarding path ever looked at whether a peer was keeping up.
`ws.send` queues what the socket cannot write yet and never refuses, so a phone
that holds its connection open while reading nothing - a tunnel, a pocket, a
dying battery - made the relay hold the entire output stream on its behalf.
Measured against the relay's own resident memory: 25 MB flooded into one stalled
peer cost 53 MB, 100 MB cost 134 MB, growing linearly with no ceiling and with
the socket still open at the end. A single session was enough to exhaust a
self-hosted relay.

The first attempt - drop anyone more than 4 MB behind - was worse than the
problem in one respect, and the suite caught it: a phone draining its socket
normally was cut off 39 frames into a 300-frame burst. Size does not separate a
burst from a stall, and because the CLI's replay buffer is 100 KB, a drop under
a flood is precisely where output goes missing.

What separates them is whether the backlog is going down. A peer over the soft
cap is left alone while it drains; it is dropped only if it is still over the cap
`TERMLY_MAX_BUFFERED_MS` later, or if it passes eight times the cap outright,
which bounds what the grace period itself can cost. Dropping is `terminate`, not
`close`, since a close frame queues behind the backlog it is supposed to free.
With the guard the same 112 MB flood leaves the relay 32 MB heavier instead of
131 MB, and stops tracking the flood entirely; a phone that drains normally now
receives all 300 frames of a 19 MB burst.

## 38. Lost output was spliced into the scrollback as if it had never existed

The CLI replays from a 100 KB circular buffer. `getAfter(seq)` filters what is
still in it and returns that - so a phone asking for everything after seq 100,
when eviction has already taken the buffer up to seq 350, gets 350 onwards and
no indication that 249 chunks are missing. The relay keeps no buffer of its own,
so there is nowhere else for that to be noticed. The previous fix made this more
common rather than less: a phone that stops keeping up is now dropped on
purpose, and a reconnect after a heavy burst is the ordinary case.

The result was not a visible hole but an invisible one. Two unrelated pieces of
output ended up adjacent, reading as one continuous stretch of terminal that
never happened in that order - which is worse than losing them, because there is
nothing to notice.

Sequence numbers are enough to detect this without any protocol change. The
client compares the seq of each arriving chunk, live or replayed, against the
last one it drew, and writes a dim `— n chunks of output missing here —` in the
place the output would have been. A seq at or below the current one means the
CLI restarted and began counting from one again - not a gap, and not marked, or
every CLI restart would carry a warning.

## 39. An installed PWA could hang on a blank screen with a warm cache behind it

The service worker served the client sources network-first, so that a deploy
lands on the next load without the worker file itself having to change. Offline
was handled: `fetch` rejects, and the cached shell is served instead.

The failure a phone actually meets is not offline. In a lift, in a tunnel, on a
captive portal that has not shown its login page yet, the radio holds the link
and the request is accepted — and nothing ever comes back. `fetch` does not
reject for that; it never settles. Measured against the worker running under the
test harness with a network that accepts and never answers: with a fully warm
cache, the worker never responded at all. An installed app would open to a blank
screen and stay there, indefinitely, with everything it needed already on disk.

The wait is now bounded. If the network has not answered within three seconds
and there is a cached copy, the cached copy is served, and the network request is
left running so the cache is refreshed whichever one wins. Three seconds is
chosen to lose the race on a healthy connection: a deadline short enough to beat
a working network would turn the shell cache-first and pin phones to old builds,
which is the problem network-first exists to avoid.

A stall belongs to the connection, not to one file, so the first timeout puts the
worker in cache-answering mode for ten seconds. Without that, the dozen requests
of one page load each pay the deadline separately, and — worse — the ones that
happen to answer come from the new build while the ones that time out come from
the old one, assembling a page out of two builds that were never tested together.
Only a timeout arms the window: a `fetch` that rejects immediately is the network
being absent rather than slow, and treating that as a stall would keep serving
stale sources for ten seconds after the connection came back.

With nothing cached the request is still left with the network however slow it is
being. There is no better answer available, and failing early would turn a slow
load into a broken one.

## 40. The browser half of the client was never run in a browser

Every UI suite ran in jsdom against a stand-in terminal that accepted escape
sequences without parsing any of them. That covers the logic and none of the
engine: the vendored xterm was never exercised, CSS was never applied, and an
error only a real V8 would raise had nowhere to surface.

`test-browser.mjs` loads the shipped page in headless Chrome over the DevTools
protocol — driven through the `ws` dependency already in the project, so no
browser-automation stack was added — pairs through the real form, types on a real
keyboard, and reads back what xterm actually put on screen. Exceptions raised in
the page are collected and fail the run.

It also settles a question that had been an assumption: output arrives in
whatever pieces the pty produced, so an escape sequence split across a chunk
boundary is routine, and since item 38 the client injects a gap marker of its own
into that stream. `\x1b[3` followed by `1mRED` in two separate writes renders
`RED` in red, and an ESC after an unfinished sequence aborts it rather than
swallowing what comes next. No defect — but it is now a check rather than a hope.

## 41. A phone on a slow link was dropped for being slow

Item 34 gave the relay a ceiling on how much it would queue for a peer, and a
hard limit above it that dropped the socket outright. Running the real client in
a real browser (item 40) showed what that costs: while the page consumed roughly
90 MB/s and its heap stayed under 4 MB, the relay dropped it **seven times in
twelve seconds**. Nothing was wrong with the phone. It was draining every byte —
just slower than a local `cat` could fill the queue.

This is the ordinary case, not a corner one. Any large output on a mobile link
puts the queue over any fixed ceiling, and a drop is exactly where output is
lost: the CLI's replay buffer is 100 KB, and the backlog that triggered the drop
is measured in megabytes. Then the CLI keeps producing and it happens again. The
reconnect machinery hides the disconnect, so the user sees only the hole it
leaves.

The ceiling is now a limit on what the relay will hold, not a verdict on the
peer. Over it, the relay stops reading the *source* — `ws._socket.pause()` on the
other half of the session — and the CLI's own write blocks. The pressure travels
back to whoever is producing too fast, which is where it belongs, and it does so
over TCP, with no frame added to the protocol. Reading resumes at half the cap so
the source is not released into a queue that is still full.

A peer that is genuinely gone still has to be cut loose, or it would hold the CLI
throttled forever — a terminal that freezes because of a phone in a drawer. The
two are told apart by whether the backlog ever reaches a new low, rather than by
how big it is. It never does for a peer that has stopped acknowledging anything.

Measured on the same flood the old code failed: 900 of 900 frames delivered,
~56 MB, no drop, with the CLI throttled to 44 MB queued. Against the previous
build the same test loses **527 of 900 frames**.

## 42. The phone resized the terminal the user was sitting in

The web client measured its own window, worked out how many columns and rows fit,
and sent that to the CLI - which passed it straight to the pty. Opening the page
on a laptop reflowed a 140x50 terminal to whatever the browser happened to be,
and it stayed that way: the CLI ignores its own `SIGWINCH` while a phone is
attached, so the pty keeps the browser's size until the phone disconnects. Anyone
still working in that terminal watched their prompt and any full-screen program
redraw at a width they had not chosen.

The mistake was in who was asked. A phone is a second window onto a session, not
the authority on its geometry. The CLI now states the size it started in when it
registers its pairing code; the relay carries that to whoever pairs, and repeats
it on every reconnect because a restored PWA never sees another `pairing_ack`.
The client draws that grid and shrinks the text to fit it, down to a 5px floor
below which the terminal pans instead.

None of it is guessed. A CLI that says nothing, or says something that is not a
positive integer, leaves the client measuring its own window as before, and the
menu shows which of the three sources is in use. The manual pin is there for a
CLI that cannot be patched.

## 43. Anyone sharing your address could take over a session you had not paired yet

A CLI whose socket dropped before pairing reconnected with `?sessionId=`, and the
id it sent was one it had generated locally - the relay had never seen it. Rather
than refuse, the relay guessed: it looked for an unpaired session registered from
the same address and handed it over, filing the invented id as an alias so the
next attempt would work too.

The address is not an identity. Behind CGNAT, a corporate egress, a university
network or a shared VPN, "same address" is thousands of people; the caller only
had to send a random uuid and arrive first, before the real CLI reconnected. The
victim then paired with the attacker's key, and their terminal was mirrored to a
stranger for as long as the session lived.

The fix is upstream of the relay. The relay already mints the session id when the
pairing code is registered and returns it in that response - the CLI was throwing
it away and inventing its own. It now adopts the minted id, which is the only
reason the guessing existed. `adoptOrphanReconnect`, the alias map, and the
`registeredFrom` address a session used to carry are gone; an id the relay did
not mint gets `session_not_found` no matter where it comes from.

End-to-end encryption limited the damage - the CLI will not accept input it
cannot decrypt, and AES-GCM rejects forgeries - so this read a terminal rather
than driving one. Note that an unpatched CLI that drops before pairing now gets
`session_not_found` instead of being adopted; the CLI fix ships with this.

## 44. Any page on the web could open a socket to this relay

WebSockets are not covered by the same-origin policy. A page on any domain could
dial this relay, and the browser would attach the visitor's address and network
position to the connection - which mattered because the relay was, at the time,
willing to hand out sessions on the strength of that address alone.

Upgrades now have to say where they come from. An `Origin` naming a host this
relay does not serve is refused at the handshake with a 403, so the page never
learns whether the session it named exists. A request with no `Origin` at all is
left alone: that is not a browser, and `ws` omits the header for non-browser
clients, so the CLI is unaffected. `TERMLY_ALLOWED_ORIGINS` names any additional
origin a web client is hosted on.

## 45. The rate limiter was a better denial of service than the flood it stopped

Every attempt was kept as a timestamp in an array, and every call re-filtered the
whole array to drop expired entries. That is quadratic in the number of attempts,
and the array was appended to even for callers that had just been rejected - so
an attacker grew the array they were about to be measured against with every
refused request.

The cost was not theoretical. 1,000 attempts inside one window took 18 ms; 10,000
took 1.5 s; 50,000 took 49 s of a single-threaded event loop, during which the
relay serves nobody. Reaching that was cheap, because being blocked did not stop
the counting.

Counters are now fixed windows: one small object per bucket, incremented and
compared, and not incremented past the ceiling where the answer can no longer
change. Idle buckets are swept once a minute, since a window only rolls over when
it is touched. A fixed window is coarser than a sliding one - a caller can spend
its budget at the end of one window and again at the start of the next - but a
factor of two on a flood ceiling is worth far less than not falling over. The
same million attempts that used to cost 49 s for one twentieth of them now cost
70 ms, with the limits still enforced.

## 46. Sluzobny worker necachoval vsetko, co stranka nacita

`test-shell.mjs` odvodzoval zoznam zo stranky, ale `/vendor/` a `/icons/` z neho
vyfiltroval s tym, ze ich pokryva vlastne pravidlo. To pravidlo (`IMMUTABLE`) vsak
hovori len o tom, ako sa subory servuju - nie o tom, ze su v precache. Diera bola
tichá: online stranka funguje, offline spadne.

Vyluka je prec, a vysla z nej dvojica skutocnych chybajucich poloziek:
`/vendor/addon-web-links.js` (novy addon) a `/icons/apple-touch-icon.png`. Obe su
teraz v `SHELL`.


## 47. A dashboard whose Caddy label would have shipped broken

Adding an operator dashboard meant gating `/dashboard*` and `/api/dashboard*`
with Caddy `basic_auth`, configured entirely through Compose labels so a
misconfigured or absent proxy fails closed rather than serving it wide open.
The first draft read the username from an env var in the label's *key*:
`caddy.basic_auth.${TERMLY_DASHBOARD_USER:-admin}`.

`docker compose config` showed why that was wrong before it ever reached
production: Compose interpolates `${...}` in a label's *value*, never in its
*key*. The rendered label kept the literal, un-substituted text as its key,
which caddy-docker-proxy would have read as a username containing a `$` and a
brace - never matching the credentials anyone actually typed. The username
isn't secret, so it is now hardcoded (`caddy.basic_auth.admin`) and only the
password hash - which does need to stay out of git - is read from `.env`.

A second, unrelated interpolation problem showed up in the same label: a
bcrypt hash is full of `$`-delimited fields (`$2a$14$...`), and Compose's own
`.env` file parser interpolates those before the value ever reaches the
compose file - one run failed outright with "the variable `Ux` is not set"
because `$Ux` inside the hash looked like a reference. `.env.example` now says
to double every `$` to `$$` when pasting a hash in.

Both were caught by literally reading `docker compose config`'s output and, for
the key-interpolation question, standing up a disposable one-service compose
project and inspecting the container's actual applied labels - `config`'s
display escapes `$` for its own re-parseability either way, so the only way to
tell a resolved value from an unresolved one was to check what Docker actually
attached to the container.
