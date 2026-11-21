import { pathToFileURL } from "node:url";
import { engineNodePath } from "./ops/engine.js";
import { readBudget, tooMany, walkXml } from "./xml.js";
import { OCCURRENCE, affords, bigramCodes, diceOf, hitsOf, normPaid, normText, searchCost, similarity, spend, textHash, weigh, weightOf } from "./text.js";
import { openZip } from "./zip.js";
import { summarizeRuns } from "./fmt.js";
import { HAS_NON_PLAIN_WS, cuttable, normOccurrences } from "./pptx.js";

export { cuttable };

// One classifier for `protected`: the engine's own (default deny), bundled for Node. The batch, `apply` and the editor agree because they ask the same code.
const { protectReasons } = await import(pathToFileURL(engineNodePath()).href);

const OBJ = "￼"; // an inline object counts as one character, like the engine

const off = (v) => v === "0" || v === "false" || v === "off" || v === "none";
/** One direct run property (inside w:rPr) -> the normalized value History compares; "" = not set. */
function runProp(p, name, a) {
  const v = a["w:val"];
  if (name === "w:b" || name === "w:i" || name === "w:strike" || name === "w:dstrike") p[name === "w:b" ? "b" : name === "w:i" ? "i" : "strike"] = off(v) ? "" : "1";
  else if (name === "w:u") p.u = off(v) ? "" : v || "single";
  else if (name === "w:color") p.color = !v || v === "auto" ? "" : v.toUpperCase();
  else if (name === "w:sz") p.size = v || "";
  else if (name === "w:rFonts") p.font = a["w:ascii"] || a["w:hAnsi"] || "";
  else if (name === "w:highlight") p.hl = off(v) ? "" : v || "";
  else if (name === "w:rStyle") p.rs = v || "";
}

// ---- formatting as the merge reads it (src/merge.js), only collected with `detail` -------------------------------------------
// A run's direct properties in the values the engine's own formatting call takes, so a difference between two versions of a run is
// already the patch that turns one into the other. Whatever is not one of these (a character style, a theme color, shading, an
// attribute this file does not know) is kept as written in `rest`: it can be compared, never set.
const HIGHLIGHT = { yellow: "#ffff00", green: "#00ff00", cyan: "#00ffff", magenta: "#ff00ff", blue: "#0000ff", red: "#ff0000", darkBlue: "#000080", darkCyan: "#008080", darkGreen: "#008000", darkMagenta: "#800080", darkRed: "#800000", darkYellow: "#808000", darkGray: "#808080", lightGray: "#c0c0c0", black: "#000000", white: "#ffffff" };
const COMPANIONS = new Set(["w:bCs", "w:iCs", "w:szCs"]); // the engine writes these with b, i and sz
const only = (a, ...keys) => Object.keys(a).every((k) => keys.includes(k));
const written = (name, a) => `${name}{${Object.keys(a).sort().map((k) => `${k}=${a[k]}`).join(" ")}}`;
/** One direct child of a run's w:rPr -> [key, value] for the engine, or null when it has to be kept as written. */
function runSet(name, a) {
  const v = a["w:val"];
  if (name === "w:b" || name === "w:i" || name === "w:strike") return only(a, "w:val") ? [name.slice(2), !off(v)] : null;
  if (name === "w:u") return only(a, "w:val") ? ["u", v === undefined ? "single" : off(v) ? "none" : v] : null;
  if (name === "w:color") return only(a, "w:val") && (v === "auto" || /^[0-9a-fA-F]{6}$/.test(v || "")) ? ["color", v === "auto" ? "auto" : `#${v.toLowerCase()}`] : null;
  if (name === "w:sz") return only(a, "w:val") && /^\d{1,4}$/.test(v || "") ? ["sz", Number(v) / 2] : null;
  if (name === "w:rFonts") return a["w:ascii"] && only(a, "w:ascii", "w:hAnsi", "w:eastAsia", "w:cs") && Object.values(a).every((x) => x === a["w:ascii"]) ? ["font", a["w:ascii"]] : null;
  if (name === "w:highlight") return only(a, "w:val") && HIGHLIGHT[v] ? ["hl", HIGHLIGHT[v]] : null;
  if (name === "w:vertAlign") return only(a, "w:val") && (v === "superscript" || v === "subscript") ? ["va", v.slice(0, 3)] : null;
  return null;
}
// What one reading of a Word document may hold. The server reads a document on its own thread at Send, at each delivery to an agent, for a
// queued comment and at the end of a run, so these bound how long one such reading can keep it from answering anything else (the outside
// review: a part of 1 million runs held it 4.3 s, a run of 3 million attributes 2.4 s). A real report of about 1,000 pages has about 16,000
// paragraphs, 240,000 elements, 350,000 attributes and 3 million characters (measured: read in about 240 ms here).
export const MAX_PARAGRAPHS = 50_000;
export const MAX_ELEMENTS = 400_000;
export const MAX_ATTRIBUTES = 800_000;
export const MAX_TEXT = 8_000_000;
/** One reading's budget (src/xml.js readBudget), shared by the parts it walks. */
export const docxBudget = () => readBudget({ elements: MAX_ELEMENTS, attrs: MAX_ATTRIBUTES, text: MAX_TEXT });
const PPR_OWN = new Set(["w:pStyle", "w:jc", "w:numPr", "w:rPr", "w:sectPr"]); // read on their own, or not paragraph formatting the user sets
const RANGE = /^(.+)(Start|End)$/;

