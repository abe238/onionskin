// `onionskin update [--check] [--yes] [--force]`: brings this copy to the latest release, the way this copy was installed.
// The network is used only when a person (or their agent) runs this command: `--check` reads one small file, `version.txt`, from the
// release folder; `update` on an installer copy then runs the release's get.sh exactly as the README one-liner does (get.sh keeps the
// SHA-256 check). No prompts, no sudo; snapshots and the state folder are never deleted here.
//
// Everything this command needs after get.sh starts is imported at the top: install.sh deletes the app folder this process runs from.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PRODUCT } from "./constants.js";

const BIN = PRODUCT.bin;
export const DEFAULT_BASE_URL = "https://github.com/abe238/onionskin/releases/latest/download";
export const VERSION_FILE = "version.txt";
export const NPM_COMMANDS = ["npm install -g onionskin-cli", `${BIN} setup --force`]; // README "### Stay up to date", word for word
export const HOMEBREW_COMMANDS = [`brew upgrade ${BIN}`, `${BIN} setup --force`]; // Homebrew owns a keg's updates: this command never updates one itself
const CURL = ["-fsSL", "--connect-timeout", "20", "--max-time", "30", "--proto-redir", "=https"]; // get.sh's own flags, a shorter time limit

/**
 * get.sh's rule for its URLs, the same rule (scripts/get.sh url_ok; test/get-script.test.js checks both on one table): https://, file:///,
 * or http:// to exactly 127.0.0.1 with an optional port, for local tests. No white space anywhere, and no "@" or backslash before the
 * first "/" after the scheme: a user name hides the real host (http://127.0.0.1:80@evil.example/ is evil.example). Read as text, the way
 * the shell rule reads it, not through a URL parser that may read the host differently than curl does.
 */
export function baseUrlOk(u) {
  const s = String(u ?? "");
  if (/\s/.test(s)) return false;
  if (s.startsWith("file:///")) return true;
  const m = /^(https?):\/\/([^/]*)/.exec(s);
  if (!m || /[@\\]/.test(m[2])) return false;
  return m[1] === "https" || /^127\.0\.0\.1(?::\d+)?$/.test(m[2]);
}

/** curl's --proto for a URL baseUrlOk accepted: only the scheme of the URL itself (redirects stay https only, CURL). */
export const curlProto = (u) => {
  const s = String(u ?? "");
  if (s.startsWith("https://")) return ["--proto", "=https"];
  if (s.startsWith("file://")) return ["--proto", "=file"];
  if (/^http:\/\/127\.0\.0\.1(?::\d+)?(?:\/|$)/.test(s)) return ["--proto", "=http"];
  return ["--proto", "=https"];
};

const VERSION_RE = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const MAX_VERSION = 40; // characters of a whole version
const MAX_DIGITS = 20; // digits of one pre-release number

/** `s` as a version's parts, or null: at most MAX_VERSION characters, and no pre-release number longer than MAX_DIGITS digits. */
function versionParts(s) {
  const v = String(s || "");
  const m = v.length <= MAX_VERSION ? VERSION_RE.exec(v) : null;
  if (!m || (m[4] && m[4].split(".").some((x) => /^\d+$/.test(x) && x.length > MAX_DIGITS))) return null;
  return m;
}

/** The first line of version.txt, or null when it is not a version (the file is untrusted: install.sh's character set, 40 characters at most). */
export function parseVersionText(text) {
  const line = String(text || "").split(/\r?\n/)[0].trim();
  return /^[0-9A-Za-z.+-]+$/.test(line) && versionParts(line) ? line : null;
}

/** Two strings of digits compared as numbers of any size (no Number: past 2^53 it rounds): -1, 0 or 1. */
function compareDigits(x, y) {
  x = x.replace(/^0+(?=\d)/, "");
  y = y.replace(/^0+(?=\d)/, "");
  if (x.length !== y.length) return x.length < y.length ? -1 : 1;
  return x === y ? 0 : x < y ? -1 : 1;
}

