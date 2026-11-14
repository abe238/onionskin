// The document outline Onionskin adds to a batch for an agent it started itself (the background holder and its Terminal form): that agent
// cannot open the file, so a note-only Send ("change the title") must carry the text and the ready-made targets. Every other holder gets the
// batch exactly as before. Real server and real CLI `reply` on the committed engine samples (copied to a temp dir, never written in place).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test, before, after } from "node:test";
import { fileURLToPath } from "node:url";
import { docxBytes, tmpdir } from "./helpers/zipbuild.js";
import { validate } from "./helpers/schema-lite.js";

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
const { bgHolder, termHolder } = await import("../src/agent-detect.js");
const { readUnits } = await import("../src/anchors.js");
const { backgroundPrompt } = await import("../src/agent-prompt.js");
const { validateOps } = await import("../src/ops/schema.js");
const { VOICE_BATCH_MAX_CHARS } = await import("../src/voice-samples.js");
const schema = JSON.parse(fs.readFileSync(path.join(repo, "docs", "contracts", "batch.schema.json"), "utf8"));

let srv;
before(async () => {
  srv = await startServer();
});
after(() => {
  srv?.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

let n = 0;
const copy = (name) => {
  const f = path.join(root, `o${++n}-${name}`);
  fs.copyFileSync(path.join(ENGINE_SAMPLES, name), f);
  return fs.realpathSync(f);
};
const written = (name, bytes) => {
  const f = path.join(root, `o${++n}-${name}`);
  fs.writeFileSync(f, bytes);
  return fs.realpathSync(f);
};
const NOTE = "Change the title at the top of the document to: Walk seven worked";
const S = () => srv.sessions;
/** A note-only Send delivered to `holder` (a function of the session key). */
async function deliver(file, holderOf, note = NOTE) {
  const s = S().open(file);
  const holder = holderOf(s.key);
  const p = S().poll(s.key, { holder });
  S().send(s.key, { baseSha: s.baseSha, comments: [], note });
  return { s, holder, batch: await p.promise };
}
/** What `onionskin poll` prints for a delivered batch (src/cli.js pretty-prints it). */
const printed = (b) => JSON.stringify(b, null, 2).length;
const firstPara = (file) => readUnits("docx", fs.readFileSync(file)).paragraphs.find((p) => p.text.trim());
const opOf = (e, rest) => ({ op: e.target.slide_id ? "replace_text_in_shape" : e.target.sheet ? "set_cells" : "replace_text", id: "overall", target: e.target, expect: e.expect, ...rest });

/** The real `onionskin reply`, as an agent Onionskin started runs it: by file, from its own work folder. */
function reply(file, batch, holder, body) {
  const W = fs.realpathSync(fs.mkdtempSync(path.join(root, "w-")));
  const rf = path.join(W, `reply-${batch.batch_id}.json`);
  fs.writeFileSync(rf, JSON.stringify(body));
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(repo, "src", "cli.js"), "reply", file, "--lease", batch.lease_ticket, "--file", rf], { env: { PATH: process.env.PATH, HOME: root, ONIONSKIN_STATE_DIR: STATE, ONIONSKIN_NO_SOFFICE: "1", ONIONSKIN_HOLDER: holder, ONIONSKIN_AGENT_DIR: W }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    c.stdout.on("data", (d) => (stdout += d));
    c.on("close", (code) => resolve({ code, json: (() => { try { return JSON.parse(stdout.split("\n")[0]); } catch { return null; } })(), stdout }));
  });
}

