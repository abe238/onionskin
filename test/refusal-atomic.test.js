// Every refusal changes nothing: for each refusal code of a draft save, a Send, Take back, an answer and a quick fix's Use, the stored
// session is read before and after and must be the same bytes (src/session.js plans what a request would store, checks every limit on
// that plan, and only then changes anything). Temp dirs only.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { docxBytes, tmpdir } from "./helpers/zipbuild.js";

const root = tmpdir();
process.env.ONIONSKIN_STATE_DIR = path.join(root, "st");
process.env.ONIONSKIN_NO_SOFFICE = "1";
const { Sessions } = await import("../src/session.js");
const { ensureStateDir } = await import("../src/paths.js");
const { MAX_DOC_BYTES } = await import("../src/constants.js");
const { STAMP_WORDS } = await import("../src/stamp-words.js");
ensureStateDir();

const PARAS = ["The first paragraph.", "The second paragraph.", "A third one here."];
const c = (id, text, i = 0) => ({ id, kind: "element", text, anchor: { location: { blockPath: [i] }, quote: PARAS[i], paraText: PARAS[i], hitKind: "paragraph" } });
let n = 0;
function fresh(S) {
  const f = path.join(root, `a${n++}.docx`);
  fs.writeFileSync(f, docxBytes(PARAS));
  return S.open(f);
}
const file = (s) => fs.readFileSync(path.join(process.env.ONIONSKIN_STATE_DIR, "sessions", `${s.key}.json`), "utf8");
/** `fn` is refused with `code` (and `status`), and the stored session and the session in memory are as they were. */
async function unchanged(s, status, code, fn) {
  const before = file(s);
  const mem = JSON.stringify({ comments: s.comments, note: s.note, queuedNote: s.queuedNote, pending: s.pending, seq: s.seq });
  let err = null;
  try {
    await fn();
  } catch (e) {
    err = e;
  }
  assert.ok(err, `${code}: refused`);
  assert.equal(err.status, status, `${code}: ${err.message}`);
  if (code) assert.equal(err.extra?.code, code);
  assert.equal(file(s), before, `${code}: the stored session is the same`);
  assert.equal(JSON.stringify({ comments: s.comments, note: s.note, queuedNote: s.queuedNote, pending: s.pending, seq: s.seq }), mem, `${code}: so is the session in memory`);
}

