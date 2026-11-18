import fs from "node:fs";
import path from "node:path";
import { MAX_DOC_BYTES, PRODUCT, REFUSED_EXTENSIONS, env, formatOfExt } from "./constants.js";
import { checkRegularOwned, readDoc, replaceGuarded, sha256, Snapshots, WriteConflict, writeSiblingCopy } from "./fsutil.js";
import { hasDelivery, loadTicketRecord, parseTicket } from "./lease.js";
import { NOT_YOUR_FILE, agentMayUse, isAgentHolder } from "./agent-detect.js";
import { validatePackage } from "./package.js";
import { cleanFlag, hasControlChars } from "./sanitize.js";
import crypto from "node:crypto";
import { ensureStateDir, sessionKey } from "./paths.js";
import { demote, summarize, runOps } from "./ops/run.js";
import { htmlWriteOffThread } from "./offload.js";
import { validateOps } from "./ops/schema.js";

export const APPLY_EXIT = { ok: 0, error: 1, invalid: 2, not_applied: 3, partial: 4, write_refused: 5 };
const MAX_OPS_BYTES = 5 * 1024 * 1024;

export class ApplyError extends Error {
  constructor(message, exit = APPLY_EXIT.error, report = null) {
    super(message);
    this.exit = exit;
    this.report = report;
  }
}

export function parseApplyArgs(rest, inline = false) {
  const a = { file: "", ops: "", dryRun: false, partial: false, batch: "", holder: "", lease: "", standalone: false, summary: false };
  for (let i = 0; i < rest.length; i++) {
    const x = rest[i];
    const val = (name) => {
      const v = x.includes("=") ? x.slice(x.indexOf("=") + 1) : rest[++i];
      if (!v) throw new Error(`${name} wants a value`);
      return v;
    };
    if (x === "--dry-run") a.dryRun = true;
    else if (x === "--summary") a.summary = true;
    else if (x === "--partial") a.partial = true;
    else if (x === "--standalone") a.standalone = true;
    else if (x === "--ops" || x.startsWith("--ops=")) a.ops = val("--ops");
    else if (x === "--batch" || x.startsWith("--batch=")) a.batch = val("--batch");
    else if (x === "--holder" || x.startsWith("--holder=")) a.holder = val("--holder");
    else if (x === "--lease" || x.startsWith("--lease=")) a.lease = val("--lease");
    else if (x.startsWith("-")) throw new Error(`unknown option ${x}`);
    else if (!a.file) a.file = x;
    else throw new Error(`unexpected argument ${x}`);
  }
  if (!a.file || (!a.ops && !inline)) throw new Error(`Usage: ${PRODUCT.bin} apply <file> --ops ops.json --lease <ticket> [--dry-run] [--partial] [--batch batch.json]  (or --standalone when no review session is open for the file)`);
  return a;
}

function readJsonFile(file, what) {
  let st;
  try {
    st = fs.statSync(file);
  } catch (err) {
    throw new ApplyError(`cannot read ${what} ${file}: ${err.message}`, APPLY_EXIT.invalid);
  }
  if (!st.isFile() || st.size > MAX_OPS_BYTES) throw new ApplyError(`${what} ${file} is not a regular file under ${MAX_OPS_BYTES / 1024 / 1024} MB`, APPLY_EXIT.invalid);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new ApplyError(`${what} ${file} is not valid JSON: ${err.message}`, APPLY_EXIT.invalid);
  }
}

/** The format of a file by its extension: an HTML file (.html or .htm) is "html"; null when Onionskin does not edit that kind of file. */
export function formatOfPath(real) {
  return formatOfExt(path.extname(real));
}
const ONLY = "Only .docx, .xlsx, .pptx, .html and .htm files are supported";

const anchorMap = (batch) => new Map((batch?.untrusted_document_evidence?.anchors || []).map((a) => [a.id, a]));

/**
 * The file was changed by someone else: apply/commit report `status: "outside_change"` and where the agent's version was saved. Built from what the
 * server says (it made the name from the session's own file path). The agent must not retry and must not write the original.
 */
