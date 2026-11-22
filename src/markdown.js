import { CapError } from "./xml.js";

// Markdown files: the file's text is the source of truth. readMarkdown reads it once into blocks and inline runs, and every displayed
// run carries the half-open range [from, to) of the source it stands for, so a selection in the rendered preview maps back to an exact
// range of the source (sourceRange), a caret maps to a source offset (sourceOffset), and an edit is an exact splice (applyReplacements).
// Pure and without Node imports: the server and the page (web/src) read a file the same way, so both agree on every offset.
//
// Offsets. Every offset is a UTF-16 code unit index into the source AFTER a leading byte order mark (U+FEFF), if there is one: the BOM
// is not part of any block or run, tree.bom says it was there, and applyReplacements takes the same offsets and keeps the BOM in
// place. tree.text is the source without it. Line endings are LF, CRLF or a lone CR, mixed freely; each keeps its exact characters.
//
// Runs. A run is {type: "run", id, block, kind, from, to, display}, ids in source order. The rule between display and source:
//   text, code, literal   one to one: display === source.slice(from, to) (code spans keep their spaces and line endings verbatim)
//   escape                "\*" displays "*": the whole spelling stands for the one character
//   entity                "&amp;" displays "&", "&#233;" displays "é": the whole spelling
//   softbreak             trailing spaces + line ending (CRLF is both characters) display " ". When the next line's indentation is
//                         whitespace only (a wrapped line in a list item, an indented continuation), it is part of the spelling too
//   hardbreak             two or more spaces + line ending, or "\" + line ending, display "\n"
// An offset inside a run of the last four kinds is not a boundary of the source. Everything not inside a run is a skip,
// {from, to, skip}, recorded where it is consumed: the marks that build blocks ("indent", "quote", "marker", "heading", "fence",
// "hr", "table", "blank", "trailing", "eol") and inline marks with no displayed width ("emphasis", "code", "link": the brackets, the
// destination and the title). Runs and skips together tile the source exactly; readMarkdown checks that before it returns.
//
// Blocks. Top-level blocks tile the source (blank lines are "blank" blocks); a block's range runs from where its first line's content
// starts (after any container marks) to the end of its last line, line ending included. Leaf blocks (paragraph, heading, code, table,
// literal) hold `inline`: run nodes and spans {type: "em" | "strong" | "code" | "link" | "image", from, to, children}. Containers:
// quote {children}, list {ordered, start, marker, tight, items: [item {marker, task, children}]}.
//
// Rendered: ATX headings (closing #s are marks), paragraphs, fenced and indented code, block quotes, bullet and ordered lists nested to
// the depth limit (a task marker "[ ]" or "[x]" stays literal text; item.task points at it), GFM pipe tables (escaped pipes are escape
// runs, also inside code spans in a cell), thematic breaks, emphasis and strong (CommonMark delimiter rules), code spans, inline links
// [label](destination "title"), backslash escapes, numeric entities and the named entities in NAMED below, hard and soft breaks.
// Shown literally in this version (the map stays one to one): front matter (YAML between --- lines at the very top; a protected
// literal block), HTML blocks and inline HTML (never interpreted), autolinks (<https://...>), images (a span of literal runs holding
// the whole "![alt](path)"; alt and src are given, nothing is loaded), link reference definitions and reference links ([a][b], [a]),
// setext headings (the underline stays paragraph text), lazy continuation lines (a line that is not indented enough ends the list item
// or quote and starts a paragraph of its own), named entities not in NAMED, strikethrough and footnotes.
// Ceilings: a tab that a container strips only in part is stripped whole; a paragraph line cannot become a table header (a table starts
// a block); code spans and inline HTML scan left to right, so "[a](`b)`" is a link (CommonMark would make the code span win); emphasis
// flanking uses \s and \p{P}\p{S} for Unicode whitespace and punctuation.

// ---- limits ---------------------------------------------------------------------------------------------------------------------
/** What one Markdown file may hold: its size in UTF-8 bytes (a BOM counts), its lines, and how deep quotes, lists or inline marks nest. */
export const MD_LIMITS = { bytes: 1024 * 1024, lines: 20_000, depth: 32 };
/** The sentence for a file that is not valid UTF-8 (the server, src/markdown-file.js, and the page say it in these words). */
export const MD_NOT_UTF8 = "This Markdown file is not saved as UTF-8, so Onionskin cannot read it. Save it as UTF-8 (in most editors: Save As, Encoding, UTF-8) and open it again.";
const n = (x) => x.toLocaleString("en-US");
const SPLIT = "Split it into smaller files and open those";
const capBytes = (size) => new CapError(`this Markdown file is ${n(size)} bytes, more than the ${n(MD_LIMITS.bytes)} bytes (1 MB) Onionskin can read. ${SPLIT}`, "bytes");
const capLines = () => new CapError(`this Markdown file has more than ${n(MD_LIMITS.lines)} lines, more than Onionskin can read. ${SPLIT}`, "lines");
const capDepth = () => new CapError(`this Markdown file nests quotes, lists or emphasis more than ${MD_LIMITS.depth} levels deep, more than Onionskin can read. Open a copy with less nesting`, "nesting depth");

/** UTF-8 length of a string (a lone surrogate counts as the 3 bytes of U+FFFD, as an encoder writes it). */
function utf8Length(s) {
  let len = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) len += 1;
    else if (c < 0x800) len += 2;
    else if (c >= 0xd800 && c < 0xdc00 && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) (len += 4), i++;
    else len += 3;
  }
  return len;
}

// ---- characters -------------------------------------------------------------------------------------------------------------------
const isSpTab = (c) => c === 32 || c === 9;
const isDigit = (c) => c >= 48 && c <= 57;
const isAlpha = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isAlnum = (c) => isAlpha(c) || isDigit(c);
const isAsciiPunct = (c) => (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
const eolLen = (s, k) => (s.charCodeAt(k) === 13 && s.charCodeAt(k + 1) === 10 ? 2 : 1);
const WS = /\s/;
const PUNCT = /[\p{P}\p{S}]/u;

/** The named entities decoded in this version (case-sensitive, as in HTML); any other "&name;" is shown literally. */
const NAMED = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00A0", copy: "©", reg: "®", trade: "™", hellip: "…", mdash: "\u2014",
  ndash: "\u2013", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", laquo: "«", raquo: "»", bull: "•", middot: "·", deg: "°",
  plusmn: "±", times: "×", divide: "÷", frac12: "½", frac14: "¼", frac34: "¾", sect: "§", para: "¶", euro: "€", pound: "£",
  yen: "¥", cent: "¢", larr: "←", rarr: "→", uarr: "↑", darr: "↓", harr: "↔", rArr: "⇒", ne: "≠", le: "≤", ge: "≥",
  infin: "∞", micro: "µ", shy: "\u00AD", zwj: "\u200D", zwnj: "\u200C", ensp: "\u2002", emsp: "\u2003", thinsp: "\u2009",
  aacute: "á", Aacute: "Á", eacute: "é", Eacute: "É", iacute: "í", Iacute: "Í", oacute: "ó", Oacute: "Ó", uacute: "ú",
  Uacute: "Ú", agrave: "à", egrave: "è", ograve: "ò", auml: "ä", ouml: "ö", uuml: "ü", Auml: "Ä", Ouml: "Ö", Uuml: "Ü",
  iuml: "ï", ntilde: "ñ", Ntilde: "Ñ", ccedil: "ç", Ccedil: "Ç", acirc: "â", ecirc: "ê", ocirc: "ô", szlig: "ß", oslash: "ø",
  aring: "å", aelig: "æ", iexcl: "¡", iquest: "¿",
};

