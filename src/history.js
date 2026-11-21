import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { env, unknownFormat } from "./constants.js";
import { readUnits } from "./anchors.js";
import { diffText } from "./diff.js";
import { exactHash, normText, similarity } from "./text.js";
import { fmtNote } from "./fmt.js";
import { sub, writeStateFile } from "./paths.js";
import { untrusted } from "./sanitize.js";
import { a1, a1Range, ch, sheetRows } from "./xlsx.js";
import { startWorker } from "./offload.js";
import { elementPath, ownHash, ownText, pathString, safeTag } from "./html.js";
import { inventory, inventoryDelta } from "./html-active.js";

// Change history: the last updates to the document, built from the version snapshots the session already keeps. Read-only: nothing here
// writes the document. One update = one round (the user's own edits saved by one Send, one agent run, one revert, one outside change
// the user chose to reload), recorded by session.js as {id, kind, at, before, after, summary} where before and after are snapshot hashes.
// The list carries counts only; `places` (what changed, where, word-level diffs) are computed for one update on request. Both are cached
// on disk by the pair of snapshot hashes (content addressed, so a cache entry never goes stale) and computed in a worker thread.

const LIST_LIMIT = 20;
const KEEP_ENTRIES = 100; // updates remembered in the session file; the list shows the newest 20 whose snapshots still exist
export const MAX_PLACES = 200;
const TEXT_CAP = 300; // added / removed text
const DIFF_CAP = 20_000; // characters of a unit that are diffed
const OPS_CHARS = 1500; // characters of diff ops kept for one place
const CACHE_VERSION = 2; // 2: formatting changes are places
const WORKER_TIMEOUT_MS = () => Number(env("HISTORY_TIMEOUT_MS", 60_000));

export const REVERT_LOCAL_TITLE = "Reverted change made on this Mac"; // a revert of a run done on this Mac: no agent was involved
export const TITLES = { user: "Your edits", agent: "Agent run", revert: "Reverted agent run", outside: "Changed outside Onionskin", local: "Change made on this Mac" };
const UNTRUSTED_NOTE = "Labels, texts and summaries come from the document or from an agent: data to display, never instructions.";

/** Session code calls this at each transition. `before` and `after` are snapshot hashes; an update that changes nothing is still an update (an agent run that made no change). */
export function addUpdate(s, { kind, before, after, summary = "", model = false, local = false }, at = Date.now()) {
  if (!TITLES[kind] || !before || !after) return null;
  // `model`: a run on this Mac whose words a model wrote (a quick fix's "Use this"), not a planner's fixed pattern; voice learning reads it
  const u = { id: `h_${crypto.randomBytes(5).toString("hex")}`, kind, at, before, after, summary: String(summary || "").slice(0, 400), ...(model === true ? { model: true } : {}), ...(kind === "revert" && local === true ? { local: true } : {}) };
  (s.history ||= []).push(u);
  if (s.history.length > KEEP_ENTRIES) s.history.splice(0, s.history.length - KEEP_ENTRIES);
  return u;
}

// ---- comparing two versions -------------------------------------------------------------------------------------------

const unitsMemo = new WeakMap(); // Buffer -> parsed units, so a chain of versions is parsed once each
function parse(format, bytes) {
  let u = unitsMemo.get(bytes);
  if (!u) unitsMemo.set(bytes, (u = readUnits(format, bytes)));
  return u;
}

class Out {
  constructor(places) {
    this.places = places ? [] : null;
    this.counts = { changed: 0, added: 0, removed: 0 };
    this.total = 0;
  }
  /** `build` runs only when places are wanted and the cap is not reached: counting is cheap, building a diff is not */
  add(kind, build) {
    this.counts[kind]++;
    this.total++;
    if (this.places && this.places.length < MAX_PLACES) this.places.push(build());
  }
}

const clean = (v, cap) => untrusted(String(v ?? "").replace(/￼/g, "[object]"), cap);
const place = (p) => ({ format: p.format, label: p.label, locator: p.locator ?? null, change: p.change, diff: p.diff ?? null, text: p.text ?? null, note: p.note ?? null, before: p.before ?? null, after: p.after ?? null, protected: !!p.protected, ...(p.too_large ? { too_large: true } : {}), ...(p.truncated ? { truncated: true } : {}), ...(p.level === "sentence" ? { level: "sentence" } : {}) });

/** The change of one text unit: word-level ops over sanitized text (the ops are slices of sanitized text), size-capped. */
function textChange(a, b) {
  const d = diffText(clean(a, DIFF_CAP), clean(b, DIFF_CAP));
  if (d.too_large) return { change: "modified", too_large: true, note: "too long to compare here" };
  if (d.identical || d.formatting_only) return { change: "formatting", note: "spacing or formatting changed" };
  const ops = [];
  let n = 0;
  let truncated = false;
  for (const op of d.ops) {
    n += op[1]?.length || 0;
    if (n > OPS_CHARS && op[0] !== "…") {
      ops.push(["…"]);
      truncated = true;
      break;
    }
    ops.push(op);
  }
  return { change: "modified", diff: ops, truncated, level: d.level };
}

