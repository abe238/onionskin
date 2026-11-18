// The stress matrix at the sizes the outside reviews used (test/helpers/matrix.js; small sizes in test/stress-matrix.test.js): a paragraph
// of one sentence repeated 10,000 times, units of 7.9 million characters, decomposed and CJK text, 1,000-character number formats,
// 20,000 defined names, 100,000 merged ranges, overlapping large ranges, repeated short needles, 500 comments each, through every route
// that reads the document or its anchors. Per request: under 1 s of this thread's CPU (the anchor worker's is not counted), the request
// completes, no comment is lost. Heavy, so it runs in the slow group, one file at a time. Temp dirs only.
import fs from "node:fs";
import path from "node:path";
import { test, after } from "node:test";
import { tmpdir } from "../test/helpers/zipbuild.js";

const root = tmpdir("da-matrix-");
process.env.ONIONSKIN_STATE_DIR = path.join(root, "st");
process.env.ONIONSKIN_NO_SOFFICE = "1";
process.env.ONIONSKIN_REWRITER_STUB = path.join(root, "no-stub.json");
const { Sessions } = await import("../src/session.js");
const { ensureStateDir } = await import("../src/paths.js");
const SG = await import("../src/suggest.js");
const { generators, runRow } = await import("../test/helpers/matrix.js");
ensureStateDir();
after(() => fs.rmSync(root, { recursive: true, force: true }));

const S = new Sessions();
for (const row of generators(1)) {
  test(`stress matrix: ${row.name}: every route under 1 s of this thread's CPU, every comment delivered`, { timeout: 600_000 }, async (t) => {
    const out = await runRow(S, SG, root, row);
    t.diagnostic(out.map((x) => `${x.route} ${x.ms} ms`).join(", "));
  });
}
