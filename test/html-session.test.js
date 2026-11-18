// HTML files in a session (PLAN-html Phase 2a): the open gate, the view, the person's text edits at Send, the
// version stamp of page anchors, an agent's write, done, History and Revert. The parser is never loaded on this thread (the code under
// test runs as on the server's): node ids come from a worker (test/helpers/html-nodes.js).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { tmpdir } from "./helpers/zipbuild.js";
import { htmlNodes, textId } from "./helpers/html-nodes.js";

const root = tmpdir();
process.env.ONIONSKIN_STATE_DIR = path.join(root, "st");
process.env.ONIONSKIN_LEASE_MS = "60000";
delete process.env.ONIONSKIN_PYTHON;
process.env.ONIONSKIN_NO_SOFFICE = "1";
const { Sessions, HttpError } = await import("../src/session.js");
const { sha256 } = await import("../src/fsutil.js");
const { ensureStateDir } = await import("../src/paths.js");
const { editHash } = await import("../src/edit-hash.js");
const { analyzeOffThread } = await import("../src/offload.js");
const { ACTIVE_REFUSED } = await import("../src/html-active.js");
const { REFUSED_PAGES, ONLY_FORMATS } = await import("../src/constants.js");
const { parserLoaded } = await import("../src/html.js");
ensureStateDir();
after(() => fs.rmSync(root, { recursive: true, force: true }));

const SAMPLE = fs.readFileSync(new URL("./fixtures/sample/sample.html", import.meta.url));
let n = 0;
function page(bytes = SAMPLE, name = `p${++n}.html`) {
  const dir = path.join(root, `d${n}`);
  fs.mkdirSync(path.join(dir, "images"), { recursive: true });
  fs.copyFileSync(new URL("./fixtures/sample/images/onion.png", import.meta.url), path.join(dir, "images", "onion.png"));
  const f = path.join(dir, name);
  fs.writeFileSync(f, bytes);
  return fs.realpathSync(f);
}
async function rejects(fn, status, code) {
  try {
    await fn();
  } catch (e) {
    assert.ok(e instanceof HttpError, String(e?.stack || e));
    assert.equal(e.status, status, e.message);
    if (code) assert.equal(e.extra.code, code, e.message);
    return e;
  }
  assert.fail("expected HttpError");
}
/** Bytes outside [s, e) of `a` and of `b` are the same, and `b` holds `repl` there. */
function onlyChanged(a, b, find, repl) {
  const s = a.indexOf(Buffer.from(find));
  assert.ok(s >= 0, `the old text ${find} is in the file`);
  assert.ok(b.subarray(0, s).equals(a.subarray(0, s)), "bytes before the edit are unchanged");
  assert.ok(b.subarray(s + Buffer.byteLength(repl)).equals(a.subarray(s + Buffer.byteLength(find))), "bytes after the edit are unchanged");
  assert.equal(b.subarray(s, s + Buffer.byteLength(repl)).toString(), repl);
}
const edit = (sha, node, newText) => ({ nodeId: node.id, versionSha: sha, baseTextHash: editHash(node.text), newText });

test("the parser is not loaded on this test's thread (the code under test runs as on the server's thread)", () => {
  assert.equal(parserLoaded(), false);
});

test("open: .html and .htm open as html; .mhtml, .mht, .webarchive, .xhtml and .svg get their fixed sentence; others the list", async () => {
  const S = new Sessions();
  const a = await S.openAsync(page(SAMPLE, "a.html"));
  assert.equal(a.format, "html");
  const b = await S.openAsync(page(SAMPLE, "b.HTM"));
  assert.equal(b.format, "html");
  for (const ext of Object.keys(REFUSED_PAGES)) {
    const e = await rejects(() => S.openAsync(page(SAMPLE, `x${ext}`)), 400, "refused_kind");
    assert.equal(e.message, REFUSED_PAGES[ext]);
  }
  assert.match(REFUSED_PAGES[".mhtml"], /in Chrome choose Save As, Webpage, Complete\.$/);
  const e = await rejects(() => S.openAsync(page(SAMPLE, "x.txt")), 400);
  assert.equal(e.message, ONLY_FORMATS);
});

