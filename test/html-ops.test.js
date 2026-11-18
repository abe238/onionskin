// src/ops/html.js through src/ops/run.js: each HTML op as a splice of the source, the bytes outside the edited place unchanged, every
// refusal code, spans_markup, R7 (no script or style body in any excerpt), replace_all_text's counting, ops of one file together, the
// fixtures, the reply shorthand, the schema, and the run in the ops worker when the parser is not on the calling thread. Pages are
// generated in memory or read from test/fixtures/html; nothing is written.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { P5 } from "../src/html-parser.js";
import * as H from "../src/html.js";
import { previewAll, runOps } from "../src/ops/run.js";
import { validateOps } from "../src/ops/schema.js";
import { planReplies } from "../src/reply.js";
import { buildBatch, replyWithOf } from "../src/batch.js";
import { ACTIVE_REFUSED } from "../src/html-active.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIX = path.join(repo, "test", "fixtures", "html");
const B = (s) => Buffer.from(s, "utf8");
const run = (src, ops, opts = {}) => runOps({ bytes: typeof src === "string" ? B(src) : src, format: "html", name: "t.html", ops, ...opts });
const page = (body, head = "<title>T</title>") => `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n${head}\n</head>\n<body>\n${body}\n</body>\n</html>\n`;
const el = (src, p) => {
  const r = H.readHtml(B(src));
  const x = H.byPath(r, p.slice(1).split("/").map((s) => s.replace(/\[(\d+)\]$/, (_, k) => `:${k - 1}`)));
  return { r, x };
};
const hashOf = (src, p) => H.ownHash(el(src, p).x);
/** The bytes of `after` equal those of `before` outside the source range [s, e) of `before` (UTF-16 offsets): the edit stayed there. */
function onlyInside(before, after, s, e) {
  const a = B(before);
  const bs = Buffer.byteLength(before.slice(0, s));
  const be = Buffer.byteLength(before.slice(0, e));
  assert.ok(after.length >= bs + (a.length - be), "the result is not shorter than what lies outside the edit");
  assert.ok(after.subarray(0, bs).equals(a.subarray(0, bs)), "bytes before the edited place are unchanged");
  assert.ok(after.subarray(after.length - (a.length - be)).equals(a.subarray(be)), "bytes after the edited place are unchanged");
}
const rangeOf = (src, p) => {
  const { x } = el(src, p);
  return [x.sourceCodeLocation.startOffset, x.sourceCodeLocation.endOffset];
};
/** The parsed tree of a source as the page parses it (an independent oracle: a fresh parse, no reading). */
const tree = (s) => P5.parse(s, { scriptingEnabled: true });

const BODY = [
  '<h1 id="top">Quarterly report</h1>',
  '<p id="intro" class="lead">Revenue grew\n   by 24% this quarter &amp; costs <b>fell</b> a little.</p>',
  "<ul>\n<li>North</li>\n<li>South &copy; team</li>\n</ul>",
  '<table><tbody><tr><td>Q1</td><td>12</td></tr></tbody></table>',
  "<p>Closing remark with <a href='notes.html'>notes</a>.</p>",
].join("\n");
const P = page(BODY);
const INTRO = "/html[1]/body[1]/p[1]";

test("replace_text: one splice of exactly the matched source, whitespace in find matching a source line break, references elsewhere untouched", async () => {
  const r = await run(P, [{ op: "replace_text", target: { element_id: "intro" }, expect: { text_hash: hashOf(P, INTRO) }, find: "grew by 24%", replace: "grew by 40%" }]);
  assert.deepEqual(r.results.map((x) => [x.status, x.detail]), [["applied", { replaced: 1 }]]);
  const out = r.bytes.toString();
  assert.ok(out.includes('<p id="intro" class="lead">Revenue grew by 40% this quarter &amp; costs <b>fell</b>'), out);
  const s = P.indexOf("grew\n");
  onlyInside(P, r.bytes, s, s + "grew\n   by 24%".length);
  // the new text is escaped for its place; the reference next to it stays as written
  const r2 = await run(P, [{ op: "replace_text", target: { path: INTRO }, expect: { quote: "costs fell" }, find: "costs", replace: "R&D <costs>" }]);
  assert.ok(r2.bytes.toString().includes("&amp; R&amp;D &lt;costs&gt; <b>fell</b>"));
  // an existing reference can be matched by its value and replaced whole
  const r3 = await run(P, [{ op: "replace_text", target: { path: "/html[1]/body[1]/ul[1]/li[2]" }, expect: { quote: "South" }, find: "©", replace: "and" }]);
  assert.ok(r3.bytes.toString().includes("<li>South and team</li>"));
  // occurrence, all, match_case as in the other formats; text inside a nested element of the target is found too
  const r4 = await run(P, [{ op: "replace_text", target: { path: INTRO }, expect: { quote: "Revenue" }, find: "FELL", replace: "rose", match_case: false }]);
  assert.ok(r4.bytes.toString().includes("<b>rose</b>"));
  assert.deepEqual(tree(r4.bytes.toString()).childNodes.length, tree(P).childNodes.length);
});

