// "Changes shown in place" (web/src/writein.js): the gate that decides when it is safe to draw the agent's changed words in place,
// the search strings built from History's diff ops, and the exactly-once placement in a paragraph's text. Diff ops come from the real
// src/diff.js over text sanitized as the server does, so the shapes are the ones the page will get.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { diffText } from "../src/diff.js";
import { untrusted } from "../src/sanitize.js";
import { textHash } from "../src/text.js";
import { WRITEIN, findOnce, gateOpen, locateChanges, needlesFor, planWriteIn, survivesSanitizer, sha256hex, wasText } from "../web/src/writein.js";

const GATES = { format: "docx", newest: { kind: "agent", reverted: false, revertRecommended: false, flags: [] }, readOnly: false, merged: false, dirtyAtStart: false, exact: true, visible: true, reducedMotion: false, edited: false, sending: false, runAtStart: "r_1", runNow: "r_1", docUpAt: 1000, detailAt: 1200 };
const clean = (s) => untrusted(String(s).replace(/￼/g, "[object]"), 20000);
const placeFor = (a, b, extra = {}) => ({ format: "docx", label: "p", locator: { format: "docx", body_path: [3], text_start: clean(b).slice(0, 160), text_hash: textHash(b) }, change: "modified", diff: diffText(clean(a), clean(b)).ops, ...extra });
const detailOf = (places, extra = {}) => ({ id: "u1", kind: "agent", format: "docx", untrusted: true, places, more: 0, after_is_current: true, ...extra });
/** locateChanges on a page paragraph whose text is the server's own after text (the hash the locator carries is of that text). */
const locate = (para, ch, server = para) => locateChanges(para, ch, textHash(server));
/** The new words each change of a place covers, as located in the new paragraph text. */
function located(a, b, para = b) {
  const ch = needlesFor(placeFor(a, b));
  if (!ch) return null;
  const r = locate(para, ch, b);
  return r && r.map((x) => ({ text: para.slice(x.start, x.end), at: x.start, was: x.was }));
}

test("a replaced word: the needle carries context and the range is the new word", () => {
  const a = "We expect a quieter quarter for the whole team this year.";
  const b = "We expect a stronger quarter for the whole team this year.";
  const [c] = needlesFor(placeFor(a, b));
  assert.equal(c.needle.slice(c.insStart, c.insEnd), "stronger");
  assert.equal(c.was, "quieter");
  assert.ok(c.needle.startsWith("We expect a ") && c.needle.includes(" quarter"));
  assert.deepEqual(located(a, b), [{ text: "stronger", at: b.indexOf("stronger"), was: "quieter" }]);
});

test("an added phrase and a pure deletion", () => {
  const a = "The plan ships in May with the new design.";
  const b = "The plan ships early in May with the new design.";
  assert.deepEqual(located(a, b), [{ text: "early", at: b.indexOf("early"), was: "" }]);
  const del = located(b, a); // the other way round: "early " removed
  assert.equal(del.length, 1);
  assert.equal(del[0].text, "");
  assert.equal(del[0].was, "early");
  assert.equal(a.slice(0, del[0].at), "The plan ships "); // where the words went
});

test("changes at the start and at the end of a paragraph, and two changes with text between them", () => {
  assert.deepEqual(located("Hello there, friend.", "Goodbye there, friend.").map((x) => x.text), ["Goodbye"]);
  assert.deepEqual(located("Hello there, friend.", "Hello there, partner.").map((x) => x.text), ["partner"]);
  const a = "One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen.";
  const b = "One TWO three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen SEVENTEEN eighteen.";
  const ops = placeFor(a, b).diff;
  assert.ok(ops.some((o) => o[0] === "…"), "the real diff puts a gap between the two changes");
  assert.deepEqual(located(a, b).map((x) => x.text), ["TWO", "SEVENTEEN"]);
});

test("the paragraph as rendered has extra spaces and a line break: offsets are raw", () => {
  const a = "We expect a quieter quarter.";
  const b = "We expect a stronger quarter.";
  const para = "We  expect a\nstronger   quarter.";
  const [r] = located(a, b, para);
  assert.equal(r.text, "stronger");
  assert.equal(r.at, para.indexOf("stronger"));
});