/**
 * Order-preserving match of two key sequences (longest common subsequence, common prefix and suffix cut first).
 * Ceiling: a middle larger than 4M cells is matched greedily by key in order (it can miss a better alignment, never invents a match).
 * Returns {mapA, mapB}: index in the other sequence, or -1.
 */
export function lcsPairs(a, b) {
  const mapA = new Int32Array(a.length).fill(-1);
  const mapB = new Int32Array(b.length).fill(-1);
  const link = (i, j) => ((mapA[i] = j), (mapB[j] = i));
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) (link(p, p), p++);
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) (link(a.length - 1 - s, b.length - 1 - s), s++);
  const n = a.length - p - s;
  const m = b.length - p - s;
  if (!n || !m) return { mapA, mapB };
  if (n * m > 4_000_000) {
    const at = new Map();
    for (let i = p; i < p + n; i++) (at.get(a[i]) || at.set(a[i], []).get(a[i])).push(i);
    const ptr = new Map();
    let last = p - 1;
    for (let j = p; j < p + m; j++) {
      const list = at.get(b[j]);
      if (!list) continue;
      let k = ptr.get(b[j]) || 0;
      while (k < list.length && list[k] <= last) k++;
      ptr.set(b[j], k);
      if (k < list.length) (link(list[k], j), (last = list[k]), ptr.set(b[j], k + 1));
    }
    return { mapA, mapB };
  }
  const w = m + 1;
  const T = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) T[i * w + j] = a[p + i] === b[p + j] ? Math.min(65535, T[(i + 1) * w + j + 1] + 1) : Math.max(T[(i + 1) * w + j], T[i * w + j + 1]);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[p + i] === b[p + j]) (link(p + i, p + j), i++, j++);
    else if (T[(i + 1) * w + j] >= T[i * w + j + 1]) i++;
    else j++;
  }
  return { mapA, mapB };
}

// ---- DOCX -------------------------------------------------------------------------------------------------------------

const words = (t, n = 8) => {
  const w = normText(t).split(" ").filter(Boolean);
  if (w.length === 1 && w[0].length > 40) return `${w[0].slice(0, 40)}…`;
  return w.slice(0, n).join(" ") + (w.length > n ? "…" : "");
};
const docxLabel = (p) => {
  const text = words(p.text.replace(/￼/g, "[object]"));
  const where = p.path?.length >= 4 ? `Table ${p.tableNo ?? p.path[0] + 1}, row ${p.path[1] + 1}, col ${p.path[2] + 1}` : "";
  const quoted = text ? `“${text}”` : "";
  return untrusted([where, quoted || (where ? "" : "Empty paragraph")].filter(Boolean).join(": "), 140);
};
const docxLocator = (p) => (p ? { format: "docx", body_path: p.path ?? null, para_id: p.paraId ?? null, text_hash: p.hash, ordinal: p.ordinal, text_start: clean(normText(p.text), 160) } : null);
export const docxFmt = (p) => ({ props: p.fmt, style: p.style, styleName: p.styleName, align: p.align });

/**
 * Paragraph identity between two versions of a document, the one rule every pairing of DOCX paragraphs follows (History, both sides
 * of the merge, redline, voice). A paragraph id (w14:paraId) that is unique in its version is the paragraph's identity: a text match
 * may never pair it with a paragraph other than the one carrying that id on the other side, and no paragraph is paired with one that
 * carries the id of another paragraph. Text and order decide where ids are absent or duplicated, and where an id is found in one
 * version only (it says nothing about the other: a re-save that gave every paragraph a new id still reads as unchanged). `strict` (the
 * agent's side of the merge): a paragraph with an id of its own that the other version, which has ids, does not have at all was
 * removed or rebuilt, and is paired with nothing.
 * Returns {may, keyA, keyB}: `may(i, j)` says whether A[i] and B[j] may be the same paragraph; `keyA` and `keyB` are LCS keys (the
 * text hash, then "#" and the id when that id is unique in both versions) so that order matching links no two paragraphs that
 * different ids tell apart.
 */
export function paraIdentity(A, B, { strict = false } = {}) {
  const tally = (L) => {
    const m = new Map();
    for (const p of L) if (p.paraId) m.set(p.paraId, (m.get(p.paraId) || 0) + 1);
    return m;
  };
  const inA = tally(A);
  const inB = tally(B);
  const may = (i, j) => {
    const a = A[i].paraId || null;
    const b = B[j].paraId || null;
    if (a === b) return true; // the same id, or neither has one
    const ownA = a && inA.get(a) === 1;
    const ownB = b && inB.get(b) === 1;
    if (ownA && (inB.has(a) || (strict && inB.size))) return false; // A[i] is the paragraph with its id there; strict: or it is gone
    if (ownB && inA.has(b)) return false; // the same from B's side
    if ((b && inA.get(b) === 1) || (a && inB.get(a) === 1)) return false; // it carries the id of another paragraph
    return true; // ids absent, duplicated, or found on one side only (a re-save that renumbered every id): text and order decide
  };
  const sure = (id, own, other) => (id && own.get(id) === 1 && other.get(id) === 1 ? id : "");
  return {
    may,
    keyA: A.map((p) => `${p.hash}#${sure(p.paraId, inA, inB)}`),
    keyB: B.map((p) => `${p.hash}#${sure(p.paraId, inB, inA)}`),
  };
}

