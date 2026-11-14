// Samples of the person's writing for "Build my voice guide" (stage 2). Pure: nothing here reads or writes a file.
//
// The agent gets a sample of each writing source the person picked, never a whole document: a long file is cut down by a fixed,
// deterministic rule (the same input always gives the same sample), paragraphs an agent wrote are left out of the open file, and the
// whole printed batch is kept under a budget so it fits in an agent's shell output. Every text that leaves here went through
// `untrusted()` (no control or bidi characters, one line, capped) and carries no file name or path: it is quoted data for the agent, never
// an instruction, and the person reads whatever the agent makes of it before anything is saved.
import { env } from "./constants.js";
import { untrusted } from "./sanitize.js";
import { normText, similarity, textHash } from "./text.js";

/** The printed batch (`onionskin poll` pretty-prints it) must stay at or under this many characters. Assumed shell output limit: about 30,000. */
export const VOICE_BATCH_MAX_CHARS = 28_000;
export const voiceBatchMax = () => Number(env("VOICE_BATCH_MAX_CHARS", VOICE_BATCH_MAX_CHARS));
export const PARA_MAX = 1200; // characters per sampled paragraph
export const SLIDE_TEXT_MAX = 600; // characters per slide title or shape text
export const REQUEST_MAX = 300; // characters per typed comment
export const MAX_REWRITES = 20;
export const MAX_REQUESTS = 30;
export const REWRITES_SHARE = 6000;
export const REQUESTS_SHARE = 2000;
export const SOURCE_MIN_SHARE = 2000;
export const AGENT_TEXTS_MAX = 500; // agent paragraphs compared by similarity (the hash check has no cap)
export const AGENT_SIMILAR = 0.5;
const OPEN_N = 3;
const CLOSE_N = 2;
const HEADINGS_N = 8;
const LIST_N = 6;
const MIN_WORDS = 4; // a body paragraph shorter than this says little about how someone writes
// What one sampled paragraph costs in the pretty-printed batch beyond its JSON string: indentation at its depth, the keys, the commas.
// An estimate for the shares; budget() measures the real thing.
const ITEM_OVERHEAD = 80;
const OBJ = new RegExp("\\uFFFC", "g"); // an inline picture's placeholder in DOCX text
const HEADING_STYLE = /heading|title/i;
const SKIP_PLACEHOLDERS = new Set(["sldNum", "dt", "ftr", "hdr"]);

const segmenter = new Intl.Segmenter("und", { granularity: "word" });
/** Words in any script (a CJK paragraph is many words, not one). */
export function wordCount(s) {
  let n = 0;
  for (const seg of segmenter.segment(s)) if (seg.isWordLike) n++;
  return n;
}

/** Every index of 0..n-1 once, spread evenly: first, last, middle, then the quarters, and so on. Deterministic. */
export function spreadOrder(n) {
  const out = [];
  if (n <= 0) return out;
  const seen = new Uint8Array(n);
  const add = (i) => {
    if (!seen[i]) (seen[i] = 1), out.push(i);
  };
  add(0);
  for (let parts = 1; out.length < n; parts *= 2) for (let j = 0; j <= parts; j++) add(Math.round((j * (n - 1)) / parts));
  return out;
}

/** `n` of `list`, evenly spaced, in order (all of it when n >= its length). */
export function evenPick(list, n) {
  if (n >= list.length) return [...list];
  if (n <= 0) return [];
  if (n === 1) return [list[0]];
  const out = [];
  for (let j = 0; j < n; j++) {
    const x = list[Math.round((j * (list.length - 1)) / (n - 1))];
    if (out[out.length - 1] !== x) out.push(x);
  }
  return out;
}

const cost = (t) => JSON.stringify(t).length + ITEM_OVERHEAD;

/**
 * The fixed rule over a source's candidate units [{k: "h"|"li"|"p", t}] (already filtered, deduplicated, agent text left out): the first
 * 3 body paragraphs ("open"), the last 2 ("close"), up to 8 headings and up to 6 list items (evenly spaced), then body paragraphs spread
 * evenly, each taken only while it fits in `share` characters. Output in document order, with the count of candidates and of samples.
 */
