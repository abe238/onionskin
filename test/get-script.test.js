import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { baseUrlOk } from "../src/update.js";

// scripts/get.sh is the one-line installer: it downloads a zip, checks its SHA-256, and runs the zip's install.sh. Here the "release" is a
// local folder (file:// URLs) and the zip's install.sh is a stub that records how it was called. A temp TMPDIR and HOME only; no network.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GET = path.join(repo, "scripts", "get.sh");
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "os-get-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");

let n = 0;
/** A release folder: onionskin.zip (+ .sha256) whose install.sh writes its arguments and stdin state to <rel>/ran.txt. */
function release({ extraEntry = null } = {}) {
  const rel = path.join(tmp, `rel${++n}`);
  const top = path.join(rel, "stage", "onionskin");
  fs.mkdirSync(top, { recursive: true });
  fs.writeFileSync(path.join(top, "install.sh"), `#!/bin/sh\nprintf 'args=%s\\nstdin=%s\\n' "$*" "$(cat)" > "${rel}/ran.txt"\n`);
  if (extraEntry) fs.writeFileSync(path.join(rel, "stage", extraEntry), "x");
  const z = spawnSync("/usr/bin/zip", ["-X", "-r", "-q", path.join(rel, "onionskin.zip"), "."], { cwd: path.join(rel, "stage") });
  assert.equal(z.status, 0);
  fs.writeFileSync(path.join(rel, "onionskin.zip.sha256"), `${sha(path.join(rel, "onionskin.zip"))}  onionskin-0.0.1-abc1234.zip\n`);
  return rel;
}
const fileUrl = (p) => `file://${p}`;

