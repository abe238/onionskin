import { colLetters, parseA1 } from "./ops/common.js";
import { untrusted } from "./sanitize.js";
import crypto from "node:crypto";
import { nfc } from "./nfc.js";
import { exactHash, normText, spend, weigh } from "./text.js";
import { CapError, readBudget, tooMany, walkXml } from "./xml.js";
import { openZip } from "./zip.js";

// XLSX durable anchors. Everything is read from the bytes with the small XML walker (no engine). Names are matched by local name,
// because writers differ in prefixes. Cell text is the text a user would see in the formula bar, as `onionskin apply` expects it:
// the formula (with a leading =) when the cell has one, else the stored value. A shared-formula child (no formula text of its own)
// falls back to its cached value (ceiling: its quote is then not the formula) and is marked `shared`: its text is a result that changes
// when another cell does, never something a person typed.

const local = (n) => n.slice(n.indexOf(":") + 1);
const attrOf = (attrs, name) => {
  for (const k of Object.keys(attrs)) if (k.includes(":") && local(k) === name) return attrs[k];
  return undefined;
};
const NUM = /^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const EMPTY = exactHash("");
/** hash of a parsed cell's text, computed once per cell (resolution and the diff would otherwise hash every cell per anchor) */
export const ch = (cell) => (cell.h ??= exactHash(cell.text));
const short = (s, n = 80) => normText(s).slice(0, n);
// The request's budget (src/text.js scanBudget) pays for every character hashed or cleaned, at the cell, the first time (ch and sh keep
// the result on the cell), and an anchor being made pays like one being resolved: a text the budget cannot pay for is not read (no hash,
// no header). An anchor made without its hash still goes out with its address and the context that was paid for (xlsxDurable); a hit
// whose text cannot be paid for while resolving is not one ("moved or removed" when nothing else places it). The cost of a cell's text
// is weigh() (src/text.js), kept on the cell: non-ASCII text costs the CPU about four times what ASCII does. The reviewer's case: 50
// anchors on A1:B1 through A1:AY1 of a cell of 31 million "é" each joined and hashed the cell, 6.6 s of CPU, while an anchor being made
// was charged whatever was left and went on.
const costOf = (cell) => (cell.w ??= weigh(cell.text));
const spent = (cell) => spend(costOf(cell));
/** short() of a parsed cell's text (or "" for no cell, or past the budget), computed once per cell like ch(): resolving one anchor compares
 * the same header or neighbor with every hit, and normalizing a 20,000-character header per hit held the server 4 s on a column of 248,000 equal cells */
const sh = (cell) => (!cell ? "" : cell.sh ?? (spent(cell) ? (cell.sh = short(cell.text)) : ""));
/** ch(cell), paid from the budget when the cell's text is not hashed yet; null past it */
const chPaid = (cell) => (cell.h !== undefined || spent(cell) ? ch(cell) : null);
// What one reading of a workbook may hold, over every sheet it reads. The server reads a workbook on its own thread at Send, at each delivery
// to an agent, for a review and at the end of a run, so these bound how long that keeps it from answering (outside review: a sheet of
// 1.5 million cells held it 1.6 s; 100,000 merged ranges made a review take 18 s). Cells are counted as written (<c> elements), empty or
// not. A file past a cap is refused with the reason; it is never read in part. Set from measurement (docs/GUIDE.md "Size limits"), at a
// load average of 13 to 21 here: a plain workbook of 999,000 cells (10 to a row, half numbers, half short shared strings) kept /health
// waiting at most 0.74 to 0.83 s (the Send) and the server at 1.5 GB; with 30 more characters in each text, 0.86 s and 1.6 GB; 999,000
// cells on one shared string, with 49,000 merged ranges, or 100 number cells to a row, 0.57 to 0.65 s. 0.0.3 took 3.1 s at 1,000,000.
// A higher cap needs the Send's whole reading moved into a worker (the Send is the longest step, and the memory grows with it).
export const MAX_CELLS = 1_000_000;
export const MAX_MERGES = 50_000;
export const MAX_SHARED_STRINGS = 1_000_000;
export const MAX_NAMES = 20_000;
export const MAX_SHEETS = 1000;
// Characters of a sheet's name. Excel allows 31; every cell of the sheet carries the name in a review's and an agent's outline (a name of
// 100,000 characters made an outline of 2,000 cells take 1.8 s on the server thread).
export const MAX_SHEET_NAME = 255;
export const MAX_BOOK_ELEMENTS = 3_200_000;
export const MAX_BOOK_ATTRIBUTES = 6_400_000;
export const MAX_BOOK_TEXT = 32_000_000;
// Characters of XML one reading of a workbook may walk (other files: MAX_READ_CHARS, 32 million). A plain workbook of 999,000 cells with
// half of them short texts is about 48 to 62 million; two sheets of one 31-million-character attribute each (the worst shape) held /health 0.43 s.
export const MAX_BOOK_CHARS = 64_000_000;
// Characters of text the cells take from the shared strings, counted per cell as the cell is read. A shared string's text is counted once
// in MAX_BOOK_TEXT, but every cell that points at it is a cell of that text for the readers after this one (a review's outline hashes and
// cleans each cell's text): 249,000 cells pointing at one string of 20,000 characters (a 517 KB file within every other cap) held the
// server 4 to 6 s per review, delivery and done. At this cap a reading's cells hold at most 32 million characters from shared strings
// (plus at most MAX_BOOK_TEXT of their own). Measured per review or outline on the server thread, at a load average of 16: 249,000 cells
// of 128 characters about 170 ms; 4 cells of 7.9 million characters (the worst shape: each unit's text is cleaned whole) about 175 ms;
// 8 such cells (64 million) 350 ms.
export const MAX_SHARED_CELL_TEXT = 32_000_000;
const bookBudget = () => Object.assign(readBudget({ elements: MAX_BOOK_ELEMENTS, attrs: MAX_BOOK_ATTRIBUTES, text: MAX_BOOK_TEXT, chars: MAX_BOOK_CHARS, what: "workbook", split: "smaller workbooks" }), { cells: 0, merges: 0, sharedText: MAX_SHARED_CELL_TEXT });
const KEEP_ROW_CELLS = 64;
const SAME_TEXT_WORK = 4_000_000;

