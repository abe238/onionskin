#!/usr/bin/env node
// Proves the harness: runs user-sim.mjs and fake-agent.mjs together for one scenario, then stops the server it started.
//   node scripts/real-run/run-fake.mjs <scenario> <workdir>        exit code = the user-sim's
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { cli, here, prepare } from "./lib.mjs";

const [scenario, workdir] = process.argv.slice(2);
const info = prepare(scenario, workdir);
const run = (script) => {
  const c = spawn(process.execPath, [path.join(here, script), scenario === "x" ? "" : script === "user-sim.mjs" ? scenario : "", info.workdir].filter(Boolean), { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  c.stdout.on("data", (d) => (out += d));
  c.stderr.on("data", (d) => (out += d));
  return { c, done: new Promise((r) => c.on("close", (code) => r({ code, out }))) };
};
const sim = run("user-sim.mjs");
const agent = run("fake-agent.mjs");
// a user script that died must not leave the fake agent polling forever
const s = await sim.done;
const killer = setTimeout(() => agent.c.kill("SIGKILL"), 20000);
const a = await agent.done;
clearTimeout(killer);
// a recording made with the stand-in agent must never pass for a real one: stamp the evidence even if the marker read missed it
const evPath = path.join(info.workdir, "evidence.json");
if (fs.existsSync(evPath)) fs.writeFileSync(evPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(evPath, "utf8")), fake: true }, null, 2));
fs.writeFileSync(path.join(info.workdir, "sim.log"), s.out);
fs.writeFileSync(path.join(info.workdir, "fake-agent.log"), a.out);
await cli(info, ["stop"]);
process.stdout.write(s.out);
if (a.code !== 0) console.log(`fake-agent exited ${a.code}:\n${a.out}`);
process.exit(s.code || (a.code ? 1 : 0));
