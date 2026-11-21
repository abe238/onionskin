import { Worker } from "node:worker_threads";
import { env } from "./constants.js";
import { STOPPING } from "./stop-gate.js";

/**
 * A worker thread running src/<name>'s work(workerData) through src/worker-host.js. Its terminate() waits until the worker has loaded its
 * modules (they are evaluated asynchronously, and stopping a worker then aborts the whole process on Node 26), then marks the worker as
 * being stopped and waits for the zlib call it may be inside to end (stopping it inside zlib aborts the process too: src/stop-gate.js),
 * then stops it; a worker that exits first is not waited for. The wait is the module loading and one zlib call at most, never the work.
 */
export function startWorker(name, { workerData, ...opts } = {}) {
  const loaded = new SharedArrayBuffer(8);
  const flag = new Int32Array(loaded);
  const worker = new Worker(new URL("./worker-host.js", import.meta.url), { ...opts, workerData: { data: workerData, loaded }, argv: [name] });
  let exited = false;
  let onExit = null;
  worker.once("exit", () => {
    exited = true;
    onExit?.();
  });
  const stop = worker.terminate.bind(worker);
  let stopping = null;
  worker.terminate = () =>
    (stopping ??= new Promise((resolve) => {
      let marked = false;
      let timer = null;
      const done = () => {
        clearTimeout(timer);
        onExit = null;
        resolve();
      };
      onExit = done;
      const deadline = Date.now() + 10_000;
      const tryStop = () => {
        if (exited) return done();
        if (Atomics.load(flag, 0) === 1) {
          marked = true;
          // from here on the worker enters no zlib call; it may still be inside one
          if ((Atomics.or(flag, 1, STOPPING) & ~STOPPING) === 0) return stop().then(done, done);
        }
        if (Date.now() >= deadline) return stop().then(done, done);
        timer = setTimeout(tryStop, marked ? 2 : 10);
        timer.unref?.();
      };
      worker.ref?.();
      tryStop();
    }));
  return worker;
}

const WORKER_TIMEOUT_MS = () => Number(env("CHECK_TIMEOUT_MS", 180_000)) + 60_000;

/**
 * Runs the `done` analysis in a worker thread: parsing a large package and the deeper check (a blocking spawn) must not stop the server from
 * answering status, poll, the browser's events and other sessions. Resolves to {postSha, batchId, flags, checks, changes}; a worker that fails,
 * crashes or exceeds the timeout resolves to a stated failure (never to "clean") and is terminated.
 * `inputs` = {pre, post, format, postSha, batchId, deferSoffice}.
 */
export function analyzeOffThread(inputs) {
  const { pre, post, format, postSha, batchId, deferSoffice } = inputs;
  const failed = (why) => ({
    postSha, batchId, changes: null,
    flags: [{ code: "checks_failed", severity: "warn", detail: why }],
    checks: { node: "failed", deep: { status: "skipped", reason: why }, notice: `The package checks did not finish: ${why}. The file was not verified.` },
  });
  return new Promise((resolve) => {
    let settled = false;
    const worker = startWorker("check-worker.js", { workerData: { pre, post, format, deferSoffice } });
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      resolve(r);
    };
    const timer = setTimeout(() => finish(failed(`timed out after ${Math.round(WORKER_TIMEOUT_MS() / 1000)}s`)), WORKER_TIMEOUT_MS());
    worker.once("message", (m) => finish(m.ok ? { postSha, batchId, flags: m.flags, checks: m.checks, changes: m.changes } : failed(m.error)));
    worker.once("error", (err) => finish(failed(String(err?.message || err))));
    worker.once("exit", (code) => finish(failed(`the check worker exited (${code})`)));
  });
}

const OPEN_TIMEOUT_MS = () => Number(env("OPEN_TIMEOUT_MS", 60_000));
// The open worker's heap: the largest documents the readers accept (their element, paragraph, shape and cell caps) took up to about
// 550 MB. ONIONSKIN_OPEN_HEAP_MB lowers it in tests.
const OPEN_HEAP_MB = () => Number(env("OPEN_HEAP_MB", 1536));

