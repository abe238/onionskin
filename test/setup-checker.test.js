import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { tmpdir, docxBytes } from "./helpers/zipbuild.js";

// The in-page "Turn on deeper checks" button: the async setup, its single flight, its failure reasons, and the browser route.
// A stub script stands in for the base Python: no network, nothing outside the temp dir.
const root = tmpdir();
process.env.ONIONSKIN_STATE_DIR = path.join(root, "st");
process.env.ONIONSKIN_WEB_DIST = path.join(root, "dist");
process.env.ONIONSKIN_TICK_MS = "100000";
delete process.env.ONIONSKIN_PYTHON;
fs.mkdirSync(process.env.ONIONSKIN_WEB_DIST);
fs.writeFileSync(path.join(process.env.ONIONSKIN_WEB_DIST, "index.html"), "<!doctype html><title>t</title>");
const { startServer } = await import("../src/server.js");
const C = await import("../src/checker.js");
const { checkPackages } = await import("../src/package.js");
const { socketPath, stateDir } = await import("../src/paths.js");

const venv = () => path.join(stateDir(), "venv");
const log = path.join(root, "calls.log");
const pipArgsLog = path.join(root, "pip-args.log");
/** A base Python that makes a venv whose python is also a stub. pip: ok | net | other | no_dist | hash_mismatch; imports: whether the library probe passes; delayMs: pip duration. */
function stub(name, { pip = "ok", imports = true, delayMs = 0, venvOk = true, version = "Python 3.9.6" } = {}) {
  const pipBehavior =
    pip === "net"
      ? 'echo "WARNING: Retrying (Retry(total=4, connect=None, read=None, redirect=None, status=None)) after connection broken by NewConnectionError: Failed to establish a new connection: [Errno 8] nodename nor servname provided, or not known: /simple/lxml/" >&2; exit 1'
      : pip === "net_and_nodist"
        ? 'echo "WARNING: Retrying (Retry(total=0, connect=None, read=None, redirect=None, status=None)) after connection broken by NewConnectionError: Failed to establish a new connection: [Errno 61] Connection refused: /simple/lxml/" >&2; echo "ERROR: Could not fetch URL http://127.0.0.1:9/simple/lxml/: There was a problem confirming the connection" >&2; echo "ERROR: Could not find a version that satisfies the requirement lxml==5.3.0 (from versions: none)" >&2; echo "ERROR: No matching distribution found for lxml==5.3.0" >&2; exit 1'
      : pip === "no_dist"
        ? 'echo "ERROR: Ignored the following versions that require a different python version: 13.0.0 Requires-Python >=3.11" >&2; echo "ERROR: Could not find a version that satisfies the requirement pillow==13.0.0 (from -r requirements.txt)" >&2; echo "ERROR: No matching distribution found for pillow==13.0.0" >&2; exit 1'
        : pip === "hash_mismatch"
          ? 'echo "ERROR: THESE PACKAGES DO NOT MATCH THE HASHES FROM THE REQUIREMENTS FILE. If you have updated the package versions, please update the hashes." >&2; exit 1'
          : pip === "other"
            ? 'echo "ERROR: some pip problem" >&2; exit 1'
            : "exit 0";
  const f = path.join(root, name);
  fs.writeFileSync(f, `#!/bin/sh
if [ "$1" = "-m" ] && [ "$2" = "venv" ]; then
  echo venv >> "${log}"
  ${venvOk ? "" : "echo 'No module named venv' >&2; exit 1"}
  mkdir -p "$3/bin"
  cat > "$3/bin/python" <<'INNER'
#!/bin/sh
case "$*" in
  *"-m pip"*) printf '%s\n' "$*" >> "${pipArgsLog}"; ${delayMs ? `sleep ${delayMs / 1000};` : ""} ${pipBehavior} ;;
  *"-c"*) ${imports && pip === "ok" ? "exit 0" : 'echo "ModuleNotFoundError: No module named lxml" >&2; exit 1'} ;;
  "--version") echo "${version}"; exit 0 ;;
esac
exit 0
INNER
  chmod +x "$3/bin/python"
  exit 0
fi
exit 1
`, { mode: 0o755 });
  return f;
}
const reset = () => {
  fs.rmSync(venv(), { recursive: true, force: true });
  fs.rmSync(log, { force: true });
  fs.rmSync(pipArgsLog, { force: true });
  C.resetSetupCheckerForTests();
};
const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").length : 0);

