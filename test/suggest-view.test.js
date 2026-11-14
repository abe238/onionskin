// The page's side of quick fixes (web/src/suggest.js, suggestEligible in web/src/stamps.js): which taps ask the small model, the card an
// answer becomes, the "Check:" lines and the Now/Suggested split. Pure functions; nothing is written.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BUILT_IN, SELECT_ONE_SENTENCE, SUGGEST_TASKS, needsOneSentence, suggestEligible } from "../web/src/stamps.js";
import { NONE_WORDS, OFFER, WORDS, aheadKey, cardFor, cleanWord, offerDone, reusableAhead, splitDiff, stampHintOn, useRefusal, warningLines } from "../web/src/suggest.js";

const stamp = (id) => BUILT_IN.find((s) => s.id === id);
const SENT = "Please note that the report is due on Friday.";
// the page is told the tasks by the server (the bootstrap); these tests ask about the machinery for all three. The shipped list is tested below.
const ALL = ["shorter", "friendlier", "grammar"];
const base = (over = {}) => ({ tasks: ALL, stamp: stamp("shorter"), on: true, busy: false, format: "docx", kind: "text", anchor: { quote: SENT, location: { blockPath: [4], start: 0, end: SENT.length } }, ...over });

test("eligible: one sentence, a built-in task, suggestions on", () => {
  assert.deepEqual(suggestEligible(base()), { task: "shorter", wholeParagraph: false });
  assert.equal(suggestEligible(base({ stamp: stamp("friendlier") })).task, "friendlier");
  assert.equal(suggestEligible(base({ stamp: stamp("grammar") })).task, "grammar");
});

test("only Fix grammar asks the model first by default (the owner's decision); any list from the server is honored", () => {
  assert.deepEqual(SUGGEST_TASKS, ["grammar"]);
  const { tasks, ...plain } = base();
  assert.deepEqual(suggestEligible({ ...plain, stamp: stamp("grammar") }), { task: "grammar", wholeParagraph: false }, "no list from the server: the shipped default");
  assert.equal(suggestEligible({ ...plain, stamp: stamp("shorter") }), null, "Shorter goes to the agent by default");
  assert.equal(suggestEligible({ ...plain, stamp: stamp("friendlier") }), null, "Friendlier goes to the agent by default");
  assert.equal(suggestEligible(base({ tasks: ["grammar"], stamp: stamp("shorter") })), null, "the server's list wins: Shorter is not on it");
  assert.deepEqual(suggestEligible(base({ tasks: ["shorter"] })), { task: "shorter", wholeParagraph: false }, "a wider list is honored");
  assert.equal(suggestEligible(base({ tasks: "shorter" })), null, "a list that is not a list asks nothing");
});

test("not eligible: off, busy, translate, an own stamp, a spreadsheet, a caret, a table", () => {
  assert.equal(suggestEligible(base({ on: false })), null);
  assert.equal(suggestEligible(base({ busy: true })), null);
  assert.equal(suggestEligible(base({ stamp: stamp("translate") })), null);
  assert.equal(suggestEligible(base({ stamp: { label: "Formal", words: "Make this more formal." } })), null);
  assert.equal(suggestEligible(base({ format: "xlsx" })), null);
  assert.equal(suggestEligible(base({ kind: "element" })), null);
  const at = (blockPath) => base({ anchor: { quote: SENT, location: { blockPath } } });
  assert.equal(suggestEligible(at([4, 1, 0])), null, "a table cell");
  assert.equal(suggestEligible(at(null)), null);
  assert.equal(suggestEligible(base({ format: "pptx", anchor: { quote: SENT, location: { shapeId: "3", cell: { r: 0, c: 1 } } } })), null, "a slide table");
  assert.ok(suggestEligible(base({ format: "pptx", anchor: { quote: SENT, location: { shapeId: "3" } } })));
});

