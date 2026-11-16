// The background agent runner (src/agent-runner.js) and the guards it needs in session.js, cli.js and reply.js.
// No real agent and no real process is started: spawn, execFile (ps, the preflight), kill, the clock and timers are all injected.
// Toy DOCX files and the state dir live in a temp dir only.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn as realSpawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { tmpdir, docxBytes } from "./helpers/zipbuild.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = fs.realpathSync(tmpdir());
process.env.ONIONSKIN_STATE_DIR = path.join(root, "st");
process.env.ONIONSKIN_NO_SOFFICE = "1";
delete process.env.ONIONSKIN_PYTHON;
const { Sessions, HttpError } = await import("../src/session.js");
const { ensureStateDir } = await import("../src/paths.js");
const { agentRunner } = await import("../src/agent-runner.js");
const { bgHolder, buildArgv, cleanEnv, findClaude, findCodex } = await import("../src/agent-detect.js");
const { refDir, readSkill, backgroundPrompt } = await import("../src/agent-prompt.js");
ensureStateDir();
after(() => fs.rmSync(root, { recursive: true, force: true }));

const fakeBin = path.join(root, "fakebin");
fs.mkdirSync(fakeBin);
fs.writeFileSync(path.join(fakeBin, "claude"), "#!/bin/sh\nexit 3\n", { mode: 0o755 }); // never run: spawn and execFile are fakes
const paras = Array.from({ length: 6 }, (_, i) => `Paragraph ${i + 1}: a sentence for the runner tests, number ${i}.`);
let n = 0;
const doc = () => {
  const f = path.join(root, `d${++n}.docx`);
  fs.writeFileSync(f, docxBytes(paras));
  return fs.realpathSync(f);
};
const comment = (id, i, text = "fix") => ({ id, kind: "element", text, anchor: { location: { blockPath: [i] }, paraText: paras[i] } });
const flush = async () => {
  for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r));
};

/** A world: Sessions, a fake clock, fake processes. `ps` answers the start time recorded for a pid (or nothing). */
function world({ env = {}, tabs = () => 0, lstart = (pid) => `start-${pid}` } = {}) {
  const S = new Sessions();
  let t = 1_800_000_000_000;
  const spawned = [];
  const signals = [];
  const timers = [];
  const execCalls = [];
  let pid = 1000;
  const execFile = (bin, args, opts, cb) => {
    execCalls.push([bin, args]);
    let out = "";
    if (bin === "/bin/ps") out = lstart(Number(args[args.length - 1])) ?? "";
    else if (args[0] === "--version") out = "2.1.323 (Claude Code)\n";
    else if (args[0] === "auth") out = JSON.stringify({ loggedIn: true, authMethod: "claude.ai" });
    const err = bin === "/bin/ps" && !out ? Object.assign(new Error("no such process"), { code: 1 }) : null;
    queueMicrotask(() => cb(err, out, ""));
  };
  const spawn = (bin, argv, opts) => {
    const c = new EventEmitter();
    c.pid = ++pid;
    c.stdout = new PassThrough();
    c.stderr = new PassThrough();
    c.lines = (...ls) => c.stdout.write(ls.map((l) => JSON.stringify(l)).join("\n") + "\n");
    c.die = async (code = 1, signal = null) => {
      await flush();
      c.emit("exit", code, signal);
      await flush();
    };
    spawned.push({ bin, argv, opts, child: c });
    return c;
  };
  const R = agentRunner(S, {
    spawn, execFile, now: () => t, kill: (p, sig) => signals.push([p, sig]),
    setTimeout: (fn, ms) => (timers.push({ fn, ms }), { unref() {} }),
    env: { HOME: root, USER: "u", PATH: "/usr/bin:/bin", ONIONSKIN_AGENT_PATH: fakeBin, ANTHROPIC_API_KEY: "sk-ant-secret", OPENAI_API_KEY: "sk-x", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", ...env },
    tabs,
  });
  S.agent = R;
  return { S, R, spawned, signals, timers, execCalls, advance: (ms) => (t += ms), now: () => t, tick: async () => (R.tick(), await flush()) };
}

/** A session opened from a terminal (the background flag), with a Send waiting. */
async function stranded(w, { background = true } = {}) {
  const s = w.S.open(doc(), background ? { agent: "background" } : {});
  w.S.send(s.key, { baseSha: s.baseSha, comments: [comment("c1", 1)], note: "" });
  await flush();
  return s;
}

test("1. ensure twice spawns once; the view goes starting -> ready -> working", async () => {
  const w = world();
  const s = w.S.open(doc(), { agent: "background" });
  w.R.ensure(s.key);
  w.R.ensure(s.key);
  await flush();
  w.R.ensure(s.key);
  await flush();
  assert.equal(w.spawned.length, 1);
  assert.equal(w.S.view(s).agent.state, "starting");
  assert.equal(w.S.view(s).agent.cli, "claude");
  const p = w.S.poll(s.key, { holder: bgHolder(s.key) });
  assert.equal(w.S.view(s).agent.state, "ready");
  w.S.send(s.key, { baseSha: s.baseSha, comments: [comment("c1", 1)], note: "" });
  await p.promise;
  assert.equal(w.S.view(s).agent.state, "working");
  assert.deepEqual(Object.keys(w.S.view(s).agent).sort(), ["activity", "cli", "failure", "show", "startsLeft", "state"]);
});

test("2. no spawn while another agent polls the file; that agent shows as external", async () => {
  const w = world();
  const s = w.S.open(doc(), { agent: "background" });
  w.S.poll(s.key, { holder: "h_person" });
  w.R.ensure(s.key);
  await flush();
  assert.equal(w.spawned.length, 0);
  assert.equal(w.S.view(s).agent.state, "external");
});

test("3. superseded: the person's own agent polls, the background group is stopped, and nothing restarts it", async () => {
  const w = world();
  const s = w.S.open(doc(), { agent: "background" });
  w.R.ensure(s.key);
  await flush();
  const bg = w.S.poll(s.key, { holder: bgHolder(s.key) });
  w.S.poll(s.key, { holder: "h_person" });
  assert.deepEqual(await bg.promise, { status: "superseded", next_step: "Another poller took over this file." });
  await flush();
  const child = w.spawned[0].child;
  assert.deepEqual(w.signals, [[-child.pid, "SIGTERM"]]);
  await child.die(0);
  assert.equal(w.S.view(s).agent.state, "external");
  // a background poll while that agent listens never takes the file back: it is told superseded at once
  const again = w.S.poll(s.key, { holder: bgHolder(s.key) });
  assert.equal((await again.promise).status, "superseded");
  assert.equal(w.S.state(s), "listening");
  w.advance(10 * 60 * 1000);
  await w.tick();
  assert.equal(w.spawned.length, 1, "no restart");
});

test("4. an exit while holding the batch hands it back at once, then restarts back off 2, 4, 8 s and resume the conversation", async () => {
  const w = world();
  const s = await stranded(w);
  assert.equal(w.spawned.length, 1);
  const c = w.spawned[0].child;
  c.lines({ type: "system", subtype: "init", session_id: "x" });
  const p = w.S.poll(s.key, { holder: bgHolder(s.key) });
  await p.promise;
  assert.equal(w.S.state(s), "working");
  await c.die(1);
  assert.equal(w.S.state(s), "stranded", "the batch is pending again and the page unlocked, without waiting for the lease");
  assert.equal(w.S.view(s).locked, false);
  assert.equal(s.activity[0].kind, "lease_expired");
  for (const [i, wait] of [2000, 4000, 8000].entries()) {
    w.advance(wait - 1);
    await w.tick();
    assert.equal(w.spawned.length, i + 1, `not before ${wait} ms`);
    w.advance(1);
    await w.tick();
    assert.equal(w.spawned.length, i + 2, `restarted after ${wait} ms`);
    const argv = w.spawned.at(-1).argv;
    assert.equal(argv[argv.indexOf("--resume") + 1], w.spawned[0].argv[w.spawned[0].argv.indexOf("--session-id") + 1], "the same conversation is resumed");
    w.spawned.at(-1).child.lines({ type: "system", subtype: "init", session_id: "x" });
    await w.spawned.at(-1).child.die(1);
  }
});

test("5. the 6th start in an hour fails with too_many_restarts; Try again starts over", async () => {
  const w = world();
  const s = await stranded(w);
  for (let i = 0; i < 4; i++) {
    await w.spawned.at(-1).child.die(1);
    w.advance(40_000);
    await w.tick();
  }
  assert.equal(w.spawned.length, 5);
  await w.spawned.at(-1).child.die(1);
  w.advance(40_000);
  await w.tick();
  assert.equal(w.spawned.length, 5, "no 6th start");
  assert.deepEqual(w.S.view(s).agent.failure, { code: "too_many_restarts" });
  assert.equal(w.S.view(s).agent.state, "failed");
  await w.R.action(s.key, { action: "start" });
  await flush();
  assert.equal(w.spawned.length, 6);
});

test("6. stop signals the group only while ps still shows the recorded start time; a reused pid gets no signal at all", async () => {
  let same = true;
  const w = world({ lstart: (pid) => (same ? "Fri Nov 13 10:00:00 2026" : "Fri Nov 13 11:11:11 2026") });
  const s = w.S.open(doc(), { agent: "background" });
  w.R.ensure(s.key);
  await flush();
  const c = w.spawned[0].child;
  assert.equal(c.pid, w.spawned[0].child.pid);
  assert.equal(w.spawned[0].opts.detached, true, "its own process group");
  const rec = JSON.parse(fs.readFileSync(path.join(process.env.ONIONSKIN_STATE_DIR, "agents", `${s.key}.json`), "utf8"));
  assert.deepEqual(rec, { pid: c.pid, pgid: c.pid, lstart: "Fri Nov 13 10:00:00 2026", holder: bgHolder(s.key), key: s.key, cli: "claude", session_id: rec.session_id });
  same = false;
  assert.equal(await w.R.stop(s.key), false);
  assert.deepEqual(w.signals, []);
  same = true;
  assert.equal(await w.R.stop(s.key), true);
  assert.deepEqual(w.signals, [[-c.pid, "SIGTERM"]]);
  // the SIGKILL 4 s later is checked again
  assert.equal(w.timers.at(-1).ms, 4000);
  same = false;
  await w.timers.at(-1).fn();
  assert.deepEqual(w.signals, [[-c.pid, "SIGTERM"]]);
  same = true;
  await w.timers.at(-1).fn();
  assert.deepEqual(w.signals.at(-1), [-c.pid, "SIGKILL"]);
  await c.die(null, "SIGTERM");
  assert.equal(w.S.view(s).agent.state, "none");
  assert.equal(fs.existsSync(path.join(process.env.ONIONSKIN_STATE_DIR, "agents", `${s.key}.json`)), false, "the record is gone with the process");
});

test("7. reapOrphans stops a group whose record matches a live process, leaves a mismatched one alone, and deletes both records", async () => {
  const w = world({ lstart: (pid) => (pid === 4242 ? "T1" : pid === 4343 ? "T-other" : null) });
  const dir = path.join(process.env.ONIONSKIN_STATE_DIR, "agents");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "aaaaaaaaaaaaaaaa.json"), JSON.stringify({ pid: 4242, pgid: 4242, lstart: "T1", holder: "onionskin-bg-aaaaaaaaaaaaaaaa", key: "aaaaaaaaaaaaaaaa" }));
  fs.writeFileSync(path.join(dir, "bbbbbbbbbbbbbbbb.json"), JSON.stringify({ pid: 4343, pgid: 4343, lstart: "T-mine", holder: "onionskin-bg-bbbbbbbbbbbbbbbb", key: "bbbbbbbbbbbbbbbb" }));
  fs.writeFileSync(path.join(dir, "cccccccccccccccc.json"), "{broken");
  const r = await w.R.reapOrphans();
  assert.deepEqual(w.signals, [[-4242, "SIGTERM"]]);
  assert.deepEqual(r.filter((x) => /^([abc])\1{15}$/.test(x.key)).map((x) => [x.key[0], x.stopped]).sort(), [["a", true], ["b", false], ["c", false]]);
  assert.deepEqual(fs.readdirSync(dir).filter((x) => x.endsWith(".json")), []);
});

