import "./html-parser.js";
import { checkedHtmlWrite } from "./html-write.js";

// The write check of an HTML file (src/html-write.js checkedHtmlWrite) off the server's thread (src/offload.js htmlWriteOffThread), within
// a time and memory limit: an agent's whole new version (/cli/agent-write, /cli/commit, a standalone commit) and, from Phase 2a, the
// person's own text edits. One message back: checkedHtmlWrite's answer, or {ok: false, code: "check_failed"} when it threw.
export function work({ before, after, edits }) {
  const b = (x) => (x ? Buffer.from(x.buffer, x.byteOffset, x.byteLength) : null);
  try {
    return checkedHtmlWrite(b(before), b(after), edits ? { edits } : {});
  } catch (err) {
    return { ok: false, code: "check_failed", reason: `the write check failed: ${String(err?.message || err).slice(0, 200)}` };
  }
}
