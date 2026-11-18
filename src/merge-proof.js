import { paraIdentity } from "./history.js";
import { byFormat } from "./constants.js";
import { readDocxParagraphs } from "./docx.js";
import { parseDeck } from "./pptx.js";
import { parseWorkbook } from "./xlsx.js";
import { untrusted } from "./sanitize.js";
import { Interner, cellStyles, docxUnits, lookCarried, lookLooseSame, numberingOf, partLabel, readPackage, residueCarried, residueLooseSame, sameLookKept, sameResidue, sameStored, sharedRich, sheetUnits, slideUnits, twinSame, unitCarried, unitLooseSame, unitSame, sameVolatile, looseSame } from "./merge-package.js";

// The proof of a merge (src/merge-worker.js runs it after every merge, before anything is written or returned). The planners
// (src/merge.js, src/merge-pptx.js, src/merge-xlsx.js) decide what to carry; this file checks the outcome on its own terms, from the
// raw content of the four versions: base (what the page loaded), mine (the person's), theirs (the agent's) and the merged result read
// back from its bytes (theirs when the merge wrote nothing). It shares only the readers and the paragraph identity rule
// (paraIdentity in src/history.js) with the planners: no matcher, no hash of normalized text, no report of the engine.
//
// Every difference between base and mine (raw text with every space, tab and line break as written, the formatting the planner
// claims to carry, order, inserts and deletes with their multiplicity) must be in exactly one of two states: in the merged result at
// the same identity, or handed back in `unplaced` by an entry that names it (`of`: the refs below) and, for text, holds the text.
// A kind of change the merge does not carry is no exception: it must be handed back too. The other direction holds as well: nothing
// in the result may read differently from the agent's version except where the person's change was carried, and nothing the agent
// wrote may be missing. When the accounting does not balance, the merge returns no file (the caller's existing "could not be merged"
// outcome: nothing is written, the person's edits stay in the page and a copy of their version is saved).
//
// Refs (set by the planners on each unplaced entry as `of`, stripped before the answer leaves the worker):
//   DOCX  "m<n>" paragraph n of mine, "b<n>" paragraph n of base (n: the reader's ordinal)
//   PPTX  "s<slide id>" a slide, "h<slide id>/<shape key>" a shape on it, "order" the order of slides
//   XLSX  "S<sheet key>" a sheet, "c<sheet key>!<cell key>" a cell, "sheets" the list of sheets
// An entry for a whole slide or sheet covers text only when the merge also keeps a copy of the person's file (`copy`).
//
// Complete by construction (src/merge-package.js): beyond the units modeled one by one above, every part of the package is compared
// whole between the versions (headers, footers, footnotes, comments, styles, lists, media, charts, relationships, properties...), the
// main parts outside their units too (tables and sections, a slide's background, a sheet's columns, rows and merged ranges), and each
// unit's residue: whatever its canonical XML holds beyond what is modeled (a paragraph's objects and other properties, a shape's place,
// size and geometry, a cell's whole style). Equal means equal canonical XML; the few attributes the engine rewrites on its own
// (VOLATILE, measured) are judged by one rule (src/merge-package.js sameVolatile): a difference between base and mine is the person's. A difference of a kind no planner carries is handed back by handBack (src/merge-worker.js
// runs it before the proof: one plain entry per kind, and a copy of the person's file); one it cannot name refuses the merge. The proof
// works from the bytes of the four versions and the merge's answer only: never from the page's list of edits.
//
// Cost: linear in the size of the four versions, except the longest increasing subsequence that tells moved paragraphs and shapes
// from the rest (n log n). The merged result is read once more (the planners' readings are not reused for it, so nothing they did to
// them counts); the package is read once for handBack and the proof together (prepareMerge). A part or slide or sheet whose stored
// bytes are the same between base and mine and between theirs and the result is not read at all.

const CAP = 2000; // the planners cut the text of an unplaced entry here (src/merge.js, src/merge-pptx.js, src/merge-xlsx.js)

/**
 * Does the text of an unplaced entry hold `want`: all of it, or the first CAP characters when the planner cut it and the person's
 * file is kept (`copy`: the rest is only there; src/merge-worker.js keeps one whenever an entry's text was cut).
 */
const holds = (got, want, copy) => typeof got === "string" && (got === want || (want.length > CAP && copy && got.startsWith(want.slice(0, CAP))));

/**
 * An index of the unplaced entries by ref, and the check that a difference is handed back: by an entry that names the unit and, for
 * text, holds it; or by an entry that names the whole slide or sheet (`box`), which holds text only when the person's file is kept.
 */
function handedBack(unplaced, copy) {
  // entries that say a kind (`as`, src/merge-proof.js handBack) cover that kind only, never text, a move or anything else
  const by = new Map();
  const byKind = new Map();
  for (const u of unplaced || []) for (const ref of Array.isArray(u?.of) ? u.of : []) {
    const into = u.as ? byKind : by;
    (into.get(ref) || into.set(ref, []).get(ref)).push(u);
  }
  /**
   * refs: the unit's own refs; text: what must be shown (null: nothing to show); box: the slide or sheet a whole entry may name; look:
   * the difference is formatting, the one thing a line that only asks to check (`check: true`, said of an edit that WAS carried) covers
   */
  const back = (refs, text = null, box = null, look = false) => {
    for (const ref of refs) for (const u of by.get(ref) || []) if ((look || !u.check) && (text === null || holds(u.text, text, copy))) return true;
    return !!(box && by.has(box) && (copy || text === null));
  };
  /**
   * A difference of a kind the planners do not carry (src/merge-package.js: "look", formatting; any other kind: an object, a shape's
   * place or size, a table's layout, a part): handed back by an entry that names the unit and says that kind (`as`), or for formatting
   * by any entry that names the unit; or by an entry for the whole slide or sheet when the person's file is kept.
   */
  back.kind = (refs, kind, box = null) => {
    for (const ref of refs) {
      for (const u of byKind.get(ref) || []) if (u.as === kind) return true;
      if (kind === "look" && by.has(ref)) return true;
    }
    return !!(box && by.has(box) && copy);
  };
  /**
   * named by an entry for the whole slide or sheet that says this kind of change (a planner's "You changed formatting on the sheet"),
   * which covers it once the person's file is kept: handBack then asks for the copy instead of a second line
   */
  const SAYS = { look: /formatting/i, layout: /row or column sizes|layout/i, shape: /shape/i };
  back.boxed = (box, kind) => !!(box && SAYS[kind] && (by.get(box) || []).some((u) => !u.check && SAYS[kind].test(u.why ?? "")));
  return back;
}

/** The tally of what did not balance; `fail` is a short reason with counts, never document text. */
class Tally {
  /** `noun`: what a unit is in this format (paragraphs, shapes, cells) */
  constructor(noun) {
    this.noun = noun;
    this.kinds = new Map();
  }
  add(kind) {
    kind = kind.replace(/\bunits\b/g, this.noun);
    this.kinds.set(kind, (this.kinds.get(kind) || 0) + 1);
  }
  get fail() {
    if (!this.kinds.size) return null;
    return [...this.kinds].map(([k, n]) => `${k}: ${n}`).join("; ");
  }
}

/** Longest increasing subsequence of `seq` (numbers): a Uint8Array marking the members of one. n log n. */
function lis(seq) {
  const tails = [];
  const tailAt = [];
  const prev = new Int32Array(seq.length).fill(-1);
  for (let k = 0; k < seq.length; k++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tails[mid] < seq[k]) lo = mid + 1;
      else hi = mid;
    }
    tails[lo] = seq[k];
    tailAt[lo] = k;
    prev[k] = lo > 0 ? tailAt[lo - 1] : -1;
  }
  const keep = new Uint8Array(seq.length);
  for (let k = tails.length ? tailAt[tails.length - 1] : -1; k >= 0; k = prev[k]) keep[k] = 1;
  return keep;
}

/**
 * The three-way accounting over one list of units (DOCX paragraphs, the shapes of one slide). Units are {raw, ref, parts: {name:
 * value}}; `bm`, `bt`, `tr` pair base with mine, base with theirs, theirs with the result (Int32Array, -1: none). `ordered`: the order
 * of the list is content (a move is a difference). `runs(u)` (DOCX): the run formatting of a unit by character, or null.
 */
