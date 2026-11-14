#!/usr/bin/env node
// Times the Send -> agent -> refresh loop with a REAL agent (headless Claude Code), over several rounds in ONE session:
// round 1 is cold (the agent has just read the skill), later rounds are warm (the number a user feels on every Send after the first).
//   node scripts/real-run/bench-real.mjs --model sonnet [--runs 3] [--skill <dir with SKILL.md>] [--cli <path to src/cli.js>] [--label name] [--effort low]
// Each round has an exact expected result, so a wrong edit fails the round instead of counting as fast.
// Prints one JSON line per run to <out>/runs.jsonl (default /tmp/rr/bench-real) and a summary table. Uses the user's Claude allowance.
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { launch, waitDoc } from "../../e2e/helpers/harness.mjs";
import { prepare, realCheckerPython, repo, sleep } from "./lib.mjs";
import { commentOnParagraph } from "./scenarios.mjs";

const arg = (n, d) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1] : d);
const model = arg("model", "sonnet");
const runs = Number(arg("runs", 3));
const skillDir = path.resolve(arg("skill", path.join(repo, "skills", "onionskin")));
const cliJs = path.resolve(arg("cli", path.join(repo, "src", "cli.js")));
const label = arg("label", "baseline");
const effort = arg("effort", "");
const outDir = arg("out", "/tmp/rr/bench-real");
const extraPrompt = arg("prompt-extra", "");
fs.mkdirSync(outDir, { recursive: true });

// what the user asks in each round, and what must be true of the document afterwards
const ROUNDS = [
  { name: "cold: one exact word change", comments: [["Customer satisfaction held steady", 'Change "three" to "four".']], want: { includes: ["all four regions"] } },
  { name: "warm: one exact word change", comments: [["Orders grew in every region", 'Replace "largest" with "biggest".']], want: { includes: ["remaining the biggest"] } },
  { name: "warm: two comments", comments: [["Supply delays remain the main risk", 'Change "two offices" to "three offices".'], ["The next quarter will focus", 'Change "South" to "North".']], want: { includes: ["in three offices", "staff in the North region"] } },
  { name: "warm: rewrite (judgment)", comments: [["Revenue reached 4.2 million", "Tighten this sentence to under 15 words. Keep the 4.2 million figure."]], want: { paraWith: "4.2 million", maxWords: 15 } },
];

const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex").slice(0, 12);
const git = (dir) => {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim() + (execFileSync("git", ["-C", dir, "status", "--porcelain"], { encoding: "utf8" }).trim() ? "+dirty" : "");
  } catch {
    return "unknown";
  }
};
const median = (xs) => (xs.length ? xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);

