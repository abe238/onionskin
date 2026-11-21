#!/usr/bin/env node
// Runs before `npm pack` and `npm publish` (package.json "prepack"). The npm tarball must ship the built web app and the ready-made
// helper for Apple's model, neither of which is in git, so build both here and fail (exit 1, nothing packed) if either is missing.
// ONIONSKIN_PREPACK_SKIP_BUILD=1 reuses what is already built (tests, repeated packs).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildAppleHelper } from "./build-apple-helper.mjs";
import { collectNpmFiles, scanPackagedFiles, verifyVendor } from "./package.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const die = (m) => {
  console.error(`prepack: FAILED\n${m}`);
  process.exit(1);
};
if (process.platform !== "darwin") die("the helper for Apple's model can only be built on a Mac");
if (!process.env.ONIONSKIN_PREPACK_SKIP_BUILD) {
  console.log("prepack: building the web app");
  const r = spawnSync("npm", ["run", "build:web"], { cwd: root, stdio: "inherit" });
  if (r.status !== 0) die("npm run build:web failed (run `npm install` first)");
  try {
    const h = buildAppleHelper();
    console.log(`prepack: built the Apple helper (${h.target}, ${h.size} bytes)`);
  } catch (e) {
    die(`the helper for Apple's model did not build: ${e.message}`);
  }
}
try {
  verifyVendor(root);
} catch (e) {
  die(e.message);
}
for (const f of [
  "web/dist/index.html",
  "scripts/rewriter/apple/onionskin-fm",
  "scripts/rewriter/apple/onionskin-fm.json",
  "vendor/engine/index.js",
  "vendor/engine-node/engine-node.mjs",
  "vendor/parse5/parse5.mjs",
  "skills/onionskin/SKILL.md",
]) {
  if (!fs.existsSync(path.join(root, f))) die(`missing: ${f}`);
}
const problems = scanPackagedFiles(collectNpmFiles(root), { helperRel: "scripts/rewriter/apple/onionskin-fm" });
if (problems.length) die(problems.map((p) => `  - ${p}`).join("\n"));
