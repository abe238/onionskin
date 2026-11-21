import { normText } from "./text.js";
import { walkXml } from "./xml.js";
import { openZip } from "./zip.js";
import { nodeChecks, validatePackage } from "./package.js";
import { parseDocxParagraphs } from "./docx.js";
import { fmtNote } from "./fmt.js";

// The check a tracked-changes copy must pass before it is written (docs/contracts/tracked-changes.md). Written from the markup contract,
// not from the builder: it shares no code with src/redline.js or src/xml-tree.js. It resolves the copy's revisions twice, the way Word's
// Accept All and Reject All do for the forms the contract allows, and compares the results with the two versions:
//   accept: paragraph for paragraph equal to AFTER on raw text, body path, style, alignment and run formatting; every other part byte-identical;
//   reject: equal to BEFORE on raw text and body path; the paragraphs whose formatting differs must number exactly `counts.formatting`.
// It is strict on purpose: any revision form the builder never writes fails the check, never passes it.

const MARK_PARENTS = new Set(["w:rPr"]);
const NEVER_WRITTEN = new Set(["w:pPrChange", "w:rPrChange", "w:moveFrom", "w:moveTo", "w:moveFromRangeStart", "w:moveToRangeStart", "w:cellIns", "w:cellDel", "w:cellMerge", "w:numberingChange", "w:sectPrChange", "w:tblPrChange", "w:tblGridChange", "w:trPrChange", "w:tcPrChange", "w:tblPrExChange", "w:customXmlInsRangeStart", "w:customXmlDelRangeStart"]);
const REV = new Set(["w:ins", "w:del"]);
const TEXTISH = new Set(["w:r", "w:t", "w:delText", "w:tab", "w:br", "w:cr", "w:drawing", "w:pict", "w:hyperlink", "w:fldSimple", "w:sdt", "w:smartTag", "w:instrText"]);
const REV_ATTRS = ["w:id", "w:author", "w:date"];

class CheckFail extends Error {}
const fail = (why) => {
  throw new CheckFail(why);
};

// ---- a small element tree of its own (not lossless: it only has to be read back by parseDocxParagraphs) ----------------------------

function parseDom(xml) {
  const root = { name: "#root", attrs: {}, kids: [] };
  const stack = [root];
  let head = "";
  const decl = /^\s*<\?xml[^?]*\?>/.exec(xml);
  if (decl) head = decl[0];
  walkXml(xml, {
    onOpen(name, attrs) {
      const el = { name, attrs, kids: [], parent: stack[stack.length - 1] };
      stack[stack.length - 1].kids.push(el);
      stack.push(el);
    },
    onClose(name) {
      const el = stack.pop();
      if (!el || el.name !== name) fail(`the copy's XML does not nest (${name})`);
    },
    onText(t) {
      if (stack.length > 1) stack[stack.length - 1].kids.push(t);
    },
  });
  if (stack.length !== 1) fail("the copy's XML is not closed");
  return { root, head };
}

