import fs from "node:fs";
import path from "node:path";
import { PRODUCT, unknownFormat } from "./constants.js";
import { ApplyError, APPLY_EXIT, applyCommand, formatOfPath } from "./apply.js";
import { loadTicketRecord, parseTicket } from "./lease.js";
import { NOT_YOUR_FILE, agentMayUse, isAgentHolder } from "./agent-detect.js";
import { QUESTION_FIX, QUESTIONS_PER_BATCH, cleanQuestion } from "./question.js";
import { SUGGESTIONS_MAX, SUGGEST_FIX, cleanSuggestion } from "./review.js";
import { VOICE_FIX, cleanVoiceDraft } from "./voice-guide.js";

/**
 * `onionskin reply`: one call that answers a whole batch. The agent names comment ids and says what to change; this command fills in
 * the anchor ids and the `expect` hashes from the batch the session holds (never from the agent), then runs the SAME `apply` code
 * (validation, lease ticket, protected checks, atomic or --partial write) and, when the write landed, the SAME `done` path.
 */

const MAX_INPUT_BYTES = 5 * 1024 * 1024;
const MODES = ["find", "text", "set", "ops", "decline", "ask"];
const SHORTHAND_EXTRAS = ["occurrence", "all", "match_case"]; // passed to replace_text / replace_text_in_shape with `find`

/** A failure with a JSON body for stdout and the exit code to use. */
export class ReplyError extends Error {
  constructor(message, { exit = APPLY_EXIT.invalid, body = {} } = {}) {
    super(message);
    this.exit = exit;
    this.body = { ok: false, finished: false, error: message, ...body };
  }
}

// --then-poll waits this long unless --timeout says otherwise: just under the 10 minute cap most agent shells put on one command
const THEN_POLL_SECONDS = 590;
const clip = (s, n = 60) => (String(s).length > n ? String(s).slice(0, n - 1) + "…" : String(s));
/** The note the user reads when the agent gave none: says what was done, from the reply itself. */
const autoNote = (r, mode) =>
  mode === "find" ? (r.replace === "" ? `Removed "${clip(r.find)}".` : `Replaced "${clip(r.find)}" with "${clip(r.replace)}".`) : mode === "text" ? "Rewrote this text." : mode === "set" ? "Set the value." : mode === "decline" ? "Declined." : "Done.";

export function parseReplyArgs(rest) {
  const a = { file: "", lease: "", json: null, from: "", partial: false, thenPoll: false, timeout: 0 };
  for (let i = 0; i < rest.length; i++) {
    const x = rest[i];
    const val = (name) => {
      const v = x.includes("=") ? x.slice(x.indexOf("=") + 1) : rest[++i];
      if (v === undefined || v === "") throw new Error(`${name} wants a value`);
      return v;
    };
    if (x === "--partial") a.partial = true;
    else if (x === "--then-poll") a.thenPoll = true;
    else if (x === "--lease" || x.startsWith("--lease=")) a.lease = val("--lease");
    else if (x === "--json" || x.startsWith("--json=")) a.json = val("--json");
    else if (x === "--file" || x.startsWith("--file=")) a.from = val("--file");
    else if (x === "--timeout" || x.startsWith("--timeout=")) {
      a.timeout = Number(val("--timeout"));
      if (!Number.isFinite(a.timeout) || a.timeout <= 0) throw new Error("--timeout wants a number of seconds, e.g. --timeout 300");
    } else if (x.startsWith("-")) throw new Error(`unknown option ${x}`);
    else if (!a.file) a.file = x;
    else throw new Error(`unexpected argument ${x}`);
  }
  if (!a.file && !a.lease) throw new Error(`Usage: ${PRODUCT.bin} reply [<file>] --lease <ticket> [--json '<json>' | --file <path>] [--partial] [--then-poll [--timeout N]]  (JSON on stdin when neither --json nor --file is given; the ticket names the file when <file> is left out)`);
  if (a.json !== null && a.from) throw new Error("--json and --file contradict each other");
  if (a.timeout && !a.thenPoll) throw new Error("--timeout only goes with --then-poll");
  if (a.lease && !parseTicket(a.lease)) throw new Error("--lease wants the value printed in the batch (<batch id>:<token>)");
  if (a.thenPoll && !a.timeout) a.timeout = THEN_POLL_SECONDS;
  return a;
}

