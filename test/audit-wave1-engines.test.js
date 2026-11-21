import assert from "node:assert/strict";
import { test } from "node:test";
import zlib from "node:zlib";
import "../src/html-parser.js";
import * as H from "../src/html.js";
import { utf8Bytes } from "../src/html-utf8.js";
import { renderCopy, RENDER_LIMITS } from "../src/html-render.js";
import { parseDocxParagraphs, resolveDurable } from "../src/docx.js";
import { docxUnits } from "../src/merge-package.js";
import { parseDeck, pptxDurable, resolvePptx } from "../src/pptx.js";
import { scanBudget } from "../src/text.js";
import { openZip, ZipError } from "../src/zip.js";
import { replaceEntry } from "../src/zip-write.js";
import { runOps } from "../src/ops/run.js";
import { exec as pptxExec } from "../src/ops/pptx.js";
import { bodyDoc, buildZip, contentTypes, docxBytes, xlsxBytes } from "./helpers/zipbuild.js";

function pptxBytes(shapesXml) {
  return buildZip({
    "[Content_Types].xml": contentTypes("pptx"),
    "_rels/.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="x/officeDocument" Target="ppt/presentation.xml"/></Relationships>',
    "ppt/presentation.xml": '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>',
    "ppt/_rels/presentation.xml.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>',
    "ppt/slides/slide1.xml": `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shapesXml}</p:spTree></p:cSld></p:sld>`,
  });
}

// ---- ENG-01: XLSX replace_all_text after structural edit & live cellText re-read ------------------------------------------------------

test("ENG-01: xlsx bind() refuses replace_all_text after structural edit with after_structural_edit", async () => {
  const bytes = xlsxBytes({ Sheet1: { A1: "foo", A2: "bar" } });
  const res = await runOps({
    bytes,
    format: "xlsx",
    name: "test.xlsx",
    ops: [
      { op: "insert_rows", target: { sheet: "Sheet1", at: 1, count: 1 }, expect: { text: "foo" } },
      { op: "replace_all_text", find: "bar", replace: "baz", expect: { count: 1 } },
    ],
  });
  assert.equal(res.results[1].status, "refused");
  assert.equal(res.results[1].code, "after_structural_edit");
});

test("ENG-01: xlsx exec() re-reads live cellText for replace_all_text and detects count mismatch", async () => {
  const bytes = xlsxBytes({ Sheet1: { A1: "foo old", A2: "alpha" } });

  // Case A: earlier set_cells changes non-matching text in A1 while keeping the match count (1); replace_all_text preserves "new"
  const okRes = await runOps({
    bytes,
    format: "xlsx",
    name: "test.xlsx",
    ops: [
      { op: "set_cells", target: { sheet: "Sheet1", range: "A1" }, expect: { text: "foo old" }, values: "foo new" },
      { op: "replace_all_text", find: "foo", replace: "bar", expect: { count: 1 } },
    ],
  });
  assert.equal(okRes.results[0].status, "applied");
  assert.equal(okRes.results[1].status, "applied");
  const z = openZip(okRes.bytes);
  const sheetXml = z.readText("xl/worksheets/sheet1.xml");
  assert.match(sheetXml, /bar new/);
  assert.doesNotMatch(sheetXml, /bar old/);

  // Case B: earlier set_cells removes the match in A1 -> replace_all_text returns incomplete_replace (and partial mode keeps A1)
  const badRes = await runOps({
    bytes,
    format: "xlsx",
    name: "test.xlsx",
    partial: true,
    ops: [
      { op: "set_cells", target: { sheet: "Sheet1", range: "A1" }, expect: { text: "foo old" }, values: "changed" },
      { op: "replace_all_text", find: "foo", replace: "bar", expect: { count: 1 } },
    ],
  });
  assert.equal(badRes.results[0].status, "applied");
  assert.equal(badRes.results[1].status, "refused");
  assert.equal(badRes.results[1].code, "incomplete_replace");
  assert.match(openZip(badRes.bytes).readText("xl/worksheets/sheet1.xml"), /changed/);
});

// ---- ENG-04: PPTX replace_all_text pre-computes specs before mutating any shape -------------------------------------------------------

