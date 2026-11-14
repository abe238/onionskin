import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { rezip } from "./helpers/zipbuild.js";
import { ENGINE_SAMPLES as SAMPLES, haveSamples, skipUnless } from "../scripts/fixtures.mjs";
import { mergePptx } from "../src/merge-pptx.js";
import { parseDeck } from "../src/pptx.js";
import { runOps } from "../src/ops/run.js";
import { openZip } from "../src/zip.js";

// What the user changed in a deck while the agent worked is carried onto the agent's version, shape by shape (src/merge-pptx.js).
// Real PPTX bytes (the committed engine sample, with parts rewritten for each side), the real op engine.
// The sample: slide 1 (id 256) title + subtitle; slide 2 (257) title + five bullets in shape 3; slide 3 (258) title, three shapes,
// a picture and a text box (shape 7) with a plain and a bold run; slide 4 (259) title + table; slide 5 (260) title + chart frame.
const SKIP = skipUnless(haveSamples(), `engine samples not found in ${SAMPLES}`, "restore test/fixtures/engine or set ONIONSKIN_TEST_SAMPLES");
const BASE = SKIP ? null : fs.readFileSync(path.join(SAMPLES, "sample.pptx"));
const slidePart = (n) => `ppt/slides/slide${n}.xml`;
/** `bytes` with text replaced in one part; every pair must hit, so a test never passes on a variant that was not made */
const edit = (bytes, part, ...pairs) =>
  rezip(bytes, {
    [part]: (xml) => {
      for (const [from, to] of pairs) {
        assert.ok(xml.includes(from), `${part} does not contain ${from}`);
        xml = xml.replace(from, to);
      }
      return xml;
    },
  });
const text = (bytes, slideId, shapeId) => {
  const d = parseDeck(bytes);
  d.ensure();
  return d.slides.find((s) => s.id === String(slideId))?.shapes.find((x) => x.id === shapeId)?.text;
};
const merge = (mine, theirs, extra = {}) => mergePptx({ base: BASE, mine, theirs, name: "t.pptx", runOps, ...extra });
const BULLETS = ["Lazy ZIP: only the central directory is read up front", "Entries are inflated on demand with DecompressionStream", "Streaming XML parser in a Web Worker", "Blocks / rows / slides arrive progressively", "Virtualized React views"];
const SLD = (id, rid) => `<p:sldId id="${id}" r:id="${rid}"/>`;

test("the user and the agent change different shapes: both texts are in the result", { skip: SKIP }, async () => {
  const r = await merge(edit(BASE, slidePart(2), ["Why it is fast", "Why it is so fast"]), edit(BASE, slidePart(2), ["Virtualized React views", "Virtualized views"]));
  assert.equal(r.merged, 1);
  assert.deepEqual(r.unplaced, []);
  assert.equal(r.copy, false);
  assert.equal(text(r.bytes, 257, 2), "Why it is so fast");
  assert.equal(text(r.bytes, 257, 3), [...BULLETS.slice(0, 4), "Virtualized views"].join("\n"));
});

test("both change the same text box: the agent's text stays and the user's text is handed back, never dropped", { skip: SKIP }, async () => {
  const r = await merge(edit(BASE, slidePart(2), ["Lazy ZIP", "Lazy archive"]), edit(BASE, slidePart(2), ["Virtualized React views", "Virtualized views"]));
  assert.equal(r.bytes, null, "nothing is written when nothing could be carried");
  assert.equal(r.merged, 0);
  assert.equal(r.unplaced.length, 1);
  assert.equal(r.unplaced[0].text, ["Lazy archive: only the central directory is read up front", ...BULLETS.slice(1)].join("\n"));
  assert.equal(r.unplaced[0].why, 'The agent changed "Content Placeholder 2" on slide 2 too. Its text is on the slide; this is yours.');
});

test("several lines of one text box changed, one of them with words that also occur in a line above: each lands in its own line", { skip: SKIP }, async () => {
  // "on demand" is made to occur in the first line too, so the replace in the second line has to name its occurrence
  const base = edit(BASE, slidePart(2), ["is read up front", "is read on demand"]);
  const mine = edit(base, slidePart(2), ["inflated on demand with", "inflated on request with"], ["Virtualized React views", "Virtual views"]);
  const theirs = edit(base, slidePart(2), ["Why it is fast", "Why it is quick"]);
  const r = await mergePptx({ base, mine, theirs, name: "t.pptx", runOps });
  assert.deepEqual(r.unplaced, []);
  assert.equal(r.merged, 1);
  assert.equal(text(r.bytes, 257, 3), text(mine, 257, 3));
  assert.match(text(r.bytes, 257, 3), /^Lazy ZIP: only the central directory is read on demand\nEntries are inflated on request with/);
  assert.equal(text(r.bytes, 257, 2), "Why it is quick");
});

