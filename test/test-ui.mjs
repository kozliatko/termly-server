/**
 * The UI layer, driven through a real DOM.
 *
 * `app.js` decides what every element does, and until now none of it was
 * reachable from a test: the file touches `document` at import. The harness puts
 * the shipped index.html in jsdom and stubs xterm, the socket and the clipboard,
 * so the wiring - which tap sends what, which state follows which message - can
 * be asserted without a browser.
 *
 * Deliberately not covered here: the crypto (test-interop), the relay protocol
 * (test-webclient, test-resume, test-restore) and the paste planner
 * (test-paste). This suite only asserts the layer above them.
 */
import crypto from 'node:crypto';
import { loadApp, FakeWebLinks } from './dom-harness.mjs';
import { generateKeyPair, exportPrivateKey, deriveAESKey, encrypt, decrypt } from '../public/termly-crypto.js';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  OK  ' : ' FAIL '} ${name}${detail ? ' - ' + detail : ''}`);
  ok ? pass++ : fail++;
};

// jsdom dispatches synchronously, but the app awaits crypto between a message
// arriving and the DOM changing - and frames are now handled one at a time, so
// that crypto starts a microtask after the frame is delivered rather than during
// the delivery. A modp14 derive is several milliseconds of it, so the wait has to
// be long enough to cover the work rather than just the dispatch.
const settle = (ms = 30) => new Promise(r => setTimeout(r, ms));

function cliKeys() {
  const dh = crypto.getDiffieHellman('modp14');
  dh.generateKeys();
  return { dh, publicKey: dh.getPublicKey().toString('base64') };
}

/** Drive the pairing form all the way to a live session. */
async function pairSession(h, { sessionId = 'sess-ui-1', cols, rows } = {}) {
  const cli = cliKeys();

  h.$('code').value = 'abc123';
  h.$('code').dispatchEvent(new h.window.Event('input'));
  h.$('connect').click();
  await settle();

  const ws = h.sockets.latest;
  const pairing = ws.sent.find(m => m.type === 'mobile_pairing');
  const secret = cli.dh.computeSecret(Buffer.from(pairing.publicKey, 'base64'));

  ws.deliver({ type: 'pairing_ack', sessionId, publicKey: cli.publicKey, cols, rows });
  await settle();

  return { ws, cli, pairing, aes: await deriveAESKey(new Uint8Array(secret)) };
}

const inputs = async (ws, aes) => {
  const out = [];
  for (const m of ws.sent.filter(m => m.type === 'input')) {
    out.push(await decrypt(m.data, m.iv, aes));
  }
  return out.join('');
};

// --- 1. The pairing form -----------------------------------------------------
{
  const h = await loadApp();
  check('pairing view is the landing view',
    h.$('pairing').style.display !== 'none' && h.$('session').style.display !== 'flex');
  check('Connect starts disabled', h.$('connect').disabled === true);
  check('the resume row is hidden with no stored session',
    h.$('resume').style.display !== 'flex');

  h.$('code').value = 'ab-c1';
  h.$('code').dispatchEvent(new h.window.Event('input'));
  check('the code field strips punctuation and upper-cases', h.$('code').value === 'ABC1');
  check('Connect stays disabled below six characters', h.$('connect').disabled === true);

  h.$('code').value = 'abc123xyz';
  h.$('code').dispatchEvent(new h.window.Event('input'));
  check('the code field caps at six characters', h.$('code').value === 'ABC123');
  check('Connect enables at six characters', h.$('connect').disabled === false);

  h.restoreGlobals();
}

// --- 2. A code carried in the URL --------------------------------------------
{
  const h = await loadApp({ url: 'https://termly.test/?code=ab-cd12' });
  check('?code= prefills the field, normalised', h.$('code').value === 'ABCD12');
  check('a prefilled code enables Connect', h.$('connect').disabled === false);
  h.restoreGlobals();

  const g = await loadApp({ url: 'https://termly.test/#code=zz9900' });
  check('#code= prefills too (QR links that avoid the query string)',
    g.$('code').value === 'ZZ9900');
  g.restoreGlobals();
}

// --- 3. A stored session offers a resume -------------------------------------
{
  const web = generateKeyPair();
  const blob = JSON.stringify({
    version: 1, host: 'termly.test', sessionId: 'stored-1',
    privateKey: exportPrivateKey(web.privateKey), cliPublicKey: cliKeys().publicKey,
    lastSeq: 42, savedAt: Date.now()
  });

  const h = await loadApp({ storage: { 'termly.session.v1': blob } });
  check('a stored session shows the resume row', h.$('resume').style.display === 'flex');
  check('the prompt says a code is the alternative, not the default',
    /Or pair a new session/.test(h.$('prompt').textContent));

  h.$('forgetBtn').click();
  check('Forget it drops the stored blob',
    h.window.localStorage.getItem('termly.session.v1') === null);
  check('Forget it hides the resume row', h.$('resume').style.display === 'none');
  h.restoreGlobals();

  // A blob written against another relay must not be offered here.
  const other = await loadApp({
    storage: { 'termly.session.v1': blob.replace('termly.test', 'someone.else') }
  });
  check('a blob from another host is not offered', other.$('resume').style.display !== 'flex');
  other.restoreGlobals();
}

