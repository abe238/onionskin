import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { xlsxBytes } from "./helpers/zipbuild.js";
import { agentChanges, mergeXlsx, planXlsxMerge, sheetMoved } from "../src/merge-xlsx.js";
import { parseWorkbook } from "../src/xlsx.js";
import { runOps } from "../src/ops/run.js";
import { ENGINE_SAMPLES } from "../scripts/fixtures.mjs";

const SAMPLE = path.join(ENGINE_SAMPLES, "sample.xlsx");

// What the user changed in a workbook while the agent worked is carried onto the agent's version, cell by cell (src/merge-xlsx.js).
// Real XLSX bytes, the real op engine. The agent's side is either made with checked ops, with the record the server keeps of such a
// write (`viaOps`), or plain bytes: a `commit` or any write the server cannot name, which carries no record.
const BUDGET = () => {
  const cells = { A1: "Item", B1: "Q1", C1: "Q2", D1: "Total" };
  for (let r = 2; r <= 9; r++) Object.assign(cells, { [`A${r}`]: `Line ${r}`, [`B${r}`]: r * 10, [`C${r}`]: r * 100, [`D${r}`]: `=B${r}+C${r}` });
  return cells;
};
const book = (budget = BUDGET(), rest = { Notes: { A1: "Assumptions" } }) => xlsxBytes({ Budget: budget, ...rest });
const set = (changes, cells = BUDGET()) => {
  const out = { ...cells };
  for (const [ref, v] of Object.entries(changes)) v === null ? delete out[ref] : (out[ref] = v);
  return out;
};
/** the cells as a spreadsheet library that does not rewrite formulas leaves them after inserting an empty row at `at` (1-based) */
const rowInserted = (cells, at) => Object.fromEntries(Object.entries(cells).map(([ref, v]) => [ref.replace(/\d+$/, (n) => (Number(n) >= at ? Number(n) + 1 : n)), v]));
const colInserted = (cells, at) => Object.fromEntries(Object.entries(cells).map(([ref, v]) => [ref.replace(/^[A-Z]+/, (l) => (l >= at ? String.fromCharCode(l.charCodeAt(0) + 1) : l)), v]));
const read = (bytes, sheet = "Budget") => {
  const wb = parseWorkbook(bytes);
  const out = {};
  for (const c of wb.sheetCells(wb.sheets.find((s) => s.name === sheet)).cells.values()) out[`${String.fromCharCode(65 + c.c)}${c.r + 1}`] = c.text;
  return out;
};
/** the agent changes `from` with checked ops: its bytes, and the record the server keeps of that write (src/session.js) */
const viaOps = async (from, ops) => {
  const r = await runOps({ bytes: from, format: "xlsx", name: "t.xlsx", ops });
  assert.ok(r.bytes, `the agent's ops apply: ${JSON.stringify(r.results)}`);
  return { theirs: r.bytes, agent: [{ route: "apply", from, to: r.bytes, ops, partial: false, anchors: [] }] };
};
const textOf = (bytes, sheet, ref) => {
  const wb = parseWorkbook(bytes);
  const [, col, row] = /^([A-Z])(\d+)$/.exec(ref);
  return wb.sheetCells(wb.sheets.find((s) => s.name === sheet)).cells.get((Number(row) - 1) * 16384 + col.charCodeAt(0) - 65)?.text ?? "";
};
/** the agent sets cells with `set_cells` ops ({A1: value}), `expect` read from the file as apply does */
const sets = (from, changes, sheet = "Budget") => viaOps(from, Object.entries(changes).map(([range, values]) => ({ op: "set_cells", target: { sheet, range }, expect: { quote: textOf(from, sheet, range) }, values })));
/** `change` is the agent's bytes alone (no record: a commit) or {theirs, agent} from `viaOps` */
const merge = (mine, change, extra = {}) => mergeXlsx({ base: book(), mine, name: "t.xlsx", runOps, ...(Buffer.isBuffer(change) ? { theirs: change } : change), ...extra });
const moved = (a, b) => sheetMoved(parseWorkbook(xlsxBytes({ S: a })).sheetCells({ index: 0, part: "xl/worksheets/sheet1.xml" }), parseWorkbook(xlsxBytes({ S: b })).sheetCells({ index: 0, part: "xl/worksheets/sheet1.xml" }));

test("the user and the agent change different cells, on different rows: both values are in the result; a formula only where the agent changed nothing", async () => {
  const r = await merge(book(set({ B3: 4242, D5: "=B5*C5", A12: "A new row", C2: null })), await sets(book(), { C7: 1400, A8: "Renamed by the agent" }));
  assert.equal(r.merged, 3);
  assert.deepEqual(r.unplaced.map((u) => [u.label, u.text]), [["Budget!D5", "=B5*C5"]], "the agent set cells, so a formula may point at a row that holds other content now");
  assert.equal(r.copy, false);
  const out = read(r.bytes);
  assert.deepEqual({ B3: out.B3, D5: out.D5, A12: out.A12, C2: out.C2 }, { B3: "4242", D5: "=B5+C5", A12: "A new row", C2: undefined }, "the user's cells, the emptied one too; D5 keeps the agent's formula");
  assert.deepEqual({ C7: out.C7, A8: out.A8 }, { C7: "1400", A8: "Renamed by the agent" }, "the agent's cells");
  assert.equal(out.D3, "=B3+C3", "an untouched formula is still a formula");
});

test("the user's number 33.333333333333336 is carried over when the agent edits another row", async () => {
  const r = await merge(book(set({ B3: 33.333333333333336 })), await sets(book(), { C7: 1400 }));
  assert.equal(r.merged, 1);
  assert.deepEqual(r.unplaced, []);
  assert.equal(read(r.bytes).B3, "33.333333333333336");
});

test("both change the same cell: the agent's value stays and the user's value is handed back, never dropped", async () => {
  const r = await merge(book(set({ B3: 4242 })), await sets(book(), { B3: 77 }));
  assert.equal(r.bytes, null, "nothing is written when nothing could be carried");
  assert.equal(r.merged, 0);
  assert.deepEqual(r.unplaced, [{ label: "Budget!B3", text: "4242", why: "The agent changed Budget!B3 too. Its value is in the sheet; this is yours.", of: ["c1 Budget!32769"] }]);
});

test("one cell in conflict does not stop the others; a cell both set to the same value is not a conflict", async () => {
  const r = await merge(book(set({ B3: 4242, B4: 5, C6: 9 })), await sets(book(), { B3: 77, C6: 9 }));
  assert.equal(r.merged, 1);
  assert.equal(r.unplaced.length, 1);
  assert.deepEqual({ B3: read(r.bytes).B3, B4: read(r.bytes).B4, C6: read(r.bytes).C6 }, { B3: "77", B4: "5", C6: "9" });
});

test("a cell the user emptied that the agent changed is kept and reported; a formula the agent rewrote is not overwritten", async () => {
  const r = await merge(book(set({ C4: null, D6: 1 })), await sets(book(), { C4: 401, D6: "=B6-C6" }));
  assert.equal(r.bytes, null);
  assert.deepEqual(r.unplaced.map((u) => [u.text, u.why]), [
    ["", "You emptied Budget!C4, but the agent changed it, so it was kept."],
    ["1", "The agent changed Budget!D6 too. Its value is in the sheet; this is yours."],
  ]);
});