function account({ B, M, T, R, bm, bt, tr, ordered, box = null, runs = null, twin = null }, back, tally) {
  // mine's run formatting in the result: the same, or the engine's paired property (twinSame) where it reads the same
  const sameMine = (m, r) => sameRuns(m, r, runs, twin);
  const inv = (map, n) => {
    const out = new Int32Array(n).fill(-1);
    map.forEach((j, i) => j >= 0 && (out[j] = i));
    return out;
  };
  const mb = inv(bm, M.length);
  const tb = inv(bt, T.length);
  const rt = inv(tr, R.length);
  const need = (refs, text, kind) => back(refs, text, box, kind.includes("formatting")) || tally.add(kind);
  const partNames = (u) => Object.keys(u.parts);
  const shown = (u) => u.show ?? u.raw; // the text an entry handed back must hold

  // Where an added unit belongs. The result's index of mine's unit j, when base, theirs and the result all have it:
  const fullR = new Int32Array(M.length).fill(-1);
  for (let j = 0; j < M.length; j++) {
    const x = mb[j];
    if (x >= 0 && bt[x] >= 0 && tr[bt[x]] >= 0) fullR[j] = tr[bt[x]];
  }
  // An added unit is in its place when the unit of the result right before it (other added units and the agent's new ones skipped) is
  // the unit before it in mine, or the one right after it is the unit after it in mine. A neighbor in mine that the merge hands back
  // (its move or its text is the person's to redo) has no settled place: then any unit back to the nearest one not handed back counts.
  const toMine = new Int32Array(R.length).fill(-1);
  for (let j = 0; j < M.length; j++) if (fullR[j] >= 0) toMine[fullR[j]] = j;
  const prevFull = new Int32Array(R.length);
  const nextFull = new Int32Array(R.length);
  for (let r = 0, last = -1; r < R.length; r++) (prevFull[r] = last), toMine[r] >= 0 && (last = toMine[r]);
  for (let r = R.length - 1, last = M.length; r >= 0; r--) (nextFull[r] = last), toMine[r] >= 0 && (last = toMine[r]);
  const lo = new Int32Array(M.length);
  const hi = new Int32Array(M.length);
  const settled = (j) => fullR[j] >= 0 && !back([M[j].ref], null, box);
  for (let j = 0, last = -1; j < M.length; j++) (lo[j] = last), settled(j) && (last = j);
  for (let j = M.length - 1, last = M.length; j >= 0; j--) (hi[j] = last), settled(j) && (last = j);
  const inPlace = (j, r) => !ordered || (prevFull[r] < j && prevFull[r] >= lo[j]) || (nextFull[r] > j && nextFull[r] <= hi[j]);
  const group = (L, ok) => {
    const g = new Map();
    L.forEach((u, n) => ok(n) && (g.get(u.raw) || g.set(u.raw, []).get(u.raw)).push(n));
    return g;
  };
  const added = group(M, (j) => mb[j] < 0); // the person's additions, by text
  const fresh = group(R, (r) => rt[r] < 0); // the units the merge added, by text
  const agentNew = group(T, (t) => tb[t] < 0);
  // A unit rewritten whole has no identity left where it carries no id: a rewrite may be carried as a new unit in place of the old one,
  // and a deletion next to an addition as the addition written into the deleted unit. Either counts when the text is the person's and
  // the place is the person's (`take` claims the unit and the addition once).
  const claimed = new Set(); // indexes in R of units claimed as the person's
  const carried = new Set(); // indexes in M of additions claimed as carried
  // the first entry of `list` that `ok` accepts; entries already claimed at its head are skipped once, not on every call (many units
  // rewritten into one same text stay linear). Ceiling: an entry `ok` refuses for its place is tried again by the next call.
  const head = new Map();
  const take = (list, ok) => {
    if (!list) return -1;
    let k = head.get(list) || 0;
    while (k < list.length && (claimed.has(list[k]) || carried.has(list[k]))) k++;
    head.set(list, k);
    for (; k < list.length; k++) if (ok(list[k])) return list[k];
    return -1;
  };

  for (let x = 0; x < B.length; x++) {
    const b = B[x];
    const m = bm[x];
    const t = bt[x];
    let r = t >= 0 ? tr[t] : -1;
    const refs = m >= 0 ? [M[m].ref, b.ref] : [b.ref];
    const pText = m >= 0 && M[m].raw !== b.raw;
    const pDel = m < 0;
    const aText = t >= 0 && T[t].raw !== b.raw;
    let rewritten = false; // the person's text is in a unit the merge added in place of this one
    if (t >= 0) {
      if (r < 0) {
        // gone from the result: a deletion of the person's of a unit the agent left as it was, or the person's rewrite carried as a new unit
        const n = pText && !aText ? take(fresh.get(M[m].raw), (n) => !claimed.has(n) && inPlace(m, n)) : -1;
        if (n >= 0) (claimed.add(n), (r = n), (rewritten = true));
        else if (!(pDel && !aText)) tally.add("the agent's units missing from the result");
      } else if (R[r].raw !== T[t].raw && !(pText && !aText && R[r].raw === M[m].raw)) {
        // the result changed the agent's unit: to the person's text, or to an addition of the person's written in place of a deletion
        const j = pDel && !aText ? take(added.get(R[r].raw), (j) => !carried.has(j) && inPlace(j, r)) : -1;
        if (j >= 0) {
          carried.add(j);
          // the unit now is the person's addition: its formatting is the addition's
          if (partNames(M[j]).some((k) => R[r].parts[k] !== M[j].parts[k]) || (runs && !sameMine(M[j], R[r]))) need([M[j].ref], null, "formatting of added units neither carried nor handed back");
          continue;
        }
        tally.add("the agent's units changed into text neither side wrote there");
      }
      const kept = r >= 0 && R[r].raw === T[t].raw;
      if (pText && kept && M[m].raw !== T[t].raw) {
        // the rewrite carried as a new unit next to the old one, which stays (a deletion not carried, so it must be said)
        const n = take(fresh.get(M[m].raw), (n) => !claimed.has(n) && inPlace(m, n));
        if (n >= 0) (claimed.add(n), need(refs, null, "deletions neither carried nor handed back"));
        else need(refs, shown(M[m]), "text edits neither carried nor handed back");
      }
      if (pDel && r >= 0 && R[r].raw === T[t].raw) need(refs, null, "deletions neither carried nor handed back");
    } else if (pText) {
      // the agent removed the unit: the person's text handed back, or carried as a new unit in its place
      const n = take(fresh.get(M[m].raw), (n) => !claimed.has(n) && inPlace(m, n));
      if (n >= 0) claimed.add(n);
      else need(refs, shown(M[m]), "text edits of units the agent removed, not handed back");
    }
    // formatting the person changed: in the result (or the agent set the same), else handed back; the agent's own formatting is kept
    for (const k of partNames(b)) {
      const changed = m >= 0 && M[m].parts[k] !== b.parts[k];
      const got = r >= 0 ? R[r].parts[k] : undefined;
      // the place of a paragraph (the body, or which table and which cell) is no formatting: a line that only asks to check never covers it
      if ((changed || rewritten) && got !== M[m].parts[k]) need(refs, null, k === "box" ? "moves into another table or cell neither carried nor handed back" : "formatting changes neither carried nor handed back");
      if (r >= 0 && !rewritten && got !== T[t].parts[k] && !(changed && got === M[m].parts[k] && T[t].parts[k] === b.parts[k])) tally.add("formatting changes in the result that neither side made");
    }
    if (rewritten) {
      if (runs && !sameMine(M[m], R[r])) need(refs, null, "formatting changes neither carried nor handed back");
    } else if (runs && m >= 0 && r >= 0) runsCheck(b, M[m], T[t], R[r], refs, need, tally, runs, twin);
    else if (runs && m >= 0 && runChanged(b, M[m], runs)) need(refs, null, "formatting changes neither carried nor handed back");
    else if (runs && r >= 0 && !sameRuns(T[t], R[r], runs)) tally.add("formatting changes in the result that neither side made");
  }
  // what the agent added is in the result as it wrote it, formatting included
  for (let t = 0; t < T.length; t++) {
    if (tb[t] >= 0) continue;
    const r = tr[t];
    if (r < 0 || R[r].raw !== T[t].raw) tally.add("the agent's new units missing from the result");
    else if (partNames(T[t]).some((k) => R[r].parts[k] !== T[t].parts[k]) || (runs && !sameRuns(T[t], R[r], runs))) tally.add("formatting changes in the result that neither side made");
  }
  // what the person added: in the result, in its place, once per copy; or handed back. A unit of the result that is in neither the
  // agent's version nor among the person's additions is text nobody wrote.
  for (const [raw, rs] of fresh) if (rs.filter((n) => !claimed.has(n)).length > (added.get(raw)?.filter((j) => !carried.has(j)).length || 0)) tally.add("units in the result that neither side wrote");
  for (const [raw, js] of added) {
    const rs = (fresh.get(raw) || []).filter((n) => !claimed.has(n));
    let same = agentNew.get(raw)?.length || 0; // the agent added the same text: the person's copy may be that one
    let k = 0;
    for (const j of js) {
      if (carried.has(j)) continue;
      const r = k < rs.length ? rs[k++] : -1;
      if (r >= 0 && inPlace(j, r)) {
        for (const name of partNames(M[j])) if (R[r].parts[name] !== M[j].parts[name]) need([M[j].ref], null, "formatting of added units neither carried nor handed back");
        if (runs && !sameMine(M[j], R[r])) need([M[j].ref], null, "formatting of added units neither carried nor handed back");
        continue;
      }
      if (back([M[j].ref], shown(M[j]), box)) continue;
      if (r < 0 && same > 0) {
        same--;
        continue;
      }
      tally.add(r >= 0 ? "added units out of place" : "added units neither carried nor handed back");
    }
  }
  if (ordered) orderCheck({ M, mb, bt, fullR }, back, box, tally);
}

