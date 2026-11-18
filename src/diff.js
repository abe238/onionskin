// A small word-level text diff for the History sidebar. No dependencies, pure functions.
//
// diffText(a, b) -> { ops, level }                         the text changed; level is "word" or "sentence"
//                 | { identical: true, ops: [] }           the same string
//                 | { formatting_only: true, ops: [] }     only whitespace differs
//                 | { too_large: true }                    more than HARD_CAP_TOKENS on one side: nothing is computed
// ops are compact: ["=", text] unchanged (trimmed to CONTEXT_WORDS words on each side of a change), ["-", text] removed,
// ["+", text] added, ["…"] where unchanged text was left out. Concatenating the "=" and "-" texts (and "…" as nothing) gives the old
// text; "=" and "+" the new one, apart from the trimmed parts. Callers pass text that was already sanitized: ops are slices of it.
//
// Ceilings: Myers O(ND) with D <= MAX_D, so a pair that differs in more than MAX_D tokens is reported as one removed + one added block.
// A changed middle over WORD_LIMIT tokens on either side is diffed by sentence first, and each changed sentence block is refined by
// word only when it is small. Tokens are words, whitespace runs, single punctuation marks, and single CJK characters.

const CONTEXT_WORDS = 6;
const WORD_LIMIT = 2000;
export const HARD_CAP_TOKENS = 60_000;
const MAX_D = 2000;
const CJK = "\\p{Script=Han}|\\p{Script=Hiragana}|\\p{Script=Katakana}";
// a word is at most 4,096 characters a token (a longer one is several): an unbounded repeat over a run of 7.9 million combining marks
// overflowed the regex stack ("Maximum call stack size exceeded")
const TOKEN = new RegExp(`(?:${CJK})|(?:(?!${CJK})[\\p{L}\\p{N}\\p{M}]){1,4096}(?:['’](?:(?!${CJK})[\\p{L}\\p{N}\\p{M}]){1,4096})*|\\s+|[^\\s]`, "gu");
const IS_WORD = new RegExp(`^(?:${CJK}|[\\p{L}\\p{N}\\p{M}])`, "u");
const IS_CJK = new RegExp(`^(?:${CJK})$`, "u");
const SENTENCE = /[^.!?。！？\n]*(?:[.!?。！？]+|\n|$)\s*/gu;

export const tokenize = (s) => s.match(TOKEN) || [];
const sentences = (s) => (s.match(SENTENCE) || []).filter(Boolean);

