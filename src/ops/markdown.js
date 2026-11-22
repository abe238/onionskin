// The apply driver for a Markdown file (src/ops/run.js): one op, replace_source, by exact range. Every op is bound against the file as
// it is before any op runs (its sha256 is the op's base, its old text is exactly the source there: src/markdown-file.js checkOne), and
// the ones that apply are written together, at once, in finish (applyAll: offsets of that one base, so an earlier replacement never moves
// a later one). Two that overlap refuse every op of the run, also with --partial. The session rebuilds the same bytes from the disk and
// these ops before it writes them (src/session.js agentWrite); nothing here searches for words.
import { NO_CHANGE, applyAll, checkOne, readMarkdownFile } from "../markdown-file.js";

export async function open({ bytes }) {
  try {
    return { file: readMarkdownFile(bytes), error: null, reps: [], asked: [] };
  } catch (err) {
    return { file: null, error: { code: err.code || "unreadable", reason: String(err.message).slice(0, 300) }, reps: [], asked: [] };
  }
}

export async function bind(st, op) {
  if (st.error) return { ok: false, status: "refused", code: st.error.code, reason: st.error.reason };
  // every range the reply asks for, also one whose op is refused below: an overlap between them refuses the whole reply in finish, so a
  // dropped op (--partial) can never hide that two ops of the reply named the same text
  const t = op?.target || {};
  if (Number.isInteger(t.from) && Number.isInteger(t.to) && t.from >= 0 && t.from <= t.to && t.to <= st.file.tree.length) st.asked.push({ from: t.from, to: t.to });
  const c = checkOne(st.file, op);
  if (c.ok && c.rep.old === c.rep.new) return { ok: false, status: "refused", code: "no_change", reason: NO_CHANGE };
  return c.ok ? { ok: true, rep: c.rep } : { ok: false, status: c.status, code: c.code, reason: c.reason };
}

export async function exec(st, b) {
  st.reps.push(b.rep);
  return { status: "applied", detail: { from: b.rep.from, to: b.rep.to } };
}

/** Two ranges the reply asked for overlap or start at the same place (as applyAll refuses them), whether or not their ops bound. */
function overlapping(asked) {
  const l = [...asked].sort((a, b) => a.from - b.from || a.to - b.to);
  for (let k = 1; k < l.length; k++) if (l[k].from < l[k - 1].to || l[k].from === l[k - 1].from) return true;
  return false;
}

export async function finish(st, results) {
  const r = overlapping(st.asked) ? { ok: false, code: "overlap", reason: "two ranges of this reply overlap or start at the same place (also counting ops that were refused), so none was written; send them as one replacement" } : applyAll(st.file, st.reps);
  if (!r.ok) {
    // all or nothing: a refusal of the set (overlapping ranges) refuses every op that would have been written
    const out = results.map((x) => (x.status === "applied" ? { index: x.index, op: x.op, ...(x.id ? { id: x.id } : {}), status: "refused", code: r.code, reason: r.reason } : x));
    return { results: out, bytes: null, warnings: [], blocked: null };
  }
  return { results, bytes: r.bytes, warnings: [], blocked: null };
}

export function close() {}
