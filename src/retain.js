// Retained size: what the server keeps of a request (the page's anchors, typed edits, view state) and of the anchors it builds, cut to
// fixed caps where it is stored, so a crafted file or page inside the documented size limits cannot make a session file, a Send's batch
// or a draft save hundreds of MB. Over a cap a value is cut and marked (`cut: true`), never refused: an anchor keeps a prefix of its
// text and its hash of the full text where one was paid for. Only a whole request past REQUEST_MAX is refused (src/server.js), with a
// plain message the page shows. Chosen from measurement (test/retain.test.js): ordinary use is untouched, see the numbers below.

/**
 * One string field of an anchor (a quote, a paragraph's text, a typed edit's before and after). A whole-paragraph selection of an
 * ordinary document is well under it: the longest paragraph of the sample files is under 300 characters and a long report paragraph
 * 3,000 to 6,000. UTF-16 units.
 */
export const STRING_MAX = 20_000;
/** A location's own strings (a sheet or shape name, a range, a paragraph id): Excel caps a sheet name at 31 characters. */
const NAME_MAX = 1_000;
/** A page anchor's context (prefix, suffix): the server keeps 40 characters of each (src/docx.js, src/pptx.js CTX). */
const CONTEXT_MAX = 1_000;
/**
 * One stored anchor, as JSON. Measured: a whole-paragraph Word anchor about 2 to 4 KB plus its quote, a 1,000 x 20 Excel range of
 * ordinary values about 11 KB, a PowerPoint shape 3 KB; a quote at STRING_MAX makes about 25 KB. Past it an Excel anchor's values are cut
 * to VALUE_SHORT characters a cell, then the optional evidence (values, formats, kinds, names, row cells) goes; the hashes stay.
 */
export const ANCHOR_MAX = 48 * 1024;
const VALUE_SHORT = 64;
/** One comment as stored (its words, the page's anchor, the anchor built from the file): past it the page's anchor is cut further. */
export const COMMENT_MAX = 128 * 1024;
/** One request's comments, note, typed edits and view state, as JSON in UTF-8 (not the document's bytes): past it the request is refused. */
export const REQUEST_MAX = 32 * 1024 * 1024;
/** One session file, in bytes. Past it every comment's page anchor and every typed edit are cut further before it is written (the waiting
 * batch's evidence is already capped per anchor by src/batch.js); nothing is dropped. */
export const SESSION_MAX = 64 * 1024 * 1024;
/** Comments and pins of one file (drafts, sent, queued and finished): one more is refused in words (src/session.js), never dropped. */
export const COMMENTS_MAX = 500;
/** What the server says (413 too_many_comments) and the page shows when one more comment would pass COMMENTS_MAX. */
export const TOO_MANY_COMMENTS = `This file has ${COMMENTS_MAX} comments waiting; send or delete some before adding more.`;
/** The overall note, in code points: the box, the notes queued during a run and a waiting batch's note together. Past it a save or a
 * Send is refused in words (src/session.js), never cut. The page's box takes no more (web/src/Sidebar.jsx). */
export const NOTE_MAX = 20_000;
/** One comment's words, in code points (src/sanitize.js userText): the page's box takes no more, so it is never cut from the page. */
export const COMMENT_TEXT_MAX = 5_000;
/** Typed edits kept for the next batch (they accumulate over Sends until one is delivered); later ones are counted, not kept. */
export const EDITS_MAX = 2_000;
/** A Word block path: the body index, then table row, cell and paragraph, deeper for nested tables. */
const PATH_MAX = 16;

const isHigh = (c) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c) => c >= 0xdc00 && c <= 0xdfff;
// a slice keeps the whole string alive; this copy does not
const flat = (s) => Buffer.from(s, "utf16le").toString("utf16le");

/** `s` cut to its first `max` UTF-16 units (never inside a surrogate pair), as a flat string that does not hold on to the long one. */
export function cutText(s, max) {
  if (typeof s !== "string" || s.length <= max) return s;
  let n = max;
  if (n > 0 && isHigh(s.charCodeAt(n - 1)) && isLow(s.charCodeAt(n))) n--;
  return flat(s.slice(0, n));
}

/** `s` cut to its last `max` UTF-16 units (never inside a surrogate pair): the text just before a selection keeps the end nearest to it. */
export function cutTail(s, max) {
  if (typeof s !== "string" || s.length <= max) return s;
  let n = s.length - max;
  if (isLow(s.charCodeAt(n)) && isHigh(s.charCodeAt(n - 1))) n++;
  return flat(s.slice(n));
}

