import assert from "node:assert/strict";
import { test } from "node:test";
import { buildStack } from "../web/src/stack.js";

const keys = (s) => s.map((i) => i.key);
const c = (id, batchId) => ({ id, batchId });

test("comments keep the order they were made in, each run after the last comment of its batch", () => {
  const comments = [c("c1", "b1"), c("c2", "b1"), c("c3", "b2"), c("c4")];
  const session = { activity: [{ id: "r2", batchId: "b2" }, { id: "r1", batchId: "b1" }], deliveredBatchId: null };
  assert.deepEqual(keys(buildStack(comments, [], session, false)), ["c1", "c2", "r1", "c3", "r2", "c4"]);
});

test("an unfinished comment in the middle stays where it is", () => {
  const comments = [c("c1", "b1"), c("c2", "b2"), c("c3", "b3")];
  const session = { activity: [{ id: "r3", batchId: "b3" }, { id: "r1", batchId: "b1" }], deliveredBatchId: null };
  assert.deepEqual(keys(buildStack(comments, [], session, false)), ["c1", "r1", "c2", "c3", "r3"]);
});

test("the working card sits under the batch that is out, above what was added since", () => {
  const comments = [c("c1", "b1"), c("c2", "b2"), c("c3")];
  const session = { activity: [{ id: "r1", batchId: "b1" }], deliveredBatchId: "b2" };
  assert.deepEqual(keys(buildStack(comments, [], session, true)), ["c1", "r1", "c2", "working", "c3"]);
});

test("typed edits sit after the comment that was newest when they began, never above a run", () => {
  const comments = [c("c1", "b1"), c("c2"), c("c3")];
  const session = { activity: [{ id: "r1", batchId: "b1" }], deliveredBatchId: null };
  const changes = [{ id: "e1", afterId: "c1" }, { id: "e2", afterId: "c2" }, { id: "e3", afterId: "gone" }];
  assert.deepEqual(keys(buildStack(comments, changes, session, false)), ["c1", "r1", "e1", "c2", "e2", "e3", "c3"]);
});

test("a run with no comments (an edit-only batch or a revert) follows the run before it", () => {
  const comments = [c("c1", "b1"), c("c2")];
  const session = { activity: [{ id: "rv" }, { id: "r1", batchId: "b1" }], deliveredBatchId: null };
  assert.deepEqual(keys(buildStack(comments, [], session, false)), ["c1", "r1", "rv", "c2"]);
});

test("a reverted run stays after the comments it answered, though they are drafts again", () => {
  const comments = [c("c1", "b1"), c("c2"), c("c3")];
  const session = { activity: [{ id: "rv" }, { id: "r2", batchId: "b2", results: [{ comment_id: "c2" }] }, { id: "r1", batchId: "b1" }], deliveredBatchId: null };
  assert.deepEqual(keys(buildStack(comments, [], session, false)), ["c1", "r1", "c2", "r2", "rv", "c3"]);
});

test("nothing yet: an empty stack", () => {
  assert.deepEqual(buildStack([], [], { activity: [] }, false), []);
});