test("set_text, set_attribute, remove_attribute, insert_html (four places), replace_element, delete_element: each splices only its place, and the result parses to the expected tree", async () => {
  const cases = [
    [{ op: "set_text", target: { path: "/html[1]/body[1]/ul[1]/li[1]" }, expect: { quote: "North" }, text: "North & East" }, "/html[1]/body[1]/ul[1]/li[1]", "<li>North &amp; East</li>"],
    [{ op: "set_attribute", target: { element_id: "intro" }, expect: { quote: "Revenue" }, name: "class", value: 'lead "big"' }, INTRO, 'class="lead &quot;big&quot;"'],
    [{ op: "set_attribute", target: { element_id: "intro" }, expect: { quote: "Revenue" }, name: "title", value: "Summary" }, INTRO, '<p id="intro" class="lead" title="Summary">'],
    [{ op: "remove_attribute", target: { element_id: "intro" }, expect: { quote: "Revenue" }, name: "class" }, INTRO, '<p id="intro">Revenue'],
    [{ op: "insert_html", target: { element_id: "top" }, expect: { quote: "Quarterly" }, where: "after", html: "<p>New <em>paragraph</em>.</p>" }, "/html[1]/body[1]/h1[1]", '</h1><p>New <em>paragraph</em>.</p>\n<p id="intro"'],
    [{ op: "insert_html", target: { element_id: "top" }, expect: { quote: "Quarterly" }, where: "before", html: "<hr>" }, "/html[1]/body[1]/h1[1]", '<hr><h1 id="top">'],
    [{ op: "insert_html", target: { path: "/html[1]/body[1]/ul[1]" }, expect: { quote: "North" }, where: "first_child", html: "<li>West</li>" }, "/html[1]/body[1]/ul[1]", "<ul><li>West</li>\n<li>North"],
    [{ op: "insert_html", target: { path: "/html[1]/body[1]/ul[1]" }, expect: { quote: "North" }, where: "last_child", html: "<li>East</li>" }, "/html[1]/body[1]/ul[1]", "team</li>\n<li>East</li></ul>"],
    [{ op: "replace_element", target: { path: "/html[1]/body[1]/table[1]" }, expect: { quote: "Q1" }, html: "<table><tbody><tr><th>Q</th><td>13</td></tr></tbody></table>" }, "/html[1]/body[1]/table[1]", "<th>Q</th><td>13</td>"],
    [{ op: "delete_element", target: { path: "/html[1]/body[1]/ul[1]/li[2]" }, expect: { quote: "South" } }, "/html[1]/body[1]/ul[1]/li[2]", "<li>North</li>\n\n</ul>"],
  ];
  for (const [op, p, want] of cases) {
    const r = await run(P, [op]);
    assert.equal(r.results[0].status, "applied", `${op.op}: ${JSON.stringify(r.results[0])}`);
    const out = r.bytes.toString();
    assert.ok(out.includes(want), `${op.op}: ${out}`);
    const [s, e] = rangeOf(P, p);
    onlyInside(P, r.bytes, op.where === "after" ? e : s, op.where === "before" ? s : e);
    // an independent oracle: a fresh parse of the result equals a fresh parse of the expected source
    const expected = P.slice(0, s) + out.slice(s, out.length - (P.length - e)) + P.slice(e);
    assert.equal(expected, out);
  }
});