/** Myers shortest edit script over two token arrays: [["=", i, j] ... ] collapsed to runs {t, a0, a1, b0, b1}; null when D exceeds maxD. */
function myers(a, b, maxD) {
  const n = a.length;
  const m = b.length;
  const off = maxD + 1;
  const v = new Int32Array(2 * maxD + 3);
  const trace = [];
  let found = -1;
  for (let d = 0; d <= maxD && found < 0; d++) {
    trace.push(v.slice(off - d, off + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) (x++, y++);
      v[off + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
  }
  if (found < 0) return null;
  const edits = []; // reversed: "=", "-" (a index) or "+" (b index)
  let x = n;
  let y = m;
  for (let d = found; d >= 0; d--) {
    const vv = trace[d];
    const k = x - y;
    let prevK;
    if (d === 0) prevK = 0;
    else prevK = k === -d || (k !== d && vv[k - 1 + d] < vv[k + 1 + d]) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : vv[prevK + d];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      edits.push(["=", x - 1, y - 1]);
      x--;
      y--;
    }
    if (d > 0) {
      if (prevK === k + 1) edits.push(["+", -1, prevY]);
      else edits.push(["-", prevX, -1]);
      x = prevX;
      y = prevY;
    }
  }
  return edits.reverse();
}

/** Token arrays -> raw ops [[type, text]] (adjacent equal types merged). Common prefix and suffix are cut first: they cost nothing. */
function diffTokens(a, b) {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const A = a.slice(p, a.length - s);
  const B = b.slice(p, b.length - s);
  const out = [];
  const push = (t, text) => {
    if (!text) return;
    if (out.length && out[out.length - 1][0] === t) out[out.length - 1][1] += text;
    else out.push([t, text]);
  };
  push("=", a.slice(0, p).join(""));
  if (A.length || B.length) {
    const script = A.length && B.length ? myers(A, B, MAX_D) : null;
    if (!script) {
      push("-", A.join(""));
      push("+", B.join(""));
    } else {
      // within one change block deletions come before insertions
      let dels = "";
      let ins = "";
      const flush = () => {
        push("-", dels);
        push("+", ins);
        dels = ins = "";
      };
      for (const [t, i, j] of script) {
        if (t === "-") dels += A[i];
        else if (t === "+") ins += B[j];
        else (flush(), push("=", A[i]));
      }
      flush();
    }
  }
  push("=", a.slice(a.length - s).join(""));
  return out;
}

/** Sentence-level diff; a changed block (removed + added run) is refined by word when both sides are small. */
function diffSentences(a, b) {
  const sa = sentences(a);
  const sb = sentences(b);
  const raw = diffTokens(sa, sb);
  const out = [];
  let coarse = false;
  for (let i = 0; i < raw.length; i++) {
    const cur = raw[i];
    const next = raw[i + 1];
    if (cur[0] === "-" && next?.[0] === "+") {
      const ta = tokenize(cur[1]);
      const tb = tokenize(next[1]);
      if (ta.length <= WORD_LIMIT && tb.length <= WORD_LIMIT) out.push(...diffTokens(ta, tb));
      else (out.push(cur, next), (coarse = true));
      i++;
    } else {
      if (cur[0] !== "=") coarse = true;
      out.push(cur);
    }
  }
  return { raw: out, coarse };
}

const wordWeight = (tok) => (IS_CJK.test(tok) ? 1 / 3 : IS_WORD.test(tok) ? 1 : 0);

/** The last (or first) `n` words' worth of tokens of an unchanged run. */
function edge(text, n, fromEnd) {
  const toks = tokenize(text);
  let w = 0;
  let i = fromEnd ? toks.length : 0;
  while (fromEnd ? i > 0 : i < toks.length) {
    const t = toks[fromEnd ? i - 1 : i];
    const nw = w + wordWeight(t);
    if (nw > n) break;
    w = nw;
    i += fromEnd ? -1 : 1;
  }
  return fromEnd ? { kept: toks.slice(i).join(""), cut: i > 0 } : { kept: toks.slice(0, i).join(""), cut: i < toks.length };
}

/** Merge a lone whitespace "=" between two changes into both sides, so "a b" -> "c d" reads as one replaced phrase. */
function mergeChanges(raw) {
  let ops = raw.map((o) => [o[0], o[1]]);
  // pass 2: [change][whitespace =][change]  ->  one block with the whitespace on both sides
  let again = true;
  while (again) {
    again = false;
    const res = [];
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      if (op[0] === "=" && /^\s+$/.test(op[1]) && res.length && res[res.length - 1][0] !== "=" && ops[i + 1] && ops[i + 1][0] !== "=") {
        res.push(["-", op[1]], ["+", op[1]]);
        again = true;
      } else res.push(op);
    }
    ops = res;
  }
  // group every change block into one "-" run followed by one "+" run
  const grouped = [];
  for (let i = 0; i < ops.length; ) {
    if (ops[i][0] === "=") {
      grouped.push(ops[i++]);
      continue;
    }
    let del = "";
    let add = "";
    while (i < ops.length && ops[i][0] !== "=") {
      if (ops[i][0] === "-") del += ops[i][1];
      else add += ops[i][1];
      i++;
    }
    if (del) grouped.push(["-", del]);
    if (add) grouped.push(["+", add]);
  }
  return grouped;
}

