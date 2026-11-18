import { normText } from "./text.js";
import { readDocxParagraphs, resolveDurable, durableFromEngine } from "./docx.js";
import { parseDeck, pptxDurable, resolvePptx } from "./pptx.js";
import { a1, a1Range, ch, parseWorkbook, resolveXlsx, sheetRows, xlsxDurable } from "./xlsx.js";
import { capDurable } from "./retain.js";
import { elementPath, htmlDurable, ownHash, pathString, readHtml, resolveHtml, visibleText } from "./html.js";
import { unknownFormat } from "./constants.js";

// One seam per format for the three things the server does with the bytes it holds: read the units, build a durable anchor from an
// engine location (at Send) and re-resolve one against newer bytes (after `done`). DOCX lives in docx.js, XLSX in xlsx.js, PPTX in pptx.js,
// HTML in html.js (whose parser exists only in a worker thread: src/html-parser.js; on the server's thread reading an HTML file throws).

export function readUnits(format, bytes) {
  if (format === "docx") return { format, paragraphs: readDocxParagraphs(bytes) };
  if (format === "xlsx") return { format, wb: parseWorkbook(bytes) };
  if (format === "pptx") return { format, deck: parseDeck(bytes) };
  if (format === "html") return { format, read: readHtml(bytes) };
  return unknownFormat(format, "readUnits");
}

/** Reads the lazy parts of `units` too (every slide, every sheet), so a version past a cap is refused now, not by a later reader. */
export function readAll(units) {
  if (units.format === "pptx") units.deck.ensure();
  if (units.format === "xlsx") for (const sheet of units.wb.sheets) units.wb.sheetCells(sheet);
  return units;
}

// The last version read, by its content hash: the server reads one version several times in a row (a Send, then the outline of the batch
// it delivers; the end of a run, then the batch it queues and the page's next resolve), so it is read once. Consumers never change the
// units (lazy caches on them are keyed by the same content). Dropped after KEEP_MS so a large file is not held in memory for nothing.
// Ceiling: one entry; two sessions read in turn read each other's versions again.
const KEEP_MS = 60_000;
let kept = null;
/** readUnits of the version whose sha256 is `sha`, reusing the last reading of it; `bytes` is the content or a function that returns it. */
export function unitsFor(format, bytes, sha) {
  if (kept && kept.format === format && kept.sha === sha) return kept.units;
  const units = readUnits(format, typeof bytes === "function" ? bytes() : bytes);
  if (kept) clearTimeout(kept.timer);
  kept = { format, sha, units, timer: setTimeout(() => (kept = null), KEEP_MS) };
  kept.timer.unref?.();
  return units;
}

/**
 * The browser's captured anchor ({location, quote, prefix, suffix, paraText, hitKind}) -> durable anchor from the written bytes, or null.
 * A page anchor whose quote was cut where it was stored (src/retain.js, `cut`) is the paragraph or shape it sits in: a range of the cut
 * text would point at a shorter one. What is built is cut to the stored caps (src/retain.js capDurable).
 */
export function buildDurable(units, anchor) {
  if (!anchor?.location) return null;
  const { format } = units;
  const whole = anchor.cut === true;
  if (format === "docx") return capDurable(durableFromEngine(units.paragraphs, anchor.location, { quote: anchor.paraText || whole ? "" : anchor.quote, prefix: anchor.prefix, suffix: anchor.suffix, paraText: anchor.paraText }));
  if (format === "xlsx") return capDurable(xlsxDurable(units.wb, anchor.location));
  if (format === "pptx") return capDurable(pptxDurable(units.deck, anchor.location, { quote: anchor.quote, prefix: anchor.prefix, suffix: anchor.suffix, text: anchor.quote, shapeWide: !!anchor.hitKind || whole }));
  if (format === "html") return capDurable(htmlDurable(units.read, anchor));
  return unknownFormat(format, "buildDurable");
}

/** Re-resolve a stored durable anchor against new units. DOCX results keep their own shape (see docx.js). */
export function resolveDurableAny(units, durable) {
  if (!durable) return { method: "none" };
  if (units.format === "docx") return resolveDurable(units.paragraphs, durable);
  if (units.format === "xlsx") return resolveXlsx(units.wb, durable);
  if (units.format === "pptx") return resolvePptx(units.deck, durable);
  if (units.format === "html") return resolveHtml(units.read, durable);
  return unknownFormat(units.format, "resolveDurableAny");
}

/**
 * What the browser stores of a view (`getViewState()` at Send), made durable. XLSX: the sheet and the top-left and selected cells as
 * cell anchors, so a reload can land on the same logical cell after rows or columns moved. PPTX: the slide id and zoom.
 */
