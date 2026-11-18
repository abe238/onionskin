// Runs on this Mac a whole Send that Onionskin can do without an agent. A local run is an ordinary delivery to a holder that lives
// inside the server: the batch, the lease ticket, `reply` and `apply` (validation, bind, expect, protected and package checks), the
// server's agent-write with its compare-and-swap and snapshot, `done` with its checks, the activity entry and Revert are all the ones an
// agent's run takes. There is no second write path. When the runner cannot finish before anything is written, the batch goes to the agent
// as if this had never been tried (Sessions.handBack).
//
// What the runner writes comes from a planner (a closed pattern applied to the person's own words: idea 8), from the ops of an agent's
// review card the person accepted (idea 21), or from a quick fix the person saw and tapped Use on (idea 10, src/suggest.js).
// Document text and model output only ever fill `find`/`replace`/`text` fields, which the same checks as an agent's reply judge; nothing
// moves into the batch's instructions, and the batch is never changed.
//
// Ceiling: `apply` runs the engine on the server's main thread, as the merge does; a large file pauses other requests for that time.
// Upgrade path: run applyCommand in a worker with the same in-process port.

import { quickPlanner } from "./quick-plan.js";
import { NOT_YOUR_FILE, agentMayUse, isAgentHolder } from "./agent-detect.js";
import { HttpError, readChecked } from "./session.js";
import { runOpsOffThread } from "./offload.js";
import { LIMITS } from "./agent-runner.js";

export const LOCAL_HOLDER = "onionskin-local";

/** The note every comment of a local run gets when its write was refused because the file changed (the person's words, docs/contracts/routes.md). */
export const REFUSED_NOTE = "The file changed while this was being done, so nothing was written. Send it again.";

/**
 * A job that carries `reply` (a quick fix's "Use this", src/suggest.js) skips the planners: the server built that reply from the
 * suggestion it stored, and it goes through the same `reply` call as a planner's.
 *
 * The planners of this build, in order. Each is {name, wants(s, batch) -> boolean (synchronous, pure: reads the person's own words and
 * the session, never the disk), plan(s, batch) -> Promise<{reply} | null>}. `reply` is the JSON `onionskin reply` takes.
 * Idea 8 (quick changes, src/quick-plan.js) is the only one: idea 10 applies nothing at Send.
 */
export const PLANNERS = [quickPlanner];

const PLAN_MS = 5000; // a planner that has not answered by then hands the batch to the agent

/** The delivery a CLI call names: batch, holder, token (all required by Sessions). Shared by the socket routes and the in-process port. */
export function leaseOf(body) {
  const str = (v) => (typeof v === "string" && v ? v : null);
  return { holder: str(body.holder), token: str(body.lease_token), batchId: str(body.batch_id), strict: true };
}

/**
 * The binding of an agent Onionskin started to its one file, checked before a /cli/* route looks the file up: another file, open or not,
 * gets the same 403 `not_your_file`, so the refusal says nothing about it. Every other holder passes (its lease is checked where it acts).
 */
export function checkBinding(file, holder) {
  if (!agentMayUse(holder, file)) throw new HttpError(403, NOT_YOUR_FILE, { code: "not_your_file" });
}

/** The session a CLI call names, after the holder's binding is checked. */
export function sessionFor(sessions, file, holder) {
  checkBinding(file, holder);
  return sessions.byFile(String(file || ""));
}

/**
 * `GET /cli/batch`: the delivered batch. With a claim (any of holder-with-token, batch_id, lease_token), and always for an agent Onionskin
 * started, only for the lease holder (Sessions.deliveredBatch), checked before anything of it is returned. A call with no claim and no
 * agent holder (a person's own tools, `apply --dry-run` without a ticket) gets it as before: such a caller can read the file and the state
 * folder anyway; the restricted agent can only run the CLI, which always sends its holder.
 */
