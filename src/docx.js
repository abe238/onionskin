import { pathToFileURL } from "node:url";
import { engineNodePath } from "./ops/engine.js";
import { walkXml } from "./xml.js";
import { normText, similarity, textHash } from "./text.js";
import { openZip } from "./zip.js";
import { summarizeRuns } from "./fmt.js";

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
export function parseDocxParagraphs(xml, { detail = false } = {}) {
  const paragraphs = [];
  const stack = []; // {name, ...}
  let bodyIndex = -1;
  let tbl = null; // current top-level table context
  let tblDepth = 0;
  let tableCount = 0; // 1-based order among top-level tables (the label users read), unlike body_path[0] which counts every body item
  let cellK = 0;
  let cur = null;
  let delDepth = 0;
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
      if (name === "w:body") inBody = true;
      if (!inBody) return;
      if (name === "w:tbl") {
        tblDepth++;
        if (tblDepth === 1) {
          bodyIndex++;
          info.tableIndex = bodyIndex;
          tableCount++;
          info.row = -1;
          info.col = -1;
        }
      } else if (name === "w:tr" && tblDepth === 1) {
        info.row++;
        info.col = -1;
      } else if (name === "w:tc" && tblDepth === 1) {
        info.col++;
        cellK = 0;
      } else if (name === "w:p") {
        pDepth++;
        const nested = stack.slice(0, -1).includes("w:p"); // a text box paragraph inside a paragraph
        if (nested) return;
        let path = null;
        let tableNo = null;
        if (tblDepth === 0) {
          bodyIndex++;
          path = [bodyIndex];
        } else if (tblDepth === 1) {
          path = [info.tableIndex, info.row, info.col, cellK++];
          tableNo = tableCount;
        }
        cur = { ordinal: paragraphs.length, path, tableNo, paraId: /^[0-9A-Fa-f]{8}$/.test(attrs["w14:paraId"] || "") ? attrs["w14:paraId"].toUpperCase() : null, text: "", instr: "", protected: false, style: null, align: "", runs: [] };
        if (detail) (Object.assign(cur, { spans: [], list: null, ppr: [], sect: false, loose: false }), (marks = new Set()), (pprTop = null));
        paragraphs.push(cur);
      } else if (cur) {
        if (detail) {
          const n = stack.length;
          if (pDepth === 1 && stack[n - 2] === "w:pPr" && stack[n - 3] === "w:p") {
            pprTop = name;
            if (name === "w:sectPr") cur.sect = true;
          }
          if (pprTop && !PPR_OWN.has(pprTop)) cur.ppr.push(written(name, attrs));
          else if (pprTop === "w:numPr" && pDepth === 1 && stack[n - 2] === "w:numPr" && (name === "w:numId" || name === "w:ilvl")) (cur.list ||= { numId: "", ilvl: 0 })[name === "w:numId" ? "numId" : "ilvl"] = name === "w:numId" ? attrs["w:val"] || "" : Number(attrs["w:val"]) || 0;
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
        if (name === "w:del") delDepth++;
        else if (name === "w:t" && delDepth === 0) (inT = true, run && (run.text = true));
        else if (name === "w:instrText") inInstr = true;
        else if (name === "w:tab" && delDepth === 0) cur.text += "\t";
        else if (name === "w:br" || name === "w:cr") {
          if (delDepth === 0 && attrs["w:type"] !== "page" && attrs["w:type"] !== "column") cur.text += "\n";
        } else if (name === "w:drawing" || name === "w:pict") {
          if (delDepth === 0) cur.text += OBJ;
        }
      }
    },
    onText(t) {
      if (cur && inT) cur.text += t;
      else if (cur && inInstr && cur.instr.length < 200) cur.instr += t;
    },
    onClose(name) {
      stack.pop();
      if (name === "w:t") inT = false;
      else if (name === "w:instrText") inInstr = false;
      else if (name === "w:del") delDepth = Math.max(0, delDepth - 1);
      else if (name === "w:tbl") tblDepth--;
      else if (name === "w:rPr") rprDepth = Math.max(0, rprDepth - 1);
      else if (name === "w:r" && run) {
        if (run.text && cur) cur.runs.push(run.p);
        if (detail && cur && cur.text.length > run.at) cur.spans.push({ n: cur.text.length - run.at, set: run.set, rest: run.rest.join(" ") });
        run = null;
      } else if (name === "w:p") {
        pDepth--;
        if (stack.includes("w:p")) return;
        if (cur) (cur.fmt = summarizeRuns(cur.runs), delete cur.runs);
        if (cur && detail) {
          if (cur.spans.reduce((n, x) => n + x.n, 0) !== cur.text.length) cur.spans = null;
          cur.ppr = cur.ppr.join(" ");
          cur.loose = marks.size > 0;
        }
        cur = null;
      }
      if (detail && name === pprTop && stack[stack.length - 1] === "w:pPr") pprTop = null;
    },
  });
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
/** The text of the nearest heading above a paragraph (by paragraph style), or "" when there is none. */
export function headingBefore(paragraphs, ordinal) {
  for (let i = ordinal - 1; i >= 0; i--) if (paragraphs[i].style && HEADING.test(paragraphs[i].style) && paragraphs[i].text.trim()) return normText(paragraphs[i].text).slice(0, 80);
  return "";
}

