import { EDITS_OVERFLOW } from "./constants.js";
import { untrusted } from "./sanitize.js";
import { exactHash } from "./text.js";
import { a1, ch, parseWorkbook } from "./xlsx.js";

// What the user changed in a workbook while the agent worked, carried onto the agent's version. The same three versions as the DOCX
// merge (src/merge.js): `base` (what the page loaded), `mine` (base plus the user's edits) and `theirs` (the file after the agent).
// The unit is the cell. A cell only the user changed becomes a `set_cells` op on `theirs` with the base text as `expect`, run through
// the same engine and package check as an agent's `apply`. A cell both sides changed keeps the agent's value and the user's value is
// handed back. Ceilings: cell values and formulas only. Formatting, sizes, hidden rows, merged cells and sheet changes are reported,
// not carried (the page names them in `edits`; one undone or redone with Undo/Redo is not reported). A value the engine reads
// differently than the file says (text that looks like a number) is handed back. More than MAX_OPS changed cells make their sheet a conflict.
// Whether an address still names the same cell on the agent's side is never guessed from the cells. Per sheet:
//  1. the agent's sheet is cell for cell the base: every edit of the user is carried;
//  2. the server's record of the run (`agentChanges`) shows the agent changed the file only through checked ops, and none that touched
//     this sheet moves cells (inserting or deleting rows or columns, renaming the sheet): merged cell by cell;
//  3. anything else (an op that moves cells, a write the server cannot name, such as `commit`, no record): all of the user's values on
//     the sheet are handed back in one item and the caller keeps a copy of the user's file.
// In case 2 the addresses hold, but `set_cells` can still rebuild a shift (each row's content written into the row below, numbers
// renumbered) that no op records. So a value is placed only on a row the agent left exactly as it was: a value on a row where the
// agent changed any cell is handed back. Two tests read the cells and can only hand back, never allow a merge: `sheetMoved` (the
// cells look like rows or columns moved) turns 2 into 3, and `placing` (the cells around a value do not show that its row and
// column are the same lines, as after a set_cells sort that left the value's own row alone) hands that one value back in case 2.
// A formula points at cells by address on any sheet: it is carried only when the agent left every sheet as it was (case 1). Rows
// or columns the user moved (the page says so, or the cells look like it) hand that sheet back too.
// Ceiling: a set_cells rebuild of a column shift that leaves the value's row reading as before (an empty row, or one whose cells
// all repeat across the shifted columns) is caught only by `placing`.

const CAP = 2000;
const turn = () => new Promise((resolve) => setImmediate(resolve));
const MAX_OPS = 2000;
const cut = (t) => (t.length > CAP ? `${t.slice(0, CAP)}...` : t);
const key = (r, c) => r * 16384 + c;
const sheetKey = (s) => `${s.sheetId} ${s.name}`;
const named = (s) => `"${untrusted(s.name, 60)}"`;
const same = (a, b) => (!a || !b ? !a && !b : (a.shared && b.shared) || (a.text === b.text && a.k === b.k));

// ---- do the cells look like rows or columns moved? (a tripwire: it can only hand edits back, never allow a merge) -------------
// Cell text cannot prove that a row was inserted: it can only show that the differences are also what a shift would leave behind.
// A line (row or column) is compared by its cells; a formula counts without its cell references, which a shift rewrites.
const REF = /\$?[A-Za-z]{1,3}\$?\d{1,7}/g;
// A short text stands for itself ("=" never starts a hash): hashing every cell of a large sheet was a sixth of its plan. Not one with
// "|", which joins a line's cells in its signature: such a text could spell out other cells (test/merge-xlsx.test.js).
const cellSig = (cell) => (cell.shared ? "shared" : cell.k === "formula" ? `f${exactHash(cell.text.replace(REF, "@"))}` : cell.text.length <= 16 && !cell.text.includes("|") ? `=${cell.text.normalize("NFC")}` : ch(cell));

