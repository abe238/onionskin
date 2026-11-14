// `onionskin reply` against a real server and the real CLI, on the committed engine samples (copied to a temp dir, never written in place).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test, before, after } from "node:test";
import { fileURLToPath } from "node:url";
import { docxBytes, tmpdir } from "./helpers/zipbuild.js";

const root = tmpdir();
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE = path.join(root, "st");
process.env.ONIONSKIN_STATE_DIR = STATE;
process.env.ONIONSKIN_LEASE_MS = "60000";
process.env.ONIONSKIN_TICK_MS = "100000";
process.env.ONIONSKIN_NO_SOFFICE = "1";
delete process.env.ONIONSKIN_PYTHON;
const { ENGINE_SAMPLES, haveSamples, skipUnless } = await import("../scripts/fixtures.mjs");
const SKIP = skipUnless(haveSamples(), `engine samples not found in ${ENGINE_SAMPLES}`, "restore test/fixtures/engine or set ONIONSKIN_TEST_SAMPLES");
const { startServer } = await import("../src/server.js");
const { readDocxParagraphs } = await import("../src/docx.js");
const { planReplies } = await import("../src/reply.js");
const { openZip } = await import("../src/zip.js");

let srv;
before(async () => {
  srv = await startServer();
});
after(() => {
  srv?.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

let n = 0;
const sample = (name) => {
  const f = path.join(root, `r${++n}-${name}`);
  fs.copyFileSync(path.join(ENGINE_SAMPLES, name), f);
  return fs.realpathSync(f);
};
const cli = (args, { env = {}, stdin = null } = {}) =>
  new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(repo, "src", "cli.js"), ...args], { env: { PATH: process.env.PATH, HOME: root, ONIONSKIN_STATE_DIR: STATE, ONIONSKIN_NO_SOFFICE: "1", ...env }, stdio: [stdin === null ? "ignore" : "pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    c.stdout.on("data", (d) => (stdout += d));
    c.stderr.on("data", (d) => (stderr += d));
    c.on("exit", (status) => resolve({ status, stdout, stderr, json: (() => { try { return JSON.parse(stdout.split("\n")[0]); } catch { return null; } })() }));
    if (stdin !== null) c.stdin.end(stdin);
  });

const docxComment = (id, i, paraText, text = "fix") => ({ id, kind: "element", text, anchor: { location: { blockPath: [i] }, paraText } });
const xlsxCell = (id, range, quote = "", text = "fix") => ({ id, kind: "element", text, anchor: { location: { sheetIndex: 0, sheetName: "Sales", range }, quote, hitKind: quote ? "sheet-cell" : "sheet-range" } });
const pptxShape = (id, shapeId, shapeName, quote) => ({ id, kind: "element", text: "fix", anchor: { location: { slideIndex: 0, slideId: "256", shapeId, shapeName }, quote, hitKind: "shape" } });

/** A file with a delivered batch held by `holder`. */
async function deliver(name, comments, holder = `H${n + 1}`) {
  const file = sample(name);
  const s = srv.sessions.open(file);
  const poll = srv.sessions.poll(s.key, { holder });
  srv.sessions.send(s.key, { baseSha: s.baseSha, comments, note: "" });
  const batch = await poll.promise;
  return { file, s, batch, holder, ticket: batch.lease_ticket, env: { ONIONSKIN_HOLDER: holder } };
}
const reply = (d, body, extra = []) => cli(["reply", d.file, "--lease", d.ticket, "--json", JSON.stringify(body), ...extra], { env: d.env });
const texts = (file) => readDocxParagraphs(fs.readFileSync(file)).map((p) => p.text);
const slideText = (file, n) => openZip(fs.readFileSync(file)).readText(`ppt/slides/slide${n}.xml`);
const bytesOf = (f) => fs.readFileSync(f);

const P3 = "Revenue grew 24% year over year";
const P4 = "Two new regions launched";
const P5 = "Customer churn fell to 3.1%";

test("docx: find+replace and text shorthands, a decline, in one call that also finishes the batch", { skip: SKIP }, async () => {
  const d = await deliver("sample.docx", [docxComment("c1", 3, P3), docxComment("c2", 4, P4), docxComment("c3", 5, P5)]);
  const r = await reply(d, { summary: "Edited two lines.", replies: [{ comment: "c1", find: "24%", replace: "40%", note: "Updated the figure." }, { comment: "c2", text: "Three new regions launched", note: "Reworded." }, { comment: "c3", decline: true, note: "Leave the churn figure." }] });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stderr, "", "STDOUT only");
  assert.deepEqual(r.json.applied, ["c1", "c2"]);
  assert.deepEqual(r.json.declined, ["c3"]);
  assert.equal(r.json.ok, true);
  assert.ok(Array.isArray(r.json.flags));
  assert.match(r.json.checks_notice, /./);
  const t = texts(d.file);
  assert.ok(t.includes("Revenue grew 40% year over year"));
  assert.ok(t.includes("Three new regions launched"));
  assert.ok(t.includes(P5), "a declined comment changes nothing");
  assert.equal(srv.sessions.state(d.s), "idle", "done ran: the batch is finished");
  assert.deepEqual(d.s.comments.map((c) => [c.id, c.status, c.result]), [["c1", "done", "Updated the figure."], ["c2", "done", "Reworded."], ["c3", "declined", "Leave the churn figure."]]);
  assert.equal(d.s.activity[0].summary, "Edited two lines.");
});

