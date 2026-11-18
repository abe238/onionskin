import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { docxBytes } from "./helpers/zipbuild.js";
import { ENGINE_SAMPLES, haveSamples, skipUnless } from "../scripts/fixtures.mjs";
import { readDocxParagraphs } from "../src/docx.js";
import { runOps } from "../src/ops/run.js";
import { mergeProven } from "../src/merge-worker.js";
import { exactHash } from "../src/text.js";

// The ordinary formatting a person sets in the page, each merged against an agent's text edit elsewhere, through the merge and its
// proof (src/merge-worker.js mergeProven). "mine" is written by the same engine calls the page's writer makes (src/ops: docx.edit
// with run and paragraph settings, xlsx.format), so these are the bytes a person's Save gives. Word: each must merge with nothing
// handed back. Excel and PowerPoint do not carry formatting (src/merge-xlsx.js, src/merge-pptx.js: "Formatting is not carried
// over"): each must be said, with nothing refused.

const SAMPLES = skipUnless(haveSamples(), `engine samples not found in ${ENGINE_SAMPLES}`, "restore test/fixtures/engine or set ONIONSKIN_TEST_SAMPLES");
const pid = (n) => String(n).padStart(8, "0");
const P = (id, t) => `<w:p w14:paraId="${pid(id)}"><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
const BASE = docxBytes([], {}, P(1, "A typo here and a few more words.") + P(2, "Second paragraph for the agent.") + P(3, "Third paragraph stays."));
const read = (bytes) => readDocxParagraphs(bytes, { detail: true });
const find = (bytes, starts) => read(bytes).find((p) => p.text.startsWith(starts));
const edit = async (bytes, ops) => {
  const r = await runOps({ bytes, format: "docx", name: "t.docx", ops });
  assert.ok(r.bytes && r.results.every((x) => x.status === "applied"), JSON.stringify(r.results));
  return r.bytes;
};
const fmt = (bytes, starts, { para, word, set } = {}) => {
  const p = find(bytes, starts);
  const at = word ? p.text.indexOf(word) : -1;
  return { op: "format_paragraph", target: { text_hash: p.hash }, expect: { text_hash: p.hash }, ...(para ? { para } : {}), ...(word ? { runs: [{ start: at, end: at + word.length, set }] } : {}) };
};
const agent = (bytes) => edit(bytes, [{ op: "replace_text", target: { text_hash: find(bytes, "Second").hash }, expect: { text_hash: find(bytes, "Second").hash }, find: "agent", replace: "agent, edited" }]);

const WORD = {
  bold: { word: "typo", set: { b: true } },
  italic: { word: "typo", set: { i: true } },
  underline: { word: "typo", set: { u: "single" } },
  strikethrough: { word: "typo", set: { strike: true } },
  "font size": { word: "typo", set: { sz: 16 } },
  "font color": { word: "typo", set: { color: "#c00000" } },
  highlight: { word: "typo", set: { hl: "#ffff00" } },
  "font family": { word: "typo", set: { font: "Georgia" } },
  "paragraph alignment": { para: { align: "center" } },
  "a heading style": { para: { style: "Heading 2" } },
  "a bullet list": { para: { list: "bullet", ilvl: 0 } },
  "a numbered list": { para: { list: "number", ilvl: 0 } },
};

for (const [what, spec] of Object.entries(WORD)) {
  test(`Word, ${what} set in the page while the agent edits another paragraph: merged, nothing handed back, the result reads as the person's`, async () => {
    const mine = await edit(BASE, [fmt(BASE, "A typo", spec)]);
    const theirs = await agent(BASE);
    const r = await mergeProven({ format: "docx", base: BASE, mine, theirs, name: "t.docx" });
    assert.equal(r.refused, undefined, `refused: ${r.refused}`);
    assert.deepEqual(r.unplaced.map((u) => u.why), []);
    const [got, want] = [find(r.bytes, "A typo"), find(mine, "A typo")];
    assert.deepEqual([got.spans, got.styleName, got.align, got.list?.kind], [want.spans, want.styleName, want.align, want.list?.kind]);
    assert.ok(find(r.bytes, "Second").text.includes("agent, edited"), "the agent's edit stands");
  });
}

