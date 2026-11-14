import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { formatDoctor, runDoctor } from "../src/doctor.js";
import { runSetup } from "../src/setup.js";

// temp HOME dirs only: the real home is never touched
const roots = [];
const tmpHome = () => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "os-doc-")));
  roots.push(d);
  return d;
};
after(() => roots.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// no Apple helper is looked for in this repo (a built one would otherwise be asked with --probe)
const probes = { defaultBrowser: () => "com.apple.safari", browsers: () => ["Google Chrome"], freeBytes: () => 50 * 1024 ** 3, apple: { dir: path.join(os.tmpdir(), "os-doc-no-helper") } };
const sysPath = `${path.dirname(process.execPath)}:/usr/bin:/bin`;
const line = (r, name) => r.checks.find((c) => c.name.startsWith(name));

async function install(home, { onPath = true } = {}) {
  const s = await runSetup([], { home, ask: async () => assert.fail("must not ask"), python: () => null });
  assert.equal(s.exit, 0, s.lines.join("\n"));
  const bin = path.join(home, ".local", "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "onionskin"), `#!/bin/sh\nexec node "${repo}/src/cli.js" "$@"\n`, { mode: 0o755 });
  return { HOME: home, PATH: onPath ? `${bin}:${sysPath}` : sysPath, ONIONSKIN_STATE_DIR: path.join(home, ".onionskin") };
}

test("doctor: a fresh home fails the required install checks and each failing line ends with the fix command", async () => {
  const home = tmpHome();
  const r = await runDoctor({ home, env: { HOME: home, PATH: sysPath }, probes });
  assert.equal(r.ok, false);
  assert.equal(line(r, "launcher").status, "MISSING");
  assert.match(formatDoctor(r), /MISSING\s+skill for Claude Code: .*Fix: onionskin setup\n/);
  assert.equal(line(r, "skill for Claude Code").fix, "onionskin setup");
  assert.equal(line(r, "deeper check").required, false);
});

test("doctor: an installed home passes; optional items never fail it; --json has the documented shape", async () => {
  const home = tmpHome();
  const env = await install(home);
  const r = await runDoctor({ home, env, probes });
  assert.equal(r.ok, true, JSON.stringify(r.checks.filter((c) => c.status === "MISSING")));
  assert.equal(r.schema, "onionskin.doctor/1");
  for (const c of r.checks) assert.deepEqual(Object.keys(c).filter((k) => !["fix"].includes(k)).sort(), ["detail", "name", "required", "status"]);
  assert.equal(line(r, "skill for Claude Code").status, "OK");
  assert.equal(line(r, "app file integrity").status, "OK");
  assert.equal(line(r, "default browser").status, "NOTE", "a non-Chrome default browser is a NOTE");
  assert.equal(line(r, "server").status, "NOTE");
  assert.equal(line(r, "deeper check").status, "NOTE");
});

test("doctor: a stale skill is MISSING with `onionskin setup --force`; a launcher dir off PATH is only a NOTE with the PATH line", async () => {
  const home = tmpHome();
  const env = await install(home, { onPath: false });
  fs.appendFileSync(path.join(home, ".claude", "skills", "onionskin", "SKILL.md"), "\nlocal edit\n");
  const r = await runDoctor({ home, env, probes });
  const stale = line(r, "skill for Claude Code");
  assert.equal(stale.status, "MISSING");
  assert.equal(stale.fix, "onionskin setup --force");
  assert.equal(r.ok, false);
  const p = r.checks.find((c) => c.name === "~/.local/bin on PATH");
  assert.equal(p.status, "NOTE");
  assert.match(p.fix, /\.zshrc/);
  fs.rmSync(path.join(home, ".claude", "skills", "onionskin", "SKILL.md"));
  fs.cpSync(path.join(repo, "skills", "onionskin"), path.join(home, ".claude", "skills", "onionskin"), { recursive: true });
  const r2 = await runDoctor({ home, env, probes });
  assert.equal(r2.ok, true, "a launcher dir missing from PATH does not fail the command");
});

test("doctor: output never carries the home path, tokens or hashes, and ends with the copy line", async () => {
  const home = tmpHome();
  const env = await install(home);
  const text = formatDoctor(await runDoctor({ home, env, probes, verbose: true }));
  assert.ok(!text.includes(home), "home is shown as ~");
  assert.match(text, /~\/\.claude\/skills\/onionskin/);
  assert.ok(!/[0-9a-f]{24,}/i.test(text) && !/b_[0-9a-f]{12}:/.test(text), "no token or hash looking string");
  assert.ok(text.endsWith("Copy everything above when reporting a problem.\n"));
});

test("doctor: free disk space below the floor is a required failure", async () => {
  const home = tmpHome();
  const r = await runDoctor({ home, env: { HOME: home, PATH: sysPath }, probes: { ...probes, freeBytes: () => 10 * 1048576 } });
  assert.equal(line(r, "free disk").status, "MISSING");
});

test("onionskin doctor --json: exit code follows the required checks (fresh HOME exits 1) and stdout is pure JSON", () => {
  const home = tmpHome();
  const r = spawnSync(process.execPath, [path.join(repo, "src", "cli.js"), "doctor", "--json"], { env: { HOME: home, PATH: sysPath }, encoding: "utf8" });
  assert.equal(r.status, 1, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.ok, false);
  assert.ok(!r.stdout.includes(home));
  const bad = spawnSync(process.execPath, [path.join(repo, "src", "cli.js"), "doctor", "--nope"], { env: { HOME: home, PATH: sysPath }, encoding: "utf8" });
  assert.equal(bad.status, 1);
});

test("doctor: quick fixes read as off with the plain sentence, on once set up, and say why Apple's model is not available", async () => {
  const home = tmpHome();
  const state = path.join(home, ".onionskin");
  const env = { HOME: home, PATH: sysPath };
  // a stand-in for the shipped helper and its onionskin-fm.json; it is never run: the probe is a stub that records its calls
  const dir = path.join(home, "helper");
  fs.mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, "onionskin-fm");
  fs.writeFileSync(bin, "#!/bin/sh\nexit 9\n", { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "onionskin-fm.json"), JSON.stringify({ sha256: crypto.createHash("sha256").update(fs.readFileSync(bin)).digest("hex") }));
  let marked = false;
  let host = { macos: "26.1", appleSilicon: true };
  let answer = { status: 0, stdout: "available\n" };
  const probed = [];
  const p = () => ({ ...probes, apple: { dir, host, quarantined: () => marked }, appleProbe: async (b) => (probed.push(b), answer) });
  const qs = async () => line(await runDoctor({ home, env, probes: p() }), "quick fixes");

  const off = await runDoctor({ home, env, probes: p() });
  assert.equal(line(off, "quick fixes").status, "NOTE");
  assert.match(line(off, "quick fixes").detail, /^off\. To turn them on, ask the agent to set them up$/);
  assert.deepEqual(probed, [bin], "a helper that passed every check is asked once");
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, "rewriter.json"), JSON.stringify({ backend: "apple", model: "apple" }));
  assert.deepEqual(await qs(), { status: "OK", name: "quick fixes", detail: "on (Apple's built-in model): spelling and grammar fixes on one sentence", required: false });
  answer = { status: 1, stdout: "unavailable: appleIntelligenceNotEnabled\n" };
  assert.equal((await qs()).detail, "set up, but not available now: Turn on Apple Intelligence in System Settings to get quick spelling and grammar fixes. Fix grammar goes to the agent.");
  answer = { status: 1, stdout: "unavailable: modelNotReady\n" };
  assert.match((await qs()).detail, /Apple's writing model is still getting ready\. Try again in a few minutes\./);
  answer = { status: 1, stdout: "unavailable: deviceNotEligible\n" };
  assert.match((await qs()).detail, /This Mac cannot run Apple's on-device writing model\./);
  answer = { status: null, stdout: "" };
  assert.equal((await qs()).detail, "set up, but not available now: Apple's built-in model did not say whether it is available. Fix grammar goes to the agent.");

  // decided before any launch: an older macOS, and a helper that still carries the download mark, are never started
  probed.length = 0;
  host = { macos: "15.6", appleSilicon: true };
  assert.equal((await qs()).detail, "off: Quick fixes need macOS 26 or later. Fix grammar goes to the agent.");
  host = { macos: "26.1", appleSilicon: true };
  marked = true;
  assert.equal((await qs()).detail, "off: macOS is holding back the small helper for quick fixes because it came from a download. Install Onionskin again to clear that. Fix grammar goes to the agent.");
  assert.deepEqual(probed, [], "the helper was not started");
  marked = false;
  fs.appendFileSync(bin, "# changed\n");
  const damaged = await runDoctor({ home, env, probes: p() });
  assert.equal(line(damaged, "quick fixes").status, "NOTE");
  assert.match(line(damaged, "quick fixes").detail, /missing or damaged in this copy of Onionskin\. Install Onionskin again to fix it\./);
  assert.deepEqual(probed, []);
  assert.equal(damaged.ok, off.ok, "an optional line never changes the verdict");
});
