import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { REFUSED_EXTENSIONS, FORMATS, MAX_DOC_BYTES, PRODUCT, env } from "./constants.js";
import { buildDurable, readUnits, resolveDurableAny, resolveView, viewDurable } from "./anchors.js";
import { durableFromEngine, headingBefore, resolveDurable } from "./docx.js";
import { checkRegularOwned, readDoc, replaceGuarded, sha256, Snapshots, WriteConflict, writeSiblingCopy } from "./fsutil.js";
import { buildBatch, compactBatch, withOutline } from "./batch.js";
import { styleChangedOutside, styleNote } from "./style.js";
import { guideChangedOutside, voiceGuide, writeDraft } from "./voice-store.js";
import { cleanVoiceDraft } from "./voice-guide.js";
import { voiceJob } from "./voice-learn.js";
import { clearTickets, saveTicket, ticketOf } from "./lease.js";
import { analyze } from "./analyze.js";
import { deepNotice, validatePackage } from "./package.js";
import { execFile } from "node:child_process";
import { sessionKey, stateDir, sub, writeStateFile } from "./paths.js";
import { cleanFlag, hasControlChars, untrusted, userText } from "./sanitize.js";
import { addUpdate, historyDetail, historyList, visibleUpdates } from "./history.js";
import { BAD_QUESTION_NOTE, QUESTIONS_PER_BATCH, cleanQuestion } from "./question.js";
import { validateOps } from "./ops/schema.js";
import { Worker } from "node:worker_threads";
import { AUTHORS, wordDate } from "./redline.js";
import { deepRedline } from "./checker.js";
import { TRACKED, formattingText, savedText, unsupportedText } from "./tracked-words.js";
import { LOCAL_HOLDER } from "./local.js";
import { bgHolder, isAgentHolder, isBgHolder, termHolder, TERM_PREFIX } from "./agent-detect.js";
import { OUTLINE_FILE_MAX, REVIEW_ASKS, REVIEW_KINDS, SUGGESTIONS_MAX, UNITS_MAX, cardsFrom, outlineOf, reviewSummary, unitsOf } from "./review.js";
import { VOICE_BATCH_MAX_CHARS } from "./voice-samples.js";
import { STAMP_WORDS } from "./stamp-words.js";
import { USE_SUMMARY, buildUseReply, placeOf } from "./suggest-reply.js";

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

const LEASE_MS = () => Number(env("LEASE_MS", 15 * 60 * 1000));
const MAX_BYTES = MAX_DOC_BYTES;
/** "Show in folder" exists on macOS (`open -R`); elsewhere the page shows the path. ONIONSKIN_NO_OPEN=1 turns it off, ONIONSKIN_OPEN_STUB=<file> records instead of launching. */
const canReveal = () => !!env("OPEN_STUB") || (process.platform === "darwin" && !env("NO_OPEN"));
/** readDoc with the size refusal as an HTTP error */
function readCapped(file) {
  try {
    return readDoc(file);
  } catch (err) {
    if (err.code === "TOO_LARGE") throw new HttpError(413, `document too large: ${err.message}`, { code: "too_large" });
    throw err;
  }
}

const num = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 1000) / 1000 : 0);
/** A pin: x/y as fractions of the element it sits on (`yPx` is kept for DOCX paragraphs); `on` says what that element is. */
function cleanPin(p) {
  const out = { xFrac: num(p.xFrac), yPx: num(p.yPx) };
  if (p.yFrac != null) out.yFrac = num(p.yFrac);
  if (["paragraph", "cell", "shape", "slide"].includes(p.on)) out.on = p.on;
  if (p.sxFrac != null) {
    out.sxFrac = num(p.sxFrac);
    out.syFrac = num(p.syFrac);
  }
  return out;
}

