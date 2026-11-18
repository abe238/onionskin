// The HTML view's pure logic (PLAN-html R4, R6, R8, R9, R11, R14, R15, R17, R18): no React, and nothing touches a DOM global when this
// module is imported, so the unit tests run it in Node over a parse5 tree of a real render copy.
//
// Every read of the frame goes through an accessor object `D` (see realmDom): parent, first child, next sibling, node type, text data,
// attributes. In the page, D is made of getters and methods captured from the PAGE's own realm and called on frame nodes, never a property
// of a frame object (a page can shadow `doc.body`, `form.getAttribute` and the like with element names and ids: spike S1, test 6). In the
// tests, D reads a parse5 tree.
//
// Text slots. The copy's n-th text node in tree order is source text node `texts[n]` (src/html-render.js; -1 for text the copy added, such
// as a placeholder's label). The copy writes `<!---->` between two text nodes that are siblings, so a run of adjacent Text siblings in the
// frame is ONE slot: WebKit splits a text node longer than 65,536 characters into several (measured), and a slot keeps them together with
// offsets counted across the run. Offsets in an anchor count UTF-16 code units of the source text node's own text, decoded (entities as
// the characters they stand for, whitespace as written), which is what the frame's text holds and what src/html-write.js textEdit takes.

import { store as pageStore } from "./lib.js";

// ---- fixed sentences (R6, R15, R16, R18, D1, D2, D4, R21) ---------------------------------------------------------------------------
export const SAY = {
  label: "Your page (still view)",
  firstRun: "This is a still view of your page: scripts are off and nothing loads from the internet.",
  firstRunOk: "Got it",
  scripts: "Scripts are off in this view.",
  remote: (n) => `${n.toLocaleString("en-US")} ${n === 1 ? "thing" : "things"} from the internet ${n === 1 ? "was" : "were"} not loaded.`,
  heavy: "This page's styles are too heavy to show; the text is shown plain.",
  folder: "Pictures and styles next to this page are not shown, because the page is in your home folder or at the top of a disk.",
  plain: {
    reparse: "This page's markup could not be shown safely, so it is shown as plain text.",
    style_end: "This page's styles could not be shown safely, so it is shown as plain text.",
    nul: "This page holds characters that cannot be shown safely, so it is shown as plain text.",
    lone_surrogate: "This page holds characters that cannot be shown safely, so it is shown as plain text.",
    crash: "This page made Onionskin's view stop responding last time, so it is shown as plain text.",
    other: "This page is shown as plain text.",
  },
  crashed: "This page made Onionskin's view stop responding last time",
  crashedRetry: "Try the full view again",
  scriptsOnly: "This page is built by scripts, which Onionskin never runs, so there is nothing to show.",
  readOnlyPart: "This part of the page cannot be edited here; comment on it instead.",
  notEditMode: "Typing fixes text in Edit mode; this mode is for comments.",
  lostTitle: (n) => (n === 1 ? "One of your text edits could not be placed on the new version of the file" : `${n} of your text edits could not be placed on the new version of the file`),
  lostWhy: "Its text is not where it was, so it was not put anywhere. Copy it and type it again where it belongs.",
  copy: "Copy",
  copied: "Copied",
  dismiss: "Done",
  blocked: "New lines and elements are the agent's job: say what you want in the comment.",
  running: "The agent is working; comment now and fix text when it is done.",
  // read only for another reason than a run (setReadOnly's reason): its own sentence
  otherTab: "This file is open for editing in another tab, so typing is off here; comments still work.",
  sending: "Your edits are on their way; typing is back once Onionskin answers.",
  mismatch: "The text in this view could not be matched to the file, so selecting and typing are off; in Comment mode, click a part of the page to comment on it.",
  hide: "Hide this in the view",
  showHidden: (n) => `Show ${n === 1 ? "the part" : `the ${n} parts`} hidden in this view`,
};

/** The sentence for a plain text view, from renderCopy's reason ("reparse", "nul", "lone_surrogate", "style_end") or "crash" (R6). */
export const plainSentence = (reason) => SAY.plain[reason] || SAY.plain.other;

// ---- the text hash of a pending edit -----------------------------------------------------------------------------------------------
// One function for the page and the server (src/edit-hash.js): cyrb53 over the exact text, 14 hex digits (vectors: test/html-view.test.js).
import { editHash } from "../../src/edit-hash.js";
export { editHash };

// ---- DOM access through the page's own prototypes (R4) -----------------------------------------------------------------------------
const TEXT = 3;
const ELEMENT = 1;

/**
 * The accessor object over a real DOM, made of getters and methods taken from `win`'s prototypes (the page's realm) and called on frame
 * nodes. Only called in the browser; nothing here runs at import.
 */
