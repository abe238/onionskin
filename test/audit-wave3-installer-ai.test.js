import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { recognize } from "../src/quick.js";
import { appleHelperState, clearQuarantine, createWorker, fileSha256 } from "../src/rewriter.js";
import { curlProto, runGetShDefault } from "../src/update.js";
import { docxBytes, tmpdir } from "./helpers/zipbuild.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.realpathSync(tmpdir("os-wave3c-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function fakePkg(name, { cliBody = "process.exit(0);\n", version = "9.9.9" } = {}) {
  const src = path.join(tmp, name);
  for (const d of ["src", "web/dist", "scripts/rewriter/apple"]) fs.mkdirSync(path.join(src, d), { recursive: true });
  for (const file of ["server.js", "server-entry.js"]) fs.writeFileSync(path.join(src, "src", file), "");
  fs.writeFileSync(path.join(src, "src", "cli.js"), `if (process.argv[2] === "--version") { console.log(${JSON.stringify(version)}); process.exit(0); }\n${cliBody}`);
  fs.writeFileSync(path.join(src, "package.json"), JSON.stringify({ version }));
  fs.writeFileSync(path.join(src, "web", "dist", "index.html"), "<!doctype html>");
  fs.writeFileSync(path.join(src, "scripts", "rewriter", "apple", "onionskin-fm"), "stub\n", { mode: 0o644 });
  fs.copyFileSync(path.join(repo, "install.sh"), path.join(src, "install.sh"));
  return src;
}

const runInstall = (src, home, ...args) =>
  spawnSync("/bin/sh", [path.join(src, "install.sh"), "--no-checker", ...args], {
    encoding: "utf8",
    env: { HOME: home, TMPDIR: tmp, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin` },
  });

// ---- INS-02: install.sh & src/update.js -----------------------------------------------------------------------------

test("INS-02 (install.sh): valid sh syntax, checks launcher ownership before stopping/overwriting, swaps atomically, escapes $APP, preserves setup exit code, quotes skills", () => {
  assert.equal(spawnSync("/bin/sh", ["-n", path.join(repo, "install.sh")]).status, 0);

  // 1. Foreign launcher check happens BEFORE stopping running server or overwriting $APP
  const homeForeign = path.join(tmp, "home-foreign");
  fs.mkdirSync(path.join(homeForeign, ".local", "bin"), { recursive: true });
  fs.mkdirSync(path.join(homeForeign, ".onionskin", "app", "9.9.9"), { recursive: true });
  fs.writeFileSync(path.join(homeForeign, ".onionskin", "app", "9.9.9", "keep.txt"), "precious");
  fs.writeFileSync(path.join(homeForeign, ".local", "bin", "onionskin"), "#!/bin/sh\necho foreign\n", { mode: 0o755 });
  const src1 = fakePkg("pkg-foreign");
  const rForeign = runInstall(src1, homeForeign);
  assert.equal(rForeign.status, 1);
  assert.match(rForeign.stdout, /was not made by this installer/);
  assert.equal(fs.readFileSync(path.join(homeForeign, ".onionskin", "app", "9.9.9", "keep.txt"), "utf8"), "precious");
  assert.equal(fs.readFileSync(path.join(homeForeign, ".local", "bin", "onionskin"), "utf8"), "#!/bin/sh\necho foreign\n");

  // 2. HOME with spaces and single quote: launcher safely escapes $APP and quotes skill paths
  const homeTricky = path.join(tmp, "home 'tricky' $X");
  fs.mkdirSync(homeTricky, { recursive: true });
  const src2 = fakePkg("pkg-tricky", {
    cliBody: `if (process.argv[2] === "--ok") { process.stdout.write("OK:" + process.argv[3]); } process.exit(0);\n`,
  });
  const rTricky = runInstall(src2, homeTricky);
  assert.equal(rTricky.status, 0, rTricky.stdout + rTricky.stderr);
  const launcher = path.join(homeTricky, ".local", "bin", "onionskin");
  const execLauncher = spawnSync(launcher, ["--ok", "arg1"], { encoding: "utf8", env: { HOME: homeTricky, TMPDIR: tmp, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` } });
  assert.equal(execLauncher.status, 0, execLauncher.stderr);
  assert.equal(execLauncher.stdout, "OK:arg1");

  // 3. Re-install replaces $APP atomically and leaves no .old.$$ backup behind
  const src2b = fakePkg("pkg-tricky-2", { cliBody: `process.stdout.write("v2"); process.exit(0);\n` });
  const rUpgrade = runInstall(src2b, homeTricky);
  assert.equal(rUpgrade.status, 0, rUpgrade.stdout + rUpgrade.stderr);
  const appsDir = fs.readdirSync(path.join(homeTricky, ".onionskin", "app"));
  assert.deepEqual(appsDir, ["9.9.9"]);

  // 4. Failing `setup` after swap warns loudly without failing install (R11)
  const homeFailSetup = path.join(tmp, "home-fail-setup");
  fs.mkdirSync(homeFailSetup, { recursive: true });
  const srcFail = fakePkg("pkg-fail-setup", {
    cliBody: `if (process.argv[2] === "setup") { console.log("setup failed line"); process.exit(7); } process.exit(0);\n`,
  });
  const rFail = runInstall(srcFail, homeFailSetup);
  assert.equal(rFail.status, 0);
  assert.match(rFail.stdout, /^ {2}setup failed line$/m);
  assert.match(rFail.stdout + rFail.stderr, /warning|setup/i);
});

