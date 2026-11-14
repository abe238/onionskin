// Row and column ops on DOCX tables (src/ops/docx-table.js through src/ops/docx.js) and slide ops on PPTX decks (src/ops/pptx.js):
// what they write, what they refuse, and that the result reopens through the repo's own readers and the engine. Every document is
// synthetic (built in memory) or the committed engine sample, edited in memory; nothing is written anywhere.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { docxBytes, rezip, tmpdir } from "./helpers/zipbuild.js";

// a temp state dir: the deep check never finds the real ~/.onionskin venv; it runs only with the repo's .venv, named explicitly below
const root = tmpdir();
process.env.ONIONSKIN_STATE_DIR = path.join(root, "st");
process.env.ONIONSKIN_NO_SOFFICE = "1";
delete process.env.ONIONSKIN_PYTHON;
after(() => fs.rmSync(root, { recursive: true, force: true }));
const { ENGINE_SAMPLES, haveSamples, havePython, python, skipUnless, VENV_HINT } = await import("../scripts/fixtures.mjs");
const SKIP = skipUnless(haveSamples(), `engine samples not found in ${ENGINE_SAMPLES}`, "restore test/fixtures/engine or set ONIONSKIN_TEST_SAMPLES");
const { validateOps } = await import("../src/ops/schema.js");
const { runOps } = await import("../src/ops/run.js");
const { readDocxParagraphs } = await import("../src/docx.js");
const { parseDeck } = await import("../src/pptx.js");
const { checkPackages, nodeChecks, partRels } = await import("../src/package.js");
const { openZip } = await import("../src/zip.js");
const { topTables } = await import("../src/ops/docx-table.js");
const { parse } = await import("../src/xml-tree.js");

const SCHEMA = "onionskin.ops/1";
const docxRun = (bytes, ops, extra = {}) => runOps({ bytes, format: "docx", name: "t.docx", ops, ...extra });
const pptxRun = (bytes, ops, extra = {}) => runOps({ bytes, format: "pptx", name: "t.pptx", ops, ...extra });
const status = (r) => r.results.map((x) => x.status);
const cells = (bytes, table) => {
  const rows = [];
  for (const p of readDocxParagraphs(bytes)) if (p.path?.length === 4 && p.path[0] === table) ((rows[p.path[1]] ||= [])[p.path[2]] = p.text);
  return rows;
};
const docXml = (bytes) => openZip(bytes).readText("word/document.xml");

