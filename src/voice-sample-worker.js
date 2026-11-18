import fs from "node:fs";
import { unknownFormat } from "./constants.js";
import { readDocxParagraphs } from "./docx.js";
import { validatePackage } from "./package.js";
import { parseDeck } from "./pptx.js";
import { agentTexts, sampleDocx, samplePptx, sampleText } from "./voice-samples.js";

/**
 * The parse step of "Build my voice guide": bytes in, samples out (src/voice-samples.js). Pure over its input apart from reading the
 * stored version blobs named in `open.agentPairs`. Every Office file is checked as a package first (validatePackage: the main part's
 * content type, openZip's size and expansion limits) and a macro-enabled one is refused. Excel files are not used as writing samples.
 *
 * Input: {open?: {format, bytes, agentPairs: [{before, after}] (snapshot blob paths)}, files: [{format, bytes}], texts: [string], shares}.
 * `format` is "docx", "pptx" or "text" (a .txt or .md file, UTF-8); `shares` is one number for every source or a list, one per source in
 * the order open, files, texts. Returns {sources: [{format, total, sampled, paragraphs}]} in that order. Throws a SampleError naming the
 * source (its index in that order) and a fixed code: "format", "macro" or "unreadable". No file name or path is ever in the output.
 */
export class SampleError extends Error {
  constructor(index, code) {
    super(`source ${index}: ${code}`);
    this.index = index;
    this.code = code;
  }
}

const MACRO_PART = /(^|\/)vbaProject\.bin$/i;

function office(bytes, format, index) {
  let zip;
  try {
    zip = validatePackage(bytes, format);
  } catch (err) {
    throw new SampleError(index, /macro/i.test(String(err?.message)) ? "macro" : "unreadable");
  }
  if (zip.names.some((n) => MACRO_PART.test(n))) throw new SampleError(index, "macro");
}

export const textsOf = (format, bytes) => {
  if (format === "docx") return readDocxParagraphs(bytes).map((p) => p.text);
  if (format !== "pptx") return unknownFormat(format, "textsOf");
  const deck = parseDeck(bytes);
  deck.ensure();
  return deck.slides.flatMap((s) => [s.title, ...(s.shapes || []).map((sh) => sh.text)]);
};

// a Buffer posted to a worker arrives as a plain Uint8Array: the parsers want a Buffer
const asBuffer = (b) => (Buffer.isBuffer(b) ? b : b instanceof Uint8Array ? Buffer.from(b.buffer, b.byteOffset, b.byteLength) : b);

function sampleOne({ format, bytes: raw }, share, index, exclude = null) {
  const bytes = asBuffer(raw);
  try {
    if (format === "docx") {
      office(bytes, format, index);
      return { format, ...sampleDocx(readDocxParagraphs(bytes, { detail: true }), share, { exclude }) };
    }
    if (format === "pptx") {
      office(bytes, format, index);
      return { format, ...samplePptx(parseDeck(bytes), share, { exclude }) };
    }
    if (format === "text") return { format, ...sampleText(new TextDecoder("utf-8", { fatal: true }).decode(bytes), share) };
  } catch (err) {
    throw err instanceof SampleError ? err : new SampleError(index, "unreadable");
  }
  throw new SampleError(index, "format");
}

export function sampleSources({ open = null, files = [], texts = [], shares = 0 } = {}) {
  const shareOf = (i) => (Array.isArray(shares) ? shares[i] : shares);
  const sources = [];
  if (open) {
    // a version pair that cannot be read (pruned, broken) just adds nothing to what is left out
    const pairs = [];
    for (const p of open.agentPairs || []) {
      try {
        pairs.push({ before: textsOf(open.format, fs.readFileSync(p.before)), after: textsOf(open.format, fs.readFileSync(p.after)) });
      } catch {}
    }
    sources.push(sampleOne(open, shareOf(0), 0, agentTexts(pairs)));
  }
  for (const f of files) sources.push(sampleOne(f, shareOf(sources.length), sources.length));
  for (const t of texts) {
    if (typeof t !== "string") throw new SampleError(sources.length, "format");
    sources.push({ format: "text", ...sampleText(t, shareOf(sources.length)) });
  }
  return { sources };
}

// Run in a worker thread by src/worker-host.js, with a timeout in the caller. One message back: {ok: true, sources} or
// {ok: false, index, code}. Anything else that goes wrong is {ok: false, index: -1, code: "unreadable"}.
export function work(data) {
  try {
    return { ok: true, ...sampleSources(data) };
  } catch (err) {
    return err instanceof SampleError ? { ok: false, index: err.index, code: err.code } : { ok: false, index: -1, code: "unreadable" };
  }
}