test("a line added to a text box with one format is carried; a text box emptied by the user is emptied", { skip: SKIP }, async () => {
  const mine = edit(edit(BASE, slidePart(2), ["<a:t>Virtualized React views</a:t></a:r></a:p>", "<a:t>Virtualized React views</a:t></a:r></a:p><a:p><a:pPr/><a:r><a:t>A sixth point</a:t></a:r></a:p>"]), slidePart(1), ["<a:t>office-engine</a:t>", "<a:t></a:t>"]);
  const r = await merge(mine, edit(BASE, slidePart(2), ["Why it is fast", "Why it is quick"]));
  assert.deepEqual(r.unplaced, []);
  assert.equal(r.merged, 2);
  assert.equal(text(r.bytes, 257, 3), [...BULLETS, "A sixth point"].join("\n"));
  assert.equal(text(r.bytes, 256, 2), "");
  assert.equal(text(r.bytes, 257, 2), "Why it is quick");
});

test("text with mixed formats: a changed word is carried and the bold run stays; an added line is handed back", { skip: SKIP }, async () => {
  const theirs = edit(BASE, slidePart(3), ["<a:t>Oval</a:t>", "<a:t>Ellipse</a:t>"]);
  const word = await merge(edit(BASE, slidePart(3), ["A free text box with ", "An open text box with "]), theirs);
  assert.deepEqual(word.unplaced, []);
  assert.equal(text(word.bytes, 258, 7), "An open text box with colored bold text");
  const d = parseDeck(word.bytes);
  d.ensure();
  assert.match(d.slides[2].shapes.find((x) => x.id === 7).fmt.b, /^~/, "one run is still bold and one is not");
  assert.equal(text(word.bytes, 258, 4), "Ellipse");
  const line = await merge(edit(BASE, slidePart(3), ["colored bold text</a:t></a:r></a:p>", "colored bold text</a:t></a:r></a:p><a:p><a:r><a:t>One more line</a:t></a:r></a:p>"]), theirs);
  assert.equal(line.bytes, null);
  assert.match(line.unplaced[0].why, /^You added or removed lines in "TextBox 6" on slide 3, whose text mixes formats/);
  assert.equal(line.unplaced[0].text, "A free text box with colored bold text\nOne more line");
});

test("slides the agent added, removed or reordered: text on a slide all three versions have is still placed, by slide id", { skip: SKIP }, async () => {
  const mine = edit(edit(BASE, slidePart(2), ["Why it is fast", "Why it is so fast"]), slidePart(1), ["office-engine", "The engine"]);
  // the agent moves slide 2 to the end and drops slide 1 from the deck
  const theirs = edit(BASE, "ppt/presentation.xml", [SLD(256, "rId7"), ""], [SLD(257, "rId8"), ""], [SLD(260, "rId11"), SLD(260, "rId11") + SLD(257, "rId8")]);
  const r = await merge(mine, theirs);
  assert.equal(r.merged, 1);
  assert.equal(text(r.bytes, 257, 2), "Why it is so fast");
  const out = parseDeck(r.bytes);
  assert.deepEqual(out.slides.map((s) => s.id), ["258", "259", "260", "257"], "the agent's slide order stands");
  assert.deepEqual(r.unplaced, [{ label: "Slide 1, Title", text: "The engine", why: "The agent removed slide 1, so your edit to the title on slide 1 was not carried over. This is yours." }]);
});

test("slides the user added, removed or moved are reported and the user's file is kept; their text edits elsewhere still merge", { skip: SKIP }, async () => {
  const theirs = edit(BASE, slidePart(2), ["Virtualized React views", "Virtualized views"]);
  const moved = await merge(edit(edit(BASE, "ppt/presentation.xml", [SLD(256, "rId7") + SLD(257, "rId8"), SLD(257, "rId8") + SLD(256, "rId7")], [SLD(260, "rId11"), ""]), slidePart(3), ["<a:t>Oval</a:t>", "<a:t>Ellipse</a:t>"]), theirs);
  assert.deepEqual(moved.unplaced.map((u) => u.why), ["You removed the slide that was slide 5. Slide changes are not carried over.", "You moved slides. Slide changes are not carried over."]);
  assert.equal(moved.merged, 1);
  assert.equal(text(moved.bytes, 258, 4), "Ellipse");
  assert.deepEqual(parseDeck(moved.bytes).slides.map((s) => s.id), ["256", "257", "258", "259", "260"]);
  // the user "added" slide 5: base and theirs are the deck without it
  const without = (bytes) => edit(bytes, "ppt/presentation.xml", [SLD(260, "rId11"), ""]);
  const added = await mergePptx({ base: without(BASE), mine: BASE, theirs: without(theirs), name: "t.pptx", runOps });
  assert.equal(added.bytes, null);
  assert.equal(added.copy, true, "a whole slide is not in the list: the caller keeps the user's file");
  assert.deepEqual(added.unplaced, [{ label: "Slide 5", text: "Chart (placeholder)", why: "You added slide 5. Slide changes are not carried over. This is its text." }]);
});

