import assert from "node:assert/strict";
import { test } from "node:test";
import { buildZip, contentTypes, docxBytes, xlsxBytes } from "./helpers/zipbuild.js";

// The budget of src/text.js (scanBudget) is only a bound if EVERY loop an anchor resolver runs over paragraphs, candidates, cells or
// shapes spends from it. An outside review found 50,000 identical paragraphs and 500 anchors (13 KB of file) held the thread for 3.9 s
// inside a 40,000,000 budget: the duplicate scans and a sort in locate() never spent. These tests count the work instead of timing it:
// every object a loop can touch (paragraph, cell, shape) is wrapped so each property read is counted, and the reads of a whole run must
// stay within a few per unit of the budget it was given. A loop that does not spend reads far more than that on these inputs.
const { scanBudget, textHash, watchBudget } = await import("../src/text.js");
const { readAll, readUnits, buildDurable, resolveDurableAny } = await import("../src/anchors.js");
const { resolveDurable } = await import("../src/docx.js");
const { xlsxDurable, resolveXlsx, parseWorkbook, rangeText } = await import("../src/xlsx.js");
const { exactHash } = await import("../src/text.js");
const { buildBatch } = await import("../src/batch.js");
const { resolvePptx } = await import("../src/pptx.js");

const READS_PER_UNIT = 8; // a charged unit covers at most a few property reads in any loop; 8 leaves margin and a free loop exceeds it by 100x

function counter() {
  const c = { n: 0 };
  c.wrap = (o) =>
    new Proxy(o, {
      get(t, k, r) {
        c.n++;
        return Reflect.get(t, k, r);
      },
    });
  return c;
}
const cpuMs = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
};

/** resolve every anchor in one budget of `budget`; the reads (after `warm`, which builds the per-reading indexes) must be within it */
function within(label, budget, c, resolve, anchors) {
  scanBudget(0, () => resolve(anchors[0])); // the indexes and caches built once per reading, not per anchor
  c.n = 0;
  const out = scanBudget(budget, () => anchors.map((a) => resolve(a)));
  assert.ok(c.n <= READS_PER_UNIT * budget, `${label}: ${c.n} property reads for a budget of ${budget} (limit ${READS_PER_UNIT * budget})`);
  return out;
}

const docxUnits = (c, texts) => {
  const u = readUnits("docx", docxBytes(texts));
  return u.paragraphs.map(c.wrap);
};
const dur = (extra = {}) => ({ format: "docx", paraId: "ABCDEF01", path: [0], paraText: "", quote: "", prefix: "", suffix: "", prevHash: null, nextHash: null, dupCount: 1, ...extra });

test("docx: 20,000 identical paragraphs and 300 anchors on them (the reviewer's shape) stay within the budget", () => {
  const T = "A repeated paragraph with identical text.";
  const c = counter();
  const ps = docxUnits(c, Array.from({ length: 20_000 }, () => T));
  const h = textHash(T);
  const anchors = Array.from({ length: 300 }, (_, j) => dur({ path: [(97 * j + 1) % 20_000], paraText: T, prevHash: h, nextHash: h, dupCount: 20_000 }));
  within("identical paragraphs", 2_000_000, c, (d) => resolveDurable(ps, d), anchors);
});

test("docx: a text repeated in hundreds of paragraphs, with a quote found in all of them, stays within the budget", () => {
  const c = counter();
  const ps = docxUnits(c, Array.from({ length: 20_000 }, (_, i) => `line ${i % 50} of the repeated report`));
  const h = (i) => textHash(`line ${i} of the repeated report`);
  const byText = Array.from({ length: 200 }, (_, j) => dur({ path: [j], paraText: "line 7 of the repeated report", prevHash: h(6), nextHash: h(8), dupCount: 400 }));
  const byQuote = Array.from({ length: 200 }, (_, j) => dur({ path: [j], quote: "repeated report", prefix: "of the" }));
  const byFuzzy = Array.from({ length: 200 }, (_, j) => dur({ path: [j], paraText: "line 7 of the repeated reports" }));
  within("duplicate hashes, by text", 2_000_000, c, (d) => resolveDurable(ps, d), byText);
  within("duplicate hashes, by quote", 2_000_000, c, (d) => resolveDurable(ps, d), byQuote);
  within("duplicate hashes, fuzzy", 2_000_000, c, (d) => resolveDurable(ps, d), byFuzzy);
});

