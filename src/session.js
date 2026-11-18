import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { EDITS_OVERFLOW, ONLY_FORMATS, REFUSED_EXTENSIONS, REFUSED_PAGES, MAX_DOC_BYTES, PRODUCT, env, formatOfExt } from "./constants.js";
import { readAll, unitsFor } from "./anchors.js";
import { anchorWork, weakDurable } from "./anchor-work.js";
import { scanBudget } from "./text.js";
import { CapError } from "./xml.js";
import { checkRegularOwned, readDoc, replaceGuarded, sha256, Snapshots, WriteConflict, writeSiblingCopy } from "./fsutil.js";
import { buildBatch, compactBatch, withOutline } from "./batch.js";
import { styleChangedOutside, styleNote } from "./style.js";
import { guideChangedOutside, voiceGuide, writeDraft } from "./voice-store.js";
import { cleanVoiceDraft } from "./voice-guide.js";
import { voiceJob } from "./voice-learn.js";
import { clearTickets, saveTicket, ticketOf } from "./lease.js";
import { analyze } from "./analyze.js";
import { anchorTimeoutMs, anchorsOffThread, htmlWriteOffThread, mergeOffThread, readOffThread, renderOffThread, startWorker } from "./offload.js";
import { deepNotice, validatePackage } from "./package.js";
import { HtmlEncodingError } from "./html.js";
import { ACTIVE_REFUSED } from "./html-active.js";
import { execFile } from "node:child_process";
import { reopenCommand } from "./person.js";
import { sessionKey, stateDir, sub, writeStateFile } from "./paths.js";
import { cleanFlag, hasControlChars, untrusted, userText } from "./sanitize.js";
import { addUpdate, historyDetail, historyList, visibleUpdates } from "./history.js";
import { BAD_QUESTION_NOTE, QUESTIONS_PER_BATCH, cleanQuestion } from "./question.js";
import { validateOps } from "./ops/schema.js";
import { AUTHORS, wordDate } from "./redline.js";
import { deepRedline } from "./checker.js";
import { TRACKED, formattingText, savedText, unsupportedText } from "./tracked-words.js";
import { LOCAL_HOLDER } from "./local.js";
import { bgHolder, isAgentHolder, isBgHolder, termHolder, TERM_PREFIX } from "./agent-detect.js";
import { OUTLINE_FILE_MAX, REVIEW_ASKS, REVIEW_KINDS, SUGGESTIONS_MAX, UNITS_MAX, outlineOf, reviewSummary, unitsOf } from "./review.js";
import { VOICE_BATCH_MAX_CHARS } from "./voice-samples.js";
import { STAMP_WORDS } from "./stamp-words.js";
import { USE_SUMMARY } from "./suggest-reply.js";
import { mergeNote } from "./notes.js";
import { COMMENT_MAX, COMMENT_TEXT_MAX, COMMENTS_MAX, EDITS_MAX, NOTE_MAX, TOO_MANY_COMMENTS, REQUEST_MAX, SESSION_MAX, capComment, cleanEdit, cleanPageAnchor, cleanView, cutText, jsonSize } from "./retain.js";

/** The line under a comment whose quick fixes could not be written on this Mac (docs/contracts/routes.md). */
export const LOCAL_HINT = "This could not be changed on this Mac, so nothing was written. Press Send to ask the agent.";

/**
 * A batch that may not write the file: "review" (src/review.js) or "voice" ("Build my voice guide"), from the batch itself so it holds
 * after a restart; null for an ordinary batch. While one is delivered, apply and commit are refused and `done` takes its own branch.
 */
const readOnlyKind = (batch) => (batch?.instructions?.voice_request ? "voice" : batch?.instructions?.review ? "review" : null);
const READ_ONLY = {
  review: "this batch is a review: nothing is written. Answer with `reply` and `suggest`.",
  voice: "this batch asks for a draft of the voice guide: nothing is written. Answer with `reply` and `voice_draft`.",
};
// the activity summary of a voice run: fixed text, never the agent's own summary
/** The flag text for a file changed behind the lease by a direct save, in the words of whoever made the change (a run on this Mac has no agent). */
const directSave = (local) => `The file changed ${local ? "while the change was made on this Mac" : "during the agent's turn"} by a path other than apply or commit (a direct save). Nothing extra was copied: the earlier version is stored; Revert restores it.`;
const VOICE_KEPT = "The agent wrote a draft of your voice guide.";
const VOICE_REFUSED = "The agent's draft could not be shown.";
const VOICE_REPLACED = "Your Send replaced the voice guide request that was waiting for the agent. Build it again when you are ready.";

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/** One comment more than a file keeps (src/retain.js COMMENTS_MAX): 413 too_many_comments, in words the page shows as they are. */
const tooMany = () => new HttpError(413, TOO_MANY_COMMENTS, { code: "too_many_comments" });
/** A note longer than Onionskin keeps (src/retain.js NOTE_MAX): 413 note_too_long. `joined`: a waiting note and this one together. */
const noteTooLong = (joined) =>
  new HttpError(413, joined ? `The note waiting for the agent and this one together are longer than Onionskin takes (${NOTE_MAX.toLocaleString("en-US")} characters), so nothing was sent. Shorten this note, then Send again.` : `This note is longer than Onionskin takes (${NOTE_MAX.toLocaleString("en-US")} characters), so it was not saved. Shorten it, then try again.`, { code: "note_too_long" });
/** The page's note as stored: refused (never cut) past NOTE_MAX. */
function noteOf(v) {
  const t = userText(v, NOTE_MAX + 1);
  if ([...t].length > NOTE_MAX) throw noteTooLong(false);
  return t;
}
/** Two notes, the earlier first, as one (a waiting batch's or the queued ones, then the new one): refused past NOTE_MAX. */
function joinNotes(a, b) {
  const t = [a, b].filter(Boolean).join("\n\n");
  if ([...t].length > NOTE_MAX) throw noteTooLong(true);
  return t;
}

/** A request whose own data is more than Onionskin keeps (src/retain.js): 413 too_large_request, in words the page shows as they are. */
export const tooLarge = (what) => new HttpError(413, `${what} is larger than Onionskin takes (${Math.round(REQUEST_MAX / 1024 / 1024)} MB), so nothing was saved. Remove some comments or shorten the longest ones, then try again.`, { code: "too_large_request" });

const LEASE_MS = () => Number(env("LEASE_MS", 15 * 60 * 1000));
const SENT_TABS = 16; // tabs of one file whose newest committed Send a session remembers (s.sent)
const DELETED_KEPT = 200; // ids and words of deleted drafts a session remembers for a handover (Sessions.handOver)
const HANDOVER_MS = 60_000; // how long a tab that lost editing may hand over its unsaved words (Sessions.handOver)
const MAX_BYTES = MAX_DOC_BYTES;
const TOO_BIG = `Onionskin cannot read this file: it is larger than ${Math.round(MAX_BYTES / 1024 / 1024)} MB, more than Onionskin can read. Make it smaller (pictures and videos are often most of a file) or split it, and open that.`;
/** "Show in folder" exists on macOS (`open -R`); elsewhere the page shows the path. ONIONSKIN_NO_OPEN=1 turns it off, ONIONSKIN_OPEN_STUB=<file> records instead of launching. */
const canReveal = () => !!env("OPEN_STUB") || (process.platform === "darwin" && !env("NO_OPEN"));
/** readDoc with the size refusal as an HTTP error */
function readCapped(file) {
  try {
    return readDoc(file);
  } catch (err) {
    if (err.code === "TOO_LARGE") throw new HttpError(413, `Onionskin cannot read this file: ${err.message}.`, { code: "too_large" });
    throw err;
  }
}

/**
 * Every part the server reads later, of bytes about to become the file (a Send's, an agent's write), so they are refused before anything is
 * written: past a reader's cap with the reason (CapError: 422 too_large), damaged where the readers look as an invalid package (422), never
 * as an internal error. The reading is kept for what reads the same version next (unitsFor).
 */
function readWhole(format, bytes, sha, refusal = "refusing to write") {
  try {
    const units = readAll(unitsFor(format, bytes, sha));
    readInCaps(format, sha);
    return units;
  } catch (err) {
    if (err instanceof CapError || err instanceof HttpError) throw err;
    throw new HttpError(422, `${refusal}: ${untrusted(err?.message || err, 200)}`, { code: "invalid_package" });
  }
}

// "<format>:<sha256>" of the versions read whole within the readers' caps, on this thread (readWhole) or by the open worker, so a version
// read again is not read whole again. Ceiling: VERIFIED_KEPT entries, the oldest dropped first (one dropped is read whole again when needed).
const VERIFIED_KEPT = 256;
const verified = new Set();
function readInCaps(format, sha) {
  const id = `${format}:${sha}`;
  verified.delete(id);
  verified.add(id);
  if (verified.size > VERIFIED_KEPT) verified.delete(verified.values().next().value);
}

/**
 * Bytes about to be handed to the engine on this thread (a quick preview, a merge, a change made on this Mac), which reads without the
 * readers' caps: they are read whole within the caps first (readWhole) unless this version already was, so a file that changed on disk
 * past a cap is refused with the reason (CapError: 422 too_large) before the engine parses any of it. Returns `bytes`.
 */
export function readChecked(format, bytes, { sha = sha256(bytes), refusal = "cannot read the file" } = {}) {
  if (!verified.has(`${format}:${sha}`)) readWhole(format, bytes, sha, refusal);
  return bytes;
}

// bounded before it is rounded, so the result is always finite (1e308 * 1000 is Infinity, stored as null); anything that is not a finite
// number is 0, as src/retain.js drops what is not of its type
const num = (v, max) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(Math.min(max, Math.max(0, n)) * 1000) / 1000 : 0;
};
const frac = (v) => num(v, 1);
const PX_MAX = 1_000_000; // a paragraph taller than this is not drawn by any page
/** A pin: x/y as fractions of the element it sits on (`yPx` is kept for DOCX paragraphs); `on` says what that element is. */
function cleanPin(p) {
  const out = { xFrac: frac(p.xFrac), yPx: num(p.yPx, PX_MAX) };
  if (p.yFrac != null) out.yFrac = frac(p.yFrac);
  if (["paragraph", "cell", "shape", "slide"].includes(p.on)) out.on = p.on;
  if (p.sxFrac != null) {
    out.sxFrac = frac(p.sxFrac);
    out.syFrac = frac(p.syFrac);
  }
  return out;
}

const APPLY_STATUS = new Set(["refused", "skipped_protected", "anchor_not_found", "expect_mismatch", "not_applied"]);
const HELD_SHOWN = 5; // items the page's "not in the document" message lists (web/src/Banners.jsx)
const WRITES_KEPT = 20; // writes per file the merge can trace (src/merge-xlsx.js agentChanges); an older base finds no record and is handed back
/**
 * What the page says the user did during the run: kinds and places only, used to hold edits back or to name what is not carried, never to
 * write. The first EDITS_KEPT; past them one more entry of kind EDITS_OVERFLOW says the list was cut, so a planner that needs the whole list
 * refuses the merge (src/merge-xlsx.js) instead of reading the cut list as complete. The proof of the merge never reads it.
 */