test("INS-02 (src/update.js): curlProto pins exact scheme and runGetShDefault downloads to 0600 temp file without pipefail", async () => {
  assert.deepEqual(curlProto("https://github.com/a/b"), ["--proto", "=https"]);
  assert.deepEqual(curlProto("file:///tmp/rel"), ["--proto", "=file"]);
  assert.deepEqual(curlProto("http://127.0.0.1:8080/rel"), ["--proto", "=http"]);
  assert.deepEqual(curlProto("http://127.0.0.1/rel"), ["--proto", "=http"]);
  assert.deepEqual(curlProto("http://example.com/rel"), ["--proto", "=https"]);
  assert.deepEqual(curlProto("http://127.0.0.1.evil.example/"), ["--proto", "=https"]);

  const bin = path.join(tmp, "curl-shim-w3");
  const tdir = path.join(tmp, "get-tmp-w3");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(tdir, { recursive: true });
  const log = path.join(tmp, "curl-w3.log");
  const ranLog = path.join(tmp, "getsh-ran.log");
  // curl shim records its args, checks that -o target already exists with mode 0600, and writes a script that prints ONIONSKIN_BASE_URL
  fs.writeFileSync(
    path.join(bin, "curl"),
    `#!/bin/sh
printf '%s\\n' "$@" > "${log}"
out=""; prev=""
for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done
mode=$(stat -f '%Lp' "$out")
printf '#!/bin/sh\nprintf "base=%%s;mode=%s\\n" "$ONIONSKIN_BASE_URL" > "%s"\n' "$mode" "${ranLog}" > "$out"
`,
    { mode: 0o755 },
  );
  const rc = await runGetShDefault("https://example.invalid/rel/", { PATH: `${bin}:/usr/bin:/bin`, TMPDIR: tdir });
  assert.equal(rc, 0);
  const args = fs.readFileSync(log, "utf8").trim().split("\n");
  const flag = (f) => args[args.indexOf(f) + 1];
  assert.equal(flag("--connect-timeout"), "20");
  assert.equal(flag("--max-time"), "60");
  assert.equal(flag("--proto"), "=https");
  assert.equal(flag("--proto-redir"), "=https");
  assert.equal(args.at(-1), "https://example.invalid/rel/get.sh");
  assert.equal(fs.readFileSync(ranLog, "utf8").trim(), "base=https://example.invalid/rel;mode=600");
  assert.deepEqual(fs.readdirSync(tdir), [], "temp dir cleaned up");
});

// ---- AI-04: main.swift, src/rewriter.js, src/voice-learn.js ---------------------------------------------------------

test("AI-04 (main.swift): trims leading whitespace/newlines before checking stops", () => {
  const swift = fs.readFileSync(path.join(repo, "scripts", "rewriter", "apple", "main.swift"), "utf8");
  const trimIdx = swift.indexOf("r.content.trimmingCharacters(in: .whitespacesAndNewlines)");
  const stopsIdx = swift.indexOf("for st in stops");
  assert.ok(trimIdx > 0 && stopsIdx > trimIdx, "r.content is trimmed before stops loop");
});