test("8. idle: 20 minutes with no tab and no batch stops the agent; a tab keeps it", async () => {
  let open = 1;
  const w = world({ tabs: () => open });
  const s = w.S.open(doc(), { agent: "background" });
  w.R.ensure(s.key);
  await flush();
  for (let i = 0; i < 3; i++) {
    w.advance(10 * 60 * 1000);
    await w.tick();
  }
  assert.deepEqual(w.signals, [], "a tab is connected");
  open = 0;
  await w.tick();
  w.advance(20 * 60 * 1000 - 1);
  await w.tick();
  assert.deepEqual(w.signals, []);
  w.advance(1);
  await w.tick();
  assert.deepEqual(w.signals, [[-w.spawned[0].child.pid, "SIGTERM"]]);
  await w.spawned[0].child.die(0);
  w.advance(60 * 60 * 1000);
  await w.tick();
  assert.equal(w.spawned.length, 1, "an idle stop is not a crash");
  assert.equal(w.S.view(s).agent.state, "none");
});

test("9. stopAll signals every running agent and waits for them", async () => {
  const w = world();
  const a = w.S.open(doc(), { agent: "background" });
  const b = w.S.open(doc(), { agent: "background" });
  w.R.ensure(a.key);
  w.R.ensure(b.key);
  await flush();
  const done = w.R.stopAll();
  await flush();
  assert.deepEqual(w.signals.map((x) => x[1]), ["SIGTERM", "SIGTERM"]);
  for (const x of w.spawned) x.child.emit("exit", null, "SIGTERM");
  await done;
  w.R.ensure(a.key);
  await flush();
  assert.equal(w.spawned.length, 2, "nothing starts while the server stops");
});

