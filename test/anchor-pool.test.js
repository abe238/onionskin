// The anchor worker pool (src/offload.js anchorsOffThread) as the server's routes use it, through Sessions' async methods: two files'
// requests run at the same time and the server's thread keeps answering while they work; a job past its time limit is answered as not
// finished, its comments go out weaker but every one of them goes out, and the next request gets a fresh worker. Each job is slowed by
// the test seam ONIONSKIN_TEST_ANCHOR_DELAY_MS. Temp dirs only.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, after } from "node:test";
import { docxBytes, tmpdir, xlsxBytes } from "./helpers/zipbuild.js";

const root = tmpdir();
process.env.ONIONSKIN_STATE_DIR = path.join(root, "st");
process.env.ONIONSKIN_NO_SOFFICE = "1";
process.env.ONIONSKIN_TEST_ANCHOR_DELAY_MS = "1500";
const { Sessions } = await import("../src/session.js");
const { ensureStateDir } = await import("../src/paths.js");
ensureStateDir();
after(() => fs.rmSync(root, { recursive: true, force: true }));

const S = new Sessions();
// opened as the server opens a file (read whole in the open worker), so a Send of the same bytes is known to be within the caps
const word = (name) => {
  const f = path.join(root, name);
  fs.writeFileSync(f, docxBytes(["The first paragraph.", "The second paragraph."]));
  return S.openAsync(f);
};
const comment = (i, location) => ({ id: `c${i}`, kind: "element", text: `comment ${i}`, anchor: { location, quote: "" } });

test("two files' Sends run at once, and the server's thread keeps answering while their anchors are worked out", { timeout: 120_000 }, async () => {
  const a = await word("a.docx");
  const b = await word("b.docx");
  let lag = 0;
  let last = performance.now();
  const tick = setInterval(() => {
    const now = performance.now();
    lag = Math.max(lag, now - last - 10);
    last = now;
  }, 10);
  const t = performance.now();
  try {
    await Promise.all([a, b].map((s) => S.sendAsync(s.key, { baseSha: s.baseSha, comments: [comment(0, { blockPath: [1] })], note: "" })));
  } finally {
    clearInterval(tick);
  }
  const ms = performance.now() - t;
  assert.ok(ms < 2900, `both took ${ms.toFixed(0)} ms: each waits 1.5 s in its worker, so they ran at the same time`);
  assert.ok(lag < 1000, `the server's thread was held ${lag.toFixed(0)} ms at most (each job waits 1.5 s in its worker)`);
  for (const s of [a, b]) assert.equal(s.comments[0].durable?.ordinal, 1, "the anchor was built from the file");
});

test("a job past its time limit: every comment still goes out, weaker; the next request gets a fresh worker", { timeout: 120_000 }, async () => {
  process.env.ONIONSKIN_ANCHOR_TIMEOUT_MS = "300";
  const f = path.join(root, "c.xlsx");
  fs.writeFileSync(f, xlsxBytes({ Sheet1: { A1: "a", B2: "b" } }));
  const s = await S.openAsync(f);
  try {
    await S.sendAsync(s.key, { baseSha: s.baseSha, comments: [comment(0, { sheetIndex: 0, sheetName: "Sheet1", range: "B2" })], note: "" });
  } finally {
    delete process.env.ONIONSKIN_ANCHOR_TIMEOUT_MS;
  }
  assert.equal(s.pending.instructions.comments.length, 1, "the comment is in the batch");
  assert.deepEqual([s.comments[0].durable.range, s.comments[0].durable.textHash, s.comments[0].durable.weak], ["B2", null, true], "its address, no hash");
  const ev = s.pending.untrusted_document_evidence.anchors[0];
  assert.deepEqual([ev.resolved, ev.unit, ev.label, s.pending.instructions.comments[0].reply_with], [true, "cell", "Sheet1!B2", "ops"], "the agent gets the cell and is offered full ops");
  const r = await S.resolveAllAsync(s.key);
  assert.deepEqual([r.anchors.c0.method, r.anchors.c0.range], ["position", "B2"], "the page finds it at its address");
  const w = await word("d.docx");
  await S.sendAsync(w.key, { baseSha: w.baseSha, comments: [comment(1, { blockPath: [0] })], note: "" });
  assert.equal(w.comments[0].durable?.ordinal, 0, "the next Send is anchored by a fresh worker");
});
