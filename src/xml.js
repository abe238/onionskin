// Minimal streaming XML walker for OOXML parts. No regexes over the whole document, no DTDs.
// Names are kept as written (prefix:local); Word, python-docx and the engine all use the conventional prefixes.

const MAX_DEPTH = 256;
// Attributes one tag may carry. A real OOXML tag has a few; a part's root element carries its namespace declarations (Word writes about
// 40). Past this the tag is refused: one run with 3 million attributes (7.3 MB) took 2.4 s to read.
export const MAX_ATTRS_PER_TAG = 512;
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function decodeEntities(s) {
  if (!s.includes("&")) return s;
  const parts = []; // decoded pieces, joined once: text that is not an entity is copied as one slice, never per "&"
  let last = 0; // s[last..] is not copied yet
  let i = 0;
  for (let amp = s.indexOf("&"); amp >= 0; amp = s.indexOf("&", i)) {
    i = amp + 1;
    // a name is at most 9 characters, so look for its ";" in the next 10 only: an unbounded search per "&" made a long run of "&" quadratic
    let semi = -1;
    for (let j = amp + 1, lim = Math.min(s.length, amp + 11); j < lim; j++) {
      if (s.charCodeAt(j) === 59) {
        semi = j;
        break;
      }
    }
    if (semi < 0) continue; // a literal "&"
    const name = s.slice(amp + 1, semi);
    let rep;
    if (Object.hasOwn(ENTITIES, name)) rep = ENTITIES[name]; // own names only: "&toString;" is not an entity
    else if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      if (Number.isInteger(code) && code > 0 && code <= 0x10ffff) rep = String.fromCodePoint(code);
    }
    if (rep === undefined) continue; // unknown name: the "&" stays, the name is read as text
    parts.push(s.slice(last, amp), rep);
    last = i = semi + 1;
  }
  if (!parts.length) return s;
  parts.push(s.slice(last));
  return parts.join("");
}

/**
 * A document too large or too dense for Onionskin to read within its limits. The message is plain words a person can act on; the server
 * answers it with its own status and message, never as an internal error. `limit` names the cap (for tests and logs).
 */
export class CapError extends Error {
  constructor(message, limit) {
    super(message);
    this.limit = limit;
  }
}

/**
 * What one reading of a document may cost, shared by every part a reader walks (pass the same object to each walkXml call): XML elements,
 * attributes, characters of text and characters of XML walked, counted down as the walk goes. `what` names the document in the message ("document", "deck",
 * "workbook"). Past a limit, walkXml throws a CapError.
 */
export function readBudget({ elements, attrs, text, chars = MAX_READ_CHARS, what = "document", split = "smaller documents" }) {
  return { elements, attrs, text, chars, caps: { elements, attrs, text, chars }, what, split };
}
// Characters of XML one reading may walk, over all its parts (a part of one 60 MB attribute is no element and no text, but walking four
// of them took 1.5 s). A Word document of 1,600 ordinary pages has about 18 million.
export const MAX_READ_CHARS = 32_000_000;
/** The CapError for more than `n` of `noun` in the document a budget reads. */
export const tooMany = (b, n, noun) => new CapError(`this ${b.what} has more than ${n.toLocaleString("en-US")} ${noun}, more than Onionskin can read. Split it into ${b.split} and open those`, noun);

/** The CapError for XML nested deeper than MAX_DEPTH (a limit like the others: answered in plain words, never as an internal error). */
export const tooDeep = () => new CapError(`this file nests XML more than ${MAX_DEPTH} levels deep, more than Onionskin can read. The file may be damaged, or made to stall programs that read it: if Word, Excel or PowerPoint opens it, save a copy there and open the copy`, "nesting depth");
/** The first `ch` in src[from..end), or -1. Bounded by the tag: indexOf would scan the rest of the part for every attribute (quadratic). */
function findIn(src, ch, from, end) {
  for (let k = from; k < end; k++) if (src[k] === ch) return k;
  return -1;
}