/**
 * Walks word/document.xml and lists every paragraph in document order.
 * `path` is the body ordinal path: [i] for a body-level paragraph (i counts body-level w:p / w:tbl, sdt content flattened)
 * and [i,row,col,k] for a paragraph directly in a table cell. Nested tables are listed with path null.
 * `text` keeps tabs and line breaks (so offsets line up with the engine); tracked deletions are excluded.
 * With `detail` (the merge) a paragraph also carries: `spans` [{n, set, rest}], one per run that holds text, covering `text` in order
 * (null when they do not add up to it); `list` {numId, ilvl} from its own w:numPr, else null; `ppr`, its other paragraph properties as
 * written; `sect`, it ends a section; `loose`, a bookmark, comment or other range starts or ends inside it without its other end.
 */
export function parseDocxParagraphs(xml, { detail = false, budget = docxBudget() } = {}) {
  const paragraphs = [];
  const stack = []; // {name, ...}
  let bodyIndex = -1;
  let tbl = null; // current top-level table context
  let tblDepth = 0;
  let tableCount = 0; // 1-based order among top-level tables (the label users read), unlike body_path[0] which counts every body item
  let cellK = 0;
  let cur = null;
  const revStack = [];
  let mcFallbackDepth = 0;
  const visible = () => !revStack.includes("del") && (revStack.length === 0 || revStack[revStack.length - 1] !== "moveFrom");
  let inT = false;
  let inInstr = false;
  let inBody = false;
  let run = null; // the open text run: {text, p: formatting} (History compares formatting; nothing else reads it)
  let rprDepth = 0;
  let pDepth = 0; // open w:p elements: 1 = the listed paragraph itself, more = a text box paragraph inside it
  let pprTop = null; // detail: the open direct child of the paragraph's own w:pPr
  let marks = null; // detail: range marks seen in the paragraph without their other end
  const info = { tableIndex: -1, row: -1, col: -1 };
  walkXml(xml, {
    onOpen(name, attrs) {
      stack.push(name);
      if (name === "mc:Fallback") {
        mcFallbackDepth++;
        return;
      }
      if (mcFallbackDepth > 0) return;
      if (name === "w:body") inBody = true;
      if (!inBody) return;
      if (name === "w:tbl" && pDepth === 0) {
        tblDepth++;
        if (tblDepth === 1) {
          bodyIndex++;
          info.tableIndex = bodyIndex;
          tableCount++;
          info.row = -1;
          info.col = -1;
        }
      } else if (name === "w:tr" && tblDepth === 1 && pDepth === 0) {
        info.row++;
        info.col = -1;
      } else if (name === "w:tc" && tblDepth === 1 && pDepth === 0) {
        info.col++;
        cellK = 0;
      } else if (name === "w:p") {
        pDepth++;
        if (pDepth > 1) return;
        let path = null;
        let tableNo = null;
        if (tblDepth === 0) {
          bodyIndex++;
          path = [bodyIndex];
        } else if (tblDepth === 1) {
          path = [info.tableIndex, info.row, info.col, cellK++];
          tableNo = tableCount;
        }
        if (paragraphs.length >= MAX_PARAGRAPHS) throw tooMany(budget, MAX_PARAGRAPHS, "paragraphs");
        cur = { ordinal: paragraphs.length, path, tableNo, paraId: /^[0-9A-Fa-f]{8}$/.test(attrs["w14:paraId"] || "") ? attrs["w14:paraId"].toUpperCase() : null, text: "", instr: "", protected: false, style: null, align: "", runs: [] };
        if (detail) (Object.assign(cur, { spans: [], list: null, ppr: [], sect: false, loose: false }), (marks = new Set()), (pprTop = null));
        paragraphs.push(cur);
      } else if (cur && pDepth === 1) {
        if (detail) {
          const n = stack.length;
          if (stack[n - 2] === "w:pPr" && stack[n - 3] === "w:p") {
            pprTop = name;
            if (name === "w:sectPr") cur.sect = true;
          }
          if (pprTop && !PPR_OWN.has(pprTop)) cur.ppr.push(written(name, attrs));
          else if (pprTop === "w:numPr" && stack[n - 2] === "w:numPr" && (name === "w:numId" || name === "w:ilvl")) (cur.list ||= { numId: "", ilvl: 0 })[name === "w:numId" ? "numId" : "ilvl"] = name === "w:numId" ? attrs["w:val"] || "" : Number(attrs["w:val"]) || 0;
          const mark = RANGE.exec(name);
          if (mark && "w:id" in attrs) {
            const key = `${mark[1]} ${attrs["w:id"]}`;
            if (!marks.delete(key)) marks.add(key);
          }
          // the open run's own w:rPr: a direct child is one property; anything deeper belongs to a property kept as written
          if (run && stack[run.depth] === "w:rPr" && n > run.depth + 1) {
            const kv = n === run.depth + 2 ? runSet(name, attrs) : null;
            if (kv) run.set[kv[0]] = kv[1];
            else if (!COMPANIONS.has(name) || n !== run.depth + 2) run.rest.push(written(name, attrs));
          }
        }
        if (name === "w:pStyle" && cur.style === null) cur.style = attrs["w:val"] || null;
        else if (name === "w:jc" && !cur.align && stack.includes("w:pPr")) cur.align = attrs["w:val"] || "";
        else if (name === "w:r" && !run) run = { text: false, p: {}, at: cur.text.length, depth: stack.length, set: {}, rest: [] };
        else if (name === "w:rPr") rprDepth++;
        else if (run && rprDepth === 1 && stack.includes("w:rPr")) runProp(run.p, name, attrs);
        if (name === "w:del") revStack.push("del");
        else if (name === "w:moveFrom") revStack.push("moveFrom");
        else if (name === "w:ins") revStack.push("ins");
        else if (name === "w:t" && visible()) (inT = true, run && (run.text = true));
        else if (name === "w:instrText") inInstr = true;
        else if (name === "w:tab" && visible()) cur.text += "\t";
        else if (name === "w:br" || name === "w:cr") {
          if (visible() && attrs["w:type"] !== "page" && attrs["w:type"] !== "column") cur.text += "\n";
        } else if (name === "w:drawing" || name === "w:pict") {
          if (visible()) cur.text += OBJ;
        }
      }
    },
    onText(t) {
      if (mcFallbackDepth > 0) return;
      if (cur && pDepth === 1 && inT) cur.text += t;
      else if (cur && pDepth === 1 && inInstr && cur.instr.length < 200) cur.instr += t;
    },
    onClose(name) {
      stack.pop();
      if (mcFallbackDepth > 0) {
        if (name === "mc:Fallback") mcFallbackDepth--;
        return;
      }
      if (name === "w:p") {
        pDepth--;
        if (pDepth > 0) return;
        if (cur) (cur.fmt = summarizeRuns(cur.runs), delete cur.runs);
        if (cur && detail) {
          if (cur.spans.reduce((n, x) => n + x.n, 0) !== cur.text.length) cur.spans = null;
          cur.ppr = cur.ppr.join(" ");
          cur.loose = marks.size > 0;
        }
        cur = null;
        revStack.length = 0;
      } else if (name === "w:tbl" && pDepth === 0) {
        tblDepth--;
      } else if (cur && pDepth === 1) {
        if (name === "w:t") inT = false;
        else if (name === "w:instrText") inInstr = false;
        else if (name === "w:del" || name === "w:moveFrom" || name === "w:ins") revStack.pop();
        else if (name === "w:rPr") rprDepth = Math.max(0, rprDepth - 1);
        else if (name === "w:r" && run) {
          if (run.text && cur) cur.runs.push(run.p);
          if (detail && cur && cur.text.length > run.at) cur.spans.push({ n: cur.text.length - run.at, set: run.set, rest: run.rest.join(" ") });
          run = null;
        }
        if (detail && name === pprTop && stack[stack.length - 1] === "w:pPr") pprTop = null;
      }
    },
  }, budget);
  for (const p of paragraphs) p.hash = textHash(p.text);
  const reasons = protectReasons(xml);
  // the engine lists paragraphs the same way; if the two ever disagree on the count, nothing can be trusted as editable
  paragraphs.forEach((p, i) => {
    const why = reasons.length === paragraphs.length ? reasons[i] : "unknown";
    p.protected = !!why;
    if (why) p.protectedReason = why;
  });
  return paragraphs;
}

