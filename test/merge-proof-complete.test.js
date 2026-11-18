import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { buildZip, docxBytes, rezip } from "./helpers/zipbuild.js";
import { ENGINE_SAMPLES, haveSamples, skipUnless } from "../scripts/fixtures.mjs";
import { proveMerge } from "../src/merge-proof.js";
import { work } from "../src/merge-worker.js";
import { readDocxParagraphs } from "../src/docx.js";
import { openZip } from "../src/zip.js";

// The proof of a merge is complete by construction (src/merge-proof.js, src/merge-package.js): every part of the package and every
// unit inside the main parts is compared between the base and the person's version in full, and a difference is in the result or
// handed back, or the merge returns no file. Four findings of an outside review on 415860f, each first as the result 415860f gave
// (the proof alone must refuse it), then through the merge worker as the server runs it (a correct merge or a clean refusal).

const SAMPLES = skipUnless(haveSamples(), `engine samples not found in ${ENGINE_SAMPLES}`, "restore test/fixtures/engine or set ONIONSKIN_TEST_SAMPLES");
const pid = (n) => String(n).padStart(8, "0");
const p = (t, id) => `<w:p w14:paraId="${pid(id)}"><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
const tbl = (inner) => `<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="4000"/></w:tblGrid><w:tr><w:tc><w:tcPr><w:tcW w:w="4000" w:type="dxa"/></w:tcPr>${inner}</w:tc></w:tr></w:tbl>`;
const prove = (format, base, mine, theirs, merged, unplaced = [], copy = false) => proveMerge(format, { base, mine, theirs, merged, unplaced, copy });
const merge = (format, base, mine, theirs, edits = []) => work({ format, base, mine, theirs, name: `t.${format}`, edits, agent: null });

test("HIGH A: a paragraph moved from one table to another and edited: the 415860f result (still in the first table) is refused by the proof alone; the merge hands the move back", async () => {
  const base = docxBytes([], {}, tbl(p("A", 1) + p("X", 2)) + tbl(p("B", 3)) + p("D", 4));
  const mine = docxBytes([], {}, tbl(p("A", 1)) + tbl(p("X edited", 2) + p("B", 3)) + p("D", 4));
  const theirs = docxBytes([], {}, tbl(p("A", 1) + p("X", 2)) + tbl(p("B", 3)) + p("D agent", 4));
  // what 415860f answered: ok, merged 1, nothing handed back, "X edited" left in the first table
  const old = docxBytes([], {}, tbl(p("A", 1) + p("X edited", 2)) + tbl(p("B", 3)) + p("D agent", 4));
  assert.match(prove("docx", base, mine, theirs, old) ?? "", /another table or cell/);
  const r = await merge("docx", base, mine, theirs);
  assert.equal(r.refused, undefined, r.refused);
  assert.equal(r.ok, true);
  const out = readDocxParagraphs(r.bytes);
  assert.ok(out.some((x) => x.text === "X edited"), "the person's text is carried");
  assert.ok(out.some((x) => x.text === "D agent"), "the agent's text stands");
  const move = r.unplaced.find((u) => /another table|table cell/.test(u.why));
  assert.ok(move, `the move is handed back: ${JSON.stringify(r.unplaced)}`);
  assert.ok(!move.check, "a move is never a line that only asks to check");
});

const HDR = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
/** a DOCX with a header part referenced by the section */
function withHeader(header, body) {
  return docxBytes([], {
    "word/_rels/document.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdH" Type="${HDR}/header" Target="header1.xml"/></Relationships>`,
    "word/header1.xml": `<?xml version="1.0"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>${header}</w:t></w:r></w:p></w:hdr>`,
  }, `${body}<w:sectPr xmlns:r="${HDR}"><w:headerReference w:type="default" r:id="rIdH"/></w:sectPr>`);
}

