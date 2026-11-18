import assert from "node:assert/strict";
import { test } from "node:test";
import { docxBytes } from "./helpers/zipbuild.js";
import { mergeProven } from "../src/merge-worker.js";
import { readDocxParagraphs } from "../src/docx.js";
import { openZip } from "../src/zip.js";

// The DOCX merge as a property over random small documents, end to end as the merge worker runs it (src/merge-worker.js): the real
// planner (src/merge.js) and op engine, then the proof (src/merge-proof.js). Every case must end in a correct merge or a clean refusal
// (no file: the person's edits stay in the page); a silent loss is the only failure.
//
// "Correct" is judged by a third checker below, over plain arrays, that imports neither the planner nor the proof. It knows every
// paragraph's true identity: the generator writes it into each paragraph as w14:textId, which the reader ignores and the engine keeps
// on a paragraph it edits or moves (a paragraph the engine adds has none, and is the person's new paragraph, known by its text). The
// w14:paraId the merge sees is separate and, by group, absent, duplicated or renumbered by the agent. The checker's accounting is the
// proof's rule, by true identity: each of the person's text edits (white space as written), deletions, additions (each copy) and
// changes of order is in the result at that paragraph and place, or handed back by an entry that names it (`of`) and, for text, holds
// it; everything the agent changed stands; nothing else in the result differs from the agent's version.
// A failing case prints its seed and its versions; each one found is kept below as a named test.

const SEED = 20261116;
const PER_GROUP = 2000;
const PARTS = 2; // per group, so each test stays far below the per-test timeout

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

const LONG = ["The team reviews the budget each quarter and files a note.", "Every request is logged with the date it arrived.", "The plan names one owner for each open question.", "Shipping waits until the checks in the list pass.", "A short summary goes to the board after each review.", "Travel is booked two weeks ahead whenever possible."];
const SHORT = ["Notes", "Budget", "Owner", "Summary", "Plan"];
// white space as typed: a second space, a tab, a line break (w:br), a space at either end
const SPACE = [(t) => t.replace(" ", "  "), (t) => t.replace(" ", "\t"), (t) => t.replace(" ", "\n"), (t) => ` ${t}`, (t) => `${t} `, (t) => t.replace(/ /g, "  ")];
const GROUPS = {
  "moves and swaps, with and without edits": ["move", "swap", "moveEdit", "swapEdit", "edit"],
  "white space only (a second space, a tab, a line break, a space at either end)": ["space", "space", "space", "edit", "move"],
  "inserts (the same text twice) and deletes next to edits": ["insert", "insertTwice", "delete", "deleteNextToEdit", "edit"],
  "both sides on one paragraph: both edit it, the agent moves or deletes what the person edited": ["edit", "small", "space", "move", "delete", "same"],
  "ids absent, duplicated, or renumbered by the agent": ["edit", "move", "insert", "delete", "space", "copyId"],
};

/**
 * One random case of a group: {base, mine, theirs}, each a list of {text, tid, pid} (tid: the true identity; pid: the w14:paraId
 * the merge sees, or null).
 */
