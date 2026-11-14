import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCT, env } from "./constants.js";
import { stateDir } from "./paths.js";

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
    fs.writeFileSync(pre, preBytes);
    fs.writeFileSync(post, postBytes);
    const r = spawnSync(py, ["-I", CHECK_SCRIPT, pre, post, format, ...(deferSoffice ? ["--no-soffice"] : [])], { encoding: "utf8", timeout: CHECK_TIMEOUT_MS(), maxBuffer: 16 * 1024 * 1024, env: process.env, killSignal: "SIGKILL" });
    if (r.error?.code === "ETIMEDOUT") return { ran: false, code: "timed_out", flags: [{ code: "deep_check_failed", severity: "warn", detail: `timed out after ${CHECK_TIMEOUT_MS() / 1000}s` }], reason: "the deeper check timed out" };
    if (r.error) return { ran: false, code: "failed", flags: [{ code: "deep_check_failed", severity: "warn", detail: r.error.message }], reason: "the deeper check could not start" };
    let j;
    try {
      j = JSON.parse(r.stdout);
    } catch {
      j = null;
    }
    if (r.status === 3) return { ran: false, flags: [], code: "libraries_missing", reason: `${py} lacks lxml/defusedxml: run \`${PRODUCT.bin} setup-checker\`` };
    if (r.status !== 0 || !j || !Array.isArray(j.flags)) {
      const why = (j?.error || r.stderr || `exit ${r.status}`).toString().slice(0, 300);
      return { ran: false, code: "failed", flags: [{ code: "deep_check_failed", severity: "warn", detail: why }], reason: "the deeper check failed to run" };
    }
    const skipped = j.skipped || [];
    const pending = skipped.some((x) => x.check === "soffice-convert" && x.pending);
    return { ran: true, flags: j.flags, checksRun: j.ran, skipped: pending ? skipped.filter((x) => !x.pending) : skipped, sofficePending: pending, python: py };
  } finally {
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
  const finish = (r) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    // the next one starts only when this one's process is really gone (a cancelled or timed-out check takes a moment to die)
    if (started && child?.pid && child.exitCode === null && child.signalCode === null) child.once("close", lateNext);
    else if (started) lateNext();
    else {
      const at = lateQueue.indexOf(start);
      if (at >= 0) lateQueue.splice(at, 1);
    }
    try {
      onDone(r);
    } catch {}
  };
  const cancel = (reason = "the check was cancelled") => {
    if (settled) return;
    if (child && child.exitCode === null) child.kill("SIGTERM");
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
      child = spawn(py, ["-I", CHECK_SCRIPT, pre, post, format, "--soffice-only"], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      return finish({ ran: false, flags: [], skipped: [], reason: `could not start: ${err.message}` });
    }
    let out = "";
    child.stdout.on("data", (d) => (out = (out + d).slice(0, 16 * 1024 * 1024)));
    child.stderr.resume();
    child.once("error", (err) => finish({ ran: false, flags: [], skipped: [], reason: `could not start: ${err.message}` }));
    child.once("close", (code) => {
      let j = null;
      try {
        j = JSON.parse(out);
      } catch {}
      if (code === 0 && j && Array.isArray(j.flags)) finish({ ran: (j.ran || []).includes("soffice-convert"), flags: j.flags, skipped: j.skipped || [], reason: (j.skipped || [])[0]?.reason });
      else finish({ ran: false, flags: [], skipped: [], reason: (j?.error || `exit ${code}`).toString().slice(0, 200) });
    });
    timer = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGTERM");
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
export function setupChecker(log = (s) => process.stderr.write(s + "\n")) {
  const base = process.env[`${PRODUCT.envPrefix}_BASE_PYTHON`] || "python3";
  fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  const steps = [
    [base, ["-m", "venv", venvDir()]],
    [venvPython(), ["-m", "pip", "install", "--disable-pip-version-check", "--quiet", "-r", CHECKER_REQUIREMENTS]],
  ];
  for (const [cmd, args] of steps) {
    log(`$ ${path.basename(cmd)} ${args.slice(0, 3).join(" ")} ...`);
    const r = spawnSync(cmd, args, { stdio: ["ignore", "inherit", "inherit"] });
    if (r.status !== 0) throw new Error(`${cmd} ${args.slice(0, 2).join(" ")} failed (${r.error?.message || `exit ${r.status}`})`);
  }
  const probe = spawnSync(venvPython(), ["-c", "import lxml, docx, openpyxl, pptx, defusedxml"], { encoding: "utf8" });
  if (probe.status !== 0) throw new Error(`the venv was created but the libraries do not import: ${probe.stderr}`);
  return venvPython();
}

// ---- the same setup, for the browser (POST /api/setup-checker) -----------------------------------------------------
// The server must keep answering while pip runs (about a minute), so this variant spawns instead of spawnSync. One job at a time for the
// whole server: a second start while one runs gets the same promise. The job's outcome is kept until the next start so the page can poll it.
const SETUP_TIMEOUT_MS = () => Number(env("SETUP_TIMEOUT_MS", 10 * 60_000));
export const NETWORK_WORDS = /could not resolve|name or service not known|nodename nor servname|temporary failure in name resolution|failed to establish a new connection|connection (?:error|refused|reset|timed out)|network is unreachable|no matching distribution|max retries exceeded|read timed out|ssl|proxy/i;
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
  const pip = await run(venvPython(), ["-m", "pip", "install", "--disable-pip-version-check", "--quiet", "-r", CHECKER_REQUIREMENTS], SETUP_TIMEOUT_MS());
  if (pip.status !== 0) {
    const text = `pip install failed (${pip.error?.message || `exit ${pip.status}`}) ${pip.stderr}`.trim();
    throw Object.assign(new Error(text), { reason: NETWORK_WORDS.test(text) ? "no_network" : "failed" });
  }
  if (!(await librariesImport(venvPython()))) throw Object.assign(new Error("the venv was created but the libraries do not import"), { reason: "failed" });
  // runs use findPython(): an ONIONSKIN_PYTHON that points elsewhere would keep the checker off after a "successful" setup
  const used = findPython();
  if (used !== venvPython() && !(await librariesImport(used))) throw Object.assign(new Error(`the venv is ready, but ${PRODUCT.envPrefix}_PYTHON points at ${used}, which lacks the libraries: unset it`), { reason: "failed" });
  return venvPython();
}

