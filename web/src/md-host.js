// A Markdown file in the page (slice 1: preview, select, comment): the host App.jsx talks to, as it talks to the engine's (selection,
// rectsFor, hitTest, scrollTo, view state). The preview (MarkdownHost.jsx) renders every run of src/markdown.js as one text node in a
// span[data-r] whose text is exactly the run's displayed string, so an offset in that text node is an offset in run.display, and
// src/markdown.js sourceRange turns a selection into the exact source range it stands for. Nothing here searches the source for words:
// a selection that does not map to one range is refused or offered as its whole block, with a plain sentence.
import { sourceRange } from "../../src/markdown.js";

/** What the page says when a selection cannot be sent as it is (MarkdownHost.jsx shows it; `block` adds the explicit whole-block button). */
export const MD_REFUSED_BLOCKS = "A comment can point at words inside one block only. Select within one paragraph, heading, list item, table cell or code block.";
export const MD_OFFER_BLOCK = "These words do not map to one exact place in the file: they cross formatting the preview hides. You can comment on the whole block instead.";

/** The run id and display offset of a DOM boundary (node, offset) inside the preview `root`, or null. Element boundaries snap to the nearest run edge. */
export function runPoint(root, node, offset, runEls, { end = false } = {}) {
  if (!node || !root.contains(node)) return null;
  const span = (node.nodeType === 3 ? node.parentElement : node)?.closest?.("[data-r]");
  if (node.nodeType === 3 && span && root.contains(span)) return { run: Number(span.dataset.r), offset };
  // an element boundary (a triple click ends at the start of the next block): the first run at or after it, or the last run before it.
  // Ceiling: a linear scan over the runs, only for such boundaries (never for a text-node selection); fine for MD_LIMITS files.
  const probe = document.createRange();
  probe.setStart(node, offset);
  let before = null;
  for (const el of runEls) {
    if (!el) continue;
    const after = probe.comparePoint(el, 0) >= 0; // the run starts at or after the boundary
    if (after) return end && before ? { run: Number(before.dataset.r), offset: before.textContent.length } : { run: Number(el.dataset.r), offset: 0 };
    before = el;
  }
  return before ? { run: Number(before.dataset.r), offset: before.textContent.length } : null;
}

/** The leaf block (a [data-b] element of this preview) that holds DOM node `node`, or null when the node is not inside one. */
export function caretBlock(root, tree, node) {
  const el = (node?.nodeType === 3 ? node.parentElement : node)?.closest?.("[data-b]");
  if (!el || !root.contains(el)) return null;
  return tree.byId[Number(el.dataset.b)] || null;
}

/** The display text of runs s..e (offsets inside the first and the last), as the person sees it. */
function shownBetween(tree, s, so, e, eo) {
  if (s > e || (s === e && so > eo)) [s, so, e, eo] = [e, eo, s, so];
  let out = "";
  for (let k = s; k <= e; k++) {
    const d = tree.runs[k].display;
    out += d.slice(k === s ? so : 0, k === e ? eo : d.length);
  }
  return out;
}
/** Up to `n` characters of the block's display text before or after run k at offset o. */
function around(tree, k, o, n, before) {
  const b = tree.runs[k].block;
  let out = "";
  if (before) {
    out = tree.runs[k].display.slice(0, o);
    for (let j = k - 1; j >= 0 && tree.runs[j].block === b && out.length < n; j--) out = tree.runs[j].display + out;
    return out.slice(-n);
  }
  out = tree.runs[k].display.slice(o);
  for (let j = k + 1; j < tree.runs.length && tree.runs[j].block === b && out.length < n; j++) out += tree.runs[j].display;
  return out.slice(0, n);
}
const blockShown = (tree, id) => tree.runs.filter((r) => r.block === id).map((r) => r.display).join("");

/**
 * The page's selection in the preview as the host reports it, or null when it is not in the preview:
 *   {kind: "text", collapsed: false, location: {from, to, version}, quote, prefix, suffix, format}   one exact range (sourceRange)
 *   {kind: "text", collapsed: true, location: {from, to, version} of the block, quote, format}       a caret: its block
 *   {kind: "refused", reason, block?: {from, to}}                                                   no exact range: the sentence to show
 */
