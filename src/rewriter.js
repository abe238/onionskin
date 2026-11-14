// The local rewriter (milestone 2, idea 10): Apple's built-in on-device model rewrites ONE sentence (Fix grammar; the other tasks are for tests).
// This file is the seam and the worker. It makes no decision about what may be written: the caller must pass every answer through
// checkRewrite() (src/rewrite-check.js) and the normal write path. An answer from here is untrusted text, like any agent's.
//
//   getRewriter() -> {name, backend, rewrite(task, text, {timeoutMs}), warm()} | null   null: not set up (or its files are not intact)
//   rewrite() always resolves (never rejects): {ok:true, text} | {ok:false, code}. The codes mean "do not use this, hand the request
//   to the agent": warming_up (the model is still loading, it loads in the background), busy, timeout, unavailable, worker_exited,
//   bad_task, bad_text, bad_output, plus the worker's own (refused, generate_failed, bad_request, ...).
//
// The one back end is chosen by <state>/rewriter.json (0600, written last by `onionskin setup-rewriter`):
//   {backend:"apple", model:"apple", sha256}      scripts/rewriter/apple/onionskin-fm of this app copy, run in place
// The command to run is never read from that file: it is derived from fixed paths, and the helper must match the hash this app copy shipped
// with (onionskin-fm.json), or the rewriter reads as off. The helper ships ready-made in the zip and is run from the app folder (an upgrade
// replaces the folder, the helper and its hash together, so nothing is copied into the state folder to go stale). Before it is ever started
// (setup's probe, the server's worker, the doctor) appleHelperState() decides from the macOS version, the processor, the hash and the
// com.apple.quarantine mark, without running it: a helper that still carries that mark would make macOS show a hidden "Not Opened" dialog
// and hang. A rewriter.json of the older Granite download reads as off until setup removes the old files (src/rewriter-cleanup.js).
// Test only: ONIONSKIN_REWRITER_STUB=<json file> maps a sentence (or "<task>\t<sentence>") to its rewrite and replaces every back end.
// Test only: ONIONSKIN_APPLE_HELPER_DIR=<folder> holds a stand-in helper (and its onionskin-fm.json) in place of the shipped one, and
// ONIONSKIN_APPLE_HOST_MACOS=<version> pretends this Mac runs that macOS, so the browser tests reach every "not available" state.
//
// The worker is long-lived (a cold start loads the model), speaks JSON lines, is started on first use, stops after 15 idle minutes and on
// close, answers one request at a time, and runs offline: a minimal environment, the state folder as its working folder, and
// /usr/bin/sandbox-exec with the network denied. Ceiling: one request at a time for the whole server (a second one gets "busy" and goes
// to the agent), and a worker that does not answer within 60 s after a timeout is killed and starts cold again.
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "./constants.js";
import { stateDir } from "./paths.js";
import { REWRITE_TASKS } from "./rewrite-check.js";
import { untrusted } from "./sanitize.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const REWRITER_DIR = path.join(here, "..", "scripts", "rewriter");
export const APPLE_HELPER_DIR = path.join(REWRITER_DIR, "apple");
export const QUARANTINE = "com.apple.quarantine";
const XATTR = "/usr/bin/xattr";
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const SANDBOX_PROFILE = "(version 1)(allow default)(deny network*)";
const MAX_TEXT_IN = 1000;
const MAX_TEXT_OUT = 2000;
const MAX_LINE = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 4000;
const START_LIMIT_MS = 120_000; // a cold model load took 16 s on the test Mac; this is the give-up point
const STUCK_MS = 60_000;
const RETRY_AFTER_FAILURE_MS = 60_000;
const idleMs = () => Number(env("REWRITER_IDLE_MS", 15 * 60_000));

/** Where everything lives. `state` is the state folder (the doctor passes its own; everything else uses the server's). */
export const rewriterPaths = (state = stateDir()) => ({
  config: path.join(state, "rewriter.json"),
  appleBin: path.join(state, "bin", "onionskin-fm"), // what an older version built here; only `setup-rewriter --remove` still deletes it
});
export const fileSha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

const NAMES = { apple: "Apple's built-in model" };

/** Why Apple's model gives no instant suggestion, in the words a person reads (the page, the doctor, setup). */
export const APPLE_STATES = {
  macos_too_old: "Quick fixes need macOS 26 or later.",
  device_not_eligible: "This Mac cannot run Apple's on-device writing model.",
  apple_intelligence_not_enabled: "Turn on Apple Intelligence in System Settings to get quick spelling and grammar fixes.",
  model_not_ready: "Apple's writing model is still getting ready. Try again in a few minutes.",
  quarantined: "macOS is holding back the small helper for quick fixes because it came from a download. Install Onionskin again to clear that.",
  helper_missing: "The small helper for quick fixes is missing or damaged in this copy of Onionskin. Install Onionskin again to fix it.",
};
/** The probe's words (scripts/rewriter/apple/main.swift --probe) to the state codes above. */
export const PROBE_REASONS = { deviceNotEligible: "device_not_eligible", appleIntelligenceNotEnabled: "apple_intelligence_not_enabled", modelNotReady: "model_not_ready" };

