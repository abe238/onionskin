import fs from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import { buildTracked } from "./redline.js";
import { verifyTracked } from "./redline-check.js";
import { env } from "./constants.js";
import { openZip } from "./zip.js";
import { replaceEntry } from "./zip-write.js";

// One tracked-changes copy, off the server thread: build it (src/redline.js), then check it (src/redline-check.js). One message back:
// {ok: true, bytes, counts} | {refused: [codes]} | {check_failed: why}. The copy's bytes only leave this worker after the check passed.
// ONIONSKIN_TEST_TAMPER_EXPORT=drop-del (tests only) removes one deletion from the built copy before the check, to prove the check is
// what stands between the builder and the disk; it can only make a copy fail, never pass.
const { before, after, author, date } = workerData;
let msg;
try {
  const b = fs.readFileSync(before);
  const a = fs.readFileSync(after);
  const r = buildTracked({ before: b, after: a, author, date });
  if (r.refused) msg = { refused: r.refused };
  else {
    let out = r.bytes;
    if (env("TEST_TAMPER_EXPORT", "") === "drop-del") out = replaceEntry(out, "word/document.xml", openZip(out).readText("word/document.xml").replace(/<w:del [^>]*>[\s\S]*?<\/w:del>/, ""));
    const v = verifyTracked({ before: b, after: a, out, counts: r.counts, author, date });
    msg = v.ok ? { ok: true, bytes: out, counts: r.counts } : { check_failed: v.why };
  }
} catch (err) {
  msg = { check_failed: `the copy could not be made: ${String(err?.message || err).slice(0, 200)}` };
}
parentPort.postMessage(msg);
