// src/html-active.js: the allowlist of what is active in an HTML file, and the inventory a write is checked against. Ordinary HTML
// features only (the allowlist design makes a list of attacks unnecessary): each active feature is refused when a write adds or changes
// it and accepted when the file already had it unchanged; plain text, formatting, tables, lists, local images and ordinary links are
// accepted.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "../vendor/parse5/parse5.mjs";
import { ACTIVE_REFUSED, REASONS, attributeAllowed, cssPlain, elementAllowed, inventory, inventoryDelta, urlKind } from "../src/html-active.js";

const page = (body, head = "") => `<!doctype html><html><head><meta charset="utf-8"><title>T</title>${head}</head><body><h1>Report</h1><p>First paragraph.</p>${body}</body></html>`;
const inv = (html) => inventory(parse(html));
const delta = (a, b) => inventoryDelta(inv(a), inv(b));

// [name, added markup (body), head markup, reason]
const ACTIVE = [
  ["a script element", "<script>start()</script>", "", "script"],
  ["an event-handler attribute", '<p onclick="go()">Click</p>', "", "event_handler"],
  ["a frame", '<iframe src="other.html"></iframe>', "", "frame"],
  ["a form with an action", '<form action="https://forms.example/send"><input name="q"></form>', "", "form"],
  ["a remote image", '<img src="https://images.example/a.png" alt="a">', "", "load_url"],
  ["a stylesheet link", "", '<link rel="stylesheet" href="site.css">', "element"],
  ["a data- attribute", '<p data-state="open">Text</p>', "", "attribute"],
  ["a remote url() in a style attribute", '<p style="background: url(https://images.example/b.png)">Text</p>', "", "load_url"],
  ["an @import in a style element", "", '<style>@import "more.css"; p { color: red }</style>', "css"],
  ["a base element", "", '<base href="https://elsewhere.example/">', "element"],
  ["a meta refresh", "", '<meta http-equiv="refresh" content="0; url=https://elsewhere.example/">', "attribute"],
  ["a javascript: link", '<a href="javascript:go()">Go</a>', "", "link_url"],
];

