import assert from "node:assert/strict";
import { test } from "node:test";
import { buildZip as buildZipLite, xlsxBytes } from "./helpers/zipbuild.js";
import { openZip as openZipLite } from "../src/zip.js";
import { mergeXlsx } from "../src/merge-xlsx.js";
import { mergeProven } from "../src/merge-worker.js";
import { parseWorkbook } from "../src/xlsx.js";
import { runOps } from "../src/ops/run.js";

// The XLSX merge as a property over random small workbooks, as the merge worker runs it (src/merge-worker.js): the planner
// (src/merge-xlsx.js) and the op engine, then the proof (src/merge-proof.js). Every case ends in a correct merge or a clean refusal;
// a silent loss is the only failure. A third checker over plain objects (sheet -> address -> value), importing neither the planner nor
// the proof, judges the merges returned: each of the person's cell changes (a value, a formula, a cell emptied, white space as typed)
// is in the result at its address or handed back by an entry that names the cell or its sheet (a whole sheet with the person's file
// kept); sheets added, removed, renamed or moved are handed back; the agent's cells stand; nothing else differs from the agent's file.
// The agent writes through checked set_cells ops with the server's record of the run, or as plain bytes (a commit, rows shifted).

const SEED = 20261116;
const CASES = 1500;
const PARTS = 3;

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const COLS = "ABCD";
const WORDS = ["Item", "Total", "North", "South", "Q1", "Q2"];
/** a workbook as {sheet name: {A1: value}}, the order of the keys being the order of the sheets */
function makeCase(seed) {
  const r = rng(seed);
  const pick = (list) => list[Math.floor(r() * list.length)];
  const rows = 3 + Math.floor(r() * 4);
  const sheet = (tag) => {
    const out = {};
    for (let i = 1; i <= rows; i++) for (const c of COLS) if (r() < 0.8) out[`${c}${i}`] = r() < 0.5 ? Math.floor(r() * 100) : `${pick(WORDS)} ${tag}${i}`;
    return out;
  };
  const base = { Data: sheet("d"), Notes: sheet("n") };
  const ref = () => `${pick([...COLS])}${1 + Math.floor(r() * (rows + 1))}`;
  let n = 0;
  const value = (who) => pick([() => Math.floor(r() * 1000), () => `${who} ${++n}`, () => `=A1+${++n}`, () => `${who}  two  spaces`, () => ` ${who} lead`]) ();
  const copy = (b) => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, { ...v }]));
  const mine = copy(base);
  for (let k = 1 + Math.floor(r() * 3); k > 0; k--) {
    const s = pick(Object.keys(mine));
    const op = pick(["set", "set", "set", "clear", "space", "shift", "addSheet", "renameSheet", "moveSheets"]);
    if (op === "set") mine[s][ref()] = value("Mine");
    else if (op === "clear") delete mine[s][ref()];
    else if (op === "space") {
      const at = Object.keys(mine[s]).find((x) => typeof mine[s][x] === "string" && mine[s][x].includes(" "));
      if (at) mine[s][at] = mine[s][at].replace(" ", "  ");
    } else if (op === "shift") mine[s] = Object.fromEntries(Object.entries(mine[s]).map(([a, v]) => [a.replace(/\d+$/, (d) => String(Number(d) + (Number(d) >= 2 ? 1 : 0))), v]));
    else if (op === "addSheet" && !mine.Extra) mine.Extra = { A1: "Added by me" };
    else if (op === "renameSheet" && mine.Notes) (mine.Renamed = mine.Notes), delete mine.Notes;
    else if (op === "moveSheets" && mine.Data && mine.Notes) {
      const [d, nn] = [mine.Data, mine.Notes];
      delete mine.Data;
      delete mine.Notes;
      Object.assign(mine, { Notes: nn, Data: d });
    }
  }
  // the agent: set cells through checked ops (most often), or write the bytes itself (a commit), rows shifted or not
  const how = r() < 0.65 ? "ops" : "bytes";
  const agentSets = [];
  for (let k = 1 + Math.floor(r() * 2); k > 0; k--) agentSets.push([pick(["Data", "Notes"]), ref(), value("Agent")]);
  const shift = how === "bytes" && r() < 0.3 ? pick(["Data", "Notes"]) : null;
  return { base, mine, how, agentSets, shift };
}

