#!/usr/bin/env node
// npm test: verify the vendored engine, build the web app, run unit then E2E suites, and fail if any tracked file changed.
//   node scripts/run-tests.mjs [unit|e2e|all|demo]   (default all)
// `demo` is opt-in and not part of `all`: the Try-it page's browser test (e2e/demo/), which builds its own page from a test recording.
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const which = process.argv[2] || "all";
const git = (...a) => execFileSync("/usr/bin/git", ["-C", root, ...a], { encoding: "utf8" });
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: root, stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`FAILED: ${cmd} ${args.join(" ")}`);
    process.exit(r.status || 1);
  }
};

const before = git("status", "--short");
run(process.execPath, ["scripts/vendor-engine.mjs", "--verify"]);
run("npm", ["run", "build:web", "--silent"]);
if (which === "unit" || which === "all") run("npm", ["run", "test:unit", "--silent"]);
if (which === "e2e" || which === "all") run("npm", ["run", "test:e2e", "--silent"]);
if (which === "demo") run(process.execPath, ["--test", "--test-force-exit", "--test-timeout=300000", "e2e/demo/demo.e2e.test.js"]);
const after = git("status", "--short");
if (before !== after) {
  console.error("Tests modified tracked or untracked repo files:\n--- before\n" + before + "--- after\n" + after);
  process.exit(1);
}
console.log("tests left the working tree untouched");
