// Notes as a CRDT (Yjs). Shared by the browser, the Android app and the server.
// Each record's notes live in a small Yjs document. Edits made on different devices
// merge character by character instead of one overwriting the other.
import * as Y from '../vendor/yjs.mjs';

export const toB64 = (u8) => {
  if (typeof Buffer !== 'undefined') return Buffer.from(u8).toString('base64');
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
};
export const fromB64 = (b64) => {
  if (!b64) return null;
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
  const s = atob(b64);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
};

/** Load a document from saved state; if there is none, start one holding `text`. */
export function loadDoc(state, text = '') {
  const doc = new Y.Doc();
  if (state && state.length) Y.applyUpdate(doc, state);
  else if (text) doc.getText('notes').insert(0, text);
  return doc;
}

/** Change the document's text to `next` with the smallest edit (common prefix/suffix kept). */
export function setText(doc, next) {
  const yt = doc.getText('notes');
  const prev = yt.toString();
  if (prev === next) return;
  let start = 0;
  while (start < prev.length && start < next.length && prev[start] === next[start]) start++;
  let endPrev = prev.length;
  let endNext = next.length;
  while (endPrev > start && endNext > start && prev[endPrev - 1] === next[endNext - 1]) { endPrev--; endNext--; }
  doc.transact(() => {
    if (endPrev > start) yt.delete(start, endPrev - start);
    if (endNext > start) yt.insert(start, next.slice(start, endNext));
  });
}

export const getText = (doc) => doc.getText('notes').toString();
export const encode = (doc) => Y.encodeStateAsUpdate(doc);

/** Merge another device's full state into `doc` (order does not matter; repeats are harmless). */
export function mergeState(doc, state) {
  if (state && state.length) Y.applyUpdate(doc, state);
}

/** Convenience: start from `state` (or `baseText`), apply an edit to `newText`, return new state. */
export function editState(state, baseText, newText) {
  const doc = loadDoc(state, baseText);
  setText(doc, newText);
  return encode(doc);
}
