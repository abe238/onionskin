import { ACTIVE_REFUSED, HTML_NS, inventory } from "../html-active.js";
import { byPath, elementAddressable, elementPath, escapeAttr, escapeText, hasDuplicateAttributes, HtmlEncodingError, kids, ownHash, parseFragmentIn, pathString, proveEdits, RAWTEXT, RCDATA, readHtml, visibleText } from "../html.js";
import { assemble, checkedHtmlWrite, conflicts, editDelta, emptyEdit, textEdit } from "../html-write.js";
import { CapError } from "../xml.js";
import { excerpt, fail, normText, refused } from "./common.js";
import { countMatches, findRanges, overlapRefusal, pickMatches } from "./runs.js";

/**
 * HTML driver (PLAN-html 3.1, 3.5 as changed by R1, R7, R8, R10, R11, R12, R22). No engine: every op is a splice of the file's source
 * through src/html.js, never a serializer, so the bytes outside the edited places stay as they are. Elements are addressed by an anchor id
 * of the batch, or by the `path` or unique `element_id` the batch and the outline give; `expect.text_hash` is the hash of the element's
 * own text (its direct text, the batch's `locator.text_hash`), `expect.quote` must occur in its visible text.
 *
 * All ops bind against the file as delivered (one reading); each op's edit is built then, and checked at bind for active content it
 * would add (R1, which names the op). Execute accepts the edits in order and refuses one that changes a place an earlier op of the file
 * changes (`overlapping_edit`). finish() applies every accepted splice at once and proves the result in one parse (src/html.js
 * proveEdits: one parse with its proof took about 1.5 s of worker CPU at the limits, so one per op would not fit a batch of 50 in the
 * ops worker's time limit), then runs the write check (src/html-write.js checkedHtmlWrite: charset, the whole-file inventory). This
 * module never loads the parser: src/ops/run.js runs it in the ops worker (src/ops-worker.js) unless the parser is on this thread.
 */

const SPANS = "the text runs across the edge of an element (a link, bold text or similar), so it is in no single text of the page; use replace_element with the element's new markup";
const FROZEN = "script and style elements cannot be changed by an agent here (code that runs in a browser, and styles, stay as they are)";
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr", "param", "keygen", "image", "basefont", "bgsound", "frame"]);
const isText = (x) => x.nodeName === "#text";
const isEl = (x) => x.tagName !== undefined;
const frozen = (el) => (el.namespaceURI === HTML_NS ? RAWTEXT.has(el.tagName) : el.tagName === "script" || el.tagName === "style");

export async function open({ bytes, name, anchors = new Map() }) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const st = { bytes: b, name, anchors, read: null, error: null, inv: null, accepted: [] };
  try {
    st.read = readHtml(b);
    st.inv = inventory(st.read.doc);
  } catch (err) {
    if (err instanceof CapError) st.error = refused("too_large", String(err.message));
    else if (err instanceof HtmlEncodingError) st.error = refused("not_utf8", err.message);
    else throw err;
  }
  return st;
}

// ---- targets and expect --------------------------------------------------------------------------------------------------------
const SEG = /^([a-z0-9-]{1,32}|t-[0-9a-f]{12})\[([1-9][0-9]{0,6})\]$/;
/** "/html[1]/body[1]/p[3]" (pathString) -> ["html:0", "body:0", "p:2"], or null. */
function parsePath(p) {
  if (typeof p !== "string" || !p.startsWith("/") || p.length > 20000) return null;
  const out = [];
  for (const s of p.slice(1).split("/")) {
    const m = SEG.exec(s);
    if (!m) return null;
    out.push(`${m[1]}:${Number(m[2]) - 1}`);
  }
  return out.length ? out : null;
}

