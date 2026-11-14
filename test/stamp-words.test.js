import assert from "node:assert/strict";
import { test } from "node:test";
import { BUILT_IN, LANGUAGES } from "../web/src/stamps.js";
import { BUILT_IN_STAMP_WORDS, STAMP_LANGUAGES, STAMP_WORDS } from "../src/stamp-words.js";

test("stamp-words: the server's copy equals the page's built-in stamps", () => {
  assert.deepEqual(STAMP_WORDS, Object.fromEntries(BUILT_IN.map((s) => [s.id, s.words])));
  assert.deepEqual(BUILT_IN_STAMP_WORDS, BUILT_IN.map((s) => s.words));
  assert.deepEqual(STAMP_LANGUAGES, LANGUAGES);
});