test("ENG-04: pptx replace_all_text pre-computes specs for all shapes before calling pptx.setText", async () => {
  const setCalls = [];
  const fakeModel = {
    els: [
      {
        sid: 2,
        text: {
          paras: [
            { ro: false, runs: [{ text: "hello", fld: false }] },
          ],
        },
      },
      {
        sid: 3,
        text: {
          paras: [
            { ro: false, runs: [{ text: "hello", fld: true }] },
          ],
        },
      },
    ],
  };
  const st = {
    slides: [{ id: "256", index: 0 }],
    models: new Map(),
    h: {
      engine: {
        async call(method, args) {
          if (method === "pptx.slide") return fakeModel;
          if (method === "pptx.setText") {
            setCalls.push(args);
            return;
          }
          throw new Error(`unexpected ${method}`);
        },
      },
    },
  };
  const b = {
    op: { op: "replace_all_text", find: "hello", replace: "world", match_case: true },
    total: 2,
    hits: [
      { slideId: "256", sid: 2, pi: 0, ro: false, n: 1 },
      { slideId: "256", sid: 3, pi: 0, ro: false, n: 1 },
    ],
  };
  const r = await pptxExec(st, b);
  assert.equal(r.status, "refused");
  assert.equal(r.code, "match_in_field");
  assert.equal(setCalls.length, 0, "shape 1 was never mutated before shape 2 threw RangeError");

  // Defense in depth: if a RangeError occurs after a mutation already happened, dirty: true is set
  const fakeModelOk = {
    els: [
      { sid: 2, text: { paras: [{ ro: false, runs: [{ text: "hello", fld: false }] }] } },
      { sid: 3, text: { paras: [{ ro: false, runs: [{ text: "hello", fld: false }] }] } },
    ],
  };
  let nCalls = 0;
  const st2 = {
    slides: [{ id: "256", index: 0 }],
    models: new Map(),
    h: {
      engine: {
        async call(method) {
          if (method === "pptx.slide") return fakeModelOk;
          if (method === "pptx.setText") {
            nCalls++;
            if (nCalls === 2) throw new RangeError("simulated field error on 2nd write");
            return;
          }
        },
      },
    },
  };
  const r2 = await pptxExec(st2, b);
  assert.equal(r2.status, "refused");
  assert.equal(r2.code, "match_in_field");
  assert.equal(r2.dirty, true);
});

// ---- ENG-02: html-render data: stylesheet limits & importDepth before data: branch -----------------------------------------------------

test("ENG-02: importDepth is enforced before data: branch and data: stylesheets enforce sheet & cssBytes limits", () => {
  const files = {};
  for (let i = 0; i <= 5; i++) {
    const next = i === 5 ? "data:text/css,.deep%7Bcolor:red%7D" : `s${i + 1}.css`;
    files[`s${i}.css`] = Buffer.from(`@import "${next}"; .l${i}{margin:0}`);
  }
  const rDepth = renderCopy(H.readHtml(Buffer.from('<link rel="stylesheet" href="s0.css"><p>x</p>')), {
    fileDir: "/onionskin-test/dir",
    readAsset: (segs) => {
      const b = files[segs.join("/")];
      return b ? { ok: true, bytes: b, key: segs.join("/") } : { ok: false, code: "not_found" };
    },
  });
  assert.equal(rDepth.stats.styles.left.import_depth, 1);
  assert.doesNotMatch(rDepth.bytes.toString(), /\.deep/);

  const tinyLimits = { ...RENDER_LIMITS, sheet: 20, cssBytes: 30 };
  const overSheet = encodeURIComponent("p{color:red;margin:10px}");
  const rSheet = renderCopy(H.readHtml(Buffer.from(`<link rel="stylesheet" href="data:text/css,${overSheet}"><p>x</p>`)), {
    fileDir: "/onionskin-test/dir",
    limits: tinyLimits,
  });
  assert.equal(rSheet.stats.assets.refused.too_large, 1);
  assert.doesNotMatch(rSheet.bytes.toString(), /<style/);

  const s1 = encodeURIComponent("a{color:red}"); // 12 bytes
  const s2 = encodeURIComponent("b{color:blue}"); // 13 bytes
  const s3 = encodeURIComponent("c{color:green}"); // 14 bytes (12+13+14 = 39 > 30)
  const rCapLink = renderCopy(
    H.readHtml(Buffer.from(`<link rel="stylesheet" href="data:text/css,${s1}"><link rel="stylesheet" href="data:text/css,${s2}"><link rel="stylesheet" href="data:text/css,${s3}"><p>x</p>`)),
    { fileDir: "/onionskin-test/dir", limits: tinyLimits },
  );
  assert.equal(rCapLink.stats.styles.heavy, "css_bytes");
  assert.equal(rCapLink.stats.assets.refused.css_cap, 1);
  assert.doesNotMatch(rCapLink.bytes.toString(), /<style/);

  const imp1 = `@import "data:text/css,${s1}";`;
  const imp2 = `@import "data:text/css,${s2}";`;
  const styleLen = Buffer.byteLength(imp1 + imp2);
  const rCapImport = renderCopy(
    H.readHtml(Buffer.from(`<style>${imp1}${imp2}</style><p>x</p>`)),
    { fileDir: "/onionskin-test/dir", limits: { ...RENDER_LIMITS, sheet: 100, cssBytes: styleLen + 15 } },
  );
  assert.equal(rCapImport.stats.styles.heavy, "css_bytes");
  assert.equal(rCapImport.stats.assets.refused.css_cap, 1);
  assert.doesNotMatch(rCapImport.bytes.toString(), /<style/);
});

