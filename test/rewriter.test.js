import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { tmpdir } from "./helpers/zipbuild.js";
import { spawnSync } from "node:child_process";
import { APPLE_STATES, QUARANTINE, REWRITER_DIR, appleHelperState, appleStateLine, clearQuarantine, createWorker, fileSha256, getRewriter, isQuarantined, readRewriterConfig, rewriterPaths, rewriterStatus, sandboxed, stopRewriter, workerEnv } from "../src/rewriter.js";

// The local rewriter's seam and worker (src/rewriter.js). A fake worker process (test/helpers/fake-rewriter-worker.mjs) speaks the real
// JSON-lines protocol, so spawning, warming up, timeouts, idle stop and a dying worker all run for real; there is no model and no network.
const root = tmpdir("rw-");
after(() => {
  stopRewriter();
  fs.rmSync(root, { recursive: true, force: true });
});
const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(here, "helpers", "fake-rewriter-worker.mjs");
const launch = (...args) => ({ cmd: process.execPath, args: [FAKE, ...args], env: { PATH: "/usr/bin:/bin" }, cwd: root });
let n = 0;
const freshState = () => {
  const d = path.join(root, `state${n++}`);
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  process.env.ONIONSKIN_STATE_DIR = d;
  delete process.env.ONIONSKIN_REWRITER_STUB;
  return d;
};
const waitReady = async (w, ms = 5000) => {
  const until = Date.now() + ms;
  for (;;) {
    const r = await w.rewrite("shorter", "Send the report.");
    if (r.code !== "warming_up") return r;
    assert.ok(Date.now() < until, "the worker never became ready");
    await new Promise((res) => setTimeout(res, 20));
  }
};
/** Polls until the model is loaded, without sending anything. */
const loaded = async (w, ms = 5000) => {
  const until = Date.now() + ms;
  while (!w.ready) {
    assert.ok(Date.now() < until, "the worker never became ready");
    await new Promise((res) => setTimeout(res, 20));
  }
};
const wait = (ms) => new Promise((res) => setTimeout(res, ms));
/** Polls until the worker has given up (answers unavailable) instead of guessing how long a process takes to start on a busy machine. */
const givenUp = async (w, ms = 15_000) => {
  const until = Date.now() + ms;
  for (;;) {
    const r = await w.rewrite("shorter", "Hello.");
    if (r.code !== "warming_up") return r;
    assert.ok(Date.now() < until, "the worker never gave up: still warming up");
    await wait(20);
  }
};

test("the first request starts the worker and goes to the agent; once the model is loaded, requests are answered", async () => {
  const w = createWorker(launch("startup", "300"));
  try {
    assert.deepEqual(await w.rewrite("shorter", "Send the report."), { ok: false, code: "warming_up" });
    assert.deepEqual(await w.rewrite("shorter", "Send the report."), { ok: false, code: "warming_up" }, "still loading: still the agent, and no second process");
    const r = await waitReady(w);
    assert.deepEqual(r, { ok: true, text: "SEND THE REPORT." });
    assert.equal(w.ready, true);
  } finally {
    w.close();
  }
});

test("a worker that is already warm answers each of the three tasks, one at a time", async () => {
  const w = createWorker(launch("ok"));
  try {
    w.warm();
    await waitReady(w);
    for (const t of ["shorter", "friendlier", "grammar"]) assert.equal((await w.rewrite(t, "Hello there.")).text, "HELLO THERE.");
    const two = await Promise.all([w.rewrite("shorter", "One."), w.rewrite("shorter", "Two.")]);
    assert.deepEqual(two.map((r) => r.code ?? "ok").sort(), ["busy", "ok"], "a second request while one is running goes to the agent");
  } finally {
    w.close();
  }
});