/**
 * The rows (or columns) of a sheet: index -> {sig, cells: Map(position in the line -> cell signature)}. Read once per sheet reading and
 * axis: the plan asks for the base sheet's lines up to three times (the person's side, the agent's side, `placing`), and a sheet of
 * 1,000,000 cells took 11 s to plan in an outside review, most of it building the same lines again. Callers never change them.
 */
const LINES = new WeakMap();
function lines(sd, rows) {
  const kept = LINES.get(sd) || LINES.set(sd, [null, null]).get(sd);
  return (kept[rows ? 0 : 1] ??= readLines(sd, rows));
}
function readLines(sd, rows) {
  const out = new Map();
  for (const cell of sd.cells.values()) {
    const [i, j] = rows ? [cell.r, cell.c] : [cell.c, cell.r];
    (out.get(i) || out.set(i, { sig: "", cells: new Map() }).get(i)).cells.set(j, cellSig(cell));
  }
  for (const line of out.values()) line.sig = [...line.cells].sort((x, y) => x[0] - y[0]).map(([j, h]) => `${j}:${h}`).join("|");
  return out;
}

const COMMON = 20; // a cell value that this many changed lines share says nothing about which line is which
/** the share of cells two lines have in common, 0..1 */
function overlap(x, y) {
  if (!x || !y) return 0;
  let hit = 0;
  for (const [j, h] of x.cells) if (y.cells.get(j) === h) hit++;
  return hit / Math.max(x.cells.size, y.cells.size);
}

/**
 * True when the lines of B could be the lines of A after an insert, delete or move: a changed line now holds what another changed
 * line held (all of it, or at least half and more than of what it held itself: a line that was edited while it moved), a new line
 * repeats an old one, or a line that is gone has a twin left. Errs toward true (then nothing is merged there).
 * Lines that moved and were rewritten by more than half are not seen as moved here; the values on them are held back as values on rows the agent changed.
 */
function linesMoved(A, B) {
  const changed = new Set();
  for (const i of new Set([...A.keys(), ...B.keys()])) if (A.get(i)?.sig !== B.get(i)?.sig) changed.add(i);
  const where = (M) => {
    const m = new Map();
    for (const [i, line] of M) (m.get(line.sig) || m.set(line.sig, []).get(line.sig)).push(i);
    return m;
  };
  const inA = where(A);
  const inB = where(B);
  const held = new Map(); // "position:cell signature" -> the changed lines of A that hold it
  for (const q of changed) for (const [j, h] of A.get(q)?.cells || []) (held.get(`${j}:${h}`) || held.set(`${j}:${h}`, []).get(`${j}:${h}`)).push(q);
  // a changed line i never reads in A as it reads in B, so it is never among the lines of A that read like B's line i (nor the other way
  // round): those lines are counted per reading once, instead of searched for each changed line (quadratic over many lines that read alike)
  const changedIn = new Map(); // signature -> changed lines of A that read so
  for (const q of changed) if (A.has(q)) changedIn.set(A.get(q).sig, (changedIn.get(A.get(q).sig) || 0) + 1);
  for (const i of changed) {
    const a = A.get(i);
    const b = B.get(i);
    if (b && (a ? changedIn.get(b.sig) > 0 : inA.has(b.sig))) return true;
    if (a && !b && inB.has(a.sig)) return true;
    if (!b) continue;
    const votes = new Map();
    for (const [j, h] of b.cells) {
      const list = held.get(`${j}:${h}`);
      if (list && list.length <= COMMON) for (const q of list) if (q !== i) votes.set(q, (votes.get(q) || 0) + 1);
    }
    const best = [...votes].sort((x, y) => y[1] - x[1])[0];
    if (best) {
      const share = overlap(b, A.get(best[0]));
      if (share >= 0.5 && share > overlap(b, a)) return true;
    }
  }
  return false;
}

/** Rows or columns of this sheet were added, removed or moved between the two versions (or that cannot be ruled out). */
export const sheetMoved = (sdA, sdB) => sdA.truncated || sdB.truncated || linesMoved(lines(sdA, true), lines(sdB, true)) || linesMoved(lines(sdA, false), lines(sdB, false));

