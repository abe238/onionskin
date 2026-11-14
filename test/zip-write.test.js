import assert from "node:assert/strict";
import { test } from "node:test";
import zlib from "node:zlib";
import { openZip, ZipError } from "../src/zip.js";
import { replaceEntry } from "../src/zip-write.js";
import { validatePackage } from "../src/package.js";
import { docxBytes, buildZip } from "./helpers/zipbuild.js";

// zip-write.js: one entry rewritten, every other entry copied byte for byte (compressed bytes, CRC, order).

test("zip-write: unchanged entries keep their compressed bytes, CRC and order; the replaced one reads back", () => {
  const input = docxBytes(["One", "Two"], { "word/styles.xml": "<w:styles/>", "docProps/app.xml": "<Properties/>" });
  const before = openZip(input);
  const doc = '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>New</w:t></w:r></w:p></w:body></w:document>';
  const out = replaceEntry(input, "word/document.xml", doc);
  const after = openZip(out);
  assert.deepEqual(after.names, before.names);
  for (const n of before.names) {
    if (n === "word/document.xml") continue;
    assert.ok(after.raw(n).equals(before.raw(n)), `${n}: same compressed bytes`);
    assert.equal(after.entries.get(n).crc, before.entries.get(n).crc, `${n}: same CRC`);
    assert.equal(after.entries.get(n).method, before.entries.get(n).method);
  }
  assert.equal(after.readText("word/document.xml"), doc);
  assert.equal(after.entries.get("word/document.xml").crc, zlib.crc32(Buffer.from(doc)) >>> 0);
  validatePackage(out, "docx");
});

test("zip-write: stored entries stay stored", () => {
  const input = docxBytes(["One"], { "media/x.bin": Buffer.from([1, 2, 3]) });
  const stored = buildZip({ ...Object.fromEntries(openZip(input).names.map((n) => [n, openZip(input).read(n)])) }, { stored: ["media/x.bin"] });
  const out = replaceEntry(stored, "word/document.xml", "<x/>");
  const z = openZip(out);
  assert.equal(z.entries.get("media/x.bin").method, 0);
  assert.deepEqual([...z.read("media/x.bin")], [1, 2, 3]);
});

/** A ZIP whose local headers carry no sizes or CRC (general purpose bit 3) and a data descriptor after each entry's data. */
function withDataDescriptors(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const comp = zlib.deflateRawSync(data);
    const crc = zlib.crc32(data) >>> 0;
    const nameBuf = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x8, 6);
    lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(nameBuf.length, 26);
    const dd = Buffer.alloc(16);
    dd.writeUInt32LE(0x08074b50, 0);
    dd.writeUInt32LE(crc, 4);
    dd.writeUInt32LE(comp.length, 8);
    dd.writeUInt32LE(data.length, 12);
    locals.push(lh, nameBuf, comp, dd);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x8, 8);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += 30 + nameBuf.length + comp.length + 16;
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

test("zip-write: an input written with data descriptors comes out readable, without them", () => {
  const z0 = openZip(docxBytes(["One"]));
  const input = withDataDescriptors(Object.fromEntries(z0.names.map((n) => [n, z0.read(n)])));
  assert.equal(openZip(input).readText("word/document.xml"), z0.readText("word/document.xml"), "the fixture itself reads");
  const out = replaceEntry(input, "word/document.xml", "<w:document/>");
  const z = openZip(out);
  assert.equal(z.readText("word/document.xml"), "<w:document/>");
  assert.equal(z.readText("[Content_Types].xml"), z0.readText("[Content_Types].xml"));
  for (const n of z.names) assert.equal(z.entries.get(n).flags & 0x8, 0, `${n}: no data descriptor flag`);
  validatePackage(out, "docx");
});

test("zip-write: a missing entry is refused", () => {
  assert.throws(() => replaceEntry(docxBytes(["x"]), "word/nope.xml", "x"), ZipError);
});