const OUTSIDE_INSTRUCTION = "Someone changed this file outside Onionskin. Do not retry and do not write the original. Report it in your results (done) with the copy's name, then stop and wait for the next batch.";
function outsideChangeOf(j) {
  if (j.code !== "conflict" || j.side !== "agent") return {};
  return {
    status: "outside_change",
    outside_change: {
      copy_path: typeof j.copy_path === "string" ? j.copy_path : null,
      copy_name: typeof j.copy_name === "string" ? j.copy_name : null,
      ...(j.copy_error ? { copy_error: String(j.copy_error).slice(0, 200) } : {}),
      instruction: OUTSIDE_INSTRUCTION,
    },
  };
}

const refusal = (message) => new ApplyError(message, APPLY_EXIT.write_refused);

/**
 * Who calls, checked before the file is read: an agent Onionskin started (ONIONSKIN_HOLDER onionskin-bg-* or onionskin-term-*) acts only on
 * its own file and only as itself (no --holder of another). Returns the holder that goes with the claim: --holder, else ONIONSKIN_HOLDER,
 * else the holder the server saved with the ticket.
 */
function callerHolder(a, real, ticket) {
  const envHolder = env("HOLDER", "");
  if (!agentMayUse(envHolder, real)) throw refusal(NOT_YOUR_FILE);
  if (isAgentHolder(envHolder) && a.holder && a.holder !== envHolder) throw refusal("--holder cannot name another holder for an agent Onionskin started. Nothing was written.");
  return a.holder || envHolder || (ticket ? loadTicketRecord(ticket.batch_id)?.holder : "") || "";
}

/**
 * The server's state for the file, asked before the file is read. With a ticket the delivered batch is handed out only to its holder, and a
 * ticket the server does not accept ends the command here, with no op run against the file. Returns {up, session, batch}.
 */
async function sessionState({ server, real, holder, ticket, wantBatch, report = "apply" }) {
  const up = await server.healthy();
  if (!up) return { up, session: null, batch: null };
  const q = holder ? `&holder=${encodeURIComponent(holder)}` : "";
  const r = await server.req({ method: "GET", path: `/cli/status?file=${encodeURIComponent(real)}${q}` });
  const body = (t) => {
    try {
      return server.json(t) || {};
    } catch {
      return {};
    }
  };
  if (r.status === 403 && body(r.text).code === "not_your_file") throw refusal(NOT_YOUR_FILE);
  const session = r.status === 200 ? server.json(r.text) : null;
  if (!session) return { up, session, batch: null };
  if (ticket) {
    const b = await server.req({ method: "GET", path: `/cli/batch?file=${encodeURIComponent(real)}${q}&batch_id=${encodeURIComponent(ticket.batch_id)}&lease_token=${encodeURIComponent(ticket.token)}` });
    if (b.status !== 200) {
      const j = body(b.text);
      if (j.code === "not_your_file") throw refusal(NOT_YOUR_FILE);
      const note = j.code === "missing_lease" ? `Cannot tell which holder this ticket belongs to: set ${PRODUCT.envPrefix}_HOLDER or pass --holder. Nothing was written.` : `The server does not accept this ticket for this file (${j.code === "no_batch" ? "no batch is delivered" : "it is not the current delivery's"}). Nothing was written. Run \`${PRODUCT.bin} status <file> --ticket\` (it answers only the agent that polled this batch) or poll again.`;
      // the same write_error a refused write reports, from the server's own content-free words; no op ran, so there are no results
      throw new ApplyError(note, APPLY_EXIT.write_refused, { schema: `onionskin.${report}-report/1`, file: real, written: false, write_path: "none", note, write_error: { status: b.status, code: typeof j.code === "string" ? j.code : null, message: typeof j.error === "string" ? j.error.slice(0, 300) : `server answered ${b.status}` } });
    }
    return { up, session, batch: server.json(b.text).batch };
  }
  if (!wantBatch) return { up, session, batch: null };
  const b = await server.req({ method: "GET", path: `/cli/batch?file=${encodeURIComponent(real)}${q}` });
  return { up, session, batch: b.status === 200 ? server.json(b.text).batch : null };
}

/**
 * Where a write may go, and under which credentials. Fails closed: a ticket, a delivered batch or a saved delivery for the file means the
 * write goes through the live session or does not happen. Standalone writes (no review session at all) need the explicit --standalone flag
 * and are refused while a live session or a saved delivery exists for the file.
 * Returns {via: "session", claim} or {via: "standalone"}; throws ApplyError(write_refused).
 */
