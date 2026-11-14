#!/usr/bin/env node
// The owner's Word gate for the tracked-changes copy (docs/contracts/tracked-changes.md section 8): writes the spike's plain files and,
// for each shipped case, the copy the real builder makes (out-<case>.docx), into the directory given (a temp dir, or for Word a folder
// inside Word's container). The five spike cases, plus four forms the builder writes that the spike did not cover: a moved paragraph, a
// rewritten paragraph (an added one right before a removed one), two paragraphs added in a row and two removed in a row. For those four
// the plain after-<case>.docx is made here from base.docx.
//   node scripts/tracked-spike/make-outputs.mjs <outdir>
// Then in Word: open out-<case>.docx, Accept All, save as accept-<case>.docx; reopen out-<case>.docx, Reject All, save as reject-<case>.docx;
// then `node scripts/tracked-spike/compare.mjs <outdir> <outdir>`.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AUTHORS, buildTracked, wordDate } from "../../src/redline.js";
import { openZip } from "../../src/zip.js";
import { replaceEntry } from "../../src/zip-write.js";
import { verifyTracked } from "../../src/redline-check.js";

const out = process.argv[2];
if (!out) {
  console.error("usage: node scripts/tracked-spike/make-outputs.mjs <outdir>");
  process.exit(2);
}
const here = path.dirname(fileURLToPath(import.meta.url));
const r = spawnSync(process.execPath, [path.join(here, "make-fixtures.mjs"), out], { stdio: "inherit" });
if (r.status !== 0) process.exit(1);
const date = wordDate(Date.now());
const before = fs.readFileSync(path.join(out, "base.docx"));
// base body: [0] heading, [1] Normal, [2] Note, [3] Normal with a bold word, then the table and the Signoff paragraph
const xml = openZip(before).readText("word/document.xml");
const paras = xml.match(/<w:p>[\s\S]*?<\/w:p>/g).slice(0, 4);
const plain = (text) => `<w:p><w:pPr></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
const EXTRA = {
  "move-para": (x) => x.replace(paras[1] + paras[2], paras[2] + paras[1]),
  "rewrite-para": (x) => x.replace(paras[2], plain("Quarterly costs go to finance by Friday noon.")),
  "insert-two": (x) => x.replace(paras[1], paras[1] + plain("First of two new paragraphs here.") + plain("Second of two new paragraphs here.")),
  "delete-two": (x) => x.replace(paras[1] + paras[2], ""),
};
for (const [c, edit] of Object.entries(EXTRA)) fs.writeFileSync(path.join(out, `after-${c}.docx`), replaceEntry(before, "word/document.xml", edit(xml)));
const CASES = ["replace-word", "replace-bold", "cell-edit", "insert-mid", "delete-mid", ...Object.keys(EXTRA)];
let bad = 0;
for (const c of CASES) {
  const after = fs.readFileSync(path.join(out, `after-${c}.docx`));
  const t = buildTracked({ before, after, author: AUTHORS.agent, date });
  const v = t.refused ? { ok: false, why: `refused: ${t.refused}` } : verifyTracked({ before, after, out: t.bytes, counts: t.counts, author: AUTHORS.agent, date });
  if (!v.ok) {
    console.error(`${c}: ${v.why}`);
    bad++;
    continue;
  }
  fs.writeFileSync(path.join(out, `out-${c}.docx`), t.bytes);
  console.log(`${c}: ${JSON.stringify(t.counts)}`);
}
console.log(`wrote out-<case>.docx for ${CASES.length - bad} of ${CASES.length} cases to ${out} (w:date ${date})`);
process.exit(bad ? 1 : 0);