test("refusal codes: anchor_not_found, expect_mismatch, spans_markup, not_addressable, active_content, not_well_formed, proof_failed, unsupported_op, too_large, not_utf8", async () => {
  const code = async (src, op) => {
    const r = await run(src, [op]);
    assert.equal(r.bytes, null, `nothing written for ${op.op}`);
    return [r.results[0].status, r.results[0].code ?? null];
  };
  const q = { quote: "Revenue" };
  assert.deepEqual(await code(P, { op: "set_text", target: { element_id: "nope" }, expect: q, text: "x" }), ["anchor_not_found", null]);
  assert.deepEqual(await code(P, { op: "set_text", target: { path: "/html[1]/body[1]/p[9]" }, expect: q, text: "x" }), ["anchor_not_found", null]);
  assert.deepEqual(await code(P, { op: "set_text", target: { anchor_id: "a9" }, expect: q, text: "x" }), ["anchor_not_found", null]);
  assert.deepEqual(await code(P, { op: "replace_text", target: { element_id: "intro" }, expect: q, find: "missing words", replace: "x" }), ["anchor_not_found", null]);
  assert.deepEqual(await code(P, { op: "replace_text", target: { element_id: "intro" }, expect: q, find: "e", replace: "x" }), ["anchor_not_found", null], "ambiguous");
  assert.deepEqual(await code(P, { op: "remove_attribute", target: { element_id: "intro" }, expect: q, name: "title" }), ["anchor_not_found", null]);
  assert.deepEqual(await code(P, { op: "set_text", target: { element_id: "intro" }, expect: { quote: "Profit" }, text: "x" }), ["expect_mismatch", null]);
  assert.deepEqual(await code(P, { op: "set_text", target: { element_id: "intro" }, expect: { text_hash: "0000000000000000" }, text: "x" }), ["expect_mismatch", null]);
  // R11: across an element's edge, or an element with more than one text
  assert.deepEqual(await code(P, { op: "replace_text", target: { element_id: "intro" }, expect: q, find: "costs fell", replace: "x" }), ["refused", "spans_markup"]);
  assert.deepEqual(await code(P, { op: "set_text", target: { element_id: "intro" }, expect: q, text: "x" }), ["refused", "spans_markup"]);
  // R8: an element the parser implied, R22: a start tag with an attribute twice, whitespace-only text
  assert.deepEqual(await code(page("<table><tr><td>a</td></tr></table>"), { op: "set_attribute", target: { path: "/html[1]/body[1]/table[1]/tbody[1]" }, expect: { quote: "a" }, name: "class", value: "x" }), ["refused", "not_addressable"]);
  assert.deepEqual(await code(page('<p class="a" class="b">t</p>'), { op: "remove_attribute", target: { path: "/html[1]/body[1]/p[1]" }, expect: { quote: "t" }, name: "class" }), ["refused", "not_addressable"]);
  assert.deepEqual(await code(page("<p> </p>"), { op: "set_text", target: { path: "/html[1]/body[1]/p[1]" }, expect: { quote: "" }, text: "x" }), ["refused", "not_addressable"]);
  assert.deepEqual(await code(page("<p>a<br>b</p>"), { op: "insert_html", target: { path: "/html[1]/body[1]/p[1]/br[1]" }, expect: { quote: "" }, where: "first_child", html: "<b>x</b>" }), ["refused", "not_addressable"]);
  // R1: script and style are frozen; adding code is refused with the one sentence
  assert.deepEqual(await code(page("<p>t</p>", "<style>p{color:red}</style>"), { op: "set_text", target: { path: "/html[1]/head[1]/style[1]" }, expect: { quote: "" }, text: "p{}" }), ["refused", "active_content"]);
  const added = await run(P, [{ op: "set_attribute", target: { element_id: "intro" }, expect: q, name: "onclick", value: "go()" }]);
  assert.deepEqual([added.results[0].code, added.results[0].reason, added.results[0].reasons], ["active_content", ACTIVE_REFUSED, ["event_handler"]]);
  // the fragment must read back the same where it is put
  assert.deepEqual(await code(P, { op: "insert_html", target: { element_id: "top" }, expect: { quote: "Quarterly" }, where: "after", html: "<pre>\n\nindented</pre>" }), ["refused", "not_well_formed"]);
  assert.deepEqual(await code(P, { op: "insert_html", target: { element_id: "top" }, expect: { quote: "Quarterly" }, where: "after", html: "<plaintext>a</b>" }), ["refused", "not_well_formed"]);
  // the proof: text put right before a paragraph whose start closes an open one would join that paragraph
  const open = page("<p>one<p id='two'>two</p>");
  assert.deepEqual(await code(open, { op: "insert_html", target: { element_id: "two" }, expect: { quote: "two" }, where: "before", html: " more" }), ["refused", "proof_failed"]);
  assert.deepEqual(await code(P, { op: "set_cells", target: { anchor_id: "a1" }, expect: q, values: 1 }), ["refused", "unsupported_op"]);
  assert.deepEqual(await code(`<p>${"<br>".repeat(200_001)}`, { op: "set_text", target: { path: "/html[1]/body[1]/p[1]" }, expect: q, text: "x" }), ["refused", "too_large"]);
  assert.deepEqual(await code(Buffer.concat([B("<p>caf"), Buffer.from([0xe9]), B("</p>")]), { op: "set_text", target: { path: "/html[1]/body[1]/p[1]" }, expect: q, text: "x" }), ["refused", "not_utf8"]);
});