/** The entity starting at s[i] === "&": {end, value}, or null when it is not one this version decodes. Scans at most 34 characters. */
function entityAt(s, i) {
  let k = i + 1;
  if (s.charCodeAt(k) === 35) {
    k++;
    const hex = s.charCodeAt(k) === 120 || s.charCodeAt(k) === 88;
    if (hex) k++;
    const d0 = k;
    while (k - d0 < (hex ? 6 : 7) && (hex ? /[0-9a-fA-F]/.test(s[k] || "") : isDigit(s.charCodeAt(k)))) k++;
    if (k === d0 || s.charCodeAt(k) !== 59) return null;
    const cp = parseInt(s.slice(d0, k), hex ? 16 : 10);
    const value = cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? "\uFFFD" : String.fromCodePoint(cp);
    return { end: k + 1, value };
  }
  while (k - i <= 32 && isAlnum(s.charCodeAt(k))) k++;
  if (k === i + 1 || s.charCodeAt(k) !== 59) return null;
  const name = s.slice(i + 1, k);
  return Object.prototype.hasOwnProperty.call(NAMED, name) ? { end: k + 1, value: NAMED[name] } : null;
}

/** A link destination or title with its escapes and entities decoded (for href, src and title; never displayed as text). */
function decodeText(s) {
  if (!s.includes("\\") && !s.includes("&")) return s;
  let out = "";
  for (let i = 0; i < s.length; ) {
    const c = s.charCodeAt(i);
    if (c === 92 && isAsciiPunct(s.charCodeAt(i + 1))) (out += s[i + 1]), (i += 2);
    else if (c === 38 && entityAt(s, i)) {
      const e = entityAt(s, i);
      out += e.value;
      i = e.end;
    } else (out += s[i]), i++;
  }
  return out;
}

// ---- lines and views --------------------------------------------------------------------------------------------------------------
// A view is one line as a container sees it: {start, col, contentEnd, end}. start is where the container's content starts on the line
// (after "> " or a list item's indentation), col is the visual column there (tabs stop every 4 columns), contentEnd is where the line
// ending starts and end is after it.

/** Leading spaces and tabs of a view: {cols (columns of it), pos (first other character), col (its column)}. */
function lead(t, v) {
  let col = v.col;
  let p = v.start;
  while (p < v.contentEnd) {
    const c = t.charCodeAt(p);
    if (c === 32) col++;
    else if (c === 9) col += 4 - (col % 4);
    else break;
    p++;
  }
  return { cols: col - v.col, pos: p, col };
}
/** The view after stripping up to `cols` columns of indentation (a tab that crosses the goal is stripped whole). */
function strip(t, v, cols) {
  let col = v.col;
  let p = v.start;
  const goal = v.col + cols;
  while (p < v.contentEnd && col < goal) {
    const c = t.charCodeAt(p);
    if (c === 32) col++;
    else if (c === 9) col += 4 - (col % 4);
    else break;
    p++;
  }
  return { start: p, col, contentEnd: v.contentEnd, end: v.end };
}
const isBlank = (t, v) => lead(t, v).pos === v.contentEnd;
function trimEnd(t, a, e) {
  while (e > a && isSpTab(t.charCodeAt(e - 1))) e--;
  return e;
}

// ---- block starts -----------------------------------------------------------------------------------------------------------------
function atxAt(t, v, L) {
  if (L.cols >= 4) return null;
  let k = L.pos;
  while (k < v.contentEnd && k - L.pos < 7 && t.charCodeAt(k) === 35) k++;
  const level = k - L.pos;
  if (level < 1 || level > 6 || (k < v.contentEnd && !isSpTab(t.charCodeAt(k)))) return null;
  return { level, markEnd: k };
}
function isHr(t, v, L) {
  if (L.cols >= 4) return false;
  const ch = t.charCodeAt(L.pos);
  if (ch !== 45 && ch !== 42 && ch !== 95) return false;
  let count = 0;
  for (let k = L.pos; k < v.contentEnd; k++) {
    const c = t.charCodeAt(k);
    if (c === ch) count++;
    else if (!isSpTab(c)) return false;
  }
  return count >= 3;
}
/** A run of "=" or "-" alone (a setext underline in CommonMark): kept as paragraph text here, so it does not interrupt a paragraph. */
function isSetextLike(t, v, L) {
  const ch = t.charCodeAt(L.pos);
  if (ch !== 61 && ch !== 45) return false;
  const e = trimEnd(t, L.pos, v.contentEnd);
  for (let k = L.pos; k < e; k++) if (t.charCodeAt(k) !== ch) return false;
  return true;
}
function fenceAt(t, v, L) {
  if (L.cols >= 4) return null;
  const ch = t.charCodeAt(L.pos);
  if (ch !== 96 && ch !== 126) return null;
  let k = L.pos;
  while (k < v.contentEnd && t.charCodeAt(k) === ch) k++;
  const len = k - L.pos;
  if (len < 3) return null;
  let a = k;
  while (a < v.contentEnd && isSpTab(t.charCodeAt(a))) a++;
  const e = trimEnd(t, a, v.contentEnd);
  if (ch === 96) for (let q = a; q < e; q++) if (t.charCodeAt(q) === 96) return null;
  return { ch, len, runEnd: k, infoFrom: a, infoTo: e, cols: L.cols };
}
function isFenceClose(t, v, f) {
  const L = lead(t, v);
  if (L.cols >= 4) return false;
  let k = L.pos;
  while (k < v.contentEnd && t.charCodeAt(k) === f.ch) k++;
  if (k - L.pos < f.len) return false;
  for (; k < v.contentEnd; k++) if (!isSpTab(t.charCodeAt(k))) return false;
  return true;
}
/** A list item marker: {ordered, ch, number, markerFrom, markerTo, contentPos, contentCol, rel (content indent from the view), empty}. */
function listAt(t, v, L) {
  if (L.cols >= 4) return null;
  let q = L.pos;
  const c = t.charCodeAt(q);
  let ordered = false;
  let number = null;
  let ch;
  if (c === 45 || c === 43 || c === 42) (ch = t[q]), q++;
  else {
    let d = q;
    while (d < v.contentEnd && d - q < 9 && isDigit(t.charCodeAt(d))) d++;
    if (d === q || (t.charCodeAt(d) !== 46 && t.charCodeAt(d) !== 41)) return null;
    ordered = true;
    number = parseInt(t.slice(q, d), 10);
    ch = t[d];
    q = d + 1;
  }
  if (q < v.contentEnd && !isSpTab(t.charCodeAt(q))) return null;
  const markerCol = L.col + (q - L.pos);
  let s = q;
  let col = markerCol;
  while (s < v.contentEnd && isSpTab(t.charCodeAt(s))) {
    col = t.charCodeAt(s) === 9 ? col + 4 - (col % 4) : col + 1;
    s++;
  }
  const base = { ordered, ch, number, markerFrom: L.pos, markerTo: q };
  if (s === v.contentEnd) return { ...base, empty: true, contentPos: v.contentEnd, contentCol: col, rel: markerCol - v.col + 1 };
  if (col - markerCol >= 5) {
    const c1 = t.charCodeAt(q) === 9 ? markerCol + 4 - (markerCol % 4) : markerCol + 1;
    return { ...base, empty: false, contentPos: q + 1, contentCol: c1, rel: c1 - v.col };
  }
  return { ...base, empty: false, contentPos: s, contentCol: col, rel: col - v.col };
}
const BLOCK_TAGS = new Set("address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul".split(" "));
const HTML_ENDS = [null, null, "-->", "?>", ">", "]]>"];
/** Which CommonMark HTML block starts here (1 to 7, where 7 is any tag at the start of a line), or 0. Looks at 32 characters. */
function htmlAt(t, v, L) {
  if (L.cols >= 4 || t.charCodeAt(L.pos) !== 60) return 0;
  const s = t.slice(L.pos, Math.min(v.contentEnd, L.pos + 32)).toLowerCase();
  if (/^<(?:script|pre|style|textarea)(?:[\s>]|$)/.test(s)) return 1;
  if (s.startsWith("<!--")) return 2;
  if (s.startsWith("<?")) return 3;
  if (s.startsWith("<![cdata[")) return 5;
  if (/^<![a-z]/.test(s)) return 4;
  const m = /^<\/?([a-z][a-z0-9-]*)(?:[\s/>]|$)/.exec(s);
  if (m && BLOCK_TAGS.has(m[1])) return 6;
  if (!/^<\/?[a-z]/.test(s)) return 0;
  // 7: one tag alone on its line (no "<" inside it, only whitespace after it); "<b>Note:</b> text" stays a paragraph
  let k = L.pos + 1;
  while (k < v.contentEnd && t.charCodeAt(k) !== 62 && t.charCodeAt(k) !== 60) k++;
  if (t.charCodeAt(k) !== 62) return 0;
  return trimEnd(t, k + 1, v.contentEnd) === k + 1 ? 7 : 0;
}
/** Does this line, after a paragraph line, start a block of its own (and so end the paragraph)? */
function interrupts(t, v, L) {
  if (L.cols >= 4) return false;
  const c = t.charCodeAt(L.pos);
  if (c === 62 || atxAt(t, v, L) || fenceAt(t, v, L)) return true;
  if (isHr(t, v, L)) return !isSetextLike(t, v, L);
  const li = listAt(t, v, L);
  if (li && !li.empty && (!li.ordered || li.number === 1)) return true;
  const h = htmlAt(t, v, L);
  return h > 0 && h < 7;
}

