import { editHash } from "./edit-hash.js";
import { ACTIVE_REFUSED, HTML_NS, inventory, inventoryDelta } from "./html-active.js";
import { decodeHtml, escapeText, kids, leadingLfParent, parseChecked, parseFragmentIn, proveEdits, proveSplice, readHtml, textContext, textRange } from "./html.js";

// Every write of an HTML file (PLAN-html R1, R10, R12, R22): the edit model the agent's ops and the person's text edits share (source
// splices plus what the parsed tree must then hold), and checkedHtmlWrite, the one check every path that changes an HTML file runs in a
// worker before anything is written: decoding, the limits, the lockstep proof for edits, the charset declaration on the first non-ASCII
// write, and the whole-file inventory of active content. The parser is not imported here (src/html-parser.js is, by the worker entries).

const isText = (x) => x.nodeName === "#text";
const isEl = (x) => x.tagName !== undefined;

// ---- the edit model ------------------------------------------------------------------------------------------------------------------
/**
 * An edit: what one op (or one of the person's text edits) changes, as found on the reading it was bound to.
 *   splices:  [{s, e, repl}]  source ranges of the decoded text (UTF-16 offsets) and their new source text
 *   texts:    [{node, start, end, repl}]  ranges of a text node's VALUE and the value that replaces them
 *   attrs:    [{el, name, value}]  an attribute set (value a string) or removed (value null)
 *   children: [{parent, i, j, make, removed}]  children [i, j) of `parent` replaced by make()'s nodes
 *   touched:  nodes this edit reads or changes; removed: subtrees it takes out (two edits conflict when one touches what the other removes)
 */
export const emptyEdit = () => ({ splices: [], texts: [], attrs: [], children: [], touched: [], removed: [] });

/**
 * Where each offset of a text node's value is in the source: an Int32Array of value.length + 1 entries, -1 where an offset falls inside
 * one character reference (`&fjlig;` is two characters of value) or a CRLF the parser read as one LF. The source of the node is cut at each
 * `&`; a piece without one is literal text (CR and CRLF read as LF), and a piece that starts with one is parsed alone in the node's
 * context, which gives the reference's value; the literal text after the reference is what the rest of the piece reads as. Null when
 * the pieces do not add up to the value (NUL characters the parser drops, or anything else this cannot place exactly).
 */
export function sourceMap(read, node) {
  const [s, e] = textRange(node, read.text);
  const src = read.text.slice(s, e);
  const V = node.value;
  const at = new Int32Array(V.length + 1).fill(-1);
  let v = 0;
  const literal = (from, to) => {
    for (let k = from; k < to; ) {
      at[v] = s + k;
      if (src[k] === "\r") {
        if (V[v] !== "\n") return false;
        k += src[k + 1] === "\n" ? 2 : 1;
      } else {
        if (V[v] !== src[k]) return false;
        k++;
      }
      v++;
    }
    return true;
  };
  const cr = (t) => t.replace(/\r\n?/g, "\n");
  let k = src.indexOf("&");
  if (!literal(0, k < 0 ? src.length : k)) return null;
  while (k >= 0) {
    const next = src.indexOf("&", k + 1);
    const piece = src.slice(k, next < 0 ? src.length : next);
    const nodes = parseFragmentIn(node.__ctx, piece).nodes;
    if (nodes.length > 1 || (nodes.length === 1 && !isText(nodes[0]))) return null;
    const d = nodes.length ? nodes[0].value : "";
    // the reference is the shortest head of the piece after which the rest reads as itself. Only a few heads are tried, so a long piece
    // costs linear time: a named reference is at most 33 characters (&CounterClockwiseContourIntegral;); a numeric one is &# (x), its
    // digits (any number of leading zeros) and an optional semicolon.
    const num = /^&#[xX]?/.exec(piece);
    const heads = [];
    if (num) {
      let q = num[0].length;
      const hex = num[0].length === 3;
      while (q < piece.length && (hex ? /[0-9a-fA-F]/ : /[0-9]/).test(piece[q])) q++;
      if (q > num[0].length) heads.push(q, ...(piece[q] === ";" ? [q + 1] : []));
      heads.unshift(1);
    } else for (let L = 1; L <= Math.min(piece.length, 40); L++) heads.push(L);
    let len = -1;
    for (const L of heads) {
      const tail = cr(piece.slice(L));
      if (d.length > tail.length && d.endsWith(tail)) {
        len = L;
        break;
      }
    }
    if (len < 0) return null;
    const ref = d.slice(0, d.length - cr(piece.slice(len)).length);
    if (V.slice(v, v + ref.length) !== ref) return null;
    at[v] = s + k;
    v += ref.length;
    if (!literal(k + len, k + piece.length)) return null;
    k = next;
  }
  if (v !== V.length) return null;
  at[V.length] = e;
  // an offset between the two halves of a surrogate pair is no place to cut
  for (let i = 1; i < V.length; i++) if (/[\udc00-\udfff]/.test(V[i]) && /[\ud800-\udbff]/.test(V[i - 1])) at[i] = -1;
  return at;
}

