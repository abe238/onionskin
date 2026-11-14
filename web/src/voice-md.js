// The voice.md file: how the person likes text written, for other AI tools. Pure; the page builds the text and offers it as a download.
// Preferences, own words and the guide are the person's own text and go in as they are. Examples are different: the "AI wrote" side came
// from a document, so every example is written as one escaped, quoted line that no tool can read as a heading, a link, a tag or a new
// instruction block. An example appears only when the caller passes it (the person ticked it).

import { parseGuide } from "./voice-guide.js";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MAX_EXAMPLES = 3;

/** "November 11, 2026" from a Date (local time), or "" for anything else. */
export function dateText(date) {
  return date instanceof Date && !Number.isNaN(date.getTime()) ? `${MONTHS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}` : "";
}

/**
 * One line of untrusted text as Markdown that shows exactly those characters: control characters (newlines, tabs) become spaces, and
 * characters a reader cannot see go (bidi marks, zero-width, tag characters, variation selectors, U+206A to U+206F, CGJ, soft hyphen,
 * U+180E, other format, private-use and unassigned code points). Then \ * _ [ ] < > # ` | ~ @ & are backslash-escaped (backslash first),
 * and "://" and "www." are broken. That stops the Markdown link, picture, autolink and entity forms; it does not stop a viewer that finds
 * bare web or email addresses by itself, which is why src/voice.js already refuses an example holding one.
 */
export function escapeExample(text) {
  return String(text ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
    .replace(/[\p{Default_Ignorable_Code_Point}\p{Cf}\p{Co}\p{Cn}\p{Cs}]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\\*_[\]<>#`|~@&]/g, "\\$&")
    .replace(/:\/\//g, "\\://")
    .replace(/www\./gi, (m) => `${m.slice(0, 3)}\\.`);
}

const lines = (s) => String(s ?? "").replace(/\r\n?/g, "\n").trim();

/**
 * buildVoiceMd({traits, words, guide, examples, date}) -> the file text, ending in one newline.
 *   traits   the sentences of the preferences that are on (strings)
 *   words    the person's own words
 *   guide    the person's saved guide (in sections: written first as ## sections; otherwise as "My guide", after the preferences)
 *   examples [{agent, mine}] the ticked examples, at most 3 are written
 *   date     a Date; the file says when it was saved
 * A section with nothing in it is left out. Non-string entries are skipped.
 */
export function buildVoiceMd({ traits = [], words = "", guide = "", examples = [], date } = {}) {
  const when = dateText(date);
  const out = ["# My writing voice", "", `How I like text written. Saved from Onionskin${when ? ` on ${when}` : ""}.`];
  // a guide built in sections is written as top-level sections, "In short" first; any other guide stays one "My guide" section
  const g = typeof guide === "string" && lines(guide) ? parseGuide(lines(guide)) : { structured: false, sections: [] };
  if (g.structured) for (const s of g.sections) if (s.body.trim()) out.push("", `## ${s.title}`, s.body.trim());
  const sentences = (Array.isArray(traits) ? traits : []).filter((t) => typeof t === "string" && lines(t)).map((t) => lines(t).replace(/\s*\n\s*/g, " "));
  if (sentences.length) out.push("", "## Preferences", ...sentences.map((t) => `- ${t}`));
  if (typeof words === "string" && lines(words)) out.push("", "## In my own words", lines(words));
  if (!g.structured && typeof guide === "string" && lines(guide)) out.push("", "## My guide", lines(guide));
  const picked = (Array.isArray(examples) ? examples : [])
    .map((e) => (e && typeof e === "object" ? { agent: escapeExample(e.agent), mine: escapeExample(e.mine) } : null))
    .filter((e) => e && e.agent && e.mine)
    .slice(0, MAX_EXAMPLES);
  if (picked.length) {
    out.push("", "## Examples", "These are places where I rewrote an AI's text.");
    picked.forEach((e, i) => out.push("", `### Example ${i + 1}`, "The AI wrote:", `> ${e.agent}`, "", "I changed it to:", `> ${e.mine}`));
  }
  return out.join("\n") + "\n";
}
