import { attr, elements, escAttr, escText, parse, serialize } from "../xml-tree.js";

// Row and column edits of a DOCX table, done on word/document.xml with the lossless element tree (src/xml-tree.js): every byte outside the
// rows and cells an op adds or removes stays as the writer left it. The DOCX driver (src/ops/docx.js) checks the ops at bind and runs them
// on the engine's saved bytes, so the engine's own paragraph edits come first and these structural edits last.
//
// One `TableEdit` per table holds the rows and columns of the table as the file had them, so every op of one ops file addresses the table
// as delivered: a row inserted after row 2 by an earlier op does not move row 3. Rows inserted at the same place keep the order of the
// ops. A table is located by its order among top-level tables (`tableNo`, 1-based, as src/docx.js counts it), which paragraph edits
// cannot change, and rows and cells must be direct children (rows or cells wrapped in a content control are refused).
//
// Merged cells: a vertical merge (vMerge) is refused where a new row would split it or a deleted row is its first row; column ops are
// refused for any table with horizontal merges or offsets (gridSpan > 1, hMerge, gridBefore, gridAfter), where a column is not one
// cell per row.

export class TableError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const no = (code, message) => {
  throw new TableError(code, message);
};

const kidsNamed = (el, name) => elements(el).filter((k) => k.name === name);
const kidNamed = (el, name) => elements(el).find((k) => k.name === name);
const clone = (node) => parse(serialize(node)).kids[0];
const valOf = (el, name) => {
  const k = el && kidNamed(el, name);
  return k ? (attr(k, "w:val") ?? "") : null;
};
/** removes the named direct children (whitespace stays; it is insignificant between these elements) */
const dropKids = (el, names) => el && (el.kids = el.kids.filter((k) => !(k.t === "el" && names.includes(k.name))));
/** the open tag without the named attributes */
const withoutAttrs = (open, names) => names.reduce((o, n) => o.replace(new RegExp(`\\s${n.replace(/[.:]/g, "\\$&")}\\s*=\\s*("[^"]*"|'[^']*')`, "g"), ""), open);
function setAttr(el, name, value) {
  const has = attr(el, name) !== undefined;
  if (has) el.open = el.open.replace(new RegExp(`(\\s${name.replace(/[.:]/g, "\\$&")}\\s*=\\s*)("[^"]*"|'[^']*')`), `$1"${escAttr(value)}"`);
  else el.open = el.open.replace(/(\s*\/?>)$/, ` ${name}="${escAttr(value)}"$1`);
}
function insertAt(parent, index, node) {
  node.parent = parent;
  parent.kids.splice(index, 0, node);
}

/** Top-level tables of the body in document order: what src/docx.js numbers 1, 2, 3 (a table with no table above it, anywhere in w:body). */
export function topTables(root) {
  const out = [];
  const walk = (el, inBody) => {
    for (const k of elements(el)) {
      if (k.name === "w:tbl" && inBody) out.push(k);
      else walk(k, inBody || k.name === "w:body");
    }
  };
  walk(root, false);
  return out;
}

/** A row's cells with their grid columns: [{tc, start, span, vMerge: null|"restart"|"continue", hMerge}], plus gridBefore/gridAfter. */
export function rowGrid(tr) {
  const trPr = kidNamed(tr, "w:trPr");
  const before = Number(valOf(trPr, "w:gridBefore") || 0);
  const after = Number(valOf(trPr, "w:gridAfter") || 0);
  let g = before;
  const cells = kidsNamed(tr, "w:tc").map((tc) => {
    const pr = kidNamed(tc, "w:tcPr");
    const span = Math.max(1, Number(valOf(pr, "w:gridSpan") || 1));
    const vm = pr && kidNamed(pr, "w:vMerge");
    const cell = { tc, start: g, span, vMerge: vm ? (attr(vm, "w:val") === "restart" ? "restart" : "continue") : null, hMerge: !!(pr && kidNamed(pr, "w:hMerge")) };
    g += span;
    return cell;
  });
  return { cells, before, after };
}

