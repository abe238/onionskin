import { parentPort, workerData } from "node:worker_threads";
import { analyze } from "./analyze.js";

try {
  parentPort.postMessage({ ok: true, ...analyze(Buffer.from(workerData.pre), Buffer.from(workerData.post), workerData.format, { deferSoffice: !!workerData.deferSoffice }) });
} catch (err) {
  parentPort.postMessage({ ok: false, error: String(err?.message || err) });
}
