// Pure helpers over engine text runs: find text across runs, replace it, split runs for formatting.
// A "run" here is an engine Inline ({t:'text', text, ...}) or any other inline (counts as one object character).
// Tracked-deletion runs ({tc:{k:'del'}}) are not part of the visible text and are never touched.

export const OBJ = "￼";
const isVisible = (r) => !(r.tc && r.tc.k === "del");
const isText = (r) => r.t === "text";

/** visible text plus, per visible run, its [start,end) offsets (objects take one character) */
export function layout(runs) {
  let text = "";
  const segs = [];
  runs.forEach((r, i) => {
    if (!isVisible(r)) return;
    const s = text.length;
    text += isText(r) ? r.text : OBJ;
    segs.push({ i, start: s, end: text.length, text: isText(r) });
  });
  return { text, segs };
}

/**
 * Case folding for find: each code point on its own, lowercased, with the final sigma folded to sigma. Per code point, because
 * String.prototype.toLowerCase of a whole text can change its length (U+0130 becomes two units), which moved every offset found in
 * the folded text away from the original. Each code point's expansion stays tied to that one character (see findRanges).
 */
export function foldCase(s) {
  let out = "";
  for (const ch of s) out += foldChar(ch);
  return out;
}
const FOLDED = new Map(); // a character -> its folding (each distinct character is folded once)
const foldChar = (ch) => {
  let f = FOLDED.get(ch);
  if (f === undefined) FOLDED.set(ch, (f = ch === "ς" ? "σ" : ch.toLowerCase()));
  return f;
};

/**
 * Calls fn(start, end) for each non-overlapping match of `find` in `text`, [start, end) offsets INTO `text` (end - start is the
 * matched length, which with match_case off is not always find.length: "İ" folds to two units). Matches are found in the folded text
 * and mapped back. Rule: a match must begin and end between original characters; a folded match that starts or ends inside one
 * character's expansion ("i" against the "i" + U+0307 that U+0130 folds to) is not reported, because replacing it would cut a
 * character in half. Matching is leftmost first; after a rejected candidate the search resumes one unit later. With `overlap` the search
 * resumes one unit after the start of every match too, so matches may overlap (countOverlapping only).
 * Linear, with no record per match: the folded text and its map back to the original are built once (typed arrays, one entry per
 * folded unit) and only when match_case is off. Ceiling: a pathological text matches millions of times (8 million characters of "İ "
 * against "i̇": 4 million), each one a call of fn.
 */
export function eachMatch(text, find, matchCase, fn, overlap = false) {
  if (!find) return;
  if (matchCase) {
    for (let at = text.indexOf(find); at >= 0; at = text.indexOf(find, at + (overlap ? 1 : find.length))) fn(at, at + find.length);
    return;
  }
  const needle = foldCase(find);
  if (!needle) return;
  // pass 1: the folded length; ASCII folds to one unit of its own, anything else through foldChar
  let n = 0;
  let plain = true;
  for (let k = 0; k < text.length; k++) {
    const c = text.charCodeAt(k);
    if (c < 128) n++;
    else {
      plain = false;
      const cp = text.codePointAt(k);
      const ch = String.fromCodePoint(cp);
      n += foldChar(ch).length;
      if (cp > 0xffff) k++;
    }
  }
  if (plain) {
    // nothing but ASCII: folding keeps every offset
    const hay = text.toLowerCase();
    for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + (overlap ? 1 : needle.length))) fn(at, at + needle.length);
    return;
  }
  const from = new Int32Array(n + 1); // folded unit -> offset in text of the character it came from
  const head = new Uint8Array(n + 1); // 1 when it is the first unit of its character's folding
  const parts = [];
  let chunk = "";
  let u = 0;
  for (let k = 0; k < text.length; ) {
    const c = text.charCodeAt(k);
    let f;
    let w = 1;
    if (c < 128) f = c >= 65 && c <= 90 ? String.fromCharCode(c + 32) : text[k];
    else {
      const cp = text.codePointAt(k);
      w = cp > 0xffff ? 2 : 1;
      f = foldChar(text.slice(k, k + w));
    }
    for (let j = 0; j < f.length; j++) (from[u] = k), (head[u] = j === 0 ? 1 : 0), u++;
    chunk += f;
    if (chunk.length > 65536) (parts.push(chunk), (chunk = ""));
    k += w;
  }
  parts.push(chunk);
  from[n] = text.length;
  head[n] = 1;
  const hay = parts.join("");
  for (let at = hay.indexOf(needle); at >= 0; ) {
    const end = at + needle.length;
    if (head[at] && head[end]) {
      fn(from[at], from[end]);
      at = hay.indexOf(needle, overlap ? at + 1 : end);
    } else at = hay.indexOf(needle, at + 1);
  }
}