// ---- DOCX fixtures -----------------------------------------------------------------------------------------------------
const tc = (text, { pr = "", para = "" } = {}) => `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/>${pr}</w:tcPr><w:p${para}><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/><w:color w:val="C00000"/></w:rPr><w:t>${text}</w:t></w:r></w:p></w:tc>`;
const tr = (...c) => `<w:tr><w:trPr><w:trHeight w:val="400"/></w:trPr>${c.join("")}</w:tr>`;
const grid = (n) => `<w:tblGrid>${'<w:gridCol w:w="2000"/>'.repeat(n)}</w:tblGrid>`;
const tbl = (n, ...rows) => `<w:tbl><w:tblPr><w:tblW w:w="${2000 * n}" w:type="dxa"/></w:tblPr>${grid(n)}${rows.join("")}</w:tbl>`;
const para = (t) => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`;
/** Intro paragraph, a 3x2 orders table (body item 1, the header row has a paragraph id), a closing paragraph */
const ORDERS = docxBytes(null, {}, `${para("Intro")}${tbl(2, tr(tc("Region", { para: ' w14:paraId="1A2B3C4D"' }), tc("Orders")), tr(tc("North"), tc("120")), tr(tc("South"), tc("98")))}${para("Closing")}`);

test("ops schema: the new row, column and slide ops validate; a chart op is an unknown op", () => {
  const ok = (op) => validateOps({ schema: SCHEMA, ops: [op] });
  const good = [
    { op: "insert_table_row", target: { table: 1, row: 2 }, expect: { quote: "South" }, where: "after", cells: ["East", "143"] },
    { op: "insert_table_row", target: { table: 1, row: 0 }, expect: { text_hash: "0123456789abcdef" }, where: "before" },
    { op: "delete_table_row", target: { table: 1, row: 1 }, expect: { quote: "North" } },
    { op: "insert_table_column", target: { table: 1, col: 1 }, expect: { quote: "" }, where: "after", cells: ["Q2"] },
    { op: "delete_table_column", target: { table: 1, col: 0 }, expect: { quote: "Region" } },
    { op: "duplicate_slide", target: { slide_id: "257" }, expect: { quote: "" }, to: { slide_id: "260" }, where: "after", shapes: [{ shape_id: 2, paragraphs: ["New"] }] },
    { op: "duplicate_slide", target: { slide_id: "257" }, expect: { quote: "" } },
    { op: "delete_slide", target: { slide_id: "259" }, expect: { quote: "Table" } },
    { op: "move_slide", target: { slide_id: "256" }, expect: { quote: "" }, to: { slide_id: "260" }, where: "before" },
  ];
  for (const op of good) assert.deepEqual(ok(op), { ok: true, errors: [] }, op.op);
  const bad = (op, re) => {
    const r = ok(op);
    assert.equal(r.ok, false, JSON.stringify(op));
    assert.match(r.errors.join("\n"), re);
  };
  bad({ op: "insert_table_row", target: { table: 1, row: 2 }, expect: { quote: "x" } }, /missing required field "where"/);
  bad({ op: "insert_table_row", target: { table: 1, row: 2 }, expect: { quote: "x" }, where: "below" }, /must be one of/);
  bad({ op: "delete_table_row", target: { table: 1, col: 2 }, expect: { quote: "x" } }, /unknown field "col"/);
  bad({ op: "delete_table_column", target: { table: 1, col: 0 } }, /missing required field "expect"/);
  bad({ op: "duplicate_slide", target: { slide_id: "257" }, expect: { quote: "" }, to: { slide_id: "260" } }, /to and where together/);
  bad({ op: "duplicate_slide", target: { slide_id: "257" }, expect: { quote: "" }, shapes: [{ shape_id: 2, paragraphs: ["a"] }, { shape_id: 2, paragraphs: ["b"] }] }, /each shape_id at most once/);
  bad({ op: "move_slide", target: { slide_id: "256" }, expect: { quote: "" }, to: { slide_id: "260" } }, /missing required field "where"/);
  bad({ op: "delete_slide", target: { slide_id: "x" }, expect: { quote: "" } }, /does not match/);
  for (const name of ["insert_chart", "add_chart", "set_chart_data", "add_slide"]) bad({ op: name, target: { slide_id: "256" }, expect: { quote: "" } }, /unknown op/);
});

test("docx: insert_table_row adds a row with the neighbor's formatting and the given cells; the file reopens and takes further ops", async () => {
  const r = await docxRun(ORDERS, [
    { op: "insert_table_row", target: { table: 1, row: 2 }, expect: { quote: "South" }, where: "after", cells: ["East", "143"] },
    { op: "insert_table_row", target: { table: 1, row: 0 }, expect: { quote: "Region\tOrders" }, where: "after", cells: ["West"] },
  ]);
  assert.deepEqual(status(r), ["applied", "applied"], JSON.stringify(r.results));
  assert.deepEqual(r.results.map((x) => x.detail), [{ table: 1, row: 3 }, { table: 1, row: 1 }]);
  assert.equal(r.blocked, null);
  assert.deepEqual(cells(r.bytes, 1), [["Region", "Orders"], ["West", ""], ["North", "120"], ["South", "98"], ["East", "143"]]);
  // the new cells: the neighbor's cell, paragraph and run properties, and none of its content or ids
  const x = docXml(r.bytes);
  const rows = topTables(parse(x))[0].kids.filter((k) => k.name === "w:tr");
  const east = rows[4];
  const s = (n) => n.open + n.kids.map((k) => (k.t === "el" ? s(k) : k.raw ?? "")).join("") + n.close;
  assert.match(s(east), /<w:trHeight w:val="400"\/>/);
  assert.match(s(east), /<w:tcW w:w="2000" w:type="dxa"\/>.*<w:jc w:val="center"\/>.*<w:rPr><w:b\/><w:color w:val="C00000"\/><\/w:rPr><w:t xml:space="preserve">East<\/w:t>/);
  assert.equal((x.match(/w14:paraId="1A2B3C4D"/g) || []).length, 1, "the header's paragraph id is not copied into the new row");
  assert.match(s(rows[1]), /<w:p><w:pPr><w:jc w:val="center"\/><\/w:pPr><\/w:p><\/w:tc><\/w:tr>$/, "a cell without text is one empty paragraph with the neighbor's paragraph properties");
  // reopens through the repo's reader and the engine: the new row can be edited by the existing op
  const again = await docxRun(r.bytes, [{ op: "set_table_cell_text", target: { table: 1, row: 1, col: 1 }, expect: { quote: "" }, text: "77" }]);
  assert.deepEqual(status(again), ["applied"], JSON.stringify(again.results));
  assert.deepEqual(cells(again.bytes, 1)[1], ["West", "77"]);
  assert.deepEqual(nodeChecks(ORDERS, again.bytes, "docx"), []);
});

test("docx: rows inserted at one place keep the ops' order; table targets are the table as delivered; paragraph ops run in the same file", async () => {
  const intro = readDocxParagraphs(ORDERS)[0];
  const r = await docxRun(ORDERS, [
    { op: "insert_table_row", target: { table: 1, row: 1 }, expect: { quote: "North" }, where: "after", cells: ["A"] },
    { op: "insert_table_row", target: { table: 1, row: 1 }, expect: { quote: "North" }, where: "after", cells: ["B"] },
    { op: "insert_table_row", target: { table: 1, row: 2 }, expect: { quote: "South" }, where: "before", cells: ["C"] },
    { op: "delete_table_row", target: { table: 1, row: 2 }, expect: { quote: "South" } },
    { op: "replace_text", target: { text_hash: intro.hash }, expect: { quote: "Intro" }, text: "Intro, revised" },
    { op: "insert_paragraph_before", target: { text_hash: intro.hash }, expect: { quote: "Intro" }, text: "Before everything" },
  ]);
  assert.deepEqual(status(r), ["applied", "applied", "applied", "applied", "applied", "applied"], JSON.stringify(r.results));
  // body item 1 is now a paragraph; the table moved to body item 2 and kept its rows in the asked order
  assert.deepEqual(cells(r.bytes, 2).map((row) => row[0]), ["Region", "North", "A", "B", "C"]);
  assert.deepEqual(readDocxParagraphs(r.bytes).filter((p) => p.path.length === 1).map((p) => p.text), ["Before everything", "Intro, revised", "Closing"]);
  // a cell the engine edits, then a row added to the same table: the row edit meets the engine's saved table
  const both = await docxRun(ORDERS, [
    { op: "set_table_cell_text", target: { table: 1, row: 2, col: 1 }, expect: { quote: "98" }, text: "99" },
    { op: "insert_table_row", target: { table: 1, row: 2 }, expect: { quote: "South" }, where: "after", cells: ["East", "143"] },
  ]);
  assert.deepEqual(status(both), ["applied", "applied"], JSON.stringify(both.results));
  assert.deepEqual(cells(both.bytes, 1), [["Region", "Orders"], ["North", "120"], ["South", "99"], ["East", "143"]]);
  const gone = await docxRun(ORDERS, [
    { op: "delete_table_row", target: { table: 1, row: 1 }, expect: { quote: "North" } },
    { op: "insert_table_row", target: { table: 1, row: 1 }, expect: { quote: "North" }, where: "after" },
  ]);
  assert.deepEqual(status(gone), ["not_applied", "refused"]);
  assert.equal(gone.results[1].code, "row_deleted");
  assert.equal(gone.bytes, null, "atomic: nothing written");
});

test("docx: insert_table_column scales the widths so the table keeps its width; delete_table_column removes a column; both reopen", async () => {
  const r = await docxRun(ORDERS, [{ op: "insert_table_column", target: { table: 1, col: 0 }, expect: { quote: "Region\nNorth\nSouth" }, where: "after", cells: ["Q1", "40", "41"] }]);
  assert.deepEqual(status(r), ["applied"], JSON.stringify(r.results));
  assert.deepEqual(r.results[0].detail, { table: 1, col: 1 });
  assert.deepEqual(cells(r.bytes, 1), [["Region", "Q1", "Orders"], ["North", "40", "120"], ["South", "41", "98"]]);
  const x = docXml(r.bytes);
  assert.deepEqual([...x.matchAll(/<w:gridCol w:w="(\d+)"\/>/g)].map((m) => Number(m[1])), [1333, 1333, 1333]);
  assert.equal((x.match(/<w:tcW w:w="1333" w:type="dxa"\/>/g) || []).length, 9, "every cell width follows its grid column");
  const d = await docxRun(r.bytes, [{ op: "delete_table_column", target: { table: 1, col: 2 }, expect: { quote: "120" } }]);
  assert.deepEqual(status(d), ["applied"], JSON.stringify(d.results));
  assert.deepEqual(cells(d.bytes, 1), [["Region", "Q1"], ["North", "40"], ["South", "41"]]);
  assert.equal((docXml(d.bytes).match(/<w:gridCol /g) || []).length, 2);
  const one = docxBytes(null, {}, tbl(1, tr(tc("Only")), tr(tc("Two"))));
  const last = await docxRun(one, [{ op: "delete_table_column", target: { table: 0, col: 0 }, expect: { quote: "Only" } }]);
  assert.equal(last.results[0].code, "last_column");
});

test("docx: targets and expect: not a table, no such row, expect against the row or column text, the only row", async () => {
  const run1 = async (op) => (await docxRun(ORDERS, [op])).results[0];
  assert.equal((await run1({ op: "delete_table_row", target: { table: 0, row: 0 }, expect: { quote: "" } })).status, "anchor_not_found", "body item 0 is a paragraph");
  assert.match((await run1({ op: "delete_table_row", target: { table: 1, row: 9 }, expect: { quote: "" } })).reason, /no row 9/);
  assert.match((await run1({ op: "delete_table_column", target: { table: 1, col: 5 }, expect: { quote: "" } })).reason, /no column 5/);
  const mis = await run1({ op: "delete_table_row", target: { table: 1, row: 1 }, expect: { quote: "South" } });
  assert.equal(mis.status, "expect_mismatch");
  assert.equal(mis.actual_excerpt, "North 120"); // the excerpt is cleaned untrusted text: whitespace collapsed
  const { textHash } = await import("../src/text.js");
  assert.equal((await run1({ op: "delete_table_row", target: { table: 1, row: 1 }, expect: { text_hash: textHash("North\t120") } })).status, "applied");
  const one = docxBytes(null, {}, tbl(2, tr(tc("A"), tc("B"))));
  const only = (await docxRun(one, [{ op: "delete_table_row", target: { table: 0, row: 0 }, expect: { quote: "A" } }])).results[0];
  assert.deepEqual([only.status, only.code], ["refused", "last_row"]);
  const many = (await docxRun(ORDERS, [{ op: "insert_table_row", target: { table: 1, row: 0 }, expect: { quote: "" }, where: "after", cells: ["a", "b", "c"] }])).results[0];
  assert.deepEqual([many.code, many.reason], ["too_many_cells", "the row has 2 cell(s); 3 cell texts were given"]);
});

test("docx: merged cells: a vertical merge is never split or beheaded; column ops refuse horizontal merges", async () => {
  const restart = { pr: '<w:vMerge w:val="restart"/>' };
  const cont = { pr: "<w:vMerge/>" };
  // column 0 of rows 0 and 1 is one merged cell
  const vm = docxBytes(null, {}, tbl(2, tr(tc("Merged", restart), tc("B")), tr(tc("", cont), tc("C")), tr(tc("D"), tc("E"))));
  const one = async (bytes, op) => (await docxRun(bytes, [op])).results[0];
  const split = await one(vm, { op: "insert_table_row", target: { table: 0, row: 0 }, expect: { quote: "Merged" }, where: "after" });
  assert.deepEqual([split.status, split.code], ["refused", "merged_cells"]);
  const head = await one(vm, { op: "delete_table_row", target: { table: 0, row: 0 }, expect: { quote: "Merged" } });
  assert.deepEqual([head.status, head.code], ["refused", "merged_cells"]);
  // below the merge, a new row copies the continuation row without its merge; deleting a continuation row shortens the merge
  const below = await docxRun(vm, [{ op: "insert_table_row", target: { table: 0, row: 1 }, expect: { quote: "C" }, where: "after", cells: ["X", "Y"] }]);
  assert.deepEqual(status(below), ["applied"]);
  assert.deepEqual(cells(below.bytes, 0), [["Merged", "B"], ["", "C"], ["X", "Y"], ["D", "E"]]);
  assert.equal((docXml(below.bytes).match(/<w:vMerge/g) || []).length, 2, "the new row is not part of the merge");
  const short = await docxRun(vm, [{ op: "delete_table_row", target: { table: 0, row: 1 }, expect: { quote: "C" } }]);
  assert.deepEqual(status(short), ["applied"]);
  // a horizontal merge: rows can be added (the new row copies the span), columns cannot
  const span = docxBytes(null, {}, tbl(2, tr(`<w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>Wide</w:t></w:r></w:p></w:tc>`), tr(tc("L"), tc("R"))));
  for (const op of [
    { op: "insert_table_column", target: { table: 0, col: 0 }, expect: { quote: "" }, where: "after" },
    { op: "delete_table_column", target: { table: 0, col: 0 }, expect: { quote: "" } },
  ]) {
    const x = await one(span, op);
    assert.deepEqual([x.status, x.code], ["refused", "merged_cells"], op.op);
  }
  const wide = await docxRun(span, [{ op: "insert_table_row", target: { table: 0, row: 0 }, expect: { quote: "Wide" }, where: "before", cells: ["Top"] }]);
  assert.deepEqual(status(wide), ["applied"]);
  assert.deepEqual(cells(wide.bytes, 0), [["Top"], ["Wide"], ["L", "R"]]);
});

test("docx: deletes refuse protected content, half a comment, and a row another op of the file edits", async () => {
  const field = `<w:tc><w:p><w:r><w:t xml:space="preserve">Page </w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:tc>`;
  const prot = docxBytes(null, {}, tbl(2, tr(tc("A"), tc("B")), tr(field, tc("C"))));
  const p = (await docxRun(prot, [{ op: "delete_table_row", target: { table: 0, row: 1 }, expect: { quote: "C" } }])).results[0];
  assert.equal(p.status, "skipped_protected");
  const half = `<w:tc><w:p><w:commentRangeStart w:id="5"/><w:r><w:t>Start</w:t></w:r></w:p></w:tc>`;
  const end = `<w:tc><w:p><w:r><w:t>End</w:t></w:r><w:commentRangeEnd w:id="5"/></w:p></w:tc>`;
  const cm = docxBytes(null, {}, tbl(2, tr(half, tc("B")), tr(end, tc("C")), tr(tc("D"), tc("E"))));
  const loose = (await docxRun(cm, [{ op: "delete_table_row", target: { table: 0, row: 0 }, expect: { quote: "Start" } }])).results[0];
  assert.deepEqual([loose.status, loose.code], ["refused", "open_range"]);
  const col = (await docxRun(cm, [{ op: "delete_table_column", target: { table: 0, col: 0 }, expect: { quote: "Start" } }])).results[0];
  assert.equal(col.status, "applied", "the whole comment range goes with the column");
  const edited = await docxRun(ORDERS, [
    { op: "set_table_cell_text", target: { table: 1, row: 1, col: 1 }, expect: { quote: "120" }, text: "121" },
    { op: "delete_table_row", target: { table: 1, row: 1 }, expect: { quote: "North" } },
  ]);
  assert.deepEqual(status(edited), ["not_applied", "refused"]);
  assert.equal(edited.results[1].code, "cell_edited_by_another_op");
  // --partial keeps the cell edit
  const partial = await docxRun(ORDERS, [
    { op: "set_table_cell_text", target: { table: 1, row: 1, col: 1 }, expect: { quote: "120" }, text: "121" },
    { op: "delete_table_row", target: { table: 1, row: 1 }, expect: { quote: "North" } },
  ], { partial: true });
  assert.deepEqual(status(partial), ["applied", "refused"]);
  assert.deepEqual(cells(partial.bytes, 1)[1], ["North", "121"]);
});

test("docx: tables are counted the way the paragraph reader counts them (engine sample)", { skip: SKIP }, async () => {
  const bytes = fs.readFileSync(path.join(ENGINE_SAMPLES, "sample.docx"));
  const paras = readDocxParagraphs(bytes);
  const tables = topTables(parse(docXml(bytes)));
  const byNo = new Map();
  for (const p of paras) if (p.tableNo) byNo.set(p.tableNo, p);
  assert.equal(tables.length, byNo.size, "one top-level table per tableNo");
  for (const [no, p] of byNo) {
    const rows = tables[no - 1].kids.filter((k) => k.name === "w:tr").length;
    assert.equal(rows, Math.max(...paras.filter((x) => x.tableNo === no).map((x) => x.path[1])) + 1, `table ${no} rows`);
  }
  // a row added to the first table of the sample, read back
  const t = [...byNo.values()][0].path[0];
  const last = Math.max(...paras.filter((x) => x.path?.[0] === t).map((x) => x.path[1]));
  const r = await docxRun(bytes, [{ op: "insert_table_row", target: { table: t, row: last }, expect: { quote: "" }, where: "after", cells: ["Added"] }]);
  assert.deepEqual(status(r), ["applied"], JSON.stringify(r.results));
  assert.equal(cells(r.bytes, t)[last + 1][0], "Added");
  assert.deepEqual(checkPackages(bytes, r.bytes, "docx").flags.filter((f) => f.severity !== "info"), []);
});

// ---- PPTX ---------------------------------------------------------------------------------------------------------------
const deckOf = (bytes) => {
  const d = parseDeck(bytes);
  d.ensure();
  return d.slides.map((s) => ({ id: s.id, part: s.part, title: s.shapes.find((x) => x.id === 2)?.text ?? "" }));
};
/** What PowerPoint needs to open a deck without repair, checked from the package: sldIdLst ids, rels, content types, notes. */
function assertDeckConsistent(bytes) {
  const zip = openZip(bytes);
  const pres = zip.readText("ppt/presentation.xml");
  const rels = new Map();
  for (const m of zip.readText("ppt/_rels/presentation.xml.rels").matchAll(/<Relationship [^>]*>/g)) rels.set(/Id="([^"]+)"/.exec(m[0])[1], m[0]);
  const ids = [...pres.matchAll(/<p:sldId id="(\d+)" r:id="([^"]+)"\/>/g)];
  assert.ok(ids.length > 0);
  assert.equal(new Set(ids.map((m) => m[1])).size, ids.length, "slide ids are unique");
  assert.equal(new Set(ids.map((m) => m[2])).size, ids.length, "relationship ids are unique");
  const types = zip.readText("[Content_Types].xml");
  const overrides = new Set([...types.matchAll(/PartName="\/([^"]+)"/g)].map((m) => m[1]));
  for (const o of overrides) assert.ok(zip.entries.has(o), `content type override for a missing part ${o}`);
  const listed = new Set();
  for (const [, id, rid] of ids) {
    assert.ok(Number(id) >= 256 && Number(id) < 2147483648, `slide id ${id} in range`);
    const target = partRels(zip, "ppt/presentation.xml").find((r) => rels.get(rid)?.includes(`Target="${r.target.replace("ppt/", "")}"`))?.target;
    assert.ok(target && zip.entries.has(target), `r:id ${rid} resolves to a slide part`);
    assert.ok(overrides.has(target), `${target} has a content type`);
    listed.add(target);
    const notes = partRels(zip, target).filter((r) => r.type === "notesSlide");
    assert.ok(notes.length <= 1);
    for (const n of notes) assert.ok(partRels(zip, n.target).some((r) => r.type === "slide" && r.target === target), "the notes slide points back to its own slide");
  }
  for (const n of zip.names) if (/^ppt\/slides\/slide\d+\.xml$/.test(n)) assert.ok(listed.has(n), `${n} is listed in sldIdLst`);
  assert.deepEqual(nodeChecks(bytes, bytes, "pptx"), [], "no dangling relationship in the result");
}
const sample = () => fs.readFileSync(path.join(ENGINE_SAMPLES, "sample.pptx"));
const NS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NOTES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${NS_REL}" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld></p:notes>`;
/** the sample with speaker notes on slide 257 (slide2.xml) */
const withNotes = () =>
  rezip(sample(), {
    "ppt/slides/_rels/slide2.xml.rels": (x) => x.replace("</Relationships>", `<Relationship Id="rId9" Type="${NS_REL}/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>`),
    "[Content_Types].xml": (x) => x.replace("</Types>", '<Override PartName="/ppt/notesSlides/notesSlide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/></Types>'),
  });
