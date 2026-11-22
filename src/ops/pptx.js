import { partRels } from "../package.js";
import { openZip } from "../zip.js";
import { checkExpect, engineFailure, excerpt, fail, refused } from "./common.js";
import { openEngine } from "./engine.js";
import { countMatches, findRanges, overlapRefusal, pickMatches, rangesOf } from "./runs.js";

/**
 * PPTX driver (headless Engine: pptx.slide to read a slide model, pptx.setText to write one shape's paragraphs, pptx.slides to
 * duplicate, delete and move slides: the editor's own slide path). Shapes are addressed by p:sldId id + cNvPr id, slides by p:sldId id;
 * a slide's position is looked up when an op runs, because an earlier slide op of the same file may have moved it.
 * A paragraph the engine marks `ro` is protected and never rewritten.
 */

export async function open({ bytes, name, anchors = new Map() }) {
  const h = await openEngine(bytes, name);
  return { h, slides: h.info.pptx.slides, name, anchors, bytes };
}

/** `{slide_id, shape_id}` as written, or `{anchor_id}` resolved through the delivered batch (the locator carries exactly those two fields). */
function shapeTarget(st, target) {
  if (!("anchor_id" in target)) return { target };
  const a = st.anchors.get(target.anchor_id);
  if (!a) return { error: `anchor ${target.anchor_id} is not in the batch (pass --batch batch.json, or run inside the session that delivered it)` };
  if (a.locator?.slide_id == null || a.locator?.shape_id == null) return { error: `anchor ${target.anchor_id} does not name a shape (it is a slide-level anchor)` };
  return { target: { slide_id: String(a.locator.slide_id), shape_id: a.locator.shape_id } };
}

/** All shapes with text on a slide model, groups flattened, in document order */
function shapesOf(els, out = []) {
  for (const el of els || []) {
    if (el.text?.paras) out.push(el);
    if (el.children) shapesOf(el.children, out);
    if (el.els) shapesOf(el.els, out);
  }
  return out;
}

const runText = (r) => (r.br ? "\n" : r.text || "");
const paraText = (p) => p.runs.map(runText).join("");
const shapeText = (el) => el.text.paras.map(paraText).join("\n");

async function slideModel(st, index) {
  return st.h.engine.call("pptx.slide", [index]);
}

const slideText = (m) => shapesOf(m.els).map(shapeText).join("\n");
/** The slide with p:sldId `id` (the first of that id) and its index (-1: none), through a map rebuilt whenever a slide op replaces st.slides (a search per op was quadratic). */
function slideById(st, id) {
  return st.slides[indexOf(st, id)];
}
function indexOf(st, id) {
  if (st.byIdOf !== st.slides) {
    st.byId = new Map();
    st.slides.forEach((s, i) => st.byId.has(String(s.id)) || st.byId.set(String(s.id), i));
    st.byIdOf = st.slides;
  }
  return st.byId.get(String(id)) ?? -1;
}

// ---- the package around a slide (read from the file as delivered: only slide ops change it, and they are checked here) ----------------
// what a copy may share with the slide it was made from: its layout, pictures and links (notes and comments are not copied)
const COPY_SHARES = new Set(["slideLayout", "image", "hyperlink", "slide", "notesSlide", "comments"]);
const KIND_NAMES = { chart: "a chart", chartUserShapes: "a chart", diagramData: "a SmartArt diagram", diagramLayout: "a SmartArt diagram", diagramQuickStyle: "a SmartArt diagram", diagramColors: "a SmartArt diagram", diagramDrawing: "a SmartArt diagram", oleObject: "an embedded object", package: "an embedded object", video: "a video", audio: "a sound", media: "media", tags: "tags", vmlDrawing: "a legacy drawing", control: "a control", ink: "ink" };

/** Refusals that hold for every slide op of a deck: what the engine would leave out of step. Null when the deck is fine. */
function deckRefusal(st) {
  const zip = (st.zip ??= openZip(st.bytes));
  const pres = zip.readText("ppt/presentation.xml") || "";
  if (/<(?:\w+:)?section\b/.test(pres)) return refused("deck_has_sections", "the deck has sections; adding, deleting or moving slides would leave the section list out of step");
  if (/<(?:\w+:)?custShow\b/.test(pres)) return refused("deck_has_custom_shows", "the deck has custom shows; adding, deleting or moving slides would leave them out of step");
  return null;
}
function slidePart(st, id) {
  return slideById(st, id)?.path || null;
}
/** a part of the deck other than the presentation and the slide's own notes that links to the slide (a "go to slide" link, a summary zoom) */
function linkedFrom(st, part) {
  const zip = st.zip;
  const own = new Set([part, ...partRels(zip, part).filter((r) => r.type === "notesSlide").map((r) => r.target)]);
  for (const name of zip.names) {
    if (!name.endsWith(".rels") || name === "ppt/_rels/presentation.xml.rels") continue;
    const src = name.replace(/_rels\/([^/]+)\.rels$/, "$1");
    if (own.has(src)) continue;
    if (partRels(zip, src).some((r) => !r.external && r.target === part)) return src;
  }
  return null;
}

