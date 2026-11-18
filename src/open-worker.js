import { env } from "./constants.js";
import { sha256 } from "./fsutil.js";
import { validatePackage } from "./package.js";
import { readAll, readUnits } from "./anchors.js";
import "./html-parser.js"; // an HTML file is read whole here too: the parser lives in worker threads only
import { HtmlEncodingError } from "./html.js";

// The first reading of a file being opened (src/offload.js readOffThread), run by src/worker-host.js: the package check and every part the
// server later reads (paragraphs, every sheet, every slide), so a damaged or hostile file is refused here, on this thread, within a time
// and memory limit. ONIONSKIN_TEST_OPEN_DELAY_MS (tests only) blocks this thread for that long, the way a slow parse would.
export function work({ bytes: raw, format }) {
  const delay = Number(env("TEST_OPEN_DELAY_MS", 0));
  if (delay > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
  const bytes = Buffer.from(raw);
  let stage = "invalid";
  try {
    validatePackage(bytes, format);
    stage = "unreadable";
    // every slide and every sheet in one reading, as a review or an agent's outline reads them: the caps count over all of them
    readAll(readUnits(format, bytes));
    return { ok: true, sha: sha256(bytes) };
  } catch (err) {
    // an HTML file not saved as UTF-8 (PLAN-html R10): its fixed sentence and whether a UTF-8 copy can be made, never mangled
    if (err instanceof HtmlEncodingError) return { ok: false, stage: "encoding", error: err.message, code: err.code, copyable: err.copyable };
    return { ok: false, stage, error: String(err?.message || err) };
  }
}