test("docx: 20,000 paragraphs sharing one paragraph id stay within the budget", () => {
  const c = counter();
  const ps = docxUnits(c, Array.from({ length: 20_000 }, () => ({ text: "Same words in every paragraph.", paraId: "0000ABCD" })));
  const h = textHash("Same words in every paragraph.");
  const anchors = Array.from({ length: 300 }, (_, j) => dur({ paraId: "0000ABCD", path: [j], paraText: "Same words in every paragraph.", quote: "words", prevHash: h, nextHash: h, dupCount: 20_000 }));
  within("one id", 2_000_000, c, (d) => resolveDurable(ps, d), anchors);
});

test("xlsx: 40,000 equal cells in rows of 100, and anchors for a cell that moved, stay within the budget", () => {
  const c = counter();
  const cells = {};
  const letters = (n) => (n < 26 ? String.fromCharCode(65 + n) : String.fromCharCode(64 + Math.floor(n / 26)) + String.fromCharCode(65 + (n % 26)));
  for (let r = 1; r <= 400; r++) for (let k = 0; k < 100; k++) cells[`${letters(k)}${r}`] = "same";
  const u = readUnits("xlsx", xlsxBytes({ S: cells }));
  const sheet = u.wb.sheets[0];
  const sd = u.wb.sheetCells(sheet);
  const base = xlsxDurable(u.wb, { sheetIndex: 0, sheetName: "S", range: "C5" });
  resolveXlsx(u.wb, base); // the per-sheet caches (first cell of each column) are built once per reading
  for (const [k, cell] of sd.cells) sd.cells.set(k, c.wrap(cell));
  for (const [r, row] of sd.rows) sd.rows.set(r, row.map((cell) => sd.cells.get(`${cell.r},${cell.c}`) ?? c.wrap(cell)));
  const moved = (j) => ({ ...base, r0: 9000 + j, r1: 9000 + j, c0: 60, c1: 60 });
  const anchors = Array.from({ length: 200 }, (_, j) => moved(j));
  within("equal cells", 3_000_000, c, (d) => resolveXlsx(u.wb, d), anchors);
});

test("pptx: 5,000 shapes with the same name and text, and anchors for a shape that is gone, stay within the budget", () => {
  const c = counter();
  const sp = (i) => `<p:sp><p:nvSpPr><p:cNvPr id="${i + 2}" name="Box"/></p:nvSpPr><p:txBody><a:p><a:r><a:t>same text</a:t></a:r></a:p></p:txBody></p:sp>`;
  const bytes = buildZip({
    "[Content_Types].xml": contentTypes("pptx"),
    "ppt/presentation.xml": '<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>',
    "ppt/_rels/presentation.xml.rels": '<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/></Relationships>',
    "ppt/slides/slide1.xml": `<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree>${Array.from({ length: 5000 }, (_, i) => sp(i)).join("")}</p:spTree></p:cSld></p:sld>`,
  });
  const u = readUnits("pptx", bytes);
  u.deck.ensure();
  for (const s of u.deck.slides) s.shapes = s.shapes.map(c.wrap);
  const d = { format: "pptx", slideId: "256", shapeId: -1, shapeName: "Box", ordinal: 0, textHash: textHash("same text"), quote: "text", titleHash: "x" };
  within("equal shapes", 400_000, c, (x) => resolvePptx(u.deck, x), Array.from({ length: 200 }, () => d));
});

test("docx: the reviewer's exact case (50,000 identical paragraphs, 500 anchors, a 40,000,000 budget) takes well under a second of CPU", () => {
  const T = "A repeated paragraph with identical text.";
  const u = readUnits("docx", docxBytes(Array.from({ length: 50_000 }, () => T)));
  const h = textHash(T);
  const d = (j) => ({ format: "docx", paraId: "ABCDEF01", path: [99 * j + 1], paraText: T, quote: "", prefix: "", suffix: "", prevHash: h, nextHash: h, dupCount: 50_000 });
  let best = Infinity;
  for (let k = 0; k < 3; k++) {
    const t = cpuMs();
    const methods = scanBudget(40_000_000, () => Array.from({ length: 500 }, (_, j) => resolveDurableAny(u, d(j)).method));
    best = Math.min(best, cpuMs() - t);
    assert.ok(methods.includes("hash"), "the first anchors resolve by their text");
  }
  assert.ok(best < 750, `${best.toFixed(0)} ms of CPU (3.9 s of wall time before; measured about 80 ms after)`);
});

