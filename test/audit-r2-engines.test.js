import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { buildZip, contentTypes, docxBytes } from "./helpers/zipbuild.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const { readAll, readUnits, buildDurable, resolveDurableAny } = await import("../src/anchors.js");
const { parseDocxParagraphs, resolveDurable } = await import("../src/docx.js");
const { parseDeck, pptxDurable, resolvePptx } = await import("../src/pptx.js");
const { parseWorkbook } = await import("../src/xlsx.js");
const { openZip, crc32, ZipError } = await import("../src/zip.js");
const { scanBudget } = await import("../src/text.js");
const { Interner, docxUnits } = await import("../src/merge-package.js");

function pptxWithParagraphs(paras) {
  const ap = paras.map((t) => `<a:p><a:r><a:t>${t}</a:t></a:r></a:p>`).join("");
  return buildZip({
    "[Content_Types].xml": contentTypes("pptx"),
    "ppt/presentation.xml": '<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>',
    "ppt/_rels/presentation.xml.rels": '<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/></Relationships>',
    "ppt/slides/slide1.xml": `<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="Box"/></p:nvSpPr><p:txBody>${ap}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
  });
}

function rawDocx(bodyInner) {
  return buildZip({
    "[Content_Types].xml": contentTypes("docx"),
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${bodyInner}</w:body></w:document>`,
  });
}

// ---- E1: no silent 64 cap on repeated text -------------------------------------------------------------------

test("E1: DOCX resolves 80th of 100 repeated normalized copies (not silently 1st), and returns lost past budget", () => {
  const chunks = Array.from({ length: 100 }, (_, i) => `item ${i}: say  hi.`);
  const text = chunks.join(" ");
  const targetChunk = "item 79: say  hi.";
  const targetStart = text.indexOf(targetChunk) + "item 79: ".length;
  const targetEnd = targetStart + "say  hi.".length;
  assert.equal(text.slice(targetStart, targetEnd), "say  hi.");

  const bytes = docxBytes([{ text, paraId: "12345678" }]);
  const u = readAll(readUnits("docx", bytes));
  const d = buildDurable(u, {
    location: { blockPath: [0], start: targetStart, end: targetEnd },
    quote: "say  hi.",
    prefix: "item 79: ",
    suffix: " item 80:",
  });
  assert.equal(d.start, targetStart);
  assert.equal(d.end, targetEnd);
  assert.equal(d.nth, 79);

  const r = resolveDurable(u.paragraphs, d);
  assert.equal(r.start, targetStart);
  assert.equal(r.end, targetEnd);
  assert.equal(r.nth, 79);

  // Even without context, nth: 79 resolves to the 80th copy
  const rNoCtx = resolveDurable(u.paragraphs, { ...d, prefix: "", suffix: "" });
  assert.equal(rNoCtx.start, targetStart);
  assert.equal(rNoCtx.end, targetEnd);
  assert.equal(rNoCtx.nth, 79);

  // When scan budget runs out, must return lost (null offsets), never silently copy 0
  const fresh = readAll(readUnits("docx", bytes));
  const rBudget = scanBudget(500, () => resolveDurable(fresh.paragraphs, { ...d, prefix: "", suffix: "" }));
  assert.equal(rBudget.start, null);
  assert.equal(rBudget.end, null);
});

test("E1: PPTX resolves 80th of 100 repeated normalized copies (not silently 1st), and returns lost past budget", () => {
  const chunks = Array.from({ length: 100 }, (_, i) => `item ${i}: say  hi.`);
  const text = chunks.join(" ");
  const targetStart = text.indexOf("item 79: say  hi.") + "item 79: ".length;
  const targetEnd = targetStart + "say  hi.".length;

  const bytes = pptxWithParagraphs([text]);
  const deck = parseDeck(bytes);
  const d = pptxDurable(deck, { slideIndex: 0, shapeId: 2, start: targetStart, end: targetEnd }, { quote: "say  hi.", prefix: "item 79: ", suffix: " item 80:" });
  assert.equal(d.start, targetStart);
  assert.equal(d.end, targetEnd);
  assert.equal(d.nth, 79);

  const r = resolvePptx(deck, d);
  assert.equal(r.start, targetStart);
  assert.equal(r.end, targetEnd);
  assert.equal(r.nth, 79);

  const rNoCtx = resolvePptx(deck, { ...d, prefix: "", suffix: "" });
  assert.equal(rNoCtx.start, targetStart);
  assert.equal(rNoCtx.end, targetEnd);
  assert.equal(rNoCtx.nth, 79);

  // Budget exhaustion returns lost (null offsets), never silently copy 0
  const fresh = parseDeck(bytes);
  const rBudget = scanBudget(500, () => resolvePptx(fresh, { ...d, prefix: "", suffix: "" }));
  assert.equal(rBudget.start, null);
  assert.equal(rBudget.end, null);
});

