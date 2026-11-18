import { readDocxParagraphs } from "../docx.js";
import { openZip } from "../zip.js";
import { replaceEntry } from "../zip-write.js";
import { checkExpect, engineFailure, excerpt, fail, textHash, normText, refused } from "./common.js";
import { TableError, tableEditor } from "./docx-table.js";
import { loadEngine, openEngine } from "./engine.js";
import { applySet, applySets, countMatches, findRanges, hasObjects, layout, pickMatches, rangesOf, replaceRanges, setAllText, splitForRange, splitForRanges } from "./runs.js";

/**
 * DOCX driver. Two phases per run (see run.js): bind() resolves anchors and checks `expect` against the file as it was before any
 * op ran; exec() then performs the ops in order through the engine's own edit path (docx.edit), the path the editor uses.
 */

const HEADING_CANON = new Set(["title", "subtitle", "h1", "h2", "h3", "h4", "h5", "h6"]);
const NEW_PID_BASE = 2_000_000;

const visibleText = (p) => layout(p.runs).text;

export async function open({ bytes, name, anchors }) {
  const h = await openEngine(bytes, name);
  const { paraSpec } = await loadEngine();
  await h.engine.call("docx.start", []);
  const done = h.events.find((e) => e.event === "docx:done")?.data;
  if (done?.error) throw new Error(`the engine could not read the document: ${done.error}`);
  const blocks = h.events.filter((e) => e.event === "docx:blocks").flatMap((e) => e.data);
  const meta = h.events.find((e) => e.event === "docx:meta")?.data || {};

  // engine paragraphs in document order (table cells included); parts of one paragraph (page breaks) share a pid and merge into one entry
  const eng = [];
  const walk = (bs) => {
    for (const b of bs) {
      if (b.t === "p") {
        const last = eng[eng.length - 1];
        if (last && b.pid !== undefined && last.pid === b.pid) last.parts.push(b);
        else eng.push({ pid: b.pid, parts: [b] });
      } else if (b.t === "tbl") for (const r of b.rows) for (const c of r.cells) walk(c.blocks);
    }
  };
  walk(blocks);
  for (const e of eng) {
    e.ro = e.parts.some((p) => p.ro) || e.pid === undefined;
    e.text = e.parts.map(visibleText).join("");
    e.hash = textHash(e.text);
  }
  const ours = readDocxParagraphs(bytes);
  const group = (list) => {
    const m = new Map();
    for (const x of list) (m.get(x.hash) || m.set(x.hash, []).get(x.hash)).push(x); // a copy per paragraph was quadratic among equal texts
    return m;
  };
  const ourBy = group(ours);
  const ourAt = new Map(); // a paragraph of ours -> its occurrence number among equal texts (indexOf per lookup was quadratic)
  for (const list of ourBy.values()) list.forEach((x, i) => ourAt.set(x, i));
  const engBy = group(eng);
  const cur = new Map(); // pid -> current single-part Paragraph model
  for (const e of eng) if (e.pid !== undefined && e.parts.length === 1) cur.set(e.pid, e.parts[0]);
  // tableOps: the row and column edits, run on the engine's saved bytes (save); bound: the body paths other ops of this file edit
  return { h, paraSpec, meta, styles: meta.styles || [], ours, eng, ourBy, ourAt, engBy, cur, anchors: anchors || new Map(), newPid: NEW_PID_BASE, name, bytes, tableOps: [], bound: [], shadow: null };
}

/** the engine paragraph that is `o` (same text, same occurrence number among equal texts); null when the two readings of the file disagree */
function engineFor(st, o) {
  const a = st.ourBy.get(o.hash);
  const b = st.engBy.get(o.hash);
  if (!b || a.length !== b.length) return null;
  return b[st.ourAt.get(o)];
}

function locatorOf(st, target) {
  if (!("anchor_id" in target)) return { loc: target };
  const a = st.anchors.get(target.anchor_id);
  if (!a) return { error: `anchor ${target.anchor_id} is not in the batch (pass --batch batch.json, or run inside the session that delivered it)` };
  if (!a.locator) return { error: `anchor ${target.anchor_id} was not resolved to a paragraph when the batch was built` };
  return { loc: a.locator, quote: a.quote };
}

