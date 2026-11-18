// The stress matrix at small sizes (the sizes of the outside reviews: e2e/stress-matrix.e2e.test.js, in the slow group): hostile files
// and comment sets through every route that reads the document or its anchors (test/helpers/matrix.js). Per request: under 1 s of this
// thread's CPU, the request completes, and no comment is lost. Temp dirs only.
import fs from "node:fs";
import path from "node:path";
import { test, after } from "node:test";
import { tmpdir } from "./helpers/zipbuild.js";

const root = tmpdir();
process.env.ONIONSKIN_STATE_DIR = path.join(root, "st");
process.env.ONIONSKIN_NO_SOFFICE = "1";
process.env.ONIONSKIN_REWRITER_STUB = path.join(root, "no-stub.json"); // the rewriter is passed in; no real model is started
const { Sessions } = await import("../src/session.js");
const { ensureStateDir } = await import("../src/paths.js");
const SG = await import("../src/suggest.js");
const { generators, htmlRows, runHtmlRow, runRow } = await import("./helpers/matrix.js");
const { anchorsOffThread } = await import("../src/offload.js");
ensureStateDir();
after(() => fs.rmSync(root, { recursive: true, force: true }));

const S = new Sessions();
for (const row of generators(0.05)) {
  test(`stress matrix (small): ${row.name}: every route under 1 s of this thread's CPU, every comment delivered`, { timeout: 300_000 }, async () => {
    await runRow(S, SG, root, row);
  });
}

// HTML: no open path until Phase 2a, so each row drives the anchor worker directly (test/helpers/matrix.js runHtmlRow); this thread's
// CPU is measured the same way, the work itself runs in the worker.
for (const row of htmlRows()) {
  test(`stress matrix: ${row.name}: a Send and a resolve under 1 s of this thread's CPU each, every comment anchored`, { timeout: 300_000 }, async () => {
    await runHtmlRow(anchorsOffThread, row);
  });
}
