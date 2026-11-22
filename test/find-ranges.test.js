import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { docxBytes, rezip, xlsxBytes } from "./helpers/zipbuild.js";
import { ENGINE_SAMPLES, haveSamples, skipUnless } from "../scripts/fixtures.mjs";

// replace_all_text with match_case off reads offsets from a folded copy of the text; they must be offsets into the ORIGINAL text.
// toLowerCase of "İ" (U+0130) is two units, so a match after it used to land one character to the right: "İ ab" with find "a"
// became "İ aZ", the "b" destroyed, reported as applied. No file leaves the temp dirs and nothing is written to disk.
process.env.ONIONSKIN_NO_SOFFICE = "1";
const { findRanges, findAll, foldCase, replaceRanges, partialWords } = await import("../src/ops/runs.js");
const { runOps } = await import("../src/ops/run.js");
const { readDocxParagraphs } = await import("../src/docx.js");
const { openZip } = await import("../src/zip.js");

const TRICKY = "İ ß ﬁ ς Σ ΐ ΰ é é 😀 𐐀 𐐨 K k a b A B x y I i".split(" ").concat(["", "́", " "]);

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The slow, obviously right reading: leftmost match at a character boundary, ending at a character boundary, folds equal. */
function reference(text, find) {
  const needle = foldCase(find);
  const bounds = [0];
  let p = 0;
  for (const ch of text) bounds.push((p += ch.length));
  const out = [];
  for (let i = 0; i < bounds.length - 1; ) {
    let hit = null;
    for (let j = i + 1; j < bounds.length && !hit; j++) {
      const f = foldCase(text.slice(bounds[i], bounds[j]));
      if (f === needle) hit = { start: bounds[i], end: bounds[j] };
      else if (f.length >= needle.length) break;
    }
    if (hit) (out.push(hit), (i = bounds.indexOf(hit.end)));
    else i++;
  }
  return out;
}

const swapCase = (s) => [...s].map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join("");

test("findRanges: randomized over characters whose folding or normalization changes length (seed 20261116)", () => {
  const rand = rng(20261116);
  const pick = () => TRICKY[Math.floor(rand() * TRICKY.length)];
  let withMatch = 0;
  for (let n = 0; n < 6000; n++) {
    let text = "";
    for (let k = Math.floor(rand() * 12); k >= 0; k--) text += pick();
    const chars = [...text];
    const i = Math.floor(rand() * (chars.length + 1));
    const j = Math.min(chars.length, i + 1 + Math.floor(rand() * 4));
    let find = chars.slice(i, j).join("");
    if (!find) continue;
    if (rand() < 0.5) find = swapCase(find);
    const where = JSON.stringify({ n, text, find });
    const got = findRanges(text, find, false);
    assert.deepEqual(got, reference(text, find), `ranges differ from the reference: ${where}`);
    let last = 0;
    for (const { start, end } of got) {
      assert.ok(start >= last && end > start && end <= text.length, `range out of order or bounds: ${where}`);
      last = end;
      // never inside a surrogate pair
      assert.ok(!/[\udc00-\udfff]/.test(text[start] ?? "") || /[\ud800-\udbff]/.test(text[start - 1] ?? "") === false, `starts inside a surrogate pair: ${where}`);
      assert.equal(foldCase(text.slice(start, end)), foldCase(find), `the matched text does not fold to the find text: ${where}`);
      // replacing the match changes exactly that substring
      const out = text.slice(0, start) + "<>" + text.slice(end);
      assert.equal(out.slice(0, start), text.slice(0, start), where);
      assert.equal(out.slice(start + 2), text.slice(end), where);
    }
    assert.deepEqual(findAll(text, find, false), got.map((r) => r.start), where);
    if (got.length) withMatch++;
  }
  assert.ok(withMatch > 1500, `the generator found a match in only ${withMatch} cases`);
});

