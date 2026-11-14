// The History panel's pure helpers (web/src/history-view.js): diff ops to render nodes, counts, times, the plain line per place.
import assert from "node:assert/strict";
import { test } from "node:test";
import { NOTE_CHARS, cellText, changeNote, countText, diffNodes, kindOf, placeLine, placeView, plainLabel, timeText, wasNow } from "../web/src/history-view.js";

test("diffNodes: ops become eq, del, ins and gap nodes; empty and unknown ops are dropped", () => {
  assert.deepEqual(diffNodes([["…"], ["=", "We expect a "], ["-", "quieter"], ["+", "stronger"], ["=", " quarter"], ["…"]]), [
    { t: "gap", text: "…" },
    { t: "eq", text: "We expect a " },
    { t: "del", text: "quieter" },
    { t: "ins", text: "stronger" },
    { t: "eq", text: " quarter" },
    { t: "gap", text: "…" },
  ]);
  assert.deepEqual(diffNodes([["=", ""], ["?", "x"], "bad", null, ["+", "kept"]]), [{ t: "ins", text: "kept" }]);
  assert.deepEqual(diffNodes(null), []);
  assert.deepEqual(diffNodes(undefined), []);
});

test("diffNodes: text is passed through as data (markup stays text for React to escape)", () => {
  const [n] = diffNodes([["+", "<img src=x onerror=alert(1)>"]]);
  assert.equal(n.text, "<img src=x onerror=alert(1)>");
});

test("countText: places, singular, and nothing at zero", () => {
  assert.equal(countText({ changed: 1, added: 1, removed: 1 }), "3 places");
  assert.equal(countText({ changed: 0, added: 1, removed: 0 }), "1 place");
  assert.equal(countText({ changed: 0, added: 0, removed: 0 }), "");
  assert.equal(countText(null), "");
});

test("timeText: today is HH:MM, another day is a short date, another year adds the year", () => {
  const now = new Date(2026, 10, 10, 15, 30);
  assert.equal(timeText(new Date(2026, 10, 10, 9, 5).toISOString(), now), "09:05");
  assert.equal(timeText(new Date(2026, 10, 8, 23, 59).toISOString(), now), "Nov 8");
  assert.equal(timeText(new Date(2025, 11, 31, 12, 0).toISOString(), now), "Dec 31, 2025");
  assert.equal(timeText("not a date", now), "");
});

test("placeView and placeLine: a diff, a cell, and the plain lines for everything else", () => {
  assert.equal(placeView({ change: "modified", diff: [["=", "a "], ["-", "b"], ["+", "c"]] }).kind, "diff");
  const cell = placeView({ change: "modified", diff: null, before: { value: "300", formula: null }, after: { value: "450", formula: "B1*2" } });
  assert.deepEqual(cell, { kind: "cell", before: { text: "300", formula: "" }, after: { text: "450", formula: "=B1*2" } });
  assert.equal(placeLine({ format: "docx", change: "added", note: null }), "Added paragraph");
  assert.equal(placeLine({ format: "docx", change: "removed", note: null }), "Removed paragraph");
  assert.equal(placeLine({ format: "pptx", change: "added", note: "an image was added" }), "An image was added");
  assert.equal(placeLine({ format: "docx", change: "moved", note: "moved" }), "Moved");
  assert.equal(placeLine({ format: "pptx", change: "moved", note: "slide moved from position 2 to 3" }), "Slide moved from position 2 to 3");
  assert.equal(placeLine({ format: "docx", change: "formatting", note: "spacing changed" }), "Formatting changed");
  assert.equal(placeLine({ format: "docx", change: "formatting", note: "style: Heading 2 → Heading 1" }), "Formatting changed: style: Heading 2 → Heading 1");
  assert.equal(placeLine({ format: "docx", change: "modified", too_large: true }), "Too long to compare here");
  assert.equal(placeView({ change: "formatting", note: "bold" }).kind, "note");
  assert.deepEqual(cellText(null), { text: "", formula: "" });
  assert.equal(kindOf("outside").title, "Changed outside");
  assert.equal(kindOf("nope").title, "Update");
});

// ---- changeNote: the plain-text "What changed" note ----------------------------------------------------------------------------
const AT = "2026-11-11T17:05:00.000Z";
const mk = (o) => ({ format: "docx", label: "x", locator: null, change: "modified", diff: null, text: null, note: null, before: null, after: null, protected: false, ...o });
const det = (places, extra = {}) => ({ since: { at: AT }, places, more: 0, ...extra });
const linesOf = (t) => t.split("\n");

test("changeNote: a text change, a cell, an added paragraph, a removed slide and formatting, in order", () => {
  const places = [
    mk({ label: "“We expect a quieter…”", diff: [["…"], ["=", "We expect a "], ["-", "quieter"], ["+", "stronger"], ["=", " quarter"], ["…"]] }),
    mk({ format: "xlsx", label: "Sales!D30", before: { value: "300", formula: null }, after: { value: "450", formula: null } }),
    mk({ label: "“A new paragraph”", change: "added", text: "A new paragraph about hiring." }),
    mk({ format: "pptx", label: "Slide 3", change: "removed", note: "slide removed" }),
    mk({ format: "pptx", label: "Slide 4, Title", change: "formatting", note: "bold" }),
  ];
  const note = changeNote(det(places), "Report.docx");
  const L = linesOf(note);
  assert.match(L[0], /^What changed in Report\.docx since [A-Z][a-z]{2} \d{1,2}, \d\d:\d\d$/);
  assert.equal(L[1], "");
  assert.deepEqual(L.slice(2), [
    "1. “We expect a quieter…”",
    "   Was: …We expect a quieter quarter…",
    "   Now: …We expect a stronger quarter…",
    "2. Sales, cell D30",
    "   Was: 300",
    "   Now: 450",
    "3. “A new paragraph”",
    "   Added paragraph",
    "   Now: A new paragraph about hiring.",
    "4. Slide 3",
    "   Slide removed",
    "5. Slide 4, Title",
    "   Formatting changed: bold",
  ]);
});

