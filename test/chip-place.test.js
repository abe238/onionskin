import assert from "node:assert/strict";
import { test } from "node:test";
import { CHIP_H, CHIP_W, placeChip } from "../web/src/chip-place.js";

const box = { left: 0, top: 0, right: 1000, bottom: 800 };
const line = (left, top, right) => ({ left, top, right, bottom: top + 24 });
const none = (rs) => rs.map(() => 0);

test("placeChip: beside the end of the last line when nothing is there, else the place with the least text under it, always inside the box", () => {
  const sel = [line(100, 400, 500)];
  const beside = placeChip(sel, box, none);
  assert.equal(beside.x, 506, "right after the last word");
  assert.ok(beside.y >= 400 - CHIP_H && beside.y <= 424, "on the last line, not above it");
  // text beside it: below wins; text below as well: above the first line
  const textAt = (blocked) => (rs) => rs.map((r) => (blocked.some((b) => r.top >= b.from && r.top < b.to) ? 900 : 0));
  assert.equal(placeChip(sel, box, textAt([{ from: 380, to: 420 }])).y, 432, "below the last line");
  const above = placeChip(sel, box, textAt([{ from: 380, to: 420 }, { from: 420, to: 480 }]));
  assert.equal(above.y, 400 - CHIP_H - 2, "above the first line, never on the selection's own lines");
  // a multi-line selection: below means below its last line, above means above its first
  const two = [line(100, 400, 900), line(100, 424, 300)];
  assert.equal(placeChip(two, box, textAt([{ from: 380, to: 440 }])).y, 456, "below the last line");
  assert.equal(placeChip(two, box, textAt([{ from: 380, to: 460 }])).y, 400 - CHIP_H - 2, "above the first line");
  // at the right edge there is no room beside: the chip stays inside the box
  const edge = placeChip([line(700, 400, 990)], box, none);
  assert.ok(edge.x >= 0 && edge.x + CHIP_W <= box.right, "inside on the right");
  // at the top and bottom of the box
  const top = placeChip([line(100, 10, 990)], box, none);
  assert.ok(top.y >= 4, `not above the top (${top.y})`);
  const bottom = placeChip([line(100, 780, 990)], box, none);
  assert.ok(bottom.y + CHIP_H <= box.bottom, `not below the bottom (${bottom.y})`);
});
