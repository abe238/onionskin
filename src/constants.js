// The product name and CLI binary name live here only. Rename by editing this file (and package.json "bin").
export const PRODUCT = {
  name: "Onionskin",
  bin: "onionskin",
  stateDirName: ".onionskin",
  envPrefix: "ONIONSKIN",
};


export const SERVER_PROTOCOL = 15; // 2: session.stage, reply, compact polls, /cli/batch-file, stop ends waiting polls; 3: question cards (/api/answer, results "asked"); 4: quick, review and suggestion routes, local history kind, merge in every format (/api/merge edits, /cli/agent-write ops), /api/export-tracked; 5: "Build my voice guide" (/api/voice/build, /api/voice/draft/discard, done takes voice_draft); 6: an agent Onionskin started is bound to its file on every /cli/* route, /cli/batch and /cli/batch-file check the lease first (a CLI never trusts an older server to do that); 7: HTML files (.html, .htm open; /api/html-view; Send takes htmlEdits); 8: Markdown files (.md, .markdown open; the page reads /api/file and renders it; one op, replace_source, by exact range, old text and base sha256; the batch carries untrusted_document_evidence.markdown; no page bytes, merges or raw commits for them); 9: a Markdown Send takes the person's typed edit as one exact splice, mdEdit {from, to, old, new, sha256}, checked like an agent's replacement and written before the batch (409 version_changed, 422, 423 locked; the page's edits list is ignored for Markdown); a Markdown write is accepted only from the delivered batch's base or a version this run wrote; ops in a comment's reply must replace that comment's range; a Markdown anchor names its revision (location.rev, from the X-Revision header of /api/file) and is valid only on that exact revision; one Markdown write per batch; reply_with "decline"; 10: protocol 9 existed in two incompatible development forms, so this is 10: a Markdown batch, write and Revert are bound to the session revision (not only the sha256), places on a draft are not kept, reply_with "decline" accepts only a decline, a no-op replacement is never applied, user_edits[].already_in_file may be false for a superseded Markdown edit; 11: one Send can hold the person's edit and comments made on the edited text (a page anchor may carry draftSha, the sha256 of the bytes its Send writes; only that Send binds it, to the revision its write makes); 12: a Markdown revision is the server's record of the file (sha256 and its identity on disk: device, inode, size, mtime), named by an opaque id (X-Revision, location.rev, mdEdit.rev are strings now); every Markdown write and Revert checks the record right before replacing the bytes; 13: a draft-made comment carries draftId and mdEdit carries the draft id it writes; a Markdown write has three outcomes (agent-write answers outcome, the session view carries mdSave, done answers outcomes per comment); 14: a Markdown page anchor carries `source`, the exact source captured with the selection (no place unless the text at its range is still that); the session view carries mdSaves per tab instead of mdSave; done outcomes give each card's final state (reopened drafts marked); 15: a Markdown page anchor carries `evidence` instead of `source` (sha256 over its identity, offsets and exact source; checked at Send, draft binding, queued delivery and resolve); duplicate comment ids in one request are refused (duplicate_comment_id); a Markdown write has a fourth outcome, "state_unconfirmed" (published, but its record could not be kept)
export const FORMATS = {
  docx: { main: "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml", part: "/word/document.xml" },
  xlsx: { main: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml", part: "/xl/workbook.xml" },
  pptx: { main: "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml", part: "/ppt/presentation.xml" },
  // not a zip package: src/package.js validatePackage checks its encoding (src/html.js decodeHtml); the open worker reads it whole
  html: { main: null, part: null, zip: false },
  // not a zip package either: src/package.js validatePackage checks it is UTF-8 (src/markdown-file.js decodeMarkdown); src/markdown.js reads it
  markdown: { main: null, part: null, zip: false },
};
export const REFUSED_EXTENSIONS = new Set([".docm", ".xlsm", ".pptm"]);
/**
 * Kinds of web file Onionskin refuses with a fixed sentence (PLAN-html D8, R15), by extension. Checked before the format: these are
 * close to .html but not pages Onionskin can edit by splices.
 */
export const REFUSED_PAGES = {
  ".mhtml": "Onionskin cannot open this kind of saved page; in Chrome choose Save As, Webpage, Complete.",
  ".mht": "Onionskin cannot open this kind of saved page; in Chrome choose Save As, Webpage, Complete.",
  ".webarchive": "Onionskin cannot open this kind of saved page; in Chrome choose Save As, Webpage, Complete.",
  ".xhtml": "Onionskin cannot open .xhtml pages; save the page as .html and open that.",
  ".svg": "Onionskin cannot open .svg pictures; it opens .html and .htm pages.",
};
/** The format of a file by its extension (".htm" is "html", ".md" and ".markdown" are "markdown"), or null when Onionskin does not open that kind of file. */
export function formatOfExt(ext) {
  const e = String(ext).toLowerCase();
  if (e === ".htm" || e === ".html") return "html";
  if (e === ".md" || e === ".markdown") return "markdown";
  const f = e.slice(1);
  return Object.hasOwn(FORMATS, f) ? f : null;
}
/** The sentence for a file Onionskin does not open: a refused page kind, or the list of what it opens. */
export const ONLY_FORMATS = "Only .docx, .xlsx, .pptx, .html, .htm, .md and .markdown files are supported";
/**
 * The end of every per-format dispatch chain: a format the chain does not know throws here, so it never runs another format's code (a
 * web page read as a deck). `where` names the chain. The message holds at most 20 characters of the value.
 */
export function unknownFormat(format, where) {
  throw new Error(`unknown format ${JSON.stringify(String(format).slice(0, 20))} in ${where}`);
}
/** `table[format]` of a per-format table, or unknownFormat (own keys only: "constructor" is not a format). */
export const byFormat = (table, format, where) => (Object.hasOwn(table, format) ? table[format] : unknownFormat(format, where));
/** The kind of the entry that ends a list of the page's edits cut short (src/session.js editKinds): more were made than it holds. */
export const EDITS_OVERFLOW = "edits.overflow";
export const env = (suffix, fallback) => process.env[`${PRODUCT.envPrefix}_${suffix}`] ?? fallback;

/** The largest document that is opened, sent, written or checked. Enforced by size BEFORE the bytes are read. */
export const MAX_DOC_BYTES = 200 * 1024 * 1024;
