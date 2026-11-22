// Markdown slice 2 through the server's seams: the person's typed edit goes with Send as ONE exact splice of the version the page loaded
// ({from, to, old, new, sha256}), checked like an agent's replacement and written before the comments are delivered; the agent is told
// about it as a user edit that is already in the file. Comments made before the edit are carried by exact arithmetic (a touched one
// is left for the person to select again), a comment made on the draft resolves on the bytes the Send writes, a changed file refuses and
// writes nothing, Revert after an agent run gives back the bytes that held the typed edit. Temp dirs and a temporary HOME only.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { tmpdir } from "./helpers/zipbuild.js";
const ev = (id, from, to, src) => (typeof id === "string" ? crypto.createHash("sha256").update(`${id}\n${from}\n${to}\n${src}`, "utf8").digest("hex") : undefined); // the selection's evidence (src/anchors.js mdEvidence)

const root = fs.realpathSync(tmpdir("md-edit-"));
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE = path.join(root, "st");
const HOME = path.join(root, "home");
fs.mkdirSync(path.join(HOME, ".local", "bin"), { recursive: true });
process.env.ONIONSKIN_STATE_DIR = STATE;
process.env.ONIONSKIN_LEASE_MS = "60000";
process.env.ONIONSKIN_TICK_MS = "100000";
process.env.ONIONSKIN_NO_SOFFICE = "1";
delete process.env.ONIONSKIN_PYTHON;
const { startServer } = await import("../src/server.js");
const { readMarkdown, sourceRange, MD_LIMITS } = await import("../src/markdown.js");
const { draftSplice } = await import("../web/src/md-edit.js");

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
let srv;
before(async () => {
  srv = await startServer();
});
after(() => {
  srv?.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

let n = 0;
function mdFile(text) {
  const dir = path.join(root, `d${++n}`);
  fs.mkdirSync(dir);
  const f = path.join(dir, `n${n}.md`);
  fs.writeFileSync(f, Buffer.from(text, "utf8"));
  return fs.realpathSync(f);
}
const cli = (args, { env = {} } = {}) =>
  new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(repo, "src", "cli.js"), ...args], { env: { PATH: `${path.join(HOME, ".local", "bin")}:${process.env.PATH}`, HOME, ONIONSKIN_STATE_DIR: STATE, ONIONSKIN_NO_SOFFICE: "1", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    c.stdout.on("data", (d) => (stdout += d));
    c.on("exit", (status) => resolve({ status, stdout }));
  });
function select(text, needle, inRun = 0) {
  const tree = readMarkdown(text);
  for (const r of tree.runs) {
    let at = -1;
    for (let k = 0; (at = r.display.indexOf(needle, at + 1)) >= 0; k++) {
      if (k !== inRun) continue;
      const m = sourceRange(tree, { startRun: r.id, startOffset: at, endRun: r.id, endOffset: at + needle.length });
      assert.ok(!m.refused && !m.block, m.reason);
      return m;
    }
  }
  throw new Error(`no run shows ${needle}`);
}
const comment = (id, version, m, rev) => ({ id, kind: "text", text: "fix", anchor: { location: { from: m.from, to: m.to, version, rev }, quote: m.quote, evidence: ev(rev, m.from, m.to, m.quote), prefix: "", suffix: "", format: "markdown" } });
const bodyOf = (t) => (t.charCodeAt(0) === 0xfeff ? t.slice(1) : t);
/** The page's splice of `draftSource` (the whole file's text with any BOM, line endings as the file has them) against the file's text. */
function spliceFor(text, draftSource) {
  const bom = text.charCodeAt(0) === 0xfeff ? "﻿" : "";
  const sp = draftSplice(bodyOf(text), bodyOf(draftSource), readMarkdown(text), readMarkdown(draftSource));
  assert.ok(sp.ok, sp.reason);
  return { edit: { from: sp.from, to: sp.to, old: sp.old, new: sp.new, sha256: sha(Buffer.from(text, "utf8")) }, newSha: sha(Buffer.from(bom + sp.source, "utf8")) };
}
async function open(text) {
  const file = mdFile(text);
  const s = await srv.sessions.openAsync(file);
  const rev = srv.sessions.loadForPage(s.key).mdRev; // as the page gets it with the file
  return { file, s, bytes: fs.readFileSync(file), rev };
}
async function sendAndPoll(o, payload) {
  const holder = `H${++n}`;
  const poll = srv.sessions.poll(o.s.key, { holder });
  await sendMd(o.s.key, { baseSha: o.s.baseSha, note: "", edits: [], ...payload });
  const batch = await poll.promise;
  return { ...o, batch, ticket: batch.lease_ticket, env: { ONIONSKIN_HOLDER: holder } };
}
const disk = (o) => fs.readFileSync(o.file);
// the page sends its typed edit with the revision number it got with the file (GET /api/file): the session's current one here
// (the record id of the file as it is now: what a page that loaded it holds)
// ... and the id of the draft state it sends (DID unless the test names another): comments made on that state name it too
const DID = "ab".repeat(12);
const sendMd = (key, p) => srv.sessions.sendAsync(key, p.mdEdit ? { ...p, mdEdit: { draftId: DID, ...p.mdEdit, ...(p.mdEdit.rev === undefined ? { rev: srv.sessions.loadForPage(key).mdRev } : {}) } } : p);
const reply = (d, body) => cli(["reply", d.file, "--lease", d.ticket, "--json", JSON.stringify(body)], { env: d.env });

test("d. a CRLF file with a BOM: one word edited and a typed Enter (CRLF) sent; every byte outside the splice is the same, and the agent is told it is already in the file", async () => {
  const text = "﻿line one\r\nsecond word here\r\nend\r\n";
  const o = await open(text);
  const draft = "﻿line one\r\nsecond thing\r\nnew here\r\nend\r\n";
  const { edit, newSha } = spliceFor(text, draft);
  const d = await sendAndPoll(o, { comments: [], mdEdit: edit });
  assert.ok(disk(d).equals(Buffer.from(draft, "utf8")), JSON.stringify(disk(d).toString()));
  assert.equal(sha(disk(d)), newSha, "the page's predicted version is the one written");
  assert.equal(disk(d)[0], 0xef);
  assert.equal(d.batch.base_sha256, newSha);
  const ue = d.batch.untrusted_document_evidence.user_edits;
  assert.equal(ue.length, 1);
  assert.equal(ue[0].already_in_file, true);
  assert.equal(ue[0].before, "word");
  const a = d.batch.untrusted_document_evidence.anchors.find((x) => x.id === ue[0].anchor_id);
  assert.equal(a.locator.source, "thing\r\nnew");
});

test("f. (slice 3) three comments made before the person's edit: after the Send writes it, none of them has a place (never moved); they keep their words and only a decline answers them", async () => {
  const text = "alpha beta gamma delta epsilon\n";
  const o = await open(text);
  const v = sha(o.bytes);
  const cs = [comment("c1", v, select(text, "beta"), o.rev), comment("c2", v, select(text, "gamma"), o.rev), comment("c3", v, select(text, "epsilon"), o.rev)];
  const { edit } = spliceFor(text, "alpha beta GAM Xma delta epsilon\n");
  const d = await sendAndPoll(o, { comments: cs, mdEdit: edit });
  assert.equal(disk(d).toString(), "alpha beta GAM Xma delta epsilon\n");
  const anchors = d.batch.untrusted_document_evidence.anchors;
  for (const c of d.batch.instructions.comments) {
    const a = anchors.find((x) => x.id === c.anchor_id);
    assert.equal(a.resolved, false, c.id);
    assert.equal(a.locator?.source, undefined, "no source");
    assert.equal(c.reply_with, "decline");
    assert.equal(c.text, "fix", "the words are kept");
  }
  const r = await reply(d, { summary: "s", replies: [{ comment: "c1", text: "B" }, { comment: "c2", decline: true }, { comment: "c3", decline: true }] });
  assert.notEqual(r.status, 0, "a text answer to a comment with no place is refused");
  assert.equal(disk(d).toString(), "alpha beta GAM Xma delta epsilon\n");
});

test("review 2: the same bytes again are not the same revision: an anchor of the first revision has no place after two writes return the file to it", async () => {
  const text = "red red\n";
  const o = await open(text);
  const first = comment("c1", sha(o.bytes), select(text, "red", 1), o.rev);
  // write 1: delete the first "red "; write 2: append " red" (the file's bytes are the first ones again)
  const a = spliceFor(text, "red\n");
  await sendMd(o.s.key, { baseSha: o.s.baseSha, note: "", edits: [], comments: [], mdEdit: a.edit });
  const mid = "red\n";
  const b = spliceFor(mid, "red red\n");
  await sendMd(o.s.key, { baseSha: sha(Buffer.from(mid)), note: "", edits: [], comments: [], mdEdit: b.edit });
  assert.ok(disk(o).equals(o.bytes), "the first bytes again");
  await sendMd(o.s.key, { baseSha: o.s.baseSha, note: "", edits: [], comments: [first] });
  const batch = await srv.sessions.poll(o.s.key, { holder: "Hrev" }).promise;
  const an = batch.untrusted_document_evidence.anchors.find((x) => x.id === batch.instructions.comments[0].anchor_id);
  assert.equal(an.resolved, false, "the old anchor is not revived");
  const res = await srv.sessions.resolveAllAsync(o.s.key);
  assert.equal(res.anchors.c1.method, "none");
});

test("g. (slice 4) a comment made while a draft exists has no place: after Send writes the edit it goes out without a place, words kept, decline only", async () => {
  const text = "one two three\n";
  const o = await open(text);
  const draft = "one two and a half three\n";
  const { edit } = spliceFor(text, draft);
  // what the page sends for a comment made on the draft's preview: its words, no location
  const onDraft = { id: "c1", kind: "text", text: "fix", anchor: { location: null, quote: "half", prefix: "", suffix: "", format: "markdown" } };
  const d = await sendAndPoll(o, { comments: [onDraft], mdEdit: edit });
  const ic = d.batch.instructions.comments[0];
  const a = d.batch.untrusted_document_evidence.anchors.find((x) => x.id === ic.anchor_id);
  assert.equal(a.resolved, false);
  assert.equal(ic.reply_with, "decline");
  assert.equal(ic.text, "fix");
  const r = await reply(d, { summary: "s", replies: [{ comment: "c1", text: "third" }] });
  assert.notEqual(r.status, 0, "a change is refused for a decline-only comment");
  assert.ok(r.stdout.includes("decline_only"), r.stdout);
  assert.equal(disk(d).toString(), draft);
});

test("h. the file changed on disk before Send: nothing is written, the comments stay drafts, and the sentence says why", async () => {
  const text = "alpha beta\n";
  const o = await open(text);
  const { edit } = spliceFor(text, "alpha BETA\n");
  const outside = Buffer.from("alpha beta gamma\n");
  fs.writeFileSync(o.file, outside);
  await assert.rejects(sendMd(o.s.key, { baseSha: o.s.baseSha, note: "", edits: [], comments: [comment("c1", sha(o.bytes), select(text, "alpha"), o.rev)], mdEdit: edit }), (e) => e.status === 409 && e.extra?.code === "version_changed" && /^The file changed since this page loaded it, so your edit was not written\./.test(e.message));
  assert.ok(disk(o).equals(outside));
  assert.ok(o.s.comments.every((c) => c.status === "draft"));
  assert.equal(o.s.pending, null);
  const copies = fs.readdirSync(path.dirname(o.file));
  assert.equal(copies.length, 1, `no conflict copy is written: ${copies}`);
});

test("h. a splice whose old text is not the file's is refused with a sentence; during a run an edit is refused (423) and nothing is written", async () => {
  const text = "alpha beta\n";
  const o = await open(text);
  await assert.rejects(sendMd(o.s.key, { baseSha: o.s.baseSha, note: "", edits: [], comments: [], mdEdit: { from: 6, to: 10, old: "betA", new: "x", sha256: o.s.baseSha } }), (e) => e.status === 422 && /^Your edit was not written:/.test(e.message));
  assert.ok(disk(o).equals(o.bytes));
  const d = await sendAndPoll(o, { comments: [comment("c1", sha(o.bytes), select(text, "beta"), o.rev)] });
  await assert.rejects(sendMd(d.s.key, { baseSha: d.s.baseSha, note: "", edits: [], comments: [], mdEdit: spliceFor(text, "ALPHA beta\n").edit }), (e) => e.status === 423);
  assert.ok(disk(d).equals(o.bytes));
});

test("i. Revert after a typed edit and an agent write gives back the bytes that held the typed edit", async () => {
  const text = "\uFEFFfirst line\r\nsecond line\r\n";
  const o = await open(text);
  const draft = "\uFEFFfirst LINE\r\nsecond line\r\n";
  const { edit } = spliceFor(text, draft);
  await sendMd(o.s.key, { baseSha: o.s.baseSha, note: "", edits: [], comments: [], mdEdit: edit });
  const typed = disk(o);
  assert.ok(typed.equals(Buffer.from(draft, "utf8")));
  // a comment on the written revision (as the page loads it), then the agent's write
  const rev = srv.sessions.loadForPage(o.s.key).mdRev;
  await sendMd(o.s.key, { baseSha: o.s.baseSha, note: "", edits: [], comments: [comment("c1", sha(typed), select(draft, "second"), rev)] });
  const holder = `H${++n}`;
  const batch = await srv.sessions.poll(o.s.key, { holder }).promise;
  const d = { ...o, batch, ticket: batch.lease_ticket, env: { ONIONSKIN_HOLDER: holder } };
  const r = await reply(d, { summary: "s", replies: [{ comment: "c1", text: "2nd" }] });
  assert.equal(r.status, 0, r.stdout);
  assert.equal(disk(d).toString(), "\uFEFFfirst LINE\r\n2nd line\r\n");
  const entry = d.s.activity.find((a) => a.kind === "agent");
  await srv.sessions.revertAsync(d.s.key, entry.id);
  assert.ok(disk(d).equals(typed));
});

test("8. a splice that makes the file larger than MD_LIMITS is refused, and nothing is written", async () => {
  const text = "short\n";
  const o = await open(text);
  const big = "x".repeat(MD_LIMITS.bytes);
  await assert.rejects(sendMd(o.s.key, { baseSha: o.s.baseSha, note: "", edits: [], comments: [], mdEdit: { from: 0, to: 5, old: "short", new: big, sha256: o.s.baseSha } }), (e) => e.status === 422);
  assert.ok(disk(o).equals(o.bytes));
});

test("a draft that deletes every character is written as an empty file, with its comment-free batch", async () => {
  const text = "only line\n";
  const o = await open(text);
  const d = await sendAndPoll(o, { comments: [], note: "check", mdEdit: { from: 0, to: text.length, old: text, new: "", sha256: o.s.baseSha } });
  assert.equal(disk(d).length, 0);
  assert.equal(d.batch.base_sha256, sha(Buffer.alloc(0)));
});

test("s3-4/s7-4 a draft or a reply may not start a BOM-less file with U+FEFF; the page keeps a typed U+FEFF and refuses the Send with a sentence", async () => {
  const text = "aaa\n";
  const o = await open(text);
  await assert.rejects(sendMd(o.s.key, { baseSha: o.s.baseSha, note: "", edits: [], comments: [], mdEdit: { from: 0, to: 0, old: "", new: "\uFEFF", sha256: o.s.baseSha } }), (e) => e.status === 422 && /byte order mark/.test(e.message));
  assert.ok(disk(o).equals(o.bytes));
  const { fromTextarea, draftRefusal, MD_DRAFT_FEFF } = await import("../web/src/md-edit.js");
  // the review's two cases: "x<U+FEFF>red" pasted, x selected and deleted: the U+FEFF stays in the draft and the Send is refused, the draft kept
  const draft = fromTextarea("\uFEFFred\n", "\n");
  assert.equal(draft, "\uFEFFred\n", "nothing the person typed is dropped");
  assert.equal(draftRefusal(draft), MD_DRAFT_FEFF);
  assert.equal(draftRefusal("x\uFEFFred\n"), MD_DRAFT_FEFF);
  assert.equal(draftRefusal("red\n"), null);
});

test("s3-4 a key typed in the preview of a BOM-less file lands at its offset, and preview, splice and server agree", async () => {
  const { firstKey, editability } = await import("../web/src/md-edit.js");
  const tree = readMarkdown("red red\n");
  const out = firstKey(tree, { start: { run: 0, offset: 5 }, end: { run: 0, offset: 5 }, collapsed: true, exact: true }, "X", editability(tree).eol);
  const draft = "red red\n".slice(0, out.from) + out.text + "red red\n".slice(out.to);
  assert.equal(draft, "red rXed\n");
  const o2 = await open("red red\n");
  const sp = spliceFor("red red\n", draft);
  const d2 = await sendAndPoll(o2, { comments: [], mdEdit: sp.edit });
  assert.equal(disk(d2).toString(), "red rXed\n", "offsets of preview, splice and server agree");
});

test("s3-6 the agent lock is checked again when the Send commits: an emptying edit with a run that started meanwhile writes and delivers nothing", async () => {
  const text = "abcd\n";
  const o = await open(text);
  // a batch waiting for an agent
  await sendMd(o.s.key, { baseSha: o.s.baseSha, note: "first", edits: [], comments: [comment("c0", sha(o.bytes), select(text, "abcd"), o.rev)] });
  assert.ok(o.s.pending);
  const c1 = comment("c1", sha(o.bytes), select(text, "abcd"), o.rev);
  // the edit is checked first (in the file's turn), then the anchors are worked out in the worker: the poll takes the waiting batch
  // exactly then (deterministic: the anchor work is wrapped for this one call)
  const real = srv.sessions.anchors;
  let poll = null;
  srv.sessions.anchors = async (job) => {
    srv.sessions.anchors = real;
    const r = await real(job);
    poll = srv.sessions.poll(o.s.key, { holder: "Hrace" });
    return r;
  };
  const sending = sendMd(o.s.key, { baseSha: o.s.baseSha, note: "second", edits: [], comments: [...o.s.comments.map((c) => ({ id: c.id, kind: c.kind, text: c.text, anchor: c.anchor })), c1], mdEdit: { from: 0, to: 5, old: text, new: "", sha256: o.s.baseSha } });
  await assert.rejects(sending, (e) => e.status === 423);
  srv.sessions.anchors = real;
  assert.ok(poll, "the poll landed between the check and the commit");
  await poll.promise;
  assert.ok(disk(o).equals(o.bytes), "the file is not emptied");
  const c = o.s.comments.find((x) => x.id === "c1");
  assert.ok(!c || c.status === "draft", "the comment of the refused Send is not delivered or queued");
  assert.ok(!o.s.queued, "nothing is queued");
});

test("s3-8 two Sends before a poll: only the latest revision's typed edit has a place; the earlier one is listed without one", async () => {
  const o = await open("red owl\n");
  const a = spliceFor("red owl\n", "gold owl\n");
  await sendMd(o.s.key, { baseSha: o.s.baseSha, note: "", edits: [], comments: [], mdEdit: a.edit });
  const b = spliceFor("gold owl\n", "green owl\n");
  await sendMd(o.s.key, { baseSha: o.s.baseSha, note: "", edits: [], comments: [], mdEdit: b.edit });
  const d = { batch: await srv.sessions.poll(o.s.key, { holder: "H2s" }).promise };
  const ue = d.batch.untrusted_document_evidence.user_edits;
  assert.equal(ue.length, 2);
  const an = (u) => d.batch.untrusted_document_evidence.anchors.find((x) => x.id === u.anchor_id);
  assert.equal(an(ue[0]).resolved, false, "the superseded edit has no place");
  assert.equal(ue[0].already_in_file, false, "s4-7: the superseded edit does not claim to be in the file");
  assert.equal(ue[1].already_in_file, true);
  assert.equal(an(ue[1]).resolved, true);
  assert.equal(an(ue[1]).locator.source, "reen", "the splice: the common prefix \"g\" stays");
});

// ---- slice 5: one Send holds the person's edit and comments made on the edited text --------------------------------------------------
/** A comment the page makes on the draft: its exact range in the draft's text (after any BOM) and the sha256 of the bytes the Send writes. */
function draftComment(id, draftSource, needle, inRun = 0, draftId = DID) {
  const m = select(draftSource, needle, inRun);
  return { id, kind: "text", text: "fix", anchor: { location: { from: m.from, to: m.to, draftSha: sha(Buffer.from(draftSource, "utf8")), draftId }, quote: m.quote, evidence: ev(draftId, m.from, m.to, m.quote), prefix: "", suffix: "", format: "markdown" } };
}
const anchorOfC = (batch, id) => {
  const ic = batch.instructions.comments.find((c) => c.id === id);
  return { ic, a: batch.untrusted_document_evidence.anchors.find((x) => x.id === ic.anchor_id) };
};

test("s5-a type an edit, comment on a word of the edited text, one Send: the comment has its place on the new revision and a text reply changes exactly those words", async () => {
  const text = "one two three\n";
  const o = await open(text);
  const draft = "one two and a half three\n";
  const { edit } = spliceFor(text, draft);
  const d = await sendAndPoll(o, { comments: [draftComment("c1", draft, "half")], mdEdit: edit });
  assert.equal(disk(d).toString(), draft);
  const { ic, a } = anchorOfC(d.batch, "c1");
  assert.equal(a.resolved, true);
  assert.equal(a.locator.source, "half");
  assert.equal(a.locator.sha256, sha(Buffer.from(draft)));
  assert.equal(ic.reply_with, "text_or_ops");
  assert.equal(d.batch.untrusted_document_evidence.user_edits[0].already_in_file, true);
  const r = await reply(d, { summary: "s", replies: [{ comment: "c1", text: "third" }] });
  assert.equal(r.status, 0, r.stdout);
  assert.equal(disk(d).toString(), "one two and a third three\n");
  const res = await srv.sessions.resolveAllAsync(d.s.key);
  assert.equal(res.anchors.c1.method, "none", "after the agent's write, its place is of the old revision (shown Done)");
});

test("s5-b red red: delete the first red in Edit, comment on the survivor, Send: the reply changes the survivor, bytes exact", async () => {
  const text = "red red\n";
  const o = await open(text);
  const draft = "red\n";
  const { edit } = spliceFor(text, draft);
  const d = await sendAndPoll(o, { comments: [draftComment("c1", draft, "red")], mdEdit: edit });
  const { a } = anchorOfC(d.batch, "c1");
  assert.deepEqual([a.resolved, a.locator.from, a.locator.to, a.locator.source], [true, 0, 3, "red"]);
  const r = await reply(d, { summary: "s", replies: [{ comment: "c1", text: "BLUE" }] });
  assert.equal(r.status, 0, r.stdout);
  assert.ok(disk(d).equals(Buffer.from("BLUE\n")));
});

test("s5-c the draft's bytes made first by an outside editor: a comment-only Send delivers the draft comment without a place; a refused splice sends nothing", async () => {
  const text = "red red\n";
  const o = await open(text);
  const draft = "red\n";
  fs.writeFileSync(o.file, draft); // the same bytes the draft would make, by another program
  srv.sessions.loadForPage(o.s.key); // the page reloads (and parks its draft)
  const d = await sendAndPoll({ ...o, s: srv.sessions.get(o.s.key) }, { baseSha: sha(Buffer.from(draft)), comments: [draftComment("c1", draft, "red")] });
  const { ic, a } = anchorOfC(d.batch, "c1");
  assert.equal(a.resolved, false);
  assert.equal(ic.reply_with, "decline");
  // a Send whose splice is refused (the file changed) sends nothing: no comment, no note
  const o2 = await open("alpha beta\n");
  const d2 = "alpha BETA\n";
  const { edit } = spliceFor("alpha beta\n", d2);
  fs.writeFileSync(o2.file, "alpha beta gamma\n");
  await assert.rejects(sendMd(o2.s.key, { baseSha: o2.s.baseSha, note: "n", edits: [], comments: [draftComment("c1", d2, "BETA")], mdEdit: edit }), (e) => e.status === 409);
  assert.equal(o2.s.pending, null);
  assert.ok(o2.s.comments.every((c) => c.status === "draft"));
});

test("s5-d a comment made on an earlier draft (the draft changed since) goes out without a place", async () => {
  const text = "one two\n";
  const o = await open(text);
  const d1 = "one two three\n";
  const d2 = "one two three!\n";
  const { edit } = spliceFor(text, d2);
  const d = await sendAndPoll(o, { comments: [draftComment("c1", d1, "three")], mdEdit: edit });
  const { ic, a } = anchorOfC(d.batch, "c1");
  assert.equal(a.resolved, false);
  assert.equal(ic.reply_with, "decline");
});

test("s5-e a CRLF file with a BOM: an edit, a comment after it and one before it, one Send: both ranges exact in the written bytes", async () => {
  const text = "﻿alpha line\r\nbeta line\r\ngamma line\r\n";
  const o = await open(text);
  const draft = "﻿alpha line\r\nbeta NEW\r\nmore\r\ngamma line\r\n";
  const { edit } = spliceFor(text, draft);
  const d = await sendAndPoll(o, { comments: [draftComment("c1", draft, "alpha"), draftComment("c2", draft, "gamma")], mdEdit: edit });
  assert.ok(disk(d).equals(Buffer.from(draft, "utf8")));
  const body = draft.slice(1);
  for (const [id, w] of [["c1", "alpha"], ["c2", "gamma"]]) {
    const { a } = anchorOfC(d.batch, id);
    assert.equal(a.resolved, true, id);
    assert.equal(body.slice(a.locator.from, a.locator.to), w);
  }
  const r = await reply(d, { summary: "s", replies: [{ comment: "c1", text: "ALPHA" }, { comment: "c2", text: "GAMMA" }] });
  assert.equal(r.status, 0, r.stdout);
  assert.ok(disk(d).equals(Buffer.from("﻿ALPHA line\r\nbeta NEW\r\nmore\r\nGAMMA line\r\n", "utf8")));
});

test("s5-f a forged draftSha, a range inside an entity, or a page that names the written revision itself: no place, never written", async () => {
  const text = "x\n";
  const o = await open(text);
  const draft = "x &amp; y\n";
  const { edit, newSha } = spliceFor(text, draft);
  const forged = { ...draftComment("c1", draft, "y"), anchor: { ...draftComment("c1", draft, "y").anchor, location: { from: 8, to: 9, draftSha: "0".repeat(64) } } };
  const inEntity = { id: "c2", kind: "text", text: "fix", anchor: { location: { from: 3, to: 5, draftSha: newSha }, quote: "&", prefix: "", suffix: "", format: "markdown" } };
  const named = { id: "c3", kind: "text", text: "fix", anchor: { location: { from: 8, to: 9, version: newSha, rev: o.s.mdRev + 1 }, quote: "y", prefix: "", suffix: "", format: "markdown" } };
  const d = await sendAndPoll(o, { comments: [forged, inEntity, named], mdEdit: edit });
  for (const id of ["c1", "c2", "c3"]) {
    const { ic, a } = anchorOfC(d.batch, id);
    assert.equal(a.resolved, false, id);
    assert.equal(ic.reply_with, "decline", id);
  }
  const r = await reply(d, { summary: "s", replies: [{ comment: "c1", text: "Z" }] });
  assert.notEqual(r.status, 0);
  assert.equal(disk(d).toString(), draft);
});

test("s5-g undo back to the file's text: a comment made on that draft, sent with no edit, has no place", async () => {
  const text = "one two\n";
  const o = await open(text);
  const d = await sendAndPoll(o, { comments: [draftComment("c1", text, "two")] }); // its draftSha is the file's own sha256
  const { ic, a } = anchorOfC(d.batch, "c1");
  assert.equal(a.resolved, false);
  assert.equal(ic.reply_with, "decline");
});

// ---- slice 10: a Send in flight, and the person's text while it is (web/src/md-edit.js, the page's logic) --------------------------
test("s10 the person undoes to the old text while Send is in flight: an unsent edit until the reload, then a draft on the new record", async () => {
  const { mdDraftDirty, mdSettle } = await import("../web/src/md-edit.js");
  const OLD = "one\ntwo\n";
  const SENT = "new text for the file\n";
  const draft = { base: "shaOld", baseRev: "r1", value: OLD }; // the undo: the textarea equals the file's old text
  const inflight = { value: SENT, sha: "shaNew" };
  assert.equal(mdDraftDirty(OLD, OLD, inflight), true, "dirty while the Send is in flight, though it equals the old base");
  assert.equal(mdSettle({ draft, inflight, doc: { version: "shaOld", rev: "r1" } }).kind, "none", "the file view has not changed");
  assert.equal(mdSettle({ draft, inflight, doc: { version: "shaNew", rev: "r2" } }).kind, "wait", "a reload before the answer: nothing is done yet");
  const answered = { ...inflight, answered: true, confirmed: true };
  assert.equal(mdDraftDirty(OLD, OLD, answered), true, "dirty after the answer, before the reload");
  assert.equal(mdSettle({ draft, inflight: answered, doc: { version: "shaOld", rev: "r1" } }).kind, "none", "the reload has not come yet");
  assert.equal(mdSettle({ draft, inflight: answered, doc: { version: "shaNew", rev: "r2" } }).kind, "rebase", "based on the new record");
  assert.equal(mdDraftDirty(OLD, SENT, null), true, "on the new record it is an ordinary edit (writes the old text back)");
});

test("s10 more typing while Send is in flight: kept and based on the new record; nothing is sent twice", async () => {
  const { mdDraftDirty, mdSettle } = await import("../web/src/md-edit.js");
  const SENT = "one two!\n";
  const MORE = "one two!?\n";
  const draft = { base: "shaOld", baseRev: "r1", value: MORE };
  const answered = { value: SENT, sha: "shaNew", answered: true, confirmed: true };
  assert.equal(mdDraftDirty(MORE, "one two\n", answered), true);
  assert.equal(mdSettle({ draft, inflight: answered, doc: { version: "shaNew", rev: "r2" } }).kind, "rebase");
  assert.equal(mdDraftDirty(MORE, SENT, null), true, "the typed key is the next edit");
  // the reload shows other bytes than the receipt claimed: kept, parked, with the warning (round 9)
  assert.deepEqual(mdSettle({ draft, inflight: answered, doc: { version: "shaOther", rev: "r3" } }), { kind: "park", unconfirmed: true });
});

test("s10 no typing while Send is in flight: unchanged (the draft leaves once the reload shows the sent bytes)", async () => {
  const { mdDraftDirty, mdSettle } = await import("../web/src/md-edit.js");
  const SENT = "one two!\n";
  const draft = { base: "shaOld", baseRev: "r1", value: SENT };
  const answered = { value: SENT, sha: "shaNew", answered: true, confirmed: true };
  assert.equal(mdDraftDirty(SENT, "one two\n", { value: SENT, sha: "shaNew" }), true, "dirty during the Send exactly as before (it differs from the base)");
  assert.equal(mdSettle({ draft, inflight: answered, doc: { version: "shaNew", rev: "r2" } }).kind, "clear");
  // with no Send at all: as before, a draft whose record changed is parked; one on its record stays
  assert.equal(mdSettle({ draft, inflight: null, doc: { version: "shaOld", rev: "r1" } }).kind, "none");
  assert.equal(mdSettle({ draft, inflight: null, doc: { version: "shaX", rev: "r9" } }).kind, "park");
  assert.equal(mdDraftDirty("one two\n", "one two\n", null), false);
});