// ---- E2: "alpha beta and then alpha\nbeta", 2nd copy selected ------------------------------------------------

test("E2: DOCX stores normalized nth and resolves 2nd copy of 'alpha beta and then alpha\\nbeta' to offset 20", () => {
  const bytes = rawDocx(`<w:p><w:r><w:t xml:space="preserve">alpha beta and then alpha</w:t><w:br/><w:t>beta</w:t></w:r></w:p>`);
  const u = readAll(readUnits("docx", bytes));
  assert.equal(u.paragraphs[0].text, "alpha beta and then alpha\nbeta");

  const d = buildDurable(u, {
    location: { blockPath: [0], start: 20, end: 30 },
    quote: "alpha\nbeta",
    prefix: "and then ",
    suffix: "",
  });
  assert.equal(d.quote, "alpha beta");
  assert.equal(d.start, 20);
  assert.equal(d.end, 30);
  assert.equal(d.nth, 1);

  const r = resolveDurableAny(u, d);
  assert.equal(r.start, 20);
  assert.equal(r.end, 30);
  assert.equal(r.nth, 1);

  // Even without context, nth: 1 resolves to offset 20 (not 0)
  const rNoCtx = resolveDurable(u.paragraphs, { ...d, prefix: "", suffix: "" });
  assert.equal(rNoCtx.start, 20);
  assert.equal(rNoCtx.end, 30);
  assert.equal(rNoCtx.nth, 1);
});

test("E2: PPTX stores normalized nth and resolves 2nd copy of 'alpha beta and then alpha\\nbeta' to offset 20", () => {
  const bytes = pptxWithParagraphs(["alpha beta and then alpha", "beta"]);
  const deck = parseDeck(bytes);
  deck.ensure();
  assert.equal(deck.slides[0].shapes[0].text, "alpha beta and then alpha\nbeta");

  const d = pptxDurable(deck, { slideIndex: 0, shapeId: 2, start: 20, end: 30 }, { quote: "alpha\nbeta", prefix: "and then ", suffix: "" });
  assert.equal(d.quote, "alpha beta");
  assert.equal(d.start, 20);
  assert.equal(d.end, 30);
  assert.equal(d.nth, 1);

  const r = resolvePptx(deck, d);
  assert.equal(r.start, 20);
  assert.equal(r.end, 30);
  assert.equal(r.nth, 1);

  // Even without context, nth: 1 resolves to offset 20 (not 0)
  const rNoCtx = resolvePptx(deck, { ...d, prefix: "", suffix: "" });
  assert.equal(rNoCtx.start, 20);
  assert.equal(rNoCtx.end, 30);
  assert.equal(rNoCtx.nth, 1);
});

// ---- E3: PPTX findExactMatch with hintStart computes true occurrence index k ---------------------------------

test("E3: PPTX pptxDurable with loc.start on 3rd copy and no context stores nth=2 and resolves to 3rd copy", () => {
  const bytes = pptxWithParagraphs(["foo bar foo baz foo"]);
  const deck = parseDeck(bytes);
  const d = pptxDurable(deck, { slideIndex: 0, shapeId: 2, start: 16, end: 19 }, { quote: "foo", prefix: "", suffix: "" });
  assert.equal(d.start, 16);
  assert.equal(d.end, 19);
  assert.equal(d.nth, 2);

  const r = resolvePptx(deck, d);
  assert.equal(r.start, 16);
  assert.equal(r.end, 19);
  assert.equal(r.nth, 2);
});

