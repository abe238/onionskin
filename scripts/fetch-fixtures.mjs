#!/usr/bin/env node
// Downloads the small pinned set of real Office files (Apache POI test data, Apache-2.0) listed in test/fixtures/manifest.json
// into test/fixtures/cache/ (gitignored), verifying each sha256. Development only: the app itself never makes this request.
//   node scripts/fetch-fixtures.mjs [--dir <dir>]
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CORPUS, repoRoot } from "./fixtures.mjs";

const i = process.argv.indexOf("--dir");
const dir = i >= 0 ? path.resolve(process.argv[i + 1]) : CORPUS;
const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "test", "fixtures", "manifest.json"), "utf8"));
const sha = (b) => createHash("sha256").update(b).digest("hex");
fs.mkdirSync(dir, { recursive: true });
let bad = 0;
for (const f of manifest.files) {
  const dest = path.join(dir, f.name);
  if (fs.existsSync(dest) && sha(fs.readFileSync(dest)) === f.sha256) continue;
  const res = await fetch(f.url);
  if (!res.ok) {
    console.error(`${f.name}: HTTP ${res.status}`);
    bad++;
    continue;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (sha(buf) !== f.sha256) {
    console.error(`${f.name}: sha256 mismatch, not saved`);
    bad++;
    continue;
  }
  fs.writeFileSync(dest, buf);
  console.log(`fetched ${f.name}`);
}
if (bad) process.exit(1);
console.log(`${manifest.files.length} fixtures in ${dir}`);
