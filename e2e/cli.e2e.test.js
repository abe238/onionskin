import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { createHash } from "node:crypto";
import { makeWorld, python, repo } from "./helpers/harness.mjs";

// Real CLI + real detached server, no browser.
let w;
before(() => {
  w = makeWorld();
});
after(() => w.cleanup());

test("open: prints the URL and poll command; refuses macro files, directories and non-OOXML; stores the server in a 0700 dir", async () => {
  const file = w.doc("long.docx");
  const r = await w.cli(["open", "--no-open", file]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^http:\/\/127\.0\.0\.1:\d+\/\?s=[0-9a-f]{16}&n=/m);
  assert.ok(r.stdout.includes(`onionskin poll '${fs.realpathSync(file)}'`));
  assert.equal(fs.statSync(w.state).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(w.state, "s.sock")).mode & 0o777, 0o600);
  fs.copyFileSync(file, w.doc("x.docm"));
  const macro = await w.cli(["open", "--no-open", w.doc("x.docm")]);
  assert.equal(macro.code, 1);
  assert.match(macro.stderr, /macro/);
  const dir = await w.cli(["open", "--no-open", w.docs]);
  assert.equal(dir.code, 1);
  fs.writeFileSync(w.doc("fake.docx"), "plain text");
  assert.match((await w.cli(["open", "--no-open", w.doc("fake.docx")])).stderr, /Not a valid \.docx/);
  assert.match((await w.cli(["open", "--no-open", w.doc("missing.docx")])).stderr, /not found/i);
  const second = await w.cli(["open", "--no-open", file]);
  assert.equal(second.code, 0, "a second open reuses the server and session");
});

test("status, poll --timeout, done without a batch", async () => {
  const file = w.doc("long.docx");
  const st = JSON.parse((await w.cli(["status", file])).stdout);
  assert.equal(st.state, "idle");
  assert.equal(st.locked, false);
  const t0 = Date.now();
  const p = await w.cli(["poll", file, "--timeout", "1"]);
  assert.equal(p.code, 0);
  const out = JSON.parse(p.stdout);
  assert.equal(out.status, "timeout");
  assert.ok(Date.now() - t0 < 6000);
  assert.equal(JSON.parse((await w.cli(["status", file])).stdout).state, "idle", "the timed-out poller deregistered");
  fs.writeFileSync(w.doc("r.json"), JSON.stringify({ summary: "x", results: [] }));
  const done = await w.cli(["done", file, "--results", w.doc("r.json")]);
  assert.equal(done.code, 1);
  assert.match(done.stderr, /no batch is in progress/);
  assert.equal((await w.cli(["done", file, "--results", w.doc("absent.json")])).code, 1);
  assert.equal((await w.cli(["bogus"])).code, 1);
});

test("poll before anything is sent shows listening; a superseded poller is told so; stop shuts the server down", async () => {
  const file = w.doc("long.docx");
  const a = w.spawnCli(["poll", file]);
  await new Promise((r) => a.child.stderr.once("data", r));
  for (let i = 0; i < 50; i++) {
    if (JSON.parse((await w.cli(["status", file])).stdout).state === "listening") break;
    await new Promise((r) => setTimeout(r, 50)); // bounded wait in a test
  }
  assert.equal(JSON.parse((await w.cli(["status", file])).stdout).state, "listening");
  const b = w.spawnCli(["poll", file]);
  const first = await a.done;
  assert.equal(JSON.parse(first.stdout).status, "superseded");
  b.child.kill();
  await w.cli(["stop"]);
  const st = JSON.parse((await w.cli(["status", file])).stdout);
  assert.equal(st.state, "no-server");
});