async function findShape(st, rawTarget) {
  const t = shapeTarget(st, rawTarget);
  if (t.error) return fail("anchor_not_found", t.error);
  const target = t.target;
  const slide = slideById(st, target.slide_id);
  if (!slide) return fail("anchor_not_found", `no slide with id ${target.slide_id}`);
  const m = await slideModel(st, slide.index);
  const hits = shapesOf(m.els).filter((e) => e.sid === target.shape_id);
  if (hits.length !== 1) return fail("anchor_not_found", hits.length ? `shape id ${target.shape_id} is ambiguous on slide ${target.slide_id}` : `no shape with text and id ${target.shape_id} on slide ${target.slide_id}`);
  return { slide, el: hits[0] };
}

export async function bind(st, op) {
  switch (op.op) {
    case "set_shape_text":
    case "replace_text_in_shape": {
      const f = await findShape(st, op.target);
      if (!f.el) return f;
      const bad = checkExpect(op.expect, shapeText(f.el), "contains");
      if (bad) return bad;
      const ro = f.el.text.paras.filter((p) => p.ro);
      if (ro.length && op.op === "set_shape_text") return fail("skipped_protected", `${ro.length} paragraph(s) of this shape are protected (equations, unmodeled fields); not rewritten`);
      if (op.op === "set_shape_text" && f.el.text.paras.some((p) => p.runs.some((r) => r.fld))) return refused("shape_has_fields", "the shape holds a field (slide number, date); use replace_text_in_shape");
      return { ok: true, op, slide: f.slide.index, sid: f.el.sid, target: { slide_id: String(f.slide.id), shape_id: f.el.sid } };
    }
    case "replace_all_text": {
      const hits = [];
      for (const s of st.slides) {
        const m = await slideModel(st, s.index);
        for (const el of shapesOf(m.els)) {
          el.text.paras.forEach((p, pi) => {
            const text = paraText(p);
            const { n, partial } = countMatches(text, op.find, op.match_case !== false);
            if (n) hits.push({ slideId: String(s.id), sid: el.sid, pi, n, partial, ro: !!p.ro, text });
          });
        }
      }
      const total = hits.reduce((n, x) => n + x.n, 0);
      const extra = { partial_words: hits.reduce((n, x) => n + x.partial, 0), protected: hits.reduce((n, x) => n + (x.ro ? x.n : 0), 0) };
      if (total !== op.expect.count) return fail("expect_mismatch", `found ${total} occurrence(s), expected ${op.expect.count}`, { found: total, ...extra });
      return { ok: true, op, hits, total, ...extra };
    }
    case "duplicate_slide":
    case "delete_slide":
    case "move_slide":
      return bindSlide(st, op);
    default:
      return refused("unsupported_op", `${op.op} does not apply to a .pptx`);
  }
}

