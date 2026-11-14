import { attrOf, local, readRels } from "./xlsx.js";
import { walkXml } from "./xml.js";
import { normText, similarity, textHash } from "./text.js";
import { openZip } from "./zip.js";
import { summarizeRuns } from "./fmt.js";
import { untrusted } from "./sanitize.js";

// PPTX durable anchors. A slide is identified by its p:sldId id (stable across reorder, insert and delete; the part path is only a hint,
// writers renumber parts), a shape by its cNvPr id plus its name and its ordinal among shapes with the same id. Shape text is the
// paragraphs joined by LF, as `onionskin apply` reads it.

const EMPTY = textHash("");
const CTX = 40;
const KEEP = 2000;

const SHAPE_TAGS = new Set(["sp", "pic", "graphicFrame", "grpSp", "cxnSp"]);
const KIND = { sp: "shape", pic: "image", graphicFrame: "table", grpSp: "group", cxnSp: "line" };

/** ppt/presentation.xml order + each slide's shapes: [{id, index, part, title, titleHash, shapes:[{id, name, ordinal, kind, text, hash}]}] */
export function parseDeck(bytes) {
  const zip = openZip(bytes);
  const px = zip.readText("ppt/presentation.xml");
  if (px == null) throw new Error("ppt/presentation.xml missing");
  const rels = readRels(zip, "ppt/presentation.xml");
  const slides = [];
  walkXml(px, {
    onOpen(n, a) {
      if (local(n) === "sldId") slides.push({ id: a.id ?? null, index: slides.length, part: rels.get(attrOf(a, "id")) || null });
    },
  });
  let loaded = false;
  const load = () => {
    if (loaded) return;
    loaded = true;
    for (const s of slides) Object.assign(s, readSlide(zip, s.part));
  };
  return { slides, ensure: load };
}

function readSlide(zip, part) {
  const out = { shapes: [], title: "", titleHash: EMPTY };
  const xml = part ? zip.readText(part) : null;
  if (xml == null) return out;
  const stack = []; // open shape containers
  let para = null; // current paragraph text of the innermost shape
  let inT = false;
  const seen = new Map();
  const at = []; // open element names, to tell a text color (rPr > solidFill > srgbClr) from any other color in the slide
  walkXml(xml, {
    onOpen(n, a) {
      const l = local(n);
      at.push(l);
      if (SHAPE_TAGS.has(l)) stack.push({ tag: l, id: null, name: "", paras: [], isTitle: false, runs: [], run: null });
      else if (!stack.length) return;
      const top = stack[stack.length - 1];
      if (l === "r") top.run = { text: false, p: {} };
      else if (top.run && l === "rPr") Object.assign(top.run.p, { b: a.b === "1" || a.b === "true" ? "1" : "", i: a.i === "1" || a.i === "true" ? "1" : "", u: a.u && a.u !== "none" ? a.u : "", size: a.sz || "", strike: a.strike && a.strike !== "noStrike" ? a.strike : "" });
      else if (top.run && (l === "srgbClr" || l === "schemeClr") && at[at.length - 2] === "solidFill" && at[at.length - 3] === "rPr") top.run.p.color = String(a.val || "").toUpperCase();
      else if (top.run && l === "latin" && at[at.length - 2] === "rPr") top.run.p.font = a.typeface || "";
      if (l === "cNvPr" && top && top.id === null) {
        top.id = a.id != null ? Number(a.id) : null;
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
      if (inT && para !== null) para += t;
    },
    onClose(n) {
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
  });
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

/**
 * Engine location {slideIndex, slideId?, shapeId?, shapeName?, cell?} (+ the text the browser saw) -> durable anchor, from the written
 * bytes. `ctx` = {quote, prefix, suffix, text}. Returns null when the slide does not exist.
 */
export function pptxDurable(deck, loc, ctx = {}) {
  deck.ensure();
  const slide = (loc.slideId != null && slideById(deck, loc.slideId)) || deck.slides[loc.slideIndex];
  if (!slide) return null;
  const base = { format: "pptx", ...(loc.protected ? { protected: true } : {}), slideId: slide.id, slidePart: slide.part, slideIndex: slide.index, slideTitle: normText(slide.title).slice(0, 120), titleHash: slide.titleHash, shapeId: null, shapeName: "", ordinal: 0, kind: "slide", text: "", textHash: null, quote: "", prefix: "", suffix: "", start: null, end: null, cell: loc.cell || null };
  if (loc.shapeId == null) return base;
  const same = slide.shapes.filter((s) => s.id === loc.shapeId);
  let sh = same[0];
  if (same.length > 1) {
    const want = textHash(ctx.text || ctx.quote || "");
    sh = same.find((s) => s.name === loc.shapeName && s.hash === want) || same.find((s) => s.hash === want) || same.find((s) => s.name === loc.shapeName) || same[0];
  }
  if (!sh) return { ...base, shapeId: loc.shapeId, shapeName: loc.shapeName || "", kind: "shape" };
  const q = normText(ctx.quote || "");
  const raw = ctx.quote || "";
  const at = q ? sh.text.indexOf(raw) : -1;
  return {
    ...base,
    shapeId: sh.id, shapeName: sh.name, ordinal: sh.ordinal, kind: sh.kind,
    text: normText(sh.text).slice(0, KEEP), textHash: sh.hash,
    // a text range inside the shape: the quote and what surrounds it
    quote: ctx.shapeWide ? "" : q,
    prefix: normText(ctx.prefix || "").slice(-CTX),
    suffix: normText(ctx.suffix || "").slice(0, CTX),
    start: !ctx.shapeWide && at >= 0 ? at : null,
    end: !ctx.shapeWide && at >= 0 ? at + raw.length : null,
  };
}

/**
 * Re-resolve against new bytes. Slide: by p:sldId id; else the part path together with the title; else the title alone when unique.
 * Shape (when the anchor has one): by id (+ ordinal); else the same name with the same text; else the same text; else the same name.
 * Result: {method, slideId, slideIndex, shapeId, shapeName, start, end, changed, text} or {method:"none"}. A deleted slide or shape is "none".
 */
export function resolvePptx(deck, d) {
  if (!d) return { method: "none" };
  deck.ensure();
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
  const stext = normText(sh.text);
  const q = d.quote || "";
  const at = q ? sh.text.indexOf(q) : -1;
  return { ...out, method: method === "id" ? how : `${method}+${how}`, shapeId: sh.id, shapeName: sh.name, start: at >= 0 ? at : null, end: at >= 0 ? at + q.length : null, changed: sh.hash !== d.textHash, text: stext.slice(0, 200), quoteLost: !!q && at < 0 };
}

/** Locator fields for the batch: the names the `apply` targets use. */
export const pptxLocator = (d) =>
  d ? { slide_id: /^\d{1,10}$/.test(String(d.slideId ?? "")) ? String(d.slideId) : null, shape_id: Number.isInteger(d.shapeId) ? d.shapeId : null, text_hash: d.textHash ?? null, start: d.start ?? null, end: d.end ?? null } : null;