/**
 * Order: of the units base, mine, theirs and the result all have, the person moved those outside a longest run kept in base order. The
 * rest keep the agent's order in the result; a moved one sits next to the neighbor it has in mine (before or after it), or is handed
 * back. Which units moved is ambiguous (of two swapped, either one did): the order balances when it balances for one of four choices, the
 * latest or the earliest longest run, over all of them or over those the merge does not hand back (a move it named is then the move).
 */
function orderCheck({ M, mb, bt, fullR }, back, box, tally) {
  const js = [];
  for (let j = 0; j < M.length; j++) if (fullR[j] >= 0) js.push(j);
  const covered = js.map((j) => back([M[j].ref], null, box));
  const order = js.map((j) => fullR[j]).sort((a, b) => a - b);
  const at = new Map(order.map((r, k) => [r, k]));
  // a longest run kept in base order, the latest one (`late`) or the earliest one (found on the sequence reversed and negated)
  const movedBy = (pool, late) => {
    const seq = pool.map((k) => mb[js[k]]);
    const keep = late ? lis(seq) : lis(seq.reverse().map((v) => -v)).reverse();
    return new Set(pool.filter((_, n) => !keep[n]));
  };
  /** the kinds that do not balance when the units at these indexes of js are the ones the person moved */
  const judge = (moved) => {
    const bad = [];
    const byT = js.map((j, k) => ({ k, t: bt[mb[j]], r: fullR[j] })).filter((x) => !moved.has(x.k));
    byT.sort((a, b) => a.t - b.t);
    for (let n = 1; n < byT.length; n++) if (byT[n].r < byT[n - 1].r && !covered[byT[n].k] && !covered[byT[n - 1].k]) {
      bad.push("units out of the agent's order");
      break;
    }
    for (const k of moved) {
      const k2 = at.get(fullR[js[k]]);
      const before = k > 0 ? fullR[js[k - 1]] : -1;
      const after = k < js.length - 1 ? fullR[js[k + 1]] : -1;
      if (before === (k2 > 0 ? order[k2 - 1] : -1) || after === (k2 < order.length - 1 ? order[k2 + 1] : -1) || covered[k]) continue;
      bad.push("moves neither carried nor handed back");
    }
    return bad;
  };
  const all = js.map((_, k) => k);
  const free = all.filter((k) => !covered[k]);
  const first = judge(movedBy(all, true));
  if (!first.length || [movedBy(all, false), movedBy(free, true), movedBy(free, false)].some((moved) => !judge(moved).length)) return;
  for (const kind of first) tally.add(kind);
}

// ---- DOCX ------------------------------------------------------------------------------------------------------------------------

// A paragraph's style, alignment and list as written (src/merge-package.js docxUnits `mod`: the canonical w:pStyle, w:jc and
// w:numPr), the list's w:numId written out as the definition it names (numberingOf). A style by its id: the definitions are compared
// where they are written, in word/styles.xml (an outside review: two lists of the same kind, or a style named the same, read as the
// same before). Ceiling: whether a list paragraph continues the numbering of the one before it is not compared, since it depends on
// the other side's lists too (a numbered paragraph the agent adds above renumbers the person's, measured: comparing it refused that
// ordinary merge); a list restarted on the same definition is not seen. Upgrade path: compare it only against the list paragraphs
// base, mine and the result all have.
const NUM_ID = /<\{[^}]*\}numId \{[^}]*\}val="([^"]*)"><\/>/;
const docxLists = (units, numbering) => units.map((u) => (u.mod["w:numPr"] ? u.mod["w:numPr"].replace(NUM_ID, (_m, v) => `<numId ${numbering(v)}>`) : ""));
// where a paragraph is: the body, or which table (counted over the whole document, nested ones too), row and cell, at every depth
// (src/merge-package.js docxUnits: two paragraphs in cell 0 0 of two different tables are in two different places)
const docxUnit = (p, side, u, list) => ({ raw: p.text, ref: `${side}${p.ordinal}`, parts: { box: u.box || "body", style: u.mod["w:pStyle"] ?? "", align: u.mod["w:jc"] ?? "", list, ppr: p.ppr || "" }, look: u.look });