/**
 * An agent Onionskin started (holder onionskin-bg-* or, in Terminal, onionskin-term-*) answers only with `--file`, and only with the one file the
 * server's prompt names: <ONIONSKIN_AGENT_DIR>/reply-<the batch id of --lease>.json, a regular file (its real path, so no symlink leads out).
 * So a hostile document cannot make it read some other file into a reply. A parse error there never quotes the input.
 */
function checkBackgroundInput(a, agentDir, batchId) {
  const want = agentDir ? path.join(agentDir, `reply-${batchId}.json`) : `reply-${batchId}.json in your work folder`;
  const fix = `write the reply JSON with the Write tool to ${want}, then pass it with --file`;
  if (!a.from) throw new ReplyError("the background agent answers with --file only", { body: { code: "bad_reply", lease_kept: true, fix } });
  let real = null, dir = null;
  try {
    dir = fs.realpathSync(agentDir || "");
    real = fs.realpathSync(a.from);
  } catch {}
  if (!agentDir || !dir || !real || real !== path.join(dir, `reply-${batchId}.json`) || !fs.lstatSync(real).isFile()) throw new ReplyError(`the background agent's --file must be ${want} (a file in its own work folder)`, { body: { code: "bad_reply", lease_kept: true, fix } });
  a.from = real; // read what was checked
}

async function readInput(a, readStdin, { quiet = false } = {}) {
  let raw;
  if (a.json !== null) raw = a.json;
  else if (a.from) {
    let st;
    try {
      st = fs.statSync(a.from);
    } catch (err) {
      throw new ReplyError(`cannot read ${a.from}: ${err.message}`);
    }
    if (!st.isFile() || st.size > MAX_INPUT_BYTES) throw new ReplyError(`${a.from} is not a regular file under ${MAX_INPUT_BYTES / 1024 / 1024} MB`);
    raw = fs.readFileSync(a.from, "utf8");
  } else raw = await readStdin();
  if (Buffer.byteLength(raw) > MAX_INPUT_BYTES) throw new ReplyError("the reply JSON is larger than 5 MB");
  try {
    return JSON.parse(raw);
  } catch (err) {
    // quiet: a position at most, never the characters of the input
    throw new ReplyError(quiet ? `the reply is not valid JSON${/position \d+/.test(err.message) ? ` (at ${/position \d+/.exec(err.message)[0]})` : ""}` : `the reply is not valid JSON: ${err.message}`);
  }
}

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const bad = (comment, code, reason, fix) => ({ comment, code, reason, ...(fix ? { fix } : {}) });

/**
 * Pure: the reply JSON and the delivered batch -> {ops, owners, replies, errors}. `owners[i]` is the comment id op i answers (null for a
 * batch-wide op). `errors` is empty when the reply can be applied. Nothing here reads the file or the agent's idea of a hash.
 */