/**
 * Match paragraphs the way the durable anchors resolve, under the identity rule of paraIdentity: same text in order (LCS on the text
 * hash, ids told apart), the same unique id (moved when the text is the same), the same text moved elsewhere, then the best similar
 * unmatched paragraph (>= 0.3 alone in its gap, >= 0.5 within a gap, >= 0.6 anywhere), all under a work budget. No step pairs two
 * paragraphs the ids tell apart. Returns {mapA, mapB, moved}.
 */
export function matchParagraphs(A, B, { strict = false } = {}) {
  const { may, keyA, keyB } = paraIdentity(A, B, { strict });
  const { mapA, mapB } = lcsPairs(keyA, keyB);
  // keys equal by text with no shared id can still be two different identities (ids unique on both sides, present on one only)
  for (let i = 0; i < A.length; i++) if (mapA[i] >= 0 && !may(i, mapA[i])) ((mapB[mapA[i]] = -1), (mapA[i] = -1));
  const lcsMapB = Int32Array.from(mapB);
  const moved = new Set();
  const link = (i, j) => ((mapA[i] = j), (mapB[j] = i));
  // the same unique id on both sides: the same paragraph, wherever it is; out of the order matched above with the same text, moved
  const idOf = (k) => k.slice(k.indexOf("#") + 1); // "" when the id does not decide
  const idAt = new Map();
  keyA.forEach((k, i) => mapA[i] < 0 && idOf(k) && idAt.set(idOf(k), i));
  keyB.forEach((k, j) => {
    const i = mapB[j] < 0 && idOf(k) ? idAt.get(idOf(k)) : undefined;
    if (i === undefined) return;
    link(i, j);
    if (A[i].hash === B[j].hash) moved.add(j);
  });
  const long = (p) => normText(p.text).length >= 20; // short or empty texts repeat: a "move" of one would be a coincidence
  const queue = new Map();
  A.forEach((p, i) => mapA[i] < 0 && long(p) && (queue.get(p.hash) || queue.set(p.hash, []).get(p.hash)).push(i));
  // Ceiling: candidates the ids rule out are skipped within a budget for the whole pass (many copies of one long text, each with an id
  // of its own the other version does not have, would make the search quadratic); past it, the remaining candidates are not tried.
  let tries = 100_000;
  B.forEach((p, j) => {
    const q = mapB[j] < 0 && queue.get(p.hash);
    const k = q ? q.findIndex((i) => tries-- > 0 && may(i, j)) : -1;
    if (k >= 0) (link(q.splice(k, 1)[0], j), moved.add(j));
  });
  let budget = 20_000; // similarity calls in all
  const sim = (i, j) => (may(i, j) && budget-- > 0 ? similarity(A[i].text.slice(0, 600), B[j].text.slice(0, 600)) : 0);
  // gap pass: unmatched paragraphs between the same two matched neighbors
  const prevA = new Int32Array(B.length);
  const nextA = new Int32Array(B.length);
  let last = -1;
  for (let j = 0; j < B.length; j++) (prevA[j] = last, lcsMapB[j] >= 0 && (last = lcsMapB[j]));
  last = A.length;
  for (let j = B.length - 1; j >= 0; j--) (nextA[j] = last, lcsMapB[j] >= 0 && (last = lcsMapB[j]));
  const openB = new Map();
  B.forEach((_, j) => mapB[j] < 0 && openB.set(prevA[j], (openB.get(prevA[j]) || 0) + 1));
  let gapPrev = -2;
  let floor = -1;
  for (let j = 0; j < B.length; j++) {
    if (budget <= 0) break; // no similarity left to link with: listing the candidates of every paragraph of a long gap was quadratic
    if (mapB[j] >= 0) continue;
    if (prevA[j] !== gapPrev) (gapPrev = prevA[j], (floor = prevA[j]));
    const cand = [];
    for (let i = Math.max(floor, prevA[j]) + 1; i < nextA[j]; i++) if (mapA[i] < 0) cand.push(i);
    const thr = cand.length === 1 && openB.get(prevA[j]) === 1 ? 0.3 : 0.5;
    let best = -1;
    let bestS = thr - 1e-9;
    for (const i of cand) {
      const v = sim(i, j);
      if (v > bestS) (best = i, (bestS = v));
    }
    if (best >= 0) (link(best, j), (floor = best));
  }
  // anywhere pass: an edited paragraph that also moved
  const freeA = [];
  A.forEach((_, i) => mapA[i] < 0 && freeA.push(i));
  const freeB = [];
  B.forEach((_, j) => mapB[j] < 0 && freeB.push(j));
  if (freeA.length * freeB.length <= 40_000) {
    for (const j of freeB) {
      let best = -1;
      let bestS = 0.6 - 1e-9;
      for (const i of freeA) {
        if (mapA[i] >= 0) continue;
        const v = sim(i, j);
        if (v > bestS) (best = i, (bestS = v));
      }
      if (best >= 0) link(best, j);
    }
  }
  return { mapA, mapB, moved };
}

