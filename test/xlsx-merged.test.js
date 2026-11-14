// Merged cells: the outline tells an agent which cells are hidden under a merge, and set_cells refuses to write them.
// Synthetic workbooks only (built in memory, nothing on disk).
import assert from "node:assert/strict";
import { test } from "node:test";
import { rezip, xlsxBytes } from "./helpers/zipbuild.js";

process.env.ONIONSKIN_NO_SOFFICE = "1";
const { outlineOf } = await import("../src/review.js");
const { runOps } = await import("../src/ops/run.js");

const merged = (refs, cells = { A1: "Quarterly title", A3: "Region", B3: "Units" }) =>
  rezip(xlsxBytes({ Sheet1: cells }), { "xl/worksheets/sheet1.xml": (x) => x.replace("</sheetData>", `</sheetData><mergeCells count="${refs.length}">${refs.map((r) => `<mergeCell ref="${r}"/>`).join("")}</mergeCells>`) });

test("outline: the anchor cell of a merged range carries `merged`; other cells do not; covered cells get no unit", () => {
  const { outline } = outlineOf("xlsx", merged(["A1:D1"]));
  assert.deepEqual(outline.map((u) => u.label), ["Sheet1!A1", "Sheet1!A3", "Sheet1!B3"]);
  assert.equal(outline[0].merged, "A1:D1");
  assert.equal(outline[1].merged, undefined);
  assert.equal(outline[2].merged, undefined);
  assert.deepEqual(outline[0].target, { sheet: "Sheet1", range: "A1" }, "the target is unchanged");
});

test("outline: a workbook without merges has the same entries as before (no `merged` key at all)", () => {
  const { outline } = outlineOf("xlsx", xlsxBytes({ Sheet1: { A1: "Title", B2: "x" } }));
  assert.ok(outline.every((u) => !("merged" in u)));
});

test("set_cells: a value into a covered cell is refused naming the range; the anchor, an empty write and cells outside still apply", async () => {
  const bytes = merged(["A1:D1"]);
  const run = (ops) => runOps({ bytes, format: "xlsx", name: "t.xlsx", ops, partial: true });
  const r = await run([
    { op: "set_cells", target: { sheet: "Sheet1", range: "B1" }, expect: { quote: "" }, values: "Checked" },
    { op: "set_cells", target: { sheet: "Sheet1", range: "E1" }, expect: { quote: "" }, values: "Checked" },
    { op: "set_cells", target: { sheet: "Sheet1", range: "A1" }, expect: { quote: "Quarterly title" }, values: "New title" },
  ]);
  assert.deepEqual(r.results.map((x) => x.status), ["refused", "applied", "applied"], JSON.stringify(r.results));
  assert.equal(r.results[0].code, "merged_cell");
  assert.match(r.results[0].reason, /A1:D1/);
  assert.match(r.results[0].reason, /B1/);
  // a range write whose covered cells carry values is refused too
  const wide = await run([{ op: "set_cells", target: { sheet: "Sheet1", range: "A1:B1" }, expect: { quote: "Quarterly title\t" }, values: [["x", "y"]] }]);
  assert.equal(wide.results[0].code, "merged_cell");
});