// --- 4. Pairing end to end ---------------------------------------------------
{
  const h = await loadApp();
  const { ws, aes, cli } = await pairSession(h);

  check('the socket carries the code', /\/ws\/agent\?code=ABC123$/.test(ws.url));
  check('the session view replaces the pairing view',
    h.$('session').style.display === 'flex' && h.$('pairing').style.display === 'none');
  check('status reads connected', h.$('status').textContent === 'connected');
  check('the connection dot is green', h.$('dot').className === 'ok');
  check('a key fingerprint is shown', h.$('fp').textContent.length === 17);
  check('the session is persisted for a cold start',
    JSON.parse(h.window.localStorage.getItem('termly.session.v1')).sessionId === 'sess-ui-1');
  check('the on-screen key bar is built', h.$('keys').querySelectorAll('button').length >= 17);

  // URLs in the scrollback are only clickable if the addon was actually handed
  // to the terminal, not merely loaded by the page.
  check('the web-links addon is attached to the terminal',
    FakeWebLinks.last?.term === h.terminal());

  // Output arrives encrypted and must reach the terminal as plaintext.
  ws.deliver({ type: 'output', seq: 7, encrypted: true, ...await encrypt('hello world', aes) });
  await settle();
  check('encrypted output is decrypted into the terminal',
    h.terminal().written.join('').includes('hello world'));

  // Typing goes back out encrypted.
  h.terminal().type('ls\r');
  await settle();
  check('typing is encrypted and sent', (await inputs(ws, aes)) === 'ls\r');
  check('resize is sent in the clear', ws.sent.some(m => m.type === 'resize'));
  void cli;
  h.restoreGlobals();
}

// --- 5. The Ctrl latch -------------------------------------------------------
{
  const h = await loadApp();
  const { ws, aes } = await pairSession(h);
  const term = h.terminal();
  const ctrlBtn = [...h.$('keys').querySelectorAll('button')].find(b => b.textContent === 'Ctrl');

  check('a hardware keystroke passes through with Ctrl unlatched',
    term.keyHandler({ type: 'keydown', key: 'c', preventDefault() {} }) === true);

  ctrlBtn.dispatchEvent(new h.window.Event('pointerdown', { cancelable: true }));
  check('tapping Ctrl latches it', ctrlBtn.classList.contains('latched'));

  const swallowed = term.keyHandler({ type: 'keydown', key: 'c', preventDefault() {} });
  await settle();
  check('a latched Ctrl turns the next letter into a control code',
    swallowed === false && (await inputs(ws, aes)) === '\x03');
  check('the latch clears after firing', !ctrlBtn.classList.contains('latched'));

  // The bug this replaced: a key with no control code left Ctrl armed, so the
  // *following* keystroke silently became a control character.
  ctrlBtn.dispatchEvent(new h.window.Event('pointerdown', { cancelable: true }));
  const pipe = [...h.$('keys').querySelectorAll('button')].find(b => b.textContent === '|');
  pipe.dispatchEvent(new h.window.Event('pointerdown', { cancelable: true }));
  await settle();
  check('a key with no control code sends itself and clears the latch',
    (await inputs(ws, aes)) === '\x03|' && !ctrlBtn.classList.contains('latched'));

  h.restoreGlobals();
}

// --- 6. Clipboard ------------------------------------------------------------
{
  const h = await loadApp();
  const { ws, aes } = await pairSession(h);
  const labels = [...h.$('keys').querySelectorAll('button')].map(b => b.textContent);
  check('a clipboard-capable browser gets a Paste key', labels.includes('Paste'));

  const payload = 'x'.repeat(2500);
  h.clipboard.text = payload;
  h.terminal().modes.bracketedPasteMode = true;
  [...h.$('keys').querySelectorAll('button')].find(b => b.textContent === 'Paste')
    .dispatchEvent(new h.window.Event('pointerdown', { cancelable: true }));
  await settle(400);

  check('a paste arrives chunked but reassembles exactly',
    (await inputs(ws, aes)) === `\x1b[200~${payload}\x1b[201~`);
  check('the paste went out in chunks, not one write',
    ws.sent.filter(m => m.type === 'input').length === 5);

  h.terminal().selection = 'copy me';
  h.$('copyBtn').click();
  await settle();
  check('Copy selection writes the selection to the clipboard',
    h.clipboard.written.join('') === 'copy me');
  h.restoreGlobals();

  const none = await loadApp({ clipboard: 'none' });
  await pairSession(none);
  check('a browser without clipboard read gets no Paste key',
    ![...none.$('keys').querySelectorAll('button')].some(b => b.textContent === 'Paste'));
  none.restoreGlobals();
}

// --- 7. Scrollback affordance ------------------------------------------------
{
  const h = await loadApp();
  await pairSession(h);
  const term = h.terminal();

  check('Jump to latest is hidden at the bottom', h.$('toBottom').hidden === true);
  term.buffer.active.baseY = 40;
  term.scrollUpBy(12);
  check('scrolling up reveals Jump to latest', h.$('toBottom').hidden === false);

  h.$('toBottom').click();
  check('tapping it returns to the bottom and hides itself',
    h.$('toBottom').hidden === true && term.scrolledToBottom === 1);
  h.restoreGlobals();
}