// ---- E4: DOCX revision stack (moveFrom > ins > moveFrom > text) ----------------------------------------------

test("E4: moveFrom > ins > moveFrom > text is invisible while moveFrom > ins > text remains visible", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
  <w:p><w:moveFrom w:id="1"><w:ins w:id="2"><w:moveFrom w:id="3"><w:r><w:t>hidden</w:t></w:r></w:moveFrom></w:ins></w:moveFrom></w:p>
  <w:p><w:moveFrom w:id="4"><w:ins w:id="5"><w:r><w:t>shown</w:t></w:r></w:ins></w:moveFrom></w:p>
  <w:p><w:r><w:t>after</w:t></w:r></w:p>
</w:body></w:document>`;

  const paras = parseDocxParagraphs(xml);
  assert.deepEqual(
    paras.map((p) => p.text),
    ["", "shown", "after"]
  );

  // merge-package.js must agree with parseDocxParagraphs
  const mp = docxUnits(xml, new Interner());
  assert.deepEqual(
    mp.paras.map((p) => p.text),
    ["", "shown", "after"]
  );
});

// ---- E5 / S11: openZip & replaceEntry & canonicalZip succeed when zlib.crc32 is undefined --------------------

test("E5 / S11: openZip, replaceEntry, and canonicalZip succeed in a Node subprocess with zlib.crc32 = undefined", () => {
  const script = `
    import assert from "node:assert/strict";
    import zlib from "node:zlib";
    zlib.crc32 = undefined;
    assert.equal(typeof zlib.crc32, "undefined");

    const { openZip, crc32, crc32Pure } = await import(${JSON.stringify(path.join(repo, "src/zip.js"))});
    const { replaceEntry } = await import(${JSON.stringify(path.join(repo, "src/zip-write.js"))});
    const { canonicalZip } = await import(${JSON.stringify(path.join(repo, "scripts/demo/canonical.mjs"))});
    const { buildZip } = await import(${JSON.stringify(path.join(repo, "test/helpers/zipbuild.js"))});

    const orig = buildZip({ "a.txt": "hello world", "b.txt": "second entry" });
    const z1 = openZip(orig);
    assert.equal(z1.readText("a.txt"), "hello world");
    assert.equal(crc32(Buffer.from("hello world")), crc32Pure(Buffer.from("hello world")));

    const updated = replaceEntry(orig, "a.txt", Buffer.from("updated content without zlib.crc32"));
    const z2 = openZip(updated);
    assert.equal(z2.readText("a.txt"), "updated content without zlib.crc32");
    assert.equal(z2.readText("b.txt"), "second entry");

    const canon = canonicalZip(updated);
    const z3 = openZip(canon);
    assert.equal(z3.readText("a.txt"), "updated content without zlib.crc32");
    console.log("OK");
  `;
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 15000 });
  assert.equal(res.status, 0, `subprocess failed:\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
  assert.match(res.stdout, /OK/);
});

// ---- E6: EOCD validation against fake EOCD & hidden second directory in trailing junk ------------------------

