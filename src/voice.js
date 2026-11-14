// Learning on top of Writing preferences, stage 1: code only. Pure functions; nothing here reads or writes a file.
//
// What is learned is a suggestion, never a preference: `suggestions()` returns fixed trait ids from src/style.js and integers, and the
// person turns one on with a tap. No text from a document, an agent or an edit ever leaves this module except through `exampleOf()`,
// whose two sides are untrusted document-derived text for the person to look at (and, only if they tick it, export).
//
// Inputs are parsed paragraphs (readDocxParagraphs in src/docx.js) of three DOCX versions linked through the agent's output:
// pre (before the agent ran), post (what the agent wrote) and mine (what the person sent next).
import { docxFmt, matchParagraphs } from "./history.js";
import { tokenize } from "./diff.js";
import { fmtNote } from "./fmt.js";
import { normText, similarity, textHash } from "./text.js";
import { untrusted } from "./sanitize.js";
import { TRAITS } from "./style.js";

export const MAX_PAIRS = 50; // edit pairs taken from one Send
export const WINDOW = 8; // the last pairs the rules look at
export const HIT_WINDOW = 40; // the last comment hits the rules look at
export const LATER_AFTER = 4; // "Not now" holds until this many new pairs
export const MAX_SUGGESTIONS = 3;
export const EXAMPLE_CAP = 400; // characters per side of an example; longer is refused, never cut
/** The per-pair signals the evidence store keeps (booleans only). */
export const SIGNALS = ["short", "sentences", "exclaim", "restored", "fmt"];
/** Where a suggestion came from. */
export const SOURCES = ["edits", "comments"];
/** Traits a comment phrase can point at. */
export const COMMENT_TRAITS = ["relaxed", "short", "plain", "formal", "minimal"];

const TRAIT_IDS = TRAITS.map((t) => t.id);
const IS_WORD = /^[\p{L}\p{N}\p{M}]/u;
const words = (s) => tokenize(normText(s).toLowerCase()).filter((t) => IS_WORD.test(t));
const SENTENCE = /[^.!?。！？]*(?:[.!?。！？]+|$)/gu;
const sentenceWords = (s) => (normText(s).match(SENTENCE) || []).map((x) => words(x).length).filter((n) => n > 0);
const EXCLAIM = /[!！]/u;

const agentChanged = (a, b) => !a || a.hash !== b.hash || !!fmtNote(docxFmt(a), docxFmt(b));
const personChanged = (b, c) => !c || b.hash !== c.hash || !!fmtNote(docxFmt(b), docxFmt(c));

/**
 * The one-to-one rule for a post paragraph that `out` (post -> other) leaves unlinked. Unlinked post paragraphs are grouped by their linked
 * neighbor before; the other side's unlinked, non-empty paragraphs between the same two linked neighbors belong to that gap. Returns a
 * function of j: the other side's index when the gap is exactly one (non-empty) post paragraph for one other paragraph, -1 when the gap has
 * no other paragraph, undefined when it cannot be told (two for one, neighbors out of order, a paragraph two gaps could claim).
 */
function oneToOne(post, out, back, other) {
  const gapOf = new Int32Array(post.length);
  const gaps = new Map(); // prev linked post index -> {post: [j], other: [k]}
  let prev = -1;
  for (let j = 0; j < post.length; j++) {
    if (out[j] >= 0) prev = j;
    else {
      gapOf[j] = prev;
      (gaps.get(prev) || gaps.set(prev, { post: [], other: [] }).get(prev)).post.push(j);
    }
  }
  for (const g of gaps.values()) {
    const before = g.post[0] - 1;
    let after = g.post[g.post.length - 1] + 1;
    while (after < post.length && out[after] < 0) after++;
    const lo = before >= 0 ? out[before] : -1;
    const hi = after < post.length ? out[after] : other.length;
    // a paragraph between the two linked neighbors, linked to nothing; neighbors out of order (a move) leave the gap ambiguous
    if (hi < lo) g.ambiguous = true;
    else for (let k = lo + 1; k < hi; k++) if (back[k] < 0 && normText(other[k].text)) g.other.push(k);
  }
  // a moved neighbor can make two gaps overlap: a paragraph two gaps could claim belongs to neither
  const claims = new Map();
  for (const g of gaps.values()) for (const k of g.other) claims.set(k, (claims.get(k) || 0) + 1);
  for (const g of gaps.values()) if (g.other.some((k) => claims.get(k) > 1)) g.ambiguous = true;
  return (j) => {
    const g = gaps.get(gapOf[j]);
    if (!g || g.ambiguous) return undefined;
    const postSide = g.post.filter((x) => normText(post[x].text));
    if (g.other.length === 0) return -1;
    if (g.other.length === 1 && postSide.length === 1 && postSide[0] === j) return g.other[0];
    return undefined;
  };
}