/** -1, 0 or 1 as `a` is older than, the same as or newer than `b` (numbers compared as numbers: 0.0.10 is newer than 0.0.9); null when either is not a version. */
export function compareVersions(a, b) {
  const pa = versionParts(a);
  const pb = versionParts(b);
  if (!pa || !pb) return null;
  for (let i = 1; i <= 3; i++) if (Number(pa[i]) !== Number(pb[i])) return Number(pa[i]) < Number(pb[i]) ? -1 : 1;
  if (pa[4] === pb[4]) return 0;
  if (!pa[4]) return 1; // 1.0.0 is newer than 1.0.0-rc.1
  if (!pb[4]) return -1;
  const xa = pa[4].split(".");
  const xb = pb[4].split(".");
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    if (xa[i] === undefined) return -1;
    if (xb[i] === undefined) return 1;
    if (xa[i] === xb[i]) continue;
    const na = /^\d+$/.test(xa[i]);
    const nb = /^\d+$/.test(xb[i]);
    if (na && nb) {
      const c = compareDigits(xa[i], xb[i]);
      if (c) return c;
      continue;
    }
    if (na !== nb) return na ? -1 : 1;
    return xa[i] < xb[i] ? -1 : 1;
  }
  return 0;
}

const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

/**
 * How the copy at `appRoot` was installed: "source" (a .git file or folder beside package.json; a worktree has a .git file), "installer"
 * (~/.onionskin/app/<version>/, what install.sh makes), "homebrew" (an npm-shaped folder inside a Homebrew keg,
 * …/Cellar/<formula>/<version>/libexec/lib/node_modules/onionskin-cli), "npm" (…/node_modules/onionskin-cli) or "unknown" (an unzipped folder run directly).
 */
export function detectRoute({ appRoot, home }) {
  const root = real(appRoot);
  if (fs.existsSync(path.join(root, ".git")) && fs.existsSync(path.join(root, "package.json"))) return { route: "source", root };
  if (path.dirname(root) === path.join(real(home), PRODUCT.stateDirName, "app")) return { route: "installer", root };
  if (path.basename(root) === "onionskin-cli" && path.basename(path.dirname(root)) === "node_modules") {
    const parts = root.split(path.sep);
    const cellar = parts.lastIndexOf("Cellar");
    if (cellar >= 0 && parts[cellar + 3] === "libexec") return { route: "homebrew", root };
    return { route: "npm", root };
  }
  return { route: "unknown", root };
}

/**
 * Reads <base>/version.txt with curl (one request; curl follows the release redirect, https only). Returns
 * {version} | {missing: true, url} (the release has no version.txt, as releases up to 0.0.3) | {bad: true, url} | {unreachable: detail, url}.
 */
export function fetchLatest(base, { run = spawnSync } = {}) {
  const url = `${String(base).replace(/\/+$/, "")}/${VERSION_FILE}`;
  const r = run("curl", [...CURL, ...curlProto(url), url], { encoding: "utf8", timeout: 40_000, stdio: ["ignore", "pipe", "pipe"] });
  if (r.error) return { unreachable: r.error.code === "ENOENT" ? "curl was not found" : r.error.message, url };
  // the server answered 404 (curl says "returned error: 404", exit 22, or 56 over HTTP/2 as GitHub's redirect serves it); 37: no such file:// path
  if (/returned error: 404\b/.test(r.stderr || "")) return { missing: true, url };
  if (r.status === 37) return { missing: true, url };
  if (r.status !== 0) return { unreachable: String(r.stderr || "").trim().split("\n").pop() || `curl exit ${r.status}`, url };
  const version = parseVersionText(r.stdout);
  return version ? { version, url } : { bad: true, url };
}

/** What a running server holds that an update would cut off (from GET /cli/open-work): plain phrases, never file names. */
export function workAtRisk(w) {
  const n = (k) => (Number.isInteger(w?.[k]) && w[k] > 0 ? w[k] : 0);
  const out = [];
  const plural = (c, one, many) => `${c} ${c === 1 ? one : many}`;
  if (n("open_sessions")) out.push(plural(n("open_sessions"), "file open in a browser tab now or in the last 20 minutes (edits typed there stay in the tab until Send)", "files open in a browser tab now or in the last 20 minutes (edits typed there stay in the tab until Send)"));
  if (n("unsent_edits")) out.push(plural(n("unsent_edits"), "unsent edit", "unsent edits"));
  if (n("draft_comments")) out.push(plural(n("draft_comments"), "draft comment", "draft comments"));
  if (n("batches")) out.push(plural(n("batches"), "batch that was sent and is not finished", "batches that were sent and are not finished"));
  return out;
}

