import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

// install.sh clears macOS's download mark (com.apple.quarantine) from exactly one file, the helper for Apple's model, in the copy it installs.
// The package here is a stand-in: its cli.js reports the package version, and the "helper" is a plain text file that is never run. A temp HOME only.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "os-inst-q-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const Q = "com.apple.quarantine";
const mark = (f) => assert.equal(spawnSync("/usr/bin/xattr", ["-w", Q, "0081;00000000;Safari;", f]).status, 0);
const marked = (f) => spawnSync("/usr/bin/xattr", ["-p", Q, f]).status === 0;

const versionCli = 'if (process.argv[2] === "--version") console.log(require("../package.json").version);\n';
function fakePackage(name) {
  const src = path.join(tmp, name);
  for (const d of ["src", "web/dist", "scripts/rewriter/apple", "skills/onionskin"]) fs.mkdirSync(path.join(src, d), { recursive: true });
  fs.writeFileSync(path.join(src, "src", "cli.js"), versionCli);
  for (const file of ["server.js", "server-entry.js"]) fs.writeFileSync(path.join(src, "src", file), "");
  fs.writeFileSync(path.join(src, "package.json"), JSON.stringify({ version: "9.9.9" }));
  fs.writeFileSync(path.join(src, "web", "dist", "index.html"), "<!doctype html>");
  fs.writeFileSync(path.join(src, "scripts", "rewriter", "apple", "onionskin-fm"), "not a program\n", { mode: 0o644 });
  fs.writeFileSync(path.join(src, "scripts", "rewriter", "apple", "main.swift"), "// not built\n");
  fs.copyFileSync(path.join(repo, "install.sh"), path.join(src, "install.sh"));
  return src;
}
const install = (src, home, ...args) =>
  spawnSync("/bin/sh", [path.join(src, "install.sh"), "--no-checker", ...args], { encoding: "utf8", env: { HOME: home, TMPDIR: home, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin` } });

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

test("V6: install.sh locks state during install/uninstall, clears stale lock, releases on SIGINT/TERM, and leaves --dry-run lock-free", async () => {
  const pkgA = fakePackage("pkg-lock-a");
  fs.writeFileSync(path.join(pkgA, "package.json"), JSON.stringify({ version: "9.9.1" }));
  fs.writeFileSync(path.join(pkgA, "src", "cli.js"), 'if (process.argv[2] === "--version") console.log("9.9.1"); process.exit(0);\n');
  const pkgB = fakePackage("pkg-lock-b");
  fs.writeFileSync(path.join(pkgB, "package.json"), JSON.stringify({ version: "9.9.2" }));
  fs.writeFileSync(path.join(pkgB, "src", "cli.js"), 'if (process.argv[2] === "--version") console.log("9.9.2"); process.exit(0);\n');
  const baseEnv = (home) => ({ HOME: home, TMPDIR: home, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin` });
  const runAsync = (src, home, ...args) =>
    new Promise((resolve) => {
      const c = spawn("/bin/sh", [path.join(src, "install.sh"), "--no-checker", ...args], { env: baseEnv(home), stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      c.stdout.on("data", (d) => (out += d));
      c.stderr.on("data", (d) => (out += d));
      c.on("close", (code) => resolve({ code, out }));
    });

  // 1. Live lock blocks install and --uninstall, does not block --dry-run
  const homeLive = path.join(tmp, "home-lock-live");
  fs.mkdirSync(path.join(homeLive, ".onionskin", "install.lock"), { recursive: true });
  fs.writeFileSync(path.join(homeLive, ".onionskin", "install.lock", "pid"), `${process.pid}\n`);
  const blocked = install(pkgA, homeLive);
  assert.notEqual(blocked.status, 0, "live lock must block install");
  assert.match(blocked.stdout + blocked.stderr, /another onionskin install or update is running/i);
  assert.equal(fs.existsSync(path.join(homeLive, ".local", "bin", "onionskin")), false, "blocked install changes nothing");
  const blockedUn = install(pkgA, homeLive, "--uninstall");
  assert.notEqual(blockedUn.status, 0, "live lock must block --uninstall");
  assert.match(blockedUn.stdout + blockedUn.stderr, /another onionskin install or update is running/i);
  const dry = install(pkgA, homeLive, "--dry-run");
  assert.equal(dry.status, 0, "--dry-run takes no lock");
  assert.equal(fs.existsSync(path.join(homeLive, ".onionskin", "install.lock")), true, "blocked runs did not remove live lock");

  // 2. Stale lock (dead pid) does not block the next install, and lock is removed on exit
  const homeStale = path.join(tmp, "home-lock-stale");
  const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  fs.mkdirSync(path.join(homeStale, ".onionskin", "install.lock"), { recursive: true });
  fs.writeFileSync(path.join(homeStale, ".onionskin", "install.lock", "pid"), `${dead.stdout.trim()}\n`);
  const rStale = install(pkgA, homeStale);
  assert.equal(rStale.status, 0, rStale.stdout + rStale.stderr);
  assert.equal(fs.existsSync(path.join(homeStale, ".onionskin", "install.lock")), false, "lock released on exit");
  const rAgain = install(pkgB, homeStale);
  assert.equal(rAgain.status, 0, "sequential install after another succeeds: " + rAgain.stdout + rAgain.stderr);

  // 3. Ctrl-C (SIGINT) during an install leaves no lock
  const pkgSlow = fakePackage("pkg-lock-slow");
  const marker = path.join(tmp, "slow-started");
  fs.writeFileSync(path.join(pkgSlow, "src", "cli.js"), versionCli + `const fs = require("node:fs"); if (process.argv[2] === "setup") { fs.writeFileSync(${JSON.stringify(marker)}, "1"); setTimeout(() => {}, 15000); } else process.exit(0);\n`);
  const homeInt = path.join(tmp, "home-lock-int");
  fs.mkdirSync(homeInt);
  const child = spawn("/bin/sh", [path.join(pkgSlow, "install.sh"), "--no-checker"], { env: baseEnv(homeInt), stdio: "ignore", detached: true });
  const deadline = Date.now() + 8000;
  while (!fs.existsSync(marker) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 30));
  assert.equal(fs.existsSync(marker), true, "slow install reached setup");
  process.kill(-child.pid, "SIGINT");
  await new Promise((r) => child.once("close", r));
  assert.equal(fs.existsSync(path.join(homeInt, ".onionskin", "install.lock")), false, "SIGINT leaves no lock");

  // 4. Concurrent installs into the same HOME: launcher always points at an existing working app
  for (let i = 0; i < 6; i++) {
    const h = path.join(tmp, `home-race-${i}`);
    fs.mkdirSync(h);
    const [a, b] = await Promise.all([runAsync(pkgA, h), runAsync(pkgB, h)]);
    assert.ok(a.code === 0 || b.code === 0, `at least one installer succeeded (a=${a.code}, b=${b.code})`);
    if (a.code !== 0) assert.match(a.out, /another onionskin install or update is running/i);
    if (b.code !== 0) assert.match(b.out, /another onionskin install or update is running/i);
    const ver = spawnSync(path.join(h, ".local", "bin", "onionskin"), ["--version"], { encoding: "utf8", env: baseEnv(h) });
    assert.equal(ver.status, 0, `launcher works on iter ${i}: ${ver.stderr}`);
    assert.match(ver.stdout.trim(), /^9\.9\.[12]$/);
    assert.equal(fs.existsSync(path.join(h, ".onionskin", "install.lock")), false, "no lock left after concurrent run");
  }
});

