/**
 * The shipped page in a real browser engine.
 *
 * Every other UI test runs the app in jsdom against a stand-in terminal. That
 * covers the logic and none of the engine: xterm never parses anything, CSS is
 * never applied, and a syntax or API error that only a real V8 raises would go
 * straight through. This suite loads the page Chrome would load, pairs through
 * the real form, types on a real keyboard, and reads what xterm actually put on
 * the screen.
 *
 * It needs a Chromium. Playwright's is used if it is installed; TERMLY_CHROME
 * overrides. Without one the suite says so and passes, rather than failing a run
 * on a machine that never had a browser.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';

const [, , code, hostArg] = process.argv;
const relayHost = hostArg || 'localhost:3000';
const secure = !/^(localhost|127\.)/.test(relayHost);
const pageUrl = `${secure ? 'https' : 'http'}://${relayHost}/`;

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Playwright's headless shell, whichever build happens to be installed. */
function findChrome() {
  if (process.env.TERMLY_CHROME) return process.env.TERMLY_CHROME;
  const root = path.join(os.homedir(), '.cache', 'ms-playwright');
  if (!fs.existsSync(root)) return null;
  const builds = fs.readdirSync(root)
    .filter(d => d.startsWith('chromium'))
    .sort()
    .reverse();
  for (const build of builds) {
    for (const rel of [
      ['chrome-headless-shell-linux64', 'chrome-headless-shell'],
      ['chrome-linux', 'chrome']
    ]) {
      const bin = path.join(root, build, ...rel);
      if (fs.existsSync(bin)) return bin;
    }
  }
  return null;
}

const chromePath = findChrome();
if (!chromePath) {
  console.log('SKIP  no Chromium found - set TERMLY_CHROME to run this suite');
  process.exit(0);
}

const port = 9200 + Math.floor(Math.random() * 300);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'termly-browser-'));
const chrome = spawn(chromePath, [
  '--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
  `--user-data-dir=${profile}`,
  `--remote-debugging-port=${port}`,
  'about:blank'
], { stdio: ['ignore', 'ignore', 'ignore'] });

const cleanup = () => {
  try { chrome.kill('SIGKILL'); } catch {}
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
};
process.on('exit', cleanup);

let version = null;
for (let i = 0; i < 50 && !version; i++) {
  await sleep(200);
  version = await fetch(`http://127.0.0.1:${port}/json/version`).then(r => r.json(), () => null);
}
if (!version) { console.error('the browser never opened a debugging port'); cleanup(); process.exit(2); }

// ---- the smallest CDP client that can drive a page -------------------------
const cdp = new WebSocket(version.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise((resolve, reject) => { cdp.once('open', resolve); cdp.once('error', reject); });

let nextId = 0;
const pending = new Map();
const pageErrors = [];

cdp.on('message', raw => {
  const msg = JSON.parse(raw);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    return msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  }
  // An exception the engine raised that jsdom would never have produced.
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    pageErrors.push(d.exception?.description || d.text);
  }
});

let session;
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId;
  pending.set(id, { resolve, reject });
  cdp.send(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }));
});

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
({ sessionId: session } = await send('Target.attachToTarget', { targetId, flatten: true }));
await send('Page.enable');
await send('Runtime.enable');

/** Evaluate in the page and hand back the value. */
async function evaluate(expression) {
  const { result, exceptionDetails } = await send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true
  });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
  return result.value;
}

/** Poll an expression until it is truthy, or give up. */
async function waitFor(expression, timeout = 15000) {
  const until = Date.now() + timeout;
  for (;;) {
    if (await evaluate(expression).catch(() => false)) return true;
    if (Date.now() > until) return false;
    await sleep(150);
  }
}

// ---- the page as Chrome loads it -------------------------------------------
await send('Page.navigate', { url: pageUrl });
check('the shipped page loads in a real engine',
  await waitFor('document.readyState === "complete" && !!document.getElementById("code")'),
  pageUrl);

check('xterm is on the page, not a stand-in',
  await evaluate('typeof window.Terminal === "function" && typeof window.FitAddon === "object"'));

/*
 * The web-links addon is vendored, so a missing copy step is a 404 the page
 * survives - right up to buildTerminal(), which then throws. Loading it onto a
 * throwaway terminal here is the engine confirming the file arrived and its
 * link provider registers.
 */
check('the web-links addon loads in the real engine', await evaluate(`(() => {
  if (typeof window.WebLinksAddon !== 'object') return false;
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-9999px;width:600px;height:300px';
  document.body.appendChild(host);
  const t = new window.Terminal({ cols: 40, rows: 6 });
  t.open(host);
  t.loadAddon(new window.WebLinksAddon.WebLinksAddon());
  t.dispose();
  host.remove();
  return true;
})()`));

// ---- pairing through the form Chrome renders --------------------------------
await evaluate(`(() => {
  const field = document.getElementById('code');
  field.value = ${JSON.stringify(code || '')};
  field.dispatchEvent(new Event('input'));
  document.getElementById('connect').click();
})()`);

const paired = await waitFor(
  'getComputedStyle(document.getElementById("session")).display === "flex"', 20000);
check('pairing through the real form reaches the session view', paired);

check('and the pairing view is gone',
  await evaluate('getComputedStyle(document.getElementById("pairing")).display === "none"'));

// ---- a real keystroke, through the pty, back onto a real screen -------------
const screen = () => evaluate('document.querySelector("#term").innerText');

check('the CLI\'s own output was rendered by xterm',
  await waitFor('document.querySelector("#term").innerText.trim().length > 0'),
  `${(await screen()).trim().length} chars on screen`);

await evaluate('document.getElementById("term").click()');
await send('Input.insertText', { text: 'echo BROWSER_OK' });
for (const type of ['keyDown', 'keyUp']) {
  await send('Input.dispatchKeyEvent', {
    type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r'
  });
}

