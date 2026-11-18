// The voice guide's fixed shape, stage 2 ("Build my voice guide"). Pure: nothing here reads or writes a file.
//
// An agent drafts a guide; the person reads every section and saves what they approve (src/voice-store.js keeps it). This module holds
// the twelve fixed sections and their caps, the strict check of an agent's draft (cleanVoiceDraft: it refuses, it never cuts or
// repairs), and the parsing of a saved guide into its sections (parseGuide, shortForm).
//
// A draft is agent text: untrusted until the person approves it word for word. The check makes sure that what reaches the page is plain
// text in the fixed layout, with nothing hidden, no link and no markup, so that every word the person approves is a word they could see.
// Ceiling: it cannot make a persuasive sentence harmless. That is what the person's review is for.
import { nfc } from "./nfc.js";

/** The twelve sections, in order. `title` is the exact `## ` heading; `max` the cap of its body, in characters (code points). */
export const SECTIONS = [
  { id: "short", title: "In short", max: 700 },
  { id: "identity", title: "Who I am as a writer", max: 500 },
  { id: "priorities", title: "What matters most", max: 600 },
  { id: "tone", title: "Tone by situation", max: 700 },
  { id: "rhythm", title: "Sentences and rhythm", max: 450 },
  { id: "words", title: "Words I use and avoid", max: 600 },
  { id: "humor", title: "Humor", max: 400 },
  { id: "structure", title: "How I build a piece", max: 500 },
  { id: "punctuation", title: "Punctuation and formatting", max: 400 },
  { id: "rules", title: "Always and never", max: 600 },
  { id: "examples", title: "Before and after", max: 900 },
  { id: "calibration", title: "Sounds like me, does not sound like me", max: 600 },
];
/** The whole saved guide, headings included, in characters (code points). */
export const GUIDE_MAX = 7000;
/** The "In short" section, the only part sent when the person picks "Short form only". */
export const SHORT_MAX = SECTIONS[0].max;
/** The largest draft read at all, in UTF-8 bytes. Checked before anything else, so a huge body costs nothing. */
export const DRAFT_MAX_BYTES = 32 * 1024;
export const DRAFT_MAX_LINES = 160;
export const LINE_MAX = 600;
/** The one heading allowed before the first section. */
export const DRAFT_TITLE = "# My voice guide";

/** What the agent is told when a draft is refused (agent-facing; the person sees the page's own wording). */
export const VOICE_FIX =
  "Fill the template in reference/voice-guide.md exactly: the twelve ## headings in order, each once, nothing before the first except an optional \"# My voice guide\" line, and no other line starting with #. Keep each section within its cap, the whole draft at most 7,000 characters and 160 lines, and every line at most 600 characters. At most two blank lines in a row. No links, web or email addresses, @, HTML, Markdown links or pictures, code fences, tabs or hidden characters. Nothing is cut to fit: correct the draft and reply again.";

const cps = (s) => [...s].length;
const HEADING_LINE = new Map(SECTIONS.map((s, i) => [`## ${s.title}`, i]));

