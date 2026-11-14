// Quick fixes: which characters of a paragraph count as "the sentence" a selection means. No imports: the server (src/suggest.js) and the
// page (web/src/stamps.js) both read it, so the two cannot disagree. The server runs it on its own reading of the paragraph, never on text the page sends.
const SPACE = /\s/u;
const END_MARK = /[.!?]["')\]”’]*$/u; // a sentence end with the quotes and brackets that close it
const CLOSE_AFTER_MARK = /^["')\]”’]*(?=\s|$)/u; // closing quotes and brackets right after an end mark
const MARK_AND_CLOSE = /^[.!?]+["')\]”’]*(?=\s|$)/u; // the end mark and what closes it, right after words that stop short of it

/**
 * The span [start, end) of `text` that a selection of [start, end) means: the selection without its leading and trailing spaces, and when it
 * covers a whole sentence except the closing punctuation, closing quote or bracket, with those added. A selection that starts or stops
 * anywhere else comes back trimmed and not extended; the caller's ordinary one-sentence rules then decide. Null when the offsets are not a
 * span of `text`.
 */
export function sentenceSpan(text, start, end) {
  if (typeof text !== "string" || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > text.length || start >= end) return null;
  while (start < end && SPACE.test(text[start])) start++;
  while (end > start && SPACE.test(text[end - 1])) end--;
  if (start >= end) return null;
  if (end === text.length) return { start, end }; // the paragraph ends here: nothing to add
  const sentenceStart = start === 0 || (SPACE.test(text[start - 1]) && /(?:^|[.!?]["')\]”’]*)\s+$/u.test(text.slice(0, start)));
  if (!sentenceStart) return { start, end };
  const rest = text.slice(end);
  const add = END_MARK.test(text.slice(start, end)) ? CLOSE_AFTER_MARK.exec(rest) : MARK_AND_CLOSE.exec(rest);
  return { start, end: end + (add ? add[0].length : 0) };
}
