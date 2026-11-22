// Quick changes (idea 8), the two halves that need the file: the preview the page shows before Send, and the planner the local runner
// (src/local.js) asks. Both read the person's own typed note and the file's bytes; nothing from the document ever becomes the command.
//
// The trust argument: the command is the person's typed note, and the count is the number the person saw on the Send button. The plan
// binds that number as `expect.count`, so a file that changed since the preview, or a tampered number, fails the count check and nothing
// is written (the batch then goes to the agent unchanged).
//
// The engine's count runs in a worker thread with a time limit (src/offload.js previewOffThread), as the change itself does (src/local.js):
// a document of one paragraph of 8 million characters held the server's thread for 4 s in an outside review. A count that does not
// finish is no count: the page shows no button and the agent gets the note. The page asks 600 ms after typing stops, and answers are
// cached by file hash and command. The bytes are read whole within the readers' caps first (readChecked), so a file swapped on disk
// past a cap is refused in plain words before the engine reads it.

import { checkRegularOwned, readOwned, sha256 } from "./fsutil.js";
import { readChecked } from "./session.js";
import { previewOffThread } from "./offload.js";
import { recognize, refusalFor, wordsFor } from "./quick.js";
import { userText } from "./sanitize.js";

const CACHE_MAX = 64;
const cache = new Map(); // `${sha}\0${format}\0${command}` -> match

const WHY_UNDONE = "You undid this change, so the agent will do it.";
const WHY_ALL_PROTECTED = "Every match is in a protected place, so the agent will do this one.";

/**
 * True when the next Send's batch would carry something besides the note (what `quickPlanner.wants` refuses), from what the server holds:
 * a batch waiting or delivered, comments sent and not yet taken by an agent or queued, the person's edits from an earlier Send. Draft
 * comments are the page's to count: the Send replaces them with the page's own list.
 */
function ridesAlong(s) {
  if (s.delivered || s.pending || s.queued) return true;
  if ((s.edits || []).length) return true;
  return (s.comments || []).some((c) => c.status === "sent" || c.status === "queued");
}

async function previewOf(bytes, format, q) {
  const p = await previewOffThread(bytes, format, q.op); // throws when the worker did not finish: no count, nothing shown or written
  const count = p.ok ? p.count : 0;
  const skipped = p.ok ? p.protected || 0 : 0;
  let why = refusalFor(q.kind, p, q.find);
  if (!why && count - skipped <= 0) why = WHY_ALL_PROTECTED;
  return { p, count, skipped, why };
}

/**
 * What the page shows for `note` on the file as it is on disk right now: {match: null} (not a quick request) or
 * {match: {action, command, count, protectedCount, local, why, text, label}}. Read only.
 */
export async function quickPreview(s, note) {
  const q = recognize(userText(note), s.format);
  if (!q) return { match: null };
  if (ridesAlong(s)) return { match: null }; // the next Send carries more than the note, so `wants` says no: the button must not promise otherwise
  // the person undid a local run of these very words: the next Send goes to the agent (src/local.js skipsLocal), so the button must not say otherwise
  if (s.skipLocalNote && userText(note).trim() === String(s.skipLocalNote).trim()) return { match: { action: q.kind, command: q.command, count: 0, protectedCount: 0, local: false, why: WHY_UNDONE } };
  let bytes;
  try {
    checkRegularOwned(s.file);
    bytes = readOwned(s.file);
  } catch {
    return { match: null };
  }
  const sha = sha256(bytes);
  const key = `${sha}\0${s.format}\0${q.command}`;
  let match = cache.get(key);
  if (!match) {
    readChecked(s.format, bytes, { sha }); // past a reader's cap: refused with the reason (422), the engine never sees it
    try {
      const { count, skipped, why } = await previewOf(bytes, s.format, q);
      match = { action: q.kind, command: q.command, count, protectedCount: skipped, local: !why, why: why || null, ...wordsFor(q, count, skipped) };
    } catch {
      return { match: null }; // the engine could not read it: the agent will
    }
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, match);
  }
  return { match };
}

/** The local runner's planner for a quick change. See src/local.js for the contract of `wants` and `plan`. */
export const quickPlanner = {
  name: "quick",

  /** Pure and synchronous: a whole Send that is only a note, the person confirmed a count for exactly this note, nothing else rides along. */
  wants(s, batch) {
    // at the Send it is on the session (held for that Send); the runner asks again when it starts, and then it is on the delivery
    const c = s.quickConfirm ?? (s.delivered?.batch === batch ? s.delivered.quick : undefined);
    if (!c || typeof c.command !== "string" || !Number.isInteger(c.count) || c.count < 1) return false;
    if ((batch.instructions?.comments || []).length) return false;
    if ((batch.untrusted_document_evidence?.user_edits || []).length) return false;
    const q = recognize(batch.instructions?.overall_note, batch.format);
    return !!q && q.command === c.command;
  },

  /** Counts again on the bytes about to be written. Any guard failing returns null: nothing is written and the agent gets the batch. */
  async plan(s, batch) {
    const confirmed = s.delivered?.quick;
    if (!confirmed || s.delivered.batch !== batch) return null;
    const q = recognize(batch.instructions?.overall_note, batch.format);
    if (!q || q.command !== confirmed.command) return null;
    let bytes;
    try {
      checkRegularOwned(s.file);
      bytes = readOwned(s.file);
      if (sha256(bytes) !== batch.base_sha256) return null; // the file moved since the Send
      readChecked(s.format, bytes, { sha: batch.base_sha256 }); // within the readers' caps before the engine reads it
    } catch {
      return null;
    }
    const { count, skipped, why } = await previewOf(bytes, batch.format, q);
    if (why || count !== confirmed.count) return null; // not what the person saw
    return { reply: { summary: wordsFor(q, count, skipped).summary, replies: [], ops: [{ ...q.op, expect: { count } }] } };
  },
};
