// Durable anchors for HTML files (PLAN-html 3.4): floors on an ordinary generated page, like test/anchors-floor.test.js for the other
// formats: 50 comments found again after edits elsewhere, after their own element's text is edited, and after elements are inserted
// above, within the budget one request gets on the server (src/session.js SCAN_BUDGET). Each floor is what the code achieves (50 of 50).
// Also: stored anchors pass src/retain.js unchanged, a spent budget makes weak anchors that resolve by their path, and the anchor work
// (src/anchor-work.js) moves them.
import assert from "node:assert/strict";
import { test } from "node:test";
import "../src/html-parser.js";
import * as H from "../src/html.js";
import { buildDurable, readUnits, resolveDurableAny } from "../src/anchors.js";
import { anchorWork, reanchor } from "../src/anchor-work.js";
import { capDurable } from "../src/retain.js";
import { scanBudget } from "../src/text.js";
import { buildBatch } from "../src/batch.js";

const BUDGET = 40_000_000;
let seed = 7;
const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff;
const VOCAB = "the of and to a in that is for it as was with be by on not this are or from at which but have an they you were there been one all we their has would when if so no what out up more said into about them some could time these two may then do first any my now such like other how over people than only very made after years work most where through back much before good great report revenue customer quarter growth market".split(" ");
const PARAS = Array.from({ length: 3000 }, (_, i) => `${Array.from({ length: 12 + Math.floor(rnd() * 20) }, () => VOCAB[Math.floor(rnd() * VOCAB.length)]).join(" ")} item ${i}.`);
const PICKS = Array.from({ length: 50 }, (_, j) => 30 + j * 59);
const ABOVE = 12;

/** An ordinary page: a heading every 100 paragraphs, indented source with line breaks inside paragraphs, entities, inline formatting. */
function pageOf(paras, { ids = false, top = [] } = {}) {
  const out = ['<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <title>Quarterly report</title>\n  <style>p { margin: 0 }</style>\n</head>\n<body>\n'];
  for (const t of top) out.push(`  <p>${t}</p>\n`);
  paras.forEach((t, i) => {
    if (i % 100 === 0) out.push(`  <h2>Section ${i / 100 + 1}</h2>\n`);
    const words = t.split(" ");
    const mid = Math.floor(words.length / 2);
    // a line break in the source halfway: the browser shows one space
    out.push(`  <p${ids ? ` id="p-${i}"` : ""}>${words.slice(0, mid).join(" ")}\n    ${words.slice(mid).join(" ")}</p>\n`);
  });
  out.push("</body>\n</html>\n");
  return Buffer.from(out.join(""));
}
const pOf = (r, i) => r.units.filter((u) => u.tag === "p")[i].node;
// the page's anchor for a one-word quote (the second word of 4+ letters) or a 30-character quote, as the browser shows the text
function anchorOf(r, i, len) {
  const el = pOf(r, i);
  const t = PARAS[i];
  const m = [...t.matchAll(/\b[a-z]{4,}\b/g)][1];
  const at = len ? t.indexOf(" ", Math.floor(t.length / 3)) + 1 : m.index;
  const end = len ? at + t.slice(at, at + len).trimEnd().length : at + m[0].length;
  return { location: { nodeId: el.__id, start: at, end }, quote: t.slice(at, end), prefix: t.slice(Math.max(0, at - 40), at), suffix: t.slice(end, end + 40), want: { at, end } };
}

function floor({ ids, own = false, above = false, elsewhere = false }) {
  const made = readUnits("html", pageOf(PARAS, { ids }));
  const edited = PARAS.map((t, i) => (own && PICKS.includes(i) ? t.replace(/item (\d+)\.$/, "item $1, as the agent rewrote it.") : elsewhere && !PICKS.includes(i) && i % 3 === 0 ? `${t} An added sentence.` : t));
  const top = above ? Array.from({ length: ABOVE }, (_, k) => `A new opening paragraph ${k} the agent added.`) : [];
  const now = readUnits("html", pageOf(edited, { ids, top }));
  const out = {};
  for (const len of [0, 30]) {
    const anchors = PICKS.map((i) => anchorOf(made.read, i, len));
    const ds = scanBudget(BUDGET, () => anchors.map((a) => buildDurable(made, a)));
    const rs = scanBudget(BUDGET, () => ds.map((d) => resolveDurableAny(now, d)));
    out[len ? "phrase" : "word"] = rs.filter((r, j) => r.path === H.pathString(H.elementPath(pOf(now.read, PICKS[j] + top.length))) && r.start === anchors[j].want.at && r.end === anchors[j].want.end).length;
    for (const d of ds) assert.equal(capDurable(d), d, "a stored anchor is within the caps as built");
  }
  return out;
}