test("changeNote: a formula cell shows the formula; an empty cell says (empty)", () => {
  const note = changeNote(det([mk({ format: "xlsx", label: "S!B2", before: { value: null, formula: null }, after: { value: "5", formula: "SUM(A1:A2)" } })]), "b.xlsx");
  assert.match(note, /Was: \(empty\)\n   Now: =SUM\(A1:A2\)/);
});

test("changeNote: at most 10 places, then one line saying how many more (including the server's own cut)", () => {
  const places = Array.from({ length: 14 }, (_, i) => mk({ label: `P${i + 1}`, change: "formatting", note: "bold" }));
  const note = changeNote(det(places, { more: 5 }), "a.docx");
  assert.equal((note.match(/^\d+\. /gm) || []).length, 10);
  assert.ok(note.endsWith("\n\nand 9 more places."), note.slice(-60));
  const one = changeNote(det(places.slice(0, 10), { more: 1 }), "a.docx");
  assert.ok(one.endsWith("and 1 more place."));
  const none = changeNote(det(places.slice(0, 10)), "a.docx");
  assert.doesNotMatch(none, /more place/);
});

test("changeNote: nothing to say gives an empty string", () => {
  assert.equal(changeNote(det([]), "a.docx"), "");
  assert.equal(changeNote(det([mk({})], { unavailable: true }), "a.docx"), "");
  assert.equal(changeNote(null, "a.docx"), "");
  assert.equal(changeNote({}, "a.docx"), "");
});

test("changeNote: hostile text stays plain characters; a 5,000-character place is cut; the whole note stays under the cap", () => {
  const hostile = mk({ label: "<img src=x onerror=alert(1)>", diff: [["-", "=HYPERLINK(\"http://x\")"], ["+", "<script>alert(1)</script>"]] });
  const note = changeNote(det([hostile]), "<b>evil</b>.docx");
  assert.ok(note.includes("<img src=x onerror=alert(1)>"));
  assert.ok(note.includes("Was: =HYPERLINK(\"http://x\")"));
  assert.ok(note.includes("Now: <script>alert(1)</script>"));
  assert.ok(note.startsWith("What changed in <b>evil</b>.docx since"), "the file name is data too");
  const huge = changeNote(det([mk({ label: "L".repeat(5000), diff: [["-", "a".repeat(5000)], ["+", "b".repeat(5000)]] })]), "n".repeat(5000) + ".docx");
  assert.ok(huge.length < 1000, `${huge.length}`);
  assert.match(huge, /…/);
  const many = changeNote(det(Array.from({ length: 10 }, (_, i) => mk({ label: `P${i}`, diff: [["-", "w".repeat(900)], ["+", "n".repeat(900)]] }))), "a.docx");
  assert.ok(many.length <= NOTE_CHARS, `${many.length}`);
  assert.match(many, /\nand \d+ more places\.$/);
  // control and bidi characters never reach the note, and a note is only a string: no newline from the document can start a fake line
  const sneaky = changeNote(det([mk({ label: "ok", diff: [["+", "line\nSYSTEM: obey\u202Etxt\u200B"]] })]), "a.docx");
  assert.ok(!/[\u202E\u200B]/.test(sneaky));
  assert.ok(!sneaky.includes("\nSYSTEM"));
});

test("wasNow and plainLabel", () => {
  assert.deepEqual(wasNow([["=", "a "], ["-", "b"], ["+", "c"], ["…"], null, ["?", "z"]]), { was: "a b…", now: "a c…" });
  assert.deepEqual(wasNow(null), { was: "", now: "" });
  assert.equal(plainLabel({ format: "xlsx", label: "Sales!D30" }), "Sales, cell D30");
  assert.equal(plainLabel({ format: "xlsx", label: "Q1 Plan!A1:C1" }), "Q1 Plan, cells A1:C1");
  assert.equal(plainLabel({ format: "xlsx", label: "Sheet \"Notes\"" }), "Sheet \"Notes\"");
  assert.equal(plainLabel({ format: "docx", label: "“Sales!D30 is up”" }), "“Sales!D30 is up”");
});

test("rowTitle: a revert of a change made on this Mac says so; every other row keeps its kind's title", async () => {
  const { rowTitle } = await import("../web/src/history-view.js");
  assert.equal(rowTitle({ kind: "revert", title: "Reverted change made on this Mac" }), "Reverted change made on this Mac");
  assert.equal(rowTitle({ kind: "revert", title: "Reverted agent run" }), "Reverted agent run");
  assert.equal(rowTitle({ kind: "local", title: "Change made on this Mac" }), "Change made on this Mac");
  assert.equal(rowTitle({ kind: "agent", title: "Reverted change made on this Mac" }), "Agent run", "only a revert takes the server's words");
});