// --- 8. Losing and regaining the line ----------------------------------------
{
  const h = await loadApp();
  const { ws } = await pairSession(h);

  ws.deliver({ type: 'cli_disconnected' });
  await settle();
  check('the CLI going away is announced', /CLI disconnected/.test(h.$('bannerText').textContent));
  check('the CLI banner is an error', h.$('banner').className.includes('err'));
  check('the terminal records the disconnect',
    h.terminal().written.join('').includes('— CLI disconnected —'));
  check('a CLI-offline banner offers no retry (there is nothing to retry)',
    h.$('bannerAction').hidden === true);

  ws.deliver({ type: 'cli_reconnected' });
  await settle();
  check('the CLI coming back clears the banner', h.$('banner').hidden === true);
  check('the terminal records the reconnect',
    h.terminal().written.join('').includes('— CLI reconnected —'));

  // Now the relay itself: a dropped socket schedules a backoff the user can skip.
  const before = h.sockets.instances.length;
  ws.close(1006);
  await settle();
  check('a dropped socket offers a retry', h.$('bannerAction').hidden === false);
  check('the banner names the countdown', /reconnecting in/.test(h.$('bannerText').textContent));
  check('the retry is a real button, not a tap target in a status message',
    h.$('bannerAction').tagName === 'BUTTON');

  h.$('bannerAction').click();
  await settle();
  check('the retry button reconnects immediately',
    h.sockets.instances.length === before + 1);
  check('the retry resumes by session id rather than re-pairing',
    /\?sessionId=sess-ui-1$/.test(h.sockets.latest.url));
  h.restoreGlobals();
}

// --- 9. A session the relay no longer has ------------------------------------
{
  const h = await loadApp();
  const { ws } = await pairSession(h);
  check('the session blob exists before the loss',
    h.window.localStorage.getItem('termly.session.v1') !== null);

  ws.reject('session_not_found', 'Session not found or expired');
  await settle();
  check('a lost session wipes the stored key material',
    h.window.localStorage.getItem('termly.session.v1') === null);
  check('the loss is shown, not swallowed', /Session ended/.test(h.$('bannerText').textContent));
  h.restoreGlobals();
}

// --- 10. Settings ------------------------------------------------------------
{
  const h = await loadApp({ storage: { 'termly.fontSize': '13' } });
  await pairSession(h);

  h.$('menuBtn').click();
  check('the menu opens', h.$('menu').style.display === 'block');
  check('the trigger reports the menu is open',
    h.$('menuBtn').getAttribute('aria-expanded') === 'true');
  check('opening the menu moves focus into it',
    h.document.activeElement === h.$('menu').querySelector('button'));

  h.$('menu').dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  check('Escape closes the menu and returns focus',
    h.$('menu').style.display === 'none'
    && h.$('menuBtn').getAttribute('aria-expanded') === 'false'
    && h.document.activeElement === h.$('menuBtn'));
  h.$('menuBtn').click();

  h.$('fontUp').click();
  check('text size steps up', h.$('fontVal').textContent === '14px');
  check('text size is remembered', h.window.localStorage.getItem('termly.fontSize') === '14');
  check('the terminal follows the setting', h.terminal().options.fontSize === 14);

  for (let i = 0; i < 20; i++) h.$('fontUp').click();
  check('text size is clamped', h.$('fontVal').textContent === '22px');

  h.$('wakeToggle').click();
  await settle();
  check('the wake lock can be turned on', h.$('wakeVal').textContent === 'on' && h.wakeLocks.length === 1);
  h.$('wakeToggle').click();
  await settle();
  check('the wake lock can be turned off',
    h.$('wakeVal').textContent === 'off' && h.wakeLocks[0].released === true);

  h.$('clearBtn').click();
  check('Clear screen clears the terminal and closes the menu',
    h.terminal().cleared === 1 && h.$('menu').style.display === 'none');

  h.$('quit').click();
  await settle();
  check('End session wipes the stored session',
    h.window.localStorage.getItem('termly.session.v1') === null);
  h.restoreGlobals();
}

// --- 11. Install affordances -------------------------------------------------
{
  const h = await loadApp();
  check('the install button starts hidden', h.$('install').hidden === true);

  let prompted = 0;
  const event = new h.window.Event('beforeinstallprompt', { cancelable: true });
  event.prompt = () => { prompted++; };
  event.userChoice = Promise.resolve({ outcome: 'accepted' });
  h.window.dispatchEvent(event);
  check('a captured install prompt reveals the button', h.$('install').hidden === false);
  check('the browser prompt is suppressed until asked for', event.defaultPrevented === true);

  h.$('install').click();
  await settle();
  check('tapping it prompts once and then goes away',
    prompted === 1 && h.$('install').hidden === true);
  h.restoreGlobals();
}

// --- 12. Scanning a QR code --------------------------------------------------
{
  const plain = await loadApp();
  check('no BarcodeDetector means no Scan button', plain.$('scan').hidden === true);
  plain.restoreGlobals();

  // The CLI encodes a JSON payload; the code has to be dug out of it.
  const h = await loadApp({ barcode: JSON.stringify({ code: 'QR1234', serverUrl: 'wss://x' }) });
  check('a camera and a decoder reveal the Scan button', h.$('scan').hidden === false);

  h.$('scan').click();
  await settle(30);
  check('scanning opens the camera', h.camera.opened === 1);
  check('a decoded code fills the field', h.$('code').value === 'QR1234');
  check('a decoded code starts pairing without another tap',
    h.$('session').style.display === 'flex');
  check('the camera is released once a code is found', h.camera.stopped === 1);
  check('the preview is put away', h.$('scanner').style.display === 'none');
  h.restoreGlobals();

  // Older CLI builds put the bare code in the QR.
  const bare = await loadApp({ barcode: '  zz9900 ' });
  bare.$('scan').click();
  await settle(30);
  check('a bare code in the QR works too', bare.$('code').value === 'ZZ9900');
  bare.restoreGlobals();

  // Denying the camera is the common case and must say so, not fail silently.
  const denied = await loadApp({ barcode: 'QR1234', cameraError: 'Permission denied' });
  denied.$('scan').click();
  await settle(30);
  check('a denied camera is reported in the page',
    /Camera unavailable: Permission denied/.test(denied.$('pairError').textContent));
  denied.restoreGlobals();

  // A pairing link is a QR the CLI could reasonably print, and the same shape
  // the page already accepts in its own address bar.
  const link = await loadApp({ barcode: 'https://termly.test/?code=lnk777' });
  link.$('scan').click();
  await settle(30);
  check('a pairing URL in the QR is understood', link.$('code').value === 'LNK777');
  link.restoreGlobals();

  // The camera sees every QR in front of it. Anything that is not a code must
  // not be normalised into one - "https://example.com/x" becomes "HTTPSE".
  for (const [name, payload] of [
    ['a URL with no code', 'https://example.com/not-a-code'],
    ['a wifi QR', 'WIFI:S:HomeNet;T:WPA;P:hunter2;;'],
    ['plain prose', 'call me back tomorrow'],
    ['JSON without a code', '{"serverUrl":"wss://x"}']
  ]) {
    const junk = await loadApp({ barcode: payload });
    junk.$('scan').click();
    await settle(30);
    check(`${name} keeps scanning rather than pairing`,
      junk.$('session').style.display !== 'flex'
      && junk.$('code').value === ''
      && junk.camera.stopped === 0);
    junk.restoreGlobals();
  }
}