function shim(name, body) {
  const dir = path.join(tmp, `shim-${name}-${++n}`);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return dir;
}
function run(args, env = {}, { shimDir = "", script = GET } = {}) {
  const tdir = path.join(tmp, `tmpdir${++n}`);
  fs.mkdirSync(tdir);
  const r = spawnSync("/bin/sh", [script, ...args], {
    encoding: "utf8",
    env: { HOME: path.join(tmp, "home"), TMPDIR: tdir, PATH: `${shimDir ? shimDir + ":" : ""}${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, ...env },
  });
  return { ...r, left: fs.readdirSync(tdir) };
}
const urls = (rel) => ({ ONIONSKIN_ZIP_URL: fileUrl(path.join(rel, "onionskin.zip")), ONIONSKIN_SHA256_URL: fileUrl(path.join(rel, "onionskin.zip.sha256")) });

test("get.sh is valid sh and runs nothing when the download is cut short", () => {
  assert.equal(spawnSync("/bin/sh", ["-n", GET]).status, 0);
  const lines = fs.readFileSync(GET, "utf8").trimEnd().split("\n");
  assert.equal(lines.at(-1), 'main "$@"', "the last line is the only call");
  const cut = path.join(tmp, "cut.sh");
  fs.writeFileSync(cut, lines.slice(0, -4).join("\n") + "\n"); // a download that stopped inside main()
  const r = run([], {}, { script: cut });
  assert.notEqual(r.status, 0, "a half script is a syntax error, not a half install");
  assert.ok(!/Onionskin one-line installer/.test(r.stdout), "nothing ran");
});

test("get.sh: happy path verifies the hash, forwards options to install.sh with stdin closed, and removes its temp folder", () => {
  const rel = release();
  const r = run(["--no-checker"], urls(rel));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /checksum ok \([0-9a-f]{64}\)/);
  assert.equal(fs.readFileSync(path.join(rel, "ran.txt"), "utf8"), "args=--no-checker\nstdin=\n");
  assert.deepEqual(r.left, [], "temp folder deleted");
});

test("get.sh: a wrong checksum stops before anything is unzipped or run", () => {
  const rel = release();
  fs.writeFileSync(path.join(rel, "onionskin.zip.sha256"), `${"0".repeat(64)}  onionskin.zip\n`);
  const r = run([], urls(rel));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /checksum does not match, so nothing was unzipped or installed/);
  assert.equal(fs.existsSync(path.join(rel, "ran.txt")), false);
  assert.deepEqual(r.left, []);
});

test("get.sh: ONIONSKIN_SHA256 replaces the checksum file; a malformed value or file is refused", () => {
  const rel = release();
  fs.writeFileSync(path.join(rel, "onionskin.zip.sha256"), "garbage\n");
  const bad = run([], urls(rel));
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /does not start with a SHA-256 hash/);
  const ok = run([], { ...urls(rel), ONIONSKIN_SHA256: sha(path.join(rel, "onionskin.zip")).toUpperCase() });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  const short = run([], { ...urls(rel), ONIONSKIN_SHA256: "abc" });
  assert.equal(short.status, 1);
  assert.match(short.stderr, /64 hex characters/);
});

test("get.sh: a zip with files outside onionskin/ is refused", () => {
  const rel = release({ extraEntry: "evil.txt" });
  const r = run([], urls(rel));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /outside its onionskin\/ folder/);
  assert.equal(fs.existsSync(path.join(rel, "ran.txt")), false);
});

test("get.sh: --dry-run downloads nothing and changes nothing; plain http and odd schemes are refused", () => {
  const dry = run(["--dry-run"], { ONIONSKIN_ZIP_URL: "https://example.invalid/onionskin.zip" });
  assert.equal(dry.status, 0, dry.stdout + dry.stderr);
  assert.match(dry.stdout, /\[dry run\] would download the zip/);
  assert.deepEqual(dry.left, []);
  assert.equal(fs.existsSync(path.join(tmp, "home")), false);
  for (const u of ["http://example.com/onionskin.zip", "ftp://example.com/x.zip", "/etc/passwd"]) {
    const r = run([], { ONIONSKIN_ZIP_URL: u });
    assert.equal(r.status, 1, u);
    assert.match(r.stderr, /refusing the URL/, u);
  }
});

test("get.sh refuses root, a non-macOS system, a missing Node and an old Node, each with nothing changed", () => {
  const root = run([], {}, { shimDir: shim("id", "echo 0") });
  assert.equal(root.status, 1);
  assert.match(root.stderr, /do not run this as root/);
  const linux = run([], {}, { shimDir: shim("uname", "echo Linux") });
  assert.equal(linux.status, 1);
  assert.match(linux.stderr, /macOS only/);
  const old = run([], {}, { shimDir: shim("node", "echo v20.11.0") });
  assert.equal(old.status, 1);
  assert.match(old.stderr, /too old; 22 or newer is required/);
  const none = spawnSync("/bin/sh", [GET], { encoding: "utf8", env: { HOME: path.join(tmp, "home"), PATH: "/usr/bin:/bin" } });
  assert.equal(none.status, 1, "this test needs a machine with no node in /usr/bin");
  assert.match(none.stderr, /Node.js 22 or newer is required and was not found/);
  assert.equal(fs.existsSync(path.join(tmp, "home")), false);
});

test("package.json is ready for npm pack: bin, files whitelist without the voice guide, and a prepack that builds", () => {
  const p = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
  assert.equal(p.name, "onionskin-cli");
  assert.equal(p.bin.onionskin, "src/cli.js");
  assert.ok(p.files.includes("web/dist") && p.files.includes("scripts/rewriter") && p.files.includes("skills/onionskin"));
  assert.ok(p.files.includes("!skills/onionskin/voice.md"), "the maintainer's voice guide never goes into a tarball");
  assert.equal(p.scripts.prepack, "node scripts/prepack.mjs");
  assert.ok(!p.files.includes("test") && !p.files.includes("e2e") && !p.files.includes("scripts"), "no tests, no whole scripts folder");
});

// One rule for a release URL, in get.sh and in `onionskin update` (src/update.js baseUrlOk): https, file:///, or http to exactly
// 127.0.0.1 with an optional port; no "@", white space or backslash before the first "/" after the scheme. Outside review:
// http://127.0.0.1:80@evil.example/release passed both, and its host is evil.example.
const URLS_OK = ["https://github.com/abe238/onionskin/releases/latest/download", "https://example.com/x?who=a@b", "file:///tmp/rel", "http://127.0.0.1/rel", "http://127.0.0.1:8080/rel", "http://127.0.0.1:8080"];
const URLS_BAD = [
  "http://127.0.0.1:80@evil.example/release", "http://127.0.0.1@evil.example/", "https://user:pw@127.0.0.1/x", "https://github.com\\@evil.example/x",
  "http://127.0.0.1:80\\@evil.example/", "http://127.0.0.1.evil.example/", "http://127.0.0.1:/x", "http://127.0.0.1:8a/x", "http://127.0.0.1#@evil.example/",
  "http://127.0.0.1?x=1", "http://localhost:80/", "http://example.com/onionskin.zip", "ftp://example.com/x.zip", "/etc/passwd", "https://a b/x", "https://a\tb/x",
  "https://github.com/x\n", "file://evil.example/x", "HTTPS://github.com/x",
];
test("a release URL: get.sh and onionskin update accept and refuse the same ones, credentials and look-alike hosts refused", () => {
  for (const u of [...URLS_OK, ...URLS_BAD]) {
    const r = run(["--dry-run"], { ONIONSKIN_ZIP_URL: u, ONIONSKIN_SHA256_URL: u });
    const shOk = r.status === 0 && /\[dry run\]/.test(r.stdout);
    if (!shOk) assert.match(r.stderr, /refusing the URL/, JSON.stringify(u));
    assert.equal(shOk, URLS_OK.includes(u), `get.sh on ${JSON.stringify(u)}`);
    assert.equal(baseUrlOk(u), URLS_OK.includes(u), `baseUrlOk on ${JSON.stringify(u)}`);
  }
});

test("get.sh asks curl for https and file only (http only for 127.0.0.1) and redirects to https only; a refused URL never reaches curl", () => {
  const rel = release();
  const log = path.join(tmp, `curl-${++n}.log`);
  // a curl that records its arguments and then serves the release folder
  const curl = shim("curl", `printf '%s\\n' "$*" >> "${log}"\nout=""; prev=""; for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done\neval "last=\\\${$#}"\ncp "${rel}/$(basename "$last")" "$out"`);
  const ok = run([], { ONIONSKIN_ZIP_URL: "http://127.0.0.1:9/onionskin.zip", ONIONSKIN_SHA256_URL: "https://example.invalid/onionskin.zip.sha256" }, { shimDir: curl });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  const calls = fs.readFileSync(log, "utf8").trim().split("\n");
  assert.equal(calls.length, 2);
  const flags = (call) => [/ --proto (\S+)/.exec(call)?.[1], / --proto-redir (\S+)/.exec(call)?.[1], call.split(" ").at(-1)];
  assert.deepEqual(flags(calls[0]), ["=https,file,http", "=https", "http://127.0.0.1:9/onionskin.zip"]);
  assert.deepEqual(flags(calls[1]), ["=https,file", "=https", "https://example.invalid/onionskin.zip.sha256"]);
  fs.rmSync(log);
  const bad = run([], { ONIONSKIN_ZIP_URL: "http://127.0.0.1:80@evil.example/onionskin.zip" }, { shimDir: curl });
  assert.equal(bad.status, 1);
  assert.equal(fs.existsSync(log), false, "curl never ran");
});