/**
 * The edit of replacing value ranges of text nodes (`items`: [{node, start, end, repl}], value offsets). Each range becomes a splice of
 * exactly its own source, escaped for its context (src/html.js escapeText), so character references and line endings elsewhere in the
 * node stay as they are. Returns {ok: true, edit} or {ok: false, node, code: "not_addressable" | "nul" | "lone_surrogate", why}.
 */
export function textEdit(read, items) {
  const edit = emptyEdit();
  const maps = new Map();
  for (const it of items) {
    const { node } = it;
    if (!maps.has(node)) maps.set(node, sourceMap(read, node));
    const map = maps.get(node);
    const s = map?.[it.start] ?? -1;
    const e = map?.[it.end] ?? -1;
    if (!map || s < 0 || e < 0) return { ok: false, node, code: "not_addressable", why: "the text there is written with a character reference or line ending that the change would cut in half" };
    const pst = node.__ctx?.sourceCodeLocation?.startTag;
    const esc = escapeText(it.repl, textContext(node), { atStartOfLeadingLf: leadingLfParent(node) && !!pst && s === pst.endOffset });
    if (!esc.ok) return { ok: false, node, code: esc.code, why: esc.code === "nul" ? "the new text holds a NUL character" : "the new text holds a lone surrogate" };
    edit.splices.push({ s, e, repl: esc.out });
    edit.texts.push({ node, start: it.start, end: it.end, repl: it.repl });
    if (!edit.touched.includes(node)) edit.touched.push(node);
  }
  return { ok: true, edit };
}

const cmpSplice = (a, b) => a.s - b.s || (a.e === a.s ? 0 : 1) - (b.e === b.s ? 0 : 1) || a.e - b.e || a.k - b.k;
/** Do two splices share a place? Two insertions at one point do not (op order decides); an insertion inside a range does. */
function clash(x, y) {
  const ex = x.s === x.e;
  const ey = y.s === y.e;
  if (ex && ey) return false;
  if (ex) return y.s < x.s && x.s < y.e;
  if (ey) return x.s < y.s && y.s < x.e;
  return Math.max(x.s, y.s) < Math.min(x.e, y.e);
}
const inside = (n, set) => {
  for (let z = n; z; z = z.__par) if (set.has(z)) return true;
  return false;
};
/**
 * Does `edit` change a place one of `accepted` (edits of earlier ops of the same file) changes? Sources overlap, the same attribute of one
 * element, or one touches what the other removes. Sorted sweep over the splices: one pair of neighbors per splice, so a document-wide
 * replace of many matches against another costs n log n, not n times m.
 */
export function conflicts(accepted, edit) {
  if (!accepted.length) return false;
  const all = [];
  accepted.forEach((a) => a.splices.forEach((sp) => all.push({ ...sp, set: 0 })));
  edit.splices.forEach((sp) => all.push({ ...sp, set: 1 }));
  all.sort((a, b) => a.s - b.s || (a.e === a.s ? 0 : 1) - (b.e === b.s ? 0 : 1) || a.e - b.e);
  const last = [null, null];
  for (const x of all) {
    const o = last[1 - x.set];
    if (o && clash(x, o)) return true;
    // the other set's splice that can still reach past x: the latest start, which (they never overlap each other) ends last
    last[x.set] = x;
  }
  for (const a of accepted) for (const x of a.attrs) for (const y of edit.attrs) if (x.el === y.el && x.name === y.name) return true;
  const gone = new Set(accepted.flatMap((a) => a.removed));
  if (gone.size && edit.touched.concat(edit.removed).some((t) => inside(t, gone))) return true;
  const mine = new Set(edit.removed);
  if (mine.size && accepted.some((a) => a.touched.concat(a.removed).some((t) => inside(t, mine)))) return true;
  return false;
}

/**
 * The bytes and the proof plan of `edits` (in op order) on `read`: every splice applied to the source at once (an insertion before a range
 * that starts at the same point, insertions at one point in op order), and for proveEdits the new value of every edited text node, the new
 * attribute list of every edited element and the child replacements of every edited parent. The edits must not conflict.
 */