// --- 13. Accessibility -------------------------------------------------------
{
  const h = await loadApp();
  await pairSession(h);

  const keys = [...h.$('keys').querySelectorAll('button')];
  check('every on-screen key has a spoken name',
    keys.every(b => (b.getAttribute('aria-label') || '').length > 2));
  check('the arrow keys are named, not left as glyphs',
    keys.find(b => b.textContent === '→').getAttribute('aria-label') === 'Right arrow');

  const ctrlBtn = keys.find(b => b.textContent === 'Ctrl');
  check('the Ctrl latch exposes its state', ctrlBtn.getAttribute('aria-pressed') === 'false');
  ctrlBtn.dispatchEvent(new h.window.Event('pointerdown', { cancelable: true }));
  check('the latched state is announced', ctrlBtn.getAttribute('aria-pressed') === 'true');
  ctrlBtn.dispatchEvent(new h.window.Event('pointerdown', { cancelable: true }));
  check('and cleared again', ctrlBtn.getAttribute('aria-pressed') === 'false');

  // pointerdown alone leaves a keyboard user with a key bar that does nothing.
  const { ws, aes } = await pairSession(h);
  void ws; void aes;
  h.restoreGlobals();
}

{
  const h = await loadApp();
  const { ws, aes } = await pairSession(h);
  const esc = [...h.$('keys').querySelectorAll('button')].find(b => b.textContent === 'Esc');
  esc.click();
  await settle();
  check('a key bar button works from the keyboard, not only from a finger',
    (await inputs(ws, aes)) === '\x1b');

  // A finger produces pointerdown *and* a synthetic click; preventDefault on the
  // first suppresses the second, and this must stay true or every tap doubles.
  esc.dispatchEvent(new h.window.Event('pointerdown', { cancelable: true }));
  await settle();
  check('a touch that is not defaultPrevented does not double-send',
    (await inputs(ws, aes)) === '\x1b\x1b');

  check('the status line is a live region', h.$('status').getAttribute('role') === 'status');
  check('the decorative connection dot is hidden from assistive tech',
    h.$('dot').getAttribute('aria-hidden') === 'true');
  check('the key fingerprint is labelled rather than read as hex',
    h.$('fp').getAttribute('aria-label') !== null);
  h.restoreGlobals();
}

// --- 14. Stopping a scan -----------------------------------------------------
{
  // A QR the scanner will never accept, so the loop keeps running and the scan
  // has to be ended some other way.
  const h = await loadApp({ barcode: 'https://example.com/not-a-code' });
  h.$('scan').click();
  await settle(30);
  check('a running scan shows the preview', h.$('scanner').style.display === 'block');
  check('the button becomes the way out', h.$('scan').textContent === 'Stop scanning');

  h.$('scan').click();
  await settle(30);
  check('tapping it again releases the camera', h.camera.stopped === 1);
  check('and puts the preview away', h.$('scanner').style.display === 'none');
  check('and offers to scan again', h.$('scan').textContent === 'Scan QR code');

  // Two taps in a row - the permission prompt is slow enough for this to happen
  // by accident - used to leave two cameras and two frame loops running.
  h.$('scan').click();
  h.$('scan').click();
  await settle(30);
  check('a double tap does not leave a second camera running',
    h.camera.opened - h.camera.stopped <= 1);
  h.restoreGlobals();
}

{
  const h = await loadApp({ barcode: 'https://example.com/not-a-code' });
  h.$('scan').click();
  await settle(30);
  Object.defineProperty(h.document, 'hidden', { configurable: true, value: true });
  h.window.dispatchEvent(new h.window.Event('visibilitychange'));
  await settle();
  check('backgrounding the app releases the camera', h.camera.stopped === 1);
  h.restoreGlobals();
}

{
  const web = generateKeyPair();
  const h = await loadApp({
    barcode: 'https://example.com/not-a-code',
    storage: {
      'termly.session.v1': JSON.stringify({
        version: 1, host: 'termly.test', sessionId: 'stored-2',
        privateKey: exportPrivateKey(web.privateKey), cliPublicKey: cliKeys().publicKey,
        lastSeq: 0, savedAt: Date.now()
      })
    }
  });
  h.$('scan').click();
  await settle(30);
  h.$('resumeBtn').click();
  await settle(30);
  check('resuming while scanning does not leave the camera on behind the terminal',
    h.camera.stopped === 1 && h.$('scanner').style.display === 'none');
  h.restoreGlobals();
}