test("LOW 5: a word made bold in another program (w:b alone) while the agent edits another paragraph merges; the engine's paired w:bCs on Latin text is the same bold", async () => {
  const two = P(2, "Second paragraph for the agent.") + P(3, "Third paragraph stays.");
  const base = docxBytes([], {}, `<w:p w14:paraId="${pid(1)}"><w:r><w:t xml:space="preserve">A typo here</w:t></w:r></w:p>${two}`);
  const mine = docxBytes([], {}, `<w:p w14:paraId="${pid(1)}"><w:r><w:t xml:space="preserve">A </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>typo</w:t></w:r><w:r><w:t xml:space="preserve"> here</w:t></w:r></w:p>${two}`);
  const theirs = await agent(base);
  const r = await mergeProven({ format: "docx", base, mine, theirs, name: "t.docx" });
  assert.equal(r.refused, undefined, `refused: ${r.refused}`);
  assert.deepEqual(r.unplaced, []);
  // the same bold on Hebrew text is not the same: w:bCs bolds it where w:b alone does not
  const heb = (t) => docxBytes([], {}, `<w:p w14:paraId="${pid(1)}">${t}</w:p>${two}`);
  const hb = heb('<w:r><w:t xml:space="preserve">A שלום here</w:t></w:r>');
  const hm = heb('<w:r><w:t xml:space="preserve">A </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>שלום</w:t></w:r><w:r><w:t xml:space="preserve"> here</w:t></w:r>');
  const hr = await mergeProven({ format: "docx", base: hb, mine: hm, theirs: await agent(hb), name: "t.docx" });
  assert.ok(hr.refused || hr.unplaced.length, "complex-script text: refused or handed back, never accepted as the same bold");
});

// ---- Excel and PowerPoint: formatting is handed back by design ----
// The planners carry values and text, never formatting (src/merge-xlsx.js, src/merge-pptx.js). Each formatting action of the page
// is said, once, with a copy of the person's file, and the value or text the agent wrote elsewhere stands. Alignment in Excel and
// size and color in PowerPoint have no engine call the ops layer exposes: their bytes are written here as the engine writes them
// (an s= index to an appended cell style; a:rPr sz and a:solidFill).
const sample = (ext) => fs.readFileSync(path.join(ENGINE_SAMPLES, `sample.${ext}`));
const xlsxCase = async (set) => {
  const base = sample("xlsx");
  const { parseWorkbook } = await import("../src/xlsx.js");
  const wb = parseWorkbook(base);
  const [s, o] = wb.sheets;
  const first = (sh) => [...wb.sheetCells(sh).cells].find(([k, c]) => k % 16384 < 26 && c.k !== "formula" && !c.shared);
  const a1 = (k) => `${String.fromCharCode(65 + (k % 16384))}${Math.floor(k / 16384) + 1}`;
  const [k, c] = first(s);
  const [ko, co] = first(o);
  const run = async (bytes, op) => (await runOps({ bytes, format: "xlsx", name: "t.xlsx", ops: [op] })).bytes;
  const mine = await run(base, { op: "format_cells", target: { sheet: s.name, range: a1(k) }, expect: { text_hash: exactHash(c.text) }, set });
  const theirs = await run(base, { op: "set_cells", target: { sheet: o.name, range: a1(ko) }, expect: { text_hash: exactHash(co.text) }, values: "agent value" });
  return mergeProven({ format: "xlsx", base, mine, theirs, name: "t.xlsx", edits: [{ kind: "format", sheet: s.name }] });
};
for (const [what, set] of Object.entries({ bold: { bold: true }, fill: { fill: "#FFFF00" }, "number format": { number_format: "0.00" } })) {
  test(`Excel, ${what} set in the page while the agent edits another sheet: said once with a copy (formatting is not carried), never refused`, { skip: SAMPLES }, async () => {
    const r = await xlsxCase(set);
    assert.equal(r.refused, undefined, `refused: ${r.refused}`);
    assert.equal(r.unplaced.length, 1, JSON.stringify(r.unplaced.map((u) => u.why)));
    assert.match(r.unplaced[0].why, /Formatting is not carried over/);
    assert.equal(r.copy, true);
  });
}

