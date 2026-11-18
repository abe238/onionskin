// A model check of "nothing typed is lost or sent twice": seeded random interleavings of a person typing in comments and the note, adding and
// deleting comments, the autosave and the leave-page save, Send, Take back, Stop, reload, an agent taking a batch and finishing it, against
// the real Sessions async methods (src/session.js) with the anchor worker's answers released by the test (the `anchors` seam), a network
// that delivers each request and answer when the sequence says (late, out of order, or lost), and an event stream that is up or down. The
// simulated page applies web/src/drafts.js exactly as web/src/App.jsx does (the same Drafts class), and mirrors App.jsx's Send, autosave,
// flush-before-action and lost-answer check. After every sequence settles: every word the person typed and did not delete is present
// exactly once, as a draft, in the note box, or with the agent (a waiting, delivered or queued batch, or a finished one); a draft the page
// made to keep words typed into a comment the server says was sent with other words may repeat that comment's words (the linked pair).
// ONIONSKIN_SIM_N sequences (default 4000) from seed ONIONSKIN_SIM_FROM (1000); ONIONSKIN_SIM_SEED to replay one. A failure prints the seed and the shortest failing sequence.
// ONIONSKIN_SIM_BASE=<a checkout of 3c7d3a6> runs the 3c7d3a6 server with a model of the 3c7d3a6 page instead (a model, ported by hand). Temp dirs only.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { docxBytes, tmpdir } from "./helpers/zipbuild.js";

const root = tmpdir("da-sim-");
// every session write fsyncs (src/paths.js writeStateFile): that system time, not the model, would be most of this test's CPU; durability
// is not what this test checks, so this process writes without it (temp dirs only)
fs.fsyncSync = () => {};
process.env.ONIONSKIN_STATE_DIR = path.join(root, "st");
process.env.ONIONSKIN_NO_SOFFICE = "1";
const BASE = process.env.ONIONSKIN_SIM_BASE || null;
const src = BASE ? path.join(BASE, "src") : path.join(import.meta.dirname, "..", "src");
const { Sessions } = await import(path.join(src, "session.js"));
const { ensureStateDir } = await import(path.join(src, "paths.js"));
const { anchorWork } = await import("../src/anchor-work.js");
const { Drafts } = await import("../web/src/drafts.js");
const { noteAfterStop } = await import("../web/src/stage.js");
ensureStateDir();
after(() => fs.rmSync(root, { recursive: true, force: true }));

const PARAS = ["The first paragraph.", "The second paragraph.", "A third one here."];
const DOC = docxBytes(PARAS);
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
const clone = (v) => JSON.parse(JSON.stringify(v));
const words = (t) => (t || "").match(/w\d+/g) || [];
const toWire = (c) => ({ id: c.id, kind: c.kind, text: c.text, anchor: c.anchor, pin: c.pin, pinNo: c.pinNo });
const anchorOf = (i) => ({ location: { blockPath: [i] }, quote: PARAS[i], paraText: PARAS[i], hitKind: "paragraph" });
const drain = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
};

