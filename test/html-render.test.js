// src/html-render.js: the render copy (PLAN-html 3.2, R2 to R5, R16, R20, R21). Ordinary HTML features as inputs, no attack lists: the
// copy is written from an allowlist, so what matters is that nothing outside it survives, checked structurally on every fixture and on
// generated pages; that every element and text node maps back to its source node; and the asset, CSS and fallback rules.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import "../src/html-parser.js";
import * as H from "../src/html.js";
import { ASSET_CODES, PLACEHOLDER_LABELS, plainCopy, renderCopy, resolveRef, sniffImage } from "../src/html-render.js";
import { assertInert, genPage, gifHeader, jpegHeader, memReader, pngHeader, webpHeader } from "./helpers/html-render-check.js";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "html");
const { files } = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
const REFUSED = new Set(["edge-invalid-utf8.html", "edge-latin1-declared.html", "edge-shiftjis-declared.html", "edge-utf16-bom.html", "word-save-as-web-page.htm"]);
const FAKE_DIR = "/onionskin-test/not-a-real-folder";
const PNG = pngHeader(4, 3);
const render = (html, files = {}, opts = {}) => renderCopy(H.readHtml(Buffer.from(html)), { fileDir: FAKE_DIR, readAsset: memReader(files), ...opts });
const body = (r) => /<body[^>]*>([\s\S]*)<\/body>/.exec(r.bytes.toString())[1];

/** Every copy element with a data-osk-id is its source element (or a fixed stand-in for it), and text node n is texts[n]. */
function assertMapsBack(read, r, label) {
  const { elements, texts } = assertInert(r.bytes, label);
  const STANDS = { form: ["div"], xmp: ["pre"], plaintext: ["pre"], listing: ["pre"], dir: ["ul"], link: ["style"], img: ["span"], video: ["span"], audio: ["span"], canvas: ["span"], input: ["span"] };
  let mapped = 0;
  for (const el of elements) {
    const id = el.attrs.find((a) => a.name === "data-osk-id")?.value;
    if (id === undefined) continue;
    const src = read.nodes[Number(id)];
    assert.ok(src && src.tagName !== undefined, `${label}: data-osk-id ${id} is a located element`);
    const placeholder = el.attrs.some((a) => a.name === "data-osk-placeholder");
    const ok = src.tagName === el.tagName || STANDS[src.tagName]?.includes(el.tagName) || (el.tagName === "span" && (placeholder || src.namespaceURI !== H.HTML_NS || !/^(?:p|div|table|td|tr|li|ul|ol|h[1-6]|pre|b|i|a|img|style|title|body|html|head)$/.test(src.tagName)));
    assert.ok(ok, `${label}: copy <${el.tagName}> for source <${src.tagName}>`);
    mapped++;
  }
  assert.equal(texts.length, r.texts.length, `${label}: one texts entry per text node`);
  texts.forEach((t, i) => {
    const id = r.texts[i];
    if (id >= 0) assert.equal(t.value, read.nodes[id].value, `${label}: text node ${i} is source node ${id}`);
  });
  return mapped;
}

test("every fixture renders; the copy holds nothing outside the display set, and maps back to the source", () => {
  let rendered = 0;
  for (const f of files) {
    if (REFUSED.has(f.file)) continue;
    const read = H.readHtml(fs.readFileSync(path.join(dir, f.file)));
    const r = renderCopy(read, { fileDir: FAKE_DIR, readAsset: memReader({}) });
    assert.ok(!r.plain, `${f.file} went plain: ${r.reason}`);
    assertMapsBack(read, r, f.file);
    // the plain view of the same reading passes the same check
    assertInert(plainCopy(read).bytes, `${f.file} (plain)`);
    rendered++;
  }
  assert.equal(rendered, files.length - REFUSED.size);
  assert.ok(rendered >= 50);
});