test("xlsx: set on a cell and on a range; the hash comes from the session", { skip: SKIP }, async () => {
  const d = await deliver("sample.xlsx", [xlsxCell("c1", "A3", "North"), xlsxCell("c2", "C4:D4")]);
  assert.deepEqual(d.batch.instructions.comments.map((c) => c.reply_with), ["set", "set"]);
  const r = await reply(d, { summary: "s", replies: [{ comment: "c1", set: "Northwest" }, { comment: "c2", set: [[300, 18.5]], note: "new units and price" }] });
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual(r.json.applied, ["c1", "c2"]);
  const sheet = openZip(bytesOf(d.file)).readText("xl/worksheets/sheet1.xml");
  assert.match(sheet, /Northwest/);
  assert.match(sheet, /<v>300<\/v>/);
  assert.match(sheet, /<v>18\.5<\/v>/);
});

test("pptx: find+replace inside a shape and text for the whole shape", { skip: SKIP }, async () => {
  const d = await deliver("sample.pptx", [pptxShape("c1", 2, "Title 1", "office-engine"), pptxShape("c2", 3, "Subtitle 2", "Progressive Office viewer for the browser")]);
  assert.deepEqual(d.batch.instructions.comments.map((c) => c.reply_with), ["find_replace_or_text", "find_replace_or_text"]);
  const r = await reply(d, { summary: "s", replies: [{ comment: "c1", text: "Onionskin demo" }, { comment: "c2", find: "browser", replace: "Mac" }] });
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual(r.json.applied, ["c1", "c2"]);
  const x = slideText(d.file, 1);
  assert.match(x, /Onionskin demo/);
  assert.match(x, /viewer for the Mac/);
});

test("full ops in a reply, and batch-wide ops that answer no comment", { skip: SKIP }, async () => {
  const d = await deliver("sample.docx", [docxComment("c1", 3, P3)]);
  const a = d.batch.untrusted_document_evidence.anchors[0];
  const r = await reply(d, { summary: "s", replies: [{ comment: "c1", ops: [{ op: "replace_text", target: { anchor_id: a.id }, expect: { text_hash: a.locator.text_hash }, find: "Revenue", replace: "Sales" }] }], ops: [{ op: "replace_all_text", find: "Quarterly", replace: "Annual", expect: { count: 1 } }] });
  assert.equal(r.status, 0, r.stdout);
  const t = texts(d.file);
  assert.ok(t.includes("Sales grew 24% year over year"));
  assert.ok(t.includes("Annual Report"));
});

test("atomic failure: nothing is written, the batch stays open with its lease, the output says what failed and how to fix it; a corrected reply then works", { skip: SKIP }, async () => {
  const d = await deliver("sample.docx", [docxComment("c1", 3, P3), docxComment("c2", 4, P4)]);
  const before = bytesOf(d.file);
  const r = await reply(d, { summary: "s", replies: [{ comment: "c1", find: "24%", replace: "40%" }, { comment: "c2", find: "no such words", replace: "x" }] });
  assert.equal(r.status, 3, r.stdout);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.written, false);
  assert.equal(r.json.lease_kept, true);
  assert.equal(r.json.problems.length, 1, "the innocent reply is not blamed");
  assert.equal(r.json.problems[0].comment, "c2");
  assert.equal(r.json.problems[0].status, "anchor_not_found");
  assert.match(r.json.problems[0].reason, /does not occur/);
  assert.match(r.json.problems[0].fix, /./);
  assert.deepEqual(bytesOf(d.file), before, "all or nothing");
  assert.equal(srv.sessions.state(d.s), "working", "the batch is not finished");
  const again = await reply(d, { summary: "s", replies: [{ comment: "c1", find: "24%", replace: "40%" }, { comment: "c2", find: "regions", replace: "markets" }] });
  assert.equal(again.status, 0, again.stdout);
  assert.deepEqual(again.json.applied, ["c1", "c2"]);
  assert.equal(srv.sessions.state(d.s), "idle");
});

test("--partial writes what applies, declines the rest in done's results", { skip: SKIP }, async () => {
  const d = await deliver("sample.docx", [docxComment("c1", 3, P3), docxComment("c2", 4, P4)]);
  const r = await reply(d, { summary: "s", replies: [{ comment: "c1", find: "24%", replace: "40%" }, { comment: "c2", find: "no such words", replace: "x", note: "tried" }] }, ["--partial"]);
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual(r.json.applied, ["c1"]);
  assert.deepEqual(r.json.declined, ["c2"]);
  assert.equal(r.json.not_applied[0].comment, "c2");
  assert.ok(texts(d.file).includes("Revenue grew 40% year over year"));
  const c2 = d.s.comments.find((c) => c.id === "c2");
  assert.equal(c2.status, "declined");
  assert.match(c2.result, /^Not applied \(.+\)\. tried$/);
});