test("W2: blocked install and uninstall print both busy lines including the lock path and exit non-zero", () => {
  const src = fakePackage("pkg-w2");
  const home = path.join(tmp, "home-w2");
  const lock = path.join(home, ".onionskin", "install.lock");
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, "pid"), `${process.pid}\n`);
  for (const args of [[], ["--uninstall"]]) {
    const r = install(src, home, ...args);
    assert.notEqual(r.status, 0, `expected non-zero exit for args=${JSON.stringify(args)}`);
    const out = r.stdout + r.stderr;
    assert.ok(out.includes("Another Onionskin install or update is running. Try again when it finishes."), out);
    assert.ok(out.includes(`If none is running, delete this folder and try again: ${lock}`), out);
  }
});

for (const boundary of ["publish", "cleanup"]) {
  test(`install stops before ${boundary} when another installer takes its lock`, () => {
    const src = fakePackage(`pkg-${boundary}`);
    const home = path.join(tmp, `home-${boundary}`);
    const state = path.join(home, ".onionskin");
    const other = path.join(state, "app", "1.0.0");
    const bin = path.join(home, "bin");
    fs.mkdirSync(other, { recursive: true });
    fs.mkdirSync(bin);
    const lock = path.join(state, "install.lock", "pid");
    const launcher = path.join(home, ".local", "bin", "onionskin");
    // Replace the pid after the temporary launcher is ready, or just after it is published.
    const command = boundary === "publish" ? "chmod" : "mv";
    const target = boundary === "publish" ? '"$HOME"/.local/bin/onionskin.tmp.*' : '"$HOME"/.local/bin/onionskin';
    fs.writeFileSync(path.join(bin, command), `#!/bin/sh
/bin/${command} "$@" || exit 1
case "$2" in ${target}) echo ${process.pid} > "$HOME/.onionskin/install.lock/pid";; esac
`, { mode: 0o755 });
    const r = spawnSync("/bin/sh", [path.join(src, "install.sh"), "--no-checker"], {
      encoding: "utf8", env: { HOME: home, TMPDIR: home, PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin` },
    });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /Another Onionskin install or update is running/);
    assert.ok(r.stdout.includes(`delete this folder and try again: ${path.dirname(lock)}`));
    assert.equal(fs.existsSync(launcher), boundary === "cleanup");
    assert.ok(fs.existsSync(other));
    assert.equal(fs.readFileSync(lock, "utf8").trim(), String(process.pid));
  });
}

for (const probeFails of [true, false]) {
  test(`a lock takeover during the same-version probe preserves the lock and original app (probe fails: ${probeFails})`, async () => {
    const src = fakePackage(`pkg-takeover-${probeFails}`);
    const home = path.join(tmp, `home-takeover-${probeFails}`);
    fs.mkdirSync(home);
    assert.equal(install(src, home).status, 0);
    const state = path.join(home, ".onionskin");
    const app = path.join(state, "app", "9.9.9");
    const original = fs.statSync(app).ino;
    const lock = path.join(state, "install.lock", "pid");
    const sleeper = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
    const closed = new Promise(resolve => sleeper.once("close", resolve));
    try {
      fs.writeFileSync(path.join(src, "src", "cli.js"), `
        if (process.argv[2] === "--version") {
          require("node:fs").writeFileSync(${JSON.stringify(lock)}, "${sleeper.pid}");
          if (${probeFails}) process.exit(1);
          console.log("9.9.9");
        }
      `);
      const r = install(src, home);
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.stdout, probeFails ? /could not start/ : /Another Onionskin install/);
      assert.equal(fs.readFileSync(lock, "utf8"), String(sleeper.pid));
      assert.equal(fs.statSync(app).ino, original);
      assert.deepEqual(fs.readdirSync(path.dirname(app)), ["9.9.9"]);
    } finally {
      sleeper.kill();
      await closed;
    }
  });
}

test("W3: --uninstall in an empty HOME leaves no ~/.onionskin; --uninstall after a real install keeps ~/.onionskin", () => {
  const src = fakePackage("pkg-w3");
  const emptyHome = path.join(tmp, "home-w3-empty");
  fs.mkdirSync(emptyHome);
  const rEmpty = install(src, emptyHome, "--uninstall");
  assert.equal(rEmpty.status, 0, rEmpty.stdout + rEmpty.stderr);
  assert.ok(!rEmpty.stdout.includes(`kept ${emptyHome}/.onionskin`));
  assert.equal(fs.existsSync(path.join(emptyHome, ".onionskin")), false, "empty HOME has no ~/.onionskin after --uninstall");

  const purge = install(src, emptyHome, "--uninstall", "--purge");
  assert.equal(purge.status, 0, purge.stdout + purge.stderr);
  assert.ok(purge.stdout.split("\n").includes(`  not present: ${emptyHome}/.onionskin`));
  assert.ok(!purge.stdout.includes(`removed ${emptyHome}/.onionskin`));
  assert.ok(!fs.existsSync(path.join(emptyHome, ".onionskin")));

  const usedHome = path.join(tmp, "home-w3-used");
  fs.mkdirSync(usedHome);
  const rInst = install(src, usedHome);
  assert.equal(rInst.status, 0, rInst.stdout + rInst.stderr);
  const rUn = install(src, usedHome, "--uninstall");
  assert.equal(rUn.status, 0, rUn.stdout + rUn.stderr);
  assert.ok(rUn.stdout.includes(`kept ${usedHome}/.onionskin`));
  assert.equal(fs.existsSync(path.join(usedHome, ".onionskin")), true, "real install keeps ~/.onionskin on --uninstall");
  assert.equal(fs.existsSync(path.join(usedHome, ".onionskin", "app")), false, "app folder removed");
  assert.equal(fs.existsSync(path.join(usedHome, ".onionskin", "install.lock")), false, "lock removed");
});

for (const version of ["9.9.9", "9.9.10"]) {
  for (const defect of ["missing module", "empty CLI", "wrong version", "missing server.js", "missing server-entry.js", "server module missing watch.js", "missing open-worker.js", "missing URL worker", "missing lazy import", "missing web bundle", "empty web bundle"]) {
    test(`a package with ${defect} at ${version} leaves the working copy and launcher in place`, () => {
      const src = fakePackage(`pkg-broken-${defect}-${version}`);
      const home = path.join(tmp, `home-broken-${defect}-${version}`);
      fs.mkdirSync(home);
      assert.equal(install(src, home).status, 0);
      const launcher = path.join(home, ".local", "bin", "onionskin");
      const oldLauncher = fs.readFileSync(launcher);
      const state = path.join(home, ".onionskin");
      const apps = path.join(state, "app");
      const oldApp = path.join(apps, "9.9.9");
      const original = fs.statSync(oldApp).ino;
      const cli = path.join(src, "src", "cli.js");
      if (defect === "missing module") fs.writeFileSync(cli, 'require("./missing-module");');
      else if (defect === "empty CLI") fs.writeFileSync(cli, "");
      else if (defect === "wrong version") fs.writeFileSync(cli, 'console.log("0.0.1");');
      else if (defect === "server module missing watch.js") fs.writeFileSync(path.join(src, "src", "server.js"), 'require("./watch.js");\n');
      // files the server loads only later (a worker, a lazy import): importing server.js does not reach them
      else if (defect === "missing open-worker.js") fs.writeFileSync(path.join(src, "src", "offload.js"), 'startWorker("open-worker.js");\n');
      else if (defect === "missing URL worker") fs.writeFileSync(path.join(src, "src", "offload.js"), 'new URL("./x-worker.js", import.meta.url);\n');
      else if (defect === "missing lazy import") fs.writeFileSync(path.join(src, "src", "lazy.js"), 'import("./later.js");\n');
      // the page names a bundle that is not there, or is empty: the editor would open blank
      else if (defect === "missing web bundle" || defect === "empty web bundle") {
        fs.writeFileSync(path.join(src, "web", "dist", "index.html"), '<!doctype html><script type="module" crossorigin src="/assets/index-x.js"></script>');
        if (defect === "empty web bundle") {
          fs.mkdirSync(path.join(src, "web", "dist", "assets"));
          fs.writeFileSync(path.join(src, "web", "dist", "assets", "index-x.js"), "");
        }
      }
      else fs.unlinkSync(path.join(src, "src", defect.slice("missing ".length)));
      fs.writeFileSync(path.join(src, "package.json"), JSON.stringify({ version }));
      const r = install(src, home);
      assert.equal(r.status, 1, r.stdout);
      assert.match(r.stdout, /could not start.*previous installation/i);
      assert.deepEqual(fs.readFileSync(launcher), oldLauncher);
      assert.deepEqual(fs.readdirSync(apps), ["9.9.9"]);
      assert.equal(fs.statSync(oldApp).ino, original);
      assert.equal(fs.existsSync(path.join(state, "install.lock")), false);
    });
  }
}

for (const versions of [["9.9.8", "9.9.9", "9.9.10"], ["9.9.9", "9.9.9", "9.9.9"]]) {
  test(`install carries the private guide forward through ${versions.join(" -> ")}`, () => {
    const src = fakePackage(`pkg-voice-${versions[0]}`);
    const home = path.join(tmp, `home-voice-${versions[0]}`);
    const apps = path.join(home, ".onionskin", "app");
    const guide = (version) => path.join(apps, version, "skills", "onionskin", "voice.md");
    fs.mkdirSync(path.dirname(guide(versions[0])), { recursive: true });
    for (let i = 1; i < versions.length; i++) {
      const content = `Private guide for cycle ${i}\n`;
      fs.writeFileSync(guide(versions[i - 1]), content);
      fs.writeFileSync(path.join(src, "package.json"), JSON.stringify({ version: versions[i] }));
      const r = install(src, home);
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.deepEqual(fs.readdirSync(apps), [versions[i]]);
      assert.equal(fs.readFileSync(guide(versions[i]), "utf8"), content);
      assert.ok(!r.stdout.includes(content.trim()));
      assert.ok(!fs.existsSync(path.join(home, ".onionskin", "voice.md.kept")));
    }
  });
}

test("install from an incomplete copy already in the app folder keeps the working launcher", () => {
  const src = fakePackage("pkg-in-place");
  const home = path.join(tmp, "home-in-place");
  fs.mkdirSync(home);
  assert.equal(install(src, home).status, 0);
  const launcher = path.join(home, ".local", "bin", "onionskin");
  const old = fs.readFileSync(launcher, "utf8");
  const broken = path.join(home, ".onionskin", "app", "9.9.10");
  fs.cpSync(src, broken, { recursive: true });
  fs.writeFileSync(path.join(broken, "package.json"), JSON.stringify({ version: "9.9.10" }));
  fs.writeFileSync(path.join(broken, "src", "cli.js"), 'require("./missing-module");\n');
  const r = install(broken, home);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(fs.readFileSync(launcher, "utf8"), old);
  assert.ok(fs.existsSync(path.join(home, ".onionskin", "app", "9.9.9", "src", "cli.js")));
});

for (const collision of [false, true]) {
  test(`install saves the old guide when the new copy has one (backup occupied: ${collision})`, () => {
    const src = fakePackage(`pkg-guides-${collision}`);
    const home = path.join(tmp, `home-guides-${collision}`);
    const state = path.join(home, ".onionskin");
    const apps = path.join(state, "app");
    const guide = path.join("skills", "onionskin", "voice.md");
    const old = path.join(apps, "9.9.8", guide);
    fs.mkdirSync(path.dirname(old), { recursive: true });
    fs.writeFileSync(old, "Old private guide");
    fs.writeFileSync(path.join(src, guide), "New private guide");
    const kept = path.join(state, "voice.md.kept");
    if (collision) fs.writeFileSync(kept, "Earlier private guide");
    const r = install(src, home);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const saved = collision ? kept + ".1" : kept;
    assert.equal(fs.readFileSync(saved, "utf8"), "Old private guide");
    if (collision) assert.equal(fs.readFileSync(kept, "utf8"), "Earlier private guide");
    assert.equal(fs.readFileSync(path.join(apps, "9.9.9", guide), "utf8"), "New private guide");
    assert.deepEqual(fs.readdirSync(apps), ["9.9.9"]);
    assert.equal(r.stdout.split("\n").filter(line => line.includes(saved)).length, 1);
    assert.doesNotMatch(r.stdout + r.stderr, /private guide/);
  });
}

for (const edited of [false, true]) {
  test(`three installs of a shipped guide keep only distinct edits (edited: ${edited})`, () => {
    const src = fakePackage(`pkg-shipped-${edited}`);
    const home = path.join(tmp, `home-shipped-${edited}`);
    const state = path.join(home, ".onionskin");
    const apps = path.join(state, "app");
    const guide = path.join("skills", "onionskin", "voice.md");
    const original = randomUUID();
    const edit = randomUUID();
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(src, guide), original);
    if (edited) {
      const previous = path.join(apps, "9.9.8", guide);
      fs.mkdirSync(path.dirname(previous), { recursive: true });
      fs.writeFileSync(previous, edit);
    }
    for (let cycle = 0; cycle < 3; cycle++) {
      const r = install(src, home);
      assert.equal(r.status, 0);
      const output = r.stdout + r.stderr;
      assert.ok(!output.includes(original) && !output.includes(edit));
      assert.deepEqual(fs.readdirSync(apps), ["9.9.9"]);
      const kept = "voice.md.kept";
      assert.deepEqual(fs.readdirSync(state).filter(name => name.startsWith(kept)), edited ? [kept] : []);
      assert.equal(output.includes("Kept your voice guide"), edited && cycle === 0);
      if (edited) assert.ok(fs.readFileSync(path.join(state, kept), "utf8") === edit);
      const current = path.join(apps, "9.9.9", guide);
      assert.ok(fs.readFileSync(current, "utf8") === original);
      if (edited && cycle === 1) fs.writeFileSync(current, edit);
    }
  });
}

test("a linked voice guide keeps the old app folder and its target in place", () => {
  const src = fakePackage("pkg-linked-guide");
  const home = path.join(tmp, "home-linked-guide");
  const apps = path.join(home, ".onionskin", "app");
  const guide = path.join("skills", "onionskin", "voice.md");
  const old = path.join(apps, "9.9.8", guide);
  const target = path.join(apps, "9.9.8", "private.md");
  fs.mkdirSync(path.dirname(old), { recursive: true });
  fs.writeFileSync(target, "Private guide");
  fs.symlinkSync(target, old);
  const r = install(src, home);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(r.stdout.includes(`Left ${old} in place because its source or destination uses a link.`));
  assert.equal(fs.readlinkSync(old), target);
  assert.equal(fs.readFileSync(target, "utf8"), "Private guide");
  assert.ok(!fs.existsSync(path.join(apps, "9.9.9", guide)));
});

test("a failed guide comparison keeps the original for the next install", () => {
  const src = fakePackage("pkg-guide-retry");
  const home = path.join(tmp, "home-guide-retry");
  const apps = path.join(home, ".onionskin", "app");
  const guide = path.join("skills", "onionskin", "voice.md");
  const old = path.join(apps, "9.9.8", guide);
  const current = path.join(apps, "9.9.9", guide);
  fs.mkdirSync(path.dirname(old), { recursive: true });
  fs.writeFileSync(old, "Private retry content");
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "cmp"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const r = spawnSync("/bin/sh", [path.join(src, "install.sh"), "--no-checker"], {
    encoding: "utf8", env: { HOME: home, TMPDIR: home, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(r.stdout.includes(old));
  assert.ok(!r.stdout.includes("Private retry content"));
  assert.equal(fs.readFileSync(old, "utf8"), "Private retry content");
  assert.ok(!fs.existsSync(current));
  assert.ok(!fs.existsSync(path.join(home, ".onionskin", "voice.md.kept")));
  assert.equal(install(src, home).status, 0);
  assert.equal(fs.readFileSync(current, "utf8"), "Private retry content");
  assert.deepEqual(fs.readdirSync(apps), ["9.9.9"]);
});

test("checker setup timing out leaves the direct install usable and prints the reason", () => {
  const src = fakePackage("pkg-checker-timeout");
  const home = path.join(tmp, "home-checker-timeout");
  fs.mkdirSync(home);
  const base = path.join(home, "slow-python");
  fs.writeFileSync(base, "#!/bin/sh\nsleep 2\nexit 1\n", { mode: 0o755 });
  const checker = path.join(repo, "src", "checker.js");
  fs.writeFileSync(path.join(src, "src", "cli.js"), `
    if (process.argv[2] === "setup-checker") {
      import(${JSON.stringify(checker)}).then(m => m.setupChecker()).catch(err => { console.error(err.message); process.exitCode = 1; });
    } else if (process.argv[2] === "--version") console.log("9.9.9");
  `);
  const env = { HOME: home, TMPDIR: home, PATH: process.env.PATH, ONIONSKIN_BASE_PYTHON: base, ONIONSKIN_SETUP_TIMEOUT_MS: "150" };
  const r = spawnSync("/bin/sh", [path.join(src, "install.sh")], { env, encoding: "utf8", timeout: 15_000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^ *Deeper check setup timed out\.$/m);
  assert.match(r.stdout, /Onionskin works without deeper checks/);
  assert.equal(spawnSync(path.join(home, ".local", "bin", "onionskin"), ["--version"], { env, encoding: "utf8" }).stdout, "9.9.9\n");
  assert.equal(fs.existsSync(path.join(home, ".onionskin", "install.lock")), false);
});

test("D1: a lock with no process number is never taken over; the hint names it and nothing is installed", () => {
  const src = fakePackage("pkg-lock-empty");
  const home = path.join(tmp, "home-lock-empty");
  const lock = path.join(home, ".onionskin", "install.lock");
  fs.mkdirSync(lock, { recursive: true });
  const r = install(src, home);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.ok(r.stdout.includes("Another Onionskin install or update is running. Try again when it finishes."), r.stdout);
  assert.ok(r.stdout.includes(`If none is running, delete this folder and try again: ${lock}`), r.stdout);
  assert.ok(fs.statSync(lock).isDirectory(), "the lock is left in place");
  assert.equal(fs.existsSync(path.join(home, ".onionskin", "app")), false);
  assert.equal(fs.existsSync(path.join(home, ".local", "bin", "onionskin")), false);
});

test("D1: a stale lock taken over by another installer after it was read is put back, not removed", () => {
  const src = fakePackage("pkg-lock-race");
  const home = path.join(tmp, "home-lock-race");
  const lock = path.join(home, ".onionskin", "install.lock");
  const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout.trim();
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, "pid"), `${dead}\n`);
  // Another installer (stood in for by this test process) takes over the dead lock just before this one moves it aside.
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "mv"), `#!/bin/sh
case "$1" in */install.lock) /bin/rm -rf "$1"; /bin/mkdir "$1"; echo ${process.pid} > "$1/pid";; esac
/bin/mv "$@"
`, { mode: 0o755 });
  const r = spawnSync("/bin/sh", [path.join(src, "install.sh"), "--no-checker"], {
    encoding: "utf8", env: { HOME: home, TMPDIR: home, PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin` },
  });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /Another Onionskin install or update is running/);
  assert.equal(fs.readFileSync(path.join(lock, "pid"), "utf8").trim(), String(process.pid), "the live installer's lock is back in place");
  assert.deepEqual(fs.readdirSync(path.dirname(lock)).filter((n) => n.startsWith("install.lock.stale")), []);
  assert.equal(fs.existsSync(path.join(home, ".onionskin", "app")), false, "nothing was published");
  assert.equal(fs.existsSync(path.join(home, ".local", "bin", "onionskin")), false);
});