// ---- ENG-03: Unicode whitespace collapse & linear url() scanner ------------------------------------------------------------------------

test("ENG-03: unclosed url(\\u00A0...) and @import url(\\u00A0...) run in linear time", () => {
  const nbsp = "\u00A0".repeat(500_000);
  for (const html of [
    `<p style="background: url(${nbsp}x">x</p>`,
    `<style>p{background:url(${nbsp}x}</style><p>x</p>`,
    `<style>@import url(${nbsp}x</style><p>x</p>`,
  ]) {
    const read = H.readHtml(Buffer.from(html));
    const t0 = process.cpuUsage();
    const r = renderCopy(read, { fileDir: "/onionskin-test/dir" });
    const dt = process.cpuUsage(t0);
    assert.ok((dt.user + dt.system) / 1000 < 1500, `took ${Math.round((dt.user + dt.system) / 1000)} ms`);
    assert.ok(!r.plain);
  }
});

// ---- ENG-15: declaredCharset & utf8Bytes ignore HTML comments --------------------------------------------------------------------------

test("ENG-15: declaredCharset and utf8Bytes ignore meta tags inside HTML comments", () => {
  const utf8WithCommentedMeta = Buffer.from('<!-- <meta charset="windows-1252"> --><meta charset="utf-8"><p>caf\u00e9</p>', "utf8");
  const dec1 = H.decodeHtml(utf8WithCommentedMeta);
  assert.equal(dec1.ok, true);
  assert.equal(dec1.declared, "utf-8");

  const winWithCommentedUtf8 = Buffer.from('<!-- <meta charset="utf-8"> --><meta charset="windows-1252"><p>caf\xe9</p>', "latin1");
  const dec2 = H.decodeHtml(winWithCommentedUtf8);
  assert.equal(dec2.ok, false);
  assert.equal(dec2.label, "windows-1252");
  assert.equal(dec2.copyable, true);

  const winWithCommentedWin = Buffer.from('<!-- <meta charset="windows-1252"> --><meta charset="windows-1252"><p>caf\xe9</p>', "latin1");
  const conv = utf8Bytes(winWithCommentedWin);
  assert.equal(conv.ok, true);
  const outStr = conv.bytes.toString("utf8");
  assert.match(outStr, /^<!-- <meta charset="windows-1252"> --><meta charset="utf-8">/);
});

// ---- ENG-05: DOCX mc:Fallback, nested text-box w:p, and w:moveFrom ---------------------------------------------------------------------

