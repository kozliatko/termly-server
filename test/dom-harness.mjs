/**
 * A DOM real enough to load `app.js` against.
 *
 * `app.js` is the largest file here and was the only one with no test: every
 * other module is reachable from Node, but the UI layer touches the document
 * the moment it is imported. This puts the shipped `index.html` in a jsdom
 * window, stubs the three browser APIs that have no Node equivalent (xterm, the
 * socket, the clipboard) and hands back handles to drive them.
 *
 * The stubs are deliberately shallow. The point is to exercise the wiring in
 * `app.js` - which element does what, which state follows which event - not to
 * re-test xterm or the relay, both of which have their own coverage.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const pub = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

// A terminal that records instead of rendering.
class FakeTerminal {
  constructor(options) {
    this.options = options;
    this.cols = 80;
    this.rows = 24;
    this.written = [];
    this.cleared = 0;
    this.focused = 0;
    this.selection = '';
    this.modes = { bracketedPasteMode: false };
    this.buffer = { active: { baseY: 0, viewportY: 0 } };
    this._handlers = { data: [], scroll: [], writeParsed: [] };
    this.keyHandler = null;
    this.scrolledToBottom = 0;
    this.resizes = [];
  }
  resize(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    this.resizes.push(`${cols}x${rows}`);
  }
  open(element) { this.element = element; }
  loadAddon(addon) { addon.activate?.(this); }
  onData(fn) { this._handlers.data.push(fn); }
  onScroll(fn) { this._handlers.scroll.push(fn); }
  onWriteParsed(fn) { this._handlers.writeParsed.push(fn); }
  attachCustomKeyEventHandler(fn) { this.keyHandler = fn; }
  write(text) { this.written.push(text); this._handlers.writeParsed.forEach(f => f()); }
  clear() { this.cleared++; }
  focus() { this.focused++; }
  getSelection() { return this.selection; }
  scrollToBottom() {
    this.scrolledToBottom++;
    this.buffer.active.viewportY = this.buffer.active.baseY;
    this._handlers.scroll.forEach(f => f());
  }
  // Test-side helpers.
  type(data) { this._handlers.data.forEach(f => f(data)); }
  scrollUpBy(lines) {
    this.buffer.active.viewportY = Math.max(0, this.buffer.active.baseY - lines);
    this._handlers.scroll.forEach(f => f());
  }
}

// The fit addon only has to count: whether app.js re-measures on a viewport
// change is the thing worth asserting, not what xterm computes.
class FakeFit {
  static last = null;
  constructor() { this.fits = 0; FakeFit.last = this; }
  activate(term) { this.term = term; }
  fit() { this.fits++; }
}

// The web-links addon only has to be loadable here: what it does with a URL is
// xterm's own coverage, not ours.
class FakeWebLinks {
  static last = null;
  constructor() { FakeWebLinks.last = this; }
  activate(term) { this.term = term; }
  dispose() {}
}

// Sockets that never leave the process; the test plays the relay.
class FakeWebSocket {
  static instances = [];
  static onSend = null;
  // The client compares readyState against WebSocket.OPEN, so the constants are
  // part of the contract, not decoration: without them every send is a no-op.
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.onopen?.();
    });
  }
  send(raw) {
    this.sent.push(JSON.parse(raw));
    FakeWebSocket.onSend?.(JSON.parse(raw), this);
  }
  close(code = 1000, reason = '') {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
  // Test-side helpers.
  deliver(message) { this.onmessage?.({ data: JSON.stringify(message) }); }
  reject(error, message) {
    this.readyState = 3;
    this.onclose?.({ code: 4000, reason: JSON.stringify({ error, message }) });
  }
  static get latest() { return FakeWebSocket.instances.at(-1); }
  static reset() { FakeWebSocket.instances = []; FakeWebSocket.onSend = null; }
}

export async function loadApp({
  storage = {},
  clipboard = 'granted',
  url = 'https://termly.test/',
  // null = the browser has no BarcodeDetector; a string = what the next frame
  // decodes to. The CLI encodes JSON, older builds encode the bare code.
  barcode = null,
  cameraError = null,
  // Whether an older build is already in charge. Without a controller the page
  // is on its first install, where there is nothing to update from.
  swController = false,
  // A new build that finished installing while the page was closed.
  swWaiting = false,
  // A browser that refuses to register the worker at all.
  swRegisterError = null,
  // A browser set to block site data: touching `localStorage` throws, rather
  // than the storage merely being empty.
  storageBlocked = false,
  // A plain-http origin, where the browser withholds crypto.subtle.
  secureContext = true
} = {}) {
  const html = await readFile(path.join(pub, 'index.html'), 'utf8');

  // jsdom shouts about every stylesheet it will not fetch and about the
  // navigation `End session` performs. Both are expected here; keep the
  // transcript to the assertions.
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', () => {});

  const dom = new JSDOM(html, {
    url,
    pretendToBeVisual: true,
    virtualConsole
  });
  const { window } = dom;

  for (const [key, value] of Object.entries(storage)) {
    window.localStorage.setItem(key, value);
  }

  if (storageBlocked) {
    // Blocking site data is not an empty store: the property access itself
    // throws, which is why a bare read at import time takes the page down.
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() { throw new window.DOMException('The operation is insecure.', 'SecurityError'); }
    });
  }

  // An insecure origin still has crypto - it just has no subtle, which is every
  // primitive this app encrypts with.
  Object.defineProperty(window, 'crypto', {
    configurable: true,
    value: secureContext ? globalThis.crypto : { getRandomValues: a => globalThis.crypto.getRandomValues(a) }
  });

  const clipboardState = { text: '', written: [] };
  const fakeClipboard = clipboard === 'none' ? undefined : {
    readText: async () => {
      if (clipboard === 'denied') throw new Error('denied');
      return clipboardState.text;
    },
    writeText: async text => {
      if (clipboard === 'denied') throw new Error('denied');
      clipboardState.written.push(text);
    }
  };

  Object.defineProperty(window.navigator, 'clipboard', {
    value: fakeClipboard, configurable: true
  });
  Object.defineProperty(window.navigator, 'onLine', { value: true, configurable: true });

  const wakeLocks = [];
  Object.defineProperty(window.navigator, 'wakeLock', {
    configurable: true,
    value: {
      request: async () => {
        const lock = { released: false, release: async () => { lock.released = true; }, addEventListener() {} };
        wakeLocks.push(lock);
        return lock;
      }
    }
  });
  const camera = { opened: 0, stopped: 0, stream: null };
  if (barcode !== null) {
    const track = { stop() { camera.stopped++; camera.stream.active = false; } };
    camera.stream = { active: true, getTracks: () => [track] };
    Object.defineProperty(window.navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => {
          camera.opened++;
          if (cameraError) throw new Error(cameraError);
          return camera.stream;
        }
      }
    });
    window.BarcodeDetector = class {
      constructor(options) { this.options = options; }
      async detect() { return barcode ? [{ rawValue: barcode }] : []; }
    };
    // jsdom has no media pipeline, so play() throws "not implemented".
    window.HTMLMediaElement.prototype.play = async function play() { /* no pipeline */ };
  }

  // A service worker registration real enough to drive the update flow: the
  // page's whole story about new builds is `updatefound` -> `statechange` ->
  // postMessage -> `controllerchange`, and none of it exists in jsdom.
  const sw = { registrations: 0, updates: 0, messages: [], reloads: 0, registerError: swRegisterError };

  const registration = new window.EventTarget();
  registration.scope = '/';
  registration.installing = null;
  registration.waiting = null;
  registration.update = async () => { sw.updates++; };

  const container = new window.EventTarget();
  container.controller = swController ? { postMessage() {} } : null;
  container.register = async (url, options) => {
    sw.registrations++;
    sw.registerUrl = url;
    sw.registerOptions = options;
    if (sw.registerError) throw new Error(sw.registerError);
    return registration;
  };

  const makeWorker = () => {
    const worker = new window.EventTarget();
    worker.state = 'installing';
    worker.postMessage = message => sw.messages.push(message);
    return worker;
  };

  /** A new build finishing its install while the page is open. */
  sw.installUpdate = () => {
    const worker = makeWorker();
    registration.installing = worker;
    registration.dispatchEvent(new window.Event('updatefound'));
    worker.state = 'installed';
    registration.installing = null;
    registration.waiting = worker;
    worker.dispatchEvent(new window.Event('statechange'));
    return worker;
  };

  /** The waiting worker taking over, which is what a real skipWaiting causes. */
  sw.takeOver = () => container.dispatchEvent(new window.Event('controllerchange'));

  // A build that finished installing while the page was closed is already
  // waiting by the time the page loads.
  if (swWaiting) registration.waiting = makeWorker();

  Object.defineProperty(window.navigator, 'serviceWorker', {
    configurable: true, value: container
  });

  // jsdom's reload is "not implemented", and Location's members are unforgeable -
  // not writable, not configurable, and a Proxy may not lie about them either.
  // The client reads `location` off the global, so it gets a stand-in carrying
  // the fields it actually uses, with a reload that can be counted.
  const real = window.location;
  const locationStub = {
    reload: () => { sw.reloads++; },
    get href() { return real.href; },
    set href(value) { sw.navigated = value; },
    get origin() { return real.origin; },
    get protocol() { return real.protocol; },
    get host() { return real.host; },
    get hostname() { return real.hostname; },
    get pathname() { return real.pathname; },
    get search() { return real.search; },
    get hash() { return real.hash; }
  };

  window.Terminal = FakeTerminal;
  window.FitAddon = { FitAddon: FakeFit };
  window.WebLinksAddon = { WebLinksAddon: FakeWebLinks };
  FakeFit.last = null;
  FakeWebLinks.last = null;

  // jsdom has no visual viewport. The soft keyboard is the whole reason app.js
  // measures one, so give the tests something to shrink.
  const viewport = new window.EventTarget();
  viewport.height = 800;
  viewport.scale = 1;
  viewport.resizeTo = height => {
    viewport.height = height;
    viewport.dispatchEvent(new window.Event('resize'));
  };
  /*
   * Pinching, as the browser reports it: the visible height is the layout height
   * divided by the scale, and panning the zoomed page fires scroll.
   */
  viewport.zoomTo = (scale, layoutHeight = 800) => {
    viewport.scale = scale;
    viewport.height = layoutHeight / scale;
    viewport.dispatchEvent(new window.Event('resize'));
    viewport.dispatchEvent(new window.Event('scroll'));
  };
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
  window.WebSocket = FakeWebSocket;
  FakeWebSocket.reset();

  // app.js reads everything off globals, so point Node's at the window's.
  const restore = [];
  for (const key of [
    'window', 'document', 'navigator', 'location', 'localStorage', 'sessionStorage',
    'Terminal', 'FitAddon', 'WebLinksAddon', 'WebSocket', 'Event', 'CustomEvent', 'KeyboardEvent',
    'MouseEvent', 'PointerEvent', 'HTMLElement', 'Node', 'getComputedStyle',
    'requestAnimationFrame', 'cancelAnimationFrame', 'addEventListener',
    'removeEventListener', 'dispatchEvent', 'matchMedia', 'BarcodeDetector',
    'crypto', 'DOMException'
  ]) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    if (previous) restore.push([key, previous]);

    let source;
    try {
      source = key in window ? window[key] : undefined;
    } catch (err) {
      // The window refuses to hand this one over - blocked site data. The global
      // has to refuse the same way, or the test would be gentler than a browser.
      Object.defineProperty(globalThis, key, { configurable: true, get() { throw err; } });
      continue;
    }

    Object.defineProperty(globalThis, key, {
      value: typeof source === 'function' && /^(add|remove|dispatch|get|request|cancel|match)/.test(key)
        ? source.bind(window)
        : source,
      configurable: true, writable: true
    });
  }
  globalThis.window = window;
  Object.defineProperty(globalThis, 'location', {
    value: locationStub, configurable: true, writable: true
  });

  // Cache-bust so repeated loads in one process get a fresh module instance.
  const app = await import(`../public/app.js?t=${Date.now()}`);

  // app.js waits for the document to be ready before touching the worker, so
  // that registering it never competes with the first paint. Sending `load` by
  // hand covers the case where jsdom has already fired its own; the page listens
  // once, so whichever arrives first is the only one that counts.
  window.dispatchEvent(new window.Event('load'));
  await new Promise(resolve => setTimeout(resolve, 1));

  return {
    dom, window, app,
    document: window.document,
    $: id => window.document.getElementById(id),
    sockets: FakeWebSocket,
    clipboard: clipboardState,
    camera,
    viewport,
    sw,
    registration,
    fit: () => FakeFit.last,
    wakeLocks,
    terminal: () => FakeTerminal.last,
    restoreGlobals: () => restore.forEach(([k, d]) => Object.defineProperty(globalThis, k, d))
  };
}

// The app builds exactly one terminal; remember it for the assertions.
const originalOpen = FakeTerminal.prototype.open;
FakeTerminal.prototype.open = function open(element) {
  FakeTerminal.last = this;
  return originalOpen.call(this, element);
};

export { FakeTerminal, FakeWebSocket, FakeFit, FakeWebLinks };
