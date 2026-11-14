#!/usr/bin/env node
// M4 spike tool (docs/contracts/tracked-changes.md): writes plain before/after DOCX files for the five tracked-change cases
// and, for each, a hand-built tracked copy to the planned markup, into the directory given (always a temp dir).
//   node scripts/tracked-spike/make-fixtures.mjs <outdir>
// Files: base.docx (the "before" of every case), after-<case>.docx, hand-<case>.docx (design 3(b) markup),
// hand-replace-word-idclash.docx (first revision w:id equals the bookmark's w:id), and hand-<case>-prevmark.docx for the two insert cases: the variant LibreOffice itself records, where the paragraph
// BEFORE the new one carries the inserted paragraph mark and the new paragraph keeps an unmarked mark.
// This is not the feature's builder: the diff is a common prefix/suffix over words (one changed region per paragraph),
// enough for these fixtures. The real builder (src/redline.js) diffs with diffRaw.
import fs from "node:fs";
import path from "node:path";
import { buildZip } from "../../test/helpers/zipbuild.js";

const out = process.argv[2];
if (!out) {
  console.error("usage: node scripts/tracked-spike/make-fixtures.mjs <outdir>");
  process.exit(2);
}
fs.mkdirSync(out, { recursive: true });

const AUTHOR = "Onionskin agent";
const DATE = "2026-11-11T09:05:00Z";
const NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const t = (s, tag = "w:t") => `<${tag}${/^\s|\s$/.test(s) ? ' xml:space="preserve"' : ""}>${esc(s)}</${tag}>`;

// Each style is visibly different, so a paragraph mark that takes its neighbor's properties shows up in the comparison.
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles ${NS}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>
<w:style w:type="paragraph" w:customStyle="1" w:styleId="Note"><w:name w:val="Note"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:ind w:left="720"/></w:pPr><w:rPr><w:i/><w:color w:val="1F4E79"/></w:rPr></w:style>
<w:style w:type="paragraph" w:customStyle="1" w:styleId="Signoff"><w:name w:val="Signoff"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:jc w:val="right"/></w:pPr><w:rPr><w:caps/></w:rPr></w:style>
<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:left w:w="108" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders></w:tblPr></w:style>
</w:styles>`;
const CT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`;
const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
const SECT = '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>';

// A document model: body items are {p: text, style} or {table: [[cell text]]}. One run per paragraph.
const BASE = [
  { p: "Project plan", style: "Heading1", bookmark: "plan" }, // bookmark w:id 1: revision ids start at 2 (M3)
  { p: "The team will review the draft on Monday.", style: "Normal" },
  { p: "Budget figures are due next week.", style: "Note" },
  { p: ["Each owner checks their ", { b: "own" }, " section."], style: "Normal" }, // one bold run, for rPr carry-over
  { table: [["Item", "Status"], ["Design", "Open"]] },
  { p: "Questions go to the shared inbox.", style: "Signoff" },
];
const clone = (m) => JSON.parse(JSON.stringify(m));
const CASES = {
  "replace-word": (m) => ((m[1].p = "The team will review the draft on Tuesday."), m),
  "insert-mid": (m) => (m.splice(2, 0, { p: "A short summary will follow the review.", style: "Signoff" }), m),
  "delete-mid": (m) => (m.splice(2, 1), m),
  "cell-edit": (m) => ((m[4].table[1][1] = "Closed"), m),
  "insert-end": (m) => (m.push({ p: "This plan was last checked in November.", style: "Note" }), m),
  "replace-bold": (m) => ((m[3].p = ["Each owner checks their ", { b: "assigned" }, " section."]), m),
};

const pPr = (style, mark = "") => `<w:pPr>${style && style !== "Normal" ? `<w:pStyle w:val="${style}"/>` : ""}${mark ? `<w:rPr>${mark}</w:rPr>` : ""}</w:pPr>`;
// text: a string, or an array of segments where {b: "x"} is a bold run
const B = "<w:rPr><w:b/></w:rPr>";
const runsXml = (text) => (Array.isArray(text) ? text : [text]).filter((s) => s && (s.b ?? s)).map((s) => (s.b ? `<w:r>${B}${t(s.b)}</w:r>` : `<w:r>${t(s)}</w:r>`)).join("");
const plainP = (text, style, mark = "", bookmark) =>
  `<w:p>${pPr(style, mark)}${bookmark ? `<w:bookmarkStart w:id="1" w:name="${bookmark}"/>` : ""}${runsXml(text)}${bookmark ? '<w:bookmarkEnd w:id="1"/>' : ""}</w:p>`;
const tableXml = (rows, cell = (text) => plainP(text, "Normal")) =>
  `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/><w:tblLook w:val="04A0"/></w:tblPr><w:tblGrid>${rows[0].map(() => '<w:gridCol w:w="4680"/>').join("")}</w:tblGrid>${rows
    .map((r, ri) => `<w:tr>${r.map((c, ci) => `<w:tc><w:tcPr><w:tcW w:w="4680" w:type="dxa"/></w:tcPr>${cell(c, ri, ci)}</w:tc>`).join("")}</w:tr>`)
    .join("")}</w:tbl>`;