test("docx: a note-only batch to the background holder carries the outline with ready targets; an ordinary holder's batch is unchanged", { skip: SKIP }, async () => {
  const f = copy("sample.docx");
  // the stand-in for a running agent: a background poll with no live agent behind it is answered closed
  const agent = S().agent;
  S().agent = null;
  let bg;
  try {
    bg = await deliver(f, bgHolder);
  } finally {
    S().agent = agent;
  }
  const ev = bg.batch.untrusted_document_evidence;
  assert.deepEqual(bg.batch.instructions.comments, [], "no comment, no selection");
  assert.ok(Array.isArray(ev.outline) && ev.outline.length > 3, "the outline is there");
  validate(bg.batch, schema, schema, "$");
  const title = firstPara(f);
  const e = ev.outline[0];
  assert.equal(e.text, title.text);
  assert.deepEqual(e.target, { ...(title.paraId ? { para_id: title.paraId } : {}), body_path: title.path, text_hash: title.hash });
  assert.deepEqual(e.expect, { text_hash: title.hash });
  for (const x of ev.outline) assert.ok(x.protected ? !x.target : x.target.text_hash && x.expect.text_hash === x.target.text_hash, JSON.stringify(x));
  // the stored batch (what `reply` and the page read) never carries it
  assert.equal(S().map.get(bg.s.key).delivered.batch.untrusted_document_evidence.outline, undefined);
  assert.ok(printed(bg.batch) <= VOICE_BATCH_MAX_CHARS, "fits in one shell output");

  const g = copy("sample.docx");
  const plain = await deliver(g, () => "A");
  assert.equal(plain.batch.untrusted_document_evidence.outline, undefined);
  assert.equal(plain.batch.untrusted_document_evidence.outline_more, undefined);
  assert.deepEqual(plain.batch.untrusted_document_evidence, S().map.get(plain.s.key).delivered.batch.untrusted_document_evidence, "the evidence as stored, nothing added");
});

test("docx: an op copied from an outline entry is accepted by the real reply; the next (compact) batch describes the file as it is then", { skip: SKIP }, async () => {
  const f = copy("sample.docx");
  const { s, holder, batch } = await deliver(f, termHolder);
  const e = batch.untrusted_document_evidence.outline[0];
  const r = await reply(f, batch, holder, { summary: "Changed the title.", replies: [], ops: [opOf(e, { text: "Walk seven worked" })] });
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.ok, true);
  assert.equal(firstPara(f).text, "Walk seven worked");

  const p = S().poll(s.key, { holder, ack: true, compact: true });
  S().send(s.key, { baseSha: S().map.get(s.key).baseSha, comments: [], note: "Now change the title to: Second round worked" });
  const second = await p.promise;
  assert.equal(second.compact, true);
  const e2 = second.untrusted_document_evidence.outline[0];
  assert.equal(e2.text, "Walk seven worked", "the outline of the file after the first change");
  assert.notEqual(e2.expect.text_hash, e.expect.text_hash, "fresh hashes");
  assert.equal(e2.expect.text_hash, firstPara(f).hash);
  const r2 = await reply(f, second, holder, { summary: "Changed it again.", replies: [], ops: [opOf(e2, { find: "Walk seven", replace: "Second round" })] });
  assert.equal(r2.code, 0, r2.stdout);
  assert.equal(firstPara(f).text, "Second round worked");
});

test("pptx: entries carry slide_id, shape_id and the shape's hash; a find+replace built from one is accepted by the real reply", { skip: SKIP }, async () => {
  const f = copy("sample.pptx");
  const { holder, batch } = await deliver(f, termHolder, "Make the first slide's title say Hello.");
  const out = batch.untrusted_document_evidence.outline;
  validate(batch, schema, schema, "$");
  const e = out.find((x) => !x.protected && /\w{4,}/.test(x.text));
  assert.deepEqual(Object.keys(e.target).sort(), ["shape_id", "slide_id"]);
  assert.match(e.target.slide_id, /^\d+$/);
  assert.ok(Number.isInteger(e.target.shape_id));
  assert.match(e.expect.text_hash, /^[0-9a-f]{16}$/);
  const word = e.text.match(/\w{4,}/)[0];
  const r = await reply(f, batch, holder, { summary: "Changed a word.", replies: [], ops: [opOf(e, { find: word, replace: "HELLO" })] });
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.ok, true);
});

test("xlsx: entries carry sheet, range and the cell's hash; a set_cells built from one is accepted by the real reply", { skip: SKIP }, async () => {
  const f = copy("sample.xlsx");
  const { holder, batch } = await deliver(f, termHolder, "Set the first cell to Hello.");
  const out = batch.untrusted_document_evidence.outline;
  validate(batch, schema, schema, "$");
  const e = out[0];
  assert.deepEqual(Object.keys(e.target).sort(), ["range", "sheet"]);
  assert.match(e.target.range, /^[A-Z]+\d+$/);
  assert.match(e.expect.text_hash, /^[0-9a-f]{16}$/);
  const r = await reply(f, batch, holder, { summary: "Set it.", replies: [], ops: [opOf(e, { values: "Hello" })] });
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.ok, true);
});