export function parseUpdateArgs(args) {
  const a = { check: false, yes: false, force: false };
  for (const x of args) {
    if (x === "--check") a.check = true;
    else if (x === "--yes") a.yes = true;
    else if (x === "--force") a.force = true;
    else if (x.startsWith("-")) throw new Error(`unknown option ${x}`);
    else throw new Error(`unexpected argument ${x}`);
  }
  return a;
}

/**
 * @param {string[]} args  the arguments after `update`
 * @param {object} d  version (running), appRoot, home, env, print(line), and the parts that act:
 *   fetchLatest(base), server: {healthy({reportMismatch: true}) -> boolean | "incompatible", openWork() -> {status, body}}, stop(), runGetSh(base) -> exit status,
 *   launcherVersion(route, root) -> string|null (the installed command's --version), run(cmd, args) -> exit status (npm --yes)
 * @returns {Promise<number>} the exit code
 */
export async function updateCommand(args, d) {
  const a = parseUpdateArgs(args);
  const say = d.print;
  const home = d.home || os.homedir();
  const env = d.env || process.env;
  const shown = (p) => {
    let t = String(p);
    for (const h of [real(home), home]) t = t.split(h).join("~");
    return t;
  };
  const base = env[`${PRODUCT.envPrefix}_BASE_URL`] || DEFAULT_BASE_URL;
  if (!baseUrlOk(base)) {
    say(`Refusing the release URL ${base} (only https:// is accepted). Nothing was changed.`);
    return 1;
  }
  const { route, root } = detectRoute({ appRoot: d.appRoot, home });
  if (route === "homebrew") {
    // before the version check on purpose: Homebrew's formula is the version that matters here, and this copy must not update itself
    say(`This copy: ${PRODUCT.name} ${d.version}`);
    say("This copy was installed with Homebrew, which manages its updates. To update it, run these two commands:");
    for (const c of HOMEBREW_COMMANDS) say(`  ${c}`);
    say("Nothing was changed.");
    return 0;
  }
  const latest = (d.fetchLatest || fetchLatest)(base);
  const cmp = latest.version ? compareVersions(d.version, latest.version) : null;

  say(`This copy: ${PRODUCT.name} ${d.version}`);
  if (latest.version) say(`Latest release: ${latest.version}`);
  else if (latest.missing) say(`Latest release: unknown (the release has no ${VERSION_FILE}, as releases up to 0.0.3 do not)`);
  else if (latest.bad) say(`Latest release: unknown (${latest.url} does not hold a version)`);
  else say(`Latest release: unknown (could not reach ${latest.url}: ${latest.unreachable})`);

  if (a.check) {
    if (latest.unreachable) {
      say("Could not check for an update. Nothing was changed.");
      return 1;
    }
    if (!latest.version) say("Could not tell whether an update exists. Nothing was changed.");
    else if (cmp < 0) say(`An update is available: run ${BIN} update`);
    else if (cmp === 0) say("Up to date.");
    else say("This copy is newer than the latest release. Nothing to update.");
    return 0;
  }

  if (route === "source") {
    say(`This is a source checkout (${shown(root)}). Update it with git: git pull, npm install, npm run build:web, then ${BIN} setup --force for the skill folders. Nothing was changed.`);
    return 0;
  }
  if (route === "unknown") {
    say(`This copy runs from ${shown(root)}, which is not the installer's folder (~/.onionskin/app), an npm install or a source checkout, so ${BIN} update cannot tell how to update it. Nothing was changed. To update, install again as the README says under Install.`);
    return 1;
  }
  if (latest.unreachable) {
    say("Not updated: could not reach the release. Nothing was changed.");
    return 1;
  }
  if (cmp === 0) {
    say(`Already up to date: ${PRODUCT.name} ${d.version} is the latest release. Nothing was changed.`);
    return 0;
  }
  if (cmp > 0) {
    say(`This copy (${d.version}) is newer than the latest release (${latest.version}). Nothing was changed.`);
    return 0;
  }
  if (route === "npm" && !a.yes) {
    say("This copy was installed with npm. To update it, run these two commands:");
    for (const c of NPM_COMMANDS) say(`  ${c}`);
    say(`Or run ${BIN} update --yes to have them run for you.`);
    return 0;
  }
  // without the release's version this cannot tell an update from a reinstall or a downgrade, so it installs nothing
  if (!latest.version) {
    say(`Not updated: the release does not say its version, so ${BIN} update cannot tell whether it is newer than this copy. Nothing was changed. To install it anyway, run the install command from the README again.`);
    return 1;
  }

  // An update restarts the server: a tab open now cannot reconnect (the new server listens on a new port). Refuse while work is open.
  let stopped = false;
  const health = await d.server.healthy({ reportMismatch: true });
  if (health) {
    if (health === "incompatible" && !a.force) {
      say(`A running Onionskin server from another version may hold unsent work: run ${BIN} stop, or ${BIN} update --force.`);
      return 1;
    }
    const w = health === true ? await d.server.openWork() : null;
    const sessions = Number.isInteger(w?.body?.sessions) ? w.body.sessions : null;
    // a server that does not count its open tabs (open_sessions) cannot vouch for edits typed in a tab: like one without the route
    const risk = w?.status === 200 && Number.isInteger(w.body?.open_sessions) ? workAtRisk(w.body) : null;
    const reason = risk ? (risk.length ? `open work that the update would cut off: ${risk.join(", ")}` : null) : sessions === 0 ? null : "a server from an older version that cannot say whether its open sessions hold unsent work";
    if (reason && !a.force) {
      say(`Not updated: ${PRODUCT.name} is running with ${reason}. The update restarts ${PRODUCT.name}, and a browser tab that is open now cannot reconnect to it, so anything not sent from it would be lost. Send or finish that work, then press Close session in the file's page (or close its tab and wait 20 minutes), and run ${BIN} update again. To update anyway, run ${BIN} update --force. Nothing was changed.`);
      return 1;
    }
    try {
      await d.stop();
    } catch (err) {
      say(`Not updated: could not stop the running ${PRODUCT.name} server (${err?.message || err}). Nothing was changed.`);
      say(`AGENT: the update did not run because the running ${PRODUCT.name} server could not be stopped. Tell the person nothing was changed and suggest running \`${BIN} stop\` or \`${BIN} doctor\`.`);
      return 1;
    }
    stopped = true;
    say(`Stopped the ${PRODUCT.name} server for the update${reason ? ` (--force: ${reason})` : ""}.`);
  }

  if (route === "npm") {
    const limit = 10 * 60_000;
    const deadline = Date.now() + limit;
    const run = d.run || runInGroup;
    for (const c of NPM_COMMANDS) {
      say(`$ ${c}`);
      const [cmd, ...rest] = c.split(" ");
      const remaining = deadline - Date.now();
      let timedOut = remaining <= 0;
      const opts = { env, timeout: remaining, totalTimeout: limit, onTimeout: () => { timedOut = true; } };
      const args = cmd === BIN ? [path.join(root, "src", "cli.js"), ...rest] : rest;
      const status = timedOut ? 1 : await run(cmd === BIN ? process.execPath : cmd, args, opts);
      if (timedOut) {
        say("The npm update timed out after 10 minutes.");
        return 1;
      }
      if (status !== 0) {
        say(`Not updated: \`${c}\` failed (exit ${status}). Run the two commands above yourself to see why.`);
        return 1;
      }
    }
    const now = d.launcherVersion(route, root);
    if (now !== latest.version) {
      say(`Not updated as expected: npm finished, but this copy now says ${now || "nothing"}, not ${latest.version} (npm may not have that version yet). Run ${BIN} doctor.`);
      return 1;
    }
    say(`UPDATED: ${PRODUCT.name} ${d.version} -> ${now} (npm).`);
    if (stopped) say(`The server was stopped; it starts again on the next ${BIN} command. Open your file again to keep working.`);
    return 0;
  }

  // the installer copy: get.sh from the same release folder, piped into sh as the README does
  say(`Running the installer from ${base}/get.sh`);
  let skillSetupFailed = false;
  let outBuf = "";
  let timedOutMs = 0;
  const scanLine = (line) => {
    if (line.includes("SKILL_SETUP_FAILED")) skillSetupFailed = true;
  };
  let noChecker = true;
  try {
    // The state folder the app uses (src/paths.js stateDir): ONIONSKIN_STATE_DIR when set, else ~/.onionskin.
    const customState = env[`${PRODUCT.envPrefix}_STATE_DIR`];
    const state = customState ? path.resolve(customState) : path.join(home, PRODUCT.stateDirName);
    noChecker = !fs.lstatSync(path.join(state, "venv", "pyvenv.cfg")).isFile();
  } catch {
    // An inaccessible or missing configuration means there is no environment to update.
  }
  const rawRes = await d.runGetSh(base, {
    noChecker,
    onOutput: (chunk) => {
      outBuf += String(chunk);
      let nl;
      while ((nl = outBuf.indexOf("\n")) !== -1) {
        scanLine(outBuf.slice(0, nl));
        outBuf = outBuf.slice(nl + 1);
      }
    },
    onTimeout: (ms) => {
      timedOutMs = ms;
    },
  });
  if (outBuf) scanLine(outBuf);
  const status = typeof rawRes === "object" && rawRes !== null ? rawRes.status : rawRes;
  if (typeof rawRes === "object" && rawRes !== null) {
    if (rawRes.skillSetupFailed) skillSetupFailed = true;
    if (rawRes.timedOut) timedOutMs = rawRes.timeoutMs || 360_000;
  }
  const now = d.launcherVersion(route, root);
  if (status !== 0) {
    if (timedOutMs) {
      const secs = Math.max(1, Math.round(timedOutMs / 1000));
      const dur = secs >= 60 && secs % 60 === 0 ? `${secs / 60} ${secs === 60 ? "minute" : "minutes"}` : `${secs}s`;
      say(`Not updated: the installer timed out after ${dur}. The command now runs ${PRODUCT.name} ${now || "(version unknown)"}.`);
    } else {
      say(`Not updated: the installer stopped (exit ${status}; its lines above say why). The command now runs ${PRODUCT.name} ${now || "(version unknown)"}.`);
    }
    return 1;
  }
  if (now !== latest.version) {
    say(`Not updated as expected: the installer finished, but ~/.local/bin/${BIN} --version says ${now || "nothing"}, not ${latest.version}. Run ${BIN} doctor.`);
    return 1;
  }
  say("");
  if (skillSetupFailed) {
    say(`UPDATED (with warning): ${PRODUCT.name} ${d.version} -> ${now}, but skill setup failed. Run \`${BIN} setup\` to finish installing the agent skill. Snapshots and settings in ~/.onionskin were kept.`);
    if (stopped) say(`The server was stopped; it starts again on the next ${BIN} command. Open your file again to keep working.`);
    say(`AGENT: this was an update to ${now}, but skill setup failed (SKILL_SETUP_FAILED). Tell the person ${PRODUCT.name} is updated to ${now}, and that skill setup did not finish so they should run \`${BIN} setup\`.`);
  } else {
    say(`UPDATED: ${PRODUCT.name} ${d.version} -> ${now}. Snapshots and settings in ~/.onionskin were kept.`);
    if (stopped) say(`The server was stopped; it starts again on the next ${BIN} command. Open your file again to keep working.`);
    say(`AGENT: this was an update. Tell the person this one sentence, and not the installer's sentence above: ${PRODUCT.name} is updated to ${now}.`);
  }
  return 0;
}

