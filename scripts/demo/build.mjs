#!/usr/bin/env node
// Builds the Try-it page (web/demo) into a local folder. Nothing is published.
//   node scripts/demo/build.mjs [--recording <folder>] [--out <folder>] [--test]
// Defaults: the recording in web/demo/recording, the page in dist-demo/ (gitignored). The recording must pass the scan (scan.mjs) with
// no exceptions. A recording made with the stand-in agent (`real: false`) is refused unless --test, and a --test build may never go to
// dist-demo/, so a test page cannot be mistaken for the one to show. The bytes bundled into the page are the bytes scanned.
// View the result with `node scripts/demo/serve.mjs [<folder>]`.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FILES, scanFolder, scanRecording } from "./scan.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
export const DEFAULT_RECORDING = path.join(repo, "web", "demo", "recording");
export const DEFAULT_OUT = path.join(repo, "dist-demo");
const MARK = ".onionskin-demo-build"; // left in every output folder, so a rebuild only ever empties a folder this script made
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");

export class BuildError extends Error {
  constructor(problems) {
    super(problems.join("\n"));
    this.problems = problems;
  }
}
const refuse = (...problems) => {
  throw new BuildError(problems);
};

/**
 * Reads and scans the recording; returns {recording, v0, v1}, the exact bytes and data the page will carry. Throws BuildError.
 * `identity` (names that must not appear) is injectable for tests, as in scan.mjs.
 */
export function loadRecording(dir, { test = false, identity } = {}) {
  const opts = identity ? { test, identity } : { test };
  const first = scanFolder(dir, opts);
  if (first.problems.length) refuse(...first.problems);
  // read once more, then scan exactly what will be bundled: a file changed after the first scan is caught here
  const [json, v0, v1] = FILES.map((f) => fs.readFileSync(path.join(dir, f)));
  let recording;
  try {
    recording = JSON.parse(json.toString("utf8"));
  } catch {
    refuse("recording.json is not valid JSON");
  }
  const problems = scanRecording({ recording, v0, v1 }, opts);
  if (problems.length) refuse(...problems);
  if (recording.real !== true && !test) refuse("this recording was made with the stand-in agent (real: false); it can never be built for showing");
  if (sha256(v0) !== recording.v0_sha256 || sha256(v1) !== recording.v1_sha256) refuse("a version does not match its hash");
  return { recording, v0, v1 };
}

/** The output folder may be missing, empty, or a folder this script built before. Anything else is refused, never emptied. */
function checkOut(out) {
  if (!fs.existsSync(out)) return;
  if (!fs.statSync(out).isDirectory()) refuse(`${out} is not a folder`);
  const there = fs.readdirSync(out);
  if (there.length && !there.includes(MARK)) refuse(`${out} holds other files; pick an empty folder`);
}

/** After the build: one page, its CSP first in <head>, no inline script, no Office file, no source map. Returns the problems. */
export function checkBuilt(out, csp) {
  const problems = [];
  const html = fs.readFileSync(path.join(out, "index.html"), "utf8");
  const head = html.slice(0, html.indexOf("</head>"));
  const meta = head.indexOf('http-equiv="Content-Security-Policy"');
  if (meta < 0 || !head.includes(`content="${csp.replace(/"/g, "&quot;")}"`)) problems.push("the page has no CSP meta tag");
  else if (/<(script|link|style)\b/i.test(head.slice(0, meta))) problems.push("something loads before the CSP meta tag");
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) if (!/\bsrc=/.test(m[1]) || m[2].trim()) problems.push("the page has an inline script");
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(out)) if (/\.(docx|xlsx|pptx|map)$/i.test(f)) problems.push(`the build holds a file it should not: ${path.relative(out, f)}`);
  return problems;
}

/** Scans, then builds. Returns the output folder. Throws BuildError when anything is refused (nothing is built then). */
export async function buildDemo({ recordingDir = DEFAULT_RECORDING, out = DEFAULT_OUT, test = false } = {}) {
  recordingDir = path.resolve(recordingDir);
  out = path.resolve(out);
  if (test && out === DEFAULT_OUT) refuse("--test builds may not go to dist-demo; pass --out with another folder");
  const rec = loadRecording(recordingDir, { test });
  checkOut(out);
  const { build } = await import("vite");
  const { demoConfig, DEMO_CSP } = await import("../../web/vite.demo.config.js");
  await build(demoConfig({ ...rec, outDir: out }));
  fs.writeFileSync(path.join(out, MARK), "built by scripts/demo/build.mjs\n");
  const problems = checkBuilt(out, DEMO_CSP);
  if (problems.length) {
    fs.rmSync(path.join(out, "index.html"), { force: true }); // a page that failed its checks is not left to be opened
    refuse(...problems);
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (k) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : undefined;
  };
  try {
    const out = await buildDemo({ recordingDir: opt("--recording") || DEFAULT_RECORDING, out: opt("--out") || DEFAULT_OUT, test: args.includes("--test") });
    console.log(`The Try-it page was built in ${out}${args.includes("--test") ? " (test recording: never show it to anyone)" : ""}.`);
    console.log(`View it with: node scripts/demo/serve.mjs ${out}`);
  } catch (err) {
    if (!(err instanceof BuildError)) throw err;
    console.error(`The page was not built. ${err.problems.length} problem(s):`);
    for (const p of err.problems) console.error(`  - ${p}`);
    process.exit(1);
  }
}