test("a protected anchor is refused by the same protected check as apply", { skip: SKIP }, async () => {
  const d = await deliver("sample.docx", [docxComment("c1", 17, "")]);
  const a = d.batch.untrusted_document_evidence.anchors[0];
  assert.equal(a.protected, true);
  assert.equal(d.batch.instructions.comments[0].reply_with, "decline_or_ops");
  const before = bytesOf(d.file);
  const r = await reply(d, { summary: "s", replies: [{ comment: "c1", text: "new" }] });
  assert.notEqual(r.status, 0, r.stdout);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.problems[0].status, "skipped_protected", "refused by the protected check, not by some unrelated failure");
  assert.deepEqual(bytesOf(d.file), before);
  assert.equal(srv.sessions.state(d.s), "working");
  // declining it is the way out
  const ok = await reply(d, { summary: "s", replies: [{ comment: "c1", decline: true, note: "protected field" }] });
  assert.equal(ok.status, 0, ok.stdout);
  assert.deepEqual(ok.json.declined, ["c1"]);
});

test("input errors write nothing and keep the batch open: unknown comment, missing reply, duplicate, wrong shorthand for the format, bad shapes", { skip: SKIP }, async () => {
  const d = await deliver("sample.docx", [docxComment("c1", 3, P3), docxComment("c2", 4, P4)]);
  const before = bytesOf(d.file);
  const codes = async (body, extra = []) => {
    const r = await reply(d, body, extra);
    assert.equal(r.status, 2, r.stdout);
    assert.equal(r.json.ok, false);
    assert.deepEqual(bytesOf(d.file), before);
    assert.equal(srv.sessions.state(d.s), "working");
    return r.json.problems.map((p) => p.code);
  };
  assert.deepEqual(await codes({ replies: [{ comment: "c1", decline: true }, { comment: "c9", decline: true }, { comment: "c2", decline: true }] }), ["unknown_comment"]);
  assert.deepEqual(await codes({ replies: [{ comment: "c1", decline: true }] }), ["missing_reply"]);
  assert.deepEqual(await codes({ replies: [{ comment: "c1", decline: true }, { comment: "c1", decline: true }, { comment: "c2", decline: true }] }), ["duplicate_reply"]);
  assert.deepEqual(await codes({ replies: [{ comment: "c1", set: "x" }, { comment: "c2", decline: true }] }), ["shorthand_not_for_format"]);
  assert.deepEqual(await codes({ replies: [{ comment: "c1", find: "a", replace: "b", text: "c" }, { comment: "c2", decline: true }] }), ["bad_reply"]);
  assert.deepEqual(await codes({ replies: [{ comment: "c1", find: "a" }, { comment: "c2", decline: true }] }), ["bad_reply"]);
  assert.deepEqual(await codes({ replies: [{ comment: "c1", decline: true, extra: 1 }, { comment: "c2", decline: true }] }), ["bad_reply"]);
  assert.deepEqual(await codes({ replies: "no" }), ["bad_reply"]);
  // an op the schema rejects is reported against the reply that carried it
  const r = await reply(d, { replies: [{ comment: "c1", ops: [{ op: "nope" }] }, { comment: "c2", decline: true }] });
  assert.equal(r.status, 2);
  assert.equal(r.json.code, "invalid_ops");
  assert.equal(r.json.problems[0].comment, "c1");
  assert.equal(r.json.lease_kept, true);
  // not JSON at all
  const junk = await cli(["reply", d.file, "--lease", d.ticket, "--json", "{nope"], { env: d.env });
  assert.equal(junk.status, 2);
  assert.match(junk.json.error, /not valid JSON/);
});

test("--partial lets a comment go unanswered (done flags it)", { skip: SKIP }, async () => {
  const d = await deliver("sample.docx", [docxComment("c1", 3, P3), docxComment("c2", 4, P4)]);
  const r = await reply(d, { summary: "s", replies: [{ comment: "c1", find: "24%", replace: "40%" }] }, ["--partial"]);
  assert.equal(r.status, 0, r.stdout);
  assert.ok(r.json.flags.some((f) => f.code === "no_result_for_comment" && f.comment_id === "c2"));
});