/** The element an op's target names, located in the source and not frozen; or a failure. */
function element(st, t) {
  let loc = t || {};
  let what = "";
  if ("anchor_id" in loc) {
    const a = st.anchors.get(loc.anchor_id);
    if (!a) return fail("anchor_not_found", `anchor ${loc.anchor_id} is not in the batch (pass --batch batch.json, or run inside the session that delivered it)`);
    if (!a.resolved || !a.locator || (!a.locator.path && !a.locator.element_id)) return fail("anchor_not_found", `anchor ${loc.anchor_id} was not resolved to an element of the page when the batch was built`);
    loc = { element_id: a.locator.element_id || undefined, path: a.locator.path || undefined };
    what = `anchor ${t.anchor_id}`;
  }
  let el = null;
  if (loc.element_id) el = st.read.byId.get(loc.element_id) || null;
  if (!el && loc.path) {
    const segs = parsePath(loc.path);
    if (!segs) return fail("anchor_not_found", "path is not an element path as the batch gives it (/html[1]/body[1]/p[3])");
    el = byPath(st.read, segs);
  }
  if (!el && !loc.element_id && !loc.path) return fail("anchor_not_found", "give anchor_id, path or element_id (from the batch)");
  if (!el) return fail("anchor_not_found", what ? `${what} no longer names an element of the page` : loc.element_id && !loc.path ? `no single element has the id ${JSON.stringify(String(loc.element_id).slice(0, 64))}` : "no element at that path");
  if (frozen(el)) return refused("active_content", FROZEN);
  if (!el.sourceCodeLocation?.startTag || el.__hidden) return refused("not_addressable", "this element is not written as such in the page's source (the parser implied it, or it is template content); target its nearest written ancestor");
  return { el };
}

/** `expect` against the element: text_hash equals its own text's hash, quote occurs in its visible text (never a script or style body: R7). */
function expectOn(st, el, expect) {
  const text = visibleText(st.read, el);
  if ("quote" in expect && !normText(text).includes(normText(expect.quote))) return fail("expect_mismatch", "the target no longer says what `expect.quote` says", { actual_excerpt: excerpt(text) });
  const h = ownHash(el);
  if ("text_hash" in expect && expect.text_hash !== h) return fail("expect_mismatch", "the target's text hash differs from `expect.text_hash`", { actual_excerpt: excerpt(text), actual_text_hash: h });
  return null;
}

// ---- finding text ------------------------------------------------------------------------------------------------------------------
/** The text nodes under `root` an op may search (not raw text, not template content), in document order. */
function textsUnder(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const x = stack.pop();
    if (isText(x)) {
      if (!x.__hidden && x.__ctx) out.push(x);
      continue;
    }
    if (isEl(x) && (frozen(x) || x.__hidden)) continue;
    const ks = kids(x);
    for (let i = ks.length - 1; i >= 0; i--) stack.push(ks[i]);
  }
  return out;
}
const foldFind = (f) => f.replace(/\s+/g, " ");
/**
 * A text with every whitespace run as one space (what the agent read: the outline folds whitespace as src/text.js normText does), and
 * where each of its offsets is in the text: `from` (start of that unit) and `to` (end). Null maps when nothing folds.
 */
function folded(v) {
  if (!/\s\s|[^\S ]/.test(v)) return { n: v, from: null, to: null };
  const from = new Int32Array(v.length + 1);
  const to = new Int32Array(v.length + 1);
  let n = "";
  let k = 0;
  for (const m of v.matchAll(/\s+|\S+/g)) {
    if (/^\s/.test(m[0])) {
      from[k] = m.index;
      to[k] = m.index + m[0].length;
      k++;
      n += " ";
    } else {
      for (let i = 0; i < m[0].length; i++) (from[k] = m.index + i), (to[k] = m.index + i + 1), k++;
      n += m[0];
    }
  }
  from[k] = v.length;
  return { n, from, to };
}
/** The matches of `find` in a text node's value (whitespace runs match any whitespace), as value ranges; and how many touch a letter. */
function matchesIn(v, find, matchCase) {
  const f = folded(v);
  const q = foldFind(find);
  const r = findRanges(f.n, q, matchCase);
  const ranges = f.from ? r.map(({ start, end }) => ({ start: f.from[start], end: end > start ? f.to[end - 1] : f.from[start] })) : r;
  return { ranges, partial: r.length ? countMatches(f.n, q, matchCase).partial : 0 };
}
/** How many times `find` occurs in the element's visible text (crossing element edges): more than in its text nodes means spans_markup. */
const visibleCount = (st, el, find, matchCase) => findRanges(visibleText(st.read, el), foldFind(find), matchCase).length;