test("CJK text is placed too", () => {
  const a = "今天的会议很重要，请准时参加。";
  const b = "今天的会议非常重要，请准时参加。";
  assert.deepEqual(located(a, b), [{ text: "非常", at: b.indexOf("非常"), was: "很" }]);
});

test("deleting the first or the last words of a paragraph marks the edge where they went", () => {
  assert.deepEqual(located("Hello there friend.", "there friend."), [{ text: "", at: 0, was: "Hello" }]);
  const b = "We will meet on Monday";
  assert.deepEqual(located("We will meet on Monday at noon", b), [{ text: "", at: b.length, was: "at noon" }]);
});

test("a change of spacing only does not qualify (no empty chip)", () => {
  assert.equal(needlesFor({ change: "modified", diff: [["=", "See foo."], ["+", " "], ["=", "bar."]] }), null);
  assert.equal(needlesFor({ change: "modified", diff: [["=", "See"], ["-", " "], ["=", "foo."]] }), null);
});

test("hostile: a hidden mark inside the changed words cannot send the change to an unchanged twin", () => {
  const run = (w) => `one two three four five six ${w} seven eight nine ten eleven twelve`;
  const a = `Start ${run("old")}. Then ${run("new")}.`;
  const b = `Start ${run("new")}. Then ${run("new")}.`; // the agent changed the first one; the second already read "new"
  const ch = needlesFor(placeFor(a, b));
  assert.ok(ch, "the server-side diff is fine");
  assert.equal(locate(b, ch), null, "the needle is there twice: nothing is drawn");
  // the rendered paragraph hides a direction mark inside the changed words: in raw text only the unchanged twin would match
  const para = b.replace("new", "ne\u200Ew");
  assert.equal(findOnce(para, ch[0].needle)?.start, para.lastIndexOf(run("new")), "raw matching alone would pick the twin");
  assert.equal(locate(para, ch), null);
  for (const odd of ["a\u200Bb", "a\u00A0b", "e\u0301", "pic \uFFFC here", "a\u000Bb", "a\u202Eb"]) assert.equal(survivesSanitizer(odd), false, JSON.stringify(odd));
  assert.equal(survivesSanitizer("Plain words, \n and\ta line break."), true);
});

test("survivesSanitizer: whenever it accepts a paragraph, its collapsed text is what the real sanitizer gives", () => {
  const pieces = ["a", "B", "é", "e\u0301", " ", "  ", "\n", "\t", "\r\n", "\u00A0", "\u200E", "\u2028", "\uFFFC", "今", "😀", ".", "\u000C", "\u0085"];
  let seed = 7;
  const rnd = (n) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n);
  for (let i = 0; i < 3000; i++) {
    let raw = "";
    for (let k = rnd(12); k >= 0; k--) raw += pieces[rnd(pieces.length)];
    if (survivesSanitizer(raw)) assert.equal(raw.replace(/\s+/g, " ").trim(), untrusted(raw, 100000), JSON.stringify(raw));
  }
});

test("findOnce: missing, twice (also overlapping), empty and not a string are all null", () => {
  const f = findOnce("a  b c", "b c");
  assert.deepEqual([f.start, f.end, f.at(1)], [3, 6, 4]);
  assert.equal(findOnce("a b c", "d"), null);
  assert.equal(findOnce("go go", "go"), null);
  assert.equal(findOnce("aaa", "aa"), null); // overlapping occurrences count
  assert.equal(findOnce("abc", ""), null);
  assert.equal(findOnce("abc", "   "), null);
  assert.equal(findOnce(null, "a"), null);
  assert.equal(findOnce("a.c", ".").start, 1); // plain text, never a pattern
  assert.equal(findOnce("abc", "."), null);
});