const relTarget = (base, target) => {
  if (target.startsWith("/")) return target.slice(1);
  const parts = base.split("/").slice(0, -1);
  for (const seg of target.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== ".") parts.push(seg);
  }
  return parts.join("/");
};

export function readRels(zip, part, budget = null) {
  const dir = part.split("/").slice(0, -1).join("/");
  const rels = new Map();
  const xml = zip.readText(`${dir ? `${dir}/` : ""}_rels/${part.split("/").pop()}.rels`);
  if (xml == null) return rels;
  walkXml(xml, {
    onOpen(name, a) {
      if (local(name) === "Relationship" && a.Id && a.Target) rels.set(a.Id, relTarget(part, a.Target));
    },
  }, budget);
  return rels;
}
export { attrOf, local };

/** workbook.xml: sheets in order with sheetId, name, part path; defined names. Sheet cells are read lazily (`sheetCells`). */
export function parseWorkbook(bytes) {
  const zip = openZip(bytes);
  const xml = zip.readText("xl/workbook.xml");
  if (xml == null) throw new Error("xl/workbook.xml missing");
  const budget = bookBudget(); // the workbook part, its relationships, shared strings, styles and every sheet read share it
  const rels = readRels(zip, "xl/workbook.xml", budget);
  const sheets = [];
  const names = [];
  let curName = null;
  walkXml(xml, {
    onOpen(n, a) {
      const l = local(n);
      if (l === "sheet" && sheets.length >= MAX_SHEETS) throw tooMany(budget, MAX_SHEETS, "sheets");
      if (l === "definedName" && names.length >= MAX_NAMES) throw tooMany(budget, MAX_NAMES, "defined names");
      if (l === "sheet" && String(a.name ?? "").length > MAX_SHEET_NAME) throw new CapError(`a sheet in this workbook has a name longer than ${MAX_SHEET_NAME} characters, more than Onionskin can read. Rename it in Excel, which allows 31, and open it again`, "sheet name");
      if (l === "sheet") sheets.push({ index: sheets.length, name: a.name ?? "", sheetId: a.sheetId ?? null, hidden: a.state === "hidden" || a.state === "veryHidden", state: a.state ?? "visible", part: rels.get(attrOf(a, "id")) || null });
      else if (l === "definedName") curName = { name: a.name, ref: "" };
    },
    onText(t) {
      if (curName) curName.ref += t;
    },
    onClose(n) {
      if (local(n) === "definedName" && curName) {
        names.push(curName);
        curName = null;
      }
    },
  }, budget);
  // the shared strings and the number formats are read on first use, once; a reading that failed (past a cap) fails the same way
  // every time (a half-read list kept after the first failure was accepted on the next call)
  const once = (read) => {
    let value = null;
    let failed = null;
    return (...args) => {
      if (failed) throw failed;
      if (value) return value;
      try {
        return (value = read(...args));
      } catch (err) {
        failed = err;
        throw err;
      }
    };
  };
  const sharedStrings = once(() => {
    const sst = [];
    const sx = zip.readText("xl/sharedStrings.xml");
    if (sx == null) return sst;
    let cur = null;
    let inT = false;
    let phon = 0;
    walkXml(sx, {
      onOpen(n) {
        const l = local(n);
        if (l === "si") cur = "";
        else if (l === "rPh") phon++;
        else if (l === "t" && cur !== null && !phon) inT = true;
      },
      onText(t) {
        if (inT) cur += t;
      },
      onClose(n) {
        const l = local(n);
        if (l === "t") inT = false;
        else if (l === "rPh") phon = Math.max(0, phon - 1);
        else if (l === "si") {
          if (sst.length >= MAX_SHARED_STRINGS) throw tooMany(budget, MAX_SHARED_STRINGS, "shared strings");
          sst.push(cur ?? "");
          cur = null;
        }
      },
    }, budget);
    return sst;
  });
  const cache = new Map();
  const sheetCells = (s) => {
    if (!cache.has(s.index)) cache.set(s.index, readSheet(zip, s, sharedStrings, budget));
    return cache.get(s.index);
  };
  // number formats: the style index of a cell -> its format code (xl/styles.xml cellXfs + numFmts, with the built-in ids)
  const formats = once(() => {
    const fmts = { custom: new Map(), xf: [] };
    const sx = zip.readText("xl/styles.xml");
    let inXfs = false;
    if (sx != null)
      walkXml(sx, {
        onOpen(n, a) {
          const l = local(n);
          if (l === "numFmt" && a.numFmtId != null) fmts.custom.set(Number(a.numFmtId), a.formatCode ?? "");
          else if (l === "cellXfs") inXfs = true;
          else if (l === "xf" && inXfs) fmts.xf.push(Number(a.numFmtId) || 0);
        },
        onClose(n) {
          if (local(n) === "cellXfs") inXfs = false;
        },
      }, budget);
    return fmts;
  });
  const numberFormat = (styleIdx) => {
    const fmts = formats();
    const id = fmts.xf[styleIdx] ?? 0;
    return fmts.custom.get(id) ?? BUILTIN_FORMATS[id] ?? (id ? `format ${id}` : "General");
  };
  return { sheets, names, sheetCells, numberFormat };
}

