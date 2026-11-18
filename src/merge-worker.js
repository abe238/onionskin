import { byFormat, env } from "./constants.js";
import { readAll, readUnits } from "./anchors.js";
import { runOps } from "./ops/run.js";
import { CapError } from "./xml.js";
import { mergeDocx } from "./merge.js";
import { mergePptx } from "./merge-pptx.js";
import { mergeXlsx } from "./merge-xlsx.js";
import { handBack, prepareMerge, proveMerge } from "./merge-proof.js";

// The merge of what the person typed while the agent worked (src/session.js mergeUserEdits), off the server thread, run by
// src/worker-host.js within a time and memory limit (src/offload.js mergeOffThread): the three versions read whole within the readers'
// caps, then the plan and the engine's run (src/merge.js, src/merge-xlsx.js, src/merge-pptx.js). One message back:
// {ok: true, bytes, merged, unplaced, copy, stable} | {cap: why} (a version past a reader's cap) | {invalid: why} | {error: why} |
// {refused: why}: the proof of the merge (src/merge-proof.js) could not account for every edit of the person's in the result, so no
// result is returned and the caller keeps the person's edits (why: counts and kinds, never document text).
// ONIONSKIN_TEST_MERGE_DELAY_MS (tests only) blocks this thread for that long first, the way a slow merge would.
// imported here, not on demand: stopping a worker while a module is still being evaluated aborts the server (src/worker-host.js)
const MERGERS = { docx: mergeDocx, xlsx: mergeXlsx, pptx: mergePptx };

export async function work({ format, base, mine, theirs, name, edits, agent }) {
  const delay = Number(env("TEST_MERGE_DELAY_MS", 0));
  if (delay > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
  const [b, m, t] = [base, mine, theirs].map((x) => Buffer.from(x.buffer, x.byteOffset, x.byteLength));
  try {
    for (const bytes of [t, b, m]) readAll(readUnits(format, bytes));
  } catch (err) {
    return err instanceof CapError ? { cap: err.message } : { invalid: String(err?.message || err).slice(0, 200) };
  }
  try {
    const steps = Array.isArray(agent) ? agent.map((s) => (s.route === "apply" ? { ...s, from: Buffer.from(s.from), to: Buffer.from(s.to) } : s)) : null;
    const r = await mergeProven({ format, base: b, mine: m, theirs: t, name, edits, agent: steps });
    if (r.refused) return r;
    return { ...r, unplaced: r.unplaced.map(({ of, as, ...u }) => u) }; // the proof's refs and kinds stay here
  } catch (err) {
    return { error: String(err?.message || err).slice(0, 200) };
  }
}

/**
 * The merge and its proof, on this thread (`work` runs it in the merge worker): the planner and the engine's run, then what the person
 * changed of a kind no planner carries (a header, a picture, a shape's place, a cell's style: src/merge-proof.js handBack) handed back
 * with a copy of the person's file, then the proof of everything, from the bytes of the four versions alone. Returns {ok: true, bytes,
 * merged, unplaced (with the proof's refs `of` and kinds `as`), copy, stable} | {refused: why}. The tests of the merge call it as well.
 */
export async function mergeProven({ format, base, mine, theirs, name, edits = [], agent = null }) {
  const r = await byFormat(MERGERS, format, "mergeProven")({ base, mine, theirs, name, runOps, edits, agent });
  if (r.refuse) return { refused: r.refuse }; // the planner cannot tell what to carry (src/merge-xlsx.js: the page's list of edits was cut)
  // ONIONSKIN_TEST_MERGE_FORGET (tests only) drops the merge's list of what it handed back, the way a planner that loses an edit would
  if (env("TEST_MERGE_FORGET", "") === "1") r.unplaced = [];
  // a text handed back cut at the planners' 2,000 characters is whole only in a copy of the person's file (src/merge-proof.js holds)
  if (r.unplaced.some((u) => typeof u.text === "string" && u.text.length >= 2000)) r.copy = true;
  // every return path, a merge that wrote nothing as well: the result is the agent's file then
  const args = { base, mine, theirs, merged: r.bytes ?? theirs, read: r.read };
  const ctx = prepareMerge(format, args);
  const more = handBack(format, { ...args, ctx, unplaced: r.unplaced, copy: !!r.copy });
  if (more.length || more.copy) (r.unplaced = [...r.unplaced, ...more]), (r.copy = true);
  const why = proveMerge(format, { ...args, ctx, unplaced: r.unplaced, copy: !!r.copy });
  if (why) return { refused: why };
  return { ok: true, bytes: r.bytes ?? null, merged: r.merged, unplaced: r.unplaced, copy: !!r.copy, stable: r.stable ?? null };
}
