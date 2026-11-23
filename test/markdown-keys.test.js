// Markdown slice 2, the page's pure rules (web/src/md-edit.js): which keys swap the preview to Edit, where the first key lands in the
// source (exactly once, at the exact offset, or not at all with the editor at the start of the block), the textarea's line endings, and
// the one exact splice a Send carries. The browser test (e2e/markdown-edit.e2e.test.js) drives the same code through real keys.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readMarkdown } from "../src/markdown.js";
import * as editabilityStrings from "../web/src/md-edit.js";
import { MD_MIXED_EOL, MD_NOT_EXACT, draftSplice, editability, firstKey, fromTextarea, toTextarea, toTextareaOffset, typedKey } from "../web/src/md-edit.js";
// composeKey is new in 1.0.1: read it from the module so this file still loads (and fails by assertion) on a version without it
const composeKey = (e) => (editabilityStrings.composeKey ?? (() => undefined))(e);

/** The source after the first key at the displayed offset `at` of the first run that shows `needle` (offset inside that run's display). */
function typeAt(text, needle, k, key, { nth = 0 } = {}) {
  const tree = readMarkdown(text);
  const runs = tree.runs.filter((r) => r.display.includes(needle));
  const r = runs[nth];
  assert.ok(r, `a run shows ${needle}`);
  const off = r.display.indexOf(needle) + k;
  const out = firstKey(tree, { start: { run: r.id, offset: off }, end: { run: r.id, offset: off }, collapsed: true, exact: true }, key, editability(tree).eol);
  assert.ok(!out.reason, out.reason);
  const body = tree.text;
  return body.slice(0, out.from) + out.text + body.slice(out.to);
}

test("a. the first key lands at exactly the caret's source offset, once: mid-word, inside **bold**, after &amp;, after an emoji, block start and end, a table cell, a list item", () => {
  assert.equal(typeAt("hello world\n", "world", 2, "X"), "hello woXrld\n");
  assert.equal(typeAt("a **bold** b\n", "bold", 2, "X"), "a **boXld** b\n");
  assert.equal(typeAt("Tom &amp; Jerry\n", " Jerry", 0, "X"), "Tom &amp;X Jerry\n");
  assert.equal(typeAt("go 😀 now\n", " now", 0, "X"), "go 😀X now\n");
  assert.equal(typeAt("# Head\n\nPara\n", "Para", 0, "X"), "# Head\n\nXPara\n");
  assert.equal(typeAt("# Head\n\nPara\n", "Para", 4, "X"), "# Head\n\nParaX\n");
  assert.equal(typeAt("| a | b |\n| - | - |\n| c1 | d |\n", "c1", 1, "X"), "| a | b |\n| - | - |\n| cX1 | d |\n");
  assert.equal(typeAt("- one\n- two\n", "two", 3, "X"), "- one\n- twoX\n");
  // Enter is the file's line ending
  assert.equal(typeAt("a b\r\nc\r\n", "a b", 1, "\n"), "a\r\n b\r\nc\r\n");
});

test("b. a selection replaces exactly its range: the last ana of banana; a selection across hidden marks types nothing and says why", () => {
  const tree = readMarkdown("banana\n");
  const out = firstKey(tree, { start: { run: 0, offset: 3 }, end: { run: 0, offset: 6 }, collapsed: false, exact: true }, "x", "\n");
  assert.deepEqual(out, { from: 3, to: 6, text: "x" });
  assert.equal("banana\n".slice(0, out.from) + out.text + "banana\n".slice(out.to), "banx\n");
  const t2 = readMarkdown("Plain **strong** end\n");
  const a = t2.runs.find((r) => r.display.startsWith("Plain"));
  const z = t2.runs.find((r) => r.display === "strong");
  const across = firstKey(t2, { start: { run: a.id, offset: 0 }, end: { run: z.id, offset: 3 }, collapsed: false, exact: true }, "x", "\n");
  assert.deepEqual(across, { caret: 0, reason: MD_NOT_EXACT });
  // a caret inside an entity's spelling, or a point snapped from an element boundary: no key, the block's start
  const t3 = readMarkdown("x\n\nTom &amp; Jerry\n");
  const ent = t3.runs.find((r) => r.kind === "entity");
  assert.equal(firstKey(t3, { start: { run: ent.id, offset: 0 }, end: { run: ent.id, offset: 0 }, collapsed: true, exact: false }, "x", "\n").caret, 3);
});

test("c. no swap for shortcuts, arrows, Backspace, Delete, Tab, Escape and during composition; printable keys and Enter swap", () => {
  const no = [{ key: "c", metaKey: true }, { key: "a", ctrlKey: true }, { key: "€", altKey: true, metaKey: true }, { key: "a", altKey: true, ctrlKey: true }, { key: "ArrowLeft" }, { key: "ArrowLeft", altKey: true }, { key: "Backspace" }, { key: "Delete" }, { key: "Tab" }, { key: "Escape" }, { key: "a", isComposing: true }, { key: "Process", keyCode: 229 }, { key: "Dead" }, { key: "Dead", altKey: true }, { key: "F5" }];
  for (const e of no) assert.equal(typedKey(e), null, JSON.stringify(e));
  assert.equal(typedKey({ key: "a" }), "a");
  assert.equal(typedKey({ key: "A", shiftKey: true }), "A");
  assert.equal(typedKey({ key: " " }), " ");
  assert.equal(typedKey({ key: "😀" }), "😀");
  assert.equal(typedKey({ key: "Enter" }), "\n");
});

