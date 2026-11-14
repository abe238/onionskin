import path from "node:path";
import { FORMATS } from "./constants.js";
import { openZip, ZipError } from "./zip.js";
import { walkXml } from "./xml.js";
import { runDeepCheck } from "./checker.js";
import { cleanFlag } from "./sanitize.js";

const MAX_TYPES_BYTES = 4 * 1024 * 1024; // [Content_Types].xml of a real document is a few KB
// Cumulative work of the relationship scan: a hostile archive can hold thousands of individually allowed .rels parts.
const MAX_RELS_PARTS = 5000;
const MAX_RELS_BYTES = 64 * 1024 * 1024;

/** Throws unless `bytes` is an OOXML ZIP whose main part content type matches `format`. Returns the opened zip. */
export function validatePackage(bytes, format) {
  const want = FORMATS[format];
  if (!want) throw new ZipError(`unsupported format: ${format}`);
  const zip = openZip(bytes);
  const ct = zip.readText("[Content_Types].xml", MAX_TYPES_BYTES);
  if (ct == null) throw new ZipError("missing [Content_Types].xml");
  let found = false;
  walkXml(ct, {
    onOpen(name, attrs) {
      if (name === "Override" && attrs.PartName === want.part) {
        if (/macroEnabled/i.test(attrs.ContentType || "")) throw new ZipError("macro-enabled documents are refused");
        if (attrs.ContentType === want.main) found = true;
      }
    },
  });
  if (!found) throw new ZipError(`content types do not describe a .${format} main part`);
  return zip;
}

function relTargets(zip) {
  const missing = [];
  let parts = 0;
  let bytes = 0;
  for (const name of zip.names) {
    if (!name.endsWith(".rels")) continue;
    if (++parts > MAX_RELS_PARTS) throw new ZipError(`too many relationship parts (more than ${MAX_RELS_PARTS})`);
    const xml = zip.readText(name);
    if (xml == null) continue;
    bytes += xml.length;
    if (bytes > MAX_RELS_BYTES) throw new ZipError("the relationship parts are too large in total");
    const srcDir = path.posix.dirname(path.posix.dirname(name)); // word/_rels/x.rels -> word
    const base = srcDir === "." ? "" : srcDir;
    walkXml(xml, {
      onOpen(tag, attrs) {
        if (tag !== "Relationship" || attrs.TargetMode === "External" || !attrs.Target) return;
        const target = attrs.Target.startsWith("/") ? attrs.Target.slice(1) : path.posix.normalize(path.posix.join(base, attrs.Target));
        const clean = target.split("#")[0];
        if (clean && !zip.entries.has(clean)) missing.push({ rels: name, target: clean });
      },
    });
  }
  return missing;
}

const DOCX_COUNTED = ["w:drawing", "w:fldChar", "w:sdt", "m:oMath", "w:hyperlink", "w:bookmarkStart"];

function countElements(xml, names) {
  const counts = Object.fromEntries(names.map((n) => [n, 0]));
  walkXml(xml, {
    onOpen(name) {
      if (name in counts) counts[name]++;
    },
  });
  return counts;
}

const SEVERITY = { invalid_package: "error", part_removed: "error", relationship_target_missing: "error", count_decreased: "warn", part_added: "info", slide_removed: "warn" };

/** The relationships of one part: [{id, type (the last segment of the type URI), target (a part path, or the URL when external), external}]. */
export function partRels(zip, part) {
  const out = [];
  const xml = zip.readText(part.replace(/([^/]+)$/, "_rels/$1.rels"));
  if (xml == null) return out;
  const base = path.posix.dirname(part);
  walkXml(xml, {
    onOpen(tag, a) {
      if (tag !== "Relationship" || !a.Type || !a.Target) return;
      const external = a.TargetMode === "External";
      const target = external ? a.Target : a.Target.startsWith("/") ? a.Target.slice(1) : path.posix.normalize(path.posix.join(base === "." ? "" : base, a.Target.split("#")[0]));
      out.push({ id: a.Id, type: a.Type.split("/").pop(), target, external });
    },
  });
  return out;
}

/** p:sldId id -> slide part, in the order of ppt/presentation.xml; empty when it cannot be read (then nothing counts as a deleted slide). */
function slideParts(zip) {
  const rels = new Map(partRels(zip, "ppt/presentation.xml").map((r) => [r.id, r.target]));
  const out = new Map();
  for (const [tag] of (zip.readText("ppt/presentation.xml") || "").matchAll(/<(?:\w+:)?sldId\b[^>]*>/g)) {
    const id = /\sid="(\d+)"/.exec(tag)?.[1];
    const rid = /\sr:id="([^"]+)"/.exec(tag)?.[1];
    if (id && rels.has(rid)) out.set(id, rels.get(rid));
  }
  return out;
}

/**
 * The parts of the slides a deck lost: each slide (by its p:sldId id) the presentation listed before and does not list after, its own notes
 * slide and comments, and the .rels of all of them. Gone from the package, they are reported as `slide_removed` (a warning: a slide is gone,
 * as asked or not), not as lost parts (an error, which recommends Revert).
 * A later added slide may get the same part name (the engine takes the first free one): that part is then a different slide, and the deep
 * check's comparison of its old and new content means nothing.
 */
