import { fmtNote } from "./fmt.js";
import { docxFmt, lcsPairs, matchParagraphs } from "./history.js";
import { readDocxParagraphs } from "./docx.js";
import { normText } from "./text.js";

// What the user did while the agent worked, carried onto the agent's version. Three versions of one DOCX: `base` (what the page
// loaded: the file as sent), `mine` (base plus the user's edits, saved by the page) and `theirs` (the file on disk after the agent).
// A paragraph only the user changed becomes an op on `theirs`, run through the same engine, expect check and package check as an
// agent's `apply`. A paragraph both sides changed is never guessed at: the agent's text stays and the user's text is handed back
// (`unplaced`), so nothing typed is lost without a word.
// Formatting the user changed without changing the text (run properties by character, and the paragraph's style, alignment and
// list) is set on the agent's paragraph when the agent left that formatting alone; on a paragraph the agent rewrote only the
// paragraph's own style, alignment and list are set. A body paragraph the user moved is moved in the agent's version when the
// agent left it alone and the paragraph next to its new place is still there. Each of these is proven on the result before it is
// kept: if one did not come out as planned, the merge runs again without any of them and says so.
// Ceilings: pictures and anything outside paragraphs are not carried. Not carried and reported: formatting of a kind the engine
// cannot set (character style, theme color, shading, spacing, indent), moves inside tables, a moved paragraph that ends a section or
// holds one end of a comment or bookmark, and formatting changed on a paragraph the user also moved (the agent's paragraph is moved
// as it is; the report names what the user changed inside it when that is certain, and asks to check the formatting whenever the user's copy
// reads differently, which every cut and paste in the editor does). Not carried and not reported: run formatting changed in a
// paragraph whose text the user also changed, the formatting of a paragraph the user added (it takes its neighbor's), and a move
// of a paragraph the user also edited (its text is carried in the old place). A paragraph the user split keeps its run formatting
// only in the part before the first changed character.

const CAP = 2000;
const cut = (t) => String(t ?? "").slice(0, CAP);
const label = (p) => {
  const t = normText(p.text);
  return t ? `"${t.split(" ").slice(0, 8).join(" ")}${t.split(" ").length > 8 ? "..." : ""}"` : "an empty paragraph";
};

/**
 * The smallest `find` / `replace` that turns `before` into `after` and occurs exactly once in `before` (so run formatting around it
 * is kept), or null when there is none within the op's limits (then the whole paragraph text is set).
 */
export function minimalReplace(before, after) {
  let p = 0;
  const max = Math.min(before.length, after.length);
  while (p < max && before[p] === after[p]) p++;
  let s = 0;
  while (s < max - p && before[before.length - 1 - s] === after[after.length - 1 - s]) s++;
  let a = p;
  let b = before.length - s; // [a, b) of `before` is replaced
  const count = (needle) => {
    let n = 0;
    for (let i = before.indexOf(needle); i >= 0; i = before.indexOf(needle, i + 1)) n++;
    return n;
  };
  // widen (left first, then right) until the find text is not empty and occurs once
  while ((b === a || count(before.slice(a, b)) !== 1) && (a > 0 || b < before.length)) {
    if (a > 0) a--;
    else b++;
    if (b - a > CAP) return null;
  }
  if (b === a) return null; // an empty paragraph has nothing to find
  const find = before.slice(a, b);
  const replace = before.slice(a, p) + after.slice(p, after.length - s) + before.slice(before.length - s, b);
  return find.length <= CAP && replace.length <= 20000 ? { find, replace } : null;
}

const RUN_WORDS = { b: "bold", i: "italic", u: "underline", strike: "strikethrough", color: "color", sz: "size", font: "font", hl: "highlight", va: "superscript or subscript" };
const ALIGN = { "": "", left: "left", center: "center", right: "right", both: "justify" }; // w:jc as written -> what the engine sets
const list = (words) => (words.length > 1 ? `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}` : words[0] || "");
const listSig = (p) => (p.list ? `${p.list.kind === "other" ? `other ${p.list.numId}` : p.list.kind} ${p.list.ilvl}` : "");
const sameList = (a, b) => (a.list?.numId || "") === (b.list?.numId || "") && (a.list?.ilvl || 0) === (b.list?.ilvl || 0);
const styleKey = (v) => normText(v || "normal").toLowerCase();