export function realmDom(win) {
  const find = (proto, name) => {
    for (let p = proto; p; p = Object.getPrototypeOf(p)) {
      const d = Object.getOwnPropertyDescriptor(p, name);
      if (d) return d;
    }
    throw new Error(`no ${name} on the page's prototypes`);
  };
  const bind = (f) => Function.prototype.call.bind(f);
  const get = (proto, name) => bind(find(proto, name).get);
  const set = (proto, name) => bind(find(proto, name).set);
  const fn = (proto, name) => bind(find(proto, name).value);
  const N = win.Node.prototype;
  const El = win.Element.prototype;
  const Doc = win.Document.prototype;
  const HEl = win.HTMLElement.prototype;
  const Sel = win.Selection.prototype;
  const Rng = win.Range.prototype;
  const Css = win.CSSStyleDeclaration.prototype;
  const NL = win.NodeList.prototype;
  const CD = win.CharacterData.prototype;
  const Frame = win.HTMLIFrameElement.prototype;
  const getAttr = fn(El, "getAttribute");
  return {
    parent: get(N, "parentNode"),
    first: get(N, "firstChild"),
    last: get(N, "lastChild"),
    next: get(N, "nextSibling"),
    prev: get(N, "previousSibling"),
    type: get(N, "nodeType"),
    data: get(CD, "data"),
    setData: set(CD, "data"),
    tag: get(El, "localName"),
    attr: getAttr,
    oskId: (el) => {
      const v = getAttr(el, "data-osk-id");
      return v === null || v === "" ? null : Number(v);
    },
    setAttr: fn(El, "setAttribute"),
    removeAttr: fn(El, "removeAttribute"),
    hasAttr: fn(El, "hasAttribute"),
    replaceChildren: fn(El, "replaceChildren"),
    createText: fn(Doc, "createTextNode"),
    removeChild: fn(N, "removeChild"),
    contains: fn(N, "contains"),
    rect: fn(El, "getBoundingClientRect"),
    elementRects: fn(El, "getClientRects"),
    editableNow: get(HEl, "isContentEditable"),
    focus: fn(HEl, "focus"),
    style: get(HEl, "style"),
    setStyle: fn(Css, "setProperty"),
    removeStyle: fn(Css, "removeProperty"),
    qsaDoc: fn(Doc, "querySelectorAll"),
    listLength: get(NL, "length"),
    listItem: fn(NL, "item"),
    docElement: get(Doc, "documentElement"),
    body: get(Doc, "body"),
    scroller: get(Doc, "scrollingElement"),
    url: get(Doc, "URL"),
    getSelection: fn(Doc, "getSelection"),
    createRange: fn(Doc, "createRange"),
    elementFromPoint: fn(Doc, "elementFromPoint"),
    scrollTop: get(El, "scrollTop"),
    setScrollTop: set(El, "scrollTop"),
    scrollLeft: get(El, "scrollLeft"),
    setScrollLeft: set(El, "scrollLeft"),
    scrollHeight: get(El, "scrollHeight"),
    clientHeight: get(El, "clientHeight"),
    clientWidth: get(El, "clientWidth"),
    rangeCount: get(Sel, "rangeCount"),
    rangeAt: fn(Sel, "getRangeAt"),
    collapse: fn(Sel, "collapse"),
    removeRanges: fn(Sel, "removeAllRanges"),
    addRange: fn(Sel, "addRange"),
    startContainer: get(Rng, "startContainer"),
    startOffset: get(Rng, "startOffset"),
    endContainer: get(Rng, "endContainer"),
    endOffset: get(Rng, "endOffset"),
    setStart: fn(Rng, "setStart"),
    setEnd: fn(Rng, "setEnd"),
    rangeRects: fn(Rng, "getClientRects"),
    frameDoc: get(Frame, "contentDocument"),
    setBaseAndExtent: fn(Sel, "setBaseAndExtent"),
    /** The text position at a point of the frame's viewport: {node, offset} or null (caretRangeFromPoint; caretPositionFromPoint in Firefox). */
    caretAt: (() => {
      const has = (name) => {
        try {
          return find(Doc, name).value;
        } catch {
          return null;
        }
      };
      const crfp = has("caretRangeFromPoint");
      const cpfp = has("caretPositionFromPoint");
      if (crfp) {
        const call = bind(crfp);
        const sc = get(Rng, "startContainer");
        const so = get(Rng, "startOffset");
        return (doc, x, y) => {
          const r = call(doc, x, y);
          return r ? { node: sc(r), offset: so(r) } : null;
        };
      }
      if (cpfp) {
        const call = bind(cpfp);
        const node = get(win.CaretPosition.prototype, "offsetNode");
        const off = get(win.CaretPosition.prototype, "offset");
        return (doc, x, y) => {
          const p = call(doc, x, y);
          return p ? { node: node(p), offset: off(p) } : null;
        };
      }
      return () => null;
    })(),
    /** A frame DOMRect as plain numbers, read through the page's getters. */
    box: (() => {
      const R = win.DOMRectReadOnly.prototype;
      const [l, t, w, h] = ["left", "top", "width", "height"].map((k) => get(R, k));
      return (r) => ({ left: l(r), top: t(r), width: w(r), height: h(r), right: l(r) + w(r), bottom: t(r) + h(r) });
    })(),
    /** A frame DOMRectList as an array of its rects. */
    boxes: (() => {
      const L = win.DOMRectList.prototype;
      const len = get(L, "length");
      const item = fn(L, "item");
      return (list) => Array.from({ length: len(list) }, (_, i) => item(list, i));
    })(),
  };
}

