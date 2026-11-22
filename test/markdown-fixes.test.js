// Markdown, the review of slice 1 (must-fix items): writes that could land on a revision the person never saw, on another copy of the
// words, on protected front matter, or erase an outside save; a --partial reply that hid an overlap; an empty result refused; a page's
// claimed edit told to the agent. Each test reproduces the reviewer's case through the session's seams and the real CLI. Temp dirs and a
// temporary HOME only.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { tmpdir } from "./helpers/zipbuild.js";
const ev = (id, from, to, src) => (typeof id === "string" ? crypto.createHash("sha256").update(`${id}\n${from}\n${to}\n${src}`, "utf8").digest("hex") : undefined); // the selection's evidence (src/anchors.js mdEvidence)

const root = fs.realpathSync(tmpdir("md-fixes-"));
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

test("7a.2 an old ticket cannot write against a revision saved outside Onionskin, even with an op naming the new sha256", async () => {
  const text = "one red\ntwo red\n";
  const d = await deliver(text, (b) => [comment("c1", b, select(text, "red"))]);
  const outside = Buffer.from("xxx red\none red\n");
  fs.writeFileSync(d.file, outside);
  const newBase = sha(outside);
  const want = Buffer.from("xxx X\none red\n");
  await assert.rejects(srv.sessions.agentWriteChecked(d.s.key, { baseSha: newBase, bytes: want, route: "apply", ops: [op(4, 7, newBase, "red", "X")], ...d.claim }), (e) => e.extra?.code === "stale_base");
  assert.ok(disk(d).equals(outside), "the outside save is left as it is");
  // the CLI says the same: nothing written
  const r = await reply(d, { summary: "s", replies: [{ comment: "c1", decline: true }], ops: [op(4, 7, newBase, "red", "X")] });
  assert.notEqual(r.status, 0);
  assert.ok(disk(d).equals(outside));
});

test("s3-2 one write per batch: after the run's checked write, a second write is refused, also one that names the new sha256", async () => {
  const text = "red red\n";
  const d = await deliver(text, (b) => [comment("c1", b, select(text, "red", 1))]);
  const base = d.batch.base_sha256;
  const b1 = Buffer.from("red red red\n");
  await srv.sessions.agentWriteChecked(d.s.key, { baseSha: base, bytes: b1, route: "apply", ops: [op(0, 0, base, "", "red ")], ...d.claim });
  // the review's case: a comment-scoped answer with the newer sha256 and the original [4,7) would change the wrong copy
  await assert.rejects(srv.sessions.agentWriteChecked(d.s.key, { baseSha: sha(b1), bytes: Buffer.from("red BLUE red\n"), route: "apply", ops: [op(4, 7, sha(b1), "red", "BLUE")], ...d.claim }), (e) => e.extra?.code === "one_write_per_batch");
  assert.ok(disk(d).equals(b1));
  const r = await reply(d, { summary: "s", replies: [{ comment: "c1", ops: [op(4, 7, sha(b1), "red", "BLUE")] }] });
  assert.notEqual(r.status, 0);
  assert.ok(disk(d).equals(b1), "nothing more written");
});

test("s3-2 a raw apply under a comment's name on another copy does not mark that comment done: it stays open, with the reason", async () => {
  const text = "red / red\n";
  const d = await deliver(text, (b) => [comment("c1", b, select(text, "red", 1))]);
  const base = d.batch.base_sha256;
  await srv.sessions.agentWriteChecked(d.s.key, { baseSha: base, bytes: Buffer.from("BLUE / red\n"), route: "apply", ops: [{ ...op(0, 3, base, "red", "BLUE"), id: "c1" }], ...d.claim });
  await srv.sessions.doneAsync(d.s.key, { summary: "s", results: [{ comment_id: "c1", status: "done", note: "" }] }, d.claim);
  const c = d.s.comments.find((x) => x.id === "c1");
  assert.equal(c.status, "draft");
  assert.equal(c.reopened, "The agent marked this done, but nothing was changed at its place, so it is open again."); // slice 4: the reason is its own field; result keeps the agent's note
});

