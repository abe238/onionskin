import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCT, env } from "./constants.js";
import { stateDir } from "./paths.js";
import { runInGroup } from "./update.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const CHECK_SCRIPT = path.join(here, "..", "scripts", "checker", "check.py");
const CHECKER_REQUIREMENTS = path.join(here, "..", "scripts", "checker", "requirements.txt");
// The deep check blocks its own thread for up to this long (default 3 minutes; LibreOffice is the slow part). The server runs it in a worker
// thread (src/offload.js), so it keeps answering meanwhile; Sessions.done called directly (tests) still runs it inline.
const CHECK_TIMEOUT_MS = () => Number(env("CHECK_TIMEOUT_MS", 180_000));

const venvDir = () => path.join(stateDir(), "venv");
const venvPython = () => path.join(venvDir(), process.platform === "win32" ? "Scripts" : "bin", process.platform === "win32" ? "python.exe" : "python");

/** ONIONSKIN_PYTHON, else the venv that `setup-checker` creates in the state dir. null when neither exists. */
export function findPython() {
  const p = env("PYTHON", "") || venvPython();
  return fs.existsSync(p) ? p : null;
}

const DEEP_KILL_GRACE_MS = 2000;
const DEEP_MAX_BUFFER = 16 * 1024 * 1024;
const checkerEnv = (dir) => ({ ...process.env, ONIONSKIN_SOFFICE_PID_FILE: path.join(dir, "soffice.pid") });

// check.py clears this file after conversion. A hard kill cannot run its cleanup handler.
function stopRemainingSoffice(dir) {
  try {
    const record = fs.readFileSync(path.join(dir, "soffice.pid"), "ascii");
    if (!/^\d+\n$/.test(record)) return;
    const pid = Number(record);
    if (Number.isSafeInteger(pid) && pid > 1) process.kill(-pid, "SIGKILL");
  } catch {}
}

// Runs `cmd args...` with SIGTERM at timeoutMs and SIGKILL after graceMs so a process stuck in a native call cannot outlast the timeout.
const SYNC_RUNNER = `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const [metaFile, timeoutStr, graceStr, maxBufStr, cmd, ...args] = process.argv.slice(1);
const timeoutMs = Number(timeoutStr);
const graceMs = Number(graceStr);
const maxBuf = Number(maxBufStr);
let timedOut = false, killTimer = null, t = null, bytes = 0, overflow = false, done = false;
const write = (o) => { try { fs.writeFileSync(metaFile, JSON.stringify(o)); } catch {} };
const finish = (o) => {
  if (done) return;
  done = true;
  clearTimeout(t); clearTimeout(killTimer);
  write(o);
  if (timedOut) { child.stdout.destroy(); child.stderr.destroy(); }
};
const child = spawn(cmd, args, { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
const feed = (stream, out) => stream.on("data", (d) => {
  bytes += d.length;
  if (bytes > maxBuf) {
    if (!overflow) { overflow = true; try { child.kill("SIGKILL"); } catch {} }
    return;
  }
  out.write(d);
});
feed(child.stdout, process.stdout);
feed(child.stderr, process.stderr);
if (timeoutMs > 0) {
  t = setTimeout(() => {
    timedOut = true;
    if (child.exitCode !== null || child.signalCode !== null) return finish({ timedOut });
    try { child.kill("SIGTERM"); } catch {}
    killTimer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, graceMs);
    killTimer.unref?.();
  }, timeoutMs);
}
child.once("error", (err) => finish({ timedOut, error: { code: err.code, message: err.message } }));
child.once("exit", (status, signal) => {
  if (timedOut) finish({ timedOut, status, signal, error: overflow ? { code: "ENOBUFS", message: "maxBuffer exceeded" } : null });
});
child.once("close", (status, signal) => finish({ timedOut, status, signal, error: overflow ? { code: "ENOBUFS", message: "maxBuffer exceeded" } : null }));
`;