export function planReplies(batch, input, { partial = false } = {}) {
  const errors = [];
  const ops = [];
  const owners = [];
  const replies = []; // {comment, decline, note, opIndexes:[...]}
  if (!isObj(input)) return { ops, owners, replies, errors: [bad(null, "bad_reply", "the reply must be a JSON object: {\"summary\":...,\"replies\":[...]}")] };
  for (const k of Object.keys(input)) {
    if (!["summary", "replies", "ops", "suggest", "voice_draft", "document_instructions_ignored"].includes(k)) errors.push(bad(null, "bad_reply", `unknown top-level field "${k}"`, "allowed: summary, replies, ops, suggest, voice_draft, document_instructions_ignored"));
  }
  if (batch.instructions?.voice_request) {
    const r = planVoiceDraft(input);
    return { ...r, errors: [...errors, ...r.errors] };
  }
  if (input.voice_draft !== undefined) errors.push(bad(null, "voice_draft_not_allowed", "voice_draft answers a voice guide request; this batch is not one", batch.instructions?.review ? "answer with suggest" : "answer each comment in replies"));
  if (batch.instructions?.review) {
    const r = planSuggestions(batch, input);
    return { ...r, errors: [...errors, ...r.errors] };
  }
  if (input.suggest !== undefined) errors.push(bad(null, "suggest_not_allowed", "suggest answers a review; this batch is not one", "answer each comment in replies"));
  if (input.summary !== undefined && typeof input.summary !== "string") errors.push(bad(null, "bad_reply", "summary must be a string"));
  if (!Array.isArray(input.replies)) errors.push(bad(null, "bad_reply", "replies must be an array (it may be empty when the batch has only an overall note)"));
  if (input.ops !== undefined && !Array.isArray(input.ops)) errors.push(bad(null, "bad_reply", "ops must be an array of full ops"));
  if (errors.length) return { ops, owners, replies, errors };

  const comments = batch.instructions?.comments || [];
  const byId = new Map(comments.map((c) => [c.id, c]));
  const anchors = new Map((batch.untrusted_document_evidence?.anchors || []).map((x) => [x.id, x]));
  const seen = new Set();
  const format = batch.format;

  input.replies.forEach((r, i) => {
    const at = `replies[${i}]`;
    if (!isObj(r) || typeof r.comment !== "string" || !r.comment) return errors.push(bad(null, "bad_reply", `${at} needs a "comment" id`));
    const id = r.comment;
    if (!byId.has(id)) return errors.push(bad(id, "unknown_comment", `no comment ${JSON.stringify(id.slice(0, 64))} in the delivered batch`, `comment ids of this batch: ${comments.map((c) => c.id).join(", ") || "(none)"}`));
    if (seen.has(id)) return errors.push(bad(id, "duplicate_reply", "this comment is answered twice", "one reply per comment; put several ops in its `ops` array"));
    seen.add(id);
    const modes = MODES.filter((m) => (m === "find" ? "find" in r || "replace" in r : m in r));
    if (modes.length !== 1) return errors.push(bad(id, "bad_reply", modes.length ? `give exactly one of find+replace, text, set, ops, decline, ask (got ${modes.join(", ")})` : "give one of find+replace, text, set, ops, decline, ask", "see reference/ops.md, section reply"));
    const mode = modes[0];
    // a question carries no note and no ops: the card shows only the question and its options
    const allowed = mode === "ask" ? ["comment", "ask", "options"] : ["comment", "note", ...(mode === "find" ? ["find", "replace", ...SHORTHAND_EXTRAS] : [mode])];
    const extra = Object.keys(r).filter((k) => !allowed.includes(k));
    if (extra.length) return errors.push(bad(id, "bad_reply", `unexpected field(s) for ${mode}: ${extra.join(", ")}`, mode === "ask" ? "a question has only comment, ask and options" : undefined));
    if (mode === "ask") {
      // the same checks as done (the trust boundary), here only so the agent gets a fix before anything is sent
      if (byId.get(id).answer) return errors.push(bad(id, "already_asked", "this comment already carries the user's answer to a question", "one question per comment: carry out the reading the user chose, or decline"));
      const q = cleanQuestion({ ask: r.ask, options: r.options });
      if (!q.question) return errors.push(bad(id, "bad_question", q.reason, QUESTION_FIX));
      if (replies.filter((x) => x.ask).length >= QUESTIONS_PER_BATCH) return errors.push(bad(id, "too_many_questions", `at most ${QUESTIONS_PER_BATCH} questions per batch`, "decline the others, or carry out the likeliest reading"));
      replies.push({ comment: id, ask: true, question: q.question, opIndexes: [] });
      return;
    }
    if (r.note !== undefined && typeof r.note !== "string") return errors.push(bad(id, "bad_reply", "note must be a string"));
    const rep = { comment: id, decline: mode === "decline", note: r.note || autoNote(r, mode), opIndexes: [] };
    replies.push(rep);
    if (mode === "decline") {
      if (r.decline !== true) errors.push(bad(id, "bad_reply", "decline must be true"));
      return;
    }
    if (mode === "ops") {
      if (!Array.isArray(r.ops) || !r.ops.length || !r.ops.every(isObj)) return errors.push(bad(id, "bad_reply", "ops must be a non-empty array of full ops"));
      for (const op of r.ops) (rep.opIndexes.push(ops.length), ops.push(op), owners.push(id));
      return;
    }
    // shorthand: the anchor of this comment supplies target and expect
    const anchor = anchors.get(byId.get(id).anchor_id);
    const hash = anchor?.resolved ? anchor.locator?.text_hash : null;
    const refuse = (code, reason, fix) => errors.push(bad(id, code, reason, fix));
    if (!anchor?.resolved || !anchor.locator) return refuse("anchor_unresolved", "this comment's anchor did not resolve to a place in the file", "decline it, or send full `ops` with your own target");
    if (!hash) return refuse("anchor_has_no_hash", "this anchor carries no text hash to check against (an empty or whole-sheet or slide-level anchor)", "send full `ops` with your own target and expect, or decline");
    const base = { id, target: { anchor_id: anchor.id }, expect: { text_hash: hash } };
    let op;
    if (mode === "find") {
      if (typeof r.find !== "string" || !r.find || typeof r.replace !== "string") return refuse("bad_reply", "find needs a non-empty string and replace needs a string");
      const extras = Object.fromEntries(SHORTHAND_EXTRAS.filter((k) => k in r).map((k) => [k, r[k]]));
      if (format === "docx" || format === "html") op = { op: "replace_text", ...base, find: r.find, replace: r.replace, ...extras };
      else if (format === "pptx") op = { op: "replace_text_in_shape", ...base, find: r.find, replace: r.replace, ...extras };
      else if (format !== "xlsx") return unknownFormat(format, "reply find");
      else return refuse("shorthand_not_for_format", "find/replace does not apply to a .xlsx cell", "use `set` for a cell or range");
    } else if (mode === "text") {
      if (typeof r.text !== "string") return refuse("bad_reply", "text must be a string");
      if (format === "docx") op = { op: "replace_text", ...base, text: r.text };
      else if (format === "html") op = { op: "set_text", ...base, text: r.text };
      else if (format === "pptx") op = { op: "set_shape_text", ...base, paragraphs: r.text.split("\n") };
      else if (format !== "xlsx") return unknownFormat(format, "reply text");
      else return refuse("shorthand_not_for_format", "text does not apply to a .xlsx cell", "use `set` for a cell or range");
    } else if (mode === "set") {
      if (format !== "xlsx") return refuse("shorthand_not_for_format", `set applies to a .xlsx cell or range, not a .${format}`, "use `find`+`replace` or `text`");
      op = { op: "set_cells", ...base, values: r.set };
    }
    rep.opIndexes.push(ops.length);
    ops.push(op);
    owners.push(id);
  });

  (input.ops || []).forEach((op) => {
    if (!isObj(op)) return errors.push(bad(null, "bad_reply", "every entry of ops must be an op object"));
    ops.push(op);
    owners.push(null);
  });

  const missing = comments.filter((c) => !seen.has(c.id)).map((c) => c.id);
  if (missing.length && !partial) errors.push(bad(null, "missing_reply", `no reply for comment(s): ${missing.join(", ")}`, "answer every comment (decline what you will not do), or pass --partial"));
  return { ops, owners, replies, errors };
}

