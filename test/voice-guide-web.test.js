import assert from "node:assert/strict";
import { test } from "node:test";
import { SECTIONS as SRC, GUIDE_MAX as SRC_MAX } from "../src/voice-guide.js";
import { GUIDE_MAX, SECTIONS, addSpan, composeGuide, covered, hasHeadingLine, lineDiff, parseGuide } from "../web/src/voice-guide.js";
import { GUIDE_MAX as UI_MAX } from "../web/src/voice-ui.js";
import { beginGuideRequest, onReviewDraft, reviewDraft } from "../web/src/voice-bus.js";

test("activity can open the draft again once the last guide request settles", () => {
  let opened = 0;
  const unsubscribe = onReviewDraft(() => opened++);
  try {
    const finishFirstSave = beginGuideRequest();
    const finishSecondSave = beginGuideRequest();
    reviewDraft();
    assert.equal(opened, 0);
    finishFirstSave();
    finishFirstSave();
    reviewDraft();
    assert.equal(opened, 0, "finishing the first save twice must leave the second save pending");
    finishSecondSave();
    reviewDraft();
    assert.equal(opened, 1);
  } finally {
    unsubscribe();
  }
});

// The page's copy of the guide's sections (web/src/voice-guide.js) must be the server's list, and its pure helpers.
test("the page's SECTIONS and caps are the server's", () => {
  assert.deepEqual(SECTIONS, SRC);
  assert.equal(GUIDE_MAX, SRC_MAX);
  assert.equal(UI_MAX, SRC_MAX);
});

const guide = (over = {}) => SECTIONS.map((s) => `## ${s.title}\n${over[s.id] ?? `Body of ${s.id}.`}`).join("\n\n");

test("parseGuide: sections in order, a title line is skipped, any other # line or text before a heading is not structured", () => {
  const p = parseGuide(`# My voice guide\n\n${guide({ tone: "Line one.\nLine two." })}\n`);
  assert.equal(p.structured, true);
  assert.deepEqual(p.sections.map((s) => s.id), SECTIONS.map((s) => s.id));
  assert.equal(p.sections.find((s) => s.id === "tone").body, "Line one.\nLine two.");
  assert.equal(parseGuide("## In short\nA\n\n## Humor\nB").sections.length, 2, "some sections only");
  for (const bad of ["", "   ", "Just text.", "Intro\n## In short\nA", "## In short\nA\n# Other", "## Humor\nB\n## In short\nA", "## In short\nA\n## In short\nB", "## Unknown\nA", "## In short\nA\n＃ hidden"]) {
    assert.deepEqual(parseGuide(bad), { structured: false, sections: [] }, JSON.stringify(bad));
  }
  assert.deepEqual(parseGuide(null), { structured: false, sections: [] });
});

test("composeGuide: a ticked section comes from its box, an unticked one keeps the saved body, one with nothing saved is left out", () => {
  const saved = parseGuide(guide()).sections.filter((s) => s.id !== "humor");
  const texts = { short: "New short.", tone: "New tone.", humor: "New humor.", rules: "  " };
  const out = composeGuide(texts, { short: true, humor: false, tone: false, rules: true }, saved);
  const p = parseGuide(out);
  assert.equal(p.structured, true);
  assert.equal(p.sections.find((s) => s.id === "short").body, "New short.");
  assert.equal(p.sections.find((s) => s.id === "tone").body, "Body of tone.", "unticked: the saved body");
  assert.equal(p.sections.some((s) => s.id === "humor"), false, "unticked and nothing saved: left out");
  assert.equal(p.sections.some((s) => s.id === "rules"), false, "ticked but empty: left out");
  assert.equal(composeGuide({}, {}, []), "");
  // the fixed order, whatever order the boxes were filled in
  assert.deepEqual(parseGuide(composeGuide({ rules: "R", short: "S" }, { rules: true, short: true })).sections.map((s) => s.id), ["short", "rules"]);
});

test("hasHeadingLine: a line starting with # (also a fullwidth one) is found", () => {
  assert.equal(hasHeadingLine("a\n# b"), true);
  assert.equal(hasHeadingLine("a\n  ## b"), true);
  assert.equal(hasHeadingLine("a\n＃ b"), true);
  assert.equal(hasHeadingLine("a # b\nc"), false);
});

test("lineDiff: same, added and removed lines", () => {
  assert.deepEqual(lineDiff("a\nb", "a\nb"), [{ t: "same", text: "a" }, { t: "same", text: "b" }]);
  assert.deepEqual(lineDiff("a\nb", "a\nb\nc"), [{ t: "same", text: "a" }, { t: "same", text: "b" }, { t: "add", text: "c" }]);
  assert.deepEqual(lineDiff("a\nb\nc", "a\nc"), [{ t: "same", text: "a" }, { t: "del", text: "b" }, { t: "same", text: "c" }]);
  assert.deepEqual(lineDiff("a", "b"), [{ t: "del", text: "a" }, { t: "add", text: "b" }]);
  assert.deepEqual(lineDiff("", "x"), [{ t: "add", text: "x" }]);
  assert.deepEqual(lineDiff("x", ""), [{ t: "del", text: "x" }]);
  assert.deepEqual(lineDiff("", ""), []);
  const big = Array.from({ length: 401 }, (_, i) => `l${i}`).join("\n");
  assert.equal(lineDiff(big, big).filter((d) => d.t !== "same").length, 802, "over 400 lines: compared as a whole");
});

test("addSpan and covered: a box counts as read only once every part of it has been in view, top to bottom", () => {
  let s = addSpan([], 0, 600); // the top of a 2,500 px box, as the editor opens
  assert.equal(covered(s, 2500), false, "only the top was on screen");
  s = addSpan(s, 1900, 2500); // a jump to the end shows only the bottom
  assert.equal(covered(s, 2500), false, "the middle was never on screen");
  for (let y = 500; y < 1900; y += 400) s = addSpan(s, y, y + 600); // scrolled through
  assert.deepEqual(s, [[0, 2500]]);
  assert.equal(covered(s, 2500), true);
  assert.equal(covered(addSpan([], 1, 299), 300), true, "a pixel of rounding at each end is fine");
  assert.equal(covered(addSpan([], 0, 290), 300), false);
  assert.equal(covered(addSpan(addSpan([], 0, 100), 104, 300), 300), false, "a gap of a few pixels is a gap");
  assert.equal(covered([], 0), false, "a box with no height was never read");
  assert.deepEqual(addSpan([[0, 10], [20, 30]], 5, 25), [[0, 30]]);
  assert.deepEqual(addSpan([[20, 30]], 0, 10), [[0, 10], [20, 30]]);
  assert.deepEqual(addSpan([[0, 10]], 8, 8), [[0, 10]], "an empty span adds nothing");
});