/**
 * Runs scripts/checker/check.py on the two package versions. Never returns "clean" for a check that did not run:
 * {ran:false, reason} when Python or its libraries are missing, and a `deep_check_failed` flag when it ran but broke.
 * `deferSoffice` leaves the LibreOffice conversion out (check.py --no-soffice): `soffice` is then "pending" when it would run (see
 * startLateSoffice) and the result never says it passed.
 */
export function runDeepCheck(preBytes, postBytes, format, { deferSoffice = false } = {}) {
  const py = findPython();
  if (!py) return { ran: false, flags: [], code: "not_set_up", reason: `no Python with lxml found: set ${PRODUCT.envPrefix}_PYTHON or run \`${PRODUCT.bin} setup-checker\`` };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "onionskin-check-"));
  try {
    const pre = path.join(dir, `pre.${format}`);
    const post = path.join(dir, `post.${format}`);
    const metaFile = path.join(dir, "meta.json");
    const timeoutMs = CHECK_TIMEOUT_MS();
    fs.writeFileSync(pre, preBytes);
    fs.writeFileSync(post, postBytes);
    const r = spawnSync(
      process.execPath,
      ["-e", SYNC_RUNNER, metaFile, String(timeoutMs), String(DEEP_KILL_GRACE_MS), String(DEEP_MAX_BUFFER), py, "-I", CHECK_SCRIPT, pre, post, format, ...(deferSoffice ? ["--no-soffice"] : [])],
      { encoding: "utf8", detached: true, timeout: timeoutMs > 0 ? timeoutMs + DEEP_KILL_GRACE_MS + 5000 : 0, maxBuffer: DEEP_MAX_BUFFER + 65536, env: checkerEnv(dir), killSignal: "SIGKILL" },
    );
    let meta = null;
    try {
      meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
    } catch {}
    if (meta?.timedOut || r.error?.code === "ETIMEDOUT") {
      // Backstop for a stuck runner or descendants that still hold its pipes.
      if (r.pid > 1) try { process.kill(-r.pid, "SIGKILL"); } catch {}
      return { ran: false, code: "timed_out", flags: [{ code: "deep_check_failed", severity: "warn", detail: `timed out after ${timeoutMs / 1000}s` }], reason: "the deeper check timed out" };
    }
    const err = meta?.error || r.error;
    if (err) return { ran: false, code: "failed", flags: [{ code: "deep_check_failed", severity: "warn", detail: err.message }], reason: "the deeper check could not start" };
    const status = meta ? meta.status : r.status;
    let j;
    try {
      j = JSON.parse(r.stdout);
    } catch {
      j = null;
    }
    if (status === 3) return { ran: false, flags: [], code: "libraries_missing", reason: `${py} lacks lxml/defusedxml: run \`${PRODUCT.bin} setup-checker\`` };
    if (status !== 0 || !j || !Array.isArray(j.flags)) {
      const why = (j?.error || r.stderr || `exit ${status}`).toString().slice(0, 300);
      return { ran: false, code: "failed", flags: [{ code: "deep_check_failed", severity: "warn", detail: why }], reason: "the deeper check failed to run" };
    }
    const skipped = j.skipped || [];
    const pending = skipped.some((x) => x.check === "soffice-convert" && x.pending);
    return { ran: true, flags: j.flags, checksRun: j.ran, skipped: pending ? skipped.filter((x) => !x.pending) : skipped, sofficePending: pending, python: py };
  } finally {
    stopRemainingSoffice(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// One LibreOffice at a time for the whole server: each run is a full office process (hundreds of MB, a second or more of CPU), so a burst of
// `done` calls waits in line (first in, first out) rather than starting one each. Ceiling: at most LATE_WAITING checks wait; one more is
// recorded as not run, with the reason. Raise the limits here if a machine can carry more.
const LATE_WAITING = 8;
const lateQueue = []; // start functions of checks that wait their turn
let lateRunning = false;
const lateNext = () => {
  lateRunning = false;
  const start = lateQueue.shift();
  if (start) start();
};

const KILL_GRACE_MS = 5000;

/** Sends SIGTERM to a live child and schedules an unref'd SIGKILL fallback so a hung child cannot stall the queue or leak temp dirs. */
function gracefulKill(getChild) {
  let killTimer = null;
  const terminate = () => {
    const child = getChild();
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.kill("SIGTERM");
    } catch {}
    if (!killTimer) {
      killTimer = setTimeout(() => {
        const c = getChild();
        if (c && c.exitCode === null && c.signalCode === null) {
          try {
            c.kill("SIGKILL");
          } catch {}
        }
      }, KILL_GRACE_MS);
      killTimer.unref?.();
    }
  };
  const clear = () => {
    clearTimeout(killTimer);
    killTimer = null;
  };
  return { terminate, clear };
}

/**
 * The LibreOffice conversion check for a version `done` already accepted, run in the background (check.py --soffice-only). Never blocks:
 * `onDone({ran, flags, skipped, reason})` is called exactly once, also when the check fails, times out, is cancelled or never got its turn
 * (then ran:false and a reason, never a clean result). One check runs at a time; the time limit counts from its own start, not from the
 * wait. `cancel()` ends it now, running or waiting: SIGTERM makes check.py kill its soffice process group; check.py also exits on its own
 * when this process is gone, so no soffice outlives the server. Returns {cancel}.
 */
export function startLateSoffice(preBytes, postBytes, format, onDone) {
  const py = findPython();
  let settled = false;
  let started = false;
  let child = null;
  let timer = null;
  let dir = null;
  const killer = gracefulKill(() => child);
  const cleanupDir = () => {
    if (!dir) return;
    const d = dir;
    dir = null;
    stopRemainingSoffice(d);
    fs.rmSync(d, { recursive: true, force: true });
  };
  const finish = (r) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    // the next one starts only when this one's process is really gone (a cancelled or timed-out check takes a moment to die)
    if (started && child?.pid && child.exitCode === null && child.signalCode === null) child.once("close", lateNext);
    else {
      cleanupDir();
      if (started) lateNext();
      else {
        const at = lateQueue.indexOf(start);
        if (at >= 0) lateQueue.splice(at, 1);
      }
    }
    try {
      onDone(r);
    } catch {}
  };
  const cancel = (reason = "the check was cancelled") => {
    if (settled) return;
    killer.terminate();
    finish({ ran: false, flags: [], skipped: [], reason });
  };
  function start() {
    started = true;
    lateRunning = true;
    try {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "onionskin-late-"));
      const pre = path.join(dir, `pre.${format}`);
      const post = path.join(dir, `post.${format}`);
      fs.writeFileSync(pre, preBytes);
      fs.writeFileSync(post, postBytes);
      child = spawn(py, ["-I", CHECK_SCRIPT, pre, post, format, "--soffice-only"], { env: checkerEnv(dir), stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      return finish({ ran: false, flags: [], skipped: [], reason: `could not start: ${err.message}` });
    }
    let out = "";
    child.stdout.on("data", (d) => (out = (out + d).slice(0, 16 * 1024 * 1024)));
    child.stderr.resume();
    child.once("error", (err) => {
      killer.clear();
      finish({ ran: false, flags: [], skipped: [], reason: `could not start: ${err.message}` });
    });
    child.once("close", (code) => {
      killer.clear();
      cleanupDir();
      let j = null;
      try {
        j = JSON.parse(out);
      } catch {}
      if (code === 0 && j && Array.isArray(j.flags)) finish({ ran: (j.ran || []).includes("soffice-convert"), flags: j.flags, skipped: j.skipped || [], reason: (j.skipped || [])[0]?.reason });
      else finish({ ran: false, flags: [], skipped: [], reason: (j?.error || `exit ${code}`).toString().slice(0, 200) });
    });
    timer = setTimeout(() => {
      killer.terminate();
      finish({ ran: false, flags: [], skipped: [], reason: `timed out after ${CHECK_TIMEOUT_MS() / 1000}s` });
    }, CHECK_TIMEOUT_MS());
  }
  if (!py) finish({ ran: false, flags: [], skipped: [], reason: "no Python for the check" });
  else if (!lateRunning) start();
  else if (lateQueue.length >= LATE_WAITING) finish({ ran: false, flags: [], skipped: [], reason: `not run: ${LATE_WAITING} LibreOffice checks were already waiting` });
  else lateQueue.push(start);
  return { cancel };
}

