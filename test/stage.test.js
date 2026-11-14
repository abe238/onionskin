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
