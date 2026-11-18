// A batch of 50 HTML ops on a file at the limits (about 10 MB, about 200,000 elements) costs the calling thread under 1 s of CPU: the
// reading, the ops, the one proof and the write check run in the ops worker (src/ops/run.js -> src/offload.js runOpsOffThread), as for
// the server and the CLI. Judged by the main thread's CPU time (process.threadCpuUsage), not wall time: the machine may be busy. The
// worker's own time is printed, and must stay inside the ops worker's time limit.
import assert from "node:assert/strict";
import { test } from "node:test";
import { runOpsOffThread } from "../src/offload.js";
import { HTML_LIMITS } from "../src/html.js";

test("50 ops on a 10 MB page of about 200,000 elements: under 1 s of main-thread CPU, all applied, one write", async () => {
  const rows = [];
  let bytes = 200;
  for (let i = 0; bytes < HTML_LIMITS.bytes - 120_000 && rows.length < 66_000; i++) {
    const r = `<p id="p${i}" class="c${i % 7}">Paragraph ${i} has <b>bold ${i}</b> and <i>words</i> to fill the page with ordinary text, about one line of a report written for this test.</p>\n`;
    rows.push(r);
    bytes += r.length;
  }
  const src = Buffer.from(`<!doctype html><html><head><meta charset="utf-8"><title>Big</title></head><body>\n${rows.join("")}</body></html>\n`);
  assert.ok(src.length > 9.5 * 1024 * 1024 && src.length <= HTML_LIMITS.bytes, `${src.length} bytes`);
  const ops = [];
  for (let k = 0; k < 50; k++) {
    const i = 1000 + k * 1200;
    const t = { element_id: `p${i}` };
    const e = { quote: `Paragraph ${i} has bold ${i}` };
    if (k % 5 === 0) ops.push({ op: "replace_text", target: t, expect: e, find: `Paragraph ${i} has`, replace: `Paragraph ${i} now has` });
    else if (k % 5 === 1) ops.push({ op: "set_attribute", target: t, expect: e, name: "class", value: "changed" });
    else if (k % 5 === 2) ops.push({ op: "insert_html", target: t, expect: e, where: "after", html: `<p>Inserted after ${i}.</p>` });
    else if (k % 5 === 3) ops.push({ op: "delete_element", target: t, expect: e });
    else ops.push({ op: "replace_element", target: t, expect: e, html: `<p id="p${i}">Replaced ${i}.</p>` });
  }
  const t0 = process.threadCpuUsage();
  const w0 = performance.now();
  const r = await runOpsOffThread({ bytes: src, format: "html", name: "big.html", ops });
  const t = process.threadCpuUsage(t0);
  const cpu = (t.user + t.system) / 1e6;
  console.log(`50 ops on ${(src.length / 1048576).toFixed(1)} MB: main-thread CPU ${cpu.toFixed(3)} s, wall ${((performance.now() - w0) / 1000).toFixed(1)} s`);
  assert.deepEqual(r.results.map((x) => x.status), ops.map(() => "applied"), JSON.stringify(r.results.find((x) => x.status !== "applied")));
  assert.ok(r.bytes.includes("Paragraph 1000 now has") && r.bytes.includes('<p id="p2200" class="changed">'));
  assert.ok(cpu < 1, `main-thread CPU ${cpu} s`);
});