/**
 * Run formatting of `from` -> `to`, two readings of the same text (`spans` of readDocxParagraphs with detail), by character:
 * {ranges: [{start, end, set}], other}. `set` holds the properties that differ, with the value in `to` (null = not set there): the
 * patch the engine applies. `other` says a property that can only be compared differs somewhere; such a stretch gets no patch.
 * Ranges are maximal, so equal differences give equal results. null when a side is unreadable or the lengths differ.
 */
export function runPatches(from, to) {
  const total = (spans) => spans.reduce((n, x) => n + x.n, 0);
  if (!from || !to || total(from) !== total(to)) return null;
  const ranges = [];
  let other = false;
  let x = 0;
  let y = 0;
  let xe = from[0]?.n ?? 0;
  let ye = to[0]?.n ?? 0;
  for (let at = 0, n = total(from); at < n; ) {
    const end = Math.min(xe, ye);
    if (from[x].rest !== to[y].rest) other = true;
    else {
      const set = {};
      for (const k of Object.keys(RUN_WORDS)) if (from[x].set[k] !== to[y].set[k]) set[k] = to[y].set[k] ?? null;
      const key = JSON.stringify(set);
      const last = ranges[ranges.length - 1];
      if (last && last.end === at && last.key === key) last.end = end;
      else if (key !== "{}") ranges.push({ start: at, end, set, key });
    }
    at = end;
    if (at === xe && ++x < from.length) xe += from[x].n;
    if (at === ye && ++y < to.length) ye += to[y].n;
  }
  return { ranges: ranges.map(({ key, ...r }) => r), other };
}

/**
 * Run properties whose value changes inside `to` at a place where `from` has one look on both sides: a difference between
 * stretches of one paragraph that nothing but a change made there explains (a paste writes the look out on every run, but
 * evenly). `from` and `to` are two readings of the same text; [] when one is unreadable.
 */
function newBreaks(from, to) {
  const keys = new Set();
  const total = (spans) => spans.reduce((n, x) => n + x.n, 0);
  if (!from || !to || total(from) !== total(to)) return [];
  let x = 0;
  let xe = from[0]?.n ?? 0;
  let at = 0;
  for (let y = 0; y < to.length - 1; y++) {
    at += to[y].n; // the place where to[y] ends and to[y + 1] starts
    while (x < from.length - 1 && xe < at) xe += from[++x].n;
    const next = xe === at && x < from.length - 1 ? from[x + 1] : from[x];
    if (from[x].rest !== next.rest) continue;
    for (const k of Object.keys(RUN_WORDS)) if (to[y].set[k] !== to[y + 1].set[k] && from[x].set[k] === next.set[k]) keys.add(k);
  }
  return Object.keys(RUN_WORDS).filter((k) => keys.has(k));
}

/** The paragraph's own formatting, `from` -> `to`: {set} is what the engine can set (style, align, list, ilvl), {no} names what it cannot. */
function paraPatch(from, to) {
  const set = {};
  const no = [];
  if ((from.style || "") !== (to.style || "")) set.style = to.style ? to.styleName || to.style : null; // null: back to the default style
  if (from.align !== to.align) to.align in ALIGN ? (set.align = ALIGN[to.align]) : no.push("this kind of alignment");
  if (listSig(from) !== listSig(to)) {
    if (!to.list) set.list = "none";
    else if (to.list.kind === "other") no.push("this kind of list");
    else if (from.list?.kind === to.list.kind) set.ilvl = to.list.ilvl;
    else (set.list = to.list.kind), (set.ilvl = to.list.ilvl);
  }
  if (from.ppr !== to.ppr) no.push("spacing, indent and other paragraph settings");
  return { set, no };
}