/** Run formatting by character (src/merge-package.js docxUnits: every run property, as written, interned): an Int32Array. */
const looks = (u) => u.look;
/** `twin(want, got, ch)`: mine's run formatting `want` reads as `got` on character `ch` (twinSame); null: only equal counts */
const sameRuns = (a, b, runs, twin = null) => {
  const x = runs(a);
  const y = runs(b);
  return x.length === y.length && x.every((v, k) => v === y[k] || (twin !== null && twin(v, y[k], a.raw[k])));
};
/** Did the run formatting change from `b` to `m`, on the characters both have (the common start and end of their texts)? */
function runChanged(b, m, runs) {
  const x = runs(b);
  const y = runs(m);
  const { p, s } = ends(b.raw, m.raw);
  for (let k = 0; k < p; k++) if (x[k] !== y[k]) return true;
  for (let k = 1; k <= s; k++) if (x[x.length - k] !== y[y.length - k]) return true;
  return false;
}
function ends(a, b) {
  let p = 0;
  const max = Math.min(a.length, b.length);
  while (p < max && a[p] === b[p]) p++;
  let s = 0;
  while (s < max - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  return { p, s };
}
/**
 * Run formatting by character, three ways. Where the person's text is in the result and the agent left the text alone, each character
 * of the result has the person's formatting where the person changed it (or typed it), else the agent's. Anything else the person
 * changed is handed back; a character of the agent's whose formatting changed otherwise is a change nobody made.
 */
function runsCheck(b, m, t, r, refs, need, tally, runs, twin = null) {
  const changed = runChanged(b, m, runs);
  const [xb, xm, xt, xr] = [b, m, t, r].map(runs);
  if (r.raw === t.raw && (r.raw !== m.raw || t.raw !== b.raw || !changed)) {
    // nothing of the person's landed in this unit's text: its formatting is the agent's
    if (!sameRuns(t, r, runs)) tally.add("formatting changes in the result that neither side made");
    if (changed && !(t.raw === m.raw && sameRuns(t, m, runs))) need(refs, null, "formatting changes neither carried nor handed back");
    return;
  }
  if (r.raw !== m.raw || t.raw !== b.raw) return; // a text change of the result that the text accounting already judged
  if (!xb || !xm || !xt || !xr) {
    if (!sameRuns(m, r, runs) && changed) need(refs, null, "formatting changes neither carried nor handed back");
    return;
  }
  const { p, s } = ends(b.raw, m.raw);
  let bad = false;
  let foreign = false;
  for (let k = 0; k < m.raw.length; k++) {
    const kb = k < p ? k : k >= m.raw.length - s ? b.raw.length - (m.raw.length - k) : -1; // the base character it is, or -1: typed
    const mineSet = kb < 0 || xm[k] !== xb[kb];
    const want = mineSet ? xm[k] : xt[kb];
    if (xr[k] === want || (mineSet && twin !== null && twin(want, xr[k], m.raw[k]))) continue;
    if (mineSet) bad = true;
    else foreign = true;
  }
  if (bad) need(refs, null, "formatting changes neither carried nor handed back");
  if (foreign) tally.add("formatting changes in the result that neither side made");
}
/** Pairs of DOCX paragraphs: a paragraph id unique on both sides first, then the same raw text in order where the ids allow it. */
function pairDocx(A, B, strict) {
  const { may } = paraIdentity(A, B, { strict });
  const ab = new Int32Array(A.length).fill(-1);
  const ba = new Int32Array(B.length).fill(-1);
  const tally = (L) => {
    const m = new Map();
    for (const p of L) if (p.paraId) m.set(p.paraId, (m.get(p.paraId) || 0) + 1);
    return m;
  };
  const [ca, cb] = [tally(A), tally(B)];
  const at = new Map();
  B.forEach((p, j) => p.paraId && cb.get(p.paraId) === 1 && ca.get(p.paraId) === 1 && at.set(p.paraId, j));
  A.forEach((p, i) => {
    const j = p.paraId ? at.get(p.paraId) : undefined;
    if (j !== undefined) (ab[i] = j), (ba[j] = i);
  });
  const byText = new Map();
  B.forEach((p, j) => ba[j] < 0 && (byText.get(p.text) || byText.set(p.text, []).get(p.text)).push(j));
  const next = new Map();
  A.forEach((p, i) => {
    if (ab[i] >= 0) return;
    const list = byText.get(p.text);
    const k = next.get(p.text) || 0;
    if (!list || k >= list.length || !may(i, list[k])) return;
    (ab[i] = list[k]), (ba[list[k]] = i);
    next.set(p.text, k + 1);
  });
  // then an id that several paragraphs carry (one copied with it), in order: the same id still says more than nothing
  const byId = new Map();
  B.forEach((p, j) => ba[j] < 0 && p.paraId && (byId.get(p.paraId) || byId.set(p.paraId, []).get(p.paraId)).push(j));
  const nextId = new Map();
  A.forEach((p, i) => {
    if (ab[i] >= 0 || !p.paraId) return;
    const list = byId.get(p.paraId);
    const k = nextId.get(p.paraId) || 0;
    if (!list || k >= list.length) return;
    (ab[i] = list[k]), (ba[list[k]] = i);
    nextId.set(p.paraId, k + 1);
  });
  // last, a paragraph rewritten in place (where the ids allow it strictly: an id of its own that the other side, which has ids, lacks
  // was removed): a run of unpaired paragraphs between two paired neighbors that face a run of the same length
  // between the same neighbors on the other side are those paragraphs, in order (without this, a paragraph whose text changed and that
  // carries no id would be a deletion and an insertion, and a change of its formatting could not be followed)
  const sure = strict ? may : paraIdentity(A, B, { strict: true }).may;
  let i0 = -1;
  for (let i = 0; i <= A.length; i++) {
    if (i < A.length && ab[i] < 0) continue;
    const j0 = i0 < 0 ? -1 : ab[i0];
    const j1 = i < A.length ? ab[i] : B.length;
    if (i - i0 > 1 && j1 - j0 === i - i0) {
      let free = true;
      for (let j = j0 + 1; j < j1 && free; j++) free = ba[j] < 0;
      for (let k = 1; free && k < i - i0; k++) free = sure(i0 + k, j0 + k);
      if (free) for (let k = 1; k < i - i0; k++) (ab[i0 + k] = j0 + k), (ba[j0 + k] = i0 + k);
    }
    i0 = i;
  }
  return ab;
}

/** The four versions of a DOCX merge read once, for the proof and for handBack: paragraphs, pairs and the package. */
function prepareDocx({ base, mine, theirs, merged, read = null }) {
  const reading = (bytes) => readDocxParagraphs(bytes, { detail: true });
  const [pb, pm, pt] = read ? [read.base, read.mine, read.theirs] : [base, mine, theirs].map(reading);
  const pr = merged === theirs ? pt : reading(merged);
  const pk = packages(base, mine, theirs, merged);
  const I = new Interner();
  const U = pk.map((P, n) => (n === 3 && merged === theirs ? null : docxUnits(P.text("word/document.xml"), I)));
  U[3] ||= U[2];
  const L = [pb, pm, pt, pr];
  // the package reading lists the paragraphs as the reader does; when it does not (a document it reads otherwise), nothing is proven
  const whole = U.every((u, n) => u.paras.length === L[n].length && u.paras.every((x, k) => x.text === L[n][k].text));
  return { L, pk, U, I, whole, bm: pairDocx(pb, pm, false), bt: pairDocx(pb, pt, true), tr: pairDocx(pt, pr, true) };
}

export function proveDocx(args) {
  const ctx = args.ctx ?? prepareDocx(args);
  const tally = new Tally("paragraphs");
  if (!ctx.whole) {
    tally.add("documents the proof could not read in full");
    return tally.fail;
  }
  const back = handedBack(args.unplaced, args.copy);
  const [B, M, T, R] = ctx.L.map((L, n) => {
    const lists = docxLists(ctx.U[n].paras, numberingOf(ctx.pk[n].text("word/numbering.xml")));
    return L.map((p, k) => docxUnit(p, "bmtr"[n], ctx.U[n].paras[k], lists[k]));
  });
  const twin = (want, got, ch) => twinSame(ctx.I, want, got, ch);
  account({ B, M, T, R, bm: ctx.bm, bt: ctx.bt, tr: ctx.tr, ordered: true, runs: looks, twin }, back, tally);
  restDocx(ctx, new Sink(back, tally));
  return tally.fail;
}

// ---- PPTX ------------------------------------------------------------------------------------------------------------------------

const sid = (s) => String(s.id ?? `#${s.index}`);
const shapeKey = (sh) => `${sh.id}#${sh.ordinal}`;

/** Pairs by key: `keyOf` gives each unit's key; a key found more than once on a side pairs nothing. */
function pairByKey(A, B, keyOf) {
  const count = (L) => L.reduce((m, u) => m.set(keyOf(u), (m.get(keyOf(u)) || 0) + 1), new Map());
  const [ca, cb] = [count(A), count(B)];
  const at = new Map();
  B.forEach((u, j) => cb.get(keyOf(u)) === 1 && at.set(keyOf(u), j));
  return Int32Array.from(A, (u) => (ca.get(keyOf(u)) === 1 && at.has(keyOf(u)) ? at.get(keyOf(u)) : -1));
}

function preparePptx({ base, mine, theirs, merged, read = null }) {
  const deck = (bytes) => {
    const d = parseDeck(bytes);
    d.ensure();
    return d;
  };
  const three = read ? [read.base, read.mine, read.theirs] : [base, mine, theirs].map(deck);
  return { decks: [...three, merged === theirs ? three[2] : deck(merged)].map((d) => d.slides), pk: packages(base, mine, theirs, merged), I: new Interner(), merged, theirs };
}

export function provePptx(args) {
  const ctx = args.ctx ?? preparePptx(args);
  const decks = ctx.decks;
  const [B, M, T, R] = decks;
  const copy = !!args.copy;
  const back = handedBack(args.unplaced, copy);
  const tally = new Tally("shapes");
  const by = (L) => new Map(L.map((s) => [sid(s), s]));
  const [inB, inM, inT, inR] = decks.map(by);
  // slides: the person's added, removed and moved slides are never carried, so each one is handed back; the agent's slide list is
  // the result's
  if (T.map(sid).join(" ") !== R.map(sid).join(" ")) tally.add("slide lists in the result different from the agent's");
  for (const s of M) if (!inB.has(sid(s)) && !(back([`s${sid(s)}`], null) && (copy || !s.shapes.some((x) => x.text)))) tally.add("added slides not handed back");
  for (const s of B) if (!inM.has(sid(s)) && !back([`s${sid(s)}`], null)) tally.add("removed slides not handed back");
  const common = (L, other) => L.map(sid).filter((x) => inB.has(x) && inM.has(x) && other.has(x));
  if (common(B, inM).join(" ") !== common(M, inB).join(" ") && !back(["order"], null)) tally.add("slide moves not handed back");
  const unit = (side, s) => (sh) => ({ raw: sh.text, ref: side === "b" || side === "m" ? `h${sid(s)}/${shapeKey(sh)}` : "", parts: { fmt: JSON.stringify(sh.fmt ?? null), name: sh.name, kind: sh.kind, placeholder: sh.placeholder ?? "" }, key: shapeKey(sh) });
  for (const b of B) {
    const m = inM.get(sid(b));
    if (!m) continue;
    const t = inT.get(sid(b));
    const r = t ? inR.get(sid(b)) : null;
    const box = `s${sid(b)}`;
    const U = [["b", b], ["m", m], ["t", t], ["r", r]].map(([side, s]) => (s ? s.shapes.map(unit(side, s)) : []));
    const key = (u) => u.key;
    account({ B: U[0], M: U[1], T: U[2], R: U[3], bm: pairByKey(U[0], U[1], key), bt: pairByKey(U[0], U[2], key), tr: pairByKey(U[2], U[3], key), ordered: true, box }, back, tally);
  }
  // the agent's slides that base or mine lack are in the result as the agent wrote them
  for (const t of T) {
    if (inB.has(sid(t)) && inM.has(sid(t))) continue;
    const r = inR.get(sid(t));
    if (!r || r.shapes.map((x) => `${shapeKey(x)} ${x.text}`).join("\n") !== t.shapes.map((x) => `${shapeKey(x)} ${x.text}`).join("\n")) tally.add("the agent's slides changed in the result");
  }
  agentOnly(ctx, T, R, (t) => inB.has(sid(t)) && inM.has(sid(t)), new Sink(back, tally), "the agent's slides changed in the result");
  restPptx(ctx, new Sink(back, tally));
  return tally.fail;
}

/**
 * A slide or sheet of the agent's that base or mine lack (or that the person removed): the merge never writes into it, so the result
 * holds its part as the agent wrote it, everything in it (not its text alone), but for VOLATILE.
 */
function agentOnly(ctx, T, R, inside, sink, words) {
  const [, , PT, PR] = ctx.pk;
  if (PT === PR) return;
  for (const t of T) {
    if (inside(t) || !t.part) continue;
    const r = R.find((x) => x.part === t.part);
    if (!r) continue; // missing: the list checks count it
    if (sameStored(PT, PR, t.part)) continue;
    const [ut, ur] = [PT.units(t.part), PR.units(t.part)];
    if (!ut || !ur) continue;
    for (const k of new Set([...ut.keys(), ...ur.keys()])) if (!unitLooseSame(ut.get(k), ur.get(k))) return void sink.foreign(words);
  }
}

// ---- XLSX ------------------------------------------------------------------------------------------------------------------------

const sheetKey = (s) => `${s.sheetId} ${s.name}`;

function prepareXlsx({ base, mine, theirs, merged, read = null }) {
  const three = read ? [read.base, read.mine, read.theirs] : [base, mine, theirs].map(parseWorkbook);
  return { books: [...three, merged === theirs ? three[2] : parseWorkbook(merged)], pk: packages(base, mine, theirs, merged), merged, theirs };
}

export function proveXlsx(args) {
  const ctx = args.ctx ?? prepareXlsx(args);
  const books = ctx.books;
  const [B, M, T, R] = books;
  const copy = !!args.copy;
  const back = handedBack(args.unplaced, copy);
  const tally = new Tally("cells");
  const by = (wb) => new Map(wb.sheets.map((s) => [sheetKey(s), s]));
  const [inB, inM, inT, inR] = books.map(by);
  if (T.sheets.map(sheetKey).join("\n") !== R.sheets.map(sheetKey).join("\n")) tally.add("sheet lists in the result different from the agent's");
  for (const s of M.sheets) if (!inB.has(sheetKey(s)) && !(back([`S${sheetKey(s)}`], null) && (copy || !M.sheetCells(s).cells.size))) tally.add("added or renamed sheets not handed back");
  for (const s of B.sheets) if (!inM.has(sheetKey(s)) && !back([`S${sheetKey(s)}`], null)) tally.add("removed or renamed sheets not handed back");
  const common = (wb, other) => wb.sheets.map(sheetKey).filter((k) => inB.has(k) && other.has(k));
  if (common(B, inM).join("\n") !== common(M, inB).join("\n") && !back(["sheets"], null)) tally.add("sheet moves not handed back");
  for (const b of B.sheets) {
    const m = inM.get(sheetKey(b));
    // as written: hidden and very hidden (shown only by a macro) are two states
    if (m && b.state !== m.state && !back(["sheets", `S${sheetKey(b)}`], null)) tally.add("sheets hidden or shown, not handed back");
  }
  // Cells, by address (the cell is its address on every side: a row or column inserted shows as the cells that changed), each one
  // three ways as in account(), in one pass without a list per sheet (a sheet holds up to a million cells): the value as written (a
  // formula as its text) and the number format.
  const value = (c) => (!c ? "" : c.shared ? "\u0001shared" : `${c.k}\u0001${c.text}`);
  for (const b of B.sheets) {
    const m = inM.get(sheetKey(b));
    if (!m) continue;
    const k = sheetKey(b);
    const box = `S${k}`;
    const t = inT.get(k);
    const r = t ? inR.get(k) : null;
    const [cb, cm, ct, cr] = [[B, b], [M, m], [T, t], [R, r]].map(([wb, s]) => (s ? wb.sheetCells(s).cells : null));
    if ([[B, b], [M, m], [T, t], [R, r]].some(([wb, s]) => s && wb.sheetCells(s).truncated)) {
      if (!back([box], null)) tally.add("sheets too large to check, not handed back");
      continue;
    }
    if (JSON.stringify(B.sheetCells(b).merges) !== JSON.stringify(M.sheetCells(m).merges) && !back([box], null) && !back.kind([box], "layout", box)) tally.add("merged cells changed, not handed back");
    const cell = (at) => {
      const [xb, xm, xt, xr] = [cb, cm, ct, cr].map((c) => c?.get(at));
      const [vb, vm, vt, vr] = [xb, xm, xt, xr].map(value);
      const refs = [`c${k}!${at}`];
      const pText = vm !== vb;
      if (ct && cr) {
        const aText = vt !== vb;
        if (vr !== vt && !(pText && !aText && vr === vm)) tally.add("the agent's cells changed into values neither side wrote there");
        if (pText && vr === vt && vm !== vt && !back(refs, xm?.text ?? "", box)) tally.add("value edits neither carried nor handed back");
      } else if (pText && !back(refs, xm?.text ?? "", box)) tally.add("value edits on sheets the agent removed, not handed back");
      // the number format, where the cell holds a value on each side compared (a value typed into an empty cell takes the format the
      // engine gives it)
      if (!xt || !xr) return;
      const [fb, fm, ft, fr] = [[B, xb], [M, xm], [T, xt], [R, xr]].map(([wb, c]) => (c ? wb.numberFormat(c.s) : null));
      const changed = xb && xm && fb !== fm;
      if (changed && fr !== fm && !back(refs, null, box)) tally.add("number formats neither carried nor handed back");
      if (fr !== ft && !(changed && fr === fm && ft === fb)) tally.add("number formats in the result that neither side set");
    };
    for (const at of cb.keys()) cell(at);
    for (const at of cm.keys()) if (!cb.has(at)) cell(at);
    if (ct) for (const at of ct.keys()) if (!cb.has(at) && !cm.has(at)) cell(at);
    if (cr) for (const at of cr.keys()) if (!cb.has(at) && !cm.has(at) && !ct?.has(at)) cell(at);
  }
  for (const t of T.sheets) {
    if (inB.has(sheetKey(t)) && inM.has(sheetKey(t))) continue;
    const r = inR.get(sheetKey(t));
    const cells = (wb, s) => [...wb.sheetCells(s).cells].map(([at, c]) => `${at} ${value(c)}`).join("\n");
    if (!r || cells(T, t) !== cells(R, r)) tally.add("the agent's sheets changed in the result");
  }
  agentOnly(ctx, T.sheets, R.sheets, (t) => inB.has(sheetKey(t)) && inM.has(sheetKey(t)), new Sink(back, tally), "the agent's sheets changed in the result");
  restXlsx(ctx, new Sink(back, tally));
  return tally.fail;
}

// ---- the rest: every part of the package, the layout of the main parts, and every unit's residue ----------------------------------
// (src/merge-package.js reads them.) Each difference between base and mine is in the result or handed back by an entry that names the
// unit and its kind (`as`); every other difference in the result is one the agent made. The same code serves handBack (each difference
// not yet handed back becomes an entry) and the proof (each one is a reason to refuse).

/** Where the rest checks report: the proof tallies, handBack collects entries. */
class Sink {
  constructor(back, tally, entries = null) {
    this.back = back;
    this.tally = tally;
    this.entries = entries;
  }
  covered(refs, kind, box = null) {
    if (this.back.kind(refs, kind, box)) return true;
    // handBack: the planner already said it for the whole slide or sheet ("You changed formatting on the sheet ...") but kept no copy:
    // the copy is what is missing, not a second line saying the same thing (a browser test found the bold of one cell said twice)
    if (this.entries && this.back.boxed(box, kind)) return (this.entries.copy = true);
    return false;
  }
  /** a difference of the person's neither in the result nor handed back: `words` for the proof, `entry` for handBack */
  lost(words, entry) {
    if (this.entries) this.entries.push({ text: "", ...entry });
    else this.tally.add(words);
  }
  /** a difference in the result that neither side made: only the proof counts it (handBack cannot hand back what is not the person's) */
  foreign(words) {
    if (!this.entries) this.tally.add(words);
  }
}

/** The four packages of a merge; the result is the agent's package when the merge wrote nothing. */
function packages(base, mine, theirs, merged) {
  const three = [base, mine, theirs].map(readPackage);
  return [...three, merged === theirs ? three[2] : readPackage(merged)];
}

const NONE = new Map();
/** A reading kept in the merge's context, so handBack and the proof read each part of each version once. */
const memo = (ctx, key, read) => {
  ctx.memo ||= new Map();
  if (!ctx.memo.has(key)) ctx.memo.set(key, read());
  return ctx.memo.get(key);
};
const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const AFTER = "That change could not be merged; it is still in your copy.";

/**
 * Every part outside the main ones (`main(name)`), unit by unit (src/merge-package.js keyedUnits; `skip(name)` names the children a
 * main check models, such as the slide list): a part the person changed is in the result as theirs or handed back, one entry per kind
 * of part; any other difference between the agent's part and the result's is one nobody made.
 */
function partsCheck(pk, main, skip, sink, strip = () => null) {
  const [B, M, T, R] = pk;
  const lostBy = new Map(); // label -> refs
  for (const name of new Set([...B.names, ...M.names, ...T.names, ...R.names])) {
    if (main(name)) continue;
    const same = (P, Q) => P === Q || (!P.has(name) && !Q.has(name)) || sameStored(P, Q, name);
    if (same(B, M) && same(T, R)) continue;
    const sk = skip(name);
    const [ub, um, ut, ur] = pk.map((P) => P.units(name, sk, strip(name)) ?? NONE);
    let lost = false;
    let odd = false;
    for (const k of new Set([...ub.keys(), ...um.keys(), ...ut.keys(), ...ur.keys()])) {
      const [b, m, t, r] = [ub, um, ut, ur].map((u) => u.get(k));
      // a member of a list modeled elsewhere ("~"): which members there are is the slide or sheet checks'; what each one holds is here
      if (k.startsWith("~") && (!b || !m || !t || !r)) continue;
      // the rule of VOLATILE (src/merge-package.js sameVolatile), on the part's units
      const changed = !unitSame(b, m);
      const carried = unitCarried(b, m, r);
      if (changed && !carried) lost = true;
      if (!unitLooseSame(t, r) && !(changed && unitLooseSame(t, b) && carried)) odd = true;
    }
    const ref = `p:${name}`;
    if (lost && !sink.covered([ref], "part")) (lostBy.get(partLabel(name)) || lostBy.set(partLabel(name), []).get(partLabel(name))).push(ref);
    if (odd) sink.foreign("parts of the file in the result that neither side changed");
  }
  for (const [label, refs] of lostBy) sink.lost("changes to parts of the file neither carried nor handed back", { label: capital(label), why: `You changed ${label}. ${AFTER}`, of: refs, as: "part" });
}

const inverse = (map, n) => {
  const out = new Int32Array(n).fill(-1);
  map.forEach((j, i) => j >= 0 && (out[j] = i));
  return out;
};
const firstWords = (t) => {
  const w = String(t).replace(/\s+/g, " ").trim();
  return w ? `"${untrusted(w.split(" ").slice(0, 8).join(" "), 80)}${w.split(" ").length > 8 ? "..." : ""}"` : "an empty paragraph";
};

const DOCX_KINDS = [
  ["fmt", "look", "paragraph formatting (spacing, indents, borders, the paragraph mark) neither carried nor handed back", `You changed this paragraph's formatting (spacing, indents, borders or the like). ${AFTER}`],
  ["obj", "object", "objects in paragraphs (pictures, fields, links, footnote and comment marks) neither carried nor handed back", `You changed a picture, link, field, footnote or comment mark, or another object in this paragraph. ${AFTER}`],
];

function restDocx(ctx, sink) {
  const { pk, U, L, bm, bt, tr } = ctx;
  partsCheck(pk, (n) => n === "word/document.xml", () => null, sink);
  const [UB, UM, UT, UR] = U.map((u) => u.paras);
  const [kb, km, kt, kr] = U.map((u) => u.skeleton);
  // the document outside its paragraphs: tables (rows, columns, cell settings), sections, anything else in the body
  const layoutMine = !unitSame(kb, km);
  const layoutIn = unitCarried(kb, km, kr);
  if (layoutMine && !layoutIn && !sink.covered(["layout"], "layout")) sink.lost("table or page layout changes neither carried nor handed back", { label: "Tables and page layout", why: `You changed the layout of a table or of the page (rows, columns, cell settings or sections). ${AFTER}`, of: ["layout"], as: "layout" });
  if (!unitLooseSame(kt, kr) && !(layoutMine && unitLooseSame(kt, kb) && layoutIn)) sink.foreign("tables or sections in the result that neither side changed");
  // a paragraph's own attributes count with its objects where it is the same paragraph on both sides; a paragraph added on each side
  // is two new elements, whose revision stamps and text ids say nothing about what they hold (w:rsid*, w14:textId: none is shown)
  const same = (X, Y, k, added = false) => sameResidue(X[k], X.text, Y[k], Y.text) && (k !== "obj" || added || X.own === Y.own);
  // mine's residue in the result, by the rule of VOLATILE (base `X`, mine `Y`, the result `Z`; X null for a paragraph the person added)
  const carried = (X, Y, Z, k, added = false) => residueCarried(X ? X[k] : [], Y[k], Y.text, Z[k], Z.text) && (k !== "obj" || added || Y.own === Z.own);
  const agentSame = (X, Y, k, added = true) => residueLooseSame(X[k], X.text, Y[k], Y.text) && (k !== "obj" || added || X.own === Y.own);
  // each paragraph the person kept: its residue as the person left it, in the result or handed back
  for (let x = 0; x < UB.length; x++) {
    const m = bm[x];
    if (m < 0) continue;
    const t = bt[x];
    const r = t >= 0 ? tr[t] : -1;
    for (const [k, kind, words, why] of DOCX_KINDS) {
      if (same(UB[x], UM[m], k) || (r >= 0 && carried(UB[x], UM[m], UR[r], k))) continue;
      const refs = [`m${m}`, `b${x}`];
      if (!sink.covered(refs, kind)) sink.lost(words, { label: firstWords(L[1][m].text), why, of: refs, as: kind });
    }
  }
  // each paragraph the person added: its residue (anything beyond its text) in a paragraph the merge added with the same text
  const mb = inverse(bm, UM.length);
  const rt = inverse(tr, UR.length);
  const fresh = new Map();
  UR.forEach((u, r) => rt[r] < 0 && (fresh.get(u.text) || fresh.set(u.text, []).get(u.text)).push(r));
  for (let j = 0; j < UM.length; j++) {
    if (mb[j] >= 0) continue;
    for (const [k, kind, words, why] of DOCX_KINDS) {
      if (!UM[j][k].length || (fresh.get(UM[j].text) || []).some((r) => carried(null, UM[j], UR[r], k, true))) continue;
      if (!sink.covered([`m${j}`], kind)) sink.lost(words, { label: firstWords(L[1][j].text), why, of: [`m${j}`], as: kind });
    }
  }
  // the agent's direction: each paragraph of the agent's in the result keeps its residue, but where the person's change landed
  const tb = inverse(bt, UT.length);
  for (let t = 0; t < UT.length; t++) {
    const r = tr[t];
    if (r < 0) continue;
    const x = tb[t];
    const m = x >= 0 ? bm[x] : -1;
    // (a paragraph's own attributes are not compared here: which of several paragraphs with the same text and no id is which is not
    // certain, and their revision stamps are not what they hold)
    for (const [k] of DOCX_KINDS) {
      if (agentSame(UT[t], UR[r], k)) continue;
      if (m >= 0 && !same(UB[x], UM[m], k, true) && agentSame(UT[t], UB[x], k) && carried(UB[x], UM[m], UR[r], k, true)) continue;
      sink.foreign("paragraph contents in the result that neither side changed");
    }
  }
}

const nameOfShape = (sl, sh) => untrusted(`${sh.isTitle ? "the title" : sh.name ? `"${sh.name}"` : `shape ${sh.id}`} on slide ${sl.index + 1}`, 100);

function restPptx(ctx, sink) {
  const { decks, pk, I } = ctx;
  const [B, M, T, R] = decks;
  const slideParts = new Set(decks.flatMap((d) => d.map((s) => s.part).filter(Boolean)));
  // the slide list: which slides and in which order are the slide checks'; each p:sldId's attributes (its relationship) are the part's
  partsCheck(pk, (n) => slideParts.has(n), (n) => (n === "ppt/presentation.xml" ? (l) => (l === "sldIdLst" ? "each" : false) : null), sink);
  const by = (L) => new Map(L.map((s) => [sid(s), s]));
  const [inM, inT, inR] = [M, T, R].map(by);
  const same = (P, Q, s, z) => P === Q || (s?.part && z?.part && s.part === z.part && sameStored(P, Q, s.part));
  for (const b of B) {
    const m = inM.get(sid(b));
    if (!m) continue;
    const t = inT.get(sid(b));
    const r = t ? inR.get(sid(b)) : null;
    // a slide nobody changed in any way (its part as stored, the same in each pair) needs nothing
    if (same(pk[0], pk[1], b, m) && t && r && same(pk[2], pk[3], t, r)) continue;
    const read = (n, s) => (!s ? null : memo(ctx, `${n === 3 && pk[3] === pk[2] ? 2 : n} ${s.part}`, () => slideUnits(s.part ? pk[n].text(s.part) ?? "" : "", I)));
    const [ub, um, ut, ur] = [read(0, b), read(1, m), read(2, t), read(3, r)];
    const fits = (u, s) => !u || (u.shapes.length === s.shapes.length && u.shapes.every((x, k) => x.id === s.shapes[k].id && x.text === s.shapes[k].text));
    if (!fits(ub, b) || !fits(um, m) || !fits(ut, t) || !fits(ur, r)) {
      sink.foreign("slides the proof could not read in full");
      continue;
    }
    const box = `s${sid(b)}`;
    const n = m.index + 1;
    const skelMine = !unitSame(ub.skeleton, um.skeleton);
    const skelIn = !!ur && unitCarried(ub.skeleton, um.skeleton, ur.skeleton);
    if (skelMine && !skelIn && !sink.covered([box], "slide", box)) sink.lost("slide backgrounds, layouts or settings neither carried nor handed back", { label: `Slide ${n}`, why: `You changed the background, layout or settings of slide ${n}. ${AFTER}`, of: [box], as: "slide" });
    if (ut && ur && !unitLooseSame(ut.skeleton, ur.skeleton) && !(skelMine && unitLooseSame(ut.skeleton, ub.skeleton) && skelIn)) sink.foreign("slide settings in the result that neither side changed");
    const bmP = pairByKey(b.shapes, m.shapes, shapeKey);
    const btP = t ? pairByKey(b.shapes, t.shapes, shapeKey) : null;
    const trP = t && r ? pairByKey(t.shapes, r.shapes, shapeKey) : null;
    const res = (X, Y, k) => sameResidue(X[k], X.text, Y[k], Y.text);
    const look = (X, Y) => sameLookKept(X.look, X.text, Y.look, Y.text); // equal on the characters both keep, VOLATILE included
    // the rule of VOLATILE: mine `Y` (base `X`) in the result `Z`; the agent's `Y0` and the result `Z` equal but for VOLATILE
    const resIn = (X, Y, Z, k) => residueCarried(X[k], Y[k], Y.text, Z[k], Z.text);
    const lookIn = (X, Y, Z) => lookCarried(I, X, Y, Z);
    const resAgent = (Y0, Z, k) => residueLooseSame(Y0[k], Y0.text, Z[k], Z.text);
    // what the person changed in a shape: its place, size and kind of shape (obj), its text's formatting (fmt, and the looks)
    const changes = (X, Y) => ({ obj: !res(X, Y, "obj"), fmt: !res(X, Y, "fmt") || X.text !== Y.text || !look(X, Y) });
    for (let x = 0; x < b.shapes.length; x++) {
      const j = bmP[x];
      if (j < 0) continue;
      const tt = btP ? btP[x] : -1;
      const rr = tt >= 0 && trP ? trP[tt] : -1;
      const [X, Y, Z] = [ub.shapes[x], um.shapes[j], rr >= 0 ? ur.shapes[rr] : null];
      const c = changes(X, Y);
      const refs = [`h${sid(b)}/${shapeKey(m.shapes[j])}`];
      const name = nameOfShape(m, m.shapes[j]);
      if (c.obj && !(Z && resIn(X, Y, Z, "obj")) && !sink.covered(refs, "shape", box)) sink.lost("shapes moved, resized or restyled, neither carried nor handed back", { label: `Slide ${n}`, why: `You moved, resized or restyled ${name}. ${AFTER}`, of: refs, as: "shape" });
      if (c.fmt && !(Z && resIn(X, Y, Z, "fmt") && lookIn(X, Y, Z)) && !sink.covered(refs, "look", box)) sink.lost("text formatting in shapes neither carried nor handed back", { label: `Slide ${n}`, why: `You changed the formatting of the text in ${name}. ${AFTER}`, of: refs, as: "look" });
    }
    // the agent's direction
    if (!trP) continue;
    const tb = btP ? inverse(btP, t.shapes.length) : null;
    for (let tt = 0; tt < t.shapes.length; tt++) {
      const rr = trP[tt];
      if (rr < 0) continue;
      const [Y0, Z] = [ut.shapes[tt], ur.shapes[rr]];
      const x = tb ? tb[tt] : -1;
      const j = x >= 0 ? bmP[x] : -1;
      const X = x >= 0 ? ub.shapes[x] : null;
      const Y = j >= 0 ? um.shapes[j] : null;
      const c = X && Y ? changes(X, Y) : { obj: false, fmt: false };
      if (!resAgent(Y0, Z, "obj") && !(c.obj && resAgent(Y0, X, "obj") && resIn(X, Y, Z, "obj"))) sink.foreign("shapes in the result that neither side changed");
      if (Z.text === Y0.text && (!resAgent(Y0, Z, "fmt") || !lookLooseSame(I, Y0, Z)) && !(c.fmt && resIn(X, Y, Z, "fmt") && lookIn(X, Y, Z))) sink.foreign("text formatting in the result that neither side set");
    }
  }
}

const STYLE_LISTS = new Set(["numFmts", "fonts", "fills", "borders", "cellStyleXfs", "cellXfs"]); // read through the cells that use them
const a1 = (k) => {
  let c = k % 16384;
  let col = "";
  for (c += 1; c > 0; c = Math.floor((c - 1) / 26)) col = String.fromCharCode(65 + ((c - 1) % 26)) + col;
  return `${col}${Math.floor(k / 16384) + 1}`;
};
const named = (s) => `"${untrusted(s.name, 60)}"`;

function restXlsx(ctx, sink) {
  const { books, pk } = ctx;
  const [B, M, T, R] = books;
  const sheetParts = new Set(books.flatMap((wb) => wb.sheets.map((s) => s.part).filter(Boolean)));
  sheetParts.add("xl/sharedStrings.xml"); // read through the cells that use them
  // the sheet list: which sheets, their names, ids and whether they are hidden are the sheet checks'; anything else a <sheet> holds is
  // the part's. The style lists are read through every place that uses them (cells, rows, columns: sheetUnits) and checked below for
  // a definition changed in place.
  const SHEET_MODELED = / (name|sheetId|state)="[^"]*"/g;
  partsCheck(pk, (n) => sheetParts.has(n), (n) => (n === "xl/styles.xml" ? (l) => STYLE_LISTS.has(l) : n === "xl/workbook.xml" ? (l) => (l === "sheets" ? "each" : false) : null), sink, (n) => (n === "xl/workbook.xml" ? (tag) => tag.replace(SHEET_MODELED, "") : null));
  // each version's styles and shared strings, read when a sheet needs them; a style or rich text is an interned key, the same in every version
  const I = (ctx.I ||= new Interner());
  const look = (n) => {
    const styles = (ctx.styles ||= pk.map((P, i) => {
      if (i === 3 && P === pk[2]) return null;
      const style = cellStyles(P.text("xl/styles.xml"));
      const rich = sharedRich(P.text("xl/sharedStrings.xml"), style.font);
      const keys = new Map();
      return { style: (s) => keys.get(s) ?? keys.set(s, I.id(style.xf(s))).get(s), rich: (k) => I.id(rich[k] ?? `#missing ${k}`), lists: style.lists };
    }));
    return styles[n] ?? styles[2];
  };
  // A definition (a font, a fill, a border, a number format, a cell style entry) the person changed in place, or removed: the engine
  // only appends to these lists (src/merge-package.js cellStyles), so it is in the result only if the result holds it as mine does
  // there; else it is handed back, whatever references it (an outside review: a font made bold that only a column's style used was
  // kept plain, and nothing was said).
  if (!sameStored(pk[0], pk[1], "xl/styles.xml") && (pk[0].has("xl/styles.xml") || pk[1].has("xl/styles.xml"))) {
    const [lb, lm, lr] = [look(0).lists, look(1).lists, look(3).lists];
    let lost = false;
    for (const name of STYLE_LISTS) {
      const [xb, xm, xr] = [lb[name], lm[name], lr[name]];
      const get = (x, i) => (x instanceof Map ? x.get(i) : x[i]);
      for (const i of xb instanceof Map ? xb.keys() : xb.keys()) if (get(xm, i) !== get(xb, i) && !sameVolatile(get(xb, i), get(xm, i), get(xr, i))) lost = true;
    }
    if (lost && !sink.covered(["p:xl/styles.xml"], "part")) sink.lost("cell style definitions changed in place, neither carried nor handed back", { label: "Cell styles", why: `You changed cell styles (a font, fill, border or number format that cells, rows or columns use). ${AFTER}`, of: ["p:xl/styles.xml"], as: "part" });
  }
  const by = (wb) => new Map(wb.sheets.map((s) => [sheetKey(s), s]));
  const [inM, inT, inR] = [M, T, R].map(by);
  const same = (P, Q, s, z) => P === Q || (s?.part && z?.part && s.part === z.part && sameStored(P, Q, s.part));
  for (const b of B.sheets) {
    const k = sheetKey(b);
    const m = inM.get(k);
    if (!m) continue;
    const t = inT.get(k);
    const r = t ? inR.get(k) : null;
    // a sheet nobody changed in any way, its styles and strings included, needs nothing
    const quiet = (P, Q, s, z) => same(P, Q, s, z) && ["xl/styles.xml", "xl/sharedStrings.xml"].every((n) => P === Q || (!P.has(n) && !Q.has(n)) || sameStored(P, Q, n));
    if (quiet(pk[0], pk[1], b, m) && t && r && quiet(pk[2], pk[3], t, r)) continue;
    const read = (n, s) => (!s ? null : memo(ctx, `${n === 3 && pk[3] === pk[2] ? 2 : n} ${s.part}`, () => sheetUnits(s.part ? pk[n].text(s.part) ?? "" : "", look(n).style, look(n).rich)));
    const [ub, um, ut, ur] = [read(0, b), read(1, m), read(2, t), read(3, r)];
    const box = `S${k}`;
    const rowsDiffer = (X, Y) => X.rows.size !== Y.rows.size || [...X.rows].some(([row, v]) => Y.rows.get(row) !== v);
    const layout = (X, Y) => !unitSame(X.skeleton, Y.skeleton) || rowsDiffer(X, Y);
    const mineLayout = layout(ub, um);
    // the rule of VOLATILE on the sheet's layout: mine in the result, the agent's equal but for VOLATILE
    const layoutIn = !!ur && unitCarried(ub.skeleton, um.skeleton, ur.skeleton) && !rowsDiffer(um, ur);
    const layoutAgent = (X, Y) => !unitLooseSame(X.skeleton, Y.skeleton) || rowsDiffer(X, Y);
    if (mineLayout && !layoutIn && !sink.covered([box], "layout", box)) sink.lost("sheet layout changes (row heights, column widths, merged cells, views) neither carried nor handed back", { label: `Sheet ${named(m)}`, why: `You changed row heights, column widths, merged cells or other settings of the sheet ${named(m)}. ${AFTER}`, of: [box], as: "layout" });
    if (ut && ur && layoutAgent(ut, ur) && !(mineLayout && !layoutAgent(ut, ub) && layoutIn)) sink.foreign("sheet layout in the result that neither side changed");
    const get = (u, key) => u.at(key);
    const lost = [];
    // every address either side has, without a list of them all (a sheet holds up to a million cells)
    const each = (X, Y, fn) => {
      for (const key of X.cells.keys()) fn(key);
      for (const key of Y.cells.keys()) if (!X.cells.has(key)) fn(key);
    };
    each(ub, um, (key) => {
      const vm = get(um, key);
      const vb = get(ub, key);
      if (vb === vm || (ur && sameVolatile(vb, vm, get(ur, key)))) return;
      if (!sink.covered([`c${k}!${key}`], "look", box)) lost.push(key);
    });
    if (lost.length) {
      lost.sort((x, y) => x - y);
      const cells = `${lost.slice(0, 5).map(a1).join(", ")}${lost.length > 5 ? ` and ${lost.length - 5} more cells` : ""}`;
      sink.lost("cell formatting neither carried nor handed back", { label: `Sheet ${named(m)}`, why: `You changed the formatting of ${cells} on the sheet ${named(m)} (bold, fill, number format, alignment, borders or the like). ${AFTER}`, of: lost.map((key) => `c${k}!${key}`), as: "look" });
    }
    if (!ut || !ur || ut === ur) continue;
    each(ut, ur, (key) => {
      const vt = get(ut, key);
      const vr = get(ur, key);
      if (looseSame(vt, vr)) return;
      const vb = get(ub, key);
      const vm = get(um, key);
      if (vb !== vm && looseSame(vt, vb) && sameVolatile(vb, vm, vr)) return;
      sink.foreign("cell formatting in the result that neither side set");
    });
  }
}

