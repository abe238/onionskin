import { checkExpect, colIndex, colLetters, engineFailure, fail, parseA1, refused } from "./common.js";
import { openEngine } from "./engine.js";
import { findAll, partialWords } from "./runs.js";
import { a1Range, parseWorkbook } from "../xlsx.js";

/**
 * XLSX driver (headless Engine: xlsx.set, xlsx.format, xlsx.sheetOp, xlsx.bookOp, xlsx.replace). Cell text for `expect` is what a
 * user would see in the formula bar: the formula when the cell has one, else the stored value. The engine refuses (with a code)
 * structural edits it cannot do losslessly; that code is surfaced as the op's `code`.
 */

export async function open({ bytes, name, anchors = new Map() }) {
  const h = await openEngine(bytes, name);
  return { h, sheets: h.info.xlsx.sheets.map((s) => ({ ...s })), loaded: new Map(), name, anchors, bytes };
}

/** Merged ranges of a sheet as the file was delivered (no op merges or unmerges), read from the bytes on first use. */
function mergesOf(st, sheetName) {
  st.wb ??= parseWorkbook(st.bytes);
  const sheet = st.wb.sheets.find((s) => s.name === sheetName) ?? st.wb.sheets.find((s) => s.name.toLowerCase() === sheetName.toLowerCase());
  return sheet ? st.wb.sheetCells(sheet).merges : [];
}

/** `{sheet, range}` as written, or `{anchor_id}` resolved through the delivered batch (the locator carries exactly those two fields). */
function rangeTarget(st, target) {
  if (!("anchor_id" in target)) return { target };
  const a = st.anchors.get(target.anchor_id);
  if (!a) return { error: `anchor ${target.anchor_id} is not in the batch (pass --batch batch.json, or run inside the session that delivered it)` };
  if (!a.locator?.sheet || !a.locator?.range) return { error: `anchor ${target.anchor_id} does not name a cell or range` };
  return { target: { sheet: a.locator.sheet, range: a.locator.range } };
}

async function load(st, i) {
  if (!st.loaded.has(i)) {
    const done = st.h.waitFor((ev, d) => ev === "xlsx:progress" && d.sheet === i && d.done);
    await st.h.engine.call("xlsx.load", [i]);
    st.loaded.set(i, await done);
  }
  return st.loaded.get(i);
}

const sheetIndex = (st, name) => {
  const exact = st.sheets.findIndex((s) => s.name === name);
  if (exact >= 0) return exact;
  const ci = st.sheets.filter((s) => s.name.toLowerCase() === name.toLowerCase());
  return ci.length === 1 ? st.sheets.indexOf(ci[0]) : -1;
};

/** the text of one cell as typed ("" for an empty cell) */
async function cellText(st, sh, r, c) {
  const d = await st.h.engine.call("xlsx.cell", [sh, r, c]);
  if (!d) return "";
  return d.formula ?? (d.value == null ? "" : String(d.value));
}

/** cells of a rectangle: columns joined by TAB, rows by LF (the shape `expect` uses) */
async function regionText(st, sh, { r0, c0, r1, c1 }) {
  const rows = [];
  for (let r = r0; r <= r1; r++) {
    const cells = [];
    for (let c = c0; c <= c1; c++) cells.push(await cellText(st, sh, r, c));
    rows.push(cells.join("\t"));
  }
  return rows.join("\n");
}

/** non-empty cells' coordinates in rows [r0,r1] */
async function usedCells(st, sh, r0, r1) {
  const out = [];
  const b = await st.h.engine.call("xlsx.block", [sh, r0, r1 + 1]);
  for (const row of b.rows) for (const c of row.cells) out.push({ r: row.r, c: c[0] });
  return out;
}
/** a row as typed, from column A to its last non-empty cell */
async function rowText(st, sh, r) {
  const used = (await usedCells(st, sh, r, r)).filter((x) => x.r === r);
  const last = used.length ? Math.max(...used.map((x) => x.c)) : -1;
  return regionText(st, sh, { r0: r, c0: 0, r1: r, c1: last }).then((t) => (last < 0 ? "" : t));
}
/** a column from row 1 to its last non-empty cell, cells joined by LF */
async function colText(st, sh, c) {
  const { rows } = await load(st, sh);
  const lines = [];
  for (let r0 = 0; r0 < rows; r0 += 500) {
    const b = await st.h.engine.call("xlsx.block", [sh, r0, Math.min(rows, r0 + 500)]);
    for (const row of b.rows) if (row.cells.some((x) => x[0] === c)) lines[row.r] = await cellText(st, sh, row.r, c);
  }
  return Array.from({ length: lines.length }, (_, i) => lines[i] ?? "").join("\n");
}

const input = (v) => (v === null ? "" : typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : String(v));

const STRUCTURAL = new Set(["insert_rows", "delete_rows", "insert_columns", "delete_columns"]);

