import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cssPlain, DISPLAY_CONTROLS, DISPLAY_INPUT_TYPES, displayAttributeAllowed, displayElementAllowed, HTML_NS, URL_KINDS, urlKind } from "./html-active.js";
import { editHosts, escapeAttr, escapeText, htmlParser, kids } from "./html.js";

// The render copy (PLAN-html 3.2 as changed by R2 to R5, R12, R16, R20 to R22): one version of a person's HTML file turned into a page the
// Onionskin page shows in `<iframe sandbox="allow-same-origin" srcdoc>`. It is written by the serializer below from the parsed tree, never
// by passing the file's bytes through: an element or attribute is written only when the display set (src/html-active.js) names it, every
// text and attribute value is escaped here, and everything else is left out and counted in `stats`. The copy holds no address a browser
// could load or follow: no `href` (a link keeps its target as `data-osk-href`, for display), no `src` but a `data:` image this module made
// from a local image or a `data:` image it checked, no `url(` in CSS but such an image, and no `link`, `meta` (but the CSP meta it puts
// first in `head`), `base`, `form`, frame, `object`, `embed`, `script`, `noscript` or `template` element. Then the copy is parsed again and
// must give the tree it was written from (R2); if not, the caller shows the plain text view (plainCopy).
// Runs in a worker only (src/html-render-worker.js): the parser is there. Every walker is iterative.

/** The frame's own policy (3.2): the first child of `head` in every copy. */
export const RENDER_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; media-src data:";

/**
 * Caps (3.2, R5, R21). Images: one at most 10 MB, at most 500 shown and 30 MB in all as the copy holds them (base64; each place an
 * image is shown counts, since each holds its own copy of the bytes); a local image at most 3 folders below the file, at most 16,000 px a side and 64 million pixels.
 * Stylesheets: a local one at most 2 MB, `@import` at most 5 levels deep, and the page's styles in all at most 2 MB, 20,000 rules and
 * 200 `:has(`, else every style of the page is left out.
 */
export const RENDER_LIMITS = { asset: 10 * 1024 * 1024, assets: 500, total: 30 * 1024 * 1024, folderDepth: 3, side: 16_000, pixels: 64_000_000, sheet: 2 * 1024 * 1024, importDepth: 5, cssBytes: 2 * 1024 * 1024, cssRules: 20_000, cssHas: 200 };

/** Why an image or a stylesheet was not shown: fixed codes, never any of the file's content. */
export const ASSET_CODES = ["remote", "folder", "absolute", "outside", "too_deep", "hidden", "library", "bad_url", "not_found", "symlink", "not_regular", "empty", "too_large", "changed", "unreadable", "type", "dimensions", "over_count", "over_total", "repeat", "not_text", "css_cap"];

const VOID = new Set(["area", "base", "basefont", "bgsound", "br", "col", "embed", "frame", "hr", "image", "img", "input", "keygen", "link", "meta", "param", "source", "track", "wbr"]);
const FRAMES = new Set(["iframe", "frame", "frameset", "object", "embed", "applet", "portal", "fencedframe"]);
const MEDIA = new Set(["video", "audio", "canvas"]);
/** Left out with everything in them, counted as "dropped". */
const DROP = new Set(["meta", "base", "noembed", "noframes", "param", "source", "track", "area", "keygen", "basefont", "bgsound", "slot", "image"]);
/** Shown under another, parse-equivalent name: raw-text and legacy elements as `pre`, `dir` as `ul`. */
const RENAME = { xmp: "pre", plaintext: "pre", listing: "pre", dir: "ul" };
/** Where a `div` standing for a `form` would be moved out by the parser (a `form` there is empty: the parser closes it at once). */
const TABLE_CONTEXT = new Set(["table", "tbody", "thead", "tfoot", "tr"]);
const LEADING_LF = new Set(["pre", "textarea", "listing"]);
const RCDATA = new Set(["title", "textarea"]);
const PLACEHOLDER_STYLE = "display:inline-block;border:1px dashed #888;padding:1px 4px;font:12px/1.4 sans-serif;color:#666;background:#f4f4f4";
/** The fixed labels of the placeholders, by kind. */
export const PLACEHOLDER_LABELS = { image: "[image not shown]", media: "[media not shown]", graphic: "[graphic not shown]" };

// ---- the serializer -----------------------------------------------------------------------------------------------------------------
// One set of functions writes the copy and, from the tree of the copy parsed again, the same text again; the two must be equal (R2).
// Adjacent text nodes are kept apart by an empty comment, so text on either side of something left out stays two nodes, as in the file
// (the page maps the n-th text node of the frame to `texts[n]`).

class Writer {
  constructor() {
    this.out = ["<!DOCTYPE html>"];
    this.stack = [{ tag: "#document", lastText: false, first: true }];
    this.texts = [];
    this.failed = null;
    this.bodyText = 0;
    this.inBody = 0;
  }
  open(tag, attrs) {
    const top = this.stack[this.stack.length - 1];
    top.lastText = false;
    top.first = false;
    let s = `<${tag}`;
    for (const [name, value] of attrs) s += ` ${name}=${attrValue(value)}`;
    this.out.push(`${s}>`);
    if (VOID.has(tag)) return false;
    this.stack.push({ tag, lastText: false, first: true });
    if (tag === "body") this.inBody++;
    return true;
  }
  close() {
    const f = this.stack.pop();
    if (f.tag === "body") this.inBody--;
    this.out.push(`</${f.tag}>`);
  }
  text(value, id, visible = true) {
    if (!value) return;
    const top = this.stack[this.stack.length - 1];
    if (top.lastText) this.out.push("<!---->");
    let s;
    if (top.tag === "style") {
      if (/<\/style/i.test(value)) return (this.failed ??= "style_end");
      s = value;
    } else {
      const e = escapeText(value, RCDATA.has(top.tag) ? "rcdata" : "normal", { atStartOfLeadingLf: top.first && LEADING_LF.has(top.tag) });
      if (!e.ok) return (this.failed ??= e.code);
      s = e.out;
    }
    this.out.push(s);
    top.lastText = true;
    top.first = false;
    this.texts.push(id ?? -1);
    if (visible && this.inBody && top.tag !== "style") this.bodyText += value.replace(/\s+/g, "").length;
  }
  comment(data = "") {
    const top = this.stack[this.stack.length - 1];
    top.lastText = false;
    top.first = false;
    this.out.push(`<!--${data}-->`);
  }
}

