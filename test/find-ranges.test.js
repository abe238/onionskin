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
