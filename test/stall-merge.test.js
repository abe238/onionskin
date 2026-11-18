// The stalls an outside review measured after round 3, through a real server in a child process with /health probed every 50 ms
// (test/helpers/stall.js): the merge of what the person typed while the agent worked (Word: a scan of every paragraph per op, 120 s at
// 49,999 paragraphs; PowerPoint: a scan of every op per shape, 1.3 s at 10,000 shapes), and a quick preview that fed a file swapped on
// disk to the engine past the readers' caps (3 to 3.8 s). /health must stay under 2 s and the work must be done (the merged count).
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { childServer, mergeFlow, within } from "./helpers/stall.js";
import { docxRuns } from "./helpers/hostile.js";
import { buildZip, docxBytes } from "./helpers/zipbuild.js";
import { ENGINE_SAMPLES, haveSamples, skipUnless } from "../scripts/fixtures.mjs";
import { MAX_ELEMENTS, readDocxParagraphs } from "../src/docx.js";
import { parseDeck } from "../src/pptx.js";
import { openZip } from "../src/zip.js";

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const SKIP = skipUnless(haveSamples(), `engine samples not found in ${ENGINE_SAMPLES}`, "restore test/fixtures/engine or set ONIONSKIN_TEST_SAMPLES");

// The same flow at 20,000 paragraphs here, gated on the server's CPU time for the merge, which a loaded Mac does not change (the /health
// wait doubled at a load average of 60). The merge scanned every paragraph per op: /health waited 5.9 s at 20,000 before (9ffb33a). At the
// cap, 49,999 paragraphs, with the /health gate, it runs in the slow group (e2e/stall-cap.e2e.test.js), one file at a time.
test("merging a Word file of 20,000 edited paragraphs: the process spends under 7 s of CPU on it, and /health is answered", { timeout: 240_000 }, async () => {
  const n = 20_000;
  // paragraph ids, as Word writes them (without them the matcher cannot pair this many rewritten paragraphs: see test/merge.test.js)
  const make = (suffix = "", first = null) => docxBytes(Array.from({ length: n }, (_, i) => ({ paraId: (0x10000000 + i).toString(16).toUpperCase(), text: i === 0 && first ? first : `Paragraph number ${i} of the text${suffix}` })));
  const r = await mergeFlow("docx", make, { location: { blockPath: [0] }, paraText: "a" }, (bytes) => {
    const paras = readDocxParagraphs(bytes);
    assert.equal(paras.length, n);
    assert.equal(paras[0].text, "Changed by the agent here");
    assert.equal(paras.filter((p, i) => p.text === `Paragraph number ${i} of the text, edited by me`).length, n - 1);
  }, { gate: 7000 }); // 3 to 5.3 s measured across runs (the merge worker is in this count); the old code took 8.4 s
  assert.equal(r.merged, n - 1);
});

