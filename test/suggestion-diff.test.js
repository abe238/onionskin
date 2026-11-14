import assert from "node:assert/strict";
import { test } from "node:test";
import { splitChange } from "../web/src/suggestion-diff.js";

test("the changed part is cut at whole words and nothing is lost", () => {
  const d = splitChange("the item each quarter and files", "the item every quarter and files");
  assert.deepEqual(d, { pre: "the item ", del: "each", ins: "every", post: " quarter and files" });
  for (const [a, b] of [["a teh b", "a the b"], ["same", "same"], ["", "new"], ["old", ""], ["x 1,000 y", "x 1,200 y"]]) {
    const r = splitChange(a, b);
    assert.equal(r.pre + r.del + r.post, a);
    assert.equal(r.pre + r.ins + r.post, b);
  }
});

test("a long replace is drawn whole: what Now shows is every word Accept writes", () => {
  const find = `The board approved the plan ${"a".repeat(142)}`;
  const replace = `The board approved the plan ${"b".repeat(233)} AND WIRE $9,000 TO ACCOUNT 12345 TODAY`;
  const d = splitChange(find, replace);
  assert.equal(d.pre + d.ins + d.post, replace);
  assert.ok((d.pre + d.ins + d.post).includes("WIRE $9,000"));
});