const isText = (D, n) => D.type(n) === TEXT;
const isEl = (D, n) => D.type(n) === ELEMENT;

/** The node after `n` in tree order within `root` (pre-order), or null. `skip` skips n's children. */
function after(D, n, root, skip = false) {
  if (!skip) {
    const f = D.first(n);
    if (f) return f;
  }
  for (let x = n; x && x !== root; x = D.parent(x)) {
    const s = D.next(x);
    if (s) return s;
  }
  return null;
}

// ---- the text index --------------------------------------------------------------------------------------------------------------
/**
 * One pass over the document in tree order: every Text node -> {n, base} (its slot and where it starts in the slot's text), and each slot's
 * first Text node. Ceiling: one Map entry per Text node (a page at the limits has a few hundred thousand), built once per version.
 */
export function buildIndex(D, root) {
  const slotOf = new Map();
  const firsts = [];
  let n = -1;
  for (let x = D.first(root); x; x = after(D, x, root)) {
    if (!isText(D, x)) continue;
    const p = D.prev(x);
    if (p && isText(D, p)) {
      const ps = slotOf.get(p);
      slotOf.set(x, { n: ps.n, base: ps.base + D.data(p).length });
    } else {
      n++;
      firsts.push(x);
      slotOf.set(x, { n, base: 0 });
    }
  }
  return { slotOf, firsts, count: n + 1 };
}

/** The Text nodes of the slot that starts at `first`. */
export function slotNodes(D, first) {
  const out = [first];
  for (let x = D.next(first); x && isText(D, x); x = D.next(x)) out.push(x);
  return out;
}
export const slotText = (D, first) => slotNodes(D, first).map((t) => D.data(t)).join("");

/** The slot of a Text node, registering it when the browser made it after the index (typing can replace a Text object). */
function slotFor(ix, D, t) {
  let s = ix.slotOf.get(t);
  if (s) return s;
  let first = t;
  let base = 0;
  for (let p = D.prev(t); p && isText(D, p); p = D.prev(p)) {
    first = p;
    base += D.data(p).length;
  }
  const fs = ix.slotOf.get(first);
  if (!fs) return null;
  s = { n: fs.n, base: fs.base + base };
  ix.slotOf.set(t, s);
  return s;
}

/** Slot `n` now starts at Text node `first` (the browser replaced its Text objects while the person typed): the index follows it. */
export function registerSlot(ix, D, first, n) {
  ix.firsts[n] = first;
  let base = 0;
  for (const t of slotNodes(D, first)) {
    ix.slotOf.set(t, { n, base });
    base += D.data(t).length;
  }
}
/** The slot {n, base} of a Text node, or null. */
export const slotOfNode = (ix, D, t) => slotFor(ix, D, t);

/** The nearest element at or above `n` that carries a data-osk-id (a located element of the source: R8). */
export function locatedOf(D, n) {
  for (let x = n; x; x = D.parent(x)) if (isEl(D, x) && D.oskId(x) !== null) return x;
  return null;
}

/** A DOM boundary point turned into a Text node and offset: the first text at or after it (start), the last text before it (end). */
function textPoint(D, container, offset, side, root) {
  if (isText(D, container)) return { node: container, offset };
  if (!isEl(D, container) && D.type(container) !== 9) return null;
  let child = D.first(container);
  for (let i = 0; child && i < offset; i++) child = D.next(child);
  if (side === "start") {
    for (let x = child ?? after(D, container, root, true); x; x = after(D, x, root)) if (isText(D, x)) return { node: x, offset: 0 };
    return null;
  }
  // end: the last Text before `child` (or before the end of container) in tree order
  let x = child ? child : null;
  const prevInOrder = (n) => {
    const p = D.prev(n);
    if (!p) return D.parent(n);
    let d = p;
    for (let l = D.last(d); l; l = D.last(d)) d = l;
    return d;
  };
  let y;
  if (x) y = prevInOrder(x);
  else {
    y = container;
    for (let l = D.last(y); l; l = D.last(y)) y = l;
  }
  for (; y && y !== root; y = prevInOrder(y)) if (isText(D, y)) return { node: y, offset: D.data(y).length };
  return null;
}

/**
 * The text of an element as the anchor counts it: its slots that come from the source (texts[n] >= 0), in tree order, joined. `wanted`
 * slots get their start offset in it. Stops early once `stopAfter` characters past the last wanted slot are read.
 */
