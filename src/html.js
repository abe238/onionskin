import crypto from "node:crypto";
import { CapError } from "./xml.js";
import { hitsOf, normPaid, normText, OCCURRENCE, searchCost, spend, textHash, weigh } from "./text.js";
import { cutText } from "./retain.js";
import { editHash } from "./edit-hash.js";

// HTML files (PLAN-html 3.1, 3.4, R7, R8, R10, R22): the file's bytes are the source of truth. This module decodes them, parses them once
// with source locations (parse5, vendored), indexes the located nodes, tells which text nodes can be edited by a splice at their exact
// place, builds the units and the outline an agent reads, makes and re-resolves durable anchors, and splices text with a proof that
// nothing outside the edited place changed.
//
// The parser is not imported here: src/html-parser.js imports it and installs it, and only modules that run in worker threads import
// that one (test/html-parser-thread.test.js), so the server's own thread never parses a page. Without it, readHtml and the proof throw.
// Every walker here is iterative (a page may nest 512 levels, and a tree past that is refused only after it is built).

let P5 = null;
/** Installs the parser (src/html-parser.js does, in a worker). */
export function installParser(p5) {
  P5 = p5;
}
const parser = () => {
  if (!P5) throw new Error("the HTML parser is not loaded on this thread: only worker threads that import src/html-parser.js read HTML files");
  return P5;
};
/** Is the parser loaded on this thread (a worker thread that imported src/html-parser.js, or a test)? */
export const parserLoaded = () => P5 !== null;
/** The installed parser (src/html-render.js parses its render copy again with it); throws on a thread that has none. */
export const htmlParser = parser;

export const HTML_NS = "http://www.w3.org/1999/xhtml";

// ---- limits (R22: set from spike S2's measurements; docs/GUIDE.md "Size limits") ------------------------------------------------
/**
 * What one HTML file may hold. Measured in S2 (worker CPU, a busy Mac): 10 MB with 200,000 elements opened in 1.2 to 1.5 s and about
 * 600 MB of heap, the proof another 0.8 s; 20 MB with 400,000 elements ran a 1 GB worker out of memory (about 2.5 to 3 KB per element
 * while two trees are alive). `data:` attribute values count against the file size only (R16), not the 1 MB attribute cap.
 */
export const HTML_LIMITS = { bytes: 10 * 1024 * 1024, elements: 200_000, attributes: 400_000, text: 8_000_000, depth: 512, attrValue: 1_000_000 };
const n = (x) => x.toLocaleString("en-US");
const SPLIT = "Split it into smaller pages and open those";
const capBytes = (size, max) => new CapError(`this page is ${(size / 1048576).toFixed(1)} MB, more than the ${max / 1048576} MB Onionskin can read. ${SPLIT}`, "bytes");
const capCount = (max, noun) => new CapError(`this page has more than ${n(max)} ${noun}, more than Onionskin can read. ${SPLIT}`, noun);
const capDepth = (max) => new CapError(`this page nests elements more than ${max} levels deep, more than Onionskin can read (a browser shows such a page differently from its source). Open a copy with less nesting`, "nesting depth");
const capValue = (max) => new CapError(`an attribute value in this page is longer than ${n(max)} characters, more than Onionskin can read. ${SPLIT}`, "attribute value");

// ---- decoding (R10, R22) ----------------------------------------------------------------------------------------------------------
/** R18: the sentence for a file saved in windows-1252 or ISO-8859-1, which Onionskin can offer to copy as UTF-8. */
export const NOT_UTF8 = "This file is not saved as UTF-8; Onionskin can save a UTF-8 copy and open that.";
/** For any other encoding (a declared Shift_JIS or UTF-16, or bytes that are not valid UTF-8): no copy is offered. */
export const NOT_READABLE_ENCODING = "This file is not saved as UTF-8, and Onionskin cannot tell how it is saved, so it cannot open it.";
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const UTF8_LABELS = new Set(["utf-8", "utf8", "unicode-1-1-utf-8", "unicode11utf8", "unicode20utf8", "x-unicode20utf8"]);
// the WHATWG labels of windows-1252 (ISO-8859-1 and US-ASCII are read as windows-1252 by browsers): the copy can be made losslessly
const WINDOWS_1252 = new Set(["ansi_x3.4-1968", "ascii", "cp1252", "cp819", "csisolatin1", "ibm819", "iso-8859-1", "iso-ir-100", "iso8859-1", "iso88591", "iso_8859-1", "iso_8859-1:1987", "l1", "latin1", "us-ascii", "windows-1252", "x-cp1252"]);

/** The charset a page declares in its first 1,024 bytes (a meta charset, or a meta http-equiv content-type), lowercased; null when none. */
function declaredCharset(bytes) {
  const head = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.length, 1024))
    .toString("latin1")
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "");
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const cs = /\bcharset\s*=\s*["']?\s*([A-Za-z0-9_.:-]+)/i.exec(m[0]);
    if (cs) return cs[1].toLowerCase();
  }
  return null;
}

/**
 * The bytes of an HTML file as text, or why not. UTF-8 only, decoded in fatal mode with the BOM set aside (left in, parse5 makes it a
 * text node at the start of the body) and reported; decoding then encoding must give the bytes back. Returns
 *   {ok: true, encoding: "utf8", text, bomLen (0 or 3), declared (the label, or null)}
 *   {ok: false, encoding: "declared-other", label, ascii, copyable, code: "not_utf8", sentence}  (a declared windows-1252 file that is
 *     plain ASCII is still refused: a later write of a non-ASCII character would not match its declaration)
 *   {ok: false, encoding: "invalid", code: "utf16" | "invalid_utf8" | "roundtrip", sentence}
 * `sentence` is NOT_UTF8 when a UTF-8 copy can be made (windows-1252 and its aliases), else NOT_READABLE_ENCODING.
 */
export function decodeHtml(bytes) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length >= 2 && ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff))) return { ok: false, encoding: "invalid", code: "utf16", sentence: NOT_READABLE_ENCODING };
  const bomLen = b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? 3 : 0;
  const label = declaredCharset(b);
  // a UTF-8 BOM wins over a declaration, as in a browser
  if (!bomLen && label && !UTF8_LABELS.has(label)) {
    const copyable = WINDOWS_1252.has(label);
    return { ok: false, encoding: "declared-other", label: cutText(label, 40), ascii: !b.some((x) => x >= 0x80), copyable, code: "not_utf8", sentence: copyable ? NOT_UTF8 : NOT_READABLE_ENCODING };
  }
  const body = b.subarray(bomLen);
  let text;
  try {
    text = UTF8.decode(body);
  } catch {
    return { ok: false, encoding: "invalid", code: "invalid_utf8", sentence: NOT_READABLE_ENCODING };
  }
  if (!Buffer.from(text, "utf8").equals(body)) return { ok: false, encoding: "invalid", code: "roundtrip", sentence: NOT_READABLE_ENCODING };
  return { ok: true, encoding: "utf8", text, bomLen, declared: label };
}

/** A refusal of the file's encoding: its message is the sentence, `code` the reason code. */
export class HtmlEncodingError extends Error {
  constructor(d) {
    super(d.sentence);
    this.code = d.code;
    this.encoding = d.encoding;
    this.label = d.label ?? null;
    this.copyable = !!d.copyable;
  }
}

// ---- offsets ------------------------------------------------------------------------------------------------------------------------
/**
 * The one function from parse5's offsets (UTF-16 indexes into the decoded text, CRLF included) to byte offsets in the file (the BOM
 * counted). A checkpoint every 4,096 code units, so a lookup reads at most 4,096; an offset inside a surrogate pair throws.
 */
export function makeByteMap(text, bomLen = 0) {
  const STEP = 4096;
  const len = text.length;
  const cps = new Float64Array(Math.floor(len / STEP) + 2);
  const width = (c) => (c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c <= 0xdfff ? 2 : 3); // a surrogate pair is 4 bytes, 2 + 2
  let bytes = 0;
  for (let i = 0, k = 0; i <= len; i++) {
    if (i % STEP === 0) cps[k++] = bytes;
    if (i === len) break;
    bytes += width(text.charCodeAt(i));
  }
  return function toByte(off) {
    if (!(off >= 0 && off <= len)) throw new RangeError("offset out of range");
    if (off > 0 && off < len) {
      const c = text.charCodeAt(off);
      const p = text.charCodeAt(off - 1);
      if (c >= 0xdc00 && c <= 0xdfff && p >= 0xd800 && p <= 0xdbff) throw new RangeError("offset inside a surrogate pair");
    }
    const k = Math.floor(off / STEP);
    let b = cps[k];
    for (let i = k * STEP; i < off; i++) b += width(text.charCodeAt(i));
    return bomLen + b;
  };
}

