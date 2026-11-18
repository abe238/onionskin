// web/src/drafts.js on its own: the paths the model check (test/interleave.test.js) does not reach, because the page's locks make them rare:
// a comment the server says was sent with other words than the page now holds, a note an action joined while the box changed, and a note
// the server gives back in an event that this page also sent once.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Drafts, mergeNote } from "../web/src/drafts.js";

const c = (id, text, status = "draft") => ({ id, kind: "element", text, status, anchor: { location: { blockPath: [0] }, quote: "q" } });
const view = (seq, comments, note = "") => ({ seq, comments, note });

test("a comment the server says was sent with other words keeps the page's newer words as a new draft after it", () => {
  const d = new Drafts();
  d.loaded("", [], 0);
  let local = { comments: [c("x", "Original comment")], note: "" };
  d.typed("x");
  const at = d.begin({ note: "", carriesNote: true, sends: new Set(["x"]), wire: 1 });
  d.end(at, false); // its answer was lost; then the comment was corrected
  d.typed("x");
  local = { comments: [c("x", "Corrected comment")], note: "" };
  const r = d.reconcile(local, view(3, [c("x", "Original comment", "sent")]));
  assert.deepEqual(r.comments.map((x) => [x.status, x.text, x.tiedTo ?? null]), [["sent", "Original comment", null], ["draft", "Corrected comment", "x"]]);
  assert.equal(r.unsaved, true, "the new draft is saved next");
  // not tied again on the next state
  const again = d.reconcile({ comments: r.comments, note: "" }, view(4, [c("x", "Original comment", "sent"), { ...r.comments[1], status: "draft" }]));
  assert.equal(again.comments.length, 2);
  // the same words: no new draft
  const d2 = new Drafts();
  d2.loaded("", [], 0);
  d2.typed("y");
  d2.begin({ note: "", carriesNote: true, sends: new Set(["y"]), wire: 1 });
  assert.equal(d2.reconcile({ comments: [c("y", "Same")], note: "" }, view(2, [c("y", "Same", "sent")])).comments.length, 1);
});

test("an action's answer joins the server's note with words typed since; the server's own additions stay before them", () => {
  assert.equal(mergeNote("Mine", "Withdrawn\n\nMine", "Mine, longer"), "Withdrawn\n\nMine, longer");
  assert.equal(mergeNote("", "Withdrawn", "Typed"), "Withdrawn\n\nTyped");
  assert.equal(mergeNote("Mine", "Mine", "Mine, longer"), "Mine, longer", "the server kept what it had: the box wins");
  assert.equal(mergeNote("Mine", "Withdrawn\n\nMine", "Mine"), "Withdrawn\n\nMine", "nothing typed since: the server's");
  // additions after `base` (a handover joined after the stored note) go after `mine`, so `base` is not there twice (model check seed 80002371)
  assert.equal(mergeNote("Mine", "Mine\n\nHanded over", "Mine, longer"), "Mine, longer\n\nHanded over");
  // ... also when both sides continued the same paragraph (two windows, seed 60001326): both continuations, `base` once
  assert.equal(mergeNote("Mine", "Mine and theirs", "Mine, longer"), "Mine, longer\n\nand theirs");
  assert.equal(mergeNote("Mine", "Mine\n\nHanded over", "Mine\n\nHanded over\n\nMore"), "Mine\n\nHanded over\n\nMore", "already in the box: not again");
  assert.equal(mergeNote("Min", "Mine", "Mint"), "Mint\n\nMine", "both changed the same word: the person's whole, then the server's");
  // `theirs` changed `base` (a note handed over and merged into it) and `mine` only added after it: both changes, by word (seed 80001477)
  assert.equal(mergeNote("Base text", "Base other\n\ntext", "Base text and more"), "Base other\n\ntext and more");
  // merged once already (a second save of the same box from the same state): not again (seed 80001477)
  assert.equal(mergeNote("Mine", "Mine, longer\n\nHanded over", "Mine, longer"), "Mine, longer\n\nHanded over");
  const d = new Drafts();
  d.loaded("Mine", [], 0);
  const at = d.begin({ rewrites: true });
  d.typedNote(); // typed while it was out
  d.end(at, true);
  const r = d.reconcile({ comments: [], note: "Mine, longer" }, view(2, [], "Withdrawn\n\nMine"), at);
  assert.equal(r.note, "Withdrawn\n\nMine, longer");
  assert.equal(r.unsaved, true);
});

