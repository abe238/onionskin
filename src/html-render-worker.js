import "./html-parser.js"; // this worker reads HTML files: the parser lives here, never on the server's thread
import { editableTextIds, editIdentities, readHtml } from "./html.js";
import { makeAssetReader, plainCopy, renderCopy } from "./html-render.js";

// The render copy of one version of an HTML file (src/offload.js renderOffThread, PLAN-html R12), run by src/worker-host.js within a
// time and memory limit: the file read again, the copy built (local images and stylesheets read here, src/html-render.js), and when the
// copy does not survive its own re-parse (R2), the plain text view instead. `job` = {bytes, fileDir}. Answers {ok: true, plain, reason,
// bytes, texts, stats, editable, ident} or {ok: false, error, code, copyable}. `bytes` is the copy (UTF-8), for the page to set as `srcdoc` once;
// `editable` the source text nodes the person may type in (src/html.js editableTextIds), `ident` their identities (editIdentities).
// `plain: true` in the job: the plain copy only (the page asks for it after its view stopped responding, R6).
export function work({ bytes, fileDir, plain = false }) {
  try {
    const read = readHtml(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    let r = plain ? null : renderCopy(read, { fileDir, readAsset: makeAssetReader(), editable: true });
    let reason = plain ? "asked" : null;
    if (!r || r.plain) {
      reason = r ? r.reason : reason;
      r = plainCopy(read);
    }
    const editable = editableTextIds(read);
    return { ok: true, plain: reason !== null, reason, bytes: new Uint8Array(r.bytes.buffer, r.bytes.byteOffset, r.bytes.byteLength), texts: r.texts, stats: r.stats, editable, ident: editIdentities(read, editable) };
  } catch (err) {
    return { ok: false, code: typeof err?.code === "string" ? err.code : null, copyable: err?.copyable === true, error: String(err?.message || err).slice(0, 200) };
  }
}