async function resolveWriteTarget({ a, real, session, up, ticket, holder }) {
  const live = !!session && session.state !== "closed";
  const delivered = live && ["working", "queued"].includes(session.state);
  const saved = hasDelivery(real);
  const recover = `Run \`${PRODUCT.bin} status <file> --ticket\` (it answers only the agent that polled this batch) or poll again.`;
  if (ticket) {
    if (!up) throw refusal(`The ${PRODUCT.name} server is not running, so the delivery named by --lease cannot be checked. Nothing was written. ${recover}`);
    if (!session) throw refusal(`The server has no session for this file, so the delivery named by --lease is gone. Nothing was written. ${recover}`);
    if (session.state === "closed") throw refusal(`The session for this file is closed; the delivery named by --lease no longer exists. Nothing was written.`);
    if (!delivered) throw refusal(`This file has an open ${PRODUCT.name} session in state "${session.state}": no batch is delivered, so the ticket is void. Nothing was written. Run \`${PRODUCT.bin} poll\` and wait for the user's Send.`);
    if (session.delivered_batch !== ticket.batch_id) throw refusal(`The ticket belongs to batch ${ticket.batch_id}, but the delivered batch is ${session.delivered_batch}: your delivery was taken back, finished or handed on. Nothing was written. Run \`${PRODUCT.bin} poll\` again.`);
    if (!holder) throw refusal(`Cannot tell which holder this ticket belongs to: set ${PRODUCT.envPrefix}_HOLDER or pass --holder. Nothing was written.`);
    return { via: "session", claim: { holder, lease_token: ticket.token, batch_id: ticket.batch_id } };
  }
  if (a.standalone) {
    if (live) throw refusal(`A ${PRODUCT.name} session is open for this file (state "${session.state}"), so a standalone write is refused: it would bypass the lease and the user's review. Use the ticket from \`poll\` (--lease).`);
    if (saved) throw refusal(`A delivery is saved for this file but its session is not available; a standalone write is refused. ${recover}`);
    return { via: "standalone" };
  }
  if (delivered || saved) throw refusal(`A batch is delivered for this file: pass the ticket printed in the batch's commands (--lease <batch id>:<token>). There is no fallback to "the last poll". ${recover}`);
  if (live) throw refusal(`this file has an open ${PRODUCT.name} session in state "${session.state}": no batch is delivered to you, so ${PRODUCT.bin} will not write. Run \`${PRODUCT.bin} poll\` and wait for the user's Send (or use --dry-run).`);
  throw refusal(`No ${PRODUCT.name} session is open for this file. To edit it without a review, pass --standalone; to work inside a review, run \`${PRODUCT.bin} open\` and \`poll\` first.`);
}

/** The standalone write: lock, compare-and-swap against `expectSha`, snapshot of what is replaced, re-hash before the rename. Returns {snapshot, acl} or {refused}. */
function standaloneWrite(real, original, out, expectSha, label) {
  ensureStateDir();
  const snaps = new Snapshots(sessionKey(real));
  if (!snaps.index().some((e) => e.original)) snaps.add(original, "original", { original: true });
  let snapshot = null;
  try {
    const info = replaceGuarded(real, out, {
      expectSha,
      snapshotBefore: (disk) => {
        snapshot = snaps.add(disk, label);
      },
      snapshotNewer: (newer) => snaps.add(newer, "newer version found while writing"),
    });
    return { snapshot, acl: info.acl };
  } catch (err) {
    if (err instanceof WriteConflict) {
      let outside = { instruction: OUTSIDE_INSTRUCTION, copy_path: null, copy_name: null };
      try {
        const c = writeSiblingCopy(real, out);
        outside = { ...outside, copy_path: c.path, copy_name: c.name };
      } catch (e) {
        outside.copy_error = `the copy could not be saved: ${e.code || e.message}`.slice(0, 200);
      }
      return { refused: "Someone changed this file outside Onionskin while apply was working; the original was left untouched and nothing was overwritten.", outside };
    }
    if (err.code === "ENOSPC_SNAP") return { refused: `no snapshot, nothing written: ${err.message}` };
    if (["LOCK_BUSY", "ACL_NOT_PRESERVED"].includes(err.code)) return { refused: `${err.message}; nothing was written.` };
    throw err;
  }
}