test("every refusal of a draft save, Send, Take back, answer and Use leaves the stored session as it was", { timeout: 120_000 }, async () => {
  const S = new Sessions();
  const TAB = "tab-a";
  const many = Array.from({ length: 501 }, (_, i) => c(`m${i}`, `comment ${i}`, i % 3));
  const long = "w".repeat(15_000);

  // draft saves
  let s = fresh(S);
  S.setDraft(s.key, { comments: [c("x", "kept")], note: "kept note", rev: 1, tab: TAB });
  await unchanged(s, 400, undefined, () => S.setDraftAsync(s.key, { comments: "no", rev: 2, tab: TAB }));
  await unchanged(s, 413, "too_many_comments", () => S.setDraftAsync(s.key, { comments: many, rev: 3, tab: TAB }));
  await unchanged(s, 413, "note_too_long", () => S.setDraftAsync(s.key, { comments: [c("x", "changed")], note: "n".repeat(20_001), rev: 4, tab: TAB }));

  // Sends: one changed comment list each, so a save before the refusal would show
  await unchanged(s, 413, "too_many_comments", () => S.sendAsync(s.key, { baseSha: s.baseSha, comments: many, note: "", rev: 5, tab: TAB }));
  await unchanged(s, 413, "note_too_long", () => S.sendAsync(s.key, { baseSha: s.baseSha, comments: [c("x", "changed")], note: "n".repeat(20_001), rev: 6, tab: TAB }));
  await unchanged(s, 413, "too_large", () => S.sendAsync(s.key, { baseSha: s.baseSha, bytes: Buffer.alloc(MAX_DOC_BYTES + 1), comments: [c("x", "changed"), c("y", "new", 1)], note: "other", rev: 7, tab: TAB }));
  // joined with the note of a batch still waiting for an agent (the review's case)
  await S.sendAsync(s.key, { baseSha: s.baseSha, comments: [c("x", "kept")], note: long, rev: 8, tab: TAB });
  await unchanged(s, 413, "note_too_long", () => S.sendAsync(s.key, { baseSha: s.baseSha, comments: [...s.comments, c("y", "new", 1)], note: "abc" + long, rev: 9, tab: TAB }));
  // joined with a queued note during a run
  s = fresh(S);
  await S.sendAsync(s.key, { baseSha: s.baseSha, comments: [c("a", "first")], note: "" });
  await S.poll(s.key).promise;
  await S.sendAsync(s.key, { baseSha: s.baseSha, comments: [...s.comments, c("q", "queued", 1)], note: long });
  await unchanged(s, 413, "note_too_long", () => S.sendAsync(s.key, { baseSha: s.baseSha, comments: [...s.comments, c("r", "another", 2)], note: long }));
  await unchanged(s, 423, "locked", () => S.sendAsync(s.key, { baseSha: s.baseSha, bytes: docxBytes(["Changed."]), comments: [...s.comments, c("r", "another", 2)], note: "x" }));

  // Take back with nothing to take back, an answer to a comment with no question
  s = fresh(S);
  S.setDraft(s.key, { comments: [c("x", "kept")], note: "kept note" });
  await unchanged(s, 409, undefined, () => S.inTurn(s.key, () => S.takeBack(s.key)));
  await unchanged(s, 409, "not_asked", () => S.inTurn(s.key, () => S.answer(s.key, { id: "x", choice: 0 })));

  // an answer with an option the question does not have
  const qs = fresh(S);
  await S.sendAsync(qs.key, { baseSha: qs.baseSha, comments: [c("x", "Which date?")], note: "" });
  await S.poll(qs.key).promise;
  S.done(qs.key, { summary: "s", results: [{ comment_id: "x", status: "asked", ask: "Which date do you mean?", options: ["March 3", "March 13"] }] });
  assert.equal(qs.comments[0].status, "asked");
  await unchanged(qs, 400, "bad_choice", () => S.inTurn(qs.key, () => S.answer(qs.key, { id: "x", choice: 5 })));
  await unchanged(qs, 400, "bad_choice", () => S.inTurn(qs.key, () => S.answer(qs.key, { id: "x", choice: "0" })));

  // a quick fix's Use: out of date, not the stamp, busy
  const qt = PARAS[0];
  const location = { blockPath: [0], start: 0, end: qt.length };
  const rec = { task: "grammar", quote: qt, location, before: qt, after: "The first paragraph!" };
  const stamp = { id: "u", kind: "text", text: STAMP_WORDS.grammar, anchor: { location, quote: qt } };
  await unchanged(s, 409, "expired", () => S.useSuggestionAsync(s.key, { suggestion: { ...rec, task: "nope" }, commentId: "u", comments: [stamp, c("x", "changed")], note: "other", baseSha: s.baseSha }));
  await unchanged(s, 413, "too_large", () => S.useSuggestionAsync(s.key, { suggestion: rec, commentId: "u", comments: [stamp, c("x", "changed")], note: "New note", bytes: Buffer.alloc(MAX_DOC_BYTES + 1), baseSha: s.baseSha }));
  await unchanged(s, 409, "not_this_comment", () => S.useSuggestionAsync(s.key, { suggestion: rec, commentId: "u", comments: [{ ...stamp, text: "other words" }, c("x", "changed")], note: "other", baseSha: s.baseSha }));
  await S.sendAsync(s.key, { baseSha: s.baseSha, comments: s.comments, note: s.note });
  await unchanged(s, 409, "busy", () => S.useSuggestionAsync(s.key, { suggestion: rec, commentId: "u", comments: [...s.comments, stamp], note: "other", baseSha: s.baseSha }));

  // closed
  S.close(s.key);
  await unchanged(s, 409, "closed", () => S.sendAsync(s.key, { baseSha: s.baseSha, comments: [c("z", "late")], note: "late" }));
});

