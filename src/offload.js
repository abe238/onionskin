import { Worker } from "node:worker_threads";
import { env } from "./constants.js";

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
    const worker = new Worker(new URL("./check-worker.js", import.meta.url), { workerData: { pre, post, format, deferSoffice } });
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
