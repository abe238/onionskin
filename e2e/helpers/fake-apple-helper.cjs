// A stand-in for the shipped Apple helper (scripts/rewriter/apple/onionskin-fm), for the browser tests: no model runs.
// harness.mjs fakeAppleHelper() copies this file next to a "mode" file as onionskin-fm, with a node shebang and the hash the server checks.
//   mode ok: the probe says available and a sentence comes back as it was. Any other mode (deviceNotEligible, appleIntelligenceNotEnabled,
//   modelNotReady) is the probe's reason for Apple's model not being available. Mode fix: as ok, but "recieve" comes back as "receive".
//   Every request's sentence is appended to asked.jsonl beside it (the tests count model calls there), and a "delay" file holds the
//   milliseconds to wait before each answer.
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const mode = fs.readFileSync(path.join(path.dirname(process.argv[1]), "mode"), "utf8").trim();
if (process.argv[2] === "--probe") {
  console.log(mode === "ok" ? "available" : `unavailable: ${mode}`);
  process.exit(mode === "ok" ? 0 : 1);
}
const here = path.dirname(process.argv[1]);
const on = mode === "ok" || mode === "fix";
process.stdout.write(JSON.stringify(on ? { ready: true } : { ready: false, code: mode }) + "\n");
if (!on) process.exit(1);
const delay = fs.existsSync(path.join(here, "delay")) ? Number(fs.readFileSync(path.join(here, "delay"), "utf8")) : 0;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, text } = JSON.parse(line);
  fs.appendFileSync(path.join(here, "asked.jsonl"), JSON.stringify(text) + "\n");
  const out = mode === "fix" ? text.replace(/recieve/g, "receive") : text;
  setTimeout(() => process.stdout.write(JSON.stringify({ id, ok: true, text: out }) + "\n"), delay);
});
