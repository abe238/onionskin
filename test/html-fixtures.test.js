// The real-file subset of spike S2's corpus (test/fixtures/html, generated files only, see its manifest.json): every file is as the
// manifest says (size and sha256), opens or is refused with the expected reason, has every visible text node addressable (R8) but the
// foster-parented text merged across a table, and gives an outline and anchors with no script or style body in them (R7).
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import "../src/html-parser.js";
import { parse } from "../vendor/parse5/parse5.mjs";
import * as H from "../src/html.js";
import { outlineOf } from "../src/review.js";
import { scanBudget } from "../src/text.js";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "html");
const { files } = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
const REFUSED = { "edge-invalid-utf8.html": "invalid_utf8", "edge-latin1-declared.html": "not_utf8", "edge-shiftjis-declared.html": "not_utf8", "edge-utf16-bom.html": "utf16", "word-save-as-web-page.htm": "not_utf8" };
const COPYABLE = new Set(["edge-latin1-declared.html", "word-save-as-web-page.htm"]);
const NOT_ADDRESSABLE = { "edge-combined.html": 1, "edge-foster-parenting.html": 1 }; // text merged around a table (S2, E2)

test("the fixtures are what the manifest says, and under 2 MB in all", () => {
  let total = 0;
  for (const f of files) {
    const b = fs.readFileSync(path.join(dir, f.file));
    assert.equal(b.length, f.bytes, f.file);
    assert.equal(crypto.createHash("sha256").update(b).digest("hex"), f.sha256, f.file);
    total += b.length;
  }
  assert.ok(total < 2 * 1024 * 1024, `${total} bytes`);
  assert.ok(files.length >= 50);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n !== "manifest.json").sort(), files.map((f) => f.file).sort(), "every file is in the manifest");
});

test("every fixture opens or is refused with its reason; visible text is addressable but for the foster-parented cases", () => {
  let opened = 0;
  for (const f of files) {
    const b = fs.readFileSync(path.join(dir, f.file));
    if (REFUSED[f.file]) {
      assert.throws(() => H.readHtml(b), (e) => e instanceof H.HtmlEncodingError && e.code === REFUSED[f.file] && e.copyable === COPYABLE.has(f.file), f.file);
      continue;
    }
    const r = H.readHtml(b);
    opened++;
    // the counting tree adapter builds the tree the default one builds
    assert.ok(H.deepEqual(parse(r.text, { scriptingEnabled: true }), r.doc), `${f.file}: the same tree as parse5's own adapter`);
    const visible = r.nodes.filter((x) => x.nodeName === "#text" && /\S/.test(x.value) && !x.__hidden && H.textContext(x) !== "raw");
    assert.equal(visible.filter((x) => x.__ok !== true).length, NOT_ADDRESSABLE[f.file] || 0, f.file);
    // R7: no script or style body reaches the outline or an anchor
    const bodies = r.nodes.filter((x) => x.nodeName === "#text" && x.__ctx && ["script", "style"].includes(x.__ctx.tagName) && x.value.trim().length >= 12).map((x) => x.value.trim().slice(0, 40));
    const { outline } = outlineOf("html", null, 2000, { format: "html", read: r });
    const anchors = scanBudget(40_000_000, () => r.units.slice(0, 300).map((u) => H.htmlDurable(r, { location: { nodeId: u.nodeId }, quote: "" })));
    const seen = JSON.stringify([outline, anchors]);
    for (const body of bodies) assert.ok(!seen.includes(JSON.stringify(body).slice(1, -1)), `${f.file}: a script or style body is in the outline or an anchor`);
  }
  assert.equal(opened, files.length - Object.keys(REFUSED).length);
});
