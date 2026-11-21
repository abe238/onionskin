// The recorder's own ZIP writer: it repacks v0.docx and v1.docx so that every header field that is not content is a fixed constant.
// A ZIP header holds bytes nothing reads (time stamps, comments, extra fields, version and attribute numbers), and the edit engine keeps
// the old stamps while giving the body a new one, so a stamp rule can only ever be "close enough". Writing the archive here removes
// that freedom by construction: the same parts in, the same bytes out, whoever packed the source and whenever.
//   every entry: version needed 2.0, made by 2.0 (MS-DOS), flags 0, deflate, the time stamp CANONICAL_DOS_TIME, no extra field, no
//   comment, attributes 0; the archive: no comment, one disk. Entry names and order are the source's; each entry's content is the
//   source's inflated bytes, deflated here with Node's zlib at its default level (the encoding scan.mjs re-creates to check it).
// Reuses openZip (src/zip.js) for reading; the header layout is the one src/zip-write.js writes. No ZIP64, like both.
import zlib from "node:zlib";
import { crc32, openZip, ZipError } from "../../src/zip.js";

/** 1980-01-01 00:00:00, the first moment a DOS time stamp can hold: DOS date 0x0021 (year 0 = 1980, month 1, day 1), time 0. */
export const CANONICAL_DOS_DATE = 0x0021;
export const CANONICAL_DOS_TIME = 0x0000;
/** The header numbers every canonical entry carries: version 2.0 (made by MS-DOS, needed to extract), deflate, no flags, attributes 0. */
export const CANONICAL = Object.freeze({ madeBy: 20, need: 20, flags: 0, method: 8, date: CANONICAL_DOS_DATE, time: CANONICAL_DOS_TIME, internal: 0, external: 0 });

/**
 * Returns `bytes` repacked canonically. Throws ZipError when the source cannot be read, holds an encrypted entry, or a part's content
 * does not match its stored checksum. Before returning, it reopens its own output and proves every entry has the source's name, place
 * and inflated bytes, and the source's CRC; any difference throws, so a repack can never change what a part says.
 */
export function canonicalZip(bytes) {
  const src = openZip(bytes);
  const parts = [];
  for (const name of src.names) {
    const e = src.entries.get(name);
    if (e.flags & 0x1) throw new ZipError(`encrypted ZIP entry ${JSON.stringify(name)}`);
    const content = src.read(name);
    if (crc32(content) !== e.crc >>> 0 || content.length !== e.size) throw new ZipError(`ZIP entry ${JSON.stringify(name)} does not match its stored checksum or size`);
    parts.push({ name, content, crc: e.crc >>> 0 });
  }
  const locals = [];
  const central = [];
  let offset = 0;
  for (const { name, content, crc } of parts) {
    const nameBuf = Buffer.from(name, "utf8");
    if (!nameBuf.every((b) => b < 0x80)) throw new ZipError(`ZIP entry name is not plain ASCII: ${JSON.stringify(name)}`); // flag 0: names are read as code page 437
    const comp = zlib.deflateRawSync(content);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(CANONICAL.need, 4);
    lh.writeUInt16LE(CANONICAL.flags, 6);
    lh.writeUInt16LE(CANONICAL.method, 8);
    lh.writeUInt16LE(CANONICAL.time, 10);
    lh.writeUInt16LE(CANONICAL.date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(content.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28); // no extra field
    locals.push(lh, nameBuf, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(CANONICAL.madeBy, 4);
    ch.writeUInt16LE(CANONICAL.need, 6);
    ch.writeUInt16LE(CANONICAL.flags, 8);
    ch.writeUInt16LE(CANONICAL.method, 10);
    ch.writeUInt16LE(CANONICAL.time, 12);
    ch.writeUInt16LE(CANONICAL.date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(content.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    // 30 extra length, 32 comment length, 34 disk, 36 internal and 38 external attributes: all 0
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22); // disk numbers 0, no archive comment
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(parts.length, 8);
  end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  if (offset + cd.length > 0xfffffffe) throw new ZipError("the archive would need ZIP64");
  const out = Buffer.concat([...locals, cd, end]);

  // the proof, on every call: same names in the same order, same inflated bytes, same CRC
  const back = openZip(out);
  if (back.names.length !== parts.length || back.names.some((n, i) => n !== parts[i].name)) throw new ZipError("the repack changed the entries or their order");
  for (const { name, content, crc } of parts) {
    const got = back.read(name);
    if (!got.equals(content) || back.entries.get(name).crc >>> 0 !== crc || crc32(got) !== crc) throw new ZipError(`the repack changed ${JSON.stringify(name)}`);
  }
  return out;
}
