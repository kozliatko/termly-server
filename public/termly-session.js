/**
 * Survives a page reload.
 *
 * This is what makes the PWA worth installing. A standalone PWA on iOS is
 * cold-started far more aggressively than a Safari tab, and without this a
 * cold start loses the session for good: the pairing code is single-use, so
 * recovering means walking back to the desktop and restarting `termly start`.
 *
 * The stored blob contains the Diffie-Hellman private exponent, which is enough
 * to decrypt the session. That is a deliberate trade - the phone already
 * displays the plaintext terminal - but it means the blob gets an expiry, is
 * bound to the relay it was created against, and is wiped the moment the
 * session is gone or the user asks.
 */

const KEY = 'termly.session.v1';

// Long enough to survive a night, short enough that a lost phone is not an
// indefinite terminal. Refreshed on every save while the session is in use.
const MAX_AGE_MS = 12 * 60 * 60 * 1000;

function storage() {
  try {
    // Safari in private mode has localStorage but throws on write, so probe it.
    const probe = '__termly_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return null;
  }
}

export function saveSession(state) {
  const store = storage();
  if (!store) return false;
  try {
    store.setItem(KEY, JSON.stringify({
      version: 1,
      host: location.host,
      sessionId: state.sessionId,
      privateKey: state.privateKey,
      cliPublicKey: state.cliPublicKey,
      lastSeq: state.lastSeq || 0,
      savedAt: Date.now()
    }));
    return true;
  } catch {
    // A full quota is not worth failing the session over.
    return false;
  }
}

export function loadSession() {
  const store = storage();
  if (!store) return null;

  let saved;
  try {
    saved = JSON.parse(store.getItem(KEY) || 'null');
  } catch {
    clearSession();
    return null;
  }
  if (!saved || saved.version !== 1) return null;

  // A blob from a different relay is useless here, and restoring it would leak
  // one relay's key material into a request to another.
  if (saved.host !== location.host) {
    clearSession();
    return null;
  }
  if (!saved.sessionId || !saved.privateKey || !saved.cliPublicKey) {
    clearSession();
    return null;
  }
  if (Date.now() - saved.savedAt > MAX_AGE_MS) {
    clearSession();
    return null;
  }
  return saved;
}

export function clearSession() {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(KEY);
  } catch { /* nothing left to do */ }
}

/**
 * lastSeq moves with every chunk of output, and writing localStorage on each
 * one would stall the render loop. Coalesce, and flush on the events that
 * actually precede a kill: backgrounding and page teardown.
 */
export function createSeqPersister(getState, intervalMs = 3000) {
  let timer = null;
  let pending = false;

  const flush = () => {
    timer = null;
    if (!pending) return;
    pending = false;
    const state = getState();
    if (state) saveSession(state);
  };

  const schedule = () => {
    pending = true;
    if (timer === null) timer = setTimeout(flush, intervalMs);
  };

  const flushNow = () => {
    if (timer !== null) clearTimeout(timer);
    flush();
  };

  // pagehide covers the iOS case that visibilitychange misses.
  addEventListener('visibilitychange', () => { if (document.hidden) flushNow(); });
  addEventListener('pagehide', flushNow);

  return { schedule, flushNow };
}