export function viewDurable(units, vs) {
  if (!vs) return null;
  if (units.format === "xlsx" && vs.format === "xlsx") {
    const loc = (range) => ({ sheetIndex: vs.sheetIndex, sheetName: vs.sheetName, range });
    return { format: "xlsx", top: xlsxDurable(units.wb, loc(vs.topLeft)), sel: xlsxDurable(units.wb, loc(vs.selection)), raw: { sheetIndex: vs.sheetIndex, sheetName: vs.sheetName, topLeft: vs.topLeft, selection: vs.selection } };
  }
  if (units.format === "pptx" && vs.format === "pptx") {
    const d = pptxDurable(units.deck, { slideIndex: vs.slideIndex });
    return { format: "pptx", durable: d, zoom: vs.zoom ?? "fit", slideIndex: vs.slideIndex };
  }
  return null;
}

/** The view to restore, in terms of the current file: {format:'xlsx', sheetIndex, sheetName, topLeft, selection} / {format:'pptx', slideIndex, zoom}. */
export function resolveView(units, view) {
  if (!view) return null;
  if (units.format === "xlsx" && view.top) {
    const top = resolveXlsx(units.wb, view.top);
    const sheetOf = (r) => ({ sheetIndex: r.sheetIndex, sheetName: r.sheetName });
    // same top-left cell by identity when it can be found; else the same address on the same sheet
    const raw = view.raw;
    const sheet = top.method !== "none" ? sheetOf(top) : (() => {
      const s = units.wb.sheets.find((x) => x.sheetId === view.top.sheetId && x.name === view.top.sheetName) || units.wb.sheets.find((x) => x.name === raw.sheetName) || units.wb.sheets.find((x) => x.sheetId === view.top.sheetId);
      return s ? { sheetIndex: s.index, sheetName: s.name } : null;
    })();
    if (!sheet) return null;
    const topLeft = top.method !== "none" ? a1(top.r0, top.c0) : raw.topLeft;
    // the selection keeps its own anchor when it resolves; otherwise it shifts by the same offset as the top-left cell
    let selection = raw.selection;
    const sel = view.sel ? resolveXlsx(units.wb, view.sel) : { method: "none" };
    if (sel.method !== "none" && sel.sheetName === sheet.sheetName) selection = sel.range;
    return { format: "xlsx", ...sheet, topLeft, selection, topMethod: top.method };
  }
  if (units.format === "pptx" && view.durable) {
    const r = resolvePptx(units.deck, { ...view.durable, shapeId: null });
    return r.method === "none" ? { format: "pptx", slideIndex: Math.min(view.slideIndex ?? 0, Math.max(0, units.deck.slides.length - 1)), zoom: view.zoom, exact: false } : { format: "pptx", slideIndex: r.slideIndex, slideId: r.slideId, zoom: view.zoom, exact: true };
  }
  return null;
}

// ---- changed regions: what the agent changed, found by comparing the file before and after ----------------------

/**
 * Longest-common-subsequence diff of two string sequences. Returns, for every index of `b`, 'same', 'changed' (paired with an unmatched
 * element of `a` in the same gap: it was edited) or 'added'. Common prefix and suffix are trimmed first; a middle larger than 4M cells
 * falls back to a multiset comparison (ceiling: no pairing, so it can only say 'added').
 */
export function diffSeq(a, b) {
  const out = new Array(b.length).fill("added");
  const pairedA = new Array(b.length).fill(-1);
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) (out[p] = "same", p++);
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) (out[b.length - 1 - s] = "same", s++);
  const A = a.slice(p, a.length - s);
  const B = b.slice(p, b.length - s);
  if (!B.length) return { kind: out, pairedA };
  if (A.length * B.length > 4_000_000) {
    const have = new Map();
    for (const x of A) have.set(x, (have.get(x) || 0) + 1);
    B.forEach((x, i) => {
      if (have.get(x) > 0) (have.set(x, have.get(x) - 1), (out[p + i] = "same"));
    });
    return { kind: out, pairedA };
  }
  const n = A.length;
  const m = B.length;
  const w = m + 1;
  const T = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) T[i * w + j] = A[i] === B[j] ? Math.min(65535, T[(i + 1) * w + j + 1] + 1) : Math.max(T[(i + 1) * w + j], T[i * w + j + 1]);
  let i = 0;
  let j = 0;
  let gapA = 0; // start of the unmatched run of A
  let gapB = 0;
  const flush = (ea, eb) => {
    // pair the unmatched runs in order: a replaced element is 'changed', the surplus of B is 'added'
    for (let k = 0; gapB + k < eb && gapA + k < ea; k++) {
      out[p + gapB + k] = "changed";
      pairedA[p + gapB + k] = p + gapA + k;
    }
  };
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      flush(i, j);
      out[p + j] = "same";
      i++;
      j++;
      gapA = i;
      gapB = j;
    } else if (T[(i + 1) * w + j] >= T[i * w + j + 1]) i++;
    else j++;
  }
  flush(n, m);
  return { kind: out, pairedA };
}