test("findRanges: a match inside one character's folding is not reported; the reviewer's two inputs", () => {
  assert.deepEqual(findRanges("İ ab", "a", false), [{ start: 2, end: 3 }]);
  assert.deepEqual(findRanges("İ apple", "apple", false), [{ start: 2, end: 7 }]);
  assert.deepEqual(findRanges("İ", "i", false), [], "the 'i' half of İ is not a match");
  assert.deepEqual(findRanges("İ", "i̇", false), [{ start: 0, end: 1 }], "the whole folding is");
  assert.deepEqual(findRanges("a\u{10400}b", "\u{10428}", false), [{ start: 1, end: 3 }]);
  assert.deepEqual(findRanges("ΑΣ", "ας", false), [{ start: 0, end: 2 }], "final and medial sigma are one letter");
  assert.deepEqual(findRanges("Kelvin", "kelvin", false), [{ start: 0, end: 6 }]);
  assert.deepEqual(findRanges("aAa", "a", true), [{ start: 0, end: 1 }, { start: 2, end: 3 }]);
  assert.deepEqual(findRanges("aaa", "", false), []);
  // replaceRanges takes a length per match
  const runs = [{ t: "text", text: "İ ab İ", s: {} }];
  const r = findRanges("İ ab İ", "İ", false);
  assert.deepEqual(r.map((x) => x.end - x.start), [1, 1]);
  assert.equal(replaceRanges(runs, r.map((x) => x.start), r.map((x) => x.end - x.start), "I")[0].text, "I ab I");
  assert.equal(partialWords("İ apple", "app", false), 1);
});

const run = (bytes, format, ops) => runOps({ bytes, format, name: `t.${format}`, ops });
const replaceAll = (find, replace, count) => ({ op: "replace_all_text", find, replace, match_case: false, expect: { count } });

test("docx replace_all_text, match_case off: İ before the match does not shift it", async () => {
  for (const [text, find, want] of [["İ ab", "a", "İ Zb"], ["İ apple", "apple", "İ Z"], ["İİ aİ a", "a", "İİ Zİ Z"]]) {
    const r = await run(docxBytes([text]), "docx", [replaceAll(find, "Z", text === "İİ aİ a" ? 2 : 1)]);
    assert.equal(r.results[0].status, "applied", JSON.stringify(r.results));
    assert.deepEqual(readDocxParagraphs(r.bytes).map((p) => p.text), [want], text);
  }
});

test("docx replace_text and format_text, match_case off: the replaced range is the matched text", async () => {
  const r = await run(docxBytes(["İ ab"]), "docx", [{ op: "replace_text", target: { body_path: [0] }, expect: { quote: "İ ab" }, find: "a", replace: "Z", match_case: false }]);
  assert.equal(r.results[0].status, "applied", JSON.stringify(r.results));
  assert.deepEqual(readDocxParagraphs(r.bytes).map((p) => p.text), ["İ Zb"]);
});

// the committed engine sample deck, its slide 1 title (shape 2, "office-engine") rewritten to the text under test
const SAMPLE = path.join(ENGINE_SAMPLES, "sample.pptx");
const SKIP_PPTX = skipUnless(haveSamples(), `engine samples not found in ${ENGINE_SAMPLES}`, "restore test/fixtures/engine or set ONIONSKIN_TEST_SAMPLES");
const pptxWith = (text) => rezip(fs.readFileSync(SAMPLE), { "ppt/slides/slide1.xml": (xml) => xml.replace("<a:t>office-engine</a:t>", `<a:t>${text}</a:t>`) });
const slideText = (bytes) => [...openZip(bytes).readText("ppt/slides/slide1.xml").matchAll(/<a:t[^>]*>([^<]*)<\/a:t>/g)].map((m) => m[1]).join("|");

test("pptx replace_all_text and replace_text_in_shape, match_case off: İ before the match does not shift it", { skip: SKIP_PPTX }, async () => {
  const r = await run(pptxWith("İ qzxw"), "pptx", [replaceAll("ZXW", "Z", 1)]);
  assert.equal(r.results[0].status, "applied", JSON.stringify(r.results));
  assert.match(slideText(r.bytes), /^İ qZ\|/);
  const s = await run(pptxWith("İ qzxw"), "pptx", [{ op: "replace_text_in_shape", target: { slide_id: "256", shape_id: 2 }, expect: { quote: "İ qzxw" }, find: "QZXW", replace: "Z", match_case: false }]);
  assert.equal(s.results[0].status, "applied", JSON.stringify(s.results));
  assert.match(slideText(s.bytes), /^İ Z\|/);
});