const addNotes = (bytes) => {
  const zip = openZip(bytes);
  const files = Object.fromEntries(zip.names.map((n) => [n, zip.read(n)]));
  files["ppt/notesSlides/notesSlide1.xml"] = NOTES;
  files["ppt/notesSlides/_rels/notesSlide1.xml.rels"] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${NS_REL}/slide" Target="../slides/slide2.xml"/></Relationships>`;
  return files;
};

test("pptx: duplicate (with text for the copy and a place), move and delete keep the deck consistent; text ops after them hit the right slide", { skip: SKIP }, async () => {
  const bytes = sample();
  assertDeckConsistent(bytes);
  const r = await pptxRun(bytes, [
    { op: "duplicate_slide", target: { slide_id: "257" }, expect: { quote: "Why it is fast" }, shapes: [{ shape_id: 2, paragraphs: ["Why it is still fast"] }] },
    { op: "move_slide", target: { slide_id: "256" }, expect: { quote: "office-engine" }, to: { slide_id: "260" }, where: "after" },
    { op: "delete_slide", target: { slide_id: "259" }, expect: { quote: "Table" } },
    { op: "set_shape_text", target: { slide_id: "258", shape_id: 2 }, expect: { quote: "Shapes" }, paragraphs: ["Shapes and images"] },
    { op: "replace_text_in_shape", target: { slide_id: "260", shape_id: 2 }, expect: { quote: "Chart" }, find: "placeholder", replace: "stand-in" },
    { op: "duplicate_slide", target: { slide_id: "258" }, expect: { quote: "Rounded" }, to: { slide_id: "257" }, where: "before" },
  ]);
  assert.deepEqual(status(r), ["applied", "applied", "applied", "applied", "applied", "applied"], JSON.stringify(r.results));
  assert.equal(r.results[0].detail.slide_id, "261");
  assert.equal(r.results[5].detail.slide_id, "262");
  assert.equal(r.blocked, null, JSON.stringify(r.blocked));
  // ops run in file order: the last copy is made after the set_shape_text on its slide, so it carries the new title
  assert.deepEqual(deckOf(r.bytes).map((s) => [s.id, s.title]), [
    ["262", "Shapes and images"],
    ["257", "Why it is fast"],
    ["261", "Why it is still fast"],
    ["258", "Shapes and images"],
    ["260", "Chart (stand-in)"],
    ["256", "office-engine"],
  ]);
  assertDeckConsistent(r.bytes);
  // the copy shares the picture of its slide, and its layout
  const zip = openZip(r.bytes);
  const copy = deckOf(r.bytes)[0].part;
  assert.deepEqual(partRels(zip, copy).map((x) => x.type).sort(), partRels(zip, "ppt/slides/slide3.xml").map((x) => x.type).sort());
  // the deleted slide's parts are reported as a slide removed (info), never as a lost part; nothing blocks. The last copy took the freed
  // name slide4.xml, so slide4.xml is not gone from the package: it is a different slide now
  const flags = checkPackages(bytes, r.bytes, "pptx").flags;
  assert.deepEqual(flags.filter((f) => f.severity !== "info"), []);
  assert.equal(deckOf(r.bytes)[0].part, "ppt/slides/slide4.xml");
  assert.deepEqual(flags.filter((f) => f.code === "slide_removed" || f.code === "part_removed"), []);
  // reopens through the engine and takes further ops
  const again = await pptxRun(r.bytes, [{ op: "delete_slide", target: { slide_id: "262" }, expect: { quote: "Shapes" } }]);
  assert.deepEqual(status(again), ["applied"]);
  assertDeckConsistent(again.bytes);
});

