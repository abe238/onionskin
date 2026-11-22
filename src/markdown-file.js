import crypto from "node:crypto";
import { MD_LIMITS, MD_NOT_UTF8, applyReplacements, offsetAllowed, readMarkdown } from "./markdown.js";
import { untrusted } from "./sanitize.js";

// A Markdown file on the server's side: its bytes as text (valid UTF-8 only), the one way an agent changes it (exact replacements against
// one base, src/ops/markdown.js and src/session.js agentWrite both run checkReplacements), and what a batch tells the agent about it
// (heading outline, blocks with their exact source). src/markdown.js is the reader both the server and the page use.

const DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }); // ignoreBOM: a BOM stays in the text (src/markdown.js reads it)

/** The sentence for a .md file that is not valid UTF-8 (src/markdown.js, so the page says it in the same words). */
export const NOT_UTF8 = MD_NOT_UTF8;

/** A refusal of a Markdown file or write, with a plain sentence and a `code`. */
export class MarkdownError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/** The text of a Markdown file's bytes (a BOM stays as U+FEFF), or a MarkdownError: not UTF-8, or past MD_LIMITS.bytes (checked before decoding). */
export function decodeMarkdown(bytes) {
  // a sentence of its own (`onionskin open` and the page show it as it is), so it starts with a capital and ends with a period
  if (bytes.length > MD_LIMITS.bytes) throw new MarkdownError(`This Markdown file is ${bytes.length.toLocaleString("en-US")} bytes, more than the ${MD_LIMITS.bytes.toLocaleString("en-US")} bytes (1 MB) Onionskin can read. Split it into smaller files and open those.`, "too_large");
  try {
    return DECODER.decode(bytes);
  } catch {
    throw new MarkdownError(NOT_UTF8, "not_utf8");
  }
}

/** The file read: {text (with any BOM), tree (src/markdown.js readMarkdown: CapError past MD_LIMITS), sha (sha256 of the bytes)}. */
export function readMarkdownFile(bytes) {
  const text = decodeMarkdown(bytes);
  return { text, tree: readMarkdown(text), sha: crypto.createHash("sha256").update(bytes).digest("hex") };
}

/** A replacement whose new text is its old text changes nothing: it is not applied, written or counted as a change (it never makes a comment Done). */
export const NO_CHANGE = "the new text is the same as the old text, so nothing changes there; to answer without a change, decline the comment with a note";

/** What a stale reply is told: nothing was written, and polling again while this batch is held brings nothing new. */
export const STALE_BASE = "the file is not the revision this batch was made on (expect.sha256 is not the batch's base_sha256 or not the file's sha256 now), so nothing was written. Decline the comments it affects, say why in their notes, and run done; the person sends again on the new version";

/** The protected block a range [from, to) touches ("the front matter"), or null. A range that only meets its edge does not touch it. */
export function protectedAt(tree, from, to) {
  for (const b of tree.blocks) {
    if (!b.protected) continue;
    if (from < b.to && to > b.from) return b.what === "frontmatter" ? "the front matter" : "a protected block";
    if (from === to && from >= b.from && from < b.to) return b.what === "frontmatter" ? "the front matter" : "a protected block";
  }
  return null;
}

/**
 * Checks one replace_source op against the base the reply was made on: {ok: true, rep: {from, to, old, new}} or {ok: false, status, code,
 * reason}. The rules, in order: the op's base (expect.sha256) is the file's sha256 now; the range lies in the file and both ends are on
 * character and run boundaries (src/markdown.js offsetAllowed); the source there is exactly expect.source (in full: never cleaned, cut or
 * searched for); the new text is whole characters. Pure.
 */
