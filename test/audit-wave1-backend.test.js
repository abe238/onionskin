import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { PassThrough } from "node:stream";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { tmpdir, docxBytes } from "./helpers/zipbuild.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = fs.realpathSync(tmpdir("audit-w1b-"));
const state = path.join(root, "st");
const dist = path.join(root, "dist");
fs.mkdirSync(state, { recursive: true, mode: 0o700 });
fs.mkdirSync(dist, { recursive: true });
fs.writeFileSync(path.join(dist, "index.html"), "<!doctype html><title>t</title>");
fs.writeFileSync(path.join(dist, "app.js"), "console.log('ok');");

process.env.ONIONSKIN_STATE_DIR = state;
process.env.ONIONSKIN_WEB_DIST = dist;
process.env.ONIONSKIN_TICK_MS = "100000";
process.env.ONIONSKIN_NO_SOFFICE = "1";
process.env.ONIONSKIN_LEASE_MS = "5000";
delete process.env.ONIONSKIN_PYTHON;

const { startServer } = await import("../src/server.js");
const { Sessions } = await import("../src/session.js");
const { ensureStateDir, socketPath } = await import("../src/paths.js");
const { agentRunner } = await import("../src/agent-runner.js");
ensureStateDir();

const children = [];
after(() => {
  for (const c of children) {
    try {
      c.kill("SIGKILL");
    } catch {}
  }
  fs.rmSync(root, { recursive: true, force: true });
});

const flush = async () => {
  for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r));
};

const paras = Array.from({ length: 6 }, (_, i) => `Paragraph ${i + 1}: sentence ${i}.`);
let docN = 0;
const makeDoc = (dir = root) => {
  const f = path.join(dir, `doc-${++docN}.docx`);
  fs.writeFileSync(f, docxBytes(paras));
  return fs.realpathSync(f);
};
const comment = (id, i, text = "fix") => ({ id, kind: "element", text, anchor: { location: { blockPath: [i] }, paraText: paras[i] } });