const cellsOf = (bytes) => openZip(bytes).readText("xl/worksheets/sheet1.xml");
test("xlsx replace_all_text, match_case off: counted and replaced by the same matches", async () => {
  const r = await run(xlsxBytes({ S: { A1: "İ ab", A2: "Kelvin", A3: "plain" } }), "xlsx", [replaceAll("a", "Z", 2)]);
  assert.equal(r.results[0].status, "applied", JSON.stringify(r.results));
  const xml = cellsOf(r.bytes);
  assert.match(xml, /İ Zb/);
  // the Kelvin sign counted as a "k" but a case-insensitive RegExp replaced nothing: counted 1, "applied", cell unchanged
  const k = await run(xlsxBytes({ S: { A1: "Kelvin" } }), "xlsx", [replaceAll("kelvin", "X", 1)]);
  assert.equal(k.results[0].status, "applied", JSON.stringify(k.results));
  assert.match(cellsOf(k.bytes), />X</);
});

test("HIGH B: counting matches keeps no record per match and is linear: twice the text, about twice the CPU time (best of 3)", async () => {
  const { countMatches, findRanges, partialWords } = await import("../src/ops/runs.js");
  // the same answers as the matches listed
  for (const [text, find, mc] of [["İ İx aİ", "i̇", false], ["The the THE then", "the", false], ["a😀b A😀B", "😀b", false], ["ab ab", "ab", true], ["ΣΑΣ σας", "σας", false]]) {
    assert.deepEqual(countMatches(text, find, mc), { n: findRanges(text, find, mc).length, partial: partialWords(text, find, mc) }, text);
  }
  const best = (n, fn = (text) => assert.equal(countMatches(text, "i̇", false).n, n)) => {
    const text = "İ ".repeat(n);
    let ms = Infinity;
    for (let k = 0; k < 3; k++) {
      const u = process.cpuUsage();
      fn(text);
      const d = process.cpuUsage(u);
      ms = Math.min(ms, (d.user + d.system) / 1000);
    }
    return ms;
  };
  const a = best(1_000_000);
  const b = best(2_000_000);
  assert.ok(b / Math.max(a, 5) < 3, `1,000,000 matches: ${a.toFixed(0)} ms, 2,000,000: ${b.toFixed(0)} ms`);
  // at the cap (8 million characters, 4 million matches): well under listing every match and reading the characters around each one,
  // as the count did before (1.6 s against 0.65 s here; compared in the same process, so a loaded Mac moves both)
  const count = best(4_000_000);
  const listed = best(4_000_000, (text) => {
    const all = findRanges(text, "i̇", false);
    assert.equal(all.length, 4_000_000);
    for (const { start, end } of all) [...text.slice(Math.max(0, start - 2), start)].pop() + [...text.slice(end, end + 2)][0];
  });
  // (standalone 0.65 s against 1.6 s; with the whole unit suite at a load of 35, 1.7 s against 1.9 s: the margin is the memory a list takes)
  assert.ok(count < listed, `counted ${Math.round(count)} ms, listed ${Math.round(listed)} ms`);
});

// ---- B1: a comment-bound find whose matches overlap ("banana", the last "ana" selected) ---------------------------------------------
// The scan is non-overlapping, so it saw one "ana" (the first) and wrote "bXna" reported as applied; "banX" was meant. The anchor's
// offsets are not trusted to choose a copy, so such a reply is refused with nothing changed. Every non-overlapping case stays as before.
const { countOverlapping, overlapRefusal } = await import("../src/ops/runs.js");

