/**
 * UI layer: pairing, terminal, on-screen keys, and the handful of things a
 * terminal needs on a phone that it never needs on a desktop - a viewport that
 * accounts for the soft keyboard, a screen that does not sleep mid-run, and a
 * session that survives the app being killed in the background.
 */

import { TermlyClient } from './termly-client.js';
import { saveSession, loadSession, clearSession, createSeqPersister } from './termly-session.js';
import { planPaste } from './paste.js';

const $ = id => document.getElementById(id);
let term, fit, client, seqPersister;
let wakeLock = null;
let installPrompt = null;

/*
 * Preferences, read defensively.
 *
 * A browser told to block site data throws on `localStorage` itself, not just on
 * the write - and these run at import. An exception here is not a forgotten font
 * size, it is a page that never finishes loading and a terminal that never
 * appears. The session blob has always been careful about this (termly-session);
 * the two settings beside it were not.
 */
function readSetting(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSetting(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch { /* a preference is not worth failing a session over */ }
}

let fontSize = clampFont(Number(readSetting('termly.fontSize')) || 13);

/*
 * Whose terminal is it?
 *
 * Measuring the browser window and resizing the CLI to match is the obvious
 * thing, and it is wrong. The CLI ignores its own SIGWINCH while a phone is
 * attached, so a size sent from here sticks to the pty until the phone leaves -
 * reflowing the terminal the user is sitting in front of, and any full-screen
 * program running in it. A phone is a second window onto that session, not the
 * authority on how wide it is.
 *
 * So the CLI says what size it started in, and this draws that grid, shrinking
 * the text until it fits rather than changing the number of columns. `window`
 * is the old behaviour, kept for a phone used on its own; `fixed` is for a CLI
 * too old to say anything.
 */
const SIZE_MODES = ['cli', 'window', 'fixed'];
const storedMode = readSetting('termly.sizeMode');
let sizeMode = SIZE_MODES.includes(storedMode) ? storedMode : 'cli';
let cliSize = parseSize(readSetting('termly.cliSize'));
let fixedSize = parseSize(readSetting('termly.customSize'));

/** `140x50`, `140 × 50`, `140,50` - whatever a person is likely to type. */
function parseSize(text) {
  const m = /^\s*(\d{1,4})\s*[x×*,\s]\s*(\d{1,4})\s*$/i.exec(text || '');
  if (!m) return null;
  const cols = Number(m[1]), rows = Number(m[2]);
  if (cols < 1 || rows < 1 || cols > 1000 || rows > 1000) return null;
  return { cols, rows };
}

/** The grid to draw, or null to go on measuring the window as before. */
function lockedSize() {
  if (sizeMode === 'window') return null;
  return sizeMode === 'fixed' ? fixedSize : cliSize;
}
let wakeWanted = readSetting('termly.wakeLock') === '1';

// ---------------------------------------------------------------- viewport --

// The soft keyboard resizes the visual viewport only. Without this the terminal
// keeps its full height and the bottom rows - where the cursor is - sit behind
// the keyboard.
//
// visualViewport.height is also divided by the pinch-zoom scale, though, so read
// naively it says a zoomed-in page is a short one and the terminal reflows under
// the reader's fingers. Multiplying the scale back out leaves the keyboard case
// exactly as it was and makes zooming a no-op here, which is what lets the page
// allow zooming at all.
function viewportHeight() {
  const viewport = window.visualViewport;
  if (!viewport) return window.innerHeight;
  return viewport.height * (viewport.scale || 1);
}

let appHeight = null;

function syncViewportHeight() {
  const height = Math.round(viewportHeight());
  // Panning a zoomed page fires scroll continuously, and each of those would
  // otherwise refit the terminal and send a resize down the wire for a size that
  // has not changed.
  if (height === appHeight) return;
  appHeight = height;
  document.documentElement.style.setProperty('--app-height', `${height}px`);
  refit();
}
window.visualViewport?.addEventListener('resize', syncViewportHeight);
window.visualViewport?.addEventListener('scroll', syncViewportHeight);
addEventListener('resize', syncViewportHeight);
addEventListener('orientationchange', () => setTimeout(syncViewportHeight, 250));
syncViewportHeight();

function refit() {
  if (!term || !fit) return;

  const locked = lockedSize();
  if (locked) return applyGrid(locked);

  // Back to measuring the window: the text goes back to the size the user asked
  // for, which the grid may have been shrinking below.
  if (term.options.fontSize !== fontSize) term.options.fontSize = fontSize;
  try {
    fit.fit();
  } catch { /* zero-sized container while hidden */ }
  client?.sendResize(term.cols, term.rows);
}

/*
 * Cell size per pixel of font, which is a constant for a fixed font family and
 * the only thing needed to work out what font size makes a given grid fit. It is
 * remembered because the terminal cannot be measured while it is hidden, and a
 * stale ratio is a far better answer than none.
 */
let cellPerPx = null;
const MIN_GRID_FONT = 5;

function measureCell() {
  const screen = $('term').querySelector('.xterm-screen');
  const px = term?.options.fontSize;
  if (!screen || !term?.cols || !term?.rows || !px) return null;
  const w = screen.clientWidth / term.cols / px;
  const h = screen.clientHeight / term.rows / px;
  return w > 0 && h > 0 ? { w, h } : null;
}

/** Draw someone else's grid, and shrink the text until it fits ours. */
function applyGrid({ cols, rows }) {
  if (term.cols !== cols || term.rows !== rows) {
    try { term.resize(cols, rows); } catch { /* a grid xterm will not make */ }
  }

  cellPerPx = measureCell() || cellPerPx;
  const box = $('term');
  const availW = box.clientWidth - 8;   // the padding the terminal sits inside
  const availH = box.clientHeight - 8;
  if (!cellPerPx || availW <= 0 || availH <= 0) return;

  // Never larger than the size the user chose - fitting is allowed to shrink
  // the text, not to override a preference - and never so small it stops being
  // text, which is what panning is for.
  const wanted = Math.min(availW / (cols * cellPerPx.w), availH / (rows * cellPerPx.h));
  const size = Math.max(MIN_GRID_FONT, Math.min(fontSize, Math.floor(wanted)));
  if (term.options.fontSize !== size) term.options.fontSize = size;

  // Below the floor the grid is wider than the screen and has to be reachable
  // some other way.
  $('termWrap').classList.toggle('panned', cols * cellPerPx.w * size > availW + 1);
}

// ----------------------------------------------------------------- pairing --

const codeInput = $('code');
const connectBtn = $('connect');
const pairError = $('pairError');

// A QR link or a shared URL can carry the code, so paste-and-go works even
// where the camera is not an option.
const prefill = new URLSearchParams(location.search).get('code')
  || new URLSearchParams(location.hash.slice(1)).get('code');
if (prefill) codeInput.value = normalise(prefill);

function normalise(value) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}