// ---- do the cells look like this is still the same row and the same column? (a tripwire too: it can only hand a value back) ---
const RARE = 500; // a cell value that more lines than this share is no evidence for which line is which (and bounds the work)
const WORK = 5e6; // comparisons per axis; past it nothing more counts as the same line

/**
 * One axis (rows or columns) of a sheet in base (A) and in the agent's version (B). `fits(i)`: a value may be placed on line i.
 * A line is the same line (`same`) when it reads the same and no other line reads like it, or when at least half of its cells
 * read the same and it reads as no other line as much (judged both ways: the agent's line among the base lines, the base line
 * among the agent's; cells with a value that more than RARE lines share are left out). A line between two such lines cannot have
 * moved, whatever was rewritten in it (`pinned`), unless it reads as another line more than as itself (`other`: two lines that
 * changed places); neither can the first line before one, the last line after one when the data ends where it did, or a line
 * the agent first wrote on past the end of the base data. A line that reads the same but has a twin, and an empty line, have
 * nothing that tells them apart: they fit only when no line of the axis is in doubt (`steady`), an empty line also when it is
 * past the end of the data in both versions. Errs toward false: the value is handed back.
 */
function axis(A, B) {
  const end = (M) => {
    let n = -1;
    for (const i of M.keys()) if (i > n) n = i;
    return n;
  };
  const endA = end(A);
  const endB = end(B);
  // a cell value at a position in its line, as one number (a string key per cell made the index most of a large sheet's plan)
  const values = new Map();
  const key = (j, h) => {
    let v = values.get(h);
    if (v === undefined) values.set(h, (v = values.size));
    return v * 2 ** 21 + j; // a line has fewer than 2^21 positions (1,048,576 rows)
  };
  const index = (M) => {
    const m = new Map();
    for (const [i, line] of M) for (const [j, h] of line.cells) {
      const k = key(j, h);
      const list = m.get(k);
      if (list) list.push(i);
      else m.set(k, [i]);
    }
    return m;
  };
  const count = (M) => {
    const m = new Map();
    for (const line of M.values()) m.set(line.sig, (m.get(line.sig) || 0) + 1);
    return m;
  };
  let ix, sigs, steady;
  let work = 0;
  const rare = (key) => (ix.A.get(key)?.length || 0) <= RARE && (ix.B.get(key)?.length || 0) <= RARE;
  const weights = new Map();
  const weight = (line) => {
    let w = weights.get(line); // kept here, not on the line: lines are shared by every reader of the sheet (lines())
    if (w == null) {
      w = 0;
      for (const [j, h] of line.cells) if (rare(key(j, h))) w++;
      weights.set(line, w);
    }
    return w;
  };
  /** how much of `line` reads as line i of M (`own`) and as the line of M it is most like apart from i (`other`): the share of the rare cells of the larger of the two */
  const shares = (i, line, M, inM) => {
    const votes = new Map();
    for (const [j, h] of line.cells) {
      const k = key(j, h);
      const list = rare(k) && inM.get(k);
      if (!list) continue;
      work += list.length;
      for (const q of list) votes.set(q, (votes.get(q) || 0) + 1);
    }
    let own = 0;
    let other = 0;
    for (const [q, n] of votes) {
      const share = n / Math.max(weight(line), weight(M.get(q)));
      if (q === i) own = share;
      else if (share > other) other = share;
    }
    return { own, other };
  };
  const judged = new Map();
  /** what the cells of line i say: {same, twin: reads the same but so does another line, other: reads as another line more than as itself} */
  const judge = (i) => {
    if (judged.has(i)) return judged.get(i);
    const a = A.get(i);
    const b = B.get(i);
    const v = { same: false, twin: false, other: false };
    if (a && b && a.sig === b.sig) {
      sigs ||= { A: count(A), B: count(B) };
      v.twin = sigs.A.get(a.sig) > 1 || sigs.B.get(b.sig) > 1;
      v.same = !v.twin;
    } else if (work > WORK) v.other = true;
    else if (a || b) {
      ix ||= { A: index(A), B: index(B) };
      const x = b ? shares(i, b, A, ix.A) : { own: 1, other: 0 };
      const y = a ? shares(i, a, B, ix.B) : { own: 1, other: 0 };
      v.same = !!a && !!b && x.own >= 0.5 && y.own >= 0.5 && x.other < x.own && y.other < y.own;
      v.other = (!!b && x.other > x.own) || (!!a && y.other > y.own);
    }
    judged.set(i, v);
    return v;
  };
  const pinned = (i) => !judge(i).other && (i === 0 || judge(i - 1).same) && (judge(i + 1).same || (i === endA && i === endB));
  /** line i, which has cells in one version at least, is not in doubt */
  const held = (i) => judge(i).same || judge(i).twin || pinned(i) || (!A.has(i) && i > endA);
  const isSteady = () => (steady ??= [...new Set([...A.keys(), ...B.keys()])].every(held));
  const fits = (i) => {
    if (!A.has(i)) return !B.has(i) && (i > Math.max(endA, endB) || isSteady());
    return judge(i).same || pinned(i) || (judge(i).twin && isSteady());
  };
  return { fits };
}