/** Non-overlapping matches of `find` in `text` as [{start, end}] (eachMatch's rule). */
export function findRanges(text, find, matchCase = true) {
  const out = [];
  eachMatch(text, find, matchCase, (start, end) => out.push({ start, end }));
  return out;
}

/** How many places `find` occurs at when a match may begin inside the one before ("ana" in "banana": 2, findRanges reports 1). */
export function countOverlapping(text, find, matchCase = true) {
  let n = 0;
  eachMatch(text, find, matchCase, () => n++, true);
  return n;
}

/**
 * B1 (refuse, not guess): a reply bound to a comment's anchor, with neither "occurrence" nor "all", where the scan reports one match
 * but `find` occurs at more places that overlap it ("banana", the last "ana" selected). The single match is the first copy, which may
 * not be the one the comment points at, and the anchor's offsets are not trusted to choose (stale after typing; the PowerPoint reader
 * gives the first copy's). Returns the refusal reason, or null when the op runs as before. `n` is how many matches findRanges reported
 * over all of `texts`. Ceiling: one more scan of the target's text, only when exactly one match was reported.
 */
export function overlapRefusal(texts, find, matchCase, n, op) {
  if (n !== 1 || op.all || op.occurrence || !op.target || !("anchor_id" in op.target)) return null;
  let total = 0;
  for (const t of texts) total += countOverlapping(t, find, matchCase);
  if (total <= 1) return null;
  return `the text to find occurs ${total} times in the target, overlapping each other, so the change might land on a copy the comment does not point at; nothing was changed. Give a longer "find" that occurs only once`;
}

/** Start offsets of the matches findRanges reports. */
export const findAll = (text, find, matchCase = true) => findRanges(text, find, matchCase).map((r) => r.start);

const WORD = /[\p{L}\p{N}]/u;
const WORDY = new Map(); // a code point -> is it a letter or digit (each distinct one tested once)
const wordAt = (text, k) => {
  if (k < 0 || k >= text.length) return false;
  const cp = text.codePointAt(k);
  let w = WORDY.get(cp);
  if (w === undefined) WORDY.set(cp, (w = WORD.test(String.fromCodePoint(cp))));
  return w;
};
/** The code point that ends right before offset k (a surrogate pair read whole), as an offset where it starts; -1 at the start. */
const before = (text, k) => (k <= 0 ? -1 : k >= 2 && /[\udc00-\udfff]/.test(text[k - 1]) && /[\ud800-\udbff]/.test(text[k - 2]) ? k - 2 : k - 1);
/** Does a match [start, end) touch a letter or digit on either side (part of a longer word, "he" in "the")? */
const partial = (text, start, end) => wordAt(text, before(text, start)) || wordAt(text, end);

/** How many matches of `find` in `text` touch a letter or digit on either side. Same matches as findRanges, no record per match. */
export function partialWords(text, find, matchCase = true) {
  return countMatches(text, find, matchCase).partial;
}

/** {n, partial}: how many matches findRanges reports, and how many of them touch a letter or digit. One pass, no record per match. */
export function countMatches(text, find, matchCase = true) {
  let n = 0;
  let p = 0;
  eachMatch(text, find, matchCase, (start, end) => {
    n++;
    if (partial(text, start, end)) p++;
  });
  return { n, partial: p };
}