test("bad input never reaches the worker: unknown task, empty text, text over 1000 characters", async () => {
  const w = createWorker(launch("ok"));
  try {
    assert.deepEqual(await w.rewrite("translate", "Hello."), { ok: false, code: "bad_task" });
    assert.deepEqual(await w.rewrite("shorter", "   "), { ok: false, code: "bad_text" });
    assert.deepEqual(await w.rewrite("shorter", 5), { ok: false, code: "bad_text" });
    assert.deepEqual(await w.rewrite("shorter", "x".repeat(1001)), { ok: false, code: "bad_text" });
    assert.equal(w.ready, false, "nothing was started for bad input to a stopped worker");
  } finally {
    w.close();
  }
});

test("a slow answer is a timeout; the worker stays busy until it answers, then works again", async () => {
  const w = createWorker(launch("slow", "400"));
  try {
    w.warm();
    await loaded(w);
    const t0 = Date.now();
    assert.deepEqual(await w.rewrite("shorter", "Late answer.", { timeoutMs: 100 }), { ok: false, code: "timeout" });
    assert.ok(Date.now() - t0 < 350, "gave up at the limit, not when the worker answered");
    assert.deepEqual(await w.rewrite("shorter", "Next one.", { timeoutMs: 100 }), { ok: false, code: "busy" });
    await wait(500);
    assert.equal((await w.rewrite("shorter", "Next one.", { timeoutMs: 2000 })).text, "NEXT ONE.", "the late answer was dropped, not given to the next request");
  } finally {
    w.close();
  }
});

test("a worker that never answers is stopped after the stuck limit and starts cold again", async () => {
  const w = createWorker(launch("never"), { stuckMs: 150 });
  try {
    w.warm();
    await loaded(w);
    assert.deepEqual(await w.rewrite("shorter", "Hello.", { timeoutMs: 50 }), { ok: false, code: "timeout" });
    await wait(400);
    assert.equal(w.ready, false, "killed");
  } finally {
    w.close();
  }
});

test("idle: the worker stops by itself, the next request starts it again", async () => {
  const w = createWorker(launch("ok"), { idleMs: 200 });
  try {
    w.warm();
    await waitReady(w);
    assert.equal(w.ready, true);
    await wait(500);
    assert.equal(w.ready, false, "stopped after the idle time");
    assert.deepEqual(await w.rewrite("shorter", "Hello."), { ok: false, code: "warming_up" });
    assert.equal((await waitReady(w)).ok, true);
  } finally {
    w.close();
  }
});

test("each answer restarts the idle clock", async () => {
  const w = createWorker(launch("ok"), { idleMs: 300 });
  try {
    w.warm();
    await waitReady(w);
    for (let i = 0; i < 4; i++) {
      await wait(150);
      assert.equal((await w.rewrite("shorter", "Hello.")).ok, true);
    }
    assert.equal(w.ready, true, "600 ms of use kept a 300 ms idle limit away");
  } finally {
    w.close();
  }
});

test("close stops the worker and a request waiting on it is answered, not left hanging", async () => {
  const w = createWorker(launch("slow", "5000"));
  w.warm();
  await loaded(w);
  const pending = w.rewrite("shorter", "Hello.", { timeoutMs: 10_000 });
  await wait(50);
  w.close();
  assert.deepEqual(await pending, { ok: false, code: "worker_exited" });
  assert.equal(w.ready, false);
});

test("a worker that dies mid-request answers worker_exited; one that cannot start is unavailable and is not respawned in a loop", async () => {
  const w = createWorker(launch("crash"), { retryMs: 60_000 });
  try {
    w.warm();
    await loaded(w);
    assert.deepEqual(await w.rewrite("shorter", "Hello."), { ok: false, code: "worker_exited" });
    assert.equal(w.ready, false);
    assert.deepEqual(await w.rewrite("shorter", "Hello."), { ok: false, code: "warming_up" }, "a worker that died after being ready is started again by the next request");
  } finally {
    w.close();
  }
  const bad = createWorker(launch("notready"), { retryMs: 60_000 });
  try {
    bad.warm();
    assert.deepEqual(await givenUp(bad), { ok: false, code: "unavailable" }, "ready:false means off for a minute, not a respawn per request");
    assert.deepEqual(await bad.rewrite("shorter", "Hello."), { ok: false, code: "unavailable" }, "and it stays off");
  } finally {
    bad.close();
  }
  const missing = createWorker({ cmd: path.join(root, "no-such-binary"), args: [] }, { retryMs: 60_000 });
  try {
    missing.warm();
    assert.deepEqual(await givenUp(missing), { ok: false, code: "unavailable" });
  } finally {
    missing.close();
  }
});