test("ENG-05: parseDocxParagraphs and docxUnits skip mc:Fallback, isolate nested w:p, and exclude w:moveFrom", () => {
  const inner =
    '<w:p w14:paraId="00000001">' +
      '<w:pPr><w:pStyle w:val="OuterStyle"/><w:jc w:val="left"/></w:pPr>' +
      '<w:r><w:t>Before </w:t></w:r>' +
      '<w:moveFrom><w:r><w:t>Moved</w:t></w:r></w:moveFrom>' +
      '<mc:AlternateContent><mc:Choice Requires="wps">' +
        '<w:r><w:drawing><wps:txbx><w:txbxContent><w:p>' +
          '<w:pPr><w:pStyle w:val="BoxStyle"/><w:jc w:val="right"/></w:pPr>' +
          '<w:r><w:rPr><w:b/></w:rPr><w:t>InBox</w:t></w:r>' +
        '</w:p></w:txbxContent></wps:txbx></w:drawing></w:r>' +
      '</mc:Choice><mc:Fallback>' +
        '<w:r><w:t>FallbackText</w:t></w:r>' +
      '</mc:Fallback></mc:AlternateContent>' +
      '<w:r><w:t> After</w:t></w:r>' +
    '</w:p>' +
    '<mc:AlternateContent><mc:Choice Requires="x"/><mc:Fallback><w:p><w:r><w:t>TopLevelFallback</w:t></w:r></w:p></mc:Fallback></mc:AlternateContent>';

  const doc = bodyDoc(inner);
  const ps = parseDocxParagraphs(doc, { detail: true });
  assert.equal(ps.length, 1);
  assert.equal(ps[0].text, "Before \ufffc After");
  assert.equal(ps[0].style, "OuterStyle");
  assert.equal(ps[0].align, "left");
  assert.equal(ps[0].fmt?.b, undefined);

  const intern = { m: new Map(), id(s) { if (!this.m.has(s)) this.m.set(s, this.m.size + 1); return this.m.get(s); } };
  const units = docxUnits(doc, intern);
  assert.equal(units.paras.length, 1);
  assert.equal(units.paras[0].text, "Before \ufffc After");
  assert.ok(!units.paras[0].mod["w:pStyle"]?.includes("BoxStyle"));
  assert.ok(!units.paras[0].mod["w:jc"]?.includes("right"));
});

// ---- ENG-06: DOCX & PPTX normalized quote fallback with raw UTF-16 offsets -------------------------------------------------------------

test("ENG-06: resolveDurable and resolvePptx fall back to normalized match mapped to raw UTF-16 offsets", () => {
  const cases = [
    { raw: "alpha\nbeta", quote: "alpha beta", want: "alpha\nbeta" },
    { raw: "alpha\t\u00A0  beta", quote: "alpha beta", want: "alpha\t\u00A0  beta" },
    { raw: "Visit cafe\u0301 now", quote: "caf\u00e9", want: "cafe\u0301" },
  ];

  for (const { raw, quote, want } of cases) {
    const doc = bodyDoc(`<w:p w14:paraId="12345678"><w:r><w:t xml:space="preserve">${raw.replace("\n", "</w:t><w:br/><w:t xml:space=\"preserve\">").replace("\t", "</w:t><w:tab/><w:t xml:space=\"preserve\">")}</w:t></w:r></w:p>`);
    const ps = parseDocxParagraphs(doc);
    const d = { format: "docx", paraId: "12345678", path: ps[0].path, paraText: raw, quote, prefix: "", suffix: "", prevHash: null, nextHash: null, dupCount: 1 };
    const rd = scanBudget(1_000_000, () => resolveDurable(ps, d));
    assert.ok(rd.start != null && rd.end != null, `DOCX resolved ${quote}`);
    assert.equal(ps[0].text.slice(rd.start, rd.end), want);

    const pxml = `<p:sp><p:nvSpPr><p:cNvPr id="2" name="T"/></p:nvSpPr><p:txBody><a:p><a:r><a:t>${raw.replace("\n", "</a:t><a:br/><a:t>")}</a:t></a:r></a:p></p:txBody></p:sp>`;
    const deck = parseDeck(pptxBytes(pxml));
    const pd = scanBudget(1_000_000, () => pptxDurable(deck, { slideIndex: 0, shapeId: 2, shapeName: "T" }, { quote }));
    assert.equal(deck.slides[0].shapes[0].text.slice(pd.start, pd.end), want);
    const rp = scanBudget(1_000_000, () => resolvePptx(deck, pd));
    assert.equal(rp.quoteLost, false);
    assert.equal(deck.slides[0].shapes[0].text.slice(rp.start, rp.end), want);
  }

  // Raw exact match preserves exact behavior
  const rawPs = parseDocxParagraphs(bodyDoc('<w:p w14:paraId="AAAAAAAA"><w:r><w:t>hello  world</w:t></w:r></w:p>'));
  const rawRes = scanBudget(1_000_000, () => resolveDurable(rawPs, { format: "docx", paraId: "AAAAAAAA", path: [0], paraText: "hello world", quote: "hello  world", prefix: "", suffix: "", prevHash: null, nextHash: null, dupCount: 1 }));
  assert.equal(rawRes.start, 0);
  assert.equal(rawRes.end, 12);
});