// Every object the page sends that is stored is rebuilt from the fields Onionskin reads, each of a known type and size; anything else is
// dropped, so the work and the size are bounded by this list, never by what the request carries.
const int = (v) => (Number.isSafeInteger(v) ? v : undefined);
const finite = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v, max) => (typeof v === "string" ? cutText(v, max) : undefined);
const idOf = (v) => int(v) ?? str(v, 64); // a PowerPoint slide or shape id: a number, or a string from older pages
const blockPath = (v) => (Array.isArray(v) && v.length > 0 && v.length <= PATH_MAX && v.every((x) => Number.isSafeInteger(x) && x >= 0) ? [...v] : undefined);
const put = (out, k, v) => {
  if (v !== undefined) out[k] = v;
};

/**
 * Where a comment, a pin or a typed edit sits, as the engine reports it (vendor/engine: docx Sz and the edit records, xlsx un, pptx AV):
 * Word {blockPath, paraId, start, end, protected}, Excel {sheetIndex, sheetName, range}, PowerPoint {slideIndex, slideId, shapeId,
 * shapeName, protected, protectedReason, cell: {row, col}}. Null for anything that is not an object.
 */
export function cleanLocation(l) {
  if (!l || typeof l !== "object" || Array.isArray(l)) return null;
  const out = {};
  put(out, "blockPath", blockPath(l.blockPath));
  put(out, "paraId", str(l.paraId, 64));
  put(out, "start", int(l.start));
  put(out, "end", int(l.end));
  put(out, "protected", typeof l.protected === "boolean" ? l.protected : str(l.protected, 200));
  put(out, "protectedReason", str(l.protectedReason, 200));
  put(out, "sheetIndex", int(l.sheetIndex));
  put(out, "sheetName", str(l.sheetName, 256)); // Excel caps a sheet name at 31 characters
  put(out, "range", str(l.range, 64)); // "XFD1048576:XFD1048576" is 21
  put(out, "slideIndex", int(l.slideIndex));
  put(out, "slideId", idOf(l.slideId));
  put(out, "shapeId", idOf(l.shapeId));
  put(out, "shapeName", str(l.shapeName, NAME_MAX));
  if (l.cell && typeof l.cell === "object" && int(l.cell.row) !== undefined && int(l.cell.col) !== undefined) out.cell = { row: l.cell.row, col: l.cell.col };
  // HTML (web/src/html-view.js): the located node's id in one version of the file, and that version's sha256 (an id means nothing in another)
  put(out, "nodeId", int(l.nodeId));
  if (typeof l.version === "string" && /^[0-9a-f]{64}$/.test(l.version)) out.version = l.version;
  return out;
}

/**
 * The page's view at Send (the engine's getViewState): Word {blockPath, textHash, quote, offsetPx, zoom, fraction}, Excel {sheetIndex,
 * sheetName, topLeft, selection}, PowerPoint {slideIndex, zoom}, each with its `format`. Null for anything else.
 */
export function cleanView(v) {
  if (!v || typeof v !== "object" || Array.isArray(v) || !["docx", "xlsx", "pptx", "html"].includes(v.format)) return null;
  if (v.format === "html") return cleanHtmlView(v);
  const out = { format: v.format };
  put(out, "blockPath", blockPath(v.blockPath));
  put(out, "textHash", str(v.textHash, 64));
  put(out, "quote", str(v.quote, 200)); // the engine sends 80
  put(out, "offsetPx", finite(v.offsetPx));
  put(out, "zoom", finite(v.zoom) ?? str(v.zoom, 16)); // a number or "fit"
  put(out, "fraction", finite(v.fraction));
  put(out, "sheetIndex", int(v.sheetIndex));
  put(out, "sheetName", str(v.sheetName, 256));
  put(out, "topLeft", str(v.topLeft, 64));
  put(out, "selection", str(v.selection, 64));
  put(out, "slideIndex", int(v.slideIndex));
  return out;
}

/** An HTML view (web/src/html-frame.js getViewState): {version, x, y, fraction, top: {nodeId, quote, offsetPx}}; hidden elements stay in the page. */
function cleanHtmlView(v) {
  const out = { format: "html" };
  if (typeof v.version === "string" && /^[0-9a-f]{64}$/.test(v.version)) out.version = v.version;
  put(out, "x", finite(v.x));
  put(out, "y", finite(v.y));
  put(out, "fraction", finite(v.fraction));
  const t = v.top;
  if (t && typeof t === "object" && int(t.nodeId) !== undefined) out.top = { nodeId: t.nodeId, quote: str(t.quote, 200) ?? "", offsetPx: finite(t.offsetPx) ?? 0 };
  return out;
}

/**
 * The page's anchor of a comment, as stored: the fields the server and the page read (location, quote, prefix, suffix, paraText,
 * format, hitKind), each cut. A quote or paragraph text cut here is marked `cut`, and the anchor is then built from the file as the
 * paragraph or shape it sits in (src/anchors.js), never as a range of the cut text. Null for anything that is not an object.
 */