/** [{start, end}] sorted by start, from match starts and their length (one number for all, or one per start). */
export function rangesOf(starts, len) {
  return starts.map((start, i) => ({ start, end: start + (Array.isArray(len) ? len[i] : len) })).sort((a, b) => a.start - b.start);
}

/** Picks the matches an op addresses: all, the nth (1-based), or the only one. Returns {starts} or {error}. */
export function pickMatches(starts, { occurrence, all }) {
  if (!starts.length) return { error: "the text to find does not occur in the target" };
  if (all) return { starts };
  if (occurrence) return occurrence <= starts.length ? { starts: [starts[occurrence - 1]] } : { error: `occurrence ${occurrence} requested but the text occurs ${starts.length} time(s)` };
  if (starts.length > 1) return { error: `ambiguous: the text occurs ${starts.length} times; give "occurrence" or "all"` };
  return { starts };
}

/** Replaces [s,e) of the visible text with `replacement`, keeping the formatting of the run the range starts in. Throws RangeError if it crosses an object. */
export function replaceRange(runs, s, e, replacement) {
  const { segs } = layout(runs);
  const hit = segs.filter((g) => g.end > s && g.start < e);
  if (!hit.length || hit.some((g) => !g.text)) throw new RangeError("the range crosses an image or other object");
  const out = runs.map((r) => ({ ...r }));
  const first = hit[0];
  const last = hit[hit.length - 1];
  const head = out[first.i].text.slice(0, s - first.start);
  const tail = out[last.i].text.slice(e - last.start);
  for (const g of hit) out[g.i].text = "";
  out[first.i].text = head + replacement + (first === last ? tail : "");
  if (first !== last) out[last.i].text = tail;
  return dropEmpty(out, first.i);
}

/**
 * replaceRange for every match at once: `starts` (non-overlapping, as findAll gives them) of `len` characters each (one number, or one
 * length per start, as findRanges reports them) become `replacement`.
 * The same result as replaceRange applied right to left, in one pass over the runs (that was a pass per match: a paragraph of 130,000
 * runs matched in each held the server's thread for minutes). Throws RangeError if a match crosses an object or meets no run.
 */
export function replaceRanges(runs, starts, len, replacement) {
  if (!starts.length) return runs;
  const at = rangesOf(starts, len);
  const { segs } = layout(runs);
  const cuts = new Map(); // run index -> [{from, to, put}] in order
  let g = 0;
  let keep = -1;
  for (const [k, { start: s, end: e }] of at.entries()) {
    while (g < segs.length && segs[g].end <= s) g++;
    let first = true;
    for (let h = g; h < segs.length && segs[h].start < e; h++) {
      const seg = segs[h];
      if (!seg.text) throw new RangeError("the range crosses an image or other object");
      (cuts.get(seg.i) || cuts.set(seg.i, []).get(seg.i)).push({ from: Math.max(s, seg.start) - seg.start, to: Math.min(e, seg.end) - seg.start, put: first ? replacement : "" });
      if (first && k === 0) keep = seg.i;
      first = false;
    }
    if (first) throw new RangeError("the range crosses an image or other object");
  }
  const out = runs.map((r, i) => {
    const list = cuts.get(i);
    if (!list) return { ...r };
    let text = "";
    let cur = 0;
    for (const c of list) (text += r.text.slice(cur, c.from) + c.put), (cur = c.to);
    return { ...r, text: text + r.text.slice(cur) };
  });
  return dropEmpty(out, keep);
}

/** Removes emptied text runs, but keeps `keep` if nothing else would carry the paragraph. */
function dropEmpty(runs, keep) {
  const res = runs.filter((r, i) => !(isText(r) && isVisible(r) && r.text === "" && i !== keep));
  return res;
}

