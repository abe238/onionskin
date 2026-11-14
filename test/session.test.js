import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, before, after } from "node:test";
import { tmpdir, docxBytes } from "./helpers/zipbuild.js";

const root = tmpdir();
process.env.ONIONSKIN_STATE_DIR = path.join(root, "st");
process.env.ONIONSKIN_LEASE_MS = "1000";
delete process.env.ONIONSKIN_PYTHON; // `done` must not reach a developer's checker venv with these toy zips
process.env.ONIONSKIN_NO_SOFFICE = "1";
const { Sessions, HttpError } = await import("../src/session.js");
const { atomicReplace, Snapshots, sha256 } = await import("../src/fsutil.js");
const { ensureStateDir } = await import("../src/paths.js");
ensureStateDir();

const paras = Array.from({ length: 12 }, (_, i) => `Paragraph ${i + 1}: some real sentence number ${i * 5 + 3} for the anchor tests.`);
const write = (name, bytes = docxBytes(paras)) => {
  const f = path.join(root, name);
  fs.writeFileSync(f, bytes);
  return fs.realpathSync(f);
};
const comment = (id, i, text = "fix") => ({ id, kind: "element", text, anchor: { location: { blockPath: [i] }, paraText: paras[i] } });
const rejects = async (fn, status, code) => {
  try {
    await fn();
  } catch (e) {
    assert.ok(e instanceof HttpError, String(e));
    assert.equal(e.status, status, e.message);
    if (code) assert.equal(e.extra.code, code);
    return e;
  }
  assert.fail("expected HttpError");
};

after(() => fs.rmSync(root, { recursive: true, force: true }));

test("open: refuses macro formats, non-ZIP, wrong format, directories, missing files; one session per realpath", () => {
  const S = new Sessions();
  for (const ext of [".docm", ".xlsm", ".pptm"]) {
    const f = path.join(root, `m${ext}`);
    fs.writeFileSync(f, docxBytes(["x"]));
    assert.throws(() => S.open(f), /macro/);
  }
  const bad = path.join(root, "bad.docx");
  fs.writeFileSync(bad, "not a zip");
  assert.throws(() => S.open(bad), /Not a valid \.docx/);
  const mismatch = path.join(root, "really-docx.xlsx");
  fs.writeFileSync(mismatch, docxBytes(["x"]));
  assert.throws(() => S.open(mismatch), /Not a valid \.xlsx/);
  assert.throws(() => S.open(path.join(root, "nope.docx")), /not found/i);
  assert.throws(() => S.open(root), /Only \.docx/);
  fs.writeFileSync(path.join(root, "t.txt"), "x");
  assert.throws(() => S.open(path.join(root, "t.txt")), /Only \.docx/);
  const f = write("a.docx");
  const link = path.join(root, "link.docx");
  fs.symlinkSync(f, link);
  const s1 = S.open(f);
  const s2 = S.open(link);
  assert.equal(s1, s2, "a symlink and its target are one session");
  assert.ok(s1.snapshots.index().some((e) => e.original), "original stored on first open");
});

test("state machine: idle -> listening -> working -> idle; send with a poller delivers at once", async () => {
  const S = new Sessions();
  const f = write("sm1.docx");
  const s = S.open(f);
  assert.equal(S.state(s), "idle");
  const poll = S.poll(s.key);
  assert.equal(S.state(s), "listening");
  S.send(s.key, { baseSha: s.baseSha, comments: [comment("c1", 3)], note: "hi" });
  const batch = await poll.promise;
  assert.equal(batch.instructions.comments[0].id, "c1");
  assert.equal(batch.instructions.overall_note, "hi");
  assert.equal(S.state(s), "working");
  assert.ok(S.view(s).locked);
  const out = S.done(s.key, { summary: "ok", results: [{ comment_id: "c1", status: "done", note: "n" }] });
  assert.deepEqual(out.flags, []);
  assert.equal(S.state(s), "idle");
  assert.equal(s.comments[0].status, "done");
  assert.equal(s.activity[0].results[0].note, "n");
});