function elementText(D, ix, texts, el, wanted = new Set(), stopAfter = Infinity) {
  let s = "";
  const at = new Map();
  let pendingWanted = wanted.size;
  let stopAt = wanted.size ? Infinity : stopAfter; // nothing wanted: read `stopAfter` characters
  for (let x = D.first(el); x; x = after(D, x, el)) {
    if (!isText(D, x)) continue;
    const prev = D.prev(x);
    if (prev && isText(D, prev)) continue; // a slot is read from its first node
    const sl = slotFor(ix, D, x);
    if (!sl || texts[sl.n] === undefined || texts[sl.n] < 0) continue;
    if (wanted.has(sl.n)) {
      at.set(sl.n, s.length);
      pendingWanted--;
    }
    s += slotText(D, x);
    if (pendingWanted === 0 && stopAt === Infinity) stopAt = s.length + stopAfter;
    if (s.length >= stopAt) break;
  }
  return { text: s, at };
}

const CTX = 40;

/**
 * A selection range in the frame -> the page anchor of PHASE-1A-INTERFACE: {location: {nodeId, start, end}, quote, prefix, suffix}.
 * Within one slot: nodeId is that source text node and start/end index its text. Across slots: nodeId is the nearest located element
 * that holds both ends, and start/end index elementText of it (the source text of its located text, in order). null when nothing of the
 * source is selected.
 * `r` = {startContainer, startOffset, endContainer, endOffset}; ctx = {D, ix, texts, root}.
 */
export function anchorFromRange(r, { D, ix, texts, root }) {
  const s = textPoint(D, r.startContainer, r.startOffset, "start", root);
  const e = textPoint(D, r.endContainer, r.endOffset, "end", root);
  if (!s || !e) return null;
  const ss = slotFor(ix, D, s.node);
  const es = slotFor(ix, D, e.node);
  if (!ss || !es) return null;
  const sPos = ss.base + s.offset;
  const ePos = es.base + e.offset;
  if (ss.n > es.n || (ss.n === es.n && sPos >= ePos)) return null;
  if (ss.n === es.n) {
    const src = texts[ss.n];
    if (src === undefined || src < 0) return null;
    const first = ix.firsts[ss.n];
    const t = slotText(D, first);
    const quote = t.slice(sPos, ePos);
    if (!quote) return null;
    // context from the located element that holds the text, so a short text node still has its neighbors' words around it
    const el = locatedOf(D, D.parent(first));
    let prefix = t.slice(Math.max(0, sPos - CTX), sPos);
    let suffix = t.slice(ePos, ePos + CTX);
    if (el) {
      const et = elementText(D, ix, texts, el, new Set([ss.n]), CTX + (t.length - ePos));
      const o = et.at.get(ss.n);
      if (o !== undefined) {
        prefix = et.text.slice(Math.max(0, o + sPos - CTX), o + sPos);
        suffix = et.text.slice(o + ePos, o + ePos + CTX);
      }
    }
    return { location: { nodeId: src, start: sPos, end: ePos }, quote, prefix, suffix };
  }
  // several slots: their nearest common located ancestor
  const up = new Set();
  for (let x = s.node; x; x = D.parent(x)) up.add(x);
  let common = e.node;
  while (common && !up.has(common)) common = D.parent(common);
  const el = locatedOf(D, common);
  if (!el) return null;
  // every slot between the ends: the first and last that come from the source stand for the ends
  const et = elementText(D, ix, texts, el, new Set([ss.n, es.n]), CTX);
  let start = et.at.has(ss.n) ? et.at.get(ss.n) + sPos : null;
  let end = et.at.has(es.n) ? et.at.get(es.n) + ePos : null;
  if (start === null || end === null) {
    // an end in text the copy added (a placeholder's label): move it to the nearest source text inside the selection
    const bounds = sourceBounds(D, ix, texts, el, ss.n, es.n);
    if (!bounds) return null;
    if (start === null) start = bounds.start;
    if (end === null) end = bounds.end;
  }
  const quote = et.text.slice(start, end);
  if (!quote) return null;
  return { location: { nodeId: D.oskId(el), start, end }, quote, prefix: et.text.slice(Math.max(0, start - CTX), start), suffix: et.text.slice(end, end + CTX) };
}

/** Where source text inside the slot range [n0, n1] starts and ends in elementText of `el`. */
function sourceBounds(D, ix, texts, el, n0, n1) {
  let len = 0;
  let start = null;
  let end = null;
  for (let x = D.first(el); x; x = after(D, x, el)) {
    if (!isText(D, x)) continue;
    const prev = D.prev(x);
    if (prev && isText(D, prev)) continue;
    const sl = slotFor(ix, D, x);
    if (!sl || texts[sl.n] === undefined || texts[sl.n] < 0) continue;
    const l = slotText(D, x).length;
    if (sl.n >= n0 && sl.n <= n1) {
      if (start === null) start = len;
      end = len + l;
    }
    len += l;
    if (sl.n > n1) break;
  }
  return start === null ? null : { start, end };
}

/** A click with no selection: the element anchor of the nearest located element (hitKind "element", as src/anchor-work.js names it). */
export function anchorFromElement(target, { D, ix, texts }) {
  const el = locatedOf(D, target);
  if (!el) return null;
  const { text } = elementText(D, ix, texts, el, new Set(), 2000);
  return { location: { nodeId: D.oskId(el) }, quote: text.replace(/\s+/g, " ").trim().slice(0, 500), prefix: "", suffix: "", hitKind: "element" };
}

