#!/usr/bin/env node
// The scan a demo recording must pass before it is written (record.mjs) and before it is built into the page (the build step calls
// scanFolder). A recording is three files: recording.json, v0.docx (the letter before the agent) and v1.docx (after it).
//   node scripts/demo/scan.mjs <folder> [--test]        exit 0 = safe to show anyone; 1 = refused, with one line per problem
//
// It refuses, and never repairs:
//   - any field outside the allow-list below, or a field of the wrong type;
//   - a recording made with the stand-in agent (`real: false`), unless --test;
//   - any string that holds a path, this Mac's user name, home folder or computer name, an email address, a web address, markup,
//     control or bidirectional characters, a long hex or token-like run, an id-shaped word (letters and digits mixed), or any
//     character outside plain text (printable ASCII and curly quotes, dashes and the ellipsis): no soft hyphens, look-alike letters
//     or Unicode slashes, which show on screen as something the rules above would refuse;
//   - words on the person's side that are not the scenario's (comments, overall note) or the letter's (quotes, unchanged and removed text);
//   - places that are not exactly what compareBytes finds between v0 and v1, a v0 whose text is not the bundled letter, or a v1 that
//     adds or removes paragraphs;
//   - in either document: external relationships, fields (w:instrText, w:fldSimple), attached templates, altChunk, subDoc, OLE objects,
//     linked images (r:link), any part that is not XML (images, embeddings), and any web address outside namespace and type names;
//   - a v0 whose parts are not the generated letter's, byte for byte; a v1 that adds or removes a part or changes any part but the
//     body; a v1 body whose markup is not the letter's byte for byte (only the words inside runs may change); and a body with text the
//     paragraph reader does not show (text boxes, tracked changes, drawings, XML comments, text outside runs, token-like attributes);
//   - either file packed in any way but the recorder's canonical one (canonical.mjs): every header field that is not content must be
//     its fixed constant (one time stamp, version, flags, attributes for every entry), the parts must be in the letter's order, and an
//     archive or entry comment, extra fields, gaps, trailing bytes, bytes after a part's compressed data, or compressed data that is
//     not the one standard encoding of the part are refused (so every byte is accounted for);
//   - run text in v1's body spelled another way than the engine writes it (character references, escaped quotes) or with spacing
//     the page does not show (doubled, leading or trailing spaces).
// The agent's own words (summary, notes, inserted text) cannot be in the letter; they are held to the string rules above instead.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { readDocxParagraphs } from "../../src/docx.js";
import { compareBytes } from "../../src/history.js";
import { hasControlChars, untrusted } from "../../src/sanitize.js";
import { escText } from "../../src/xml-tree.js";
import { crc32, openZip } from "../../src/zip.js";
import { CANONICAL } from "./canonical.mjs";
import { DEMO } from "./demo-scenario.mjs";

export const SCHEMA = "onionskin.demo/1";
export const FILES = ["recording.json", "v0.docx", "v1.docx"];
export const CAPS = { agent: 60, summary: 400, note: 400, comment: 200, quote: 500 };
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");

/** The allow-list, as exact key sets. A key that is not listed is refused, wherever it is. */
const KEYS = {
  top: ["schema", "real", "agent", "date", "format", "v0_sha256", "v1_sha256", "comments", "overall_note", "result", "places", "timing"],
  comment: ["n", "text", "quote", "prefix", "suffix"],
  result: ["summary", "notes"],
  note: ["n", "status", "note"],
  place: ["change", "diff", "text_start"],
  timing: ["working_ms", "result_ms"],
};