// ---- tables -----------------------------------------------------------------------------------------------------------------------
/** The cells of a pipe-table row in t[a, e) (already trimmed), as trimmed ranges {from, to}. A backslash escapes the next character. */
function splitRow(t, a, e) {
  if (a < e && t.charCodeAt(a) === 124) a++;
  if (e > a && t.charCodeAt(e - 1) === 124) {
    let bs = 0;
    for (let k = e - 2; k >= a && t.charCodeAt(k) === 92; k--) bs++;
    if (bs % 2 === 0) e--;
  }
  const cells = [];
  let cs = a;
  const cell = (x, y) => {
    while (x < y && isSpTab(t.charCodeAt(x))) x++;
    return { from: x, to: trimEnd(t, x, y) };
  };
  for (let k = a; k < e; k++) {
    const c = t.charCodeAt(k);
    if (c === 92) k++;
    else if (c === 124) cells.push(cell(cs, k)), (cs = k + 1);
  }
  cells.push(cell(cs, e));
  return cells;
}
function hasPipe(t, a, e) {
  for (let k = a; k < e; k++) {
    const c = t.charCodeAt(k);
    if (c === 92) k++;
    else if (c === 124) return true;
  }
  return false;
}
/** A table header at views[i] (with its delimiter row at i + 1): {head, align}, or null. */
function tableAt(t, views, i) {
  const v = views[i];
  const L = lead(t, v);
  if (L.cols >= 4 || i + 1 >= views.length) return null;
  const e = trimEnd(t, L.pos, v.contentEnd);
  if (!hasPipe(t, L.pos, e)) return null;
  const d = views[i + 1];
  const Ld = lead(t, d);
  if (Ld.cols >= 4 || Ld.pos === d.contentEnd) return null;
  const dcells = splitRow(t, Ld.pos, trimEnd(t, Ld.pos, d.contentEnd));
  const align = [];
  for (const c of dcells) {
    let k = c.from;
    const left = t.charCodeAt(k) === 58;
    if (left) k++;
    const d0 = k;
    while (k < c.to && t.charCodeAt(k) === 45) k++;
    if (k === d0) return null;
    const right = k < c.to && t.charCodeAt(k) === 58;
    if (right) k++;
    if (k !== c.to) return null;
    align.push(left && right ? "center" : right ? "right" : left ? "left" : null);
  }
  const head = splitRow(t, L.pos, e);
  return head.length === dcells.length ? { head, align } : null;
}

// ---- reading ----------------------------------------------------------------------------------------------------------------------
/**
 * Reads a Markdown file's text. Returns {text (without a BOM), bom, length, blocks (top level), byId (every block by id), runs (in
 * source order, run.id is the index), skips, info: {bytes, lines, newlines: {lf, crlf, cr}}, limits}. Throws a CapError past
 * MD_LIMITS, with a sentence to show.
 */
export function readMarkdown(source) {
  if (typeof source !== "string") throw new TypeError("readMarkdown takes the text of the file");
  if (source.length > MD_LIMITS.bytes) throw capBytes(utf8Length(source));
  const bytes = utf8Length(source);
  if (bytes > MD_LIMITS.bytes) throw capBytes(bytes);
  const bom = source.charCodeAt(0) === 0xfeff;
  const t = bom ? source.slice(1) : source;
  const views = [];
  const newlines = { lf: 0, crlf: 0, cr: 0 };
  let start = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c !== 10 && c !== 13) continue;
    const len = eolLen(t, i);
    if (len === 2) newlines.crlf++;
    else if (c === 10) newlines.lf++;
    else newlines.cr++;
    views.push({ start, col: 0, contentEnd: i, end: i + len });
    if (views.length > MD_LIMITS.lines) throw capLines();
    i += len - 1;
    start = i + 1;
  }
  if (start < t.length) views.push({ start, col: 0, contentEnd: t.length, end: t.length });
  if (views.length > MD_LIMITS.lines) throw capLines();
  const P = { t, runs: [], skips: [], byId: [] };
  const blocks = parseBlocks(P, views, 0);
  finish(P);
  return { text: t, bom, length: t.length, blocks, byId: P.byId, runs: P.runs, skips: P.skips, info: { bytes, lines: views.length, newlines }, limits: MD_LIMITS };
}

function mk(P, type, from, to) {
  const b = { id: P.byId.length, type, from, to };
  P.byId.push(b);
  return b;
}
function skip(P, from, to, kind) {
  if (to > from) P.skips.push({ from, to, skip: kind });
}
function runAt(P, b, from, to, kind, display) {
  const r = { type: "run", id: -1, block: b.id, kind, from, to, display };
  P.runs.push(r);
  return r;
}
/** Literal or code lines: one one-to-one run per line, the last line's ending a skip. Views i..j inclusive, each from `starts[k]`. */
function lineRuns(P, b, views, i, j, kind, startOf = (w) => w.start) {
  const out = [];
  for (let k = i; k <= j; k++) {
    const w = views[k];
    const s = startOf(w);
    skip(P, w.start, s, "indent");
    const to = k < j ? w.end : w.contentEnd;
    if (to > s) out.push(runAt(P, b, s, to, kind, P.t.slice(s, to)));
    if (k === j) skip(P, w.contentEnd, w.end, "eol");
  }
  return out;
}