test("HIGH 4 (round 7): 50 comments on one cell of 31 million characters hash it once, not once per comment, and every character hashed is paid from the budget (5.0 s of CPU before)", () => {
  const bytes = xlsxBytes({ S: { A1: "a".repeat(31_000_000), B2: "x" } });
  // CPU of making and resolving `n` anchors on A1, each on a fresh reading (nothing kept from the run before), best of 3
  const run = (n) => {
    let ms = Infinity;
    let out;
    for (let k = 0; k < 3; k++) {
      const made = parseWorkbook(bytes);
      const read = parseWorkbook(bytes);
      for (const wb of [made, read]) wb.sheetCells(wb.sheets[0]);
      const t = cpuMs();
      const ds = scanBudget(40_000_000, () => Array.from({ length: n }, () => xlsxDurable(made, { sheetIndex: 0, range: "A1" })));
      out = scanBudget(40_000_000, () => ds.map((d) => resolveXlsx(read, d)));
      ms = Math.min(ms, cpuMs() - t);
    }
    return { ms, out };
  };
  const one = run(1);
  const fifty = run(50);
  assert.deepEqual([...new Set(fifty.out.map((r) => `${r.method} ${r.changed}`))], ["position false"], "every comment stays on its unchanged cell");
  // the load here runs 20 to 70: a ratio, with room. Per comment the old code hashed the whole cell twice (x50 the work of one).
  assert.ok(fifty.ms < 4 * one.ms + 100, `50 comments ${fifty.ms.toFixed(0)} ms, 1 comment ${one.ms.toFixed(0)} ms`);
  // a budget smaller than the cell: the cell is not hashed at all, and the comment resolves as moved or removed (never a wrong place)
  const wb = parseWorkbook(bytes);
  const d = xlsxDurable(wb, { sheetIndex: 0, range: "A1" });
  const fresh = parseWorkbook(bytes);
  assert.equal(scanBudget(1_000_000, () => resolveXlsx(fresh, d)).method, "none");
  assert.equal(fresh.sheetCells(fresh.sheets[0]).cells.values().next().value.h, undefined, "nothing hashed past the budget");
});

// ---- round 8: making anchors is paid like resolving them, in every format, by the work the text really costs ----------------------
// The reviewer: 50 comments on A1:B1 through A1:AY1 of a cell of 31 million "é" (within every reader cap) took 6.85 s on the server's
// thread to make (6.63 s of CPU; the same in ASCII 1.83 s): each distinct range joined and hashed the cell, and an anchor being made was
// charged whatever was left and went on. A recorder sees every spend: none happens outside a budget, none is allowed past what is left,
// and the CPU of making and of resolving 50 anchors on one huge unit stays near that of 5 (it grows with the budget, never with anchors
// times the text). Each case runs in ASCII, in "é" (V8 keeps such text two bytes a character), in CJK and in decomposed letters.
const BUDGET = 40_000_000; // src/session.js SCAN_BUDGET
const SCRIPTS = { ascii: "a", latin: "é", cjk: "中", decomposed: "é" };
const huge = (ch, n) => ch.repeat(Math.floor(n / ch.length));
const colName = (n) => (n < 26 ? String.fromCharCode(65 + n) : String.fromCharCode(64 + Math.floor(n / 26)) + String.fromCharCode(65 + (n % 26)));

function recorder() {
  const r = { spent: 0, refused: 0, outside: 0 };
  watchBudget((n, ok, outside) => {
    if (outside) r.outside++;
    else if (ok) r.spent += n;
    else r.refused++;
  });
  return r;
}

