import { diffRaw } from "./diff.js";
import { parseDocxParagraphs } from "./docx.js";
import { matchParagraphs } from "./history.js";
import { normText } from "./text.js";
import { fmtNote } from "./fmt.js";
import { openZip } from "./zip.js";
import { replaceEntry } from "./zip-write.js";
import { walkXml } from "./xml.js";
import { attr, attrs, descendants, elements, escAttr, escText, parse, serialize, textOf } from "./xml-tree.js";

// Builds the tracked-changes copy (docs/contracts/tracked-changes.md): the AFTER file with Word revision markup written into
// word/document.xml, so Accept All in Word gives AFTER and Reject All gives BEFORE (text and paragraph structure). Pure: bytes in, bytes or
// refusal codes out. Every gate below refuses the whole copy (all or nothing); the caller still runs src/redline-check.js on the result.
//
// Markup (contract section 4): run revisions <w:del><w:r><w:rPr/><w:delText/></w:r></w:del> then <w:ins><w:r>..<w:t/></w:r></w:ins>;
// an added paragraph has its own mark inserted, a removed one is rebuilt from BEFORE with its own mark deleted and placed before the AFTER
// match of the next kept BEFORE paragraph. Ids start at 1 + the largest w:id in any part; no rsid attributes on what is written here.

export const AUTHORS = { agent: "Onionskin agent", mixed: "Onionskin" };
const MAX_ID = 2147483647;