const SIG_CODES = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

/** Runs a command in its own process group; forwards signals and kills the entire process group on timeout or parent exit. */
export function runInGroup(cmd, args, { env = process.env, timeout, totalTimeout = timeout, graceMs = 500, signalGraceMs = 10_000, onOutput, onTimeout }) {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let signaled = null;
    let killTimer = null;
    let exitTimer = null;
    let stdoutBuf = "";
    let stderrBuf = "";

    let child;
    try {
      child = spawn(cmd, args, {
        detached: true,
        stdio: onOutput ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
        env,
      });
    } catch {
      return resolve(1);
    }

    const killGroup = (sig) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, sig);
      } catch {}
    };

    const emitLine = (stream, line, nl) => {
      if (onOutput) onOutput(line + nl);
      const out = line.includes("SKILL_SETUP_FAILED")
        ? `  Warning: skill setup did not finish; run '${BIN} setup' to finish installing the skill.`
        : line;
      stream.write(out + nl);
    };

    const feed = (stream, which, chunk) => {
      let buf = (which === "out" ? stdoutBuf : stderrBuf) + chunk.toString("utf8");
      let idx;
      while ((idx = buf.indexOf("\n")) !== -1) {
        emitLine(stream, buf.slice(0, idx), "\n");
        buf = buf.slice(idx + 1);
      }
      if (which === "out") stdoutBuf = buf;
      else stderrBuf = buf;
    };

    const flushStreams = () => {
      if (stdoutBuf) {
        const s = stdoutBuf;
        stdoutBuf = "";
        emitLine(process.stdout, s, "");
      }
      if (stderrBuf) {
        const s = stderrBuf;
        stderrBuf = "";
        emitLine(process.stderr, s, "");
      }
    };

    const onParentExit = () => {
      killGroup("SIGTERM");
      killGroup("SIGKILL");
    };

    const onSignal = (sig) => {
      if (settled || signaled) return;
      signaled = sig;
      killGroup(sig);
      clearTimeout(killTimer);
      const hardStop = () => {
        killGroup("SIGKILL");
        try { child.stdout?.destroy(); } catch {}
        try { child.stderr?.destroy(); } catch {}
        finish(SIG_CODES[sig] || 1);
      };
      if (signalGraceMs === 0) return hardStop();
      killTimer = setTimeout(hardStop, signalGraceMs);
      killTimer.unref?.();
    };

    const sigHandlers = ["SIGINT", "SIGTERM", "SIGHUP"].map((sig) => {
      const fn = () => onSignal(sig);
      process.on(sig, fn);
      return [sig, fn];
    });
    process.on("exit", onParentExit);

    const cleanupListeners = () => {
      for (const [sig, fn] of sigHandlers) process.off(sig, fn);
      process.off("exit", onParentExit);
    };

    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(exitTimer);
      cleanupListeners();
      // If the leader exited on timeout/signal while a descendant ignored SIGTERM/SIGINT, reap the group.
      if (timedOut || signaled) killGroup("SIGKILL");
      flushStreams();
      if (timedOut) return resolve(1);
      if (signaled) return resolve(SIG_CODES[signaled] || 1);
      resolve(code ?? 1);
    };

    child.stdout?.on("data", (buf) => feed(process.stdout, "out", buf));
    child.stderr?.on("data", (buf) => feed(process.stderr, "err", buf));
    child.once("error", () => finish(1));
    child.once("exit", (code) => {
      if (settled) return;
      exitTimer = setTimeout(() => {
        try { child.stdout?.destroy(); } catch {}
        try { child.stderr?.destroy(); } catch {}
        finish(code);
      }, graceMs);
      exitTimer.unref?.();
    });
    child.once("close", (code) => finish(code));

    const timer = setTimeout(() => {
      timedOut = true;
      if (onTimeout) onTimeout(totalTimeout);
      killGroup("SIGTERM");
      killTimer = setTimeout(() => {
        killGroup("SIGKILL");
        try { child.stdout?.destroy(); } catch {}
        try { child.stderr?.destroy(); } catch {}
        finish(1);
      }, graceMs);
      killTimer.unref?.();
    }, timeout);
    timer.unref?.();
  });
}