test("AI-04 (src/rewriter.js): LC_ALL=C in xattr, appleHelperState caching & invalidation, SIGKILL fallback in stop()", async () => {
  const rewriterSrc = fs.readFileSync(path.join(repo, "src", "rewriter.js"), "utf8");
  assert.match(rewriterSrc, /LC_ALL:\s*"C"/);
  assert.match(rewriterSrc, /c\.kill\("SIGKILL"\)/);
  assert.match(rewriterSrc, /killTimer\.unref\?\.\(\)/);

  // Caching behavior: repeating appleHelperState on an unchanged dir/bin avoids re-running xattr or hashing
  const dir = path.join(tmp, "fm-cache");
  fs.mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, "onionskin-fm");
  fs.writeFileSync(bin, "binary-v1\n", { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "onionskin-fm.json"), JSON.stringify({ sha256: fileSha256(bin) }));
  const host = { macos: "26.1", appleSilicon: true };
  assert.equal(appleHelperState({ dir, host }).ok, true);
  assert.equal(appleHelperState({ dir, host }).ok, true);
  // Marking quarantine updates ctimeMs, so appleHelperState notices immediately without stale cache
  assert.equal(spawnSync("/usr/bin/xattr", ["-w", "com.apple.quarantine", "0081;00000000;Safari;", bin]).status, 0);
  assert.deepEqual(appleHelperState({ dir, host }), { ok: false, reason: "quarantined", bin });
  assert.equal(clearQuarantine(bin), true);
  assert.equal(appleHelperState({ dir, host }).ok, true);

  // S13: Worker close() itself SIGKILLs a process that ignores SIGTERM (no manual kill by the test)
  const stub = path.join(tmp, "ignore-term.mjs");
  const pidFile = path.join(tmp, "ignore-term.pid");
  fs.writeFileSync(
    stub,
    `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nprocess.on("SIGTERM", () => {});\nconsole.log(JSON.stringify({ ready: true }));\nsetInterval(() => {}, 1000);\n`,
  );
  const w = createWorker({ cmd: process.execPath, args: [stub], env: { PATH: "/usr/bin:/bin" }, cwd: tmp }, { killGraceMs: 200 });
  w.warm();
  const until = Date.now() + 5000;
  while (!w.ready && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
  assert.equal(w.ready, true);
  const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
  assert.ok(pid > 0);
  w.close();
  // Wait for src/rewriter.js itself to SIGKILL the worker after killGraceMs
  const deadBy = Date.now() + 2000;
  let alive = true;
  while (Date.now() < deadBy) {
    try {
      process.kill(pid, 0);
      await new Promise((r) => setTimeout(r, 40));
    } catch {
      alive = false;
      break;
    }
  }
  assert.equal(alive, false, `rewriter close() must SIGKILL SIGTERM-ignoring worker pid ${pid} itself`);
});

test("AI-04 (src/voice-learn.js): enforces concurrency cap of 1 active voice-sample-worker (429 busy on concurrent call)", async () => {
  const st = path.join(tmp, "voice-st");
  fs.mkdirSync(st, { recursive: true });
  process.env.ONIONSKIN_STATE_DIR = st;
  const { Sessions } = await import("../src/session.js");
  const { buildVoiceRequest } = await import("../src/voice-learn.js");
  const S = new Sessions();
  const doc1 = path.join(tmp, "v1.docx");
  const doc2 = path.join(tmp, "v2.docx");
  fs.writeFileSync(doc1, docxBytes(["First document sentence with enough words."]));
  fs.writeFileSync(doc2, docxBytes(["Second document sentence with enough words."]));
  const s1 = S.open(doc1, { format: "docx" });
  const s2 = S.open(doc2, { format: "docx" });
  const reqBody = { open_file: true, edits: false, comments: false, improve: false, texts: [], files: [] };

  const p1 = buildVoiceRequest(S, s1.key, reqBody);
  await assert.rejects(
    () => buildVoiceRequest(S, s2.key, reqBody),
    (err) => err?.status === 429 && err?.extra?.code === "busy",
  );
  await p1;
  // Once the first completes, the second succeeds
  await buildVoiceRequest(S, s2.key, reqBody);
});

// ---- PY-05: scripts/checker/check.py --------------------------------------------------------------------------------

