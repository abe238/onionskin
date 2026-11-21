// Pure data and text (no browser imports, so unit tests load it). The loading hook is useStamps in Stamps.jsx.
// Stamps: a label plus fixed words. A tap sends the words as an ordinary Quick ask comment on the selection.
// The built-in words are code. Own stamps are loaded from the local server (they are the person's own typing); nothing from the document is ever used here.

import { COMMENT_TEXT_MAX } from "../../src/retain.js";
import { sentenceSpan } from "../../src/sentence-span.js"; // pure, no imports: the server runs the same rule on its own reading of the paragraph

export const BUILT_IN = [
  { id: "shorter", label: "Shorter", words: "Make this shorter. Keep the meaning." },
  { id: "friendlier", label: "Friendlier", words: "Make this sound friendlier. Keep the meaning." },
  { id: "grammar", label: "Fix grammar", words: "Fix the grammar, spelling and punctuation here. Change nothing else." },
  { id: "translate", label: "Translate", words: "Translate this into {language}.", language: true },
];
export const LANGUAGES = ["Spanish", "French", "German", "Portuguese", "Italian", "Chinese", "Japanese", "Korean"];

/** The sentence a stamp sends. A stamp that needs a language and gets none (or one not on the list) sends nothing: null. */
export function stampText(stamp, language) {
  if (!stamp.language) return stamp.words;
  return LANGUAGES.includes(language) ? stamp.words.replace("{language}", language) : null;
}

export function stampComment(words, typed) {
  const text = `${words} ${typed}`;
  return text.length <= COMMENT_TEXT_MAX ? text : null;
}

// ---- quick fixes (src/suggest.js): which stamp taps may show a suggestion first ----------------------------------------
// The tasks are ids of the built-in stamps above. The server says which ask the model first (`suggest.tasks` in the bootstrap, src/suggest.js) and
// checks everything again. This default holds the jobs the small model is measurably good at (today Fix grammar; the same list as SUGGEST_TASKS in
// src/suggest.js). A different list from the server is honored.
export const SUGGEST_TASKS = ["grammar"];
const BAD_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/;
const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();

/** The line the stamp row shows (suggestions on) when the selection is not one whole sentence: the tap will go to the agent, and this says so first. */
export const SELECT_ONE_SENTENCE = "Select one whole sentence to get a suggestion first.";

/**
 * What the page can tell about the selection before any tap (`never` goes with "no" for a table cell or a protected shape: no selection there is ever suggested): "ok" (one sentence, a suggestion can be asked for), "maybe" (it may be one
 * sentence minus its end mark but the page has no paragraph text to say, a PowerPoint text box: the server reads it and decides) or "no" (not one
 * sentence: several, part of one, a table cell, a caret). A Word selection that is a sentence minus its end mark, closing quote or bracket, or
 * has spaces at its edges, is read as the whole sentence (`sentenceSpan`), as the server does from the paragraph. `kind` is the selection's.
 */
export function selectionShape({ format, kind, anchor, paraText = null }) {
  if (kind !== "text" || !anchor || typeof anchor.quote !== "string") return { shape: "no" };
  let quote = anchor.quote;
  if (format === "docx" && paraText) {
    const loc = anchor.location || {};
    const at = Number.isInteger(loc.start) && paraText.slice(loc.start, loc.end) === quote ? loc.start : paraText.indexOf(quote);
    const span = at >= 0 ? sentenceSpan(paraText, at, at + quote.length) : null;
    if (span) quote = paraText.slice(span.start, span.end);
  }
  if (quote.length < 3 || quote.length > 300 || quote !== quote.trim() || BAD_CHARS.test(quote)) return { shape: "no" };
  const loc = anchor.location || {};
  // `never`: a place no suggestion is ever made for, however the words are selected, so the stamp row does not ask for a different selection
  if (loc.protected) return { shape: "no", never: true }; // a read-only shape
  if (format === "docx") {
    if (!Array.isArray(loc.blockPath) || loc.blockPath.length < 1 || loc.blockPath.length > 2) return { shape: "no", never: true }; // a table cell or a nested paragraph
  } else if (format !== "pptx" && format !== "xlsx") return { shape: "no", never: true }; // a format with no quick fixes
  else if (loc.cell || loc.tableCell || loc.row != null || loc.col != null) return { shape: "no", never: true }; // a slide table
  const whole = format === "docx" && !!paraText && norm(paraText) === norm(quote);
  if (!/^["'(\[“‘]?[\p{Lu}\p{N}]/u.test(quote)) return { shape: "no" };
  if (/[.!?]["')\]”’]*\s+\S/u.test(quote)) return { shape: "no" }; // another sentence end inside
  if (!whole && !/[.!?]["')\]”’]*$/u.test(quote)) return { shape: format === "pptx" ? "maybe" : "no" };
  return { shape: "ok", wholeParagraph: whole };
}

/**
 * Does this stamp tap on this selection ask the small model first? `{task, wholeParagraph}` when yes, null when the tap must do what it
 * always did (add the comment and Send). All of: suggestions are on, nothing is working or queued, a built-in Shorter, Friendlier or Fix
 * grammar stamp, a Word or PowerPoint file, selected words (not a caret), and one sentence (selectionShape). `paraText` is the text of the
 * paragraph the selection sits in (Word only), to tell a whole paragraph and to complete a sentence the selection stops short of.
 */
export function suggestEligible({ stamp, on, busy, format, kind, anchor, paraText = null, tasks = SUGGEST_TASKS }) {
  if (!on || busy || !stamp || !Array.isArray(tasks) || !tasks.includes(stamp.id)) return null;
  if (format !== "docx" && format !== "pptx") return null;
  const { shape, wholeParagraph } = selectionShape({ format, kind, anchor, paraText });
  return shape === "no" ? null : { task: stamp.id, wholeParagraph: !!wholeParagraph };
}

/** True when quick fixes are on and the selection is certainly not one whole sentence, and a different selection could be: the stamp row says so before the tap. */
export function needsOneSentence({ on, tasks = SUGGEST_TASKS, format, kind, anchor, paraText = null }) {
  if (!on || !Array.isArray(tasks) || !tasks.length || (format !== "docx" && format !== "pptx")) return false;
  const { shape, never } = selectionShape({ format, kind, anchor, paraText });
  return shape === "no" && !never; // selecting more or less would help; in a table cell or a protected shape nothing would
}