const sheetIds = { Data: 1, Notes: 2, Extra: 3, Renamed: 2 }; // a renamed sheet keeps its id
const bytesOf = (book) => xlsxBytes(book, { ids: Object.fromEntries(Object.keys(book).map((k) => [k, sheetIds[k]])) });
/** the workbook's cells as plain objects: {sheets: [name in order], cells: {name: {A1: "kind value"}}} */
function plainOf(bytes) {
  const wb = parseWorkbook(bytes);
  const cells = {};
  for (const s of wb.sheets) {
    const out = (cells[s.name] = {});
    for (const c of wb.sheetCells(s).cells.values()) out[`${String.fromCharCode(65 + c.c)}${c.r + 1}`] = { k: c.k, text: c.text };
  }
  return { sheets: wb.sheets.map((s) => s.name), cells, ids: Object.fromEntries(wb.sheets.map((s) => [s.name, s.sheetId])) };
}

async function theirsOf(c, baseBytes) {
  if (c.how === "ops") {
    const plain = plainOf(baseBytes);
    const ops = c.agentSets.map(([sheet, range, values]) => ({ op: "set_cells", target: { sheet, range }, expect: { quote: plain.cells[sheet][range]?.text ?? "" }, values }));
    const r = await runOps({ bytes: baseBytes, format: "xlsx", name: "t.xlsx", ops });
    if (!r.bytes) return { theirs: baseBytes, agent: null }; // (an op the engine refused: the agent changed nothing)
    return { theirs: r.bytes, agent: [{ route: "apply", from: baseBytes, to: r.bytes, ops, partial: false, anchors: [] }] };
  }
  const book = Object.fromEntries(Object.entries(c.base).map(([k, v]) => [k, { ...v }]));
  for (const [sheet, at, v] of c.agentSets) book[sheet][at] = v;
  if (c.shift) book[c.shift] = Object.fromEntries(Object.entries(book[c.shift]).map(([a, v]) => [a.replace(/\d+$/, (d) => String(Number(d) + 1)), v]));
  return { theirs: bytesOf(book), agent: null };
}

/** the third checker: what does not balance, from plain objects and the merge's list (refs "S<id> <name>", "c<id> <name>!<key>", "sheets") */
function unbalanced(B, M, T, R, unplaced, copy) {
  const bad = [];
  const named = new Map();
  for (const u of unplaced) for (const ref of u.of || []) (named.get(ref) || named.set(ref, []).get(ref)).push(u);
  const sheetRef = (P, s) => `S${P.ids[s]} ${s}`;
  const key = (a) => (Number(/\d+$/.exec(a)[0]) - 1) * 16384 + a.charCodeAt(0) - 65;
  const back = (refs, text = null) => refs.some((ref) => (named.get(ref) || []).some((u) => text === null || u.text === text));
  const same = (x, y) => (x?.k ?? "") === (y?.k ?? "") && (x?.text ?? "") === (y?.text ?? "");
  if (T.sheets.join() !== R.sheets.join()) bad.push("the agent's list of sheets changed");
  for (const s of M.sheets) if (!B.sheets.includes(s) && !(back([sheetRef(M, s)]) && copy)) bad.push(`the sheet ${s} the person added is not handed back`);
  for (const s of B.sheets) if (!M.sheets.includes(s) && !back([sheetRef(B, s)])) bad.push(`the sheet ${s} the person removed is not handed back`);
  const order = (P, other) => P.sheets.filter((s) => other.sheets.includes(s));
  if (order(B, M).join() !== order(M, B).join() && !back(["sheets"])) bad.push("the person moved sheets; not handed back");
  for (const s of B.sheets) {
    const all = new Set([...Object.keys(B.cells[s]), ...Object.keys(M.cells[s] || {}), ...Object.keys(T.cells[s] || {}), ...Object.keys(R.cells[s] || {})]);
    for (const a of all) {
      const [b, m, t, r] = [B, M, T, R].map((P) => P.cells[s]?.[a]);
      const mineHas = M.sheets.includes(s);
      const pChanged = mineHas && !same(b, m);
      const refs = [`c${sheetRef(B, s).slice(1)}!${key(a)}`];
      if (T.sheets.includes(s) && !same(r, t) && !(pChanged && same(t, b) && same(r, m))) bad.push(`${s}!${a} reads ${r?.text ?? "(empty)"}, neither the agent's value nor the person's change`);
      if (pChanged && !same(r, m) && !back(refs, m?.text ?? "") && !(copy && back([sheetRef(B, s)]))) bad.push(`the person's ${s}!${a} is neither in the result nor handed back`);
    }
  }
  return bad;
}