const pptxCase = async (rpr) => {
  const base = sample("pptx");
  const { parseDeck } = await import("../src/pptx.js");
  const { rezip } = await import("./helpers/zipbuild.js");
  const { openZip } = await import("../src/zip.js");
  const d = parseDeck(base);
  d.ensure();
  const shapes = d.slides.flatMap((sl) => sl.shapes.filter((x) => x.kind === "shape" && /[A-Za-z]{3,}/.test(x.text)).map((x) => ({ sl, x })));
  const [{ sl }] = shapes;
  const last = shapes[shapes.length - 1];
  const w = /[A-Za-z]{3,}/.exec(last.x.text)[0];
  const theirs = (await runOps({ bytes: base, format: "pptx", name: "t.pptx", ops: [{ op: "replace_text_in_shape", target: { slide_id: String(last.sl.id), shape_id: last.x.id }, expect: { text_hash: last.x.hash }, find: w, replace: `${w} agent`, occurrence: 1 }] })).bytes;
  // the person formats the first run of the first slide's text, as the engine writes it
  const mine = rezip(base, { [sl.part]: (x) => x.replace("<a:r><a:t>", `<a:r><a:rPr lang="en-US" dirty="0"${rpr}<a:t>`) });
  assert.notEqual(openZip(mine).readText(sl.part), openZip(base).readText(sl.part), "the run was formatted");
  return mergeProven({ format: "pptx", base, mine, theirs, name: "t.pptx", edits: [{ kind: "format", slide: sl.index }] });
};
for (const [what, rpr] of Object.entries({ bold: ' b="1"/>', size: ' sz="3200"/>', color: '><a:solidFill><a:srgbClr val="C00000"/></a:solidFill></a:rPr>' })) {
  test(`PowerPoint, ${what} set in the page while the agent edits another shape: said with a copy (formatting is not carried), never refused`, { skip: SAMPLES }, async () => {
    const r = await pptxCase(rpr);
    assert.equal(r.refused, undefined, `refused: ${r.refused}`);
    assert.ok(r.unplaced.length >= 1 && r.unplaced.every((u) => /formatting|Formatting/.test(u.why)), JSON.stringify(r.unplaced.map((u) => u.why)));
    assert.equal(r.copy, true);
  });
}

// written by another program (the property alone, without the engine's paired twin): merged, as bold is (LOW 5)
for (const [what, rpr] of [["italic", "<w:i/>"], ["a size", '<w:sz w:val="32"/>'], ["a font", '<w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/>']]) {
  test(`Word, ${what} written by another program (no complex-script twin) while the agent edits another paragraph: merged, nothing handed back`, async () => {
    const two = P(2, "Second paragraph for the agent.");
    const base = docxBytes([], {}, `<w:p w14:paraId="${pid(1)}"><w:r><w:t xml:space="preserve">A typo here</w:t></w:r></w:p>${two}`);
    const mine = docxBytes([], {}, `<w:p w14:paraId="${pid(1)}"><w:r><w:t xml:space="preserve">A </w:t></w:r><w:r><w:rPr>${rpr}</w:rPr><w:t>typo</w:t></w:r><w:r><w:t xml:space="preserve"> here</w:t></w:r></w:p>${two}`);
    const r = await mergeProven({ format: "docx", base, mine, theirs: await agent(base), name: "t.docx" });
    assert.equal(r.refused, undefined, `refused: ${r.refused}`);
    assert.deepEqual(r.unplaced, []);
  });
}

