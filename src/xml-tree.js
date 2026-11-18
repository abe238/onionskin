import { CapError, MAX_ATTRS_PER_TAG, decodeEntities, tooDeep } from "./xml.js";

// A lossless element tree for one OOXML part: every node keeps its raw source text, so serialize(parse(x)) === x exactly and a builder
// can rewrite a few elements while every other byte stays as the writer left it. Refuses DTDs and entity declarations; depth 256.
// Nodes: {t: "el", name, open, close, kids, parent} (close is "" for a self-closing tag), {t: "text", raw}, {t: "raw", raw} (comment,
// processing instruction), {t: "cdata", raw}, and {t: "out", raw} or {t: "lazy", build} which only builders add.

const MAX_DEPTH = 256;

export function parse(xml) {
  const root = { t: "root", kids: [], parent: null };
  const stack = [root];
  const n = xml.length;
  let i = 0;
  const top = () => stack[stack.length - 1];
  const add = (node) => {
    node.parent = top();
    top().kids.push(node);
    return node;
  };
  while (i < n) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) {
      add({ t: "text", raw: xml.slice(i) });
      break;
    }
    if (lt > i) add({ t: "text", raw: xml.slice(i, lt) });
    let end;
    if (xml.startsWith("<!--", lt)) {
      end = xml.indexOf("-->", lt + 4);
      if (end < 0) throw new Error("unterminated comment");
      add({ t: "raw", raw: xml.slice(lt, (end += 3)) });
    } else if (xml.startsWith("<![CDATA[", lt)) {
      end = xml.indexOf("]]>", lt + 9);
      if (end < 0) throw new Error("unterminated CDATA");
      add({ t: "cdata", raw: xml.slice(lt, (end += 3)) });
    } else if (xml.startsWith("<?", lt)) {
      end = xml.indexOf("?>", lt + 2);
      if (end < 0) throw new Error("unterminated processing instruction");
      add({ t: "raw", raw: xml.slice(lt, (end += 2)) });
    } else if (xml.startsWith("<!", lt)) {
      throw new Error("DTD or entity declarations are not allowed");
    } else {
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
      end = j + 1;
      const tag = xml.slice(lt, end);
      if (tag[1] === "/") {
        const name = tag.slice(2, -1).trim();
        const el = top();
        if (el.t !== "el" || el.name !== name) throw new Error(`mismatched closing tag </${name}>`);
        el.close = tag;
        stack.pop();
      } else {
        const self = tag[tag.length - 2] === "/";
        const m = /^<([^\s/>]+)/.exec(tag);
        if (!m) throw new Error("bad tag");
        const el = add({ t: "el", name: m[1], open: tag, close: "", kids: [] });
        if (!self) {
          stack.push(el);
          if (stack.length - 1 > MAX_DEPTH) throw tooDeep();
        }
      }
    }
    i = end;
  }
  if (stack.length !== 1) throw new Error("unclosed element");
  return root;
}

export function serialize(node) {
  switch (node.t) {
    case "root":
      return node.kids.map(serialize).join("");
    case "el":
      return node.open + node.kids.map(serialize).join("") + node.close;
    case "lazy":
      return node.build();
    default:
      return node.raw;
  }
}

/** The attributes of an element's open tag, decoded, in source order: [[name, value]]. */
export function attrs(el) {
  const out = [];
  const re = /\s([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  const body = el.open.slice(1 + el.name.length);
  let m;
  while ((m = re.exec(body))) {
    if (out.length >= MAX_ATTRS_PER_TAG) throw new CapError(`a tag in this file has more than ${MAX_ATTRS_PER_TAG} attributes, more than Onionskin can read. The file may be damaged, or made to stall programs that read it: if Word, Excel or PowerPoint opens it, save a copy there and open the copy`, "attributes per tag");
    out.push([m[1], decodeEntities(m[3] ?? m[4])]);
  }
  return out;
}
export const attr = (el, name) => attrs(el).find((a) => a[0] === name)?.[1];

/** The decoded text of a text or CDATA node. */
export const textOf = (node) => (node.t === "cdata" ? node.raw.slice(9, -3) : node.t === "text" ? decodeEntities(node.raw) : "");

export const elements = (el) => el.kids.filter((k) => k.t === "el");

export function* descendants(el) {
  for (const k of el.kids || []) {
    if (k.t !== "el") continue;
    yield k;
    yield* descendants(k);
  }
}

export const escText = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const escAttr = (s) => escText(s).replace(/"/g, "&quot;");
