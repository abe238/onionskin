#!/usr/bin/env node
// M4 spike tool: compares Accept All / Reject All results with the plain documents, on paragraph text, body path and style.
//   node scripts/tracked-spike/compare.mjs <resultsDir> <genDir>
// <resultsDir> holds accept-<case>.docx and reject-<case>.docx (saved by Word or LibreOffice after Accept All / Reject All);
// <genDir> is the output of make-fixtures.mjs. Accept must equal after-<case>.docx, Reject must equal base.docx.
import fs from "node:fs";
import { readDocxParagraphs } from "../../src/docx.js";
import { openZip } from "../../src/zip.js";

const [dir, gen] = process.argv.slice(2);
if (!dir || !gen) {
  console.error("usage: node scripts/tracked-spike/compare.mjs <resultsDir> <genDir>");
  process.exit(2);
}
const sig = (f) => readDocxParagraphs(fs.readFileSync(f)).map((p) => `${JSON.stringify(p.path)} ${p.styleName ?? p.style ?? "Normal"} ${JSON.stringify(p.text)} bold=${p.fmt?.b ?? ""}`);
// text of the bold runs outside w:del, in order (Word may split or merge runs, so adjacent pieces are joined)
const bold = (f) => {
  const xml = openZip(fs.readFileSync(f)).readText("word/document.xml").replace(/<w:del\b[^>]*>[\s\S]*?<\/w:del>/g, "");
  const runs = xml.match(/<w:r\b[^>]*>[\s\S]*?<\/w:r>/g) || [];
  return runs.filter((r) => /<w:b(\s+w:val="(1|true|on)")?\s*\/>/.test(r)).map((r) => (r.match(/<w:t\b[^>]*>([^<]*)<\/w:t>/g) || []).map((x) => x.replace(/<[^>]+>/g, "")).join("")).join("|");
};
const revs = (f) => (openZip(fs.readFileSync(f)).readText("word/document.xml").match(/<w:(ins|del|moveFrom|moveTo|rPrChange|pPrChange)\b/g) || []).length;
let failed = 0;
for (const f of fs.readdirSync(dir).filter((n) => /^(accept|reject)-.*\.docx$/.test(n)).sort()) {
  const [, op, c] = f.match(/^(accept|reject)-(.*)\.docx$/);
  const want = op === "accept" ? `${gen}/after-${c.replace(/-(prevmark|idclash|own)$/, "")}.docx` : `${gen}/base.docx`;
  const a = [...sig(`${dir}/${f}`), `bold runs: ${bold(`${dir}/${f}`)}`];
  const b = [...sig(want), `bold runs: ${bold(want)}`];
  const diffs = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) diffs.push(`#${i} got ${a[i] ?? "(none)"} want ${b[i] ?? "(none)"}`);
  const left = revs(`${dir}/${f}`);
  if (diffs.length || left) failed++;
  console.log(`${diffs.length || left ? "FAIL" : "PASS"} ${op.padEnd(6)} ${c.padEnd(22)} revisions left ${left}${diffs.length ? "\n   " + diffs.join("\n   ") : ""}`);
}
process.exit(failed ? 1 : 0);
