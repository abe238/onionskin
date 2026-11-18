// What the person typed is never replaced by text from the server unless the server's text is known to be based on it (docs/contracts/routes.md,
// "the page's drafts"). Every editable thing the page holds (each comment's words, the overall note) has a local revision that goes up on
// every change. Every request that carries them, or whose answer can rewrite them (a draft save, Send, a quick fix's Use, Take back, Stop,
// Revert, Close), records what it was sent with (begin). When server state arrives (an answer, the event stream, a page load, the check after
// a lost answer) the page puts it in through reconcile() and nowhere else: a field takes the server's words only when its revision is still
// the one the server's state is based on (or it was never changed here since the page loaded). Otherwise the page's words stay, and the
// answer says they are unsaved, so the next autosave carries them. Pure: no React, no browser (test/interleave.test.js drives the same code).

import { mergeNote } from "../../src/notes.js";

export { mergeNote }; // for test/drafts.test.js

// the notes of this page's requests remembered (a page has a handful in flight at most; past this an older one is merged as the server's)
const NOTES_KEPT = 50;
let tied = 0;
/** The id of a new draft that keeps words typed into a comment the server says was sent with other words. */
const tieId = (id) => `${String(id).slice(0, 40)}~${Date.now().toString(36)}${(tied++).toString(36)}`;

export class Drafts {
  constructor() {
    this.noteRev = 0;
    this.revs = new Map(); // comment id -> revision (0: not changed here since the page loaded)
    this.gone = new Set(); // comment ids deleted here: the server's copy is not brought back
    this.goneUnsaved = new Set(); // ... and not yet confirmed by a save's answer
    this.acked = new Map(); // comment id -> the newest revision a save or Send that went through carried (the server holds it)
    this.ackedText = new Map(); // ... and its words then
    this.theirs = new Set(); // comment ids this page took from the server's state (not made here): they follow it, also when it drops them
    this.sentWith = new Map(); // comment id -> its revision when the latest Send or Use of this page carried it
    // the note as the server is known to hold it, the box's revision then (-1: no revision of the box), and the `seq` of the server state it
    // came from (a handover says it: the server then knows whether this page took the answer of its last save, src/session.js handOver)
    this.stored = { rev: 0, text: "", seq: -1 };
    this.seen = -1; // the newest state of the server this page took (its `seq`): an older one that arrives late changes nothing
    this.noteSeen = -1; // the newest state whose note the box took (the server merges a note it gave back since, src/session.js)
    this.open = 0; // requests in flight
    this.sendsOpen = 0; // Sends in flight that carry the note: until one is answered, no other state changes the box (the Send's answer decides)
    this.notesSent = []; // {rev, text, wire} of the notes this page's requests carried, newest last (the last NOTES_KEPT)
  }

  /** The person changed the note, or a comment (its words, or made it). */
  typedNote() {
    this.noteRev++;
  }
  typed(id) {
    this.revs.set(id, (this.revs.get(id) || 0) + 1);
  }
  rev(id) {
    return this.revs.get(id) || 0;
  }
  removed(id) {
    this.gone.add(id);
    this.goneUnsaved.add(id);
  }

  /**
   * Whether the page holds words the server has not confirmed: the note box since the server last held it, a comment changed or made since
   * the last answer that carried it, a deletion no save has confirmed. The leave-page question counts this (web/src/App.jsx), so a save on
   * the way out that never arrives does not lose words silently.
   */
  dirty(comments) {
    return this.noteRev !== this.stored.rev || this.goneUnsaved.size > 0 || comments.some((c) => this.rev(c.id) > (this.acked.get(c.id) ?? 0));
  }

  /** The page loaded `note` and `comments` from the server (a page load, a tab that takes over editing): nothing here is newer. */
  loaded(note, comments = [], seq = -1) {
    this.seen = seq;
    this.noteSeen = seq;
    this.latest = { note: note || "" }; // the note of that newest state
    this.revs.clear();
    this.sentWith.clear();
    this.gone.clear();
    this.goneUnsaved.clear();
    this.acked.clear();
    this.ackedText.clear();
    this.theirs = new Set(comments.map((c) => c.id));
    this.noteRev = 0;
    this.stored = { rev: 0, text: note || "", seq };
  }