test("docx: a table row added with numbers read off an outline entry's body_path is accepted by the real reply", { skip: SKIP }, async () => {
  const f = copy("sample.docx");
  const { holder, batch } = await deliver(f, termHolder, "Add a row below this table's last row with: Added row");
  const cell = batch.untrusted_document_evidence.outline.filter((x) => x.target?.body_path?.length === 4).pop(); // the last cell entry of the last table
  const [table, row] = cell.target.body_path;
  const word = cell.text.match(/\w{2,}/)[0];
  const r = await reply(f, batch, holder, { summary: "Added a row.", replies: [], ops: [{ op: "insert_table_row", id: "overall", target: { table, row }, expect: { quote: word }, where: "after", cells: ["Added row"] }] });
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.ok, true);
  const added = readUnits("docx", fs.readFileSync(f)).paragraphs.find((p) => p.text === "Added row");
  assert.deepEqual(added.path.slice(0, 3), [table, row + 1, 0]);
});

test("pptx: a slide copied by the slide_id of an outline entry, with its title set, is accepted by the real reply", { skip: SKIP }, async () => {
  const f = copy("sample.pptx");
  const { holder, batch } = await deliver(f, termHolder, "Duplicate slide 2 and title the copy Next steps.");
  const title = batch.untrusted_document_evidence.outline.find((x) => /^slide 2,/.test(x.label) && x.target);
  const r = await reply(f, batch, holder, { summary: "Copied slide 2.", replies: [], ops: [{ op: "duplicate_slide", id: "overall", target: { slide_id: title.target.slide_id }, expect: { quote: "" }, shapes: [{ shape_id: title.target.shape_id, paragraphs: ["Next steps"] }] }] });
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.ok, true);
  const deck = readUnits("pptx", fs.readFileSync(f)).deck;
  deck.ensure();
  assert.equal(deck.slides.length, 6);
  assert.equal(deck.slides[2].shapes.find((s) => s.id === title.target.shape_id).text, "Next steps");
  assert.equal(deck.slides[1].shapes.find((s) => s.id === title.target.shape_id).text, title.text, "the original keeps its title");
});

test("a chart request: a reply that declines in its summary writes nothing; a chart op is refused as invalid ops", { skip: SKIP }, async () => {
  const f = copy("sample.pptx");
  const before = fs.readFileSync(f);
  const { holder, batch } = await deliver(f, termHolder, "Add a bar chart of the 2024 to 2026 numbers on slide 4.");
  const bad = await reply(f, batch, holder, { summary: "Tried a chart.", replies: [], ops: [{ op: "insert_chart", target: { slide_id: "259" }, expect: { quote: "" } }] });
  assert.equal(bad.json.ok, false, bad.stdout);
  assert.equal(bad.json.code, "invalid_ops");
  assert.ok(fs.readFileSync(f).equals(before), "nothing written");
  const r = await reply(f, batch, holder, { summary: "Onionskin cannot create charts, so I did not add one.", replies: [] });
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.ok, true);
  assert.ok(fs.readFileSync(f).equals(before), "the file is byte for byte the same");
});

const outlineDirOf = (key) => path.join(fs.realpathSync(STATE), "agents", key, "outline");
const linesOf = (f) => fs.readFileSync(f, "utf8").split("\n").filter(Boolean);
const longDocx = (name, n) => written(name, docxBytes(Array.from({ length: n }, (_, i) => `Paragraph ${i + 1}: ${"words of the document ".repeat(6).trim()}`)));

test("a long document: the inline outline is cut to fit one shell output, and the complete outline goes to a file the batch names", { skip: SKIP }, async () => {
  const f = longDocx("long.docx", 400);
  const { s, batch } = await deliver(f, termHolder);
  const ev = batch.untrusted_document_evidence;
  assert.ok(ev.outline.length > 5 && ev.outline.length < 400);
  assert.equal(ev.outline[0].text_exact, undefined, "a short paragraph shown whole has no marker");
  assert.ok(ev.outline[0].text.startsWith("Paragraph 1:"), "document order, from the top");
  assert.ok(printed(batch) <= VOICE_BATCH_MAX_CHARS && printed(batch) > VOICE_BATCH_MAX_CHARS - 1500, `printed ${printed(batch)}: within the cap, and not cut far below it`);
  validate(batch, schema, schema, "$");
  // the file: every unit, one JSON object per line, in the agent's own outline folder, 0600, named per batch
  assert.equal(ev.outline_file, path.join(outlineDirOf(s.key), `outline-${batch.batch_id}.jsonl`));
  assert.equal(ev.outline_file_units, 400);
  assert.equal(ev.outline_more, undefined, "nothing is left out of the file");
  const st = fs.lstatSync(ev.outline_file);
  assert.ok(st.isFile() && (st.mode & 0o777) === 0o600);
  const lines = linesOf(ev.outline_file);
  assert.equal(lines.length, 400);
  const units = lines.map((l) => JSON.parse(l));
  assert.deepEqual(units.slice(0, ev.outline.length), ev.outline, "the inline outline is the head of the file");
  assert.equal(units[399].id, "u400");
  assert.ok(units[399].text.startsWith("Paragraph 400:"));
  for (const u of units) validate(u, schema.properties.untrusted_document_evidence.properties.outline.items, schema, "$.line");
  assert.ok(lines.every((l) => l.length < 2000), "Read pages it: every line under 2,000 characters");
});

