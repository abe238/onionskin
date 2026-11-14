import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyExit, parseLine, replyFailureWords } from "../src/agent-events.js";

// Lines shaped like the real Claude Code streams (spike 2026-11-13), with the document text removed.
const L = (o) => JSON.stringify(o);
const use = (name, input) => L({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name, input }] }, session_id: "s-1" });
const res = (content, is_error = false) => L({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content, is_error }] } });
const p = (line) => parseLine("claude", line);

test("init gives the session id", () => {
  assert.deepEqual(p(L({ type: "system", subtype: "init", session_id: "abc-123", tools: ["Bash", "Read", "Write"] })), { sessionId: "abc-123" });
});

test("tool starts map to the plain lines", () => {
  assert.equal(p(use("Read", { file_path: "/x/skills/onionskin/reference/ops.md" })).activity, "Reading the instructions");
  assert.equal(p(use("Read", { file_path: "/Users/patq/Doc.docx" })).activity, undefined, "reading anything else is not announced");
  assert.equal(p(use("Bash", { command: "onionskin poll '/d/a.docx' --timeout 590" })).activity, "Waiting for you to press Send");
  assert.equal(p(use("Write", { file_path: "/st/agents/k/reply-b_1.json", content: "{}" })).activity, "Writing the changes");
  assert.equal(p(use("Bash", { command: "onionskin reply --lease b_1:ff --then-poll --file /st/agents/k/reply-b_1.json" })).activity, "Making the changes");
  assert.equal(p(use("Bash", { command: "onionskin status /d/a.docx" })).activity, undefined);
});

test("a batch result counts the comments; the document text in it is never shown", () => {
  const batch = { schema: "onionskin.batch/1", instructions: { comments: [{ id: "c1", text: "SECRET-DOC-TEXT" }, { id: "c2", text: "x" }] }, untrusted_document_evidence: { anchors: [] } };
  const r = p(res(JSON.stringify(batch)));
  assert.equal(r.activity, "Got your batch: 2 comments");
  assert.ok(!JSON.stringify(r).includes("SECRET"));
  assert.equal(p(res(JSON.stringify({ ...batch, instructions: { comments: [{ id: "c1" }] } }))).activity, "Got your batch: 1 comment");
  assert.equal(p(res(JSON.stringify({ ...batch, instructions: { comments: [], overall_note: "x" } }))).activity, "Got your batch", "a note alone has no comment count");
  assert.equal(p(res([{ type: "text", text: JSON.stringify(batch) }])).activity, "Got your batch: 2 comments", "a list of text blocks reads the same");
  assert.equal(p(res('{"schema":"onionskin.batch/1","instructions":{"comments":[{"id":"c1","text":"cut off')).activity, "Got your batch" , "a shortened batch still says so");
});

test("a poll that timed out says nothing", () => {
  assert.deepEqual(p(res(JSON.stringify({ status: "timeout" }))), {});
});

test("reply results: done, and a failure in words (the reason text is never copied)", () => {
  assert.equal(p(res(JSON.stringify({ ok: true, applied: 1, declined: 0, asked: 0, flags: [] }))).activity, "Done. The page shows what changed");
  const two = JSON.stringify({ ok: true, applied: 1, declined: 0, asked: 0, flags: [] }) + "\n" + JSON.stringify({ schema: "onionskin.batch/1", instructions: { comments: [{}] } });
  assert.equal(p(res(two)).activity, "Got your batch: 1 comment", "reply --then-poll: the newest thing in the output wins");
  const bad = p(res(JSON.stringify({ ok: false, finished: false, error: "the text said SECRET", code: "not_applied" })));
  assert.equal(bad.activity, "The change did not go through: the text no longer matched the document");
  assert.equal(replyFailureWords("nope"), "it was not accepted");
  assert.equal(p(res(JSON.stringify({ ok: false, error: "x", code: "stale_batch" }))).activity, "The change did not go through: the batch was no longer current");
});