test("1.0.1 a printable key typed with Option (Alt) held is typing: the euro sign (Option-Shift-2 on a US Mac keyboard), Option-e on a layout that gives a letter", () => {
  assert.equal(typedKey({ key: "€", altKey: true, shiftKey: true }), "€");
  assert.equal(typedKey({ key: "e", altKey: true }), "e");
  assert.equal(typedKey({ key: "µ", altKey: true }), "µ");
  // never with Cmd or Ctrl, which are shortcuts
  assert.equal(typedKey({ key: "€", altKey: true, ctrlKey: true }), null);
  assert.equal(typedKey({ key: "m", altKey: true, metaKey: true }), null);
  assert.equal(composeKey({ key: "€", altKey: true }), false, "a typed key is not a composition");
});

test("1.0.1 a dead key or the start of a composition is not typed but opens Edit (composeKey), so the composition lands in the text box", () => {
  for (const e of [{ key: "Dead" }, { key: "Dead", altKey: true }, { key: "Dead", altKey: true, shiftKey: true }, { key: "Process", keyCode: 229 }, { key: "Unidentified", keyCode: 229 }]) {
    assert.equal(typedKey(e), null, JSON.stringify(e));
    assert.equal(composeKey(e), true, JSON.stringify(e));
  }
  // a key in the middle of a composition already going on is neither typed nor a start (as before 1.0.1: the preview stays)
  for (const e of [{ key: "Dead", metaKey: true }, { key: "Dead", ctrlKey: true }, { key: "a", isComposing: true }, { key: "Dead", isComposing: true }, { key: "a" }, { key: "ArrowLeft" }, null]) assert.equal(composeKey(e), false, JSON.stringify(e));
  assert.equal(typedKey({ key: "a", isComposing: true }), null);
});

test("d. the textarea round trip keeps a CRLF file's bytes; the splice of one edited word leaves everything else identical", () => {
  const text = "line one\r\nsecond word here\r\nend\r\n";
  const tree = readMarkdown(`﻿${text}`);
  const ed = editability(tree);
  assert.deepEqual(ed, { ok: true, eol: "\r\n" });
  assert.equal(fromTextarea(toTextarea(text), ed.eol), text, "identity");
  assert.equal(toTextareaOffset(text, text.indexOf("word")), text.indexOf("word") - 1);
  const edited = toTextarea(text).replace("word", "thing\nnew");
  const draft = fromTextarea(edited, ed.eol);
  const sp = draftSplice(text, draft, tree, readMarkdown(draft));
  assert.deepEqual([sp.from, sp.to, sp.old, sp.new], [17, 21, "word", "thing\r\nnew"]);
});

test("e. mixed line endings or a lone CR: not editable, with one sentence", () => {
  assert.deepEqual(editability(readMarkdown("a\nb\r\nc\n")), { ok: false, reason: MD_MIXED_EOL });
  assert.deepEqual(editability(readMarkdown("a\rb\n")), { ok: false, reason: MD_MIXED_EOL });
  assert.equal(editability(readMarkdown("no newline")).eol, "\n");
});

test("the splice is widened to allowed ends: &amp; edited to &lt;, an emoji next to one that shares its high surrogate, a combining mark", () => {
  const sp = (a, b) => draftSplice(a, b, readMarkdown(a), readMarkdown(b));
  const e1 = sp("x &amp; y\n", "x &lt; y\n");
  assert.deepEqual([e1.old, e1.new], ["&amp;", "&lt;"]);
  const e2 = sp("a 😀 b\n", "a 😁 b\n"); // U+1F600 and U+1F601: the same high surrogate
  assert.deepEqual([e2.old, e2.new], ["😀", "😁"]);
  const e3 = sp("cafe\n", "café\n");
  assert.equal(e3.ok, true);
  assert.equal(e3.source, "café\n");
  assert.ok(!/^[̀-ͯ]/.test(e3.new) || e3.from === 4, "a lone combining mark is never split from its base on the old side");
  assert.deepEqual(sp("same\n", "same\n"), { ok: true, none: true });
});

test("s7-4 the textarea's text is kept exactly: a U+FEFF anywhere stays (and is refused at Send), line endings convert", () => {
  assert.equal(fromTextarea("\uFEFF\uFEFFred red\n", "\n"), "\uFEFF\uFEFFred red\n");
  assert.equal(fromTextarea("\uFEFFa\nb\n", "\r\n"), "\uFEFFa\r\nb\r\n");
  assert.equal(fromTextarea("a\uFEFFb", "\n"), "a\uFEFFb");
});

