// A person at a terminal vs a coding agent. Agents (and scripts) get the CLI's agent output unchanged; a person who types
// `onionskin <file>` or `onionskin open <file>` gets plain words, and the server starts its background agent on the file (src/agent-runner.js).
import { PRODUCT } from "./constants.js";

const BIN = PRODUCT.bin;
// the formats Onionskin opens, and the web files it refuses with a sentence (src/constants.js REFUSED_PAGES): `onionskin page.mhtml` says why
const DOC_EXT = /\.(docx|xlsx|pptx|html|htm|mhtml|mht|webarchive|xhtml|svg)$/i;
export const GET_CLAUDE_CODE = "https://claude.com/product/claude-code";

/**
 * Environment variables an agent sets for the commands it runs. Exact names only: people export CODEX_HOME, API keys and
 * CLAUDE_CODE_* settings in their shell profile, so a prefix match would treat them as agents.
 * Claude Code: CLAUDECODE=1. Codex 0.167: CODEX_THREAD_ID, CODEX_TOOL_CALL_ID, CODEX_CI, CODEX_SANDBOX (seen in a real `codex exec` command).
 */
export const AGENT_ENV = ["CLAUDECODE", "CODEX_THREAD_ID", "CODEX_TOOL_CALL_ID", "CODEX_CI", "CODEX_SANDBOX"];

export const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** A path as one POSIX shell word: bare when it holds only safe characters, else in single quotes. */
export const shellWord = (s) => (/^[A-Za-z0-9_\/.\-+@%,:=]+$/.test(String(s)) ? String(s) : shellQuote(s));

/** What a person pastes in a terminal, from any folder, to reopen a file: the command with the file's absolute path. */
export const reopenCommand = (file) => `${BIN} ${shellWord(file)}`;

/** True when an agent or a script runs this command: an agent's environment variable, or stdin or stdout that is not a terminal. */
export function isAgentRun({ env = {}, stdinTTY = false, stdoutTTY = false } = {}) {
  if (AGENT_ENV.some((k) => env[k])) return true;
  return !(stdinTTY && stdoutTTY);
}

/**
 * Strips --agent / --no-agent from `open` and `poll` and says who the output is for.
 * Returns { argv, person, offer }: person = plain words; offer = the background agent starts on the file (never with --no-agent).
 */
export function pickAudience(argv, ctx) {
  if (!["open", "poll"].includes(argv[0])) return { argv, person: false, offer: false };
  const agent = argv.includes("--agent");
  const noAgent = argv.includes("--no-agent");
  if (agent && noAgent) throw new Error("--agent and --no-agent cannot be combined");
  const rest = argv.filter((x) => x !== "--agent" && x !== "--no-agent");
  if (agent) return { argv: rest, person: false, offer: false };
  if (noAgent) return { argv: rest, person: true, offer: false };
  const person = !isAgentRun(ctx);
  return { argv: rest, person, offer: person };
}

/** `onionskin report.docx` is `onionskin open report.docx`: a first argument that names a Word, Excel or PowerPoint file. */
export function expandShortcut(argv, commands) {
  const first = argv[0];
  if (!first || first.startsWith("-") || first in commands || !DOC_EXT.test(first)) return argv;
  return ["open", ...argv];
}

const later = (realPath) =>
  `When you want an agent on it, run this in a terminal:\n  ${BIN} ${shellQuote(realPath)}\nor, inside Claude Code, type:\n  /onionskin ${shellQuote(realPath)}\n(in Codex, ask it to use the onionskin skill on that file).\n`;

/**
 * What a person sees after `open`. `offer`: the background agent starts on the file (`found`: Claude Code is installed); one plain line says so.
 * Without `offer` (--no-agent) only the page opens, and the text says how to get an agent later.
 */
export function personOpenText({ name, url, realPath, browser = true, found = false, codex = false, offer = false }) {
  let t = browser ? `Opened ${name} in your browser.\n  ${url}\n\n` : `Opened ${name}. Open this link in your browser:\n  ${url}\n\n`;
  t += `Onionskin works together with a coding agent: you mark up the file in the page and press Send, and the agent makes the changes and answers your comments.\n\n`;
  if (!offer) return t + later(realPath);
  if (!found && codex) return t + `Codex is on this Mac. To work on this file, say to Codex:\n  open ${name} in Onionskin\nTo start an agent from this command instead, get Claude Code: ${GET_CLAUDE_CODE}\n`;
  if (!found) return t + `Claude Code was not found on this Mac, so no agent can start yet. Get Claude Code: ${GET_CLAUDE_CODE}\nSign in to it once, then press Try again in the page.\n`;
  return t + `Claude Code is starting in the background to work on this file with you. Press Send in the page when you are ready.\n`;
}

/** What a person sees from `poll`: two plain lines and no batch. */
export function personPollText(realPath) {
  return `${BIN} poll is the command the coding agent runs to wait for your Send; you do not need to type it.\nTo start, run: ${BIN} ${shellQuote(realPath)}   (it opens the file and starts Claude Code on it in the background)\n`;
}