const BUILTIN_FORMATS = { 0: "General", 1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00", 9: "0%", 10: "0.00%", 11: "0.00E+00", 12: "# ?/?", 13: "# ??/??", 14: "mm-dd-yy", 15: "d-mmm-yy", 16: "d-mmm", 17: "mmm-yy", 18: "h:mm AM/PM", 19: "h:mm:ss AM/PM", 20: "h:mm", 21: "h:mm:ss", 22: "m/d/yy h:mm", 37: "#,##0 ;(#,##0)", 38: "#,##0 ;[Red](#,##0)", 39: "#,##0.00;(#,##0.00)", 40: "#,##0.00;[Red](#,##0.00)", 45: "mm:ss", 46: "[h]:mm:ss", 47: "mmss.0", 48: "##0.0E+0", 49: "@" };

const key = (r, c) => r * 16384 + c;

/** {cells: Map(r*16384+c -> {r,c,text}), rows: Map(r -> cells sorted by column), maxR, maxC, truncated, merges: [{r0,c0,r1,c1}]}. Empty cells are not kept. */
function readSheet(zip, sheet, sharedStrings, budget = bookBudget()) {
  const cells = new Map();
  const rows = new Map();
  const out = { cells, rows, maxR: -1, maxC: -1, truncated: false, merges: [] };
  const xml = sheet.part ? zip.readText(sheet.part) : null;
  if (xml == null) return out;
  let cur = null;
  let field = null; // v | f | is
  let inIs = false;
  let phon = 0;
  walkXml(xml, {
    onOpen(n, a) {
      const l = local(n);
      if (l === "mergeCell") {
        if (++budget.merges > MAX_MERGES) throw tooMany(budget, MAX_MERGES, "merged ranges");
        const q = parseA1(a.ref ?? "");
        if (q && (q.r1 > q.r0 || q.c1 > q.c0)) out.merges.push(q);
      } else if (l === "c" && ++budget.cells > MAX_CELLS) throw tooMany(budget, MAX_CELLS, "cells");
      else if (l === "c" && a.r) {
        const m = /^([A-Z]{1,3})(\d+)$/.exec(a.r);
        cur = m ? { c: [...m[1]].reduce((x, ch) => x * 26 + ch.charCodeAt(0) - 64, 0) - 1, r: Number(m[2]) - 1, t: a.t || "n", s: Number(a.s) || 0, v: "", f: null, is: "" } : null;
      } else if (!cur) return;
      else if (l === "v") field = "v";
      else if (l === "f") {
        field = "f";
        cur.f = "";
      } else if (l === "is") inIs = true;
      else if (l === "rPh") phon++;
      else if (l === "t" && inIs && !phon) field = "is";
    },
    onText(t) {
      if (cur && field) cur[field] += t;
    },
    onClose(n) {
      const l = local(n);
      if (l === "v" || l === "f" || l === "t") field = null;
      else if (l === "is") inIs = false;
      else if (l === "rPh") phon = Math.max(0, phon - 1);
      else if (l === "c" && cur) {
        let text;
        if (cur.f) text = `=${cur.f}`;
        else if (cur.t === "s") {
          text = sharedStrings()[Number(cur.v)] ?? "";
          if ((budget.sharedText -= text.length) < 0) throw tooMany(budget, MAX_SHARED_CELL_TEXT, "characters of text in its cells");
        }
        else if (cur.t === "inlineStr") text = cur.is;
        else if (cur.t === "b") text = cur.v === "1" ? "TRUE" : "FALSE";
        else if (cur.t === "n" && NUM.test(cur.v)) text = String(Number(cur.v));
        else text = cur.v;
        if (text !== "" && cur.c < 16384) {
          const cell = { r: cur.r, c: cur.c, text, k: cur.f ? "formula" : cur.t === "s" || cur.t === "inlineStr" || cur.t === "str" ? "text" : cur.t === "b" ? "boolean" : cur.t === "e" ? "error" : "number", s: cur.s, ...(cur.f ? { cached: cur.v } : cur.f === "" ? { shared: true } : {}) }; // `cached`: the value a formula last computed (History shows it next to the formula)
          const prev = cells.get(key(cur.r, cur.c));
          if (prev) {
            // a cell written twice: the later one counts, and its row lists it once
            for (const k of Object.keys(prev)) delete prev[k];
            Object.assign(prev, cell);
          }
          else {
            cells.set(key(cur.r, cur.c), cell);
            if (!rows.has(cur.r)) rows.set(cur.r, []);
            rows.get(cur.r).push(cell);
          }
          if (cur.r > out.maxR) out.maxR = cur.r;
          if (cur.c > out.maxC) out.maxC = cur.c;
        }
        cur = null;
      }
    },
  }, budget);
  for (const list of rows.values()) list.sort((a, b) => a.c - b.c);
  return out;
}

// ---- ranges and context ---------------------------------------------------------------------------------------

export const a1 = (r, c) => `${colLetters(c)}${r + 1}`;
export const a1Range = (q) => (q.r0 === q.r1 && q.c0 === q.c1 ? a1(q.r0, q.c0) : `${a1(q.r0, q.c0)}:${a1(q.r1, q.c1)}`);
const at = (sd, r, c) => (r < 0 || c < 0 ? "" : sd.cells.get(key(r, c))?.text ?? "");
/** the hash of the text at (r, c) (EMPTY for no cell), paid as chPaid pays it; null past the budget */
const hashAt = (sd, r, c) => {
  const cell = r < 0 || c < 0 ? undefined : sd.cells.get(key(r, c));
  return cell ? chPaid(cell) : EMPTY;
};
/** The parsed cell at row r, column c (0-based) of a sheet's cells (sheetCells), or undefined. */
export const cellAt = (sd, r, c) => sd.cells.get(key(r, c));
/** Merged ranges of a sheet by their top-left cell, built once per sheet: a lookup per cell, never a scan of every range. */
export function mergeAt(sd, r, c) {
  if (!sd.mergeIndex) {
    sd.mergeIndex = new Map();
    for (const q of sd.merges) if (!sd.mergeIndex.has(key(q.r0, q.c0))) sd.mergeIndex.set(key(q.r0, q.c0), q); // the first, as a scan finds it
  }
  return sd.mergeIndex.get(key(r, c));
}

/** the text of a rectangle as `apply` expects it: cells joined by TAB, rows by LF (bounded) */
export function rangeText(sd, q) {
  const rows = [];
  for (let r = q.r0; r <= Math.min(q.r1, q.r0 + 2000); r++) {
    const row = [];
    for (let c = q.c0; c <= Math.min(q.c1, q.c0 + 200); c++) row.push(at(sd, r, c));
    rows.push(row.join("\t"));
  }
  return rows.join("\n");
}

// What an anchor keeps of a range's text: the batch quotes at most 500 characters of it and shows at most 20 x 10 of its cells, 200
// characters each (src/batch.js). An anchor kept the whole text: 50 anchors on ranges of a cell of 31 million characters held 50 copies
// of it (the server ran out of memory), and each was saved with the session and cleaned again for the batch.
const CELL_KEEP = 1000;
const TEXT_KEEP = 4000;
const VALUES = { rows: 20, cols: 10 };
const cut = (s) => (s.length > CELL_KEEP ? s.slice(0, CELL_KEEP) : s);
const lastRow = (q) => Math.min(q.r1, q.r0 + 2000);
const lastCol = (q) => Math.min(q.c1, q.c0 + 200);

/**
 * A range as an anchor keeps it, per range on the sheet's reading: `text` (rangeText with each cell cut at CELL_KEEP characters, at most
 * TEXT_KEEP in all), `values` (its top-left VALUES.rows x VALUES.cols cells, cut the same way) and `hash`, the hash of the whole rangeText
 * (what `apply` checks an `expect.text_hash` against). Paid before the work: WALK_CELL units a cell to walk it, then HASH_CELL a cell and
 * weigh() of every cell's text for the hash (measured on 2,000 x 201 cells of "a": the walk 50 to 65 ns a cell, the hash 125; charged
 * at 3 and 1 units a cell, 500 comments on such ranges held a Send 3.1 s). Priced as a search is (src/text.js HIT, about 6 ns a unit):
 * a budget of range work is about 0.25 s. Past it an anchor goes out without its range hash (the agent is offered full ops for it).
 * Null when the walk cannot be paid; `hash` null when the hash cannot (asked again by the next request, on a fresh budget).
 * The hash is fed in chunks of whole cells, not a call per cell: 1,000 x 20 cells of ordinary values (about 10 characters) took 125 to
 * 140 ns a cell fed one by one and 25 to 35 ns in chunks (on "a": 100 and 25), so HASH_CELL is 5 and the text is paid by its weight.
 * Ordinary ranges cost about 25 units a cell: 50 of 1,000 x 20 cells take 25 million units (40.25 million at 20 a cell, and the 50th
 * went out without its hash). Ceiling: cells averaging past about 25 ASCII characters put 50 such ranges over the budget again.
 * NFC of the whole is the NFC of each cell, since a tab or a line break never composes or reorders with what is next to it (src/nfc.js
 * runs of marks end at either too), so a chunk ends after any cell. 50 distinct ranges on one large cell cost 50 hashes of
 * it, which the budget pays for or refuses; the cell's own hash (one-cell ranges, the top-left identity) is kept on the cell.
 */
const WALK_CELL = 10;
const HASH_CELL = 5;
const CHUNK = 1 << 16;
function rangeOf(sd, q) {
  const k = `${q.r0},${q.c0},${q.r1},${q.c1}`;
  const memo = (sd.ranges ||= new Map()); // Ceiling: one entry per range an anchor names, so at most the anchors of the reading
  let v = memo.get(k);
  const one = q.r0 === q.r1 && q.c0 === q.c1;
  if (!v) {
    const r1 = lastRow(q);
    const c1 = lastCol(q);
    if (!spend(WALK_CELL * (r1 - q.r0 + 1) * (c1 - q.c0 + 1))) return null;
    let text = "";
    let cost = 0;
    const values = [];
    for (let r = q.r0; r <= r1; r++) {
      const row = r - q.r0 < VALUES.rows ? [] : null;
      for (let c = q.c0; c <= c1; c++) {
        const cell = sd.cells.get(key(r, c));
        const t = cell ? cell.text : "";
        if (cell) cost += costOf(cell);
        cost += HASH_CELL;
        if (row && c - q.c0 < VALUES.cols) row.push(cut(t));
        if (text.length < TEXT_KEEP) text += (c > q.c0 ? "\t" : r > q.r0 ? "\n" : "") + cut(t);
      }
      if (row) values.push(row);
    }
    memo.set(k, (v = { text: text.length > TEXT_KEEP ? text.slice(0, TEXT_KEEP) : text, values, hash: null, cost }));
  }
  if (v.hash === null) v.hash = one ? hashAt(sd, q.r0, q.c0) : spend(v.cost) ? streamHash(sd, q) : null;
  return v;
}
/** exactHash(rangeText(sd, q)), fed in chunks that end after a whole cell */
function streamHash(sd, q) {
  const h = crypto.createHash("sha256");
  let buf = "";
  for (let r = q.r0; r <= lastRow(q); r++) {
    if (r > q.r0) buf += "\n";
    for (let c = q.c0; c <= lastCol(q); c++) {
      if (c > q.c0) buf += "\t";
      buf += at(sd, r, c);
      if (buf.length >= CHUNK) (h.update(nfc(buf)), (buf = ""));
    }
  }
  h.update(nfc(buf));
  return h.digest("hex").slice(0, 16);
}

// A number format as an anchor keeps it: its first FORMAT_KEEP characters (the batch shows 100), kept per style of a reading. An outside
// review: a custom format of 1,000 decomposed letters on every cell of A1:J20 was kept whole per cell of each of 500 anchors (323 MB).
// numberFormat() itself stays whole: the merge compares formats.
const FORMAT_KEEP = 100;
const FORMATS = new WeakMap();
function formatOf(wb, s) {
  let m = FORMATS.get(wb);
  if (!m) FORMATS.set(wb, (m = new Map()));
  let v = m.get(s);
  if (v === undefined) {
    v = wb.numberFormat(s);
    if (v.length > FORMAT_KEEP) v = v.slice(0, FORMAT_KEEP);
    m.set(s, v);
  }
  return v;
}
/** Per cell of a range (at most 20 x 10, like the evidence `values`): its kind (number, text, formula, boolean, error, empty) and number format. */
function cellMeta(wb, sd, q) {
  const types = [];
  const formats = [];
  for (let r = q.r0; r <= Math.min(q.r1, q.r0 + 19); r++) {
    const t = [];
    const f = [];
    for (let c = q.c0; c <= Math.min(q.c1, q.c0 + 9); c++) {
      const cell = sd.cells.get(key(r, c));
      t.push(cell ? cell.k : "empty");
      f.push(cell ? formatOf(wb, cell.s) : "General");
    }
    types.push(t);
    formats.push(f);
  }
  return { types, formats };
}

/** The nearest non-empty cell above `r` in column `c`: the column header (the topmost one, which is the header row of a table). */
function colHeaderAt(sd, r, c) {
  // the first cell of each column (only cells with text are kept), found once per sheet: a scan up the column per call was quadratic
  if (!sd.colFirst) {
    sd.colFirst = new Map();
    for (const cell of sd.cells.values()) {
      const f = sd.colFirst.get(cell.c);
      if (!f || cell.r < f.r) sd.colFirst.set(cell.c, cell);
    }
  }
  const f = sd.colFirst.get(c);
  return f && f.r < r ? sh(f) : "";
}

/** What surrounds a range: neighbors, the row's other cells (hashes), the row's leftmost cell, the column's header. */
function contextOf(sd, q) {
  const rowCells = [];
  let rowHeader = null;
  const row = sd.rows.get(q.r0) || [];
  for (const cell of spend(row.length) ? row : []) { // a row read from the request's budget (src/text.js scanBudget); past it the row's context is not kept
    if (cell.c >= q.c0 && cell.c <= q.c1) continue;
    if (!rowHeader && cell.c < q.c0 && cell.text) rowHeader = cell;
    if (rowCells.length >= KEEP_ROW_CELLS) continue;
    const h = chPaid(cell); // past the budget the cell is left out of what the row is remembered by
    if (h !== null) rowCells.push(h);
  }
  return {
    rowHeader: sh(rowHeader),
    colHeader: colHeaderAt(sd, q.r0, q.c0),
    left: sh(cellAt(sd, q.r0, q.c0 - 1)),
    right: sh(cellAt(sd, q.r0, q.c1 + 1)),
    up: sh(cellAt(sd, q.r0 - 1, q.c0)),
    down: sh(cellAt(sd, q.r1 + 1, q.c0)),
    rowCells: rowCells.sort(),
  };
}

/** Fraction of the remembered other cells of the row that row `r` still has (outside columns [c0,c1]). */
function rowOverlap(sd, ctx, r, c0, c1) {
  if (!ctx.rowCells.length) return 0;
  const have = new Map();
  for (const cell of sd.rows.get(r) || []) {
    if (cell.c >= c0 && cell.c <= c1) continue;
    const h = chPaid(cell);
    if (h === null) continue;
    have.set(h, (have.get(h) || 0) + 1);
  }
  let hit = 0;
  for (const h of ctx.rowCells) {
    if (have.get(h) > 0) {
      hit++;
      have.set(h, have.get(h) - 1);
    }
  }
  return hit / ctx.rowCells.length;
}
const hasRowInfo = (ctx) => ctx.rowCells.length > 0 || !!ctx.rowHeader;
const firstOutside = (sd, r, c0, c1) => (sd.rows.get(r) || []).find((x) => x.c < c0 || x.c > c1);
/**
 * row `r` looks like the remembered row: most of its other cells are there, or its leftmost cell is the same. Reading the row is spent
 * from the request's budget (src/text.js scanBudget), at a cell a unit and again for the leftmost one; past it the row does not look
 * like it (so the anchor resolves as "moved or removed"). `charge` false when the caller spent for its rows already.
 */
const sameRow = (sd, ctx, r, c0, c1, charge = true) => {
  if (charge && !spend(2 * (sd.rows.get(r)?.length || 0) + 1)) return false;
  return rowOverlap(sd, ctx, r, c0, c1) >= 0.6 || (!!ctx.rowHeader && sh(firstOutside(sd, r, c0, c1)) === ctx.rowHeader);
};

function neighborScore(sd, ctx, r, c, d) {
  const eq = (a, b) => (a !== "" && a === b ? 0.5 : 0);
  const near = (rr, cc) => (rr < 0 || cc < 0 ? "" : sh(sd.cells.get(key(rr, cc))));
  return eq(ctx.left, near(r, c - 1)) + eq(ctx.right, near(r, c + (d.c1 - d.c0) + 1)) + eq(ctx.up, near(r - 1, c)) + eq(ctx.down, near(r + (d.r1 - d.r0) + 1, c));
}

// ---- anchors --------------------------------------------------------------------------------------------------

const bookRef = (ref) => {
  const m = /^(?:'((?:[^']|'')+)'|([^!']+))!\$?([A-Z]{1,3})\$?(\d+)(?::\$?([A-Z]{1,3})\$?(\d+))?$/.exec(String(ref).trim());
  if (!m) return null;
  return { sheet: (m[1] ?? m[2]).replace(/''/g, "'"), a1: m[5] ? `${m[3]}${m[4]}:${m[5]}${m[6]}` : `${m[3]}${m[4]}` };
};
// the defined names by the cell they point at and by name, read once per workbook (an anchor looked up every name, with a regex each)
function nameIndex(wb) {
  if (wb.nameIndex) return wb.nameIndex;
  const at = new Map();
  const byName = new Map();
  for (const n of wb.names) {
    if (!byName.has(n.name)) byName.set(n.name, n);
    const b = bookRef(n.ref);
    if (!b) continue;
    const k = `${b.sheet}\u0000${b.a1}`;
    (at.get(k) || at.set(k, []).get(k)).push(n.name);
  }
  return (wb.nameIndex = { at, byName });
}
// What an anchor keeps of the names that point at its range: resolving reads them in order and takes the first that still checks out, so
// a few are enough. At most NAMES_KEEP of at most 255 characters (Excel's own limit), each paid from the budget by its length (20,000
// names of 250 characters on A1: every comment on A1 kept all of them, 5 MB each, 400 MB of session file for 80 comments).
const NAMES_KEEP = 8;
const namesAt = (wb, sheetName, full) => {
  const out = [];
  for (const nm of nameIndex(wb).at.get(`${sheetName}\u0000${full}`) || []) {
    if (out.length >= NAMES_KEEP) break;
    if (nm.length <= 255 && spend(nm.length)) out.push(nm);
  }
  return out;
};
const nameDef = (wb, nm) => nameIndex(wb).byName.get(nm);
const pickSheet = (wb, { sheetName, sheetIndex }) => wb.sheets.find((s) => s.name === sheetName) || wb.sheets[sheetIndex] || null;