/**
 * Pairs of the agent's text and the person's next version of it. A post paragraph counts when the agent added or changed it (text or
 * formatting) against pre AND the person then changed or deleted it. Returns [{pre, agent, mine}] (paragraph objects; `pre` null for a
 * paragraph the agent added or whose old version cannot be told, `mine` null for one the person deleted), at most MAX_PAIRS, in document
 * order.
 *
 * matchParagraphs stops linking two versions below a similarity of 0.3 to 0.6, so a heavy rewrite reads as one removed and one added.
 * That case is paired here only when it is exactly one-to-one between the same two linked neighbors, on both sides: pre -> post gives the
 * old version (anything else leaves `pre` null), post -> mine gives the person's version; a gap with no paragraph left on the person's
 * side is a delete; anything else (two for one, three for two) is skipped, never guessed.
 */
export function editPairs(pre, post, mine) {
  const m1 = matchParagraphs(pre, post);
  const m2 = matchParagraphs(post, mine);
  const oldOf = oneToOne(post, m1.mapB, m1.mapA, pre);
  const mineOf = oneToOne(post, m2.mapA, m2.mapB, mine);
  const out = [];
  for (let j = 0; j < post.length && out.length < MAX_PAIRS; j++) {
    const b = post[j];
    let i = m1.mapB[j];
    if (i < 0) i = oldOf(j) ?? -1;
    const a = i >= 0 ? pre[i] : null;
    if (!a && !normText(b.text)) continue; // an empty paragraph the agent added is not text
    if (!agentChanged(a, b)) continue;
    let k = m2.mapA[j];
    if (k < 0) k = mineOf(j); // -1: the person deleted it
    if (k === undefined) continue;
    const c = k >= 0 ? mine[k] : null;
    if (!personChanged(b, c)) continue;
    out.push({ pre: a, agent: b, mine: c && normText(c.text) ? c : null }); // emptied reads as deleted
  }
  return out;
}

/** {own, total}: the person's words (lowercased, counted as a multiset) and how many of them are not in the agent's version. */
function ownCount(agent, mine) {
  const m = words(mine);
  const bag = new Map();
  for (const w of words(agent)) bag.set(w, (bag.get(w) || 0) + 1);
  let own = 0;
  for (const w of m) {
    const n = bag.get(w) || 0;
    if (n) bag.set(w, n - 1);
    else own++;
  }
  return { own, total: m.length };
}
/** Share of the person's words that are not in the agent's version: 0..1, 0 when the person wrote none. */
export function ownShare(agent, mine) {
  const { own, total } = ownCount(agent, mine);
  return total ? own / total : 0;
}

/** The five booleans kept for one pair. Every rule is language-neutral: word and sentence counts, "!", hashes, formatting. */
export function pairSignals(p) {
  const agent = p.agent.text;
  const mine = p.mine ? p.mine.text : "";
  const wa = words(agent).length;
  const wm = words(mine).length;
  const short = wa > 0 && (!p.mine || wm * 100 <= wa * 85);
  const sa = sentenceWords(agent);
  const sm = p.mine ? sentenceWords(mine) : [];
  // average(mine) <= 0.8 * average(agent), as integers: sum(m) * len(a) * 10 <= sum(a) * len(m) * 8
  const sum = (x) => x.reduce((t, n) => t + n, 0);
  const sentences = sa.length >= 2 && sm.length >= 2 && sum(sm) * sa.length * 10 <= sum(sa) * sm.length * 8;
  const exclaim = !!p.mine && EXCLAIM.test(agent) && !EXCLAIM.test(mine);
  let restored = false;
  if (p.pre && p.mine && p.pre.hash !== p.agent.hash) {
    const sp = similarity(mine, p.pre.text);
    restored = textHash(mine) === textHash(p.pre.text) || (sp >= 0.9 && sp >= similarity(agent, p.pre.text) + 0.1);
  }
  const fmt = !!(p.pre && p.mine) && !!fmtNote(docxFmt(p.pre), docxFmt(p.agent)) && !fmtNote(docxFmt(p.pre), docxFmt(p.mine));
  return { short, sentences, exclaim, restored, fmt };
}

