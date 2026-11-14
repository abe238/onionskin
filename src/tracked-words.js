// What a person reads about the tracked-changes copy (M4 Idea 16). Plain words only; no document or agent text is ever put in here.

export const TRACKED = {
  locked: "Wait until the agent finishes, then try again.",
  not_editor: "Save the copy from the tab that holds the file.",
  not_current: "This file has changed since this run. Use What changed to save every change instead.",
  has_revisions: "This file already has tracked changes. Accept or reject them in Word first, then try again.",
  outside: "Someone changed this file outside Onionskin during this time, so these changes cannot all be marked as Onionskin's.",
  check_failed: "The copy did not pass Onionskin's check, so it was not saved. Your file is fine.",
  timeout: "This file is too large to make the copy right now. Nothing was saved.",
  busy: "A copy is already being made.",
  folder: "Onionskin could not save in that folder. Download the copy instead.",
  folder_too_large: "Onionskin could not save in that folder. Move the file to a folder you can save in, then try again.",
  not_docx: "Only Word files can be saved with tracked changes.",
  not_agent: "Only an agent run can be saved with tracked changes.",
  no_changes: "There are no text changes to mark here. Nothing was saved.",
  nothing: "There is nothing in History to save yet.",
  not_set_up: "Onionskin checked the copy. The extra checks are not set up on this Mac.",
  moves: "Moved text shows as removed in one place and added in the other.",
};

/** Refusal codes from src/redline.js (and the span rules) -> the phrase in "Some of these changes cannot be shown ...: {list}." */
export const UNSUPPORTED = {
  notes_part: "a change in a header, footer or footnote",
  other_part: "a change to the file's styles or settings",
  table_shape: "a change to a table's rows or columns",
  table_para: "a paragraph added or removed inside a table",
  protected: "a change in a paragraph with a picture, link or field",
  at_end: "a paragraph added or removed at the very end",
  next_to_table: "a paragraph added or removed right next to a table",
  section: "a section break",
  sdt: "a change in a text box or content control",
  nested_table: "a change in a table inside another table",
  pruned: "an older change that is no longer stored",
  bad_char: "a character Word cannot store",
  id_overflow: "a file with too many numbered items",
  unreadable: "a part of the file Onionskin cannot read yet",
};

const join = (list) => (list.length < 2 ? list.join("") : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`);
export const unsupportedText = (codes) => `Some of these changes cannot be shown as tracked changes yet: ${join([...new Set(codes.map((c) => UNSUPPORTED[c] || UNSUPPORTED.unreadable))])}. Nothing was saved.`;
export const savedText = (name) => `Saved “${name}” in the same folder as your file.`;
export const formattingText = (n) => (n === 1 ? "1 formatting change is in the copy but not marked, so Reject All in Word keeps it." : `${n} formatting changes are in the copy but not marked, so Reject All in Word keeps them.`);
