import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test, after } from "node:test";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { buildZip, docxBytes, tmpdir } from "./helpers/zipbuild.js";

// The demo recorder (scripts/demo/record.mjs) and its scan (scan.mjs). The run is made in-process with the real Sessions code and the
// fake agent's edits, in a temp state dir: no browser, no agent, ~/.onionskin never touched. Every refusal also checks nothing was written.
const root = tmpdir();
const base = path.join(root, "base");
fs.mkdirSync(base);
process.env.ONIONSKIN_STATE_DIR = path.join(base, "state");
process.env.ONIONSKIN_LEASE_MS = "60000";
process.env.ONIONSKIN_NO_SOFFICE = "1";
delete process.env.ONIONSKIN_PYTHON;
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { python, havePython, skipUnless, VENV_HINT } = await import("../scripts/fixtures.mjs");
const HAVE_PY = havePython();
const opts = { skip: skipUnless(HAVE_PY, "needs .venv with python-docx", VENV_HINT) };
after(() => fs.rmSync(root, { recursive: true, force: true }));

const { Sessions } = await import("../src/session.js");
const { ensureStateDir } = await import("../src/paths.js");
const { runOps } = await import("../src/ops/run.js");
const { readDocxParagraphs } = await import("../src/docx.js");
const { openZip } = await import("../src/zip.js");
const { DEMO } = await import("../scripts/demo/demo-scenario.mjs");
const { LETTER, LETTER_PARTS, packingProblems, scanDocx, scanFolder, scanRecording } = await import("../scripts/demo/scan.mjs");
const { CANONICAL_DOS_DATE, CANONICAL_DOS_TIME, canonicalZip } = await import("../scripts/demo/canonical.mjs");
const { buildRecording, writeRecording, RecordError } = await import("../scripts/demo/record.mjs");
ensureStateDir();
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
const ID = { user: "patq", home: "/Users/patq", host: "patqs-mac" }; // made up: the scan must refuse these names
const NONCE = "vh66prKjSVojDNZNe6Yu8XeReBBnsHZJ"; // the shape of a launch link's one-time code (24 random bytes, base64url)
const IDS = ["cmwd7criumeia", "cmwd7csdwp4jp", "cmwd7ct6h0wic"]; // the shape of the page's comment ids

// ---- one demo-docx run, answered the way fake-agent.mjs answers it, then reverted ---------------------------------------------------
let ctx = null;
if (HAVE_PY) {
  const fx = path.join(root, "fx");
  execFileSync(python, [path.join(repo, "scripts", "real-run", "make-fixtures.py"), fx], { stdio: "ignore" });
  const file = path.join(base, "welcome.docx");
  fs.copyFileSync(path.join(fx, "welcome.docx"), file);
  fs.copyFileSync(path.join(fx, "welcome.docx"), path.join(base, "original.docx"));
  const real = fs.realpathSync(file);
  const S = new Sessions();
  const s = S.open(real);
  const comments = DEMO.comments.map((c, i) => {
    const quote = DEMO.letter[i + 1];
    return { id: IDS[i], kind: "text", text: c.text, anchor: { location: { blockPath: [i + 1], start: 0, end: quote.length }, quote: quote + "\n", prefix: "", suffix: "", format: "docx" } };
  });
  const poll = S.poll(s.key, { holder: "agent" });
  S.send(s.key, { baseSha: s.baseSha, comments, note: DEMO.overall, edits: [] });
  const batch = await poll.promise;
  const anchors = new Map(batch.untrusted_document_evidence.anchors.map((a) => [a.id, a]));
  const cs = batch.instructions.comments;
  const hash = (c) => anchors.get(c.anchor_id).locator.text_hash;
  const op = (c, find, replace) => ({ op: "replace_text", id: c.id, target: { anchor_id: c.anchor_id }, expect: { text_hash: hash(c) }, find, replace });
  const ops = [
    op(cs[0], ", and we hope that you will feel at home here very quickly", ""),
    op(cs[1], ", so that the crew can reach them", ""),
    op(cs[2], "you should contact", "please ask at"),
    { op: "replace_all_text", id: "overall", find: "front office", replace: "Welcome Desk", expect: { count: 2 } },
  ];
  const before = fs.readFileSync(real);
  const r = await runOps({ bytes: before, format: "docx", name: "welcome.docx", ops, anchors });
  assert.ok(r.bytes, JSON.stringify(r.results));
  const claim = { holder: "agent", token: batch.lease.token, batchId: batch.batch_id };
  S.agentWrite(s.key, { baseSha: sha256(before), bytes: r.bytes, ...claim });
  const notes = ["Cut the ending and kept the welcome.", "Dropped the last clause; the Tuesday pickup stays.", "Changed the wording to a friendlier ask."];
  S.done(s.key, { summary: "Shortened two sentences, made the question line friendlier, and renamed the front office to the Welcome Desk.", results: cs.map((c, i) => ({ comment_id: c.id, status: "done", note: notes[i] })) }, claim);
  S.revert(s.key, S.get(s.key).activity.find((a) => a.kind === "agent").id);
  // what user-sim.mjs writes: it holds the absolute path, the delivered batch (with its lease) and much else the recorder must not copy
  const ev = { scenario: "demo-docx", started_at: new Date().toISOString(), file: real, comment_texts: DEMO.comments.map((c) => c.text), overall_note: DEMO.overall, batch, timing: { working_ms: 900, result_ms: 2400, reverted_ms: 5100 }, fake: true };
  fs.writeFileSync(path.join(base, "evidence.json"), JSON.stringify(ev, null, 2));
  fs.writeFileSync(path.join(base, "scenario.json"), JSON.stringify({ scenario: "demo-docx", workdir: base, file, original: path.join(base, "original.docx"), state_dir: path.join(base, "state"), url_file: path.join(base, "url.txt") }));
  fs.writeFileSync(path.join(base, "url.txt"), `http://127.0.0.1:61472/?s=${s.key}&n=${NONCE}\n`);
  fs.writeFileSync(path.join(base, "fake-agent.marker"), "this workdir was answered by fake-agent.mjs, not a real agent\n");
  ctx = { key: s.key, batch, lease: batch.lease.token };
}