test("a note the server gives back in an event (a queued note at a lease expiry) goes in, though this page sent the same words once", () => {
  const d = new Drafts();
  d.loaded("", [], 0);
  d.typedNote();
  const at = d.begin({ note: "Queued note", carriesNote: true, sends: new Set(), wire: 1 });
  d.end(at, true);
  let r = d.reconcile({ comments: [], note: "Queued note" }, view(2, [], ""), at); // the Send took it
  assert.equal(r.note, "");
  r = d.reconcile({ comments: [], note: r.note }, view(3, [], "Queued note")); // the run stopped: the queued note is back in the box
  assert.deepEqual([r.note, r.unsaved], ["Queued note", false]);
  // a state older than one the page took changes nothing
  assert.deepEqual(d.reconcile({ comments: [], note: r.note }, view(2, [c("z", "old")], "")), { comments: [], note: "Queued note", unsaved: false });
});

// The model check's seed 415446: the box was emptied by the server (a Send took the note), not by typing; then the server gave the note back
// (the run stopped with it queued) while the page did not hear of it, and an old save's late answer showed it. The box had no keystroke since
// the server last held it, so the server's note is taken; before, the empty box was kept as if typed and the next save emptied the note.
test("a box the server emptied (not typed) takes the note the server gives back, also from a late save's answer", () => {
  const d = new Drafts();
  d.loaded("w1", [], 5);
  const save = d.begin({ note: "w1", carriesNote: true, wire: 2 }); // a leave-page save sent while the Send below was in flight
  const send = d.begin({ note: "w1", carriesNote: true, sends: new Set(), wire: 1 });
  d.end(send);
  let r = d.reconcile({ comments: [], note: "w1" }, view(8, [], ""), send); // the Send took it: the box empties
  assert.equal(r.note, "");
  d.end(save);
  r = d.reconcile({ comments: [], note: r.note }, view(11, [], "w1"), save); // the run stopped and gave it back; the old save's answer shows it
  assert.equal(r.note, "w1", "the note the server gave back is in the box");
  // with a keystroke since the box emptied, the person's words stay and go with the server's
  const d2 = new Drafts();
  d2.loaded("w1", [], 5);
  const s2 = d2.begin({ note: "w1", carriesNote: true, wire: 2 });
  const t2 = d2.begin({ note: "w1", carriesNote: true, sends: new Set(), wire: 1 });
  d2.end(t2);
  let r2 = d2.reconcile({ comments: [], note: "w1" }, view(8, [], ""), t2);
  d2.typedNote();
  d2.end(s2);
  r2 = d2.reconcile({ comments: [], note: "typed" }, view(11, [], "w1"), s2);
  assert.ok(r2.note.includes("w1") && r2.note.includes("typed"), r2.note);
});

test("a later save of this page that carried the note from before the server emptied the box does not explain the server's note", () => {
  const d = new Drafts();
  d.loaded("w1", [], 5);
  const save2 = d.begin({ note: "w1", carriesNote: true, wire: 2 });
  d.begin({ note: "w1", carriesNote: true, wire: 3 }); // lost: never answered
  const send = d.begin({ note: "w1", carriesNote: true, sends: new Set(), wire: 1 });
  d.end(send);
  let r = d.reconcile({ comments: [], note: "w1" }, view(8, [], ""), send);
  d.end(save2);
  r = d.reconcile({ comments: [], note: r.note }, view(11, [], "w1"), save2);
  assert.equal(r.note, "w1");
});

test("words are unsaved until the answer of a save that carried them: typed, saving, failed, deleted", () => {
  const d = new Drafts();
  d.loaded("", [], 0);
  const cs = [c("x", "words")];
  assert.equal(d.dirty(cs), false);
  d.typed("x");
  assert.equal(d.dirty(cs), true, "typed, no save yet");
  const a = d.begin({ note: "", carriesNote: true, wire: 1, comments: cs });
  assert.equal(d.dirty(cs), true, "its save is on its way");
  d.end(a, false);
  assert.equal(d.dirty(cs), true, "its save failed");
  const b = d.begin({ note: "", carriesNote: true, wire: 2, comments: cs });
  d.end(b, true);
  assert.equal(d.dirty(cs), false, "a save that carried it went through");
  d.typedNote();
  assert.equal(d.dirty(cs), true, "the note box too");
  d.reconcile({ comments: cs, note: "n" }, view(3, cs, "n"), d.begin({ note: "n", carriesNote: true, wire: 3, comments: cs }));
  d.removed("x");
  assert.equal(d.dirty([]), true, "a deletion no save confirmed");
  const e = d.begin({ note: "n", carriesNote: true, wire: 4, comments: [] });
  d.end(e, true);
  assert.equal(d.dirty([]), false);
});

