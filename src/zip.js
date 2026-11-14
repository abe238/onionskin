import zlib from "node:zlib";

const MAX_ENTRIES = 20000;
const MAX_ENTRY_BYTES = 512 * 1024 * 1024;
const MAX_XML_BYTES = 64 * 1024 * 1024;
/** Everything one opened archive may inflate or copy out through read(), added up. Real documents read a few parts (types, rels, the main part). */
export const MAX_TOTAL_EXPANSION = 256 * 1024 * 1024;

export class ZipError extends Error {}

/** Reads the central directory of a ZIP held in memory. No ZIP64 (files over 4 GB are refused). */
export function openZip(buf, { budget = MAX_TOTAL_EXPANSION } = {}) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50) throw new ZipError("not a ZIP file");
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError("ZIP end record not found");
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipError("ZIP64 is not supported");
  if (count > MAX_ENTRIES) throw new ZipError("too many ZIP entries");
  if (cdOffset + cdSize > buf.length) throw new ZipError("ZIP central directory out of range");
  const entries = new Map();
  let p = cdOffset;
  for (let k = 0; k < count; k++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new ZipError("bad ZIP central directory");
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    if (name.startsWith("/") || name.split("/").includes("..") || name.includes("\\") || name.includes("\0")) throw new ZipError(`unsafe ZIP entry name: ${JSON.stringify(name)}`);
    if (entries.has(name)) throw new ZipError(`duplicate ZIP entry: ${JSON.stringify(name)}`);
    if (size > MAX_ENTRY_BYTES) throw new ZipError(`ZIP entry too large: ${JSON.stringify(name)}`);
    entries.set(name, { name, flags, method, crc, compSize, size, localOffset, cdOffset: p }); // cdOffset: where this entry's central record starts (zip-write.js copies it)
    p += 46 + nameLen + extraLen + commentLen;
  }
  let used = 0;
  const spend = (name, n) => {
    used += n;
    if (used > budget) throw new ZipError(`ZIP expansion budget exceeded while reading ${JSON.stringify(name)} (more than ${Math.round(budget / 1024 / 1024)} MB in total)`);
  };
  /** The entry's bytes as stored in the archive (still compressed); null when there is no such entry. Spends no budget: nothing is inflated. */
  function raw(name) {
    const e = entries.get(name);
    if (!e) return null;
    const lo = e.localOffset;
    if (lo + 30 > buf.length || buf.readUInt32LE(lo) !== 0x04034b50) throw new ZipError(`bad local header for ${JSON.stringify(name)}`);
    const dataStart = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28);
    if (dataStart + e.compSize > buf.length) throw new ZipError(`ZIP entry ${JSON.stringify(name)} runs past the end of the file`);
    return buf.subarray(dataStart, dataStart + e.compSize);
  }
  function read(name, cap = MAX_XML_BYTES) {
    const e = entries.get(name);
    if (!e) return null;
    cap = Math.min(cap, MAX_ENTRY_BYTES);
    const data = raw(name);
    if (e.method === 0) {
      // a stored entry is bounded by the same per-entry cap as an inflated one
      if (data.length > cap) throw new ZipError(`ZIP entry ${JSON.stringify(name)} is larger than the ${Math.round(cap / 1024 / 1024)} MB limit for a part that is read`);
      spend(name, data.length);
      return Buffer.from(data);
    }
    if (e.method === 8) {
      let out;
      try {
        out = zlib.inflateRawSync(data, { maxOutputLength: cap });
      } catch (err) {
        throw new ZipError(`cannot inflate ${JSON.stringify(name)}: ${err.message}`);
      }
      spend(name, out.length);
      return out;
    }
    throw new ZipError(`unsupported ZIP method ${e.method} for ${JSON.stringify(name)}`);
  }
  return { names: [...entries.keys()], entries, read, raw, buf, eocd, readText: (name, cap) => read(name, cap)?.toString("utf8") ?? null };
}