export function selectionOf(root, tree, version, runEls, sel = window.getSelection()) {
  if (!sel || !sel.rangeCount || !root) return null;
  const r = sel.getRangeAt(0);
  if (!root.contains(r.startContainer) || !root.contains(r.endContainer)) return null;
  if (r.collapsed) {
    // a caret is its block: the [data-b] element that holds the caret's own node, never the run nearest to it (a caret at the end of
    // one paragraph element would snap to the first run of the next). A caret between blocks names no block: nothing.
    const b = caretBlock(root, tree, r.startContainer);
    return b ? { kind: "text", collapsed: true, location: { from: b.from, to: b.to, version }, quote: blockShown(tree, b.id), source: tree.text.slice(b.from, b.to), prefix: "", suffix: "", format: "markdown" } : null;
  }
  const a = runPoint(root, r.startContainer, r.startOffset, runEls);
  const z = r.collapsed ? a : runPoint(root, r.endContainer, r.endOffset, runEls, { end: true });
  if (!a || !z) return null;
  const loc = (from, to) => ({ from, to, version });
  const m = sourceRange(tree, { startRun: a.run, startOffset: a.offset, endRun: z.run, endOffset: z.offset });
  if (m.refused) return /nothing is selected/.test(m.reason) ? null : { kind: "refused", reason: MD_REFUSED_BLOCKS };
  if (m.block) return { kind: "refused", reason: MD_OFFER_BLOCK, block: { from: m.block.from, to: m.block.to, quote: blockShown(tree, m.block.id), source: m.block.source } };
  const [s, so, e, eo] = a.run < z.run || (a.run === z.run && a.offset <= z.offset) ? [a.run, a.offset, z.run, z.offset] : [z.run, z.offset, a.run, a.offset];
  // `source`: the exact source of the range, captured with it (the server gives a place only where the text is still exactly this)
  return { kind: "text", collapsed: false, location: loc(m.from, m.to), quote: shownBetween(tree, s, so, e, eo), source: m.quote, prefix: around(tree, s, so, 40, true), suffix: around(tree, e, eo, 40, false), format: "markdown" };
}

/** Runs overlapping [from, to) (binary search on their sorted, non-overlapping ranges). */
function runsIn(tree, from, to) {
  const R = tree.runs;
  let lo = 0;
  let hi = R.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (R[mid].to <= from) lo = mid + 1;
    else hi = mid;
  }
  const out = [];
  for (let k = lo; k < R.length && R[k].from < to; k++) out.push(R[k]);
  return out;
}

/**
 * The client rectangles of a location in this version: an exact range draws over the part of each run it covers (a run that stands for
 * several source characters is drawn whole). A location of another version has none (its offsets mean nothing here). Ceiling: at most
 * RECT_RUNS runs are measured (a whole-block comment on a huge table); the rest of such a block is not outlined.
 */
const RECT_RUNS = 2000;
export function rectsOf(tree, version, runEls, loc) {
  if (!loc || !Number.isInteger(loc.from) || !Number.isInteger(loc.to) || (loc.version && loc.version !== version)) return [];
  const out = [];
  const range = document.createRange();
  for (const r of runsIn(tree, loc.from, loc.to).slice(0, RECT_RUNS)) {
    const el = runEls[r.id];
    const t = el?.firstChild;
    if (!t || t.nodeType !== 3) continue;
    const verbatim = r.kind === "text" || r.kind === "code" || r.kind === "literal";
    const a = verbatim ? Math.max(0, loc.from - r.from) : 0;
    const b = verbatim ? Math.min(t.length, loc.to - r.from) : t.length;
    if (b <= a) continue;
    range.setStart(t, a);
    range.setEnd(t, b);
    for (const rc of range.getClientRects()) if (rc.width > 0 && rc.height > 0) out.push(rc);
  }
  return out;
}

/** What a click in Comment or Pin mode lands on: its whole block, as an element anchor. */
export function hitOf(root, tree, version, x, y) {
  const pos = document.caretPositionFromPoint ? document.caretPositionFromPoint(x, y) : null;
  const node = pos ? pos.offsetNode : document.caretRangeFromPoint?.(x, y)?.startContainer;
  const el = (node?.nodeType === 3 ? node.parentElement : node)?.closest?.("[data-b]");
  if (!el || !root.contains(el)) return null;
  const b = tree.byId[Number(el.dataset.b)];
  if (!b) return null;
  return { kind: "block", location: { from: b.from, to: b.to, version }, quote: blockShown(tree, b.id), source: tree.text.slice(b.from, b.to), rect: el.getBoundingClientRect(), format: "markdown" };
}