// The model check's seed 2219317: a save's answer arrived while a Send that carried the note was in flight and changed the box under it; the
// box then had a revision the Send never took, and the save on the way out put the delivered note back.
test("while a Send that carries the note is in flight, no other answer changes the box; the Send's answer decides", () => {
  const d = new Drafts();
  d.loaded("", [], 0);
  d.typedNote();
  const save = d.begin({ note: "w3", carriesNote: true, wire: 1 });
  const send = d.begin({ note: "w3", carriesNote: true, sends: new Set(), wire: 2 });
  d.end(save, true);
  let r = d.reconcile({ comments: [], note: "w3" }, view(3, [], "Given back\n\nw3"), save);
  assert.equal(r.note, "w3", "the held box stays as the Send carried it");
  d.end(send, true);
  r = d.reconcile({ comments: [], note: r.note }, view(6, [], ""), send);
  assert.equal(r.note, "", "the Send took it (with the note given back merged in, on the server)");
});

// The outside review of 4d2b2fc (src/notes.js:28): words the person deleted from the note while its save was out came back with the
// server's answer, and the box was marked saved. A three-way merge from the base: the person's deletions and additions, the server's additions.
test("the note merge honors what the person did to the base: deletions stay deleted, additions kept once, the box unsaved when it differs", () => {
  const d = new Drafts();
  d.loaded("", [], 0);
  d.typedNote();
  const at = d.begin({ note: "Fix title and subtitle", carriesNote: true, wire: 1 });
  d.typedNote(); // " and subtitle" deleted while the save was out
  d.end(at, true);
  const r = d.reconcile({ comments: [], note: "Fix title" }, view(2, [], "Fix title and subtitle\n\nCheck links"), at);
  assert.equal(r.note, "Fix title\n\nCheck links", "the deleted words stay deleted, the other window's addition is kept");
  assert.equal(r.unsaved, true, "the server holds other words: the next save carries the box");
  assert.equal(d.dirty([]), true);
  // the next save of the merged box goes through: saved
  const next = d.begin({ note: r.note, carriesNote: true, wire: 2 });
  d.end(next, true);
  const s = d.reconcile({ comments: [], note: r.note }, view(3, [], r.note), next);
  assert.deepEqual([s.note, s.unsaved, d.dirty([])], [r.note, false, false]);

  const M = (base, theirs, mine) => mergeNote(base, theirs, mine);
  // deletions at the start, the middle and the end, with the server's paragraph added after
  assert.equal(M("Fix the title and subtitle", "Fix the title and subtitle\n\nCheck links", "the title and subtitle"), "the title and subtitle\n\nCheck links");
  assert.equal(M("Fix the title and subtitle", "Fix the title and subtitle\n\nCheck links", "Fix the subtitle"), "Fix the subtitle\n\nCheck links");
  assert.equal(M("Fix the title and subtitle", "Fix the title and subtitle\n\nCheck links", "Fix the title"), "Fix the title\n\nCheck links");
  // ... and with the server's paragraph added in front (Take back: the withdrawn note goes before)
  assert.equal(M("Fix the title and subtitle", "Withdrawn\n\nFix the title and subtitle", "Fix the title"), "Withdrawn\n\nFix the title");
  // a word replaced
  assert.equal(M("Fix the title now", "Fix the title now\n\nCheck links", "Fix the heading now"), "Fix the heading now\n\nCheck links");
  // both appended: the person's text whole, the server's addition after a blank line, each once
  assert.equal(M("Base", "Base\n\nTheirs", "Base and mine"), "Base and mine\n\nTheirs");
  // the server's text is the person's: nothing to merge
  assert.equal(M("Base", "Base, edited", "Base, edited"), "Base, edited");
  // an empty base: the server's first (as before), both once
  assert.equal(M("", "Theirs", "Mine"), "Theirs\n\nMine");
  // both changed the same words: undecidable, so the person's text whole and the server's addition after it
  assert.equal(M("Fix the title", "Fix the header", "Fix the heading"), "Fix the heading\n\nheader");
  // the person deleted words the server changed: the person's text, then what the server added
  assert.equal(M("Fix the title and subtitle", "Fix the title and caption", "Fix the title"), "Fix the title\n\ncaption");
  // a second save from the same state: the server's note already starts with the person's additions, not again
  assert.equal(M("Mine", "Mine more\n\nHanded over", "Mine more"), "Mine more\n\nHanded over");
});
