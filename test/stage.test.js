import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, after } from "node:test";
import { tmpdir, docxBytes } from "./helpers/zipbuild.js";

// session.stage: where the delivered batch is (delivered, writing, checking), null when no batch is delivered. Toy DOCX files in a temp dir only.
const root = tmpdir();
process.env.ONIONSKIN_STATE_DIR = path.join(root, "st");
process.env.ONIONSKIN_LEASE_MS = "60000";
delete process.env.ONIONSKIN_PYTHON;
process.env.ONIONSKIN_NO_SOFFICE = "1";
const { Sessions } = await import("../src/session.js");
const { sha256 } = await import("../src/fsutil.js");
const { ensureStateDir } = await import("../src/paths.js");
ensureStateDir();
after(() => fs.rmSync(root, { recursive: true, force: true }));

const paras = Array.from({ length: 6 }, (_, i) => `Paragraph ${i + 1}: some real sentence number ${i * 5 + 3} for the stage tests.`);
const write = (name) => {
  const f = path.join(root, name);
  fs.writeFileSync(f, docxBytes(paras));
  return fs.realpathSync(f);
};
const comment = (id, i) => ({ id, kind: "element", text: "fix", anchor: { location: { blockPath: [i] }, paraText: paras[i] } });

test("stage follows the delivery: null, delivered, writing (apply notice and write), checking (done), null; every move is broadcast", async () => {
  const S = new Sessions();
  const seen = [];
  S.on("change", (s) => seen.push(S.view(s).stage));
  const f = write("stage.docx");
  const s = S.open(f);
  assert.equal(S.view(s).stage, null, "no batch yet");
  const poll = S.poll(s.key, { holder: "A" });
  assert.equal(S.view(s).stage, null, "a poller alone is not a delivery");
  S.send(s.key, { baseSha: s.baseSha, comments: [comment("c1", 1)], note: "" });
  const batch = await poll.promise;
  assert.equal(S.view(s).stage, "delivered");
  const claim = { holder: "A", token: batch.lease.token, batchId: batch.batch_id };

  S.noteApply(s.key, { ...claim, run: "r1", problems: [], applied: [] });
  assert.equal(S.view(s).stage, "writing", "an apply that reached the server moves the stage");
  assert.equal(seen.at(-1), "writing", "and the page is told");

  const bytes = docxBytes(["The agent's text."]);
  S.agentWrite(s.key, { baseSha: sha256(fs.readFileSync(f)), bytes, ...claim });
  assert.equal(S.view(s).stage, "writing", "the landed write keeps it");

  const inputs = S.analysisInputs(s.key, claim);
  assert.ok(inputs);
  assert.equal(S.view(s).stage, "checking");
  assert.equal(seen.at(-1), "checking");

  S.done(s.key, { summary: "ok", results: [{ comment_id: "c1", status: "done" }] }, claim);
  assert.equal(S.view(s).stage, null, "cleared when the batch ends");
  assert.equal(seen.at(-1), null);
});

test("stage is a commit arrival too, and take back clears it", async () => {
  const S = new Sessions();
  const f = write("stage2.docx");
  const s = S.open(f);
  const poll = S.poll(s.key, { holder: "A" });
  S.send(s.key, { baseSha: s.baseSha, comments: [comment("c1", 1)], note: "" });
  const batch = await poll.promise;
  const claim = { holder: "A", token: batch.lease.token, batchId: batch.batch_id };
  S.agentWrite(s.key, { baseSha: null, bytes: docxBytes(["Committed candidate."]), label: "before agent commit", ...claim });
  assert.equal(S.view(s).stage, "writing");
  S.takeBack(s.key);
  assert.equal(S.view(s).stage, null);
});