before(() => fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 }));

test("direct checker setup shares one deadline across venv and pip and stops pip's children", async () => {
  reset();
  const base = path.join(root, "slow-direct");
  const marker = path.join(root, "pip-survived");
  fs.writeFileSync(base, `#!/bin/sh
case "$2" in
  venv) sleep 0.4; mkdir -p "$3/bin"; cp "$0" "$3/bin/python" ;;
  pip) echo pip > "${log}"; (trap '' TERM; sleep 1; touch "${marker}") >/dev/null 2>&1 & sleep 0.4 ;;
esac
`, { mode: 0o755 });
  process.env.ONIONSKIN_BASE_PYTHON = base;
  process.env.ONIONSKIN_SETUP_TIMEOUT_MS = "650";
  try {
    await assert.rejects(async () => C.setupChecker(() => {}), /timed out/i);
    assert.equal(fs.readFileSync(log, "utf8").trim(), "pip");
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(fs.existsSync(marker), false);
  } finally {
    delete process.env.ONIONSKIN_SETUP_TIMEOUT_MS;
  }
});

test("a run without a checker says why with a stable code, not only a sentence", () => {
  reset();
  const pre = docxBytes(["One."]);
  const r = checkPackages(pre, pre, "docx");
  assert.equal(r.checks.deep.status, "skipped");
  assert.equal(r.checks.deep.code, "not_set_up");
  assert.match(r.checks.notice, /Deeper check skipped/, "the technical sentence stays for agents");
});

test("an installer stopping during checker setup takes the Python process group with it", async () => {
  reset();
  const base = path.join(root, "ignore-term");
  const marker = path.join(root, "setup-outlived-installer");
  fs.writeFileSync(base, `#!/bin/sh
trap '' TERM
echo ready > "${log}"
sleep 1
touch "${marker}"
exit 1
`, { mode: 0o755 });
  const child = spawn(process.execPath, [fileURLToPath(new URL("../src/cli.js", import.meta.url)), "setup-checker"], {
    env: { ...process.env, ONIONSKIN_BASE_PYTHON: base }, stdio: "ignore",
  });
  const closed = new Promise((resolve) => child.once("close", resolve));
  try {
    for (let i = 0; i < 100 && !fs.existsSync(log); i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(fs.existsSync(log), "the stub is running");
    child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 300));
    child.kill("SIGKILL");
    await closed;
    await new Promise((r) => setTimeout(r, 850));
    assert.equal(fs.existsSync(marker), false);
  } finally {
    child.kill("SIGKILL");
  }
});

test("setup: a working base Python gives a venv whose libraries import, and the next check finds it with no restart", async () => {
  reset();
  process.env.ONIONSKIN_BASE_PYTHON = stub("ok");
  assert.equal((await C.setupCheckerStatus()).state, "off");
  await C.startSetupChecker();
  assert.equal(calls(), 1);
  assert.deepEqual(await C.setupCheckerStatus(), { state: "on" });
  assert.equal(C.findPython(), path.join(venv(), "bin", "python"));
});

test("setup is single flight: a second start while one runs joins it", async () => {
  reset();
  process.env.ONIONSKIN_BASE_PYTHON = stub("slow", { delayMs: 400 });
  const a = C.startSetupChecker();
  assert.equal((await C.setupCheckerStatus()).state, "working");
  const b = C.startSetupChecker();
  assert.equal(a, b, "the same running job");
  await a;
  assert.equal(calls(), 1, "one venv was made");
  await C.startSetupChecker(); // finished: a new click may run again (and finds a good venv)
  assert.equal(calls(), 2);
});