function makeCase(seed, group) {
  const r = rng(seed);
  const pick = (list) => list[Math.floor(r() * list.length)];
  const n = 3 + Math.floor(r() * 4);
  const base = Array.from({ length: n }, (_, k) => ({ text: r() < 0.7 ? `${pick(LONG)} (${k + 1})` : `${pick(SHORT)} ${k + 1}`, tid: k + 1, pid: k + 1 }));
  const noIds = group.startsWith("ids") && r() < 0.3;
  // the same text twice in the base (not without ids, where nothing but text tells such two apart)
  if (r() < 0.2 && !noIds) base[1 + Math.floor(r() * (n - 1))].text = base[0].text;
  let fresh = 0;
  const ops = GROUPS[group];
  const side = (who, tids, shared) => {
    const L = base.map((p) => ({ ...p }));
    const one = (op) => {
      const i = Math.floor(r() * L.length);
      const text = () => (r() < 0.6 ? `${who} wrote paragraph number ${++fresh} here today.` : `${who} ${++fresh}`);
      const add = (at, t) => L.splice(at, 0, { text: t, tid: tids + ++fresh, pid: r() < 0.5 ? null : tids + fresh });
      const move = () => {
        const [p] = L.splice(i, 1);
        L.splice(Math.floor(r() * (L.length + 1)), 0, p);
        return p;
      };
      if (op === "edit") L[i].text = text();
      else if (op === "small") L[i].text = `${L[i].text} ${who} added.`;
      else if (op === "same") L[i].text = shared(i); // both sides may write the same text into one paragraph
      else if (op === "space") L[i].text = pick(SPACE)(L[i].text);
      else if (op === "insert") add(i + Math.floor(r() * 2), text());
      else if (op === "insertTwice") {
        const t = text();
        add(i, t);
        add(Math.floor(r() * (L.length + 1)), t);
      } else if (op === "delete" && L.length > 2) L.splice(i, 1);
      else if (op === "deleteNextToEdit" && L.length > 2) {
        L.splice(i, 1);
        if (L[i]) L[i].text = text();
      } else if (op === "move" && L.length > 1) move();
      else if (op === "moveEdit" && L.length > 1) move().text = text();
      else if (op === "swap" && i + 1 < L.length) [L[i], L[i + 1]] = [L[i + 1], L[i]];
      else if (op === "swapEdit" && i + 1 < L.length) {
        [L[i], L[i + 1]] = [L[i + 1], L[i]];
        L[i].text = text();
        L[i + 1].text = text();
      } else if (op === "copyId" && L.length > 1) L.splice(i + 1, 0, { text: text(), tid: tids + ++fresh, pid: L[i].pid }); // a copy that keeps the id
    };
    const k = 1 + Math.floor(r() * 3);
    for (let s = 0; s < k; s++) one(pick(ops));
    return L;
  };
  const shared = new Map();
  const same = (i) => shared.get(i) ?? shared.set(i, `Both sides wrote this into paragraph ${i + 1}.`).get(i);
  const mine = side("Mine", 1000, same);
  const theirs = side("Agent", 2000, same);
  if (noIds) for (const L of [base, mine, theirs]) for (const p of L) p.pid = null; // no ids anywhere
  else if (group.startsWith("ids") && r() < 0.45) for (const p of theirs) p.pid = p.pid == null ? null : 5000 + p.tid; // the agent's version renumbered every id
  return { base, mine, theirs };
}

// ---- the documents ----------------------------------------------------------------------------------------------------------------
const hex = (n) => (0x10000000 + n).toString(16).toUpperCase();
const xmlText = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
/** a paragraph's runs: text as written, a tab as w:tab, a line break as w:br */
const runsOf = (text) => text.split(/(\t|\n)/).filter((x) => x !== "").map((x) => (x === "\t" ? "<w:r><w:tab/></w:r>" : x === "\n" ? "<w:r><w:br/></w:r>" : `<w:r><w:t xml:space="preserve">${xmlText(x)}</w:t></w:r>`)).join("");
const bytesOf = (list) => docxBytes([], {}, list.map((p) => `<w:p w14:textId="${hex(p.tid)}"${p.pid == null ? "" : ` w14:paraId="${hex(p.pid)}"`}>${runsOf(p.text)}</w:p>`).join(""));
/** the result as {text, tid}: the reader's text, and the w14:textId the engine kept (null on a paragraph it added) */
function resultOf(bytes) {
  const tags = openZip(bytes).readText("word/document.xml").match(/<w:p(?=[\s>])[^>]*>/g) || [];
  const texts = readDocxParagraphs(bytes).map((p) => p.text);
  assert.equal(tags.length, texts.length);
  return texts.map((text, k) => {
    const id = /w14:textId="([0-9A-F]{8})"/.exec(tags[k])?.[1];
    return { text, tid: id ? parseInt(id, 16) - 0x10000000 : null };
  });
}

// ---- the third checker: plain arrays, true identities -----------------------------------------------------------------------------
/**
 * What does not balance in a merge: B, M, T, R are lists of {text, tid}; `unplaced` is the merge's list, whose `of` names
 * paragraphs as "m" or "b" and their index in mine or base; `copy`: the person's file is kept. Returns the broken rules.
 */
