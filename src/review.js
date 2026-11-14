import crypto from "node:crypto";
import { readUnits } from "./anchors.js";
import { findAll } from "./ops/runs.js";
import { untrusted } from "./sanitize.js";
import { exactHash, normText } from "./text.js";
import { a1, a1Range } from "./xlsx.js";

// Idea 21: the agent reviews first. The person taps one of three fixed requests; the batch carries that fixed sentence in
// `instructions.review` and a read-only outline of the file (`untrusted_document_evidence.units[]`, built here by code). The agent answers
// with suggestions, which become cards: an edit card is one find-and-replace inside one DOCX paragraph or one PPTX shape, a note card is a
// concern with nothing to apply (spreadsheets get note cards only). Nothing the agent writes ever moves into a batch: a card's op is built
// here from the server's own record of the unit, and only the person's tap runs it, through the same apply path as an agent's ops.
// `Sessions.done()` is the trust boundary (cleanSuggestion + checkOnDisk); `planReplies` runs the same checks only to tell the agent what to fix.

export const REVIEW_KINDS = ["proofread", "skeptical_cfo", "check_numbers"];
/** The fixed sentence each button sends. Code constants: the only text a review puts in `instructions`. */
export const REVIEW_ASKS = {
  proofread: "Proofread the document. Suggest fixes for spelling, grammar and punctuation only.",
  skeptical_cfo: "Read the document as a skeptical finance chief would. Point out claims without support, numbers that do not add up, and risks left unsaid.",
  check_numbers: "Check every number in the document: totals, percentages, dates and units. Suggest a fix only when a number is clearly wrong. Otherwise point out what to check.",
};

export const UNITS_MAX = 300; // units in one review batch; the rest is counted in `units_more` (a long file is cut off)
export const UNIT_TEXT_MAX = 1000;
export const UNIT_LABEL_MAX = 120;
// The complete outline file of a batch for an agent Onionskin started: at most this many units (one per line). 2,000 covers a document of
// a few hundred pages; a line stays under 1,900 characters, so the worst file is about 3.8 MB and a typical one (150-character paragraphs)
// about 0.6 MB. Beyond it, `outline_more` counts the units the agent cannot see.
export const OUTLINE_FILE_MAX = 2000;
export const OUTLINE_LINE_MAX = 1900;
export const SUGGESTIONS_MAX = 20;
export const FIND_MAX = 200;
export const REPLACE_MAX = 300;
export const WHY_MAX = 100;
export const NOTE_MAX = 200;
const EXCERPT_MAX = 160; // the card's "before" and "after": a code excerpt around the change
export const SUGGEST_FIX = `At most ${SUGGESTIONS_MAX} items, each {unit, find, replace, why} or {unit, note}: find at most ${FIND_MAX} characters and once in that unit, replace ${REPLACE_MAX}, why ${WHY_MAX}, note ${NOTE_MAX}, one line, no links. Spreadsheets take notes only.`;

// a link: a scheme, www., an email, or a bare domain (letters, a dot, two or more letters: "evil.example", not "a.m." or "3.5%"; the
// pattern src/rewrite-check.js uses). Stricter than question cards (src/question.js): an accepted `replace` goes into the file.
// Ceiling: it also refuses a file name ("deck.pptx") or a missing space after a period ("end.Next"); those go unsuggested.
const LINK = /:\/\/|www\.|@|(?:[\p{L}\p{N}-]+\.)+\p{L}{2,}/iu;
// what untrusted() keeps but a reader cannot see (the set src/voice.js refuses in examples): Accept would put it in the file unseen
const INVISIBLE = /[\p{Default_Ignorable_Code_Point}\p{Cf}\p{Co}\p{Cn}\p{Cs}]/u;
const len = (s) => [...s].length;
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

/**
 * The outline of a file for a review: DOCX paragraphs with text, PPTX text shapes, XLSX non-empty cells, in document order. Returns
 * {units: [{id, label, text, protected}] (at most UNITS_MAX, for the batch), more, index: {id -> where the unit is and its text hash}} (the
 * index stays on the server). A unit an edit cannot address (a DOCX paragraph with no body path, a PPTX shape whose id is shared on its
 * slide) is marked protected: suggestions on it are refused.
 * Ceiling: every paragraph, shape or cell is read and sorted on the server's main thread before the cut to UNITS_MAX, so a very large
 * workbook pauses other requests while a review is built. Upgrade path: stop reading at UNITS_MAX + a count, or build in a worker.
 */
