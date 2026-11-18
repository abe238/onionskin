import zlib from "node:zlib";
import { gated } from "./stop-gate.js";
import { openZip, ZipError } from "./zip.js";

// Rewrites one entry of a ZIP held in memory and copies every other entry as it is: same order, same compressed bytes, same CRC, same
// central-directory fields (times, attributes, extra fields, comments). The local headers are written fresh from the central-directory
// values, so an input that used data descriptors (sizes after the data) comes out without them. No ZIP64, like zip.js.

const sig = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
};

/** Returns new archive bytes where `name` holds `data` (deflated). Throws ZipError when `name` is missing or an entry is encrypted. */
export function replaceEntry(bytes, name, data) {
  const zip = openZip(bytes);
  const buf = zip.buf;
  if (!zip.entries.has(name)) throw new ZipError(`no entry ${JSON.stringify(name)} to replace`);
  const newData = Buffer.from(data);
  const newComp = gated(() => zlib.deflateRawSync(newData)); // never stopped inside zlib (src/stop-gate.js)
  const newCrc = zlib.crc32(newData) >>> 0;
  const parts = [];
  const central = [];
  let offset = 0;
  for (const n of zip.names) {
    const e = zip.entries.get(n);
    if (e.flags & 0x1) throw new ZipError(`encrypted ZIP entry ${JSON.stringify(n)}`);
    const cd = e.cdOffset;
    const nameLen = buf.readUInt16LE(cd + 28);
    const extraLen = buf.readUInt16LE(cd + 30);
    const commentLen = buf.readUInt16LE(cd + 32);
    const record = Buffer.from(buf.subarray(cd, cd + 46 + nameLen + extraLen + commentLen)); // a copy: patched below
    const nameBuf = record.subarray(46, 46 + nameLen);
    const mine = n === name;
    const comp = mine ? newComp : zip.raw(n);
    const method = mine ? 8 : e.method;
    const crc = mine ? newCrc : e.crc;
    const size = mine ? newData.length : e.size;
    const flags = e.flags & ~0x8; // sizes are in the local header now: no data descriptor
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(record.readUInt16LE(6), 4); // version needed
    lh.writeUInt16LE(flags, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(record.readUInt16LE(12), 10); // time
    lh.writeUInt16LE(record.readUInt16LE(14), 12); // date
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(size, 22);
    lh.writeUInt16LE(nameLen, 26);
    lh.writeUInt16LE(0, 28); // no local extra field
    parts.push(lh, nameBuf, comp);
    record.writeUInt16LE(flags, 8);
    record.writeUInt16LE(method, 10);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(comp.length, 20);
    record.writeUInt32LE(size, 24);
    record.writeUInt32LE(offset, 42);
    central.push(record);
    offset += 30 + nameLen + comp.length;
  }
  const cd = Buffer.concat(central);
  const commentLen = buf.readUInt16LE(zip.eocd + 20);
  const end = Buffer.alloc(22);
  sig(0x06054b50).copy(end, 0);
  end.writeUInt16LE(zip.names.length, 8);
  end.writeUInt16LE(zip.names.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(commentLen, 20);
  const comment = buf.subarray(zip.eocd + 22, zip.eocd + 22 + commentLen);
  if (offset + cd.length > 0xfffffffe) throw new ZipError("the archive would need ZIP64");
  return Buffer.concat([...parts, cd, end, comment]);
}
