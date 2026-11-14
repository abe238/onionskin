#!/usr/bin/env node
// Makes a TEST recording of the demo-docx scenario for building and testing the Try-it page: never one to show anyone.
//   node scripts/demo/test-recording.mjs <out folder>
// The run is made in-process with the real Sessions code and the edits fake-agent.mjs makes, in a temp folder (its own state dir:
// ~/.onionskin is never opened), then handed to record.mjs with --test, so the recording is stamped `real: false` and passes the scan
// only with --test. build.mjs refuses it unless --test, and never builds it into the default folder. The temp folder is removed after.
// Needs the repo virtualenv (python-docx) for the letter.
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");

const out = process.argv[2] && path.resolve(process.argv[2]);
if (!out) (console.error("usage: test-recording.mjs <out folder>"), process.exit(2));

const work = fs.mkdtempSync(path.join(os.tmpdir(), "os-demo-rec-"));
try {
  process.env.ONIONSKIN_STATE_DIR = path.join(work, "state");
  process.env.ONIONSKIN_LEASE_MS = "60000";
  process.env.ONIONSKIN_NO_SOFFICE = "1";
  const { python, havePython, VENV_HINT } = await import("../fixtures.mjs");
  if (!havePython()) throw new Error(`the demo letter needs the repo virtualenv. Create it: ${VENV_HINT}`);
  const { Sessions } = await import("../../src/session.js");
  const { ensureStateDir } = await import("../../src/paths.js");
  const { runOps } = await import("../../src/ops/run.js");
  const { DEMO } = await import("./demo-scenario.mjs");
  ensureStateDir();

  const fx = path.join(work, "fx");
  execFileSync(python, [path.join(repo, "scripts", "real-run", "make-fixtures.py"), fx], { stdio: "ignore" });
  const file = path.join(work, "welcome.docx");
  fs.copyFileSync(path.join(fx, "welcome.docx"), file);
  fs.copyFileSync(path.join(fx, "welcome.docx"), path.join(work, "original.docx"));
  const real = fs.realpathSync(file);
  const S = new Sessions();
  const s = S.open(real);
  // the comments as the page makes them: each on one whole sentence of the letter (paragraphs 2 to 4)
  const comments = DEMO.comments.map((c, i) => {
    const quote = DEMO.letter[i + 1];
    return { id: `c${"abc"[i]}`, kind: "text", text: c.text, anchor: { location: { blockPath: [i + 1], start: 0, end: quote.length }, quote, prefix: "", suffix: "", format: "docx" } };
  });
  const poll = S.poll(s.key, { holder: "agent" });
  S.send(s.key, { baseSha: s.baseSha, comments, note: DEMO.overall, edits: [] });
  const batch = await poll.promise;
  const anchors = new Map(batch.untrusted_document_evidence.anchors.map((a) => [a.id, a]));
  const cs = batch.instructions.comments;
  const hash = (c) => anchors.get(c.anchor_id).locator.text_hash;
  const op = (c, find, replace) => ({ op: "replace_text", id: c.id, target: { anchor_id: c.anchor_id }, expect: { text_hash: hash(c) }, find, replace });
  // the same edits fake-agent.mjs makes for demo-docx
  const ops = [
    op(cs[0], ", and we hope that you will feel at home here very quickly", ""),
    op(cs[1], ", so that the crew can reach them", ""),
    op(cs[2], "you should contact", "please ask at"),
    { op: "replace_all_text", id: "overall", find: "front office", replace: "Welcome Desk", expect: { count: 2 } },
  ];
  const before = fs.readFileSync(real);
  const r = await runOps({ bytes: before, format: "docx", name: "welcome.docx", ops, anchors });
  if (!r.bytes) throw new Error(`the test edits did not apply: ${JSON.stringify(r.results).slice(0, 400)}`);
  const claim = { holder: "agent", token: batch.lease.token, batchId: batch.batch_id };
  S.agentWrite(s.key, { baseSha: sha256(before), bytes: r.bytes, ...claim });
  const notes = ["Cut the ending and kept the welcome.", "Dropped the last clause; the Tuesday pickup stays.", "Changed the wording to a friendlier ask."];
  S.done(s.key, { summary: "Shortened two sentences, made the question line friendlier, and renamed the front office to the Welcome Desk.", results: cs.map((c, i) => ({ comment_id: c.id, status: "done", note: notes[i] })) }, claim);
  S.revert(s.key, S.get(s.key).activity.find((a) => a.kind === "agent").id);
  const ev = { scenario: DEMO.scenario, file: real, overall_note: DEMO.overall, batch, timing: { working_ms: 3000, result_ms: 8000, reverted_ms: 11000 }, fake: true };
  fs.writeFileSync(path.join(work, "evidence.json"), JSON.stringify(ev, null, 2));
  fs.writeFileSync(path.join(work, "scenario.json"), JSON.stringify({ scenario: DEMO.scenario, workdir: work, file, original: path.join(work, "original.docx"), state_dir: path.join(work, "state") }));
  fs.writeFileSync(path.join(work, "fake-agent.marker"), "this workdir was answered by a stand-in, not a real agent\n");

  const rec = spawnSync(process.execPath, [path.join(here, "record.mjs"), work, "--agent", "Test agent", "--test", "--out", out], { encoding: "utf8" });
  process.stdout.write(rec.stdout);
  process.stderr.write(rec.stderr);
  process.exitCode = rec.status ?? 1;
} catch (err) {
  console.error(`No test recording was made: ${err.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