test("pptx: deleting a slide removes its notes slide; duplicating leaves the notes with the original", { skip: SKIP }, async () => {
  const { buildZip } = await import("./helpers/zipbuild.js");
  const bytes = buildZip(addNotes(withNotes()));
  assertDeckConsistent(bytes);
  const dup = await pptxRun(bytes, [{ op: "duplicate_slide", target: { slide_id: "257" }, expect: { quote: "fast" } }]);
  assert.deepEqual(status(dup), ["applied"]);
  assertDeckConsistent(dup.bytes);
  const z = openZip(dup.bytes);
  const copyPart = deckOf(dup.bytes)[2].part;
  assert.deepEqual(partRels(z, copyPart).map((x) => x.type), ["slideLayout"], "the copy has no notes");
  const del = await pptxRun(bytes, [{ op: "delete_slide", target: { slide_id: "257" }, expect: { quote: "fast" } }]);
  assert.deepEqual(status(del), ["applied"], JSON.stringify(del.results));
  assertDeckConsistent(del.bytes);
  const after = openZip(del.bytes);
  assert.ok(!after.entries.has("ppt/notesSlides/notesSlide1.xml") && !after.entries.has("ppt/slides/slide2.xml"));
  const flags = checkPackages(bytes, del.bytes, "pptx").flags;
  assert.deepEqual(flags.filter((f) => f.code === "part_removed"), []);
  assert.deepEqual(flags.filter((f) => f.code === "slide_removed").map((f) => [f.part, f.severity]).sort(), ["ppt/notesSlides/_rels/notesSlide1.xml.rels", "ppt/notesSlides/notesSlide1.xml", "ppt/slides/_rels/slide2.xml.rels", "ppt/slides/slide2.xml"].map((p) => [p, "warn"]));
  assert.ok(flags.every((f) => f.severity !== "error"), "a requested delete does not recommend Revert");
});