/** Where on the agent's sheet the cells do not argue against a value of the user: `cell(r, c)`. */
function placing(sdA, sdB) {
  const rows = axis(lines(sdA, true), lines(sdB, true));
  const cols = axis(lines(sdA, false), lines(sdB, false));
  return { cell: (r, c) => rows.fits(r) && cols.fits(c) };
}

// ---- how the agent changed the file: facts from the server's record of the run --------------------------------------------
// Ops that leave every cell at its address. Any other op moves cells on the sheet it names or, naming none, on every sheet.
const ADDRESS_STABLE = new Set(["set_cells", "format_cells", "replace_all_text", "add_sheet"]);
const lower = (n) => String(n).toLowerCase(); // the engine finds a sheet by its name in any case when that is unambiguous
const RANK = { stable: 0, unknown: 1, moved: 2 };
const UNKNOWN = { of: () => "unknown" };

/**
 * What the agent did to each sheet between the page's base and the file on disk. `steps` is the server's record of the writes that
 * lead from one to the other, oldest first (src/session.js): an `apply` write ({route: "apply", from, to: bytes before and after,
 * ops: the validated ops, partial, anchors: the delivered batch's}), or an earlier pass of this merge ({route: "merge", stable: the
 * sheets on which it kept every address}). Any other route (`commit`) or no record at all says nothing. An apply write counts only
 * when its ops, run again here on `from`, give `to` cell for cell: what the agent's process sent is checked, not believed.
 * Returns {of(sheet name)}: "stable" (every cell kept its address), "moved" (an op that changes which address a cell lives at
 * touched the sheet) or "unknown". Ceiling: one engine run per apply write of the run, on every merge.
 */
export async function agentChanges(steps, { runOps, name }) {
  if (!Array.isArray(steps) || !steps.length) return UNKNOWN;
  const each = [];
  try {
    for (const st of steps) {
      if (st.route === "merge" && Array.isArray(st.stable)) {
        const kept = new Set(st.stable.map(lower));
        each.push((n) => (kept.has(lower(n)) ? "stable" : "unknown"));
        continue;
      }
      if (st.route !== "apply" || !Array.isArray(st.ops) || !st.ops.length || !st.from || !st.to) return UNKNOWN;
      const anchors = new Map((st.anchors || []).map((a) => [a.id, a]));
      const again = await runOps({ bytes: st.from, format: "xlsx", name, ops: st.ops, partial: st.partial === true, anchors });
      if (!again.bytes) return UNKNOWN;
      const [to, out] = [parseWorkbook(st.to), parseWorkbook(again.bytes)];
      const capped = (wb) => wb.sheets.some((sh) => wb.sheetCells(sh).truncated); // cells past the parse cap cannot be compared
      if (capped(to) || capped(out) || verify(to, out, []).foreign) return UNKNOWN;
      const moved = new Set();
      let all = false;
      for (const op of st.ops) {
        if (ADDRESS_STABLE.has(op.op)) continue;
        if (typeof op.target?.sheet === "string") moved.add(lower(op.target.sheet));
        else all = true;
      }
      each.push((n) => (all || moved.has(lower(n)) ? "moved" : "stable"));
    }
  } catch {
    return UNKNOWN;
  }
  return { of: (n) => each.reduce((worst, f) => (RANK[f(n)] > RANK[worst] ? f(n) : worst), "stable") };
}