function removedSlideParts(pre, post) {
  const out = new Set();
  const after = slideParts(post);
  const add = (part) => (out.add(part), out.add(part.replace(/([^/]+)$/, "_rels/$1.rels")));
  for (const [id, part] of slideParts(pre)) {
    if (after.has(id)) continue;
    add(part);
    for (const x of partRels(pre, part)) if (!x.external && (x.type === "notesSlide" || x.type === "comments")) add(x.target);
  }
  return out;
}

const relKey = (m) => `${m.rels}\0${m.target}`;

/** The checks before cleaning: flag values are still the document's own strings (checkPackages dedupes on them, then cleans). */
function rawNodeChecks(preBytes, postBytes, format) {
  const flags = [];
  let post;
  try {
    post = validatePackage(postBytes, format);
  } catch (err) {
    return [{ code: "invalid_package", severity: "error", detail: err.message }];
  }
  try {
    return scanDifferences(openZip(preBytes), post, format, flags);
  } catch (err) {
    if (!(err instanceof ZipError)) throw err;
    // a budget or limit hit while scanning: stated, never read as clean
    return [{ code: "invalid_package", severity: "error", detail: `the package checks stopped: ${err.message}` }];
  }
}

function scanDifferences(pre, post, format, flags) {
  const gone = format === "pptx" ? removedSlideParts(pre, post) : new Set();
  for (const n of pre.names) if (!post.entries.has(n)) flags.push({ code: gone.has(n) ? "slide_removed" : "part_removed", part: n });
  for (const n of post.names) if (!pre.entries.has(n)) flags.push({ code: "part_added", part: n });
  // differential: a relationship already dangling in the input is not the agent's damage
  const preMissing = new Set(relTargets(pre).map(relKey));
  for (const m of relTargets(post)) if (!preMissing.has(relKey(m))) flags.push({ code: "relationship_target_missing", ...m });
  if (format === "docx") {
    const a = countElements(pre.readText("word/document.xml") || "", DOCX_COUNTED);
    const b = countElements(post.readText("word/document.xml") || "", DOCX_COUNTED);
    for (const k of DOCX_COUNTED) if (b[k] < a[k]) flags.push({ code: "count_decreased", element: k, before: a[k], after: b[k] });
  }
  return flags.map((f) => ({ ...f, severity: SEVERITY[f.code] || "warn" }));
}

/** The Node-only checks (always available): part list, relationship targets, element counts. Each flag carries a severity and is cleaned. */
export function nodeChecks(preBytes, postBytes, format) {
  return rawNodeChecks(preBytes, postBytes, format).map(cleanFlag);
}

/** The one sentence about the deeper check. A LibreOffice check still running is "pending", never "passed". */
export const deepNotice = (skipped = [], pending = false) =>
  `Deeper check ran${skipped.length ? `; skipped: ${skipped.map((x) => `${x.check} (${x.reason})`).join(", ")}` : ""}${pending ? "; the LibreOffice conversion check is still running (pending), the Activity list updates when it finishes" : ""}.`;

const flagKey = (f) => JSON.stringify([f.code, f.part, f.element, f.rels, f.target, f.id]);

/**
 * Node checks plus the deeper Python/LibreOffice check when a Python with lxml is available.
 * Returns {flags, checks}: `flags` are findings (severity info/warn/error); `checks` says what ran, so a skipped deep check is never silent.
 */
export function checkPackages(preBytes, postBytes, format, opts = {}) {
  const node = rawNodeChecks(preBytes, postBytes, format);
  if (node.some((f) => f.code === "invalid_package")) return { flags: node.map(cleanFlag), checks: { node: "ran", deep: { status: "skipped", reason: "the package is invalid" } } };
  const deep = runDeepCheck(preBytes, postBytes, format, { deferSoffice: !!opts.deferSoffice });
  // the deep check counts per part; its numbers replace the coarse whole-document counts
  const base = deep.ran ? node.filter((f) => f.code !== "count_decreased") : node;
  // the deep check compares parts by name: a deleted slide's parts are lost parts to it, and a slide added later under a freed name is the
  // deleted one with fewer elements. Both are the slide delete the node check already told apart; any other finding on such a part stays.
  const gone = format === "pptx" ? removedSlideParts(openZip(preBytes), openZip(postBytes)) : new Set();
  const deepFlags = deep.flags.filter((f) => !(gone.has(f.part) && f.code === "count_decreased")).map((f) => (f.code === "part_removed" && gone.has(f.part) ? { code: "slide_removed", severity: SEVERITY.slide_removed, part: f.part } : f));
  const seen = new Set();
  // dedupe on the raw values, then clean: cleaning first could merge distinct flags
  const flags = [...base, ...deepFlags].filter((f) => !seen.has(flagKey(f)) && seen.add(flagKey(f))).map(cleanFlag);
  const checks = {
    node: "ran",
    deep: deep.ran ? { status: "ran", checks: deep.checksRun, skipped: deep.skipped, ...(deep.sofficePending ? { soffice: "pending" } : {}) } : { status: "skipped", reason: deep.reason, code: deep.code },
  };
  checks.notice = deep.ran ? deepNotice(deep.skipped, deep.sofficePending) : `Deeper check skipped: ${deep.reason}. Only the built-in checks ran.`;
  return { flags, checks };
}