check('a keystroke typed into the browser comes back through the pty',
  await waitFor('document.querySelector("#term").innerText.includes("BROWSER_OK")', 20000));

// ---- what jsdom could never answer: does the parser survive a split? --------
/*
 * Output arrives in whatever pieces the pty produced, so an escape sequence is
 * split across two writes routinely - and after a gap in the replay the client
 * now injects a marker of its own into that stream. Both are only safe if the
 * parser carries its state across a write and if an ESC resynchronises it.
 * Neither is knowable from the stand-in terminal the other suites use; this is
 * the vendored xterm answering for itself.
 */
const split = await evaluate(`(async () => {
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-9999px;width:600px;height:300px';
  document.body.appendChild(host);
  const t = new window.Terminal({ cols: 40, rows: 6 });
  t.open(host);

  // Writes are queued and parsed asynchronously; reading the buffer before the
  // parser has run is how this test would pass without proving anything.
  const write = data => new Promise(done => t.write(data, done));
  const line = n => t.buffer.active.getLine(n)?.translateToString(true) ?? '';
  const out = {};

  // An SGR cut in half by a chunk boundary.
  await write('\\x1b[3');
  await write('1mRED');
  out.resumed = line(0);
  const cell = t.buffer.active.getLine(0)?.getCell(0);
  out.colour = cell?.getFgColor();
  out.palette = cell?.isFgPalette();

  // A sequence the CLI never finished, then the client's own gap marker. The
  // ESC has to abort what was dangling, or the marker is eaten as parameters.
  t.reset();
  await write('\\x1b[3');
  await write('\\x1b[0m\\r\\n\\x1b[90m— 3 chunks of output missing here —\\x1b[0m\\r\\n');
  out.marker = line(0) + '|' + line(1);

  t.dispose();
  host.remove();
  return out;
})()`);

check('xterm resumes an escape sequence split across two writes',
  split.resumed === 'RED', `line reads ${JSON.stringify(split.resumed)}`);
check('and applies it, rather than printing it',
  split.palette === true && split.colour === 1, `fg colour ${split.colour}, palette ${split.palette}`);
check('a gap marker after an unfinished sequence is not swallowed by it',
  split.marker.includes('3 chunks of output missing here'),
  `line reads ${JSON.stringify(split.marker)}`);

// ---- a grid that is not the browser's own ----------------------------------
/*
 * The phone is a second window onto the CLI's terminal, not the authority on how
 * wide it is. jsdom can prove the resize is never sent; only a real engine can
 * prove the grid it is replaced with is actually drawable - that xterm makes 50
 * rows of it, and that the text shrinks to fit a window far too narrow for 140
 * columns at the size the user picked.
 */
await evaluate(`(() => {
  localStorage.setItem('termly.sizeMode', 'fixed');
  localStorage.setItem('termly.customSize', '140x50');
  localStorage.setItem('termly.fontSize', '13');
})()`);
await send('Page.reload', {});
const cameBack = await waitFor(
  'document.readyState === "complete" && !!document.getElementById("resumeBtn")', 20000);
check('the stored session is offered again after a reload', cameBack);

await evaluate('document.getElementById("resumeBtn").click()');
check('and resuming it reaches the session view',
  await waitFor('getComputedStyle(document.getElementById("session")).display === "flex"', 20000));

const grid = await waitFor('document.querySelectorAll(".xterm-rows > div").length === 50', 10000);
check('the terminal is drawn at the pinned 50 rows, not the window\'s own', grid,
  `${await evaluate('document.querySelectorAll(".xterm-rows > div").length')} rows rendered`);

/*
 * xterm does not put the size it renders at on any element worth reading, so the
 * comparison is against the same grid built at the size the user asked for. If
 * the drawn one is narrower, the fitting did something; if it also fits the box,
 * it did the right thing.
 */
/*
 * xterm does not put the size it renders at on any element worth reading, so the
 * measurement is the height of one cell - the grid's own height over the rows it
 * drew - against the same thing built at the size the user asked for. Comparing
 * whole grids would not do: a terminal that ignored the pin and fitted the
 * window is also smaller than a 140-column baseline, while proving nothing.
 */
const drawn = await evaluate(`(async () => {
  const screen = document.querySelector('.xterm-screen');
  const rows = document.querySelectorAll('.xterm-rows > div').length;

  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-9999px;width:2000px;height:900px';
  document.body.appendChild(host);
  const t = new window.Terminal({ cols: 140, rows: 50, fontSize: 13 });
  t.open(host);
  await new Promise(done => t.write(' ', done));
  const ref = host.querySelector('.xterm-screen');
  const baseline = ref.clientHeight / 50;
  t.dispose();
  host.remove();

  return {
    rows,
    cell: rows ? screen.clientHeight / rows : 0,
    baseline,
    width: screen.clientWidth,
    box: document.getElementById('term').clientWidth
  };
})()`);
check('and its text was shrunk rather than its columns dropped',
  drawn.cell > 0 && drawn.cell < drawn.baseline,
  `${drawn.cell.toFixed(1)}px cells against ${drawn.baseline.toFixed(1)}px at the chosen 13px`);
check('so the pinned grid fits on screen',
  drawn.rows === 50 && drawn.width <= drawn.box,
  `${drawn.rows} rows, ${Math.round(drawn.width)}px in a ${drawn.box}px box`);

// ---- anything the engine objected to along the way -------------------------
check('nothing threw in the page', pageErrors.length === 0, pageErrors.join(' | ') || 'clean');

const failed = checks.filter(ok => !ok).length;
console.log(`\n=== ${checks.length - failed}/${checks.length} checks passed ===`);
cleanup();
process.exit(failed ? 1 : 0);
