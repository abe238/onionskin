import zlib from "node:zlib";
import { gated } from "./stop-gate.js";

const MAX_ENTRIES = 20000;
const MAX_ENTRY_BYTES = 512 * 1024 * 1024;
const MAX_XML_BYTES = 64 * 1024 * 1024;
/** Everything one opened archive may inflate or copy out through read(), added up. Real documents read a few parts (types, rels, the main part). */
export const MAX_TOTAL_EXPANSION = 256 * 1024 * 1024;

export class ZipError extends Error {}
const MB = (n) => (n >= 1024 * 1024 ? `${Math.round(n / 1024 / 1024)} MB` : `${n.toLocaleString("en-US")} bytes`);
const SPLIT = "Split it into smaller files, or save it again in Word, Excel or PowerPoint, and open that";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();
export function crc32Pure(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
export function crc32(buf) {
  return typeof zlib.crc32 === "function" ? zlib.crc32(buf) >>> 0 : crc32Pure(buf);
}

function validEocd(buf, i) {
  const count = buf.readUInt16LE(i + 10);
  const cdSize = buf.readUInt32LE(i + 12);
  const cdOffset = buf.readUInt32LE(i + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) return false;
  if (count > MAX_ENTRIES) return false;
  if (cdOffset + cdSize !== i) return false;
  let p = cdOffset;
  for (let k = 0; k < count; k++) {
    if (p + 46 > i || buf.readUInt32LE(p) !== 0x02014b50) return false;
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    if (p + 46 + nameLen + extraLen + commentLen > i) return false;
    p += 46 + nameLen + extraLen + commentLen;
  }
  return p === i;
}

/** Reads the central directory of a ZIP held in memory. No ZIP64 (files over 4 GB are refused). */
export function openZip(buf, { budget = MAX_TOTAL_EXPANSION } = {}) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50) throw new ZipError("not a ZIP file");
  let exactValid = -1;
  let exactInvalid = -1;
  let fallback = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) !== 0x06054b50) continue;
    const end = i + 22 + buf.readUInt16LE(i + 20);
    if (end === buf.length) {
      if (validEocd(buf, i)) {
        exactValid = i;
        break;
      }
      if (exactInvalid < 0) exactInvalid = i;
    } else if (end < buf.length && validEocd(buf, i)) {
      fallback = i;
    }
  }
  const eocd = exactValid >= 0 ? exactValid : fallback >= 0 ? fallback : exactInvalid;
  if (eocd < 0) throw new ZipError("ZIP end record not found");
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipError("ZIP64 is not supported");
  if (count > MAX_ENTRIES) throw new ZipError(`this file has more than ${MAX_ENTRIES.toLocaleString("en-US")} parts, more than Onionskin can read. ${SPLIT}`);
  if (cdOffset + cdSize > buf.length) throw new ZipError("ZIP central directory out of range");
  const entries = new Map();
  let p = cdOffset;
  for (let k = 0; k < count; k++) {
    if (p + 46 > cdOffset + cdSize || buf.readUInt32LE(p) !== 0x02014b50) throw new ZipError("bad ZIP central directory");
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    if (p + 46 + nameLen + extraLen + commentLen > cdOffset + cdSize) throw new ZipError("bad ZIP central directory");
    if (compSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) throw new ZipError("ZIP64 is not supported");
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    if (name.startsWith("/") || name.split("/").includes("..") || name.includes("\\") || name.includes("\0")) throw new ZipError(`unsafe ZIP entry name: ${JSON.stringify(name)}`);
    if (entries.has(name)) throw new ZipError(`duplicate ZIP entry: ${JSON.stringify(name)}`);
    if (size > MAX_ENTRY_BYTES) throw new ZipError(`a part of this file (${JSON.stringify(name)}) is larger than ${MB(MAX_ENTRY_BYTES)} unpacked, more than Onionskin can read. ${SPLIT}`);
    entries.set(name, { name, flags, method, crc, compSize, size, localOffset, cdOffset: p }); // cdOffset: where this entry's central record starts (zip-write.js copies it)
    p += 46 + nameLen + extraLen + commentLen;
  }
  let used = 0;
  const spend = (name, n) => {
    used += n;
    if (used > budget) throw new ZipError(`this file unpacks to more than ${MB(budget)} in the parts Onionskin reads (at ${JSON.stringify(name)}), more than Onionskin can read. ${SPLIT}`);
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
    if (e.flags & 0x1) throw new ZipError(`encrypted ZIP entry ${JSON.stringify(name)}`);
    cap = Math.min(cap, MAX_ENTRY_BYTES);
    const data = raw(name);
    let out;
    if (e.method === 0) {
      // a stored entry is bounded by the same per-entry cap as an inflated one
      if (data.length > cap) throw new ZipError(`a part of this file (${JSON.stringify(name)}) is larger than ${MB(cap)} unpacked, more than Onionskin can read. ${SPLIT}`);
      out = Buffer.from(data);
    } else if (e.method === 8) {
      try {
        out = gated(() => zlib.inflateRawSync(data, { maxOutputLength: cap })); // never stopped inside zlib (src/stop-gate.js)
      } catch (err) {
        if (err?.code === "ERR_BUFFER_TOO_LARGE") throw new ZipError(`a part of this file (${JSON.stringify(name)}) is larger than ${MB(cap)} unpacked, more than Onionskin can read. ${SPLIT}`);
        throw new ZipError(`cannot inflate ${JSON.stringify(name)}: ${err.message}`);
      }
    } else {
      throw new ZipError(`unsupported ZIP method ${e.method} for ${JSON.stringify(name)}`);
    }
    if (out.length !== e.size) throw new ZipError(`size mismatch for ${JSON.stringify(name)}`);
    if (crc32(out) !== e.crc) throw new ZipError(`CRC mismatch for ${JSON.stringify(name)} (does not match its stored checksum)`);
    spend(name, out.length);
    return out;
  }
  return { names: [...entries.keys()], entries, read, raw, buf, eocd, readText: (name, cap) => read(name, cap)?.toString("utf8") ?? null };
}
