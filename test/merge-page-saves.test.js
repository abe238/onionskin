import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { repoRoot } from "../scripts/fixtures.mjs";
import { mergeProven } from "../src/merge-worker.js";
import { openZip } from "../src/zip.js";

// Bytes saved by the REAL page (test/fixtures/page-saves, captured from the browser tests e2e/merge, e2e/pptx and e2e/xlsx on
// 2026-11-17: base = the file the page loaded, mine = what the page sent to /api/merge, theirs = the agent's file at that moment,
// edits = the page's list). What the page rewrites when it saves, measured part by part: DOCX, the typed run only; PPTX, the typed
// run, which the page writes with a:rPr lang="en-US" dirty="0" (VOLATILE, src/merge-package.js); XLSX, the typed cell (its t="n"
// dropped: the storage, not compared) and the cached value of the formula next to it, which the page computes (not compared: never
// typed); a bold cell adds a font and a cell style at the end of the lists (the engine only appends) and s= on the cell. Nothing
// else changed in any part. Each must merge as the person expects: typed values carried with nothing said, a bold said once.

const dir = path.join(repoRoot, "test", "fixtures", "page-saves");
const load = (name, ext) => {
  const f = (v) => fs.readFileSync(path.join(dir, name, `${v}.${ext}`));
  return { format: ext, base: f("base"), mine: f("mine"), theirs: f("theirs"), edits: JSON.parse(fs.readFileSync(path.join(dir, name, "edits.json"), "utf8")) };
};
// XLSX: the agent's file is made here, one value set through the engine (the browser test's agent wrote through `onionskin apply`,
// whose record of the writes the server keeps and these files do not)
const agentBook = async (base) => {
  const { runOps } = await import("../src/ops/run.js");
  const { parseWorkbook } = await import("../src/xlsx.js");
  const { exactHash } = await import("../src/text.js");
  const wb = parseWorkbook(base);
  const s = wb.sheets.find((x) => x.name === "Budget");
  const was = wb.sheetCells(s).cells.get(29 * 16384 + 3)?.text ?? "";
  const ops = [{ op: "set_cells", target: { sheet: "Budget", range: "D30" }, expect: { text_hash: exactHash(was) }, values: 1400 }];
  const r = await runOps({ bytes: base, format: "xlsx", name: "t.xlsx", ops: structuredClone(ops) });
  assert.ok(r.bytes, JSON.stringify(r.results));
  return { theirs: r.bytes, agent: [{ route: "apply", ops, from: base, to: r.bytes }] }; // the server's record of that write
};
const merge = async (c) => {
  const a = c.format === "xlsx" ? await agentBook(c.base) : { theirs: c.theirs, agent: null };
  return mergeProven({ format: c.format, base: c.base, mine: c.mine, theirs: a.theirs, agent: a.agent, name: `t.${c.format}`, edits: c.edits });
};

for (const [name, ext] of [["docx-typed", "docx"], ["pptx-typed", "pptx"], ["xlsx-typed", "xlsx"]]) {
  test(`a real page save (${name}): text typed while the agent worked merges with nothing handed back and no copy`, async () => {
    const r = await merge(load(name, ext));
    assert.equal(r.refused, undefined, r.refused);
    assert.deepEqual(r.unplaced.map((u) => u.why), []);
    assert.equal(r.copy, false);
    assert.ok(r.bytes, "the person's text is written");
  });
}

test("a real page save (xlsx-bold): a cell made bold and a value typed: the value merges, the bold is said once, with a copy of the person's file", async () => {
  const c = load("xlsx-bold", "xlsx");
  const r = await merge(c);
  assert.equal(r.refused, undefined, r.refused);
  assert.deepEqual(r.unplaced.map((u) => u.why), ['You changed formatting on the sheet "Budget". Formatting is not carried over.']);
  assert.equal(r.copy, true);
  assert.match(openZip(r.bytes).readText("xl/worksheets/sheet2.xml"), /<c r="C16"[^>]*><v>444<\/v>/);
});

test("the page's own rewrite of a PPTX run (lang and dirty) is the engine's: a person's proofing language changed on the same run is theirs", async () => {
  const c = load("pptx-typed", "pptx");
  // the person also set the language of the typed run to French: base has no lang there, so it is theirs and must be handed back
  const { rezip } = await import("./helpers/zipbuild.js");
  const part = openZip(c.mine).names.find((n) => /slides\/slide\d+\.xml$/.test(n) && openZip(c.mine).readText(n).includes('dirty="0"'));
  const fr = rezip(c.mine, { [part]: (x) => x.replace('lang="en-US" dirty="0"', 'lang="fr-FR" dirty="0"') });
  const r = await merge({ ...c, mine: fr });
  assert.ok(r.refused || r.unplaced.length, `the French proofing language is not dropped silently: ${JSON.stringify(r)}`);
});