test("10. the command line is exactly the least-privilege form, run in the agent's own real work folder with no stdin", async () => {
  const w = world();
  const s = w.S.open(doc(), { agent: "background" });
  w.R.ensure(s.key);
  await flush();
  const { bin, argv, opts } = w.spawned[0];
  assert.equal(bin, path.join(fakeBin, "claude"));
  const W = fs.realpathSync(path.join(process.env.ONIONSKIN_STATE_DIR, "agents", s.key));
  const REF = refDir();
  const sid = argv[argv.indexOf("--session-id") + 1];
  assert.match(sid, /^[0-9a-f-]{36}$/);
  assert.deepEqual(argv, [
    "-p", backgroundPrompt({ file: s.file, workDir: W, timeout: 590 }),
    "--append-system-prompt", readSkill(),
    "--model", "sonnet",
    "--session-id", sid,
    "--output-format", "stream-json", "--verbose", "--max-turns", "200",
    "--restricted",
    "--tools", "Bash,Read,Write",
    "--allowedTools", "Bash(onionskin poll:*)", "Bash(onionskin reply:*)", "Bash(onionskin status:*)", `Read(/${REF}/**)`, `Read(/${W}/outline/**)`, `Edit(/${W}/**)`,
    "--add-dir", REF,
    "--add-dir", `${W}/outline`,
    "--permission-mode", "dontAsk", "--permission-prompts", "none",
    "--setting-sources", "", "--strict-mcp-config", "--disable-slash-commands",
  ]);
  assert.ok(`Edit(/${W}/**)`.startsWith("Edit(//"), "an absolute rule (`//`)");
  assert.equal(opts.cwd, W);
  assert.deepEqual(opts.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(fs.statSync(W).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(W, "outline")).mode & 0o777, 0o700, "the only part of its folder the agent may read: the outline files");
  const prompt = argv[1];
  assert.ok(prompt.includes(`${W}/reply-<batch_id>.json`) && prompt.includes("--file") && /Never use `--json`/.test(prompt));
  assert.ok(!prompt.includes("Paragraph"), "no document text in the prompt");
  // the wrapper runs this build's CLI
  const wrapper = fs.readFileSync(path.join(process.env.ONIONSKIN_STATE_DIR, "agents", "bin", "onionskin"), "utf8");
  assert.equal(wrapper, `#!/bin/sh\nexec '${process.execPath}' '${path.join(repo, "src", "cli.js")}' "$@"\n`);
  // the Terminal form: the same limits, no -p, no stream flags
  const term = buildArgv({ skill: "S", sessionId: sid, resume: true, workDir: W, refDir: REF, print: false });
  assert.ok(!term.includes("-p") && !term.includes("--output-format") && term.includes("--restricted") && term.includes("dontAsk") && term[term.indexOf("--resume") + 1] === sid);
});

test("11. the agent's environment is built from nothing: no API key, no agent-session variables", async () => {
  const w = world();
  const s = w.S.open(doc(), { agent: "background" });
  w.R.ensure(s.key);
  await flush();
  const e = w.spawned[0].opts.env;
  const W = fs.realpathSync(path.join(process.env.ONIONSKIN_STATE_DIR, "agents", s.key));
  assert.deepEqual(Object.keys(e).sort(), ["BASH_DEFAULT_TIMEOUT_MS", "HOME", "LANG", "ONIONSKIN_AGENT_DIR", "ONIONSKIN_HOLDER", "ONIONSKIN_STATE_DIR", "PATH", "TMPDIR", "USER"]);
  assert.equal(e.ONIONSKIN_HOLDER, `onionskin-bg-${s.key}`);
  assert.equal(e.ONIONSKIN_AGENT_DIR, W);
  assert.ok(e.PATH.startsWith(fs.realpathSync(path.join(process.env.ONIONSKIN_STATE_DIR, "agents", "bin")) + ":"));
  assert.ok(!JSON.stringify(e).includes("sk-"), "no key of any kind");
  // the preflight ran with the same clean environment
  assert.ok(w.execCalls.some(([b, a]) => b.endsWith("/claude") && a.join(" ") === "auth status --json"));
  assert.deepEqual(cleanEnv({ binDir: "/b", stateDir: "/s", holder: "h", workDir: "/w", env: { ANTHROPIC_API_KEY: "k", HOME: "/h", USER: "u", TMPDIR: "/t" } }).ANTHROPIC_API_KEY, undefined);
});

test("11b. sign-in, version and not installed fail closed before any start, and never restart by themselves", async () => {
  // not installed: no claude on the search path (HOME decides ~/.local/bin; /opt/homebrew/bin and /usr/local/bin are searched too)
  const none = world({ env: { ONIONSKIN_AGENT_PATH: path.join(root, "empty-dir"), PATH: "/nonexistent", HOME: path.join(root, "nohome") } });
  const s = none.S.open(doc(), { agent: "background" });
  none.R.ensure(s.key);
  await flush();
  const v = none.S.view(s).agent;
  const elsewhere = ["/opt/homebrew/bin/claude", "/usr/local/bin/claude"].some((x) => fs.existsSync(x));
  const codexElsewhere = ["/opt/homebrew/bin/codex", "/usr/local/bin/codex"].some((x) => fs.existsSync(x));
  if (!elsewhere) assert.deepEqual([none.spawned.length, v.state, v.failure], [0, "failed", { code: "not_installed", ...(codexElsewhere ? { codex: true } : {}) }]);
  // Codex alone on the Mac: found (so the page can say "ask Codex"), and never taken for Claude Code
  const only = (name) => (f) => f === `/x/bin/${name}`;
  assert.equal(findCodex({ PATH: "/x/bin", HOME: "/nohome" }, only("codex")), "/x/bin/codex");
  assert.equal(findClaude({ PATH: "/x/bin", HOME: "/nohome" }, only("codex")), null);
  assert.equal(findCodex({ PATH: "/x/bin", HOME: "/nohome" }, only("claude")), null);
  // test processes never start an agent unless they opt in with ONIONSKIN_AGENT_PATH
  const off = world({ env: { ONIONSKIN_AGENT_PATH: "", NODE_TEST_CONTEXT: "child-v8" } });
  const s2 = off.S.open(doc(), { agent: "background" });
  off.R.ensure(s2.key);
  await flush();
  assert.equal(off.spawned.length, 0);
  assert.equal(off.S.view(s2).agent.state, "none");
});

