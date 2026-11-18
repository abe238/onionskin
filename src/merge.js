import { fmtNote } from "./fmt.js";
import { docxFmt, lcsPairs, matchParagraphs, paraIdentity } from "./history.js";
import { readDocxParagraphs } from "./docx.js";
import { normText } from "./text.js";

// What the user did while the agent worked, carried onto the agent's version. Three versions of one DOCX: `base` (what the page
// loaded: the file as sent), `mine` (base plus the user's edits, saved by the page) and `theirs` (the file on disk after the agent).
// A paragraph only the user changed becomes an op on `theirs`, run through the same engine, expect check and package check as an
// agent's `apply`. Text is compared as written: a line break, a tab or a second space is an edit. A paragraph both sides changed is
// never guessed at: the agent's text stays and the user's text is handed back (`unplaced`), so nothing typed is lost without a word.
// Formatting the user changed without changing the text (run properties by character, and the paragraph's style, alignment and
// list) is set on the agent's paragraph when the agent left that formatting alone; on a paragraph the agent rewrote only the
// paragraph's own style, alignment and list are set. A body paragraph the user moved (edited or not) is moved in the agent's version
// when the agent left it alone, moved no paragraph itself, and the paragraph next to its new place is still there. Each of these is
// proven on the result before it is kept: if one did not come out as planned, the merge runs again without any of them and says so.
// Then the proof of the merge (src/merge-proof.js, in src/merge-worker.js) checks the result on its own: every entry of `unplaced` names
// what it stands for (`of`), and a result that does not account for every edit is not returned.
// Ceilings: pictures and anything outside paragraphs are not carried. Not carried and reported: formatting of a kind the engine
// cannot set (character style, theme color, shading, spacing, indent), moves inside tables, a moved paragraph that ends a section or
// holds one end of a comment or bookmark, a move while the agent moved paragraphs too, and formatting changed on a paragraph the user
// also moved (the agent's paragraph is moved as it is; the report names what the user changed inside it when that is certain, and asks
// to check the formatting whenever the user's copy reads differently, which every cut and paste in the editor does). Carried, with a
// line asking to check: the text of a paragraph the user added whose formatting the result does not have (the engine gives it the
// paragraph formatting of its neighbor), and text typed into a paragraph whose formatting inside then differs from the user's. A
// paragraph the user split keeps its run formatting only in the part before the first changed character.

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
export function minimalReplace(before, after, shared = null) {
  let p = 0;
  const max = Math.min(before.length, after.length);
  while (p < max && before[p] === after[p]) p++;
  let s = 0;
  while (s < max - p && before[before.length - 1 - s] === after[after.length - 1 - s]) s++;
  let a = p;
  let b = before.length - s; // [a, b) of `before` is replaced
  // only uniqueness matters: stop at the second match (counting every overlapping match of each widening was quadratic: a run of
  // 20,000 "a" with one letter typed in the middle held the server's thread for more than 5 seconds in an outside review). Each
  // search still spans up to the whole text when the second match is far away, so the text the searches span is budgeted: past
  // 16 times the paragraph (plus a floor), null, and the whole paragraph text is set instead (its run formatting is not kept).
  // `shared` ({left}) is the budget of a whole merge: the floor is per paragraph, so 3,900 paragraphs of 2,000 "a" with one letter typed
  // in each spent 5 s of the merge's time in an outside review. Past it, every later paragraph is set whole as well.
  let budget = 2_000_000 + 16 * before.length;
  const once = (needle) => {
    const i = before.indexOf(needle);
    if (i < 0) return false;
    const j = before.indexOf(needle, i + 1);
    const span = j < 0 ? before.length : j + needle.length; // what the two searches spanned
    budget -= span;
    if (shared) shared.left -= span;
    return j < 0;
  };
  // widen (left first, then right) until the find text is not empty and occurs once
  while ((b === a || !once(before.slice(a, b))) && (a > 0 || b < before.length)) {
    if (a > 0) a--;
    else b++;
    if (b - a > CAP || budget < 0 || shared?.left < 0) return null;
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
 * Are two paragraphs in the same place: both in the body, or in the same cell (row and column) of the same table? A table is its order
 * among the body's tables (`tableNo`; its body index shifts with every paragraph added above it). Two cells 0 0 of two tables are two
 * places (an outside review: a paragraph moved from the first table to the second was edited in the first and nothing was said).
 */
const sameBox = (a, b) => (a.path?.length ?? 0) === (b.path?.length ?? 0) && (a.path?.length !== 4 || (a.tableNo === b.tableNo && a.path[1] === b.path[1] && a.path[2] === b.path[2]));

/**
 * Pairs, in place, a base paragraph `mapA` leaves unpaired alone between two paired neighbors with the first unpaired paragraph of B
 * between their partners, when the two are in the same place (sameBox) and the ids allow it (`may`). Linear.
 */
function pairSlots(A, B, mapA, mapB, may) {
  let i0 = -1;
  for (let i = 0; i <= A.length; i++) {
    if (i < A.length && mapA[i] < 0) continue;
    const j0 = i0 < 0 ? -1 : mapA[i0];
    const j1 = i < A.length ? mapA[i] : B.length;
    // one paragraph rewritten (a long run of rewritten paragraphs stays with the matcher: see "every one of 20,000 paragraphs rewritten")
    const b = j0 + 1;
    if (i - i0 === 2 && b < j1 && mapB[b] < 0 && sameBox(A[i0 + 1], B[b]) && may(i0 + 1, b)) (mapA[i0 + 1] = b), (mapB[b] = i0 + 1);
    i0 = i;
  }
}

/**
 * The indexes j of `map` (index -> paired index, -1: none) that are out of order: those outside one longest run whose paired indexes
 * increase (a longest increasing subsequence, n log n). The proof of the merge (src/merge-proof.js) finds moves on its own.
 */
function outOfOrder(map) {
  const js = [];
  for (let j = 0; j < map.length; j++) if (map[j] >= 0) js.push(j);
  const tails = []; // tails[len - 1]: the index in js of the smallest last value of a run of length len
  const back = new Int32Array(js.length).fill(-1);
  for (let k = 0; k < js.length; k++) {
    const v = map[js[k]];
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (map[js[tails[mid]]] < v) lo = mid + 1;
      else hi = mid;
    }
    tails[lo] = k;
    back[k] = lo > 0 ? tails[lo - 1] : -1;
  }
  const out = new Set(js);
  for (let k = tails.length ? tails[tails.length - 1] : -1; k >= 0; k = back[k]) out.delete(js[k]);
  return out;
}

/**
 * Plans the merge. Arguments are paragraph lists (readDocxParagraphs with detail). Returns
 * {items: [{kind, label, text, t, op, ...}], unplaced: [{label, text, why}]}: every item is tried on `theirs`. `t` is the index in
 * `theirs` of the paragraph the op names (for a new paragraph: its anchor); a moved paragraph also has `to`, its new neighbor, and
 * a `note` (with `check`, see `lost`) when its formatting in `mine` is not the original's.
 */
export function planDocxMerge(base, mine, theirs) {
  // Which paragraph of the person's version, and of the agent's, is base paragraph i: one rule for both sides and for History
  // (paraIdentity in src/history.js). A paragraph id unique in its version is the paragraph: a match by text and position never pairs
  // it with a paragraph that carries another id (an outside review: the person retyped paragraph 1 to read as paragraph 2 and edited
  // paragraph 2; text matching took the new paragraph 1 for paragraph 2, and the edit of paragraph 1 was lost). On the agent's side
  // the rule is strict: a base paragraph whose id the agent's version, which has ids, no longer has was removed or rebuilt, and an
  // edit of it is handed back. If several of the agent's paragraphs carry the id (one copied with it), only a text match that carries
  // it counts. Without ids on either side, text and position alone decide, as before. In doubt the edit is handed back (unplaced),
  // never applied to a paragraph the person did not edit (an outside review: an edit of the first paragraph overwrote the second one,
  // whose text the agent had replaced with the first one's).
  const { mapA: baseToMine, mapB: mineToBase, moved: same } = matchParagraphs(base, mine);
  // A paragraph rewritten whole between two paragraphs the person left in place faces the first new paragraph between their copies: in
  // the same place (body or table cell), it is that paragraph, edited (a short text, such as a table cell's, has no similarity to go
  // by: "Item" retyped as "Mine" was a deletion and a new paragraph, and a line added under it went into another cell)
  pairSlots(base, mine, baseToMine, mineToBase, paraIdentity(base, mine, { strict: true }).may);
  // Which of the person's paragraphs moved: those the matcher found elsewhere with the same text, and of the others those outside a
  // longest run that keeps the base order. A paragraph the person also edited counts like any other (an outside review: base [A, B, C,
  // D], the person moved A after C and edited it, and the move was dropped without a word; so was the order of two paragraphs swapped
  // and both edited).
  const moved = new Set([...same, ...outOfOrder(Int32Array.from(mineToBase, (i, j) => (same.has(j) ? -1 : i)))]);
  const theirSide = paraIdentity(base, theirs, { strict: true });
  /** may paragraph n of the agent's version be base paragraph i, as far as the ids say (the rule above)? */
  const agrees = theirSide.may;
  // a base paragraph the agent left alone, by position: the same text in the same order, ids told apart
  const { mapA: baseToTheirs } = lcsPairs(theirSide.keyA, theirSide.keyB);
  const agent = matchParagraphs(base, theirs, { strict: true }); // where the agent's other paragraphs came from: an edited one, one it moved
  // the agent changed the order of paragraphs too: then which order wins is not certain, and no move of the person's is carried
  const agentMoved = outOfOrder(agent.mapA).size > 0;
  const ids = (L) => {
    const m = new Map(); // id -> the indexes of the paragraphs that carry it
    L.forEach((p, n) => p.paraId && (m.get(p.paraId) || m.set(p.paraId, []).get(p.paraId)).push(n));
    return m;
  };
  const baseIds = ids(base);
  const theirIds = ids(theirs);
  const ownId = (i) => (base[i].paraId && baseIds.get(base[i].paraId).length === 1 ? base[i].paraId : null);
  /** base paragraph i where it stands in the agent's version (same text, same order), when the ids agree; else -1 */
  const inPlace = (i) => {
    const t = baseToTheirs[i];
    return t >= 0 && theirs[t].path && agrees(i, t) ? t : -1;
  };
  /** inPlace(i), else the paragraph with its unique id when the agent moved it and left its text alone; else -1 */
  const at = (i) => {
    const t = inPlace(i);
    if (t >= 0) return t;
    const n = ownId(i) ? theirIds.get(ownId(i)) : null;
    return n?.length === 1 && theirs[n[0]].path && theirs[n[0]].hash === base[i].hash ? n[0] : -1;
  };
  const locator = (n) => ({ body_path: theirs[n].path, text_hash: theirs[n].hash });
  const work = { left: 4_000_000 + 16 * base.reduce((n, p) => n + p.text.length, 0) }; // minimalReplace over the whole plan
  const items = [];
  const unplaced = [];
  // `of` names the paragraph an entry stands for, for the proof of the merge (src/merge-proof.js): "m" and the paragraph's ordinal in
  // the person's version, or "b" and its ordinal in the base
  const ref = (p) => `${base[p.ordinal] === p ? "b" : "m"}${p.ordinal}`;
  const no = (p, why, text = p.text, of = [ref(p)]) => unplaced.push({ label: label(p), text: cut(text), why, of });

  // The agent's version of a base paragraph whose text it changed, only when there is no doubt which one it is: the same unique
  // paragraph id, or the one paragraph between the same two untouched neighbors (and never one the ids say is another paragraph).
  const rewritten = (i) => {
    const n = agent.mapA[i];
    if (n < 0 || baseToTheirs[i] >= 0 || agent.moved.has(n) || !theirs[n].path || !agrees(i, n)) return -1;
    if (theirIds.get(ownId(i))?.length === 1) return n; // the agent's version may have no ids at all (an outside review: this threw)
    const before = i === 0 ? n === 0 : inPlace(i - 1) >= 0 && inPlace(i - 1) === n - 1;
    const after = i === base.length - 1 ? n === theirs.length - 1 : inPlace(i + 1) >= 0 && inPlace(i + 1) === n + 1;
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
      return no(m, `You changed formatting here${mineWords.length ? ` (${list(mineWords)})` : ""}, but the agent changed, moved or removed this paragraph, so it was not carried over.`, "", [ref(m), ref(b)]);
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
    if (!done.length) return no(m, notes.join(" "), "", [ref(m), ref(b)]);
    items.push({ kind: "format", label: label(m), of: [ref(m), ref(b)], text: "", hash: null, t: n, words: done, note: notes.join(" "), op: { op: "format_paragraph", target: locator(n), expect: { text_hash: a.hash }, ...(Object.keys(carry).length ? { para: carry } : {}), ...(runs.length ? { runs } : {}) } });
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

  // anchors for new paragraphs: the nearest paragraph before (else after) that the agent left alone, or rewrote when there is no doubt
  // which paragraph of its version that is (an anchor past the agent's edited neighbor put the new paragraph on the wrong side of it).
  // The user may have edited it (a split leaves the first half as an edit of the original): every op is bound to the agent's file
  // before any op runs.
  const still = (j) => mineToBase[j] >= 0 && !moved.has(j); // a paragraph of the base that is where it was
  const placed = (i) => {
    const t = inPlace(i);
    if (t >= 0) return t;
    const n = ownId(i) ? theirIds.get(ownId(i)) : null;
    return n?.length === 1 && theirs[n[0]].path && agrees(i, n[0]) ? n[0] : rewritten(i);
  };
  const anchorOf = (j) => (still(j) ? placed(mineToBase[j]) : -1);
  // the nearest paragraph of `mine` before and after j that passes `ok`, for every j at once (a walk from each paragraph was quadratic
  // over a long stretch of new or moved paragraphs). -1 / mine.length: none.
  const nearest = (ok) => {
    const prev = new Int32Array(mine.length);
    const next = new Int32Array(mine.length);
    for (let j = 0, last = -1; j < mine.length; j++) (prev[j] = last), ok(j) && (last = j);
    for (let j = mine.length - 1, last = mine.length; j >= 0; j--) (next[j] = last), ok(j) && (last = j);
    return { prev, next };
  };
  let nearStill = null;
  let nearAnchor = null;
  const inserts = []; // {where: "after"|"before", to: index in theirs, m, move?: index in theirs of the paragraph to move}
  let unanchored = false; // a paragraph of the user's could not be placed: it may be one of the "deleted" ones, rewritten past recognition

  /**
   * A paragraph the user moved: the agent's paragraph is moved as it is, placed by the paragraph right before it in the user's
   * version (else the one right after), which the agent must have left alone. The formatting of the user's copy is never set: a
   * paragraph that was cut and pasted comes back without its style, alignment and list and with its look written out on every run
   * (seen in the real editor), so setting it would take the heading or the bullet off the agent's paragraph. It is read for the
   * report only (`lost`).
   */
  const move = (m, j, i) => {
    const n = inPlace(i);
    const more = lost(base[i], m);
    const t = theirs[n];
    const say = (why) => void no(m, why, "", [ref(m), ref(base[i])]);
    if (!t) return say(agent.moved.has(agent.mapA[i]) ? "You moved this paragraph and so did the agent. It is where the agent put it." : "You moved this paragraph, but the agent changed or removed it, so the move was not carried over.");
    if (agentMoved) return say("You moved this paragraph, but the agent moved paragraphs too, so the move was not carried over.");
    if (t.path?.length !== 1 || m.path?.length !== 1) return say("You moved this paragraph in or out of a table. Moves that involve tables are not carried over.");
    if (t.sect) return say("You moved this paragraph, but it ends a section of the document, so the move was not carried over.");
    if (t.loose) return say("You moved this paragraph, but a comment or bookmark starts or ends inside it, so the move was not carried over.");
    const body = (k) => (k >= 0 && k < mine.length && anchorOf(k) >= 0 && theirs[anchorOf(k)].path.length === 1 ? anchorOf(k) : -1);
    nearStill ||= nearest(still);
    let k = nearStill.prev[j];
    if (body(k) >= 0) return void inserts.push({ where: "after", to: body(k), m, move: n, ...more });
    k = nearStill.next[j];
    if (body(k) >= 0) return void inserts.push({ where: "before", to: body(k), m, move: n, ...more });
    say("You moved this paragraph, but the agent changed the paragraphs next to its new place, so the move was not carried over.");
  };

  mine.forEach((m, j) => {
    const i = mineToBase[j];
    if (i >= 0) {
      const b = base[i];
      // moved into another table or cell, its order among the paragraphs kept: the move is not carried (a move that changes the order
      // says so in move()); its text and formatting are, where it stands in the agent's version
      if (!sameBox(b, m) && !moved.has(j)) no(m, "You moved this paragraph into another table or table cell. Moves that involve tables are not carried over.", "", [ref(m), ref(b)]);
      if (b.text === m.text) return moved.has(j) ? move(m, j, i) : format(b, m, i, false);
      // The text changed. White space counts as written: a line break, a tab or a second space is an edit too, though the text hashes the
      // same (an outside review: a line break typed into "A B" was dropped without a word). So does the agent's, on its side.
      const t = at(i);
      const now = t >= 0 ? theirs[t] : agent.mapA[i] >= 0 && agrees(i, agent.mapA[i]) ? theirs[agent.mapA[i]] : null;
      // the agent's own copy of this paragraph already reads as the user's (an earlier pass carried it). Only that one paragraph counts:
      // the same text anywhere else in the agent's version says nothing about this one (an outside review lost an edit that way)
      if (now?.text === m.text) return moved.has(j) ? move(m, j, i) : undefined;
      if (t < 0 || now.text !== b.text) return no(m, "The agent changed this paragraph too. Its version is in the document; this is yours.", m.text, [ref(m), ref(b)]);
      const r = minimalReplace(b.text, m.text, work);
      const op = { op: "replace_text", target: locator(t), expect: { text_hash: b.hash }, ...(r ? r : { text: m.text }) };
      items.push({ kind: "changed", label: label(m), of: [ref(m), ref(b)], text: cut(m.text), hash: m.hash, raw: m.text, m, t, op });
      format(b, m, i, true);
      if (moved.has(j)) move(m, j, i); // moved as well: the agent's paragraph, edited first, is moved
      return;
    }
    nearAnchor ||= nearest((x) => anchorOf(x) >= 0);
    // placed by a paragraph in the same place: the body, or the same table cell (a new line typed in a cell was put in the body)
    let k = nearAnchor.prev[j];
    if (k >= 0 && sameBox(mine[k], m) && sameBox(theirs[anchorOf(k)], mine[k])) return inserts.push({ where: "after", to: anchorOf(k), m });
    k = nearAnchor.next[j];
    if (k < mine.length && sameBox(mine[k], m) && sameBox(theirs[anchorOf(k)], mine[k])) return inserts.push({ where: "before", to: anchorOf(k), m });
    unanchored = true;
    no(m, "There was no unchanged paragraph near this new one to place it by.");
  });
  // several new or moved paragraphs after one anchor: each lands right after the anchor, so the last goes first
  for (const x of inserts.filter((x) => x.where === "after").reverse().concat(inserts.filter((x) => x.where === "before"))) {
    const to = locator(x.to);
    if (x.move === undefined) items.push({ kind: "added", label: label(x.m), of: [ref(x.m)], text: cut(x.m.text), hash: x.m.hash, m: x.m, t: x.to, where: x.where, op: { op: x.where === "after" ? "insert_paragraph_after" : "insert_paragraph_before", target: to, expect: { text_hash: to.text_hash }, text: x.m.text } });
    else items.push({ kind: "moved", label: label(x.m), of: [ref(x.m), ref(base[mineToBase[x.m.ordinal]])], text: "", hash: x.m.hash, t: x.move, to: x.to, where: x.where, ...(x.note ? { note: x.note, check: x.check } : {}), op: { op: "move_paragraph", target: locator(x.move), expect: { text_hash: theirs[x.move].hash }, to, where: x.where } });
  }
  // A base paragraph with no match in the user's version is deleted only when every paragraph of the user's could be placed. When one could
  // not (the matcher's similarity budget ran out on a long run of edited paragraphs, so none of them matched), the unmatched base paragraphs
  // may be those very paragraphs, rewritten: deleting them removed the whole document (a merge of 49,999 edited paragraphs left one).
  const kept = [];
  base.forEach((b, i) => {
    if (baseToMine[i] >= 0) return;
    const t = at(i) >= 0 && theirs[at(i)].text === b.text ? at(i) : -1; // the agent's white space counts too
    if (t >= 0 && unanchored) kept.push(ref(b));
    else if (t >= 0) items.push({ kind: "removed", label: label(b), of: [ref(b)], text: "", hash: null, t, op: { op: "delete_paragraph", target: locator(t), expect: { text_hash: b.hash } } });
    else no(b, "You deleted this paragraph, but the agent changed it, so it was kept.", "");
  });
  if (kept.length) unplaced.push({ label: "Deleted paragraphs", text: "", why: `${kept.length === 1 ? "A paragraph you deleted was" : `${kept.length} paragraphs you deleted or rewrote were`} kept, because Onionskin could not place your other edits next to ${kept.length === 1 ? "it" : "them"}.`, of: kept });
  // A table cell holds at least one paragraph: deleting all of a cell's paragraphs leaves a cell Word reports as damaged (found by the
  // proof of the merge: a table row the person deleted came back as a row of empty cells). Those deletions are a row or a cell the
  // person removed, which is not carried: they are handed back and the paragraphs stay.
  const cellOf = (p) => (p.path?.length === 4 ? `${p.tableNo} ${p.path[1]} ${p.path[2]}` : null);
  const left = new Map(); // cell of the agent's version -> paragraphs it keeps after the plan
  for (const p of theirs) if (cellOf(p)) left.set(cellOf(p), (left.get(cellOf(p)) || 0) + 1);
  for (const it of items) if (it.kind === "removed" && cellOf(theirs[it.t])) left.set(cellOf(theirs[it.t]), left.get(cellOf(theirs[it.t])) - 1);
  for (const it of items) if (it.kind === "added" && cellOf(theirs[it.t])) left.set(cellOf(theirs[it.t]), left.get(cellOf(theirs[it.t])) + 1);
  for (let k = items.length - 1; k >= 0; k--) {
    const it = items[k];
    if (it.kind !== "removed" || !cellOf(theirs[it.t]) || left.get(cellOf(theirs[it.t])) > 0) continue;
    items.splice(k, 1);
    unplaced.push({ label: it.label, text: "", why: "You deleted this paragraph with the table row or cell it was in. Rows and cells are not carried over, so it was kept.", of: it.of });
  }
  // replacements first, then formatting, then new and moved paragraphs, then deletions (an anchor is never a paragraph this plan deletes)
  const order = { changed: 0, format: 1, added: 2, moved: 2, removed: 3 };
  items.sort((x, y) => order[x.kind] - order[y.kind]);
  return { items, unplaced };
}

const turn = () => new Promise((resolve) => setImmediate(resolve));
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
  // a linked list of the agent's paragraphs, each found by its index in `theirs` (a search and a splice per item was quadratic)
  const head = { next: null };
  const tail = { prev: head };
  head.next = tail;
  const put = (a, x) => ((x.prev = a), (x.next = a.next), (a.next.prev = x), (a.next = x), (x.live = true)); // x right after a
  const take = (x) => ((x.prev.next = x.next), (x.next.prev = x.prev), (x.live = false));
  const nodes = theirs.map((p, n) => {
    const x = { n, hash: p.hash };
    put(tail.prev, x);
    return x;
  });
  const live = (n) => (nodes[n]?.live ? nodes[n] : null);
  items.forEach((it, k) => {
    if (results[k]?.status !== "applied") return;
    const x = live(it.t);
    if (!x) return;
    if (it.kind === "changed") x.hash = it.hash;
    else if (it.kind === "removed") take(x);
    else if (it.kind === "added") put(it.where === "after" ? x : x.prev, { n: -1, hash: it.hash, it });
    else if (it.kind === "moved") {
      take(x);
      const to = live(it.to); // always there (an anchor is never a paragraph the plan removes); if not, where a splice at -1 put it
      put(to ? (it.where === "after" ? to : to.prev) : it.where === "after" || tail.prev === head ? head : tail.prev.prev, x);
    }
  });
  const seq = [];
  for (let x = head.next; x !== tail; x = x.next) seq.push({ n: x.n, hash: x.hash, it: x.it });
  return seq;
}

/** Do two readings of the same text look the same: paragraph style, alignment, list, other paragraph settings and runs by character? */
function sameLook(a, b) {
  const runs = runPatches(a.spans, b.spans);
  return styleKey(a.styleName || a.style) === styleKey(b.styleName || b.style) && a.align === b.align && listSig(a) === listSig(b) && a.ppr === b.ppr && !!runs && !runs.other && !runs.ranges.length;
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
  // a turn of the event loop between the readings and the plan: at 50,000 paragraphs each takes 0.2 to 0.3 s, all four in a row 0.9 s
  const agents = read(theirs);
  await turn();
  const before = read(base);
  await turn();
  const after = read(mine);
  await turn();
  const plan = planDocxMerge(before, after, agents);
  await turn();
  const unplaced = [...plan.unplaced];
  const readings = { base: before, mine: after, theirs: agents }; // for the proof of the merge (src/merge-worker.js), read once
  if (!plan.items.length) return { bytes: null, merged: 0, unplaced, read: readings };
  let r = await attempt(plan.items, { theirs, agents, name, runOps, read });
  if (r.redo) {
    // a move or a formatting change did not come out as planned: nothing unproven is written, the rest is carried without them
    for (const it of plan.items.filter((x) => SOFT.has(x.kind))) unplaced.push({ label: it.label, text: "", why: reason(it), of: it.of });
    const rest = plan.items.filter((x) => !SOFT.has(x.kind));
    r = rest.length ? await attempt(rest, { theirs, agents, name, runOps, read }) : { bytes: null, merged: 0, unplaced: [] };
  }
  return { bytes: r.bytes, merged: r.merged, unplaced: [...unplaced, ...r.unplaced], read: readings };
}

/** One run of `items` on the agent's bytes, checked on the result. {redo: true} asks for a run without moves and formatting. */
async function attempt(items, { theirs, agents, name, runOps, read }) {
  const unplaced = [];
  const soft = items.some((x) => SOFT.has(x.kind));
  const { results, bytes, blocked } = await runOps({ bytes: theirs, format: "docx", name, ops: items.map((x) => x.op), partial: true });
  const fail = (it, why) => unplaced.push({ label: it.label, text: it.text, why, of: it.of });
  if (!bytes) {
    if (blocked && soft) return { redo: true };
    for (const [n, it] of items.entries()) fail(it, blocked ? "Carrying your edits over would have damaged the file, so none were applied." : reason(it, results[n]));
    return { bytes: null, merged: 0, unplaced };
  }
  // the proof is the result, not the report. First: nothing of the agent's version is gone except what an op named.
  await turn();
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
  // then: every carried text is in the merged file, and a changed paragraph reads as typed, white space as written, in its own place (the
  // same text elsewhere proves nothing about it) whenever the result has the paragraphs the plan expects
  const have = new Set(out.map((p) => p.hash));
  const seq = expected(agents, items, results);
  const place = seq.length === out.length ? new Map(seq.map((x, k) => [x.n, k])) : null;
  if (place && items.some((it, n) => it.kind === "changed" && results[n]?.status === "applied" && out[place.get(it.t)]?.text !== it.raw)) {
    // a paragraph of the agent's now reads as neither version: nothing is written
    if (soft) return { redo: true };
    for (const it of items) fail(it, "Carrying your edits over would have changed the agent's text, so none were applied.");
    return { bytes: null, merged: 0, unplaced };
  }
  // The look the person gave a paragraph they added, or the inside of one they typed in, that the result does not have is said (a check
  // line), never dropped without a word: the engine gives a new paragraph the paragraph formatting of the one it is placed by, and typed
  // text the look of the run it lands in. The proof of the merge (src/merge-proof.js) refuses a result that differs without such a line.
  if (place) {
    const added = new Map();
    seq.forEach((x, k) => x.it && added.set(x.it, k));
    items.forEach((it, n) => {
      if (results[n]?.status !== "applied" || !it.m || (it.kind !== "added" && it.kind !== "changed")) return;
      const o = out[it.kind === "added" ? added.get(it) : place.get(it.t)];
      if (!o || o.text !== it.m.text || sameLook(it.m, o)) return;
      unplaced.push({ label: it.label, text: "", why: it.kind === "added" ? "Your new paragraph was carried over with the formatting of the paragraph next to it: if you formatted it, set it again." : "Your text was carried over, but the formatting inside this paragraph is not as you had it: check it.", of: it.of, check: true });
    });
  }
  let merged = 0;
  items.forEach((it, n) => {
    if (results[n]?.status !== "applied") return fail(it, reason(it, results[n]));
    if (it.hash && !have.has(it.hash)) return fail(it, "This edit did not land as typed.");
    merged++;
    if (it.note && it.kind === "moved") unplaced.push({ label: it.label, text: "", why: `Your move was carried over. ${it.note}`, of: it.of, ...(it.check ? { check: true } : {}) });
    else if (it.note) fail(it, `Your ${list(it.words)} change was carried over. ${it.note}`);
  });
  return { bytes, merged, unplaced };
}