test("the outline file: the worst line stays under 2,000 characters; the next batch replaces the file; Close removes it", { skip: SKIP }, async () => {
  // quotes double when JSON-escaped: 1,000 of them would print 2,000 characters
  const f = written("worst.docx", docxBytes([...Array.from({ length: 300 }, (_, i) => `Paragraph ${i + 1}: ${"words of the document ".repeat(6).trim()}`), "&quot;".repeat(1500), `\\`.repeat(1500)]));
  const { s, holder, batch } = await deliver(f, termHolder);
  const first = batch.untrusted_document_evidence.outline_file;
  const lines = linesOf(first);
  assert.equal(lines.length, 302);
  for (const l of lines.slice(-2)) {
    assert.ok(l.length < 2000, `line of ${l.length} characters`);
    assert.equal(JSON.parse(l).text_exact, false);
  }
  S().done(s.key, { summary: "ok", results: [] }, { holder, token: batch.lease.token, batchId: batch.batch_id });
  const p = S().poll(s.key, { holder, ack: true, compact: true });
  S().send(s.key, { baseSha: S().map.get(s.key).baseSha, comments: [], note: "Again" });
  const second = await p.promise;
  assert.equal(second.compact, true);
  const next = second.untrusted_document_evidence.outline_file;
  assert.ok(next && next !== first && fs.existsSync(next));
  assert.ok(!fs.existsSync(first), "the older batch's file is gone");
  assert.deepEqual(fs.readdirSync(outlineDirOf(s.key)), [path.basename(next)]);
  S().close(s.key);
  assert.ok(!fs.existsSync(next), "Close removes it");
});

test("a document past the file cap: the file holds the first OUTLINE_FILE_MAX units and outline_more counts the rest", { skip: SKIP }, async () => {
  const { OUTLINE_FILE_MAX } = await import("../src/review.js");
  const f = longDocx("huge.docx", OUTLINE_FILE_MAX + 37);
  const { batch } = await deliver(f, termHolder);
  const ev = batch.untrusted_document_evidence;
  assert.equal(linesOf(ev.outline_file).length, OUTLINE_FILE_MAX);
  assert.equal(ev.outline_file_units, OUTLINE_FILE_MAX);
  assert.equal(ev.outline_more, 37);
});

test("an ordinary holder: no outline, no file written; a short document to Onionskin's agent: no file either", { skip: SKIP }, async () => {
  const f = longDocx("plain.docx", 400);
  const { s, batch } = await deliver(f, () => "A");
  assert.equal(batch.untrusted_document_evidence.outline_file, undefined);
  assert.ok(!fs.existsSync(path.join(STATE, "agents", s.key)), "nothing written for an ordinary holder");
  const g = copy("sample.pptx");
  const short = await deliver(g, termHolder, "Make the first slide's title say Hello.");
  assert.equal(short.batch.untrusted_document_evidence.outline_file, undefined);
  assert.equal(short.batch.untrusted_document_evidence.outline_more, undefined);
});