export function checkOne(file, op, { person = false } = {}) {
  const bad = (status, code, reason) => ({ ok: false, status, code, reason });
  if (op?.op !== "replace_source") return bad("refused", "not_for_markdown", `${op?.op} does not apply to a Markdown file: use replace_source (an exact range, its old text and the new text)`);
  const t = op.target || {};
  const e = op.expect || {};
  if (e.sha256 !== file.sha) return bad("expect_mismatch", "stale_base", STALE_BASE);
  const { from, to } = t;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > file.tree.length) return bad("refused", "bad_range", `the range ${from} to ${to} is not inside this file (its text is ${file.tree.length} characters long, counted after any BOM)`);
  if (!offsetAllowed(file.tree, from) || !offsetAllowed(file.tree, to)) return bad("refused", "not_a_boundary", "an end of the range falls inside one character or inside a mark that stands for several characters (an escape, an entity, a line break); widen the range to the whole of it");
  const prot = person ? null : protectedAt(file.tree, from, to); // the person may edit front matter; a reply never does
  if (prot) return bad("refused", "protected", `the range ${from} to ${to} touches ${prot}, which the batch marks protected: true. It is never changed by a reply; decline the comment`);
  const old = file.tree.text.slice(from, to);
  if (typeof e.source !== "string" || old !== e.source) return bad("expect_mismatch", "old_text_differs", `the file's text from ${from} to ${to} is not expect.source exactly; copy it from the batch (untrusted_document_evidence.markdown.blocks or the anchor's locator.source)`);
  if (typeof op.text !== "string" || !op.text.isWellFormed()) return bad("refused", "broken_text", "the new text holds a broken character (a lone surrogate)");
  return { ok: true, rep: { from, to, old, new: op.text } };
}

/**
 * The file's bytes with `reps` (checked by checkOne against this same base) applied together, at once, through applyReplacements: offsets
 * are the base's, so an earlier replacement never moves a later one; overlapping ranges refuse the whole set. Everything outside the
 * ranges (a BOM, every line ending, the final newline) is the same bytes. Returns {ok: true, bytes} or {ok: false, code, reason}.
 */
export function applyAll(file, reps, { person = false } = {}) {
  let out;
  try {
    out = applyReplacements(file.text, reps);
  } catch (err) {
    return { ok: false, code: err.code === "overlap" ? "overlap" : err.code || "invalid", reason: err.code === "overlap" ? "two replacements of this reply overlap or start at the same place, so none was written; send them as one replacement" : String(err.message) };
  }
  // the byte order mark stays as it was: a replacement may not start a BOM-less file with U+FEFF (the next reading would take it for a
  // BOM and every offset after it would move by one), and none removes an existing one (it is outside every range)
  if ((out.charCodeAt(0) === 0xfeff) !== (file.text.charCodeAt(0) === 0xfeff)) return { ok: false, code: "bom", reason: "the file would start with a byte order mark (U+FEFF) it does not have; remove that character from the start of the new text" };
  const bytes = Buffer.from(out, "utf8");
  let after;
  try {
    after = readMarkdown(decodeMarkdown(bytes)); // the result within MD_LIMITS, as the next reading of the file needs it
  } catch (err) {
    return { ok: false, code: "too_large", reason: `the file after these replacements cannot be read: ${String(err.message).slice(0, 200)}` };
  }
  // protected front matter must still be read as the same front matter after an agent's replacements (an append right after its closing
  // "---" would join that line and end the front matter: refused). The person may edit their own front matter
  if (!person) {
    const fm = (t) => {
      const b = t.blocks.find((x) => x.protected);
      return b ? t.text.slice(b.from, b.to).replace(/(\r\n|\r|\n)$/, "") : null; // its last line ending may be added after it
    };
    const before = fm(file.tree);
    if (before !== null && fm(after) !== before) return { ok: false, code: "protected", reason: "these replacements would change or end the front matter, which a reply never changes; start an addition after it with a new line" };
  }
  return { ok: true, bytes, reps: reps.map((r) => ({ from: r.from, to: r.to, len: r.new.length })) };
}

/**
 * What an agent's write of a Markdown file must be (src/session.js agentWrite): the bytes rebuilt from the disk bytes and the ops it says
 * it ran, every op checked against that one base. Returns {ok: true, bytes} or {ok: false, code, reason}.
 */
