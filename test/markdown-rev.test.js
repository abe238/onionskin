// Markdown, the third review (slice 4): every write, delivery and Revert bound to the session's revision, not only the bytes; no places
// on a draft; a no-op is never Done; decline-only comments; superseded edits; unanswered comments under --partial. Reproductions of the
// review's cases through the session's seams and the real CLI. (Header shared with test/markdown-fixes.test.js:) Markdown, the review of slice 1 (must-fix items): writes that could land on a revision the person never saw, on another copy of the
// words, on protected front matter, or erase an outside save; a --partial reply that hid an overlap; an empty result refused; a page's
// claimed edit told to the agent. Each test reproduces the reviewer's case through the session's seams and the real CLI. Temp dirs and a
// temporary HOME only.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { tmpdir } from "./helpers/zipbuild.js";
const ev = (id, from, to, src) => (typeof id === "string" ? crypto.createHash("sha256").update(`${id}\n${from}\n${to}\n${src}`, "utf8").digest("hex") : undefined); // the selection's evidence (src/anchors.js mdEvidence)

const root = fs.realpathSync(tmpdir("md-rev-"));
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
const { hooks } = await import("../src/fsutil.js");
const { readMarkdown, sourceRange } = await import("../src/markdown.js");

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
    let stderr = "";
    c.stdout.on("data", (d) => (stdout += d));
    c.stderr.on("data", (d) => (stderr += d));
    c.on("exit", (status) => resolve({ status, stdout, stderr, json: (() => { try { return JSON.parse(stdout.split("\n")[0]); } catch { return null; } })() }));
  });
/** The page's anchor for the `inRun`-th copy of `needle` in the first run that shows it (src/markdown.js sourceRange, as the page does). */
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
let REV = null; // the revision number the page got with the file (loadForPage), which its anchors name with the sha256
const comment = (id, bytes, m, rev = REV) => ({ id, kind: "text", text: "fix", anchor: { location: { from: m.from, to: m.to, version: sha(bytes), rev }, quote: m.quote, evidence: ev(rev, m.from, m.to, m.quote), prefix: "", suffix: "", format: "markdown" } });
async function deliver(text, comments, extra = {}) {
  const file = mdFile(text);
  const bytes = fs.readFileSync(file);
  const s = await srv.sessions.openAsync(file);
  REV = srv.sessions.loadForPage(s.key).mdRev;
  const holder = `H${++n}`;
  const poll = srv.sessions.poll(s.key, { holder });
  await srv.sessions.sendAsync(s.key, { baseSha: s.baseSha, comments: comments(bytes), note: "", edits: [], ...extra });
  const batch = await poll.promise;
  return { file, bytes, s, batch, holder, ticket: batch.lease_ticket, env: { ONIONSKIN_HOLDER: holder }, claim: { holder, token: batch.lease.token, batchId: batch.batch_id } };
}
const reply = (d, body, more = []) => cli(["reply", d.file, "--lease", d.ticket, ...more, "--json", JSON.stringify(body)], { env: d.env });
const disk = (d) => fs.readFileSync(d.file);
const op = (from, to, base, source, text) => ({ op: "replace_source", target: { from, to }, expect: { sha256: base, source }, text });


const observe = (d) => srv.sessions.loadForPage(d.s.key); // a disk observation, as the page's file load makes one
const NOT_DONE = "The agent marked this done, but nothing was changed at its place, so it is open again.";

// ---- slice 6: a revision is the file's record on disk (sha256 + device, inode, size, mtime), checked right before every write --------
/** The fourth review's cycle: delete the first "red " outside Onionskin, (something observes it, or nothing), then append " red" again. */
async function cycle(d, observe = () => {}) {
  await new Promise((r) => setTimeout(r, 5));
  fs.writeFileSync(d.file, "red\n");
  await observe();
  await new Promise((r) => setTimeout(r, 5));
  fs.writeFileSync(d.file, "red red\n");
}
async function replyRefused(d, t) {
  const r = await reply(d, { summary: "s", replies: [{ comment: "c1", text: "BLUE" }] });
  assert.notEqual(r.status, 0, `${t}: ${r.stdout}`);
  assert.equal(disk(d).toString(), "red red\n", `${t}: the file is untouched`);
  assert.notEqual(d.s.comments.find((c) => c.id === "c1").status, "done", t);
}
const RED = "red red\n";
const rows = [
  ["/api/stale", (d) => srv.sessions.staleCheck(d.s.key, d.batch.base_sha256)],
  ["reopening the file", (d) => srv.sessions.openAsync(d.file)],
  ["the page's file load", (d) => srv.sessions.loadForPage(d.s.key)],
  ["resolve", (d) => srv.sessions.resolveAllAsync(d.s.key)],
  ["a refused agent write", (d) => reply(d, { summary: "s", replies: [{ comment: "c1", text: "BLUE" }] })],
  ["a refused typed Send", (d) => srv.sessions.sendAsync(d.s.key, { baseSha: d.batch.base_sha256, note: "", edits: [], comments: [], mdEdit: { from: 0, to: 0, old: "", new: "x", sha256: d.batch.base_sha256, rev: "0".repeat(24) } }).catch(() => {})],
  ["the CLI's own read", (d) => cli(["status", d.file], { env: d.env })],
  ["nothing at all", null],
];
for (const [what, obs] of rows) {
  test(`s6 the red red cycle, the intervening file seen by ${what}: the old batch's reply is refused, the file is untouched`, async () => {
    const d = await deliver(RED, (b) => [comment("c1", b, select(RED, "red", 1))]);
    await cycle(d, obs ? () => obs(d) : undefined);
    await replyRefused(d, what);
  });
}

test("s6 the cycle while the batch waits for its first poll (delivery is the observer): no blocks, and the reply is refused", async () => {
  const file = mdFile(RED);
  const s = await srv.sessions.openAsync(file);
  REV = srv.sessions.loadForPage(s.key).mdRev;
  await srv.sessions.sendAsync(s.key, { baseSha: s.baseSha, comments: [comment("c1", Buffer.from(RED), select(RED, "red", 1))], note: "", edits: [] });
  await cycle({ file });
  const holder = `H${++n}`;
  const batch = await srv.sessions.poll(s.key, { holder }).promise;
  assert.ok(batch.untrusted_document_evidence.markdown_unavailable, "no blocks on another record");
  await replyRefused({ file, s, ticket: batch.lease_ticket, env: { ONIONSKIN_HOLDER: holder } }, "delivery");
});

test("s6 a byte-identical atomic replacement (a new inode) refuses the old batch", async () => {
  const d = await deliver(RED, (b) => [comment("c1", b, select(RED, "red", 1))]);
  const tmp = `${d.file}.tmp`;
  fs.writeFileSync(tmp, RED);
  fs.renameSync(tmp, d.file);
  await replyRefused(d, "atomic replacement");
});

test("s6 an identical re-save (same bytes, a new modification time) refuses; an xattr or chmod (ctime only) does not", async () => {
  const d = await deliver(RED, (b) => [comment("c1", b, select(RED, "red", 1))]);
  const st = fs.statSync(d.file);
  fs.utimesSync(d.file, st.atime, new Date(st.mtimeMs + 2000));
  await replyRefused(d, "touch");
  const e = await deliver(RED, (b) => [comment("c1", b, select(RED, "red", 1))]);
  fs.chmodSync(e.file, 0o640); // ctime moves, mtime does not
  if (process.platform === "darwin") spawnSync("/usr/bin/xattr", ["-w", "com.example.tag", "x", e.file]);
  const r = await reply(e, { summary: "s", replies: [{ comment: "c1", text: "BLUE" }] });
  assert.equal(r.status, 0, r.stdout);
  assert.equal(disk(e).toString(), "red BLUE\n");
});