function parseBlocks(P, views, depth) {
  if (depth > MD_LIMITS.depth) throw capDepth();
  const t = P.t;
  const out = [];
  const count = views.length;
  let i = 0;
  // front matter: "---" alone on the very first line of the file, closed by "---" or "..." alone on a line
  if (depth === 0 && count > 1 && views[0].start === 0 && t.slice(0, trimEnd(t, 0, views[0].contentEnd)) === "---") {
    for (let k = 1; k < count; k++) {
      const w = views[k];
      const s = t.slice(w.start, trimEnd(t, w.start, w.contentEnd));
      if (s !== "---" && s !== "...") continue;
      const b = mk(P, "literal", 0, w.end);
      b.what = "frontmatter";
      b.protected = true;
      b.inline = lineRuns(P, b, views, 0, k, "literal");
      out.push(b);
      i = k + 1;
      break;
    }
  }
  while (i < count) {
    const v = views[i];
    const L = lead(t, v);
    if (L.pos === v.contentEnd) {
      let j = i;
      while (j < count && isBlank(t, views[j])) skip(P, views[j].start, views[j].end, "blank"), j++;
      out.push(mk(P, "blank", v.start, views[j - 1].end));
      i = j;
      continue;
    }
    if (L.cols >= 4) {
      i = indentedCode(P, views, i, out);
      continue;
    }
    let h;
    if ((h = fenceAt(t, v, L))) i = fencedCode(P, views, i, L, h, out);
    else if ((h = atxAt(t, v, L))) heading(P, v, L, h, out), i++;
    else if (isHr(t, v, L)) {
      const b = mk(P, "hr", v.start, v.end);
      skip(P, v.start, L.pos, "indent");
      skip(P, L.pos, v.contentEnd, "hr");
      skip(P, v.contentEnd, v.end, "eol");
      out.push(b);
      i++;
    } else if (t.charCodeAt(L.pos) === 62) i = quote(P, views, i, depth, out);
    else if ((h = listAt(t, v, L))) i = list(P, views, i, depth, h, out);
    else if ((h = htmlAt(t, v, L))) i = htmlBlock(P, views, i, h, out);
    else if ((h = tableAt(t, views, i))) i = table(P, views, i, h, out);
    else i = paragraph(P, views, i, out);
  }
  return out;
}

/** The inline segments of lines i..j-1: leading whitespace is indentation, the last line's trailing whitespace and ending are skips. */
function textSegments(P, views, i, j) {
  const t = P.t;
  const segs = [];
  for (let k = i; k < j; k++) {
    const v = views[k];
    const L = lead(t, v);
    skip(P, v.start, L.pos, "indent");
    if (k < j - 1) segs.push({ from: L.pos, eolTo: v.end });
    else {
      const e = trimEnd(t, L.pos, v.contentEnd);
      skip(P, e, v.contentEnd, "trailing");
      skip(P, v.contentEnd, v.end, "eol");
      segs.push({ from: L.pos, eolTo: e });
    }
  }
  return segs;
}
function paragraph(P, views, i, out) {
  const t = P.t;
  let j = i + 1;
  while (j < views.length) {
    const L = lead(t, views[j]);
    if (L.pos === views[j].contentEnd || interrupts(t, views[j], L)) break;
    j++;
  }
  const b = mk(P, "paragraph", views[i].start, views[j - 1].end);
  b.inline = parseInline(P, b, textSegments(P, views, i, j));
  out.push(b);
  return j;
}
function heading(P, v, L, h, out) {
  const t = P.t;
  const b = mk(P, "heading", v.start, v.end);
  b.level = h.level;
  let a = h.markEnd;
  while (a < v.contentEnd && isSpTab(t.charCodeAt(a))) a++;
  const trail = trimEnd(t, a, v.contentEnd);
  let e = trail;
  let k = e;
  while (k > a && t.charCodeAt(k - 1) === 35) k--;
  if (k < e && (k === a || isSpTab(t.charCodeAt(k - 1)))) e = trimEnd(t, a, k);
  skip(P, v.start, L.pos, "indent");
  skip(P, L.pos, a, "heading");
  b.inline = parseInline(P, b, [{ from: a, eolTo: e }]);
  skip(P, e, trail, "heading");
  skip(P, trail, v.contentEnd, "trailing");
  skip(P, v.contentEnd, v.end, "eol");
  out.push(b);
}
function fencedCode(P, views, i, L, f, out) {
  const t = P.t;
  const v = views[i];
  let j = i + 1;
  while (j < views.length && !isFenceClose(t, views[j], f)) j++;
  const closed = j < views.length;
  const b = mk(P, "code", v.start, closed ? views[j].end : views[j - 1].end);
  b.fenced = true;
  b.closed = closed;
  b.info = f.infoTo > f.infoFrom ? t.slice(f.infoFrom, f.infoTo) : null;
  skip(P, v.start, L.pos, "indent");
  skip(P, L.pos, f.infoFrom, "fence");
  b.infoRun = f.infoTo > f.infoFrom ? runAt(P, b, f.infoFrom, f.infoTo, "literal", b.info) : null;
  skip(P, f.infoTo, v.contentEnd, "fence");
  skip(P, v.contentEnd, v.end, "eol");
  b.inline = j > i + 1 ? lineRuns(P, b, views, i + 1, j - 1, "code", (w) => strip(t, w, f.cols).start) : [];
  if (closed) {
    skip(P, views[j].start, views[j].contentEnd, "fence");
    skip(P, views[j].contentEnd, views[j].end, "eol");
    j++;
  }
  out.push(b);
  return j;
}
function indentedCode(P, views, i, out) {
  const t = P.t;
  let j = i;
  let last = i;
  while (j < views.length) {
    const L = lead(t, views[j]);
    if (L.pos !== views[j].contentEnd) {
      if (L.cols < 4) break;
      last = j;
    }
    j++;
  }
  const b = mk(P, "code", views[i].start, views[last].end);
  b.fenced = false;
  b.closed = true;
  b.info = null;
  b.infoRun = null;
  b.inline = lineRuns(P, b, views, i, last, "code", (w) => strip(t, w, 4).start);
  out.push(b);
  return last + 1;
}
function htmlBlock(P, views, i, kind, out) {
  const t = P.t;
  let j = i;
  if (kind >= 6) {
    while (j + 1 < views.length && !isBlank(t, views[j + 1])) j++;
  } else {
    const end = kind === 1 ? null : HTML_ENDS[kind];
    for (; j < views.length; j++) {
      const s = t.slice(views[j].start, views[j].contentEnd);
      const lower = kind === 1 ? s.toLowerCase() : s;
      if (end ? lower.includes(end) : /<\/(?:script|pre|style|textarea)>/.test(lower)) break;
    }
    if (j === views.length) j--;
  }
  const b = mk(P, "literal", views[i].start, views[j].end);
  b.what = "html";
  b.inline = lineRuns(P, b, views, i, j, "literal");
  out.push(b);
  return j + 1;
}
function quote(P, views, i, depth, out) {
  const t = P.t;
  const inner = [];
  let j = i;
  for (; j < views.length; j++) {
    const v = views[j];
    const L = lead(t, v);
    if (L.cols >= 4 || L.pos === v.contentEnd || t.charCodeAt(L.pos) !== 62) break;
    let p = L.pos + 1;
    let col = L.col + 1;
    if (p < v.contentEnd && isSpTab(t.charCodeAt(p))) (col = t.charCodeAt(p) === 9 ? col + 4 - (col % 4) : col + 1), p++;
    skip(P, v.start, L.pos, "indent");
    skip(P, L.pos, p, "quote");
    inner.push({ start: p, col, contentEnd: v.contentEnd, end: v.end });
  }
  const b = mk(P, "quote", views[i].start, views[j - 1].end);
  b.children = parseBlocks(P, inner, depth + 1);
  out.push(b);
  return j;
}
function list(P, views, i, depth, first, out) {
  const t = P.t;
  const L = mk(P, "list", views[i].start, views[i].end);
  L.ordered = first.ordered;
  L.start = first.number;
  L.marker = first.ch;
  L.tight = true;
  L.items = [];
  let j = i;
  let mkr = first;
  let last;
  for (;;) {
    const v = views[j];
    let k = j + 1;
    last = j;
    if (!(mkr.empty && k < views.length && isBlank(t, views[k]))) {
      for (; k < views.length; k++) {
        const lw = lead(t, views[k]);
        if (lw.pos === views[k].contentEnd) continue;
        if (lw.cols < mkr.rel) break;
        last = k;
      }
    }
    const item = mk(P, "item", v.start, views[last].end);
    item.marker = { from: mkr.markerFrom, to: mkr.markerTo };
    skip(P, v.start, mkr.markerFrom, "indent");
    skip(P, mkr.markerFrom, mkr.contentPos, "marker");
    const iv = [{ start: mkr.contentPos, col: mkr.contentCol, contentEnd: v.contentEnd, end: v.end }];
    for (let q = j + 1; q <= last; q++) {
      const st = strip(t, views[q], mkr.rel);
      skip(P, views[q].start, st.start, "indent");
      iv.push(st);
    }
    item.children = parseBlocks(P, iv, depth + 1);
    const p0 = item.children[0];
    item.task = null;
    if (p0 && p0.type === "paragraph") {
      const x = t.charCodeAt(p0.from + 1);
      const after = t.charCodeAt(p0.from + 3);
      if (t.charCodeAt(p0.from) === 91 && (x === 32 || x === 120 || x === 88) && t.charCodeAt(p0.from + 2) === 93 && (p0.from + 3 >= t.length || isSpTab(after) || after === 10 || after === 13)) {
        item.task = { checked: x !== 32, from: p0.from, to: p0.from + 3 };
      }
    }
    if (item.children.some((c, x) => x > 0 && c.type === "blank")) L.tight = false;
    L.items.push(item);
    let q = last + 1;
    while (q < views.length && isBlank(t, views[q])) q++;
    if (q >= views.length) break;
    const lw = lead(t, views[q]);
    if (lw.cols >= 4 || isHr(t, views[q], lw)) break;
    const nx = listAt(t, views[q], lw);
    if (!nx || nx.ordered !== first.ordered || nx.ch !== first.ch) break;
    if (q > last + 1) {
      L.tight = false;
      for (let r = last + 1; r < q; r++) skip(P, views[r].start, views[r].end, "blank");
    }
    j = q;
    mkr = nx;
  }
  L.to = views[last].end;
  out.push(L);
  return last + 1;
}
function table(P, views, i, h, out) {
  const t = P.t;
  let j = i + 2;
  while (j < views.length) {
    const L = lead(t, views[j]);
    if (L.pos === views[j].contentEnd || interrupts(t, views[j], L) || listAt(t, views[j], L) || isHr(t, views[j], L)) break;
    j++;
  }
  const b = mk(P, "table", views[i].start, views[j - 1].end);
  b.align = h.align;
  b.rows = [];
  const row = (v, cells, header) => {
    const L = lead(t, v);
    skip(P, v.start, L.pos, "indent");
    let pos = L.pos;
    for (const c of cells) {
      skip(P, pos, c.from, "table");
      c.inline = parseInline(P, b, [{ from: c.from, eolTo: c.to }], true);
      pos = c.to;
    }
    skip(P, pos, v.contentEnd, "table");
    skip(P, v.contentEnd, v.end, "eol");
    b.rows.push({ header, cells });
  };
  row(views[i], h.head, true);
  const d = views[i + 1];
  const Ld = lead(t, d);
  skip(P, d.start, Ld.pos, "indent");
  skip(P, Ld.pos, d.contentEnd, "table");
  skip(P, d.contentEnd, d.end, "eol");
  for (let k = i + 2; k < j; k++) {
    const L = lead(t, views[k]);
    row(views[k], splitRow(t, L.pos, trimEnd(t, L.pos, views[k].contentEnd)), false);
  }
  out.push(b);
  return j;
}

