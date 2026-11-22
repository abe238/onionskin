// Markdown files end to end through the server's seams, as the page and an agent use them: a selection in the preview made into the
// page's anchor (src/markdown.js sourceRange, as web/src/md-host.js does), Send (anchors built from the file, src/anchors.js), the batch
// (src/batch.js: the exact range, the base sha256 and the exact source of the anchor), `onionskin reply` (src/reply.js) through apply
// (src/ops/markdown.js: one base, all replacements at once), the session's write (src/session.js agentWrite: the result rebuilt from the
// disk bytes and the ops) and Revert. A Markdown write never searches for words: these tests put the selected words more than once in
// the file, next to whitespace that the cleaned quote folds, past the 500 characters the quote keeps, and inside marks the preview hides.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { tmpdir } from "./helpers/zipbuild.js";
const ev = (id, from, to, src) => (typeof id === "string" ? crypto.createHash("sha256").update(`${id}\n${from}\n${to}\n${src}`, "utf8").digest("hex") : undefined); // the selection's evidence (src/anchors.js mdEvidence)

const root = fs.realpathSync(tmpdir("md-session-"));
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
const { ONLY_FORMATS } = await import("../src/constants.js");
const { validate } = await import("./helpers/schema-lite.js");
const BATCH_SCHEMA = JSON.parse(fs.readFileSync(new URL("../docs/contracts/batch.schema.json", import.meta.url), "utf8"));

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
function mdFile(text, name = `n${++n}.md`) {
  const dir = path.join(root, `d${++n}`);
  fs.mkdirSync(dir);
  const f = path.join(dir, name);
  fs.writeFileSync(f, typeof text === "string" ? Buffer.from(text, "utf8") : text);
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

/**
 * The page's anchor for a selection of `needle` in the preview, as web/src/md-host.js makes it: the `nth` run (in source order) whose
 * displayed text holds the needle, from its first character to its last, through sourceRange. Never the source searched for the words.
 */
function select(text, needle, { nth = 0, inRun = 0 } = {}) {
  const tree = readMarkdown(text);
  let seen = 0;
  for (const r of tree.runs) {
    let at = -1;
    let k = 0;
    while ((at = r.display.indexOf(needle, at + 1)) >= 0) {
      if (seen === nth && k === inRun) {
        const m = sourceRange(tree, { startRun: r.id, startOffset: at, endRun: r.id, endOffset: at + needle.length });
        assert.ok(!m.refused && !m.block, `the selection of ${JSON.stringify(needle)} maps to one range: ${m.reason}`);
        return { from: m.from, to: m.to, quote: m.quote };
      }
      k++;
    }
    if (k) seen++;
  }
  throw new Error(`no run shows ${JSON.stringify(needle)}`);
}
/** The page's anchor for a range of the file as it is now (the version the page shows). */
// the revision number the page got with the file (GET /api/file: loadForPage), as the page's anchors name it (slice 3: an anchor is valid
// only on the exact revision it was made on, its sha256 and this number)
let REV = null;
const anchorOf = (bytes, m, kind = "text") => ({ location: { from: m.from, to: m.to, version: sha(bytes), rev: REV }, quote: m.quote, evidence: ev(REV, m.from, m.to, m.quote), prefix: "", suffix: "", format: "markdown", ...(kind === "text" ? {} : { hitKind: "block" }) });
const comment = (id, bytes, m, text = "fix") => ({ id, kind: "text", text, anchor: anchorOf(bytes, m) });

/** A file with a delivered batch held by `holder`. */
async function deliver(text, comments, { name } = {}) {
  const file = mdFile(text, name);
  const bytes = fs.readFileSync(file);
  const s = await srv.sessions.openAsync(file);
  REV = srv.sessions.loadForPage(s.key).mdRev;
  const holder = `H${++n}`;
  const poll = srv.sessions.poll(s.key, { holder });
  await srv.sessions.sendAsync(s.key, { baseSha: s.baseSha, comments: comments(bytes), note: "", edits: [] });
  const batch = await poll.promise;
  return { file, bytes, s, batch, holder, ticket: batch.lease_ticket, env: { ONIONSKIN_HOLDER: holder } };
}
const reply = (d, body) => cli(["reply", d.file, "--lease", d.ticket, "--json", JSON.stringify(body)], { env: d.env });
const disk = (d) => fs.readFileSync(d.file);
/** `after` is `before` with exactly the [from, to) range (UTF-16 offsets after any BOM) replaced by `repl`, byte for byte elsewhere. */
function onlyRange(beforeBytes, afterBytes, from, to, repl) {
  const t = beforeBytes.toString("utf8");
  const bom = t.charCodeAt(0) === 0xfeff ? 1 : 0;
  const want = t.slice(0, bom + from) + repl + t.slice(bom + to);
  assert.equal(afterBytes.toString("utf8"), want);
  assert.ok(afterBytes.equals(Buffer.from(want, "utf8")), "byte for byte");
}

test("open: .md and .markdown open as markdown; a file that is not UTF-8 is refused with one plain sentence; others get the list", async () => {
  const a = await srv.sessions.openAsync(mdFile("# Hi\n", "a.md"));
  assert.equal(a.format, "markdown");
  const b = await srv.sessions.openAsync(mdFile("# Hi\n", "b.MARKDOWN"));
  assert.equal(b.format, "markdown");
  await assert.rejects(srv.sessions.openAsync(mdFile(Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]), "latin.md")), (e) => e.status === 400 && /^This Markdown file is not saved as UTF-8/.test(e.message) && !/\n/.test(e.message));
  await assert.rejects(srv.sessions.openAsync(mdFile("x", "x.txt")), (e) => e.status === 400 && e.message === ONLY_FORMATS);
  const big = Buffer.alloc(1_153_433, 0x61);
  await assert.rejects(srv.sessions.openAsync(mdFile(big, "big.md")), (e) => e.status === 400 && e.message === "This Markdown file is 1,153,433 bytes, more than the 1,048,576 bytes (1 MB) Onionskin can read. Split it into smaller files and open those.");
  assert.match(ONLY_FORMATS, /\.md and \.markdown/);
});

