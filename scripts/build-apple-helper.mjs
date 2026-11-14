#!/usr/bin/env node
// Builds the ready-made helper for Apple's built-in model: scripts/rewriter/apple/main.swift, compiled for Apple silicon and macOS 26 or later
// (arm64 only: the model runs on Apple silicon alone), plus onionskin-fm.json beside it with its size and SHA-256. The packager ships both
// in the zip (scripts/package.mjs) and setup checks the helper against that hash (src/rewriter-setup.js); the person's Mac never compiles it.
//   node scripts/build-apple-helper.mjs [--out <dir>]   (default: scripts/rewriter/apple, where a source checkout looks for it)
// Fails (exit 1, nothing left behind) when the macOS developer tools are missing or the build fails. It never starts /usr/bin/swiftc without
// them: on such a Mac that command opens Apple's installer window.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const HELPER_SOURCE = path.join(root, "scripts", "rewriter", "apple", "main.swift");
export const HELPER_NAME = "onionskin-fm";
export const HELPER_TARGET = "arm64-apple-macos26.0";
export const HELPER_FLAGS = ["-O", "-parse-as-library", "-target", HELPER_TARGET];

/**
 * Builds into `outDir`: <outDir>/onionskin-fm and <outDir>/onionskin-fm.json {file, target, size, sha256}. Returns that record.
 * Throws an Error with a plain message when it cannot. `run` (tests) replaces spawnSync.
 */
export function buildAppleHelper({ outDir = path.dirname(HELPER_SOURCE), run = spawnSync } = {}) {
  if (run("/usr/bin/xcode-select", ["-p"], { encoding: "utf8", timeout: 10_000 }).status !== 0) throw new Error("the macOS developer tools are not installed (xcode-select -p failed), so swiftc is missing");
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, HELPER_NAME);
  const tmp = `${out}.building`;
  fs.rmSync(tmp, { force: true });
  const r = run("/usr/bin/swiftc", [...HELPER_FLAGS, HELPER_SOURCE, "-o", tmp], { encoding: "utf8", timeout: 10 * 60_000 });
  if (r.status !== 0 || !fs.existsSync(tmp)) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`swiftc failed (${r.error?.message || `exit ${r.status}`}) ${String(r.stderr || "").trim()}`.trim());
  }
  fs.renameSync(tmp, out);
  fs.chmodSync(out, 0o755);
  const bytes = fs.readFileSync(out);
  const record = { file: HELPER_NAME, target: HELPER_TARGET, size: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
  fs.writeFileSync(path.join(outDir, `${HELPER_NAME}.json`), JSON.stringify(record, null, 2) + "\n");
  return record;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--out");
  try {
    const r = buildAppleHelper(i > 0 ? { outDir: path.resolve(process.argv[i + 1]) } : {});
    console.log(`built ${HELPER_NAME} for ${r.target}: ${r.size} bytes, sha256 ${r.sha256}`);
  } catch (err) {
    console.error(`build-apple-helper: FAILED\n${err.message}`);
    process.exit(1);
  }
}
