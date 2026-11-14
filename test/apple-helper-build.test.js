import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { HELPER_FLAGS, HELPER_SOURCE, HELPER_TARGET, buildAppleHelper } from "../scripts/build-apple-helper.mjs";

// The ready-made helper for Apple's model (scripts/build-apple-helper.mjs, used by scripts/package.mjs). Temp folders only; the built helper
// is inspected (architecture, minimum macOS, hash), never run.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "os-fm-build-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const haveTools = spawnSync("/usr/bin/xcode-select", ["-p"]).status === 0;

test("the build line: optimized, arm64 only, macOS 26.0 as the minimum, the shipped source", () => {
  assert.equal(HELPER_TARGET, "arm64-apple-macos26.0");
  assert.deepEqual(HELPER_FLAGS, ["-O", "-parse-as-library", "-target", "arm64-apple-macos26.0"]);
  const calls = [];
  const run = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === "/usr/bin/swiftc") fs.writeFileSync(args[args.indexOf("-o") + 1], "fake binary");
    return { status: 0 };
  };
  const out = path.join(tmp, "fake");
  const r = buildAppleHelper({ outDir: out, run });
  assert.deepEqual(calls.map((c) => c[0]), ["/usr/bin/xcode-select", "/usr/bin/swiftc"]);
  assert.deepEqual(calls[1], ["/usr/bin/swiftc", ...HELPER_FLAGS, HELPER_SOURCE, "-o", path.join(out, "onionskin-fm.building")]);
  assert.deepEqual(r, { file: "onionskin-fm", target: HELPER_TARGET, size: 11, sha256: crypto.createHash("sha256").update("fake binary").digest("hex") });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, "onionskin-fm.json"), "utf8")), r);
  assert.deepEqual(fs.readdirSync(out).sort(), ["onionskin-fm", "onionskin-fm.json"]);
});

test("no developer tools: swiftc is never started (it would open Apple's installer); a failed build leaves nothing behind", () => {
  const calls = [];
  const noTools = (cmd) => (calls.push(cmd), { status: 2 });
  assert.throws(() => buildAppleHelper({ outDir: path.join(tmp, "none"), run: noTools }), /developer tools are not installed/);
  assert.deepEqual(calls, ["/usr/bin/xcode-select"]);
  const out = path.join(tmp, "broken");
  const fails = (cmd, args) => {
    if (cmd === "/usr/bin/swiftc") {
      fs.writeFileSync(args[args.indexOf("-o") + 1], "half");
      return { status: 1, stderr: "error: cannot find 'X' in scope" };
    }
    return { status: 0 };
  };
  assert.throws(() => buildAppleHelper({ outDir: out, run: fails }), /swiftc failed \(exit 1\) error: cannot find 'X' in scope/);
  assert.deepEqual(fs.readdirSync(out), []);
});

test("the real build: arm64 only, minimum macOS 26.0, about 100 KB, the same bytes from two folders, and no home path inside", { skip: haveTools ? false : "the macOS developer tools are not installed" }, () => {
  const a = buildAppleHelper({ outDir: path.join(tmp, "a") });
  const b = buildAppleHelper({ outDir: path.join(tmp, "b") });
  assert.equal(a.sha256, b.sha256, "reproducible");
  assert.ok(a.size > 50_000 && a.size < 400_000, `${a.size} bytes`);
  const bin = path.join(tmp, "a", "onionskin-fm");
  assert.equal(spawnSync("/usr/bin/lipo", ["-archs", bin], { encoding: "utf8" }).stdout.trim(), "arm64");
  assert.match(spawnSync("/usr/bin/vtool", ["-show-build", bin], { encoding: "utf8" }).stdout, /minos 26\.0\b/);
  const bytes = fs.readFileSync(bin);
  assert.ok(!bytes.includes(Buffer.from(os.homedir())), "no home path");
  assert.ok(!bytes.includes(Buffer.from(tmp)), "no build folder path");
});
