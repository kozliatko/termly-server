/**
 * The minimum DOM the client touches, so the shipped browser sources can be
 * exercised in Node. Anything beyond this belongs in the UI layer, not the
 * client - if this file starts growing, that separation has slipped.
 */
export function installDomShim(host = 'localhost:3000') {
  // Local relays run plain http; anything else is behind the proxy and is TLS.
  const secure = !/^(localhost|127\.|\[::1\])/.test(host);
  globalThis.location = { protocol: secure ? 'https:' : 'http:', host, pathname: '/' };
  globalThis.document = { hidden: false };

  const listeners = new Map();
  globalThis.addEventListener = (type, fn) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
  };
  globalThis.removeEventListener = (type, fn) => listeners.get(type)?.delete(fn);
  globalThis.dispatch = type => listeners.get(type)?.forEach(fn => fn());

  // localStorage, faithful enough for the session store including the quota path.
  const map = new Map();
  globalThis.localStorage = {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: k => map.delete(k),
    clear: () => map.clear()
  };
}