test("a. banana: the first ana, then separately the last ana; each reply changes exactly that copy", async () => {
  const text = "banana\n";
  const first = select(text, "ana", { inRun: 0 });
  const last = select(text, "ana", { inRun: 1 });
  assert.deepEqual([first.from, first.to, last.from, last.to], [1, 4, 3, 6]);
  const d1 = await deliver(text, (b) => [comment("c1", b, first)]);
  const a = d1.batch.untrusted_document_evidence.anchors[0];
  assert.deepEqual({ from: a.locator.from, to: a.locator.to, sha256: a.locator.sha256, source: a.locator.source }, { from: 1, to: 4, sha256: sha(d1.bytes), source: "ana" });
  assert.equal(d1.batch.instructions.comments[0].reply_with, "text_or_ops");
  validate(d1.batch, BATCH_SCHEMA, BATCH_SCHEMA, "$"); // the delivered batch, as the contract describes it
  assert.ok(!d1.batch.how_to_apply.rules.some((r) => /\bcommit\b.*--from/.test(r)), "no commit route offered for Markdown");
  const md = d1.batch.untrusted_document_evidence.markdown;
  assert.equal(md.base_sha256, sha(d1.bytes));
  assert.deepEqual(md.blocks.map((x) => [x.type, x.from, x.to, x.source]), [["paragraph", 0, 7, "banana\n"]]);
  let r = await reply(d1, { summary: "s", replies: [{ comment: "c1", text: "XYZ" }] });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(disk(d1).toString(), "bXYZna\n");
  const d2 = await deliver(text, (b) => [comment("c1", b, last)]);
  r = await reply(d2, { summary: "s", replies: [{ comment: "c1", text: "XYZ" }] });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(disk(d2).toString(), "banXYZ\n");
});

test("b. red car, red bus: a comment on the second red and an op on the first land on their own copies (one base); overlapping ranges refuse the whole reply", async () => {
  const text = "red car, red bus\n";
  const second = select(text, "red", { inRun: 1 });
  assert.deepEqual([second.from, second.to], [9, 12]);
  const d = await deliver(text, (b) => [comment("c1", b, second)]);
  const base = d.batch.base_sha256;
  // the op on the first red names its range and old text; the comment's shorthand replaces the second. Both read the base offsets:
  // the first replacement making the line longer never moves the second
  const r = await reply(d, { summary: "s", replies: [{ comment: "c1", text: "blue" }], ops: [{ op: "replace_source", target: { from: 0, to: 3 }, expect: { sha256: base, source: "red" }, text: "dark green" }] });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(disk(d).toString(), "dark green car, blue bus\n");

  const o = await deliver(text, (b) => [comment("c1", b, second)]);
  const before = disk(o);
  const bad = await reply(o, { summary: "s", replies: [{ comment: "c1", text: "blue" }], ops: [{ op: "replace_source", target: { from: 4, to: 11 }, expect: { sha256: o.batch.base_sha256, source: "car, re" }, text: "x" }] });
  assert.notEqual(bad.status, 0);
  assert.equal(bad.json.ok, false);
  assert.equal(bad.json.written, false);
  assert.ok(JSON.stringify(bad.json).includes("overlap"), bad.stdout);
  assert.ok(disk(o).equals(before), "nothing written");
  assert.equal(srv.sessions.state(o.s), "working", "the batch stays open");
});