function parseTag(src, start, end) {
  // src[start..end) is the inside of <...> without the angle brackets
  let i = start;
  let selfClosing = false;
  if (src[end - 1] === "/") {
    selfClosing = true;
    end -= 1;
  }
  while (i < end && !/\s/.test(src[i])) i++;
  const name = src.slice(start, i);
  const attrs = {};
  let count = 0;
  while (i < end) {
    while (i < end && /\s/.test(src[i])) i++;
    if (i >= end) break;
    const eq = findIn(src, "=", i, end);
    if (eq < 0) break;
    const key = src.slice(i, eq).trim();
    i = eq + 1;
    while (i < end && /\s/.test(src[i])) i++;
    const q = src[i];
    if (q !== '"' && q !== "'") break;
    const close = findIn(src, q, i + 1, end);
    if (close < 0) break;
    if (++count > MAX_ATTRS_PER_TAG) throw new CapError(`a tag in this file has more than ${MAX_ATTRS_PER_TAG} attributes, more than Onionskin can read. The file may be damaged, or made to stall programs that read it: if Word, Excel or PowerPoint opens it, save a copy there and open the copy`, "attributes per tag");
    attrs[key] = decodeEntities(src.slice(i + 1, close));
    i = close + 1;
  }
  return { name, attrs, selfClosing, count };
}

/**
 * Calls onOpen(name, attrs), onText(text), onClose(name) in document order. Throws on DTDs, excess depth and a closing tag with nothing
 * open, and a CapError past MAX_ATTRS_PER_TAG or past `budget` (readBudget: counted down across every part of one reading).
 */
export function walkXml(xml, { onOpen, onClose, onText }, budget = null) {
  let i = 0;
  let depth = 0;
  const n = xml.length;
  if (budget && (budget.chars -= n) < 0) throw tooMany(budget, budget.caps.chars, "characters of XML");
  const text = (t) => {
    if (budget && (budget.text -= t.length) < 0) throw tooMany(budget, budget.caps.text, "characters of text");
    onText(t);
  };
  while (i < n) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) {
      if (onText && i < n) text(decodeEntities(xml.slice(i)));
      break;
    }
    if (lt > i && onText) text(decodeEntities(xml.slice(i, lt)));
    if (xml.startsWith("<!--", lt)) {
      const e = xml.indexOf("-->", lt + 4);
      if (e < 0) throw new Error("unterminated comment");
      i = e + 3;
    } else if (xml.startsWith("<![CDATA[", lt)) {
      const e = xml.indexOf("]]>", lt + 9);
      if (e < 0) throw new Error("unterminated CDATA");
      if (onText) text(xml.slice(lt + 9, e));
      i = e + 3;
    } else if (xml.startsWith("<?", lt)) {
      const e = xml.indexOf("?>", lt + 2);
      if (e < 0) throw new Error("unterminated processing instruction");
      i = e + 2;
    } else if (xml.startsWith("<!", lt)) {
      throw new Error("DTD or entity declarations are not allowed");
    } else {
      // find the closing '>' outside quotes
      let j = lt + 1;
      let q = "";
      while (j < n) {
        const c = xml[j];
        if (q) {
          if (c === q) q = "";
        } else if (c === '"' || c === "'") q = c;
        else if (c === ">") break;
        j++;
      }
      if (j >= n) throw new Error("unterminated tag");
      if (xml[lt + 1] === "/") {
        // a closing tag with nothing open would let the depth limit drift: callers keep a stack of open names and scan it per element
        if (--depth < 0) throw new Error("closing tag without an open element");
        if (onClose) onClose(xml.slice(lt + 2, j).trim());
      } else {
        const tag = parseTag(xml, lt + 1, j);
        if (budget) {
          if (--budget.elements < 0) throw tooMany(budget, budget.caps.elements, "XML elements");
          if ((budget.attrs -= tag.count) < 0) throw tooMany(budget, budget.caps.attrs, "XML attributes");
        }
        if (onOpen) onOpen(tag.name, tag.attrs);
        if (tag.selfClosing) {
          if (onClose) onClose(tag.name);
        } else {
          depth++;
          if (depth > MAX_DEPTH) throw tooDeep();
        }
      }
      i = j + 1;
    }
  }
}
