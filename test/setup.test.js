import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { claudePluginProvides, parseSetupArgs, runSetup, skillTargets } from "../src/setup.js";

// temp HOME dirs only: the real home is never touched
const roots = [];
const tmpHome = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "os-home-"));
  roots.push(d);
  return fs.realpathSync(d);
};
after(() => roots.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const never = async () => assert.fail("must not ask");
const opts = (home, extra = {}) => ({ home, ask: never, python: () => null, ...extra });
const listing = (dir) => fs.readdirSync(dir, { recursive: true }).sort();

test("setup installs the skill folder into both agent skill directories and prints what it did", async () => {
  const home = tmpHome();
  const r = await runSetup([], opts(home));
  assert.equal(r.exit, 0, r.lines.join("\n"));
  for (const t of skillTargets(home)) {
    assert.ok(fs.statSync(path.join(t, "SKILL.md")).isFile());
    assert.ok(fs.statSync(path.join(t, "reference", "ops.md")).isFile());
    assert.ok(r.lines.some((l) => l === `${t}: installed`), r.lines.join("\n"));
  }
  assert.deepEqual(listing(skillTargets(home)[0]), listing(skillTargets(home)[1]));
  assert.ok(r.lines.some((l) => /deeper checker: not set up.*setup-checker/.test(l)));
  assert.ok(r.lines.some((l) => /^node .*: ok/.test(l)));
});

test("setup is idempotent, --dry-run writes nothing, a too-old node is reported", async () => {
  const home = tmpHome();
  const dry = await runSetup(["--dry-run"], opts(home));
  assert.equal(dry.exit, 0);
  assert.ok(dry.lines.some((l) => l.startsWith("[dry run] ") && l.endsWith(": installed")));
  assert.equal(fs.existsSync(path.join(home, ".claude")), false, "dry run created nothing");
  await runSetup([], opts(home));
  const again = await runSetup([], opts(home));
  assert.ok(again.lines.filter((l) => l.endsWith(": already up to date")).length === 2, again.lines.join("\n"));
  const old = await runSetup(["--dry-run"], opts(home, { nodeVersion: "20.1.0" }));
  assert.equal(old.exit, 1);
  assert.match(old.lines[0], /too old/);
});

test("a different existing version is kept unless the answer is yes or --force is given", async () => {
  const home = tmpHome();
  const [claude, agents] = skillTargets(home);
  fs.mkdirSync(claude, { recursive: true });
  fs.writeFileSync(path.join(claude, "SKILL.md"), "---\nname: onionskin\n---\nold local copy\n");
  fs.writeFileSync(path.join(claude, "extra.txt"), "mine");
  const asked = [];
  const no = await runSetup([], opts(home, { ask: async (q) => (asked.push(q), false) }));
  assert.equal(no.exit, 1);
  assert.equal(asked.length, 1);
  assert.match(asked[0], /different content/);
  assert.equal(fs.readFileSync(path.join(claude, "SKILL.md"), "utf8").includes("old local copy"), true, "left as it was");
  assert.ok(fs.existsSync(path.join(claude, "extra.txt")));
  assert.ok(fs.existsSync(path.join(agents, "SKILL.md")), "the other target was still installed");
  const dry = await runSetup(["--dry-run"], opts(home));
  assert.ok(dry.lines.some((l) => /would ask before replacing/.test(l)));
  assert.ok(fs.existsSync(path.join(claude, "extra.txt")));
  const yes = await runSetup([], opts(home, { ask: async () => true }));
  assert.equal(yes.exit, 0);
  assert.ok(yes.lines.some((l) => l === `${claude}: replaced`));
  assert.equal(fs.existsSync(path.join(claude, "extra.txt")), false);
  fs.writeFileSync(path.join(agents, "SKILL.md"), "tampered");
  const forced = await runSetup(["--force"], opts(home));
  assert.equal(forced.exit, 0);
  assert.ok(fs.readFileSync(path.join(agents, "SKILL.md"), "utf8").startsWith("---\nname: onionskin"));
  assert.deepEqual(fs.readdirSync(path.dirname(claude)).filter((n) => n.startsWith(".onionskin")), [], "no temp folders left");
});

test("a symlink or a file in the way is never replaced; uninstall removes only our folders", async () => {
  const home = tmpHome();
  const [claude, agents] = skillTargets(home);
  const elsewhere = path.join(home, "elsewhere");
  fs.mkdirSync(elsewhere);
  fs.mkdirSync(path.dirname(claude), { recursive: true });
  fs.symlinkSync(elsewhere, claude);
  const r = await runSetup(["--force"], opts(home));
  assert.equal(r.exit, 1);
  assert.ok(fs.lstatSync(claude).isSymbolicLink(), "symlink untouched");
  assert.ok(fs.existsSync(path.join(agents, "SKILL.md")));
  const un = await runSetup(["--uninstall"], opts(home));
  assert.equal(un.exit, 1, "the symlink is not ours to remove");
  assert.equal(fs.existsSync(agents), false, "our folder was removed");
  assert.ok(fs.existsSync(elsewhere));
  fs.rmSync(claude);
  fs.mkdirSync(claude);
  fs.writeFileSync(path.join(claude, "SKILL.md"), "---\nname: something-else\n---\n");
  const other = await runSetup(["--uninstall"], opts(home));
  assert.ok(other.lines.some((l) => l.includes("left alone")));
  assert.ok(fs.existsSync(path.join(claude, "SKILL.md")), "another skill's folder is never removed");
  const dryUn = await runSetup(["--uninstall", "--dry-run"], opts(home));
  assert.equal(dryUn.exit, 1);
  assert.equal((await runSetup(["--uninstall"], opts(tmpHome()))).exit, 0, "nothing installed is not an error");
});

test("Ctrl-C during skill replacement leaves a complete skill at the original path", async () => {
  const home = tmpHome();
  const [target] = skillTargets(home);
  await runSetup([], opts(home));
  const file = path.join(target, "SKILL.md");
  const current = fs.readFileSync(file, "utf8");
  const previous = current + "\nOlder copy.\n";
  fs.writeFileSync(file, previous);
  const script = `
    import fs from "node:fs";
    import { runSetup } from "./src/setup.js";
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (to === process.argv[1]) process.kill(process.pid, "SIGINT");
      return rename(from, to);
    };
    await runSetup(["--force"]);
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script, target], {
    cwd: repo, env: { ...process.env, HOME: home, ONIONSKIN_STATE_DIR: path.join(home, "st") },
  });
  assert.equal(r.signal, "SIGINT", String(r.stderr));
  assert.ok([current, previous].includes(fs.readFileSync(file, "utf8")));
  assert.ok(fs.statSync(path.join(target, "reference", "ops.md")).isFile());
});

test("setup arguments are validated", () => {
  assert.deepEqual(parseSetupArgs(["--force", "--dry-run"]), { dryRun: true, force: true, uninstall: false });
  assert.throws(() => parseSetupArgs(["--bogus"]), /unknown option/);
  assert.throws(() => parseSetupArgs(["x"]), /unexpected argument/);
  assert.throws(() => parseSetupArgs(["--uninstall", "--force"]), /--force/);
});

test("cli: `onionskin setup` honors HOME and `--version` prints the package version", () => {
  const home = tmpHome();
  const run = (args) => spawnSync(process.execPath, [path.join(repo, "src", "cli.js"), ...args], { encoding: "utf8", env: { ...process.env, HOME: home, ONIONSKIN_STATE_DIR: path.join(home, "st") } });
  const r = run(["setup"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(home, ".claude", "skills", "onionskin", "SKILL.md")));
  assert.ok(fs.existsSync(path.join(home, ".agents", "skills", "onionskin", "SKILL.md")));
  const v = run(["--version"]);
  assert.equal(v.stdout.trim(), JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")).version);
  assert.equal(run(["setup", "--bogus"]).status, 1);
  assert.equal(run(["setup", "--uninstall"]).status, 0);
  assert.equal(fs.existsSync(path.join(home, ".claude", "skills", "onionskin")), false);
});

test("setup detects a stale install and prints how to refresh it; byte-identical after the refresh (item 9)", async () => {
  const home = tmpHome();
  const [claude, agents] = skillTargets(home);
  await runSetup([], opts(home));
  fs.writeFileSync(path.join(claude, "SKILL.md"), fs.readFileSync(path.join(claude, "SKILL.md"), "utf8") + "\nan older protocol\n");
  const stale = await runSetup([], opts(home, { ask: async () => false }));
  assert.equal(stale.exit, 1, "a stale install is not silently accepted");
  assert.ok(stale.lines.some((l) => l.startsWith(`${claude}: STALE`) && /onionskin setup --force/.test(l)), stale.lines.join("\n"));
  assert.ok(stale.lines.some((l) => l === `${agents}: already up to date`), "the up to date copy is not flagged");
  const dry = await runSetup(["--dry-run"], opts(home));
  assert.ok(dry.lines.some((l) => /STALE: refresh with: onionskin setup --force/.test(l)));
  const fixed = await runSetup(["--force"], opts(home));
  assert.equal(fixed.exit, 0);
  const src = fs.readFileSync(path.join(repo, "skills", "onionskin", "SKILL.md"));
  for (const t of [claude, agents]) assert.ok(fs.readFileSync(path.join(t, "SKILL.md")).equals(src), `${t} is byte-identical to the repo copy`);
});

test("voice.md beside the skill (the maintainer's own guide) is never installed and never makes the folders read as different", async () => {
  const home = tmpHome();
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "skill-src-"));
  roots.push(source);
  fs.cpSync(path.join(repo, "skills", "onionskin"), source, { recursive: true });
  fs.writeFileSync(path.join(source, "voice.md"), "## In short\nPrivate words.\n");
  await runSetup([], opts(home, { source }));
  for (const dir of skillTargets(home)) {
    assert.equal(fs.existsSync(path.join(dir, "voice.md")), false, `${dir} got voice.md`);
    assert.equal(fs.existsSync(path.join(dir, "voice.example.md")), true, "the sample is installed");
  }
  const again = await runSetup(["--dry-run"], opts(home, { source }));
  assert.match(JSON.stringify(again), /up to date/);
});

// The Claude Code plugin route (/plugin install onionskin@onionskin) gives Claude Code the skill as onionskin:onionskin. With a user-scope
// install record, setup leaves ~/.claude/skills/onionskin out (and removes its own old copy) so the skill does not show twice; every
// other case installs the folder as before. The record's shape is what Claude Code 2.1.323 wrote in a real install.
const pluginRecord = (home, { scope = "user", id = "onionskin@onionskin", enabled } = {}) => {
  fs.mkdirSync(path.join(home, ".claude", "plugins"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { [id]: [{ scope, installPath: "/x", version: "3c07e7bd445a" }] } }));
  if (enabled !== undefined) fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { [id]: enabled } }));
};

test("with the Claude Code plugin installed, setup skips the Claude Code skill folder, removes its own old copy, and leaves a foreign one", async () => {
  const home = tmpHome();
  const [claude, agents] = skillTargets(home);
  pluginRecord(home);
  assert.deepEqual(claudePluginProvides(home), { id: "onionskin@onionskin", dir: "/x" });
  const r = await runSetup([], opts(home));
  assert.equal(r.exit, 0, r.lines.join("\n"));
  assert.equal(fs.existsSync(claude), false);
  assert.ok(fs.existsSync(path.join(agents, "SKILL.md")), "the shared agents folder is still installed");
  assert.ok(r.lines.includes(`${claude}: skipped (the Claude Code plugin onionskin@onionskin provides this skill)`), r.lines.join("\n"));
  // an earlier install's copy is ours: removed (a dry run first changes nothing)
  fs.cpSync(path.join(repo, "skills", "onionskin"), claude, { recursive: true });
  const dry = await runSetup(["--dry-run"], opts(home));
  assert.ok(fs.existsSync(claude) && dry.lines.some((l) => l.startsWith(`[dry run] ${claude}: removed`)), dry.lines.join("\n"));
  await runSetup([], opts(home));
  assert.equal(fs.existsSync(claude), false);
  // a copy that differs (an older version, or edited) is removed only after a yes or with --force
  fs.cpSync(path.join(repo, "skills", "onionskin"), claude, { recursive: true });
  fs.appendFileSync(path.join(claude, "SKILL.md"), "\nedited\n");
  const asked = [];
  const kept = await runSetup([], opts(home, { ask: async (q) => (asked.push(q), false) }));
  assert.equal(asked.length, 1);
  assert.ok(fs.existsSync(claude) && kept.lines.some((l) => l.startsWith(`${claude}: kept`) && l.endsWith("onionskin setup --force")), kept.lines.join("\n"));
  await runSetup(["--force"], opts(home));
  assert.equal(fs.existsSync(claude), false);
  // someone else's folder of that name is never touched
  fs.mkdirSync(claude, { recursive: true });
  fs.writeFileSync(path.join(claude, "SKILL.md"), "---\nname: something-else\n---\n");
  const left = await runSetup([], opts(home));
  assert.ok(fs.existsSync(path.join(claude, "SKILL.md")) && left.lines.some((l) => l.startsWith(`${claude}: left alone`)), left.lines.join("\n"));
});

test("the plugin skip fails toward installing: project scope, a disabled plugin, another plugin's name or an unreadable record", async () => {
  const unreadable = (h) => {
    fs.mkdirSync(path.join(h, ".claude", "plugins"), { recursive: true });
    fs.writeFileSync(path.join(h, ".claude", "plugins", "installed_plugins.json"), "{not json");
  };
  for (const prepare of [(h) => pluginRecord(h, { scope: "project" }), (h) => pluginRecord(h, { enabled: false }), (h) => pluginRecord(h, { id: "other@onionskin" }), unreadable]) {
    const home = tmpHome();
    prepare(home);
    assert.equal(claudePluginProvides(home), null);
    const r = await runSetup([], opts(home));
    assert.equal(r.exit, 0, r.lines.join("\n"));
    assert.ok(fs.existsSync(path.join(skillTargets(home)[0], "SKILL.md")));
  }
});
