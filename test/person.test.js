// A person at a terminal vs a coding agent (src/person.js): who gets which output, the `onionskin <file>` shortcut and the plain
// words a person sees. The background agent itself is started by the server (test/agent-runner.test.js), never here.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENT_ENV, expandShortcut, isAgentRun, personOpenText, personPollText, pickAudience } from "../src/person.js";
import { FLAGS } from "../src/cli.js";

const TTY = { stdinTTY: true, stdoutTTY: true };
const FILE = "/Users/patq/My report.docx";

test("isAgentRun: an agent's variable or a non-terminal stdin/stdout means agent or script; only a plain terminal is a person", () => {
  assert.equal(isAgentRun({ env: {}, ...TTY }), false);
  for (const k of AGENT_ENV) assert.equal(isAgentRun({ env: { [k]: "1" }, ...TTY }), true, k);
  assert.equal(isAgentRun({ env: {}, stdinTTY: true, stdoutTTY: false }), true, "stdout piped");
  assert.equal(isAgentRun({ env: {}, stdinTTY: false, stdoutTTY: true }), true, "stdin not a terminal");
  // exact names only: settings people export in their shell profile do not make them an agent
  assert.equal(isAgentRun({ env: { CODEX_HOME: "/h", CLAUDE_CODE_USE_BEDROCK: "1", CLAUDECODE: "" }, ...TTY }), false);
});

test("pickAudience: --agent forces today's output, --no-agent the person path without the offer; only open and poll take them", () => {
  assert.deepEqual(pickAudience(["open", "f.docx"], { env: {}, ...TTY }), { argv: ["open", "f.docx"], person: true, offer: true });
  assert.deepEqual(pickAudience(["open", "f.docx"], { env: { CLAUDECODE: "1" }, ...TTY }), { argv: ["open", "f.docx"], person: false, offer: false });
  assert.deepEqual(pickAudience(["open", "f.docx"], { env: {} }), { argv: ["open", "f.docx"], person: false, offer: false }, "no terminal");
  assert.deepEqual(pickAudience(["open", "--agent", "f.docx"], { env: {}, ...TTY }), { argv: ["open", "f.docx"], person: false, offer: false });
  assert.deepEqual(pickAudience(["poll", "f.docx", "--no-agent"], { env: { CLAUDECODE: "1" } }), { argv: ["poll", "f.docx"], person: true, offer: false });
  assert.throws(() => pickAudience(["open", "--agent", "--no-agent", "f.docx"], {}), /cannot be combined/);
  assert.deepEqual(pickAudience(["status", "f.docx", "--agent"], { env: {}, ...TTY }), { argv: ["status", "f.docx", "--agent"], person: false, offer: false }, "other commands keep the flag, and reject it");
});

test("expandShortcut: `onionskin <file>` is `onionskin open <file>` for Word, Excel and PowerPoint files only", () => {
  assert.deepEqual(expandShortcut(["report.docx"], FLAGS), ["open", "report.docx"]);
  assert.deepEqual(expandShortcut(["/a/B.XLSX", "--no-open"], FLAGS), ["open", "/a/B.XLSX", "--no-open"]);
  assert.deepEqual(expandShortcut(["deck.pptx", "--no-agent"], FLAGS), ["open", "deck.pptx", "--no-agent"]);
  for (const argv of [["open", "r.docx"], ["poll", "r.docx"], ["notes.txt"], ["macro.docm"], ["--help"], [], ["stop"]]) assert.deepEqual(expandShortcut(argv, FLAGS), argv);
});

const NO_JARGON = /poll|lease|ticket|batch|json|[{}]/i;

test("the person's words: the page is open, the background agent starts (one plain line), or how to get Claude Code; no agent words", () => {
  const base = { name: "My report.docx", url: "http://127.0.0.1:5/?s=ab&n=cd", realPath: FILE };
  const starts = personOpenText({ ...base, found: true, offer: true });
  assert.match(starts, /^Opened My report\.docx in your browser\.\n  http:\/\/127\.0\.0\.1:5\//);
  assert.match(starts, /works together with a coding agent/);
  assert.ok(starts.endsWith("Claude Code is starting in the background to work on this file with you. Press Send in the page when you are ready.\n"));
  assert.doesNotMatch(starts, /\[Y\/n\]/, "no question any more: the agent just starts");
  const none = personOpenText({ ...base, found: false, offer: true });
  assert.match(none, /Claude Code was not found on this Mac/);
  assert.match(none, /https:\/\/claude\.com\/product\/claude-code/);
  assert.match(none, /press Try again in the page/);
  const codexOnly = personOpenText({ ...base, found: false, codex: true, offer: true });
  assert.match(codexOnly, /Codex is on this Mac\. To work on this file, say to Codex:\n  open My report\.docx in Onionskin\n/);
  assert.doesNotMatch(codexOnly, /not found/);
  const only = personOpenText({ ...base, browser: false, found: true, offer: false });
  assert.match(only, /Open this link in your browser/);
  assert.ok(only.includes(`  onionskin '${FILE}'\n`) && !/starting in the background/.test(only), "--no-agent: the page only");
  const poll = personPollText(FILE);
  assert.equal(poll.trimEnd().split("\n").length, 2);
  assert.match(poll, /the command the coding agent runs/);
  assert.ok(poll.includes(`onionskin '${FILE}'`));
  for (const t of [starts, none, only]) assert.doesNotMatch(t.replace(/http:\S+/, ""), NO_JARGON, t);
  assert.doesNotMatch(poll.replace(/^onionskin poll is the command/, ""), NO_JARGON);
  for (const t of [starts, none, only, poll]) assert.doesNotMatch(t, /[\u2013\u2014]/, "no en or em dashes");
});