// Hidden characters, refused (never stripped): C0 except \n (tabs too), DEL, C1, the bidi marks and controls, the line and paragraph
// separators, and every default-ignorable, format, private-use, unassigned or surrogate code point. A lone ZWNJ or ZWJ (U+200C, U+200D)
// is allowed: Persian and several Indic scripts need it to spell a word, and emoji sequences use it. Two or more in a row spell nothing.
// Built with new RegExp from escapes so no raw control character lives in this file.
const HIDDEN = new RegExp(
  "[\\u0000-\\u0009\\u000B-\\u001F\\u007F-\\u009F\\u061C\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069\\u2028\\u2029]|" +
    "(?![\\u200C\\u200D])[\\p{Default_Ignorable_Code_Point}\\p{Cf}\\p{Co}\\p{Cn}\\p{Cs}]|[\\u200C\\u200D]{2,}",
  "u"
);
// Links and markup, checked on the NFKC form so a fullwidth or compatibility look-alike (a fullwidth @ or colon and slashes, a small less-than sign) counts as the real character.
// Every pattern is a literal or starts at one fixed character, so the check stays linear on a 32 KB draft.
const MARKUP = [
  /:\/\//u,
  /www\./iu,
  /@/u,
  /&(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/iu,
  /mailto:/iu,
  /\]\(/u,
  /!\[/u,
  /<[\p{L}/!?]/u,
  /```/u,
];
const VS = /[\uFE0E\uFE0F]/gu;
/** A line that draws nothing: spaces of any kind and the braille blank (U+2800, which is neither a space nor hidden). */
const BLANK = /^[\s\u2800]*$/u;
const BLANK_RUN_MAX = 2;
const TLD = /^\p{L}{2,}$/u;
const NAME_CHAR = /[\p{L}\p{N}-]/u;
const PORT = /:\d{1,5}$/u;
/**
 * A domain with a path, at least as strict as the examples' rule (LINK in src/voice.js, a backtracking pattern that is fine on 400
 * characters but not on 32 KB): any part of a word before one of its slashes that ends in a name character, a dot and two or more letters,
 * an optional port after it ("evil.example/x", "//evil.example/login", "x/evil.example/", "evil.example:8080/x"). "4.5/5", "and/or" and
 * "e.g. 3/4" pass. One pass over each word.
 */
function domainPath(s) {
  for (const word of s.split(/\s+/u)) {
    const parts = word.split("/");
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i].replace(PORT, "");
      const dot = name.lastIndexOf(".");
      if (dot > 0 && NAME_CHAR.test(name[dot - 1]) && TLD.test(name.slice(dot + 1))) return true;
    }
  }
  return false;
}

const refuse = (code, reason) => ({ code, reason });

/**
 * The section bodies of `lines`, or a refusal. Every line whose left-trimmed text starts with # must be "## <a fixed title>" exactly
 * (trailing spaces allowed; a fullwidth number sign counts as #); before the first section only blank lines and one optional "# My voice guide". `all` asks for all twelve,
 * in order, once each; otherwise any of them in order, each at most once (a saved guide the person composed from some sections).
 */
function splitSections(lines, { all }) {
  const found = [];
  let cur = null;
  let titleSeen = false;
  for (const line of lines) {
    const t = line.trimEnd();
    if (/^\s*#/u.test(nfc(t, "NFKC"))) { // a fullwidth number sign looks like # on the page
      if (!cur && !titleSeen && t === DRAFT_TITLE) {
        titleSeen = true;
        continue;
      }
      const i = HEADING_LINE.get(t);
      if (i === undefined) return refuse("bad_structure", "a line starts with # but is not one of the twelve section headings");
      if (found.length && i <= found[found.length - 1].index) return refuse("bad_structure", `the heading "${SECTIONS[i].title}" is out of order or repeated`);
      cur = { index: i, lines: [] };
      found.push(cur);
    } else if (cur) cur.lines.push(line);
    else if (t.trim()) return refuse("bad_structure", "there is text before the first section heading");
  }
  if (!found.length) return refuse("bad_structure", "there is no section heading");
  if (all) {
    const missing = SECTIONS.filter((_, i) => !found.some((f) => f.index === i));
    if (missing.length) return refuse("bad_structure", `the heading "${missing[0].title}" is missing`);
  }
  return {
    sections: found.map((f) => ({
      id: SECTIONS[f.index].id,
      title: SECTIONS[f.index].title,
      body: f.lines.join("\n").replace(/^\s*\n/u, "").trimEnd(),
    })),
  };
}

/**
 * An agent's draft of the guide: `{text, sections: [{id, title, body}]}` when it passes, `{code, reason}` when it does not. The only
 * changes: CR LF and CR become LF, NFC, and the emoji presentation selectors U+FE0E and U+FE0F are removed (they only change how an
 * emoji is drawn). Everything else is refused, never cut or repaired. Codes: `too_long`, `hidden_characters`, `link_or_markup`,
 * `bad_structure` (also more than two blank lines in a row). A `reason` holds fixed words, section titles and numbers only, never the draft's own text.
 */
export function cleanVoiceDraft(value) {
  if (typeof value !== "string") return refuse("bad_structure", "the draft must be text");
  // size first: a huge body is refused before any regex or normalization runs over it
  if (Buffer.byteLength(value, "utf8") > DRAFT_MAX_BYTES) return refuse("too_long", `the draft is over ${DRAFT_MAX_BYTES} bytes`);
  const text = nfc(value.replace(/\r\n?/gu, "\n")).replace(VS, "");
  if (HIDDEN.test(text)) return refuse("hidden_characters", "the draft holds a hidden or control character (tabs included)");
  const nfkc = nfc(text, "NFKC");
  if (MARKUP.some((re) => re.test(nfkc)) || domainPath(nfkc)) return refuse("link_or_markup", "the draft holds a link, an address, @, HTML or Markdown markup, or a code fence");
  const lines = text.split("\n");
  // padding: a run of blank lines could push a planted line far below the part of a box the person reads first
  let blank = 0;
  for (const l of lines) {
    blank = BLANK.test(l) ? blank + 1 : 0;
    if (blank > BLANK_RUN_MAX) return refuse("bad_structure", `there are more than ${BLANK_RUN_MAX} blank lines in a row`);
  }
  const split = splitSections(lines, { all: true });
  if (split.code) return split;
  for (const s of split.sections) {
    const max = SECTIONS.find((x) => x.id === s.id).max;
    if (cps(s.body) > max) return refuse("too_long", `the section "${s.title}" is ${cps(s.body)} characters; at most ${max}`);
  }
  if (cps(text) > GUIDE_MAX) return refuse("too_long", `the draft is ${cps(text)} characters; at most ${GUIDE_MAX}`);
  if (lines.length > DRAFT_MAX_LINES) return refuse("too_long", `the draft is ${lines.length} lines; at most ${DRAFT_MAX_LINES}`);
  const long = lines.findIndex((l) => cps(l) > LINE_MAX);
  if (long >= 0) return refuse("too_long", `line ${long + 1} is over ${LINE_MAX} characters`);
  return { text, sections: split.sections };
}

/**
 * A saved guide (the person's own text, already stripped by the store) split into its sections. `structured` is true when every line
 * starting with # is one of the fixed headings, in order, each at most once, with nothing but "# My voice guide" before the first: a
 * guide composed in the editor, possibly from some sections only. A guide imported in stage 1 is usually not structured, and then
 * `sections` is empty. `short` is the "In short" body, or "".
 */
export function parseGuide(text) {
  if (typeof text !== "string" || !text.trim()) return { structured: false, sections: [], short: "" };
  const split = splitSections(text.replace(/\r\n?/gu, "\n").split("\n"), { all: false });
  if (split.code) return { structured: false, sections: [], short: "" };
  return { structured: true, sections: split.sections, short: split.sections.find((s) => s.id === "short")?.body || "" };
}

/** The "In short" section alone ("## In short" and its body), or "" when the guide has none, it is empty or it is over SHORT_MAX. */
export function shortForm(text) {
  const { short } = parseGuide(text);
  return short && cps(short) <= SHORT_MAX ? `## ${SECTIONS[0].title}\n${short}` : "";
}