test("R7: a mismatch excerpt never holds a script or style body, and a script or style target is refused before its text is read", async () => {
  const SECRET = "SCRIPT_BODY_MARKER";
  const src = page(`<div id="box"><p>visible words</p><script>var x = "${SECRET}";</script><style>.c{content:"${SECRET}"}</style></div>`);
  for (const op of [
    { op: "set_attribute", target: { element_id: "box" }, expect: { quote: "not there" }, name: "class", value: "x" },
    { op: "delete_element", target: { element_id: "box" }, expect: { text_hash: "0000000000000000" } },
    { op: "set_text", target: { path: "/html[1]/body[1]/div[1]/script[1]" }, expect: { quote: "nope" }, text: "x" },
    { op: "set_attribute", target: { path: "/html[1]/body[1]/div[1]/style[1]" }, expect: { quote: "nope" }, name: "class", value: "x" },
  ]) {
    const r = await run(src, [op]);
    assert.ok(!JSON.stringify(r.results).includes(SECRET), JSON.stringify(r.results));
    assert.notEqual(r.results[0].status, "applied");
  }
  const mm = await run(src, [{ op: "set_attribute", target: { element_id: "box" }, expect: { quote: "not there" }, name: "class", value: "x" }]);
  assert.match(mm.results[0].actual_excerpt, /visible words/);
});

test("replace_all_text: text only (never a script or style body or an attribute value), counted with match_case, partial words, protected text and matches across markup", async () => {
  const src = page('<p title="cat">The cat sat. <b>Cat</b>alog</p><script>var cat = 1;</script><style>.cat{}</style><p>con<i>cat</i>enate ca<b>t</b></p>');
  const count = async (find, opts = {}) => previewAll(B(src), "html", { op: "replace_all_text", find, replace: "dog", expect: { count: 0 }, ...opts });
  assert.deepEqual(await count("cat"), { ok: true, count: 2, protected: 0, partial_words: 0 });
  assert.deepEqual(await count("cat", { match_case: false }), { ok: true, count: 3, protected: 0, partial_words: 0 }, "a match is weighed inside its own text: <b>Cat</b>alog's 'alog' is another text; the attribute's 'cat' is not counted");
  const miss = await run(src, [{ op: "replace_all_text", find: "cat", replace: "dog", expect: { count: 3 } }]);
  assert.equal(miss.results[0].status, "expect_mismatch");
  assert.equal(miss.results[0].found, 2);
  assert.equal(miss.results[0].spans_markup, 1, "the 'ca<b>t</b>' match is across an element's edge");
  const r = await run(src, [{ op: "replace_all_text", find: "cat", replace: "dog", expect: { count: 2 } }]);
  assert.deepEqual(r.results[0].detail, { replaced: 2 });
  const out = r.bytes.toString();
  assert.ok(out.includes('<p title="cat">The dog sat.') && out.includes("var cat = 1;") && out.includes(".cat{}") && out.includes("con<i>dog</i>enate"), out);
  // text the parser builds from two places (stray text on both sides of a table row, moved out of the table and merged) is counted as
  // protected and skipped, never mis-spliced
  const fost = "<!doctype html><body><table>cat<tr><td>cat</td></tr>cat</table></body>";
  const pr = await previewAll(B(fost), "html", { op: "replace_all_text", find: "cat", replace: "dog", expect: { count: 0 } });
  assert.deepEqual([pr.count, pr.protected], [3, 2]);
  const f = await run(fost, [{ op: "replace_all_text", find: "cat", replace: "dog", expect: { count: 3 } }]);
  assert.equal(f.results[0].status, "applied");
  assert.equal(f.results[0].detail.replaced, 1);
  assert.deepEqual(f.results[0].detail.skipped_protected.map((x) => x.matches), [2]);
  assert.equal(f.bytes.toString(), "<!doctype html><body><table>cat<tr><td>dog</td></tr>cat</table></body>");
});