function attrValue(v) {
  const e = escapeAttr(String(v), '"');
  return e.ok ? e.out : '""';
}

/** The text of a parsed copy, written by the same Writer: equal to the copy when the parse gave the tree the copy was written from. */
function serializeTree(doc) {
  const w = new Writer();
  const stack = [];
  const push = (list) => {
    for (let i = list.length - 1; i >= 0; i--) stack.push(list[i]);
  };
  push(kids(doc).filter((n) => n.nodeName !== "#documentType"));
  for (const n of kids(doc)) if (n.nodeName === "#documentType" && n.name !== "html") return null;
  while (stack.length) {
    const n = stack.pop();
    if (n === CLOSE) {
      w.close();
      continue;
    }
    if (n.nodeName === "#text") w.text(n.value);
    else if (n.nodeName === "#comment") w.comment(n.data);
    else if (n.tagName !== undefined) {
      if (n.namespaceURI !== HTML_NS) return null; // the copy holds no foreign element
      if (n.attrs.some((a) => a.namespace || a.prefix)) return null;
      if (w.open(n.tagName, n.attrs.map((a) => [a.name, a.value]))) {
        stack.push(CLOSE);
        push(kids(n));
      }
    } else return null;
  }
  return w.failed ? null : w.out.join("");
}
const CLOSE = Symbol("close");

// ---- whitespace runs ---------------------------------------------------------------------------------------------------------------
// urlKind and cssPlain (src/html-active.js) and the CSS patterns below backtrack over a long run of whitespace that is not followed by
// what they look for (a 500,000-space run inside a url( held one call for minutes). So a URL holding a run of 64 or more is treated as
// one this cannot read, and CSS has every such run shortened to one space before any pattern reads it (CSS treats a run as one space,
// but inside a quoted string, where 64 spaces in a row are not a thing a page needs).
const LONG_WS = /[ \t\n\f\r]{64}/;
const kindOf = (v) => (LONG_WS.test(v) ? "other" : urlKind(v));
const shortWs = (css) => (LONG_WS.test(css) ? css.replace(/[ \t\n\f\r]{64,}/g, " ") : css);
const isWs = (c) => c === 32 || c === 9 || c === 10 || c === 12 || c === 13;
function trimWs(s) {
  let a = 0;
  let b = s.length;
  while (a < b && isWs(s.charCodeAt(a))) a++;
  while (b > a && isWs(s.charCodeAt(b - 1))) b--;
  return s.slice(a, b);
}

// elements inside an editable part the person never types in (web/src/html-view.js NOT_TYPED, the controls the copy shows)
const ISLANDS = new Set(["button", "select", "option", "optgroup", "textarea", "input", "datalist", "output", "progress", "meter"]);

// ---- assets (R5) ----------------------------------------------------------------------------------------------------------------------
const isHomeOrRoot = (dir) => {
  const real = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  const d = real(dir);
  return d === real(os.homedir()) || d === path.parse(d).root || /^\/Volumes\/[^/]+$/.test(d);
};

/**
 * A relative reference resolved against `base` (folder names below the file's folder) to the names of the file it means, or why not:
 * no query or fragment, no absolute path, no encoded separator, no folder or file whose name starts with a dot, no `Library` folder
 * (any case), never above the file's folder, at most `folderDepth` folders down. Pure: no file is touched.
 */
