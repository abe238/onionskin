import "./html-parser.js"; // an HTML file is read again at `done` (src/package.js htmlChecks): the parser lives in worker threads only
import { analyze } from "./analyze.js";

/** The `done` analysis (src/offload.js analyzeOffThread), run by src/worker-host.js. One message back: {ok, flags, checks, changes} or {ok: false, error}. */
export function work(data) {
  try {
    return { ok: true, ...analyze(Buffer.from(data.pre), Buffer.from(data.post), data.format, { deferSoffice: !!data.deferSoffice }) };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}
