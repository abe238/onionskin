#!/usr/bin/env node
// The correctness and safety gate for the agent side: a REAL agent (headless Claude Code) answers each of the five scenarios, with the skill
// and CLI of THIS checkout, while user-sim.mjs plays the user and checks the resulting file. Uses the user's Claude allowance.
//   node scripts/real-run/gate-real.mjs [--model sonnet] [scenario ...]        exit 0 only when every scenario passed
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { SCENARIOS, here, prepare, realCheckerPython, repo } from "./lib.mjs";

const argv = process.argv.slice(2);
const model = argv.includes("--model") ? argv.splice(argv.indexOf("--model"), 2)[1] : "sonnet";
const scenarios = argv.length ? argv : Object.keys(SCENARIOS);
const skill = path.join(repo, "skills", "onionskin", "SKILL.md");
const cliJs = path.join(repo, "src", "cli.js");
fs.mkdirSync("/tmp/rr", { recursive: true });
let failed = 0;
for (const sc of scenarios) {
  const wd = fs.mkdtempSync("/tmp/rr/gate-");
  const info = prepare(sc, wd);
  const bin = path.join(wd, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "onionskin"), `#!/bin/sh\nexec "${process.execPath}" "${cliJs}" "$@"\n`, { mode: 0o755 });
  const py = realCheckerPython();
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, ONIONSKIN_STATE_DIR: info.state_dir, ONIONSKIN_NO_SOFFICE: "1", ...(py ? { ONIONSKIN_PYTHON: py } : {}) };
  const prompt = `Act as if the user just typed \`/onionskin ${info.file}\` in your session. Follow the onionskin skill exactly. The skill is at ${skill}: read it first, and read its reference/ files only when it tells you to. Do not use any other copy of the skill.

A script plays the human user in a browser, so:
1. The environment is already set (ONIONSKIN_STATE_DIR and the \`onionskin\` command on PATH). Do not change it.
2. Run \`onionskin open ${info.file} --no-open\`. Write the URL it prints, alone on one line, to ${info.url_file}. Do not open a browser yourself.
3. Wait for the user's Send in the FOREGROUND as the skill says. Never run the wait in the background and never end your turn while waiting.
Keep going until a poll returns {"status":"closed"}. Write no chat reply during the review. Work only on ${info.file} and inside ${wd}; touch nothing else on this machine. Your final message is one line.`;
  const agent = spawn("claude", ["-p", prompt, "--model", model, "--dangerously-skip-permissions", "--setting-sources", "project", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"], { cwd: wd, env, stdio: "ignore", detached: true });
  const sim = spawn(process.execPath, [path.join(here, "user-sim.mjs"), sc, wd], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  sim.stdout.on("data", (d) => (out += d));
  sim.stderr.on("data", (d) => (out += d));
  const code = await new Promise((r) => sim.on("close", r));
  try {
    execFileSync(path.join(bin, "onionskin"), ["stop"], { env, stdio: "ignore" });
  } catch {}
  try {
    process.kill(-agent.pid, "SIGKILL");
  } catch {}
  try {
    execFileSync(path.join(bin, "onionskin"), ["stop"], { env, stdio: "ignore" });
  } catch {}
  fs.writeFileSync(path.join(wd, "sim.log"), out);
  const table = out.slice(out.lastIndexOf(`\n${sc}\n`));
  console.log(code === 0 ? `PASS  ${sc}  (${(table.match(/RESULT: PASS \((\d+) checks\)/) || [])[1] || "?"} checks)` : `FAIL  ${sc}  evidence in ${wd}\n${table.split("\n").filter((l) => /FAIL|RESULT/.test(l)).join("\n")}`);
  if (code === 0) fs.rmSync(wd, { recursive: true, force: true });
  else failed++;
}
console.log(failed ? `\nGATE: ${failed} of ${scenarios.length} scenarios FAILED` : `\nGATE: all ${scenarios.length} scenarios passed (model ${model})`);
process.exit(failed ? 1 : 0);
