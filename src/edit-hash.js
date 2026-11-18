// The text hash of a pending HTML text edit (PLAN-html R9): one function for the page (web/src/html-view.js) and the server
// (src/html-write.js), so both read the same 14 hex digits. Pure, no imports. Fixed vectors: test/html-view.test.js.

/**
 * cyrb53 over the exact text (UTF-16 code units, nothing normalized), 14 hex digits. Not a security hash: it tells "the text the edit
 * was made on" from another text, and the version's sha256 travels with it.
 */
export function editHash(s) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}
