import crypto from "node:crypto";
import { nfc } from "./nfc.js";

/** NFC (src/nfc.js: linear, also on a run of thousands of combining marks), whitespace collapsed, trimmed: the text every anchor, hash and comparison is built on. Null and undefined read as "". */
export const normText = (s) => nfc(s).replace(/\s+/g, " ").trim();

const sha16 = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);
/** 16-hex hash of the normalized text (DOCX paragraphs, PPTX shapes) */
export const textHash = (s) => sha16(normText(s));
/** 16-hex hash of the NFC text with whitespace kept (XLSX cells and regions compare character for character) */
export const exactHash = (s) => sha16(nfc(s));

function bigrams(s) {
  const m = new Map();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    m.set(g, (m.get(g) || 0) + 1);
  }
  return m;
}
/**
 * The character bigrams of a text, normalized and lowercased as similarity() reads it, as a sorted list of codes (two UTF-16 units in
 * one number). Two such lists give the same Dice coefficient as similarity() by one merge, without building a map per comparison.
 */
export function bigramCodes(s) {
  const t = normText(s).toLowerCase();
  const out = new Float64Array(Math.max(0, t.length - 1));
  for (let i = 0; i < out.length; i++) out[i] = t.charCodeAt(i) * 65536 + t.charCodeAt(i + 1);
  out.sort();
  return { codes: out, empty: !t, short: t.length < 2 ? t : null };
}
/** similarity(a, b) from bigramCodes(a) and bigramCodes(b). */
export function diceOf(A, B) {
  if (A.empty && B.empty) return 1;
  if (A.short !== null || B.short !== null) return A.short !== null && B.short !== null && A.short === B.short ? 1 : 0;
  const a = A.codes;
  const b = B.codes;
  let i = 0;
  let j = 0;
  let hit = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) (hit++, i++, j++);
    else if (a[i] < b[j]) i++;
    else j++;
  }
  return (2 * hit) / (a.length + b.length);
}

/** Dice coefficient over character bigrams of the normalized, lowercased strings (0..1). */
export function similarity(a, b) {
  return similarityTo(b)(a);
}
/** similarity(a, b) as a function of `a`, with b's bigrams counted once: comparing one text with every paragraph stays linear. */
export function similarityTo(b) {
  b = normText(b).toLowerCase();
  let B = null;
  return (a) => {
    a = normText(a).toLowerCase();
    if (!a && !b) return 1;
    if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
    B ??= bigrams(b);
    const A = bigrams(a);
    let hit = 0;
    for (const [g, c] of A) hit += Math.min(c, B.get(g) || 0);
    return (2 * hit) / (a.length - 1 + b.length - 1);
  };
}

// Resolving a moved anchor scans the whole reading (every paragraph's text, every cell of a sheet): its cost is the document once per such
// anchor. scanBudget(n, fn) bounds the scans of every anchor resolved inside fn together (src/docx.js counts bigrams and paragraphs,
// src/xlsx.js cells); past it, an anchor its cheap steps do not find resolves as "moved or removed". The server resolves the anchors of
// one request under one budget (src/session.js).
// Making an anchor is paid the same way as resolving one: no work runs past the budget "because it must". An anchor whose text
// cannot be paid for is made without it (src/xlsx.js: the address and its context, no text hash), never by going over.
let scanLeft = Infinity;
let watcher = null;
export function scanBudget(n, fn) {
  const before = scanLeft;
  scanLeft = n;
  try {
    return fn();
  } finally {
    scanLeft = before;
  }
}
/** Spends `n` of the current budget; false (and nothing spent) when it does not have that much left. */
export function spend(n) {
  const ok = scanLeft >= n;
  watcher?.(n, ok, scanLeft === Infinity);
  if (!ok) return false;
  scanLeft -= n;
  return true;
}
/** Can the budget pay `n`? Nothing is spent (a text longer than what is left is refused before its weight is counted). */
export const affords = (n) => scanLeft >= n;
/** Tests: `fn(n, ok, outside)` sees every spend (`outside`: no scanBudget around it); null stops watching. */
export const watchBudget = (fn) => (watcher = fn);

/**
 * What reading `s` once costs the budget (normalizing, hashing or encoding it): a unit per character of ASCII text, else 2 units per
 * UTF-8 byte. Measured per million characters here (nfc, then sha256): ASCII 1.2 ms; text with any non-ASCII character, which V8 keeps
 * at two bytes a character, 4.7 ms (é: 4 units), CJK 8 ms (6 units), emoji 7 to 10 ms (4 units a UTF-16 unit). Buffer.byteLength reads
 * 10 million characters in under 2 ms, about a hundredth of the work it prices.
 * Ceiling: text that normalization rewrites (decomposed letters, "e" + U+0301) costs about 30 ms per million and is charged 3 units a
 * character, so a budget's worth of it is slower than a budget's worth of ASCII (40 million units: about 0.4 s against 0.05 s).
 * Upgrade path: count combining marks in the reader's own pass over the text and price them apart.
 */