for (const ids of [false, true]) {
  const w = ids ? "with id attributes" : "without ids";
  test(`floor, HTML ${w}: 50 one-word and 50 30-character quotes found again after edits elsewhere`, { timeout: 120_000 }, () => {
    assert.deepEqual(floor({ ids, elsewhere: true }), { word: 50, phrase: 50 });
  });
  test(`floor, HTML ${w}: the same after each comment's own paragraph is edited after the quote`, { timeout: 120_000 }, () => {
    assert.deepEqual(floor({ ids, own: true }), { word: 50, phrase: 50 });
  });
  test(`floor, HTML ${w}: the same after paragraphs are inserted above`, { timeout: 120_000 }, () => {
    assert.deepEqual(floor({ ids, above: true, own: true }), { word: 50, phrase: 50 });
  });
}

test("an anchor's method: the id first, then the path with its hash, then the quote near its old place", () => {
  const made = readUnits("html", pageOf(PARAS.slice(0, 300), { ids: true }));
  const plain = readUnits("html", pageOf(PARAS.slice(0, 300)));
  const a = anchorOf(made.read, 120, 0);
  const d = scanBudget(BUDGET, () => buildDurable(made, a));
  assert.equal(d.elementId, "p-120");
  assert.equal(d.heading, "Section 2");
  assert.equal(scanBudget(BUDGET, () => resolveDurableAny(made, d)).method, "id");
  const dp = scanBudget(BUDGET, () => buildDurable(plain, anchorOf(plain.read, 120, 0)));
  assert.equal(dp.elementId, null);
  assert.equal(scanBudget(BUDGET, () => resolveDurableAny(plain, dp)).method, "path");
  const moved = readUnits("html", pageOf(PARAS.slice(0, 300), { top: ["one more"] }));
  const r = scanBudget(BUDGET, () => resolveDurableAny(moved, dp));
  assert.equal(r.method, "quote");
  assert.equal(r.changed, false);
  // a deleted paragraph: none
  const gone = readUnits("html", pageOf(PARAS.slice(0, 300).map((t, i) => (i === 120 ? "replaced entirely by other words" : t))));
  assert.equal(scanBudget(BUDGET, () => resolveDurableAny(gone, dp)).method !== "path", true);
});

test("an element with no text of its own (a table row, a list item holding a list) follows its content, not its old place", () => {
  const rows = (top) => Buffer.from(`<!doctype html><html><body><table>${top}${Array.from({ length: 20 }, (_, i) => `<tr><td>Row ${i} name</td><td>${i * 7}</td></tr>`).join("")}</table><ul>${top ? "<li><ul><li>new</li></ul></li>" : ""}<li><ul><li>inner one</li></ul></li><li><ul><li>inner two</li></ul></li></ul></body></html>`);
  const made = readUnits("html", rows(""));
  const now = readUnits("html", rows("<tr><td>New row</td><td>0</td></tr>"));
  const tr = made.read.nodes.filter((x) => x.tagName === "tr")[5];
  const d = scanBudget(BUDGET, () => buildDurable(made, { location: { nodeId: tr.__id }, quote: "", hitKind: "element" }));
  assert.equal(d.tag, "tr");
  const r = scanBudget(BUDGET, () => resolveDurableAny(now, d));
  assert.notEqual(r.method, "path", "the row now at the old path is another row");
  assert.equal(r.path, "/html[1]/body[1]/table[1]/tbody[1]/tr[7]");
  assert.match(r.text, /^Row 5 name/);
  const li = made.read.nodes.filter((x) => x.tagName === "li")[2]; // the second outer item
  const dl = scanBudget(BUDGET, () => buildDurable(made, { location: { nodeId: li.__id }, quote: "", hitKind: "element" }));
  const rl = scanBudget(BUDGET, () => resolveDurableAny(now, dl));
  assert.match(rl.text, /^inner two/);
  // unchanged, the path still finds it
  assert.equal(scanBudget(BUDGET, () => resolveDurableAny(made, d)).method, "path");
});

