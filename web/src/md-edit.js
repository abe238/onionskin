// Markdown edit mode (slice 2), the pure part: what a key pressed in the preview does, how the textarea's text maps to the file's
// source and back, and the one exact splice a Send carries. No DOM here, so the page and the tests (test/markdown-edit*.test.js) run the
// same code. Offsets are src/markdown.js offsets (UTF-16, after any BOM); nothing here searches for words.
import { offsetAllowed, sourceOffset, sourceRange } from "../../src/markdown.js";

/** What the person reads when the file cannot be edited in the page, or a key could not be typed where they pressed it. */
export const MD_MIXED_EOL = "This file mixes line endings, so it opens for reading and comments only. Save it with one kind of line ending to edit it here.";
export const MD_CR_EOL = "This file uses old-style line endings (a carriage return alone), which this version does not edit, so it opens for reading and comments only. Save it with LF or CRLF line endings to edit it here.";
export const MD_NOT_EXACT = "That spot does not map to one exact place in the file, so the key was not typed. The editor opened at the start of that block.";
export const MD_RO_EDIT = "This tab is read-only. Edit from the tab that holds the file.";
export const MD_LOCKED_EDIT = "The agent is working on this file. You can type again when it is done.";
export const MD_BODY_BOM = "This file's text contains an invisible byte order mark character, so it opens for reading and comments only.";
export const MD_DRAFT_FEFF = "Your edit was not sent: it contains an invisible byte order mark character (U+FEFF), which would change how the file is read. Remove it in Edit, then send again.";
/** Why a draft cannot be sent as it is, or null: a U+FEFF anywhere in its text (the file has none: a file that has one is not editable). */
export const draftRefusal = (source) => (source.includes("\uFEFF") ? MD_DRAFT_FEFF : null);
/** A fresh random id for one state of the draft (a new one on every change, undo included): comments made on it name it. */
export const newDraftId = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");
export const MD_SAVE_UNCONFIRMED = "Your edit was written to the file, but Onionskin could not confirm the save. Check the file; your edit is kept here to copy.";
export const MD_OFFER_STALE = "The text changed under that offer, so it was withdrawn and nothing was anchored. Select the words again.";
export const MD_PARKED_EDIT = "You have an unsent edit from an earlier version of this file. Copy or discard it before you type here.";
/** A comment whose place is no longer on the file (any write since it was made, or the draft it was made on changed): calm, with what to do. */
export const MD_SELECT_AGAIN = "You edited the text after making this comment, so it no longer points at a place. Select the words again, or send it as it is.";
/** The same, when the file changed some other way (an agent's write, Revert, a save outside Onionskin). */
export const MD_SELECT_AGAIN_FILE = "The file changed after you made this comment, so it no longer points at a place. Select the words again, or send it as it is.";
/** Above Send, when an unsent edit and comments without a place go together. */
export const MD_SEND_NO_PLACES = "Your edit is written first, so comments without a place go to the agent as words only.";

/**
 * Can the file be edited in the page: {ok: true, eol} (the line ending typed Enters become: the file's one kind, LF when it has none),
 * or {ok: false, reason}. A textarea holds LF only, so a file with a lone CR or with both LF and CRLF could not keep its bytes.
 */
export function editability(tree) {
  const { lf, crlf, cr } = tree.info.newlines;
  if (cr && !lf && !crlf) return { ok: false, reason: MD_CR_EOL };
  if (cr || (lf && crlf)) return { ok: false, reason: MD_MIXED_EOL };
  // text that holds U+FEFF anywhere (after the BOM, if any): deleting what is before it would expose it at the start, where a textarea
  // could not tell it from a pasted byte order mark. Editing is off; reading and comments work
  if (tree.text.includes("\uFEFF")) return { ok: false, reason: MD_BODY_BOM };
  return { ok: true, eol: crlf ? "\r\n" : "\n" };
}

/** The file's text (after any BOM) as the textarea holds it: CRLF as LF. Only for an editable file (one kind of line ending). */
/**
 * The one line-ending setting of a draft, fixed when the draft is made: the file's it is typed on ("\n" for a file with no line ending
 * yet). A draft that exists keeps its own, also when it is re-based onto a new revision of the file (whose line endings may say
 * nothing, or something else): preview, its hash, further typing, Copy and Send all use it (mdDraftSource).
 */
export const draftEolOf = (prev, ed) => prev?.eol ?? (ed?.ok ? ed.eol : "\n");
/** The draft's text as file source (after any BOM), with its own line endings: what Copy gives and Send writes, the same bytes. */
export const mdDraftSource = (draft) => fromTextarea(draft.value, draft.eol || "\n");
export const toTextarea = (text) => text.replace(/\r\n/g, "\n");
/**
 * The textarea's text back as the file's source: every line break the file's line ending (a textarea gives LF; a stray CR is one too).
 * Nothing the person typed or pasted is dropped: a U+FEFF stays exactly as entered, and a draft that holds one is refused at Send with a
 * sentence (draftRefusal), its text kept.
 */
export const fromTextarea = (value, eol) => {
  const lf = value.replace(/\r\n?/g, "\n");
  return eol === "\r\n" ? lf.replace(/\n/g, "\r\n") : lf;
};
/** A source offset as a textarea offset (each CRLF before it is one character there). The offset is never inside a CRLF (offsetAllowed). */
export function toTextareaOffset(text, o) {
  let k = 0;
  for (let i = text.indexOf("\r\n"); i >= 0 && i < o; i = text.indexOf("\r\n", i + 2)) k++;
  return o - k;
}