// ---- parsing under the limits ---------------------------------------------------------------------------------------------------------
/**
 * One parse of `text` with source locations and scripting on (R22: off can move `title` into the body), counting elements, attributes
 * and text characters as the tree is built, so a page past a limit is refused before it fills memory (a 10 MB file of tiny elements
 * would be millions of them). Returns {doc, dupOffsets}: the start offsets of duplicate attributes (parse5 gives a dropped duplicate
 * no location). Throws a CapError past a limit.
 */
function parseLimited(text, limits = HTML_LIMITS) {
  const p5 = parser();
  const d = p5.defaultTreeAdapter;
  const c = { elements: 0, attrs: 0, text: 0 };
  const attrs = (list) => {
    if ((c.attrs += list.length) > limits.attributes) throw capCount(limits.attributes, "attributes");
    for (const a of list) if (a.value.length > limits.attrValue && !/^[ \t\n\f\r]*data:/i.test(a.value)) throw capValue(limits.attrValue);
  };
  const chars = (t) => {
    if ((c.text += t.length) > limits.text) throw capCount(limits.text, "characters of text");
  };
  const treeAdapter = {
    ...d,
    createElement(tag, ns, list) {
      if (++c.elements > limits.elements) throw capCount(limits.elements, "elements");
      attrs(list);
      return d.createElement(tag, ns, list);
    },
    adoptAttributes(recipient, list) {
      const before = recipient.attrs.length;
      d.adoptAttributes(recipient, list);
      attrs(recipient.attrs.slice(before));
    },
    insertText(parent, t) {
      chars(t);
      d.insertText(parent, t);
    },
    insertTextBefore(parent, t, ref) {
      chars(t);
      d.insertTextBefore(parent, t, ref);
    },
  };
  const dupOffsets = [];
  const doc = p5.parse(text, { sourceCodeLocationInfo: true, scriptingEnabled: true, treeAdapter, onParseError: (e) => e.code === "duplicate-attribute" && dupOffsets.push(e.startOffset) });
  return { doc, dupOffsets: dupOffsets.sort((a, b) => a - b) };
}

// ---- tree helpers ---------------------------------------------------------------------------------------------------------------------
/** Children of a node; a template's are those of its content. */
export const kids = (x) => (x.nodeName === "template" && x.content ? x.content.childNodes : x.childNodes || []);
const isEl = (x) => x.tagName !== undefined;
const isText = (x) => x.nodeName === "#text";
const html = (x) => x.namespaceURI === HTML_NS;
/** Elements whose content is raw text: never a unit, never an edit, never shown to an agent (R7). `noscript` is raw with scripting on. */
export const RAWTEXT = new Set(["script", "style", "xmp", "iframe", "noembed", "noframes", "plaintext", "noscript"]);
export const RCDATA = new Set(["title", "textarea"]);
/** A raw-text element, or a script or style in another namespace (an SVG script runs and an SVG style applies): its text is frozen and hidden. */
const frozen = (el) => (html(el) ? RAWTEXT.has(el.tagName) : el.tagName === "script" || el.tagName === "style");
const LEADING_LF = new Set(["pre", "listing", "textarea"]);
const HEADING = /^h[1-6]$/;
/** Leaf elements that are units with no text of their own (images and other replaced content). */
const LEAF = new Set(["img", "video", "audio", "canvas", "iframe", "embed", "object", "input", "hr", "svg"]);
// elements a browser shows on a line of their own: the visible text puts a space at their edges, so their words never run together
const BLOCK = new Set(["address", "article", "aside", "blockquote", "body", "br", "caption", "dd", "details", "dialog", "div", "dl", "dt", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "head", "header", "hgroup", "hr", "html", "li", "main", "menu", "nav", "ol", "option", "p", "pre", "section", "summary", "table", "tbody", "td", "tfoot", "th", "thead", "title", "tr", "ul"]);

/** The path of a node from the document: child indexes (template content counts as the template's children). */
export function pathOf(x) {
  const p = [];
  while (x && x.__par) (p.push(x.__idx), (x = x.__par));
  return p.reverse();
}
/** The node at child-index path `p` from `doc`, or null. */
export function atPath(doc, p) {
  let x = doc;
  for (const i of p) {
    const ks = kids(x);
    if (i >= ks.length) return null;
    x = ks[i];
  }
  return x;
}

/** Deep structural equality of two subtrees (names, namespaces, attributes in order, values, template content), iterative. */
export function deepEqual(a, b) {
  const st = [[a, b]];
  while (st.length) {
    const [x, y] = st.pop();
    if (x.nodeName !== y.nodeName) return false;
    if (isText(x)) {
      if (x.value !== y.value) return false;
      continue;
    }
    if (x.nodeName === "#comment") {
      if (x.data !== y.data) return false;
      continue;
    }
    if (x.nodeName === "#documentType") {
      if (x.name !== y.name || x.publicId !== y.publicId || x.systemId !== y.systemId) return false;
      continue;
    }
    if (isEl(x)) {
      if (x.tagName !== y.tagName || x.namespaceURI !== y.namespaceURI || x.attrs.length !== y.attrs.length) return false;
      for (let i = 0; i < x.attrs.length; i++) {
        const p = x.attrs[i];
        const q = y.attrs[i];
        if (p.name !== q.name || p.value !== q.value || (p.namespace || "") !== (q.namespace || "") || (p.prefix || "") !== (q.prefix || "")) return false;
      }
    }
    const xk = kids(x);
    const yk = kids(y);
    if (xk.length !== yk.length) return false;
    for (let i = 0; i < xk.length; i++) st.push([xk[i], yk[i]]);
  }
  return true;
}
/** One node's own identity (no children): what the proof compares on the path to the edited place. */
function shallowSame(a, b) {
  if (a.nodeName !== b.nodeName) return false;
  if (isText(a)) return a.value === b.value;
  if (a.nodeName === "#comment") return a.data === b.data;
  if (!isEl(a)) return true;
  if (a.tagName !== b.tagName || a.namespaceURI !== b.namespaceURI || a.attrs.length !== b.attrs.length) return false;
  return a.attrs.every((p, i) => p.name === b.attrs[i].name && p.value === b.attrs[i].value && (p.namespace || "") === (b.attrs[i].namespace || "") && (p.prefix || "") === (b.attrs[i].prefix || ""));
}

// ---- contexts, addressability (R8) and escaping ---------------------------------------------------------------------------------------
/** The text context of a text node: "raw" (frozen), "rcdata" (title, textarea), "normal", or "none" (no parent element). */
export function textContext(x) {
  const p = x.__ctx;
  if (!p) return "none";
  if (frozen(p)) return "raw";
  if (html(p) && RCDATA.has(p.tagName)) return "rcdata";
  return "normal";
}
/** Is the text node's parent a pre, listing or textarea (the parser drops a newline right after their start tag)? */
export const leadingLfParent = (x) => !!x.__ctx && html(x.__ctx) && LEADING_LF.has(x.__ctx.tagName);
/**
 * The source range [start, end) of a text node. parse5 includes in the span the newline it drops right after <pre>, <listing> or
 * <textarea> when more whitespace follows; that newline is not part of the node, so it is left outside (S2, E2).
 */
export function textRange(x, text) {
  const loc = x.sourceCodeLocation;
  let s = loc.startOffset;
  const e = loc.endOffset;
  const p = x.__ctx;
  const pst = p?.sourceCodeLocation?.startTag;
  if (p && leadingLfParent(x) && pst && s === pst.endOffset) {
    if (text.startsWith("\r\n", s) && !x.value.startsWith("\n\n") && e - s > x.value.length) s += 2;
    else if ((text[s] === "\n" || text[s] === "\r") && e - s > x.value.length) s += 1;
  }
  return [s, e];
}
/** R8 for a text node: located, not whitespace only, not raw text, and its source slice parsed alone in its parent's context is it. */
function addressableText(x, text) {
  if (!x.sourceCodeLocation || !x.__ctx || !/\S/.test(x.value)) return false;
  const c = textContext(x);
  if (c !== "normal" && c !== "rcdata") return false;
  const [s, e] = textRange(x, text);
  const f = parser().parseFragment(x.__ctx, text.slice(s, e), { scriptingEnabled: true }).childNodes;
  return f.length === 1 && isText(f[0]) && f[0].value === x.value;
}
/** R8 for an element, run on demand (O(its subtree)): its source slice, parsed alone in its parent's context, is exactly it. */
export function elementAddressable(read, nodeId) {
  const x = read.nodes[nodeId];
  const loc = x?.sourceCodeLocation;
  if (!x || !isEl(x) || !loc?.startTag || !x.__ctx || (html(x) && ["html", "head", "body"].includes(x.tagName))) return false;
  const f = parser().parseFragment(x.__ctx, read.text.slice(loc.startOffset, loc.endOffset), { scriptingEnabled: true }).childNodes;
  return f.length === 1 && deepEqual(f[0], x);
}