test("c. a double space, a tab and a no-break space next to the selection: exactly the range is written", async () => {
  const text = "one  two\tthree\u00a0four  two\n";
  const m = select(text, "two", { inRun: 1 });
  assert.equal(text.slice(m.from, m.to), "two");
  assert.equal(m.from, text.lastIndexOf("two"));
  const d = await deliver(text, (b) => [comment("c1", b, m)]);
  assert.equal(d.batch.untrusted_document_evidence.anchors[0].locator.source, "two");
  const r = await reply(d, { summary: "s", replies: [{ comment: "c1", text: "2" }] });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  onlyRange(d.bytes, disk(d), m.from, m.to, "2");
});

test("d. a selection longer than 500 characters: exactly that range is replaced, not one character beyond", async () => {
  const words = Array.from({ length: 160 }, (_, i) => `w${i}`).join("  ");
  const text = `Start ${words} end.\n`;
  const tree = readMarkdown(text);
  const run = tree.runs[0];
  const m = sourceRange(tree, { startRun: run.id, startOffset: 6, endRun: run.id, endOffset: 6 + 700 });
  assert.equal(m.to - m.from, 700);
  const d = await deliver(text, (b) => [comment("c1", b, m)]);
  const a = d.batch.untrusted_document_evidence.anchors[0];
  assert.ok(a.quote.length <= 500, "the quote is the cleaned, clipped copy");
  assert.equal(a.locator.source, text.slice(6, 706), "the source is the exact text, in full");
  const r = await reply(d, { summary: "s", replies: [{ comment: "c1", text: "[cut]" }] });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  onlyRange(d.bytes, disk(d), 6, 706, "[cut]");
});

test("e. emoji, CRLF, a BOM, an entity, an escape, text in **bold** and in a link label: ranges and bytes exact", async () => {
  const text = "\uFEFF# Plan 😀 now\r\n\r\nTom &amp; Jerry \\* star **bold 😀 word** and [the label](https://example.com/x \"t\") end\r\n";
  const tree = readMarkdown(text);
  const ent = tree.runs.find((r) => r.kind === "entity");
  const esc = tree.runs.find((r) => r.kind === "escape");
  const mEnt = sourceRange(tree, { startRun: ent.id, startOffset: 0, endRun: ent.id, endOffset: 1 });
  const mEsc = sourceRange(tree, { startRun: esc.id, startOffset: 0, endRun: esc.id, endOffset: 1 });
  const body = text.slice(1); // offsets are after the BOM
  assert.equal(body.slice(mEnt.from, mEnt.to), "&amp;");
  assert.equal(body.slice(mEsc.from, mEsc.to), "\\*");
  const mBold = select(text, "😀 word");
  assert.equal(body.slice(mBold.from, mBold.to), "😀 word");
  const mLabel = select(text, "label");
  assert.equal(body.slice(mLabel.from, mLabel.to), "label");
  const mHead = select(text, "😀", { nth: 0 });
  assert.equal(body.slice(mHead.from, mHead.to), "😀");
  const d = await deliver(text, (b) => [comment("c1", b, mEnt), comment("c2", b, mEsc), comment("c3", b, mBold), comment("c4", b, mLabel), comment("c5", b, mHead)]);
  const locs = d.batch.untrusted_document_evidence.anchors.map((a) => a.locator.source);
  assert.deepEqual(locs, ["&amp;", "\\*", "😀 word", "label", "😀"]);
  const r = await reply(d, { summary: "s", replies: [{ comment: "c1", text: "and" }, { comment: "c2", text: "\\#" }, { comment: "c3", text: "🎉 thing" }, { comment: "c4", text: "new label" }, { comment: "c5", text: "🚀" }] });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const want = "\uFEFF# Plan 🚀 now\r\n\r\nTom and Jerry \\# star **bold 🎉 thing** and [the new label](https://example.com/x \"t\") end\r\n";
  assert.ok(disk(d).equals(Buffer.from(want, "utf8")), `${JSON.stringify(disk(d).toString())}`);
  assert.equal(disk(d)[0], 0xef, "the BOM is kept");
});

test("f. a stale hash: the file changed on disk after the batch, so the reply is refused and the file is left untouched", async () => {
  const text = "alpha beta\n";
  const d = await deliver(text, (b) => [comment("c1", b, select(text, "beta"))]);
  const changed = Buffer.from("alpha beta gamma\n");
  fs.writeFileSync(d.file, changed);
  const r = await reply(d, { summary: "s", replies: [{ comment: "c1", text: "BETA" }] });
  assert.notEqual(r.status, 0);
  assert.equal(r.json.ok, false);
  assert.ok(disk(d).equals(changed), "the changed file is not overwritten");
});