function unbalanced({ B, M, T, R, unplaced }) {
  const at = (L) => new Map(L.flatMap((p, k) => (p.tid == null ? [] : [[p.tid, k]])));
  // What the merge can see of identity is the paragraph id: a paragraph that carries a base paragraph's id, unique on both sides, while
  // that paragraph is gone (a copy kept its id, then the original was deleted) is that paragraph. Without an id (or with one several
  // paragraphs carry), a paragraph whose text changed has no identity left (rewritten in place, and deleted with a new one added there,
  // read the same): one the agent rewrote is the agent's new paragraph; one the person rewrote that is not in the result with the
  // person's text is the person's new paragraph (the base one a deletion); and see below for one the person deleted.
  [M, T, R] = [M, T, R].map((L) => L.map((p) => ({ ...p })));
  const count = (L) => L.reduce((m, p) => (p.pid == null ? m : m.set(p.pid, (m.get(p.pid) || 0) + 1)), new Map());
  const basePid = count(B);
  const byPid = new Map(B.filter((p) => basePid.get(p.pid) === 1).map((p) => [p.pid, p.tid]));
  for (const [L, also] of [[M, []], [T, [R]]]) {
    const pids = count(L);
    const tids = new Set(L.map((p) => p.tid));
    for (const p of L) {
      const tid = byPid.get(p.pid);
      if (tid === undefined || pids.get(p.pid) !== 1 || tids.has(tid)) continue;
      for (const X of also) for (const x of X) if (x.tid === p.tid) x.tid = tid;
      p.tid = tid;
    }
  }
  // "without an id" on one side: none, or one that more than one paragraph carries in the base or on that side
  const [minePid, theirPid] = [count(M), count(T)];
  const loose = (p, side) => p.pid == null || basePid.get(p.pid) !== 1 || side.get(p.pid) > 1;
  const textOf = (L, tid) => L.find((p) => p.tid === tid)?.text;
  for (const p of B) {
    if (!loose(p, theirPid) || textOf(T, p.tid) === undefined || textOf(T, p.tid) === p.text) continue;
    for (const L of [T, R]) for (const x of L) if (x.tid === p.tid) x.tid = `agent ${p.tid}`;
  }
  for (const p of B) {
    const m = textOf(M, p.tid);
    if (loose(p, minePid) && m !== undefined && m !== p.text && textOf(R, p.tid) !== m) for (const x of M) if (x.tid === p.tid) x.tid = `person ${p.tid}`;
  }
  // and one the person deleted, whose place in the result now holds a paragraph the person added there, is that addition
  const added = new Set(M.filter((x) => !B.some((y) => y.tid === x.tid)).map((x) => x.text));
  for (const p of B) {
    const r = R.find((x) => x.tid === p.tid);
    if (loose(p, minePid) && textOf(M, p.tid) === undefined && textOf(T, p.tid) === p.text && r && r.text !== p.text && added.has(r.text)) r.tid = null;
  }
  const [iB, iM, iT, iR] = [B, M, T, R].map(at);
  const named = new Map(); // tid -> entries that name it
  for (const u of unplaced) {
    for (const ref of u.of || []) {
      const p = (ref[0] === "m" ? M : ref[0] === "b" ? B : [])[Number(ref.slice(1))];
      if (p) (named.get(p.tid) || named.set(p.tid, []).get(p.tid)).push(u);
    }
  }
  const back = (tid, text = null) => (named.get(tid) || []).some((u) => text === null || u.text === text.slice(0, 2000));
  const text = (L, ix, tid) => (ix.has(tid) ? L[ix.get(tid)].text : undefined);
  const bad = [];
  // the person's text edits and deletions
  for (const [tid] of iB) {
    const [b, m, t, r] = [text(B, iB, tid), text(M, iM, tid), text(T, iT, tid), text(R, iR, tid)];
    if (m !== undefined && m !== b && r !== m && !back(tid, m)) bad.push(`the person's edit of paragraph ${tid} is neither in it nor handed back`);
    if (m === undefined && r !== undefined && !back(tid)) bad.push(`the person deleted paragraph ${tid}; it is in the result and not handed back`);
    // the agent's side stands
    if (t === undefined && r !== undefined) bad.push(`the agent deleted paragraph ${tid}; it is back`);
    if (t !== undefined && t !== b && r !== t) bad.push(`the agent's text of paragraph ${tid} is lost`);
    if (t !== undefined && r === undefined && !(m === undefined && t === b)) bad.push(`paragraph ${tid} is gone, though only a deletion of the person's of a paragraph the agent left alone may remove it`);
  }
  // nothing in the result differs from the agent's version but the person's carried edits
  for (const [tid, k] of iR) {
    const [b, m, t] = [text(B, iB, tid), text(M, iM, tid), text(T, iT, tid)];
    if (t === undefined) bad.push(`paragraph ${tid} is in the result but not in the agent's version`);
    else if (R[k].text !== t && !(m !== undefined && m !== b && t === b && R[k].text === m)) bad.push(`paragraph ${tid} reads ${JSON.stringify(R[k].text)}, neither the agent's text nor the person's edit of it`);
  }
  for (const [tid] of iT) if (!iB.has(tid) && text(R, iR, tid) !== text(T, iT, tid)) bad.push(`the agent's new paragraph ${tid} is lost`);
  // what the person added, each copy: in the result in its place, or handed back; nothing nobody wrote
  const full = (tid) => tid != null && iB.has(tid) && iM.has(tid) && iT.has(tid) && iR.has(tid);
  // a neighbor the agent moved (out of a longest run its version keeps in base order, found by the quadratic textbook way: cases are
  // small) does not mark a place either
  const kept = (() => {
    const L = T.filter((p) => full(p.tid)).map((p) => p.tid);
    const best = L.map(() => 1);
    const from = L.map(() => -1);
    for (let a = 0; a < L.length; a++) for (let b = 0; b < a; b++) if (iB.get(L[b]) < iB.get(L[a]) && best[b] + 1 > best[a]) (best[a] = best[b] + 1), (from[a] = b);
    const out = new Set();
    for (let a = best.indexOf(Math.max(0, ...best)); a >= 0; a = from[a]) out.add(L[a]);
    return out;
  })();
  const settled = (tid) => full(tid) && !back(tid) && kept.has(tid);
  const both = T.filter((p) => iB.has(p.tid)).map((p) => iB.get(p.tid));
  const agentReordered = both.some((v, k) => k > 0 && v < both[k - 1]);
  const fresh = new Map(); // text -> indexes of the result's paragraphs the engine added
  R.forEach((p, k) => p.tid == null && (fresh.get(p.text) || fresh.set(p.text, []).get(p.text)).push(k));
  const used = new Map();
  M.forEach((p, j) => {
    if (iB.has(p.tid)) return;
    const list = fresh.get(p.text) || [];
    const n = used.get(p.text) || 0;
    if (n < list.length) {
      used.set(p.text, n + 1);
      const r = list[n];
      // its place: the result's paragraph before it (other new ones skipped) is one of mine's between it and the nearest one not
      // handed back, or the same after it
      const prevR = R.slice(0, r).reverse().find((x) => full(x.tid));
      const nextR = R.slice(r + 1).find((x) => full(x.tid));
      const near = (step) => {
        const out = new Set();
        for (let k = j + step; k >= 0 && k < M.length; k += step) {
          if (!full(M[k].tid)) continue;
          out.add(M[k].tid);
          if (settled(M[k].tid)) break;
        }
        return out;
      };
      const before = near(-1);
      const after = near(1);
      const okBefore = prevR ? before.has(prevR.tid) : ![...before].some(settled);
      const okAfter = nextR ? after.has(nextR.tid) : ![...after].some(settled);
      // Ceiling: without ids, once the agent also put paragraphs in another order, a new paragraph has no place left to judge
      const unjudged = agentReordered && B.every((x) => x.pid == null);
      if (!okBefore && !okAfter && !unjudged && !back(p.tid, p.text)) bad.push(`the person's new paragraph ${JSON.stringify(p.text)} is out of place`);
    } else if (!back(p.tid, p.text) && !T.some((x) => !iB.has(x.tid) && x.text === p.text)) bad.push(`the person's new paragraph ${JSON.stringify(p.text)} is neither in the result nor handed back`);
  });
  for (const [t, list] of fresh) if (list.length > (used.get(t) || 0)) bad.push(`the result has ${JSON.stringify(t)} that nobody wrote there`);
  // order, pair by pair, of the paragraphs all four versions have and the merge does not hand back: the person's order where the person
  // changed it, else the agent's
  const pairs = [...iR.keys()].filter(settled);
  for (let x = 0; x < pairs.length; x++) {
    for (let y = x + 1; y < pairs.length; y++) {
      const [p, q] = [pairs[x], pairs[y]];
      const [bo, mo, to, ro] = [iB, iM, iT, iR].map((ix) => ix.get(p) < ix.get(q));
      if (ro !== (mo !== bo ? mo : to)) bad.push(`paragraphs ${p} and ${q} are in the wrong order`);
    }
  }
  return bad;
}

