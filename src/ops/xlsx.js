import { checkExpect, colIndex, colLetters, engineFailure, fail, parseA1, refused } from "./common.js";
import { openEngine } from "./engine.js";
import { countMatches, findRanges } from "./runs.js";
import { a1Range, cellAt, local, parseWorkbook } from "../xlsx.js";
import path from "node:path";
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

// The engine's percent pattern in parseInput (vendor/engine-node/engine-node.mjs).
const PERCENT = /^[-+]?(\d+\.?\d*|\.\d+)%$/;

// A percent string goes to the engine as the same decimal with "e-2", which its plain-number pattern accepts: the engine's own
// division by 100 rounds twice ("0.07%" would become 0.0007000000000000001), the exponent gives the nearest number to what was written.
const engineInput = (text) => (PERCENT.test(text.trim()) ? `${text.trim().slice(0, -1)}e-2` : text);

// The numeric and percent patterns mirror parseInput in vendor/engine-node/engine-node.mjs.
export function numberWriteRefusal(value, r, c) {
  if (typeof value === "number" && !Number.isFinite(value)) return refused("number_would_change", `${colLetters(c)}${r + 1} would be saved as the text "${value}": the number is too large to store`);
  if (typeof value !== "string") return null;
  const text = value.trim();
  const match = /^[-+]?(\d+\.?\d*|\.\d+)(?:e[-+]?\d+|%)?$/i.exec(text);
  if (!match) return null;
  const body = engineInput(text);
  const number = Number(body);
  let reason;
  if (/^0\d/.test(match[1])) reason = "leading zeros are not kept in this version";
  else if (!Number.isFinite(number) || normalizedDecimal(body) !== normalizedDecimal(String(number))) reason = "the number cannot be stored exactly";
  // a percent's own digits must be exact too, as before the percent went in as an exponent: "12345678901234567%" is refused
  else if (text.endsWith("%") && normalizedDecimal(text.slice(0, -1)) !== normalizedDecimal(String(Number(text.slice(0, -1))))) reason = "the number cannot be stored exactly";
  // Excel shows at most 15 significant digits, so a 16th would show rounded ("1.249999999999999%" as 1.3% in a 0.0% cell)
  else if (text.endsWith("%") && normalizedDecimal(text.slice(0, -1)).replace(/^-|e.*$/g, "").length > 15) reason = "it has more than 15 significant digits, and Excel shows only 15";
  else return null;
  return refused("number_would_change", `${colLetters(c)}${r + 1} would be saved as the number ${number} instead of the text ${JSON.stringify(value)}: ${reason}`);
}

const STRUCTURAL = new Set(["insert_rows", "delete_rows", "insert_columns", "delete_columns"]);