/** Phase 1 (before any op ran): sheet and range exist, `expect` holds. Async because it reads cells through the engine. */
export async function bind(st, op) {
  const b = bindShape(st, op);
  if (!b.ok) return b;
  // Addresses and `expect` are about the file as it is now. After rows or columns moved they would mean something else.
  if (b.sh !== undefined && st.shifted?.has(b.sh)) return refused("after_structural_edit", "an earlier op of this file inserted or deleted rows/columns on this sheet; send this op in a separate apply call");
  const bad = await checkRegion(st, b);
  if (bad) return bad;
  if (STRUCTURAL.has(op.op)) (st.shifted ??= new Set()).add(b.sh);
  if (op.op === "replace_all_text") {
    const hits = await allMatches(st, op);
    const total = hits.reduce((n, x) => n + x.n, 0);
    // `t` is the formula when a cell has one, so a hit whose text starts with "=" would rewrite a formula
    const extra = { partial_words: hits.reduce((n, x) => n + partialWords(x.t, op.find, op.match_case !== false), 0), in_formulas: hits.reduce((n, x) => n + (x.t.startsWith("=") ? x.n : 0), 0) };
    if (total !== op.expect.count) return fail("expect_mismatch", `found ${total} occurrence(s), expected ${op.expect.count}`, { found: total, ...extra });
    Object.assign(b, extra);
    b.hits = hits;
  }
  return b;
}

function bindShape(st, op) {
  switch (op.op) {
    case "set_cells":
    case "format_cells": {
      const rt = rangeTarget(st, op.target);
      if (rt.error) return fail("anchor_not_found", rt.error);
      const target = rt.target;
      const sh = sheetIndex(st, target.sheet);
      if (sh < 0) return fail("anchor_not_found", `no sheet named "${target.sheet}"`);
      const rect = parseA1(target.range);
      if (!rect) return fail("anchor_not_found", `bad range ${target.range}`);
      if (op.op === "set_cells") {
        const rows = rect.r1 - rect.r0 + 1;
        const cols = rect.c1 - rect.c0 + 1;
        const v = op.values;
        if (!Array.isArray(v)) {
          if (rows * cols !== 1) return refused("values_shape", `a scalar value fits one cell, ${target.range} has ${rows * cols}`);
        } else if (v.length !== rows || v.some((r) => r.length !== cols)) return refused("values_shape", `values must be ${rows} row(s) of ${cols} cell(s) to fill ${target.range}`);
      }
      if (op.op === "set_cells") {
        // a merged range shows only its top-left cell: a value in any other cell of it is hidden from the person (an empty write is harmless)
        const flat = Array.isArray(op.values) ? op.values : [[op.values]];
        for (const m of mergesOf(st, target.sheet)) {
          const hit = flat.flatMap((row, i) => row.map((v, j) => ({ r: rect.r0 + i, c: rect.c0 + j, v }))).find((x) => x.r >= m.r0 && x.r <= m.r1 && x.c >= m.c0 && x.c <= m.c1 && !(x.r === m.r0 && x.c === m.c0) && input(x.v) !== "");
          if (hit) return refused("merged_cell", `${colLetters(hit.c)}${hit.r + 1} is inside the merged range ${a1Range(m)}, which shows only its top-left cell ${colLetters(m.c0)}${m.r0 + 1}: write there, or pick a cell outside the range`);
        }
      }
      return { ok: true, op, sh, rect, phase: "region" };
    }
    case "insert_rows":
    case "delete_rows": {
      const sh = sheetIndex(st, op.target.sheet);
      if (sh < 0) return fail("anchor_not_found", `no sheet named "${op.target.sheet}"`);
      return { ok: true, op, sh, at: op.target.at - 1, n: op.target.count || 1, phase: "rows" };
    }
    case "insert_columns":
    case "delete_columns": {
      const sh = sheetIndex(st, op.target.sheet);
      if (sh < 0) return fail("anchor_not_found", `no sheet named "${op.target.sheet}"`);
      return { ok: true, op, sh, at: colIndex(op.target.at), n: op.target.count || 1, phase: "cols" };
    }
    case "add_sheet":
      if (sheetIndex(st, op.target.name) >= 0) return fail("expect_mismatch", `a sheet named "${op.target.name}" already exists`);
      return { ok: true, op, phase: "book" };
    case "rename_sheet": {
      const sh = sheetIndex(st, op.target.sheet);
      if (sh < 0) return fail("anchor_not_found", `no sheet named "${op.target.sheet}"`);
      const bad = checkExpect(op.expect, st.sheets[sh].name, "exact");
      if (bad) return bad;
      if (sheetIndex(st, op.new_name) >= 0 && st.sheets[sheetIndex(st, op.new_name)].name.toLowerCase() !== st.sheets[sh].name.toLowerCase()) return refused("sheet_name_taken", `a sheet named "${op.new_name}" already exists`);
      return { ok: true, op, sh, phase: "book" };
    }
    case "replace_all_text":
      return { ok: true, op, phase: "all" };
    default:
      return refused("unsupported_op", `${op.op} does not apply to a .xlsx`);
  }
}