test("12. a background holder's poll never starts a server, and a lost connection ends it with closed", { skip: process.platform === "win32" }, async () => {
  const state = fs.mkdtempSync("/tmp/osr-");
  const run = (args, env) =>
    new Promise((resolve) => {
      const c = realSpawn(process.execPath, [path.join(repo, "src", "cli.js"), ...args], { env: { PATH: process.env.PATH, HOME: root, ONIONSKIN_STATE_DIR: state, ONIONSKIN_NO_SOFFICE: "1", ONIONSKIN_AGENT_CLI: "none", ...env }, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      c.stdout.on("data", (d) => (stdout += d));
      c.on("close", (code) => resolve({ code, stdout }));
    });
  try {
    const f = doc();
    const key = (await import("../src/paths.js")).sessionKey(f);
    const r = await run(["poll", f, "--timeout", "5"], { ONIONSKIN_HOLDER: `onionskin-bg-${key}` });
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.stdout), { status: "closed", reason: "the server stopped" });
    assert.equal(fs.existsSync(path.join(state, "s.sock")), false, "no server was started");
    // the Open in Terminal agent has the same limits: its poll does not start a server either
    const rt = await run(["poll", f, "--timeout", "5"], { ONIONSKIN_HOLDER: `onionskin-term-${key}` });
    assert.deepEqual(JSON.parse(rt.stdout), { status: "closed", reason: "the server stopped" });
    assert.equal(fs.existsSync(path.join(state, "s.sock")), false, "no server was started by the Terminal holder");
    // a server that dies under a waiting background poll is not started again
    assert.equal((await run(["open", "--no-open", f], {})).code, 0);
    const pid = JSON.parse(fs.readFileSync(path.join(state, "server.json"), "utf8")).pid;
    const poll = run(["poll", f, "--timeout", "60"], { ONIONSKIN_HOLDER: `onionskin-bg-${key}` });
    for (let i = 0; i < 100; i++) {
      const st = await run(["status", f], {});
      if (JSON.parse(st.stdout).pollers === 1) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    process.kill(pid, "SIGKILL"); // the server this test started, by its own pid
    const out = await poll;
    assert.deepEqual(JSON.parse(out.stdout), { status: "closed", reason: "the server stopped" });
    assert.equal(JSON.parse((await run(["status", f], {})).stdout).state, "no-server", "nothing brought it back");
  } finally {
    await run(["stop"], {});
    fs.rmSync(state, { recursive: true, force: true });
  }
});

test("12b. the stranded grace: a file not opened from a terminal waits 20 s, and an agent that polls in time means no start; Start skips the wait", async () => {
  const w = world();
  const s = await stranded(w, { background: false });
  w.advance(19_999);
  await w.tick();
  assert.equal(w.spawned.length, 0);
  w.advance(1);
  await w.tick();
  assert.equal(w.spawned.length, 1, "still nobody after 20 s: the background agent starts");
  const w2 = world();
  const s2 = await stranded(w2, { background: false });
  w2.advance(10_000);
  await w2.tick();
  const own = w2.S.poll(s2.key, { holder: "h_person" });
  await own.promise; // the person's agent took the batch
  w2.advance(60_000);
  await w2.tick();
  assert.equal(w2.spawned.length, 0);
  const w3 = world();
  const s3 = await stranded(w3, { background: false });
  await w3.R.action(s3.key, { action: "start" });
  await flush();
  assert.equal(w3.spawned.length, 1, "the Start button does not wait");
  // a file opened from a terminal does not wait at all
  const w4 = world();
  await stranded(w4);
  assert.equal(w4.spawned.length, 1);
});

test("12c. releaseAgent does what a lease expiry does (wrote: Revert entry and reload; not written: pending again), only for the delivery's own holder", async () => {
  for (const wrote of [false, true]) {
    const w = world();
    const s = w.S.open(doc(), { agent: "background" });
    const p = w.S.poll(s.key, { holder: bgHolder(s.key) });
    w.S.send(s.key, { baseSha: s.baseSha, comments: [comment("c1", 1)], note: "" });
    await p.promise;
    assert.throws(() => w.S.releaseAgent(s.key, "h_other"), (e) => e instanceof HttpError && e.extra.code === "not_lease_holder");
    assert.throws(() => w.S.releaseAgent(s.key, "onionskin-bg-0000000000000000"), (e) => e instanceof HttpError && e.status === 403);
    if (wrote) fs.writeFileSync(s.file, docxBytes(paras.map((x) => x + " changed")));
    const events = [];
    w.S.on("change", (_s, ev) => events.push(ev));
    w.S.releaseAgent(s.key, bgHolder(s.key));
    assert.equal(w.S.state(s), "stranded");
    assert.equal(s.delivered, null);
    assert.ok(s.pending);
    assert.equal(s.activity[0].kind, "lease_expired");
    assert.equal(s.activity.some((a) => a.kind === "agent" && a.summary === "The agent stopped responding after changing the file." && a.revertRecommended), wrote);
    assert.ok(events.includes(wrote ? "reload" : "state"));
    assert.throws(() => w.S.releaseAgent(s.key, bgHolder(s.key)), (e) => e.extra.code === "no_batch");
  }
});

test("12d. a run that reaches its turn limit is recycled: a fresh conversation at once, not counted as a crash", async () => {
  const w = world();
  const s = await stranded(w);
  for (let i = 0; i < 7; i++) {
    const c = w.spawned.at(-1).child;
    c.lines({ type: "system", subtype: "init", session_id: "s" }, { type: "result", subtype: "error_max_turns", is_error: true, num_turns: 200 });
    await c.die(1);
  }
  assert.equal(w.spawned.length, 8, "7 recycles past the hourly cap of 5, no failure");
  assert.equal(w.S.view(s).agent.failure, null);
  const ids = w.spawned.map((x) => x.argv[x.argv.indexOf("--session-id") + 1]);
  assert.equal(new Set(ids).size, 8, "each recycle is a new conversation (no --resume)");
});

test("12e. failures from the stream: signed out, usage limit, a refusal that left the batch held; none restarts by itself", async () => {
  const lines = {
    signed_out: [{ type: "assistant", error: "authentication_failed", message: { content: [] } }, { type: "result", is_error: true, terminal_reason: "api_error" }],
    limit: [{ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1794902400 } }],
    refused: [{ type: "result", subtype: "success", is_error: false, permission_denials: [{ tool_name: "Bash" }] }],
  };
  for (const [code, ls] of Object.entries(lines)) {
    const w = world();
    const s = await stranded(w);
    const c = w.spawned[0].child;
    if (code === "refused") await w.S.poll(s.key, { holder: bgHolder(s.key) }).promise;
    c.lines(...ls);
    await c.die(code === "refused" ? 0 : 1);
    const v = w.S.view(s).agent;
    assert.equal(v.state, "failed", code);
    assert.equal(v.failure.code, code);
    if (code === "refused") assert.equal(w.S.state(s), "stranded", "the batch is saved: pending again");
    w.advance(10 * 60 * 1000);
    await w.tick();
    assert.equal(w.spawned.length, 1, `${code}: no restart by itself`);
  }
});