test("open: a page saved as windows-1252 is refused with the R18 sentence (no copy is made: that action is not in this version)", async () => {
  const S = new Sessions();
  const bytes = Buffer.from('<!doctype html><html><head><meta charset="windows-1252"><title>t</title></head><body><p>caf\xe9</p></body></html>', "latin1");
  const f = page(bytes, "latin.html");
  for (let i = 0; i < 2; i++) {
    // the second time comes from the remembered refusal: the same sentence and code
    const e = await rejects(() => S.openAsync(f), 400, "not_utf8");
    assert.equal(e.message, "This file is not saved as UTF-8; Onionskin can save a UTF-8 copy and open that.");
  }
  assert.ok(fs.readFileSync(f).equals(bytes));
  assert.ok(!fs.readdirSync(path.dirname(f)).some((x) => x.includes(".utf8.")), "no copy was written");
  const bad = page(Buffer.from([0x3c, 0x70, 0x3e, 0xff, 0xfe, 0x3c, 0x2f, 0x70, 0x3e]), "bad.html");
  await rejects(() => S.openAsync(bad), 400, "encoding");
});

test("open: a page over a limit is refused with the reason (too many elements)", async () => {
  const S = new Sessions();
  const big = Buffer.from(`<!doctype html><body>${"<i></i>".repeat(200_001)}</body>`);
  const e = await rejects(() => S.openAsync(page(big, "big.html")), 400, "unreadable");
  assert.match(e.message, /more than 200,000 elements/);
});

test("the view: the render copy of the disk bytes, its texts and the editable text nodes, cached per version; plain on request; an outside change is recorded", async () => {
  const S = new Sessions();
  const f = page();
  const s = await S.openAsync(f);
  const [v, v2] = await Promise.all([S.htmlView(s.key), S.htmlView(s.key)]);
  assert.equal(v, v2, "two requests for one version share one render");
  assert.equal(v.sha, sha256(SAMPLE));
  assert.equal(v.plain, false);
  const copy = v.bytes.toString();
  assert.ok(!/<script/i.test(copy) && !/\shref=/i.test(copy), "no script and no href in the copy");
  assert.match(copy, /data:image\/png;base64,/, "the local image is inlined");
  assert.equal(v.stats.scripts, 1);
  const hardy = await textId(SAMPLE, "hardy crops");
  assert.ok(v.editable.includes(hardy.id), "a paragraph's text is editable");
  const link = await textId(SAMPLE, "community garden guide");
  assert.ok(!v.editable.includes(link.id), "a link's text is not");
  assert.ok(v.texts.includes(hardy.id));
  const p = await S.htmlView(s.key, { plain: true });
  assert.equal(p.plain, true);
  assert.equal(p.reason, "asked");
  // an outside change: the next view is of the new bytes, and History records the outside update
  fs.writeFileSync(f, Buffer.from(SAMPLE.toString().replace("hardy crops", "sturdy crops")));
  const v3 = await S.htmlView(s.key);
  assert.notEqual(v3.sha, v.sha);
  assert.equal(s.history.at(-1).kind, "outside");
  assert.equal(s.history.at(-1).after, v3.sha);
});