/**
 * Starts the setup (or joins the one that is running) and returns its promise. It resolves to the venv's python, or rejects with an error that
 * carries `reason`: no_python | no_network | failed. The caller does not need to await it; setupCheckerStatus() reports it.
 */
export function startSetupChecker() {
  if (job?.promise) return job.promise;
  const mine = {};
  mine.promise = setupSteps().then(
    (py) => ((job = null), py),
    (err) => {
      job = { outcome: { reason: err.reason || "failed", detail: String(err.message).slice(0, 2000) } };
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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "onionskin-redline-"));
    const files = ["pre", "post", "out"].map((n) => path.join(dir, `${n}.docx`));
    [preBytes, postBytes, outBytes].forEach((b, k) => fs.writeFileSync(files[k], b));
    let out = "";
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fs.rmSync(dir, { recursive: true, force: true });
      resolve(r);
    };
    const child = spawn(py, ["-I", CHECK_SCRIPT, "--redline", ...files], { env: process.env, stdio: ["ignore", "pipe", "ignore"] });
    const timer = setTimeout(() => (child.kill("SIGTERM"), finish({ ran: true, ok: false, why: "the deeper check timed out" })), CHECK_TIMEOUT_MS());
    child.stdout.on("data", (c) => (out += c).length > 1e6 && child.kill("SIGTERM"));
    child.on("error", () => finish({ ran: true, ok: false, why: "the deeper check could not start" }));
    child.on("close", (code) => {
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