// ---- what the page says the user did (never a reason to write, only to hold back or to say what was not carried) ------------
const LAYOUT = new Set(["sheet.rowHeight", "sheet.colWidth", "sheet.hideRows", "sheet.hideCols", "sheet.gridlines", "sheet.freeze"]);
const VALUES = new Set(["cell", "replace", "undo", "redo"]);

function readEdits(edits) {
  const out = { moved: new Set(), movedAll: false, format: new Set(), layout: new Set(), book: false };
  for (const e of edits || []) {
    const kind = String(e?.kind ?? "");
    const sheet = typeof e?.sheet === "string" ? e.sheet : null;
    if (VALUES.has(kind)) continue;
    if (kind === "format") out.format.add(sheet);
    else if (LAYOUT.has(kind)) out.layout.add(sheet);
    else if (kind.startsWith("book.")) out.book = true;
    else if (sheet == null) out.movedAll = true; // rows, columns, sort, merged cells, an import, or a kind this code does not know
    else out.moved.add(sheet);
  }
  return out;
}

/**
 * Plans the merge. Arguments are parsed workbooks (parseWorkbook), the page's edit kinds ([{kind, sheet}]) and what the agent did
 * to each sheet (`agentChanges`; without it only sheets the agent left as they were are merged). Returns
 * {items: [{label, text, sheet, k, want, op}], unplaced: [{label, text, why}], copy, stable}: every item is tried on `theirs`; `copy`
 * asks the caller to keep the user's whole file, because an unplaced item stands for more than it can show; `stable` names the
 * sheets on which the user's version and the agent's still share every address (what a second pass of this merge starts from).
 */