test("generated pages of ordinary features: nothing outside the display set survives, ids and texts map back, same bytes twice", () => {
  let plain = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const page = genPage(seed);
    const read = H.readHtml(Buffer.from(page));
    const files = { "img/local.png": PNG, "css/site.css": Buffer.from("p { margin: 1px; background: url(../img/local.png) }") };
    const r = renderCopy(read, { fileDir: FAKE_DIR, readAsset: memReader(files) });
    if (r.plain) {
      plain++;
      assertInert(plainCopy(read).bytes, `seed ${seed} (plain)`);
      continue;
    }
    assertMapsBack(read, r, `seed ${seed}`);
    const again = renderCopy(H.readHtml(Buffer.from(page)), { fileDir: FAKE_DIR, readAsset: memReader(files) });
    assert.ok(again.bytes.equals(r.bytes), `seed ${seed}: same input, same bytes`);
  }
  assert.equal(plain, 0, `${plain} of 300 generated pages went plain (each is a serializer bug to name)`);
});

test("positive control: the structural check catches what it is there for", () => {
  const good = render("<p>x</p>").bytes.toString();
  const bad = [
    good.replace("<p", '<p onclick="x()"'),
    good.replace("<p", '<a href="#x"></a><p'),
    good.replace("<p", "<form></form><p"),
    good.replace("<p", "<script></script><p"),
    good.replace("<p", "<link rel=preconnect><p"),
    good.replace("<p", '<p data-osk-other="1"'),
    good.replace("<p", '<img src="https://example.invalid/a.png"><p'),
    good.replace("<p", '<p style="background:url(a.png)"'),
    good.replace("<p", '<p target="_top"'),
    good.replace("<p", "<svg></svg><p"),
    good.replace('content="default-src', 'content="default-src *;'),
    good.replace("<p", '<meta http-equiv="refresh" content="0"><p'),
  ];
  assertInert(good);
  for (const b of bad) assert.throws(() => assertInert(b), assert.AssertionError, b.slice(0, 300));
});

test("ordinary features: scripts and handlers left out and counted, links kept for display only, forms inert, frames gone", () => {
  const r = render(`<!doctype html><title>T</title><body onload="init()">
<script>alert(1)</script><button onclick="go()">Go</button>
<p>Read <a href="https://example.invalid/more" target="_blank" name="m">more</a> or <a href="#top">top</a> or <a href="javascript:void(0)">js</a>.</p>
<form action="https://example.invalid/s" method="post"><label>Name <input name="n" type="text" value="v"></label><input type="checkbox" checked><select name="s"><option>One</option></select><textarea name="t">Hi</textarea><button type="submit" formaction="https://example.invalid/x">Send</button></form>
<iframe src="https://example.invalid/f"><p>inside</p></iframe><object data="o.bin"><p>fallback</p></object><embed src="e.swf">
<noscript><p>enable scripts</p></noscript><template><p>later</p></template>`);
  assert.ok(!r.plain);
  const s = body(r);
  assert.ok(!/alert|enable scripts|later|inside|fallback/.test(s), s);
  assert.match(s, /<a data-osk-id="\d+" data-osk-href="https:\/\/example\.invalid\/more">more<\/a>/);
  assert.match(s, /<a data-osk-id="\d+" data-osk-href="#top">top<\/a>/);
  assert.match(s, /<a data-osk-id="\d+">js<\/a>/, "a javascript: target is not kept even for display");
  assert.match(s, /<div data-osk-id="\d+"><label/, "the form is a div");
  assert.match(s, /<input data-osk-id="\d+" type="text" value="v" disabled="">/);
  assert.match(s, /<input data-osk-id="\d+" type="checkbox" checked="" disabled="">/);
  assert.match(s, /<textarea data-osk-id="\d+" disabled="">Hi<\/textarea>/);
  assert.match(s, /<button data-osk-id="\d+" disabled="">Send<\/button>/);
  const st = r.stats;
  assert.equal(st.scripts, 1);
  assert.equal(st.handlers, 2);
  assert.equal(st.links, 2);
  assert.equal(st.forms, 1);
  assert.equal(st.controls, 6);
  assert.equal(st.frames, 3);
  assert.equal(st.noscript, 1);
  assert.equal(st.templates, 1);
  assert.ok(st.bodyText > 0);
  assertInert(r.bytes);
});

test("a form directly in a table is left out (a div there would be moved by the parser); its rows stay", () => {
  const r = render("<table><form><tr><td>cell</td></tr></form></table>");
  assert.ok(!r.plain, r.reason);
  assert.match(body(r), /<td data-osk-id="\d+">cell<\/td>/);
  assert.equal(r.stats.forms, 1);
});

