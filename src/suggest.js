// Quick fixes (idea 10 option A): the small model on this Mac suggests a rewrite of ONE selected sentence (Shorter, Friendlier, Fix
// grammar), the person sees both sentences, and only a tap on "Use this" writes it. This file is the server half: the suggestion itself
// (POST /api/suggest), "Use this" (POST /api/suggest/use, which hands over to Sessions.useSuggestion), warming the model
// (POST /api/suggest/warm), the status for the page's bootstrap, and the one-button setup (GET|POST /api/setup-rewriter).
//
// The trust argument: the selected sentence is document text and the rewrite is model output, both untrusted. Asking writes nothing and
// changes no session state: the suggestion is kept in this process's memory only (at most 3 per file, for 10 minutes, never in the session
// file), and the page gets it to show as plain text. A Use names the suggestion by its id; the text written is the stored one, through the
// local runner's ordinary checked write (src/local.js), never text the page sends back. "Ask the agent instead" is an ordinary Send of the
// stamp's words: the suggestion never enters a batch.
//
// Ceilings: one suggestion at a time per file here, and one at a time for the whole server in the worker (src/rewriter.js answers "busy").
// The store is lost with the server (a reload after a restart shows no card; the stamp is tapped again).
import crypto from "node:crypto";
import { buildDurable, readUnits } from "./anchors.js";
import { diffText } from "./diff.js";
import { checkRegularOwned, readDoc } from "./fsutil.js";
import { REWRITE_TASKS, checkRewrite, inputQualifies } from "./rewrite-check.js";
import { APPLE_STATES, appleHelperState, appleStateLine, getRewriter, rewriterStatus } from "./rewriter.js";
import { setupRewriter } from "./rewriter-setup.js";
import { untrusted } from "./sanitize.js";
import { HttpError } from "./session.js";
import { sentenceSpan } from "./sentence-span.js";
import { placeOf } from "./suggest-reply.js";
import { normText } from "./text.js";

export { USE_NOTE, USE_SUMMARY, buildUseReply, changedMiddle, placeOf } from "./suggest-reply.js";

// The stamps that ask the small model first: the jobs it is measurably good at, and nothing else (the owner, 2026-11-12: "only use them for what
// they're best at"). Today that is Fix grammar. Every other stamp goes to the agent. Widen this list per measured capability; the page's copy
// (web/src/stamps.js) must match, and test/suggest-view.test.js checks that it does.
export const SUGGEST_TASKS = ["grammar"];
// The tasks the page and this server accept: SUGGEST_TASKS, and with the test stand-in back end (src/rewriter.js, backend "stub") all three. A shorter
// shipped list would be honored end to end (the page names and asks only what is on it; /api/suggest refuses the rest). The page is told this list in the bootstrap (suggestStatus) and has no copy of its own.
const tasksNow = () => (rewriterStatus().backend === "stub" ? REWRITE_TASKS : SUGGEST_TASKS);
export const SUGGEST_FORMATS = ["docx", "pptx"];
const KEEP = 3; // suggestions kept per file
const KEEP_MS = 10 * 60_000;
const ASK_MS = 4000; // the model's time limit for one sentence
const WARM_MS = 8000; // how long a cold model is waited for
const WARM_RETRY_MS = 250;
const MAX_QUOTE = 300;
const CONTEXT = 200; // characters of text kept either side of the sentence in an anchor
// the line for a suggestion withheld because it changed quoted text (checked before the fact codes: a quoted name is also a name)
export const QUOTED_LINE = "No suggestion here: the change is inside quoted text.";
// reasons of the suggest check that mean the writing helper changed a fact (the page says so in those words)
const FACT_CODES = new Set(["number_changed", "unit_changed", "date_word_changed", "range_changed", "code_changed", "name_changed", "link_changed"]);

// ---- the in-memory store ---------------------------------------------------------------------------------------------------
const stores = new WeakMap(); // Sessions -> Map(session key -> [record], oldest first)
const asking = new WeakMap(); // Sessions -> Set(session key): one suggestion in flight per file