test("E6: openZip handles trailing bytes, ignores garbage fake EOCD, and ignores second directory hidden in trailing junk", () => {
  const realZip = buildZip({ "real.txt": "authentic content" });

  // 1. Valid ZIP with ordinary trailing bytes still opens
  const withTrailing = Buffer.concat([realZip, Buffer.from("some trailing metadata bytes")]);
  assert.equal(openZip(withTrailing).readText("real.txt"), "authentic content");

  // 2. Garbage fake EOCD appended in trailing junk (even with commentLen=0 at EOF) is rejected and real ZIP opens
  const fakeEocd = Buffer.alloc(22);
  fakeEocd.writeUInt32LE(0x06054b50, 0);
  fakeEocd.writeUInt16LE(1, 8);
  fakeEocd.writeUInt16LE(1, 10);
  fakeEocd.writeUInt32LE(100, 12); // cdSize doesn't line up
  fakeEocd.writeUInt32LE(0, 16); // cdOffset doesn't line up
  const withFakeEocd = Buffer.concat([realZip, Buffer.from("junk"), fakeEocd]);
  assert.equal(openZip(withFakeEocd).readText("real.txt"), "authentic content");

  // 3. Second valid central directory + EOCD hidden in trailing junk (not at EOF): real directory is read, not the hidden one
  const evilName = Buffer.from("evil.txt");
  const evilData = Buffer.from("malicious");
  const evilComp = zlib.deflateRawSync(evilData);
  const evilCrc = crc32(evilData);
  const baseOffset = realZip.length;

  const evilLh = Buffer.alloc(30);
  evilLh.writeUInt32LE(0x04034b50, 0);
  evilLh.writeUInt16LE(20, 4);
  evilLh.writeUInt16LE(8, 8);
  evilLh.writeUInt32LE(evilCrc, 14);
  evilLh.writeUInt32LE(evilComp.length, 18);
  evilLh.writeUInt32LE(evilData.length, 22);
  evilLh.writeUInt16LE(evilName.length, 26);

  const evilCdOffset = baseOffset + 30 + evilName.length + evilComp.length;
  const evilCh = Buffer.alloc(46);
  evilCh.writeUInt32LE(0x02014b50, 0);
  evilCh.writeUInt16LE(20, 4);
  evilCh.writeUInt16LE(20, 6);
  evilCh.writeUInt16LE(8, 10);
  evilCh.writeUInt32LE(evilCrc, 16);
  evilCh.writeUInt32LE(evilComp.length, 20);
  evilCh.writeUInt32LE(evilData.length, 24);
  evilCh.writeUInt16LE(evilName.length, 28);
  evilCh.writeUInt32LE(baseOffset, 42);
  const evilCdSize = 46 + evilName.length;

  const evilEocd = Buffer.alloc(22);
  evilEocd.writeUInt32LE(0x06054b50, 0);
  evilEocd.writeUInt16LE(1, 8);
  evilEocd.writeUInt16LE(1, 10);
  evilEocd.writeUInt32LE(evilCdSize, 12);
  evilEocd.writeUInt32LE(evilCdOffset, 16);

  const withHiddenSecondDir = Buffer.concat([realZip, evilLh, evilName, evilComp, evilCh, evilName, evilEocd, Buffer.from("trailing")]);
  const opened = openZip(withHiddenSecondDir);
  assert.deepEqual(opened.names, ["real.txt"]);
  assert.equal(opened.readText("real.txt"), "authentic content");
});

// ---- E7 / T9: XLSX boolean accepts only exact "1" and "true" (matching the engine) ---------------------------

test("E7 / T9: XLSX boolean cells treat only exact <v>1</v> and <v>true</v> as TRUE (TRUE and True read FALSE)", () => {
  const bytes = buildZip({
    "[Content_Types].xml": contentTypes("xlsx"),
    "xl/workbook.xml": '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    "xl/worksheets/sheet1.xml": `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
      <row r="1"><c r="A1" t="b"><v>true</v></c><c r="B1" t="b"><v>TRUE</v></c><c r="C1" t="b"><v>True</v></c><c r="D1" t="b"><v>1</v></c><c r="E1" t="b"><v>false</v></c><c r="F1" t="b"><v>0</v></c><c r="G1" t="b"/></row>
    </sheetData></worksheet>`,
  });
  const wb = parseWorkbook(bytes);
  const sd = wb.sheetCells(wb.sheets[0]);
  assert.equal(sd.cells.get("0,0")?.text ?? sd.cells.get(0)?.text, "TRUE");
  assert.equal(sd.cells.get("0,1")?.text ?? sd.cells.get(1)?.text, "FALSE");
  assert.equal(sd.cells.get("0,2")?.text ?? sd.cells.get(2)?.text, "FALSE");
  assert.equal(sd.cells.get("0,3")?.text ?? sd.cells.get(3)?.text, "TRUE");
  assert.equal(sd.cells.get("0,4")?.text ?? sd.cells.get(4)?.text, "FALSE");
  assert.equal(sd.cells.get("0,5")?.text ?? sd.cells.get(5)?.text, "FALSE");
  assert.equal(sd.cells.get("0,6") ?? sd.cells.get(6), undefined);
});