export function assemble(read, edits) {
  const all = [];
  edits.forEach((ed, k) => ed.splices.forEach((sp) => all.push({ ...sp, k })));
  all.sort(cmpSplice);
  let out = "";
  let at = 0;
  for (const sp of all) {
    out += read.text.slice(at, sp.s) + sp.repl;
    at = Math.max(at, sp.e);
  }
  out += read.text.slice(at);
  const bytes = Buffer.concat([read.bytes.subarray(0, read.bomLen), Buffer.from(out, "utf8")]);
  const texts = new Map();
  const ranges = new Map();
  edits.forEach((ed) => ed.texts.forEach((t) => (ranges.get(t.node) || ranges.set(t.node, []).get(t.node)).push(t)));
  for (const [node, rs] of ranges) {
    rs.sort((a, b) => a.start - b.start);
    let v = "";
    let p = 0;
    for (const r of rs) {
      v += node.value.slice(p, r.start) + r.repl;
      p = r.end;
    }
    texts.set(node, v + node.value.slice(p));
  }
  const attrs = new Map();
  edits.forEach((ed) =>
    ed.attrs.forEach(({ el, name, value }) => {
      const list = attrs.get(el) || el.attrs.map((a) => ({ ...a }));
      const i = list.findIndex((a) => a.name === name && !a.namespace);
      if (value === null) {
        if (i >= 0) list.splice(i, 1);
      } else if (i >= 0) list[i] = { ...list[i], value };
      else list.push({ name, value });
      attrs.set(el, list);
    }),
  );
  const children = new Map();
  edits.forEach((ed, k) => ed.children.forEach((c) => (children.get(c.parent) || children.set(c.parent, []).get(c.parent)).push({ ...c, k })));
  for (const list of children.values()) list.sort((a, b) => a.i - b.i || (a.i === a.j ? 0 : 1) - (b.i === b.j ? 0 : 1) || a.k - b.k);
  return { bytes, plan: { texts, attrs, children } };
}

// ---- active content of one edit (to name the op that adds it) ---------------------------------------------------------------------
const cloneOf = (el, attrs, texts) => {
  const c = { nodeName: el.nodeName, tagName: el.tagName, namespaceURI: el.namespaceURI, attrs, childNodes: [] };
  c.childNodes = texts.map((value) => ({ nodeName: "#text", value, parentNode: c }));
  return c;
};
const textsOf = (list) => list.filter(isText).map((x) => x.value);
/**
 * inventoryDelta of what one edit takes out against what it puts in (R1), without a parse: the subtrees it removes against the nodes it
 * makes, and each element it changes (attributes, or its own text, which is a disallowed element's body) before and after. Inventories
 * are counted multisets, so for edits that do not conflict this names exactly the entries the whole-file inventory finds added.
 * `scripted`: whether the file loads a script (the template rule).
 */
export function editDelta(edit, scripted) {
  const before = [];
  const after = [];
  const byParent = new Map();
  for (const t of edit.texts) (byParent.get(t.node.__par) || byParent.set(t.node.__par, []).get(t.node.__par)).push(t);
  for (const [p, ts] of byParent) {
    if (!p || !isEl(p)) continue;
    const vals = kids(p).filter(isText);
    const now = vals.map((x) => {
      const mine = ts.filter((t) => t.node === x).sort((a, b) => a.start - b.start);
      let v = "";
      let q = 0;
      for (const r of mine) (v += x.value.slice(q, r.start) + r.repl), (q = r.end);
      return v + x.value.slice(q);
    });
    before.push(cloneOf(p, p.attrs, vals.map((x) => x.value)));
    after.push(cloneOf(p, p.attrs, now));
  }
  const els = new Map();
  for (const a of edit.attrs) (els.get(a.el) || els.set(a.el, []).get(a.el)).push(a);
  for (const [el, list] of els) {
    let attrs = el.attrs.map((a) => ({ ...a }));
    for (const { name, value } of list) {
      const i = attrs.findIndex((a) => a.name === name && !a.namespace);
      if (value === null) attrs = attrs.filter((_, k) => k !== i);
      else if (i >= 0) attrs[i] = { ...attrs[i], value };
      else attrs.push({ name, value });
    }
    before.push(cloneOf(el, el.attrs, []));
    after.push(cloneOf(el, attrs, []));
  }
  for (const c of edit.children) {
    const made = c.make();
    before.push(...c.removed);
    after.push(...made);
    if (isEl(c.parent)) {
      const old = kids(c.parent);
      before.push(cloneOf(c.parent, c.parent.attrs, textsOf(old)));
      after.push(cloneOf(c.parent, c.parent.attrs, textsOf([...old.slice(0, c.i), ...made, ...old.slice(c.j)])));
    }
  }
  const inv = (nodes) => inventory({ nodeName: "#document-fragment", childNodes: nodes });
  const a = inv(before);
  const b = inv(after);
  a.scripted = b.scripted = scripted || b.scripted;
  return inventoryDelta(a, b);
}