/** `detail` (the merge only): formatting per run and the paragraph's list, see parseDocxParagraphs; `list.kind` is "bullet", "number" or "other". */
export function readDocxParagraphs(bytes, { detail = false } = {}) {
  const zip = openZip(bytes);
  const xml = zip.readText("word/document.xml");
  if (xml == null) throw new Error("word/document.xml missing");
  const paragraphs = parseDocxParagraphs(xml, { detail });
  const names = styleNames(zip.readText("word/styles.xml"));
  if (names.size) for (const p of paragraphs) if (p.style && names.has(p.style)) p.styleName = names.get(p.style);
  if (detail && paragraphs.some((p) => p.list)) {
    const kinds = listKinds(zip.readText("word/numbering.xml"));
    for (const p of paragraphs) if (p.list) p.list = p.list.numId && p.list.numId !== "0" ? { ...p.list, kind: kinds.get(p.list.numId) || "other" } : null; // numId 0 switches a style's list off
  }
  return paragraphs;
}

/**
 * w:numId -> "bullet" | "number" | "other", by the first level of its definition: the two kinds the editor's list buttons make and
 * the engine can set again. A list with level overrides, or one this cannot read, is "other".
 */
function listKinds(xml) {
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
    });
  } catch {} // an unreadable numbering part: every list is "other", which is reported, never set
  return out;
}

/** w:styleId -> the style's display name ("heading 2" is shown as "Heading 2"); empty when styles.xml is missing or unreadable. */
function styleNames(xml) {
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
    });
  } catch {} // a damaged styles part only costs the readable style names
  return out;
}

const CTX = 40;
const PARA_TEXT_KEEP = 2000;

// ---- engine location -> durable anchor ----------------------------------------------------------------------