function runNode(scriptPath, args, env) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [scriptPath, ...args], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    children.push(c);
    let stdout = "";
    let stderr = "";
    c.stdout.on("data", (d) => (stdout += d));
    c.stderr.on("data", (d) => (stderr += d));
    c.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test("BE-01 & BE-20: server-entry calls srv.shutdown() on SIGTERM and shutdown() is idempotent", async () => {
  const st = path.join(root, "st-be01");
  fs.mkdirSync(st, { recursive: true, mode: 0o700 });
  const env = { ...process.env, ONIONSKIN_STATE_DIR: st, ONIONSKIN_WEB_DIST: dist, ONIONSKIN_TICK_MS: "100000", ONIONSKIN_NO_SOFFICE: "1" };

  // BE-20: SIGTERM triggers graceful shutdown (unlinks socket and server.json)
  const c = spawn(process.execPath, [path.join(repo, "src", "server-entry.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(c);
  await new Promise((resolve, reject) => {
    let out = "";
    const to = setTimeout(() => reject(new Error("server-entry timed out")), 10000);
    c.stdout.on("data", (d) => {
      out += d;
      if (out.includes("ready")) {
        clearTimeout(to);
        resolve();
      }
    });
    c.on("exit", (code) => {
      clearTimeout(to);
      reject(new Error(`exited early with ${code}`));
    });
  });
  assert.ok(fs.existsSync(path.join(st, "s.sock")));
  assert.ok(fs.existsSync(path.join(st, "server.json")));
  const exited = new Promise((resolve) => c.once("exit", (code, signal) => resolve({ code, signal })));
  c.kill("SIGTERM");
  const res = await exited;
  assert.equal(res.code, 0);
  assert.equal(fs.existsSync(path.join(st, "s.sock")), false, "shutdown unlinked s.sock on SIGTERM");
  assert.equal(fs.existsSync(path.join(st, "server.json")), false, "shutdown unlinked server.json on SIGTERM");
});

test("BE-01: shutdown() idempotency verified in child process", async () => {
  const st2 = path.join(root, "st-be01-idem");
  fs.mkdirSync(st2, { recursive: true, mode: 0o700 });
  const code = `
    import assert from "node:assert/strict";
    import { startServer } from ${JSON.stringify(path.join(repo, "src", "server.js"))};
    const srv = await startServer();
    let stopAllCalls = 0;
    const orig = srv.agent.stopAll.bind(srv.agent);
    srv.agent.stopAll = () => { stopAllCalls++; return orig(); };
    srv.shutdown();
    srv.shutdown();
    assert.equal(stopAllCalls, 1);
    console.log("IDEMPOTENT_OK");
  `;
  const r = await new Promise((resolve) => {
    const c = spawn(process.execPath, ["--input-type=module", "-e", code], {
      env: { ...process.env, ONIONSKIN_STATE_DIR: st2, ONIONSKIN_WEB_DIST: dist, ONIONSKIN_TICK_MS: "100000", ONIONSKIN_NO_SOFFICE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(c);
    let stdout = "";
    let stderr = "";
    c.stdout.on("data", (d) => (stdout += d));
    c.stderr.on("data", (d) => (stderr += d));
    c.on("close", (cCode) => resolve({ code: cCode, stdout, stderr }));
  });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes("IDEMPOTENT_OK"));
});

test("BE-02 & BE-10 (withStartLock): stale empty/invalid start.lock is evicted; serveStatic blocks symlink escape and handles stream errors", async () => {
  const st = path.join(root, "st-be02");
  fs.mkdirSync(st, { recursive: true, mode: 0o700 });
  // BE-10: write an empty start.lock and backdate it > 2s (also tests invalid pid=0 doesn't process.kill(0,0))
  const lock = path.join(st, "start.lock");
  fs.writeFileSync(lock, "");
  const oldTime = new Date(Date.now() - 5000);
  fs.utimesSync(lock, oldTime, oldTime);

  const outside = path.join(root, "outside-secret.txt");
  fs.writeFileSync(outside, "TOP_SECRET");
  fs.symlinkSync(outside, path.join(dist, "escape.txt"));
  fs.symlinkSync(path.join(dist, "app.js"), path.join(dist, "alias.js"));
  const unreadable = path.join(dist, "unreadable.js");
  fs.writeFileSync(unreadable, "secret");
  fs.chmodSync(unreadable, 0o000);

  // Run server + HTTP checks in a child script so srv.shutdown() exiting at 50ms doesn't affect test runner
  const script = `
    import assert from "node:assert/strict";
    import http from "node:http";
    import { startServer } from ${JSON.stringify(path.join(repo, "src", "server.js"))};
    const srv = await startServer();
    const req = (p, cookie) => new Promise((resolve, reject) => {
      const r = http.request({ host: "127.0.0.1", port: srv.port, method: "GET", path: p, headers: cookie ? { cookie } : {} }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
        res.on("error", () => resolve({ status: res.statusCode, headers: res.headers, destroyed: true }));
      });
      r.on("error", () => resolve({ destroyed: true }));
      r.end();
    });
    const nonce = srv.auth.newNonce();
    const boot = await req("/?n=" + nonce);
    const cookie = boot.headers["set-cookie"][0].split(";")[0];

    const esc = await req("/escape.txt", cookie);
    assert.equal(esc.status, 403, "symlink escaping WEB_DIST must be forbidden");
    assert.equal(esc.text, "forbidden");

    const ok = await req("/alias.js", cookie);
    assert.equal(ok.status, 200, "symlink staying inside WEB_DIST is allowed");
    assert.equal(ok.text, "console.log('ok');");

    const miss = await req("/does-not-exist.js", cookie);
    assert.equal(miss.status, 404);

    // Stream error (EACCES on 0o000 file) is handled without crashing the server
    await req("/unreadable.js", cookie);
    const stillAlive = await req("/app.js", cookie);
    assert.equal(stillAlive.status, 200);

    console.log("STATIC_AND_LOCK_OK");
    srv.shutdown();
  `;
  const r = await new Promise((resolve) => {
    const c = spawn(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, ONIONSKIN_STATE_DIR: st, ONIONSKIN_WEB_DIST: dist, ONIONSKIN_TICK_MS: "100000", ONIONSKIN_NO_SOFFICE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(c);
    let stdout = "";
    let stderr = "";
    c.stdout.on("data", (d) => (stdout += d));
    c.stderr.on("data", (d) => (stderr += d));
    c.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes("STATIC_AND_LOCK_OK"));
});

test("BE-10 (removeStaleSocket): cli.js ignores pid <= 0 in server.json/start.lock and unlinks stale socket", async () => {
  const st = path.join(root, "st-be10-cli");
  fs.mkdirSync(st, { recursive: true, mode: 0o700 });
  const sock = path.join(st, "s.sock");

  // Create an ECONNREFUSED socket by binding and SIGKILLing a helper process
  const dead = spawn(process.execPath, ["-e", `require("net").createServer().listen(${JSON.stringify(sock)}, () => console.log("up"))`], { stdio: ["ignore", "pipe", "ignore"] });
  children.push(dead);
  await new Promise((r) => dead.stdout.once("data", r));
  dead.kill("SIGKILL");
  await new Promise((r) => dead.on("exit", r));
  assert.ok(fs.existsSync(sock));

  fs.writeFileSync(path.join(st, "server.json"), JSON.stringify({ pid: 0, port: 1234, protocol: 1 }));
  const lock = path.join(st, "start.lock");
  fs.writeFileSync(lock, "-1");
  const old = new Date(Date.now() - 5000);
  fs.utimesSync(lock, old, old);

  const res = await runNode(path.join(repo, "src", "cli.js"), ["stop"], { ONIONSKIN_STATE_DIR: st, ONIONSKIN_NO_SOFFICE: "1" });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(fs.existsSync(sock), false, "stale socket was removed even with pid=0 and pid=-1");
});

test("BE-03: launch() aborts after preflight if stop(), handover(), or close() happened mid-preflight", async () => {
  const fakeBin = path.join(root, "fakebin-be03");
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(path.join(fakeBin, "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  function deferredWorld() {
    const S = new Sessions();
    const spawned = [];
    let resolveAuth = null;
    const execFile = (bin, args, opts, cb) => {
      if (args[0] === "--version") return queueMicrotask(() => cb(null, "2.1.323 (Claude Code)\n", ""));
      if (args[0] === "auth") {
        resolveAuth = () => cb(null, JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }), "");
        return;
      }
      queueMicrotask(() => cb(null, "", ""));
    };
    const spawnFn = () => {
      const c = new EventEmitter();
      c.pid = 9001;
      c.stdout = new PassThrough();
      c.stderr = new PassThrough();
      spawned.push(c);
      return c;
    };
    const R = agentRunner(S, {
      spawn: spawnFn,
      execFile,
      kill: () => {},
      env: { HOME: root, USER: "u", PATH: "/usr/bin:/bin", ONIONSKIN_AGENT_PATH: fakeBin },
      open: () => {},
    });
    S.agent = R;
    return { S, R, spawned, finishPreflight: () => resolveAuth?.() };
  }

  // Case 1: stop() during preflight
  {
    const w = deferredWorld();
    const s = w.S.open(makeDoc(), { agent: "background" });
    w.R.ensure(s.key);
    await flush();
    await w.R.stop(s.key);
    assert.equal(w.S.view(s).agent.state, "none");
    w.finishPreflight();
    await flush();
    assert.equal(w.spawned.length, 0, "stop() during preflight aborts spawn");
    assert.equal(w.S.view(s).agent.state, "none");
  }

  // Case 2: handover() during preflight
  {
    const w = deferredWorld();
    const s = w.S.open(makeDoc(), { agent: "background" });
    w.R.ensure(s.key);
    await flush();
    await w.R.handover(s);
    assert.equal(w.S.view(s).agent.state, "handover");
    w.finishPreflight();
    await flush();
    assert.equal(w.spawned.length, 0, "handover() during preflight aborts spawn");
    assert.equal(w.S.view(s).agent.state, "handover", "handover state preserved");
  }

  // Case 3: close() during preflight
  {
    const w = deferredWorld();
    const s = w.S.open(makeDoc(), { agent: "background" });
    w.R.ensure(s.key);
    await flush();
    w.S.close(s.key);
    w.finishPreflight();
    await flush();
    assert.equal(w.spawned.length, 0, "close() during preflight aborts spawn");
  }
});

test("BE-06: child error event cleans up record file, clears e.child, fails as crashed, and starts waiting agent", async () => {
  const fakeBin = path.join(root, "fakebin-be06");
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(path.join(fakeBin, "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  const S = new Sessions();
  const spawned = [];
  let pid = 7000;
  const execFile = (bin, args, opts, cb) => {
    if (bin === "/bin/ps") return queueMicrotask(() => cb(null, "T1\n", ""));
    if (args[0] === "--version") return queueMicrotask(() => cb(null, "2.1.323 (Claude Code)\n", ""));
    if (args[0] === "auth") return queueMicrotask(() => cb(null, JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }), ""));
    queueMicrotask(() => cb(null, "", ""));
  };
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
    execFile,
    kill: () => {},
    env: { HOME: root, USER: "u", PATH: "/usr/bin:/bin", ONIONSKIN_AGENT_PATH: fakeBin },
  });
  S.agent = R;

  const a = S.open(makeDoc(), { agent: "background" });
  const b = S.open(makeDoc(), { agent: "background" });
  R.ensure(a.key);
  await flush();
  R.ensure(b.key);
  await flush();
  assert.equal(spawned.length, 1);
  const recPath = path.join(state, "agents", `${a.key}.json`);
  assert.ok(fs.existsSync(recPath), "record file exists while child is attached");

  spawned[0].emit("error", new Error("spawn ENOENT"));
  await flush();
  assert.equal(fs.existsSync(recPath), false, "record file removed on error");
  assert.equal(R.entries.get(a.key).child, null, "e.child cleared on error");
  assert.equal(S.view(a).agent.state, "failed");
  assert.deepEqual(S.view(a).agent.failure, { code: "crashed" });
  assert.equal(spawned.length, 2, "waiting agent b started after error freed the slot");

  // Even if close fires afterwards, it does not overwrite failed state
  spawned[0].emit("close", 1, null);
  await flush();
  assert.equal(S.view(a).agent.state, "failed");
});

test("BE-07: analysisInputs() renews lease and tick() does not expire while stage is checking", () => {
  let t = 1_800_000_000_000;
  const S = new Sessions({ now: () => t });
  const f = makeDoc();
  const s = S.open(f);
  const poll = S.poll(s.key, { holder: "agent-a" });
  S.send(s.key, { baseSha: s.baseSha, comments: [comment("c1", 1)], note: "" });
  return poll.promise.then((batch) => {
    const claim = { holder: "agent-a", token: batch.lease.token, batchId: batch.batch_id };
    const initialExpires = s.delivered.lease.expiresAt;

    t += 4000;
    const inputs = S.analysisInputs(s.key, claim);
    assert.ok(inputs);
    assert.equal(s.delivered.stage, "checking");
    assert.ok(s.delivered.lease.expiresAt > initialExpires, "analysisInputs renewed the lease");

    // Advance well past the renewed lease while stage === "checking"
    t = s.delivered.lease.expiresAt + 60_000;
    S.tick();
    assert.ok(s.delivered, "tick() must not expire lease while stage is checking");

    const done = S.done(s.key, { summary: "ok", results: [{ comment_id: "c1", status: "done" }] }, claim);
    assert.equal(done.ok, true);
    assert.equal(s.delivered, null);
  });
});
