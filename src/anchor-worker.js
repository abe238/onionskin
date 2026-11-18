import { anchorWork } from "./anchor-work.js";
import "./html-parser.js"; // this worker reads HTML files: the parser lives here, never on the server's thread
import { env } from "./constants.js";
import { checkRegularOwned, readDoc, sha256 } from "./fsutil.js";

// The server's anchor worker (src/offload.js anchorsOffThread), run by src/worker-host.js and kept warm: it answers job after job, each
// on a version of a file, and keeps the last reading (src/anchors.js unitsFor), so an ordinary Send reads the file once. A job is
// {id, job: {format, source: {bytes} | {path, sha?}, check, tasks, outline}}; the answer {id, ok: true, sha, r} (src/anchor-work.js) |
// {id, ok: false, error}. A `path` is read here (a regular file the user owns), never on the server's thread; a `sha` it must have.
// The budget is ten times the server's own (src/session.js SCAN_BUDGET): all of it took 0.4 s (50 hashes of a cell of 31 million "é")
// to 1.3 s (500 anchors in a paragraph of decomposed letters) of CPU here, at a load average of 20. The time limit around this thread is what
// bounds the work, and ordinary large ranges (fifty of 1,000 x 20 cells of 30-character labels) all keep their hash.
// ONIONSKIN_TEST_ANCHOR_DELAY_MS (tests only) blocks this thread for that long first, the way a slow job would.
export const WORKER_BUDGET = 400_000_000;

function source({ bytes, path, sha }) {
  if (bytes) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  checkRegularOwned(path);
  const b = readDoc(path);
  if (sha && sha256(b) !== sha) throw Object.assign(new Error("the file is not the version asked for"), { stale: true });
  return b;
}

export function serve(port) {
  port.on("message", ({ id, job }) => {
    const delay = Number(env("TEST_ANCHOR_DELAY_MS", 0));
    if (delay > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
    let answer;
    try {
      const bytes = source(job.source);
      const sha = job.source.sha || sha256(bytes);
      answer = { id, ok: true, sha, r: anchorWork({ ...job, bytes, sha, validate: !!job.source.bytes, budget: WORKER_BUDGET }) };
    } catch (err) {
      answer = { id, ok: false, stale: !!err?.stale, error: String(err?.message || err).slice(0, 200) };
    }
    port.postMessage(answer);
  });
}