/**
 * Engine location {sheetIndex, sheetName, range} -> durable anchor, from the written bytes. `range` is a cell or rectangle (the anchor
 * remembers its text, the row's other cells and the neighbors) or whole rows / columns / the sheet (position only).
 */
export function xlsxDurable(wb, loc) {
  const sheet = pickSheet(wb, loc);
  if (!sheet) return null;
  const base = { format: "xlsx", sheetId: sheet.sheetId, sheetName: sheet.name, sheetIndex: sheet.index, range: loc.range || "" };
  const q = parseA1(loc.range || "");
  if (!q) return { ...base, cell: false, text: "", textHash: null, ctx: null, names: [] };
  const sd = wb.sheetCells(sheet);
  // Within the request's budget, like resolving (src/text.js scanBudget): the identity first, so a range too large to hash whole still
  // knows its top-left cell. Past the budget the anchor still goes out, weaker: the address and what context was paid for, with a null
  // hash (the batch offers the agent full `ops` for it, never a `set` checked against a hash it does not have).
  const textHash = hashAt(sd, q.r0, q.c0); // of the top-left cell: the identity
  const got = rangeOf(sd, q);
  const full = a1Range(q);
  return {
    ...base,
    cell: true,
    r0: q.r0, c0: q.c0, r1: q.r1, c1: q.c1,
    text: got ? got.text : "", // typed text of the range, as much as the batch can show (TEXT_KEEP)
    values: got ? got.values : [],
    textHash,
    rangeHash: got ? got.hash : null,
    ctx: contextOf(sd, q),
    ...cellMeta(wb, sd, q),
    names: namesAt(wb, sheet.name, full),
  };
}