test("shapes the user added or removed and table text are reported with their text, not rebuilt", { skip: SKIP }, async () => {
  const OVAL = /<p:sp><p:nvSpPr><p:cNvPr id="4" name="Oval 3"\/>.*?<\/p:sp>/s;
  const without = (bytes) => rezip(bytes, { [slidePart(3)]: (xml) => (assert.match(xml, OVAL), xml.replace(OVAL, "")) });
  const theirs = edit(BASE, slidePart(2), ["Virtualized React views", "Virtualized views"]);
  const added = await mergePptx({ base: without(BASE), mine: BASE, theirs: without(theirs), name: "t.pptx", runOps });
  assert.equal(added.bytes, null);
  assert.equal(added.copy, true);
  assert.deepEqual(added.unplaced, [{ label: "Slide 3, Oval 3", text: "Oval", why: 'You added "Oval 3" on slide 3. Shape changes are not carried over. This is its text.' }]);
  const removed = await merge(without(BASE), theirs);
  assert.deepEqual(removed.unplaced.map((u) => u.why), ['You removed "Oval 3" on slide 3. Shape changes are not carried over.']);
  const table = await merge(edit(BASE, slidePart(4), ["<a:t>Metric</a:t>", "<a:t>Measure</a:t>"]), theirs);
  assert.equal(table.bytes, null);
  assert.match(table.unplaced[0].why, /^You changed "Table 2" on slide 4, which is not a plain text box/);
  assert.match(table.unplaced[0].text, /^Measure\n2024/);
});