/**
 * New text for a splice that replaces one whole text node, escaped for its context (S2): normal text escapes & < > and CR, RCDATA & <
 * and CR; a leading LF at the very start of pre, listing or textarea gets one more literal LF for the parser to drop (a character
 * reference would not survive). Raw text is frozen. NUL and lone surrogates are refused. Returns {ok, out} or {ok: false, code}.
 */
export function escapeText(s, context, { atStartOfLeadingLf = false } = {}) {
  if (context !== "normal" && context !== "rcdata") return { ok: false, code: "frozen" };
  if (s.includes("\u0000")) return { ok: false, code: "nul" };
  if (/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s)) return { ok: false, code: "lone_surrogate" };
  let out = s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  if (context === "normal") out = out.replace(/>/g, "&gt;");
  out = out.replace(/\r/g, "&#13;");
  if (atStartOfLeadingLf && out.startsWith("\n")) out = `\n${out}`;
  return { ok: true, out };
}
/**
 * An attribute value escaped for its quoting style ('"', "'" or "" for unquoted, which becomes '"' unless the value is a plain token).
 * Returns {ok, out (with its quotes), quote} or {ok: false, code: "nul"}.
 */
export function escapeAttr(v, quote) {
  if (v.includes("\u0000")) return { ok: false, code: "nul" };
  if (/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(v)) return { ok: false, code: "lone_surrogate" };
  if (quote === "" && !/^[^\s"'=<>`&]+$/.test(v)) quote = '"';
  let out = v.replace(/&/g, "&amp;").replace(/\r/g, "&#13;");
  if (quote === '"') out = out.replace(/"/g, "&quot;");
  if (quote === "'") out = out.replace(/'/g, "&#39;");
  return { ok: true, out: quote + out + quote, quote };
}

// ---- names an agent may see (R7) ------------------------------------------------------------------------------------------------------
const SAFE_NAME = /^[a-z0-9-]{1,32}$/;
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
/** A tag name as an agent may see it: itself when it matches [a-z0-9-]{1,32}, else a neutral token made from its hash (stable, so a path still compares). */
export const safeTag = (tag) => (SAFE_NAME.test(tag) ? tag : `t-${sha(tag).slice(0, 12)}`);
const idOf = (x) => x.attrs?.find((a) => a.name === "id" && !a.namespace)?.value ?? null;

// ---- reading a file -------------------------------------------------------------------------------------------------------------------
/**
 * Reads an HTML file (bytes) in full: size, decoding, one parse under the limits, depth, the located nodes, addressability of every text
 * node, the units and the outline's text. Runs in a worker only (the parser is there). Throws a CapError past a limit (its message states
 * the limit in plain words) and an HtmlEncodingError for a file that is not UTF-8. The read holds one tree.
 *
 * Returns a reading: {format: "html", bytes, text, bomLen, toByte, doc, nodes, units, flat, byId, dupOffsets, limits}.
 *  - nodes: the located nodes (elements, text, comments, the doctype; never an implied element) in source order (start offset, then tree
 *    order); a node's id (`__id`) is its index here. The render copy and the page use the same ids.
 *  - units: the elements that directly hold non-whitespace text, and leaf elements (images and the like), in tree order, outside raw
 *    text and template content: {node, nodeId (null for an implied element), tag, kind: "text" | "leaf", editable, heading (the index in
 *    `units` of the nearest heading at or before it, or -1), htmlId (its id when unique and [a-z0-9-]{1,32}, else null), hasId}.
 *  - flat: the page's visible text (no raw text, no template content), whitespace runs as one space and a space at block edges;
 *    every element's [__fs, __fe) is its range in it.
 */
export function readHtml(bytes, limits = HTML_LIMITS) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length > limits.bytes) throw capBytes(b.length, limits.bytes);
  const d = decodeHtml(b);
  if (!d.ok) throw new HtmlEncodingError(d);
  const { doc, dupOffsets } = parseLimited(d.text, limits);
  return indexRead({ bytes: b, text: d.text, bomLen: d.bomLen, doc, dupOffsets, limits });
}

/** A reading from an already parsed version (proveSplice's): the same as readHtml without a second parse. */
export function readParsed(parsed) {
  return indexRead({ ...parsed, limits: parsed.limits || HTML_LIMITS });
}

function indexRead({ bytes, text, bomLen, doc, dupOffsets, limits }) {
  const len = text.length;
  const located = [];
  const units = [];
  const byHtmlId = new Map(); // id -> element, or null when two elements share it
  const flat = [];
  let flatLen = 0;
  const put = (s) => {
    flat.push(s);
    flatLen += s.length;
  };
  let lastSpace = true;
  // a block's edge is a space, as a selection across two paragraphs reads once its whitespace is folded (src/text.js normText)
  const lineBreak = () => {
    if (!lastSpace) put(" ");
    lastSpace = true;
  };
  let heading = -1;
  doc.__par = null;
  doc.__depth = 0;
  doc.__ctx = null;
  doc.__hidden = false; // inside raw text or template content: not shown, never a unit
  const nth = new Map();
  const stack = [doc];
  while (stack.length) {
    const x = stack.pop();
    if (x.exit) {
      const el = x.exit;
      if (el.__block) lineBreak();
      el.__fe = flatLen;
      continue;
    }
    const loc = x.sourceCodeLocation;
    if (loc) {
      // parse5 8.1.1 reports endOffset = length + 1 for a comment or doctype cut off by the end of the input (S2, E1)
      if (loc.endOffset > len) loc.endOffset = len;
      if (loc.endTag && loc.endTag.endOffset > len) loc.endTag.endOffset = len;
      if (x !== doc) located.push(x);
    }
    if (isEl(x) && x.__depth > limits.depth) throw capDepth(limits.depth);
    if (isText(x)) {
      if (x.__hidden) continue;
      if (x.__ctx && /\S/.test(x.value)) x.__ok = addressableText(x, text);
      let t = x.value.replace(/[ \t\n\f\r]+/g, " ");
      if (lastSpace && t.startsWith(" ")) t = t.slice(1);
      if (t) {
        x.__fs = flatLen;
        put(t);
        lastSpace = t.endsWith(" ");
      }
      continue;
    }
    const ks = kids(x);
    if (isEl(x)) {
      x.__block = html(x) && BLOCK.has(x.tagName);
      if (x.__block) lineBreak();
      x.__fs = flatLen;
      stack.push({ exit: x });
      const id = idOf(x);
      if (id !== null && SAFE_NAME.test(id)) byHtmlId.set(id, byHtmlId.has(id) ? null : x);
      if (!x.__hidden) {
        // raw-text and template elements hold no unit text (R7); an iframe is still a leaf
        const raw = frozen(x) || (html(x) && x.tagName === "template");
        const direct = !raw && ks.some((c) => isText(c) && /\S/.test(c.value));
        const leaf = LEAF.has(x.tagName);
        if (direct || leaf) {
          const before = heading; // a heading's own heading is the one before it; what it holds is under it
          if (html(x) && HEADING.test(x.tagName)) heading = units.length;
          units.push({ node: x, nodeId: null, tag: x.tagName, kind: direct ? "text" : "leaf", editable: false, heading: heading === units.length ? before : heading, htmlId: null, hasId: id !== null });
          x.__unit = units.length - 1;
        }
      }
    }
    // children: their parent, index, context element, depth, nth among same-tag element siblings, and whether they are shown
    nth.clear();
    const hide = x.__hidden || (isEl(x) && (frozen(x) || (html(x) && x.tagName === "template")));
    for (let i = 0; i < ks.length; i++) {
      const c = ks[i];
      c.__par = x;
      c.__idx = i;
      c.__depth = x.__depth + 1;
      c.__ctx = isEl(x) ? x : null;
      c.__hidden = hide;
      if (isEl(c)) {
        // by tag alone (any namespace): a path segment tag:nth then names one child
        c.__nth = nth.get(c.tagName) || 0;
        nth.set(c.tagName, c.__nth + 1);
      }
    }
    for (let i = ks.length - 1; i >= 0; i--) stack.push(ks[i]);
  }
  // ids: located nodes in source order; tree order breaks ties (an adoption-agency clone carries its original's start location)
  located.forEach((x, i) => (x.__tree = i));
  located.sort((a, b) => a.sourceCodeLocation.startOffset - b.sourceCodeLocation.startOffset || a.__tree - b.__tree);
  located.forEach((x, i) => (x.__id = i));
  for (const u of units) {
    u.nodeId = u.node.__id ?? null;
    u.editable = u.kind === "text" && kids(u.node).some((c) => c.__ok === true);
    const id = idOf(u.node);
    u.htmlId = id !== null && byHtmlId.get(id) === u.node ? id : null;
  }
  const byId = new Map();
  for (const [k, v] of byHtmlId) if (v) byId.set(k, v);
  return { format: "html", bytes, text, bomLen, toByte: makeByteMap(text, bomLen), doc, nodes: located, units, flat: flat.join(""), byId, dupOffsets, limits };
}

// Text the person may type in (PLAN-html D4, R8, R11): source text nodes the write check accepts (src/html-write.js checkedHtmlWrite
// "edits": located, addressable, in normal or RCDATA context, not hidden) and not inside a link, a form control, `title` or `head`, where
// typing would change what a control or a link says rather than the page's text (the page applies the markup half again,
// web/src/html-view.js canType).
const NOT_TYPED = new Set(["a", "button", "select", "option", "optgroup", "textarea", "datalist", "output", "title", "head"]);
/** The ids (in `read.nodes`) of the source text nodes the person may type in: the `editable` list the view route sends the page. */
export function editableTextIds(read) {
  const out = [];
  for (const x of read.nodes) {
    if (!isText(x) || x.__ok !== true || x.__hidden || !["normal", "rcdata"].includes(textContext(x))) continue;
    let ok = true;
    for (let p = x.__par; p && ok; p = p.__par) if (p.tagName && NOT_TYPED.has(p.tagName)) ok = false;
    if (ok) out.push(x.__id);
  }
  return out;
}

// The parts of the page the person may type in, made editable in the render copy itself (src/html-render.js) so the page never has to
// change an attribute on a large page (measured in Chromium: making 100,000 paragraphs editable from script costs seconds of layout) and
// a key pressed right after a click is never lost. A part is the element right above a text node of editableTextIds, unless an element
// above it is a part already, or its subtree holds more than EDIT_HOST_MAX nodes (it is then made editable at the click, by the page:
// web/src/html-frame.js beginHost, and compared whole while typed in). The page checks every typed change again (canType).
export const EDIT_HOST_MAX = 400;
/** The elements the render copy marks `contenteditable` (see above), as a Set of the reading's elements. */
export function editHosts(read, ids = editableTextIds(read)) {
  const cand = new Set();
  for (const id of ids) {
    const p = read.nodes[id]?.__par;
    if (p && p.tagName !== undefined) cand.add(p);
  }
  // subtree sizes, capped at EDIT_HOST_MAX + 1, for the candidates: counted by walking each one (stopping at the cap), the inner ones first
  const size = new Map();
  const sizeOf = (el) => {
    let n = 0;
    const stack = [...kids(el)];
    while (stack.length && n <= EDIT_HOST_MAX) {
      const x = stack.pop();
      n++;
      for (const c of kids(x)) stack.push(c);
    }
    return n;
  };
  const small = (el) => {
    let v = size.get(el);
    if (v === undefined) size.set(el, (v = sizeOf(el)));
    return v <= EDIT_HOST_MAX;
  };
  const hosts = new Set();
  for (const c of cand) {
    if (!small(c)) continue;
    let covered = false;
    for (let a = c.__par; a && !covered; a = a.__par) if (cand.has(a) && small(a)) covered = true;
    if (!covered) hosts.add(c);
  }
  return hosts;
}

// The identity of a text node the person may type in (PLAN-html R9; the page re-places a pending edit after a version change by it, never
// by the node's numeric id, which means nothing in another version: web/src/html-view.js createEdits replace). Per node of `ids`, six
// int32 in a row:
//   nk (2 ints): a 64-bit key of its neighbors: its parent's tag, its index among the parent's text children, and the text hashes
//     (src/edit-hash.js) of the shown, non-blank text nodes just before and just after it in the document;
//   ik (2 ints): a 64-bit key of its parent's `id` (when unique in this version), or 0, 0;
//   tw: how many shown text nodes of this version have exactly its text (its twins, itself included);
//   pw: how many of them are under its parent with that unique id (anywhere below it, not only its children), or 0 when it has none.
// The node's own text is not in a key: the page reads it from the frame and compares its hash, so the same keys also find a node whose
// text is already the edit's new text. The element path is not in a key on purpose: an element inserted before shifts every path after
// it, and "same path, same text" is exactly what put an edit on a twin paragraph inserted before its own (the outside review, 029e51b).
// Nor is the index in `ik`: a parent's own text moved among its children is still found by the id (when it is the only one with its text
// there). The page places an edit only where the counts say one node can be meant (twins are never told apart by content).
const HASH_SEEDS = [0x9e3779b9, 0x85ebca6b];
function key64(s, out, at) {
  // two 32-bit lanes of a multiply-xor hash with different seeds (not a security hash: the write check re-checks the text at Send)
  for (let lane = 0; lane < 2; lane++) {
    let h = HASH_SEEDS[lane] ^ s.length;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), lane ? 0x27d4eb2f : 0x165667b1);
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
    h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
    out[at + lane] = (h ^ (h >>> 15)) | 0;
  }
  // 0, 0 means "no key": a real key is never that
  if (out[at] === 0 && out[at + 1] === 0) out[at + 1] = 1;
}
export const IDENTITY_INTS = 6;
// Ceiling of the parent counts (pw): nodes visited under id'd parents, all together. Nested id'd parents each holding text cost their
// subtrees again (quadratic at worst); past this budget a parent gets pw 0, so its texts are placed by their neighbors only (or listed).
const PARENT_COUNT_BUDGET = 2_000_000;
/** The identities of the text nodes `ids` (editableTextIds), as one Int32Array of IDENTITY_INTS per node (see above). */
export function editIdentities(read, ids) {
  const shown = [];
  const twins = new Map();
  for (const x of read.nodes) {
    if (!isText(x) || x.__hidden || !/\S/.test(x.value)) continue;
    x.__shown = shown.length;
    shown.push(x);
    twins.set(x.value, (twins.get(x.value) || 0) + 1);
  }
  const under = new Map(); // id'd parent -> Map(text -> shown text nodes with it in its subtree), or null past the budget
  let budget = PARENT_COUNT_BUDGET;
  const countsUnder = (p) => {
    if (under.has(p)) return under.get(p);
    const m = new Map();
    const stack = [p];
    while (stack.length && budget > 0) {
      const n = stack.pop();
      budget--;
      if (isText(n)) {
        if (n.__shown !== undefined && shown[n.__shown] === n) m.set(n.value, (m.get(n.value) || 0) + 1);
      } else for (const c of kids(n)) stack.push(c);
    }
    const r = stack.length ? null : m;
    under.set(p, r);
    return r;
  };
  const out = new Int32Array(IDENTITY_INTS * ids.length);
  ids.forEach((id, k) => {
    const x = read.nodes[id];
    const p = x.__par;
    let index = 0;
    for (const c of kids(p)) {
      if (c === x) break;
      if (isText(c)) index++;
    }
    const at = k * IDENTITY_INTS;
    const i = x.__shown;
    const prev = i > 0 ? editHash(shown[i - 1].value) : "";
    const next = i < shown.length - 1 ? editHash(shown[i + 1].value) : "";
    key64(`${p?.tagName ?? ""}\u0001${index}\u0001${prev}\u0001${next}`, out, at);
    const hid = p && idOf(p);
    if (hid !== null && hid !== undefined && read.byId.get(hid) === p) {
      const m = countsUnder(p);
      if (m) {
        key64(`${hid}`, out, at + 2);
        out[at + 5] = m.get(x.value) || 0;
      }
    }
    out[at + 4] = twins.get(x.value) || 0;
  });
  return out;
}