const TOC_STYLE = /^toc\s?\d$/i;
/**
 * Why a paragraph is protected, in short code + plain words for the batch (`field: table of contents`, `equation`, `tracked formatting`),
 * and whether it is a generated table-of-contents entry. The engine's reason is the base; a field is named by its instruction keyword.
 */
export function protectInfo(p) {
  if (!p.protected) return null;
  const toc = /^\s*TOC\b/.test(p.instr || "") || TOC_STYLE.test(p.style || "");
  let reason = String(p.protectedReason || "unknown").replace(/^(a|an)\s+/, "");
  if (reason === "field") {
    const kw = /^\s*([A-Za-z]{2,12})\b/.exec(p.instr || "")?.[1]?.toUpperCase();
    reason = toc ? "field: table of contents" : kw ? `field: ${kw}` : "field";
  } else if (toc) reason = `${reason} (table of contents entry)`;
  return { reason, toc };
}

const HEADING = /^(heading\s?\d|title|subtitle)$/i;
// the nearest heading at or before each ordinal, found in one pass per reading: a scan up from every resolved comment was a pass over
// the paragraphs per comment, and the heading's text was normalized whole again each time, outside the budget
const HEADS = new WeakMap();
/** The text of the nearest heading above a paragraph (by paragraph style), or "" when there is none (or the budget cannot pay for it). */
export function headingBefore(paragraphs, ordinal) {
  if (!Number.isInteger(ordinal) || ordinal <= 0) return "";
  let at = HEADS.get(paragraphs);
  if (!at) {
    at = new Int32Array(paragraphs.length + 1);
    let last = -1;
    for (let i = 0; i < paragraphs.length; i++) {
      at[i] = last; // the heading strictly before paragraph i
      const p = paragraphs[i];
      if (p.style && HEADING.test(p.style) && p.text.trim()) last = i;
    }
    at[paragraphs.length] = last;
    HEADS.set(paragraphs, at);
  }
  const h = at[Math.min(ordinal, paragraphs.length)];
  if (h < 0) return "";
  const p = paragraphs[h];
  return spend(normCost(p)) ? norm(p).slice(0, 80) : "";
}

/** `detail` (the merge only): formatting per run and the paragraph's list, see parseDocxParagraphs; `list.kind` is "bullet", "number" or "other". */
export function readDocxParagraphs(bytes, { detail = false } = {}) {
  const zip = openZip(bytes);
  const xml = zip.readText("word/document.xml");
  if (xml == null) throw new Error("word/document.xml missing");
  const budget = docxBudget(); // the main part, the styles and the numbering of one reading share it
  const paragraphs = parseDocxParagraphs(xml, { detail, budget });
  const names = styleNames(zip.readText("word/styles.xml"), budget);
  if (names.size) for (const p of paragraphs) if (p.style && names.has(p.style)) p.styleName = names.get(p.style);
  if (detail && paragraphs.some((p) => p.list)) {
    const kinds = listKinds(zip.readText("word/numbering.xml"), budget);
    for (const p of paragraphs) if (p.list) p.list = p.list.numId && p.list.numId !== "0" ? { ...p.list, kind: kinds.get(p.list.numId) || "other" } : null; // numId 0 switches a style's list off
  }
  return paragraphs;
}

/**
 * w:numId -> "bullet" | "number" | "other", by the first level of its definition: the two kinds the editor's list buttons make and
 * the engine can set again. A list with level overrides, or one this cannot read, is "other".
 */
