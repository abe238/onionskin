#!/usr/bin/env node
// A stand-in for the `claude` command, for the background agent's browser tests. Installed as `claude` in a temp folder (see fake-side.mjs).
// It answers `--version` and `auth status --json`, and in `-p` mode prints Claude Code's stream-json lines while it runs the REAL `onionskin poll`
// and `onionskin reply` (found on PATH), the way scripts/real-run/fake-agent.mjs does. It never reads a document's text as instructions: its one edit is fixed.
// `purge <dir> --yes` is recorded in `purged`. The folder holding this file may hold `mode`: "signed_out" (auth fails), "crash" (exits 1 as soon as a batch arrives), "limit" (prints the plan-limit event when a batch arrives and exits), "outline" (sets the first outline unit to a fixed title), "outline-file" (finds a fixed sentence in the batch's outline file), "hold" (keeps the batch and waits; on a signal it records the signal in `signals`, tries a
// late reply with its lease into `late.json`, then exits a second later), or empty. Every start appends its pid to `pids`, and "resume" or "fresh" to `starts`.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const mode = (() => {
  try {
    return fs.readFileSync(path.join(here, "mode"), "utf8").trim();
  } catch {
    return "";
  }
})();
const args = process.argv.slice(2);
if (args[0] === "--version") (console.log("2.1.323 (Claude Code)"), process.exit(0));
if (args[0] === "auth") {
  if (mode === "signed_out") (console.log(JSON.stringify({ loggedIn: false })), process.exit(1));
  console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }));
  process.exit(0);
}

if (args[0] === "purge") (fs.appendFileSync(path.join(here, "purged"), `${args[1]}\n`), process.exit(0)); // Close session removes the conversation
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const sessionId = args[args.indexOf("--session-id") + 1] || "fake-session";
fs.appendFileSync(path.join(here, "pids"), `${process.pid}\n`);
fs.appendFileSync(path.join(here, "starts"), `${args.includes("--resume") ? "resume" : "fresh"}\n`);
if (mode === "signed_out") {
  emit({ type: "assistant", error: "authentication_failed", message: { content: [{ type: "text", text: "Not logged in" }] }, session_id: sessionId });
  emit({ type: "result", subtype: "success", is_error: true, terminal_reason: "api_error", result: "Invalid authentication credentials", permission_denials: [], session_id: sessionId });
  process.exit(1);
}
const prompt = args[args.indexOf("-p") + 1] || "";
const file = prompt.match(/document: `([^`]+)`/)?.[1] || process.env.FAKE_CLAUDE_FILE;
const workDir = process.env.ONIONSKIN_AGENT_DIR || process.cwd();
const run = (...a) => spawnSync("onionskin", a, { encoding: "utf8", env: process.env, maxBuffer: 64 * 1024 * 1024 });
let n = 0;
const bash = (command) => {
  const id = `tu${++n}`;
  emit({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] }, session_id: sessionId });
  return id;
};
const result = (id, content) => emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content }] }, session_id: sessionId });

emit({ type: "system", subtype: "init", session_id: sessionId, tools: ["Bash", "Read", "Write"] });
emit({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu0", name: "Read", input: { file_path: path.join(here, "reference", "ops.md") } }] }, session_id: sessionId });
for (;;) {
  const id = bash(`onionskin poll ${file} --timeout 30`);
  const r = run("poll", file, "--timeout", "30");
  result(id, r.stdout);
  let j = {};
  try {
    j = JSON.parse(r.stdout);
  } catch {}
  if (j.status === "closed" || j.status === "superseded" || r.status !== 0) break;
  if (j.schema !== "onionskin.batch/1") continue;
  if (mode === "crash") process.exit(1);
  if (mode === "limit") {
    // the plan's limit is reached while it holds the batch: Claude Code prints this event and stops without a reply
    emit({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: Math.floor(Date.now() / 1000) + 3600, rateLimitType: "seven_day" }, session_id: sessionId });
    emit({ type: "result", subtype: "success", is_error: true, result: "Usage limit reached", permission_denials: [], session_id: sessionId });
    process.exit(1);
  }
  const ticket = j.next_step.match(/--lease (b_[0-9a-f]{12}:[0-9a-f]{16})/)?.[1];
  if (mode === "hold") {
    // holds the batch, not blocked in a child (a signal handler runs only from the event loop), until Onionskin stops it
    let ending = false;
    const late = (sig) => {
      fs.appendFileSync(path.join(here, "signals"), `${sig}\n`);
      if (ending) return; // a second signal is only recorded
      ending = true;
      const rf = path.join(workDir, `reply-${j.batch_id}.json`);
      fs.writeFileSync(rf, JSON.stringify({ summary: "Late.", replies: [], ops: [{ op: "replace_all_text", id: "overall", find: "Paragraph 003:", replace: "Paragraph LATE:", expect: { count: 1 } }] }));
      const r = run("reply", "--lease", ticket, "--file", rf);
      fs.writeFileSync(path.join(here, "late.json"), JSON.stringify({ status: r.status, stdout: r.stdout, stderr: r.stderr }));
      setTimeout(() => process.exit(143), 1000); // lingers, so a second signal from Onionskin would be recorded
    };
    for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => late(sig));
    fs.writeFileSync(path.join(here, "held"), j.batch_id);
    await new Promise(() => setInterval(() => {}, 1000));
  }
  // "outline": the first unit of the outline Onionskin adds for its own agent gets a fixed title, its target and expect copied as they are.
  // "outline-file": the unit holding a fixed sentence is looked up in the batch's outline file (read the way the agent's Read tool would)
  let unit = (j.untrusted_document_evidence?.outline || []).find((x) => x.target);
  const of = j.untrusted_document_evidence?.outline_file;
  if (mode === "outline-file" && of) {
    emit({ type: "assistant", message: { content: [{ type: "tool_use", id: "tur", name: "Read", input: { file_path: of } }] }, session_id: sessionId });
    unit = fs.readFileSync(of, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((x) => x.target && x.text.startsWith("The harbor office"));
  }
  const reply =
    mode === "outline-file"
      ? { summary: "Changed the month.", replies: [], ops: unit ? [{ op: "replace_text", id: "overall", target: unit.target, expect: unit.expect, find: "March", replace: "April" }] : [] }
      : mode === "outline"
      ? { summary: "Changed the title.", replies: [], ops: unit ? [{ op: "replace_text", id: "overall", target: unit.target, expect: unit.expect, text: "Quarterly review approved" }] : [] }
      : { summary: "Changed the paragraph number.", replies: [], ops: [{ op: "replace_all_text", id: "overall", find: "Paragraph 003:", replace: "Paragraph THREE:", expect: { count: 1 } }] };
  for (const c of j.instructions.comments || []) reply.replies.push({ comment: c.id, decline: true, note: "The fake agent only changes the paragraph number." });
  const rf = path.join(workDir, `reply-${j.batch_id}.json`);
  emit({ type: "assistant", message: { content: [{ type: "tool_use", id: "tuw", name: "Write", input: { file_path: rf, content: "(reply)" } }] }, session_id: sessionId });
  fs.writeFileSync(rf, JSON.stringify(reply));
  const rid = bash(`onionskin reply --lease ${ticket} --file ${rf}`);
  result(rid, run("reply", "--lease", ticket, "--file", rf).stdout);
}
emit({ type: "result", subtype: "success", is_error: false, permission_denials: [], session_id: sessionId });