/**
 * The key of a keydown in the preview, as the text it types, or null when it does not swap to Edit: a shortcut (Cmd, Ctrl or Alt held),
 * composition (an IME: the person presses the Edit switch), arrows, Backspace, Delete, Tab, Escape and every other named key. Enter is "\n".
 */
export function typedKey(e) {
  if (!e || e.isComposing || e.keyCode === 229 || e.key === "Process" || e.key === "Dead") return null;
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  if (e.key === "Enter") return "\n";
  if (typeof e.key !== "string" || [...e.key].length !== 1) return null;
  return /[\p{Cc}\p{Cf}]/u.test(e.key) ? null : e.key;
}

/**
 * The first key typed in the preview: where it goes in the source. `at` is the preview's selection as run points: {start: {run, offset},
 * end: {run, offset}, collapsed, exact} (exact: both points are in a run's text, not snapped from an element boundary). Returns
 *   {from, to, text}        the key replaces source [from, to) (a caret: from === to), exactly once
 *   {caret, reason}         no exact place: the editor opens with the caret at `caret` (the start of that block) and types nothing
 * `text` uses the file's line ending for Enter.
 */
export function firstKey(tree, at, key, eol) {
  // an empty file (or one that holds only a BOM) has exactly one place, offset 0: the key goes there
  if (tree.text.length === 0) return { from: 0, to: 0, text: key === "\n" ? eol : key };
  const blockStart = () => {
    const r = tree.runs[at?.start?.run];
    return { caret: r ? tree.byId[r.block].from : 0, reason: MD_NOT_EXACT };
  };
  if (!at || !at.start || at.exact === false) return blockStart();
  const text = key === "\n" ? eol : key;
  if (at.collapsed) {
    const o = sourceOffset(tree, at.start.run, at.start.offset);
    return o == null || !offsetAllowed(tree, o) ? blockStart() : { from: o, to: o, text };
  }
  const m = sourceRange(tree, { startRun: at.start.run, startOffset: at.start.offset, endRun: at.end.run, endOffset: at.end.offset });
  return m.refused || m.block ? blockStart() : { from: m.from, to: m.to, text };
}

/**
 * The one exact splice from the file's text `a` to the draft `b` (both after any BOM): the changed middle between their common prefix and
 * common suffix, widened until both ends are allowed in both versions (src/markdown.js offsetAllowed: not between CR and LF, not inside a
 * surrogate pair or grapheme cluster, not inside an escape, an entity or a line break), which keeps it exact because both sides carry the
 * widened text. `ta`, `tb`: the two read trees. Returns {ok: true, none} when nothing changed, {ok: true, from, to, old, new, source}, or
 * {ok: false, reason} when the result does not give back the draft (a bug: never sent).
 */
export function draftSplice(a, b, ta, tb) {
  if (a === b) return { ok: true, none: true };
  const max = Math.min(a.length, b.length);
  let p = 0;
  while (p < max && a.charCodeAt(p) === b.charCodeAt(p)) p++;
  let q = 0;
  while (q < max - p && a.charCodeAt(a.length - 1 - q) === b.charCodeAt(b.length - 1 - q)) q++;
  let from = p;
  let toA = a.length - q;
  let toB = b.length - q;
  while (from > 0 && !(offsetAllowed(ta, from) && offsetAllowed(tb, from))) from--;
  while (toA < a.length && !(offsetAllowed(ta, toA) && offsetAllowed(tb, toB))) (toA++, toB++);
  const old = a.slice(from, toA);
  const neu = b.slice(from, toB);
  const source = a.slice(0, from) + neu + a.slice(toA);
  if (source !== b) return { ok: false, reason: "the edit could not be turned into one exact change of the file" };
  return { ok: true, from, to: toA, old, new: neu, source };
}


/**
 * Is the page's draft an unsent edit? Against the text of the record it is on; and, from a Send until that Send's reload has settled
 * (`inflight`: {value, sha, answered?, confirmed?}, the textarea value it submitted and the sha256 it writes), against that submitted text
 * too: an undo to the old text, or any key typed meanwhile, is a change from what the Send writes, so it is unsent even when it equals
 * the old base.
 */
export function mdDraftDirty(value, baseText, inflight) {
  return value !== baseText || (!!inflight && value !== inflight.value);
}

/**
 * What the page does with its draft when the file view (`doc`: {version, rev, error?}) changes:
 *  - "none": the draft is on the record shown, or there is nothing to do;
 *  - "wait": a Send is in flight and not answered yet (its own reload may come first);
 *  - "clear": the Send was confirmed and the reload shows exactly its bytes, and the draft is still the submitted text;
 *  - "rebase": the same, but the person changed the text after pressing Send: that text becomes a draft on the new record;
 *  - "park": the draft is on another record (with `unconfirmed` when the reload contradicts a confirmed receipt).
 */
export function mdSettle({ draft, inflight, doc }) {
  if (!draft || draft.parked || !doc) return { kind: "none" };
  if (!doc.error && doc.version === draft.base && doc.rev === draft.baseRev) return { kind: "none" };
  if (inflight && !inflight.answered) return { kind: "wait" };
  if (inflight?.confirmed) {
    if (doc.error || doc.version !== inflight.sha) return { kind: "park", unconfirmed: true };
    return draft.value === inflight.value ? { kind: "clear" } : { kind: "rebase" };
  }
  return { kind: "park" };
}
