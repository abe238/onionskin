// "Changes shown in place" (milestone 3, idea 6a): the safety gate and the text placement, as pure functions. Nothing here touches the
// page, the engine or the network. The page asks two questions and draws only when both say yes:
//   1. planWriteIn(detail, gates): may this refresh draw the agent's changed words in place at all, and which History places qualify?
//   2. locateChanges(paraText, changes): where, in one verified paragraph's text as rendered, do those changes sit, exactly once each?
// Any doubt answers "do nothing": the page then keeps today's fading outline. Every gate input must be proven; a missing or odd value
// closes the gate. Malformed input never throws (a throw would also lose the "changes below" pill that shares the caller).
//
// The text from History is untrusted (document and agent words, sanitized on the server). It is only compared with indexOf (never built
// into a RegExp) and returned as plain strings for React to render as text.
//
// Which run: the gate opens only for an agent run that stands and that Onionskin does not recommend reverting (no error flag, no change
// from outside Onionskin, checks not skipped). Such a run's words may not be the agent's checked changes, so they keep the outline.
//
// Offsets: History's diff ops are over sanitized text with whitespace collapsed (like normTxt in App.jsx). The paragraph text the page
// reads is raw. findOnce matches on the collapsed form and maps the result back to raw offsets. locateChanges checks the page paragraph
// against the server's paragraph before it places anything: the SHA-256 of its text (NFC, whitespace collapsed, as src/text.js textHash)
// must equal the place's locator.text_hash, which the server computed from the update's AFTER text. The page's text can hold letters
// the server's text leaves out (a tracked deletion is drawn struck through; its letters are in the paragraph's text) or lack letters
// the server's text has (hidden text): either shifts the offsets or leaves only an unchanged twin to match, so a hash that differs
// refuses. survivesSanitizer is a second, separate check: no character the server's sanitizer would strip or change (control or direction
// marks, an inline object, a space other than a plain one, another Unicode form), since the diff ops are over sanitized text and the
// hash is not. Ceiling: the hash folds whitespace first, so it cannot tell a plain space on the page from a character the server
// counts as whitespace but the sanitizer strips (U+FEFF, vertical tab, form feed); whether the engine ever draws one of those as a
// plain space was not checked. A paragraph at or over the server's diff cap (DIFF_CAP characters) is refused too: the server diffs
// only its first DIFF_CAP characters and does not mark that cut, so later changes are missing from the ops. A place planWriteIn lists
// can still get null from locateChanges: the caller keeps today's outline for it, and calls locateChanges once per place, not per frame.
// Not proven here: that these raw offsets are the engine's rectsFor offsets ("the paragraph text as shown"). With the hash equal and
// no inline object they count the same characters, as read from the contract, not measured in a browser. The caller's hitTest check
// confirms the rectangle lies in this paragraph; it cannot see a shifted range inside it.

export const WRITEIN = { wipeMs: 500, wasMs: 900, tintMs: 1500, lateMs: 1500, maxPlaces: 40, maxShown: 12, wasChars: 60, contextWords: 6 };

const OBJECT = "[object]"; // what the server writes for an inline object (picture, chart) in the text
const MARK = "…[truncated]"; // what the server's untrusted() appends to text it cut (src/sanitize.js)
const DIFF_CAP = 20_000; // characters of a paragraph the server diffs (src/history.js); the cut is not marked truncated
const HASH = /^[0-9a-f]{16}$/;
// runs whose words may not be the agent's checked changes: changed outside Onionskin (during or behind the agent's turn), checks skipped
const OUTSIDE = new Set(["file_changed_outside_onionskin", "outside_change", "no_pre_snapshot"]);
const isStr = (v) => typeof v === "string";

// The server's untrusted() (src/sanitize.js) without its length cap, copied here because web code does not import server code.
// test/writein.test.js checks that a paragraph this accepts reads the same through the real untrusted().
const STRIP = new RegExp("[\\u0000-\\u001F\\u007F-\\u009F\\u061C\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF]", "g");
const WS = new RegExp("[\\t\\n\\r\\u2028\\u2029]+", "g");
const serverText = (raw) => raw.replace(WS, " ").replace(STRIP, "").normalize("NFC").replace(/ {2,}/g, " ").trim();
/**
 * The page text survives the server's sanitizer unchanged: nothing stripped, replaced or recomposed on the way. This does not compare
 * with the server's text (only locateChanges' hash check does); it rules out characters that sanitizing would move offsets for.
 */
