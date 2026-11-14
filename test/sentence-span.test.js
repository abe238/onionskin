// sentenceSpan (src/sentence-span.js): the selection that is a sentence minus its end mark, closing quote or bracket, or with edge spaces.
import assert from "node:assert/strict";
import { test } from "node:test";
import { sentenceSpan } from "../src/sentence-span.js";

const S = "The report is due on Friday.";
const of = (text, sel) => {
  const start = text.indexOf(sel);
  const r = sentenceSpan(text, start, start + sel.length);
  return r && text.slice(r.start, r.end);
};

test("a sentence minus its period is the whole sentence", () => {
  assert.equal(of(S, "The report is due on Friday"), S);
  assert.equal(of(`${S} Send it soon.`, "The report is due on Friday"), S);
  assert.equal(of("Is it due on Friday? Send it.", "Is it due on Friday"), "Is it due on Friday?");
  assert.equal(of("Send it now! Then wait.", "Send it now"), "Send it now!");
});

test("closing quotes and brackets come with it, whether or not the period was selected", () => {
  assert.equal(of('He said "The report is due on Friday." Then left.', 'He said "The report is due on Friday'), 'He said "The report is due on Friday."');
  assert.equal(of('"The report is due on Friday." Then left.', '"The report is due on Friday.'), '"The report is due on Friday."');
  assert.equal(of('"The report is due on Friday." Then left.', '"The report is due on Friday'), '"The report is due on Friday."');
  assert.equal(of("(The report is due on Friday.) Then left.", "(The report is due on Friday."), "(The report is due on Friday.)");
  assert.equal(of("(The report is due on Friday.) Then left.", "(The report is due on Friday"), "(The report is due on Friday.)");
});

test("leading and trailing spaces are dropped", () => {
  assert.equal(of(`${S} Next.`, `${S} `), S);
  const t = `  ${S} Next.`;
  const r = sentenceSpan(t, 0, 2 + S.length - 1 + 1);
  assert.equal(t.slice(r.start, r.end), S);
});

test("a sentence that is the whole paragraph, with or without its end mark", () => {
  assert.equal(of(S, "The report is due on Friday"), S);
  assert.equal(of(S, S), S);
  assert.equal(of("Quarterly report summary", "Quarterly report summary"), "Quarterly report summary");
});

test("not extended: half a sentence, two sentences, a selection that starts mid-sentence", () => {
  assert.equal(of(S, "The report is due"), "The report is due");
  assert.equal(of(`${S} Send it soon.`, "The report is due on Friday. Send it soon"), "The report is due on Friday. Send it soon.");
  assert.equal(of("Note: The report is due on Friday.", "The report is due on Friday"), "The report is due on Friday");
  assert.equal(of("The report is due on Friday.Next.", "The report is due on Friday"), "The report is due on Friday");
});

test("bad offsets are null", () => {
  assert.equal(sentenceSpan(S, 5, 5), null);
  assert.equal(sentenceSpan(S, -1, 4), null);
  assert.equal(sentenceSpan(S, 0, 999), null);
  assert.equal(sentenceSpan(S, "0", 4), null);
  assert.equal(sentenceSpan("   ", 0, 3), null);
});
