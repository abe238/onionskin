import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { buildZip } from "./helpers/zipbuild.js";
import { ENGINE_SAMPLES, haveSamples, skipUnless } from "../scripts/fixtures.mjs";
import { mergeProven } from "../src/merge-worker.js";
import { parseDeck } from "../src/pptx.js";
import { openZip } from "../src/zip.js";

// The PPTX merge as a property over random small decks, as the merge worker runs it (src/merge-worker.js): the planner
// (src/merge-pptx.js) and the op engine, then the proof (src/merge-proof.js). Every case ends in a correct merge or a clean refusal;
// a silent loss is the only failure. A third checker over plain arrays (slides by id, shapes by id), importing neither the planner nor
// the proof, judges the merges returned: each of the person's shape text edits (white space as typed, lines added) is in the result in
// that shape or handed back by an entry that names the shape (or its slide, with the person's file kept); shapes and slides added,
// removed or put in another order, and formatting, are handed back; the agent's deck stands; nothing else differs from it.

const SKIP = skipUnless(haveSamples(), `engine samples not found in ${ENGINE_SAMPLES}`, "restore test/fixtures/engine or set ONIONSKIN_TEST_SAMPLES");
const SEED = 20261116;
const CASES = 600;
const PARTS = 3;

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LINES = ["Revenue grew in the north", "Costs stayed flat", "Hiring starts in May", "Two launches this quarter", "Support tickets fell"];
/** a deck: [{sid, shapes: [{id, lines: [text], bold}]}] */
function makeCase(seed) {
  const r = rng(seed);
  const pick = (list) => list[Math.floor(r() * list.length)];
  const base = Array.from({ length: 2 + Math.floor(r() * 2) }, (_, s) => ({ sid: 256 + s, shapes: Array.from({ length: 2 + Math.floor(r() * 3) }, (_, k) => ({ id: k + 2, lines: Array.from({ length: 1 + Math.floor(r() * 2) }, () => pick(LINES)), bold: false })) }));
  const copy = (d) => d.map((s) => ({ ...s, shapes: s.shapes.map((x) => ({ ...x, lines: [...x.lines] })) }));
  let n = 0;
  const side = (who, ops) => {
    const d = copy(base);
    for (let k = 1 + Math.floor(r() * 2); k > 0; k--) {
      const s = pick(d);
      const x = pick(s.shapes);
      const op = pick(ops);
      if (!x) continue;
      if (op === "edit") x.lines[0] = `${who} ${++n}`;
      else if (op === "space") x.lines[0] = x.lines[0].replace(" ", "  ");
      else if (op === "line") x.lines.push(`${who} line ${++n}`);
      else if (op === "bold") x.bold = !x.bold;
      else if (op === "addShape") s.shapes.push({ id: 20 + ++n, lines: [`${who} box ${n}`], bold: false });
      else if (op === "removeShape" && s.shapes.length > 1) s.shapes.splice(s.shapes.indexOf(x), 1);
      else if (op === "swapShapes" && s.shapes.length > 1) s.shapes.reverse();
      else if (op === "swapSlides") d.reverse();
      else if (op === "removeSlide" && d.length > 1) d.splice(d.indexOf(s), 1);
    }
    return d;
  };
  const mine = side("Mine", ["edit", "edit", "space", "line", "bold", "addShape", "removeShape", "swapShapes", "swapSlides", "removeSlide"]);
  const theirs = side("Agent", ["edit", "edit", "space", "removeShape", "swapSlides", "removeSlide"]);
  return { base, mine, theirs };
}