export const survivesSanitizer = (raw) => isStr(raw) && !raw.includes("\uFFFC") && collapse(raw).text === serverText(raw);

/**
 * Is it safe to draw changes in place for this refresh? Every field must be proven:
 *   format "docx"; newest: the session's newest activity entry {kind, reverted, revertRecommended, flags} (an agent run that stands,
 *   that Onionskin does not recommend reverting, with no error flag and no change from outside Onionskin); readOnly false;
 *   merged false (no merge ran and nothing was held back in this refresh); dirtyAtStart false (no unsent typing when it began);
 *   exact true (the view came back to the exact place); visible true (the tab is shown); reducedMotion a boolean (true draws the still version: no wipe, no fade); edited false (no typing
 *   since the refresh); sending false (no Send started); runAtStart and runNow: the newest run id when the refresh began and now, the same.
 * Returns {open: true} or {open: false, why} (why is for tests and logs, never shown to the person).
 */
export function gateOpen(g) {
  if (!g || typeof g !== "object") return { open: false, why: "no-gates" };
  if (g.format !== "docx") return { open: false, why: "format" };
  if (g.newest?.kind !== "agent" || g.newest?.reverted !== false) return { open: false, why: "newest" };
  if (g.newest.revertRecommended !== false || !Array.isArray(g.newest.flags)) return { open: false, why: "revert-recommended" };
  if (!g.newest.flags.every((f) => f && typeof f === "object" && f.severity !== "error" && !OUTSIDE.has(f.code))) return { open: false, why: "flags" };
  if (g.readOnly !== false) return { open: false, why: "read-only" };
  if (g.merged !== false) return { open: false, why: "merged" };
  if (g.dirtyAtStart !== false) return { open: false, why: "dirty" };
  if (g.exact !== true) return { open: false, why: "inexact" };
  if (g.visible !== true) return { open: false, why: "hidden" };
  if (typeof g.reducedMotion !== "boolean") return { open: false, why: "reduced-motion" };
  if (g.edited !== false) return { open: false, why: "edited" };
  if (g.sending !== false) return { open: false, why: "sending" };
  if (!isStr(g.runAtStart) || !g.runAtStart || g.runAtStart !== g.runNow) return { open: false, why: "run-moved" };
  return { open: true };
}

/**
 * The plan for one refresh. `detail` is GET /api/history/:id for the newest update; `gates` as gateOpen, plus docUpAt and detailAt
 * (ms timestamps: the document was up, the detail arrived). Returns {go: false, why} or {go: true, places: [{index, locator, changes}]}
 * where index is the place's position in detail.places and changes come from needlesFor. Places that do not qualify are left out (the
 * caller outlines them as today).
 */
export function planWriteIn(detail, gates) {
  try {
    const g = gateOpen(gates);
    if (!g.open) return { go: false, why: g.why };
    if (!Number.isFinite(gates.docUpAt) || !Number.isFinite(gates.detailAt) || gates.detailAt - gates.docUpAt > WRITEIN.lateMs) return { go: false, why: "late" };
    if (!detail || typeof detail !== "object" || detail.unavailable) return { go: false, why: "unavailable" };
    if (detail.format !== "docx" || detail.kind !== "agent" || detail.after_is_current !== true) return { go: false, why: "detail" };
    if (!Array.isArray(detail.places)) return { go: false, why: "unavailable" };
    if (detail.places.length > WRITEIN.maxPlaces || detail.more !== 0) return { go: false, why: "too-many" };
    const places = [];
    detail.places.forEach((p, index) => {
      if (!bodyParagraph(p?.locator)) return;
      const changes = needlesFor(p);
      if (changes) places.push({ index, locator: p.locator, changes });
    });
    return places.length ? { go: true, places } : { go: false, why: "no-places" };
  } catch {
    return { go: false, why: "error" };
  }
}

/**
 * A top-level body paragraph that can be found again by its opening words and proven by its hash (table cells, headers and footers keep
 * the outline). The caller passes locator.text_hash to locateChanges.
 */