/**
 * Plans the merge. Arguments are paragraph lists (readDocxParagraphs with detail). Returns
 * {items: [{kind, label, text, t, op, ...}], unplaced: [{label, text, why}]}: every item is tried on `theirs`. `t` is the index in
 * `theirs` of the paragraph the op names (for a new paragraph: its anchor); a moved paragraph also has `to`, its new neighbor, and
 * a `note` (with `check`, see `lost`) when its formatting in `mine` is not the original's.
 */
export function planDocxMerge(base, mine, theirs) {
  const { mapA: baseToMine, mapB: mineToBase, moved } = matchParagraphs(base, mine);
  // a base paragraph the agent left alone, by position: the same text in the same order
  const { mapA: baseToTheirs } = lcsPairs(base.map((p) => p.hash), theirs.map((p) => p.hash));
  const agent = matchParagraphs(base, theirs); // where the agent's other paragraphs came from: an edited one, one it moved
  const at = (i) => (theirs[baseToTheirs[i]]?.path ? baseToTheirs[i] : -1);
  const locator = (n) => ({ body_path: theirs[n].path, text_hash: theirs[n].hash });
  const theirsHas = new Set(theirs.map((p) => p.hash));
  const items = [];
  const unplaced = [];
  const no = (p, why, text = p.text) => unplaced.push({ label: label(p), text: cut(text), why });

  // The agent's version of a base paragraph whose text it changed, only when there is no doubt which one it is: the same unique
  // paragraph id, or the one paragraph between the same two untouched neighbors.
  const ids = (L) => L.reduce((m, p) => (p.paraId ? m.set(p.paraId, (m.get(p.paraId) || 0) + 1) : m), new Map());
  let idCount = null;
  const rewritten = (i) => {
    const n = agent.mapA[i];
    if (n < 0 || baseToTheirs[i] >= 0 || agent.moved.has(n) || !theirs[n].path) return -1;
    idCount ||= [ids(base), ids(theirs)];
    const id = base[i].paraId;
    if (id && theirs[n].paraId === id && idCount[0].get(id) === 1 && idCount[1].get(id) === 1) return n;
    const before = i === 0 ? n === 0 : baseToTheirs[i - 1] >= 0 && baseToTheirs[i - 1] === n - 1;
    const after = i === base.length - 1 ? n === theirs.length - 1 : baseToTheirs[i + 1] >= 0 && baseToTheirs[i + 1] === n + 1;
    return before && after ? n : -1;
  };

  /**
   * Formatting the user changed on a paragraph (`b` in base, `m` in mine). `typed`: the user changed its text too, so only the
   * paragraph's own formatting can be told apart from the typing.
   */
  const format = (b, m, i, typed) => {
    const para = paraPatch(b, m);
    const exact = !typed && b.text === m.text ? runPatches(b.spans, m.spans) : null;
    const words = exact ? [...new Set(exact.ranges.flatMap((r) => Object.keys(r.set)))].map((k) => RUN_WORDS[k]) : [];
    // the texts differ in white space only, or a run could not be read: the summary History uses still says that something changed
    const vague = !typed && !exact ? fmtNote({ props: b.fmt }, { props: m.fmt }) : null;
    const cannot = [...para.no, ...(exact?.other ? ["character styles and text effects"] : [])];
    if (!Object.keys(para.set).length && !words.length && !vague && !cannot.length) return;
    const kept = at(i);
    const n = kept >= 0 ? kept : typed ? -1 : rewritten(i);
    const mineWords = [...("style" in para.set ? ["style"] : []), ...("align" in para.set ? ["alignment"] : []), ...("list" in para.set || "ilvl" in para.set ? ["list"] : []), ...words];
    if (n < 0) {
      if (typed) return; // the text was handed back with its own reason
      return no(m, `You changed formatting here${mineWords.length ? ` (${list(mineWords)})` : ""}, but the agent changed, moved or removed this paragraph, so it was not carried over.`, "");
    }
    const a = theirs[n];
    const carry = {};
    const done = [];
    const clash = [];
    const notes = [];
    if ("style" in para.set) (a.style || "") === (b.style || "") ? ((carry.style = para.set.style), done.push("style")) : clash.push("style");
    if ("align" in para.set) a.align === b.align ? ((carry.align = para.set.align), done.push("alignment")) : clash.push("alignment");
    if ("list" in para.set || "ilvl" in para.set) {
      if (sameList(a, b)) (Object.assign(carry, "list" in para.set ? { list: para.set.list } : {}, "ilvl" in para.set ? { ilvl: para.set.ilvl } : {}), done.push("list"));
      else clash.push("list");
    }
    if (clash.length) notes.push(`The agent changed the ${list(clash)} here too, so yours was not carried over.`);
    let runs = [];
    if (words.length) {
      const same = kept >= 0 && a.text === b.text ? runPatches(b.spans, a.spans) : null;
      if (kept < 0) notes.push(`The agent rewrote this paragraph, so the ${list(words)} you changed inside it was not carried over.`);
      else if (same && !same.ranges.length && !same.other) ((runs = exact.ranges), done.push(...words));
      else notes.push(`The agent changed formatting inside this paragraph too, so the ${list(words)} you changed was not carried over.`);
    } else if (vague) notes.push(`Formatting inside this paragraph is different in your version (${vague}). It could not be carried over.`);
    if (cannot.length) notes.push(`Changes to ${list(cannot)} are not carried over.`);
    if (!done.length) return no(m, notes.join(" "), "");
    items.push({ kind: "format", label: label(m), text: "", hash: null, t: n, words: done, note: notes.join(" "), op: { op: "format_paragraph", target: locator(n), expect: { text_hash: a.hash }, ...(Object.keys(carry).length ? { para: carry } : {}), ...(runs.length ? { runs } : {}) } });
  };

  /**
   * What to say about the formatting of a paragraph the user moved (`b` in base, `m` in mine) when the move is carried: {note,
   * check}, or {} when the copy reads as the original does. Certain (named): a look that differs between stretches of the copy
   * where the original has one. Anything else that differs may be the paste or may be the user's (a heading picked, a list, or the
   * whole paragraph made bold): `check` marks the line as a request to look, not a loss. The named line says the same about the
   * rest of the paragraph's formatting, since a named word can hide a heading picked before the cut.
   */
  const lost = (b, m) => {
    const para = paraPatch(b, m);
    const exact = b.text === m.text ? runPatches(b.spans, m.spans) : null;
    const sure = newBreaks(b.spans, m.spans).map((k) => RUN_WORDS[k]);
    if (sure.length) return { note: `The ${list(sure)} you changed inside this paragraph was not: the paragraph has the formatting of the agent's version.` };
    if (!Object.keys(para.set).length && !para.no.length && exact && !exact.ranges.length && !exact.other) return {};
    return { note: "This paragraph has the formatting of the agent's version: if you changed its formatting too, set it again.", check: true };
  };

  // anchors for new paragraphs: the nearest paragraph before (else after) that the agent left alone. The user may have edited it
  // (a split leaves the first half as an edit of the original): every op is bound to the agent's file before any op runs.
  const still = (j) => mineToBase[j] >= 0 && !moved.has(j); // a paragraph of the base that is where it was
  const anchorOf = (j) => (still(j) ? at(mineToBase[j]) : -1);
  const inserts = []; // {where: "after"|"before", to: index in theirs, m, move?: index in theirs of the paragraph to move}

  /**
   * A paragraph the user moved: the agent's paragraph is moved as it is, placed by the paragraph right before it in the user's
   * version (else the one right after), which the agent must have left alone. The formatting of the user's copy is never set: a
   * paragraph that was cut and pasted comes back without its style, alignment and list and with its look written out on every run
   * (seen in the real editor), so setting it would take the heading or the bullet off the agent's paragraph. It is read for the
   * report only (`lost`).
   */
  const move = (m, j, i) => {
    const n = baseToTheirs[i];
    const more = lost(base[i], m);
    const t = theirs[n];
    const say = (why) => void no(m, why, "");
    if (!t) return say(agent.moved.has(agent.mapA[i]) ? "You moved this paragraph and so did the agent. It is where the agent put it." : "You moved this paragraph, but the agent changed or removed it, so the move was not carried over.");
    if (t.path?.length !== 1 || m.path?.length !== 1) return say("You moved this paragraph in or out of a table. Moves that involve tables are not carried over.");
    if (t.sect) return say("You moved this paragraph, but it ends a section of the document, so the move was not carried over.");
    if (t.loose) return say("You moved this paragraph, but a comment or bookmark starts or ends inside it, so the move was not carried over.");
    const body = (k) => (k >= 0 && k < mine.length && anchorOf(k) >= 0 && theirs[anchorOf(k)].path.length === 1 ? anchorOf(k) : -1);
    let k = j - 1;
    while (k >= 0 && !still(k)) k--;
    if (body(k) >= 0) return void inserts.push({ where: "after", to: body(k), m, move: n, ...more });
    k = j + 1;
    while (k < mine.length && !still(k)) k++;
    if (body(k) >= 0) return void inserts.push({ where: "before", to: body(k), m, move: n, ...more });
    say("You moved this paragraph, but the agent changed the paragraphs next to its new place, so the move was not carried over.");
  };

  mine.forEach((m, j) => {
    const i = mineToBase[j];
    if (i >= 0) {
      const b = base[i];
      if (moved.has(j)) return move(m, j, i); // the same text in another place
      if (b.hash === m.hash) return normText(m.text) ? format(b, m, i, false) : undefined;
      const t = at(i);
      if (t < 0 && theirsHas.has(m.hash)) return; // the same text is already there (an earlier pass carried it)
      if (t < 0) return no(m, "The agent changed this paragraph too. Its version is in the document; this is yours.");
      const r = minimalReplace(b.text, m.text);
      const op = { op: "replace_text", target: locator(t), expect: { text_hash: b.hash }, ...(r ? r : { text: m.text }) };
      items.push({ kind: "changed", label: label(m), text: cut(m.text), hash: m.hash, t, op });
      return format(b, m, i, true);
    }
    if (!normText(m.text)) return; // an empty line that was added: nothing to lose
    let k = j - 1;
    while (k >= 0 && anchorOf(k) < 0) k--;
    if (k >= 0) return inserts.push({ where: "after", to: anchorOf(k), m });
    k = j + 1;
    while (k < mine.length && anchorOf(k) < 0) k++;
    if (k < mine.length) return inserts.push({ where: "before", to: anchorOf(k), m });
    no(m, "There was no unchanged paragraph near this new one to place it by.");
  });
  // several new or moved paragraphs after one anchor: each lands right after the anchor, so the last goes first
  for (const x of inserts.filter((x) => x.where === "after").reverse().concat(inserts.filter((x) => x.where === "before"))) {
    const to = locator(x.to);
    if (x.move === undefined) items.push({ kind: "added", label: label(x.m), text: cut(x.m.text), hash: x.m.hash, t: x.to, where: x.where, op: { op: x.where === "after" ? "insert_paragraph_after" : "insert_paragraph_before", target: to, expect: { text_hash: to.text_hash }, text: x.m.text } });
    else items.push({ kind: "moved", label: label(x.m), text: "", hash: x.m.hash, t: x.move, to: x.to, where: x.where, ...(x.note ? { note: x.note, check: x.check } : {}), op: { op: "move_paragraph", target: locator(x.move), expect: { text_hash: x.m.hash }, to, where: x.where } });
  }
  base.forEach((b, i) => {
    if (baseToMine[i] >= 0 || !normText(b.text)) return;
    const t = at(i);
    if (t >= 0) items.push({ kind: "removed", label: label(b), text: "", hash: null, t, op: { op: "delete_paragraph", target: locator(t), expect: { text_hash: b.hash } } });
    else no(b, "You deleted this paragraph, but the agent changed it, so it was kept.", "");
  });
  // replacements first, then formatting, then new and moved paragraphs, then deletions (an anchor is never a paragraph this plan deletes)
  const order = { changed: 0, format: 1, added: 2, moved: 2, removed: 3 };
  items.sort((x, y) => order[x.kind] - order[y.kind]);
  return { items, unplaced };
}

