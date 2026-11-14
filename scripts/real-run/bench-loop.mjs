#!/usr/bin/env node
// Times each stage of the Send -> agent -> refresh loop with the scripted agent (no model, no tokens), so the numbers are the product's
// own overhead: everything a real agent adds on top is its thinking time. Prints the median of N rounds per scenario.
//   node scripts/real-run/bench-loop.mjs [rounds=5] [scenario ...]        REALRUN_SOFFICE=1 includes the LibreOffice check; BENCH_REPLY=1 uses the one-call reply route
// Ceiling: the fixtures are small (6 to 37 KB); a large file will be slower in apply, the checks and the reload.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { here } from "./lib.mjs";

const rounds = Number(process.argv[2]) || 5;
const scenarios = process.argv.slice(3).length ? process.argv.slice(3) : ["docx-basic", "xlsx-basic", "pptx-basic"];
const base = fs.mkdtempSync("/tmp/rr/bench-"); // short path: the server's unix socket lives under it
const REPLY_STAGES = [
  ["Send click to agent has the batch", "send_clicked", "poll_returned"],
  ["Agent answers in one call (reply: write, finish, checks)", "poll_returned", "reply_done"],
  ["TOTAL: Send click to document reloaded and unlocked", "send_clicked", "unlocked"],
];
const APPLY_STAGES = [
  ["Send click to agent has the batch", "send_clicked", "poll_returned"],
  ["Agent dry run (apply --dry-run)", "poll_returned", "dry_run_done"],
  ["Agent write (apply)", "dry_run_done", "apply_done"],
  ["Agent finish and file checks (done)", "apply_done", "done_returned"],
  ["done to result on the page", "done_returned", "result_shown"],
  ["done to document reloaded and unlocked", "done_returned", "unlocked"],
  ["TOTAL: Send click to document reloaded and unlocked", "send_clicked", "unlocked"],
];
const STAGES = process.env.BENCH_REPLY ? REPLY_STAGES : APPLY_STAGES;
const median = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
console.log(`load average: ${execFileSync("uptime").toString().trim().split("load averages: ")[1]}; rounds: ${rounds}; LibreOffice check: ${process.env.REALRUN_SOFFICE ? "on" : "off"}; agent route: ${process.env.BENCH_REPLY ? "reply (one call)" : "apply + done"}`);
for (const sc of scenarios) {
  const rows = STAGES.map(() => []);
  let failed = 0;
  for (let i = 0; i < rounds; i++) {
    const wd = path.join(base, `${sc.split("-")[0]}${i}`);
    const r = spawnSync(process.execPath, [path.join(here, "run-fake.mjs"), sc, wd], { encoding: "utf8" });
    const f = path.join(wd, "timings.jsonl");
    const t = Object.fromEntries(fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l)).map((m) => [m.name, m.t]) : []);
    if (r.status !== 0 || !t.unlocked) {
      failed++;
      continue;
    }
    STAGES.forEach(([, a, b], k) => rows[k].push(t[b] - t[a]));
  }
  console.log(`\n${sc} (${rounds - failed} of ${rounds} rounds timed)`);
  if (rows[0].length) STAGES.forEach(([name], k) => console.log(`  ${String(median(rows[k])).padStart(6)} ms  (min ${Math.min(...rows[k])}, max ${Math.max(...rows[k])})  ${name}`));
}
fs.rmSync(base, { recursive: true, force: true });