const RANK = { position: 4, value: 3, context: 2, name: 1 };

/**
 * Re-resolve against new bytes. Strategies, first hit wins (the method is reported):
 *   sheet: sheetId when it agrees with the name; else the name, then the id (the better cell match decides), else the content.
 *   position: same address, same text, same row.   value: the same text elsewhere, the context picks between equals.
 *   position (changed): same address, text changed, row and column header still agree.
 *   context: text changed and the cell moved: the row by its other cells or leftmost cell, the column by its header.
 *   name: a defined name that pointed at it.   none: "moved or removed".
 * Result: {method, sheetId, sheetName, sheetIndex, range, changed, moved, text, r0,c0,r1,c1}.
 */
export function resolveXlsx(wb, d) {
  if (!d) return { method: "none" };
  const byId = d.sheetId != null ? wb.sheets.find((s) => s.sheetId === d.sheetId) : null;
  const byName = wb.sheets.find((s) => s.name === d.sheetName) || null;
  const cands = [];
  if (byId && byName === byId) cands.push(byId);
  else {
    if (byName) cands.push(byName);
    if (byId) cands.push(byId);
  }
  if (!cands.length) return contentSearch(wb, d);
  let best = null;
  for (const s of cands) {
    const r = resolveIn(wb, s, d);
    if (r.method !== "none" && (!best || (RANK[r.method] ?? 0) > (RANK[best.method] ?? 0))) best = r;
  }
  // an id that now belongs to another sheet (a renumbering writer) and a name that is gone: look for the content everywhere
  return best || contentSearch(wb, d);
}