/*
 * Without WebCrypto there is no session to be had.
 *
 * `crypto.subtle` exists only in a secure context - for a self-hosted relay that
 * means HTTPS, or localhost. Reach the same page at `http://192.168.1.10:3000`,
 * which is exactly how someone tries this on their own network first, and every
 * call in termly-crypto is a call on `undefined`. That used to surface as a
 * TypeError from inside the handshake, with the page still cheerfully offering a
 * Connect button. Say it once, up front, and stop offering what cannot work.
 */
const cryptoReady = Boolean(globalThis.crypto?.subtle);

if (!cryptoReady) {
  pairError.textContent = 'This page needs HTTPS. Browsers only provide the '
    + 'encryption Termly uses on a secure origin, so open the relay over '
    + 'https:// (or from localhost) and this will work.';
}

codeInput.addEventListener('input', () => {
  codeInput.value = normalise(codeInput.value);
  connectBtn.disabled = !cryptoReady || codeInput.value.length !== 6;
});
codeInput.dispatchEvent(new Event('input'));
codeInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !connectBtn.disabled) startPairing();
});
connectBtn.addEventListener('click', startPairing);

// A saved session outranks the code field: the code is single-use, so if one is
// still open, re-pairing is not even possible without restarting the CLI.
const saved = cryptoReady ? loadSession() : null;
if (saved) {
  $('resume').style.display = 'flex';
  $('prompt').textContent = 'Or pair a new session with a code.';
  $('resumeBtn').addEventListener('click', () => startSession(c => c.restore(saved), saved.lastSeq));
  $('forgetBtn').addEventListener('click', () => {
    clearSession();
    $('resume').style.display = 'none';
    $('prompt').textContent = 'Enter the pairing code shown by termly start.';
  });
}