  /**
   * A request goes out. `note`: the note it stores (`carriesNote`: a draft save that carries the box, a Send, a Use). `rewrites`: its answer
   * can change the note from what the server holds (Take back, Stop, Revert, Close), so that answer is based on the stored note. A draft
   * save that leaves the note out is neither: its answer's note is taken as an event's is. `sends`: ids it delivers (a Send's drafts, a Use's
   * stamp). `wire`: its number (a save, a Send). Returns what it was sent with, for reconcile() and end().
   */
  begin({ note = "", carriesNote = false, rewrites = false, sends = null, wire = null, comments = null } = {}) {
    const at = { wire, note: carriesNote ? { rev: this.noteRev, text: note || "" } : rewrites ? { ...this.stored } : null, carries: carriesNote, sends: !!sends };
    if (comments) {
      at.revs = new Map(comments.map((c) => [c.id, this.rev(c.id)])); // `comments`: the list it stores (a draft save, a Send)
      at.texts = new Map(comments.map((c) => [c.id, c.text]));
      at.gone = [...this.goneUnsaved];
    }
    if (carriesNote) this.notesSent = [...this.notesSent.slice(1 - NOTES_KEPT), { ...at.note, wire }];
    if (sends) for (const id of sends) this.sentWith.set(id, this.rev(id));
    if (sends && carriesNote) this.sendsOpen++;
    this.open++;
    return at;
  }

  /** What this page holds that no save confirmed, for POST /api/handover: the comments (each with `base`, the words the server last confirmed) and the note. */
  unsaved(comments, note) {
    return {
      comments: comments.filter((c) => this.rev(c.id) > (this.acked.get(c.id) ?? 0)).map((c) => ({ id: c.id, kind: c.kind, text: c.text, anchor: c.anchor, pin: c.pin, pinNo: c.pinNo, base: this.ackedText.get(c.id) ?? null })),
      note: this.noteRev !== this.stored.rev ? note : undefined,
      noteRev: this.noteRev,
      base: this.stored.text,
      baseSeq: this.stored.seq,
    };
  }

  /** The request answered (`ok`: the server stored what it carried) or failed: no longer in flight. */
  end(at, ok = false) {
    this.open = Math.max(0, this.open - 1);
    if (at?.sends && at.carries) this.sendsOpen = Math.max(0, this.sendsOpen - 1);
    if (!ok || !at?.revs) return;
    for (const [id, r] of at.revs)
      if (r >= (this.acked.get(id) ?? 0)) {
        this.acked.set(id, r);
        this.ackedText.set(id, at.texts.get(id));
      }
    for (const id of at.gone) this.goneUnsaved.delete(id);
  }

  /**
   * The one place server state goes into the page's comments and note. `local`: {comments, note} as the page holds them now; `view`: the
   * server's session; `at`: what the request this answers was sent with (null: state that answers nothing of this page's, as an event).
   * `wholesale`: the page shows the server's words as they are (a read-only tab; one that just took over editing), and nothing here is newer.
   * Returns {comments, note, unsaved}: `unsaved` when the page keeps words the server does not hold (the next autosave carries them).
   */
  reconcile(local, view, at = null, { wholesale = false } = {}) {
    if (wholesale) {
      this.loaded(view.note, view.comments, view.seq ?? -1);
      return { comments: view.comments, note: view.note || "", unsaved: false };
    }
    // a state older than one this page already took (an event or an answer that was on its way) is older than what the page holds: it
    // changes nothing, except that the answer of a request that carried or rewrote the note decides the note against the newer state (which
    // came after that request, so it is based on it too)
    if (Number.isFinite(view.seq) && view.seq < this.seen) {
      if (!at?.note) return { comments: local.comments, note: local.note || "", unsaved: false };
      const n = this.#note(local.note || "", this.latest.note, at, this.seen);
      if (n.based || n.note === this.latest.note) this.noteSeen = this.seen;
      return { comments: local.comments, note: n.note, unsaved: n.unsaved };
    }
    if (Number.isFinite(view.seq)) this.seen = view.seq;
    this.latest = { note: view.note || "" };
    let unsaved = false;
    const byId = new Map(view.comments.map((x) => [x.id, x]));
    const comments = [];
    const mine = new Set(local.comments.map((c) => c.id));
    for (const c of local.comments) {
      const s = byId.get(c.id);
      if (!s) {
        if (!(this.theirs.has(c.id) && this.rev(c.id) === 0)) comments.push(c); // one this page made stays until its save
        continue;
      }
      const fields = { status: s.status, result: s.result, localHint: s.localHint, durable: s.durable, batchId: s.batchId, question: s.question, answer: s.answer };
      const r = this.rev(c.id);
      if (s.status === "draft" && !s.answer) {
        // the server's words for a draft are words this page sent: the page's own are the same or newer
        comments.push({ ...c, ...fields, text: r === 0 ? s.text : c.text });
        continue;
      }
      // frozen (sent, queued, finished, asked) or answered: the server's words are what a Send carried. Based on what the page holds when it
      // was not changed since the Send of this page that carried it (or since the page loaded); otherwise the newer words stay as a new draft
      const sent = this.sentWith.get(c.id);
      const based = r === 0 || sent === r || c.text === s.text;
      comments.push({ ...c, ...fields, text: s.text });
      if (!based && (c.text || "").trim()) {
        const id = tieId(c.id);
        comments.push({ id, kind: c.kind, anchor: c.anchor, pin: c.pin, pinNo: null, text: c.text, status: "draft", tiedTo: c.id });
        this.typed(id);
        unsaved = true;
      }
      this.revs.set(c.id, 0); // what it shows now is the server's
      this.sentWith.delete(c.id);
    }
    // one the server holds and this page does not, and did not delete (a save from before a reload that landed after this page loaded): shown
    for (const s of view.comments)
      if (!mine.has(s.id) && !this.gone.has(s.id)) {
        comments.push(s);
        this.theirs.add(s.id);
      }
    const n = this.#note(local.note || "", view.note || "", at, Number.isFinite(view.seq) ? view.seq : -1);
    // the box took this state's note, or merged its words into it: based on it (a note the server gave back in it is not merged again)
    if ((n.based || n.note === (view.note || "")) && Number.isFinite(view.seq)) this.noteSeen = view.seq;
    return { comments, note: n.note, unsaved: unsaved || n.unsaved };
  }

