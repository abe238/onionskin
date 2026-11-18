// A real Onionskin server in a child process, driven over its CLI socket and its browser API, with /health probed from this process the
// whole time: the longest wait for /health is the longest the server's thread was busy. Used by test/stall.test.js
// (ONIONSKIN_STALL_LOG=1 prints the wait per path). State, documents and the web folder live in a temp dir; no agent is ever started.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { docxBytes, tmpdir } from "./zipbuild.js";
import { pptxRuns, xlsxGrid } from "./hostile.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function request(opts, body) {
  return new Promise((resolve, reject) => {
    const r = http.request(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    r.on("error", reject);
    if (body != null) r.write(body);
    r.end();
  });
}

// Every child server still running when this test process exits is killed then, whatever ended the test: a test that timed out never
// reaches its own stop() (its finally block waits on the promise that timed out), and --test-force-exit then left the server running
// with no parent. Synchronous, as an "exit" handler must be; the temp folder of such a server is left for the system to clear.
const live = new Set();
process.on("exit", () => {
  for (const c of live) c.kill("SIGKILL");
});

/** Starts `node src/server-entry.js` in a fresh state dir. Returns helpers for the socket and the browser API, and the child's exit. */
export async function childServer({ env = {}, prefix = "da-stall-" } = {}) {
  const root = tmpdir(prefix);
  const state = path.join(root, "st");
  const web = path.join(root, "web");
  fs.mkdirSync(web);
  fs.writeFileSync(path.join(web, "index.html"), "<!doctype html><title>t</title>");
  const childEnv = { PATH: process.env.PATH, HOME: root, ONIONSKIN_STATE_DIR: state, ONIONSKIN_WEB_DIST: web, ONIONSKIN_NO_SOFFICE: "1", ONIONSKIN_AGENT_CLI: "none", ONIONSKIN_TICK_MS: "100000", ONIONSKIN_LEASE_MS: "600000", ...env };
  const child = spawn(process.execPath, [path.join(repo, "src", "server-entry.js")], { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  live.add(child);
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => (live.delete(child), resolve({ code, signal }))));
  let exit = null;
  exited.then((e) => (exit = e));
  await new Promise((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
      if (out.includes("ready")) resolve();
    });
    exited.then((e) => reject(new Error(`the server exited before it was ready (${JSON.stringify(e)}): ${stderr}`)));
  });
  const socketFile = path.join(state, "s.sock"); // src/paths.js socketPath
  const { port } = JSON.parse(fs.readFileSync(path.join(state, "server.json"), "utf8"));
  const cli = (method, p, body) => request({ socketPath: socketFile, method, path: p, headers: body ? { "content-type": "application/json" } : {} }, body ? JSON.stringify(body) : null);
  const pages = new Map(); // key -> {cookie, token}
  /** Opens `file` through /cli/open and takes the launch link like the page does. Returns {key, json}. */
  async function openPage(file, extra = {}) {
    const o = await cli("POST", "/cli/open", { file, ...extra });
    if (o.status !== 200) return { status: o.status, json: o.json };
    const u = new URL(o.json.url);
    const first = await request({ host: "127.0.0.1", port, method: "GET", path: u.pathname + u.search });
    const cookie = first.headers["set-cookie"][0].split(";")[0];
    const token = /<meta name="onionskin-launch" content="([\w-]+)">/.exec(first.text)?.[1];
    pages.set(o.json.key, { cookie, token });
    await api(o.json.key, "/api/claim", { takeover: true });
    return { status: 200, key: o.json.key, json: o.json };
  }
  const TAB = "stalltab01";
  // `tab`: the page's tab id (a reloaded page is a new tab)
  function api(key, p, body, method = body === undefined ? "GET" : "POST", tab = TAB) {
    const { cookie, token } = pages.get(key);
    const data = body === undefined ? null : JSON.stringify(body);
    const sep = p.includes("?") ? "&" : "?";
    return request({ host: "127.0.0.1", port, method, path: `${p}${sep}s=${key}`, headers: { cookie, "x-onionskin-token": token, "x-onionskin-tab": tab, origin: `http://127.0.0.1:${port}`, "sec-fetch-site": "same-origin", ...(data ? { "content-type": "application/json" } : {}) } }, data);
  }
  return {
    root, state, port, child, cli, api, openPage,
    get exit() {
      return exit;
    },
    get stderr() {
      return stderr;
    },
    pid: child.pid,
    async stop() {
      if (exit == null) {
        child.kill("SIGTERM");
        await exited;
      }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * Asks the server's /health every `every` ms, one request at a time, from this process, until stop(). stop() resolves to
 * {max, count, errors}: the longest a /health request waited for its answer (ms), how many were answered, and what failed.
 */
export function healthProbe(srv, { every = 50 } = {}) {
  let running = true;
  let max = 0;
  let count = 0;
  const errors = [];
  const loop = (async () => {
    while (running) {
      const t = performance.now();
      try {
        const r = await srv.cli("GET", "/health");
        if (r.status !== 200) errors.push(`status ${r.status}`);
        else count++;
      } catch (err) {
        errors.push(String(err?.code || err?.message || err));
      }
      max = Math.max(max, performance.now() - t);
      await new Promise((r) => setTimeout(r, every));
    }
  })();
  return {
    async stop() {
      running = false;
      await loop;
      return { max: Math.round(max), count, errors };
    },
  };
}

/** Runs `fn` while /health is probed. Returns {ms (how long fn took), health: {max, count, errors}, result}. */
export async function underProbe(srv, fn) {
  const probe = healthProbe(srv);
  await new Promise((r) => setTimeout(r, 120)); // a few answered probes first
  const t = performance.now();
  let result, error;
  try {
    result = await fn();
  } catch (err) {
    error = err;
  }
  const ms = Math.round(performance.now() - t);
  await new Promise((r) => setTimeout(r, 120));
  const health = await probe.stop();
  if (error) throw Object.assign(error, { health });
  return { ms, health, result };
}

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const HEALTH_MS = 2000;
const benign = { docx: () => docxBytes(["Hello there.", "Second paragraph."]), xlsx: () => xlsxGrid(3), pptx: () => pptxRuns(1, 2) };
const anchor = { docx: { location: { blockPath: [0] }, paraText: "a" }, xlsx: { location: { sheetIndex: 0, sheetName: "S1", range: "A1" } }, pptx: { location: { slideIndex: 0, shapeId: 2 }, quote: "a" } };

/** Runs `fn` under the probe; asserts /health stayed within HEALTH_MS and the server is alive. Returns the response. */
export async function within(srv, label, fn) {
  const r = await underProbe(srv, fn);
  if (process.env.ONIONSKIN_STALL_LOG) console.log(`stall: ${label}: /health waited at most ${r.health.max} ms (${r.ms} ms for the request)`);
  assert.deepEqual(r.health.errors, [], `${label}: /health failed`);
  assert.ok(r.health.max < HEALTH_MS, `${label}: /health waited ${r.health.max} ms`);
  assert.equal(srv.exit, null, `${label}: the server exited`);
  assert.notEqual(r.result?.status, 500, `${label}: ${JSON.stringify(r.result?.json)}`);
  return r.result;
}

/**
 * The reviewer's flow: open `make()`, Send one comment, the agent Onionskin started commits a change to the first unit and finishes,
 * then the page asks to merge its version (every unit edited) onto the agent's. Returns the merge's answer.
 */
/** CPU time (user and system, ms) the process `pid` has used so far, from ps (10 ms steps). */
export function cpuOf(pid) {
  const t = spawnSync("/bin/ps", ["-o", "time=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim(); // [[h:]m:]s.cc
  return t.split(":").reduce((acc, x) => acc * 60 + Number(x), 0) * 1000;
}

/**
 * The server's CPU time for `fn` (ms), with /health still probed and every answer required: on a loaded Mac, wall time and the /health
 * wait count the time other processes held the cores; the server's own CPU time counts only its work.
 */
export async function cpuWithin(srv, label, fn, maxMs) {
  const before = cpuOf(srv.pid);
  const r = await underProbe(srv, fn);
  const cpu = cpuOf(srv.pid) - before;
  if (process.env.ONIONSKIN_STALL_LOG) console.log(`stall: ${label}: ${cpu} ms of server CPU, /health waited at most ${r.health.max} ms`);
  assert.deepEqual(r.health.errors, [], `${label}: /health failed`);
  assert.ok(cpu < maxMs, `${label}: the server used ${cpu} ms of CPU`);
  assert.equal(srv.exit, null, `${label}: the server exited`);
  return r.result;
}

/**
 * `gate`: null checks /health under 2 s (within); a number checks the server's CPU time for the merge instead (cpuWithin). `ops`: the
 * agent's change is made with these checked ops (src/ops/run.js on make()) and written as an apply with its record, as `apply` does,
 * instead of make("", "Changed by the agent here") committed without one.
 */
export async function mergeFlow(format, make, anchor, check, { gate = null, ops = null } = {}) {
  const srv = await childServer();
  try {
    const f = path.join(srv.root, `m.${format}`);
    const b0 = make();
    fs.writeFileSync(f, b0);
    const { key, status } = await srv.openPage(f);
    assert.equal(status, 200);
    const real = fs.realpathSync(f);
    assert.equal((await srv.api(key, "/api/send", { baseSha: sha(b0), comments: [{ id: "c1", kind: "element", text: "check", anchor }], note: "go" })).status, 200);
    const holder = `onionskin-term-${key}`;
    const polled = await srv.cli("GET", `/cli/poll?file=${encodeURIComponent(real)}&holder=${holder}`);
    const [batchId, token] = polled.json.lease_ticket.split(":");
    if (ops) {
      const { runOps } = await import("../../src/ops/run.js");
      const made = await runOps({ bytes: b0, format, name: `m.${format}`, ops });
      assert.ok(made.bytes, JSON.stringify(made.results).slice(0, 300));
      const w = await srv.cli("POST", "/cli/agent-write", { file: real, holder, batch_id: batchId, lease_token: token, base_sha256: sha(b0), bytes_b64: Buffer.from(made.bytes).toString("base64"), ops });
      assert.equal(w.status, 200, JSON.stringify(w.json).slice(0, 300));
    } else {
      const theirs = make("", "Changed by the agent here");
      assert.equal((await srv.cli("POST", "/cli/commit", { file: real, holder, batch_id: batchId, lease_token: token, base_sha256: sha(b0), bytes_b64: theirs.toString("base64") })).status, 200);
    }
    assert.equal((await srv.cli("POST", "/cli/done", { file: real, holder, batch_id: batchId, lease_token: token, results: [] })).status, 200);
    const mine = make(", edited by me");
    const merge = () => srv.api(key, "/api/merge", { baseSha: sha(b0), bytesB64: mine.toString("base64"), edits: [] });
    const r = gate == null ? await within(srv, `${format} merge`, merge) : await cpuWithin(srv, `${format} merge`, merge, gate);
    assert.equal(r.status, 200, JSON.stringify(r.json).slice(0, 300));
    check(fs.readFileSync(f)); // what the merge wrote: the agent's change and every one of the person's
    return r.json;
  } finally {
    await srv.stop();
  }
}

/** Every path with `bytes`, in fresh servers so nothing was read before (the server keeps the last reading of a version). */
export async function everyPath(format, bytes) {
  let srv = await childServer();
  try {
    const hf = path.join(srv.root, `h.${format}`);
    fs.writeFileSync(hf, bytes);
    const o = await within(srv, "open", () => srv.openPage(hf));
    assert.equal(o.status, 200, JSON.stringify(o.json));
    assert.equal((await within(srv, "review", () => srv.api(o.key, "/api/review", { kind: "proofread" }))).status, 200);
    await srv.stop();
    // the page sends the bytes, the agent is delivered the batch with its outline, a comment is queued, done
    srv = await childServer();
    const f = path.join(srv.root, `d.${format}`);
    const b0 = benign[format]();
    fs.writeFileSync(f, b0);
    const { key } = await srv.openPage(f);
    const real = fs.realpathSync(f);
    const c1 = { id: "c1", kind: "element", text: "check this", anchor: anchor[format] };
    assert.equal((await within(srv, "send", () => srv.api(key, "/api/send", { baseSha: sha(b0), bytesB64: bytes.toString("base64"), comments: [c1], note: "a note" }))).status, 200);
    const holder = `onionskin-term-${key}`;
    const polled = await within(srv, "poll", () => srv.cli("GET", `/cli/poll?file=${encodeURIComponent(real)}&holder=${holder}`));
    assert.ok(polled.json.untrusted_document_evidence?.outline, "the agent got the outline");
    await within(srv, "queued comment", () => srv.api(key, "/api/send", { baseSha: sha(bytes), comments: [c1, { ...c1, id: "c2" }], note: "" }));
    const [batchId, token] = polled.json.lease_ticket.split(":");
    assert.equal((await within(srv, "done", () => srv.cli("POST", "/cli/done", { file: real, holder, batch_id: batchId, lease_token: token, results: [] }))).status, 200);
    await within(srv, "resolve", () => srv.api(key, "/api/resolve", {}));
    await srv.stop();
    // the agent writes the bytes; done, resolve and revert read them first
    srv = await childServer();
    const g = path.join(srv.root, `g.${format}`);
    fs.writeFileSync(g, b0);
    const og = await srv.openPage(g);
    const realG = fs.realpathSync(g);
    await srv.api(og.key, "/api/send", { baseSha: sha(b0), comments: [c1], note: "a note" });
    const hg = `onionskin-term-${og.key}`;
    const pg = await srv.cli("GET", `/cli/poll?file=${encodeURIComponent(realG)}&holder=${hg}`);
    await srv.api(og.key, "/api/send", { baseSha: sha(b0), comments: [c1, { ...c1, id: "c2" }], note: "" });
    const [bid, tok] = pg.json.lease_ticket.split(":");
    assert.equal((await within(srv, "agent write", () => srv.cli("POST", "/cli/commit", { file: realG, holder: hg, batch_id: bid, lease_token: tok, base_sha256: sha(b0), bytes_b64: bytes.toString("base64") }))).status, 200);
    assert.equal((await within(srv, "done after the write", () => srv.cli("POST", "/cli/done", { file: realG, holder: hg, batch_id: bid, lease_token: tok, results: [] }))).status, 200);
    await within(srv, "resolve after the write", () => srv.api(og.key, "/api/resolve", {}));
    const run = (await srv.api(og.key, "/api/bootstrap")).json.session.activity.find((a) => a.kind === "agent");
    assert.equal((await within(srv, "revert", () => srv.api(og.key, "/api/revert", { id: run.id }))).status, 200);
    assert.equal((await within(srv, "close", () => srv.api(og.key, "/api/close", {}))).status, 200);
  } finally {
    await srv.stop();
  }
}