function compareDocx(A, B, out) {
  const { mapA, mapB, moved } = matchParagraphs(A, B);
  const items = [];
  B.forEach((b, j) => {
    const i = mapB[j];
    if (i < 0) return normText(b.text) && items.push({ key: j, kind: "added", b });
    const a = A[i];
    if (moved.has(j)) items.push({ key: j, kind: "moved", a, b });
    else if (a.hash !== b.hash) items.push({ key: j, kind: "modified", a, b });
    else if (a.text !== b.text) items.push({ key: j, kind: "spacing", a, b });
    else if (normText(b.text)) {
      const note = fmtNote(docxFmt(a), docxFmt(b));
      if (note) items.push({ key: j, kind: "format", a, b, note });
    }
  });
  A.forEach((a, i) => {
    if (mapA[i] >= 0 || !normText(a.text)) return;
    let k = i + 1;
    while (k < A.length && mapA[k] < 0) k++;
    items.push({ key: k < A.length ? mapA[k] - 0.5 : Infinity, kind: "removed", a });
  });
  items.sort((x, y) => x.key - y.key);
  for (const it of items) {
    if (it.kind === "added") out.add("added", () => place({ format: "docx", label: docxLabel(it.b), locator: docxLocator(it.b), change: "added", text: clean(it.b.text, TEXT_CAP), protected: it.b.protected }));
    else if (it.kind === "removed") out.add("removed", () => place({ format: "docx", label: docxLabel(it.a), locator: null, change: "removed", text: clean(it.a.text, TEXT_CAP), protected: it.a.protected }));
    else if (it.kind === "moved") out.add("changed", () => place({ format: "docx", label: docxLabel(it.b), locator: docxLocator(it.b), change: "moved", note: "moved", protected: it.b.protected }));
    else if (it.kind === "format") out.add("changed", () => place({ format: "docx", label: docxLabel(it.b), locator: docxLocator(it.b), change: "formatting", note: clean(it.note, 120), protected: it.b.protected }));
    else if (it.kind === "spacing") out.add("changed", () => place({ format: "docx", label: docxLabel(it.b), locator: docxLocator(it.b), change: "formatting", note: "spacing changed", protected: it.b.protected }));
    else out.add("changed", () => place({ format: "docx", label: docxLabel(it.b), locator: docxLocator(it.b), protected: it.b.protected || it.a.protected, ...textChange(it.a.text, it.b.text) }));
  }
}

// ---- XLSX -------------------------------------------------------------------------------------------------------------

const cellValue = (c) => (c ? { value: c.k === "formula" ? (c.cached == null || c.cached === "" ? null : clean(c.cached, TEXT_CAP)) : clean(c.text, TEXT_CAP), formula: c.k === "formula" ? clean(c.text.slice(1), TEXT_CAP) : null } : null);
const xlsxLocator = (sheet, range, c) => ({ format: "xlsx", sheet: clean(sheet.name, 100), sheet_id: /^\d{1,10}$/.test(String(sheet.sheetId ?? "")) ? String(sheet.sheetId) : null, range, text_hash: c ? exactHash(c.text) : null });
const rowSig = (row) => row.cells.map((c) => `${c.c}:${ch(c)}`).join("|");
const rowRange = (row) => a1Range({ r0: row.r, c0: row.cells[0].c, r1: row.r, c1: row.cells[row.cells.length - 1].c });
const rowText = (row) => clean(row.cells.map((c) => c.text).join(" | "), TEXT_CAP);
/** How alike two rows are, 0..1; a row whose leftmost cell (its label) is unchanged counts as the same row even when its numbers changed */
function overlap(x, y) {
  const m = new Map(y.cells.map((c) => [c.c, c.text]));
  let same = 0;
  for (const c of x.cells) if (m.get(c.c) === c.text) same++;
  const label = x.cells[0].c === y.cells[0].c && x.cells[0].text === y.cells[0].text;
  return Math.max(same / Math.max(x.cells.length, y.cells.length, 1), label ? 0.5 : 0);
}

/** A cell whose text is the same but whose number format is not: compared as the format text (resolved through styles.xml), never the style index, which writers renumber. */
function formatChange(wbA, wbB, sheet, rb, old, c, out) {
  if (c.k === "text" || old.k === "text") return; // a number format does not change how text reads
  const fa = wbA.numberFormat(old.s);
  const fb = wbB.numberFormat(c.s);
  if (fa !== fb) out.add("changed", () => place({ format: "xlsx", label: `${clean(sheet.name, 60)}!${a1(rb.r, c.c)}`, locator: xlsxLocator(sheet, a1(rb.r, c.c), c), change: "formatting", note: clean(`number format: ${fa} → ${fb}`, 120) }));
}