test("setup failures name a reason: no Python, no internet, anything else; the exit-0 failure (libraries do not import) is a failure", async () => {
  reset();
  process.env.ONIONSKIN_BASE_PYTHON = path.join(root, "does-not-exist");
  await assert.rejects(C.startSetupChecker());
  let s = await C.setupCheckerStatus();
  assert.equal(s.state, "failed");
  assert.equal(s.reason, "no_python");
  assert.ok(s.detail, "technical detail is kept for the Details disclosure");

  reset();
  process.env.ONIONSKIN_BASE_PYTHON = stub("net", { pip: "net" });
  await assert.rejects(C.startSetupChecker());
  s = await C.setupCheckerStatus();
  assert.equal(s.reason, "no_network");

  reset();
  process.env.ONIONSKIN_BASE_PYTHON = stub("other", { pip: "other" });
  await assert.rejects(C.startSetupChecker());
  assert.equal((await C.setupCheckerStatus()).reason, "failed");

  reset();
  process.env.ONIONSKIN_BASE_PYTHON = stub("noimport", { imports: false });
  await assert.rejects(C.startSetupChecker());
  s = await C.setupCheckerStatus();
  assert.equal(s.state, "failed", "pip said ok but the libraries do not import: not success");
  assert.equal(s.reason, "failed");

  // a failed attempt does not block the next one
  process.env.ONIONSKIN_BASE_PYTHON = stub("ok2");
  await C.startSetupChecker();
  assert.equal((await C.setupCheckerStatus()).state, "on");
});

test("a good venv that ONIONSKIN_PYTHON overrides with a bad Python is a failure, not a silent off", async () => {
  reset();
  process.env.ONIONSKIN_BASE_PYTHON = stub("ok3");
  process.env.ONIONSKIN_PYTHON = path.join(root, "bad-override");
  fs.writeFileSync(process.env.ONIONSKIN_PYTHON, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  try {
    await assert.rejects(C.startSetupChecker(), /ONIONSKIN_PYTHON points at/);
    assert.equal((await C.setupCheckerStatus()).state, "failed");
  } finally {
    delete process.env.ONIONSKIN_PYTHON;
  }
});

test("status is off for a venv whose libraries do not import", async () => {
  reset();
  process.env.ONIONSKIN_BASE_PYTHON = stub("half", { imports: false });
  await assert.rejects(C.startSetupChecker());
  C.resetSetupCheckerForTests(); // forget the failure; the broken venv is still on disk
  assert.equal((await C.setupCheckerStatus()).state, "off");
});

test("S2/S3: pip install enforces --require-hashes and --only-binary=:all:, and classifies real pip errors", async () => {
  // Async path (browser button)
  reset();
  process.env.ONIONSKIN_BASE_PYTHON = stub("ok-flags");
  await C.startSetupChecker();
  const asyncArgs = fs.readFileSync(pipArgsLog, "utf8").trim();
  assert.match(asyncArgs, /--require-hashes/, "async setup passes --require-hashes");
  assert.match(asyncArgs, /--only-binary=:all:/, "async setup passes --only-binary=:all:");

  // CLI setup-checker
  reset();
  process.env.ONIONSKIN_BASE_PYTHON = stub("ok-flags-sync");
  await C.setupChecker(() => {});
  const syncArgs = fs.readFileSync(pipArgsLog, "utf8").trim();
  assert.match(syncArgs, /--require-hashes/, "CLI setup passes --require-hashes");
  assert.match(syncArgs, /--only-binary=:all:/, "CLI setup passes --only-binary=:all:");

  // Real Python 3.9 failure text (Requires-Python / Ignored the following versions + No matching distribution) -> unsupported_python with version
  reset();
  process.env.ONIONSKIN_BASE_PYTHON = stub("nodist", { pip: "no_dist", version: "Python 3.9.6" });
  await assert.rejects(C.startSetupChecker());
  let s = await C.setupCheckerStatus();
  assert.equal(s.state, "failed");
  assert.equal(s.reason, "unsupported_python");
  assert.equal(s.pythonVersion, "Python 3.9.6");
  assert.match(s.detail, /Python 3\.9\.6/, "detail reports the detected Python version");

  // T2: Real pip error carrying BOTH connection error AND "No matching distribution found" -> MUST map to no_network
  reset();
  process.env.ONIONSKIN_BASE_PYTHON = stub("netnodist", { pip: "net_and_nodist", version: "Python 3.13.0" });
  await assert.rejects(C.startSetupChecker());
  s = await C.setupCheckerStatus();
  assert.equal(s.state, "failed");
  assert.equal(s.reason, "no_network", "connection error + No matching distribution must classify as no_network");

  // Hash mismatch -> failed (NOT no_network, NOT unsupported_python)
  reset();
  process.env.ONIONSKIN_BASE_PYTHON = stub("hashbad", { pip: "hash_mismatch" });
  await assert.rejects(C.startSetupChecker());
  s = await C.setupCheckerStatus();
  assert.equal(s.state, "failed");
  assert.equal(s.reason, "failed");

  // DNS failure -> no_network
  reset();
  process.env.ONIONSKIN_BASE_PYTHON = stub("dnsfail", { pip: "net" });
  await assert.rejects(C.startSetupChecker());
  s = await C.setupCheckerStatus();
  assert.equal(s.state, "failed");
  assert.equal(s.reason, "no_network");
});

// ---- the browser route ---------------------------------------------------------------------------------------
let srv, cookie, token;
const base = () => ({ host: "127.0.0.1", port: srv.port });
const req = (opts, body) =>
  new Promise((resolve, reject) => {
    const r = http.request({ ...base(), ...opts }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() }));
    });
    r.on("error", reject);
    if (body) r.write(body);
    r.end();
  });