// ---- inline -----------------------------------------------------------------------------------------------------------------------
// The lines of a leaf block are joined into one content string (indentation and container marks left out) with a map back to the
// source: segs[k] is source [from, eolTo) and starts at content index cs[k]. One left-to-right scan makes tokens; emphasis follows
// CommonMark's delimiter stack (with openers_bottom, so it stays linear) and links its bracket stack. Every scan that can fail is bounded
// by the next character that ends it (inline HTML stops at the next "<", a destination at 32 nested parentheses, a title by a memo of
// the next quote), so a file of thousands of unclosed openers stays linear.

function parseInline(P, block, segs, inTable = false) {
  const t = P.t;
  const cs = [];
  const parts = [];
  let m = 0;
  for (const s of segs) {
    cs.push(m);
    const x = t.slice(s.from, s.eolTo);
    parts.push(x);
    m += x.length;
  }
  if (m === 0) return [];
  const c = parts.length === 1 ? parts[0] : parts.join("");
  const segOf = (x) => {
    let lo = 0;
    let hi = cs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (cs[mid] <= x) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const toSrc = (x) => {
    const k = segOf(x);
    return segs[k].from + (x - cs[k]);
  };
  const toSrcEnd = (x) => toSrc(x - 1) + 1;

  const toks = [];
  const spans = [];
  const images = [];
  const head = { ord: -1, prev: null, next: null };
  let tail = head;
  let ord = 0;
  const unlink = (d) => {
    d.prev.next = d.next;
    if (d.next) d.next.prev = d.prev;
    else tail = d.prev;
  };
  // backtick runs by length, for code span closers (each position is passed once)
  const ticks = new Map();
  for (let k = 0; k < m; ) {
    if (c.charCodeAt(k) !== 96) {
      k++;
      continue;
    }
    let e = k;
    while (e < m && c.charCodeAt(e) === 96) e++;
    let q = ticks.get(e - k);
    if (!q) ticks.set(e - k, (q = { at: [], ptr: 0 }));
    q.at.push(k);
    k = e;
  }
  const closerFor = (len, after) => {
    const q = ticks.get(len);
    if (!q) return -1;
    while (q.ptr < q.at.length && q.at[q.ptr] < after) q.ptr++;
    return q.ptr < q.at.length ? q.at[q.ptr] : -1;
  };
  // the character class around a delimiter run: 0 other, 1 whitespace, 2 punctuation (the start and end of the content are whitespace)
  const classOf = (cp) => {
    if (cp < 128) return cp === 32 || (cp >= 9 && cp <= 13) ? 1 : isAsciiPunct(cp) ? 2 : 0;
    const ch = String.fromCodePoint(cp);
    return WS.test(ch) ? 1 : PUNCT.test(ch) ? 2 : 0;
  };
  const classBefore = (x) => (x <= 0 ? 1 : classOf(c.codePointAt(x >= 2 && (c.charCodeAt(x - 1) & 0xfc00) === 0xdc00 && (c.charCodeAt(x - 2) & 0xfc00) === 0xd800 ? x - 2 : x - 1)));
  const classAt = (x) => (x >= m ? 1 : classOf(c.codePointAt(x)));
  // the next unescaped `code` at or after `from` (titles); queries come in increasing order, so each character is scanned once
  const memo = new Map();
  const nextUnesc = (code, from) => {
    const hit = memo.get(code);
    if (hit && from >= hit.from && (hit.at < 0 || from <= hit.at)) return hit.at;
    let k = from;
    let at = -1;
    while (k < m) {
      const x = c.charCodeAt(k);
      if (x === 92) k += 2;
      else if (x === code) {
        at = k;
        break;
      } else k++;
    }
    memo.set(code, { from, at });
    return at;
  };
  const skipWs = (k) => {
    while (k < m && isSpTab(c.charCodeAt(k))) k++;
    if (c.charCodeAt(k) === 10 || c.charCodeAt(k) === 13) {
      k += eolLen(c, k);
      while (k < m && isSpTab(c.charCodeAt(k))) k++;
    }
    return k;
  };
  const linkTail = (q) => {
    if (c.charCodeAt(q) !== 40) return null;
    let j = skipWs(q + 1);
    let dest;
    if (c.charCodeAt(j) === 60) {
      let k = j + 1;
      while (k < m) {
        const x = c.charCodeAt(k);
        if (x === 92 && isAsciiPunct(c.charCodeAt(k + 1))) k += 2;
        else if (x === 62 || x === 60 || x === 10 || x === 13) break;
        else k++;
      }
      if (c.charCodeAt(k) !== 62) return null;
      dest = c.slice(j + 1, k);
      j = k + 1;
    } else {
      let k = j;
      let depth = 0;
      while (k < m) {
        const x = c.charCodeAt(k);
        if (x === 92 && isAsciiPunct(c.charCodeAt(k + 1))) {
          k += 2;
          continue;
        }
        if (x <= 32 || x === 127) break;
        if (x === 40 && ++depth > 32) return null;
        if (x === 41) {
          if (depth === 0) break;
          depth--;
        }
        k++;
      }
      if (depth !== 0) return null;
      dest = c.slice(j, k);
      j = k;
    }
    let title = null;
    const j2 = skipWs(j);
    const qc = c.charCodeAt(j2);
    if (j2 > j && (qc === 34 || qc === 39 || qc === 40)) {
      const close = nextUnesc(qc === 40 ? 41 : qc, j2 + 1);
      if (close < 0) return null;
      if (qc === 40) {
        const open = nextUnesc(40, j2 + 1);
        if (open >= 0 && open < close) return null;
      }
      title = c.slice(j2 + 1, close);
      j = skipWs(close + 1);
    } else j = j2;
    if (c.charCodeAt(j) !== 41) return null;
    return { end: j + 1, dest, title };
  };
  let noComment = false;
  const htmlEnd = (i) => {
    if (c.startsWith("<!--", i)) {
      if (noComment) return 0;
      const k = c.indexOf("-->", i + 4);
      if (k < 0) return (noComment = true), 0;
      return k + 3;
    }
    const y = c.charCodeAt(i + 1);
    if (!(isAlpha(y) || y === 63 || ((y === 47 || y === 33) && isAlpha(c.charCodeAt(i + 2))))) return 0;
    let k = i + 1;
    while (k < m && c.charCodeAt(k) !== 60 && c.charCodeAt(k) !== 62) k++;
    return c.charCodeAt(k) === 62 ? k + 1 : 0;
  };
  const processEmphasis = (bottom) => {
    const floors = new Map();
    let closer = bottom.next;
    while (closer) {
      if (!closer.canClose) {
        closer = closer.next;
        continue;
      }
      const key = `${closer.ch}${closer.canOpen ? 1 : 0}${closer.orig % 3}`;
      const floor = Math.max(bottom.ord, floors.has(key) ? floors.get(key) : -1);
      let o = closer.prev;
      while (o.ord > floor) {
        const odd = (o.canClose || closer.canOpen) && (o.orig + closer.orig) % 3 === 0 && !(o.orig % 3 === 0 && closer.orig % 3 === 0);
        if (o.ch === closer.ch && o.canOpen && !odd) break;
        o = o.prev;
      }
      if (o.ord > floor) {
        const use = closer.e - closer.s >= 2 && o.e - o.s >= 2 ? 2 : 1;
        o.e -= use;
        closer.s += use;
        spans.push({ type: use === 2 ? "strong" : "em", a: o.e, b: closer.s });
        for (let x = o.next; x !== closer; ) {
          const nx = x.next;
          unlink(x);
          x = nx;
        }
        if (o.e === o.s) unlink(o);
        if (closer.e === closer.s) {
          const nx = closer.next;
          unlink(closer);
          closer = nx;
        }
      } else {
        floors.set(key, closer.prev.ord);
        const nx = closer.next;
        if (!closer.canOpen) unlink(closer);
        closer = nx;
      }
    }
  };

  // ---- the scan
  const brackets = [];
  let linkFloor = 0; // "[" openers below this index of `brackets` are inactive (a link may not contain a link)
  let ts = 0;
  const flush = (end) => {
    if (end > ts) toks.push({ t: "text", a: ts, b: end });
  };
  let i = 0;
  while (i < m) {
    const x = c.charCodeAt(i);
    if (x === 92) {
      const y = c.charCodeAt(i + 1);
      if (isAsciiPunct(y)) {
        flush(i);
        toks.push({ t: "esc", a: i, b: i + 2, d: c[i + 1] });
        i += 2;
        ts = i;
      } else if (y === 10 || y === 13) {
        flush(i);
        const b = i + 1 + eolLen(c, i + 1);
        toks.push({ t: "br", hard: true, a: i, b });
        i = b;
        ts = i;
      } else i++;
    } else if (x === 38) {
      const ent = entityAt(c, i);
      if (ent) {
        flush(i);
        toks.push({ t: "ent", a: i, b: ent.end, d: ent.value });
        i = ent.end;
        ts = i;
      } else i++;
    } else if (x === 96) {
      let e = i;
      while (e < m && c.charCodeAt(e) === 96) e++;
      const close = closerFor(e - i, e);
      if (close >= 0) {
        flush(i);
        const b = close + (e - i);
        toks.push({ t: "code", a: i, ia: e, ib: close, b });
        spans.push({ type: "code", a: i, b });
        i = b;
        ts = i;
      } else i = e;
    } else if (x === 42 || x === 95) {
      let e = i;
      while (e < m && c.charCodeAt(e) === x) e++;
      flush(i);
      const before = classBefore(i);
      const after = classAt(e);
      const wsB = before === 1;
      const wsA = after === 1;
      const pB = before === 2;
      const pA = after === 2;
      const left = !wsA && (!pA || wsB || pB);
      const right = !wsB && (!pB || wsA || pA);
      const d = { t: "delim", ch: x, a: i, b: e, s: i, e, orig: e - i, ord: ord++, prev: null, next: null };
      d.canOpen = x === 42 ? left : left && (!right || pB);
      d.canClose = x === 42 ? right : right && (!left || pA);
      toks.push(d);
      if (d.canOpen || d.canClose) {
        d.prev = tail;
        tail.next = d;
        tail = d;
      }
      i = e;
      ts = i;
    } else if (x === 91 || (x === 33 && c.charCodeAt(i + 1) === 91)) {
      flush(i);
      const tok = { t: "open", a: i, b: x === 33 ? i + 2 : i + 1, used: false };
      toks.push(tok);
      brackets.push({ tok, image: x === 33, bottom: tail });
      i = tok.b;
      ts = i;
    } else if (x === 93) {
      const top = brackets.length ? brackets[brackets.length - 1] : null;
      const tl = top && (top.image || brackets.length - 1 >= linkFloor) ? linkTail(i + 1) : null;
      if (!tl) {
        if (top) brackets.pop();
        if (linkFloor > brackets.length) linkFloor = brackets.length;
        i++;
        continue;
      }
      flush(i);
      processEmphasis(top.bottom);
      top.bottom.next = null;
      tail = top.bottom;
      top.tok.used = true;
      const sp = { type: top.image ? "image" : "link", a: top.tok.a, b: tl.end, labelA: top.tok.b, labelB: i, dest: tl.dest, title: tl.title };
      spans.push(sp);
      if (top.image) images.push(sp);
      brackets.pop();
      if (!top.image || linkFloor > brackets.length) linkFloor = brackets.length;
      i = tl.end;
      ts = i;
    } else if (x === 60) {
      const e = htmlEnd(i);
      if (e) {
        flush(i);
        toks.push({ t: "html", a: i, b: e });
        i = e;
        ts = i;
      } else i++;
    } else if (x === 10 || x === 13) {
      let w = i;
      while (w > ts && isSpTab(c.charCodeAt(w - 1))) w--;
      flush(w);
      const b = i + eolLen(c, i);
      toks.push({ t: "br", hard: i - w >= 2 && c.charCodeAt(i - 1) === 32 && c.charCodeAt(i - 2) === 32, a: w, b });
      i = b;
      ts = i;
    } else i++;
  }
  flush(m);
  processEmphasis(head);

  // ---- output: runs and skips in source coordinates
  const out = [];
  const push = (from, to, kind, display) => {
    const last = out[out.length - 1];
    if (kind === "text" && last && last.kind === "text" && last.to === from) {
      last.to = to;
      last.display += display;
      return;
    }
    out.push(runAt(P, block, from, to, kind, display));
  };
  const pieces = (a, b, fn) => {
    for (let k = segOf(a); a < b; k++) {
      const e = Math.min(b, k + 1 < cs.length ? cs[k + 1] : m);
      const f = segs[k].from + (a - cs[k]);
      fn(f, f + (e - a), a, e);
      a = e;
    }
  };
  const verbatim = (a, b, kind) => pieces(a, b, (f, to, x, y) => push(f, to, kind, c.slice(x, y)));
  const skipC = (a, b, kind) => pieces(a, b, (f, to) => skip(P, f, to, kind));
  const atomic = (a, b, kind, display) => {
    const k = segOf(a);
    let to = toSrcEnd(b);
    // a break at the end of a line takes the next line's indentation when it is whitespace only
    if (k + 1 < cs.length && b === cs[k + 1]) {
      let g = segs[k].eolTo;
      while (g < segs[k + 1].from && isSpTab(t.charCodeAt(g))) g++;
      if (g === segs[k + 1].from) to = g;
    }
    push(toSrc(a), to, kind, display);
  };
  images.sort((x, y) => x.a - y.a || y.b - x.b);
  const outer = [];
  for (const r of images) if (!outer.length || r.a >= outer[outer.length - 1].b) outer.push(r);
  let ri = 0;
  for (const k of toks) {
    while (ri < outer.length && k.a >= outer[ri].b) ri++;
    if (ri < outer.length && k.a >= outer[ri].a) {
      if (k.a === outer[ri].a) verbatim(outer[ri].a, outer[ri].b, "literal");
      continue;
    }
    if (k.t === "text" || k.t === "open") {
      if (k.t === "open" && k.used) skipC(k.a, k.b, "link");
      else verbatim(k.a, k.b, "text");
    } else if (k.t === "esc") atomic(k.a, k.b, "escape", k.d);
    else if (k.t === "ent") atomic(k.a, k.b, "entity", k.d);
    else if (k.t === "br") atomic(k.a, k.b, k.hard ? "hardbreak" : "softbreak", k.hard ? "\n" : " ");
    else if (k.t === "html") verbatim(k.a, k.b, "literal");
    else if (k.t === "delim") {
      skipC(k.a, k.s, "emphasis");
      if (k.e > k.s) verbatim(k.s, k.e, "text");
      skipC(k.e, k.b, "emphasis");
    } else if (k.t === "code") {
      skipC(k.a, k.ia, "code");
      let a = k.ia;
      if (inTable) {
        for (let q = k.ia; q + 1 < k.ib; q++) {
          if (c.charCodeAt(q) !== 92 || c.charCodeAt(q + 1) !== 124) continue;
          if (q > a) verbatim(a, q, "code");
          atomic(q, q + 2, "escape", "|");
          a = q + 2;
          q++;
        }
      }
      if (k.ib > a) verbatim(a, k.ib, "code");
      skipC(k.ib, k.b, "code");
    }
  }
  // spans: the ones inside an image are shown literally with it
  let oi = 0;
  const kept = [];
  for (const s of spans.sort((x, y) => x.a - y.a || y.b - x.b)) {
    while (oi < outer.length && s.a >= outer[oi].b) oi++;
    if (oi < outer.length && s.a >= outer[oi].a && s !== outer[oi]) continue;
    kept.push(s);
  }
  const nodes = kept.map((s) => {
    const node = { type: s.type, from: toSrc(s.a), to: toSrcEnd(s.b), children: [] };
    if (s.type === "link") {
      skipC(s.labelB, s.b, "link");
      node.href = decodeText(s.dest);
      node.title = s.title === null ? null : decodeText(s.title);
    } else if (s.type === "image") {
      node.src = decodeText(s.dest);
      node.alt = c.slice(s.labelA, s.labelB);
      node.title = s.title === null ? null : decodeText(s.title);
    }
    return node;
  });
  // nest runs into spans by position (spans nest: emphasis inside a link is processed with the link)
  const root = [];
  const stack = [{ to: Infinity, children: root }];
  let si = 0;
  const openTo = (pos) => {
    while (si < nodes.length && nodes[si].from <= pos) {
      const s = nodes[si++];
      while (stack[stack.length - 1].to <= s.from) stack.pop();
      stack[stack.length - 1].children.push(s);
      stack.push(s);
      if (stack.length - 1 > MD_LIMITS.depth) throw capDepth();
    }
  };
  for (const r of out) {
    openTo(r.from);
    while (stack[stack.length - 1].to <= r.from) stack.pop();
    stack[stack.length - 1].children.push(r);
  }
  openTo(Infinity);
  return root;
}

/** Numbers the runs in source order and checks that runs and skips tile the text exactly (a broken map is a bug: refuse, never guess). */
function finish(P) {
  P.runs.sort((a, b) => a.from - b.from);
  P.runs.forEach((r, i) => (r.id = i));
  const all = P.runs.concat(P.skips).sort((a, b) => a.from - b.from || (a.skip ? 1 : 0) - (b.skip ? 1 : 0));
  const kept = [];
  let pos = 0;
  let lastBreak = null;
  for (const x of all) {
    if (x.skip === "indent" && lastBreak && x.from >= lastBreak.from && x.to <= lastBreak.to) continue; // folded into a soft or hard break
    if (x.from !== pos || x.to <= x.from) throw new Error(`internal error: the Markdown source map is broken near offset ${pos}`);
    pos = x.to;
    if (x.kind === "softbreak" || x.kind === "hardbreak") lastBreak = x;
    if (x.skip) kept.push(x);
  }
  if (pos !== P.t.length) throw new Error(`internal error: the Markdown source map ends at ${pos} of ${P.t.length}`);
  P.skips = kept;
}

// ---- selections, carets, edits ----------------------------------------------------------------------------------------------------
const ONE_TO_ONE = new Set(["text", "code", "literal"]);
/** Is display === source.slice(from, to) for this run (text, code, literal)? Otherwise the run stands for its whole spelling. */
export const isVerbatim = (run) => ONE_TO_ONE.has(run.kind);

const GRAPHEMES = typeof Intl !== "undefined" && Intl.Segmenter ? new Intl.Segmenter("en", { granularity: "grapheme" }) : null;
/** Is offset o of s between two whole characters (grapheme clusters; without Intl.Segmenter, code points not followed by a mark)? */
function wholeAt(s, o) {
  if (o === 0 || o === s.length) return true;
  const lo = s.charCodeAt(o);
  if ((lo & 0xfc00) === 0xdc00 && (s.charCodeAt(o - 1) & 0xfc00) === 0xd800) return false;
  if (GRAPHEMES) return GRAPHEMES.segment(s).containing(o).index === o;
  return !/[\p{M}\u200D\uFE0E\uFE0F]/u.test(String.fromCodePoint(s.codePointAt(o)));
}
/** The source offset of displayed offset o in run r, or null inside a character or inside a run that stands for several characters. */
function edge(r, o) {
  if (isVerbatim(r)) return wholeAt(r.display, o) ? r.from + o : null;
  return o === 0 ? r.from : o === r.display.length ? r.to : null;
}
const validAt = (tree, id, o) => Number.isInteger(id) && id >= 0 && id < tree.runs.length && Number.isInteger(o) && o >= 0 && o <= tree.runs[id].display.length;

/**
 * A preview selection -> the exact source range it stands for. `sel` is {startRun, startOffset, endRun, endOffset}: run ids and
 * offsets in the runs' displayed strings (either order). Returns
 *   {from, to, quote}                      the mapped pieces are contiguous and both ends fall on whole characters and run boundaries
 *   {block: {id, from, to, source}, reason} otherwise: the whole enclosing leaf block is offered instead
 *   {refused: true, reason}                 nothing selected, an unknown run, or a selection across blocks
 * Never searches for matching words: only the runs' own ranges are used.
 */
export function sourceRange(tree, sel) {
  let { startRun: s, startOffset: so, endRun: e, endOffset: eo } = sel || {};
  if (!validAt(tree, s, so) || !validAt(tree, e, eo)) return { refused: true, reason: "the selection does not point at text of this version of the file; select it again" };
  if (s > e || (s === e && so > eo)) [s, so, e, eo] = [e, eo, s, so];
  const R = tree.runs;
  while (s < e && so === R[s].display.length) (s++, (so = 0));
  while (e > s && eo === 0) (e--, (eo = R[e].display.length));
  if (s === e && so === eo) return { refused: true, reason: "nothing is selected" };
  if (R[s].block !== R[e].block) return { refused: true, reason: "the selection runs across more than one block; select within one paragraph, heading, table or code block" };
  const b = tree.byId[R[s].block];
  const offer = (reason) => ({ block: { id: b.id, from: b.from, to: b.to, source: tree.text.slice(b.from, b.to) }, reason });
  const from = edge(R[s], so);
  const to = edge(R[e], eo);
  if (from === null || to === null) return offer("an end of the selection falls inside a character or inside a mark that stands for several characters of the source");
  for (let k = s; k < e; k++) if (R[k].to !== R[k + 1].from) return offer("the selection crosses formatting marks that the preview hides");
  // the ends as the server checks them (offsetAllowed): "&amp;" followed by a combining mark ends inside one character of the source
  if (!offsetAllowed(tree, from) || !offsetAllowed(tree, to)) return offer("an end of the selection falls inside a character of the source");
  return { from, to, quote: tree.text.slice(from, to) };
}

/** A caret in the preview (run id, offset in its displayed string) -> its source offset, or null when that place is not one offset. */
export function sourceOffset(tree, runId, offset) {
  if (tree.runs.length === 0 && runId == null) return 0; // an empty or whitespace-only file: the caret starts at the beginning
  if (!validAt(tree, runId, offset)) return null;
  return edge(tree.runs[runId], offset);
}

/**
 * May a replacement start or end at source offset o? Not inside a run that stands for several characters of the source (an escape, an
 * entity, a soft or hard break: "\*", "&amp;", a CRLF), and not inside one character (a surrogate pair, a grapheme cluster, CR LF). Inside
 * a one-to-one run or a mark the preview hides, any whole-character offset is a boundary. The check of every agent replacement
 * (src/markdown-file.js checkReplacements), on top of applyReplacements' own.
 */
export function offsetAllowed(tree, o) {
  if (!Number.isInteger(o) || o < 0 || o > tree.length) return false;
  const R = tree.runs;
  let lo = 0;
  let hi = R.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (R[mid].to <= o) lo = mid + 1;
    else if (R[mid].from >= o) hi = mid - 1;
    else return isVerbatim(R[mid]) && wholeAt(tree.text, o); // strictly inside run R[mid]
  }
  return wholeAt(tree.text, o);
}