const bodyParagraph = (l) => !!l && l.format === "docx" && Array.isArray(l.body_path) && l.body_path.length === 1 && Number.isInteger(l.body_path[0]) && l.body_path[0] >= 0 && isStr(l.text_start) && !!l.text_start && isStr(l.text_hash) && HASH.test(l.text_hash);

/**
 * The search strings for one History place, or null when it does not qualify: a "modified" text change with a complete diff and no
 * inline object anywhere in it. One entry per change, in order: {needle, insStart, insEnd, was}. needle is the new words with up to
 * contextWords words of unchanged text on each side (never across a gap, where the server cut text out), whitespace collapsed;
 * needle.slice(insStart, insEnd) is the new words (empty for a pure deletion: the place where words went); was is the old words, cut.
 */
export function needlesFor(place) {
  try {
    return needles(place);
  } catch {
    return null; // a sparse or otherwise odd ops list
  }
}
function needles(place) {
  if (!place || place.change !== "modified" || place.too_large || place.truncated || !Array.isArray(place.diff)) return null;
  const ops = Array.from(place.diff); // holes become undefined, which goodOp refuses (every() skips holes)
  if (!ops.length || !ops.every(goodOp)) return null;
  if (ops.some((o) => o[0] !== "…" && (o[1].includes(OBJECT) || o[1].includes(MARK)))) return null; // an object, or text the server cut
  const out = [];
  for (let i = 0; i < ops.length; i++) {
    if (ops[i][0] !== "-" && ops[i][0] !== "+") continue;
    let del = "";
    let add = "";
    const first = i;
    while (i < ops.length && (ops[i][0] === "-" || ops[i][0] === "+")) {
      if (ops[i][0] === "-") del += ops[i][1];
      else add += ops[i][1];
      i++;
    }
    const left = ops[first - 1]?.[0] === "=" ? lastWords(ops[first - 1][1], WRITEIN.contextWords) : "";
    const right = ops[i]?.[0] === "=" ? firstWords(ops[i][1], WRITEIN.contextWords) : "";
    i--; // the loop's i++ steps onto the op after this change
    const n = collapse(left + add + right);
    const insStart = rawToNorm(n.map, left.length);
    let insEnd = Math.max(insStart, rawToNorm(n.map, left.length + add.length));
    // the new words without the spaces around them (those belong to the join, not the change)
    let s = insStart;
    while (s < insEnd && n.text[s] === " ") s++;
    while (insEnd > s && n.text[insEnd - 1] === " ") insEnd--;
    if (!/\S/.test(n.text)) return null; // nothing to find: a deletion with no words around it
    if (!add.trim() && !del.trim()) return null; // only spacing moved: nothing to show, and the place keeps its outline
    out.push({ needle: n.text, insStart: add.trim() ? s : insStart, insEnd: add.trim() ? insEnd : insStart, was: wasText(del) });
  }
  return out.length ? out : null;
}

const goodOp = (o) => Array.isArray(o) && (o[0] === "…" ? o.length === 1 : (o[0] === "=" || o[0] === "-" || o[0] === "+") && isStr(o[1]));

/** The last / first `n` words of an unchanged run, with the whitespace between them (words are runs of non-space characters). */
function lastWords(text, n) {
  const parts = text.split(/(\s+)/);
  let words = 0;
  let k = parts.length;
  while (k > 0) {
    const t = parts[k - 1];
    if (t && !/^\s+$/.test(t)) {
      if (words === n) break;
      words++;
    }
    k--;
  }
  return parts.slice(k).join("");
}
function firstWords(text, n) {
  const parts = text.split(/(\s+)/);
  let words = 0;
  let k = 0;
  while (k < parts.length) {
    const t = parts[k];
    if (t && !/^\s+$/.test(t)) {
      if (words === n) break;
      words++;
    }
    k++;
  }
  return parts.slice(0, k).join("");
}

/** The old words for the "Was:" chip: plain text, whitespace collapsed, at most wasChars characters (code points) ending in "…". */
export function wasText(s) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  const cps = [...t];
  return cps.length > WRITEIN.wasChars ? cps.slice(0, WRITEIN.wasChars - 1).join("") + "…" : t;
}