const hdr = (extra = {}) => ({ cookie, "x-onionskin-token": token, origin: `http://127.0.0.1:${srv.port}`, "sec-fetch-site": "same-origin", "content-type": "application/json", ...extra });
const json = (r) => JSON.parse(r.text);

test("route: guarded like the other POST routes, takes no parameters, never blocks, and reports progress", async () => {
  reset();
  srv = await startServer();
  try {
    const doc = path.join(root, "d.docx");
    fs.writeFileSync(doc, docxBytes(["Paragraph one."]));
    const open = () =>
      new Promise((resolve, reject) => {
        const r = http.request({ socketPath: socketPath(), method: "POST", path: "/cli/open", headers: { "content-type": "application/json" } }, (res) => {
          let t = "";
          res.on("data", (d) => (t += d));
          res.on("end", () => resolve(JSON.parse(t)));
        });
        r.on("error", reject);
        r.end(JSON.stringify({ file: doc }));
      });
    const u2 = new URL((await open()).url);
    const ex = await new Promise((resolve, reject) => {
      const r = http.request({ ...base(), path: u2.pathname + u2.search, method: "GET" }, (res) => {
        let t = "";
        res.on("data", (d) => (t += d));
        res.on("end", () => resolve({ headers: res.headers, text: t }));
      });
      r.on("error", reject);
      r.end();
    });
    cookie = ex.headers["set-cookie"][0].split(";")[0];
    token = /<meta name="onionskin-launch" content="([\w-]+)">/.exec(ex.text)?.[1];
    assert.ok(cookie && token);

    process.env.ONIONSKIN_BASE_PYTHON = stub("route", { delayMs: 500 });
    const post = (headers, body = "{}") => req({ path: "/api/setup-checker", method: "POST", headers }, body);
    // the same guards as every other POST
    const noTok = hdr();
    delete noTok["x-onionskin-token"];
    assert.equal((await post(noTok)).status, 403, "no token");
    assert.equal((await post(hdr({ "x-onionskin-token": "wrong" }))).status, 403);
    assert.equal((await post(hdr({ origin: "http://evil.example" }))).status, 403, "foreign origin");
    assert.equal((await post(hdr({ "sec-fetch-site": "cross-site" }))).status, 403);
    assert.equal((await post(hdr({ "content-type": "text/plain" }))).status, 415);
    assert.equal((await post({ origin: hdr().origin, "sec-fetch-site": "same-origin", "content-type": "application/json" })).status, 401, "no cookie");
    assert.equal((await req({ path: "/api/setup-checker", method: "GET", headers: {} })).status, 401);
    assert.equal(calls(), 0, "none of the refused requests started a setup");

    assert.equal(json(await req({ path: "/api/setup-checker", method: "GET", headers: hdr() })).state, "off");
    // starting answers at once (the setup takes 500 ms) and a second click joins it
    const t0 = Date.now();
    const a = await post(hdr(), JSON.stringify({ ignored: "/etc/passwd", python: "/bin/sh" }));
    assert.equal(a.status, 200);
    assert.ok(Date.now() - t0 < 400, "the route did not wait for the setup");
    assert.equal(json(a).state, "working");
    const b = await post(hdr());
    assert.equal(json(b).state, "working");
    for (let i = 0; i < 50 && json(await req({ path: "/api/setup-checker", method: "GET", headers: hdr() })).state === "working"; i++) await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(json(await req({ path: "/api/setup-checker", method: "GET", headers: hdr() })), { state: "on" });
    assert.equal(calls(), 1, "one setup ran, with no input from the page");
  } finally {
    srv.shutdown();
  }
});

after(() => {
  delete process.env.ONIONSKIN_BASE_PYTHON;
});