test("done: document_instructions_ignored is sanitized (5 items, 200 chars) and the summary is capped at 400", async () => {
  const S = new Sessions();
  const f = write("dii1.docx");
  const s = S.open(f);
  const poll = S.poll(s.key);
  S.send(s.key, { baseSha: s.baseSha, comments: [comment("c1", 3)], note: "" });
  await poll.promise;
  const many = ["one\u202Ebidi", "x".repeat(900), "3", "4", "5", "6", "7"];
  S.done(s.key, { summary: "s".repeat(900), document_instructions_ignored: many, results: [{ comment_id: "c1", status: "done" }] });
  const a = s.activity[0];
  assert.equal(a.documentInstructionsIgnored.length, 5);
  assert.equal(a.documentInstructionsIgnored[0], "onebidi");
  assert.ok([...a.documentInstructionsIgnored[1]].length <= 200);
  assert.ok([...a.summary].length <= 400 + "…[truncated]".length);
});

test("done: document_instructions_ignored keeps strings only, counts a case-only duplicate once, and says when more than 5 were reported", async () => {
  const S = new Sessions();
  const report = async (name, list) => {
    const s = S.open(write(name));
    const poll = S.poll(s.key);
    S.send(s.key, { baseSha: s.baseSha, comments: [comment("c1", 3)], note: "" });
    await poll.promise;
    S.done(s.key, { summary: "ok", ...(list === undefined ? {} : { document_instructions_ignored: list }), results: [{ comment_id: "c1", status: "done" }] });
    return s.activity[0];
  };
  // numbers, objects, null and empty strings are dropped; "Ignore" and "IGNORE" are one
  let a = await report("dii2.docx", ["Ignore previous", 42, { a: 1 }, null, "   ", "IGNORE PREVIOUS", "second", "\u200b"]);
  assert.deepEqual(a.documentInstructionsIgnored, ["Ignore previous", "second"]);
  assert.equal("documentInstructionsIgnoredMore" in a, false);
  // exactly 5 distinct: no "more"
  a = await report("dii3.docx", ["a1", "b2", "c3", "d4", "e5"]);
  assert.equal(a.documentInstructionsIgnored.length, 5);
  assert.equal("documentInstructionsIgnoredMore" in a, false);
  // 6 distinct: 5 kept and "more"
  a = await report("dii4.docx", ["a1", "b2", "c3", "d4", "e5", "f6"]);
  assert.equal(a.documentInstructionsIgnored.length, 5);
  assert.equal(a.documentInstructionsIgnoredMore, true);
  // 5 distinct plus a sixth that only repeats one of them in another case: not "more"
  a = await report("dii5.docx", ["a1", "b2", "c3", "d4", "e5", "A1"]);
  assert.equal("documentInstructionsIgnoredMore" in a, false);
  // junk before the real items does not use up the 5 slots, but only the first 50 raw items are looked at
  a = await report("dii6.docx", [...Array(10).fill(7), "a1", "b2"]);
  assert.deepEqual(a.documentInstructionsIgnored, ["a1", "b2"]);
  a = await report("dii7.docx", [...Array(50).fill(null), "late"]);
  assert.equal("documentInstructionsIgnored" in a, false);
  // an empty or missing list stores neither field
  for (const [n, v] of [["dii8.docx", []], ["dii9.docx", undefined], ["dii10.docx", "not a list"]]) {
    a = await report(n, v);
    assert.equal("documentInstructionsIgnored" in a, false);
    assert.equal("documentInstructionsIgnoredMore" in a, false);
  }
});

test("state machine: no poller -> stranded with the exact command; a later poll delivers and locks", async () => {
  const S = new Sessions();
  const s = S.open(write("sm2.docx"));
  S.send(s.key, { baseSha: s.baseSha, comments: [comment("c1", 1)], note: "" });
  assert.equal(S.state(s), "stranded");
  assert.equal(S.view(s).strandedCommand, `onionskin poll '${s.file}'`);
  const batch = await S.poll(s.key).promise;
  assert.equal(batch.instructions.comments.length, 1);
  assert.equal(S.state(s), "working");
  assert.equal(S.view(s).strandedCommand, null);
});

