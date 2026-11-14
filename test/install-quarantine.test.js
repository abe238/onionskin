import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

// install.sh clears macOS's download mark (com.apple.quarantine) from exactly one file, the helper for Apple's model, in the copy it installs.
// The package here is a stand-in: its cli.js does nothing, and the "helper" is a plain text file that is never run. A temp HOME only.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "os-inst-q-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const Q = "com.apple.quarantine";
const mark = (f) => assert.equal(spawnSync("/usr/bin/xattr", ["-w", Q, "0081;00000000;Safari;", f]).status, 0);
const marked = (f) => spawnSync("/usr/bin/xattr", ["-p", Q, f]).status === 0;

function fakePackage(name) {
  const src = path.join(tmp, name);
  for (const d of ["src", "web/dist", "scripts/rewriter/apple"]) fs.mkdirSync(path.join(src, d), { recursive: true });
  fs.writeFileSync(path.join(src, "src", "cli.js"), "process.exit(0);\n");
  fs.writeFileSync(path.join(src, "package.json"), JSON.stringify({ version: "9.9.9" }));
  fs.writeFileSync(path.join(src, "web", "dist", "index.html"), "<!doctype html>");
  fs.writeFileSync(path.join(src, "scripts", "rewriter", "apple", "onionskin-fm"), "not a program\n", { mode: 0o644 });
  fs.writeFileSync(path.join(src, "scripts", "rewriter", "apple", "main.swift"), "// not built\n");
  fs.copyFileSync(path.join(repo, "install.sh"), path.join(src, "install.sh"));
  return src;
}
const install = (src, home, ...args) =>
  spawnSync("/bin/sh", [path.join(src, "install.sh"), "--no-checker", ...args], { encoding: "utf8", env: { HOME: home, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin` } });

test("install.sh removes the download mark from the helper in the installed copy, and from nothing else", () => {
  const src = fakePackage("pkg");
  const helper = path.join(src, "scripts", "rewriter", "apple", "onionskin-fm");
  const sibling = path.join(src, "scripts", "rewriter", "apple", "main.swift");
  mark(helper);
  mark(sibling);
  const home = path.join(tmp, "home");
  fs.mkdirSync(home);
  const r = install(src, home);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const app = path.join(home, ".onionskin", "app", "9.9.9", "scripts", "rewriter", "apple");
  assert.equal(marked(path.join(app, "onionskin-fm")), false, "the installed helper carries no mark");
  assert.equal(marked(path.join(app, "main.swift")), true, "a file next to it keeps its mark (cp -R copies it)");
  assert.equal(marked(helper), true, "the unzipped folder is not touched");
  assert.equal(marked(sibling), true);
  assert.match(r.stdout, /^ {2}quick fixes: removed macOS's download mark from one file, if it had one: the small helper that talks to Apple's on-device model, so macOS does not stop it$/m);
  // again, on a copy with no mark: no error, the same true line
  const again = install(src, home);
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.match(again.stdout, /removed macOS's download mark from one file, if it had one/);
});

test("install.sh: --dry-run says what it would do and changes nothing; --rewriter=granite is refused", () => {
  const src = fakePackage("pkg2");
  const home = path.join(tmp, "home2");
  fs.mkdirSync(home);
  const r = install(src, home, "--dry-run");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /\[dry run\] would remove macOS's download mark from one file, the small helper that talks to Apple's on-device model/);
  assert.equal(fs.existsSync(path.join(home, ".onionskin")), false);
  const g = install(src, home, "--rewriter=granite");
  assert.equal(g.status, 2);
  assert.match(g.stderr, /--rewriter takes no value/);
});

test("install.sh: an old download left in the state folder is removed once, with one plain line; links are not followed; a second install says nothing", () => {
  const src = fakePackage("pkg3");
  // the real command line of this checkout stands in for the package's, so the cleanup that runs is the real one
  fs.rmSync(path.join(src, "src"), { recursive: true });
  fs.cpSync(path.join(repo, "src"), path.join(src, "src"), { recursive: true });
  fs.cpSync(path.join(repo, "vendor"), path.join(src, "vendor"), { recursive: true });
  fs.cpSync(path.join(repo, "skills"), path.join(src, "skills"), { recursive: true });
  fs.cpSync(path.join(repo, "docs", "contracts"), path.join(src, "docs", "contracts"), { recursive: true });
  fs.writeFileSync(path.join(src, "package.json"), JSON.stringify({ version: "9.9.9", type: "module" }));
  const home = path.join(tmp, "home3");
  const state = path.join(home, ".onionskin");
  const outside = path.join(tmp, "outside3");
  fs.mkdirSync(path.join(outside, "keep"), { recursive: true });
  fs.writeFileSync(path.join(outside, "keep", "precious.txt"), "do not delete");
  fs.mkdirSync(path.join(state, "models", "granite"), { recursive: true });
  fs.writeFileSync(path.join(state, "models", "granite", "config.json"), "{}");
  fs.writeFileSync(path.join(state, "models", "granite", "model.safetensors"), "x".repeat(2_000_000));
  fs.symlinkSync(path.join(outside, "keep"), path.join(state, "models", "granite", "escape"));
  fs.mkdirSync(path.join(state, "rewriter-venv"), { recursive: true });
  fs.writeFileSync(path.join(state, "rewriter-venv", "pyvenv.cfg"), "home = x\n");
  fs.writeFileSync(path.join(state, "rewriter.json"), JSON.stringify({ backend: "mlx", model: "granite" }));
  const r = install(src, home);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^ {2}Removed the old writing helper download \(2 MB\)\. Quick fixes are off until you run: onionskin setup-rewriter$/m);
  for (const f of ["models", "rewriter-venv", "rewriter.json"]) assert.equal(fs.existsSync(path.join(state, f)), false, f);
  assert.equal(fs.readFileSync(path.join(outside, "keep", "precious.txt"), "utf8"), "do not delete", "nothing outside the state folder was touched");
  const again = install(src, home);
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.ok(!/Removed the old writing helper/.test(again.stdout));
});

test("install.sh: a folder that is not on the PATH is no required step; the PATH line is optional and the checks use the full path", () => {
  const src = fakePackage("pkg-path");
  const home = path.join(tmp, "home-path");
  fs.mkdirSync(home);
  const r = install(src, home);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(!/One more step/.test(r.stdout), "no 'One more step'");
  assert.match(r.stdout, /Your agent finds Onionskin by its full location .*\.local\/bin\/onionskin\), so you do not need to do anything\./);
  assert.match(r.stdout, /Optional: to type 'onionskin' yourself in Terminal, paste this line/);
  assert.match(r.stdout, /\.local\/bin\/onionskin --version/, "the check commands name the full path");
});