function resolveIn(wb, s, d) {
  if (!d.cell) return { method: "position", sheetId: s.sheetId, sheetName: s.name, sheetIndex: s.index, range: d.range, changed: false, moved: false, text: "" };
  const sd = wb.sheetCells(s);
  const ctx = d.ctx;
  const w = d.c1 - d.c0;
  const hh = d.r1 - d.r0;
  const shape = (r, c) => ({ r0: r, c0: c, r1: r + hh, c1: c + w });
  const res = (method, q) => {
    // rangeOf reads up to 2001 x 201 cells: paid before it is read, nothing of it once the budget is out. An anchor made without its
    // range hash (past the budget at Send), or a range whose hash this request did not pay for, compares the text both kept (its first
    // TEXT_KEEP characters): a difference there is a change. Ceiling: an edit past that text reads as unchanged; ordinary ranges keep
    // their hash (rangeOf). An anchor stored by an earlier version (no `values`) kept its whole text, and one whose walk was not paid
    // kept none (empty `values`): neither is compared.
    const got = rangeOf(sd, q);
    const text = got ? got.text : "";
    const changed = d.rangeHash != null && got?.hash != null ? got.hash !== d.rangeHash : !!got && d.values?.length > 0 && got.text !== d.text;
    return { method, sheetId: s.sheetId, sheetName: s.name, sheetIndex: s.index, range: a1Range(q), changed, moved: q.r0 !== d.r0 || q.c0 !== d.c0, text: text.slice(0, 200), ...q };
  };
  const noCtx = !hasRowInfo(ctx) && !ctx.left && !ctx.right && !ctx.up && !ctx.down;
  const rowOk = (r, c, charged = false) => sameRow(sd, ctx, r, c, c + w, !charged); // charged: the caller spent for these rows
  const colOk = (r, c) => !ctx.colHeader || colHeaderAt(sd, r, c) === ctx.colHeader;
  const gate = (r, c) => (hasRowInfo(ctx) ? rowOk(r, c) : noCtx || neighborScore(sd, ctx, r, c, d) >= 1);
  // an anchor made without the top-left hash (past the budget at Send) is found by its context only (steps 3 to 5); with no context
  // either, by its address, as a whole-row or whole-sheet anchor is. hashAt is null past the budget: never equal to a missing hash.
  const known = d.textHash != null;
  // 1. same address, same text, same row
  if (known && hashAt(sd, d.r0, d.c0) === d.textHash && gate(d.r0, d.c0)) return res("position", shape(d.r0, d.c0));
  // 2. the same text somewhere else; the context picks between equal values
  if (known && d.textHash !== EMPTY && spend(sd.cells.size * 8)) {
    // the scan of every cell runs within the budget of the anchors resolved together (src/text.js scanBudget)
    const hits = [];
    for (const cell of sd.cells.values()) if (chPaid(cell) === d.textHash) hits.push(cell);
    // Ceiling: scoring a hit scans its row, so when the hits' rows hold more than SAME_TEXT_WORK cells in all (a sheet of one value
    // repeated in long rows), they are not scored one by one; the steps below place the anchor by its row and column instead.
    // Upgrade path: score each row once per anchor.
    // The rows the hits sit in are spent from the request's budget too (the ceiling above is per anchor; 500 anchors of it were not bounded).
    let work = 0;
    for (const x of hits) work += sd.rows.get(x.r)?.length || 0;
    if (work > SAME_TEXT_WORK || !spend(2 * work + hits.length)) hits.length = 0;
    // one other cell with the same text only counts when the row or column header agree with it (or the anchor never had any): an edited
    // cell must not be stolen by an unrelated cell that happens to hold the old text; the in-place step below gets its chance first
    const fits = (x) => (hasRowInfo(ctx) ? rowOk(x.r, x.c, true) || (!!ctx.colHeader && colHeaderAt(sd, x.r, x.c) === ctx.colHeader) : !ctx.colHeader || colHeaderAt(sd, x.r, x.c) === ctx.colHeader);
    if (hits.length === 1 && fits(hits[0])) return res("value", shape(hits[0].r, hits[0].c));
    if (hits.length > 1) {
      // the best and the runner-up in one pass (a sort of every hit is not needed for two)
      let best = null;
      let second = -Infinity;
      for (const x of hits) {
        const score = (rowOk(x.r, x.c, true) ? 2 : 0) + (ctx.colHeader && colHeaderAt(sd, x.r, x.c) === ctx.colHeader ? 1.5 : 0) + neighborScore(sd, ctx, x.r, x.c, d);
        if (!best || score > best.score) (second = best ? best.score : -Infinity), (best = { x, score });
        else if (score > second) second = score;
      }
      if (best.score > 0 && best.score > second) return res("value", shape(best.x.r, best.x.c));
    }
  }
  // 3. edited in place: the text differs but the row and the column header still say it is the same cell
  //    (an anchor without its hash: one remembered neighbor still there is enough, as it has nothing else to go by)
  if (hasRowInfo(ctx) ? rowOk(d.r0, d.c0) && colOk(d.r0, d.c0) : (!known && noCtx) || (!noCtx && neighborScore(sd, ctx, d.r0, d.c0, d) >= (known ? 1 : 0.5))) return res("position", shape(d.r0, d.c0));
  // 4. the text changed and the cell moved: the row by its other cells, the column by its header
  if (hasRowInfo(ctx) && spend(sd.cells.size * 8)) {
    let best = null;
    let second = null;
    let count = 0;
    for (const r of sd.rows.keys()) {
      const ov = rowOverlap(sd, ctx, r, -1, -1);
      const hdr = !!ctx.rowHeader && sh(sd.rows.get(r)[0]) === ctx.rowHeader;
      if (ov >= 0.6 || hdr) {
        const hit = { r, score: ov + (hdr ? 0.5 : 0) };
        count++;
        if (!best || hit.score > best.score) (second = best), (best = hit);
        else if (!second || hit.score > second.score) second = hit;
      }
    }
    if (best && (count === 1 || best.score > second.score) && spend(sd.maxC + 1)) {
      const row = best.r;
      const cols = [];
      if (ctx.colHeader) {
        for (let c = 0; c <= sd.maxC; c++) if (colHeaderAt(sd, row, c) === ctx.colHeader) cols.push(c);
      } else cols.push(d.c0);
      if (cols.length === 1) return res("context", shape(row, cols[0]));
    }
  }
  // 5. a defined name that pointed at this range; last, because a library that does not shift names leaves them stale
  for (const nm of d.names || []) {
    const def = nameDef(wb, nm);
    const b = def ? bookRef(def.ref) : null;
    const q = b && b.sheet === s.name ? parseA1(b.a1) : null;
    // a name that moved was updated by the writer (trusted); one that still points at the old address is stale unless the cell checks out
    const verified = q && ((known && hashAt(sd, q.r0, q.c0) === d.textHash) || (hasRowInfo(ctx) ? sameRow(sd, ctx, q.r0, q.c0, q.c0 + w) : neighborScore(sd, ctx, q.r0, q.c0, d) >= 1));
    if (q && (q.r0 !== d.r0 || q.c0 !== d.c0 || verified)) return res("name", q);
  }
  return { method: "none" };
}