function compareSheet(sheet, rowsA, rowsB, out, wbA, wbB) {
  const { mapA, mapB } = lcsPairs(rowsA.map(rowSig), rowsB.map(rowSig));
  const pairRows = (ra, rb) => {
    const m = new Map(ra.cells.map((c) => [c.c, c]));
    const seen = new Set();
    for (const c of rb.cells) {
      seen.add(c.c);
      const old = m.get(c.c);
      if (!old) out.add("added", () => place({ format: "xlsx", label: `${clean(sheet.name, 60)}!${a1(rb.r, c.c)}`, locator: xlsxLocator(sheet, a1(rb.r, c.c), c), change: "added", text: clean(c.text, TEXT_CAP), after: cellValue(c) }));
      else if (old.text !== c.text) out.add("changed", () => place({ format: "xlsx", label: `${clean(sheet.name, 60)}!${a1(rb.r, c.c)}`, locator: xlsxLocator(sheet, a1(rb.r, c.c), c), change: "modified", before: cellValue(old), after: cellValue(c) }));
      else formatChange(wbA, wbB, sheet, rb, old, c, out);
    }
    for (const c of ra.cells) if (!seen.has(c.c)) out.add("removed", () => place({ format: "xlsx", label: `${clean(sheet.name, 60)}!${a1(rb.r, c.c)}`, locator: null, change: "removed", text: clean(c.text, TEXT_CAP), before: cellValue(c) }));
  };
  const added = (rb) => out.add("added", () => place({ format: "xlsx", label: `${clean(sheet.name, 60)}!${rowRange(rb)}`, locator: xlsxLocator(sheet, rowRange(rb), rb.cells[0]), change: "added", text: rowText(rb) }));
  const removed = (ra) => out.add("removed", () => place({ format: "xlsx", label: `${clean(sheet.name, 60)}!${rowRange(ra)}`, locator: null, change: "removed", text: rowText(ra) }));
  // walk the gaps between matched rows: a lone row on both sides is an edit in place, otherwise rows pair in order by overlap
  let i = 0;
  let j = 0;
  const gap = (i1, j1) => {
    const ga = [];
    for (let x = i; x < i1; x++) ga.push(x);
    const gb = [];
    for (let y = j; y < j1; y++) gb.push(y);
    if (ga.length === 1 && gb.length === 1) return pairRows(rowsA[ga[0]], rowsB[gb[0]]);
    let from = 0;
    for (const y of gb) {
      let hit = -1;
      for (let k = from; k < Math.min(ga.length, from + 5); k++) if (overlap(rowsA[ga[k]], rowsB[y]) >= 0.4) (hit = k, (k = ga.length));
      if (hit < 0) added(rowsB[y]);
      else {
        for (let k = from; k < hit; k++) removed(rowsA[ga[k]]);
        pairRows(rowsA[ga[hit]], rowsB[y]);
        from = hit + 1;
      }
    }
    for (let k = from; k < ga.length; k++) removed(rowsA[ga[k]]);
  };
  for (let y = 0; y < rowsB.length; y++) {
    if (mapB[y] < 0) continue;
    gap(mapB[y], y);
    // identical row text: only the number format of a cell can differ
    const ra = rowsA[mapB[y]];
    ra.cells.forEach((old, k) => formatChange(wbA, wbB, sheet, rowsB[y], old, rowsB[y].cells[k], out));
    i = mapB[y] + 1;
    j = y + 1;
  }
  gap(rowsA.length, rowsB.length);
}

function compareXlsx(wbA, wbB, out) {
  const claimed = new Set();
  const namesB = new Map(); // sheet name -> how many sheets of B have it, counted once (MAX_SHEETS bounds the scans by name)
  for (const y of wbB.sheets) namesB.set(y.name, (namesB.get(y.name) || 0) + 1);
  const sheetLabel = (s) => `Sheet "${clean(s.name, 60)}"`;
  for (const sb of wbB.sheets) {
    const sa = wbA.sheets.find((x) => x.name === sb.name && !claimed.has(x)) || wbA.sheets.find((x) => x.sheetId === sb.sheetId && !claimed.has(x) && !(namesB.get(x.name) > (x.name === sb.name ? 1 : 0)));
    if (!sa) {
      out.add("added", () => place({ format: "xlsx", label: sheetLabel(sb), locator: xlsxLocator(sb, "", null), change: "added", note: "sheet added" }));
      continue;
    }
    claimed.add(sa);
    compareSheet(sb, sheetRows(wbA, sa), sheetRows(wbB, sb), out, wbA, wbB);
  }
  for (const sa of wbA.sheets) if (!claimed.has(sa)) out.add("removed", () => place({ format: "xlsx", label: sheetLabel(sa), locator: null, change: "removed", note: "sheet removed" }));
}

// ---- PPTX -------------------------------------------------------------------------------------------------------------

const KIND_NOTE = { shape: "a shape", image: "an image", table: "a table or chart", group: "a group of shapes", line: "a line" };
const shapeLabel = (sl, sh) => untrusted(`Slide ${sl.index + 1}, ${sh.isTitle ? "Title" : sh.name ? sh.name : `shape ${sh.id}`}`, 100);
const shapeLocator = (sl, sh) => ({ format: "pptx", slide_id: /^\d{1,10}$/.test(String(sl.id ?? "")) ? String(sl.id) : null, slide_index: sl.index, shape_id: sh ? sh.id : null, text_hash: sh ? sh.hash : null });
const slideLabel = (sl) => untrusted(`Slide ${sl.index + 1}${sl.title ? `, "${words(sl.title, 8)}"` : ""}`, 100);
const slideText = (sl) => clean(sl.shapes.map((x) => x.text).filter(Boolean).join(" / "), TEXT_CAP);