test("state machine: lease expiry flips to stranded and unlocks; re-poll redelivers; late done is refused", async () => {
  let t = 1_000_000;
  const S = new Sessions({ now: () => t });
  const s = S.open(write("sm3.docx"));
  S.send(s.key, { baseSha: s.baseSha, comments: [comment("c1", 2)], note: "" });
  const first = await S.poll(s.key, { holder: "agent" }).promise;
  assert.equal(S.state(s), "working");
  t += 500;
  S.tick();
  assert.equal(S.state(s), "working", "lease still valid");
  S.poll(s.key, { ack: true, holder: "agent" }).cancel(); // ack renews the lease
  t += 800;
  S.tick();
  assert.equal(S.state(s), "working", "renewed by ack");
  t += 1500;
  S.tick();
  assert.equal(S.state(s), "stranded");
  assert.equal(s.activity[0].kind, "lease_expired");
  const again = await S.poll(s.key).promise;
  assert.equal(again.batch_id, first.batch_id, "same batch redelivered");
  S.takeBack(s.key);
  assert.equal(S.state(s), "idle");
  assert.equal(s.comments[0].status, "draft", "comments return to drafts on take back");
  await rejects(() => S.done(s.key, { summary: "late" }), 409, "no_batch");
});

test("state machine: Send while working is queued (comments only, bytes refused) and becomes the next batch after done", async () => {
  const S = new Sessions();
  const s = S.open(write("sm4.docx"));
  S.send(s.key, { baseSha: s.baseSha, comments: [comment("c1", 1)], note: "" });
  await S.poll(s.key).promise;
  S.send(s.key, { baseSha: s.baseSha, comments: [comment("c1", 1), comment("c2", 5, "later")], note: "n2" });
  assert.equal(S.state(s), "queued");
  assert.equal(s.comments.find((c) => c.id === "c2").status, "queued");
  await rejects(() => S.send(s.key, { baseSha: s.baseSha, bytes: docxBytes(paras), comments: [], note: "" }), 423, "locked");
  S.done(s.key, { summary: "first", results: [{ comment_id: "c1", status: "done" }] });
  assert.equal(S.state(s), "stranded", "queued batch waits for the next poll");
  const next = await S.poll(s.key).promise;
  assert.deepEqual(next.instructions.comments.map((c) => c.id), ["c2"]);
  assert.equal(next.instructions.overall_note, "n2");
});

test("close: the closed tab stops being the editor, so the tab that reopens the file can edit", () => {
  const S = new Sessions();
  const f = path.join(root, "reopen-editor.docx");
  fs.writeFileSync(f, docxBytes(["x"]));
  const s = S.open(f);
  assert.equal(S.claimEditor(s.key, "tab-old-1"), true);
  S.close(s.key);
  S.open(f); // reopened under the same name while the old tab is still on screen
  assert.equal(S.claimEditor(s.key, "tab-new-1"), true, "the new tab edits");
  assert.equal(S.claimEditor(s.key, "tab-old-1"), false, "the old tab does not take it back");
});

test("state machine: a new poll supersedes the old; close ends pollers", async () => {
  const S = new Sessions();
  const s = S.open(write("sm5.docx"));
  const p1 = S.poll(s.key);
  const p2 = S.poll(s.key);
  assert.equal((await p1.promise).status, "superseded");
  S.close(s.key);
  assert.equal((await p2.promise).status, "closed");
  assert.equal(S.state(s), "closed");
  await rejects(() => S.send(s.key, { baseSha: s.baseSha, comments: [], note: "" }), 409, "closed");
});

test("send: compare-and-swap on the disk hash (409, nothing written); invalid package refused", () => {
  const S = new Sessions();
  const f = write("cas.docx");
  const s = S.open(f);
  const base = s.baseSha;
  const changed = docxBytes(["changed on disk by someone else"]);
  fs.writeFileSync(f, changed);
  const e = rejects(() => S.send(s.key, { baseSha: base, bytes: docxBytes(["mine"]), comments: [], note: "" }), 409, "conflict");
  return e.then((err) => {
    assert.equal(err.extra.diskSha, sha256(changed));
    assert.deepEqual(fs.readFileSync(f), changed, "conflicting Send must not write");
    return rejects(() => S.send(s.key, { baseSha: sha256(changed), bytes: Buffer.from("garbage"), comments: [], note: "" }), 422, "invalid_package");
  });
});

