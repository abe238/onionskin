import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { buildAppleHelper } from "../scripts/build-apple-helper.mjs";
import { appleHelperState, createWorker, sandboxed } from "../src/rewriter.js";
import { probeHelper } from "../src/rewriter-setup.js";
import { checkRewrite } from "../src/rewrite-check.js";

// OPT IN: runs only with ONIONSKIN_REAL_REWRITER=1, and calls Apple's on-device model for real, so run it under the shared lock. It builds the
// shipped helper into a temp folder (the way scripts/package.mjs does), passes the same checks the server makes before any start
// (appleHelperState: macOS 26, Apple silicon, the hash, no quarantine mark), asks it whether the model is available, and sends a few sentences
// the way the server does (sandbox with the network denied, a minimal environment). It prints the answers; it asserts only that the model
// answers and that the quoted misspelling never reaches the page.
const on = process.env.ONIONSKIN_REAL_REWRITER === "1";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "rw-real-apple-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const SENTENCES = [
  "This are a test of the writing helper.",
  "The supplier's invoice lists the item as \"stainles steel brackets\", and we need them to correct it.",
  "Its a good day for the team to finish the report.",
];

test("the real Apple helper: built ready-made, checked without running it, available, and answers Fix grammar in the sandbox", { skip: on ? false : "set ONIONSKIN_REAL_REWRITER=1 to run (calls Apple's on-device model; use the shared lock)", timeout: 180_000 }, async () => {
  const dir = path.join(root, "helper");
  const rec = buildAppleHelper({ outDir: dir });
  const h = appleHelperState({ dir });
  assert.equal(h.ok, true, `the server would not start it: ${h.reason}`);
  assert.equal(h.sha256, rec.sha256);
  const state = path.join(root, "state");
  fs.mkdirSync(state);
  const pr = await probeHelper(h.bin);
  assert.equal(pr.status, 0, `Apple's model is not available here: ${pr.stdout.trim()}`);
  const [cmd, args] = sandboxed(h.bin, []);
  const w = createWorker({ cmd, args, env: { PATH: "/usr/bin:/bin", HOME: state, TMPDIR: os.tmpdir() }, cwd: state }, { startMs: 60_000 });
  try {
    const t0 = Date.now();
    w.warm();
    while (!w.ready) {
      assert.ok(Date.now() - t0 < 60_000, "the helper did not start within a minute");
      await new Promise((r) => setTimeout(r, 50));
    }
    for (const s of SENTENCES) {
      const t = Date.now();
      const r = await w.rewrite("grammar", s, { timeoutMs: 20_000 });
      assert.equal(r.ok, true, JSON.stringify(r));
      const c = checkRewrite("grammar", s, r.text, { mode: "suggest" });
      console.log(`REAL APPLE ${Date.now() - t} ms  ${c.verdict.padEnd(9)} ${(c.reasons || []).map((x) => x.code).join(",")}  ${JSON.stringify(r.text)}`);
      if (s.includes("stainles")) assert.ok(c.verdict === "unchanged" || c.verdict === "withhold" || r.text.includes("\"stainles steel brackets\""), "the quoted misspelling is never offered as fixed");
    }
  } finally {
    w.close();
  }
});