/** Does this element's start tag hold a duplicate attribute (parse5 keeps the first; removing it would bring back the next)? */
export function hasDuplicateAttributes(read, nodeId) {
  const st = read.nodes[nodeId]?.sourceCodeLocation?.startTag;
  if (!st) return false;
  const o = read.dupOffsets;
  let lo = 0;
  let hi = o.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (o[m] < st.startOffset) lo = m + 1;
    else hi = m;
  }
  return lo < o.length && o[lo] < st.endOffset;
}

// ---- units, text, the outline -------------------------------------------------------------------------------------------------------
/** The visible text of an element (its range of `flat`), as kept: line breaks and spaces as they are there. */
const rawTextOf = (read, el) => read.flat.slice(el.__fs ?? 0, el.__fe ?? 0);
/** The visible text of an element (never raw text such as a script or style body, never template content: R7). */
export const visibleText = rawTextOf;
/** The element's own text: its direct text children, normalized. Its hash identifies it (an edit inside a nested element leaves it). */
export function ownText(el) {
  let s = "";
  for (const c of kids(el)) if (isText(c)) s += c.value;
  return s;
}
const OWN = new WeakMap();
/** textHash of an element's own text; a leaf by its tag and source (an image has no text). Kept per element of a reading. */
export function ownHash(el) {
  let h = OWN.get(el);
  if (h === undefined) {
    h = LEAF.has(el.tagName) ? textHash(`${el.tagName} ${el.attrs.find((a) => a.name === "src")?.value ?? ""} ${el.attrs.find((a) => a.name === "alt")?.value ?? ""}`) : textHash(ownText(el));
    OWN.set(el, h);
  }
  return h;
}
/** The cost of ownHash the first time (its text weighed), nothing once kept. */
const ownCost = (el) => (OWN.has(el) ? 0 : weigh(ownText(el)) + 1);