/**
 * Does the file carry the com.apple.quarantine mark? Asked of /usr/bin/xattr, never by running the file. true | false; anything but a clean
 * "No such xattr" answer counts as marked (fail closed).
 */
export function isQuarantined(file) {
  const r = spawnSync(XATTR, ["-p", QUARANTINE, file], { encoding: "utf8", timeout: 5000 });
  if (r.status === 0) return true;
  return !(r.status === 1 && /No such xattr/.test(r.stderr || ""));
}
/** Removes the mark from exactly this file. true when the file carries no mark afterwards. */
export function clearQuarantine(file) {
  spawnSync(XATTR, ["-d", QUARANTINE, file], { encoding: "utf8", timeout: 5000 });
  return !isQuarantined(file);
}

let hostCache = null;
/** {macos: "26.1" | null, appleSilicon: boolean}, read once per process (sw_vers, and sysctl only for a Node that is not arm64). */
export function hostFacts() {
  if (hostCache) return hostCache;
  const out = (cmd, args) => {
    try {
      const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 5000 });
      return r.status === 0 ? r.stdout.trim() : null;
    } catch {
      return null;
    }
  };
  const mac = process.platform === "darwin";
  if (env("APPLE_HOST_MACOS", "")) return (hostCache = { macos: env("APPLE_HOST_MACOS", ""), appleSilicon: true }); // browser tests: pretend this macOS version
  hostCache = { macos: mac ? out("/usr/bin/sw_vers", ["-productVersion"]) : null, appleSilicon: mac && (process.arch === "arm64" || out("/usr/sbin/sysctl", ["-n", "hw.optional.arm64"]) === "1") };
  return hostCache;
}

/**
 * May the shipped Apple helper be started at all? Decided without running it, in this order: macOS 26 or later, Apple silicon, the helper and
 * its onionskin-fm.json are there and the hash matches, no quarantine mark. {ok:true, bin, sha256} | {ok:false, reason} (a key of APPLE_STATES,
 * or helper_changed, which reads as helper_missing). `o` (tests): dir, host ({macos, appleSilicon}), quarantined(file).
 */
export function appleHelperState(o = {}) {
  const dir = o.dir ?? (env("APPLE_HELPER_DIR", "") || APPLE_HELPER_DIR); // the folder variable is for the browser tests, with a stand-in helper
  const host = o.host ?? hostFacts();
  const marked = o.quarantined ?? isQuarantined;
  const major = Number(String(host.macos ?? "").split(".")[0]);
  if (!Number.isFinite(major) || major < 26) return { ok: false, reason: "macos_too_old" };
  if (!host.appleSilicon) return { ok: false, reason: "device_not_eligible" };
  const bin = path.join(dir, "onionskin-fm");
  let rec;
  try {
    rec = JSON.parse(fs.readFileSync(path.join(dir, "onionskin-fm.json"), "utf8"));
    if (!fs.lstatSync(bin).isFile()) return { ok: false, reason: "helper_missing" };
  } catch {
    return { ok: false, reason: "helper_missing" };
  }
  if (typeof rec?.sha256 !== "string" || fileSha256(bin) !== rec.sha256) return { ok: false, reason: "helper_changed" };
  if (marked(bin)) return { ok: false, reason: "quarantined", bin };
  return { ok: true, bin, sha256: rec.sha256 };
}
/** The person's words for a reason code, or null. helper_changed reads as helper_missing. */
export const appleStateLine = (reason) => APPLE_STATES[reason === "helper_changed" ? "helper_missing" : reason] ?? null;

/**
 * Reads <state>/rewriter.json and decides whether it is intact. {ok:true, backend, model, name, key, launch:{cmd,args}} or {ok:false, reason}.
 * Cheap enough to run on every call (a few stat calls, one /usr/bin/xattr call; the Apple helper is about 110 KB to hash).
 * `apple` (tests) goes to appleHelperState. A file of the older Granite setup (backend "mlx") is unknown_backend: off.
 */
export function readRewriterConfig(state, apple = {}) {
  const p = rewriterPaths(state);
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(p.config, "utf8"));
  } catch {
    return { ok: false, reason: "not_set_up" };
  }
  if (cfg?.backend === "apple") {
    if (cfg.model !== "apple") return { ok: false, reason: "config_mismatch" };
    const h = appleHelperState(apple);
    if (!h.ok) return { ok: false, reason: h.reason };
    return { ok: true, backend: "apple", model: "apple", name: NAMES.apple, key: `apple:${h.sha256}`, launch: { cmd: h.bin, args: [] } };
  }
  return { ok: false, reason: "unknown_backend" };
}