function recordsOf(sessions, key) {
  let m = stores.get(sessions);
  if (!m) stores.set(sessions, (m = new Map()));
  const now = sessions.now();
  const live = (m.get(key) || []).filter((r) => now - r.at < KEEP_MS);
  if (live.length) m.set(key, live);
  else m.delete(key);
  return live;
}

/** Keeps `record` for `key`; the oldest goes when there are more than KEEP. */
export function keepSuggestion(sessions, key, record) {
  const list = [...recordsOf(sessions, key), record].slice(-KEEP);
  stores.get(sessions).set(key, list);
}

/** The live record with this id for this file, or null (unknown, expired, pushed out, or another file's). */
export function findSuggestion(sessions, key, id) {
  if (typeof id !== "string" || !id) return null;
  return recordsOf(sessions, key).find((r) => r.id === id) || null;
}

export function forgetSuggestion(sessions, key, id) {
  const m = stores.get(sessions);
  const list = m?.get(key);
  if (list) m.set(key, list.filter((r) => r.id !== id));
}

// ---- POST /api/suggest -----------------------------------------------------------------------------------------------------
/** The page's selection: a location object and a quote (plain strings only); everything else it may carry is dropped. */
function cleanAnchor(a) {
  if (!a || typeof a !== "object" || !a.location || typeof a.location !== "object" || Array.isArray(a.location)) return null;
  if (typeof a.quote !== "string" || !a.quote || a.quote.length > MAX_QUOTE) return null;
  const str = (v) => (typeof v === "string" ? v.slice(0, 200) : "");
  return { location: a.location, quote: a.quote, prefix: str(a.prefix), suffix: str(a.suffix) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One suggestion for the selected sentence. body: {task, anchor: {location, quote, prefix?, suffix?}, wholeParagraph?}. Never writes and
 * never changes the session. Resolves to one of:
 *   {state: "shown", id, before, after, diff, warnings, untrusted: true, anchor}   diff: diffText(before, after) ops; warnings: suggest-check warnings;
 *     anchor: {location, quote, prefix, suffix} of the whole sentence (the selection, completed as src/sentence-span.js says): the page puts its comment there
 *   {state: "unchanged"} | {state: "withheld", why: "facts" | "not_shorter" | "not_friendlier" | "not_clean" | "quoted", line?} | {state: "addresses_ai"} | {state: "protected"}
 *   {state: "not_eligible", why} | {state: "off", why?, line?} | {state: "busy"} | {state: "timeout"} | {state: "warming"} | {state: "failed", why?: "refused"}
 *   "withheld" with why "quoted" carries the line to show (QUOTED_LINE); "off" with a why (Apple's model is not available now: a key of
 *   APPLE_STATES) carries its line, and the tap goes to the agent; "failed" with why "refused" is the model declining the sentence.
 * `opts` (tests): rewriter() -> the rewriter or null, warmMs, retryMs.
 */
export async function suggest(sessions, key, body, opts = {}) {
  const { rewriter = getRewriter, warmMs = WARM_MS, retryMs = WARM_RETRY_MS } = opts;
  const s = sessions.get(key);
  if (s.closed) throw new HttpError(409, "session closed", { code: "closed" });
  const task = body?.task;
  if (!tasksNow().includes(task)) throw new HttpError(400, `task must be one of ${tasksNow().join(", ")}`, { code: "bad_task" });
  const no = (why) => ({ state: "not_eligible", why });
  if (!SUGGEST_FORMATS.includes(s.format)) return no("format");
  if (s.delivered || s.pending) return no("working");
  const anchor = cleanAnchor(body.anchor);
  if (!anchor) return no("selection");
  const picked = anchor.quote; // exactly what the page selected; the file is searched for this
  if (untrusted(picked.trim(), MAX_QUOTE + 100) !== picked.trim()) return no("selection"); // control, bidi or zero-width characters, a line break

  // where it is in the file on disk now, read only. A sentence the page changed and has not sent yet is not found: that is checked again,
  // on the bytes actually written, at Use
  let place = null;
  try {
    checkRegularOwned(s.file);
    const units = readUnits(s.format, readDoc(s.file));
    place = placeOf(units, buildDurable(units, anchor), picked);
  } catch {
    place = null;
  }
  if (place?.code === "protected") return { state: "protected" };
  if (place?.code === "not_eligible") return no("place");
  // The sentence is read from the paragraph itself, never from the page: a selection that is a sentence minus its end mark, closing quote or
  // bracket, or with spaces at its edges, means the whole sentence (src/sentence-span.js). The anchor Use will write on is the sentence's.
  let quote = picked;
  let from = anchor;
  if (place?.ok) {
    const span = Number.isInteger(place.start) && Number.isInteger(place.end) ? sentenceSpan(place.text, place.start, place.end) : null;
    if (span) {
      quote = place.text.slice(span.start, span.end);
      if (untrusted(quote, MAX_QUOTE + 100) !== quote || quote.length > MAX_QUOTE + 10) return no("selection");
      const loc = Number.isInteger(anchor.location.start) && Number.isInteger(anchor.location.end) ? { ...anchor.location, start: span.start, end: span.end } : anchor.location;
      from = { location: loc, quote, prefix: place.text.slice(Math.max(0, span.start - CONTEXT), span.start), suffix: place.text.slice(span.end, span.end + CONTEXT) };
    }
  } else if (untrusted(picked, MAX_QUOTE + 100) !== picked) return no("selection"); // edge spaces: nothing to read the sentence from
  const wholeParagraph = place?.ok ? normText(place.text) === normText(quote) : body.wholeParagraph === true;
  const q = inputQualifies(quote, { wholeParagraph });
  if (!q.ok) return q.reasons.some((r) => r.code === "input_addresses_ai") ? { state: "addresses_ai" } : no("sentence");

  const rw = rewriter();
  if (!rw) return { state: "off" };
  let mine = asking.get(sessions);
  if (!mine) asking.set(sessions, (mine = new Set()));
  if (mine.has(key)) return { state: "busy" };
  mine.add(key);
  try {
    const until = Date.now() + warmMs;
    let r;
    for (;;) {
      r = await rw.rewrite(task, quote, { timeoutMs: ASK_MS });
      if (r?.code !== "warming_up") break;
      if (Date.now() >= until) return { state: "warming" };
      await sleep(retryMs);
    }
    if (!r?.ok) {
      if (Object.hasOwn(APPLE_STATES, r?.code)) return { state: "off", why: r.code, line: appleStateLine(r.code) };
      if (r?.code === "refused") return { state: "failed", why: "refused" };
      return { state: r?.code === "timeout" ? "timeout" : r?.code === "busy" ? "busy" : "failed" };
    }
    if (s.closed || s.delivered || s.pending) return no("working"); // an agent run started while the model worked
    const c = checkRewrite(task, quote, r.text, { mode: "suggest" });
    if (c.verdict === "unchanged") return { state: "unchanged" };
    if (c.verdict !== "show" && c.verdict !== "warn") {
      const codes = (c.reasons || []).map((x) => x.code);
      if (codes.includes("quoted_text_changed")) return { state: "withheld", why: "quoted", line: QUOTED_LINE };
      return { state: "withheld", why: codes.some((x) => FACT_CODES.has(x)) ? "facts" : task === "shorter" && codes.includes("not_shorter") ? "not_shorter" : task === "friendlier" && codes.includes("formal_only") ? "not_friendlier" : "not_clean" };
    }
    const warnings = (c.warnings || []).map((w) => ({
      code: w.code,
      words: (w.words || []).map((x) => untrusted(x, 30)),
      dropped: (w.dropped || []).map((x) => untrusted(x, 30)),
      added: (w.added || []).map((x) => untrusted(x, 30)),
      ...(w.now ? { now: w.now === "question" ? "question" : "statement" } : {}),
    }));
    const id = `q_${crypto.randomBytes(8).toString("hex")}`;
    keepSuggestion(sessions, key, { id, task, quote, location: from.location, before: quote, after: c.text, warnings, at: sessions.now() });
    const d = diffText(quote, c.text, { context: Infinity });
    return { state: "shown", id, before: quote, after: c.text, diff: d.ops || [], warnings, untrusted: true, anchor: from };
  } finally {
    mine.delete(key);
  }
}

// ---- POST /api/suggest/use ---------------------------------------------------------------------------------------------------
/**
 * body: {id, commentId, comments, note?, baseSha, bytesB64?, edits?}. The record is looked up here by id; Sessions.useSuggestion checks the
 * rest and starts the local run. The record is used once: it is forgotten as soon as the run has started.
 */
export function useSuggestion(sessions, key, body) {
  const id = typeof body?.id === "string" ? body.id : "";
  const record = findSuggestion(sessions, key, id);
  if (!record) throw new HttpError(409, "This suggestion is out of date. Tap the stamp again.", { code: "expired" });
  const bytes = typeof body.bytesB64 === "string" ? Buffer.from(body.bytesB64, "base64") : null;
  sessions.useSuggestion(key, { suggestion: record, commentId: body.commentId, comments: body.comments, note: body.note, baseSha: String(body.baseSha || ""), bytes, edits: body.edits });
  forgetSuggestion(sessions, key, id);
  return sessions.get(key);
}

// ---- warm-up and status ------------------------------------------------------------------------------------------------------
/** POST /api/suggest/warm: starts a cold model in the background. Carries no text. */
export function warmSuggest() {
  const rw = getRewriter();
  rw?.warm();
  return { on: !!rw };
}

/**
 * The bootstrap's `suggest` field: {on, name, tasks, unavailable}. `unavailable` is {code, line} when Apple's model gives no instant suggestion on
 * this Mac (a key of APPLE_STATES in src/rewriter.js, and its plain line; Fix grammar then goes to the agent), else null. Decided without starting
 * the helper: from the macOS version, the processor, the helper's hash and its quarantine mark, then what the last setup or start was told.
 * `o` (tests) goes to appleHelperState.
 */
export function suggestStatus(o = {}) {
  const r = rewriterStatus();
  const why = (code) => (Object.hasOwn(APPLE_STATES, code === "helper_changed" ? "helper_missing" : code) ? { code: code === "helper_changed" ? "helper_missing" : code, line: appleStateLine(code) } : null);
  if (r.on) return { on: true, name: r.name, tasks: tasksNow(), unavailable: r.backend === "apple" ? why(getRewriter()?.startCode?.()) : null };
  const h = appleHelperState(o);
  return { on: false, name: null, tasks: tasksNow(), unavailable: why(h.ok ? job?.outcome?.reason : h.reason) ?? why(r.reason) };
}

// ---- the setup, for the browser (GET|POST /api/setup-rewriter) -----------------------------------------------------------------
// The same pattern as the deeper checks' setup (src/checker.js startSetupChecker): one job for the whole server, a second start joins it,
// the outcome is kept until the next start so the page can poll. Always Apple's built-in model, from the helper this app copy ships (nothing is
// downloaded). Nothing starts unless the person pressed the setup button.
let job = null; // {promise} while running; {outcome: {reason, detail}} after a failure; null when idle or after a success

const reasonOf = (err) => (Object.hasOwn(APPLE_STATES, err?.reason) ? err.reason : "failed");

/** Starts the setup or joins the running one. `deps` (tests) go to setupRewriter: {probe, probeHelper, apple, clearQuarantine}. */
export function startSetupRewriter(deps = {}) {
  if (job?.promise) return job.promise;
  const mine = {};
  mine.promise = setupRewriter({ model: "apple" }, () => {}, deps).then(
    (r) => ((job = null), r),
    (err) => {
      job = { outcome: { reason: reasonOf(err), detail: untrusted(err?.message || "", 2000) } };
      throw err;
    },
  );
  mine.promise.catch(() => {}); // a click nobody awaits must not become an unhandled rejection
  job = mine;
  return mine.promise;
}

/** {state: "off" | "working" | "on" | "failed", reason?: a key of APPLE_STATES | "failed", detail?}. */
export function setupRewriterStatus() {
  if (job?.promise) return { state: "working" };
  if (rewriterStatus().on) return { state: "on" };
  if (job?.outcome) return { state: "failed", ...job.outcome };
  return { state: "off" };
}

export const resetSetupRewriterForTests = () => {
  job = null;
};