/**
 * `onionskin apply`. `server` = {healthy(), req(options, body), json(text)} for the CLI socket.
 * `inline` ({ops, batch}, used by `reply`) supplies the ops document and the delivered batch in memory instead of --ops / the session fetch;
 * every check below runs on it exactly as on a file.
 * Returns {exit, report}; throws ApplyError for failures before any op ran.
 */
export async function applyCommand(rest, server, inline = null) {
  const a = parseApplyArgs(rest, !!inline);
  let real;
  try {
    real = fs.realpathSync(path.resolve(a.file));
  } catch {
    throw new ApplyError(`File not found: ${JSON.stringify(a.file.slice(0, 200))}`);
  }
  if (hasControlChars(real)) throw new ApplyError("This file's path contains control or bidirectional-text characters. Rename or move the file and run apply again.");
  const ext = path.extname(real).toLowerCase();
  if (REFUSED_EXTENSIONS.has(ext)) throw new ApplyError(`${ext} (macro-enabled) files are refused`);
  const format = formatOfPath(real);
  if (!format) throw new ApplyError(ONLY);

  const doc = inline ? inline.ops : readJsonFile(a.ops, "ops file");
  const v = validateOps(doc);
  if (!v.ok) throw new ApplyError("the ops file does not match the schema", APPLY_EXIT.invalid, { schema: "onionskin.apply-report/1", status: "invalid_ops", errors: v.errors });

  // the only credential is the ticket (--lease): not the batch JSON, not whatever the last poll of this file saved
  const ticket = parseTicket(a.lease);
  if (a.lease && !ticket) throw new ApplyError("--lease wants the value printed in the batch's commands (<batch id>:<token>)", APPLY_EXIT.invalid);
  if (ticket && a.standalone) throw new ApplyError("--lease and --standalone contradict each other", APPLY_EXIT.invalid);
  // authorization before the file is read: who calls, what the server holds for the file, and (with a ticket) that the server accepts it.
  // Nothing below reads, parses or runs an op on the document until then, so a refusal carries nothing of it.
  const holder = callerHolder(a, real, ticket);
  const st = await sessionState({ server, real, holder, ticket, wantBatch: !inline?.batch && !a.batch });
  const { up, session } = st;
  const batch = inline?.batch ?? (a.batch ? readJsonFile(a.batch, "batch file") : st.batch);

  checkRegularOwned(real);
  let bytes;
  try {
    bytes = readDoc(real); // refuses by size before reading
  } catch (err) {
    if (err.code === "TOO_LARGE") throw new ApplyError(`document too large: ${err.message}`);
    throw err;
  }
  // an HTML file is no package: the driver reads it in the ops worker and refuses every op of a file it cannot read (src/ops/html.js)
  if (format !== "html") {
    try {
      validatePackage(bytes, format);
    } catch (err) {
      throw new ApplyError(`Not a valid .${format}: ${err.message}`);
    }
  }
  // a run inside the server (src/local.js) reads the bytes within the readers' caps before the engine does, on the server's thread
  if (server.checkBytes && format !== "html") {
    try {
      server.checkBytes(bytes, format);
    } catch (err) {
      throw new ApplyError(String(err?.message || err)); // nothing ran: the local runner hands the batch to the agent
    }
  }
  const baseSha = sha256(bytes);
  // where the write must go (no op has run yet): through the server when a session tracks this file (it owns the lease, the compare-and-swap and the snapshots)
  let target = { via: "none" };
  if (!a.dryRun) target = await resolveWriteTarget({ a, real, session, up, ticket, holder });
  const claim = target.claim;
  const viaSession = target.via === "session";

  // a run inside the server (src/local.js) has the engine work in a worker thread (server.runOps), off the server's own thread
  const run = server.runOps ?? runOps;
  const { results: ran, bytes: out, warnings, blocked } = await run({ bytes, format, name: path.basename(real), ops: doc.ops, partial: a.partial, anchors: anchorMap(batch) });
  const results = ran;
  const refuseWrite = (note, extra = {}) => {
    // nothing reached disk, so no op may read `applied`
    report.results = demote(report.results, note);
    report.counts = summarize(report.results);
    report.note = note;
    if (a.dryRun) Object.assign(report, { would_write: false, would_write_partial: false });
    return { exit: APPLY_EXIT.write_refused, report: Object.assign(report, extra) };
  };
  const counts = summarize(results);
  const failed = results.length - counts.applied;
  const report = {
    schema: "onionskin.apply-report/1",
    file: real,
    format,
    mode: a.partial ? "partial" : "atomic",
    dry_run: a.dryRun,
    written: false,
    write_path: a.dryRun ? "none" : target.via,
    base_sha256: baseSha,
    counts,
    results,
    ...(warnings.length ? { warnings: warnings.map(cleanFlag) } : {}),
  };
  const runId = `run_${crypto.randomBytes(4).toString("hex")}`;
  let exit = failed === 0 ? APPLY_EXIT.ok : a.partial && counts.applied ? APPLY_EXIT.partial : APPLY_EXIT.not_applied;

  if (viaSession) {
    // tell the session what could not be applied (also when nothing gets written), so the user sees it with the run
    // problems are keyed by op (index + name): a later run that applies the op clears an earlier failure for it
    const problems = results.filter((r) => !["applied", "not_applied"].includes(r.status)).map((r) => ({ key: `${r.index}:${r.op}`, op: r.op, status: r.status, code: r.code, reason: r.reason }));
    if (problems.length) await server.req({ method: "POST", path: "/cli/apply-report" }, { file: real, ...claim, run: runId, problems, applied: [] }).catch(() => {});
  }
  if (blocked) return refuseWrite("The engine's output failed the package check (a part, relationship, drawing or link was lost). Nothing was written.", { blocked_by_safety_check: blocked.map(cleanFlag) });
  if (a.dryRun) {
    // what a real run would do: atomic writes only when every op applies, --partial writes the ops that apply
    const writes = (r) => !!r.bytes && r.results.some((x) => x.status === "applied");
    const wouldWrite = a.partial ? writes({ bytes: out, results }) : failed === 0 && !!out;
    const wouldWritePartial = a.partial ? wouldWrite : failed === 0 ? wouldWrite : writes(await run({ bytes, format, name: path.basename(real), ops: doc.ops, partial: true, anchors: anchorMap(batch) }));
    report.would_write = wouldWrite;
    report.would_write_partial = wouldWritePartial;
    report.note = `dry run: nothing was written. A real run in ${report.mode} mode would ${wouldWrite ? "write the file" : "write nothing"}${a.partial ? "" : `; with --partial it would ${wouldWritePartial ? "write the ops that apply" : "write nothing"}`}.`;
    return { exit, report };
  }
  if (!out) {
    report.note = failed ? "nothing was written" : "no op changed the document";
    return { exit, report };
  }

  if (viaSession) {
    // the ops go with the bytes: the server keeps them so that a later merge of the user's edits can check how the file changed
    const w = await server.req({ method: "POST", path: "/cli/agent-write" }, { file: real, base_sha256: baseSha, bytes_b64: out.toString("base64"), ops: doc.ops, partial: a.partial, ...claim });
    const j = server.json(w.text);
    if (w.status !== 200) {
      return refuseWrite("The server refused the write; the file on disk is unchanged.", { write_error: { status: w.status, code: j.code || null, message: j.error || `server answered ${w.status}` }, ...outsideChangeOf(j) });
    }
    report.written = true;
    report.new_sha256 = j.sha256;
    report.lease_expires_at = j.lease_expires_at;
    // only a write that landed clears an earlier failure of the same op (a blocked or refused write applied nothing)
    const appliedKeys = results.filter((r) => r.status === "applied").map((r) => `${r.index}:${r.op}`);
    if (appliedKeys.length) await server.req({ method: "POST", path: "/cli/apply-report" }, { file: real, ...claim, run: runId, problems: [], applied: appliedKeys }).catch(() => {});
    report.note = `written through the ${PRODUCT.name} session (lease renewed, previous version snapshotted)`;
  } else {
    // standalone: the same lock, compare-and-swap and atomic write, plus a snapshot of the bytes we replace in the state dir
    const w = standaloneWrite(real, bytes, out, baseSha, "before apply (standalone)");
    if (w.refused) return refuseWrite(w.refused, w.outside ? { status: "outside_change", outside_change: w.outside } : {});
    report.snapshot = w.snapshot;
    report.acl = w.acl;
    report.written = true;
    report.new_sha256 = sha256(out);
    report.note = `standalone: no active ${PRODUCT.name} session for this file (explicit --standalone), so no lease was involved. Written atomically; the previous version is snapshotted in the state dir (${report.snapshot.slice(0, 12)}).`;
  }
  return { exit, report };
}

