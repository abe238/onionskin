// `onionskin doctor`: one line per check, OK / MISSING / NOTE, written to be pasted into a bug report.
// MISSING on a `required` check makes the command exit 1; optional checks (Python checker, LibreOffice, ...) only ever NOTE.
// Never prints tokens, tickets, cookies, document names or document content; the home directory is shown as `~`.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCT, SERVER_PROTOCOL } from "./constants.js";
import { describeBackground, normalizeBackground } from "./settings.js";
import { PROBE_REASONS, appleHelperState, appleStateLine, rewriterStatus } from "./rewriter.js";
import { probeHelper } from "./rewriter-setup.js";
import { SKILL_SOURCE, claudePluginProvides, skillMatches, skillTargets } from "./setup.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = PRODUCT.bin;
const DEFAULT_APP_ROOT = path.resolve(here, "..");
const PATH_FIX = `echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc   (then open a new Terminal window)`;
const REINSTALL_FIX = "sh install.sh   (from the unzipped onionskin folder)";

const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
function hashTree(dir) {
  const out = {};
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else if (e.isFile()) out[r] = sha(path.join(d, e.name));
    }
  };
  walk(dir, "");
  return out;
}

/** Compares vendor/engine and vendor/engine-node with the hashes in vendor/engine.lock.json (what `npm run verify:vendor` checks, minus the build-time entry hash). */
function verifyVendor(appRoot) {
  const lockPath = path.join(appRoot, "vendor", "engine.lock.json");
  if (!fs.existsSync(lockPath)) return { present: false, problems: [] };
  const problems = [];
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  const cmp = (label, dir, files) => {
    const now = fs.existsSync(dir) ? hashTree(dir) : {};
    for (const [f, h] of Object.entries(files || {})) if (now[f] !== h) problems.push(`${now[f] ? "changed" : "missing"} ${label}/${f}`);
    for (const f of Object.keys(now)) if (!(f in (files || {}))) problems.push(`extra ${label}/${f}`);
  };
  cmp("vendor/engine", path.join(appRoot, "vendor", "engine"), lock.files);
  if (lock.node) cmp("vendor/engine-node", path.join(appRoot, "vendor", "engine-node"), lock.node.files);
  return { present: true, problems };
}

function probeServer(sock) {
  return new Promise((resolve) => {
    if (!fs.existsSync(sock)) return resolve({ state: "none" });
    const r = http.get({ socketPath: sock, path: "/health", timeout: 1500 }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          const j = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          resolve(res.statusCode === 200 && j.protocol === SERVER_PROTOCOL ? { state: "up", sessions: Number.isInteger(j.sessions) ? j.sessions : null } : { state: "wrong" });
        } catch {
          resolve({ state: "wrong" });
        }
      });
    });
    r.on("timeout", () => (r.destroy(), resolve({ state: "dead" })));
    r.on("error", () => resolve({ state: "dead" }));
  });
}

function defaultBrowserId() {
  if (process.platform !== "darwin") return null;
  const r = spawnSync("defaults", ["read", "com.apple.LaunchServices/com.apple.launchservices.secure", "LSHandlers"], { encoding: "utf8", timeout: 4000 });
  if (r.status !== 0) return null;
  for (const block of r.stdout.split(/\n\s*\{/)) {
    const id = /LSHandlerURLScheme = https;/.test(block) ? [...block.matchAll(/LSHandlerRoleAll = "?([^";\s]+)/g)].map((m) => m[1]).filter((x) => x !== "-").pop() : null;
    if (id && id !== "-") return id;
  }
  return null;
}

const run = (cmd, args, env) => {
  try {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 8000, env });
    return r.status === 0 ? (r.stdout || r.stderr).trim() : null;
  } catch {
    return null;
  }
};