test("Send with text edits: one write of exactly those texts (bytes outside them unchanged), a Send's comments anchored on the new bytes; refusals change nothing", async () => {
  const S = new Sessions();
  const f = page();
  const s = await S.openAsync(f);
  const sha = sha256(SAMPLE);
  const hardy = await textId(SAMPLE, "hardy crops");
  const water = await textId(SAMPLE, "Water the new rows");
  // refusals first: bytes from the page, an old version, a changed base text
  await rejects(() => S.sendAsync(s.key, { baseSha: sha, bytes: Buffer.from("<p>x</p>"), comments: [], note: "" }), 400, "no_bytes_for_html");
  await rejects(() => S.sendAsync(s.key, { baseSha: sha, htmlEdits: [{ ...edit(sha, hardy, "x"), versionSha: "0".repeat(64) }], comments: [], note: "" }), 409, "version_changed");
  await rejects(() => S.sendAsync(s.key, { baseSha: sha, htmlEdits: [{ ...edit(sha, hardy, "x"), baseTextHash: editHash("other") }], comments: [], note: "" }), 409, "version_changed");
  await rejects(() => S.sendAsync(s.key, { baseSha: sha, htmlEdits: [{ nodeId: "1" }], comments: [], note: "" }), 400, "bad_edits");
  assert.ok(fs.readFileSync(f).equals(SAMPLE), "nothing was written");
  const newText = hardy.text.replace("hardy crops", "cold-hardy crops & herbs");
  const quote = "Snap peas on the trellis";
  const peas = await textId(SAMPLE, quote);
  const comment = { id: "c1", kind: "text", text: "say which peas", anchor: { location: { nodeId: peas.id, start: 0, end: quote.length, version: sha }, quote, prefix: "", suffix: "" } };
  await S.sendAsync(s.key, { baseSha: sha, htmlEdits: [edit(sha, hardy, newText)], comments: [comment], note: "", edits: [{ kind: "text", before: hardy.text, after: newText, location: { nodeId: hardy.id, version: sha } }] });
  const after1 = fs.readFileSync(f);
  onlyChanged(SAMPLE, after1, "hardy crops go", "cold-hardy crops &amp; herbs go");
  assert.equal(s.baseSha, sha256(after1));
  const sent = s.comments.find((c) => c.id === "c1");
  assert.equal(sent.status, "sent");
  assert.equal(sent.durable.quote, quote, "the comment's anchor is the sentence it was made on");
  assert.equal(s.edits[0].durable?.format, "html", "the typed edit's place is anchored too");
  assert.equal(s.history.at(-1).kind, "user");
  assert.equal(s.pending.instructions.comments[0].id, "c1");
  // emptying a text node is an allowed edit (it splices to nothing and the proof passes)
  const s2 = S.get(s.key);
  S.takeBack(s2.key);
  const now = fs.readFileSync(f);
  const w2 = (await htmlNodes(now)).find((x) => x.text?.includes("Water the new rows"));
  await S.sendAsync(s.key, { baseSha: sha256(now), htmlEdits: [{ nodeId: w2.id, versionSha: sha256(now), baseTextHash: editHash(w2.text), newText: "" }], comments: [], note: "" });
  const after2 = fs.readFileSync(f);
  assert.ok(after2.includes(Buffer.from('<p style="color: #3b6b4a;"></p>')), "the paragraph is empty, its markup kept");
  assert.equal(after2.length, now.length - Buffer.byteLength(water.text));
});

test("text edits are refused during a run (D5)", async () => {
  const S = new Sessions();
  const s = await S.openAsync(page());
  const sha = sha256(SAMPLE);
  const lede = await textId(SAMPLE, "A short plan");
  const poll = S.poll(s.key, { holder: "agent" });
  await S.sendAsync(s.key, { baseSha: sha, comments: [{ id: "c1", kind: "element", text: "x", anchor: { location: { nodeId: lede.id, version: sha }, quote: "A short plan", hitKind: "element" } }], note: "" });
  await poll.promise;
  await rejects(() => S.sendAsync(s.key, { baseSha: sha, htmlEdits: [edit(sha, lede, "y")], comments: [], note: "" }), 423, "locked");
});

test("a draft keeps its HTML anchor (node id and version) and pin; one made on an older version is moved by its own version, not by its id", async () => {
  const S = new Sessions();
  const f = page();
  const s = await S.openAsync(f);
  const sha = sha256(SAMPLE);
  const quote = "Spinach between the onion rows";
  const node = await textId(SAMPLE, quote);
  const c = { id: "c1", kind: "text", text: "plant chard too", anchor: { location: { nodeId: node.id, start: 0, end: quote.length, version: sha }, quote, prefix: "", suffix: "" } };
  const pin = { id: "p1", kind: "pin", text: "here", pin: { xFrac: 0.25, yFrac: 0.5 }, anchor: { location: { nodeId: node.id, version: sha }, quote, hitKind: "element" } };
  S.setDraft(s.key, { comments: [c, pin], note: "" });
  assert.deepEqual(s.comments[0].anchor.location, { start: 0, end: quote.length, nodeId: node.id, version: sha });
  assert.deepEqual(s.comments[1].pin, { xFrac: 0.25, yFrac: 0.5, yPx: 0 });
  // outside Onionskin, an element goes in above it: every later node id shifts
  const changed = Buffer.from(SAMPLE.toString().replace("<h2>What to plant first</h2>", "<h2>What to plant first</h2>\n<p>A new note, added later.</p>"));
  fs.writeFileSync(f, changed);
  await S.htmlView(s.key); // the page takes the new version (an outside update)
  const moved = (await htmlNodes(changed)).find((x) => x.text?.includes(quote));
  assert.notEqual(moved.id, node.id, "the id names another node now");
  const r = await S.resolveAllAsync(s.key);
  assert.equal(r.anchors.c1.method === "none", false, JSON.stringify(r.anchors.c1));
  assert.deepEqual(r.anchors.c1.page, { nodeId: moved.id, start: 0, end: quote.length }, "the same sentence, at its new id");
  await S.sendAsync(s.key, { baseSha: sha256(changed), comments: [c], note: "" });
  assert.equal(s.comments[0].durable.quote, quote);
  assert.ok(s.pending.untrusted_document_evidence.anchors.length >= 1, "the batch names it");
});