test("each active feature is refused when a write adds it, with a neutral reason code, and accepted when the file already had it", () => {
  for (const [name, body, head, reason] of ACTIVE) {
    const before = page("<p>Second.</p>");
    const after = page(`<p>Second.</p>${body}`, head);
    const d = delta(before, after);
    assert.equal(d.refused, true, `${name}: added`);
    assert.equal(d.reason, reason, `${name}: reason`);
    assert.ok(d.reasons.every((r) => REASONS.includes(r)), `${name}: reasons are codes`);
    assert.ok(!JSON.stringify([d.reason, d.reasons]).match(/go\(|start|images\.example|more\.css|elsewhere/), `${name}: no file content in the reason`);
    // the file had it: an ordinary text edit elsewhere is accepted
    const edited = after.replace("First paragraph.", "First paragraph, edited.");
    assert.equal(delta(after, edited).refused, false, `${name}: present and unchanged`);
    assert.equal(delta(after, after).refused, false, `${name}: no change at all`);
  }
});

test("a changed script body, a flipped type attribute, a second copy of a script and a moved script are refused; a removed one is not", () => {
  const a = page('<script type="text/plain">one()</script>');
  assert.equal(delta(a, page('<script type="text/plain">two()</script>')).reason, "script", "edited body");
  assert.equal(delta(a, page('<script type="module">one()</script>')).reason, "script", "type flip");
  assert.equal(delta(a, page('<script type="text/plain">one()</script><script type="text/plain">one()</script>')).reason, "script", "one more");
  const moved = `<!doctype html><html><head><meta charset="utf-8"><title>T</title><script type="text/plain">one()</script></head><body><h1>Report</h1><p>First paragraph.</p></body></html>`;
  assert.equal(delta(a, moved).reason, "script", "the same script moved from the body to the head: a move of active content (029e51b)");
  // a script removed is no addition
  assert.equal(delta(a, page("")).refused, false);
  assert.equal(delta(a, page("")).removed.length, 1);
});

test("an SVG script or style is active too: its body edited is refused, and it counts as a script for template delimiters", () => {
  const a = page('<svg><script>one()</script><style>.a{fill:red}</style><circle r="1"/></svg><p>Hi</p>');
  assert.equal(delta(a, a.replace("one()", "two()")).reason, "script");
  assert.equal(delta(a, a.replace("fill:red", "fill:blue")).reason, "element");
  assert.equal(delta(a, a.replace("<p>Hi</p>", "<p>Hi {{ x }}</p>")).reason, "template");
  assert.equal(delta(a, a.replace("<p>Hi</p>", "<p>Hello</p>")).refused, false);
});

test("a changed link target (R1): to an allowed kind it is accepted and listed for History; to another kind it is refused", () => {
  const a = page('<p><a href="https://one.example/page">Link</a></p>');
  const ok = delta(a, page('<p><a href="https://two.example/page">Link</a></p>'));
  assert.equal(ok.refused, false);
  assert.deepEqual(ok.links, { added: [{ kind: "link", url: "https://two.example/page", urlKind: "https" }], removed: [{ kind: "link", url: "https://one.example/page", urlKind: "https" }] });
  for (const bad of ["javascript:go()", "//two.example/page", "data:text/html,x", "file:///etc/hosts"]) assert.equal(delta(a, page(`<p><a href="${bad}">Link</a></p>`)).reason, "link_url", bad);
  // a local image changed to a remote one
  assert.equal(delta(page('<img src="pics/a.png" alt="">'), page('<img src="https://images.example/a.png" alt="">')).reason, "load_url");
});

test("template delimiters in added text are refused only when the file loads a script", () => {
  const withScript = page('<script src="app.js"></script><p>Hi</p>');
  assert.equal(delta(withScript, withScript.replace("<p>Hi</p>", "<p>Hi {{ name }}</p>")).reason, "template");
  assert.equal(delta(withScript, withScript.replace("<p>Hi</p>", '<p title="${x}">Hi</p>')).reason, "template");
  const plain = page("<p>Hi</p>");
  assert.equal(delta(plain, plain.replace("<p>Hi</p>", "<p>Hi {{ name }}</p>")).refused, false);
});

test("accepted: plain text, allowlisted formatting, tables, lists, local and data images, and http(s), mailto and tel links", () => {
  const before = page("<p>Second.</p>");
  const rich = page(`<p>Second, <b>bold</b>, <i>it</i>, <em>em</em>, <strong>strong</strong>, <span class="note" style="color: #333; font-weight: bold">styled</span>, <code>x</code>, <sub>2</sub>.</p>
    <h2 id="results">Results</h2><blockquote>Quote</blockquote><hr>
    <table border="1"><thead><tr><th scope="col">A</th><th colspan="2">B</th></tr></thead><tbody><tr><td rowspan="2">1</td><td>2</td><td>3</td></tr></tbody></table>
    <ul><li>one</li><li>two</li></ul><ol start="3"><li value="3">three</li></ol><dl><dt>t</dt><dd>d</dd></dl>
    <img src="pics/chart.png" alt="Chart" width="300" height="200"><img src="data:image/png;base64,iVBORw0KGgo=" alt="">
    <p style="background: url(pics/bg.png)">bg</p>
    <p><a href="https://example.com/a">a</a> <a href="http://example.com/b">b</a> <a href="mailto:someone@example.com">mail</a> <a href="tel:+15550100">tel</a> <a href="#results">jump</a> <a href="other.html">rel</a></p>
    <p><font color="red" face="Arial">old</font><o:p></o:p></p>`, "<style>p { margin: 0; background: url('pics/p.png') }</style>");
  const d = delta(before, rich);
  assert.equal(d.refused, false, JSON.stringify(d.added.filter((e) => e.code)));
  assert.equal(d.links.added.length, 10); // six links, two images, and the url() of the style attribute and of the style element
});

test("urlKind: what a browser would read, not what the value looks like", () => {
  const cases = {
    "": "fragment", "#top": "fragment", "a/b.png": "relative", "../up.png": "relative", "/root.png": "relative", "?q=1": "relative",
    "https://example.com/": "https", "HTTP://example.com/": "http", "mailto:a@example.com": "mailto", "tel:+1555": "tel",
    "data:image/png;base64,AAAA": "data-image", "data:image/jpeg,x": "data-image", "data:image/svg+xml,<svg/>": "other", "data:text/html,x": "other",
    "//example.com/x.png": "other", "\\\\example.com\\x.png": "other", "java\tscript:x": "other", "javascript:x": "other", " JavaScript:x": "other",
    "a\nb.png": "other", "vbscript:x": "other", "file:///etc/hosts": "other", "blob:x": "other", "  a.png  ": "relative",
  };
  for (const [v, k] of Object.entries(cases)) assert.equal(urlKind(v), k, JSON.stringify(v));
});

test("the tables: elements by name and namespace, attributes globally and per element, CSS in its plain form", () => {
  for (const t of ["p", "table", "img", "a", "o:p", "font"]) assert.ok(elementAllowed(t), t);
  for (const t of ["script", "iframe", "form", "link", "base", "object", "embed", "template", "noscript", "video", "svg"]) assert.ok(!elementAllowed(t), t);
  assert.ok(!elementAllowed("a", "http://www.w3.org/2000/svg"), "an SVG a is not an HTML a");
  assert.ok(attributeAllowed("p", "class") && attributeAllowed("a", "href") && attributeAllowed("img", "src") && attributeAllowed("td", "colspan"));
  for (const [e, a] of [["p", "href"], ["p", "src"], ["a", "target"], ["a", "rel"], ["a", "download"], ["p", "onclick"], ["p", "data-x"], ["img", "srcset"], ["p", "type"], ["iframe", "srcdoc"], ["div", "hx-get"], ["div", "v-if"]]) assert.ok(!attributeAllowed(e, a), `${e} ${a}`);
  assert.deepEqual(cssPlain("margin: 0; background: url(a.png)"), { ok: true, loads: ["a.png"] });
  for (const c of ["background: url(https://x.example/a.png)", "@import 'a.css'", "background: image-set('a.png' 1x)", "b\\61 ckground: red", "width: expression(go())"]) assert.equal(cssPlain(c).ok, false, c);
  assert.match(ACTIVE_REFUSED, /^The agent tried to add code that runs in a browser, so nothing was written\.$/);
});

test("the inventory's entries are canonical: the same content in another order gives the same entries (its seq keeps the order)", () => {
  const a = inv(page('<p class="x" style="color:red" data-a="1" data-b="2">t</p><script>x</script>'));
  const b = inv(page('<script>x</script><p data-b="2" style="color:red" data-a="1" class="x">t</p>'));
  assert.deepEqual(a.entries, b.entries);
  assert.equal(a.scripted, true);
  assert.notDeepEqual(a.seq, b.seq, "active content in another order is another sequence");
  assert.deepEqual(inv(page('<p data-b="2" data-a="1">t</p>')).seq, inv(page('<p data-a="1" data-b="2">t</p>')).seq, "attribute order in one element does not count");
  // deep nesting is walked without recursion
  const deep = page(`${"<div>".repeat(5000)}<span onclick="x">t</span>${"</div>".repeat(5000)}`);
  assert.equal(inventoryDelta(inv(page("")), inv(deep)).reason, "event_handler");
});

test("active content is bound to its element (029e51b, html-active.js:282): a swap, a move or a copy is refused; edits around it are not", () => {
  const two = page('<p id="a" onclick="one()">A</p><p id="b" onclick="two()">B</p>');
  // the review's case: the two values swapped
  assert.equal(delta(two, two.replace('onclick="one()"', "@1").replace('onclick="two()"', 'onclick="one()"').replace("@1", 'onclick="two()"')).reason, "event_handler");
  // the same without ids, and the same values on other elements of another kind
  const bare = page('<p onclick="one()">A</p><p onclick="two()">B</p>');
  assert.equal(delta(bare, page('<p onclick="two()">A</p><p onclick="one()">B</p>')).reason, "event_handler");
  // moved: to an element with another id, into another element, onto another tag, or copied
  assert.equal(delta(page('<p id="a" onclick="x()">A</p><p id="b">B</p>'), page('<p id="a">A</p><p id="b" onclick="x()">B</p>')).reason, "event_handler");
  assert.equal(delta(page('<p onclick="x()">A</p><div><p>B</p></div>'), page('<p>A</p><div><p onclick="x()">B</p></div>')).reason, "event_handler");
  assert.equal(delta(page('<p onclick="x()">A</p><div>B</div>'), page('<p>A</p><div onclick="x()">B</div>')).reason, "event_handler");
  assert.equal(delta(page('<p onclick="x()">A</p>'), page('<p onclick="x()">A</p><p onclick="x()">A</p>')).reason, "event_handler");
  // a script, a frame and a form swapped in order: refused; a script moved into another element: refused
  assert.equal(delta(page('<script type="text/plain">a()</script><iframe src="x.html"></iframe>'), page('<iframe src="x.html"></iframe><script type="text/plain">a()</script>')).refused, true);
  assert.equal(delta(page('<div><script type="text/plain">a()</script></div><section></section>'), page('<div></div><section><script type="text/plain">a()</script></section>')).reason, "script");
  // a javascript: link moved to another link
  assert.equal(delta(page('<p><a id="x" href="javascript:a()">x</a> <a id="y" href="https://e.example/">y</a></p>'), page('<p><a id="x" href="https://e.example/">x</a> <a id="y" href="javascript:a()">y</a></p>')).refused, true);
  // accepted: the file as it is; text edited, in the owner too; allowlisted elements inserted or deleted before, between and after;
  // classes and styles changed on the owner; an active item removed
  for (const after of [
    two,
    two.replace(">A<", ">A, edited<").replace(">B<", ">Be<"),
    two.replace('<p id="a"', '<h2>New heading</h2><p>New paragraph</p><p id="a"'),
    two.replace('<p id="b"', '<ul><li>between</li></ul><p id="b"'),
    two.replace("<h1>Report</h1><p>First paragraph.</p>", ""),
    two.replace('<p id="a"', '<p class="lead" style="color: red" id="a"'),
    two.replace(' onclick="two()"', ""),
    `${two.replace("</body>", "<table><tr><td>x</td></tr></table></body>")}`,
  ]) {
    const d = delta(two, after);
    assert.equal(d.refused, false, `${after}: ${d.reasons}`);
  }
  // the stated limit (src/html-active.js inventoryDelta): moved to the next element of the same tag, place and id, with no other active
  // item between, is not seen (the same code runs, on a neighbor); it is pinned here so a change to it is a decision, not an accident
  assert.equal(delta(page('<p onclick="x()">A</p><p>B</p>'), page('<p>A</p><p onclick="x()">B</p>')).refused, false);
  // an ordinary file with active content nowhere near the edit
  const app = page('<div id="app"><button onclick="go()">Go</button></div><script src="app.js"></script><p>Body text.</p>');
  assert.equal(delta(app, app.replace("<p>Body text.</p>", "<p>Body text, longer.</p><p>Another.</p>")).refused, false);
  assert.equal(delta(app, app.replace("<p>Body text.</p>", "").replace('<div id="app">', '<p>Intro first.</p><div id="app">')).refused, false);
});

// The outside review of 4d2b2fc (html-active.js:368): an owner's id holding the character the positional keys were joined with broke the
// split that read the refusal code back, so a swap of two handlers was accepted. Owner, key and code are kept apart now; checked with ids
// holding every control character, the old separator, quotes and astral characters (as numeric references and as they are).
test("handlers swapped between owners whose ids hold control, quote or astral characters are refused, whatever the id holds", () => {
  const ids = [];
  for (let c = 0; c <= 0x1f; c++) ids.push(`&#${c};`);
  ids.push("\u0001", "&#x1;", '&quot;', "'", "&#39;", "\u{1F600}", "&#x1F600;", "\u{10FFFD}", "a\u0001b\u0001c", "&#1;&#1;&#1;", "x&#0;y");
  for (const mid of ids) {
    const before = page(`<p id="a${mid}x" onclick="one()">A</p><p id="b${mid}x" onclick="two()">B</p>`);
    const swapped = page(`<p id="a${mid}x" onclick="two()">A</p><p id="b${mid}x" onclick="one()">B</p>`);
    const d = delta(before, swapped);
    assert.equal(d.refused, true, `id with ${JSON.stringify(mid)}: the swap is refused`);
    assert.equal(d.reason, "event_handler", JSON.stringify(mid));
    assert.equal(delta(before, before).refused, false, `id with ${JSON.stringify(mid)}: the file as it is passes`);
    assert.equal(delta(before, before.replace(">A<", ">A, edited<")).refused, false, `id with ${JSON.stringify(mid)}: a text edit passes`);
    // wrapping an owner in a new element is a move: refused too
    assert.equal(delta(before, before.replace(`<p id="b${mid}x"`, `<div><p id="b${mid}x"`).replace(">B</p>", ">B</p></div>")).refused, true, JSON.stringify(mid));
  }
  // an attribute value that holds the old separator does not give the element's entry the key of two attributes (no joined keys either)
  const elKey = (html) => inv(html).entries.find((e) => e.kind === "element" && e.key.includes("script")).key;
  assert.notEqual(elKey(page('<script type="text/plain" a="1" b="2">x</script>')), elKey(page('<script type="text/plain" a="1&#1;b=2">x</script>')));
});