function listKinds(xml, budget) {
  const out = new Map();
  if (xml == null) return out;
  const fmt = new Map(); // abstractNumId -> numFmt of level 0
  const stack = [];
  let abs = null;
  let num = null;
  let lvl = null;
  try {
    walkXml(xml, {
      onOpen(name, a) {
        stack.push(name);
        const parent = stack[stack.length - 2];
        if (name === "w:abstractNum") abs = a["w:abstractNumId"] ?? null;
        else if (name === "w:lvl" && parent === "w:abstractNum") lvl = a["w:ilvl"];
        else if (name === "w:numFmt" && parent === "w:lvl" && abs != null && lvl === "0" && !fmt.has(abs)) fmt.set(abs, a["w:val"] || "");
        else if (name === "w:num") num = { id: a["w:numId"], abs: null, plain: true };
        else if (num && name === "w:abstractNumId" && parent === "w:num") num.abs = a["w:val"];
        else if (num && name === "w:lvlOverride") num.plain = false;
      },
      onClose(name) {
        stack.pop();
        if (name === "w:abstractNum") abs = null;
        else if (name === "w:num" && num) {
          const f = num.plain ? fmt.get(num.abs) : null;
          if (num.id) out.set(num.id, f === "bullet" ? "bullet" : f === "decimal" ? "number" : "other");
          num = null;
        }
      },
    }, budget);
  } catch {} // an unreadable numbering part: every list is "other", which is reported, never set
  return out;
}

/** w:styleId -> the style's display name ("heading 2" is shown as "Heading 2"); empty when styles.xml is missing or unreadable. */
function styleNames(xml, budget) {
  const out = new Map();
  if (xml == null) return out;
  let id = null;
  try {
    walkXml(xml, {
      onOpen(name, a) {
        if (name === "w:style") id = a["w:styleId"] || null;
        else if (name === "w:name" && id && !out.has(id) && a["w:val"]) out.set(id, a["w:val"].replace(/^./, (c) => c.toUpperCase()).slice(0, 60));
      },
      onClose(name) {
        if (name === "w:style") id = null;
      },
    }, budget);
  } catch {} // a damaged styles part only costs the readable style names
  return out;
}

const CTX = 40;
const PARA_TEXT_KEEP = 2000;

// ---- engine location -> durable anchor ----------------------------------------------------------------------

// A paragraph's normalized text, kept per paragraph object: every comment resolved against the same reading reuses it.
const NORM = new WeakMap();
const norm = (p) => {
  let v = NORM.get(p);
  if (v === undefined) NORM.set(p, (v = normText(p.text)));
  return v;
};
/** what norm(p) is about to read: the paragraph's text the first time (src/text.js weigh), nothing once it is kept (spent from the request's budget) */
const normCost = (p) => (NORM.has(p) ? 0 : weightOf(p));
// the byte tables a search is priced by (src/text.js hitsOf): of a paragraph's normalized text, and of its text as written
const NORM_HITS = new WeakMap();
const RAW_HITS = new WeakMap();
/** a native search for `q` in norm(p), which is already kept (src/text.js searchCost) */
const normSearch = (p, q) => searchCost(norm(p).length, q, hitsOf(NORM_HITS, p, norm(p), q));

// The paragraphs of one reading by w14:paraId and by text hash, in document order, built once: every anchor resolved against the reading
// looks its paragraph up instead of scanning them all.
const INDEX = new WeakMap();
function indexOf(paragraphs) {
  let ix = INDEX.get(paragraphs);
  if (ix) return ix;
  ix = { byId: new Map(), byHash: new Map(), byPath: new Map(), byTop: new Map(), noPath: [], tops: null };
  for (const p of paragraphs) {
    if (p.path) (ix.byTop.get(p.path[0]) || ix.byTop.set(p.path[0], []).get(p.path[0])).push(p);
    else ix.noPath.push(p);
    if (p.paraId) (ix.byId.get(p.paraId) || ix.byId.set(p.paraId, []).get(p.paraId)).push(p);
    (ix.byHash.get(p.hash) || ix.byHash.set(p.hash, []).get(p.hash)).push(p);
    if (p.path && !ix.byPath.has(p.path.join(","))) ix.byPath.set(p.path.join(","), p); // the first, as a scan finds it
  }
  INDEX.set(paragraphs, ix);
  return ix;
}

// The paragraphs in the order nearest() ranks them, one level of equal distance from the body block `want` at a time (document order
// within a level), those without a body position last: the first level holding a match holds the match a scan of all of them picks.
function* byDistance(paragraphs, ix, want) {
  if (!Number.isSafeInteger(want) || !ix.byTop.size) return yield paragraphs;
  // the body blocks that hold paragraphs, outward from `want` (a body of many tables and few paragraphs has gaps: they are not walked)
  const tops = (ix.tops ||= [...ix.byTop.keys()].sort((a, b) => a - b));
  let hi = 0;
  for (let lo = 0, top = tops.length; lo < top; ) {
    const mid = (lo + top) >> 1;
    if (tops[mid] < want) lo = mid + 1;
    else top = mid;
    hi = lo;
  }
  let lo = hi - 1;
  while (lo >= 0 || hi < tops.length) {
    const dl = lo >= 0 ? want - tops[lo] : Infinity;
    const dh = hi < tops.length ? tops[hi] - want : Infinity;
    const d = Math.min(dl, dh);
    const a = dl === d ? ix.byTop.get(tops[lo--]) : null;
    const b = dh === d ? ix.byTop.get(tops[hi++]) : null;
    yield a && b ? a.concat(b) : a || b;
  }
  if (ix.noPath.length) yield ix.noPath;
}

const BIGRAMS = new WeakMap();
const bigramsOf = (p) => {
  let v = BIGRAMS.get(p);
  if (!v) BIGRAMS.set(p, (v = bigramCodes(p.text)));
  return v;
};