test("not eligible: the shape of the text", () => {
  const q = (quote, extra = {}) => suggestEligible(base({ anchor: { quote, location: { blockPath: [1] } }, ...extra }));
  assert.equal(q("Hi"), null, "under 3 characters");
  assert.ok(q("Yes."), "3 characters is enough");
  assert.equal(q("The report is due on Friday. Send it soon."), null, "two sentences");
  assert.equal(q("The report is due\non Friday."), null, "a line break");
  assert.equal(q("the report is due on Friday."), null, "starts with a lower-case letter");
  assert.equal(q("The report is due on Friday"), null, "no sentence end");
  assert.equal(q(` ${SENT}`), null, "edge space");
  assert.equal(q("The report is​ due on Friday."), null, "zero-width character");
  assert.equal(q("A".repeat(301)), null, "too long");
  assert.ok(q("2 reports are due on Friday."), "a digit starts a sentence");
  assert.ok(q('"The report is due on Friday."'), "a quote mark");
  assert.ok(q("Is the report due on Friday?"));
});

test("a whole Word paragraph needs no sentence end; a part of one does", () => {
  const quote = "Quarterly report summary";
  assert.equal(suggestEligible(base({ anchor: { quote, location: { blockPath: [1] } } })), null);
  assert.deepEqual(suggestEligible(base({ anchor: { quote, location: { blockPath: [1] } }, paraText: "Quarterly  report summary" })), { task: "shorter", wholeParagraph: true });
  assert.equal(suggestEligible(base({ anchor: { quote, location: { blockPath: [1] } }, paraText: "Quarterly report summary for the team" })), null);
});

test("a Word selection that is a sentence minus its end mark, closing quote or edge spaces is that sentence; anything else says so", () => {
  const para = `${SENT} Send it soon.`;
  const at = (quote, p = para, loc = {}) => ({ anchor: { quote, location: { blockPath: [2], ...loc } }, paraText: p });
  const asks = (a) => suggestEligible(base(a));
  assert.deepEqual(asks(at(SENT.slice(0, -1))), { task: "shorter", wholeParagraph: false }, "minus the period");
  assert.deepEqual(asks(at(SENT.slice(0, -1), para, { start: 0, end: SENT.length - 1 })), { task: "shorter", wholeParagraph: false }, "with the engine's offsets");
  assert.ok(asks(at(`${SENT} `)), "a trailing space");
  assert.ok(asks(at('"The report is due on Friday', '"The report is due on Friday." Then left.')), "minus the period and the closing quote");
  assert.ok(asks(at('"The report is due on Friday.', '"The report is due on Friday." Then left.')), "minus the closing quote");
  assert.deepEqual(asks(at("The report is due on Friday", "The report is due on Friday")), { task: "shorter", wholeParagraph: true }, "the whole paragraph, no end mark at all");
  assert.equal(asks(at("The report is due", `${SENT} Send it soon.`)), null, "half a sentence");
  assert.equal(asks(at("The report is due on Friday. Send it soon", para)), null, "two sentences");
  // the line the stamp row shows before the tap
  const note = (a) => needsOneSentence({ on: true, tasks: ALL, format: "docx", kind: "text", ...at(...a) });
  assert.equal(SELECT_ONE_SENTENCE, "Select one whole sentence to get a suggestion first.");
  assert.equal(note(["The report is due"]), true, "half a sentence");
  assert.equal(note(["The report is due on Friday. Send it soon"]), true, "two sentences");
  assert.equal(note([SENT.slice(0, -1)]), false, "a sentence minus its period is a sentence");
  assert.equal(note([SENT]), false);
  assert.equal(needsOneSentence({ on: true, tasks: ALL, format: "docx", kind: "element", ...at(SENT) }), true, "a caret with no selected words");
  assert.equal(needsOneSentence({ on: true, tasks: ALL, format: "docx", kind: "text", anchor: { quote: SENT, location: { blockPath: [4, 1, 0] } }, paraText: SENT }), false, "a table cell: selecting more would not help, so no line");
  assert.equal(needsOneSentence({ on: true, tasks: ALL, format: "pptx", kind: "text", anchor: { quote: SENT, location: { shapeId: "3", cell: { row: 0, col: 1 } } } }), false, "a slide table cell");
  assert.equal(needsOneSentence({ on: true, tasks: ALL, format: "pptx", kind: "text", anchor: { quote: SENT, location: { shapeId: "3", protected: true } } }), false, "a protected shape");
  assert.equal(suggestEligible(base({ format: "docx", kind: "text", anchor: { quote: SENT, location: { blockPath: [4, 1, 0] } }, paraText: SENT })), null, "and a tap there still goes to the agent");
  assert.equal(needsOneSentence({ on: false, tasks: ALL, format: "docx", kind: "text", ...at("The report is due") }), false, "suggestions off: the old line");
  assert.equal(needsOneSentence({ on: true, tasks: [], format: "docx", kind: "text", ...at("The report is due") }), false, "no stamp on the list");
  assert.equal(needsOneSentence({ on: true, tasks: ALL, format: "xlsx", kind: "text", ...at("The report is due") }), false, "a spreadsheet has no suggestions to hint at");
  // a PowerPoint text box: the page has no paragraph text, so a sentence minus its end mark is left to the server to read
  const slide = { format: "pptx", kind: "text", anchor: { quote: "The report is due on Friday", location: { shapeId: "3" } } };
  assert.ok(suggestEligible(base(slide)), "asked: the server reads the text box");
  assert.equal(needsOneSentence({ on: true, tasks: ALL, ...slide }), false, "and no warning before it has");
  assert.equal(needsOneSentence({ on: true, tasks: ALL, ...slide, anchor: { quote: "The report. Is due", location: { shapeId: "3" } } }), true);
});