const two = (n) => String(n).padStart(2, "0");
/** Word's own w:date convention: the local wall-clock time written with a Z, seconds 00 (contract M2). */
export const wordDate = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}:00Z`;
};

const REVISIONS = new Set(["w:ins", "w:del", "w:moveFrom", "w:moveTo", "w:moveFromRangeStart", "w:moveToRangeStart", "w:rPrChange", "w:pPrChange", "w:cellIns", "w:cellDel", "w:cellMerge", "w:numberingChange", "w:sectPrChange", "w:tblPrChange", "w:tblGridChange", "w:trPrChange", "w:tcPrChange", "w:tblPrExChange"]);
const P_ANCHORS = new Set(["w:bookmarkStart", "w:bookmarkEnd", "w:commentRangeStart", "w:commentRangeEnd", "w:proofErr"]);
const RUN_KIDS = new Set(["w:rPr", "w:t", "w:tab", "w:br", "w:lastRenderedPageBreak", "w:commentReference"]);
// direct run properties a deleted run may carry over from BEFORE (anything else falls back to the neighboring AFTER properties)
const DIRECT_RPR = new Set(["w:b", "w:bCs", "w:i", "w:iCs", "w:u", "w:strike", "w:dstrike", "w:color", "w:sz", "w:szCs", "w:rFonts", "w:highlight", "w:vertAlign", "w:lang", "w:caps", "w:smallCaps"]);
// paragraph properties a removed paragraph keeps from BEFORE, in their source order (which is the schema order)
const KEEP_PPR = new Set(["w:pStyle", "w:keepNext", "w:keepLines", "w:pageBreakBefore", "w:numPr", "w:spacing", "w:ind", "w:contextualSpacing", "w:jc", "w:outlineLvl"]);
// characters XML 1.0 does not allow (a decoded &#1; would make the copy unreadable)
const BAD_CHAR = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const NOTES_PART = /^word\/(header|footer|footnotes|endnotes|comments)[^/]*\.xml$/;

class Refused extends Error {
  constructor(codes) {
    super(codes.join(", "));
    this.codes = codes;
  }
}

// ---- reading the paragraphs out of the tree -------------------------------------------------------------------------

/** Every paragraph in document order, as parseDocxParagraphs lists them (paragraphs inside a paragraph, text boxes, are not listed). */
function listParagraphs(root) {
  const body = [...descendants(root)].find((e) => e.name === "w:body");
  if (!body) throw new Refused(["unreadable"]);
  const out = [];
  const tables = [];
  let nestedTables = 0;
  const visit = (el, depth) => {
    for (const k of elements(el)) {
      if (k.name === "w:p") {
        let ctx = "other";
        if (k.parent === body) ctx = "body";
        else if (depth === 1 && k.parent.name === "w:tc") ctx = "cell";
        else if (depth > 1) ctx = "nested";
        out.push({ node: k, ctx, seg: tables.length - nestedTables }); // seg: top-level tables before it
        continue;
      }
      if (k.name === "w:tbl" && depth > 0) nestedTables++;
      if (k.name === "w:tbl") {
        const t = { rows: [] };
        tables.push(t);
        for (const tr of elements(k).filter((x) => x.name === "w:tr")) t.rows.push(elements(tr).filter((x) => x.name === "w:tc").length);
      }
      visit(k, depth + (k.name === "w:tbl" ? 1 : 0));
    }
  };
  visit(body, 0);
  return { body, paras: out, tables };
}

/**
 * A paragraph's content as pieces: {kind: "text", rPr, tag: "t"|"tab"|"br", text} and {kind: "anchor", raw} (bookmarks, comment marks,
 * proofErr, a comment reference run). null when it holds anything else (links, fields, objects, special characters...).
 */
function piecesOf(p) {
  const pieces = [];
  let pPr = null;
  for (const k of p.kids) {
    if (k.t === "text") {
      if (k.raw.trim()) return null;
      continue;
    }
    if (k.t !== "el") return null;
    if (k.name === "w:pPr") {
      if (pPr || pieces.length) return null;
      pPr = k;
    } else if (P_ANCHORS.has(k.name)) pieces.push({ kind: "anchor", raw: serialize(k) });
    else if (k.name === "w:r") {
      let rPr = "";
      const kids = elements(k);
      if (k.kids.some((x) => x.t !== "el" && !(x.t === "text" && !x.raw.trim()))) return null;
      for (const c of kids) {
        if (!RUN_KIDS.has(c.name)) return null;
        if (c.name === "w:rPr") rPr = serialize(c);
        else if (c.name === "w:t") {
          if (c.kids.some((x) => x.t !== "text" && x.t !== "cdata")) return null;
          const text = c.kids.map(textOf).join("");
          if (text) pieces.push({ kind: "text", rPr, tag: "t", text });
        } else if (c.name === "w:tab") pieces.push({ kind: "text", rPr, tag: "tab", text: "\t" });
        else if (c.name === "w:br") {
          if (attrs(c).length) return null; // a typed break (page, column) or a clear break is not plain text
          pieces.push({ kind: "text", rPr, tag: "br", text: "\n" });
        } else if (c.name === "w:commentReference") pieces.push({ kind: "anchor", raw: `<w:r>${rPr}${serialize(c)}</w:r>` });
        // w:lastRenderedPageBreak is a layout hint Word writes again on save: dropped from rewritten paragraphs
      }
    } else return null;
  }
  return { pPr, pieces };
}

const textOfPieces = (pieces) => pieces.filter((x) => x.kind === "text").map((x) => x.text).join("");

// ---- writing markup ---------------------------------------------------------------------------------------------------

const space = (s) => (/^\s|\s$/.test(s) ? ' xml:space="preserve"' : "");
const tagXml = (pc, del) => (pc.tag === "tab" ? "<w:tab/>" : pc.tag === "br" ? "<w:br/>" : del ? `<w:delText${space(pc.text)}>${escText(pc.text)}</w:delText>` : `<w:t${space(pc.text)}>${escText(pc.text)}</w:t>`);
/** pieces -> runs; neighbors with the same properties share one run */
function runsXml(pieces, del) {
  let out = "";
  let cur = null;
  let body = "";
  for (const pc of pieces) {
    if (cur !== null && pc.rPr !== cur) (out += `<w:r>${cur}${body}</w:r>`, (body = ""));
    cur = pc.rPr;
    body += tagXml(pc, del);
  }
  if (cur !== null) out += `<w:r>${cur}${body}</w:r>`;
  return out;
}

/** Splits text pieces at character offsets [s, e) of the paragraph text. */
function slice(pieces, s, e) {
  const out = [];
  let at = 0;
  for (const pc of pieces) {
    if (pc.kind !== "text") continue;
    const a = at;
    const b = at + pc.text.length;
    at = b;
    if (b <= s || a >= e) continue;
    const from = Math.max(s, a) - a;
    const to = Math.min(e, b) - a;
    out.push({ ...pc, text: pc.text.slice(from, to) });
  }
  return out;
}
/** Offsets of the anchors among the pieces: [{at, raw}] */
function anchorsOf(pieces) {
  const out = [];
  let at = 0;
  for (const pc of pieces) {
    if (pc.kind === "text") at += pc.text.length;
    else out.push({ at, raw: pc.raw });
  }
  return out;
}

/** The open tag of a paragraph that gets content: an empty <w:p .../> becomes <w:p ...>. */
const openOf = (node) => (node.close ? node.open : node.open.replace(/\s*\/>$/, ">"));

/** Adds an empty w:ins / w:del as the first child of the paragraph mark's w:rPr (contract M7, M8). `pPrXml` is "" or a serialized w:pPr. */
function markPPr(pPrNode, mark) {
  if (!pPrNode) return `<w:pPr><w:rPr>${mark}</w:rPr></w:pPr>`;
  const kids = pPrNode.kids;
  const rPr = kids.find((k) => k.t === "el" && k.name === "w:rPr");
  const inner = (k) => (k.t === "el" && k.name === "w:rPr" ? (k.close ? k.open + mark + k.kids.map(serialize).join("") + k.close : `${k.open.replace(/\s*\/>$/, ">")}${mark}</w:rPr>`) : serialize(k));
  let body;
  if (rPr) body = kids.map(inner).join("");
  else {
    const at = kids.findIndex((k) => k.t === "el" && (k.name === "w:sectPr" || k.name === "w:pPrChange"));
    const list = kids.map(serialize);
    list.splice(at < 0 ? list.length : at, 0, `<w:rPr>${mark}</w:rPr>`);
    body = list.join("");
  }
  const open = pPrNode.close ? pPrNode.open : pPrNode.open.replace(/\s*\/>$/, ">");
  return `${open}${body}</w:pPr>`;
}

// ---- the build --------------------------------------------------------------------------------------------------------

/** XML text of every part, for the largest id. */
function maxIdOf(zip) {
  let max = 0;
  for (const n of zip.names) {
    if (!/\.xml$/i.test(n)) continue;
    walkXml(zip.readText(n), {
      onOpen(_, a) {
        const v = a["w:id"];
        if (v != null && /^\d{1,12}$/.test(v)) max = Math.max(max, Number(v));
      },
    });
  }
  return max;
}

function styleIds(xml) {
  const ids = new Set();
  if (!xml) return ids;
  walkXml(xml, { onOpen: (name, a) => name === "w:style" && a["w:styleId"] && ids.add(a["w:styleId"]) });
  return ids;
}

/**
 * {before, after}: DOCX bytes; {author, date}: what every revision carries. Returns {bytes, counts: {ins, del, paras_added, paras_removed,
 * moved, formatting}} or {refused: [codes]}. `formatting` is how many paragraphs Reject All leaves with formatting other than BEFORE's.
 */
export function buildTracked({ before, after, author, date }) {
  try {
    return build(before, after, author, date);
  } catch (err) {
    if (err instanceof Refused) return { refused: [...new Set(err.codes)] };
    return { refused: ["unreadable"], detail: String(err?.message || err).slice(0, 200) };
  }
}

function build(beforeBytes, afterBytes, author, date) {
  const zb = openZip(beforeBytes);
  const za = openZip(afterBytes);
  const codes = [];
  // ---- parts: only word/document.xml may differ (contract section 6: the tolerated list is empty)
  const names = new Set([...zb.names, ...za.names]);
  for (const n of names) {
    if (n === "word/document.xml") continue;
    const same = zb.entries.has(n) && za.entries.has(n) && (zb.raw(n).equals(za.raw(n)) || zb.read(n, 512 * 1024 * 1024).equals(za.read(n, 512 * 1024 * 1024)));
    if (!same) codes.push(NOTES_PART.test(n) ? "notes_part" : "other_part");
  }
  const xb = zb.readText("word/document.xml");
  const xa = za.readText("word/document.xml");
  if (xb == null || xa == null) throw new Refused(["unreadable"]);
  const tb = parse(xb);
  const ta = parse(xa);
  for (const t of [tb, ta]) for (const e of descendants(t)) if (REVISIONS.has(e.name)) throw new Refused(["has_revisions"]); // its own message
  const LB = listParagraphs(tb);
  const LA = listParagraphs(ta);
  const A = parseDocxParagraphs(xb);
  const B = parseDocxParagraphs(xa);
  // the tree walk and the shared reader must list the same paragraphs, or nothing here can be trusted
  if (A.length !== LB.paras.length || B.length !== LA.paras.length) throw new Refused(["unreadable"]);
  for (const p of [...A, ...B]) if (BAD_CHAR.test(p.text)) codes.push("bad_char");
  if (JSON.stringify(LB.tables) !== JSON.stringify(LA.tables)) codes.push("table_shape");
  const stylesAfter = styleIds(za.readText("word/styles.xml"));

  // ---- pairing. Table shapes are equal (gated), so a cell paragraph pairs with the one in the same table, row, column and position.
  // Every other paragraph goes through History's matcher; a pair that sits between other tables, or crosses an earlier pair, is a move
  // (removed at the old place, added at the new one).
  const pairB = new Int32Array(B.length).fill(-1);
  const pairA = new Int32Array(A.length).fill(-1);
  const cellKey = (P, L, k) => (L.paras[k].ctx === "cell" ? `${P[k].tableNo}|${P[k].path.slice(1).join(",")}` : null);
  const cellsA = new Map();
  A.forEach((_, i) => cellKey(A, LB, i) && cellsA.set(cellKey(A, LB, i), i));
  B.forEach((_, j) => {
    const i = cellsA.get(cellKey(B, LA, j));
    if (cellKey(B, LA, j) && i != null) (pairB[j] = i), (pairA[i] = j);
  });
  const restA = A.map((_, i) => i).filter((i) => LB.paras[i].ctx !== "cell");
  const restB = B.map((_, j) => j).filter((j) => LA.paras[j].ctx !== "cell");
  const m = matchParagraphs(restA.map((i) => A[i]), restB.map((j) => B[j]));
  // Ceiling: the demotion is greedy in AFTER order, so one pair matched far forward turns the later pairs into moves (a correct copy, just a
  // noisier one). Upgrade path: keep the longest increasing subsequence of the pairs instead.
  let lastI = -1;
  const movedPairs = new Set();
  restB.forEach((j, jj) => {
    if (m.mapB[jj] < 0) return;
    const i = restA[m.mapB[jj]];
    if (m.moved.has(jj) || i < lastI || LB.paras[i].ctx !== LA.paras[j].ctx || LB.paras[i].seg !== LA.paras[j].seg) return movedPairs.add(j);
    pairB[j] = i;
    pairA[i] = j;
    lastI = i;
  });

  const plainA = A.map((_, i) => piecesOf(LB.paras[i].node));
  const plainB = B.map((_, j) => piecesOf(LA.paras[j].node));
  const gate = (side, k, { whole }) => {
    const L = side === "A" ? LB : LA;
    const P = side === "A" ? A : B;
    const plain = side === "A" ? plainA : plainB;
    const { ctx, node } = L.paras[k];
    if (ctx === "nested") return codes.push("nested_table");
    if (ctx === "other") return codes.push("sdt");
    if (P[k].protected || !plain[k]) return codes.push("protected");
    if (textOfPieces(plain[k].pieces) !== P[k].text) return codes.push("unreadable");
    if (!whole) return;
    if (ctx === "cell") return codes.push("table_para");
    if (plain[k].pPr && elements(plain[k].pPr).some((e) => e.name === "w:sectPr")) return codes.push("section");
    const sib = node.parent.kids.slice(node.parent.kids.indexOf(node) + 1).find((x) => x.t === "el");
    if (!sib || sib.name === "w:sectPr") return codes.push("at_end");
    if (sib.name !== "w:p") return codes.push("next_to_table");
  };

  const modified = new Map(); // j -> i
  for (let j = 0; j < B.length; j++) {
    const i = pairB[j];
    if (i < 0) continue;
    if (A[i].text !== B[j].text) {
      gate("A", i, { whole: false });
      gate("B", j, { whole: false });
      modified.set(j, i);
    } else if ((A[i].protected || B[j].protected) && serialize(LB.paras[i].node) !== serialize(LA.paras[j].node)) codes.push("protected"); // a link or field changed under the same text
  }
  const added = [];
  for (let j = 0; j < B.length; j++) if (pairB[j] < 0) (gate("B", j, { whole: true }), added.push(j));
  const removed = [];
  for (let i = 0; i < A.length; i++) if (pairA[i] < 0) (gate("A", i, { whole: true }), removed.push(i));
  if (codes.length) throw new Refused(codes);
  if (!modified.size && !added.length && !removed.length) throw new Refused(["no_changes"]);

  // ---- where each removed paragraph goes: before the AFTER match of the next kept BEFORE paragraph (its siblings are paragraphs: gated)
  const insertBefore = new Map(); // AFTER paragraph index -> [BEFORE indexes, in order]
  for (const i of removed) {
    let k = i + 1;
    while (k < A.length && pairA[k] < 0) k++;
    const j = k < A.length ? pairA[k] : -1;
    if (j < 0 || LA.paras[j].ctx !== "body" || LB.paras[k].ctx !== "body") throw new Refused(["at_end"]);
    (insertBefore.get(j) || insertBefore.set(j, []).get(j)).push(i);
  }

  // ---- markup, generated in document order so ids rise through the document
  let nextId = Math.max(maxIdOf(za), maxIdOf(zb)) + 1;
  const counts = { ins: 0, del: 0, paras_added: added.length, paras_removed: removed.length, moved: movedPairs.size, formatting: 0 };
  const rev = (kind) => {
    if (nextId > MAX_ID) throw new Refused(["id_overflow"]);
    counts[kind]++;
    return `w:id="${nextId++}" w:author="${escAttr(author)}" w:date="${escAttr(date)}"`;
  };
  const stylesOk = (rPrXml) => {
    if (!rPrXml) return true;
    const t = parse(rPrXml);
    const rPr = elements(t)[0];
    return elements(rPr).every((e) => DIRECT_RPR.has(e.name) || (e.name === "w:rStyle" && stylesAfter.has(attr(e, "w:val"))));
  };
  const predicted = new Map(); // BEFORE index -> the paragraph Reject All gives, as XML (for the formatting count)

  const removedXml = (i) => {
    const { pPr, pieces } = plainA[i];
    const keep = pPr ? elements(pPr).filter((e) => KEEP_PPR.has(e.name) && (e.name !== "w:pStyle" || stylesAfter.has(attr(e, "w:val")))) : [];
    const keptPPr = keep.map(serialize).join("");
    const text = pieces.filter((x) => x.kind === "text").map((pc) => (stylesOk(pc.rPr) ? pc : { ...pc, rPr: "" }));
    predicted.set(i, `<w:p><w:pPr>${keptPPr}</w:pPr>${runsXml(text, false)}</w:p>`);
    const mark = `<w:del ${rev("del")}/>`;
    return `<w:p><w:pPr>${keptPPr}<w:rPr>${mark}</w:rPr></w:pPr>${text.length ? `<w:del ${rev("del")}>${runsXml(text, true)}</w:del>` : ""}</w:p>`;
  };

  const addedXml = (j) => {
    const node = LA.paras[j].node;
    const { pPr, pieces } = plainB[j];
    const mark = `<w:ins ${rev("ins")}/>`;
    let body = "";
    let group = [];
    const flush = () => {
      if (group.length) body += `<w:ins ${rev("ins")}>${runsXml(group, false)}</w:ins>`;
      group = [];
    };
    for (const pc of pieces) {
      if (pc.kind === "anchor") (flush(), (body += pc.raw));
      else group.push(pc);
    }
    flush();
    return `${openOf(node)}${markPPr(pPr, mark)}${body}</w:p>`;
  };

  const modifiedXml = (j, i) => {
    const node = LA.paras[j].node;
    const { pPr, pieces: pb } = plainB[j];
    const pa = plainA[i].pieces;
    const ops = diffRaw(A[i].text, B[j].text);
    const anchors = anchorsOf(pb);
    let ai = 0;
    let out = "";
    let rejected = ""; // the runs Reject All gives back: kept AFTER text plus restored BEFORE text
    const flushAnchors = (upto) => {
      while (ai < anchors.length && anchors[ai].at <= upto) out += anchors[ai++].raw;
    };
    const emitAfter = (s, e, wrap) => {
      const cuts = [s, ...anchors.map((x) => x.at).filter((x) => x > s && x < e), e];
      for (let c = 0; c + 1 < cuts.length; c++) {
        flushAnchors(cuts[c]);
        const runs = runsXml(slice(pb, cuts[c], cuts[c + 1]), false);
        if (!runs) continue;
        out += wrap ? `<w:ins ${rev("ins")}>${runs}</w:ins>` : runs;
        if (!wrap) rejected += runs;
      }
    };
    let aPos = 0;
    let bPos = 0;
    for (const [t, text] of ops) {
      const n = text.length;
      if (t === "=") (emitAfter(bPos, bPos + n, false), (aPos += n), (bPos += n));
      else if (t === "+") (emitAfter(bPos, bPos + n, true), (bPos += n));
      else {
        flushAnchors(bPos);
        // BEFORE's run properties when they are plain direct formatting; otherwise the AFTER properties next to the place
        const near = slice(pb, Math.max(0, bPos - 1), bPos + 1)[0]?.rPr ?? "";
        const pieces = slice(pa, aPos, aPos + n).map((pc) => (stylesOk(pc.rPr) ? pc : { ...pc, rPr: near }));
        out += `<w:del ${rev("del")}>${runsXml(pieces, true)}</w:del>`;
        rejected += runsXml(pieces, false);
        aPos += n;
      }
    }
    flushAnchors(Infinity);
    predicted.set(i, `<w:p>${pPr ? serialize(pPr) : ""}${rejected}</w:p>`);
    return `${openOf(node)}${pPr ? serialize(pPr) : ""}${out}</w:p>`;
  };

  // replace the changed AFTER paragraphs with lazily built markup and slot the removed BEFORE paragraphs in; serialize builds in order
  const addedSet = new Set(added);
  for (let j = 0; j < B.length; j++) {
    const node = LA.paras[j].node;
    const lazies = [];
    for (const i of insertBefore.get(j) || []) lazies.push({ t: "lazy", parent: node.parent, build: () => removedXml(i) });
    let self = null;
    if (addedSet.has(j)) self = { t: "lazy", parent: node.parent, build: () => addedXml(j) };
    else if (modified.has(j)) self = { t: "lazy", parent: node.parent, build: () => modifiedXml(j, modified.get(j)) };
    if (!lazies.length && !self) continue;
    const list = node.parent.kids;
    list.splice(list.indexOf(node), 1, ...lazies, self || node);
  }
  const xml = serialize(ta);

  // ---- the formatting count: paragraphs Reject All gives back with formatting other than BEFORE's (History's comparison)
  for (let i = 0; i < A.length; i++) if (!predicted.has(i) && pairA[i] >= 0) predicted.set(i, null);
  const order = [...predicted.keys()].filter((i) => predicted.get(i) !== null);
  const probe = order.length ? parseDocxParagraphs(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${order.map((i) => predicted.get(i)).join("")}</w:body></w:document>`) : [];
  const slot = new Map(order.map((i, k) => [i, k]));
  const fmtOf = (p) => ({ props: p.fmt, style: p.style, align: p.align });
  for (const [i, x] of predicted) {
    const back = x === null ? B[pairA[i]] : probe[slot.get(i)];
    if (normText(A[i].text) && fmtNote(fmtOf(A[i]), fmtOf(back))) counts.formatting++;
  }
  return { bytes: replaceEntry(afterBytes, "word/document.xml", xml), counts };
}
