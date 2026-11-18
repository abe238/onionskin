// Small files that are expensive to read: the shapes outside reviews used against the readers. Each is a valid package of its format.
import { buildZip, contentTypes, docxBytes } from "./zipbuild.js";

/** One paragraph with one run that carries `n` attributes. */
export const docxAttrs = (n) => docxBytes([], {}, `<w:p><w:r ${Array.from({ length: n }, (_, i) => `a${i}="1"`).join(" ")}><w:t>x</w:t></w:r></w:p>`);
/** One paragraph of `n` one-letter runs. */
export const docxRuns = (n) => docxBytes([], {}, `<w:p>${"<w:r><w:t>a</w:t></w:r>".repeat(n)}</w:p>`);
/** `n` short paragraphs. */
export const docxParas = (n) => docxBytes([], {}, "<w:p><w:r><w:t>hello world</w:t></w:r></w:p>".repeat(n));

const S = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const colName = (c) => {
  let s = "";
  for (c += 1; c > 0; c = Math.floor((c - 1) / 26)) s = String.fromCharCode(65 + ((c - 1) % 26)) + s;
  return s;
};
/** One sheet of `cells` number cells (100 per row) and `merges` one-cell-high merge ranges (A1:B1, A2:B2, ...). */
export function xlsxGrid(cells, merges = 0, { sheets = 1 } = {}) {
  const parts = [];
  const sheetXml = () => {
    const rows = [];
    for (let r = 0; r * 100 < cells; r++) {
      const n = Math.min(100, cells - r * 100);
      let row = `<row r="${r + 1}">`;
      for (let c = 0; c < n; c++) row += `<c r="${colName(c)}${r + 1}"><v>${c}</v></c>`;
      rows.push(row + "</row>");
    }
    const m = merges ? `<mergeCells count="${merges}">${Array.from({ length: merges }, (_, i) => `<mergeCell ref="A${i + 1}:B${i + 1}"/>`).join("")}</mergeCells>` : "";
    return `<?xml version="1.0"?><worksheet ${S}><sheetData>${rows.join("")}</sheetData>${m}</worksheet>`;
  };
  const one = sheetXml();
  for (let i = 0; i < sheets; i++) parts.push([`xl/worksheets/sheet${i + 1}.xml`, one]);
  const types = contentTypes("xlsx").replace("</Types>", `${parts.map(([p]) => `<Override PartName="/${p}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`);
  return buildZip({
    "[Content_Types].xml": types,
    "_rels/.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    "xl/workbook.xml": `<?xml version="1.0"?><workbook ${S}><sheets>${parts.map((_, i) => `<sheet name="S${i + 1}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${parts.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}</Relationships>`,
    ...Object.fromEntries(parts),
  });
}

/** One sheet of `cells` cells (100 per row), each pointing at the one shared string, of `len` characters. */
export function xlsxShared(cells, len) {
  const rows = [];
  for (let r = 0; r * 100 < cells; r++) {
    let row = `<row r="${r + 1}">`;
    for (let c = 0; c < Math.min(100, cells - r * 100); c++) row += `<c r="${colName(c)}${r + 1}" t="s"><v>0</v></c>`;
    rows.push(row + "</row>");
  }
  return buildZip({
    "[Content_Types].xml": contentTypes("xlsx").replace("</Types>", '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'),
    "_rels/.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    "xl/workbook.xml": `<?xml version="1.0"?><workbook ${S}><sheets><sheet name="S1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    "xl/worksheets/sheet1.xml": `<?xml version="1.0"?><worksheet ${S}><sheetData>${rows.join("")}</sheetData></worksheet>`,
    "xl/sharedStrings.xml": `<?xml version="1.0"?><sst ${S}><si><t>${"x".repeat(len)}</t></si></sst>`,
  });
}

/** One column: A1 a header of `len` characters, A2 to A`cells` the number `a2` then 1, 1, 1, ...; `name` is the sheet's name. */
export function xlsxColumn(cells, len, { a2 = "1", name = "S1" } = {}) {
  const rows = [`<row r="1"><c r="A1" t="inlineStr"><is><t>${"h".repeat(len)}</t></is></c></row>`];
  for (let r = 2; r <= cells; r++) rows.push(`<row r="${r}"><c r="A${r}"><v>${r === 2 ? a2 : "1"}</v></c></row>`);
  return buildZip({
    "[Content_Types].xml": contentTypes("xlsx").replace("</Types>", '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'),
    "_rels/.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    "xl/workbook.xml": `<?xml version="1.0"?><workbook ${S}><sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    "xl/worksheets/sheet1.xml": `<?xml version="1.0"?><worksheet ${S}><sheetData>${rows.join("")}</sheetData></worksheet>`,
  });
}

/** `slides` slides, each one text shape of `runs` one-letter runs in one paragraph. */
export function pptxRuns(slides, runs) {
  const files = {
    "[Content_Types].xml": contentTypes("pptx"),
    "_rels/.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>',
    "ppt/presentation.xml": `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst>${Array.from({ length: slides }, (_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join("")}</p:sldIdLst></p:presentation>`,
    "ppt/_rels/presentation.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${Array.from({ length: slides }, (_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`).join("")}</Relationships>`,
  };
  const slide = `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="T"/></p:nvSpPr><p:txBody><a:p>${"<a:r><a:t>a</a:t></a:r>".repeat(runs)}</a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
  for (let i = 0; i < slides; i++) files[`ppt/slides/slide${i + 1}.xml`] = slide;
  return buildZip(files);
}
