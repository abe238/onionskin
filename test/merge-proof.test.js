import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { docxBytes, rezip, xlsxBytes } from "./helpers/zipbuild.js";
import { ENGINE_SAMPLES as SAMPLES, haveSamples, skipUnless } from "../scripts/fixtures.mjs";
import { mergeDocx } from "../src/merge.js";
import { mergePptx } from "../src/merge-pptx.js";
import { mergeXlsx } from "../src/merge-xlsx.js";
import { proveMerge } from "../src/merge-proof.js";
import { work } from "../src/merge-worker.js";
import { readDocxParagraphs } from "../src/docx.js";
import { runOps } from "../src/ops/run.js";

// The proof after every merge (src/merge-proof.js, run by src/merge-worker.js): every difference between the base and the person's
// version is in the result at the same paragraph, shape or cell, or handed back by an entry that names it; nothing the agent wrote is
// lost and nothing nobody wrote appears. Each case is checked twice: the proof alone on the result the merge gave on f4935ec (it must
// refuse), and the real merge now (it must balance). Real DOCX, XLSX and PPTX bytes, the real op engine.

const pid = (n) => String(n).padStart(8, "0");
const W14 = (inner, id) => `<w:p${id == null ? "" : ` w14:paraId="${pid(id)}"`}>${inner}</w:p>`;
const run = (t) => `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>`;
/** a DOCX whose paragraphs are [inner XML of the runs, id]; `run(t)` is plain text */
const doc = (list) => docxBytes([], {}, list.map(([inner, id]) => W14(inner, id)).join(""));
const plain = (list) => doc(list.map(([t, id]) => [run(t), id]));
const texts = (bytes) => readDocxParagraphs(bytes).map((p) => p.text);
const prove = (format, base, mine, theirs, r) => proveMerge(format, { base, mine, theirs, merged: r.bytes ?? theirs, unplaced: r.unplaced, copy: !!r.copy });
const docxMerge = async (base, mine, theirs) => {
  const r = await mergeDocx({ base, mine, theirs, name: "t.docx", runOps });
  return { r, why: prove("docx", base, mine, theirs, r) };
};

test("HIGH B: a paragraph the person moved and edited, ids kept: the f4935ec result is refused by the proof alone; the merge now carries both", async () => {
  const base = plain([["A", 1], ["B", 2], ["C", 3], ["D", 4]]);
  const mine = plain([["B", 2], ["C", 3], ["A2", 1], ["D", 4]]);
  const theirs = plain([["A", 1], ["B", 2], ["C", 3], ["D2", 4]]);
  // what f4935ec answered: [A2, B, C, D2], merged 1, nothing handed back
  const old = prove("docx", base, mine, theirs, { bytes: plain([["A2", 1], ["B", 2], ["C", 3], ["D2", 4]]), unplaced: [] });
  assert.match(old ?? "", /moves neither carried nor handed back: 1/);
  const { r, why } = await docxMerge(base, mine, theirs);
  assert.equal(why, null);
  assert.deepEqual(texts(r.bytes), ["B", "C", "A2", "D2"]);
  // two paragraphs swapped and both edited
  const b2 = plain([["One", 1], ["Two", 2], ["Three", 3]]);
  const m2 = plain([["Two edited", 2], ["One edited", 1], ["Three", 3]]);
  const t2 = plain([["One", 1], ["Two", 2], ["Three by the agent", 3]]);
  assert.match(prove("docx", b2, m2, t2, { bytes: plain([["One edited", 1], ["Two edited", 2], ["Three by the agent", 3]]), unplaced: [] }) ?? "", /moves neither carried nor handed back/);
  const swapped = await docxMerge(b2, m2, t2);
  assert.equal(swapped.why, null);
  assert.deepEqual(texts(swapped.r.bytes), ["Two edited", "One edited", "Three by the agent"]);
});