const pathKey = (path) => (Array.isArray(path) && path.every(Number.isInteger) ? path.join(",") : null); // a body path is integers (anything else matches nothing)
const NONE = [];
/**
 * The paragraphs of the file by w14:paraId, by body path and by text hash, built on first use: every op of a run looks its paragraph up
 * instead of scanning them all (a scan per op made a merge of 8,000 edited paragraphs hold the server's thread for 1.4 s, 49,999 for 120 s).
 */
function lookup(st) {
  if (st.lookup) return st.lookup;
  const ix = { byId: new Map(), byPath: new Map(), byHash: new Map() };
  const add = (m, k, p) => (m.get(k) || m.set(k, []).get(k)).push(p);
  for (const p of st.ours) {
    if (p.paraId) add(ix.byId, p.paraId, p);
    if (p.path) add(ix.byPath, pathKey(p.path), p);
    add(ix.byHash, p.hash, p);
  }
  return (st.lookup = ix);
}

/** durable locator -> one paragraph of the file. Exact matches only (paraId, path+hash, hash, quote): no fuzzy matching. */
function resolveParagraph(st, target) {
  const { loc, quote, error } = locatorOf(st, target);
  if (error) return fail("anchor_not_found", error);
  const pid = loc.para_id || loc.paraId;
  const path = Array.isArray(loc.body_path) ? loc.body_path : null;
  const hash = loc.text_hash || null;
  const ix = lookup(st);
  const unique = (hits, how) => (hits.length === 1 ? { o: hits[0] } : hits.length > 1 ? fail("anchor_not_found", `ambiguous locator (${how} matches ${hits.length} paragraphs)`) : null);
  if (pid) {
    const r = unique(ix.byId.get(String(pid).toUpperCase()) || NONE, "para_id");
    if (r) return r;
  }
  const atPath = path ? ix.byPath.get(pathKey(path)) || NONE : NONE;
  if (path && hash) {
    const r = unique(atPath.filter((p) => p.hash === hash), "body_path with text_hash");
    if (r) return r;
  }
  if (hash) {
    const r = unique(ix.byHash.get(hash) || NONE, "text_hash");
    if (r) return r;
  }
  if (path && !hash) {
    const r = unique(atPath, "body_path");
    if (r) return r;
  }
  // Ceiling: the quote is the last resort (no id, path or hash matched) and scans every paragraph; ops that reach it are rare (an agent's
  // locator whose paragraph changed), and a batch carries at most its comments' anchors. Upgrade path: a substring index.
  const q = normText(quote || "");
  if (q.length >= 8) {
    const r = unique(st.ours.filter((p) => normText(p.text).includes(q)), "the anchor quote");
    if (r) return r;
  }
  return fail("anchor_not_found", "no paragraph in the file matches this locator");
}

/** the paragraph, checked against `expect`, mapped to the engine, and refused when protected */
function bindParagraph(st, target, expect) {
  const r = resolveParagraph(st, target);
  if (!r.o) return r;
  const o = r.o;
  const bad = checkExpect(expect, o.text, "contains");
  if (bad) return bad;
  if (o.protected) return fail("skipped_protected", "the paragraph holds a field, content control, equation or other construct that cannot be rewritten losslessly");
  const e = engineFor(st, o);
  if (!e) return fail("anchor_not_found", "the engine and the file read this paragraph's text differently (fields or objects?); not edited");
  if (e.ro) return fail("skipped_protected", "the engine marks this paragraph read-only");
  if (e.parts.length > 1) return refused("paragraph_spans_page_break", "paragraphs that contain a page break are not supported");
  if (o.path) st.bound.push(o.path);
  return { ok: true, pid: e.pid, o };
}

