import assert from "node:assert/strict";
import { test } from "node:test";
import { commandHops, formatHops, hopBreakdown, pageHops, summarizeHops } from "../scripts/real-run/bench-marks.mjs";

// The bench's per-hop arithmetic, with made-up numbers (the bench itself needs a real agent and is never run here).
const sent = 1_000_000;
const snap = {
  origin: sent - 5000, // the page started 5 s before Send
  measures: [
    { name: "os:reload-load", startTime: 5000 + 9000, duration: 140.4 }, // after Send
    { name: "os:file-fetch", startTime: 5000 + 9000, duration: 120.2 },
    { name: "os:file-render", startTime: 5000 + 9130, duration: 310.6 },
    { name: "os:reload-load", startTime: 100, duration: 999 }, // the page's own first load: not this round
  ],
  resources: [
    { name: "http://127.0.0.1:1/api/send", startTime: 5000, responseEnd: 5000 + 85.4 },
    { name: "http://127.0.0.1:1/api/draft", startTime: 5000, responseEnd: 5000 + 5 },
  ],
};
const trace = [
  { cmd: "poll", flags: [], start: sent - 20_000, end: sent + 600, code: 0 },
  { cmd: "apply", flags: ["--dry-run"], start: sent + 4000, end: sent + 4300, code: 0 },
  { cmd: "reply", flags: [], start: sent + 7000, end: sent + 7500, code: 0 },
  { cmd: "poll", flags: [], start: sent + 7500, end: sent + 99_000, code: 0 }, // the next wait: not a call of this round
];

test("page hops: upload from the send resource, this round's reload measures only", () => {
  assert.deepEqual(pageHops(snap, sent, sent + 10_000), { upload_ms: 85, reload_ms: 140, file_fetch_ms: 120, file_render_ms: 311 });
  assert.deepEqual(pageHops({}, sent), { upload_ms: null, reload_ms: null, file_fetch_ms: null, file_render_ms: null }, "a page that made no marks");
});

test("command hops: delivery, each call with the wait before it, write time; the next poll is not a call", () => {
  const h = commandHops(trace, sent, sent + 9000);
  assert.equal(h.deliver_ms, 600);
  assert.deepEqual(h.calls, [
    { cmd: "apply", ms: 300, gap_ms: 3400, code: 0 },
    { cmd: "reply", ms: 500, gap_ms: 2700, code: 0 },
  ]);
  assert.equal(h.write_ms, 800);
  assert.deepEqual(commandHops([], sent, sent + 1), { deliver_ms: null, calls: [], write_ms: 0 });
});

test("breakdown, its printed lines and the median over rounds", () => {
  const h = hopBreakdown({ snap, trace, sent, resultAt: sent + 8200 });
  assert.equal(h.after_last_call_ms, 700);
  const out = formatHops(h);
  assert.match(out, /upload 85 ms, delivery 600 ms, write 800 ms, result card 700 ms after the last command/);
  assert.match(out, /apply 300 \(after 3400\), reply 500 \(after 2700\)/);
  assert.match(out, /reload 140 ms \(file fetch 120 ms, viewer opens it 311 ms\)/);
  const s = summarizeHops([h, { ...h, upload_ms: 200 }, { ...h, upload_ms: null }]);
  assert.equal(s.rounds, 3);
  assert.equal(s.upload_ms, 200, "a missing hop is left out, not counted as zero");
  assert.equal(s.calls, 2);
});