export function planXlsxMerge(base, mine, theirs, edits = [], agent = UNKNOWN) {
  const said = readEdits(edits);
  const items = [];
  const unplaced = [];
  let copy = false;
  // `of` names what an entry stands for, for the proof of the merge (src/merge-proof.js): "S" and a sheet key, "c" and a sheet key, "!"
  // and a cell key, or "sheets" (the list of sheets)
  const whole = (label, why, text = "", of = []) => (unplaced.push({ label, text: cut(text), why, of }), (copy = true));
  const inMine = new Map(mine.sheets.map((s) => [sheetKey(s), s]));
  const inTheirs = new Map(theirs.sheets.map((s) => [sheetKey(s), s]));
  const inBase = new Set(base.sheets.map(sheetKey));
  let sheetsChanged = false;
  const memo = (fn, m = new Map()) => (b) => (m.has(sheetKey(b)) ? m.get(sheetKey(b)) : m.set(sheetKey(b), fn(b)).get(sheetKey(b)));
  const movedMine = memo((b) => said.movedAll || said.moved.has(b.name) || sheetMoved(base.sheetCells(b), mine.sheetCells(inMine.get(sheetKey(b)))));
  const movedTheirs = memo((b) => sheetMoved(base.sheetCells(b), theirs.sheetCells(inTheirs.get(sheetKey(b)))));
  /** the agent's sheet is cell for cell the base */
  const untouched = (b) => {
    const A = base.sheetCells(b);
    const T = theirs.sheetCells(inTheirs.get(sheetKey(b)));
    if (A.truncated || T.truncated || A.cells.size !== T.cells.size) return false;
    for (const [k, cell] of A.cells) if (!same(cell, T.cells.get(k))) return false;
    return true;
  };
  /** on the agent's side, may sheet b be merged by address? "same" | "stable" (cases 1 and 2), else why not: "gone" | "moved" | "unknown" | "looks moved" */
  const place = memo((b) => placing(base.sheetCells(b), theirs.sheetCells(inTheirs.get(sheetKey(b)))));
  const theirSide = memo((b) => {
    if (!inTheirs.has(sheetKey(b))) return "gone";
    if (untouched(b)) return "same";
    const fact = agent.of(b.name);
    if (fact !== "stable") return fact;
    return movedTheirs(b) ? "looks moved" : "stable";
  });
  const byAddress = (b) => ["same", "stable"].includes(theirSide(b));
  /** the rows on which the agent's sheet differs from the base in any cell (a set_cells rebuild of a shift rewrites them) */
  const agentRows = memo((b) => {
    const A = base.sheetCells(b).cells;
    const T = theirs.sheetCells(inTheirs.get(sheetKey(b))).cells;
    const rows = new Set();
    for (const k of new Set([...A.keys(), ...T.keys()])) if (!same(A.get(k), T.get(k))) rows.add(Math.floor(k / 16384));
    return rows;
  });
  // a formula points at cells by address, on any sheet, and any cell the agent set may hold another row's content now: it is
  // carried only when the agent left every sheet as it was
  let still;
  const formulasFit = () => (still ??= base.sheets.every((b) => inMine.has(sheetKey(b)) && !movedMine(b) && theirSide(b) === "same"));
  const theirWhy = {
    gone: (b) => `The agent removed or renamed the sheet ${named(b)}, so your edits there were not carried over. These are yours.`,
    moved: (b) => `The agent added, removed or moved rows or columns on the sheet ${named(b)}, so your edits there were not carried over. These are yours.`,
    unknown: (b) => `The agent changed the sheet ${named(b)} in a way Onionskin cannot check cell by cell, so your edits there were not carried over. These are yours.`,
    "looks moved": (b) => `The agent's changes on the sheet ${named(b)} look like rows or columns moved, so your edits there were not carried over. These are yours.`,
  };
  for (const s of mine.sheets) {
    if (inBase.has(sheetKey(s))) continue;
    sheetsChanged = true;
    whole(`Sheet ${named(s)}`, `You added or renamed the sheet ${named(s)}. Sheet changes are not carried over.`, "", [`S${sheetKey(s)}`]);
  }
  for (const b of base.sheets) {
    const m = inMine.get(sheetKey(b));
    if (!m) {
      sheetsChanged = true;
      unplaced.push({ label: `Sheet ${named(b)}`, text: "", why: `You removed or renamed the sheet ${named(b)}. Sheet changes are not carried over.`, of: [`S${sheetKey(b)}`] });
      continue;
    }
    const label = (r, c) => `${untrusted(b.name, 60)}!${a1(r, c)}`;
    const box = [`S${sheetKey(b)}`];
    const cellRef = (k) => [`c${sheetKey(b)}!${k}`];
    const sdB = base.sheetCells(b);
    const sdM = mine.sheetCells(m);
    const changed = [];
    for (const k of new Set([...sdB.cells.keys(), ...sdM.cells.keys()])) if (!same(sdB.cells.get(k), sdM.cells.get(k))) changed.push(k);
    changed.sort((x, y) => x - y);
    // a number format changed on a cell whose value did not, which the page did not name: said too, never carried
    if (!said.format.has(b.name) && !said.format.has(null)) {
      for (const [k, cell] of sdB.cells) {
        const now = sdM.cells.get(k);
        if (now && same(cell, now) && base.numberFormat(cell.s) !== mine.numberFormat(now.s)) unplaced.push({ label: label(Math.floor(k / 16384), k % 16384), text: "", why: `You changed the number format of ${label(Math.floor(k / 16384), k % 16384)}. Formatting is not carried over.`, of: cellRef(k) });
      }
    }
    const mineMoved = movedMine(b);
    if (!changed.length && !mineMoved) continue;
    const values = () => {
      let out = "";
      for (const k of changed) {
        if (out.length > CAP) break; // the rest is in the copy of the user's file
        out += `${out ? "\n" : ""}${a1(Math.floor(k / 16384), k % 16384)}: ${sdM.cells.get(k)?.text ?? "(emptied)"}`;
      }
      return out;
    };
    const t = inTheirs.get(sheetKey(b));
    if (mineMoved) whole(`Sheet ${named(b)}`, `You added, removed or moved rows or columns on the sheet ${named(b)}. That is not carried over. These cells differ in your version.`, values(), box);
    else if (!byAddress(b)) whole(`Sheet ${named(b)}`, theirWhy[theirSide(b)](b), values(), box);
    else if (items.length + changed.length > MAX_OPS) whole(`Sheet ${named(b)}`, `You changed more than ${MAX_OPS} cells while the agent worked. The cells on the sheet ${named(b)} were not carried over. These are yours.`, values(), box);
    else {
      const sdT = theirs.sheetCells(t);
      for (const k of changed) {
        const r = Math.floor(k / 16384);
        const c = k % 16384;
        const want = sdM.cells.get(k);
        const was = sdB.cells.get(k);
        const now = sdT.cells.get(k);
        if (same(now, want)) continue; // the agent wrote the same value
        if (!same(now, was)) {
          unplaced.push({ label: label(r, c), text: cut(want?.text ?? ""), why: want ? `The agent changed ${label(r, c)} too. Its value is in the sheet; this is yours.` : `You emptied ${label(r, c)}, but the agent changed it, so it was kept.`, of: cellRef(k) });
          continue;
        }
        if (theirSide(b) === "stable" && agentRows(b).has(r)) {
          unplaced.push({ label: label(r, c), text: cut(want?.text ?? ""), why: want ? `The agent changed other cells in the same row as ${label(r, c)}, so that row may hold other content now. Your value was not carried over. This is yours.` : `You emptied ${label(r, c)}, but the agent changed other cells in the same row, so it was kept.`, of: cellRef(k) });
          continue;
        }
        if (theirSide(b) === "stable" && !place(b).cell(r, c)) {
          unplaced.push({ label: label(r, c), text: cut(want?.text ?? ""), why: want ? `The agent changed so much around ${label(r, c)} that it may not be the same cell any more, so your value was not carried over. This is yours.` : `You emptied ${label(r, c)}, but the agent changed so much around it that it may not be the same cell any more, so it was kept.`, of: cellRef(k) });
          continue;
        }
        if (want?.k === "formula" && !formulasFit()) {
          unplaced.push({ label: label(r, c), text: cut(want.text), why: `Rows or columns may have moved while the agent worked, so your formula for ${label(r, c)} may point at other cells now. It was not carried over. This is yours.`, of: cellRef(k) });
          continue;
        }
        items.push({ label: label(r, c), of: cellRef(k), text: cut(want?.text ?? ""), sheet: sheetKey(b), k, want, op: { op: "set_cells", target: { sheet: b.name, range: a1(r, c) }, expect: { text_hash: exactHash(was?.text ?? "") }, values: want ? want.text : null } });
      }
    }
  }
  const order = (wb) => wb.sheets.map(sheetKey).filter((x) => inBase.has(x) && inMine.has(x)).join("\n");
  // sheets moved are said even when sheets were also added or removed (those lines name only the sheets added or removed: a move next to
  // them was dropped without a word, found by test/merge-xlsx-property.test.js)
  if (order(base) !== order(mine) || (said.book && !sheetsChanged)) unplaced.push({ label: "Sheets", text: "", why: "You moved, hid or changed sheets. Sheet changes are not carried over.", of: ["sheets"] });
  const where = (sheet) => (sheet == null ? "" : ` on the sheet "${untrusted(sheet, 60)}"`);
  const sheetRef = (sheet) => mine.sheets.filter((s) => sheet == null || s.name === sheet).map((s) => `S${sheetKey(s)}`);
  for (const sheet of said.format) unplaced.push({ label: "Formatting", text: "", why: `You changed formatting${where(sheet)}. Formatting is not carried over.`, of: sheetRef(sheet) });
  for (const sheet of said.layout) unplaced.push({ label: "Layout", text: "", why: `You changed row or column sizes, hidden rows or columns, or the frozen panes${where(sheet)}. That is not carried over.`, of: sheetRef(sheet) });
  const stable = base.sheets.filter((b) => inMine.has(sheetKey(b)) && !movedMine(b) && byAddress(b)).map((b) => b.name);
  return { items, unplaced, copy, stable };
}