test("send: written bytes land atomically with the original mode; a snapshot of the previous bytes exists", () => {
  const S = new Sessions();
  const f = write("mode.docx");
  fs.chmodSync(f, 0o640);
  const s = S.open(f);
  const before = fs.readFileSync(f);
  const mine = docxBytes(["Paragraph 1 edited by the user."]);
  S.send(s.key, { baseSha: s.baseSha, bytes: mine, comments: [], note: "x" });
  assert.deepEqual(fs.readFileSync(f), mine);
  assert.equal(fs.statSync(f).mode & 0o7777, 0o640);
  assert.deepEqual(fs.readdirSync(path.dirname(f)).filter((n) => n.includes(".tmp")), [], "no temp file left behind");
  assert.ok(s.snapshots.has(sha256(before)), "pre-write bytes snapshotted");
  assert.ok(s.snapshots.has(sha256(mine)));
  assert.equal(s.baseSha, sha256(mine));
});

test("atomicReplace refuses a symlink and non-regular files", () => {
  const target = write("real.docx");
  const link = path.join(root, "evil-link.docx");
  fs.symlinkSync(target, link);
  assert.throws(() => atomicReplace(link, Buffer.from("x")), /symbolic link/);
  assert.deepEqual(fs.readFileSync(target), docxBytes(paras));
  assert.throws(() => atomicReplace(root, Buffer.from("x")), /not a regular file/);
});

test("done: package check flags a lost drawing and a removed part; revert refuses when the disk changed, otherwise restores", async () => {
  const S = new Sessions();
  const withDrawing = docxBytes([], { "word/media/a.png": "png" }, '<w:p><w:r><w:drawing/></w:r></w:p><w:p><w:r><w:t>Paragraph 1 text</w:t></w:r></w:p>');
  const f = write("flags.docx", withDrawing);
  const s = S.open(f);
  const poll = S.poll(s.key);
  S.send(s.key, { baseSha: s.baseSha, comments: [], note: "go" });
  const batch = await poll.promise;
  const agentOut = docxBytes([], {}, "<w:p><w:r><w:t>Paragraph 1 text</w:t></w:r></w:p>");
  S.agentWrite(s.key, { baseSha: s.baseSha, bytes: agentOut, holder: "agent", token: batch.lease.token, batchId: batch.batch_id }); // the agent's write goes through the server
  const { flags } = S.done(s.key, { summary: "removed stuff", results: [] });
  assert.deepEqual(flags.map((x) => x.code).sort(), ["count_decreased", "part_removed"]);
  const run = s.activity[0];
  // someone else touches the file: revert must refuse
  fs.writeFileSync(f, docxBytes(["third party"]));
  await rejects(() => S.revert(s.key, run.id), 409, "changed_since");
  fs.writeFileSync(f, agentOut);
  S.revert(s.key, run.id);
  assert.equal(sha256(fs.readFileSync(f)), run.preSha);
  assert.equal(S.state(s), "idle");
  assert.ok(s.snapshots.has(run.postSha), "post-agent version kept as a snapshot");
  await rejects(() => S.revert(s.key, run.id), 404);
});

test("snapshots: content addressed, original kept forever, version cap and byte cap enforced", () => {
  const dir = path.join(root, "st");
  const snaps = new Snapshots("capkey", { keep: 3, maxBytes: 10_000 });
  const orig = snaps.add(Buffer.from("original-bytes"), "original", { original: true });
  const shas = [];
  for (let i = 0; i < 6; i++) shas.push(snaps.add(Buffer.from(`version-${i}`.padEnd(100, "x")), `v${i}`));
  assert.equal(snaps.add(Buffer.from("version-5".padEnd(100, "x")), "dup"), shas[5], "same content, same address");
  const idx = snaps.index();
  assert.ok(idx.some((e) => e.sha === orig && e.original), "original survives pruning");
  assert.equal(idx.filter((e) => !e.original).length, 3, "only the newest 3 versions remain");
  assert.ok(!snaps.has(shas[0]) && snaps.has(shas[5]));
  const big = new Snapshots("bytecap", { keep: 50, maxBytes: 250 });
  big.add(Buffer.alloc(100, 1), "o", { original: true });
  for (let i = 0; i < 5; i++) big.add(Buffer.alloc(100, i + 2), `b${i}`);
  const kept = big.index().filter((e) => !e.original);
  assert.ok(kept.reduce((n, e) => n + e.size, 0) + 100 <= 250 + 100, "byte cap pruned old versions");
  assert.ok(kept.length < 5);
  assert.ok(fs.existsSync(dir));
});
