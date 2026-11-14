#!/usr/bin/env node
// Builds the DOM-free engine core for plain Node (bun is used for BUILDING only) from the engine source at the commit
// recorded in vendor/engine.lock.json, into vendor/engine-node/, and records it under "node" in the same lock file.
//   node scripts/build-engine-node.mjs                 build + write the lock entry
//   node scripts/build-engine-node.mjs --verify        hashes match the lock and the lock's two commits agree
//   node scripts/build-engine-node.mjs --rebuild-check rebuild in a temp dir and compare byte for byte (needs the engine repo and bun)
//   --commit <sha> --out <dir>                         scratch build of another commit; writes nothing under vendor/ and no lock
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lockPath = path.join(root, "vendor", "engine.lock.json");
const outDir = path.join(root, "vendor", "engine-node");
const entrySrc = path.join(root, "scripts", "engine-node", "entry.ts");
const engineRepo = process.env.ONIONSKIN_ENGINE_REPO || path.resolve(root, "..", "onionskin-engine");
const bun = process.env.BUN || path.join(os.homedir(), ".bun", "bin", "bun");
const sha = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
};
const readLock = () => JSON.parse(fs.readFileSync(lockPath, "utf8"));

function hashes(dir) {
  const files = {};
  for (const name of fs.readdirSync(dir).sort()) files[name] = sha(path.join(dir, name));
  return files;
}

/** git archive of the engine source at `commit` into a fresh temp dir, plus our entry file; bun bundles it for Node. */
function build(commit, into) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "onionskin-engine-"));
  try {
    const tar = execFileSync("/usr/bin/git", ["-C", engineRepo, "archive", commit, "src", "LICENSE"], { maxBuffer: 256 * 1024 * 1024 });
    execFileSync("/usr/bin/tar", ["-x", "-C", tmp], { input: tar });
    fs.copyFileSync(entrySrc, path.join(tmp, "src", "node-entry.ts"));
    fs.mkdirSync(into, { recursive: true });
    execFileSync(bun, ["build", "src/node-entry.ts", "--target=node", "--format=esm", "--outfile", path.join(into, "engine-node.mjs")], { cwd: tmp, stdio: ["ignore", "inherit", "inherit"] });
    fs.copyFileSync(path.join(tmp, "LICENSE"), path.join(into, "LICENSE"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function verify() {
  const lock = readLock();
  const n = lock.node;
  const problems = [];
  if (!n) problems.push("vendor/engine.lock.json has no node section");
  else {
    if (n.engineCommit !== lock.engineCommit) problems.push(`node engine commit ${n.engineCommit.slice(0, 10)} differs from vendored ${lock.engineCommit.slice(0, 10)}: run node scripts/build-engine-node.mjs (npm run vendor re-vendors the browser engine from the engine repo's HEAD and then does this too)`);
    if (n.entrySha256 !== sha(entrySrc)) problems.push("scripts/engine-node/entry.ts changed since the node build");
    const now = fs.existsSync(outDir) ? hashes(outDir) : {};
    for (const [f, h] of Object.entries(n.files)) if (now[f] !== h) problems.push(`${now[f] ? "changed" : "missing"} vendor/engine-node/${f}`);
    for (const f of Object.keys(now)) if (!(f in n.files)) problems.push(`extra vendor/engine-node/${f}`);
  }
  if (problems.length) {
    console.error(`vendor/engine-node does not match vendor/engine.lock.json:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`vendor/engine-node OK (${Object.keys(n.files).length} files, engine ${n.engineCommit.slice(0, 10)})`);
}

if (process.argv.includes("--verify")) verify();
else if (process.argv.includes("--rebuild-check")) {
  const lock = readLock();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "onionskin-rebuild-"));
  try {
    build(lock.node.engineCommit, tmp);
    const a = hashes(tmp);
    const bad = Object.entries(lock.node.files).filter(([f, h]) => a[f] !== h).map(([f]) => f);
    if (bad.length) throw new Error(`rebuild differs from the lock: ${bad.join(", ")}`);
    console.log("vendor/engine-node rebuilds byte for byte");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
} else if (arg("--commit")) {
  const out = path.resolve(arg("--out") || "");
  if (!arg("--out") || out.startsWith(path.join(root, "vendor"))) throw new Error("--commit needs --out <dir> outside vendor/");
  build(arg("--commit"), out);
  console.log(`scratch build of ${arg("--commit")} in ${out}`);
} else {
  const lock = readLock();
  fs.rmSync(outDir, { recursive: true, force: true });
  build(lock.engineCommit, outDir);
  lock.node = {
    engineCommit: lock.engineCommit,
    entry: "engine-node.mjs",
    entrySha256: sha(entrySrc),
    bun: execFileSync(bun, ["--version"], { encoding: "utf8" }).trim(),
    files: hashes(outDir),
  };
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n");
  console.log(`built vendor/engine-node (${Object.keys(lock.node.files).join(", ")}) from engine ${lock.engineCommit.slice(0, 10)}`);
}
