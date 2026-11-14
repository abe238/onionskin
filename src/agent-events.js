// Turns the background agent's stream (Claude Code `--output-format stream-json`, one JSON object per line) into the plain activity lines the page
// shows, and into the facts the runner needs (session id, a sign-in or limit failure, how the run ended). Pure: no file, no process, no clock.
// Document text never reaches an activity line: the lines below are fixed words plus a count, whatever the agent or a tool printed.
// Claude Code only in this build; any other `cli` parses to nothing.

const sec = (n) => (n < 1e12 ? n * 1000 : n); // a reset time may come in seconds or in milliseconds

/** The top-level JSON objects inside a tool's output (a `reply --then-poll` prints more than one). Strings and nesting are respected; junk between them is skipped. */
function jsonDocs(text) {
  const out = [];
  const s = String(text);
  for (let i = 0; i < s.length && out.length < 4; i++) {
    if (s[i] !== "{") continue;
    let depth = 0;
    let inStr = false;
    let j = i;
    for (; j < s.length; j++) {
      const c = s[j];
      if (inStr) {
        if (c === "\\") j++;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) break;
    }
    if (depth !== 0) break; // cut off (a long batch can be shortened): nothing more to read
    try {
      out.push(JSON.parse(s.slice(i, j + 1)));
    } catch {}
    i = j;
  }
  return out;
}

/** The reply command's failure code, in words a person understands. */
const REPLY_FAILURES = {
  bad_reply: "the answer was not in the right shape",
  stale_batch: "the batch was no longer current",
  no_batch: "the batch was no longer current",
  write_refused: "the file could not be saved",
  not_applied: "the text no longer matched the document",
  invalid_ops: "an edit was not valid",
  apply_failed: "an edit could not be applied",
  done_failed: "the batch could not be finished",
};
export const replyFailureWords = (code) => REPLY_FAILURES[code] || "it was not accepted";

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** The tool output as one string (a string, or a list of {type:"text", text}). */
const toolText = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => (typeof x?.text === "string" ? x.text : "")).join("\n") : "");

function fromToolResult(r) {
  const text = toolText(r.content);
  if (r.is_error && /permission to use .* (has been )?denied|not allowed|don't ask mode/i.test(text)) return { activity: "Blocked a command it is not allowed to run", denial: true };
  if (r.is_error) return {};
  let activity;
  for (const d of jsonDocs(text)) {
    if (d && d.schema === "onionskin.batch/1") {
      const n = d.instructions?.comments?.length;
      activity = Number.isInteger(n) && n > 0 ? `Got your batch: ${plural(n, "comment", "comments")}` : "Got your batch";
    } else if (d && d.ok === true && ("applied" in d || "declined" in d || "finished" in d)) activity = "Done. The page shows what changed";
    else if (d && d.ok === false && "error" in d) activity = `The change did not go through: ${replyFailureWords(d.code)}`;
  }
  if (!activity && /"schema"\s*:\s*"onionskin\.batch\/1"/.test(text)) activity = "Got your batch"; // shortened output: it still is a batch
  return activity ? { activity } : {};
}

function fromToolUse(u) {
  const input = u.input || {};
  if (u.name === "Bash") {
    const cmd = String(input.command || "");
    if (/\bonionskin\s+poll\b/.test(cmd)) return "Waiting for you to press Send";
    if (/\bonionskin\s+reply\b/.test(cmd)) return "Making the changes";
    return undefined;
  }
  const file = String(input.file_path || input.path || "");
  if (u.name === "Read" && /\/reference\/[^/]+\.md$/.test(file)) return "Reading the instructions";
  if (u.name === "Write" && /(^|\/)reply[^/]*\.json$/.test(file)) return "Writing the changes";
  return undefined;
}

/**
 * One stream line -> what it tells us. Every field is optional:
 *   activity   a plain line for the page
 *   sessionId  Claude Code's session id (to resume after a crash)
 *   denial     true when a command was refused
 *   failure    "signed_out" | "limit", with resetsAt (milliseconds) for a limit that names its reset time
 *   result     the final event: {ok, turnsExhausted, denials}
 * A line that is not JSON, or an event this code does not know, gives {}.
 */
export function parseLine(cli, line) {
  if (cli !== "claude") return {};
  let e;
  try {
    e = JSON.parse(String(line));
  } catch {
    return {};
  }
  if (!e || typeof e !== "object") return {};
  const out = {};
  if (typeof e.session_id === "string" && e.session_id) out.sessionId = e.session_id;

  if (e.type === "rate_limit_event") {
    const info = e.rate_limit_info || {};
    if (info.status === "rejected") {
      out.failure = "limit";
      if (Number.isFinite(Number(info.resetsAt)) && Number(info.resetsAt) > 0) out.resetsAt = sec(Number(info.resetsAt));
    }
    return out; // "allowed_warning" is only a heads-up: not a failure
  }

  if (e.type === "assistant") {
    if (e.error === "authentication_failed") out.failure = "signed_out";
    else if (e.error === "rate_limit" || e.error === "billing_error") out.failure = "limit";
    const parts = Array.isArray(e.message?.content) ? e.message.content : [];
    let activity;
    for (const p of parts) {
      if (p?.type === "tool_use") activity = fromToolUse(p) ?? activity;
      else if (p?.type === "text" && !activity && !out.failure) activity = "Thinking"; // the text itself is never shown: it can quote the document
    }
    if (activity) out.activity = activity;
    return out;
  }

  if (e.type === "user") {
    const parts = Array.isArray(e.message?.content) ? e.message.content : [];
    for (const p of parts) {
      if (p?.type !== "tool_result") continue;
      const r = fromToolResult(p);
      if (r.activity) out.activity = r.activity;
      if (r.denial) out.denial = true;
    }
    return out;
  }

  if (e.type === "result") {
    const denials = Array.isArray(e.permission_denials) ? e.permission_denials.length : 0;
    out.result = { ok: e.is_error !== true, turnsExhausted: e.subtype === "error_max_turns", denials };
    if (denials) out.denial = true;
    if (e.is_error === true && e.terminal_reason === "api_error" && !out.failure && /authentication|\b401\b|log ?in|sign ?in/i.test(String(e.result || ""))) out.failure = "signed_out";
    return out;
  }
  return out;
}

/**
 * Why a run ended, as a failure code for the page, or null when it ended the way it should.
 *   failure    what parseLine saw in the stream ("signed_out" | "limit"): it wins
 *   denials    how many commands were refused; with a batch still held, the run was stopped by a refusal
 *   heldBatch  the agent's batch was still delivered when it exited
 * A run that gave its last result, exited 0 and holds no batch is a normal end (closed, superseded, recycled at the turn limit).
 */
export function classifyExit({ code = null, signal = null, sawResult = false, denials = 0, heldBatch = false, failure = null } = {}) {
  if (failure === "signed_out" || failure === "limit") return failure;
  if (denials > 0 && heldBatch) return "refused";
  if (code === 0 && !signal && sawResult && !heldBatch) return null;
  return "crashed";
}