/** the merge of one case as the merge worker runs it: {refused} or {bad: the broken rules of a merge it returned} */
async function check(c) {
  const [base, mine, theirs] = [c.base, c.mine, c.theirs].map(bytesOf);
  const r = await mergeProven({ format: "docx", base, mine, theirs, name: "t.docx" });
  if (r.refused) return { refused: r.refused };
  const plain = (L) => L.map(({ text, tid, pid }) => ({ text, tid, pid }));
  return { bad: unbalanced({ B: plain(c.base), M: plain(c.mine), T: plain(c.theirs), R: r.bytes ? resultOf(r.bytes) : plain(c.theirs), unplaced: r.unplaced }) };
}

const show = (seed, c, bad) => `seed ${seed}: ${bad.join("; ")}\n${["base", "mine", "theirs"].map((k) => `  ${k}: ${JSON.stringify(c[k].map((p) => [p.text, p.tid, p.pid]))}`).join("\n")}`;

Object.keys(GROUPS).forEach((group, g) => {
  for (let part = 0; part < PARTS; part++) {
    test(`property, ${group} (${PER_GROUP} cases, part ${part + 1} of ${PARTS}, seed ${SEED + g * 100_000}): a correct merge or a clean refusal, never a silent loss`, async (t) => {
      const per = PER_GROUP / PARTS;
      const failures = [];
      let refused = 0;
      for (let k = part * per; k < (part + 1) * per && failures.length < 5; k++) {
        const seed = SEED + g * 100_000 + k;
        const c = makeCase(seed, group);
        const out = await check(c);
        if (out.refused) refused++;
        else if (out.bad.length) failures.push(show(seed, c, out.bad));
      }
      t.diagnostic(`merged ${per - refused}, refused ${refused}`);
      assert.deepEqual(failures, []);
    });
  }
});