/**
 * A page anchor's location -> a DOM range spec in the frame: {startNode, startOffset, endNode, endOffset} or {element} for a whole element,
 * or null when it is not in this version. ctx = {D, ix, texts, slotOfSource (source text id -> slot n), elementById(id)}.
 */
export function rangeOfLocation(loc, ctx) {
  const { D, ix } = ctx;
  if (!loc || !Number.isInteger(loc.nodeId)) return null;
  const n = ctx.slotOfSource.get(loc.nodeId);
  if (n !== undefined) {
    const nodes = slotNodes(D, ix.firsts[n]);
    const total = nodes.reduce((a, t) => a + D.data(t).length, 0);
    const s = Number.isInteger(loc.start) ? Math.max(0, Math.min(loc.start, total)) : 0;
    const e = Number.isInteger(loc.end) ? Math.max(s, Math.min(loc.end, total)) : total;
    return { ...pieceAt(D, nodes, s, "start"), ...pieceAt(D, nodes, e, "end") };
  }
  const el = ctx.elementById(loc.nodeId);
  if (!el) return null;
  if (!Number.isInteger(loc.start) || !Number.isInteger(loc.end)) return { element: el };
  // offsets in elementText(el): walk its source slots to the two points
  let len = 0;
  let start = null;
  let end = null;
  for (let x = D.first(el); x && !end; x = after(D, x, el)) {
    if (!isText(D, x)) continue;
    const prev = D.prev(x);
    if (prev && isText(D, prev)) continue;
    const sl = slotFor(ix, D, x);
    if (!sl || ctx.texts[sl.n] === undefined || ctx.texts[sl.n] < 0) continue;
    const nodes = slotNodes(D, x);
    const l = nodes.reduce((a, t) => a + D.data(t).length, 0);
    if (!start && loc.start <= len + l) start = pieceAt(D, nodes, loc.start - len, "start");
    if (start && loc.end <= len + l) end = pieceAt(D, nodes, loc.end - len, "end");
    len += l;
  }
  return start && end ? { ...start, ...end } : { element: el };
}

function pieceAt(D, nodes, off, side) {
  let o = off;
  for (let i = 0; i < nodes.length; i++) {
    const l = D.data(nodes[i]).length;
    if (o <= l || i === nodes.length - 1) return side === "start" ? { startNode: nodes[i], startOffset: Math.min(o, l) } : { endNode: nodes[i], endOffset: Math.min(o, l) };
    o -= l;
  }
  return null;
}

// ---- which text the person may type in (R8, D4, R17) --------------------------------------------------------------------------------
// The server supplies `editable`: the ids (in the reading's `nodes`) of the source text nodes the person may type in. Phase 2a computes it
// from the reading: a text node with `__ok === true` (located, not whitespace only, normal or RCDATA context, and its source slice parsed
// alone is it) that is not inside an `a`, a form control (button, select, option, optgroup, textarea, datalist, output, label for a
// control is fine), `title` or `head`. The page applies the markup half again (a link target, a placeholder, a control, head), so a
// list that is too generous still cannot open a link's text or a control's label for typing.
const NOT_TYPED = new Set(["button", "select", "option", "optgroup", "textarea", "input", "datalist", "output", "progress", "meter", "title", "head", "style"]);
// an Array or an Int32Array (the view route's body, src/html-envelope.js)
export const editableSet = (editable) => (editable instanceof Set ? editable : new Set(editable && typeof editable[Symbol.iterator] === "function" && typeof editable !== "string" ? editable : []));

/** May the person type in the slot of Text node `t`? */
export function canType(t, { D, ix, texts, editable }) {
  const sl = slotFor(ix, D, t);
  if (!sl) return false;
  const src = texts[sl.n];
  if (src === undefined || src < 0 || !editable.has(src)) return false;
  for (let x = D.parent(t); x && isEl(D, x); x = D.parent(x)) {
    if (NOT_TYPED.has(D.tag(x))) return false;
    if (D.attr(x, "data-osk-href") !== null || D.attr(x, "data-osk-placeholder") !== null) return false;
  }
  return true;
}

// ---- what typing did to an element (R11, R17) ---------------------------------------------------------------------------------------
/**
 * The shape of an element's subtree by position: each descendant element and each text slot, in tree order. Two shapes with the same
 * `key` have the same elements and slots in the same places (Text objects may differ: select-all and type can replace one). The snapshot
 * keeps each element's child nodes and each Text node's data, so restoreShape can put the subtree back exactly.
 */