test("the worker's own refusal is passed on as a code; an answer over the size limit, junk lines and a line that never ends are not trusted", async () => {
  const refuse = createWorker(launch("refuse"));
  try {
    refuse.warm();
    assert.deepEqual(await waitReady(refuse), { ok: false, code: "refused", reason: "May contain unsafe content" }, "a refusal stays a refusal, with the framework's words");
  } finally {
    refuse.close();
  }
  const huge = createWorker(launch("huge"));
  try {
    huge.warm();
    assert.deepEqual(await waitReady(huge), { ok: false, code: "bad_output" });
  } finally {
    huge.close();
  }
  const junk = createWorker(launch("garbage"));
  try {
    junk.warm();
    assert.equal((await waitReady(junk)).text, "SEND THE REPORT.", "a non-JSON line is skipped");
  } finally {
    junk.close();
  }
  const flood = createWorker(launch("flood"), { retryMs: 60_000 });
  try {
    flood.warm();
    assert.deepEqual(await givenUp(flood), { ok: false, code: "unavailable" });
  } finally {
    flood.close();
  }
});

test("a worker that says why it cannot start (Apple's three reasons) is answered with that reason until the next try", async () => {
  for (const code of ["device_not_eligible", "apple_intelligence_not_enabled", "model_not_ready"]) {
    const w = createWorker(launch("notready", code), { retryMs: 60_000 });
    try {
      w.warm();
      assert.deepEqual(await givenUp(w), { ok: false, code });
      assert.equal(w.startCode, code);
    } finally {
      w.close();
    }
  }
  // a later start that works, begun by warm(), clears the reason (the bootstrap must not keep saying it)
  const once = createWorker(launch("notreadyonce", path.join(root, "started-once")), { retryMs: 100 });
  try {
    once.warm();
    assert.deepEqual(await givenUp(once), { ok: false, code: "apple_intelligence_not_enabled" });
    const until = Date.now() + 15_000;
    while (!once.ready) {
      assert.ok(Date.now() < until, "the second start never became ready");
      once.warm();
      await wait(20);
    }
    assert.equal(once.startCode, null);
  } finally {
    once.close();
  }
  const other = createWorker(launch("notready", "Some Thing!"), { retryMs: 60_000 });
  try {
    other.warm();
    assert.deepEqual(await givenUp(other), { ok: false, code: "unavailable" }, "any other code is not passed on");
  } finally {
    other.close();
  }
});

test("a worker that never says ready is given up on at the start limit", async () => {
  const w = createWorker(launch("startup", "5000"), { startMs: 150, retryMs: 60_000 });
  try {
    w.warm();
    await wait(400);
    assert.deepEqual(await w.rewrite("shorter", "Hello."), { ok: false, code: "unavailable" });
  } finally {
    w.close();
  }
});