/** A slide by id, its `expect` against the text of its shapes (joined by LF), and what the deck or the slide cannot take. */
async function bindSlide(st, op) {
  const i = indexOf(st, op.target.slide_id);
  if (i < 0) return fail("anchor_not_found", `no slide with id ${op.target.slide_id}`);
  const m = await slideModel(st, i);
  const bad = checkExpect(op.expect, slideText(m), "contains");
  if (bad) return bad;
  const deck = deckRefusal(st);
  if (deck) return deck;
  if (op.to) {
    if (indexOf(st, op.to.slide_id) < 0) return fail("anchor_not_found", `no slide with id ${op.to.slide_id} (to)`);
    if (op.op === "move_slide" && op.to.slide_id === op.target.slide_id) return refused("move_onto_itself", "a slide cannot be moved next to itself");
  }
  const part = slidePart(st, op.target.slide_id);
  if (op.op === "delete_slide") {
    if (st.slides.length <= 1) return refused("last_slide", "the deck has only this slide");
    const from = linkedFrom(st, part);
    if (from) return refused("slide_is_linked", `another part of the deck links to this slide (${from}); remove the link first`);
  }
  if (op.op === "duplicate_slide") {
    const other = partRels(st.zip, part).filter((r) => !COPY_SHARES.has(r.type));
    if (other.length) {
      const what = [...new Set(other.map((r) => KIND_NAMES[r.type] || `a part of type ${r.type}`))].join(", ");
      return refused(other.some((r) => r.type === "chart") ? "slide_has_chart" : "slide_has_shared_parts", `the slide holds ${what}, which a copy would share with it; slides with charts or embedded parts cannot be duplicated here`);
    }
    for (const sh of op.shapes || []) {
      const hits = shapesOf(m.els).filter((e) => e.sid === sh.shape_id);
      if (hits.length !== 1) return fail("anchor_not_found", hits.length ? `shape id ${sh.shape_id} is ambiguous on slide ${op.target.slide_id}` : `no shape with text and id ${sh.shape_id} on slide ${op.target.slide_id}`);
      const ro = hits[0].text.paras.filter((p) => p.ro);
      if (ro.length) return fail("skipped_protected", `${ro.length} paragraph(s) of shape ${sh.shape_id} are protected (equations, unmodeled fields); not rewritten`);
      if (hits[0].text.paras.some((p) => p.runs.some((r) => r.fld))) return refused("shape_has_fields", `shape ${sh.shape_id} holds a field (slide number, date); its text cannot be set here`);
    }
  }
  return { ok: true, op };
}

/** PParaSpec[] for the shape as it is now; `edit(paraIndex, runs)` may change one paragraph's runs (specs for the rest echo the model) */
function specsOf(el, edit) {
  return el.text.paras.map((p, pi) => {
    const runs = p.runs.map((r) => (r.fld ? { text: r.text, src: r.src, fld: true } : { text: runText(r), src: r.src }));
    return { k: p.k ?? pi, runs: edit?.(pi, runs) ?? runs };
  });
}

/** set_shape_text's specs: one paragraph per string; existing paragraphs keep their formatting, extra ones copy the last */
function textSpecs(el, paragraphs) {
  const cur = specsOf(el);
  const first = el.text.paras[0]?.runs.find((r) => !r.fld && !r.br);
  return paragraphs.map((text, i) => {
    const base = cur[Math.min(i, cur.length - 1)];
    const src = (el.text.paras[Math.min(i, cur.length - 1)]?.runs.find((r) => !r.fld && !r.br) || first)?.src;
    return { ...(i < cur.length ? { k: base.k } : { k: undefined }), ...(base?.algn ? { algn: base.algn } : {}), runs: [{ text, src }] };
  });
}

/**
 * One slide op through the engine's pptx.slides, by slide id. The engine skips an op it cannot do without saying so, so the slide list it
 * returns is checked against what the op must leave (one more slide right where asked, one fewer, the same set in a new order).
 */
async function execSlide(st, op) {
  const before = st.slides.map((s) => String(s.id));
  const from = before.indexOf(op.target.slide_id);
  if (from < 0) return fail("anchor_not_found", `slide ${op.target.slide_id} was deleted by an earlier op of this file`);
  const call = async (args) => (st.slides = (await st.h.engine.call("pptx.slides", [args])).slides);
  /** the engine's `move` index for "before/after `to`": it takes the slide out first, then inserts it at that index of the rest */
  const moveTo = (ids, moving, to, where) => {
    const rest = ids.filter((x) => x !== moving);
    const at = rest.indexOf(to);
    return at < 0 ? -1 : where === "after" ? at + 1 : at;
  };
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  if (op.op === "delete_slide") {
    if (before.length <= 1) return refused("last_slide", "the deck has only this slide");
    await call({ op: "delete", index: from });
    if (!same(st.slides.map((s) => String(s.id)), before.filter((x) => x !== op.target.slide_id))) return { ...refused("slide_op_not_applied", "the engine did not delete the slide"), dirty: true };
    return { status: "applied" };
  }
  if (op.op === "move_slide") {
    const to = moveTo(before, op.target.slide_id, op.to.slide_id, op.where);
    if (to < 0) return fail("anchor_not_found", `slide ${op.to.slide_id} (to) was deleted by an earlier op of this file`);
    await call({ op: "move", from, to });
    const want = before.filter((x) => x !== op.target.slide_id);
    want.splice(to, 0, op.target.slide_id);
    if (!same(st.slides.map((s) => String(s.id)), want)) return { ...refused("slide_op_not_applied", "the engine did not move the slide"), dirty: true };
    return { status: "applied" };
  }
  // duplicate: the copy lands right after its slide; then, when asked, it moves; then its shapes get their text
  if (op.to && !before.includes(op.to.slide_id)) return fail("anchor_not_found", `slide ${op.to.slide_id} (to) was deleted by an earlier op of this file`);
  await call({ op: "duplicate", index: from });
  const ids = st.slides.map((s) => String(s.id));
  const copy = ids[from + 1];
  if (ids.length !== before.length + 1 || before.includes(copy) || !same(ids.filter((x) => x !== copy), before)) return { ...refused("slide_op_not_applied", "the engine did not duplicate the slide"), dirty: true };
  if (op.to) {
    const to = moveTo(ids, copy, op.to.slide_id, op.where);
    await call({ op: "move", from: from + 1, to });
    if (st.slides.map((s) => String(s.id)).indexOf(copy) !== to) return { ...refused("slide_op_not_applied", "the engine did not move the copy"), dirty: true };
  }
  const at = indexOf(st, copy);
  for (const sh of op.shapes || []) {
    const el = shapesOf((await slideModel(st, at)).els).find((e) => e.sid === sh.shape_id);
    if (!el) return { ...fail("anchor_not_found", `shape ${sh.shape_id} is not on the copy`), dirty: true };
    await st.h.engine.call("pptx.setText", [at, el.sid, textSpecs(el, sh.paragraphs)]);
  }
  return { status: "applied", detail: { slide_id: copy } }; // the copy's id: its position may change with a later op of this file
}