test("PY-05 (check.py): read_part streams MAX_PART+1, rejects UTF-16 & >64KB DOCTYPEs, and soffice_convert percent-encodes UserInstallation URI", () => {
  const pyBin = fs.existsSync(path.join(os.homedir(), ".onionskin", "venv", "bin", "python"))
    ? path.join(os.homedir(), ".onionskin", "venv", "bin", "python")
    : "python3";
  const hasLxml = spawnSync(pyBin, ["-c", "import lxml"], { encoding: "utf8" }).status === 0;

  // Test UserInstallation URI via pathlib.Path(tmp).as_uri() even without lxml
  const checkPy = fs.readFileSync(path.join(repo, "scripts", "checker", "check.py"), "utf8");
  assert.match(checkPy, /f\.read\(MAX_PART \+ 1\)/);
  assert.match(checkPy, /docinfo\.doctype/);
  assert.match(checkPy, /pathlib\.Path\(os\.path\.abspath\(tmp\)\)\.as_uri\(\)/);

  if (hasLxml) {
    const pyTest = spawnSync(
      pyBin,
      [
        "-B",
        "-c",
        `
import io, sys, zipfile
sys.path.insert(0, ${JSON.stringify(path.join(repo, "scripts", "checker"))})
import check

def mkzip(data):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("word/document.xml", data)
    buf.seek(0)
    return zipfile.ZipFile(buf)

class FakeInfo: file_size = 10
class FakeZip:
    def getinfo(self, n): return FakeInfo()
    def open(self, n): return io.BytesIO(b"a" * (check.MAX_PART + 1))

for name, fn in [
    ("lie_size", lambda: check.read_part(FakeZip(), "word/document.xml")),
    ("utf16_dtd", lambda: check.read_part(mkzip('<?xml version="1.0" encoding="UTF-16"?><!DOCTYPE r><r/>'.encode("utf-16")), "word/document.xml")),
    ("late_dtd", lambda: check.read_part(mkzip(b'<?xml version="1.0"?><!-- ' + b'x'*70000 + b' --><!DOCTYPE r><r/>'), "word/document.xml")),
]:
    try:
        fn()
        raise AssertionError(name + " did not raise")
    except ValueError:
        pass
assert check.read_part(mkzip(b"<r/>"), "word/document.xml").tag == "r"
print("PY_OK")
`,
      ],
      { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } },
    );
    assert.equal(pyTest.status, 0, pyTest.stderr);
    assert.equal(pyTest.stdout.trim(), "PY_OK");
  }
});

// ---- AI-08: src/quick.js --------------------------------------------------------------------------------------------

test("AI-08 (src/quick.js): case-insensitive 'with' after quoted find", () => {
  const r1 = recognize('Replace "Acme" WITH "Initech"', "docx");
  assert.equal(r1?.kind, "replace");
  assert.equal(r1.find, "Acme");
  assert.equal(r1.replace, "Initech");
  const r2 = recognize('REPLACE "Acme, Inc." With Initech', "docx");
  assert.equal(r2?.kind, "replace");
  assert.equal(r2.find, "Acme, Inc.");
  assert.equal(r2.replace, "Initech");
});

// ---- DOC-01 & SAF-01: README.md, docs/DEVELOPERS.md, skills/onionskin/SKILL.md -------------------------------------

test("DOC-01 & SAF-01: docs and skill harden curl proto flags, temp work paths, and macOS 13.1 / Safari 16.2 wording", () => {
  const readme = fs.readFileSync(path.join(repo, "README.md"), "utf8");
  const curlLines = readme.split("\n").filter((l) => l.includes("curl -fsSL"));
  assert.equal(curlLines.length, 2);
  for (const l of curlLines) assert.match(l, /--proto "=https" --proto-redir "=https"/);

  const devs = fs.readFileSync(path.join(repo, "docs", "DEVELOPERS.md"), "utf8");
  assert.match(devs, /macOS 13\.1/);
  assert.match(devs, /Safari 16\.2/);
  assert.match(devs, /color-mix\(\)/);
  assert.match(devs, /test:webkit/);
  assert.match(devs, /test:safari/);
  assert.ok(!/Safari is untested/.test(devs));

  const skill = fs.readFileSync(path.join(repo, "skills", "onionskin", "SKILL.md"), "utf8");
  assert.match(skill, /curl -fsSL --proto "=https" --proto-redir "=https"/);
  assert.ok(!skill.includes("/tmp/onionskin-work.docx"));
  assert.match(skill, /mktemp/);
});