export function cliBatch(sessions, s, { holder, token, batchId }) {
  if (token || batchId || isAgentHolder(holder)) return { state: sessions.state(s), batch: sessions.deliveredBatch(s.key, { holder, token, batchId }) };
  return { state: sessions.state(s), batch: s.delivered?.batch || null };
}

/** `GET /cli/batch-file`: the file of the delivery named by a full ticket (batch id and token) for this holder, or null. Never a file for a wrong token. */
export function batchFile(sessions, { holder, token, batchId }) {
  if (!batchId || !token) return null;
  const s = [...sessions.map.values()].find((x) => x.delivered?.batch.batch_id === batchId && x.delivered.lease.token === token);
  return s && agentMayUse(holder, s.file) ? s.file : null;
}

/** The claim of a GET route's query (holder, lease_token, batch_id). */
export const claimOfQuery = (q) => leaseOf({ holder: q.get("holder"), lease_token: q.get("lease_token"), batch_id: q.get("batch_id") });

/** `GET /cli/status`: what `apply`, `commit` and `done` read about a file's session. One function for the socket and the in-process port. */
export function cliStatus(sessions, s) {
  const v = sessions.view(s);
  return {
    state: v.state, locked: v.locked, pollers: v.pollers, pending_batch: v.pendingBatchId, delivered_batch: v.deliveredBatchId,
    lease_expires_at: v.leaseExpiresAt, comments: { draft: s.comments.filter((c) => c.status === "draft").length, total: s.comments.length },
    unsent_edits: s.edits.length, activity: s.activity.length,
  };
}

// A tab gone this long no longer holds the update back: the same 20 minutes after which the background agent of a file with no tab stops
// (src/agent-runner.js LIMITS.idleMs). A forgotten session does not block updates forever.
export const TAB_RECENT_MS = LIMITS.idleMs;

/**
 * `GET /cli/open-work`: the sum of cliStatus over every session (what `onionskin update` would cut off). Counts only, never file names.
 * `open_sessions`: sessions not closed with a tab open now (`tabs(key)`) or seen less than TAB_RECENT_MS ago (`seen(key)`, a time). The
 * page keeps typed edits to itself until Send, so `unsent_edits` cannot see them: an open tab is the only sign of them.
 */
export function openWork(sessions, { tabs = () => 0, seen = () => null, now = Date.now() } = {}) {
  const w = { sessions: 0, open_sessions: 0, unsent_edits: 0, draft_comments: 0, batches: 0 };
  for (const s of sessions.map.values()) {
    const st = cliStatus(sessions, s);
    w.sessions++;
    const t = seen(s.key);
    if (!s.closed && (tabs(s.key) > 0 || (Number.isFinite(t) && now - t < TAB_RECENT_MS))) w.open_sessions++;
    w.unsent_edits += st.unsent_edits;
    w.draft_comments += st.comments.draft;
    if (st.pending_batch || st.delivered_batch) w.batches++;
  }
  return w;
}

/** The person reverted a local run of these words: they go to the agent. True when any comment of the batch, or its whole note, is marked. */
export function skipsLocal(s, batch) {
  const ids = new Set((batch.instructions?.comments || []).map((c) => c.id));
  if (s.comments.some((c) => ids.has(c.id) && c.skipLocal)) return true;
  const note = String(batch.instructions?.overall_note || "").trim();
  return !!s.skipLocalNote && note !== "" && note === String(s.skipLocalNote).trim();
}

/**
 * The CLI socket's routes that `reply` and `apply` call, answered in process by the same Sessions calls, for this one session only.
 * An HttpError becomes {status, text} exactly as the socket's fail() writes it, so `apply` takes the same refusal paths.
 */