// What untrusted() keeps but a reader cannot see: default-ignorable code points (tag characters, variation selectors, U+206A to U+206F,
// CGJ, soft hyphen, U+180E, the Hangul fillers), format characters, private-use, unassigned and lone surrogate code points.
const INVISIBLE = /[\p{Default_Ignorable_Code_Point}\p{Cf}\p{Co}\p{Cn}\p{Cs}]/u;
// A link, or text that common tools turn into one: a scheme, www., an email or a mention, an HTML entity, a domain with a path. Checked on
// the NFKC form, so full-width letters and punctuation count as their ASCII twins.
const LINK = /:\/\/|www\.|@|&#?[a-z0-9]+;|[\p{L}\p{N}-]+\.\p{L}{2,}\//iu;

/**
 * One side of an example, sanitized with untrusted(), or null when it must be refused (never cleaned or cut): empty, over EXAMPLE_CAP
 * characters, holding a character the person cannot see on the page (it could carry words they never read), or holding a link.
 */
export function exampleSide(text) {
  const s = untrusted(text, Infinity);
  if (!s || [...s].length > EXAMPLE_CAP || INVISIBLE.test(s) || LINK.test(s.normalize("NFKC"))) return null;
  return s;
}
const mostlyOwn = (other, mine) => {
  const { own, total } = ownCount(other, mine);
  return own * 10 >= total * 8; // integers: exactly 0.8 passes
};

const RUN = 4; // words in a row that count as text taken from the document
// the runs of RUN words in a row; a side shorter than RUN is one run of its own
const runsOf = (w) => (w.length < RUN ? (w.length ? [w.join(" ")] : []) : Array.from({ length: w.length - RUN + 1 }, (_, i) => w.slice(i, i + RUN).join(" ")));
/**
 * Every run of RUN words in a row (lowercased) that the given paragraphs hold, for exampleOf. In order, so a long paragraph full of common
 * words does not count against the person's own sentence the way a bag of words would.
 */
export function documentRuns(paragraphs) {
  const out = new Set();
  for (const q of Array.isArray(paragraphs) ? paragraphs : []) for (const r of runsOf(words(untrusted(q?.text, Infinity)))) out.add(r);
  return out;
}
/**
 * At least 80% of the person's words lie outside every run that `runs` holds. A side shorter than RUN words is refused when any run holds
 * it. Ceiling: a short document paragraph inside a longer side, or document text with every fourth word changed, is not seen; the scan of
 * all runs for a short side is linear in the document.
 */
function ownOfRuns(runs, mine) {
  const m = words(mine);
  if (m.length < RUN) {
    const s = ` ${m.join(" ")} `;
    for (const r of runs) if (` ${r} `.includes(s)) return false;
    return true;
  }
  const taken = new Uint8Array(m.length);
  runsOf(m).forEach((r, i) => {
    if (runs.has(r)) taken.fill(1, i, i + RUN);
  });
  const t = taken.reduce((a, b) => a + b, 0);
  return (m.length - t) * 10 >= m.length * 8;
}

/**
 * A before/after example for voice.md, or null. Only a rewrite that is mostly the person's own words: at least 80% of the person's words
 * are not in the agent's version nor in the pre version (counted as a bag of words), and at least 80% lie outside every run of 4 words in a
 * row that `runs` holds (documentRuns() of the pre and post documents), so document or agent text the person put back or moved is never
 * shown as theirs; the person wrote 3 to 80 words and the agent at most 120; each side passes exampleSide() (at most 400 characters,
 * refused never cut, nothing invisible, no link). Without `runs` (a Set) the document cannot be checked, so nothing is an example. Both
 * sides are untrusted document-derived text.
 */
export function exampleOf(p, runs) {
  if (!p.mine || !(runs instanceof Set)) return null;
  const agent = exampleSide(p.agent.text);
  const mine = exampleSide(p.mine.text);
  if (agent == null || mine == null) return null;
  const wm = words(mine).length;
  if (wm < 3 || wm > 80 || words(agent).length > 120) return null;
  if (!mostlyOwn(agent, mine)) return null;
  if (p.pre && !mostlyOwn(untrusted(p.pre.text, Infinity), mine)) return null;
  if (!ownOfRuns(runs, mine)) return null;
  return { agent, mine };
}

