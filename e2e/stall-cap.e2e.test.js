// Files at (or just under) the readers' caps through every path of a real server in a child process, with /health probed the whole time
// (test/helpers/stall.js everyPath, mergeFlow): /health must be answered within 2 s at every moment. Heavy (each builds and reads a file at
// a cap several times), so they run in the slow group, one file at a time; test/stall.test.js and test/stall-merge.test.js run the same
// flows at smaller sizes. Temp dirs only; no agent is started.
import assert from "node:assert/strict";
import { test } from "node:test";
import { everyPath, mergeFlow } from "../test/helpers/stall.js";
import { docxParas, pptxRuns, xlsxGrid, xlsxShared } from "../test/helpers/hostile.js";
import fs from "node:fs";
import path from "node:path";
import { MAX_CELLS, parseWorkbook } from "../src/xlsx.js";
import { parseDeck } from "../src/pptx.js";
import { docxBytes, rezip, xlsxBytes } from "../test/helpers/zipbuild.js";
import { ENGINE_SAMPLES, haveSamples, skipUnless } from "../scripts/fixtures.mjs";
import { MAX_PARAGRAPHS, readDocxParagraphs } from "../src/docx.js";

const SKIP = skipUnless(haveSamples(), `engine samples not found in ${ENGINE_SAMPLES}`, "restore test/fixtures/engine or set ONIONSKIN_TEST_SAMPLES");

test(`merging a Word file of ${(MAX_PARAGRAPHS - 1).toLocaleString("en-US")} edited paragraphs (the cap) keeps /health under 2 s (more than 60 s before)`, { timeout: 240_000 }, async () => {
  const n = MAX_PARAGRAPHS - 1;
  // paragraph ids, as Word writes them (without them the matcher cannot pair this many rewritten paragraphs: see test/merge.test.js)
  const make = (suffix = "", first = null) => docxBytes(Array.from({ length: n }, (_, i) => ({ paraId: (0x10000000 + i).toString(16).toUpperCase(), text: i === 0 && first ? first : `Paragraph number ${i} of the text${suffix}` })));
  const r = await mergeFlow("docx", make, { location: { blockPath: [0] }, paraText: "a" }, (bytes) => {
    const paras = readDocxParagraphs(bytes);
    assert.equal(paras.length, n);
    assert.equal(paras[0].text, "Changed by the agent here");
    assert.equal(paras.filter((p, i) => p.text === `Paragraph number ${i} of the text, edited by me`).length, n - 1);
  });
  assert.equal(r.merged, n - 1);
});

test("a Word file of 49,999 paragraphs (the paragraph cap): every path keeps /health under 2 s", { timeout: 240_000 }, () => everyPath("docx", docxParas(49_999)));
test("an Excel file of 100,000 cells and 49,000 merged ranges: every path keeps /health under 2 s (the review took 18 s)", { timeout: 240_000 }, () => everyPath("xlsx", xlsxGrid(100_000, 49_000)));
test(`a plain workbook just under the cell cap (${(MAX_CELLS - 1000).toLocaleString("en-US")} number cells, 0.0.3 opened it): every path keeps /health under 2 s`, { timeout: 240_000 }, () => everyPath("xlsx", xlsxGrid(MAX_CELLS - 1000)));
test("a workbook of 249,000 cells that all show one shared string of 128 characters (just under the 32 million cap): every path under 2 s", { timeout: 240_000 }, () => everyPath("xlsx", xlsxShared(249_000, 128)));
test("a workbook of 4 cells that show a shared string of 7.9 million characters (the worst shape under the cap): every path under 2 s", { timeout: 240_000 }, () => everyPath("xlsx", xlsxShared(4, 7_900_000)));
test("a deck of one shape of 240,000 runs (the element cap): every path keeps /health under 2 s", { timeout: 240_000 }, () => everyPath("pptx", pptxRuns(1, 240_000)));

// ---- round 5: the reviewer's merges, through a real server: the merge runs in a worker, so /health is answered throughout -------------
test("the reviewer's Word merge: 3,900 paragraphs of 2,000 \"a\", one letter typed in each (4.2 s of CPU on the thread before)", { timeout: 240_000 }, async () => {
  const a = "a".repeat(2000);
  const make = (suffix = "", first = null) => docxBytes(Array.from({ length: 3900 }, (_, i) => ({ paraId: (0x10000000 + i).toString(16).toUpperCase(), text: first && i === 0 ? `c${a.slice(1)}` : suffix ? `${a.slice(0, 1000)}b${a.slice(1001)}` : a })));
  const r = await mergeFlow("docx", make, { location: { blockPath: [0] }, paraText: "a" }, (bytes) => {
    const paras = readDocxParagraphs(bytes);
    assert.equal(paras[0].text, `c${a.slice(1)}`);
    assert.equal(paras.filter((p) => p.text === `${a.slice(0, 1000)}b${a.slice(1001)}`).length, 3899);
  });
  assert.equal(r.merged, 3899);
});

test("the reviewer's Excel merge: one sheet of 50,000 rows by 20 columns, the person changes A1 and the agent A2 with an op (11 s on the thread before)", { timeout: 240_000 }, async () => {
  const cells = {};
  for (let r = 0; r < 50_000; r++) for (let c = 0; c < 20; c++) cells[`${String.fromCharCode(65 + c)}${r + 1}`] = r * 20 + c;
  const make = (suffix = "") => xlsxBytes({ S: suffix ? { ...cells, A1: 1000001 } : cells });
  const ops = [{ op: "set_cells", target: { sheet: "S", range: "A2" }, expect: { quote: "20" }, values: 1000002 }];
  const r = await mergeFlow("xlsx", make, { location: { sheetIndex: 0, sheetName: "S", range: "A1" } }, (bytes) => {
    const wb = parseWorkbook(bytes);
    const got = wb.sheetCells(wb.sheets[0]).cells;
    assert.deepEqual([got.get(0)?.text, got.get(16384)?.text, got.get(16384 * 2)?.text], ["1000001", "1000002", "40"]);
  }, { ops });
  assert.deepEqual([r.merged, r.unplaced], [1, []]);
});

test("the reviewer's PowerPoint merge: one shape of 25,000 paragraphs, every one changed (4 s to plan and hours to apply before)", { skip: SKIP, timeout: 240_000 }, async () => {
  const sample = fs.readFileSync(path.join(ENGINE_SAMPLES, "sample.pptx"));
  const make = (suffix = "", first = null) =>
    rezip(sample, {
      "ppt/slides/slide2.xml": (x) => x.replace(/(<p:cNvPr id="3"[\s\S]*?<a:lstStyle\/>)[\s\S]*?(<\/p:txBody>)/, (_, s, e) => `${s}${`<a:p><a:r><a:t>${suffix ? "b" : "a"}</a:t></a:r></a:p>`.repeat(25_000)}${e}`).replace("Why it is fast", first ? "Why it is quick" : "Why it is fast"),
    });
  const r = await mergeFlow("pptx", make, { location: { slideIndex: 1, shapeId: 3 }, quote: "a" }, (bytes) => {
    const d = parseDeck(bytes);
    d.ensure();
    const shapes = d.slides[1].shapes;
    assert.equal(shapes.find((x) => x.id === 2).text, "Why it is quick");
    assert.equal(shapes.find((x) => x.id === 3).text, Array(25_000).fill("b").join("\n"));
  });
  assert.equal(r.merged, 1);
});
