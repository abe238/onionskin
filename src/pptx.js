import { attrOf, local, readRels } from "./xlsx.js";
import { readBudget, tooMany, walkXml } from "./xml.js";
import { OCCURRENCE, affords, hitsOf, normPaid, normText, searchCost, similarity, spend, textHash, weigh, weightOf } from "./text.js";
import { nfc } from "./nfc.js";
import { openZip } from "./zip.js";
import { summarizeRuns } from "./fmt.js";
import { untrusted } from "./sanitize.js";

// PPTX durable anchors. A slide is identified by its p:sldId id (stable across reorder, insert and delete; the part path is only a hint,
// writers renumber parts), a shape by its cNvPr id plus its name and its ordinal among shapes with the same id. Shape text is the
// paragraphs joined by LF, as `onionskin apply` reads it.

const EMPTY = textHash("");
const CTX = 40;
const KEEP = 2000;

// What one reading of a deck may hold, counted over all its slides. The server reads a deck on its own thread at Send, at each delivery to
// an agent and at the end of a run, so these bound how long that keeps it from answering (outside review: three slides of 2.85 million runs
// each held it 7.2 s). Each shape costs a few hundred bytes once read. A real deck of 200 slides has a few thousand shapes and well under
// 200,000 elements.
export const MAX_SHAPES = 50_000;
export const MAX_DECK_ELEMENTS = 500_000;
export const MAX_DECK_ATTRIBUTES = 1_000_000;
export const MAX_DECK_TEXT = 8_000_000;
const deckBudget = () => readBudget({ elements: MAX_DECK_ELEMENTS, attrs: MAX_DECK_ATTRIBUTES, text: MAX_DECK_TEXT, what: "deck", split: "smaller decks" });
const SHAPE_TAGS = new Set(["sp", "pic", "graphicFrame", "grpSp", "cxnSp"]);
const KIND = { sp: "shape", pic: "image", graphicFrame: "table", grpSp: "group", cxnSp: "line" };

/** ppt/presentation.xml order + each slide's shapes: [{id, index, part, title, titleHash, shapes:[{id, name, ordinal, kind, text, hash}]}] */
export function parseDeck(bytes) {
  const zip = openZip(bytes);
  const px = zip.readText("ppt/presentation.xml");
  if (px == null) throw new Error("ppt/presentation.xml missing");
  const budget = deckBudget(); // the presentation, its relationships and every slide of one reading share it
  const rels = readRels(zip, "ppt/presentation.xml", budget);
  const slides = [];
  walkXml(px, {
    onOpen(n, a) {
      if (local(n) === "sldId") slides.push({ id: a.id ?? null, index: slides.length, part: rels.get(attrOf(a, "id")) || null });
    },
  }, budget);
  // read once; a reading that failed (past a cap) fails the same way every time it is asked again, never "already read"
  let loaded = false;
  let failed = null;
  const load = () => {
    if (failed) throw failed;
    if (loaded) return;
    try {
      const count = { shapes: 0, budget };
      const read = slides.map((s) => readSlide(zip, s.part, count));
      slides.forEach((s, i) => Object.assign(s, read[i]));
      loaded = true;
    } catch (err) {
      failed = err;
      throw err;
    }
  };
  return { slides, ensure: load };
}