/** The engine's sample deck with its slides replaced by `slides` slides of 50 one-paragraph text boxes each; text(i) is box i's text. */
function deck(slides, text) {
  const sample = openZip(fs.readFileSync(path.join(ENGINE_SAMPLES, "sample.pptx")));
  const P = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const files = {};
  for (const n of sample.names) if (!/^ppt\/(slides|charts|embeddings|media)\//.test(n) && n !== "docProps/thumbnail.jpeg") files[n] = sample.read(n);
  const range = Array.from({ length: slides }, (_, i) => i);
  files["[Content_Types].xml"] = sample.readText("[Content_Types].xml").replace(/<Override PartName="\/ppt\/(slides|charts)\/[^"]+"[^>]*\/>/g, "").replace("</Types>", `${range.map((i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join("")}</Types>`);
  files["_rels/.rels"] = sample.readText("_rels/.rels").replace(/<Relationship Id="rId2"[^>]*\/>/, ""); // the thumbnail
  files["ppt/presentation.xml"] = sample.readText("ppt/presentation.xml").replace(/<p:sldIdLst>.*<\/p:sldIdLst>/, `<p:sldIdLst>${range.map((i) => `<p:sldId id="${256 + i}" r:id="rId${100 + i}"/>`).join("")}</p:sldIdLst>`);
  files["ppt/_rels/presentation.xml.rels"] = sample.readText("ppt/_rels/presentation.xml.rels").replace(/<Relationship Id="rId(7|8|9|10|11)"[^>]*\/>/g, "").replace("</Relationships>", `${range.map((i) => `<Relationship Id="rId${100 + i}" Type="${P}/slide" Target="slides/slide${i + 1}.xml"/>`).join("")}</Relationships>`);
  for (const s of range) {
    let sp = "";
    for (let k = 0; k < 50; k++) sp += `<p:sp><p:nvSpPr><p:cNvPr id="${k + 2}" name="Box ${k + 1}"/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="9" cy="9"/></a:xfrm></p:spPr><p:txBody><a:p><a:r><a:t>${text(s * 50 + k)}</a:t></a:r></a:p></p:txBody></p:sp>`;
    files[`ppt/slides/slide${s + 1}.xml`] = `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="${P}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${sp}</p:spTree></p:cSld></p:sld>`;
    files[`ppt/slides/_rels/slide${s + 1}.xml.rels`] = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${P}/slideLayout" Target="../slideLayouts/slideLayout6.xml"/></Relationships>`;
  }
  return buildZip(files);
}

test("merging a deck of 20,000 edited text boxes keeps /health under 2 s (1.3 s at 10,000 before, growing with the square)", { skip: SKIP, timeout: 240_000 }, async () => {
  const n = 20_000;
  const make = (suffix = "", first = null) => deck(n / 50, (i) => (i === 0 && first ? first : `Shape ${i} text${suffix}`));
  const r = await mergeFlow("pptx", make, { location: { slideIndex: 0, shapeId: 2 }, quote: "a" }, (bytes) => {
    const d = parseDeck(bytes);
    d.ensure();
    const texts = d.slides.flatMap((sl) => sl.shapes.map((x) => x.text));
    assert.equal(texts.length, n);
    assert.equal(texts[0], "Changed by the agent here");
    assert.equal(texts.filter((t, i) => t === `Shape ${i} text, edited by me`).length, n - 1);
  });
  assert.equal(r.merged, n - 1, "every box but the agent's was carried");
});

test("a quick preview of a file swapped on disk past a reader's cap is refused in plain words before the engine reads it (3 to 3.8 s before)", { timeout: 240_000 }, async () => {
  const srv = await childServer();
  try {
    const f = path.join(srv.root, "q.docx");
    fs.writeFileSync(f, docxBytes(["Hello there.", "Second paragraph."]));
    const { key } = await srv.openPage(f);
    fs.writeFileSync(f, docxRuns(1_200_000)); // one paragraph of 1.2 million runs, 154 KB zipped
    for (const note of ['replace "aa" with "bb"', "make every heading bold"]) {
      const r = await within(srv, `quick preview: ${note}`, () => srv.api(key, "/api/quick", { note }));
      assert.equal(r.status, 422, JSON.stringify(r.json));
      assert.equal(r.json.code, "too_large");
      assert.match(r.json.error, new RegExp(`^Onionskin cannot read this file: this document has more than ${MAX_ELEMENTS.toLocaleString("en-US")} XML elements, more than Onionskin can read\\. .*\\.$`));
    }
    // just under the cap the preview still counts, and /health stays answered while the engine reads it
    const runs = Math.floor((MAX_ELEMENTS - 10) / 2);
    fs.writeFileSync(f, docxBytes([], {}, `<w:p>${'<w:r><w:t xml:space="preserve">Acme </w:t></w:r>'.repeat(runs)}</w:p>`));
    const r = await within(srv, "quick preview just under the cap", () => srv.api(key, "/api/quick", { note: 'replace "Acme" with "Initech"' }));
    assert.equal(r.status, 200);
    assert.equal(r.json.match?.count, runs);
  } finally {
    await srv.stop();
  }
});

test("a quick change made on this Mac on one paragraph of 99,997 runs: /health under 2 s, every match replaced (minutes before)", { timeout: 240_000 }, async () => {
  // the engine's runs were rebuilt once per match before: quadratic in the matches of a paragraph. Half the element cap: at the cap
  // (199,995 runs) the engine's own edit of the paragraph is one block of 0.9 s here, and /health waited 1.1 to 2.0 s under load, too
  // close to this bound for a test that must not flake (docs/GUIDE.md "Size limits")
  const srv = await childServer();
  try {
    const runs = Math.floor((MAX_ELEMENTS - 10) / 4);
    const bytes = docxBytes([], {}, `<w:p>${'<w:r><w:t xml:space="preserve">Acme </w:t></w:r>'.repeat(runs)}</w:p>`);
    const f = path.join(srv.root, "w.docx");
    fs.writeFileSync(f, bytes);
    const { key } = await srv.openPage(f);
    const note = 'replace "Acme" with "Initech"';
    const pv = await srv.api(key, "/api/quick", { note });
    assert.equal(pv.json.match?.local, true, JSON.stringify(pv.json));
    const done = await within(srv, "quick change on this Mac", async () => {
      await srv.api(key, "/api/send", { baseSha: sha(bytes), comments: [], note, quick: { command: pv.json.match.command, count: pv.json.match.count } });
      for (let i = 0; i < 600; i++) {
        const b = await srv.api(key, "/api/bootstrap");
        if (i > 2 && b.json.session.state !== "working") return b;
        await new Promise((r) => setTimeout(r, 200));
      }
      return null;
    });
    const run = done?.json.session.activity?.[0];
    assert.equal(run?.by, "local", JSON.stringify(run));
    assert.match(run.summary, new RegExp(`in ${runs} places`));
    const [para] = readDocxParagraphs(fs.readFileSync(f));
    assert.equal(para.text.split("Initech ").length - 1, runs, "every match is in the file");
    assert.ok(!para.text.includes("Acme"));
  } finally {
    await srv.stop();
  }
});