// The live scan, if one is running. A scan that cannot be stopped is a camera
// that stays on until a code happens to appear in front of it.
let scanning = null;

if (cryptoReady && 'BarcodeDetector' in window && navigator.mediaDevices?.getUserMedia) {
  $('scan').hidden = false;
  $('scan').addEventListener('click', () => {
    if (scanning) {
      stopScanning();
      return;
    }
    scanQR().catch(err => {
      stopScanning();
      pairError.textContent = `Camera unavailable: ${err.message}`;
    });
  });
}

// Backgrounding the app mid-scan would otherwise leave the camera running, with
// the indicator light on and nothing watching the frames.
addEventListener('visibilitychange', () => { if (document.hidden) stopScanning(); });

function stopScanning() {
  if (!scanning) return;
  const { stream } = scanning;
  scanning = null;
  stream.getTracks().forEach(t => t.stop());
  $('scanner').style.display = 'none';
  $('scan').textContent = 'Scan QR code';
}

async function scanQR() {
  const scanner = $('scanner');
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });

  // Two taps used to open two cameras and two frame loops. The permission
  // prompt can take long enough for that to happen by accident.
  if (scanning) {
    stream.getTracks().forEach(t => t.stop());
    return;
  }
  const session = { stream };
  scanning = session;

  scanner.srcObject = stream;
  scanner.style.display = 'block';
  $('scan').textContent = 'Stop scanning';
  await scanner.play();

  const detector = new BarcodeDetector({ formats: ['qr_code'] });

  const tick = async () => {
    // A stop between frames ends the loop; so does the stream dying under us.
    if (scanning !== session || !stream.active) return;
    try {
      const [found] = await detector.detect(scanner);
      const code = found && codeFromQR(found.rawValue);
      if (code) {
        stopScanning();
        codeInput.value = code;
        codeInput.dispatchEvent(new Event('input'));
        startPairing();
        return;
      }
    } catch { /* a frame that failed to decode is normal */ }
    requestAnimationFrame(tick);
  };
  tick();
}

/**
 * A pairing code out of whatever the camera decoded, or null.
 *
 * Being strict here matters: the camera sees every QR in front of it, and
 * normalising an arbitrary string happily yields six characters from something
 * that is not a code at all - "https://example.com/x" becomes "HTTPSE". Pairing
 * against that burns the user's rate-limit budget and tells them nothing.
 */
function codeFromQR(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();

  // What the CLI encodes today: a JSON pairing payload.
  try {
    const parsed = JSON.parse(text);
    const code = normalise(String(parsed?.code ?? ''));
    return code.length === 6 ? code : null;
  } catch { /* not JSON */ }

  // A pairing URL, the same shape the web client accepts when it is opened.
  if (/^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      const carried = new URLSearchParams(url.search).get('code')
        || new URLSearchParams(url.hash.slice(1)).get('code');
      const code = normalise(carried || '');
      return code.length === 6 ? code : null;
    } catch {
      return null;
    }
  }

  // Older builds encode the bare code. Accept it only when the whole payload is
  // exactly a code: allowing separators or stray words means "call me back
  // tomorrow" normalises to CALLME and pairs against nothing.
  return /^[A-Za-z0-9]{6}$/.test(text) ? normalise(text) : null;
}

function startPairing() {
  const code = codeInput.value;
  startSession(c => c.connect(code), 0);
}

// ----------------------------------------------------------------- session --