test("D1: a lock folder replaced by another one holding the same number stops the install before the launcher swap", () => {
  const src = fakePackage("pkg-lock-inode");
  const home = path.join(tmp, "home-lock-inode");
  const state = path.join(home, ".onionskin");
  const other = path.join(state, "app", "1.0.0");
  const bin = path.join(home, "bin");
  fs.mkdirSync(other, { recursive: true });
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "chmod"), `#!/bin/sh
/bin/chmod "$@" || exit 1
case "$2" in "$HOME"/.local/bin/onionskin.tmp.*)
  L="$HOME/.onionskin/install.lock"; P=$(cat "$L/pid"); /bin/rm -rf "$L"; /bin/mkdir "$L"; echo "$P" > "$L/pid";;
esac
`, { mode: 0o755 });
  const r = spawnSync("/bin/sh", [path.join(src, "install.sh"), "--no-checker"], {
    encoding: "utf8", env: { HOME: home, TMPDIR: home, PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin` },
  });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /Another Onionskin install or update is running/);
  assert.equal(fs.existsSync(path.join(home, ".local", "bin", "onionskin")), false, "the launcher was not swapped");
  assert.ok(fs.existsSync(other), "nothing was pruned");
});

test("D1: a lock taken over before a first install publishes leaves no app folder and the other lock in place", async () => {
  const src = fakePackage("pkg-lock-first");
  const home = path.join(tmp, "home-lock-first");
  fs.mkdirSync(home);
  const lock = path.join(home, ".onionskin", "install.lock", "pid");
  const sleeper = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
  const closed = new Promise((resolve) => sleeper.once("close", resolve));
  try {
    fs.writeFileSync(path.join(src, "src", "cli.js"), `
      if (process.argv[2] === "--version") {
        require("node:fs").writeFileSync(${JSON.stringify(lock)}, "${sleeper.pid}");
        console.log("9.9.9");
      }
    `);
    const r = install(src, home);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /Another Onionskin install/);
    assert.equal(fs.readFileSync(lock, "utf8"), String(sleeper.pid));
    assert.equal(fs.existsSync(path.join(home, ".onionskin", "app", "9.9.9")), false);
    assert.equal(fs.existsSync(path.join(home, ".local", "bin", "onionskin")), false);
  } finally {
    sleeper.kill();
    await closed;
  }
});

test("D3: with ONIONSKIN_STATE_DIR set, the installer sets up the deeper checks in that folder", () => {
  const src = fakePackage("pkg-custom-state");
  const home = path.join(tmp, "home-custom-state");
  const custom = path.join(tmp, "custom-state");
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(src, "src", "cli.js"), `
    const fs = require("node:fs"), path = require("node:path");
    if (process.argv[2] === "--version") console.log("9.9.9");
    else if (process.argv[2] === "setup-checker") {
      const bin = path.join(process.env.ONIONSKIN_STATE_DIR, "venv", "bin");
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(path.join(bin, "python"), "#!/bin/sh\\n", { mode: 0o755 });
    }
  `);
  const r = spawnSync("/bin/sh", [path.join(src, "install.sh")], {
    encoding: "utf8", env: { HOME: home, TMPDIR: home, ONIONSKIN_STATE_DIR: custom, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin` },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(r.stdout.includes(`Checking the Python libraries in ${custom}/venv`), r.stdout);
  assert.match(r.stdout, /^ {2}done$/m);
  assert.ok(fs.existsSync(path.join(custom, "venv", "bin", "python")));
  assert.equal(fs.existsSync(path.join(home, ".onionskin", "venv")), false, "nothing in the default folder");
  assert.ok(fs.existsSync(path.join(home, ".onionskin", "app", "9.9.9")), "the app copy stays in ~/.onionskin");
});