// ---- binding ---------------------------------------------------------------------------------------------------------------------
/** One op's result of bind: the edit, checked for active content it adds (R1, by the fixed reason codes). */
function bound(st, op, edit, detail) {
  const d = editDelta(edit, st.inv.scripted);
  if (d.refused) return { ...refused("active_content", ACTIVE_REFUSED), reasons: d.reasons };
  return { ok: true, op, edit, ...(detail ? { detail } : {}) };
}

/** The edit of setting an element's whole text (set_text, replace_text with `text`). */
function wholeText(st, el, text) {
  const ks = kids(el);
  if (ks.length === 1 && isText(ks[0])) {
    const node = ks[0];
    if (node.__ok !== true) return refused("not_addressable", "this text cannot be edited by a splice at its exact place (whitespace only, or read differently from its source); use replace_element");
    const t = textEdit(st.read, [{ node, start: 0, end: node.value.length, repl: text }]);
    return t.ok ? { edit: t.edit } : refused(t.code === "not_addressable" ? "not_addressable" : "not_well_formed", t.why);
  }
  if (ks.length) return refused("spans_markup", "the element holds other elements or more than one text; use replace_text for a part of its text, or replace_element with its new markup");
  if (el.namespaceURI !== HTML_NS || VOID.has(el.tagName)) return refused("not_addressable", "this element holds no text");
  const edit = emptyEdit();
  if (text === "") return { edit };
  const at = el.sourceCodeLocation.startTag.endOffset;
  const esc = escapeText(text, RCDATA.has(el.tagName) ? "rcdata" : "normal", { atStartOfLeadingLf: ["pre", "listing", "textarea"].includes(el.tagName) });
  if (!esc.ok) return refused("not_well_formed", "the new text holds a NUL character or a lone surrogate");
  edit.splices.push({ s: at, e: at, repl: esc.out });
  edit.children.push({ parent: el, i: 0, j: 0, make: () => [{ nodeName: "#text", value: text }], removed: [] });
  edit.touched.push(el);
  return { edit };
}

/** A fragment for a place: parsed in its context, which must read back the same (R22). */
function fragment(ctx, markup) {
  if (/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(markup) || markup.includes("\u0000")) return refused("not_well_formed", "the markup holds a NUL character or a lone surrogate");
  const f = parseFragmentIn(ctx, markup);
  if (!f.roundTrips) return refused("not_well_formed", "the markup does not read back the same in that place (an unclosed, misplaced or misnested tag?)");
  return { nodes: f.nodes };
}

const quoteOf = (src) => {
  const eq = src.indexOf("=");
  if (eq < 0) return null;
  const c = src.slice(eq + 1).trimStart()[0];
  return c === '"' || c === "'" ? c : "";
};