test("protected content, a blocked package check, a result that changes the agent's text: nothing is written", { skip: SKIP }, async () => {
  const mine = edit(edit(BASE, slidePart(2), ["Why it is fast", "Why it is so fast"]), slidePart(1), ["office-engine", "The engine"]);
  const theirs = edit(BASE, slidePart(2), ["Virtualized React views", "Virtualized views"]);
  const stub = (answer) => mergePptx({ base: BASE, mine, theirs, name: "t.pptx", runOps: async ({ ops }) => answer(ops) });
  const prot = await stub((ops) => ({ results: ops.map((op, index) => ({ index, op: op.op, status: "skipped_protected", reason: "the match is in a protected paragraph" })), bytes: null, warnings: [], blocked: null }));
  assert.equal(prot.bytes, null);
  assert.deepEqual(prot.unplaced.map((u) => [u.text, u.why]), [
    ["The engine", "Your edit to the title on slide 1 was not carried over: the text box holds content that cannot be rewritten safely (a field or an equation). This is yours."],
    ["Why it is so fast", "Your edit to the title on slide 2 was not carried over: the text box holds content that cannot be rewritten safely (a field or an equation). This is yours."],
  ]);
  const blocked = await stub((ops) => ({ results: ops.map((op, index) => ({ index, op: op.op, status: "not_applied" })), bytes: null, warnings: [], blocked: [{ code: "part_removed" }] }));
  assert.equal(blocked.bytes, null);
  assert.match(blocked.unplaced[0].why, /would have damaged the file/);
  // an engine that writes the carried text and also loses the agent's
  const lossy = await stub((ops) => ({ results: ops.map((op, index) => ({ index, op: op.op, status: "applied" })), bytes: mine, warnings: [], blocked: null }));
  assert.equal(lossy.bytes, null, "the agent's bullet is gone from the result: it is not written");
  assert.deepEqual(lossy.unplaced.map((u) => u.text), ["The engine", "Why it is so fast"]);
  assert.match(lossy.unplaced[0].why, /would have changed the agent's text/);
  // one op does not apply (the shape is not what `expect` says): the other shape is written, this one is handed back
  const real = await mergePptx({ base: BASE, mine, theirs, name: "t.pptx", runOps: (a) => runOps({ ...a, ops: a.ops.map((op, i) => (i ? op : { ...op, expect: { text_hash: "0".repeat(16) } })) }) });
  assert.equal(real.merged, 1);
  assert.equal(text(real.bytes, 256, 2), "office-engine");
  assert.equal(text(real.bytes, 257, 2), "Why it is so fast");
  assert.deepEqual(real.unplaced.map((u) => u.text), ["The engine"]);
});

test("a text box with a field: its changed words are carried by replace; the real engine refuses to rewrite it whole", { skip: SKIP }, async () => {
  const FIELD = '<a:fld id="{B6F15528-21DE-4FAA-801E-634DDDAF4B2B}" type="slidenum"><a:rPr lang="en-US"/><a:t>1</a:t></a:fld>';
  const base = edit(BASE, slidePart(1), ["<a:r><a:t>Progressive Office viewer for the browser</a:t></a:r>", `<a:r><a:t>Progressive Office viewer for the browser, page </a:t></a:r>${FIELD}`]);
  const theirs = edit(base, slidePart(1), ["office-engine", "The engine"]);
  const word = await mergePptx({ base, mine: edit(base, slidePart(1), ["Progressive Office viewer", "Fast Office viewer"]), theirs, name: "t.pptx", runOps });
  assert.deepEqual(word.unplaced, []);
  assert.equal(text(word.bytes, 256, 3), "Fast Office viewer for the browser, page 1");
  assert.match(openZip(word.bytes).readText(slidePart(1)), /type="slidenum"/, "the field survived");
  const line = await mergePptx({ base, mine: edit(base, slidePart(1), [`${FIELD}</a:p>`, `${FIELD}</a:p><a:p><a:r><a:t>Second line</a:t></a:r></a:p>`]), theirs, name: "t.pptx", runOps });
  assert.equal(line.bytes, null, "nothing is written");
  assert.equal(line.unplaced.length, 1);
  assert.match(line.unplaced[0].text, /Second line$/);
  assert.equal(text(theirs, 256, 2), "The engine");
});

test("formatting, shape and slide changes the page names are reported as not carried over; they never stop the text", { skip: SKIP }, async () => {
  const r = await merge(edit(BASE, slidePart(2), ["Why it is fast", "Why it is so fast"]), edit(BASE, slidePart(2), ["Virtualized React views", "Virtualized views"]), { edits: [{ kind: "text", slide: 1 }, { kind: "format", slide: 1 }, { kind: "format", slide: 1 }, { kind: "shape.transform", slide: 2 }, { kind: "slide.hide", slide: 4 }, { kind: "undo", slide: 0 }] });
  assert.equal(r.merged, 1);
  assert.equal(r.copy, true, "a moved shape is only in the user's file");
  assert.deepEqual(r.unplaced.map((u) => u.why), [
    "You changed slides (hidden, background or order). Slide changes are not carried over.",
    "You changed text formatting on slide 2. Formatting is not carried over.",
    "You added, removed, moved or restyled shapes on slide 3. Shape changes are not carried over.",
  ]);
});

test("the session merge writes a deck as the user's update", { skip: SKIP }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "os-merge-p-"));
  process.env.ONIONSKIN_STATE_DIR = path.join(root, "st");
  try {
    const { Sessions } = await import("../src/session.js");
    const { ensureStateDir } = await import("../src/paths.js");
    const { sha256 } = await import("../src/fsutil.js");
    ensureStateDir();
    const file = path.join(root, "d.pptx");
    fs.writeFileSync(file, BASE);
    const S = new Sessions();
    const s = S.open(file);
    s.snapshots.add(BASE, "sent");
    const theirs = edit(BASE, slidePart(2), ["Virtualized React views", "Virtualized views"]);
    fs.writeFileSync(file, theirs);
    s.baseSha = sha256(theirs);
    const r = await S.mergeUserEdits(s.key, { baseSha: sha256(BASE), bytes: edit(BASE, slidePart(2), ["Why it is fast", "Why it is so fast"]), edits: [{ kind: "text", slide: 1 }] });
    assert.deepEqual({ merged: r.merged, unplaced: r.unplaced, copy_name: r.copy_name }, { merged: 1, unplaced: [], copy_name: null });
    assert.equal(r.sha, sha256(fs.readFileSync(file)));
    assert.equal(text(fs.readFileSync(file), 257, 2), "Why it is so fast");
    assert.match(text(fs.readFileSync(file), 257, 3), /Virtualized views$/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