function startSession(begin, restoredSeq) {
  // Resuming while the scanner is up leaves the camera running behind the
  // terminal, where nothing will ever turn it off.
  stopScanning();
  pairError.textContent = '';
  $('pairing').style.display = 'none';
  $('session').style.display = 'flex';

  buildTerminal();
  buildKeys();
  syncViewportHeight();

  client = new TermlyClient({
    status: setStatus,
    output: data => term.write(data),

    // Output the CLI could no longer replay. Dim, so it does not read as part
    // of the session's own output, and placed exactly where the hole is.
    gap: chunks => term.write(
      `\r\n\x1b[90m— ${chunks} chunk${chunks === 1 ? '' : 's'} of output missing here —\x1b[0m\r\n`),
    paired: ({ fingerprint, restored }) => {
      $('fp').textContent = fingerprint.slice(0, 17);
      if (restored) term.write(`\r\n\x1b[90m— resumed from seq ${restoredSeq} —\x1b[0m\r\n`);
      // The geometry can only go out once there is a session to attach it to.
      // Doing it here rather than on a timer alone means a slow handshake still
      // ends with the CLI knowing the real width.
      refit();
    },
    // The CLI's own geometry, sent on pairing and again on every reconnect.
    // Remembered so a cold start draws the right grid before the relay has had
    // a chance to say anything.
    cliSize: size => {
      cliSize = size;
      writeSetting('termly.cliSize', `${size.cols}x${size.rows}`);
      updateSizeLabel();
      refit();
    },
    persist: () => {
      const snapshot = client.snapshot();
      if (snapshot) saveSession(snapshot);
    },
    inputDropped: why => showBanner(`${why} — keystroke not sent`, true, 2000),
    cliOffline: () => {
      showBanner('The CLI disconnected — waiting for it to come back', true);
      term.write('\r\n\x1b[33m— CLI disconnected —\x1b[0m\r\n');
    },
    cliOnline: () => {
      hideBanner();
      term.write('\r\n\x1b[32m— CLI reconnected —\x1b[0m\r\n');
    },
    sessionLost: message => {
      // The session is gone server-side; the stored blob can only mislead now.
      clearSession();
      setStatus(message || 'Session ended', 'err');
      showBanner('Session ended — start a new one from the CLI', true);
      term.write(`\r\n\x1b[31m${message || 'Session ended.'}\x1b[0m\r\n`);
    },
    fatal: message => {
      setStatus(message, 'err');
      showBanner(message, true);
      term.write(`\r\n\x1b[31m${message}\x1b[0m\r\n`);
    },
    log: message => console.debug('[termly]', message)
  });

  // lastSeq moves with every chunk; coalesce the writes rather than hitting
  // localStorage on each one.
  seqPersister = createSeqPersister(() => client?.snapshot());

  begin(client);

  // And again once the web font has settled, which changes the cell size and so
  // the row and column count.
  setTimeout(refit, 600);
  applyWakeLock();
}

function buildTerminal() {
  term = new Terminal({
    cursorBlink: true,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize,
    scrollback: 5000,
    // The relay carries the raw PTY stream, so let the app own the alt screen.
    allowProposedApi: true,
    // Typing while scrolled up should snap back to the prompt, or the keystroke
    // appears to vanish.
    scrollOnUserInput: true,
    theme: {
      background: '#0d1117', foreground: '#e6edf3', cursor: '#2f81f7',
      selectionBackground: '#264f78'
    }
  });
  fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  // Turns http(s) URLs in the scrollback into clickable links. The addon's own
  // handler opens a blank tab, clears its opener and only then navigates, so the
  // new tab cannot reach back into this page.
  term.loadAddon(new WebLinksAddon.WebLinksAddon());
  term.open($('term'));
  fit.fit();

  term.onData(data => client.sendInput(data));
  term.onWriteParsed(() => {
    seqPersister?.schedule();
    updateScrollAffordance();
  });
  term.onScroll(updateScrollAffordance);

  // Tapping the terminal is how the keyboard comes up on a phone.
  $('term').addEventListener('click', () => term.focus());

  $('toBottom').addEventListener('click', () => {
    term.scrollToBottom();
    updateScrollAffordance();
    term.focus();
  });
}

// xterm holds output when the viewport is scrolled up, which is correct but
// silent: on a phone there is no scrollbar to show that more arrived below.
function updateScrollAffordance() {
  const buffer = term.buffer.active;
  const behind = buffer.baseY - buffer.viewportY;
  $('toBottom').hidden = behind < 2;
}

// -------------------------------------------------------------- clipboard --

