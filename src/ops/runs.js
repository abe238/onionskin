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

/** Non-overlapping start offsets of `find` in `text`. */
export function findAll(text, find, matchCase = true) {
  const hay = matchCase ? text : text.toLowerCase();
  const needle = matchCase ? find : find.toLowerCase();
  const out = [];
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + needle.length)) out.push(at);
  return out;
}

const WORD = /[\p{L}\p{N}]/u;
/** How many matches of `find` in `text` touch a letter or digit on either side (part of a longer word, "he" in "the"). Same matches as findAll. */
export function partialWords(text, find, matchCase = true) {
  let n = 0;
  for (const at of findAll(text, find, matchCase)) {
    const before = [...text.slice(Math.max(0, at - 2), at)].pop();
    const after = [...text.slice(at + find.length, at + find.length + 2)][0];
    if ((before && WORD.test(before)) || (after && WORD.test(after))) n++;
  }
  return n;
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

/** Merges a run-property patch into the `d` (direct formatting) of the covered text runs. */
export function applySet(runs, covered, patch) {
  return runs.map((r, i) => (covered.includes(i) && isText(r) ? { ...r, d: { ...(r.d || {}), ...patch } } : r));
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