export function unitsOf(format, bytes) {
  const raw = rawUnits(format, bytes);
  const units = [];
  const index = {};
  raw.slice(0, UNITS_MAX).forEach((x, i) => {
    const id = `u${i + 1}`;
    const label = untrusted(x.label, UNIT_LABEL_MAX);
    units.push({ id, label, text: untrusted(x.text, UNIT_TEXT_MAX), protected: x.protected });
    index[id] = { label, protected: x.protected, ...x.at };
  });
  return { units, more: Math.max(0, raw.length - UNITS_MAX), index };
}

/** Every unit of the file in document order: {label, text (the full text, not cleaned), protected, at (where it is and its text hash)}. */
function rawUnits(format, bytes) {
  const raw = [];
  const u = readUnits(format, bytes);
  if (format === "docx") {
    for (const p of u.paragraphs) {
      if (!normText(p.text)) continue;
      const where = !p.path ? `paragraph ${p.ordinal + 1} (in a text box)` : p.path.length === 1 ? `paragraph ${p.path[0] + 1}` : `table ${p.tableNo ?? p.path[0] + 1}, row ${p.path[1] + 1}, column ${p.path[2] + 1}`;
      raw.push({ label: where, text: p.text, protected: !!p.protected || !p.path, at: { ordinal: p.ordinal, para_id: p.paraId || null, body_path: p.path || null, text_hash: p.hash } });
    }
  } else if (format === "pptx") {
    u.deck.ensure();
    for (const s of u.deck.slides) {
      const counts = new Map();
      for (const sh of s.shapes) counts.set(sh.id, (counts.get(sh.id) || 0) + 1);
      for (const sh of s.shapes) {
        if (sh.kind !== "shape" || !normText(sh.text)) continue;
        const addressable = /^\d{1,10}$/.test(String(s.id ?? "")) && Number.isInteger(sh.id) && sh.id >= 0 && counts.get(sh.id) === 1;
        raw.push({ label: `slide ${s.index + 1}, ${sh.name ? `"${sh.name}"` : `shape ${sh.id}`}`, text: sh.text, protected: !addressable, at: { slide_id: String(s.id), slide_index: s.index, shape_id: sh.id, text_hash: sh.hash } });
      }
    }
  } else if (format === "xlsx") {
    for (const sheet of u.wb.sheets) {
      const cells = [...u.wb.sheetCells(sheet).cells.values()].sort((x, y) => x.r - y.r || x.c - y.c);
      const sd = u.wb.sheetCells(sheet);
      for (const c of cells) {
        const text = c.k === "formula" && c.cached ? `${c.text} (shows ${c.cached})` : c.text;
        const m = sd.merges.find((q) => q.r0 === c.r && q.c0 === c.c);
        raw.push({ label: `${sheet.name}!${a1(c.r, c.c)}`, text, protected: false, ...(m ? { merged: a1Range(m) } : {}), at: { sheet: sheet.name, range: a1(c.r, c.c), text_hash: exactHash(c.text) } });
      }
    }
  } else throw new Error(`unknown format ${format}`);
  return raw;
}

/**
 * The outline an agent Onionskin started gets with every edit batch (it cannot open the file): the units of `unitsOf`, each with the
 * `target` and `expect` an op needs to address it, copied as they are. DOCX `{para_id?, body_path, text_hash}` (replace_text and the other
 * paragraph ops), PPTX `{slide_id, shape_id}` (replace_text_in_shape, set_shape_text), XLSX `{sheet, range}` (set_cells); `expect` is
 * `{text_hash}` of the whole unit. A protected unit has no target. `text_exact: false` marks a text that is not the unit's exact text (cut
 * at UNIT_TEXT_MAX, or cleaned by untrusted(): whitespace runs, control characters): a `find` must use words seen in it, and a whole
 * rewrite would lose what is not shown. Returns {outline, more} with at most `max` entries and `more` the units past them; the session
 * cuts the inline part further to fit, and writes all of them to the outline file when they do not fit (see OUTLINE_FILE_MAX).
 * Every entry, as JSON, stays under OUTLINE_LINE_MAX characters (its text is cut further when quotes or backslashes double in JSON), so
 * the outline file, one entry per line, can be paged with Claude Code's Read tool (which cuts lines at 2,000 characters).
 */
