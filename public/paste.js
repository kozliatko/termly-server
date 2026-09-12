/**
 * Turns clipboard text into the sequence of writes to push at the tty.
 *
 * Pure on purpose: the interesting parts - the size ceiling, the bracketed
 * paste markers, where the chunk boundaries land - are exactly the parts worth
 * testing, and none of them need a DOM.
 */

// A tty in canonical mode accepts about 4096 bytes per line and silently drops
// the rest, so a paste has to arrive in pieces whatever the relay would carry.
export const PASTE_CHUNK = 1024;

// Well under the relay's 4 MB frame limit, and far past anything a person
// meaningfully pastes into a terminal.
export const PASTE_LIMIT = 100000;

export function planPaste(text, { bracketed = false, chunk = PASTE_CHUNK, limit = PASTE_LIMIT } = {}) {
  if (typeof text !== 'string' || text === '') {
    return { ok: true, writes: [] };
  }
  if (text.length > limit) {
    return { ok: false, reason: 'too-large', size: text.length, writes: [] };
  }

  const writes = [];
  if (bracketed) writes.push('\x1b[200~');
  for (let i = 0; i < text.length; i += chunk) writes.push(text.slice(i, i + chunk));
  if (bracketed) writes.push('\x1b[201~');

  return { ok: true, writes };
}