// Reading the clipboard needs a user gesture and, on Safari, an explicit
// confirmation. Both are satisfied by a tap; browsers without the API (Firefox
// does not expose readText to pages) get no button rather than a broken one.
const canPaste = Boolean(navigator.clipboard?.readText);

async function pasteFromClipboard() {
  let text;
  try {
    text = await navigator.clipboard.readText();
  } catch {
    // Denied, or dismissed. Nothing useful to recover.
    showBanner('Clipboard not available', true, 2500);
    return;
  }
  const plan = planPaste(text, { bracketed: term.modes?.bracketedPasteMode });

  if (!plan.ok) {
    showBanner(`Paste is ${Math.round(plan.size / 1000)}k — too large`, true, 3000);
    return;
  }

  for (const [i, write] of plan.writes.entries()) {
    if (!await client.sendInput(write)) {
      showBanner('Paste interrupted — the line went down', true, 3000);
      return;
    }
    // Yield so the tty drains rather than being handed the lot at once.
    if (i < plan.writes.length - 1) await new Promise(r => setTimeout(r, 12));
  }

  term.focus();
}

async function copySelection() {
  const text = term.getSelection();
  if (!text) {
    showBanner('Select some text first — press and hold', true, 2500);
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    showBanner(`Copied ${text.length} characters`, false, 2000);
  } catch {
    showBanner('Could not write to the clipboard', true, 2500);
  }
}

// ------------------------------------------------------------ on-screen keys --

// Ctrl is a latch rather than a held key: there is nothing to hold on a phone.
let ctrlArmed = false;

function buildKeys() {
  // Third field is the accessible name: "^C" and "→" are glyphs a screen reader
  // either spells out or skips entirely.
  const keys = [
    ['Esc', '\x1b', 'Escape'], ['Tab', '\t', 'Tab'], ['Ctrl', 'CTRL', 'Control'],
    ['↑', '\x1b[A', 'Up arrow'], ['↓', '\x1b[B', 'Down arrow'],
    ['←', '\x1b[D', 'Left arrow'], ['→', '\x1b[C', 'Right arrow'],
    ['⏎', '\r', 'Enter'], ['^C', '\x03', 'Control C, interrupt'],
    ['^D', '\x04', 'Control D, end of input'], ['^Z', '\x1a', 'Control Z, suspend'],
    ['|', '|', 'Pipe'], ['~', '~', 'Tilde'], ['/', '/', 'Slash'], ['-', '-', 'Hyphen'],
    ['PgUp', '\x1b[5~', 'Page up'], ['PgDn', '\x1b[6~', 'Page down']
  ];

  if (canPaste) keys.push(['Paste', 'PASTE', 'Paste from clipboard']);

  const bar = $('keys');
  bar.innerHTML = '';

  for (const [label, seq, name] of keys) {
    const button = document.createElement('button');
    button.textContent = label;
    button.type = 'button';
    button.setAttribute('aria-label', name);
    if (seq === 'CTRL') button.setAttribute('aria-pressed', 'false');

    // pointerdown, not click: the default action of a press is to move focus,
    // and losing focus closes the soft keyboard. preventDefault keeps it up -
    // which also suppresses the synthetic click, so the click listener below is
    // reached only by a keyboard, where there is no soft keyboard to protect.
    button.addEventListener('pointerdown', e => {
      e.preventDefault();
      press(seq, button);
    });
    button.addEventListener('click', () => press(seq, button));
    bar.appendChild(button);
  }

  // With Ctrl latched, the next printable character becomes its control code.
  term.attachCustomKeyEventHandler(event => {
    if (!ctrlArmed || event.type !== 'keydown') return true;
    const char = event.key;
    if (char.length !== 1) return true;
    const upper = char.toUpperCase();
    if (upper < '@' || upper > '_') return true;
    event.preventDefault();
    unlatchCtrl();
    client.sendInput(String.fromCharCode(upper.charCodeAt(0) - 64));
    return false;
  });
}

