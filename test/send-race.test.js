// A Send and the page's draft saves of one file run in turn (src/session.js sendAsync, setDraftAsync, settled), as they did when Send was
// synchronous: a draft save, a take back or a page load that arrives while a Send waits for the anchor worker is answered after the Send
// commits, against what it committed. A real server in a child process, driven through its routes, with every anchor job slowed by the
// test seam ONIONSKIN_TEST_ANCHOR_DELAY_MS. Also: nothing past a cap is dropped without a word (500 comments, notes), an undelivered batch
// replaced by a new Send keeps its note, and a pin's coordinates stay finite. Temp dirs only.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { docxBytes, tmpdir } from "./helpers/zipbuild.js";
import { childServer } from "./helpers/stall.js";

const root = tmpdir();
process.env.ONIONSKIN_STATE_DIR = path.join(root, "st");
process.env.ONIONSKIN_NO_SOFFICE = "1";
process.env.ONIONSKIN_TEST_ANCHOR_DELAY_MS = "500"; // this process's own anchor worker (the child server sets its own)
const { Sessions } = await import("../src/session.js");
const { ensureStateDir } = await import("../src/paths.js");
const { STAMP_WORDS } = await import("../src/stamp-words.js");
ensureStateDir();

const DELAY = 1500; // each anchor job in the child server's worker
let srv;
before(async () => {
  srv = await childServer({ prefix: "da-race-", env: { ONIONSKIN_TEST_ANCHOR_DELAY_MS: String(DELAY) } });
});
after(async () => {
  await srv?.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

const PARAS = ["The first paragraph.", "The second paragraph.", "A third one here."];
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
let n = 0;
/** A new file opened in the child server. Returns {key, base}. */
async function page(server = srv) {
  const f = path.join(server.root, `r${n++}.docx`);
  const b = docxBytes(PARAS);
  fs.writeFileSync(f, b);
  const o = await server.openPage(f);
  assert.equal(o.status, 200);
  return { key: o.key, base: sha(b) };
}
const c = (id, text, i = 0) => ({ id, kind: "element", text, status: "draft", anchor: { location: { blockPath: [i] }, quote: PARAS[i], paraText: PARAS[i], hitKind: "paragraph" } });
const later = (ms) => new Promise((r) => setTimeout(r, ms));
const view = async (key, server = srv) => (await server.api(key, "/api/bootstrap")).json.session;
const rows = (v) => v.comments.map((x) => [x.id, x.status, x.text]);
const stored = (key, server = srv) => JSON.parse(fs.readFileSync(path.join(server.state, "sessions", `${key}.json`), "utf8"));
/** A request, with the moment it was answered, so the order of answers can be checked. */
const timed = (p) => p.then((r) => ({ ...r, at: performance.now() }));

test("a draft save during the wait is applied after the Send commits, against what it committed: nothing is lost or sent twice", { timeout: 120_000 }, async () => {
  const { key, base } = await page();
  const sending = timed(srv.api(key, "/api/send", { baseSha: base, comments: [c("x", "Original comment")], note: "First note", rev: 1 }));
  await later(DELAY / 3);
  // the page keeps the comment it sent as it was (it cannot be edited during the wait) and adds one; a save during the wait carries no note
  const saving = timed(srv.api(key, "/api/draft", { comments: [c("x", "Original comment"), c("y", "Added during Send", 1)], rev: 2 }));
  const [sent, saved] = await Promise.all([sending, saving]);
  assert.equal(sent.status, 200);
  assert.equal(saved.status, 200);
  assert.ok(saved.at >= sent.at, "the draft save is answered after the Send");
  assert.deepEqual(rows(saved.json.session), [["x", "sent", "Original comment"], ["y", "draft", "Added during Send"]], "the save answers with the committed state plus its new comment");
  const v = await view(key);
  assert.deepEqual(rows(v), [["x", "sent", "Original comment"], ["y", "draft", "Added during Send"]]);
  assert.equal(v.note, "", "the note went with the Send and is not back in the box");
  const st = stored(key);
  assert.deepEqual(st.comments.map((x) => [x.id, x.status]), [["x", "sent"], ["y", "draft"]], "on disk too");
  assert.equal(st.pending.instructions.overall_note, "First note");
  assert.deepEqual(st.pending.instructions.comments.map((x) => x.text), ["Original comment"]);
});

test("a draft save without a note keeps the stored note (the page's save while a Send is in flight)", { timeout: 60_000 }, async () => {
  const { key } = await page();
  assert.equal((await srv.api(key, "/api/draft", { comments: [], note: "Keep me", rev: 1 })).status, 200);
  const r = await srv.api(key, "/api/draft", { comments: [c("y", "a comment")], rev: 2 });
  assert.equal(r.status, 200);
  assert.equal(r.json.session.note, "Keep me");
  assert.equal((await srv.api(key, "/api/draft", { comments: [], note: "", rev: 3 })).json.session.note, "", "an empty note still empties the box");
});

test("a page loaded during the wait starts from the committed state, and its next Send does not send the note again", { timeout: 120_000 }, async () => {
  const { key, base } = await page();
  const sending = timed(srv.api(key, "/api/send", { baseSha: base, comments: [c("x", "Original comment")], note: "First note", rev: 1 }));
  await later(DELAY / 3);
  // the reload: a new tab takes over editing and asks for the state
  assert.equal((await srv.api(key, "/api/claim", { takeover: true }, "POST", "reloadtab1")).status, 200);
  const boot = await timed(srv.api(key, "/api/bootstrap", undefined, "GET", "reloadtab1"));
  const sent = await sending;
  assert.ok(boot.at >= sent.at, "the page load waited for the Send");
  const v = boot.json.session;
  assert.deepEqual(rows(v), [["x", "sent", "Original comment"]], "the reloaded page shows the comment as sent");
  assert.equal(v.note, "", "and an empty note box");
  // the reloaded page saves and sends what it was given: the note goes out once
  assert.equal((await srv.api(key, "/api/draft", { comments: v.comments, note: v.note, rev: 1 }, "POST", "reloadtab1")).status, 200);
  const again = await srv.api(key, "/api/send", { baseSha: v.baseSha, comments: [...v.comments, c("z", "One more", 2)], note: v.note, rev: 2 }, "POST", "reloadtab1");
  assert.equal(again.status, 200);
  assert.equal(stored(key).pending.instructions.overall_note, "First note", "the note once");
  assert.deepEqual(stored(key).pending.instructions.comments.map((x) => x.text), ["Original comment", "One more"]);
});

test("an autosave numbered before the Send and landing after it changes nothing (why the page still numbers its saves)", { timeout: 120_000 }, async () => {
  const { key, base } = await page();
  const sending = srv.api(key, "/api/send", { baseSha: base, comments: [c("x", "Original comment")], note: "First note", rev: 2 });
  await later(DELAY / 3);
  const late = await srv.api(key, "/api/draft", { comments: [c("x", "Original comm")], note: "First no", rev: 1 });
  assert.equal(late.status, 200);
  assert.equal((await sending).status, 200);
  const v = await view(key);
  assert.deepEqual(rows(v), [["x", "sent", "Original comment"]]);
  assert.equal(v.note, "", "the older note is not put back in the box");
});

test("499 comments in flight, one added during the wait, then one more: the 500th is kept, the 501st is refused in words, nothing is dropped", { timeout: 180_000 }, async () => {
  const { key, base } = await page();
  const many = Array.from({ length: 499 }, (_, i) => c(`m${i}`, `comment ${i}`, i % 3));
  const sending = srv.api(key, "/api/send", { baseSha: base, comments: many, note: "", rev: 1 });
  await later(DELAY / 3);
  const fivehundred = srv.api(key, "/api/draft", { comments: [...many, c("new", "Added while waiting", 1)], rev: 2 });
  assert.equal((await sending).status, 200);
  assert.equal((await fivehundred).status, 200);
  let v = await view(key);
  assert.equal(v.comments.length, 500);
  assert.equal(v.comments.at(-1).text, "Added while waiting");
  assert.equal(v.comments.filter((x) => x.status === "sent").length, 499);
  const over = await srv.api(key, "/api/draft", { comments: [...v.comments, c("over", "One too many", 2)], rev: 3 });
  assert.equal(over.status, 413);
  assert.equal(over.json.code, "too_many_comments");
  assert.equal(over.json.error, "This file has 500 comments waiting; send or delete some before adding more.");
  v = await view(key);
  assert.equal(v.comments.length, 500, "nothing changed");
  assert.ok(v.comments.some((x) => x.id === "new"), "the comment added during the wait is still there");
  const sendOver = await srv.api(key, "/api/send", { baseSha: v.baseSha, comments: [...v.comments, c("over", "One too many", 2)], note: "", rev: 4 });
  assert.equal(sendOver.status, 413);
  assert.equal(sendOver.json.code, "too_many_comments");
});

test("a Send refused at its turn (409 conflict) leaves every comment it carried an editable draft and its note in the box", { timeout: 120_000 }, async () => {
  const { key } = await page();
  const r = await srv.api(key, "/api/send", { baseSha: "0".repeat(64), comments: [c("x", "Original comment"), c("y", "Another", 1)], note: "First note", rev: 1 });
  assert.equal(r.status, 409);
  const v = await view(key);
  assert.deepEqual(rows(v), [["x", "draft", "Original comment"], ["y", "draft", "Another"]]);
  assert.equal(v.note, "First note");
});

test("a Send whose bytes could not be read in time (503 read_timeout) leaves every comment an editable draft and its note in the box", { timeout: 120_000 }, async () => {
  const slow = await childServer({ prefix: "da-race-to-", env: { ONIONSKIN_TEST_ANCHOR_DELAY_MS: "1500", ONIONSKIN_ANCHOR_TIMEOUT_MS: "300" } });
  try {
    const { key, base } = await page(slow);
    const bytes = docxBytes(["A version this server never read.", "Second."]);
    const r = await slow.api(key, "/api/send", { baseSha: base, bytesB64: bytes.toString("base64"), comments: [c("x", "Original comment")], note: "First note", rev: 1 });
    assert.equal(r.status, 503);
    assert.equal(r.json.code, "read_timeout");
    const v = await view(key, slow);
    assert.deepEqual(rows(v), [["x", "draft", "Original comment"]]);
    assert.equal(v.note, "First note");
  } finally {
    await slow.stop();
  }
});

test("Take back pressed during the wait is done after the Send commits: the batch comes back whole", { timeout: 120_000 }, async () => {
  const { key, base } = await page();
  const sending = srv.api(key, "/api/send", { baseSha: base, comments: [c("x", "Original comment")], note: "First note", rev: 1 });
  await later(DELAY / 3);
  const back = await srv.api(key, "/api/takeback", {});
  assert.equal((await sending).status, 200);
  assert.equal(back.status, 200, "there is a batch to take back: the Send's");
  const v = await view(key);
  assert.deepEqual(rows(v), [["x", "draft", "Original comment"]]);
  assert.equal(v.note, "First note");
  assert.equal(v.pendingBatchId, null);
});

// The review of dd83dd2 (HIGH, older than the asynchronous Send): with no agent polling, a second Send replaced the waiting batch and its note.
test("two Sends with no agent polling: the waiting batch keeps the first note and its comments, the second note follows it", { timeout: 120_000 }, async () => {
  const { key, base } = await page();
  assert.equal((await srv.api(key, "/api/send", { baseSha: base, comments: [c("a", "Fix the heading")], note: "Explain why sales fell.", rev: 1 })).status, 200);
  const v1 = await view(key);
  const r = await srv.api(key, "/api/send", { baseSha: v1.baseSha, comments: [...v1.comments, c("b", "Shorter", 1)], note: "Also correct the spelling.", rev: 2 });
  assert.equal(r.status, 200);
  const st = stored(key);
  assert.equal(st.pending.instructions.overall_note, "Explain why sales fell.\n\nAlso correct the spelling.", "both notes, in order");
  assert.deepEqual(st.pending.instructions.comments.map((x) => x.text), ["Fix the heading", "Shorter"], "both batches' comments");
  assert.equal(r.json.session.note, "");
  // the agent then gets both
  const polled = await srv.cli("GET", `/cli/poll?file=${encodeURIComponent(st.file)}&holder=onionskin-term-${key}`);
  assert.equal(polled.status, 200);
  assert.equal(polled.json.instructions.overall_note, "Explain why sales fell.\n\nAlso correct the spelling.");
});

// ---- the same rules on Sessions directly (no worker delay here) --------------------------------------------------------------------
let fileN = 0;
const openS = async (S) => {
  const f = path.join(root, `s${fileN++}.docx`);
  fs.writeFileSync(f, docxBytes(PARAS));
  return S.openAsync(f);
};

test("Sessions: a Use, a queued Send and a Send behind another each apply a draft save that arrives during the wait after they commit", { timeout: 60_000 }, async () => {
  const S = new Sessions();
  const TAB = "tab-race-1";
  // a quick fix's Use: the stamp goes out, a correction of another comment and a new one made meanwhile are kept
  let s = await openS(S);
  const qt = PARAS[0];
  const location = { blockPath: [0], start: 0, end: qt.length };
  const rec = { task: "grammar", quote: qt, location, before: qt, after: "The first paragraph!" };
  const stamp = { id: "u", kind: "text", text: STAMP_WORDS.grammar, anchor: { location, quote: qt } };
  const using = S.useSuggestionAsync(s.key, { suggestion: rec, commentId: "u", comments: [stamp, c("o", "other", 1)], note: "kept note", baseSha: s.baseSha, rev: 1, tab: TAB });
  await later(150);
  await S.setDraftAsync(s.key, { comments: [stamp, c("o", "other, corrected", 1), c("y", "added", 2)], note: "kept note, longer", rev: 2, tab: TAB });
  await using;
  let by = new Map(s.comments.map((x) => [x.id, x]));
  assert.equal(by.get("u").status, "sent", "the stamp went out on this Mac");
  assert.equal(by.get("o").text, "other, corrected");
  assert.equal(by.get("y")?.status, "draft");
  assert.equal(s.note, "kept note, longer");
  // a Send during a run (queued)
  s = await openS(S);
  await S.sendAsync(s.key, { baseSha: s.baseSha, comments: [c("a", "first")], note: "", rev: 1, tab: TAB });
  await S.poll(s.key).promise;
  const queuing = S.sendAsync(s.key, { baseSha: s.baseSha, comments: [c("a", "first"), c("x", "Original comment", 1)], note: "First note", rev: 2, tab: TAB });
  await later(150);
  const saving = S.setDraftAsync(s.key, { comments: [c("a", "first"), c("x", "Original comment", 1), c("y", "added", 2)], rev: 3, tab: TAB });
  await Promise.all([queuing, saving]);
  by = new Map(s.comments.map((x) => [x.id, x]));
  assert.deepEqual([by.get("x").status, by.get("x").text, by.get("y")?.status], ["queued", "Original comment", "draft"]);
  assert.equal(s.queuedNote, "First note");
  assert.equal(s.note, "");
  // a Send waiting behind another of the same file, and a save behind both
  s = await openS(S);
  const first = S.sendAsync(s.key, { baseSha: s.baseSha, comments: [c("a", "first")], note: "", rev: 1, tab: TAB });
  await later(100);
  const second = S.sendAsync(s.key, { baseSha: s.baseSha, comments: [c("a", "first"), c("b", "second")], note: "n2", rev: 2, tab: TAB });
  await later(100);
  const third = S.setDraftAsync(s.key, { comments: [c("a", "first"), c("b", "second"), c("z", "typed while both waited", 2)], note: "n3", rev: 3, tab: TAB });
  await Promise.all([first, second, third]);
  by = new Map(s.comments.map((x) => [x.id, x]));
  assert.deepEqual([by.get("a").status, by.get("b").status, by.get("z")?.status], ["sent", "sent", "draft"]);
  assert.equal(s.pending.instructions.overall_note, "n2");
  assert.equal(s.note, "n3");
});

// The review of 3c7d3a6 (H1): a draft save numbered after a Send but landing before the Send's body finished arriving (a visibility-change
// save, which leaves the note out) made the Send's own note and list be ignored. A Send commits exactly its own payload; the newer save's
// additions stay drafts.
test("Sessions: a draft save numbered after a Send that lands before it never changes what the Send delivers, and keeps its additions", { timeout: 60_000 }, async () => {
  const S = new Sessions();
  const TAB = "tab-race-h1";
  for (const older of ["", "Explain"]) {
    const s = await openS(S);
    if (older) await S.setDraftAsync(s.key, { comments: [c("x", "Fix the heading")], note: older, rev: 1, tab: TAB });
    // the save (rev 3) arrives first, without the note; the Send (rev 2) arrives after it
    await S.setDraftAsync(s.key, { comments: [c("x", "Fix the heading"), c("y", "Added after Send", 1)], rev: 3, tab: TAB });
    await S.sendAsync(s.key, { baseSha: s.baseSha, comments: [c("x", "Fix the heading")], note: "Explain why sales fell.", rev: 2, tab: TAB });
    assert.equal(s.pending.instructions.overall_note, "Explain why sales fell.", `the Send's own note goes out (older: ${JSON.stringify(older)})`);
    assert.deepEqual(s.pending.instructions.comments.map((x) => x.text), ["Fix the heading"]);
    assert.deepEqual(s.comments.map((x) => [x.id, x.status, x.text]), [["x", "sent", "Fix the heading"], ["y", "draft", "Added after Send"]], "the newer save's comment stays a draft");
    assert.equal(s.note, "", "the note went with the Send");
    // a save numbered before the Send that lands now changes nothing
    await S.setDraftAsync(s.key, { comments: [c("x", "Fix the head")], note: "Explain why", rev: 1, tab: TAB });
    assert.equal(s.note, "");
    assert.equal(s.comments.length, 2);
  }
  // a quick fix's Use overtaken the same way: it delivers only its stamp, so the newer save's note and comment stay
  const s = await openS(S);
  const qt = PARAS[0];
  const location = { blockPath: [0], start: 0, end: qt.length };
  const rec = { task: "grammar", quote: qt, location, before: qt, after: "The first paragraph!" };
  const stamp = { id: "u", kind: "text", text: STAMP_WORDS.grammar, anchor: { location, quote: qt } };
  await S.setDraftAsync(s.key, { comments: [stamp, c("o", "other, corrected", 1), c("z", "new", 2)], note: "newer note", rev: 2, tab: TAB });
  await S.useSuggestionAsync(s.key, { suggestion: rec, commentId: "u", comments: [stamp, c("o", "other", 1)], note: "older", baseSha: s.baseSha, rev: 1, tab: TAB });
  const by = new Map(s.comments.map((x) => [x.id, x]));
  assert.equal(by.get("u").status, "sent");
  assert.equal(by.get("o").text, "other, corrected");
  assert.equal(by.get("z")?.status, "draft");
  assert.equal(s.note, "newer note");
});

test("D variants: a Send during a run queues its note after the queued one; Take back brings every note back; a carried note past the cap is refused", { timeout: 60_000 }, async () => {
  const S = new Sessions();
  // queued during a run
  let s = await openS(S);
  await S.sendAsync(s.key, { baseSha: s.baseSha, comments: [c("a", "first")], note: "Run note" });
  await S.poll(s.key).promise; // delivered
  await S.sendAsync(s.key, { baseSha: s.baseSha, comments: [...s.comments, c("q1", "queued one", 1)], note: "Queued A" });
  await S.sendAsync(s.key, { baseSha: s.baseSha, comments: [...s.comments, c("q2", "queued two", 2)], note: "Queued B" });
  assert.equal(s.queuedNote, "Queued A\n\nQueued B");
  assert.deepEqual(s.comments.filter((x) => x.status === "queued").map((x) => x.id), ["q1", "q2"]);
  // Take back (the page's Stop takes the batch back the same way): every note comes back, in order
  S.takeBack(s.key);
  assert.equal(s.note, "Run note\n\nQueued A\n\nQueued B");
  assert.ok(s.comments.every((x) => x.status === "draft"));
  // after a take back, two Sends with no agent: both notes in the waiting batch
  s = await openS(S);
  await S.sendAsync(s.key, { baseSha: s.baseSha, comments: [c("a", "first")], note: "One" });
  S.takeBack(s.key);
  await S.sendAsync(s.key, { baseSha: s.baseSha, comments: s.comments, note: s.note });
  await S.sendAsync(s.key, { baseSha: s.baseSha, comments: [...s.comments, c("b", "second", 1)], note: "Two" });
  assert.equal(s.pending.instructions.overall_note, "One\n\nTwo");
  assert.deepEqual(s.pending.instructions.comments.map((x) => x.id), ["a", "b"]);
  // a note that would make the waiting batch's note longer than a note may be is refused, and nothing changes
  const long = "w".repeat(15_000);
  s = await openS(S);
  await S.sendAsync(s.key, { baseSha: s.baseSha, comments: [], note: long });
  const first = s.pending.batch_id;
  await assert.rejects(S.sendAsync(s.key, { baseSha: s.baseSha, comments: [c("b", "second")], note: long }), (e) => e.status === 413 && e.extra?.code === "note_too_long");
  assert.equal(s.pending.batch_id, first, "the waiting batch is unchanged");
  assert.equal(s.pending.instructions.overall_note, long, "the waiting note is whole (not cut)");
  // a refusal changes nothing (test/refusal-atomic.test.js): the page keeps the new comment and note, and its next save stores them
  assert.deepEqual(s.comments, [], "nothing of the refused Send is stored");
  assert.equal(s.note, "");
});

test("a note longer than a note may be is refused in words, never cut", async () => {
  const S = new Sessions();
  const s = await openS(S);
  assert.throws(() => S.setDraft(s.key, { comments: [], note: "n".repeat(20_001) }), (e) => e.status === 413 && e.extra?.code === "note_too_long");
  S.setDraft(s.key, { comments: [], note: "n".repeat(20_000) });
  assert.equal(s.note.length, 20_000);
});

test("a pin's coordinates stay finite and within bounds: 1e308 is clamped, junk is 0", async () => {
  const S = new Sessions();
  const s = await openS(S);
  const pin = (p) => ({ ...c("p", "pin"), kind: "pin", pin: p });
  S.setDraft(s.key, { comments: [pin({ xFrac: 1e308, yFrac: -1e308, yPx: 1e308, sxFrac: "x", syFrac: Infinity, on: "shape" })], note: "" });
  const p = s.comments[0].pin;
  for (const k of ["xFrac", "yFrac", "yPx", "sxFrac", "syFrac"]) assert.ok(Number.isFinite(p[k]), `${k} is finite`);
  assert.deepEqual(p, { xFrac: 1, yPx: 1_000_000, yFrac: 0, on: "shape", sxFrac: 0, syFrac: 0 });
  const st = JSON.parse(fs.readFileSync(path.join(process.env.ONIONSKIN_STATE_DIR, "sessions", `${s.key}.json`), "utf8"));
  assert.deepEqual(st.comments[0].pin, p, "stored as numbers, not null");
});

test("Sessions: a note the server gave back (a run that stopped with a note queued behind it) is never overwritten by a save from a page that had not seen it", async () => {
  const S = new Sessions();
  const TAB = "tab-give";
  const s = await openS(S);
  await S.sendAsync(s.key, { baseSha: s.baseSha, comments: [c("a", "first")], note: "", rev: 1, tab: TAB });
  await S.poll(s.key).promise;
  await S.sendAsync(s.key, { baseSha: s.baseSha, comments: [c("a", "first"), c("q", "queued", 1)], note: "Queued note", rev: 2, noteRev: 1, tab: TAB });
  const seen = s.seq; // the page saw this state
  s.delivered.lease.expiresAt = 0;
  S.tick(); // the run stopped: the queued comment and its note come back to the box
  assert.equal(s.note, "Queued note");
  // a save from the page that had not seen that: its own note (empty) is merged into the server's, not put over it
  await S.setDraftAsync(s.key, { comments: s.comments, note: "", noteRev: 2, seen, rev: 3, tab: TAB });
  assert.equal(s.note, "Queued note");
  await S.setDraftAsync(s.key, { comments: s.comments, note: "Typed before it saw it", noteRev: 3, seen, rev: 4, tab: TAB });
  assert.equal(s.note, "Queued note\n\nTyped before it saw it");
  // once the page has seen it, its save is the note
  await S.setDraftAsync(s.key, { comments: s.comments, note: "Edited", noteRev: 4, seen: s.seq, rev: 5, tab: TAB });
  assert.equal(s.note, "Edited");
});

test("Sessions: a Send delivers only the drafts the page holds for it (`sends`); another draft stays a draft with its words", async () => {
  const S = new Sessions();
  const s = await openS(S);
  await S.sendAsync(s.key, { baseSha: s.baseSha, comments: [c("a", "held"), c("b", "shown as queued in the page", 1)], note: "n", sends: ["a"], rev: 1, tab: "tab-sends" });
  assert.deepEqual(s.comments.map((x) => [x.id, x.status]), [["a", "sent"], ["b", "draft"]]);
  assert.deepEqual(s.pending.instructions.comments.map((x) => x.id), ["a"]);
});

test("Sessions: after a restart the session still says which Send of a tab committed (`sent`), so a page asking after a lost answer is told it went through", async () => {
  const S = new Sessions();
  const s = await openS(S);
  await S.sendAsync(s.key, { baseSha: s.baseSha, comments: [c("a", "sent before the restart")], note: "n", noteRev: 3, rev: 7, tab: "tab-restart" });
  const file = s.file;
  const S2 = new Sessions(); // the server restarted: a new process reads the stored session
  const again = S2.open(file);
  assert.deepEqual(S2.view(again).sent, { "tab-restart": { rev: 7, noteRev: 3 } });
  // and the note that Send took is still not put back by that tab's save on the way out
  await S2.setDraftAsync(again.key, { comments: again.comments, note: "n", noteRev: 3, rev: 8, tab: "tab-restart" });
  assert.equal(again.note, "");
});

test("Sessions: the tab that lost editing hands over its unsaved words once; nothing stored is replaced; no other tab may", async () => {
  const S = new Sessions();
  const s = await openS(S);
  assert.equal(S.claimEditor(s.key, "tab-a"), true);
  await S.setDraftAsync(s.key, { comments: [c("x", "Saved words")], note: "Saved note", rev: 1, tab: "tab-a" });
  const seen = s.seq;
  assert.equal(S.claimEditor(s.key, "tab-b", { takeover: true }), true);
  await assert.rejects(() => S.inTurn(s.key, () => S.handOver(s.key, "tab-c", { comments: [], note: "x", base: "" })), (e) => e.extra?.code === "no_handover");
  await S.inTurn(s.key, () => S.handOver(s.key, "tab-a", { comments: [c("x", "Unsaved correction"), c("y", "Made, not saved", 1)], note: "Saved note, and an unsaved instruction", base: "Saved note" }));
  assert.deepEqual(s.comments.map((x) => [x.status, x.text]), [["draft", "Saved words"], ["draft", "Unsaved correction"], ["draft", "Made, not saved"]]);
  assert.equal(s.note, "Saved note, and an unsaved instruction");
  await assert.rejects(() => S.inTurn(s.key, () => S.handOver(s.key, "tab-a", { comments: [], note: "again", base: "" })), (e) => e.extra?.code === "no_handover", "once");
  // the tab that edits now saves from the state it loaded (before the handover): the handed-over note is merged, not overwritten
  await S.setDraftAsync(s.key, { comments: s.comments, note: "Saved note", rev: 1, seen, tab: "tab-b" });
  assert.equal(s.note, "Saved note, and an unsaved instruction");
});

test("Sessions: a handover replaces a draft nobody changed since that tab saved it; one another tab changed keeps both; one it deleted stays deleted", async () => {
  const S = new Sessions();
  const s = await openS(S);
  S.claimEditor(s.key, "tab-a");
  await S.setDraftAsync(s.key, { comments: [c("x", "Mine"), c("y", "Theirs later", 1), c("z", "Deleted there", 2)], note: "", rev: 1, tab: "tab-a" });
  S.claimEditor(s.key, "tab-b", { takeover: true });
  await S.setDraftAsync(s.key, { comments: [c("x", "Mine"), c("y", "Changed by B", 1)], note: "", rev: 1, tab: "tab-b" }); // B changes y, deletes z
  await S.inTurn(s.key, () => S.handOver(s.key, "tab-a", { comments: [{ ...c("x", "Mine, corrected"), base: "Mine" }, { ...c("y", "Theirs later, corrected", 1), base: "Theirs later" }, { ...c("z", "Deleted there", 2), base: "Deleted there" }] }));
  assert.deepEqual(s.comments.map((x) => x.text), ["Mine, corrected", "Changed by B", "Theirs later, corrected"]);
});

test("Sessions: a handover of a tab whose save the server merged into a given note starts from that merged note, so nothing is in two places (model check seed 3415619)", { timeout: 60_000 }, async () => {
  // three windows: A hands its note to B, B's save is merged after it, C takes over; B then hands over the box its save's answer gave it
  const setup = async () => {
    const S = new Sessions();
    const s = await openS(S);
    S.claimEditor(s.key, "tab-a");
    S.claimEditor(s.key, "tab-b", { takeover: true });
    const seen = s.seq; // B loaded before A's handover
    await S.inTurn(s.key, () => S.handOver(s.key, "tab-a", { comments: [], note: "Note from A", base: "" }));
    await S.setDraftAsync(s.key, { comments: [], note: "Note from B", noteRev: 1, seen, noteSeen: seen, rev: 1, tab: "tab-b" });
    assert.equal(s.note, "Note from A\n\nNote from B", "B's note merged after the one A handed over");
    const answered = s.seq; // the state the save's answer carried
    S.claimEditor(s.key, "tab-c", { takeover: true });
    // B's page took the answer (web/src/drafts.js: the box merged, `stored` the server's note of that state) and typed more
    const handover = { comments: [], note: "Note from A\n\nNote from B\n\nMore from B", base: "Note from A\n\nNote from B", baseSeq: answered, noteRev: 2 };
    return { S, s, handover };
  };
  // C has not sent: the stored note gets only what B added
  let { S, s, handover } = await setup();
  await S.inTurn(s.key, () => S.handOver(s.key, "tab-b", handover));
  assert.equal(s.note, "Note from A\n\nNote from B\n\nMore from B");
  // C sent the note first (the batch holds it): the box gets only what B added after it
  ({ S, s, handover } = await setup());
  await S.sendAsync(s.key, { baseSha: s.baseSha, comments: [c("x", "C's comment")], note: s.note, noteRev: 0, seen: s.seq, noteSeen: s.seq, rev: 1, tab: "tab-c" });
  assert.equal(s.pending.instructions.overall_note, "Note from A\n\nNote from B");
  await S.inTurn(s.key, () => S.handOver(s.key, "tab-b", handover));
  assert.equal(s.note, "More from B");
});

test("Sessions: a handover of a tab whose box took a note the server gave back after its last save (Take back) starts from that note; one whose save's answer was lost starts from what it carried", { timeout: 60_000 }, async () => {
  const setup = async () => {
    const S = new Sessions();
    const s = await openS(S);
    S.claimEditor(s.key, "tab-b");
    await S.sendAsync(s.key, { baseSha: s.baseSha, comments: [c("x", "sent")], note: "First", noteRev: 1, rev: 1, tab: "tab-b" });
    await S.setDraftAsync(s.key, { comments: s.comments, note: "Second", noteRev: 2, seen: s.seq, noteSeen: s.seq, rev: 2, tab: "tab-b" });
    const saved = s.seq;
    await S.inTurn(s.key, () => S.takeBack(s.key));
    assert.equal(s.note, "First\n\nSecond", "the batch's note comes back in front of the box");
    const tookBack = s.seq;
    S.claimEditor(s.key, "tab-c", { takeover: true });
    return { S, s, saved, tookBack };
  };
  const more = { comments: [], note: "First\n\nSecond\n\nThird", base: "First\n\nSecond", noteRev: 4 };
  // B's box took Take back's answer and B typed more
  let { S, s, tookBack } = await setup();
  await S.inTurn(s.key, () => S.handOver(s.key, "tab-b", { ...more, baseSeq: tookBack }));
  assert.equal(s.note, "First\n\nSecond\n\nThird");
  // ... and C sent the note before the handover arrived: the box gets only what B added
  ({ S, s, tookBack } = await setup());
  await S.sendAsync(s.key, { baseSha: s.baseSha, comments: s.comments, note: s.note, noteRev: 0, seen: s.seq, noteSeen: s.seq, rev: 1, tab: "tab-c" });
  assert.equal(s.pending.instructions.overall_note, "First\n\nSecond");
  await S.inTurn(s.key, () => S.handOver(s.key, "tab-b", { ...more, baseSeq: tookBack }));
  assert.equal(s.note, "Third");
  // B's save of "Second" was stored but its answer lost: B's box is what it carried plus what it typed, its base an older state's note
  S = new Sessions();
  s = await openS(S);
  S.claimEditor(s.key, "tab-b");
  await S.sendAsync(s.key, { baseSha: s.baseSha, comments: [c("x", "sent")], note: "First", noteRev: 1, rev: 1, tab: "tab-b" });
  const sentState = s.seq; // B's page took the Send's answer: its box empty, `stored` "" of this state
  await S.setDraftAsync(s.key, { comments: s.comments, note: "Second", noteRev: 2, seen: s.seq, noteSeen: s.seq, rev: 2, tab: "tab-b" });
  S.claimEditor(s.key, "tab-c", { takeover: true });
  await S.inTurn(s.key, () => S.handOver(s.key, "tab-b", { comments: [], note: "Second\n\nThird", base: "", baseSeq: sentState, noteRev: 3 }));
  assert.equal(s.note, "Second\n\nThird");
  assert.equal(s.pending.instructions.overall_note, "First");
});

test("Sessions and the page's reconcile: a save's answer merged into a note the server gave back counts as seen, so the next save does not merge that note in again (model check seed 3721)", { timeout: 60_000 }, async () => {
  const { Drafts } = await import("../web/src/drafts.js");
  const S = new Sessions();
  const s = await openS(S);
  const TAB = "tab-b";
  S.claimEditor(s.key, "tab-a");
  S.claimEditor(s.key, TAB, { takeover: true });
  const d = new Drafts();
  d.loaded(s.note, s.comments, s.seq); // B loaded before A's handover
  await S.inTurn(s.key, () => S.handOver(s.key, "tab-a", { comments: [], note: "Note from A", base: "" }));
  const save = (note, rev) => {
    const at = d.begin({ note, carriesNote: true, wire: rev, comments: [] });
    return { at, done: S.setDraftAsync(s.key, { comments: [], note, noteRev: d.noteRev, seen: d.seen, noteSeen: d.noteSeen, rev, tab: TAB }) };
  };
  d.typedNote();
  const first = save("Note from B", 1);
  await first.done;
  assert.equal(s.note, "Note from A\n\nNote from B", "merged after the note A handed over");
  d.typedNote(); // typed before the answer came
  d.end(first.at, true);
  const r = d.reconcile({ comments: [], note: "Note from B\n\nMore" }, JSON.parse(JSON.stringify(S.view(s))), first.at);
  assert.equal(r.note, "Note from A\n\nNote from B\n\nMore");
  assert.equal(r.unsaved, true);
  await save(r.note, 2).done;
  assert.equal(s.note, "Note from A\n\nNote from B\n\nMore", "nothing in the box twice");
});

test("Sessions: a save from a state before notes were given back merges from the note it had seen, and from its own earlier save once that was merged (model check seeds 90001534, 50001646)", { timeout: 60_000 }, async () => {
  // two gives: A hands over "From A", C (which saw that) types after it, B hands over "From B" before C's save lands
  let S = new Sessions();
  let s = await openS(S);
  S.claimEditor(s.key, "tab-a");
  S.claimEditor(s.key, "tab-b", { takeover: true });
  await S.inTurn(s.key, () => S.handOver(s.key, "tab-a", { comments: [], note: "From A", base: "" }));
  S.claimEditor(s.key, "tab-c", { takeover: true });
  const seenA = s.seq; // C loaded here: the box "From A"
  await S.inTurn(s.key, () => S.handOver(s.key, "tab-b", { comments: [], note: "From B", base: "" }));
  assert.equal(s.note, "From A\n\nFrom B");
  await S.setDraftAsync(s.key, { comments: [], note: "From A and C", noteRev: 1, seen: seenA, noteSeen: seenA, rev: 1, tab: "tab-c" });
  assert.equal(s.note, "From A and C\n\nFrom B", "From A once");
  // one give, then two saves of one tab from the state before it (the first one's answer still on its way)
  S = new Sessions();
  s = await openS(S);
  S.claimEditor(s.key, "tab-a");
  await S.setDraftAsync(s.key, { comments: [], note: "Base", noteRev: 1, rev: 1, tab: "tab-a" });
  S.claimEditor(s.key, "tab-c", { takeover: true });
  const seen = s.seq;
  await S.inTurn(s.key, () => S.handOver(s.key, "tab-a", { comments: [], note: "Base from A", base: "Base" }));
  await S.setDraftAsync(s.key, { comments: [], note: "Base and C", noteRev: 1, seen, noteSeen: seen, rev: 1, tab: "tab-c" });
  const once = s.note;
  await S.setDraftAsync(s.key, { comments: [], note: "Base and C, more", noteRev: 2, seen, noteSeen: seen, rev: 2, tab: "tab-c" });
  for (const w of ["Base", "from", "and"]) assert.equal(s.note.split(w).length - 1, 1, `${JSON.stringify(w)} once in ${JSON.stringify(s.note)} (after ${JSON.stringify(once)})`);
  assert.match(s.note, /more/);
});