/** The run's summary when the agent gave none. A change that answered only the overall note has no comment to count, so `written` says it. */
export function autoSummaryText({ applied, declined, asked, written, userEdits = 0 }) {
  const parts = [applied ? `${applied} changed` : "", declined ? `${declined} declined` : "", asked ? `${asked} question${asked > 1 ? "s" : ""}` : ""].filter(Boolean);
  if (parts.length) return parts.join(", ");
  if (written) return "Changed the file as your note asked";
  // a Send that carried only the person's own edits: they are in the file already, so "No change needed" alone reads as if nothing was kept
  return userEdits ? "Your edits are saved. Nothing else needed changing." : "No change needed";
}

/**
 * A review batch (instructions.review): the answer is `suggest` only. Nothing is written, so no ops and no replies. The checks are the ones
 * `done` makes against the file (src/review.js), here against the batch's units, so the agent learns what to fix before anything is sent.
 */
function planSuggestions(batch, input) {
  const errors = [];
  const none = { ops: [], owners: [], replies: [] };
  if (input.ops !== undefined || (input.replies !== undefined && !(Array.isArray(input.replies) && input.replies.length === 0))) errors.push(bad(null, "review_only", "this batch is a review: change nothing", `answer with {"suggest":[...]} only (${SUGGEST_FIX})`));
  if (input.summary !== undefined && typeof input.summary !== "string") errors.push(bad(null, "bad_reply", "summary must be a string"));
  const list = input.suggest ?? [];
  if (!Array.isArray(list)) errors.push(bad(null, "bad_suggestion", "suggest must be a list", SUGGEST_FIX));
  else if (list.length > SUGGESTIONS_MAX) errors.push(bad(null, "too_many_suggestions", `at most ${SUGGESTIONS_MAX} suggestions (got ${list.length}); more than that and none would be shown`, "keep the most important ones"));
  else {
    const units = batch.untrusted_document_evidence?.units || [];
    list.forEach((raw, i) => {
      const c = cleanSuggestion(raw, units, batch.format);
      if (c.reason) errors.push(bad(null, "bad_suggestion", `suggest[${i}]: ${c.reason}`, SUGGEST_FIX));
    });
  }
  return { ...none, errors, suggestions: Array.isArray(list) ? list : [] };
}