const SOFT = new Set(["format", "moved"]); // carried only when the result proves them; the merge can always do without
const PROTECTED = "a protected paragraph (it holds a field, a content control or something else that cannot be rewritten safely)";
/** Why one item is not in the document, in words for the user. `r` is the op's result when it ran. */
function reason(it, r) {
  const prot = r?.status === "skipped_protected";
  if (it.kind === "moved") return prot ? `You moved this paragraph, but it or the paragraph next to its new place is ${PROTECTED}, so the move was not carried over.` : "You moved this paragraph, but the move could not be made on the agent's version.";
  if (it.kind === "format") return `${prot ? `This is ${PROTECTED}, so the ${list(it.words)} you changed here was not carried over.` : `The ${list(it.words)} you changed here could not be set on the agent's version.`}${it.note ? ` ${it.note}` : ""}`;
  return "This edit could not be placed on the agent's version.";
}

/** The order of paragraphs (as text hashes, with the index in `theirs` each came from) the applied ops must give. */
function expected(theirs, items, results) {
  const seq = theirs.map((p, n) => ({ n, hash: p.hash }));
  const find = (n) => seq.findIndex((x) => x.n === n);
  items.forEach((it, k) => {
    if (results[k]?.status !== "applied") return;
    const i = find(it.t);
    if (i < 0) return;
    if (it.kind === "changed") seq[i] = { n: it.t, hash: it.hash };
    else if (it.kind === "removed") seq.splice(i, 1);
    else if (it.kind === "added") seq.splice(it.where === "after" ? i + 1 : i, 0, { n: -1, hash: it.hash });
    else if (it.kind === "moved") {
      const [x] = seq.splice(i, 1);
      const to = find(it.to);
      seq.splice(it.where === "after" ? to + 1 : to, 0, x);
    }
  });
  return seq;
}

