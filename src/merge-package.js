import { createHash } from "node:crypto";
import { walkXml } from "./xml.js";
import { openZip } from "./zip.js";

// The whole package as the proof of a merge reads it (src/merge-proof.js): every part of the OOXML zip, compared between versions in a
// canonical form, and the main parts cut into units (DOCX paragraphs, PPTX shapes, XLSX cells and rows) whose canonical XML is split
// into what the proof models one by one (text, run properties by character, the paragraph's style, alignment and list, cell values)
// and a residue of everything else. Two units, or two parts, are the same only when their canonical forms are equal: nothing is
// compared by a list of chosen fields, so a difference of a kind no one thought of is still a difference.
//
// Canonical XML: element and attribute names by namespace URI (prefixes do not count: XML Namespaces), attributes sorted (their order
// is not content in XML), entities decoded, comments and processing instructions dropped (no Office program reads them inside a
// package part), and white space between elements dropped where an element holds other elements (OOXML has no mixed content: text lives
// in leaf elements such as w:t, a:t and v, whose white space is kept as written). Custom data parts (customXml/) are not OOXML and may
// be mixed content: their white space is kept wherever it stands.
//
// VOLATILE: content the engine rewrites on its own when it writes a unit (measured: every committed fixture opened and saved unedited
// through the engine path the page and the merge use came back byte for byte; one edit through the same path changed nothing outside
// the edited unit except these, inside it). Each is KEPT in the canonical form, marked (VOL before the attribute's name), and judged by
// one rule (sameVolatile below, used by every comparison of src/merge-proof.js):
//   - a difference in it between base and mine is the person's (their own bytes: a proofing language set from en-US to fr-FR, a
//     space kept or not, a workbook asked to compute on open), and must be in the result as mine has it, or be handed back;
//   - the engine's own rewrite is allowed only where the person left it as base had it: between mine and the result on a unit the
//     merge wrote for them, and between the agent's version and the result.
// The attributes:
//   - xml:space on any element. The engine adds xml:space="preserve" to the text elements it writes (w:t, an inline string's t).
//   - lang and dirty on a DrawingML run's a:rPr. The engine writes lang="en-US" dirty="0" on every run it writes in a shape: the
//     spell-check language and the "text changed since the last spell check" flag.
//   - fullCalcOnLoad on a workbook's calcPr. The engine writes <calcPr fullCalcOnLoad="1"/> when it writes a formula, which it does not
//     compute (measured on test/merge-xlsx-property.test.js: every case where the merge carried a formula).
// Read as absent, with the reason they cannot hide a person's change:
//   - an empty w:rPr or a:rPr, and a calcPr left empty (no attribute, no child): an empty list of properties sets nothing, the same as
//     none, and a calcPr without attributes holds every calculation setting at its default, as no calcPr does. The engine drops
//     <w:rPr/> from a run it edits. (An a:rPr that holds only lang or dirty is not empty: it is compared by the rule above.)
//   - w:proofErr, the mark where Word last found a spelling or grammar error: no text, no formatting, never printed or shown but as
//     the spell checker's squiggle, and Word checks again on open and writes them anew. The engine moves these marks when it edits the
//     text next to them, differently for two edits that give the same text (measured on the committed corpus files delins.docx and
//     52449.docx: a word typed after "Tika" moved the marks around the next space), so the rule above would hand back ordinary typing.
// Everything else counts, rsid attributes included (the engine never changes them, so they never differ between the versions of a
// merge unless a person's other program wrote them).
//
// Cost: one pass over each part read (linear), each unit's canonical string built once; binary parts compared by their stored bytes
// first (no inflation when they are equal), then inflated. Ceiling: a version with more than MAX_TOTAL_EXPANSION bytes of parts that
// differ from another version is not read (src/zip.js): the merge stops with an error and writes nothing.

const XMLNS = "http://www.w3.org/XML/1998/namespace";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const WML = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const SPACE = `{${XMLNS}}space`;
const ARPR = `{${A}}rPr`;
const SML = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const CALC = `{${SML}}calcPr`;
const EMPTY_DROPPED = new Set([`{${WML}}rPr`, ARPR, CALC]);
const volatileAttr = (el, at) => at === SPACE || (el === ARPR && (at === "lang" || at === "dirty")) || (el === CALC && at === "fullCalcOnLoad");
/** marks a VOLATILE attribute in a canonical tag: ` \u0001name="value"` */
export const VOL = "\u0001";
const VOL_ATTR = / \u0001[^=]*="[^"]*"/g;
const EMPTIED = new RegExp(`<(${[...EMPTY_DROPPED].map((q) => q.replace(/[{}./:]/g, "\\$&")).join("|")})></>`, "g");
/** A canonical string without its VOLATILE attributes (an element they leave empty is then read as absent, as above). */
export const loose = (s) => (typeof s === "string" && s.includes(VOL) ? s.replace(VOL_ATTR, "").replace(EMPTIED, "") : s);
/** The VOLATILE attributes of a canonical string alone, in order, each with the element it stands on. */
export const volOf = (s) => {
  if (typeof s !== "string" || !s.includes(VOL)) return "";
  const out = [];
  for (const m of s.matchAll(/<([^ >]*)([^>]*)>/g)) if (m[2].includes(VOL)) out.push(`${m[1]}${m[2].match(VOL_ATTR).join("")}`);
  return out.join("");
};
/**
 * THE RULE for VOLATILE content, written once. `b`, `m`, `r`: the same unit (a part's child, a character's run properties, a
 * paragraph's or a shape's residue) in base, mine and the result, as canonical strings (or as anything `key` reads one from). Is mine's
 * unit in the result? Equal; or equal but for VOLATILE, where the person left VOLATILE as base had it (the engine's rewrite of a unit
 * it wrote: its xml:space, its lang and dirty, its fullCalcOnLoad). A difference between base and mine in VOLATILE is the person's,
 * so then only equal counts. (Between the agent's version and the result, VOLATILE alone is the engine's: looseSame.)
 */
export function sameVolatile(b, m, r) {
  if (r === m) return true;
  if (r == null || m == null) return false;
  return loose(r) === loose(m) && volOf(b ?? "") === volOf(m);
}
/** Equal but for VOLATILE: the agent's unit and the result's, where the engine may have written it. */
export const looseSame = (t, r) => t === r || (t != null && r != null && loose(t) === loose(r));
const DROPPED = new Set([`{${WML}}proofErr`]); // elements read as absent, whatever they hold
// On/off properties, read the one way every comparison sees them (round 8: "typo" made bold as <w:b w:val="true"/> was compared as a
// different property from the <w:b/> the merge writes, and the proof refused an ordinary merge). WordprocessingML's CT_OnOff elements
// of run and paragraph properties (ST_OnOff: on is no w:val, "true", "1" or "on"; off is "false", "0" or "off") are written as no
// w:val for on and w:val="0" for off. Off stays an element: written off is not the same as absent where a style turns it on.
// DrawingML's run properties say bold and italic with xsd:boolean attributes ("true" or "1", "false" or "0"), written "1" and "0";
// SpreadsheetML's font properties as below.
const ON_OFF = new Set(["b", "bCs", "i", "iCs", "caps", "smallCaps", "strike", "dstrike", "outline", "shadow", "emboss", "imprint", "noProof", "snapToGrid", "vanish", "webHidden", "specVanish", "rtl", "cs", "oMath", "keepNext", "keepLines", "pageBreakBefore", "widowControl", "suppressLineNumbers", "suppressAutoHyphens", "kinsoku", "wordWrap", "overflowPunct", "topLinePunct", "autoSpaceDE", "autoSpaceDN", "bidi", "adjustRightInd", "mirrorIndents", "suppressOverlap", "contextualSpacing"].map((l) => `{${WML}}${l}`));
const W_VAL = `{${WML}}val`;
const ST_ON_OFF = { true: "", 1: "", on: "", false: "0", 0: "0", off: "0" };
const A_RUN = new Set(["rPr", "defRPr", "endParaRPr"].map((l) => `{${A}}${l}`));
const XSD_BOOL = { true: "1", 1: "1", false: "0", 0: "0" };
// SpreadsheetML's font properties (CT_BooleanProperty: val is an xsd:boolean, true when absent), written as no val for on and val="0"
// for off, in a font of styles.xml and in a shared string's run properties alike
const S_BOOL = new Set(["b", "i", "strike", "condense", "extend", "outline", "shadow"].map((l) => `{${SML}}${l}`));
/** an attribute's value as compared: on/off spellings in one form (above); undefined drops the attribute */
const valueOf = (el, at, v) => {
  if (at === W_VAL && ON_OFF.has(el) && Object.hasOwn(ST_ON_OFF, v)) return ST_ON_OFF[v] || undefined;
  if ((at === "b" || at === "i") && A_RUN.has(el) && Object.hasOwn(XSD_BOOL, v)) return XSD_BOOL[v];
  if (at === "val" && S_BOOL.has(el) && Object.hasOwn(XSD_BOOL, v)) return XSD_BOOL[v] === "1" ? undefined : "0";
  return v;
};