/** The README one-liner, run for `base` (already checked by baseUrlOk): downloads get.sh to a 0600 temp file, then executes it with /bin/sh. */
export async function runGetShDefault(base, env = process.env, { timeout = 360_000, graceMs = 500, onOutput = () => {}, onTimeout, noChecker = false } = {}) {
  const url = String(base).replace(/\/+$/, "");
  const tmpDir = fs.mkdtempSync(path.join(env.TMPDIR || os.tmpdir(), "onionskin-get-"));
  const tmpFile = path.join(tmpDir, "get.sh");
  const deadline = Date.now() + timeout;
  try {
    const fd = fs.openSync(tmpFile, "wx", 0o600);
    fs.closeSync(fd);
    const dl = spawnSync(
      "curl",
      ["-fsSL", "--connect-timeout", "20", "--max-time", "60", ...curlProto(url), "--proto-redir", "=https", "-o", tmpFile, `${url}/get.sh`],
      { stdio: ["ignore", "inherit", "inherit"], env, timeout: Math.min(70_000, timeout) }
    );
    if (dl.error || dl.status !== 0) return dl.status ?? 1;
    fs.chmodSync(tmpFile, 0o600);
    const remaining = Math.max(1, deadline - Date.now());
    const args = noChecker ? [tmpFile, "--no-checker"] : [tmpFile];
    return await runInGroup("/bin/sh", args, { env: { ...env, ONIONSKIN_BASE_URL: url }, timeout: remaining, totalTimeout: timeout, graceMs, onOutput, onTimeout });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