  /** The note box after server state whose note is `theirs` arrived (`at`: what the request it answers was sent with; `seq`: that state's). */
  #note(mine, theirs, at, seq) {
    // a Send that carries the box is in flight (its note is read only): the box is the Send's until its answer, which is not this state
    if (this.sendsOpen > 0 && !at?.sends) return { note: mine, unsaved: false };
    let unsaved = false;
    let based = false; // the box is now based on `theirs` (took it, or merged what was typed since into it)
    // the note: taken when the box is what the server's state is based on, merged when the person typed since
    let note = mine;
    // the answer of a draft save shows the note of a later request of this page (it landed first): the box is that or newer, nothing of
    // the server's own in it. Only a later one: an earlier note of this page can be one the server gave back (a queued note at a lease expiry)
    const own = at?.carries && !at.sends && at.wire != null ? this.notesSent.findLast((x) => x.text === theirs && x.wire > at.wire && x.rev >= this.stored.rev) : null; // (not one from before the server last set the box)
    if (own && theirs !== mine) {
      if (own.rev === this.noteRev) note = theirs;
      else unsaved = true;
    } else if (at?.note) {
      // the box is what this request carried, or what the server last held with no keystroke since (it can have emptied the box itself,
      // as a Send that took the note): the server's note is based on it. Otherwise the words typed since are merged with the server's,
      // from whichever the box was based on last: this request's note, or the server's if it set the box after this request went out
      if (this.noteRev === at.note.rev || this.noteRev === this.stored.rev) note = theirs;
      else note = mergeNote(this.stored.rev > at.note.rev ? this.stored.text : at.note.text, theirs, note);
      based = true;
      if (note === theirs) this.stored = { rev: this.noteRev, text: theirs, seq };
      else {
        // the server holds the note this request stored, or its own (joined) one, which is no revision of the box
        this.stored = at.carries && theirs === at.note.text ? { rev: at.note.rev, text: at.note.text, seq } : { rev: -1, text: theirs, seq };
        unsaved = true;
      }
    } else if (this.open === 0 && this.noteRev === this.stored.rev) {
      note = theirs; // nothing typed since the server last held the box, nothing in flight: the server's note is based on it
      this.stored = { rev: this.noteRev, text: theirs, seq };
    } else if (note !== theirs) unsaved = true;
    if (note !== mine) {
      // the box changed without a keystroke: a new revision all the same, so a save of it is never taken for the note a Send already took
      this.noteRev++;
      if (this.stored.text === note) this.stored = { ...this.stored, rev: this.noteRev };
    }
    return { note, unsaved, based };
  }
}
