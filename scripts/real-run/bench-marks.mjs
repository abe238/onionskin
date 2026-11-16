// Pure helpers for bench-real.mjs: turn the page's timing marks (web/src/marks.js), the browser's resource timing and the CLI trace into one per-hop
// breakdown of a round. No browser, no file, no clock in here, so test/bench-marks.test.js can check them with made-up numbers.
//   upload    Send pressed -> the server's answer to POST /api/send arrived at the page
//   deliver   Send pressed -> the agent's poll returned the batch
//   calls     each onionskin command the agent ran: how long it took, and the gap before it (the model's thinking and tool round trip)
//   write     the commands that write (apply, commit, reply, done), summed
//   reload    event -> the new file handed to the viewer (os:reload-load), the file fetch (os:file-fetch) and the viewer opening it (os:file-render)

const WRITES = new Set(["apply", "commit", "reply", "done"]);
const median = (xs) => (xs.length ? xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);
const round = (n) => (Number.isFinite(n) ? Math.round(n) : null);

/** `snap` is what the page returns: {origin, measures: [{name, startTime, duration}], resources: [{name, startTime, responseEnd}]}. Times are epoch ms after this. */
export function pageHops(snap, sent, end = Infinity) {
  const origin = Number(snap?.origin) || 0;
  const abs = (t) => origin + t;
  const inRound = (t) => abs(t) >= sent - 50 && abs(t) <= end + 2000;
  const last = (name) => (snap?.measures || []).filter((m) => m.name === name && inRound(m.startTime)).sort((a, b) => b.startTime - a.startTime)[0];
  const send = (snap?.resources || []).filter((r) => /\/api\/send$/.test(String(r.name)) && abs(r.startTime) >= sent - 50).sort((a, b) => a.startTime - b.startTime)[0];
  return {
    upload_ms: send ? round(abs(send.responseEnd) - sent) : null,
    reload_ms: round(last("os:reload-load")?.duration),
    file_fetch_ms: round(last("os:file-fetch")?.duration),
    file_render_ms: round(last("os:file-render")?.duration),
  };
}

/** `trace`: the CLI's own trace lines [{cmd, flags, start, end, code}]. Commands of this round only; `poll` is the delivery, never a call. */
export function commandHops(trace, sent, end) {
  const mine = (trace || []).filter((c) => c.end > sent && c.start < end + 500);
  const poll = mine.find((c) => c.cmd === "poll" && c.start <= sent + 1000) || mine.find((c) => c.cmd === "poll");
  const calls = [];
  let prev = poll ? poll.end : sent;
  for (const c of mine.filter((x) => x.cmd !== "poll").sort((a, b) => a.start - b.start)) {
    calls.push({ cmd: c.cmd, ms: round(c.end - c.start), gap_ms: round(Math.max(0, c.start - prev)), code: c.code || 0 });
    prev = c.end;
  }
  return {
    deliver_ms: poll ? round(poll.end - sent) : null,
    calls,
    write_ms: calls.filter((c) => WRITES.has(c.cmd)).reduce((n, c) => n + c.ms, 0),
  };
}

/** One round's breakdown. `resultAt` is when the result card showed (epoch ms), or null. */
export function hopBreakdown({ snap, trace, sent, resultAt }) {
  const end = resultAt ?? Date.now();
  const lastEnd = (trace || []).filter((c) => c.cmd !== "poll" && c.end > sent && c.start < end + 500).reduce((m, c) => Math.max(m, c.end), 0);
  return { ...pageHops(snap, sent, end), ...commandHops(trace, sent, end), after_last_call_ms: resultAt && lastEnd ? round(resultAt - lastEnd) : null };
}

const fmt = (n) => (n == null ? "-" : `${n} ms`);

/** The lines printed under a round. */
export function formatHops(h) {
  const calls = h.calls.length ? h.calls.map((c) => `${c.cmd} ${c.ms} (after ${c.gap_ms})`).join(", ") : "none";
  return [`    upload ${fmt(h.upload_ms)}, delivery ${fmt(h.deliver_ms)}, write ${fmt(h.write_ms)}, result card ${fmt(h.after_last_call_ms)} after the last command`, `    calls (ms, with the wait before each): ${calls}`, `    reload ${fmt(h.reload_ms)} (file fetch ${fmt(h.file_fetch_ms)}, viewer opens it ${fmt(h.file_render_ms)})`].join("\n");
}

/** Median of each hop over many rounds' breakdowns. */
export function summarizeHops(list) {
  const pick = (k) => median(list.map((h) => h[k]).filter((x) => x != null));
  return { rounds: list.length, upload_ms: pick("upload_ms"), deliver_ms: pick("deliver_ms"), write_ms: pick("write_ms"), reload_ms: pick("reload_ms"), file_fetch_ms: pick("file_fetch_ms"), file_render_ms: pick("file_render_ms"), calls: median(list.map((h) => h.calls.length)), call_gap_ms: median(list.flatMap((h) => h.calls.map((c) => c.gap_ms))) };
}
