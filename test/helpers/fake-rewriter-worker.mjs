// A stand-in for the rewriter's worker process (src/rewriter.js): the same JSON-lines protocol, no model.
//   node fake-rewriter-worker.mjs <mode> [ms]
//   modes: ok (upper-cases the sentence) | startup <ms> (ready after ms) | slow <ms> (answers after ms) | never (never answers)
//          huge (answer over the size limit) | garbage (a non-JSON line, then the answer) | refuse | crash (exits on the first request)
//          notready [code] (says ready:false, with that code or model_missing, and exits) | flood (writes a line that never ends)
//          notreadyonce <file> (the first start, while <file> is missing, says ready:false with apple_intelligence_not_enabled; later starts are ready)
//          refuse answers {ok:false, code:"refused", reason}
import fs from "node:fs";
import readline from "node:readline";

const [mode = "ok", arg] = process.argv.slice(2);
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const start = () => {
  if (mode === "notreadyonce" && !fs.existsSync(arg)) {
    fs.writeFileSync(arg, "started once");
    out({ ready: false, code: "apple_intelligence_not_enabled" });
    process.exit(1);
  }
  if (mode === "notready") {
    out({ ready: false, code: arg || "model_missing" });
    process.exit(1);
  }
  if (mode === "flood") return process.stdout.write("x".repeat(600 * 1024));
  out({ ready: true });
};
if (mode === "startup") setTimeout(start, Number(arg)); else start();
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, text } = JSON.parse(line);
  const answer = () => {
    if (mode === "refuse") return out({ id, ok: false, code: "refused", reason: "May contain unsafe content" });
    if (mode === "huge") return out({ id, ok: true, text: "y".repeat(3000) });
    if (mode === "garbage") process.stdout.write("not json\n");
    out({ id, ok: true, text: text.toUpperCase() });
  };
  if (mode === "crash") process.exit(3);
  if (mode === "never") return;
  if (mode === "slow") return void setTimeout(answer, Number(arg));
  answer();
});