/** The sheet is gone (renamed and renumbered): the cell by its text and context in every sheet; only one clear winner counts. */
function contentSearch(wb, d) {
  if (!d.cell || d.textHash === EMPTY || d.textHash == null) return { method: "none" };
  const found = [];
  for (const s of wb.sheets) {
    const r = resolveIn(wb, s, d);
    if (r.method === "position" || r.method === "value") found.push(r);
  }
  return found.length === 1 ? { ...found[0], method: "value" } : { method: "none" };
}

/** Locator fields for the batch: the names the `apply` targets use. */
const RANGE_OK = /^([A-Za-z]{1,3}\d{1,7}(:[A-Za-z]{1,3}\d{1,7})?|\d{1,7}:\d{1,7}|[A-Za-z]{1,3}:[A-Za-z]{1,3})$/;
export const xlsxLocator = (d) =>
  d
    ? {
        sheet: untrusted(d.sheetName, 100), // a sheet name is document text: control and bidi characters out, capped (Excel allows 31)
        sheet_id: /^\d{1,10}$/.test(String(d.sheetId ?? "")) ? String(d.sheetId) : null,
        range: RANGE_OK.test(d.range || "") ? d.range : null, // only the shapes the host speaks; anything else is a whole-sheet anchor
        text_hash: d.textHash ?? null,
      }
    : null;

/** Rows of a sheet for the changed-region diff: [{r, cells:[{c,text}]}] in order. */
export function sheetRows(wb, s) {
  const sd = wb.sheetCells(s);
  return [...sd.rows.keys()].sort((a, b) => a - b).map((r) => ({ r, cells: sd.rows.get(r) }));
}