// ---- the charset declaration (R10) -----------------------------------------------------------------------------------------------
export const CHARSET_META = '<meta charset="utf-8">';
const META_NODE = { nodeName: "meta", tagName: "meta", namespaceURI: HTML_NS, attrs: [{ name: "charset", value: "utf-8" }], childNodes: [] };
/** Said to the agent when a first non-ASCII write cannot also declare UTF-8 (code charset_needs_head). */
export const CHARSET_NEEDS_HEAD =
  "This page does not say it is saved as UTF-8, and Onionskin found no place near its top to say so, so text with characters outside plain ASCII was not written. Write those characters as character references (for example &eacute; for é), or first add a <head> element at the top of the page.";
const hasHigh = (b, from = 0) => {
  for (let i = from; i < b.length; i++) if (b[i] >= 0x80) return true;
  return false;
};

/**
 * R10: the first write that adds a non-ASCII character to a file that declares no charset (no BOM, no meta charset in its first 1,024
 * bytes, and no non-ASCII byte before) also inserts <meta charset="utf-8"> as the first child of head, at the first place where that
 * insertion proves (only that element added, nothing else moved) and ends within the first 1,024 bytes (where a browser looks): right
 * after the head start tag, else after the html start tag, else after the doctype, else at the very start. No such place: refused.
 * `after` is a parsed version ({bytes, text, bomLen, declared, doc, limits}). Returns {ok: true, bytes, doc, added} or a refusal.
 */
export function withCharset(beforeInfo, after) {
  const need = !beforeInfo.declared && beforeInfo.ascii && !after.bomLen && !after.declared && hasHigh(after.bytes);
  if (!need) return { ok: true, bytes: after.bytes, doc: after.doc, added: false };
  const root = after.doc.childNodes.find((x) => isEl(x) && x.tagName === "html");
  const head = root && kids(root).find((x) => isEl(x) && x.tagName === "head" && x.namespaceURI === HTML_NS);
  const doctype = after.doc.childNodes.find((x) => x.nodeName === "#documentType");
  if (head) {
    const path = [after.doc.childNodes.indexOf(root), kids(root).indexOf(head)];
    const at = [head.sourceCodeLocation?.startTag?.endOffset, root.sourceCodeLocation?.startTag?.endOffset, doctype?.sourceCodeLocation?.endOffset, 0];
    for (const off of [...new Set(at.filter(Number.isInteger))]) {
      const text = after.text.slice(0, off) + CHARSET_META + after.text.slice(off);
      if (Buffer.byteLength(text.slice(0, off + CHARSET_META.length), "utf8") > 1024) continue;
      const bytes = Buffer.from(text, "utf8");
      const p = proveSplice({ doc: after.doc, bomLen: 0, limits: after.limits }, bytes, { parentPath: path, i: 0, j: 0, make: () => [META_NODE] });
      if (p.ok) return { ok: true, bytes, doc: p.parsed.doc, added: true };
    }
  }
  return { ok: false, code: "charset_needs_head", reason: CHARSET_NEEDS_HEAD };
}

// ---- the check every write runs --------------------------------------------------------------------------------------------------
const refusal = (code, reason, extra = {}) => ({ ok: false, code, reason, ...extra });
const unreadable = (p) => (p.code === "limits" ? refusal("too_large", p.why) : refusal("not_utf8", p.why));