// --- 15. The soft keyboard ---------------------------------------------------
{
  const h = await loadApp();
  const height = () => h.document.documentElement.style.getPropertyValue('--app-height');
  check('the layout height is measured from the visual viewport', height() === '800px');

  const { ws, aes } = await pairSession(h);
  void aes;
  const fitsBefore = h.fit().fits;

  // What a soft keyboard actually does: it shrinks the visual viewport only.
  h.viewport.resizeTo(430);
  await settle();
  check('the soft keyboard shrinks the terminal rather than covering it',
    height() === '430px');
  check('the terminal is re-measured', h.fit().fits > fitsBefore);

  const resizes = ws.sent.filter(m => m.type === 'resize').length;
  h.viewport.resizeTo(800);
  await settle();
  check('putting the keyboard away restores the height', height() === '800px');
  check('the CLI is told the new geometry',
    ws.sent.filter(m => m.type === 'resize').length > resizes);
  h.restoreGlobals();
}

// --- 16. Getting a new build onto the phone ----------------------------------
{
  const h = await loadApp();
  check('the worker is registered at the root', h.sw.registrations === 1
    && h.sw.registerUrl === '/sw.js' && h.sw.registerOptions.scope === '/');
  check('and never served from the HTTP cache, which could pin a broken build',
    h.sw.registerOptions.updateViaCache === 'none');

  // First install: nothing is being replaced, so there is nothing to announce.
  h.sw.installUpdate();
  await settle();
  check('a first install does not announce itself', h.$('banner').hidden === true);
  check('and asks for no swap', h.sw.messages.length === 0);

  // A claim on a page that was never controlled must not bounce it.
  h.sw.takeOver();
  await settle();
  check('taking over an uncontrolled page does not reload it', h.sw.reloads === 0);
  h.restoreGlobals();
}

{
  // An older build is in charge and the user has not started anything yet.
  const h = await loadApp({ swController: true });
  h.sw.installUpdate();
  await settle();
  check('with nothing at stake the new build is taken straight away',
    h.sw.messages.length === 1 && h.sw.messages[0].type === 'skip-waiting');
  check('and the page says so rather than going silent',
    h.$('bannerText').textContent === 'updating…');

  h.sw.takeOver();
  h.sw.takeOver();
  await settle();
  check('the swap reloads the page exactly once', h.sw.reloads === 1);
  h.restoreGlobals();
}

{
  // A half-typed pairing code is something to lose.
  const h = await loadApp({ swController: true });
  h.$('code').value = 'ab';
  h.sw.installUpdate();
  await settle();
  check('a half-typed code is not thrown away for an update',
    h.sw.messages.length === 0);
  check('the update is offered instead',
    h.$('banner').hidden === false && h.$('bannerText').textContent === 'A new version is ready');
  check('with a button that says what it does',
    h.$('bannerAction').hidden === false && h.$('bannerAction').textContent === 'Reload');

  h.$('bannerAction').click();
  await settle();
  check('taking it asks the waiting worker to step in',
    h.sw.messages.length === 1 && h.sw.messages[0].type === 'skip-waiting');
  h.restoreGlobals();
}

{
  const h = await loadApp({ swController: true });
  const { ws, aes } = await pairSession(h);
  void aes;
  h.sw.installUpdate();
  await settle();
  check('a live session is never swapped out from under the user',
    h.sw.messages.length === 0);
  check('the update waits in the banner instead',
    h.$('bannerText').textContent === 'A new version is ready');

  // The line going down puts a more urgent message up. The update must not be
  // the casualty of that.
  ws.close(1006);
  await settle();
  check('a connection problem takes the banner over',
    h.$('bannerText').textContent !== 'A new version is ready');

  h.$('bannerAction').click();
  await settle();
  h.sockets.latest.deliver({ type: 'sync_complete', currentSeq: 0 });
  await settle();
  check('and the update comes back once the line is quiet again',
    h.$('banner').hidden === false && h.$('bannerText').textContent === 'A new version is ready');
  h.restoreGlobals();
}

{
  // A build that finished installing while the app was closed is already waiting
  // by the time the page runs.
  const h = await loadApp({ swController: true, swWaiting: true });
  await settle();
  check('a build installed while the app was closed is picked up at startup',
    h.sw.messages.length === 1 && h.sw.messages[0].type === 'skip-waiting');
  h.restoreGlobals();
}

{
  const h = await loadApp({ swController: true });
  const before = h.sw.updates;
  Object.defineProperty(h.document, 'hidden', { configurable: true, value: false });
  h.window.dispatchEvent(new h.window.Event('visibilitychange'));
  await settle();
  // An installed PWA is opened, not navigated, so nothing else would ever look.
  check('coming back to the app checks for a new build', h.sw.updates > before);
  h.restoreGlobals();
}

{
  // A worker is a nicety; the terminal is the product.
  const h = await loadApp({ swController: true, swRegisterError: 'storage is full' });
  h.$('code').value = 'abc123';
  h.$('code').dispatchEvent(new h.window.Event('input'));
  check('a browser that refuses the worker can still pair',
    h.$('connect').disabled === false && h.$('pairing').hidden === false);
  h.restoreGlobals();
}