const xml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const P = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
let sample = null;
/** the engine's sample deck with its slides replaced by `deck`'s; slide `sid` is always part slide<sid>.xml */
function bytesOf(deck) {
  sample ||= openZip(fs.readFileSync(path.join(ENGINE_SAMPLES, "sample.pptx")));
  const files = {};
  for (const n of sample.names) if (!/^ppt\/(slides|charts|embeddings|media)\//.test(n) && n !== "docProps/thumbnail.jpeg") files[n] = sample.read(n);
  const all = [256, 257, 258];
  files["[Content_Types].xml"] = sample.readText("[Content_Types].xml").replace(/<Override PartName="\/ppt\/(slides|charts)\/[^"]+"[^>]*\/>/g, "").replace("</Types>", `${all.map((i) => `<Override PartName="/ppt/slides/slide${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join("")}</Types>`);
  files["_rels/.rels"] = sample.readText("_rels/.rels").replace(/<Relationship Id="rId2"[^>]*\/>/, "");
  files["ppt/presentation.xml"] = sample.readText("ppt/presentation.xml").replace(/<p:sldIdLst>.*<\/p:sldIdLst>/, `<p:sldIdLst>${deck.map((s) => `<p:sldId id="${s.sid}" r:id="rId${s.sid}"/>`).join("")}</p:sldIdLst>`);
  files["ppt/_rels/presentation.xml.rels"] = sample.readText("ppt/_rels/presentation.xml.rels").replace(/<Relationship Id="rId(7|8|9|10|11)"[^>]*\/>/g, "").replace("</Relationships>", `${all.map((i) => `<Relationship Id="rId${i}" Type="${P}/slide" Target="slides/slide${i}.xml"/>`).join("")}</Relationships>`);
  for (const sid of all) {
    const s = deck.find((x) => x.sid === sid) || { shapes: [] };
    const sp = s.shapes.map((x) => `<p:sp><p:nvSpPr><p:cNvPr id="${x.id}" name="Box ${x.id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="9" cy="9"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/>${x.lines.map((l) => `<a:p><a:r><a:rPr lang="en-US"${x.bold ? ' b="1"' : ""}/><a:t xml:space="preserve">${xml(l)}</a:t></a:r></a:p>`).join("")}</p:txBody></p:sp>`).join("");
    files[`ppt/slides/slide${sid}.xml`] = `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="${P}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${sp}</p:spTree></p:cSld></p:sld>`;
    files[`ppt/slides/_rels/slide${sid}.xml.rels`] = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${P}/slideLayout" Target="../slideLayouts/slideLayout6.xml"/></Relationships>`;
  }
  return buildZip(files);
}
/** a deck read back as plain arrays: [{sid, shapes: [{id, text, fmt}]}] */
function plainOf(bytes) {
  const d = parseDeck(bytes);
  d.ensure();
  return d.slides.map((s) => ({ sid: String(s.id), shapes: s.shapes.map((x) => ({ id: x.id, text: x.text, fmt: JSON.stringify(x.fmt) })) }));
}

