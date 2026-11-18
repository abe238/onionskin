// The page's offsets and htmlDurable's agree (PLAN-html Phase 2a, viewer gap 4): a selection the page makes (web/src/html-view.js
// anchorFromRange: UTF-16 code units of a source text node's decoded text, or of an element's joined source text) becomes a durable anchor
// and resolves back to exactly the selected characters, through character references, astral characters and collapsed whitespace.
// Whitespace at the ends of a selection is not kept (the stored quote is trimmed).
import assert from "node:assert/strict";
import { test } from "node:test";
import "../src/html-parser.js";
import { htmlDurable, readHtml, resolveHtml } from "../src/html.js";

const SRC = "<!doctype html><body><h1>T</h1>\n<p>  Caf&eacute;   na&iuml;ve &#x1F600;\n  x <b>bold   one</b> end &amp; more  </p><p>Caf&eacute;   na&iuml;ve again</p></body>";
const read = readHtml(Buffer.from(SRC));
const p = read.nodes.find((x) => x.tagName === "p");
const t = p.childNodes[0];
const b = p.childNodes[1].childNodes[0];
const after = p.childNodes[2];

/** The page's anchor of value[start, end) in text node `x` (prefix and suffix as the page takes them). */
const pageAnchor = (x, start, end, joined = null) => {
  const v = joined ?? x.value;
  return { location: { nodeId: joined ? p.__id : x.__id, start, end }, quote: v.slice(start, end), prefix: v.slice(Math.max(0, start - 40), start), suffix: v.slice(end, end + 40) };
};
const roundTrip = (a) => resolveHtml(read, htmlDurable(read, a)).page;

test("within one text node: entities, an astral character and folded whitespace come back as exactly the selected characters", () => {
  for (const sel of ["naïve 😀", "Café   naïve", "é", "😀", "naïve 😀\n  x"]) {
    const start = t.value.indexOf(sel);
    assert.ok(start >= 0, sel);
    const page = roundTrip(pageAnchor(t, start, start + sel.length));
    assert.deepEqual(page, { nodeId: t.__id, start, end: start + sel.length }, JSON.stringify(sel));
    assert.equal(t.value.slice(page.start, page.end), sel);
  }
});

test("the same words in another paragraph do not capture it: the place, not only the words", () => {
  const second = read.nodes.filter((x) => x.tagName === "p")[1].childNodes[0];
  const sel = "Café   naïve";
  const start = second.value.indexOf(sel);
  const page = roundTrip(pageAnchor(second, start, start + sel.length));
  assert.deepEqual(page, { nodeId: second.__id, start, end: start + sel.length });
});

test("whitespace at the ends of a selection is left out; the words between are exact", () => {
  const sel = "  Café ";
  const page = roundTrip(pageAnchor(t, 0, sel.length));
  assert.equal(t.value.slice(page.start, page.end), "Café");
  const tail = "x ";
  const s = t.value.indexOf(tail);
  const p2 = roundTrip(pageAnchor(t, s, s + tail.length));
  assert.equal(t.value.slice(p2.start, p2.end), "x");
});

test("across text nodes (into the bold text): the element's joined text, exactly", () => {
  const joined = t.value + b.value + after.value;
  const s = joined.indexOf("x bold");
  const e = joined.indexOf("one") + 3;
  const page = roundTrip(pageAnchor(null, s, e, joined));
  assert.deepEqual(page, { nodeId: p.__id, start: s, end: e });
  assert.equal(joined.slice(page.start, page.end), "x bold   one");
});