// ---- cases found, kept by name ----------------------------------------------------------------------------------------------------
const P = (list) => list.map(([text, tid, pid = tid]) => ({ text, tid, pid }));
const named = async (c) => {
  const out = await check(c);
  assert.deepEqual(out, { bad: [] }, JSON.stringify(out));
};
// the outside reviews' cases (each lost an edit on an earlier version)
test("found: base [A, B, C, D], the person retyped A as B and edited B, the agent edited B and D", () => named({ base: P([["A", 1], ["B", 2], ["C", 3], ["D", 4]]), mine: P([["B", 1], ["B2", 2], ["C", 3], ["D", 4]]), theirs: P([["A", 1], ["B3", 2], ["C", 3], ["D4", 4]]) }));
test("found (HIGH B): the person moved A after C and edited it, the agent edited D", () => named({ base: P([["A", 1], ["B", 2], ["C", 3], ["D", 4]]), mine: P([["B", 2], ["C", 3], ["A2", 1], ["D", 4]]), theirs: P([["A", 1], ["B", 2], ["C", 3], ["D2", 4]]) }));
test("found (HIGH B): two paragraphs swapped and both edited", () => named({ base: P([["One", 1], ["Two", 2], ["Three", 3]]), mine: P([["Two edited", 2], ["One edited", 1], ["Three", 3]]), theirs: P([["One", 1], ["Two", 2], ["Three by the agent", 3]]) }));
test("found (HIGH C): a line break typed where a space was, the agent edited the next paragraph", () => named({ base: P([["A B", 1], ["C", 2]]), mine: P([["A\nB", 1], ["C", 2]]), theirs: P([["A B", 1], ["C2", 2]]) }));
test("found (HIGH C): two spaces, a tab, a space at either end", async () => {
  for (const t of ["A  B", "A\tB", " A B", "A B "]) await named({ base: P([["A B", 1], ["C", 2]]), mine: P([[t, 1], ["C", 2]]), theirs: P([["A B", 1], ["C2", 2]]) });
});