/** Is the paragraph `o` of the result the agent's paragraph `t` with exactly the formatting this item set, and nothing else different? */
function formatted(it, t, o) {
  const para = it.op.para || {};
  if ("style" in para ? styleKey(o.styleName || o.style) !== styleKey(para.style) : (o.style || "") !== (t.style || "")) return false;
  if ("align" in para ? ALIGN[o.align] !== para.align : o.align !== t.align) return false;
  if ("list" in para ? (para.list === "none" ? !!o.list : o.list?.kind !== para.list || o.list.ilvl !== (para.ilvl ?? 0)) : "ilvl" in para ? o.list?.numId !== t.list?.numId || o.list?.ilvl !== para.ilvl : !sameList(o, t)) return false;
  if (o.ppr !== t.ppr) return false;
  if (o.text !== t.text) return !it.op.runs; // the user's typing went into this paragraph as well: only its own properties were set
  const got = runPatches(t.spans, o.spans);
  return !!got && !got.other && JSON.stringify(got.ranges) === JSON.stringify(it.op.runs || []);
}

/**
 * Runs the plan on the agent's bytes. `runOps` is injected (src/ops/run.js) so this file stays free of the engine. Returns
 * {bytes: Buffer|null, merged, unplaced}. Whatever did not apply, or is not found in the result afterwards, is in `unplaced`;
 * so is a line for an edit that was carried only in part. `check: true` on a line: the edit is in the document and the line asks
 * the user to look at something that may or may not be theirs.
 */