test("a needle found twice in the paragraph falls back for the whole place", () => {
  const a = "Call me later. Call me later.";
  const b = "Call me soon. Call me later.";
  const ch = needlesFor(placeFor(a, b));
  assert.ok(ch);
  // the rendered paragraph repeats the changed sentence: the needle is there twice
  assert.equal(locate("Call me soon. Call me later. Call me soon. Call me later.", ch), null);
  assert.equal(locate("Something else entirely.", ch), null); // missing
});

test("one change that cannot be placed sinks the whole place (all or nothing)", () => {
  const a = "One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen.";
  const b = "One TWO three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen SEVENTEEN eighteen.";
  const ch = needlesFor(placeFor(a, b));
  assert.equal(locate(b.replace("SEVENTEEN", "seventeen"), ch), null);
  assert.equal(locate(b, [ch[1], ch[0]]), null); // out of order
});

test("inline objects, too_large, truncated, formatting, added and removed places do not qualify", () => {
  assert.equal(needlesFor(placeFor("A picture ￼ here.", "A picture ￼ there.")), null);
  assert.equal(needlesFor(placeFor("A picture ￼ here.", "A picture here.")), null);
  assert.equal(needlesFor({ change: "modified", too_large: true, note: "too long to compare here" }), null);
  assert.equal(needlesFor({ ...placeFor("a b", "a c"), truncated: true }), null);
  assert.equal(needlesFor({ change: "formatting", note: "spacing or formatting changed", diff: null }), null);
  assert.equal(needlesFor({ change: "added", text: "new" }), null);
  assert.equal(needlesFor({ change: "removed", text: "old" }), null);
  assert.equal(needlesFor({ change: "modified", diff: [] }), null);
  assert.equal(needlesFor({ change: "modified", diff: [["+", 5]] }), null);
  assert.equal(needlesFor({ change: "modified", diff: "nope" }), null);
  assert.equal(needlesFor(null), null);
  assert.equal(needlesFor({ change: "modified", diff: [["-", "everything"]] }), null); // a deletion with no words around it
});

test("hostile old words come back as plain text, cut at 60", () => {
  const evil = "<img src=x onerror=alert(1)>";
  const [c] = needlesFor(placeFor(`Keep ${evil} this.`, "Keep this."));
  assert.equal(c.was, evil);
  assert.equal(typeof c.was, "string");
  const long = "x".repeat(5000);
  const [d] = needlesFor({ change: "modified", diff: [["=", "Start "], ["-", long], ["+", "short"], ["=", " end."]] });
  assert.equal([...d.was].length, WRITEIN.wasChars);
  assert.ok(d.was.endsWith("…"));
  assert.equal(wasText("😀".repeat(100)).length, 59 * 2 + 1); // never splits a character in two
});

test("planWriteIn: the gate is open on a clean refresh and lists the qualifying places", () => {
  const ok = placeFor("We expect a quieter quarter.", "We expect a stronger quarter.");
  const plan = planWriteIn(detailOf([{ change: "formatting", locator: ok.locator, diff: null }, ok]), GATES);
  assert.equal(plan.go, true);
  assert.deepEqual(plan.places.map((p) => p.index), [1]);
  assert.equal(plan.places[0].changes[0].was, "quieter");
});

test("planWriteIn: reduced motion still draws (the page shows the still version)", () => {
  const d = detailOf([placeFor("We expect a quieter quarter.", "We expect a stronger quarter.")]);
  assert.equal(planWriteIn(d, { ...GATES, reducedMotion: true }).go, true);
});

