import assert from "node:assert/strict";
import { test } from "node:test";
import { catchUpPlan, retryDelay } from "../web/src/catchup.js";

const page = (o = {}) => ({ syncedSha: "old", syncedRun: "r1", wantSha: null, busy: false, dirty: false, readOnly: false, ...o });
const view = (o = {}) => ({ baseSha: "new", format: "docx", activity: [{ id: "r2" }, { id: "r1" }], ...o });

test("a page that holds the session's version does nothing", () => {
  assert.equal(catchUpPlan(view({ baseSha: "old" }), page()), "none");
});

test("a page that missed a refresh reloads from the next state it sees", () => {
  assert.equal(catchUpPlan(view(), page()), "reload");
  assert.equal(catchUpPlan(view({ format: "xlsx" }), page()), "reload");
  assert.equal(catchUpPlan(view(), page({ readOnly: true })), "reload", "a read-only tab follows too");
});

test("one refresh per version: a state for the version already being loaded is not a second one", () => {
  assert.equal(catchUpPlan(view(), page({ wantSha: "new" })), "none");
  assert.equal(catchUpPlan(view({ baseSha: "newer" }), page({ wantSha: "new" })), "reload");
});

test("not while the page is itself writing, and not before it has loaded anything", () => {
  assert.equal(catchUpPlan(view(), page({ busy: true })), "none");
  assert.equal(catchUpPlan(view(), page({ syncedSha: null })), "none");
  assert.equal(catchUpPlan(view({ baseSha: null }), page()), "none");
});

test("unsent edits are merged in every format and never reloaded away in a read-only tab", () => {
  assert.equal(catchUpPlan(view(), page({ dirty: true })), "merge");
  assert.equal(catchUpPlan(view({ format: "xlsx" }), page({ dirty: true })), "merge");
  assert.equal(catchUpPlan(view({ format: "pptx" }), page({ dirty: true })), "merge");
  assert.equal(catchUpPlan(view(), page({ dirty: true, readOnly: true })), "wait");
});

test("a version that moved with no new run is a file changed outside and opened again: left to the outside-change flow", () => {
  assert.equal(catchUpPlan(view({ activity: [{ id: "r1" }] }), page()), "none");
  assert.equal(catchUpPlan(view({ activity: [{ id: "r1" }] }), page({ dirty: true })), "none", "typing is never merged over it");
  assert.equal(catchUpPlan(view({ activity: [] }), page({ syncedRun: null })), "none");
});

test("a failed refresh is tried again soon, then slowly, then no more", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 7].map(retryDelay), [1000, 2000, 4000, 8000, 15000, 15000]);
  assert.equal(retryDelay(8), null);
});
