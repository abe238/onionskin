import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "os-wave1c-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const until = async (fn, ms = 10_000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 40));
  }
  return false;
};

// ---- INS-01: scripts/get.sh symlink and path-traversal checks -------------------------------------------------------

function makeZipFromStage(stageDir, zipPath, extraZipArgs = []) {
  const r = spawnSync("/usr/bin/zip", ["-X", "-r", "-q", ...extraZipArgs, zipPath, "."], { cwd: stageDir });
  assert.equal(r.status, 0, r.stderr);
  fs.writeFileSync(`${zipPath}.sha256`, `${sha256(fs.readFileSync(zipPath))}  onionskin.zip\n`);
}

function runGetSh(zipPath, tdir) {
  return spawnSync("/bin/sh", [path.join(repo, "scripts", "get.sh")], {
    encoding: "utf8",
    env: {
      HOME: path.join(tmp, "get-home"),
      TMPDIR: tdir,
      PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
      ONIONSKIN_ZIP_URL: `file://${zipPath}`,
      ONIONSKIN_SHA256_URL: `file://${zipPath}.sha256`,
    },
  });
}

test("INS-01: get.sh rejects zip entries with symlinks or '..' path traversal before unpacking, while allowing 'a..b.txt'", () => {
  // 1. Symlink inside onionskin/
  {
    const dir = path.join(tmp, "ins-sym");
    const stage = path.join(dir, "stage");
    fs.mkdirSync(path.join(stage, "onionskin"), { recursive: true });
    fs.writeFileSync(path.join(stage, "onionskin", "install.sh"), `#!/bin/sh\ntouch "${dir}/ran"\n`);
    fs.symlinkSync("/etc/passwd", path.join(stage, "onionskin", "link"));
    const zipPath = path.join(dir, "onionskin.zip");
    makeZipFromStage(stage, zipPath, ["-y"]);
    const tdir = path.join(dir, "tmp");
    fs.mkdirSync(tdir);
    const r = runGetSh(zipPath, tdir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /symlink/);
    assert.equal(fs.existsSync(path.join(dir, "ran")), false);
    assert.deepEqual(fs.readdirSync(tdir), []);
  }

  // 2. Path traversal without trailing slash (`onionskin/..` or `onionskin/../evil`) via raw zip entry crafted with python3
  {
    const dir = path.join(tmp, "ins-dotdot");
    fs.mkdirSync(dir, { recursive: true });
    const zipPath = path.join(dir, "onionskin.zip");
    const py = spawnSync(
      "python3",
      [
        "-c",
        `import zipfile, sys
with zipfile.ZipFile(sys.argv[1], "w") as z:
  z.writestr("onionskin/install.sh", "#!/bin/sh\\ntouch ${dir}/ran\\n")
  z.writestr("onionskin/..", b"x")`,
        zipPath,
      ],
      { encoding: "utf8" },
    );
    assert.equal(py.status, 0, py.stderr);
    fs.writeFileSync(`${zipPath}.sha256`, `${sha256(fs.readFileSync(zipPath))}  onionskin.zip\n`);
    const tdir = path.join(dir, "tmp");
    fs.mkdirSync(tdir);
    const r = runGetSh(zipPath, tdir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /outside its onionskin\/ folder/);
    assert.equal(fs.existsSync(path.join(dir, "ran")), false);
  }

  // 3. Legitimate filename containing `..` inside a component (`onionskin/a..b.txt`) is accepted
  {
    const dir = path.join(tmp, "ins-ok");
    const stage = path.join(dir, "stage");
    fs.mkdirSync(path.join(stage, "onionskin"), { recursive: true });
    fs.writeFileSync(path.join(stage, "onionskin", "install.sh"), `#!/bin/sh\ntouch "${dir}/ran"\n`);
    fs.writeFileSync(path.join(stage, "onionskin", "a..b.txt"), "ok");
    const zipPath = path.join(dir, "onionskin.zip");
    makeZipFromStage(stage, zipPath);
    const tdir = path.join(dir, "tmp");
    fs.mkdirSync(tdir);
    const r = runGetSh(zipPath, tdir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(fs.existsSync(path.join(dir, "ran")), true);
  }
});

// ---- PY-01 & PY-02: src/checker.js SIGTERM, deferred dir cleanup, and 5s SIGKILL fallback ---------------------------

test("PY-01 & PY-02: runDeepCheck sends SIGTERM on timeout; startLateSoffice & deepRedline defer dir cleanup until close and fall back to SIGKILL", async () => {
  const pyDir = path.join(tmp, "py-stub");
  fs.mkdirSync(pyDir, { recursive: true });
  const pyStub = path.join(pyDir, "python");
  const logFile = path.join(pyDir, "events.log");

  // Stub python that ignores `-I` and `check.py`, logs its temp dir, handles modes via STUB_CHECK_MODE:
  //   term_slow: traps SIGTERM, writes TERM to log, sleeps 0.25s before exiting
  //   ignore_term: ignores SIGTERM (traps ''), sleeps 30s (tests 5s SIGKILL fallback)
  //   ok_redline: exits 0 with valid redline JSON
  //   ok_late: exits 0 with valid late JSON
  fs.writeFileSync(
    pyStub,
    `#!/bin/sh
if [ "$3" = "--redline" ]; then pre="$4"; else pre="$3"; fi
dir=$(dirname "$pre")
echo "$dir" > "${pyDir}/last.dir"
case "$STUB_CHECK_MODE" in
  term_slow)
    trap 'echo "TERM" >> "${logFile}"; sleep 0.25; exit 0' TERM
    echo "READY" >> "${logFile}"
    while :; do sleep 0.05; done
    ;;
  ignore_term)
    trap '' TERM
    echo "READY_HANG" >> "${logFile}"
    exec sleep 30
    ;;
  ok_late)
    echo '{"flags":[],"ran":["soffice-convert"],"skipped":[]}'
    ;;
esac
`,
    { mode: 0o755 },
  );

  const prevPy = process.env.ONIONSKIN_PYTHON;
  const prevTo = process.env.ONIONSKIN_CHECK_TIMEOUT_MS;
  const prevMode = process.env.STUB_CHECK_MODE;
  process.env.ONIONSKIN_PYTHON = pyStub;

  const { runDeepCheck, startLateSoffice, deepRedline } = await import("../src/checker.js");

  try {
    // PY-01: runDeepCheck uses SIGTERM (so trap runs and logs TERM)
    process.env.STUB_CHECK_MODE = "term_slow";
    process.env.ONIONSKIN_CHECK_TIMEOUT_MS = "350";
    fs.rmSync(logFile, { force: true });
    const deepRes = runDeepCheck(Buffer.from("pre"), Buffer.from("post"), "docx");
    assert.equal(deepRes.code, "timed_out");
    const deadline = Date.now() + 2000;
    let logText = "";
    while (Date.now() < deadline) {
      if (fs.existsSync(logFile)) {
        logText = fs.readFileSync(logFile, "utf8");
        if (/TERM/.test(logText)) break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.match(logText, /TERM/, "runDeepCheck sent SIGTERM, not SIGKILL");

    // PY-02 (deepRedline): resolves on timeout, keeps temp dir until child closes, removes on close
    fs.rmSync(logFile, { force: true });
    process.env.STUB_CHECK_MODE = "term_slow";
    process.env.ONIONSKIN_CHECK_TIMEOUT_MS = "150";
    const redRes = await deepRedline(Buffer.from("pre"), Buffer.from("post"), Buffer.from("out"));
    assert.equal(redRes.ran, true);
    assert.equal(redRes.ok, false);
    assert.match(redRes.why, /timed out/);
    const redDir = fs.readFileSync(path.join(pyDir, "last.dir"), "utf8").trim();
    assert.equal(fs.existsSync(redDir), true, "deepRedline temp dir stays alive while child is handling SIGTERM");
    assert.ok(await until(() => !fs.existsSync(redDir), 3000), "deepRedline temp dir is deleted once child closes");

    // PY-02 (startLateSoffice): cancel keeps temp dir until child closes; queued check waits for close
    fs.rmSync(logFile, { force: true });
    process.env.STUB_CHECK_MODE = "term_slow";
    process.env.ONIONSKIN_CHECK_TIMEOUT_MS = "10000";
    let cancelRes;
    const h = startLateSoffice(Buffer.from("pre"), Buffer.from("post"), "docx", (r) => (cancelRes = r));
    assert.ok(await until(() => fs.existsSync(logFile) && fs.readFileSync(logFile, "utf8").includes("READY"), 3000));
    const lateDir = fs.readFileSync(path.join(pyDir, "last.dir"), "utf8").trim();
    h.cancel("stop");
    assert.equal(cancelRes.ran, false);
    assert.equal(fs.existsSync(lateDir), true, "startLateSoffice temp dir stays alive while child is exiting");
    assert.ok(await until(() => !fs.existsSync(lateDir), 3000), "startLateSoffice temp dir is deleted after close");

    // PY-02 (5s SIGKILL fallback): child ignoring SIGTERM is killed by SIGKILL after ~5s and unblocks lateQueue
    fs.rmSync(logFile, { force: true });
    process.env.STUB_CHECK_MODE = "ignore_term";
    process.env.ONIONSKIN_CHECK_TIMEOUT_MS = "120";
    let timedOutRes;
    startLateSoffice(Buffer.from("pre"), Buffer.from("post"), "docx", (r) => (timedOutRes = r));
    assert.ok(await until(() => fs.existsSync(logFile) && fs.readFileSync(logFile, "utf8").includes("READY_HANG"), 3000));
    const hangDir = fs.readFileSync(path.join(pyDir, "last.dir"), "utf8").trim();
    process.env.STUB_CHECK_MODE = "ok_late";
    let nextRes;
    startLateSoffice(Buffer.from("pre"), Buffer.from("post"), "docx", (r) => (nextRes = r));
    assert.ok(await until(() => timedOutRes, 2000), "first check settled on timeout");
    assert.equal(nextRes, undefined, "queued check waits while hung child is alive");
    assert.ok(await until(() => nextRes && !fs.existsSync(hangDir), 8000), "5s SIGKILL fallback killed hung child, cleaned dir, and unblocked lateQueue");
    assert.equal(nextRes.ran, true);
  } finally {
    if (prevPy === undefined) delete process.env.ONIONSKIN_PYTHON;
    else process.env.ONIONSKIN_PYTHON = prevPy;
    if (prevTo === undefined) delete process.env.ONIONSKIN_CHECK_TIMEOUT_MS;
    else process.env.ONIONSKIN_CHECK_TIMEOUT_MS = prevTo;
    if (prevMode === undefined) delete process.env.STUB_CHECK_MODE;
    else process.env.STUB_CHECK_MODE = prevMode;
  }
});

test("V7: runDeepCheck returns timed_out within timeout + 3s even when python handles SIGTERM inside a long native call", async () => {
  const pyDir = path.join(tmp, "py-v7");
  fs.mkdirSync(pyDir, { recursive: true });
  const stuckPy = path.join(pyDir, "stuck.py");
  const pidFile = path.join(pyDir, "pid");
  fs.writeFileSync(
    stuckPy,
    `import signal, sys, hashlib, os, pathlib
os.setsid()  # Only a direct signal from the runner can end this check.
pathlib.Path(${JSON.stringify(pidFile)}).write_text(str(os.getpid()))
def on_term(*_):
    sys.exit(143)
signal.signal(signal.SIGTERM, on_term)
hashlib.pbkdf2_hmac("sha256", b"x", b"y", 60_000_000)
`,
  );
  const pyStub = path.join(pyDir, "python");
  fs.writeFileSync(pyStub, `#!/bin/sh\nexec python3 -I ${JSON.stringify(stuckPy)}\n`, { mode: 0o755 });

  const prevPy = process.env.ONIONSKIN_PYTHON;
  const prevTo = process.env.ONIONSKIN_CHECK_TIMEOUT_MS;
  process.env.ONIONSKIN_PYTHON = pyStub;
  process.env.ONIONSKIN_CHECK_TIMEOUT_MS = "1000";
  const { runDeepCheck } = await import("../src/checker.js");
  try {
    const t0 = Date.now();
    const res = runDeepCheck(Buffer.from("pre"), Buffer.from("post"), "docx");
    const elapsed = Date.now() - t0;
    assert.equal(res.code, "timed_out");
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "the runner reaped the checker before returning");
    assert.ok(elapsed < 4000, `expected return within limit (1s) + 3s, took ${elapsed}ms`);
  } finally {
    if (fs.existsSync(pidFile)) {
      const pid = Number(fs.readFileSync(pidFile, "utf8"));
      if (pid > 1) try { process.kill(pid, "SIGKILL"); } catch {}
    }
    if (prevPy === undefined) delete process.env.ONIONSKIN_PYTHON;
    else process.env.ONIONSKIN_PYTHON = prevPy;
    if (prevTo === undefined) delete process.env.ONIONSKIN_CHECK_TIMEOUT_MS;
    else process.env.ONIONSKIN_CHECK_TIMEOUT_MS = prevTo;
  }
});

test("a checker that exits while a descendant holds its pipes returns at the deadline", async () => {
  const checker = path.join(tmp, "exit-with-open-pipes");
  const pidFile = path.join(tmp, "pipe-pid");
  fs.writeFileSync(checker, `#!/bin/sh\nsleep 4 &\necho "$!" > "${pidFile}"\n`, { mode: 0o755 });
  const { runDeepCheck } = await import("../src/checker.js");
  const prevPy = process.env.ONIONSKIN_PYTHON;
  const prevTo = process.env.ONIONSKIN_CHECK_TIMEOUT_MS;
  process.env.ONIONSKIN_PYTHON = checker;
  process.env.ONIONSKIN_CHECK_TIMEOUT_MS = "400";
  try {
    const start = Date.now();
    const res = runDeepCheck(Buffer.from("pre"), Buffer.from("post"), "docx");
    assert.equal(res.code, "timed_out");
    assert.ok(Date.now() - start < 1800, "returned without waiting for the inherited pipes to close");
  } finally {
    if (prevPy === undefined) delete process.env.ONIONSKIN_PYTHON;
    else process.env.ONIONSKIN_PYTHON = prevPy;
    if (prevTo === undefined) delete process.env.ONIONSKIN_CHECK_TIMEOUT_MS;
    else process.env.ONIONSKIN_CHECK_TIMEOUT_MS = prevTo;
    if (fs.existsSync(pidFile)) {
      const pid = Number(fs.readFileSync(pidFile, "utf8"));
      if (pid > 1) try { process.kill(pid, "SIGKILL"); } catch {}
    }
  }
});

// ---- AI-01: monotonic totalPairs in voice-store & voice.js ---------------------------------------------------------

test("AI-01: totalPairs grows past MAX_PAIRS, 'Not now' expires after LATER_AFTER new pairs, and legacy files stay compatible", async () => {
  const st = path.join(tmp, "voice-st");
  const prevState = process.env.ONIONSKIN_STATE_DIR;
  process.env.ONIONSKIN_STATE_DIR = st;
  const store = await import(`../src/voice-store.js?ai01=${Date.now()}`);
  const { LATER_AFTER, suggestions } = await import("../src/voice.js");
  const { ensureStateDir } = await import("../src/paths.js");
  ensureStateDir();
  const evPath = path.join(st, "voice-evidence.json");
  const sig = (short = true) => ({ short, sentences: false, exclaim: false, restored: false, fmt: false });

  try {
    // 1. Legacy file without totalPairs (10 pairs): backwards compatible
    fs.writeFileSync(
      evPath,
      JSON.stringify({ v: 1, learning: true, pairs: Array.from({ length: 10 }, (_, i) => ({ at: i + 1, ...sig() })), hits: [], examples: [], answers: {} }),
      { mode: 0o600 },
    );
    assert.equal(suggestions(store.readEvidence(), { traits: [] })[0]?.trait, "short");
    assert.deepEqual(store.setAnswer("short", "later").answers.short, { later: 10 });
    assert.deepEqual(suggestions(store.readEvidence(), { traits: [] }), [], "held back at 10 - 10 < 4");

    // Appending 1 pair initializes totalPairs from existing 10 -> 11
    const afterOne = store.appendRecords({ pairs: [sig()] }, 100);
    assert.equal(afterOne.totalPairs, 11);
    assert.equal(afterOne.pairs.length, 11);

    // 2. Push past MAX_PAIRS (30) and record "Not now" when window is full
    for (let i = 0; i < 21; i++) store.appendRecords({ pairs: [sig()] }, 200 + i);
    const full = store.readEvidence();
    assert.equal(full.pairs.length, store.MAX_PAIRS);
    assert.equal(full.totalPairs, 32);
    assert.deepEqual(store.setAnswer("short", "later").answers.short, { later: 32 });
    assert.deepEqual(suggestions(store.readEvidence(), { traits: [] }), [], "held right after Not now");

    // 3 more pairs -> still held
    for (let i = 0; i < LATER_AFTER - 1; i++) store.appendRecords({ pairs: [sig()] }, 300 + i);
    assert.equal(store.readEvidence().totalPairs, 35);
    assert.deepEqual(suggestions(store.readEvidence(), { traits: [] }), [], "still held at 35 - 32 = 3 < 4");

    // 4th new pair -> offered again even though pairs.length stays capped at 30
    store.appendRecords({ pairs: [sig()] }, 400);
    const afterFour = store.readEvidence();
    assert.equal(afterFour.pairs.length, store.MAX_PAIRS);
    assert.equal(afterFour.totalPairs, 36);
    assert.equal(suggestions(afterFour, { traits: [] })[0]?.trait, "short");
  } finally {
    if (prevState === undefined) delete process.env.ONIONSKIN_STATE_DIR;
    else process.env.ONIONSKIN_STATE_DIR = prevState;
  }
});

// ---- AI-02: NFKC + look-alike dot folding + invisible stripping in question.js & voice-guide.js --------------------

test("AI-02: cleanQuestion blocks ://, www., emails, and look-alike/invisible obfuscations while allowing ordinary text and bare domains", async () => {
  const { cleanQuestion } = await import("../src/question.js");
  const refused = [
    ["Email boss@evil.example now?", ["Yes", "No"]],
    ["Which option?", ["mailto:boss", "Cancel"]],
    ["Which option?", ["foo@bar.example", "Cancel"]],
    ["Visit https://x.example now?", ["Yes", "No"]],
    ["Go to www.x.example today?", ["Yes", "No"]],
    ["Which site?", ["\uFF57\uFF57\uFF57\uFF0Eevil.example", "None"]],
    ["Which site?", ["www\u3002x.example", "None"]],
    ["Which site?", ["www\uFF61x.example", "None"]],
    ["Which site?", ["www\u2024x.example", "None"]],
    ["Which site?", ["w\u200Bww.x.example", "None"]],
    ["Which site?", ["ww\u00ADw.x.example", "None"]],
    ["Go to https\uFF1A\uFF0F\uFF0Fx.example?", ["Yes", "No"]],
    ["Mail a\uFF20b.co?", ["Yes", "No"]],
    ["Mail a@b\u3002example?", ["Yes", "No"]],
  ];
  for (const [ask, options] of refused) {
    const r = cleanQuestion({ ask, options });
    assert.equal(r.code, "bad_question", JSON.stringify([ask, options]));
    assert.match(r.reason, /link/, JSON.stringify([ask, options]));
  }
  const allowed = [
    ["Which item, e.g. March 3?", ["U.S. office", "U.K. office"]],
    ["Upgrade to v0.0.5 at 9 a.m.?", ["Yes (3.5%)", "No"]],
    ["That is done.It works now?", ["Yes", "No"]],
    ["Is the crash at main.py:42 the one you mean?", ["Yes", "No"]],
    ["Finished.No changes needed.", ["OK", "Reopen"]],
    ["Step 1.Click Save.", ["Done", "Skip"]],
    ["Fixed.Run the tests.", ["Run", "Later"]],
    ["Use Socket.IO, ADO.NET, or ML.NET?", ["Socket.IO", "ML.NET"]],
    ["Check app.js:120, file.txt:12, Main.java:17, index.html:30?", ["Yes", "No"]],
    ["Bare domain evil.com is an accepted gap?", ["Yes", "No"]],
  ];
  for (const [ask, options] of allowed) {
    assert.ok(cleanQuestion({ ask, options }).question, JSON.stringify([ask, options]));
  }
});

test("AI-02: cleanVoiceDraft blocks ://, www., emails, and domain/path (with look-alike dots & invisible chars) while allowing ordinary text", async () => {
  const { SECTIONS, cleanVoiceDraft } = await import("../src/voice-guide.js");
  const makeDraft = (words) =>
    SECTIONS.map((s) => `## ${s.title}\n${s.id === "words" ? words : "I write in short, plain lines."}`).join("\n\n") + "\n";

  for (const bad of [
    "Visit https://x.example today.",
    "Visit www.x.example today.",
    "Visit www\u3002x.example today.",
    "Email a@b.example today.",
    "Open evil.example/login now.",
    "Open evil\u3002example/login now.",
    "Open evil\uFF61example/login now.",
    "Open evil\u2024example/login now.",
    "Try \uFF45\uFF56\uFF49\uFF4C\uFF0E\uFF45\uFF58\uFF41\uFF4D\uFF50\uFF4C\uFF45/login today.",
  ]) {
    assert.equal(cleanVoiceDraft(makeDraft(bad)).code, "link_or_markup", bad);
  }
  for (const ok of [
    "Use plain words, e.g. short verbs in the U.S. office.",
    "Meetings at 9 a.m. or 2 p.m., i.e. before 5 p.m.",
    "Release v0.0.5 grew 3.5% with Ph.D. reviewers.",
    "That is done.It works now? Finished.No changes needed.",
    "Step 1.Click Save. Fixed.Run the tests.",
    "Stack: Socket.IO, ADO.NET, ML.NET, Node.js, ASP.NET.",
    "Files: main.py:42, app.js:120, file.txt:12, Main.java:17, index.html:30, report.docx, budget.xlsx.",
  ]) {
    assert.equal(cleanVoiceDraft(makeDraft(ok)).code, undefined, ok);
  }
});

// ---- PKG-01: package.mjs & prepack.mjs scan, regex-escaping, abediaz.ai, vendor verify -----------------------------

test("PKG-01: scanPackagedFiles escapes user regex metacharacters, allows abediaz.ai/abediaz.com, and flags PII/secrets/dotfiles", async () => {
  const { scanPackagedFiles } = await import("../scripts/package.mjs");
  const d = path.join(tmp, "pkg-scan");
  fs.mkdirSync(d, { recursive: true });
  const write = (name, body) => {
    const abs = path.join(d, name);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
    return { rel: name, abs, size: fs.statSync(abs).size };
  };

  // user with regex metacharacters (`a.b+c`) must not throw or match `axb+c`
  const benign = write("src/ok.js", "const x = 'axb+c'; // https://onionskin.abediaz.ai and abediaz.com\n");
  assert.deepEqual(scanPackagedFiles([benign], { home: "/nonexistent/home", user: "a.b+c" }), []);
  assert.deepEqual(scanPackagedFiles([benign], { home: "/nonexistent/home", user: "abediaz" }), []);

  // literal `a.b+c` IS caught
  const literalUser = write("src/leak.js", "const author = 'a.b+c';\n");
  assert.equal(scanPackagedFiles([literalUser], { home: "/nonexistent/home", user: "a.b+c" }).length, 1);

  // standalone `abediaz` (not abediaz.com / abediaz.ai) IS caught
  const bareUser = write("src/bare.js", "const u = 'abediaz';\n");
  assert.equal(scanPackagedFiles([bareUser], { home: "/nonexistent/home", user: "abediaz" }).length, 1);

  // dotfile, secret, /Users/ path, and denylisted word are caught
  const dot = write("src/.env", "SECRET=1\n");
  const sec = write("src/key.js", `const k = '${"AKIA" + "1234567890ABCDEF"}';\n`);
  const usr = write("src/path.js", `const p = '${"/Users" + "/alice/work"}';\n`);
  const deny = write("src/doc.js", `const f = '${"PLAN" + ".md"}';\n`);
  const probs = scanPackagedFiles([dot, sec, usr, deny], { home: "/nonexistent/home", user: "someone" });
  assert.ok(probs.some((p) => p.includes("dotfile")));
  assert.ok(probs.some((p) => p.includes("secret-looking")));
  assert.ok(probs.some((p) => p.includes("/Users/")));
  assert.ok(probs.some((p) => p.includes("denylisted")));
});

test("PKG-01: prepack.mjs runs vendor-engine --verify, checks vendor/parse5 & vendor/engine-node, and scans packaged files", () => {
  const copy = path.join(tmp, "prepack-repo");
  const tracked = execFileSync("/usr/bin/git", ["-C", repo, "ls-files", "-co", "--exclude-standard", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  for (const f of tracked) {
    const from = path.join(repo, f);
    if (!fs.existsSync(from) || fs.lstatSync(from).isSymbolicLink() || !fs.statSync(from).isFile()) continue;
    fs.mkdirSync(path.dirname(path.join(copy, f)), { recursive: true });
    fs.copyFileSync(from, path.join(copy, f));
  }
  // Stub built artifacts so ONIONSKIN_PREPACK_SKIP_BUILD=1 can run prepack without swiftc/vite
  fs.mkdirSync(path.join(copy, "web", "dist"), { recursive: true });
  fs.writeFileSync(path.join(copy, "web", "dist", "index.html"), "<!doctype html><title>t</title>\n");
  fs.mkdirSync(path.join(copy, "scripts", "rewriter", "apple"), { recursive: true });
  fs.writeFileSync(path.join(copy, "scripts", "rewriter", "apple", "onionskin-fm"), Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x00, 0x01]));
  fs.writeFileSync(path.join(copy, "scripts", "rewriter", "apple", "onionskin-fm.json"), '{"sha256":"0","size":6,"target":"arm64-apple-macos26.0"}\n');

  const runPrepack = () =>
    spawnSync(process.execPath, [path.join(copy, "scripts", "prepack.mjs")], {
      cwd: copy,
      encoding: "utf8",
      env: { ...process.env, ONIONSKIN_PREPACK_SKIP_BUILD: "1" },
    });

  // 1. Clean copy passes (including abediaz.ai in package.json and abediaz.com in README.md)
  const ok = runPrepack();
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);

  // 2. Tampering vendor/parse5/parse5.mjs fails vendor verification
  const p5 = path.join(copy, "vendor", "parse5", "parse5.mjs");
  const origP5 = fs.readFileSync(p5);
  fs.writeFileSync(p5, "// tampered\n");
  const badVendor = runPrepack();
  assert.notEqual(badVendor.status, 0);
  assert.match(badVendor.stderr, /vendor/i);
  fs.writeFileSync(p5, origP5);

  // 3. A dotfile or PII inside a packaged folder (src/) fails prepack scan
  const leak = path.join(copy, "src", ".env");
  fs.writeFileSync(leak, "TOKEN=1\n");
  const badScan = runPrepack();
  assert.notEqual(badScan.status, 0);
  assert.match(badScan.stderr, /dotfile: src\/\.env/);
  fs.rmSync(leak);
});
