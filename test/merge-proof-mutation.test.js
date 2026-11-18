import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { buildZip, docxBytes, rezip } from "./helpers/zipbuild.js";
import { ENGINE_SAMPLES, haveSamples, skipUnless } from "../scripts/fixtures.mjs";
import { proveMerge } from "../src/merge-proof.js";
import { mergeProven } from "../src/merge-worker.js";
import { openZip } from "../src/zip.js";

// A mutation test of the proof of a merge (src/merge-proof.js): correct merges, each result then damaged in one way at a time (a run
// property dropped, a paragraph moved into another table cell, a header changed, a shape nudged, a cell unbolded, a footnote dropped),
// on a unit the person changed and on one only the agent changed. The proof alone must refuse every damaged result.

const SAMPLES = skipUnless(haveSamples(), `engine samples not found in ${ENGINE_SAMPLES}`, "restore test/fixtures/engine or set ONIONSKIN_TEST_SAMPLES");
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

// ---- DOCX: a header, footnotes, a table of two cells, body paragraphs with bold text ----
const run = (t, bold = false) => `<w:r>${bold ? "<w:rPr><w:b/></w:rPr>" : ""}<w:t xml:space="preserve">${t}</w:t></w:r>`;
const para = (id, inner) => `<w:p w14:paraId="${String(id).padStart(8, "0")}">${inner}</w:p>`;
function docx({ header = "Header", body = {}, note = "A note" } = {}) {
  const b = { one: "First paragraph", two: "Second paragraph", three: "Third", cellA: "Cell A", cellB: "Cell B", ...body };
  const xml =
    para(1, run(b.one) + run(" bold words", true)) +
    para(2, run(b.two) + `<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="1"/></w:r>`) +
    `<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid><w:tr><w:tc>${para(3, run(b.cellA))}</w:tc><w:tc>${para(4, run(b.cellB))}</w:tc></w:tr></w:tbl>` +
    para(5, run(b.three, true)) +
    `<w:sectPr xmlns:r="${REL}"><w:headerReference w:type="default" r:id="rIdH"/></w:sectPr>`;
  return docxBytes([], {
    "word/_rels/document.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdH" Type="${REL}/header" Target="header1.xml"/><Relationship Id="rIdF" Type="${REL}/footnotes" Target="footnotes.xml"/></Relationships>`,
    "word/header1.xml": `<?xml version="1.0"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>${header}</w:t></w:r></w:p></w:hdr>`,
    "word/footnotes.xml": `<?xml version="1.0"?><w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:footnote w:id="1"><w:p><w:r><w:t>${note}</w:t></w:r></w:p></w:footnote></w:footnotes>`,
  }, xml);
}
/** a damage to one part of a result: null when it finds nothing to damage there */
const edit = (part, fn) => (bytes) => {
  const was = openZip(bytes).readText(part);
  const now = fn(was);
  return now === was ? null : rezip(bytes, { [part]: () => now });
};
const doc = (fn) => edit("word/document.xml", fn);
const DOCX_DAMAGE = {
  "a run property dropped (the agent's bold)": doc((x) => x.replace("<w:rPr><w:b/></w:rPr><w:t xml:space=\"preserve\"> bold words", "<w:t xml:space=\"preserve\"> bold words").replace(/(<w:r>)<w:rPr><w:b\/><\/w:rPr>(<w:t[^>]*> bold words)/, "$1$2")),
  "a run property dropped (the last paragraph's bold)": doc((x) => x.replace(/<w:rPr><w:b\/><\/w:rPr>(<w:t[^>]*>Third)/, "$1").replace(/<w:rPr><w:b\/>(<w:bCs\/>)?<\/w:rPr>(<w:t[^>]*>Third)/, "$2")),
  "a paragraph moved into the other table cell": doc((x) => {
    const m = /(<w:tc>)(.*?)(<\/w:tc><w:tc>)(.*?)(<\/w:tc>)/s.exec(x);
    return x.replace(m[0], `${m[1]}<w:p/>${m[3]}${m[2]}${m[4]}${m[5]}`);
  }),
  "the header changed": edit("word/header1.xml", (x) => x.replace(/<w:t>[^<]*<\/w:t>/, "<w:t>Damaged header</w:t>")),
  "a footnote dropped": edit("word/footnotes.xml", (x) => x.replace(/<w:footnote w:id="1">.*<\/w:footnote>/s, "")),
  "a footnote mark dropped": doc((x) => x.replace(/<w:r><w:rPr><w:rStyle w:val="FootnoteReference"\/><\/w:rPr><w:footnoteReference w:id="1"\/><\/w:r>/, "")),
  "a table cell's width changed": doc((x) => x.replace('<w:gridCol w:w="2000"/>', '<w:gridCol w:w="2600"/>')),
};

// ---- PPTX: two text boxes on one slide ----
let sample = null;
function deck(shapes) {
  sample ||= openZip(fs.readFileSync(path.join(ENGINE_SAMPLES, "sample.pptx")));
  const files = {};
  for (const n of sample.names) if (!/^ppt\/(slides|charts|embeddings|media)\//.test(n) && n !== "docProps/thumbnail.jpeg") files[n] = sample.read(n);
  files["[Content_Types].xml"] = sample.readText("[Content_Types].xml").replace(/<Override PartName="\/ppt\/(slides|charts)\/[^"]+"[^>]*\/>/g, "").replace("</Types>", `<Override PartName="/ppt/slides/slide256.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>`);
  files["_rels/.rels"] = sample.readText("_rels/.rels").replace(/<Relationship Id="rId2"[^>]*\/>/, "");
  files["ppt/presentation.xml"] = sample.readText("ppt/presentation.xml").replace(/<p:sldIdLst>.*<\/p:sldIdLst>/, `<p:sldIdLst><p:sldId id="256" r:id="rId256"/></p:sldIdLst>`);
  files["ppt/_rels/presentation.xml.rels"] = sample.readText("ppt/_rels/presentation.xml.rels").replace(/<Relationship Id="rId(7|8|9|10|11)"[^>]*\/>/g, "").replace("</Relationships>", `<Relationship Id="rId256" Type="${REL}/slide" Target="slides/slide256.xml"/></Relationships>`);
  const sp = shapes.map((x) => `<p:sp><p:nvSpPr><p:cNvPr id="${x.id}" name="Box ${x.id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x.x ?? 0}" y="${x.id * 1000}"/><a:ext cx="900000" cy="900000"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:p><a:r><a:rPr lang="en-US"${x.bold ? ' b="1"' : ""}/><a:t xml:space="preserve">${x.text}</a:t></a:r></a:p></p:txBody></p:sp>`).join("");
  files["ppt/slides/slide256.xml"] = `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="${REL}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${sp}</p:spTree></p:cSld></p:sld>`;
  files["ppt/slides/_rels/slide256.xml.rels"] = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout6.xml"/></Relationships>`;
  return buildZip(files);
}
const slide = (fn) => edit("ppt/slides/slide256.xml", fn);
const PPTX_DAMAGE = {
  "the person's shape nudged": slide((x) => x.replace(/(<p:cNvPr id="2"[\s\S]*?<a:off x=")(\d+)/, (_m, a, v) => `${a}${Number(v) + 12700}`)),
  "the agent's shape nudged": slide((x) => x.replace(/(<p:cNvPr id="3"[\s\S]*?<a:off x=")(\d+)/, (_m, a, v) => `${a}${Number(v) + 12700}`)),
  "a shape resized": slide((x) => x.replace(/(<p:cNvPr id="3"[\s\S]*?<a:ext cx=")(\d+)/, (_m, a, v) => `${a}${Number(v) * 2}`)),
  "a shape's text unbolded": slide((x) => x.replace(/(<p:cNvPr id="4"[\s\S]*?<a:rPr[^>]*?) b="1"/, "$1")),
  "two shapes put in another order": slide((x) => {
    const sps = x.match(/<p:sp>.*?<\/p:sp>/gs);
    return x.replace(sps[0], "\u0000").replace(sps[1], sps[0]).replace("\u0000", sps[1]);
  }),
};

// ---- XLSX: two sheets, a bold cell ----
const S = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const STYLES = `<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>`;
function book(s, t) {
  const cells = (m) => Object.entries(m).map(([ref, [v, st]]) => `<row r="${ref.slice(1)}"><c r="${ref}"${st ? ` s="${st}"` : ""} t="inlineStr"><is><t>${v}</t></is></c></row>`).join("");
  const sheet = (m) => `<?xml version="1.0"?><worksheet ${S}><cols><col min="1" max="1" width="12" customWidth="1"/></cols><sheetData>${cells(m)}</sheetData></worksheet>`;
  return buildZip({
    "[Content_Types].xml": `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    "_rels/.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0"?><workbook ${S}><sheets><sheet name="S" sheetId="1" r:id="rId1"/><sheet name="T" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL}/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="${REL}/styles" Target="styles.xml"/></Relationships>`,
    "xl/styles.xml": STYLES,
    "xl/worksheets/sheet1.xml": sheet(s),
    "xl/worksheets/sheet2.xml": sheet(t),
  });
}
const sheet = (n, fn) => edit(`xl/worksheets/sheet${n}.xml`, fn);
const XLSX_DAMAGE = {
  "a cell the agent left bold unbolded": sheet(1, (x) => x.replace(/(<c r="A2") s="1"/, "$1")),
  "the agent's bold cell unbolded": sheet(2, (x) => x.replace(/(<c r="B2") s="1"/, "$1")),
  "a carried cell made bold": sheet(1, (x) => x.replace(/(<c r="A1")/, '$1 s="1"')),
  "a column width changed": sheet(2, (x) => x.replace('width="12"', 'width="20"')),
  "the cell styles changed": edit("xl/styles.xml", (x) => x.replace("<b/>", "<i/>")),
};

const CASES = [
  { format: "docx", name: "the person edits a body paragraph, the agent the cell B", base: docx(), mine: docx({ body: { two: "Second paragraph, edited" } }), theirs: docx({ body: { cellB: "Cell B by the agent" } }), damage: DOCX_DAMAGE },
  { format: "docx", name: "the person edits a cell, the agent the first paragraph", base: docx(), mine: docx({ body: { cellA: "Cell A edited" } }), theirs: docx({ body: { one: "First paragraph by the agent" } }), damage: DOCX_DAMAGE },
  { format: "docx", name: "the agent changed the header and the note", base: docx(), mine: docx({ body: { three: "Third, edited" } }), theirs: docx({ header: "Agent header", note: "Agent note" }), damage: DOCX_DAMAGE },
  { format: "pptx", name: "the person edits box 2, the agent box 3", base: deck([{ id: 2, text: "A" }, { id: 3, text: "B" }, { id: 4, text: "C", bold: true }]), mine: deck([{ id: 2, text: "A edited" }, { id: 3, text: "B" }, { id: 4, text: "C", bold: true }]), theirs: deck([{ id: 2, text: "A" }, { id: 3, text: "B by the agent" }, { id: 4, text: "C", bold: true }]), damage: PPTX_DAMAGE, skip: SAMPLES },
  { format: "xlsx", name: "the person edits S!A1, the agent T!B1", base: book({ A1: ["Base"], A2: ["Bold", 1] }, { B1: ["Other"], B2: ["Agent bold", 1] }), mine: book({ A1: ["Mine"], A2: ["Bold", 1] }, { B1: ["Other"], B2: ["Agent bold", 1] }), theirs: book({ A1: ["Base"], A2: ["Bold", 1] }, { B1: ["Other by the agent"], B2: ["Agent bold", 1] }), damage: XLSX_DAMAGE },
];

for (const c of CASES) {
  test(`mutation (${c.format}): ${c.name}: the correct merge balances; each damage to its result is refused by the proof alone`, { skip: c.skip }, async () => {
    const r = await mergeProven({ format: c.format, base: c.base, mine: c.mine, theirs: c.theirs, name: `t.${c.format}` });
    assert.equal(r.refused, undefined, `the merge itself: ${r.refused}`);
    const result = r.bytes ?? c.theirs;
    const prove = (merged) => proveMerge(c.format, { base: c.base, mine: c.mine, theirs: c.theirs, merged, unplaced: r.unplaced, copy: r.copy });
    assert.equal(prove(result), null, "the undamaged result balances");
    const missed = [];
    let tried = 0;
    for (const [what, damage] of Object.entries(c.damage)) {
      const damaged = damage(result);
      if (!damaged) continue; // nothing of this kind in this result
      tried++;
      if (prove(damaged) === null) missed.push(what);
    }
    assert.equal(tried, Object.keys(c.damage).length, "every damage found something to damage");
    assert.deepEqual(missed, [], `damaged results the proof accepted`);
  });
}

// ---- Round 7: one mutation per row of the abstraction table (docs/DEVELOPERS.md "What the proof compares") ----
// Every hole an outside review found was a change in the PERSON's version that the proof's reading did not see. So each row is tried
// on mine: a correct merge (base, mine, theirs) first, then mine changed in exactly that content. The merge must refuse or hand back
// one more thing, and the proof alone must refuse the first answer (its result, its list) for the changed mine: the difference is
// seen. Rows the proof treats as equal by design (an equivalence with its reason in the table) are tried on the result instead, and
// must be accepted. Run with ONIONSKIN_MUTATION_REPORT=1 for the counts.

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const RELS = (extra) => `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${extra}</Relationships>`;
const NUMBERING = `<?xml version="1.0"?><w:numbering ${W_NS}><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl></w:abstractNum><w:abstractNum w:abstractNumId="2"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="o"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="2"/></w:num><w:num w:numId="3"><w:abstractNumId w:val="1"/></w:num></w:numbering>`;
const STYLES_W = `<?xml version="1.0"?><w:styles ${W_NS}><w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:pPr><w:ind w:left="720"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Quote2"><w:name w:val="quote"/></w:style></w:styles>`;
/** a DOCX with a header of a paragraph and a table, custom data, lists and styles; `body` the paragraphs after the agent's one */
function richDoc({ two = "Second paragraph", header = "Head", value = "base" } = {}) {
  const p = (id, inner, ppr = "") => `<w:p w14:paraId="${String(id).padStart(8, "0")}">${ppr ? `<w:pPr>${ppr}</w:pPr>` : ""}${inner}</w:p>`;
  const r = (t) => `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>`;
  const list = (n) => `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${n}"/></w:numPr>`;
  const body =
    p(1, r("First paragraph") + `<w:r><w:br/></w:r>` + r("after a break")) +
    p(2, r(two)) +
    p(3, r("Item one"), list(1)) +
    p(4, r("Item two"), list(1)) +
    p(5, r("Quoted words"), '<w:pStyle w:val="Quote"/>') +
    p(6, r(" spaced ")) +
    `<w:sectPr xmlns:r="${REL}"><w:headerReference w:type="default" r:id="rIdH"/></w:sectPr>`;
  return docxBytes([], {
    "word/_rels/document.xml.rels": RELS(`<Relationship Id="rIdH" Type="${REL}/header" Target="header1.xml"/><Relationship Id="rIdN" Type="${REL}/numbering" Target="numbering.xml"/><Relationship Id="rIdS" Type="${REL}/styles" Target="styles.xml"/><Relationship Id="rIdC" Type="${REL}/customXml" Target="../customXml/item1.xml"/>`),
    "word/header1.xml": `<?xml version="1.0"?><w:hdr ${W_NS}><w:p><w:r><w:t xml:space="preserve">${header} </w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:hdr>`,
    "word/numbering.xml": NUMBERING,
    "word/styles.xml": STYLES_W,
    "customXml/item1.xml": `<?xml version="1.0"?><data xmlns="urn:mydata"><value>${value}</value>after</data>`,
  }, body);
}
const STYLES_X = (font1 = "", xfs = "") => `<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font>${font1}<sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>${xfs}</cellXfs></styleSheet>`;
/** a workbook with shared strings (one with a phonetic reading), a styled column and row, two sheets */
function richBook({ b2 = "Agent", styles = STYLES_X(), sst = null, sheet1 = null, wbExtra = "", state = "" } = {}) {
  const S1 = sheet1 ?? `<cols><col min="3" max="3" width="10" style="1"/></cols><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>Plain</t></is></c></row><row r="2"><c r="B2" t="inlineStr"><is><t>${b2}</t></is></c></row><row r="3" s="1" customFormat="1"><c r="A3" t="inlineStr"><is><t>Row</t></is></c></row></sheetData>`;
  const SST = sst ?? `<si><t>東京</t><rPh sb="0" eb="2"><t>とうきょう</t></rPh><phoneticPr fontId="0" type="Hiragana"/></si>`;
  return buildZip({
    "[Content_Types].xml": `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`,
    "_rels/.rels": RELS(`<Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/>`),
    "xl/workbook.xml": `<?xml version="1.0"?><workbook ${S}><sheets><sheet name="S" sheetId="1" r:id="rId1"${state}/><sheet name="T" sheetId="2" r:id="rId2"/></sheets>${wbExtra}</workbook>`,
    "xl/_rels/workbook.xml.rels": RELS(`<Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL}/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="${REL}/styles" Target="styles.xml"/><Relationship Id="rId4" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/>`),
    "xl/styles.xml": styles,
    "xl/sharedStrings.xml": `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${SST}</sst>`,
    "xl/worksheets/sheet1.xml": `<?xml version="1.0"?><worksheet ${S}>${S1}</worksheet>`,
    "xl/worksheets/sheet2.xml": `<?xml version="1.0"?><worksheet ${S}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Other</t></is></c></row></sheetData></worksheet>`,
  });
}
/** a slide of two groups of two boxes each, and a free box the agent edits */
function groupDeck({ free = "Free box", move = false, lang = "en-US" } = {}) {
  const box = (id, t) => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Box ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="${id * 1000}"/><a:ext cx="900000" cy="900000"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:p><a:r><a:rPr lang="${lang}" dirty="0"/><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sp>`;
  const grp = (id, inner) => `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${id}" name="Group ${id}"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${inner}</p:grpSp>`;
  const tree = move ? grp(10, box(11, "One")) + grp(20, box(12, "Two") + box(21, "Three") + box(22, "Four")) : grp(10, box(11, "One") + box(12, "Two")) + grp(20, box(21, "Three") + box(22, "Four"));
  const bytes = deck([{ id: 30, text: free }]);
  return rezip(bytes, { "ppt/slides/slide256.xml": (x) => x.replace("<p:grpSpPr/>", `<p:grpSpPr/>${tree}`) });
}
const part = (name, fn) => (bytes) => {
  const was = openZip(bytes).readText(name);
  const now = fn(was);
  assert.notEqual(now, was, `the mutation found what to change in ${name}`);
  return rezip(bytes, { [name]: () => now });
};
const dOC = (fn) => part("word/document.xml", fn);
const once = (from, to) => (x) => (assert.ok(x.includes(from), `"${from}" is there`), x.replace(from, to));

// [row, format, base, mine (the correct merge's), theirs, mutation of mine]
const DOCX_B = richDoc();
const DOCX_T = richDoc({ two: "Second paragraph by the agent" });
const XLSX_B = richBook();
const XLSX_T = richBook({ b2: "Agent edited" });
const MINE_ROWS = [
  ["xml:space on a header's text (VOLATILE: the person's own bytes)", "docx", DOCX_B, DOCX_B, DOCX_T, part("word/header1.xml", once('<w:t xml:space="preserve">Head </w:t>', "<w:t>Head </w:t>"))],
  ["xml:space on body text with an edge space (unkept spaces)", "docx", DOCX_B, DOCX_B, DOCX_T, dOC(once('<w:t xml:space="preserve"> spaced </w:t>', "<w:t> spaced </w:t>"))],
  ["fullCalcOnLoad (VOLATILE: the person's own bytes)", "xlsx", XLSX_B, XLSX_B, XLSX_T, part("xl/workbook.xml", once("</sheets>", '</sheets><calcPr fullCalcOnLoad="1"/>'))],
  ["a part's root text (custom data)", "docx", DOCX_B, DOCX_B, DOCX_T, part("customXml/item1.xml", once("after", "later"))],
  ["white space in custom data", "docx", DOCX_B, DOCX_B, DOCX_T, part("customXml/item1.xml", once("<value>", " <value>"))],
  ["the order of a part's children without an identity (a header's paragraph and table)", "docx", DOCX_B, DOCX_B, DOCX_T, part("word/header1.xml", (x) => x.replace(/(<w:p>.*?<\/w:p>)(<w:tbl>.*<\/w:tbl>)/, "$2$1"))],
  ["a counted line break's own attributes (w:clear)", "docx", DOCX_B, DOCX_B, DOCX_T, dOC(once("<w:br/>", '<w:br w:clear="all"/>'))],
  ["a paragraph's style by its id (two styles named alike)", "docx", DOCX_B, DOCX_B, DOCX_T, dOC(once('<w:pStyle w:val="Quote"/>', '<w:pStyle w:val="Quote2"/>'))],
  ["a list by the definition its numId names (bullet to another bullet)", "docx", DOCX_B, DOCX_B, DOCX_T, dOC(once('<w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t xml:space="preserve">Item one', '<w:numId w:val="2"/></w:numPr></w:pPr><w:r><w:t xml:space="preserve">Item one'))],
  ["a list taken off with numId 0", "docx", DOCX_B, DOCX_B, DOCX_T, dOC(once('<w:pStyle w:val="Quote"/>', '<w:pStyle w:val="Quote"/><w:numPr><w:numId w:val="0"/></w:numPr>'))],
  ["a style definition changed in place, used by a column only (HIGH 2)", "xlsx", XLSX_B, XLSX_B, XLSX_T, part("xl/styles.xml", once("</font><font><sz", "</font><font><b/><sz"))],
  ["a cell absent under a styled column made explicit with style 0", "xlsx", XLSX_B, XLSX_B, XLSX_T, part("xl/worksheets/sheet1.xml", once('<c r="B1" t="inlineStr"><is><t>Plain</t></is></c>', '<c r="B1" t="inlineStr"><is><t>Plain</t></is></c><c r="C1"/>'))],
  ["a row's style (resolved, not its index)", "xlsx", XLSX_B, XLSX_B, XLSX_T, part("xl/worksheets/sheet1.xml", once('<row r="3" s="1" customFormat="1">', '<row r="3" s="0" customFormat="1">'))],
  ["a cell written twice at one address", "xlsx", XLSX_B, XLSX_B, XLSX_T, part("xl/worksheets/sheet1.xml", once('<c r="B1" t="inlineStr"><is><t>Plain</t></is></c>', '<c r="B1" t="inlineStr"><is><t>Plain</t></is></c><c r="B1" s="1" t="inlineStr"><is><t>Plain</t></is></c>'))],
  ["the text of a shared string's phonetic run (HIGH 1)", "xlsx", XLSX_B, XLSX_B, XLSX_T, part("xl/sharedStrings.xml", once("とうきょう", "トウキョウ"))],
  ["a phonetic run's font (resolved)", "xlsx", richBook({ styles: STYLES_X("<b/>") }), richBook({ styles: STYLES_X("<b/>") }), richBook({ styles: STYLES_X("<b/>"), b2: "Agent edited" }), part("xl/sharedStrings.xml", once('fontId="0"', 'fontId="1"'))],
  ["a sheet's state as written (hidden to very hidden)", "xlsx", richBook({ state: ' state="hidden"' }), richBook({ state: ' state="hidden"' }), richBook({ state: ' state="hidden"', b2: "Agent edited" }), part("xl/workbook.xml", once('state="hidden"', 'state="veryHidden"'))],
  ["a paragraph's alignment as written", "docx", DOCX_B, DOCX_B, DOCX_T, dOC(once('<w:pStyle w:val="Quote"/>', '<w:pStyle w:val="Quote"/><w:jc w:val="distribute"/>'))],
  ["a member of the sheet list beyond its name, id and state", "xlsx", XLSX_B, XLSX_B, XLSX_T, part("xl/workbook.xml", once('<sheet name="T" sheetId="2" r:id="rId2"/>', '<sheet name="T" sheetId="2" r:id="rId2" xmlns:x="urn:x" x:flag="1"/>'))],
];
const PPTX_ROWS = () => [
  ["a member of the slide list beyond its id (its relationship)", "pptx", groupDeck(), groupDeck(), groupDeck({ free: "Free box by the agent" }), part("ppt/presentation.xml", once('<p:sldId id="256" r:id="rId256"/>', '<p:sldId id="256" r:id="rId256" xmlns:x="urn:x" x:flag="1"/>'))],
  ["lang on a shape's run (VOLATILE: the person's own bytes, en-US to fr-FR)", "pptx", groupDeck(), groupDeck(), groupDeck({ free: "Free box by the agent" }), slide((x) => x.replace('lang="en-US" dirty="0"/><a:t>One', 'lang="fr-FR" dirty="0"/><a:t>One'))],
  ["dirty on a shape's run (VOLATILE: the person's own bytes)", "pptx", groupDeck(), groupDeck(), groupDeck({ free: "Free box by the agent" }), slide((x) => x.replace('dirty="0"/><a:t>Two', 'dirty="1"/><a:t>Two'))],
  ["a shape moved from one group into another (one mark per child)", "pptx", groupDeck(), groupDeck(), groupDeck({ free: "Free box by the agent" }), () => groupDeck({ move: true })],
];

// equivalences: meaning-preserving changes to the correct result, which the proof must accept
const EQUIV = [
  ["namespace prefixes", "docx", part("word/header1.xml", (x) => x.replace(/w:/g, "ww:").replace("xmlns:w=", "xmlns:ww="))],
  ["attribute order", "docx", part("word/document.xml", once('<w:headerReference w:type="default" r:id="rIdH"/>', '<w:headerReference r:id="rIdH" w:type="default"/>'))],
  ["an entity for a character", "docx", part("word/header1.xml", once(">Cell<", ">&#67;ell<"))],
  ["an XML comment", "docx", part("word/header1.xml", once("<w:tbl>", "<!-- note --><w:tbl>"))],
  ["white space between OOXML elements", "docx", part("word/header1.xml", once("<w:tbl>", "\n  <w:tbl>"))],
  ["an empty w:rPr", "docx", part("word/header1.xml", once("<w:r><w:t>Cell", "<w:r><w:rPr/><w:t>Cell"))],
  ["children with an identity in another order (styles)", "docx", part("word/styles.xml", (x) => x.replace(/(<w:style w:type="paragraph" w:styleId="Normal">.*?<\/w:style>)(<w:style w:type="paragraph" w:styleId="Quote">.*?<\/w:style>)/, "$2$1"))],
  ["one run split in two with the same properties", "docx", (bytes) => part("word/document.xml", once('<w:r><w:t xml:space="preserve">Quoted words</w:t></w:r>', '<w:r><w:t xml:space="preserve">Quoted </w:t></w:r><w:r><w:t xml:space="preserve">words</w:t></w:r>'))(bytes)],
];
// exemptions kept as written in the table (the person's change is not handed back, by design; reported, not counted as caught)
const EXEMPT = [
  ["a list's continuity (the same definition, restarted): a known miss, see the table", "docx", DOCX_B, DOCX_B, DOCX_T, dOC(once('<w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t xml:space="preserve">Item two', '<w:numId w:val="3"/></w:numPr></w:pPr><w:r><w:t xml:space="preserve">Item two'))],
  ["w:proofErr (spell checker marks)", "docx", DOCX_B, DOCX_B, DOCX_T, dOC(once("<w:r><w:t xml:space=\"preserve\">Quoted words", '<w:proofErr w:type="spellStart"/><w:r><w:t xml:space="preserve">Quoted words'))],
];

const mergeOf = (format, base, mine, theirs) => mergeProven({ format, base, mine, theirs, name: `t.${format}` });
const proofOf = (format, base, mine, theirs, r) => proveMerge(format, { base, mine, theirs, merged: r.bytes ?? theirs, unplaced: r.unplaced, copy: r.copy });
const report = [];
test("round 7 mutations of the person's version, one per row of the abstraction table: each is seen (the old answer is refused) and the merge refuses or hands it back", { skip: SAMPLES }, async () => {
  const missed = [];
  const rows = [...MINE_ROWS, ...PPTX_ROWS()];
  for (const [row, format, base, mine0, theirs, mutate] of rows) {
    const r0 = await mergeOf(format, base, mine0, theirs);
    assert.equal(r0.refused, undefined, `${row}: the correct merge: ${r0.refused}`);
    assert.equal(proofOf(format, base, mine0, theirs, r0), null, `${row}: the correct merge balances`);
    const mine = mutate(mine0);
    const seen = proofOf(format, base, mine, theirs, r0) !== null;
    const r = await mergeOf(format, base, mine, theirs);
    const said = !!r.refused || r.unplaced.length > r0.unplaced.length || (r.copy && !r0.copy);
    report.push(`${seen && said ? "caught" : "MISSED"}: ${row}`);
    if (!seen || !said) missed.push(`${row} (proof ${seen ? "saw it" : "did not see it"}, merge ${said ? "said it" : "said nothing"})`);
  }
  if (process.env.ONIONSKIN_MUTATION_REPORT) console.log(`${rows.length} rows:\n${report.join("\n")}`);
  assert.deepEqual(missed, []);
});

test("round 7 equivalences: a meaning-preserving change to a correct result is accepted (the table's reasons hold); the exemptions stay as the table says", async () => {
  const r0 = await mergeOf("docx", DOCX_B, DOCX_B, DOCX_T);
  const result = r0.bytes ?? DOCX_T;
  for (const [row, format, change] of EQUIV) assert.equal(proveMerge(format, { base: DOCX_B, mine: DOCX_B, theirs: DOCX_T, merged: change(result), unplaced: r0.unplaced, copy: r0.copy }), null, row);
  for (const [row, format, base, mine0, theirs, mutate] of EXEMPT) {
    const r = await mergeOf(format, base, mutate(mine0), theirs);
    assert.equal(r.refused, undefined, `${row}: ${r.refused}`);
    assert.deepEqual(r.unplaced, [], `${row}: not handed back (the table's exemption)`);
  }
});

test("round 7: a paragraph handed back cut at 2,000 characters counts only with a copy of the person's file (the rest of the text is only there)", async () => {
  const long = "x".repeat(2500);
  const base = docxBytes([], {}, `<w:p w14:paraId="00000001"><w:r><w:t>Base</w:t></w:r></w:p>`);
  const mine = docxBytes([], {}, `<w:p w14:paraId="00000001"><w:r><w:t>${long}</w:t></w:r></w:p>`);
  const theirs = docxBytes([], {}, `<w:p w14:paraId="00000001"><w:r><w:t>Agent</w:t></w:r></w:p>`);
  const cut = [{ text: long.slice(0, 2000), why: "yours", of: ["m0", "b0"] }];
  assert.match(proveMerge("docx", { base, mine, theirs, merged: theirs, unplaced: cut, copy: false }) ?? "", /text edits/);
  assert.equal(proveMerge("docx", { base, mine, theirs, merged: theirs, unplaced: cut, copy: true }), null);
  const r = await mergeOf("docx", base, mine, theirs);
  assert.equal(r.copy, true, "the merge keeps the copy itself");
});

test("round 7 agent-only content whole: a sheet the person removed is the agent's alone; its cells' formatting damaged in the result is refused (it was compared by values only)", async () => {
  const base = XLSX_B;
  const mine = part("xl/workbook.xml", once('<sheet name="T" sheetId="2" r:id="rId2"/>', ""))(base);
  const theirs = XLSX_T;
  const r0 = await mergeOf("xlsx", base, mine, theirs);
  assert.equal(r0.refused, undefined, r0.refused);
  assert.equal(proofOf("xlsx", base, mine, theirs, r0), null, "the correct merge balances");
  const damaged = part("xl/worksheets/sheet2.xml", once('<c r="A1" t="inlineStr">', '<c r="A1" s="1" t="inlineStr">'))(r0.bytes ?? theirs);
  assert.match(proveMerge("xlsx", { base, mine, theirs, merged: damaged, unplaced: r0.unplaced, copy: r0.copy }) ?? "", /the agent's sheets changed in the result/);
});

// ---- the outside review of 3f29ce5, its cases as it ran them (HIGH 4, the stall, is in test/anchors-budget.test.js) ----
const STY1 = (font1 = "") => STYLES_X(font1);
const oneSheet = (sheet, styles = STY1(), sst = null) => {
  const b = richBook({ styles, sheet1: sheet, ...(sst ? { sst } : {}) });
  return b;
};
test("HIGH 1 (3f29ce5): a shared string's phonetic reading changed from hiragana to katakana while the agent edits B2: handed back with a copy, never kept silently", async () => {
  const sheet = (b2) => `<sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="2"><c r="B2" t="inlineStr"><is><t>${b2}</t></is></c></row></sheetData>`;
  const si = (ph) => `<si><t>東京</t><rPh sb="0" eb="2"><t>${ph}</t></rPh><phoneticPr fontId="0" type="Hiragana"/></si>`;
  const [base, mine, theirs] = [oneSheet(sheet("b"), STY1(), si("とうきょう")), oneSheet(sheet("b"), STY1(), si("トウキョウ")), oneSheet(sheet("agent"), STY1(), si("とうきょう"))];
  assert.notEqual(proveMerge("xlsx", { base, mine, theirs, merged: theirs, unplaced: [], copy: false }), null, "3f29ce5's answer (nothing said) is refused");
  const r = await mergeOf("xlsx", base, mine, theirs);
  assert.equal(r.refused, undefined, r.refused);
  assert.ok(r.unplaced.length >= 1 && r.copy, JSON.stringify(r.unplaced));
});

for (const how of ["a column's style", "a row's style (customFormat)"]) {
  test(`HIGH 2 (3f29ce5): a font made bold that only ${how} uses, while the agent edits B2: handed back with a copy, never kept plain silently`, async () => {
    const sheet = (b2) => (how.startsWith("a column")
      ? `<cols><col min="1" max="1" width="10" style="1"/></cols><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Person</t></is></c></row><row r="2"><c r="B2" t="inlineStr"><is><t>${b2}</t></is></c></row></sheetData>`
      : `<sheetData><row r="1" s="1" customFormat="1"><c r="A1" t="inlineStr"><is><t>Person</t></is></c></row><row r="2"><c r="B2" t="inlineStr"><is><t>${b2}</t></is></c></row></sheetData>`);
    const [base, mine, theirs] = [oneSheet(sheet("Agent")), oneSheet(sheet("Agent"), STY1("<b/>")), oneSheet(sheet("Agent edited"))];
    assert.notEqual(proveMerge("xlsx", { base, mine, theirs, merged: theirs, unplaced: [], copy: false }), null, "3f29ce5's answer is refused");
    const r = await mergeOf("xlsx", base, mine, theirs);
    assert.equal(r.refused, undefined, r.refused);
    assert.ok(r.unplaced.some((u) => /cell styles/.test(u.why)) && r.copy, JSON.stringify(r.unplaced));
  });
}

test("HIGH 3 (3f29ce5): custom data's root text changed from base to changed while the agent edits paragraph 2: handed back with a copy", async () => {
  const p = (t, id) => `<w:p w14:paraId="0000000${id}"><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
  const mk = (v, two) => docxBytes([], { "customXml/item1.xml": `<?xml version="1.0"?><value xmlns="urn:mydata">${v}</value>`, "word/_rels/document.xml.rels": RELS(`<Relationship Id="rIdC" Type="${REL}/customXml" Target="../customXml/item1.xml"/>`) }, p("One", 1) + p(two, 2));
  const [base, mine, theirs] = [mk("base", "Two"), mk("changed", "Two"), mk("base", "Two by the agent")];
  assert.notEqual(proveMerge("docx", { base, mine, theirs, merged: theirs, unplaced: [], copy: false }), null, "3f29ce5's answer is refused");
  const r = await mergeOf("docx", base, mine, theirs);
  assert.equal(r.refused, undefined, r.refused);
  assert.ok(r.unplaced.some((u) => /custom data/.test(u.why)) && r.copy, JSON.stringify(r.unplaced));
});

test("LOW 5 (3f29ce5): \"typo\" made bold with w:b alone in \"A typo here\" while the agent edits paragraph 2: merged, nothing handed back (it was refused)", async () => {
  const two = `<w:p w14:paraId="00000002"><w:r><w:t xml:space="preserve">Second</w:t></w:r></w:p>`;
  const base = docxBytes([], {}, `<w:p w14:paraId="00000001"><w:r><w:t xml:space="preserve">A typo here</w:t></w:r></w:p>${two}`);
  const mine = docxBytes([], {}, `<w:p w14:paraId="00000001"><w:r><w:t xml:space="preserve">A </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>typo</w:t></w:r><w:r><w:t xml:space="preserve"> here</w:t></w:r></w:p>${two}`);
  const theirs = docxBytes([], {}, `<w:p w14:paraId="00000001"><w:r><w:t xml:space="preserve">A typo here</w:t></w:r></w:p>${two.replace("Second", "Second by the agent")}`);
  const r = await mergeOf("docx", base, mine, theirs);
  assert.equal(r.refused, undefined, r.refused);
  assert.deepEqual(r.unplaced, []);
  assert.match(openZip(r.bytes).readText("word/document.xml"), /<w:b\/><w:bCs\/><\/w:rPr><w:t[^>]*>typo/);
});

test("round 7 known miss, run once: a mark the person moved inside a span they also retyped is not seen (the changed-span ceiling of sameResidue, docs/DEVELOPERS.md)", async () => {
  const p = (inner) => docxBytes([], {}, `<w:p w14:paraId="00000001">${inner}</w:p><w:p w14:paraId="00000002"><w:r><w:t>Second</w:t></w:r></w:p>`);
  const base = p('<w:r><w:t xml:space="preserve">Ab</w:t></w:r><w:bookmarkStart w:id="1" w:name="m"/><w:bookmarkEnd w:id="1"/><w:r><w:t xml:space="preserve">cd</w:t></w:r>');
  const typedThenMark = p('<w:r><w:t xml:space="preserve">Abxyz</w:t></w:r><w:bookmarkStart w:id="1" w:name="m"/><w:bookmarkEnd w:id="1"/><w:r><w:t xml:space="preserve">cd</w:t></w:r>');
  const markThenTyped = p('<w:r><w:t xml:space="preserve">Ab</w:t></w:r><w:bookmarkStart w:id="1" w:name="m"/><w:bookmarkEnd w:id="1"/><w:r><w:t xml:space="preserve">xyzcd</w:t></w:r>');
  const theirs = rezip(base, { "word/document.xml": (x) => x.replace(">Second<", ">Second by the agent<") });
  const r = await mergeOf("docx", base, typedThenMark, theirs);
  assert.equal(r.refused, undefined, r.refused);
  // the person's mark stands after the typing; the result may have it before: the proof accepts either (the known miss)
  const other = rezip(r.bytes ?? theirs, { "word/document.xml": (x) => (x.includes("Abxyz") ? x.replace(/<w:r>(<w:rPr>.*?<\/w:rPr>)?<w:t[^>]*>Abxyz<\/w:t><\/w:r>/, '<w:r><w:t xml:space="preserve">Ab</w:t></w:r>').replace(/(<w:bookmarkEnd w:id="1"\/>)/, '$1<w:r><w:t xml:space="preserve">xyz</w:t></w:r>') : x) });
  const why = proveMerge("docx", { base, mine: typedThenMark, theirs, merged: other, unplaced: r.unplaced, copy: r.copy });
  // the documented miss: when the proof starts to see it, take the row out of the table's known misses
  assert.equal(why, null, `the proof now sees it (${why}): update docs/DEVELOPERS.md`);
  assert.ok(markThenTyped.length > 0);
});

// Round 8, MEDIUM 2: custom data whose children carry an id (or a name) was compared as if their order did not matter, because an
// identity attribute made a child a unit found wherever it stood. In custom data the order is the data's own. Only the collections the
// formats define as unordered are exempt (src/merge-package.js UNORDERED).
for (const [label, attr] of [["id", "id"], ["name", "name"]]) {
  test(`round 8 MEDIUM 2: the person reverses custom data's children (with ${label} attributes) and types in paragraph 1, the agent edits paragraph 2: handed back with a copy`, async () => {
    const items = (order) => `<?xml version="1.0"?><items xmlns="urn:mydata">${order.map(([k, v]) => `<item ${attr}="${k}">${v}</item>`).join("")}</items>`;
    const p = (t, id) => `<w:p w14:paraId="0000000${id}"><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
    const mk = (order, one, two) => docxBytes([], { "customXml/item1.xml": items(order), "word/_rels/document.xml.rels": RELS(`<Relationship Id="rIdC" Type="${REL}/customXml" Target="../customXml/item1.xml"/>`) }, p(one, 1) + p(two, 2));
    const AB = [["a", "First"], ["b", "Second"]];
    const BA = [["b", "Second"], ["a", "First"]];
    const [base, mine, theirs] = [mk(AB, "One", "Two"), mk(BA, "One Person typed", "Two"), mk(AB, "One", "Two by the agent")];
    const r = await mergeOf("docx", base, mine, theirs);
    assert.equal(r.refused, undefined, r.refused);
    assert.ok(r.copy, "a copy of the person's version is kept");
    assert.ok(r.unplaced.some((u) => /custom data/.test(u.why)), JSON.stringify(r.unplaced));
    // the old answer (body edits merged, custom data in the agent's order, nothing handed back) is refused by the proof
    const merged = rezip(theirs, { "word/document.xml": (x) => x.replace(">One<", ">One Person typed<") });
    assert.notEqual(proveMerge("docx", { base, mine, theirs, merged, unplaced: [], copy: false }), null);
  });
}

// Round 9 (eighth review, MEDIUM): two paragraph styles both marked w:default="1" (Plain: bold off; Bold: bold on). Word takes the first,
// so reversing them changes every paragraph without a style. The person reversed them and typed in paragraph 1, the agent edited
// paragraph 2: it was merged as ok, nothing handed back, the agent's order kept. Same for table styles.
for (const type of ["paragraph", "table"]) {
  test(`round 9: the person reverses two ${type} styles that are both the default, and types in paragraph 1, the agent edits paragraph 2: never merged as no change`, async () => {
    const p = (t, id) => `<w:p w14:paraId="0000000${id}"><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
    const sty = { Plain: `<w:style w:type="${type}" w:default="1" w:styleId="Plain"><w:name w:val="Plain"/><w:rPr><w:b w:val="0"/></w:rPr></w:style>`, Bold: `<w:style w:type="${type}" w:default="1" w:styleId="Bold"><w:name w:val="Bold"/><w:rPr><w:b/></w:rPr></w:style>` };
    const styles = (order) => `<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${order.map((k) => sty[k]).join("")}</w:styles>`;
    const mk = (order, one, two) => docxBytes([], { "word/styles.xml": styles(order), "word/_rels/document.xml.rels": RELS(`<Relationship Id="rIdS" Type="${REL}/styles" Target="styles.xml"/>`) }, p(one, 1) + p(two, 2));
    const [base, mine, theirs] = [mk(["Plain", "Bold"], "One", "Two"), mk(["Bold", "Plain"], "One Person typed", "Two"), mk(["Plain", "Bold"], "One", "Two by the agent")];
    const r = await mergeOf("docx", base, mine, theirs);
    assert.equal(r.refused, undefined, r.refused);
    const order = (bytes) => [...openZip(bytes).readText("word/styles.xml").matchAll(/w:styleId="(\w+)"/g)].map((m) => m[1]).join(",");
    assert.ok(r.copy || order(r.bytes) === "Bold,Plain", `merged order ${order(r.bytes)}, copy ${r.copy}, unplaced ${JSON.stringify(r.unplaced)}`);
    // the old answer (the agent's order, nothing handed back) is refused by the proof
    const merged = rezip(theirs, { "word/document.xml": (x) => x.replace(">One<", ">One Person typed<") });
    assert.notEqual(proveMerge("docx", { base, mine, theirs, merged, unplaced: [], copy: false }), null);
  });
}

// Round 10 (ninth review, MEDIUM): Plain omits w:type, which Word and the engine read as paragraph, and Bold says paragraph: the proof
// grouped Plain apart, so the person's reversal was merged as no change and their default Plain became Bold. The same with the styles
// part written under a prefix other than w bound to the same namespace, and with an attribute named type from another namespace.
for (const [label, plain, bold, pre] of [
  ["Plain omits w:type", `<w:style w:default="1" w:styleId="Plain">`, `<w:style w:type="paragraph" w:default="1" w:styleId="Bold">`, "w"],
  ["the prefix is x, bound to the same namespace", `<x:style x:default="1" x:styleId="Plain">`, `<x:style x:type="paragraph" x:default="1" x:styleId="Bold">`, "x"],
  ["Plain carries o:type from another namespace", `<w:style o:type="table" w:default="1" w:styleId="Plain">`, `<w:style w:type="paragraph" w:default="1" w:styleId="Bold">`, "w"],
  ["the attributes have no prefix (they counted before, and still do)", `<w:style default="1" w:styleId="Plain">`, `<w:style type="paragraph" default="1" w:styleId="Bold">`, "w"],
]) {
  test(`round 10: the person reverses two default paragraph styles where ${label}, and types in paragraph 1, the agent edits paragraph 2: never merged as no change`, async () => {
    const p = (t, id) => `<w:p w14:paraId="0000000${id}"><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
    const sty = { Plain: `${plain}<${pre}:name ${pre}:val="Plain"/><${pre}:rPr><${pre}:b ${pre}:val="0"/></${pre}:rPr></${pre}:style>`, Bold: `${bold}<${pre}:name ${pre}:val="Bold"/><${pre}:rPr><${pre}:b/></${pre}:rPr></${pre}:style>` };
    const styles = (order) => `<?xml version="1.0"?><${pre}:styles xmlns:${pre}="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:o="urn:other">${order.map((k) => sty[k]).join("")}</${pre}:styles>`;
    const mk = (order, one, two) => docxBytes([], { "word/styles.xml": styles(order), "word/_rels/document.xml.rels": RELS(`<Relationship Id="rIdS" Type="${REL}/styles" Target="styles.xml"/>`) }, p(one, 1) + p(two, 2));
    const [base, mine, theirs] = [mk(["Plain", "Bold"], "One", "Two"), mk(["Bold", "Plain"], "One Person typed", "Two"), mk(["Plain", "Bold"], "One", "Two by the agent")];
    const r = await mergeOf("docx", base, mine, theirs);
    assert.equal(r.refused, undefined, r.refused);
    const order = (bytes) => [...openZip(bytes).readText("word/styles.xml").matchAll(/:styleId="(\w+)"/g)].map((m) => m[1]).join(",");
    assert.ok(r.copy || order(r.bytes) === "Bold,Plain", `merged order ${order(r.bytes)}, copy ${r.copy}, unplaced ${JSON.stringify(r.unplaced)}`);
    const merged = rezip(theirs, { "word/document.xml": (x) => x.replace(">One<", ">One Person typed<") });
    assert.notEqual(proveMerge("docx", { base, mine, theirs, merged, unplaced: [], copy: false }), null);
  });
}

test("round 9: defaults of different types (paragraph, table, numbering) reordered against each other are no change", () => {
  const p = (t, id) => `<w:p w14:paraId="0000000${id}"><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
  const sty = [`<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>`, `<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/></w:style>`, `<w:style w:type="numbering" w:default="1" w:styleId="NoList"><w:name w:val="No List"/></w:style>`];
  const styles = (order) => `<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${order.map((i) => sty[i]).join("")}</w:styles>`;
  const mk = (order, two) => docxBytes([], { "word/styles.xml": styles(order), "word/_rels/document.xml.rels": RELS(`<Relationship Id="rIdS" Type="${REL}/styles" Target="styles.xml"/>`) }, p("One", 1) + p(two, 2));
  const [base, mine, theirs] = [mk([0, 1, 2], "Two"), mk([2, 0, 1], "Two"), mk([0, 1, 2], "Two by the agent")];
  assert.equal(proveMerge("docx", { base, mine, theirs, merged: theirs, unplaced: [], copy: false }), null);
});

test("round 8 MEDIUM 2: the collections the formats define as unordered still compare without their order (relationships, content types, styles)", async () => {
  const p = (t, id) => `<w:p w14:paraId="0000000${id}"><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
  const rels = (rev) => RELS((rev ? [1, 0] : [0, 1]).map((i) => [`<Relationship Id="rIdC" Type="${REL}/customXml" Target="../customXml/item1.xml"/>`, `<Relationship Id="rIdS" Type="${REL}/styles" Target="styles.xml"/>`][i]).join(""));
  const styles = (rev) => `<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${(rev ? [1, 0] : [0, 1]).map((i) => [`<w:style w:type="paragraph" w:styleId="A"><w:name w:val="A"/></w:style>`, `<w:style w:type="paragraph" w:styleId="B"><w:name w:val="B"/></w:style>`][i]).join("")}</w:styles>`;
  const mk = (rev, two) => docxBytes([], { "customXml/item1.xml": `<?xml version="1.0"?><v xmlns="urn:d">x</v>`, "word/_rels/document.xml.rels": rels(rev), "word/styles.xml": styles(rev) }, p("One", 1) + p(two, 2));
  const [base, mine, theirs] = [mk(false, "Two"), mk(true, "Two"), mk(false, "Two by the agent")];
  assert.equal(proveMerge("docx", { base, mine, theirs, merged: theirs, unplaced: [], copy: false }), null, "reordering what has no order is no change");
});

// Round 8, LOW 3: an on/off run property written val="true" ("typo" made bold as <w:b w:val="true"/>) was compared as a different
// property from the <w:b/> the merge writes, and the proof refused an ordinary merge.
for (const val of [' w:val="true"', ' w:val="1"', ' w:val="on"']) {
  test(`round 8 LOW 3: "typo" made bold with <w:b${val}/> in "A typo here" while the agent edits paragraph 2: merged, nothing handed back`, async () => {
    const two = `<w:p w14:paraId="00000002"><w:r><w:t xml:space="preserve">Second</w:t></w:r></w:p>`;
    const base = docxBytes([], {}, `<w:p w14:paraId="00000001"><w:r><w:t xml:space="preserve">A typo here</w:t></w:r></w:p>${two}`);
    const mine = docxBytes([], {}, `<w:p w14:paraId="00000001"><w:r><w:t xml:space="preserve">A </w:t></w:r><w:r><w:rPr><w:b${val}/></w:rPr><w:t>typo</w:t></w:r><w:r><w:t xml:space="preserve"> here</w:t></w:r></w:p>${two}`);
    const theirs = docxBytes([], {}, `<w:p w14:paraId="00000001"><w:r><w:t xml:space="preserve">A typo here</w:t></w:r></w:p>${two.replace("Second", "Second by the agent")}`);
    const r = await mergeOf("docx", base, mine, theirs);
    assert.equal(r.refused, undefined, r.refused);
    assert.deepEqual(r.unplaced, []);
  });
}

test("round 8 LOW 3: every on/off spelling reads as one property, for bold, italic, strike and caps; written off is not absent", async () => {
  const { canonical } = await import("../src/merge-package.js");
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const rpr = (inner) => canonical(`<w:rPr ${W}>${inner}</w:rPr>`);
  for (const el of ["b", "i", "strike", "caps"]) {
    const on = rpr(`<w:${el}/>`);
    for (const v of ["true", "1", "on"]) assert.equal(rpr(`<w:${el} w:val="${v}"/>`), on, `${el} ${v}`);
    const off = rpr(`<w:${el} w:val="0"/>`);
    for (const v of ["false", "off"]) assert.equal(rpr(`<w:${el} w:val="${v}"/>`), off, `${el} ${v}`);
    assert.notEqual(off, on, `${el}: off is not on`);
    assert.notEqual(off, rpr(""), `${el}: written off is not absent (a style may turn it on)`);
  }
  // not an on/off property: an underline's kind is kept as written
  assert.notEqual(rpr('<w:u w:val="single"/>'), rpr("<w:u/>"));
  // a paragraph property too
  const ppr = (inner) => canonical(`<w:pPr ${W}>${inner}</w:pPr>`);
  assert.equal(ppr('<w:keepNext w:val="true"/>'), ppr("<w:keepNext/>"));
  // DrawingML run properties: b and i are xsd:boolean attributes
  const arpr = (attrs) => canonical(`<a:rPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ${attrs}/>`);
  assert.equal(arpr('b="true" i="false"'), arpr('b="1" i="0"'));
  assert.notEqual(arpr('b="0"'), arpr('b="1"'));
});

test("round 9: SpreadsheetML font properties read every boolean spelling as one (<b/>, <b val=\"1\"/>, <b val=\"true\"/>); off is not on, and not absent", async () => {
  const { canonical } = await import("../src/merge-package.js");
  const font = (inner) => canonical(`<font xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${inner}</font>`);
  for (const el of ["b", "i", "strike", "outline", "shadow", "condense", "extend"]) {
    const on = font(`<${el}/>`);
    for (const v of ["true", "1"]) assert.equal(font(`<${el} val="${v}"/>`), on, `${el} ${v}`);
    assert.equal(font(`<${el} val="false"/>`), font(`<${el} val="0"/>`), `${el} off`);
    assert.notEqual(font(`<${el} val="0"/>`), on);
    assert.notEqual(font(`<${el} val="0"/>`), font(""));
  }
  assert.notEqual(font('<u val="double"/>'), font("<u/>"), "an underline's kind is kept as written");
});

test("round 8 LOW 3: bold written off (w:val=\"false\") on a run whose style is bold, while the agent edits paragraph 2: never merged as no change", async () => {
  const two = `<w:p w14:paraId="00000002"><w:r><w:t xml:space="preserve">Second</w:t></w:r></w:p>`;
  const STY = `<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Strong"><w:name w:val="Strong"/><w:rPr><w:b/></w:rPr></w:style></w:styles>`;
  const doc = (run, t2 = two) => docxBytes([], { "word/styles.xml": STY, "word/_rels/document.xml.rels": RELS(`<Relationship Id="rIdS" Type="${REL}/styles" Target="styles.xml"/>`) }, `<w:p w14:paraId="00000001"><w:pPr><w:pStyle w:val="Strong"/></w:pPr>${run}</w:p>${t2}`);
  const plain = '<w:r><w:t xml:space="preserve">A typo here</w:t></w:r>';
  const [base, mine, theirs] = [doc(plain), doc('<w:r><w:rPr><w:b w:val="false"/></w:rPr><w:t xml:space="preserve">A typo here</w:t></w:r>'), doc(plain, two.replace("Second", "Second by the agent"))];
  assert.notEqual(proveMerge("docx", { base, mine, theirs, merged: theirs, unplaced: [], copy: false }), null, "the person's change is seen");
  const r = await mergeOf("docx", base, mine, theirs);
  assert.equal(r.refused, undefined, r.refused);
  assert.equal(proofOf("docx", base, mine, theirs, r), null);
});