// ---- ENG-07: zip.js & zip-write.js validation and bounds checks ------------------------------------------------------------------------

test("ENG-07: zip.js validates encryption, size, CRC32, EOCD comment length, CD bounds, and ZIP64 sentinels", () => {
  const base = buildZip({ "a.txt": "hello world", "b.txt": "stored entry" }, { stored: ["b.txt"] });

  // 1. Encrypted entry rejected on read()
  {
    const b = Buffer.from(base);
    const cdOff = b.readUInt32LE(b.length - 6);
    b.writeUInt16LE(b.readUInt16LE(cdOff + 8) | 0x1, cdOff + 8);
    const z = openZip(b);
    assert.throws(() => z.read("a.txt"), (e) => e instanceof ZipError && /encrypted/i.test(e.message));
  }

  // 2. CRC mismatch rejected on read() (deflated & stored)
  for (const [entry, idx] of [["a.txt", 0], ["b.txt", 1]]) {
    const b = Buffer.from(base);
    let p = b.readUInt32LE(b.length - 6);
    for (let k = 0; k < idx; k++) p += 46 + b.readUInt16LE(p + 28) + b.readUInt16LE(p + 30) + b.readUInt16LE(p + 32);
    b.writeUInt32LE((b.readUInt32LE(p + 16) ^ 1) >>> 0, p + 16);
    const z = openZip(b);
    assert.throws(() => z.read(entry), (e) => e instanceof ZipError && /CRC mismatch/i.test(e.message));
  }

  // 3. Size mismatch rejected on read() (deflated & stored)
  {
    const b = Buffer.from(base);
    const cdOff = b.readUInt32LE(b.length - 6);
    b.writeUInt32LE(999, cdOff + 24);
    const z = openZip(b);
    assert.throws(() => z.read("a.txt"), (e) => e instanceof ZipError && /size mismatch/i.test(e.message));
  }

  // 4. EOCD scan ignores fake EOCD signature inside archive comment
  {
    const fakeComment = Buffer.alloc(24);
    fakeComment.writeUInt32LE(0x06054b50, 0); // looks like EOCD, but i + 22 + 0 !== buf.length
    const b = Buffer.from(base);
    b.writeUInt16LE(fakeComment.length, b.length - 2);
    const withComment = Buffer.concat([b, fakeComment]);
    const z = openZip(withComment);
    assert.equal(z.readText("a.txt"), "hello world");
  }

  // 5. CD entry exceeding cdOffset + cdSize rejected
  {
    const b = Buffer.from(base);
    const cdOff = b.readUInt32LE(b.length - 6);
    b.writeUInt16LE(5000, cdOff + 32); // huge commentLen past cdOffset + cdSize
    assert.throws(() => openZip(b), (e) => e instanceof ZipError && /central directory/i.test(e.message));
  }

  // 6. Per-entry ZIP64 sentinel 0xffffffff rejected
  for (const fieldOff of [20, 24, 42]) {
    const b = Buffer.from(base);
    const cdOff = b.readUInt32LE(b.length - 6);
    b.writeUInt32LE(0xffffffff, cdOff + fieldOff);
    assert.throws(() => openZip(b), (e) => e instanceof ZipError && /ZIP64/i.test(e.message));
  }
});

test("ENG-07: zip-write.js sets version-needed >= 20 for deflated entries and rejects > 0xfffffffe before writeUInt32LE", () => {
  const storedZip = buildZip({ "a.txt": "hello" }, { stored: ["a.txt"] });
  // Lower version-needed in CD to 10 (1.0) for the stored entry
  const b = Buffer.from(storedZip);
  const cdOff = b.readUInt32LE(b.length - 6);
  b.writeUInt16LE(10, cdOff + 6);
  const rewritten = replaceEntry(b, "a.txt", "hello deflated");
  const z = openZip(rewritten);
  const cd2 = z.entries.get("a.txt").cdOffset;
  assert.equal(rewritten.readUInt16LE(cd2 + 6), 20);
  const lo = z.entries.get("a.txt").localOffset;
  assert.equal(rewritten.readUInt16LE(lo + 4), 20);
});