test("B1: countOverlapping and overlapRefusal", () => {
  assert.equal(countOverlapping("banana", "ana"), 2);
  assert.equal(findRanges("banana", "ana").length, 1);
  assert.equal(countOverlapping("BANANA", "ana", false), 2);
  assert.equal(countOverlapping("BANANA", "ana", true), 0);
  assert.equal(countOverlapping("aaaa", "aa"), 3);
  assert.equal(countOverlapping("red car and red bus", "red"), 2);
  const bound = { target: { anchor_id: "a1" } };
  assert.match(overlapRefusal(["banana"], "ana", true, 1, bound), /occurs 2 times .* overlapping/);
  assert.equal(overlapRefusal(["banana"], "ana", true, 1, { target: { body_path: [0] } }), null); // not comment-bound: as before
  assert.equal(overlapRefusal(["banana"], "ana", true, 1, { ...bound, occurrence: 1 }), null);
  assert.equal(overlapRefusal(["banana"], "ana", true, 1, { ...bound, all: true }), null);
  assert.equal(overlapRefusal(["the brown fox"], "brown", true, 1, bound), null);
  assert.equal(overlapRefusal(["banana", "x"], "nan", true, 1, bound), null);
  // across a shape's paragraphs: one match reported in all, a second overlapping copy in the same paragraph
  assert.ok(overlapRefusal(["no match", "banana"], "ana", true, 1, bound));
});

const docxAnchor = (start, end, quote) => new Map([["a1", { id: "a1", locator: { para_id: null, body_path: [0], text_hash: null, start, end }, quote }]]);
const runA = (bytes, format, ops, anchors, partial = false) => runOps({ bytes, format, name: `t.${format}`, ops, anchors, partial });
const textOf = (r, input) => readDocxParagraphs(r.bytes || input).map((p) => p.text);

test("B1 docx: a comment-bound find with overlapping copies is refused, nothing written", async () => {
  const input = docxBytes(["banana"]);
  const r = await runA(input, "docx", [{ op: "replace_text", target: { anchor_id: "a1" }, expect: { quote: "banana" }, find: "ana", replace: "X" }], docxAnchor(3, 6, "ana"));
  assert.equal(r.results[0].status, "refused", JSON.stringify(r.results));
  assert.equal(r.results[0].code, "overlapping_matches");
  assert.equal(r.bytes, null);
  const f = await runA(input, "docx", [{ op: "format_text", target: { anchor_id: "a1" }, expect: { quote: "banana" }, find: "ana", set: { bold: true } }], docxAnchor(3, 6, "ana"));
  assert.equal(f.results[0].code, "overlapping_matches", JSON.stringify(f.results));
  assert.equal(f.bytes, null);
  // partial mode: the other op of the batch still applies
  const two = docxBytes(["banana", "The lazy dog"]);
  const anchors = new Map([...docxAnchor(3, 6, "ana"), ["a2", { id: "a2", locator: { para_id: null, body_path: [1], text_hash: null, start: 4, end: 8 }, quote: "lazy" }]]);
  const p = await runA(two, "docx", [
    { op: "replace_text", target: { anchor_id: "a1" }, expect: { quote: "banana" }, find: "ana", replace: "X" },
    { op: "replace_text", target: { anchor_id: "a2" }, expect: { quote: "lazy" }, find: "lazy", replace: "sleepy" },
  ], anchors, true);
  assert.deepEqual(p.results.map((x) => x.status), ["refused", "applied"], JSON.stringify(p.results));
  assert.deepEqual(textOf(p, two), ["banana", "The sleepy dog"]);
});

