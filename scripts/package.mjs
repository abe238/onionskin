#!/usr/bin/env node
// Builds dist-zip/onionskin-<version>-<shortsha>.zip: the run-time files only, one top folder `onionskin/`.
// Takes whatever is in the tree when it runs. Usage: node scripts/package.mjs [--skip-build]
// Fails (exit 1, no zip left behind) when the zip would hold a home-directory path, a secret pattern, an internal file name,
// a file over 5 MB, or more than 45 MB in total, and when the helper for Apple's model cannot be built (no swiftc, or the build fails).
// Uses /usr/bin/zip and swiftc (scripts/build-apple-helper.mjs); no dependencies.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildAppleHelper } from "./build-apple-helper.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(root, "dist-zip");
const STAGE = path.join(OUT, "stage");
const TOP = "onionskin";
const MAX_FILE = 5 * 1024 * 1024;
const MAX_TOTAL = 45 * 1024 * 1024;
const skipBuild = process.argv.includes("--skip-build");
const forPublic = process.argv.includes("--public"); // a zip for other people: the maintainer's own voice guide stays out

const die = (msg) => {
  console.error(`package: FAILED\n${msg}`);
  process.exit(1);
};
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { cwd: root, encoding: "utf8", ...opts });
const git = (...a) => run("/usr/bin/git", a).stdout.trim();

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const sha = git("rev-parse", "--short", "HEAD") || "nogit";
const dirty = git("status", "--porcelain") !== "";
const zipName = `onionskin-${pkg.version}-${sha}${dirty ? "-dirty" : ""}${forPublic ? "-public" : ""}.zip`;
const zipPath = path.join(OUT, zipName);

// ---- 1. build the web app --------------------------------------------------------------------------------------
if (!skipBuild) {
  console.log("package: building the web app (npm run build:web)");
  const r = run("npm", ["run", "build:web"], { stdio: "inherit" });
  if (r.status !== 0) die("npm run build:web failed (run `npm install` first, or link node_modules)");
}
if (!fs.existsSync(path.join(root, "web", "dist", "index.html"))) die("web/dist/index.html is missing: build the web app first");

// ---- 2. stage ----------------------------------------------------------------------------------------------------
fs.mkdirSync(OUT, { recursive: true });
fs.rmSync(STAGE, { recursive: true, force: true });
for (const n of fs.readdirSync(OUT)) if (/^onionskin-.*\.zip(\.sha256)?$/.test(n) || n === "MANIFEST.txt") fs.rmSync(path.join(OUT, n)); // keeps the rehearsal logs
const top = path.join(STAGE, TOP);
fs.mkdirSync(top, { recursive: true });

const SKIP_NAMES = new Set([".DS_Store", "node_modules", "__pycache__", ".venv"]);
/** Copies a file or folder from the repo into the stage; dotfiles, caches and .pyc are never copied. */
function copy(rel, { optional = false, filter = () => true } = {}) {
  const src = path.join(root, rel);
  if (!fs.existsSync(src)) {
    if (optional) return;
    die(`required path is missing: ${rel}`);
  }
  const walk = (s, d) => {
    const st = fs.lstatSync(s);
    if (st.isSymbolicLink()) die(`refusing to package a symlink: ${s}`);
    if (st.isDirectory()) {
      fs.mkdirSync(d, { recursive: true });
      for (const n of fs.readdirSync(s)) {
        if (n.startsWith(".") || SKIP_NAMES.has(n) || n.endsWith(".pyc")) continue;
        walk(path.join(s, n), path.join(d, n));
      }
    } else if (filter(path.basename(s))) {
      fs.mkdirSync(path.dirname(d), { recursive: true });
      fs.copyFileSync(s, d);
    }
  };
  walk(src, path.join(top, rel));
}

copy("src");
copy("web/dist");
copy("vendor/engine");
copy("vendor/engine-node");
copy("vendor/engine.lock.json");
copy("skills/onionskin", { filter: (n) => !(forPublic && n === "voice.md") }); // voice.md is the maintainer's own voice guide (like a .env): in his own zip, never in a --public one
copy("scripts/checker");
copy("scripts/rewriter", { filter: (n) => !/^onionskin-fm(\.json|\.building)?$/.test(n) }); // the Swift source of the helper for Apple's model (the built helper is added below); the benchmark and its MLX lab tooling, scripts/rewriter-eval, are never copied
// the helper for Apple's model, built here and shipped ready-made (the person's Mac never compiles it), with its size and hash beside it
let helper;
try {
  helper = buildAppleHelper({ outDir: path.join(top, "scripts", "rewriter", "apple") });
} catch (err) {
  fs.rmSync(STAGE, { recursive: true, force: true });
  die(`the helper for Apple's model did not build: ${err.message}`);
}
console.log(`package: built the Apple helper (${helper.target}, ${helper.size} bytes, sha256 ${helper.sha256})`);
copy("scripts/requirements.txt");
copy("scripts/install-check.mjs");
copy("docs/contracts", { filter: (n) => n.endsWith(".schema.json") }); // src/batch.js and src/ops/schema.js read these at run time
copy("LICENSE");
copy("NOTICE");
copy("CHANGELOG.md");
copy("INSTALL.md");
copy("install.sh");
fs.chmodSync(path.join(top, "install.sh"), 0o755);
fs.chmodSync(path.join(top, "src", "cli.js"), 0o755);