const APPLY_STATUS = new Set(["refused", "skipped_protected", "anchor_not_found", "expect_mismatch", "not_applied"]);
// the three-way merge of each format (loaded on first use: they pull in the engine)
const MERGERS = { docx: { module: "./merge.js", fn: "mergeDocx" }, xlsx: { module: "./merge-xlsx.js", fn: "mergeXlsx" }, pptx: { module: "./merge-pptx.js", fn: "mergePptx" } };
const HELD_SHOWN = 5; // items the page's "not in the document" message lists (web/src/Banners.jsx)
const WRITES_KEPT = 20; // writes per file the merge can trace (src/merge-xlsx.js agentChanges); an older base finds no record and is handed back
/** What the page says the user did during the run: kinds and places only, used to hold edits back or to name what is not carried, never to write. */
const editKinds = (edits) => (Array.isArray(edits) ? edits.slice(0, 2000) : []).map((e) => ({ kind: String(e?.kind ?? "").slice(0, 40), sheet: typeof e?.sheet === "string" ? e.sheet.slice(0, 100) : null, slide: Number.isInteger(e?.slide) ? e.slide : null }));
/** One op `apply` did not apply, as the page shows it: codes and short reasons only (never document text). */
function cleanProblem(p, run = "") {
  return {
    key: untrusted(p?.key || `${p?.index ?? ""}:${p?.op ?? ""}`, 80),
    run: untrusted(run, 40),
    op: untrusted(p?.op, 40),
    status: APPLY_STATUS.has(p?.status) ? p.status : "refused",
    code: p?.code ? untrusted(p.code, 60) : null,
    reason: untrusted(p?.reason, 200),
  };
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** A stored durable anchor re-resolved against `units` (the bytes the agent will read next); null when the unit is gone. Without a durable, one is built from the browser's anchor. */
function reanchor(units, c) {
  const d = c.durable;
  if (!d) return buildDurable(units, c.anchor);
  const r = resolveDurableAny(units, d);
  if (r.method === "none") return null;
  if (units.format === "docx") return { ...d, ...r, format: "docx", quote: d.quote, prefix: d.prefix, suffix: d.suffix, paraText: r.text, engineDelta: r.engineDelta };
  if (units.format === "xlsx") return buildDurable(units, { location: { sheetIndex: r.sheetIndex, sheetName: r.sheetName, range: r.range } });
  return buildDurable(units, { location: { slideIndex: r.slideIndex, slideId: r.slideId, shapeId: r.shapeId ?? undefined, shapeName: r.shapeName, cell: d.cell || undefined }, quote: d.quote, prefix: d.prefix, suffix: d.suffix, hitKind: d.quote ? undefined : "shape" });
}

/**
 * All session state and transitions, with no HTTP in it.
 * States (derived): idle, listening, working, queued, stranded, closed. poll results add timeout and superseded.
 *  - Send with a poller waiting: batch delivered, session `working`, document locked.
 *  - Send with nobody polling: batch kept as `pending`, session `stranded`, document stays editable.
 *  - Send while working: comments only, kept as `queued`; released to the next poller after `done`.
 *  - Lease expiry or Take back: `delivered` is withdrawn, the document unlocks.
 */
export class Sessions extends EventEmitter {
  // delivered run -> styleChangedOutside() when it went out; memory only, so a run reloaded after a restart has none and is not flagged
  #styleSeen = new WeakMap();
  // delivered run -> guideChangedOutside() when it went out (the same idea for voice-guide.json); taking it also arms the guide's guard
  #guideSeen = new WeakMap();
  constructor({ now = Date.now } = {}) {
    super();
    this.now = now;
    this.map = new Map(); // key -> session
    this.createdCopies = new Set(); // absolute paths of conflict copies THIS server wrote: the only paths `showCopy` will reveal
    this.editors = new Map(); // key -> id of the one browser tab that may edit (in memory only: a tab's id lives as long as its page)
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
    if (cur && cur !== tab && !takeover) return false;
    if (cur !== tab) {
      this.editors.set(key, tab);
      this.emit("change", s, "state");
    }
    return true;
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
  /** `opts.agent === "background"`: the person opened it from a terminal, so the server's background agent works on it (stored on the session). */
  open(input, opts = {}) {
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
    const format = ext.slice(1);
    if (!FORMATS[format]) throw new HttpError(400, "Only .docx, .xlsx and .pptx files are supported");
    let st;
    try {
      st = checkRegularOwned(real);
    } catch (err) {
      throw new HttpError(400, err.message);
    }
    const bytes = readCapped(real);
    try {
      validatePackage(bytes, format);
    } catch (err) {
      throw new HttpError(400, `Not a valid .${format}: ${err.message}`);
    }
    const key = sessionKey(real);
    let s = this.map.get(key);
    const sha = sha256(bytes);
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
    const { pollers, snapshots, ...rest } = s;
    writeStateFile(path.join(sub("sessions"), `${s.key}.json`), JSON.stringify(rest));
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
      editor: this.editors.get(s.key) || null,
      conflict: s.conflict || null,
      canReveal: canReveal(),
      // the agent's review cards (src/review.js); their ops stay on the server
      suggestions: (s.suggestions || []).map(({ op, acceptedBatch, ...c }) => c),
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
  /** Browser replaces its list of comments/pins and the overall note. Server-owned fields (status, results) are kept. */
  setDraft(key, { comments, note }) {
    const s = this.get(key);
    if (!Array.isArray(comments)) throw new HttpError(400, "comments must be an array");
    const prev = new Map(s.comments.map((c) => [c.id, c]));
    s.comments = comments.slice(0, 500).map((c) => {
      const old = prev.get(String(c.id));
      const base = {
        id: String(c.id).slice(0, 64),
        kind: ["text", "element", "pin"].includes(c.kind) ? c.kind : "element",
        text: userText(c.text),
        anchor: c.anchor && typeof c.anchor === "object" ? c.anchor : null,
        pin: c.pin && typeof c.pin === "object" ? cleanPin(c.pin) : null,
        pinNo: Number.isInteger(c.pinNo) ? c.pinNo : null,
      };
      if (old && old.status !== "draft") return { ...old, text: old.text, kind: old.kind }; // sent/done comments are frozen
      // an answered question: the words, the question and the answer stay as the person left them (the page cannot change them)
      const keep = old?.skipLocal ? { skipLocal: true } : {}; // a reverted local run: the next Send of this comment goes to the agent
      if (old?.localHint && userText(c.text) === old.text) keep.localHint = old.localHint; // the words changed: the hint no longer applies
      if (old?.answer) return { ...base, text: old.text, status: "draft", durable: old.durable || null, question: old.question, answer: old.answer, ...keep };
      return { ...base, status: "draft", durable: old?.durable || null, ...keep };
    });
    s.note = userText(typeof note === "string" ? note : "");
    this.#changed(s, "draft");
    return s;
  }

  // ---- send ------------------------------------------------------------------------------------------------
  /**
   * payload: { baseSha, bytes?: Buffer, comments, note, edits: [{kind,before,after,label,location}], viewState }
   * Compare-and-swap on the disk hash. Returns the session.
   */
  send(key, payload) {
    const s = this.get(key);
    if (s.closed) throw new HttpError(409, "session closed", { code: "closed" });
    const hasBytes = !!payload.bytes?.length;
    if (s.delivered && hasBytes) throw new HttpError(423, s.delivered.local ? "the document is locked while a change is made on this Mac" : "the document is locked while the agent works", { code: "locked" }); // before touching any state
    this.setDraft(key, { comments: payload.comments ?? s.comments, note: payload.note ?? s.note });
    if (s.delivered) {
      // queue: comments and note only. A new comment gets its durable anchor from the bytes the page shows (the pre-agent snapshot),
      // never from the disk, which the agent may already have changed; done() then moves it onto the post-agent file.
      const fresh = s.comments.filter((c) => c.status === "draft");
      if (fresh.some((c) => !c.durable)) {
        let units = null;
        try {
          units = readUnits(s.format, s.snapshots.read(s.delivered.preSha));
        } catch {
          units = null; // no snapshot: done() falls back to building from the post-agent file
        }
        if (units) {
          for (const c of fresh) {
            if (c.durable) continue;
            c.durable = buildDurable(units, c.anchor);
            if (units.format === "pptx" && c.kind === "pin" && c.durable?.shapeId != null) c.durable.pinFallback = buildDurable(units, { location: { slideIndex: c.durable.slideIndex, slideId: c.durable.slideId } });
          }
        }
      }
      for (const c of fresh) c.status = "queued";
      if (s.note) {
        // the note belongs to the queued batch now; the stored note is cleared so the next Send does not repeat it
        s.queuedNote = [s.queuedNote, s.note].filter(Boolean).join("\n\n");
        s.note = "";
      }
      if (fresh.length || s.queuedNote) s.queued = true; // a Send with nothing new queues nothing (no empty batch after this one)
      this.#changed(s);
      this.#voice(s, { sent: fresh });
      return s;
    }
    const { diskSha, written, writtenSha, writeInfo, lastUpdate } = this.#takePage(s, payload);

    // user edits since the last Send (document-derived text) accumulate until a batch is delivered
    for (const e of Array.isArray(payload.edits) ? payload.edits.slice(0, 2000) : []) s.edits.push({ kind: e.kind, before: e.before, after: e.after, label: e.label, location: e.location });

    const units = readUnits(s.format, written);
    const resolve = (anchor) => buildDurable(units, anchor);
    const eligible = s.comments.filter((c) => c.status === "draft" || c.status === "sent");
    for (const c of eligible) {
      c.durable = resolve(c.anchor);
      // a PPTX pin dropped on a shape also remembers its slide: if the shape is deleted the pin stays on the slide
      if (units.format === "pptx" && c.kind === "pin" && c.durable?.shapeId != null) c.durable.pinFallback = buildDurable(units, { location: { slideIndex: c.durable.slideIndex, slideId: c.durable.slideId } });
    }
    for (const e of s.edits) e.durable = e.durable || resolve({ location: e.location, quote: e.after });
    s.view = this.#resolveView(s, units, payload.viewState);

    const batch = buildBatch({ file: s.file, format: s.format, baseSha: writtenSha, note: s.note, comments: eligible, edits: s.edits, style: styleNote(), guide: voiceGuide() });
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
    this.#changed(s);
    this.#voice(s, { last: lastUpdate, diskSha, writtenSha, sent });
    if (this.state(s) === "stranded" && !s.pollers.length) this.emit("stranded", s); // nobody took it: the server may start its background agent
    return s;
  }

  /**
   * The page's bytes become the file, as at Send (and at a quick fix's Use): the disk read, the compare-and-swap against the version
   * the page loaded, the package check, the guarded replace, the "sent" snapshot, the new base and the person's own history update.
   * `check(bytes)` (optional) sees the bytes that are about to be the file, after the package check and before anything is written, and
   * may throw to refuse. Returns {disk, diskSha, written, writtenSha, writeInfo, lastUpdate}.
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
    if (diskSha !== payload.baseSha) {
      throw this.#outsideChange(s, { side: "user", bytes: payload.bytes, diskSha, baseSha: payload.baseSha });
    }
    let written = disk;
    let writeInfo = null;
    if (hasBytes) {
      if (payload.bytes.length > MAX_BYTES) throw new HttpError(413, "document too large");
      try {
        validatePackage(payload.bytes, s.format);
      } catch (err) {
        throw new HttpError(422, `refusing to write: ${err.message}`, { code: "invalid_package" });
      }
    }
    if (check) check(hasBytes ? payload.bytes : disk);
    if (hasBytes) {
      writeInfo = this.#replace(s, payload.bytes, { expectSha: diskSha, label: "before send", side: "user" });
      written = payload.bytes;
    }
    const writtenSha = sha256(written);
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
   * Ceiling: the engine runs in the server process (about 0.1 s on a 300-paragraph file); move it to a worker if large files stall polls.
   */
  async mergeUserEdits(key, { baseSha, bytes, edits = [] }) {
    const s = this.get(key);
    if (s.closed) throw new HttpError(409, "session closed", { code: "closed" });
    if (s.delivered) throw new HttpError(423, s.delivered.local ? "a change is being made on this Mac" : "the agent is working", { code: "locked" });
    const merger = MERGERS[s.format];
    if (!/^[0-9a-f]{64}$/.test(baseSha)) throw new HttpError(400, "baseSha must be a sha256"); // it names a snapshot file
    if (!bytes?.length) throw new HttpError(400, "no document bytes");
    if (bytes.length > MAX_BYTES) throw new HttpError(413, "document too large");
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
    const [mod, { runOps }] = await Promise.all([import(merger.module), import("./ops/run.js")]);
    const r = await mod[merger.fn]({ base, mine: bytes, theirs: disk, name: path.basename(s.file), runOps, edits: editKinds(edits), agent: s.format === "xlsx" ? this.#writesBetween(s, baseSha, diskSha, disk) : null });
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
  #replace(s, bytes, { expectSha, label, side = null }) {
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

  #resolveView(s, units, vs) {
    if (!vs) return null;
    if (units.format === "docx" && vs.format !== "docx") return { format: s.format, raw: vs };
    if (units.format !== "docx") return viewDurable(units, vs) || { format: s.format, raw: vs };
    const d = durableFromEngine(units.paragraphs, { blockPath: vs.blockPath }, { quote: vs.quote });
    return { format: "docx", durable: d, offsetPx: Number(vs.offsetPx) || 0, zoom: vs.zoom ?? "fit", fraction: vs.fraction };
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
   * A file that cannot be read gets no outline (the agent declines what it cannot find); an outline file that cannot be written leaves the
   * inline part with `outline_more`. Ceiling: read and parsed on the main thread at each such delivery, as a review is; upgrade path as in unitsOf.
   */
  #withOutline(s, batch, holder) {
    if (!isAgentHolder(holder) || batch.instructions?.review || batch.instructions?.voice_request) return batch;
    let all;
    try {
      checkRegularOwned(s.file);
      all = outlineOf(s.format, readCapped(s.file), OUTLINE_FILE_MAX);
    } catch {
      return batch;
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
      s.note = [s.queuedNote, s.note].filter(Boolean).join("\n\n");
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
   * `apply` through a live session: the single authority for the write. Accepted only while a batch is delivered (state working or
   * queued: both hold a live lease) and only for the lease holder; compare-and-swap on the disk hash; renews the lease.
   */
  agentWrite(key, { baseSha, bytes, holder, token, batchId, label = "before agent write", route = "commit", ops = null, partial = false }) {
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
    if (bytes.length > MAX_BYTES) throw new HttpError(413, "document too large");
    try {
      validatePackage(bytes, s.format);
    } catch (err) {
      throw new HttpError(422, `refusing to write: ${err.message}`, { code: "invalid_package" });
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
    this.setStage(key, "writing"); // only once the checks passed: a refused write does not claim to be writing
    const info = this.#replace(s, bytes, { expectSha: diskSha, label, side: "agent" });
    const newSha = sha256(bytes);
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

  done(key, results, claim = {}, analysis = null) {
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
    if (readOnlyKind(run.batch) === "voice") return this.#doneVoice(s, results, run, post, postSha);
    // a review that wrote nothing ends with cards. One whose file changed anyway (a direct save past review_only) is finished as a run below:
    // its write is flagged and can be reverted, and no card is kept
    if (run.batch.instructions?.review && postSha === run.preSha) return this.#doneReview(s, results, run, post);
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
    else found = analyze(pre, post, s.format);
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
    const queuedPlan = this.#planQueued(s, post, postSha, flags);
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
  #planQueued(s, post, postSha, flags) {
    let plan = null;
    if (s.queued) {
      const queued = s.comments.filter((c) => c.status === "queued");
      if (queued.length || s.queuedNote) {
        let units = null;
        try {
          units = readUnits(s.format, post);
        } catch (err) {
          flags.push({ code: "queued_reanchor_failed", severity: "warn", detail: err.message });
        }
        const durables = new Map();
        for (const c of queued) {
          let d = null;
          try {
            if (units) d = reanchor(units, c);
          } catch (err) {
            flags.push({ code: "queued_reanchor_failed", severity: "warn", comment_id: c.id, detail: err.message });
          }
          durables.set(c.id, d);
        }
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
    const { units, more, index } = unitsOf(s.format, bytes);
    const batch = buildBatch({ file: s.file, format: s.format, baseSha, note: "", comments: [], edits: [], review: { kind, ask: REVIEW_ASKS[kind] }, units, unitsMore: more });
    s.review = { batchId: batch.batch_id, kind, units: units.map((u) => ({ id: u.id, protected: u.protected })), index };
    s.decidedBatch = batch.batch_id; // never the local runner's: only an agent reads the file
    return batch;
  }

  /** `done` of a review that wrote nothing: the suggestions become cards (checked against the file), an activity entry of kind "review", no history update. */
  #doneReview(s, results, run, post) {
    const flags = [];
    const ix = s.review?.batchId === run.batch.batch_id ? s.review : null;
    const { cards, dropped } = ix ? cardsFrom(results.suggestions, { bytes: post, format: s.format, units: ix.units, index: ix.index, reviewId: run.batch.batch_id }) : { cards: [], dropped: (Array.isArray(results.suggestions) ? results.suggestions : []).map((_, i) => ({ index: i, reason: "the review's outline is gone" })) };
    for (const d of dropped) flags.push({ code: "bad_suggestion", severity: "warn", ...(d.index != null ? { index: d.index } : {}), reason: d.reason });
    if (results.voice_draft !== undefined) flags.push({ code: "voice_draft_not_allowed", severity: "warn" });
    const queuedPlan = this.#planQueued(s, post, run.preSha, flags);
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
  useSuggestion(key, { suggestion: rec, commentId, comments, note, baseSha, bytes = null, edits = [] }) {
    const s = this.get(key);
    if (s.closed) throw new HttpError(409, "session closed", { code: "closed" });
    if (s.delivered || s.pending) throw new HttpError(409, "The agent started working on this file, so nothing was written. Ask the agent instead, or try again when it is done.", { code: "busy" });
    const words = rec && Object.hasOwn(STAMP_WORDS, rec.task) && rec.task !== "translate" ? STAMP_WORDS[rec.task] : null;
    if (!words || typeof rec.before !== "string" || typeof rec.after !== "string") throw new HttpError(409, "This suggestion is out of date. Tap the stamp again.", { code: "expired" });
    const id = String(commentId ?? "").slice(0, 64);
    const mine = Array.isArray(comments) ? comments.find((c) => c && String(c.id) === id) : null;
    const old = s.comments.find((c) => c.id === id);
    const sameAnchor = (a) => a && typeof a === "object" && a.quote === rec.quote && JSON.stringify(a.location ?? null) === JSON.stringify(rec.location ?? null);
    if (!mine || userText(mine.text) !== words || !sameAnchor(mine.anchor) || (old && old.status !== "draft")) throw new HttpError(409, "This comment is not the suggestion's stamp.", { code: "not_this_comment" });

    this.setDraft(key, { comments, note: note ?? s.note });
    const c = s.comments.find((x) => x.id === id);
    const anchor = { location: c.anchor.location, quote: c.anchor.quote, prefix: c.anchor.prefix, suffix: c.anchor.suffix };
    let plan = null;
    // the place and the reply are worked out on the very bytes that are about to be the file; any refusal here writes nothing
    const check = (b) => {
      const units = readUnits(s.format, b);
      const durable = buildDurable(units, anchor);
      const place = placeOf(units, durable, rec.quote);
      if (!place.ok) throw new HttpError(409, place.code === "protected" ? "This part of the file is protected, so it cannot be changed here." : LOCAL_HINT, { code: place.code });
      const reply = buildUseReply(rec, id, place.text);
      const batch = buildBatch({ file: s.file, format: s.format, baseSha: sha256(b), note: "", comments: [{ ...c, durable }], edits: [] });
      if (!reply || batch.instructions.comments[0]?.reply_with !== "find_replace_or_text") throw new HttpError(409, LOCAL_HINT, { code: "not_here" });
      plan = { durable, reply, batch };
    };
    let taken;
    try {
      taken = this.#takePage(s, { baseSha, bytes }, check);
    } catch (err) {
      // nothing was written: the comment stays a draft, and says it can go to the agent
      if (["not_here", "not_eligible", "protected"].includes(err?.extra?.code)) {
        c.localHint = LOCAL_HINT;
        this.#changed(s);
      }
      throw err;
    }
    for (const e of Array.isArray(edits) ? edits.slice(0, 2000) : []) s.edits.push({ kind: e.kind, before: e.before, after: e.after, label: e.label, location: e.location });
    c.durable = plan.durable;
    c.status = "sent";
    c.batchId = plan.batch.batch_id;
    delete c.localHint;
    s.lastWrite = taken.writeInfo;
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
  #doneVoice(s, results, run, post, postSha) {
    const flags = [];
    for (const r of (Array.isArray(results.results) ? results.results : []).slice(0, 1000)) flags.push({ code: "unknown_result", severity: "warn", comment_id: String(r?.comment_id ?? "").slice(0, 64) });
    const check = cleanVoiceDraft(results.voice_draft); // size first, then hidden characters, links and markup, the layout, the caps
    if (check.code) flags.push({ code: "bad_voice_draft", severity: "warn", reason: check.code });
    this.#guardFlags(run, flags);
    const queuedPlan = this.#planQueued(s, post, postSha, flags);
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
    s.note = [...new Set(notes)].join("\n\n");
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

  revert(key, activityId) {
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
    this.#replace(s, pre, { expectSha: entry.postSha, label: "before revert" }); // a revert is a new version
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
      s.note = entry.localNote; // the request comes back to the box, and the same words go to the agent next time
      s.skipLocalNote = entry.localNote;
    }
    // a batch built against the reverted version is rebuilt against the restored bytes (a review: its outline is read again; a voice
    // request keeps its samples, which left out what that run wrote, and points at the restored version)
    if (readOnlyKind(s.pending) === "voice") s.pending = { ...s.pending, base_sha256: entry.preSha };
    else if (s.pending?.instructions?.review) s.pending = this.#reviewBatch(s, s.pending.instructions.review.kind, pre, entry.preSha);
    else if (s.pending) {
      const ids = new Set(s.pending.instructions.comments.map((c) => c.id));
      const cs = s.comments.filter((c) => ids.has(c.id));
      let units = null;
      try {
        units = readUnits(s.format, pre);
      } catch {
        units = null;
      }
      for (const c of cs) {
        try {
          if (units) c.durable = reanchor(units, c);
        } catch {
          c.durable = null;
        }
      }
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
    return out;
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
    const bytes = readCapped(s.file);
    const out = { baseSha: sha256(bytes), format: s.format, anchors: {}, view: null };
    const units = readUnits(s.format, bytes);
    for (const c of s.comments) {
      if (!c.durable) continue;
      let r = resolveDurableAny(units, c.durable);
      if (r.method === "none" && units.format === "pptx" && c.durable.pinFallback) {
        const f = resolveDurableAny(units, c.durable.pinFallback);
        if (f.method !== "none") r = { ...f, tieLost: true };
      }
      if (units.format === "docx" && r.method !== "none") r.heading = headingBefore(units.paragraphs, r.ordinal);
      out.anchors[c.id] = r;
    }
    if (s.format === "pptx") out.slides = units.deck.slides.map((x) => ({ index: x.index, id: x.id }));
    if (s.format === "docx") {
      if (s.view?.durable) out.view = { ...resolveDurable(units.paragraphs, s.view.durable), offsetPx: s.view.offsetPx, zoom: s.view.zoom, fraction: s.view.fraction };
    } else out.view = resolveView(units, s.view);
    out.sheets = s.format === "xlsx" ? units.wb.sheets.map((x) => ({ index: x.index, name: x.name, sheetId: x.sheetId })) : undefined;
    return out;
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
      worker = new Worker(new URL("./redline-worker.js", import.meta.url), { workerData: job });
    } catch (err) {
      return finish({ check_failed: String(err?.message || err) });
    }
    worker.once("message", finish);
    worker.once("error", (err) => finish({ check_failed: String(err?.message || err) }));
    worker.once("exit", (code) => finish({ check_failed: `the worker exited (${code})` }));
  });
}