/** The element path an agent and a durable anchor use: [`tag:nth`] from the root, tag names made safe (R7), nth among same-tag siblings. */
export function elementPath(el) {
  const p = [];
  for (let x = el; x && x.__par; x = x.__par) if (isEl(x)) p.push(`${safeTag(x.tagName)}:${x.__nth}`);
  return p.reverse();
}
/** A path as the agent reads it: /html[1]/body[1]/p[3] (1-based, as XPath counts). */
export const pathString = (p) => (Array.isArray(p) ? `/${p.map((s) => s.replace(/:(\d+)$/, (_, k) => `[${Number(k) + 1}]`)).join("/")}` : null);

const LABEL_EXCERPT = 60;
const TEXT_SHOWN = 2001; // more than the outline shows of a unit (src/review.js UNIT_TEXT_MAX), so a longer text reads as cut there
/**
 * The units in src/review.js rawUnits shape, for the outline an agent gets (review.js outlineOf cuts and cleans them): {label, text (the
 * unit's visible text), protected (not editable here), at: {node_id, path, element_id, text_hash}}. The label
 * names the tag (R7), the id when it is safe, and the nearest heading before it. Script and style bodies are never in any text (R7).
 * `label`, `text` and `at` are read when asked for: the outline reads them for the units it shows, not for every unit of a large page.
 */
export function htmlRawUnits(read) {
  const head = new Map();
  const headingText = (i) => {
    if (!head.has(i)) head.set(i, normText(rawTextOf(read, read.units[i].node).slice(0, 4 * LABEL_EXCERPT)).slice(0, LABEL_EXCERPT));
    return head.get(i);
  };
  return read.units.map((u, i) => ({
    get label() {
      const id = u.htmlId ? `#${u.htmlId}` : u.hasId ? "#(id)" : "";
      const h = u.heading >= 0 ? headingText(u.heading) : "";
      const level = html(u.node) && HEADING.test(u.tag) ? ` (heading ${u.tag[1]})` : "";
      return `${safeTag(u.tag)}${id}${level}${h ? ` under "${h}"` : ""}`;
    },
    get text() {
      if (u.kind === "leaf") return u.node.attrs.find((a) => a.name === "alt")?.value ?? "";
      return read.flat.slice(u.node.__fs ?? 0, Math.min(u.node.__fe ?? 0, (u.node.__fs ?? 0) + TEXT_SHOWN)).trim();
    },
    protected: !u.editable,
    get at() {
      return { node_id: u.nodeId, path: pathString(elementPath(u.node)), element_id: u.htmlId, text_hash: ownHash(u.node) };
    },
  }));
}

// ---- durable anchors (3.4) ------------------------------------------------------------------------------------------------------------
const CTX = 40;
const KEEP = 2000;
// the hash of no own text: every container (a row, a list, a wrapper div) has it, so a path that leads to one proves nothing by it alone
const EMPTY = textHash("");
/** The element's visible text, as an anchor keeps it, is `text` (paid; false when the budget cannot pay). */
function sameText(read, el, text) {
  const raw = rawTextOf(read, el).slice(0, 2 * KEEP);
  return spend(weigh(raw)) && normText(raw).slice(0, KEEP) === (text ?? "");
}
const HEAD_KEEP = 80;
/** The element a page anchor points at: the node itself when it is an element, else its parent; an implied one climbs to a located one. */
function elementOf(read, nodeId) {
  let x = Number.isInteger(nodeId) ? read.nodes[nodeId] : null;
  if (x && !isEl(x)) x = x.__par;
  while (x && isEl(x) && !x.sourceCodeLocation) x = x.__par; // R8: an implied element anchors to its nearest located ancestor
  return x && isEl(x) ? x : null;
}
/** The nearest heading at or before an element, by the units' order (`heading` of its unit, else of the last unit before it). */
function headingFor(read, el) {
  let i = el.__unit;
  if (i === undefined) {
    // an element that is no unit: the last unit that starts at or before it in the visible text
    let lo = 0;
    let hi = read.units.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if ((read.units[m].node.__fs ?? 0) <= (el.__fs ?? 0)) lo = m + 1;
      else hi = m;
    }
    i = lo - 1;
  }
  const h = i >= 0 ? read.units[i].heading : -1;
  if (h < 0) return "";
  const raw = rawTextOf(read, read.units[h].node).slice(0, 4 * HEAD_KEEP);
  return spend(weigh(raw)) ? normText(raw).slice(0, HEAD_KEEP) : "";
}
/**
 * Where `q` occurs in the element's visible text, paid from the budget: at `hint` when it is there; else the occurrence whose context
 * best matches `prefix` and `suffix` (normalized), the nearest to `hint` among equals. -1 when none (or the budget cannot pay).
 */
function placeIn(read, el, q, hint, prefix = "", suffix = "") {
  if (!q) return -1;
  const t = rawTextOf(read, el);
  if (Number.isInteger(hint) && hint >= 0 && spend(q.length + 1) && t.startsWith(q, hint)) return hint;
  if (!spend(searchCost(t.length, q))) return -1;
  return bestOccurrence(t, q, 0, t.length, Number.isInteger(hint) ? hint : 0, prefix, suffix);
}
/** The occurrence of `q` in s[from, to) that best matches the context, then the nearest to `at`; each occurrence is paid for. */
function bestOccurrence(s, q, from, to, at, prefix, suffix) {
  let best = -1;
  let bestScore = -Infinity;
  for (let i = s.indexOf(q, from), k = 0; i >= 0 && i + q.length <= to && k < 1000; i = s.indexOf(q, i + 1), k++) {
    if (!spend(OCCURRENCE + 4 * CTX)) break;
    const before = prefix ? normText(s.slice(Math.max(0, i - 2 * CTX), i)) : "";
    const after = suffix ? normText(s.slice(i + q.length, i + q.length + 2 * CTX)) : "";
    const score = (prefix && before.endsWith(prefix) ? 2 : 0) + (suffix && after.startsWith(suffix) ? 2 : 0) - Math.abs(i - at) / (s.length + 1);
    if (score > bestScore) (best = i), (bestScore = score);
  }
  return best;
}

// ---- the page's offsets (web/src/html-view.js anchorFromRange) and this module's -----------------------------------------------
// The page counts UTF-16 code units of decoded source text as the frame holds it: in ONE source text node when `location.nodeId` is a
// text node, else in the joined text of the element's source text nodes the copy shows (src/html-render.js: not in template content,
// raw text or a non-HTML element, which the copy replaces). This module counts in `flat`: whitespace runs as one space, a leading space
// after a space dropped. These convert one to the other, exactly, so a selection's place survives the round trip (test/html-anchors.test.js).