test("s3-3 Take back after the checked write and an outside save: Revert is off for that run too, and nothing says Revert restores it", async () => {
  const text = "red\nblue\n";
  const d = await deliver(text, (b) => [comment("c1", b, select(text, "red"))]);
  const base = d.batch.base_sha256;
  await srv.sessions.agentWriteChecked(d.s.key, { baseSha: base, bytes: Buffer.from("RED\nblue\n"), route: "apply", ops: [op(0, 3, base, "red", "RED")], ...d.claim });
  const outside = Buffer.from("RED\noutside note\n");
  fs.writeFileSync(d.file, outside);
  srv.sessions.takeBack(d.s.key);
  const entry = d.s.activity.find((a) => a.kind === "agent");
  assert.match(entry.noRevert, /^Revert is off for this run/);
  assert.equal(entry.revertRecommended, false);
  assert.ok(!JSON.stringify(entry.flags).includes("Revert restores it"));
  await assert.rejects(srv.sessions.revertAsync(d.s.key, entry.id), (e) => e.status === 409);
  assert.ok(disk(d).equals(outside));
});

test("s3-7 a selection too long for the batch: no source, reply_with decline, and the rules say to decline (never to read the file)", async () => {
  const words = "word ".repeat(20_050);
  const text = `${words}\n`;
  const tree = readMarkdown(text);
  const m = sourceRange(tree, { startRun: 0, startOffset: 0, endRun: 0, endOffset: 100_001 });
  const d = await deliver(text, (b) => [comment("c1", b, m)]);
  const a = d.batch.untrusted_document_evidence.anchors[0];
  assert.equal(a.locator?.source, undefined);
  assert.equal(d.batch.instructions.comments[0].reply_with, "decline");
  assert.ok(d.batch.how_to_apply.rules.some((x) => /decline it with a plain reason\. Never read the file/.test(x)));
  const { backgroundPrompt } = await import("../src/agent-prompt.js");
  assert.match(backgroundPrompt({ file: "/x/a.md", workDir: "/tmp/w", timeout: 60 }), /untrusted_document_evidence\.markdown/);
});

test("s3-9 apply --standalone is refused for a Markdown file, and nothing is written", async () => {
  const f = mdFile("red\n");
  const opsFile = path.join(path.dirname(f), "ops.json");
  fs.writeFileSync(opsFile, JSON.stringify({ schema: "onionskin.ops/1", ops: [op(0, 3, sha(fs.readFileSync(f)), "red", "blue")] }));
  const r = await cli(["apply", f, "--ops", opsFile, "--standalone"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /--standalone is not available for it/);
  assert.equal(fs.readFileSync(f, "utf8"), "red\n");
});

test("7a.3 an outside save after the checked write and before done: done keeps it, and Revert is off with a plain sentence", async () => {
  const text = "red\nblue\n";
  const d = await deliver(text, (b) => [comment("c1", b, select(text, "red"))]);
  const base = d.batch.base_sha256;
  await srv.sessions.agentWriteChecked(d.s.key, { baseSha: base, bytes: Buffer.from("RED\nblue\n"), route: "apply", ops: [op(0, 3, base, "red", "RED")], ...d.claim });
  const outside = Buffer.from("RED\nexternal note\n");
  fs.writeFileSync(d.file, outside);
  await srv.sessions.doneAsync(d.s.key, { summary: "s", results: [{ comment_id: "c1", status: "done", note: "" }] }, d.claim);
  const entry = d.s.activity.find((a) => a.kind === "agent");
  assert.match(entry.noRevert, /^Revert is off for this run: the file was changed outside Onionskin/);
  await assert.rejects(srv.sessions.revertAsync(d.s.key, entry.id), (e) => e.status === 409 && e.message === entry.noRevert);
  assert.ok(disk(d).equals(outside), "the outside save is kept");
});

test("7a.4 an op inside a comment's reply that names another copy of the words is refused, and nothing is written", async () => {
  const text = "red / red\n";
  const second = select(text, "red", 1);
  const d = await deliver(text, (b) => [comment("c1", b, second)]);
  const r = await reply(d, { summary: "s", replies: [{ comment: "c1", ops: [op(0, 3, d.batch.base_sha256, "red", "blue")] }] });
  assert.notEqual(r.status, 0);
  assert.ok(r.json.problems.some((p) => p.code === "op_not_on_anchor"), r.stdout);
  assert.ok(disk(d).equals(d.bytes));
  // the same change as a top-level op, with the comment answered on its own range: both land
  const ok = await reply(d, { summary: "s", replies: [{ comment: "c1", ops: [op(6, 9, d.batch.base_sha256, "red", "green")] }], ops: [op(0, 3, d.batch.base_sha256, "red", "blue")] });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.equal(disk(d).toString(), "blue / green\n");
});

test("7a.5 --partial: two requested ranges that overlap refuse the reply even when one of the two ops fails its own check", async () => {
  const text = "red red\n";
  const d = await deliver(text, (b) => [comment("c1", b, select(text, "red"))]);
  const base = d.batch.base_sha256;
  const r = await reply(d, { summary: "s", replies: [{ comment: "c1", decline: true }], ops: [op(0, 3, base, "red", "NEW"), op(1, 3, base, "WRONG", "x")] }, ["--partial"]);
  assert.ok(disk(d).equals(d.bytes), `nothing written: ${disk(d)} ${r.stdout}`);
});

test("7a.7 front matter: the anchor is protected, the shorthand and an explicit op are refused, and nothing is written", async () => {
  const text = "---\ntitle: Old\n---\n\nBody text\n";
  const d = await deliver(text, (b) => [comment("c1", b, select(text, "Old"))]);
  const a = d.batch.untrusted_document_evidence.anchors[0];
  assert.equal(a.protected, true);
  assert.equal(d.batch.instructions.comments[0].reply_with, "decline", "s3-8: only a decline answers it");
  const r1 = await reply(d, { summary: "s", replies: [{ comment: "c1", text: "New" }] });
  assert.notEqual(r1.status, 0);
  const from = text.indexOf("Old");
  const r2 = await reply(d, { summary: "s", replies: [{ comment: "c1", decline: true }], ops: [op(from, from + 3, d.batch.base_sha256, "Old", "New")] });
  assert.notEqual(r2.status, 0);
  assert.ok(disk(d).equals(d.bytes));
  assert.ok(d.batch.how_to_apply.rules.some((x) => /front matter\) are never changed/.test(x)));
});