/** One sequence: a fresh file and server, one page (then the page after each reload). */
class World {
  constructor(n) {
    this.trace = [];
    this.jobs = []; // anchor work waiting to be released
    this.net = []; // requests in flight: {page, call, arrived, result, lost}
    this.streamUp = true;
    this.pages = []; // every page still open: the editing one (this.page) and windows that lost editing to another
    this.live = new Set(); // words typed and not deleted
    this.ties = new Map(); // a page-made draft -> {to: the comment whose words it repeats, words: those words}
    this.finishedNotes = [];
    this.finished = []; // what each finished run delivered: [{comments: [{id, text}], note}], so a word delivered twice is seen
    this.leftAsked = new Set(); // words on a page the person left although it asked first (its unconfirmed words were then theirs to drop)
    this.word = 0;
    this.S = new Sessions(BASE ? {} : { anchors: (data) => this.#anchors(data) });
    const f = path.join(root, `f${n}.docx`);
    fs.writeFileSync(f, DOC);
    this.file = f;
    const s = this.S.open(f);
    this.key = s.key;
    this.s = s;
    this.S.on("change", (x) => {
      if (x.key !== this.key || !this.streamUp) return;
      for (const p of this.pages) if (p.alive && p.ready) p.queue.push(clone(this.S.view(x)));
    });
    this.page = new (BASE ? OldPage : Page)(this, clone(this.S.view(s)));
    this.pages.push(this.page);
    this.S.claimEditor(this.key, this.page.tab); // its event stream claims editing (src/server.js /api/events)
  }
  #anchors(data) {
    return new Promise((res) =>
      this.jobs.push(() => {
        const bytes = data.source.bytes ?? fs.readFileSync(data.source.path);
        const sha = data.source.sha ?? sha256(bytes);
        res({ ok: true, sha, r: anchorWork({ format: data.format, bytes, sha, check: !!data.check, tasks: data.tasks, outline: !!data.outline, budget: 1e8 }) });
      }),
    );
  }
  newWord() {
    const w = `w${++this.word}`;
    this.live.add(w);
    return w;
  }
  /** A request of `page` to the server: answered when the sequence delivers it (a page that was left gets nothing). */
  request(page, call, label = "") {
    return new Promise((resolve, reject) => this.net.push({ page, call, label, arrived: false, result: null, resolve, reject }));
  }
  arrive(r) {
    r.arrived = true;
    if (process.env.ONIONSKIN_SIM_DEBUG) console.log("# arrive", r.call.toString().slice(0, 80));
    Promise.resolve()
      .then(r.call)
      .then(
        () => (r.result = { ok: true, view: clone(this.S.view(this.s)) }),
        (e) => (r.result = { ok: false, err: e }),
      );
  }
  answer(r, lose = false) {
    this.net.splice(this.net.indexOf(r), 1);
    if (TRACE) console.log(`#    answer ${r.page.tab} ${r.label} ${lose ? "LOST" : JSON.stringify({ ok: r.result.ok, note: r.result.view?.note, seq: r.result.view?.seq, sent: r.result.view?.sent })}`);
    if (!r.page.alive) return;
    if (process.env.ONIONSKIN_SIM_DEBUG) console.log("# answer", lose ? "lost" : JSON.stringify({ ok: r.result.ok, note: r.result.view?.note, cs: r.result.view?.comments.map((c) => c.id + ":" + c.status), sent: r.result.view?.sent, st: r.result.err?.status, msg: r.result.err?.message?.slice(0, 80) }), "page note", JSON.stringify(r.page.note));
    if (lose) return r.reject(Object.assign(new Error("Failed to fetch"), { status: undefined }));
    if (r.result.ok) r.resolve(r.result.view);
    else r.reject(Object.assign(new Error(r.result.err.message), { status: r.result.err.status ?? 500 }));
  }

  /** The actions possible now: [name, fn]. */
  actions() {
    const p = this.page;
    const a = [];
    const s = this.s;
    if (p.ready) {
      const editable = p.comments.filter((c) => c.status === "draft" && !c.answer && !p.held?.ids.has(c.id));
      for (const c of editable.slice(0, 3)) a.push([`type ${c.id}`, () => p.type(c.id)]);
      if (!p.held?.note && !p.busy) a.push(["type note", () => p.typeNote()]);
      if (p.comments.length < 6) a.push(["add", () => p.add()]);
      if (editable.length) a.push([`delete ${editable[0].id}`, () => p.del(editable[0].id)]);
      if (p.timer && !p.held) a.push(["autosave", () => p.saveNow()]);
      if (p.pending || p.sending) a.push(["hide (leave-page save)", () => p.saveNow({ keepalive: true })]);
      if (!p.sending && !p.busy) a.push(["Send", () => p.send()]); // App.jsx: no Send while Take back, Stop, Revert or Close is in flight
      // App.jsx: one of Take back, Stop, Revert, Close at a time, and none during a Send
      if (["stranded", "working", "queued"].includes(p.session.state) && !p.sending && !p.busy) a.push(["Take back", () => p.takeBack()]);
      if (["working", "queued"].includes(p.session.state) && !p.sending && !p.busy) a.push(["Stop", () => p.stop()]);
      a.push(["reload", () => this.reload()]);
      if (p.queue.length) a.push(["event", () => p.onState(p.queue.shift())]);
      if (!BASE) a.push(["second window takes over", () => this.second()]);
    }
    for (const r of this.net.slice(0, 3)) {
      const i = this.net.indexOf(r);
      if (!r.arrived) a.push([`arrive #${i}`, () => this.arrive(r)], [`lose request #${i}`, () => this.answer(r, true)]);
      else if (r.result) a.push([`answer #${i}`, () => this.answer(r)], [`lose answer #${i}`, () => this.answer(r, true)]);
    }
    if (this.jobs.length) a.push(["worker", () => this.jobs.shift()()]);
    if (s.pending && !s.delivered && !s.pending.instructions?.review) a.push(["agent takes it", () => this.S.poll(this.key, { holder: "A" })]);
    if (s.delivered && !s.delivered.local) a.push(["agent finishes", () => this.finish()], ["lease expires", () => this.expire()]);
    for (const o of this.pages) if (o !== p && o.alive && o.ready && o.queue.length) a.push(["event in the other window", () => o.onState(o.queue.shift())]);
    a.push([this.streamUp ? "stream down" : "stream up", () => this.toggleStream()]);
    return a;
  }
  /** The agent stops answering: its lease runs out (src/session.js tick): the batch waits again, queued comments and note are drafts again. */
  expire() {
    this.s.delivered.lease.expiresAt = 0;
    this.S.tick();
  }
  toggleStream() {
    this.streamUp = !this.streamUp;
    for (const p of this.pages) {
      p.queue = [];
      if (this.streamUp && p.alive && p.ready) p.queue.push(clone(this.S.view(this.s))); // the state on connect
    }
  }
  finish() {
    const d = this.s.delivered;
    this.finishedNotes.push(d.batch.instructions?.overall_note || "");
    this.finished.push({ comments: d.batch.instructions.comments.map((c) => ({ id: c.id, text: this.s.comments.find((x) => x.id === c.id)?.text ?? "" })), note: d.batch.instructions?.overall_note || "" });
    this.S.done(this.key, { summary: "ok", results: d.batch.instructions.comments.map((c) => ({ comment_id: c.id, status: "done" })) }, { holder: d.lease.holder, token: d.lease.token, batchId: d.batch.batch_id });
  }
  reload() {
    const old = this.page;
    // the leave-page question (App.jsx unsent): when it asks, the person leaves anyway; what only that page held was theirs to drop, so a
    // lost request of a page that asked is allowed to lose those words. One that did not ask held nothing the server had not confirmed
    const asks = !BASE && (old.pending || old.sending || !!old.saving || old.d.dirty(old.comments));
    if (old.pending || (old.sending && !BASE)) old.saveNow({ keepalive: true }); // the save on the way out
    if (asks) for (const w of [...words(old.note), ...old.comments.flatMap((c) => words(c.text))]) this.leftAsked.add(w);
    old.alive = false;
    old.left = asks ? "asked" : "quiet";
    this.page = new (BASE ? OldPage : Page)(this, null);
    this.pages = [...this.pages.filter((p) => p.alive), this.page];
  }
  /** A second window opens the file and presses Edit here instead: the first stays open, read only, and hands over what it had not saved. */
  second() {
    this.page = new Page(this, null);
    this.pages = [...this.pages.filter((p) => p.alive), this.page];
  }

  async step(choice) {
    const a = this.actions();
    const [name, fn] = a[choice % a.length];
    this.trace.push(name);
    fn();
    await drain();
  }
  /** A named step: the first action possible now whose name starts with `want` (none: the person could not do it, as typing into a locked comment). "net": everything in flight goes through once. */
  async named(want) {
    if (want === "net") {
      for (let i = 0; i < 6; i++) {
        for (const r of [...this.net]) r.arrived ? r.result && this.answer(r) : this.arrive(r);
        while (this.jobs.length) this.jobs.shift()();
        await drain();
      }
      return this.trace.push("net");
    }
    if (want === "worker" && BASE) {
      // the 3c7d3a6 server has no seam: its real anchor worker answers on its own; wait for what arrived to be answered
      for (let i = 0; i < 300 && this.net.some((r) => r.arrived && !r.result); i++) await new Promise((r) => setTimeout(r, 10));
      return this.trace.push("worker");
    }
    const hit = this.actions().find(([name]) => name.startsWith(want));
    this.trace.push(hit ? hit[0] : `(${want}: not possible)`);
    if (hit) hit[1]();
    await drain();
  }
  /** Everything in flight goes through, no more losses, the stream up, until nothing changes. */
  async settle() {
    if (!this.streamUp) this.toggleStream();
    for (let round = 0; round < 400; round++) {
      let moved = false;
      for (const r of [...this.net]) {
        if (!r.arrived) (this.arrive(r), (moved = true));
        else if (r.result) (this.answer(r), (moved = true));
      }
      while (this.jobs.length) (this.jobs.shift()(), (moved = true));
      await drain();
      const p = this.page;
      for (const o of this.pages) if (o.alive && o.ready && o.queue.length) (o.onState(o.queue.shift()), (moved = true));
      if (p.ready && !p.held && (p.timer || p.pending) && !p.saving) (p.saveNow(), (moved = true));
      await drain();
      if (TRACE && moved) this.dump(`settle round ${round}`);
      if (!moved && !this.net.length && !this.jobs.length && !this.pages.some((o) => o.alive && o.queue.length) && !p.pending && !p.saving && !p.sending && !p.busy && p.ready) return;
    }
    throw new Error("did not settle");
  }

  dump(label) {
    const s = this.s;
    const p = this.page;
    console.log(`# -- ${label}`);
    console.log(`#    server note=${JSON.stringify(s.note)} queued=${JSON.stringify(s.queuedNote)} pending=${JSON.stringify(s.pending?.instructions?.overall_note ?? null)} delivered=${JSON.stringify(s.delivered?.batch.instructions?.overall_note ?? null)} given=${JSON.stringify(s.noteGiven ?? null)} seq=${s.seq} comments=${JSON.stringify(s.comments.map((c) => [c.id, c.status, c.text]))}`);
    console.log(`#    page ${p.tab} ready=${p.ready} note=${JSON.stringify(p.note)} noteRev=${p.d.noteRev} stored=${JSON.stringify(p.d.stored)} seen=${p.d.seen} held=${!!p.held} busy=${p.busy} out=${p.out} pending=${p.pending} comments=${JSON.stringify((p.comments || []).map((c) => [c.id, c.status, c.text]))}`);
    console.log(`#    net ${JSON.stringify(this.net.map((r) => [r.page.tab, r.label, r.arrived, !!r.result]))} jobs=${this.jobs.length} finished=${JSON.stringify(this.finishedNotes)}`);
  }
  /** The conservation property, on what the server holds once the page holds nothing it has not saved. */
  check() {
    const s = this.s;
    const p = this.page;
    const fail = (m) => {
      throw new Error(m);
    };
    // the page shows what the server holds
    const drafts = (l) => JSON.stringify(l.filter((c) => c.status === "draft").map((c) => [c.id, c.text]));
    if (drafts(p.comments) !== drafts(s.comments)) fail(`the page's drafts ${drafts(p.comments)} are not the server's ${drafts(s.comments)}`);
    if ((p.note || "") !== (s.note || "")) fail(`the page's note ${JSON.stringify(p.note)} is not the server's ${JSON.stringify(s.note)}`);
    const root = (id) => {
      while (this.ties.has(id)) id = this.ties.get(id).to;
      return id;
    };
    const seen = new Map(); // word -> places, once per time it is there (a word twice in one note box is there twice)
    const put = (text, where) => {
      for (const w of words(text)) {
        const l = seen.get(w) || [];
        l.push(where);
        seen.set(w, l);
      }
    };
    // a page-made draft repeats the words of the sent comment it was made for: those count where that comment is (the person sees both)
    // so does a draft the server made at a handover for words typed into a comment that another window had changed (src/session.js handOver)
    for (const c of s.comments) {
      const m = /^(.*)~h[0-9a-f]{6}$/.exec(c.id);
      const to = m && s.comments.find((x) => x.id === m[1]);
      if (to && !this.ties.has(c.id)) this.ties.set(c.id, { to: to.id, words: new Set(words(to.text)) });
    }
    const own = (c) => {
      const tie = this.ties.get(c.id);
      return tie ? words(c.text).filter((w) => !tie.words.has(w)).join(" ") : c.text;
    };
    // a finished comment counts in the finished run that delivered it (below), so a comment delivered twice is in two places
    for (const c of s.comments) if (!["done", "declined"].includes(c.status)) put(own(c), `comment ${root(c.id)}`);
    this.finished.forEach((f, i) => f.comments.forEach((c) => put(own(c), `finished run ${i}, comment ${root(c.id)}`)));
    put(s.note, "note box");
    put(s.queuedNote, "queued note");
    if (s.pending) put(s.pending.instructions?.overall_note, "waiting batch note");
    if (s.delivered) put(s.delivered.batch.instructions?.overall_note, "delivered batch note");
    this.finishedNotes.forEach((n, i) => put(n, `finished note ${i}`));
    // a window that lost editing and could not hand its words over keeps them on its page, read only, with Copy my comments
    const kept = new Set();
    for (const o of this.pages) if (o.alive && o !== p && o.handing === "failed") for (const w of [...words(o.note), ...o.comments.flatMap((c) => words(c.text))]) kept.add(w);
    for (const w of this.live) {
      const l = seen.get(w) || [];
      if (l.length === 0 && kept.has(w)) continue; // not stored, but on that page with Copy my comments
      if (l.length === 0 && this.leftAsked.has(w)) continue; // the person left although the page asked first
      if (l.length === 0) fail(`${w} was typed and is gone`);
      if (l.length > 1) fail(`${w} is in ${l.length} places: ${l.join(", ")}`);
    }
  }
}

/** The page as web/src/App.jsx runs it, with the same web/src/drafts.js. */
class Page {
  constructor(w, view) {
    this.w = w;
    this.alive = true;
    this.tab = `t${++Page.n}`;
    this.queue = []; // this page's event stream, not delivered yet
    this.ro = false; // another window edits the file now
    this.handing = null; // null | "sending" | "failed" (App.jsx handOver)
    this.wire = 0;
    this.held = null;
    this.sending = false;
    this.pending = false; // draftPendingRef
    this.timer = false; // an autosave is scheduled
    this.saving = null;
    this.busy = 0; // Take back or Stop pressed and not done (App.jsx rewritingRef)
    this.out = 0; // ... and its request out (App.jsx outRef)
    this.ready = false;
    this.d = new Drafts();
    if (view) this.load(view);
    else this.boot();
  }
  load(view) {
    this.session = view;
    this.comments = clone(view.comments);
    this.note = view.note || "";
    this.d.loaded(this.note, this.comments, view.seq);
    this.ready = true;
  }
  async boot() {
    // main.jsx: GET /api/bootstrap (it waits for this file's requests in flight) and the claim of editing; asked again until it answers
    for (;;) {
      try {
        const v = await this.w.request(this, () => this.w.S.settled(this.w.key).then(() => this.w.S.claimEditor(this.w.key, this.tab, { takeover: true })));
        this.load(v);
        if (this.w.streamUp) this.queue.push(clone(this.w.S.view(this.w.s))); // its event stream opens once it has loaded
        return;
      } catch {}
    }
  }
  apply(view, at = null) {
    // App.jsx applyServer
    if (process.env.ONIONSKIN_SIM_DEBUG) console.log("# apply", JSON.stringify({ at, noteRev: this.d.noteRev, stored: this.d.stored, open: this.d.open, note: this.note, theirs: view.note, cs: view.comments.map((c) => c.id + ":" + c.status), mine: this.comments.map((c) => c.id) }));
    const r = this.d.reconcile({ comments: this.comments, note: this.note }, view, at);
    this.comments = r.comments;
    this.note = r.note;
    for (const c of r.comments) if (c.tiedTo && !this.w.ties.has(c.id)) this.w.ties.set(c.id, { to: c.tiedTo, words: new Set(words(r.comments.find((x) => x.id === c.tiedTo)?.text)) });
    if (r.unsaved && !this.pending) this.soon();
  }
  onState(view) {
    if (TRACE) console.log(`#    event ${this.tab} seq=${view.seq} note=${JSON.stringify(view.note)} editor=${view.editor}`);
    if (this.handing) return; // App.jsx merge: handing over, or it failed: the words stay
    if (view.editor && view.editor !== this.tab) {
      if (!this.ro && this.d.dirty(this.comments)) {
        if (!this.sending) return this.handOver();
        this.ro = true;
        this.handing = "waiting"; // App.jsx: after its Send
        return;
      }
      this.ro = true;
      this.session = view;
      const r = this.d.reconcile({ comments: this.comments, note: this.note }, view, null, { wholesale: true });
      this.comments = r.comments;
      this.note = r.note;
      return;
    }
    this.session = view;
    this.apply(view);
  }
  /** App.jsx handOver: what this window had not saved goes to POST /api/handover; it stays on the page until that went through. */
  handOver() {
    this.ro = true;
    this.handing = "sending";
    this.timer = false;
    this.pending = false;
    const body = this.d.unsaved(this.comments, this.note);
    this.w.request(this, () => this.w.S.inTurn(this.w.key, () => this.w.S.handOver(this.w.key, this.tab, body)), `handover ${JSON.stringify(body.note)}`).then(
      (v) => {
        this.handing = null;
        const r = this.d.reconcile({ comments: this.comments, note: this.note }, v, null, { wholesale: true });
        this.comments = r.comments;
        this.note = r.note;
      },
      () => (this.handing = "failed"),
    );
  }
  /** src/server.js: the routes that change the session refuse a tab that is not the editor (409 not_editor). */
  edit(fn) {
    return () => {
      this.w.S.requireEditor(this.w.key, this.tab);
      return fn();
    };
  }
  soon() {
    this.pending = true;
    if (!this.held) this.timer = true;
  }
  touch(id, text) {
    this.comments = this.comments.map((c) => (c.id === id ? { ...c, text } : c));
    this.d.typed(id);
    this.soon();
  }
  type(id) {
    const c = this.comments.find((x) => x.id === id);
    this.touch(id, `${c.text} ${this.w.newWord()}`);
  }
  typeNote() {
    this.note = this.note ? `${this.note} ${this.w.newWord()}` : this.w.newWord();
    this.d.typedNote();
    this.soon();
  }
  add() {
    const id = `c${++Page.ids}`;
    this.comments = [...this.comments, { id, kind: "element", text: this.w.newWord(), status: "draft", anchor: anchorOf(Page.ids % 3), pin: null, pinNo: null }];
    this.d.typed(id);
    this.soon();
  }
  del(id) {
    this.d.removed(id);
    for (const w of words(this.comments.find((c) => c.id === id).text)) if (![...this.comments].some((c) => c.id !== id && words(c.text).includes(w)) && !words(this.note).includes(w)) this.w.live.delete(w);
    this.comments = this.comments.filter((c) => c.id !== id);
    this.soon();
  }
  saveNow({ keepalive = false } = {}) {
    this.timer = false;
    this.pending = false;
    const note = this.out ? undefined : this.note; // App.jsx outRef
    const wire = ++this.wire;
    const at = this.d.begin({ note, carriesNote: note !== undefined, wire });
    const body = { comments: this.comments.map(toWire), note, noteRev: this.d.noteRev, seen: this.d.seen, noteSeen: this.d.noteSeen, rev: wire, tab: this.tab };
    if (process.env.ONIONSKIN_SIM_DEBUG) console.log("# save", this.tab, wire, JSON.stringify(note), "out", this.out, "busy", this.busy, keepalive ? "keepalive" : "");
    const req = this.w.request(this, this.edit(() => this.w.S.setDraftAsync(this.w.key, body)), `save#${wire} note=${JSON.stringify(note)} noteRev=${body.noteRev} seen=${body.seen}`).then(
      (v) => {
        this.d.end(at, true);
        this.apply(v, at);
        return true;
      },
      (e) => {
        this.d.end(at, false);
        if (e.status !== 413 || keepalive) this.soon();
        return false;
      },
    );
    const mine = req.finally(() => this.saving === mine && (this.saving = null));
    this.saving = mine;
    return mine;
  }
  async flush() {
    while (this.saving) await this.saving;
    if (this.pending && !this.held) return (await this.saveNow()) && this.flush();
    return true;
  }
  async send() {
    this.sending = true;
    const ids = new Set(this.comments.filter((c) => c.status === "draft").map((c) => c.id));
    this.held = { ids, note: true };
    this.timer = false;
    this.pending = false;
    const wire = ++this.wire;
    const body = { baseSha: this.session.baseSha, comments: this.comments.map(toWire), note: this.note, edits: [], rev: wire, noteRev: this.d.noteRev, seen: this.d.seen, noteSeen: this.d.noteSeen, sends: [...ids], tab: this.tab };
    const at = this.d.begin({ note: body.note, carriesNote: true, sends: ids, wire });
    let failed = null;
    try {
      let view;
      try {
        view = await this.w.request(this, this.edit(() => this.w.S.sendAsync(this.w.key, body)), `send#${wire} note=${JSON.stringify(body.note)} noteRev=${body.noteRev} seen=${body.seen}`);
      } catch (e) {
        if (e.status != null) throw e;
        this.held = { ...this.held, checking: true };
        view = await this.checkSent();
        if (!(view.sent?.[this.tab]?.rev >= wire)) throw e;
      }
      this.d.end(at, true);
      at.done = true;
      this.session = view;
      this.apply(view, at);
    } catch (e) {
      failed = e;
    } finally {
      if (!at.done) this.d.end(at, false);
      this.held = null;
      this.sending = false;
      if (this.handing === "waiting") return this.handOver();
      if (this.pending || failed) this.soon();
    }
  }
  async checkSent() {
    for (;;) {
      try {
        return await this.w.request(this, () => this.w.S.settled(this.w.key));
      } catch {}
    }
  }
  /** Take back (post("takeback")) and Stop (agentAct): what is typed is saved first; the answer goes in through reconcile. */
  async rewrite(call) {
    this.busy++;
    try {
      if (!(await this.flush())) return; // App.jsx: not saved first, so the action does not go
      const at = this.d.begin({ rewrites: true });
      this.out++;
      try {
        const v = await this.w.request(this, call);
        this.d.end(at, true);
        this.session = v;
        this.apply(v, at);
      } catch (e) {
        this.d.end(at, false);
        if (e.status == null) {
          const v = await this.checkSent(); // App.jsx afterLost
          this.session = v;
          this.apply(v, at);
        }
      } finally {
        this.out--;
      }
    } finally {
      this.busy--;
    }
  }
  takeBack() {
    return this.rewrite(this.edit(() => this.w.S.inTurn(this.w.key, () => this.w.S.takeBack(this.w.key))));
  }
  stop() {
    // src/agent-runner.js stopAndTakeBack: the take back runs at once, outside the file's turn
    return this.rewrite(this.edit(() => (this.w.s.delivered || this.w.s.pending) && this.w.S.takeBack(this.w.key)));
  }
}
Page.n = 0;
Page.ids = 0;

/** A model of the 3c7d3a6 page (web/src/App.jsx at that commit), for ONIONSKIN_SIM_BASE: ported by hand, so a model, not the page. */
class OldPage extends Page {
  constructor(w, view) {
    super(w, view);
    this.unsure = null;
  }
  apply(view) {
    this.comments = this.comments.map((c) => {
      const s = view.comments.find((x) => x.id === c.id);
      if (!s) return c;
      return { ...c, status: s.status, answer: s.answer, text: s.status === "draft" && !s.answer ? c.text : s.text };
    });
  }
  saveNow({ keepalive = false } = {}) {
    this.timer = false;
    this.pending = false;
    const unsure = this.unsure;
    const note = (keepalive && this.held?.note) || unsure ? undefined : this.note;
    const body = { comments: this.comments.map(toWire), note, rev: ++this.wire, tab: this.tab };
    const req = this.w.request(this, () => this.w.S.setDraftAsync(this.w.key, body)).then(
      (v) => {
        if (!keepalive && unsure && this.unsure === unsure) {
          this.unsure = null;
          if (wentThrough(v, unsure)) {
            if (this.note === unsure.note) this.note = "";
            this.apply(v);
          } else this.soon();
        }
      },
      () => this.soon(),
    );
    const mine = req.finally(() => this.saving === mine && (this.saving = null));
    this.saving = mine;
    return mine;
  }
  async send() {
    this.sending = true;
    const ids = new Set(this.comments.filter((c) => c.status === "draft").map((c) => c.id));
    this.held = { ids, note: true };
    this.timer = false;
    this.pending = false;
    const body = { baseSha: this.session.baseSha, comments: this.comments.map(toWire), note: this.note, edits: [], rev: ++this.wire, tab: this.tab };
    let failed = null;
    try {
      let view;
      try {
        view = await this.w.request(this, () => this.w.S.sendAsync(this.w.key, body));
      } catch (e) {
        if (e.status != null) throw e;
        this.unsure = { ids, note: body.note };
        view = await this.w.request(this, () => this.w.S.settled(this.w.key)).catch(() => null);
        if (!view) throw e;
        this.unsure = null;
        if (!wentThrough(view, { ids, note: body.note })) throw e;
      }
      this.unsure = null;
      this.note = "";
      this.session = view;
      this.apply(view);
    } catch (e) {
      failed = e;
    } finally {
      this.held = null;
      this.sending = false;
      if (this.pending || (failed && failed.status == null)) this.soon();
    }
  }
  async takeBack() {
    try {
      const v = await this.w.request(this, () => this.w.S.inTurn(this.w.key, () => this.w.S.takeBack(this.w.key)));
      this.session = v;
      this.note = v.note || "";
    } catch {}
  }
  async stop() {
    const due = this.pending;
    this.timer = false;
    this.pending = false;
    try {
      const v = await this.w.request(this, () => (this.w.s.delivered || this.w.s.pending) && this.w.S.takeBack(this.w.key));
      this.session = v;
      this.note = noteAfterStop(v.note || "", this.note || "");
      this.soon();
    } catch {
      if (due) this.soon();
    }
  }
}
function wentThrough(view, { ids, note }) {
  return view.comments.some((c) => ids.has(c.id) && c.status !== "draft") || (!ids.size && !!note && !view.note);
}

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let worlds = 0;
/** Runs `ops` (one number per step: which of the actions possible then). Returns null, or {error, trace}. */
let TRACE = false; // ONIONSKIN_SIM_TRACE=1: the shortest failing sequence is run once more with the state after every step
async function run(ops) {
  const w = new World(worlds++);
  try {
    for (const o of ops) {
      await (typeof o === "string" ? w.named(o) : w.step(o));
      if (TRACE) w.dump(w.trace.at(-1));
    }
    await w.settle();
    if (TRACE) w.dump("settled");
    w.check();
    return null;
  } catch (e) {
    if (process.env.ONIONSKIN_SIM_SEED) console.log("# state", JSON.stringify({ comments: w.s.comments.map((c) => [c.id, c.status, c.text]), note: w.s.note, queuedNote: w.s.queuedNote, pending: w.s.pending?.instructions?.overall_note, page: w.page.comments.map((c) => [c.id, c.status, c.text]), pageNote: w.page.note, finished: w.finishedNotes }));
    return { error: e.message, trace: w.trace };
  } finally {
    w.page.alive = false;
    for (const r of w.net) r.page.alive = false;
    try {
      w.S.close(w.key);
    } catch {}
    fs.rmSync(w.file, { force: true });
  }
}
/** The shortest sequence found that still fails: ops removed one block at a time while it keeps failing. */
async function shrink(ops) {
  let best = ops;
  for (let size = Math.ceil(best.length / 2); size >= 1; size = Math.floor(size / 2)) {
    for (let i = 0; i + size <= best.length; ) {
      const cand = [...best.slice(0, i), ...best.slice(i + size)];
      if (await run(cand)) best = cand;
      else i += size;
    }
  }
  return best;
}

// The review of 3c7d3a6, as sequences of this model (ONIONSKIN_SIM_BASE=<3c7d3a6 checkout> shows each failing there)
const REVIEW = {
  // H1: a leave-page save numbered after the Send arrives before it; the Send's note must go out
  H1: ["add", "type note", "autosave", "net", "type note", "Send", "hide", "arrive #1", "net"],
  // H2: a note typed after a Send, Take back pressed before the autosave
  H2: ["add", "type note", "autosave", "net", "Send", "net", "type note", "Take back"],
  // H3: the Send's answer and the check after it lost with the stream down; the person corrects the comment
  H3: ["stream down", "add", "autosave", "net", "Send", "arrive #0", "worker", "lose answer #0", "lose request #0", "type c", "type c"],
};
for (const [name, steps] of Object.entries(REVIEW))
  test(`the review's ${name} as a sequence: nothing typed is lost or sent twice`, { timeout: 60_000 }, async () => {
    const bad = await run(steps);
    if (bad) console.log(`# ${name}: ${bad.error}\n#   ${bad.trace.join(" | ")}`);
    assert.equal(bad, null);
  });

test("random interleavings of typing, autosave, Send, Take back, Stop, reload, the agent, lost and late answers: nothing typed is lost or sent twice", { timeout: Number(process.env.ONIONSKIN_SIM_TIMEOUT_MS || 600_000) }, async () => {
  const n = Number(process.env.ONIONSKIN_SIM_N || 4000);
  const from = Number(process.env.ONIONSKIN_SIM_FROM || 1000);
  const only = process.env.ONIONSKIN_SIM_SEED;
  const seeds = only ? [Number(only)] : Array.from({ length: n }, (_, i) => from + i);
  const t0 = process.cpuUsage();
  const failures = [];
  for (const seed of seeds) {
    const r = rng(seed);
    const ops = Array.from({ length: 12 + Math.floor(r() * 40) }, () => Math.floor(r() * 1e6));
    const bad = await run(ops);
    if (!bad) continue;
    const short = await shrink(ops);
    TRACE = !!process.env.ONIONSKIN_SIM_TRACE;
    const again = await run(short);
    TRACE = false;
    failures.push({ seed, error: (again || bad).error, steps: (again || bad).trace });
    if (failures.length >= 3) break;
  }
  const cpu = process.cpuUsage(t0);
  console.log(`# ${seeds.length} sequences${BASE ? " (3c7d3a6 server and page model)" : ""}, ${Math.round((cpu.user + cpu.system) / 1000)} ms CPU, ${failures.length} failing`);
  for (const f of failures) console.log(`# seed ${f.seed}: ${f.error}\n#   ${f.steps.join(" | ")}`);
  assert.equal(failures.length, 0, `failing seeds: ${failures.map((f) => f.seed).join(", ")}`);
});