test("the user changed nothing: nothing to write", async () => {
  const r = await merge(book(), await sets(book(), { C7: 1400 }));
  assert.deepEqual({ bytes: r.bytes, merged: r.merged, unplaced: r.unplaced, copy: r.copy }, { bytes: null, merged: 0, unplaced: [], copy: false });
});

const INSERT_AT_4 = { op: "insert_rows", target: { sheet: "Budget", at: 4 }, expect: { quote: "Line 4\t40\t400\t=B4+C4" } };

test("the agent inserted a row with apply: the whole sheet is handed back with a copy, the user's values are listed, other sheets still merge", async () => {
  const mine = xlsxBytes({ Budget: set({ B8: 4242, F8: "typed in an empty cell" }), Notes: { A1: "Assumptions", A2: "Mine" } });
  const change = await viaOps(book(), [INSERT_AT_4]);
  const r = await merge(mine, change);
  assert.equal(r.copy, true, "the list stands for the sheet: the caller keeps the user's file");
  assert.equal(r.unplaced.length, 1);
  assert.match(r.unplaced[0].why, /^The agent added, removed or moved rows or columns on the sheet "Budget"/);
  assert.equal(r.unplaced[0].text, "B8: 4242\nF8: typed in an empty cell");
  assert.equal(r.merged, 1, "the other sheet is merged");
  assert.equal(read(r.bytes, "Notes").A2, "Mine");
  assert.deepEqual(read(r.bytes), read(change.theirs), "the agent's sheet is as the agent left it");
  assert.deepEqual(r.stable, ["Notes"], "a second pass may merge by address on the other sheet only");
});

test("a shift is seen where every row reads the same, and where the engine rewrote the formulas of the rows it moved", async () => {
  const same = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`A${i + 1}`, 0]));
  assert.equal(moved(same, rowInserted(same, 5)), true, "identical rows: one is gone from the middle and one appeared at the end");
  assert.equal(moved(same, { ...same, A11: 0 }), true, "a new row that repeats an old one may be an insert");
  assert.equal(moved(same, Object.fromEntries(Object.entries(same).slice(0, 9))), true, "a row that is gone and has a twin may be a delete");
  const change = await viaOps(book(), [INSERT_AT_4]);
  assert.equal(read(change.theirs).D5, "=B5+C5", "the engine moved the row and rewrote its formula");
  assert.equal(moved(BUDGET(), Object.fromEntries(Object.entries(read(change.theirs)).map(([k, v]) => [k, /^\d+$/.test(v) ? Number(v) : v]))), true);
  const r = await merge(book(set({ B8: 4242 })), change);
  assert.equal(r.bytes, null);
  assert.match(r.unplaced[0].why, /The agent added, removed or moved rows or columns/);
  assert.equal(moved(BUDGET(), colInserted(BUDGET(), "B")), true, "a column inserted");
  assert.equal(moved(BUDGET(), set({ B3: 1, C3: 2, A5: "x", D9: 7, F2: "new", A12: "more" })), false, "plain cell edits are not a shift");
  assert.equal(moved(BUDGET(), set({ B3: 30, A12: "Line 3", B12: 30, C12: 300, D12: "=B12+C12" })), true, "a new row that repeats an old one");
});

test("a row inserted while the rows below it are renumbered, written without a record: handed back, never placed one row off", async () => {
  const numbered = (cells) => Object.fromEntries(Object.entries(cells).flatMap(([ref, v]) => (ref.startsWith("A") && ref !== "A1" ? [[ref, v], [`G${ref.slice(1)}`, Number(ref.slice(1)) - 1]] : [[ref, v]])));
  const base = numbered(BUDGET());
  // the agent inserts a row at 4 and renumbers column G below it: no row reads exactly as it did
  const theirs = numbered(rowInserted(BUDGET(), 4));
  assert.equal(theirs.G6, 5, "the row that was row 5 (number 4) is row 6 and renumbered");
  assert.equal(moved(base, theirs), true);
  const r = await mergeXlsx({ base: book(base), mine: book({ ...base, F8: "typed in an empty cell" }), theirs: book(theirs), name: "t.xlsx", runOps });
  assert.equal(r.bytes, null, "nothing is placed by address");
  assert.equal(r.copy, true);
  assert.equal(r.unplaced[0].text, "F8: typed in an empty cell");
  // one cell edited in each of two rows that share most of their cells is still two edits, not a move
  const alike = { A1: "open", B1: "Ana", C1: 1, D1: "x", A2: "open", B2: "Ana", C2: 2, D2: "y", A3: "open", B3: "Ana", C3: 3, D3: "z" };
  assert.equal(moved(alike, { ...alike, D1: "changed", D2: "changed too" }), false);
});

test("a carried value keeps the number format of its cell; every other cell keeps its own", { skip: !fs.existsSync(SAMPLE) && "engine samples not found" }, async () => {
  const base = fs.readFileSync(SAMPLE);
  const fmtOf = (bytes, r, c) => {
    const wb = parseWorkbook(bytes);
    const cell = wb.sheetCells(wb.sheets[0]).cells.get(r * 16384 + c);
    return [cell.text, wb.numberFormat(cell.s)];
  };
  assert.deepEqual(fmtOf(base, 2, 5), ["0.0842", "0.0%"]);
  const typed = (range, was, values) => runOps({ bytes: base, format: "xlsx", name: "t.xlsx", ops: [{ op: "set_cells", target: { sheet: "Sales", range }, expect: { quote: was }, values }] });
  const mine = (await typed("F3", "0.0842", 0.5)).bytes; // the user types into a percent cell, in the engine, as the page does
  const r = await mergeXlsx({ base, mine, name: "t.xlsx", runOps, ...(await viaOps(base, [{ op: "set_cells", target: { sheet: "Sales", range: "C4" }, expect: { quote: "261" }, values: 200 }])) });
  assert.deepEqual({ merged: r.merged, unplaced: r.unplaced }, { merged: 1, unplaced: [] }, "the engine's own save adds no differences: exactly one cell is carried");
  assert.deepEqual(fmtOf(r.bytes, 2, 5), ["0.5", "0.0%"]);
  assert.deepEqual(fmtOf(r.bytes, 3, 2), ["200", "General"]);
  assert.deepEqual(fmtOf(r.bytes, 2, 3), ["21.2", '"$"#,##0.00']);
});

test("the user inserted a row (the page says so, or the cells show it): not carried, the cells that differ are listed", async () => {
  const theirs = await sets(book(), { C7: 1400 });
  const byCells = await merge(book(rowInserted(BUDGET(), 4)), theirs);
  assert.equal(byCells.bytes, null);
  assert.equal(byCells.copy, true);
  assert.match(byCells.unplaced[0].why, /^You added, removed or moved rows or columns on the sheet "Budget"\. That is not carried over\./);
  assert.match(byCells.unplaced[0].text, /^A4: \(emptied\)\n/);
  const bySaying = await merge(book(set({ B3: 4242 })), theirs, { edits: [{ kind: "cell", sheet: "Budget" }, { kind: "sheet.insertRows", sheet: "Budget" }] });
  assert.equal(bySaying.bytes, null, "a cell edit on a sheet whose rows the user moved is not placed by its address");
  assert.equal(bySaying.unplaced[0].text, "B3: 4242");
});