test("7b a checked write that leaves an empty file is written (an empty result is not a missing payload)", async () => {
  const text = "x";
  const d = await deliver(text, (b) => [comment("c1", b, select(text, "x"))]);
  const r = await reply(d, { summary: "s", replies: [{ comment: "c1", text: "" }] });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(disk(d).length, 0);
});

test("7b a page's claimed edit is never told to the agent: a Markdown Send's edits list is ignored", async () => {
  const text = "alpha\n";
  const d = await deliver(text, (b) => [comment("c1", b, select(text, "alpha"))], { edits: [{ kind: "text", before: "alpha", after: "zebra", label: "paragraph", location: { from: 0, to: 5, version: sha(Buffer.from(text)) } }] });
  assert.deepEqual(d.batch.untrusted_document_evidence.user_edits, []);
  assert.ok(disk(d).equals(d.bytes));
});

test("7b/s3-7 Markdown wording: a stale reply says to decline and never to poll again, and the rules never offer an anchor_id target", async () => {
  const text = "alpha beta\n";
  const d = await deliver(text, (b) => [comment("c1", b, select(text, "beta"))]);
  assert.ok(!d.batch.how_to_apply.rules.some((x) => /target ops by anchor id/.test(x)));
  assert.ok(d.batch.how_to_apply.rules.some((x) => /never an anchor_id/.test(x)));
  fs.writeFileSync(d.file, "alpha beta!\n");
  const r = await reply(d, { summary: "s", replies: [{ comment: "c1", text: "B" }] });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /Decline the comments it affects/);
  assert.doesNotMatch(r.stdout, /poll again/i, "no stale instruction to poll again");
});

// ---- the coordinator's walk of slice 1 in a real browser ------------------------------------------------------------------------------
const TRIP = "# Trip plan\n\nA short plan with **bold words**, soft words. Red car, red bus, red car.\n\n| City | Nights | Cost |\n| --- | --- | --- |\n| Lima | 2 | 300 |\n| Cusco | 3 | 450 |\n";