/** {on:true, name, backend} | {on:false, reason} for the doctor and the setup command. `apple` (tests) goes to appleHelperState. */
export function rewriterStatus(state, apple = {}) {
  if (env("REWRITER_STUB", "")) return { on: true, name: "test stand-in", backend: "stub" };
  const c = readRewriterConfig(state, apple);
  return c.ok ? { on: true, name: c.name, backend: c.backend } : { on: false, reason: c.reason };
}

/** [command, args] with the network denied for the process (and everything it starts). Without sandbox-exec the command runs as is. */
export function sandboxed(cmd, args, sandboxExec = SANDBOX_EXEC) {
  return fs.existsSync(sandboxExec) ? [sandboxExec, ["-p", SANDBOX_PROFILE, cmd, ...args]] : [cmd, args];
}

/** The environment the worker gets: nothing of the server's, the state folder as home. */
export function workerEnv() {
  return { PATH: "/usr/bin:/bin", HOME: stateDir(), TMPDIR: os.tmpdir() };
}

/**
 * One worker process behind a request function. `launch` is {cmd, args, env?, cwd?}; the real ones come from getRewriter(), tests pass a fake script.
 * Options: idleMs (default 15 minutes), startMs, stuckMs, retryMs.
 */
export function createWorker(launch, opts = {}) {
  const o = { idleMs: idleMs(), startMs: START_LIMIT_MS, stuckMs: STUCK_MS, retryMs: RETRY_AFTER_FAILURE_MS, ...opts };
  let child = null;
  let ready = false;
  let failedAt = 0;
  let startCode = null; // the worker's own reason for not starting ({"ready":false,"code"}), answered until the next try
  let nextId = 1;
  let busy = null; // {id, settle}: the request the worker is still working on (also after its caller timed out)
  let idleTimer = null;
  let startTimer = null;
  let stuckTimer = null;

  const stop = () => {
    clearTimeout(idleTimer);
    clearTimeout(startTimer);
    clearTimeout(stuckTimer);
    const c = child;
    child = null;
    ready = false;
    if (c) {
      try {
        c.stdin.end();
      } catch {}
      c.kill("SIGTERM");
    }
    if (busy) {
      busy.settle({ ok: false, code: "worker_exited" });
      busy = null;
    }
  };
  const touchIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(stop, o.idleMs);
    idleTimer.unref?.();
  };

  function start() {
    let c;
    try {
      c = spawn(launch.cmd, launch.args || [], { stdio: ["pipe", "pipe", "ignore"], env: launch.env ?? workerEnv(), cwd: launch.cwd ?? stateDir() });
    } catch {
      failedAt = Date.now();
      return;
    }
    child = c;
    c.unref();
    let buf = "";
    const gone = () => {
      if (child !== c) return;
      if (!ready) failedAt = Date.now();
      stop();
    };
    c.once("error", gone);
    c.once("exit", gone);
    c.stdin.on("error", () => {});
    c.stdout.setEncoding("utf8");
    c.stdout.on("data", (d) => {
      buf += d;
      if (buf.length > MAX_LINE && !buf.includes("\n")) return gone(); // a worker that never ends a line is not speaking our protocol
      let at;
      while ((at = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, at);
        buf = buf.slice(at + 1);
        if (child === c) onLine(line);
      }
    });
    startTimer = setTimeout(() => {
      if (child === c && !ready) {
        failedAt = Date.now();
        stop();
      }
    }, o.startMs);
    startTimer.unref?.();
  }

  function onLine(line) {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (!m || typeof m !== "object") return;
    if ("ready" in m) {
      if (m.ready === true && !ready) {
        ready = true;
        startCode = null; // a start that worked (also one begun by warm()) replaces an earlier reason
        clearTimeout(startTimer);
        touchIdle();
      } else if (m.ready === false) {
        failedAt = Date.now();
        startCode = Object.values(PROBE_REASONS).includes(m.code) ? m.code : null; // Apple's three reasons; anything else reads as "unavailable"
        stop();
      }
      return;
    }
    if (!busy || m.id !== busy.id) return;
    const b = busy;
    busy = null;
    clearTimeout(stuckTimer);
    touchIdle();
    if (m.ok === true && typeof m.text === "string" && m.text.length <= MAX_TEXT_OUT) b.settle({ ok: true, text: m.text });
    else if (m.ok === true) b.settle({ ok: false, code: "bad_output" });
    else b.settle({ ok: false, code: goodCode(m.code) ?? "failed", ...(typeof m.reason === "string" && m.reason ? { reason: untrusted(m.reason, 200) } : {}) });
  }

  return {
    /** Starts the model in the background if it is not running. */
    warm() {
      if (!child && Date.now() - failedAt >= o.retryMs) start();
    },
    rewrite(task, text, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
      if (!REWRITE_TASKS.includes(task)) return Promise.resolve({ ok: false, code: "bad_task" });
      if (typeof text !== "string" || !text.trim() || text.length > MAX_TEXT_IN) return Promise.resolve({ ok: false, code: "bad_text" });
      if (!child) {
        if (Date.now() - failedAt < o.retryMs) return Promise.resolve({ ok: false, code: startCode ?? "unavailable" });
        startCode = null;
        start();
      }
      if (!child) return Promise.resolve({ ok: false, code: "unavailable" });
      if (!ready) return Promise.resolve({ ok: false, code: "warming_up" });
      if (busy) return Promise.resolve({ ok: false, code: "busy" });
      return new Promise((resolve) => {
        const id = nextId++;
        let timer;
        const settle = (r) => {
          clearTimeout(timer);
          resolve(r);
        };
        busy = { id, settle };
        timer = setTimeout(() => settle({ ok: false, code: "timeout" }), timeoutMs);
        // the worker may still be working on it; "busy" holds until it answers, and a worker that never does is stopped
        stuckTimer = setTimeout(() => {
          if (busy?.id === id) {
            failedAt = Date.now();
            stop();
          }
        }, timeoutMs + o.stuckMs);
        stuckTimer.unref?.();
        try {
          child.stdin.write(JSON.stringify({ id, task, text }) + "\n");
        } catch {
          busy = null;
          settle({ ok: false, code: "worker_exited" });
        }
      });
    },
    close: stop,
    /** For tests and the doctor: is a model loaded right now? */
    get ready() {
      return ready;
    },
    /** The worker's own reason for its last failed start (device_not_eligible, ...), or null. */
    get startCode() {
      return startCode;
    },
  };
}