export async function mergeDocx({ base, mine, theirs, name, runOps }) {
  const read = (bytes) => readDocxParagraphs(bytes, { detail: true });
  const agents = read(theirs);
  const plan = planDocxMerge(read(base), read(mine), agents);
  const unplaced = [...plan.unplaced];
  if (!plan.items.length) return { bytes: null, merged: 0, unplaced };
  let r = await attempt(plan.items, { theirs, agents, name, runOps, read });
  if (r.redo) {
    // a move or a formatting change did not come out as planned: nothing unproven is written, the rest is carried without them
    for (const it of plan.items.filter((x) => SOFT.has(x.kind))) unplaced.push({ label: it.label, text: "", why: reason(it) });
    const rest = plan.items.filter((x) => !SOFT.has(x.kind));
    r = rest.length ? await attempt(rest, { theirs, agents, name, runOps, read }) : { bytes: null, merged: 0, unplaced: [] };
  }
  return { bytes: r.bytes, merged: r.merged, unplaced: [...unplaced, ...r.unplaced] };
}

/** One run of `items` on the agent's bytes, checked on the result. {redo: true} asks for a run without moves and formatting. */
async function attempt(items, { theirs, agents, name, runOps, read }) {
  const unplaced = [];
  const soft = items.some((x) => SOFT.has(x.kind));
  const { results, bytes, blocked } = await runOps({ bytes: theirs, format: "docx", name, ops: items.map((x) => x.op), partial: true });
  const fail = (it, why) => unplaced.push({ label: it.label, text: it.text, why });
  if (!bytes) {
    if (blocked && soft) return { redo: true };
    for (const [n, it] of items.entries()) fail(it, blocked ? "Carrying your edits over would have damaged the file, so none were applied." : reason(it, results[n]));
    return { bytes: null, merged: 0, unplaced };
  }
  // the proof is the result, not the report. First: nothing of the agent's version is gone except what an op named.
  const out = read(bytes);
  const count = (list) => list.reduce((m, h) => m.set(h, (m.get(h) || 0) + 1), new Map());
  const named = count(items.filter((x, n) => (x.kind === "changed" || x.kind === "removed") && results[n]?.status === "applied").map((x) => x.op.expect.text_hash));
  const after = count(out.map((p) => p.hash));
  for (const [h, n] of count(agents.map((p) => p.hash))) {
    if ((after.get(h) || 0) + (named.get(h) || 0) < n) {
      if (soft) return { redo: true };
      for (const it of items) fail(it, "Carrying your edits over would have changed the agent's text, so none were applied.");
      return { bytes: null, merged: 0, unplaced };
    }
  }
  // then, for moves and formatting: every paragraph is where the applied ops put it, and each formatted one differs from the
  // agent's by exactly what was set
  if (items.some((x, n) => SOFT.has(x.kind) && results[n]?.status === "applied")) {
    const seq = expected(agents, items, results);
    if (seq.length !== out.length || seq.some((x, k) => x.hash !== out[k].hash)) return { redo: true };
    const where = new Map(seq.map((x, k) => [x.n, k]));
    if (items.some((it, n) => it.kind === "format" && results[n]?.status === "applied" && !formatted(it, agents[it.t], out[where.get(it.t)]))) return { redo: true };
  }
  // then: every carried text is in the merged file
  const have = new Set(out.map((p) => p.hash));
  let merged = 0;
  items.forEach((it, n) => {
    if (results[n]?.status !== "applied") return fail(it, reason(it, results[n]));
    if (it.hash && !have.has(it.hash)) return fail(it, "This edit did not land as typed.");
    merged++;
    if (it.note && it.kind === "moved") unplaced.push({ label: it.label, text: "", why: `Your move was carried over. ${it.note}`, ...(it.check ? { check: true } : {}) });
    else if (it.note) fail(it, `Your ${list(it.words)} change was carried over. ${it.note}`);
  });
  return { bytes, merged, unplaced };
}