/** the third checker: what does not balance (refs "s<slide id>", "h<slide id>/<shape id>#0", "order") */
function unbalanced(B, M, T, R, unplaced, copy) {
  const bad = [];
  const named = new Map();
  for (const u of unplaced) for (const ref of u.of || []) (named.get(ref) || named.set(ref, []).get(ref)).push(u);
  const back = (refs, text = null) => refs.some((ref) => (named.get(ref) || []).some((u) => text === null || u.text === text));
  const slide = (D, sid) => D.find((s) => s.sid === sid);
  const shape = (D, sid, id) => slide(D, sid)?.shapes.find((x) => x.id === id);
  if (T.map((s) => s.sid).join() !== R.map((s) => s.sid).join()) bad.push("the agent's slide list changed");
  for (const s of M) if (!slide(B, s.sid) && !back([`s${s.sid}`])) bad.push(`slide ${s.sid} the person added is not handed back`);
  for (const s of B) if (!slide(M, s.sid) && !back([`s${s.sid}`])) bad.push(`slide ${s.sid} the person removed is not handed back`);
  const order = (D, other) => D.map((s) => s.sid).filter((sid) => slide(other, sid)).join();
  if (order(B, M) !== order(M, B) && !back(["order"])) bad.push("the person moved slides; not handed back");
  for (const t of T) {
    const r = slide(R, t.sid);
    if (!r || r.shapes.map((x) => x.id).join() !== t.shapes.map((x) => x.id).join()) bad.push(`slide ${t.sid}: the agent's shapes changed`);
  }
  for (const b of B) {
    const m = slide(M, b.sid);
    if (!m) continue;
    const ref = (id) => `h${b.sid}/${id}#0`;
    const whole = () => back([`s${b.sid}`]); // a line for the whole slide (formatting, shapes): any change but text
    const ids = (s) => s.shapes.map((x) => x.id).filter((id) => shape(B, b.sid, id) && shape(M, b.sid, id)).join();
    if (ids(b) !== ids(m) && !m.shapes.every((x) => !shape(B, b.sid, x.id) || back([ref(x.id)])) && !whole()) bad.push(`slide ${b.sid}: shapes put in another order, not handed back`);
    for (const x of m.shapes) if (!shape(B, b.sid, x.id) && !back([ref(x.id)], x.text) && !(copy && back([`s${b.sid}`]))) bad.push(`the shape ${x.id} the person added on slide ${b.sid} is not handed back`);
    for (const x of b.shapes) {
      const [mx, tx, rx] = [shape(M, b.sid, x.id), shape(T, b.sid, x.id), shape(R, b.sid, x.id)];
      if (!mx) {
        if (!back([ref(x.id)]) && !whole()) bad.push(`the shape ${x.id} the person removed on slide ${b.sid} is not handed back`);
        continue;
      }
      if (mx.text !== x.text && rx?.text !== mx.text && !back([ref(x.id)], mx.text) && !(copy && back([`s${b.sid}`]))) bad.push(`the person's text of shape ${x.id} on slide ${b.sid} is neither in it nor handed back`);
      if (mx.text === x.text && mx.fmt !== x.fmt && rx?.fmt !== mx.fmt && !back([ref(x.id)]) && !whole()) bad.push(`the person's formatting of shape ${x.id} on slide ${b.sid} is neither carried nor handed back`);
      if (tx && rx && rx.text !== tx.text && !(mx.text !== x.text && tx.text === x.text && rx.text === mx.text)) bad.push(`shape ${x.id} on slide ${b.sid} reads neither the agent's text nor the person's`);
      if (tx && rx && rx.fmt !== tx.fmt && rx.text === tx.text) bad.push(`shape ${x.id} on slide ${b.sid}: the agent's formatting changed`);
    }
  }
  return bad;
}

async function check(c) {
  const [base, mine, theirs] = [c.base, c.mine, c.theirs].map(bytesOf);
  const r = await mergeProven({ format: "pptx", base, mine, theirs, name: "t.pptx" });
  if (r.refused) return { refused: r.refused };
  return { bad: unbalanced(plainOf(base), plainOf(mine), plainOf(theirs), plainOf(r.bytes ?? theirs), r.unplaced, !!r.copy), merged: r.merged };
}

for (let part = 0; part < PARTS; part++) {
  test(`PPTX property, part ${part + 1} of ${PARTS} (${CASES} cases in all, seed ${SEED}): a correct merge or a clean refusal, never a silent loss`, { skip: SKIP }, async (t) => {
    const per = CASES / PARTS;
    const failures = [];
    let refused = 0;
    let carried = 0;
    for (let k = part * per; k < (part + 1) * per && failures.length < 5; k++) {
      const c = makeCase(SEED + k);
      const out = await check(c);
      if (out.refused) refused++;
      else if (out.bad.length) failures.push(`seed ${SEED + k}: ${out.bad.join("; ")}\n  ${JSON.stringify(c)}`);
      else if (out.merged) carried++;
    }
    t.diagnostic(`merged ${per - refused} (${carried} with text carried), refused ${refused}`);
    assert.deepEqual(failures, []);
  });
}