let nth = 0;
/** A copy of the run with its own paths, changed by `mutate({ev, sess, dir, info})`; returns the copy's folder. */
function variant(mutate = () => {}) {
  const dir = path.join(root, `v${++nth}`);
  fs.cpSync(base, dir, { recursive: true });
  const info = JSON.parse(fs.readFileSync(path.join(dir, "scenario.json"), "utf8"));
  info.file = path.join(dir, "welcome.docx");
  info.original = path.join(dir, "original.docx");
  const sf = path.join(dir, "state", "sessions", `${ctx.key}.json`);
  const sess = JSON.parse(fs.readFileSync(sf, "utf8"));
  sess.file = fs.realpathSync(info.file);
  const ev = JSON.parse(fs.readFileSync(path.join(dir, "evidence.json"), "utf8"));
  mutate({ ev, sess, dir, info });
  fs.writeFileSync(path.join(dir, "scenario.json"), JSON.stringify(info));
  fs.writeFileSync(sf, JSON.stringify(sess));
  fs.writeFileSync(path.join(dir, "evidence.json"), JSON.stringify(ev));
  return dir;
}
const agentRun = (sess) => sess.activity.find((a) => a.kind === "agent");
const build = (dir, o = {}) => buildRecording(dir, { agent: "Test agent", test: true, identity: ID, ...o });
const refused = (dir, re, o = {}) => {
  const out = path.join(root, `out-${++nth}`);
  assert.throws(
    () => writeRecording(out, build(dir, o)),
    (e) => e instanceof RecordError && re.test(e.message),
  );
  assert.equal(fs.existsSync(out), false, "nothing is written when a check fails");
};
const RECORD = path.join(repo, "scripts", "demo", "record.mjs");
const SCAN = path.join(repo, "scripts", "demo", "scan.mjs");
const node = (args) => spawnSync(process.execPath, args, { encoding: "utf8", env: { ...process.env, ONIONSKIN_STATE_DIR: path.join(root, "unused-state") } });

test("the scenario's letter constant and part list match the generated welcome.docx", opts, () => {
  const letter = fs.readFileSync(path.join(base, "original.docx"));
  assert.deepEqual(readDocxParagraphs(letter).map((p) => p.text), [...DEMO.letter]);
  assert.deepEqual(openZip(letter).names, [...LETTER_PARTS]);
  // every part is byte-stable, so the scan pins each one: a regenerated letter must hash the same
  for (const n of LETTER_PARTS) assert.equal(sha256(openZip(letter).read(n)), LETTER[n], n);
});

test("a run answered by the stand-in agent is refused without --test, by the command too, and nothing is written", opts, () => {
  refused(variant(), /was answered by the stand-in agent/, { test: false });
  // the marker alone is enough, even when the evidence claims a real run
  refused(variant(({ ev }) => (ev.fake = false)), /was answered by the stand-in agent/, { test: false });
  // a missing stamp is not a real run either
  refused(variant(({ ev, dir }) => (delete ev.fake, fs.rmSync(path.join(dir, "fake-agent.marker")))), /was answered by the stand-in agent/, { test: false });
  const out = path.join(root, "cli-out");
  const r = node([RECORD, base, "--agent", "Test agent", "--out", out]);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /Nothing was written/);
  assert.equal(fs.existsSync(out), false);
  // --test may never write where the page is built from
  const d = node([RECORD, base, "--agent", "Test agent", "--test"]);
  assert.equal(d.status, 1);
  assert.match(d.stderr, /may not be written to web\/demo\/recording/);
});