export function parseCommitArgs(rest) {
  const a = { file: "", from: "", lease: "", base: "", holder: "", standalone: false };
  for (let i = 0; i < rest.length; i++) {
    const x = rest[i];
    const val = (name) => {
      const v = x.includes("=") ? x.slice(x.indexOf("=") + 1) : rest[++i];
      if (!v) throw new Error(`${name} wants a value`);
      return v;
    };
    if (x === "--standalone") a.standalone = true;
    else if (x === "--from" || x.startsWith("--from=")) a.from = val("--from");
    else if (x === "--lease" || x.startsWith("--lease=")) a.lease = val("--lease");
    else if (x === "--base" || x.startsWith("--base=")) a.base = val("--base");
    else if (x === "--holder" || x.startsWith("--holder=")) a.holder = val("--holder");
    else if (x.startsWith("-")) throw new Error(`unknown option ${x}`);
    else if (!a.file) a.file = x;
    else throw new Error(`unexpected argument ${x}`);
  }
  if (!a.file || !a.from) throw new Error(`Usage: ${PRODUCT.bin} commit <file> --from <candidate file> --lease <ticket> [--base <sha256>]  (or --standalone --base <sha256> when no review session is open)`);
  return a;
}

/**
 * `onionskin commit <file> --from <candidate>`: the only way a document edited with another tool (python-docx, openpyxl, python-pptx, ...)
 * reaches the file. The agent edits a COPY; this submits the copy's bytes through the same authenticated write as `apply` (lease check,
 * compare-and-swap, snapshot, locked atomic replace). The original path is never written by the agent.
 * The base the candidate was edited from is, unless --base says otherwise, the hash the server last wrote or delivered for the batch;
 * if the file moved since, the commit is refused with `conflict` and the agent starts over from a fresh copy.
 */
