// The document reading and anchor work of one request, as plain data in and out, with no session state: building anchors from the page's
// (Send, a comment queued during a run, a quick fix's Use), moving stored ones onto newer bytes (done, revert), resolving them for the page
// (resolve), placing a quick fix's selection (suggest), the review cards' check (done of a review) and the outline of a batch for an agent
// Onionskin started. The server runs it in a warm worker thread with a time limit (src/anchor-worker.js, src/offload.js anchorsOffThread),
// so a crafted file never holds the server's thread; the synchronous Sessions methods tests call run it on their own thread. Either way
// it runs under a scan budget (src/text.js scanBudget) as a second line: past it an anchor is made weaker or resolves as moved or removed.
import { buildDurable, readAll, resolveDurableAny, resolveView, unitsFor, viewDurable } from "./anchors.js";
import { durableFromEngine, headingBefore, resolveDurable } from "./docx.js";
import { capDurable, cutText } from "./retain.js";
import { OUTLINE_FILE_MAX, cardsFrom, outlineOf } from "./review.js";
import { buildUseReply, placeOf, selectionOf } from "./suggest-reply.js";
import { normText, scanBudget } from "./text.js";
import { parseA1 } from "./ops/common.js";
import { validatePackage } from "./package.js";
import { CapError } from "./xml.js";
import { unknownFormat } from "./constants.js";

/** A stored durable anchor re-resolved against `units` (the bytes the agent will read next); null when the unit is gone. Without a durable, one is built from the browser's anchor. */
export function reanchor(units, c) {
  const d = c.durable;
  if (!d) return buildDurable(units, c.anchor);
  const r = resolveDurableAny(units, d);
  if (r.method === "none") return null;
  if (units.format === "docx") return capDurable({ ...d, ...r, format: "docx", quote: d.quote, prefix: d.prefix, suffix: d.suffix, paraText: r.text, engineDelta: r.engineDelta });
  if (units.format === "xlsx") return buildDurable(units, { location: { sheetIndex: r.sheetIndex, sheetName: r.sheetName, range: r.range } });
  if (units.format === "pptx") return buildDurable(units, { location: { slideIndex: r.slideIndex, slideId: r.slideId, shapeId: r.shapeId ?? undefined, shapeName: r.shapeName, cell: d.cell || undefined }, quote: d.quote, prefix: d.prefix, suffix: d.suffix, hitKind: d.quote ? undefined : "shape" });
  // the resolved place in the page's own offsets (src/html.js pageLocation), which htmlDurable reads
  if (units.format === "html") return buildDurable(units, { location: r.page?.start != null ? r.page : { nodeId: r.nodeId }, quote: d.quote, prefix: d.prefix, suffix: d.suffix, hitKind: d.quote ? undefined : "element" });
  return unknownFormat(units.format, "reanchor");
}

/** The page's anchor made durable, with a PowerPoint pin's slide as its fallback (a pin on a deleted shape stays on its slide). */
function built(units, anchor, pin) {
  const d = buildDurable(units, anchor);
  if (pin && units.format === "pptx" && d?.shapeId != null) d.pinFallback = buildDurable(units, { location: { slideIndex: d.slideIndex, slideId: d.slideId } });
  return d;
}

/** The view the page reported at Send ({format, ...}), made durable against `units`. */
export function viewOf(units, vs) {
  if (!vs) return null;
  if (units.format === "docx" && vs.format !== "docx") return { format: units.format, raw: vs };
  if (units.format !== "docx") return viewDurable(units, vs) || { format: units.format, raw: vs };
  const d = durableFromEngine(units.paragraphs, { blockPath: vs.blockPath }, { quote: vs.quote });
  return { format: "docx", durable: d, offsetPx: Number(vs.offsetPx) || 0, zoom: vs.zoom ?? "fit", fraction: vs.fraction };
}

/** What the page's resolve shows: every comment's anchor (by id) and the view, in terms of `units`. */
export function resolveAllOf(units, comments, view) {
  const out = { anchors: {}, view: null };
  for (const c of comments) {
    let r = resolveDurableAny(units, c.durable);
    if (r.method === "none" && units.format === "pptx" && c.durable.pinFallback) {
      const f = resolveDurableAny(units, c.durable.pinFallback);
      if (f.method !== "none") r = { ...f, tieLost: true };
    }
    if (units.format === "docx" && r.method !== "none") r.heading = headingBefore(units.paragraphs, r.ordinal);
    if (typeof r.text === "string") r.text = cutText(r.text, 4000); // what the page shows of it; resolved text is never stored
    out.anchors[c.id] = r;
  }
  if (units.format === "pptx") out.slides = units.deck.slides.map((x) => ({ index: x.index, id: x.id }));
  if (units.format === "docx") {
    if (view?.durable) out.view = { ...resolveDurable(units.paragraphs, view.durable), offsetPx: view.offsetPx, zoom: view.zoom, fraction: view.fraction };
  } else out.view = resolveView(units, view);
  if (units.format === "xlsx") out.sheets = units.wb.sheets.map((x) => ({ index: x.index, name: x.name, sheetId: x.sheetId }));
  return out;
}

