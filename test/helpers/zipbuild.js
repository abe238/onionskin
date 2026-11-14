import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { FORMATS } from "../../src/constants.js";
import { openZip } from "../../src/zip.js";

function crc32(buf) {
  let c,
    crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Builds a ZIP in memory from {name: string|Buffer}. method 8 (deflate) for all but entries named in `stored`. */
export function buildZip(files, { stored = [] } = {}) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const method = stored.includes(name) ? 0 : 8;
    const comp = method === 8 ? zlib.deflateRawSync(data) : data;
    const nameBuf = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc32(data), 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc32(data), 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

export function contentTypes(format, mainType) {
  const f = FORMATS[format];
  return `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="${f.part}" ContentType="${mainType ?? f.main}"/></Types>`;
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"';

/** A minimal DOCX. `paras` are strings or {text, paraId}. extra parts via `extra`. */
export function docxBytes(paras, extra = {}, bodyXml) {
  const body = bodyXml ?? paras.map((p) => (typeof p === "string" ? { text: p } : p)).map((p) => `<w:p${p.paraId ? ` w14:paraId="${p.paraId}"` : ""}><w:r><w:t>${p.text}</w:t></w:r></w:p>`).join("");
  return buildZip({
    "[Content_Types].xml": contentTypes("docx"),
    "_rels/.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="x/officeDocument" Target="word/document.xml"/></Relationships>',
    "word/document.xml": `<?xml version="1.0"?><w:document ${W}><w:body>${body}</w:body></w:document>`,
    ...extra,
  });
}

export const bodyDoc = (inner) => `<?xml version="1.0"?><w:document ${W}><w:body>${inner}</w:body></w:document>`;

export function tmpdir(prefix = "da-unit-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const S = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const xmlText = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const colOf = (letters) => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);

/**
 * A minimal XLSX. `sheets` is {name: {A1: value}}: a number is a number cell, a string starting with = a formula, {shared: cached}
 * a cell that takes its formula from a shared group (no formula text of its own), any other string an inline text cell.
 * Sheet ids follow the order (1, 2, ...); pass `ids` ({name: id}) to pin them.
 */
export function xlsxBytes(sheets, { ids = {} } = {}) {
  const names = Object.keys(sheets);
  const cellXml = (ref, v) => {
    if (v && typeof v === "object") return `<c r="${ref}"><f t="shared" si="0"/><v>${xmlText(v.shared)}</v></c>`;
    if (typeof v === "number") return `<c r="${ref}"><v>${v}</v></c>`;
    if (typeof v === "boolean") return `<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`;
    if (String(v).startsWith("=")) return `<c r="${ref}"><f>${xmlText(String(v).slice(1))}</f></c>`;
    return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlText(v)}</t></is></c>`;
  };
  const sheetXml = (cells) => {
    const rows = new Map();
    for (const [ref, v] of Object.entries(cells)) {
      const m = /^([A-Z]+)(\d+)$/.exec(ref);
      (rows.get(Number(m[2])) || rows.set(Number(m[2]), []).get(Number(m[2]))).push([colOf(m[1]), ref, v]);
    }
    const body = [...rows.keys()].sort((a, b) => a - b).map((r) => `<row r="${r}">${rows.get(r).sort((a, b) => a[0] - b[0]).map(([, ref, v]) => cellXml(ref, v)).join("")}</row>`).join("");
    return `<?xml version="1.0"?><worksheet ${S}><sheetData>${body}</sheetData></worksheet>`;
  };
  const types = contentTypes("xlsx").replace("</Types>", `${names.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`);
  return buildZip({
    "[Content_Types].xml": types,
    "_rels/.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    "xl/workbook.xml": `<?xml version="1.0"?><workbook ${S}><sheets>${names.map((n, i) => `<sheet name="${xmlText(n).replace(/"/g, "&quot;")}" sheetId="${ids[n] ?? i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}</Relationships>`,
    ...Object.fromEntries(names.map((n, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(sheets[n])])),
  });
}

/** The same package with some parts rewritten: `edit` is {partName: (text) => text}; null from an edit removes the part. */
export function rezip(bytes, edit) {
  const zip = openZip(bytes);
  const files = {};
  for (const name of zip.names) {
    const next = edit[name] ? edit[name](zip.readText(name)) : zip.read(name);
    if (next != null) files[name] = next;
  }
  return buildZip(files);
}