export function resolveRef(ref, base = [], limits = RENDER_LIMITS) {
  let v = trimWs(String(ref ?? ""));
  if (LONG_WS.test(v)) return { ok: false, code: "bad_url" };
  const cut = v.search(/[?#]/);
  if (cut >= 0) v = v.slice(0, cut);
  if (v.startsWith("/")) return { ok: false, code: "absolute" };
  if (/%(?:2f|5c|00)/i.test(v)) return { ok: false, code: "bad_url" };
  let d;
  try {
    d = decodeURIComponent(v);
  } catch {
    return { ok: false, code: "bad_url" };
  }
  if (/[\u0000-\u001f\u007f\\:]/.test(d)) return { ok: false, code: "bad_url" };
  const segs = [...base];
  for (const part of d.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (!segs.length) return { ok: false, code: "outside" };
      segs.pop();
    } else segs.push(part);
  }
  if (!segs.length || d.endsWith("/")) return { ok: false, code: "bad_url" };
  if (segs.length - 1 > limits.folderDepth) return { ok: false, code: "too_deep" };
  for (let i = 0; i < segs.length; i++) {
    if (segs[i].startsWith(".")) return { ok: false, code: "hidden" };
    if (i < segs.length - 1 && segs[i].toLowerCase() === "library") return { ok: false, code: "library" };
  }
  return { ok: true, segs };
}

/**
 * The real reader of a local asset (R5), opened the way src/watch.js opens a file: every folder on the way is a real folder (lstat, not a
 * symlink), every name is spelled as its folder lists it (a case variant is not the file on a case-sensitive disk and must not be here
 * either), the file is a regular file opened non-blocking without following a symlink, its descriptor is checked with fstat against the
 * lstat and read. `readAsset(segs, {fileDir, max})` -> {ok: true, bytes, key ("dev:ino")} | {ok: false, code}. Keeps folder listings
 * for the one render it serves.
 * A folder swapped for a symlink between those checks and the open (Node has no openat, so the open follows a symlinked folder) is
 * caught after it: once the file is open, and again once it is read, its path is resolved again (realpath) and must be the expected one
 * under the file's real folder, the path's lstat must be the open descriptor's device and inode, and every folder on the way must still
 * be the same real folder (device and inode, not a symlink). Any difference refuses the asset ("changed"); nothing read is used.
 * Ceiling: a swap made and undone entirely between the open and the first of those checks, twice over, is not seen; the bytes would
 * then come from a file the person's own account can read anyway. Upgrade path: a native openat walk.
 * `hooks` (tests only): {beforeFile(segs), afterOpen(segs)}: run after the folders are checked (before the file's lstat and open) and
 * right after the open.
 */
export function makeAssetReader({ hooks = null } = {}) {
  const listings = new Map();
  const listed = (dir, name) => {
    let set = listings.get(dir);
    if (!set) {
      try {
        set = new Set(fs.readdirSync(dir).map((n) => n.normalize("NFC")));
      } catch {
        set = new Set();
      }
      listings.set(dir, set);
    }
    return set.has(name.normalize("NFC"));
  };
  const reals = new Map();
  const realOf = (p) => {
    try {
      return fs.realpathSync(p).normalize("NFC");
    } catch {
      return null;
    }
  };
  return function readAsset(segs, { fileDir, max }) {
    let base = reals.get(fileDir);
    if (base === undefined) reals.set(fileDir, (base = realOf(fileDir)));
    if (!base) return { ok: false, code: "not_found" };
    let dir = fileDir;
    const folders = []; // [path, dev, ino] of every folder on the way, as checked
    for (let i = 0; i < segs.length; i++) {
      const name = segs[i];
      if (!listed(dir, name)) return { ok: false, code: "not_found" };
      const p = path.join(dir, name);
      if (i === segs.length - 1) hooks?.beforeFile?.(segs);
      let st;
      try {
        st = fs.lstatSync(p);
      } catch {
        return { ok: false, code: "not_found" };
      }
      if (st.isSymbolicLink()) return { ok: false, code: "symlink" };
      if (i < segs.length - 1) {
        if (!st.isDirectory()) return { ok: false, code: "not_found" };
        folders.push([p, st.dev, st.ino]);
        dir = p;
        continue;
      }
      if (!st.isFile()) return { ok: false, code: "not_regular" };
      if (st.size === 0) return { ok: false, code: "empty" };
      if (st.size > max) return { ok: false, code: "too_large" };
      const expected = path.join(base, ...segs.map((x) => x.normalize("NFC")));
      let fd;
      try {
        fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      } catch (err) {
        return { ok: false, code: err?.code === "ELOOP" ? "symlink" : "unreadable" };
      }
      try {
        hooks?.afterOpen?.(segs);
        const f = fs.fstatSync(fd);
        if (!f.isFile() || f.ino !== st.ino || f.dev !== st.dev) return { ok: false, code: "changed" };
        // the path still leads to this descriptor, through the same real folders, to the expected place
        const same = () => {
          let now;
          try {
            now = fs.lstatSync(p);
          } catch {
            return false;
          }
          if (now.isSymbolicLink() || now.ino !== f.ino || now.dev !== f.dev) return false;
          for (const [fp, dev, ino] of folders) {
            let d;
            try {
              d = fs.lstatSync(fp);
            } catch {
              return false;
            }
            if (d.isSymbolicLink() || !d.isDirectory() || d.dev !== dev || d.ino !== ino) return false;
          }
          return realOf(p) === expected;
        };
        if (!same()) return { ok: false, code: "changed" };
        if (f.size === 0) return { ok: false, code: "empty" };
        if (f.size > max) return { ok: false, code: "too_large" };
        const bytes = Buffer.alloc(f.size);
        let off = 0;
        while (off < bytes.length) {
          const k = fs.readSync(fd, bytes, off, bytes.length - off, off);
          if (k <= 0) break;
          off += k;
        }
        if (off !== bytes.length || !same()) return { ok: false, code: "changed" };
        return { ok: true, bytes, key: `${f.dev}:${f.ino}` };
      } catch {
        return { ok: false, code: "unreadable" };
      } finally {
        fs.closeSync(fd);
      }
    }
    return { ok: false, code: "not_found" };
  };
}

/**
 * The type and size of an image, from its first bytes (never its name): PNG, JPEG, GIF or WebP (v1, no SVG). Returns {ok, mime, width,
 * height} or {ok: false, code: "type" | "dimensions"} (a header this cannot read, or past 16,000 px a side or 64 million pixels).
 */
export function sniffImage(b, limits = RENDER_LIMITS) {
  const dims = (mime, width, height) => (width > 0 && height > 0 && width <= limits.side && height <= limits.side && width * height <= limits.pixels ? { ok: true, mime, width, height } : { ok: false, code: "dimensions" });
  const at = (s, o) => b.length >= o + s.length && b.toString("latin1", o, o + s.length) === s;
  if (b.length >= 24 && at("\x89PNG\r\n\x1a\n", 0) && at("IHDR", 12)) return dims("image/png", b.readUInt32BE(16), b.readUInt32BE(20));
  if (b.length >= 10 && (at("GIF87a", 0) || at("GIF89a", 0))) return dims("image/gif", b.readUInt16LE(6), b.readUInt16LE(8));
  if (b.length >= 30 && at("RIFF", 0) && at("WEBP", 8)) {
    if (at("VP8 ", 12) && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return dims("image/webp", b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff);
    if (at("VP8L", 12) && b[20] === 0x2f) return dims("image/webp", 1 + (((b[22] & 0x3f) << 8) | b[21]), 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6)));
    if (at("VP8X", 12)) return dims("image/webp", 1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3));
    return { ok: false, code: "type" };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    // walk the markers to the first frame header (SOF): its height and width
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return { ok: false, code: "type" };
      while (b[i] === 0xff && i < b.length) i++;
      const m = b[i];
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
        i++;
        continue;
      }
      if (m === 0xd9 || m === 0xda) return { ok: false, code: "type" };
      if (i + 8 >= b.length) break;
      const len = b.readUInt16BE(i + 1);
      if ((m >= 0xc0 && m <= 0xc3) || (m >= 0xc5 && m <= 0xc7) || (m >= 0xc9 && m <= 0xcb) || (m >= 0xcd && m <= 0xcf)) return dims("image/jpeg", b.readUInt16BE(i + 6), b.readUInt16BE(i + 4));
      if (len < 2) return { ok: false, code: "type" };
      i += 1 + len;
    }
    return { ok: false, code: "type" };
  }
  return { ok: false, code: "type" };
}