// --- 17. Reaching all of it without a pointer --------------------------------
{
  const h = await loadApp();
  const { ws, aes } = await pairSession(h);
  void ws; void aes;

  const menu = h.$('menu');
  const menuBtn = h.$('menuBtn');
  const key = name => new h.window.KeyboardEvent('keydown', { key: name, bubbles: true });
  const open = () => menu.style.display === 'block';

  check('the popup says what it is', menu.getAttribute('role') === 'menu' &&
    menuBtn.getAttribute('aria-haspopup') === 'menu');
  check('and so does everything in it',
    [...menu.querySelectorAll('button')].every(b => b.getAttribute('role') === 'menuitem'));
  check('the dividers are not read as items',
    [...menu.querySelectorAll('.sep')].every(d => d.getAttribute('role') === 'separator'));

  // Down on the button is how a menu button is opened everywhere else.
  menuBtn.dispatchEvent(key('ArrowDown'));
  check('arrow-down opens the menu on its first item',
    open() && h.document.activeElement === h.$('fontDown'));
  check('and the button says it is open', menuBtn.getAttribute('aria-expanded') === 'true');

  menu.dispatchEvent(key('ArrowDown'));
  check('the arrows walk it', h.document.activeElement === h.$('fontUp'));
  menu.dispatchEvent(key('End'));
  check('End jumps to the last item', h.document.activeElement === h.$('quit'));
  menu.dispatchEvent(key('ArrowDown'));
  check('and it wraps rather than dead-ending', h.document.activeElement === h.$('fontDown'));
  menu.dispatchEvent(key('ArrowUp'));
  check('upwards too', h.document.activeElement === h.$('quit'));
  menu.dispatchEvent(key('Home'));
  check('Home comes back to the top', h.document.activeElement === h.$('fontDown'));

  menu.dispatchEvent(key('Escape'));
  check('Escape closes it and gives the button its focus back',
    !open() && h.document.activeElement === menuBtn);

  menuBtn.dispatchEvent(key('ArrowUp'));
  check('arrow-up opens it on the last item',
    open() && h.document.activeElement === h.$('quit'));

  // Tabbing past the last item: focus leaves the menu for something outside it.
  menu.dispatchEvent(new h.window.FocusEvent('focusout',
    { bubbles: true, relatedTarget: h.$('term') }));
  check('and tabbing out of it closes it rather than leaving it hanging', !open());

  // A blur with nowhere to go is the window losing focus, or a browser that does
  // not focus a button when it is tapped. Neither means the user is done.
  menuBtn.dispatchEvent(key('ArrowDown'));
  menu.dispatchEvent(new h.window.FocusEvent('focusout',
    { bubbles: true, relatedTarget: null }));
  check('but a blur that goes nowhere leaves it alone', open());

  h.restoreGlobals();
}

{
  // WCAG asks that a page not forbid zooming, and 13px of terminal output is
  // exactly the sort of thing someone needs to pinch.
  const h = await loadApp();
  const viewport = h.document.querySelector('meta[name="viewport"]').content;
  check('the page does not block zooming',
    !/user-scalable\s*=\s*no/.test(viewport) && !/maximum-scale/.test(viewport));

  const height = () => h.document.documentElement.style.getPropertyValue('--app-height');
  const { ws, aes } = await pairSession(h);
  void ws; void aes;
  check('the layout starts at the full height', height() === '800px');

  const fitsBefore = h.fit().fits;
  // A zoomed-in visual viewport reports a fraction of the layout height. Read
  // naively that is a soft keyboard, and the terminal reflows mid-pinch.
  h.viewport.zoomTo(2);
  await settle();
  check('pinching does not shrink the layout', height() === '800px');
  check('and does not reflow the terminal', h.fit().fits === fitsBefore);

  // The keyboard, which is the case this measurement exists for, still works.
  h.viewport.scale = 1;
  h.viewport.resizeTo(430);
  await settle();
  check('a soft keyboard still shortens it', height() === '430px');
  h.restoreGlobals();
}

{
  // Every on-screen key is a glyph. Without a name they are read out as their
  // symbol, or as nothing at all.
  const h = await loadApp();
  const { ws, aes } = await pairSession(h);
  void ws; void aes;
  const keys = [...h.$('keys').querySelectorAll('button')];
  check('every on-screen key has a name', keys.length > 0 &&
    keys.every(b => (b.getAttribute('aria-label') || '').length > 1));
  check('and the latching one reports its state',
    keys.some(b => b.getAttribute('aria-pressed') === 'false'));
  h.restoreGlobals();
}

{
  // display:none, not a class that merely hides it - an off-screen form still
  // in the tab order is a keyboard user typing into nothing.
  const h = await loadApp();
  const { ws, aes } = await pairSession(h);
  void ws; void aes;
  check('the pairing form leaves the tab order once it is done',
    h.$('pairing').style.display === 'none');
  h.restoreGlobals();
}

// --- 18. Browsers that take something away ----------------------------------
{
  // "Block site data" makes the property itself throw. These reads run at
  // import, so getting this wrong is not a lost preference - it is a blank page.
  const h = await loadApp({ storageBlocked: true });
  check('a browser blocking site data still boots the app',
    h.$('connect') !== null && h.$('pairing').style.display !== 'none');

  const { ws, aes } = await pairSession(h);
  void aes;
  check('and can still pair and run a session', h.$('session').style.display === 'flex');

  // Both settings write on change; neither may take the session down with it.
  const before = h.$('fontVal').textContent;
  h.$('menuBtn').click();
  h.$('fontUp').click();
  h.$('wakeToggle').click();
  await settle();
  check('changing settings does not throw where they cannot be stored',
    h.$('fontVal').textContent !== before && ws.readyState === 1);
  h.restoreGlobals();
}