// English only, fixed, case-insensitive, whole words. The "less formal" family is matched first and blanked out, so it is never "formal".
const PHRASES = [
  ["relaxed", ["less formal", "more casual", "friendlier", "more relaxed"]],
  ["short", ["shorter", "shorten", "more concise", "too long", "trim"]],
  ["plain", ["simpler", "plainer", "plain words", "plain english", "less jargon"]],
  ["formal", ["more formal", "more professional"]],
  ["minimal", ["keep my wording", "don't rewrite", "do not rewrite", "only change"]],
];
const phraseRe = (ph) => new RegExp(`(?<![\\p{L}\\p{N}])${ph.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+")}(?![\\p{L}\\p{N}])`, "giu");
const PHRASE_RES = PHRASES.map(([trait, list]) => [trait, list.map(phraseRe)]);

/** Trait ids a comment the person typed asks for, each at most once, in COMMENT_TRAITS order. Only the ids are ever stored. */
export function commentHits(text) {
  let s = normText(text).toLowerCase().replace(/[‘’ʼ]/g, "'");
  const out = [];
  for (const [trait, res] of PHRASE_RES) {
    let hit = false;
    for (const re of res) s = s.replace(re, () => ((hit = true), " "));
    if (hit) out.push(trait);
  }
  return out;
}

const EDIT_RULES = [
  // [trait, signal, at least, share of the window (percent, 0 = none)]
  ["short", "short", 4, 60],
  ["short_sentences", "sentences", 4, 60],
  ["no_exclaim", "exclaim", 3, 0],
  ["minimal", "restored", 3, 0],
  ["format", "fmt", 2, 0],
];
const COMMENT_MIN = 3;

/**
 * What to offer the person: [{trait, n, m, source}], at most MAX_SUGGESTIONS, edits first. `trait` is a fixed id from src/style.js,
 * `source` one of SOURCES, `n` and `m` integers (n of the last m edits, or n of the last m comment hits). `evidence` is the stored file
 * and is not trusted: only `=== true` signals count, unknown hit traits are dropped, numbers are recounted here. Nothing is offered that
 * is already on, was answered "never", or was answered "later" (the pair count at the time) fewer than LATER_AFTER new pairs ago.
 */
export function suggestions(evidence, style) {
  const ev = evidence && typeof evidence === "object" ? evidence : {};
  const pairs = Array.isArray(ev.pairs) ? ev.pairs.filter((p) => p && typeof p === "object") : [];
  const hits = Array.isArray(ev.hits) ? ev.hits.filter((h) => h && typeof h === "object" && COMMENT_TRAITS.includes(h.trait)) : [];
  const answers = ev.answers && typeof ev.answers === "object" && !Array.isArray(ev.answers) ? ev.answers : {};
  const on = new Set(Array.isArray(style?.traits) ? style.traits : []);
  const held = (trait) => {
    const a = Object.hasOwn(answers, trait) ? answers[trait] : null;
    if (!a || typeof a !== "object") return false;
    if (a.never === true) return true;
    return Number.isInteger(a.later) && pairs.length - a.later < LATER_AFTER;
  };
  const found = [];
  const win = pairs.slice(-WINDOW);
  for (const [trait, signal, min, share] of EDIT_RULES) {
    const n = win.filter((p) => p[signal] === true).length;
    if (n >= min && n * 100 >= share * win.length) found.push({ trait, n, m: win.length, source: "edits" });
  }
  const hwin = hits.slice(-HIT_WINDOW);
  for (const trait of COMMENT_TRAITS) {
    const n = hwin.filter((h) => h.trait === trait).length;
    if (n >= COMMENT_MIN && !found.some((f) => f.trait === trait)) found.push({ trait, n, m: hwin.length, source: "comments" });
  }
  // asked for both a formal and a relaxed tone: the evidence disagrees, so neither is offered
  const both = found.some((f) => f.trait === "formal") && found.some((f) => f.trait === "relaxed");
  return found
    .filter((f) => TRAIT_IDS.includes(f.trait) && !on.has(f.trait) && !held(f.trait) && !(both && (f.trait === "formal" || f.trait === "relaxed")))
    .slice(0, MAX_SUGGESTIONS)
    .map(({ trait, n, m, source }) => ({ trait, n, m, source }));
}