const PROVERS = { docx: proveDocx, pptx: provePptx, xlsx: proveXlsx };
const PREPARE = { docx: prepareDocx, pptx: preparePptx, xlsx: prepareXlsx };
const REST = { docx: restDocx, pptx: restPptx, xlsx: restXlsx };

/**
 * The four versions read once for handBack and proveMerge of the same merge ({base, mine, theirs, merged, read}): pass the result
 * as `ctx` to both.
 */
export function prepareMerge(format, args) {
  return byFormat(PREPARE, format, "prepareMerge")(args);
}

/**
 * The proof of one merge: null when every difference balances, else a short reason (counts and kinds, no document text). `merged` is
 * the result's bytes (theirs when the merge wrote nothing); `unplaced` and `copy` are what the merge answers.
 */
export function proveMerge(format, args) {
  return byFormat(PROVERS, format, "proveMerge")(args);
}

/**
 * The person's differences of the kinds no planner carries (parts, layout, the residue of units: src/merge-package.js) that are neither
 * in the result nor handed back yet, as plain unplaced entries ({label, text: "", why, of, as}), grouped. The merge worker adds them
 * (and keeps a copy of the person's file) before the proof runs: so the person is told of every such change, and the proof checks the
 * merge with them. A difference this cannot name is left to the proof, which refuses the merge. `copy` on the list: one an entry of
 * the merge's own already names for its whole slide or sheet, which holds once the copy is kept.
 */
export function handBack(format, args) {
  const ctx = args.ctx ?? byFormat(PREPARE, format, "handBack")(args);
  if (ctx.whole === false) return [];
  const entries = [];
  byFormat(REST, format, "handBack")(ctx, new Sink(handedBack(args.unplaced, args.copy), null, entries));
  const copy = !!entries.copy;
  // one entry per thing said: the same words for several units are one line naming them all
  const byWhy = new Map();
  for (const e of entries) {
    const key = `${e.as}\0${e.label}\0${e.why}`;
    if (byWhy.has(key)) byWhy.get(key).of.push(...e.of);
    else byWhy.set(key, { ...e, of: [...e.of] });
  }
  const out = [...byWhy.values()];
  if (copy) out.copy = true; // a difference an entry already names, which needs the person's file kept
  return out;
}