export async function bind(st, op) {
  if (st.error) return { ...st.error };
  const tgt = (expectToo = true) => {
    const r = element(st, op.target);
    if (!r.el) return r;
    const bad = expectToo ? expectOn(st, r.el, op.expect || {}) : null;
    return bad || r;
  };
  switch (op.op) {
    case "replace_text": {
      const r = tgt();
      if (!r.el) return r;
      if ("text" in op) {
        const w = wholeText(st, r.el, String(op.text));
        return w.edit ? bound(st, op, w.edit) : w;
      }
      const mc = op.match_case !== false;
      const hits = [];
      const nodes = textsUnder(r.el);
      for (const node of nodes) for (const m of matchesIn(node.value, op.find, mc).ranges) hits.push({ node, ...m });
      // B1: the same rule as Word and PowerPoint, over the same folded text, node by node, that the matches above come from
      const overlap = overlapRefusal(hits.length === 1 ? nodes.map((node) => folded(node.value).n) : [], foldFind(op.find), mc, hits.length, op);
      if (overlap) return refused("overlapping_matches", overlap);
      // and over the element's whole text (its text nodes joined in order): a copy that runs across formatting ("ba<b>n</b>ana", the
      // first "ana") is not one of the matches above, and the one match found may not be the copy the comment points at. Ceiling: text
      // nodes of two blocks inside the element join with nothing between, which can only refuse more, never write elsewhere.
      if (hits.length === 1 && overlapRefusal([folded(nodes.map((node) => node.value).join("")).n], foldFind(op.find), mc, 1, op)) {
        return refused("overlapping_matches", 'a copy of these words runs across formatting (bold, a link or similar) in the target, so the change might land on a different copy than the comment points at; nothing was changed. Give a longer "find" that occurs only once');
      }
      const pick = pickMatches(hits.map((_, i) => i), op);
      if (pick.error) {
        const seen = visibleCount(st, r.el, op.find, mc);
        if (seen > hits.length && (!hits.length || (op.occurrence && op.occurrence > hits.length))) return refused("spans_markup", SPANS);
        return fail("anchor_not_found", pick.error);
      }
      const chosen = pick.starts.map((i) => hits[i]);
      if (chosen.some((h) => h.node.__ok !== true)) return refused("not_addressable", "the match is in text that cannot be edited by a splice at its exact place (text the parser moved, or whitespace only); use replace_element");
      const t = textEdit(st.read, chosen.map((h) => ({ node: h.node, start: h.start, end: h.end, repl: op.replace })));
      if (!t.ok) return refused(t.code === "not_addressable" ? "not_addressable" : "not_well_formed", t.why);
      return bound(st, op, t.edit, { replaced: chosen.length });
    }
    case "set_text": {
      const r = tgt();
      if (!r.el) return r;
      const w = wholeText(st, r.el, op.text);
      return w.edit ? bound(st, op, w.edit) : w;
    }
    case "set_attribute":
    case "remove_attribute": {
      const r = tgt();
      if (!r.el) return r;
      const el = r.el;
      if (el.namespaceURI !== HTML_NS) return refused("not_addressable", "attributes of SVG and MathML elements cannot be changed here");
      const name = op.name.toLowerCase();
      const st0 = el.sourceCodeLocation.startTag;
      const at = st0.attrs?.[name];
      const cur = el.attrs.find((a) => a.name === name && !a.namespace);
      const text = st.read.text;
      const edit = emptyEdit();
      edit.touched.push(el);
      if (op.op === "remove_attribute") {
        if (!cur) return fail("anchor_not_found", `the element has no ${JSON.stringify(name)} attribute`);
        // R22: removing the first of duplicate attributes would make the next one count
        if (!at || hasDuplicateAttributes(st.read, el.__id)) return refused("not_addressable", "this start tag holds an attribute more than once; removing one would make another count instead");
        let s = at.startOffset;
        while (s > 0 && /[\t\n\f\r ]/.test(text[s - 1])) s--;
        edit.splices.push({ s, e: at.endOffset, repl: "" });
        edit.attrs.push({ el, name, value: null });
        return bound(st, op, edit);
      }
      const value = String(op.value);
      if (cur) {
        if (!at) return refused("not_addressable", "this attribute has no place in the source");
        const src = text.slice(at.startOffset, at.endOffset);
        const q = quoteOf(src);
        const esc = escapeAttr(value, q === null ? '"' : q);
        if (!esc.ok) return refused("not_well_formed", "the value holds a NUL character or a lone surrogate");
        edit.splices.push({ s: at.startOffset, e: at.endOffset, repl: `${src.slice(0, name.length)}=${esc.out}` });
      } else {
        const esc = escapeAttr(value, '"');
        if (!esc.ok) return refused("not_well_formed", "the value holds a NUL character or a lone surrogate");
        let p = st0.startOffset + 1 + el.tagName.length;
        for (const a of Object.values(st0.attrs || {})) if (a.endOffset > p) p = a.endOffset;
        edit.splices.push({ s: p, e: p, repl: ` ${name}=${esc.out}` });
      }
      edit.attrs.push({ el, name, value });
      return bound(st, op, edit);
    }
    case "insert_html":
    case "replace_element":
    case "delete_element": {
      const r = tgt();
      if (!r.el) return r;
      const el = r.el;
      const loc = el.sourceCodeLocation;
      const outside = op.op !== "insert_html" || op.where === "before" || op.where === "after";
      const parent = outside ? el.__par : el;
      if (outside) {
        // R8, on demand: the element's source, parsed alone in its parent's context, is exactly it
        if (!el.__ctx || !isEl(parent) || !elementAddressable(st.read, el.__id)) return refused("not_addressable", "this element cannot be cut out of the source exactly (the parser builds it from more than its own tags); target an ancestor, or change its contents");
      } else if (el.namespaceURI !== HTML_NS || VOID.has(el.tagName) || RCDATA.has(el.tagName)) return refused("not_addressable", "this element cannot hold markup");
      const edit = emptyEdit();
      edit.touched.push(parent);
      if (op.op === "delete_element") {
        edit.splices.push({ s: loc.startOffset, e: loc.endOffset, repl: "" });
        edit.children.push({ parent, i: el.__idx, j: el.__idx + 1, make: () => [], removed: [el] });
        edit.removed.push(el);
        return bound(st, op, edit);
      }
      const f = fragment(outside ? el.__ctx : el, op.html);
      if (!f.nodes) return f;
      const make = () => f.nodes;
      if (op.op === "replace_element") {
        edit.splices.push({ s: loc.startOffset, e: loc.endOffset, repl: op.html });
        edit.children.push({ parent, i: el.__idx, j: el.__idx + 1, make, removed: [el] });
        edit.removed.push(el);
        return bound(st, op, edit);
      }
      let at;
      let i;
      if (op.where === "before") [at, i] = [loc.startOffset, el.__idx];
      else if (op.where === "after") [at, i] = [loc.endOffset, el.__idx + 1];
      else if (op.where === "first_child") [at, i] = [loc.startTag.endOffset, 0];
      else {
        if (!loc.endTag) return refused("not_addressable", "this element has no end tag in the source, so there is no exact place after its last child; use replace_element");
        [at, i] = [loc.endTag.startOffset, kids(el).length];
      }
      edit.splices.push({ s: at, e: at, repl: op.html });
      edit.children.push({ parent, i, j: i, make, removed: [] });
      return bound(st, op, edit);
    }
    case "replace_all_text": {
      const mc = op.match_case !== false;
      const hits = [];
      for (const node of textsUnder(st.read.doc)) {
        const m = matchesIn(node.value, op.find, mc);
        if (m.ranges.length) hits.push({ node, ranges: m.ranges, partial: m.partial, ro: node.__ok !== true });
      }
      const total = hits.reduce((n, h) => n + h.ranges.length, 0);
      const extra = { partial_words: hits.reduce((n, h) => n + h.partial, 0), protected: hits.reduce((n, h) => n + (h.ro ? h.ranges.length : 0), 0) };
      if (total !== op.expect.count) {
        const across = findRanges(st.read.flat, foldFind(op.find), mc).length - total;
        return fail("expect_mismatch", `found ${total} occurrence(s), expected ${op.expect.count}`, { found: total, ...extra, ...(across > 0 ? { spans_markup: across } : {}) });
      }
      // each text node's matches become splices; a node that cannot take them (read differently, or cut inside a character reference) is skipped and listed
      const skipped = [];
      const parts = [];
      for (const h of hits) {
        const t = h.ro ? null : textEdit(st.read, h.ranges.map((g) => ({ node: h.node, ...g, repl: op.replace })));
        if (t?.ok) parts.push(t.edit);
        else if (t && t.code !== "not_addressable") return refused("not_well_formed", t.why);
        else skipped.push({ path: pathString(elementPath(h.node.__par)), excerpt: excerpt(h.node.value), matches: h.ranges.length });
      }
      const edit = emptyEdit();
      for (const p of parts) for (const k of Object.keys(edit)) edit[k].push(...p[k]);
      const replaced = total - skipped.reduce((n, s) => n + s.matches, 0);
      return bound(st, op, edit, { replaced, ...(skipped.length ? { skipped_protected: skipped.slice(0, 50) } : {}) });
    }
    default:
      return refused("unsupported_op", `${op.op} does not apply to an .html file`);
  }
}