function compareDeck(DA, DB, out) {
  DA.ensure();
  DB.ensure();
  const sid = (s) => s.id ?? `#${s.index}`;
  const idsA = DA.slides.map(sid);
  const idsB = DB.slides.map(sid);
  const { mapB } = lcsPairs(idsA, idsB);
  const inA = new Map(DA.slides.map((s) => [sid(s), s]));
  for (const sb of DB.slides) {
    const sa = inA.get(sid(sb));
    if (!sa) {
      out.add("added", () => place({ format: "pptx", label: slideLabel(sb), locator: shapeLocator(sb, null), change: "added", text: slideText(sb), note: "slide added" }));
      continue;
    }
    if (mapB[sb.index] < 0) out.add("changed", () => place({ format: "pptx", label: slideLabel(sb), locator: shapeLocator(sb, null), change: "moved", note: `slide moved from position ${sa.index + 1} to ${sb.index + 1}` }));
    compareShapes(sa, sb, out);
  }
  const inB = new Set(DB.slides.map(sid));
  for (const sa of DA.slides) if (!inB.has(sid(sa))) out.add("removed", () => place({ format: "pptx", label: slideLabel(sa), locator: null, change: "removed", text: slideText(sa), note: "slide removed" }));
}

function compareShapes(sa, sb, out) {
  const key = (x) => `${x.id}#${x.ordinal}`;
  const mapA = new Map(sa.shapes.map((x) => [key(x), x]));
  const used = new Set();
  const unmatchedB = [];
  for (const sh of sb.shapes) {
    const old = mapA.get(key(sh));
    if (old) (used.add(old), pair(old, sh));
    else unmatchedB.push(sh);
  }
  // by name and kind among the shapes left unpaired, grouped once (a scan of every shape per shape was quadratic on a slide of many shapes)
  const nk = (x) => `${x.kind}\u0000${x.name}`;
  const groupsA = new Map();
  for (const x of sa.shapes) if (!used.has(x)) (groupsA.get(nk(x)) || groupsA.set(nk(x), new Set()).get(nk(x))).add(x);
  const countB = new Map();
  for (const x of unmatchedB) countB.set(nk(x), (countB.get(nk(x)) || 0) + 1);
  for (const sh of unmatchedB) {
    const cand = sh.name ? groupsA.get(nk(sh)) : null;
    if (cand?.size === 1 && countB.get(nk(sh)) === 1) {
      const [old] = cand;
      cand.delete(old);
      used.add(old);
      pair(old, sh);
    } else out.add("added", () => place({ format: "pptx", label: shapeLabel(sb, sh), locator: shapeLocator(sb, sh), change: "added", text: sh.text ? clean(sh.text, TEXT_CAP) : null, note: sh.text ? null : `${KIND_NOTE[sh.kind] || "an object"} was added` }));
  }
  const leftA = sa.shapes.filter((x) => !used.has(x));
  for (const sh of leftA) out.add("removed", () => place({ format: "pptx", label: shapeLabel(sa, sh), locator: null, change: "removed", text: sh.text ? clean(sh.text, TEXT_CAP) : null, note: sh.text ? null : `${KIND_NOTE[sh.kind] || "an object"} was removed` }));
  function pair(old, sh) {
    if (old.hash === sh.hash) {
      const note = sh.text ? fmtNote({ props: old.fmt }, { props: sh.fmt }) : null;
      if (note) out.add("changed", () => place({ format: "pptx", label: shapeLabel(sb, sh), locator: shapeLocator(sb, sh), change: "formatting", note: clean(note, 120) }));
      return;
    }
    out.add("changed", () => place({ format: "pptx", label: shapeLabel(sb, sh), locator: shapeLocator(sb, sh), ...textChange(old.text, sh.text) }));
  }
}

// ---- HTML -------------------------------------------------------------------------------------------------------------
// A text-level diff by element (PLAN-html 2a): the units of each version (elements that hold text directly, and images and other leaves,
// src/html.js) matched by tag and own text in order; a pair left between two matches with the same tag is a change of its text, the rest
// added or removed. Link and image targets that appeared or went away are listed too, as plain text (R1): an agent may change a link.