function inProcessPort(sessions, key) {
  const answer = async (fn) => {
    try {
      return { status: 200, text: JSON.stringify(await fn()) };
    } catch (err) {
      if (Number.isInteger(err?.status)) return { status: err.status, text: JSON.stringify({ error: err.message, ...(err.extra || {}) }) };
      return { status: 500, text: JSON.stringify({ error: "internal error" }) };
    }
  };
  const mine = (file) => {
    const s = sessions.byFile(String(file || ""));
    if (s.key !== key) throw Object.assign(new Error("no such session"), { status: 404 });
    return s;
  };
  return {
    healthy: async () => true,
    json: (t) => JSON.parse(t),
    checkBytes: (bytes, format) => readChecked(format, bytes), // apply reads the file again: within the readers' caps before the engine
    runOps: runOpsOffThread, // and the engine's work happens in a worker thread with a time limit, never on the server's thread
    async req({ method, path: p }, body = {}) {
      const u = new URL(p, "http://x");
      const route = `${method} ${u.pathname}`;
      if (route === "GET /cli/status") return answer(() => cliStatus(sessions, mine(u.searchParams.get("file"))));
      if (route === "GET /cli/batch") return answer(() => cliBatch(sessions, mine(u.searchParams.get("file")), claimOfQuery(u.searchParams)));
      if (route === "POST /cli/agent-write") {
        return answer(() => {
          const s = mine(body.file);
          const bytes = typeof body.bytes_b64 === "string" ? Buffer.from(body.bytes_b64, "base64") : null;
          return sessions.agentWriteChecked(s.key, { baseSha: String(body.base_sha256 || ""), bytes, route: "apply", ops: Array.isArray(body.ops) ? body.ops : null, partial: body.partial === true, ...leaseOf(body) });
        });
      }
      if (route === "POST /cli/apply-report") {
        return answer(() => {
          const s = mine(body.file);
          return sessions.noteApply(s.key, { ...leaseOf(body), run: typeof body.run === "string" ? body.run : "", problems: Array.isArray(body.problems) ? body.problems : [], applied: Array.isArray(body.applied) ? body.applied.filter((k) => typeof k === "string") : [] });
        });
      }
      return { status: 404, text: JSON.stringify({ error: "not found" }) };
    },
  };
}

function within(promise, ms) {
  let timer;
  return Promise.race([Promise.resolve(promise).finally(() => clearTimeout(timer)), new Promise((resolve) => (timer = setTimeout(() => resolve(null), ms)))]);
}

/**
 * The runner. `finishRun(key, results, claim)` is the server's end of a run (the `/cli/done` body). `planners` defaults to PLANNERS;
 * tests add a stub planner to `runner.planners`. Sessions asks `wants` once per batch id, synchronously, before any poller.
 */