/**
 * What the result must be: the agent's file, with nothing different except the carried cells, each reading as the user's. A cell
 * that was there before keeps its number format (typing a value does not change one), carried or not.
 */
function verify(theirs, out, applied) {
  const bad = new Set();
  if (theirs.sheets.map(sheetKey).join("\n") !== out.sheets.map(sheetKey).join("\n")) return { foreign: true, bad };
  const carried = new Map(applied.map((it) => [`${it.sheet}\n${it.k}`, it]));
  for (const [i, s] of theirs.sheets.entries()) {
    const T = theirs.sheetCells(s).cells;
    const O = out.sheetCells(out.sheets[i]).cells;
    for (const k of new Set([...T.keys(), ...O.keys()])) {
      const t = T.get(k);
      const o = O.get(k);
      const it = carried.get(`${sheetKey(s)}\n${k}`);
      const format = !t || !o || theirs.numberFormat(t.s) === out.numberFormat(o.s);
      if (it ? same(o, it.want) && format : same(o, t) && format) continue;
      if (!it) return { foreign: true, bad };
      bad.add(it);
    }
  }
  return { foreign: false, bad };
}

/**
 * Runs the plan on the agent's bytes. `runOps` is injected (src/ops/run.js); `agent` is the server's record of the run (see
 * `agentChanges`). Returns {bytes: Buffer|null, merged, unplaced, copy, stable}.
 * The proof is the result: bytes are returned only when the saved file is the agent's file plus exactly the carried cells. A cell
 * that did not land as the user had it is taken out and the rest is run again from the agent's bytes (once), so it is never written.
 */