// ---- the rest of the document: tables, headers, footers, footnotes, comments, formatting, rows, many edits --------------------------
// Random documents with a header, a footer, a footnote, a comment, two tables and body paragraphs. The person moves paragraphs into a
// table cell or from one table to the other, edits the header, footer, footnote or comment, makes text bold, sets a heading or a
// list, inserts or deletes a table row, edits text; sometimes the page's list of edits runs past 2,000. The agent edits text, the
// header or the footnote. A tiny checker over plain objects (paragraphs by w14:textId, the parts' text, the tables' rows) asks of
// every difference between the base and the person's version: in the result, or handed back by an entry that names it (`of`), or the
// merge refused. Anything else is a silent loss, the only failure.
const STRUCT_CASES = 400;
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

function makeStruct(seed) {
  const r = rng(seed);
  const pick = (list) => list[Math.floor(r() * list.length)];
  let tid = 0;
  const p = (text) => ({ tid: ++tid, text, bold: false, style: false, list: false });
  const base = {
    header: "Header text",
    footer: "Footer text",
    note: "Footnote text",
    comment: "Comment text",
    blocks: [{ p: p("Opening paragraph with a comment") }, { p: p("A paragraph with a footnote") }, { rows: [[[p("Cell one")], [p("Cell two")]], [[p("Cell three")], [p("Cell four")]]] }, { p: p("Between the tables") }, { rows: [[[p("Second table cell")]]] }, { p: p(`Closing paragraph ${Math.floor(r() * 100)}`) }],
  };
  const copy = (d) => JSON.parse(JSON.stringify(d));
  const body = (d) => d.blocks.filter((b) => b.p).map((b) => b.p);
  const all = (d) => d.blocks.flatMap((b) => (b.p ? [b.p] : b.rows.flat(2)));
  let n = 0;
  const side = (who, ops) => {
    const d = copy(base);
    for (let k = 1 + Math.floor(r() * 3); k > 0; k--) {
      const op = pick(ops);
      const any = pick(all(d));
      const [t1, t2] = d.blocks.filter((b) => b.rows);
      if (op === "text") any.text = `${who} edit ${++n}`;
      else if (op === "bold") any.bold = !any.bold;
      else if (op === "style") pick(body(d)).style = true;
      else if (op === "list") pick(body(d)).list = true;
      else if (["header", "footer", "note", "comment"].includes(op)) d[op] = `${who} ${op} ${++n}`;
      else if (op === "toCell") {
        const i = d.blocks.findIndex((b) => b.p && b !== d.blocks[0]);
        if (i > 0 && body(d).length > 2) pick(t1.rows.flat()).push(d.blocks.splice(i, 1)[0].p);
      } else if (op === "betweenTables") {
        const cell = pick(t1.rows.flat());
        if (cell.length > 1 || r() < 0.5) cell.length && t2.rows[0][0].push(cell.splice(Math.floor(r() * cell.length), 1)[0]);
      } else if (op === "insertRow") t1.rows.splice(Math.floor(r() * 3), 0, [[{ tid: 900 + ++n, text: `${who} row ${n}`, bold: false, style: false, list: false }], [{ tid: 950 + n, text: `${who} cell ${n}`, bold: false, style: false, list: false }]]);
      else if (op === "deleteRow" && t1.rows.length > 1) t1.rows.splice(Math.floor(r() * t1.rows.length), 1);
    }
    return d;
  };
  const mine = side("Mine", ["text", "bold", "style", "list", "header", "footer", "note", "comment", "toCell", "betweenTables", "insertRow", "deleteRow"]);
  const theirs = side("Agent", ["text", "text", "header", "note", "bold"]);
  return { base, mine, theirs, many: r() < 0.2 };
}

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
function structBytes(d) {
  const para = (x, extra = "") => `<w:p w14:paraId="${hex(x.tid)}" w14:textId="${hex(x.tid)}">${x.style || x.list ? `<w:pPr>${x.style ? '<w:pStyle w:val="Heading2"/>' : ""}${x.list ? '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>' : ""}</w:pPr>` : ""}${extra.startsWith("<w:commentRangeStart") ? extra : ""}<w:r>${x.bold ? "<w:rPr><w:b/><w:bCs/></w:rPr>" : ""}<w:t xml:space="preserve">${esc(x.text)}</w:t></w:r>${extra.startsWith("<w:commentRangeStart") ? '<w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r>' : extra}</w:p>`;
  const extras = new Map([[d.blocks[0].p?.tid, '<w:commentRangeStart w:id="0"/>'], [2, '<w:r><w:footnoteReference w:id="1"/></w:r>']]);
  const cellXml = (cell) => `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr>${cell.length ? cell.map((x) => para(x, extras.get(x.tid))).join("") : "<w:p/>"}</w:tc>`;
  const blocks = d.blocks.map((b) => (b.p ? para(b.p, extras.get(b.p.tid)) : `<w:tbl><w:tblPr/><w:tblGrid>${b.rows[0].map(() => '<w:gridCol w:w="2000"/>').join("")}</w:tblGrid>${b.rows.map((row) => `<w:tr>${row.map(cellXml).join("")}</w:tr>`).join("")}</w:tbl>`)).join("");
  const part = (root, inner) => `<?xml version="1.0"?><w:${root} xmlns:w="${W}">${inner}</w:${root}>`;
  const one = (t) => `<w:p><w:r><w:t xml:space="preserve">${esc(t)}</w:t></w:r></w:p>`;
  return docxBytes([], {
    "word/_rels/document.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdH" Type="${R}/header" Target="header1.xml"/><Relationship Id="rIdF" Type="${R}/footer" Target="footer1.xml"/><Relationship Id="rIdN" Type="${R}/footnotes" Target="footnotes.xml"/><Relationship Id="rIdC" Type="${R}/comments" Target="comments.xml"/><Relationship Id="rIdU" Type="${R}/numbering" Target="numbering.xml"/><Relationship Id="rIdS" Type="${R}/styles" Target="styles.xml"/></Relationships>`,
    "word/header1.xml": part("hdr", one(d.header)),
    "word/footer1.xml": part("ftr", one(d.footer)),
    "word/footnotes.xml": part("footnotes", `<w:footnote w:id="1">${one(d.note)}</w:footnote>`),
    "word/comments.xml": part("comments", `<w:comment w:id="0" w:author="Reviewer">${one(d.comment)}</w:comment>`),
    "word/numbering.xml": part("numbering", '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>'),
    "word/styles.xml": part("styles", '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/></w:style>'),
  }, `${blocks}<w:sectPr xmlns:r="${R}"><w:headerReference w:type="default" r:id="rIdH"/><w:footerReference w:type="default" r:id="rIdF"/></w:sectPr>`);
}

/** the tiny checker's reading of a DOCX: parts' text, each paragraph by its w14:textId (text, place, bold, heading, list), the rows */
function structOf(bytes) {
  const zip = openZip(bytes);
  const text = (name) => [...(zip.readText(name) || "").matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join("");
  const xml = zip.readText("word/document.xml");
  const paras = [];
  const tables = [];
  // top-level tables in order; a paragraph's place is "body" or "table/row/cell"
  let t = -1;
  for (const m of xml.matchAll(/<w:tbl>.*?<\/w:tbl>|<w:p\b[^>]*\/>|<w:p\b.*?<\/w:p>/gs)) {
    if (m[0].startsWith("<w:tbl>")) {
      t++;
      const rows = [...m[0].matchAll(/<w:tr>.*?<\/w:tr>/gs)].map((row, ri) => [...row[0].matchAll(/<w:tc>.*?<\/w:tc>/gs)].map((cell, ci) => [...cell[0].matchAll(/<w:p\b[^>]*\/>|<w:p\b.*?<\/w:p>/gs)].map((pm) => paras.push(readPara(pm[0], `${t}/${ri}/${ci}`)) && paras[paras.length - 1].tid)));
      tables.push(rows.map((row) => row.map((cell) => cell.join(",")).join("|")));
    } else paras.push(readPara(m[0], "body"));
  }
  return { header: text("word/header1.xml"), footer: text("word/footer1.xml"), note: text("word/footnotes.xml"), comment: text("word/comments.xml"), paras, tables };
}
function readPara(x, where) {
  const tid = /w14:textId="([0-9A-F]{8})"/.exec(x)?.[1] ?? null;
  return { tid: tid ? parseInt(tid, 16) - 0x10000000 : null, text: [...x.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1].replace(/&lt;/g, "<").replace(/&amp;/g, "&")).join(""), where, bold: /<w:b\/>|<w:b w:val="(1|true|on)"\/>/.test(x), style: /<w:pStyle w:val="Heading2"\/>/.test(x), list: /<w:numPr>/.test(x) };
}

function structUnbalanced(B, M, T, R, unplaced, copy) {
  const bad = [];
  const named = (refs, text = null) => unplaced.some((u) => (u.of || []).some((ref) => refs.includes(ref)) && (text === null || u.text === text));
  for (const k of ["header", "footer", "note", "comment"]) {
    const part = { header: "word/header1.xml", footer: "word/footer1.xml", note: "word/footnotes.xml", comment: "word/comments.xml" }[k];
    if (M[k] !== B[k] && R[k] !== M[k] && !(named([`p:${part}`]) && copy)) bad.push(`the person's ${k} is neither in the result nor handed back`);
    if (T[k] !== B[k] && M[k] === B[k] && R[k] !== T[k]) bad.push(`the agent's ${k} is gone`);
  }
  const at = (L) => new Map(L.paras.map((p, i) => [p.tid, { ...p, ord: i }]));
  const [b, m, t, r] = [B, M, T, R].map(at);
  for (const [tid, x] of m) {
    const was = b.get(tid);
    const got = r.get(tid);
    const refs = was ? [`m${x.ord}`, `b${was.ord}`] : [`m${x.ord}`];
    if (!was) {
      // a new paragraph may be carried as the text written into one the person replaced (the merge's identity is not the true one):
      // its text in the result, in its place or with an entry that names it
      const carried = got?.text === x.text ? got : R.paras.find((p) => p.text === x.text && !b.has(p.tid) && !t.has(p.tid)) || R.paras.find((p) => p.text === x.text && m.get(p.tid)?.text !== p.text);
      if (!(carried && (carried.where === x.where || named(refs))) && !named(refs, x.text) && !(named(["layout"]) && copy)) bad.push(`the paragraph ${tid} the person added is neither in the result nor handed back`);
      continue;
    }
    if (x.text !== was.text && got?.text !== x.text && !named(refs, x.text)) bad.push(`the person's text of ${tid} is neither in the result nor handed back`);
    for (const k of ["bold", "style", "list"]) if (x[k] !== was[k] && got?.[k] !== x[k] && !named(refs)) bad.push(`the person's ${k} of ${tid} is neither in the result nor handed back`);
    if (x.where !== was.where && got?.where !== x.where && !named(refs) && !(named(["layout"]) && copy)) bad.push(`the person moved ${tid} from ${was.where} to ${x.where}; neither carried nor handed back`);
  }
  for (const [tid, was] of b) if (!m.has(tid) && r.has(tid) && !named([`b${was.ord}`]) && !(named(["layout"]) && copy)) bad.push(`the paragraph ${tid} the person deleted is still there, not handed back`);
  if (M.tables.join("\n") !== B.tables.join("\n") && R.tables.join("\n") !== M.tables.join("\n") && !(named(["layout"]) && copy) && M.tables.length === B.tables.length && M.tables.some((rows, i) => rows.length !== B.tables[i].length)) bad.push("the person's table rows are neither in the result nor handed back");
  for (const [tid, x] of t) {
    const was = b.get(tid);
    if (was && x.text !== was.text && m.get(tid)?.text === was.text && r.get(tid)?.text !== x.text) bad.push(`the agent's text of ${tid} is gone`);
  }
  return bad;
}

const MANY = Array.from({ length: 2001 }, () => ({ kind: "text" }));
test(`property, the rest of the document (${STRUCT_CASES} cases, seed ${SEED + 900_000}): tables, parts, formatting, rows, many edits: a correct merge or a clean refusal, never a silent loss`, async (t) => {
  const failures = [];
  const count = { merged: 0, handedBack: 0, refused: 0 };
  for (let k = 0; k < STRUCT_CASES && failures.length < 5; k++) {
    const seed = SEED + 900_000 + k;
    const c = makeStruct(seed);
    const [base, mine, theirs] = [c.base, c.mine, c.theirs].map(structBytes);
    const r = await mergeProven({ format: "docx", base, mine, theirs, name: "t.docx", edits: c.many ? MANY : [] });
    if (r.refused) {
      count.refused++;
      continue;
    }
    count[r.unplaced.length ? "handedBack" : "merged"]++;
    const bad = structUnbalanced(...[base, mine, theirs, r.bytes ?? theirs].map(structOf), r.unplaced, r.copy);
    if (bad.length) failures.push(`seed ${seed}: ${bad.join("; ")}`);
  }
  t.diagnostic(`merged ${count.merged}, handed back ${count.handedBack}, refused ${count.refused}`);
  assert.deepEqual(failures, []);
});
