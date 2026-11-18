import assert from "node:assert/strict";
import { test } from "node:test";
import { buildZip, contentTypes, docxBytes, xlsxBytes } from "./helpers/zipbuild.js";
import { scanBudget } from "../src/text.js";
import { buildDurable, readUnits, resolveDurableAny } from "../src/anchors.js";
import { buildBatch } from "../src/batch.js";

// Floors for ordinary files: how many of 50 comments are found again after an ordinary edit, each format, within the budget one request
// gets on the server (src/session.js SCAN_BUDGET). Each count is what the code achieves (50 of 50); a change that finds fewer fails here.
const BUDGET = 40_000_000;

// ---- Word: a few thousand ordinary English paragraphs ----------------------------------------------------------------------------------
let seed = 11;
const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff;
const VOCAB = "the of and to a in that is for it as was with be by on not this are or from at which but have an they you were there been one all we their has would when if so no what out up more said into about them some could time these two may then do first any my now such like other how over people than only very made after years work most where through back much before good great report revenue customer quarter growth market".split(" ");
const PARAS = Array.from({ length: 3000 }, (_, i) => `${Array.from({ length: 12 + Math.floor(rnd() * 20) }, () => VOCAB[Math.floor(rnd() * VOCAB.length)]).join(" ")} item ${i}.`);
const PICKS = Array.from({ length: 50 }, (_, j) => 30 + j * 59);
const ABOVE = 12; // paragraphs inserted at the top in the "inserted above" cases
const idOf = (i) => (i + 1).toString(16).toUpperCase().padStart(8, "0");

// the browser's anchor for a one-word quote (the second word of 4+ letters) or a 30-character quote (from a word start a third in,
// trimmed as the page keeps it)
function anchorOf(t, i, len) {
  const m = [...t.matchAll(/\b[a-z]{4,}\b/g)][1];
  const at = len ? t.indexOf(" ", Math.floor(t.length / 3)) + 1 : m.index;
  const end = len ? at + t.slice(at, at + len).trimEnd().length : at + m[0].length;
  return { location: { blockPath: [i], start: at, end }, quote: t.slice(at, end), prefix: t.slice(Math.max(0, at - 40), at), suffix: t.slice(end, end + 40) };
}

function wordCase({ ids, above }) {
  const para = (text, i) => (ids ? { text, paraId: idOf(i) } : text);
  const made = readUnits("docx", docxBytes(PARAS.map(para)));
  // the agent edits each anchored paragraph after the quote, and (above) inserts paragraphs at the top
  const edited = PARAS.map((t, i) => para(PICKS.includes(i) ? t.replace(/item (\d+)\.$/, "item $1, as the agent rewrote it.") : t, i));
  const top = above ? Array.from({ length: ABOVE }, (_, k) => para(`A new opening paragraph ${k} the agent added.`, 100_000 + k)) : [];
  const read = readUnits("docx", docxBytes([...top, ...edited]));
  const out = {};
  for (const len of [0, 30]) {
    const anchors = PICKS.map((i) => anchorOf(PARAS[i], i, len));
    const ds = scanBudget(BUDGET, () => anchors.map((a) => buildDurable(made, a)));
    const rs = scanBudget(BUDGET, () => ds.map((d) => resolveDurableAny(read, d)));
    out[len ? "phrase" : "word"] = rs.filter((r, j) => r.ordinal === PICKS[j] + top.length && r.start === anchors[j].location.start && r.end === anchors[j].location.end).length;
  }
  return out;
}

test("floor, Word without paragraph ids: 50 one-word and 50 30-character quotes, each paragraph edited after the quote, all found", { timeout: 120_000 }, () => {
  assert.deepEqual(wordCase({ ids: false, above: false }), { word: 50, phrase: 50 });
});

test("floor, Word without paragraph ids: the same with paragraphs inserted above, all found", { timeout: 120_000 }, () => {
  assert.deepEqual(wordCase({ ids: false, above: true }), { word: 50, phrase: 50 });
});

test("floor, Word with paragraph ids: the same with paragraphs inserted above, all found", { timeout: 120_000 }, () => {
  assert.deepEqual(wordCase({ ids: true, above: true }), { word: 50, phrase: 50 });
});