const XML_BAD = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/; // not allowed in XML 1.0
/** One run's content: TAB and LF become w:tab and w:br, like the editor writes them. */
function runContent(text) {
  return text
    .split(/(\t|\n)/)
    .filter((s) => s !== "")
    .map((s) => (s === "\t" ? "<w:tab/>" : s === "\n" ? "<w:br/>" : `<w:t xml:space="preserve">${escText(s)}</w:t>`))
    .join("");
}
const RANGE_MARK = /^w:(commentRange|bookmark|moveFromRange|moveToRange|perm|customXml\w*Range)(Start|End)$/;

/**
 * A fresh cell built from `tc` (the neighbor): its cell properties without the vertical merge and tracked-change records, one paragraph
 * with the neighbor's first paragraph properties and its first text run's properties, holding `text` (or empty). Nothing of the
 * neighbor's content is copied, so no paragraph id, bookmark, comment or field is duplicated.
 */
function freshCell(tc, text) {
  const pr = kidNamed(tc, "w:tcPr");
  let tcPr = "";
  if (pr) {
    const c = clone(pr);
    dropKids(c, ["w:vMerge", "w:cellIns", "w:cellDel", "w:cellMerge", "w:tcPrChange", "w:cnfStyle"]);
    tcPr = serialize(c);
  }
  const p = kidNamed(tc, "w:p");
  let pPr = "";
  let rPr = "";
  if (p) {
    const pp = kidNamed(p, "w:pPr");
    if (pp) {
      const c = clone(pp);
      dropKids(c, ["w:pPrChange", "w:sectPr", "w:cnfStyle"]);
      dropKids(kidNamed(c, "w:rPr"), ["w:ins", "w:del", "w:moveFrom", "w:moveTo", "w:rPrChange"]);
      pPr = serialize(c);
    }
    const run = findRun(p);
    const rp = run && kidNamed(run, "w:rPr");
    if (rp) {
      const c = clone(rp);
      dropKids(c, ["w:rPrChange"]);
      rPr = serialize(c);
    }
  }
  const body = text ? `<w:r>${rPr}${runContent(text)}</w:r>` : "";
  return parse(`<w:tc>${tcPr}<w:p>${pPr}${body}</w:p></w:tc>`).kids[0];
}
/** the first run of a paragraph that holds text (outside deleted text), else its first run */
function findRun(p) {
  let firstRun = null;
  let withText = null;
  const walk = (el) => {
    for (const k of elements(el)) {
      if (withText) return;
      if (k.name === "w:del" || k.name === "w:pPr") continue;
      if (k.name === "w:r") {
        firstRun ??= k;
        if (kidNamed(k, "w:t")) withText = k;
      } else walk(k);
    }
  };
  walk(p);
  return withText || firstRun;
}

const TWIPS = (s) => (/^\d+$/.test(s ?? "") ? Number(s) : null);

/** The edits of one table in one ops file. Throws TableError for what it refuses; never leaves the table half changed. */
export class TableEdit {
  constructor(tbl) {
    if (elements(tbl).some((k) => k.name === "w:sdt" || k.name === "w:customXml")) no("table_wrapped_rows", "the table has rows inside a content control; rows cannot be added or removed here");
    if (tbl.parent && ancestorNamed(tbl, "w:p")) no("table_in_text_box", "the table is inside a text box");
    this.tbl = tbl;
    this.orig = kidsNamed(tbl, "w:tr");
    for (const tr of this.orig) if (elements(tr).some((k) => k.name === "w:sdt" || k.name === "w:customXml")) no("table_wrapped_rows", "a row has cells inside a content control; it cannot be edited here");
    const grid = kidNamed(tbl, "w:tblGrid");
    this.cols = grid ? kidsNamed(grid, "w:gridCol").length : 0;
    this.colMap = Array.from({ length: this.cols }, (_, i) => i); // original column -> current grid column, -1 once deleted
    this.afterCols = new Map();
  }

  rows() {
    return kidsNamed(this.tbl, "w:tr");
  }