/**
 * When the work did not finish (its time limit, a crash, too many at once), a comment still goes out, weaker, the way a spent budget
 * leaves it: an Excel anchor keeps its sheet and address, with no hash and no context (src/xlsx.js resolves such an anchor by its
 * address); a Word or PowerPoint one is "unresolved location" with the page's quote (its place in the paragraph needs the file). Never an
 * error that loses the comment.
 */
export function weakDurable(format, anchor) {
  const loc = anchor?.location;
  // HTML: the page's quote, its context and the node id it named (a hint for that version only): resolved by searching the quote
  // (src/html.js resolveHtml), never by a path it does not have
  if (format === "html") {
    if (!loc || !Number.isInteger(loc.nodeId)) return null;
    const quote = anchor.hitKind ? "" : cutText(normText(String(anchor.quote ?? "")), 2000);
    const text = anchor.hitKind ? cutText(normText(String(anchor.quote ?? "")), 2000) : "";
    return { format: "html", nodeId: loc.nodeId, path: null, tag: null, elementId: null, kind: "element", flatAt: 0, textHash: null, text, quote, prefix: cutText(normText(String(anchor.prefix ?? "")).slice(-40), 40), suffix: cutText(normText(String(anchor.suffix ?? "")), 40), start: null, end: null, heading: "", fallback: true };
  }
  if (format !== "xlsx" || !loc || typeof loc.sheetName !== "string") return null;
  const range = typeof loc.range === "string" ? cutText(loc.range, 40) : "";
  const base = { format: "xlsx", sheetId: null, sheetName: cutText(loc.sheetName, 200), sheetIndex: Number.isInteger(loc.sheetIndex) ? loc.sheetIndex : 0, range, textHash: null, names: [], weak: true };
  const q = parseA1(range);
  if (!q) return { ...base, cell: false, text: "", ctx: null };
  return { ...base, cell: true, r0: q.r0, c0: q.c0, r1: q.r1, c1: q.c1, text: "", values: [], rangeHash: null, ctx: { rowHeader: "", colHeader: "", left: "", right: "", up: "", down: "", rowCells: [] } };
}

function one(units, t, bytes, sha) {
  switch (t.op) {
    case "build":
      return built(units, t.anchor, t.pin);
    case "reanchor":
      return reanchor(units, t.c);
    case "view":
      return viewOf(units, t.vs);
    case "use": {
      // a quick fix's Use: where the stored suggestion goes in these bytes, and the one reply that writes it (the widening's searches are paid from the same budget)
      const d = buildDurable(units, t.anchor);
      const p = placeOf(units, d, t.rec.quote);
      return { durable: d, place: { ok: p.ok, code: p.code }, reply: p.ok ? buildUseReply(t.rec, t.id, p.text) : null };
    }
    case "select":
      return selectionOf(units, buildDurable(units, t.anchor), t.anchor, t.picked, t.limits);
    case "resolveAll":
      return resolveAllOf(units, t.comments, t.view);
    case "cards":
      return cardsFrom(t.list, { bytes, sha, format: units.format, units: t.units, index: t.index, reviewId: t.reviewId });
    default:
      throw new Error(`unknown task ${String(t.op).slice(0, 40)}`);
  }
}

/**
 * One request's work on one version of the file. `bytes` is the version (a Buffer, or a function that returns it, read only when the
 * reading of `sha` is not kept); `validate` runs the package check first (bytes a request carried); `check` reads every part within the
 * readers' caps first (bytes about to become the file); `tasks` is a
 * list of {op, ...}; `outline` adds the outline of the file for an agent Onionskin started. Returns {read: {ok: true} | {cap} | {invalid},
 * results: one per task (a task that throws gives {error})}, and `outline` ({outline, more} of src/review.js outlineOf, or null).
 */
export function anchorWork({ format, bytes, sha, check = false, validate = false, tasks = [], outline = false, budget }) {
  let units;
  try {
    // bytes from a request: the package check first, as the open worker does (an HTML file has no package: readHtml checks its size,
    // encoding and limits as it reads it)
    if (validate && format !== "html") validatePackage(bytes, format);
    units = unitsFor(format, bytes, sha);
    if (check) readAll(units);
  } catch (err) {
    return { read: err instanceof CapError ? { cap: err.message } : { invalid: String(err?.message || err).slice(0, 200) }, results: tasks.map(() => ({ error: "unreadable" })) };
  }
  const results = scanBudget(budget, () =>
    tasks.map((t) => {
      try {
        return one(units, t, bytes, sha);
      } catch (err) {
        return { error: String(err?.message || err).slice(0, 200) };
      }
    }),
  );
  let all = null;
  if (outline) {
    try {
      all = outlineOf(format, typeof bytes === "function" ? null : bytes, OUTLINE_FILE_MAX, units);
    } catch {
      all = null;
    }
  }
  return { read: { ok: true }, results, ...(outline ? { outline: all } : {}) };
}