function press(seq, button) {
  if (seq === 'PASTE') {
    pasteFromClipboard();
    return;
  }

  if (seq === 'CTRL') {
    ctrlArmed = !ctrlArmed;
    button.classList.toggle('latched', ctrlArmed);
    button.setAttribute('aria-pressed', String(ctrlArmed));
    term.focus();
    return;
  }

  // A latched Ctrl applies to the next on-screen key too. Anything that has no
  // control code still clears the latch: leaving it armed means the keystroke
  // after it silently becomes a control character the user never asked for.
  if (ctrlArmed) {
    unlatchCtrl();
    const upper = seq.length === 1 ? seq.toUpperCase() : '';
    if (upper >= '@' && upper <= '_') {
      client.sendInput(String.fromCharCode(upper.charCodeAt(0) - 64));
      term.focus();
      return;
    }
  }

  client.sendInput(seq);
  term.focus();
}

function unlatchCtrl() {
  ctrlArmed = false;
  const latched = $('keys').querySelector('button.latched');
  latched?.classList.remove('latched');
  latched?.setAttribute('aria-pressed', 'false');
}

// -------------------------------------------------------------------- menu --

const menu = $('menu');

const menuItems = () => [...menu.querySelectorAll('button')];

function setMenu(open, focusItem = 0) {
  menu.style.display = open ? 'block' : 'none';
  $('menuBtn').setAttribute('aria-expanded', String(open));
  // A menu that can only be dismissed by clicking elsewhere is a trap for
  // anyone driving this from a keyboard.
  if (!open) return;
  const items = menuItems();
  items.at(focusItem)?.focus();
}

const isOpen = () => menu.style.display === 'block';

function closeMenu() {
  setMenu(false);
  $('menuBtn').focus();
}

$('menuBtn').addEventListener('click', e => {
  e.stopPropagation();
  setMenu(!isOpen());
});

// Opening with the arrows lands on the end of the menu the key points at, which
// is what anyone who has used a menu button elsewhere will expect.
$('menuBtn').addEventListener('keydown', e => {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  setMenu(true, e.key === 'ArrowDown' ? 0 : -1);
});

document.addEventListener('click', () => setMenu(false));
menu.addEventListener('click', e => e.stopPropagation());

/*
 * Menu keys.
 *
 * The buttons are still buttons - Enter and Space activate them, and a screen
 * reader reads them as menu items because the markup says so. What was missing
 * was everything that makes a menu navigable without a pointer: the arrows, the
 * ends, and a way out that does not leave focus stranded.
 */
menu.addEventListener('keydown', e => {
  const items = menuItems();
  const at = items.indexOf(document.activeElement);

  if (e.key === 'Escape') closeMenu();
  else if (e.key === 'ArrowDown') items[(at + 1) % items.length]?.focus();
  else if (e.key === 'ArrowUp') items[(at - 1 + items.length) % items.length]?.focus();
  else if (e.key === 'Home') items[0]?.focus();
  else if (e.key === 'End') items.at(-1)?.focus();
  else return;

  e.preventDefault();
});

/*
 * Tabbing past the last item used to leave the menu hanging open over the
 * terminal with nothing inside it focused.
 *
 * Only a blur that goes somewhere counts. Escape moves focus to the button
 * itself on the way out, which is not a reason to close twice; and a blur with
 * nowhere to go is a tap on a browser that does not focus buttons, or the whole
 * window losing focus - neither of which should shut a menu the user opened.
 * Dismissing by pointer is the document click handler's job.
 */
menu.addEventListener('focusout', e => {
  const next = e.relatedTarget;
  if (!isOpen() || !next) return;
  if (next !== $('menuBtn') && !menu.contains(next)) setMenu(false);
});

function sizeLabel() {
  if (sizeMode === 'window') return 'browser window';
  const size = lockedSize();
  if (!size) return 'window — CLI has not said';
  return `${size.cols} × ${size.rows} · ${sizeMode === 'fixed' ? 'fixed' : 'from CLI'}`;
}

function updateSizeLabel() {
  const val = $('sizeVal');
  if (val) val.textContent = sizeLabel();
}

function setSizeMode(mode) {
  sizeMode = mode;
  writeSetting('termly.sizeMode', mode);
  updateSizeLabel();
  refit();
}

/*
 * A number typed by hand, for a CLI too old to send one. `prompt` is a poor
 * dialog, but it is the one that works from a menu without breaking the arrow
 * keys that move through it - and some browsers refuse it outright, which is
 * the same as declining to answer.
 */