test("planWriteIn: every uncertain gate says do nothing", () => {
  const d = detailOf([placeFor("We expect a quieter quarter.", "We expect a stronger quarter.")]);
  const closed = {
    "not Word": { format: "xlsx" },
    "read-only tab": { readOnly: true },
    "a merge ran": { merged: true },
    "dirty at start": { dirtyAtStart: true },
    "view not exact": { exact: false },
    "nothing restored": { exact: undefined },
    "tab hidden": { visible: false },
    "reduced motion unknown": { reducedMotion: undefined },
    "typing since": { edited: true },
    "sent again": { sending: true },
    "run moved": { runNow: "r_2" },
    "no run id": { runAtStart: "", runNow: "" },
    "reverted newest": { newest: { kind: "agent", reverted: true } },
    "newest not agent": { newest: { kind: "revert", reverted: false } },
    "late detail": { detailAt: 1000 + WRITEIN.lateMs + 1 },
    "no timing": { docUpAt: undefined },
  };
  for (const [name, over] of Object.entries(closed)) assert.equal(planWriteIn(d, { ...GATES, ...over }).go, false, name);
  // each gate field left out closes it too
  for (const k of Object.keys(GATES)) {
    const g = { ...GATES };
    delete g[k];
    assert.equal(planWriteIn(d, g).go, false, `missing ${k}`);
  }
  assert.equal(planWriteIn(d, {}).go, false);
  assert.equal(planWriteIn(d, null).go, false);
  assert.equal(gateOpen(GATES).open, true);
});

test("planWriteIn: the detail itself must prove it is current and complete", () => {
  const p = placeFor("We expect a quieter quarter.", "We expect a stronger quarter.");
  assert.equal(planWriteIn(detailOf([p], { after_is_current: false }), GATES).go, false);
  assert.equal(planWriteIn(detailOf([p], { unavailable: true }), GATES).go, false);
  assert.equal(planWriteIn(detailOf([p], { kind: "revert" }), GATES).go, false);
  assert.equal(planWriteIn(detailOf([p], { format: "pptx" }), GATES).go, false);
  assert.equal(planWriteIn(detailOf([p], { more: 3 }), GATES).go, false);
  assert.equal(planWriteIn(detailOf(Array.from({ length: WRITEIN.maxPlaces + 1 }, () => p)), GATES).go, false); // 41 places
  assert.equal(planWriteIn(detailOf(Array.from({ length: WRITEIN.maxPlaces }, () => p)), GATES).go, true);
  assert.equal(planWriteIn(detailOf("nope"), GATES).go, false);
  assert.equal(planWriteIn(null, GATES).go, false);
  assert.equal(planWriteIn(detailOf([]), GATES).go, false); // nothing to draw
  // not a top-level body paragraph: table cells, missing opening words, odd locators
  for (const locator of [{ format: "docx", body_path: [2, 0, 1], text_start: "x" }, { format: "docx", body_path: [2] }, { format: "docx", body_path: ["2"], text_start: "x" }, null, { format: "xlsx" }])
    assert.equal(planWriteIn(detailOf([{ ...p, locator }]), GATES).go, false);
});

test("malformed input never throws", () => {
  const weird = [undefined, 1, "x", [], { places: [null, 1, { diff: [[]] }] }];
  for (const w of weird) {
    assert.doesNotThrow(() => planWriteIn(w, GATES));
    assert.doesNotThrow(() => planWriteIn(detailOf([w]), GATES));
    assert.doesNotThrow(() => locateChanges("text", w));
    assert.doesNotThrow(() => needlesFor(w));
  }
  assert.equal(locate("text", [{ needle: "text", insStart: "0", insEnd: 1 }]), null);
});

test("hostile: a run Onionskin recommends reverting, or one with a change from outside Onionskin, keeps the outline", () => {
  const d = detailOf([placeFor("We expect a quieter quarter.", "We expect a stronger quarter.")]);
  const agent = (over) => ({ ...GATES, newest: { ...GATES.newest, ...over } });
  // the entry src/session.js #recordMidRun writes when a withdrawn batch had already changed the file
  const withdrawn = { id: "r_9", kind: "agent", reverted: false, revertRecommended: true, changes: null, checks: null, flags: [{ code: "file_changed_outside_onionskin", severity: "warn" }] };
  assert.equal(planWriteIn(d, { ...GATES, newest: withdrawn }).go, false, "withdrawn run");
  assert.equal(gateOpen({ ...GATES, newest: withdrawn }).open, false);
  const closed = {
    "revert recommended": { revertRecommended: true },
    "revert recommendation unknown": { revertRecommended: undefined },
    "no flags list": { flags: undefined },
    "an error flag": { flags: [{ code: "docx_xml_invalid", severity: "error" }] },
    "changed outside onionskin (warn)": { flags: [{ code: "file_changed_outside_onionskin", severity: "warn" }] },
    "changed outside onionskin (info)": { flags: [{ code: "file_changed_outside_onionskin", severity: "info" }] },
    "outside change while the agent worked": { flags: [{ code: "outside_change", severity: "warn" }] },
    "checks skipped: no pre-agent version": { flags: [{ code: "no_pre_snapshot", severity: "warn" }] },
    "odd flag": { flags: [null] },
  };
  for (const [name, over] of Object.entries(closed)) assert.equal(planWriteIn(d, agent(over)).go, false, name);
  // a warning about one op that did not apply does not close it: what the agent did write was checked
  assert.equal(planWriteIn(d, agent({ flags: [{ code: "apply_not_applied", severity: "warn" }] })).go, true);
});