test("pptx: the deep check (scripts/checker/check.py) agrees: a deleted slide, and a copy under its freed part name, are not damage", { skip: SKIP || skipUnless(havePython(), "needs .venv with lxml", VENV_HINT) }, async () => {
  process.env.ONIONSKIN_PYTHON = python;
  try {
    const bytes = sample();
    const r = await pptxRun(bytes, [
      { op: "delete_slide", target: { slide_id: "259" }, expect: { quote: "Table" } },
      { op: "duplicate_slide", target: { slide_id: "258" }, expect: { quote: "Rounded" } },
    ]);
    assert.deepEqual(status(r), ["applied", "applied"]);
    const { flags, checks } = checkPackages(bytes, r.bytes, "pptx");
    assert.equal(checks.deep.status, "ran", JSON.stringify(checks));
    assert.deepEqual(flags.filter((f) => f.severity !== "info"), [], "no lost part and no count decrease on the reused slide4.xml (its old content went with the deleted slide)");
    // a part removed that is not a slide's own still counts as lost
    const broken = rezip(r.bytes, { "ppt/media/image1.png": () => null });
    assert.ok(checkPackages(bytes, broken, "pptx").flags.some((f) => f.code === "part_removed" && f.part === "ppt/media/image1.png" && f.severity === "error"));
  } finally {
    delete process.env.ONIONSKIN_PYTHON;
  }
});