// ---- Excel: a sales table, comments on cells and small ranges, rows inserted above -----------------------------------------------------
const col = (n) => {
  let s = "";
  for (n++; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};
const REGIONS = ["North", "South", "East", "West"];
const PRODUCTS = ["Widget", "Gadget", "Bracket", "Hinge", "Valve", "Sprocket", "Gear", "Spring", "Bolt", "Washer"];
function sheet(extraAbove) {
  const cells = { A1: "Order", B1: "Region", C1: "Product", D1: "Units", E1: "Price", F1: "Total", G1: "Date" };
  const rows = [];
  for (let k = 0; k < extraAbove; k++) rows.push([`NEW-${k}`, "Central", "Clamp", 1 + k, 2.5, 2.5 * (1 + k), "2026-11-01"]);
  for (let i = 0; i < 400; i++) {
    const units = 1 + ((i * 37) % 90);
    const price = [4.5, 12, 7.25, 19.99, 3][i % 5];
    rows.push([`SO-${1000 + i}`, REGIONS[i % 4], PRODUCTS[(i * 7) % 10], units, price, Math.round(units * price * 100) / 100, `2026-${String(1 + (i % 12)).padStart(2, "0")}-${String(1 + (i % 28)).padStart(2, "0")}`]);
  }
  rows.forEach((r, k) => r.forEach((v, c) => (cells[`${col(c)}${k + 2}`] = v)));
  return xlsxBytes({ Sales: cells });
}

test("floor, Excel: 50 comments on ordinary cells and small ranges all keep a text hash and are found again after rows are inserted above", { timeout: 120_000 }, () => {
  // 30 single cells in every column, 20 ranges of 1 x 3 to 3 x 4 cells
  const ranges = Array.from({ length: 50 }, (_, j) => {
    const r = 3 + j * 7;
    if (j < 30) return { range: `${col(j % 7)}${r}`, r0: r - 1, c0: j % 7 };
    const h = 1 + (j % 3);
    const w = 3 + (j % 2);
    const c = j % 3;
    return { range: `${col(c)}${r}:${col(c + w - 1)}${r + h - 1}`, r0: r - 1, c0: c };
  });
  const made = readUnits("xlsx", sheet(0));
  const ds = scanBudget(BUDGET, () => ranges.map((q) => buildDurable(made, { location: { sheetIndex: 0, sheetName: "Sales", range: q.range } })));
  assert.equal(ds.filter((d) => d.textHash && d.rangeHash).length, 50, "every anchor keeps its cell and range hash");
  const batch = buildBatch({ file: "/tmp/floor.xlsx", format: "xlsx", baseSha: "0".repeat(64), note: "", comments: ds.map((d, j) => ({ id: `c${j}`, kind: "element", text: "check", durable: d })), edits: [] });
  assert.equal(batch.instructions.comments.filter((c) => c.reply_with === "set").length, 50, "the agent may answer each with `set`");
  const INSERTED = 5;
  const read = readUnits("xlsx", sheet(INSERTED));
  const rs = scanBudget(BUDGET, () => ds.map((d) => resolveDurableAny(read, d)));
  const found = rs.filter((r, j) => r.method !== "none" && r.r0 === ranges[j].r0 + INSERTED && r.c0 === ranges[j].c0 && r.range === ds[j].range.replace(/\d+/g, (n) => String(Number(n) + INSERTED)) && !r.changed).length;
  assert.equal(found, 50, `${found} of 50 found again, unchanged (${[...new Set(rs.map((r) => r.method))]})`);
});

// ---- PowerPoint: 25 slides of a title and a body, a slide added before them -------------------------------------------------------------
const P_NS = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
function deck(slides) {
  const sp = (id, name, text, ph) => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr>${ph ? `<p:ph type="${ph}"/>` : ""}</p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;
  const files = {
    "[Content_Types].xml": contentTypes("pptx"),
    "ppt/presentation.xml": `<?xml version="1.0"?><p:presentation ${P_NS} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst>${slides.map((s, i) => `<p:sldId id="${s.id}" r:id="rId${i + 1}"/>`).join("")}</p:sldIdLst></p:presentation>`,
    "ppt/_rels/presentation.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${slides.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${s.id}.xml"/>`).join("")}</Relationships>`,
  };
  for (const s of slides) files[`ppt/slides/slide${s.id}.xml`] = `<?xml version="1.0"?><p:sld ${P_NS}><p:cSld><p:spTree>${sp(2, "Title 1", s.title, "title")}${sp(3, "Content 2", s.body)}</p:spTree></p:cSld></p:sld>`;
  return buildZip(files);
}

test("floor, PowerPoint: 50 comments on the shapes of 25 slides are all found again after a slide is added before them", { timeout: 120_000 }, () => {
  const slides = Array.from({ length: 25 }, (_, i) => ({ id: 256 + i, title: `Quarter review part ${i + 1}`, body: `Revenue grew in ${REGIONS[i % 4]} as ${PRODUCTS[i % 10]} orders rose for the ${i + 1} week in a row.` }));
  const made = readUnits("pptx", deck(slides));
  const anchors = slides.flatMap((s, i) => [
    { location: { slideIndex: i, slideId: s.id, shapeId: 2, shapeName: "Title 1" }, quote: s.title, hitKind: "shape" }, // the whole title
    { location: { slideIndex: i, slideId: s.id, shapeId: 3, shapeName: "Content 2" }, quote: "orders rose", prefix: s.body.slice(0, s.body.indexOf("orders")), suffix: s.body.slice(s.body.indexOf("orders") + 11) }, // words in the body
  ]);
  const ds = scanBudget(BUDGET, () => anchors.map((a) => buildDurable(made, a)));
  const read = readUnits("pptx", deck([{ id: 300, title: "Agenda", body: "What we cover today." }, ...slides]));
  const rs = scanBudget(BUDGET, () => ds.map((d) => resolveDurableAny(read, d)));
  const found = rs.filter((r, j) => r.method !== "none" && r.slideId === String(anchors[j].location.slideId) && r.slideIndex === anchors[j].location.slideIndex + 1 && r.shapeId === anchors[j].location.shapeId).length;
  assert.equal(found, 50, `${found} of 50 found again (${[...new Set(rs.map((r) => r.method))]})`);
});

// ---- Excel, large ranges of longer labels, as the server makes them now (in the anchor worker, src/anchor-worker.js) -------------------
// Round 11 (e): with dozens of 1,000 x 20 ranges of cells of 25 or more characters, the server's budget ran out and some anchors went out
// without their range hash, so an edit deep in such a range was not flagged. The anchor worker's budget pays for 50 of them.
test("floor, Excel: 50 ranges of 1,000 x 20 cells of 32-character labels all keep their hash in the anchor worker, and an edit deep in the last reads as changed", { timeout: 300_000 }, async () => {
  const { anchorWork } = await import("../src/anchor-work.js");
  const { WORKER_BUDGET } = await import("../src/anchor-worker.js");
  const cellsOf = (edit) => {
    const cells = {};
    for (let r = 1; r <= 1000; r++) for (let c = 0; c < 70; c++) cells[`${col(c)}${r}`] = `Item ${r}-${c} of the long label ok`;
    return xlsxBytes({ Sheet1: { ...cells, ...edit } });
  };
  const tasks = Array.from({ length: 50 }, (_, i) => ({ op: "build", anchor: { location: { sheetIndex: 0, sheetName: "Sheet1", range: `${col(i)}1:${col(i + 19)}1000` } } }));
  const made = anchorWork({ format: "xlsx", bytes: cellsOf({}), sha: "floor-e-1", tasks, budget: WORKER_BUDGET });
  const ds = made.results;
  assert.equal(ds.filter((d) => d?.rangeHash).length, 50, "every range keeps its hash");
  const read = anchorWork({ format: "xlsx", bytes: cellsOf({ [`${col(68)}900`]: "edited" }), sha: "floor-e-2", tasks: ds.map((d) => ({ op: "resolveAll", comments: [{ id: "x", durable: d }], view: null })), budget: WORKER_BUDGET });
  const changed = read.results.map((r, i) => (r.anchors.x.changed ? i : -1)).filter((i) => i >= 0);
  assert.deepEqual(changed, [49], "only the last range, which holds the edited cell, reads as changed");
});