export function localRunner(sessions, { finishRun, planners = [...PLANNERS] } = {}) {
  const pick = (s, batch) =>
    runner.planners.find((p) => {
      try {
        return p.wants(s, batch) === true;
      } catch {
        return false;
      }
    });

  const runner = {
    planners,
    planMs: PLAN_MS,
    wants: (s, batch) => !skipsLocal(s, batch) && !!pick(s, batch),

    /** Runs the delivery named by `ticket` ({batchId, token, job?}, from the `local` event). Never throws. Resolves with what happened, for tests. */
    async run(key, ticket) {
      try {
        return await attempt(key, ticket);
      } catch (err) {
        console.error(`local run failed: ${err?.code || err?.name || "error"}`); // never the message: it can quote the document
        return giveUp(key, ticket);
      }
    },
  };

  const claimOf = (ticket) => ({ holder: LOCAL_HOLDER, token: ticket.token, batchId: ticket.batchId, strict: true });
  const finish = (key, ticket, results) => finishRun(key, results, claimOf(ticket));

  /**
   * Nothing was written: hand the batch to the agent (or drop an accepted suggestion). Refused once a write landed: then the run is left to
   * the lease expiry, which records what is in the file and gives the batch to the agent (as for an agent that stopped responding).
   */
  async function giveUp(key, ticket) {
    let s;
    try {
      s = sessions.get(key);
    } catch {
      return "gone";
    }
    const accept = !!s.delivered?.accept;
    try {
      if (accept) sessions.dropLocal(key, claimOf(ticket));
      else sessions.handBack(key, claimOf(ticket));
      return accept ? "dropped" : "handed_back";
    } catch (err) {
      if (err?.extra?.code !== "written") return "stale"; // taken back, finished or handed on meanwhile: nothing of ours to settle
    }
    return "left";
  }

  async function finishDeclined(key, ticket, batch) {
    const results = { summary: REFUSED_NOTE, results: (batch?.instructions?.comments || []).map((c) => ({ comment_id: c.id, status: "declined", note: REFUSED_NOTE })) };
    try {
      await finish(key, ticket, results);
      return "declined";
    } catch {
      return "left"; // the lease expires and the tick records what is in the file; the batch then goes to the agent
    }
  }

  async function attempt(key, ticket) {
    let s;
    try {
      s = sessions.get(key);
    } catch {
      return "gone";
    }
    const d = s.delivered;
    if (!d?.local || d.batch.batch_id !== ticket.batchId || d.lease.token !== ticket.token) return "stale"; // taken back or closed before this ran
    const batch = d.batch;
    const lease = `${ticket.batchId}:${ticket.token}`;
    const server = inProcessPort(sessions, key);
    const [{ ReplyError, replyCommand }, { ApplyError, applyCommand }] = await Promise.all([import("./reply.js"), import("./apply.js")]); // they pull in the engine

    if (Array.isArray(ticket.job?.ops)) {
      // an accepted suggestion of the agent's review: the stored ops, through apply (--partial) and done
      let out;
      try {
        out = await applyCommand([s.file, "--lease", lease, "--partial", "--holder", LOCAL_HOLDER], server, { ops: { schema: "onionskin.ops/1", ops: ticket.job.ops }, batch });
      } catch (err) {
        if (!(err instanceof ApplyError)) throw err;
        return giveUp(key, ticket);
      }
      if (!out.report.written) return giveUp(key, ticket);
      // which ops landed, by their ids (the card ids): done marks those cards accepted and the rest stale
      const accepted = out.report.results.filter((r) => r.status === "applied" && typeof r.id === "string").map((r) => r.id);
      const results = { summary: typeof ticket.job.summary === "string" ? ticket.job.summary : "", results: [], accepted };
      try {
        await finish(key, ticket, results);
        return "done";
      } catch {
        return retryFinish(key, ticket, results, batch);
      }
    }

    // a quick fix the person tapped Use on (src/suggest.js): its reply was built by the server from its stored text, not planned now
    const stored = ticket.job?.reply ? { reply: ticket.job.reply } : null;
    const planner = stored ? null : pick(s, batch);
    const plan = stored ?? (planner ? await within(Promise.resolve().then(() => planner.plan(s, batch)), runner.planMs).catch(() => null) : null);
    if (!plan?.reply) return giveUp(key, ticket);
    if (sessions.get(key).delivered !== d) return "stale"; // taken back while the planner worked
    try {
      await replyCommand([s.file, "--lease", lease, "--json", JSON.stringify(plan.reply)], {
        server,
        holder: LOCAL_HOLDER,
        finish: (_file, results) => finish(key, ticket, results),
        readStdin: async () => "",
      });
      return "done";
    } catch (err) {
      if (!(err instanceof ReplyError)) throw err;
      const code = err.body?.code;
      if (code === "done_failed") return retryFinish(key, ticket, err.body.results, batch);
      // the server refused the write because the file changed: nothing was written, and the agent would meet the same file. Finish with the fixed note.
      if (code === "outside_change" || err.body?.write_error?.code === "conflict") return finishDeclined(key, ticket, batch);
      return giveUp(key, ticket); // no match, expect or protected refusal, a bad plan: nothing written, the agent gets the batch
    }
  }

  /** `done` failed after the write: once more, then hand back if nothing was written, else leave it to the lease expiry (as for an agent). */
  async function retryFinish(key, ticket, results, batch) {
    try {
      await finish(key, ticket, results);
      return "done";
    } catch {
      return giveUp(key, ticket);
    }
  }

  return runner;
}