/**
 * replaceInRuns for every match at once (`starts`, non-overlapping, of `len` characters each: one number, or one length per start): the same result as replaceInRuns applied
 * right to left, in one pass over the runs (a pass per match: one shape of 240,000 one-letter runs took minutes). Exported for its test.
 */
export function replaceAllInRuns(runs, starts, len, replacement) {
  if (!starts.length) return runs.map((r) => ({ ...r }));
  const at = rangesOf(starts, len);
  const firstOf = new Array(at.length).fill(-1);
  let pos = 0;
  let k = 0;
  const out = runs.map((r, i) => {
    const a = pos;
    const b = pos + r.text.length;
    pos = b;
    while (k < at.length && at[k].end <= a) k++;
    let text = null;
    let cur = 0;
    for (let j = k; j < at.length && at[j].start < b; j++) {
      const { start: s, end: e } = at[j];
      if (e <= a) continue;
      if (r.fld) throw new RangeError("the match is inside a field");
      const put = firstOf[j] < 0;
      if (put) firstOf[j] = i;
      text = (text ?? "") + r.text.slice(cur, Math.max(0, s - a)) + (put ? replacement : "");
      cur = Math.min(r.text.length, e - a);
    }
    return text === null ? { ...r } : { ...r, text: text + r.text.slice(cur) };
  });
  return out.filter((r, i) => r.text !== "" || i === firstOf[0] || r.fld);
}

/** replaces [s,e) of a paragraph's concatenated run texts; the first run in range carries the replacement and the formatting */
export function replaceInRuns(runs, s, e, replacement) {
  let pos = 0;
  const out = runs.map((r) => ({ ...r }));
  let first = -1;
  out.forEach((r, i) => {
    const a = pos;
    const b = pos + r.text.length;
    pos = b;
    if (b <= s || a >= e) return;
    if (r.fld) throw new RangeError("the match is inside a field");
    const head = r.text.slice(0, Math.max(0, s - a));
    const tail = r.text.slice(Math.min(r.text.length, e - a));
    if (first < 0) {
      first = i;
      r.text = head + replacement + (e <= b ? tail : "");
    } else r.text = e <= b ? tail : "";
  });
  return out.filter((r, i) => r.text !== "" || i === first || r.fld);
}