test("s6 a person's Send already checked, then the file changed twice (same bytes again) before its commit: refused, nothing written", async () => {
  const text = "red red\n";
  const file = mdFile(text);
  const s = await srv.sessions.openAsync(file);
  const rev = srv.sessions.loadForPage(s.key).mdRev;
  const sending = srv.sessions.sendAsync(s.key, { baseSha: s.baseSha, note: "", edits: [], comments: [], mdEdit: { from: 3, to: 7, old: " red", new: "", sha256: s.baseSha, rev } }).then(() => null, (e) => e);
  await new Promise((r) => setImmediate(r)); // the edit is checked; its anchors are worked out in the worker
  fs.writeFileSync(file, "red\n");
  await new Promise((r) => setTimeout(r, 5));
  fs.writeFileSync(file, text);
  const err = await sending;
  assert.equal(err?.status, 409, String(err));
  assert.equal(fs.readFileSync(file, "utf8"), text);
});

test("s6 Revert after outside saves that come back to the run's bytes: refused, the file kept", async () => {
  const text = "red blue\n";
  const d = await deliver(text, (b) => [comment("c1", b, select(text, "red"))]);
  const r = await reply(d, { summary: "s", replies: [{ comment: "c1", text: "RED" }] });
  assert.equal(r.status, 0, r.stdout);
  const post = disk(d);
  await new Promise((r2) => setTimeout(r2, 5));
  fs.writeFileSync(d.file, "RED blue and more\n");
  await new Promise((r2) => setTimeout(r2, 5));
  fs.writeFileSync(d.file, post);
  const entry = d.s.activity.find((a) => a.kind === "agent");
  await assert.rejects(srv.sessions.revertAsync(d.s.key, entry.id), (e) => e.status === 409);
  assert.ok(disk(d).equals(post), "the file is not reverted");
});

test("s6 a server restart with a page still open: the page's old anchors have no place (no record survives a restart)", async () => {
  const text = "alpha beta\n";
  const file = mdFile(text);
  const s = await srv.sessions.openAsync(file);
  const oldRev = srv.sessions.loadForPage(s.key).mdRev;
  const { Sessions } = await import("../src/session.js");
  const S2 = new Sessions();
  const s2 = await S2.openAsync(file);
  const poll = S2.poll(s2.key, { holder: "Hrestart" });
  await S2.sendAsync(s2.key, { baseSha: s2.baseSha, note: "", edits: [], comments: [comment("c1", Buffer.from(text), select(text, "beta"), oldRev)] });
  const batch = await poll.promise;
  const a = batch.untrusted_document_evidence.anchors[0];
  assert.equal(a.resolved, false);
  assert.equal(batch.instructions.comments[0].reply_with, "decline");
});

test("s4-1 after a Revert, a waiting batch's comments have no place (words kept, decline only), never rebuilt on the restored bytes", async () => {
  const text = "a b c\n";
  const d = await deliver(text, (b) => [comment("c1", b, select(text, "a"))]);
  await srv.sessions.sendAsync(d.s.key, { baseSha: d.batch.base_sha256, comments: [...d.s.comments.map((c) => ({ id: c.id, kind: c.kind, text: c.text, anchor: c.anchor })), comment("c2", d.bytes, select(text, "b"))], note: "", edits: [] });
  const r = await reply(d, { summary: "s", replies: [{ comment: "c1", text: "A" }] });
  assert.equal(r.status, 0, r.stdout);
  const entry = d.s.activity.find((a) => a.kind === "agent");
  await srv.sessions.revertAsync(d.s.key, entry.id);
  const p = d.s.pending;
  assert.ok(p);
  for (const ic of p.instructions.comments) {
    const a = p.untrusted_document_evidence.anchors.find((x) => x.id === ic.anchor_id);
    assert.equal(a.resolved, false, ic.id);
    assert.equal(ic.reply_with, "decline", ic.id);
  }
});

test("s4-4 a replacement with the same text is not applied and never makes a comment Done; nothing is written", async () => {
  const text = "red / red\n";
  const d = await deliver(text, (b) => [comment("c1", b, select(text, "red", 1))]);
  const base = d.batch.base_sha256;
  const r = await reply(d, { summary: "s", replies: [{ comment: "c1", text: "red" }], ops: [op(0, 3, base, "red", "BLUE")] });
  assert.notEqual(r.status, 0, r.stdout);
  assert.ok(disk(d).equals(d.bytes), "nothing written");
  await assert.rejects(srv.sessions.agentWriteChecked(d.s.key, { baseSha: base, bytes: d.bytes, route: "apply", ops: [op(6, 9, base, "red", "red")], ...d.claim }), (e) => e.extra?.code === "no_change");
});

test("s4-4 a reopened comment keeps the agent's note, and a draft save keeps the reason and the note", async () => {
  const text = "red / red\n";
  const d = await deliver(text, (b) => [comment("c1", b, select(text, "red", 1))]);
  const base = d.batch.base_sha256;
  await srv.sessions.agentWriteChecked(d.s.key, { baseSha: base, bytes: Buffer.from("BLUE / red\n"), route: "apply", ops: [op(0, 3, base, "red", "BLUE")], ...d.claim });
  await srv.sessions.doneAsync(d.s.key, { summary: "s", results: [{ comment_id: "c1", status: "done", note: "Red marks an overdue item." }] }, d.claim);
  const c = d.s.comments.find((x) => x.id === "c1");
  assert.equal(c.status, "draft");
  assert.equal(c.reopened, NOT_DONE);
  assert.equal(c.result, "Red marks an overdue item.");
  const entry = d.s.activity.find((a) => a.kind === "agent");
  assert.equal(entry.results[0].note, `${NOT_DONE} Agent: Red marks an overdue item.`);
  srv.sessions.setDraft(d.s.key, { comments: d.s.comments.map((x) => ({ id: x.id, kind: x.kind, text: x.text, anchor: x.anchor })), note: "", rev: 99, tab: "t1" });
  const c2 = d.s.comments.find((x) => x.id === "c1");
  assert.equal(c2.reopened, NOT_DONE);
  assert.equal(c2.result, "Red marks an overdue item.");
});

test("s4-5 a comment delivered with reply_with decline accepts only a decline, also when its source is in a delivered block", async () => {
  const words = "word ".repeat(20_050);
  const text = `${words}\n`;
  const tree = readMarkdown(text);
  const m = sourceRange(tree, { startRun: 0, startOffset: 0, endRun: 0, endOffset: 100_001 });
  const d = await deliver(text, (b) => [comment("c1", b, m)]);
  assert.equal(d.batch.instructions.comments[0].reply_with, "decline");
  const src = d.batch.untrusted_document_evidence.markdown.blocks[0].source;
  assert.equal(src, text, "the block carries the whole source");
  const r = await reply(d, { summary: "s", replies: [{ comment: "c1", ops: [op(0, 100_001, d.batch.base_sha256, text.slice(0, 100_001), "short")] }] });
  assert.notEqual(r.status, 0);
  assert.ok(r.stdout.includes("decline_only"), r.stdout);
  assert.ok(disk(d).equals(d.bytes));
});

