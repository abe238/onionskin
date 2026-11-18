import crypto from "node:crypto";

// What is active in an HTML file (PLAN-html R1): the one table the render copy (src/html-render.js, later), the agent's ops and the check
// on every write use. It is an allowlist, not a list of attacks: an element or attribute is allowed only when it is named here, a URL only
// when its kind is named for its attribute, CSS only in the plain form below. Everything else is "active", whatever it is: present and
// unchanged it is left alone (the file had it), added or changed by a write it refuses the whole write (inventoryDelta).
// Pure: no parser here. The functions read a parse5 tree by its shape (nodeName, tagName, namespaceURI, attrs, childNodes, the content of
// a template, the value of a text node), so the same table serves every module that holds a tree.

export const HTML_NS = "http://www.w3.org/1999/xhtml";

/** The fixed sentence for a refused write (R1). */
export const ACTIVE_REFUSED = "The agent tried to add code that runs in a browser, so nothing was written.";

// Elements a write may add or change: document structure, text and its formatting, lists, tables, images, links, and the legacy
// formatting Office and email exports use (`font`, `center`, Word's `o:p`). Not here, so refused when added: script, noscript, template,
// style sheets by link, frames, objects, forms and their controls, media, canvas, SVG and MathML (another namespace), base, and every
// element this table does not name. `style` and `meta` are here with their own rules (CSS below; meta: no http-equiv).
const ELEMENTS = new Set(
  [
    "html", "head", "body", "title", "meta", "style",
    "address", "article", "aside", "footer", "header", "h1", "h2", "h3", "h4", "h5", "h6", "hgroup", "main", "nav", "section", "search",
    "blockquote", "dd", "div", "dl", "dt", "figcaption", "figure", "hr", "li", "menu", "ol", "p", "pre", "ul",
    "a", "abbr", "b", "bdi", "bdo", "br", "cite", "code", "data", "dfn", "em", "i", "kbd", "mark", "q", "rp", "rt", "ruby", "s", "samp",
    "small", "span", "strong", "sub", "sup", "time", "u", "var", "wbr", "del", "ins",
    "img", "picture",
    "caption", "col", "colgroup", "table", "tbody", "td", "tfoot", "th", "thead", "tr",
    "details", "summary",
    "center", "font", "big", "tt", "strike", "nobr", "o:p",
  ],
);

// Attributes allowed on every allowed element.
const GLOBAL_ATTRS = new Set(["class", "id", "title", "lang", "dir", "style", "hidden", "translate", "align", "valign", "width", "height", "bgcolor", "nowrap", "border"]);
// Attributes allowed on one element only (URL-bearing ones are listed in URL_ATTRS too).
const ELEMENT_ATTRS = {
  a: ["href"],
  img: ["src", "alt"],
  td: ["colspan", "rowspan", "headers", "scope", "abbr"],
  th: ["colspan", "rowspan", "headers", "scope", "abbr"],
  col: ["span"],
  colgroup: ["span"],
  table: ["cellpadding", "cellspacing", "summary"],
  ol: ["start", "reversed"],
  li: ["value"],
  time: ["datetime"],
  del: ["datetime"],
  ins: ["datetime"],
  data: ["value"],
  meta: ["charset", "name", "content"],
  font: ["color", "face", "size"],
  br: ["clear"],
  details: ["open"],
  html: ["xmlns"],
};
const PER_ELEMENT = new Map(Object.entries(ELEMENT_ATTRS).map(([k, v]) => [k, new Set(v)]));

/** The URL-bearing allowed attributes: "link" (followed when clicked) or "load" (fetched when shown), and the kinds each allows. */
const URL_ATTRS = { "a href": "link", "img src": "load" };
export const URL_KINDS = {
  link: new Set(["fragment", "relative", "http", "https", "mailto", "tel"]),
  load: new Set(["relative", "data-image"]),
};