const MAX_CHANGES = 300;

/** Regions of the post file the agent changed: [{kind:'changed'|'added', ...position}] in post coordinates, capped; `truncated` says it was. */
export function changedRegions(format, preBytes, postBytes) {
  const items = [];
  const push = (it) => items.length < MAX_CHANGES && items.push(it);
  if (format === "docx") {
    const pre = readDocxParagraphs(preBytes);
    const post = readDocxParagraphs(postBytes);
    const { kind } = diffSeq(pre.map((p) => p.hash), post.map((p) => p.hash));
    post.forEach((p, i) => kind[i] !== "same" && push({ kind: kind[i], text: normText(p.text).slice(0, 160), ordinal: p.ordinal }));
  } else if (format === "xlsx") {
    const A = parseWorkbook(preBytes);
    const B = parseWorkbook(postBytes);
    const namesB = new Map(); // sheet name -> how many sheets of B have it
    for (const y of B.sheets) namesB.set(y.name, (namesB.get(y.name) || 0) + 1);
    for (const sb of B.sheets) {
      const sa = A.sheets.find((x) => x.name === sb.name) || A.sheets.find((x) => x.sheetId === sb.sheetId && !(namesB.get(x.name) > (x.name === sb.name ? 1 : 0)));
      const rowsB = sheetRows(B, sb);
      if (!sa) {
        for (const row of rowsB) push({ kind: "added", sheetId: sb.sheetId, sheetName: sb.name, range: a1Range({ r0: row.r, c0: row.cells[0].c, r1: row.r, c1: row.cells[row.cells.length - 1].c }) });
        continue;
      }
      const rowsA = sheetRows(A, sa);
      const sig = (row) => row.cells.map((c) => `${c.c}:${ch(c)}`).join("|");
      const { kind, pairedA } = diffSeq(rowsA.map(sig), rowsB.map(sig));
      rowsB.forEach((row, i) => {
        if (kind[i] === "same") return;
        const where = { sheetId: sb.sheetId, sheetName: sb.name };
        if (kind[i] === "changed") {
          const old = new Map(rowsA[pairedA[i]].cells.map((c) => [c.c, c.text]));
          const seen = new Set();
          for (const c of row.cells) {
            seen.add(c.c);
            if (old.get(c.c) !== c.text) push({ kind: "changed", ...where, range: a1(row.r, c.c) });
          }
          for (const c of old.keys()) if (!seen.has(c)) push({ kind: "changed", ...where, range: a1(row.r, c) });
        } else push({ kind: "added", ...where, range: a1Range({ r0: row.r, c0: row.cells[0].c, r1: row.r, c1: row.cells[row.cells.length - 1].c }) });
      });
    }
  } else if (format === "pptx") {
    const A = parseDeck(preBytes);
    const B = parseDeck(postBytes);
    A.ensure();
    B.ensure();
    const slidesA = new Map();
    for (const x of A.slides) if (!slidesA.has(x.id)) slidesA.set(x.id, x);
    for (const sb of B.slides) {
      const sa = slidesA.get(sb.id);
      if (!sa) {
        push({ kind: "added", slideId: sb.id });
        continue;
      }
      const inA = new Map(); // id#ordinal -> the first such shape of the slide before, built once per slide
      for (const x of sa.shapes) if (!inA.has(`${x.id}#${x.ordinal}`)) inA.set(`${x.id}#${x.ordinal}`, x);
      for (const sh of sb.shapes) {
        const old = inA.get(`${sh.id}#${sh.ordinal}`);
        if (!old) push({ kind: "added", slideId: sb.id, shapeId: sh.id });
        else if (old.hash !== sh.hash) push({ kind: "changed", slideId: sb.id, shapeId: sh.id });
      }
    }
  } else if (format === "html") {
    // elements that hold text (and images, other leaves) by tag and own text, in order: what is new or different in the post version
    const A = readHtml(preBytes);
    const B = readHtml(postBytes);
    const key = (u) => `${u.tag}\u0000${ownHash(u.node)}`;
    const { kind } = diffSeq(A.units.map(key), B.units.map(key));
    B.units.forEach((u, i) => kind[i] !== "same" && push({ kind: kind[i], nodeId: u.nodeId, path: pathString(elementPath(u.node)), text: normText(visibleText(B, u.node)).slice(0, 160) }));
  } else unknownFormat(format, "changedRegions");
  return { items, truncated: items.length >= MAX_CHANGES };
}