// At most OPEN_AT_ONCE open readings run at a time (each may use up to OPEN_HEAP_MB); the rest wait their turn, at most OPEN_WAIT_MS each
// and OPEN_QUEUE of them, then get "busy". So the worst wait for an answer is OPEN_WAIT_MS + the open time limit (the CLI waits longer).
const OPEN_AT_ONCE = 2;
const OPEN_QUEUE = 16;
export const OPEN_WAIT_MS = 60_000;
let running = 0;
const waiting = [];
function nextOpen() {
  while (running < OPEN_AT_ONCE && waiting.length) {
    const w = waiting.shift();
    clearTimeout(w.timer);
    running++;
    w.go();
  }
}

/**
 * Reads a file being opened in a worker thread (src/open-worker.js): the package check and every part the server reads later, so a slow or
 * hostile file stalls only that thread. Resolves to {ok: true, sha} or {ok: false, stage, error}: stage "invalid" (not a package of this
 * format), "unreadable" (a reader refused it, a cap included), "timeout", "memory" or "busy" (too many files are being opened at once);
 * any other worker failure is "unreadable". Never rejects.
 */
export function readOffThread(bytes, format) {
  return new Promise((resolve) => {
    const busy = { ok: false, stage: "busy", error: `${OPEN_AT_ONCE} files are being read already` };
    if (waiting.length >= OPEN_QUEUE) return resolve(busy);
    const w = {
      go: () =>
        readNow(bytes, format).then((r) => {
          running--;
          nextOpen();
          resolve(r);
        }),
      timer: setTimeout(() => {
        waiting.splice(waiting.indexOf(w), 1);
        resolve(busy);
      }, OPEN_WAIT_MS),
    };
    w.timer.unref?.();
    waiting.push(w);
    nextOpen();
  });
}

function readNow(bytes, format) {
  return new Promise((resolve) => {
    let settled = false;
    let worker;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker?.terminate();
      resolve(r);
    };
    const ms = OPEN_TIMEOUT_MS();
    const secs = Math.max(1, Math.round(ms / 1000));
    const timer = setTimeout(() => finish({ ok: false, stage: "timeout", error: `reading it took longer than ${secs} second${secs === 1 ? "" : "s"}` }), ms);
    try {
      worker = startWorker("open-worker.js", { workerData: { bytes, format }, resourceLimits: { maxOldGenerationSizeMb: OPEN_HEAP_MB() } });
    } catch (err) {
      return finish({ ok: false, stage: "unreadable", error: String(err?.message || err) });
    }
    worker.once("message", finish);
    worker.once("error", (err) => finish(err?.code === "ERR_WORKER_OUT_OF_MEMORY" ? { ok: false, stage: "memory", error: "reading it needs more memory than Onionskin allows" } : { ok: false, stage: "unreadable", error: String(err?.message || err) }));
    worker.once("exit", (code) => finish({ ok: false, stage: "unreadable", error: `the reading worker exited (${code})` }));
  });
}

// The merge of what the person typed while the agent worked (src/merge-worker.js). The time limit: the longest merge at the readers'
// caps measured here, a workbook of 1,000,000 cells (three versions read, the agent's run checked again, the plan and the engine's
// run), took 14 to 15 s at a load average of 20 (e2e/stall-cap.e2e.test.js), so 120 s leaves room for a slower or busier Mac. The heap:
// that merge needed more than 1,024 MB and less than 1,536 MB; 2,048 MB. ONIONSKIN_MERGE_TIMEOUT_MS and _MERGE_HEAP_MB set them.
// At most MERGE_AT_ONCE run at a time; another is refused as busy (the page keeps the person's edits and says so).
const MERGE_TIMEOUT_MS = () => Number(env("MERGE_TIMEOUT_MS", 120_000));
const MERGE_HEAP_MB = () => Number(env("MERGE_HEAP_MB", 2048));
const MERGE_AT_ONCE = 2;
let merging = 0;

