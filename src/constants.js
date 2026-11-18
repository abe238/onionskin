// The product name and CLI binary name live here only. Rename by editing this file (and package.json "bin").
export const PRODUCT = {
  name: "Onionskin",
  bin: "onionskin",
  stateDirName: ".onionskin",
  envPrefix: "ONIONSKIN",
};


export const SERVER_PROTOCOL = 7; // 2: session.stage, reply, compact polls, /cli/batch-file, stop ends waiting polls; 3: question cards (/api/answer, results "asked"); 4: quick, review and suggestion routes, local history kind, merge in every format (/api/merge edits, /cli/agent-write ops), /api/export-tracked; 5: "Build my voice guide" (/api/voice/build, /api/voice/draft/discard, done takes voice_draft); 6: an agent Onionskin started is bound to its file on every /cli/* route, /cli/batch and /cli/batch-file check the lease first (a CLI never trusts an older server to do that); 7: HTML files (.html, .htm open; /api/html-view; Send takes htmlEdits)
export const FORMATS = {
  docx: { main: "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml", part: "/word/document.xml" },
  xlsx: { main: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml", part: "/xl/workbook.xml" },
  pptx: { main: "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml", part: "/ppt/presentation.xml" },
  // not a zip package: src/package.js validatePackage checks its encoding (src/html.js decodeHtml); the open worker reads it whole
  html: { main: null, part: null, zip: false },
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
/** The format of a file by its extension (".htm" is "html"), or null when Onionskin does not open that kind of file. */
export function formatOfExt(ext) {
  const e = String(ext).toLowerCase();
  if (e === ".htm" || e === ".html") return "html";
  const f = e.slice(1);
  return Object.hasOwn(FORMATS, f) ? f : null;
}
/** The sentence for a file Onionskin does not open: a refused page kind, or the list of what it opens. */
export const ONLY_FORMATS = "Only .docx, .xlsx, .pptx, .html and .htm files are supported";
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