function pick(units, share) {
  const items = units.map((u, i) => ({ i, k: u.k, t: untrusted(u.t, u.max ?? PARA_MAX) })).filter((u) => u.t);
  const body = items.filter((u) => u.k === "p").map((u) => u.i);
  const open = body.slice(0, OPEN_N);
  const close = body.slice(Math.max(OPEN_N, body.length - CLOSE_N));
  const rest = body.slice(OPEN_N, Math.max(OPEN_N, body.length - CLOSE_N));
  const label = new Map([...open.map((i) => [i, "open"]), ...close.map((i) => [i, "close"])]);
  const order = [
    ...open,
    ...close,
    ...evenPick(items.filter((u) => u.k === "h").map((u) => u.i), HEADINGS_N),
    ...evenPick(items.filter((u) => u.k === "li").map((u) => u.i), LIST_N),
    ...spreadOrder(rest.length).map((j) => rest[j]),
  ];
  const byIndex = new Map(items.map((u) => [u.i, u]));
  const chosen = new Set();
  let used = 0;
  for (const i of order) {
    const c = cost(byIndex.get(i).t);
    if (used + c > share) continue;
    used += c;
    chosen.add(i);
  }
  const paragraphs = items.filter((u) => chosen.has(u.i)).map((u) => ({ k: label.get(u.i) || u.k, t: u.t }));
  return { total: items.length, sampled: paragraphs.length, paragraphs };
}

/** Drops empty, duplicate (by textHash) and agent-written units, in that order, keeping the first of each text. */
function distinct(units, exclude) {
  const seen = new Set();
  const out = [];
  for (const u of units) {
    if (!normText(u.t)) continue;
    const h = textHash(u.t);
    if (seen.has(h)) continue;
    seen.add(h);
    if (exclude && isAgentText(u.t, exclude)) continue;
    out.push(u);
  }
  return out;
}

/**
 * A sample of a Word document. `paras` from readDocxParagraphs(bytes, {detail: true}) (src/docx.js). Left out: protected paragraphs,
 * paragraphs in tables (and nested tables), empty ones, body paragraphs under 4 words, repeats, and, with `exclude` (from agentTexts),
 * paragraphs an agent wrote. A heading is a paragraph whose style name (or id) says heading or title; a list item has a list.
 */
export function sampleDocx(paras, share, { exclude = null } = {}) {
  const units = [];
  for (const p of Array.isArray(paras) ? paras : []) {
    if (!p || p.protected || !Array.isArray(p.path) || p.path.length !== 1 || typeof p.text !== "string") continue;
    const t = p.text.replace(OBJ, " ");
    const k = HEADING_STYLE.test(p.styleName || p.style || "") ? "h" : p.list ? "li" : "p";
    if (k === "p" && wordCount(normText(t)) < MIN_WORDS) continue;
    units.push({ k, t });
  }
  return pick(distinct(units, exclude), share);
}

/**
 * A sample of a PowerPoint deck from parseDeck(bytes) (src/pptx.js): slides spread evenly, each slide's title and the text of its other
 * text shapes (no tables, slide numbers, dates, headers or footers), at most 600 characters each, while they fit in `share`. With
 * `exclude`, text an agent wrote is left out.
 */
export function samplePptx(deck, share, { exclude = null } = {}) {
  deck.ensure();
  const slides = deck.slides.map((s) => {
    const units = [];
    if (s.title) units.push({ k: "h", t: s.title, max: SLIDE_TEXT_MAX });
    for (const sh of s.shapes || []) {
      if (sh.isTitle || sh.kind !== "shape" || SKIP_PLACEHOLDERS.has(sh.placeholder)) continue;
      units.push({ k: "p", t: sh.text, max: SLIDE_TEXT_MAX });
    }
    return units;
  });
  // repeats and agent text are dropped across the whole deck, then whole slides are taken in an even spread
  const seen = new Set();
  const kept = slides.map((units) =>
    units.filter((u) => {
      if (!normText(u.t)) return false;
      const h = textHash(u.t);
      if (seen.has(h)) return false;
      seen.add(h);
      return !(exclude && isAgentText(u.t, exclude));
    })
  );
  const flat = kept.flatMap((units, s) => units.map((u) => ({ ...u, s, t: untrusted(u.t, SLIDE_TEXT_MAX) }))).filter((u) => u.t);
  const chosen = new Set();
  let used = 0;
  for (const s of spreadOrder(kept.length)) {
    for (const u of flat.filter((x) => x.s === s)) {
      const c = cost(u.t);
      if (used + c > share) continue;
      used += c;
      chosen.add(u);
    }
  }
  const paragraphs = flat.filter((u) => chosen.has(u)).map((u) => ({ k: u.k, t: u.t }));
  return { total: flat.length, sampled: paragraphs.length, paragraphs };
}

