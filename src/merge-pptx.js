import { EDITS_OVERFLOW } from "./constants.js";
import { minimalReplace } from "./merge.js";
import { findAll } from "./ops/runs.js";
import { parseDeck } from "./pptx.js";
import { untrusted } from "./sanitize.js";

// What the user changed in a deck while the agent worked, carried onto the agent's version. The same three versions as the DOCX
// merge (src/merge.js): `base` (what the page loaded), `mine` (base plus the user's edits) and `theirs` (the file after the agent).
// The unit is the text of one shape. A slide is matched by its p:sldId id and a shape by its id on that slide, which is how `apply`
// addresses them: both survive slides being added, removed or reordered, so text on a slide all three versions have is still
// placed when the agent changed the slide list. A shape only the user changed becomes ops on `theirs` (`replace_text_in_shape`
// per changed line, or `set_shape_text` when lines were added or removed) with the base text as `expect`, run through the same
// engine and package check as an agent's `apply`. A shape both changed keeps the agent's text and the user's text is handed back.
// Slides or shapes the user added, removed or moved are reported, never rebuilt, and the caller keeps a copy of the user's file.
// Ceilings: text only. Formatting, position, size, fill and slide changes are reported, not carried (the page names them in
// `edits`; one undone or redone with Undo/Redo is not reported). Table text is handed back. `set_shape_text` gives every line one
// format, so it is used only where the shape's text has one format; otherwise the text is handed back.

const CAP = 2000;
const turn = () => new Promise((resolve) => setImmediate(resolve));
const cut = (t) => (t.length > CAP ? `${t.slice(0, CAP)}...` : t);
const sid = (s) => String(s.id ?? `#${s.index}`);
const key = (sh) => `${sh.id}#${sh.ordinal}`;
const keys = (sl) => sl.shapes.map((x) => `${key(x)}/${x.kind}`).join(" ");
const twins = (sl) => sl.shapes.some((x) => x.ordinal > 0);
const slideText = (sl) => sl.shapes.map((x) => x.text).filter(Boolean).join("\n\n");
const nameOf = (sl, sh) => untrusted(`${sh.isTitle ? "the title" : sh.name ? `"${sh.name}"` : `shape ${sh.id}`} on slide ${sl.index + 1}`, 100);
const mixed = (sh) => Object.values(sh.fmt || {}).some((v) => String(v).startsWith("~"));

// ---- what the page says the user did (never a reason to write, only to say what was not carried) ----------------------------
const TEXT = new Set(["text", "undo", "redo"]);
function readEdits(edits) {
  const out = { format: new Set(), shapes: new Set(), slides: false, other: false };
  for (const e of edits || []) {
    const kind = String(e?.kind ?? "");
    const slide = Number.isInteger(e?.slide) ? e.slide : null;
    if (TEXT.has(kind) || kind === EDITS_OVERFLOW) continue; // the list was cut: what it misses is found in the bytes (src/merge-proof.js handBack)
    if (kind === "format") out.format.add(slide);
    else if (kind.startsWith("shape.")) out.shapes.add(slide);
    else if (kind.startsWith("slide.")) out.slides = true;
    else out.other = true;
  }
  return out;
}

// Lines changed in one shape that are carried one replace each; past it the shape's whole text is set (one op). The engine runs each
// op on the whole shape, about 18 microseconds per line of it here: 2,000 changed lines of a 2,000-line shape took 50 s to apply, 100 of
// a 25,000-line shape 46 s. So both count: at most MAX_LINE_OPS replaces, and at most LINE_OP_WORK (replaces x lines), about 2 s.
export const MAX_LINE_OPS = 100;
const LINE_OP_WORK = 100_000;

/**
 * The ops that turn the base text of one shape into the user's: one replace per changed line (last line first), else the whole text.
 * `work` ({left}) is the budget of the whole plan for minimalReplace and for counting the find text in the lines before each one.
 */