function styleId(st, name) {
  const want = normText(name).toLowerCase();
  return st.styles.find((s) => s.id.toLowerCase() === want || normText(s.name).toLowerCase() === want)?.id;
}
async function ensureStyleId(st, name) {
  const known = styleId(st, name);
  if (known) return known;
  const n = normText(name).toLowerCase();
  const canon = n === "normal" ? "normal" : n === "title" ? "title" : n === "subtitle" ? "subtitle" : /^heading [1-6]$/.test(n) ? `h${n.slice(-1)}` : null;
  if (canon) {
    const r = await st.h.engine.call("docx.style", [canon]);
    st.styles = r.styles || st.styles;
    return r.id;
  }
  return null;
}

// ---- bind --------------------------------------------------------------------------------------------------------
export function bind(st, op) {
  switch (op.op) {
    case "replace_text":
    case "insert_paragraph_after":
    case "insert_paragraph_before":
    case "delete_paragraph":
    case "set_paragraph_style":
    case "format_text":
    case "format_paragraph": {
      const b = bindParagraph(st, op.target, op.expect);
      return b.ok ? { ...b, op } : b;
    }
    case "move_paragraph": {
      const b = bindParagraph(st, op.target, op.expect);
      if (!b.ok) return b;
      const to = bindParagraph(st, op.to, { text_hash: op.to.text_hash });
      if (!to.ok) return to;
      if (to.pid === b.pid) return refused("move_onto_itself", "a paragraph cannot be moved next to itself");
      // the original XML travels whole: only between places of the same kind, and never with a section break or half a comment or bookmark range
      if (b.o.path?.length !== 1 || to.o.path?.length !== 1) return refused("move_not_in_body", "only paragraphs of the document body (not in a table) can be moved");
      const more = (st.detail ||= readDocxParagraphs(st.bytes, { detail: true }))[b.o.ordinal];
      if (more.sect) return refused("move_section_break", "the paragraph ends a section");
      if (more.loose) return refused("move_open_range", "a comment or bookmark starts or ends inside the paragraph");
      return { ...b, anchorPid: to.pid, op };
    }
    case "set_table_cell_text": {
      const { table, row, col, paragraph = 0 } = op.target;
      const o = (lookup(st).byPath.get(pathKey([table, row, col, paragraph])) || NONE)[0];
      if (!o) return fail("anchor_not_found", `no paragraph ${paragraph} in cell (${row},${col}) of table ${table}`);
      const r = bindParagraph(st, { text_hash: o.hash, body_path: o.path }, op.expect);
      return r.ok ? { ...r, op } : r;
    }
    case "replace_all_text": {
      // counted, not listed: one pass per paragraph for the count and the matches inside a longer word (a list of every match of 8
      // million characters held the thread for seconds in an outside review)
      const hits = st.ours.map((o) => ({ o, ...countMatches(o.text, op.find, op.match_case !== false) })).filter((x) => x.n);
      const total = hits.reduce((n, x) => n + x.n, 0);
      // what previewAll reports: matches inside a longer word, and matches in protected paragraphs (which the run skips)
      const extra = { partial_words: hits.reduce((n, x) => n + x.partial, 0), protected: hits.reduce((n, x) => n + (x.o.protected ? x.n : 0), 0) };
      if (total !== op.expect.count) return fail("expect_mismatch", `found ${total} occurrence(s), expected ${op.expect.count}`, { found: total, ...extra });
      return { ok: true, op, hits, total, ...extra };
    }
    case "insert_table_row":
    case "delete_table_row":
    case "insert_table_column":
    case "delete_table_column":
      return bindTable(st, op);
    case "format_all": {
      const inScope = scopeEntries(st, op.scope);
      const prot = protectedEntries(st);
      const skipped = inScope.filter((e) => e.ro || prot.has(e) || e.parts.length > 1).length; // the same test exec skips on
      if (inScope.length !== op.expect.count) return fail("expect_mismatch", `${inScope.length} paragraph(s) with text are in scope "${op.scope}", expected ${op.expect.count}`, { found: inScope.length, protected: skipped });
      return { ok: true, op, found: inScope.length, protected: skipped };
    }
    default:
      return refused("unsupported_op", `${op.op} does not apply to a .docx`);
  }
}