function locate(paragraphs, { path, paraId, quote, prefix, text, prevHash, nextHash, dupCount, allowPath = false }) {
  // The page's quote and paragraph text (each can be a whole paragraph, per comment) are paid for before they are read: the text is
  // normalized up to four times below (its hash, its length, the slot's similarity, its bigrams). Past the budget a step that needs it
  // is skipped, and at Send the bare position still answers.
  const q = normPaid(quote) ?? "";
  if (text && !(affords(4 * text.length) && spend(4 * weigh(text)))) text = "";
  const want = path ? path[0] : null;
  const dist = (p) => (want == null || !p.path ? 1e6 : Math.abs(p.path[0] - want));
  // the nearest of `list` (smaller distance, then smaller ordinal) in one pass, charged to the request's budget: null when it runs out
  // (sorting a copy of 50,000 look-alikes for each of 500 anchors held the thread for 4 s, outside the budget)
  const nearest = (list) => {
    if (!spend(list.length * 3)) return null;
    let best = null;
    let bd = 0;
    for (const p of list) {
      const d = dist(p);
      if (!best || d < bd || (d === bd && p.ordinal < best.ordinal)) (best = p), (bd = d);
    }
    return best;
  };
  const nb = (p) => (prevHash && paragraphs[p.ordinal - 1]?.hash === prevHash ? 1 : 0) + (nextHash && paragraphs[p.ordinal + 1]?.hash === nextHash ? 1 : 0);
  const ix = indexOf(paragraphs);
  // 1. w14:paraId
  if (paraId) {
    const hit = ix.byId.get(paraId.toUpperCase()) || [];
    if (hit.length === 1) return { p: hit[0], method: "id" };
  }
  // 2. identical text; among duplicates prefer the one whose neighbors are unchanged, then the nearest.
  //    Text that was not unique when the anchor was captured ("TBD") is only trusted when a hit has an agreeing neighbor: otherwise
  //    the comment would jump to another paragraph with the same words. Anchors from before dupCount was stored count short text as ambiguous.
  let ambiguousHash = null;
  if (text) {
    const h = textHash(text);
    const hits = ix.byHash.get(h) || [];
    const ambiguous = (dupCount != null ? dupCount > 1 : normText(text).length < 20) && (prevHash || nextHash);
    // one pass over the hits for the best neighbor count, then the nearest of those (a document of 50,000 identical paragraphs and 500
    // anchors held the thread for 4 s: the scans and the sort were outside the budget). Spent up front, at about what a hit costs here.
    if (hits.length && spend(hits.length * 24)) {
      let best = null;
      let top = 0;
      let bd = 0;
      for (const p of hits) {
        const n = nb(p);
        const d = dist(p);
        if (!best || n > top || (n === top && (d < bd || (d === bd && p.ordinal < best.ordinal)))) (best = p), (top = n), (bd = d);
      }
      if (!ambiguous || top > 0) return { p: best, method: "hash" };
      ambiguousHash = h;
    }
  }
  // 3. same slot: both neighbors unchanged and exactly one paragraph sits between them (edited in place)
  if (prevHash && nextHash) {
    const after = ix.byHash.get(prevHash) || [];
    const slots = spend(after.length * 4) ? after.map((p) => paragraphs[p.ordinal + 1]).filter((p) => p && nb(p) === 2) : [];
    // the slot's whole text is compared: within the request's budget (a slot of 8 million characters, 50 comments: 56 s before)
    if (slots.length === 1 && (!text || (spend(2 * weightOf(slots[0]) + normCost(slots[0])) && (similarity(slots[0].text, text) >= 0.3 || (q && norm(slots[0]).includes(q)))))) return { p: slots[0], method: "neighbors" };
  }
  // steps 4 and 5 scan every paragraph: only within the budget of the anchors resolved together (src/text.js scanBudget), 16 units a
  // paragraph, and the text each step searches character by character
  // 4. exact quote. Ambiguous when the quote also occurs elsewhere and the prefix does not disambiguate: do not guess here. The
  //    paragraphs are read nearest first (byDistance): the answer is the nearest match, so the search stops at the first distance that
  //    has one (50 comments on a paragraph the agent changed, in 26,000 paragraphs, searched every paragraph 50 times).
  let read = true;
  if (q) {
    const pre = normPaid(prefix) ?? "";
    const longer = pre ? [pre + (pre.endsWith(" ") ? "" : " ") + q, pre + q] : null;
    const hits = [];
    const better = [];
    for (const level of byDistance(paragraphs, ix, want)) {
      for (const p of level) {
        if (!(read = spend(16 + normCost(p)) && spend(normSearch(p, q)))) break; // a native substring search (src/text.js searchCost)
        if (!norm(p).includes(q) || (ambiguousHash && p.hash === ambiguousHash)) continue; // look-alikes rejected in step 2 stay rejected
        hits.push(p);
        // two native substring searches per hit (src/text.js searchCost, as in the loop above)
        if (longer && spend(2 * normSearch(p, longer[1])) && (norm(p).includes(longer[0]) || norm(p).includes(longer[1]))) better.push(p);
      }
      if (!read) break;
      const found = better.length ? better : !pre && !text ? hits : [];
      if (found.length) {
        const p = nearest(found);
        if (p) return { p, method: "quote" };
      }
    }
    if (read && hits.length === 1) {
      const p = nearest(hits);
      if (p) return { p, method: "quote" };
    }
  } else read = spend(paragraphs.length * 16);
  // 5. fuzzy: similarity to the remembered text (or the quote), neighbors count in favor
  const probe = text || q;
  let spent = !read;
  if (probe && read) {
    // The best candidate must clearly beat the runner-up: in templated text a deleted paragraph looks like its siblings,
    // and "moved or removed" is a better answer than attaching the comment to the wrong one.
    // the two best candidates only, found in one pass: the answer needs the winner and the runner-up, never the order of the rest
    let best = null;
    let second = null;
    let count = 0;
    const P = bigramCodes(text || q); // the probe's bigrams once; each paragraph's are kept with it (bigramsOf)
    const n = P.codes.length;
    for (const p of paragraphs) {
      if (ambiguousHash && p.hash === ambiguousHash) continue; // rejected above: a look-alike elsewhere is not this paragraph
      let sim = 0;
      if (text) {
        if (!BIGRAMS.has(p) && !spend(weightOf(p))) {
          spent = true; // its bigrams are read (and sorted) once per reading: the first time costs its text
          break;
        }
        const B = bigramsOf(p);
        // 0.6 needs the shorter at least 3/7 of the longer (Dice is at most 2 min / (m + n)): skip the others without comparing
        const m = B.codes.length;
        if (P.short === null && B.short === null && (Math.min(m, n) * 7 < Math.max(m, n) * 3)) continue;
        if (!spend(m + n)) {
          spent = true; // the budget is spent: "moved or removed" (src/text.js scanBudget), or the bare position at Send
          break;
        }
        sim = diceOf(B, P);
      } else if (norm(p).length) {
        if (!spend(normCost(p) + q.length + 40 + n)) {
          spent = true;
          break;
        }
        sim = diceOf(bigramCodes(norm(p).slice(0, q.length + 40)), P);
      }
      if (sim >= 0.6) {
        const c = { p, sim, score: sim + nb(p) * 0.1 - dist(p) * 1e-6 }; // distance only breaks ties
        count++;
        if (!best || c.score > best.score) (second = best), (best = c);
        else if (!second || c.score > second.score) second = c;
      }
    }
    if (!spent && best && (count === 1 || best.score - second.score >= 0.04)) return { p: best.p, method: "fuzzy", score: Math.round(best.sim * 100) / 100 };
  }
  // At Send time the browser's own index is as fresh as the bytes, so the bare position is acceptable.
  // After a reload it never is (an insert above shifts it): resolveDurable does not pass allowPath.
  if (allowPath && path) {
    const hit = ix.byPath.get(path.join(",")); // by lookup, not a scan: the bare position must still answer once the budget is spent
    if (hit) return { p: hit, method: "path" };
  }
  return null;
}