const documentXml = (bodyInner) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${NS}><w:body>${bodyInner}${SECT}</w:body></w:document>`;
const pkg = (docXml) => buildZip({ "[Content_Types].xml": CT, "_rels/.rels": RELS, "word/document.xml": docXml, "word/_rels/document.xml.rels": DOC_RELS, "word/styles.xml": STYLES });
const plainBody = (m) => m.map((it) => (it.table ? tableXml(it.table) : plainP(it.p, it.style, "", it.bookmark))).join("");

let nextId = 2;
const rev = (kind) => `w:id="${nextId++}" w:author="${AUTHOR}" w:date="${DATE}"`;
const insRun = (text) => `<w:ins ${rev()}><w:r>${t(text)}</w:r></w:ins>`;
const delRun = (text) => `<w:del ${rev()}><w:r>${t(text, "w:delText")}</w:r></w:del>`;
const insMark = () => `<w:ins ${rev()}/>`;
const delMark = () => `<w:del ${rev()}/>`;

// In-paragraph edit: common word prefix and suffix stay plain, the middle is one w:del then one w:ins (design 3(b)).
function editedRuns(before, after) {
  const a = before.split(/(\s+)/);
  const b = after.split(/(\s+)/);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  let j = 0;
  while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
  const pre = a.slice(0, i).join("");
  const del = a.slice(i, a.length - j).join("");
  const ins = b.slice(i, b.length - j).join("");
  const suf = a.slice(a.length - j).join("");
  return `${pre ? `<w:r>${t(pre)}</w:r>` : ""}${del ? delRun(del) : ""}${ins ? insRun(ins) : ""}${suf ? `<w:r>${t(suf)}</w:r>` : ""}`;
}
const editedP = (before, after, style) => `<w:p>${pPr(style)}${editedRuns(before, after)}</w:p>`;
// Added paragraph (design): runs in w:ins and its own mark inserted.
const addedP = (text, style) => `<w:p>${pPr(style, insMark())}${insRun(text)}</w:p>`;
// Removed paragraph (design): rebuilt from BEFORE, runs in w:del (w:delText) and its own mark deleted.
const removedP = (text, style) => `<w:p>${pPr(style, delMark())}${delRun(text)}</w:p>`;

function tracked(name, variant) {
  nextId = variant === "idclash" ? 1 : 2; // idclash: the first revision reuses the bookmark's w:id 1
  const b = BASE;
  const plain = (it) => (it.table ? tableXml(it.table) : plainP(it.p, it.style, "", it.bookmark));
  let body;
  if (name === "replace-word") body = [plain(b[0]), editedP(b[1].p, CASES[name](clone(b))[1].p, b[1].style), ...b.slice(2).map(plain)].join("");
  else if (name === "insert-mid") {
    const text = "A short summary will follow the review.";
    const mid = variant === "prevmark" ? `<w:p>${pPr(b[1].style, insMark())}<w:r>${t(b[1].p)}</w:r></w:p><w:p>${pPr("Signoff")}${insRun(text)}</w:p>` : `${plain(b[1])}${addedP(text, "Signoff")}`;
    body = [plain(b[0]), mid, ...b.slice(2).map(plain)].join("");
  }
  else if (name === "delete-mid") body = [...b.slice(0, 2).map(plain), removedP(b[2].p, b[2].style), ...b.slice(3).map(plain)].join("");
  else if (name === "cell-edit")
    body = [...b.slice(0, 4).map(plain), tableXml(b[4].table, (c, ri, ci) => (ri === 1 && ci === 1 ? editedP("Open", "Closed", "Normal") : plainP(c, "Normal"))), plain(b[5])].join("");
  else if (name === "insert-end") {
    const last = b[5];
    const text = "This plan was last checked in November.";
    // design: the new last paragraph's own mark is inserted. prevmark: the previous paragraph's mark is inserted and the
    // new paragraph keeps the original final mark (the form the LibreOffice harness recorded).
    const tail = variant === "prevmark" ? `<w:p>${pPr(last.style, insMark())}<w:r>${t(last.p)}</w:r></w:p><w:p>${pPr("Note")}${insRun(text)}</w:p>` : `${plain(last)}${addedP(text, "Note")}`;
    body = [...b.slice(0, 5).map(plain), tail].join("");
  } else if (name === "replace-bold") {
    // deleted run keeps BEFORE's bold rPr, inserted run gets AFTER's bold rPr
    const p3 = `<w:p>${pPr("Normal")}<w:r>${t("Each owner checks their ")}</w:r><w:del ${rev()}><w:r>${B}${t("own", "w:delText")}</w:r></w:del><w:ins ${rev()}><w:r>${B}${t("assigned")}</w:r></w:ins><w:r>${t(" section.")}</w:r></w:p>`;
    body = [...b.slice(0, 3).map(plain), p3, ...b.slice(4).map(plain)].join("");
  }
  return pkg(documentXml(body));
}

fs.writeFileSync(path.join(out, "base.docx"), pkg(documentXml(plainBody(BASE))));
for (const name of Object.keys(CASES)) {
  fs.writeFileSync(path.join(out, `after-${name}.docx`), pkg(documentXml(plainBody(CASES[name](clone(BASE))))));
  fs.writeFileSync(path.join(out, `hand-${name}.docx`), tracked(name));
}
for (const name of ["insert-mid", "insert-end"]) fs.writeFileSync(path.join(out, `hand-${name}-prevmark.docx`), tracked(name, "prevmark"));
fs.writeFileSync(path.join(out, "hand-replace-word-idclash.docx"), tracked("replace-word", "idclash"));
console.log(`wrote base.docx, ${Object.keys(CASES).length} after/hand pairs, 2 prevmark variants and 1 idclash variant to ${out}`);