function askForSize() {
  const now = lockedSize() || { cols: term?.cols || 80, rows: term?.rows || 24 };
  try {
    return parseSize(window.prompt('Terminal size, as columns x rows',
      `${now.cols} x ${now.rows}`));
  } catch {
    return null;
  }
}

$('sizeToggle').addEventListener('click', () => {
  const next = SIZE_MODES[(SIZE_MODES.indexOf(sizeMode) + 1) % SIZE_MODES.length];
  if (next !== 'fixed') return setSizeMode(next);

  const typed = askForSize();
  // Nothing usable typed: the CLI's own size is the better answer, and going
  // back to it is less surprising than sitting on a grid nobody asked for.
  if (!typed) return setSizeMode('cli');
  fixedSize = typed;
  writeSetting('termly.customSize', `${typed.cols}x${typed.rows}`);
  setSizeMode('fixed');
});
updateSizeLabel();

$('fontUp').addEventListener('click', () => setFont(fontSize + 1));
$('fontDown').addEventListener('click', () => setFont(fontSize - 1));
$('copyBtn').addEventListener('click', () => { copySelection(); setMenu(false); });
$('clearBtn').addEventListener('click', () => { term.clear(); setMenu(false); });
$('wakeToggle').addEventListener('click', () => {
  wakeWanted = !wakeWanted;
  writeSetting('termly.wakeLock', wakeWanted ? '1' : '0');
  applyWakeLock();
});
$('quit').addEventListener('click', () => {
  // Ending the session means the stored key material has no further purpose.
  clearSession();
  client.disconnect();
  location.href = location.pathname;
});

function clampFont(size) { return Math.min(22, Math.max(9, size)); }

function setFont(size) {
  fontSize = clampFont(size);
  writeSetting('termly.fontSize', String(fontSize));
  $('fontVal').textContent = `${fontSize}px`;
  if (term) {
    term.options.fontSize = fontSize;
    refit();
  }
}
setFont(fontSize);

// --------------------------------------------------------------- wake lock --

// A long AI run produces no touch input, so the screen sleeps and the socket
// dies exactly when the session is most worth keeping.
async function applyWakeLock() {
  $('wakeVal').textContent = wakeWanted ? 'on' : 'off';
  if (!('wakeLock' in navigator)) {
    $('wakeVal').textContent = 'unsupported';
    return;
  }
  try {
    if (wakeWanted && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!wakeWanted && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {
    $('wakeVal').textContent = 'denied';
  }
}

// The browser drops the lock whenever the page is hidden; take it back.
addEventListener('visibilitychange', () => {
  if (!document.hidden && wakeWanted) applyWakeLock();
});

// ------------------------------------------------------------------ status --

let bannerTimer = null;
// What the banner's button does right now, if it is showing one.
let bannerAction = null;

// Reconnecting is the one thing worth interrupting a backoff for: a user tapping
// the button is better evidence that the network is back than the timer is.
const RETRY_ACTION = {
  label: 'Retry now',
  run: () => {
    showBanner('retrying…', false);
    client?.retryNow();
  }
};

function setStatus(text, kind) {
  $('status').textContent = text;
  $('dot').className = kind === 'err' ? 'err' : text === 'connected' ? 'ok' : '';

  if (text === 'connected') {
    hideBanner();
    return;
  }

  // The cliOffline handler has already put a fuller message up; repeating the
  // status word here would only overwrite it with something terser.
  if (text === 'CLI offline') return;

  if (/reconnect|resuming|offline|disconnected/.test(text)) {
    showBanner(text, false, 0, /reconnect|offline/.test(text) ? RETRY_ACTION : null);
  }
}

function showBanner(text, isError, autoHideMs, action = null) {
  const banner = $('banner');
  // Only the text node is replaced: the button lives inside the banner so that
  // the whole pill is one announcement, and rewriting textContent would delete
  // it.
  $('bannerText').textContent = text;
  const button = $('bannerAction');
  button.hidden = !action;
  if (action) button.textContent = action.label;
  bannerAction = action;
  banner.className = isError ? 'err' : '';
  banner.hidden = false;
  if (bannerTimer) clearTimeout(bannerTimer);
  if (autoHideMs) bannerTimer = setTimeout(hideBanner, autoHideMs);
}

$('bannerAction').addEventListener('click', () => bannerAction?.run());

function hideBanner() {
  if (bannerTimer) clearTimeout(bannerTimer);
  bannerAction = null;
  $('banner').hidden = true;

  // An update notice is not transient the way a connection message is. It waits
  // behind whatever the line has to say and comes back once that clears, rather
  // than being lost to a reconnect that happened to land on top of it.
  if (updateReady) showUpdateBanner();
}

// ----------------------------------------------------------------- install --

addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  installPrompt = e;
  $('install').hidden = false;
});