const escText = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s) => escText(s).replace(/"/g, "&quot;");
function serialize(node) {
  if (typeof node === "string") return escText(node);
  if (node.name === "#root") return node.kids.map(serialize).join("");
  const attrs = Object.entries(node.attrs).map(([k, v]) => ` ${k}="${escAttr(v)}"`).join("");
  return node.kids.length ? `<${node.name}${attrs}>${node.kids.map(serialize).join("")}</${node.name}>` : `<${node.name}${attrs}/>`;
}
const elKids = (el) => el.kids.filter((k) => typeof k !== "string");
function* walk(el) {
  for (const k of el.kids) {
    if (typeof k === "string") continue;
    yield k;
    yield* walk(k);
  }
}
const hasText = (el) => [...walk(el)].some((d) => TEXTISH.has(d.name) && !inside(d, el, "w:pPr"));
function inside(d, top, name) {
  for (let p = d.parent; p && p !== top; p = p.parent) if (p.name === name) return true;
  return false;
}
const isMark = (el) => REV.has(el.name) && el.parent && MARK_PARENTS.has(el.parent.name) && el.parent.parent?.name === "w:pPr";

// ---- resolving ------------------------------------------------------------------------------------------------------

/**
 * Accept (keep = "ins") or reject (keep = "del") our revisions in a document.xml string; `isOurs(el)` says which revision elements are ours.
 * A paragraph whose own mark is removed (deleted mark on accept, inserted mark on reject) must be empty once its runs are resolved, and is
 * dropped: the next paragraph keeps its own properties (contract M7, M8). Throws CheckFail on any form the contract does not allow.
 */
function resolve(xml, keep, isOurs) {
  const { root, head } = parseDom(xml);
  const doomed = [];
  const visit = (el) => {
    for (let i = 0; i < el.kids.length; i++) {
      const k = el.kids[i];
      if (typeof k === "string") continue;
      if (NEVER_WRITTEN.has(k.name)) fail(`a revision form the copy never uses: ${k.name}`);
      if (REV.has(k.name) && isOurs(k)) {
        if (isMark(k)) {
          if (k.kids.length) fail("a paragraph-mark revision has content");
          const p = k.parent.parent.parent;
          if (p?.name !== "w:p") fail("a paragraph-mark revision outside a paragraph");
          if (k.name !== `w:${keep}`) doomed.push(p);
          el.kids.splice(i--, 1);
          continue;
        }
        if (k.name === `w:${keep}`) {
          // unwrap: w:ins keeps its runs on accept, w:del gives its runs back (as w:t) on reject
          for (const r of elKids(k)) if (r.name !== "w:r") fail(`a revision holds ${r.name}, not a run`);
          if (keep === "del") for (const d of walk(k)) if (d.name === "w:delText") d.name = "w:t";
          for (const r of k.kids) if (typeof r !== "string") r.parent = el;
          el.kids.splice(i, 1, ...k.kids);
          i--;
          continue;
        }
        el.kids.splice(i--, 1);
        continue;
      }
      visit(k);
    }
  };
  visit(root);
  for (const p of doomed) {
    if (hasText(p)) fail("a paragraph whose mark is removed still has text after resolving");
    const list = p.parent.kids;
    const at = list.indexOf(p);
    const next = list.slice(at + 1).find((x) => typeof x !== "string");
    if (next?.name !== "w:p") fail("a paragraph whose mark is removed has no paragraph after it");
    list.splice(at, 1);
  }
  const left = [...walk(root)].filter((d) => REV.has(d.name) && isOurs(d));
  if (left.length) fail("revisions are left after resolving");
  return head + serialize(root);
}

const allOurs = () => true;
export const acceptOurs = (xml, isOurs = allOurs) => resolve(xml, "ins", isOurs);
export const rejectOurs = (xml, isOurs = allOurs) => resolve(xml, "del", isOurs);

// ---- markup shape -------------------------------------------------------------------------------------------------

/** Every w:id="N" in an XML part. */
function idsIn(xml, into) {
  walkXml(xml, {
    onOpen(_, a) {
      if (a["w:id"] != null) into.add(a["w:id"]);
    },
  });
  return into;
}

function checkShape(root, isOurs, { author, date }) {
  const seen = new Set();
  const touched = new Set(); // paragraphs holding one of our revisions
  for (const el of walk(root)) {
    if (NEVER_WRITTEN.has(el.name)) fail(`a revision form the copy never uses: ${el.name}`);
    if (!REV.has(el.name) || !isOurs(el)) continue;
    const keys = Object.keys(el.attrs);
    if (keys.join(" ") !== REV_ATTRS.join(" ")) fail(`a revision's attributes are not w:id, w:author, w:date in that order: ${keys.join(" ")}`);
    if (!/^\d{1,10}$/.test(el.attrs["w:id"]) || seen.has(el.attrs["w:id"])) fail("a revision id is not a unique number");
    seen.add(el.attrs["w:id"]);
    if (el.attrs["w:author"] !== author) fail("a revision has another author");
    if (el.attrs["w:date"] !== date) fail("a revision has another date");
    let p = el.parent;
    while (p && p.name !== "w:p") p = p.parent;
    if (!p) fail("a revision outside a paragraph");
    touched.add(p);
    if (isMark(el)) {
      if (elKids(el.parent)[0] !== el) fail("a paragraph-mark revision is not first in the mark's properties");
      const pPr = el.parent.parent;
      const after = elKids(pPr).slice(elKids(pPr).indexOf(el.parent) + 1);
      if (after.some((x) => x.name !== "w:sectPr")) fail("the mark's properties are not in their place in the paragraph properties");
      if (elKids(p)[0] !== pPr) fail("the paragraph properties are not first in the paragraph");
    } else {
      if (el.parent !== p) fail("a run revision is not directly in its paragraph");
      for (const r of elKids(el)) {
        if (r.name !== "w:r") fail(`a revision holds ${r.name}, not a run`);
        for (const d of walk(r)) {
          if (el.name === "w:del" && d.name === "w:t") fail("deleted text is not in w:delText");
          if (el.name === "w:ins" && d.name === "w:delText") fail("inserted text is in w:delText");
        }
      }
    }
  }
  // Word drops leading and trailing spaces of a text element without xml:space="preserve"; the round trip below would not notice
  for (const p of touched)
    for (const d of walk(p)) {
      if (d.name !== "w:t" && d.name !== "w:delText") continue;
      const t = d.kids.join("");
      if (/^\s|\s$/.test(t) && d.attrs["xml:space"] !== "preserve") fail("a text piece with spaces at its edge is not marked to keep them");
    }
  return seen;
}

// ---- comparing ----------------------------------------------------------------------------------------------------

const fmtOf = (p) => ({ props: p.fmt, style: p.style, align: p.align });
const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);