// ---- shapes as a whole: place, size, order, formatting; many edits --------------------------------------------------------------
// The person moves, resizes, puts in another order, bolds or edits shapes, sometimes past 2,000 page events (the session then says
// the list was cut); the agent edits or moves shapes. A tiny checker over plain objects (each shape by id: its text, position, size,
// bold, and its place in the order) asks of each difference between the base and the person's version: in the result, or handed back
// by an entry that names the shape or its slide (with the person's file kept), or the merge refused. Silent loss is the only failure.
const GEOM_CASES = 300;
function makeGeom(seed) {
  const r = rng(seed);
  const pick = (list) => list[Math.floor(r() * list.length)];
  const base = Array.from({ length: 3 + Math.floor(r() * 2) }, (_, k) => ({ id: k + 2, text: pick(LINES), x: 100000 * k, y: 0, cx: 900000, cy: 500000, bold: false }));
  let n = 0;
  const side = (who, ops) => {
    const d = base.map((x) => ({ ...x }));
    for (let k = 1 + Math.floor(r() * 3); k > 0; k--) {
      const op = pick(ops);
      const x = pick(d);
      if (op === "text") x.text = `${who} ${++n}`;
      else if (op === "move") (x.x += 12700 * (1 + Math.floor(r() * 9))), (x.y += 12700);
      else if (op === "resize") x.cx += 25400;
      else if (op === "bold") x.bold = !x.bold;
      else if (op === "reorder") {
        const i = d.indexOf(x);
        const j = (i + 1) % d.length;
        [d[i], d[j]] = [d[j], d[i]];
      }
    }
    return d;
  };
  return { base, mine: side("Mine", ["text", "move", "resize", "bold", "reorder"]), theirs: side("Agent", ["text", "move"]), many: r() < 0.25 };
}
let sampleParts = null; // the sample's parts read once (one opened archive counts everything read from it against one budget)
function geomBytes(shapes) {
  sample ||= openZip(fs.readFileSync(path.join(ENGINE_SAMPLES, "sample.pptx")));
  sampleParts ||= Object.fromEntries(sample.names.filter((n) => !/^ppt\/(slides|charts|embeddings|media)\//.test(n) && n !== "docProps/thumbnail.jpeg").map((n) => [n, sample.read(n)]));
  const files = { ...sampleParts };
  files["[Content_Types].xml"] = sample.readText("[Content_Types].xml").replace(/<Override PartName="\/ppt\/(slides|charts)\/[^"]+"[^>]*\/>/g, "").replace("</Types>", `<Override PartName="/ppt/slides/slide256.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>`);
  files["_rels/.rels"] = sample.readText("_rels/.rels").replace(/<Relationship Id="rId2"[^>]*\/>/, "");
  files["ppt/presentation.xml"] = sample.readText("ppt/presentation.xml").replace(/<p:sldIdLst>.*<\/p:sldIdLst>/, `<p:sldIdLst><p:sldId id="256" r:id="rId256"/></p:sldIdLst>`);
  files["ppt/_rels/presentation.xml.rels"] = sample.readText("ppt/_rels/presentation.xml.rels").replace(/<Relationship Id="rId(7|8|9|10|11)"[^>]*\/>/g, "").replace("</Relationships>", `<Relationship Id="rId256" Type="${P}/slide" Target="slides/slide256.xml"/></Relationships>`);
  const sp = shapes.map((x) => `<p:sp><p:nvSpPr><p:cNvPr id="${x.id}" name="Box ${x.id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x.x}" y="${x.y}"/><a:ext cx="${x.cx}" cy="${x.cy}"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:p><a:r><a:rPr lang="en-US"${x.bold ? ' b="1"' : ""}/><a:t xml:space="preserve">${xml(x.text)}</a:t></a:r></a:p></p:txBody></p:sp>`).join("");
  files["ppt/slides/slide256.xml"] = `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="${P}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${sp}</p:spTree></p:cSld></p:sld>`;
  files["ppt/slides/_rels/slide256.xml.rels"] = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${P}/slideLayout" Target="../slideLayouts/slideLayout6.xml"/></Relationships>`;
  return buildZip(files);
}
/** the tiny checker's reading: the shapes of slide 256 in order, each {id, text, x, y, cx, cy, bold} */
function geomOf(bytes) {
  const x = openZip(bytes).readText("ppt/slides/slide256.xml");
  return [...x.matchAll(/<p:sp>.*?<\/p:sp>/gs)].map(([s]) => ({ id: Number(/<p:cNvPr id="(\d+)"/.exec(s)[1]), text: [...s.matchAll(/<a:t(?: [^>]*)?>([^<]*)<\/a:t>/g)].map((m) => m[1]).join(""), x: Number(/<a:off x="(\d+)"/.exec(s)?.[1]), y: Number(/<a:off x="\d+" y="(\d+)"/.exec(s)?.[1]), cx: Number(/<a:ext cx="(\d+)"/.exec(s)?.[1]), bold: /<a:rPr[^>]* b="1"/.test(s) }));
}
function geomUnbalanced(B, M, T, R, unplaced, copy) {
  const bad = [];
  const named = (refs) => unplaced.some((u) => (u.of || []).some((ref) => refs.includes(ref)));
  const by = (L) => new Map(L.map((x, i) => [x.id, { ...x, at: i }]));
  const [b, m, t, r] = [B, M, T, R].map(by);
  for (const [id, x] of m) {
    const was = b.get(id);
    const got = r.get(id);
    const refs = [`h256/${id}#0`];
    const back = named(refs) || (copy && named(["s256"]));
    for (const k of ["text", "x", "y", "cx", "bold"]) if (x[k] !== was[k] && got?.[k] !== x[k] && !back) bad.push(`the person's ${k} of shape ${id} is neither in the result nor handed back`);
  }
  const order = (L) => L.map((x) => x.id).join();
  if (order(M) !== order(B) && order(R) !== order(M) && !M.some((x) => named([`h256/${x.id}#0`]))) bad.push("the person's order of shapes is neither in the result nor handed back");
  for (const [id, x] of t) {
    const was = b.get(id);
    for (const k of ["text", "x", "y"]) if (x[k] !== was[k] && m.get(id)[k] === was[k] && r.get(id)?.[k] !== x[k]) bad.push(`the agent's ${k} of shape ${id} is gone`);
  }
  return bad;
}
const MANY_EVENTS = Array.from({ length: 2001 }, () => ({ kind: "text", slide: 0 }));
test(`PPTX property, shapes as a whole (${GEOM_CASES} cases, seed ${SEED + 7}): place, size, order, formatting, many edits: a correct merge or a clean refusal, never a silent loss`, { skip: SKIP }, async (t) => {
  const failures = [];
  const count = { merged: 0, handedBack: 0, refused: 0 };
  for (let k = 0; k < GEOM_CASES && failures.length < 5; k++) {
    const c = makeGeom(SEED + 7 + k);
    const [base, mine, theirs] = [c.base, c.mine, c.theirs].map(geomBytes);
    const { editKinds } = await import("../src/session.js");
    const r = await mergeProven({ format: "pptx", base, mine, theirs, name: "t.pptx", edits: c.many ? editKinds(MANY_EVENTS) : [] });
    if (r.refused) {
      count.refused++;
      continue;
    }
    count[r.unplaced.length ? "handedBack" : "merged"]++;
    const bad = geomUnbalanced(...[base, mine, theirs, r.bytes ?? theirs].map(geomOf), r.unplaced, r.copy);
    if (bad.length) failures.push(`seed ${SEED + 7 + k}: ${bad.join("; ")}\n  ${JSON.stringify(c)}`);
  }
  t.diagnostic(`merged ${count.merged}, handed back ${count.handedBack}, refused ${count.refused}`);
  assert.deepEqual(failures, []);
});