/**
 * A voice guide request (instructions.voice_request): the answer is `voice_draft` only, a Markdown draft of the guide. Nothing is written,
 * so no replies, ops or suggest. The check is the one `done` makes (cleanVoiceDraft), here only so the agent learns what to fix.
 */
function planVoiceDraft(input) {
  const errors = [];
  if (input.ops !== undefined || input.suggest !== undefined || (input.replies !== undefined && !(Array.isArray(input.replies) && input.replies.length === 0))) errors.push(bad(null, "voice_only", "this batch asks for a draft of the voice guide: change nothing", 'answer with {"voice_draft": "..."} only, no replies, ops or suggest'));
  if (input.summary !== undefined && typeof input.summary !== "string") errors.push(bad(null, "bad_reply", "summary must be a string"));
  const d = cleanVoiceDraft(input.voice_draft);
  if (d.code) errors.push(bad(null, "bad_voice_draft", input.voice_draft === undefined ? "voice_draft is missing" : `${d.code}: ${d.reason}`, VOICE_FIX));
  return { ops: [], owners: [], replies: [], errors };
}

const FIX = {
  expect_mismatch: "The text there is not what the batch said (the file changed since). Decline this comment, or poll again for a fresh batch.",
  anchor_not_found: "Read the reason: the find text must occur in the anchor (once, or add occurrence/all), or the anchor no longer resolves to one place. Correct the reply, decline this comment, or send full `ops` with an explicit target.",
  skipped_protected: "Protected place (field, equation, content control or similar): it cannot be rewritten losslessly. Decline this comment with a note.",
};
const fixFor = (r) => FIX[r.status] || (r.status === "refused" ? `Refused by the engine${r.code ? ` (${r.code})` : ""}. Change the op as the reason says, or decline.` : undefined);
const brief = (comment, r) => ({ comment, op: r.op, status: r.status, ...(r.code ? { code: r.code } : {}), ...(r.reason ? { reason: r.reason } : {}), ...(Array.isArray(r.reasons) ? { reasons: r.reasons } : {}), ...(r.actual_excerpt ? { actual_excerpt: r.actual_excerpt } : {}), ...(fixFor(r) ? { fix: fixFor(r) } : {}) });