test("HIGH D: a header the person changed while the agent changed the body: the 415860f result (merged 0, the base header) is refused by the proof alone; the merge hands the header back with a copy", async () => {
  const base = withHeader("Base header", p("Body", 1));
  const mine = withHeader("Mine header", p("Body", 1));
  const theirs = withHeader("Base header", p("Body by the agent", 1));
  assert.match(prove("docx", base, mine, theirs, theirs) ?? "", /parts/);
  const r = await merge("docx", base, mine, theirs);
  assert.equal(r.refused, undefined, r.refused);
  const header = r.unplaced.find((u) => /header/.test(u.why));
  assert.ok(header, `the header is handed back: ${JSON.stringify(r.unplaced)}`);
  assert.equal(r.copy, true, "the person's version is kept as a copy next to the file");
  // the agent's header stands where the agent changed it and the person did not
  const both = await merge("docx", base, withHeader("Base header", p("Body edited", 1)), withHeader("Agent header", p("Body", 1)));
  assert.equal(both.ok, true);
  assert.deepEqual(both.unplaced, []);
  assert.match(openZip(both.bytes).readText("word/header1.xml"), /Agent header/);
});

// ---- PPTX ----
const P = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const xml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
let sample = null;
/** the engine's sample deck with one slide (id 256) of boxes [{id, text, x, bold}] */
function deck(shapes) {
  sample ||= openZip(fs.readFileSync(path.join(ENGINE_SAMPLES, "sample.pptx")));
  const files = {};
  for (const n of sample.names) if (!/^ppt\/(slides|charts|embeddings|media)\//.test(n) && n !== "docProps/thumbnail.jpeg") files[n] = sample.read(n);
  files["[Content_Types].xml"] = sample.readText("[Content_Types].xml").replace(/<Override PartName="\/ppt\/(slides|charts)\/[^"]+"[^>]*\/>/g, "").replace("</Types>", `<Override PartName="/ppt/slides/slide256.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>`);
  files["_rels/.rels"] = sample.readText("_rels/.rels").replace(/<Relationship Id="rId2"[^>]*\/>/, "");
  files["ppt/presentation.xml"] = sample.readText("ppt/presentation.xml").replace(/<p:sldIdLst>.*<\/p:sldIdLst>/, `<p:sldIdLst><p:sldId id="256" r:id="rId256"/></p:sldIdLst>`);
  files["ppt/_rels/presentation.xml.rels"] = sample.readText("ppt/_rels/presentation.xml.rels").replace(/<Relationship Id="rId(7|8|9|10|11)"[^>]*\/>/g, "").replace("</Relationships>", `<Relationship Id="rId256" Type="${P}/slide" Target="slides/slide256.xml"/></Relationships>`);
  const sp = shapes.map((x) => `<p:sp><p:nvSpPr><p:cNvPr id="${x.id}" name="Box ${x.id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x.x ?? 0}" y="0"/><a:ext cx="900000" cy="900000"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:p><a:r><a:rPr lang="en-US"${x.bold ? ' b="1"' : ""}/><a:t xml:space="preserve">${xml(x.text)}</a:t></a:r></a:p></p:txBody></p:sp>`).join("");
  files["ppt/slides/slide256.xml"] = `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="${P}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${sp}</p:spTree></p:cSld></p:sld>`;
  files["ppt/slides/_rels/slide256.xml.rels"] = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${P}/slideLayout" Target="../slideLayouts/slideLayout6.xml"/></Relationships>`;
  return buildZip(files);
}
// what the page sends after 2,000 text events: the session keeps the first 2,000 (src/session.js), so the move after them is gone
const overflowed = (kind) => Array.from({ length: 2000 }, () => ({ kind, slide: 0, sheet: "S" }));

test("HIGH C (PPTX): a shape moved after 2,000 text events: the 415860f result (text carried, position lost) is refused by the proof alone; the merge hands the move back with a copy", { skip: SAMPLES }, async () => {
  const base = deck([{ id: 2, text: "A", x: 0 }, { id: 3, text: "Other", x: 0 }]);
  const mine = deck([{ id: 2, text: "Mine", x: 2000000 }, { id: 3, text: "Other", x: 0 }]);
  const theirs = deck([{ id: 2, text: "A", x: 0 }, { id: 3, text: "Other by the agent", x: 0 }]);
  const old = deck([{ id: 2, text: "Mine", x: 0 }, { id: 3, text: "Other by the agent", x: 0 }]);
  assert.match(prove("pptx", base, mine, theirs, old) ?? "", /shapes? .*neither carried nor handed back/);
  const r = await merge("pptx", base, mine, theirs, overflowed("text"));
  assert.equal(r.refused, undefined, r.refused);
  assert.equal(r.ok, true);
  const moved = r.unplaced.find((u) => /moved, resized/.test(u.why));
  assert.ok(moved, `the move is handed back: ${JSON.stringify(r.unplaced)}`);
  assert.equal(r.copy, true);
});

// ---- XLSX ----
const S = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const STYLES = `<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>`;
/** a workbook of two sheets, S and T: `s` and `t` are {A1: [text, style]} */
function book(s, t) {
  const cells = (m) => Object.entries(m).map(([ref, [v, st]]) => `<row r="${ref.slice(1)}"><c r="${ref}"${st ? ` s="${st}"` : ""} t="inlineStr"><is><t>${v}</t></is></c></row>`).join("");
  const sheet = (m) => `<?xml version="1.0"?><worksheet ${S}><sheetData>${cells(m)}</sheetData></worksheet>`;
  return buildZip({
    "[Content_Types].xml": `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    "_rels/.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${P}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0"?><workbook ${S}><sheets><sheet name="S" sheetId="1" r:id="rId1"/><sheet name="T" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${P}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${P}/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="${P}/styles" Target="styles.xml"/></Relationships>`,
    "xl/styles.xml": STYLES,
    "xl/worksheets/sheet1.xml": sheet(s),
    "xl/worksheets/sheet2.xml": sheet(t),
  });
}

test("HIGH C (XLSX): a cell made bold after 2,000 value events: the 415860f result (value carried, bold lost) is refused by the proof alone; the merge hands the bold back with a copy", async () => {
  const base = book({ A1: ["Base"] }, { B1: ["Other"] });
  const mine = book({ A1: ["Mine", 1] }, { B1: ["Other"] });
  const theirs = book({ A1: ["Base"] }, { B1: ["Other by the agent"] });
  const old = book({ A1: ["Mine"] }, { B1: ["Other by the agent"] });
  assert.match(prove("xlsx", base, mine, theirs, old) ?? "", /cell (formats|formatting)/);
  const r = await merge("xlsx", base, mine, theirs, overflowed("cell"));
  assert.equal(r.refused, undefined, r.refused);
  assert.equal(r.ok, true);
  const bold = r.unplaced.find((u) => /formatting of/.test(u.why));
  assert.ok(bold, `the bold is handed back: ${JSON.stringify(r.unplaced)}`);
  assert.equal(r.copy, true);
});

test("HIGH C: past 2,000 page events the list says it was cut; the XLSX planner, which reads moves of rows from it, refuses instead of guessing; the proof never reads it", async () => {
  const { editKinds } = await import("../src/session.js");
  const { EDITS_OVERFLOW } = await import("../src/constants.js");
  const many = Array.from({ length: 2001 }, () => ({ kind: "cell", sheet: "S" }));
  const kinds = editKinds(many);
  assert.equal(kinds.length, 2001);
  assert.equal(kinds[2000].kind, EDITS_OVERFLOW);
  assert.equal(editKinds(many.slice(0, 2000)).length, 2000, "a list that fits is passed as it is");
  const base = book({ A1: ["Base"] }, { B1: ["Other"] });
  const mine = book({ A1: ["Mine"] }, { B1: ["Other"] });
  const theirs = book({ A1: ["Base"] }, { B1: ["Other by the agent"] });
  const r = await merge("xlsx", base, mine, theirs, kinds);
  assert.match(r.refused ?? "", /more edits were made than Onionskin can follow/);
  // the same merge with the list whole carries the value
  const ok = await merge("xlsx", base, mine, theirs, many.slice(0, 2000));
  assert.equal(ok.ok, true);
  assert.equal(ok.merged, 1);
});

test("found by the proof: a table row the person deleted was merged as a row of empty cells (a damaged table); the paragraphs stay and the row is handed back", async () => {
  const cell = (inner) => `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr>${inner}</w:tc>`;
  const table = (rows) => `<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>${rows.map((r) => `<w:tr>${r.map(cell).join("")}</w:tr>`).join("")}</w:tbl>`;
  const rows = [[p("One", 1), p("Two", 2)], [p("Three", 3), p("Four", 4)]];
  const base = docxBytes([], {}, p("Body", 9) + table(rows));
  const mine = docxBytes([], {}, p("Body", 9) + table(rows.slice(0, 1)));
  const theirs = docxBytes([], {}, p("Body by the agent", 9) + table(rows));
  // what the planner wrote before: the row's two paragraphs deleted, two cells left with no paragraph
  const old = docxBytes([], {}, p("Body by the agent", 9) + table([rows[0], ["", ""]]));
  assert.match(prove("docx", base, mine, theirs, old) ?? "", /tables or sections in the result/);
  const r = await merge("docx", base, mine, theirs);
  assert.equal(r.refused, undefined, r.refused);
  const xml = openZip(r.bytes ?? theirs).readText("word/document.xml");
  assert.doesNotMatch(xml, /<w:tc>(<w:tcPr>.*?<\/w:tcPr>)?<\/w:tc>/, "no cell without a paragraph");
  assert.deepEqual(readDocxParagraphs(r.bytes ?? theirs).map((x) => x.text), ["Body by the agent", "One", "Two", "Three", "Four"]);
  assert.ok(r.unplaced.some((u) => /table/.test(u.why)), JSON.stringify(r.unplaced));
  assert.equal(r.copy, true);
});

test("the whole-package proof stays linear: twice the cells of a workbook, about twice its CPU time (best of 3)", async () => {
  const { xlsxBytes } = await import("./helpers/zipbuild.js");
  const { prepareMerge, handBack } = await import("../src/merge-proof.js");
  const time = (rows) => {
    const cells = {};
    for (let r = 1; r <= rows; r++) for (const c of "ABCDEFGHIJ") cells[`${c}${r}`] = r;
    const base = xlsxBytes({ Data: cells });
    cells.A1 = "edited";
    const mine = xlsxBytes({ Data: cells });
    let best = Infinity;
    for (let k = 0; k < 3; k++) {
      const u = process.cpuUsage();
      const args = { base, mine, theirs: base, merged: mine };
      const ctx = prepareMerge("xlsx", args);
      assert.deepEqual(handBack("xlsx", { ...args, ctx, unplaced: [], copy: false }), []);
      assert.equal(proveMerge("xlsx", { ...args, ctx, unplaced: [], copy: false }), null);
      const d = process.cpuUsage(u);
      best = Math.min(best, (d.user + d.system) / 1000);
    }
    return best;
  };
  const a = time(10_000);
  const b = time(20_000);
  assert.ok(b / Math.max(a, 5) < 3, `100,000 cells: ${a.toFixed(0)} ms, 200,000: ${b.toFixed(0)} ms`);
});

test("browser regression (round 7): a cell made bold in the page while the agent works is said once, by the page's own line, with a copy of the person's file; not a second line for the same bold", async () => {
  const base = book({ A1: ["Name"], A2: ["Base"] }, { B1: ["Other"] });
  const mine = book({ A1: ["Name", 1], A2: ["Mine"] }, { B1: ["Other"] });
  const theirs = book({ A1: ["Name"], A2: ["Base"] }, { B1: ["Other by the agent"] });
  const r = await merge("xlsx", base, mine, theirs, [{ kind: "format", sheet: "S" }, { kind: "cell", sheet: "S" }]);
  assert.equal(r.refused, undefined, r.refused);
  assert.deepEqual(r.unplaced.map((u) => u.why), ['You changed formatting on the sheet "S". Formatting is not carried over.']);
  assert.equal(r.copy, true, "the bold is kept in the copy of the person's file");
  assert.equal(r.merged, 1, "the value typed next to it is carried");
});

test("the copy that stands for a second line is only for a change of the same kind: a column width changed next to a bold the page named is still said", async () => {
  const S2 = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const widen = (bytes) => rezip(bytes, { "xl/worksheets/sheet1.xml": (x) => x.replace(`<worksheet ${S2}>`, `<worksheet ${S2}><cols><col min="1" max="1" width="30" customWidth="1"/></cols>`) });
  const base = book({ A1: ["Name"], A2: ["Base"] }, { B1: ["Other"] });
  const mine = widen(book({ A1: ["Name", 1], A2: ["Mine"] }, { B1: ["Other"] }));
  const theirs = book({ A1: ["Name"], A2: ["Base"] }, { B1: ["Other by the agent"] });
  const r = await merge("xlsx", base, mine, theirs, [{ kind: "format", sheet: "S" }, { kind: "cell", sheet: "S" }]);
  assert.equal(r.refused, undefined, r.refused);
  assert.equal(r.unplaced.length, 2, JSON.stringify(r.unplaced.map((u) => u.why)));
  assert.ok(r.unplaced.some((u) => /column widths/.test(u.why)));
  assert.equal(r.copy, true);
});