test("s4-3 a file whose text starts with U+FEFF (after its BOM) is not editable; a normal BOM file and a BOM-less file keep every byte outside the splice", () => {
  const { MD_BODY_BOM } = editabilityStrings;
  assert.deepEqual(editability(readMarkdown("﻿﻿body\n")), { ok: false, reason: MD_BODY_BOM });
  for (const file of ["﻿body text\n", "body text\n"]) {
    const tree = readMarkdown(file);
    const ed = editability(tree);
    assert.equal(ed.ok, true);
    const draft = fromTextarea(`${toTextarea(tree.text)}!`, ed.eol);
    const sp = draftSplice(tree.text, draft, tree, readMarkdown(draft));
    const bom = tree.bom ? "﻿" : "";
    const out = bom + tree.text.slice(0, sp.from) + sp.new + tree.text.slice(sp.to);
    assert.equal(out, `${file}!`, "only the appended character changes");
  }
});

test("s6-6 U+FEFF anywhere in the text (after any BOM): not editable, so deleting a visible character can never expose and drop it", () => {
  const { MD_BODY_BOM } = editabilityStrings;
  assert.deepEqual(editability(readMarkdown("﻿x﻿red\n")), { ok: false, reason: MD_BODY_BOM });
  assert.deepEqual(editability(readMarkdown("x﻿red\n")), { ok: false, reason: MD_BODY_BOM });
  assert.equal(MD_BODY_BOM, "This file's text contains an invisible byte order mark character, so it opens for reading and comments only.");
  assert.equal(editability(readMarkdown("﻿red\n")).ok, true, "a BOM alone is fine");
});

// ---- slice 11 --------------------------------------------------------------------------------------------------------------------
test("s11-2 an empty file, and one that holds only a BOM: the first key is typed at offset 0, once", async () => {
  const { readMarkdown } = await import("../src/markdown.js");
  for (const src of ["", "﻿"]) {
    const tree = readMarkdown(src);
    // no run at all: the page has no exact point (at is null), or a caret it could not map
    for (const at of [null, { start: { run: 0 }, exact: false }]) {
      const out = firstKey(tree, at, "H", editability(tree).eol);
      assert.deepEqual(out, { from: 0, to: 0, text: "H" }, JSON.stringify(src));
      const draft = tree.text.slice(0, out.from) + out.text + tree.text.slice(out.to);
      assert.equal(draft, "H");
    }
  }
});

test("s11-3 a file whose line endings are only CR says so; a mixed file keeps the mixed sentence", async () => {
  const { readMarkdown } = await import("../src/markdown.js");
  const { MD_CR_EOL } = await import("../web/src/md-edit.js");
  assert.equal(editability(readMarkdown("one\rtwo\r")).reason, MD_CR_EOL);
  assert.equal(MD_CR_EOL, "This file uses old-style line endings (a carriage return alone), which this version does not edit, so it opens for reading and comments only. Save it with LF or CRLF line endings to edit it here.");
  assert.equal(editability(readMarkdown("one\r\ntwo\n")).reason, MD_MIXED_EOL);
  assert.equal(editability(readMarkdown("one\rtwo\n")).reason, MD_MIXED_EOL);
  assert.equal(editability(readMarkdown("one\ntwo\n")).ok, true);
});

test("s11-1 a draft keeps the one line-ending setting it was made with: Copy and Send give the same bytes, across re-bases", async () => {
  const { readMarkdown } = await import("../src/markdown.js");
  const { draftEolOf, mdDraftSource } = await import("../web/src/md-edit.js");
  const make = (file, value, prev = null) => ({ value, eol: draftEolOf(prev, editability(readMarkdown(file))) });
  // the review's case: CRLF file, the whole file replaced by one line with no newline and sent, the original restored meanwhile and the
  // draft re-based onto the one-line file: its own CRLF decides
  let d = make("one\r\ntwo\r\n", "x");
  d = make("one\r\ntwo\r\n", "one\ntwo\n", d); // the restore, typed while the Send was in flight
  d = { ...d, ...make("x", d.value, d) }; // re-based onto the new revision "x"
  assert.equal(mdDraftSource(d), "one\r\ntwo\r\n", "what Send writes");
  // control: an LF file
  let l = make("one\ntwo\n", "x");
  l = { ...l, ...make("x", "one\ntwo\n", l) };
  assert.equal(mdDraftSource(l), "one\ntwo\n");
  // control: the first submission keeps one CRLF
  let k = make("one\r\ntwo\r\n", "one\n");
  k = { ...k, ...make("one\r\n", "one\ntwo\n", k) };
  assert.equal(mdDraftSource(k), "one\r\ntwo\r\n");
  // a CRLF file, the draft re-based twice (onto a one-line file, then onto an LF file): still CRLF, and further typing keeps it
  let t = make("a\r\nb\r\n", "a\nb\nc\n");
  t = { ...t, ...make("z", t.value, t) };
  t = { ...t, ...make("z\nq\n", t.value + "d\n", t) };
  assert.equal(mdDraftSource(t), "a\r\nb\r\nc\r\nd\r\n");
  // a new draft (none before) takes the file's setting; a file with no line ending yet gives LF
  assert.equal(make("p\r\nq\r\n", "p\n").eol, "\r\n");
  assert.equal(make("p", "p\n").eol, "\n");
});