  #row(r) {
    const tr = this.orig[r];
    if (!tr) no("no_such_row", `the table has no row ${r} (rows are 0-based; it has ${this.orig.length})`);
    if (tr.gone) no("row_deleted", `row ${r} was deleted by an earlier op of this file`);
    return tr;
  }

  /** Inserts a row before or after original row `r`; returns the new row's 0-based index in the table. */
  insertRow(r, where, cells = []) {
    const ref = this.#row(r);
    if (cells.some((t) => XML_BAD.test(t))) no("bad_text", "a cell text holds a control character");
    const rows = this.rows();
    const at = rows.indexOf(ref);
    let j = at;
    if (where === "after") for (j = at + 1; rows[j] && rows[j].addedAfter === r; j++);
    const below = rows[j] ?? null; // the row that will be under the new one
    if (below) for (const c of rowGrid(below).cells) if (c.vMerge === "continue") no("merged_cells", "a vertically merged cell spans the place of the new row; split the merge in Word first");
    const refCells = kidsNamed(ref, "w:tc");
    if (cells.length > refCells.length) no("too_many_cells", `the row has ${refCells.length} cell(s); ${cells.length} cell texts were given`);
    const tr = clone(ref);
    tr.open = withoutAttrs(tr.open, ["w14:paraId", "w14:textId"]);
    const trPr = kidNamed(tr, "w:trPr");
    if (trPr) {
      dropKids(trPr, ["w:ins", "w:del", "w:trPrChange", "w:cnfStyle"]);
      if (!(where === "before" && kidNamed(trPr, "w:tblHeader"))) dropKids(trPr, ["w:tblHeader"]); // a new row repeats as a header only above a header row
    }
    tr.kids = trPr ? [trPr] : [];
    for (const [i, tc] of refCells.entries()) {
      const fresh = freshCell(tc, cells[i] ?? "");
      fresh.parent = tr;
      tr.kids.push(fresh);
    }
    if (where === "after") tr.addedAfter = r;
    const kids = this.tbl.kids;
    insertAt(this.tbl, below ? kids.indexOf(below) : kids.indexOf(rows[rows.length - 1]) + 1, tr);
    return this.rows().indexOf(tr);
  }

  deleteRow(r) {
    const ref = this.#row(r);
    const rows = this.rows();
    if (rows.length === 1) no("last_row", "the table has only this row; a table needs at least one");
    if (looseMarks([ref])) no("open_range", "a comment or bookmark starts or ends in this row and goes on outside it");
    const next = rows[rows.indexOf(ref) + 1];
    if (next) {
      const starts = new Set(rowGrid(ref).cells.filter((c) => c.vMerge === "restart").map((c) => c.start));
      if (rowGrid(next).cells.some((c) => c.vMerge === "continue" && starts.has(c.start))) no("merged_cells", "this row is the first row of a vertically merged cell that goes on below; unmerge it in Word first");
    }
    this.tbl.kids.splice(this.tbl.kids.indexOf(ref), 1);
    ref.gone = true;
  }

  /** every current row is one plain cell per grid column: what a column op needs */
  #uniform() {
    if (!this.cols) no("table_without_grid", "the table has no column grid (w:tblGrid)");
    for (const tr of this.rows()) {
      const g = rowGrid(tr);
      if (g.before || g.after || g.cells.some((c) => c.span > 1 || c.hMerge) || g.cells.length !== this.cols) no("merged_cells", "the table has horizontally merged or offset cells, so a column is not one cell per row; columns cannot be added or removed here");
    }
  }

  #col(c) {
    if (c >= this.colMap.length) no("no_such_column", `the table has no column ${c} (columns are 0-based; it has ${this.colMap.length})`);
    if (this.colMap[c] < 0) no("column_deleted", `column ${c} was deleted by an earlier op of this file`);
    return this.colMap[c];
  }

  /** Inserts a column before or after original column `c`, scaling the widths so the table keeps its width; returns its 0-based index. */
  insertColumn(c, where, cells = []) {
    const cur = this.#col(c);
    this.#uniform();
    if (cells.some((t) => XML_BAD.test(t))) no("bad_text", "a cell text holds a control character");
    const rows = this.rows();
    if (cells.length > rows.length) no("too_many_cells", `the table has ${rows.length} row(s); ${cells.length} cell texts were given`);
    const pos = where === "after" ? cur + 1 + (this.afterCols.get(c) || 0) : cur;
    const grid = kidNamed(this.tbl, "w:tblGrid");
    const gridCols = kidsNamed(grid, "w:gridCol");
    const widths = gridCols.map((g) => TWIPS(attr(g, "w:w")));
    const gc = clone(gridCols[cur]);
    const kidsAt = (parent, list, i) => (i < list.length ? parent.kids.indexOf(list[i]) : parent.kids.indexOf(list[list.length - 1]) + 1);
    insertAt(grid, kidsAt(grid, gridCols, pos), gc);
    // widths: the new column is as wide as its neighbor, then every column is scaled so the sum stays what it was (the page still fits)
    let next = null;
    if (widths.every((w) => w !== null)) {
      const total = widths.reduce((a, b) => a + b, 0);
      const all = [...widths.slice(0, pos), widths[cur], ...widths.slice(pos)];
      const sum = total + widths[cur];
      if (total > 0 && sum > 0) {
        next = all.map((w) => Math.max(1, Math.round((w * total) / sum)));
        kidsNamed(grid, "w:gridCol").forEach((g, i) => setAttr(g, "w:w", String(next[i])));
      }
    }
    for (const [i, tr] of rows.entries()) {
      const tcs = kidsNamed(tr, "w:tc");
      const fresh = freshCell(tcs[cur], cells[i] ?? "");
      insertAt(tr, kidsAt(tr, tcs, pos), fresh);
      if (next) kidsNamed(tr, "w:tc").forEach((tc, k) => {
        const w = kidNamed(kidNamed(tc, "w:tcPr") ?? { kids: [] }, "w:tcW");
        if (w && (attr(w, "w:type") ?? "dxa") === "dxa" && TWIPS(attr(w, "w:w")) !== null) setAttr(w, "w:w", String(next[k]));
      });
    }
    if (where === "after") this.afterCols.set(c, (this.afterCols.get(c) || 0) + 1);
    for (let k = 0; k < this.colMap.length; k++) if (this.colMap[k] >= pos) this.colMap[k]++;
    this.cols++;
    return pos;
  }

  deleteColumn(c) {
    const cur = this.#col(c);
    this.#uniform();
    if (this.cols === 1) no("last_column", "the table has only this column; a table needs at least one");
    if (looseMarks(this.rows().map((tr) => kidsNamed(tr, "w:tc")[cur]))) no("open_range", "a comment or bookmark starts or ends in this column and goes on outside it");
    const grid = kidNamed(this.tbl, "w:tblGrid");
    const gc = kidsNamed(grid, "w:gridCol")[cur];
    grid.kids.splice(grid.kids.indexOf(gc), 1);
    for (const tr of this.rows()) {
      const tc = kidsNamed(tr, "w:tc")[cur];
      tr.kids.splice(tr.kids.indexOf(tc), 1);
    }
    this.colMap = this.colMap.map((k, i) => (i === c ? -1 : k > cur ? k - 1 : k));
    this.cols--;
  }
}