// samples: the engine's own MIT-licensed sample documents (NOTICE item 3), so the first test needs no file of the user's
for (const f of ["sample.docx", "sample.xlsx", "sample.pptx"]) {
  const s = path.join(root, "test", "fixtures", "engine", f);
  if (!fs.existsSync(s)) die(`sample missing: ${s}`);
  fs.mkdirSync(path.join(top, "samples"), { recursive: true });
  fs.copyFileSync(s, path.join(top, "samples", f));
}
fs.writeFileSync(
  path.join(top, "samples", "README.txt"),
  "sample.docx, sample.xlsx and sample.pptx are the sample documents of the office-engine playground (MIT, see NOTICE), copied unchanged.\nOpen one with: onionskin samples/sample.docx\n",
);

// package.json: only what running needs. There are no run-time dependencies (React is bundled into web/dist).
const trimmed = { name: pkg.name, version: pkg.version, description: pkg.description, type: pkg.type, bin: pkg.bin, engines: pkg.engines, license: pkg.license };
if (pkg.dependencies && Object.keys(pkg.dependencies).length) die(`package.json has run-time dependencies (${Object.keys(pkg.dependencies)}): vendor them or make install.sh run npm install --omit=dev`);
fs.writeFileSync(path.join(top, "package.json"), JSON.stringify(trimmed, null, 2) + "\n");

