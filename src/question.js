import { untrusted } from "./sanitize.js";

/**
 * A question the agent asks instead of declining: `{"comment":"c1","ask":"Which date?","options":["March 3","March 13"]}`.
 * The agent wrote it after reading the document, so every string is untrusted. It is cleaned like other untrusted text (one line, no
 * control, bidirectional or zero-width characters) and then checked. A string over its cap is refused, never cut, so the card shows the
 * whole text the agent later reads back. The checks run on the cleaned text, so a hidden character cannot slip a link or a duplicate past.
 * `Sessions.done()` is the trust boundary; `planReplies` runs the same checks only to tell the agent what to fix.
 */
export const QUESTION_MAX = 160;
export const OPTION_MAX = 40;
export const OPTIONS_MIN = 2;
export const OPTIONS_MAX = 4;
export const QUESTIONS_PER_BATCH = 3;
export const QUESTION_FIX = "A question needs 2 to 4 short options (40 characters each) and no links.";
/** The note on the card when `done` received a question it would not show. */
export const BAD_QUESTION_NOTE = "The agent asked a question that could not be shown.";

const LINK = /:\/\/|www\./i;
const len = (s) => [...s].length; // code points, as untrusted() and the schema count

/** One string: cleaned, then refused when empty, over `max` or a link. Returns {text} or {reason}. */
function cleanOne(v, max, what) {
  if (typeof v !== "string") return { reason: `${what} must be a string` };
  const text = untrusted(v, Number.MAX_SAFE_INTEGER);
  if (!text) return { reason: `${what} is empty` };
  if (len(text) > max) return { reason: `${what} is longer than ${max} characters` };
  if (LINK.test(text)) return { reason: `${what} contains a link` };
  return { text };
}

/** `{ask, options}` -> `{question: {text, options}}`, or `{code: "bad_question", reason}`. */
export function cleanQuestion({ ask, options } = {}) {
  const refuse = (reason) => ({ code: "bad_question", reason });
  const q = cleanOne(ask, QUESTION_MAX, "the question");
  if (q.reason) return refuse(q.reason);
  if (!Array.isArray(options)) return refuse("options must be a list");
  if (options.length < OPTIONS_MIN || options.length > OPTIONS_MAX) return refuse(`give ${OPTIONS_MIN} to ${OPTIONS_MAX} options (got ${options.length})`);
  const out = [];
  for (const [i, o] of options.entries()) {
    const c = cleanOne(o, OPTION_MAX, `option ${i + 1}`);
    if (c.reason) return refuse(c.reason);
    out.push(c.text);
  }
  if (new Set(out.map((o) => o.toLowerCase())).size !== out.length) return refuse("two options are the same");
  return { question: { text: q.text, options: out } };
}
