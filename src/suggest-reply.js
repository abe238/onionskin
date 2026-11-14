// Quick fixes (idea 10 option A), the pure half of "Use this": where in the file a suggestion may be written, and the one reply the
// local runner sends for it. No I/O and no session state: src/session.js (useSuggestion) and src/suggest.js both call these.
//
// What is written is only the changed middle of the sentence: the shortest span from the first change to the last, widened to whole words
// until it occurs exactly once in the paragraph (or text box) it sits in, otherwise the whole sentence. The engine refuses a find that
// occurs more than once, so a sentence that repeats word for word in its paragraph is refused and nothing is written.

/** The comment's result note and the run's summary (docs/contracts/routes.md). Fixed words: never the model's text. */
export const USE_NOTE = "Rewritten on this Mac. Nothing left this Mac.";
export const USE_SUMMARY = "Rewrote 1 sentence on this Mac. Nothing left this Mac.";

const isSpace = (ch) => /\s/u.test(ch);

/** Occurrences of `q` in `text`, overlapping ones counted (stricter than the engine's own count). */
function count(text, q) {
  let n = 0;
  for (let i = text.indexOf(q); i >= 0; i = text.indexOf(q, i + 1)) n++;
  return n;
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
    if (find.trim() && count(unitText, find) === 1) {
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