// ---- the test stand-in ----------------------------------------------------------------------------------------------------
test("stub back end: maps a sentence (or task and sentence) to its rewrite, and reads the file on every call", async () => {
  const state = freshState();
  const stub = path.join(state, "stub.json");
  process.env.ONIONSKIN_REWRITER_STUB = stub;
  try {
    fs.writeFileSync(stub, JSON.stringify({ "Send the report to me by Friday.": "Send me the report by Friday.", "shorter\tHello there my friend.": "Hello.", "Slow one.": { text: "Quick.", delayMs: 300 }, "Odd one.": { code: "refused" } }));
    const rw = getRewriter();
    assert.equal(rw.backend, "stub");
    assert.deepEqual(await rw.rewrite("shorter", "Send the report to me by Friday."), { ok: true, text: "Send me the report by Friday." });
    assert.deepEqual(await rw.rewrite("shorter", "Hello there my friend."), { ok: true, text: "Hello." });
    assert.deepEqual(await rw.rewrite("friendlier", "Hello there my friend."), { ok: false, code: "no_stub" }, "the task-keyed entry is for shorter only");
    assert.deepEqual(await rw.rewrite("shorter", "Odd one."), { ok: false, code: "refused" });
    assert.deepEqual(await rw.rewrite("shorter", "Slow one.", { timeoutMs: 50 }), { ok: false, code: "timeout" });
    assert.deepEqual(await rw.rewrite("shorter", "Slow one.", { timeoutMs: 2000 }), { ok: true, text: "Quick." });
    assert.deepEqual(await rw.rewrite("translate", "Hello."), { ok: false, code: "bad_task" });
    assert.deepEqual(await rw.rewrite("shorter", "constructor"), { ok: false, code: "no_stub" }, "inherited object keys are not entries");
    fs.writeFileSync(stub, JSON.stringify({ "Send the report to me by Friday.": "Changed." }));
    assert.equal((await rw.rewrite("shorter", "Send the report to me by Friday.")).text, "Changed.");
    fs.rmSync(stub);
    assert.deepEqual(await rw.rewrite("shorter", "Send the report to me by Friday."), { ok: false, code: "unavailable" });
    assert.equal(rewriterStatus().on, true);
  } finally {
    delete process.env.ONIONSKIN_REWRITER_STUB;
  }
});

// ---- the configuration file --------------------------------------------------------------------------------------------------
test("not set up: getRewriter is null and the status says why", () => {
  freshState();
  assert.equal(getRewriter(), null);
  assert.deepEqual(rewriterStatus(), { on: false, reason: "not_set_up" });
  fs.writeFileSync(rewriterPaths().config, "{nope");
  assert.equal(getRewriter(), null, "a broken file reads as off");
});

test("a settings file of the older Granite download reads as off (setup removes the old files), and starts nothing", () => {
  const state = freshState();
  fs.writeFileSync(rewriterPaths(state).config, JSON.stringify({ backend: "mlx", model: "granite", dir: path.join(state, "models", "granite"), sha256: "0".repeat(64) }));
  assert.deepEqual(rewriterStatus(), { on: false, reason: "unknown_backend" });
  assert.equal(getRewriter(), null);
  fs.writeFileSync(rewriterPaths(state).config, JSON.stringify({ backend: "apple", model: "granite" }));
  assert.equal(readRewriterConfig().reason, "config_mismatch");
});

/** A stand-in for the shipped helper: <dir>/onionskin-fm (a script that writes a marker file if it is ever run) and onionskin-fm.json with its hash. */
function fakeHelper(name, { mode = 0o755 } = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, "onionskin-fm");
  const ran = path.join(dir, "RAN");
  fs.writeFileSync(bin, `#!/bin/sh\necho ran > "${ran}"\n`, { mode });
  fs.writeFileSync(path.join(dir, "onionskin-fm.json"), JSON.stringify({ file: "onionskin-fm", sha256: fileSha256(bin) }));
  return { dir, bin, ran };
}
const NEW_MAC = { macos: "26.1", appleSilicon: true };