test("HIGH C: white space typed into a paragraph (a line break, two spaces, a leading or trailing space, a tab) is carried or refused, never dropped", async () => {
  const cases = [
    ["a line break", run("A") + "<w:r><w:br/></w:r>" + run("B")],
    ["two spaces", run("A  B")],
    ["a leading space", run(" A B")],
    ["a trailing space", run("A B ")],
    ["a tab", run("A") + "<w:r><w:tab/></w:r>" + run("B")],
  ];
  const base = plain([["A B", 1], ["C", 2]]);
  const theirs = plain([["A B", 1], ["C2", 2]]);
  for (const [what, inner] of cases) {
    const mine = doc([[inner, 1], [run("C"), 2]]);
    const raw = readDocxParagraphs(mine)[0].text;
    assert.notEqual(raw, "A B", `${what}: the fixture differs from the base as written`);
    // f4935ec: nothing written, nothing handed back
    assert.match(prove("docx", base, mine, theirs, { bytes: null, unplaced: [] }) ?? "", /text edits neither carried nor handed back: 1/, what);
    const { r, why } = await docxMerge(base, mine, theirs);
    assert.equal(why, null, what);
    assert.deepEqual(texts(r.bytes), [raw, "C2"], what);
  }
  // the agent changed only white space in the paragraph the person typed in: a conflict, handed back, not overwritten
  const agentSpace = plain([["A  B", 1], ["C", 2]]);
  const mine = plain([["A B and more", 1], ["C", 2]]);
  const { r, why } = await docxMerge(base, mine, agentSpace);
  assert.equal(why, null);
  assert.equal(r.bytes, null);
  assert.deepEqual(r.unplaced.map((u) => u.text), ["A B and more"]);
});