export async function exec(st, b) {
  const { op } = b;
  let mutated = 0;
  try {
    if (op.op === "set_shape_text") {
      const f = await findShape(st, b.target);
      if (!f.el) return f;
      const specs = textSpecs(f.el, op.paragraphs);
      await st.h.engine.call("pptx.setText", [f.slide.index, f.el.sid, specs]);
      return { status: "applied", detail: { paragraphs: specs.length } };
    }
    if (op.op === "duplicate_slide" || op.op === "delete_slide" || op.op === "move_slide") return await execSlide(st, op);
    if (op.op === "replace_text_in_shape") {
      const f = await findShape(st, b.target);
      if (!f.el) return f;
      const slideIndex = f.slide.index;
      const hits = [];
      f.el.text.paras.forEach((p, pi) => findRanges(paraText(p), op.find, op.match_case !== false).forEach(({ start, end }) => hits.push({ pi, at: start, len: end - start })));
      const overlap = overlapRefusal(f.el.text.paras.map(paraText), op.find, op.match_case !== false, hits.length, op);
      if (overlap) return refused("overlapping_matches", overlap);
      const pick = pickMatches(hits.map((_, i) => i), op);
      if (pick.error) return fail("anchor_not_found", pick.error);
      const chosen = pick.starts.map((i) => hits[i]);
      const blocked = chosen.filter((h) => f.el.text.paras[h.pi].ro);
      if (blocked.length) return fail("skipped_protected", "the match is in a protected paragraph", { detail: { skipped_protected: blocked.map((h) => ({ paragraph: h.pi, excerpt: excerpt(paraText(f.el.text.paras[h.pi])) })) } });
      const byPara = new Map();
      for (const h of chosen) (byPara.get(h.pi) || byPara.set(h.pi, []).get(h.pi)).push(h);
      const specs = specsOf(f.el, (pi, runs) => {
        const hs = byPara.get(pi);
        if (!hs) return null;
        return replaceAllInRuns(runs, hs.map((h) => h.at), hs.map((h) => h.len), op.replace);
      });
      await st.h.engine.call("pptx.setText", [slideIndex, f.el.sid, specs]);
      return { status: "applied", detail: { replaced: chosen.length } };
    }
    if (op.op === "replace_all_text") {
      const skipped = [];
      let n = 0;
      let skippedMatches = 0;
      const bySlide = new Map();
      for (const h of b.hits) {
        const k = `${h.slideId}:${h.sid}`;
        (bySlide.get(k) || bySlide.set(k, []).get(k)).push(h);
      }
      // each slide's model is read once, its shapes by id (a model per shape, searched shape by shape, was quadratic on a slide of many
      // shapes): this op writes one shape at a time, and a write never changes another shape's model
      const models = new Map();
      const shapeOn = async (slide, sid) => {
        if (!models.has(slide)) {
          const byId = new Map();
          if (slide >= 0) for (const e of shapesOf((await slideModel(st, slide)).els)) if (!byId.has(e.sid)) byId.set(e.sid, e);
          models.set(slide, byId);
        }
        return models.get(slide).get(sid);
      };
      const writes = [];
      for (const [key, hs] of bySlide) {
        const [slideId, sid] = key.split(":");
        const slide = indexOf(st, slideId); // by id: an earlier slide op of this file may have moved or removed it
        const el = await shapeOn(slide, Number(sid));
        if (!el) {
          skippedMatches += hs.reduce((a, h) => a + h.n, 0);
          skipped.push({ slide: slideId, shape_id: Number(sid), reason: slide < 0 ? "the slide is gone" : "the shape is gone" });
          continue;
        }
        const todo = new Set(hs.filter((h) => !h.ro).map((h) => h.pi));
        for (const h of hs.filter((x) => x.ro)) {
          skipped.push({ slide: slideId, shape_id: Number(sid), paragraph: h.pi, excerpt: excerpt(paraText(el.text.paras[h.pi])) });
          skippedMatches += h.n;
        }
        if (!todo.size) continue;
        const specs = specsOf(el, (pi, runs) => {
          if (!todo.has(pi)) return null;
          const found = findRanges(runs.map((r) => r.text).join(""), op.find, op.match_case !== false);
          n += found.length;
          return replaceAllInRuns(runs, found.map((r) => r.start), found.map((r) => r.end - r.start), op.replace);
        });
        writes.push({ slide, sid: Number(sid), specs });
      }
      if (n + skippedMatches !== b.total) return { ...refused("incomplete_replace", `replaced ${n} and listed ${skippedMatches} of ${b.total} match(es)`), dirty: true };
      for (const w of writes) {
        await st.h.engine.call("pptx.setText", [w.slide, w.sid, w.specs]);
        mutated++;
      }
      if (!n && skipped.length) return { status: "skipped_protected", reason: "every shape with a match is protected", detail: { skipped_protected: skipped } };
      return { status: "applied", detail: { replaced: n, ...(skipped.length ? { skipped_protected: skipped } : {}) } };
    }
  } catch (err) {
    if (err instanceof RangeError) return { ...refused("match_in_field", err.message), ...(mutated > 0 ? { dirty: true } : {}) };
    return engineFailure(err);
  }
  return refused("unsupported_op", op.op);
}

export async function save(st) {
  const blob = await st.h.engine.call("save", []);
  return Buffer.from(await blob.arrayBuffer());
}

export const close = (st) => st.h.engine.dispose();
