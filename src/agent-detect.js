// Finds the coding agent the server starts in the background, checks it is signed in, and builds its exact command line and environment.
// Claude Code only in this build (no Codex runner). Nothing here starts the agent: src/agent-runner.js does, with what this returns.
//
// The command line is the least-privilege form proven with Claude Code 2.1.323 (docs/contracts/routes.md, "Background agent"):
// only Bash, Read and Write; the Bash allow-list names `onionskin poll|reply|status` (Claude Code also lets read-only commands run inside
// the granted folders); Write only inside the agent's own work folder; Read only in the skill's reference folder and its own work folder
// (a probe with canary files: reads outside them, the home folder, network fetches and writes elsewhere were all refused); no settings
// files, MCP servers, skills or slash commands of the person's own setup.
import { execFile as nodeExecFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sessionKey } from "./paths.js";

/** Every holder id the server's own background agents poll with starts with this; the rest of the id is the session key. */
export const BG_PREFIX = "onionskin-bg-";
export const bgHolder = (key) => `${BG_PREFIX}${key}`;
export const isBgHolder = (h) => typeof h === "string" && h.startsWith(BG_PREFIX);
/** The holder of "Open in Terminal": the same conversation under the same limits, so the same guards (bound to its file, reply by file only). */
export const TERM_PREFIX = "onionskin-term-";
export const termHolder = (key) => `${TERM_PREFIX}${key}`;
/** A holder Onionskin itself gives to an agent it starts: the background one or its Terminal form. */
export const isAgentHolder = (h) => isBgHolder(h) || (typeof h === "string" && h.startsWith(TERM_PREFIX));

/** What every command refuses with when an agent Onionskin started names another file: the same words whether that file is open or not. */
export const NOT_YOUR_FILE = "This agent works only on the file it was started for. Nothing was read or written.";

/**
 * May `holder` act on `file`? Any holder but an agent Onionskin started may (its lease is checked where it acts). An agent's holder carries
 * the session key of its one file (onionskin-bg-<key>, onionskin-term-<key>): the file must resolve to that key. Decided from the path
 * alone, before any session is looked up or the file is read, so the answer for another file never depends on that file being open.
 * One check for the CLI (src/cli.js, src/reply.js, src/apply.js) and the server's /cli/* routes (src/local.js sessionFor).
 */
export function agentMayUse(holder, file) {
  if (!isAgentHolder(holder)) return true;
  const key = holder.slice(isBgHolder(holder) ? BG_PREFIX.length : TERM_PREFIX.length);
  let real;
  try {
    real = fs.realpathSync(path.resolve(String(file || "")));
  } catch {
    return false;
  }
  return key !== "" && sessionKey(real) === key;
}

/** `--restricted` and the `//` rule forms need at least this Claude Code. An older one counts as not installed ("Update Claude Code"). */
export const MIN_CLAUDE = "2.1.323";
export const DEFAULT_MODEL = "sonnet";
export const POLL_TIMEOUT = 590; // seconds: under the 600000 ms Bash ceiling