test("--test writes a recording; the publish-side check refuses it because it is stamped real: false", opts, () => {
  const out = path.join(root, "test-out");
  const r = node([RECORD, base, "--agent", "Test agent", "--test", "--out", out]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(fs.readdirSync(out).sort(), ["recording.json", "v0.docx", "v1.docx"]);
  const { recording, problems } = scanFolder(out);
  assert.equal(recording.real, false);
  assert.deepEqual(problems, ["this recording was made with the stand-in agent (real: false); it can never be shown as a real session"]);
  assert.deepEqual(scanFolder(out, { test: true }).problems, []);
  const pub = node([SCAN, out]);
  assert.equal(pub.status, 1);
  assert.match(pub.stderr, /stand-in agent/);
  assert.equal(node([SCAN, out, "--test"]).status, 0);
  const j = JSON.parse(fs.readFileSync(path.join(out, "recording.json"), "utf8"));
  assert.equal(scanRecording({ recording: { ...j, real: "yes" }, v0: fs.readFileSync(path.join(out, "v0.docx")), v1: fs.readFileSync(path.join(out, "v1.docx")) }).includes("real must be true or false"), true);
});

test("the allow-list output carries no path, id, key, lease, token or user name, and only the listed fields", opts, () => {
  const { recording: r, v0, v1 } = build(base);
  assert.deepEqual(Object.keys(r), ["schema", "real", "agent", "date", "format", "v0_sha256", "v1_sha256", "comments", "overall_note", "result", "places", "timing"]);
  assert.deepEqual(Object.keys(r.comments[0]), ["n", "text", "quote", "prefix", "suffix"]);
  assert.deepEqual(Object.keys(r.result.notes[0]), ["n", "status", "note"]);
  assert.deepEqual(Object.keys(r.places[0]), ["change", "diff", "text_start"]);
  assert.deepEqual(r.timing, { working_ms: 900, result_ms: 2400 });
  assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(r.v0_sha256, sha256(v0));
  assert.equal(r.v1_sha256, sha256(v1));
  const keys = [];
  const walk = (v) => (Array.isArray(v) ? v.forEach(walk) : v && typeof v === "object" ? Object.entries(v).forEach(([k, x]) => (keys.push(k), walk(x))) : null);
  walk(r);
  for (const bad of ["file", "key", "lease", "holder", "token", "id", "batchId", "comment_id", "anchor", "durable"]) assert.ok(!keys.includes(bad), bad);
  const text = JSON.stringify(r);
  for (const bad of ["/Users/", "/private/", "/tmp/", root, ctx.key, ctx.batch.batch_id, ctx.lease, NONCE, ...IDS, "patq"]) assert.ok(!text.includes(bad), bad);
  const hex = JSON.stringify({ ...r, v0_sha256: "", v1_sha256: "" }).match(/[0-9a-f]{16,}/gi);
  assert.equal(hex, null);
  assert.equal(r.comments[0].quote, DEMO.letter[1], "the quote is cleaned (the trailing newline is gone)");
  assert.deepEqual(scanRecording({ recording: r, v0, v1 }, { identity: ID, test: true }), []);
});

test("a recording that tries to smuggle a home-directory path is refused, and nothing is written", opts, () => {
  refused(variant(({ sess }) => (agentRun(sess).results[0].note = "Saved a copy in /Users/patq/Desktop/letter.docx first.")), /result note 1 text holds a file path/);
  refused(variant(({ sess }) => (agentRun(sess).results[1].note = "A copy is in ~/Desktop now.")), /result note 2 text holds a file path/);
  refused(variant(({ sess }) => (agentRun(sess).summary = "Done for patq.")), /result summary holds this Mac's user name/);
  refused(variant(({ sess }) => (agentRun(sess).summary = "Edited the copy at C:\\letters\\welcome.docx.")), /file path/);
});

test("a recording that tries to smuggle a launch token or a lease ticket is refused, and nothing is written", opts, () => {
  refused(variant(({ sess }) => (agentRun(sess).summary = `Opened the page with ${NONCE} and finished.`)), /result summary holds a token-like run/);
  refused(variant(({ sess }) => (agentRun(sess).results[0].note = `Used --lease ${ctx.batch.batch_id}:${ctx.lease}`)), /result note 1 text holds/);
  refused(variant(({ sess }) => (agentRun(sess).results[2].note = `Answered ${IDS[2]}.`)), /id-shaped word/);
  refused(variant(({ sess }) => (agentRun(sess).summary = "See http://127.0.0.1:61472/ for the result.")), /web address/);
  refused(variant(({ sess }) => (agentRun(sess).summary = "Mail patq@example.com when done.")), /email address/);
});

test("a recording that tries to smuggle a sentence that is not in the sample or the scenario is refused, and nothing is written", opts, () => {
  const sentence = "Please send the deposit to the new account today.";
  refused(variant(({ sess }) => (sess.comments[0].anchor.quote = sentence)), /comment 1 quote is not text of the letter/);
  refused(variant(({ sess }) => (sess.comments[1].anchor.suffix = ` ${sentence}`)), /comment 2 suffix is not text of the letter/);
  refused(variant(({ sess }) => (sess.comments[2].text = sentence)), /not the scenario's comments/);
  refused(variant(({ ev }) => (ev.overall_note = sentence)), /overall note is not the scenario's note/);
  refused(variant(({ ev }) => (ev.batch.instructions.overall_note = sentence)), /overall note is not the scenario's note/);
  // the same sentence placed straight into the files the page reads: the scan refuses each one
  const good = build(base);
  const scan = (mut) => {
    const r = structuredClone(good.recording);
    mut(r);
    return scanRecording({ recording: r, v0: good.v0, v1: good.v1 }, { identity: ID, test: true });
  };
  assert.ok(scan((r) => (r.comments[0].text = sentence)).includes("comment 1 text is not the scenario's comment"));
  assert.ok(scan((r) => (r.overall_note = sentence)).includes("overall_note is not the scenario's note"));
  assert.ok(scan((r) => r.places[0].diff.splice(1, 0, ["=", sentence])).includes("place 1 diff 2 is not text of the letter"));
  assert.ok(scan((r) => (r.places[0].diff[2] = ["-", sentence])).includes("place 1 diff 3 is not text of the letter"));
  assert.ok(scan((r) => (r.places[0].text_start = sentence)).includes("place 1 text_start is not text of v1.docx"));
  assert.ok(scan((r) => r.places[0].diff.push(["+", sentence])).includes("places are not what the two versions show"));
  // a v0 that is not the bundled letter
  const other = docxBytes(["Dear new neighbor,", sentence]);
  assert.ok(scanRecording({ recording: { ...good.recording, v0_sha256: sha256(other) }, v0: other, v1: good.v1 }, { identity: ID, test: true }).includes("v0.docx is not the bundled demo letter"));
});

test("fields outside the allow-list are refused wherever they are", opts, () => {
  const good = build(base);
  const scan = (mut) => {
    const r = structuredClone(good.recording);
    mut(r);
    return scanRecording({ recording: r, v0: good.v0, v1: good.v1 }, { identity: ID, test: true });
  };
  assert.match(scan((r) => (r.file = "welcome.docx"))[0], /exactly these fields/);
  assert.match(scan((r) => (r.comments[0].id = "c1")).join("\n"), /comment 1 must hold exactly/);
  assert.match(scan((r) => (r.result.notes[0].comment_id = "c1")).join("\n"), /result note 1 must hold exactly/);
  assert.match(scan((r) => (r.places[0].locator = {})).join("\n"), /place 1 must hold exactly/);
  assert.match(scan((r) => (r.timing.reverted_ms = 5)).join("\n"), /timing must hold exactly/);
  assert.match(scan((r) => (r.v1_sha256 = r.v0_sha256)).join("\n"), /v1_sha256 does not match/);
  // the listed keys in another order: the order would reach the page, so it is refused too
  assert.match(scan((r) => {
    const { schema, ...rest } = r;
    for (const k of Object.keys(r)) delete r[k];
    Object.assign(r, rest, { schema });
  })[0], /exactly these fields/);
  assert.match(scan((r) => (r.timing = { result_ms: r.timing.result_ms, working_ms: r.timing.working_ms })).join("\n"), /timing must hold exactly/);
});

test("a revert whose restored version is not the version before the run is refused", opts, () => {
  refused(variant(({ sess }) => (sess.activity.find((a) => a.kind === "revert").postSha = agentRun(sess).postSha)), /did not put back the version from before/);
  refused(variant(({ sess }) => (agentRun(sess).reverted = false)), /was not reverted/);
  refused(variant(({ sess }) => (sess.activity = sess.activity.filter((a) => a.kind !== "revert"))), /exactly one agent run and one Revert/);
  refused(variant(({ sess }) => sess.activity.push({ ...agentRun(sess), id: "r_x" })), /exactly one agent run and one Revert/);
});

test("strings with bidirectional or control characters come out clean, and the scan refuses them when they are put back", opts, () => {
  const dir = variant(({ sess }) => {
    agentRun(sess).summary = "Shortened\u202e two\u0007 sentences.";
    agentRun(sess).results[0].note = "Cut\u200b the\tending.\u2066";
  });
  const good = build(dir);
  assert.equal(good.recording.result.summary, "Shortened two sentences.");
  assert.equal(good.recording.result.notes[0].note, "Cut the ending.");
  const r = structuredClone(good.recording);
  r.result.summary = "Shortened\u202e two sentences.";
  assert.ok(scanRecording({ recording: r, v0: good.v0, v1: good.v1 }, { identity: ID, test: true }).some((p) => /result summary has control or bidirectional/.test(p)));
  r.result.summary = "<img src=x onerror=alert(1)>";
  assert.ok(scanRecording({ recording: r, v0: good.v0, v1: good.v1 }, { identity: ID, test: true }).includes("result summary holds markup"));
});

// ---- the document scan, one hostile document per case (minimal hand-built packages; no Python needed) ------------------------------
const RELS = (inner) => `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${inner}</Relationships>`;
const P = (inner) => `<w:p>${inner}<w:r><w:t>Welcome to Maple Court.</w:t></w:r></w:p>`;
const HOSTILE = {
  "an external image link": docxBytes([], { "word/_rels/document.xml.rels": RELS('<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="https://example.invalid/p.png" TargetMode="External"/>') }, P('<w:r><w:drawing><a:blip xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" r:embed="rId9"/></w:drawing></w:r>')),
  "a linked image": docxBytes([], {}, P('<w:r><w:drawing><a:blip xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" r:link="rId9"/></w:drawing></w:r>')),
  "a HYPERLINK field": docxBytes([], {}, P('<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> HYPERLINK "https://example.invalid" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>')),
  "an INCLUDEPICTURE field": docxBytes([], {}, P('<w:fldSimple w:instr=" INCLUDEPICTURE &quot;x.png&quot; "><w:r><w:t>pic</w:t></w:r></w:fldSimple>')),
  "an attached template": docxBytes(["Welcome to Maple Court."], { "word/settings.xml": '<?xml version="1.0"?><w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:attachedTemplate r:id="rId1"/></w:settings>', "word/_rels/settings.xml.rels": RELS('<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" Target="file:///C:/t.dotm" TargetMode="External"/>') }),
  "an altChunk": docxBytes([], {}, P('<w:altChunk r:id="rId3"/>')),
  "a web address in the text": docxBytes(["Visit https://example.invalid for more."]),
  "an image part": docxBytes(["Welcome to Maple Court."], { "word/media/image1.png": "png" }),
  "the user name in the properties": docxBytes(["Welcome to Maple Court."], { "docProps/core.xml": '<?xml version="1.0"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"><cp:lastModifiedBy>patq</cp:lastModifiedBy></cp:coreProperties>' }),
};
const EXPECT = {
  "an external image link": /external relationship/,
  "a linked image": /r:link/,
  "a HYPERLINK field": /w:instrText/,
  "an INCLUDEPICTURE field": /w:fldSimple/,
  "an attached template": /attached template/,
  "an altChunk": /altChunk/,
  "a web address in the text": /web address/,
  "an image part": /not XML/,
  "the user name in the properties": /user name/,
};
for (const [what, bytes] of Object.entries(HOSTILE)) {
  test(`the document scan refuses ${what}`, () => {
    const problems = scanDocx(bytes, "v1.docx", ID);
    assert.ok(problems.some((p) => EXPECT[what].test(p)), JSON.stringify(problems));
  });
}

test("a plain package passes the document scan (namespace and type names are not web addresses)", () => {
  assert.deepEqual(scanDocx(docxBytes(["Welcome to Maple Court."]), "v0.docx", ID), []);
});

/** A copy of the run whose agent version (v1) is changed part by part, stored under its own hash as the session would store it. */
const withV1 = (mutate) =>
  variant(({ sess, dir }) => {
    const run = agentRun(sess);
    const snaps = path.join(dir, "state", "snapshots", ctx.key);
    const zip = openZip(fs.readFileSync(path.join(snaps, `${run.postSha}.bin`)));
    const files = Object.fromEntries(zip.names.map((n) => [n, zip.read(n)]));
    mutate(files, (n) => zip.readText(n));
    const bytes = buildZip(files);
    const sha = sha256(bytes);
    fs.writeFileSync(path.join(snaps, `${sha}.bin`), bytes);
    run.postSha = sha;
  });
const body = (text, from, to) => Buffer.from(text("word/document.xml").replace(from, to));

test("a run whose agent wrote a hostile v1 is refused at record time, and nothing is written", opts, () => {
  refused(withV1((f, text) => (f["word/document.xml"] = body(text, "<w:r>", '<w:r><w:instrText> HYPERLINK "https://example.invalid" </w:instrText></w:r><w:r>'))), /v1\.docx word\/document\.xml: a field \(w:instrText\)/);
  // a launch token in a header part the agent added
  refused(withV1((f) => (f["word/header1.xml"] = Buffer.from(`<?xml version="1.0"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>${NONCE}</w:t></w:r></w:p></w:hdr>`))), /v1\.docx adds or removes parts/);
  // a sentence that is not in the sample, in the properties
  refused(withV1((f, text) => (f["docProps/core.xml"] = Buffer.from(text("docProps/core.xml").replace("<dc:description>generated by python-docx</dc:description>", "<dc:description>Please send the deposit today.</dc:description>")))), /v1\.docx changes docProps\/core\.xml; only the body may change/);
  // text the paragraph reader does not return: a text box, a deleted run, an XML comment, text outside a run, a token in an attribute
  refused(withV1((f, text) => (f["word/document.xml"] = body(text, "<w:r>", "<w:r><w:pict><w:txbxContent><w:p><w:r><w:t>Send the deposit.</w:t></w:r></w:p></w:txbxContent></w:pict></w:r><w:r>"))), /v1\.docx body: holds w:txbxContent/);
  refused(withV1((f, text) => (f["word/document.xml"] = body(text, "<w:r>", "<w:del><w:r><w:delText>Send the deposit.</w:delText></w:r></w:del><w:r>"))), /v1\.docx body: holds w:delText/);
  refused(withV1((f, text) => (f["word/document.xml"] = body(text, "<w:r>", "<!-- Send the deposit. --><w:r>"))), /v1\.docx body: holds an XML comment/);
  refused(withV1((f, text) => (f["word/document.xml"] = body(text, "<w:r>", "Send the deposit.<w:r>"))), /v1\.docx body: holds text outside/);
  refused(withV1((f, text) => (f["word/document.xml"] = body(text, "<w:r>", `<w:r w:rsidR="${NONCE}">`))), /v1\.docx body: an attribute holds a token-like value/);
});

test("the guards above do not refuse an untouched v1 or plain prose from an agent", opts, () => {
  const plain = "Checked the file: both places changed. The data: unchanged. Open 9:30 to 5:00, and/or by appointment, 24/7 by email? No.";
  const good = build(variant(({ sess }) => (agentRun(sess).summary = plain)));
  assert.equal(good.recording.result.summary, plain);
  // an untouched copy of v1 under a new zip (other byte layout, same parts) passes too
  assert.ok(build(withV1(() => {})).recording);
});

// ---- wrong "yes" answers an independent review found: each one must now be refused -------------------------------------------------
/**
 * A ZIP built byte by byte so each place a ZIP can carry bytes outside its parts can be filled: `eocdComment`, `centralExtra`,
 * `centralComment`, `localExtra` (on the first entry), `gap` (bytes between the first two entries), `stored` (the first entry not compressed), `trailing` (after the end
 * record), `afterDeflate` (bytes inside the first entry's data, after the deflate stream ends), `level` (another deflate encoding),
 * and the header numbers of every entry: `madeBy`, `external` (file attributes), `time`, `date`; `lastTime` stamps only the last entry
 * (in both of its headers). With no options and the defaults below it writes exactly what the recorder's canonical repack writes.
 */
function rawZip(files, o = {}) {
  const locals = [];
  const central = [];
  let offset = 0;
  const count = Object.keys(files).length;
  Object.entries(files).forEach(([name, content], k) => {
    const data = Buffer.from(content);
    const time = k === count - 1 && o.lastTime != null ? o.lastTime : (o.time ?? 0);
    const method = k === 0 && o.stored ? 0 : 8;
    let comp = method === 0 ? data : zlib.deflateRawSync(data, o.level != null ? { level: o.level } : {});
    if (k === 0 && o.afterDeflate) comp = Buffer.concat([comp, Buffer.from(o.afterDeflate)]);
    const nameBuf = Buffer.from(name);
    const lx = Buffer.from(k === 0 && o.localExtra ? o.localExtra : "");
    const cx = Buffer.from(k === 0 && o.centralExtra ? o.centralExtra : "");
    const cc = Buffer.from(k === 0 && o.centralComment ? o.centralComment : "");
    const crc = zlib.crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(o.date ?? 0x21, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(lx.length, 28);
    const gap = Buffer.from(k === 0 && o.gap ? o.gap : "");
    locals.push(lh, nameBuf, lx, comp, gap);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(o.madeBy ?? 20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(o.date ?? 0x21, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(cx.length, 30);
    ch.writeUInt16LE(cc.length, 32);
    ch.writeUInt32LE(o.external ?? 0, 38);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf, cx, cc);
    offset += lh.length + nameBuf.length + lx.length + comp.length + gap.length;
  });
  const cd = Buffer.concat(central);
  const comment = Buffer.from(o.eocdComment || "");
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...locals, cd, end, comment, Buffer.from(o.trailing || "")]);
}
const SECRET = `/Users/patq/Desktop/taxes.pdf token=${NONCE}`;
const SH = "­";
/** A copy of the run whose v1 is replaced by `make(files of the honest v1)`'s bytes, stored under its own hash. */
const withV1Bytes = (make) =>
  variant(({ sess, dir }) => {
    const run = agentRun(sess);
    const snaps = path.join(dir, "state", "snapshots", ctx.key);
    const zip = openZip(fs.readFileSync(path.join(snaps, `${run.postSha}.bin`)));
    const bytes = make(Object.fromEntries(zip.names.map((n) => [n, zip.read(n)])), (n) => zip.readText(n));
    const sha = sha256(bytes);
    fs.writeFileSync(path.join(snaps, `${sha}.bin`), bytes);
    run.postSha = sha;
  });
/** The run as a real agent would leave it: stamped fake: false and no marker. */
const asReal = (dir) => {
  const ev = JSON.parse(fs.readFileSync(path.join(dir, "evidence.json"), "utf8"));
  ev.fake = false;
  fs.writeFileSync(path.join(dir, "evidence.json"), JSON.stringify(ev));
  fs.rmSync(path.join(dir, "fake-agent.marker"), { force: true });
  return dir;
};

test("the honest run, recorded at production shape (real agent, no --test), passes the publish-side scan", opts, () => {
  const out = path.join(root, `prod-${++nth}`);
  const rec = build(asReal(variant()), { test: false });
  assert.equal(rec.recording.real, true);
  writeRecording(out, rec);
  assert.deepEqual(scanFolder(out, { identity: ID }).problems, []);
});

// ---- the recorder's canonical archives: every header field that is not content is a fixed constant ------------------------------------
/** Every entry of an archive as [name, inflated bytes, stored CRC], in order. */
const entriesOf = (bytes) => {
  const z = openZip(bytes);
  return z.names.map((n) => [n, z.read(n), z.entries.get(n).crc >>> 0]);
};
const honestV1 = () => {
  const run = JSON.parse(fs.readFileSync(path.join(base, "state", "sessions", `${ctx.key}.json`), "utf8")).activity.find((a) => a.kind === "agent");
  return fs.readFileSync(path.join(base, "state", "snapshots", ctx.key, `${run.postSha}.bin`));
};
const filesOf = (bytes) => Object.fromEntries(entriesOf(bytes).map(([n, b]) => [n, b]));
const PACKED = (why) => new RegExp(`v1\\.docx is not packed the way the recorder packs it \\(${why}\\)`);

test("the canonical repack keeps every entry's content, CRC and order, and two repacks of the same input are byte-identical", opts, () => {
  for (const src of [fs.readFileSync(path.join(base, "original.docx")), honestV1()]) {
    const once = canonicalZip(src);
    assert.ok(canonicalZip(src).equals(once), "the same input gives the same bytes");
    assert.ok(canonicalZip(once).equals(once), "a canonical archive repacks to itself");
    const [a, b] = [entriesOf(src), entriesOf(once)];
    assert.deepEqual(b.map(([n]) => n), a.map(([n]) => n), "same names in the same order");
    a.forEach(([n, bytes, crc], i) => {
      assert.ok(b[i][1].equals(bytes), `${n}: same inflated bytes`);
      assert.equal(b[i][2], crc, `${n}: same CRC`);
      assert.equal(zlib.crc32(b[i][1]) >>> 0, crc, `${n}: the CRC is the content's`);
    });
    assert.deepEqual(packingProblems(once, "v1.docx"), []);
    // an independent writer (rawZip, built byte by byte above) with the canonical constants writes the same bytes
    assert.ok(rawZip(filesOf(src)).equals(once), "rawZip with no options is the canonical form");
  }
  // a part whose content does not match its stored checksum is refused, never repacked
  const bad = Buffer.from(rawZip({ "a.xml": "<a/>" }));
  const cd = openZip(bad).entries.get("a.xml").cdOffset;
  bad.writeUInt32LE(bad.readUInt32LE(cd + 16) ^ 1, cd + 16);
  assert.throws(() => canonicalZip(bad), /does not match its stored checksum/);
});

test("a source with mixed time stamps, comments and extra fields comes out with none of them, and passes the scan", opts, () => {
  const ascii = (t) => Buffer.from(t).readUInt16LE(0);
  const messy = rawZip(filesOf(honestV1()), { eocdComment: SECRET, centralExtra: SECRET, centralComment: SECRET, localExtra: SECRET, time: 0x6a5b, date: 0x5d6c, lastTime: 0x6a5c, madeBy: ascii("pa"), external: ascii("tq"), level: 1 });
  assert.ok(messy.includes(Buffer.from(SECRET)));
  const clean = canonicalZip(messy);
  assert.ok(clean.equals(canonicalZip(honestV1())), "the same bytes as the honest archive's repack");
  assert.ok(!clean.includes(Buffer.from(SECRET)));
  assert.deepEqual(packingProblems(clean, "v1.docx"), []);
  // through the recorder, at production shape: the written v1 is the honest one, and the folder passes the publish-side scan
  const honest = build(asReal(variant()), { test: false });
  const rec = build(asReal(withV1Bytes(() => messy)), { test: false });
  assert.ok(rec.v1.equals(honest.v1));
  assert.ok(rec.v0.equals(honest.v0));
  assert.equal(rec.recording.v1_sha256, sha256(honest.v1));
  const out = path.join(root, `canon-${++nth}`);
  writeRecording(out, rec);
  assert.deepEqual(scanFolder(out, { identity: ID }).problems, []);
  for (const f of ["v0.docx", "v1.docx"]) {
    const b = fs.readFileSync(path.join(out, f));
    assert.equal(b.readUInt16LE(b.length - 2), 0, `${f}: no archive comment`);
    for (const [n] of entriesOf(b)) {
      const e = openZip(b).entries.get(n);
      assert.deepEqual([b.readUInt16LE(e.cdOffset + 12), b.readUInt16LE(e.cdOffset + 14), b.readUInt16LE(e.cdOffset + 30), b.readUInt16LE(e.cdOffset + 32)], [CANONICAL_DOS_TIME, CANONICAL_DOS_DATE, 0, 0], `${f} ${n}`);
    }
  }
});

test("a hand-made v1 that carries bytes outside its parts is refused by the scan: a stamp, a comment, an extra field, and more", opts, () => {
  const good = build(base);
  const files = filesOf(good.v1);
  const scan = (v1) => scanRecording({ recording: { ...good.recording, v1_sha256: sha256(v1) }, v0: good.v0, v1 }, { identity: ID, test: true }).join("\n");
  assert.equal(scan(rawZip(files)), "", "the canonical layout passes");
  const ascii = (t) => Buffer.from(t).readUInt16LE(0);
  const cases = [
    // the canonical time on every entry but the last, which is two seconds later (inside the old ten-second window)
    [{ lastTime: 1 }, "an entry's time stamp is not the fixed one"],
    [{ time: 0x6a5b, date: 0x5d6c }, "an entry's time stamp is not the fixed one"],
    [{ time: 0xffff }, "an entry's time stamp is not the fixed one"],
    [{ eocdComment: SECRET }, "the end record is not the last bytes: an archive comment or trailing bytes"],
    [{ trailing: SECRET }, "the end record is not the last bytes: an archive comment or trailing bytes"],
    [{ centralComment: SECRET }, "an entry carries an extra field or a comment"],
    [{ centralExtra: SECRET }, "an entry carries an extra field or a comment"],
    [{ localExtra: SECRET }, "a local header does not repeat its central record"],
    [{ gap: SECRET }, "bytes between the entries"],
    [{ afterDeflate: SECRET }, "bytes after a part's compressed data"],
    [{ level: 1 }, "a part's compressed data is not the standard encoding of its content"],
    [{ madeBy: ascii("pa") }, "an entry's header numbers are not the fixed ones"],
    [{ external: ascii("tq") }, "an entry's header numbers are not the fixed ones"],
    // a stored (uncompressed) entry: every canonical entry is deflated by the recorder
    [{ stored: true }, "an entry's header numbers are not the fixed ones"],
    // the letter writer's own profile (Python's zipfile) is no longer accepted: only the recorder's
    [{ madeBy: 0x314, external: 0x1800000 }, "an entry's header numbers are not the fixed ones"],
  ];
  for (const [o, why] of cases) assert.match(scan(rawZip(files, o)), PACKED(why.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), JSON.stringify(o));
  assert.ok(rawZip(files).equals(good.v1), "the recorder wrote the canonical layout");
  // the parts in another order: the order is the letter's, so it cannot carry anything either
  const names = Object.keys(files);
  const swapped = Object.fromEntries([names[1], names[0], ...names.slice(2)].map((n) => [n, files[n]]));
  assert.match(scan(rawZip(swapped)), /v1\.docx does not have the letter's parts in the letter's order/);
});

test("run text spelled another way than the engine writes it is refused: a character reference, an escaped quote, doubled spaces", opts, () => {
  refused(withV1((f, text) => (f["word/document.xml"] = body(text, "Welcome Desk", "&#87;elcome Desk"))), /v1\.docx body: holds run text not written the plain way/);
  refused(withV1((f, text) => (f["word/document.xml"] = body(text, "Welcome Desk", "Welcome&#x20;Desk"))), /v1\.docx body: holds run text not written the plain way/);
  refused(withV1((f, text) => (f["word/document.xml"] = body(text, "Welcome Desk", "Welcome &quot;Desk&quot;"))), /v1\.docx body: holds run text not written the plain way/);
  refused(withV1((f, text) => (f["word/document.xml"] = body(text, "Welcome Desk", "Welcome  Desk"))), /v1\.docx paragraph \d+ has extra spaces or characters the page does not show/);
});

test("body markup the letter does not have is refused: a sentence in a bookmark name, a made-up attribute value", opts, () => {
  const bm = '<w:bookmarkStart w:id="0" w:name="Please send the deposit to the new account today"/><w:bookmarkEnd w:id="0"/>';
  refused(asReal(withV1((f, text) => (f["word/document.xml"] = body(text, "<w:r>", `${bm}<w:r>`)))), /v1\.docx body: holds markup the letter does not have/, { test: false });
  refused(withV1((f, text) => (f["word/document.xml"] = body(text, /w:rsidR="[0-9A-F]+"/, 'w:rsidR="QwErTyUiOpAsDfGhJkL"'))), /v1\.docx body: holds markup the letter does not have/);
  // inside a tag, where a plain attribute pattern does not look: a non-ASCII attribute name, words with no "=", extra spacing
  const sentence = "Please send the deposit to the new account today";
  for (const tag of [`<w:r \u00e9="${sentence}">`, `<w:r "${sentence}">`, "<w:r   >"]) refused(withV1((f, text) => (f["word/document.xml"] = body(text, "<w:r>", tag))), /v1\.docx body: holds markup the letter does not have/);
  // before the root: in the XML declaration, in an instruction ahead of it, as spacing between tags
  refused(withV1((f, text) => (f["word/document.xml"] = body(text, "standalone='yes'", `standalone='yes' note='${sentence}'`))), /v1\.docx body: holds markup the letter does not have/);
  refused(withV1((f, text) => (f["word/document.xml"] = Buffer.from(`<?xml-note ${sentence}?>` + text("word/document.xml")))), /v1\.docx body: holds markup the letter does not have/);
  refused(withV1((f, text) => (f["word/document.xml"] = body(text, "</w:p>", "</w:p>\n\t \n"))), /v1\.docx body: holds markup the letter does not have/);
});

test("invisible or look-alike characters are refused: soft hyphens, Unicode slashes, a Cyrillic letter in the user name", opts, () => {
  const split = NONCE.match(/.{1,5}/g).join(SH);
  refused(asReal(variant(({ sess }) => (agentRun(sess).results[0].note = `Opened with ${split} and pa${SH}tq.`))), /result note 1 text holds a character/, { test: false });
  refused(variant(({ sess }) => (agentRun(sess).summary = `Done for pa${SH}tq.`)), /result summary holds a character/);
  const good = build(base);
  const scan = (mut) => {
    const r = structuredClone(good.recording);
    mut(r);
    return scanRecording({ recording: r, v0: good.v0, v1: good.v1 }, { identity: ID, test: true }).join("\n");
  };
  assert.match(scan((r) => (r.result.summary = `Done for pa${SH}tq.`)), /result summary holds a character/);
  assert.match(scan((r) => (r.result.summary = "Saved a copy in ∕Volumes∕FamilyShare∕taxes first.")), /result summary holds a character/);
  assert.match(scan((r) => (r.result.summary = "Copied it to ／Volumes／FamilyShare／letters.")), /result summary holds a character/);
  assert.match(scan((r) => (r.result.summary = "Done for pаtq.")), /result summary holds a character/);
  assert.match(scan((r) => (r.result.summary = "Checked [/etc] first.")), /result summary holds a file path/);
  assert.match(scan((r) => (r.result.summary = "Saved to Desktop/taxes.pdf now.")), /result summary holds a file path/);
  // a token cut into short words: any word of four or more that mixes letters and digits is id-shaped
  assert.match(scan((r) => (r.result.summary = "Code vh66p rKjSV ojDNZ Ne6Yu 8XeRe BBnsH ZJ ok.")), /result summary holds an id-shaped word/);
  // in the letter's own text too: a soft hyphen inside a word of v1
  refused(withV1((f, text) => (f["word/document.xml"] = body(text, "Welcome Desk", `Welcome De${SH}sk`))), /v1\.docx body: holds a character/);
});

test("v0 must be the bundled letter part for part, and the original letter must be there to compare with", opts, () => {
  const good = build(base);
  const z0 = openZip(good.v0);
  const f0 = Object.fromEntries(z0.names.map((n) => [n, z0.read(n)]));
  const z1 = openZip(good.v1);
  const sentence = "Please send the deposit to the new account today";
  const prop = (n, z) => Buffer.from(z.readText(n).replace("generated by python-docx", sentence));
  const v0 = buildZip({ ...f0, "docProps/core.xml": prop("docProps/core.xml", z0) });
  const v1 = buildZip({ ...Object.fromEntries(z1.names.map((n) => [n, z1.read(n)])), "docProps/core.xml": prop("docProps/core.xml", z1) });
  const r = { ...good.recording, v0_sha256: sha256(v0), v1_sha256: sha256(v1) };
  assert.ok(scanRecording({ recording: r, v0, v1 }, { identity: ID, test: true }).includes("v0.docx docProps/core.xml is not the bundled letter's"));
  refused(variant(({ info }) => (info.original = path.join(root, "no-such-original.docx"))), /the letter the run started from is missing/);
  refused(variant(({ info }) => delete info.original), /the letter the run started from is missing/);
});

test("a recording folder holding any other file, a Finder .DS_Store included, is refused", opts, () => {
  const out = path.join(root, `ds-${++nth}`);
  writeRecording(out, build(base));
  fs.writeFileSync(path.join(out, ".DS_Store"), `Bud1 ${SECRET}`);
  assert.deepEqual(scanFolder(out, { identity: ID, test: true }).problems, ["the folder holds files that are not part of a recording: 1"]);
});

test("the real-run user script types the scenario's words from the shared constant", () => {
  const sc = fs.readFileSync(path.join(repo, "scripts", "real-run", "scenarios.mjs"), "utf8");
  assert.match(sc, /import \{ DEMO \} from "\.\.\/demo\/demo-scenario\.mjs"/);
  assert.match(sc, /for \(const c of DEMO\.comments\) await commentOnParagraph\(page, c\.on, c\.text\)/);
});