export function outlineOf(format, bytes, max = UNITS_MAX) {
  const raw = rawUnits(format, bytes);
  const outline = raw.slice(0, max).map((x, i) => {
    const target = x.protected ? null : targetOf(x.at, format);
    const entry = (n) => {
      const text = untrusted(x.text, n);
      return {
        id: `u${i + 1}`,
        label: untrusted(x.label, UNIT_LABEL_MAX),
        text,
        ...(text === x.text ? {} : { text_exact: false }),
        protected: x.protected,
        ...(x.merged ? { merged: x.merged } : {}),
        ...(target ? { target, expect: { text_hash: x.at.text_hash } } : {}),
      };
    };
    let e = entry(UNIT_TEXT_MAX);
    for (let n = UNIT_TEXT_MAX - 100; JSON.stringify(e).length >= OUTLINE_LINE_MAX && n > 0; n -= 100) e = entry(n);
    return e;
  });
  return { outline, more: Math.max(0, raw.length - max) };
}

/** One agent string: refused (never cut or cleaned into shape) unless it is already one clean line within `max`, and not a link. */
function strict(v, max, what, { empty = false } = {}) {
  if (typeof v !== "string") return `${what} must be a string`;
  if (!v && !empty) return `${what} is empty`;
  if (len(v) > max) return `${what} is longer than ${max} characters`;
  if (untrusted(v, Number.MAX_SAFE_INTEGER) !== v) return `${what} must be one line of plain text (no line breaks, control characters, or spaces at the ends)`;
  if (INVISIBLE.test(v)) return `${what} holds a character that cannot be seen`;
  if (LINK.test(v.normalize("NFKC"))) return `${what} contains a link`; // full-width letters count as their ASCII twins
  return null;
}

/**
 * The shape and caps of one suggestion, against the units of the batch (`units`: [{id, protected}]). Pure. Returns
 * {item: {unit, kind: "edit", find, replace, why} | {unit, kind: "note", note}} or {reason}.
 */
export function cleanSuggestion(raw, units, format) {
  if (!isObj(raw)) return { reason: "a suggestion must be an object" };
  const unit = typeof raw.unit === "string" ? raw.unit : "";
  const u = units.find((x) => x.id === unit);
  // reasons are code text only (they reach the page as flags): no string the agent wrote is echoed
  if (!u) return { reason: "no such unit in this review" };
  if (u.protected) return { reason: "this unit is protected: it cannot be changed or commented on here" };
  const isNote = "note" in raw;
  const allowed = isNote ? ["unit", "note"] : ["unit", "find", "replace", "why"];
  const extra = Object.keys(raw).filter((k) => !allowed.includes(k));
  if (extra.length) return { reason: "unexpected fields (give {unit, find, replace, why} or {unit, note})" };
  if (isNote) {
    const bad = strict(raw.note, NOTE_MAX, "note");
    return bad ? { reason: bad } : { item: { unit, kind: "note", note: raw.note } };
  }
  if (format === "xlsx") return { reason: "a spreadsheet takes notes only: {unit, note}" };
  const bad = strict(raw.find, FIND_MAX, "find") || strict(raw.replace, REPLACE_MAX, "replace") || (raw.why === undefined ? null : strict(raw.why, WHY_MAX, "why", { empty: true }));
  if (bad) return { reason: bad };
  if (raw.find === raw.replace) return { reason: "find and replace are the same" };
  return { item: { unit, kind: "edit", find: raw.find, replace: raw.replace, why: raw.why ?? "" } };
}

/** The unit's current full text, read by code from `units` (readUnits of the bytes on disk), or null when it is not where the index says. */
function textNow(units, at) {
  if (units.format === "docx") {
    const p = units.paragraphs[at.ordinal];
    return p && p.hash === at.text_hash ? p.text : null;
  }
  if (units.format === "pptx") {
    units.deck.ensure();
    const sh = units.deck.slides.find((s) => String(s.id) === at.slide_id)?.shapes.filter((x) => x.id === at.shape_id);
    return sh?.length === 1 && sh[0].hash === at.text_hash ? sh[0].text : null;
  }
  const sheet = units.wb.sheets.find((s) => s.name === at.sheet);
  if (!sheet) return null;
  const c = [...units.wb.sheetCells(sheet).cells.values()].find((x) => a1(x.r, x.c) === at.range);
  return c && exactHash(c.text) === at.text_hash ? c.text : null;
}

// Never cut what Accept removes or writes: `find` (FIND_MAX) and `replace` (REPLACE_MAX) are shown whole; only the file's words around them are cut.
function excerpt(text, at, n, replace) {
  if (n >= EXCERPT_MAX) return { before: untrusted(text.slice(at, at + n), Number.MAX_SAFE_INTEGER), after: untrusted(replace, Number.MAX_SAFE_INTEGER) };
  const room = EXCERPT_MAX - n;
  let s = Math.max(0, at - Math.floor(room / 2));
  const e = Math.min(text.length, s + EXCERPT_MAX);
  s = Math.max(0, e - EXCERPT_MAX);
  const head = s > 0 ? "…" : "";
  const tail = e < text.length ? "…" : "";
  return {
    before: head + untrusted(text.slice(s, e), Number.MAX_SAFE_INTEGER) + tail,
    after: head + untrusted(text.slice(s, at) + replace + text.slice(at + n, e), Number.MAX_SAFE_INTEGER) + tail,
  };
}