test("a refused command shows a line and counts as a denial", () => {
  const r = p(res("Permission to use Bash has been denied because Claude Code is running in don't ask mode", true));
  assert.deepEqual(r, { activity: "Blocked a command it is not allowed to run", denial: true });
  assert.deepEqual(p(res("some other tool error", true)), {});
});

test("assistant text is only ever 'Thinking'", () => {
  const r = p(L({ type: "assistant", message: { content: [{ type: "text", text: "The document says SECRET" }] } }));
  assert.deepEqual(r, { activity: "Thinking" });
  const both = p(L({ type: "assistant", message: { content: [{ type: "text", text: "ok" }, { type: "tool_use", name: "Bash", input: { command: "onionskin poll f" } }] } }));
  assert.equal(both.activity, "Waiting for you to press Send", "a tool line beats Thinking");
});

test("rate limit: a warning is not a failure, a rejection is (with the reset time in milliseconds)", () => {
  assert.deepEqual(p(L({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.93 } })), {});
  assert.deepEqual(p(L({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1790000000 } })), { failure: "limit", resetsAt: 1790000000000 });
  assert.deepEqual(p(L({ type: "rate_limit_event", rate_limit_info: { status: "rejected" } })), { failure: "limit" });
  assert.equal(p(L({ type: "assistant", error: "rate_limit", message: { content: [] } })).failure, "limit");
  assert.equal(p(L({ type: "assistant", error: "billing_error", message: { content: [] } })).failure, "limit");
});

test("signed out", () => {
  assert.equal(p(L({ type: "assistant", error: "authentication_failed", message: { content: [{ type: "text", text: "Not logged in" }] } })).failure, "signed_out");
  const r = p(L({ type: "result", subtype: "success", is_error: true, terminal_reason: "api_error", result: "Invalid authentication credentials", permission_denials: [] }));
  assert.equal(r.failure, "signed_out");
  assert.deepEqual(r.result, { ok: false, turnsExhausted: false, denials: 0 });
});

test("the final result carries denials and the turn limit", () => {
  const r = p(L({ type: "result", subtype: "success", is_error: false, permission_denials: [{ tool_name: "Bash" }, { tool_name: "Bash" }], session_id: "s-9" }));
  assert.deepEqual(r, { sessionId: "s-9", denial: true, result: { ok: true, turnsExhausted: false, denials: 2 } });
  assert.equal(p(L({ type: "result", subtype: "error_max_turns", is_error: true, permission_denials: [] })).result.turnsExhausted, true);
});

test("junk, unknown events and other CLIs give nothing", () => {
  for (const line of ["", "not json", "null", "[]", "42", L({ type: "stream_event" })]) assert.deepEqual(p(line), {});
  assert.deepEqual(parseLine("codex", L({ type: "thread.started", thread_id: "t" })), {}, "Claude Code is the only background agent in this build");
});

test("classifyExit", () => {
  assert.equal(classifyExit({ code: 0, sawResult: true }), null, "a normal end");
  assert.equal(classifyExit({ code: 1, sawResult: true, failure: "signed_out" }), "signed_out");
  assert.equal(classifyExit({ code: 1, failure: "limit" }), "limit");
  assert.equal(classifyExit({ code: 0, sawResult: true, denials: 2, heldBatch: true }), "refused");
  assert.equal(classifyExit({ code: 0, sawResult: true, denials: 2, heldBatch: false }), null, "a refusal that did not strand a batch is not a failure");
  assert.equal(classifyExit({ code: 0, sawResult: true, heldBatch: true }), "crashed", "it quit while holding a batch");
  assert.equal(classifyExit({ code: null, signal: "SIGKILL" }), "crashed");
  assert.equal(classifyExit({ code: 1, sawResult: false }), "crashed");
  assert.equal(classifyExit({ code: 0, sawResult: false }), "crashed", "no final result is not a clean end");
});