const LIST_LINE = /^\s*(?:[-*+•]|\d{1,3}[.)])\s+(?=\S)/u;
const MD_HEADING = /^#{1,6}\s+(?=\S)/u;
/**
 * A sample of pasted text or a .txt or .md file: split on blank lines; a one-line block starting with "#" is a heading, a block whose
 * every line starts with a list marker gives one list item per line; everything else is a body paragraph. Then the same rule as Word.
 */
export function sampleText(str, share) {
  const units = [];
  for (const block of String(str ?? "").replace(/\r\n?/g, "\n").split(/\n[ \t]*\n/)) {
    const lines = block.split("\n").filter((l) => l.trim());
    if (!lines.length) continue;
    if (lines.length === 1 && MD_HEADING.test(lines[0])) units.push({ k: "h", t: lines[0].replace(MD_HEADING, "") });
    else if (lines.every((l) => LIST_LINE.test(l))) for (const l of lines) units.push({ k: "li", t: l.replace(LIST_LINE, "") });
    else if (wordCount(normText(lines.join(" "))) >= MIN_WORDS) units.push({ k: "p", t: lines.join(" ") });
  }
  return pick(distinct(units, null), share);
}

/**
 * What agents wrote in a file, from its stored version pairs: for each agent or local run whose two versions are both still stored,
 * `before` and `after` are the paragraph (or shape) texts of the two versions. A paragraph of `after` whose hash is not in `before` was
 * written by the run. Returns {hashes, texts}: every such hash, and the newest 500 texts for the similarity check.
 * Ceiling: text an agent wrote in a run whose versions were pruned, or text pasted in from elsewhere, is not known here.
 */
export function agentTexts(pairs) {
  const hashes = new Set();
  const texts = [];
  for (const pair of Array.isArray(pairs) ? pairs : []) {
    if (!pair || !Array.isArray(pair.before) || !Array.isArray(pair.after)) continue;
    const before = new Set(pair.before.map((t) => textHash(t)));
    for (const t of pair.after) {
      if (typeof t !== "string" || !normText(t)) continue;
      const h = textHash(t);
      if (before.has(h) || hashes.has(h)) continue;
      hashes.add(h);
      texts.push(t);
    }
  }
  const kept = texts.slice(-AGENT_TEXTS_MAX);
  return { hashes, texts: kept, lens: kept.map((t) => normText(t).toLowerCase().length) };
}

/**
 * True when a paragraph (text or {text}) is one an agent wrote: its hash is an agent paragraph's, or its similarity to one is at least
 * 0.5 (the person's light edit of agent text is still agent text; a heavy rewrite is theirs). A length check skips pairs whose bigram
 * counts alone keep them under 0.5, so the 500 x 600 worst case stays cheap.
 */
export function isAgentText(p, set) {
  const t = typeof p === "string" ? p : p?.text;
  if (typeof t !== "string" || !set) return false;
  if (set.hashes?.has(textHash(t))) return true;
  const la = normText(t).toLowerCase().length - 1;
  const texts = set.texts || [];
  for (let i = 0; i < texts.length; i++) {
    const lb = (set.lens?.[i] ?? normText(texts[i]).toLowerCase().length) - 1;
    if (la > 0 && lb > 0 && 4 * Math.min(la, lb) < la + lb) continue; // Dice <= 2*min/(la+lb) < 0.5
    if (similarity(t, texts[i]) >= AGENT_SIMILAR) return true;
  }
  return false;
}

/**
 * The person's rewrites of agent text for the agent: the newest of the stored examples ({agent, mine}, oldest first, from
 * src/voice-store.js) up to 20 and `share` characters, oldest first, as {ai, mine}.
 */