/** Parse the target cli.js path from an installer-written launcher (single- or double-quoted). */
export function parseLauncherTarget(text) {
  const sq = text.match(/exec node '((?:[^']|'\\'')+)'/);
  if (sq) return sq[1].replace(/'\\''/g, "'");
  const dq = text.match(/exec node "([^"]+)"/);
  if (dq) return dq[1];
  return null;
}

/**
 * @param {object} o  home, appRoot, env, verbose: where to look. probes: injectable `defaultBrowser()` and `freeBytes(dir)` for tests.
 * @returns {Promise<{schema:string, ok:boolean, version:string|null, checks:Array<{status:string,name:string,detail:string,fix?:string,required:boolean}>}>}
 */
export async function runDoctor(o = {}) {
  const home = o.home || os.homedir();
  const appRoot = o.appRoot || DEFAULT_APP_ROOT;
  const env = o.env || process.env;
  const state = env[`${PRODUCT.envPrefix}_STATE_DIR`] ? path.resolve(env[`${PRODUCT.envPrefix}_STATE_DIR`]) : path.join(home, PRODUCT.stateDirName);
  const homes = [...new Set([home, (() => { try { return fs.realpathSync(home); } catch { return home; } })()])].sort((a, b) => b.length - a.length);
  const show = (s) => {
    let t = String(s);
    for (const h of homes) t = t.split(h).join("~");
    return t;
  };
  const checks = [];
  const add = (status, name, detail = "", { required = false, fix } = {}) => checks.push({ status, name: show(name), detail: show(detail), ...(fix && status !== "OK" ? { fix: show(fix) } : {}), required });
  const whichAll = (name) => {
    const out = [];
    for (const d of (env.PATH || "").split(":")) {
      if (!d) continue;
      const p = path.join(d, name);
      try {
        fs.accessSync(p, fs.constants.X_OK);
        if (fs.statSync(p).isFile()) out.push(p);
      } catch {}
    }
    return out;
  };
  const which = (name) => whichAll(name)[0] || null;

  let version = null;
  try {
    version = JSON.parse(fs.readFileSync(path.join(appRoot, "package.json"), "utf8")).version;
  } catch {}

  // system
  add("NOTE", "platform", `${process.platform} ${os.arch()}, macOS ${process.platform === "darwin" ? run("sw_vers", ["-productVersion"], env) || "unknown" : "n/a"}`);
  const major = Number(process.versions.node.split(".")[0]);
  add(major >= 22 ? "OK" : "MISSING", "node", `v${process.versions.node}${major >= 22 ? "" : " (needs 22 or newer)"}`, { required: true, fix: "install Node 22 or newer: brew install node   (or https://nodejs.org/en/download)" });
  const nodeOnPath = which("node");
  add(nodeOnPath ? "OK" : "MISSING", "node on PATH", nodeOnPath || "the launcher needs `node` on PATH", { required: true, fix: "install Node (see above), then open a new Terminal window" });

  // app
  add(version ? "OK" : "MISSING", "this app copy", version ? `version ${version} at ${appRoot}` : `no package.json at ${appRoot}`, { required: true, fix: REINSTALL_FIX });
  add(fs.existsSync(path.join(appRoot, "web", "dist", "index.html")) ? "OK" : "MISSING", "web app (web/dist)", "", { required: true, fix: REINSTALL_FIX });
  add(fs.existsSync(path.join(appRoot, "vendor", "engine-node", "engine-node.mjs")) && fs.existsSync(path.join(appRoot, "vendor", "engine", "index.js")) ? "OK" : "MISSING", "document engine (vendor/)", "", { required: true, fix: REINSTALL_FIX });
  try {
    const v = verifyVendor(appRoot);
    if (!v.present) add("NOTE", "app file integrity", "no vendor lock in this copy; nothing to compare");
    else add(v.problems.length ? "MISSING" : "OK", "app file integrity", v.problems.length ? `${v.problems.length} file(s) differ from vendor/engine.lock.json: ${v.problems.slice(0, 3).join(", ")}` : "vendor files match vendor/engine.lock.json", { required: true, fix: "sh install.sh   (reinstall from the original zip)" });
  } catch (err) {
    add("MISSING", "app file integrity", `could not verify: ${err.message}`, { required: true, fix: "sh install.sh   (reinstall from the original zip)" });
  }

  // launcher
  const found = which(BIN);
  const launcher = found || path.join(home, ".local", "bin", BIN);
  if (fs.existsSync(launcher)) {
    const target = parseLauncherTarget(fs.readFileSync(launcher, "utf8"));
    // the installer writes `exec node '<app>/src/cli.js'` (or double-quoted in older versions); any other launcher (a symlink, npm link) is judged by whether it runs
    add(!target || fs.existsSync(target) ? "OK" : "MISSING", "launcher", `${launcher}${target ? ` -> ${target}` : " (custom launcher)"}`, { required: true, fix: REINSTALL_FIX });
    const v = run(launcher, ["--version"], env);
    add(v ? "OK" : "MISSING", `${BIN} --version`, v || "the launcher did not run", { required: true, fix: REINSTALL_FIX });
  } else add("MISSING", "launcher", `${launcher} not found`, { required: true, fix: REINSTALL_FIX });
  // Which copy is answering, and any other onionskin command that could answer instead (npm's global one and the installer's
  // ~/.local/bin one, for example): the first on PATH wins, so two copies can drift apart. Compared by the cli.js each one runs.
  const real = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return p;
    }
  };
  const runs = (p) => {
    try {
      const t = parseLauncherTarget(fs.readFileSync(p, "utf8").slice(0, 400)); // the installer's 2-line launcher
      return real(t || p);
    } catch {
      return real(p);
    }
  };
  const self = real(path.join(appRoot, "src", "cli.js"));
  add("NOTE", "running from", self);
  const others = new Map();
  for (const p of [...whichAll(BIN), path.join(home, ".local", "bin", BIN)]) if (fs.existsSync(p) && runs(p) !== self && !others.has(runs(p))) others.set(runs(p), p);
  for (const [t, p] of others) add("NOTE", `another ${BIN}`, `${p} runs ${t}, a different copy`, { fix: "keep one copy: remove the npm one with npm uninstall -g onionskin-cli, or the installer one with sh ~/.onionskin/app/*/install.sh --uninstall" });
  const launcherDir = path.dirname(launcher);
  const onPath = (env.PATH || "").split(":").includes(launcherDir);
  add(onPath ? "OK" : "NOTE", `${launcherDir} on PATH`, onPath ? "yes" : "no: Terminal cannot find the command by name", { fix: PATH_FIX });

  // skills
  const plugin = claudePluginProvides(home);
  const appSkill = appRoot === DEFAULT_APP_ROOT ? SKILL_SOURCE : path.join(appRoot, "skills", BIN);
  for (const [label, dir] of [["Claude Code", skillTargets(home)[0]], ["Codex / agents", skillTargets(home)[1]]]) {
    if (plugin && label === "Claude Code") {
      // the same rule `setup` uses: with the plugin installed, the folder is left out on purpose. The plugin's copy follows the
      // repository, the app's copy follows the release, so a difference between them is only a NOTE.
      const id = plugin.id;
      if (fs.existsSync(dir)) add("NOTE", `skill for ${label}`, `the Claude Code plugin ${id} provides it and ${dir} is a second copy, so it can show twice`, { fix: `${BIN} setup --force` });
      else {
        let match = false;
        try {
          match = !!plugin.dir && skillMatches(plugin.dir, appSkill);
        } catch {}
        if (match) add("OK", `skill for ${label}`, `provided by the Claude Code plugin ${id}, the same as this app's copy`);
        else add("NOTE", `skill for ${label}`, `provided by the Claude Code plugin ${id}, which differs from this app's copy`, { fix: `claude plugin marketplace update ${id.split("@")[1]}, then claude plugin update ${id}, or reinstall Onionskin` });
      }
      continue;
    }
    if (!fs.existsSync(dir)) {
      add("MISSING", `skill for ${label}`, `${dir} not found`, { required: true, fix: `${BIN} setup` });
      continue;
    }
    let same = false;
    try {
      same = skillMatches(dir, appSkill);
    } catch {}
    add(same ? "OK" : "MISSING", `skill for ${label}`, `${dir} ${same ? "matches this app's copy" : "differs from this app's copy"}`, { required: true, fix: `${BIN} setup --force` });
  }
  add(which("claude") ? "OK" : "NOTE", "Claude Code command (claude)", which("claude") || "not on PATH here (fine if you use the desktop app or Codex)");
  add(which("codex") ? "OK" : "NOTE", "Codex command (codex)", which("codex") || "not on PATH here");

  // optional deeper check
  const py = env[`${PRODUCT.envPrefix}_PYTHON`] || path.join(state, "venv", "bin", "python");
  if (fs.existsSync(py)) {
    const ok = run(py, ["-c", "import lxml, docx, openpyxl, pptx, defusedxml; print('libraries import')"], env);
    add(ok ? "OK" : "NOTE", "deeper check (Python venv)", `${py}: ${ok || "present but the libraries do not import"}`, { fix: `${BIN} setup-checker` });
  } else add("NOTE", "deeper check (Python venv)", "not set up (optional)", { fix: `${BIN} setup-checker   (needs Python 3.10+ and internet once)` });
  // quick fixes: what the setup says, then whether Apple's model can be used here (decided without starting the helper; only a helper
  // that passed every check is asked, with --probe; tests pass o.probes.apple for appleHelperState and o.probes.appleProbe)
  const rw = rewriterStatus(state, o.probes?.apple);
  const apple = appleHelperState(o.probes?.apple);
  let unavailable = apple.ok ? null : apple.reason;
  if (apple.ok && (rw.on ? rw.backend === "apple" : true)) {
    const pr = await (o.probes?.appleProbe || probeHelper)(apple.bin);
    if (pr.status !== 0) unavailable = PROBE_REASONS[/^unavailable: (\w+)/.exec(String(pr.stdout || "").trim())?.[1]] ?? "no_answer";
  }
  const line = unavailable === "no_answer" ? "Apple's built-in model did not say whether it is available." : unavailable ? appleStateLine(unavailable) : null;
  if (rw.on && !(rw.backend === "apple" && line)) add("OK", "quick fixes", `on (${rw.name}): spelling and grammar fixes on one sentence`);
  else if (line) add("NOTE", "quick fixes", `${rw.on ? "set up, but not available now" : "off"}: ${line} Fix grammar goes to the agent.`);
  else add("NOTE", "quick fixes", rw.reason === "not_set_up" ? "off. To turn them on, ask the agent to set them up" : `off: the setup is damaged (${rw.reason}). To fix it, ask the agent to set them up again`, { fix: `${BIN} setup-rewriter` });
  const soffice = ["/Applications/LibreOffice.app/Contents/MacOS/soffice"].find((p) => fs.existsSync(p)) || which("soffice");
  add(soffice ? "OK" : "NOTE", "LibreOffice (conversion check)", soffice || "not installed (optional)", { fix: "brew install --cask libreoffice" });

  // browser
  const browsers = (o.probes?.browsers ? o.probes.browsers() : [["Google Chrome", "/Applications/Google Chrome.app"], ["Safari", "/Applications/Safari.app"], ["Brave", "/Applications/Brave Browser.app"], ["Microsoft Edge", "/Applications/Microsoft Edge.app"], ["Firefox", "/Applications/Firefox.app"], ["Arc", "/Applications/Arc.app"]].filter(([, p]) => fs.existsSync(p)).map(([n]) => n));
  add(browsers.length ? "OK" : "MISSING", "browser", browsers.length ? browsers.join(", ") : "none found in /Applications", { required: true, fix: "install Google Chrome: https://www.google.com/chrome" });
  const dflt = (o.probes?.defaultBrowser || defaultBrowserId)();
  if (dflt) add(/^com\.google\.chrome$/i.test(dflt) ? "OK" : "NOTE", "default browser", /^com\.google\.chrome$/i.test(dflt) ? "Google Chrome" : `${dflt}: only Chrome is tested`, { fix: "System Settings > Desktop & Dock > Default web browser > Google Chrome" });
  else add("NOTE", "default browser", "could not be read; only Chrome is tested");

  // state dir, disk, server
  if (fs.existsSync(state)) {
    const st = fs.statSync(state);
    const ours = st.uid === process.getuid() && !(st.mode & 0o077);
    add(ours ? "OK" : "NOTE", "state folder", `${state} mode ${(st.mode & 0o777).toString(8)}, ${st.uid === process.getuid() ? "owned by you" : "NOT owned by you"}`, { fix: `chmod 700 ${state}` });
  } else add("NOTE", "state folder", `${state} does not exist yet (created on first use)`);
  try {
    let raw = {};
    try {
      raw = JSON.parse(fs.readFileSync(path.join(state, "settings.json"), "utf8"));
    } catch {}
    const b = normalizeBackground(raw?.background);
    const hasImg = ["png", "jpg", "webp"].some((e) => fs.existsSync(path.join(state, "backgrounds", `custom.${e}`)));
    const missing = b.kind === "custom" && !hasImg;
    add("NOTE", "background", missing ? "custom image chosen but its file is missing (the default is shown)" : describeBackground(b), missing ? { fix: `${BIN} config background default` } : {});
  } catch {
    add("NOTE", "background", "could not be read");
  }
  let probeDir = state;
  while (!fs.existsSync(probeDir) && path.dirname(probeDir) !== probeDir) probeDir = path.dirname(probeDir);
  try {
    const free = (o.probes?.freeBytes || ((d) => { const s = fs.statfsSync(d); return s.bavail * s.bsize; }))(probeDir);
    const mb = Math.floor(free / 1048576);
    add(mb < 200 ? "MISSING" : mb < 2048 ? "NOTE" : "OK", "free disk space", `${mb >= 1024 ? (mb / 1024).toFixed(1) + " GB" : mb + " MB"} free where the state folder lives`, { required: true, fix: "free some disk space; Onionskin keeps a snapshot of the file at every step" });
  } catch {
    add("NOTE", "free disk space", "could not be read");
  }
  const srv = await probeServer(path.join(state, "s.sock"));
  if (srv.state === "up") {
    add("OK", "server", "running and reachable on its Unix socket");
    add("NOTE", "open sessions", srv.sessions == null ? "unknown (older server)" : `${srv.sessions} (names are not printed${o.verbose ? "; --verbose does not add them either" : ""})`);
  } else if (srv.state === "none") add("NOTE", "server", "not running (it starts on the first `onionskin open`)");
  else add("NOTE", "server", srv.state === "dead" ? "a leftover socket file exists but nothing answers" : "something answered that is not this server's protocol", { fix: `${BIN} stop` });
  if (o.verbose) add("NOTE", "PATH entries", (env.PATH || "").split(":").filter(Boolean).join(" "));

  return { schema: `${BIN}.doctor/1`, ok: !checks.some((c) => c.required && c.status === "MISSING"), version, checks };
}

export function formatDoctor(r) {
  const lines = [`${PRODUCT.name} doctor${r.version ? ` ${r.version}` : ""}`, ""];
  for (const c of r.checks) lines.push(`${c.status.padEnd(8)}${c.name}${c.detail ? ": " + c.detail : ""}${c.fix ? `. Fix: ${c.fix}` : ""}`);
  lines.push("", r.ok ? "Result: OK (no required check failed)." : "Result: a required check failed (see MISSING lines).", "Copy everything above when reporting a problem.");
  return lines.join("\n") + "\n";
}