/**
 * The check of one write of an HTML file, run in a worker (src/html-write-worker.js; the driver runs it in the ops worker). The whole write
 * is accepted or refused; nothing is written on a refusal. Inputs: the file's bytes now (`beforeBytes`) and the bytes to write
 * (`afterBytes`), and in `opts` at most one of:
 *   plan:   an edit plan (src/html-write.js assemble) on `opts.read`: the lockstep proof that only those places changed (src/html.js
 *           proveEdits); an op write
 *   parsed: `afterBytes` already proven and parsed by the caller (the driver), not parsed again
 *   edits:  the person's own text edits, [{nodeId, text, baseTextHash?}] on a reading of `beforeBytes` (R11: each replaces one source
 *           text node; `baseTextHash`, src/edit-hash.js, must be the hash of that node's text now, else "edit_moved"): applied
 *           here, proven, and `afterBytes` (may be null) must equal the result
 *   none:   a whole new version (a commit, an agent write): decoding, the limits and a parse, no splice proof
 * then the charset rule (withCharset) and the inventory of active content before and after (R1). `opts.read` (a reading of beforeBytes)
 * and `opts.beforeInv` save a parse. Holds at most two trees.
 * Returns {ok: true, bytes (to write: afterBytes, or with the charset declaration added), charset_added, links ({added, removed} link and
 * load targets, for History)} or {ok: false, code, reason, reasons?}: code "active_content" (reason ACTIVE_REFUSED, reasons the fixed
 * codes of src/html-active.js), "too_large", "not_utf8", "before_unreadable", "proof_failed", "charset_needs_head", "not_addressable",
 * "overlapping_edit", "edit_moved", "edits_mismatch", "not_well_formed" (a NUL or a lone surrogate in an edit's text).
 */
export function checkedHtmlWrite(beforeBytes, afterBytes, opts = {}) {
  let read = opts.read || null;
  let beforeDoc = read?.doc;
  let declared = read ? read.bomLen > 0 || decodeHtml(read.bytes).declared != null : false;
  if (!read) {
    const p = parseChecked(beforeBytes);
    if (!p.ok) return refusal("before_unreadable", `the file as it is now cannot be read as HTML: ${p.why}`);
    beforeDoc = p.doc;
    declared = p.bomLen > 0 || p.declared != null;
  }
  const beforeInfo = { declared, ascii: !hasHigh(read ? read.bytes : beforeBytes) };
  const beforeInv = opts.beforeInv || inventory(beforeDoc);
  let after;
  if (opts.edits) {
    if (!read || !read.nodes) read = readHtml(beforeBytes);
    const seen = new Set();
    const items = [];
    for (const ed of opts.edits) {
      const x = read.nodes[ed?.nodeId];
      if (!x || !isText(x) || x.__hidden || x.__ok !== true || !["normal", "rcdata"].includes(textContext(x))) return refusal("not_addressable", "a text edit names a place that is not one editable text of the page");
      if (seen.has(x)) return refusal("overlapping_edit", "two text edits name the same text");
      // the page's hash of the text it edited (src/edit-hash.js): another text at that place means the page and the file disagree
      if (ed.baseTextHash != null && editHash(x.value) !== ed.baseTextHash) return refusal("edit_moved", "a text edit was made on text that is not at that place in the file now");
      seen.add(x);
      items.push({ node: x, start: 0, end: x.value.length, repl: String(ed.text ?? "") });
    }
    const t = textEdit(read, items);
    if (!t.ok) return refusal(t.code === "not_addressable" ? "not_addressable" : "not_well_formed", t.why);
    const { bytes, plan } = assemble(read, [t.edit]);
    if (afterBytes && !Buffer.from(afterBytes).equals(bytes)) return refusal("edits_mismatch", "the bytes to write are not the text edits applied to the file");
    const p = proveEdits(read, bytes, plan);
    if (!p.ok) return p.code === "limits" ? refusal("too_large", p.why) : refusal("proof_failed", "the change would also change the page somewhere else, so nothing was written");
    after = { ...p.parsed, declared: decodeHtml(bytes).declared };
  } else if (opts.plan) {
    const p = proveEdits(read, afterBytes, opts.plan);
    if (!p.ok) return p.code === "limits" ? refusal("too_large", p.why) : refusal("proof_failed", "the change would also change the page somewhere else, so nothing was written");
    after = { ...p.parsed, declared: decodeHtml(p.parsed.bytes).declared };
  } else if (opts.parsed) {
    after = { ...opts.parsed, declared: decodeHtml(opts.parsed.bytes).declared };
  } else {
    beforeDoc = null; // the old tree is not needed past its inventory: at most two trees
    const p = parseChecked(afterBytes);
    if (!p.ok) return unreadable(p);
    after = p;
  }
  const c = withCharset(beforeInfo, after);
  if (!c.ok) return c;
  after = null;
  const d = inventoryDelta(beforeInv, inventory(c.doc));
  if (d.refused) return refusal("active_content", ACTIVE_REFUSED, { reasons: d.reasons });
  return { ok: true, bytes: c.bytes, charset_added: c.added, links: d.links };
}
