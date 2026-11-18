// src/html.js: decoding (R10), the limits (R22), the located-node index and addressability (R8), units and the outline (R7), text
// splices with their escaping and the proof. Every page here is generated in memory; nothing is written.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import "../src/html-parser.js";
import { parse } from "../vendor/parse5/parse5.mjs";
import * as H from "../src/html.js";
import { CapError } from "../src/xml.js";
import { outlineOf } from "../src/review.js";
import { readUnits } from "../src/anchors.js";
import { scanBudget } from "../src/text.js";

const B = (s) => Buffer.from(s, "utf8");
const read = (s) => H.readHtml(typeof s === "string" ? B(s) : s);
const textNodes = (r) => r.nodes.filter((x) => x.nodeName === "#text");
const textNode = (r, v) => textNodes(r).find((x) => x.value === v);

// ---- decoding ---------------------------------------------------------------------------------------------------------------------------
test("decode: UTF-8 with a BOM set aside and reported, the round trip exact; a BOM wins over a declared charset", () => {
  const body = B('<!doctype html><meta charset="windows-1252"><p>café</p>');
  const d = H.decodeHtml(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]));
  assert.deepEqual({ ok: d.ok, encoding: d.encoding, bomLen: d.bomLen, starts: d.text.startsWith("<!doctype") }, { ok: true, encoding: "utf8", bomLen: 3, starts: true });
  const r = read(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), B("<p>a</p>")]));
  assert.equal(r.bomLen, 3);
  assert.ok(!textNodes(r).some((x) => x.value.includes("﻿")), "the BOM is no text node");
  const p = textNode(r, "a");
  assert.equal(r.toByte(p.sourceCodeLocation.startOffset), 3 + 3, "byte offsets count the BOM");
});

test("decode: refusals with a reason code and the fixed sentence (R18); a declared windows-1252 file is offered a UTF-8 copy", () => {
  const latin = H.decodeHtml(Buffer.concat([B('<meta charset="windows-1252"><p>caf'), Buffer.from([0xe9]), B("</p>")]));
  assert.deepEqual([latin.ok, latin.encoding, latin.label, latin.copyable, latin.code, latin.sentence], [false, "declared-other", "windows-1252", true, "not_utf8", "This file is not saved as UTF-8; Onionskin can save a UTF-8 copy and open that."]);
  const iso = H.decodeHtml(B('<meta http-equiv="Content-Type" content="text/html; charset=ISO-8859-1"><p>plain</p>'));
  assert.deepEqual([iso.label, iso.copyable, iso.ascii], ["iso-8859-1", true, true], "declared but plain ASCII: still refused, with the copy offered");
  const sjis = H.decodeHtml(B('<meta charset="Shift_JIS"><p>x</p>'));
  assert.deepEqual([sjis.code, sjis.copyable, sjis.sentence], ["not_utf8", false, H.NOT_READABLE_ENCODING]);
  const bad = H.decodeHtml(Buffer.concat([B("<p>"), Buffer.from([0xc3, 0x28]), B("</p>")]));
  assert.deepEqual([bad.ok, bad.encoding, bad.code, bad.sentence], [false, "invalid", "invalid_utf8", H.NOT_READABLE_ENCODING]);
  assert.equal(H.decodeHtml(Buffer.from([0xff, 0xfe, 0x3c, 0x00])).code, "utf16");
  assert.throws(() => read(Buffer.from([0xff, 0xfe, 0x3c, 0x00])), (e) => e instanceof H.HtmlEncodingError && e.code === "utf16" && e.message === H.NOT_READABLE_ENCODING);
});

test("offsets: every located node, start tag, end tag and attribute maps to its exact bytes through CRLF, lone CR, NUL and astral characters", () => {
  const src = "<!doctype html>\r\n<html><head><title>T\r\n\u{1F600}</title></head>\r<body>\r\n<p class=\"\u{1F4A9}x\" id='a'>one\u0000two \u{1F600}\r\nthree</p>\r<pre>\r\n\r\nkeep</pre><!-- c é -->\n<p>中文 café</p></body></html>";
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), B(src)]);
  const r = read(bytes);
  let checked = 0;
  const same = (s, e) => {
    assert.equal(bytes.subarray(r.toByte(s), r.toByte(e)).toString("utf8"), r.text.slice(s, e));
    checked++;
  };
  for (const x of r.nodes) {
    const l = x.sourceCodeLocation;
    same(l.startOffset, l.endOffset);
    if (l.startTag) same(l.startTag.startOffset, l.startTag.endOffset);
    if (l.endTag) same(l.endTag.startOffset, l.endTag.endOffset);
    for (const a of Object.values(l.attrs || {})) same(a.startOffset, a.endOffset);
  }
  assert.ok(checked > 30);
  const at = r.text.indexOf("\u{1F600}");
  assert.throws(() => r.toByte(at + 1), /surrogate/);
  assert.ok(textNodes(r).some((x) => x.value.includes("\u0000") === false && x.value.startsWith("one")), "NUL is dropped from the value, still inside the span");
});