// Uninstall with a state folder set by ONIONSKIN_STATE_DIR and a checker: each sentence says only what is true afterwards. A custom
// state folder outside ~/.onionskin is never removed: it is named as a quoted path on its own line, never as a command to paste.
// `setup(home)` makes the folders and returns the ONIONSKIN_STATE_DIR value (null: unset); `venvAt(home)` is where the checker really is
// (null: none); `opts.cwd` is the folder the uninstall runs in (for a relative value).
function uninstallWithChecker(name, setup, venvAt, args = [], opts = {}) {
  const src = fakePackage(`pkg-${name}`);
  const home = path.join(tmp, `home-${name}`);
  fs.mkdirSync(home);
  assert.equal(install(src, home).status, 0);
  const stateDir = setup(home);
  const venv = venvAt(home);
  if (venv) fs.mkdirSync(venv, { recursive: true });
  const r = spawnSync("/bin/sh", [path.join(src, "install.sh"), "--uninstall", ...args], {
    cwd: opts.cwd ? opts.cwd(home) : undefined,
    encoding: "utf8", env: { HOME: home, TMPDIR: home, ...(stateDir ? { ONIONSKIN_STATE_DIR: stateDir } : {}), PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin` },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /rm -rf/, "no command to paste");
  return { r, home, venv, lines: r.stdout.split("\n") };
}
const hasLines = (lines, want) => { const i = lines.indexOf(want[0]); return i >= 0 && want.every((l, k) => lines[i + k] === l); };
// A custom state folder as the app keeps it: sessions and snapshots in it.
const customState = (dir) => { for (const d of ["sessions", "snapshots"]) fs.mkdirSync(path.join(dir, d), { recursive: true }); fs.writeFileSync(path.join(dir, "snapshots", "a"), "x"); };
const customLines = (dir, purge, checker = true) => [
  `  Your ${checker ? "sessions, snapshots and checker environment" : "sessions and snapshots"} are in the state folder set by ONIONSKIN_STATE_DIR, which ${purge ? "was left in place" : "--purge also leaves in place"}. You can delete this folder yourself if you no longer want it:`,
  `    "${dir}"`,
];

test("D3: purge with a custom state folder outside ~/.onionskin, its path with a space, leaves it and says where the snapshots are", () => {
  const { home, venv, lines, r } = uninstallWithChecker("purge-outside", (h) => {
    fs.mkdirSync(path.join(h, "external")); // a sibling an unquoted command would hit
    customState(path.join(h, "external state"));
    return path.join(h, "external state");
  }, (h) => path.join(h, "external state", "venv"), ["--purge"]);
  assert.equal(fs.existsSync(path.join(home, ".onionskin")), false);
  assert.ok(fs.existsSync(venv), "the checker outside is not removed");
  assert.ok(fs.existsSync(path.join(home, "external state", "snapshots", "a")), "the snapshots outside are not removed");
  assert.ok(fs.existsSync(path.join(home, "external")));
  assert.ok(lines.includes(`  removed ${home}/.onionskin`), r.stdout);
  assert.ok(hasLines(lines, customLines(path.join(home, "external state"), true)), r.stdout);
  assert.doesNotMatch(r.stdout, /included|left in place, outside/);
});

test("D3: purge with a custom state folder given relative, with a trailing slash, finds it where the app does", () => {
  const { home, lines, r } = uninstallWithChecker("purge-relative", (h) => {
    customState(path.join(h, "work", "rel state"));
    return "rel state/";
  }, () => null, ["--purge"], { cwd: (h) => path.join(h, "work") });
  assert.ok(lines.includes(`  removed ${home}/.onionskin`), r.stdout);
  assert.ok(hasLines(lines, customLines(path.join(home, "work", "rel state"), true, false)), r.stdout);
  assert.ok(fs.existsSync(path.join(home, "work", "rel state", "snapshots", "a")));
});

test("D3: purge with a custom state folder inside ~/.onionskin says the snapshots and the checker were removed with it", () => {
  const { home, venv, lines, r } = uninstallWithChecker("purge-inside", (h) => {
    customState(path.join(h, ".onionskin", "custom"));
    return path.join(h, ".onionskin", "custom") + "/";
  }, (h) => path.join(h, ".onionskin", "custom", "venv"), ["--purge"]);
  assert.equal(fs.existsSync(venv), false);
  assert.equal(fs.existsSync(path.join(home, ".onionskin")), false);
  assert.ok(lines.includes(`  removed ${home}/.onionskin (snapshots and checker environment included)`), r.stdout);
  assert.doesNotMatch(r.stdout, /left in place|ONIONSKIN_STATE_DIR/);
});

test("D3: purge with a custom state folder reached through a link inside ~/.onionskin leaves it, at its real place", () => {
  const { home, venv, lines, r } = uninstallWithChecker("purge-linked", (h) => {
    customState(path.join(h, "real-state"));
    fs.symlinkSync(path.join(h, "real-state"), path.join(h, ".onionskin", "linked"));
    return path.join(h, ".onionskin", "linked");
  }, (h) => path.join(h, "real-state", "venv"), ["--purge"]);
  assert.equal(fs.existsSync(path.join(home, ".onionskin")), false);
  assert.ok(fs.existsSync(venv), "the linked checker survives");
  assert.ok(fs.existsSync(path.join(home, "real-state", "snapshots", "a")), "the linked snapshots survive");
  assert.ok(lines.includes(`  removed ${home}/.onionskin`), r.stdout);
  assert.ok(hasLines(lines, customLines(path.join(home, "real-state"), true)), r.stdout);
  assert.doesNotMatch(r.stdout, /included/);
});

test("D3: purge after an install made with --no-checker does not report removing a checker", () => {
  const { home, lines, r } = uninstallWithChecker("purge-none", () => null, () => null, ["--purge"]);
  assert.equal(fs.existsSync(path.join(home, ".onionskin")), false);
  assert.ok(lines.includes(`  removed ${home}/.onionskin (snapshots included)`), r.stdout);
  assert.doesNotMatch(r.stdout, /checker|ONIONSKIN_STATE_DIR/);
});

test("D3: purge with the variable unset and a checker that is a link out of ~/.onionskin says the checker was left, and where", () => {
  const { home, venv, lines, r } = uninstallWithChecker("purge-venv-link", (h) => {
    fs.mkdirSync(path.join(h, "elsewhere", "venv"), { recursive: true });
    fs.symlinkSync(path.join(h, "elsewhere", "venv"), path.join(h, ".onionskin", "venv"));
    return null;
  }, () => null, ["--purge"]);
  assert.ok(fs.existsSync(path.join(home, "elsewhere", "venv")));
  assert.ok(lines.includes(`  removed ${home}/.onionskin (snapshots included)`), r.stdout);
  assert.ok(hasLines(lines, [
    "  The checker environment was left in place, outside that folder. You can delete this folder yourself if you no longer want it:",
    `    "${path.join(home, "elsewhere", "venv")}"`,
  ]), r.stdout);
  assert.equal(venv, null);
});

test("D3: uninstall without purge says where the snapshots and the checker are kept", () => {
  const inside = uninstallWithChecker("keep-inside", () => null, (h) => path.join(h, ".onionskin", "venv"));
  assert.ok(inside.lines.includes(`  kept ${inside.home}/.onionskin (your snapshots and the checker environment). To delete it too, run the uninstall again with --purge.`), inside.r.stdout);
  const none = uninstallWithChecker("keep-none", () => null, () => null);
  assert.ok(none.lines.includes(`  kept ${none.home}/.onionskin (your snapshots). To delete it too, run the uninstall again with --purge.`), none.r.stdout);
  assert.doesNotMatch(none.r.stdout, /checker|ONIONSKIN_STATE_DIR/);
  const outside = uninstallWithChecker("keep-outside", (h) => { customState(path.join(h, "external state")); return path.join(h, "external state"); }, (h) => path.join(h, "external state", "venv"));
  assert.ok(outside.lines.includes(`  kept ${outside.home}/.onionskin. To delete it too, run the uninstall again with --purge.`), outside.r.stdout);
  assert.ok(hasLines(outside.lines, customLines(path.join(outside.home, "external state"), false)), outside.r.stdout);
  assert.doesNotMatch(outside.r.stdout, /your snapshots\)|outside that folder/);
});

test("a dry run with a space in HOME prints each removal path in double quotes", () => {
  const src = fakePackage("pkg-dry-space");
  const home = path.join(tmp, "home dry space");
  fs.mkdirSync(home);
  assert.equal(install(src, home).status, 0);
  const r = install(src, home, "--uninstall", "--purge", "--dry-run");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const lines = r.stdout.split("\n");
  for (const p of [`${home}/.local/bin/onionskin`, `${home}/.onionskin/app`, `${home}/.onionskin`]) {
    assert.ok(lines.some((l) => l.startsWith("  [dry run] ") && l.endsWith(` "${p}"`)), `${p} quoted:\n${r.stdout}`);
  }
  assert.ok(!lines.some((l) => l.startsWith("  [dry run] rm") && l.includes(` ${home}/`)), "no unquoted path");
  assert.ok(fs.existsSync(path.join(home, ".onionskin", "app", "9.9.9")), "nothing removed");
});

test("the start check accepts a package whose workers, lazy imports and URL workers are all present", () => {
  const src = fakePackage("pkg-refs-ok");
  const home = path.join(tmp, "home-refs-ok");
  fs.mkdirSync(home);
  fs.mkdirSync(path.join(src, "src", "ops"));
  fs.writeFileSync(path.join(src, "src", "offload.js"), 'startWorker("open-worker.js"); new URL("./worker-host.js", import.meta.url); import("./lazy.js");\n');
  fs.writeFileSync(path.join(src, "src", "ops", "run.js"), 'import { x } from "../lazy.js";\nconst t = `./${"name"}`;\n');
  for (const f of ["open-worker.js", "worker-host.js", "lazy.js"]) fs.writeFileSync(path.join(src, "src", f), "");
  // a built page: local bundle and stylesheet present; absolute URLs, data: and anchors are not files to check
  const dist = path.join(src, "web", "dist");
  fs.mkdirSync(path.join(dist, "assets"));
  fs.writeFileSync(path.join(dist, "assets", "index-a.js"), "x");
  fs.writeFileSync(path.join(dist, "assets", "index-a.css"), "x");
  fs.writeFileSync(path.join(dist, "index.html"), '<!doctype html><script type="module" crossorigin src="/assets/index-a.js"></script><link rel="stylesheet" href="./assets/index-a.css?v=1"><link href="https://example.com/x.css"><img src="data:image/png;base64,AA"><a href="#top"></a>');
  const r = install(src, home);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(fs.existsSync(path.join(home, ".onionskin", "app", "9.9.9", "src", "open-worker.js")));
});

// A same-version reinstall whose publish fails after another installer (this test process) took the lock. `publish` is the stub
// for the failing move of the staged copy: it can also put another installer's copy under the version's name first.
function failedPublishAfterLockLoss(name, publish = "") {
  const src = fakePackage(`pkg-${name}`);
  const home = path.join(tmp, `home-${name}`);
  fs.mkdirSync(home);
  assert.equal(install(src, home).status, 0);
  const apps = path.join(home, ".onionskin", "app");
  fs.writeFileSync(path.join(apps, "9.9.9", "old-marker"), "old");
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "mv"), `#!/bin/sh
case "$1" in */.incoming-*) echo ${process.pid} > "$HOME/.onionskin/install.lock/pid"; ${publish} exit 1;; esac
/bin/mv "$@"
`, { mode: 0o755 });
  const r = spawnSync("/bin/sh", [path.join(src, "install.sh"), "--no-checker"], {
    encoding: "utf8", env: { HOME: home, TMPDIR: home, PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin` },
  });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /Another Onionskin install or update is running/);
  assert.equal(fs.readFileSync(path.join(home, ".onionskin", "install.lock", "pid"), "utf8").trim(), String(process.pid), "the other lock is left alone");
  return { r, apps, aside: fs.readdirSync(apps).filter((n) => n.startsWith("9.9.9.old.")) };
}