/** The source text nodes under `el` the page counts (its elementText), in tree order. Iterative. */
function pageTexts(el) {
  const out = [];
  const stack = [...kids(el)].reverse();
  while (stack.length) {
    const x = stack.pop();
    if (isText(x)) {
      if (!x.__hidden) out.push(x);
      continue;
    }
    if (!isEl(x) || !html(x) || x.tagName === "template") continue;
    const ks = kids(x);
    for (let i = ks.length - 1; i >= 0; i--) stack.push(ks[i]);
  }
  return out;
}
/** Was the first (collapsed) space of text node `x` dropped from `flat` (it followed a space)? */
const leadDropped = (read, x) => x.value.length > 0 && WS(x.value.charCodeAt(0)) && (x.__fs === undefined || read.flat[x.__fs] !== " ");
// characters of value[0, k) that `collapse` keeps: each non-space, and the first space of each run. Additive per character, so a table of
// counts every 4,096 code units makes one lookup cost at most 4,096 steps (a page of one 8-million-character text node, anchored 500
// times, test/stress-matrix.test.js). Kept per text node of a reading.
const WS = (c) => c === 32 || c === 9 || c === 10 || c === 12 || c === 13;
const STEP = 4096;
const KEPT = new WeakMap();
function keptCount(x, k) {
  const v = x.value;
  let table = KEPT.get(x);
  if (!table) {
    table = new Int32Array(Math.floor(v.length / STEP) + 1);
    let n = 0;
    for (let i = 0; i < v.length; i++) {
      if (i % STEP === 0) table[i / STEP] = n;
      const c = v.charCodeAt(i);
      if (!WS(c) || i === 0 || !WS(v.charCodeAt(i - 1))) n++;
    }
    if (v.length % STEP === 0) table[v.length / STEP] = n;
    KEPT.set(x, table);
  }
  const b = Math.floor(k / STEP);
  let n = table[b];
  for (let i = b * STEP; i < k; i++) {
    const c = v.charCodeAt(i);
    if (!WS(c) || i === 0 || !WS(v.charCodeAt(i - 1))) n++;
  }
  return n;
}
/** The `flat` offset of the page offset `k` in text node `x` (0 <= k <= value length). */
function flatOf(read, x, k) {
  const base = x.__fs ?? null;
  if (base === null) return null; // no text of it is in `flat` (whitespace only, after a space)
  const n = keptCount(x, k) - (leadDropped(read, x) && k > 0 ? 1 : 0);
  return base + Math.max(0, n);
}
/**
 * The page offset in text node `x` of `flat` offset `f`: the first offset that maps at or past it (an end), and for a start the character
 * that makes `f` (past the rest of a whitespace run, which makes nothing).
 */
function pageOf(read, x, f, start = false) {
  const v = x.value;
  let lo = 0;
  let hi = v.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (flatOf(read, x, m) < f) lo = m + 1;
    else hi = m;
  }
  if (start) while (lo < v.length && flatOf(read, x, lo + 1) === flatOf(read, x, lo)) lo++;
  return lo;
}
/**
 * A page location -> where its first selected character sits in `rawTextOf(el)` (the hint htmlDurable gives placeIn), or null. `lead`:
 * code units of whitespace the stored quote trimmed off its start.
 */
function hintOf(read, el, loc, lead = 0) {
  if (!Number.isInteger(loc?.start)) return null;
  const node = Number.isInteger(loc.nodeId) ? read.nodes[loc.nodeId] : null;
  let x = null;
  let k = loc.start + lead;
  if (node && isText(node)) x = node;
  else {
    for (const t of pageTexts(el)) {
      if (k <= t.value.length) {
        x = t;
        break;
      }
      k -= t.value.length;
    }
  }
  if (!x || k > x.value.length) return null;
  const f = flatOf(read, x, k);
  return f === null ? null : f - (el.__fs ?? 0);
}
/**
 * The page location of [s, e) in `rawTextOf(el)`: {nodeId, start, end} in one source text node when both ends are in it, else in the
 * element's joined text (page coordinates either way); null when the text is in no node the page counts.
 */
export function pageLocation(read, el, s, e) {
  const fs = (el.__fs ?? 0) + s;
  const fe = (el.__fs ?? 0) + e;
  const list = pageTexts(el);
  let before = 0;
  let a = null;
  let b = null;
  for (const t of list) {
    const ts = t.__fs;
    const tl = ts === undefined ? 0 : keptCount(t, t.value.length) - (leadDropped(read, t) ? 1 : 0);
    if (ts !== undefined && !a && fs < ts + tl && fs >= ts) a = { t, k: pageOf(read, t, fs, true), before };
    if (ts !== undefined && fe <= ts + tl && fe > ts) {
      b = { t, k: pageOf(read, t, fe), before };
      break;
    }
    before += t.value.length;
  }
  if (!a || !b) return null;
  if (a.t === b.t) return { nodeId: a.t.__id ?? null, start: a.k, end: b.k };
  return { nodeId: el.__id ?? null, start: a.before + a.k, end: b.before + b.k };
}

/**
 * The page's anchor ({location: {nodeId, start?, end?}, quote, prefix, suffix, cut?, hitKind?}) -> a durable anchor on these bytes, or
 * null when the node is not in them. nodeId is the id of a located node in this version (`nodes`); a text node anchors to its element.
 * The anchor: {format: "html", nodeId (a hint for this version only), path, tag, elementId, kind, textHash (of the element's own text),
 * text (its visible text, normalized, 2,000 characters), quote, prefix, suffix (normalized, 40 characters of context), start, end (the
 * quote in the element's visible text), heading, flatAt (where the element starts in the page's visible text, to search near)}.
 * Everything is paid from the budget (src/text.js): when the element's text cannot be paid for, the anchor is weak (`weak: true`, the
 * path and the page's context, no hash), and resolveHtml finds it again by its path.
 */
export function htmlDurable(read, anchor) {
  const loc = anchor?.location;
  const el = loc ? elementOf(read, loc.nodeId) : null;
  if (!el) return null;
  const path = spend(el.__depth + 1) ? elementPath(el) : null;
  if (!path) return null;
  const tag = safeTag(el.tagName);
  const elementId = (() => {
    const id = idOf(el);
    return id !== null && read.byId.get(id) === el ? id : null;
  })();
  const base = { format: "html", nodeId: el.__id ?? null, path, tag, elementId, kind: el.__unit !== undefined ? read.units[el.__unit].kind : "element", flatAt: el.__fs ?? 0 };
  const whole = anchor.cut === true || !!anchor.hitKind;
  const excerpt = rawTextOf(read, el).slice(0, 2 * KEEP);
  if (!spend(ownCost(el)) || !spend(weigh(excerpt))) {
    // weak: the path and the page's context, cut, not normalized (nothing more can be paid for)
    return { ...base, weak: true, textHash: null, text: "", quote: "", prefix: cutText(String(anchor.prefix ?? "").slice(-CTX), CTX), suffix: cutText(String(anchor.suffix ?? ""), CTX), start: null, end: null, heading: "" };
  }
  const q = whole ? "" : (normPaid(anchor.quote) ?? "");
  const prefix = (normPaid(String(anchor.prefix ?? "").slice(-4 * CTX)) ?? "").slice(-CTX);
  const suffix = (normPaid(String(anchor.suffix ?? "").slice(0, 4 * CTX)) ?? "").slice(0, CTX);
  // the page's offsets (decoded source text) turned into this module's (whitespace folded): the exact place, not a hint that misses
  const rawQuote = String(anchor.quote ?? "");
  const lead = rawQuote.length - rawQuote.replace(/^[ \t\n\f\r]+/, "").length;
  const at = placeIn(read, el, q, q ? hintOf(read, el, loc, lead) : null, prefix, suffix);
  return {
    ...base,
    textHash: ownHash(el),
    text: normText(excerpt).slice(0, KEEP),
    quote: q,
    prefix,
    suffix,
    start: at >= 0 ? at : null,
    end: at >= 0 ? at + q.length : null,
    heading: headingFor(read, el),
  };
}

/** The element at a durable path ([`tag:nth`], see elementPath), or null. Each step pays for the children it scans. */
export function byPath(read, path) {
  let x = read.doc;
  for (const seg of path) {
    const m = /^(.*):(\d+)$/.exec(seg);
    if (!m) return null;
    const ks = kids(x);
    if (!spend(ks.length + 1)) return null;
    const want = Number(m[2]);
    let next = null;
    for (const c of ks) {
      if (isEl(c) && c.__nth === want && safeTag(c.tagName) === m[1]) {
        next = c;
        break;
      }
    }
    if (!next) return null;
    x = next;
  }
  return x === read.doc ? null : x;
}
/** The deepest element whose visible text holds [s, e): from the element that holds the text at `s`, up. */
function elementAt(read, s, e) {
  // the text node that holds offset s: the last one starting at or before it, found by walking the units' elements is not enough (a
  // text node of a non-unit), so the walk goes by the located nodes' visible-text starts
  const ts = read.__textStarts ||= read.nodes.filter((x) => isText(x) && x.__fs !== undefined).sort((a, b) => a.__fs - b.__fs);
  let lo = 0;
  let hi = ts.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (ts[m].__fs <= s) lo = m + 1;
    else hi = m;
  }
  let x = lo > 0 ? ts[lo - 1].__par : null;
  while (x && isEl(x) && !((x.__fs ?? 0) <= s && (x.__fe ?? 0) >= e)) x = x.__par;
  while (x && isEl(x) && !x.sourceCodeLocation) x = x.__par;
  return x && isEl(x) ? x : null;
}
const NEAR = 8192;
/**
 * The occurrence of `q` in the page's visible text closest to `at` that best matches the context (prefix and suffix), searched near the
 * old place first, then over the whole text. Paid from the budget: a search it cannot pay for finds nothing. -1 when none.
 */