export function pickRewrites(examples, share = REWRITES_SHARE) {
  const out = [];
  let used = 0;
  for (const e of [...(Array.isArray(examples) ? examples : [])].reverse()) {
    if (out.length >= MAX_REWRITES) break;
    if (!e || typeof e.agent !== "string" || typeof e.mine !== "string") continue;
    const r = { ai: untrusted(e.agent, PARA_MAX), mine: untrusted(e.mine, PARA_MAX) };
    if (!r.ai || !r.mine) continue;
    const c = JSON.stringify(r).length + ITEM_OVERHEAD;
    if (used + c > share) continue;
    used += c;
    out.unshift(r);
  }
  return out;
}

/** The person's typed comments (newest last; stamp taps already left out by the caller): the newest 30 that fit `share`, in order, each at most 300 characters. */
export function pickRequests(texts, share = REQUESTS_SHARE) {
  const seen = new Set();
  const out = [];
  let used = 0;
  for (const raw of [...(Array.isArray(texts) ? texts : [])].reverse()) {
    if (out.length >= MAX_REQUESTS) break;
    const t = untrusted(raw, REQUEST_MAX);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    const c = cost(t);
    if (used + c > share) continue;
    used += c;
    out.unshift(t);
  }
  return out;
}

/**
 * How the room left in the batch is shared: `fixed` is the printed size of the batch with no evidence, `sources` the number of writing
 * sources. Rewrites get up to 6,000 and typed comments up to 2,000 when chosen; the rest is split evenly across the sources, at least 2,000
 * each (budget() then trims what does not fit).
 */
export function voiceShares({ fixed, sources, rewrites = false, requests = false, max = voiceBatchMax() }) {
  const room = Math.max(0, max - fixed);
  const rw = rewrites ? Math.min(REWRITES_SHARE, room) : 0;
  const rq = requests ? Math.min(REQUESTS_SHARE, Math.max(0, room - rw)) : 0;
  const source = sources > 0 ? Math.max(SOURCE_MIN_SHARE, Math.floor((room - rw - rq) / sources)) : 0;
  return { rewrites: rw, requests: rq, source };
}

// the order paragraphs are given up in when the batch is too big: body first, then list items, headings, closers, openers
const DROP_ORDER = ["p", "li", "h", "close", "open"];

/**
 * Trims `evidence` ({sources: [{paragraphs, sampled, ...}], rewrites, my_requests}) until `measure(evidence)` (the printed size of the
 * whole batch it goes into) is at most `max`. Deterministic: from the source whose paragraphs print largest, evenly spaced paragraphs of
 * the first kind in DROP_ORDER that any source still has; when no source has any left, the oldest rewrite, then the oldest comment.
 * Returns a trimmed copy, or null when even an empty evidence does not fit (then nothing is sent). Never returns an over-budget result.
 */
export function budget(evidence, measure, max = voiceBatchMax()) {
  const e = {
    ...evidence,
    sources: (evidence.sources || []).map((s) => ({ ...s, paragraphs: [...(s.paragraphs || [])] })),
    rewrites: [...(evidence.rewrites || [])],
    my_requests: [...(evidence.my_requests || [])],
  };
  for (;;) {
    const size = measure(e);
    if (size <= max) return e;
    const over = size - max;
    const kind = DROP_ORDER.find((k) => e.sources.some((s) => s.paragraphs.some((p) => p.k === k)));
    if (kind) {
      let best = null;
      let bestSize = -1;
      for (const s of e.sources) {
        if (!s.paragraphs.some((p) => p.k === kind)) continue;
        const n = JSON.stringify(s.paragraphs).length;
        if (n > bestSize) (best = s), (bestSize = n);
      }
      const of = best.paragraphs.filter((p) => p.k === kind);
      const each = of.reduce((n, p) => n + cost(p.t), 0) / of.length;
      const drop = new Set(evenPick(of, Math.min(of.length, Math.max(1, Math.ceil(over / each)))));
      best.paragraphs = best.paragraphs.filter((p) => !drop.has(p));
      best.sampled = best.paragraphs.length;
    } else if (e.rewrites.length) e.rewrites.shift();
    else if (e.my_requests.length) e.my_requests.shift();
    else return null;
  }
}