function readSlide(zip, part, count = { shapes: 0, budget: deckBudget() }) {
  const out = { shapes: [], title: "", titleHash: EMPTY };
  const xml = part ? zip.readText(part) : null;
  if (xml == null) return out;
  const stack = []; // open shape containers
  let para = null; // current paragraph text of the innermost shape
  let inT = false;
  const seen = new Map();
  const at = []; // open element names, to tell a text color (rPr > solidFill > srgbClr) from any other color in the slide
  let mcFallbackDepth = 0;
  walkXml(xml, {
    onOpen(n, a) {
      if (n === "mc:Fallback" || mcFallbackDepth > 0) {
        if (n === "mc:Fallback") mcFallbackDepth++;
        return;
      }
      const l = local(n);
      at.push(l);
      if (SHAPE_TAGS.has(l) && ++count.shapes > MAX_SHAPES) throw tooMany(count.budget, MAX_SHAPES, "shapes");
      if (SHAPE_TAGS.has(l)) stack.push({ tag: l, id: null, name: "", paras: [], isTitle: false, runs: [], run: null });
      else if (!stack.length) return;
      const top = stack[stack.length - 1];
      if (l === "r") top.run = { text: false, p: {} };
      else if (top.run && l === "rPr") Object.assign(top.run.p, { b: a.b === "1" || a.b === "true" ? "1" : "", i: a.i === "1" || a.i === "true" ? "1" : "", u: a.u && a.u !== "none" ? a.u : "", size: a.sz || "", strike: a.strike && a.strike !== "noStrike" ? a.strike : "" });
      else if (top.run && (l === "srgbClr" || l === "schemeClr") && at[at.length - 2] === "solidFill" && at[at.length - 3] === "rPr") top.run.p.color = String(a.val || "").toUpperCase();
      else if (top.run && l === "latin" && at[at.length - 2] === "rPr") top.run.p.font = a.typeface || "";
      if (l === "cNvPr" && top && top.id === null) {
        top.id = /^\d+$/.test(a.id ?? "") ? Number(a.id) : null;
        top.name = a.name ?? "";
      } else if (l === "ph" && top) {
        top.ph = a.type || "object"; // no type = a content placeholder
        if (a.type === "title" || a.type === "ctrTitle") top.isTitle = true;
      }
      else if (l === "p" && top) para = "";
      else if (l === "t" && para !== null) (inT = true, top.run && (top.run.text = true));
      else if (l === "br" && para !== null) para += "\n";
      else if (l === "tc" && top) top.cellStart = true;
    },
    onText(t) {
      if (mcFallbackDepth > 0) return;
      if (inT && para !== null) para += t;
    },
    onClose(n) {
      if (mcFallbackDepth > 0) {
        if (n === "mc:Fallback") mcFallbackDepth--;
        return;
      }
      const l = local(n);
      at.pop();
      if (l === "r" && stack.length) {
        const top = stack[stack.length - 1];
        if (top.run?.text) top.runs.push(top.run.p);
        top.run = null;
      }
      if (l === "t") inT = false;
      else if (l === "p" && para !== null && stack.length) {
        stack[stack.length - 1].paras.push(para);
        para = null;
      } else if (SHAPE_TAGS.has(l) && stack.length) {
        const sh = stack.pop();
        const text = sh.paras.join("\n");
        const id = sh.id ?? -1;
        const ordinal = seen.get(id) || 0;
        seen.set(id, ordinal + 1);
        out.shapes.push({ id, name: sh.name, ordinal, kind: KIND[sh.tag], text, hash: textHash(text), isTitle: sh.isTitle, placeholder: sh.ph || null, fmt: summarizeRuns(sh.runs) });
        if (sh.isTitle && !out.title) out.title = text;
      }
    },
  }, count.budget);
  out.titleHash = textHash(out.title);
  return out;
}

/** `onionskin shapes`: every shape of one slide (or of all slides) as {shape_id, name, kind, placeholder, text_preview}; read-only, from the PPTX parts. */
export function listShapes(deck, slideId = null) {
  deck.ensure();
  const slides = slideId == null ? deck.slides : deck.slides.filter((s) => s.id === String(slideId));
  if (!slides.length) throw new Error(`no slide with id ${JSON.stringify(String(slideId).slice(0, 40))}; the slide ids are ${deck.slides.map((s) => s.id).join(", ")}`);
  return slides.map((s) => ({
    slide_id: s.id,
    slide_index: s.index + 1,
    shapes: s.shapes.map((sh) => ({ shape_id: sh.id, name: untrusted(sh.name, 100), kind: sh.kind, placeholder: sh.placeholder, text_preview: untrusted(normText(sh.text), 80) })),
  }));
}