// too_large_request needs a session near the 64 MB cap of its file (the fixture of test/retain.test.js: quotes and typed edits of control
// characters are six bytes each as JSON, so they stay past the cap even after the writer's cuts). Slow: about 60 MB is written and read.
test("a draft save and a quick fix's Use refused because the session would not fit its file (413 too_large_request) leave the stored session as it was", { timeout: 300_000 }, async () => {
  const S = new Sessions();
  const TAB = "tab-big";
  const ctl = "\u0001".repeat(20_000);
  const heavy = (id, i) => ({ id, kind: "element", text: "fix", anchor: { location: { blockPath: [i % 3] }, quote: ctl, paraText: ctl, prefix: ctl, suffix: ctl } });
  const edits = Array.from({ length: 2000 }, () => ({ kind: "text", before: ctl, after: ctl, label: ctl.slice(0, 1000), location: { blockPath: [0] } }));

  // a draft save: 2,000 typed edits kept for the batch (about 60 MB once cut) fit; 498 heavy drafts on top do not
  let s = fresh(S);
  S.send(s.key, { baseSha: s.baseSha, comments: [c("x", "sent with the edits")], note: "", edits, rev: 1, tab: TAB });
  assert.equal(s.edits.length, 2000);
  S.setDraft(s.key, { comments: [...s.comments, c("y", "kept draft", 1)], note: "kept note", rev: 2, tab: TAB });
  const many = Array.from({ length: 498 }, (_, i) => heavy(`h${i}`, i));
  await unchanged(s, 413, "too_large_request", () => S.setDraftAsync(s.key, { comments: [s.comments[0], c("y", "changed", 1), ...many], note: "other note", rev: 3, tab: TAB }));
  S.close(s.key);

  // a quick fix's Use: 499 heavy drafts fit; the Use's 2,000 typed edits on top do not
  s = fresh(S);
  S.setDraft(s.key, { comments: Array.from({ length: 499 }, (_, i) => heavy(`h${i}`, i)), note: "kept note", rev: 1, tab: TAB });
  const qt = PARAS[0];
  const location = { blockPath: [0], start: 0, end: qt.length };
  const rec = { task: "grammar", quote: qt, location, before: qt, after: "The first paragraph!" };
  const stamp = { id: "u", kind: "text", text: STAMP_WORDS.grammar, anchor: { location, quote: qt } };
  const changed = [{ ...s.comments[0], text: "fix, changed" }, ...s.comments.slice(1)]; // a save before the refusal would show
  await unchanged(s, 413, "too_large_request", () => S.useSuggestionAsync(s.key, { suggestion: rec, commentId: "u", comments: [...changed, stamp], note: "New note", edits, baseSha: s.baseSha, rev: 2, tab: TAB }));
  S.close(s.key);
});

test("Take back never refuses: notes joined past the cap come back whole, the page may save that box and shorten it, not lengthen it", async () => {
  const S = new Sessions();
  const s = fresh(S);
  const a = "a".repeat(15_000);
  const b = "b".repeat(15_000);
  await S.sendAsync(s.key, { baseSha: s.baseSha, comments: [], note: a });
  S.setDraft(s.key, { comments: [], note: b });
  S.takeBack(s.key);
  assert.equal(s.note, `${a}\n\n${b}`, "both notes, whole");
  S.setDraft(s.key, { comments: [], note: s.note }); // the page saves the box it was given
  S.setDraft(s.key, { comments: [], note: s.note.slice(1) }); // and a shorter one
  await unchanged(s, 413, "note_too_long", () => S.setDraftAsync(s.key, { comments: [], note: `${s.note}x` }));
  await unchanged(s, 413, "note_too_long", () => S.sendAsync(s.key, { baseSha: s.baseSha, comments: [], note: s.note }));
});