const FALLBACK_DIRS = (home) => [path.join(home || os.homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];

function canRun(f) {
  try {
    fs.accessSync(f, fs.constants.X_OK);
    return fs.statSync(f).isFile();
  } catch {
    return false;
  }
}

/**
 * True when no background agent may start: ONIONSKIN_AGENT_CLI=none, or a test process (node --test sets NODE_TEST_CONTEXT, and the
 * servers a test starts inherit it) that did not opt in with ONIONSKIN_AGENT_PATH. Fail closed: no test ever spends a real agent's plan.
 */
export function agentsDisabled(env = process.env) {
  if (env.ONIONSKIN_AGENT_CLI === "none") return true;
  return !!env.NODE_TEST_CONTEXT && !env.ONIONSKIN_AGENT_PATH;
}

/**
 * The absolute path of `claude`, or null. ONIONSKIN_AGENT_PATH (dirs, searched first) is the test seam; ONIONSKIN_AGENT_CLI forces one CLI
 * (only "claude" exists in this build: any other value finds nothing).
 */
const findCli = (name, env, run) => {
  const dirs = [...String(env.ONIONSKIN_AGENT_PATH || "").split(path.delimiter), ...String(env.PATH || "").split(path.delimiter), ...FALLBACK_DIRS(env.HOME)];
  for (const d of dirs) {
    if (!d || !path.isAbsolute(d)) continue;
    const f = path.join(d, name);
    if (run(f)) return f;
  }
  return null;
};

export function findClaude(env = process.env, run = canRun) {
  if (env.ONIONSKIN_AGENT_CLI && env.ONIONSKIN_AGENT_CLI !== "claude") return null;
  return findCli("claude", env, run);
}

/**
 * Codex, when it is on this Mac. This build starts no Codex agent itself: it is found only so a person without Claude Code is told to
 * ask Codex for the file, in place of "no coding agent found".
 */
export function findCodex(env = process.env, run = canRun) {
  return findCli("codex", env, run);
}

const newer = (a, b) => {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return true;
};

function run(execFile, bin, args, env) {
  return new Promise((resolve) => {
    execFile(bin, args, { env, timeout: 5000, maxBuffer: 256 * 1024 }, (err, stdout) => resolve({ code: err ? (typeof err.code === "number" ? err.code : -1) : 0, stdout: String(stdout || "") }));
  });
}

/**
 * Before a start: is this Claude Code new enough, and signed in? 5 s per command, `execFile` injectable.
 * Returns null when it may start, else {code: "not_installed"|"signed_out", update?: true}.
 */
export async function preflight(bin, { env, execFile = nodeExecFile } = {}) {
  const v = await run(execFile, bin, ["--version"], env);
  const m = /(\d+\.\d+\.\d+)/.exec(v.stdout);
  if (v.code !== 0 || !m) return { code: "not_installed" };
  if (!newer(m[1], MIN_CLAUDE)) return { code: "not_installed", update: true };
  const a = await run(execFile, bin, ["auth", "status", "--json"], env);
  let j = null;
  try {
    j = JSON.parse(a.stdout);
  } catch {}
  if (j && j.loggedIn === true && a.code === 0) return null;
  return { code: "signed_out" };
}

/**
 * The environment of the agent: built from nothing, never the server's (which may come from an agent session, or hold API keys).
 * No ANTHROPIC_API_KEY or other key, so the agent always uses the person's subscription, never a paid API account.
 */
export function cleanEnv({ binDir, stateDir, holder, workDir, env = process.env }) {
  const out = {
    HOME: env.HOME || os.homedir(),
    USER: env.USER || os.userInfo().username,
    LANG: "en_US.UTF-8",
    TMPDIR: env.TMPDIR || os.tmpdir(),
    PATH: [binDir, path.dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
    ONIONSKIN_STATE_DIR: stateDir,
    ONIONSKIN_HOLDER: holder,
    ONIONSKIN_AGENT_DIR: workDir,
    BASH_DEFAULT_TIMEOUT_MS: "600000",
  };
  if (env.ONIONSKIN_TRACE) out.ONIONSKIN_TRACE = env.ONIONSKIN_TRACE; // the loop benchmarks' timing file, only when the server has it
  return out;
}

/**
 * The exact command line (section 2.2 of the build spec, with the rule forms the real probe proved): returns the argv after the binary.
 * `resume` continues the crashed conversation (`--resume <id>`) instead of starting one (`--session-id <id>`). `print: false` is the
 * Terminal form (Open in Terminal): the same limits, without -p and the stream flags; its `prompt` (when given) is the first message of the
 * interactive session, so it starts polling at once instead of waiting at its prompt.
 *
 * The prompt is a positional argument and stays FIRST in both forms (`-p` takes no value, so it is a positional there too): `--add-dir`,
 * `--tools` and `--allowedTools` take several values, and a prompt placed after one of them would be read as one more of its values.
 */
export function buildArgv({ prompt, skill, model = DEFAULT_MODEL, sessionId, resume = false, workDir, refDir, print = true }) {
  return [
    ...(print ? ["-p", prompt] : prompt ? [prompt] : []),
    "--append-system-prompt", skill,
    "--model", model,
    resume ? "--resume" : "--session-id", sessionId,
    ...(print ? ["--output-format", "stream-json", "--verbose", "--max-turns", "200"] : []),
    "--restricted",
    "--tools", "Bash,Read,Write",
    "--allowedTools", "Bash(onionskin poll:*)", "Bash(onionskin reply:*)", "Bash(onionskin status:*)", `Read(/${refDir}/**)`, `Read(/${workDir}/outline/**)`, `Edit(/${workDir}/**)`,
    "--add-dir", refDir,
    "--add-dir", `${workDir}/outline`, // the outline files. Its own work folder is its working directory, so it can also read what is there (its transcript and reply files); a live probe showed everything outside these folders is refused
    "--permission-mode", "dontAsk",
    ...(print ? ["--permission-prompts", "none"] : []),
    "--setting-sources", "",
    "--strict-mcp-config",
    "--disable-slash-commands",
  ];
}