/**
 * A cleaned suggestion against the file as it is now (`units`: readUnits of the bytes on disk) and the server's index. Returns {card} or
 * {reason}. The unit must still hold the text it had when the batch was built, and an edit's `find` must occur exactly once in its full
 * text (case-sensitive, as apply matches). The card's op is built here, from the index; never from the agent.
 */
export function cardFor(item, units, index, { reviewId, format }) {
  const at = index[item.unit];
  if (!at || at.protected) return { reason: "unknown or protected unit" };
  const text = textNow(units, at);
  if (text == null) return { reason: "the unit changed since the review started" };
  const id = `g_${crypto.randomBytes(6).toString("hex")}`;
  const base = { id, reviewId, kind: item.kind, label: at.label, status: "open", at: placeOf(at, format) };
  if (item.kind === "note") return { card: { ...base, before: untrusted(text, EXCERPT_MAX), note: item.note } };
  const hits = findAll(text, item.find, true);
  if (hits.length !== 1) return { reason: hits.length ? `the text to find occurs ${hits.length} times in the unit` : "the text to find does not occur in the unit" };
  const ex = excerpt(text, hits[0], item.find.length, item.replace);
  return { card: { ...base, before: ex.before, after: ex.after, why: item.why, op: opFor(at, format, id, item) } };
}

/** Where the page shows a card ("Show me"): code-built, no document text. */
function placeOf(at, format) {
  if (format === "docx") return { format, ordinal: at.ordinal, para_id: at.para_id, body_path: at.body_path };
  if (format === "pptx") return { format, slide_id: at.slide_id, slide_index: at.slide_index, shape_id: at.shape_id };
  return { format, sheet: at.sheet, range: at.range };
}

/** The op Accept runs: one find-and-replace in one paragraph or shape, with the unit's text hash as `expect`. */
export function opFor(at, format, id, { find, replace }) {
  if (format === "docx") return { op: "replace_text", id, target: targetOf(at, format), expect: { text_hash: at.text_hash }, find, replace };
  if (format === "pptx") return { op: "replace_text_in_shape", id, target: targetOf(at, format), expect: { text_hash: at.text_hash }, find, replace };
  return null;
}

/** The explicit op target of a unit (ops.schema.json docx_target, pptx_target, xlsx_range_target). */
function targetOf(at, format) {
  if (format === "docx") return at.para_id ? { para_id: at.para_id, body_path: at.body_path, text_hash: at.text_hash } : { body_path: at.body_path, text_hash: at.text_hash };
  if (format === "pptx") return { slide_id: at.slide_id, shape_id: at.shape_id };
  return { sheet: at.sheet, range: at.range };
}

/**
 * The agent's suggestions -> {cards, dropped: [{index, reason}]}. More than SUGGESTIONS_MAX stores none (refused, never the first 20).
 * `bytes` is the file now; `units` the batch's outline; `index` the server's record.
 */
export function cardsFrom(list, { bytes, format, units, index, reviewId }) {
  if (list === undefined || list === null) return { cards: [], dropped: [] };
  if (!Array.isArray(list)) return { cards: [], dropped: [{ index: null, reason: "suggestions must be a list" }] };
  if (list.length > SUGGESTIONS_MAX) return { cards: [], dropped: list.map((_, i) => ({ index: i, reason: `more than ${SUGGESTIONS_MAX} suggestions` })) };
  let now;
  try {
    now = readUnits(format, bytes);
  } catch {
    return { cards: [], dropped: list.map((_, i) => ({ index: i, reason: "the file could not be read" })) };
  }
  const cards = [];
  const dropped = [];
  list.forEach((raw, i) => {
    const c = cleanSuggestion(raw, units, format);
    const r = c.item ? cardFor(c.item, now, index, { reviewId, format }) : c;
    if (r.card) cards.push(r.card);
    else dropped.push({ index: i, reason: r.reason });
  });
  return { cards, dropped };
}

/** The activity summary of a review (code text, never the agent's). */
export const reviewSummary = (n) => (n ? `The agent made ${n} suggestion${n === 1 ? "" : "s"}.` : "The agent had no suggestions.");