test("stop ends a waiting poll with closed instead of letting it start the server again", async () => {
  const file = w.doc("stop.docx");
  fs.copyFileSync(w.doc("long.docx"), file);
  assert.equal((await w.cli(["open", "--no-open", file])).code, 0);
  const poll = w.spawnCli(["poll", file]);
  await new Promise((r) => setTimeout(r, 1200)); // the poll is registered
  assert.equal((await w.cli(["stop"])).code, 0);
  const res = await Promise.race([poll.done, new Promise((r) => setTimeout(() => r(null), 8000))]);
  assert.ok(res, "the poll returned within 8 seconds of stop");
  assert.equal(JSON.parse(res.stdout).status, "closed");
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(fs.existsSync(path.join(w.state, "s.sock")), false, "no server was started again");
});

test("--help and -h print the command's own help for every subcommand, and run nothing", async () => {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || "/tmp"), "da-home-"));
  const h = makeWorld({ HOME: home }); // setup writes under HOME: a regression must not touch the real one
  try {
    const { FLAGS } = await import("../src/cli.js");
    const cmds = Object.keys(FLAGS).filter((c) => c !== "setup-checker"); // setup-checker would build a Python environment if it ever ran
    assert.ok(cmds.includes("setup-rewriter") && cmds.includes("apply") && cmds.includes("stop"));
    for (const cmd of cmds) {
      for (const flag of ["--help", "-h"]) {
        const r = await h.cli([cmd, flag]);
        assert.equal(r.code, 0, `${cmd} ${flag}: ${r.stderr}`);
        assert.equal(r.stderr, "", `${cmd} ${flag} says nothing on stderr`);
        const first = r.stdout.split("\n")[0];
        assert.ok(new RegExp(`^  onionskin ${cmd}( |$)`).test(first), `${cmd} ${flag} starts with its own usage line, got: ${first}`);
        assert.ok(!r.stdout.split("\n").some((l) => /^  onionskin (open|poll|status) /.test(l) && cmd !== l.trim().split(" ")[1]), `${cmd} ${flag} lists only its own command`);
      }
    }
    assert.deepEqual(fs.readdirSync(home), [], "no command ran: nothing was installed under HOME");
    assert.equal(fs.existsSync(path.join(h.state, "s.sock")), false, "no server was started");
  } finally {
    await h.cleanup();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// A person at a terminal vs an agent (src/person.js). Agents and scripts must keep getting the output above, byte for byte.
const agentOpenText = (typed, real, url) =>
  `Opened ${typed}${real !== path.resolve(typed) ? ` (real path ${real})` : ""}\n${url}\n\nTo receive the user's batch, run:\n  onionskin poll '${real}'\nAny path form of this file (as typed or the real path) works in later commands.\nIt can run in the background (Claude Code) or in the foreground with --timeout <secs> (see the skill).\n`;

test("agents and scripts get open's output unchanged: piped, --agent, an agent's environment, and the `onionskin <file>` shortcut", async () => {
  const file = w.doc("long.docx");
  const real = fs.realpathSync(file);
  const { CLAUDECODE, ...plain } = w.env;
  for (const [args, env] of [[["open", "--no-open", file]], [["open", "--no-open", "--agent", file]], [[file, "--no-open"]], [["open", "--no-open", file], plain], [["open", "--no-open", file], { ...plain, CODEX_THREAD_ID: "t" }]]) {
    const r = await new Promise((resolve) => {
      const c = spawn(process.execPath, [path.join(repo, "src", "cli.js"), ...args], { env: env || w.env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      c.stdout.on("data", (d) => (stdout += d));
      c.on("close", (code) => resolve({ code, stdout }));
    });
    assert.equal(r.code, 0, args.join(" "));
    const url = r.stdout.split("\n")[1];
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/\?s=[0-9a-f]{16}&n=/);
    assert.equal(r.stdout, agentOpenText(file, real, url), args.join(" "));
  }
});

test("--no-agent: the person's words for open and poll, with no agent words; poll exits 2 without waiting", async () => {
  const file = w.doc("long.docx");
  const o = await w.cli(["open", "--no-open", "--no-agent", file]);
  assert.equal(o.code, 0, o.stderr);
  assert.match(o.stdout, /^Opened long\.docx\. Open this link in your browser:\n  http:/);
  assert.match(o.stdout, /works together with a coding agent/);
  assert.doesNotMatch(o.stdout.replace(/http:\S+/, ""), /poll|lease|ticket|json|[{}]/i);
  const t0 = Date.now();
  const p = await w.cli(["poll", "--no-agent", file]);
  assert.equal(p.code, 2);
  assert.ok(Date.now() - t0 < 5000, "poll did not wait for a Send");
  assert.equal(p.stdout.trimEnd().split("\n").length, 2);
  assert.match(p.stdout, /the command the coding agent runs/);
  assert.doesNotMatch(p.stdout, /[{}]|lease|ticket/);
  assert.equal(JSON.parse((await w.cli(["status", file])).stdout).state, "idle", "no poller was registered");
});

test("a person at a real terminal (pseudo-terminal, no agent variables) gets the page and the background agent (one plain line, no question); --no-agent opens the page only; poll does not dump the batch", { skip: process.platform === "win32" }, async () => {
  const file = w.doc("person.docx");
  fs.copyFileSync(w.doc("long.docx"), file);
  const bin = path.join(w.root, "fakebin");
  fs.mkdirSync(bin, { recursive: true });
  const log = path.join(w.root, "fake.log");
  // a stand-in `claude` that only logs (the CLI finds it, so the person is told the agent starts; no test ever starts one)
  fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\nfor a in "$@"; do echo "ARG:$a" >> '${log}'; done\ntest -t 0 && echo "fake agent has the terminal"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "open"), `#!/bin/sh\necho "BROWSER:$1" >> '${log}'\n`, { mode: 0o755 });
  const env = { HOME: path.join(w.root, "home"), TERM: "xterm", ONIONSKIN_STATE_DIR: w.state, PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin` }; // no CLAUDECODE, no CODEX_*
  const pty = (answer, args, then = []) =>
    new Promise((resolve) => {
      const c = spawn(python, ["-I", path.join(repo, "e2e", "helpers", "pty-run.py"), answer, ...then, process.execPath, path.join(repo, "src", "cli.js"), ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      c.stdout.on("data", (d) => (stdout += d));
      c.on("close", (code) => resolve({ code, stdout }));
    });
  const lines = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : []);
  const opened = (f) => JSON.parse(fs.readFileSync(path.join(w.state, "sessions", `${createHash("sha256").update(fs.realpathSync(f)).digest("hex").slice(0, 16)}.json`), "utf8")).openedFor;
  const yes = await pty("-", [file]);
  assert.equal(yes.code, 0, yes.stdout);
  assert.equal(opened(file), "background", "the open carried the background flag to the server");
  assert.match(yes.stdout, /Opened person\.docx in your browser\./);
  assert.match(yes.stdout, /Claude Code is starting in the background to work on this file with you\. Press Send in the page when you are ready\./);
  assert.doesNotMatch(yes.stdout, /\[Y\/n\]|fake agent has the terminal/, "no question, and the terminal stays the person's");
  assert.doesNotMatch(yes.stdout.replace(/http:\S+/, ""), /poll|lease|ticket|json|[{}]/i);
  // the server this file's earlier tests started runs under the test runner, so it never starts an agent (src/agent-detect.js agentsDisabled)
  await new Promise((r) => setTimeout(r, 500));
  assert.ok(!lines().includes("ARG:-p"), "no agent was started by a test");
  assert.equal(lines().filter((l) => l.startsWith("BROWSER:http://127.0.0.1:")).length, 1, "the page opened once");
  const other = w.doc("person2.docx");
  fs.copyFileSync(w.doc("long.docx"), other);
  const no = await pty("-", ["open", "--no-agent", other]);
  assert.equal(no.code, 0);
  assert.equal(opened(other), undefined, "--no-agent sends no background flag");
  assert.match(no.stdout, /When you want an agent on it/);
  assert.doesNotMatch(no.stdout, /starting in the background/);
  const poll = await pty("-", ["poll", file]);
  assert.equal(poll.code, 2);
  assert.match(poll.stdout, /the command the coding agent runs/);
  assert.doesNotMatch(poll.stdout, /[{}]|lease|ticket/);
});