/** `onionskin setup-checker`: the one place that uses the network (pip). Creates <state dir>/venv. */
export async function setupChecker(log = (s) => process.stderr.write(s + "\n")) {
  const base = process.env[`${PRODUCT.envPrefix}_BASE_PYTHON`] || "python3";
  fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + SETUP_TIMEOUT_MS();
  const runStep = async (cmd, args) => {
    const remaining = deadline - Date.now();
    let expired = remaining <= 0;
    // The installer may itself receive SIGKILL shortly after TERM. End this step's group before that happens.
    const status = expired ? 1 : await runInGroup(cmd, args, { timeout: remaining, signalGraceMs: 0, onTimeout: () => { expired = true; } });
    if (expired) throw new Error("Deeper check setup timed out.");
    if (status === 129 || status === 130 || status === 143) throw new Error("Deeper check setup was stopped.");
    return status;
  };
  const imports = ["-c", "import lxml, docx, openpyxl, pptx, defusedxml"];
  if (env("SETUP_IF_NEEDED") === "1") {
    if (fs.existsSync(venvPython()) && await runStep(venvPython(), imports) === 0) return venvPython();
    if (!env("BASE_PYTHON") && process.platform === "darwin") {
      const guard = '[ "$(command -v python3)" != /usr/bin/python3 ] || xcode-select -p >/dev/null 2>&1';
      if (await runStep("/bin/sh", ["-c", guard]) !== 0) throw new Error("Python needs the macOS developer tools, which are not installed.");
    }
  }
  const steps = [
    [base, ["-m", "venv", venvDir()]],
    [venvPython(), ["-m", "pip", "install", "--disable-pip-version-check", "--quiet", "--require-hashes", "--only-binary=:all:", "-r", CHECKER_REQUIREMENTS]],
  ];
  for (const [cmd, args] of steps) {
    log(`$ ${path.basename(cmd)} ${args.slice(0, 3).join(" ")} ...`);
    const status = await runStep(cmd, args);
    if (status !== 0) throw new Error(`${cmd} ${args.slice(0, 2).join(" ")} failed (exit ${status})`);
  }
  if (await runStep(venvPython(), imports) !== 0) throw new Error("the venv was created but the libraries do not import");
  return venvPython();
}

