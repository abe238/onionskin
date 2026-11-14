import assert from "node:assert/strict";
import { test } from "node:test";
import { noteAlone, ridesAlong } from "../web/src/quick-send.js";

test("the Send is the note alone: finished comments do not count; drafts, queued and waiting comments, edits and undone typing do", () => {
  const c = (status) => ({ id: status, status });
  assert.deepEqual(["draft", "queued", "sent", "done", "declined", "asked"].map((st) => ridesAlong(c(st))), [true, true, true, false, false, false]);
  assert.equal(noteAlone({ comments: [], edits: 0, dirty: false }), true);
  assert.equal(noteAlone({ comments: [c("done"), c("declined")], edits: 0, dirty: false }), true, "comments from earlier rounds stay out of the Send");
  assert.equal(noteAlone({ comments: [c("done"), c("sent")], edits: 0, dirty: false }), false, "a comment still waiting for an agent goes with it");
  assert.equal(noteAlone({ comments: [c("draft")], edits: 0, dirty: false }), false);
  assert.equal(noteAlone({ comments: [], edits: 1, dirty: true }), false);
  assert.equal(noteAlone({ comments: [], edits: 0, dirty: true }), false, "typing that was undone still sends the page's document");
});