/** Who this Mac is: names that must never appear in a recording. Injectable so tests use made-up ones. */
export const localIdentity = () => ({ user: os.userInfo().username, home: os.homedir(), host: os.hostname().split(".")[0] });

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const RULES = [
  [/(^|[\s"'(\[{=:,;])(~|\.{1,2})?\/[A-Za-z0-9_.-]/, "a file path"],
  [/[^\s/]\/[^\s/]+\//, "a file path"],
  [/[A-Za-z0-9_.-]\/[A-Za-z0-9_.-]*\.[A-Za-z][A-Za-z0-9]{0,4}\b/, "a file path"],
  [/(^|[^A-Za-z])[A-Za-z]:\\|\\\\/, "a file path"],
  [/[a-z][a-z0-9+.-]*:\/\//i, "a web address"],
  [/\b(javascript|vbscript):/i, "a web address"],
  [/\b(data|file|mailto|blob):\S/i, "a web address"],
  [/\bwww\./i, "a web address"],
  [/[^\s@]+@[^\s@]+\.[a-z]{2,}/i, "an email address"],
  [/<\s*\/?\s*[a-z!?]/i, "markup"],
  [/[0-9a-f]{16,}/i, "a long hex run (a hash, key or token)"],
  [/[A-Za-z0-9_-]{20,}/, "a token-like run"],
];
// Plain text: printable ASCII plus curly quotes, en and em dashes and the ellipsis. Everything else is refused, not cleaned: a soft hyphen
// (U+00AD) is invisible and splits a user name or token past the rules, and look-alike letters and slashes read as the real ones.
const PLAIN = /^[\x20-\x7E\u2018\u2019\u201C\u201D\u2013\u2014\u2026]*$/;
const notPlain = (s) => [...s].find((c) => !PLAIN.test(c));
const codepoint = (c) => `U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`;
// a word of four or more characters that mixes letters and digits: comment ids, batch ids, tickets, session keys, and the pieces of a
// token cut into short words (the 20-character rule alone would miss "vh66p rKjSV ...")
const idShaped = (s) => (s.match(/[A-Za-z0-9_-]{4,}/g) || []).find((w) => /[A-Za-z]/.test(w) && /\d/.test(w));

/**
 * Problems with one string of the recording ("" when none). `piece`: a slice of a sentence (a diff step), which may start or end with a
 * space, so it is checked for control characters and length instead of against untrusted().
 */
export function stringProblem(s, identity, cap = 500, { piece = false } = {}) {
  if (typeof s !== "string") return "is not text";
  if (piece ? hasControlChars(s) || [...s].length > cap || s.normalize("NFC") !== s : untrusted(s, cap) !== s) return "has control or bidirectional characters, extra spaces, or is too long";
  const odd = notPlain(s);
  if (odd) return `holds a character outside plain text (${codepoint(odd)})`;
  for (const [re, what] of RULES) if (re.test(s)) return `holds ${what}`;
  const id = idShaped(s);
  if (id) return `holds an id-shaped word (${id.slice(0, 3)}...)`;
  return identityProblem(s, identity);
}

/** Checks `s` as written and folded (compatibility forms, invisible format characters and accents removed), so a soft hyphen or a
 * full-width letter does not hide a name in the XML parts, which are not held to the plain-text rule. */
function identityProblem(s, identity) {
  const folded = s.normalize("NFKD").replace(/[\p{Cf}\p{Mn}]/gu, "");
  return identityIn(s, identity) || (folded !== s ? identityIn(folded, identity) : "");
}

function identityIn(s, identity) {
  const lower = s.toLowerCase();
  if (identity.home && identity.home.length > 1 && lower.includes(identity.home.toLowerCase())) return "holds this Mac's home folder";
  for (const [k, what] of [["user", "user name"], ["host", "computer name"]]) {
    const v = identity[k];
    if (v && v.length >= 3 && new RegExp(`(^|[^A-Za-z0-9])${esc(v)}($|[^A-Za-z0-9])`, "i").test(s)) return `holds this Mac's ${what}`;
  }
  return "";
}

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
// exactly these keys, in this order: the page gets recording.json re-serialized, which keeps key order, so an order would be a free choice
const keysExactly = (v, keys) => isObj(v) && Object.keys(v).length === keys.length && Object.keys(v).every((k, i) => k === keys[i]);
const isMs = (v) => Number.isInteger(v) && v >= 0 && v <= 3_600_000;

/** Every structural and provenance check on one document. Returns a list of problems. */
export function scanDocx(bytes, label, identity = localIdentity()) {
  const out = [];
  let zip;
  try {
    zip = openZip(bytes);
  } catch (err) {
    return [`${label}: not a readable document (${err.message})`];
  }
  for (const name of zip.names) {
    const where = `${label} ${name.replace(/[^\w./[\]-]/g, "?").slice(0, 80)}`;
    if (!/\.(xml|rels)$/i.test(name)) {
      out.push(`${where}: a part that is not XML (an image or an embedded file)`);
      continue;
    }
    if (identityProblem(name, identity)) out.push(`${where}: the part name ${identityProblem(name, identity)}`);
    const xml = zip.readText(name);
    if (xml == null) continue;
    if (/TargetMode\s*=\s*["']External["']/i.test(xml)) out.push(`${where}: an external relationship`);
    for (const [re, what] of [
      [/<w:instrText\b/, "a field (w:instrText)"],
      [/<w:fldSimple\b/, "a field (w:fldSimple)"],
      [/attachedTemplate/, "an attached template"],
      [/altChunk/i, "an altChunk"],
      [/subDoc/i, "a subDoc"],
      [/oleObject/i, "an OLE object"],
      [/\br:link\s*=/, "a linked image (r:link)"],
    ])
      if (re.test(xml)) out.push(`${where}: ${what}`);
    // namespace declarations and relationship or content type names are URLs by definition; nothing else may be
    const rest = xml
      .replace(/<\?xml[^>]*\?>/g, "")
      .replace(/\sxmlns(:[\w.-]+)?\s*=\s*("[^"]*"|'[^']*')/g, "")
      .replace(/<(Relationship|Default|Override)\b[^>]*>/g, (m) => m.replace(/\s(Type|ContentType)\s*=\s*("[^"]*"|'[^']*')/g, ""))
      .replace(/\s(xsi:schemaLocation|mc:Ignorable)\s*=\s*("[^"]*"|'[^']*')/g, "");
    if (/[a-z][a-z0-9+.-]*:\/\//i.test(rest) || /\bwww\./i.test(rest)) out.push(`${where}: a web address`);
    if (/[^\s@<>"']+@[^\s@<>"']+\.[a-z]{2,}/i.test(rest)) out.push(`${where}: an email address`);
    if (/(^|[\s>"'(=])(~|\.{1,2})?\/(Users|private|tmp|var|Volumes|home)\b/i.test(rest)) out.push(`${where}: a file path`);
    const who = identityProblem(rest, identity);
    if (who) out.push(`${where}: ${who}`);
  }
  return out;
}

/**
 * The parts of the generated welcome.docx (make-fixtures.py, python-docx pinned in scripts/requirements.txt) and the sha256 of each
 * part's content. The parts are byte-stable across runs (only the ZIP's own time stamps change), so v0 must match every one: nothing in
 * v0, inside or outside the body, can be anything but the letter. test/demo-record.test.js regenerates the letter and checks this list.
 */
export const LETTER = Object.freeze({
  "[Content_Types].xml": "5affc2b6f5a2c8c77ee6ac9754dbd8b00161e6ab7b3c884ca6c169fd26f8b54b",
  "_rels/.rels": "1aa88a511268d274d555cfe6dd73009814426c28b90c08999e06f100b469d436",
  "docProps/core.xml": "18997ccc2b2acfd433258e8ec77885b1731b60b51db38cbf51540846ba9c9a48",
  "docProps/app.xml": "be664981c3141cddfc59362beb287ebf20d0773660e2dd6faac5968a5930a081",
  "word/document.xml": "f8ebec00f496c671832cd5bb1aefda71e4e0945eaa8de0cf43eb4dbc5a008f9a",
  "word/_rels/document.xml.rels": "70ef9c3bbfc48354644004ace7666ae3b97e3afe6704f1584c160cb105827769",
  "word/styles.xml": "02d71a68ddb92c055e84526d6a9e45700be3872781ababf759241694bc30e384",
  "word/stylesWithEffects.xml": "463ae0928cf0d84775dbf8cf18d6c3029f6707c81bf590f6d6dd8757a5e93f15",
  "word/settings.xml": "4ab3c91f9d1de77eeb5db0c4a8da01c31da542c7c84a67e0e357f7592192c5f4",
  "word/webSettings.xml": "349d36de7434d09f86987ff671d8814964a0588c1e630c06e562cda7e75e9f95",
  "word/fontTable.xml": "79385fb7f60247507ecaffc292e9ebd52ea0657b8634f629ba6fccc54011d6bb",
  "word/theme/theme1.xml": "e3a8ab7db9ca7afca56f5f2820a56e8b660016c647773555b060b0a02ac76941",
  "word/numbering.xml": "70976f19cbcd896e51890859fe6ecb3467a5a7ad0c040160fedc5a1993cb09ce",
});
export const LETTER_PARTS = Object.freeze(Object.keys(LETTER));
const BODY = "word/document.xml";

/**
 * The body may hold text only where the paragraph reader sees it: no text boxes, tracked changes, drawings, objects or links, no XML
 * comments or processing instructions, no text outside w:t, every w:t inside the paragraphs' text, and no token-like attribute value.
 */
export function bodyProblems(bytes, label, paras) {
  let xml;
  try {
    xml = openZip(bytes).readText(BODY);
  } catch {
    xml = null;
  }
  if (xml == null) return [`${label}: the body is missing`];
  const out = [];
  for (const el of ["w:txbxContent", "w:delText", "w:del", "w:ins", "w:moveFrom", "w:moveTo", "w:drawing", "w:pict", "w:object", "w:hyperlink", "w:customXml", "w:sdt", "w:comment"])
    if (new RegExp(`<${el}\\b`).test(xml)) out.push(`${label} body: holds ${el}`);
  const inner = xml.replace(/^\s*<\?xml[^>]*\?>/, "");
  if (/<!--|<\?|<!\[CDATA\[|<!DOCTYPE/i.test(inner)) out.push(`${label} body: holds an XML comment or instruction`);
  const texts = [];
  const outside = inner.replace(/<w:t(\s[^>]*)?>([^<]*)<\/w:t>/g, (_, a, t) => (texts.push(t), "")).replace(/<[^>]*>/g, "");
  if (outside.trim()) out.push(`${label} body: holds text outside the paragraphs' runs`);
  const unescape = (t) =>
    t
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Math.min(parseInt(n, 16), 0x10ffff)))
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Math.min(+n, 0x10ffff)))
      .replace(/&amp;/g, "&");
  const all = paras.join("\n");
  for (const t of texts) {
    // one spelling per text: the engine's (src/xml-tree.js escText). A character reference or an escaped quote reads the same on screen,
    // so a choice between spellings would be a place to hide bits.
    if (escText(unescape(t)) !== t) out.push(`${label} body: holds run text not written the plain way`);
    const odd = notPlain(unescape(t));
    if (odd) out.push(`${label} body: holds a character outside plain text (${codepoint(odd)})`);
    const clean = untrusted(unescape(t), 100000);
    if (clean && !all.includes(clean)) out.push(`${label} body: holds run text the paragraphs do not show`);
  }
  const attrs = inner.replace(/\sxmlns(:[\w.-]+)?\s*=\s*("[^"]*"|'[^']*')/g, "").match(/\s[\w:.-]+\s*=\s*("[^"]*"|'[^']*')/g) || [];
  for (const a of attrs) if (/[0-9a-f]{16,}/i.test(a) || /[A-Za-z0-9_-]{20,}/.test(a.replace(/^\s[\w:.-]+\s*=\s*/, ""))) out.push(`${label} body: an attribute holds a token-like value`);
  return [...new Set(out)];
}

/** v0 has exactly the letter's parts; v1 has the same parts, and every one but the body is byte for byte v0's. */
export function packageProblems(v0, v1) {
  let a, b;
  try {
    a = openZip(v0);
    b = openZip(v1);
  } catch {
    return ["a document is not a readable package"];
  }
  const out = [];
  // the same names in the same order: an order of the 13 parts is a choice (about 32 bits), so it is pinned to the letter's
  const same = (x, y) => x.length === y.length && x.every((n) => y.includes(n));
  const inOrder = (x, y) => x.length === y.length && x.every((n, i) => n === y[i]);
  if (!same(a.names, [...LETTER_PARTS])) out.push("v0.docx does not have the parts of the bundled letter");
  else if (!inOrder(a.names, [...LETTER_PARTS])) out.push("v0.docx does not have the letter's parts in the letter's order");
  else for (const n of a.names) if (sha256(a.read(n)) !== LETTER[n]) out.push(`v0.docx ${n} is not the bundled letter's`);
  if (!same(b.names, a.names)) out.push("v1.docx adds or removes parts of the letter");
  else if (!inOrder(b.names, a.names)) out.push("v1.docx does not have the letter's parts in the letter's order");
  else for (const n of a.names) if (n !== BODY && !a.read(n).equals(b.read(n))) out.push(`v1.docx changes ${n.replace(/[^\w./[\]-]/g, "?").slice(0, 80)}; only the body may change`);
  return out;
}

/** A body with the text of every run emptied: what is left is all the markup, declaration and spacing included. */
const skeleton = (xml) => xml.replace(/(<w:t(?:\s[^>]*)?>)[^<]*(<\/w:t>)/g, "$1$2");

/**
 * v1's body must be the letter's body (v0, pinned above) with only the text inside runs changed: the same declaration, elements,
 * attributes, values, order and spacing, byte for byte. A bookmark name, a made-up revision id, an odd attribute name, words inside a
 * tag, an instruction before the root or extra spacing between tags is refused; none of it is shown and the replay needs none of it.
 * Ceiling: an agent edit that splits a run, adds formatting or adds a paragraph is refused too, so a recording must be of text edits.
 */
export function markupProblems(v0, v1) {
  let a, b;
  try {
    a = openZip(v0).readText(BODY);
    b = openZip(v1).readText(BODY);
  } catch {
    return ["a document is not a readable package"];
  }
  if (a == null || b == null) return [];
  return skeleton(a) === skeleton(b) ? [] : ["v1.docx body: holds markup the letter does not have (only the words inside the letter's runs may change)"];
}

const MAX_PART = 64 * 1024 * 1024;
/**
 * Every byte of the file is a ZIP structure the scan reads or a part's compressed data, and every header field that is not content is
 * the recorder's fixed constant (CANONICAL in canonical.mjs, which record.mjs writes): the end record is the last 22 bytes (no archive
 * comment) and names one disk, the central directory sits right before it, the entries follow one another from byte 0 with no gaps, no
 * entry has an extra field, a comment or a trailing data descriptor, each local header repeats its central record, every entry carries
 * the same time stamp (1980-01-01 00:00:00), version, flags and attributes and is deflated, and each part's data is exactly the standard
 * deflate encoding of its content, checked by re-encoding it. The headers hold no free bits: what is left is the parts' names, which
 * packageProblems pins to the letter's, in the letter's order, and their content, which the rest of the scan reads.
 */
export function packingProblems(buf, label) {
  const bad = (why) => [`${label} is not packed the way the recorder packs it (${why})`];
  if (!Buffer.isBuffer(buf) || buf.length < 22) return bad("too short");
  const end = buf.length - 22;
  if (buf.readUInt32LE(end) !== 0x06054b50) return bad("the end record is not the last bytes: an archive comment or trailing bytes");
  const count = buf.readUInt16LE(end + 10);
  const cdSize = buf.readUInt32LE(end + 12);
  const cdOff = buf.readUInt32LE(end + 16);
  if (buf.readUInt16LE(end + 4) || buf.readUInt16LE(end + 6) || buf.readUInt16LE(end + 8) !== count || buf.readUInt16LE(end + 20)) return bad("the end record is not plain");
  if (cdOff + cdSize !== end) return bad("bytes between the central directory and the end record");
  let p = cdOff;
  let next = 0;
  for (let k = 0; k < count; k++) {
    if (p + 46 > end || buf.readUInt32LE(p) !== 0x02014b50) return bad("a bad central record");
    const c = {
      madeBy: buf.readUInt16LE(p + 4),
      need: buf.readUInt16LE(p + 6),
      flags: buf.readUInt16LE(p + 8),
      method: buf.readUInt16LE(p + 10),
      time: buf.readUInt16LE(p + 12),
      date: buf.readUInt16LE(p + 14),
      crc: buf.readUInt32LE(p + 16),
      comp: buf.readUInt32LE(p + 20),
      size: buf.readUInt32LE(p + 24),
      nameLen: buf.readUInt16LE(p + 28),
      extraLen: buf.readUInt16LE(p + 30),
      commentLen: buf.readUInt16LE(p + 32),
      disk: buf.readUInt16LE(p + 34),
      internal: buf.readUInt16LE(p + 36),
      external: buf.readUInt32LE(p + 38),
      local: buf.readUInt32LE(p + 42),
    };
    if (c.extraLen || c.commentLen) return bad("an entry carries an extra field or a comment");
    if (c.time !== CANONICAL.time || c.date !== CANONICAL.date) return bad("an entry's time stamp is not the fixed one");
    if (c.disk || ["madeBy", "need", "flags", "method", "internal", "external"].some((k) => c[k] !== CANONICAL[k])) return bad("an entry's header numbers are not the fixed ones");
    const name = buf.subarray(p + 46, p + 46 + c.nameLen);
    if (c.local !== next) return bad("bytes between the entries");
    const lo = c.local;
    if (lo + 30 > cdOff || buf.readUInt32LE(lo) !== 0x04034b50) return bad("a bad local header");
    const same = [
      [buf.readUInt16LE(lo + 4), c.need],
      [buf.readUInt16LE(lo + 6), c.flags],
      [buf.readUInt16LE(lo + 8), c.method],
      [buf.readUInt16LE(lo + 10), c.time],
      [buf.readUInt16LE(lo + 12), c.date],
      [buf.readUInt32LE(lo + 14), c.crc],
      [buf.readUInt32LE(lo + 18), c.comp],
      [buf.readUInt32LE(lo + 22), c.size],
      [buf.readUInt16LE(lo + 26), c.nameLen],
      [buf.readUInt16LE(lo + 28), 0],
    ].every(([x, y]) => x === y);
    if (!same || !buf.subarray(lo + 30, lo + 30 + c.nameLen).equals(name)) return bad("a local header does not repeat its central record");
    const start = lo + 30 + c.nameLen;
    if (start + c.comp > cdOff || c.size > MAX_PART) return bad("an entry runs past its place");
    const data = buf.subarray(start, start + c.comp);
    let r;
    try {
      r = zlib.inflateRawSync(data, { info: true, maxOutputLength: MAX_PART });
    } catch {
      return bad("a part cannot be read");
    }
    if (r.engine.bytesWritten !== data.length) return bad("bytes after a part's compressed data");
    const content = r.buffer;
    if (!zlib.deflateRawSync(content).equals(data)) return bad("a part's compressed data is not the standard encoding of its content");
    if (content.length !== c.size || crc32(content) !== c.crc) return bad("a part's size or checksum is wrong");
    next = start + c.comp;
    p += 46 + c.nameLen;
  }
  if (next !== cdOff) return bad("bytes between the last entry and the central directory");
  if (p !== end) return bad("the central directory holds more than its records");
  return [];
}

const paragraphs = (bytes) => readDocxParagraphs(bytes).map((p) => untrusted(p.text, 100000));

/** The places the page draws, rebuilt from compareBytes: only {change, diff, text_start}, and only modified paragraphs. */
export function placesFor(v0, v1) {
  const r = compareBytes("docx", v0, v1, { places: true });
  if (r.counts.added || r.counts.removed) throw new Error("the agent added or removed a paragraph; the replay shows changed paragraphs only");
  if (r.more) throw new Error("too many changed places for the replay");
  return r.places.map((p) => {
    if (p.change !== "modified" || !Array.isArray(p.diff) || p.too_large) throw new Error(`a place the replay cannot show (${String(p.change).slice(0, 20)})`);
    return { change: "modified", diff: p.diff.map((op) => (op[0] === "…" ? ["…"] : [op[0], op[1]])), text_start: p.locator?.text_start ?? "" };
  });
}

/**
 * Every check on a recording held in memory: {recording (parsed JSON), v0, v1 (Buffers)}. Returns a list of plain problems ([] = safe).
 * `test` allows `real: false` (a recording made with the stand-in agent); nothing else is relaxed.
 */
export function scanRecording({ recording: r, v0, v1 }, { identity = localIdentity(), test = false } = {}) {
  const out = [];
  const str = (where, s, cap, o) => {
    const p = stringProblem(s, identity, cap, o);
    if (p) out.push(`${where} ${p}`);
    return !p;
  };
  if (!keysExactly(r, KEYS.top)) return [`recording.json must hold exactly these fields: ${KEYS.top.join(", ")}`];
  if (r.schema !== SCHEMA) out.push(`schema must be ${SCHEMA}`);
  if (typeof r.real !== "boolean") out.push("real must be true or false");
  else if (!r.real && !test) out.push("this recording was made with the stand-in agent (real: false); it can never be shown as a real session");
  str("agent", r.agent, CAPS.agent);
  if (!r.agent) out.push("agent is empty");
  if (typeof r.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(r.date)) out.push("date must be a day (YYYY-MM-DD)");
  if (r.format !== "docx") out.push("format must be docx");
  if (!Buffer.isBuffer(v0) || r.v0_sha256 !== sha256(v0)) out.push("v0_sha256 does not match v0.docx");
  if (!Buffer.isBuffer(v1) || r.v1_sha256 !== sha256(v1)) out.push("v1_sha256 does not match v1.docx");
  if (out.length && (!Buffer.isBuffer(v0) || !Buffer.isBuffer(v1))) return out;

  out.push(...packingProblems(v0, "v0.docx"), ...packingProblems(v1, "v1.docx"));
  out.push(...scanDocx(v0, "v0.docx", identity), ...scanDocx(v1, "v1.docx", identity));
  let p0, p1, raw1;
  try {
    p0 = paragraphs(v0);
    raw1 = readDocxParagraphs(v1).map((p) => p.text);
    p1 = raw1.map((t) => untrusted(t, 100000));
  } catch (err) {
    return [...out, `a document could not be read (${err.message})`];
  }
  // the text as written, before cleaning: doubled, leading or trailing spaces do not show on the page, so they are not allowed to exist
  raw1.forEach((t, i) => t !== p1[i] && out.push(`v1.docx paragraph ${i + 1} has extra spaces or characters the page does not show`));
  if (p0.length !== DEMO.letter.length || p0.some((t, i) => t !== DEMO.letter[i])) out.push("v0.docx is not the bundled demo letter");
  out.push(...packageProblems(v0, v1), ...bodyProblems(v0, "v0.docx", p0), ...bodyProblems(v1, "v1.docx", p1), ...markupProblems(v0, v1));
  if (p1.length !== p0.length) out.push("v1.docx adds or removes paragraphs");
  p1.forEach((t, i) => str(`v1.docx paragraph ${i + 1}`, t, 100000));
  const inV0 = (s) => s === "" || p0.some((t) => t.includes(s));
  const inV1 = (s) => s === "" || p1.some((t) => t.includes(s));

  if (!Array.isArray(r.comments) || r.comments.length !== DEMO.comments.length) out.push(`comments must list the ${DEMO.comments.length} scenario comments`);
  else
    r.comments.forEach((c, i) => {
      const w = `comment ${i + 1}`;
      if (!keysExactly(c, KEYS.comment)) return out.push(`${w} must hold exactly: ${KEYS.comment.join(", ")}`);
      if (c.n !== i + 1) out.push(`${w} is numbered ${String(c.n).slice(0, 8)}`);
      if (str(`${w} text`, c.text, CAPS.comment) && c.text !== DEMO.comments[i].text) out.push(`${w} text is not the scenario's comment`);
      for (const k of ["quote", "prefix", "suffix"]) if (str(`${w} ${k}`, c[k], CAPS.quote) && !inV0(c[k])) out.push(`${w} ${k} is not text of the letter`);
      if (!c.quote) out.push(`${w} has no quote`);
    });
  if (str("overall_note", r.overall_note, CAPS.comment) && r.overall_note !== DEMO.overall) out.push("overall_note is not the scenario's note");

  if (!keysExactly(r.result, KEYS.result)) out.push(`result must hold exactly: ${KEYS.result.join(", ")}`);
  else {
    str("result summary", r.result.summary, CAPS.summary);
    if (!Array.isArray(r.result.notes) || r.result.notes.length !== DEMO.comments.length) out.push("result notes must answer each comment once");
    else
      r.result.notes.forEach((n, i) => {
        const w = `result note ${i + 1}`;
        if (!keysExactly(n, KEYS.note)) return out.push(`${w} must hold exactly: ${KEYS.note.join(", ")}`);
        if (n.n !== i + 1) out.push(`${w} is numbered ${String(n.n).slice(0, 8)}`);
        if (!["done", "declined"].includes(n.status)) out.push(`${w} status must be done or declined`);
        str(`${w} text`, n.note, CAPS.note);
      });
  }

  let expected = null;
  try {
    expected = placesFor(v0, v1);
  } catch (err) {
    out.push(err.message);
  }
  if (!Array.isArray(r.places)) out.push("places must be a list");
  else {
    r.places.forEach((p, i) => {
      const w = `place ${i + 1}`;
      if (!keysExactly(p, KEYS.place)) return out.push(`${w} must hold exactly: ${KEYS.place.join(", ")}`);
      if (p.change !== "modified") out.push(`${w} change must be modified`);
      if (str(`${w} text_start`, p.text_start, 160) && !inV1(p.text_start)) out.push(`${w} text_start is not text of v1.docx`);
      if (!Array.isArray(p.diff)) return out.push(`${w} diff must be a list`);
      p.diff.forEach((op, j) => {
        const ow = `${w} diff ${j + 1}`;
        if (!Array.isArray(op) || !["=", "-", "+", "…"].includes(op[0]) || op.length !== (op[0] === "…" ? 1 : 2)) return out.push(`${ow} is not a diff step`);
        if (op[0] === "…" || !str(ow, op[1], 2000, { piece: true })) return;
        if ((op[0] === "=" || op[0] === "-") && !inV0(op[1])) out.push(`${ow} is not text of the letter`);
        if ((op[0] === "=" || op[0] === "+") && !inV1(op[1])) out.push(`${ow} is not text of v1.docx`);
      });
    });
    if (expected && JSON.stringify(expected) !== JSON.stringify(r.places)) out.push("places are not what the two versions show");
  }

  if (!keysExactly(r.timing, KEYS.timing)) out.push(`timing must hold exactly: ${KEYS.timing.join(", ")}`);
  else if (!isMs(r.timing.working_ms) || !isMs(r.timing.result_ms) || r.timing.working_ms > r.timing.result_ms) out.push("timing must be whole milliseconds, working before result, under an hour");
  return [...new Set(out)];
}

/** Reads a recording folder and scans it. Returns {problems, recording?}. Used by this CLI and by the page's build step. */
export function scanFolder(dir, opts = {}) {
  const missing = FILES.filter((f) => !fs.existsSync(path.join(dir, f)));
  if (missing.length) return { problems: missing.map((f) => `${f} is missing`) };
  // nothing else, not even a Finder .DS_Store: the folder is committed as it is, and any other file could carry anything
  const extra = fs.readdirSync(dir).filter((f) => !FILES.includes(f));
  if (extra.length) return { problems: [`the folder holds files that are not part of a recording: ${extra.length}`] };
  let recording;
  try {
    recording = JSON.parse(fs.readFileSync(path.join(dir, "recording.json"), "utf8"));
  } catch {
    return { problems: ["recording.json is not valid JSON"] };
  }
  const problems = scanRecording({ recording, v0: fs.readFileSync(path.join(dir, "v0.docx")), v1: fs.readFileSync(path.join(dir, "v1.docx")) }, opts);
  return { problems, recording };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith("--"));
  if (!dir) (console.error("usage: scan.mjs <recording folder> [--test]"), process.exit(2));
  const { problems } = scanFolder(path.resolve(dir), { test: args.includes("--test") });
  if (problems.length) {
    console.error(`Refused: ${problems.length} problem(s) in this recording.`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log("The recording passed the scan.");
}