function shapeOps(target, old, text, work) {
  const B = old.text.split("\n");
  const M = text.split("\n");
  const expect = { text_hash: old.hash };
  const whole = [{ op: "set_shape_text", target, expect, paragraphs: M }];
  if (B.length !== M.length) return whole;
  let changed = 0;
  for (let i = 0; i < M.length; i++) if (B[i] !== M[i] && (++changed > MAX_LINE_OPS || changed * B.length > LINE_OP_WORK)) return whole;
  // how often a find text occurs in the lines before line i, counted once per find text in one pass (counting the lines before each
  // changed line rescanned all of them: 25,000 changed lines took 4 s to plan in an outside review)
  const before = new Map();
  const countBefore = (find, i) => {
    let at = before.get(find);
    if (!at) {
      work.left -= old.text.length;
      at = new Int32Array(B.length + 1);
      for (let k = 0; k < B.length; k++) at[k + 1] = at[k] + findAll(B[k], find).length;
      before.set(find, at);
    }
    return at[i];
  };
  const ops = [];
  for (let i = M.length - 1; i >= 0; i--) {
    if (B[i] === M[i]) continue;
    const r = minimalReplace(B[i], M[i], work);
    if (!r || work.left < 0) return whole;
    // the find text occurs once in its own line; lines before it are counted, and they are untouched when this op runs
    ops.push({ op: "replace_text_in_shape", target, expect, find: r.find, replace: r.replace, occurrence: countBefore(r.find, i) + 1 });
  }
  return ops;
}

/**
 * Plans the merge. Arguments are parsed decks (parseDeck) and the page's edit kinds ([{kind, slide}]). Returns
 * {items: [{label, text, slide, key, want, ops}], unplaced: [{label, text, why}], copy}: every item is tried on `theirs`; `copy`
 * asks the caller to keep the user's whole file, because an unplaced item stands for more than it can show.
 */