/**
 * Runs one merge in a worker thread with a time and memory limit, so a large or crafted document never holds the server's thread.
 * `job` = {format, base, mine, theirs, name, edits, agent}. Resolves to what the worker answered ({ok: true, ...} | {cap} | {invalid} |
 * {error}), or {failed: "timeout" | "memory" | "busy" | "crashed", why}. Never rejects.
 */
export function mergeOffThread(job) {
  return new Promise((resolve) => {
    if (merging >= MERGE_AT_ONCE) return resolve({ failed: "busy", why: `${MERGE_AT_ONCE} merges are running already` });
    merging++;
    let settled = false;
    let worker;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      merging--;
      clearTimeout(timer);
      worker?.terminate();
      resolve(r);
    };
    const ms = MERGE_TIMEOUT_MS();
    const secs = Math.max(1, Math.round(ms / 1000));
    const timer = setTimeout(() => finish({ failed: "timeout", why: `it took longer than ${secs} second${secs === 1 ? "" : "s"}` }), ms);
    try {
      worker = startWorker("merge-worker.js", { workerData: job, resourceLimits: { maxOldGenerationSizeMb: MERGE_HEAP_MB() } });
    } catch (err) {
      return finish({ failed: "crashed", why: String(err?.message || err) });
    }
    worker.once("message", finish);
    worker.once("error", (err) => finish(err?.code === "ERR_WORKER_OUT_OF_MEMORY" ? { failed: "memory", why: "it needs more memory than Onionskin allows" } : { failed: "crashed", why: String(err?.message || err).slice(0, 200) }));
    worker.once("exit", (code) => finish({ failed: "crashed", why: `the merge worker exited (${code})` }));
  });
}

// The engine's work for a quick change (src/ops-worker.js): the preview's count, the plan's count and the change itself. Time limit: a
// count over a document at the readers' caps (8 million characters, 4 million matches) took about 2 s here, the engine's open included,
// and a change of every match a few times that; 120 s leaves room for a slower or busier Mac. Heap: as a merge. ONIONSKIN_OPS_TIMEOUT_MS
// and _OPS_HEAP_MB set them. At most OPS_AT_ONCE run at a time; another is answered as busy (a preview is then not shown, a change is
// left to the agent).
const OPS_TIMEOUT_MS = () => Number(env("OPS_TIMEOUT_MS", 120_000));
const OPS_HEAP_MB = () => Number(env("OPS_HEAP_MB", 2048));
const OPS_AT_ONCE = 2;
let opsRunning = 0;

/**
 * Runs `job` ({kind: "preview", bytes, format, op, name} | {kind: "run", bytes, format, name, ops, partial, anchors: [[k, v]]}) in a
 * worker thread. Resolves to what the worker answered ({ok: true, p} | {ok: true, r}) or {failed: "timeout" | "memory" | "busy" |
 * "crashed", why}. Never rejects.
 */
export function opsOffThread(job) {
  return new Promise((resolve) => {
    if (opsRunning >= OPS_AT_ONCE) return resolve({ failed: "busy", why: `${OPS_AT_ONCE} changes are being counted or made already` });
    opsRunning++;
    let settled = false;
    let worker;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      opsRunning--;
      clearTimeout(timer);
      worker?.terminate();
      resolve(r);
    };
    const ms = OPS_TIMEOUT_MS();
    const secs = Math.max(1, Math.round(ms / 1000));
    const timer = setTimeout(() => finish({ failed: "timeout", why: `it took longer than ${secs} second${secs === 1 ? "" : "s"}` }), ms);
    try {
      worker = startWorker("ops-worker.js", { workerData: job, resourceLimits: { maxOldGenerationSizeMb: OPS_HEAP_MB() } });
    } catch (err) {
      return finish({ failed: "crashed", why: String(err?.message || err).slice(0, 200) });
    }
    worker.once("message", finish);
    worker.once("error", (err) => finish(err?.code === "ERR_WORKER_OUT_OF_MEMORY" ? { failed: "memory", why: "it needs more memory than Onionskin allows" } : { failed: "crashed", why: String(err?.message || err).slice(0, 200) }));
    worker.once("exit", (code) => finish({ failed: "crashed", why: `the worker exited (${code})` }));
  });
}