// ---- table rows and columns (src/ops/docx-table.js) ----------------------------------------------------------------
const TABLE_KIND = { insert_table_row: "insertRow", delete_table_row: "deleteRow", insert_table_column: "insertColumn", delete_table_column: "deleteColumn" };
const docXml = (st) => (st.docXml ??= openZip(st.bytes).readText("word/document.xml"));
/** cell paragraphs -> text: grouped by `key` (path index of the cell) in order, paragraphs joined by LF, groups by `sep` */
function joined(paras, key, sep) {
  const groups = new Map();
  for (const p of paras) (groups.get(p.path[key]) || groups.set(p.path[key], []).get(p.path[key])).push(p.text);
  return [...groups.keys()].sort((a, b) => a - b).map((k) => groups.get(k).join("\n")).join(sep);
}
const tableSpec = (op, tableNo) => {
  const isRow = "row" in op.target;
  const at = isRow ? op.target.row : op.target.col;
  return { kind: TABLE_KIND[op.op], tableNo, args: op.op.startsWith("insert") ? [at, op.where, op.cells || []] : [at] };
};

/**
 * A row or column of a top-level table, by `table` (body_path[0]) and `row` or `col`. `expect` is checked against the row's text (cells
 * joined by TAB) or the column's (cells joined by LF), each cell's paragraphs joined by LF. The edit is tried here on a copy of the file as
 * delivered that carries the table edits bound before it, so what the table cannot take (merged cells, the last row, more cell texts
 * than cells) is refused before any op runs.
 */
function bindTable(st, op) {
  const { table } = op.target;
  const cells = st.ours.filter((p) => p.path?.length === 4 && p.path[0] === table);
  if (!cells.length) return fail("anchor_not_found", `body item ${table} is not a table (use body_path[0] of a paragraph in the table)`);
  const isRow = "row" in op.target;
  const at = isRow ? op.target.row : op.target.col;
  const sel = cells.filter((p) => p.path[isRow ? 1 : 2] === at);
  if (!sel.length) return fail("anchor_not_found", `the table has no ${isRow ? "row" : "column"} ${at} (0-based)`);
  const bad = checkExpect(op.expect, joined(sel, isRow ? 2 : 1, isRow ? "\t" : "\n"), "contains");
  if (bad) return bad;
  if (op.op.startsWith("delete") && sel.some((p) => p.protected)) return fail("skipped_protected", `the ${isRow ? "row" : "column"} holds a protected paragraph (a field, content control, equation or tracked change); not removed`);
  const spec = tableSpec(op, cells[0].tableNo);
  try {
    (st.bindShadow ??= tableEditor(docXml(st))).run(spec);
  } catch (err) {
    if (err instanceof TableError) return refused(err.code, err.message);
    throw err;
  }
  return { ok: true, op, spec, table, isRow, at };
}

/** The edit on this file's copy of the table (every earlier table edit included); recorded for save when it holds. */
function execTable(st, b) {
  if (b.op.op.startsWith("delete")) {
    const hit = st.bound.find((p) => p.length === 4 && p[0] === b.table && p[b.isRow ? 1 : 2] === b.at);
    if (hit) return refused("cell_edited_by_another_op", `another op of this file edits a paragraph in this ${b.isRow ? "row" : "column"}; it would be removed with it`);
  }
  st.shadow ??= tableEditor(docXml(st));
  let index;
  try {
    index = st.shadow.run(b.spec);
  } catch (err) {
    if (err instanceof TableError) return refused(err.code, err.message); // nothing changed: the copy stays as it was, the engine was not touched
    throw err;
  }
  st.tableOps.push(b.spec);
  return { status: "applied", ...(index !== undefined ? { detail: { table: b.table, [b.isRow ? "row" : "col"]: index } } : {}) };
}

function isHeading(st, e) {
  const sid = e.parts[0].sid;
  const info = st.styles.find((s) => s.id === sid);
  return !!info && (HEADING_CANON.has(info.canon) || info.outline != null);
}
const protectedEntries = (st) => {
  const set = new Set();
  for (const o of st.ours) if (o.protected) set.add(engineFor(st, o));
  return set;
};
function scopeEntries(st, scope) {
  return st.eng.filter((e) => e.text.trim() && (scope === "headings") === isHeading(st, e));
}