const goodCode = (c) => (typeof c === "string" && /^[a-z_]{1,40}$/.test(c) ? c : null);

// ---- the stub back end (tests) ---------------------------------------------------------------------------------------
function stubRewriter(file) {
  return {
    name: "test stand-in",
    backend: "stub",
    warm() {},
    close() {},
    async rewrite(task, text, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
      if (!REWRITE_TASKS.includes(task)) return { ok: false, code: "bad_task" };
      if (typeof text !== "string" || !text.trim() || text.length > MAX_TEXT_IN) return { ok: false, code: "bad_text" };
      let map;
      try {
        map = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        return { ok: false, code: "unavailable" };
      }
      const hit = Object.hasOwn(map, `${task}\t${text}`) ? map[`${task}\t${text}`] : Object.hasOwn(map, text) ? map[text] : undefined;
      if (hit === undefined) return { ok: false, code: "no_stub" };
      const e = typeof hit === "string" ? { text: hit } : hit;
      if (e.delayMs > timeoutMs) {
        await new Promise((r) => setTimeout(r, timeoutMs));
        return { ok: false, code: "timeout" };
      }
      if (e.delayMs) await new Promise((r) => setTimeout(r, e.delayMs));
      if (typeof e.code === "string") return { ok: false, code: e.code };
      return typeof e.text === "string" && e.text.length <= MAX_TEXT_OUT ? { ok: true, text: e.text } : { ok: false, code: "bad_output" };
    },
  };
}

// ---- the one worker of this server ---------------------------------------------------------------------------------------
let current = null; // {key, worker}

/** Stops the worker (server shutdown, or the configuration changed). Safe to call any time. */
export function stopRewriter() {
  current?.worker.close();
  current = null;
}

/**
 * The rewriter, or null when it is not set up, its files are not intact, or (Apple) its helper may not be started (appleHelperState). A removed or
 * replaced setup stops the worker that was running. `apple` (tests) goes to appleHelperState.
 */
export function getRewriter(apple = {}) {
  const stub = env("REWRITER_STUB", "");
  if (stub) return stubRewriter(stub);
  const c = readRewriterConfig(undefined, apple);
  if (!c.ok) {
    stopRewriter();
    return null;
  }
  if (current && current.key !== c.key) stopRewriter();
  if (!current) {
    const [cmd, args] = sandboxed(c.launch.cmd, c.launch.args);
    current = { key: c.key, worker: createWorker({ cmd, args }) };
  }
  const { worker } = current;
  return { name: c.name, backend: c.backend, rewrite: (task, text, o) => worker.rewrite(task, text, o), warm: () => worker.warm(), close: stopRewriter, startCode: () => worker.startCode };
}