/** Keep at most `context` words of unchanged text next to a change; the rest becomes ["…"]. */
function trim(ops, context) {
  const out = [];
  ops.forEach((op, i) => {
    if (op[0] !== "=") return out.push(op);
    const first = i === 0;
    const last = i === ops.length - 1;
    const total = tokenize(op[1]).reduce((w, t) => w + wordWeight(t), 0);
    if (total <= (first || last ? context : context * 2)) return out.push(op);
    // the cut side loses its whitespace: the ellipsis stands where the text was left out
    if (first) out.push(["…"], ["=", edge(op[1], context, true).kept.trimStart()]);
    else if (last) out.push(["=", edge(op[1], context, false).kept.trimEnd()], ["…"]);
    else out.push(["=", edge(op[1], context, false).kept.trimEnd()], ["…"], ["=", edge(op[1], context, true).kept.trimStart()]);
  });
  return out;
}

export function diffText(a, b, { context = CONTEXT_WORDS } = {}) {
  a = String(a ?? "");
  b = String(b ?? "");
  if (a === b) return { identical: true, ops: [] };
  if (a.replace(/\s+/g, "") === b.replace(/\s+/g, "")) return { formatting_only: true, ops: [] };
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.length > HARD_CAP_TOKENS || tb.length > HARD_CAP_TOKENS) return { too_large: true };
  let p = 0;
  while (p < ta.length && p < tb.length && ta[p] === tb[p]) p++;
  let s = 0;
  while (s < ta.length - p && s < tb.length - p && ta[ta.length - 1 - s] === tb[tb.length - 1 - s]) s++;
  const middle = Math.max(ta.length - p - s, tb.length - p - s);
  let raw;
  let level = "word";
  if (middle > WORD_LIMIT) {
    const r = diffSentences(a, b);
    raw = r.raw;
    level = "sentence";
  } else raw = diffTokens(ta, tb);
  return { ops: trim(mergeChanges(raw), context), level };
}


/**
 * The full edit script between two raw strings, for rebuilding both sides (the tracked-changes copy): nothing is trimmed, sanitized or
 * skipped. Returns [[type, text]] with types "=", "-", "+": the "=" and "-" texts concatenated give `a` exactly, "=" and "+" give `b`.
 * Same tokenizer and change grouping as diffText; a changed middle over WORD_LIMIT tokens goes by sentence first; past HARD_CAP_TOKENS,
 * or when Myers gives up (MAX_D), the changed middle is one removal plus one addition.
 */
export function diffRaw(a, b) {
  a = String(a ?? "");
  b = String(b ?? "");
  if (a === b) return a ? [["=", a]] : [];
  const ta = tokenize(a);
  const tb = tokenize(b);
  let raw;
  if (ta.length > HARD_CAP_TOKENS || tb.length > HARD_CAP_TOKENS) {
    let p = 0;
    while (p < a.length && p < b.length && a[p] === b[p]) p++;
    let s = 0;
    while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
    raw = [["=", a.slice(0, p)], ["-", a.slice(p, a.length - s)], ["+", b.slice(p, b.length - s)], ["=", a.slice(a.length - s)]].filter((o) => o[1]);
  } else {
    let p = 0;
    while (p < ta.length && p < tb.length && ta[p] === tb[p]) p++;
    let s = 0;
    while (s < ta.length - p && s < tb.length - p && ta[ta.length - 1 - s] === tb[tb.length - 1 - s]) s++;
    raw = Math.max(ta.length - p - s, tb.length - p - s) > WORD_LIMIT ? diffSentences(a, b).raw : diffTokens(ta, tb);
  }
  const ops = mergeChanges(raw);
  // the tokenizer covers every character, but a rebuild that does not give both sides back exactly must never be used
  const side = (keep) => ops.filter((o) => o[0] === "=" || o[0] === keep).map((o) => o[1]).join("");
  if (side("-") !== a || side("+") !== b) return [["-", a], ["+", b]].filter((o) => o[1]);
  return ops;
}