export function cleanPageAnchor(a) {
  if (!a || typeof a !== "object" || Array.isArray(a)) return null;
  const out = {};
  const loc = cleanLocation(a.location);
  if (loc) out.location = loc;
  let cut = false;
  for (const k of ["quote", "paraText"]) {
    if (typeof a[k] !== "string") continue;
    out[k] = cutText(a[k], STRING_MAX);
    if (out[k].length < a[k].length) cut = true;
  }
  put(out, "prefix", typeof a.prefix === "string" ? cutTail(a.prefix, CONTEXT_MAX) : undefined); // the end nearest the selection
  put(out, "suffix", str(a.suffix, CONTEXT_MAX));
  for (const k of ["format", "hitKind"]) put(out, k, str(a[k], 40));
  if (cut || a.cut === true) out.cut = true;
  return out;
}

/** A typed edit the page reported ({kind, before, after, label, location}), as stored for the next batch. */
export function cleanEdit(e) {
  const side = (v) => (typeof v === "string" ? cutText(v, STRING_MAX) : v == null ? v : typeof v === "number" || typeof v === "boolean" ? cutText(String(v), 100) : null);
  const before = side(e?.before);
  const after = side(e?.after);
  const out = { kind: str(e?.kind, 40) ?? null, before, after, label: str(e?.label, NAME_MAX) ?? null, location: cleanLocation(e?.location) };
  if ((typeof e?.before === "string" && before.length < e.before.length) || (typeof e?.after === "string" && after.length < e.after.length)) out.cut = true;
  return out;
}

// in UTF-8 bytes, as the file is written (a CJK character is 3)
export const jsonSize = (v) => {
  try {
    return Buffer.byteLength(JSON.stringify(v) ?? "");
  } catch {
    return Infinity;
  }
};
const OPTIONAL = ["values", "types", "formats", "names"];
/**
 * An anchor built from the file (src/anchors.js buildDurable, src/session.js reanchor), as stored and handed on: every string at
 * STRING_MAX; past ANCHOR_MAX as JSON, an Excel anchor's values cut to VALUE_SHORT characters a cell, then the optional evidence dropped.
 * Hashes, places and the kept text prefix stay. Marked `cut` when anything was cut. Returns the same object when nothing was.
 */
export function capDurable(d) {
  if (!d || typeof d !== "object") return d;
  let out = d;
  const own = () => (out === d ? (out = { ...d }) : out);
  for (const [k, v] of Object.entries(d)) if (typeof v === "string" && v.length > STRING_MAX) own()[k] = cutText(v, STRING_MAX);
  if (jsonSize(out) > ANCHOR_MAX) {
    own();
    if (Array.isArray(out.values)) out.values = out.values.map((r) => (Array.isArray(r) ? r.map((x) => (typeof x === "string" ? cutText(x, VALUE_SHORT) : x)) : r));
    if (jsonSize(out) > ANCHOR_MAX) {
      for (const k of OPTIONAL) if (Array.isArray(out[k])) out[k] = [];
      if (out.ctx && typeof out.ctx === "object") out.ctx = { ...out.ctx, rowCells: [] };
      for (const [k, v] of Object.entries(out)) {
        if (typeof v !== "string" || v.length <= 2000 || /hash/i.test(k)) continue;
        // a quote is a range of the text: cut, it would point at a shorter one, so the anchor becomes its whole paragraph or shape
        if (k === "quote") Object.assign(out, { quote: "", start: null, end: null, ...("nth" in out ? { nth: null } : {}) });
        else out[k] = cutText(v, 2000);
      }
    }
  }
  if (d.pinFallback) {
    const p = capDurable(d.pinFallback);
    if (p !== d.pinFallback) own().pinFallback = p;
  }
  if (out !== d) out.cut = true;
  return out;
}

/** A comment as stored, past COMMENT_MAX: the page's anchor is cut to 2,000 characters a field (the anchor built from the file holds the rest). */
export function capComment(c) {
  if (jsonSize(c) <= COMMENT_MAX) return c;
  const out = { ...c, cut: true };
  if (out.anchor) out.anchor = { ...out.anchor, cut: true, ...Object.fromEntries(["quote", "paraText"].filter((k) => typeof out.anchor[k] === "string").map((k) => [k, cutText(out.anchor[k], 2000)])) };
  if (out.durable) out.durable = capDurable(out.durable);
  return out;
}

/** The size of a request's own data (comments, note, edits, view state) as JSON; Infinity when it cannot be written as JSON. */
export const requestSize = (parts) => jsonSize(parts);