/**
 * The command. `deps` = {server: {healthy, req, json}, finish(file, results, lease) -> done's JSON, pollNext(file, timeout) -> string, readStdin(), holder?}.
 * Returns {exit, body, next, emitted} where `body` is the JSON object for stdout (already written through `deps.emitBody` when `emitted`) and `next` (with --then-poll) the second line; a failed wait becomes {status: "poll_failed"}.
 * Throws ReplyError for input problems; everything it prints is JSON on stdout.
 */
export async function replyCommand(rest, deps) {
  let a;
  try {
    a = parseReplyArgs(rest);
  } catch (err) {
    throw new ReplyError(err.message);
  }
  const { server } = deps;
  // who calls: the local runner names itself; otherwise ONIONSKIN_HOLDER (an agent Onionskin started cannot change it), else the holder the
  // server saved with this ticket. It goes with every request, so the server checks the binding and the lease before it hands out anything.
  const envHolder = process.env[`${PRODUCT.envPrefix}_HOLDER`];
  const ticketOfArgs = parseTicket(a.lease);
  const holder = deps.holder || envHolder || (ticketOfArgs ? loadTicketRecord(ticketOfArgs.batch_id)?.holder : null) || "";
  const notYours = () => new ReplyError(NOT_YOUR_FILE, { exit: APPLY_EXIT.write_refused, body: { code: "not_your_file" } });
  if (!a.file) {
    // no file given: the whole ticket (batch id and token) names the session; a wrong token names none
    if (!(await server.healthy())) throw new ReplyError(`the ${PRODUCT.name} server is not running, so the delivery named by --lease cannot be checked. Nothing was written.`, { exit: APPLY_EXIT.write_refused });
    const w = await server.req({ method: "GET", path: `/cli/batch-file?batch_id=${encodeURIComponent(ticketOfArgs?.batch_id || "")}&lease_token=${encodeURIComponent(ticketOfArgs?.token || "")}&holder=${encodeURIComponent(holder)}` });
    a.file = w.status === 200 ? server.json(w.text).file || "" : "";
    if (!a.file) throw new ReplyError(`No delivered batch matches this ticket: your delivery was taken back, finished or handed on. Nothing was written. Run \`${PRODUCT.bin} poll <file>\` again.`, { exit: APPLY_EXIT.write_refused, body: { code: "stale_batch" } });
  }
  // an agent Onionskin started: its own input first (only its one reply file, content-free checks), then its binding to its one file,
  // refused before that file is looked at, in the same words whether it exists or is open
  const bg = !deps.holder && isAgentHolder(envHolder);
  const ticketRequired = () => new ReplyError(`--lease <ticket> is required: it is the lease_ticket of the batch (\`${PRODUCT.bin} status <file> --ticket\` prints it again)`);
  let input;
  if (bg) {
    if (!ticketOfArgs) throw ticketRequired();
    checkBackgroundInput(a, process.env[`${PRODUCT.envPrefix}_AGENT_DIR`], ticketOfArgs.batch_id);
    input = await readInput(a, deps.readStdin, { quiet: true });
    if (!agentMayUse(envHolder, a.file)) throw notYours();
  }
  let real;
  try {
    real = fs.realpathSync(path.resolve(a.file));
  } catch {
    throw new ReplyError(`File not found: ${JSON.stringify(a.file.slice(0, 200))}`, { exit: APPLY_EXIT.error });
  }
  if (!formatOfPath(real)) throw new ReplyError("Only .docx, .xlsx, .pptx, .html and .htm files are supported");
  const ticket = ticketOfArgs;
  if (!ticket) throw ticketRequired();
  if (!bg) input = await readInput(a, deps.readStdin, { quiet: false });

  // authorization first: the server hands out the batch the session holds for this delivery (the only source of anchors and hashes) only
  // to this ticket's holder, checked before the reply is planned or run against the file
  if (!(await server.healthy())) throw new ReplyError(`the ${PRODUCT.name} server is not running, so the delivery named by --lease cannot be checked. Nothing was written.`, { exit: APPLY_EXIT.write_refused });
  const r = await server.req({ method: "GET", path: `/cli/batch?file=${encodeURIComponent(real)}&holder=${encodeURIComponent(holder)}&batch_id=${encodeURIComponent(ticket.batch_id)}&lease_token=${encodeURIComponent(ticket.token)}` });
  let refused = null;
  try {
    refused = r.status === 200 ? null : server.json(r.text);
  } catch {
    refused = {};
  }
  if (refused?.code === "not_your_file") throw notYours();
  if (refused?.code === "no_batch") throw new ReplyError(`No batch is delivered for this file, so the ticket is void. Nothing was written. Run \`${PRODUCT.bin} poll\` and wait for the user's Send.`, { exit: APPLY_EXIT.write_refused, body: { code: "no_batch" } });
  if (refused) throw new ReplyError(`This ticket is not the delivery the session holds: your delivery was taken back, finished or handed on, or the ticket is wrong. Nothing was written. Run \`${PRODUCT.bin} poll\` again.`, { exit: APPLY_EXIT.write_refused, body: { code: refused.code === "not_lease_holder" ? "not_lease_holder" : "stale_batch" } });
  const held = server.json(r.text).batch;
  if (!held || held.batch_id !== ticket.batch_id) throw new ReplyError(`This ticket is not the delivery the session holds. Nothing was written. Run \`${PRODUCT.bin} poll\` again.`, { exit: APPLY_EXIT.write_refused, body: { code: "stale_batch" } });

  const plan = planReplies(held, input, { partial: a.partial });
  if (plan.errors.length) throw new ReplyError("the reply cannot be applied; nothing was written and the batch is still open", { body: { code: "bad_reply", lease_kept: true, problems: plan.errors } });

  const failedReplies = new Map(); // comment id -> first failing op result (partial mode)
  const partlyApplied = new Map(); // comment id -> note: some of its ops applied, some did not (partial mode)
  let written = false;
  let opsApplied = 0;
  let problems = [];
  if (plan.ops.length) {
    let out;
    try {
      // deps.holder: the local runner names its own holder, so an ONIONSKIN_HOLDER in the server's environment cannot stand in for it
      out = await applyCommand([real, "--lease", a.lease, ...(a.partial ? ["--partial"] : []), ...(deps.holder ? ["--holder", deps.holder] : [])], server, { ops: { schema: "onionskin.ops/1", ops: plan.ops }, batch: held });
    } catch (err) {
      if (!(err instanceof ApplyError)) throw err;
      const rep = err.report;
      const mapped = rep?.errors ? rep.errors.map((e) => ({ comment: plan.owners[Number(/^\$\.ops\[(\d+)\]/.exec(e)?.[1])] ?? null, error: e })) : undefined;
      throw new ReplyError(err.message, { exit: err.exit, body: { code: rep?.status || (err.exit === APPLY_EXIT.write_refused ? "write_refused" : "apply_failed"), ...(rep?.status === "invalid_ops" ? { lease_kept: true } : {}), ...(mapped ? { problems: mapped } : {}), ...(rep?.write_error ? { write_error: rep.write_error } : {}), ...(rep?.outside_change ? { outside_change: rep.outside_change } : {}) } });
    }
    const { report, exit } = out;
    written = !!report.written;
    opsApplied = report.results.filter((x) => x.status === "applied").length;
    const failed = report.results.filter((x) => x.status !== "applied");
    problems = failed.filter((x) => x.status !== "not_applied").map((x) => brief(plan.owners[x.index], x));
    const stopped = report.status === "outside_change" || (exit !== APPLY_EXIT.ok && !(a.partial && exit === APPLY_EXIT.partial));
    if (stopped) {
      // nothing was finished: the batch stays delivered, the lease is kept, the agent fixes the named replies and calls again
      throw new ReplyError(report.note || "the ops did not apply; nothing was written and the batch is still open", {
        exit,
        body: { code: report.status || (report.written === false && report.write_error ? "write_refused" : "not_applied"), written: false, ...(exit === APPLY_EXIT.not_applied || report.blocked_by_safety_check ? { lease_kept: true } : {}), problems, ...(report.blocked_by_safety_check ? { blocked_by_safety_check: report.blocked_by_safety_check } : {}), ...(report.write_error ? { write_error: report.write_error } : {}), ...(report.outside_change ? { outside_change: report.outside_change } : {}) },
      });
    }
    const failedIdx = new Set(failed.map((x) => x.index));
    for (const x of failed) {
      const c = plan.owners[x.index];
      if (!c || failedReplies.has(c)) continue;
      const mine = plan.replies.find((rep) => rep.comment === c)?.opIndexes || [];
      // several ops, only some failed: the edit is partly in the file, so the comment is not reported as declined
      if (mine.length > 1 && mine.some((i) => !failedIdx.has(i))) partlyApplied.set(c, `${mine.filter((i) => failedIdx.has(i)).length} of ${mine.length} ops did not apply (${x.code || x.status})`);
      else failedReplies.set(c, x);
    }
  }

  // results for done: built from the replies, never from the agent's idea of what happened
  const applied = [];
  const declined = [];
  const asked = [];
  const results = plan.replies.map((rep) => {
    if (rep.ask) {
      asked.push(rep.comment);
      return { comment_id: rep.comment, status: "asked", ask: rep.question.text, options: rep.question.options };
    }
    const f = failedReplies.get(rep.comment);
    if (rep.decline || f) {
      declined.push(rep.comment);
      const why = f ? `Not applied (${f.code || f.status}).${rep.note ? ` ${rep.note}` : ""}` : rep.note;
      return { comment_id: rep.comment, status: "declined", note: why };
    }
    applied.push(rep.comment);
    const part = partlyApplied.get(rep.comment);
    return { comment_id: rep.comment, status: "done", note: part ? `Partly applied: ${part}.${rep.note ? ` ${rep.note}` : ""}` : rep.note };
  });
  const autoSummary = autoSummaryText({ applied: applied.length, declined: declined.length, asked: asked.length, written, userEdits: held.untrusted_document_evidence?.user_edits?.length || 0 });
  const review = !!held.instructions?.review;
  const voice = !!held.instructions?.voice_request;
  const ignoredField = input.document_instructions_ignored !== undefined ? { document_instructions_ignored: input.document_instructions_ignored } : {};
  // a review's suggestions and a voice draft go to done as the agent wrote them: done checks them again (the trust boundary)
  const finishBody = voice
    ? { summary: input.summary || "Drafted a voice guide.", results: [], voice_draft: input.voice_draft, ...ignoredField }
    : { summary: input.summary || (review ? "" : autoSummary), results, ...(review ? { suggestions: plan.suggestions } : {}), ...ignoredField };
  let j;
  try {
    j = await deps.finish(real, finishBody, a.lease);
  } catch (err) {
    throw new ReplyError(`${written ? "The edit is in the file, but " : ""}the batch could not be finished: ${err.message}`, { exit: APPLY_EXIT.error, body: { code: "done_failed", written, results: finishBody } });
  }
  const body = {
    ok: !!j.ok,
    // `applied` lists comment ids only: a reply whose ops answered the overall note has none, so these two say whether the file changed
    changed: written,
    ops_applied: opsApplied,
    applied,
    declined,
    asked,
    ...(problems.length ? { not_applied: problems } : {}),
    ...(review ? { suggested: Number(j.suggestions) || 0, not_shown: Number(j.dropped) || 0 } : {}),
    // "received": kept for the user to review (they read and approve every word before it is saved); "not_kept": done refused it
    ...(voice ? { voice_draft: j.voice_draft === "kept" ? "received" : "not_kept" } : {}),
    flags: j.flags || [],
    ...(j.checks?.notice ? { checks_notice: j.checks.notice } : {}),
  };
  if (!a.thenPoll) return { exit: APPLY_EXIT.ok, body, next: null };
  // the batch is finished: say so first, so a kill or a failure while waiting for the next batch never hides the result
  if (deps.emitBody) await deps.emitBody(body);
  let next;
  try {
    next = await deps.pollNext(real, a.timeout);
  } catch (err) {
    next = { status: "poll_failed", error: String(err?.message || err).slice(0, 300) };
  }
  return { exit: APPLY_EXIT.ok, body, next, emitted: !!deps.emitBody };
}