const slideById = (deck, id) => deck.slides.find((s) => s.id === String(id)) || null;

// The budget (src/text.js scanBudget): resolving an anchor reads slides, the shapes of a slide and a shape's text, once per anchor. Each
// such read is spent before it runs, and an anchor whose spend fails resolves as "moved or removed" (the slide or shape alone when
// it is all that is known). Index-free scans here are over the slides of a deck or the shapes of a slide, both bounded by MAX_* at parse.
const slideCost = (deck) => deck.slides.length * 4 + 1;
const shapeCost = (slide) => slide.shapes.length * 8 + 1;

/**
 * Engine location {slideIndex, slideId?, shapeId?, shapeName?, cell?} (+ the text the browser saw) -> durable anchor, from the written
 * bytes. `ctx` = {quote, prefix, suffix, text}. Returns null when the slide does not exist.
 */
export function pptxDurable(deck, loc, ctx = {}) {
  deck.ensure();
  const slide = (loc.slideId != null && spend(slideCost(deck)) && slideById(deck, loc.slideId)) || deck.slides[loc.slideIndex];
  if (!slide) return null;
  const base = { format: "pptx", ...(loc.protected ? { protected: true } : {}), slideId: slide.id, slidePart: slide.part, slideIndex: slide.index, slideTitle: titleOf(slide), titleHash: slide.titleHash, shapeId: null, shapeName: "", ordinal: 0, kind: "slide", text: "", textHash: null, quote: "", prefix: "", suffix: "", start: null, end: null, cell: loc.cell || null };
  if (loc.shapeId == null || !spend(shapeCost(slide))) return base;
  const same = slide.shapes.filter((s) => s.id === loc.shapeId);
  let sh = same[0];
  if (same.length > 1) {
    // the page's text is hashed only when the budget pays for it (null: told apart by name, then the first)
    const seen = ctx.text || ctx.quote || "";
    const want = affords(seen.length) && spend(weigh(seen)) ? textHash(seen) : null;
    sh = same.find((s) => s.name === loc.shapeName && s.hash === want) || same.find((s) => s.hash === want) || same.find((s) => s.name === loc.shapeName) || same[0];
  }
  if (!sh) return { ...base, shapeId: loc.shapeId, shapeName: loc.shapeName || "", kind: "shape" };
  // the page's quote, prefix and suffix are normalized within the budget too (each can be a whole shape's text, per comment); past it
  // the anchor is the shape, without the text range
  const q = normPaid(ctx.quote) ?? "";
  const raw = q ? ctx.quote : "";
  const prefix = (normPaid(ctx.prefix) ?? "").slice(-CTX);
  const suffix = (normPaid(ctx.suffix) ?? "").slice(0, CTX);
  const hintStart = Number.isInteger(loc.start) ? loc.start : null;
  const ctxOpts = { prefix, suffix, nth: ctx.nth ?? ctx.occ ?? null, hintStart };
  let at = -1;
  let len = raw.length;
  let k = null;
  if (q && !ctx.shapeWide) {
    const preferNorm = raw !== q || (q.includes(" ") && HAS_NON_PLAIN_WS.test(sh.text));
    if (preferNorm) {
      const m = findNormMatch(sh, q, ctxOpts);
      if (m) [at, len, k] = [m.start, m.end - m.start, m.k];
    } else {
      const exact = spend(textCost(sh, raw)) ? findExactMatch(sh, raw, ctxOpts) : null;
      if (exact) [at, len, k] = [exact.start, exact.end - exact.start, exact.k];
      else if (exact === undefined) {
        const m = findNormMatch(sh, q, ctxOpts);
        if (m) [at, len, k] = [m.start, m.end - m.start, m.k];
      }
    }
  }
  return {
    ...base,
    shapeId: sh.id, shapeName: sh.name, ordinal: sh.ordinal, kind: sh.kind,
    text: spend(normCost(sh)) ? normShape(sh).slice(0, KEEP) : "", textHash: sh.hash,
    // a text range inside the shape: the quote and what surrounds it
    quote: ctx.shapeWide ? "" : q,
    prefix,
    suffix,
    start: !ctx.shapeWide && at >= 0 ? at : null,
    end: !ctx.shapeWide && at >= 0 ? at + len : null,
    nth: !ctx.shapeWide && at >= 0 ? k : null,
  };
}