test("ops of one file bind against it as delivered, compose when their places differ, and an overlap is refused; --partial writes the rest", async () => {
  const ops = [
    { op: "replace_text", target: { element_id: "intro" }, expect: { quote: "Revenue" }, find: "Revenue", replace: "Income" },
    { op: "replace_text", target: { element_id: "intro" }, expect: { quote: "Revenue" }, find: "quarter", replace: "year" },
    { op: "set_attribute", target: { element_id: "intro" }, expect: { quote: "Revenue" }, name: "class", value: "lead big" },
    { op: "insert_html", target: { element_id: "intro" }, expect: { quote: "Revenue" }, where: "after", html: "<p>Added.</p>" },
    { op: "delete_element", target: { path: "/html[1]/body[1]/ul[1]/li[1]" }, expect: { quote: "North" } },
    { op: "replace_all_text", find: "South", replace: "Southern", expect: { count: 1 } },
  ];
  const r = await run(P, ops);
  assert.deepEqual(r.results.map((x) => x.status), ops.map(() => "applied"));
  const out = r.bytes.toString();
  assert.ok(out.includes('<p id="intro" class="lead big">Income grew\n   by 24% this year &amp; costs') && out.includes("</p><p>Added.</p>") && out.includes("<ul>\n\n<li>Southern &copy; team</li>"), out);
  // the same text twice, or an edit inside an element another op deletes: refused, and atomic mode writes nothing
  const clash = [
    { op: "replace_text", target: { element_id: "intro" }, expect: { quote: "Revenue" }, find: "Revenue grew", replace: "x" },
    { op: "replace_text", target: { element_id: "intro" }, expect: { quote: "Revenue" }, find: "grew", replace: "y" },
    { op: "delete_element", target: { path: "/html[1]/body[1]/ul[1]" }, expect: { quote: "North" } },
    { op: "set_text", target: { path: "/html[1]/body[1]/ul[1]/li[1]" }, expect: { quote: "North" }, text: "z" },
  ];
  const a = await run(P, clash);
  assert.equal(a.bytes, null);
  assert.deepEqual(a.results.map((x) => [x.status, x.code ?? null]), [["not_applied", null], ["refused", "overlapping_edit"], ["not_applied", null], ["not_applied", null]]);
  const p = await run(P, clash, { partial: true });
  assert.deepEqual(p.results.map((x) => [x.status, x.code ?? null]), [["applied", null], ["refused", "overlapping_edit"], ["applied", null], ["refused", "overlapping_edit"]]);
  assert.ok(p.bytes.toString().includes('<p id="intro" class="lead">x\n   by 24%') && !p.bytes.toString().includes("<ul>"));
  // --partial: a proof failure is traced to its op, the others are written
  const open = page("<p>one<p id='two'>two</p><p id='three'>three</p>");
  const q = await run(open, [{ op: "insert_html", target: { element_id: "two" }, expect: { quote: "two" }, where: "before", html: " more" }, { op: "set_text", target: { element_id: "three" }, expect: { quote: "three" }, text: "3" }], { partial: true });
  assert.deepEqual(q.results.map((x) => [x.status, x.code ?? null]), [["refused", "proof_failed"], ["applied", null]]);
  assert.ok(q.bytes.toString().includes("<p id='three'>3</p>"));
});