test("hostile: an older tracked deletion's letters on the page cannot send the change to an unchanged twin", () => {
  // the server's text leaves tracked deletions out (src/docx.js delDepth); the page draws them struck through, so their letters
  // are in the paragraph's text there. The locator's text_hash is of the server's after text.
  const intro = "This quarterly report summarizes the results of the regional teams across every office, including staffing, budget, open risks, and the plans we agreed for the coming months ahead.";
  const run = (w) => `one two three four five six ${w} seven eight nine ten eleven twelve`;
  const a = `${intro} Start ${run("old")}. Then ${run("new")}.`;
  const b = `${intro} Start ${run("new")}. Then ${run("new")}.`;
  const plan = planWriteIn(detailOf([placeFor(a, b)]), GATES);
  assert.equal(plan.go, true);
  const ch = plan.places[0].changes;
  const dom = b.replace("Start one two three", "Start one two thXree");
  assert.ok(survivesSanitizer(dom), "plain letters: the sanitizer alone cannot tell");
  assert.ok(findOnce(dom, ch[0].needle), "raw matching alone would pick the twin");
  assert.equal(plan.places[0].locator.text_hash, textHash(b));
  assert.equal(locateChanges(dom, ch, plan.places[0].locator.text_hash), null);
  assert.equal(locateChanges(dom, ch, textHash(b)), null);
  // no twin: a tracked deletion before the change shifts every offset after it
  const shown = `${intro} Revenue was flat in the north. We expect a stronger quarter for the whole team this year.`;
  const before = `${intro} Revenue was flat in the north. We expect a quieter quarter for the whole team this year.`;
  const ch2 = needlesFor(placeFor(before, shown));
  const dom2 = shown.replace("was flat", "was ZZZ flat");
  assert.equal(locateChanges(dom2, ch2, textHash(shown)), null);
  // the same paragraph without the deletion places, and the hash is required
  assert.deepEqual(locateChanges(shown, ch2, textHash(shown)).map((r) => shown.slice(r.start, r.end)), ["stronger"]);
  for (const h of [undefined, null, "", "zz", textHash(shown).toUpperCase(), textHash(shown).slice(0, 15), 5]) assert.equal(locateChanges(shown, ch2, h), null, String(h));
});

test("a paragraph past the server's diff cap keeps the outline (changes past the cap are not in the diff)", () => {
  let filler = "";
  for (let i = 0; i < 4000; i++) filler += `w${i} `;
  const a = `Alpha old beta gamma. ${filler}tail OLDEND end.`;
  const b = `Alpha new beta gamma. ${filler}tail NEWEND end.`;
  assert.ok(b.length > 20000);
  const p = placeFor(a, b);
  assert.ok(!p.diff.some((o) => o[0] === "-" && o[1].includes("OLDEND")), "the server's diff never sees the second change");
  const ch = needlesFor(p);
  assert.equal(ch === null || locate(b, ch) === null, true);
  // only the old text was over the cap: its cut mark is in a changed op
  assert.equal(needlesFor({ change: "modified", diff: [["=", "Keep these words "], ["-", "old …[truncated]"], ["+", "new"]] }), null);
  // just under the cap still places
  const c = `Alpha old beta. ${"x".repeat(19950)}`;
  const e = `Alpha new beta. ${"x".repeat(19950)}`;
  assert.deepEqual(located(c, e).map((x) => x.text), ["new"]);
});

