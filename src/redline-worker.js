import fs from "node:fs";
import { buildTracked } from "./redline.js";
import { verifyTracked } from "./redline-check.js";
import { env } from "./constants.js";
import { openZip } from "./zip.js";
import { replaceEntry } from "./zip-write.js";

// One tracked-changes copy, off the server thread (run by src/worker-host.js): build it (src/redline.js), then check it (src/redline-check.js). One message back:
// {ok: true, bytes, counts} | {refused: [codes]} | {check_failed: why}. The copy's bytes only leave this worker after the check passed.
// ONIONSKIN_TEST_TAMPER_EXPORT=drop-del (tests only) removes one deletion from the built copy before the check, to prove the check is
// what stands between the builder and the disk; it can only make a copy fail, never pass.
export function work({ before, after, author, date }) {
  try {
    const b = fs.readFileSync(before);
    const a = fs.readFileSync(after);
    const r = buildTracked({ before: b, after: a, author, date });
    if (r.refused) return { refused: r.refused };
    let out = r.bytes;
    if (env("TEST_TAMPER_EXPORT", "") === "drop-del") out = replaceEntry(out, "word/document.xml", openZip(out).readText("word/document.xml").replace(/<w:del [^>]*>[\s\S]*?<\/w:del>/, ""));
    const v = verifyTracked({ before: b, after: a, out, counts: r.counts, author, date });
    return v.ok ? { ok: true, bytes: out, counts: r.counts } : { check_failed: v.why };
  } catch (err) {
    return { check_failed: `the copy could not be made: ${String(err?.message || err).slice(0, 200)}` };
  }
}