const MARK = /\p{M}/u;
const WS_CHAR = /\s/;
export const HAS_NON_PLAIN_WS = /[\t\r\n\f\v\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]|  /;
/**
 * May a window start (or end) right before text[i]? Yes below U+0300 (no such character joins the one before it under NFC); never inside a
 * surrogate pair or before a combining mark; otherwise when the character normalizes the same after the three before it as on its own
 * (the longest chain of starters that compose, Hangul L V T and its like, is three: test/parse-limits.test.js checks every code point).
 * Exported for src/docx.js and its test.
 */
export function cuttable(text, i) {
  if (i <= 0 || i >= text.length) return true;
  const c = text.charCodeAt(i);
  if (c < 0x300) return true;
  if (c >= 0xdc00 && c <= 0xdfff) return false;
  const ch = String.fromCodePoint(text.codePointAt(i));
  if (MARK.test(ch)) return false;
  const before = text.slice(Math.max(0, i - 3), i);
  return (before + ch).normalize("NFC") === before.normalize("NFC") + ch.normalize("NFC");
}

function buildNormMap(text) {
  const parts = [];
  const starts = [];
  const ends = [];
  let seenNonWs = false;
  for (let i = 0; i < text.length; ) {
    if (WS_CHAR.test(text[i])) {
      let j = i + 1;
      while (j < text.length && WS_CHAR.test(text[j])) j++;
      if (seenNonWs && j < text.length) {
        parts.push(" ");
        starts.push(i);
        ends.push(j);
      }
      i = j;
      continue;
    }
    let j = i + (text.codePointAt(i) > 0xffff ? 2 : 1);
    while (j < text.length && !WS_CHAR.test(text[j]) && !cuttable(text, j)) {
      j += text.codePointAt(j) > 0xffff ? 2 : 1;
    }
    const chunk = nfc(text.slice(i, j));
    if (chunk) {
      parts.push(chunk);
      for (let k = 0; k < chunk.length; k++) {
        starts.push(i);
        ends.push(j);
      }
      seenNonWs = true;
    }
    i = j;
  }
  return { norm: parts.join(""), starts: Int32Array.from(starts), ends: Int32Array.from(ends) };
}

const NORM_MAP = new WeakMap();
const NORM_HITS = new WeakMap();
const NORM_OCC = new WeakMap();
const RAW_OCC = new WeakMap();
const OCC_KEEP = 16;
export function normMapFor(unit) {
  let map = NORM_MAP.get(unit);
  if (map === undefined) {
    if (!spend(weigh(unit.text))) return null;
    NORM_MAP.set(unit, (map = buildNormMap(unit.text)));
  }
  return map;
}
export function normOccurrences(unit, q, max = Infinity) {
  const nq = normText(q);
  if (!nq) return [];
  if (max === Infinity) {
    const cached = NORM_OCC.get(unit)?.get(nq);
    if (cached) return cached;
  }
  const map = normMapFor(unit);
  if (!map) return null;
  if (!spend(searchCost(map.norm.length, nq, hitsOf(NORM_HITS, unit, map.norm, nq)))) return null;
  const out = [];
  for (let i = map.norm.indexOf(nq); i >= 0 && out.length < max; i = map.norm.indexOf(nq, i + nq.length)) {
    if (!spend(OCCURRENCE)) return null;
    out.push({ start: map.starts[i], end: map.ends[i + nq.length - 1], normStart: i, normEnd: i + nq.length });
  }
  if (max === Infinity) {
    let m = NORM_OCC.get(unit);
    if (!m) NORM_OCC.set(unit, (m = new Map()));
    if (m.size >= OCC_KEEP) m.delete(m.keys().next().value);
    m.set(nq, out);
  }
  return out;
}