// ---- the places a write changed ---------------------------------------------------------------------------------------------------
// A write of a Markdown file is a list of exact replacements of one base (an agent's replace_source ops). `reps` here is that list as
// {from, to, len}: base offsets and the length of the new text, sorted, not overlapping. Only the "changed" marks use it: no comment's
// place is ever moved from one revision to another (src/session.js, Markdown revision records).

/** Replacements {from, to, len} sorted by place (what changedRanges takes). */
export const sortReps = (reps) => reps.map((r) => ({ from: r.from, to: r.to, len: r.len })).sort((a, b) => a.from - b.from || a.to - b.to);

/**
 * The ranges a run of writes changed, in the last version: `moves` is the writes in order, each {reps}. Each replacement is its new
 * text's range there, carried through the later writes (a later write that overlaps it widens it to cover both). Exact arithmetic from
 * the applied replacements: one entry per replaced range ({from, to}, sorted; an empty one is a deletion), never a comparison of texts.
 */
export function changedRanges(moves) {
  let out = [];
  for (const m of moves) {
    const reps = sortReps(m.reps || []);
    // a point of the version before this write -> its place after (side: where a point inside a replacement goes)
    const at = (x, side) => {
      let d = 0;
      for (const p of reps) {
        if (p.to <= x && !(p.from === x && p.to === x && side === "end")) d += p.len - (p.to - p.from);
        else if (p.from < x || (p.from === x && p.to === x)) return side === "start" ? p.from + d : p.from + d + p.len;
        else break;
      }
      return x + d;
    };
    const next = out.map((r) => ({ from: at(r.from, "start"), to: Math.max(at(r.from, "start"), at(r.to, "end")) }));
    let d = 0;
    for (const p of reps) {
      next.push({ from: p.from + d, to: p.from + d + p.len });
      d += p.len - (p.to - p.from);
    }
    next.sort((x, y) => x.from - y.from || x.to - y.to);
    out = [];
    for (const r of next) {
      const last = out[out.length - 1];
      if (last && (r.from < last.to || (r.from === last.from && r.to === last.to))) last.to = Math.max(last.to, r.to);
      else out.push({ ...r });
    }
  }
  return out;
}