test("a queued comment keeps the stage of the running batch; the next delivery starts at delivered", async () => {
  const S = new Sessions();
  const f = write("stage3.docx");
  const s = S.open(f);
  const poll = S.poll(s.key, { holder: "A" });
  S.send(s.key, { baseSha: s.baseSha, comments: [comment("c1", 1)], note: "" });
  const batch = await poll.promise;
  const claim = { holder: "A", token: batch.lease.token, batchId: batch.batch_id };
  S.noteApply(s.key, { ...claim, run: "r1" });
  S.send(s.key, { baseSha: s.baseSha, comments: [comment("c1", 1), comment("c2", 2)], note: "" });
  assert.equal(S.state(s), "queued");
  assert.equal(S.view(s).stage, "writing");
  const next = S.poll(s.key, { holder: "A", ack: true });
  S.done(s.key, { summary: "ok", results: [{ comment_id: "c1", status: "done" }] }, claim);
  const b2 = await next.promise;
  assert.equal(b2.instructions.comments[0].id, "c2");
  assert.equal(S.view(s).stage, "delivered");
});

test("the page's words for a stage: a run on this Mac reads 'Doing this on your Mac' with no progress line", async () => {
  const { stageOf } = await import("../web/src/stage.js");
  assert.deepEqual(stageOf({ state: "working", stage: "local" }), { text: "Doing this on your Mac", step: 0, of: 3, key: "local" });
  assert.deepEqual(stageOf({ state: "working", stage: "writing", local: true }), { text: "Doing this on your Mac", step: 0, of: 3, key: "local" }, "a run on this Mac stays itself while it writes and checks: no agent progress line");
  assert.equal(stageOf({ state: "working", stage: "writing" }).text, "Writing your changes");
  assert.equal(stageOf({ state: "idle", stage: null }).text, "");
});

test("the top bar's line during a run: a Word file says to keep editing; an HTML file is read-only then, so it says to comment now", async () => {
  const { lockedSyncText } = await import("../web/src/stage.js");
  assert.equal(lockedSyncText({ state: "working", stage: "delivered", format: "docx", locked: true }), "The agent has your batch: keep editing");
  assert.equal(lockedSyncText({ state: "working", stage: "writing", format: "docx", locked: true }), "Writing your changes: keep editing");
  assert.equal(lockedSyncText({ state: "working", stage: "local", local: true, format: "xlsx", locked: true }), "Working on this Mac: keep editing");
  for (const stage of ["delivered", "writing", "checking", "local", undefined]) {
    const t = lockedSyncText({ state: "working", stage, local: stage === "local", format: "html", locked: true });
    assert.equal(t, "Agent working: comment now, fix text after", String(stage));
    assert.ok(!/keep editing/i.test(t));
  }
});