test("apple config: the helper of this app copy runs in place when its hash matches the shipped onionskin-fm.json", () => {
  const state = freshState();
  const p = rewriterPaths(state);
  const { dir, bin } = fakeHelper("helper-ok");
  const apple = { dir, host: NEW_MAC, quarantined: () => false };
  fs.writeFileSync(p.config, JSON.stringify({ backend: "apple", model: "apple", sha256: "from an older setup" }));
  const c = readRewriterConfig(undefined, apple);
  assert.equal(c.ok, true, JSON.stringify(c));
  assert.equal(c.launch.cmd, bin, "run from the app folder, never a copy in the state folder");
  assert.deepEqual(rewriterStatus(undefined, apple), { on: true, name: "Apple's built-in model", backend: "apple" });
  fs.writeFileSync(bin, "#!/bin/sh\necho replaced\n", { mode: 0o755 });
  assert.equal(readRewriterConfig(undefined, apple).reason, "helper_changed");
  fs.rmSync(bin);
  assert.equal(readRewriterConfig(undefined, apple).reason, "helper_missing");
  assert.equal(getRewriter(apple), null);
});

test("appleHelperState: macOS 26, Apple silicon, the helper and its hash, then the quarantine mark, all decided without running it", () => {
  const { dir, ran } = fakeHelper("helper-gate");
  let asked = 0;
  const q = (v) => () => (asked++, v);
  assert.deepEqual(appleHelperState({ dir, host: { macos: "15.7", appleSilicon: true }, quarantined: q(false) }), { ok: false, reason: "macos_too_old" });
  assert.deepEqual(appleHelperState({ dir, host: { macos: null, appleSilicon: false }, quarantined: q(false) }), { ok: false, reason: "macos_too_old" }, "an unknown version is not 26");
  assert.deepEqual(appleHelperState({ dir, host: { macos: "26.0", appleSilicon: false }, quarantined: q(false) }), { ok: false, reason: "device_not_eligible" });
  assert.deepEqual(appleHelperState({ dir: path.join(root, "nowhere"), host: NEW_MAC, quarantined: q(false) }), { ok: false, reason: "helper_missing" });
  assert.equal(asked, 0, "the mark is only asked about for a helper that passed the other checks");
  assert.deepEqual(appleHelperState({ dir, host: NEW_MAC, quarantined: q(true) }), { ok: false, reason: "quarantined", bin: path.join(dir, "onionskin-fm") });
  assert.equal(appleHelperState({ dir, host: { macos: "27.2", appleSilicon: true }, quarantined: q(false) }).ok, true);
  assert.equal(fs.existsSync(ran), false, "the helper was never run");
  // every reason a person can be shown has a plain line, and helper_changed reads as missing or damaged
  for (const k of ["macos_too_old", "device_not_eligible", "apple_intelligence_not_enabled", "model_not_ready", "quarantined", "helper_missing"]) assert.ok(APPLE_STATES[k] && !/[\u2014]/.test(APPLE_STATES[k]), k);
  assert.equal(appleStateLine("helper_changed"), APPLE_STATES.helper_missing);
  assert.equal(APPLE_STATES.macos_too_old, "Quick fixes need macOS 26 or later.");
  assert.equal(APPLE_STATES.device_not_eligible, "This Mac cannot run Apple's on-device writing model.");
  assert.equal(APPLE_STATES.apple_intelligence_not_enabled, "Turn on Apple Intelligence in System Settings to get quick spelling and grammar fixes.");
  assert.equal(APPLE_STATES.model_not_ready, "Apple's writing model is still getting ready. Try again in a few minutes.");
});

test("the quarantine mark: read with /usr/bin/xattr and removed from exactly that file (a plain file that is never run)", () => {
  const dir = path.join(root, "marked");
  fs.mkdirSync(dir, { recursive: true });
  const a = path.join(dir, "a.txt");
  const b = path.join(dir, "b.txt");
  for (const f of [a, b]) fs.writeFileSync(f, "not a program\n", { mode: 0o644 });
  const mark = (f) => assert.equal(spawnSync("/usr/bin/xattr", ["-w", QUARANTINE, "0081;00000000;Safari;", f]).status, 0);
  mark(a);
  mark(b);
  assert.equal(isQuarantined(a), true);
  assert.equal(clearQuarantine(a), true);
  assert.equal(isQuarantined(a), false);
  assert.equal(isQuarantined(b), true, "the other file keeps its mark");
  assert.equal(clearQuarantine(a), true, "a file without the mark is fine (no such attribute)");
  assert.equal(isQuarantined(path.join(dir, "missing")), true, "an answer that is not a clean no counts as marked");
});