/** Whitespace collapsed and trimmed (as App.jsx normTxt), with map[i] = the raw index of collapsed character i. */
function collapse(raw) {
  let text = "";
  const map = [];
  let pendingSpace = -1;
  for (let i = 0; i < raw.length; i++) {
    if (/\s/.test(raw[i])) {
      if (text && pendingSpace < 0) pendingSpace = i;
      continue;
    }
    if (pendingSpace >= 0) {
      text += " ";
      map.push(pendingSpace);
      pendingSpace = -1;
    }
    text += raw[i];
    map.push(i);
  }
  return { text, map };
}
/** How many collapsed characters come from raw text before raw index `r`. */
const rawToNorm = (map, r) => {
  let k = 0;
  while (k < map.length && map[k] < r) k++;
  return k;
};

/**
 * Where `needle` occurs in `text`, if it occurs exactly once (overlapping occurrences count). Both are compared with whitespace
 * collapsed; the answer is in raw offsets of `text`: {start, end} of the whole needle, plus `at(k)`, the raw offset of needle
 * position k. null when it is missing, found twice or more, or empty.
 */
export function findOnce(text, needle) {
  if (!isStr(text) || !isStr(needle)) return null;
  const want = collapse(needle).text;
  if (!want) return null;
  const hay = collapse(text);
  const first = hay.text.indexOf(want);
  if (first < 0 || hay.text.indexOf(want, first + 1) >= 0) return null;
  const at = (k) => (k <= 0 ? hay.map[first] : k >= want.length ? hay.map[first + want.length - 1] + 1 : hay.map[first + k]);
  return { start: at(0), end: at(want.length), at };
}

/**
 * The raw ranges of one place's changes inside the paragraph text read from the page, or null (all or nothing). textHash is the place's
 * locator.text_hash: the page text must hash to it (it is the server's after text), survive the sanitizer unchanged and stay under the
 * diff cap; every needle must be found exactly once, and the ranges must come in order without overlapping. Each result is
 * {start, end, was}; start === end for a pure deletion (the place where words went).
 */
export function locateChanges(paraText, changes, textHash) {
  try {
    if (!isStr(textHash) || !HASH.test(textHash) || !survivesSanitizer(paraText) || !Array.isArray(changes) || !changes.length) return null;
    const norm = paraText.normalize("NFC").replace(/\s+/g, " ").trim(); // src/text.js normText
    if (norm.length >= DIFF_CAP || sha256hex(norm).slice(0, 16) !== textHash) return null; // UTF-16 length >= code points: never under-refuses
    const out = [];
    let prevEnd = -1;
    for (const c of changes) {
      const f = findOnce(paraText, c?.needle);
      if (!f || !Number.isInteger(c.insStart) || !Number.isInteger(c.insEnd) || c.insEnd < c.insStart) return null;
      const start = f.at(c.insStart);
      const end = c.insEnd === c.insStart ? start : f.at(c.insEnd - 1) + 1;
      if (start <= prevEnd || end < start || end > paraText.length) return null;
      out.push({ start, end, was: isStr(c.was) ? c.was : "" });
      prevEnd = Math.max(start, end);
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * SHA-256 of a string's UTF-8 bytes, as 64 hex characters. Synchronous, so the placement stays a plain function the redraw can call
 * (crypto.subtle is async only). Inputs are paragraphs under DIFF_CAP characters.
 */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
export function sha256hex(str) {
  const bytes = new TextEncoder().encode(str);
  const n = ((bytes.length + 9 + 63) >> 6) << 6; // message + 0x80 + 64-bit length, padded to 64-byte blocks
  const buf = new Uint8Array(n);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(n - 8, Math.floor((bytes.length * 8) / 2 ** 32));
  dv.setUint32(n - 4, (bytes.length * 8) >>> 0);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x, r) => (x >>> r) | (x << (32 - r));
  for (let off = 0; off < n; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    let [a, b, c, d, e, f, g, k] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (k + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      k = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] += a;
    h[1] += b;
    h[2] += c;
    h[3] += d;
    h[4] += e;
    h[5] += f;
    h[6] += g;
    h[7] += k;
  }
  return Array.from(h, (x) => x.toString(16).padStart(8, "0")).join("");
}