function exactOccurrencesIn(sh, raw, first, second, ctxPerOcc = 0) {
  let m = RAW_OCC.get(sh);
  const cached = m?.get(raw);
  if (cached) return cached;
  if (!spend(2 * OCCURRENCE)) return null;
  const occ = [first, second];
  for (let i = sh.text.indexOf(raw, second + raw.length); i >= 0; i = sh.text.indexOf(raw, i + raw.length)) {
    if (ctxPerOcc && !affords((occ.length + 1) * ctxPerOcc)) return null;
    if (!spend(OCCURRENCE)) return null;
    occ.push(i);
  }
  if (!m) RAW_OCC.set(sh, (m = new Map()));
  if (m.size >= OCC_KEEP) m.delete(m.keys().next().value);
  m.set(raw, occ);
  return occ;
}

function findExactMatch(sh, raw, { prefix = "", suffix = "", nth = null, hintStart = null } = {}) {
  const first = sh.text.indexOf(raw);
  if (first < 0) return undefined;
  const second = sh.text.indexOf(raw, first + raw.length);
  if (second < 0) return { start: first, end: first + raw.length, k: 0 };
  if (Number.isInteger(hintStart) && hintStart >= 0 && sh.text.slice(hintStart, hintStart + raw.length) === raw) {
    let k = 0;
    let found = false;
    for (let i = first; i >= 0 && i <= hintStart; i = sh.text.indexOf(raw, i + raw.length)) {
      if (!spend(OCCURRENCE)) {
        k = null;
        break;
      }
      if (i === hintStart) {
        found = true;
        break;
      }
      k++;
    }
    return { start: hintStart, end: hintStart + raw.length, k: found ? k : null };
  }
  const pre = normText(prefix).slice(-CTX);
  const suf = normText(suffix).slice(0, CTX);
  const ctxPerOcc = pre || suf ? 2 * (pre.length + suf.length + 16) : 0;
  const occ = exactOccurrencesIn(sh, raw, first, second, ctxPerOcc);
  if (!occ) return null;
  if (ctxPerOcc && !spend(occ.length * ctxPerOcc)) return null;
  const guarded = [];
  for (let i = 0; i < occ.length; i++) {
    const at = occ[i];
    const okPre = !pre || normText(sh.text.slice(Math.max(0, at - 4 * pre.length - 16), at)).endsWith(pre);
    const okSuf = !suf || normText(sh.text.slice(at + raw.length, at + raw.length + 4 * suf.length + 16)).startsWith(suf);
    if (okPre && okSuf) guarded.push(i);
  }
  const validNth = Number.isInteger(nth) && nth >= 0 && nth < occ.length ? nth : null;
  let idx;
  if (guarded.length === 1) idx = guarded[0];
  else if (validNth !== null && guarded.includes(validNth)) idx = validNth;
  else if (Number.isInteger(hintStart) && guarded.length) {
    idx = guarded.reduce((best, i) => (Math.abs(occ[i] - hintStart) < Math.abs(occ[best] - hintStart) ? i : best), guarded[0]);
  } else if (guarded.length) idx = guarded[0];
  else idx = validNth !== null ? validNth : 0;
  return { start: occ[idx], end: occ[idx] + raw.length, k: idx };
}