/**
 * Browser engine location (as sent at Send) -> durable anchor, resolved against the WRITTEN bytes.
 * `loc` = {blockPath, paraId, start, end}; `quote/prefix/suffix` from the engine selection/hitTest.
 * Returns null when the paragraph cannot be found.
 */
export function durableFromEngine(paragraphs, loc, ctx = {}) {
  const hit = locate(paragraphs, { path: loc.blockPath, paraId: loc.paraId, quote: ctx.quote, prefix: ctx.prefix, text: ctx.paraText, allowPath: true });
  if (!hit) return null;
  return durableFor(paragraphs, hit.p, loc.blockPath ? loc.blockPath[0] : null, ctx, loc);
}

/**
 * Offsets of the non-overlapping occurrences of `q` in `text` (the first `max` of them), or null when the request's budget runs out: the
 * search is counted as a native substring search (src/text.js searchCost) and each occurrence found at OCCURRENCE.
 */
// the complete list of a quote's occurrences in a paragraph, kept per paragraph of a reading for the last few quotes (rule: what is
// derived from the same paragraph is computed once per reading): 50 comments on one selection of a repeated text listed the same
// 395,000 occurrences 50 times. Ceiling: OCC_KEEP quotes per paragraph, the oldest dropped first.
const OCC = new WeakMap();
const OCC_KEEP = 16;
function occurrencesIn(p, q) {
  let m = OCC.get(p);
  const hit = m?.get(q);
  if (hit) return hit;
  const occ = occurrences(p, q);
  if (occ) {
    if (!m) OCC.set(p, (m = new Map()));
    if (m.size >= OCC_KEEP) m.delete(m.keys().next().value);
    m.set(q, occ);
  }
  return occ;
}
function occurrences(p, q, max = Infinity) {
  const { text } = p;
  if (!spend(searchCost(text.length, q, hitsOf(RAW_HITS, p, text, q)))) return null;
  const out = [];
  for (let i = text.indexOf(q); i >= 0 && out.length < max; i = text.indexOf(q, i + q.length)) {
    if (!spend(OCCURRENCE)) return null;
    out.push(i);
  }
  return out;
}

/**
 * normText(text).slice(0, n), reading only as much of the text as that needs (windows cut as endsWithNorm cuts them), each character read
 * spent from the budget; null past it. A comment's paragraph text is kept to 2,000 characters, and normalizing a whole paragraph of
 * 8 million characters for each of 50 comments held the thread for seconds.
 */
function normHead(text, n) {
  for (let size = 2 * n + 8; ; size *= 2) {
    const e = cutNear(text, Math.min(text.length, size), 1);
    if (e === null || !spend(weigh(text.slice(0, e)))) return null;
    const head = normText(text.slice(0, e));
    if (e === text.length || head.length > n) return head.slice(0, n);
  }
}