test("B1 docx: same as before where matches do not overlap, or the op is not comment-bound or names occurrence/all", async () => {
  const fox = "The quick brown fox jumps over the lazy dog";
  const rows = [
    // [paragraph, anchor offsets, op extras, want status, want text]
    [fox, [10, 15, "brown"], { find: "quick brown fox", replace: "Q" }, "applied", "The Q jumps over the lazy dog"],
    [fox, [10, 15, "brown"], { find: "lazy", replace: "L" }, "applied", "The quick brown fox jumps over the L dog"],
    [fox, [20, 24, "jump"], { find: "jumps", replace: "J" }, "applied", "The quick brown fox J over the lazy dog"],
    ["Prix :\u00a010", [0, 9, "Prix : 10"], { find: "10", replace: "12" }, "applied", "Prix :\u00a012"],
    ["Vraiment ?", [0, 10, "Vraiment ?"], { find: "Vraiment", replace: "Oui" }, "applied", "Oui ?"],
    ["red car and red bus", [12, 15, "red"], { find: "red", replace: "blue" }, "anchor_not_found", "red car and red bus"],
    ["banana", [3, 6, "ana"], { find: "ana", replace: "X", occurrence: 1 }, "applied", "bXna"],
    ["banana", [3, 6, "ana"], { find: "ana", replace: "X", all: true }, "applied", "bXna"],
    ["banana", [0, 6, "banana"], { find: "nan", replace: "X" }, "applied", "baXa"],
  ];
  for (const [para, [s, e, q], extra, status, want] of rows) {
    const input = docxBytes([para]);
    const r = await runA(input, "docx", [{ op: "replace_text", target: { anchor_id: "a1" }, expect: { quote: para }, ...extra }], docxAnchor(s, e, q));
    assert.equal(r.results[0].status, status, `${para} ${JSON.stringify(extra)} ${JSON.stringify(r.results)}`);
    assert.deepEqual(textOf(r, input), [want], para);
  }
  // an explicit target (the merge's and an agent's own locator): release behavior, the first copy
  const input = docxBytes(["banana"]);
  const x = await runA(input, "docx", [{ op: "replace_text", target: { body_path: [0] }, expect: { quote: "banana" }, find: "ana", replace: "X" }], new Map());
  assert.equal(x.results[0].status, "applied", JSON.stringify(x.results));
  assert.deepEqual(textOf(x, input), ["bXna"]);
  // replace_all_text counts and replaces the non-overlapping matches, as before
  const all = await run(input, "docx", [replaceAll("ana", "X", 1)]);
  assert.equal(all.results[0].status, "applied", JSON.stringify(all.results));
  assert.deepEqual(textOf(all, input), ["bXna"]);
  // two comments on one paragraph in one atomic batch: both apply
  const two = await runA(docxBytes([fox]), "docx", [
    { op: "replace_text", target: { anchor_id: "a1" }, expect: { quote: fox }, find: "brown", replace: "red" },
    { op: "replace_text", target: { anchor_id: "a2" }, expect: { quote: "lazy" }, find: "lazy", replace: "sleepy" },
  ], new Map([...docxAnchor(10, 15, "brown"), ["a2", { id: "a2", locator: { para_id: null, body_path: [0], text_hash: null, start: 35, end: 39 }, quote: "lazy" }]]));
  assert.deepEqual(two.results.map((r) => r.status), ["applied", "applied"], JSON.stringify(two.results));
  assert.deepEqual(textOf(two), ["The quick red fox jumps over the sleepy dog"]);
});

const shapeAnchor = new Map([["a1", { id: "a1", locator: { slide_id: "256", shape_id: 2, text_hash: null, start: 3, end: 6 }, quote: "ana" }]]);
test("B1 pptx: a comment-bound find with overlapping copies is refused; non-overlapping finds apply as before", { skip: SKIP_PPTX }, async () => {
  const deck = pptxWith("banana");
  const r = await runA(deck, "pptx", [{ op: "replace_text_in_shape", target: { anchor_id: "a1" }, expect: { quote: "banana" }, find: "ana", replace: "X" }], shapeAnchor);
  assert.equal(r.results[0].code, "overlapping_matches", JSON.stringify(r.results));
  assert.equal(r.bytes, null);
  const ok = await runA(pptxWith("quick brown fox"), "pptx", [{ op: "replace_text_in_shape", target: { anchor_id: "a1" }, expect: { quote: "quick brown fox" }, find: "brown", replace: "red" }], shapeAnchor);
  assert.equal(ok.results[0].status, "applied", JSON.stringify(ok.results));
  assert.match(slideText(ok.bytes), /^quick red fox\|/);
  const occ = await runA(deck, "pptx", [{ op: "replace_text_in_shape", target: { anchor_id: "a1" }, expect: { quote: "banana" }, find: "ana", replace: "X", occurrence: 1 }], shapeAnchor);
  assert.equal(occ.results[0].status, "applied", JSON.stringify(occ.results));
  assert.match(slideText(occ.bytes), /^bXna\|/);
  const plain = await run(deck, "pptx", [{ op: "replace_text_in_shape", target: { slide_id: "256", shape_id: 2 }, expect: { quote: "banana" }, find: "ana", replace: "X" }]);
  assert.equal(plain.results[0].status, "applied", JSON.stringify(plain.results));
  assert.match(slideText(plain.bytes), /^bXna\|/);
});