test("D1: a failed publish that has lost the lock puts the old copy back when nothing took its name", () => {
  const { r, apps, aside } = failedPublishAfterLockLoss("lock-rollback");
  assert.deepEqual(aside, [], fs.readdirSync(apps).join(","));
  assert.equal(fs.readFileSync(path.join(apps, "9.9.9", "old-marker"), "utf8"), "old", "the launcher's copy is back");
  assert.doesNotMatch(r.stdout, /set aside/);
});

test("D1: a failed publish that has lost the lock leaves the old copy aside, and says where, when another copy took its name", () => {
  const { r, apps, aside } = failedPublishAfterLockLoss("lock-rollback-taken", 'mkdir "$2" && echo other > "$2/other-marker";');
  assert.equal(fs.readFileSync(path.join(apps, "9.9.9", "other-marker"), "utf8"), "other\n", "the other installer's copy is untouched");
  assert.equal(fs.existsSync(path.join(apps, "9.9.9", "old-marker")), false);
  assert.deepEqual(fs.readdirSync(path.join(apps, "9.9.9")), ["other-marker"], "nothing was moved inside it");
  assert.equal(aside.length, 1, fs.readdirSync(apps).join(","));
  assert.equal(fs.readFileSync(path.join(apps, aside[0], "old-marker"), "utf8"), "old");
  const where = path.join(apps, aside[0]);
  assert.ok(r.stdout.split("\n").includes(`  Another copy was installed at ${path.join(apps, "9.9.9")} meanwhile, so your previous copy was left at ${where}.`), r.stdout);
});