test("images: data: images are checked and kept, local ones inlined by their bytes' type, the rest are placeholders", () => {
  const gif = gifHeader(2, 2);
  const r = render(
    `<img src="data:image/png;base64,${PNG.toString("base64")}" alt="a">
<img src="pics/photo.png" alt="b"><img src="pics/photo.png" alt="again">
<img src="https://example.invalid/r.png"><img src="//example.invalid/r.png"><img src="file:///etc/passwd">
<img src="data:image/svg+xml,%3Csvg%3E%3C/svg%3E"><img src="lies.png"><img src="huge.png"><img src="none.png">
<img src="../up.png"><img src="/abs.png"><img src="a/b/c/d/deep.png"><img src=".hidden/x.png"><img src="Library/x.png"><img src="ok.jpg"><img src="ok.webp">`,
    { "pics/photo.png": PNG, "lies.png": gif, "huge.png": pngHeader(60_000, 60_000), "a/b/c/d/deep.png": PNG, ".hidden/x.png": PNG, "Library/x.png": PNG, "ok.jpg": jpegHeader(10, 20), "ok.webp": webpHeader(5, 6) },
  );
  assert.ok(!r.plain, r.reason);
  const s = body(r);
  const srcs = [...s.matchAll(/src="(data:[^;]+);base64,/g)].map((m) => m[1]);
  assert.deepEqual(srcs, ["data:image/png", "data:image/png", "data:image/png", "data:image/gif", "data:image/jpeg", "data:image/webp"]);
  assert.equal((s.match(/data-osk-placeholder="image"/g) || []).length, 11);
  assert.ok(s.includes(PLACEHOLDER_LABELS.image));
  assert.equal(r.stats.assets.shown, 6);
  assert.equal(r.stats.remote, 3);
  assert.deepEqual(r.stats.assets.refused, { type: 1, dimensions: 1, not_found: 1, outside: 1, absolute: 1, too_deep: 1, hidden: 1, library: 1 });
  for (const k of Object.keys(r.stats.assets.refused)) assert.ok(ASSET_CODES.includes(k), k);
  assertInert(r.bytes);
});

test("asset caps: one image over 10 MB, more than 500 shown, more than 30 MB in all (as base64, as the copy holds them)", () => {
  const big = Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)]);
  const seven = Buffer.concat([PNG, Buffer.alloc(7 * 1024 * 1024)]); // 9.3 MB as base64: three fit in 30 MB
  let r = render(`<img src="big.png">`, { "big.png": big });
  assert.deepEqual(r.stats.assets.refused, { too_large: 1 });
  r = render(`${'<img src="n.png">'.repeat(4)}`, { "n.png": seven });
  assert.equal(r.stats.assets.shown, 3);
  assert.deepEqual(r.stats.assets.refused, { over_total: 1 });
  r = render(`${'<img src="t.png">'.repeat(501)}`, { "t.png": PNG });
  assert.equal(r.stats.assets.shown, 500);
  assert.deepEqual(r.stats.assets.refused, { over_count: 1 });
});

test("the home folder or a volume root as the file's folder: no local asset at all", () => {
  for (const fileDir of [process.env.HOME, "/", "/Volumes/Disk"]) {
    const r = renderCopy(H.readHtml(Buffer.from('<img src="a.png"><p style="background:url(a.png)">x</p>')), { fileDir, readAsset: memReader({ "a.png": PNG }) });
    assert.equal(r.stats.folder, "home_or_root", fileDir);
    assert.equal(r.stats.assets.shown, 0);
    assert.equal(r.stats.assets.refused.folder, 2);
  }
});

test("resolveRef: relative paths below the folder only", () => {
  assert.deepEqual(resolveRef("a/./b/../c.png"), { ok: true, segs: ["a", "c.png"] });
  assert.deepEqual(resolveRef("../img/x.png", ["css"]), { ok: true, segs: ["img", "x.png"] });
  assert.deepEqual(resolveRef("my%20pic.png?v=2#x"), { ok: true, segs: ["my pic.png"] });
  for (const [ref, code] of [["../x.png", "outside"], ["a/../../x.png", "outside"], ["/x.png", "absolute"], ["a%2fb.png", "bad_url"], ["a%5cb.png", "bad_url"], ["%E0%A4%A.png", "bad_url"], ["a:b.png", "bad_url"], ["a/b/c/d/x.png", "too_deep"], [".git/x.png", "hidden"], [".x.png", "hidden"], ["LIBRARY/x.png", "library"], ["dir/", "bad_url"], ["", "bad_url"]]) {
    assert.equal(resolveRef(ref).code, code, ref);
  }
  assert.equal(resolveRef("a/b/c/x.png").ok, true, "three folders down is allowed");
});