// ---- the same setup, for the browser (POST /api/setup-checker) -----------------------------------------------------
// The server must keep answering while pip runs (about a minute), so this variant spawns instead of spawnSync. One job at a time for the
// whole server: a second start while one runs gets the same promise. The job's outcome is kept until the next start so the page can poll it.
const SETUP_TIMEOUT_MS = () => Number(env("SETUP_TIMEOUT_MS", 10 * 60_000));
export const NETWORK_WORDS = /could not (?:resolve|fetch url)|name or service not known|nodename nor servname|temporary failure in name resolution|failed to establish a new connection|newconnectionerror|connection (?:error|refused|reset|timed out)|network is unreachable|max retries exceeded|read timed out|ssl|proxy/i;
export const UNSUPPORTED_PYTHON_WORDS = /requires-python|ignored the following versions/i;
let job = null; // {promise} while running; {outcome: {reason, detail}} after a failure; null when idle or after a success

/** One command, async. Resolves {status, stderr (last 4000 bytes), error}; never rejects, never inherits the server's stdio. */
export function run(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    let stderr = "";
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stderr: stderr.slice(-4000), ...r });
    };
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"], env: process.env });
    } catch (error) {
      return resolve({ status: null, stderr: "", error });
    }
    const timer = setTimeout(() => (child.kill("SIGKILL"), done({ status: null, error: new Error(`took longer than ${Math.round(timeoutMs / 1000)}s`) })), timeoutMs);
    child.stderr.on("data", (d) => (stderr += d));
    child.once("error", (error) => done({ status: null, error }));
    child.once("close", (status) => done({ status }));
  });
}