/** expect, checked against the live state right before the edit */
async function checkRegion(st, b) {
  const { op } = b;
  let text;
  if (b.sh !== undefined) await load(st, b.sh);
  if (b.phase === "region") text = await regionText(st, b.sh, b.rect);
  else if (b.phase === "rows") {
    const parts = [];
    for (let r = b.at; r < b.at + (op.op === "delete_rows" ? b.n : 1); r++) parts.push(await rowText(st, b.sh, r));
    text = parts.join("\n");
  } else if (b.phase === "cols") {
    const parts = [];
    for (let c = b.at; c < b.at + (op.op === "delete_columns" ? b.n : 1); c++) parts.push(await colText(st, b.sh, c));
    text = parts.join("\n");
  } else return null;
  return checkExpect(op.expect, text, "exact");
}

async function allMatches(st, op) {
  const out = [];
  for (let sh = 0; sh < st.sheets.length; sh++) {
    const { rows } = await load(st, sh);
    for (let r0 = 0; r0 < rows; r0 += 500) {
      const b = await st.h.engine.call("xlsx.block", [sh, r0, Math.min(rows, r0 + 500)]);
      for (const row of b.rows)
        for (const c of row.cells) {
          const t = await cellText(st, sh, row.r, c[0]);
          const n = findAll(t, op.find, op.match_case !== false).length;
          if (n) out.push({ sh, r: row.r, c: c[0], n, t });
        }
    }
  }
  return out;
}

export async function exec(st, b) {
  const { op } = b;
  try {
    if (b.sh !== undefined) await load(st, b.sh);
    if (op.op === "replace_all_text") {
      const total = b.hits.reduce((n, x) => n + x.n, 0);
      const byFormula = [];
      for (const x of b.hits) {
        const needle = op.match_case !== false ? op.find : null;
        const next = needle ? x.t.split(op.find).join(op.replace) : x.t.replace(new RegExp(op.find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), () => op.replace);
        byFormula.push({ sh: x.sh, r: x.r, c: x.c, input: next });
      }
      for (const sh of new Set(byFormula.map((x) => x.sh))) await st.h.engine.call("xlsx.set", [sh, byFormula.filter((x) => x.sh === sh).map(({ r, c, input }) => ({ r, c, input }))]);
      if (byFormula.length !== b.hits.length) return { ...refused("incomplete_replace", "not every matching cell was rewritten"), dirty: true };
      return { status: "applied", detail: { replaced: total, cells: byFormula.length } };
    }
    switch (op.op) {
      case "set_cells": {
        const flat = Array.isArray(op.values) ? op.values : [[op.values]];
        const cells = [];
        flat.forEach((row, i) => row.forEach((v, j) => cells.push({ r: b.rect.r0 + i, c: b.rect.c0 + j, input: input(v) })));
        await st.h.engine.call("xlsx.set", [b.sh, cells]);
        return { status: "applied", detail: { cells: cells.length } };
      }
      case "format_cells": {
        const s = op.set;
        const patch = {};
        if ("number_format" in s) patch.numFmt = s.number_format;
        if ("bold" in s) patch.b = s.bold;
        if ("italic" in s) patch.i = s.italic;
        if ("fill" in s) patch.fill = s.fill.toLowerCase();
        if ("font_color" in s) patch.color = s.font_color.toLowerCase();
        await st.h.engine.call("xlsx.format", [b.sh, b.rect, patch]);
        return { status: "applied" };
      }
      case "insert_rows":
      case "delete_rows":
      case "insert_columns":
      case "delete_columns": {
        const kind = { insert_rows: "insertRows", delete_rows: "deleteRows", insert_columns: "insertCols", delete_columns: "deleteCols" }[op.op];
        await st.h.engine.call("xlsx.sheetOp", [b.sh, { op: kind, at: b.at, n: b.n }]);
        st.loaded.delete(b.sh); // the sheet's rows moved: later reads must not use cached sizes
        return { status: "applied" };
      }
      case "add_sheet": {
        const r = await st.h.engine.call("xlsx.bookOp", [{ op: "add", name: op.target.name, after: st.sheets.length - 1 }]);
        if (r.sheets) st.sheets = r.sheets.map((s) => ({ ...s }));
        if (sheetIndex(st, op.target.name) < 0) return { ...refused("sheet_not_added", "the engine did not add the sheet under that name"), dirty: true };
        return { status: "applied" };
      }
      case "rename_sheet": {
        const r = await st.h.engine.call("xlsx.bookOp", [{ op: "rename", index: b.sh, name: op.new_name }]);
        if (r.sheets) st.sheets = r.sheets.map((s) => ({ ...s }));
        return { status: "applied" };
      }
    }
  } catch (err) {
    return engineFailure(err);
  }
  return refused("unsupported_op", op.op);
}

export async function save(st) {
  const blob = await st.h.engine.call("save", []);
  return Buffer.from(await blob.arrayBuffer());
}

export const close = (st) => st.h.engine.dispose();