export function planPptxMerge(base, mine, theirs, edits = []) {
  for (const d of [base, mine, theirs]) d.ensure();
  const said = readEdits(edits);
  const work = { left: 4_000_000 + 16 * [base, mine].reduce((n, d) => n + d.slides.reduce((k, sl) => k + sl.shapes.reduce((j, x) => j + x.text.length, 0), 0), 0) };
  const items = [];
  const unplaced = [];
  let copy = false;
  // `of` names what an entry stands for, for the proof of the merge (src/merge-proof.js): "s" and a slide id, "h" and a slide id and
  // shape key, or "order" (the order of the slides)
  const back = (label, why, text = "", of = []) => unplaced.push({ label, text: cut(text), why, of });
  const whole = (label, why, text = "", of = []) => (back(label, why, text, of), (copy = true));
  const shapeRef = (sl, sh) => `h${sid(sl)}/${key(sh)}`;
  const inBase = new Map(base.slides.map((s) => [sid(s), s]));
  const inMine = new Map(mine.slides.map((s) => [sid(s), s]));
  const inTheirs = new Map(theirs.slides.map((s) => [sid(s), s]));
  let slidesSaid = false;
  for (const m of mine.slides) {
    if (inBase.has(sid(m))) continue;
    slidesSaid = true;
    whole(`Slide ${m.index + 1}`, `You added slide ${m.index + 1}. Slide changes are not carried over.${slideText(m) ? " This is its text." : ""}`, slideText(m), [`s${sid(m)}`]);
  }
  for (const b of base.slides) {
    if (inMine.has(sid(b))) continue;
    slidesSaid = true;
    back(`Slide ${b.index + 1}`, `You removed the slide that was slide ${b.index + 1}. Slide changes are not carried over.`, "", [`s${sid(b)}`]);
  }
  const order = (d) => d.slides.map(sid).filter((x) => inBase.has(x) && inMine.has(x)).join(" ");
  if (order(base) !== order(mine)) {
    slidesSaid = true;
    back("Slides", "You moved slides. Slide changes are not carried over.", "", ["order"]);
  }
  if (said.slides && !slidesSaid) back("Slides", "You changed slides (hidden, background or order). Slide changes are not carried over.");

  for (const m of mine.slides) {
    const b = inBase.get(sid(m));
    if (!b) continue;
    const t = inTheirs.get(sid(m));
    const n = m.index + 1;
    // a shape is its id; where two shapes of a slide share one, the id means the same shape only while the shape list is unchanged
    const sure = (![b, m, t].some((sl) => sl && twins(sl))) || (keys(b) === keys(m) && (!t || keys(b) === keys(t)));
    if (!sure) {
      const had = new Set(b.shapes.map((x) => x.text));
      const mineOnly = m.shapes.filter((x) => x.text && !had.has(x.text)).map((x) => x.text);
      if (mineOnly.length || keys(b) !== keys(m)) whole(`Slide ${n}`, `Shapes on slide ${n} share an id and shapes were added or removed there, so your edits could not be matched to the agent's version.${mineOnly.length ? " These are yours." : ""}`, mineOnly.join("\n\n"), [`s${sid(m)}`]);
      continue;
    }
    const wasBy = new Map(b.shapes.map((x) => [key(x), x]));
    const nowBy = new Map((t?.shapes || []).map((x) => [key(x), x]));
    const mineKeys = new Set(m.shapes.map(key));
    for (const old of b.shapes) if (!mineKeys.has(key(old))) back(`Slide ${n}`, `You removed ${nameOf(b, old)}. Shape changes are not carried over.`, "", [shapeRef(b, old)]);
    // what the page may not have named: shapes put in another order (front to back), and text formatting changed in a shape whose text
    // did not change (in one whose text changed, the text's own line names the shape)
    const inOrder = (sl) => sl.shapes.map(key).filter((k) => wasBy.has(k) && mineKeys.has(k)).join(" ");
    if (inOrder(b) !== inOrder(m)) back(`Slide ${n}`, `You put shapes on slide ${n} in another order. Shape changes are not carried over.`, "", m.shapes.map((x) => shapeRef(m, x)));
    if (!said.format.has(m.index)) for (const sh of m.shapes) if (wasBy.get(key(sh))?.text === sh.text && JSON.stringify(wasBy.get(key(sh)).fmt) !== JSON.stringify(sh.fmt)) back(`Slide ${n}`, `You changed text formatting in ${nameOf(m, sh)}. Formatting is not carried over.`, "", [shapeRef(m, sh)]);
    for (const sh of m.shapes) {
      const old = wasBy.get(key(sh));
      const label = untrusted(`Slide ${n}, ${sh.isTitle ? "Title" : sh.name ? sh.name : `shape ${sh.id}`}`, 100);
      if (!old) {
        whole(label, `You added ${nameOf(m, sh)}. Shape changes are not carried over.${sh.text ? " This is its text." : ""}`, sh.text, [shapeRef(m, sh)]);
        continue;
      }
      if (old.text === sh.text) continue;
      const now = nowBy.get(key(sh));
      if (!t) back(label, `The agent removed slide ${n}, so your edit to ${nameOf(m, sh)} was not carried over. This is yours.`, sh.text, [shapeRef(m, sh)]);
      else if (!now) back(label, `The agent removed ${nameOf(m, sh)}, so your edit was not carried over. This is yours.`, sh.text, [shapeRef(m, sh)]);
      else if (now.text === sh.text) continue; // the agent wrote the same text
      else if (now.text !== old.text) back(label, `The agent changed ${nameOf(t, now)} too. Its text is on the slide; this is yours.`, sh.text, [shapeRef(m, sh)]);
      else if (sh.kind !== "shape") back(label, `You changed ${nameOf(m, sh)}, which is not a plain text box (a table or a group). That is not carried over. This is yours.`, sh.text, [shapeRef(m, sh)]);
      else {
        const ops = shapeOps({ slide_id: sid(m), shape_id: sh.id }, old, sh.text, work);
        const lines = old.text.split("\n").length === sh.text.split("\n").length;
        if (ops[0].op === "set_shape_text" && mixed(now)) back(label, lines ? `You changed many lines in ${nameOf(m, sh)}, whose text mixes formats. They are carried over only as the whole text, which would lose the formats. This is yours.` : `You added or removed lines in ${nameOf(m, sh)}, whose text mixes formats. That cannot be carried over without losing them. This is yours.`, sh.text, [shapeRef(m, sh)]);
        else items.push({ label, of: [shapeRef(m, sh)], text: cut(sh.text), name: nameOf(t, now), slide: sid(m), key: key(sh), want: sh.text, look: JSON.stringify(old.fmt) !== JSON.stringify(sh.fmt) ? JSON.stringify(sh.fmt) : null, ops });
      }
    }
  }
  const where = (slide) => (slide == null ? "" : ` on slide ${slide + 1}`);
  const slideRef = (slide) => (slide != null && mine.slides[slide] ? [`s${sid(mine.slides[slide])}`] : []);
  for (const slide of said.format) back("Formatting", `You changed text formatting${where(slide)}. Formatting is not carried over.`, "", slideRef(slide));
  for (const slide of said.shapes) whole("Shapes", `You added, removed, moved or restyled shapes${where(slide)}. Shape changes are not carried over.`, "", slideRef(slide));
  if (said.other) whole("Other changes", "You made a change that is not text. It is not carried over.");
  return { items, unplaced, copy };
}