/** Returns e.g. "Python 3.9.6" or "" if the interpreter cannot be queried. */
function pythonVersion(py) {
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    let child;
    try {
      child = spawn(py, ["--version"], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    } catch {
      return resolve("");
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      done("");
    }, 5000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.once("error", () => done(""));
    child.once("close", (status) => done(status === 0 ? out.trim().slice(0, 80) : ""));
  });
}

/** Do the venv's libraries import? (The one probe both setup and the status use: a venv whose pip said ok but whose libraries do not import is not ready.) */
async function librariesImport(py) {
  return (await run(py, ["-c", "import lxml, docx, openpyxl, pptx, defusedxml"], 30_000)).status === 0;
}

async function setupSteps() {
  const base = process.env[`${PRODUCT.envPrefix}_BASE_PYTHON`] || "python3";
  // A Mac without the developer tools: /usr/bin/python3 is a stub that opens Apple's installer window. Never start that from a button.
  if (base === "python3" && process.platform === "darwin") {
    const first = (process.env.PATH || "").split(":").map((d) => path.join(d, "python3")).find((f) => fs.existsSync(f));
    if (first === "/usr/bin/python3" && (await run("/usr/bin/xcode-select", ["-p"], 5000)).status !== 0) throw Object.assign(new Error("/usr/bin/python3 needs the macOS developer tools, which are not installed"), { reason: "no_python" });
  }
  fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  const venv = await run(base, ["-m", "venv", venvDir()], SETUP_TIMEOUT_MS());
  if (venv.status !== 0) {
    const missing = venv.error?.code === "ENOENT";
    throw Object.assign(new Error(`${base} -m venv failed (${venv.error?.message || `exit ${venv.status}`}) ${venv.stderr}`.trim()), { reason: missing ? "no_python" : "failed" });
  }
  const pip = await run(venvPython(), ["-m", "pip", "install", "--disable-pip-version-check", "--quiet", "--require-hashes", "--only-binary=:all:", "-r", CHECKER_REQUIREMENTS], SETUP_TIMEOUT_MS());
  if (pip.status !== 0) {
    const text = `pip install failed (${pip.error?.message || `exit ${pip.status}`}) ${pip.stderr}`.trim();
    if (NETWORK_WORDS.test(text)) {
      throw Object.assign(new Error(text), { reason: "no_network" });
    }
    if (UNSUPPORTED_PYTHON_WORDS.test(text)) {
      const ver = await pythonVersion(venvPython());
      const detail = ver ? `this Python version or platform (${ver}) is not supported: ${text}` : `this Python version or platform is not supported: ${text}`;
      throw Object.assign(new Error(detail), { reason: "unsupported_python", pythonVersion: ver || undefined });
    }
    throw Object.assign(new Error(text), { reason: "failed" });
  }
  if (!(await librariesImport(venvPython()))) throw Object.assign(new Error("the venv was created but the libraries do not import"), { reason: "failed" });
  // runs use findPython(): an ONIONSKIN_PYTHON that points elsewhere would keep the checker off after a "successful" setup
  const used = findPython();
  if (used !== venvPython() && !(await librariesImport(used))) throw Object.assign(new Error(`the venv is ready, but ${PRODUCT.envPrefix}_PYTHON points at ${used}, which lacks the libraries: unset it`), { reason: "failed" });
  return venvPython();
}