// Mirror the two dateSerial2 patterns in vendor/engine-node/engine-node.mjs.
const DATE_ISO = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
const DATE_DMY = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?: (\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
const looksLikeDate = (value) => DATE_ISO.test(value.trim()) || DATE_DMY.test(value.trim());

function invalidDatePart(value) {
  const text = value.trim();
  const iso = DATE_ISO.exec(text);
  const m = iso ?? DATE_DMY.exec(text);
  if (!m) return null;
  const month = Number(m[2]), day = Number(m[iso ? 3 : 1]), year = Number(m[iso ? 1 : 3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  if (month < 1 || month > 12 || day < 1 || day > [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]) return "day";
  if (Number(m[4]) > 23 || Number(m[5]) > 59 || Number(m[6]) > 59) return "time";
  // Date.UTC reads years 0 to 99 as 1900 to 1999, and Excel shows serials before 1 March 1900 one day off (its 1900 leap day).
  return year < 1900 || (year === 1900 && month < 3) ? "early" : null;
}

// A time with no date, which the engine never converts: impossible only in a date-formatted cell.
const impossibleTime = (value) => {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  return !!m && (Number(m[1]) > 23 || Number(m[2]) > 59 || Number(m[3]) > 59);
};

/** Style index -> number format code, as the engine knows them: the delivered styles, then each style an op added (`res.styles`). */
function noteStyles(st, res) {
  st.formats ??= [...(st.h.info.xlsx.formats ?? [])];
  for (const x of res?.styles ?? []) st.formats[x.index] = x.format;
}

/** The styles part the workbook links, the first one that exists (as the engine reads it), or null. */
function stylesPart(zip) {
  const relsOf = (part) => part.replace(/[^/]*$/, (n) => `_rels/${n}.rels`);
  const targets = (part, type) => {
    const out = [];
    walkXml(zip.readText(relsOf(part)) ?? "", { onOpen(name, a) { if (name.endsWith("Relationship") && a.Type?.endsWith(type) && a.TargetMode !== "External") out.push(a.Target.startsWith("/") ? a.Target.slice(1) : path.posix.normalize(path.posix.join(path.posix.dirname(part), a.Target))); } });
    return out;
  };
  const book = targets("", "/officeDocument")[0];
  return (book && targets(book, "/styles").find((p) => zip.readText(p) != null)) ?? null;
}

/** Does the delivered workbook link a styles part? Without one the engine writes xl/styles.xml with no relationship, and the saved file loses every new format. */
function stylesLinked(st) {
  if (st.stylesLinked === undefined) {
    st.stylesPart = stylesPart((st.zip ??= openZip(st.bytes)));
    st.stylesLinked = st.stylesPart != null;
  }
  return st.stylesLinked;
}

const EVERY_CELL = { r0: 0, c0: 0, r1: Infinity, c1: Infinity };

/**
 * The ranges of a sheet under a conditional format whose rule sets a number format: a rule's dxf in the styles part with a numFmt, or an
 * x14 rule (in extLst) with its own numFmt. The engine draws none of them, so a cell there may show something else in Excel. A range
 * that cannot be read counts as the whole sheet.
 */
function conditionalNumberFormats(zip, sheetPart, styles) {
  const numbered = new Set();
  let dxf = -1, inDxfs = false;
  walkXml((styles && zip.readText(styles)) ?? "", {
    onOpen(name) {
      const t = local(name);
      if (t === "dxfs") inDxfs = true;
      else if (inDxfs && t === "dxf") dxf++;
      else if (inDxfs && t === "numFmt") numbered.add(dxf);
    },
    onClose(name) { if (local(name) === "dxfs") inDxfs = false; },
  });
  const out = [];
  let cf = null, sqref = null;
  walkXml((sheetPart && zip.readText(sheetPart)) ?? "", {
    onOpen(name, a) {
      const t = local(name);
      if (t === "conditionalFormatting") cf = { refs: a.sqref ?? "", number: false };
      else if (cf && ((t === "cfRule" && a.dxfId !== undefined && numbered.has(Number(a.dxfId))) || t === "numFmt")) cf.number = true;
      else if (cf && t === "sqref") sqref = "";
    },
    onText(text) { if (sqref !== null) sqref += text; },
    onClose(name) {
      const t = local(name);
      if (t === "sqref" && cf) (cf.refs += ` ${sqref}`), (sqref = null);
      if (t === "conditionalFormatting" && cf) {
        if (cf.number) for (const ref of cf.refs.trim().split(/\s+/)) out.push(parseA1(ref.replaceAll("$", "")) ?? EVERY_CELL);
        cf = null;
      }
    },
  });
  return out;
}
/**
 * Is `code` a plain percent picture this version can vouch for? One or two sections (positive; negative), each exactly: an optional plain
 * color ([Red], or [Color1] to [Color56] with no space, the range Excel has), then "+" or "-" or an opening "(", digit placeholders (0 # ?) with commas only between them, an optional "."
 * and placeholders, one "%", the ")" that closes a "(", and an optional "_" pad at the very end. Nothing else.
 * This can only REFUSE: a write is kept only when this holds AND the display check passes. The bundled engine and desktop Excel disagree
 * on more format codes than any list names, so the engine's display alone cannot accept a format. Widen it only where a format is proved
 * to show the same in both; never let it accept on its own.
 */
const PERCENT_SECTION = /^(?:\[(?:black|red|green|blue|yellow|magenta|cyan|white|color(?:[1-9]|[1-4]\d|5[0-6]))\])?(?:[-+]?|\((?=.*\)(?:_[^"\\;])?$))[0#?]+(?:,[0#?]+)*(?:\.[0#?]+)?%(\))?(?:_[^"\\;])?$/i;
export function knownPercentFormat(code) {
  if (typeof code !== "string") return false;
  const sections = code.split(";");
  return sections.length <= 2 && sections.every((x) => {
    const m = PERCENT_SECTION.exec(x);
    return !!m && /^(?:\[[^\]]*\])?\(/.test(x) === (m[1] === ")");
  });
}

/** Cell style indexes whose xf in cellXfs says applyNumberFormat="0": Excel may then not use the format the engine draws. */
function numberFormatOff(zip, styles) {
  const off = new Set();
  let i = -1, inXfs = false;
  walkXml((styles && zip.readText(styles)) ?? "", {
    onOpen(name, a) {
      const t = local(name);
      if (t === "cellXfs") inXfs = true;
      else if (inXfs && t === "xf") {
        i++;
        if (a.applyNumberFormat === "0" || a.applyNumberFormat === "false") off.add(i);
      }
    },
    onClose(name) { if (local(name) === "cellXfs") inXfs = false; },
  });
  return off;
}

const covers = (ranges, r, c) => ranges.some((x) => r >= x.r0 && r <= x.r1 && c >= x.c0 && c <= x.c1);

/**
 * Does the grid string `shown` show the percent string `input` as written? The whole string, outer ASCII spaces trimmed, must be a plain
 * percent: a leading "-" or "+" or parentheses around it all, digits (plain, or grouped by commas in threes with no leading zero: "0,005%"
 * reads as a decimal in some locales), an optional "." and digits,
 * one "%". A negative needs "-" or parentheses, a positive no sign or "+", zero no sign. The digits must be the input rounded half away
 * from zero to the decimals shown, in exact decimal arithmetic. At an exact tie the digits one below in magnitude pass too: the stored
 * number is exact, and Onionskin's own viewer can show a tie rounded down (its binary arithmetic). A nonzero input may not show as zero.
 */
export function percentShown(input, shown) {
  const m = /^(?:([-+]?)([1-9]\d{0,2}(?:,\d{3})+|\d+)(?:\.(\d+))?%|(\()([1-9]\d{0,2}(?:,\d{3})+|\d+)(?:\.(\d+))?%\))$/.exec(shown.replace(/^ +| +$/g, ""));
  const typed = /^([-+]?)(\d*)(?:\.(\d*))?%$/.exec(input.trim());
  if (!m || !typed) return false;
  const sign = m[4] ?? m[1];
  const digits = BigInt(`${m[2] ?? m[5]}${m[3] ?? m[6] ?? ""}`.replaceAll(",", ""));
  const places = (m[3] ?? m[6] ?? "").length;
  const fraction = typed[3] ?? "";
  const value = BigInt(`${typed[2]}${fraction}` || "0");
  let fits = digits === value * 10n ** BigInt(Math.max(0, places - fraction.length));
  if (places < fraction.length) {
    const unit = 10n ** BigInt(fraction.length - places);
    const below = value / unit, twice = (value % unit) * 2n;
    fits = twice === unit ? digits === below || digits === below + 1n : digits === below + (twice > unit ? 1n : 0n);
  }
  const signOk = value === 0n ? sign === "" : typed[1] === "-" ? sign === "-" || sign === "(" : sign === "" || sign === "+";
  return signOk && !(value !== 0n && digits === 0n) && fits;
}

/** The refusal for a percent write at r,c that the cell shows as `shown` (null: not checkable), or null when it shows as written. */
function percentRefusal(input, shown, r, c, { code, formatOff = false, underFormat, saved = false }) {
  const at = `${colLetters(c)}${r + 1}`;
  const done = saved ? "Nothing was written" : "Nothing was changed";
  const uncheckable = refused("number_would_change", `${at} has a number format (${JSON.stringify(code ?? "unknown")}) that this version cannot check, so ${JSON.stringify(input)} was not written${saved ? ", in the saved file. Nothing was written" : ""}. Set a plain percent number_format such as "0%" with format_cells first, or send the number itself.`);
  if (formatOff) return uncheckable;
  if (underFormat) return refused("number_would_change", `${at} is under a conditional format that sets its own number format, so what it would show cannot be checked: ${JSON.stringify(input)} was not written. ${done}. Send the number itself, or write the percent into a cell without such a format.`);
  // what the cell would show comes first (it says the most); a display that passes still needs a format code in the known-good grammar
  if (shown == null || !percentShown(input, shown)) return refused("number_would_change", `${at} would show ${JSON.stringify((shown ?? "").replace(/^ +| +$/g, ""))}, not ${JSON.stringify(input)}${saved ? ", in the saved file" : ""}. ${done}. Set a percent number_format such as "0%" with format_cells first, or send the number itself.`);
  return knownPercentFormat(code) ? null : uncheckable;
}

const cellKey = (sh, r, c) => `${sh}:${r}:${c}`;

/** Each surviving percent write moves with the rows or columns an op inserts or deletes; one in a deleted row or column is gone. */
function movePercents(st, sh, kind, at, n) {
  if (!st.percents?.size) return;
  const axis = kind.endsWith("rows") ? "r" : "c";
  const next = new Map();
  for (const x of st.percents.values()) {
    if (x.sh === sh && x[axis] >= at) {
      if (kind.startsWith("delete") && x[axis] < at + n) continue;
      x[axis] += kind.startsWith("insert") ? n : -n;
    }
    next.set(cellKey(x.sh, x.r, x.c), x);
  }
  st.percents = next;
}

async function loadIn(h, sh) {
  const done = h.waitFor((ev, d) => ev === "xlsx:progress" && d.sheet === sh && d.done);
  await h.engine.call("xlsx.load", [sh]);
  return done;
}

/** [first row, last row] of a list of cells (a loop: a spread of many thousand arguments would overflow the stack) */
function rowSpan(list) {
  let r0 = Infinity, r1 = -Infinity;
  for (const x of list) (r0 = Math.min(r0, x.r)), (r1 = Math.max(r1, x.r));
  return [r0, r1];
}

/** Grid cells of rows [r0, r1] keyed by r * 16384 + c: one block read for the whole span. */
async function gridOf(h, sh, r0, r1) {
  const out = new Map();
  for (const row of (await h.engine.call("xlsx.block", [sh, r0, r1 + 1])).rows) for (const x of row.cells) out.set(row.r * 16384 + x[0], x);
  return out;
}

/**
 * The backstop before a batch is published: reopen the exact bytes about to be written and check each percent write that survived (at
 * its final address). Each must be stored as a plain number equal to the input divided by 100 and show as written in the reopened file.
 * Returns null, or {op, refusal} for the first that fails; the runner then publishes nothing. One engine open, one block read per sheet.
 */
export async function verifySaved(st, bytes) {
  if (!st.percents?.size) return null;
  const writes = [...st.percents.values()];
  let h;
  try {
    h = await openEngine(bytes, st.name);
    const wb = parseWorkbook(bytes);
    const zip = openZip(bytes);
    const styles = stylesPart(zip);
    for (const sh of new Set(writes.map((x) => x.sh))) {
      const mine = writes.filter((x) => x.sh === sh);
      const info = h.info.xlsx.sheets[sh];
      const sheet = info && wb.sheets.find((s) => s.part === info.path); // by part, not position: the two lists may not count the same entries
      if (!sheet || !info) return { op: mine[0].op, refusal: refused("number_would_change", `${colLetters(mine[0].c)}${mine[0].r + 1} could not be found in the saved file to check its percent. Nothing was written.`) };
      await loadIn(h, sh);
      const grid = await gridOf(h, sh, ...rowSpan(mine));
      const cells = wb.sheetCells(sheet);
      const ranges = conditionalNumberFormats(zip, info.path, styles);
      const off = numberFormatOff(zip, styles);
      for (const x of mine) {
        const stored = cellAt(cells, x.r, x.c);
        const [, shown, style] = grid.get(x.r * 16384 + x.c) ?? [];
        if (stored?.k !== "number" || normalizedDecimal(stored.text) !== normalizedDecimal(engineInput(x.input)))
          return { op: x.op, refusal: refused("number_would_change", `${colLetters(x.c)}${x.r + 1} would not hold ${JSON.stringify(x.input)} as the number ${Number(engineInput(x.input))} in the saved file (it would show ${JSON.stringify(shown ?? "")}). Nothing was written.`) };
        const bad = percentRefusal(x.input, shown, x.r, x.c, { code: h.info.xlsx.formats?.[style], formatOff: off.has(style), underFormat: covers(ranges, x.r, x.c), saved: true });
        if (bad) return { op: x.op, refusal: bad };
      }
    }
    return null;
  } catch (err) {
    const x = writes[0];
    return { op: x.op, refusal: refused("number_would_change", `the saved file could not be reopened to check the percent in ${colLetters(x.c)}${x.r + 1} (${String(err?.message || err).split("\n")[0].slice(0, 200)}). Nothing was written. Only a write that produces a percent is checked this way: send the number itself instead of a percent string.`) };
  } finally {
    h?.engine.dispose();
  }
}

async function setCells(st, sh, cells, op) {
  noteStyles(st, await st.h.engine.call("xlsx.set", [sh, cells.map((x) => ({ ...x, input: engineInput(x.input) }))]));
  // What each written cell shows and its style index: one block read over the written rows, after the write, only when needed.
  let grid;
  const cellOf = async (r, c) => (grid ??= await gridOf(st.h, sh, ...rowSpan(cells))).get(r * 16384 + c);
  const styleOf = async (r, c) => (await cellOf(r, c))?.[2];
  // The live format decides whether the engine parses a date. Discard this in-memory edit if it converted an impossible date or time.
  for (const { r, c, input } of cells) {
    const at = `${colLetters(c)}${r + 1}`;
    const invalid = invalidDatePart(input);
    if (invalid && await cellText(st, sh, r, c) !== input)
      return { ...refused("invalid_date", invalid === "early" ? `${at} has a date format and ${JSON.stringify(input)} is before 1 March 1900, the earliest date this version can store` : `${at} has a date format and ${JSON.stringify(input)} names a ${invalid} that does not exist`), dirty: true };
    // Without a linked styles part the date format the engine applied is not saved: the cell would reopen as a bare serial number.
    if (looksLikeDate(input) && !stylesLinked(st) && await cellText(st, sh, r, c) !== input)
      return { ...refused("invalid_date", `this workbook has no styles part, so ${at} could not keep its date format when saved: ${JSON.stringify(input)} would show as a plain number. Send the text, or use a workbook saved by Excel`), dirty: true };
    // The engine counts dates from 1900 whatever the workbook says, so in a 1904 workbook every date would be saved four years and a day late.
    if (st.h.info.xlsx.date1904 && looksLikeDate(input) && await cellText(st, sh, r, c) !== input)
      return { ...refused("invalid_date", `${at} has a date format, and this workbook counts dates from 1904, which this version cannot write: ${JSON.stringify(input)} would be saved as a different day`), dirty: true };
    if (PERCENT.test(input.trim())) {
      if (!stylesLinked(st)) return { ...refused("number_would_change", `this workbook has no styles part, so ${at} could not keep a percent format when saved: ${JSON.stringify(input)} would show as a plain number. Send the number itself`), dirty: true };
      // Accept only when the engine now draws the input AND the format code is a known-good percent (knownPercentFormat). The delivered sheet's conditional formats
      // still sit where they were: bind refuses a write after rows or columns moved on this sheet.
      const sheet = st.sheets[sh];
      sheet.conditionalNumberFormats ??= conditionalNumberFormats(st.zip, sheet.path, st.stylesPart);
      st.numberFormatOff ??= numberFormatOff(st.zip, st.stylesPart); // the delivered styles; one an op adds is checked in the saved bytes
      const [, shown, style] = (await cellOf(r, c)) ?? [];
      const bad = percentRefusal(input, shown, r, c, { code: st.formats[style], formatOff: st.numberFormatOff.has(style), underFormat: covers(sheet.conditionalNumberFormats, r, c) });
      if (bad) return { ...bad, dirty: true };
    }
    // An elapsed-hours format ("[h]:mm") counts hours past 23, so "36:15" is a real duration there: only minutes and seconds can be wrong.
    const elapsed = /^(\d{1,2}):([0-5]\d)(?::([0-5]\d))?$/.test(input.trim()) && /\[h+\]/i.test(st.formats[await styleOf(r, c)] ?? "");
    if (impossibleTime(input) && !elapsed) {
      // Ask the cell: a date it converts means a date format, and then "24:00" names a time that does not exist.
      await st.h.engine.call("xlsx.set", [sh, [{ r, c, input: "2000-01-01" }]]);
      const dated = await cellText(st, sh, r, c) !== "2000-01-01";
      if (dated) return { ...refused("invalid_date", `${at} has a date format and ${JSON.stringify(input)} names a time that does not exist`), dirty: true };
      await st.h.engine.call("xlsx.set", [sh, [{ r, c, input }]]);
    }
  }
  // Remember each percent that landed for the check of the saved bytes (verifySaved); a later write to the same cell replaces it.
  st.percents ??= new Map();
  for (const { r, c, input } of cells) {
    st.percents.delete(cellKey(sh, r, c));
    if (PERCENT.test(input.trim())) st.percents.set(cellKey(sh, r, c), { op, sh, r, c, input });
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
        const bad = await setCells(st, sh, byFormula.filter((x) => x.sh === sh), op);
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
        const bad = await setCells(st, b.sh, cells, op);
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
        noteStyles(st, await st.h.engine.call("xlsx.format", [b.sh, b.rect, patch]));
        return { status: "applied" };
      }
      case "insert_rows":
      case "delete_rows":
      case "insert_columns":
      case "delete_columns": {
        const kind = { insert_rows: "insertRows", delete_rows: "deleteRows", insert_columns: "insertCols", delete_columns: "deleteCols" }[op.op];
        await st.h.engine.call("xlsx.sheetOp", [b.sh, { op: kind, at: b.at, n: b.n }]);
        st.loaded.delete(b.sh); // the sheet's rows moved: later reads must not use cached sizes
        movePercents(st, b.sh, op.op, b.at, b.n);
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