export function shapeOf(D, host) {
  const parts = [];
  const kids = [];
  const datas = [];
  const slots = [];
  const walk = (el) => {
    const list = [];
    for (let c = D.first(el); c; c = D.next(c)) list.push(c);
    kids.push([el, list]);
  };
  walk(host);
  for (let x = D.first(host); x; x = after(D, x, host)) {
    const t = D.type(x);
    if (t === TEXT) {
      datas.push([x, D.data(x)]);
      const p = D.prev(x);
      if (!(p && isText(D, p))) {
        parts.push("T");
        slots.push(x);
      }
    } else if (t === ELEMENT) {
      parts.push(`<${D.tag(x)}>`);
      walk(x);
    } else parts.push(`#${t}`);
  }
  return { key: parts.join(""), slots, kids, datas, texts: slots.map((f) => slotText(D, f)) };
}

/** Puts a subtree back as `snap` holds it (child lists, then text). */
export function restoreShape(D, snap) {
  for (const [el, list] of snap.kids) D.replaceChildren(el, ...list);
  for (const [t, data] of snap.datas) if (D.data(t) !== data) D.setData(t, data);
}

/**
 * What typing changed in one slot's text: {text (what the edit keeps: a no-break space the browser typed for a space becomes a space,
 * inside the changed part only), newline (the changed part holds a line break: Enter or a multi-line paste)}.
 */
export function typedChange(before, after) {
  let p = 0;
  const max = Math.min(before.length, after.length);
  while (p < max && before.charCodeAt(p) === after.charCodeAt(p)) p++;
  let s = 0;
  while (s < max - p && before.charCodeAt(before.length - 1 - s) === after.charCodeAt(after.length - 1 - s)) s++;
  const mid = after.slice(p, after.length - s);
  return { text: after.slice(0, p) + mid.replace(/\u00a0/g, " ") + after.slice(after.length - s), newline: /[\n\r\u2028\u2029]/.test(mid), inserted: mid.length };
}

// ---- the identity of an editable text node (R9) -------------------------------------------------------------------------------------
// The server sends, with each version's view, six int32 per editable text node (src/html.js editIdentities): a 64-bit key of its
// neighbors (`nk`), a 64-bit key of its parent's unique id (`ik`, 0 0 when none), its number of twins (`tw`, text nodes with the same
// text) and how many of them are under that parent (`pw`, 0 when none). The page never computes them: it only compares them across versions.
const IDENT_INTS = 6;
const keyOf = (a, b) => (a === 0 && b === 0 ? null : `${a >>> 0}:${b >>> 0}`);
/**
 * The identities of one version: `of(nodeId)` -> {nk, ik, tw} or null (by bisection: the list is in source order), `byNk(nk)` and
 * `byIk(ik)` -> the node ids with that key, from tables built on first use (a Map entry per editable text node: a few hundred thousand
 * at the limits, built once when a version change re-places edits).
 */
export function identities(editable, ident) {
  let posOf = null;
  let nkMap = null;
  let ikMap = null;
  const ids = editable ? Array.from(editable) : [];
  const ok = !!ident && ident.length === IDENT_INTS * ids.length && ids.length > 0;
  const at = (k) => ({ nk: keyOf(ident[k * IDENT_INTS], ident[k * IDENT_INTS + 1]), ik: keyOf(ident[k * IDENT_INTS + 2], ident[k * IDENT_INTS + 3]), tw: ident[k * IDENT_INTS + 4], pw: ident[k * IDENT_INTS + 5] });
  let built = 0;
  const push = (m, key, id) => key && (m.get(key) || m.set(key, []).get(key)).push(id);
  /** Builds the lookup tables (needed when a version changes, not while typing). */
  const build = () => {
    if (!posOf) {
      posOf = new Map();
      nkMap = new Map();
      ikMap = new Map();
    }
    for (; built < ids.length; built++) {
      const r = at(built);
      posOf.set(ids[built], built);
      push(nkMap, r.nk, ids[built]);
      push(ikMap, r.ik, ids[built]);
    }
    return true;
  };
  // the server's list is in source order (ascending ids: src/html.js editableTextIds), so a node's place in it is found by bisection
  // without a table; one that is not would fall back to the table
  const sorted = ids.every((id, k) => k === 0 || ids[k - 1] < id);
  const find = (nodeId) => {
    if (!sorted) return (build(), posOf.get(nodeId));
    let lo = 0;
    let hi = ids.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (ids[m] < nodeId) lo = m + 1;
      else hi = m;
    }
    return ids[lo] === nodeId ? lo : undefined;
  };
  return {
    of(nodeId) {
      if (!ok) return null;
      const k = find(nodeId);
      return k === undefined ? null : at(k);
    },
    byNk: (nk) => (ok && nk ? (build(), nkMap.get(nk) || []) : []),
    byIk: (ik) => (ok && ik ? (build(), ikMap.get(ik) || []) : []),
  };
}

/**
 * The shape tokens of a key (shapeOf): "T" for a text slot, "<tag>" for an element, "#n" for another node.
 */