test("xlsx and pptx: the file lines carry the same entry shape as the inline outline", { skip: SKIP }, async () => {
  const { outlineOf } = await import("../src/review.js");
  const x = copy("sample.xlsx");
  const { batch } = await deliver(x, termHolder, "Set the last cell to Hello.");
  const lines = linesOf(batch.untrusted_document_evidence.outline_file).map((l) => JSON.parse(l));
  assert.ok(lines.length > batch.untrusted_document_evidence.outline.length);
  for (const u of lines.slice(-3)) {
    assert.deepEqual(Object.keys(u.target).sort(), ["range", "sheet"]);
    assert.match(u.expect.text_hash, /^[0-9a-f]{16}$/);
  }
  const p = outlineOf("pptx", fs.readFileSync(path.join(ENGINE_SAMPLES, "sample.pptx")));
  for (const u of p.outline.filter((e) => e.target)) {
    assert.deepEqual(Object.keys(u.target).sort(), ["shape_id", "slide_id"]);
    assert.ok(JSON.stringify(u).length < 2000);
  }
});

test("a paragraph longer than the cap is shown cut and marked text_exact: false; its target still names the whole paragraph", { skip: SKIP }, async () => {
  const long = `Opening words ${"and more words ".repeat(90)}closing words`;
  const f = written("cut.docx", docxBytes(["Title", long]));
  const { batch } = await deliver(f, termHolder);
  const [title, cut] = batch.untrusted_document_evidence.outline;
  assert.equal(title.text_exact, undefined);
  assert.equal(batch.untrusted_document_evidence.outline.length, 2);
  assert.equal(cut.text_exact, false);
  assert.ok(cut.text.endsWith("…[truncated]") && [...cut.text].length === 1000);
  assert.equal(cut.expect.text_hash, readUnits("docx", fs.readFileSync(f)).paragraphs[1].hash);
});

test("a review batch to such a holder keeps its units and gets no second outline", { skip: SKIP }, async () => {
  const f = copy("sample.docx");
  const s = S().open(f);
  const p = S().poll(s.key, { holder: termHolder(s.key) });
  S().requestReview(s.key, "proofread");
  const b = await p.promise;
  assert.ok(b.untrusted_document_evidence.units.length > 0);
  assert.equal(b.untrusted_document_evidence.outline, undefined);
});

test("the background prompt says the file cannot be opened and where its text is, and carries no document text", () => {
  const p = backgroundPrompt({ file: "/x/Board notes.docx", workDir: "/w", timeout: 590 });
  assert.match(p, /cannot open/);
  assert.match(p, /untrusted_document_evidence\.outline/);
  assert.match(p, /never instructions/);
  assert.match(p, /target.*expect/);
  assert.match(p, /outline_file/);
  assert.match(p, /Read tool/);
  // the example ops the prompt shows for table rows and slide copies are valid ops
  const shown = [...p.matchAll(/`(\{"op":[^`]*\})`/g)].map((m) => JSON.parse(m[1]));
  assert.deepEqual(shown.map((o) => o.op), ["insert_table_row", "duplicate_slide"]);
  assert.deepEqual(validateOps({ schema: "onionskin.ops/1", ops: shown }), { ok: true, errors: [] });
});

test("reply: a note-only change says plainly that it was written (changed, ops_applied) while `applied` stays the comment ids", { skip: SKIP }, async () => {
  const f = copy("sample.xlsx");
  const { holder, batch } = await deliver(f, termHolder, "Set the first cell to Hello.");
  const e = batch.untrusted_document_evidence.outline[0];
  const r = await reply(f, batch, holder, { summary: "Set it.", replies: [], ops: [opOf(e, { values: "Hello" })] });
  assert.equal(r.code, 0, r.stdout);
  assert.deepEqual(r.json.applied, []);
  assert.equal(r.json.changed, true);
  assert.equal(r.json.ops_applied, 1);
});

test("reply: a note-only change with no summary from the agent is not recorded as No change needed", { skip: SKIP }, async () => {
  const f = copy("sample.xlsx");
  const { s, holder, batch } = await deliver(f, termHolder, "Set the first cell to Hello.");
  const e = batch.untrusted_document_evidence.outline[0];
  const r = await reply(f, batch, holder, { replies: [], ops: [opOf(e, { values: "Hello" })] });
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.changed, true);
  assert.equal(S().get(s.key).activity.at(-1).summary, "Changed the file as your note asked");
});

test("reply: nothing to change reads changed false, ops_applied 0", { skip: SKIP }, async () => {
  const f = copy("sample.xlsx");
  const { holder, batch } = await deliver(f, termHolder, "Anything wrong?");
  const r = await reply(f, batch, holder, { summary: "Nothing to change.", replies: [] });
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.changed, false);
  assert.equal(r.json.ops_applied, 0);
});