// The render copy of an HTML file (src/html-render-worker.js, PLAN-html R12). Time limit: a page at the HTML limits (9.2 MB, 198,000
// elements, 30 MB of images) took 2.6 s in this worker, its reading included, at a load average of 17 (test/html-render-limits.test.js);
// 60 s leaves room for a slower or busier Mac. Heap: 1 GB, the HTML limit (R22; at most two trees alive). ONIONSKIN_RENDER_TIMEOUT_MS and _RENDER_HEAP_MB set them. At most
// RENDER_AT_ONCE run at a time; another is answered as busy.
const RENDER_TIMEOUT_MS = () => Number(env("RENDER_TIMEOUT_MS", 60_000));
const RENDER_HEAP_MB = () => Number(env("RENDER_HEAP_MB", 1024));
const RENDER_AT_ONCE = 2;
let rendering = 0;

/**
 * Builds the render copy of `bytes` (one version of an HTML file in folder `fileDir`, the folder of its real path) in a worker thread.
 * Resolves to {ok: true, plain, reason, bytes (Buffer), texts, stats}, {ok: false, code, error} (the file was refused: a limit, its
 * encoding) or {failed: "timeout" | "memory" | "busy" | "crashed", why}. Never rejects.
 */
export function renderOffThread({ bytes, fileDir, plain = false }) {
  return new Promise((resolve) => {
    if (rendering >= RENDER_AT_ONCE) return resolve({ failed: "busy", why: `${RENDER_AT_ONCE} pages are being prepared already` });
    rendering++;
    let settled = false;
    let worker;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      rendering--;
      clearTimeout(timer);
      worker?.terminate();
      resolve(r?.ok && r.bytes ? { ...r, bytes: Buffer.from(r.bytes.buffer, r.bytes.byteOffset, r.bytes.byteLength) } : r);
    };
    const ms = RENDER_TIMEOUT_MS();
    const secs = Math.max(1, Math.round(ms / 1000));
    const timer = setTimeout(() => finish({ failed: "timeout", why: `it took longer than ${secs} second${secs === 1 ? "" : "s"}` }), ms);
    try {
      worker = startWorker("html-render-worker.js", { workerData: { bytes, fileDir, plain }, resourceLimits: { maxOldGenerationSizeMb: RENDER_HEAP_MB() } });
    } catch (err) {
      return finish({ failed: "crashed", why: String(err?.message || err).slice(0, 200) });
    }
    worker.once("message", finish);
    worker.once("error", (err) => finish(err?.code === "ERR_WORKER_OUT_OF_MEMORY" ? { failed: "memory", why: "it needs more memory than Onionskin allows" } : { failed: "crashed", why: String(err?.message || err).slice(0, 200) }));
    worker.once("exit", (code) => finish({ failed: "crashed", why: `the worker exited (${code})` }));
  });
}

/** previewAll (src/ops/run.js) in the ops worker: its answer, or a thrown Error when the worker did not finish (nothing was counted). */
export async function previewOffThread(bytes, format, op) {
  const r = await opsOffThread({ kind: "preview", bytes, format, op, name: `preview.${format}` });
  if (!r.ok) throw new Error(`the count did not finish: ${r.why}`);
  return r.p;
}

/**
 * runOps (src/ops/run.js) in the ops worker, with its answer's shape. A worker that does not finish writes nothing: every op reads
 * not_applied with the reason, and there are no bytes.
 */
export async function runOpsOffThread({ bytes, format, name, ops, partial = false, anchors = new Map() }) {
  const r = await opsOffThread({ kind: "run", bytes, format, name, ops, partial, anchors: [...anchors] });
  if (r.ok) return { ...r.r, bytes: r.r.bytes ? Buffer.from(r.r.bytes.buffer, r.r.bytes.byteOffset, r.r.bytes.byteLength) : null };
  const reason = `the change did not finish: ${r.why}; nothing was written`;
  return { results: ops.map((op, index) => ({ index, op: op.op, ...(op.id ? { id: op.id } : {}), status: "not_applied", reason })), bytes: null, warnings: [], blocked: null };
}

