import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

// Checks the zip that `node scripts/package.mjs` built. Skips (with the reason) when no zip exists; it never builds one.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist-zip");
const zip = fs.existsSync(dist) ? fs.readdirSync(dist).filter((n) => /^onionskin-.*\.zip$/.test(n)).map((n) => path.join(dist, n)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] : null;
const skip = zip ? false : "no zip in dist-zip/: run `node scripts/package.mjs` first";

describe("the install zip", { skip }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pkg-test-"));
  const names = [];
  const read = (rel) => fs.readFileSync(path.join(tmp, "onionskin", rel), "utf8");
  test("unzips to one top folder with the run-time files", () => {
    const r = spawnSync("/usr/bin/unzip", ["-q", zip, "-d", tmp]);
    assert.equal(r.status, 0, String(r.stderr));
    assert.deepEqual(fs.readdirSync(tmp), ["onionskin"]);
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) (e.isDirectory() ? walk(path.join(d, e.name)) : names.push(path.relative(tmp, path.join(d, e.name))));
    })(tmp);
    for (const f of ["src/cli.js", "web/dist/index.html", "vendor/engine-node/engine-node.mjs", "vendor/engine/index.js", "skills/onionskin/SKILL.md", "install.sh", "INSTALL.md", "LICENSE", "NOTICE", "samples/sample.docx", "docs/contracts/ops.schema.json", "scripts/install-check.mjs", "scripts/checker/check.py", "scripts/rewriter/apple/main.swift", "scripts/rewriter/apple/onionskin-fm", "scripts/rewriter/apple/onionskin-fm.json"]) {
      assert.ok(fs.existsSync(path.join(tmp, "onionskin", f)), `missing ${f}`);
    }
  });
  test("the helper for Apple's model is in the zip ready-made: arm64, macOS 26.0 or later, its hash in onionskin-fm.json and in MANIFEST.txt", () => {
    const bin = path.join(tmp, "onionskin", "scripts", "rewriter", "apple", "onionskin-fm");
    const rec = JSON.parse(read("scripts/rewriter/apple/onionskin-fm.json"));
    const bytes = fs.readFileSync(bin);
    assert.equal(rec.sha256, crypto.createHash("sha256").update(bytes).digest("hex"));
    assert.equal(rec.size, bytes.length);
    assert.equal(rec.target, "arm64-apple-macos26.0");
    assert.ok(fs.statSync(bin).mode & 0o100, "executable");
    assert.equal(spawnSync("/usr/bin/lipo", ["-archs", bin], { encoding: "utf8" }).stdout.trim(), "arm64");
    assert.match(spawnSync("/usr/bin/vtool", ["-show-build", bin], { encoding: "utf8" }).stdout, /minos 26\.0\b/);
    assert.ok(fs.readFileSync(path.join(dist, "MANIFEST.txt"), "utf8").includes(`sha256 ${rec.sha256}`), "the manifest names its hash");
  });
  test("nothing of the old download or the benchmark lab is in the zip: no Python worker, model list or libraries list, only the Apple helper", () => {
    const rewriter = names.filter((n) => n.startsWith("onionskin/scripts/rewriter/")).map((n) => n.slice("onionskin/scripts/rewriter/".length)).sort();
    assert.deepEqual(rewriter, ["apple/main.swift", "apple/onionskin-fm", "apple/onionskin-fm.json"]);
    assert.deepEqual(names.filter((n) => /rewriter-eval|rewrite_mlx|mlx-lab|\/models\.json$/.test(n)), []);
  });
  test("the sample voice guide ships; a --public zip never holds a personal voice.md", () => {
    assert.ok(names.includes("onionskin/skills/onionskin/voice.example.md"));
    if (/-public\.zip$/.test(zip)) assert.equal(names.some((n) => /(^|\/)voice\.md$/.test(n)), false);
  });
  test("excludes tests, internal docs, dotfiles, node_modules and dev folders", () => {
    const bad = names.filter((n) => /(^|\/)(test|e2e|node_modules|\.git|\.github|real-run|dist-zip)(\/|$)|\/\.[^/]+$|docs\/(PLAN|PROGRESS|review|screens)|web\/src\//.test(n));
    assert.deepEqual(bad, []);
  });
  test("no file over 5 MB, total under 45 MB, zip under 45 MB", () => {
    let total = 0;
    for (const n of names) {
      const s = fs.statSync(path.join(tmp, n)).size;
      total += s;
      assert.ok(s <= 5 * 1024 * 1024, `${n} is ${s} bytes`);
    }
    assert.ok(total <= 45 * 1024 * 1024, `unpacked ${total}`);
    assert.ok(fs.statSync(zip).size <= 45 * 1024 * 1024);
  });
  test("no home path, secret pattern or internal file name inside any text file", () => {
    const home = os.homedir();
    for (const n of names) {
      const buf = fs.readFileSync(path.join(tmp, n));
      if (buf.subarray(0, 8000).includes(0)) continue;
      const t = buf.toString("utf8");
      assert.ok(!t.includes(home), `${n} contains the home path`);
      assert.ok(!/\/Users\/[A-Za-z0-9._-]+\//.test(t), `${n} contains a /Users/ path`);
      assert.ok(!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(t), `${n} has a private key`);
      for (const w of ["PLAN.md", "PROGRESS.md", "plan-attack"]) assert.ok(!t.includes(w), `${n} mentions ${w}`);
    }
  });
  test("package.json is trimmed and the install script is valid sh", () => {
    const p = JSON.parse(read("package.json"));
    assert.equal(p.devDependencies, undefined);
    assert.equal(p.dependencies, undefined);
    assert.equal(p.bin.onionskin, "src/cli.js");
    assert.equal(p.engines.node, ">=22");
    assert.equal(spawnSync("/bin/sh", ["-n", path.join(tmp, "onionskin", "install.sh")]).status, 0);
  });
});
