// The checks every agent replacement of a Markdown file passes (src/markdown-file.js checkOne, applyAll, rebuild), and the apply driver
// that runs them (src/ops/markdown.js through src/ops/run.js): one base, exact old text, ends on character and run boundaries, all at
// once, overlaps refused whole (also with --partial). Pure: no files, no server.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";
import { checkOne, markdownEvidence, readMarkdownFile, rebuild } from "../src/markdown-file.js";
import { runOps } from "../src/ops/run.js";
import fs from "node:fs";
import { compareBytes } from "../src/history.js";
import { changedRegions } from "../src/anchors.js";
import { validate } from "./helpers/schema-lite.js";

const B = (s) => Buffer.from(s, "utf8");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const op = (bytes, from, to, source, text) => ({ op: "replace_source", target: { from, to }, expect: { sha256: sha(bytes), source }, text });

test("checkOne: the base, the range, the boundaries and the exact old text, each refused with its code", () => {
  const bytes = B("Tom &amp; Jerry\r\nnext \\* line 😀\r\n");
  const f = readMarkdownFile(bytes);
  const t = f.tree.text;
  const amp = t.indexOf("&amp;");
  assert.equal(checkOne(f, op(bytes, amp, amp + 5, "&amp;", "and")).ok, true, "the whole entity");
  assert.equal(checkOne(f, op(bytes, amp + 1, amp + 5, "amp;", "x")).code, "not_a_boundary", "inside an entity");
  const cr = t.indexOf("\r\n");
  assert.equal(checkOne(f, op(bytes, cr + 1, cr + 2, "\n", "")).code, "not_a_boundary", "between CR and LF");
  const esc = t.indexOf("\\*");
  assert.equal(checkOne(f, op(bytes, esc + 1, esc + 2, "*", "#")).code, "not_a_boundary", "inside an escape");
  const emo = t.indexOf("😀");
  assert.equal(checkOne(f, op(bytes, emo + 1, emo + 2, t.slice(emo + 1, emo + 2), "x")).code, "not_a_boundary", "inside a surrogate pair");
  assert.equal(checkOne(f, op(bytes, 0, 3, "Tom", "Tim")).ok, true);
  assert.equal(checkOne(f, op(bytes, 0, 3, "Tim", "Tam")).code, "old_text_differs");
  assert.equal(checkOne(f, { ...op(bytes, 0, 3, "Tom", "x"), expect: { sha256: "0".repeat(64), source: "Tom" } }).code, "stale_base");
  assert.equal(checkOne(f, op(bytes, 0, t.length + 1, t, "x")).code, "bad_range");
  assert.equal(checkOne(f, { op: "replace_text", target: {}, expect: {} }).code, "not_for_markdown");
  assert.equal(checkOne(f, op(bytes, 0, 3, "Tom", "\ud800")).code, "broken_text");
});

test("rebuild: offsets of one base, applied together; an overlap refuses all; the BOM and line endings stay", () => {
  const bytes = B("\uFEFFred car, red bus\r\nno newline at end");
  const ok = rebuild(bytes, [op(bytes, 9, 12, "red", "blue"), op(bytes, 0, 3, "red", "dark green")]);
  assert.equal(ok.ok, true);
  assert.ok(ok.bytes.equals(B("\uFEFFdark green car, blue bus\r\nno newline at end")));
  const bad = rebuild(bytes, [op(bytes, 0, 3, "red", "x"), op(bytes, 2, 6, "d ca", "y")]);
  assert.deepEqual([bad.ok, bad.code], [false, "overlap"]);
  assert.equal(rebuild(Buffer.from([0x63, 0x61, 0x66, 0xe9]), [op(B("x"), 0, 1, "x", "y")]).code, "not_utf8");
});

test("the apply driver: atomic by default; --partial writes what binds, but an overlap still refuses every op", async () => {
  const bytes = B("alpha beta gamma\n");
  const good = op(bytes, 6, 10, "beta", "BETA");
  const wrong = op(bytes, 0, 5, "alphX", "A");
  let r = await runOps({ bytes, format: "markdown", ops: [good, wrong] });
  assert.equal(r.bytes, null, "atomic: one wrong old text writes nothing");
  r = await runOps({ bytes, format: "markdown", ops: [good, wrong], partial: true });
  assert.ok(r.bytes.equals(B("alpha BETA gamma\n")));
  assert.deepEqual(r.results.map((x) => x.status), ["applied", "expect_mismatch"]);
  r = await runOps({ bytes, format: "markdown", ops: [good, op(bytes, 8, 13, "ta ga", "x")], partial: true });
  assert.equal(r.bytes, null);
  assert.deepEqual(r.results.map((x) => [x.status, x.code]), [["refused", "overlap"], ["refused", "overlap"]]);
});

test("the batch evidence: exact block sources and ranges, headings cleaned for display only", () => {
  const bytes = B("# Title  *x*\n\npara  one\n\n- item\n");
  const e = markdownEvidence(readMarkdownFile(bytes));
  assert.equal(e.base_sha256, sha(bytes));
  assert.deepEqual(e.outline.map((h) => [h.level, h.text, h.from, h.to]), [[1, "Title x", 0, 13]]);
  assert.deepEqual(e.blocks.map((b) => [b.type, b.label, b.source]), [["heading", "heading 1", "# Title  *x*\n"], ["paragraph", "paragraph", "para  one\n"], ["paragraph", "list item, paragraph", "item\n"]]);
});

test("History and changed regions: leaf blocks of the after version by exact range and version, as the history contract says", () => {
  const before = B("# Plan\n\nRed car.\n\nKeep me.\n");
  const after = B("# Plan\n\nBlue car.\n\nKeep me.\n\nNew line.\n");
  const r = compareBytes("markdown", before, after, { places: true });
  assert.deepEqual(r.counts, { changed: 1, added: 1, removed: 0 });
  const schema = JSON.parse(fs.readFileSync(new URL("../docs/contracts/history.schema.json", import.meta.url), "utf8"));
  const loc = schema.$defs.place.properties.locator.oneOf.find((x) => x.properties?.format?.const === "markdown");
  for (const p of r.places) {
    assert.deepEqual(Object.keys(p.locator).sort(), [...loc.required].sort());
    validate(p.locator, loc, schema, "$.locator");
    assert.equal(p.locator.version, sha(after));
    assert.ok(after.toString().slice(p.locator.from, p.locator.to).length > 0);
  }
  assert.deepEqual(r.places.map((p) => [p.change, after.toString().slice(p.locator.from, p.locator.to)]), [["modified", "Blue car.\n"], ["added", "New line.\n"]]);
  const c = changedRegions("markdown", before, after);
  assert.deepEqual(c.items.map((x) => [x.kind, x.from, x.to]), [["changed", 8, 18], ["added", 29, 39]]);
});