// ---- limits -----------------------------------------------------------------------------------------------------------------------------
const page = (body) => `<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body>${body}</body></html>`;
const refused = (src, re) => assert.throws(() => read(src), (e) => e instanceof CapError && re.test(e.message), re);

test("limit: file size, stated in MB with the limit", () => {
  refused(B(page(`<!--${"x".repeat(10 * 1024 * 1024)}-->`)), /^this page is 10\.0 MB, more than the 10 MB Onionskin can read\. Split it into smaller pages and open those$/);
  assert.ok(read(page(`<p>t</p><!--${"x".repeat(9 * 1024 * 1024)}-->`)).units.length > 0);
});
test("limit: elements, counted as the tree is built (a 10 MB file of tiny elements is refused, not run out of memory)", () => {
  refused(page("<br>".repeat(200_000)), /^this page has more than 200,000 elements, more than Onionskin can read\. Split it into smaller pages and open those$/);
  refused(page("<b></b>".repeat(1_400_000)), /more than 200,000 elements/);
  assert.equal(read(page("<br>".repeat(190_000))).nodes.length > 190_000, true);
});
test("limit: attributes", () => {
  refused(page('<i a b c d></i>'.repeat(100_001)), /^this page has more than 400,000 attributes, more than Onionskin can read/);
  read(page('<i a b c></i>'.repeat(100_000)));
});
test("limit: characters of text", () => {
  refused(page("a".repeat(8_000_001)), /^this page has more than 8,000,000 characters of text, more than Onionskin can read/);
  read(page("a".repeat(7_999_000)));
});
test("limit: nesting depth 512 opens, deeper is refused, and nothing recurses at 100,000 levels", () => {
  // html is level 1 and body 2: 510 divs put the deepest at 512
  const deep = (k) => page(`${"<div>".repeat(k)}deep${"</div>".repeat(k)}`);
  const r = read(deep(510));
  assert.equal(r.units.at(-1).tag, "div");
  refused(deep(511), /^this page nests elements more than 512 levels deep, more than Onionskin can read/);
  refused(deep(100_000), /more than 512 levels deep/);
});
test("limit: one attribute value of 1,000,000 characters; a data: value counts against the file size only (R16)", () => {
  refused(page(`<p title="${"x".repeat(1_000_001)}">t</p>`), /^an attribute value in this page is longer than 1,000,000 characters/);
  read(page(`<p title="${"x".repeat(1_000_000)}">t</p>`));
  read(page(`<img src="data:image/png;base64,${"A".repeat(3_000_000)}" alt="">`));
});

// ---- ids, units, addressability (R8) ----------------------------------------------------------------------------------------------------
test("ids count located nodes only, in source order; implied elements have none", () => {
  const r = read("<p>one<p>two<table><tr><td>c</td></tr></table>");
  assert.deepEqual(r.nodes.map((x) => x.__id), r.nodes.map((_, i) => i));
  for (let i = 1; i < r.nodes.length; i++) assert.ok(r.nodes[i - 1].sourceCodeLocation.startOffset <= r.nodes[i].sourceCodeLocation.startOffset);
  const htmlEl = r.doc.childNodes.find((x) => x.tagName === "html");
  assert.equal(htmlEl.sourceCodeLocation, null);
  assert.equal(htmlEl.__id, undefined, "an implied html element has no id");
  assert.ok(!r.nodes.some((x) => x.tagName === "tbody"), "the implied tbody is not located");
});

