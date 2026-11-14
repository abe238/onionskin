import { colLetters, parseA1 } from "./ops/common.js";
import { untrusted } from "./sanitize.js";
import { exactHash, normText } from "./text.js";
import { walkXml } from "./xml.js";
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
const MAX_CELLS = 1_500_000;
const KEEP_ROW_CELLS = 64;

const relTarget = (base, target) => {
  if (target.startsWith("/")) return target.slice(1);
  const parts = base.split("/").slice(0, -1);
  for (const seg of target.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== ".") parts.push(seg);
  }
  return parts.join("/");
};

export function readRels(zip, part) {
  const dir = part.split("/").slice(0, -1).join("/");
  const rels = new Map();
  const xml = zip.readText(`${dir ? `${dir}/` : ""}_rels/${part.split("/").pop()}.rels`);
  if (xml == null) return rels;
  walkXml(xml, {
    onOpen(name, a) {
      if (local(name) === "Relationship" && a.Id && a.Target) rels.set(a.Id, relTarget(part, a.Target));
    },
  });
  return rels;
}
export { attrOf, local };

/** workbook.xml: sheets in order with sheetId, name, part path; defined names. Sheet cells are read lazily (`sheetCells`). */
export function parseWorkbook(bytes) {
  const zip = openZip(bytes);
  const xml = zip.readText("xl/workbook.xml");
  if (xml == null) throw new Error("xl/workbook.xml missing");
  const rels = readRels(zip, "xl/workbook.xml");
  const sheets = [];
  const names = [];
  let curName = null;
  walkXml(xml, {
    onOpen(n, a) {
      const l = local(n);
      if (l === "sheet") sheets.push({ index: sheets.length, name: a.name ?? "", sheetId: a.sheetId ?? null, hidden: a.state === "hidden" || a.state === "veryHidden", part: rels.get(attrOf(a, "id")) || null });
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
  });
  let sst = null;
  const sharedStrings = () => {
    if (sst) return sst;
    sst = [];
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
          sst.push(cur ?? "");
          cur = null;
        }
      },
    });
    return sst;
  };
  const cache = new Map();
  const sheetCells = (s) => {
    if (!cache.has(s.index)) cache.set(s.index, readSheet(zip, s, sharedStrings));
    return cache.get(s.index);
  };
  // number formats: the style index of a cell -> its format code (xl/styles.xml cellXfs + numFmts, with the built-in ids)
  let fmts = null;
  const numberFormat = (styleIdx) => {
    if (!fmts) {
      fmts = { custom: new Map(), xf: [] };
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
        });
    }
    const id = fmts.xf[styleIdx] ?? 0;
    return fmts.custom.get(id) ?? BUILTIN_FORMATS[id] ?? (id ? `format ${id}` : "General");
  };
  return { sheets, names, sheetCells, numberFormat };
}

const BUILTIN_FORMATS = { 0: "General", 1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00", 9: "0%", 10: "0.00%", 11: "0.00E+00", 12: "# ?/?", 13: "# ??/??", 14: "mm-dd-yy", 15: "d-mmm-yy", 16: "d-mmm", 17: "mmm-yy", 18: "h:mm AM/PM", 19: "h:mm:ss AM/PM", 20: "h:mm", 21: "h:mm:ss", 22: "m/d/yy h:mm", 37: "#,##0 ;(#,##0)", 38: "#,##0 ;[Red](#,##0)", 39: "#,##0.00;(#,##0.00)", 40: "#,##0.00;[Red](#,##0.00)", 45: "mm:ss", 46: "[h]:mm:ss", 47: "mmss.0", 48: "##0.0E+0", 49: "@" };

const key = (r, c) => r * 16384 + c;

/** {cells: Map(r*16384+c -> {r,c,text}), rows: Map(r -> cells sorted by column), maxR, maxC, truncated, merges: [{r0,c0,r1,c1}]}. Empty cells are not kept. */
function readSheet(zip, sheet, sharedStrings) {
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
        const q = parseA1(a.ref ?? "");
        if (q && (q.r1 > q.r0 || q.c1 > q.c0)) out.merges.push(q);
      } else if (l === "c" && a.r) {
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
        if (cells.size >= MAX_CELLS) out.truncated = true;
        else {
          let text;
          if (cur.f) text = `=${cur.f}`;
          else if (cur.t === "s") text = sharedStrings()[Number(cur.v)] ?? "";
          else if (cur.t === "inlineStr") text = cur.is;
          else if (cur.t === "b") text = cur.v === "1" ? "TRUE" : "FALSE";
          else if (cur.t === "n" && NUM.test(cur.v)) text = String(Number(cur.v));
          else text = cur.v;
          if (text !== "" && cur.c < 16384) {
            const cell = { r: cur.r, c: cur.c, text, k: cur.f ? "formula" : cur.t === "s" || cur.t === "inlineStr" || cur.t === "str" ? "text" : cur.t === "b" ? "boolean" : cur.t === "e" ? "error" : "number", s: cur.s, ...(cur.f ? { cached: cur.v } : cur.f === "" ? { shared: true } : {}) }; // `cached`: the value a formula last computed (History shows it next to the formula)
            cells.set(key(cur.r, cur.c), cell);
            if (!rows.has(cur.r)) rows.set(cur.r, []);
            rows.get(cur.r).push(cell);
            if (cur.r > out.maxR) out.maxR = cur.r;
            if (cur.c > out.maxC) out.maxC = cur.c;
          }
        }
        cur = null;
      }
    },
  });
  for (const list of rows.values()) list.sort((a, b) => a.c - b.c);
  return out;
}