function nearestQuote(read, q, at, prefix, suffix) {
  const f = read.flat;
  const holder = read.__hits ||= { text: f };
  for (const [s, e] of [[Math.max(0, at - NEAR), Math.min(f.length, at + NEAR + q.length)], [0, f.length]]) {
    const whole = s === 0 && e === f.length;
    if (!spend(whole ? searchCost(f.length, q, hitsOf(HITS, holder, f, q)) : searchCost(e - s, q))) return -1;
    const best = bestOccurrence(f, q, s, e, at, prefix, suffix);
    if (best >= 0) return best;
    if (whole) break;
  }
  return -1;
}
const HITS = new WeakMap();
/** `x` or its nearest located ancestor whose (safe) tag is `tag`, or null. */
function withTag(x, tag) {
  for (let y = x; y && isEl(y); y = y.__par) if (safeTag(y.tagName) === tag && y.sourceCodeLocation) return y;
  return null;
}

/**
 * Re-resolve a durable anchor against a (newer) reading. Order (3.4): the unique id attribute; the same path with the same own-text hash
 * (a weak anchor: the same path and tag); the quote (or the start of the element's text) searched near its old place, then everywhere,
 * with its context; all within the budget. Result: {method: "id" | "path" | "quote" | "none", nodeId, path, tag, elementId, start, end,
 * changed (its own text differs), quoteLost, text (200 characters), heading}.
 */
export function resolveHtml(read, d) {
  if (!d || d.format !== "html") return { method: "none" };
  let el = null;
  let method = "none";
  if (d.elementId && spend(1)) {
    const x = read.byId.get(d.elementId) || null;
    if (x) [el, method] = [x, "id"];
  }
  if (!el && Array.isArray(d.path)) {
    const x = byPath(read, d.path);
    if (x && (d.weak ? safeTag(x.tagName) === d.tag : spend(ownCost(x)) && ownHash(x) === d.textHash && (d.textHash !== EMPTY || sameText(read, x, d.text)))) [el, method] = [x, "path"];
  }
  if (!el && !d.weak) {
    const needle = d.quote || (d.text || "").slice(0, 60);
    const old = (Number(d.flatAt) || 0) + (d.quote && Number.isInteger(d.start) ? d.start : 0); // where it was in the visible text
    const at = needle ? nearestQuote(read, needle, old, d.quote ? d.prefix : "", d.quote ? d.suffix : "") : -1;
    if (at >= 0) {
      let x = elementAt(read, at, at + needle.length);
      if (!d.quote) x = withTag(x, d.tag) || x; // an element anchor (no quote) lands on the element of its own tag that holds the text
      if (x) [el, method] = [x, "quote"];
    }
  }
  while (el && isEl(el) && !el.sourceCodeLocation) el = el.__par; // an implied element at the path: its located ancestor (it has an id)
  if (!el || !isEl(el)) return { method: "none" };
  const q = d.quote || "";
  const at = q ? placeIn(read, el, q, Number.isInteger(d.start) ? d.start : null, d.prefix, d.suffix) : -1;
  const text = rawTextOf(read, el).slice(0, 800);
  return {
    method,
    nodeId: el.__id ?? null,
    // where the page draws it, in its own offsets (pageLocation): the quote's exact characters, or the whole element
    page: at >= 0 ? pageLocation(read, el, at, at + q.length) || { nodeId: el.__id ?? null } : { nodeId: el.__id ?? null },
    path: pathString(elementPath(el)),
    tag: safeTag(el.tagName),
    elementId: d.elementId && read.byId.get(d.elementId) === el ? d.elementId : null,
    start: at >= 0 ? at : null,
    end: at >= 0 ? at + q.length : null,
    changed: !(spend(ownCost(el)) && ownHash(el) === d.textHash),
    quoteLost: !!q && at < 0,
    text: spend(weigh(text)) ? normText(text).slice(0, 200) : "",
    heading: headingFor(read, el),
  };
}

/** Locator fields for the batch (the names an op's target will use): the path an agent reads, the safe id, the text hash, the quote's place. */
export const htmlLocator = (d) =>
  d ? { path: pathString(d.path), element_id: typeof d.elementId === "string" && SAFE_NAME.test(d.elementId) ? d.elementId : null, text_hash: d.textHash ?? null, start: d.start ?? null, end: d.end ?? null } : null;

// ---- splices and the proof ------------------------------------------------------------------------------------------------------------
/**
 * The proof of a splice (S2's lockstep proof, recommended over hashing both trees): `afterBytes` decode the same way (UTF-8, the same BOM),
 * parse within the limits, and their tree equals the old one everywhere outside the edited place: the same nodes along the path to the
 * edited parent, every subtree off that path equal, and the edited parent's children equal to the expected list (the old ones before `i`,
 * `make()`'s nodes, the old ones from `j`; adjacent text merged, empty text dropped). `edit` = {parentPath, i, j, make} (see editText,
 * editAttributes, editChildren). Holds at most two trees: the old reading's and the new parse. Returns {ok: true, parsed} (pass `parsed`
 * to readParsed for the new reading, never a third parse) or {ok: false, code}: "decode", "bom", "limits", "ancestor_changed",
 * "sibling_changed", "parent_changed", "children_count", "edited_place_differs".
 */
export function proveSplice(before, afterBytes, edit) {
  const b = Buffer.isBuffer(afterBytes) ? afterBytes : Buffer.from(afterBytes.buffer, afterBytes.byteOffset, afterBytes.byteLength);
  if (b.length > before.limits.bytes) return { ok: false, code: "limits", why: capBytes(b.length, before.limits.bytes).message };
  const dec = decodeHtml(b);
  if (!dec.ok) return { ok: false, code: "decode" };
  if (dec.bomLen !== before.bomLen) return { ok: false, code: "bom" };
  let parsed;
  try {
    parsed = parseLimited(dec.text, before.limits);
  } catch (err) {
    if (err instanceof CapError) return { ok: false, code: "limits", why: err.message };
    throw err;
  }
  let a = before.doc;
  let y = parsed.doc;
  const { parentPath, i, j } = edit;
  for (let depth = 0; depth < parentPath.length; depth++) {
    if (!shallowSame(a, y)) return { ok: false, code: "ancestor_changed" };
    const ak = kids(a);
    const bk = kids(y);
    if (ak.length !== bk.length) return { ok: false, code: "children_count" };
    const at = parentPath[depth];
    for (let k = 0; k < ak.length; k++) if (k !== at && !deepEqual(ak[k], bk[k])) return { ok: false, code: "sibling_changed" };
    a = ak[at];
    y = bk[at];
    if (!a || !y) return { ok: false, code: "ancestor_changed" };
  }
  if (!shallowSame(a, y)) return { ok: false, code: "parent_changed" };
  const old = kids(a);
  const want = [];
  for (const x of [...old.slice(0, i), ...edit.make(), ...old.slice(j)]) {
    if (isText(x)) {
      if (x.value === "") continue;
      const p = want[want.length - 1];
      if (p && isText(p)) {
        want[want.length - 1] = { nodeName: "#text", value: p.value + x.value };
        continue;
      }
    }
    want.push(x);
  }
  const got = kids(y);
  if (got.length !== want.length) return { ok: false, code: "children_count" };
  for (let k = 0; k < got.length; k++) if (!deepEqual(want[k], got[k])) return { ok: false, code: "edited_place_differs" };
  return { ok: true, parsed: { bytes: b, text: dec.text, bomLen: dec.bomLen, doc: parsed.doc, dupOffsets: parsed.dupOffsets, limits: before.limits } };
}

/** The edit of replacing one text node's value (`newText` "" removes it). */
export const editText = (node, newText) => ({ parentPath: pathOf(node.__par), i: node.__idx, j: node.__idx + 1, make: () => (newText === "" ? [] : [{ nodeName: "#text", value: newText }]) });
/** The edit of giving an element a new attribute list (its children unchanged). */
export const editAttributes = (el, attrs) => ({ parentPath: pathOf(el.__par), i: el.__idx, j: el.__idx + 1, make: () => [{ ...el, attrs: attrs.map((a) => ({ ...a })) }] });
/** The edit of replacing children [i, j) of `parent` with the nodes `make()` returns (a fragment parsed in the parent's context). */
export const editChildren = (parent, i, j, make) => ({ parentPath: pathOf(parent), i, j, make });