test("malformed structure: each text node is addressable or read-only as R8 says, and an addressable one is never mis-spliced", () => {
  const cases = {
    "text around a table": "<table>before<tr><td>cell</td></tr>after</table>",
    "foster text merged with body text": "<p>x</p>lead<table>stray<tr><td>c</td></tr></table>",
    "misnested formatting": "<p><b>one<i>two</b>three</i> four</p>",
    "adoption agency": "<b>1<p>2</b>3</p>",
    "implied elements": "plain text with no tags at all<p>then a paragraph",
    "unclosed at EOF": "<div><p>open <b>bold text",
    "comment cut at EOF": "<p>text</p><!-- not closed",
    "p in p": "<p>outer<p>inner</p>",
    "duplicate attributes and ids": '<p id="dup" id="other" class="a" class="b">first</p><p id="dup">second</p>',
  };
  let spliced = 0;
  let readOnly = 0;
  for (const [name, src] of Object.entries(cases)) {
    const r = read(src);
    for (const x of textNodes(r)) {
      if (!/\S/.test(x.value)) continue;
      const res = H.spliceText(r, x.__id, "NEW");
      if (x.__ok !== true) {
        assert.equal(res.ok, false, `${name}: read-only "${x.value}" refused`);
        assert.ok(["not_addressable", "frozen"].includes(res.code), `${name}: ${res.code}`);
        readOnly++;
        continue;
      }
      // an addressable node: the splice is proven, and an independent parse shows NEW exactly where the node was
      if (!res.ok) {
        assert.equal(res.code, "would_change_structure", `${name}: ${res.code}`);
        continue;
      }
      spliced++;
      const path = H.pathOf(x);
      const after = parse(res.bytes.toString("utf8"));
      const at = H.atPath(after, path);
      assert.ok(at && at.nodeName === "#text" && at.value.includes("NEW"), `${name}: "${x.value}" became NEW in place`);
      assert.equal(res.bytes.toString("utf8").replace("NEW", x.value), src, `${name}: only that text changed`);
    }
  }
  assert.ok(spliced >= 15 && readOnly >= 1, `${spliced} spliced, ${readOnly} read-only`);
  // the specific R8 cases: foster-parented text merged across a table is read-only
  const f = read(cases["foster text merged with body text"]);
  assert.ok(textNodes(f).some((x) => /stray/.test(x.value) && x.__ok !== true), "merged foster text is read-only");
  const d = read(cases["duplicate attributes and ids"]);
  assert.equal(H.hasDuplicateAttributes(d, d.units[0].nodeId), true);
  assert.equal(H.hasDuplicateAttributes(d, d.units[1].nodeId), false);
  assert.deepEqual(d.units.map((u) => [u.htmlId, u.hasId]), [[null, true], [null, true]], "a shared id is no element id");
  assert.equal(H.elementAddressable(read(cases["adoption agency"]), read(cases["adoption agency"]).nodes.findLast((x) => x.tagName === "b").__id), false, "an adoption-agency clone is not addressable");
});

test("units: elements that directly hold text and leaf elements, never raw text or template content; editable as their text is", () => {
  const r = read(page('<h2 id="intro">Intro</h2><p>Hello <b>world</b></p><div><span>  </span></div><img src="a.png" alt="A"><script>var s = "body";</script><style>p{}</style><template><p>inert</p></template><noscript><p>ns</p></noscript><textarea>edit me</textarea>'));
  assert.deepEqual(r.units.map((u) => `${u.tag}:${u.kind}:${u.editable}`), ["title:text:true", "h2:text:true", "p:text:true", "b:text:true", "img:leaf:false", "textarea:text:true"]);
  assert.equal(r.units[2].heading, 1, "the paragraph is under the h2");
  assert.equal(r.units[1].heading, -1, "a heading's own heading is the one before it");
  assert.equal(r.units[1].htmlId, "intro");
  assert.ok(!r.flat.includes("body") && !r.flat.includes("inert") && !r.flat.includes("ns"), "raw text and template content are not in the visible text");
});