function findNormMatch(sh, q, { prefix = "", suffix = "", nth = null, hintStart = null } = {}) {
  const pre = normText(prefix).slice(-CTX);
  const suf = normText(suffix).slice(0, CTX);
  const needAll = !!(pre || suf || Number.isInteger(nth) || Number.isInteger(hintStart));
  const occ = normOccurrences(sh, q, needAll ? Infinity : 1);
  if (!occ?.length) return null;
  if (occ.length === 1) return { ...occ[0], k: 0 };
  const validNth = Number.isInteger(nth) && nth >= 0 && nth < occ.length ? nth : null;
  if ((pre || suf) && !spend(occ.length * 2 * (pre.length + suf.length + 16))) return null;
  const map = normMapFor(sh);
  const guarded = [];
  for (let i = 0; i < occ.length; i++) {
    const o = occ[i];
    const okPre = !pre || !map || map.norm.slice(Math.max(0, o.normStart - pre.length - 1), o.normStart).trimEnd().endsWith(pre);
    const okSuf = !suf || !map || map.norm.slice(o.normEnd, o.normEnd + suf.length + 1).trimStart().startsWith(suf);
    if (okPre && okSuf) guarded.push(i);
  }
  let idx;
  if (guarded.length === 1) idx = guarded[0];
  else if (validNth !== null && guarded.includes(validNth)) idx = validNth;
  else if (Number.isInteger(hintStart) && guarded.length) {
    idx = guarded.reduce((best, i) => (Math.abs(occ[i].start - hintStart) < Math.abs(occ[best].start - hintStart) ? i : best), guarded[0]);
  } else if (guarded.length) idx = guarded[0];
  else idx = validNth !== null ? validNth : 0;
  return { ...occ[idx], k: idx };
}

// A shape's normalized text, kept per shape of a reading: every anchor on a shape normalized all of it again (50 comments on a shape of
// 8 million characters held the server's thread for 5.6 s while the page placed them).
const NORM = new WeakMap();
const normShape = (sh) => {
  let v = NORM.get(sh);
  if (v === undefined) NORM.set(sh, (v = normText(sh.text)));
  return v;
};
// A slide's normalized title, kept per slide of a reading and paid from the budget the first time: every anchor on a slide normalized the
// whole title again, outside the budget. Past the budget the anchor has no title text ("", asked again by the next request); the title's
// hash, read with the slide, still identifies it.
const TITLE = new WeakMap();
const titleOf = (slide) => {
  let v = TITLE.get(slide);
  if (v === undefined) {
    const t = normPaid(slide.title);
    if (t === null) return "";
    TITLE.set(slide, (v = t.slice(0, 120)));
  }
  return v;
};
/** what normShape(sh) is about to read: the shape's text the first time (src/text.js weigh), nothing once it is kept */
const normCost = (sh) => (NORM.has(sh) ? 0 : weightOf(sh));
/** a native substring search for `q` in a shape's text (src/text.js searchCost), priced by the shape's byte table (src/text.js hitsOf) */
const HITS = new WeakMap();
const textCost = (sh, q) => searchCost(sh.text.length, q, hitsOf(HITS, sh, sh.text, q));

/**
 * Re-resolve against new bytes. Slide: by p:sldId id; else the part path together with the title; else the title alone when unique.
 * Shape (when the anchor has one): by id (+ ordinal); else the same name with the same text; else the same text; else the same name.
 * Result: {method, slideId, slideIndex, shapeId, shapeName, start, end, changed, text} or {method:"none"}. A deleted slide or shape is "none".
 */