async function check(c) {
  const base = bytesOf(c.base);
  const mine = bytesOf(c.mine);
  const { theirs, agent } = await theirsOf(c, base);
  const r = await mergeProven({ format: "xlsx", base, mine, theirs, name: "t.xlsx", agent });
  if (r.refused) return { refused: r.refused };
  return { bad: unbalanced(plainOf(base), plainOf(mine), plainOf(theirs), plainOf(r.bytes ?? theirs), r.unplaced, !!r.copy), merged: r.merged };
}

for (let part = 0; part < PARTS; part++) {
  test(`XLSX property, part ${part + 1} of ${PARTS} (${CASES} cases in all, seed ${SEED}): a correct merge or a clean refusal, never a silent loss`, async (t) => {
    const per = CASES / PARTS;
    const failures = [];
    let refused = 0;
    let carried = 0;
    for (let k = part * per; k < (part + 1) * per && failures.length < 5; k++) {
      const c = makeCase(SEED + k);
      const out = await check(c);
      if (out.refused) refused++;
      else if (out.bad.length) failures.push(`seed ${SEED + k}: ${out.bad.join("; ")}\n  ${JSON.stringify(c)}`);
      else if (out.merged) carried++;
    }
    t.diagnostic(`merged ${per - refused} (${carried} with cells carried), refused ${refused}`);
    assert.deepEqual(failures, []);
  });
}

test("found: sheets moved while a sheet was added are handed back too (the move was dropped without a word)", async () => {
  const c = { base: { Data: { A1: 1 }, Notes: { A1: "n" } }, mine: { Extra: { A1: "Added by me" }, Notes: { A1: "n" }, Data: { A1: 1 } }, how: "bytes", agentSets: [["Data", "B2", 5]], shift: null };
  const out = await check(c);
  assert.deepEqual(out.bad, []);
  const r = await mergeXlsx({ base: bytesOf(c.base), mine: bytesOf(c.mine), theirs: (await theirsOf(c, bytesOf(c.base))).theirs, name: "t.xlsx", runOps });
  assert.ok(r.unplaced.some((u) => u.label === "Sheets" && /moved/.test(u.why)), JSON.stringify(r.unplaced));
});