test("D1: --uninstall that loses its lock after removing the app leaves the skill folders alone", () => {
  const src = fakePackage("pkg-lock-skills");
  const home = path.join(tmp, "home-lock-skills");
  fs.mkdirSync(home);
  assert.equal(install(src, home).status, 0);
  const skill = path.join(home, ".claude", "skills", "onionskin");
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(path.join(skill, "SKILL.md"), "---\nname: onionskin\n---\n");
  const lock = path.join(home, ".onionskin", "install.lock");
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "rm"), `#!/bin/sh
/bin/rm "$@" || exit 1
case "$2" in */.onionskin/app) echo ${process.pid} > "$HOME/.onionskin/install.lock/pid";; esac
`, { mode: 0o755 });
  const r = spawnSync("/bin/sh", [path.join(src, "install.sh"), "--no-checker", "--uninstall"], {
    encoding: "utf8", env: { HOME: home, TMPDIR: home, PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin` },
  });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /Another Onionskin install or update is running/);
  assert.ok(fs.existsSync(path.join(skill, "SKILL.md")), "the skill folder was not removed without the lock");
  assert.equal(fs.readFileSync(path.join(lock, "pid"), "utf8").trim(), String(process.pid));
});

test("D1: --uninstall that loses its lock after stopping the server removes neither the launcher nor the app", async () => {
  const src = fakePackage("pkg-lock-uninstall");
  const home = path.join(tmp, "home-lock-uninstall");
  fs.mkdirSync(home);
  const lock = path.join(home, ".onionskin", "install.lock", "pid");
  const sleeper = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
  const closed = new Promise((resolve) => sleeper.once("close", resolve));
  try {
    fs.writeFileSync(path.join(src, "src", "cli.js"), versionCli + `if (process.argv[2] === "stop") require("node:fs").writeFileSync(${JSON.stringify(lock)}, "${sleeper.pid}");\n`);
    assert.equal(install(src, home).status, 0);
    const r = install(src, home, "--uninstall");
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /Another Onionskin install or update is running/);
    assert.ok(fs.existsSync(path.join(home, ".local", "bin", "onionskin")), "launcher kept");
    assert.ok(fs.existsSync(path.join(home, ".onionskin", "app", "9.9.9")), "app kept");
    assert.equal(fs.readFileSync(lock, "utf8"), String(sleeper.pid), "the other lock is left alone");
  } finally {
    sleeper.kill();
    await closed;
  }
});

test("D1: exit cleanup removes the lock only when it is still the folder this installer made, not by number alone", () => {
  const src = fakePackage("pkg-lock-cleanup");
  const home = path.join(tmp, "home-lock-cleanup");
  fs.mkdirSync(home);
  const lock = path.join(home, ".onionskin", "install.lock");
  // During skill setup, the lock folder is replaced by a new folder holding the installer's own number.
  fs.writeFileSync(path.join(src, "src", "cli.js"), versionCli + `if (process.argv[2] === "setup") {
    const fs = require("node:fs"), L = ${JSON.stringify(lock)}, pid = fs.readFileSync(L + "/pid", "utf8");
    fs.rmSync(L, { recursive: true }); fs.mkdirSync(L); fs.writeFileSync(L + "/pid", pid);
  }\n`);
  const r = install(src, home);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(fs.existsSync(lock), "a lock folder this installer did not make is left in place");
  // the ordinary case: the installer's own lock is removed on exit
  const plain = fakePackage("pkg-lock-cleanup-plain");
  const home2 = path.join(tmp, "home-lock-cleanup-plain");
  fs.mkdirSync(home2);
  assert.equal(install(plain, home2).status, 0);
  assert.equal(fs.existsSync(path.join(home2, ".onionskin", "install.lock")), false);
});