/**
 * Starts the setup (or joins the one that is running) and returns its promise. It resolves to the venv's python, or rejects with an error that
 * carries `reason`: no_python | no_network | unsupported_python | failed. The caller does not need to await it; setupCheckerStatus() reports it.
 */
export function startSetupChecker() {
  if (job?.promise) return job.promise;
  const mine = {};
  mine.promise = setupSteps().then(
    (py) => ((job = null), py),
    (err) => {
      job = {
        outcome: {
          reason: err.reason || "failed",
          detail: String(err.message).slice(0, 2000),
          ...(err.pythonVersion ? { pythonVersion: err.pythonVersion } : {}),
        },
      };
      throw err;
    },
  );
  mine.promise.catch(() => {}); // a click nobody awaits must not become an unhandled rejection
  job = mine;
  return mine.promise;
}

/** {state: "off"|"working"|"on"|"failed", reason?, detail?} for the page. "on" means the libraries import right now, whoever set them up. */
export async function setupCheckerStatus() {
  if (job?.promise) return { state: "working" };
  const py = findPython();
  if (py && (await librariesImport(py))) return { state: "on" };
  if (job?.outcome) return { state: "failed", ...job.outcome };
  return { state: "off" };
}

export const resetSetupCheckerForTests = () => {
  job = null;
};

/**
 * The deeper check of a tracked-changes copy (check.py --redline): a second resolver in Python (lxml), a reopen with python-docx, and a
 * LibreOffice conversion to ODT in a private profile when LibreOffice is there. Async (the server keeps answering). Resolves to
 * {ran: false, reason} when the checker is not set up, else {ran: true, ok, why, skipped}. A check that breaks or times out is a failed
 * check (ran: true, ok: false), never a pass.
 */
export function deepRedline(preBytes, postBytes, outBytes) {
  const py = findPython();
  if (!py) return Promise.resolve({ ran: false, reason: "not_set_up" });
  return new Promise((resolve) => {
    let dir = fs.mkdtempSync(path.join(os.tmpdir(), "onionskin-redline-"));
    const files = ["pre", "post", "out"].map((n) => path.join(dir, `${n}.docx`));
    let out = "";
    let settled = false;
    let child = null;
    let timer = null;
    const killer = gracefulKill(() => child);
    const cleanupDir = () => {
      if (!dir) return;
      const d = dir;
      dir = null;
      stopRemainingSoffice(d);
      fs.rmSync(d, { recursive: true, force: true });
    };
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!child?.pid || child.exitCode !== null || child.signalCode !== null) cleanupDir();
      resolve(r);
    };
    try {
      [preBytes, postBytes, outBytes].forEach((b, k) => fs.writeFileSync(files[k], b));
      child = spawn(py, ["-I", CHECK_SCRIPT, "--redline", ...files], { env: checkerEnv(dir), stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return finish({ ran: true, ok: false, why: "the deeper check could not start" });
    }
    timer = setTimeout(() => {
      killer.terminate();
      finish({ ran: true, ok: false, why: "the deeper check timed out" });
    }, CHECK_TIMEOUT_MS());
    child.stdout.on("data", (c) => (out += c).length > 1e6 && killer.terminate());
    child.once("error", () => {
      killer.clear();
      finish({ ran: true, ok: false, why: "the deeper check could not start" });
    });
    child.once("close", (code) => {
      killer.clear();
      cleanupDir();
      if (code === 3) return finish({ ran: false, reason: "libraries_missing" });
      let j = null;
      try {
        j = JSON.parse(out);
      } catch {}
      if (code !== 0 || !j || typeof j.ok !== "boolean") return finish({ ran: true, ok: false, why: "the deeper check failed to run" });
      finish({ ran: true, ok: j.ok, why: String(j.why || "").slice(0, 200), skipped: Array.isArray(j.skipped) ? j.skipped : [] });
    });
  });
}