export async function mergeXlsx({ base, mine, theirs, name, runOps, edits = [], agent = null }) {
  // which sheets had rows or columns moved comes from the page's list of edits as well as from the bytes: a list cut short cannot say
  // that none were, so nothing is carried by address on its word (the merge returns no file; src/merge-worker.js)
  if ((edits || []).some((e) => e?.kind === EDITS_OVERFLOW)) return { refuse: "more edits were made than Onionskin can follow; it cannot tell whether rows or columns moved" };
  const T = parseWorkbook(theirs);
  const facts = await agentChanges(agent, { runOps, name });
  await turn(); // between the readings and the plan (the sheets are read as the plan needs them)
  const read = { base: parseWorkbook(base), mine: parseWorkbook(mine), theirs: T }; // also for the proof of the merge (src/merge-worker.js)
  const plan = planXlsxMerge(read.base, read.mine, T, edits, facts);
  await turn();
  const unplaced = [...plan.unplaced];
  const fail = (it, why) => unplaced.push({ label: it.label, text: it.text, why, of: it.of });
  const end = (bytes, merged) => ({ bytes, merged, unplaced, copy: plan.copy, stable: plan.stable, read });
  let items = plan.items;
  for (let pass = 0; pass < 2 && items.length; pass++) {
    const { results, bytes, blocked } = await runOps({ bytes: theirs, format: "xlsx", name, ops: items.map((x) => x.op), partial: true });
    if (!bytes) {
      for (const it of items) fail(it, blocked ? "Carrying your edits over would have damaged the file, so none were applied." : `Your value for ${it.label} could not be placed on the agent's version.`);
      return end(null, 0);
    }
    const applied = items.filter((_, n) => results[n]?.status === "applied");
    await turn();
    const { foreign, bad } = verify(T, parseWorkbook(bytes), applied);
    if (foreign) break;
    const isApplied = new Set(applied); // includes() per item was quadratic
    for (const it of items) {
      if (!isApplied.has(it)) fail(it, `Your value for ${it.label} could not be placed on the agent's version.`);
      else if (bad.has(it)) fail(it, `Your value for ${it.label} did not land as typed, so the agent's version was kept there.`);
    }
    if (!bad.size) return end(bytes, applied.length);
    items = applied.filter((it) => !bad.has(it));
  }
  for (const it of items) fail(it, "Carrying your edits over would have changed the agent's values, so none were applied.");
  return end(null, 0);
}
