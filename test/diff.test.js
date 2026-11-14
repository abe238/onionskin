import assert from "node:assert/strict";
import { test } from "node:test";
import { diffRaw, diffText, tokenize, HARD_CAP_TOKENS } from "../src/diff.js";

const text = (ops, types) => ops.filter((o) => types.includes(o[0])).map((o) => o[1] ?? "").join("");

test("diff: a replaced word is one removed and one added op with its neighbors as context", () => {
  const d = diffText("The quick brown fox jumps", "The quick red fox jumps");
  assert.deepEqual(d.ops, [["=", "The quick "], ["-", "brown"], ["+", "red"], ["=", " fox jumps"]]);
  assert.equal(d.level, "word");
});

test("diff: insert and delete", () => {
  assert.deepEqual(diffText("one two three", "one two extra three").ops, [["=", "one two "], ["+", "extra "], ["=", "three"]]);
  assert.deepEqual(diffText("one two extra three", "one two three").ops, [["=", "one two "], ["-", "extra "], ["=", "three"]]);
});

test("diff: unchanged text is trimmed to about six words each side, with an ellipsis marker", () => {
  const a = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa";
  const b = a.replace("juliet", "JULIET");
  assert.deepEqual(diffText(a, b).ops, [["…"], ["=", "delta echo foxtrot golf hotel india "], ["-", "juliet"], ["+", "JULIET"], ["=", " kilo lima mike november oscar papa"]]);
  // a change in the middle of two far-apart edits keeps both sides of the gap
  const c = a.replace("alpha", "ALPHA").replace("papa", "PAPA");
  const ops = diffText(a, c).ops;
  assert.deepEqual(ops.filter((o) => o[0] === "…"), [["…"]], "the long run between the two edits is cut once");
  assert.equal(ops[0][0], "-", "no ellipsis before a change at the very start");
});

test("diff: moved text is a delete plus an insert, never silently merged", () => {
  const d = diffText("A B C D E F", "C D E F A B");
  assert.ok(text(d.ops, ["-"]).includes("A B") && text(d.ops, ["+"]).includes("A B"));
  assert.ok(text(d.ops, ["="]).includes("C D E F"));
});

test("diff: punctuation is its own token", () => {
  assert.deepEqual(tokenize("Hello, world."), ["Hello", ",", " ", "world", "."]);
  assert.deepEqual(tokenize("don't stop"), ["don't", " ", "stop"]);
  const d = diffText("Hello, world.", "Hello world!");
  assert.equal(text(d.ops, ["="]), "Hello world");
  assert.equal(text(d.ops, ["-"]), ",.");
  assert.equal(text(d.ops, ["+"]), "!");
});

test("diff: a whitespace-only change is formatting-only with no ops; identical strings are identical", () => {
  assert.deepEqual(diffText("a b  c", "a b c"), { formatting_only: true, ops: [] });
  assert.deepEqual(diffText("a\tb", "a b"), { formatting_only: true, ops: [] });
  assert.deepEqual(diffText("same text", "same text"), { identical: true, ops: [] });
  assert.deepEqual(diffText("", ""), { identical: true, ops: [] });
});

test("diff: CJK text is diffed per character", () => {
  assert.deepEqual(tokenize("今天天气"), ["今", "天", "天", "气"]);
  assert.deepEqual(diffText("今天天气很好", "今天天气不错").ops, [["=", "今天天气"], ["-", "很好"], ["+", "不错"]]);
  assert.deepEqual(tokenize("ひらがなカタカナ").length, 8);
});

test("diff: unicode (accents, emoji, combining marks) tokenizes without splitting words or code points", () => {
  assert.deepEqual(tokenize("café 😀 naïve"), ["café", " ", "😀", " ", "naïve"]);
  const d = diffText("Crème brûlée 😀 today", "Crème brûlée 😢 today");
  assert.equal(text(d.ops, ["-"]), "😀");
  assert.equal(text(d.ops, ["+"]), "😢");
  const decomposed = "Café au lait";
  assert.deepEqual(tokenize(decomposed)[0], "Café", "a combining accent stays inside its word");
});

