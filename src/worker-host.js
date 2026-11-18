// The entry of every worker thread the server starts (src/offload.js startWorker). It imports node builtins only, so its own evaluation is
// synchronous; it then loads the named worker module dynamically, marks `loaded`, runs the module's work(data) and posts what it returns.
// Why: the worker modules import src/docx.js, which awaits at its top level. Terminating a worker while a module is still being evaluated
// asynchronously aborts the whole server process on Node 26 ("Check failed: !is_null()", exit 133), and a worker whose job ran inside its
// module's evaluation was in that state for the whole job. startWorker's terminate() waits for `loaded` (the imports took tens of ms),
// so a worker is only ever stopped while it runs plain code. It also hands the zlib gate its word (src/stop-gate.js): stopping a worker
// inside zlib aborts the process too. test/worker-terminate.test.js stops each worker at many points.
import { parentPort, workerData } from "node:worker_threads";
import { setStopGate } from "./stop-gate.js";

const WORKERS = new Set(["check-worker.js", "history-worker.js", "redline-worker.js", "voice-worker.js", "voice-sample-worker.js", "open-worker.js", "merge-worker.js", "ops-worker.js", "anchor-worker.js", "html-write-worker.js", "html-render-worker.js"]);
const name = process.argv[2];
if (!WORKERS.has(name)) throw new Error(`unknown worker ${JSON.stringify(String(name)).slice(0, 60)}`);
const { data, loaded } = workerData;
setStopGate(new Int32Array(loaded)); // index 0: loaded, index 1: the zlib gate
// No top-level await here, in it or in src/stop-gate.js (that would make this module's evaluation asynchronous again). A failed import or a throw from work() is an
// unhandled rejection, which ends the worker with an "error" event its caller already handles; so is a rejected promise from work().
// A module that exports serve(port) is kept warm instead (src/anchor-worker.js): it answers each message it is sent, itself.
import(new URL(`./${name}`, import.meta.url).href).then((m) => {
  Atomics.store(new Int32Array(loaded), 0, 1);
  if (typeof m.serve === "function") return m.serve(parentPort, data);
  return Promise.resolve(m.work(data)).then((r) => parentPort.postMessage(r)); // a value, or a promise of one (the merge worker's engine is asynchronous)
});