export function resolvePptx(deck, d) {
  if (!d) return { method: "none" };
  deck.ensure();
  if (!spend(slideCost(deck))) return { method: "none" };
  let slide = d.slideId != null ? slideById(deck, d.slideId) : null;
  let method = "id";
  if (!slide) {
    const part = deck.slides.filter((s) => s.part && s.part === d.slidePart && s.titleHash === d.titleHash && d.titleHash !== EMPTY);
    const title = deck.slides.filter((s) => s.titleHash === d.titleHash && d.titleHash !== EMPTY);
    if (part.length === 1) [slide, method] = [part[0], "part"];
    else if (title.length === 1) [slide, method] = [title[0], "title"];
  }
  if (!slide) return { method: "none" };
  const out = { method, slideId: slide.id, slideIndex: slide.index, shapeId: null, shapeName: "", start: null, end: null, changed: false, text: "", titleChanged: slide.titleHash !== d.titleHash };
  if (d.shapeId == null) return out;
  const shapes = slide.shapes;
  if (!spend(shapeCost(slide))) return { method: "none" };
  const byId = shapes.filter((s) => s.id === d.shapeId);
  let sh = null;
  let how = "";
  if (byId.length === 1) [sh, how] = [byId[0], "id"];
  else if (byId.length > 1) {
    sh = byId.find((s) => s.ordinal === d.ordinal && (s.name === d.shapeName || s.hash === d.textHash)) || byId.find((s) => s.name === d.shapeName && s.hash === d.textHash) || null;
    if (sh) how = "id";
  }
  if (!sh) {
    const nameText = shapes.filter((s) => s.name && s.name === d.shapeName && s.hash === d.textHash);
    const text = shapes.filter((s) => d.textHash && d.textHash !== EMPTY && s.hash === d.textHash);
    const name = shapes.filter((s) => s.name && s.name === d.shapeName);
    if (nameText.length === 1) [sh, how] = [nameText[0], "name+text"];
    else if (text.length === 1) [sh, how] = [text[0], "text"];
    else if (name.length === 1 && d.textHash && d.textHash !== EMPTY) [sh, how] = [name[0], "name"];
  }
  if (!sh) return { method: "none" };
  // The shape is found (by its id, or its name and the hash read with the slide). Its text and the quote's place in it are read only when
  // the budget pays for them: past it the comment is still on its shape, without a text excerpt or a range (a shape of 7.9 million CJK
  // characters costs more than the whole budget to normalize, and its comments resolved as "moved or removed" with the shape right there).
  const stext = spend(normCost(sh)) ? normShape(sh) : "";
  const q = d.quote || "";
  const searched = !!q && spend(textCost(sh, q)); // a shape-wide comment has no quote, and no search to pay for
  const ctxOpts = { prefix: d.prefix ?? d.before ?? "", suffix: d.suffix ?? d.after ?? "", nth: d.nth ?? d.occ ?? null };
  let at = -1;
  let len = q.length;
  let k = null;
  if (searched) {
    const preferNorm = q.includes(" ") && HAS_NON_PLAIN_WS.test(sh.text);
    if (preferNorm) {
      if (stext) {
        const m = findNormMatch(sh, q, ctxOpts);
        if (m) [at, len, k] = [m.start, m.end - m.start, m.k];
      }
    } else {
      const exact = findExactMatch(sh, q, ctxOpts);
      if (exact && !(Number.isInteger(ctxOpts.nth) && ctxOpts.nth > 0 && exact.k !== ctxOpts.nth)) {
        [at, len, k] = [exact.start, exact.end - exact.start, exact.k];
      } else if (exact !== null && stext) {
        const m = findNormMatch(sh, q, ctxOpts);
        if (m) [at, len, k] = [m.start, m.end - m.start, m.k];
        else if (exact) [at, len, k] = [exact.start, exact.end - exact.start, exact.k];
      } else if (exact) {
        [at, len, k] = [exact.start, exact.end - exact.start, exact.k];
      }
    }
  }
  return { ...out, method: method === "id" ? how : `${method}+${how}`, shapeId: sh.id, shapeName: sh.name, start: at >= 0 ? at : null, end: at >= 0 ? at + len : null, nth: at >= 0 ? k : null, changed: sh.hash !== d.textHash, text: stext.slice(0, 200), quoteLost: searched && at < 0 };
}

/** Locator fields for the batch: the names the `apply` targets use. */
export const pptxLocator = (d) =>
  d ? { slide_id: /^\d{1,10}$/.test(String(d.slideId ?? "")) ? String(d.slideId) : null, shape_id: Number.isInteger(d.shapeId) ? d.shapeId : null, text_hash: d.textHash ?? null, start: d.start ?? null, end: d.end ?? null } : null;