// ---- ranges and context ---------------------------------------------------------------------------------------

export const a1 = (r, c) => `${colLetters(c)}${r + 1}`;
export const a1Range = (q) => (q.r0 === q.r1 && q.c0 === q.c1 ? a1(q.r0, q.c0) : `${a1(q.r0, q.c0)}:${a1(q.r1, q.c1)}`);
const at = (sd, r, c) => (r < 0 || c < 0 ? "" : sd.cells.get(key(r, c))?.text ?? "");

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
      f.push(cell ? wb.numberFormat(cell.s) : "General");
    }
    types.push(t);
    formats.push(f);
  }
  return { types, formats };
}

/** The nearest non-empty cell above `r` in column `c`: the column header (the topmost one, which is the header row of a table). */
function colHeaderAt(sd, r, c) {
  for (let i = 0; i < r; i++) {
    const t = at(sd, i, c);
    if (t !== "") return short(t);
  }
  return "";
}

/** What surrounds a range: neighbors, the row's other cells (hashes), the row's leftmost cell, the column's header. */
function contextOf(sd, q) {
  const rowCells = [];
  let rowHeader = "";
  for (const cell of sd.rows.get(q.r0) || []) {
    if (cell.c >= q.c0 && cell.c <= q.c1) continue;
    if (!rowHeader && cell.c < q.c0) rowHeader = cell.text;
    if (rowCells.length < KEEP_ROW_CELLS) rowCells.push(ch(cell));
  }
  return {
    rowHeader: short(rowHeader),
    colHeader: colHeaderAt(sd, q.r0, q.c0),
    left: short(at(sd, q.r0, q.c0 - 1)),
    right: short(at(sd, q.r0, q.c1 + 1)),
    up: short(at(sd, q.r0 - 1, q.c0)),
    down: short(at(sd, q.r1 + 1, q.c0)),
    rowCells: rowCells.sort(),
  };
}