/** The bytes of a `data:` URL ({mime, bytes}), or null when it is not one this can read. */
function dataUrl(v) {
  const m = /^[ \t\n\f\r]*data:([^,]*),(.*)$/is.exec(String(v));
  if (!m) return null;
  const params = m[1].split(";").map((s) => s.trim().toLowerCase());
  const mime = params[0] || "text/plain";
  const b64 = params.includes("base64");
  try {
    const bytes = b64 ? Buffer.from(m[2].replace(/[ \t\n\f\r]/g, ""), "base64") : Buffer.from(decodeURIComponent(m[2]), "utf8");
    return { mime, bytes };
  } catch {
    return null;
  }
}

const UTF8 = new TextDecoder("utf-8", { fatal: true });

// ---- CSS (R1's rule, R16, R21) -------------------------------------------------------------------------------------------------------
const IMPORT = /@import[ \t\n\f\r]+(?:url\([ \t\n\f\r]*(?:"([^"]*)"|'([^']*)'|([^)"' \t\n\f\r]+)?)[ \t\n\f\r]*\)|"([^"]*)"|'([^']*)')[ \t\n\f\r]*([^;{}]*)(?:;|$)/gi;
const MEDIA_LIST = /^[a-z0-9 ,()\-:._]*$/i;

// ---- the render ---------------------------------------------------------------------------------------------------------------------
/**
 * The render copy of one reading (src/html.js readHtml). `fileDir` is the folder of the file's real path; `readAsset(segs, {fileDir,
 * max})` reads one local asset (default: makeAssetReader(), the real one). `editable`: the parts the person may type in are marked
 * `contenteditable` (src/html.js editHosts; the view route's copy always is). Returns
 *   {bytes (the copy, UTF-8), texts (for the n-th text node of the copy in tree order, the id of its text node in the reading, or -1),
 *    stats}
 * or {plain: true, reason} when the copy, parsed again, is not the tree it was written from (reason "reparse") or a text could not be
 * written ("nul", "lone_surrogate", "style_end"): the caller then shows plainCopy(read).
 * `stats` holds numbers and fixed codes only, never any of the file's content:
 *   {scripts, handlers (on* attributes), noscript, templates, frames, forms (shown as inert div), controls (shown disabled), media,
 *    foreign (SVG and MathML left out), links (targets kept for display), attributes (left out), elements (written), dropped (elements
 *    left out), renamed, remote (images, stylesheets, imports and CSS url() not loaded because not local), assets: {shown, refused:
 *    {code: n}}, styles: {kept, left: {code: n}, heavy: null | "css_bytes" | "css_rules" | "css_has"}, folder: null | "home_or_root",
 *    bodyText (visible characters in the body, not counting spaces: 0 means R16's "built by scripts" message)}
 */
export function renderCopy(read, { fileDir, readAsset = makeAssetReader(), limits = RENDER_LIMITS, editable = false } = {}) {
  const stats = { scripts: 0, handlers: 0, noscript: 0, templates: 0, frames: 0, forms: 0, controls: 0, media: 0, foreign: 0, links: 0, attributes: 0, elements: 0, dropped: 0, renamed: 0, remote: 0, assets: { shown: 0, refused: {} }, styles: { kept: 0, left: {}, heavy: null }, folder: null, bodyText: 0 };
  const bump = (o, k) => (o[k] = (o[k] || 0) + 1);
  // what the file holds, wherever it is (the banner: "Scripts are off in this view")
  for (const x of read.nodes) {
    if (x.tagName === undefined) continue;
    if (x.tagName === "script") stats.scripts++;
    for (const a of x.attrs) if (/^on/i.test(a.name)) stats.handlers++;
  }
  const noAssets = fileDir == null || isHomeOrRoot(fileDir);
  if (noAssets) stats.folder = "home_or_root";
  let total = 0;
  let count = 0;
  const imageCache = new Map(); // joined names -> {ok, bytes, ...}
  const refuse = (code) => {
    if (code === "remote") stats.remote++;
    else bump(stats.assets.refused, code);
    return null;
  };
  /** A `data:` URI for an image in the copy, counted against the caps, or null (counted). */
  const imageUri = (bytes) => {
    const s = sniffImage(bytes, limits);
    if (!s.ok) return refuse(s.code);
    if (bytes.length > limits.asset) return refuse("too_large");
    if (count + 1 > limits.assets) return refuse("over_count");
    const size = 4 * Math.ceil(bytes.length / 3); // as it is held in the copy (base64): the copy stays within the page and 30 MB
    if (total + size > limits.total) return refuse("over_total");
    count++;
    total += size;
    stats.assets.shown++;
    let b64 = base64s.get(bytes);
    if (b64 === undefined) base64s.set(bytes, (b64 = bytes.toString("base64")));
    return `data:${s.mime};base64,${b64}`;
  };
  const base64s = new WeakMap();
  const readLocal = (ref, base, max) => {
    if (noAssets) return { ok: false, code: "folder" };
    const r = resolveRef(ref, base, limits);
    if (!r.ok) return r;
    const got = readAsset(r.segs, { fileDir, max });
    return got.ok ? { ...got, segs: r.segs } : got;
  };
  /** An image reference (an img src or a CSS url()) as a data: URI, or null (counted). `base` null: relative is not resolvable. */
  const image = (ref, base) => {
    const kind = kindOf(ref);
    if (kind === "data-image" || (kind === "other" && /^[ \t\n\f\r]*data:image\//i.test(ref))) {
      const d = dataUrl(ref);
      return d ? imageUri(d.bytes) : refuse("type");
    }
    if (kind !== "relative") return refuse("remote");
    if (base === null) return refuse("bad_url"); // a relative url() in a data: stylesheet has nothing to resolve against
    const r = resolveRef(ref, base, limits);
    if (!r.ok) return refuse(r.code);
    const key = r.segs.join("/");
    let got = imageCache.get(key);
    if (!got) {
      // bounded before it happens: at most `assets` files read, and no more bytes read in all than `total` (read and not shown counts
      // too), so a page naming thousands of large local files reads at most 30 MB of them; a file that is not an image is not kept
      const room = Math.min(limits.asset, limits.total - readBytes);
      if (count >= limits.assets || reads >= limits.assets) got = { ok: false, code: "over_count" };
      else if (room <= 0) got = { ok: false, code: "over_total" };
      else {
        reads++;
        got = readLocal(ref, base, room);
        if (got.ok) {
          readBytes += got.bytes.length;
          const sn = sniffImage(got.bytes, limits);
          if (!sn.ok) got = sn;
        } else if (got.code === "too_large" && room < limits.asset) got = { ok: false, code: "over_total" };
      }
      imageCache.set(key, got);
    }
    if (!got.ok) return refuse(got.code);
    return imageUri(got.bytes);
  };
  let reads = 0;
  let readBytes = 0;

  // ---- pass 1: the page's stylesheets, their imports read, then the caps decided before anything is written (R21) ----
  const sheetsSeen = new Set(); // dev:ino of every local stylesheet already inlined: never the same file twice
  const sheetText = (bytes) => {
    try {
      return shortWs(UTF8.decode(bytes).replace(/^\ufeff/, ""));
    } catch {
      return null;
    }
  };
  const sheets = new Map(); // node -> its CSS in the copy, or null (left out)
  // a local stylesheet is read once (by its path, then by its file), and reading stops where the 2 MB cap is spent (which leaves every
  // style of the page out anyway), so a page naming one sheet a thousand times, or a thousand sheets, reads at most 2 MB of CSS
  const sheetPaths = new Set();
  let cssRead = 0;
  const readSheet = (ref, base) => {
    if (noAssets) return { ok: false, code: "folder" };
    const r = resolveRef(ref, base, limits);
    if (!r.ok) return r;
    const key = r.segs.join("/");
    if (sheetPaths.has(key)) return { ok: false, code: "repeat" };
    sheetPaths.add(key);
    const room = Math.min(limits.sheet, limits.cssBytes - cssRead);
    if (room <= 0) return (stats.styles.heavy ??= "css_bytes"), { ok: false, code: "css_cap" };
    const got = readLocal(ref, base, room);
    if (got.ok) cssRead += got.bytes.length;
    else if (got.code === "too_large" && room < limits.sheet) return (stats.styles.heavy ??= "css_bytes"), { ok: false, code: "css_cap" };
    if (got.ok && sheetsSeen.has(got.key)) return { ok: false, code: "repeat" };
    if (got.ok) sheetsSeen.add(got.key);
    return got;
  };
  const readDataSheet = (ref) => {
    const d = dataUrl(ref);
    if (!d || d.mime !== "text/css") return refuse("not_text");
    const room = Math.min(limits.sheet, limits.cssBytes - cssRead);
    if (room <= 0) return (stats.styles.heavy ??= "css_bytes"), refuse("css_cap");
    if (d.bytes.length > room) {
      if (room < limits.sheet) return (stats.styles.heavy ??= "css_bytes"), refuse("css_cap");
      return refuse("too_large");
    }
    cssRead += d.bytes.length;
    const text = sheetText(d.bytes);
    if (text === null) return refuse("not_text");
    return text;
  };
  const sheetNodes = [];
  {
    const stack = [read.doc];
    while (stack.length) {
      const n = stack.pop();
      if (n.tagName !== undefined) {
        if (n.namespaceURI !== HTML_NS) continue;
        const t = n.tagName;
        if (t === "script" || t === "template" || t === "noscript" || FRAMES.has(t) || t === "noembed" || t === "noframes") continue;
        if (t === "style" || (t === "link" && isStylesheet(n))) sheetNodes.push(n);
        if (t === "style") continue;
      }
      const ks = kids(n);
      for (let i = ks.length - 1; i >= 0; i--) stack.push(ks[i]);
    }
  }
  let cssBytes = 0;
  let cssRules = 0;
  let cssHas = 0;
  const raw = new Map(); // node -> its parts (expandSheet), url() still to rewrite
  for (const n of sheetNodes) {
    let css = null;
    let base = [];
    if (n.tagName === "style") {
      css = shortWs(kids(n).map((c) => c.value ?? "").join(""));
      cssRead += Buffer.byteLength(css);
    }
    else {
      const href = attr(n, "href") ?? "";
      if (/^[ \t\n\f\r]*data:/i.test(href)) {
        css = readDataSheet(href);
        base = null;
      } else if (kindOf(href) === "relative") {
        const got = readSheet(href, []);
        if (!got.ok) refuse(got.code);
        else {
          css = sheetText(got.bytes);
          if (css === null) refuse("not_text");
          base = got.segs.slice(0, -1);
        }
      } else refuse("remote");
    }
    if (css === null) continue;
    const parts = expandSheet(css, base);
    for (const p of parts) {
      cssBytes += Buffer.byteLength(p.text);
      cssRules += (p.text.match(/\{/g) || []).length;
      cssHas += (p.text.match(/:has\(/gi) || []).length;
    }
    raw.set(n, parts);
  }
  // a sheet and its imports as a list of parts in order, each with the folder its url() resolve against (null: none, a data: sheet);
  // iterative: a stack of sheets still to split at their imports and parts ready to keep
  function expandSheet(css, base) {
    const out = [];
    const st = [{ sheet: css, base, depth: 0 }];
    while (st.length) {
      const it = st.pop();
      if (it.part !== undefined) {
        if (it.part) out.push({ text: it.part, base: it.base });
        continue;
      }
      const items = [];
      let last = 0;
      for (const m of it.sheet.matchAll(IMPORT)) {
        items.push({ part: it.sheet.slice(last, m.index), base: it.base });
        last = m.index + m[0].length;
        const r = importTarget(m, it.base, it.depth);
        if (!r) continue;
        if (r.media) items.push({ part: `@media ${r.media}{`, base: [] });
        items.push({ sheet: r.text, base: r.base, depth: it.depth + 1 });
        if (r.media) items.push({ part: "}", base: [] });
      }
      items.push({ part: it.sheet.slice(last), base: it.base });
      for (let i = items.length - 1; i >= 0; i--) st.push(items[i]);
    }
    return out;
  }
  function importTarget(m, b, depth) {
    if (depth >= limits.importDepth) return (bump(stats.styles.left, "import_depth"), null);
    const target = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? "";
    const media = String(m[6] || "").trim();
    if (media && (!MEDIA_LIST.test(media) || /layer|supports|url/i.test(media))) return (bump(stats.styles.left, "import_media"), null);
    if (/^[ \t\n\f\r]*data:/i.test(target)) {
      const text = readDataSheet(target);
      if (text === null) return null;
      return { text, base: null, media };
    }
    if (kindOf(target) !== "relative" || b === null) return refuse("remote");
    const got = readSheet(target, b);
    if (!got.ok) return refuse(got.code);
    const text = sheetText(got.bytes);
    if (text === null) return refuse("not_text");
    return { text, base: got.segs.slice(0, -1), media };
  }

  // (already "css_bytes" when reading spent the 2 MB)
  if (!stats.styles.heavy && cssBytes > limits.cssBytes) stats.styles.heavy = "css_bytes";
  else if (!stats.styles.heavy && cssRules > limits.cssRules) stats.styles.heavy = "css_rules";
  else if (!stats.styles.heavy && cssHas > limits.cssHas) stats.styles.heavy = "css_has";
  const stylesOn = !stats.styles.heavy;

  /** CSS text with every url() made a checked data: image or `none`; null when the result is not plain (R1's rule) or not writable. */
  const resolveUrls = (css, base) => {
    const s = css;
    if (s.length < 4 || !/url\(/i.test(s)) return s;
    const space = (c) => {
      const k = c.charCodeAt(0);
      return k < 128 ? k === 32 || (k >= 9 && k <= 13) : /\s/.test(c);
    };
    const isUrl = (i) => (s.charCodeAt(i) | 32) === 117 && (s.charCodeAt(i + 1) | 32) === 114 && (s.charCodeAt(i + 2) | 32) === 108;
    let stop = null;
    const stops = () => {
      if (stop) return stop;
      const n = s.length;
      stop = { any: new Int32Array(n + 1), dq: new Int32Array(n + 1), sq: new Int32Array(n + 1), ns: new Int32Array(n + 1) };
      stop.any[n] = stop.dq[n] = stop.sq[n] = stop.ns[n] = n;
      for (let i = n - 1; i >= 0; i--) {
        const c = s[i];
        const ws = space(c);
        stop.any[i] = c === ")" || c === '"' || c === "'" || ws ? i : stop.any[i + 1];
        stop.dq[i] = c === '"' ? i : stop.dq[i + 1];
        stop.sq[i] = c === "'" ? i : stop.sq[i + 1];
        stop.ns[i] = ws ? stop.ns[i + 1] : i;
      }
      return stop;
    };
    const out = [];
    let from = 0;
    for (let i = 0; i + 3 < s.length; ) {
      if (!(isUrl(i) && s[i + 3] === "(")) {
        i++;
        continue;
      }
      const st = stops();
      const j = st.ns[i + 4];
      let val = null;
      let k = j;
      if (j < s.length && (s[j] === '"' || s[j] === "'")) {
        const close = j + 1 <= s.length ? (s[j] === '"' ? st.dq : st.sq)[j + 1] : s.length;
        if (close < s.length) [val, k] = [s.slice(j + 1, close), close + 1];
      } else {
        k = st.any[j];
        val = s.slice(j, k);
      }
      const m = val !== null ? st.ns[k] : s.length;
      if (val === null || m >= s.length || s[m] !== ")") {
        i++;
        continue;
      }
      const uri = image(val, base);
      out.push(s.slice(from, i), uri ? `url("${uri}")` : "none");
      from = i = m + 1;
    }
    if (!from) return s;
    out.push(s.slice(from));
    return out.join("");
  };
  const finalCss = (parts, inElement) => {
    const text = parts.map((p) => resolveUrls(p.text, p.base)).join("");
    const c = cssPlain(text);
    if (!c.ok || !c.loads.every((u) => kindOf(u) === "data-image")) return (bump(stats.styles.left, "not_plain"), null);
    if (inElement && /<\/style/i.test(text)) return (bump(stats.styles.left, "not_plain"), null);
    return text;
  };
  if (stylesOn) for (const [n, parts] of raw) sheets.set(n, finalCss(parts, true));

  // ---- pass 2: the copy ----
  const attrCss = new Map(); // a style attribute's value -> its CSS in the copy, or null (left out)
  const w = new Writer();
  // the parts the person may type in (src/html.js editHosts): editable as the frame parses the copy; inside one, a link, a placeholder
  // or a control is an island the caret skips (`contenteditable="false"`)
  const hosts = editable ? editHosts(read) : new Set();
  const inHost = (n) => {
    for (let a = n.__par; a; a = a.__par) if (hosts.has(a)) return true;
    return false;
  };
  const editAttr = (n, tag, at) => {
    if (hosts.has(n)) at.push(["contenteditable", "plaintext-only"]);
    else if ((tag === "a" || ISLANDS.has(tag)) && inHost(n)) at.push(["contenteditable", "false"]);
  };
  const ph = (kind, n) => {
    const at = [];
    if (n.__id !== undefined) at.push(["data-osk-id", String(n.__id)]);
    at.push(["data-osk-placeholder", kind], ["style", PLACEHOLDER_STYLE]);
    if (inHost(n)) at.push(["contenteditable", "false"]);
    w.open("span", at);
    w.text(PLACEHOLDER_LABELS[kind], -1, false); // a label of ours: not the page's text (R16 counts the page's own)
    w.close();
  };
  /** The attributes the copy keeps on `n`, written as `tag`: the display set, the CSS rule for style, data-osk-id first. */
  const attrsOf = (n, tag) => {
    const at = [];
    if (n.__id !== undefined) at.push(["data-osk-id", String(n.__id)]);
    for (const a of n.attrs) {
      if (a.namespace || a.prefix) {
        stats.attributes++;
        continue;
      }
      const name = a.name;
      if (/^on/i.test(name)) continue; // counted above
      if (name === "style") {
        if (!stylesOn) continue;
        // the same declarations on many elements are checked once (one with a url() counts its image at each place it is shown)
        let css = attrCss.get(a.value);
        if (css === undefined) {
          css = finalCss([{ text: shortWs(a.value), base: [] }], false);
          if (!/url\s*\(/i.test(a.value)) attrCss.set(a.value, css);
        } else if (css === null) bump(stats.styles.left, "not_plain");
        if (css !== null) (at.push(["style", css]), stats.styles.kept++);
        continue;
      }
      if (name === "href" && tag === "a") {
        const k = kindOf(a.value);
        if (URL_KINDS.link.has(k) && a.value.length <= 2048) (at.push(["data-osk-href", a.value]), stats.links++);
        else stats.attributes++;
        continue;
      }
      if (name === "type" && tag === "input") {
        const t = a.value.trim().toLowerCase();
        if (DISPLAY_INPUT_TYPES.has(t)) at.push(["type", t]);
        continue;
      }
      if (tag === "style" && name === "media") {
        if (MEDIA_LIST.test(a.value) && !/url/i.test(a.value)) at.push(["media", a.value]);
        continue;
      }
      if (displayAttributeAllowed(tag, name)) at.push([name, a.value]);
      else stats.attributes++;
    }
    if (DISPLAY_CONTROLS.has(tag)) {
      if (!at.some(([k]) => k === "disabled")) at.push(["disabled", ""]);
      stats.controls++;
    }
    editAttr(n, tag, at);
    return at;
  };

  const stack = [];
  const pushKids = (n) => {
    const ks = kids(n);
    for (let i = ks.length - 1; i >= 0; i--) stack.push(ks[i]);
  };
  const html = kids(read.doc).find((x) => x.tagName === "html");
  let bodyDone = false;
  if (html) {
    w.open("html", attrsOf(html, "html"));
    stack.push(CLOSE);
    pushKids(html);
  } else {
    w.open("html", []);
    stack.push(CLOSE);
  }
  while (stack.length) {
    const n = stack.pop();
    if (n === CLOSE) {
      if (w.stack.length === 2 && !bodyDone) {
        // the html element closes: a page with no body (a frameset) gets an empty one
        w.open("body", []);
        w.close();
        bodyDone = true;
      }
      w.close();
      continue;
    }
    if (n === CSP) {
      w.open("meta", [["http-equiv", "Content-Security-Policy"], ["content", RENDER_CSP]]);
      continue;
    }
    if (n.nodeName === "#text") {
      w.text(n.value, n.__id);
      continue;
    }
    if (n.tagName === undefined) continue; // comments, the doctype: not in the copy
    const t = n.tagName;
    if (n.namespaceURI !== HTML_NS) {
      stats.foreign++;
      ph("graphic", n);
      continue;
    }
    const parentTag = w.stack[w.stack.length - 1].tag;
    if (t === "head") {
      w.open("head", attrsOf(n, "head"));
      stack.push(CLOSE);
      pushKids(n);
      stack.push(CSP);
      stats.elements++;
      continue;
    }
    if (t === "body") bodyDone = true;
    if (t === "script") continue; // counted above
    if (t === "noscript") stats.noscript++;
    else if (t === "template") stats.templates++;
    else if (FRAMES.has(t)) stats.frames++;
    if (t === "noscript" || t === "template" || FRAMES.has(t)) continue;
    if (DROP.has(t) || (VOID.has(t) && !displayElementAllowed(t) && t !== "link")) {
      stats.dropped++;
      continue;
    }
    if (t === "link") {
      const css = sheets.get(n);
      if (css) {
        w.open("style", n.__id !== undefined ? [["data-osk-id", String(n.__id)]] : []);
        w.text(css);
        w.close();
        stats.styles.kept++;
        stats.elements++;
      } else stats.dropped++;
      continue;
    }
    if (t === "style") {
      const css = stylesOn ? sheets.get(n) : null;
      if (css) {
        w.open("style", attrsOf(n, "style"));
        w.text(css);
        w.close();
        stats.styles.kept++;
        stats.elements++;
      }
      continue;
    }
    if (MEDIA.has(t)) {
      stats.media++;
      ph("media", n);
      continue;
    }
    if (t === "img" || (t === "input" && attr(n, "type")?.trim().toLowerCase() === "image")) {
      const src = attr(n, "src");
      if (t === "input") {
        stats.controls++;
        ph("image", n);
        continue;
      }
      if (src === null) {
        w.open("img", attrsOf(n, "img"));
        stats.elements++;
        continue;
      }
      const uri = image(src, []);
      if (!uri) {
        ph("image", n);
        continue;
      }
      w.open("img", [...attrsOf(n, "img"), ["src", uri]]);
      stats.elements++;
      continue;
    }
    let tag = t;
    if (t === "form") {
      stats.forms++;
      if (TABLE_CONTEXT.has(parentTag)) continue;
      tag = "div";
    } else if (RENAME[t]) {
      tag = RENAME[t];
      stats.renamed++;
    } else if (!displayElementAllowed(t)) {
      tag = "span"; // an element this does not know: its content shown, as a browser shows an unknown element's
      stats.renamed++;
    }
    stats.elements++;
    if (w.open(tag, attrsOf(n, tag))) {
      stack.push(CLOSE);
      if (t === "xmp" || t === "plaintext") {
        const s = kids(n).map((c) => c.value ?? "").join("");
        const id = kids(n).find((c) => c.nodeName === "#text")?.__id;
        w.text(s, id);
      } else pushKids(n);
    }
  }
  if (w.failed) return { plain: true, reason: w.failed };
  const copy = w.out.join("");
  // R2: the copy parsed again, as the frame parses it (scripting off: a frame that runs no script), must be the tree it was written from
  const again = htmlParser().parse(copy, { scriptingEnabled: false });
  if (serializeTree(again) !== copy) return { plain: true, reason: "reparse" };
  stats.bodyText = w.bodyText;
  return { bytes: Buffer.from(copy, "utf8"), texts: w.texts, stats };
}
const CSP = Symbol("csp");

const attr = (n, name) => n.attrs?.find((a) => a.name === name && !a.namespace)?.value ?? null;
const isStylesheet = (n) => {
  const rel = (attr(n, "rel") ?? "").toLowerCase().split(/[ \t\n\f\r]+/);
  return rel.includes("stylesheet") && !rel.includes("alternate");
};

/**
 * The plain text view (R2's fallback): the page's text units as headings and paragraphs of escaped text, in a minimal page with the same
 * CSP meta; each written from a unit gets that element's `data-osk-id`. Text nested in a unit already written is not written again.
 * Returns {bytes, texts, stats: {units, bodyText}}.
 */
export function plainCopy(read) {
  const w = new Writer();
  w.open("html", []);
  w.open("head", []);
  w.open("meta", [["http-equiv", "Content-Security-Policy"], ["content", RENDER_CSP]]);
  w.close();
  w.open("body", []);
  let end = -1;
  let units = 0;
  for (const u of read.units) {
    if (u.kind !== "text") continue;
    const el = u.node;
    if ((el.__fs ?? 0) < end) continue;
    end = el.__fe ?? 0;
    const text = read.flat.slice(el.__fs ?? 0, el.__fe ?? 0).trim().replace(/[\u0000\ud800-\udfff]/g, (c) => (c === "\u0000" ? "" : c));
    if (!text) continue;
    const tag = el.namespaceURI === HTML_NS && /^h[1-6]$/.test(el.tagName) ? el.tagName : "p";
    w.open(tag, u.nodeId !== null ? [["data-osk-id", String(u.nodeId)]] : []);
    w.text(safeText(text));
    w.close();
    units++;
  }
  w.close();
  w.close();
  return { bytes: Buffer.from(w.out.join(""), "utf8"), texts: w.texts, stats: { units, bodyText: w.bodyText } };
}
// lone surrogates cannot be written: each becomes U+FFFD (a paired one is kept)
const safeText = (s) => s.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "\ufffd");