test("warningLines: fixed templates, two lines, a third says to read it all", () => {
  const w = (code, dropped = [], added = [], extra = {}) => ({ code, words: [...dropped, ...added], dropped, added, ...extra });
  assert.deepEqual(warningLines([w("negation", [], ["not"])]), ['Check: "not" was added.']);
  assert.deepEqual(warningLines([w("condition", ["unless"], [])]), ['Check: "unless" was taken out.']);
  assert.deepEqual(warningLines([w("modal", ["must"], ["should"])]), ['Check: "must" became "should".']);
  assert.deepEqual(warningLines([w("question", [], [], { now: "question" })]), ["Check: this now reads as a question."]);
  assert.deepEqual(warningLines([w("question", [], [], { now: "statement" })]), ["Check: this no longer reads as a question."]);
  assert.deepEqual(warningLines([w("number_moved", ["account"], ["March"])]), ["Check: a number is now next to different words."]);
  const three = [w("negation", [], ["not"]), w("modal", ["must"], []), w("action", [], ["pay"])];
  assert.deepEqual(warningLines(three), ['Check: "not" was added.', 'Check: "must" was taken out.', "Check the whole sentence carefully."]);
  assert.deepEqual(warningLines(three.slice(0, 2)).length, 2);
  assert.deepEqual(warningLines(null), []);
  assert.deepEqual(warningLines([{ code: "amount" }, 7, null]), [], "a warning with no words says nothing");
});

test("a word in a Check line is cut to 30 characters and stripped of control characters", () => {
  assert.equal(cleanWord("a\u0000b‮c​d"), "abcd");
  assert.equal(cleanWord("x".repeat(40)).length, 30);
  assert.deepEqual(warningLines([{ code: "action", dropped: [], added: ["pay\n<b>"] }]), ['Check: "pay<b>" was added.']);
});

test("splitDiff: Now keeps equal and removed words, Suggested keeps equal and added words, gaps go", () => {
  const ops = [["=", "The report is "], ["-", "really "], ["=", "due"], ["+", " soon"], ["…"]];
  const { now, suggested } = splitDiff(ops);
  assert.deepEqual(now, [{ t: "eq", text: "The report is " }, { t: "del", text: "really " }, { t: "eq", text: "due" }]);
  assert.deepEqual(suggested, [{ t: "eq", text: "The report is " }, { t: "eq", text: "due" }, { t: "ins", text: " soon" }]);
  assert.deepEqual(splitDiff(null), { now: [], suggested: [] });
});

