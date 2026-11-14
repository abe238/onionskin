import { nodeChecks } from "../package.js";
import * as docx from "./docx.js";
import * as pptx from "./pptx.js";
import * as xlsx from "./xlsx.js";

const DRIVERS = { docx, xlsx, pptx };
// ops whose job is to remove or rewrite content: a lower count of drawings/links/bookmarks is then expected, not damage
const REWRITES = new Set(["delete_paragraph", "set_table_cell_text", "set_shape_text", "delete_rows", "delete_columns", "delete_table_row", "delete_table_column", "delete_slide"]);
const BLOCKING = new Set(["invalid_package", "part_removed", "relationship_target_missing"]);

/** The package-check flags that stop a write. Fewer elements are fine only after a rewrite; a slide may only go when an op deleted one. */
export const blockingFlags = (flags, { rewrites, slideDeleted }) => flags.filter((f) => BLOCKING.has(f.code) || (f.code === "count_decreased" && !rewrites) || (f.code === "slide_removed" && !slideDeleted));

const shape = (i, op, r) => {
  const { ok, dirty, ...rest } = r; // `dirty` is the runner's own signal, not part of the report
  return { index: i, op: op.op, ...(op.id ? { id: op.id } : {}), ...rest };
};
/** Nothing reached disk: an op must not read `applied`. Keeps what the op did as `would_have` for the agent. */
export function demote(results, reason) {
  return results.map((r) => (r.status === "applied" ? { index: r.index, op: r.op, ...(r.id ? { id: r.id } : {}), status: "not_applied", reason, ...(r.detail ? { would_have: r.detail } : {}) } : r));
}
const notApplied = (i, op, why) => ({ index: i, op: op.op, ...(op.id ? { id: op.id } : {}), status: "not_applied", reason: why });

/**
 * Runs `ops` against `bytes`. Phase 1 binds every op (anchor + expect) against the untouched file; phase 2 executes in order.
 * The engine cannot roll back, so nothing is saved unless the set is acceptable: atomic mode stops at the first op that
 * does not apply; partial mode restarts from the original bytes without an op whose execution threw, then keeps the rest.
 * Returns {results, bytes (null = nothing to write), warnings, blocked}.
 */
export async function runOps({ bytes, format, name, ops, partial = false, anchors = new Map() }) {
  const driver = DRIVERS[format];
  const excluded = new Map();
  for (let pass = 0; pass <= ops.length; pass++) {
    const st = await driver.open({ bytes, name, anchors });
    try {
      const results = new Array(ops.length);
      const bound = new Array(ops.length);
      for (const [i, op] of ops.entries()) {
        if (excluded.has(i)) results[i] = shape(i, op, excluded.get(i));
        else {
          const b = await driver.bind(st, op);
          if (b.ok) bound[i] = b;
          else results[i] = shape(i, op, b);
        }
      }
      const bindFailed = results.some(Boolean);
      let stop = bindFailed && !partial;
      let restart = false;
      for (let i = 0; i < ops.length && !restart; i++) {
        if (!bound[i]) continue;
        if (stop) {
          results[i] = notApplied(i, ops[i], "atomic mode: another op did not apply, so nothing was written");
          continue;
        }
        const r = await driver.exec(st, bound[i]);
        // document-wide ops are COUNTED against the file as delivered (bind) but run after the earlier ops of this file: say so when that bites
        if (r.code === "incomplete_replace" && results.some((x) => x?.status === "applied")) r.reason += ". An earlier op of this file changed text this op matches: put document-wide ops (replace_all_text, format_all) first in the ops file";
        results[i] = shape(i, ops[i], r);
        if (r.status === "applied") continue;
        if (!partial) stop = true;
        else if (r.dirty) {
          excluded.set(i, r);
          restart = true;
        }
      }
      if (restart) continue;
      if (stop) {
        ops.forEach((op, i) => results[i] ||= notApplied(i, op, "atomic mode: another op did not apply, so nothing was written"));
        return { results: demote(results, "atomic mode: another op did not apply, so nothing was written"), bytes: null, warnings: [], blocked: null };
      }
      const applied = results.filter((r) => r.status === "applied").length;
      if (!applied) return { results, bytes: null, warnings: [], blocked: null };
      const out = await driver.save(st);
      // the writer is checked before anything leaves this function: a lossy save blocks the whole write
      const flags = nodeChecks(bytes, out, format);
      const rewrites = ops.some((op, i) => results[i].status === "applied" && (REWRITES.has(op.op) || (op.op === "replace_text" && "text" in op)));
      const slideDeleted = ops.some((op, i) => results[i].status === "applied" && op.op === "delete_slide");
      const blocking = blockingFlags(flags, { rewrites, slideDeleted });
      const warnings = flags.filter((f) => !blocking.includes(f));
      if (blocking.length) return { results: demote(results, "blocked by the package check: nothing was written"), bytes: null, warnings, blocked: blocking };
      return { results, bytes: out, warnings, blocked: null };
    } finally {
      driver.close(st);
    }
  }
  throw new Error("apply could not settle on a set of ops"); // unreachable: every restart excludes one op
}

/**
 * Read-only count for a document-wide op (replace_all_text, format_all), before anyone has confirmed a number.
 * Binds once with expect.count 0 and reads what was found; nothing is executed or saved.
 * Returns {ok:true, count, protected, partial_words?, in_formulas?} or {ok:false, status, reason, code?}.
 * `partial_words` (replace_all_text) is the number of matches that sit inside a longer word; `in_formulas` (XLSX) the number inside a formula.
 */
export async function previewAll(bytes, format, op, { name = `preview.${format}`, anchors = new Map() } = {}) {
  const driver = DRIVERS[format];
  if (!driver) return { ok: false, status: "refused", reason: `unsupported format ${format}` };
  if (op?.op !== "replace_all_text" && op?.op !== "format_all") return { ok: false, status: "refused", reason: `${op?.op} is not a document-wide op` };
  const st = await driver.open({ bytes, name, anchors });
  try {
    const b = await driver.bind(st, { ...op, expect: { count: 0 } });
    // count 0 matches the file when nothing is found (b.ok); any other count is the expect_mismatch that carries `found`
    if (!b.ok && b.status !== "expect_mismatch") return { ok: false, status: b.status, reason: b.reason, ...(b.code ? { code: b.code } : {}) };
    const count = b.ok ? 0 : b.found;
    return { ok: true, count, protected: b.protected ?? 0, ...("partial_words" in b ? { partial_words: b.partial_words } : {}), ...("in_formulas" in b ? { in_formulas: b.in_formulas } : {}) };
  } finally {
    driver.close(st);
  }
}

export const summarize = (results) => {
  const counts = { applied: 0, skipped_protected: 0, refused: 0, anchor_not_found: 0, expect_mismatch: 0, not_applied: 0 };
  for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
  return counts;
};
