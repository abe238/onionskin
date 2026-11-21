import { checkExpect, colIndex, colLetters, engineFailure, fail, parseA1, refused } from "./common.js";
import { openEngine } from "./engine.js";
import { countMatches, findRanges } from "./runs.js";
import { a1Range, parseWorkbook } from "../xlsx.js";
import { openZip } from "../zip.js";
import { walkXml } from "../xml.js";

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

// Give equal decimal spellings the same signed coefficient and power of ten.
function normalizedDecimal(text) {
  const [mantissa, exponent = "0"] = text.split(/e/i);
  const [whole, fraction = ""] = mantissa.replace(/^[-+]/, "").split(".");
  const digits = (whole + fraction).replace(/^0+/, "");
  if (!digits) return "0";
  const coefficient = digits.replace(/0+$/, "");
  const power = BigInt(exponent) - BigInt(fraction.length) + BigInt(digits.length - coefficient.length);
  return `${mantissa.startsWith("-") ? "-" : ""}${coefficient}e${power}`;
}

// The numeric and percent patterns mirror parseInput in vendor/engine-node/engine-node.mjs.
export function numberWriteRefusal(value, r, c) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  const match = /^[-+]?(\d+\.?\d*|\.\d+)(?:e[-+]?\d+|%)?$/i.exec(text);
  if (!match) return null;
  const percent = text.endsWith("%");
  const body = percent ? text.slice(0, -1) : text;
  const number = Number(body);
  let reason;
  if (/^0\d/.test(match[1])) reason = "leading zeros are not kept in this version";
  else if (!Number.isFinite(number) || normalizedDecimal(body) !== normalizedDecimal(String(number))) reason = "the number cannot be stored exactly";
  else return null;
  return refused("number_would_change", `${colLetters(c)}${r + 1} would be saved as the number ${percent ? number / 100 : number} instead of the text ${JSON.stringify(value)}: ${reason}`);
}

const STRUCTURAL = new Set(["insert_rows", "delete_rows", "insert_columns", "delete_columns"]);

