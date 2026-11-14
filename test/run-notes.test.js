import { test } from "node:test";
import assert from "node:assert/strict";
import { flagText, shownFlags } from "../web/src/lib.js";
import { autoSummaryText } from "../src/reply.js";
import { blockingFlags } from "../src/ops/run.js";

test("a copied slide is one plain note in the panel, without its link file", () => {
  const flags = [
    { code: "part_added", severity: "info", part: "ppt/slides/slide6.xml" },
    { code: "part_added", severity: "info", part: "ppt/slides/_rels/slide6.xml.rels" },
    { code: "part_added", severity: "info", part: "word/media/image3.png" },
  ];
  const shown = shownFlags(flags);
  assert.deepEqual(shown.map((f) => f.part), ["ppt/slides/slide6.xml", "word/media/image3.png"]);
  assert.equal(flagText(shown[0]), "A slide was added to the deck.");
  assert.equal(flagText(shown[1]), "A new part appeared in the file: word/media/image3.png");
  assert.deepEqual(shownFlags(undefined), []);
});

test("a run with no summary from the agent never says No change needed when the file was written", () => {
  assert.equal(autoSummaryText({ applied: 0, declined: 0, asked: 0, written: true }), "Changed the file as your note asked");
  assert.equal(autoSummaryText({ applied: 0, declined: 0, asked: 0, written: false }), "No change needed");
  assert.equal(autoSummaryText({ applied: 0, declined: 0, asked: 0, written: false, userEdits: 2 }), "Your edits are saved. Nothing else needed changing.");
  assert.equal(autoSummaryText({ applied: 2, declined: 1, asked: 1, written: true }), "2 changed, 1 declined, 1 question");
});

test("a write that lost a slide is blocked unless an op deleted one", () => {
  const gone = [{ code: "slide_removed", part: "ppt/slides/slide2.xml" }, { code: "part_added", part: "ppt/slides/slide9.xml" }];
  assert.deepEqual(blockingFlags(gone, { rewrites: false, slideDeleted: false }).map((f) => f.code), ["slide_removed"]);
  assert.deepEqual(blockingFlags(gone, { rewrites: true, slideDeleted: false }).map((f) => f.code), ["slide_removed"], "a rewrite does not excuse a lost slide");
  assert.deepEqual(blockingFlags(gone, { rewrites: false, slideDeleted: true }), []);
  assert.deepEqual(blockingFlags([{ code: "part_removed", part: "x" }], { rewrites: true, slideDeleted: true }).length, 1);
});

test("a deleted slide is one plain note in the panel", () => {
  const flags = ["ppt/notesSlides/_rels/notesSlide1.xml.rels", "ppt/notesSlides/notesSlide1.xml", "ppt/slides/_rels/slide2.xml.rels", "ppt/slides/slide2.xml"].map((part) => ({ code: "slide_removed", severity: "warn", part }));
  const shown = shownFlags([...flags, ...flags]); // reported by both checks
  assert.equal(shown.length, 1);
  assert.equal(flagText(shown[0]), "A slide was removed from the deck. Revert this run brings it back.");
});