// ---- cell styles, merged ranges, column widths; many edits ----------------------------------------------------------------------
// The person makes cells bold, fills them, changes their number format or alignment, merges a range, widens a column or types a
// value, sometimes past 2,000 page events; the agent types values or bolds cells. A tiny checker over plain objects (each cell's value
// and its style read through the result's own styles part, the merged ranges and the column widths) asks of every difference between
// the base and the person's version: in the result, or handed back by an entry that names the cell or its sheet (with the person's file
// kept), or the merge refused. Silent loss is the only failure.
const STYLE_CASES = 300;
const SS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
// 16 cell styles: bold (1), filled (2), percent (4), centered (8)
const XFS = Array.from({ length: 16 }, (_, s) => `<xf numFmtId="${s & 4 ? 164 : 0}" fontId="${s & 1}" fillId="${s & 2 ? 2 : 0}" borderId="0" xfId="0"${s & 1 ? ' applyFont="1"' : ""}${s & 2 ? ' applyFill="1"' : ""}${s & 4 ? ' applyNumberFormat="1"' : ""}${s & 8 ? ' applyAlignment="1"><alignment horizontal="center"/></xf>' : "/>"}`).join("");
const STYLE_XML = `<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="0.00%"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="16">${XFS}</cellXfs></styleSheet>`;
function makeStyled(seed) {
  const r = rng(seed);
  const pick = (list) => list[Math.floor(r() * list.length)];
  const refs = ["A1", "B1", "C1", "A2", "B2", "C2", "A3", "B3"];
  const sheet = (tag) => ({ cells: Object.fromEntries(refs.map((a, k) => [a, { v: `${tag} ${k}`, s: 0 }])), merges: [], widths: { A: 12, B: 12 } });
  const base = { S: sheet("s"), T: sheet("t") };
  const copy = (d) => JSON.parse(JSON.stringify(d));
  let n = 0;
  const side = (who, ops) => {
    const d = copy(base);
    for (let k = 1 + Math.floor(r() * 3); k > 0; k--) {
      const op = pick(ops);
      const sh = d[pick(["S", "T"])];
      const c = sh.cells[pick(refs)];
      if (op === "value") c.v = `${who} ${++n}`;
      else if (op === "bold") c.s ^= 1;
      else if (op === "fill") c.s ^= 2;
      else if (op === "format") c.s ^= 4;
      else if (op === "align") c.s ^= 8;
      else if (op === "merge" && !sh.merges.length) sh.merges.push("A3:B3");
      else if (op === "width") sh.widths[pick(["A", "B"])] += 5;
    }
    return d;
  };
  return { base, mine: side("Mine", ["value", "bold", "fill", "format", "align", "merge", "width"]), theirs: side("Agent", ["value", "value", "bold"]), many: r() < 0.2 };
}
function styledBytes(d) {
  const sheetXml = (sh) => `<?xml version="1.0"?><worksheet ${SS}><cols>${Object.entries(sh.widths).map(([col, w]) => { const i = col.charCodeAt(0) - 64; return `<col min="${i}" max="${i}" width="${w}" customWidth="1"/>`; }).join("")}</cols><sheetData>${[1, 2, 3].map((row) => `<row r="${row}">${Object.entries(sh.cells).filter(([a]) => a.endsWith(String(row))).map(([a, c]) => `<c r="${a}"${c.s ? ` s="${c.s}"` : ""} t="inlineStr"><is><t>${c.v}</t></is></c>`).join("")}</row>`).join("")}</sheetData>${sh.merges.length ? `<mergeCells count="${sh.merges.length}">${sh.merges.map((m) => `<mergeCell ref="${m}"/>`).join("")}</mergeCells>` : ""}</worksheet>`;
  return buildZipLite({
    "[Content_Types].xml": `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    "_rels/.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0"?><workbook ${SS}><sheets><sheet name="S" sheetId="1" r:id="rId1"/><sheet name="T" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL}/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="${REL}/styles" Target="styles.xml"/></Relationships>`,
    "xl/styles.xml": STYLE_XML,
    "xl/worksheets/sheet1.xml": sheetXml(d.S),
    "xl/worksheets/sheet2.xml": sheetXml(d.T),
  });
}
/** the tiny checker's reading: per sheet, each cell's value and style (bold, fill, format, alignment) through the file's own styles */
function styledOf(bytes) {
  const zip = openZipLite(bytes);
  const st = zip.readText("xl/styles.xml");
  const fonts = [...st.matchAll(/<font>.*?<\/font>|<font\/>/gs)].map(([f]) => /<b\/>|<b val="(1|true)"\/>/.test(f));
  const fills = [...st.matchAll(/<fill>.*?<\/fill>/gs)].map(([f]) => /<fgColor rgb="([^"]+)"/.exec(f)?.[1] ?? /patternType="([^"]+)"/.exec(f)?.[1] ?? "");
  const fmts = new Map([...st.matchAll(/<numFmt numFmtId="(\d+)" formatCode="([^"]*)"\/>/g)].map((m) => [m[1], m[2]]));
  const xfs = [...(/<cellXfs[^>]*>(.*?)<\/cellXfs>/s.exec(st)?.[1] ?? "").matchAll(/<xf\b[^>]*\/>|<xf\b[^>]*>.*?<\/xf>/gs)].map(([x]) => {
    const at = (k) => new RegExp(`\\b${k}="(\\d+)"`).exec(x)?.[1] ?? "0";
    return `${fonts[Number(at("fontId"))] ? "bold" : ""}|${fills[Number(at("fillId"))]}|${fmts.get(at("numFmtId")) ?? at("numFmtId")}|${/horizontal="([^"]+)"/.exec(x)?.[1] ?? ""}`;
  });
  const sheet = (n) => {
    const x = zip.readText(`xl/worksheets/sheet${n}.xml`);
    const cells = Object.fromEntries([...x.matchAll(/<c r="([A-Z]+\d+)"([^>]*)>(.*?)<\/c>/gs)].map((m) => [m[1], { v: [...m[3].matchAll(/<t(?: [^>]*)?>([^<]*)<\/t>/g)].map((t) => t[1]).join(""), s: xfs[Number(/ s="(\d+)"/.exec(m[2])?.[1] ?? 0)] }]));
    return { cells, merges: [...x.matchAll(/<mergeCell ref="([^"]+)"/g)].map((m) => m[1]).join(), widths: [...x.matchAll(/<col [^>]*\/>/g)].map(([c]) => `${/min="(\d+)"/.exec(c)[1]}:${/width="([^"]+)"/.exec(c)[1]}`).join() };
  };
  return { S: sheet(1), T: sheet(2) };
}
function styledUnbalanced(B, M, T, R, unplaced, copy) {
  const bad = [];
  const named = (refs) => unplaced.some((u) => (u.of || []).some((ref) => refs.includes(ref)));
  const key = (a) => (Number(/\d+$/.exec(a)[0]) - 1) * 16384 + a.charCodeAt(0) - 65;
  for (const [name, id] of [["S", 1], ["T", 2]]) {
    const box = `S${id} ${name}`;
    const whole = copy && named([box]);
    for (const [a, x] of Object.entries(M[name].cells)) {
      const was = B[name].cells[a];
      const got = R[name].cells[a];
      const refs = [`c${id} ${name}!${key(a)}`];
      if (x.v !== was.v && got?.v !== x.v && !named(refs) && !whole) bad.push(`the person's value of ${name}!${a} is neither in the result nor handed back`);
      if (x.s !== was.s && got?.s !== x.s && !named(refs) && !whole) bad.push(`the person's style of ${name}!${a} (${was.s} -> ${x.s}) is neither in the result nor handed back (${got?.s})`);
      const agent = T[name].cells[a];
      if (agent.v !== was.v && x.v === was.v && got?.v !== agent.v) bad.push(`the agent's value of ${name}!${a} is gone`);
    }
    for (const k of ["merges", "widths"]) if (M[name][k] !== B[name][k] && R[name][k] !== M[name][k] && !whole) bad.push(`the person's ${k} on ${name} are neither in the result nor handed back`);
  }
  return bad;
}
test(`XLSX property, cell styles and sheet layout (${STYLE_CASES} cases, seed ${SEED + 11}): bold, fill, number format, alignment, merged ranges, column widths, many edits: a correct merge or a clean refusal, never a silent loss`, async (t) => {
  const { editKinds } = await import("../src/session.js");
  const many = editKinds(Array.from({ length: 2001 }, () => ({ kind: "cell", sheet: "S" })));
  const failures = [];
  const count = { merged: 0, handedBack: 0, refused: 0 };
  for (let k = 0; k < STYLE_CASES && failures.length < 5; k++) {
    const c = makeStyled(SEED + 11 + k);
    const [base, mine, theirs] = [c.base, c.mine, c.theirs].map(styledBytes);
    const r = await mergeProven({ format: "xlsx", base, mine, theirs, name: "t.xlsx", edits: c.many ? many : [] });
    if (r.refused) {
      count.refused++;
      continue;
    }
    count[r.unplaced.length ? "handedBack" : "merged"]++;
    const bad = styledUnbalanced(...[base, mine, theirs, r.bytes ?? theirs].map(styledOf), r.unplaced, r.copy);
    if (bad.length) failures.push(`seed ${SEED + 11 + k}: ${bad.join("; ")}`);
  }
  t.diagnostic(`merged ${count.merged}, handed back ${count.handedBack}, refused ${count.refused}`);
  assert.deepEqual(failures, []);
});