test("sheets: the agent adds one (the rest still merges), renames one the user edited (conflict), the user adds one (reported)", async () => {
  const added = await merge(book(set({ B3: 4242 })), xlsxBytes({ Budget: BUDGET(), Notes: { A1: "Assumptions" }, Extra: { A1: "new" } }));
  assert.equal(added.merged, 1);
  assert.deepEqual(added.unplaced, []);
  assert.equal(read(added.bytes).B3, "4242");
  assert.equal(read(added.bytes, "Extra").A1, "new");
  const renamed = await merge(book(set({ B3: 4242 })), xlsxBytes({ "Budget 2026": BUDGET(), Notes: { A1: "Assumptions" } }));
  assert.equal(renamed.bytes, null);
  assert.equal(renamed.copy, true);
  assert.deepEqual(renamed.unplaced.map((u) => [u.text, u.why]), [["B3: 4242", 'The agent removed or renamed the sheet "Budget", so your edits there were not carried over. These are yours.']]);
  const mine = await merge(xlsxBytes({ Budget: BUDGET(), Notes: { A1: "Assumptions" }, Mine: { A1: "x" } }), book(set({ C7: 1400 })));
  assert.equal(mine.bytes, null);
  assert.equal(mine.copy, true);
  assert.match(mine.unplaced[0].why, /You added or renamed the sheet "Mine"/);
});

test("a cell that takes its formula from a shared group is not an edit when only its result changed", async () => {
  const cells = (d3) => set({ D3: { shared: d3 } });
  const r = await mergeXlsx({ base: book(cells(330)), mine: book(set({ B4: 5 }, cells(999))), name: "t.xlsx", runOps, ...(await sets(book(cells(330)), { C7: 1400 })) });
  assert.equal(r.merged, 1, "only B4 is carried");
  assert.deepEqual(r.unplaced, []);
  assert.equal(read(r.bytes).B4, "5");
});

test("a value the engine reads differently than the file says is handed back; the agent's cell stays and the rest is merged", async () => {
  const r = await merge(book(set({ F2: "007", B4: 5 })), await sets(book(), { C7: 1400 }));
  assert.equal(r.merged, 1);
  assert.deepEqual(r.unplaced, [{ label: "Budget!F2", text: "007", why: "Your value for Budget!F2 could not be placed on the agent's version.", of: ["c1 Budget!16389"] }]);
  const out = read(r.bytes);
  assert.deepEqual({ F2: out.F2, B4: out.B4, C7: out.C7 }, { F2: undefined, B4: "5", C7: "1400" });
});