export async function commitCommand(rest, server, { check = htmlWriteOffThread } = {}) {
  const a = parseCommitArgs(rest);
  let real;
  try {
    real = fs.realpathSync(path.resolve(a.file));
  } catch {
    throw new ApplyError(`File not found: ${JSON.stringify(a.file.slice(0, 200))}`);
  }
  if (hasControlChars(real)) throw new ApplyError("This file's path contains control or bidirectional-text characters. Rename or move the file and run commit again.");
  const ext = path.extname(real).toLowerCase();
  if (REFUSED_EXTENSIONS.has(ext)) throw new ApplyError(`${ext} (macro-enabled) files are refused`);
  const format = formatOfPath(real);
  if (!format) throw new ApplyError(ONLY);
  let candidatePath;
  try {
    candidatePath = fs.realpathSync(path.resolve(a.from));
  } catch {
    throw new ApplyError(`candidate file not found: ${JSON.stringify(a.from.slice(0, 200))}`, APPLY_EXIT.invalid);
  }
  const ticket = parseTicket(a.lease);
  if (a.lease && !ticket) throw new ApplyError("--lease wants the value printed in the batch's commands (<batch id>:<token>)", APPLY_EXIT.invalid);
  if (ticket && a.standalone) throw new ApplyError("--lease and --standalone contradict each other", APPLY_EXIT.invalid);
  const holder = callerHolder(a, real, ticket);
  if (candidatePath === real) throw new ApplyError("--from is the document itself: edit a COPY (cp the file to a temp path first) and commit that", APPLY_EXIT.invalid);
  const cst = fs.statSync(candidatePath);
  if (!cst.isFile() || cst.size > MAX_DOC_BYTES) throw new ApplyError(`candidate ${a.from} is not a regular file under ${MAX_DOC_BYTES / 1024 / 1024} MB`, APPLY_EXIT.invalid);
  if (a.base && !/^[0-9a-f]{64}$/.test(a.base)) throw new ApplyError("--base wants a sha256 in lower-case hex", APPLY_EXIT.invalid);
  const candidate = fs.readFileSync(candidatePath);
  // an HTML candidate is checked as a whole new version (src/html-write.js): by the server for a session, below for a standalone commit
  if (format !== "html") {
    try {
      validatePackage(candidate, format);
    } catch (err) {
      throw new ApplyError(`The candidate is not a valid .${format}: ${err.message}. Nothing was written.`, APPLY_EXIT.write_refused);
    }
  }

  const { up, session } = await sessionState({ server, real, holder, ticket, wantBatch: false, report: "commit" });
  const target = await resolveWriteTarget({ a, real, session, up, ticket, holder });
  const report = { schema: "onionskin.commit-report/1", file: real, format, written: false, write_path: target.via, candidate_sha256: sha256(candidate) };
  if (target.via === "session") {
    const w = await server.req({ method: "POST", path: "/cli/commit" }, { file: real, bytes_b64: candidate.toString("base64"), ...(a.base ? { base_sha256: a.base } : {}), ...target.claim });
    const j = server.json(w.text);
    if (w.status !== 200) return { exit: APPLY_EXIT.write_refused, report: { ...report, note: "The server refused the commit; the file on disk is unchanged.", write_error: { status: w.status, code: j.code || null, message: j.error || `server answered ${w.status}` }, ...outsideChangeOf(j) } };
    return { exit: APPLY_EXIT.ok, report: { ...report, written: true, new_sha256: j.sha256, lease_expires_at: j.lease_expires_at, note: `committed through the ${PRODUCT.name} session (lease renewed, previous version snapshotted)` } };
  }
  if (!a.base) throw new ApplyError("a standalone commit needs --base <sha256 of the file the candidate was edited from> so a newer version is never overwritten", APPLY_EXIT.invalid);
  checkRegularOwned(real);
  const disk = readDoc(real);
  let out = candidate;
  if (format === "html") {
    // R1, R12: the same check as the server's, in a worker, against exactly the bytes whose hash is --base (a disk that differs now and
    // is put back before the write would otherwise let a change the base forbids through); the compare-and-swap of standaloneWrite runs
    // after the await, against --base again. A refusal here writes no copy: the candidate was never checked.
    if (sha256(disk) !== a.base) return { exit: APPLY_EXIT.write_refused, report: { ...report, note: "The file on disk is not the version --base names (someone changed it outside Onionskin); nothing was checked and nothing was written.", status: "outside_change", outside_change: { instruction: OUTSIDE_INSTRUCTION, copy_path: null, copy_name: null, copy_error: "no copy was saved: the candidate was not checked against the version on disk" } } };
    const c = await check({ before: disk, after: candidate });
    if (!c.ok) return { exit: APPLY_EXIT.write_refused, report: { ...report, note: `${c.reason} Nothing was written.`, write_error: { status: 422, code: c.code, message: c.reason, ...(c.reasons ? { reasons: c.reasons } : {}) } } };
    out = c.bytes;
  }
  const w = standaloneWrite(real, disk, out, a.base, "before commit (standalone)");
  if (w.refused) return { exit: APPLY_EXIT.write_refused, report: { ...report, note: w.refused, ...(w.outside ? { status: "outside_change", outside_change: w.outside } : {}) } };
  return { exit: APPLY_EXIT.ok, report: { ...report, written: true, new_sha256: sha256(out), snapshot: w.snapshot, acl: w.acl, note: "standalone (explicit --standalone): written atomically; the previous version is snapshotted in the state dir" } };
}

/** The compact form of an apply or commit report (`--summary`): per-op statuses, flags, written, ok. The full report is the default. */
export function summarizeReport(report, exit) {
  const codes = (list) => (Array.isArray(list) ? list.map((f) => f.code).filter(Boolean) : undefined);
  return {
    schema: `${report.schema}-summary`,
    ok: exit === 0,
    exit,
    ...(report.mode ? { mode: report.mode } : {}),
    ...(report.dry_run !== undefined ? { dry_run: report.dry_run } : {}),
    written: !!report.written,
    ...(report.would_write !== undefined ? { would_write: report.would_write, would_write_partial: report.would_write_partial } : {}),
    ...(report.counts ? { counts: report.counts } : {}),
    ...(report.results ? { ops: report.results.map((r) => ({ index: r.index, op: r.op, ...(r.id ? { id: r.id } : {}), status: r.status, ...(r.code ? { code: r.code } : {}) })) } : {}),
    ...(report.warnings ? { warnings: codes(report.warnings) } : {}),
    ...(report.blocked_by_safety_check ? { blocked_by_safety_check: codes(report.blocked_by_safety_check) } : {}),
    ...(report.status ? { status: report.status } : {}),
    ...(report.note ? { note: report.note } : {}),
  };
}