const ESC = /[&<>"]/;
const esc = (s) => (ESC.test(s) ? s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;") : s);
const WS = /^[ \t\r\n]*$/;
const hash = (s) => createHash("sha1").update(s).digest("base64");

// resolved names, per namespace map (a map is shared by every element until one declares a namespace): one lookup per name
const RESOLVED = new WeakMap();
function qname(map, name, element) {
  let memo = RESOLVED.get(map);
  if (!memo) RESOLVED.set(map, (memo = new Map()));
  const key = element ? name : `@${name}`;
  let q = memo.get(key);
  if (q !== undefined) return q;
  const i = name.indexOf(":");
  if (i < 0) q = element && map.get("") ? `{${map.get("")}}${name}` : name;
  else q = `{${map.get(name.slice(0, i)) ?? name.slice(0, i)}}${name.slice(i + 1)}`;
  memo.set(key, q);
  return q;
}

/**
 * Walks `xml` in canonical form: ev.open(rawName, attrs, tag, prefixes), ev.text(text), ev.close(rawName). `tag` is the canonical open tag
 * (`<{uri}local a="v">`, attributes sorted, VOLATILE ones dropped), `prefixes` the namespace prefixes in scope; text is decoded. Linear.
 */
export function walkCanonical(xml, ev, budget = null, { lazyTags = false, keepSpace = false } = {}) {
  // `lazyTags`: ev.open gets a function that builds the tag, for a reader that needs few of them (a sheet's million cells)
  const ns = [new Map([["xml", XMLNS]])];
  const kids = [];
  let pend = "";
  let lazy = null; // the open tag of an empty-candidate property element, sent once something is inside it
  const flush = () => {
    if (lazy) ev.open(lazy.name, lazy.a, lazy.tag, lazy.m);
    lazy = null;
  };
  let gone = 0; // > 0 inside a DROPPED element
  walkXml(xml, {
    onOpen(name, a) {
      if (gone) return void gone++;
      let m = ns[ns.length - 1];
      for (const k in a) if (k === "xmlns" || k.startsWith("xmlns:")) (m === ns[ns.length - 1] && (m = new Map(m)), m.set(k === "xmlns" ? "" : k.slice(6), a[k]));
      const had0 = kids.length ? kids[kids.length - 1] : false;
      if (kids.length) kids[kids.length - 1] = true;
      pend = "";
      flush();
      ns.push(m);
      const q = qname(m, name, true);
      if (DROPPED.has(q)) {
        ns.pop();
        if (kids.length) kids[kids.length - 1] = had0;
        return void (gone = 1);
      }
      const build = () => {
        const at = [];
        for (const k in a) {
          if (k === "xmlns" || k.startsWith("xmlns:")) continue;
          const qa = qname(m, k, false);
          const v = valueOf(q, qa, a[k]);
          if (v !== undefined) at.push(`${volatileAttr(q, qa) ? VOL : ""}${qa}="${esc(v)}"`);
        }
        if (at.length > 1) at.sort();
        return `<${q}${at.length ? ` ${at.join(" ")}` : ""}>`;
      };
      kids.push(false);
      const empty = EMPTY_DROPPED.has(q);
      const tag = empty || !lazyTags ? build() : null;
      const bare = empty && tag === `<${q}>`;
      const give = lazyTags ? (tag === null ? build : () => tag) : tag;
      if (bare) lazy = { name, a, tag: give, m };
      else ev.open(name, a, give, m);
    },
    onText(t) {
      if (gone) return;
      if (!keepSpace && WS.test(t)) return void (pend += t);
      flush();
      if (pend) ev.text(pend);
      pend = "";
      ev.text(t);
    },
    onClose(name) {
      if (gone) return void gone--;
      const had = kids.pop();
      ns.pop();
      if (lazy) {
        // an empty run property list: the same as none
        lazy = null;
        pend = "";
        return;
      }
      if (!had && pend) ev.text(pend);
      pend = "";
      ev.close(name);
    },
  }, budget);
}

/** The canonical form of a whole XML part, as one string. */
export function canonical(xml, opts = {}) {
  const out = [];
  walkCanonical(xml, { open: (_n, _a, tag) => out.push(tag), text: (t) => out.push(esc(t)), close: () => out.push("</>") }, null, opts);
  return out.join("");
}

// ---- parts -----------------------------------------------------------------------------------------------------------------------

const isXml = (name) => /\.(xml|rels|vml)$/i.test(name) || name === "[Content_Types].xml";
// children of a part's root element, keyed by their identity where they carry one (so one style, one numbering definition, one
// comment, one relationship is one unit), else by name and order
const KEY_ATTRS = ["styleId", "abstractNumId", "numId", "id", "Id", "Extension", "PartName", "name"];
const keyOf = (name, a) => {
  for (const k of KEY_ATTRS) for (const ak in a) if (ak === k || ak.endsWith(`:${k}`)) return `${name.slice(name.indexOf(":") + 1)}[${k}=${a[ak]}]`;
  return null;
};

/** A unit as the proof compares it: hashes of its canonical string `s`, of the string without VOLATILE `l`, and of VOLATILE alone `v`. */
const unitOf = (str) => {
  const l = loose(str);
  return { s: hash(str), l: l === str ? null : hash(l), v: str.includes(VOL) ? hash(volOf(str)) : "" };
};
/** sameVolatile (above) on units read by unitOf: the rule, on hashes */
export const unitCarried = (b, m, r) => r === m || (r != null && m != null && (r.s === m.s || ((r.l ?? r.s) === (m.l ?? m.s) && (b?.v ?? "") === m.v)));
/** looseSame on units */
export const unitLooseSame = (t, r) => t === r || (t != null && r != null && (t.s === r.s || (t.l ?? t.s) === (r.l ?? r.s)));
export const unitSame = (x, y) => x === y || (x != null && y != null && x.s === y.s);

// The collections whose order means nothing, named one by one: a child of one of these parts with one of these names is found by its
// identity wherever it stands, and moving it is no change. Every other child keeps its place in "@order", identity or not: in custom data
// (customXml/) <item id="a"> and <item id="b"> swapped is the data's own order changed (round 8: it was merged as no change).
const UNORDERED = [
  // OPC (ECMA-376 Part 2): a relationship is found by its Id, a content type by its extension or part name; neither list has an order
  [/(^|\/)_rels\/[^/]*\.rels$/i, ["Relationship"]],
  [/^\[Content_Types\]\.xml$/, ["Default", "Override"]],
  // WordprocessingML: the body names these by id (w:pStyle, w:numId and the abstractNumId it points at, w:commentReference,
  // w:footnoteReference, w:endnoteReference) and a run's font by name; where each definition stands in its part is not read
  [/^word\/styles\.xml$/i, ["style"]],
  [/^word\/numbering\.xml$/i, ["abstractNum", "num"]],
  [/^word\/comments\.xml$/i, ["comment"]],
  [/^word\/footnotes\.xml$/i, ["footnote"]],
  [/^word\/endnotes\.xml$/i, ["endnote"]],
  [/^word\/fontTable\.xml$/i, ["font"]],
];
// Within an unordered collection, the members that compete keep their order: two styles of one type both marked w:default (Word takes
// the first: the eighth review reversed a Plain and a Bold default and it was merged as no change). Their order is kept in "@order"
// among those of the same type only (Normal, the default table style and No List are each the default of their own type; their order
// against each other means nothing). A member with a duplicate key is a unit of its own by its place already (keyedUnits put).
// The attributes are read by namespace (any prefix bound to WordprocessingML's, never another namespace's `type`; one without a prefix
// still counts, as it did, w:type first), and a style without w:type is a paragraph style, as Word and the engine read it (the ninth
// review: Plain without w:type and Bold with "paragraph" were grouped apart, and the person's reversal of them was merged as no change).
const ON = new Set(["1", "true", "on"]);
const W_DEFAULT = `{${WML}}default`;
const W_TYPE = `{${WML}}type`;
/** the group a member competes in (its w:type, "paragraph" without one), or null when it is not marked w:default; `m`: the prefixes in scope */
const competes = (a, m) => {
  let on = false;
  let wType = null;
  let bare = null;
  for (const k in a) {
    const q = qname(m, k, false);
    if (q === W_DEFAULT || q === "default") on ||= ON.has(a[k]);
    else if (q === W_TYPE) wType = a[k];
    else if (q === "type") bare = a[k];
  }
  return on ? (wType ?? bare ?? "paragraph") : null;
};
/** the local names of the children of part `name` whose order means nothing (UNORDERED), or null */
export const unorderedIn = (name) => {
  const hit = UNORDERED.find(([re]) => re.test(name));
  return hit ? new Set(hit[1]) : null;
};

/**
 * The units of one part, Map key -> unitOf: "@root" (the root element's own tag), each child of the root by its identity (keyOf) or
 * `name#n`, the root's own text by where it stands ("@text#n": after n children), and "@order", the order of the children, by key, but
 * for the collections `unordered` names (a set of local names, UNORDERED above): a style, a list definition, a comment, a relationship
 * is found by its identity wherever it stands, and its order is not what it means. `skip(localName)`: true for children modeled elsewhere;
 * "each" for a list whose members are modeled elsewhere (which slides, which sheets, in which order) but whose attributes are not: each
 * member is then a unit "~<list>/<key>" of what is left once `strip` takes out the modeled attributes.
 */
function keyedUnits(xml, skip = null, { keepSpace = false, strip = null, unordered = null } = {}) {
  const units = new Map();
  let depth = 0;
  let cur = null;
  let key = null;
  let each = null; // the list open whose members are units
  let kids = 0;
  const seen = new Map();
  const order = [];
  const rivals = new Map(); // competes() group -> keys in document order
  const put = (k0, str) => {
    // a key seen twice keeps both, in order
    let k = k0;
    for (let n = 2; units.has(k); n++) k = `${k0}~${n}`;
    units.set(k, unitOf(str));
  };
  walkCanonical(xml, {
    open(name, a, tag, prefixes) {
      depth++;
      if (depth === 1) return void units.set("@root", unitOf(tag));
      if (depth === 2) {
        kids++;
        const local = name.slice(name.indexOf(":") + 1);
        const how = skip?.(local);
        cur = null;
        key = null;
        if (how === "each") each = local;
        if (how) return;
        key = keyOf(name, a);
        if (!key) {
          const n = seen.get(local) || 0;
          seen.set(local, n + 1);
          key = `${local}#${n}`;
          order.push(key);
        } else if (!unordered?.has(local)) order.push(key);
        else {
          const g = competes(a, prefixes);
          if (g !== null) (rivals.get(g) || rivals.set(g, []).get(g)).push(key);
        }
        cur = [];
      } else if (depth === 3 && each) {
        key = `~${each}/${keyOf(name, a) ?? name}`;
        cur = [strip ? strip(tag) : tag];
        return;
      }
      cur?.push(tag);
    },
    text(t) {
      if (depth === 1) put(`@text#${kids}`, esc(t));
      else cur?.push(esc(t));
    },
    close() {
      if (depth >= 2) cur?.push("</>");
      if ((depth === 2 && cur) || (depth === 3 && each && cur)) {
        put(key, cur.join(""));
        cur = null;
      }
      if (depth === 2) each = null;
      depth--;
    },
  }, null, { keepSpace });
  for (const g of [...rivals.keys()].sort()) if (rivals.get(g).length > 1) order.push(`|default ${g}:`, ...rivals.get(g));
  units.set("@order", unitOf(order.join(" ")));
  return units;
}

/** A package: its part names and a lazy, cached reading of each part's units (see partUnits). */
export function readPackage(bytes) {
  const zip = openZip(bytes);
  const cache = new Map();
  return {
    zip,
    names: zip.names,
    has: (name) => zip.entries.has(name),
    raw: (name) => zip.raw(name),
    method: (name) => zip.entries.get(name)?.method,
    text: (name) => zip.readText(name),
    /** Map key -> unit (unitOf); for a binary part, one key "@bytes"; null when the part is absent */
    units(name, skip = null, strip = null) {
      if (!zip.entries.has(name)) return null;
      const id = `${name}\0${skip ? "skip" : ""}`;
      if (cache.has(id)) return cache.get(id);
      let u;
      const bytesOf = () => new Map([["@bytes", { s: hash(zip.read(name)), l: null, v: "" }]]);
      if (!isXml(name)) u = bytesOf();
      else {
        try {
          u = keyedUnits(zip.readText(name), skip, { keepSpace: /^customxml\//i.test(name), strip, unordered: unorderedIn(name) });
        } catch {
          u = bytesOf(); // not well-formed XML: its bytes are what can be compared
        }
      }
      cache.set(id, u);
      return u;
    },
  };
}

/** Are a part's stored bytes the same in two packages (same method, same compressed bytes)? Then nothing needs inflating. */
export const sameStored = (P, Q, name) => P.has(name) && Q.has(name) && P.method(name) === Q.method(name) && P.raw(name).equals(Q.raw(name));

/** What a person reads for a part they changed: a few words, by where the part sits in the package. */
export function partLabel(name) {
  const n = name.toLowerCase();
  const rules = [
    [/header\d*\.xml$/, "the header"],
    [/footer\d*\.xml$/, "the footer"],
    [/footnotes\.xml$/, "footnotes"],
    [/endnotes\.xml$/, "endnotes"],
    [/comments[a-z]*\d*\.xml$|people\.xml$/, "comments"],
    [/notesslides\//, "speaker notes"],
    [/notesmaster|handoutmaster/, "notes or handout masters"],
    [/slidemasters\/|slidelayouts\//, "slide masters or layouts"],
    [/\/media\//, "pictures or media"],
    [/embeddings\/|activex\//, "embedded objects"],
    [/charts?\//, "charts"],
    [/diagrams\//, "diagrams"],
    [/drawings\//, "drawings"],
    [/theme\//, "the theme"],
    [/word\/styles\.xml$|styleswitheffects\.xml$/, "styles"],
    [/numbering\.xml$/, "lists"],
    [/settings\.xml$|presprops\.xml$|viewprops\.xml$|websettings\.xml$/, "document settings"],
    [/fonttable\.xml$|\/fonts\//, "fonts"],
    [/^docprops\//, "document properties (title, author and the like)"],
    [/^customxml\//, "custom data"],
    [/xl\/styles\.xml$/, "cell styles"],
    [/xl\/workbook\.xml$/, "workbook settings or defined names"],
    [/ppt\/presentation\.xml$/, "presentation settings"],
    [/tables\/|pivot|querytables|connections\.xml$|externallinks\//, "tables, pivot tables or data connections"],
    [/\.rels$|\[content_types\]\.xml$/, "the links between the file's parts"],
  ];
  for (const [re, words] of rules) if (re.test(n)) return words;
  return "another part of the file";
}

// ---- DOCX: word/document.xml ---------------------------------------------------------------------------------------------------

const OBJ = "￼"; // an inline object counts as one character, as in src/docx.js
const PPR_MODELED = new Set(["w:pStyle", "w:jc", "w:numPr"]); // compared on their own by the proof (style, align, list): `mod`

/** Interns canonical strings as small numbers, shared by the readings of one merge so the same look has the same number everywhere. */
export class Interner {
  constructor() {
    this.ids = new Map([["", 0]]);
    this.strs = [""];
    this.looseIds = new Map(); // id -> the id of its string without VOLATILE
  }
  id(s) {
    let n = this.ids.get(s);
    if (n === undefined) (this.ids.set(s, (n = this.ids.size)), this.strs.push(s));
    return n;
  }
  /** the string interned as `n` (-1: none, as a line break between paragraphs of a shape) */
  str(n) {
    return n < 0 ? null : this.strs[n];
  }
  /** the id of the string interned as `n` without VOLATILE */
  loose(n) {
    if (n < 0) return n;
    let v = this.looseIds.get(n);
    if (v === undefined) this.looseIds.set(n, (v = this.id(loose(this.strs[n]))));
    return v;
  }
  /** the id of VOLATILE alone in the string interned as `n` */
  vol(n) {
    return n < 0 ? 0 : this.id(volOf(this.strs[n]));
  }
}

/**
 * word/document.xml as units. Paragraphs are listed exactly as src/docx.js lists them (every w:p in w:body not inside another w:p,
 * in document order), each with: `text` (the reader's rules: w:t outside w:del, w:tab, a line break, an object as one character),
 * `look` (Int32Array: the canonical run properties of each character, interned), `box` (the table, row and cell it sits in, at every
 * depth; "" in the body), `own` (the w:p tag without its w14:paraId), `mod` (the canonical w:pStyle, w:jc and w:numPr of its own
 * properties, by name), and two residues: `fmt` (its paragraph properties other than style, alignment and list, the paragraph mark's
 * run properties included) and `obj` (every other element in it: pictures, fields, links, bookmarks, comment marks, footnote marks,
 * tracked changes, and a tab or line break counted as text that says more than "a tab" or "a line": a w:br that clears floating
 * pictures, say), each token with the character offset where it stands. A w:t that does not keep its spaces (no xml:space="preserve")
 * and whose text starts or ends with one is a VOLATILE token in `obj` (a reader may drop those spaces: the rule of VOLATILE above). The run boundaries themselves (w:r) do not count: two
 * runs with the same properties next to each other read the same as one. `skeleton` is the canonical document with each run of
 * listed paragraphs replaced by one mark: tables (rows, cells and their properties), sections and anything else outside paragraphs.
 */
export function docxUnits(xml, intern) {
  const paras = [];
  const skel = [];
  const stack = [];
  let inBody = false;
  let cur = null; // the listed paragraph open: {text, look, fmt, obj, box}
  let pDepth = 0;
  const revStack = [];
  let mcFallbackDepth = 0;
  const visible = () => !revStack.includes("del") && (revStack.length === 0 || revStack[revStack.length - 1] !== "moveFrom");
  let inT = false;
  const runs = []; // open w:r: {rpr: [] | null, id}
  let rprDepth = 0; // > 0 while inside a run's own w:rPr (collected into the run's look)
  let pprDepth = 0; // > 0 while inside the listed paragraph's own w:pPr
  let skipDepth = 0; // > 0 while inside a modeled w:pPr child (pStyle, jc, numPr), written into cur.mod
  let mod = null; // [name, tokens] of the modeled child open
  let tTrim = false; // the w:t open does not keep its spaces
  let tables = 0;
  const cells = []; // open tables: {t, row, col}
  const chars = []; // look ids of the open paragraph, one per character
  const quiet = []; // per element open inside the paragraph: true when it wrote no token (a run, a text element, a counted tab or break)
  const lookNow = () => (runs.length ? runs[runs.length - 1].id : 0);
  const add = (s) => {
    cur.text += s;
    for (let k = 0; k < s.length; k++) chars.push(lookNow());
  };
  const token = (into, s) => into.push(`${cur.text.length}|${s}`);
  const closeRpr = () => {
    runs[runs.length - 1].rpr.push("</>");
    if (--rprDepth === 0) {
      const r = runs[runs.length - 1];
      r.id = intern.id(r.rpr.join(""));
    }
  };
  const closePpr = () => {
    pprDepth--;
    if (skipDepth) {
      mod[1].push("</>");
      if (--skipDepth === 0) cur.mod[mod[0]] = mod[1].join("");
    } else token(cur.fmt, "</>");
  };
  walkCanonical(xml, {
    open(name, a, tag) {
      stack.push(name);
      if (name === "mc:Fallback" || mcFallbackDepth > 0) {
        if (name === "mc:Fallback") mcFallbackDepth++;
        if (!cur) skel.push(tag);
        else if (rprDepth) (rprDepth++, runs[runs.length - 1].rpr.push(tag));
        else if (pprDepth) {
          pprDepth++;
          if (skipDepth) skipDepth++, mod[1].push(tag);
          else token(cur.fmt, tag);
          quiet.push(false);
        } else (quiet.push(false), token(cur.obj, `${runs.length ? `r${lookNow()}` : ""}${tag}`));
        return;
      }
      if (name === "w:body") inBody = true;
      if (!cur) {
        if (name === "w:tbl") cells.push({ t: tables++, row: -1, col: -1 });
        else if (name === "w:tr" && cells.length) (cells[cells.length - 1].row++, (cells[cells.length - 1].col = -1));
        else if (name === "w:tc" && cells.length) cells[cells.length - 1].col++;
      }
      if (name === "w:p") pDepth++;
      if (name === "w:p" && inBody && pDepth === 1) {
        // `own`: the paragraph's own attributes (revision stamps, its text id) but its id, which is how the proof pairs paragraphs
        cur = { text: "", look: null, fmt: [], obj: [], mod: {}, own: tag.replace(/ \{[^}]*\}paraId="[^"]*"/, ""), box: cells.map((c) => `${c.t}.${c.row}.${c.col}`).join("/") };
        chars.length = 0;
        if (skel[skel.length - 1] !== "¶") skel.push("¶");
        return;
      }
      if (!cur) return void skel.push(tag);
      if (pDepth > 1) return void (quiet.push(false), token(cur.obj, `${runs.length ? `r${lookNow()}` : ""}${tag}`));
      // inside a listed paragraph
      if (rprDepth) {
        rprDepth++;
        runs[runs.length - 1].rpr.push(tag);
        return;
      }
      if (name === "w:rPr" && stack[stack.length - 2] === "w:r") {
        rprDepth = 1;
        runs[runs.length - 1].rpr = [tag];
        return;
      }
      if (name === "w:del") revStack.push("del");
      else if (name === "w:moveFrom") revStack.push("moveFrom");
      else if (name === "w:ins") revStack.push("ins");
      if (name === "w:r") {
        runs.push({ rpr: null, id: 0 });
        return void quiet.push(true);
      }
      // text, by the reader's rules (src/docx.js parseDocxParagraphs), wherever it stands in the paragraph
      let counted = false;
      if (name === "w:t" && visible()) (inT = true), (counted = true), (tTrim = !/ \u0001\{[^}]*\}space="preserve"/.test(tag));
      else if (name === "w:tab" && visible()) add("\t"), (counted = true);
      else if ((name === "w:br" || name === "w:cr") && visible() && a["w:type"] !== "page" && a["w:type"] !== "column") add("\n"), (counted = true);
      // a counted tab or break with attributes of its own (a w:br w:clear="all"): its tag, where it stands
      if (counted && name !== "w:t" && tag.includes(" ") && !pprDepth) token(cur.obj, `${runs.length ? `r${lookNow()}` : ""}${tag}</>`);
      else if ((name === "w:drawing" || name === "w:pict") && visible()) add(OBJ); // one character, and an object too
      if (pprDepth) {
        // the paragraph's own properties (a tab stop inside them is counted as text by the reader as well, and kept here as written)
        pprDepth++;
        if (skipDepth) skipDepth++, mod[1].push(tag);
        else if (pprDepth === 2 && PPR_MODELED.has(name)) (skipDepth = 1), (mod = [name, [tag]]);
        else token(cur.fmt, tag);
        return void quiet.push(false);
      }
      if (name === "w:pPr" && stack[stack.length - 2] === "w:p" && pDepth === 1) {
        pprDepth = 1;
        token(cur.fmt, tag);
        return void quiet.push(false);
      }
      quiet.push(counted);
      // any other element is an object of the paragraph, with the run properties it sits under
      if (!counted) token(cur.obj, `${runs.length ? `r${lookNow()}` : ""}${tag}`);
    },
    text(t) {
      if (!cur) return void skel.push(esc(t));
      if (rprDepth) return void runs[runs.length - 1].rpr.push(esc(t));
      if (pprDepth) return void (skipDepth ? mod[1].push(esc(t)) : token(cur.fmt, esc(t)));
      if (mcFallbackDepth > 0 || pDepth > 1) return void token(cur.obj, esc(t));
      if (inT) {
        if (tTrim && /^[ \t\r\n]|[ \t\r\n]$/.test(t)) token(cur.obj, `${VOL}unkept spaces`);
        return void add(t);
      }
      token(cur.obj, esc(t));
    },
    close(name) {
      stack.pop();
      if (mcFallbackDepth > 0) {
        if (name === "mc:Fallback") mcFallbackDepth--;
        if (!cur) return void skel.push("</>");
        if (rprDepth) return void closeRpr();
        const silent = quiet.pop();
        if (pprDepth) return void closePpr();
        if (!silent) token(cur.obj, "</>");
        return;
      }
      if (!cur && name === "w:tbl") cells.pop();
      if (name === "w:body") inBody = false;
      if (name === "w:p") pDepth--;
      if (cur && name === "w:p" && pDepth === 0) {
        cur.look = Int32Array.from(chars);
        paras.push(cur);
        cur = null;
        revStack.length = 0;
        return;
      }
      if (!cur) return void skel.push("</>");
      if ((pDepth >= 1 && name === "w:p") || pDepth > 1) {
        if (!quiet.pop()) token(cur.obj, "</>");
        return;
      }
      if (rprDepth) return void closeRpr();
      if (name === "w:del" || name === "w:moveFrom" || name === "w:ins") revStack.pop();
      if (name === "w:r" && runs.length) runs.pop();
      if (name === "w:t") inT = false;
      const silent = quiet.pop();
      if (pprDepth) return void closePpr();
      if (!silent) token(cur.obj, "</>");
    },
  });
  return { paras, skeleton: unitOf(skel.join("")) };
}

// ---- PPTX: one slide part ------------------------------------------------------------------------------------------------------

const SHAPE_TAGS = new Set(["sp", "pic", "graphicFrame", "grpSp", "cxnSp"]);
const localOf = (n) => n.slice(n.indexOf(":") + 1);

/**
 * One slide as units, listed as src/pptx.js lists shapes (each shape element, nested ones included, when it closes): `id`, `text`
 * (its paragraphs joined by a line break, a:br as one), `look` (each character's canonical a:rPr; a line break between paragraphs has
 * none), and the residues `fmt` (inside the text body: paragraph and body properties) and `obj` (outside it: position, size, geometry,
 * fill, line, name, placeholder, effects, a picture's image, a table, a chart...). A nested shape stands in its parent as one mark per
 * shape, with its id (a shape moved from one group into another is a change of both groups).
 * `skeleton`: the slide without its shapes (background, timing, transitions, color map), each run of shapes as one mark.
 */
export function slideUnits(xml, intern) {
  const shapes = [];
  const skel = [];
  const open = []; // open shapes
  let depth = 0;
  let para = null; // the a:p open (its shape is the innermost open one)
  let inT = false;
  let run = null; // the a:r open: {rpr: [] | null, id, depth}
  let rprDepth = 0;
  let body = 0; // depth of the open p:txBody (0: none)
  let mcFallbackDepth = 0;
  walkCanonical(xml, {
    open(name, a, tag) {
      depth++;
      if (name === "mc:Fallback" || mcFallbackDepth > 0) {
        if (name === "mc:Fallback") mcFallbackDepth++;
        const sh = open[open.length - 1];
        if (!sh) skel.push(tag);
        else if (rprDepth) (rprDepth++, run.rpr.push(tag));
        else (body ? sh.fmt : sh.obj).push(`${sh.text.length}|${run ? `r${run.id}` : ""}${tag}`);
        return;
      }
      const l = localOf(name);
      if (SHAPE_TAGS.has(l)) {
        const parent = open[open.length - 1];
        const sh = { id: null, text: "", chars: [], paras: 0, fmt: [], obj: [`0|${tag}`], depth, mark: null };
        if (parent) {
          // the mark is written once the child's id is known (its cNvPr comes after its own tag)
          const into = body ? parent.fmt : parent.obj;
          sh.mark = [into, into.length, `${parent.text.length}|▣`];
          into.push(sh.mark[2]);
        } else if (skel[skel.length - 1] !== "▣") skel.push("▣"); // top-level shapes are units of their own, listed in order
        open.push(sh);
        return;
      }
      const sh = open[open.length - 1];
      if (!sh) return void skel.push(tag);
      if (rprDepth) return void (rprDepth++, run.rpr.push(tag));
      if (l === "rPr" && run && depth === run.depth + 1) return void ((rprDepth = 1), (run.rpr = [tag]));
      if (l === "cNvPr" && sh.id === null) sh.id = a.id != null ? Number(a.id) : -1;
      if (l === "txBody") body = depth;
      if (l === "r") return void (run = { rpr: null, id: 0, depth });
      if (l === "p" && body) {
        if (sh.paras++ > 0) (sh.text += "\n"), sh.chars.push(-1);
        para = sh;
      }
      if (l === "t" && para) return void (inT = true);
      if (l === "br" && para) (sh.text += "\n"), sh.chars.push(run ? run.id : -1);
      (body ? sh.fmt : sh.obj).push(`${sh.text.length}|${run && l !== "br" ? `r${run.id}` : ""}${tag}`);
    },
    text(t) {
      const sh = open[open.length - 1];
      if (!sh) return void skel.push(esc(t));
      if (rprDepth) return void run.rpr.push(esc(t));
      if (mcFallbackDepth > 0) return void (body ? sh.fmt : sh.obj).push(`${sh.text.length}|${esc(t)}`);
      if (inT && para) {
        sh.text += t;
        for (let k = 0; k < t.length; k++) sh.chars.push(run ? run.id : 0);
        return;
      }
      (body ? sh.fmt : sh.obj).push(`${sh.text.length}|${esc(t)}`);
    },
    close(name) {
      const l = localOf(name);
      depth--;
      if (mcFallbackDepth > 0) {
        if (name === "mc:Fallback") mcFallbackDepth--;
        const sh = open[open.length - 1];
        if (!sh) return void skel.push("</>");
        if (rprDepth) {
          run.rpr.push("</>");
          if (--rprDepth === 0) run.id = intern.id(run.rpr.join(""));
          return;
        }
        (body ? sh.fmt : sh.obj).push(`${sh.text.length}|</>`);
        return;
      }
      const sh = open[open.length - 1];
      if (!sh) return void skel.push("</>");
      if (SHAPE_TAGS.has(l) && depth + 1 === sh.depth) {
        open.pop();
        if (sh.mark) sh.mark[0][sh.mark[1]] = `${sh.mark[2]}${sh.id ?? -1}`;
        shapes.push({ id: sh.id ?? -1, text: sh.text, look: Int32Array.from(sh.chars), fmt: sh.fmt, obj: sh.obj });
        return;
      }
      if (rprDepth) {
        run.rpr.push("</>");
        if (--rprDepth === 0) run.id = intern.id(run.rpr.join(""));
        return;
      }
      if (l === "r" && run && depth + 1 === run.depth) return void (run = null);
      if (l === "t" && inT) return void (inT = false);
      if (l === "p" && para === sh && body) para = null;
      (body ? sh.fmt : sh.obj).push(`${sh.text.length}|</>`);
      if (l === "txBody" && depth + 1 === body) body = 0;
    },
  });
  return { shapes, skeleton: unitOf(skel.join("")) };
}

// ---- XLSX: styles, shared strings, one sheet ------------------------------------------------------------------------------------

/**
 * xl/styles.xml as the definitions the places that use them resolve to: `xf(s)`, a cell, row or column style index -> the canonical
 * form of everything that style sets (the cellXfs entry with its font, fill, border, number format and cell style entry written out in
 * place of their ids); `font(i)`, a font (a shared string's phonetic text names one); and `lists`, each definition list as written
 * (numFmts by id, the others by index), for the check of a definition changed in place (src/merge-proof.js restXlsx: the engine only
 * appends to these lists, measured on the committed samples for bold, italic, fill and a number format, so a definition the person
 * changed in place is one the merge never carries, whatever references it).
 */
export function cellStyles(xml) {
  const lists = { numFmts: new Map(), fonts: [], fills: [], borders: [], cellStyleXfs: [], cellXfs: [] };
  if (xml != null) {
    let depth = 0;
    let list = null;
    let cur = null;
    let fmtId = null;
    walkCanonical(xml, {
      open(name, a, tag) {
        depth++;
        const l = localOf(name);
        if (depth === 2) list = l in lists ? l : null;
        else if (depth === 3 && list) {
          cur = [];
          fmtId = list === "numFmts" ? a.numFmtId : null;
        }
        if (depth >= 3 && cur) cur.push(tag);
      },
      text(t) {
        if (depth >= 3 && cur) cur.push(esc(t));
      },
      close() {
        if (depth >= 3 && cur) cur.push("</>");
        if (depth === 3 && cur) {
          if (list === "numFmts") lists.numFmts.set(String(fmtId), cur.join(""));
          else lists[list].push(cur.join(""));
          cur = null;
        }
        depth--;
      },
    });
  }
  const memo = new Map();
  const ref = /(fontId|fillId|borderId|numFmtId|xfId)="([^"]*)"/g;
  const out = (from, i) =>
    (from[i] ?? "").replace(ref, (_m, k, v) => {
      if (k === "fontId") return `font=${lists.fonts[Number(v)] ?? `#${v}`}`;
      if (k === "fillId") return `fill=${lists.fills[Number(v)] ?? `#${v}`}`;
      if (k === "borderId") return `border=${lists.borders[Number(v)] ?? `#${v}`}`;
      if (k === "numFmtId") return `numFmt=${lists.numFmts.get(v) ?? `builtin ${v}`}`;
      return `xf=${from === lists.cellXfs ? out(lists.cellStyleXfs, Number(v)) : v}`;
    });
  const xf = (s) => {
    let v = memo.get(s);
    if (v === undefined) memo.set(s, (v = out(lists.cellXfs, s)));
    return v;
  };
  return { xf, font: (i) => lists.fonts[Number(i)] ?? `#${i}`, lists };
}

/**
 * xl/sharedStrings.xml: index -> the canonical rich text of the string beyond the text the value check reads (src/xlsx.js: the text of
 * the string's t elements outside phonetic runs): its runs' properties, where each run's text ends, and its phonetic runs and
 * properties as written, their text included (an outside review: the reading of a name changed from hiragana to katakana was a length
 * here, and the merge kept the old one). `font(i)`: a phonetic properties' font, written out in place of its id (cellStyles).
 */
export function sharedRich(xml, font = (i) => `#${i}`) {
  const out = [];
  if (xml == null) return out;
  let depth = 0;
  let cur = null;
  let inT = 0; // depth of the modeled t element open
  let phon = 0; // > 0 inside a phonetic run
  walkCanonical(xml, {
    open(name, a, tag) {
      depth++;
      const l = localOf(name);
      if (depth === 2) cur = [];
      else if (cur) {
        if (l === "rPh") phon++;
        if (l === "t" && !inT && !phon) inT = depth;
        else cur.push(l === "phoneticPr" && a.fontId != null ? tag.replace(/ fontId="[^"]*"/, ` font=${font(a.fontId)}`) : tag);
      }
    },
    text(t) {
      if (cur && !inT) cur.push(esc(t));
      else if (cur) cur.push(`#${t.length}`); // where a run's text ends, not the text itself (the value check's)
    },
    close(name) {
      if (depth === inT) inT = 0;
      else if (depth > 2 && cur) {
        cur.push("</>");
        if (localOf(name) === "rPh") phon--;
      }
      if (depth === 2 && cur) (out.push(cur.join("")), (cur = null));
      depth--;
    },
  });
  return out;
}

const parseRef = (r) => {
  const m = /^([A-Z]{1,3})(\d+)$/.exec(r || "");
  return m ? (Number(m[2]) - 1) * 16384 + [...m[1]].reduce((x, ch) => x * 26 + ch.charCodeAt(0) - 64, 0) - 1 : null;
};

/**
 * One worksheet as units: `cells` Map key (row * 16384 + col, as src/xlsx.js keys them) -> the canonical residue of the cell: its
 * resolved style (cellStyles, by key), a rich text's run properties (by key), a formula's attributes, any other attribute or child. Not in it, as
 * modeled elsewhere: the value or formula text (the proof's value check), the storage of a text (shared or inline: `t`), and the
 * cached result of a formula (`v` beside an `f`: recomputed by every spreadsheet program when it opens the file, never typed).
 * A cell absent is the same as one with nothing but the style it shows (`at`): its row's (when the row says customFormat), else its
 * column's, else style 0. `rows` Map row -> its attributes other than r, its style resolved. `skeleton`: the sheet without its cells and
 * rows (columns, their styles resolved, merged ranges, views, panes, conditional formats, page setup...). A cell written twice at one
 * address keeps both (a reader takes one or the other: both count).
 */
const S_ATTR = / s="[^"]*"/;
const STYLE_ATTR = / style="[^"]*"/;
export function sheetUnits(xml, style, rich) {
  // `style(s)` and `rich(i)`: short keys of a style index and a shared string (interned by the caller, so a million cells hold small
  // strings, and the same style or rich text has the same key in every version)
  const cells = new Map();
  const rows = new Map();
  const skel = [];
  let depth = 0;
  let inData = 0;
  let row = null; // the open row's number, or null when its cells go to the skeleton (a row without r)
  let cur = null; // the open cell: {key, s, t, parts, v, f, path}
  const rowStyle = new Map(); // row -> style index its absent cells show
  const colStyle = []; // [first, last, style index] (0-based columns)
  const styled = (t, attr, v) => t.replace(attr === "s" ? S_ATTR : STYLE_ATTR, ` ${attr}=#${style(Number(v) || 0)}`);
  walkCanonical(xml, {
    open(name, a, tag) {
      depth++;
      const l = localOf(name);
      if (!inData) {
        if (l === "sheetData") inData = depth;
        if (l === "col" && a.style != null) {
          colStyle.push([Number(a.min) - 1, Number(a.max) - 1, Number(a.style) || 0]);
          return void skel.push(styled(tag(), "style", a.style));
        }
        return void skel.push(tag());
      }
      if (depth === inData + 1 && l === "row" && a.r != null) {
        row = Number(a.r);
        let own = tag().replace(/ r="[^"]*"/, "");
        if (a.s != null) own = styled(own, "s", a.s);
        if ((a.customFormat === "1" || a.customFormat === "true") && a.s != null) rowStyle.set(row, Number(a.s) || 0);
        if (!/^<(\{[^}]*\})?row>$/.test(own)) rows.set(row, own);
        return;
      }
      const key = depth === inData + 2 && l === "c" && row !== null ? parseRef(a.r) : null;
      if (key !== null) {
        let more = false; // attributes other than r, s and t
        for (const k in a) if (k !== "r" && k !== "s" && k !== "t") more = true;
        cur = { key, s: Number(a.s) || 0, t: a.t || "n", parts: more ? [tag().replace(/ (r|s|t)="[^"]*"/g, "")] : [], v: null, f: false, path: [] };
        return;
      }
      if (!cur) return void skel.push(tag());
      cur.path.push(l);
      if (cur.path.length === 1 && l === "v") return void (cur.v = "");
      if (cur.path.length === 1 && l === "f") cur.f = true;
      // an inline string's text is the value check's: where each run's text ends is kept, not the text
      cur.parts.push(l === "t" && cur.path[0] === "is" && !cur.path.includes("rPh") ? "<t>" : tag());
    },
    text(t) {
      if (!cur) return void skel.push(esc(t));
      const l = cur.path[cur.path.length - 1];
      if (cur.path.length === 1 && l === "v") return void (cur.t === "s" && (cur.v += t));
      if (cur.path.length === 1 && l === "f") return; // the formula text: the value check's
      cur.parts.push(l === "t" && cur.path[0] === "is" && !cur.path.includes("rPh") ? `#${t.length}` : esc(t));
    },
    close(name) {
      const l = localOf(name);
      const at = depth--;
      if (!inData) return void skel.push("</>");
      if (at === inData) return void ((inData = 0), skel.push("</>"));
      if (cur && at === inData + 2) {
        const shared = cur.t === "s" && !cur.f && cur.v !== null ? rich(Number(cur.v)) : "";
        const v = !shared && !cur.parts.length ? style(cur.s) : `${style(cur.s)}|${shared}|${cur.parts.join("")}`;
        cells.set(cur.key, cells.has(cur.key) ? `${cells.get(cur.key)}\u0003${v}` : v);
        cur = null;
        return;
      }
      if (cur) {
        const top = cur.path.pop();
        if (!(cur.path.length === 0 && top === "v")) cur.parts.push("</>");
        return;
      }
      if (at === inData + 1 && l === "row" && row !== null) return void (row = null);
      skel.push("</>");
    },
  }, null, { lazyTags: true });
  const skeleton = skel.join("");
  /** the style a cell absent at `key` shows (row * 16384 + col) */
  const shown = (key) => {
    const r = rowStyle.get(Math.floor(key / 16384) + 1);
    if (r !== undefined) return style(r);
    const c = key % 16384;
    let v = byCol.get(c); // one scan of the columns per column (at most 16,384), not per cell
    if (v === undefined) {
      v = style(0);
      for (const [lo, hi, st] of colStyle) if (c >= lo && c <= hi) v = style(st);
      byCol.set(c, v);
    }
    return v;
  };
  const byCol = new Map();
  const plain = !rowStyle.size && !colStyle.length ? style(0) : null;
  return { cells, rows, skeleton: unitOf(skeleton), at: (key) => cells.get(key) ?? plain ?? shown(key) };
}

// ---- comparing residues ----------------------------------------------------------------------------------------------------------

/** The length of the common start `p` and end `s` of two strings (not overlapping). Linear. */
export function ends(a, b) {
  let p = 0;
  const max = Math.min(a.length, b.length);
  while (p < max && a[p] === b[p]) p++;
  let s = 0;
  while (s < max - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  return { p, s };
}

/**
 * Are two residues (lists of "offset|token" read from units with texts `x` and `y`) the same once the text change between them is
 * taken into account? The tokens must be equal in order, and each must stand in the same place relative to the text: in the common
 * start at the same offset, in the common end at the same distance from the end, or in the changed middle on both sides. The common
 * start and the common end are each taken whole (they may overlap where the change is ambiguous: "Fiktiv A" -> "Fiktiv typed A" is
 * " typed" typed after "Fiktiv" or "typed " typed before "A", and a mark right after "Fiktiv" may follow either). Linear.
 */
export function sameResidue(X, x, Y, y) {
  if (X.length !== Y.length) return false;
  if (!X.length) return true;
  const { p, s } = ends(x, y);
  let s2 = 0; // the whole common end, not cut by the common start
  const max = Math.min(x.length, y.length);
  while (s2 < max && x[x.length - 1 - s2] === y[y.length - 1 - s2]) s2++;
  const d = y.length - x.length;
  for (let k = 0; k < X.length; k++) {
    const i = X[k].indexOf("|");
    const j = Y[k].indexOf("|");
    if (X[k].slice(i) !== Y[k].slice(j)) return false;
    const ax = Number(X[k].slice(0, i));
    const ay = Number(Y[k].slice(0, j));
    if (ax <= p && ay === ax) continue;
    if (ax >= x.length - s2 && ay === ax + d) continue;
    if (ax >= p && ax <= x.length - s && ay >= p && ay <= y.length - s) continue;
    return false;
  }
  return true;
}

// VOLATILE in a residue (lists of "offset|token"): tokens that hold a marked attribute, and the marks that stand alone ("|\u0001...")
const looseResidue = (X) =>
  X.some((t) => t.includes(VOL))
    ? X.flatMap((t) => {
        const i = t.indexOf("|");
        const v = t.slice(i + 1);
        return v.startsWith(VOL) ? [] : [`${t.slice(0, i + 1)}${loose(v)}`];
      })
    : X;
const volResidue = (X) => (X.some((t) => t.includes(VOL)) ? X.filter((t) => t.includes(VOL)).map((t) => ((v) => (v.startsWith(VOL) ? v : volOf(v)))(t.slice(t.indexOf("|") + 1))).join("") : "");
/** The rule (sameVolatile) on residues: is mine's residue `M` (text `m`) in the result's `R` (text `r`), `B` (text `b`) the base's? */
export const residueCarried = (B, M, m, R, r) => sameResidue(M, m, R, r) || (volResidue(B) === volResidue(M) && sameResidue(looseResidue(M), m, looseResidue(R), r));
/** looseSame on residues: the agent's `T` and the result's `R`, equal but for VOLATILE */
export const residueLooseSame = (T, t, R, r) => sameResidue(T, t, R, r) || sameResidue(looseResidue(T), t, looseResidue(R), r);

/** Per-character looks (Int32Array) of two units with texts `x` and `y`: the same on the characters both keep (common start and end)? */
export function sameLookKept(lx, x, ly, y) {
  const { p, s } = ends(x, y);
  for (let k = 0; k < p; k++) if (lx[k] !== ly[k]) return false;
  for (let k = 1; k <= s; k++) if (lx[lx.length - k] !== ly[ly.length - k]) return false;
  return true;
}

/**
 * The rule (sameVolatile) on per-character looks: is mine's look `Y` in the result's `Z` on the characters both keep, `X` the base's?
 * A character of mine is in the result with the same run properties; or the same but for VOLATILE where the person left that
 * character's VOLATILE as base had it. A character the person typed takes the run properties of the text it was typed into: its
 * VOLATILE is left as base had it when it is that of the base character just before or just after the typing (else only the same
 * counts). `I`: the Interner the looks were read with.
 */
export function lookCarried(I, X, Y, Z) {
  const { p, s } = ends(Y.text, Z.text);
  const { p: pb, s: sb } = X ? ends(X.text, Y.text) : { p: 0, s: 0 };
  const n = Y.text.length;
  const at = (k) => (k < pb ? k : k >= n - sb ? X.text.length - (n - k) : -1); // mine's character k in base, or -1: typed
  const ok = (k, kz) => {
    const y = Y.look[k];
    const z = Z.look[kz];
    if (y === z) return true;
    if (I.loose(y) !== I.loose(z)) return false;
    if (!X) return false;
    const kb = at(k);
    if (kb >= 0) return I.vol(X.look[kb]) === I.vol(y);
    const v = I.vol(y); // typed: the base characters around the typing
    return (pb > 0 && I.vol(X.look[pb - 1]) === v) || (pb < X.text.length && I.vol(X.look[pb]) === v);
  };
  for (let k = 0; k < p; k++) if (!ok(k, k)) return false;
  for (let k = 1; k <= s; k++) if (!ok(n - k, Z.text.length - k)) return false;
  return true;
}
/** looseSame on per-character looks: the agent's `Y` and the result's `Z`, on the characters both keep, equal but for VOLATILE */
export function lookLooseSame(I, Y, Z) {
  const { p, s } = ends(Y.text, Z.text);
  for (let k = 0; k < p; k++) if (I.loose(Y.look[k]) !== I.loose(Z.look[k])) return false;
  for (let k = 1; k <= s; k++) if (I.loose(Y.look[Y.look.length - k]) !== I.loose(Z.look[Z.look.length - k])) return false;
  return true;
}

// ---- the engine's paired run properties (DOCX) ------------------------------------------------------------------------------------
// The engine writes a run property with its complex-script or East Asian twin (vendor/engine-node/engine-node.mjs applyRunSet, the
// writer of the page and of the merge alike): bold as w:b and w:bCs, italic as w:i and w:iCs, a size as w:sz and w:szCs (the same
// value), a font as w:rFonts with ascii, hAnsi, eastAsia and cs. A person's version written by another program may carry the first
// alone (an outside review: "typo" made bold with w:b only; the merge carried it as w:b w:bCs and the proof refused an ordinary merge).
// The twin acts only on characters of its own script: w:bCs, w:iCs and w:szCs (and rFonts' cs) on complex-script text (Hebrew,
// Arabic, Thai, the Indic scripts...), rFonts' eastAsia on East Asian text, and on a run that says w:rtl or w:cs or hints eastAsia.
// So the two read the same, character by character, when: mine's run has the first property and not the twin, the result's run is
// mine's with the twin added at the first's value (and nothing else), the run says none of w:rtl, w:cs or an eastAsia hint, and the
// character is below U+0590 (Latin, Greek, Cyrillic, Armenian, the punctuation and symbols of those blocks: no complex-script or East
// Asian character is). Anything else is not the same.
const W_URI = `{${WML}}`;
const TWINS = { b: "bCs", i: "iCs", sz: "szCs" };
/** the children of a canonical w:rPr, as {local: attributes} (null when it is not a flat list of empty elements) */
function rprKids(str) {
  if (str === "") return {};
  const head = `<${W_URI}rPr>`;
  if (!str.startsWith(head) || !str.endsWith("</>")) return null;
  const body = str.slice(head.length, -3);
  const out = {};
  const re = /<\{[^}]*\}([A-Za-z]+)([^>]*)><\/>/gy;
  let m;
  let at = 0;
  while ((m = re.exec(body))) {
    if (m[0].indexOf(W_URI) !== 1 || m[1] in out) return null;
    out[m[1]] = m[2];
    at = re.lastIndex;
  }
  return at === body.length ? out : null;
}
/** Does the run property `got` (an interned id of the result) read as `want` (mine's) on the character `ch`? See above. */
export function twinSame(I, want, got, ch) {
  if (want === got) return true;
  if (want < 0 || got < 0 || ch.codePointAt(0) >= 0x0590) return false;
  const w = rprKids(I.str(want));
  const g = rprKids(I.str(got));
  if (!w || !g || "rtl" in w || "cs" in w) return false;
  if (/hint="eastAsia"/.test(w.rFonts ?? "") || /hint="eastAsia"/.test(g.rFonts ?? "")) return false;
  for (const k in w) if (!(k in g)) return false;
  for (const k in g) {
    if (k in w && k !== "rFonts") {
      if (g[k] !== w[k]) return false;
      continue;
    }
    const first = Object.keys(TWINS).find((f) => TWINS[f] === k);
    if (first) {
      if (!(first in w) || k in w || g[k] !== w[first]) return false;
      continue;
    }
    if (k !== "rFonts") return false;
    // w:rFonts: mine's attributes, and eastAsia and cs added at the value of ascii
    const attrs = (x) => Object.fromEntries([...x.matchAll(/ \{[^}]*\}([A-Za-z]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
    const [wa, ga] = [attrs(w.rFonts ?? ""), attrs(g.rFonts)];
    if (!("rFonts" in w)) return false;
    for (const a in wa) if (ga[a] !== wa[a]) return false;
    for (const a in ga) if (!(a in wa) && !((a === "eastAsia" || a === "cs") && ga[a] === wa.ascii)) return false;
  }
  return true;
}

// ---- DOCX: numbering --------------------------------------------------------------------------------------------------------------

/**
 * word/numbering.xml as what a paragraph's w:numId resolves to: numId -> the canonical w:num without its own id, with the abstract
 * definition it names written out in place of the abstractNumId (without its id, its w:nsid and its w:tmpl: the numbers that tie a
 * definition to its copies in other files and to a template; they change nothing on the page and stay compared where they are
 * written, in numbering.xml). "0" -> "off" (numId 0 takes a style's list off).
 */
const attrLocal = (a, l) => {
  for (const k in a) if (k === l || k.endsWith(`:${l}`)) return a[k];
  return undefined;
};
export function numberingOf(xml) {
  const abs = new Map();
  const nums = new Map();
  if (xml != null) {
    let depth = 0;
    let cur = null;
    let what = null;
    let id = null;
    let skip = 0;
    walkCanonical(xml, {
      open(name, a, tag) {
        depth++;
        if (depth === 2) {
          const l = localOf(name);
          what = l === "abstractNum" ? abs : l === "num" ? nums : null;
          id = attrLocal(a, l === "abstractNum" ? "abstractNumId" : "numId");
          cur = what ? [tag.replace(/ \{[^}]*\}(abstractNumId|numId)="[^"]*"/, "")] : null;
          return;
        }
        if (!cur) return;
        if (skip || (depth === 3 && what === abs && (localOf(name) === "nsid" || localOf(name) === "tmpl"))) return void skip++;
        if (depth === 3 && what === nums && localOf(name) === "abstractNumId") return void (skip++, cur.push(`<abs ${attrLocal(a, "val")}>`));
        cur.push(tag);
      },
      text(t) {
        if (cur && !skip) cur.push(esc(t));
      },
      close() {
        if (skip) skip--;
        else if (cur && depth >= 2) cur.push("</>");
        if (depth === 2 && cur) (what.set(String(id), cur.join("")), (cur = null));
        depth--;
      },
    });
  }
  const memo = new Map([["0", "off"]]);
  return (numId) => {
    const k = String(numId);
    let v = memo.get(k);
    if (v === undefined) memo.set(k, (v = nums.has(k) ? nums.get(k).replace(/<abs ([^>]*)>/, (_m, a) => abs.get(a) ?? `#missing abstract ${a}`) : `#missing ${k}`));
    return v;
  };
}