test("sha256hex: matches node's SHA-256 for ASCII, accents, CJK, emoji, empty text and every padding length", () => {
  const cases = ["", "abc", "\u00E9 e\u0301", "今天的会议很重要", "😀 and 𝄞", "x".repeat(19999), ...Array.from({ length: 130 }, (_, i) => "a".repeat(i))];
  for (const s of cases) assert.equal(sha256hex(s), createHash("sha256").update(s).digest("hex"), JSON.stringify(s.slice(0, 20)));
  assert.equal(sha256hex("We expect a stronger quarter.").slice(0, 16), textHash("We expect a stronger quarter."));
});

test("needlesFor on a sparse ops list does not throw", () => {
  assert.doesNotThrow(() => needlesFor({ change: "modified", diff: new Array(1) }));
  assert.equal(needlesFor({ change: "modified", diff: new Array(1) }), null);
  assert.equal(needlesFor({ change: "modified", diff: [["=", "a "], , ["+", "b"]] }), null); // a hole between ops
});

test("real History places: a Word paragraph changed by the agent places, and the same paragraph with a tracked deletion keeps the outline", async () => {
  const { compareBytes } = await import("../src/history.js");
  const { docxBytes } = await import("./helpers/zipbuild.js");
  const intro = "Our team met every week this autumn and agreed on the plan below for everyone.";
  const a = `${intro} We expect a quieter quarter for the whole team this year.`;
  const b = `${intro} We expect a stronger quarter for the whole team this year.`;
  const r = compareBytes("docx", docxBytes(["Title", a]), docxBytes(["Title", b]), { places: true });
  const plan = planWriteIn(detailOf(r.places), GATES);
  assert.equal(plan.go, true, JSON.stringify(r.places));
  const [p] = plan.places;
  assert.equal(p.locator.text_hash, textHash(b), "the locator carries the hash of the after paragraph");
  assert.deepEqual(locateChanges(b, p.changes, p.locator.text_hash).map((x) => b.slice(x.start, x.end)), ["stronger"]);
  // the after file also holds an older tracked deletion in that paragraph, far from the change: the server's text leaves it out, the
  // page shows its letters, so every page offset after it is one word off the engine's "text as shown"
  const del = `<w:p><w:r><w:t xml:space="preserve">Our team met </w:t></w:r><w:del w:id="1" w:author="x"><w:r><w:delText>almost </w:delText></w:r></w:del><w:r><w:t xml:space="preserve">${b.slice("Our team met ".length)}</w:t></w:r></w:p>`;
  const r2 = compareBytes("docx", docxBytes(["Title", a]), docxBytes([], {}, `<w:p><w:r><w:t>Title</w:t></w:r></w:p>${del}`), { places: true });
  const plan2 = planWriteIn(detailOf(r2.places), GATES);
  assert.equal(plan2.go, true);
  const page = b.replace("met every", "met almost every"); // what the paragraph's text reads on the page
  assert.ok(findOnce(page, plan2.places[0].changes[0].needle), "the change's own words are found: only the hash tells");
  assert.equal(locateChanges(page, plan2.places[0].changes, plan2.places[0].locator.text_hash), null);
});

test("runs that are not an agent's edit draw nothing: a voice guide draft (activity kind voice), a run on this Mac (history kind local)", () => {
  const d = detailOf([placeFor("We expect a quieter quarter.", "We expect a stronger quarter.")]);
  assert.deepEqual(gateOpen({ ...GATES, newest: { kind: "voice", reverted: false, revertRecommended: false, flags: [] } }), { open: false, why: "newest" });
  // a quick change or a quick fix's Use: the activity entry is kind agent (by local), the History update is kind local
  assert.deepEqual(planWriteIn({ ...d, kind: "local" }, GATES), { go: false, why: "detail" });
});