/** Accept the op's edit unless it changes a place an earlier op of this file changes. */
export async function exec(st, b) {
  if (st.accepted.some((a) => a.edit.splices.length) && conflicts(st.accepted.map((a) => a.edit), b.edit)) return refused("overlapping_edit", "an earlier op of this file changes the same place (the same text, attribute or element, or one inside it); give one op per place, or one replace_element");
  if (b.op.op === "replace_all_text" && b.detail.replaced === 0 && b.detail.skipped_protected) return { status: "skipped_protected", reason: "every text with a match cannot be edited at its exact place", detail: b.detail };
  st.accepted.push({ edit: b.edit });
  return { status: "applied", ...(b.detail ? { detail: b.detail } : {}) };
}

const ATOMIC = "atomic mode: another op did not apply, so nothing was written";
const notApplied = (r, reason) => ({ index: r.index, op: r.op, ...(r.id ? { id: r.id } : {}), status: "not_applied", reason, ...(r.detail ? { would_have: r.detail } : {}) });
const refusedAs = (r, code, reason, extra = {}) => ({ index: r.index, op: r.op, ...(r.id ? { id: r.id } : {}), status: "refused", code, reason, ...extra });

/**
 * The end of a run (src/ops/run.js calls it instead of save and the package checks): every accepted splice at once, one proof, then the
 * write check. A proof that fails is traced to the ops that fail it alone (a parse each, only then): those are refused `proof_failed`;
 * in --partial mode the rest is tried again without them, in atomic mode nothing is written. A refused write check (active content,
 * charset) refuses every op that would have been written, with its code. Returns runOps' answer {results, bytes, warnings, blocked}.
 */