test("g. old text that differs by one character is refused, and nothing is written", async () => {
  const text = "alpha beta\n";
  const d = await deliver(text, (b) => [comment("c1", b, select(text, "beta"))]);
  const r = await reply(d, { summary: "s", replies: [{ comment: "c1", ops: [{ op: "replace_source", target: { from: 6, to: 10 }, expect: { sha256: d.batch.base_sha256, source: "betA" }, text: "BETA" }] }] });
  assert.notEqual(r.status, 0);
  assert.equal(r.json.ok, false);
  assert.ok(disk(d).equals(d.bytes));
  // the same with the right old text goes through (the refusal was the one character)
  const ok = await reply(d, { summary: "s", replies: [{ comment: "c1", ops: [{ op: "replace_source", target: { from: 6, to: 10 }, expect: { sha256: d.batch.base_sha256, source: "beta" }, text: "BETA" }] }] });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.equal(disk(d).toString(), "alpha BETA\n");
});

test("find+replace is not offered for Markdown: the reply says to use text or replace_source, and nothing is written", async () => {
  const text = "alpha beta\n";
  const d = await deliver(text, (b) => [comment("c1", b, select(text, "beta"))]);
  const r = await reply(d, { summary: "s", replies: [{ comment: "c1", find: "beta", replace: "x" }] });
  assert.notEqual(r.status, 0);
  assert.ok(r.json.problems.some((p) => p.code === "shorthand_not_for_format"), r.stdout);
  assert.ok(disk(d).equals(d.bytes));
});

test("i. Revert after an agent write gives back byte-identical content", async () => {
  const text = "\uFEFFline one\r\nline  two\r\nno final newline";
  const d = await deliver(text, (b) => [comment("c1", b, select(text, "two"))]);
  const r = await reply(d, { summary: "s", replies: [{ comment: "c1", text: "2" }] });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(!disk(d).equals(d.bytes));
  const entry = d.s.activity.find((a) => a.kind === "agent");
  await srv.sessions.revertAsync(d.s.key, entry.id);
  assert.ok(disk(d).equals(d.bytes), "byte for byte the version before the run");
});

test("the session writes a Markdown file only with a replacement it rebuilt: raw commits, page bytes and merges are refused", async () => {
  const text = "alpha beta\n";
  const d = await deliver(text, (b) => [comment("c1", b, select(text, "beta"))]);
  const claim = { holder: d.holder, token: d.batch.lease.token, batchId: d.batch.batch_id };
  await assert.rejects(srv.sessions.agentWriteChecked(d.s.key, { bytes: Buffer.from("rewritten\n"), ...claim }), (e) => e.extra?.code === "not_for_markdown");
  await assert.rejects(srv.sessions.agentWriteChecked(d.s.key, { baseSha: d.batch.base_sha256, bytes: Buffer.from("alpha BETA!\n"), route: "apply", ops: [{ op: "replace_source", target: { from: 6, to: 10 }, expect: { sha256: d.batch.base_sha256, source: "beta" }, text: "BETA" }], ...claim }), (e) => e.extra?.code === "unchecked_write");
  assert.ok(disk(d).equals(d.bytes));
  const f2 = mdFile("x\n");
  const s2 = await srv.sessions.openAsync(f2);
  await assert.rejects(srv.sessions.sendAsync(s2.key, { baseSha: s2.baseSha, bytes: Buffer.from("y\n"), comments: [], note: "" }), (e) => e.extra?.code === "no_bytes_for_markdown");
  await assert.rejects(srv.sessions.mergeUserEdits(s2.key, { baseSha: s2.baseSha, bytes: Buffer.from("y\n") }), (e) => e.extra?.code === "not_for_markdown");
});

test("a comment made on another version of the file is not placed by its words: its anchor goes out unresolved", async () => {
  const text = "alpha beta\n";
  const file = mdFile(text);
  const s = await srv.sessions.openAsync(file);
  const m = select(text, "beta");
  const old = { id: "c1", kind: "text", text: "x", anchor: { ...anchorOf(Buffer.from(text), m), location: { from: m.from, to: m.to, version: "0".repeat(64) } } };
  const poll = srv.sessions.poll(s.key, { holder: "Hv" });
  await srv.sessions.sendAsync(s.key, { baseSha: s.baseSha, comments: [old], note: "" });
  const batch = await poll.promise;
  const a = batch.untrusted_document_evidence.anchors[0];
  assert.equal(a.resolved, false);
  assert.equal(batch.instructions.comments[0].reply_with, "decline"); // slice 3: a Markdown anchor with no place offers only a decline (was decline_or_ops)
});