/** true when `nodes` (the rows or cells an op removes) hold one end of a comment, bookmark or other range without the other end */
function looseMarks(nodes) {
  const open = new Map();
  const walk = (el) => {
    for (const k of elements(el)) {
      const m = RANGE_MARK.exec(k.name);
      const id = m && attr(k, "w:id");
      if (id !== undefined && m) {
        const key = `${m[1]} ${id}`;
        open.set(key, (open.get(key) || 0) + (m[2] === "Start" ? 1 : -1));
      }
      walk(k);
    }
  };
  for (const n of nodes) walk({ kids: [n] });
  return [...open.values()].some((v) => v !== 0);
}

function ancestorNamed(el, name) {
  for (let p = el.parent; p; p = p.parent) if (p.name === name) return p;
  return null;
}

/**
 * The table edits of one ops file on one copy of document.xml. `run({kind, tableNo, args})` does one edit (kind: insertRow, deleteRow,
 * insertColumn, deleteColumn) and returns its result; a TableError leaves the copy as it was. `xml()` is the copy now.
 */
export function tableEditor(xml) {
  const root = parse(xml);
  const tables = topTables(root);
  const editors = new Map();
  return {
    run({ kind, tableNo, args }) {
      const tbl = tables[tableNo - 1];
      if (!tbl) no("no_such_table", `table ${tableNo} is not in the document`);
      if (!editors.has(tbl)) editors.set(tbl, new TableEdit(tbl));
      return editors.get(tbl)[kind](...args);
    },
    xml: () => serialize(root),
  };
}