test("content the engine refuses to change, a blocked package check, a result that changes the agent's cells: nothing is written", async () => {
  const mine = book(set({ B3: 4242, B4: 5 }));
  const theirs = xlsxBytes({ Budget: BUDGET(), Notes: { A1: "Assumptions", B2: 1400 } }); // the agent left Budget as it was
  const stub = (answer) => mergeXlsx({ base: book(), mine, theirs, name: "t.xlsx", runOps: async ({ ops }) => answer(ops) });
  const refused = await stub((ops) => ({ results: ops.map((op, index) => ({ index, op: op.op, status: "refused", code: "xlsx-protected", reason: "the sheet is protected" })), bytes: null, warnings: [], blocked: null }));
  assert.equal(refused.bytes, null);
  assert.deepEqual(refused.unplaced.map((u) => [u.text, u.why]), [["4242", "Your value for Budget!B3 could not be placed on the agent's version."], ["5", "Your value for Budget!B4 could not be placed on the agent's version."]]);
  const blocked = await stub((ops) => ({ results: ops.map((op, index) => ({ index, op: op.op, status: "not_applied" })), bytes: null, warnings: [], blocked: [{ code: "part_removed" }] }));
  assert.equal(blocked.bytes, null);
  assert.equal(blocked.unplaced.length, 2);
  assert.match(blocked.unplaced[0].why, /would have damaged the file/);
  // an engine that writes the carried cells and also loses one of the agent's
  const lossy = await stub((ops) => ({ results: ops.map((op, index) => ({ index, op: op.op, status: "applied" })), bytes: book(set({ B3: 4242, B4: 5 })), warnings: [], blocked: null }));
  assert.equal(lossy.bytes, null, "the agent's Notes!B2 is gone from the result: it is not written");
  assert.deepEqual(lossy.unplaced.map((u) => u.text), ["4242", "5"]);
  assert.match(lossy.unplaced[0].why, /would have changed the agent's values/);
  // one op does not apply (the cell is not what `expect` says): the other is written, this one is handed back
  const real = await mergeXlsx({ base: book(), mine, theirs, name: "t.xlsx", runOps: (a) => runOps({ ...a, ops: a.ops.map((op, i) => (i ? op : { ...op, expect: { text_hash: "0".repeat(16) } })) }) });
  assert.equal(real.merged, 1);
  assert.equal(read(real.bytes).B3, "30");
  assert.deepEqual(real.unplaced.map((u) => u.text), ["4242"]);
});

test("formatting, sizes and sheet changes the page names are reported as not carried over; they never stop the cells", async () => {
  const r = await merge(book(set({ B3: 4242 })), await sets(book(), { C7: 1400 }), { edits: [{ kind: "cell", sheet: "Budget" }, { kind: "format", sheet: "Budget" }, { kind: "format", sheet: "Budget" }, { kind: "sheet.colWidth", sheet: "Notes" }, { kind: "book.move", sheet: "Notes" }, { kind: "undo", sheet: "Budget" }] });
  assert.equal(r.merged, 1);
  assert.equal(r.copy, false);
  assert.deepEqual(r.unplaced.map((u) => u.why), [
    "You moved, hid or changed sheets. Sheet changes are not carried over.",
    'You changed formatting on the sheet "Budget". Formatting is not carried over.',
    'You changed row or column sizes, hidden rows or columns, or the frozen panes on the sheet "Notes". That is not carried over.',
  ]);
  assert.ok(r.unplaced.every((u) => u.text === ""));
});

test("more changed cells than one merge carries: the sheet is handed back whole", () => {
  const many = Object.fromEntries(Array.from({ length: 2001 }, (_, i) => [`H${i + 1}`, i + 1]));
  const wb = (cells) => parseWorkbook(book(cells));
  const plan = planXlsxMerge(wb(BUDGET()), wb({ ...BUDGET(), ...many }), wb(BUDGET()));
  assert.equal(plan.items.length, 0);
  assert.equal(plan.copy, true);
  assert.match(plan.unplaced[0].why, /You changed more than 2000 cells/);
  assert.ok(plan.unplaced[0].text.length <= 2003 && plan.unplaced[0].text.startsWith("H1: 1\nH2: 2\n"));
});

test("the session merge reads the server's record of the run: apply merges, a second pass builds on the first, a moving op, a commit, a direct save and a record that does not match the bytes hand back", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "os-merge-x-"));
  process.env.ONIONSKIN_STATE_DIR = path.join(root, "st");
  try {
    const { Sessions } = await import("../src/session.js");
    const { ensureStateDir } = await import("../src/paths.js");
    const { sha256 } = await import("../src/fsutil.js");
    ensureStateDir();
    const file = path.join(root, "b.xlsx");
    fs.writeFileSync(file, book());
    const S = new Sessions();
    const s = S.open(file);
    const disk = () => fs.readFileSync(file);
    /** one agent run: Send, the agent writes, done */
    const run = async (write) => {
      const poll = S.poll(s.key);
      S.send(s.key, { baseSha: s.baseSha, comments: [], note: "go" });
      const batch = await poll.promise;
      await write({ holder: "agent", token: batch.lease.token, batchId: batch.batch_id });
      S.done(s.key, { summary: "Done.", results: [] });
    };
    const engine = async (bytes, ops) => (await runOps({ bytes, format: "xlsx", name: "b.xlsx", ops })).bytes;
    const apply = (ops, bytes = null) => run(async (claim) => S.agentWrite(s.key, { baseSha: sha256(disk()), bytes: bytes || (await engine(disk(), ops)), route: "apply", ops, ...claim }));
    const setOp = (range, values, from = disk()) => ({ op: "set_cells", target: { sheet: "Budget", range }, expect: { quote: textOf(from, "Budget", range) }, values });
    const insertOp = (at, from = disk()) => ({ op: "insert_rows", target: { sheet: "Budget", at }, expect: { quote: ["A", "B", "C", "D"].map((c) => textOf(from, "Budget", `${c}${at}`)).join("\t") } });
    /** the page's version: what it loaded plus the user's typing (the page saves through the same engine) */
    const typed = (from, changes) => engine(from, Object.entries(changes).map(([range, v]) => setOp(range, v, from)));
    const copies = () => fs.readdirSync(root).filter((n) => n.endsWith(".xlsx") && n !== "b.xlsx");

    // 1. the agent sets a cell through apply: the user's cell is carried
    const loaded = disk();
    await apply([setOp("C7", 1400)]);
    const mine = await typed(loaded, { B3: 4242 });
    const ok = await S.mergeUserEdits(s.key, { baseSha: sha256(loaded), bytes: mine, edits: [{ kind: "cell", sheet: "Budget" }] });
    assert.deepEqual({ merged: ok.merged, unplaced: ok.unplaced, copy_name: ok.copy_name, same: ok.same }, { merged: 1, unplaced: [], copy_name: null, same: false });
    assert.equal(ok.sha, sha256(disk()));
    assert.equal(s.baseSha, ok.sha);
    assert.deepEqual([read(disk()).B3, read(disk()).C7], ["4242", "1400"]);
    // 2. typed during that merge: the second pass starts from the page's version and finds the first pass's record
    const ok2 = await S.mergeUserEdits(s.key, { baseSha: ok.mineSha, bytes: await typed(mine, { B4: 5 }) });
    assert.deepEqual([ok2.merged, ok2.unplaced], [1, []]);
    assert.deepEqual([read(disk()).B3, read(disk()).B4, read(disk()).C7], ["4242", "5", "1400"]);
    assert.deepEqual(copies(), [], "no copy when everything was carried");

    // 3. the agent inserts a row through apply: the sheet is handed back with a copy of the user's file, the agent's file is untouched
    let before = disk();
    await apply([insertOp(4)]);
    let afterAgent = disk();
    let mineNow = await typed(before, { B8: 555 });
    const moved = await S.mergeUserEdits(s.key, { baseSha: sha256(before), bytes: mineNow });
    assert.equal(moved.merged, 0);
    assert.equal(moved.unplaced[0].text, "B8: 555");
    assert.match(moved.unplaced[0].why, /^The agent added, removed or moved rows or columns on the sheet "Budget"/);
    assert.match(moved.copy_name, /^b \(Onionskin copy .*\)\.xlsx$/);
    assert.ok(fs.readFileSync(path.join(root, moved.copy_name)).equals(mineNow), "the copy is the user's file");
    assert.ok(disk().equals(afterAgent), "the agent's file was not touched");

    // 4. the agent changes one cell through commit (a file made with another tool): the server cannot name what changed
    before = disk();
    const committed = await engine(before, [setOp("C2", 1)]);
    await run((claim) => S.agentWrite(s.key, { baseSha: null, bytes: committed, label: "before agent commit", ...claim }));
    mineNow = await typed(before, { F2: "note" });
    const viaCommit = await S.mergeUserEdits(s.key, { baseSha: sha256(before), bytes: mineNow });
    assert.equal(viaCommit.merged, 0);
    assert.deepEqual(viaCommit.unplaced.map((u) => [u.text, u.why]), [["F2: note", 'The agent changed the sheet "Budget" in a way Onionskin cannot check cell by cell, so your edits there were not carried over. These are yours.']]);
    assert.ok(viaCommit.copy_name, "the user's file is kept");
    assert.ok(disk().equals(committed));

    // 5. the agent saves the file directly (no route at all)
    before = disk();
    await run(async () => fs.writeFileSync(file, await engine(before, [setOp("C3", 2)])));
    const direct = await S.mergeUserEdits(s.key, { baseSha: sha256(before), bytes: await typed(before, { F3: "note" }) });
    assert.deepEqual([direct.merged, direct.unplaced[0].text], [0, "F3: note"]);
    assert.match(direct.unplaced[0].why, /cannot check cell by cell/);

    // 6. apply's record names one op, but the bytes it sent have a row inserted: the record is checked, not believed
    before = disk();
    const forged = await engine(before, [insertOp(2, before)]);
    await apply([setOp("C4", 3)], forged);
    const lie = await S.mergeUserEdits(s.key, { baseSha: sha256(before), bytes: await typed(before, { F4: "note" }) });
    assert.deepEqual([lie.merged, lie.unplaced[0].text], [0, "F4: note"]);
    assert.match(lie.unplaced[0].why, /cannot check cell by cell/);
    assert.ok(disk().equals(forged));

    // 7. a Send that writes the user's own edits starts the run: the page's base is the sent version, and the record starts there
    const sent = await typed(disk(), { E2: "sent with the batch" });
    const poll = S.poll(s.key);
    S.send(s.key, { baseSha: s.baseSha, bytes: sent, comments: [], note: "go" });
    const batch = await poll.promise;
    assert.equal(s.baseSha, sha256(sent), "what the page loads as its base after Send");
    const afterSend = s.baseSha;
    S.agentWrite(s.key, { baseSha: afterSend, bytes: await engine(sent, [setOp("C7", 4, sent)]), route: "apply", ops: [setOp("C7", 4, sent)], holder: "agent", token: batch.lease.token, batchId: batch.batch_id });
    S.done(s.key, { summary: "Done.", results: [] });
    const fromSent = await S.mergeUserEdits(s.key, { baseSha: afterSend, bytes: await typed(sent, { F8: "typed during the run" }) });
    assert.deepEqual([fromSent.merged, fromSent.unplaced], [1, []]);
    assert.deepEqual([read(disk()).E2, read(disk()).F8, read(disk()).C7], ["sent with the batch", "typed during the run", "4"]);

    // more conflicts than the page lists: the user's file is kept too
    const six = ["B2", "B3", "B4", "B5", "B6", "B7"];
    before = disk();
    await apply(six.map((ref) => setOp(ref, 2)));
    const many = await S.mergeUserEdits(s.key, { baseSha: sha256(before), bytes: await typed(before, Object.fromEntries(six.map((ref) => [ref, 1]))) });
    assert.equal(many.unplaced.length, 6);
    assert.ok(many.unplaced.every((u) => /^The agent changed Budget!B\d too/.test(u.why)));
    assert.match(many.copy_name, /^b \(Onionskin copy/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---- the rule, branch by branch: nothing is placed by address unless the record shows the addresses held ----------------------
const S8 = () => Object.assign({}, ...Array.from({ length: 8 }, (_, i) => ({ [`A${i + 1}`]: i + 1, [`B${i + 1}`]: `Item ${i + 1}` })));
/** what the agent leaves when it inserts a row at 3, renumbers column A and rewrites every other cell below: no row reads as it did */
const RESIDUAL = () => {
  const out = {};
  for (let r = 1; r <= 9; r++) out[`A${r}`] = r;
  Object.assign(out, { B1: "Item 1", B2: "Item 2", B3: "New item" });
  for (let r = 4; r <= 9; r++) out[`B${r}`] = `Thing ${r - 1}`;
  return out;
};
const NOTE = "call vendor about Item 5";
const mergeS = (mine, change) => mergeXlsx({ base: xlsxBytes({ S: S8() }), mine: xlsxBytes({ S: mine }), name: "t.xlsx", runOps, ...(Buffer.isBuffer(change) ? { theirs: change } : change) });
const wholeSheet = (r, why) => {
  assert.equal(r.bytes, null, "nothing is written");
  assert.equal(r.merged, 0);
  assert.equal(r.copy, true, "the caller keeps the user's file");
  assert.deepEqual(r.unplaced.map((u) => [u.label, u.text]), [['Sheet "S"', `E5: ${NOTE}`]]);
  assert.match(r.unplaced[0].why, why);
};
/** set_cells ops that turn sheet S of `from` into `cells` (one op per cell that differs) */
const rewriteOps = (from, cells) => {
  const wb = parseWorkbook(from);
  const now = {};
  for (const c of wb.sheetCells(wb.sheets[0]).cells.values()) now[`${String.fromCharCode(65 + c.c)}${c.r + 1}`] = c.text;
  return Object.entries(cells).filter(([ref, v]) => now[ref] !== String(v)).map(([range, values]) => ({ op: "set_cells", target: { sheet: "S", range }, expect: { quote: now[range] ?? "" }, values }));
};
const chain = (...changes) => ({ theirs: changes.at(-1).theirs, agent: changes.flatMap((c) => c.agent) });

test("the agent inserts a row, renumbers a number column and rewrites the other cells, through commit: the note is handed back, never written beside another row", async () => {
  const theirs = xlsxBytes({ S: RESIDUAL() });
  assert.equal(sheetMoved(parseWorkbook(xlsxBytes({ S: S8() })).sheetCells({ index: 0, part: "xl/worksheets/sheet1.xml" }), parseWorkbook(theirs).sheetCells({ index: 0, part: "xl/worksheets/sheet1.xml" })), false, "the cells do not show the shift: only the record can");
  wholeSheet(await mergeS({ ...S8(), E5: NOTE }, theirs), /cannot check cell by cell/);
});

test("the same change through apply (an insert, then cells set): the insert is on record, so the sheet is handed back", async () => {
  const base = xlsxBytes({ S: S8() });
  const inserted = await viaOps(base, [{ op: "insert_rows", target: { sheet: "S", at: 3 }, expect: { quote: "3\tItem 3" } }]);
  const rewritten = await viaOps(inserted.theirs, rewriteOps(inserted.theirs, RESIDUAL()));
  assert.deepEqual(read(rewritten.theirs, "S"), Object.fromEntries(Object.entries(RESIDUAL()).map(([k, v]) => [k, String(v)])));
  wholeSheet(await mergeS({ ...S8(), E5: NOTE }, chain(inserted, rewritten)), /^The agent added, removed or moved rows or columns on the sheet "S"/);
});

// A row the agent changed any cell of may hold another row's content now (a shift rebuilt with `set_cells` keeps every address, so the
// record cannot show it): a value of the user's on that row is handed back. Only a row the agent left exactly as it was is merged.
const sameRow = (r, label, text) => {
  const u = r.unplaced.find((x) => x.label === label);
  assert.ok(u, `${label} is handed back: ${JSON.stringify(r.unplaced)}`);
  assert.equal(u.text, text, "with the whole value");
  assert.match(u.why, /The agent changed other cells in the same row/);
};
test("the agent only sets cells, rebuilding the shift above with set_cells: the record shows no address moved, but the note's row was rewritten, so it is handed back", async () => {
  const base = xlsxBytes({ S: S8() });
  const change = await viaOps(base, rewriteOps(base, RESIDUAL()));
  const r = await mergeS({ ...S8(), E5: NOTE }, change);
  assert.equal(r.bytes, null, "nothing is written");
  assert.equal(r.merged, 0);
  sameRow(r, "S!E5", NOTE);
});

test("the same set_cells rebuild with a column every row shares (only one cell in three changes per row): a note and a changed status on a rewritten row are handed back", async () => {
  const base = {};
  for (let r = 1; r <= 8; r++) Object.assign(base, { [`A${r}`]: r, [`B${r}`]: `Item ${r}`, [`C${r}`]: "Open" });
  const theirs = {};
  for (let r = 1; r <= 9; r++) Object.assign(theirs, { [`A${r}`]: r, [`C${r}`]: "Open" });
  Object.assign(theirs, { B1: "Item 1", B2: "Item 2", B3: "New item" });
  for (let r = 4; r <= 9; r++) theirs[`B${r}`] = `Thing ${r - 1}`;
  const r = await mergeCells(base, { ...base, E5: NOTE, C6: "Closed", E1: "beside a row the agent left as it was" }, theirs);
  sameRow(r, "S!E5", NOTE);
  sameRow(r, "S!C6", "Closed");
  assert.deepEqual([r.merged, read(r.bytes, "S").E1, read(r.bytes, "S").C6], [1, "beside a row the agent left as it was", "Open"]);
});

test("a formula the user typed is handed back once the agent changed any cell, on any sheet: it may point at a row that now holds other content", async () => {
  const two = (s, n) => xlsxBytes({ S: s, Notes: n });
  const from = two(S8(), { A1: "x" });
  const change = await viaOps(from, rewriteOps(from, RESIDUAL()));
  const r = await mergeXlsx({ base: from, mine: two(S8(), { A1: "x", A2: "=S!B5", A3: "plain text" }), name: "t.xlsx", runOps, ...change });
  assert.deepEqual(r.unplaced.map((u) => [u.label, u.text]), [["Notes!A2", "=S!B5"]]);
  assert.match(r.unplaced[0].why, /your formula for Notes!A2 may point at other cells now/);
  assert.deepEqual([r.merged, read(r.bytes, "Notes").A3], [1, "plain text"]);
});

test("the record says only cells were set, but the cells look like rows moved: the tripwire hands the sheet back", async () => {
  const base = xlsxBytes({ S: S8() });
  const looks = { ...rowInserted(S8(), 3), A3: "", B3: "" };
  const change = await viaOps(base, rewriteOps(base, looks));
  wholeSheet(await mergeS({ ...S8(), E5: NOTE }, change), /^The agent's changes on the sheet "S" look like rows or columns moved/);
});

test("no record, a record of a route that names no ops, a record that does not reproduce the bytes: handed back; a sheet the agent left as it was is still merged", async () => {
  const base = xlsxBytes({ S: S8() });
  const calm = await viaOps(base, [{ op: "set_cells", target: { sheet: "S", range: "B8" }, expect: { quote: "Item 8" }, values: "Renamed" }]);
  wholeSheet(await mergeS({ ...S8(), E5: NOTE }, calm.theirs), /cannot check cell by cell/);
  wholeSheet(await mergeS({ ...S8(), E5: NOTE }, { theirs: calm.theirs, agent: [{ route: "commit", from: base, to: calm.theirs }] }), /cannot check cell by cell/);
  const inserted = await runOps({ bytes: base, format: "xlsx", name: "t.xlsx", ops: [{ op: "insert_rows", target: { sheet: "S", at: 3 }, expect: { quote: "3\tItem 3" } }] });
  wholeSheet(await mergeS({ ...S8(), E5: NOTE }, { theirs: inserted.bytes, agent: [{ ...calm.agent[0], to: inserted.bytes }] }), /cannot check cell by cell|look like rows or columns moved/);
  // the agent wrote only the other sheet, through commit: the user's values on the sheet it left alone are carried; a formula is not
  const two = (s, notes) => xlsxBytes({ S: s, Notes: notes });
  const r = await mergeXlsx({ base: two(S8(), { A1: "x" }), mine: two({ ...S8(), E5: NOTE, F5: "=A5*2" }, { A1: "x" }), theirs: two(S8(), { A1: "rewritten" }), name: "t.xlsx", runOps });
  assert.equal(r.merged, 1);
  assert.equal(read(r.bytes, "S").E5, NOTE);
  assert.deepEqual(r.unplaced.map((u) => u.label), ["S!F5"], "a formula may point at the sheet the server cannot account for");
  assert.match(r.unplaced[0].why, /your formula for S!F5 may point at other cells now/);
});

test("ops that name their cell by anchor are checked with the anchors of the delivered batch", async () => {
  const base = book();
  const ops = [{ op: "set_cells", target: { anchor_id: "a1" }, expect: { quote: "700" }, values: 1400 }];
  const anchors = [{ id: "a1", locator: { sheet: "Budget", range: "C7" } }];
  const theirs = (await runOps({ bytes: base, format: "xlsx", name: "t.xlsx", ops, anchors: new Map(anchors.map((a) => [a.id, a])) })).bytes;
  const record = { route: "apply", from: base, to: theirs, ops, partial: false };
  const ok = await merge(book(set({ B3: 4242 })), { theirs, agent: [{ ...record, anchors }] });
  assert.deepEqual([ok.merged, ok.unplaced], [1, []]);
  const lost = await merge(book(set({ B3: 4242 })), { theirs, agent: [{ ...record, anchors: [] }] });
  assert.equal(lost.merged, 0, "without the anchors the ops do not reproduce the file");
});

test("agentChanges: the worst of every step counts; a merge pass speaks only for the sheets it kept", async () => {
  const base = book();
  const cells = await sets(base, { C7: 1 });
  const rows = await viaOps(cells.theirs, [{ op: "insert_rows", target: { sheet: "budget", at: 2 }, expect: { quote: "Line 2\t20\t200\t=B2+C2" } }]);
  const facts = await agentChanges([...cells.agent, ...rows.agent], { runOps, name: "t.xlsx" });
  assert.deepEqual([facts.of("Budget"), facts.of("Notes")], ["moved", "stable"], "a sheet named in another case is the same sheet");
  const pass = await agentChanges([{ route: "merge", stable: ["Notes"] }], { runOps, name: "t.xlsx" });
  assert.deepEqual([pass.of("Budget"), pass.of("Notes")], ["unknown", "stable"]);
  assert.equal((await agentChanges(null, { runOps, name: "t.xlsx" })).of("Budget"), "unknown");
  const renamed = await viaOps(base, [{ op: "rename_sheet", target: { sheet: "Notes" }, expect: { quote: "Notes" }, new_name: "Notes 2" }]);
  assert.equal((await agentChanges(renamed.agent, { runOps, name: "t.xlsx" })).of("Notes"), "moved");
});

test("a formula the user typed is carried only when the agent left every sheet as it was", async () => {
  const notes = { A1: "Assumptions" };
  const two = (s, n = notes) => xlsxBytes({ S: s, Notes: n });
  const run = (mine, change) => mergeXlsx({ base: two(S8()), mine, name: "t.xlsx", runOps, ...change });
  // the agent changed only the sheet the formula is on, and not the cells it points at: carried
  const calm = await run(two(S8(), { ...notes, A2: "=S!B5" }), await viaOps(two(S8()), [{ op: "set_cells", target: { sheet: "Notes", range: "A1" }, expect: { quote: "Assumptions" }, values: "Rewritten" }]));
  assert.deepEqual(calm.unplaced.map((u) => u.label), ["Notes!A2"], "a set cell on any sheet may be another row's content now");
  // the agent changed nothing: carried
  const idle = await mergeXlsx({ base: two(S8()), mine: two(S8(), { ...notes, A2: "=S!B5" }), theirs: two(S8()), name: "t.xlsx", runOps });
  assert.deepEqual([idle.merged, idle.unplaced, read(idle.bytes, "Notes").A2], [1, [], "=S!B5"]);
  // the agent inserted a row on S: the formula on Notes may point at another row now; a plain value there is still carried
  const shifted = await run(two(S8(), { ...notes, A2: "=S!B5", A3: "plain text" }), await viaOps(two(S8()), [{ op: "insert_rows", target: { sheet: "S", at: 3 }, expect: { quote: "3\tItem 3" } }]));
  assert.deepEqual(shifted.unplaced.map((u) => [u.label, u.text]), [["Notes!A2", "=S!B5"]]);
  assert.deepEqual([shifted.merged, read(shifted.bytes, "Notes").A3, read(shifted.bytes, "Notes").A2], [1, "plain text", undefined]);
  // the user inserted the row: the formula was typed against the user's rows, which are not carried
  const own = await run(two(rowInserted(S8(), 4), { ...notes, A2: "=S!B5" }), await viaOps(two(S8()), [{ op: "set_cells", target: { sheet: "S", range: "B8" }, expect: { quote: "Item 8" }, values: "Renamed" }]));
  assert.equal(own.bytes, null);
  assert.ok(own.unplaced.some((u) => u.label === "Notes!A2" && u.text === "=S!B5"));
});

test("the agent refreshes a whole column, rewrites one row and edits cells through apply: values on rows it left as they were and in a new row below are carried, values on rows it changed are handed back", async () => {
  const change = { B3: 31, A7: "Renamed", B7: 1, ...Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`C${i + 2}`, (i + 2) * 100 + 7])) };
  const mine = xlsxBytes({ Budget: set({ B5: 55, F9: "check this one", A12: "A new row", B12: 1, G7: "beside the rewritten row", G9: "=C5*2" }), Notes: { A1: "Assumptions", B1: "beside the only cell", B2: "below it" } });
  const budget = await sets(book(), change);
  const both = chain(budget, await viaOps(budget.theirs, [{ op: "set_cells", target: { sheet: "Notes", range: "A1" }, expect: { quote: "Assumptions" }, values: "Rewritten" }]));
  const r = await merge(mine, both);
  assert.deepEqual(r.unplaced.map((u) => u.label), ["Budget!B5", "Budget!G7", "Budget!G9", "Notes!B1"]);
  assert.match(r.unplaced.find((u) => u.label === "Budget!G9").why, /your formula for Budget!G9 may point at other cells now/);
  for (const label of ["Budget!B5", "Budget!G7", "Notes!B1"]) assert.match(r.unplaced.find((u) => u.label === label).why, /The agent changed other cells in the same row/);
  assert.equal(r.merged, 4);
  const out = read(r.bytes);
  assert.deepEqual([out.F9, out.A12, out.B12, out.B5, out.G7, out.B3, out.C5, out.A7], ["check this one", "A new row", "1", "50", undefined, "31", "507", "Renamed"]);
  assert.deepEqual(read(r.bytes, "Notes"), { A1: "Rewritten", B2: "below it" });
});

// ---- checked ops that only set cells, but the cells around a value do not show its row and column are the same lines (a sort, a
// shift rebuilt with set_cells): the value is handed back, by the row rule when the agent changed its row, else by `placing`. Both
// can only hand back; the record is what allows a merge. ---------------------------------------------------------------------------
const ITEMS = (header = false) => {
  const cells = header ? { A1: "Item", B1: "Q1", C1: "Q2" } : {};
  for (let r = header ? 2 : 1; r <= 8; r++) Object.assign(cells, { [`A${r}`]: `Item ${r}`, [`B${r}`]: r * 10, [`C${r}`]: r * 100 });
  return cells;
};
/** a row inserted at `at`, and every cell of the rows from `from` on rewritten by `rewrite(column letter, value, old row)` */
const shifted = (cells, at, rewrite, from = 1) => {
  const out = {};
  for (const [ref, v] of Object.entries(cells)) {
    const [, col, row] = /^([A-Z]+)(\d+)$/.exec(ref);
    out[`${col}${Number(row) >= at ? Number(row) + 1 : row}`] = Number(row) >= from ? rewrite(col, v, Number(row)) : v;
  }
  return out;
};
/** the agent turns sheet S from `base` into `theirs` with set_cells only (cells it empties set to null), on record */
const bySetCells = async (base, theirs) => {
  const from = xlsxBytes({ S: base });
  const ops = rewriteOps(from, theirs);
  for (const ref of Object.keys(base)) if (!(ref in theirs)) ops.push({ op: "set_cells", target: { sheet: "S", range: ref }, expect: { quote: textOf(from, "S", ref) }, values: null });
  return viaOps(from, ops);
};
const mergeCells = async (base, mine, theirs) => mergeXlsx({ base: xlsxBytes({ S: base }), mine: xlsxBytes({ S: mine }), name: "t.xlsx", runOps, ...(await bySetCells(base, theirs)) });
const handedBack = (r, label, text) => {
  const u = r.unplaced.find((x) => x.label === label);
  assert.ok(u, `${label} is handed back: ${JSON.stringify(r.unplaced)}`);
  assert.equal(u.text, text, "with the whole value");
  assert.match(u.why, /may not be the same cell any more|The agent changed other cells in the same row/);
};

test("set_cells rebuild a row inserted while most of every row was rewritten: a value typed into an empty cell is handed back, not written one row off", async () => {
  const base = ITEMS();
  const theirs = { ...shifted(base, 3, (col, v) => (col === "A" ? v : v + 1)), A3: "New item", B3: 1, C3: 2 };
  const r = await mergeCells(base, { ...base, E5: "call vendor about Item 5" }, theirs);
  assert.equal(r.bytes, null, "nothing is written");
  handedBack(r, "S!E5", "call vendor about Item 5");
});

test("set_cells: one cell of a moved row that happens to read as before is not evidence that the row is the same", async () => {
  const base = ITEMS();
  const theirs = { ...shifted(base, 3, (col, v) => (col === "A" ? `Thing ${v.slice(5)}` : col === "B" ? v + 10 : v + 1), 3), A3: "New item", B3: 30, C3: 2 };
  const r = await mergeCells(base, { ...base, E5: "call vendor about Item 5" }, theirs);
  assert.equal(r.bytes, null);
  handedBack(r, "S!E5", "call vendor about Item 5");
});

test("set_cells: a note typed into a blank row between two blocks is handed back when the rows above it were rewritten", async () => {
  const base = {};
  for (const r of [1, 2, 3, 5, 6, 8, 9, 10]) Object.assign(base, { [`A${r}`]: `Item ${r}`, [`B${r}`]: r * 10, [`C${r}`]: r * 100 });
  let theirs = base;
  for (let n = 0; n < 3; n++) theirs = shifted(theirs, 2, (_, v) => v);
  theirs = Object.fromEntries(Object.entries(theirs).map(([ref, v]) => [ref, ref.startsWith("A") ? v : v + 1]));
  Object.assign(theirs, { A2: "New a", A3: "New b", A4: "New c" });
  const r = await mergeCells(base, { ...base, A7: "Section C" }, theirs);
  assert.equal(r.bytes, null);
  handedBack(r, "S!A7", "Section C");
});

test("set_cells: a column rebuilt one to the right while the columns were rewritten: a value typed into an empty cell of one is handed back", async () => {
  const base = { A1: "Item", B1: "Q1", C1: "Q2", D1: "Q3" };
  for (const r of [2, 3, 5, 6, 7, 8]) Object.assign(base, { [`A${r}`]: `Item ${r}`, [`B${r}`]: r * 10, [`C${r}`]: r * 100, [`D${r}`]: r * 1000 });
  base.A4 = "Item 4 (no numbers yet)";
  const theirs = Object.fromEntries(Object.entries(colInserted(base, "B")).map(([ref, v]) => [ref, typeof v === "number" ? v + 1 : v]));
  for (const r of [1, 2, 3, 5, 6, 7, 8]) theirs[`B${r}`] = r === 1 ? "Q0" : r;
  const r = await mergeCells(base, { ...base, C4: 400 }, theirs);
  assert.equal(r.bytes, null);
  handedBack(r, "S!C4", "400");
});

test("set_cells: a column rebuilt one to the right: a value typed into a row that is empty in both is handed back by the cells around it, not by the row rule", async () => {
  const base = { A1: "Item", B1: "Q1", C1: "Q2", D1: "Q3" };
  for (const r of [2, 3, 4, 6, 7, 8]) Object.assign(base, { [`A${r}`]: `Item ${r}`, [`B${r}`]: r * 10, [`C${r}`]: r * 100, [`D${r}`]: r * 1000 });
  const theirs = Object.fromEntries(Object.entries(colInserted(base, "B")).map(([ref, v]) => [ref, typeof v === "number" ? v + 1 : v]));
  for (const r of [1, 2, 3, 4, 6, 7, 8]) theirs[`B${r}`] = r === 1 ? "Q0" : r;
  const r = await mergeCells(base, { ...base, C5: 999 }, theirs);
  assert.equal(r.bytes, null);
  assert.match(r.unplaced.find((u) => u.label === "S!C5")?.why ?? "", /may not be the same cell any more/);
});

test("set_cells: two rows swapped (a sort) and their numbers refreshed: a note beside one is handed back", async () => {
  const base = ITEMS();
  const theirs = { ...base, A3: "Item 5", B3: 51, C3: 501, A5: "Item 3", B5: 31, C5: 301 };
  const r = await mergeCells(base, { ...base, E3: "call vendor about Item 3" }, theirs);
  assert.equal(r.bytes, null, "row 3 reads as the old row 5 more than as itself");
  handedBack(r, "S!E3", "call vendor about Item 3");
});

test("set_cells: a row that reads exactly as before but has a twin is no evidence; the same note is carried when the agent only edited cells", async () => {
  const base = { A1: "Item A", B1: 10, C1: 100, A2: "Subtotal", B2: "=B1", A3: "Item B", B3: 20, C3: 200, A4: "Subtotal", B4: "=B3", A5: "Item C", B5: 30, C5: 300, A6: "Subtotal", B6: "=B5" };
  const theirs = { ...base, A1: "Item C", B1: 31, C1: 301, A5: "Item A", B5: 11, C5: 101 };
  const r = await mergeCells(base, { ...base, D2: "check group A subtotal" }, theirs);
  assert.equal(r.bytes, null, "row 2 is under Item C now");
  handedBack(r, "S!D2", "check group A subtotal");
  const calm = await mergeCells(base, { ...base, D2: "check group A subtotal" }, { ...base, B3: 21, C5: 301 });
  assert.deepEqual([calm.merged, calm.unplaced], [1, []]);
});

test("values that most rows share are no evidence for a row: rows that differ in a rare value are carried, rows of shared values only are handed back", () => {
  const wb = (cells) => parseWorkbook(xlsxBytes({ S: cells }));
  const rows = (fn) => Object.assign({}, ...Array.from({ length: 1200 }, (_, i) => fn(i + 1)));
  const stable = { of: () => "stable" }; // the record says only cells were set
  const base = rows((r) => ({ [`A${r}`]: `Item ${r}`, [`B${r}`]: "Open", [`C${r}`]: "West", [`D${r}`]: r * 7 }));
  const keep = (r) => r === 40 || r === 77; // rows the agent left as they were, so the cells, not the rows it changed, decide
  const plan = planXlsxMerge(wb(base), wb({ ...base, F40: "note", A77: "Renamed" }), wb(rows((r) => ({ [`A${r}`]: `Item ${r}`, [`B${r}`]: "Open", [`C${r}`]: "West", [`D${r}`]: r * 7 + (keep(r) ? 0 : 1) }))), [], stable);
  assert.deepEqual([plan.items.map((x) => x.label), plan.unplaced], [["S!F40", "S!A77"], []]);
  const flat = rows((r) => ({ [`A${r}`]: "Open", [`B${r}`]: "West", [`C${r}`]: 0 }));
  const none = planXlsxMerge(wb(flat), wb({ ...flat, E40: "note" }), wb(rows((r) => ({ [`A${r}`]: "Open", [`B${r}`]: "West", [`C${r}`]: keep(r) ? 0 : 1 }))), [], stable);
  assert.deepEqual([none.items, none.unplaced.map((x) => [x.label, x.text])], [[], [["S!E40", "note"]]]);
  // without a record nothing on a changed sheet is placed, whatever the cells say
  const unknown = planXlsxMerge(wb(base), wb({ ...base, F40: "note" }), wb(rows((r) => ({ [`A${r}`]: `Item ${r}`, [`B${r}`]: "Open", [`C${r}`]: "West", [`D${r}`]: r * 7 + 1 }))));
  assert.deepEqual([unknown.items, unknown.copy], [[], true]);
});

test("a value counts as already there only on the same cell: rows the agent swapped with set_cells do not hide the person's edit", async () => {
  // the person set Line 3's Q1 to 40; the agent swapped rows 3 and 4 by setting their cells, so B3 now reads 40 for Line 4
  const swap = { A3: "Line 4", B3: 40, C3: 400, A4: "Line 3", B4: 30, C4: 300 };
  const r = await merge(book(set({ B3: 40 })), await sets(book(), swap));
  assert.equal(r.merged, 0);
  assert.deepEqual(r.unplaced.map((u) => u.text), ["B3: 40"], "the person's value is handed back (here with the whole sheet: the rows look moved)");
  assert.equal(r.copy, true);
});

test("a cell text that spells out other cells is not read as them: two rows that swap places are seen as moved", () => {
  // the line signature joins "position:value" with "|": a short value is written as itself, so one holding "|" and ":" could spell
  // another row's cells (a row {A: "x", B: "y"} and a row {A: "x|1:=y"} read alike, and their swap looked like no change)
  assert.equal(moved({ A1: "x", B1: "y", A2: "x|1:=y", A3: "end" }, { A1: "x|1:=y", A2: "x", B2: "y", A3: "end" }), true);
  assert.equal(moved({ A1: "x", B1: "y", A2: "z", A3: "end" }, { A1: "x", B1: "y", A2: "z", A3: "end" }), false);
});

// The DOCX merge once paired a paragraph by text against its id (outside review, final round). A workbook pairs by cell address: the
// person retypes A3 to read as A4 and edits A4, the agent edits A4 and A9. A3's edit lands in A3, A4's is handed back.
test("addresses, the person's side: a cell retyped to read as its neighbor stays its own cell; the neighbor's edit is handed back", async () => {
  const r = await merge(book(set({ A3: "Line 4", A4: "Line 4b" })), await sets(book(), { A4: "Line 4c", A9: "Line 9d" }));
  const out = read(r.bytes);
  assert.deepEqual({ A3: out.A3, A4: out.A4, A9: out.A9 }, { A3: "Line 4", A4: "Line 4c", A9: "Line 9d" });
  assert.equal(r.merged, 1);
  assert.deepEqual(r.unplaced.map((u) => [u.label, u.text]), [["Budget!A4", "Line 4b"]]);
});