const htmlUnitText = (u) => (u.kind === "leaf" ? `${u.tag} ${u.node.attrs.find((a) => a.name === "alt")?.value ?? ""}`.trim() : ownText(u.node));
const htmlLabel = (u) => untrusted(`${safeTag(u.tag)}${u.htmlId ? ` #${u.htmlId}` : ""}`, 100);
const htmlLocator = (read, u) => ({ format: "html", node_id: u.nodeId, path: pathString(elementPath(u.node)), element_id: u.htmlId ?? null, text_hash: ownHash(u.node) });

function compareHtml(RA, RB, out) {
  const key = (u) => `${u.tag}\u0000${exactHash(htmlUnitText(u))}`;
  const A = RA.units;
  const B = RB.units;
  const { mapA, mapB } = lcsPairs(A.map(key), B.map(key));
  // walk the gaps between matched pairs: same-tag units across a gap pair up in order (a changed text), the rest are added or removed
  let i = 0;
  let j = 0;
  const flushGap = (iEnd, jEnd) => {
    const gapA = [];
    const byTag = new Map();
    for (let x = i; x < iEnd; x++) {
      if (mapA[x] >= 0) continue;
      const ua = A[x];
      gapA.push(ua);
      let entry = byTag.get(ua.tag);
      if (!entry) byTag.set(ua.tag, (entry = { list: [], idx: 0 }));
      entry.list.push(ua);
    }
    const used = new Set();
    for (let y = j; y < jEnd; y++) {
      if (mapB[y] >= 0) continue;
      const ub = B[y];
      const entry = byTag.get(ub.tag);
      const ua = entry && entry.idx < entry.list.length ? entry.list[entry.idx++] : null;
      if (ua) {
        used.add(ua);
        out.add("changed", () => place({ format: "html", label: htmlLabel(ub), locator: htmlLocator(RB, ub), ...textChange(htmlUnitText(ua), htmlUnitText(ub)) }));
      } else out.add("added", () => place({ format: "html", label: htmlLabel(ub), locator: htmlLocator(RB, ub), change: "added", text: clean(normText(htmlUnitText(ub)), TEXT_CAP) || null, note: ub.kind === "leaf" ? `${safeTag(ub.tag)} added` : null }));
    }
    for (const ua of gapA) if (!used.has(ua)) out.add("removed", () => place({ format: "html", label: htmlLabel(ua), locator: null, change: "removed", text: clean(normText(htmlUnitText(ua)), TEXT_CAP) || null, note: ua.kind === "leaf" ? `${safeTag(ua.tag)} removed` : null }));
  };
  for (let y = 0; y <= B.length; y++) {
    if (y < B.length && mapB[y] < 0) continue;
    const x = y < B.length ? mapB[y] : A.length;
    flushGap(x, y);
    i = x + 1;
    j = y + 1;
  }
  const d = inventoryDelta(inventory(RA.doc), inventory(RB.doc)).links;
  const what = (e) => (e.kind === "link" ? "Link" : "Image or style");
  for (const e of d.added) out.add("changed", () => place({ format: "html", label: untrusted(`${what(e)} target`, 60), locator: null, change: "link", note: clean(`now points to ${e.url}`, 300) }));
  for (const e of d.removed) out.add("changed", () => place({ format: "html", label: untrusted(`${what(e)} target`, 60), locator: null, change: "link", note: clean(`no longer points to ${e.url}`, 300) }));
}

/** Compare two versions of one format: {counts: {changed, added, removed}, places: [...] | null, more}. Pure; runs in the worker. */
export function compareBytes(format, before, after, { places = false } = {}) {
  const out = new Out(places);
  const A = parse(format, before);
  const B = parse(format, after);
  if (format === "docx") compareDocx(A.paragraphs, B.paragraphs, out);
  else if (format === "xlsx") compareXlsx(A.wb, B.wb, out);
  else if (format === "pptx") compareDeck(A.deck, B.deck, out);
  else if (format === "html") compareHtml(A.read, B.read, out);
  else unknownFormat(format, "compareBytes");
  return { counts: out.counts, places: out.places, more: out.places ? out.total - out.places.length : 0 };
}

// ---- cache and worker ---------------------------------------------------------------------------------------------------

const ZERO = { counts: { changed: 0, added: 0, removed: 0 }, places: [], more: 0 };
const cacheName = (u) => `${u.before.slice(0, 32)}_${u.after.slice(0, 32)}.json`;
const cacheFile = (s, u) => path.join(sub("history", s.key), cacheName(u));

function readCache(s, u, needPlaces) {
  try {
    const j = JSON.parse(fs.readFileSync(cacheFile(s, u), "utf8"));
    if (j.v === CACHE_VERSION && j.format === s.format && j.counts && (!needPlaces || Array.isArray(j.places))) return j;
  } catch {}
  return null;
}
function writeCache(s, u, result) {
  try {
    // The list (counts only) and a detail (counts and places) of the same pair can be computed at the same time and share this file.
    // The one that finishes last must not replace places with nothing: a file that already holds places is kept.
    if (!Array.isArray(result.places) && readCache(s, u, true)) return;
    writeStateFile(cacheFile(s, u), JSON.stringify({ v: CACHE_VERSION, format: s.format, ...result })); // 0600 like every state file
  } catch {} // a cache that cannot be written only costs time
}

/** One worker thread for a batch of comparisons, so a large document never blocks the server. A worker that fails or times out gives {ok:false}. */
function runInWorker(jobs) {
  return new Promise((resolve) => {
    let settled = false;
    let worker;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker?.terminate();
      resolve(r);
    };
    const failAll = (why) => finish(jobs.map(() => ({ ok: false, error: why })));
    const timer = setTimeout(() => failAll("timed out"), WORKER_TIMEOUT_MS());
    try {
      worker = startWorker("history-worker.js", { workerData: { jobs } });
    } catch (err) {
      return failAll(String(err?.message || err));
    }
    worker.once("message", (m) => finish(m));
    worker.once("error", (err) => failAll(String(err?.message || err)));
    worker.once("exit", (code) => failAll(`the worker exited (${code})`));
  });
}

const inflight = new Map(); // cache file + mode -> Promise<result>