test("cardFor: a shown answer, and every state with its sentence", () => {
  const shown = cardFor({ state: "shown", id: "q_1", before: "A b.", after: "A.", diff: [["=", "A"], ["-", " b"], ["=", "."]], warnings: [{ code: "negation", dropped: [], added: ["not"] }], untrusted: true }, "shorter");
  assert.equal(shown.kind, "shown");
  assert.equal(shown.id, "q_1");
  assert.deepEqual(shown.checks, ['Check: "not" was added.']);
  assert.ok(shown.now.some((n) => n.t === "del"));
  const none = (a, t = "shorter") => cardFor(a, t);
  assert.deepEqual(none({ state: "unchanged" }, "grammar"), { kind: "none", text: NONE_WORDS.nothingToFix, retry: false });
  assert.equal(none({ state: "unchanged" }, "friendlier").text, "No friendlier version this time.");
  assert.equal(none({ state: "unchanged" }).text, "No shorter version this time.");
  assert.equal(none({ state: "withheld", why: "facts" }).text, "No suggestion this time: the writing helper changed a number, date or name.");
  assert.equal(none({ state: "withheld", why: "not_clean" }).text, "No suggestion this time: the writing helper did not give a clean rewrite of this sentence.");
  assert.equal(none({ state: "withheld", why: "not_shorter" }).text, "No shorter version this time.");
  assert.equal(none({ state: "withheld", why: "not_friendlier" }, "friendlier").text, "No friendlier version this time.");
  assert.equal(none({ state: "addresses_ai" }).text, "No suggestion for this sentence. It reads like instructions for an AI.");
  assert.equal(none({ state: "protected" }).text, "This part of the file is protected, so it cannot be changed here.");
  for (const [state, text] of [["timeout", "No suggestion this time. The writing helper took too long."], ["busy", "The writing helper is busy with another sentence. Try again in a moment."], ["warming", "The writing helper is still starting. Try again in a moment, or ask the agent."]]) {
    assert.deepEqual(none({ state }), { kind: "none", text, retry: true });
  }
  assert.equal(none({ state: "not_eligible", why: "working" }).text, NONE_WORDS.agentStarted);
  assert.deepEqual(none({ state: "not_eligible", why: "sentence" }), { kind: "send" });
  assert.deepEqual(none({ state: "off" }), { kind: "send" });
  assert.deepEqual(none(null), { kind: "send" });
  assert.equal(none({ state: "shown" }).kind, "none", "a shown answer with no text is not drawn");
});

test("a refusal from Apple's model and a change inside quotes each get their own line", () => {
  assert.deepEqual(cardFor({ state: "failed", why: "refused" }, "grammar"), { kind: "none", text: "No suggestion for this sentence.", retry: false });
  assert.deepEqual(cardFor({ state: "withheld", why: "quoted", line: "x" }, "grammar"), { kind: "none", text: "No suggestion here: the change is inside quoted text.", retry: false });
});

test("a Try again exists only for warm-up, busy, time-out and failure", () => {
  for (const state of ["unchanged", "withheld", "addresses_ai", "protected"]) assert.equal(cardFor({ state, why: "facts" }, "shorter").retry, false, state);
  for (const state of ["warming", "busy", "timeout", "failed"]) assert.equal(cardFor({ state }, "shorter").retry, true, state);
});

test("useRefusal: the server's sentence for a refused Use", () => {
  assert.equal(useRefusal({ code: "expired", message: "x" }), "This suggestion is out of date. Tap the stamp again.");
  assert.equal(useRefusal({ code: "busy" }), NONE_WORDS.agentStarted);
  assert.equal(useRefusal({ code: "not_here", message: "This could not be changed on this Mac, so nothing was written. Press Send to ask the agent." }), "This could not be changed on this Mac, so nothing was written. Press Send to ask the agent.");
});

test("the wording is the design's, with no em dash", () => {
  const all = JSON.stringify([WORDS, NONE_WORDS, OFFER]);
  assert.ok(!all.includes("—"));
  assert.equal(WORDS.sub, "Made on this Mac by Apple's writing model. Nothing changes until you tap Use this.");
  assert.equal(WORDS.warming, "Getting the writing helper ready.");
  assert.equal(OFFER.line, "Get quick fixes for one sentence, made by Apple's writing model on this Mac. Nothing you write leaves it.");
  assert.equal(OFFER.turnOn, "Turn on");
  assert.ok(!/granite|download|GB|Python|internet|confirm/i.test(JSON.stringify([OFFER, WORDS, NONE_WORDS])), "no download, size, Python or Granite anywhere on the page");
});