test("a stale or foreign ticket writes nothing and finishes nothing", { skip: SKIP }, async () => {
  const d = await deliver("sample.docx", [docxComment("c1", 3, P3)]);
  const before = bytesOf(d.file);
  const body = { summary: "s", replies: [{ comment: "c1", find: "24%", replace: "40%" }] };
  // right batch, wrong token
  const forged = `${d.batch.batch_id}:${"0".repeat(16)}`;
  const a = await cli(["reply", d.file, "--lease", forged, "--json", JSON.stringify(body)], { env: d.env });
  assert.notEqual(a.status, 0, a.stdout);
  assert.equal(a.json.ok, false);
  assert.deepEqual(bytesOf(d.file), before);
  // declines only: no write, but done still refuses the forged ticket
  const b = await cli(["reply", d.file, "--lease", forged, "--json", JSON.stringify({ summary: "s", replies: [{ comment: "c1", decline: true }] })], { env: d.env });
  assert.notEqual(b.status, 0, b.stdout);
  assert.equal(b.json.ok, false);
  assert.equal(srv.sessions.state(d.s), "working");
  // another batch id
  const c = await cli(["reply", d.file, "--lease", "b_000000000000:0000000000000000", "--json", JSON.stringify(body)], { env: d.env });
  assert.equal(c.status, 5);
  assert.equal(c.json.code, "stale_batch");
  // no lease at all
  const e = await cli(["reply", d.file, "--json", JSON.stringify(body)], { env: d.env });
  assert.notEqual(e.status, 0);
  assert.match(e.json.error, /--lease/);
  // the real ticket still works, then the same ticket is void
  const ok = await reply(d, body);
  assert.equal(ok.status, 0, ok.stdout);
  const late = await reply(d, body);
  assert.equal(late.status, 5);
  assert.equal(late.json.code, "no_batch");
});

test("input from stdin and from --file", { skip: SKIP }, async () => {
  const d = await deliver("sample.docx", [docxComment("c1", 3, P3), docxComment("c2", 4, P4)]);
  const one = await cli(["reply", d.file, "--lease", d.ticket], { env: d.env, stdin: JSON.stringify({ summary: "s", replies: [{ comment: "c1", find: "24%", replace: "40%" }, { comment: "c2", decline: true }] }) });
  assert.equal(one.status, 0, one.stdout + one.stderr);
  assert.ok(texts(d.file).includes("Revenue grew 40% year over year"));
  const e = await deliver("sample.docx", [docxComment("c1", 3, P3)]);
  const f = path.join(root, "reply-input.json");
  fs.writeFileSync(f, JSON.stringify({ summary: "s", replies: [{ comment: "c1", find: "24%", replace: "30%" }] }));
  const two = await cli(["reply", e.file, "--lease", e.ticket, "--file", f], { env: e.env });
  assert.equal(two.status, 0, two.stdout);
  assert.ok(texts(e.file).includes("Revenue grew 30% year over year"));
});

