import fs from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import { compareBytes } from "./history.js";

// One message back: a result per job, in order. A version that cannot be read or parsed fails its own job only.
const bytes = new Map(); // blob path -> Buffer, so a version shared by two pairs is read (and parsed) once
const read = (f) => bytes.get(f) || (bytes.set(f, fs.readFileSync(f)), bytes.get(f));
parentPort.postMessage(
  workerData.jobs.map((j) => {
    try {
      return { ok: true, result: compareBytes(j.format, read(j.before), read(j.after), { places: j.places }) };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  })
);
