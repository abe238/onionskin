#!/usr/bin/env node
// The HTML parser Onionskin reads .html files with: parse5 (MIT) and the entities package it imports (BSD-2-Clause), bundled into one
// ES module with no imports, vendor/parse5/parse5.mjs, next to their combined license, pinned by vendor/parse5.lock.json. It is loaded
// only by modules that run in worker threads (src/html-parser.js), never on the server's own thread.
//   node scripts/vendor-parse5.mjs --verify            recompute sha256 of vendor/parse5 and fail on a mismatch (npm run verify:vendor)
//   node scripts/vendor-parse5.mjs --build <dir>       rebuild from the two npm tarballs in <dir> (parse5-<v>.tgz, entities-<v>.tgz):
//                                                      checks each tarball's sha512 against the lock, unpacks to a temp folder, bundles
//                                                      with the repo's rolldown and fails unless the result is byte for byte the locked file
// Nothing is fetched: get the tarballs with `npm pack parse5@<v> entities@<v> --ignore-scripts` and read them before building.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "vendor", "parse5");
const lockPath = path.join(root, "vendor", "parse5.lock.json");
const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

function verify() {
  const problems = [];
  const have = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
  for (const [name, h] of Object.entries(lock.files)) {
    const p = path.join(dir, name);
    if (!have.includes(name)) problems.push(`missing ${name}`);
    else if (!fs.lstatSync(p).isFile()) problems.push(`not a regular file: ${name}`);
    else if (sha256(fs.readFileSync(p)) !== h) problems.push(`changed ${name}`);
  }
  for (const name of have) if (!(name in lock.files)) problems.push(`extra ${name}`);
  if (problems.length) {
    console.error(`vendor/parse5 does not match vendor/parse5.lock.json:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`vendor/parse5 OK (${Object.keys(lock.files).length} files, parse5 ${lock.parse5.version}, entities ${lock.entities.version})`);
}

async function build(tarDir) {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "osk-parse5-")));
  const here = process.cwd();
  try {
    const unpack = (pkg) => {
      const tgz = path.join(tarDir, `${pkg}-${lock[pkg].version}.tgz`);
      const bytes = fs.readFileSync(tgz);
      const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
      if (integrity !== lock[pkg].integrity) throw new Error(`${path.basename(tgz)}: integrity ${integrity} is not the locked ${lock[pkg].integrity}`);
      const out = path.join(tmp, "third_party", "unpacked", pkg);
      fs.mkdirSync(out, { recursive: true });
      execFileSync("/usr/bin/tar", ["-xzf", tgz, "-C", out], { stdio: "inherit" });
      return path.join(out, "package");
    };
    const p5 = unpack("parse5");
    const ent = path.join(unpack("entities"), "dist");
    const { rolldown } = await import(pathToFileURL(path.join(root, "node_modules", "rolldown", "dist", "index.mjs")).href);
    process.chdir(tmp); // the bundle names each module by its path relative to the working folder
    const bundle = await rolldown({
      input: path.join(p5, "dist", "index.js"),
      platform: "neutral",
      treeshake: true,
      plugins: [{ name: "local-entities", resolveId: (id) => ({ "entities/decode": path.join(ent, "decode.js"), "entities/escape": path.join(ent, "escape.js"), entities: path.join(ent, "index.js") })[id] ?? null }],
    });
    const { output } = await bundle.generate({ format: "esm", banner: lock.banner, sourcemap: false });
    await bundle.close();
    if (output.length !== 1) throw new Error(`expected one chunk, got ${output.length}`);
    const code = Buffer.from(output[0].code);
    const license = Buffer.from(fs.readFileSync(path.join(p5, "LICENSE"), "utf8") + "\n---- entities ----\n" + fs.readFileSync(path.join(ent, "..", "LICENSE"), "utf8"));
    const made = { [lock.entry]: code, "LICENSE.txt": license };
    const wrong = Object.entries(made).filter(([name, buf]) => sha256(buf) !== lock.files[name]).map(([name]) => name);
    if (wrong.length) throw new Error(`the rebuild differs from the lock: ${wrong.join(", ")} (nothing was written)`);
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, buf] of Object.entries(made)) fs.writeFileSync(path.join(dir, name), buf);
    console.log(`vendor/parse5 rebuilt, byte for byte the locked files (${code.length} bytes)`);
  } finally {
    process.chdir(here);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const at = process.argv.indexOf("--build");
if (process.argv.includes("--verify")) verify();
else if (at > 0 && process.argv[at + 1]) await build(path.resolve(process.argv[at + 1]));
else {
  console.error("usage: node scripts/vendor-parse5.mjs --verify | --build <folder with the two tarballs>");
  process.exit(2);
}