/**
 * The source with exact replacements applied: each {from, to, old, new} replaces source.slice(from, to) (offsets after a BOM, as in
 * readMarkdown), which must equal `old`. Replacements may not overlap or share a start, and may not split a surrogate pair. Any problem
 * refuses the whole call (an Error with `code`: "invalid", "stale", "overlap", "split"); everything outside the ranges is kept as it is.
 */
export function applyReplacements(source, reps) {
  const refuse = (code, msg) => Object.assign(new Error(msg), { code });
  if (typeof source !== "string" || !Array.isArray(reps)) throw refuse("invalid", "applyReplacements takes the file's text and a list of replacements");
  const base = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  const len = source.length - base;
  const list = reps.map((r, i) => {
    if (!r || !Number.isInteger(r.from) || !Number.isInteger(r.to) || r.from < 0 || r.to < r.from || r.to > len || typeof r.old !== "string" || typeof r.new !== "string") {
      throw refuse("invalid", `replacement ${i + 1} is not a range of this file with old and new text`);
    }
    if (source.slice(base + r.from, base + r.to) !== r.old) throw refuse("stale", `replacement ${i + 1} no longer matches the file at ${r.from} to ${r.to}; read the file again`);
    for (const p of [r.from, r.to]) {
      if ((source.charCodeAt(base + p) & 0xfc00) === 0xdc00 && (source.charCodeAt(base + p - 1) & 0xfc00) === 0xd800 && p > 0) throw refuse("split", `replacement ${i + 1} splits a character at ${p}`);
    }
    return r;
  });
  list.sort((a, b) => a.from - b.from || a.to - b.to);
  for (let k = 1; k < list.length; k++) {
    if (list[k].from < list[k - 1].to || list[k].from === list[k - 1].from) throw refuse("overlap", "two replacements overlap or start at the same place; send them as one");
  }
  const parts = [source.slice(0, base)];
  let pos = 0;
  for (const r of list) {
    parts.push(source.slice(base + pos, base + r.from), r.new);
    pos = r.to;
  }
  parts.push(source.slice(base + pos));
  return parts.join("");
}