export const shapeTokens = (key) => key.match(/T|<[^>]*>|#\d+/g) || [];
/**
 * Typing emptied text (6b): the browser removes an emptied Text node, and puts a `<br>` in an element left with no text (Chromium,
 * measured). `before` and `after` are shape keys. Returns the indexes (among the slots of `before`) of the text slots that are gone when
 * that is ALL that differs, else null.
 */
export function emptiedSlots(before, after) {
  const a = shapeTokens(before);
  let b = shapeTokens(after);
  const brs = (l) => l.filter((t) => t === "<br>").length;
  for (let extra = brs(b) - brs(a); extra > 0; extra--) b = b.filter((t, i) => t !== "<br>" || i !== b.lastIndexOf("<br>"));
  const gone = [];
  let j = 0;
  let slot = 0;
  for (const t of a) {
    if (j < b.length && b[j] === t) j++;
    else if (t === "T") gone.push(slot);
    else return null;
    if (t === "T") slot++;
  }
  return j === b.length && gone.length ? gone : null;
}

// ---- pending edits (R9) -------------------------------------------------------------------------------------------------------------
/**
 * The person's text edits, held in the page until Send (or "Save my edits"): [{nodeId, versionSha, baseTextHash, newText, baseText,
 * ident}]. baseText and ident (the node's identity on the version the edit was placed on: identities above) stay in the page (to undo
 * and to re-place); the server gets the other four. Order: when each node was first edited.
 */
export function createEdits() {
  let list = [];
  let lost = [];
  const subs = new Set();
  const emit = () => subs.forEach((f) => {
    try {
      f(list.slice());
    } catch {
      /* one listener failing does not stop the rest */
    }
  });
  return {
    list: () => list.slice(),
    has: () => list.length > 0,
    get: (nodeId) => list.find((e) => e.nodeId === nodeId) || null,
    /** Adds or updates the edit of `nodeId`. The base is the version's text: kept from the first edit. Typing back to it removes the edit. */
    set({ nodeId, versionSha, baseText, newText, ident = null }) {
      const i = list.findIndex((e) => e.nodeId === nodeId);
      const base = i >= 0 ? list[i].baseText : baseText;
      if (newText === base) {
        if (i >= 0) (list = list.filter((_, k) => k !== i)), emit();
        return null;
      }
      const e = { nodeId, versionSha, baseTextHash: editHash(base), newText, baseText: base, ident: i >= 0 ? list[i].ident : ident };
      list = i >= 0 ? list.map((x, k) => (k === i ? e : x)) : [...list, e];
      emit();
      return e;
    },
    /** Undoes one edit (the node's, else the last one edited) and returns it, or null. */
    undo(nodeId) {
      const i = nodeId === undefined ? list.length - 1 : list.findIndex((e) => e.nodeId === nodeId);
      if (i < 0) return null;
      const e = list[i];
      list = list.filter((_, k) => k !== i);
      emit();
      return e;
    },
    undoAll() {
      const all = list;
      list = [];
      if (all.length) emit();
      return all;
    },
    /**
     * After the server took the edits (a Send or Save went through): forget them without touching the view. The edits that could not be
     * placed stay listed (their text is nowhere else) until dismissLost().
     */
    clear() {
      const had = list.length > 0;
      list = [];
      if (had) emit();
    },
    /**
     * After a version change, each edit goes to a node of the new version by its identity (made on the version it was placed on), never
     * by its numeric id (it means nothing in another version) and never by its text alone. THE RULE (outside review of 4d2b2fc): an edit
     * is placed only when exactly ONE text node of the new version has the edit's base text and either the same neighbors (`nk`) with that
     * text unique in the page, before and after (`tw` 1), or the same parent's unique id (`ik`) with that text unique under that parent,
     * before and after (`pw` 1). Content cannot tell twins apart (a twin moved or inserted next to the edited one reads the same), so an
     * id match never overrides a twin, and any ambiguity keeps the edit and lists it ("could not be placed", with its text and Copy).
     * Not placed means lost, never "already applied": "changed" (the parent is there, its text is not the base), "several" (the base
     * text is there, more than once or with twins), "gone". `applied` in the result stays, always empty, for the callers that read it.
     * A placed edit takes the identity of its new place. Lost edits are reported, never dropped silently: they stay in lost() until
     * dismissLost(). `now` = {ids: identities() of the new version, textOf(nodeId): its text in the new version or null}.
     */
    replace(versionSha, { ids, textOf }) {
      const placed = [];
      const applied = [];
      const nowLost = [];
      const place = (e, nodeId) => placed.push({ ...e, nodeId, versionSha, ident: ids.of(nodeId) });
      for (const e of list) {
        const id = e.ident;
        if (!id) {
          nowLost.push({ ...e, why: "gone" });
          continue;
        }
        const read = (nodeId) => ({ nodeId, text: textOf(nodeId), id: ids.of(nodeId) });
        const byParent = id.ik ? ids.byIk(id.ik).map(read).filter((c) => c.text !== null) : [];
        const near = ids.byNk(id.nk).map(read).filter((c) => c.text !== null);
        const base = (c) => editHash(c.text) === e.baseTextHash;
        const fits = new Set([...near.filter((c) => base(c) && id.tw === 1 && c.id?.tw === 1), ...byParent.filter((c) => base(c) && id.pw === 1 && c.id?.pw === 1)].map((c) => c.nodeId));
        if (fits.size === 1) {
          place(e, [...fits][0]);
          continue;
        }
        // No "already applied" shortcut (outside review of 9304853): a node nearby that holds the edit's new text may be another node that
        // always read so ("teh / teh / the", the first corrected), so an edit that is not placed is always listed, never dropped.
        if (fits.size > 1 || near.some(base) || byParent.some(base)) nowLost.push({ ...e, why: "several" });
        else nowLost.push({ ...e, why: byParent.length ? "changed" : "gone" });
      }
      list = placed;
      lost = [...lost, ...nowLost];
      emit();
      return { placed, applied, lost: nowLost };
    },
    lost: () => lost.slice(),
    /** The person has copied or let go of the edits that could not be placed: they leave the list (the pending ones stay). */
    dismissLost() {
      const had = lost.length > 0;
      lost = [];
      if (had) emit();
    },
    subscribe(f) {
      subs.add(f);
      return () => subs.delete(f);
    },
  };
}

// ---- elements hidden in the view (R15) ---------------------------------------------------------------------------------------------
/**
 * A hidden element as the view state keeps it: {nodeId, tag, hash (editHash of its text, first 200 characters)}. After a version change
 * each goes to the element with the same id when tag and hash still match, else to the one element with that tag and hash; none or
 * several: it is shown again. `find(tag, hash)` returns the new version's candidate ids, `at(nodeId)` {tag, hash} or null.
 */
export function replaceHidden(hidden, { at, find }) {
  const out = [];
  for (const h of hidden) {
    const now = at(h.nodeId);
    if (now && now.tag === h.tag && now.hash === h.hash) out.push(h);
    else {
      const c = find(h.tag, h.hash);
      if (c.length === 1) out.push({ ...h, nodeId: c[0] });
    }
  }
  return out;
}

// ---- the crash flag (R6) -----------------------------------------------------------------------------------------------------------
// Set for a file version right before the frame gets its content, cleared once it has loaded and painted. A flag found set when the view
// opens means the last attempt never got there (the tab hung or crashed): show the plain view. Kept in localStorage through the page's
// own guarded store (lib.js `store`), since a reopened tab starts with an empty sessionStorage. One key holds every version still flagged
// (normally none); ceiling: at most 20, the oldest dropped.
const CRASH_KEY = "onionskin.html.crash";
export function crashFlag(storage = pageStore) {
  const read = () => {
    try {
      const v = JSON.parse(storage.get("localStorage", CRASH_KEY) || "{}");
      return v && typeof v === "object" && !Array.isArray(v) ? v : {};
    } catch {
      return {};
    }
  };
  const write = (m) => {
    const keys = Object.keys(m).sort((a, b) => m[a] - m[b]).slice(-20);
    storage.set("localStorage", CRASH_KEY, JSON.stringify(Object.fromEntries(keys.map((k) => [k, m[k]]))));
  };
  return {
    isSet: (version) => Object.prototype.hasOwnProperty.call(read(), String(version)),
    set(version) {
      const m = read();
      m[String(version)] = Date.now();
      write(m);
    },
    clear(version) {
      const m = read();
      if (!Object.prototype.hasOwnProperty.call(m, String(version))) return;
      delete m[String(version)];
      write(m);
    },
  };
}

/** The first-run line (R18) is shown until the person dismisses it once. */
const SEEN_KEY = "onionskin.html.firstRunSeen";
export const firstRunSeen = (storage = pageStore) => storage.get("localStorage", SEEN_KEY) === "1";
export const markFirstRunSeen = (storage = pageStore) => storage.set("localStorage", SEEN_KEY, "1");

/** The notices a version shows, in order, from renderCopy's stats and the view's state. Each: {id, text}. */
export function noticesFor({ stats, plain, locked, firstRun, hiddenCount, mismatch }) {
  const out = [];
  const s = stats || {};
  if (firstRun) out.push({ id: "first-run", text: SAY.firstRun });
  if (plain) out.push({ id: "plain", text: plainSentence(plain) });
  if (mismatch) out.push({ id: "mismatch", text: SAY.mismatch });
  // `locked`: why the view is read only ("run", "tab", "sending"; true reads as "run"), one sentence for the strongest reason
  if (locked === true || locked === "run") out.push({ id: "running", text: SAY.running });
  else if (locked === "sending") out.push({ id: "sending", text: SAY.sending });
  else if (locked === "tab") out.push({ id: "other-tab", text: SAY.otherTab });
  if (s.scripts > 0) out.push({ id: "scripts", text: SAY.scripts });
  if (s.remote > 0) out.push({ id: "remote", text: SAY.remote(s.remote) });
  if (s.styles?.heavy) out.push({ id: "heavy", text: SAY.heavy });
  if (s.folder === "home_or_root") out.push({ id: "folder", text: SAY.folder });
  if (hiddenCount > 0) out.push({ id: "hidden", text: SAY.showHidden(hiddenCount) });
  return out;
}
