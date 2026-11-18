import fs from "node:fs";
import "./html-parser.js"; // an HTML file's versions are compared here too: the parser lives in worker threads only
import { compareBytes } from "./history.js";

// Run by src/worker-host.js. One message back: a result per job, in order. A version that cannot be read or parsed fails its own job only.
export function work(data) {
  const bytes = new Map(); // blob path -> Buffer, so a version shared by two pairs is read (and parsed) once
  const read = (f) => bytes.get(f) || (bytes.set(f, fs.readFileSync(f)), bytes.get(f));
  return data.jobs.map((j) => {
    try {
      return { ok: true, result: compareBytes(j.format, read(j.before), read(j.after), { places: j.places }) };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  });
}