test("a spent budget makes a weak anchor (path and context, no hash), which resolves by its path; none at all is unresolved", () => {
  const made = readUnits("html", pageOf(PARAS.slice(0, 200)));
  const a = anchorOf(made.read, 50, 30);
  const weak = scanBudget(20, () => buildDurable(made, a));
  assert.equal(weak.weak, true);
  assert.equal(weak.textHash, null);
  assert.deepEqual(weak.path.slice(0, 2), ["html:0", "body:0"]);
  assert.ok(weak.prefix.length <= 40 && weak.suffix.length <= 40);
  const r = scanBudget(BUDGET, () => resolveDurableAny(made, weak));
  assert.equal(r.method, "path");
  assert.equal(r.path, H.pathString(H.elementPath(pOf(made.read, 50))));
  assert.equal(scanBudget(0, () => buildDurable(made, a)), null);
});

test("stored anchors pass src/retain.js unchanged: a deep element, a long quote, a long id-less path", () => {
  const deep = Buffer.from(`<!doctype html><html><body>${"<div>".repeat(500)}<p>deep text here</p>${"</div>".repeat(500)}<p>${"word ".repeat(10_000)}</p></body></html>`);
  const u = readUnits("html", deep);
  const p = u.read.units.find((x) => x.tag === "p");
  const d = scanBudget(BUDGET, () => buildDurable(u, { location: { nodeId: p.nodeId }, quote: "text", prefix: "deep ", suffix: " here" }));
  assert.equal(d.path.length, 503);
  assert.equal(capDurable(d), d);
  const big = u.read.units.at(-1);
  const q = "word ".repeat(4000).trim();
  const d2 = scanBudget(BUDGET, () => buildDurable(u, { location: { nodeId: big.nodeId }, quote: q, prefix: "", suffix: "" }));
  assert.ok(d2.text.length <= 2000);
  assert.ok(JSON.stringify(d2).length <= 48 * 1024);
});

test("the anchor work moves an HTML anchor onto newer bytes and builds the outline, in one call as the worker runs it", () => {
  const before = pageOf(PARAS.slice(0, 120));
  const after = pageOf(PARAS.slice(0, 120).map((t, i) => (i === 40 ? t.replace(/item (\d+)\.$/, "item $1, rewritten.") : t)), { top: ["new", "two"] });
  const u0 = readUnits("html", before);
  const a = anchorOf(u0.read, 40, 0);
  const d = scanBudget(BUDGET, () => buildDurable(u0, a));
  const w = anchorWork({ format: "html", bytes: after, sha: "x".repeat(64), validate: true, check: true, tasks: [{ op: "reanchor", c: { durable: d } }, { op: "resolveAll", comments: [{ id: "c1", durable: d }], view: null }], outline: true, budget: BUDGET });
  assert.deepEqual(w.read, { ok: true });
  const moved = w.results[0];
  assert.equal(moved.format, "html");
  assert.deepEqual(moved.path.slice(-1), ["p:42"]);
  assert.equal(moved.quote, a.quote);
  assert.equal(w.results[1].anchors.c1.method, "quote");
  assert.ok(w.outline.outline.length > 100 && w.outline.outline.every((e) => e.id && e.label));
  // a page past a limit is a cap the worker reports, never an error that loses the request
  const capped = anchorWork({ format: "html", bytes: Buffer.from(`<p>${"<br>".repeat(200_001)}`), sha: "y".repeat(64), validate: true, tasks: [{ op: "reanchor", c: { durable: d } }], budget: BUDGET });
  assert.match(capped.read.cap, /more than 200,000 elements/);
  // the batch: the html locator, and the reply shorthand of an element that holds text (replace_text, set_text: Phase 1c)
  const b = buildBatch({ file: "/tmp/x.html", format: "html", baseSha: "a".repeat(64), note: "", edits: [], comments: [{ id: "c1", kind: "text", text: "fix", durable: moved }] });
  const an = b.untrusted_document_evidence.anchors[0];
  assert.deepEqual(Object.keys(an.locator), ["path", "element_id", "text_hash", "start", "end"]);
  assert.match(an.locator.path, /^\/html\[1\]\/body\[1\]\/p\[43\]$/);
  assert.equal(b.instructions.comments[0].reply_with, "find_replace_or_text");
  assert.equal(reanchor(u0, { durable: null, anchor: a }).format, "html");
});
