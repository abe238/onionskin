// The overall note, joined and merged the same way on the server and in the page (web/src/drafts.js, web/src/stage.js). Pure, no imports.

/** `back`, then `mine` after a blank line, unless every paragraph of `mine` is in `back` already as whole paragraphs (never part of one). */
export function joinNote(back, mine) {
  back = back || "";
  const paras = (x) => x.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const m = paras(mine || "");
  if (!m.length) return back;
  if (`\n\n${paras(back).join("\n\n")}\n\n`.includes(`\n\n${m.join("\n\n")}\n\n`)) return back;
  return back ? `${back}\n\n${mine}` : mine;
}

// Tokens of a note: runs of letters and digits, runs of white space, and each other character on its own.
const tokens = (s) => s.match(/[\p{L}\p{N}\p{M}_]+|\s+|[^\p{L}\p{N}\p{M}_\s]/gu) || [];
// Ceiling of the word diff: a table of this many cells (about 16 MB) at most; a longer changed middle is one change (then the merge falls back).
const DIFF_CELLS = 4_000_000;

/** The changes that make token list `b` from `a`: [{start, end, ins}] in order, `a[start, end)` replaced by the tokens `ins`. */
function changes(a, b) {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const n = a.length - p - s;
  const m = b.length - p - s;
  if (n === 0 && m === 0) return [];
  if (n === 0 || m === 0 || (n + 1) * (m + 1) > DIFF_CELLS) return [{ start: p, end: p + n, ins: b.slice(p, p + m) }];
  // longest common subsequence of the middles, by a table filled from the end
  const w = m + 1;
  const L = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) L[i * w + j] = a[p + i] === b[p + j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
  const out = [];
  let cur = null;
  const flush = () => {
    if (cur) out.push(cur);
    cur = null;
  };
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[p + i] === b[p + j]) {
      flush();
      i++;
      j++;
    } else if (j < m && (i === n || L[i * w + j + 1] >= L[(i + 1) * w + j])) {
      cur ??= { start: p + i, end: p + i, ins: [] };
      cur.ins.push(b[p + j++]);
    } else {
      cur ??= { start: p + i, end: p + i, ins: [] };
      cur.end = p + ++i;
    }
  }
  flush();
  return out;
}

const startsWithTokens = (x, y) => y.length <= x.length && y.every((t, k) => x[k] === t);
const blank = (t) => !t || /^\s/.test(t);

/**
 * The note when one side holds `theirs` and the other `mine`, both from `base`: a three-way merge by words. What `mine` deleted from `base`
 * stays deleted, what `mine` added stays, what `theirs` added (to `base`) is kept, each once; changes of the two sides that do not touch
 * the same words both apply. Where both changed the same words, the merge cannot decide: `mine` is kept whole and the words `theirs` added
 * follow it after a blank line (the caller then holds a note that is not the server's, so it stays unsaved). Both adding at the same place:
 * the same words once; one adding more after the same words (merged before: a second save from the same state) the longer; at the start
 * of `base` the server's first (it only puts returned notes in front: Take back, Stop); anywhere else, undecided as above. Unchanged on
 * either side takes the other; the server emptying the box (a Send took the note) keeps `mine`.
 */
export function mergeNote(base, theirs, mine) {
  base = base || "";
  theirs = theirs || "";
  mine = mine || "";
  if (mine === base || mine === theirs) return theirs;
  if (theirs === base || !theirs) return mine;
  const B = tokens(base);
  const T = tokens(theirs);
  const M = tokens(mine);
  const cm = changes(B, M);
  const ct = changes(B, T);
  const fallback = () => joinNote(mine, ct.map((c) => c.ins.join("").trim()).filter(Boolean).join("\n\n"));
  const out = [];
  let at = 0; // the next token of `base` to copy
  let i = 0;
  let j = 0;
  const take = (c) => {
    for (; at < c.start; at++) out.push(B[at]);
    out.push(...c.ins);
    at = c.end;
  };
  // `x` is all before `y`: it ends before `y` starts, or where `y` starts unless both only insert there
  const before = (x, y) => x.end < y.start || (x.end === y.start && !(x.start === x.end && y.start === y.end));
  while (i < cm.length || j < ct.length) {
    const a = cm[i];
    const b = ct[j];
    if (!b || (a && before(a, b))) {
      take(a);
      i++;
      continue;
    }
    if (!a || before(b, a)) {
      take(b);
      j++;
      continue;
    }
    // both change at the same place
    const same = a.start === b.start && a.end === b.end;
    if (same && a.ins.join("") === b.ins.join("")) take(a);
    else if (same && a.start === a.end && startsWithTokens(b.ins, a.ins)) take(b);
    else if (same && a.start === a.end && startsWithTokens(a.ins, b.ins)) take(a);
    else if (same && a.start === 0 && a.end === 0) take({ start: 0, end: 0, ins: [...b.ins, ...(blank(b.ins.at(-1)) || blank(a.ins[0]) ? [] : ["\n\n"]), ...a.ins] });
    else return fallback();
    i++;
    j++;
  }
  for (; at < B.length; at++) out.push(B[at]);
  let r = out.join("");
  // white space the merge left at an end the person's text does not have there
  if (!/^\s/.test(mine)) r = r.replace(/^\s+/, "");
  if (!/\s$/.test(mine)) r = r.replace(/\s+$/, "");
  return r;
}