/** What the result must be: the agent's deck, with nothing different except the carried shapes, each reading as the user's. */
function verify(theirs, out, applied) {
  out.ensure();
  const bad = new Set();
  if (theirs.slides.map(sid).join(" ") !== out.slides.map(sid).join(" ")) return { foreign: true, bad };
  const carried = new Map(applied.map((it) => [`${it.slide} ${it.key}`, it]));
  for (const [i, sl] of theirs.slides.entries()) {
    const o = out.slides[i];
    if (keys(sl) !== keys(o)) return { foreign: true, bad };
    for (const [j, sh] of sl.shapes.entries()) {
      const it = carried.get(`${sid(sl)} ${key(sh)}`);
      if (it) {
        if (o.shapes[j].text !== it.want) bad.add(it);
      } else if (o.shapes[j].text !== sh.text || JSON.stringify(o.shapes[j].fmt) !== JSON.stringify(sh.fmt)) return { foreign: true, bad };
    }
  }
  return { foreign: false, bad };
}

/**
 * Runs the plan on the agent's bytes. `runOps` is injected (src/ops/run.js). Returns {bytes: Buffer|null, merged, unplaced, copy}.
 * The proof is the result: bytes are returned only when the saved deck is the agent's deck plus exactly the carried shapes. A shape
 * whose text did not land as the user had it is taken out and the rest is run again from the agent's bytes (once), so it is never
 * written.
 */
export async function mergePptx({ base, mine, theirs, name, runOps, edits = [] }) {
  // a turn of the event loop between the readings and the plan, so a large deck is never read three times in one stretch
  const T = parseDeck(theirs);
  T.ensure();
  await turn();
  const B = parseDeck(base);
  B.ensure();
  await turn();
  const M = parseDeck(mine);
  M.ensure();
  await turn();
  const plan = planPptxMerge(B, M, T, edits);
  await turn();
  const unplaced = [...plan.unplaced];
  const fail = (it, why) => unplaced.push({ label: it.label, text: it.text, why, of: it.of });
  const end = (bytes, merged) => ({ bytes, merged, unplaced, copy: plan.copy, read: { base: B, mine: M, theirs: T } }); // `read`: for the proof
  let items = plan.items;
  for (let pass = 0; pass < 2 && items.length; pass++) {
    const owner = items.flatMap((it) => it.ops.map(() => it));
    const { results, bytes, blocked } = await runOps({ bytes: theirs, format: "pptx", name, ops: items.flatMap((it) => it.ops), partial: true });
    // each item's op results, gathered once (a map over every op for each item was quadratic: 10,000 shapes held the thread for 1.3 s)
    const statuses = new Map(items.map((it) => [it, []]));
    owner.forEach((it, n) => results[n]?.status && statuses.get(it).push(results[n].status));
    const status = (it) => statuses.get(it);
    const notPlaced = (it) => (status(it).includes("skipped_protected") ? `Your edit to ${it.name} was not carried over: the text box holds content that cannot be rewritten safely (a field or an equation). This is yours.` : `Your edit to ${it.name} could not be placed on the agent's version. This is yours.`);
    if (!bytes) {
      for (const it of items) fail(it, blocked ? "Carrying your edits over would have damaged the file, so none were applied." : notPlaced(it));
      return end(null, 0);
    }
    const applied = items.filter((it) => status(it).every((x) => x === "applied"));
    const isApplied = new Set(applied);
    // a shape with one op applied and another not reads as neither version: these bytes are not written, the rest is run again
    const half = items.some((it) => !isApplied.has(it) && status(it).includes("applied"));
    if (!half) await turn();
    const { foreign, bad } = half ? { foreign: false, bad: new Set() } : verify(T, parseDeck(bytes), applied);
    if (foreign) break;
    for (const it of items) {
      if (!isApplied.has(it)) fail(it, notPlaced(it));
      else if (bad.has(it)) fail(it, `Your edit to ${it.name} did not land as typed, so the agent's version was kept there. This is yours.`);
    }
    if (!bad.size && !half) {
      // text the person also formatted differently: the text is carried, its look is not (only text is), and that is said
      const looks = applied.filter((it) => it.look !== null);
      if (looks.length) {
        const out = parseDeck(bytes);
        out.ensure();
        const at = new Map(out.slides.map((sl) => [sid(sl), new Map(sl.shapes.map((x) => [key(x), x]))]));
        for (const it of looks) if (JSON.stringify(at.get(it.slide)?.get(it.key)?.fmt) !== it.look) unplaced.push({ label: it.label, text: "", why: `Your text in ${it.name} was carried over, but not the formatting you changed in it: set it again.`, of: it.of, check: true });
      }
      return end(bytes, applied.length);
    }
    items = applied.filter((it) => !bad.has(it));
  }
  for (const it of items) fail(it, "Carrying your edits over would have changed the agent's text, so none were applied.");
  return end(null, 0);
}