test("s4-6 protocol 12, and the contract text names the revision", async () => {
  const { SERVER_PROTOCOL } = await import("../src/constants.js");
  assert.equal(SERVER_PROTOCOL, 15); // slice 9: selection evidence, duplicate ids, state_unconfirmed (was 14)
  const doc = fs.readFileSync(path.join(repo, "docs", "contracts", "anchors.md"), "utf8");
  assert.match(doc, /location: \{from, to, version, rev\}/);
  assert.doesNotMatch(doc, /the same sha256 gives the same range/);
  const ref = fs.readFileSync(path.join(repo, "skills", "onionskin", "reference", "batch.md"), "utf8");
  assert.doesNotMatch(ref.split("\n").filter((l) => l.includes("markdown")).join("\n"), /poll again|\(read the file for them/);
});

test("s4-8 --partial with a comment left out: it is open again with a reason, never left sent with no batch", async () => {
  const text = "one two\n";
  const d = await deliver(text, (b) => [comment("c1", b, select(text, "one")), comment("c2", b, select(text, "two"))]);
  const r = await reply(d, { summary: "s", replies: [{ comment: "c1", text: "ONE" }] }, ["--partial"]);
  assert.equal(r.status, 0, r.stdout);
  const c2 = d.s.comments.find((x) => x.id === "c2");
  assert.equal(c2.status, "draft");
  assert.equal(c2.reopened, "The agent did not answer this comment, so it is open again.");
});

test("s6-7 replacements that cancel each other: nothing is written or applied, and the comment is not Done", async () => {
  const text = "ab z\n";
  const d = await deliver(text, (b) => [comment("c1", b, select(text, "a"))]);
  const base = d.batch.base_sha256;
  const r = await reply(d, { summary: "s", replies: [{ comment: "c1", text: "ab" }], ops: [op(1, 2, base, "b", "")] });
  assert.notEqual(r.status, 0, r.stdout);
  assert.ok(disk(d).equals(d.bytes));
  assert.notEqual(d.s.comments.find((c) => c.id === "c1").status, "done");
});

test("s6-7 Done needs a net change at the comment: cancelling neighbors plus a distant change reopen it, with the agent's note kept", async () => {
  const text = "ab z\n";
  const d = await deliver(text, (b) => [comment("c1", b, select(text, "a"))]);
  const base = d.batch.base_sha256;
  const r = await reply(d, { summary: "s", replies: [{ comment: "c1", text: "ab", note: "Done here." }], ops: [op(1, 2, base, "b", ""), op(3, 4, base, "z", "Z")] });
  assert.equal(r.status, 0, r.stdout);
  assert.equal(disk(d).toString(), "ab Z\n");
  const c = d.s.comments.find((x) => x.id === "c1");
  assert.equal(c.status, "draft");
  assert.equal(c.reopened, NOT_DONE);
  assert.equal(c.result, "Done here.");
});

test("s6-7 a raw apply carrying a decline-only comment's id never closes it", async () => {
  const words = "word ".repeat(20_050);
  const text = `${words}\n`;
  const tree = readMarkdown(text);
  const m = sourceRange(tree, { startRun: 0, startOffset: 0, endRun: 0, endOffset: 100_001 });
  const d = await deliver(text, (b) => [comment("c1", b, m)]);
  assert.equal(d.batch.instructions.comments[0].reply_with, "decline");
  const base = d.batch.base_sha256;
  const out = Buffer.from(`short${text.slice(100_001)}`);
  // s7-5: the raw op that names the decline-only comment is refused for that range; nothing is written
  await assert.rejects(srv.sessions.agentWriteChecked(d.s.key, { baseSha: base, bytes: out, route: "apply", ops: [{ ...op(0, 100_001, base, text.slice(0, 100_001), "short"), id: "c1" }], ...d.claim }), (e) => e.extra?.code === "decline_only");
  assert.ok(disk(d).equals(d.bytes));
  await srv.sessions.doneAsync(d.s.key, { summary: "s", results: [{ comment_id: "c1", status: "done", note: "Shortened." }] }, d.claim);
  const c = d.s.comments.find((x) => x.id === "c1");
  assert.equal(c.status, "draft");
  assert.equal(c.result, "Shortened.");
});

test("s6-7 an outside save after the agent's write and before done: the comment is not closed", async () => {
  const text = "red blue\n";
  const d = await deliver(text, (b) => [comment("c1", b, select(text, "red"))]);
  const base = d.batch.base_sha256;
  await srv.sessions.agentWriteChecked(d.s.key, { baseSha: base, bytes: Buffer.from("RED blue\n"), route: "apply", ops: [op(0, 3, base, "red", "RED")], ...d.claim });
  fs.writeFileSync(d.file, "blue\n");
  await srv.sessions.doneAsync(d.s.key, { summary: "s", results: [{ comment_id: "c1", status: "done", note: "" }] }, d.claim);
  assert.notEqual(d.s.comments.find((x) => x.id === "c1").status, "done");
});

test("s6-7 an explicit Revert keeps the agent's note on the reopened card", async () => {
  const text = "red blue\n";
  const d = await deliver(text, (b) => [comment("c1", b, select(text, "red"))]);
  const r = await reply(d, { summary: "s", replies: [{ comment: "c1", text: "RED", note: "Capitalized." }] });
  assert.equal(r.status, 0, r.stdout);
  const entry = d.s.activity.find((a) => a.kind === "agent");
  await srv.sessions.revertAsync(d.s.key, entry.id);
  const c = d.s.comments.find((x) => x.id === "c1");
  assert.equal(c.status, "draft");
  assert.equal(c.result, "Capitalized.");
  assert.equal(c.reopened, "The run was reverted, so this comment is open again.");
});

// ---- slice 7 ---------------------------------------------------------------------------------------------------------------------
const DIDA = "aa".repeat(12);
const DIDB = "bb".repeat(12);
const draftC = (id, draft, needle, inRun, draftId) => {
  const m = select(draft, needle, inRun);
  return { id, kind: "text", text: "fix", anchor: { location: { from: m.from, to: m.to, draftSha: sha(Buffer.from(draft)), draftId }, quote: m.quote, evidence: ev(draftId, m.from, m.to, m.quote), prefix: "", suffix: "", format: "markdown" } };
};
const editOf = (s, text, draft, draftId) => {
  let p = 0;
  while (p < text.length && text[p] === draft[p]) p++;
  let q = 0;
  while (q < Math.min(text.length, draft.length) - p && text[text.length - 1 - q] === draft[draft.length - 1 - q]) q++;
  return { from: p, to: text.length - q, old: text.slice(p, text.length - q), new: draft.slice(p, draft.length - q), sha256: sha(Buffer.from(text)), rev: srv.sessions.loadForPage(s.key).mdRev, draftId };
};

test("s7-1 the review's one-tab case: a draft comment sent alone, then a different edit with the same bytes: the comment never gains a place", async () => {
  const text = "red red\n";
  const file = mdFile(text);
  const s = await srv.sessions.openAsync(file);
  const c = draftC("c1", "red\n", "red", 0, DIDA); // made on A's draft (deleted the first "red ")
  await srv.sessions.sendAsync(s.key, { baseSha: s.baseSha, note: "", edits: [], comments: [c] }); // the draft was lost: the comment alone
  // a different edit (delete the LAST " red") with the same bytes and even the same draft id: the waiting comment stays without a place
  await srv.sessions.sendAsync(s.key, { baseSha: s.baseSha, note: "", edits: [], comments: [c], mdEdit: { ...editOf(s, text, "red\n", DIDA) } });
  const holder = `H${++n}`;
  const batch = await srv.sessions.poll(s.key, { holder }).promise;
  const ic = batch.instructions.comments.find((x) => x.id === "c1");
  assert.equal(ic.reply_with, "decline");
  const r = await reply({ file, ticket: batch.lease_ticket, env: { ONIONSKIN_HOLDER: holder } }, { summary: "s", replies: [{ comment: "c1", text: "BLUE" }] });
  assert.notEqual(r.status, 0);
  assert.equal(fs.readFileSync(file, "utf8"), "red\n");
});

test("s7-1 the review's two-tab case: tab B sends its own splice with tab A's saved comment: no place", async () => {
  const text = "red red\n";
  const file = mdFile(text);
  const s = await srv.sessions.openAsync(file);
  const cA = draftC("c1", "red\n", "red", 0, DIDA);
  srv.sessions.setDraft(s.key, { comments: [cA], note: "", rev: 1, tab: "tabA" });
  const holder = `H${++n}`;
  const poll = srv.sessions.poll(s.key, { holder });
  await srv.sessions.sendAsync(s.key, { baseSha: s.baseSha, note: "", edits: [], comments: [cA], mdEdit: editOf(s, text, "red\n", DIDB) });
  const batch = await poll.promise;
  assert.equal(batch.instructions.comments[0].reply_with, "decline");
  assert.equal(batch.untrusted_document_evidence.anchors.find((a) => a.id === batch.instructions.comments[0].anchor_id).resolved, false);
});

test("s7-2 an outside edit right after Onionskin's rename: the write is not confirmed, no record is current, and a reply and Revert on it are refused", async () => {
  const text = "red old\n";
  const file = mdFile(text);
  const s = await srv.sessions.openAsync(file);
  const draft = "red red\n";
  hooks.afterRename = ({ file: f }) => {
    hooks.afterRename = null;
    fs.writeFileSync(f, "red red\n".replace("red ", "")); // in place, same inode
    fs.appendFileSync(f, "");
  };
  try {
    const holder = `H${++n}`;
    const poll = srv.sessions.poll(s.key, { holder });
    await srv.sessions.sendAsync(s.key, { baseSha: s.baseSha, note: "", edits: [], comments: [draftC("c1", draft, "red", 1, DIDA)], mdEdit: editOf(s, text, draft, DIDA), rev: 3, tab: "t1" });
    const batch = await poll.promise;
    assert.equal(srv.sessions.view(s).mdSaves.t1.outcome, "content_unconfirmed");
    assert.equal(batch.instructions.comments[0].reply_with, "decline");
    const before = fs.readFileSync(file);
    const r = await reply({ file, ticket: batch.lease_ticket, env: { ONIONSKIN_HOLDER: holder } }, { summary: "s", replies: [{ comment: "c1", decline: true }], ops: [op(0, 3, batch.base_sha256, "red", "BLUE")] });
    assert.notEqual(r.status, 0);
    assert.ok(fs.readFileSync(file).equals(before), "the outsider's text is kept");
  } finally {
    hooks.afterRename = null;
  }
});

test("s7-2 a swapped parent folder (or a folder symlink) refuses the write", async () => {
  const text = "red red\n";
  const d = await deliver(text, (b) => [comment("c1", b, select(text, "red", 1))]);
  const dir = path.dirname(d.file);
  fs.renameSync(dir, `${dir}-moved`);
  fs.mkdirSync(dir);
  fs.linkSync(path.join(`${dir}-moved`, path.basename(d.file)), d.file);
  const r = await reply(d, { summary: "s", replies: [{ comment: "c1", text: "BLUE" }] });
  assert.notEqual(r.status, 0, r.stdout);
  assert.equal(fs.readFileSync(path.join(`${dir}-moved`, path.basename(d.file)), "utf8"), text);
  assert.equal(fs.readFileSync(d.file, "utf8"), text);
});

test("s7-3 the folder flush fails after the rename: the reply says the text was written but not confirmed (never 'unchanged'), and nothing is Done", async () => {
  const text = "red blue\n";
  const d = await deliver(text, (b) => [comment("c1", b, select(text, "red"))]);
  hooks.dirFsync = () => {
    throw Object.assign(new Error("no space"), { code: "ENOSPC" });
  };
  let r;
  try {
    r = await reply(d, { summary: "s", replies: [{ comment: "c1", text: "RED" }] });
  } finally {
    hooks.dirFsync = null;
  }
  assert.equal(disk(d).toString(), "RED blue\n", "the bytes are in place");
  assert.equal(r.json.confirmed, false, r.stdout);
  assert.equal(r.json.save_outcome, "durability_unconfirmed");
  assert.doesNotMatch(r.stdout, /unchanged/);
  assert.notEqual(d.s.comments.find((c) => c.id === "c1").status, "done");
  assert.ok(d.s.activity.find((a) => a.kind === "agent").flags.some((f) => f.code === "save_unconfirmed"));
});

test("s7-3 the folder flush fails after the person's Send: no 500, the outcome is told, nothing of it is writable later", async () => {
  const text = "red blue\n";
  const file = mdFile(text);
  const s = await srv.sessions.openAsync(file);
  hooks.dirFsync = () => {
    throw Object.assign(new Error("no space"), { code: "ENOSPC" });
  };
  try {
    await srv.sessions.sendAsync(s.key, { baseSha: s.baseSha, note: "", edits: [], comments: [], mdEdit: editOf(s, text, "RED blue\n", DIDA), rev: 7, tab: "t1" });
  } finally {
    hooks.dirFsync = null;
  }
  assert.equal(fs.readFileSync(file, "utf8"), "RED blue\n");
  assert.deepEqual(srv.sessions.view(s).mdSaves.t1, { rev: 7, outcome: "durability_unconfirmed" });
});

test("s7-5 a new inode with identical bytes before done: the comment is reopened, not closed", async () => {
  const text = "red blue\n";
  const d = await deliver(text, (b) => [comment("c1", b, select(text, "red"))]);
  const base = d.batch.base_sha256;
  await srv.sessions.agentWriteChecked(d.s.key, { baseSha: base, bytes: Buffer.from("RED blue\n"), route: "apply", ops: [op(0, 3, base, "red", "RED")], ...d.claim });
  const tmp = `${d.file}.tmp`;
  fs.writeFileSync(tmp, "RED blue\n");
  fs.renameSync(tmp, d.file);
  await srv.sessions.doneAsync(d.s.key, { summary: "s", results: [{ comment_id: "c1", status: "done", note: "" }] }, d.claim);
  assert.equal(d.s.comments.find((c) => c.id === "c1").status, "draft");
});

test("s7-5 a touching third replacement (a -> ab, delete b, c -> C): reopened; and the CLI prints the server's own outcome", async () => {
  const text = "abc z\n";
  const d = await deliver(text, (b) => [comment("c1", b, select(text, "a"))]);
  const base = d.batch.base_sha256;
  const r = await reply(d, { summary: "s", replies: [{ comment: "c1", text: "ab" }], ops: [op(1, 2, base, "b", ""), op(2, 3, base, "c", "C")] });
  assert.equal(r.status, 0, r.stdout);
  assert.equal(disk(d).toString(), "abC z\n");
  assert.equal(d.s.comments.find((c) => c.id === "c1").status, "draft");
  assert.deepEqual(r.json.applied, [], "the CLI does not claim what the server reopened");
});

test("s7-6 a stale delivery offers no place: no locator, decline", async () => {
  const file = mdFile(RED);
  const s = await srv.sessions.openAsync(file);
  REV = srv.sessions.loadForPage(s.key).mdRev;
  await srv.sessions.sendAsync(s.key, { baseSha: s.baseSha, comments: [comment("c1", Buffer.from(RED), select(RED, "red", 1))], note: "", edits: [] });
  await cycle({ file });
  const batch = await srv.sessions.poll(s.key, { holder: `H${++n}` }).promise;
  assert.equal(batch.instructions.comments[0].reply_with, "decline");
  assert.equal(batch.untrusted_document_evidence.anchors[0].locator, null);
});

// ---- slice 8 ---------------------------------------------------------------------------------------------------------------------
test("s8-1 a substituted range (the same draft id and digest, the original source): no place, never written", async () => {
  const text = "red red blue!\n";
  const file = mdFile(text);
  const s = await srv.sessions.openAsync(file);
  const draft = "red red blue!!\n";
  const real = draftC("c1", draft, "red", 0, DIDA); // the first "red", as selected
  const forged = { ...real, anchor: { ...real.anchor, location: { ...real.anchor.location, from: 8, to: 12 } } }; // pointed at "blue"
  const holder = `H${++n}`;
  const poll = srv.sessions.poll(s.key, { holder });
  await srv.sessions.sendAsync(s.key, { baseSha: s.baseSha, note: "", edits: [], comments: [forged], mdEdit: editOf(s, text, draft, DIDA) });
  const batch = await poll.promise;
  assert.equal(batch.instructions.comments[0].reply_with, "decline");
  const r = await reply({ file, ticket: batch.lease_ticket, env: { ONIONSKIN_HOLDER: holder } }, { summary: "s", replies: [{ comment: "c1", text: "BLUE" }] });
  assert.notEqual(r.status, 0);
  assert.equal(fs.readFileSync(file, "utf8"), draft);
});

test("s8-1 a queued comment whose captured evidence is not the text at its range has no place at delivery", async () => {
  const text = "red blue\n";
  const d = await deliver(text, (b) => [comment("c1", b, select(text, "red"))]);
  const q = comment("c2", d.bytes, select(text, "blue"));
  q.anchor.evidence = ev(q.anchor.location.rev, q.anchor.location.from, q.anchor.location.to, "red"); // captured on other text than its range holds now
  await srv.sessions.sendAsync(d.s.key, { baseSha: d.batch.base_sha256, comments: [...d.s.comments.map((c) => ({ id: c.id, kind: c.kind, text: c.text, anchor: c.anchor })), q], note: "", edits: [] });
  await reply(d, { summary: "s", replies: [{ comment: "c1", decline: true }] });
  const p = d.s.pending;
  const ic = p.instructions.comments.find((c) => c.id === "c2");
  assert.equal(ic.reply_with, "decline");
});

test("s8-2 Revert after the file was renamed aside, another file loaded, and the original inode restored: refused", async () => {
  const text = "red red\n";
  const d = await deliver(text, (b) => [comment("c1", b, select(text, "red", 1))]);
  const r = await reply(d, { summary: "s", replies: [{ comment: "c1", text: "BLUE" }] });
  assert.equal(r.status, 0, r.stdout);
  const aside = `${d.file}.aside`;
  fs.renameSync(d.file, aside);
  fs.writeFileSync(d.file, "other\n");
  srv.sessions.loadForPage(d.s.key);
  fs.renameSync(aside, d.file);
  srv.sessions.loadForPage(d.s.key);
  const entry = d.s.activity.find((a) => a.kind === "agent");
  await assert.rejects(srv.sessions.revertAsync(d.s.key, entry.id), (e) => e.status === 409);
  assert.equal(disk(d).toString(), "red BLUE\n");
});

test("s8-3 the staged file replaced by another inode with the same bytes before publication: refused, nothing published", async () => {
  const text = "red blue\n";
  const d = await deliver(text, (b) => [comment("c1", b, select(text, "red"))]);
  hooks.beforeRename = ({ tmp }) => {
    hooks.beforeRename = null;
    const bytes = fs.readFileSync(tmp);
    fs.rmSync(tmp);
    fs.writeFileSync(tmp, bytes, { mode: 0o400 });
  };
  try {
    const r = await reply(d, { summary: "s", replies: [{ comment: "c1", text: "RED" }] });
    assert.notEqual(r.status, 0, r.stdout);
  } finally {
    hooks.beforeRename = null;
  }
  assert.equal(disk(d).toString(), text);
  assert.equal(fs.statSync(d.file).mode & 0o777, 0o644);
});

test("s8-4 a folder flush the filesystem does not support, and a folder that cannot be listed: published, not confirmed (never 'unchanged', never 'confirmed')", async () => {
  const text = "red blue\n";
  const d = await deliver(text, (b) => [comment("c1", b, select(text, "red"))]);
  hooks.dirFsync = () => {
    throw Object.assign(new Error("not supported"), { code: "EINVAL" });
  };
  let r;
  try {
    r = await reply(d, { summary: "s", replies: [{ comment: "c1", text: "RED" }] });
  } finally {
    hooks.dirFsync = null;
  }
  assert.equal(disk(d).toString(), "RED blue\n");
  assert.equal(r.json.save_outcome, "durability_unconfirmed", r.stdout);
  assert.notEqual(d.s.comments.find((c) => c.id === "c1").status, "done");
  // a folder the owner can write and enter but not list: the person's Send publishes, and says it is not confirmed
  const file = mdFile("one two\n");
  const s = await srv.sessions.openAsync(file);
  const dir = path.dirname(file);
  const ed = editOf(s, "one two\n", "one TWO\n", DIDA);
  fs.chmodSync(dir, 0o300);
  try {
    await srv.sessions.sendAsync(s.key, { baseSha: s.baseSha, note: "", edits: [], comments: [], mdEdit: ed, rev: 2, tab: "t9" });
  } finally {
    fs.chmodSync(dir, 0o755);
  }
  assert.equal(fs.readFileSync(file, "utf8"), "one TWO\n");
  assert.equal(srv.sessions.view(s).mdSaves.t9.outcome, "durability_unconfirmed");
});

test("s8-4 Take back after an unconfirmed agent write: the run says so and recommends no Revert", async () => {
  const text = "red blue\n";
  const d = await deliver(text, (b) => [comment("c1", b, select(text, "red"))]);
  const base = d.batch.base_sha256;
  hooks.dirFsync = () => {
    throw Object.assign(new Error("no space"), { code: "ENOSPC" });
  };
  try {
    await srv.sessions.agentWriteChecked(d.s.key, { baseSha: base, bytes: Buffer.from("RED blue\n"), route: "apply", ops: [op(0, 3, base, "red", "RED")], ...d.claim });
  } finally {
    hooks.dirFsync = null;
  }
  srv.sessions.takeBack(d.s.key);
  const entry = d.s.activity.find((a) => a.kind === "agent");
  assert.ok(entry.flags.some((f) => f.code === "save_unconfirmed"));
  assert.equal(entry.revertRecommended, false);
});

test("s8-5 the server refuses a person's splice that inserts U+FEFF", async () => {
  const file = mdFile("one two\n");
  const s = await srv.sessions.openAsync(file);
  await assert.rejects(srv.sessions.sendAsync(s.key, { baseSha: s.baseSha, note: "", edits: [], comments: [], mdEdit: { ...editOf(s, "one two\n", "one t﻿wo\n", DIDA) } }), (e) => e.status === 422 && /U\+FEFF/.test(e.message));
  assert.equal(fs.readFileSync(file, "utf8"), "one two\n");
});

test("s8-6 a delivery made stale stays without places for the whole lease, even when the file comes back", async () => {
  const text = "red red\n";
  const file = mdFile(text);
  const s = await srv.sessions.openAsync(file);
  REV = srv.sessions.loadForPage(s.key).mdRev;
  await srv.sessions.sendAsync(s.key, { baseSha: s.baseSha, comments: [comment("c1", Buffer.from(text), select(text, "red", 1))], note: "", edits: [] });
  const aside = `${file}.aside`;
  fs.renameSync(file, aside); // missing at the poll
  const holder = `H${++n}`;
  const batch = await srv.sessions.poll(s.key, { holder }).promise;
  fs.renameSync(aside, file); // restored
  assert.equal(batch.instructions.comments[0].reply_with, "decline");
  const held = srv.sessions.deliveredBatch(s.key, { holder, token: batch.lease.token, batchId: batch.batch_id });
  assert.equal(held.instructions.comments[0].reply_with, "decline");
  const r = await reply({ file, ticket: batch.lease_ticket, env: { ONIONSKIN_HOLDER: holder } }, { summary: "s", replies: [{ comment: "c1", ops: [op(4, 7, batch.base_sha256, "red", "BLUE")] }] });
  assert.notEqual(r.status, 0);
  assert.equal(fs.readFileSync(file, "utf8"), text);
});

test("s8-6 a raw done results file: a comment named twice, or one not in this batch, is refused before any card changes", async () => {
  const text = "red blue\n";
  const d = await deliver(text, (b) => [comment("c1", b, select(text, "red"))]);
  srv.sessions.setDraft(d.s.key, { comments: [...d.s.comments.map((c) => ({ id: c.id, kind: c.kind, text: c.text, anchor: c.anchor, status: c.status })), comment("c9", d.bytes, select(text, "blue"))], note: "", rev: 99, tab: "t1" });
  await assert.rejects(srv.sessions.doneAsync(d.s.key, { summary: "s", results: [{ comment_id: "c1", status: "declined" }, { comment_id: "c1", status: "done" }] }, d.claim), (e) => e.status === 400);
  await assert.rejects(srv.sessions.doneAsync(d.s.key, { summary: "s", results: [{ comment_id: "c9", status: "declined" }] }, d.claim), (e) => e.status === 400);
  assert.equal(d.s.comments.find((c) => c.id === "c1").status, "sent");
  assert.equal(d.s.comments.find((c) => c.id === "c9").status, "draft");
  // the final state goes back to the caller, a reopened Draft as such
  const out = await srv.sessions.doneAsync(d.s.key, { summary: "s", results: [{ comment_id: "c1", status: "done", note: "x" }] }, d.claim);
  assert.deepEqual(out.outcomes, [{ comment_id: "c1", status: "draft", reopened: true }]);
});

test("s8-7 sentOnce is a Markdown field only: an HTML comment sent and queued carries none", async () => {
  const dir = path.join(root, `h${++n}`);
  fs.mkdirSync(dir);
  const f = path.join(dir, "page.html");
  fs.writeFileSync(f, "<!doctype html><html><body><p>hello world</p></body></html>\n");
  const s = await srv.sessions.openAsync(fs.realpathSync(f));
  const c = { id: "h1", kind: "text", text: "fix", anchor: { location: { nodeId: 0 }, quote: "hello", prefix: "", suffix: "", format: "html" } };
  await srv.sessions.sendAsync(s.key, { baseSha: s.baseSha, comments: [c], note: "", edits: [] });
  assert.equal(s.comments[0].sentOnce, undefined);
});

// ---- slice 9 ---------------------------------------------------------------------------------------------------------------------
/** A comment on the `inRun`-th `needle`, then its range moved to another copy of the same word: the same identity, source and evidence. */
const moved = (c, text, needle, to) => {
  const m = select(text, needle, to);
  return { ...c, anchor: { ...c.anchor, location: { ...c.anchor.location, from: m.from, to: m.to } } };
};

test("s9-2 a range moved to another copy of the same word (fresh Send): no place, and the reply cannot write it", async () => {
  const text = "red x red y blue\n";
  const d = await deliver(text, (b) => [moved(comment("c1", b, select(text, "red", 0)), text, "red", 1)]);
  assert.equal(d.batch.instructions.comments[0].reply_with, "decline");
  const r = await reply(d, { summary: "s", replies: [{ comment: "c1", text: "BLUE" }] });
  assert.notEqual(r.status, 0, r.stdout);
  assert.equal(disk(d).toString(), text);
});

test("s9-2 a range moved to another copy of the same word (draft binding): no place, never written", async () => {
  const text = "red x red y blue\n";
  const file = mdFile(text);
  const s = await srv.sessions.openAsync(file);
  const draft = "red x red y blue!\n";
  const c = moved(draftC("c1", draft, "red", 0, DIDA), draft, "red", 1);
  const holder = `H${++n}`;
  const poll = srv.sessions.poll(s.key, { holder });
  await srv.sessions.sendAsync(s.key, { baseSha: s.baseSha, note: "", edits: [], comments: [c], mdEdit: editOf(s, text, draft, DIDA) });
  const batch = await poll.promise;
  assert.equal(batch.instructions.comments[0].reply_with, "decline");
  const r = await reply({ file, ticket: batch.lease_ticket, env: { ONIONSKIN_HOLDER: holder } }, { summary: "s", replies: [{ comment: "c1", text: "BLUE" }] });
  assert.notEqual(r.status, 0);
  assert.equal(fs.readFileSync(file, "utf8"), draft);
});

test("s9-2 a range moved to another copy of the same word (queued delivery): no place", async () => {
  const text = "red x red y blue\n";
  const d = await deliver(text, (b) => [comment("c1", b, select(text, "blue"))]);
  const q = moved(comment("c2", d.bytes, select(text, "red", 0)), text, "red", 1);
  await srv.sessions.sendAsync(d.s.key, { baseSha: d.batch.base_sha256, comments: [...d.s.comments.map((c) => ({ id: c.id, kind: c.kind, text: c.text, anchor: c.anchor })), q], note: "", edits: [] });
  await reply(d, { summary: "s", replies: [{ comment: "c1", decline: true }] });
  assert.equal(d.s.pending.instructions.comments.find((c) => c.id === "c2").reply_with, "decline");
});

test("s9-2 resolve: a draft whose evidence does not hold at its range is shown nowhere", async () => {
  const text = "red x red y blue\n";
  const file = mdFile(text);
  const s = await srv.sessions.openAsync(file);
  REV = srv.sessions.loadForPage(s.key).mdRev;
  const good = comment("c1", Buffer.from(text), select(text, "red", 0));
  const bad = moved(comment("c2", Buffer.from(text), select(text, "red", 0)), text, "red", 1);
  const other = { ...comment("c3", Buffer.from(text), select(text, "blue")), anchor: { ...comment("c3", Buffer.from(text), select(text, "blue")).anchor, evidence: ev(REV, 12, 16, "red ") } };
  srv.sessions.setDraft(s.key, { comments: [good, bad, other], note: "", rev: 1, tab: "t1" });
  const r = await srv.sessions.resolveAllAsync(s.key);
  assert.notEqual(r.anchors.c1.method, "none");
  assert.equal(r.anchors.c2.method, "none");
  assert.equal(r.anchors.c3.method, "none");
});

test("s9-2 a large non-ASCII selection keeps a writable place, and the stored comment holds a digest, not a second copy of it", async () => {
  const cjk = "漢".repeat(45_000);
  const text = `${cjk}\n`;
  const d = await deliver(text, (b) => [comment("c1", b, select(text, cjk))]);
  assert.equal(d.batch.instructions.comments[0].reply_with, "text_or_ops");
  const stored = d.s.comments.find((c) => c.id === "c1");
  assert.equal(stored.anchor.source, undefined);
  assert.match(stored.anchor.evidence, /^[0-9a-f]{64}$/);
  const emoji = "😀".repeat(40_000);
  const t2 = `${emoji}\n`;
  const d2 = await deliver(t2, (b) => [comment("c1", b, select(t2, emoji))]);
  assert.equal(d2.batch.instructions.comments[0].reply_with, "text_or_ops");
  // the limit is the batch's: 100,000 UTF-16 units of source in any script; one more and the words go decline-only (never refused)
  for (const [unit, len, want] of [["漢", 100_000, "text_or_ops"], ["漢", 100_001, "decline"]]) {
    const big = unit.repeat(len);
    const t = `${big}\n`;
    const d3 = await deliver(t, (b) => [comment("c1", b, select(t, big))]);
    assert.equal(d3.batch.instructions.comments[0].reply_with, want, `${len}`);
  }
});

test("s9-3 two comments with the same id in one request: refused before anything is saved or sent", async () => {
  const text = "red blue\n";
  const file = mdFile(text);
  const s = await srv.sessions.openAsync(file);
  REV = srv.sessions.loadForPage(s.key).mdRev;
  const a = { ...comment("c1", Buffer.from(text), select(text, "red")), text: "Change red to ruby" };
  const b = { ...comment("c1", Buffer.from(text), select(text, "blue")), text: "Why blue?" };
  await assert.rejects(srv.sessions.sendAsync(s.key, { baseSha: s.baseSha, comments: [a, b], note: "", edits: [] }), (e) => e.status === 400 && e.extra?.code === "duplicate_comment_id");
  assert.throws(() => srv.sessions.setDraft(s.key, { comments: [a, b], note: "", rev: 1, tab: "t1" }), (e) => e.status === 400);
  assert.equal(s.comments.length, 0);
  assert.equal(s.pending ?? null, null);
  // the same id after normalization (cut to 64 characters) is a duplicate too
  const long = "x".repeat(64);
  await assert.rejects(srv.sessions.sendAsync(s.key, { baseSha: s.baseSha, comments: [{ ...a, id: `${long}1` }, { ...b, id: `${long}2` }], note: "", edits: [] }), (e) => e.status === 400);
});

test("s9-4 an outside atomic save after the final check opened the target: refused, the outside version kept", async () => {
  const text = "red blue\n";
  const d = await deliver(text, (b) => [comment("c1", b, select(text, "red"))]);
  let opens = 0;
  hooks.readOpened = ({ file }) => {
    if (++opens !== 2) return; // the first read is the record check; the second is the final check before the rename
    hooks.readOpened = null;
    const t = `${file}.outside`;
    fs.writeFileSync(t, "outside document\n");
    fs.renameSync(t, file);
  };
  let r;
  try {
    r = await reply(d, { summary: "s", replies: [{ comment: "c1", text: "RED" }] });
  } finally {
    hooks.readOpened = null;
  }
  assert.notEqual(r.status, 0, r.stdout);
  assert.equal(disk(d).toString(), "outside document\n");
});

test("s9-4 the staged name changed during its read-back: refused, nothing published", async () => {
  const text = "red blue\n";
  const d = await deliver(text, (b) => [comment("c1", b, select(text, "red"))]);
  hooks.stageReadBack = ({ tmp }) => {
    hooks.stageReadBack = null;
    fs.rmSync(tmp);
    fs.writeFileSync(tmp, "substituted\n");
  };
  let r;
  try {
    r = await reply(d, { summary: "s", replies: [{ comment: "c1", text: "RED" }] });
  } finally {
    hooks.stageReadBack = null;
  }
  assert.notEqual(r.status, 0, r.stdout);
  assert.equal(disk(d).toString(), text);
});

test("s9-4 the folder moved after the confirmation and another put at its name: the flush is not of that folder, never confirmed", async () => {
  const text = "red blue\n";
  const d = await deliver(text, (b) => [comment("c1", b, select(text, "red"))]);
  const dir = path.dirname(d.file);
  hooks.beforeFlush = () => {
    hooks.beforeFlush = null;
    fs.renameSync(dir, `${dir}.moved`);
    fs.mkdirSync(dir);
    fs.writeFileSync(d.file, "RED blue\n");
  };
  let r;
  try {
    r = await reply(d, { summary: "s", replies: [{ comment: "c1", text: "RED" }] });
  } finally {
    hooks.beforeFlush = null;
  }
  assert.notEqual(r.json?.save_outcome ?? "confirmed", "confirmed", r.stdout);
  assert.notEqual(d.s.comments.find((c) => c.id === "c1").status, "done");
});

test("s9-4 other bytes of the same length with the mtime kept, right after the rename: never confirmed", async () => {
  const text = "ONLY DRAFT\n";
  const d = await deliver(text, (b) => [comment("c1", b, select(text, "ONLY"))]);
  hooks.afterRename = ({ file }) => {
    hooks.afterRename = null;
    const st = fs.statSync(file, { bigint: true });
    fs.writeFileSync(file, "other text\n"); // the same length (11), the same inode
    const p = spawnSync("python3", ["-c", "import os,sys; os.utime(sys.argv[1], ns=(int(sys.argv[2]), int(sys.argv[3])))", file, String(st.atimeNs), String(st.mtimeNs)]);
    assert.equal(p.status, 0, String(p.stderr));
    assert.equal(fs.statSync(file, { bigint: true }).mtimeNs, st.mtimeNs);
  };
  let r;
  try {
    r = await reply(d, { summary: "s", replies: [{ comment: "c1", text: "SOLE" }] });
  } finally {
    hooks.afterRename = null;
  }
  assert.equal(disk(d).toString(), "other text\n");
  assert.notEqual(r.json?.save_outcome ?? "confirmed", "confirmed", r.stdout);
});

test("s9-6 a failure recording the write after the rename (the snapshot index): never 'not written'", async () => {
  const text = "red blue\n";
  const d = await deliver(text, (b) => [comment("c1", b, select(text, "red"))]);
  const touch = d.s.snapshots.touch.bind(d.s.snapshots);
  d.s.snapshots.touch = () => {
    d.s.snapshots.touch = touch;
    throw Object.assign(new Error("no space"), { code: "ENOSPC" });
  };
  const r = await reply(d, { summary: "s", replies: [{ comment: "c1", text: "RED" }] });
  d.s.snapshots.touch = touch;
  assert.equal(disk(d).toString(), "RED blue\n");
  assert.equal(r.json?.written === false, false, r.stdout);
  assert.doesNotMatch(r.stdout, /unchanged/);
  assert.equal(r.json.save_outcome, "state_unconfirmed", r.stdout);
  assert.notEqual(d.s.comments.find((c) => c.id === "c1").status, "done");
  const entry = d.s.activity.find((a) => a.kind === "agent");
  assert.equal(entry.revertRecommended, false); // no usable post-write record: no Revert offered
  assert.ok(entry.noRevert);
});

/** Makes the next session-file save (#changed: it saves, then emits "change") fail once, while `when()` holds. */
function failNextSave(when = () => true) {
  const emit = srv.sessions.emit.bind(srv.sessions);
  const state = { armed: true };
  srv.sessions.emit = (ev, ...rest) => {
    if (state.armed && ev === "change" && when()) {
      state.armed = false;
      throw Object.assign(new Error("no space"), { code: "ENOSPC" });
    }
    return emit(ev, ...rest);
  };
  state.restore = () => (srv.sessions.emit = emit);
  return state;
}

test("s9-6 a failure saving the session file after the agent's write: never 'not written'", async () => {
  const text = "red blue\n";
  const d = await deliver(text, (b) => [comment("c1", b, select(text, "red"))]);
  const f = failNextSave(() => fs.readFileSync(d.file, "utf8") === "RED blue\n");
  let r;
  try {
    r = await reply(d, { summary: "s", replies: [{ comment: "c1", text: "RED" }] });
  } finally {
    f.restore();
  }
  assert.equal(f.armed, false, "the failure was injected");
  assert.equal(disk(d).toString(), "RED blue\n");
  assert.equal(r.json.save_outcome, "state_unconfirmed", r.stdout);
  assert.notEqual(d.s.comments.find((c) => c.id === "c1").status, "done");
});

test("s9-6 a failure saving the session file after Revert wrote the earlier bytes: told on the run, never 'not reverted'", async () => {
  const text = "red blue\n";
  const d = await deliver(text, (b) => [comment("c1", b, select(text, "red"))]);
  const r = await reply(d, { summary: "s", replies: [{ comment: "c1", text: "RED" }] });
  assert.equal(r.status, 0, r.stdout);
  const entry = d.s.activity.find((a) => a.kind === "agent");
  const f = failNextSave(() => fs.readFileSync(d.file, "utf8") === text);
  try {
    await srv.sessions.revertAsync(d.s.key, entry.id);
  } finally {
    f.restore();
  }
  assert.equal(f.armed, false, "the failure was injected");
  assert.equal(disk(d).toString(), text);
  assert.equal(entry.reverted, true);
  assert.ok(d.s.activity[0].flags.some((x) => x.code === "save_unconfirmed"));
});

test("s9-6 a lease expiry after the agent wrote and the file then disappeared, or came back to the earlier bytes: the run is recorded, with no Revert", async () => {
  for (const after of ["gone", "restored"]) {
    const text = "red blue\n";
    const d = await deliver(text, (b) => [comment("c1", b, select(text, "red"))]);
    const base = d.batch.base_sha256;
    await srv.sessions.agentWriteChecked(d.s.key, { baseSha: base, bytes: Buffer.from("RED blue\n"), route: "apply", ops: [op(0, 3, base, "red", "RED")], ...d.claim });
    if (after === "gone") fs.rmSync(d.file);
    else fs.writeFileSync(d.file, text);
    d.s.delivered.lease.expiresAt = 0;
    srv.sessions.tick();
    const entry = d.s.activity.find((a) => a.kind === "agent");
    assert.ok(entry, after);
    assert.equal(entry.revertRecommended, false, after);
    assert.ok(entry.flags.some((f) => f.severity === "error"), after);
  }
});

test("s9-6 a failure after the person's edit was published (the session file): the tab's receipt says not confirmed, never 'not written'", async () => {
  const text = "one two\n";
  const file = mdFile(text);
  const s = await srv.sessions.openAsync(file);
  const emit = srv.sessions.emit.bind(srv.sessions);
  let armed = true;
  srv.sessions.emit = (ev, ...rest) => {
    if (armed && ev === "change" && fs.readFileSync(file, "utf8") === "one TWO\n") {
      armed = false;
      throw Object.assign(new Error("no space"), { code: "ENOSPC" });
    }
    return emit(ev, ...rest);
  };
  try {
    await srv.sessions.sendAsync(s.key, { baseSha: s.baseSha, note: "", edits: [], comments: [], mdEdit: editOf(s, text, "one TWO\n", DIDA), rev: 2, tab: "t9" });
  } finally {
    srv.sessions.emit = emit;
  }
  assert.equal(armed, false, "the failure was injected");
  assert.equal(fs.readFileSync(file, "utf8"), "one TWO\n");
  assert.equal(srv.sessions.view(s).mdSaves.t9.outcome, "state_unconfirmed");
  // where the session stands after the catch (in memory): the Send committed before the failed save, so its batch waits; no record is
  // trusted, so the next write on this file is refused until the page reads it again
  assert.ok(s.pending, "the Send's batch is pending");
});

test("s9-6 Take back after the agent wrote and the file then disappeared, or came back to the earlier bytes: the run is recorded, with no Revert", async () => {
  for (const after of ["gone", "restored"]) {
    const text = "red blue\n";
    const d = await deliver(text, (b) => [comment("c1", b, select(text, "red"))]);
    const base = d.batch.base_sha256;
    await srv.sessions.agentWriteChecked(d.s.key, { baseSha: base, bytes: Buffer.from("RED blue\n"), route: "apply", ops: [op(0, 3, base, "red", "RED")], ...d.claim });
    if (after === "gone") fs.rmSync(d.file);
    else fs.writeFileSync(d.file, text);
    srv.sessions.takeBack(d.s.key);
    const entry = d.s.activity.find((a) => a.kind === "agent");
    assert.ok(entry, after);
    assert.equal(entry.revertRecommended, false, after);
    assert.ok(entry.flags.some((f) => f.severity === "error"), after);
  }
});

test("s9-7 an append that would end protected front matter is refused; one that starts with a new line is written", async () => {
  const text = "---\ntitle: A\n---";
  const d = await deliver(text, () => [], { note: "add an introduction" });
  const base = d.batch.base_sha256;
  await assert.rejects(srv.sessions.agentWriteChecked(d.s.key, { baseSha: base, bytes: Buffer.from(`${text}Introduction`), route: "apply", ops: [op(text.length, text.length, base, "", "Introduction")], ...d.claim }), (e) => e.status >= 400 && e.status < 500);
  assert.equal(disk(d).toString(), text);
  await srv.sessions.agentWriteChecked(d.s.key, { baseSha: base, bytes: Buffer.from(`${text}\nIntroduction`), route: "apply", ops: [op(text.length, text.length, base, "", "\nIntroduction")], ...d.claim });
  assert.equal(disk(d).toString(), `${text}\nIntroduction`);
});
