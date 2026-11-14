import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { PRODUCT } from "./constants.js";
import { findPython } from "./checker.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const SKILL_SOURCE = path.join(here, "..", "skills", PRODUCT.bin);
const MIN_NODE = 22;

/** Where agents read skills: Claude Code and the shared agents folder (Codex and others). Relative to the home directory. */
export const skillTargets = (home) => [path.join(home, ".claude", "skills", PRODUCT.bin), path.join(home, ".agents", "skills", PRODUCT.bin)];

/**
 * `{ id, dir }` (the plugin id `onionskin@<marketplace>` and its installed folder) when the Claude Code plugin route already gives
 * Claude Code this skill for every project: an install record with scope "user" in ~/.claude/plugins/installed_plugins.json that
 * ~/.claude/settings.json does not turn off. Then a ~/.claude/skills/onionskin folder would make the same skill show twice. Anything
 * unreadable or unexpected returns null, so setup installs the folder as before. Reads only the default ~/.claude, like skillTargets
 * (a CLAUDE_CONFIG_DIR elsewhere is not looked at). The Codex plugin is not handled: ~/.agents/skills is shared by other agents too,
 * so that folder is always installed.
 */
export function claudePluginProvides(home) {
  try {
    const rec = JSON.parse(fs.readFileSync(path.join(home, ".claude", "plugins", "installed_plugins.json"), "utf8"));
    let enabled = {};
    try {
      enabled = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8")).enabledPlugins || {};
    } catch {}
    for (const [id, installs] of Object.entries(rec?.plugins || {})) {
      if (id.split("@")[0] !== PRODUCT.bin || enabled[id] === false || !Array.isArray(installs)) continue;
      const user = installs.find((i) => i?.scope === "user");
      if (user) return { id, dir: typeof user.installPath === "string" ? user.installPath : null };
    }
  } catch {}
  return null;
}

export function parseSetupArgs(rest) {
  const a = { dryRun: false, force: false, uninstall: false };
  for (const x of rest) {
    if (x === "--dry-run") a.dryRun = true;
    else if (x === "--force") a.force = true;
    else if (x === "--uninstall") a.uninstall = true;
    else if (x.startsWith("-")) throw new Error(`unknown option ${x}`);
    else throw new Error(`unexpected argument ${x}`);
  }
  if (a.uninstall && a.force) throw new Error("--force has no meaning with --uninstall");
  return a;
}

/** The person's own voice guide beside the skill (src/voice-store.js reads it like a .env): never copied to an installed skill folder, never compared. */
const PERSONAL = "voice.md";

/** Every regular file under `dir` as [relative path, sha256], sorted. Symlinks and special files are not followed (a skill folder holds plain files). */
function tree(dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((x, y) => (x.name < y.name ? -1 : 1))) {
      const p = path.join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (r === PERSONAL) continue;
      if (e.isDirectory()) walk(p, r);
      else if (e.isFile()) out.push([r, crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex")]);
      else out.push([r, `non-regular:${e.isSymbolicLink() ? "symlink" : "special"}`]);
    }
  };
  walk(dir, "");
  return out;
}
const same = (a, b) => JSON.stringify(tree(a)) === JSON.stringify(tree(b));
/** true when the installed skill folder `dir` is byte-identical to `source` (default: this app's copy) */
export const skillMatches = (dir, source = SKILL_SOURCE) => same(dir, source);

/** true when `dir` is a skill folder of this tool (its SKILL.md frontmatter says `name: onionskin`) */
function isOurs(dir) {
  try {
    const head = fs.readFileSync(path.join(dir, "SKILL.md"), "utf8").slice(0, 400);
    return new RegExp(`^name:\\s*${PRODUCT.bin}\\s*$`, "m").test(head);
  } catch {
    return false;
  }
}

function copyTree(src, dest, top = true) {
  fs.mkdirSync(dest, { recursive: true, mode: 0o755 });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (top && e.name === PERSONAL) continue;
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyTree(s, d, false);
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}