export async function finish(st, results, { partial = false } = {}) {
  let live = [];
  let k = 0;
  results.forEach((r, i) => r.status === "applied" && live.push({ ri: i, edit: st.accepted[k++].edit }));
  const done = (bytes, extra = {}) => ({ results, bytes, warnings: [], blocked: null, ...extra });
  for (;;) {
    if (!live.some((x) => x.edit.splices.length)) return done(null);
    const { bytes, plan } = assemble(st.read, live.map((x) => x.edit));
    const p = proveEdits(st.read, bytes, plan);
    if (!p.ok) {
      const alone = (x) => {
        const a = assemble(st.read, [x.edit]);
        return proveEdits(st.read, a.bytes, a.plan).ok;
      };
      let bad = live.length > 1 ? live.filter((x) => x.edit.splices.length && !alone(x)) : live;
      if (!bad.length) bad = live; // each alone proves, together they do not
      const why = p.code === "limits" ? `the result would be past a limit: ${p.why}` : "the change would also change the page somewhere else (the parser would read the new source differently), so nothing was written";
      for (const x of bad) results[x.ri] = refusedAs(results[x.ri], p.code === "limits" ? "too_large" : "proof_failed", why);
      live = live.filter((x) => !bad.includes(x));
      if (!partial) {
        for (const x of live) results[x.ri] = notApplied(results[x.ri], ATOMIC);
        return done(null);
      }
      continue;
    }
    const c = checkedHtmlWrite(st.bytes, p.parsed.bytes, { read: st.read, parsed: p.parsed, beforeInv: st.inv });
    if (!c.ok) {
      for (const x of live) results[x.ri] = refusedAs(results[x.ri], c.code, c.reason, c.reasons ? { reasons: c.reasons } : {});
      return done(null);
    }
    return done(c.bytes, { html: { charset_added: c.charset_added, links: c.links } });
  }
}

export const close = () => {};