test("diff: a very long paragraph with a small edit is still word-level, fast, and bounded in size", () => {
  const long = Array.from({ length: 5000 }, (_, i) => `word${i}.`).join(" ");
  const t0 = Date.now();
  const d = diffText(long, long.replace("word2500.", "changed2500."));
  assert.ok(Date.now() - t0 < 500, `took ${Date.now() - t0} ms`);
  assert.equal(d.level, "word");
  assert.ok(JSON.stringify(d.ops).length < 400);
  assert.equal(text(d.ops, ["-"]), "word2500");
});

test("diff: a long, heavily rewritten paragraph falls back to sentences; over the hard cap nothing is computed", () => {
  const a = Array.from({ length: 1500 }, (_, i) => `Sentence number ${i} stays here.`).join(" ");
  const b = a.replace("number 700 stays", "number 700 now goes");
  assert.ok(tokenize(a).length > 2000);
  // one small change: the trimmed prefix and suffix leave a tiny middle, so it stays word-level
  assert.equal(diffText(a, b).level, "word");
  // many changes spread over the whole text: the changed middle is over 2,000 tokens, so sentences are compared first
  const c = a.replace(/stays/g, "remains");
  const d = diffText(a, c);
  assert.equal(d.level, "sentence");
  assert.ok(d.ops.some((o) => o[0] === "-") && d.ops.some((o) => o[0] === "+"));
  const huge = diffText("x ".repeat(HARD_CAP_TOKENS), "y ".repeat(HARD_CAP_TOKENS));
  assert.deepEqual(huge, { too_large: true });
});

// diffRaw: the untrimmed script the tracked-changes copy is built from. Both sides must come back exactly.
const rebuilds = (a, b) => {
  const ops = diffRaw(a, b);
  assert.equal(text(ops, ["=", "-"]), a, "the = and - texts give the old text");
  assert.equal(text(ops, ["=", "+"]), b, "the = and + texts give the new text");
  assert.ok(ops.every((o) => ["=", "-", "+"].includes(o[0]) && o[1].length > 0), "only = - + ops, none empty");
  return ops;
};

test("diffRaw: a replaced word, nothing trimmed, removal before addition", () => {
  const a = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa";
  assert.deepEqual(rebuilds(a, a.replace("juliet", "JULIET")), [["=", "alpha bravo charlie delta echo foxtrot golf hotel india "], ["-", "juliet"], ["+", "JULIET"], ["=", " kilo lima mike november oscar papa"]]);
  assert.deepEqual(diffRaw("same", "same"), [["=", "same"]]);
  assert.deepEqual(diffRaw("", ""), []);
});

test("diffRaw: rebuilds both sides for CJK, whitespace-only, tabs and line breaks", () => {
  rebuilds("今日は良い天気です。", "今日は悪い天気でした。");
  rebuilds("one  two\tthree", "one two\tthree");
  rebuilds("line one\nline two", "line one\n\nline 2");
  rebuilds(" leading and trailing ", "leading and trailing");
  rebuilds("", "new text");
  rebuilds("old text", "");
});

test("diffRaw: a long paragraph goes by sentence and still rebuilds exactly", () => {
  const s = Array.from({ length: 400 }, (_, i) => `Sentence ${i} has a few words.`).join(" ");
  assert.ok(tokenize(s).length > 2000);
  rebuilds(s, s.replace("Sentence 10 has", "Sentence ten has").replace("Sentence 390 has a few", "Sentence 390 had some"));
});

test("diffRaw: past the Myers limit (more than 2,000 edits) it is one removal plus one addition, and rebuilds", () => {
  const a = Array.from({ length: 900 }, (_, i) => `a${i}`).join(" ");
  const b = Array.from({ length: 900 }, (_, i) => `b${i}`).join(" ");
  const ops = rebuilds(a, b);
  assert.ok(ops.length <= 4, `coarse script: ${ops.length} ops`);
  const huge = "word ".repeat(HARD_CAP_TOKENS);
  rebuilds(huge, huge + "tail");
});