/** Splits runs at the ends of [s,e) so the range is covered by whole runs. Returns {runs, covered:[indexes in new runs]}. */
export function splitForRange(runs, s, e) {
  const out = [];
  const covered = [];
  let pos = 0;
  for (const r of runs) {
    if (!isVisible(r)) {
      out.push(r);
      continue;
    }
    const len = isText(r) ? r.text.length : 1;
    const a = pos;
    const b = pos + len;
    pos = b;
    if (b <= s || a >= e || !isText(r)) {
      if (!isText(r) && b > s && a < e) covered.push(out.length); // objects inside the range are covered whole
      out.push(r);
      continue;
    }
    const from = Math.max(s, a) - a;
    const to = Math.min(e, b) - a;
    for (const [t, inside] of [[r.text.slice(0, from), false], [r.text.slice(from, to), true], [r.text.slice(to), false]]) {
      if (!t) continue;
      if (inside) covered.push(out.length);
      out.push({ ...r, text: t });
    }
  }
  return { runs: out, covered };
}

/**
 * splitForRange for several ranges at once: `ranges` [{start, end}] sorted and not overlapping. Returns {runs, covered: [indexes in
 * the new runs, per range]}, the same runs as splitting for each range in turn, in one pass (a pass per range was quadratic).
 * Null when a range is empty, or the ranges overlap or are out of order (the caller then splits one range at a time).
 */
export function splitForRanges(runs, ranges) {
  for (let k = 0; k < ranges.length; k++) if (!(ranges[k].start < ranges[k].end) || (k && ranges[k].start < ranges[k - 1].end)) return null;
  const out = [];
  const covered = ranges.map(() => []);
  let pos = 0;
  let k = 0;
  for (const r of runs) {
    if (!isVisible(r)) {
      out.push(r);
      continue;
    }
    const len = isText(r) ? r.text.length : 1;
    const a = pos;
    const b = pos + len;
    pos = b;
    while (k < ranges.length && ranges[k].end <= a) k++;
    let hit = false;
    let cur = 0;
    for (let j = k; j < ranges.length && ranges[j].start < b; j++) {
      const { start: s, end: e } = ranges[j];
      if (e <= a) continue;
      if (!isText(r)) {
        covered[j].push(out.length); // objects inside the range are covered whole
        continue;
      }
      hit = true;
      const from = Math.max(s, a) - a;
      const to = Math.min(e, b) - a;
      if (from > cur) out.push({ ...r, text: r.text.slice(cur, from) });
      if (to > from) {
        covered[j].push(out.length);
        out.push({ ...r, text: r.text.slice(from, to) });
      }
      cur = to;
    }
    if (!hit) out.push(r);
    else if (cur < len) out.push({ ...r, text: r.text.slice(cur) });
  }
  return { runs: out, covered };
}

/** Merges a run-property patch into the `d` (direct formatting) of the covered text runs. */
export function applySet(runs, covered, patch) {
  const at = new Set(covered); // includes() per run was quadratic on a paragraph of many runs
  return runs.map((r, i) => (at.has(i) && isText(r) ? { ...r, d: { ...(r.d || {}), ...patch } } : r));
}

/** applySet for several ranges at once: `covered` from splitForRanges, `patches` one per range. */
export function applySets(runs, covered, patches) {
  const at = new Map();
  covered.forEach((list, j) => list.forEach((i) => at.set(i, { ...(at.get(i) || {}), ...patches[j] })));
  return runs.map((r, i) => (at.has(i) && isText(r) ? { ...r, d: { ...(r.d || {}), ...at.get(i) } } : r));
}

/** Sets the text of a whole paragraph: the first visible text run carries it, the other visible text runs go. Objects stay where they are (callers refuse those). */
export function setAllText(runs, text) {
  const out = runs.map((r) => ({ ...r }));
  let placed = false;
  const kept = [];
  for (const r of out) {
    if (isText(r) && isVisible(r)) {
      if (!placed) {
        r.text = text;
        placed = true;
        kept.push(r);
      }
    } else kept.push(r);
  }
  if (!placed) kept.push({ t: "text", text, s: {} });
  return kept;
}

export const hasObjects = (runs) => runs.some((r) => isVisible(r) && !isText(r));
