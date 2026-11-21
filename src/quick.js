// Quick changes: the small closed set of requests Onionskin can do without the agent.
// Pure: it reads the person's own typed note and nothing else. Document text never reaches this file.
// Anything not recognized exactly returns null, and the request goes to the agent as it does today.

const MAX_NOTE = 200;
const MAX_BARE_WORDS = 6;
const MAX_BARE_CHARS = 60;
const MIN_FIND = 2;
const BANNED_WORDS = new Set(["and", "or", "then", "with", "to", "in"]);
const TAILS = ["everywhere", "throughout", "in the document", "in the whole document", "in the file"];
const OPEN_QUOTES = new Set(['"', "“"]);
const QUOTES = /["“”]/;

/** The note as it is compared and shown: one line, no politeness, no closing punctuation, one tail dropped. null when it cannot be a quick request. */
export function normalizeNote(note) {
  if (typeof note !== "string") return null;
  let t = note.trim();
  if (!t || t.length > MAX_NOTE || /[\r\n\u2028\u2029]/.test(t)) return null;
  t = t.replace(/[.!]$/, "").replace(/\s+/g, " ").trim();
  t = t.replace(/^please /i, "");
  if (/\p{Cc}/u.test(t)) return null;
  const low = t.toLowerCase();
  for (const tail of TAILS) {
    if (low.endsWith(` ${tail}`)) {
      t = t.slice(0, t.length - tail.length - 1).trimEnd();
      break;
    }
  }
  return t || null;
}

// ---- headings -----------------------------------------------------------------------------------------------------
const TARGETS = ["every heading", "each heading", "all headings", "all the headings", "the headings"];
const SETS = {
  bold: { bold: true },
  italic: { italic: true },
  underline: { underline: true },
  "no bold": { bold: false },
  "no italic": { italic: false },
  "no underline": { underline: false },
};
/** Every accepted heading phrase (lower case) -> the `set` it means. Built from templates; test/quick.test.js pins the list. */
export const HEADING_PHRASES = (() => {
  const m = new Map();
  const verbs = { bold: "bold", italicize: "italic", underline: "underline" };
  const adjectives = { bold: "bold", italic: "italic", underlined: "underline" };
  const removals = { "the bold": "bold", bold: "bold", italics: "italic", "the italics": "italic", "the underline": "underline", underlining: "underline" };
  for (const t of TARGETS) {
    for (const [v, k] of Object.entries(verbs)) m.set(`${v} ${t}`, SETS[k]);
    for (const [a, k] of Object.entries(adjectives)) m.set(`make ${t} ${a}`, SETS[k]);
    for (const [r, k] of Object.entries(removals)) m.set(`remove ${r} from ${t}`, SETS[`no ${k}`]);
  }
  return m;
})();

// ---- replace ------------------------------------------------------------------------------------------------------
/** A bare span: 1 to 6 words, up to 60 characters, no list or sentence punctuation, none of the joining words. */
function bareSpan(s) {
  if (!s || s.length > MAX_BARE_CHARS || /[,;:?!]/.test(s) || QUOTES.test(s)) return false;
  const words = s.split(" ");
  if (words.length > MAX_BARE_WORDS || words.some((w) => !w || BANNED_WORDS.has(w.toLowerCase()))) return false;
  return true;
}

/** Reads one side of "replace A with B" from the start of `s`. Returns {value, rest} or null. A quoted side keeps commas and joining words. */
function quoted(s) {
  if (!OPEN_QUOTES.has(s[0])) return null;
  const end = s.slice(1).search(QUOTES);
  if (end < 0) return null;
  return { value: s.slice(1, end + 1), rest: s.slice(end + 2) };
}

function parseReplace(t) {
  const m = /^replace (?:(?:all|every) )?(.+)$/i.exec(t);
  if (!m) return null;
  const body = m[1];
  let find;
  let rest;
  if (OPEN_QUOTES.has(body[0])) {
    const q = quoted(body);
    if (!q || !/^ with /i.test(q.rest)) return null;
    find = { text: q.value, quoted: true };
    rest = q.rest.slice(" with ".length);
  } else {
    const at = body.search(/ with /i);
    if (at < 0) return null;
    find = { text: body.slice(0, at), quoted: false };
    rest = body.slice(at + " with ".length);
  }
  let repl;
  if (OPEN_QUOTES.has(rest[0])) {
    const q = quoted(rest);
    if (!q || q.rest) return null; // nothing may follow the closing quote
    repl = { text: q.value, quoted: true };
  } else repl = { text: rest, quoted: false };
  if (!find.quoted && !bareSpan(find.text)) return null;
  if (!repl.quoted && !bareSpan(repl.text)) return null; // also refuses an empty bare replacement: removing text must be said as ""
  if (find.text.trim().length < MIN_FIND || find.text === repl.text) return null;
  return { find: find.text, replace: repl.text };
}

/**
 * Recognizes a quick request in the person's note for a file of `format` ("docx", "xlsx", "pptx").
 * Returns null (not recognized: the agent does it) or
 * { command, kind: "replace"|"headings", op, find?, replace?, set? }
 * where `op` is the ops-file op WITHOUT `expect`: the caller adds the count the person confirmed.
 * Matching is case-sensitive. Heading formatting is DOCX only.
 */
export function recognize(note, format) {
  const command = normalizeNote(note);
  if (!command) return null;
  const set = HEADING_PHRASES.get(command.toLowerCase());
  if (set) {
    if (format !== "docx") return null;
    return { command, kind: "headings", set: { ...set }, op: { op: "format_all", scope: "headings", set: { ...set } } };
  }
  const r = parseReplace(command);
  if (!r) return null;
  return { command, kind: "replace", find: r.find, replace: r.replace, op: { op: "replace_all_text", find: r.find, replace: r.replace, match_case: true } };
}

/**
 * Why a counted request cannot run as a quick change, or null when it can. `p` is previewAll's answer.
 * Returned strings are the plain wording the page shows.
 */
export function refusalFor(kind, p, find) {
  if (!p?.ok) return "The agent will look into it.";
  if (!p.count) return kind === "replace" ? `No "${find}" in this file. The agent will look into it.` : "No headings in this file. The agent will look into it.";
  if (p.partial_words) return "Some matches are part of longer words, so the agent will do this one.";
  if (p.in_formulas) return "Some matches are inside formulas, so the agent will do this one.";
  return null;
}

// ---- wording ------------------------------------------------------------------------------------------------------
const clip = (s, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const places = (n) => `${n} ${n === 1 ? "place" : "places"}`;
const headings = (n) => `${n} ${n === 1 ? "heading" : "headings"}`;
/** The one style a heading phrase sets: ["bold"|"italic"|"underlined", true|false]. */
function styleOf(set) {
  const k = Object.keys(set)[0];
  return [k === "underline" ? "underlined" : k, set[k] === true];
}

/**
 * The plain words for a recognized, counted request. `n` is the count the person confirms; `skipped` how many of those are protected places the
 * run leaves alone. text: the preview line's middle; label: the Send button; summary: what the activity entry says afterwards.
 */
export function wordsFor(q, n, skipped = 0) {
  const done = n - skipped;
  if (q.kind === "replace") {
    const find = `"${clip(q.find)}"`;
    return {
      text: q.replace === "" ? `remove ${find} in ${places(n)}` : `replace ${find} with "${clip(q.replace)}" in ${places(n)}`,
      label: `Replace in ${places(n)}`,
      summary: `${q.replace === "" ? `Removed ${find}` : `Replaced ${find} with "${clip(q.replace)}"`} in ${places(done)}. No AI was used.`,
    };
  }
  const [word, on] = styleOf(q.set);
  return {
    text: on ? `make ${headings(n)} ${word}` : `remove ${word} from ${headings(n)}`,
    label: `Change ${headings(n)}`,
    summary: `${on ? `Made ${headings(done)} ${word}` : `Removed ${word} from ${headings(done)}`}. No AI was used.`,
  };
}