test("13. the background holder answers with --file inside its work folder only, and a JSON error does not quote the input", async () => {
  const f = doc();
  const W = fs.realpathSync(fs.mkdtempSync(path.join(root, "w-")));
  const outside = path.join(root, "outside.json");
  fs.writeFileSync(outside, '{"replies":[]}');
  const bad = path.join(W, "reply-b_aaaaaaaaaaaa.json");
  fs.writeFileSync(bad, "SECRET-TEXT-FROM-SOMEWHERE not json");
  const run = (args, env) =>
    new Promise((resolve) => {
      const c = realSpawn(process.execPath, [path.join(repo, "src", "cli.js"), "reply", f, "--lease", "b_aaaaaaaaaaaa:0123456789abcdef", ...args], { env: { PATH: process.env.PATH, HOME: root, ONIONSKIN_STATE_DIR: process.env.ONIONSKIN_STATE_DIR, ONIONSKIN_HOLDER: "onionskin-bg-0123456789abcdef", ONIONSKIN_AGENT_DIR: W, ...env }, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      c.stdout.on("data", (d) => (stdout += d));
      c.stdin.end('{"replies":[]}');
      c.on("close", (code) => resolve({ code, json: JSON.parse(stdout) }));
    });
  const out = await run(["--file", outside]);
  assert.equal(out.code, 2);
  assert.match(out.json.error, /in its own work folder/);
  assert.equal(out.json.code, "bad_reply");
  const link = path.join(W, "link.json");
  fs.symlinkSync(outside, link);
  assert.match((await run(["--file", link])).json.error, /in its own work folder/, "a symlink out of the folder is refused");
  assert.match((await run(["--json", '{"replies":[]}'])).json.error, /--file only/);
  assert.match((await run([])).json.error, /--file only/, "stdin too");
  assert.match((await run(["--file", outside], { ONIONSKIN_AGENT_DIR: "" })).json.error, /in its own work folder/, "no work folder: refused");
  const junk = await run(["--file", bad]);
  assert.match(junk.json.error, /^the reply is not valid JSON/);
  assert.ok(!JSON.stringify(junk.json).includes("SECRET"), "the input is never echoed");
  // any other holder: today's behavior (the input reaches the parser, and its message is unchanged)
  const other = await run(["--file", bad], { ONIONSKIN_HOLDER: "h_person" });
  assert.match(other.json.error, /not valid JSON: /);
});

test("14. the reserved holder is bound to its own file; Open in Terminal stops the agent and writes a Terminal file with the same limits", async () => {
  const stub = path.join(root, "open-stub.txt");
  const w = world();
  const s = w.S.open(doc(), { agent: "background" });
  assert.throws(() => w.S.poll(s.key, { holder: "onionskin-bg-ffffffffffffffff" }), (e) => e instanceof HttpError && e.extra.code === "reserved_holder");
  w.R.ensure(s.key);
  await flush();
  w.spawned[0].child.lines({ type: "system", subtype: "init", session_id: "x" });
  await flush();
  const prev = process.env.ONIONSKIN_OPEN_STUB;
  process.env.ONIONSKIN_OPEN_STUB = stub;
  try {
    const t = w.R.action(s.key, { action: "terminal" });
    await flush();
    await w.spawned[0].child.die(null, "SIGTERM");
    await t;
  } finally {
    if (prev === undefined) delete process.env.ONIONSKIN_OPEN_STUB;
    else process.env.ONIONSKIN_OPEN_STUB = prev;
  }
  assert.equal(w.S.view(s).agent.state, "handover");
  const f = fs.readFileSync(stub, "utf8").trim();
  assert.ok(f.endsWith("/open-agent.command"));
  assert.equal(fs.statSync(f).mode & 0o777, 0o700);
  const body = fs.readFileSync(f, "utf8");
  for (const x of ["--restricted", "dontAsk", "'Bash(onionskin poll:*)'", "--resume", "'ONIONSKIN_HOLDER=onionskin-term-", "/usr/bin/env -i"]) assert.ok(body.includes(x), x);
  assert.ok(!body.includes("sk-") && !body.includes("'-p'"));
  w.advance(10 * 60 * 1000);
  await w.tick();
  assert.equal(w.spawned.length, 1, "no restart while it is open in Terminal");
});

test("15. Close session stops the agent and removes its folder (transcript, reply files)", async () => {
  const w = world();
  const s = await stranded(w);
  const c = w.spawned[0].child;
  c.lines({ type: "system", subtype: "init", session_id: "x" });
  await flush();
  const W = path.join(process.env.ONIONSKIN_STATE_DIR, "agents", s.key);
  const tr = path.join(W, "transcript.jsonl");
  assert.equal(fs.statSync(tr).mode & 0o777, 0o600, "the transcript is private");
  assert.match(fs.readFileSync(tr, "utf8"), /"init"/);
  w.S.close(s.key);
  await flush();
  assert.deepEqual(w.signals, [], "it may end by itself first (its poll said closed)");
  const grace = w.timers.find((t) => t.ms === 10_000);
  await grace.fn();
  await flush();
  assert.deepEqual(w.signals, [[-c.pid, "SIGTERM"]], "after 10 s the group is stopped");
  await c.die(null, "SIGTERM");
  assert.equal(fs.existsSync(W), false);
  assert.ok(w.execCalls.some(([b, a]) => b.endsWith("/claude") && a[0] === "purge" && a[2] === "--yes"), "Claude Code's own copy is purged too");
  assert.equal(w.S.view(s).agent.state, "none");
});

test("16. at most N agents at once: the next one waits as starting and starts when a slot frees", async () => {
  const S = new Sessions();
  const spawned = [];
  let pid = 5000;
  const R = agentRunner(S, {
    limits: { maxAgents: 1 },
    spawn: () => {
      const c = new EventEmitter();
      c.pid = ++pid;
      c.stdout = new PassThrough();
      c.stderr = new PassThrough();
      spawned.push(c);
      return c;
    },
    execFile: (bin, args, o, cb) => queueMicrotask(() => cb(null, bin === "/bin/ps" ? "T" : args[0] === "--version" ? "2.1.323" : JSON.stringify({ loggedIn: true }), "")),
    kill: () => {},
    env: { HOME: root, PATH: "/usr/bin", ONIONSKIN_AGENT_PATH: fakeBin },
  });
  S.agent = R;
  const a = S.open(doc(), { agent: "background" });
  const b = S.open(doc(), { agent: "background" });
  R.ensure(a.key);
  await flush();
  R.ensure(b.key);
  await flush();
  assert.equal(spawned.length, 1);
  assert.equal(S.view(b).agent.state, "starting", "it waits for a slot");
  await R.stop(a.key);
  spawned[0].emit("exit", null, "SIGTERM");
  await flush();
  assert.equal(spawned.length, 2, "the waiting one started when the slot freed");
});

test("17. a resume that dies before any stream line falls back to a fresh conversation next time", async () => {
  const w = world();
  await stranded(w);
  w.spawned[0].child.lines({ type: "system", subtype: "init", session_id: "x" });
  await w.spawned[0].child.die(1);
  w.advance(2000);
  await w.tick();
  const resumed = w.spawned[1].argv;
  assert.ok(resumed.includes("--resume"));
  await w.spawned[1].child.die(1); // no line at all: the conversation could not be resumed
  w.advance(4000);
  await w.tick();
  const fresh = w.spawned[2].argv;
  assert.ok(fresh.includes("--session-id") && !fresh.includes("--resume"));
});

// ---- holes found in the merge review: each test failed before its fix -----------------------------------------------------

test("18. reply by file: only <work folder>/reply-<this batch>.json, the name the server's prompt gives; any other file in the folder is refused", async () => {
  const f = doc();
  const W = fs.realpathSync(fs.mkdtempSync(path.join(root, "w-")));
  const run = (file, env = {}) =>
    new Promise((resolve) => {
      const c = realSpawn(process.execPath, [path.join(repo, "src", "cli.js"), "reply", f, "--lease", "b_aaaaaaaaaaaa:0123456789abcdef", "--file", file], { env: { PATH: process.env.PATH, HOME: root, ONIONSKIN_STATE_DIR: process.env.ONIONSKIN_STATE_DIR, ONIONSKIN_HOLDER: "onionskin-bg-0123456789abcdef", ONIONSKIN_AGENT_DIR: W, ...env }, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      c.stdout.on("data", (d) => (stdout += d));
      c.on("close", (code) => resolve({ code, json: JSON.parse(stdout) }));
    });
  for (const name of ["transcript.jsonl", "open-agent.command", "reply-b_bbbbbbbbbbbb.json", "notes.json"]) {
    const p = path.join(W, name);
    fs.writeFileSync(p, '{"replies":[]}');
    const out = await run(p);
    assert.equal(out.code, 2, name);
    assert.match(out.json.error, /reply-b_aaaaaaaaaaaa\.json/, `${name}: the error names the one file allowed`);
  }
  fs.mkdirSync(path.join(W, "sub"));
  fs.writeFileSync(path.join(W, "sub", "reply-b_aaaaaaaaaaaa.json"), '{"replies":[]}');
  assert.match((await run(path.join(W, "sub", "reply-b_aaaaaaaaaaaa.json"))).json.error, /reply-b_aaaaaaaaaaaa\.json/, "not in a sub folder");
  // the Terminal session (Open in Terminal) has the same limits as the background agent
  assert.match((await run(path.join(W, "notes.json"), { ONIONSKIN_HOLDER: "onionskin-term-0123456789abcdef" })).json.error, /reply-b_aaaaaaaaaaaa\.json/, "the Terminal holder too");
});

test("19. the Terminal holder is bound to its own file, like the background one", async () => {
  const w = world();
  const s = w.S.open(doc(), { agent: "background" });
  assert.throws(() => w.S.poll(s.key, { holder: "onionskin-term-ffffffffffffffff" }), (e) => e instanceof HttpError && e.extra.code === "reserved_holder");
  const own = w.S.poll(s.key, { holder: `onionskin-term-${s.key}` });
  assert.equal(w.S.state(s), "listening");
  own.cancel?.();
});

const within = (p, ms = 2000) => Promise.race([p, new Promise((r) => setTimeout(() => r({ status: "still waiting" }), ms).unref())]);

test("20. the agent process ended but its poll is still registered: the poll is answered closed, so a Send never goes to nobody", async () => {
  const w = world();
  const s = w.S.open(doc(), { agent: "background" });
  w.R.ensure(s.key);
  await flush();
  const c = w.spawned[0].child;
  c.lines({ type: "system", subtype: "init", session_id: "x" });
  const orphan = w.S.poll(s.key, { holder: bgHolder(s.key) }); // the agent's `onionskin poll` child, still connected
  c.lines({ type: "result", subtype: "success", is_error: false, permission_denials: [] });
  await c.die(0);
  assert.equal((await within(orphan.promise)).status, "closed");
  assert.equal(w.S.state(s) === "listening", false, "nobody is shown as listening");
  // a poll that arrives while no agent process runs for the file is answered closed too
  const late = w.S.poll(s.key, { holder: bgHolder(s.key) });
  assert.equal((await within(late.promise)).status, "closed");
  assert.equal(s.pollers.length, 0);
});

test("21. Close session after a server restart still removes Claude Code's own copy of the conversation", async () => {
  const w = world();
  const s = await stranded(w);
  w.spawned[0].child.lines({ type: "system", subtype: "init", session_id: "x" });
  await w.spawned[0].child.die(null, "SIGTERM");
  const W = path.join(process.env.ONIONSKIN_STATE_DIR, "agents", s.key);
  assert.ok(fs.existsSync(W));
  // a new server: a fresh runner with no memory of that agent
  const w2 = world();
  const s2 = w2.S.open(s.file);
  w2.S.close(s2.key);
  await flush();
  assert.equal(fs.existsSync(W), false);
  assert.ok(w2.execCalls.some(([b, a]) => b.endsWith("/claude") && a[0] === "purge"), "purged although this runner never started it");
});

test("22. Open Terminal to sign in (signed out): a sign-in window opens, nothing is handed over, and Try again stays", async () => {
  const stub = path.join(root, "open-stub-signin.txt");
  const w = world();
  const s = w.S.open(doc(), { agent: "background" });
  w.R.ensure(s.key);
  await flush();
  w.R.entries.get(s.key).failure = { code: "signed_out" };
  w.R.entries.get(s.key).state = "failed";
  const prev = process.env.ONIONSKIN_OPEN_STUB;
  process.env.ONIONSKIN_OPEN_STUB = stub;
  try {
    await w.R.action(s.key, { action: "terminal" });
  } finally {
    if (prev === undefined) delete process.env.ONIONSKIN_OPEN_STUB;
    else process.env.ONIONSKIN_OPEN_STUB = prev;
  }
  const v = w.S.view(s).agent;
  assert.equal(v.state, "failed");
  assert.equal(v.failure.code, "signed_out");
  const f = fs.readFileSync(stub, "utf8").trim();
  const body = fs.readFileSync(f, "utf8");
  assert.match(body, /'auth' 'login'/);
  assert.ok(!/--resume|--session-id|ONIONSKIN_HOLDER|sk-/.test(body), "a sign-in only: no agent, no key");
});

test("23. a fourth document's agent waits, and the page is told another document's agent is busy", async () => {
  const w = world();
  w.R.entries; // limits default to 3
  const keys = [];
  for (let i = 0; i < 4; i++) {
    const s = w.S.open(doc(), { agent: "background" });
    keys.push(s);
    w.R.ensure(s.key);
    await flush();
  }
  assert.equal(w.spawned.length, 3);
  assert.equal(w.S.view(keys[3]).agent.state, "starting");
  assert.equal(w.S.view(keys[3]).agent.busy, true);
  assert.equal(w.S.view(keys[0]).agent.busy, undefined, "only the waiting one");
});

test("24. the background prompt quotes the file and the reply file the way a shell needs (a space in a name is normal)", () => {
  const p = backgroundPrompt({ file: "/Users/patq/My Docs/it's a plan.docx", workDir: "/Users/patq/.onionskin/agents/k", timeout: 590 });
  assert.ok(p.includes("document: `/Users/patq/My Docs/it's a plan.docx`"));
  assert.ok(p.includes(`onionskin poll "/Users/patq/My Docs/it's a plan.docx" --timeout 590`), "double quotes: no '\\'' form, which Claude Code refused once");
  assert.ok(p.includes('--file "/Users/patq/.onionskin/agents/k/reply-<batch_id>.json"'));
  const odd = backgroundPrompt({ file: "/Users/patq/$HOME's.docx", workDir: "/w", timeout: 590 });
  assert.ok(odd.includes(`onionskin poll '/Users/patq/$HOME'\\''s.docx'`), "a $ in the name: single quotes, never expanded");
});

// ---- the page's Stop: POST /api/agent {action: "stop", takeBack: true} ----------------------------------------------------------------
const { sha256 } = await import("../src/fsutil.js");
const code = (c) => (e) => e instanceof HttpError && e.extra?.code === c;

/** A background agent that holds the delivered batch: returns its child and the batch it polled (with the lease). */
async function working(w, { background = true } = {}) {
  const s = w.S.open(doc(), background ? { agent: "background" } : {});
  w.R.ensure(s.key);
  await flush();
  const c = w.spawned.at(-1).child;
  c.lines({ type: "system", subtype: "init", session_id: "x" });
  await flush();
  const p = w.S.poll(s.key, { holder: bgHolder(s.key) });
  w.S.send(s.key, { baseSha: s.baseSha, comments: [comment("c1", 1)], note: "tighten it" });
  const batch = await p.promise;
  assert.equal(w.R.viewFor(s.key).state, "working");
  return { s, c, batch };
}

test("25. today's order is wrong: a plain stop of a working agent puts the batch back to pending (still sent, waiting for an agent)", async () => {
  const w = world();
  const { s, c } = await working(w);
  await w.R.action(s.key, { action: "stop" });
  await c.die(null, "SIGTERM");
  assert.equal(w.S.state(s), "stranded", "requeued through releaseAgent / #expire");
  assert.equal(s.comments[0].status, "sent");
  assert.ok(s.pending);
});

test("26. Stop with takeBack: the batch comes back to drafts FIRST, then the agent is signaled once; nothing is requeued or restarted", async () => {
  const w = world();
  const { s, c, batch } = await working(w);
  const before = fs.readFileSync(s.file);
  // the agent wrote before the Stop: that run stays Revert-able
  const agentBytes = docxBytes(paras.map((x) => x + " (agent)"));
  w.S.agentWrite(s.key, { baseSha: sha256(before), bytes: agentBytes, holder: bgHolder(s.key), token: batch.lease.token, batchId: batch.batch_id });
  await w.R.action(s.key, { action: "stop", takeBack: true });
  assert.equal(w.S.view(s).agent.state, "none", "shown stopped at once, while the process is still exiting");
  assert.equal(s.delivered, null);
  assert.equal(s.pending, null);
  assert.equal(s.comments[0].status, "draft");
  assert.equal(s.note, "tighten it", "the note is back in the box");
  assert.deepEqual(w.signals, [[-c.pid, "SIGTERM"]]);
  const entry = s.activity.find((a) => a.kind === "agent");
  assert.ok(entry?.revertRecommended && entry.flags.some((f) => f.code === "taken_back_mid_run"), "the mid-run write is recorded");
  // the kill window: the stopping agent's late write, apply report, done and next poll are all refused, and the file stays as it was
  const onDisk = fs.readFileSync(s.file);
  const claim = { holder: bgHolder(s.key), token: batch.lease.token, batchId: batch.batch_id };
  assert.throws(() => w.S.agentWrite(s.key, { baseSha: sha256(onDisk), bytes: docxBytes(["late"]), ...claim }), code("not_working"));
  assert.throws(() => w.S.noteApply(s.key, { ...claim, run: "r", problems: [] }), code("not_working"));
  assert.throws(() => w.S.done(s.key, { summary: "late", results: [{ comment_id: "c1", status: "done" }] }, claim), code("no_batch"));
  const late = w.S.poll(s.key, { holder: bgHolder(s.key) });
  assert.equal((await within(late.promise)).status, "closed", "a poll from the stopping agent never takes the next Send");
  assert.deepEqual(fs.readFileSync(s.file), onDisk, "the late calls changed nothing");
  await c.die(null, "SIGTERM");
  assert.equal(w.S.state(s), "idle", "nothing pending: the exit had nothing to hand back");
  assert.equal(w.R.viewFor(s.key).state, "none");
  assert.equal(w.R.viewFor(s.key).failure, null);
  w.advance(5 * 60 * 1000);
  await w.tick();
  assert.equal(w.spawned.length, 1, "no restart until the next Send");
  w.S.revert(s.key, entry.id);
  assert.deepEqual(fs.readFileSync(s.file), before, "Revert restores the pre-agent bytes");
});

test("27. the next Send after a Stop starts a fresh conversation (the withdrawn batch is not in it) at once, without the 20 s grace and without using an hourly start", async () => {
  const w = world();
  const { s, c } = await working(w, { background: false });
  const first = w.spawned[0].argv;
  const id = first[first.indexOf("--session-id") + 1];
  assert.equal(w.R.viewFor(s.key).startsLeft, 4);
  await w.R.action(s.key, { action: "stop", takeBack: true });
  await c.die(null, "SIGTERM");
  w.S.send(s.key, { baseSha: s.baseSha, comments: s.comments, note: "" });
  await flush();
  assert.equal(w.spawned.length, 2, "started at once, although the file was not opened from a terminal");
  const argv = w.spawned[1].argv;
  assert.equal(argv.includes("--resume"), false, "the stopped conversation, which holds the withdrawn batch, is not resumed");
  assert.ok(argv.includes("--session-id"));
  assert.notEqual(argv[argv.indexOf("--session-id") + 1], id, "a new conversation");
  assert.equal(w.R.viewFor(s.key).startsLeft, 4, "not counted");
});

test("28. six Stop-then-Send cycles in an hour never lock the agent out", async () => {
  {
    const w = world();
    const { s, c } = await working(w);
    let child = c;
    for (let i = 0; i < 6; i++) {
      await w.R.action(s.key, { action: "stop", takeBack: true });
      await child.die(null, "SIGTERM");
      w.S.send(s.key, { baseSha: s.baseSha, comments: s.comments, note: "" });
      await flush();
      child = w.spawned.at(-1).child;
      assert.ok(!w.spawned.at(-1).argv.includes("--resume"), `cycle ${i + 1}: a fresh conversation`);
      child.lines({ type: "system", subtype: "init", session_id: "x" });
      await flush();
      const p = w.S.poll(s.key, { holder: bgHolder(s.key) });
      assert.equal((await within(p.promise)).batch_id, s.pending?.batch_id ?? s.delivered.batch.batch_id);
      assert.equal(w.R.viewFor(s.key).state, "working", `cycle ${i + 1}`);
    }
    assert.equal(w.R.viewFor(s.key).failure, null);
    assert.equal(w.R.viewFor(s.key).startsLeft, 4, "only the first start counted");
  }
});

test("29. a Send during the kill window is delivered to the next agent, not the stopping one", async () => {
  const w = world();
  const { s, c } = await working(w);
  const orphan = w.S.poll(s.key, { holder: bgHolder(s.key) }); // its poll child, still connected
  await w.R.action(s.key, { action: "stop", takeBack: true });
  assert.equal((await within(orphan.promise)).status, "closed");
  w.S.send(s.key, { baseSha: s.baseSha, comments: s.comments, note: "" });
  await flush();
  assert.equal(w.S.state(s), "stranded", "nobody took it while the old agent exits");
  assert.equal(w.spawned.length, 1);
  await c.die(null, "SIGTERM");
  assert.equal(w.spawned.length, 2, "started as soon as the old one is gone");
  assert.ok(!w.spawned[1].argv.includes("--resume"), "a fresh conversation");
});

test("30. Stop with nothing running: no signal, no error, and an idle listening agent is left listening", async () => {
  const w = world();
  const s = w.S.open(doc(), { agent: "background" });
  await w.R.action(s.key, { action: "stop", takeBack: true }); // no agent ever started, nothing to take back
  w.R.ensure(s.key);
  await flush();
  const c = w.spawned[0].child;
  c.lines({ type: "system", subtype: "init", session_id: "x" });
  w.S.poll(s.key, { holder: bgHolder(s.key) });
  assert.equal(w.R.viewFor(s.key).state, "ready");
  await w.R.action(s.key, { action: "stop", takeBack: true });
  assert.deepEqual(w.signals, []);
  assert.equal(w.R.viewFor(s.key).state, "ready");
  assert.equal(w.R.viewFor(s.key).failure, null);
  // a Send nobody has polled yet (the agent is still starting): taken back, the starting agent is not signaled
  const w2 = world();
  const s2 = await stranded(w2);
  assert.equal(w2.spawned.length, 1);
  await w2.R.action(s2.key, { action: "stop", takeBack: true });
  assert.equal(s2.pending, null);
  assert.equal(s2.comments[0].status, "draft");
  assert.deepEqual(w2.signals, []);
});

test("31. the person's own agent (external): Stop takes the batch back and signals nothing", async () => {
  const w = world();
  const s = w.S.open(doc(), { agent: "background" });
  const p = w.S.poll(s.key, { holder: "h_person" });
  w.S.send(s.key, { baseSha: s.baseSha, comments: [comment("c1", 1)], note: "" });
  const batch = await p.promise;
  assert.equal(w.R.viewFor(s.key).state, "external");
  await w.R.action(s.key, { action: "stop", takeBack: true });
  assert.deepEqual(w.signals, []);
  assert.equal(w.spawned.length, 0);
  assert.equal(s.delivered, null);
  assert.equal(s.comments[0].status, "draft");
  assert.throws(() => w.S.done(s.key, { summary: "late", results: [] }, { holder: "h_person", token: batch.lease.token, batchId: batch.batch_id }), code("no_batch"));
});

test("32. startsLeft counts the hourly starts left and comes back as the hour rolls", async () => {
  const w = world();
  const s = w.S.open(doc(), { agent: "background" });
  assert.equal(w.S.view(s).agent.startsLeft, 5, "no agent yet");
  w.R.ensure(s.key);
  await flush();
  for (let i = 0; i < 4; i++) {
    await w.spawned.at(-1).child.die(1);
    w.advance(40_000);
    await w.tick();
  }
  assert.equal(w.R.viewFor(s.key).startsLeft, 0);
  w.advance(60 * 60 * 1000);
  assert.equal(w.R.viewFor(s.key).startsLeft, 5);
});

test("33. after a Stop, when the person's own agent takes over, a later Send waits the usual 20 s grace again", async () => {
  const w = world();
  const { s, c } = await working(w, { background: false });
  await w.R.action(s.key, { action: "stop", takeBack: true });
  await c.die(null, "SIGTERM");
  const own = w.S.poll(s.key, { holder: "h_person" });
  w.S.send(s.key, { baseSha: s.baseSha, comments: s.comments, note: "" });
  await own.promise; // the person's agent has the batch
  w.S.takeBack(s.key);
  w.S.send(s.key, { baseSha: s.baseSha, comments: s.comments, note: "" }); // lands between two of its polls
  await flush();
  assert.equal(w.spawned.length, 1, "no shortcut: it may be about to poll again");
  w.advance(20_000);
  await w.tick();
  assert.equal(w.spawned.length, 2, "the grace ran out: the background agent starts");
});

test("34. alive() is false for every stop reason: a Send in the kill window after an idle stop still gets an agent; handover and close leave nothing behind", async () => {
  // idle stop of a background-opened file: the stopping agent's next poll is answered closed, a tab comes back and Sends before the exit
  let open = 0;
  const w = world({ tabs: () => open });
  const s = w.S.open(doc(), { agent: "background" });
  w.R.ensure(s.key);
  await flush();
  const c = w.spawned[0].child;
  c.lines({ type: "system", subtype: "init", session_id: "x" });
  const first = w.S.poll(s.key, { holder: bgHolder(s.key) });
  await w.tick();
  w.advance(20 * 60 * 1000);
  await w.tick();
  assert.equal(w.signals.length, 1, "the idle stop went out");
  first.cancel(); // its poll timed out; the agent polls again while it exits
  assert.equal((await within(w.S.poll(s.key, { holder: bgHolder(s.key) }).promise)).status, "closed");
  open = 1;
  w.S.send(s.key, { baseSha: s.baseSha, comments: [comment("c1", 1)], note: "" });
  await flush();
  assert.equal(w.S.state(s), "stranded", "the stopping agent did not take it");
  assert.equal(w.spawned.length, 1);
  await c.die(null, "SIGTERM");
  assert.equal(w.spawned.length, 2, "an agent starts for the Send once the idle one is gone; the batch is not left waiting");
  assert.equal(w.S.state(s), "stranded", "the batch is still pending, nothing dropped");

  // handover with a batch delivered: the stopping agent's poll is answered closed, and its exit hands the batch back (pending, not lost)
  const w2 = world();
  const { s: s2, c: c2 } = await working(w2);
  const prev = process.env.ONIONSKIN_OPEN_STUB;
  process.env.ONIONSKIN_OPEN_STUB = path.join(root, "open-stub-34.txt");
  try {
    const ho = w2.R.action(s2.key, { action: "terminal" });
    await flush();
    assert.equal(w2.signals.length, 1);
    assert.equal((await within(w2.S.poll(s2.key, { holder: bgHolder(s2.key), ack: true }).promise)).status, "closed", "no new poll during the kill window");
    await c2.die(null, "SIGTERM");
    await ho;
  } finally {
    if (prev === undefined) delete process.env.ONIONSKIN_OPEN_STUB;
    else process.env.ONIONSKIN_OPEN_STUB = prev;
  }
  assert.equal(w2.S.state(s2), "stranded", "the batch is pending again, for the Terminal agent");
  assert.equal(w2.S.view(s2).locked, false, "the page is not left locked by the stopped agent");
  assert.equal(w2.S.view(s2).agent.state, "handover");
  assert.equal(w2.spawned.length, 1, "no background agent starts while it is open in Terminal");

  // close: the stopping agent's poll is closed and nothing restarts
  const w3 = world();
  const { s: s3, c: c3 } = await working(w3);
  w3.S.close(s3.key);
  await flush();
  assert.equal((await within(w3.S.poll(s3.key, { holder: bgHolder(s3.key) }).promise)).status, "closed");
  await c3.die(0);
  assert.equal(w3.spawned.length, 1, "a closed session never restarts its agent");
});

test("35. a Send taken by an idle-stopped agent in its kill window (file not opened for it) is not stranded: it gets the 20 s grace, then an agent", async () => {
  const w = world();
  const s = w.S.open(doc());
  w.R.ensure(s.key);
  await flush();
  const c = w.spawned[0].child;
  c.lines({ type: "system", subtype: "init", session_id: "x" });
  await flush();
  w.S.poll(s.key, { holder: bgHolder(s.key) }); // its poll waits
  await w.tick();
  w.advance(20 * 60 * 1000);
  await w.tick();
  assert.equal(w.signals.length, 1, "the idle stop went out");
  w.S.send(s.key, { baseSha: s.baseSha, comments: [comment("c1", 1)], note: "" }); // the dying agent's poll takes it
  await flush();
  await c.die(null, "SIGTERM");
  assert.equal(w.S.state(s), "stranded", "the batch is pending again");
  assert.equal(w.spawned.length, 1);
  w.advance(20_000);
  await w.tick();
  assert.equal(w.spawned.length, 2, "after the grace, an agent starts for it");
});