test("the outline (R7): tag names and ids constrained, script and style bodies never included, texts under the outline's caps", () => {
  const long = "my-element-with-a-name-longer-than-thirty-two-characters";
  const src = page(`<h1>Title</h1><${long}>custom text</${long}><p id="Has Space">odd id</p><p id="ok-id">fine id</p><Foo:Bar>ns</Foo:Bar><script>SECRET_SCRIPT_BODY()</script><style>.SECRET_STYLE_BODY{}</style><svg><style>.SECRET_SVG_STYLE{}</style><script>SECRET_SVG_SCRIPT()</script></svg><p>${"long ".repeat(500)}</p>`);
  const r = read(src);
  const { outline } = outlineOf("html", null, 2000, { format: "html", read: r });
  const json = JSON.stringify(outline);
  assert.ok(!/SECRET_/.test(json), "no script or style body");
  assert.ok(!json.includes(long), "a long tag name is a token");
  assert.ok(!json.includes("Has Space"), "an unsafe id is a token");
  assert.ok(json.includes("#ok-id") && json.includes("#(id)"));
  for (const e of outline) assert.match(e.label, /^(?:[a-z0-9-]{1,32}|t-[0-9a-f]{12})(?:#(?:[a-z0-9-]{1,32}|\(id\)))?(?: \(heading \d\))?(?: under ".*")?$/, e.label);
  const big = outline.find((e) => e.text.startsWith("long"));
  assert.ok(big.text.length <= 1000 && big.text_exact === false);
  // one addressing form, as the op schema takes it: the unique id (the path is the other form, for an element without one)
  assert.deepEqual(outline.find((e) => e.text === "fine id").target, { element_id: "ok-id" });
  // anchors on every unit carry no script or style body either
  const all = scanBudget(40_000_000, () => r.units.map((u) => H.htmlDurable(r, { location: { nodeId: u.nodeId }, quote: "" })));
  assert.ok(!/SECRET_/.test(JSON.stringify(all)));
});

// ---- text splices -----------------------------------------------------------------------------------------------------------------------
test("text splices: escaping per context, the leading newline of pre and textarea, and the refusal codes", () => {
  const src = page('<p class="c">a &lt; b &amp; c</p><pre>\nfirst</pre><textarea>\nbox</textarea><script>code()</script><p>   </p>');
  const r = read(src);
  const ok = (v, n) => {
    const s = H.spliceText(r, textNode(r, v).__id, n);
    assert.ok(s.ok, `${v}: ${s.code}`);
    const r2 = H.readParsed(s.parsed);
    return [s.bytes.toString("utf8"), r2];
  };
  let [out, r2] = ok("a < b & c", 'x <y> & "z"\r\nw');
  assert.ok(out.includes('<p class="c">x &lt;y&gt; &amp; "z"&#13;\nw</p>'));
  assert.ok(textNodes(r2).some((x) => x.value === 'x <y> & "z"\r\nw'));
  [out] = ok("t", "a </title> & <b>");
  assert.ok(out.includes("<title>a &lt;/title> &amp; &lt;b></title>"), "RCDATA keeps > and escapes & and <");
  [out] = ok("first", "\nlead");
  assert.ok(out.includes("<pre>\n\nlead</pre>"), "one more literal newline for the parser to drop");
  [out] = ok("box", "\nbox2");
  assert.ok(out.includes("<textarea>\n\nbox2</textarea>"));
  const refuse = (id, v) => H.spliceText(r, id, v).code;
  assert.equal(refuse(textNode(r, "code()").__id, "x"), "frozen");
  assert.equal(refuse(textNode(r, "   ").__id, "x"), "whitespace_only");
  assert.equal(refuse(textNode(r, "first").__id, "a\u0000b"), "nul");
  assert.equal(refuse(textNode(r, "first").__id, "a\ud800b"), "lone_surrogate");
  assert.equal(refuse(r.units[0].nodeId, "x"), "not_text");
  assert.equal(refuse(99_999, "x"), "no_such_node");
});

test("the proof refuses a splice that changes structure outside the edited place, and holds what the edit says", () => {
  const r = read(page("<p>one</p><p>two</p>"));
  const one = textNode(r, "one");
  const [s, e] = H.textRange(one, r.text);
  // hand-made splices the edit does not describe: an element for the text, a new paragraph beside it
  assert.equal(H.proveSplice(r, H.spliceBytes(r, s, e, "<b>one</b>"), H.editText(one, "one")).code, "edited_place_differs");
  assert.equal(H.proveSplice(r, H.spliceBytes(r, s, e, "one</p><p>extra"), H.editText(one, "one")).code, "children_count");
  assert.equal(H.proveSplice(r, H.spliceBytes(r, s, e, "uno"), H.editText(one, "one")).code, "edited_place_differs");
  assert.equal(H.proveSplice(r, H.spliceBytes(r, s, e, "uno"), H.editText(one, "uno")).ok, true);
  // an attribute edit
  const p = r.units[1].node;
  const at = p.sourceCodeLocation.startTag;
  const withClass = H.spliceBytes(r, at.endOffset - 1, at.endOffset - 1, ' class="x"');
  assert.equal(H.proveSplice(r, withClass, H.editAttributes(p, [{ name: "class", value: "x" }])).ok, true);
  assert.equal(H.proveSplice(r, withClass, H.editAttributes(p, [{ name: "class", value: "y" }])).code, "edited_place_differs");
  // past a limit or not UTF-8: refused
  assert.equal(H.proveSplice(r, Buffer.concat([r.bytes, Buffer.from([0xff])]), H.editText(one, "one")).code, "decode");
});

test("on the server's thread (no parser installed) reading an HTML file throws a clear error; units through anchors.js read it in a worker", () => {
  const html = fileURLToPath(new URL("../src/html.js", import.meta.url));
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `import { readHtml } from ${JSON.stringify(html)}; try { readHtml(Buffer.from("<p>x")); } catch (e) { console.log(e.message); }`], { encoding: "utf8" });
  assert.match(r.stdout, /the HTML parser is not loaded on this thread/);
  assert.equal(readUnits("html", B("<p>x</p>")).read.units.length, 1, "with the parser (this test installed it)");
});