test("sniffImage: by bytes, PNG, JPEG, GIF, WebP only, dimensions capped", () => {
  assert.deepEqual(sniffImage(PNG), { ok: true, mime: "image/png", width: 4, height: 3 });
  assert.deepEqual(sniffImage(jpegHeader(640, 480)), { ok: true, mime: "image/jpeg", width: 640, height: 480 });
  assert.deepEqual(sniffImage(gifHeader(16000, 4000)), { ok: true, mime: "image/gif", width: 16000, height: 4000 });
  assert.deepEqual(sniffImage(webpHeader(300, 200)), { ok: true, mime: "image/webp", width: 300, height: 200 });
  assert.equal(sniffImage(gifHeader(16001, 1)).code, "dimensions");
  assert.equal(sniffImage(pngHeader(10000, 7000)).code, "dimensions", "70 million pixels");
  assert.equal(sniffImage(pngHeader(0, 5)).code, "dimensions");
  assert.equal(sniffImage(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>")).code, "type");
  assert.equal(sniffImage(Buffer.from("BM........................")).code, "type");
  assert.equal(sniffImage(Buffer.alloc(0)).code, "type");
  assert.equal(sniffImage(jpegHeader(10, 10).subarray(0, 12)).code, "type", "a cut JPEG");
});

test("CSS: style attributes and elements kept when plain, url() inlined or removed, local stylesheets and imports inlined", () => {
  const files = {
    "css/site.css": Buffer.from('@import "parts/a.css";\nh1 { margin: 2px; background: url(../img/bg.png) }'),
    "css/parts/a.css": Buffer.from("@import url(b.css) print;\n.a { margin: 0; background: url(https://example.invalid/x.png) }"),
    "css/parts/b.css": Buffer.from(".b { color: red }"),
    "img/bg.png": PNG,
  };
  const r = render(
    `<head><link rel="stylesheet" href="css/site.css"><link rel="stylesheet" href="https://example.invalid/r.css"><link rel="alternate stylesheet" href="css/site.css">
<link rel="stylesheet" href="data:text/css,p%7Bmargin:3px%7D"><style>@import url(https://example.invalid/i.css); p { margin: 4px }</style><style>p::before{content:"\\201C"}</style></head>
<h1 style="font-weight: bold; background: url('img/bg.png')">T</h1><p style="background:url(https://example.invalid/b.png) no-repeat">p</p><p style="font: 12px x; behavior: url(x.htc)">q</p>`,
    files,
  );
  assert.ok(!r.plain, r.reason);
  const s = r.bytes.toString();
  // site.css with a.css in place of its import, and b.css in place of a.css's (for print); each url() against its own sheet's folder
  assert.match(s, /<style data-osk-id="\d+">@media print\{\.b \{ color: red \}\}\n\.a \{ margin: 0; background: none \}\nh1 \{ margin: 2px; background: url\("data:image\/png;base64,/);
  assert.match(s, /<style data-osk-id="\d+">p\{margin:3px\}<\/style>/, "a data: stylesheet");
  assert.match(s, /<style data-osk-id="\d+"> p \{ margin: 4px \}<\/style>/, "a remote @import is removed");
  assert.ok(!s.includes("201C"), "a stylesheet with a backslash is left out");
  assert.match(s, /<h1 data-osk-id="\d+" style="font-weight: bold; background: url\(&quot;data:image\/png;base64,/);
  assert.match(s, /<p data-osk-id="\d+" style="background:none no-repeat">p<\/p>/);
  assert.match(s, /<p data-osk-id="\d+">q<\/p>/, "a style attribute that is not plain is left out");
  assert.equal(r.stats.styles.left.not_plain, 2);
  assert.equal(r.stats.remote, 4, "the remote link, the remote import, two remote url()");
  assert.equal(r.stats.styles.heavy, null);
  assertInert(r.bytes);
});

test("CSS imports: at most 5 levels, never the same file twice, a relative url() in a data: sheet is not resolved", () => {
  const files = {};
  for (let i = 0; i < 8; i++) files[`s${i}.css`] = Buffer.from(`@import "s${i + 1}.css"; .l${i} { color: red }`);
  files["loop.css"] = Buffer.from('@import "loop.css"; .loop { color: red }');
  let r = render('<link rel="stylesheet" href="s0.css"><p>x</p>', files);
  const s = r.bytes.toString();
  for (let i = 0; i <= 5; i++) assert.ok(s.includes(`.l${i} `), `level ${i}`);
  assert.ok(!s.includes(".l6 "));
  assert.equal(r.stats.styles.left.import_depth, 1);
  r = render('<link rel="stylesheet" href="loop.css"><link rel="stylesheet" href="loop.css"><p>x</p>', files);
  assert.equal((r.bytes.toString().match(/\.loop/g) || []).length, 1);
  assert.equal(r.stats.assets.refused.repeat, 2);
  r = render(`<link rel="stylesheet" href="data:text/css,p%7Bbackground:url(a.png)%7D"><p>x</p>`, { "a.png": PNG });
  assert.match(r.bytes.toString(), /p\{background:none\}/);
  assert.equal(r.stats.assets.refused.bad_url, 1);
});

test("CSS caps: over 2 MB, 20,000 rules or 200 :has( leaves out every style of the page, attributes included", () => {
  const cases = [
    ["css_bytes", `<style>p { color: red; } /*${"x".repeat(2 * 1024 * 1024)}*/</style>`],
    ["css_rules", `<style>${".a{}".repeat(20_001)}</style>`],
    ["css_has", `<style>${"p:has(b){}".repeat(201)}</style>`],
  ];
  for (const [code, sheet] of cases) {
    const r = render(`<head>${sheet}</head><p style="color: red">x</p>`);
    assert.equal(r.stats.styles.heavy, code);
    assert.ok(!/<style/.test(r.bytes.toString()), code);
    assert.ok(!/style=/.test(body(r)), `${code}: style attributes too`);
  }
  const ok = render(`<style>${".a{}".repeat(19_999)}${"p:has(b){}".repeat(1)}</style><p style="color:red">x</p>`);
  assert.equal(ok.stats.styles.heavy, null);
  assert.match(body(ok), /style="color:red"/);
});

test("SVG and MathML: left out with their content, a placeholder carrying the root's id, counted", () => {
  const read = H.readHtml(Buffer.from('<p>a <svg viewBox="0 0 1 1"><circle r="1"/><text>in svg</text></svg> b <math><mi>x</mi></math></p>'));
  const r = renderCopy(read, { fileDir: FAKE_DIR, readAsset: memReader({}) });
  const s = body(r);
  assert.ok(!/in svg|<mi|<circle/.test(s));
  const ids = [...s.matchAll(/<span data-osk-id="(\d+)" data-osk-placeholder="graphic"/g)].map((m) => read.nodes[Number(m[1])].tagName);
  assert.deepEqual(ids, ["svg", "math"]);
  assert.equal(r.stats.foreign, 2);
});

test("text around something left out stays two text nodes; pre and textarea keep a leading newline; raw text is shown as text", () => {
  const read = H.readHtml(Buffer.from("<p>one<script>x</script>two<!-- c -->three</p><pre>\n\nkeep</pre><textarea>\n\nt</textarea><xmp><b>&amp;</b></xmp>"));
  const r = renderCopy(read, { fileDir: FAKE_DIR, readAsset: memReader({}) });
  assert.ok(!r.plain, r.reason);
  const s = body(r);
  assert.match(s, /one<!---->two<!---->three/);
  assert.match(s, /<pre data-osk-id="\d+">\n\nkeep<\/pre>/);
  assert.match(s, /<pre data-osk-id="\d+">&lt;b&gt;&amp;amp;&lt;\/b&gt;<\/pre>/);
  assertMapsBack(read, r, "texts");
});

test("incoming data-osk-* and name are stripped; an unknown element is shown as a span with its content", () => {
  const r = render('<div data-osk-id="5" data-osk-href="x" name="n" id="keep" class="c">a<x-card data-x="1"><b>b</b></x-card><dialog open>d</dialog></div>');
  const s = body(r);
  assert.match(s, /^<div data-osk-id="\d+" id="keep" class="c">a<span data-osk-id="\d+"><b data-osk-id="\d+">b<\/b><\/span><span data-osk-id="\d+">d<\/span><\/div>$/);
  assert.equal((s.match(/data-osk-id="5"/g) || []).length <= 1, true);
});

test("R2: a copy whose re-parse differs from the tree it was written from goes to the plain view", () => {
  const read = H.readHtml(Buffer.from("<h1>Title</h1><table><tr><td>cell</td></tr></table><p>after the <b>table</b></p>"));
  // a tree no parser makes: a paragraph straight inside the table (a parse moves it out, before the table)
  const table = read.doc.childNodes[0].childNodes[1].childNodes.find((n) => n.tagName === "table");
  const p = read.doc.childNodes[0].childNodes[1].childNodes.find((n) => n.tagName === "p");
  table.childNodes.unshift(p);
  const r = renderCopy(read, { fileDir: FAKE_DIR, readAsset: memReader({}) });
  assert.deepEqual(r, { plain: true, reason: "reparse" });
  const plain = plainCopy(read);
  const { elements } = assertInert(plain.bytes, "plain");
  const s = plain.bytes.toString();
  assert.match(s, /<h1 data-osk-id="\d+">Title<\/h1>/);
  assert.match(s, /<p data-osk-id="\d+">after the table<\/p>/);
  assert.ok(!/<table/.test(s));
  for (const el of elements) {
    const id = el.attrs.find((a) => a.name === "data-osk-id")?.value;
    if (id !== undefined) assert.equal(read.nodes[Number(id)].tagName, el.tagName === "p" ? read.nodes[Number(id)].tagName : el.tagName);
  }
  assert.ok(plain.stats.units >= 3);
});

test("a page built by scripts: bodyText 0 (R16's message); a frameset page gets an empty body", () => {
  assert.equal(render('<div id="root"></div><script src="app.js"></script>').stats.bodyText, 0);
  assert.equal(render('<div id="root"><img src="https://example.invalid/logo.png"></div>').stats.bodyText, 0, "a placeholder's label is not the page's text");
  const r = render("<frameset><frame src=a.html></frameset>");
  assert.ok(!r.plain, r.reason);
  assert.match(r.bytes.toString(), /<\/head><body><\/body><\/html>$/);
  assert.equal(r.stats.frames, 1);
});

test("reads are bounded by the caps before they happen: thousands of large local files read at most 30 MB of images and 2 MB of CSS", () => {
  const nine = Buffer.concat([PNG, Buffer.alloc(9 * 1024 * 1024)]);
  const font = Buffer.alloc(9 * 1024 * 1024, 1);
  const sheet = Buffer.from(`p { color: red }${" ".repeat(10)}`.repeat(40_000)); // about 1 MB
  let calls = 0;
  let bytes = 0;
  const counting = (segs, opts) => {
    const k = segs.join("/");
    const b = k.startsWith("img/") ? nine : k.startsWith("font/") ? font : k.startsWith("css/") ? sheet : null;
    if (!b) return { ok: false, code: "not_found" };
    if (b.length > opts.max) return { ok: false, code: "too_large" }; // as the real reader: refused by its size, never read
    calls++;
    bytes += b.length;
    return { ok: true, bytes: b, key: k };
  };
  const reset = () => ((calls = 0), (bytes = 0));
  const many = (f) => Array.from({ length: 2000 }, (_, i) => f(i)).join("");
  let r = render(many((i) => `<img src="img/p${i}.png">`), {}, { readAsset: counting });
  assert.ok(calls <= 4 && bytes <= 30 * 1024 * 1024, `${calls} reads, ${bytes} bytes`);
  assert.equal(r.stats.assets.shown, 2, "two 9 MB images fit in 30 MB as base64");
  reset();
  r = render(`<p style="x">${many((i) => `<span style="background:url(font/f${i}.woff)">x</span>`)}</p>`, {}, { readAsset: counting });
  assert.ok(bytes <= 30 * 1024 * 1024, `${calls} reads, ${bytes} bytes of files that are not images`);
  assert.equal(r.stats.assets.shown, 0);
  reset();
  r = render(`<head>${many((i) => `<link rel="stylesheet" href="css/s${i}.css">`)}</head><p>x</p>`, {}, { readAsset: counting });
  assert.ok(bytes <= 2 * 1024 * 1024, `${calls} reads, ${bytes} bytes of CSS`);
  assert.equal(r.stats.styles.heavy, "css_bytes");
  reset();
  r = render(`<head>${many(() => '<link rel="stylesheet" href="css/same.css">')}</head><p>x</p>`, {}, { readAsset: counting });
  assert.equal(calls, 1, "one sheet named 2,000 times is read once");
  assert.equal(r.stats.assets.refused.repeat, 1999);
});

test("a long run of whitespace in a URL or in CSS costs no more than any other text", () => {
  const sp = " ".repeat(500_000);
  for (const html of [`<p style="background: url(${sp}x y)">x</p>`, `<style>@import ${sp}x;</style><p>x</p>`, `<style>@import url(a.css)${sp}{</style><p>x</p>`, `<style>p{background:url(${sp}x y)}</style><p>x</p>`, `<img src="${sp}x y">`, `<a href="x${sp}y">x</a>`, `<link rel=stylesheet href="x${sp}y"><p>x</p>`]) {
    const read = H.readHtml(Buffer.from(html));
    const c0 = process.cpuUsage();
    const r = renderCopy(read, { fileDir: FAKE_DIR, readAsset: memReader({}) });
    const c = process.cpuUsage(c0);
    assert.ok((c.user + c.system) / 1000 < 1500, `${html.slice(0, 40)}: ${Math.round((c.user + c.system) / 1000)} ms`);
    assertInert(r.bytes);
  }
});

test("a quirks-mode page with a table inside a paragraph goes plain: the copy is always no-quirks, as a srcdoc frame is", () => {
  assert.deepEqual(render("<p>a<table><tr><td>x</td></tr></table>"), { plain: true, reason: "reparse" });
  assert.ok(!render("<!doctype html><p>a<table><tr><td>x</td></tr></table>").plain);
});

test("the parts the person may type in are editable in the copy itself: the outermost element over editable text, islands inside, a big one left to the click", () => {
  const body = (html) => render(`<!doctype html><html><head><title>t</title></head><body>${html}</body></html>`, {}, { editable: true }).bytes.toString("utf8").replace(/^[\s\S]*<body[^>]*>|<\/body>[\s\S]*$/g, "");
  const out = body('<p>Read <a href="https://example.invalid/">more</a> <b>bold</b> <img src="https://example.invalid/x.png" alt="x"></p><div>Outer <p>inner</p></div><ul><li>one</li></ul><a href="#x">link alone</a>');
  // the paragraph is the part; its link and the image placeholder are islands; <b> is part of it, not a part of its own
  assert.match(out, /^<p data-osk-id="\d+" contenteditable="plaintext-only">Read <a [^>]*data-osk-href="https:\/\/example\.invalid\/" contenteditable="false">more<\/a> <b data-osk-id="\d+">bold<\/b> <span [^>]*data-osk-placeholder="image"[^>]* contenteditable="false">/);
  // a div with text of its own holds its paragraph: one part, the outer one
  assert.match(out, /<div data-osk-id="\d+" contenteditable="plaintext-only">Outer <p data-osk-id="\d+">inner<\/p><\/div>/);
  assert.match(out, /<li data-osk-id="\d+" contenteditable="plaintext-only">one<\/li>/);
  // a link outside any part is not an island (nothing editable there) and never editable
  assert.match(out, /<a data-osk-id="\d+" data-osk-href="#x">link alone<\/a>/);
  // an element whose subtree is over EDIT_HOST_MAX nodes is not marked; the elements inside it with text are
  const many = Array.from({ length: H.EDIT_HOST_MAX }, (_, i) => `<span>s${i}</span>`).join("");
  const big = body(`<div>Big text ${many}</div><p>small</p>`);
  assert.match(big, /^<div data-osk-id="\d+">Big text <span data-osk-id="\d+" contenteditable="plaintext-only">s0<\/span>/);
  assert.match(big, /<p data-osk-id="\d+" contenteditable="plaintext-only">small<\/p>$/);
  // incoming contenteditable attributes are never kept: only the server's own marks
  assert.doesNotMatch(body('<p contenteditable="true">x</p><div contenteditable>y <a href="#">z</a></div>'.replace("<p", "<section")), /contenteditable="true"|contenteditable=""/);
  // without `editable` (the default) nothing is marked
  assert.doesNotMatch(render("<p>x</p>").bytes.toString(), /contenteditable/);
});
