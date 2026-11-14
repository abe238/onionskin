import assert from "node:assert/strict";
import { test } from "node:test";
import { HEADING_PHRASES, normalizeNote, recognize, refusalFor, wordsFor } from "../src/quick.js";
import { validateOps } from "../src/ops/schema.js";

const rep = (note, format = "docx") => recognize(note, format);

test("heading phrases: the closed table is exactly 60 phrases and every one is recognized (DOCX only)", () => {
  assert.equal(HEADING_PHRASES.size, 60);
  for (const [phrase, set] of HEADING_PHRASES) {
    for (const note of [phrase, phrase.toUpperCase(), `Please ${phrase}.`, `${phrase} in the document!`]) {
      const r = rep(note);
      assert.equal(r?.kind, "headings", note);
      assert.deepEqual(r.op, { op: "format_all", scope: "headings", set }, note);
      assert.equal(rep(note, "xlsx"), null, note);
      assert.equal(rep(note, "pptx"), null, note);
    }
  }
  assert.deepEqual(rep("Make all the headings italic").set, { italic: true });
  assert.deepEqual(rep("underline each heading").set, { underline: true });
  assert.deepEqual(rep("Remove the bold from every heading").set, { bold: false });
  assert.deepEqual(rep("remove underlining from the headings").set, { underline: false });
});

test("heading op plus a count passes the ops schema", () => {
  const r = rep("bold the headings");
  assert.deepEqual(validateOps({ schema: "onionskin.ops/1", ops: [{ ...r.op, expect: { count: 9 } }] }), { ok: true, errors: [] });
});

test("replace: the plain forms, quoted forms (commas and joining words survive), tails and politeness", () => {
  const ok = (note, find, replace) => {
    const r = rep(note);
    assert.equal(r?.kind, "replace", note);
    assert.deepEqual([r.find, r.replace], [find, replace], note);
    assert.deepEqual(r.op, { op: "replace_all_text", find, replace, match_case: true }, note);
    return r;
  };
  ok("Replace Acme with Initech", "Acme", "Initech");
  ok("replace all Acme with Initech everywhere.", "Acme", "Initech");
  ok("Please replace every Acme Corp with Initech Inc throughout!", "Acme Corp", "Initech Inc");
  ok("Replace Q3 with Q4 in the file", "Q3", "Q4");
  ok('Replace "Acme, Inc." with "Initech, LLC"', "Acme, Inc.", "Initech, LLC");
  ok("Replace “Acme” with “Initech”", "Acme", "Initech");
  ok('Replace "this and that" with "in or out"', "this and that", "in or out");
  ok('Replace "Acme with Initech" with "x"', "Acme with Initech", "x");
  ok('Replace Acme with ""', "Acme", ""); // removing text must be said as an empty quoted string
  ok("REPLACE Acme WITH initech", "Acme", "initech");
  const r = rep("Replace Acme with Initech", "xlsx");
  assert.equal(r.kind, "replace"); // replace works on all three formats
  assert.equal(rep("Replace Acme with Initech", "pptx").kind, "replace");
  assert.equal(r.command, "Replace Acme with Initech");
  assert.equal(rep("Replace Acme with Initech everywhere.").command, "Replace Acme with Initech");
  assert.deepEqual(validateOps({ schema: "onionskin.ops/1", ops: [{ ...r.op, expect: { count: 12 } }] }), { ok: true, errors: [] });
});

test("refused: anything not exactly recognized falls through to the agent", () => {
  for (const note of [
    "Replace Acme with Initech and fix the intro",
    "Replace Q3 with Q4 in the summary",
    "Change the tone to formal",
    "replace he",
    "replace he with",
    "Replace with Initech",
    "Replace all with Initech",
    "Replace Acme with Acme",
    'Replace "Acme" with "Acme"',
    "Replace A with B", // a one-character find
    'Replace " " with "x"',
    "Replace Acme with", // a missing replacement is not a deletion
    "Replace Acme, Inc with Initech", // list punctuation needs quotes
    "Replace Acme with Initech, then bold it",
    "Replace Acme or Beta with Initech",
    "Replace Acme with Initech to Beta",
    "Replace Acme with Initech with Beta",
    "Replace one two three four five six seven with x", // seven words
    `Replace ${"x".repeat(61)} with y`,
    'Replace "Acme" with "Initech" and more',
    'Replace "Acme with "Initech"',
    "Replace Acme with Initech?",
    "Replace Acme with Initech\nand more",
    `Replace Acme with ${"y ".repeat(110)}`,
    "Replace Acme with Initech\u0007",
    "",
    "   ",
    "bold",
    "bold the headings and the body",
    "make the headings red",
    "bold the headings in the summary",
    "italicize some headings",
  ]) assert.equal(rep(note), null, JSON.stringify(note));
  assert.equal(rep(undefined), null);
  assert.equal(rep(42), null);
  assert.equal(normalizeNote(`a${" ".repeat(10)}${"b".repeat(200)}`), null);
});

test("refusalFor: no match, part of a longer word and inside a formula all hand the request to the agent", () => {
  assert.equal(refusalFor("replace", { ok: true, count: 12, partial_words: 0 }, "Acme"), null);
  assert.equal(refusalFor("headings", { ok: true, count: 9 }), null);
  assert.equal(refusalFor("replace", { ok: true, count: 0, partial_words: 0 }, "Acme"), 'No "Acme" in this file. The agent will look into it.');
  assert.match(refusalFor("headings", { ok: true, count: 0 }), /No headings/);
  assert.match(refusalFor("replace", { ok: true, count: 3, partial_words: 1 }, "he"), /longer words/);
  assert.match(refusalFor("replace", { ok: true, count: 3, partial_words: 0, in_formulas: 2 }, "C3"), /inside formulas/);
  assert.match(refusalFor("replace", { ok: false, status: "refused" }, "x"), /agent/);
  assert.match(refusalFor("replace", undefined, "x"), /agent/);
});

test("wordsFor: the plain wording of the preview line, the Send button and the activity summary", () => {
  const r = rep('Replace "Acme" with "Initech"');
  assert.deepEqual(wordsFor(r, 12), { text: 'replace "Acme" with "Initech" in 12 places', label: "Replace in 12 places", summary: 'Replaced "Acme" with "Initech" in 12 places. No AI was used.' });
  assert.equal(wordsFor(r, 1).label, "Replace in 1 place");
  assert.equal(wordsFor(r, 12, 2).summary, 'Replaced "Acme" with "Initech" in 10 places. No AI was used.', "protected places are not counted as replaced");
  assert.equal(wordsFor(rep('Replace Acme with ""'), 3).text, 'remove "Acme" in 3 places');
  assert.deepEqual(wordsFor(rep("bold every heading"), 9), { text: "make 9 headings bold", label: "Change 9 headings", summary: "Made 9 headings bold. No AI was used." });
  assert.equal(wordsFor(rep("underline the headings"), 1).text, "make 1 heading underlined");
  assert.equal(wordsFor(rep("remove the italics from all headings"), 4).text, "remove italic from 4 headings");
  assert.match(wordsFor(rep(`replace ${"x".repeat(50)} with y`), 2).text, /^replace "x{50}" with "y" in 2 places$/);
  assert.ok(wordsFor(rep(`replace "${"x".repeat(150)}" with y`), 2).text.includes("…"), "a long quoted span is cut for display");
});