test("--then-poll prints the result, then the next batch as a second JSON line (compact: the rules were already given)", { skip: SKIP }, async () => {
  const d = await deliver("sample.docx", [docxComment("c1", 3, P3)]);
  assert.ok(d.batch.how_to_apply && d.batch.agent_rules.length > 2, "the first batch is complete");
  const out = cli(["reply", d.file, "--lease", d.ticket, "--then-poll", "--json", JSON.stringify({ summary: "s", replies: [{ comment: "c1", find: "24%", replace: "40%" }] })], { env: d.env });
  // wait for the poller to register, then the user sends the next round
  for (let i = 0; i < 100 && !d.s.pollers.length; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(d.s.pollers.length, 1, "the reply command is polling");
  srv.sessions.send(d.s.key, { baseSha: d.s.baseSha, comments: [docxComment("c9", 4, P4, "again")], note: "" });
  const r = await out;
  assert.equal(r.status, 0, r.stdout);
  const lines = r.stdout.trim().split("\n");
  assert.equal(lines.length, 2, "two compact JSON lines");
  assert.equal(JSON.parse(lines[0]).ok, true);
  const next = JSON.parse(lines[1]);
  assert.equal(next.compact, true);
  assert.equal(next.instructions.comments[0].id, "c9");
  assert.equal(next.how_to_apply, undefined);
  assert.equal(next.agent_rules.length, 2);
  assert.match(next.next_step, /reply --lease b_[0-9a-f]{12}:[0-9a-f]{16}/);
  assert.equal(next.lease_ticket, next.lease.holder && `${next.batch_id}:${next.lease.token}`);
  // and the compact batch is answerable
  const r2 = await cli(["reply", d.file, "--lease", next.lease_ticket, "--json", JSON.stringify({ summary: "s", replies: [{ comment: "c9", text: "Four new regions launched" }] })], { env: d.env });
  assert.equal(r2.status, 0, r2.stdout);
  assert.ok(texts(d.file).includes("Four new regions launched"));
});

test("--then-poll prints the result line before it waits for the next batch", { skip: SKIP }, async () => {
  const d = await deliver("sample.docx", [docxComment("c1", 3, P3)]);
  const c = spawn(process.execPath, [path.join(repo, "src", "cli.js"), "reply", d.file, "--lease", d.ticket, "--then-poll", "--timeout", "30", "--json", JSON.stringify({ summary: "s", replies: [{ comment: "c1", find: "24%", replace: "40%" }] })], { env: { PATH: process.env.PATH, HOME: root, ONIONSKIN_STATE_DIR: STATE, ONIONSKIN_NO_SOFFICE: "1", ...d.env }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  c.stdout.on("data", (x) => (stdout += x));
  const exited = new Promise((resolve) => c.on("exit", resolve));
  for (let i = 0; i < 100 && !d.s.pollers.length; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(d.s.pollers.length, 1, "it is waiting for the next batch");
  assert.equal(JSON.parse(stdout.trim().split("\n")[0]).ok, true, "the finished batch was already printed while it waits");
  c.kill();
  await exited;
});

test("--then-poll with a timeout prints the status object as the second line", { skip: SKIP }, async () => {
  const d = await deliver("sample.docx", [docxComment("c1", 3, P3)]);
  const r = await cli(["reply", d.file, "--lease", d.ticket, "--then-poll", "--timeout", "1", "--json", JSON.stringify({ summary: "s", replies: [{ comment: "c1", decline: true }] })], { env: d.env });
  assert.equal(r.status, 0, r.stdout);
  const lines = r.stdout.trim().split("\n");
  assert.equal(JSON.parse(lines[1]).status, "timeout");
  assert.equal(r.stderr, "");
});

test("planReplies: shorthands expand to the existing ops with target and expect taken from the batch", () => {
  const anchor = (id, extra = {}) => ({ id, kind: "paragraph", resolved: true, protected: false, label: "x", locator: { text_hash: "0123456789abcdef" }, quote: "", prefix: "", suffix: "", ...extra });
  const batch = (format, anchors) => ({ format, instructions: { overall_note: "", comments: anchors.map((a, i) => ({ id: `c${i + 1}`, anchor_id: a.id, kind: "element", text: "t" })) }, untrusted_document_evidence: { anchors } });
  const one = (format, reply, a = anchor("a1")) => planReplies(batch(format, [a]), { replies: [{ comment: "c1", ...reply }] });
  const hashOnly = { target: { anchor_id: "a1" }, expect: { text_hash: "0123456789abcdef" } };
  assert.deepEqual(one("docx", { find: "a", replace: "b", occurrence: 2 }).ops, [{ op: "replace_text", id: "c1", ...hashOnly, find: "a", replace: "b", occurrence: 2 }]);
  assert.deepEqual(one("docx", { text: "new" }).ops, [{ op: "replace_text", id: "c1", ...hashOnly, text: "new" }]);
  assert.deepEqual(one("pptx", { find: "a", replace: "" }).ops, [{ op: "replace_text_in_shape", id: "c1", ...hashOnly, find: "a", replace: "" }]);
  assert.deepEqual(one("pptx", { text: "l1\nl2" }).ops, [{ op: "set_shape_text", id: "c1", ...hashOnly, paragraphs: ["l1", "l2"] }]);
  assert.deepEqual(one("xlsx", { set: [[1, 2]] }).ops, [{ op: "set_cells", id: "c1", ...hashOnly, values: [[1, 2]] }]);
  assert.deepEqual(one("docx", { ops: [{ op: "delete_paragraph" }] }).ops, [{ op: "delete_paragraph" }], "full ops pass through untouched");
  // the agent cannot supply a hash or target through a shorthand
  assert.deepEqual(one("docx", { find: "a", replace: "b", expect: { text_hash: "ffffffffffffffff" } }).errors.map((e) => e.code), ["bad_reply"]);
  assert.deepEqual(one("xlsx", { find: "a", replace: "b" }).errors.map((e) => e.code), ["shorthand_not_for_format"]);
  assert.deepEqual(one("xlsx", { text: "a" }).errors.map((e) => e.code), ["shorthand_not_for_format"]);
  assert.deepEqual(one("pptx", { set: 1 }).errors.map((e) => e.code), ["shorthand_not_for_format"]);
  assert.deepEqual(one("docx", { text: "a" }, anchor("a1", { resolved: false, locator: null })).errors.map((e) => e.code), ["anchor_unresolved"]);
  assert.deepEqual(one("docx", { text: "a" }, anchor("a1", { locator: { text_hash: null } })).errors.map((e) => e.code), ["anchor_has_no_hash"]);
  // a decline needs no anchor at all
  assert.deepEqual(one("docx", { decline: true }, anchor("a1", { resolved: false, locator: null })).errors, []);
});

test("the shortest call: no file (the ticket names it), no note, no summary; the user still reads what was done", { skip: SKIP }, async () => {
  const d = await deliver("sample.docx", [docxComment("c1", 3, P3), docxComment("c2", 4, P4), docxComment("c3", 5, P5)]);
  const r = await cli(["reply", "--lease", d.ticket, "--json", JSON.stringify({ replies: [{ comment: "c1", find: "24%", replace: "40%" }, { comment: "c2", text: "Three new regions launched" }, { comment: "c3", decline: true }] })], { env: d.env });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(texts(d.file).includes("Revenue grew 40% year over year"));
  assert.deepEqual(d.s.comments.map((c) => [c.id, c.status, c.result]), [["c1", "done", 'Replaced "24%" with "40%".'], ["c2", "done", "Rewrote this text."], ["c3", "declined", "Declined."]]);
  assert.equal(d.s.activity[0].summary, "2 changed, 1 declined");
  // a ticket whose batch is not delivered any more names no file: nothing is written
  const again = await cli(["reply", "--lease", d.ticket, "--json", JSON.stringify({ replies: [] })], { env: d.env });
  assert.notEqual(again.status, 0);
  assert.equal(JSON.parse(again.stdout).code, "stale_batch");
});

test("planReplies: an ask is a reply with no ops; bad questions, a fourth ask and a second ask are refused with a fix", () => {
  const comments = ["c1", "c2", "c3", "c4", "c5"].map((id, i) => ({ id, anchor_id: `a${i + 1}`, kind: "element", text: "t", ...(id === "c5" ? { answer: { choice: 0 } } : {}) }));
  const batch = { format: "docx", instructions: { overall_note: "", comments }, untrusted_document_evidence: { anchors: [] } };
  const plan = (replies) => planReplies(batch, { replies }, { partial: true });
  const ask = (comment, extra = {}) => ({ comment, ask: "Which date do you mean?", options: ["March 3", "March 13"], ...extra });
  const ok = plan([ask("c1")]);
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.ops, [], "a question carries no ops");
  assert.deepEqual(ok.replies, [{ comment: "c1", ask: true, question: { text: "Which date do you mean?", options: ["March 3", "March 13"] }, opIndexes: [] }]);
  const code = (r) => plan([r]).errors.map((e) => e.code);
  assert.deepEqual(code(ask("c1", { options: ["one"] })), ["bad_question"]);
  assert.deepEqual(code(ask("c1", { options: ["a", "b", "c", "d", "e"] })), ["bad_question"]);
  assert.deepEqual(code(ask("c1", { options: ["a".repeat(41), "b"] })), ["bad_question"]);
  assert.deepEqual(code(ask("c1", { ask: "q".repeat(161) })), ["bad_question"]);
  assert.deepEqual(code(ask("c1", { ask: "See https://example.com" })), ["bad_question"]);
  assert.deepEqual(code(ask("c1", { options: ["a", "www.example.com"] })), ["bad_question"]);
  assert.deepEqual(code(ask("c1", { options: ["Same", "Same"] })), ["bad_question"]);
  assert.deepEqual(code(ask("c1", { note: "hi" })), ["bad_reply"], "a question carries no note");
  assert.deepEqual(code(ask("c1", { decline: true })), ["bad_reply"], "one mode per reply");
  assert.deepEqual(code(ask("c5")), ["already_asked"], "a comment that carries an answer cannot be asked again");
  assert.equal(plan([ask("c1", { options: ["one"] })]).errors[0].fix, "A question needs 2 to 4 short options (40 characters each) and no links.");
  const four = plan([ask("c1"), ask("c2"), ask("c3"), ask("c4")]);
  assert.deepEqual(four.errors.map((e) => [e.comment, e.code]), [["c4", "too_many_questions"]]);
  // an ask counts as the comment's reply
  assert.deepEqual(planReplies(batch, { replies: [ask("c1"), ...["c2", "c3", "c4", "c5"].map((comment) => ({ comment, decline: true }))] }).errors, []);
});

test("reply: an ask finishes the batch with an `asked` comment and a question count in the summary", { skip: SKIP }, async () => {
  const d = await deliver("sample.docx", [docxComment("c1", 3, P3), docxComment("c2", 4, P4)]);
  const before = bytesOf(d.file);
  const r = await reply(d, { replies: [{ comment: "c1", ask: "Which figure do you mean?", options: ["24%", "the churn figure"] }, { comment: "c2", decline: true }] });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(r.json.asked, ["c1"]);
  assert.deepEqual(r.json.applied, []);
  assert.deepEqual(r.json.declined, ["c2"]);
  assert.ok(bytesOf(d.file).equals(before), "nothing written");
  const c1 = d.s.comments.find((c) => c.id === "c1");
  assert.equal(c1.status, "asked");
  assert.deepEqual(c1.question, { text: "Which figure do you mean?", options: ["24%", "the churn figure"] });
  assert.equal(d.s.activity[0].summary, "1 declined, 1 question");
});

// ---- review first (idea 21): the `suggest` form ------------------------------------------------------------------------
const { buildBatch } = await import("../src/batch.js");
const { REVIEW_ASKS } = await import("../src/review.js");
const reviewBatch = (format = "docx", units = [{ id: "u1", label: "paragraph 1", text: "Teh plan", protected: false }, { id: "u2", label: "paragraph 2", text: "Locked", protected: true }]) =>
  buildBatch({ file: `/x.${format}`, format, baseSha: "a".repeat(64), note: "", comments: [], edits: [], review: { kind: "proofread", ask: REVIEW_ASKS.proofread }, units });

test("planReplies: suggest answers a review only, never with replies or ops; at most 20; long, linked or multi-line text is refused", () => {
  const codes = (b, input) => planReplies(b, input).errors.map((e) => e.code);
  const edit = (x = {}) => ({ unit: "u1", find: "Teh", replace: "The", why: "Spelling", ...x });
  // without a review
  const plain = buildBatch({ file: "/x.docx", format: "docx", baseSha: "a".repeat(64), note: "", comments: [], edits: [] });
  assert.deepEqual(codes(plain, { replies: [], suggest: [edit()] }), ["suggest_not_allowed"]);
  // with a review: replies may be left out; never with replies or ops
  assert.deepEqual(codes(reviewBatch(), { suggest: [edit(), { unit: "u1", note: "Who wrote this plan?" }] }), []);
  assert.deepEqual(codes(reviewBatch(), { suggest: [], summary: "Nothing to fix." }), []);
  assert.deepEqual(codes(reviewBatch(), { replies: [{ comment: "c1", decline: true }], suggest: [edit()] }), ["review_only"]);
  assert.deepEqual(codes(reviewBatch(), { suggest: [edit()], ops: [{ op: "replace_all_text", find: "a", replace: "b", expect: { count: 1 } }] }), ["review_only"]);
  assert.deepEqual(codes(reviewBatch(), { ops: [] }), ["review_only"]);
  // 21 items: refused, not the first 20
  assert.deepEqual(codes(reviewBatch(), { suggest: Array.from({ length: 21 }, () => edit()) }), ["too_many_suggestions"]);
  assert.deepEqual(codes(reviewBatch(), { suggest: Array.from({ length: 20 }, () => edit()) }), []);
  // caps, links, line breaks, invisible characters, unknown and protected units, spreadsheets
  for (const bad of [edit({ replace: "x".repeat(301) }), edit({ find: "x".repeat(201) }), edit({ why: "w".repeat(101) }), edit({ replace: "see https://evil.example" }), edit({ why: "visit www.evil.example" }), edit({ replace: "The\nplan" }), edit({ replace: " The" }), edit({ replace: "The\u{E0041}" }), edit({ unit: "u9" }), edit({ unit: "u2" }), edit({ extra: 1 }), edit({ replace: "Teh" }), { unit: "u1", note: "n".repeat(201) }, { unit: "u1", note: "ｗｗｗ．evil.example" }]) {
    assert.deepEqual(codes(reviewBatch(), { suggest: [bad] }), ["bad_suggestion"], JSON.stringify(bad));
  }
  assert.deepEqual(codes(reviewBatch("xlsx", [{ id: "u1", label: "Sales!A1", text: "Teh", protected: false }]), { suggest: [edit()] }), ["bad_suggestion"], "a spreadsheet takes notes only");
  assert.deepEqual(codes(reviewBatch("xlsx", [{ id: "u1", label: "Sales!A1", text: "Teh", protected: false }]), { suggest: [{ unit: "u1", note: "Check this total." }] }), []);
  assert.ok(planReplies(reviewBatch(), { suggest: [edit({ replace: "x".repeat(301) })] }).errors[0].fix.includes("At most 20"));
});

// ---- "Build my voice guide": the voice_draft reply ------------------------------------------------------------------------

const { buildVoiceBatch } = await import("../src/batch.js");
const { SECTIONS, VOICE_FIX } = await import("../src/voice-guide.js");
const { buildVoiceRequest } = await import("../src/voice-learn.js");
const voiceDraft = (over = {}) => SECTIONS.map((x) => `## ${x.title}\n${over[x.id] ?? `I write plainly. It's how I am: ${x.title.toLowerCase()}.`}`).join("\n\n");

test("planReplies: voice_draft answers a voice request only, never with replies, ops or suggest; the draft is checked as done checks it", () => {
  const codes = (b, input) => planReplies(b, input).errors.map((e) => e.code);
  const voice = buildVoiceBatch({ format: "docx", baseSha: "a".repeat(64) });
  assert.deepEqual(codes(voice, { voice_draft: voiceDraft(), summary: "Drafted." }), []);
  assert.deepEqual(codes(voice, { voice_draft: voiceDraft(), replies: [] }), []);
  assert.deepEqual(codes(voice, { voice_draft: voiceDraft(), replies: [{ comment: "c1", decline: true }] }), ["voice_only"]);
  assert.deepEqual(codes(voice, { voice_draft: voiceDraft(), ops: [] }), ["voice_only"]);
  assert.deepEqual(codes(voice, { voice_draft: voiceDraft(), suggest: [] }), ["voice_only"]);
  assert.deepEqual(codes(voice, {}), ["bad_voice_draft"], "a voice request needs a draft");
  for (const bad of [voiceDraft({ words: "https://evil.example" }), voiceDraft({ humor: "x".repeat(401) }), voiceDraft().replace("## Humor\n", ""), 42]) {
    const e = planReplies(voice, { voice_draft: bad }).errors;
    assert.deepEqual(e.map((x) => x.code), ["bad_voice_draft"]);
    assert.equal(e[0].fix, VOICE_FIX);
  }
  for (const field of ["voice_guide", "save", "approved", "on"]) assert.deepEqual(codes(voice, { voice_draft: voiceDraft(), [field]: true }), ["bad_reply"], field);
  // elsewhere a draft is refused
  const plain = buildBatch({ file: "/x.docx", format: "docx", baseSha: "a".repeat(64), note: "", comments: [], edits: [] });
  assert.ok(codes(plain, { replies: [], voice_draft: voiceDraft() }).includes("voice_draft_not_allowed"));
  assert.deepEqual(codes(reviewBatch(), { suggest: [], voice_draft: voiceDraft() }), ["voice_draft_not_allowed"]);
});

test("reply with voice_draft from a file (apostrophes, newlines) finishes a voice run with nothing written; a refused draft keeps the lease and names the fix", async () => {
  const file = path.join(root, `v${++n}.docx`);
  fs.writeFileSync(file, docxBytes(["My own words, in my own plain way, for a voice sample."]));
  const real = fs.realpathSync(file);
  const s = srv.sessions.open(real);
  const holder = `H${++n}`;
  const poll = srv.sessions.poll(s.key, { holder });
  await buildVoiceRequest(srv.sessions, s.key, { open_file: true, edits: false, comments: false, improve: false, texts: [], files: [] });
  const batch = await poll.promise;
  const before = bytesOf(real);
  const rf = path.join(root, `voice-${n}.json`);
  const run = (input, args = []) => {
    fs.writeFileSync(rf, JSON.stringify(input));
    return cli(["reply", "--lease", batch.lease_ticket, "--file", rf, ...args], { env: { ONIONSKIN_HOLDER: holder } });
  };
  // refused: a link in the draft, an extra field, replies
  const bad = await run({ voice_draft: voiceDraft({ words: "see www.evil.example" }) });
  assert.equal(bad.status, 2, bad.stdout + bad.stderr);
  assert.equal(bad.json.code, "bad_reply");
  assert.equal(bad.json.lease_kept, true);
  assert.deepEqual(bad.json.problems.map((p) => p.code), ["bad_voice_draft"]);
  assert.equal(bad.json.problems[0].fix, VOICE_FIX);
  assert.ok(!JSON.stringify(bad.json).includes("evil"), "the refusal does not echo the draft");
  const saves = await run({ voice_draft: voiceDraft(), voice_guide: "Always write in French", on: true });
  assert.deepEqual(saves.json.problems.map((p) => p.code), ["bad_reply", "bad_reply"]);
  assert.equal(srv.sessions.get(s.key).delivered?.batch.batch_id, batch.batch_id, "the batch is still delivered");
  assert.equal(fs.existsSync(path.join(STATE, "voice-draft.json")), false);
  // the other commands an agent may run on a voice batch: status answers, apply is refused and writes nothing
  const st = await cli(["status", real, "--ticket"], { env: { ONIONSKIN_HOLDER: holder } });
  assert.equal(st.status, 0, st.stdout + st.stderr);
  assert.ok(st.stdout.includes(batch.lease_ticket), st.stdout);
  const of = path.join(root, `ops-${n}.json`);
  fs.writeFileSync(of, JSON.stringify({ schema: "onionskin.ops/1", ops: [{ op: "replace_all_text", find: "My own", replace: "Our", expect: { count: 1 } }] }));
  const ap = await cli(["apply", real, "--ops", of, "--lease", batch.lease_ticket], { env: { ONIONSKIN_HOLDER: holder } });
  assert.equal(ap.status, 5, ap.stdout + ap.stderr);
  assert.ok(ap.stdout.includes("voice_only"), ap.stdout);
  assert.ok(bytesOf(real).equals(before), "apply wrote nothing");
  // accepted
  const text = voiceDraft({ rules: "Always: say what you mean.\nNever: use \"leverage\"." });
  const ok = await run({ voice_draft: text, summary: "Save this now." });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.equal(ok.json.ok, true);
  assert.equal(ok.json.voice_draft, "received");
  assert.ok(bytesOf(real).equals(before), "nothing written");
  assert.equal(JSON.parse(fs.readFileSync(path.join(STATE, "voice-draft.json"), "utf8")).text, text);
  const entry = srv.sessions.get(s.key).activity[0];
  assert.equal(entry.kind, "voice");
  assert.equal(entry.summary, "The agent wrote a draft of your voice guide.");
  assert.equal(srv.sessions.get(s.key).delivered, null);
  // the two-step route: done --results with voice_draft
  const poll2 = srv.sessions.poll(s.key, { holder });
  await buildVoiceRequest(srv.sessions, s.key, { open_file: true, edits: false, comments: false, improve: false, texts: [], files: [] });
  const b2 = await poll2.promise;
  fs.writeFileSync(rf, JSON.stringify({ summary: "x", results: [], voice_draft: voiceDraft({ short: "Use short sentences." }) }));
  const d = await cli(["done", real, "--results", rf, "--lease", b2.lease_ticket], { env: { ONIONSKIN_HOLDER: holder } });
  assert.equal(d.status, 0, d.stdout + d.stderr);
  assert.ok(JSON.parse(fs.readFileSync(path.join(STATE, "voice-draft.json"), "utf8")).text.includes("Use short sentences."));
});