// ---- anchors: the document reading and anchor work of a request (src/anchor-work.js) -----------------------------------------
// Warm workers (src/anchor-worker.js), each one job at a time: at most ANCHOR_POOL at once, so two requests for different documents (or
// a crafted one and an ordinary one) never wait for each other; a request past them waits its turn within its own time limit, at most
// ANCHOR_QUEUE of them, then is answered "busy". A worker that runs past its time limit, runs out of memory or crashes is stopped and
// replaced; the request it held is answered as failed, and its caller makes its comments weaker the way a spent budget does (never an
// error that loses one). One worker stays warm; the others stop after ANCHOR_IDLE_MS idle, with the reading they keep.
// Time limit: a reading at the readers' caps took under 1 s (docs/GUIDE.md "Size limits"; the open worker allows 60 s); the work after it is bounded by the
// worker's budget (all of it: 0.4 to 1.3 s of CPU here). ONIONSKIN_ANCHOR_TIMEOUT_MS and _ANCHOR_HEAP_MB set them.
const ANCHOR_TIMEOUT_MS = () => Number(env("ANCHOR_TIMEOUT_MS", 60_000));
/** The anchor worker's time limit for one job, in ms (src/session.js settled bounds a page load's wait by it). */
export const anchorTimeoutMs = ANCHOR_TIMEOUT_MS;
const ANCHOR_HEAP_MB = () => Number(env("ANCHOR_HEAP_MB", 2048));
const ANCHOR_POOL = 3;
const ANCHOR_QUEUE = 16;
const ANCHOR_IDLE_MS = 60_000;
const anchorPool = []; // {worker, job: the one in progress or null, sha: of the version it read last, idle: timer}
const anchorWaiting = [];
let anchorIds = 0;

function anchorWorker() {
  const w = { worker: startWorker("anchor-worker.js", { resourceLimits: { maxOldGenerationSizeMb: ANCHOR_HEAP_MB() } }), job: null, sha: null, idle: null };
  w.worker.unref(); // a warm worker never keeps the process alive
  const fail = (failed, why) => {
    const i = anchorPool.indexOf(w);
    if (i >= 0) anchorPool.splice(i, 1);
    w.dead = true;
    clearTimeout(w.idle);
    w.job?.finish({ failed, why });
    w.worker.terminate();
    nextAnchor();
  };
  w.worker.on("message", (m) => {
    if (!w.job || m?.id !== w.job.id) return;
    if (m.ok) w.sha = m.sha;
    w.job.finish(m.ok ? { ok: true, sha: m.sha, r: m.r } : { failed: m.stale ? "stale" : "crashed", why: m.error });
  });
  w.worker.on("error", (err) => fail(err?.code === "ERR_WORKER_OUT_OF_MEMORY" ? "memory" : "crashed", String(err?.message || err).slice(0, 200)));
  w.worker.on("exit", (code) => fail("crashed", `the anchor worker exited (${code})`));
  w.fail = fail;
  anchorPool.push(w);
  return w;
}

function runAnchor(w, job) {
  clearTimeout(w.idle);
  w.job = job;
  job.onDone = () => {
    w.job = null;
    if (w.dead) return;
    if (anchorPool.filter((x) => !x.dead).length > 1) {
      w.idle = setTimeout(() => !w.job && w.fail("idle", "idle"), ANCHOR_IDLE_MS);
      w.idle.unref?.();
    }
    nextAnchor();
  };
  const msg = { id: job.id, job: job.data };
  try {
    w.worker.postMessage(msg);
  } catch (err) {
    w.fail("crashed", String(err?.message || err).slice(0, 200));
  }
}

function nextAnchor() {
  while (anchorWaiting.length) {
    const job = anchorWaiting[0];
    const idle = anchorPool.filter((w) => !w.job && !w.dead);
    const w = idle.find((x) => x.sha && x.sha === job.data.source.sha) || idle[0] || (anchorPool.length < ANCHOR_POOL ? anchorWorker() : null);
    if (!w) return;
    anchorWaiting.shift();
    runAnchor(w, job);
  }
}