// README: the zip's copy drops the source-build sections and names no internal planning files.
{
  let md = fs.readFileSync(path.join(root, "README.md"), "utf8");
  const dropSection = (title) => {
    const re = new RegExp(`^## ${title}\\n[\\s\\S]*?(?=^## |(?![\\s\\S]))`, "m");
    md = md.replace(re, "");
  };
  dropSection("Install from source");
  dropSection("Developing");
  md = md.replace(/What is done and what is open is in `docs\/PROGRESS\.md`; the plan is `docs\/PLAN\.md`; the contracts are in/, "The contracts are in");
  md = md.replace(/`docs\/(PLAN|PROGRESS|PLAN-collab-later)\.md`/g, "the project plan (not part of this zip)");
  md = md.replace(/^!\[.*\]\(docs\/media\/.*\)\n/gm, "").replace(/^\*The demo was recorded.*\n/m, "").replace(/^For developers: .*\n/m, ""); // the zip has no docs/ folder
  md = md.replace(/^# Onionskin\n/, "# Onionskin\n\n> This is the install zip. Start with INSTALL.md.\n");
  fs.writeFileSync(path.join(top, "README.md"), md.replace(/\n{3,}/g, "\n\n"));
}

// ---- 3. checks ---------------------------------------------------------------------------------------------------
const files = [];
(function walk(d) {
  for (const n of fs.readdirSync(d)) {
    const p = path.join(d, n);
    const st = fs.lstatSync(p);
    if (st.isDirectory()) walk(p);
    else files.push({ rel: path.relative(STAGE, p).split(path.sep).join("/"), abs: p, size: st.size });
  }
})(STAGE);
files.sort((a, b) => (a.rel < b.rel ? -1 : 1));

const home = os.homedir();
const user = os.userInfo().username;
const DENY_WORDS = ["PLAN.md", "PROGRESS.md", "plan-attack"];
const SECRET_RES = [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bAKIA[0-9A-Z]{16}\b/, /\bgh[pousr]_[A-Za-z0-9]{36,}\b/, /\bsk-[A-Za-z0-9]{32,}\b/, /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/];
const isText = (buf) => !buf.subarray(0, 8000).includes(0);
const problems = [];

for (const f of files) {
  const base = path.basename(f.rel);
  if (f.rel.includes("/Users/")) problems.push(`path under /Users/: ${f.rel}`);
  if (base === ".env" || base.startsWith(".env.") || base.startsWith(".")) problems.push(`dotfile: ${f.rel}`);
  if (/\.(pem|key|p12|pfx)$/i.test(base)) problems.push(`key-like file: ${f.rel}`);
  for (const w of DENY_WORDS) if (f.rel.includes(w)) problems.push(`denylisted name "${w}" in path: ${f.rel}`);
  if (f.size > MAX_FILE) problems.push(`file over 5 MB (${(f.size / 1048576).toFixed(1)} MB): ${f.rel}`);
  const buf = fs.readFileSync(f.abs);
  if (f.rel === `${TOP}/scripts/rewriter/apple/onionskin-fm` && (buf.includes(Buffer.from(home)) || (user.length > 3 && buf.includes(Buffer.from(user))))) problems.push(`the home directory or the account name is inside ${f.rel}`);
  if (!isText(buf)) continue; // binary (the sample Office files, the helper): only the size and name checks apply
  const text = buf.toString("utf8");
  if (text.includes(home)) problems.push(`home directory path (${home}) in ${f.rel}`);
  if (/\/Users\/[A-Za-z0-9._-]+\//.test(text)) problems.push(`a /Users/<name>/ path in ${f.rel}`);
  if (user.length > 3 && new RegExp(`\\b${user}\\b`).test(text.replace(/abediaz\.com/g, ""))) problems.push(`the local account name appears in ${f.rel}`);
  for (const w of DENY_WORDS) if (text.includes(w)) problems.push(`denylisted word "${w}" in ${f.rel}`);
  for (const re of SECRET_RES) if (re.test(text)) problems.push(`secret-looking pattern ${re} in ${f.rel}`);
}
const total = files.reduce((n, f) => n + f.size, 0);
if (total > MAX_TOTAL) problems.push(`total unpacked size ${(total / 1048576).toFixed(1)} MB is over 45 MB`);
const required = ["src/cli.js", "web/dist/index.html", "vendor/engine/index.js", "vendor/engine-node/engine-node.mjs", "skills/onionskin/SKILL.md", "install.sh", "INSTALL.md", "LICENSE", "NOTICE", "samples/sample.docx", "docs/contracts/ops.schema.json", "scripts/rewriter/apple/onionskin-fm", "scripts/rewriter/apple/onionskin-fm.json"];
for (const r of required) if (!files.some((f) => f.rel === `${TOP}/${r}`)) problems.push(`missing from the zip: ${r}`);
if (problems.length) {
  fs.rmSync(STAGE, { recursive: true, force: true });
  die(problems.map((p) => `  - ${p}`).join("\n"));
}

// ---- 4. zip ------------------------------------------------------------------------------------------------------
const z = run("/usr/bin/zip", ["-X", "-r", "-q", zipPath, TOP], { cwd: STAGE });
if (z.status !== 0) die(`zip failed: ${z.stderr}`);
const zsize = fs.statSync(zipPath).size;
if (zsize > MAX_TOTAL) {
  fs.rmSync(zipPath);
  die(`the zip is ${(zsize / 1048576).toFixed(1)} MB, over 45 MB`);
}
const digest = crypto.createHash("sha256").update(fs.readFileSync(zipPath)).digest("hex");
fs.rmSync(STAGE, { recursive: true, force: true });

// ---- 5. manifest ---------------------------------------------------------------------------------------------------
const mb = (n) => `${(n / 1048576).toFixed(2)} MB`;
const top10 = [...files].sort((a, b) => b.size - a.size).slice(0, 10);
const manifest = [
  `zip:      ${zipName}`,
  `version:  ${pkg.version}  commit: ${sha}${dirty ? " (working tree had uncommitted changes)" : ""}`,
  `files:    ${files.length}`,
  `unpacked: ${mb(total)}`,
  `zip size: ${mb(zsize)}`,
  `sha256:   ${digest}`,
  `helper:   scripts/rewriter/apple/onionskin-fm  ${helper.target}  ${helper.size} bytes  sha256 ${helper.sha256}`,
  "",
  "largest 10:",
  ...top10.map((f) => `  ${mb(f.size).padStart(9)}  ${f.rel}`),
  "",
  "all files:",
  ...files.map((f) => `  ${String(f.size).padStart(9)}  ${f.rel}`),
  "",
].join("\n");
fs.writeFileSync(path.join(OUT, "MANIFEST.txt"), manifest);
fs.writeFileSync(path.join(OUT, `${zipName}.sha256`), `${digest}  ${zipName}\n`);
console.log(manifest.split("\nall files:")[0]);
console.log(`wrote ${path.relative(root, zipPath)}, dist-zip/MANIFEST.txt and ${zipName}.sha256`);
