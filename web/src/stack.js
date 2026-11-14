/**
 * The panel is one stack in the order things happened, oldest at the top and newest right above the Send area. Comments keep the order
 * they were made in and never move. A run sits after the last comment of its batch, and typed edits sit after the comment that was
 * newest when they were made (never above a finished or working run).
 */
export function buildStack(comments, changes, session, working) {
  const slots = Array.from({ length: comments.length + 1 }, () => []); // slots[i]: what comes right after comment i - 1
  const lastOf = (batchId) => (batchId ? comments.findLastIndex((c) => c.batchId === batchId) : -1);
  // a reverted run's comments are drafts again and carry no batch: the run still belongs after the comments it answered
  const answered = (a) => comments.findLastIndex((c) => (a.results || []).some((r) => r.comment_id === c.id));
  let floor = 0;
  for (const a of [...session.activity].reverse()) {
    floor = Math.max(floor, lastOf(a.batchId) + 1, answered(a) + 1);
    slots[floor].push({ t: "run", key: a.id, a });
  }
  if (working) {
    floor = Math.max(floor, lastOf(session.deliveredBatchId) + 1);
    slots[floor].push({ t: "working", key: "working" });
  }
  for (const e of changes) {
    floor = Math.max(floor, comments.findIndex((c) => c.id === e.afterId) + 1);
    slots[floor].push({ t: "edit", key: e.id, e });
  }
  const out = [...slots[0]];
  comments.forEach((c, i) => out.push({ t: "comment", key: c.id, c }, ...slots[i + 1]));
  return out;
}