async function oneRun(i) {
  const wd = fs.mkdtempSync("/tmp/rr/br-");
  const info = prepare("docx-basic", wd);
  const trace = path.join(wd, "trace.jsonl");
  // an `onionskin` on PATH that is exactly the CLI under test
  const bin = path.join(wd, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "onionskin"), `#!/bin/sh\nexec "${process.execPath}" "${cliJs}" "$@"\n`, { mode: 0o755 });
  const py = realCheckerPython();
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, ONIONSKIN_STATE_DIR: info.state_dir, ONIONSKIN_TRACE: trace, ONIONSKIN_NO_SOFFICE: process.env.REALRUN_SOFFICE ? "" : "1", ...(py ? { ONIONSKIN_PYTHON: py } : {}) };
  if (!env.ONIONSKIN_NO_SOFFICE) delete env.ONIONSKIN_NO_SOFFICE;
  const prompt = `Act as if the user just typed \`/onionskin ${info.file}\` in your session. Follow the onionskin skill exactly. The skill is at ${skillDir}/SKILL.md: read it first, and read its reference/ files only when it tells you to. Do not use any other copy of the skill.

A script plays the human user in a browser, so:
1. The environment is already set (ONIONSKIN_STATE_DIR and the \`onionskin\` command on PATH). Do not change it.
2. Run \`onionskin open ${info.file} --no-open\`. Write the URL it prints, alone on one line, to ${info.url_file}. Do not open a browser yourself.
3. Wait for the user's Send with the FOREGROUND path from the skill (\`onionskin poll ${info.file} --timeout 240\`, run again whenever it returns {"status":"timeout"}). Never run it in the background and never end your turn while waiting.
4. The user sends SEVERAL batches. After each one is finished, poll again. Stop only when a poll returns {"status":"closed"}.
Write no chat reply during the review. Work only on ${info.file} and inside ${wd}. Your final message is one line.${extraPrompt ? "\n" + extraPrompt : ""}`;
  const args = ["-p", prompt, "--model", model, "--dangerously-skip-permissions", "--setting-sources", "project", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence", "--output-format", "json", ...(effort ? ["--effort", effort] : [])];
  const agent = spawn("claude", args, { cwd: wd, env, stdio: ["ignore", "pipe", "pipe"], detached: true }); // its own process group, so its polls die with it
  let agentOut = "";
  agent.stdout.on("data", (d) => (agentOut += d));
  agent.stderr.on("data", (d) => (agentOut += d));
  const agentDone = new Promise((r) => agent.on("close", (code) => r(code)));
  const started = Date.now();
  const rec = { label, model, effort, run: i, skill_sha: sha(path.join(skillDir, "SKILL.md")), cli: git(path.dirname(path.dirname(cliJs))), rounds: [], ok: false };
  let br;
  try {
    let url = "";
    while (!url && Date.now() - started < 300_000) {
      if (fs.existsSync(info.url_file)) url = fs.readFileSync(info.url_file, "utf8").split(/\s+/).find((x) => /^https?:\/\//.test(x)) || "";
      if (!url) await sleep(250);
    }
    if (!url) throw new Error("the agent wrote no URL within 5 minutes");
    rec.startup_ms = Date.now() - started; // agent start -> URL (reading the skill, open)
    br = await launch();
    const page = await br.page();
    await page.goto(url);
    await waitDoc(page, ".de-p");
    for (const [k, round] of ROUNDS.entries()) {
      const listenFrom = Date.now();
      await page.locator('[data-testid="banner-listening"]').waitFor({ timeout: 120_000 });
      const r = { name: round.name, relisten_wait_ms: Date.now() - listenFrom };
      for (const [para, text] of round.comments) await commentOnParagraph(page, para, text);
      await page.waitForTimeout(300);
      // page-side watch: the moment the wanted text is visible in the document, and the moment the result card appears
      await page.evaluate((want) => {
        const b = (window.__bench = { entries: document.querySelectorAll('[data-testid="activity-entry"]').length });
        const ok = () => {
          const doc = document.querySelector('[data-testid="docwrap"]');
          const text = doc.innerText.replace(/\s+/g, " ");
          if (!(want.includes || []).every((s) => text.includes(s))) return false;
          if (!want.paraWith) return true;
          const p = [...doc.querySelectorAll(".de-p")].find((e) => e.innerText.includes(want.paraWith));
          return !!p && p.innerText.trim().split(/\s+/).length <= want.maxWords;
        };
        b.timer = setInterval(() => {
          if (!b.result_shown && document.querySelectorAll('[data-testid="activity-entry"]').length > b.entries) b.result_shown = Date.now();
          if (!b.visible && ok()) b.visible = Date.now();
          if (b.visible && b.result_shown) clearInterval(b.timer);
        }, 25);
      }, round.want);
      const sent = Date.now();
      await page.locator('[data-testid="send"]').click();
      let b = {};
      while (Date.now() - sent < 300_000) {
        b = await page.evaluate(() => ({ visible: window.__bench.visible, result_shown: window.__bench.result_shown })).catch(() => ({}));
        if (b.visible && b.result_shown) break;
        if (b.result_shown && Date.now() - b.result_shown > 5000) break; // the run finished and the wanted text never showed
        await sleep(100);
      }
      r.sent = sent;
      r.total_ms = b.visible ? b.visible - sent : null;
      r.result_card_ms = b.result_shown ? b.result_shown - sent : null;
      r.correct = !!b.visible;
      // the commands the agent ran for this round
      const end = b.result_shown || Date.now();
      const cmds = fs.existsSync(trace) ? fs.readFileSync(trace, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
      const mine = cmds.filter((c) => c.end > sent && c.start < end + 500 && !(c.cmd === "poll" && c.start > sent));
      const poll = mine.find((c) => c.cmd === "poll");
      const work = mine.filter((c) => c.cmd !== "poll");
      r.commands = work.map((c) => `${c.cmd}${c.flags.includes("--dry-run") ? " --dry-run" : ""}${c.code ? ` (exit ${c.code})` : ""}`);
      r.command_ms = work.reduce((n, c) => n + (c.end - c.start), 0);
      r.deliver_ms = poll ? poll.end - sent : null;
      r.model_ms = r.result_card_ms != null ? r.result_card_ms - r.command_ms - (r.deliver_ms || 0) : null; // thinking + tool round trips
      rec.rounds.push(r);
      console.log(`  run ${i} round ${k + 1} (${round.name}): ${r.correct ? r.total_ms + " ms" : "WRONG or not finished"}; commands: ${r.commands.join(", ") || "none"}`);
      if (!r.correct) break;
    }
    rec.ok = rec.rounds.length === ROUNDS.length && rec.rounds.every((r) => r.correct);
  } catch (e) {
    rec.error = e.message;
    console.log(`  run ${i} failed: ${e.message}`);
  } finally {
    await br?.close().catch(() => {});
    try {
      execFileSync(path.join(bin, "onionskin"), ["stop"], { env, stdio: "ignore" });
    } catch {}
    // a waiting poll starts the server again, so the agent's whole process group is ended first, then the server is stopped once more
    const killGroup = (sig) => {
      try {
        process.kill(-agent.pid, sig);
      } catch {}
    };
    const soft = setTimeout(() => killGroup("SIGTERM"), 4000);
    const hard = setTimeout(() => killGroup("SIGKILL"), 9000);
    await agentDone;
    clearTimeout(soft);
    clearTimeout(hard);
    killGroup("SIGKILL");
    try {
      execFileSync(path.join(bin, "onionskin"), ["stop"], { env, stdio: "ignore" });
    } catch {}
    try {
      const j = JSON.parse(agentOut);
      rec.agent = { turns: j.num_turns, duration_ms: j.duration_ms, cost_usd: j.total_cost_usd, output_tokens: j.usage?.output_tokens, input_tokens: (j.usage?.input_tokens || 0) + (j.usage?.cache_read_input_tokens || 0) + (j.usage?.cache_creation_input_tokens || 0) };
    } catch {
      rec.agent_tail = agentOut.slice(-400);
    }
    {
      fs.writeFileSync(path.join(wd, "agent-out.txt"), agentOut);
    }
    fs.appendFileSync(path.join(outDir, "runs.jsonl"), JSON.stringify(rec) + "\n");
    if (rec.ok && !process.env.BENCH_KEEP) fs.rmSync(wd, { recursive: true, force: true });
    else console.log(`  evidence kept in ${wd}`);
  }
  return rec;
}

console.log(`${label}: model ${model}${effort ? " effort " + effort : ""}, ${runs} runs, skill ${sha(path.join(skillDir, "SKILL.md"))}, cli ${git(path.dirname(path.dirname(cliJs)))}, load ${execFileSync("uptime").toString().split("load averages: ")[1].trim()}`);
const all = [];
for (let i = 1; i <= runs; i++) all.push(await oneRun(i));
const good = all.filter((r) => r.ok);
console.log(`\n${label}: ${good.length} of ${runs} runs correct in every round`);
for (const [k, round] of ROUNDS.entries()) {
  const xs = all.map((r) => r.rounds[k]).filter((r) => r?.correct);
  if (!xs.length) continue;
  const t = xs.map((r) => r.total_ms);
  console.log(`  ${String(median(t)).padStart(6)} ms median (min ${Math.min(...t)}, max ${Math.max(...t)}, n ${t.length})  ${round.name}; model ${median(xs.map((r) => r.model_ms))} ms, commands ${median(xs.map((r) => r.command_ms))} ms in ${median(xs.map((r) => r.commands.length))} calls`);
}
const warm = all.flatMap((r) => r.rounds.slice(1).filter((x) => x.correct).map((x) => x.total_ms));
console.log(`  WARM median over all warm rounds: ${median(warm)} ms (min ${warm.length ? Math.min(...warm) : "-"}, max ${warm.length ? Math.max(...warm) : "-"}, n ${warm.length}); startup median ${median(all.map((r) => r.startup_ms).filter(Boolean))} ms`);
process.exit(good.length === runs ? 0 : 1);