test("the words for the wait: pending window, progress line of this batch only, counter, and when Stop shows", async () => {
  const { pendingWords, progressOf, elapsedText, stopKind } = await import("../web/src/stage.js");
  // the window after Send before an agent has the batch
  assert.equal(pendingWords({ state: "working", agent: { state: "starting" } }), "");
  assert.equal(pendingWords({ state: "stranded", agent: { state: "starting" } }), "Starting the agent for your batch");
  assert.equal(pendingWords({ state: "stranded", agent: { state: "starting", busy: true } }), "Waiting for a free agent. Another document's agent is busy");
  assert.equal(pendingWords({ state: "stranded", agent: { state: "none" } }), "Your batch is saved. Waiting for an agent");
  assert.equal(pendingWords({ state: "stranded" }), "Your batch is saved. Waiting for an agent", "an older server sends no agent field");
  assert.equal(pendingWords({ state: "stranded", agent: { state: "external" } }), "", "the person's own agent: not this page's words");
  // the progress line: nothing from an earlier batch
  const at = 1;
  const a = (state, ...texts) => ({ state, activity: texts.map((text) => ({ at, text })) });
  assert.equal(progressOf(a("working", "Got your batch: 2 comments", "Reading the instructions", "Writing the changes")), "Writing the changes");
  assert.equal(progressOf(a("working", "Got your batch", "Making the changes", "Waiting for you to press Send")), "", "back to waiting: no line for a batch that is over");
  assert.equal(progressOf(a("working", "Got your batch: 1 comment", "Done. The page shows what changed", "Waiting for you to press Send")), "");
  assert.equal(progressOf(a("working", "Got your batch: 1 comment", "Done. The page shows what changed", "Waiting for you to press Send", "Got your batch: 2 comments")), "Got your batch: 2 comments", "the next batch starts over");
  assert.equal(progressOf(a("working", "Got your batch", "Done. The page shows what changed", "Waiting for you to press Send", "Thinking")), "", "a line before the batch that is out is the last batch's");
  assert.equal(progressOf(a("working", "Waiting for you to press Send")), "");
  assert.equal(progressOf(a("external", "Got your batch", "Writing the changes")), "", "no agent of ours: no line");
  assert.equal(progressOf(undefined), "");
  assert.deepEqual([0, 999, 12_400, 60_000, 65_000, 3_725_000, -5, NaN].map(elapsedText), ["0 s", "0 s", "12 s", "1 min 00 s", "1 min 05 s", "62 min 05 s", "0 s", "0 s"]);
  // Stop: the background agent only; the person's own agent gets take back alone; none on this Mac's own runs or in a read-only tab
  const w = (agent, extra = {}) => ({ state: "working", agent: { state: agent }, ...extra });
  assert.deepEqual(["working", "ready", "starting"].map((s) => stopKind(w(s), false)), ["stop", "stop", "stop"]);
  assert.deepEqual(["external", "handover"].map((s) => stopKind(w(s), false)), ["takeback", "takeback"]);
  assert.equal(stopKind(w("none"), false), null);
  assert.equal(stopKind({ state: "working" }, false), null, "no agent field");
  assert.equal(stopKind(w("working"), true), null, "read-only tab");
  assert.equal(stopKind(w("working", { local: true }), false), null, "a run on this Mac has no agent to stop");
  assert.equal(stopKind({ state: "listening", agent: { state: "ready" } }, false), null);
});

test("timing marks: off by default, on when the page asks, never throw", async () => {
  const { mark, measure } = await import("../web/src/marks.js");
  const names = () => performance.getEntries().map((e) => e.name);
  mark("os:test-off");
  assert.ok(!names().includes("os:test-off"), "a normal page makes no marks");
  globalThis.__onionskinMarks = true;
  try {
    mark("os:test-a");
    mark("os:test-b");
    measure("os:test-ab", "os:test-a", "os:test-b");
    assert.ok(names().includes("os:test-a") && names().includes("os:test-ab"));
    assert.doesNotThrow(() => measure("os:test-bad", "os:never-made"), "a missing mark is not an error");
  } finally {
    delete globalThis.__onionskinMarks;
    performance.clearMarks();
    performance.clearMeasures();
  }
});

test("the note after Stop: the withdrawn note, then what was typed and not saved; whole paragraphs compared, never parts of one", async () => {
  const { noteAfterStop } = await import("../web/src/stage.js");
  assert.equal(noteAfterStop("Keep it short.", ""), "Keep it short.");
  assert.equal(noteAfterStop("Keep it short.", "  "), "Keep it short.");
  assert.equal(noteAfterStop("", "Use US spelling."), "Use US spelling.");
  assert.equal(noteAfterStop("Keep it short.", "Keep it short."), "Keep it short.", "the saved note came back: not twice");
  assert.equal(noteAfterStop("Keep it short.\n\nUse US spelling.", "Use US spelling."), "Keep it short.\n\nUse US spelling.", "a paragraph the server joined back");
  assert.equal(noteAfterStop("Keep it short and formal.", "short"), "Keep it short and formal.\n\nshort", "a short typed note that is part of one paragraph is kept");
  assert.equal(noteAfterStop("A.\n\nB.\n\nC.", "B.\n\nC."), "A.\n\nB.\n\nC.", "several whole paragraphs");
  assert.equal(noteAfterStop("A.\n\nB.", "Typed during the run."), "A.\n\nB.\n\nTyped during the run.");
});