test("pptx: refusals: a chart slide, the last slide, a linked slide, sections, custom shows, a missing slide, expect", { skip: SKIP }, async () => {
  const one = async (bytes, op) => (await pptxRun(bytes, [op])).results[0];
  const chart = await one(sample(), { op: "duplicate_slide", target: { slide_id: "260" }, expect: { quote: "" } });
  assert.deepEqual([chart.status, chart.code], ["refused", "slide_has_chart"]);
  assert.match(chart.reason, /a chart/);
  const linked = rezip(sample(), { "ppt/slides/_rels/slide3.xml.rels": (x) => x.replace("</Relationships>", `<Relationship Id="rId99" Type="${NS_REL}/slide" Target="slide4.xml"/></Relationships>`) });
  const l = await one(linked, { op: "delete_slide", target: { slide_id: "259" }, expect: { quote: "" } });
  assert.deepEqual([l.status, l.code], ["refused", "slide_is_linked"]);
  assert.equal((await one(linked, { op: "duplicate_slide", target: { slide_id: "258" }, expect: { quote: "" } })).status, "applied", "a copy may keep a link to another slide");
  const sections = rezip(sample(), { "ppt/presentation.xml": (x) => x.replace("</p:presentation>", '<p:extLst><p:ext uri="{521415D9-36F7-43E2-AB2F-B90AF26B5E84}"><p14:sectionLst xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main"><p14:section name="All" id="{11111111-2222-3333-4444-555555555555}"><p14:sldIdLst><p14:sldId id="256"/></p14:sldIdLst></p14:section></p14:sectionLst></p:ext></p:extLst></p:presentation>') });
  for (const op of ["duplicate_slide", "delete_slide"]) assert.equal((await one(sections, { op, target: { slide_id: "257" }, expect: { quote: "" } })).code, "deck_has_sections", op);
  assert.equal((await one(sections, { op: "move_slide", target: { slide_id: "257" }, expect: { quote: "" }, to: { slide_id: "256" }, where: "before" })).code, "deck_has_sections");
  const shows = rezip(sample(), { "ppt/presentation.xml": (x) => x.replace("<p:defaultTextStyle>", '<p:custShowLst><p:custShow name="Short" id="0"><p:sldLst><p:sld r:id="rId8"/></p:sldLst></p:custShow></p:custShowLst><p:defaultTextStyle>') });
  assert.equal((await one(shows, { op: "delete_slide", target: { slide_id: "258" }, expect: { quote: "" } })).code, "deck_has_custom_shows");
  assert.equal((await one(sample(), { op: "delete_slide", target: { slide_id: "999" }, expect: { quote: "" } })).status, "anchor_not_found");
  assert.equal((await one(sample(), { op: "move_slide", target: { slide_id: "256" }, expect: { quote: "" }, to: { slide_id: "999" }, where: "after" })).status, "anchor_not_found");
  assert.equal((await one(sample(), { op: "move_slide", target: { slide_id: "256" }, expect: { quote: "" }, to: { slide_id: "256" }, where: "after" })).code, "move_onto_itself");
  const mis = await one(sample(), { op: "delete_slide", target: { slide_id: "257" }, expect: { quote: "Something else" } });
  assert.equal(mis.status, "expect_mismatch");
  assert.match(mis.actual_excerpt, /Why it is fast/);
  assert.equal((await one(sample(), { op: "duplicate_slide", target: { slide_id: "257" }, expect: { quote: "" }, shapes: [{ shape_id: 42, paragraphs: ["x"] }] })).status, "anchor_not_found");
  // the last slide: four deletes go, the fifth is refused, atomically nothing is written
  const all = await pptxRun(sample(), ["256", "257", "258", "259", "260"].map((id) => ({ op: "delete_slide", target: { slide_id: id }, expect: { quote: "" } })));
  assert.deepEqual(status(all), ["not_applied", "not_applied", "not_applied", "not_applied", "refused"]);
  assert.equal(all.results[4].code, "last_slide");
  assert.equal(all.bytes, null);
  // a slide deleted by an earlier op of the file
  const twice = await pptxRun(sample(), [
    { op: "delete_slide", target: { slide_id: "257" }, expect: { quote: "" } },
    { op: "set_shape_text", target: { slide_id: "257", shape_id: 2 }, expect: { quote: "" }, paragraphs: ["x"] },
  ]);
  assert.deepEqual(status(twice), ["not_applied", "anchor_not_found"]);
});