test("an agent run: a write adding a script is refused with the R1 sentence (recorded with the run); a write removing the script lands; done, History, then Revert restores the bytes exactly", async () => {
  const S = new Sessions();
  const f = page();
  const s = await S.openAsync(f);
  const sha = sha256(SAMPLE);
  const poll = S.poll(s.key, { holder: "agent" });
  const node = await textId(SAMPLE, "Onion sets");
  await S.sendAsync(s.key, { baseSha: sha, comments: [{ id: "c1", kind: "element", text: "drop the script", anchor: { location: { nodeId: node.id, version: sha }, quote: "Onion sets", hitKind: "element" } }], note: "" });
  const batch = await poll.promise;
  const claim = { holder: batch.lease.holder, token: batch.lease.token, batchId: batch.batch_id };
  const withScript = Buffer.from(SAMPLE.toString().replace("</ul>", "</ul>\n<script>alert(1)</script>"));
  const e = await rejects(() => S.agentWriteChecked(s.key, { bytes: withScript, ...claim }), 422, "active_content");
  assert.equal(e.message, ACTIVE_REFUSED);
  assert.ok(fs.readFileSync(f).equals(SAMPLE), "nothing was written");
  assert.equal(s.delivered.applyProblems[0].reason, ACTIVE_REFUSED);
  const noScript = Buffer.from(SAMPLE.toString().replace(/\n<script>[\s\S]*?<\/script>/, "").replace("Onion sets, two rows", "Onion sets, three rows"));
  await S.agentWriteChecked(s.key, { bytes: noScript, ...claim });
  assert.ok(fs.readFileSync(f).equals(noScript));
  const inputs = S.analysisInputs(s.key, claim);
  const analysis = await analyzeOffThread(inputs);
  assert.equal(analysis.checks.node, "ran");
  assert.ok(analysis.changes.items.some((it) => it.text.includes("three rows")), JSON.stringify(analysis.changes));
  const out = await S.doneAsync(s.key, { summary: "done", results: [{ comment_id: "c1", status: "done", note: "ok" }] }, claim, analysis, { inline: false });
  const refused = out.flags.find((x) => x.reason_code === "active_content");
  assert.equal(refused?.detail, ACTIVE_REFUSED, "the run's result carries the fixed sentence");
  const list = await S.history(s.key);
  const run = list.updates.find((u) => u.kind === "agent");
  const d = await S.historyUpdate(s.key, run.id);
  assert.ok(d.places.some((p) => p.change === "modified" || p.diff), JSON.stringify(d.places));
  assert.ok(d.places.every((p) => p.format === "html"));
  const entry = s.activity.find((a) => a.kind === "agent");
  await S.revertAsync(s.key, entry.id);
  assert.ok(fs.readFileSync(f).equals(SAMPLE), "Revert restores the bytes exactly, script and all");
  assert.equal(s.history.at(-1).kind, "revert");
});

test("Review first is refused for HTML (the page hides the button)", async () => {
  const S = new Sessions();
  const s = await S.openAsync(page());
  await rejects(() => S.requestReview(s.key, "proofread"), 409, "not_for_html");
});