function locate(paragraphs, { path, paraId, quote, prefix, text, prevHash, nextHash, dupCount, allowPath = false }) {
  const q = normText(quote || "");
  const want = path ? path[0] : null;
  const dist = (p) => (want == null || !p.path ? 1e6 : Math.abs(p.path[0] - want));
  const nearest = (list) => list.slice().sort((a, b) => dist(a) - dist(b) || a.ordinal - b.ordinal)[0];
  const nb = (p) => (prevHash && paragraphs[p.ordinal - 1]?.hash === prevHash ? 1 : 0) + (nextHash && paragraphs[p.ordinal + 1]?.hash === nextHash ? 1 : 0);
  // 1. w14:paraId
  if (paraId) {
    const hit = paragraphs.filter((p) => p.paraId === paraId.toUpperCase());
    if (hit.length === 1) return { p: hit[0], method: "id" };
  }
  // 2. identical text; among duplicates prefer the one whose neighbors are unchanged, then the nearest.
  //    Text that was not unique when the anchor was captured ("TBD") is only trusted when a hit has an agreeing neighbor: otherwise
  //    the comment would jump to another paragraph with the same words. Anchors from before dupCount was stored count short text as ambiguous.
  let ambiguousHash = null;
  if (text) {
    const h = textHash(text);
    const hits = paragraphs.filter((p) => p.hash === h);
    const ambiguous = (dupCount != null ? dupCount > 1 : normText(text).length < 20) && (prevHash || nextHash);
    if (hits.length && (!ambiguous || hits.some((p) => nb(p) > 0))) return { p: nearest(hits.filter((p) => nb(p) === Math.max(...hits.map(nb)))), method: "hash" };
    if (hits.length) ambiguousHash = h;
  }
  // 3. same slot: both neighbors unchanged and exactly one paragraph sits between them (edited in place)
  if (prevHash && nextHash) {
    const slots = paragraphs.filter((p) => nb(p) === 2);
    if (slots.length === 1 && (!text || similarity(slots[0].text, text) >= 0.3 || (q && normText(slots[0].text).includes(q)))) return { p: slots[0], method: "neighbors" };
  }
  // 4. exact quote. Ambiguous when the quote also occurs elsewhere and the prefix does not disambiguate: do not guess here.
  if (q) {
    const hits = paragraphs.filter((p) => normText(p.text).includes(q) && !(ambiguousHash && p.hash === ambiguousHash)); // look-alikes rejected in step 2 stay rejected
    if (hits.length) {
      const pre = normText(prefix || "");
      const better = pre ? hits.filter((p) => normText(p.text).includes(pre + (pre.endsWith(" ") ? "" : " ") + q) || normText(p.text).includes(pre + q)) : [];
      if (better.length) return { p: nearest(better), method: "quote" };
      if (hits.length === 1 || (!pre && !text)) return { p: nearest(hits), method: "quote" };
    }
  }
  // 5. fuzzy: similarity to the remembered text (or the quote), neighbors count in favor
  const probe = text || q;
  if (probe) {
    // The best candidate must clearly beat the runner-up: in templated text a deleted paragraph looks like its siblings,
    // and "moved or removed" is a better answer than attaching the comment to the wrong one.
    const scored = [];
    for (const p of paragraphs) {
      if (ambiguousHash && p.hash === ambiguousHash) continue; // rejected above: a look-alike elsewhere is not this paragraph
      const sim = text ? similarity(p.text, text) : normText(p.text).length ? similarity(normText(p.text).slice(0, q.length + 40), q) : 0;
      if (sim >= 0.6) scored.push({ p, sim, score: sim + nb(p) * 0.1 - dist(p) * 1e-6 }); // distance only breaks ties
    }
    scored.sort((a, b) => b.score - a.score);
    if (scored.length && (scored.length === 1 || scored[0].score - scored[1].score >= 0.04)) return { p: scored[0].p, method: "fuzzy", score: Math.round(scored[0].sim * 100) / 100 };
  }
  // At Send time the browser's own index is as fresh as the bytes, so the bare position is acceptable.
  // After a reload it never is (an insert above shifts it): resolveDurable does not pass allowPath.
  if (allowPath && path) {
    const hit = paragraphs.find((p) => p.path && p.path.length === path.length && p.path.every((v, i) => v === path[i]));
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

/** Offsets of every non-overlapping occurrence of `q` in `text`. */
function occurrences(text, q) {
  const out = [];
  for (let i = text.indexOf(q); i >= 0; i = text.indexOf(q, i + q.length)) out.push(i);
  return out;
}

/**
 * Which occurrence of a repeated quote a selection or a stored anchor means. Prefix and suffix are the normalized text around it;
 * `nth` is the occurrence index remembered at capture. Returns the offset, or -1 when the text does not occur.
 */
function pickOccurrence(text, q, { prefix = "", suffix = "", nth = null } = {}) {
  const occ = occurrences(text, q);
  if (!occ.length) return -1;
  const guarded = occ.filter((at) => (!prefix || normText(text.slice(0, at)).endsWith(prefix)) && (!suffix || normText(text.slice(at + q.length)).startsWith(suffix)));
  if (guarded.length === 1) return guarded[0];
  if (nth != null && nth < occ.length && guarded.includes(occ[nth])) return occ[nth];
  if (guarded.length) return guarded[0];
  return nth != null && nth < occ.length ? occ[nth] : occ[0];
}

function durableFor(paragraphs, p, engineTop, ctx, loc = {}) {
  const norm = normText(p.text);
  const q = normText(ctx.quote || "");
  const prefix = normText(ctx.prefix || "").slice(-CTX);
  const suffix = normText(ctx.suffix || "").slice(0, CTX);
  let start = null;
  let end = null;
  let nth = null;
  if (q) {
    // the engine's own offsets when they point at the quote; else the occurrence whose surroundings match prefix and suffix
    const at = Number.isInteger(loc.start) && Number.isInteger(loc.end) && p.text.slice(loc.start, loc.end) === ctx.quote ? loc.start : pickOccurrence(p.text, ctx.quote, { prefix, suffix });
    if (at >= 0) {
      start = at;
      end = at + ctx.quote.length;
      nth = occurrences(p.text, ctx.quote).indexOf(at);
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
    dupCount: paragraphs.filter((x) => x.hash === p.hash).length,
    paraText: norm.slice(0, PARA_TEXT_KEEP),
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
  const at = q ? pickOccurrence(p.text, q, { prefix: d.prefix, suffix: d.suffix, nth: d.nth }) : -1;
  if (at >= 0) {
    start = at;
    end = at + q.length;
  }
  return { method: hit.method, score: hit.score, ordinal: p.ordinal, path: p.path, tableNo: p.tableNo ?? null, paraId: p.paraId, textHash: p.hash, protected: !!p.protected, ...(p.protected ? { protectInfo: protectInfo(p) } : {}), dupCount: paragraphs.filter((x) => x.hash === p.hash).length, nth: at >= 0 ? occurrences(p.text, q).indexOf(at) : null, prevHash: paragraphs[p.ordinal - 1]?.hash || null, nextHash: paragraphs[p.ordinal + 1]?.hash || null, text: normText(p.text).slice(0, PARA_TEXT_KEEP), start, end, engineDelta: d.engineDelta || 0 };
}