// ---- exec --------------------------------------------------------------------------------------------------------
const wasDeleted = () => fail("anchor_not_found", "the paragraph was deleted by an earlier op of this file");

async function editRuns(st, pid, runs) {
  const p = st.cur.get(pid);
  const edited = { ...p, edited: true, runs };
  const res = await st.h.engine.call("docx.edit", [{ anchor: pid, list: [st.paraSpec([edited])], want: true }]);
  const nb = res.blocks[pid];
  st.cur.set(pid, nb && nb.length === 1 && nb[0].t === "p" ? after(p, nb[0], true) : edited); // `edited` stays set: a later spec must not be mistaken for the untouched original
}

/**
 * The paragraph model after an edit. The engine's answer does not carry `pd` (paragraph properties set by an earlier op of this file:
 * style, alignment, list), and every spec is generated from the original paragraph again, so `pd` has to travel with the model or the
 * next op on this paragraph would silently undo it.
 */
const after = (p, block, edited) => ({ ...block, edited, ...(p.pd ? { pd: p.pd } : {}) });

function matchesIn(p, find, matchCase, pick) {
  const { text } = layout(p.runs);
  const found = findRanges(text, find, matchCase !== false);
  const m = pickMatches(found.map((_, i) => i), pick);
  if (m.error) return m;
  const chosen = m.starts.map((i) => found[i]);
  return { starts: chosen.map((r) => r.start), lens: chosen.map((r) => r.end - r.start) }; // lens: with match_case off a match is not always find.length long
}

