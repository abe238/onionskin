// Minimal streaming XML walker for OOXML parts. No regexes over the whole document, no DTDs.
// Names are kept as written (prefix:local); Word, python-docx and the engine all use the conventional prefixes.

const MAX_DEPTH = 256;
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function decodeEntities(s) {
  if (!s.includes("&")) return s;
  let out = "";
  let i = 0;
  while (i < s.length) {
    const amp = s.indexOf("&", i);
    if (amp < 0) {
      out += s.slice(i);
      break;
    }
    out += s.slice(i, amp);
    const semi = s.indexOf(";", amp);
    if (semi < 0 || semi - amp > 10) {
      out += "&";
      i = amp + 1;
      continue;
    }
    const name = s.slice(amp + 1, semi);
    let rep;
    if (name in ENTITIES) rep = ENTITIES[name];
    else if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      if (Number.isInteger(code) && code > 0 && code <= 0x10ffff) rep = String.fromCodePoint(code);
    }
    if (rep === undefined) {
      out += "&";
      i = amp + 1;
    } else {
      out += rep;
      i = semi + 1;
    }
  }
  return out;
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
  while (i < end) {
    while (i < end && /\s/.test(src[i])) i++;
    if (i >= end) break;
    const eq = src.indexOf("=", i);
    if (eq < 0 || eq >= end) break;
    const key = src.slice(i, eq).trim();
    i = eq + 1;
    while (i < end && /\s/.test(src[i])) i++;
    const q = src[i];
    if (q !== '"' && q !== "'") break;
    const close = src.indexOf(q, i + 1);
    if (close < 0 || close >= end) break;
    attrs[key] = decodeEntities(src.slice(i + 1, close));
    i = close + 1;
  }
  return { name, attrs, selfClosing };
}

/** Calls onOpen(name, attrs), onText(text), onClose(name) in document order. Throws on DTDs and excess depth. */
export function walkXml(xml, { onOpen, onClose, onText }) {
  let i = 0;
  let depth = 0;
  const n = xml.length;
  while (i < n) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) {
      if (onText && i < n) onText(decodeEntities(xml.slice(i)));
      break;
    }
    if (lt > i && onText) onText(decodeEntities(xml.slice(i, lt)));
    if (xml.startsWith("<!--", lt)) {
      const e = xml.indexOf("-->", lt + 4);
      if (e < 0) throw new Error("unterminated comment");
      i = e + 3;
    } else if (xml.startsWith("<![CDATA[", lt)) {
      const e = xml.indexOf("]]>", lt + 9);
      if (e < 0) throw new Error("unterminated CDATA");
      if (onText) onText(xml.slice(lt + 9, e));
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
        depth--;
        if (onClose) onClose(xml.slice(lt + 2, j).trim());
      } else {
        const tag = parseTag(xml, lt + 1, j);
        if (onOpen) onOpen(tag.name, tag.attrs);
        if (tag.selfClosing) {
          if (onClose) onClose(tag.name);
        } else {
          depth++;
          if (depth > MAX_DEPTH) throw new Error("XML nesting too deep");
        }
      }
      i = j + 1;
    }
  }
}