test("the server never starts a helper that still carries the mark: getRewriter is null and the status says why", () => {
  const state = freshState();
  const { dir, ran } = fakeHelper("helper-marked");
  fs.writeFileSync(rewriterPaths(state).config, JSON.stringify({ backend: "apple", model: "apple" }));
  const apple = { dir, host: NEW_MAC, quarantined: () => true };
  assert.equal(getRewriter(apple), null);
  assert.deepEqual(rewriterStatus(undefined, apple), { on: false, reason: "quarantined" });
  assert.equal(getRewriter({ ...apple, host: { macos: "15.1", appleSilicon: true } }), null);
  assert.deepEqual(rewriterStatus(undefined, { ...apple, host: { macos: "15.1", appleSilicon: true } }), { on: false, reason: "macos_too_old" });
  assert.equal(fs.existsSync(ran), false, "nothing was started");
});

test("getRewriter keeps one worker per configuration and stops it when the setup is removed", () => {
  const state = freshState();
  const { dir } = fakeHelper("helper-one");
  const apple = { dir, host: NEW_MAC, quarantined: () => false };
  fs.writeFileSync(rewriterPaths(state).config, JSON.stringify({ backend: "apple", model: "apple" }));
  const a = getRewriter(apple);
  assert.ok(a && a.backend === "apple");
  assert.ok(getRewriter(apple), "a second call is cheap and reuses the worker");
  fs.rmSync(rewriterPaths().config);
  assert.equal(getRewriter(apple), null);
  stopRewriter();
});

// ---- environment and sandbox ----------------------------------------------------------------------------------------------
test("the worker gets a minimal environment and none of the server's", () => {
  freshState();
  process.env.ONIONSKIN_SECRET_FOR_TEST = "hunter2";
  process.env.ANTHROPIC_API_KEY = "sk-test";
  try {
    const e = workerEnv();
    assert.deepEqual(Object.keys(e).sort(), ["HOME", "PATH", "TMPDIR"]);
    assert.equal(e.HOME, process.env.ONIONSKIN_STATE_DIR);
    assert.deepEqual(Object.keys(e).filter((k) => /KEY|SECRET|TOKEN|ONIONSKIN/.test(k)), []);
    assert.ok(!JSON.stringify(e).includes("hunter2") && !JSON.stringify(e).includes("sk-test"));
  } finally {
    delete process.env.ONIONSKIN_SECRET_FOR_TEST;
    delete process.env.ANTHROPIC_API_KEY;
  }
});

test("sandboxed(): wraps the command with the network denied, or leaves it alone when sandbox-exec is missing", () => {
  const [cmd, args] = sandboxed("/x/python", ["-I", "a.py"], process.execPath);
  assert.equal(cmd, process.execPath);
  assert.deepEqual(args.slice(0, 1), ["-p"]);
  assert.match(args[1], /\(deny network\*\)/);
  assert.deepEqual(args.slice(2), ["/x/python", "-I", "a.py"]);
  assert.deepEqual(sandboxed("/x/python", ["-I"], path.join(root, "no-sandbox-exec")), ["/x/python", ["-I"]]);
});