{
  // The self-hosting first attempt: the relay reached at http://<lan-ip>:3000.
  // Every primitive in termly-crypto is a call on undefined there.
  const h = await loadApp({ secureContext: false });
  check('an insecure origin says so, in the place errors are announced',
    /HTTPS/.test(h.$('pairError').textContent) &&
    h.$('pairError').getAttribute('role') === 'alert');

  h.$('code').value = 'abc123';
  h.$('code').dispatchEvent(new h.window.Event('input'));
  check('and stops offering a Connect that could only fail',
    h.$('connect').disabled === true);
  check('the scanner is not offered either', h.$('scan').hidden === true);
  h.restoreGlobals();
}

{
  // A stored session must not resurface on an origin that cannot decrypt it.
  const h = await loadApp({
    secureContext: false,
    storage: { 'termly.session.v1': JSON.stringify({
      version: 1, host: 'termly.test', sessionId: 'sess-old',
      privateKey: 'x', cliPublicKey: 'y', lastSeq: 3, savedAt: Date.now()
    }) }
  });
  check('a saved session is not offered where it could not be resumed',
    h.$('resume').style.display !== 'flex');
  h.restoreGlobals();
}

// --- 19. Output arriving faster than it can be decrypted ---------------------
{
  /*
   * Every frame off the socket starts an independent async handler, and the
   * output path awaits an AES-GCM decrypt before it writes anything. Two frames
   * that arrive together are therefore two decrypts racing, and the shorter one
   * wins: `cat` a large file and the shell prompt that follows it lands in the
   * terminal first, in the middle of the file.
   *
   * The frames below are built up front so that delivering them is one
   * uninterrupted run of onmessage calls, which is what a real socket does with
   * a burst - an await between the delivers would hide the whole defect.
   */
  const h = await loadApp();
  const cli = cliKeys();

  h.$('code').value = 'abc123';
  h.$('code').dispatchEvent(new h.window.Event('input'));
  h.$('connect').click();
  await settle();

  const ws = h.sockets.latest;
  const pairing = ws.sent.find(m => m.type === 'mobile_pairing');
  const aes = await deriveAESKey(
    new Uint8Array(cli.dh.computeSecret(Buffer.from(pairing.publicKey, 'base64'))));

  const ack = { type: 'pairing_ack', sessionId: 'sess-order', publicKey: cli.publicKey };
  // A screenful of a big file, then the one short line that follows it.
  const bulk = { type: 'output', seq: 1, encrypted: true, ...await encrypt('A'.repeat(400000), aes) };
  const prompt = { type: 'output', seq: 2, encrypted: true, ...await encrypt('$ ', aes) };

  ws.deliver(ack);
  ws.deliver(bulk);
  ws.deliver(prompt);
  await settle(60);

  const screen = h.terminal().written.join('');
  check('output that arrives on the heels of pairing is not dropped',
    screen.includes('AAAA'),
    screen.includes('AAAA') ? '' : 'the key was still being derived when it arrived');
  check('a short line behind a long one lands behind it',
    screen.indexOf('$ ') > screen.indexOf('AAAA'));

  /*
   * Same race across message types. A catchup batch decrypts every entry in it,
   * so live output arriving while that is still running used to overtake the
   * replay it belongs after.
   */
  const batch = {
    type: 'catchup_batch',
    batch: [
      { seq: 3, encrypted: true, ...await encrypt('B'.repeat(200000), aes) },
      { seq: 4, encrypted: true, ...await encrypt('C'.repeat(200000), aes) }
    ]
  };
  const live = { type: 'output', seq: 5, encrypted: true, ...await encrypt('live\r\n', aes) };

  const before = h.terminal().written.length;
  ws.deliver(batch);
  ws.deliver(live);
  await settle(60);

  const after = h.terminal().written.slice(before).join('');
  check('a replayed batch is written before the live output that follows it',
    after.indexOf('live') > after.indexOf('CCCC') && after.indexOf('CCCC') > after.indexOf('BBBB'));

  // The relay hands the CLI a resume point; a reordered stream would also have
  // walked lastSeq backwards past frames the phone has not actually drawn.
  ws.deliver({ type: 'sync_complete', currentSeq: 5 });
  await settle();
  check('and the session it persists agrees with what was drawn',
    JSON.parse(h.window.localStorage.getItem('termly.session.v1')).lastSeq === 5);

  h.restoreGlobals();
}

// --- 20. Output that never arrives ------------------------------------------
{
  /*
   * The CLI replays from a 100 KB circular buffer, and its `getAfter` returns
   * whatever survived eviction without saying that anything was evicted. The
   * relay now also drops a phone that has stopped draining its socket, so a
   * reconnect after a heavy burst is the ordinary case, not the rare one. Both
   * arrive at the phone the same way: a sequence number further along than the
   * one it left off at.
   */
  const h = await loadApp();
  const { ws, aes } = await pairSession(h, { sessionId: 'sess-gap' });
  const term = h.terminal();

  ws.deliver({ type: 'output', seq: 1, encrypted: true, ...await encrypt('one', aes) });
  await settle();
  const beforeGap = term.written.length;

  // seq 5 after seq 1: three chunks the CLI could not replay.
  ws.deliver({ type: 'output', seq: 5, encrypted: true, ...await encrypt('five', aes) });
  await settle();
  const afterGap = term.written.slice(beforeGap).join('');
  check('a hole in the sequence is marked where it happened',
    /3 chunks of output missing here/.test(afterGap));
  check('and the output that followed it is still written, after the mark',
    afterGap.includes('missing here')
      && afterGap.indexOf('five') > afterGap.indexOf('missing here'));

  const contiguous = term.written.length;
  ws.deliver({ type: 'output', seq: 6, encrypted: true, ...await encrypt('six', aes) });
  await settle();
  check('an unbroken sequence is not marked',
    !/missing here/.test(term.written.slice(contiguous).join('')));

  // A replay that starts past where the phone left off - the eviction case.
  const replayed = term.written.length;
  ws.deliver({
    type: 'catchup_batch',
    batch: [
      { seq: 20, encrypted: true, ...await encrypt('twenty', aes) },
      { seq: 21, encrypted: true, ...await encrypt('-one', aes) }
    ]
  });
  await settle();
  const replay = term.written.slice(replayed).join('');
  check('a replay that starts late says how much it could not bring back',
    /13 chunks of output missing here/.test(replay));
  check('and the replay itself still lands', replay.includes('twenty-one'));

  /*
   * A CLI that restarted counts from one again. That is not a gap - there is
   * nothing missing, the numbering just began afresh - and marking it would put
   * a warning on every CLI restart.
   */
  const restarted = term.written.length;
  ws.deliver({
    type: 'catchup_batch',
    batch: [{ seq: 1, encrypted: true, ...await encrypt('fresh', aes) }]
  });
  await settle();
  check('a CLI that restarted its numbering is not reported as a hole',
    !/missing here/.test(term.written.slice(restarted).join('')));

  h.restoreGlobals();
}