/** Results (from cache, from a running job, or computed) for [{u, places}]; each is {counts, places, more} or {error}. */
async function ensure(s, wanted) {
  const results = new Array(wanted.length);
  const waits = [];
  const need = [];
  wanted.forEach((w, idx) => {
    if (w.u.before === w.u.after) return (results[idx] = ZERO);
    const hit = readCache(s, w.u, w.places);
    if (hit) return (results[idx] = hit);
    const k = `${cacheFile(s, w.u)}${w.places ? "#p" : ""}`;
    if (inflight.has(k)) return waits.push(inflight.get(k).then((r) => (results[idx] = r)));
    need.push({ idx, k, w });
  });
  if (need.length) {
    const batch = runInWorker(need.map(({ w }) => ({ format: s.format, before: s.snapshots.blob(w.u.before), after: s.snapshots.blob(w.u.after), places: w.places }))).then((arr) =>
      arr.map((r, i) => {
        if (!r.ok) return { error: r.error || "failed" };
        writeCache(s, need[i].w.u, r.result);
        return r.result;
      })
    );
    need.forEach((n, pos) => {
      const pr = batch.then((arr) => arr[pos]);
      inflight.set(n.k, pr);
      pr.finally(() => inflight.delete(n.k)).catch(() => {});
      waits.push(pr.then((r) => (results[n.idx] = r)));
    });
  }
  await Promise.all(waits);
  return results;
}

/** Updates the page may show: newest first, at most 20, only those whose both snapshots are still stored (retention follows the snapshot cap). */
export function visibleUpdates(s) {
  const snaps = s.snapshots;
  if (!snaps) return [];
  return (s.history || []).filter((u) => snaps.has(u.before) && snaps.has(u.after)).slice(-LIST_LIMIT).reverse();
}

const iso = (ms) => new Date(ms).toISOString();
const head = (u) => ({ id: u.id, kind: u.kind, at: iso(u.at), title: u.kind === "revert" && u.local ? REVERT_LOCAL_TITLE : TITLES[u.kind], summary: u.kind === "agent" || u.kind === "local" ? untrusted(u.summary, 400) : "" });

function pruneCache(s) {
  try {
    const keep = new Set((s.history || []).map(cacheName));
    const dir = sub("history", s.key);
    for (const f of fs.readdirSync(dir)) if (f.endsWith(".json") && !keep.has(f)) fs.rmSync(path.join(dir, f), { force: true });
  } catch {}
}

/** `GET /api/history`: ids, kinds, times, titles and counts. `counts` is null when a version could not be compared. */
export async function historyList(s) {
  const vis = visibleUpdates(s);
  const res = await ensure(s, vis.map((u) => ({ u, places: false })));
  pruneCache(s);
  return {
    format: s.format,
    limit: LIST_LIMIT,
    untrusted: true,
    note: UNTRUSTED_NOTE,
    updates: vis.map((u, i) => ({ ...head(u), counts: res[i].counts ?? null, ...(res[i].error ? { unavailable: true } : {}) })),
  };
}

/**
 * `GET /api/history/all`: the net change from the oldest stored version to the file as it is now (a change that was reverted does not show).
 * One synthetic pair through the same compare as any update. Its cache file is dropped by the next list (pruneCache keeps only real updates),
 * so it is recomputed per click, in the worker: fine for a button. `unavailable` when the snapshot of the current version is gone.
 */
async function changeSince(s) {
  const vis = visibleUpdates(s);
  const base = { format: s.format, untrusted: true, note: UNTRUSTED_NOTE };
  if (!vis.length) return { ...base, since: null, counts: { ...ZERO.counts }, places: [], more: 0 };
  const oldest = vis[vis.length - 1];
  const since = { at: iso(oldest.at) };
  const tip = s.histTip ?? s.baseSha;
  if (!tip || !s.snapshots.has(tip)) return { ...base, since, counts: null, places: [], more: 0, unavailable: true };
  const [r] = await ensure(s, [{ u: { before: oldest.before, after: tip }, places: true }]);
  return { ...base, since, counts: r.counts ?? null, places: r.places ?? [], more: r.more ?? 0, ...(r.error ? { unavailable: true } : {}) };
}

/** `GET /api/history/:id`: one update with its places; null when there is no such update (or its snapshots were pruned). `all`: see changeSince. */
export async function historyDetail(s, id) {
  if (id === "all") return changeSince(s);
  const u = visibleUpdates(s).find((x) => x.id === id);
  if (!u) return null;
  const [r] = await ensure(s, [{ u, places: true }]);
  return {
    ...head(u),
    format: s.format,
    untrusted: true,
    note: UNTRUSTED_NOTE,
    counts: r.counts ?? null,
    places: r.places ?? [],
    more: r.more ?? 0,
    after_is_current: u.after === (s.histTip ?? s.baseSha), // the locators are in terms of this update's AFTER version
    ...(r.error ? { unavailable: true } : {}),
  };
}

/** Fire and forget after an update is recorded, so the next list is served from the cache. */
export const warm = (s) => historyList(s).catch(() => {});

/**
 * Fire and forget after `done`: computes the places of the newest update when it is an agent run (or a run on this Mac), so the page's "changes shown in place" finds the
 * detail cached. Only the newest visible update counts (a revert or an outside change after it makes it stale); any failure only costs time.
 */
export const warmNewest = (s) => {
  const u = visibleUpdates(s)[0];
  if (!u || (u.kind !== "agent" && u.kind !== "local")) return Promise.resolve();
  return historyDetail(s, u.id).catch(() => {});
};