test("every fixture that opens takes a text replace, an attribute, an insert and a delete, each with the bytes outside its element unchanged", async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(FIX, "manifest.json"), "utf8"));
  let tried = 0;
  for (const { file } of manifest.files) {
    const bytes = fs.readFileSync(path.join(FIX, file));
    let read;
    try {
      read = H.readHtml(bytes);
    } catch {
      continue; // refused at open (encoding, limits): test/html-fixtures.test.js covers those
    }
    const src = read.text;
    const u = read.units.find((x) => x.editable && x.node.sourceCodeLocation?.startTag && x.node.namespaceURI === H.HTML_NS && /[A-Za-z]{4,}/.test(H.ownText(x.node)));
    if (!u) continue;
    tried++;
    const at = { path: H.pathString(H.elementPath(u.node)) };
    const expect = { text_hash: H.ownHash(u.node) };
    const word = /[A-Za-z]{4,}/.exec(H.ownText(u.node))[0];
    const [s, e] = [u.node.sourceCodeLocation.startOffset, u.node.sourceCodeLocation.endOffset];
    const bom = read.bomLen;
    const inside = (r, s0, e0) => onlyInside(src, r.bytes.subarray(bom), s0, e0);
    const r1 = await run(bytes, [{ op: "replace_text", target: at, expect, find: word, replace: "Changed", occurrence: 1 }]);
    if (r1.results[0].status === "applied") inside(r1, s, e);
    // a form control's or label's text is the body of an element R1 does not allow, so changing it is refused like adding one
    else assert.ok(["spans_markup", "not_addressable", "proof_failed", "active_content"].includes(r1.results[0].code), `${file}: ${JSON.stringify(r1.results[0])}`);
    const r2 = await run(bytes, [{ op: "set_attribute", target: at, expect, name: "title", value: "Note" }]);
    if (r2.results[0].status === "applied") inside(r2, s, u.node.sourceCodeLocation.startTag.endOffset);
    else assert.ok(["not_addressable", "proof_failed", "active_content"].includes(r2.results[0].code), `${file}: ${JSON.stringify(r2.results[0])}`);
    const r3 = await run(bytes, [{ op: "insert_html", target: at, expect, where: "after", html: "<p>Inserted paragraph.</p>" }]);
    if (r3.results[0].status === "applied") inside(r3, e, e);
    else assert.ok(["not_addressable", "proof_failed", "not_well_formed", "active_content"].includes(r3.results[0].code), `${file}: ${JSON.stringify(r3.results[0])}`);
    const r4 = await run(bytes, [{ op: "delete_element", target: at, expect }]);
    if (r4.results[0].status === "applied") inside(r4, s, e);
    else assert.ok(["not_addressable", "proof_failed", "active_content"].includes(r4.results[0].code), `${file}: ${JSON.stringify(r4.results[0])}`);
  }
  assert.ok(tried >= 30, `ops ran on ${tried} fixtures`);
});

test("the reply shorthands of an HTML comment: find+replace is replace_text, text is set_text; reply_with says which fits", () => {
  const anchorText = { id: "a1", resolved: true, unit: "text", locator: { path: INTRO, element_id: "intro", text_hash: "0123456789abcdef" } };
  assert.equal(replyWithOf(anchorText, "html"), "find_replace_or_text");
  assert.equal(replyWithOf({ ...anchorText, unit: "leaf" }, "html"), "ops");
  assert.equal(replyWithOf({ ...anchorText, locator: { ...anchorText.locator, text_hash: null } }, "html"), "ops");
  const batch = { format: "html", instructions: { comments: [{ id: "c1", anchor_id: "a1" }, { id: "c2", anchor_id: "a1" }] }, untrusted_document_evidence: { anchors: [anchorText] } };
  const plan = planReplies(batch, { replies: [{ comment: "c1", find: "24%", replace: "40%" }, { comment: "c2", text: "New text" }] });
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.ops, [
    { op: "replace_text", id: "c1", target: { anchor_id: "a1" }, expect: { text_hash: "0123456789abcdef" }, find: "24%", replace: "40%" },
    { op: "set_text", id: "c2", target: { anchor_id: "a1" }, expect: { text_hash: "0123456789abcdef" }, text: "New text" },
  ]);
  assert.ok(validateOps({ schema: "onionskin.ops/1", ops: plan.ops }).ok);
  // the batch tells the agent what a write may not add, and shows HTML examples only for an HTML file
  const b = buildBatch({ file: "/tmp/x.html", format: "html", baseSha: "a".repeat(64), note: "", edits: [], comments: [] });
  assert.ok(b.how_to_apply.rules.some((r) => r.includes("active_content") && r.includes(ACTIVE_REFUSED)));
  assert.ok(b.how_to_apply.examples.length >= 2 && b.how_to_apply.examples.every((e) => e.format === "html"));
  assert.ok(b.how_to_apply.examples.every((e) => validateOps({ schema: "onionskin.ops/1", ops: [{ ...e.op, expect: { text_hash: "0123456789abcdef" } }] }).ok));
});

