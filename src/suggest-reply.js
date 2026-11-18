// Quick fixes (idea 10 option A), the pure half of "Use this": where in the file a suggestion may be written, and the one reply the
// local runner sends for it, and where a selection sits before the model is asked. No I/O and no session state: src/anchor-work.js runs
// them (in the server's anchor worker, or on the caller's thread for the synchronous Sessions methods).
//
// What is written is only the changed middle of the sentence: the shortest span from the first change to the last, widened to whole words
// until it occurs exactly once in the paragraph (or text box) it sits in, otherwise the whole sentence. The engine refuses a find that
// occurs more than once, so a sentence that repeats word for word in its paragraph is refused and nothing is written.
import { untrusted } from "./sanitize.js";
import { sentenceSpan } from "./sentence-span.js";
import { normText, searchCost, spend } from "./text.js";

/** The comment's result note and the run's summary (docs/contracts/routes.md). Fixed words: never the model's text. */
export const USE_NOTE = "Rewritten on this Mac. Nothing left this Mac.";
export const USE_SUMMARY = "Rewrote 1 sentence on this Mac. Nothing left this Mac.";

const isSpace = (ch) => /\s/u.test(ch);

/**
 * Whether `q` occurs exactly once in `text`, overlapping occurrences counted (stricter than the engine's own count): it stops at the
 * second. Each try is two native searches, paid from the request's budget (src/text.js searchCost, at its worst case); null when the
 * budget cannot pay. An outside review: counting every occurrence of each widened span in a paragraph of one sentence repeated 10,000
 * times took 8.3 s before Use answered "not here".
 */
function once(text, q) {
  if (!spend(2 * searchCost(text.length, q))) return null;
  const i = text.indexOf(q);
  return i >= 0 && text.indexOf(q, i + 1) < 0;
}

/**
 * {find, replace} that turns `before` into `after` when `find` is swapped for `replace`, with `find` occurring once in `unitText` (the
 * paragraph or text box `before` sits in); null when no such span exists (no change, or the sentence itself repeats in `unitText`).
 */
export function changedMiddle(before, after, unitText = before) {
  if (typeof before !== "string" || typeof after !== "string" || !before || before === after) return null;
  let pre = 0;
  while (pre < before.length && pre < after.length && before[pre] === after[pre]) pre++;
  let suf = 0;
  const room = Math.min(before.length, after.length) - pre;
  while (suf < room && before[before.length - 1 - suf] === after[after.length - 1 - suf]) suf++;
  let s = pre;
  let e = before.length - suf; // the end of the span in `before`; the same distance from the end in `after`
  // whole words: never split a word (or a surrogate pair, which is never a space)
  while (s > 0 && !isSpace(before[s - 1])) s--;
  while (e < before.length && !isSpace(before[e])) e++;
  for (;;) {
    const find = before.slice(s, e);
    const unique = find.trim() ? once(unitText, find) : false;
    if (unique === null) return null; // past the budget: nothing is written (the comment goes to the agent)
    if (unique) {
      const replace = after.slice(s, after.length - (before.length - e));
      if (before.slice(0, s) + replace + before.slice(e) !== after) return null; // cannot happen; refuse rather than write something else
      return { find, replace };
    }
    if (s === 0 && e === before.length) return null;
    // one more word on each side
    while (s > 0 && isSpace(before[s - 1])) s--;
    while (s > 0 && !isSpace(before[s - 1])) s--;
    while (e < before.length && isSpace(before[e])) e++;
    while (e < before.length && !isSpace(before[e])) e++;
  }
}

/**
 * Where a selection sits in `units` (readUnits of the bytes at hand), for a durable anchor built from them. {ok: true, text, start, end} with
 * `text` the whole paragraph or text box and [start, end) the selection in it, or {ok: false, code}: "not_here" (the sentence is not at that place in these bytes), "protected",
 * "not_eligible" (a table cell, a nested Word paragraph, a slide table, picture or the slide itself).
 */
export function placeOf(units, d, quote) {
  if (!d) return { ok: false, code: "not_here" };
  if (d.protected) return { ok: false, code: "protected" };
  let text = null;
  if (units.format === "docx") {
    if (!Array.isArray(d.path) || d.path.length > 2) return { ok: false, code: "not_eligible" };
    text = units.paragraphs[d.ordinal]?.text ?? null;
  } else if (units.format === "pptx") {
    if (d.kind !== "shape" || d.cell) return { ok: false, code: "not_eligible" };
    const slide = units.deck.slides[d.slideIndex];
    const same = (slide?.shapes || []).filter((x) => x.id === d.shapeId);
    text = (same.find((x) => x.ordinal === d.ordinal) || (same.length === 1 ? same[0] : null))?.text ?? null;
  } else return { ok: false, code: "not_eligible" };
  if (typeof text !== "string" || !Number.isInteger(d.start) || text.slice(d.start, d.end) !== quote) return { ok: false, code: "not_here" };
  return { ok: true, text, start: d.start, end: d.end };
}

/**
 * The reply JSON (`onionskin reply`) for one stored suggestion on the comment `commentId`: one find and replace on that comment's anchor,
 * which `reply` turns into replace_text (Word) or replace_text_in_shape (PowerPoint) with the anchor's text hash as `expect`. `record` is the
 * server's stored suggestion ({before, after}); nothing here comes from the page. Null when no safe span exists.
 */
export function buildUseReply(record, commentId, unitText) {
  const m = changedMiddle(record?.before, record?.after, unitText);
  if (!m) return null;
  return { summary: USE_SUMMARY, replies: [{ comment: commentId, find: m.find, replace: m.replace, note: USE_NOTE }] };
}

/**
 * What a quick fix's selection means in `units` (src/suggest.js, before the model is asked), from the paragraph or text box it sits in,
 * never from the page: `d` is the durable anchor built from `anchor`, `picked` the selected text, `limits` = {context, maxQuote}.
 * {code: "protected" | "not_eligible" | "selection"} (refused), {ok: false} (not found at that place: the page's text is used), or
 * {ok: true, quote, from, wholeParagraph}: the whole sentence the selection means (src/sentence-span.js), the anchor for it (`from`: the
 * page's location with the sentence's offsets, and `context` characters either side) and whether it is the whole paragraph. Only these
 * leave: the paragraph's own text stays where it was read.
 */
export function selectionOf(units, d, anchor, picked, { context, maxQuote }) {
  const place = placeOf(units, d, picked);
  if (place.code === "protected" || place.code === "not_eligible") return { code: place.code };
  if (!place.ok) return { ok: false };
  let quote = picked;
  let from = anchor;
  const span = Number.isInteger(place.start) && Number.isInteger(place.end) ? sentenceSpan(place.text, place.start, place.end) : null;
  if (span) {
    quote = place.text.slice(span.start, span.end);
    if (untrusted(quote, maxQuote + 100) !== quote || quote.length > maxQuote + 10) return { code: "selection" };
    const loc = Number.isInteger(anchor.location.start) && Number.isInteger(anchor.location.end) ? { ...anchor.location, start: span.start, end: span.end } : anchor.location;
    from = { location: loc, quote, prefix: place.text.slice(Math.max(0, span.start - context), span.start), suffix: place.text.slice(span.end, span.end + context) };
  }
  return { ok: true, quote, from, wholeParagraph: normText(place.text) === normText(quote) };
}
