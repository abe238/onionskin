// Run as its own process by test/worker-terminate.test.js: starts each worker the server starts, the way the server starts it, and
// terminates it after 0, 1, 2, ... ms, through its start, its imports and its work. Prints "survived <n>" and exits 0 when this process
// lives through all of it; a V8 abort would end it with exit 133 instead. argv: <scratch dir> <max delay ms> <step ms> <dense stops>.
// The dense part stops the open worker <dense stops> times while it reads a workbook of 1,000 one-cell sheets (a zlib call every few
// hundred microseconds): stopping a worker inside zlib aborted the process with SIGABRT ("close before init"), 3 runs in 5 here before
// src/stop-gate.js.
import fs from "node:fs";
import path from "node:path";
import { docxBytes } from "./zipbuild.js";
import { xlsxGrid } from "./hostile.js";

const [dir, maxMs, step, dense] = [process.argv[2], Number(process.argv[3]), Number(process.argv[4]), Number(process.argv[5] || 0)];
const { startWorker } = await import("../../src/offload.js");
const paras = Array.from({ length: 400 }, (_, i) => `Paragraph ${i} of a document that the workers read while they are stopped.`);
const a = docxBytes(paras);
const b = docxBytes(paras.map((p, i) => (i % 7 ? p : `${p} Changed.`)));
const fa = path.join(dir, "a.docx");
const fb = path.join(dir, "b.docx");
fs.writeFileSync(fa, a);
fs.writeFileSync(fb, b);
const jobs = {
  "check-worker.js": { pre: a, post: b, format: "docx", deferSoffice: true },
  "history-worker.js": { jobs: [{ format: "docx", before: fa, after: fb, places: true }] },
  "redline-worker.js": { before: fa, after: fb, author: "Onionskin", date: "2026-11-16T00:00:00Z" },
  "voice-worker.js": { pre: fa, post: fb, mine: fa },
  "voice-sample-worker.js": { open: null, files: [{ format: "docx", bytes: a }], texts: [], shares: 5 },
};
jobs["open-worker.js"] = { bytes: a, format: "docx" };
jobs["merge-worker.js"] = { format: "docx", base: a, mine: b, theirs: docxBytes(paras.map((p, i) => (i === 3 ? `${p} Changed by the agent.` : p))), name: "t.docx", edits: [], agent: null };
jobs["ops-worker.js"] = { kind: "preview", bytes: a, format: "docx", op: { op: "replace_all_text", find: "Paragraph", replace: "Line", match_case: true }, name: "a.docx" };
jobs["html-render-worker.js"] = { bytes: Buffer.from(`<!doctype html><title>t</title>${paras.map((p) => `<p style="color:#333">${p} <img src="a.png"></p>`).join("")}`), fileDir: dir };
const start = Object.fromEntries(Object.entries(jobs).map(([name, workerData]) => [name, () => startWorker(name, { workerData })]));
// the anchor worker is kept warm: it is started with no job and answers the jobs it is sent (src/anchor-worker.js)
start["anchor-worker.js"] = () => {
  const w = startWorker("anchor-worker.js");
  w.unref(); // it never ends by itself; the server's pool unrefs it too
  w.postMessage({ id: 1, job: { format: "docx", source: { path: fa }, check: true, tasks: [{ op: "build", anchor: { location: { blockPath: [3] }, quote: "Paragraph 3" } }], outline: true } });
  return w;
};
let n = 0;
for (const [name, make] of Object.entries(start)) {
  let answered = 0;
  for (let d = 0; d <= maxMs; d += step) {
    const w = make();
    w.on("error", () => {});
    w.on("message", () => answered++);
    if (d) await new Promise((r) => setTimeout(r, d));
    await w.terminate();
    n++;
  }
  // and once to the end: the worker does answer when it is left alone
  const done = await new Promise((resolve) => {
    const w = make();
    w.once("message", () => resolve(true));
    w.once("error", (e) => resolve(`error: ${e.message}`));
    w.once("exit", () => resolve(false));
  });
  if (done !== true) throw new Error(`${name} did not answer when left alone: ${done}`);
  console.log(`${name}: ${answered} answered before they were stopped`);
}
const sheets = xlsxGrid(1, 0, { sheets: 1000 });
for (let i = 0; i < dense; i++) {
  const w = startWorker("open-worker.js", { workerData: { bytes: sheets, format: "xlsx" } });
  w.on("error", () => {});
  await new Promise((r) => setTimeout(r, 5 + ((i * 7) % 61)));
  await w.terminate();
  n++;
}
console.log(`survived ${n}`);