test("the schema: the HTML ops, exactly one locator for an element, and replace_text taking an HTML path", () => {
  const v = (op) => validateOps({ schema: "onionskin.ops/1", ops: [op] });
  const e = { text_hash: "0123456789abcdef" };
  assert.ok(v({ op: "set_text", target: { path: INTRO }, expect: e, text: "x" }).ok);
  assert.ok(v({ op: "set_attribute", target: { element_id: "intro" }, expect: e, name: "class", value: "x" }).ok);
  assert.ok(v({ op: "remove_attribute", target: { anchor_id: "a1" }, expect: e, name: "title" }).ok);
  assert.ok(v({ op: "insert_html", target: { anchor_id: "a1" }, expect: e, where: "last_child", html: "<li>x</li>" }).ok);
  assert.ok(v({ op: "replace_element", target: { anchor_id: "a1" }, expect: e, html: "<p>x</p>" }).ok);
  assert.ok(v({ op: "delete_element", target: { anchor_id: "a1" }, expect: e }).ok);
  assert.ok(v({ op: "replace_text", target: { path: INTRO }, expect: e, find: "a", replace: "b" }).ok);
  assert.ok(!v({ op: "set_text", target: { path: INTRO, element_id: "intro" }, expect: e, text: "x" }).ok);
  assert.ok(!v({ op: "set_text", target: {}, expect: e, text: "x" }).ok);
  assert.ok(!v({ op: "insert_html", target: { anchor_id: "a1" }, expect: e, where: "inside", html: "<b>x</b>" }).ok);
  assert.ok(!v({ op: "set_source", target: { anchor_id: "a1" }, expect: e, text: "x" }).ok, "set_source does not exist (R1)");
  assert.ok(!v({ op: "set_attribute", target: { anchor_id: "a1" }, expect: e, name: "bad name", value: "x" }).ok);
});

test("without the parser on the calling thread (the CLI, the server), runOps and previewAll run the HTML driver in the ops worker", () => {
  const script = `
    import { runOps, previewAll } from ${JSON.stringify(path.join(repo, "src", "ops", "run.js"))};
    import { parserLoaded } from ${JSON.stringify(path.join(repo, "src", "html.js"))};
    const bytes = Buffer.from('<!doctype html><body><p id="x">Hello world</p></body>');
    const r = await runOps({ bytes, format: "html", name: "a.html", ops: [{ op: "replace_text", target: { element_id: "x" }, expect: { quote: "Hello" }, find: "world", replace: "there" }] });
    const p = await previewAll(bytes, "html", { op: "replace_all_text", find: "o", replace: "0", expect: { count: 0 } });
    console.log(JSON.stringify({ loaded: parserLoaded(), status: r.results[0].status, out: String(r.bytes), buffer: Buffer.isBuffer(r.bytes), count: p.count }));`;
  // a file, not stdin: a worker inherits --input-type, which then fails it
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "osk-html-cli-"));
  let c;
  try {
    fs.writeFileSync(path.join(d, "run.mjs"), script);
    c = spawnSync(process.execPath, [path.join(d, "run.mjs")], { encoding: "utf8", timeout: 120_000 });
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
  assert.equal(c.status, 0, c.stderr);
  assert.deepEqual(JSON.parse(c.stdout.trim()), { loaded: false, status: "applied", out: '<!doctype html><body><p id="x">Hello there</p></body>', buffer: true, count: 2 });
});