async function askYesNo(question) {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise((r) => rl.question(`${question} [y/N] `, r));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

/**
 * `onionskin setup`. Copies the skill folder to each target. Returns {exit, lines}; never writes outside `home`'s two skill folders.
 * `ask(question) -> bool` is consulted before replacing a different existing folder (never when --force).
 */
export async function runSetup(rest, { home = os.homedir(), source = SKILL_SOURCE, ask = askYesNo, nodeVersion = process.versions.node, python = findPython } = {}) {
  const a = parseSetupArgs(rest);
  const lines = [];
  const say = (s) => lines.push(s);
  let exit = 0;
  const dry = a.dryRun ? "[dry run] " : "";

  const major = Number(nodeVersion.split(".")[0]);
  if (major < MIN_NODE) {
    say(`node ${nodeVersion}: too old, ${PRODUCT.name} needs node >= ${MIN_NODE}`);
    exit = 1;
  } else say(`node ${nodeVersion}: ok (needs >= ${MIN_NODE})`);

  if (!a.uninstall && !isOurs(source)) {
    say(`cannot find the skill folder to install at ${source}`);
    return { exit: 1, lines };
  }

  const plugin = a.uninstall ? null : claudePluginProvides(home)?.id;
  for (const target of skillTargets(home)) {
    let st = null;
    try {
      st = fs.lstatSync(target);
    } catch {}
    if (plugin && target === skillTargets(home)[0]) {
      // the Claude Code plugin already gives Claude Code this skill: a second copy here would show twice. An identical copy is removed;
      // a different one only with --force or a yes, like any replacement below.
      const twice = `the Claude Code plugin ${plugin} provides this skill, so this copy would show twice`;
      if (!st) say(`${target}: skipped (the Claude Code plugin ${plugin} provides this skill)`);
      else if (st.isSymbolicLink() || !st.isDirectory() || !isOurs(target)) say(`${target}: left alone (not a ${PRODUCT.bin} skill folder this tool installed; ${twice})`);
      else if (!same(source, target) && !a.force && (a.dryRun || !(await ask(`${target} differs from this version and ${twice}. Remove it?`)))) {
        say(`${dry}${target}: kept (it differs from this version; ${twice}). Remove it with: ${PRODUCT.bin} setup --force`);
      } else {
        if (!a.dryRun) fs.rmSync(target, { recursive: true });
        say(`${dry}${target}: removed (${twice})`);
      }
      continue;
    }
    if (a.uninstall) {
      if (!st) say(`${target}: not installed`);
      else if (st.isSymbolicLink() || !st.isDirectory() || !isOurs(target)) {
        say(`${target}: left alone (not a ${PRODUCT.bin} skill folder this tool installed)`);
        exit = 1;
      } else {
        if (!a.dryRun) fs.rmSync(target, { recursive: true });
        say(`${dry}${target}: removed`);
      }
      continue;
    }
    if (st && (st.isSymbolicLink() || !st.isDirectory())) {
      say(`${target}: left alone (it exists and is not a plain folder; move it away and run setup again)`);
      exit = 1;
      continue;
    }
    if (st && same(source, target)) {
      say(`${target}: already up to date`);
      continue;
    }
    if (st && !a.force) {
      if (a.dryRun) {
        say(`${dry}${target}: exists with different content; would ask before replacing it (--force skips the question). STALE: refresh with: ${PRODUCT.bin} setup --force`);
        continue;
      }
      if (!(await ask(`${target} exists with different content. Replace it?`))) {
        say(`${target}: kept (different version; answer yes or use --force to replace)`);
        say(`${target}: STALE: this install differs from the skill shipped with this ${PRODUCT.name}, so the agent may follow an outdated protocol. Refresh it with: ${PRODUCT.bin} setup --force`);
        exit = 1;
        continue;
      }
    }
    if (!a.dryRun) {
      // copy next to the target, then swap, so a failed copy never leaves a half-installed skill
      const parent = path.dirname(target);
      fs.mkdirSync(parent, { recursive: true });
      const tmp = path.join(parent, `.${PRODUCT.bin}.tmp-${process.pid}`);
      fs.rmSync(tmp, { recursive: true, force: true });
      copyTree(source, tmp);
      if (st) fs.rmSync(target, { recursive: true });
      fs.renameSync(tmp, target);
    }
    say(`${dry}${target}: ${st ? "replaced" : "installed"}`);
  }

  if (!a.uninstall) {
    const py = python();
    if (py) say(`deeper checker: ready (${py})`);
    else say(`deeper checker: not set up yet. The built-in checks always run; the deeper ones are turned on from the review panel, or with \`${PRODUCT.bin} setup-checker\` (uses the network once)`);
  }
  return { exit, lines };
}