// ---- the two back ends say the same thing ---------------------------------------------------------------------------------
test("the fixed instructions: Swift's Fix grammar is the tuned benchmark prompt (r3-plain)", () => {
  const swift = fs.readFileSync(path.join(REWRITER_DIR, "apple", "main.swift"), "utf8");
  // the text of a string literal as it is written in source: JSON escaping is the same in Python and Swift for these strings
  const lit = (s) => JSON.stringify(s).slice(1, -1);
  const sets = path.join(REWRITER_DIR, "..", "rewriter-eval", "prompts");
  // Apple: the grammar benchmark's tuned prompt, as constants (the --prompts loader is for the evaluation scripts only), and Fix grammar is its one task
  const r3 = JSON.parse(fs.readFileSync(path.join(REWRITER_DIR, "..", "rewriter-eval", "grammar", "fm", "prompts", "r3-plain.json"), "utf8"));
  assert.ok(swift.includes(`var system = "${lit(r3.system)}"\n`), "r3 system text");
  assert.ok(swift.includes(`"grammar": "${lit(r3.instruction)}",`), "r3 grammar instruction");
  assert.equal(r3.shots.length, 12);
  const block = swift.slice(swift.indexOf("var shots"), swift.indexOf("var options"));
  assert.equal(block, `var shots: [String: [[String]]] = [\n  "grammar": [\n${r3.shots.map(([a, b]) => `    ["${lit(a)}", "${lit(b)}"],\n`).join("")}  ],\n]\n`, "exactly the 12 examples, in order");
  assert.ok(swift.includes(`maximumResponseTokens: ${r3.maxTokens})`) && r3.maxTokens === 160, "160 response tokens");
  assert.ok(!/"shorter"|"friendlier"/.test(swift), "the helper offers no other task");
  // the prompt sets never contain a sentence of the evaluation set (so the held-out score means something): every set that is checked in
  const evalSet = JSON.parse(fs.readFileSync(path.join(REWRITER_DIR, "..", "rewriter-eval", "sentences.json"), "utf8")).sentences;
  const all = fs.readdirSync(sets).filter((f) => f.endsWith(".json")).flatMap((f) => Object.values(JSON.parse(fs.readFileSync(path.join(sets, f), "utf8")).shots).flat(2));
  for (const s of evalSet) for (const t of [s.text, s.fixed].filter(Boolean)) assert.ok(!all.some((x) => x.includes(t) || t.includes(x)), `an example repeats ${s.id}`);
  // and the benchmark's 160 sentences are not among the shipped examples either
  const bench = JSON.parse(fs.readFileSync(path.join(REWRITER_DIR, "..", "rewriter-eval", "grammar", "set.json"), "utf8"));
  const benchInputs = (Array.isArray(bench) ? bench : bench.items ?? bench.sentences ?? []).map((x) => x.input).filter(Boolean);
  assert.ok(benchInputs.length >= 160, `${benchInputs.length} benchmark sentences`);
  for (const t of benchInputs) assert.ok(!r3.shots.flat().includes(t), `a shipped example is a benchmark sentence: ${t}`);
  assert.equal(evalSet.filter((s) => s.split === "holdout").length, 30);
  assert.equal(evalSet.filter((s) => s.split === "holdout" && s.errors).length, 10);
  assert.equal(evalSet.filter((s) => s.features.includes("badnews")).length, 5);
});

test("the test-only variables point appleHelperState at a stand-in folder and a macOS version (the browser tests rely on them)", () => {
  const dir = path.join(root, "env-fm");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "onionskin-fm"), "stand-in");
  fs.writeFileSync(path.join(dir, "onionskin-fm.json"), JSON.stringify({ sha256: fileSha256(path.join(dir, "onionskin-fm")) }));
  process.env.ONIONSKIN_APPLE_HELPER_DIR = dir;
  try {
    assert.deepEqual(appleHelperState({ host: { macos: "26.1", appleSilicon: true }, quarantined: () => false }), { ok: true, bin: path.join(dir, "onionskin-fm"), sha256: fileSha256(path.join(dir, "onionskin-fm")) });
  } finally {
    delete process.env.ONIONSKIN_APPLE_HELPER_DIR;
  }
});