// normText(text.slice(0, at)).endsWith(prefix) and normText(text.slice(from)).startsWith(suffix), reading only as much of the text as
// the prefix or suffix needs. A window is cut only where nothing on one side changes how the other side normalizes (`cuttable`), so the
// window normalizes to exactly the end (or the start) of what the whole text normalizes to, give or take one space where it was cut.
// Once the window holds at least as many normalized characters as the prefix, it answers for the whole text; else it doubles.
// Every character read (the walk to a cut and the window normalized) is spent from the budget of the request (src/text.js): null when it
// runs out. An outside review: CJK text has no character below U+0300, every window grew to the whole paragraph, 3.65 s for one anchor.
/** The nearest place at or before (dir -1) or after (dir 1) i where a window may be cut, each character walked spent; null past the budget. */
function cutNear(text, i, dir) {
  let n = 0;
  while (!cuttable(text, i)) {
    i += dir;
    if (++n % 1024 === 0 && !spend(1024)) return null;
  }
  return spend(n % 1024) ? i : null;
}
export function endsWithNorm(text, at, prefix) {
  for (let size = 2 * prefix.length + 8; ; size *= 2) {
    const w = cutNear(text, Math.max(0, at - size), -1);
    if (w === null || !spend(weigh(text.slice(w, at)))) return null;
    const n = normText(text.slice(w, at));
    if (w === 0 || n.length >= prefix.length) return n.endsWith(prefix);
  }
}
export function startsWithNorm(text, from, suffix) {
  for (let size = 2 * suffix.length + 8; ; size *= 2) {
    const e = cutNear(text, Math.min(text.length, from + size), 1);
    if (e === null || !spend(weigh(text.slice(from, e)))) return null;
    const n = normText(text.slice(from, e));
    if (e === text.length || n.length >= suffix.length) return n.startsWith(suffix);
  }
}

/**
 * Which occurrence of a repeated quote a selection or a stored anchor means. Prefix and suffix are the normalized text around it;
 * `nth` is the occurrence index remembered at capture. Returns {at: the offset, k: which occurrence it is}, or {at: -1, k: null} when the
 * text does not occur or the budget ran out.
 */
/** does the text around the occurrence at `at` (of `qLen` UTF-16 units) read as prefix and suffix (normalized, as an anchor keeps them)? null: the budget ran out */
function fitsAt(text, qLen, at, { prefix = "", suffix = "" }) {
  prefix = String(prefix || "").slice(-CTX); // what an anchor keeps (durableFor); a longer one from elsewhere is read as its last CTX
  suffix = String(suffix || "").slice(0, CTX);
  const pre = !prefix || endsWithNorm(text, at, prefix);
  if (pre === null) return null;
  const suf = pre && (!suffix || startsWithNorm(text, at + qLen, suffix));
  return suf === null ? null : !!(pre && suf);
}
function pickOccurrence(p, q, opts = {}) {
  const text = p.text;
  // the remembered occurrence first, listing only the occurrences up to it: when its surroundings still fit, it is the answer every rule
  // of pickFrom gives, and the others need not be listed or read (an outside review: 300,000 "a" with nth 150,000 lost its offsets
  // under the budget, though the remembered one still fit)
  const { nth = null } = opts;
  // only an index of the occurrences is one: a selection that starts between two of them ("aa" at offset 1 of "aaaa", which the
  // non-overlapping search does not list) was stored with nth -1, and occ[-1] (undefined) made the window readers loop forever on the
  // server's thread, the budget never asked (a window of no characters costs nothing)
  const remembered = Number.isInteger(nth) && nth >= 0 ? nth : null;
  if (remembered !== null && (opts.prefix || opts.suffix)) {
    const head = occurrences(p, q, remembered + 1);
    if (head === null) return { at: -1, k: null };
    if (head.length === remembered + 1) {
      const ok = fitsAt(text, q.length, head[remembered], opts);
      if (ok === null) return { at: -1, k: null };
      if (ok) return { at: head[remembered], k: remembered };
    }
  }
  const occ = occurrencesIn(p, q);
  const at = occ?.length ? pickFrom(text, q.length, occ, { ...opts, nth: remembered }) : -1;
  return at < 0 ? { at: -1, k: null } : { at, k: occ.indexOf(at) };
}
function pickNormOccurrence(p, q, opts = {}) {
  const occ = normOccurrences(p, q);
  if (!occ?.length) return { at: -1, len: 0, k: null };
  let { nth = null } = opts;
  if (!(Number.isInteger(nth) && nth >= 0 && nth < occ.length)) nth = null;
  const prefix = String(opts.prefix || "").slice(-CTX);
  const suffix = String(opts.suffix || "").slice(0, CTX);
  if ((prefix || suffix) && occ.length > 1 && !spend(occ.length * 2 * (prefix.length + suffix.length + 16))) return { at: -1, len: 0, k: null };
  const guarded = [];
  for (let i = 0; i < occ.length; i++) {
    const o = occ[i];
    const ok = fitsAt(p.text, o.end - o.start, o.start, { prefix, suffix });
    if (ok === null) return { at: -1, len: 0, k: null };
    if (ok) guarded.push(i);
  }
  let idx;
  if (guarded.length === 1) idx = guarded[0];
  else if (nth != null && guarded.includes(nth)) idx = nth;
  else if (Number.isInteger(opts.hintStart) && guarded.length) {
    idx = guarded.reduce((best, i) => (Math.abs(occ[i].start - opts.hintStart) < Math.abs(occ[best].start - opts.hintStart) ? i : best), guarded[0]);
  } else if (guarded.length) idx = guarded[0];
  else idx = nth != null ? nth : 0;
  const hit = occ[idx];
  return { at: hit.start, len: hit.end - hit.start, k: idx };
}
function pickFrom(text, qLen, occ, { prefix = "", suffix = "", nth = null, hintStart = null }) {
  if (!(Number.isInteger(nth) && nth >= 0 && nth < occ.length)) nth = null;
  prefix = String(prefix || "").slice(-CTX);
  suffix = String(suffix || "").slice(0, CTX);
  const fits = (at) => fitsAt(text, qLen, at, { prefix, suffix });
  // each occurrence reads about CTX characters on each side, out of the budget of the request (src/text.js): a paragraph of 100,000
  // "a" read the whole text before every one of them and took 10 seconds in an outside review. Past the budget, no offset.
  if ((prefix || suffix) && occ.length > 1 && !spend(occ.length * 2 * (prefix.length + suffix.length + 16))) return -1;
  const guarded = [];
  for (const at of occ) {
    const ok = fits(at);
    if (ok === null) return -1;
    if (ok) guarded.push(at);
  }
  if (guarded.length === 1) return guarded[0];
  if (nth != null && nth < occ.length && guarded.includes(occ[nth])) return occ[nth];
  if (Number.isInteger(hintStart) && guarded.length) {
    return guarded.reduce((best, at) => (Math.abs(at - hintStart) < Math.abs(best - hintStart) ? at : best), guarded[0]);
  }
  if (guarded.length) return guarded[0];
  return nth != null && nth < occ.length ? occ[nth] : occ[0];
}