export function weigh(s) {
  const bytes = Buffer.byteLength(s, "utf8");
  return bytes === s.length ? bytes : 2 * bytes;
}
/**
 * What a native substring search for `q` in `n` characters costs the budget, by what V8 does on the text at hand (measured on 7.9
 * million characters, and on 26,000 paragraphs of English prose, 6.6 million characters). V8 finds candidate places with memchr for
 * one byte of the needle's first character (the character itself in a one-byte string; in a two-byte string, the larger of its two
 * bytes, which also matches characters that only share that byte) and checks the rest at each: for a needle of 2 to 6 characters,
 * 6.4 to 7 ns a candidate on dense text ("az" in 7.9 million "a", "aaz" in "abab...", "丁z" in 7.9 million "中"), 3 to 13 ns on
 * prose (13 ns for sparse candidates). Longer needles switch to a skipping search only once candidates matched far enough; candidates
 * that share only a byte ("丁丁丁丁丁丁丁丁丁z" in "中") never do and cost the same 7 ns each, and so does a one-character needle in a
 * two-byte string ("丁" in "中": 55 ms). A needle whose first two characters match everywhere costs no more per candidate than one
 * whose second does not ("abz" and "az" on "abab...": 6.1 ns). The rest of the text costs memchr's pass, 0.015 to 0.05 ns a character.
 * Charged: a 16th of a unit a character, HIT units a candidate (hitsOf counts them, from a byte table kept per unit) and a unit for
 * the call, whatever the needle's length; `hits` defaults to every character (the worst case) where no table is kept. Ceiling: a
 * whole budget of searching is at most about 0.26 s (40 million / HIT candidates at 13 ns); a long needle on one-byte text that
 * matches everywhere (V8 skips there, 0.5 to 1.1 ns a character) is charged as if it did not skip, about 4 times what it costs.
 * Each occurrence a search lists costs OCCURRENCE.
 */
export const HIT = 2;
export const searchCost = (n, q, hits = n) => (n >> 4) + HIT * hits + 1;
// The byte table of a unit's text: for every byte value, how many characters hold it as their low byte or as a nonzero high byte (an
// upper bound on memchr's candidates for any needle in either string width). Kept as [byte * 2^32 + count] for the bytes present.
const SCRATCH = new Uint32Array(256);
const TWO32 = 2 ** 32;
function byteTable(s) {
  const t = SCRATCH;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const lo = c & 255;
    t[lo]++;
    const hi = c >> 8;
    if (hi && hi !== lo) t[hi]++;
  }
  const out = [];
  for (let b = 0; b < 256; b++) if (t[b]) out.push(b * TWO32 + t[b]), (t[b] = 0);
  return Float64Array.from(out);
}
/**
 * How many places a native search for `q` in `s` (the text of `unit`, keyed in `cache`, a WeakMap per kind of text) checks, from the
 * unit's byte table (`unit.text` is the text as written; `s` the text searched, the same or its normalized form). The table is built
 * once per unit at 2 units a character (measured 1.75 ns); past the budget, every character.
 */
export function hitsOf(cache, unit, s, q) {
  q = String(q ?? "");
  const f = q.charCodeAt(0);
  if (!(f >= 0)) return 0;
  // one character below 256 in ASCII text: memchr looks for the character itself (its other byte is 0) and stops at the first match. Not
  // for a character above: in ASCII text that V8 holds two bytes a character, "š" (0x161) stops at every "a" (0x61).
  if (q.length === 1 && f < 256 && weightOf(unit) === unit.text.length) return 0;
  let t = cache.get(unit);
  if (t === undefined) {
    if (!spend(2 * s.length)) return s.length;
    cache.set(unit, (t = byteTable(s)));
  }
  const b = Math.max(f & 255, f >> 8);
  for (const v of t) if (Math.floor(v / TWO32) === b) return v % TWO32;
  return 0;
}
/** what listing one more occurrence costs (measured 27 ns each, with the search that finds it, on 395,000 of them) */
export const OCCURRENCE = 24;
/** normText(s), paid from the budget at weigh(s) first; null when it cannot pay (text the page sent, with no reading to keep it on). */
export function normPaid(s) {
  s = String(s ?? "");
  return affords(s.length) && spend(weigh(s)) ? normText(s) : null;
}
// weigh() of a unit's text (a paragraph, a shape), kept per unit of a reading: a text the budget refuses is weighed once, not once per anchor
const WEIGHT = new WeakMap();
export function weightOf(unit) {
  let w = WEIGHT.get(unit);
  if (w === undefined) WEIGHT.set(unit, (w = weigh(unit.text)));
  return w;
}