export async function exec(st, b) {
  const { op } = b;
  if (TABLE_KIND[op.op]) return execTable(st, b);
  try {
    switch (op.op) {
      case "replace_text":
      case "set_table_cell_text": {
        const p = st.cur.get(b.pid);
        if (!p) return wasDeleted();
        if ("text" in op) {
          if (hasObjects(p.runs)) return refused("paragraph_has_objects", "the paragraph holds an image or other object; use find/replace instead of text");
          await editRuns(st, b.pid, setAllText(p.runs, op.text));
          return { status: "applied" };
        }
        const m = matchesIn(p, op.find, op.match_case, op);
        if (m.error) return fail("anchor_not_found", m.error);
        await editRuns(st, b.pid, replaceRanges(p.runs, m.starts, m.lens, op.replace));
        return { status: "applied", detail: { replaced: m.starts.length } };
      }
      case "format_text": {
        const p = st.cur.get(b.pid);
        if (!p) return wasDeleted();
        const m = matchesIn(p, op.find, op.match_case, op);
        if (m.error) return fail("anchor_not_found", m.error);
        const patch = runProps(op.set);
        const sp = splitForRanges(p.runs, rangesOf(m.starts, m.lens));
        await editRuns(st, b.pid, applySet(sp.runs, sp.covered.flat(), patch));
        return { status: "applied", detail: { ranges: m.starts.length } };
      }
      case "insert_paragraph_after":
      case "insert_paragraph_before": {
        const p = st.cur.get(b.pid);
        if (!p) return wasDeleted();
        let pd;
        if (op.style) {
          const id = await ensureStyleId(st, op.style);
          if (!id) return refused("unknown_style", `no paragraph style "${op.style}" (available: ${st.styles.map((s) => s.name).slice(0, 20).join(", ")})`);
          pd = { style: id };
        }
        const pid = st.newPid++;
        const fresh = { pid, from: b.pid, ...(pd ? { pd } : {}), parts: [[{ text: op.text }]] };
        const anchorSpec = st.paraSpec([p]);
        const res = await st.h.engine.call("docx.edit", [{ anchor: b.pid, list: op.op === "insert_paragraph_after" ? [anchorSpec, fresh] : [fresh, anchorSpec], want: true }]);
        if (res.blocks[b.pid]?.length === 1) st.cur.set(b.pid, after(p, res.blocks[b.pid][0], !!p.edited));
        if (res.blocks[pid]?.length === 1) st.cur.set(pid, { ...res.blocks[pid][0], edited: true });
        return { status: "applied" };
      }
      case "delete_paragraph": {
        if (!st.cur.has(b.pid)) return wasDeleted();
        await st.h.engine.call("docx.edit", [{ anchor: b.pid, list: [], remove: [] }]);
        st.cur.delete(b.pid);
        return { status: "applied" };
      }
      case "set_paragraph_style": {
        const p = st.cur.get(b.pid);
        if (!p) return wasDeleted();
        const id = await ensureStyleId(st, op.style);
        if (!id) return refused("unknown_style", `no paragraph style "${op.style}" (available: ${st.styles.map((s) => s.name).slice(0, 20).join(", ")})`);
        const pd = { ...(p.pd || {}), style: id };
        const spec = { ...st.paraSpec([{ ...p, edited: true }]), pd };
        const res = await st.h.engine.call("docx.edit", [{ anchor: b.pid, list: [spec], want: true }]);
        const nb = res.blocks[b.pid];
        if (!nb || nb[0].sid !== id) return { ...refused("style_not_applied", "the engine did not apply the style"), dirty: true };
        st.cur.set(b.pid, after({ pd }, nb[0], true));
        return { status: "applied" };
      }
      // The two ops below are the merge's own (src/merge.js): they are not in ops.schema.json, so an agent's ops file cannot name them.
      case "format_paragraph": {
        // formatting the user set while the agent worked: paragraph properties (`para`) and run properties by character range (`runs`), in one edit
        const p = st.cur.get(b.pid);
        if (!p) return wasDeleted();
        const pd = { ...(p.pd || {}) };
        const para = op.para || {};
        let id;
        if (para.style === null) pd.style = ""; // back to the default style: the engine takes the style reference out
        else if ("style" in para) {
          id = await ensureStyleId(st, para.style);
          if (!id) return refused("unknown_style", `no paragraph style "${para.style}"`);
          pd.style = id;
        }
        if ("align" in para) pd.align = para.align;
        if ("list" in para) pd.list = para.list;
        if ("ilvl" in para) pd.ilvl = para.ilvl;
        let runs = p.runs;
        if (op.runs?.length) {
          // offsets are those of the paragraph as the file has it: any difference in how the engine reads the text and nothing is formatted
          if (layout(runs).text !== b.o.text) return refused("text_read_differently", "the engine reads this paragraph's text differently; not formatted");
          const ranges = [...op.runs].sort((x, y) => x.start - y.start);
          const sp = splitForRanges(runs, ranges);
          if (sp) runs = applySets(sp.runs, sp.covered, ranges.map((r) => r.set));
          else {
            // ranges that overlap or are empty: one at a time, right to left (each a pass over the runs)
            for (const r of ranges.reverse()) {
              const one = splitForRange(runs, r.start, r.end);
              runs = applySet(one.runs, one.covered, r.set);
            }
          }
        }
        const spec = { ...st.paraSpec([{ ...p, edited: true, runs }]), ...(Object.keys(pd).length ? { pd } : {}) };
        const res = await st.h.engine.call("docx.edit", [{ anchor: b.pid, list: [spec], want: true }]);
        const nb = res.blocks[b.pid];
        if (!nb || nb.length !== 1 || nb[0].t !== "p") return { ...refused("format_not_applied", "the engine did not return the paragraph"), dirty: true };
        if (id !== undefined && nb[0].sid !== id) return { ...refused("style_not_applied", "the engine did not apply the style"), dirty: true };
        st.cur.set(b.pid, after({ pd: Object.keys(pd).length ? pd : undefined }, nb[0], true));
        return { status: "applied" };
      }
      case "move_paragraph": {
        // the paragraph itself (its original XML when no op of this file edited it) is taken out of its place and listed next to the anchor
        const p = st.cur.get(b.pid);
        const a = st.cur.get(b.anchorPid);
        if (!p || !a) return wasDeleted();
        const list = [st.paraSpec([a]), st.paraSpec([p])];
        await st.h.engine.call("docx.edit", [{ anchor: b.anchorPid, list: op.where === "before" ? list.reverse() : list }]);
        return { status: "applied" };
      }
      case "replace_all_text": {
        const skipped = [];
        let n = 0;
        let paragraphs = 0;
        let skippedMatches = 0;
        const prot = protectedEntries(st);
        for (const { o, n: expected } of b.hits) {
          const skip = (reason) => {
            skipped.push({ ordinal: o.ordinal, reason, excerpt: excerpt(o.text) });
            skippedMatches += expected;
          };
          const e = engineFor(st, o);
          const p = e && e.pid !== undefined ? st.cur.get(e.pid) : null;
          if (!e || e.ro || prot.has(e) || o.protected || !p) {
            skip(!e ? "text read differently by the engine" : "protected");
            continue;
          }
          if (e.parts.length > 1) {
            skip("paragraph spans a page break");
            continue;
          }
          const m = matchesIn(p, op.find, op.match_case, { all: true });
          if (m.error || m.starts.length !== expected) {
            // an earlier op of this file changed the paragraph, or the engine reads it differently: never silently under-apply
            skip(m.error ? "the text is no longer in the paragraph (changed by an earlier op of this file?)" : `the engine finds ${m.starts.length} of the ${expected} match(es)`);
            continue;
          }
          let runs;
          try {
            runs = replaceRanges(p.runs, m.starts, m.lens, op.replace);
          } catch (err) {
            if (!(err instanceof RangeError)) throw err;
            skip(err.message);
            continue;
          }
          await editRuns(st, e.pid, runs);
          n += m.starts.length;
          paragraphs++;
        }
        // every bound match ends up replaced or listed: a count that does not add up is a failure, not an "applied"
        if (n + skippedMatches !== b.total) return { ...refused("incomplete_replace", `replaced ${n} and listed ${skippedMatches} of ${b.total} match(es)`), dirty: true };
        if (!paragraphs && skipped.length) return { status: "skipped_protected", reason: "every paragraph with a match is protected or unreadable for the engine", detail: { skipped_protected: skipped } };
        return { status: "applied", detail: { replaced: n, paragraphs, ...(skipped.length ? { skipped_protected: skipped } : {}) } };
      }
      case "format_all": {
        const prot = protectedEntries(st);
        const patch = runProps(op.set);
        const skipped = [];
        let changed = 0;
        for (const e of scopeEntries(st, op.scope)) {
          const p = e.pid !== undefined ? st.cur.get(e.pid) : null;
          if (!p || e.ro || prot.has(e) || e.parts.length > 1) {
            skipped.push({ reason: "protected", excerpt: excerpt(e.text) });
            continue;
          }
          const { segs } = layout(p.runs);
          const covered = segs.filter((g) => g.text).map((g) => g.i);
          await editRuns(st, e.pid, applySet(p.runs, covered, patch));
          changed++;
        }
        if (!changed && skipped.length) return { status: "skipped_protected", reason: "every paragraph in scope is protected", detail: { skipped_protected: skipped } };
        return { status: "applied", detail: { paragraphs: changed, ...(skipped.length ? { skipped_protected: skipped } : {}) } };
      }
    }
  } catch (err) {
    return engineFailure(err);
  }
  return refused("unsupported_op", op.op);
}

/** schema property names -> the engine's direct-formatting names */
function runProps(set) {
  const d = {};
  if ("bold" in set) d.b = set.bold;
  if ("italic" in set) d.i = set.italic;
  if ("underline" in set) d.u = set.underline ? "single" : "none";
  if ("color" in set) d.color = set.color.toLowerCase();
  if ("size_pt" in set) d.sz = set.size_pt;
  return d;
}

export async function save(st) {
  const blob = await st.h.engine.call("save", []);
  const out = Buffer.from(await blob.arrayBuffer());
  if (!st.tableOps.length) return out;
  // the row and column edits last, on the engine's document: its paragraph edits never change a table's rows or cells, so each edit
  // meets the table it was checked against in exec (a refusal here throws and nothing is written)
  const ed = tableEditor(openZip(out).readText("word/document.xml"));
  for (const spec of st.tableOps) ed.run(spec);
  return replaceEntry(out, "word/document.xml", ed.xml());
}

export const close = (st) => st.h.engine.dispose();