test("the hint and the offer's last line name only the stamps that show a suggestion first", () => {
  // the shipped build (no list): Fix grammar only
  assert.equal(stampHintOn(undefined), "Fix grammar shows a suggestion first on one sentence. Other taps go to the agent with your other changes.");
  assert.equal(offerDone(undefined), "Quick fixes are on. Select one sentence and tap Fix grammar.");
  // a wider list names all it holds
  assert.equal(stampHintOn(ALL), "Shorter, Friendlier and Fix grammar show a suggestion first on one sentence. Other taps go to the agent with your other changes.");
  assert.equal(offerDone(ALL), "Quick fixes are on. Select one sentence and tap Shorter, Friendlier or Fix grammar.");
  // a shorter list from the server: the words name only what is on it, so they never promise a card a stamp will not show
  assert.equal(stampHintOn(["grammar"]), "Fix grammar shows a suggestion first on one sentence. Other taps go to the agent with your other changes.");
  assert.equal(offerDone(["grammar"]), "Quick fixes are on. Select one sentence and tap Fix grammar.");
  assert.equal(stampHintOn(["grammar", "shorter"]), "Shorter and Fix grammar show a suggestion first on one sentence. Other taps go to the agent with your other changes.");
  assert.equal(offerDone(["friendlier", "grammar"]), "Quick fixes are on. Select one sentence and tap Friendlier or Fix grammar.");
  // nothing on the list (or junk, or a stamp that never asks the model): no promise at all
  for (const t of [[], ["translate"], "grammar", [null]]) {
    assert.equal(stampHintOn(t), "Tap a stamp to send it with your other changes.");
    assert.equal(offerDone(t), "Quick fixes are on.");
  }
});

// A PowerPoint selection the page could not judge ("maybe") is never sent silently: when the server says it is not one sentence, the card says so.
test("a maybe selection the server refuses shows the one-sentence line; a sure one still goes to the agent as before", () => {
  assert.deepEqual(cardFor({ state: "not_eligible", why: "sentence" }, "shorter", true), { kind: "none", text: SELECT_ONE_SENTENCE, retry: false });
  assert.deepEqual(cardFor({ state: "not_eligible", why: "sentence" }, "shorter"), { kind: "send" });
  assert.equal(cardFor({ state: "not_eligible", why: "working" }, "shorter", true).text, NONE_WORDS.agentStarted);
  assert.deepEqual(cardFor({ state: "off" }, "shorter", true), { kind: "send" });
});

test("the head start: a held answer is for the exact task, selection and file version, and only a definite answer is used at the tap", () => {
  const req = { task: "grammar", wholeParagraph: true, anchor: { quote: SENT, prefix: "", suffix: "", location: { blockPath: [4], start: 0, end: SENT.length } } };
  const k = aheadKey(req, "sha1");
  assert.equal(aheadKey({ ...req, anchor: { ...req.anchor } }, "sha1"), k, "the same selection read again");
  assert.notEqual(aheadKey(req, "sha2"), k, "another file version");
  assert.notEqual(aheadKey({ ...req, task: "shorter" }, "sha1"), k, "another stamp");
  assert.notEqual(aheadKey({ ...req, anchor: { ...req.anchor, quote: "Please note that the report is due on Monday." } }, "sha1"), k, "other words");
  assert.notEqual(aheadKey({ ...req, anchor: { ...req.anchor, location: { blockPath: [5], start: 0, end: SENT.length } } }, "sha1"), k, "the same words in another paragraph");
  assert.notEqual(aheadKey({ ...req, anchor: { ...req.anchor, suffix: " More." } }, "sha1"), k, "other words around it");
  assert.notEqual(aheadKey({ ...req, wholeParagraph: false }, "sha1"), k, "not the whole paragraph");
  for (const a of [{ state: "shown", id: "q_1" }, { state: "unchanged" }, { state: "withheld", why: "facts" }, { state: "addresses_ai" }, { state: "protected" }, { state: "failed", why: "refused" }]) assert.ok(reusableAhead(a), a.state);
  for (const a of [{ state: "busy" }, { state: "warming" }, { state: "timeout" }, { state: "failed" }, { state: "off" }, { state: "not_eligible", why: "working" }, null, undefined]) assert.ok(!reusableAhead(a), String(a?.state));
});