// --- N. The size of the grid -------------------------------------------------
/*
 * Whose terminal is it? The browser window is the wrong answer. The CLI ignores
 * its own SIGWINCH while a phone is attached, so a resize sent from here sticks
 * to the pty until the phone leaves - reflowing the terminal the user is also
 * working in, and any full-screen program running in it.
 */
{
  const h = await loadApp();
  const { ws } = await pairSession(h, { cols: 140, rows: 50 });
  const term = h.terminal();

  check('the grid is set to the size the CLI is running in',
    term.cols === 140 && term.rows === 50, `${term.cols}x${term.rows}`);
  check('and the CLI is not told to resize itself to the browser window',
    ws.sent.filter(m => m.type === 'resize').length === 0,
    `${ws.sent.filter(m => m.type === 'resize').length} sent`);

  h.viewport.resizeTo(400);
  await settle();
  check('nor when the window changes, or the soft keyboard opens',
    ws.sent.filter(m => m.type === 'resize').length === 0);
  check('and the grid holds its size through it',
    term.cols === 140 && term.rows === 50, `${term.cols}x${term.rows}`);

  // Switching to the window is still there for anyone who wants it - a phone
  // used on its own, with no terminal on the other end to disturb.
  check('the menu says where the size comes from',
    /140/.test(h.$('sizeVal').textContent), h.$('sizeVal').textContent);
  h.$('sizeToggle').click();
  await settle();
  check('switching to the window resizes the CLI again',
    ws.sent.some(m => m.type === 'resize'));
  check('and the menu says so', /window/i.test(h.$('sizeVal').textContent),
    h.$('sizeVal').textContent);
  check('and the choice is remembered',
    h.window.localStorage.getItem('termly.sizeMode') === 'window', h.window.localStorage.getItem('termly.sizeMode'));

  h.restoreGlobals();
}

{
  // An unpatched CLI never says what size it is. The old behaviour is the only
  // one left, and it has to keep working rather than leave an 80x24 default.
  const h = await loadApp();
  const { ws } = await pairSession(h);
  await settle();
  check('with no size from the CLI the window is measured, as before',
    ws.sent.some(m => m.type === 'resize'));
  check('and the menu admits it has not been told',
    /window|unknown/i.test(h.$('sizeVal').textContent), h.$('sizeVal').textContent);

  // The relay repeats the size on a reconnect, which is the only way a restored
  // session ever hears it.
  ws.deliver({ type: 'session_info', cols: 120, rows: 40 });
  await settle();
  const term = h.terminal();
  check('a size arriving later is adopted', term.cols === 120 && term.rows === 40,
    `${term.cols}x${term.rows}`);
  const before = ws.sent.filter(m => m.type === 'resize').length;
  h.viewport.resizeTo(500);
  await settle();
  check('and stops the window from being imposed from then on',
    ws.sent.filter(m => m.type === 'resize').length === before);

  h.restoreGlobals();
}

{
  // The manual override: for a CLI that cannot be patched, or a size the user
  // wants to pin for their own reasons.
  const h = await loadApp();
  h.window.prompt = () => '132 x 43';
  const { ws } = await pairSession(h, { cols: 140, rows: 50 });
  const term = h.terminal();

  h.$('sizeToggle').click();   // -> window
  h.$('sizeToggle').click();   // -> fixed, asks for the size
  await settle();
  check('a size typed in by hand is used', term.cols === 132 && term.rows === 43,
    `${term.cols}x${term.rows}`);
  check('and the CLI is left alone for that too',
    ws.sent.filter(m => m.type === 'resize').length === 1,
    `${ws.sent.filter(m => m.type === 'resize').length} sent`);
  check('and it survives a reload',
    h.window.localStorage.getItem('termly.customSize') === '132x43', h.window.localStorage.getItem('termly.customSize'));

  // Nonsense is not a size. Cancelling is not a size either.
  h.window.prompt = () => 'wide please';
  h.$('sizeToggle').click();   // -> back to following the CLI
  h.$('sizeToggle').click();   // -> window
  h.$('sizeToggle').click();   // -> fixed, refused
  await settle();
  check('a size that cannot be read leaves the terminal on the CLI\'s own',
    term.cols === 140 && term.rows === 50, `${term.cols}x${term.rows}`);

  h.restoreGlobals();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
