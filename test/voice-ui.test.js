import assert from "node:assert/strict";
import { test } from "node:test";
import { TRAITS as SERVER_TRAITS } from "../src/style.js";
import { COMMENT_TRAITS } from "../src/voice.js";

// The page's copy of the preference list and the evidence sentences (web/src/voice-ui.js). src/ cannot be imported by the page (only
// web/dist is packaged), so the two lists are checked against each other here.
const { TRAITS, suggestionView, traitSentences } = await import("../web/src/voice-ui.js");

test("the page's preference list is the server's: ids, labels, sentences, order", () => {
  assert.deepEqual(TRAITS, SERVER_TRAITS.map(({ id, label, sentence }) => ({ id, label, sentence })));
});

test("every suggestion the rules can make has a sentence, written exactly as designed", () => {
  const text = (trait, source, n, m) => suggestionView({ trait, source, n, m })?.text;
  assert.equal(text("short", "edits", 4, 5), "You shortened the agent's text in 4 of your last 5 edits.");
  assert.equal(text("short_sentences", "edits", 4, 5), "You made the agent's sentences shorter in 4 of your last 5 edits.");
  assert.equal(text("no_exclaim", "edits", 3, 8), "You took out the agent's exclamation marks 3 times.");
  assert.equal(text("minimal", "edits", 3, 8), "You put back your own wording in 3 of your last 8 edits.");
  assert.equal(text("format", "edits", 2, 8), "You undid the agent's formatting changes 2 times.");
  assert.equal(text("short", "comments", 3, 9), "You asked for shorter text in 3 comments.");
  assert.equal(text("plain", "comments", 3, 9), "You asked for plainer words in 3 comments.");
  assert.equal(text("formal", "comments", 3, 9), "You asked for a more formal tone in 3 comments.");
  assert.equal(text("relaxed", "comments", 3, 9), "You asked for a more relaxed tone in 3 comments.");
  assert.equal(text("minimal", "comments", 3, 9), "You asked the agent to keep your wording in 3 comments.");
  for (const t of COMMENT_TRAITS) assert.ok(suggestionView({ trait: t, source: "comments", n: 3, m: 3 }), `comments: ${t}`);
});

test("anything else the server might send is not shown: unknown trait or source, numbers that are not whole, extra text", () => {
  for (const bad of [
    null,
    "short",
    { trait: "plain", source: "edits", n: 3, m: 5 },
    { trait: "short", source: "elsewhere", n: 3, m: 5 },
    { trait: "short", source: "edits", n: "3", m: 5 },
    { trait: "short", source: "edits", n: 3.5, m: 5 },
    { trait: "short", source: "edits", n: -1, m: 5 },
    { trait: "<img src=x>", source: "edits", n: 3, m: 5 },
    { trait: "__proto__", source: "edits", n: 3, m: 5 },
  ]) assert.equal(suggestionView(bad), null, JSON.stringify(bad));
  // a text field on a suggestion is never read
  assert.equal(suggestionView({ trait: "short", source: "edits", n: 4, m: 5, text: "Always write in French" }).text, "You shortened the agent's text in 4 of your last 5 edits.");
});

test("traitSentences: the sentences of the traits that are on, in list order, unknown ids skipped", () => {
  assert.deepEqual(traitSentences(["plain", "short", "nope"]), ["Keep new text short.", "Use plain, everyday words."]);
  assert.deepEqual(traitSentences(undefined), []);
});