function durableFor(paragraphs, p, engineTop, ctx, loc = {}) {
  // the page's quote, prefix and suffix, paid for before they are normalized; past the budget the anchor is the paragraph alone
  const q = normPaid(ctx.quote) ?? "";
  const prefix = (normPaid(ctx.prefix) ?? "").slice(-CTX);
  const suffix = (normPaid(ctx.suffix) ?? "").slice(0, CTX);
  let start = null;
  let end = null;
  let nth = null;
  if (q) {
    // the engine's own offsets when they point at the quote; else the occurrence whose surroundings match prefix and suffix
    const hintStart = Number.isInteger(loc.start) ? loc.start : null;
    const preferNorm = (ctx.quote !== q && ctx.quote.trim() !== q) || (q.includes(" ") && HAS_NON_PLAIN_WS.test(p.text));
    const own = hintStart !== null && Number.isInteger(loc.end) && p.text.slice(loc.start, loc.end) === ctx.quote;
    let picked;
    if (own) {
      let k = -1;
      if (preferNorm) {
        const nocc = normOccurrences(p, q);
        if (nocc) {
          k = nocc.findIndex((o) => o.start === loc.start && o.end === loc.end);
          if (k < 0) k = nocc.findIndex((o) => o.start >= loc.start && o.end <= loc.end);
        }
      } else {
        k = occurrencesIn(p, ctx.quote)?.indexOf(loc.start) ?? -1;
      }
      picked = { at: loc.start, k: k >= 0 ? k : null, len: ctx.quote.length };
    } else if (preferNorm) {
      picked = pickNormOccurrence(p, q, { prefix, suffix, hintStart });
    } else {
      picked = { ...pickOccurrence(p, ctx.quote, { prefix, suffix, hintStart }), len: ctx.quote.length };
      if (picked.at < 0) picked = pickNormOccurrence(p, q, { prefix, suffix, hintStart });
    }
    if (picked.at >= 0) {
      start = picked.at;
      end = picked.at + picked.len;
      nth = picked.k;
    }
  }
  return {
    format: "docx",
    paraId: p.paraId,
    path: p.path,
    tableNo: p.tableNo ?? null,
    ordinal: p.ordinal,
    protected: !!p.protected,
    ...(p.protected ? { protectInfo: protectInfo(p) } : {}),
    textHash: p.hash,
    prevHash: paragraphs[p.ordinal - 1]?.hash || null,
    nextHash: paragraphs[p.ordinal + 1]?.hash || null,
    dupCount: indexOf(paragraphs).byHash.get(p.hash)?.length ?? 0,
    paraText: normHead(p.text, PARA_TEXT_KEEP) ?? "",
    quote: q,
    prefix,
    suffix,
    start,
    end,
    nth,
    // difference between the engine's Block[] index and our body ordinal at capture time (section breaks etc.)
    engineDelta: engineTop != null && p.path ? engineTop - p.path[0] : 0,
  };
}

/** Re-resolve a durable anchor against new bytes: id, then hash, then exact quote, then fuzzy. */
export function resolveDurable(paragraphs, d) {
  if (!d) return { method: "none" };
  const hit = locate(paragraphs, { path: d.path, paraId: d.paraId, quote: d.quote, prefix: d.prefix, text: d.paraText, prevHash: d.prevHash, nextHash: d.nextHash, dupCount: d.dupCount });
  if (!hit) return { method: "none" };
  const p = hit.p;
  const q = d.quote || "";
  let start = null;
  let end = null;
  const ctxOpts = { prefix: d.prefix ?? d.before ?? "", suffix: d.suffix ?? d.after ?? "", nth: d.nth ?? d.occ ?? null };
  const preferNorm = !!q && q === normText(q) && q.includes(" ") && HAS_NON_PLAIN_WS.test(p.text);
  let at = -1;
  let len = q.length;
  let k = null;
  if (q) {
    if (preferNorm) {
      const picked = pickNormOccurrence(p, q, ctxOpts);
      if (picked.at >= 0) ({ at, len, k } = picked);
      else ({ at, k } = pickOccurrence(p, q, ctxOpts));
    } else {
      ({ at, k } = pickOccurrence(p, q, ctxOpts));
      if (at < 0 || (Number.isInteger(ctxOpts.nth) && ctxOpts.nth > 0 && k !== ctxOpts.nth)) {
        const picked = pickNormOccurrence(p, q, ctxOpts);
        if (picked.at >= 0) ({ at, len, k } = picked);
      }
    }
  }
  if (at >= 0) {
    start = at;
    end = at + len;
  }
  return { method: hit.method, score: hit.score, ordinal: p.ordinal, path: p.path, tableNo: p.tableNo ?? null, paraId: p.paraId, textHash: p.hash, protected: !!p.protected, ...(p.protected ? { protectInfo: protectInfo(p) } : {}), dupCount: indexOf(paragraphs).byHash.get(p.hash)?.length ?? 0, nth: at >= 0 ? k : null, prevHash: paragraphs[p.ordinal - 1]?.hash || null, nextHash: paragraphs[p.ordinal + 1]?.hash || null, text: normHead(p.text, PARA_TEXT_KEEP) ?? "", start, end, engineDelta: d.engineDelta || 0 };
}