const EDITS_KEPT = 2000;
export const editKinds = (edits) => {
  const list = (Array.isArray(edits) ? edits.slice(0, EDITS_KEPT) : []).map((e) => ({ kind: String(e?.kind ?? "").slice(0, 40), sheet: typeof e?.sheet === "string" ? e.sheet.slice(0, 100) : null, slide: Number.isInteger(e?.slide) ? e.slide : null }));
  return Array.isArray(edits) && edits.length > EDITS_KEPT ? [...list, { kind: EDITS_OVERFLOW, sheet: null, slide: null }] : list;
};
/** One op `apply` did not apply, as the page shows it: codes and short reasons only (never document text). */
function cleanProblem(p, run = "") {
  return {
    key: untrusted(p?.key || `${p?.index ?? ""}:${p?.op ?? ""}`, 80),
    run: untrusted(run, 40),
    op: untrusted(p?.op, 40),
    status: APPLY_STATUS.has(p?.status) ? p.status : "refused",
    code: p?.code ? untrusted(p.code, 60) : null,
    // the R1 refusal in the server's own words, never the reason text an agent's report carries
    reason: p?.code === "active_content" ? ACTIVE_REFUSED : untrusted(p?.reason, 200),
  };
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * An HTML file that is not saved as UTF-8 (PLAN-html R10, R18): 400 with the fixed sentence as it is and `code` (not_utf8 or the
 * reason). The page shows the sentence; the UTF-8 copy it offers is a CLI action (`onionskin open` prints its command: src/html-utf8.js).
 */
function encodingRefusal(real, r) {
  return new HttpError(400, r.error, { code: r.code === "not_utf8" ? "not_utf8" : "encoding" });
}

/** The person's pending HTML text edits a Send or "Save my edits" carries (web/src/html-view.js createEdits): checked fields only. */
const HTML_EDITS_MAX = 2000;
const HTML_EDIT_TEXT_MAX = 1_000_000; // one text node's new text; the whole request is held to REQUEST_MAX (src/server.js)
export function cleanHtmlEdits(list) {
  if (list == null) return [];
  if (!Array.isArray(list) || list.length > HTML_EDITS_MAX) throw new HttpError(400, `htmlEdits must be a list of at most ${HTML_EDITS_MAX} edits`, { code: "bad_edits" });
  return list.map((e) => {
    const ok = e && typeof e === "object" && Number.isSafeInteger(e.nodeId) && e.nodeId >= 0 && typeof e.versionSha === "string" && /^[0-9a-f]{64}$/.test(e.versionSha) && typeof e.baseTextHash === "string" && /^[0-9a-f]{14}$/.test(e.baseTextHash) && typeof e.newText === "string" && e.newText.length <= HTML_EDIT_TEXT_MAX;
    if (!ok) throw new HttpError(400, "an HTML text edit must be {nodeId, versionSha, baseTextHash, newText}", { code: "bad_edits" });
    return { nodeId: e.nodeId, versionSha: e.versionSha, baseTextHash: e.baseTextHash, newText: e.newText };
  });
}
/** 409 version_changed: the page's edits were made on a version that is not the file on disk now (it reloads the view and places them again). */
const VERSION_CHANGED = "The file changed since this page loaded it, so your text edits were not written. The page shows the new version and puts your edits back where it can find their text; check them, then Send again.";
/** The write check refused the person's text edits: 409 for an edit made on other text (the page reloads), 422 for the others; nothing was written. */
function htmlEditRefusal(c) {
  if (c.code === "edit_moved") return new HttpError(409, VERSION_CHANGED, { code: "version_changed" });
  if (c.code === "check_failed" || c.failed) return new HttpError(503, `Your text edits could not be checked: ${c.reason || c.why || "the check did not finish"}. Nothing was written; your edits are still in this page. Try again in a moment.`, { code: "check_failed" });
  return new HttpError(422, `Your text edits were not written: ${c.reason}.`, { code: c.code, ...(c.reasons ? { reasons: c.reasons } : {}) });
}

// The tasks the anchor work does for a request (src/anchor-work.js), and how a result is matched to its task: by the task's own content,
// so a comment changed while the worker ran finds no answer and goes out weaker instead of with another one's anchor.
const buildTask = (c) => ({ op: "build", anchor: c.anchor, pin: c.kind === "pin" });
const reanchorTask = (c) => ({ op: "reanchor", c: { durable: c.durable ?? null, anchor: c.durable ? null : c.anchor } });
const editAnchor = (e) => ({ location: e.location, quote: e.after, ...(e.cut ? { cut: true } : {}) });
const cardsTask = (results, ix, run) => ({ op: "cards", list: results.suggestions, units: ix.units, index: ix.index, reviewId: run.batch.batch_id });
// a quick fix's Use: the page anchor's location and text only (its kind of selection does not change where the sentence is)
const useTask = (a, rec, id) => ({ op: "use", anchor: { location: a.location, quote: a.quote, prefix: a.prefix, suffix: a.suffix }, rec: { quote: rec.quote, before: rec.before, after: rec.after }, id });
const taskKey = (t) => JSON.stringify(t);
/** A task's result that can be used: not missing, not an error of its own. A null anchor (the unit is not in the file) is a result. */
const usable = (r) => r !== undefined && !(r && typeof r === "object" && "error" in r && Object.keys(r).length === 1);

/**
 * All session state and transitions, with no HTTP in it.
 * States (derived): idle, listening, working, queued, stranded, closed. poll results add timeout and superseded.
 *  - Send with a poller waiting: batch delivered, session `working`, document locked.
 *  - Send with nobody polling: batch kept as `pending`, session `stranded`, document stays editable.
 *  - Send while working: comments only, kept as `queued`; released to the next poller after `done`.
 *  - Lease expiry or Take back: `delivered` is withdrawn, the document unlocks.
 */
// What one request may spend scanning a whole reading for moved anchors (src/text.js scanBudget): about 0.1 to 0.3 s here. Fifty moved
// comments on a Word document of 26,000 paragraphs took 10 s before. Past it, the rest resolve as moved or removed, and an anchor being
// made is made without the text it cannot pay for (src/xlsx.js xlsxDurable). The server's routes make and resolve anchors in the anchor
// worker (src/anchor-worker.js, ten times this budget, within a time limit); the synchronous methods (Send, done, revert, resolve, Use of
// a quick fix) do it on the caller's thread under this budget.
export const SCAN_BUDGET = 40_000_000;
const REFUSED_KEPT = 64;
const REFUSED_MS = 2 * 60_000;

export class Sessions extends EventEmitter {
  // delivered run -> styleChangedOutside() when it went out; memory only, so a run reloaded after a restart has none and is not flagged
  #styleSeen = new WeakMap();
  // delivered run -> guideChangedOutside() when it went out (the same idea for voice-guide.json); taking it also arms the guide's guard
  #guideSeen = new WeakMap();
  // the last outline built for an agent Onionskin started: {key, sha, all} (one entry; ceiling: two such agents in turn build twice)
  #outline = null;
  // `anchors`: the anchor worker's call (src/offload.js anchorsOffThread); a test passes its own to control when the work answers
  constructor({ now = Date.now, anchors = anchorsOffThread } = {}) {
    super();
    this.now = now;
    this.anchors = anchors;
    this.map = new Map(); // key -> session
    this.createdCopies = new Set(); // absolute paths of conflict copies THIS server wrote: the only paths `showCopy` will reveal
    this.editors = new Map(); // key -> id of the one browser tab that may edit (in memory only: a tab's id lives as long as its page)
    this.handovers = new Map(); // key -> {tab, until}: the tab another tab just took editing from (memory only), see handOver()
    this.briefed = new Map(); // key -> Set of holders that already received a complete batch in this session (memory only: a restarted server briefs again)
    // key -> how the file got from one version to the next, oldest first: {from, to, route: "apply", ops, partial, anchors} for an agent's
    // apply, {from, to, route: "commit"} for a commit, {from, to, route: "merge", stable} for a pass of the user's merge. The merge reads it
    // to know whether cell addresses still hold. Memory only (ops carry document text): after a restart there is no record, and edits are handed back.
    this.writes = new Map();
    this.exporting = new Set(); // keys with a tracked-changes copy being made: one at a time per file
    this.local = null; // the local runner's {wants(s, batch)} (src/local.js), set by the server; null: every batch goes to an agent
    this.agent = null; // the background agent runner's {viewFor(key)} (src/agent-runner.js), set by the server; null: no background agent
  }

  // ---- one editable tab per file -----------------------------------------------------------------------------
  /** A tab asks to be the editor. The first one wins; `takeover` is the user's explicit "Edit here instead". Returns whether this tab is the editor. */
  claimEditor(key, tab, { takeover = false } = {}) {
    const s = this.get(key);
    const cur = this.editors.get(key);
    if (s.closed) return false; // a closed session has no editor; the tab that reopens it claims it
    if (cur && cur !== tab && !takeover) return false;
    if (cur !== tab) {
      if (cur) this.handovers.set(key, { tab: cur, until: this.now() + HANDOVER_MS }); // the tab that lost editing may hand over its unsaved words once
      this.editors.set(key, tab);
      this.emit("change", s, "state");
    }
    return true;
  }

  /**
   * The tab that just lost editing to another ("Edit here instead") hands over the words it had not saved yet: once, within HANDOVER_MS, and
   * only that tab. Nothing another tab saved is replaced: a comment it made is added as a draft; words it typed into a draft nobody changed since
   * it last saved it (`base`, per comment) replace it; words typed into one the store holds otherwise become a new draft next to it; its note is merged into the stored one from the note it started from (`base`, src/notes.js mergeNote),
   * and the tab that edits now gets it as a note the server gave back (its stale save cannot overwrite it). Refused (409 `no_handover`) for
   * any other tab or later, and like a draft save past a cap (413, nothing changes). The page that cannot hand over keeps the words visible
   * with Copy my comments (web/src/App.jsx).
   */
  // key -> (tab -> {sent, seq}): the note the newest draft save of each tab carried, and the session `seq` it stored at (memory only, the last 8 tabs). A tab that hands over a note the server already took
  // from it (its save's answer was lost, so it did not know) hands over nothing new: whatever happened to that note since is not its loss
  #noteFrom = new Map();
  handOver(key, tab, { comments, note, base, baseSeq, noteRev } = {}) {
    const s = this.get(key);
    const h = this.handovers.get(key);
    if (!h || h.tab !== tab || h.until < this.now()) throw new HttpError(409, "This tab no longer edits the file.", { code: "no_handover" });
    if (!Array.isArray(comments)) throw new HttpError(400, "comments must be an array");
    const byId = new Map(s.comments.map((c) => [c.id, c]));
    const next = [...s.comments];
    for (const c of comments.filter((x) => x && typeof x === "object")) {
      const id = cutText(String(c.id), 64);
      const old = byId.get(id);
      const text = userText(c.text, COMMENT_TEXT_MAX);
      const del = s.deletedDrafts?.[id];
      if (!old && del === text) continue; // deleted in the tab that edits now, with these very words: it stays deleted
      if (!old) next.push(this.#draft(c, del === undefined ? id : cutText(`${id}~h${crypto.randomBytes(3).toString("hex")}`, 64), null)); // deleted there, with other words: these come back as a new draft
      else if (text === old.text) continue;
      else if (old.status === "draft" && !old.answer && typeof c.base === "string" && userText(c.base, COMMENT_TEXT_MAX) === old.text) next[next.indexOf(old)] = this.#draft(c, id, old); // nobody changed it since: the newer words replace it
      else next.push(this.#draft(c, cutText(`${id}~h${crypto.randomBytes(3).toString("hex")}`, 64), null));
    }
    if (next.length > COMMENTS_MAX) throw tooMany();
    for (const c of next) if (c.status === "draft" && jsonSize(c) > COMMENT_MAX) throw tooLarge("This draft");
    let text = s.note;
    const from = this.#noteFrom.get(key);
    const last = from?.get(tab);
    const already = typeof note === "string" && (last?.sent === userText(note, NOTE_MAX + 1) || this.#noteTaken(s, noteRev, tab)); // or a Send of that tab took it
    if (typeof note === "string" && note !== s.note && !already) {
      // what it started from: the note the page's box is based on (`base`) when that came from a state at or after that tab's last save
      // (`baseSeq`: the page took that save's answer, or something newer, as a Take back's); else the note that save carried (its answer
      // was lost, so the box is that note and what was typed since); with no save of that tab, what the page says
      const fresh = typeof base === "string" && Number.isSafeInteger(baseSeq) && (!last || baseSeq >= last.seq);
      const from = fresh ? base : last ? last.sent : typeof base === "string" ? base : "";
      const mine = noteOf(note);
      // the box was emptied here since (a Send took the note that tab started from): only what that tab added after it is handed over
      text = !s.note && from && mine.startsWith(from) ? mine.slice(from.length).replace(/^\s+/, "") : mergeNote(from, s.note, mine);
    }
    if ([...text].length > NOTE_MAX && [...text].length > [...s.note].length) throw noteTooLong(true);
    const before = s.note;
    this.#commitDraft(s, { comments: next, note: before }, null, tab, true);
    this.handovers.delete(key);
    if (text !== before) {
      this.#giveNote(s, text);
      this.#changed(s, "draft");
    } else this.emit("change", s, "draft");
    return s;
  }

  /** The tab's event stream ended (closed, reloaded): the file has no editor until a tab claims it. */
  releaseEditor(key, tab) {
    if (this.editors.get(key) !== tab) return;
    this.editors.delete(key);
    const s = this.map.get(key);
    if (s) this.emit("change", s, "state");
  }

  /** Browser routes that change the session refuse a tab that is not the editor (when a tab holds the file). */
  requireEditor(key, tab) {
    const cur = this.editors.get(key);
    if (cur && cur !== tab) throw new HttpError(409, "This file is open for editing in another tab. Use Edit here instead to take over.", { code: "not_editor" });
  }

  // ---- open ------------------------------------------------------------------------------------------------
  /**
   * open() as the server's routes call it: the file is first read in a worker thread with a time and memory limit (src/offload.js
   * readOffThread: the package check and every part the server reads later), so a slow or hostile file never stalls the server, and a
   * file no reader accepts is refused here, with the reason, instead of failing later at Send.
   */
  async openAsync(input, opts = {}) {
    const { real, format } = this.#checkInput(input);
    // A file that changes between the worker's reading and open()'s own (a swap, a save in progress) is read in the worker again, once:
    // open() never takes bytes the worker has not read, so nothing on this thread reads a version past the readers' caps.
    for (let attempt = 0; ; attempt++) {
      const bytes = readCapped(real);
      const sha = sha256(bytes);
      const known = this.#refused.get(`${format}:${sha}`);
      const r = known && this.now() - known.at < REFUSED_MS ? known : await readOffThread(bytes, format);
      if (r.ok) readInCaps(format, r.sha);
      if (!r.ok) {
        // the same bytes are refused again at once (an agent's polls fall back to opening a file that is not open, again and again)
        if (r.stage !== "busy") this.#refuse(`${format}:${sha}`, r);
        if (r.stage === "encoding") throw encodingRefusal(real, r);
        if (r.stage === "invalid") throw new HttpError(400, `Not a valid .${format}: ${r.error}`);
        if (r.stage === "busy") throw new HttpError(503, `Onionskin is busy opening other files: ${r.error}. Try again in a minute.`, { code: "busy" });
        const hint = r.stage === "timeout" || r.stage === "memory" ? " It may be damaged, or made to stall programs that read it." : "";
        throw new HttpError(400, `This file could not be opened: ${r.error}.${hint}`, { code: r.stage === "timeout" ? "open_timeout" : "unreadable" });
      }
      try {
        return this.open(input, { ...opts, checkedSha: r.sha, onlyChecked: true });
      } catch (err) {
        if (err?.extra?.code !== "changed_while_opening" || attempt >= 1) throw err;
      }
    }
  }

  // "<format>:<sha256>" -> what the open worker said about those bytes when it refused them, for REFUSED_MS (a refusal for time may not hold once the
  // Mac is less busy); at most REFUSED_KEPT, oldest dropped first
  #refused = new Map();
  #refuse(id, r) {
    if (r.at) return; // already a remembered answer
    this.#refused.delete(id);
    this.#refused.set(id, { ok: false, stage: r.stage, error: r.error, code: r.code, copyable: r.copyable, at: this.now() });
    if (this.#refused.size > REFUSED_KEPT) this.#refused.delete(this.#refused.keys().next().value);
  }

  /** The path checks of open(): the real path, its format and its lstat. Throws HttpError. */
  #checkInput(input) {
    let real;
    try {
      real = fs.realpathSync(path.resolve(input));
    } catch {
      throw new HttpError(404, `File not found: ${JSON.stringify(untrusted(input, 200))}`);
    }
    // a path with control or bidi characters would sit in the commands printed for the agent: refuse it up front
    if (hasControlChars(real)) throw new HttpError(400, "This file's path contains control or bidirectional-text characters. Rename or move the file and open it again.", { code: "unsafe_path" });
    const ext = path.extname(real).toLowerCase();
    if (REFUSED_EXTENSIONS.has(ext)) throw new HttpError(400, `${ext} (macro-enabled) files are refused`);
    if (Object.hasOwn(REFUSED_PAGES, ext)) throw new HttpError(400, REFUSED_PAGES[ext], { code: "refused_kind" });
    const format = formatOfExt(ext);
    if (!format) throw new HttpError(400, ONLY_FORMATS);
    let st;
    try {
      st = checkRegularOwned(real);
    } catch (err) {
      throw new HttpError(400, err.message);
    }
    return { real, format, st };
  }

  /** `opts.agent === "background"`: the person opened it from a terminal, so the server's background agent works on it (stored on the session). */
  open(input, opts = {}) {
    const { real, format, st } = this.#checkInput(input);
    const bytes = readCapped(real);
    const sha = sha256(bytes);
    // openAsync already read these exact bytes in a worker; for it, other bytes (the file changed since) go back to the worker. Any other
    // caller (tests, tools) gets the package check here.
    if (opts.onlyChecked && opts.checkedSha !== sha) throw new HttpError(409, "The file kept changing while Onionskin opened it. Open it again once it is saved.", { code: "changed_while_opening" });
    if (opts.checkedSha !== sha) {
      try {
        validatePackage(bytes, format);
      } catch (err) {
        if (err instanceof HtmlEncodingError) throw encodingRefusal(real, { error: err.message, code: err.code, copyable: err.copyable });
        throw new HttpError(400, `Not a valid .${format}: ${err.message}`);
      }
    }
    const key = sessionKey(real);
    let s = this.map.get(key);
    if (!s) {
      s = this.#load(key) || this.#fresh(key, real, format, sha);
      s.file = real;
      s.format = format;
      this.map.set(key, s);
    }
    s.snapshots = new Snapshots(key);
    if (!s.snapshots.index().some((e) => e.original)) s.snapshots.add(bytes, "original", { original: true });
    if (!s.delivered && s.baseSha !== sha) s.baseSha = sha; // the user re-opened: the file on disk is the base
    if (!s.delivered && s.histTip !== sha) {
      // history starts from the version the user opened (kept as a snapshot so a later outside change has a "before")
      try {
        if (!s.snapshots.has(sha)) s.snapshots.add(bytes, "opened");
      } catch {} // a full disk must not block opening
      s.histTip = sha;
    }
    s.mtimeMs = st.mtimeMs;
    s.closed = false;
    if (opts.agent === "background") s.openedFor = "background";
    s.mode = st.mode & 0o7777;
    this.#save(s);
    this.emit("change", s);
    return s;
  }

  #fresh(key, file, format, sha) {
    return {
      key, file, format, baseSha: sha, comments: [], note: "", queuedNote: "", edits: [], pending: null, delivered: null, queued: false,
      activity: [], view: null, closed: false, pollers: [], seq: 0, createdAt: this.now(), history: [], histTip: null,
    };
  }

  #load(key) {
    try {
      const f = path.join(sub("sessions"), `${key}.json`);
      const j = JSON.parse(fs.readFileSync(f, "utf8"));
      const s = { ...this.#fresh(key, j.file, j.format, j.baseSha), ...j, pollers: [] };
      // a hard kill can leave work in flight that no result will ever settle
      if (s.delivered?.stage === "checking") s.delivered.stage = "writing";
      if (s.delivered?.local) {
        // the local runner died with the server. Not yet writing: the batch waits for an agent, as if handed back. Writing: the lease
        // expires at the first tick, which records what was written (it needs the snapshots, which open() sets after this)
        if (s.delivered.stage === "delivered") this.#unDeliver(s);
        else s.delivered.lease.expiresAt = 0;
        try {
          this.#writeLease(s);
        } catch {} // the lease file is a mirror: a failure must not lose the session
      }
      for (const a of s.activity || []) {
        if (a.checks?.deep?.soffice !== "pending") continue;
        const deep = { ...a.checks.deep };
        delete deep.soffice;
        deep.skipped = [...(deep.skipped || []), { check: "soffice-convert", reason: "the server stopped before the check finished" }];
        a.checks = { ...a.checks, deep, notice: deepNotice(deep.skipped) };
      }
      return s;
    } catch {
      return null;
    }
  }

  #save(s) {
    const { raw, cut } = this.#encode(s);
    if (cut) Object.assign(s, cut); // in memory too
    writeStateFile(path.join(sub("sessions"), `${s.key}.json`), raw);
  }

  /**
   * The session file's text for `s`: {raw, cut}. The one cap on a session file (src/retain.js SESSION_MAX, in bytes): past it every
   * comment's page anchor and every typed edit are cut further (`cut`: those lists, for the caller to keep); nothing is dropped. Each part
   * is cut where it is stored, so this is a last line. `raw` can still be past the cap; a change the page asked for is then refused (#fits).
   */
  #encode(s) {
    const { pollers, snapshots, ...rest } = s;
    const raw = JSON.stringify(rest);
    if (Buffer.byteLength(raw) <= SESSION_MAX) return { raw, cut: null };
    const cut = {
      comments: rest.comments.map((c) => capComment({ ...c, anchor: c.anchor && { ...c.anchor, cut: true, quote: cutText(c.anchor.quote, 2000), paraText: cutText(c.anchor.paraText, 2000) } })),
      edits: rest.edits.map((e) => ({ ...e, before: cutText(e.before, 2000), after: cutText(e.after, 2000), cut: true })),
    };
    return { raw: JSON.stringify({ ...rest, ...cut }), cut };
  }

  /** Whether the session with `patch` fits its file once cut (#encode): checked before a change the page asked for touches anything. */
  #fits(s, patch) {
    return Buffer.byteLength(this.#encode({ ...s, ...patch }).raw) <= SESSION_MAX;
  }

  /** The page's typed edits since the last Send, as they are kept for the next batch: each field cut (src/retain.js), at most EDITS_MAX in all. */
  #editsToTake(s, edits) {
    return (Array.isArray(edits) ? edits.slice(0, Math.max(0, EDITS_MAX - s.edits.length)) : []).map(cleanEdit);
  }

  // ---- anchor work: the anchor worker, or this thread (src/anchor-work.js) ------------------------------------------------
  /**
   * The results of `tasks` on the version `sha` (`bytes`: a Buffer, or a function that returns it). With `prepared` (what the anchor
   * worker answered for the same tasks, src/session.js #offThread) they are taken from it, and nothing is read here: a task it has no
   * answer for (its work did not finish, or it was for another version) reads as not done. Without, they are worked out on this thread
   * under the request's budget, as the synchronous methods always did. Returns {read, outline, at(i)}.
   */
  #results(format, bytes, sha, tasks, prepared, { check = false } = {}) {
    if (prepared) {
      const ok = prepared.ok && prepared.sha === sha;
      return { read: ok ? prepared.read : null, outline: ok ? prepared.outline : null, at: (i) => (ok ? prepared.map.get(taskKey(tasks[i])) : undefined) };
    }
    // an HTML file is read in workers only (the parser is not on this thread): without the worker's answer the work is not done, and each
    // caller makes its anchors weaker, as when the worker did not finish
    if (format === "html") return { read: null, outline: null, at: () => undefined };
    const r = anchorWork({ format, bytes, sha, check, tasks, budget: SCAN_BUDGET });
    return { read: r.read, outline: null, at: (i) => r.results[i] };
  }

  /** Bytes about to become the file: what their reading found. Past a cap 422 (CapError); not read in time and never read whole before: 503. */
  #readVerdict(work, format, sha, refusal) {
    const read = work.read;
    if (read?.ok) return readInCaps(format, sha);
    if (read?.cap) throw new CapError(read.cap);
    if (read?.invalid) throw new HttpError(422, `${refusal}: ${untrusted(read.invalid, 200)}`, { code: "invalid_package" });
    if (verified.has(`${format}:${sha}`)) return; // the work did not finish, but this version was read whole within the caps before
    throw new HttpError(503, "Onionskin could not finish reading the file in time, so nothing was sent. Your comments are kept. Try again in a moment.", { code: "read_timeout" });
  }

  /** `job` ({source, check, tasks, outline}) in the anchor worker: {ok: true, sha, read, outline, map: task key -> result} or {ok: false, why}. */
  async #offThread(format, job) {
    const r = await this.anchors({ format, ...job });
    if (!r.ok) return { ok: false, why: r.failed };
    const map = new Map();
    job.tasks.forEach((t, i) => map.set(taskKey(t), r.r.results[i]));
    return { ok: true, sha: r.sha, read: r.r.read, outline: r.r.outline ?? null, map };
  }

  // the async methods of one file run in turn (another file's never wait for them); synchronous ones keep their own order
  #chains = new Map();
  #serial(key, fn) {
    const prev = this.#chains.get(key) || Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.then(() => {}, () => {});
    this.#chains.set(key, tail);
    tail.then(() => this.#chains.get(key) === tail && this.#chains.delete(key));
    return run;
  }

  /**
   * `fn` (a synchronous change the page asks for: a draft save, Take back, an answer) in this file's turn, as the server's routes call it.
   * One that arrives while a Send waits for the anchor worker is applied after that Send commits, against what it committed, as when Send
   * was synchronous. Never called from inside a turn (it would wait for itself).
   */
  inTurn(key, fn) {
    this.get(key);
    return this.#serial(key, () => fn());
  }

  /** setDraft() in this file's turn (the route POST /api/draft). */
  setDraftAsync(key, args) {
    return this.inTurn(key, () => this.setDraft(key, args));
  }

  /**
   * Resolves once every request of this file that arrived before now is answered, so a page that loads (or reloads) during a Send starts
   * from what it committed, never from the middle of it. Bounded: a Send plans its worker job at most twice, each within the worker's time
   * limit; past that the page gets the state as it is then.
   */
  async settled(key, ms = 2 * anchorTimeoutMs() + 5_000) {
    const tail = this.#chains.get(key);
    if (!tail) return;
    let timer;
    await Promise.race([tail, new Promise((r) => (timer = setTimeout(r, ms)))]);
    clearTimeout(timer);
  }

  /**
   * An agent Onionskin started polls while a batch waits for it (src/server.js /cli/poll): the outline its delivery carries is built in
   * the anchor worker first, so the delivery finds it (#withOutline's memo) instead of reading the file on this thread.
   */
  async outlineAhead(key, holder) {
    const s = this.get(key);
    if (!isAgentHolder(holder) || !s.pending || s.delivered || s.pending.instructions?.review || s.pending.instructions?.voice_request) return;
    const r = await anchorsOffThread({ format: s.format, source: { path: s.file }, tasks: [], outline: true });
    if (r.ok && r.r.read.ok && r.r.outline) this.#outline = { key: s.key, sha: r.sha, all: r.r.outline };
  }

  /** An agent Onionskin started is waiting for this file: its delivery carries the outline, which the anchor worker then builds too. */
  #wantsOutline(s) {
    return s.pollers.some((p) => isAgentHolder(p.holder));
  }

  get(key) {
    const s = this.map.get(key);
    if (!s) throw new HttpError(404, "no such session");
    return s;
  }
  byFile(input) {
    let real;
    try {
      real = fs.realpathSync(path.resolve(input));
    } catch {
      throw new HttpError(404, `File not found: ${input}`);
    }
    return this.get(sessionKey(real));
  }

  // ---- derived state ---------------------------------------------------------------------------------------
  state(s) {
    if (s.closed) return "closed";
    if (s.delivered) return s.queued ? "queued" : "working";
    if (s.pending) return "stranded";
    return s.pollers.length ? "listening" : "idle";
  }

  view(s) {
    const state = this.state(s);
    const lease = s.delivered ? s.delivered.lease : null;
    return {
      key: s.key,
      name: path.basename(s.file),
      file: s.file, // the absolute path (like copy_path): the page words the commands that reopen the file from any folder
      reopen: reopenCommand(s.file), // the exact command to paste in a terminal from any folder
      format: s.format,
      state,
      locked: !!s.delivered,
      local: !!s.delivered?.local, // the batch in flight is a run on this Mac (src/local.js), no agent: the page words the wait for it
      baseSha: s.baseSha,
      comments: s.comments,
      note: s.note,
      edits: s.edits.length,
      activity: s.activity,
      view: s.view,
      pollers: s.pollers.length,
      pendingBatchId: s.pending?.batch_id || null,
      deliveredBatchId: s.delivered?.batch.batch_id || null,
      leaseExpiresAt: lease?.expiresAt || null,
      // where the delivered batch is: "delivered" (an agent has it) | "writing" (apply/commit arrived) | "checking" (done is running its checks) | null (no batch delivered)
      stage: s.delivered?.local && s.delivered.stage === "delivered" ? "local" : (s.delivered?.stage ?? null),
      // "voice" while the batch in flight (waiting or delivered) asks for a draft of the voice guide: the page words the wait for it
      runKind: readOnlyKind(s.delivered?.batch ?? s.pending) === "voice" ? "voice" : null,
      strandedCommand: state === "stranded" ? `${PRODUCT.bin} poll ${shellQuote(s.file)}` : null,
      startCommand: state === "stranded" ? `${PRODUCT.bin} ${shellQuote(s.file)}` : null, // what a person types in a terminal to start an agent on this file
      seq: s.seq,
      // per tab, the newest Send (or quick fix's Use) of it that committed: {tab: {rev, noteRev}}. A page whose Send got no answer learns
      // from it whether that Send went through (web/src/App.jsx checkSent)
      sent: s.sent || {},
      editor: this.editors.get(s.key) || null,
      conflict: s.conflict || null,
      canReveal: canReveal(),
      // the agent's review cards (src/review.js); their ops stay on the server
      suggestions: (s.suggestions || []).map(({ op, acceptedBatch, ...c }) => c),
      changedOutside: !!this.watch?.outside(s), // src/watch.js: the file on disk is a version Onionskin does not know (a boolean only, never a name)
      // the background agent (src/agent-runner.js): {state, cli, show, activity, failure}; never a path, a holder id or agent text
      agent: this.agent ? this.agent.viewFor(s.key) : { state: "none", cli: null, show: false, activity: [], failure: null },
    };
  }

  #changed(s, event = "state") {
    s.seq++;
    this.#save(s);
    this.emit("change", s, event);
  }

  // ---- drafts ----------------------------------------------------------------------------------------------
  // key -> {tab, rev}: the newest save or Send a tab numbered (memory only: a reloaded page is a new tab and counts again). Saves and Sends
  // run in turn (inTurn), but two requests of one tab can still arrive out of order: an autosave sent just before Send was pressed can land
  // after the Send committed, and would put the note the Send took back in the box. One numbered at or below what the tab already sent
  // changes nothing (test/send-race.test.js).
  #revs = new Map();
  // s.sent = {tab: {rev, noteRev}}: per tab (the last SENT_TABS), the newest numbered Send (or Use) of it that committed, and the revision
  // of its note box the newest such Send took. Stored with the session, so a page still asking whether its Send went through gets the right
  // answer after the server restarts. A save of that tab whose note is that revision or older (its save on the way out while the Send was in
  // flight) leaves the note alone, and so does its handover: a note a Send delivered is never put back.
  #sentRev(s, { rev, tab, noteRev }, took = false) {
    if (!Number.isSafeInteger(rev) || typeof tab !== "string") return;
    const all = s.sent && typeof s.sent === "object" ? s.sent : {};
    const last = all[tab];
    if (last && last.rev > rev) return;
    const { [tab]: _, ...rest } = all;
    const entry = { rev, noteRev: took && Number.isSafeInteger(noteRev) ? noteRev : last?.noteRev ?? null };
    s.sent = Object.fromEntries([...Object.entries(rest), [tab, entry]].slice(-SENT_TABS));
  }
  /** Whether `noteRev` of `tab` is a note a committed Send of that tab already took (see s.sent). */
  #noteTaken(s, noteRev, tab) {
    const last = typeof tab === "string" ? s.sent?.[tab] : null;
    return Number.isSafeInteger(noteRev) && Number.isSafeInteger(last?.noteRev) && noteRev <= last.noteRev;
  }

  /**
   * Browser replaces its list of comments/pins and the overall note. Server-owned fields (status, results) are kept: a sent, queued or
   * finished comment is as the server holds it, whatever words the page sends for it. `note` absent (not a string): the stored note is
   * kept (the page's save while a Send is in flight, which took the note). `rev` (optional): see #revs. Every field is rebuilt from what
   * Onionskin reads (src/retain.js). Refused (413) before anything changes: more than COMMENTS_MAX comments, a note past NOTE_MAX, a
   * comment past COMMENT_MAX after its cuts, a session past SESSION_MAX after the writer's. Nothing is dropped or cut without a word.
   */
  setDraft(key, { comments, note, rev, tab, noteRev, seen, noteSeen } = {}) {
    const s = this.get(key);
    if (!Array.isArray(comments)) throw new HttpError(400, "comments must be an array");
    if (this.#overtaken(s, rev, tab, true)) return s;
    this.#commitDraft(s, this.#draftPlan(s, { comments, note: this.#noteTaken(s, noteRev, tab) ? undefined : note, seen, noteSeen, tab }), rev, tab);
    if (typeof note === "string" && tab) {
      const m = this.#noteFrom.get(key) || new Map();
      m.delete(tab);
      m.set(tab, { sent: userText(note, NOTE_MAX + 1), seq: s.seq, used: !this.#noteTaken(s, noteRev, tab) }); // see handOver and #draftPlan
      if (m.size > 8) m.delete(m.keys().next().value); // the tabs of one file: a handful
      this.#noteFrom.set(key, m);
    }
    return s;
  }

  /** Whether this tab already numbered a newer save or Send than `rev` (`orSame`: one numbered the same too). See #revs. */
  #overtaken(s, rev, tab, orSame = false) {
    if (!Number.isSafeInteger(rev)) return false;
    const last = this.#revs.get(s.key);
    return !!last && last.tab === tab && (orSame ? rev <= last.rev : rev < last.rev);
  }

  /**
   * What a draft save of `comments` and `note` would store, {comments, note}, with every limit checked and nothing changed. `note` absent:
   * the stored note. A note past NOTE_MAX is refused, except one not longer than the stored note (Take back can join notes past it: the
   * page saves the box it was given, and may shorten it).
   */
  #draftPlan(s, { comments, note, seen, noteSeen, tab }) {
    if (!Array.isArray(comments)) throw new HttpError(400, "comments must be an array");
    const list = comments.filter((c) => c && typeof c === "object");
    if (list.length > COMMENTS_MAX) throw tooMany();
    const long = typeof note === "string" && note.length > NOTE_MAX && note.length <= s.note.length;
    let text = typeof note !== "string" ? s.note : long ? userText(note, s.note.length) : noteOf(note);
    // the server gave a note back to the box (#giveNote) that the page had not seen when it sent this (`seen`: the newest session `seq` it
    // took): the page's note is merged into it, never put over it
    // (`noteSeen`: the newest state whose note the page's box took or is based on; a page can see a state and keep its own words)
    const given = s.noteGiven;
    const ns = Number.isSafeInteger(noteSeen) ? noteSeen : seen;
    if (typeof note === "string" && given && Number.isSafeInteger(ns) && ns <= given.seq) {
      // from the note the server held before the first give the page had not seen (`steps`: each give; a session stored before them has
      // the first one's only); or, when a save of this tab was merged in since (its answer still on its way), from the note that save
      // carried: the box is that note and what was typed since, and the stored note already has that save's words
      // (ceiling: the last 50 gives; past that, a page that saw none of the kept ones merges from the oldest note, as before `steps`)
      const hit = given.steps?.find((g) => g.seq >= ns);
      const first = hit && !(given.cut && hit === given.steps[0]) ? hit : given;
      const last = this.#noteFrom.get(s.key)?.get(tab);
      text = mergeNote(last?.used && last.seq > first.seq ? last.sent : first.before, s.note, text);
    }
    const prev = new Map(s.comments.map((c) => [c.id, c]));
    const next = list.map((c) => {
      const id = cutText(String(c.id), 64);
      const old = prev.get(id);
      return old && old.status !== "draft" ? old : this.#draft(c, id, old); // sent/queued/finished comments are frozen
    });
    // a comment on its way to the agent (in a waiting batch, or queued) stays whatever list a save carries: a save never changes what a
    // Send delivers (a page that had not seen it yet, after a reload, does not take it out of the batch). Nor does a save delete a draft
    // another tab wrote after the state its page took (`seen`): the page did not know of it (a window that handed over its words, the save
    // of a page that was left landing after the reloaded page loaded)
    const named = new Set(next.map((c) => c.id));
    const unseen = (c) => c.status === "draft" && Number.isSafeInteger(seen) && c.wroteBy && c.wroteBy.tab !== tab && c.wroteBy.seq > seen;
    for (const c of s.comments) if ((c.status === "sent" || c.status === "queued" || unseen(c)) && !named.has(c.id)) next.push(c);
    if (next.length > COMMENTS_MAX) throw tooMany();
    for (const c of next) if (c.status === "draft" && jsonSize(c) > COMMENT_MAX) throw tooLarge("This draft");
    return { comments: next, note: text, seen: Number.isSafeInteger(noteSeen) ? noteSeen : seen };
  }

  /**
   * The server puts `text` in the note box itself (Take back, a run that stopped with comments queued behind it, the Revert of a run on this
   * Mac). Until a save shows the page has seen it, a save of the note from the page is merged into it (#draftPlan): the note it had then is kept.
   */
  #giveNote(s, text) {
    if (text === s.note) return;
    const step = { seq: s.seq, before: s.note };
    if (s.noteGiven) {
      const steps = [...(s.noteGiven.steps || []), step];
      s.noteGiven = { ...s.noteGiven, seq: s.seq, steps: steps.slice(-50), ...(steps.length > 50 || !s.noteGiven.steps ? { cut: true } : {}) };
    } else s.noteGiven = { ...step, steps: [step] };
    s.note = text;
  }

  /** Stores a plan of #draftPlan as a draft save: refused (413) past the session cap before anything changes. */
  #commitDraft(s, plan, rev, tab, quiet = false) {
    // each draft remembers which tab last wrote its words, and when (#draftPlan: a save does not delete one its page has not seen)
    const prev = new Map(s.comments.map((c) => [c.id, c]));
    for (const c of plan.comments) {
      if (c.status !== "draft") continue;
      const old = prev.get(c.id);
      if (!old || old.status !== "draft" || old.text !== c.text) c.wroteBy = { tab: tab ?? null, seq: s.seq + 1 };
      else if (old.wroteBy && c !== old) c.wroteBy = old.wroteBy;
    }
    // the words of drafts this save deletes, by id (the last DELETED_KEPT): a window handing over words afterwards does not bring them back
    const kept = new Set(plan.comments.map((c) => c.id));
    const gone = [...prev.values()].filter((c) => c.status === "draft" && !kept.has(c.id));
    const deleted = gone.length ? Object.fromEntries([...Object.entries(s.deletedDrafts || {}), ...gone.map((c) => [c.id, c.text])].slice(-DELETED_KEPT)) : s.deletedDrafts;
    const patch = { comments: plan.comments, note: plan.note, seq: s.seq + 1, ...(deleted ? { deletedDrafts: deleted } : {}) };
    const { raw, cut } = this.#encode({ ...s, ...patch });
    if (Buffer.byteLength(raw) > SESSION_MAX) throw tooLarge("This draft");
    if (Number.isSafeInteger(rev) && !this.#overtaken(s, rev, tab)) this.#revs.set(s.key, { tab, rev }); // never lowered
    Object.assign(s, patch, cut || {});
    if (s.noteGiven && Number.isSafeInteger(plan.seen) && plan.seen > s.noteGiven.seq) delete s.noteGiven; // the page has seen it
    writeStateFile(path.join(sub("sessions"), `${s.key}.json`), raw);
    // `quiet`: a Send's (or a Use's) save, which its commit announces; an event for the moment between would show its note still in the box
    if (!quiet) this.emit("change", s, "draft");
  }

  /** One draft as stored, from the page's comment `c` (`old`: the stored draft of the same id, if any). */
  #draft(c, id, old) {
    const base = {
      id,
      kind: ["text", "element", "pin"].includes(c.kind) ? c.kind : "element",
      text: userText(c.text, COMMENT_TEXT_MAX),
      anchor: cleanPageAnchor(c.anchor), // the fields the server and the page read, each cut (src/retain.js)
      pin: c.pin && typeof c.pin === "object" ? cleanPin(c.pin) : null,
      pinNo: Number.isInteger(c.pinNo) ? c.pinNo : null,
    };
    // an answered question: the words, the question and the answer stay as the person left them (the page cannot change them)
    const keep = old?.skipLocal ? { skipLocal: true } : {}; // a reverted local run: the next Send of this comment goes to the agent
    if (old?.localHint && base.text === old.text) keep.localHint = old.localHint; // the words changed: the hint no longer applies
    if (old?.answer) return capComment({ ...base, text: old.text, status: "draft", durable: old.durable || null, question: old.question, answer: old.answer, ...keep });
    return capComment({ ...base, status: "draft", durable: old?.durable || null, ...keep });
  }

  /**
   * What a Send (or a quick fix's Use: `useId`, the stamp it delivers) stores before it commits, as #draftPlan: nothing changed.
   * Invariant: a Send commits exactly its own payload, whatever draft save is numbered before or after it. Normally its list and note
   * replace the stored ones, as a draft save does. When this tab already numbered a newer save (one sent after the Send was pressed whose
   * body arrived first, as a page's visibility-change save can), that save is the stored list and the Send is authoritative only for what
   * it delivers: the drafts it names (their words as the Send carried them) and its note. Everything else stays as the newer save left it:
   * a comment it added is a draft, one it deleted stays deleted (the page cannot delete what a Send in flight carries), its note (none:
   * it leaves the note to the Send). A Use delivers only its stamp, so then it changes nothing else, not the note either.
   */
  #sentPlan(s, { comments, note, rev, tab, seen, noteSeen, sends }, useId = null) {
    const list = Array.isArray(comments) ? comments : s.comments;
    // `sends` (optional): the ids the page holds read only for this Send, the drafts it means to deliver; a comment the page still showed as
    // queued or sent when Send was pressed (and could be typed into after) is not delivered by it
    const named = Array.isArray(sends) ? new Set(sends.slice(0, COMMENTS_MAX).map((id) => cutText(String(id), 64))) : null;
    if (!this.#overtaken(s, rev, tab)) {
      const plan = this.#draftPlan(s, { comments: list, note: typeof note === "string" ? note : s.note, seen, noteSeen, tab });
      return named && useId == null ? { ...plan, only: named } : plan;
    }
    const own = this.#draftPlan(s, { comments: list.filter((c) => c && typeof c === "object" && (useId == null || String(c.id) === useId)), note: useId == null && typeof note === "string" ? note : s.note, seen, noteSeen, tab });
    const mine = new Map(own.comments.map((c) => [c.id, c]));
    // `only`: the drafts this Send delivers (the others are the newer save's, and stay drafts)
    return { comments: s.comments.map((c) => (c.status === "draft" && mine.has(c.id) ? mine.get(c.id) : c)), note: own.note, only: new Set([...mine.keys()].filter((id) => !named || useId != null || named.has(id))) };
  }

  /** The drafts of `comments` a Send with `plan` delivers: all of them, or those it names when a newer save was stored first. */
  #delivers(comments, plan) {
    return comments.filter((c) => c.status === "draft" && (!plan.only || plan.only.has(c.id)));
  }

  /**
   * The 413 refusals of a Send, on the state its plan would make (nothing changed yet): the bytes past the cap, a note that joined with
   * the one waiting (the batch an agent has not taken, or the queued note during a run) would be past NOTE_MAX, a session that would not
   * fit its file. Run before the worker is asked and again at the commit, against the state then.
   */
  #sendLimits(s, plan, payload) {
    if (payload.bytes?.length > MAX_BYTES) throw new HttpError(413, TOO_BIG, { code: "too_large" });
    if (s.delivered) joinNotes(s.queuedNote, plan.note);
    else joinNotes(s.pending && !readOnlyKind(s.pending) ? s.pending.instructions?.overall_note || "" : "", plan.note);
    if (!this.#fits(s, { comments: plan.comments, edits: [...s.edits, ...this.#editsToTake(s, payload.edits)] })) throw tooLarge("This Send");
  }

  // ---- send ------------------------------------------------------------------------------------------------
  /**
   * payload: { baseSha, bytes?: Buffer, comments, note, edits: [{kind,before,after,label,location}], viewState }
   * Compare-and-swap on the disk hash. Returns the session.
   */
  send(key, payload) {
    return scanBudget(SCAN_BUDGET, () => this.#send(key, payload));
  }

  /**
   * send() as the server's route calls it: the reading of the bytes that become the file and every anchor of the batch are worked out
   * first, in the warm anchor worker with a time limit (src/offload.js anchorsOffThread), then send() commits with what came back and
   * reads nothing itself. Work that did not finish leaves its comments weaker (src/anchor-work.js weakDurable), never lost; bytes it
   * could not read in time are refused with "try again" unless that version was read whole before.
   * Invariant: a Send and the page's draft saves, Take back and answers of one file run in turn (inTurn), as when Send was synchronous.
   * The Send saves its list and note when its turn comes, then commits exactly that; whatever arrives meanwhile waits and is applied after
   * the commit, against what it committed. A page loaded meanwhile waits for it too (settled).
   */
  async sendAsync(key, payload) {
    const s = this.get(key);
    const hasBytes = !!payload.bytes?.length;
    if (s.closed || (s.delivered && hasBytes)) return this.send(key, payload); // refused there, before anything changes
    return this.#serial(key, async () => {
      // refused there, before anything changes: closed, or locked
      if (s.closed || (s.delivered && hasBytes)) return this.send(key, payload);
      // nothing is stored before the commit: the worker works on what the Send would store, every limit is checked on it first (a refusal
      // here changes nothing) and again at the commit
      let prepared = null;
      let html = {};
      for (let attempt = 0; attempt < 2; attempt++) {
        const queued = !!s.delivered;
        const plan = this.#sentPlan(s, payload);
        this.#sendLimits(s, plan, payload);
        if (s.format === "html") this.#htmlSendChecks(s, payload);
        const job = this.#sendJob(s, payload, plan);
        // an HTML file that is not queued: the person's text edits are written through the write check, and every anchor is made on the
        // version it was made on, then moved onto the bytes this Send writes (#htmlSendWork)
        if (s.format === "html" && !s.delivered) ({ prepared, html } = await this.#htmlSendWork(s, payload, job));
        else prepared = job ? await this.#offThread(s.format, job) : null;
        if (!!s.delivered === queued) break; // a run started or ended while it worked: plan again once, for the other case
      }
      return this.send(key, { ...payload, ...html, prepared });
    });
  }

  /** An HTML Send's own refusals, before any work: no bytes from the browser ever (PLAN-html 3.1), no text edits during a run (D5). */
  #htmlSendChecks(s, payload) {
    if (payload.bytes?.length && !payload.htmlChecked) throw new HttpError(400, "an HTML file's bytes never come from the page; send its text edits", { code: "no_bytes_for_html" });
    if (payload.htmlEdits?.length && s.delivered) throw new HttpError(423, s.delivered.local ? "the document is locked while a change is made on this Mac" : "the document is locked while the agent works", { code: "locked" });
  }

  /**
   * The work of an HTML Send that is not queued, off this thread (the parser exists only in workers):
   *  1. the person's text edits (R9), when there are any: on the version the page loaded, which must be the file on disk (else 409
   *     version_changed: the page reloads the view and places its edits again), applied by the write check in a worker (src/html-write.js
   *     checkedHtmlWrite "edits": one write, the proof, the inventory). Its bytes become the file at the commit (#takePage), which checks
   *     the disk hash again after these awaits (R12).
   *  2. the anchors: a page anchor names a node of ONE version (`location.version`, a node id means nothing in another). An anchor made on
   *     the version this Send writes is built there; one made on another version (a draft that outlived a reload, the typed edits'
   *     places when this Send changes the bytes) is built on that version first (the file on disk or a stored snapshot), then moved onto
   *     the bytes this Send writes (reanchor), as a queued comment is moved onto the agent's file at done.
   * Returns {prepared (what #offThread returns, keyed by this Send's own tasks), html: {bytes, htmlChecked} or {}}.
   */
  async #htmlSendWork(s, payload, job) {
    let disk;
    try {
      checkRegularOwned(s.file);
      disk = readCapped(s.file);
    } catch (err) {
      throw new HttpError(409, `cannot read the file: ${err.message}`, { code: "gone" });
    }
    const diskSha = sha256(disk);
    let target = { bytes: disk, sha: diskSha };
    let html = {};
    const edits = cleanHtmlEdits(payload.htmlEdits);
    if (edits.length) {
      if (payload.baseSha !== diskSha || edits.some((e) => e.versionSha !== diskSha)) throw new HttpError(409, VERSION_CHANGED, { code: "version_changed", diskSha });
      const c = await htmlWriteOffThread({ before: disk, edits: edits.map((e) => ({ nodeId: e.nodeId, text: e.newText, baseTextHash: e.baseTextHash })) });
      if (!c.ok) throw htmlEditRefusal(c);
      const bytes = Buffer.from(c.bytes.buffer, c.bytes.byteOffset, c.bytes.byteLength);
      target = { bytes, sha: sha256(bytes) };
      html = { bytes, htmlChecked: { from: diskSha, to: target.sha } };
    }
    const prepared = await this.#htmlAnchorWork(s, job.tasks, target, { disk, diskSha, check: true, outline: job.outline });
    return { prepared, html };
  }

  /**
   * `tasks` (build, reanchor and view tasks of one request) on the version `target` ({bytes, sha}), in the anchor worker, with every build
   * task whose page anchor was made on another version (`location.version`) built on that version first (`known.disk` when it is the file
   * on disk, else a stored snapshot) and moved onto `target`. One made on a version no longer stored is moved as a weak anchor (its quote
   * searched). Returns what #offThread returns, its map keyed by the tasks given.
   */
  async #htmlAnchorWork(s, tasks, target, { disk = null, diskSha = null, check = false, outline = false } = {}) {
    const elsewhere = new Map(); // version -> [task index]
    tasks.forEach((t, i) => {
      const v = t.op === "build" ? t.anchor?.location?.version : null;
      if (v && v !== target.sha) (elsewhere.get(v) || elsewhere.set(v, []).get(v)).push(i);
    });
    const moved = new Map(); // task index -> the durable made on its own version (null: not there; undefined: not worked out)
    for (const [v, list] of elsewhere) {
      const source = v === diskSha && disk ? { bytes: disk } : s.snapshots.has(v) ? { path: s.snapshots.blob(v), sha: v } : null;
      if (!source) continue;
      const r = await this.#offThread("html", { source, tasks: list.map((i) => tasks[i]) });
      if (r.ok && r.read?.ok) list.forEach((i) => moved.set(i, r.map.get(taskKey(tasks[i]))));
    }
    const asked = tasks.map((t, i) => {
      if (!elsewhere.size || !(t.op === "build" && t.anchor?.location?.version && t.anchor.location.version !== target.sha)) return t;
      const d = moved.get(i);
      return { op: "reanchor", c: { durable: usable(d) && d ? d : weakDurable("html", t.anchor), anchor: null } };
    });
    const r = await this.#offThread("html", { source: { bytes: target.bytes }, check, tasks: asked, outline });
    if (!r.ok) return r;
    const map = new Map();
    asked.forEach((t, i) => map.set(taskKey(tasks[i]), r.map.get(taskKey(t))));
    return { ...r, sha: target.sha, map };
  }

  /** What a Send asks of the anchor worker (the same tasks #send makes, for the list it would store), or null when it needs nothing read. */
  #sendJob(s, payload, plan) {
    if (s.delivered) {
      const need = this.#delivers(plan.comments, plan).filter((c) => !c.durable);
      if (!need.length || !s.snapshots.has(s.delivered.preSha)) return null;
      return { source: { path: s.snapshots.blob(s.delivered.preSha), sha: s.delivered.preSha }, tasks: need.map(buildTask) };
    }
    const { tasks } = this.#sendTasks(s, this.#editsToTake(s, payload.edits), payload.viewState, plan);
    const bytes = payload.bytes?.length ? payload.bytes : null;
    return { source: bytes ? { bytes } : { path: s.file }, check: true, tasks, outline: this.#wantsOutline(s) };
  }

  /** The tasks of a Send that is not queued: every comment that goes out (drafts, and those of a batch still waiting), the typed edits without an anchor yet, the view. */
  #sendTasks(s, newEdits, viewState, plan = { comments: s.comments }) {
    const go = new Set(this.#delivers(plan.comments, plan));
    const eligible = plan.comments.filter((c) => go.has(c) || c.status === "sent");
    const edits = [...s.edits, ...newEdits].filter((e) => !e.durable);
    const vs = cleanView(viewState);
    return { eligible, edits, vs, tasks: [...eligible.map(buildTask), ...edits.map((e) => ({ op: "build", anchor: editAnchor(e), pin: false })), ...(vs ? [{ op: "view", vs }] : [])] };
  }

  /**
   * The commit of a Send: the Send's own list and note are saved first (#sentPlan), then every draft goes out with the note. A batch still
   * waiting for an agent (not delivered) is replaced by one that carries its comments and its note, then this one's; during a run the
   * drafts and the note are queued after those already queued. Every 413 (#sendLimits) is refused before anything changes.
   */
  #send(key, payload) {
    const s = this.get(key);
    if (s.closed) throw new HttpError(409, "session closed", { code: "closed" });
    if (s.format === "html") this.#htmlSendChecks(s, payload);
    const hasBytes = !!payload.bytes?.length;
    if (s.delivered && hasBytes) throw new HttpError(423, s.delivered.local ? "the document is locked while a change is made on this Mac" : "the document is locked while the agent works", { code: "locked" }); // before touching any state
    // the Send's own list and note (#sentPlan), every limit checked on them before anything changes; then stored as a draft save is, so a
    // refusal after this (the file changed, could not be read in time) leaves them as editable drafts
    const plan = this.#sentPlan(s, payload);
    this.#sendLimits(s, plan, payload);
    this.#commitDraft(s, plan, payload.rev, payload.tab, true);
    try {
      return this.#sendCommit(s, payload, plan);
    } catch (err) {
      this.emit("change", s, "draft"); // refused after the save: the page's tabs see the drafts it stored (a Send that commits says so once, at the end)
      throw err;
    }
  }

  /** The rest of #send, once its list and note are stored: the batch (or the queue) and the commit. */
  #sendCommit(s, payload, plan) {
    if (s.delivered) {
      // queue: comments and note only. A new comment gets its durable anchor from the bytes the page shows (the pre-agent snapshot),
      // never from the disk, which the agent may already have changed; done() then moves it onto the post-agent file.
      const queuedNote = joinNotes(s.queuedNote, s.note); // before anything changes
      const fresh = this.#delivers(s.comments, plan);
      const need = fresh.filter((c) => !c.durable);
      if (need.length) {
        // no snapshot, or work that did not finish: the anchor stays unset, and done() builds it from the post-agent file
        const work = this.#results(s.format, () => s.snapshots.read(s.delivered.preSha), s.delivered.preSha, need.map(buildTask), payload.prepared);
        if (work.read?.ok) need.forEach((c, i) => (c.durable = usable(work.at(i)) ? work.at(i) : null));
      }
      for (const c of fresh) c.status = "queued";
      // the note belongs to the queued batch now; it leaves the box so the next Send does not repeat it
      s.queuedNote = queuedNote;
      s.note = "";
      if (fresh.length || s.queuedNote) s.queued = true; // a Send with nothing new queues nothing (no empty batch after this one)
      this.#sentRev(s, payload, true);
      this.#changed(s);
      this.#voice(s, { sent: fresh });
      return s;
    }
    // a batch still waiting for an agent is replaced: its comments go again (they are "sent"), and so does its note, first
    const waiting = s.pending && !readOnlyKind(s.pending) ? s.pending.instructions?.overall_note || "" : "";
    const note = joinNotes(waiting, s.note); // before anything is written
    // the bytes that become the file are read whole before anything is written (one past a reader's cap is refused: CapError, nothing
    // changes), and every anchor of the batch is built from them, by the anchor worker (sendAsync) or here
    const newEdits = this.#editsToTake(s, payload.edits);
    const { eligible, edits, vs, tasks } = this.#sendTasks(s, newEdits, payload.viewState, { ...plan, comments: s.comments });
    // what is stored must fit its file once cut (src/retain.js SESSION_MAX): checked before the file is written or anything changes
    if (!this.#fits(s, { comments: s.comments, edits: [...s.edits, ...newEdits] })) throw tooLarge("This Send");
    let work = null;
    const { diskSha, writtenSha, writeInfo, lastUpdate } = this.#takePage(s, payload, (b, sha) => {
      work = this.#results(s.format, b, sha, tasks, payload.prepared, { check: true });
      this.#readVerdict(work, s.format, sha, "refusing to write");
    });

    // user edits since the last Send (document-derived text) accumulate until a batch is delivered
    s.edits.push(...newEdits);
    // a comment whose anchor work did not finish goes out weaker (src/anchor-work.js weakDurable); a PPTX pin on a shape also remembers its slide
    eligible.forEach((c, i) => (c.durable = usable(work.at(i)) ? work.at(i) : weakDurable(s.format, c.anchor)));
    edits.forEach((e, i) => (e.durable = usable(work.at(eligible.length + i)) ? work.at(eligible.length + i) : weakDurable(s.format, editAnchor(e))));
    const v = vs ? work.at(eligible.length + edits.length) : null;
    s.view = !vs ? null : usable(v) ? v : { format: s.format, raw: vs };
    if (work.outline) this.#outline = { key: s.key, sha: writtenSha, all: work.outline };

    const batch = buildBatch({ file: s.file, format: s.format, baseSha: writtenSha, note, comments: eligible, edits: s.edits, style: styleNote(), guide: voiceGuide() });
    const sent = eligible.filter((c) => c.status === "draft");
    for (const c of eligible) {
      c.status = "sent";
      c.batchId = batch.batch_id;
    }
    s.note = ""; // the note moved into the batch: it is not asked for again
    // a voice guide request still waiting for an agent is replaced by this Send (as a waiting review is); its pasted texts go with it, so say so
    if (readOnlyKind(s.pending) === "voice") s.activity.unshift({ id: `r_${crypto.randomBytes(4).toString("hex")}`, kind: "voice", at: this.now(), batchId: s.pending.batch_id, summary: VOICE_REPLACED, results: [], flags: [{ code: "voice_request_replaced", severity: "warn" }], checks: null, changes: null, reverted: false });
    s.pending = batch;
    s.lastWrite = writeInfo;
    // a quick change (src/quick-plan.js): the note and the count the person saw on the button. Held for this Send only; it never enters the batch.
    const qc = payload.quick;
    if (qc && typeof qc === "object" && typeof qc.command === "string" && qc.command.length <= 300 && Number.isInteger(qc.count) && qc.count > 0 && qc.count <= 1e6) s.quickConfirm = { command: qc.command, count: qc.count };
    this.#deliverIfPolled(s);
    delete s.quickConfirm;
    delete s.skipLocalNote; // it held for this Send only (the decision for its batch is made)
    this.#sentRev(s, payload, true);
    this.#changed(s);
    this.#voice(s, { last: lastUpdate, diskSha, writtenSha, sent });
    if (this.state(s) === "stranded" && !s.pollers.length) this.emit("stranded", s); // nobody took it: the server may start its background agent
    return s;
  }

  /**
   * The page's bytes become the file, as at Send (and at a quick fix's Use): the disk read, the compare-and-swap against the version
   * the page loaded, the package check, the guarded replace, the "sent" snapshot, the new base and the person's own history update.
   * `check(bytes, sha)` (optional) sees the bytes that are about to be the file and their sha256, after the package check and before
   * anything is written, and may throw to refuse. Returns {disk, diskSha, written, writtenSha, writeInfo, lastUpdate}.
   */
  #takePage(s, payload, check = null) {
    const hasBytes = !!payload.bytes?.length;
    let disk;
    try {
      checkRegularOwned(s.file);
      disk = readCapped(s.file);
    } catch (err) {
      throw new HttpError(409, `cannot read the file: ${err.message}`, { code: "gone" });
    }
    const diskSha = sha256(disk);
    // an HTML file's text edits were applied by its write check (#htmlSendWork) to the version the page loaded: no bytes come from the page
    const htmlChecked = s.format === "html" ? payload.htmlChecked ?? null : null;
    if (diskSha !== payload.baseSha || (htmlChecked && htmlChecked.from !== diskSha)) {
      // an HTML page sent no bytes: nothing of its to keep as a copy (its edits stay in the page, which reloads and places them again)
      throw this.#outsideChange(s, { side: "user", bytes: s.format === "html" ? null : payload.bytes, diskSha, baseSha: payload.baseSha });
    }
    let written = disk;
    let writeInfo = null;
    if (hasBytes) {
      if (payload.bytes.length > MAX_BYTES) throw new HttpError(413, TOO_BIG, { code: "too_large" });
      if (s.format === "html") {
        if (htmlChecked?.to !== sha256(payload.bytes)) throw new HttpError(500, "an HTML file is written only after its write check", { code: "unchecked_write" });
      } else {
        try {
          validatePackage(payload.bytes, s.format);
        } catch (err) {
          throw new HttpError(422, `refusing to write: ${err.message}`, { code: "invalid_package" });
        }
      }
    }
    const writtenSha = hasBytes ? sha256(payload.bytes) : diskSha;
    if (htmlChecked && hasBytes) readInCaps("html", writtenSha); // the write check read these bytes whole within the limits
    if (check) check(hasBytes ? payload.bytes : disk, writtenSha);
    if (hasBytes) {
      writeInfo = this.#replace(s, payload.bytes, { expectSha: diskSha, label: "before send", side: "user", htmlChecked });
      written = payload.bytes;
    }
    s.snapshots.add(written, "sent");
    s.baseSha = writtenSha;
    const lastUpdate = s.history?.at(-1); // learning pairs an agent run with the person's edits right after it
    if (hasBytes && writtenSha !== diskSha) addUpdate(s, { kind: "user", before: diskSha, after: writtenSha }, this.now());
    s.histTip = writtenSha;
    return { disk, diskSha, written, writtenSha, writeInfo, lastUpdate };
  }

  /** Hands what this Send can teach (src/voice-learn.js) to the server's `voice` listener. Last in send(): learning never fails a Send. */
  #voice(s, info) {
    try {
      const job = voiceJob(s, info);
      if (job) this.emit("voice", job);
    } catch {}
  }

  // ---- merge what the user typed while the agent worked ---------------------------------------------------
  /**
   * The page kept editing while a batch was delivered. `bytes` is the page's document: the version it loaded (`baseSha`) plus the
   * user's edits; `edits` names the kinds of edits the page saw. The disk now holds the agent's version. What only the user changed
   * (DOCX paragraphs, formatting and moves: src/merge.js; XLSX cells: src/merge-xlsx.js; PPTX shape text: src/merge-pptx.js) is carried onto it as ops (same engine, expect, protected and package checks
   * as an agent's apply) and written as the user's own update. Refused while a batch is delivered (423): the page waits and asks
   * again. Returns {merged, unplaced, sha, same, mineSha, copy_name}.
   * The reading of the three versions within the readers' caps, the plan and the engine's run happen in a worker thread with a time and
   * memory limit (src/offload.js mergeOffThread): the server's thread stays free whatever the document. A merge that fails or runs out of
   * time writes nothing: the person's version is saved as a copy next to the file and the page keeps their edits (503 merge_failed).
   * One merge per session at a time (another is 423 locked; the page has only one in flight).
   */
  async mergeUserEdits(key, { baseSha, bytes, edits = [] }) {
    const s = this.get(key);
    if (s.closed) throw new HttpError(409, "session closed", { code: "closed" });
    if (s.delivered) throw new HttpError(423, s.delivered.local ? "a change is being made on this Mac" : "the agent is working", { code: "locked" });
    if (s.merging) throw new HttpError(423, "your edits are being merged already", { code: "locked" });
    // an HTML view is read only during a run (PLAN-html D5): nothing is typed to merge, and its bytes never come from the page
    if (s.format === "html") throw new HttpError(400, "an HTML file's edits are never merged: its view is read only while the agent works", { code: "not_for_html" });
    if (!/^[0-9a-f]{64}$/.test(baseSha)) throw new HttpError(400, "baseSha must be a sha256"); // it names a snapshot file
    if (!bytes?.length) throw new HttpError(400, "no document bytes");
    if (bytes.length > MAX_BYTES) throw new HttpError(413, TOO_BIG, { code: "too_large" });
    try {
      validatePackage(bytes, s.format);
    } catch (err) {
      throw new HttpError(422, `refusing to merge: ${err.message}`, { code: "invalid_package" });
    }
    let disk;
    try {
      checkRegularOwned(s.file);
      disk = readCapped(s.file);
    } catch (err) {
      throw new HttpError(409, `cannot read the file: ${err.message}`, { code: "gone" });
    }
    const diskSha = sha256(disk);
    if (diskSha === baseSha) return { same: true, merged: 0, unplaced: [], sha: diskSha, mineSha: null }; // the file did not change under the page
    if (diskSha !== s.baseSha) throw this.#outsideChange(s, { side: "user", bytes, diskSha, baseSha });
    let base;
    try {
      base = s.snapshots.read(baseSha);
    } catch {
      throw new HttpError(409, "the version this page started from is no longer stored", { code: "no_base" });
    }
    // the three versions are read whole within the readers' caps in the worker first (the page's version, a file swapped on disk and an
    // old snapshot alike): past one, the merge is refused with the reason and nothing is written
    let r;
    s.merging = true;
    try {
      r = await mergeOffThread({ format: s.format, base, mine: bytes, theirs: disk, name: path.basename(s.file), edits: editKinds(edits), agent: s.format === "xlsx" ? this.#writesBetween(s, baseSha, diskSha, disk) : null });
    } finally {
      s.merging = false;
    }
    if (r.cap) throw new CapError(r.cap);
    if (r.invalid) throw new HttpError(422, `refusing to merge: ${untrusted(r.invalid, 200)}`, { code: "invalid_package" });
    if (!r.ok) throw this.#mergeFailed(s, bytes, r);
    if (r.bytes) r.bytes = Buffer.from(r.bytes.buffer, r.bytes.byteOffset, r.bytes.byteLength); // a Uint8Array once it crossed threads
    if (s.closed) throw new HttpError(409, "session closed", { code: "closed" });
    if (s.delivered) throw new HttpError(423, s.delivered.local ? "a change is being made on this Mac" : "the agent is working", { code: "locked" }); // a batch was delivered while the engine ran
    // The page shows the first HELD_SHOWN items and drops its own version when it reloads. When the list stands for more than it
    // shows, the user's whole file is saved next to the original first. No copy, no merge: the edits stay in the page.
    let copy = null;
    if (r.copy || r.unplaced.length > HELD_SHOWN) {
      try {
        copy = writeSiblingCopy(s.file, bytes);
        this.createdCopies.add(copy.path);
      } catch (err) {
        throw new HttpError(409, `a copy of your version could not be saved: ${err.code || err.message}`, { code: "copy_failed" });
      }
    }
    s.snapshots.add(bytes, "mine"); // a second pass (the user typed during this one) starts from this version
    let sha = diskSha;
    if (r.bytes) {
      this.#replace(s, r.bytes, { expectSha: diskSha, label: "before merge", side: "user" });
      sha = sha256(r.bytes);
      s.snapshots.add(r.bytes, "merged");
      s.baseSha = sha;
      addUpdate(s, { kind: "user", before: diskSha, after: sha }, this.now());
      s.histTip = sha;
      this.#changed(s);
    }
    // the second pass compares this version of the page with the result: the sheets kept their addresses where this pass merged by address
    if (Array.isArray(r.stable)) this.#logWrite(s, { from: sha256(bytes), to: sha, route: "merge", stable: r.stable });
    return { same: false, merged: r.merged, unplaced: r.unplaced.slice(0, 50), sha, mineSha: sha256(bytes), copy_name: copy?.name ?? null };
  }

  /**
   * A merge that did not finish (out of time or memory, busy, crashed) or whose result the proof refused: nothing was written. The person's version is saved next to the
   * file (except when Onionskin was only busy) and the answer says so in words the page shows inside its own sentence ("could not be
   * merged into its version (...). Your edits are still in this page: download them before you reload.").
   */
  #mergeFailed(s, bytes, r) {
    if (r.failed === "busy") return new HttpError(503, "Onionskin is merging other files right now; nothing was written, so try again in a moment", { code: "merge_busy" });
    let copy = null;
    try {
      copy = writeSiblingCopy(s.file, bytes);
      this.createdCopies.add(copy.path);
    } catch {}
    // refused: the proof of the merge (src/merge-proof.js) could not account for every edit of the person's in the result; the reason
    // holds counts and kinds of edits, never their text
    const why = r.failed === "timeout" || r.failed === "memory" ? r.why : r.refused ? `the merged file could not be checked to hold every one of your edits (${r.refused})` : "the merge stopped with an error";
    return new HttpError(503, `${why}; nothing was written${copy ? `, and a copy of your version was saved as ${copy.name} next to the file` : ""}`, { code: "merge_failed", copy_name: copy?.name ?? null });
  }

  #logWrite(s, entry) {
    const list = this.writes.get(s.key) || [];
    list.push(entry);
    if (list.length > WRITES_KEPT) list.shift();
    this.writes.set(s.key, list);
  }

  /**
   * The recorded writes that lead from version `from` to version `to` (the file on disk, `disk`), oldest first, with the bytes an
   * apply write started from and produced; null when no chain of records connects them (a revert, a direct save, a restart, a pruned
   * snapshot). Hashes name content, so a chain found is what happened to the bytes, whatever the order of the runs.
   */
  #writesBetween(s, from, to, disk) {
    const list = this.writes.get(s.key) || [];
    const seen = new Set();
    const walk = (sha) => {
      if (sha === from) return [];
      if (seen.has(sha)) return null;
      seen.add(sha);
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].to !== sha) continue;
        const before = walk(list[i].from);
        if (before) return [...before, list[i]];
      }
      return null;
    };
    const chain = walk(to);
    if (!chain) return null;
    try {
      return chain.map((e) => (e.route === "apply" ? { ...e, from: s.snapshots.read(e.from), to: e.to === to ? disk : s.snapshots.read(e.to) } : e));
    } catch {
      return null;
    }
  }

  /**
   * The one write path of the session (Send, agent write, commit, revert): the advisory lock and the compare-and-swap cover the whole
   * replacement (see replaceGuarded). `expectSha` is the hash the caller compared against; a file that is different now, or becomes
   * different just before the rename, is not overwritten (the newer bytes are snapshotted) and the caller gets the 409 conflict.
   */
  #replace(s, bytes, { expectSha, label, side = null, htmlChecked = null }) {
    // R1, R12: an HTML file is written only with bytes its write check passed in a worker (agentWriteChecked); every other path refuses
    if (s.format === "html" && htmlChecked?.to !== sha256(bytes)) throw new HttpError(500, "an HTML file is written only after its write check", { code: "unchecked_write" });
    try {
      return replaceGuarded(s.file, bytes, {
        expectSha,
        snapshotBefore: (disk) => s.snapshots.add(disk, label),
        snapshotNewer: (newer) => s.snapshots.add(newer, "newer version found while writing"),
      });
    } catch (err) {
      if (err instanceof WriteConflict) throw this.#outsideChange(s, { side, bytes, diskSha: err.diskSha, baseSha: err.baseSha, message: err.message });
      if (err.code === "ENOSPC_SNAP") throw new HttpError(507, err.message);
      if (err.code === "LOCK_BUSY") throw new HttpError(409, err.message, { code: "write_busy" });
      if (err.code === "ACL_NOT_PRESERVED") throw new HttpError(409, err.message, { code: "acl_not_preserved" });
      if (err.code === "SYMLINK") throw new HttpError(409, `write failed: ${err.message}`, { code: "symlink" });
      throw new HttpError(500, `write failed: ${err.message}`, { code: "write_failed" });
    }
  }

  /**
   * The file on disk is not what the writer compared against: someone else changed it. The original is NOT touched. When `side` says whose
   * bytes these are ("user": the page's current bytes; "agent": the agent's candidate), they are saved as a sibling copy so nothing is lost,
   * and the 409 carries the copy's name and path (built by the server from the session's own file path). An agent-side conflict is also
   * recorded for the page: an activity entry and a banner. Returns the HttpError to throw.
   */
  #outsideChange(s, { side, bytes, diskSha, baseSha, message }) {
    let copy = null;
    let copyError = null;
    if (side && bytes?.length) {
      try {
        copy = writeSiblingCopy(s.file, bytes);
        this.createdCopies.add(copy.path);
      } catch (err) {
        copyError = `the copy could not be saved: ${err.code || err.message}`;
      }
    }
    const extra = { code: "conflict", diskSha, baseSha, side, copy_name: copy?.name ?? null, copy_path: copy?.path ?? null, copy_error: copyError, can_reveal: canReveal() };
    if (side === "agent") {
      const local = !!s.delivered?.local; // a change made on this Mac: no agent was involved
      const what = local ? "The change made on this Mac" : "The agent's write";
      const note = copy ? `Someone changed this file outside Onionskin. ${what} was not applied and your original file was left untouched. A copy with ${local ? "the change" : "the agent's edits"} was saved as ${copy.name} in the same folder.` : `Someone changed this file outside Onionskin. ${what} was not applied and your original file was left untouched.${copyError ? ` ${copyError}.` : ""}`;
      s.conflict = { side: "agent", ...(local ? { local: true } : {}), copyName: copy?.name ?? null, copyPath: copy?.path ?? null, copyError, at: this.now() };
      if (s.delivered) s.delivered.outsideChange = { copyName: copy?.name ?? null };
      s.activity.unshift({ id: `r_${crypto.randomBytes(4).toString("hex")}`, kind: "outside_change", at: this.now(), summary: userText(note, 600), flags: [{ code: "outside_change", severity: "warn" }], results: [] });
      this.#changed(s);
    }
    return new HttpError(409, message || "the file changed on disk since it was loaded", extra);
  }

  /** Reveal a conflict copy in the Finder. Only a path this server itself wrote is accepted; `open -R` gets it as an argument (no shell). */
  showCopy(p) {
    if (!this.createdCopies.has(String(p)) || !fs.existsSync(p)) throw new HttpError(404, "no such copy");
    const stub = env("OPEN_STUB"); // tests: record the path instead of launching Finder
    if (stub) {
      fs.appendFileSync(stub, `${p}\n`);
      return { ok: true, opened: true };
    }
    if (!canReveal()) return { ok: true, opened: false };
    execFile("/usr/bin/open", ["-R", p], () => {});
    return { ok: true, opened: true };
  }

  dismissConflict(key) {
    const s = this.get(key);
    s.conflict = null;
    this.#changed(s);
    return s;
  }

  /** The cheap early check: does the disk still hold the version the page loaded? (Not asked while a batch is delivered: the agent changes the disk then.) */
  staleCheck(key, loadedSha) {
    const s = this.get(key);
    const diskSha = sha256(readCapped(s.file));
    return { stale: !s.delivered && !!loadedSha && diskSha !== loadedSha, diskSha };
  }

  // ---- poll / delivery -------------------------------------------------------------------------------------
  /**
   * Registers a poller. Returns a handle {promise, cancel}. Resolves with the batch object, or {status:'superseded'|'closed'}.
   * ack=true acknowledges a finished run and renews the lease of a run in progress. compact=true (only `reply --then-poll` asks) lets a holder that was briefed already get the short form (see compactBatch);
   * every other poll, including a new agent conversation on the same file that shares the saved holder, gets the complete batch. full=true overrides compact.
   */
  poll(key, { ack = false, holder = "agent", full = false, compact = false } = {}) {
    const s = this.get(key);
    if (holder === LOCAL_HOLDER) throw new HttpError(400, "this holder id is reserved for Onionskin itself; poll with another one", { code: "reserved_holder" });
    // the background agent's holder is bound to its own file, and it never takes a file from an agent that polls it (that agent supersedes it instead)
    if (isBgHolder(holder) && holder !== bgHolder(key)) throw new HttpError(400, "this holder id is reserved for Onionskin itself; poll with another one", { code: "reserved_holder" });
    if (typeof holder === "string" && holder.startsWith(TERM_PREFIX) && holder !== termHolder(key)) throw new HttpError(400, "this holder id is reserved for Onionskin itself; poll with another one", { code: "reserved_holder" });
    if (isBgHolder(holder) && (s.pollers.some((p) => p.holder !== holder) || (s.delivered && !s.delivered.local && s.delivered.lease.holder !== holder))) {
      this.emit("superseded", s, holder);
      return { promise: Promise.resolve({ status: "superseded", next_step: "Another poller took over this file." }), cancel: () => {} };
    }
    // a background poll with no agent process behind it (the agent ended, its poll child lived on): answered closed, so no Send goes to nobody
    if (isBgHolder(holder) && this.agent?.alive && !this.agent.alive(key)) return { promise: Promise.resolve({ status: "closed", reason: "the agent was stopped" }), cancel: () => {} };
    if (ack && s.delivered && s.delivered.lease.holder === holder) this.#renew(s);
    let resolveFn;
    const promise = new Promise((r) => (resolveFn = r));
    for (const old of s.pollers.splice(0)) {
      old.resolve({ status: "superseded", next_step: "Another poller took over this file." });
      if (isBgHolder(old.holder) && old.holder !== holder) this.emit("superseded", s, old.holder);
    }
    const p = { holder, full, compact, resolve: resolveFn };
    s.pollers.push(p);
    if (s.closed) {
      s.pollers = s.pollers.filter((x) => x !== p);
      resolveFn({ status: "closed" });
    } else {
      this.#deliverIfPolled(s);
    }
    this.#changed(s);
    return {
      promise,
      cancel: () => {
        const before = s.pollers.length;
        s.pollers = s.pollers.filter((x) => x !== p);
        if (s.pollers.length !== before) this.#changed(s);
      },
    };
  }

  #deliverIfPolled(s) {
    if (!s.pending || s.delivered) return;
    if (this.#deliverLocal(s)) return;
    if (!s.pollers.length) return;
    const p = s.pollers.shift();
    const batch = s.pending;
    this.#deliverTo(s, batch, p.holder);
    s.pending = null;
    s.queued = false;
    this.#writeLease(s);
    this.#styleSeen.set(s.delivered, styleChangedOutside());
    this.#guideSeen.set(s.delivered, guideChangedOutside());
    // the poller gets a copy that carries this delivery's lease; the stored batch stays free of it
    // the commands in it carry this delivery's ticket (`--lease`), so an agent that runs them as printed names its own delivery
    const ticket = ticketOf(batch.batch_id, s.delivered.lease.token);
    const lease = { holder: p.holder, token: s.delivered.lease.token };
    const shown = this.#withOutline(s, batch, p.holder);
    const briefed = this.briefed.get(s.key) || this.briefed.set(s.key, new Set()).get(s.key);
    if (briefed.has(p.holder) && p.compact && !p.full) {
      p.resolve(compactBatch(shown, { file: s.file, ticket, lease }));
      return;
    }
    briefed.add(p.holder);
    p.resolve({
      ...shown,
      // a voice batch writes nothing, so it has no how_to_apply
      ...(batch.how_to_apply ? { how_to_apply: { ...batch.how_to_apply, command: batch.how_to_apply.command.replace(/( --ops \S+)/, `$1 --lease ${ticket}`), rules: batch.how_to_apply.rules.map((r) => r.replaceAll("<ticket>", ticket)) } } : {}),
      next_step: batch.next_step.replace(/( --results \S+)$/, `$1 --lease ${ticket}`).replaceAll("<ticket>", ticket),
      lease,
      lease_ticket: ticket,
    });
  }

  /**
   * An agent Onionskin started (its background holder or the Terminal form) cannot open the file, so each edit batch it receives, complete or
   * compact, also carries the outline of the file as it is now (the bytes its ops are checked against), with the target and expect of every
   * unit. As much as fits one shell output is inline; when that is not all of it, the complete outline (up to OUTLINE_FILE_MAX units) is
   * written to <state>/agents/<key>/outline/outline-<batch id>.jsonl (0600, atomic, one unit per line), the only folder that agent may read,
   * and the batch names it. Older outline files of the session go at each such delivery, and with the folder on Close.
   * Any other holder, a review (it has `units`) and a voice request (it quotes only the sources the person ticked) get the batch as stored.
   * A file that cannot be read gets no outline, and `outline_unavailable` says why (the agent declines what it cannot find); an outline file that cannot be written leaves the
   * inline part with `outline_more`. The outline is built in the anchor worker at Send, at done and before a poll's delivery (outlineAhead),
   * and found here by the file's hash. Ceiling: a delivery that finds none (a synchronous caller, or the file changed in between) reads and
   * parses the file on this thread, as a review does; upgrade path as in unitsOf.
   */
  #withOutline(s, batch, holder) {
    if (!isAgentHolder(holder) || batch.instructions?.review || batch.instructions?.voice_request) return batch;
    let all;
    try {
      checkRegularOwned(s.file);
      const bytes = readCapped(s.file);
      const sha = sha256(bytes);
      // the same version's outline is built once (an agent's polls and a Send's delivery read the same file), on the memo's reading of it
      if (this.#outline?.key === s.key && this.#outline.sha === sha) all = this.#outline.all;
      // an HTML file is never parsed on this thread: its outline comes from the anchor worker (Send, done, outlineAhead) or not at all
      else if (s.format === "html") return { ...batch, untrusted_document_evidence: { ...batch.untrusted_document_evidence, outline_unavailable: "Onionskin did not finish reading this page's outline in time. Use the anchors and their quotes; poll again for an outline." } };
      else {
        all = outlineOf(s.format, bytes, OUTLINE_FILE_MAX, unitsFor(s.format, bytes, sha));
        this.#outline = { key: s.key, sha, all };
      }
    } catch (err) {
      // the agent is told why it has no outline (a file changed past a reader's cap behind Onionskin, or gone), in the reader's plain words
      const why = err instanceof CapError ? `Onionskin cannot read this file: ${err.message}.` : "Onionskin cannot read this file as it is now.";
      return { ...batch, untrusted_document_evidence: { ...batch.untrusted_document_evidence, outline_unavailable: why } };
    }
    const inline = withOutline(batch, all, VOICE_BATCH_MAX_CHARS, { inlineMax: UNITS_MAX });
    const name = `outline-${batch.batch_id}.jsonl`;
    let dir = null;
    try {
      dir = fs.realpathSync(sub("agents", s.key, "outline")); // a real path: --restricted compares paths literally
      for (const n of fs.readdirSync(dir)) if (/^outline-.*\.jsonl$/.test(n) && n !== name) fs.rmSync(path.join(dir, n), { force: true });
    } catch {}
    if (!inline.untrusted_document_evidence.outline_more || !dir) return inline;
    const file = path.join(dir, name);
    try {
      writeStateFile(file, all.outline.map((u) => JSON.stringify(u)).join("\n") + "\n");
    } catch {
      return inline;
    }
    return withOutline(batch, all, VOICE_BATCH_MAX_CHARS, { inlineMax: UNITS_MAX, file: { path: file, units: all.outline.length } });
  }

  /**
   * The local runner (src/local.js) is asked once per batch id whether it does this whole batch on this Mac. Yes: the batch is delivered to
   * LOCAL_HOLDER with a fresh token, like an agent's delivery, and no poller is taken. The `local` event carries the ticket; the runner uses
   * only that. A batch that comes back (hand-back, lease expiry, restart) is never asked again, so it goes to the agent.
   */
  #deliverLocal(s) {
    const batch = s.pending;
    if (!this.local || s.decidedBatch === batch.batch_id) return false;
    s.decidedBatch = batch.batch_id;
    let yes = false;
    try {
      yes = this.local.wants(s, batch) === true;
    } catch {
      yes = false; // a predicate that throws means no
    }
    if (!yes) return false;
    this.#deliverTo(s, batch, LOCAL_HOLDER, { local: true, ...(s.quickConfirm ? { quick: s.quickConfirm } : {}) });
    s.pending = null;
    s.queued = false;
    this.#writeLease(s);
    this.emit("local", s, { batchId: batch.batch_id, token: s.delivered.lease.token });
    return true;
  }

  #deliverTo(s, batch, holder, extra = {}) {
    s.delivered = { batch, stage: "delivered", preSha: s.baseSha, knownSha: s.baseSha, deliveredAt: this.now(), edits: s.edits, lease: { holder, token: crypto.randomBytes(8).toString("hex"), expiresAt: this.now() + LEASE_MS() }, ...extra };
    s.edits = [];
  }

  /** A delivery that wrote nothing goes back: the batch is pending again (decided: the next delivery is an agent's), the typed edits are evidence again, queued comments are drafts again (as at lease expiry). */
  #unDeliver(s) {
    const d = s.delivered;
    if (!d.accept) s.pending = d.batch; // an accepted suggestion has nothing to ask an agent
    this.#backToDraft(s, d, true);
    s.decidedBatch = d.batch.batch_id;
    s.edits = [...d.edits, ...s.edits];
    s.delivered = null;
    this.#queuedToDrafts(s);
  }

  #queuedToDrafts(s) {
    if (s.queued) {
      for (const c of s.comments) if (c.status === "queued") c.status = "draft";
      this.#giveNote(s, [s.queuedNote, s.note].filter(Boolean).join("\n\n"));
      s.queuedNote = "";
    }
    s.queued = false;
  }

  /**
   * The local runner could not finish and nothing was written: the batch goes to the agent exactly as it would have (same batch, a new
   * lease when a poller takes it). Strict lease; refused (409 `written`) once the delivery wrote anything, which then finishes like a run.
   */
  handBack(key, claim) {
    const s = this.get(key);
    if (!s.delivered) throw new HttpError(409, "no batch is in progress for this file", { code: "no_batch" });
    this.#assertLease(s, { ...claim, strict: true });
    if (!s.delivered.local) throw new HttpError(409, "only a run on this Mac is handed back", { code: "not_local" });
    if ((s.delivered.knownSha ?? s.delivered.preSha) !== s.delivered.preSha) throw new HttpError(409, "the file was already written for this batch", { code: "written" });
    this.#unDeliver(s);
    this.#writeLease(s);
    this.#deliverIfPolled(s);
    this.#changed(s);
    return s;
  }

  /**
   * A batch made by Onionskin itself (idea 21's Accept: no instructions, the stored ops) run on this Mac with an agent's powers. Refused
   * while anything is delivered or waiting, so it never takes a Send's place. `job` stays in memory with the delivery and goes to the runner
   * with the `local` event. Returns the ticket.
   */
  startLocal(key, batch, job = null) {
    const s = this.get(key);
    if (s.closed) throw new HttpError(409, "session closed", { code: "closed" });
    if (s.delivered || s.pending) throw new HttpError(409, "a batch is already waiting or in progress for this file", { code: "busy" });
    if (!batch?.batch_id || batch.base_sha256 !== s.baseSha) throw new HttpError(409, "the batch is not for the current version of the file", { code: "stale_batch" });
    this.#deliverTo(s, batch, LOCAL_HOLDER, { local: true, accept: true, ...(job?.model === true ? { model: true } : {}) }); // model: the words come from the local writing model
    s.decidedBatch = batch.batch_id;
    this.#writeLease(s);
    this.#changed(s);
    const ticket = { batchId: batch.batch_id, token: s.delivered.lease.token, job };
    this.emit("local", s, ticket);
    return ticket;
  }

  /** A startLocal delivery that wrote nothing ends with no trace: nothing goes to an agent (there is nothing to ask it). Strict lease, like handBack. */
  dropLocal(key, claim) {
    const s = this.get(key);
    if (!s.delivered) throw new HttpError(409, "no batch is in progress for this file", { code: "no_batch" });
    this.#assertLease(s, { ...claim, strict: true });
    if (!s.delivered.accept) throw new HttpError(409, "only an accepted suggestion is dropped", { code: "not_local" });
    if ((s.delivered.knownSha ?? s.delivered.preSha) !== s.delivered.preSha) throw new HttpError(409, "the file was already written for this batch", { code: "written" });
    this.#settleCards(s, s.delivered, []); // nothing applied: the text there changed
    this.#backToDraft(s, s.delivered, true);
    s.edits = [...s.delivered.edits, ...s.edits];
    s.delivered = null;
    this.#writeLease(s);
    this.#deliverIfPolled(s);
    this.#changed(s);
    return s;
  }

  /**
   * An accepted run that ends without `done` (dropLocal, a restart, a lease expiry): the comment of a quick fix it carried is a draft
   * again, so the person can send it to the agent. `hint`: nothing was written, and the comment says so.
   */
  #backToDraft(s, d, hint) {
    if (!d?.accept) return;
    for (const c of s.comments) {
      if (c.batchId !== d.batch.batch_id || c.status !== "sent") continue;
      c.status = "draft";
      delete c.batchId;
      if (hint) c.localHint = LOCAL_HINT;
    }
  }

  #writeLease(s) {
    const f = path.join(sub("leases"), `${s.key}.json`);
    if (!s.delivered) {
      try {
        fs.unlinkSync(f);
      } catch {}
      clearTickets(s.key);
      return;
    }
    // a local delivery's token lives in the server's memory only: no `status --ticket` can hand it to an agent
    if (!s.delivered.local) saveTicket(s.key, { batchId: s.delivered.batch.batch_id, holder: s.delivered.lease.holder, token: s.delivered.lease.token });
    writeStateFile(f, JSON.stringify({ holder: s.delivered.lease.holder, expiresAt: s.delivered.lease.expiresAt, baseSha256: s.delivered.preSha }));
  }

  #renew(s) {
    s.delivered.lease.expiresAt = this.now() + LEASE_MS();
    this.#writeLease(s);
    this.#changed(s);
  }

  /** Called on a timer: a delivered batch whose lease expired goes back to pending (stranded) and the document unlocks. */
  tick() {
    for (const s of this.map.values()) if (s.delivered && s.delivered.lease.expiresAt <= this.now()) this.#expire(s);
  }

  /**
   * The background agent stopped while it held this batch (a crash, a refusal): end the delivery now instead of at lease expiry, with the
   * same steps as an expiry. A run that wrote is recorded with Revert; one that did not is pending again. Only the delivery's own holder.
   */
  releaseAgent(key, holder) {
    const s = this.get(key);
    if (!s.delivered) throw new HttpError(409, "no batch is in progress for this file", { code: "no_batch" });
    if (!isBgHolder(holder) || s.delivered.local || s.delivered.lease.holder !== holder) throw new HttpError(403, "another agent holds the lease for this batch", { code: "not_lease_holder" });
    this.#expire(s);
    return s;
  }

  #expire(s) {
    const local = !!s.delivered.local; // a run on this Mac: no agent in it
    const wrote = this.#recordMidRun(s, local ? "The change on this Mac stopped after it changed the file." : "The agent stopped responding after changing the file.", "lease_expired_mid_run");
    if (!s.delivered.accept) s.pending = s.delivered.batch; // a local run's batch was decided at its delivery: it goes to the agent now
    this.#backToDraft(s, s.delivered, !wrote);
    s.edits = [...s.delivered.edits, ...s.edits];
    const accepted = !!s.delivered.accept;
    s.delivered = null;
    // comments queued behind the expired run have no batch to ride in: they go back to drafts (with their note) instead of waiting for a done that cannot come
    this.#queuedToDrafts(s);
    s.activity.unshift({ id: `r_${crypto.randomBytes(4).toString("hex")}`, kind: "lease_expired", at: this.now(), summary: local ? (accepted ? (wrote ? "The change on this Mac stopped after it changed the file. Revert restores the earlier version." : "The change on this Mac did not finish. Nothing was written.") : "The change on this Mac did not finish. Your request is waiting for an agent.") : "The agent stopped responding. The batch is waiting for the next poll.", flags: [], results: [], ...(local ? { by: "local" } : {}) });
    this.#writeLease(s);
    this.#changed(s, wrote ? "reload" : "state");
  }

  // ---- agent write -----------------------------------------------------------------------------------------
  /** Moves the delivered batch to `stage` (see view().stage) and tells the page. No-op without a delivery or when it is already there. */
  setStage(key, stage) {
    const s = this.get(key);
    if (!s.delivered || s.delivered.stage === stage) return;
    s.delivered.stage = stage;
    this.#changed(s);
  }

  /**
   * Who may act on the delivered batch. A stale agent (its lease expired and the batch went to another poll) carries the old delivery's
   * token, so even the same batch id cannot be completed or written by it. Writers (agentWrite, noteApply) always pass `strict`: holder,
   * batch id and token are all required, a missing one is `missing_lease`. `done` is strict at the server route.
   */
  #assertLease(s, { holder, token, batchId, strict = false }, { staleOnHolder = false } = {}) {
    const d = s.delivered;
    if (strict && (!holder || !token || !batchId)) throw new HttpError(400, "holder, batch_id and lease_token are required: they come from the output of `poll`", { code: "missing_lease" });
    const stale = () => new HttpError(409, "this is not your delivery: the batch was taken back, finished or handed to another agent. Run poll again.", { code: "stale_batch" });
    if (batchId != null && batchId !== d.batch.batch_id) throw stale();
    if (holder != null && d.lease.holder !== holder) {
      if (staleOnHolder) throw stale();
      throw new HttpError(403, "another agent holds the lease for this batch", { code: "not_lease_holder" });
    }
    if (token != null && token !== d.lease.token) throw stale();
  }

  /**
   * The delivered batch, for its lease holder only (`GET /cli/batch` with a claim): holder, batch id and token are all required and checked
   * before anything of the batch is handed out, so `reply` and `apply` read no anchors, comments or file text for a delivery that is not theirs.
   */
  deliveredBatch(key, claim) {
    const s = this.get(key);
    if (!s.delivered) throw new HttpError(409, "no batch is delivered for this file, so the ticket is void", { code: "no_batch" });
    this.#assertLease(s, { ...claim, strict: true });
    return s.delivered.batch;
  }

  /**
   * `apply` through a live session: the single authority for the write. Accepted only while a batch is delivered (state working or
   * queued: both hold a live lease) and only for the lease holder; compare-and-swap on the disk hash; renews the lease.
   */
  agentWrite(key, { baseSha, bytes, holder, token, batchId, label = "before agent write", route = "commit", ops = null, partial = false, htmlChecked = null }) {
    const s = this.get(key);
    if (s.closed) throw new HttpError(409, "session closed", { code: "closed" });
    const state = this.state(s);
    if (!s.delivered) throw new HttpError(409, `no batch is delivered to an agent (state: ${state}); run poll and wait for the user's Send`, { code: "not_working", state });
    this.#assertLease(s, { holder, token, batchId, strict: true });
    const readOnly = readOnlyKind(s.delivered.batch);
    if (readOnly) throw new HttpError(409, READ_ONLY[readOnly], { code: `${readOnly}_only` });
    // `commit` does not know the hash its candidate was edited from: the base is the last hash this server wrote or served for the delivery
    if (baseSha == null) baseSha = s.delivered.knownSha ?? s.delivered.preSha;
    if (!bytes?.length) throw new HttpError(400, "no bytes");
    if (bytes.length > MAX_BYTES) throw new HttpError(413, TOO_BIG, { code: "too_large" });
    const newSha = sha256(bytes);
    if (s.format === "html") {
      // checked in a worker (agentWriteChecked) for exactly these bytes; the disk hash it was checked against is compared below
      if (htmlChecked?.to !== newSha) throw new HttpError(500, "an HTML file is written only after its write check", { code: "unchecked_write" });
    } else {
      try {
        validatePackage(bytes, s.format);
      } catch (err) {
        throw new HttpError(422, `refusing to write: ${err.message}`, { code: "invalid_package" });
      }
      // read whole before anything is written, as a Send's bytes are: bytes past a reader's cap are refused with the reason (CapError, 422
      // too_large), never written to leave the next outline, review and done without a reading. The reading is kept for them (unitsFor).
      readWhole(s.format, bytes, newSha);
    }
    let disk;
    try {
      checkRegularOwned(s.file);
      disk = readCapped(s.file);
    } catch (err) {
      throw new HttpError(409, `cannot read the file: ${err.message}`, { code: "gone" });
    }
    const diskSha = sha256(disk);
    if (diskSha !== baseSha) throw this.#outsideChange(s, { side: "agent", bytes, diskSha, baseSha, message: "the file changed on disk since apply read it" });
    // R12: the compare-and-swap again after the check's await: the version it checked against must still be the one on disk
    if (s.format === "html" && htmlChecked.from !== diskSha) throw this.#outsideChange(s, { side: "agent", bytes, diskSha, baseSha: htmlChecked.from, message: "the file changed on disk while the write was being checked" });
    this.setStage(key, "writing"); // only once the checks passed: a refused write does not claim to be writing
    const info = this.#replace(s, bytes, { expectSha: diskSha, label, side: "agent", htmlChecked });
    // what the merge may rely on later: the ops `apply` says it ran (checked against the bytes when a merge needs them), or that it was a commit
    const checked = route === "apply" && s.format === "xlsx" && Array.isArray(ops) && validateOps({ schema: "onionskin.ops/1", ops }).ok; // only the XLSX merge reads them
    this.#logWrite(s, checked ? { from: diskSha, to: newSha, route, ops, partial: partial === true, anchors: s.delivered.batch.untrusted_document_evidence?.anchors || [] } : { from: diskSha, to: newSha, route: route === "apply" ? "apply" : "commit", ops: null });
    s.delivered.knownSha = newSha;
    // the pre-agent version is what Revert restores: keep it the newest entry so many agent writes cannot prune it
    s.snapshots.touch(s.delivered.preSha);
    s.lastWrite = info;
    this.#renew(s);
    return { ok: true, sha256: newSha, lease_expires_at: s.delivered.lease.expiresAt };
  }

  /**
   * The agent's write (`/cli/agent-write`, `/cli/commit`) for every format. An HTML file's bytes first go through the write check
   * (src/html-write.js checkedHtmlWrite: decoding, limits, a parse, the charset rule, the inventory of active content) in a worker; the
   * bytes it returns (the charset declaration may be added) are then written by agentWrite, which checks the lease, the state and the
   * disk hash again after that await (R12). Other formats: agentWrite as it is.
   */
  async agentWriteChecked(key, args, check = htmlWriteOffThread) {
    const s = this.get(key);
    if (s.format !== "html") return this.agentWrite(key, args);
    // the cheap refusals first, so a write that cannot land costs no worker; agentWrite makes every one of them again after the await
    if (s.closed) throw new HttpError(409, "session closed", { code: "closed" });
    if (!s.delivered) throw new HttpError(409, `no batch is delivered to an agent (state: ${this.state(s)}); run poll and wait for the user's Send`, { code: "not_working", state: this.state(s) });
    this.#assertLease(s, { holder: args.holder, token: args.token, batchId: args.batchId, strict: true });
    if (!args.bytes?.length) throw new HttpError(400, "no bytes");
    let disk;
    try {
      checkRegularOwned(s.file);
      disk = readCapped(s.file);
    } catch (err) {
      throw new HttpError(409, `cannot read the file: ${err.message}`, { code: "gone" });
    }
    // the bytes checked are the ones whose hash agentWrite compares with the base and the disk after this await (from === disk === base)
    const c = await check({ before: disk, after: args.bytes });
    if (!c.ok) {
      // a refused write is part of the run's result: the page lists it with the run (the R1 sentence for active content), nothing was written
      if (c.code !== "check_failed" && s.delivered && !s.closed) {
        const p = cleanProblem({ key: `write:${c.code}`, op: args.route === "apply" ? "apply" : "commit", status: "refused", code: c.code, reason: c.reason });
        s.delivered.applyProblems = [...(s.delivered.applyProblems || []).filter((x) => x.key !== p.key), p].slice(0, 40);
        this.#changed(s);
      }
      throw new HttpError(c.code === "check_failed" ? 503 : 422, c.reason, { code: c.code, ...(c.reasons ? { reasons: c.reasons } : {}) });
    }
    return this.agentWrite(key, { ...args, bytes: c.bytes, htmlChecked: { from: sha256(disk), to: sha256(c.bytes) } });
  }

  /**
   * What `apply` could not do (refused by the engine, protected, anchor or expectation mismatch), told by the lease holder after each run
   * (also when nothing was written). Shown to the user with the activity entry at `done`.
   */
  noteApply(key, { holder, token, batchId, run = "", problems = [], applied = [] }) {
    const s = this.get(key);
    if (!s.delivered) throw new HttpError(409, "no batch is delivered to an agent", { code: "not_working" });
    this.#assertLease(s, { holder, token, batchId, strict: true });
    this.setStage(key, "writing");
    // problems are keyed by op: a later run replaces what an earlier run said about the same op, and an op that now applied clears it
    const fresh = problems.slice(0, 40).map((p) => cleanProblem(p, run));
    const settled = new Set([...fresh.map((p) => p.key), ...applied.slice(0, 200).map((k) => untrusted(k, 80))]);
    s.delivered.applyProblems = [...(s.delivered.applyProblems || []).filter((p) => !settled.has(p.key)), ...fresh].slice(0, 40);
    this.#changed(s);
    return { ok: true };
  }

  // ---- done ------------------------------------------------------------------------------------------------
  /** The bytes `done` will analyze (null when the pre-agent version is gone), for the server to analyze off the event loop. Asserts the lease first. */
  analysisInputs(key, claim) {
    const s = this.get(key);
    if (!s.delivered) throw new HttpError(409, "no batch is in progress for this file (taken back or already finished)", { code: "no_batch" });
    this.#assertLease(s, claim, { staleOnHolder: true });
    this.setStage(key, "checking");
    let post;
    let pre;
    try {
      post = readCapped(s.file);
      pre = s.snapshots.read(s.delivered.preSha);
    } catch {
      return null; // done() states what it could not read
    }
    const readOnly = readOnlyKind(s.delivered.batch);
    if (readOnly === "voice") return null; // a voice run writes nothing; a file changed anyway is recorded by done, not analyzed
    if (readOnly === "review" && sha256(post) === s.delivered.preSha) return null; // a review that wrote nothing: nothing to check
    // deferSoffice: the LibreOffice conversion runs after `done` returns (startLateSoffice); ONIONSKIN_SOFFICE_SYNC=1 keeps it inline
    return { pre, post, format: s.format, postSha: sha256(post), batchId: s.delivered.batch.batch_id, deferSoffice: env("SOFFICE_SYNC", "") !== "1" };
  }

  /**
   * done() as the server calls it (src/server.js finishRun): the anchors of the comments queued during the run (moved onto the file the
   * agent leaves), a review's cards and the outline for a waiting agent are worked out first in the anchor worker, then done() commits
   * with them and reads none of it on this thread. Work that did not finish leaves those comments weaker, with a flag; never lost.
   */
  async doneAsync(key, results, claim = {}, analysis = null, opts = {}) {
    return this.#serial(key, async () => {
      const s = this.get(key);
      const run = s.delivered;
      const tasks = [];
      if (run && s.queued) tasks.push(...s.comments.filter((c) => c.status === "queued").map(reanchorTask));
      if (run?.batch.instructions?.review && s.review?.batchId === run.batch.batch_id && results && typeof results === "object") tasks.push(cardsTask(results, s.review, run));
      const prepared = run && (tasks.length || this.#wantsOutline(s)) ? await this.#offThread(s.format, { source: { path: s.file }, tasks, outline: this.#wantsOutline(s) }) : null;
      return this.done(key, results, claim, analysis, { ...opts, prepared });
    });
  }

  /** `inline: false` (the server): never analyze on this thread; an analysis for other bytes (the file changed while it ran) is a stated failure. */
  done(key, results, claim = {}, analysis = null, { inline = true, prepared = null } = {}) {
    const s = this.get(key);
    if (!s.delivered) throw new HttpError(409, "no batch is in progress for this file (taken back or already finished)", { code: "no_batch" });
    this.#assertLease(s, claim, { staleOnHolder: true });
    if (!results || typeof results !== "object") throw new HttpError(400, "results must be an object");
    const list = Array.isArray(results.results) ? results.results : [];
    const run = s.delivered;
    let post;
    try {
      post = readCapped(s.file);
    } catch (err) {
      throw new HttpError(409, `cannot read the file: ${err.message}`);
    }
    const postSha = sha256(post);
    if (readOnlyKind(run.batch) === "voice") return this.#doneVoice(s, results, run, post, postSha, prepared);
    // a review that wrote nothing ends with cards. One whose file changed anyway (a direct save past review_only) is finished as a run below:
    // its write is flagged and can be reverted, and no card is kept
    if (run.batch.instructions?.review && postSha === run.preSha) return this.#doneReview(s, results, run, post, prepared);
    s.snapshots.add(post, "after agent");

    // ---- plan: everything that can throw happens here, on locals; the session is not touched until the commit below ------
    let pre;
    try {
      pre = s.snapshots.read(run.preSha);
    } catch {
      pre = null;
    }
    // the analysis normally comes from the worker (server route); a call without one, or with one for other bytes, analyzes inline
    let found;
    if (!pre) found = { flags: [{ code: "no_pre_snapshot", severity: "warn" }], checks: { node: "skipped", deep: { status: "skipped", reason: "no pre-agent snapshot" }, notice: "Checks skipped: the pre-agent version is no longer stored." }, changes: null };
    else if (analysis && analysis.postSha === postSha && analysis.batchId === run.batch.batch_id) found = analysis;
    else if (!inline) {
      const why = "the file changed while it was being checked";
      found = { flags: [{ code: "checks_failed", severity: "warn", detail: why }], checks: { node: "failed", deep: { status: "skipped", reason: why }, notice: `The package checks did not finish: ${why}. The file was not verified.` }, changes: null };
    } else if (s.format === "html") {
      // an HTML file is read in workers only: a caller without the worker's analysis gets it stated as not run, never as clean
      const why = "the checks of an HTML file run in a worker";
      found = { flags: [{ code: "checks_failed", severity: "warn", detail: why }], checks: { node: "failed", deep: { status: "skipped", reason: why }, notice: `The checks did not run: ${why}. The file was not verified.` }, changes: null };
    } else found = analyze(pre, post, s.format);
    const flags = [...found.flags];
    const { checks, changes } = found;
    // the file must be what this server last wrote (apply/commit) or delivered; anything else changed it behind the lease (a direct save by
    // the agent's own library, or another program): the lost-update class the lease cannot see. Error severity, so Revert is recommended.
    if (postSha !== (run.knownSha ?? run.preSha)) flags.push({ code: "file_changed_outside_onionskin", severity: "error", detail: directSave(run.local) });
    if (run.outsideChange) flags.push({ code: "outside_change", severity: "warn", detail: run.local ? (run.outsideChange.copyName ? `The file was changed outside Onionskin while the change was made on this Mac; the changed version was saved as a copy: ${run.outsideChange.copyName}` : "The file was changed outside Onionskin while the change was made on this Mac; the change was not applied.") : run.outsideChange.copyName ? `The file was changed outside Onionskin while the agent worked; the agent's version was saved as a copy: ${run.outsideChange.copyName}` : "The file was changed outside Onionskin while the agent worked; the agent's write was not applied." });
    for (const p of run.applyProblems || []) flags.push({ code: p.status === "skipped_protected" ? "apply_skipped_protected" : "apply_not_applied", severity: p.status === "skipped_protected" ? "info" : "warn", op: p.op, status: p.status, ...(p.code ? { reason_code: p.code } : {}), detail: p.reason });
    const byId = new Map(s.comments.map((c) => [c.id, c]));
    const entries = [];
    const updates = [];
    const asks = this.#askPlan(s, run);
    for (const r of list.slice(0, 1000)) {
      const c = byId.get(String(r.comment_id));
      if (!c || !["done", "declined", "asked"].includes(r.status) || (r.status === "asked" && !asks.allowed(c))) {
        flags.push({ code: "unknown_result", severity: "warn", comment_id: String(r.comment_id).slice(0, 64) });
        continue;
      }
      if (r.status === "asked") {
        const q = asks.take(c, r);
        if (q.question) {
          updates.push({ c, status: "asked", result: undefined, question: q.question });
          entries.push({ comment_id: c.id, status: "asked", note: "" });
        } else {
          // the batch is not lost: the comment is declined with a fixed note, never the agent's text
          flags.push({ code: "bad_question", severity: "warn", comment_id: c.id, reason: q.code });
          updates.push({ c, status: "declined", result: BAD_QUESTION_NOTE });
          entries.push({ comment_id: c.id, status: "declined", note: BAD_QUESTION_NOTE });
        }
        continue;
      }
      const note = userText(r.note ?? "", 1000);
      updates.push({ c, status: r.status, result: note });
      entries.push({ comment_id: c.id, status: r.status, note });
    }
    for (const c of run.batch.instructions.comments) {
      if (!entries.some((e) => e.comment_id === c.id)) flags.push({ code: "no_result_for_comment", severity: "warn", comment_id: c.id });
    }
    // style.json changed by something else while this batch was out (an agent with a shell, say): already put back by src/style.js
    this.#guardFlags(run, flags);
    if (results.voice_draft !== undefined) flags.push({ code: "voice_draft_not_allowed", severity: "warn" }); // only a voice batch takes a draft; nothing is stored
    const queuedPlan = this.#planQueued(s, post, postSha, flags, prepared);
    if (prepared?.ok && prepared.sha === postSha && prepared.outline) this.#outline = { key: s.key, sha: postSha, all: prepared.outline };
    const cleanFlags = flags.map(cleanFlag);
    const { list: ignored, more: ignoredMore } = ignoredInstructions(results.document_instructions_ignored);
    const entry = {
      id: `r_${crypto.randomBytes(4).toString("hex")}`, kind: "agent", at: this.now(), batchId: run.batch.batch_id,
      summary: userText(typeof results.summary === "string" ? results.summary : "", 400), results: entries,
      // text in the document that tried to instruct the agent: agent-supplied, so sanitized like other untrusted text (5 items of 200 chars)
      ...(ignored.length ? { documentInstructionsIgnored: ignored, ...(ignoredMore ? { documentInstructionsIgnoredMore: true } : {}) } : {}), flags: cleanFlags, checks,
      revertRecommended: cleanFlags.some((f) => f.severity === "error"),
      changes,
      preSha: run.preSha, postSha, reverted: false,
      // a run on this Mac (src/local.js): the page titles it "Done on this Mac"; its note comes back to the box if the person reverts it
      ...(run.local ? { by: "local", localNote: userText(run.batch.instructions?.overall_note || "") } : {}),
    };

    // ---- commit: assignments only ------------------------------------------------------------------------------------
    for (const u of updates) {
      u.c.status = u.status;
      u.c.result = u.result;
      if (u.question) u.c.question = u.question;
    }
    if (run.accept) {
      this.#settleCards(s, run, Array.isArray(results.accepted) ? results.accepted : []);
      s.edits = [...run.edits, ...s.edits]; // an accepted suggestion carried none of the person's edits: they ride with the next Send
    }
    s.activity.unshift(entry);
    addUpdate(s, { kind: run.local ? "local" : "agent", before: run.preSha, after: postSha, summary: entry.summary, model: run.model === true }, this.now());
    s.histTip = postSha;
    s.baseSha = postSha;
    s.delivered = null;
    s.conflict = null;
    if (s.queued) {
      s.queued = false;
      if (queuedPlan) {
        for (const c of queuedPlan.queued) {
          c.durable = queuedPlan.durables.get(c.id);
          c.status = "sent";
          c.batchId = queuedPlan.batch.batch_id;
        }
        s.pending = queuedPlan.batch;
        s.queuedNote = "";
      }
    }
    this.#writeLease(s);
    this.#deliverIfPolled(s);
    this.#changed(s, "reload");
    return { ok: true, flags: cleanFlags, checks };
  }

  /**
   * The LibreOffice conversion result for a version `done` already accepted (activity entry checks.deep.soffice === "pending"). Recorded against
   * the entry of the version it checked. A failure that found something is an error flag (Revert offered like any error flag from done) only
   * while that run is still the latest and the file is still its version; after a newer write it is a warning on that run and changes nothing.
   * Never throws; false when the entry or session is gone or the entry was already settled.
   */
  recordLateCheck(key, { batchId, postSha, result }) {
    let s;
    try {
      s = this.get(key);
    } catch {
      return false;
    }
    const entry = s.activity.find((a) => a.kind === "agent" && a.batchId === batchId && a.postSha === postSha && a.checks?.deep?.soffice === "pending");
    if (!entry) return false;
    // current: still the latest run and the file is still its version. A next batch handed out meanwhile (comments queued during the run) changes nothing until its agent writes.
    const d = s.delivered;
    const current = s.baseSha === postSha && s.activity.find((a) => a.kind === "agent" && !a.reverted) === entry && (!d || (d.preSha === postSha && d.knownSha === postSha));
    const found = (result.flags || []).map((f) => cleanFlag(current || f.severity !== "error" ? f : { ...f, severity: "warn", detail: `${f.detail || ""} (the file has changed since this run)`.trim() }));
    const deep = { ...entry.checks.deep };
    delete deep.soffice;
    const skipped = [...(deep.skipped || [])];
    if (result.ran) deep.checks = [...(deep.checks || []), "soffice-convert"];
    else skipped.push({ check: "soffice-convert", reason: untrusted(result.reason || "did not run", 120) });
    deep.skipped = skipped;
    entry.checks = { ...entry.checks, deep, notice: deepNotice(skipped) };
    entry.flags = [...entry.flags, ...found];
    if (found.some((f) => f.severity === "error")) entry.revertRecommended = true;
    this.#changed(s);
    return true;
  }

  /**
   * Who `done` may mark `asked`, and how many. Only a comment of the delivered batch (never an unsent draft), never one that already
   * carries an answer (one question per comment), and at most QUESTIONS_PER_BATCH per `done` (the rule `reply` can check up front).
   * Ceiling: questions left open from two runs and answered together put more than three entries in one batch's `questions[]`; counting
   * open questions here would refuse asks that `reply` accepted. Pure: reads the session, changes nothing.
   */
  #askPlan(s, run) {
    const inBatch = new Map(run.batch.instructions.comments.map((c) => [c.id, c]));
    let open = 0;
    return {
      allowed: (c) => inBatch.has(c.id) && c.batchId === run.batch.batch_id,
      take: (c, r) => {
        if (inBatch.get(c.id).answer || c.answer) return { code: "already_asked" };
        const q = cleanQuestion({ ask: r.ask, options: r.options });
        if (!q.question) return q;
        if (open >= QUESTIONS_PER_BATCH) return { code: "too_many_questions" };
        open++;
        return q;
      },
    };
  }

  /**
   * The person tapped an option on a question card. `choice` is the index of the option (checked against the options this server
   * stored; option text is never taken from the page), or null for "Something else". An index keeps the question and sets the answer;
   * null drops the question. Either way the comment is a draft again, and the page sends it as usual.
   */
  answer(key, { id, choice }) {
    const s = this.get(key);
    if (s.closed) throw new HttpError(409, "session closed", { code: "closed" });
    const c = s.comments.find((x) => x.id === id);
    if (!c || c.status !== "asked" || !c.question) throw new HttpError(409, "this comment has no open question", { code: "not_asked" });
    if (choice !== null && !(Number.isInteger(choice) && choice >= 0 && choice < c.question.options.length)) throw new HttpError(400, "choice must be the number of one of the options, or null", { code: "bad_choice" });
    if (choice === null) {
      delete c.question;
      delete c.answer;
    } else c.answer = { choice };
    c.status = "draft";
    delete c.result;
    delete c.batchId;
    this.#changed(s, "draft");
    return s;
  }

  /** Comments queued while the agent worked become the next pending batch, anchored on the file the agent leaves. Pure planning: touches no session state; re-anchoring problems are pushed onto `flags`. */
  // `prepared`: the anchor worker's answer for the same tasks (doneAsync); without it the anchors are moved on this thread.
  #planQueued(s, post, postSha, flags, prepared = null) {
    let plan = null;
    if (s.queued) {
      const queued = s.comments.filter((c) => c.status === "queued");
      if (queued.length || s.queuedNote) {
        const work = this.#results(s.format, post, postSha, queued.map(reanchorTask), prepared);
        const read = work.read;
        if (!read?.ok) flags.push({ code: "queued_reanchor_failed", severity: "warn", detail: read?.invalid || read?.cap || "the anchors could not be worked out in time" });
        const durables = new Map();
        queued.forEach((c, i) => {
          const r = work.at(i);
          if (read?.ok && !usable(r)) flags.push({ code: "queued_reanchor_failed", severity: "warn", comment_id: c.id, detail: r?.error ?? "the anchor could not be worked out in time" });
          durables.set(c.id, read?.ok && usable(r) ? r : weakDurable(s.format, c.anchor));
        });
        const batch = buildBatch({ file: s.file, format: s.format, baseSha: postSha, note: s.queuedNote, comments: queued.map((c) => ({ ...c, durable: durables.get(c.id) })), edits: [], style: styleNote(), guide: voiceGuide() });
        plan = { queued, durables, batch };
      }
    }
    return plan;
  }

  // ---- review first (idea 21, src/review.js) ------------------------------------------------------------------
  /**
   * The person tapped a review button. The batch carries the fixed sentence for `kind` and the code-built outline of the file on disk; the
   * outline's index (where each unit is, its text hash) stays here. Refused while a batch waits or is delivered, and when the disk is not
   * the version the session knows. It goes to an agent, never to the local runner.
   */
  requestReview(key, kind) {
    const s = this.get(key);
    if (s.closed) throw new HttpError(409, "session closed", { code: "closed" });
    if (!REVIEW_KINDS.includes(kind)) throw new HttpError(400, `kind must be one of ${REVIEW_KINDS.join(", ")}`, { code: "bad_kind" });
    if (s.format === "html") throw new HttpError(409, "Review first is not available for HTML files in this version. Comment on the page and press Send.", { code: "not_for_html" }); // PLAN-html 2a: the page hides the button
    if (s.delivered || s.pending) throw new HttpError(409, s.delivered?.local ? "Wait for the change on this Mac to finish, then try again." : "Wait for the agent to finish, then try again.", { code: "busy" });
    let disk;
    try {
      checkRegularOwned(s.file);
      disk = readCapped(s.file);
    } catch (err) {
      throw new HttpError(409, `cannot read the file: ${err.message}`, { code: "gone" });
    }
    if (sha256(disk) !== s.baseSha) throw new HttpError(409, "The file changed outside Onionskin. Reload it, then try again.", { code: "changed_since" });
    s.pending = this.#reviewBatch(s, kind, disk, s.baseSha);
    this.#deliverIfPolled(s);
    this.#changed(s);
    return s;
  }

  #reviewBatch(s, kind, bytes, baseSha) {
    const { units, more, index } = unitsOf(s.format, bytes, unitsFor(s.format, bytes, baseSha));
    const batch = buildBatch({ file: s.file, format: s.format, baseSha, note: "", comments: [], edits: [], review: { kind, ask: REVIEW_ASKS[kind] }, units, unitsMore: more });
    s.review = { batchId: batch.batch_id, kind, units: units.map((u) => ({ id: u.id, protected: u.protected })), index };
    s.decidedBatch = batch.batch_id; // never the local runner's: only an agent reads the file
    return batch;
  }

  /** `done` of a review that wrote nothing: the suggestions become cards (checked against the file), an activity entry of kind "review", no history update. */
  #doneReview(s, results, run, post, prepared = null) {
    const flags = [];
    const ix = s.review?.batchId === run.batch.batch_id ? s.review : null;
    const gone = (why) => ({ cards: [], dropped: (Array.isArray(results.suggestions) ? results.suggestions : []).map((_, i) => ({ index: i, reason: why })) });
    let checked = gone("the review's outline is gone");
    if (ix) {
      const r = this.#results(s.format, post, run.preSha, [cardsTask(results, ix, run)], prepared).at(0);
      checked = usable(r) && r ? r : gone("the suggestions could not be checked against the file in time");
    }
    const { cards, dropped } = checked;
    for (const d of dropped) flags.push({ code: "bad_suggestion", severity: "warn", ...(d.index != null ? { index: d.index } : {}), reason: d.reason });
    if (results.voice_draft !== undefined) flags.push({ code: "voice_draft_not_allowed", severity: "warn" });
    const queuedPlan = this.#planQueued(s, post, run.preSha, flags, prepared);
    const cleanFlags = flags.map(cleanFlag);
    const { list: ignored, more: ignoredMore } = ignoredInstructions(results.document_instructions_ignored); // a review reads the whole file: its report counts most here
    const entry = {
      ...(ignored.length ? { documentInstructionsIgnored: ignored, ...(ignoredMore ? { documentInstructionsIgnoredMore: true } : {}) } : {}),
      id: `r_${crypto.randomBytes(4).toString("hex")}`, kind: "review", at: this.now(), batchId: run.batch.batch_id, reviewKind: run.batch.instructions.review.kind,
      summary: reviewSummary(cards.length), results: [], flags: cleanFlags, checks: null, changes: null, suggestions: cards.length, suggestionsDropped: dropped.length,
      preSha: run.preSha, postSha: run.preSha, reverted: false,
    };
    // ---- commit
    for (const g of s.suggestions || []) if (g.status === "open") g.status = "replaced";
    s.suggestions = [...cards, ...(s.suggestions || [])].slice(0, 3 * SUGGESTIONS_MAX);
    s.activity.unshift(entry);
    s.edits = [...run.edits, ...s.edits]; // the review carried none of the person's edits: they ride with the next Send
    s.delivered = null;
    s.review = null;
    if (s.queued) {
      s.queued = false;
      if (queuedPlan) {
        for (const c of queuedPlan.queued) {
          c.durable = queuedPlan.durables.get(c.id);
          c.status = "sent";
          c.batchId = queuedPlan.batch.batch_id;
        }
        s.pending = queuedPlan.batch;
        s.queuedNote = "";
      }
    }
    this.#writeLease(s);
    this.#deliverIfPolled(s);
    this.#changed(s); // nothing changed in the file: no reload
    return { ok: true, flags: cleanFlags, checks: null, suggestions: cards.length, dropped: dropped.length };
  }

  /**
   * The person tapped a card button: `choice` 0 = Accept (edit cards), 1 = Reject or Dismiss. "Show me" never reaches the server. Only ids
   * and an integer come from the page. Accept runs the stored ops on this Mac (startLocal: the lease, apply with --partial, done, Revert);
   * the cards stay open until that run settles them (accepted, or stale when the text there changed).
   */
  answerSuggestions(key, { ids, choice }) {
    const s = this.get(key);
    if (s.closed) throw new HttpError(409, "session closed", { code: "closed" });
    if (choice !== 0 && choice !== 1) throw new HttpError(400, "choice must be 0 (accept) or 1 (reject)", { code: "bad_choice" });
    if (!Array.isArray(ids) || !ids.length || ids.length > SUGGESTIONS_MAX || !ids.every((x) => typeof x === "string") || new Set(ids).size !== ids.length) throw new HttpError(400, `ids must list 1 to ${SUGGESTIONS_MAX} different suggestion ids`, { code: "bad_ids" });
    const cards = ids.map((id) => (s.suggestions || []).find((g) => g.id === id));
    if (cards.some((g) => !g)) throw new HttpError(400, "no such suggestion", { code: "unknown_suggestion" });
    if (cards.some((g) => g.status !== "open")) throw new HttpError(409, "this suggestion was already answered", { code: "not_open" });
    if (choice === 1) {
      for (const g of cards) g.status = g.kind === "note" ? "dismissed" : "rejected";
      this.#changed(s);
      return s;
    }
    if (cards.some((g) => g.kind !== "edit" || !g.op)) throw new HttpError(400, "a note cannot be accepted", { code: "not_acceptable" });
    if (s.delivered) throw new HttpError(423, s.delivered?.local ? "Wait for the change on this Mac to finish, then try again." : "Wait for the agent to finish, then try again.", { code: "locked" });
    if (s.pending) throw new HttpError(409, s.delivered?.local ? "Wait for the change on this Mac to finish, then try again." : "Wait for the agent to finish, then try again.", { code: "busy" });
    let disk;
    try {
      checkRegularOwned(s.file);
      disk = readCapped(s.file);
    } catch (err) {
      throw new HttpError(409, `cannot read the file: ${err.message}`, { code: "gone" });
    }
    if (sha256(disk) !== s.baseSha) throw new HttpError(409, "The file changed outside Onionskin. Reload it, then try again.", { code: "changed_since" });
    const batch = buildBatch({ file: s.file, format: s.format, baseSha: s.baseSha, note: "", comments: [], edits: [] });
    const n = cards.length;
    this.startLocal(key, batch, { ops: cards.map((g) => g.op), summary: `Accepted ${n} suggestion${n === 1 ? "" : "s"} from the agent's review.` });
    s.delivered.suggestionIds = ids; // settled by done or dropLocal
    this.#save(s);
    return s;
  }

  /**
   * "Use this" on a quick fix (idea 10 option A, src/suggest.js). `suggestion` is the server's stored record ({task, quote, location,
   * before, after}, from memory, handed over by src/suggest.js); the page sends only ids, its comments and its bytes. The page's unsent edits
   * are taken first, exactly as a Send takes them (#takePage); then one comment, whose words must be the server's own stamp words for the
   * task and whose anchor must be the one the suggestion was made for, becomes a batch of its own. The local runner writes it through
   * `reply` (one find and replace inside that paragraph or text box, the anchor's text hash as `expect`), apply's checks, the lease, `done`
   * and Revert, as for any local run. The text written is the stored suggestion, never text from the page. Every refusal happens before
   * anything is written. Other comments and the overall note stay for the next Send; typed edits ride with it too.
   */
  /**
   * useSuggestion() as the server's route calls it (src/suggest.js): where the suggestion goes in the bytes about to be the file, and
   * the one reply that writes it, are worked out in the anchor worker first. Work that did not finish writes nothing: the comment stays a
   * draft and says it can go to the agent, as when the sentence is not found.
   */
  async useSuggestionAsync(key, args) {
    const s = this.get(key);
    this.#useChecks(s, args); // refused before it waits its turn
    return this.#serial(key, async () => {
      const { id } = this.#useChecks(s, args);
      const { c } = this.#usePlan(s, args, id); // nothing is stored before the commit, as a Send (sendAsync)
      const bytes = args.bytes?.length && args.bytes.length <= MAX_BYTES ? args.bytes : null;
      const prepared = await this.#offThread(s.format, { source: bytes ? { bytes } : { path: s.file }, tasks: [useTask(c.anchor, args.suggestion, id)] });
      return this.useSuggestion(key, { ...args, prepared });
    });
  }

  /** The refusals of a quick fix's Use that need nothing read (useSuggestion runs them first). Returns {id}. */
  #useChecks(s, { suggestion: rec, commentId, comments }) {
    if (s.closed) throw new HttpError(409, "session closed", { code: "closed" });
    if (s.delivered || s.pending) throw new HttpError(409, "The agent started working on this file, so nothing was written. Ask the agent instead, or try again when it is done.", { code: "busy" });
    const words = rec && Object.hasOwn(STAMP_WORDS, rec.task) && rec.task !== "translate" ? STAMP_WORDS[rec.task] : null;
    if (!words || typeof rec.before !== "string" || typeof rec.after !== "string") throw new HttpError(409, "This suggestion is out of date. Tap the stamp again.", { code: "expired" });
    const id = String(commentId ?? "").slice(0, 64);
    const mine = Array.isArray(comments) ? comments.find((c) => c && String(c.id) === id) : null;
    const old = s.comments.find((c) => c.id === id);
    const sameAnchor = (a) => a && typeof a === "object" && a.quote === rec.quote && JSON.stringify(a.location ?? null) === JSON.stringify(rec.location ?? null);
    if (!mine || userText(mine.text) !== words || !sameAnchor(mine.anchor) || (old && old.status !== "draft")) throw new HttpError(409, "This comment is not the suggestion's stamp.", { code: "not_this_comment" });
    return { id };
  }

  /** What a Use stores before it commits (#sentPlan with its stamp), the stamp as planned, and every limit checked: nothing changed. */
  #usePlan(s, { comments, note, edits = [], rev, tab, seen, noteSeen, bytes = null }, id) {
    if (bytes?.length > MAX_BYTES) throw new HttpError(413, TOO_BIG, { code: "too_large" }); // before anything is stored, as a Send
    const saved = this.#sentPlan(s, { comments, note, rev, tab, seen, noteSeen }, id);
    const c = saved.comments.find((x) => x.id === id);
    if (c?.status !== "draft") throw new HttpError(409, "This comment is not the suggestion's stamp.", { code: "not_this_comment" });
    if (!this.#fits(s, { comments: saved.comments, edits: [...s.edits, ...this.#editsToTake(s, edits)] })) throw tooLarge("This request");
    return { saved, c };
  }

  useSuggestion(key, { suggestion: rec, commentId, comments, note, baseSha, bytes = null, edits = [], prepared = null, rev, tab, seen, noteSeen }) {
    const s = this.get(key);
    const { id } = this.#useChecks(s, { suggestion: rec, commentId, comments });
    // the page's list and note are saved first (only the stamp goes out), after every limit is checked on them
    this.#commitDraft(s, this.#usePlan(s, { comments, note, edits, rev, tab, seen, noteSeen, bytes }, id).saved, rev, tab, true);
    const c = s.comments.find((x) => x.id === id);
    let plan = null;
    // the place and the reply are worked out on the very bytes that are about to be the file (by the anchor worker, or here); any
    // refusal here writes nothing, and work that did not finish is "not here"
    const check = (b, sha) => {
      const r = this.#results(s.format, b, sha, [useTask(c.anchor, rec, id)], prepared).at(0);
      const { durable, place, reply } = usable(r) ? r : { durable: null, place: { ok: false, code: "not_here" }, reply: null };
      if (!place.ok) throw new HttpError(409, place.code === "protected" ? "This part of the file is protected, so it cannot be changed here." : LOCAL_HINT, { code: place.code });
      const batch = buildBatch({ file: s.file, format: s.format, baseSha: sha, note: "", comments: [{ ...c, durable }], edits: [] });
      if (!reply || batch.instructions.comments[0]?.reply_with !== "find_replace_or_text") throw new HttpError(409, LOCAL_HINT, { code: "not_here" });
      plan = { durable, reply, batch };
    };
    if (!this.#fits(s, { comments: s.comments, edits: [...s.edits, ...this.#editsToTake(s, edits)] })) throw tooLarge("This request"); // before anything is written
    let taken;
    try {
      taken = this.#takePage(s, { baseSha, bytes }, check);
    } catch (err) {
      // nothing was written: the comment stays a draft, and says it can go to the agent
      if (["not_here", "not_eligible", "protected"].includes(err?.extra?.code)) {
        c.localHint = LOCAL_HINT;
        this.#changed(s);
      } else this.emit("change", s, "draft"); // the drafts it stored
      throw err;
    }
    s.edits.push(...this.#editsToTake(s, edits));
    c.durable = plan.durable;
    c.status = "sent";
    c.batchId = plan.batch.batch_id;
    delete c.localHint;
    s.lastWrite = taken.writeInfo;
    this.#sentRev(s, { rev, tab });
    try {
      this.startLocal(key, plan.batch, { reply: plan.reply, summary: USE_SUMMARY, model: true }); // saves, tells the page, starts the runner
    } catch (err) {
      // not reachable after the checks above; if it were, the page's bytes are kept (they are the person's) and the comment is a draft again
      c.status = "draft";
      delete c.batchId;
      this.#changed(s);
      throw err;
    }
    return s;
  }

  /** An accepted run ended: its cards whose op applied are "accepted", the rest "stale". `applied` are op ids the runner read from apply's report. */
  #settleCards(s, run, applied) {
    const ids = new Set(run?.suggestionIds || []);
    const ok = new Set(applied.filter((x) => ids.has(x)));
    for (const g of s.suggestions || []) {
      if (!ids.has(g.id) || g.status !== "open") continue;
      g.status = ok.has(g.id) ? "accepted" : "stale";
      if (ok.has(g.id)) g.acceptedBatch = run.batch.batch_id;
    }
  }

  // ---- "Build my voice guide" (stage 2, src/voice-learn.js builds the batch) ------------------------------------------------
  /**
   * The person asked the agent for a draft of their voice guide. `batch` is buildVoiceBatch's (src/batch.js): code constants, their
   * approved guide and preferences, and the samples they ticked as evidence. Refused while a batch waits or is delivered, and when the file
   * on disk or the session moved on since the samples were taken. It goes to an agent, never to the local runner. While it is delivered
   * nothing may be written (409 voice_only), and `done` keeps the draft for the person's review (#doneVoice).
   */
  requestVoice(key, batch) {
    const s = this.get(key);
    if (s.closed) throw new HttpError(409, "session closed", { code: "closed" });
    if (readOnlyKind(batch) !== "voice") throw new HttpError(400, "not a voice guide request", { code: "bad_request" });
    if (s.delivered || s.pending) throw new HttpError(409, s.delivered?.local ? "Wait for the change on this Mac to finish, then try again." : "Wait for the agent to finish, then try again.", { code: "busy" });
    let disk;
    try {
      checkRegularOwned(s.file);
      disk = readCapped(s.file);
    } catch (err) {
      throw new HttpError(409, `cannot read the file: ${err.message}`, { code: "gone" });
    }
    // a file changed outside Onionskin would otherwise be blamed on the voice run when it ends; samples taken from an older version are not sent
    if (sha256(disk) !== s.baseSha || batch.base_sha256 !== s.baseSha) throw new HttpError(409, "The file changed outside Onionskin. Reload it, then try again.", { code: "changed_since" });
    s.pending = batch;
    s.decidedBatch = batch.batch_id; // never the local runner's: only an agent drafts a guide
    this.#deliverIfPolled(s);
    this.#changed(s);
    return s;
  }

  /**
   * `done` of a voice batch (the trust boundary for the draft). The draft is agent text: it is checked by cleanVoiceDraft and stored as
   * an untrusted draft (voice-draft.json) for the person to read, edit and approve, never copied into the saved guide: only their Save on
   * the page does that. Every other field the agent sends (a guide, `on`, `save`, results) changes nothing. An activity entry of kind
   * "voice" with a fixed summary, no history update and no analysis. A file that changed anyway (a direct save past voice_only) is
   * recorded as a withdrawn run would be: flagged, kept Revert-able.
   */
  #doneVoice(s, results, run, post, postSha, prepared = null) {
    const flags = [];
    for (const r of (Array.isArray(results.results) ? results.results : []).slice(0, 1000)) flags.push({ code: "unknown_result", severity: "warn", comment_id: String(r?.comment_id ?? "").slice(0, 64) });
    const check = cleanVoiceDraft(results.voice_draft); // size first, then hidden characters, links and markup, the layout, the caps
    if (check.code) flags.push({ code: "bad_voice_draft", severity: "warn", reason: check.code });
    this.#guardFlags(run, flags);
    const queuedPlan = this.#planQueued(s, post, postSha, flags, prepared);
    const { list: ignored, more: ignoredMore } = ignoredInstructions(results.document_instructions_ignored);
    // ---- commit: the draft file first (a failed write keeps nothing and says so), then the session
    let kept = false;
    if (!check.code) {
      try {
        writeDraft({ batch_id: run.batch.batch_id, text: results.voice_draft });
        kept = true;
      } catch {
        flags.push({ code: "voice_draft_not_saved", severity: "warn" });
      }
    }
    const cleanFlags = flags.map(cleanFlag);
    const wrote = postSha !== run.preSha && this.#recordMidRun(s, "The file changed while the agent drafted your voice guide.", "voice_run_changed_file");
    s.activity.unshift({
      ...(ignored.length ? { documentInstructionsIgnored: ignored, ...(ignoredMore ? { documentInstructionsIgnoredMore: true } : {}) } : {}),
      id: `r_${crypto.randomBytes(4).toString("hex")}`, kind: "voice", at: this.now(), batchId: run.batch.batch_id,
      summary: kept ? VOICE_KEPT : VOICE_REFUSED, results: [], flags: cleanFlags, checks: null, changes: null,
      preSha: run.preSha, postSha: run.preSha, reverted: false,
    });
    s.edits = [...run.edits, ...s.edits]; // the voice batch carried none of the person's edits: they ride with the next Send
    s.delivered = null;
    if (s.queued) {
      s.queued = false;
      if (queuedPlan) {
        for (const c of queuedPlan.queued) {
          c.durable = queuedPlan.durables.get(c.id);
          c.status = "sent";
          c.batchId = queuedPlan.batch.batch_id;
        }
        s.pending = queuedPlan.batch;
        s.queuedNote = "";
      }
    }
    this.#writeLease(s);
    this.#deliverIfPolled(s);
    this.#changed(s, wrote ? "reload" : "state"); // nothing changed in the file: no reload (as a review)
    return { ok: true, flags: cleanFlags, checks: null, voice_draft: kept ? "kept" : "refused" };
  }

  /** style.json and voice-guide.json changed by something else while this run was out (an agent with a shell, say): already put back by their stores. */
  #guardFlags(run, flags) {
    if (this.#styleSeen.has(run) && styleChangedOutside() > this.#styleSeen.get(run)) flags.push({ code: "style_changed_outside_onionskin", severity: "warn", detail: "Your writing preferences were changed outside Onionskin, so they were put back." });
    if (this.#guideSeen.has(run) && guideChangedOutside() > this.#guideSeen.get(run)) flags.push({ code: "voice_guide_changed_outside_onionskin", severity: "warn", detail: "Your voice guide was changed outside Onionskin, so it was put back." });
  }

  // ---- take back / revert / close -------------------------------------------------------------------------
  takeBack(key) {
    const s = this.get(key);
    const batch = s.delivered?.batch || s.pending;
    if (!batch) throw new HttpError(409, "nothing to take back");
    // the note travels back with the comments: the withdrawn batch's note, then a queued one, then whatever was typed since
    const notes = [batch.instructions?.overall_note, s.queuedNote, s.note].filter(Boolean);
    this.#giveNote(s, [...new Set(notes)].join("\n\n"));
    s.queuedNote = "";
    let event = "state";
    if (s.delivered) {
      // the typed edits stay as evidence for the next batch: they were saved into the file before this batch went out
      s.edits = [...s.delivered.edits, ...s.edits];
      if (this.#recordMidRun(s, s.delivered.local ? "Taken back mid-run: the change on this Mac had already changed the file." : "Taken back mid-run: the agent had already changed the file.", "taken_back_mid_run")) event = "reload";
    }
    for (const c of s.comments) if (["sent", "queued"].includes(c.status)) c.status = "draft";
    s.delivered = null;
    s.pending = null;
    s.conflict = null;
    s.queued = false;
    this.#writeLease(s);
    this.#changed(s, event);
    return s;
  }

  /**
   * The agent may have written before its batch was withdrawn (Take back, lease expiry): the page still shows the pre-agent copy. When the
   * disk differs from the pre-agent snapshot, keep that run Revert-able (an `agent` entry with the original preSha), make the new bytes the
   * base and say so; the caller emits `reload`. Returns whether anything changed on disk.
   * Ceiling: after a lease expiry the redelivered batch starts from these partial bytes, so Revert on ITS run returns to the partial state.
   */
  #recordMidRun(s, summary, code) {
    let disk = null;
    try {
      disk = readCapped(s.file);
    } catch {
      return false;
    }
    if (sha256(disk) === s.delivered.preSha) return false;
    try {
      s.snapshots.add(disk, "after agent (withdrawn)");
    } catch {} // a full disk must not block withdrawing; Revert will say the version is not stored
    const postSha = sha256(disk);
    const flags = [{ code, severity: "warn" }];
    // the same rule as done: bytes this server never wrote or delivered came from a direct save, not the agent's apply or commit
    if (postSha !== (s.delivered.knownSha ?? s.delivered.preSha)) flags.push({ code: "file_changed_outside_onionskin", severity: "error", detail: directSave(s.delivered.local) });
    s.activity.unshift({
      id: `r_${crypto.randomBytes(4).toString("hex")}`, kind: "agent", at: this.now(), batchId: s.delivered.batch.batch_id,
      summary, results: [], flags, checks: null,
      revertRecommended: true, changes: null, preSha: s.delivered.preSha, postSha, reverted: false,
      ...(s.delivered.local ? { by: "local", localNote: userText(s.delivered.batch.instructions?.overall_note || "") } : {}),
    });
    addUpdate(s, { kind: s.delivered.local ? "local" : "agent", before: s.delivered.preSha, after: postSha, summary }, this.now());
    s.histTip = postSha;
    s.baseSha = postSha;
    return true;
  }

  /** revert() as the server's route calls it: a waiting batch's anchors are moved onto the restored version in the anchor worker first. */
  async revertAsync(key, activityId) {
    return this.#serial(key, async () => {
      const s = this.get(key);
      const entry = s.activity.find((a) => a.id === activityId && a.kind === "agent");
      let prepared = null;
      if (entry && !entry.reverted && !s.delivered && s.pending && !readOnlyKind(s.pending) && !s.pending.instructions?.review && s.snapshots.has(entry.preSha)) {
        const tasks = this.#revertComments(s, entry).map(reanchorTask);
        if (tasks.length) prepared = await this.#offThread(s.format, { source: { path: s.snapshots.blob(entry.preSha), sha: entry.preSha }, tasks });
      }
      return this.revert(key, activityId, { prepared });
    });
  }

  /** The comments of the waiting batch, as revert() moves them: the run's comments become drafts first, so only the others are left. */
  #revertComments(s, entry) {
    const ids = new Set(s.pending.instructions.comments.map((c) => c.id));
    return s.comments.filter((c) => ids.has(c.id) && !(c.batchId === entry.batchId && ["done", "declined", "asked"].includes(c.status)));
  }

  revert(key, activityId, { prepared = null } = {}) {
    const s = this.get(key);
    if (s.delivered) throw new HttpError(423, s.delivered.local ? "a change is being made on this Mac" : "the agent is working", { code: "locked" });
    const entry = s.activity.find((a) => a.id === activityId && a.kind === "agent");
    if (!entry || entry.reverted) throw new HttpError(404, "nothing to revert");
    const mac = entry.by === "local"; // a change made on this Mac: no agent was involved, so the words do not say one was
    const latest = s.activity.find((a) => a.kind === "agent" && !a.reverted);
    if (latest !== entry) throw new HttpError(409, mac ? "only the latest change can be reverted" : "only the latest agent run can be reverted", { code: "not_latest" });
    const disk = readCapped(s.file);
    if (sha256(disk) !== entry.postSha) throw new HttpError(409, mac ? "the file changed after the change was made; revert refused" : "the file changed after the agent finished; revert refused", { code: "changed_since" });
    if (!s.snapshots.has(entry.preSha)) throw new HttpError(410, mac ? "the version before this change is no longer stored" : "the pre-agent version is no longer stored");
    const pre = s.snapshots.read(entry.preSha);
    // an HTML file: a revert restores the version before the run, by identity (the stored bytes must hash to the run's preSha), never
    // through the write check: that version was the file before (opened by the person or written after its own check), and checking it
    // against the run's result would refuse undoing a run that removed active content (the revert would "add" it back)
    let htmlChecked = null;
    if (s.format === "html") {
      if (sha256(pre) !== entry.preSha) throw new HttpError(410, mac ? "the version before this change is no longer stored" : "the pre-agent version is no longer stored");
      htmlChecked = { from: entry.postSha, to: entry.preSha };
    }
    this.#replace(s, pre, { expectSha: entry.postSha, label: "before revert", htmlChecked }); // a revert is a new version
    s.snapshots.add(pre, "reverted");
    s.baseSha = entry.preSha;
    addUpdate(s, { kind: "revert", before: entry.postSha, after: entry.preSha, local: mac }, this.now());
    s.histTip = entry.preSha;
    entry.reverted = true;
    // the run's comments were answered against a version that no longer exists: they are drafts again
    for (const c of s.comments) {
      if (c.batchId === entry.batchId && ["done", "declined", "asked"].includes(c.status)) {
        if (c.status === "asked") delete c.question; // asked about a version that no longer exists
        c.status = "draft";
        delete c.result;
        delete c.batchId;
        if (entry.by === "local") c.skipLocal = true; // the person undid what this Mac did: the next Send asks the agent
      }
    }
    for (const g of s.suggestions || []) if (g.status === "accepted" && g.acceptedBatch === entry.batchId) g.status = "open"; // the text is back: it can be accepted again
    if (entry.by === "local" && entry.localNote && !s.note) {
      this.#giveNote(s, entry.localNote); // the request comes back to the box, and the same words go to the agent next time
      s.skipLocalNote = entry.localNote;
    }
    // a batch built against the reverted version is rebuilt against the restored bytes (a review: its outline is read again; a voice
    // request keeps its samples, which left out what that run wrote, and points at the restored version)
    if (readOnlyKind(s.pending) === "voice") s.pending = { ...s.pending, base_sha256: entry.preSha };
    else if (s.pending?.instructions?.review) s.pending = this.#reviewBatch(s, s.pending.instructions.review.kind, pre, entry.preSha);
    else if (s.pending) {
      const ids = new Set(s.pending.instructions.comments.map((c) => c.id));
      const cs = s.comments.filter((c) => ids.has(c.id));
      // moved onto the restored version by the anchor worker (revertAsync) or here; one whose work did not finish goes out weaker
      const work = this.#results(s.format, pre, entry.preSha, cs.map(reanchorTask), prepared);
      if (work.read?.ok) cs.forEach((c, i) => (c.durable = usable(work.at(i)) ? work.at(i) : work.at(i)?.error ? null : weakDurable(s.format, c.anchor)));
      s.pending = buildBatch({ file: s.file, format: s.format, baseSha: entry.preSha, note: s.pending.instructions.overall_note, comments: cs, edits: [], style: styleNote(), guide: voiceGuide() });
      for (const c of cs) c.batchId = s.pending.batch_id;
    }
    s.activity.unshift({ id: `r_${crypto.randomBytes(4).toString("hex")}`, kind: "revert", at: this.now(), summary: mac ? "Reverted to the version before this change." : "Reverted to the version before the agent's run.", flags: [], results: [], postSha: entry.preSha });
    this.#changed(s, "reload");
    return s;
  }

  close(key) {
    const s = this.get(key);
    s.closed = true;
    this.#views.delete(key); // the render of an HTML file (htmlView)
    this.editors.delete(key); // the closed tab may stay on screen with its event stream open: it must not hold the file against the tab that reopens it
    for (const p of s.pollers.splice(0)) p.resolve({ status: "closed" });
    fs.rmSync(path.join(stateDir(), "agents", s.key, "outline"), { recursive: true, force: true }); // the outline files of Onionskin's own agent
    this.emit("closed", s); // the server ends background checks for this file
    this.#changed(s);
    return s;
  }

  /**
   * The page loads the file (first load, "Reload the changed file", a reload of the tab). When the disk holds a version history does not
   * know, someone changed it outside Onionskin and the user is now taking that version: store it and record an "outside" update
   * (before = the last version history knew, after = these bytes). Never while an agent works (the disk changes then by design).
   * Returns the same {diskSha, baseSha, bytes} as diskCheck.
   */
  loadForPage(key) {
    const out = this.diskCheck(key);
    const s = this.get(key);
    if (!s.delivered && !s.closed && s.histTip && out.diskSha !== s.histTip) {
      try {
        s.snapshots.add(out.bytes, "outside change");
        addUpdate(s, { kind: "outside", before: s.histTip, after: out.diskSha }, this.now());
        s.histTip = out.diskSha;
        this.#save(s);
      } catch {} // no space for the snapshot: nothing is recorded, the file still loads
    }
    this.watch?.taken(s); // src/watch.js: this version is Onionskin's own from now on
    return out;
  }

  // ---- the view of an HTML file (GET /api/html-view) ------------------------------------------------------------------------------
  // key -> {sha, full, plain}: the render of one version (promises, so two requests for it share one worker run); one version per file,
  // dropped when the file changes or the session closes. Ceiling: one entry per open HTML file, each up to ~43 MB (the render copy at the
  // limits): a person with many large pages open holds them all; an LRU over files would be the upgrade.
  #views = new Map();
  /**
   * The page's view of an HTML file (PLAN-html 3.2, R12): the disk bytes are taken as /api/file takes them (loadForPage: an outside change
   * is recorded, the watcher told), then the render copy of exactly those bytes is built in the render worker (src/offload.js
   * renderOffThread), or the plain copy with `plain`. Resolves to {sha, plain, reason, stats, texts, editable, ident, bytes}; throws HttpError
   * 422 with the encoding's sentence and code (and `copyable`) or a limit's, 503 when the worker was busy or did not finish.
   */
  async htmlView(key, { plain = false } = {}) {
    const s = this.get(key);
    if (s.format !== "html") throw new HttpError(400, "this file is not an HTML file", { code: "not_html" });
    const { bytes, diskSha } = this.loadForPage(key);
    let c = this.#views.get(key);
    if (!c || c.sha !== diskSha) this.#views.set(key, (c = { sha: diskSha, full: null, plain: null }));
    const k = plain ? "plain" : "full";
    if (!c[k]) {
      const p = renderOffThread({ bytes, fileDir: path.dirname(s.file), plain }).then((r) => {
        if (r.ok) return { sha: diskSha, plain: r.plain, reason: r.reason, stats: r.stats, texts: r.texts, editable: r.editable, ident: r.ident, bytes: r.bytes };
        if (c[k] === p) c[k] = null; // a failure is not kept: the next request tries again
        if (r.failed) throw new HttpError(503, `Onionskin could not prepare this page: ${r.why}. Try again in a moment.`, { code: r.failed === "busy" ? "busy" : "render_failed" });
        if (r.code === "not_utf8" || ["utf16", "invalid_utf8", "roundtrip"].includes(r.code)) throw encodingRefusal(s.file, { error: r.error, code: r.code, copyable: r.copyable });
        throw new HttpError(422, `Onionskin cannot read this file: ${r.error}.`, { code: "too_large" });
      });
      c[k] = p;
    }
    return c[k];
  }

  /** The history list and one update (browser routes, read-only; see src/history.js). */
  history(key) {
    return historyList(this.get(key));
  }
  async historyUpdate(key, id) {
    const d = await historyDetail(this.get(key), id);
    if (!d) throw new HttpError(404, "no such update", { code: "no_such_update" });
    return d;
  }

  // ---- the tracked-changes copy (M4 Idea 16, docs/contracts/tracked-changes.md) ------------------------------------------
  /**
   * The versions a tracked-changes copy covers. `id` is one agent run (only while its result is the file on disk) or "all": everything
   * History holds, from the oldest stored update to the current version, refused when the chain has a gap or holds an outside change.
   * Returns {before, after, author, date}; throws HttpError with a plain message.
   */
  #exportSpan(s, id) {
    const vis = visibleUpdates(s); // newest first
    const run = (u) => u.kind === "agent" || u.kind === "local"; // a run on this Mac is recorded like an agent's (activity kind "agent", by "local")
    const outsideRun = (u) => run(u) && (s.activity || []).some((a) => a.kind === "agent" && a.preSha === u.before && a.postSha === u.after && (a.flags || []).some((f) => f.code === "file_changed_outside_onionskin"));
    const refuse = (status, code, msg = TRACKED[code]) => new HttpError(status, msg, { code });
    let list;
    if (id === "all") {
      if (!vis.length) throw refuse(404, "nothing");
      list = vis.slice().reverse();
      for (let k = 0; k + 1 < list.length; k++) {
        if (list[k].after === list[k + 1].before) continue;
        // a break in the chain: an outside change no longer listed, or an update whose versions were pruned
        const from = s.history.indexOf(list[k]);
        const to = s.history.indexOf(list[k + 1]);
        if (s.history.slice(from + 1, to).some((u) => u.kind === "outside")) throw refuse(409, "outside");
        throw refuse(409, "unsupported", unsupportedText(["pruned"]));
      }
      if (list[list.length - 1].after !== s.histTip) throw refuse(409, "outside"); // the file on disk is a version History never recorded
    } else {
      const u = vis.find((x) => x.id === id);
      if (!u) throw new HttpError(404, "no such update", { code: "no_such_update" });
      if (!run(u)) throw refuse(409, "not_agent");
      if (u.after !== s.histTip) throw refuse(409, "not_current");
      list = [u];
    }
    if (list.some((u) => u.kind === "outside" || outsideRun(u))) throw refuse(409, "outside");
    const newest = list[list.length - 1];
    return { before: list[0].before, after: newest.after, author: list.every((u) => u.kind === "agent" || u.kind === "revert") ? AUTHORS.agent : AUTHORS.mixed, date: wordDate(newest.at) };
  }

  /**
   * "Save a copy with tracked changes": builds and checks the copy in a worker, then writes it NEXT TO the file (never over it, never the file
   * itself). Nothing is written unless every check passes: the span rules, the disk still holding the span's newest version before and after
   * the build, the builder's gates, the in-code round trip, and the deeper check when it is set up. Returns {ok, saved, name, path, ...}.
   */
  async exportTracked(key, id) {
    const s = this.get(key);
    if (s.format !== "docx") throw new HttpError(409, TRACKED.not_docx, { code: "not_docx" });
    if (s.delivered) throw new HttpError(423, TRACKED.locked, { code: "locked" });
    if (this.exporting.has(key)) throw new HttpError(409, TRACKED.busy, { code: "busy" });
    const span = this.#exportSpan(s, id);
    this.exporting.add(key);
    try {
      const current = () => {
        if (s.delivered) throw new HttpError(423, TRACKED.locked, { code: "locked" });
        let disk = null;
        try {
          disk = sha256(readCapped(s.file));
        } catch {} // moved, removed or unreadable: not the version the copy is made from
        if (s.histTip !== span.after || disk !== span.after) throw new HttpError(409, id === "all" ? TRACKED.outside : TRACKED.not_current, { code: id === "all" ? "outside" : "not_current" });
      };
      current();
      if (!s.snapshots.has(span.before) || !s.snapshots.has(span.after)) throw new HttpError(409, unsupportedText(["pruned"]), { code: "unsupported" });
      const r = await exportInWorker({ before: s.snapshots.blob(span.before), after: s.snapshots.blob(span.after), author: span.author, date: span.date });
      if (r.timeout) throw new HttpError(409, TRACKED.timeout, { code: "timeout" });
      if (r.refused?.includes("has_revisions")) throw new HttpError(409, TRACKED.has_revisions, { code: "has_revisions" });
      if (r.refused?.includes("no_changes")) throw new HttpError(409, TRACKED.no_changes, { code: "no_changes" });
      if (r.refused) throw new HttpError(409, unsupportedText(r.refused), { code: "unsupported", reasons: r.refused });
      if (!r.ok) throw new HttpError(409, TRACKED.check_failed, { code: "check_failed" });
      const bytes = Buffer.from(r.bytes);
      const deep = await deepRedline(s.snapshots.read(span.before), s.snapshots.read(span.after), bytes);
      if (deep.ran && !deep.ok) throw new HttpError(409, TRACKED.check_failed, { code: "check_failed" });
      current(); // the agent, a Send or another program may have changed the file while the copy was made
      const notes = [];
      if (r.counts.formatting) notes.push(formattingText(r.counts.formatting));
      if (r.counts.moved) notes.push(TRACKED.moves);
      if (!deep.ran) notes.push(TRACKED.not_set_up);
      const counts = r.counts;
      let copy;
      try {
        copy = writeSiblingCopy(s.file, bytes, { label: "tracked changes" });
      } catch (err) {
        if (!["EACCES", "EPERM", "EROFS", "ENOSPC", "EDQUOT"].includes(err.code)) throw err;
        const ext = path.extname(s.file);
        const name = `${path.basename(s.file, ext)} (tracked changes)${ext}`; // from the session's own path, never document text
        if (bytes.length > 25 * 1024 * 1024) return { ok: true, saved: false, code: "folder_too_large", message: TRACKED.folder_too_large, counts, notes };
        return { ok: true, saved: false, code: "folder_not_writable", message: TRACKED.folder, download: { name, bytesB64: bytes.toString("base64") }, counts, notes };
      }
      this.createdCopies.add(copy.path);
      return { ok: true, saved: true, name: copy.name, path: copy.path, can_reveal: canReveal(), message: savedText(copy.name), counts, notes };
    } finally {
      this.exporting.delete(key);
    }
  }

  /** Unlocked document, current disk hash vs the base we hold; used by the page after a reconnect. */
  diskCheck(key) {
    const s = this.get(key);
    const disk = readCapped(s.file);
    return { diskSha: sha256(disk), baseSha: s.baseSha, bytes: disk };
  }

  /**
   * Re-resolve durable anchors (comments + view) against the current disk bytes. DOCX results keep the shape docx.js returns; XLSX and
   * PPTX results are in terms of the current file (sheetIndex/sheetName/range, slideIndex/slideId/shapeId) so the page never reuses a stored location.
   */
  resolveAll(key) {
    const s = this.get(key);
    // an HTML file is read in workers only: on this thread every anchor is "moved or removed" (the server's route resolves in the worker)
    if (s.format === "html") return { baseSha: sha256(readCapped(s.file)), format: s.format, anchors: Object.fromEntries(this.#resolveTask(s).comments.map((c) => [c.id, { method: "none" }])), view: null };
    const bytes = readCapped(s.file);
    const baseSha = sha256(bytes);
    const r = anchorWork({ format: s.format, bytes, sha: baseSha, tasks: [this.#resolveTask(s)], budget: SCAN_BUDGET });
    if (!r.read.ok) throw r.read.cap ? new CapError(r.read.cap) : new Error(r.read.invalid);
    if (r.results[0]?.error) throw new Error(r.results[0].error);
    return { baseSha, format: s.format, ...r.results[0] };
  }

  /**
   * resolveAll() as the server's route calls it: resolved in the anchor worker against the file on disk. Work that did not finish
   * answers as a spent budget does: every anchor "moved or removed" (the page keeps the comments in its list), the view unknown.
   */
  async resolveAllAsync(key) {
    const s = this.get(key);
    const task = this.#resolveTask(s);
    if (s.format === "html") await this.#htmlDrafts(s, task);
    const r = await anchorsOffThread({ format: s.format, source: { path: s.file }, tasks: [task] });
    if (r.ok && r.r.read.cap) throw new CapError(r.r.read.cap);
    if (r.ok && r.r.read.ok && usable(r.r.results[0])) return { baseSha: r.sha, format: s.format, ...r.r.results[0] };
    return { baseSha: r.ok ? r.sha : sha256(readCapped(s.file)), format: s.format, anchors: Object.fromEntries(task.comments.map((c) => [c.id, { method: "none" }])), view: null };
  }

  /**
   * HTML: a draft (no durable yet) whose page anchor was made on another version than the file on disk (an outside change, a revert, a
   * save) would be drawn at a node id of that other version. It is made durable on its own version first (a stored snapshot) and resolved
   * with the others; one whose version is no longer stored resolves by its quote. Drafts made on the file's version need nothing: the page
   * draws them at their own place.
   */
  async #htmlDrafts(s, task) {
    let cur;
    try {
      cur = sha256(readCapped(s.file));
    } catch {
      return;
    }
    const other = s.comments.filter((c) => !c.durable && c.anchor?.location?.version && c.anchor.location.version !== cur);
    const byVersion = new Map();
    for (const c of other) (byVersion.get(c.anchor.location.version) || byVersion.set(c.anchor.location.version, []).get(c.anchor.location.version)).push(c);
    for (const [v, list] of byVersion) {
      const r = s.snapshots.has(v) ? await this.#offThread("html", { source: { path: s.snapshots.blob(v), sha: v }, tasks: list.map(buildTask) }) : null;
      for (const c of list) {
        const d = r?.ok && r.read?.ok ? r.map.get(taskKey(buildTask(c))) : undefined;
        const durable = usable(d) && d ? d : weakDurable("html", c.anchor);
        if (durable) task.comments.push({ id: c.id, durable });
      }
    }
  }

  #resolveTask(s) {
    return { op: "resolveAll", comments: s.comments.filter((c) => c.durable).map((c) => ({ id: c.id, durable: c.durable })), view: s.view };
  }
}

/**
 * `document_instructions_ignored` from the agent's results. Only strings count (anything else is dropped), each sanitized as untrusted text,
 * empty ones dropped and repeats ignoring case counted once. Looks at the first 50 raw items; keeps the first 5 distinct ones and says in `more`
 * when a sixth distinct one was reported. The count is the agent's own report: it is never proof of how many orders the file held.
 */
function ignoredInstructions(v) {
  const list = [];
  let more = false;
  if (!Array.isArray(v)) return { list, more };
  const seen = new Set();
  for (const x of v.slice(0, 50)) {
    if (typeof x !== "string") continue;
    const t = untrusted(x, 200);
    const k = t.toLowerCase();
    if (!t || seen.has(k)) continue;
    seen.add(k);
    if (list.length < 5) list.push(t);
    else more = true;
  }
  return { list, more };
}

const EXPORT_TIMEOUT_MS = () => Number(env("EXPORT_TIMEOUT_MS", 60_000));
/** Builds and checks one tracked-changes copy in a worker thread (src/redline-worker.js), so a large file never blocks the server. */
function exportInWorker(job) {
  return new Promise((resolve) => {
    let worker;
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker?.terminate();
      resolve(r);
    };
    const timer = setTimeout(() => finish({ timeout: true }), EXPORT_TIMEOUT_MS());
    try {
      worker = startWorker("redline-worker.js", { workerData: job });
    } catch (err) {
      return finish({ check_failed: String(err?.message || err) });
    }
    worker.once("message", finish);
    worker.once("error", (err) => finish({ check_failed: String(err?.message || err) }));
    worker.once("exit", (code) => finish({ check_failed: `the worker exited (${code})` }));
  });
}