/** Template delimiters (R1): refused in added text or attribute values when the file loads any script. */
const TEMPLATE = /\{\{|\{%|<%|\$\{/;

/** Is an element of this name and namespace on the allowlist? Only HTML-namespace elements are. */
export function elementAllowed(name, namespace = HTML_NS) {
  return namespace === HTML_NS && ELEMENTS.has(String(name));
}

/** Is attribute `name` allowed on allowed element `element`? Names compare as the parser reports them (lowercase). */
export function attributeAllowed(element, name) {
  name = String(name);
  return GLOBAL_ATTRS.has(name) || PER_ELEMENT.get(String(element))?.has(name) === true;
}

// a raster image as a data: URL (no SVG in v1, R5): the media type, optional parameters, then the comma
const DATA_IMAGE = /^data:image\/(?:png|jpeg|jpg|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)(?:;[a-z0-9=._+-]*)*,/i;
const SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;
/**
 * The kind of a URL as an attribute value holds it (character references already decoded by the parser): "fragment" ("" or "#..."),
 * "relative" (a path with no scheme and no host), "data-image", "http", "https", "mailto", "tel", or "other". A value is "other" when a
 * browser could read it as something else than it looks: any control character (browsers drop tabs and newlines anywhere in a URL), a
 * backslash (read as a slash), a leading "//" (another host), or a scheme not named here.
 */
export function urlKind(value) {
  // trimmed of HTML whitespace by index: a regex for the trailing run tried every start inside a run (quadratic in its length)
  const raw = String(value ?? "");
  const htmlSpace = (c) => c === 32 || c === 9 || c === 10 || c === 12 || c === 13;
  let a = 0;
  let b = raw.length;
  while (a < b && htmlSpace(raw.charCodeAt(a))) a++;
  while (b > a && htmlSpace(raw.charCodeAt(b - 1))) b--;
  const v = raw.slice(a, b);
  if (/[\u0000-\u001f\u007f\\]/.test(v)) return "other";
  if (v === "" || v.startsWith("#")) return "fragment";
  if (v.startsWith("//")) return "other";
  const m = SCHEME.exec(v);
  if (!m) return "relative";
  const s = m[1].toLowerCase();
  if (s === "http" || s === "https" || s === "mailto" || s === "tel") return s;
  if (s === "data") return DATA_IMAGE.test(v) ? "data-image" : "other";
  return "other";
}

/**
 * The CSS rule (R1): CSS in a style attribute or a style element is plain when it has no backslash (escapes could spell any name), no
 * @import, no image-set() or src() (they load without url()), no expression(), behavior or -moz-binding, and every url() is relative or a
 * data: image. Returns {ok, loads: [url]}.
 */
export function cssPlain(css) {
  const s = String(css ?? "");
  const loads = [];
  if (/\\|@import|image-set\s*\(|\bsrc\s*\(|expression\s*\(|behavior\s*:|-moz-binding/i.test(s)) return { ok: false, loads };
  // url( ... ) read by index, as the regex /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s]*))\s*\)/gi read it (that regex backtracked over every
  // split of a whitespace run between its two \s*: quadratic in the run). What is left must hold no url( this cannot read: not plain.
  // JavaScript's \s, as the regex read it: ASCII by code, anything else by the regex (rare, so cheap)
  const space = (c) => {
    const k = c.charCodeAt(0);
    return k < 128 ? k === 32 || (k >= 9 && k <= 13) : /\s/.test(c);
  };
  const isUrl = (i) => (s.charCodeAt(i) | 32) === 117 && (s.charCodeAt(i + 1) | 32) === 114 && (s.charCodeAt(i + 2) | 32) === 108; // u r l, any case
  // where each position's next stop is (an unquoted value ends at ), a quote or whitespace; a quoted one at its quote), found once
  // backwards, so a run of unclosed url( is not scanned again from each one
  let stop = null;
  const stops = () => {
    if (stop) return stop;
    const n = s.length;
    stop = { any: new Int32Array(n + 1), dq: new Int32Array(n + 1), sq: new Int32Array(n + 1) };
    stop.any[n] = stop.dq[n] = stop.sq[n] = n;
    for (let i = n - 1; i >= 0; i--) {
      const c = s[i];
      stop.any[i] = c === ")" || c === '"' || c === "'" || space(c) ? i : stop.any[i + 1];
      stop.dq[i] = c === '"' ? i : stop.dq[i + 1];
      stop.sq[i] = c === "'" ? i : stop.sq[i + 1];
    }
    return stop;
  };
  let rest = "";
  let from = 0;
  for (let i = 0; i + 3 < s.length; ) {
    if (!(isUrl(i) && s[i + 3] === "(")) {
      i++;
      continue;
    }
    let j = i + 4;
    while (j < s.length && space(s[j])) j++;
    let val = null;
    let k = j;
    if (s[j] === '"' || s[j] === "'") {
      const close = j + 1 <= s.length ? (s[j] === '"' ? stops().dq : stops().sq)[j + 1] : s.length;
      if (close < s.length) [val, k] = [s.slice(j + 1, close), close + 1];
    } else {
      k = stops().any[j];
      val = s.slice(j, k);
    }
    let m = k;
    while (val !== null && m < s.length && space(s[m])) m++;
    if (val === null || s[m] !== ")") {
      i++;
      continue;
    }
    loads.push(val);
    rest += s.slice(from, i);
    from = i = m + 1;
  }
  rest += s.slice(from);
  for (let i = 0; i + 3 < rest.length; i++) {
    if (!((rest.charCodeAt(i) | 32) === 117 && (rest.charCodeAt(i + 1) | 32) === 114 && (rest.charCodeAt(i + 2) | 32) === 108)) continue;
    let j = i + 3;
    while (j < rest.length && space(rest[j])) j++;
    if (rest[j] === "(") return { ok: false, loads }; // a url( this cannot read: not plain
  }
  return { ok: loads.every((u) => URL_KINDS.load.has(urlKind(u))), loads };
}

// ---- the display set (the render copy, src/html-render.js) --------------------------------------------------------------------------
// A second set, for SHOWING a page, not for writing one. Why it differs: the render copy is shown in a frame that runs no script, sends
// nothing and navigates nowhere, so it may show controls a write may never add (a page with a sign-up form should look like itself; the
// controls are shown disabled and never inside a `form`), and it shows less than a write may keep: no `meta` (the copy's one meta is the
// CSP the server adds first), no link target (the renderer keeps it as `data-osk-href` for display only) and no `src` (the renderer inlines
// a local or `data:` image itself, or shows a placeholder). The renderer, not this table, handles `href`, `src` and `style`.
const DISPLAY_EXTRA = ["input", "button", "select", "option", "optgroup", "textarea", "label", "fieldset", "legend", "output", "meter", "progress"];
const DISPLAY_ELEMENTS = new Set([...ELEMENTS, ...DISPLAY_EXTRA].filter((t) => t !== "meta"));
const DISPLAY_ATTRS = {
  input: ["type", "value", "placeholder", "checked", "size", "readonly", "multiple", "min", "max", "step"],
  button: ["value"],
  select: ["multiple", "size"],
  option: ["value", "selected", "label"],
  optgroup: ["label"],
  textarea: ["rows", "cols", "placeholder", "readonly", "wrap"],
  meter: ["value", "min", "max", "low", "high", "optimum"],
  progress: ["value", "max"],
  style: ["media"],
};
const DISPLAY_PER_ELEMENT = new Map(Object.entries(DISPLAY_ATTRS).map(([k, v]) => [k, new Set(v)]));
/** The `type` values an input keeps in the render copy; any other (`image` loads its `src`) is not kept. */
export const DISPLAY_INPUT_TYPES = new Set(["text", "search", "email", "url", "tel", "number", "password", "date", "time", "datetime-local", "month", "week", "color", "range", "checkbox", "radio", "submit", "reset", "button", "file", "hidden"]);
/** Form controls: the render copy shows each one `disabled`. */
export const DISPLAY_CONTROLS = new Set(["input", "button", "select", "textarea", "fieldset"]);

/** May the render copy show an element of this name and namespace? HTML namespace only, as for writes. */
export function displayElementAllowed(name, namespace = HTML_NS) {
  return namespace === HTML_NS && DISPLAY_ELEMENTS.has(String(name));
}

/** May the render copy keep attribute `name` on element `element`? Never `href`, `src`, `style` or `name` (the renderer's own rules). */
export function displayAttributeAllowed(element, name) {
  name = String(name);
  if (name === "href" || name === "src" || name === "style" || name === "name" || element === "meta") return false;
  return attributeAllowed(element, name) || DISPLAY_PER_ELEMENT.get(String(element))?.has(name) === true;
}

// ---- the inventory --------------------------------------------------------------------------------------------------------------

const kidsOf = (n) => (n.nodeName === "template" && n.content ? n.content.childNodes : n.childNodes || []);
const KEEP = 2048; // a value longer than this is kept by its hash (an inventory never holds a whole script or a megabyte attribute)
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex").slice(0, 32);
const keep = (s) => (s.length <= KEEP ? s : `#${sha(s)}`);
// an entry's key: its fields as a JSON array (one string per entry, never split: a field may hold any character)
const keyOf = (...fields) => JSON.stringify(fields);
const FRAMES = new Set(["iframe", "frame", "frameset", "object", "embed", "applet", "portal", "fencedframe"]);
const FORMS = new Set(["form", "input", "button", "select", "textarea", "option", "optgroup", "datalist", "fieldset", "legend", "label", "output", "isindex", "keygen"]);
const RAW = new Set(["script", "style", "xmp", "iframe", "noembed", "noframes", "plaintext", "noscript"]);

/** The reason code of a disallowed element. */
const elementCode = (tag, ns) => (tag === "script" ? "script" : ns !== HTML_NS ? "element" : FRAMES.has(tag) ? "frame" : FORMS.has(tag) ? "form" : "element");

// The place of an element for the positional part of the inventory: a hash of the tag names from the inventory's root down to it (no
// indexes, so elements inserted or deleted before it do not move it), two 32-bit lanes.
const placeOf = (parent, tag) => {
  let a = parent[0] ^ 0x811c9dc5;
  let b = parent[1] ^ 0x01000193;
  for (let i = 0; i < tag.length; i++) {
    a = Math.imul(a ^ tag.charCodeAt(i), 0x01000193);
    b = Math.imul(b ^ tag.charCodeAt(i), 0x5bd1e995);
  }
  a = Math.imul(a ^ (a >>> 15), 0x2c1b3c6d) ^ 0x3e;
  b = Math.imul(b ^ (b >>> 13), 0x297a2d39) ^ 0x3e;
  return [a | 0, b | 0];
};

/**
 * A summary of what is active in a parsed document (a parse5 tree), in two parts:
 *  - entries: canonical and order-independent: every element outside the allowlist (with all its attributes and, for script and other
 *    raw-text elements, its body), every attribute outside the allowlist, every link target and every load target (a URL attribute or a
 *    CSS url()), CSS that is not plain, and (when the file holds any script) every text or attribute value with a template delimiter.
 *    [{key, kind, code?, url?, urlKind?, n}] sorted by key: what was added or removed, and the links History lists.
 *  - seq: positional: every one of those entries that is not allowed (a `code`, templates aside) in document order, each with the
 *    element that owns it: the place of the owner (the tag names from the root down to it, placeOf), its tag and its `id`. Two
 *    inventories whose seq differ other than by items removed moved, swapped, copied or changed something active (outside review
 *    029e51b, html-active.js:282: two `onclick` values swapped between elements kept the same entries).
 * Returns {scripted, entries, seq}. Iterative: any depth. Values over 2,048 characters are kept by hash.
 */
export function inventory(tree) {
  const counts = new Map(); // key -> {kind, code, url, urlKind, n}
  const seq = [];
  let own = null; // the active items of the element being read, sorted into seq after it
  const add = (key, rec) => {
    const e = counts.get(key);
    if (e) e.n++;
    else counts.set(key, { key, ...rec, n: 1 });
    if (rec.code && rec.kind !== "template" && own) own.push(key);
  };
  const tpl = []; // [where, value] of values with a template delimiter, kept when the file turns out to hold a script
  let scripted = false;
  const ROOT = [0, 0];
  const stack = [tree];
  const places = [ROOT];
  while (stack.length) {
    const n = stack.pop();
    const up = places.pop();
    const ks = kidsOf(n);
    const here = n.tagName === undefined ? up : placeOf(up, `${n.namespaceURI === HTML_NS ? "" : `${n.namespaceURI}|`}${n.tagName}`);
    for (let i = ks.length - 1; i >= 0; i--) (stack.push(ks[i]), places.push(here));
    if (n.nodeName === "#text") {
      const p = n.parentNode;
      const raw = p && ((p.namespaceURI === HTML_NS && RAW.has(p.tagName)) || p.tagName === "script" || p.tagName === "style");
      if (!raw && TEMPLATE.test(n.value)) tpl.push(["text", n.value]);
      continue;
    }
    if (n.tagName === undefined) continue;
    const tag = n.tagName;
    const ns = n.namespaceURI;
    const attrs = n.attrs || [];
    own = [];
    // owner and key as separate fields (an id can hold any character, so no joined string is split later: outside review of 4d2b2fc)
    const owner = keyOf(`${here[0] >>> 0}.${here[1] >>> 0}`, tag, attrs.find((a) => a.name === "id" && !a.prefix)?.value ?? "");
    const flush = () => {
      for (const key of own.sort()) seq.push({ owner, key });
      own = null;
    };
    if (tag === "script") scripted = true; // an SVG script runs too
    if (!elementAllowed(tag, ns)) {
      // its own text (a script or style body, in HTML or SVG): a changed body is a changed entry
      const body = kidsOf(n).filter((c) => c.nodeName === "#text").map((c) => c.value).join("");
      const sig = attrs.map((a) => [`${a.prefix ? `${a.prefix}:` : ""}${a.name}`, keep(a.value)]).sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0));
      add(keyOf("el", ns === HTML_NS ? "" : ns, tag, sig, body ? sha(body) : ""), { kind: "element", code: elementCode(tag, ns) });
      for (const a of attrs) if (TEMPLATE.test(a.value)) tpl.push(["attr", a.value]);
      flush();
      continue;
    }
    for (const a of attrs) {
      const name = a.name; // an allowed element is an HTML one: its attributes have no namespace prefix
      if (TEMPLATE.test(a.value)) tpl.push(["attr", a.value]);
      const urlRole = URL_ATTRS[`${tag} ${name}`];
      if (urlRole) {
        const k = urlKind(a.value);
        add(keyOf("url", urlRole, tag, name, keep(a.value)), { kind: urlRole, url: keep(a.value), urlKind: k, code: URL_KINDS[urlRole].has(k) ? undefined : `${urlRole}_url` });
      } else if (name === "style") {
        const c = cssPlain(a.value);
        if (!c.ok) add(keyOf("css", "attr", sha(a.value)), { kind: "css", code: "css" });
        for (const u of c.loads) add(keyOf("url", "load", "css", "url", keep(u)), { kind: "load", url: keep(u), urlKind: urlKind(u), code: URL_KINDS.load.has(urlKind(u)) ? undefined : "load_url" });
      } else if (!attributeAllowed(tag, name)) {
        add(keyOf("attr", tag, name, keep(a.value)), { kind: "attribute", code: /^on/i.test(name) ? "event_handler" : "attribute" });
      }
    }
    if (tag === "style" && ns === HTML_NS) {
      const body = kidsOf(n).map((c) => c.value ?? "").join("");
      const c = cssPlain(body);
      if (!c.ok) add(keyOf("css", "style", sha(body)), { kind: "css", code: "css" });
      for (const u of c.loads) add(keyOf("url", "load", "css", "url", keep(u)), { kind: "load", url: keep(u), urlKind: urlKind(u), code: URL_KINDS.load.has(urlKind(u)) ? undefined : "load_url" });
    }
    flush();
  }
  for (const [where, v] of tpl) add(keyOf("tpl", where, sha(v)), { kind: "template", code: "template" });
  const entries = [...counts.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).map((e) => Object.fromEntries(Object.entries(e).filter(([, v]) => v !== undefined)));
  return { scripted, entries, seq };
}

/** Reason codes, in the order a refusal names the first one found. Neutral words only: never any of the file's content. */
export const REASONS = ["script", "event_handler", "frame", "form", "element", "attribute", "link_url", "load_url", "css", "template"];

/**
 * What a write added or changed, from the inventories before and after: `added` and `removed` entries (a count that grew or shrank is
 * that many), `links` ({added, removed} link and load targets, for History), and `refused` with `reason` (one REASONS code) and `reasons`
 * when anything added is active, or when the active items after are not the ones before in the same order on the same owners less some
 * removed (seq: a move, a swap or a copy between elements). A changed target is a removed entry and an added one: refused only when the
 * new one's kind is not allowed for its attribute (R1), listed in `links` either way. Text with a template delimiter counts only when
 * either version holds a script.
 */
export function inventoryDelta(before, after) {
  const count = (inv) => new Map(inv.entries.map((e) => [e.key, e]));
  const A = count(before);
  const B = count(after);
  const added = [];
  const removed = [];
  for (const [k, e] of B) {
    const d = e.n - (A.get(k)?.n || 0);
    if (d > 0) added.push({ ...e, n: d });
  }
  for (const [k, e] of A) {
    const d = e.n - (B.get(k)?.n || 0);
    if (d > 0) removed.push({ ...e, n: d });
  }
  const scripted = before.scripted || after.scripted;
  const codes = new Set(added.filter((e) => e.code && (e.kind !== "template" || scripted)).map((e) => e.code));
  // positional: the active items after must be the ones before, in order, less some removed (a subsequence); each one not found names
  // its entry's code. Ceiling: an owner is told by its place, tag and id, so an item moved to another element of the same tag, place and
  // id with no other active item between is not seen (the same code runs, on a neighbor). Wrapping an owner in a new element is a move.
  const codeOf = new Map([...A, ...B].map(([k, e]) => [k, e.code]));
  const bs = after.seq || [];
  const as = before.seq || [];
  for (let i = 0, j = 0; j < bs.length; j++) {
    while (i < as.length && (as[i].owner !== bs[j].owner || as[i].key !== bs[j].key)) i++;
    if (i < as.length) i++;
    else {
      const c = codeOf.get(bs[j].key);
      if (c) codes.add(c);
    }
  }
  const reasons = REASONS.filter((r) => codes.has(r));
  const isUrl = (e) => e.kind === "link" || e.kind === "load";
  return {
    refused: reasons.length > 0,
    reason: reasons[0] ?? null,
    reasons,
    added,
    removed,
    links: { added: added.filter(isUrl).map((e) => ({ kind: e.kind, url: e.url, urlKind: e.urlKind })), removed: removed.filter(isUrl).map((e) => ({ kind: e.kind, url: e.url, urlKind: e.urlKind })) },
  };
}