// Mirror the two dateSerial2 patterns in vendor/engine-node/engine-node.mjs.
function invalidDatePart(value) {
  const text = value.trim();
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
  const m = iso ?? /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?: (\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
  if (!m) return null;
  const month = Number(m[2]), day = Number(m[iso ? 3 : 1]), year = Number(m[iso ? 1 : 3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  if (month < 1 || month > 12 || day < 1 || day > [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]) return "day";
  return Number(m[4]) > 23 || Number(m[5]) > 59 || Number(m[6]) > 59 ? "time" : null;
}

async function setCells(st, sh, cells) {
  await st.h.engine.call("xlsx.set", [sh, cells]);
  // The live format decides whether the engine parses a date. Discard this in-memory edit if it converted an impossible date or time.
  for (const { r, c, input } of cells) {
    const invalid = invalidDatePart(input);
    if (invalid && await cellText(st, sh, r, c) !== input)
      return { ...refused("invalid_date", `${colLetters(c)}${r + 1} has a date format and ${JSON.stringify(input)} names a ${invalid} that does not exist`), dirty: true };
  }
  return null;
}

function addressRefusal(st, sh) {
  const sheet = st.sheets[sh];
  if (sheet.implicitCells === undefined) {
    const xml = (st.zip ??= openZip(st.bytes)).readText(sheet.path);
    if (xml == null) return refused("sheet_unreadable", "the worksheet could not be checked for cell addresses");
    let implicit = false;
    const stack = [];
    walkXml(xml, {
      onOpen(name, attrs) {
        const tag = name.slice(name.indexOf(":") + 1);
        if (tag === "c" && stack.at(-1) === "row" && stack.at(-2) === "sheetData" && !attrs.r) implicit = true;
        stack.push(tag);
      },
      onClose() { stack.pop(); },
    });
    sheet.implicitCells = implicit;
  }
  return sheet.implicitCells ? refused("cells_without_address", `sheet "${sheet.name}" stores cells without their addresses. Edits to it are not supported in this version.`) : null;
}

/** Phase 1 (before any op ran): sheet and range exist, `expect` holds. Async because it reads cells through the engine. */
export async function bind(st, op) {
  const b = bindShape(st, op);
  if (!b.ok) return b;
  // Moving addresses or renaming a sheet can also rewrite formulas on other sheets.
  const sheets = STRUCTURAL.has(op.op) || op.op === "rename_sheet" ? st.sheets.keys() : b.sh === undefined ? [] : [b.sh];
  for (const sh of sheets) {
    const bad = addressRefusal(st, sh);
    if (bad) return bad;
  }
  // Addresses and `expect` are about the file as it is now. After rows or columns moved they would mean something else.
  if (b.sh !== undefined && st.shifted?.has(b.sh)) return refused("after_structural_edit", "an earlier op of this file inserted or deleted rows/columns on this sheet; send this op in a separate apply call");
  if (op.op === "replace_all_text" && st.shifted?.size > 0) return refused("after_structural_edit", "an earlier op of this file inserted or deleted rows/columns on a sheet; send this op in a separate apply call");
  const bad = await checkRegion(st, b);
  if (bad) return bad;
  if (STRUCTURAL.has(op.op)) (st.shifted ??= new Set()).add(b.sh);
  if (op.op === "replace_all_text") {
    const hits = await allMatches(st, op);
    for (const sh of new Set(hits.map((x) => x.sh))) {
      const bad = addressRefusal(st, sh);
      if (bad) return bad;
    }
    const total = hits.reduce((n, x) => n + x.n, 0);
    // The read-only preview binds with count zero. At execution an earlier op may have changed the cell text.
    if (op.expect.count === 0) {
      for (const x of hits) {
        const cell = replacementCell(x, x.t, op);
        if (cell.code) return cell;
      }
    }
    // `t` is the formula when a cell has one, so a hit whose text starts with "=" would rewrite a formula
    const extra = { partial_words: hits.reduce((n, x) => n + x.partial, 0), in_formulas: hits.reduce((n, x) => n + (x.t.startsWith("=") ? x.n : 0), 0) };
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
        const written = flat.flatMap((row, i) => row.map((v, j) => ({ r: rect.r0 + i, c: rect.c0 + j, v }))).filter((x) => input(x.v) !== ""); // once, not per range
        for (const m of mergesOf(st, target.sheet)) {
          if (m.r1 < rect.r0 || m.r0 > rect.r1 || m.c1 < rect.c0 || m.c0 > rect.c1) continue; // a range outside the write: nothing of it is hit
          const hit = written.find((x) => x.r >= m.r0 && x.r <= m.r1 && x.c >= m.c0 && x.c <= m.c1 && !(x.r === m.r0 && x.c === m.c0));
          if (hit) return refused("merged_cell", `${colLetters(hit.c)}${hit.r + 1} is inside the merged range ${a1Range(m)}, which shows only its top-left cell ${colLetters(m.c0)}${m.r0 + 1}: write there, or pick a cell outside the range`);
        }
        for (const { v, r, c } of written) {
          const bad = numberWriteRefusal(v, r, c);
          if (bad) return bad;
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
          const { n, partial } = countMatches(t, op.find, op.match_case !== false);
          if (n) out.push({ sh, r: row.r, c: c[0], n, partial, t });
        }
    }
  }
  return out;
}

function replacementCell(x, text, op) {
  const ranges = findRanges(text, op.find, op.match_case !== false);
  if (ranges.length !== x.n) return { ...refused("incomplete_replace", `cell ${colLetters(x.c)}${x.r + 1} changed before replace_all_text ran`), dirty: true };
  let next = "";
  let cur = 0;
  for (const { start, end } of ranges) (next += text.slice(cur, start) + op.replace), (cur = end);
  next += text.slice(cur);
  return numberWriteRefusal(next, x.r, x.c) ?? { sh: x.sh, r: x.r, c: x.c, input: next };
}

export async function exec(st, b) {
  const { op } = b;
  try {
    if (b.sh !== undefined) await load(st, b.sh);
    if (op.op === "replace_all_text") {
      const total = b.hits.reduce((n, x) => n + x.n, 0);
      const byFormula = [];
      for (const x of b.hits) {
        const live = await cellText(st, x.sh, x.r, x.c);
        const cell = replacementCell(x, live, op);
        if (cell.code) return cell;
        byFormula.push(cell);
      }
      for (const sh of new Set(byFormula.map((x) => x.sh))) {
        const bad = await setCells(st, sh, byFormula.filter((x) => x.sh === sh));
        if (bad) return bad;
      }
      if (byFormula.length !== b.hits.length) return { ...refused("incomplete_replace", "not every matching cell was rewritten"), dirty: true };
      return { status: "applied", detail: { replaced: total, cells: byFormula.length } };
    }
    switch (op.op) {
      case "set_cells": {
        const flat = Array.isArray(op.values) ? op.values : [[op.values]];
        const cells = [];
        flat.forEach((row, i) => row.forEach((v, j) => cells.push({ r: b.rect.r0 + i, c: b.rect.c0 + j, input: input(v) })));
        const bad = await setCells(st, b.sh, cells);
        if (bad) return bad;
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
