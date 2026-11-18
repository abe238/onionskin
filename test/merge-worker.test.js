// The merge of what the person typed while the agent worked runs in a worker thread with a time and memory limit (src/offload.js
// mergeOffThread, src/merge-worker.js): the server's thread stays answerable whatever the document, and a merge that runs out of time
// writes nothing, keeps a copy of the person's version and says so. Outside review, round 5: merges of 4 to 11 s of CPU held the thread
// (a queued setImmediate did not run). Temp dirs only.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { test, after } from "node:test";
import { docxBytes, tmpdir } from "./helpers/zipbuild.js";

const root = tmpdir("da-mergew-");
process.env.ONIONSKIN_STATE_DIR = path.join(root, "st");
const { Sessions } = await import("../src/session.js");
const { ensureStateDir } = await import("../src/paths.js");
const { sha256 } = await import("../src/fsutil.js");
const { readDocxParagraphs } = await import("../src/docx.js");
ensureStateDir();
after(() => fs.rmSync(root, { recursive: true, force: true }));

const pid = (i) => (0x10000000 + i).toString(16).toUpperCase();
/** a session on `base` whose file the agent then replaced with `theirs` (what a write through the server leaves) */
function session(name, base, theirs) {
  const dir = fs.mkdtempSync(path.join(root, "d-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, base);
  const S = new Sessions();
  const s = S.open(file);
  s.snapshots.add(base, "sent");
  fs.writeFileSync(file, theirs);
  s.baseSha = sha256(theirs);
  return { S, s, file, dir, baseSha: sha256(base) };
}
/** runs fn while the event loop's delay is measured: {result, maxMs} */
async function watched(fn) {
  const h = monitorEventLoopDelay({ resolution: 10 });
  h.enable();
  try {
    return { result: await fn(), maxMs: h.max / 1e6 };
  } finally {
    h.disable();
  }
}

test("the reviewer's Word merge (3,900 paragraphs of 2,000 characters, 4.2 s on the thread before) leaves the event loop free and is carried", async () => {
  const a = "a".repeat(2000);
  const doc = (f) => docxBytes(Array.from({ length: 3900 }, (_, i) => ({ text: f(i), paraId: pid(i) })));
  const { S, s, file, baseSha } = session("w.docx", doc(() => a), doc((i) => (i === 0 ? `c${a.slice(1)}` : a)));
  const mine = doc(() => `${a.slice(0, 1000)}b${a.slice(1001)}`);
  const { result: r, maxMs } = await watched(() => S.mergeUserEdits(s.key, { baseSha, bytes: mine }));
  assert.equal(r.merged, 3899);
  assert.ok(maxMs < 2000, `the event loop waited ${maxMs.toFixed(0)} ms`);
  const out = readDocxParagraphs(fs.readFileSync(file));
  assert.equal(out[0].text, `c${a.slice(1)}`);
  assert.equal(out.filter((p) => p.text === `${a.slice(0, 1000)}b${a.slice(1001)}`).length, 3899);
});

test("a merge past its time limit writes nothing, keeps a copy of the person's version, says so, and can be tried again", async () => {
  const P = Array.from({ length: 6 }, (_, i) => `Paragraph ${i + 1} of the plan, as it was sent to the agent.`);
  const theirs = docxBytes(P.map((t, i) => (i === 0 ? "The agent rewrote the first paragraph." : t)));
  const { S, s, file, dir, baseSha } = session("t.docx", docxBytes(P), theirs);
  const mine = docxBytes(P.map((t, i) => (i === 4 ? `${t} Edited by me.` : t)));
  process.env.ONIONSKIN_MERGE_TIMEOUT_MS = "300";
  process.env.ONIONSKIN_TEST_MERGE_DELAY_MS = "20000";
  try {
    const first = S.mergeUserEdits(s.key, { baseSha, bytes: mine });
    // one merge per session at a time
    await assert.rejects(S.mergeUserEdits(s.key, { baseSha, bytes: mine }), (e) => e.status === 423 && e.extra.code === "locked");
    const { result: err, maxMs } = await watched(() => first.then(() => null, (e) => e));
    assert.ok(err, "the merge was refused");
    assert.deepEqual([err.status, err.extra.code, typeof err.extra.copy_name], [503, "merge_failed", "string"]);
    assert.match(err.message, /^it took longer than 1 second; nothing was written, and a copy of your version was saved as .+\.docx next to the file$/);
    assert.ok(maxMs < 2000, `the event loop waited ${maxMs.toFixed(0)} ms`);
    assert.deepEqual(fs.readFileSync(file), theirs, "the file is the agent's, untouched");
    const copies = fs.readdirSync(dir).filter((n) => n !== "t.docx");
    assert.equal(copies.length, 1);
    assert.deepEqual(fs.readFileSync(path.join(dir, copies[0])), mine, "the copy is the person's version");
  } finally {
    delete process.env.ONIONSKIN_MERGE_TIMEOUT_MS;
    delete process.env.ONIONSKIN_TEST_MERGE_DELAY_MS;
  }
  const again = await S.mergeUserEdits(s.key, { baseSha, bytes: mine });
  assert.equal(again.merged, 1);
  assert.deepEqual(readDocxParagraphs(fs.readFileSync(file)).map((p) => p.text)[4], `${P[4]} Edited by me.`);
});

test("a merge whose result the proof cannot account for writes nothing, keeps a copy of the person's version and says why, without document text", async () => {
  const P = Array.from({ length: 4 }, (_, i) => `Paragraph ${i + 1} of the plan, as it was sent to the agent.`);
  const theirs = docxBytes(P.map((t, i) => (i === 1 ? "The agent rewrote the second paragraph." : t)));
  const { S, s, file, dir, baseSha } = session("p.docx", docxBytes(P), theirs);
  const mine = docxBytes(P.map((t, i) => (i === 1 ? `${t} Private words typed by me.` : t)));
  process.env.ONIONSKIN_TEST_MERGE_FORGET = "1"; // the merge's list of what it handed back is lost, as a planner bug would lose it
  try {
    const err = await S.mergeUserEdits(s.key, { baseSha, bytes: mine }).then(() => null, (e) => e);
    assert.ok(err, "the merge was refused");
    assert.deepEqual([err.status, err.extra.code, typeof err.extra.copy_name], [503, "merge_failed", "string"]);
    assert.match(err.message, /^the merged file could not be checked to hold every one of your edits \(text edits neither carried nor handed back: 1\); nothing was written, and a copy of your version was saved as .+\.docx next to the file$/);
    assert.ok(!/Private|Paragraph/.test(err.message), "no document text");
    assert.deepEqual(fs.readFileSync(file), theirs, "the file is the agent's, untouched");
    const copies = fs.readdirSync(dir).filter((n) => n !== "p.docx");
    assert.equal(copies.length, 1);
    assert.deepEqual(fs.readFileSync(path.join(dir, copies[0])), mine, "the copy is the person's version");
  } finally {
    delete process.env.ONIONSKIN_TEST_MERGE_FORGET;
  }
  const again = await S.mergeUserEdits(s.key, { baseSha, bytes: mine });
  assert.deepEqual([again.merged, again.unplaced.map((u) => u.text)], [0, [`${P[1]} Private words typed by me.`]]);
});