/** `bytes` with [s, e) of the decoded text (UTF-16 offsets) replaced by `repl`, through the one byte map. */
export function spliceBytes(read, s, e, repl) {
  const b0 = read.toByte(s);
  const b1 = read.toByte(e);
  return Buffer.concat([read.bytes.subarray(0, b0), Buffer.from(repl, "utf8"), read.bytes.subarray(b1)]);
}

/**
 * The person's text edit (R11: the edit unit is one source text node): replace the text node `nodeId` with `newText`, escaped for its
 * context, then prove the result. Returns {ok: true, bytes, parsed} or {ok: false, code}: "no_such_node", "not_text", "whitespace_only",
 * "frozen" (raw text), "not_addressable" (R8), "nul", "lone_surrogate", "would_change_structure" (the proof refused), "limits".
 */
export function spliceText(read, nodeId, newText) {
  const x = read.nodes[nodeId];
  if (!x) return { ok: false, code: "no_such_node" };
  if (!isText(x)) return { ok: false, code: "not_text" };
  const context = textContext(x);
  if (context === "raw" || x.__hidden) return { ok: false, code: "frozen" };
  if (!/\S/.test(x.value)) return { ok: false, code: "whitespace_only" };
  if (x.__ok !== true) return { ok: false, code: "not_addressable" };
  newText = String(newText);
  const [s, e] = textRange(x, read.text);
  const pst = x.__ctx?.sourceCodeLocation?.startTag;
  const esc = escapeText(newText, context, { atStartOfLeadingLf: leadingLfParent(x) && !!pst && s === pst.endOffset });
  if (!esc.ok) return { ok: false, code: esc.code };
  const bytes = spliceBytes(read, s, e, esc.out);
  const p = proveSplice(read, bytes, editText(x, newText));
  if (!p.ok) return { ok: false, code: p.code === "limits" ? "limits" : "would_change_structure" };
  return { ok: true, bytes, parsed: p.parsed };
}

// ---- many edits at once, and whole files (Phase 1c: src/ops/html.js, src/html-write.js) ----------------------------------------------
/** The deepest element nesting of a tree, iterative. */
function depthOf(doc) {
  let max = 0;
  const st = [[doc, 0]];
  while (st.length) {
    const [x, d] = st.pop();
    if (d > max) max = d;
    for (const c of kids(x)) if (isEl(c)) st.push([c, d + 1]);
  }
  return max;
}

/**
 * Bytes as an HTML file, without the index a reading builds: size, decoding, one parse with source locations within the limits, depth.
 * For a whole new version (a commit) that has no edit to prove. Returns {ok: true, bytes, text, bomLen, declared, doc, dupOffsets,
 * limits} or {ok: false, code, why}: code "limits" (why: the limit in plain words) or the decoding's code (utf16, invalid_utf8,
 * roundtrip, not_utf8).
 */
export function parseChecked(bytes, limits = HTML_LIMITS) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length > limits.bytes) return { ok: false, code: "limits", why: capBytes(b.length, limits.bytes).message };
  const d = decodeHtml(b);
  if (!d.ok) return { ok: false, code: d.code, why: d.sentence };
  let parsed;
  try {
    parsed = parseLimited(d.text, limits);
  } catch (err) {
    if (err instanceof CapError) return { ok: false, code: "limits", why: err.message };
    throw err;
  }
  if (depthOf(parsed.doc) > limits.depth) return { ok: false, code: "limits", why: capDepth(limits.depth).message };
  return { ok: true, bytes: b, text: d.text, bomLen: d.bomLen, declared: d.declared, doc: parsed.doc, dupOffsets: parsed.dupOffsets, limits };
}

/** A fragment parsed in the context of element `ctx` as the page parses (scripting on): its nodes, and whether serializing them and parsing that again gives the same nodes. */
export function parseFragmentIn(ctx, markup) {
  const p5 = parser();
  const f = p5.parseFragment(ctx, markup, { scriptingEnabled: true });
  const again = p5.parseFragment(ctx, p5.serialize(f), { scriptingEnabled: true }).childNodes;
  const nodes = f.childNodes;
  return { nodes, roundTrips: nodes.length === again.length && nodes.every((x, i) => deepEqual(x, again[i])) };
}

/**
 * The lockstep proof of many edits at once (the composite form of proveSplice, so a batch of ops costs one parse, not one per op: one
 * parse with its proof took about 1.5 s of worker CPU at the limits). `plan`:
 *   texts:    Map(text node -> its new value; "" removes it)
 *   attrs:    Map(element -> its new attribute list; its children compared as usual)
 *   children: Map(parent -> [{i, j, make}] sorted by i, an insertion (i === j) before a range starting at the same i, then op order):
 *             children [i, j) of the parent replaced by make()'s nodes; ranges do not overlap.
 * Every node not named compares equal to the old one (names, namespaces, attributes in order, values, comments, the doctype); each edited
 * parent's children equal the expected list (adjacent text merged, empty text dropped). Holds at most two trees. Returns {ok: true,
 * parsed} or {ok: false, code}: "limits", "decode", "bom", "node_changed", "children_count", "edited_place_differs".
 */
export function proveEdits(before, afterBytes, plan) {
  const b = Buffer.isBuffer(afterBytes) ? afterBytes : Buffer.from(afterBytes.buffer, afterBytes.byteOffset, afterBytes.byteLength);
  const p = parseChecked(b, before.limits);
  if (!p.ok) return p.code === "limits" ? { ok: false, code: "limits", why: p.why } : { ok: false, code: "decode" };
  if (p.bomLen !== before.bomLen) return { ok: false, code: "bom" };
  const T = plan.texts || new Map();
  const A = plan.attrs || new Map();
  const C = plan.children || new Map();
  const edited = new Set(C.keys());
  for (const t of T.keys()) edited.add(t.__par);
  const stack = [[before.doc, p.doc]];
  while (stack.length) {
    const [a, y] = stack.pop();
    if (a.nodeName !== y.nodeName) return { ok: false, code: "node_changed" };
    if (isEl(a)) {
      const want = A.get(a) || a.attrs;
      if (a.tagName !== y.tagName || a.namespaceURI !== y.namespaceURI || want.length !== y.attrs.length) return { ok: false, code: "node_changed" };
      for (let k = 0; k < want.length; k++) {
        const u = want[k];
        const v = y.attrs[k];
        if (u.name !== v.name || u.value !== v.value || (u.namespace || "") !== (v.namespace || "") || (u.prefix || "") !== (v.prefix || "")) return { ok: false, code: "node_changed" };
      }
    } else if (!shallowSame(a, y) || (a.nodeName === "#documentType" && (a.name !== y.name || a.publicId !== y.publicId || a.systemId !== y.systemId))) return { ok: false, code: "node_changed" };
    const ak = kids(a);
    const yk = kids(y);
    if (!edited.has(a)) {
      if (ak.length !== yk.length) return { ok: false, code: "children_count" };
      for (let k = 0; k < ak.length; k++) {
        if (isText(ak[k])) {
          if (!isText(yk[k]) || ak[k].value !== yk[k].value) return { ok: false, code: "node_changed" };
        } else stack.push([ak[k], yk[k]]);
      }
      continue;
    }
    // the expected children of an edited parent: {text} (merged, possibly edited), {orig} (compared in lockstep), {made} (compared whole)
    const want = [];
    const putText = (v) => {
      if (v === "") return;
      const last = want[want.length - 1];
      if (last && last.text !== undefined) last.text += v;
      else want.push({ text: v });
    };
    const putOld = (x) => (isText(x) ? putText(T.has(x) ? T.get(x) : x.value) : want.push({ orig: x }));
    const putMade = (x) => (isText(x) ? putText(x.value) : want.push({ made: x }));
    let k = 0;
    for (const e of C.get(a) || []) {
      while (k < e.i) putOld(ak[k++]);
      for (const x of e.make()) putMade(x);
      k = Math.max(k, e.j);
    }
    while (k < ak.length) putOld(ak[k++]);
    if (want.length !== yk.length) return { ok: false, code: "children_count" };
    for (let q = 0; q < want.length; q++) {
      const w = want[q];
      const g = yk[q];
      if (w.text !== undefined) {
        if (!isText(g) || g.value !== w.text) return { ok: false, code: "edited_place_differs" };
      } else if (w.orig) stack.push([w.orig, g]);
      else if (!deepEqual(w.made, g)) return { ok: false, code: "edited_place_differs" };
    }
  }
  return { ok: true, parsed: { bytes: b, text: p.text, bomLen: p.bomLen, doc: p.doc, dupOffsets: p.dupOffsets, limits: before.limits } };
}