/**
 * {ok: true} or {ok: false, why}. `before`, `after`, `out` are DOCX bytes; `counts.formatting` is what the builder said Reject All keeps;
 * `author` and `date` are what every one of our revisions must carry. Never throws on a bad copy: a crash in here is a failed check.
 */
export function verifyTracked({ before, after, out, counts, author, date }) {
  try {
    try {
      validatePackage(out, "docx");
    } catch (err) {
      fail(`the copy is not a valid package: ${err.message}`);
    }
    if (nodeChecks(after, out, "docx").some((f) => f.severity === "error")) fail("the package checks found an error");
    const za = openZip(after);
    const zb = openZip(before);
    const zo = openZip(out);
    if (zo.names.join("\0") !== za.names.join("\0")) fail("the copy's parts differ from the agent's version");
    for (const n of za.names) {
      if (n === "word/document.xml") continue;
      const sameRaw = zo.entries.get(n)?.method === za.entries.get(n)?.method && zo.raw(n).equals(za.raw(n));
      if (!sameRaw && !zo.read(n).equals(za.read(n))) fail(`a part other than the main text differs: ${n}`);
    }
    const xa = za.readText("word/document.xml");
    const xb = zb.readText("word/document.xml");
    const xo = zo.readText("word/document.xml");
    // revisions already in either version are not ours; every id in any part is an input id
    const inputIds = new Set();
    for (const z of [za, zb]) for (const n of z.names) if (/\.xml$/i.test(n)) idsIn(z.readText(n), inputIds);
    const isOurs = (el) => !inputIds.has(el.attrs["w:id"]);
    const ours = checkShape(parseDom(xo).root, isOurs, { author, date });
    if (!ours.size) fail("the copy has no revisions");
    const revCount = (x) => {
      let n = 0;
      walkXml(x, { onOpen: (name) => REV.has(name) && n++ });
      return n;
    };
    if (revCount(xo) !== ours.size + revCount(xa)) fail("the copy has revisions that are neither ours nor the file's own");
    let maxIn = 0;
    for (const v of inputIds) {
      if (/^\d+$/.test(v)) {
        const n = Number(v);
        if (n > maxIn) maxIn = n;
      }
    }
    for (const id of ours) if (Number(id) <= maxIn) fail("a revision id is not above every id in the file");

    const A = parseDocxParagraphs(xa);
    const acc = parseDocxParagraphs(acceptOurs(xo, isOurs));
    if (acc.length !== A.length) fail(`Accept All gives ${acc.length} paragraphs, the agent's version has ${A.length}`);
    acc.forEach((p, i) => {
      const q = A[i];
      if (p.text !== q.text) fail(`Accept All: paragraph ${i + 1} text differs`);
      if (!same(p.path, q.path)) fail(`Accept All: paragraph ${i + 1} is in another place`);
      if (!same(fmtOf(p), fmtOf(q))) fail(`Accept All: paragraph ${i + 1} formatting differs`);
    });
    const B = parseDocxParagraphs(xb);
    const rej = parseDocxParagraphs(rejectOurs(xo, isOurs));
    if (rej.length !== B.length) fail(`Reject All gives ${rej.length} paragraphs, the earlier version has ${B.length}`);
    let formatting = 0;
    rej.forEach((p, i) => {
      const q = B[i];
      if (p.text !== q.text) fail(`Reject All: paragraph ${i + 1} text differs`);
      if (!same(p.path, q.path)) fail(`Reject All: paragraph ${i + 1} is in another place`);
      if (normText(q.text) && fmtNote(fmtOf(q), fmtOf(p))) formatting++;
    });
    if (formatting !== (counts?.formatting ?? 0)) fail(`Reject All keeps ${formatting} formatting changes, the copy says ${counts?.formatting ?? 0}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, why: err instanceof CheckFail ? err.message : `the check stopped: ${String(err?.message || err).slice(0, 200)}` };
  }
}