/**
 * src/anchor-work.js anchorWork in a warm worker. `data` = {format, source: {bytes} | {path, sha?}, check, tasks, outline}. Resolves to
 * {ok: true, sha, r} or {failed: "timeout" | "memory" | "busy" | "crashed" | "stale", why}. Never rejects. A job that times out stops its
 * worker (the next job gets a fresh one).
 */
export function anchorsOffThread(data) {
  return new Promise((resolve) => {
    if (anchorWaiting.length >= ANCHOR_QUEUE) return resolve({ failed: "busy", why: `${ANCHOR_QUEUE} requests are waiting already` });
    const job = { id: ++anchorIds, data, settled: false };
    const ms = ANCHOR_TIMEOUT_MS();
    const timer = setTimeout(() => {
      const i = anchorWaiting.indexOf(job);
      if (i >= 0) {
        anchorWaiting.splice(i, 1);
        return job.finish({ failed: "busy", why: "the other requests did not finish in time" });
      }
      const w = anchorPool.find((x) => x.job === job);
      if (w) w.fail("timeout", `it took longer than ${Math.max(1, Math.round(ms / 1000))} s`);
      else job.finish({ failed: "timeout", why: "timed out" });
    }, ms);
    job.finish = (r) => {
      if (job.settled) return;
      job.settled = true;
      clearTimeout(timer);
      resolve(r);
      job.onDone?.();
    };
    anchorWaiting.push(job);
    nextAnchor();
  });
}

/** Starts the warm anchor worker ahead of the first request (the server calls it at start), so a first Send does not wait for its start. */
export function warmAnchors() {
  if (!anchorPool.length) anchorWorker();
}

// ---- the write check of an HTML file (src/html-write-worker.js) -------------------------------------------------------------------
// One parse of each version and an inventory of each: about 1.5 s of worker CPU at the limits (10 MB, 200,000 elements), with at most
// two trees alive (about 600 MB). Time limit and heap as the ops worker's (ONIONSKIN_OPS_TIMEOUT_MS, _OPS_HEAP_MB). At most HTML_AT_ONCE
// at a time; another is answered as busy, and the write is refused (nothing is written unchecked).
const HTML_AT_ONCE = 2;
let htmlRunning = 0;

/**
 * src/html-write.js checkedHtmlWrite in a worker thread: `job` = {before, after, edits?} (bytes; edits [{nodeId, text}]). Resolves to its
 * answer, with `bytes` as a Buffer: {ok: true, bytes, charset_added, links} | {ok: false, code, reason, reasons?}; a worker that does not
 * finish resolves to {ok: false, code: "check_failed", reason}. Never rejects.
 */
export function htmlWriteOffThread(job) {
  return new Promise((resolve) => {
    const failed = (why) => ({ ok: false, code: "check_failed", reason: `the write check did not finish: ${why}; nothing was written` });
    if (htmlRunning >= HTML_AT_ONCE) return resolve(failed(`${HTML_AT_ONCE} checks are running already`));
    htmlRunning++;
    let settled = false;
    let worker;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      htmlRunning--;
      clearTimeout(timer);
      worker?.terminate();
      resolve(r?.ok && r.bytes ? { ...r, bytes: Buffer.from(r.bytes.buffer, r.bytes.byteOffset, r.bytes.byteLength) } : r);
    };
    const ms = OPS_TIMEOUT_MS();
    const timer = setTimeout(() => finish(failed(`it took longer than ${Math.max(1, Math.round(ms / 1000))} s`)), ms);
    try {
      worker = startWorker("html-write-worker.js", { workerData: job, resourceLimits: { maxOldGenerationSizeMb: OPS_HEAP_MB() } });
    } catch (err) {
      return finish(failed(String(err?.message || err).slice(0, 200)));
    }
    worker.once("message", finish);
    worker.once("error", (err) => finish(failed(err?.code === "ERR_WORKER_OUT_OF_MEMORY" ? "it needed more memory than Onionskin allows" : String(err?.message || err).slice(0, 200))));
    worker.once("exit", (code) => finish(failed(`the worker exited (${code})`)));
  });
}