const pptx8 = (text) => buildZip({
  "[Content_Types].xml": contentTypes("pptx"),
  "ppt/presentation.xml": '<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>',
  "ppt/_rels/presentation.xml.rels": '<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/></Relationships>',
  "ppt/slides/slide1.xml": `<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="Box"/></p:nvSpPr><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
});

// per format: the file, and the browser's anchor for comment i of n (distinct ranges or selections on the one huge unit)
const CASES = {
  // the reviewer's 31 million characters, within the reader's 64 MB a part (CJK: 20 million, 60 MB of UTF-8)
  xlsx: { size: (ch) => Math.min(31_000_000, Math.floor(60_000_000 / (Buffer.byteLength(ch) / ch.length))), bytes: (t) => xlsxBytes({ S: { A1: t } }), anchor: (t, i) => ({ location: { sheetIndex: 0, sheetName: "S", range: `A1:${colName(i + 1)}1` } }) },
  docx: {
    size: () => 7_900_000, // the reader's cap is 8 million characters of text
    bytes: (t) => docxBytes([t, "The next paragraph."]),
    // a selection inside the paragraph; the whole paragraph (the page sends its text as paraText and quote); a short quote the
    // paragraph does not hold (V8 searches a short needle position by position: 50 of them held the thread 9.3 s, charged a 64th)
    anchor: (t, i) => {
      if (i % 3 === 1) return { location: { blockPath: [0] }, quote: t, paraText: t, prefix: "", suffix: "" };
      if (i % 3 === 2) return { location: { blockPath: [0] }, quote: `${t.slice(0, 2 * (1 + (i % 4)))}z`, prefix: "", suffix: "" };
      const at = Math.floor(((i + 1) * t.length) / 60) & ~1;
      return { location: { blockPath: [0], start: at, end: at + 20 }, quote: t.slice(at, at + 20), prefix: t.slice(at - 40, at), suffix: t.slice(at + 20, at + 60) };
    },
  },
  pptx: {
    size: () => 7_900_000,
    bytes: pptx8,
    anchor: (t, i) => {
      const at = Math.floor(((i + 1) * t.length) / 60) & ~1;
      return { location: { slideIndex: 0, shapeId: 2 }, quote: i % 2 ? t : t.slice(at, at + 20), prefix: t.slice(at - 40, at), suffix: t.slice(at + 20, at + 60) };
    },
  },
};

for (const [format, C] of Object.entries(CASES)) {
  test(`round 8: ${format}: making and resolving 50 anchors on one huge unit costs about what 5 do, in every script, and every spend is within the budget`, { timeout: 240_000 }, () => {
    const rows = [];
    for (const [script, ch] of Object.entries(SCRIPTS)) {
      const text = huge(ch, C.size(ch));
      const bytes = C.bytes(text);
      const run = (n) => {
        let ms = Infinity;
        let out = null;
        for (let k = 0; k < 3; k++) {
          const made = readAll(readUnits(format, bytes)); // fresh readings: nothing kept from the run before
          const read = readAll(readUnits(format, bytes));
          const rec = recorder();
          const t = cpuMs();
          let ds, rs;
          try {
            ds = scanBudget(BUDGET, () => Array.from({ length: n }, (_, i) => buildDurable(made, C.anchor(text, i))));
            rs = scanBudget(BUDGET, () => ds.map((d) => resolveDurableAny(read, d)));
          } finally {
            watchBudget(null);
          }
          ms = Math.min(ms, cpuMs() - t);
          out = { ds, rs, rec };
        }
        return { ms, ...out };
      };
      const five = run(5);
      const fifty = run(50);
      const placed = fifty.rs.filter((r) => r.method !== "none").length;
      rows.push(`${script} 5: ${five.ms.toFixed(0)} ms, 50: ${fifty.ms.toFixed(0)} ms, ${placed} of 50 placed`);
      assert.equal(fifty.rec.outside, 0, `${format} ${script}: a spend outside any budget`);
      assert.ok(fifty.rec.spent <= 2 * BUDGET, `${format} ${script}: ${fifty.rec.spent} spent from two budgets of ${BUDGET}`);
      // every comment still goes out with an anchor (the weaker one past the budget), never dropped
      assert.equal(fifty.ds.filter(Boolean).length, 50, `${format} ${script}: every comment has an anchor`);
      // the load here runs 20 to 70: a ratio with room, and an absolute bound well under the 6.6 s the reviewer measured
      assert.ok(fifty.ms < 3 * five.ms + 100, `${format} ${script}: 50 anchors ${fifty.ms.toFixed(0)} ms, 5 anchors ${five.ms.toFixed(0)} ms`);
      // a cell or a shape found by its address or id is still placed when its text costs more than the budget (a Word paragraph without
      // a paragraph id is found only by its text: past the budget it shows as moved or removed, docs/contracts/anchors.md)
      if (format !== "docx") assert.equal(placed, 50, `${format} ${script}: ${placed} of 50 placed`);
      assert.ok(fifty.ms < 1500, `${format} ${script}: 50 anchors took ${fifty.ms.toFixed(0)} ms of CPU`);
    }
    console.log(`${format}: ${rows.join("; ")}`);
  });
}

test("round 8: an anchor the budget cannot pay for whole goes out weaker, never dropped: the address and context, no text hash, the reply asks for full ops", { timeout: 120_000 }, () => {
  const bytes = xlsxBytes({ S: { A1: "é".repeat(31_000_000), A2: "below", B1: "right" } });
  const wb = parseWorkbook(bytes);
  const d = scanBudget(BUDGET, () => xlsxDurable(wb, { sheetIndex: 0, sheetName: "S", range: "A1:B1" }));
  assert.equal(d.cell, true);
  assert.equal(d.range, "A1:B1");
  assert.equal(d.textHash, null, "the cell is not hashed: 124 million units of work for a budget of 40 million");
  assert.equal(d.rangeHash, null);
  assert.equal(d.text, `${"é".repeat(1000)}\tright`, "what the batch can show of it is kept (src/xlsx.js CELL_KEEP), nothing more");
  assert.equal(d.values[0][0].length, 1000);
  // resolved later by its address and context, never by a hash it does not have
  const fresh = parseWorkbook(bytes);
  const r = scanBudget(BUDGET, () => resolveXlsx(fresh, d));
  assert.equal(r.method, "position");
  assert.equal(r.range, "A1:B1");
  assert.equal(r.changed, false);
  // a range that fits is hashed exactly as apply hashes the joined text
  const small = parseWorkbook(xlsxBytes({ S: { A1: "x́", B1: "y", A2: "z" } }));
  const s = scanBudget(BUDGET, () => xlsxDurable(small, { sheetIndex: 0, sheetName: "S", range: "A1:B2" }));
  assert.equal(s.rangeHash, exactHash("x́\ty\nz\t"));
  assert.equal(s.rangeHash, exactHash(rangeText(small.sheetCells(small.sheets[0]), { r0: 0, c0: 0, r1: 1, c1: 1 })));
  // the batch: the comment is there, its anchor names the range, and the agent is offered full ops (no hash to check a `set` against)
  const batch = buildBatch({ file: "/tmp/x.xlsx", format: "xlsx", baseSha: "0".repeat(64), note: "", comments: [{ id: "c1", kind: "element", text: "fix this", durable: d }], edits: [] });
  assert.equal(batch.instructions.comments.length, 1);
  assert.equal(batch.instructions.comments[0].reply_with, "ops");
  const a = batch.untrusted_document_evidence.anchors[0];
  assert.deepEqual([a.resolved, a.unit, a.locator.range, a.locator.text_hash], [true, "range", "A1:B1", null]);
  assert.equal(a.values[0][0].length, 200);
  assert.equal(a.values[0][1], "right");
});

test("round 10: an anchor without its range hash still reads as changed when the text it kept differs", () => {
  const book = (b1) => parseWorkbook(xlsxBytes({ S: { A1: "x", B1: b1, A2: "z", B2: "w" } }));
  const d = scanBudget(50, () => xlsxDurable(book("y"), { sheetIndex: 0, sheetName: "S", range: "A1:B2" })); // the walk is paid, the hash is not
  assert.equal(d.rangeHash, null);
  assert.equal(d.text, "x\ty\nz\tw");
  assert.equal(scanBudget(BUDGET, () => resolveXlsx(book("y"), d)).changed, false);
  const r = scanBudget(BUDGET, () => resolveXlsx(book("edited"), d));
  assert.deepEqual([r.method, r.range, r.changed], ["position", "A1:B2", true]); // d4ecd1e: false
  // an anchor whose walk was not paid either kept no text: there is nothing to compare, so it is not called changed
  const bare = scanBudget(10, () => xlsxDurable(book("y"), { sheetIndex: 0, sheetName: "S", range: "A1:B2" }));
  assert.deepEqual([bare.rangeHash, bare.text, bare.values], [null, "", []]);
  assert.equal(scanBudget(BUDGET, () => resolveXlsx(book("y"), bare)).changed, false);
});

test("round 8 (found while testing): a selection that starts between two listed occurrences of its own text resolves, never loops (\"aa\" at offset 1 of \"aaaaaa\" held the thread forever)", () => {
  const u = readUnits("docx", docxBytes(["aaaaaa", "Next."]));
  const d = scanBudget(BUDGET, () => buildDurable(u, { location: { blockPath: [0], start: 1, end: 3 }, quote: "aa", prefix: "a", suffix: "aaa" }));
  assert.equal(d.start, 1);
  assert.equal(d.nth, null, "not an index of the occurrences the search lists (it was stored as -1)");
  const r = scanBudget(BUDGET, () => resolveDurableAny(readUnits("docx", docxBytes(["aaaaaa", "Next."])), { ...d, nth: -1 })); // as an earlier version stored it
  assert.equal(r.method, "hash", "the paragraph by its text, then the selection's offsets in it");
  assert.ok(Number.isInteger(r.start));
});

// ---- round 9: a search is priced by what it costs on the text at hand ---------------------------------------------------------------
// Round 8 charged every 2-to-8-character needle 8 units a character (its worst case, a first character that matches everywhere): on a long
// Word file without paragraph ids, 50 comments quoting one word in paragraphs the agent changed (and the paragraphs around them) were
// none of them found again. A search is now priced by the places V8 checks (src/text.js hitsOf), and the paragraphs are read nearest first.
test("round 9: 50 one-word and 50 phrase comments on a long Word file without paragraph ids, each paragraph and its neighbors changed, are all found again", { timeout: 240_000 }, () => {
  let seed = 7;
  const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff;
  const vocab = "the of and to a in that is for it as was with be by on not he this are or his from at which but have an they you were her she there been one all we their has would when if so no what out up more said into about them some could time these two may then do first any my now such like other how over people than only very made after years work most where through back much before good great report revenue customer quarter growth market".split(" ");
  const paras = Array.from({ length: 26_000 }, (_, i) => `${Array.from({ length: 12 + Math.floor(rnd() * 20) }, () => vocab[Math.floor(rnd() * vocab.length)]).join(" ")} item ${i}.`);
  const picks = Array.from({ length: 50 }, (_, j) => 300 + j * 500);
  const made = readUnits("docx", docxBytes(paras));
  const edited = paras.slice();
  for (const i of picks) for (const k of [i - 1, i, i + 1]) edited[k] = edited[k].replace(/item (\d+)\.$/, "item $1, changed by the agent.");
  for (const len of [0, 30]) {
    const anchors = picks.map((i) => {
      const t = paras[i];
      const m = [...t.matchAll(/\b[a-z]{4,}\b/g)][1];
      const at = len ? t.indexOf(" ", Math.floor(t.length / 3)) + 1 : m.index; // a phrase from a word start (a quote is kept trimmed)
      const end = len ? at + len : at + m[0].length;
      return { location: { blockPath: [i], start: at, end }, quote: t.slice(at, end), prefix: t.slice(Math.max(0, at - 40), at), suffix: t.slice(end, end + 40) };
    });
    const ds = scanBudget(BUDGET, () => anchors.map((a) => buildDurable(made, a)));
    const read = readUnits("docx", docxBytes(edited));
    const rs = scanBudget(BUDGET, () => ds.map((d) => resolveDurableAny(read, d)));
    const found = rs.filter((r, j) => r.ordinal === picks[j] && r.start === anchors[j].location.start).length;
    assert.equal(found, 50, `${len ? `${len}-character quotes` : "one-word quotes"}: ${found} of 50 found again (${[...new Set(rs.map((r) => r.method))]})`);
  }
});

test("round 9: a one-character quote in a paragraph of 7.9 million CJK characters is charged a place for every character V8 checks (charged a 16th of one before: 50 took 1.2 s to make)", () => {
  // what making the anchor spends, for a quote "丁" (U+4E01: absent, but its larger byte, 0x4E, is the high byte of every "中", U+4E2D,
  // so memchr stops at every character) and for "z" (0x7A: no character holds that byte)
  const spent = (quote) => {
    let n = 0;
    watchBudget((k, ok) => ok && (n += k));
    try {
      scanBudget(1e12, () => buildDurable(readUnits("docx", docxBytes(["中".repeat(7_900_000), "Next."])), { location: { blockPath: [0] }, quote, prefix: "", suffix: "" }));
    } finally {
      watchBudget(null);
    }
    return n;
  };
  const extra = spent("丁") - spent("z");
  assert.ok(extra >= 2 * 7_900_000, `"丁" costs ${extra} units more than "z"`);
});

test("round 9: ASCII text in a file that holds one CJK character is kept two bytes a character: a one-character quote above 255 that shares a byte with it is charged per character", () => {
  // "š" (U+0161): its larger byte, 0x61, is every "a" of the paragraph once V8 holds the file's text two bytes a character
  const spent = (quote) => {
    let n = 0;
    watchBudget((k, ok) => ok && (n += k));
    try {
      scanBudget(1e12, () => buildDurable(readUnits("docx", docxBytes(["a".repeat(2_000_000), "中"])), { location: { blockPath: [0] }, quote, prefix: "", suffix: "" }));
    } finally {
      watchBudget(null);
    }
    return n;
  };
  const extra = spent("š") - spent("z");
  assert.ok(extra >= 2 * 2_000_000, `"š" costs ${extra} units more than "z"`);
});