test("Word, a hyperlink added in the page while the agent edits another paragraph: handed back with a copy (no planner carries a link: an object of the paragraph and a relationship)", async () => {
  const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const rels = (x) => `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${x}</Relationships>`;
  const two = P(2, "Second paragraph for the agent.");
  const base = docxBytes([], { "word/_rels/document.xml.rels": rels("") }, P(1, "A typo here") + two);
  const mine = docxBytes([], { "word/_rels/document.xml.rels": rels(`<Relationship Id="rIdL" Type="${REL}/hyperlink" Target="https://example.com" TargetMode="External"/>`) }, `<w:p w14:paraId="${pid(1)}"><w:r><w:t xml:space="preserve">A </w:t></w:r><w:hyperlink xmlns:r="${REL}" r:id="rIdL"><w:r><w:t>typo</w:t></w:r></w:hyperlink><w:r><w:t xml:space="preserve"> here</w:t></w:r></w:p>${two}`);
  const r = await mergeProven({ format: "docx", base, mine, theirs: await agent(base), name: "t.docx" });
  assert.equal(r.refused, undefined, `refused: ${r.refused}`);
  assert.ok(r.unplaced.some((u) => /link/.test(u.why)) && r.copy, JSON.stringify(r.unplaced.map((u) => u.why)));
});

test("Excel, alignment set in the page (an appended cell style with an alignment, as the engine writes it) while the agent edits another sheet: said once with a copy", { skip: SAMPLES }, async () => {
  const base = sample("xlsx");
  const { rezip } = await import("./helpers/zipbuild.js");
  const { openZip } = await import("../src/zip.js");
  const { parseWorkbook } = await import("../src/xlsx.js");
  const wb = parseWorkbook(base);
  const [s, o] = wb.sheets;
  const styles = openZip(base).readText("xl/styles.xml");
  const n = (styles.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/)[1].match(/<xf\b/g) || []).length;
  const [k] = [...wb.sheetCells(s).cells].find(([key, c]) => key % 16384 < 26 && c.k !== "formula" && !c.shared);
  const ref = `${String.fromCharCode(65 + (k % 16384))}${Math.floor(k / 16384) + 1}`;
  const mine = rezip(base, {
    "xl/styles.xml": (x) => x.replace("</cellXfs>", '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="center"/></xf></cellXfs>'),
    [s.part]: (x) => x.replace(new RegExp(`<c r="${ref}"( s="\\d+")?`), `<c r="${ref}" s="${n}"`),
  });
  const [ko, co] = [...wb.sheetCells(o).cells].find(([key, c]) => key % 16384 < 26 && c.k !== "formula" && !c.shared);
  const a1 = (key) => `${String.fromCharCode(65 + (key % 16384))}${Math.floor(key / 16384) + 1}`;
  const theirs = (await runOps({ bytes: base, format: "xlsx", name: "t.xlsx", ops: [{ op: "set_cells", target: { sheet: o.name, range: a1(ko) }, expect: { text_hash: exactHash(co.text) }, values: "agent value" }] })).bytes;
  const r = await mergeProven({ format: "xlsx", base, mine, theirs, name: "t.xlsx", edits: [{ kind: "format", sheet: s.name }] });
  assert.equal(r.refused, undefined, `refused: ${r.refused}`);
  assert.deepEqual(r.unplaced.map((u) => u.why), [`You changed formatting on the sheet "${s.name}". Formatting is not carried over.`]);
  assert.equal(r.copy, true);
});

test("Word, a numbered list set by the person while the agent numbers a paragraph above it: merged, nothing handed back (the numbering runs on; comparing that refused the merge)", async () => {
  const f = (b, s) => fmt(b, s, { para: { list: "number", ilvl: 0 } });
  const mine = await edit(BASE, [f(BASE, "Third")]);
  const theirs = await edit(BASE, [f(BASE, "A typo")]);
  const r = await mergeProven({ format: "docx", base: BASE, mine, theirs, name: "t.docx" });
  assert.equal(r.refused, undefined, `refused: ${r.refused}`);
  assert.deepEqual(r.unplaced, []);
  assert.equal(find(r.bytes, "Third").list?.kind, "number");
});