test("the proof counts copies: two inserted copies of one paragraph are two edits; the agent's text and untouched paragraphs are guarded", async () => {
  const base = plain([["Alpha paragraph of the plan.", 1], ["Beta paragraph of the plan.", 2], ["Gamma paragraph of the plan.", 3]]);
  const mine = doc([[run("Alpha paragraph of the plan."), 1], [run("Same new line."), 7], [run("Beta paragraph of the plan."), 2], [run("Same new line."), 8], [run("Gamma paragraph of the plan."), 3]]);
  const theirs = plain([["Alpha paragraph of the plan.", 1], ["Beta paragraph, as the agent wrote it.", 2], ["Gamma paragraph of the plan.", 3]]);
  const { r, why } = await docxMerge(base, mine, theirs);
  assert.equal(why, null);
  assert.deepEqual(texts(r.bytes), ["Alpha paragraph of the plan.", "Same new line.", "Beta paragraph, as the agent wrote it.", "Same new line.", "Gamma paragraph of the plan."]);
  const oneCopy = docxBytes(["Alpha paragraph of the plan.", "Same new line.", "Beta paragraph, as the agent wrote it.", "Gamma paragraph of the plan."]);
  assert.match(prove("docx", base, mine, theirs, { bytes: oneCopy, unplaced: [] }) ?? "", /added paragraphs neither carried nor handed back: 1/);
  // the agent's text overwritten: refused even when the person's edit is listed
  const overwritten = plain([["Alpha paragraph of the plan.", 1], ["Beta paragraph of the plan.", 2], ["Gamma paragraph of the plan.", 3]]);
  assert.match(prove("docx", base, mine, theirs, { bytes: overwritten, unplaced: [{ text: "Same new line.", of: ["m1", "m3"] }] }) ?? "", /the agent's paragraphs changed into text neither side wrote there/);
  // the person's text in a paragraph neither side changed
  const foreign = plain([["Same new line.", 1], ["Beta paragraph, as the agent wrote it.", 2], ["Gamma paragraph of the plan.", 3]]);
  assert.match(prove("docx", base, mine, theirs, { bytes: foreign, unplaced: [{ text: "Same new line.", of: ["m1", "m3"] }] }) ?? "", /changed into text neither side wrote there/);
  // a paragraph in the wrong place: the person's new line under Gamma instead of under Alpha
  const late = doc([[run("Alpha paragraph of the plan."), 1], [run("Beta paragraph, as the agent wrote it."), 2], [run("Same new line."), null], [run("Gamma paragraph of the plan."), 3], [run("Same new line."), null]]);
  assert.match(prove("docx", base, mine, theirs, { bytes: late, unplaced: [] }) ?? "", /added paragraphs out of place: 2/);
});

test("formatting: a change the person made is in the result or handed back; the f4935ec kind of silence is refused", async () => {
  const center = '<w:pPr><w:jc w:val="center"/></w:pPr>';
  const base = plain([["This paragraph reports the quarterly revenue.", 1], ["Second.", 2]]);
  const mine = doc([[center + run("This paragraph reports the quarterly revenue."), 1], [run("Second."), 2]]);
  const theirs = plain([["This paragraph reports the quarterly revenue.", 1], ["Second, by the agent.", 2]]);
  const { r, why } = await docxMerge(base, mine, theirs);
  assert.equal(why, null);
  assert.equal(readDocxParagraphs(r.bytes, { detail: true })[0].align, "center");
  assert.match(prove("docx", base, mine, theirs, { bytes: null, unplaced: [] }) ?? "", /formatting changes neither carried nor handed back: 1/);
  assert.equal(prove("docx", base, mine, theirs, { bytes: null, unplaced: [{ text: "", of: ["m0"] }] }), null, "handed back by an entry that names the paragraph");
});

test("XLSX: a value neither in the result nor handed back is refused; a whole sheet handed back counts only with the person's file kept", async () => {
  const base = xlsxBytes({ S: { A1: "Item", B1: 10, B2: 20 } });
  const mine = xlsxBytes({ S: { A1: "Item", B1: 11, B2: 20 } });
  const theirs = xlsxBytes({ S: { A1: "Item", B1: 12, B2: 20 } });
  // no record of how the agent wrote the file: the sheet is handed back whole, with a copy of the person's file
  const r = await mergeXlsx({ base, mine, theirs, name: "t.xlsx", runOps });
  assert.deepEqual([r.copy, r.unplaced.map((u) => u.text)], [true, ["B1: 11"]]);
  assert.equal(prove("xlsx", base, mine, theirs, r), null);
  assert.match(prove("xlsx", base, mine, theirs, { ...r, unplaced: [] }) ?? "", /value edits neither carried nor handed back: 1/);
  assert.match(prove("xlsx", base, mine, theirs, { ...r, copy: false }) ?? "", /value edits neither carried nor handed back: 1/, "the line lists the value, but only the copy holds it whole");
  // a result that changed a cell nobody changed
  const bent = xlsxBytes({ S: { A1: "Item", B1: 12, B2: 21 } });
  assert.match(prove("xlsx", base, mine, theirs, { bytes: bent, unplaced: r.unplaced, copy: true }) ?? "", /the agent's cells changed into values neither side wrote there: 1/);
  // the agent left the sheet as it was: the value is carried, and the proof reads it back from the result
  const carried = await mergeXlsx({ base, mine, theirs: base, name: "t.xlsx", runOps });
  assert.equal(carried.merged, 1);
  assert.equal(prove("xlsx", base, mine, base, carried), null);
  assert.match(prove("xlsx", base, mine, base, { bytes: base, unplaced: [] }) ?? "", /value edits neither carried nor handed back: 1/);
});

const SKIP = skipUnless(haveSamples(), `engine samples not found in ${SAMPLES}`, "restore test/fixtures/engine or set ONIONSKIN_TEST_SAMPLES");
test("PPTX: shape text neither in the result nor handed back is refused; the real merge balances", { skip: SKIP }, async () => {
  const BASE = fs.readFileSync(path.join(SAMPLES, "sample.pptx"));
  const edit = (from, to) => rezip(BASE, { "ppt/slides/slide2.xml": (xml) => (assert.ok(xml.includes(from)), xml.replace(from, to)) });
  const mine = edit("Lazy ZIP", "Lazy archive");
  const theirs = edit("Virtualized React views", "Virtualized views");
  const r = await mergePptx({ base: BASE, mine, theirs, name: "t.pptx", runOps });
  assert.equal(prove("pptx", BASE, mine, theirs, r), null);
  assert.match(prove("pptx", BASE, mine, theirs, { ...r, unplaced: [] }) ?? "", /text edits neither carried nor handed back: 1/);
  const apart = edit("Why it is fast", "Why it is so fast");
  const r2 = await mergePptx({ base: BASE, mine: apart, theirs, name: "t.pptx", runOps });
  assert.equal(r2.merged, 1);
  assert.equal(prove("pptx", BASE, apart, theirs, r2), null);
  assert.match(prove("pptx", BASE, apart, theirs, { bytes: null, unplaced: [] }) ?? "", /text edits neither carried nor handed back: 1/);
});

test("the merge worker runs the proof on every answer: a merge that loses an edit returns no file and a reason without document text", async () => {
  const P = ["Paragraph one of the plan, as sent.", "Paragraph two of the plan, as sent.", "Paragraph three of the plan, as sent."];
  const base = docxBytes(P);
  const mine = docxBytes([P[0], "Paragraph two, as I edited it, secret words.", P[2]]);
  const theirs = docxBytes([P[0], "Paragraph two, as the agent rewrote it.", P[2]]);
  const job = { format: "docx", base, mine, theirs, name: "t.docx", edits: [], agent: null };
  const ok = await work(job);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.unplaced.map((u) => Object.keys(u).sort()), [["label", "text", "why"]], "the proof's refs stay in the worker");
  process.env.ONIONSKIN_TEST_MERGE_FORGET = "1";
  try {
    const bad = await work(job);
    assert.deepEqual(Object.keys(bad), ["refused"]);
    assert.match(bad.refused, /^text edits neither carried nor handed back: 1$/);
    assert.ok(!/secret|Paragraph/.test(bad.refused), "no document text in the reason");
  } finally {
    delete process.env.ONIONSKIN_TEST_MERGE_FORGET;
  }
});

test("the proof is linear: twice the paragraphs take about twice its CPU time (best of 3)", async () => {
  const make = (n, suffix = "") => docxBytes(Array.from({ length: n }, (_, i) => ({ paraId: (0x10000000 + i).toString(16).toUpperCase(), text: `Paragraph number ${i} of the text${suffix}` })));
  const time = async (n) => {
    const [base, mine] = [make(n), make(n, ", edited")];
    const theirs = base;
    const r = await mergeDocx({ base, mine, theirs, name: "t.docx", runOps });
    let best = Infinity;
    for (let k = 0; k < 3; k++) {
      const u = process.cpuUsage();
      assert.equal(proveMerge("docx", { base, mine, theirs, merged: r.bytes, unplaced: r.unplaced, read: r.read }), null);
      const d = process.cpuUsage(u);
      best = Math.min(best, (d.user + d.system) / 1000);
    }
    return best;
  };
  const a = await time(5000);
  const b = await time(10000);
  assert.ok(b / Math.max(a, 5) < 3, `5,000 paragraphs: ${a.toFixed(0)} ms, 10,000: ${b.toFixed(0)} ms`);
});

test("found by the proof on test/fixtures: a short table cell retyped stays in its cell with its formatting (it was deleted and a new paragraph put in the body)", async () => {
  const base = fs.readFileSync(new URL("./fixtures/lo-tracked/cell-edit.docx", import.meta.url));
  const P = readDocxParagraphs(base, { detail: true });
  const cell = P.find((p) => p.path?.length === 4 && p.text === "Item");
  const other = P.find((p) => p.path?.length === 4 && p.text !== "Item" && /\w{4,}/.test(p.text));
  const edit = async (p, find, replace) => (await runOps({ bytes: base, format: "docx", name: "t.docx", ops: [{ op: "replace_text", target: { body_path: p.path, text_hash: p.hash }, expect: { text_hash: p.hash }, find, replace }] })).bytes;
  const mine = await edit(cell, "Item", "Mine");
  const theirs = await edit(other, /\w{4,}/.exec(other.text)[0], "Agent");
  const { r, why } = await docxMerge(base, mine, theirs);
  assert.equal(why, null);
  assert.equal(r.merged, 1);
  const out = readDocxParagraphs(r.bytes, { detail: true }).find((p) => p.text === "Mine");
  assert.deepEqual(out.path, cell.path, "in its cell");
  assert.deepEqual([out.style, out.align, out.ppr, JSON.stringify(out.spans)], [cell.style, cell.align, cell.ppr, JSON.stringify(cell.spans)], "with its formatting");
});

test("a line that only asks to check the formatting accounts for formatting, never for a move: the f4935ec result of HIGH B with such a line is refused", () => {
  const base = plain([["A", 1], ["B", 2], ["C", 3], ["D", 4]]);
  const mine = plain([["B", 2], ["C", 3], ["A2", 1], ["D", 4]]);
  const theirs = plain([["A", 1], ["B", 2], ["C", 3], ["D2", 4]]);
  const old = plain([["A2", 1], ["B", 2], ["C", 3], ["D2", 4]]);
  assert.match(prove("docx", base, mine, theirs, { bytes: old, unplaced: [{ text: "", why: "Your move was carried over. Check the formatting.", of: ["m2", "b0"], check: true }] }) ?? "", /moves neither carried nor handed back: 1/);
  assert.equal(prove("docx", base, mine, theirs, { bytes: old, unplaced: [{ text: "", why: "You moved this paragraph, but the move was not carried over.", of: ["m2", "b0"] }] }), null, "a line that says the move was not carried accounts for it");
});