test("walk 1: the changed places are exactly the replaced ranges of the new revision, one per replacement", async () => {
  const red = select(TRIP, "red", 1);
  const cost = select(TRIP, "450");
  const bold = select(TRIP, "bold");
  const d = await deliver(TRIP, (b) => [comment("c1", b, red), comment("c2", b, cost), comment("c3", b, bold)]);
  const r = await reply(d, { summary: "three changes", replies: [{ comment: "c1", text: "blue" }, { comment: "c2", text: "475" }, { comment: "c3", text: "strong" }] });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const after = disk(d).toString();
  const entry = d.s.activity.find((a) => a.kind === "agent");
  const shown = entry.changes.items.map((it) => after.slice(it.from, it.to));
  assert.deepEqual(shown, ["strong", "blue", "475"], JSON.stringify(entry.changes.items));
  assert.equal(entry.changes.items.length, 3);
});

test("walk 2 (slice 3): after the write, nothing of the old revision has a place: the handled comments resolve as none (shown Done, no warning), a queued comment and a draft keep their words and go out without a place", async () => {
  const red = select(TRIP, "red", 1);
  const cost = select(TRIP, "450");
  const lima = select(TRIP, "Lima");
  const nights = select(TRIP, "Nights");
  const d = await deliver(TRIP, (b) => [comment("c1", b, red), comment("c2", b, cost)]);
  await srv.sessions.sendAsync(d.s.key, { baseSha: d.batch.base_sha256, comments: [...d.s.comments.map((c) => ({ id: c.id, kind: c.kind, text: c.text, anchor: c.anchor })), comment("c3", d.bytes, lima)], note: "", edits: [] });
  assert.equal(d.s.comments.find((c) => c.id === "c3").status, "queued");
  const r = await reply(d, { summary: "s", replies: [{ comment: "c1", text: "a much longer word" }, { comment: "c2", text: "1475" }] });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  srv.sessions.setDraft(d.s.key, { comments: [...d.s.comments.map((c) => ({ id: c.id, kind: c.kind, text: c.text, anchor: c.anchor, status: c.status })), comment("c4", d.bytes, nights)], note: "", rev: 99, tab: "t1" });
  const res = await srv.sessions.resolveAllAsync(d.s.key);
  for (const id of ["c1", "c2", "c3", "c4"]) assert.equal(res.anchors[id].method, "none", id);
  assert.equal(d.s.comments.find((c) => c.id === "c1").status, "done");
  const pending = d.s.pending;
  const ic = pending.instructions.comments.find((c) => c.id === "c3");
  const a3 = pending.untrusted_document_evidence.anchors.find((a) => a.id === ic.anchor_id);
  assert.equal(a3.resolved, false);
  assert.equal(ic.reply_with, "decline");
  assert.equal(ic.text, "fix");
});

test("review 2: delete a selected range, then fill the gap in a later write: the queued comment never names the new words", async () => {
  const text = "L red R\n";
  const d = await deliver(text, (b) => [comment("c1", b, select(text, "L"))]);
  await srv.sessions.sendAsync(d.s.key, { baseSha: d.batch.base_sha256, comments: [...d.s.comments.map((c) => ({ id: c.id, kind: c.kind, text: c.text, anchor: c.anchor })), comment("c2", d.bytes, select(text, "red"))], note: "", edits: [] });
  const r = await reply(d, { summary: "s", replies: [{ comment: "c1", decline: true }], ops: [op(2, 5, d.batch.base_sha256, "red", "")] });
  assert.equal(r.status, 0, r.stdout);
  const next = d.s.pending;
  const ic = next.instructions.comments.find((c) => c.id === "c2");
  const a = next.untrusted_document_evidence.anchors.find((x) => x.id === ic.anchor_id);
  assert.equal(a.resolved, false);
  assert.equal(a.locator?.source, undefined);
});

test("7a.6 the page's selection ends are checked as the server checks them: the & of &amp; before a combining mark is offered as its block", () => {
  const text = "Use &amp;́ here.\n";
  const tree = readMarkdown(text);
  const ent = tree.runs.find((r) => r.kind === "entity");
  const m = sourceRange(tree, { startRun: ent.id, startOffset: 0, endRun: ent.id, endOffset: 1 });
  assert.ok(m.block, JSON.stringify(m));
  assert.equal(m.block.source, text);
});