export function rebuild(diskBytes, ops) {
  let file;
  try {
    file = readMarkdownFile(diskBytes);
  } catch (err) {
    return { ok: false, code: err.code || "unreadable", reason: String(err.message).slice(0, 300) };
  }
  if (!Array.isArray(ops) || !ops.length) return { ok: false, code: "no_ops", reason: "a Markdown file is written only by replace_source ops" };
  const reps = [];
  for (const op of ops) {
    const c = checkOne(file, op);
    if (!c.ok) return { ok: false, code: c.code, reason: c.reason };
    if (c.rep.old === c.rep.new) return { ok: false, code: "no_change", reason: NO_CHANGE }; // never evidence that anything was done
    reps.push(c.rep);
  }
  return applyAll(file, reps);
}

// ---- the batch: what the agent reads about the file --------------------------------------------------------------------------------
/** The anchors' exact source in the stored batch: one at most this long (longer: the agent reads the blocks or the file), all at most SOURCE_TOTAL. */
export const SOURCE_MAX = 100_000;
export const SOURCE_TOTAL = 2_000_000;
/** The blocks' source a delivered batch carries inline, in all (a 1 MB file would make one poll's output too long for an agent's shell). */
export const BLOCKS_INLINE_MAX = 200_000;

const LABEL = { paragraph: "paragraph", heading: "heading", code: "code block", table: "table", literal: "shown as written", hr: "rule" };
/** Leaf blocks in source order, each with the containers around it ("quote", "list item"). */
function leaves(tree) {
  const out = [];
  const walk = (blocks, path) => {
    for (const b of blocks) {
      if (b.type === "blank") continue;
      if (b.type === "quote") walk(b.children, [...path, "quote"]);
      else if (b.type === "list") for (const it of b.items) walk(it.children, [...path, b.ordered ? "numbered item" : "list item"]);
      else out.push({ b, path });
    }
  };
  walk(tree.blocks, []);
  return out;
}
/** The 1-based line of source offset o (counting LF, CRLF and lone CR). */
function lineOf(text, o) {
  let line = 1;
  for (let i = 0; i < o; i++) {
    const c = text.charCodeAt(i);
    if (c === 10 || (c === 13 && text.charCodeAt(i + 1) !== 10)) line++;
  }
  return line;
}

/** The label of the leaf block that holds source offset o ("paragraph, line 12"), for an anchor's label. */
export function labelAt(tree, from) {
  const hit = leaves(tree).find(({ b }) => b.from <= from && from < b.to) || null;
  const what = hit ? [...hit.path, hit.b.type === "heading" ? `heading ${hit.b.level}` : LABEL[hit.b.type] || hit.b.type].join(", ") : "text";
  return `${what}, line ${lineOf(tree.text, from)}`;
}

/** Display text of a leaf block's inline nodes (headings in the outline). */
const shownText = (nodes) => nodes.map((x) => (x.type === "run" ? x.display : shownText(x.children || []))).join("");

/**
 * untrusted_document_evidence.markdown of a batch: the base it was made on, the heading outline (display text cleaned, exact ranges) and
 * the ordered leaf blocks with their EXACT source and range (never cleaned: an agent copies `source` into expect.source), as much of it as
 * fits BLOCKS_INLINE_MAX; `blocks_more` counts the rest, which the agent reads from the file itself (same offsets: UTF-16, after any BOM).
 */
export function markdownEvidence(file) {
  const outline = [];
  const blocks = [];
  let total = 0;
  let more = 0;
  for (const { b, path } of leaves(file.tree)) {
    if (b.type === "heading") outline.push({ level: b.level, text: untrusted(shownText(b.inline), 200), from: b.from, to: b.to });
    const source = file.tree.text.slice(b.from, b.to);
    if (more || total + source.length > BLOCKS_INLINE_MAX) {
      more++;
      continue;
    }
    total += source.length;
    blocks.push({ id: `u${blocks.length + 1}`, type: b.type, label: [...path, b.type === "heading" ? `heading ${b.level}` : LABEL[b.type] || b.type].join(", "), from: b.from, to: b.to, source, ...(b.protected ? { protected: true } : {}) });
  }
  return {
    base_sha256: file.sha,
    offsets: "UTF-16 code units of the file's text after any BOM, half-open [from, to)",
    outline,
    blocks,
    ...(more ? { blocks_more: more, blocks_note: "More blocks than one batch shows. Change only text whose exact source this batch carries; decline comments on the rest and say the file is too long to show whole." } : {}),
  };
}