/** Fraction of the remembered other cells of the row that row `r` still has (outside columns [c0,c1]). */
function rowOverlap(sd, ctx, r, c0, c1) {
  if (!ctx.rowCells.length) return 0;
  const have = new Map();
  for (const cell of sd.rows.get(r) || []) {
    if (cell.c >= c0 && cell.c <= c1) continue;
    const h = ch(cell);
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
/** row `r` looks like the remembered row: most of its other cells are there, or its leftmost cell is the same */
const sameRow = (sd, ctx, r, c0, c1) => rowOverlap(sd, ctx, r, c0, c1) >= 0.6 || (!!ctx.rowHeader && short(firstOutside(sd, r, c0, c1)?.text) === ctx.rowHeader);

function neighborScore(sd, ctx, r, c, d) {
  const eq = (a, b) => (a !== "" && a === b ? 0.5 : 0);
  return eq(ctx.left, short(at(sd, r, c - 1))) + eq(ctx.right, short(at(sd, r, c + (d.c1 - d.c0) + 1))) + eq(ctx.up, short(at(sd, r - 1, c))) + eq(ctx.down, short(at(sd, r + (d.r1 - d.r0) + 1, c)));
}

// ---- anchors --------------------------------------------------------------------------------------------------

const bookRef = (ref) => {
  const m = /^(?:'((?:[^']|'')+)'|([^!']+))!\$?([A-Z]{1,3})\$?(\d+)(?::\$?([A-Z]{1,3})\$?(\d+))?$/.exec(String(ref).trim());
  if (!m) return null;
  return { sheet: (m[1] ?? m[2]).replace(/''/g, "'"), a1: m[5] ? `${m[3]}${m[4]}:${m[5]}${m[6]}` : `${m[3]}${m[4]}` };
};
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
  const text = rangeText(sd, q);
  const full = a1Range(q);
  return {
    ...base,
    cell: true,
    r0: q.r0, c0: q.c0, r1: q.r1, c1: q.c1,
    text, // typed text of the whole range
    textHash: exactHash(at(sd, q.r0, q.c0)), // of the top-left cell: the identity
    rangeHash: exactHash(text),
    ctx: contextOf(sd, q),
    ...cellMeta(wb, sd, q),
    names: wb.names.filter((n) => { const b = bookRef(n.ref); return b && b.sheet === sheet.name && b.a1 === full; }).map((n) => n.name),
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
    const text = rangeText(sd, q);
    return { method, sheetId: s.sheetId, sheetName: s.name, sheetIndex: s.index, range: a1Range(q), changed: exactHash(text) !== d.rangeHash, moved: q.r0 !== d.r0 || q.c0 !== d.c0, text: text.slice(0, 200), ...q };
  };
  const noCtx = !hasRowInfo(ctx) && !ctx.left && !ctx.right && !ctx.up && !ctx.down;
  const rowOk = (r, c) => sameRow(sd, ctx, r, c, c + w);
  const colOk = (r, c) => !ctx.colHeader || colHeaderAt(sd, r, c) === ctx.colHeader;
  const gate = (r, c) => (hasRowInfo(ctx) ? rowOk(r, c) : noCtx || neighborScore(sd, ctx, r, c, d) >= 1);
  // 1. same address, same text, same row
  if (exactHash(at(sd, d.r0, d.c0)) === d.textHash && gate(d.r0, d.c0)) return res("position", shape(d.r0, d.c0));
  // 2. the same text somewhere else; the context picks between equal values
  if (d.textHash !== EMPTY) {
    const hits = [];
    for (const cell of sd.cells.values()) if (ch(cell) === d.textHash) hits.push(cell);
    // one other cell with the same text only counts when the row or column header agree with it (or the anchor never had any): an edited
    // cell must not be stolen by an unrelated cell that happens to hold the old text; the in-place step below gets its chance first
    const fits = (x) => (hasRowInfo(ctx) ? rowOk(x.r, x.c) || (!!ctx.colHeader && colHeaderAt(sd, x.r, x.c) === ctx.colHeader) : !ctx.colHeader || colHeaderAt(sd, x.r, x.c) === ctx.colHeader);
    if (hits.length === 1 && fits(hits[0])) return res("value", shape(hits[0].r, hits[0].c));
    if (hits.length > 1) {
      const scored = hits
        .map((x) => ({ x, score: (rowOk(x.r, x.c) ? 2 : 0) + (ctx.colHeader && colHeaderAt(sd, x.r, x.c) === ctx.colHeader ? 1.5 : 0) + neighborScore(sd, ctx, x.r, x.c, d) }))
        .sort((a, b) => b.score - a.score);
      if (scored[0].score > 0 && scored[0].score > scored[1].score) return res("value", shape(scored[0].x.r, scored[0].x.c));
    }
  }
  // 3. edited in place: the text differs but the row and the column header still say it is the same cell
  if (hasRowInfo(ctx) ? rowOk(d.r0, d.c0) && colOk(d.r0, d.c0) : !noCtx && neighborScore(sd, ctx, d.r0, d.c0, d) >= 1) return res("position", shape(d.r0, d.c0));
  // 4. the text changed and the cell moved: the row by its other cells, the column by its header
  if (hasRowInfo(ctx)) {
    const rowsHit = [];
    for (const r of sd.rows.keys()) {
      const ov = rowOverlap(sd, ctx, r, -1, -1);
      const hdr = !!ctx.rowHeader && short(sd.rows.get(r)[0]?.text) === ctx.rowHeader;
      if (ov >= 0.6 || hdr) rowsHit.push({ r, score: ov + (hdr ? 0.5 : 0) });
    }
    rowsHit.sort((a, b) => b.score - a.score);
    if (rowsHit.length && (rowsHit.length === 1 || rowsHit[0].score > rowsHit[1].score)) {
      const row = rowsHit[0].r;
      const cols = [];
      if (ctx.colHeader) {
        for (let c = 0; c <= sd.maxC; c++) if (colHeaderAt(sd, row, c) === ctx.colHeader) cols.push(c);
      } else cols.push(d.c0);
      if (cols.length === 1) return res("context", shape(row, cols[0]));
    }
  }
  // 5. a defined name that pointed at this range; last, because a library that does not shift names leaves them stale
  for (const nm of d.names || []) {
    const def = wb.names.find((n) => n.name === nm);
    const b = def ? bookRef(def.ref) : null;
    const q = b && b.sheet === s.name ? parseA1(b.a1) : null;
    // a name that moved was updated by the writer (trusted); one that still points at the old address is stale unless the cell checks out
    const verified = q && (exactHash(at(sd, q.r0, q.c0)) === d.textHash || (hasRowInfo(ctx) ? sameRow(sd, ctx, q.r0, q.c0, q.c0 + w) : neighborScore(sd, ctx, q.r0, q.c0, d) >= 1));
    if (q && (q.r0 !== d.r0 || q.c0 !== d.c0 || verified)) return res("name", q);
  }
  return { method: "none" };
}

/** The sheet is gone (renamed and renumbered): the cell by its text and context in every sheet; only one clear winner counts. */
function contentSearch(wb, d) {
  if (!d.cell || d.textHash === EMPTY) return { method: "none" };
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
