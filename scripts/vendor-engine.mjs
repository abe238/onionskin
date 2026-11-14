#!/usr/bin/env node
// Builds the engine (bun, build-time only) and copies dist/ into vendor/engine/ with a lock file.
//   node scripts/vendor-engine.mjs            build + copy + write vendor/engine.lock.json
//   node scripts/vendor-engine.mjs --verify   recompute sha256 of vendor/engine and fail on mismatch
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vendorDir = path.join(root, "vendor", "engine");
const lockPath = path.join(root, "vendor", "engine.lock.json");
const engineRepo = process.env.ONIONSKIN_ENGINE_REPO || path.resolve(root, "..", "onionskin-engine");
const bun = process.env.BUN || path.join(os.homedir(), ".bun", "bin", "bun");

function walk(dir, base = dir, out = []) {
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const st = fs.lstatSync(full);
    if (st.isDirectory()) walk(full, base, out);
    else if (st.isFile()) out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out;
}

const sha = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function hashes() {
  const files = {};
  for (const rel of walk(vendorDir)) files[rel] = sha(path.join(vendorDir, rel));
  return files;
}

function verify() {
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  const now = hashes();
  const problems = [];
  for (const [rel, h] of Object.entries(lock.files)) {
    if (!(rel in now)) problems.push(`missing ${rel}`);
    else if (now[rel] !== h) problems.push(`changed ${rel}`);
  }
  for (const rel of Object.keys(now)) if (!(rel in lock.files)) problems.push(`extra ${rel}`);
  if (problems.length) {
    console.error(`vendor/engine does not match vendor/engine.lock.json:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`vendor/engine OK (${Object.keys(now).length} files, engine ${lock.engineCommit.slice(0, 10)})`);
  // the Node build used by `apply` is locked in the same file ("node" section) and must be at the same engine commit
  execFileSync(process.execPath, [path.join(root, "scripts", "build-engine-node.mjs"), "--verify"], { stdio: "inherit" });
}

if (process.argv.includes("--verify")) {
  verify();
} else {
  const git = (...a) => execFileSync("/usr/bin/git", ["-C", engineRepo, ...a], { encoding: "utf8" }).trim();
  const dirty = git("status", "--porcelain");
  if (dirty) console.warn("warning: engine working tree is dirty; the lock records HEAD only");
  execFileSync(bun, ["run", "build"], { cwd: engineRepo, stdio: "inherit" });
  fs.rmSync(vendorDir, { recursive: true, force: true });
  fs.mkdirSync(vendorDir, { recursive: true });
  // .map files and .d.ts are not shipped: they are large and not needed at runtime.
  for (const rel of walk(path.join(engineRepo, "dist"))) {
    if (rel.endsWith(".map") || rel.startsWith("types/")) continue;
    const to = path.join(vendorDir, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(engineRepo, "dist", rel), to);
  }
  fs.writeFileSync(lockPath, JSON.stringify({ engineCommit: git("rev-parse", "HEAD"), files: hashes() }, null, 2) + "\n");
  console.log(`vendored ${Object.keys(hashes()).length} files`);
  // rebuild the Node entry at the new commit (writes the "node" section of the lock again)
  execFileSync(process.execPath, [path.join(root, "scripts", "build-engine-node.mjs")], { stdio: "inherit" });
}