$('install').addEventListener('click', async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  $('install').hidden = true;
});

// iOS has no install prompt; say how instead, but only where it applies.
if (/iPhone|iPad/.test(navigator.userAgent) && !navigator.standalone) {
  $('hint').textContent = 'Tip: Share → Add to Home Screen for a full-screen terminal.';
}

// ------------------------------------------------------------ new versions --

/*
 * How a fix reaches a phone.
 *
 * An installed PWA is opened, not navigated, and Chrome only looks for a new
 * worker on navigation - so the build it was installed with can outlive every
 * deploy. Worse, a worker that calls skipWaiting() on install replaces itself
 * under a page that is already running the old sources, mid-session.
 *
 * So: the worker waits, this asks the user, and the swap and the reload happen
 * together. `update()` on every return to the foreground is what makes a new
 * build visible at all to an app that is never navigated.
 */

let updateReady = false;
let waitingWorker = null;
let reloading = false;

function showUpdateBanner() {
  showBanner('A new version is ready', false, 0, { label: 'Reload', run: applyUpdate });
}

function applyUpdate() {
  // Without a waiting worker there is nothing to hand over to, so a plain reload
  // is both the fallback and the whole of the update.
  if (!waitingWorker) return location.reload();
  showBanner('updating…', false);
  waitingWorker.postMessage({ type: 'skip-waiting' });
}

function offerUpdate(registration, hadController) {
  const worker = registration.waiting;
  // No controller at startup means this is a first install: there is no older
  // build to replace, and nothing to tell the user about.
  if (!worker || !hadController || updateReady) return;
  updateReady = true;
  waitingWorker = worker;

  // Before pairing there is nothing to lose, so take the new build straight away
  // rather than making the user tap through a notice about it. A half-typed
  // pairing code counts as something to lose.
  if (!client && !$('code').value) return applyUpdate();
  showUpdateBanner();
}

// A module script normally runs before `load`, but not if it was imported late -
// and a listener added after the event has gone by never fires, which would
// leave the worker unregistered. `once` so a stray second `load` cannot register
// twice.
function whenLoaded(fn) {
  if (document.readyState === 'complete') fn();
  else addEventListener('load', fn, { once: true });
}

if ('serviceWorker' in navigator) {
  whenLoaded(async () => {
    const container = navigator.serviceWorker;
    const hadController = !!container.controller;
    let registration;

    try {
      // updateViaCache:'none' so the worker itself is always revalidated; a
      // service worker cached by HTTP can pin a broken build indefinitely.
      registration = await container.register('/sw.js', { scope: '/', updateViaCache: 'none' });
    } catch (err) {
      console.debug('[termly] service worker registration failed', err);
      return;
    }

    // Fires when the waiting worker has actually taken over. Reloading here and
    // nowhere else is what keeps the page and its worker on the same build.
    container.addEventListener('controllerchange', () => {
      if (reloading || !hadController) return;
      reloading = true;
      location.reload();
    });

    // A worker that finished installing while the page was closed is already
    // waiting by the time this runs.
    offerUpdate(registration, hadController);

    registration.addEventListener('updatefound', () => {
      const installing = registration.installing;
      installing?.addEventListener('statechange', () => {
        if (installing.state === 'installed') offerUpdate(registration, hadController);
      });
    });

    addEventListener('visibilitychange', () => {
      if (!document.hidden) registration.update?.().catch(() => {});
    });
  });
}
