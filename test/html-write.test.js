// The write check of an HTML file (src/html-write.js checkedHtmlWrite, R1, R10, R12) on every path that writes one: the agent's ops
// (runOps, as reply and apply run them), the agent's whole version through the session (/cli/agent-write and /cli/commit: the session's
// agentWriteChecked, with the check in its worker), a standalone commit (the CLI, its worker), and the person's own text edits (the
// function Phase 2a wires). Each refuses a write that adds a script, an event handler, a frame, a form, a remote image, a stylesheet
// link, a data- attribute, an edited script body, a script type flip, or (when the file loads a script) a template delimiter, and accepts
// text, formatting, tables, lists, a local image and http(s) and mailto links (listed for History). Also: the compare-and-swap after the
// worker's await, the charset rule, and that nothing writes an HTML file unchecked. Ordinary HTML features only. Temp dirs only.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { docxBytes, tmpdir } from "./helpers/zipbuild.js";
import "../src/html-parser.js";
import * as H from "../src/html.js";
import { ACTIVE_REFUSED } from "../src/html-active.js";
import { CHARSET_META, checkedHtmlWrite } from "../src/html-write.js";
import { htmlWriteOffThread } from "../src/offload.js";
import { runOps } from "../src/ops/run.js";

const root = tmpdir();
process.env.ONIONSKIN_STATE_DIR = path.join(root, "st");
process.env.ONIONSKIN_LEASE_MS = "60000";
delete process.env.ONIONSKIN_PYTHON;
delete process.env.ONIONSKIN_HOLDER;
process.env.ONIONSKIN_NO_SOFFICE = "1";
const { Sessions, HttpError } = await import("../src/session.js");
const { sha256 } = await import("../src/fsutil.js");
const { ensureStateDir } = await import("../src/paths.js");
const { applyCommand, commitCommand } = await import("../src/apply.js");
ensureStateDir();
after(() => fs.rmSync(root, { recursive: true, force: true }));

const B = (s) => Buffer.from(s, "utf8");
const page = (body, head = "") => `<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n<title>T</title>\n${head}</head>\n<body>\n<p id="p1">First paragraph.</p>\n${body}\n</body>\n</html>\n`;
const PLAIN = page("<p>Last.</p>");
const SCRIPTED = page('<p>Last.</p>\n<script type="text/javascript">var n = 1;</script>');
const after1 = (src, html) => src.replace('<p id="p1">First paragraph.</p>', `<p id="p1">First paragraph.</p>${html}`);

// what a write may not add (R1): [name, base page, the whole new version, the op that makes it or null, reason code]
// two existing handlers, their values swapped by a whole new version (outside review 029e51b, html-active.js:282)
const HANDLERS = PLAIN.replace('<p id="p1">', '<p id="p1" onclick="one()">').replace("<p>Last.</p>", '<p id="p2" onclick="two()">Last.</p>');
const REFUSED = [
  ["two handlers swapped between their elements", HANDLERS, HANDLERS.replace('onclick="one()"', "@").replace('onclick="two()"', 'onclick="one()"').replace("@", 'onclick="two()"'), { op: "set_attribute", name: "onclick", value: "two()" }, "event_handler"],
  ["a script element", PLAIN, after1(PLAIN, "<script>run()</script>"), { op: "insert_html", where: "after", html: "<script>run()</script>" }, "script"],
  ["an event-handler attribute", PLAIN, PLAIN.replace('<p id="p1">', '<p id="p1" onclick="run()">'), { op: "set_attribute", name: "onclick", value: "run()" }, "event_handler"],
  ["a frame", PLAIN, after1(PLAIN, '<iframe src="other.html"></iframe>'), { op: "insert_html", where: "after", html: '<iframe src="other.html"></iframe>' }, "frame"],
  ["a form action", PLAIN, after1(PLAIN, '<form action="https://example.com/send"><button>Send</button></form>'), { op: "insert_html", where: "after", html: '<form action="https://example.com/send"><button>Send</button></form>' }, "form"],
  ["a remote image", PLAIN, after1(PLAIN, '<img src="https://example.com/a.png" alt="a">'), { op: "insert_html", where: "after", html: '<img src="https://example.com/a.png" alt="a">' }, "load_url"],
  ["a stylesheet link", PLAIN, PLAIN.replace("<title>T</title>", '<title>T</title><link rel="stylesheet" href="site.css">'), null, "element"],
  ["a data- attribute", PLAIN, PLAIN.replace('<p id="p1">', '<p id="p1" data-role="x">'), { op: "set_attribute", name: "data-role", value: "x" }, "attribute"],
  ["an edited script body", SCRIPTED, SCRIPTED.replace("var n = 1;", "var n = 2;"), null, "script"],
  ["a script type flip", SCRIPTED, SCRIPTED.replace('type="text/javascript"', 'type="module"'), null, "script"],
  ["a template delimiter in a file that loads a script", SCRIPTED, SCRIPTED.replace("First paragraph.", "First {{ name }}."), { op: "replace_text", find: "paragraph", replace: "{{ name }}" }, "template"],
];
// what a write may add: [name, the markup put after the first paragraph]
const ACCEPTED = [
  ["text", "<p>Plain new text, with an ampersand &amp; a quote.</p>"],
  ["formatting", "<p><b>bold</b> <i>italic</i> <em>em</em> <strong>strong</strong> <code>code</code> <sup>2</sup> <span class=\"note\" style=\"color: #333\">span</span></p>"],
  ["a table", "<table><thead><tr><th>Q</th><th>Total</th></tr></thead><tbody><tr><td>1</td><td colspan=\"1\">12</td></tr></tbody></table>"],
  ["lists", "<ul><li>one</li><li>two</li></ul><ol start=\"3\"><li>three</li></ol><dl><dt>t</dt><dd>d</dd></dl>"],
  ["a local image", '<p><img src="images/chart.png" alt="Chart" width="200"></p>'],
  ["links", '<p><a href="https://example.com/a">https</a> <a href="http://example.com/b">http</a> <a href="mailto:team@example.com">mail</a> <a href="#p1">here</a> <a href="notes.html">notes</a></p>'],
];

// ---- the paths -------------------------------------------------------------------------------------------------------------------
const P1 = { path: "/html[1]/body[1]/p[1]" };
const hashP1 = (src) => H.ownHash(H.byPath(H.readHtml(B(src)), ["html:0", "body:0", "p:0"]));
async function viaOps(base, op) {
  const r = await runOps({ bytes: B(base), format: "html", name: "t.html", ops: [{ ...op, target: P1, expect: { text_hash: hashP1(base) } }] });
  return r.bytes ? { ok: true, bytes: r.bytes, html: r.html } : { ok: false, code: r.results[0].code, reasons: r.results[0].reasons, reason: r.results[0].reason };
}
let n = 0;
/** A session whose batch is delivered, its file then holding `html` (the open gate takes HTML files in Phase 2a; the write path is what is tested). */
async function htmlSession(html) {
  const S = new Sessions();
  const file = path.join(root, `w${++n}.docx`);
  fs.writeFileSync(file, docxBytes(["Paragraph one of the session.", "Paragraph two."]));
  const real = fs.realpathSync(file);
  const s = S.open(real);
  const poll = S.poll(s.key, { holder: "A" });
  S.send(s.key, { baseSha: s.baseSha, comments: [{ id: "c1", kind: "element", text: "fix", anchor: { location: { blockPath: [1] }, paraText: "Paragraph two." } }], note: "" });
  const batch = await poll.promise;
  s.format = "html";
  fs.writeFileSync(real, html);
  s.delivered.knownSha = sha256(B(html)); // what a commit without --base compares against: the version delivered
  return { S, s, file: real, claim: { holder: "A", token: batch.lease.token, batchId: batch.batch_id } };
}
async function viaSession(base, next, { commit = false } = {}) {
  const { S, s, file, claim } = await htmlSession(base);
  try {
    const w = await S.agentWriteChecked(s.key, { baseSha: commit ? null : sha256(B(base)), bytes: B(next), ...(commit ? { label: "before agent commit" } : { route: "apply" }), ...claim });
    return { ok: true, bytes: fs.readFileSync(file), sha: w.sha256 };
  } catch (e) {
    assert.ok(e instanceof HttpError, String(e));
    assert.equal(fs.readFileSync(file).toString(), base, "a refused write left the file as it was");
    return { ok: false, code: e.extra.code, reasons: e.extra.reasons, reason: e.message, status: e.status };
  }
}
async function viaStandaloneCommit(base, next) {
  const file = path.join(root, `c${++n}.html`);
  const cand = path.join(root, `c${n}-copy.html`);
  fs.writeFileSync(file, base);
  fs.writeFileSync(cand, next);
  const server = { healthy: async () => false, req: async () => ({ status: 503, text: "{}" }), json: JSON.parse };
  const { exit, report } = await commitCommand([file, "--from", cand, "--standalone", "--base", sha256(B(base))], server);
  if (exit === 0) return { ok: true, bytes: fs.readFileSync(file) };
  assert.equal(fs.readFileSync(file).toString(), base);
  return { ok: false, code: report.write_error?.code, reasons: report.write_error?.reasons, reason: report.note };
}
const viaCheck = async (base, next) => checkedHtmlWrite(B(base), B(next));
const viaWorker = async (base, next) => htmlWriteOffThread({ before: B(base), after: B(next) });

test("R1 on every write path: each kind of active content refuses the whole write with the one sentence and its reason code", async () => {
  for (const [name, base, next, op, reason] of REFUSED) {
    const paths = { check: viaCheck, worker: viaWorker, "agent-write": viaSession, commit: (b, x) => viaSession(b, x, { commit: true }), "standalone commit": viaStandaloneCommit };
    for (const [where, fn] of Object.entries(paths)) {
      const r = await fn(base, next);
      assert.equal(r.ok, false, `${name} through ${where} was written`);
      assert.equal(r.code, "active_content", `${name} through ${where}: ${JSON.stringify(r)}`);
      assert.ok(r.reasons.includes(reason), `${name} through ${where}: ${r.reasons}`);
      assert.ok(String(r.reason).includes(ACTIVE_REFUSED), `${name} through ${where}: ${r.reason}`);
    }
    if (op) {
      const r = await viaOps(base, op);
      assert.deepEqual([r.ok, r.code, r.reasons?.includes(reason), r.reason], [false, "active_content", true, ACTIVE_REFUSED], `${name} through ops`);
    } else {
      // no op can make it: script and style elements are frozen for ops, and no op adds a link element
      const r = await runOps({ bytes: B(base), format: "html", name: "t.html", ops: [{ op: "insert_html", target: { path: "/html[1]/head[1]/title[1]" }, expect: { quote: "T" }, where: "after", html: '<link rel="stylesheet" href="site.css">' }] });
      assert.equal(r.bytes, null, name);
    }
  }
  // the same template text in a file that loads no script is ordinary text
  assert.equal((await viaCheck(PLAIN, PLAIN.replace("First paragraph.", "First {{ name }}."))).ok, true);
});

test("R1 on every write path: text, formatting, tables, lists, a local image and links are written, and changed link targets are listed for History", async () => {
  for (const [name, html] of ACCEPTED) {
    const next = after1(PLAIN, html);
    for (const [where, fn] of Object.entries({ check: viaCheck, "agent-write": viaSession, commit: (b, x) => viaSession(b, x, { commit: true }), "standalone commit": viaStandaloneCommit })) {
      const r = await fn(PLAIN, next);
      assert.equal(r.ok, true, `${name} through ${where}: ${JSON.stringify(r)}`);
      assert.equal(r.bytes.toString(), next, `${name} through ${where}: the bytes as sent`);
    }
    const o = await viaOps(PLAIN, { op: "insert_html", where: "after", html });
    assert.equal(o.ok, true, `${name} through ops: ${JSON.stringify(o)}`);
    assert.equal(o.bytes.toString(), next);
  }
  const links = (await viaCheck(PLAIN, after1(PLAIN, ACCEPTED[5][1]))).links;
  assert.deepEqual(links.added.map((l) => l.url).sort(), ["#p1", "http://example.com/b", "https://example.com/a", "mailto:team@example.com", "notes.html"]);
  const moved = await viaCheck(after1(PLAIN, '<a href="https://example.com/old">x</a>'), after1(PLAIN, '<a href="https://example.com/new">x</a>'));
  assert.deepEqual([moved.ok, moved.links.removed.map((l) => l.url), moved.links.added.map((l) => l.url)], [true, ["https://example.com/old"], ["https://example.com/new"]]);
  const o = await viaOps(PLAIN, { op: "insert_html", where: "after", html: '<p><a href="https://example.com/x">x</a></p>' });
  assert.deepEqual(o.html.links.added.map((l) => l.url), ["https://example.com/x"]);
});

test("R12: a file changed underneath while the worker checked is not overwritten (the compare-and-swap runs again after the await)", async () => {
  const next = after1(PLAIN, "<p>Agent text.</p>");
  const underneath = after1(PLAIN, "<p>Someone else saved this.</p>");
  for (const base of ["the delivered version", "the version found underneath"]) {
    const { S, s, file, claim } = await htmlSession(PLAIN);
    const w = S.agentWriteChecked(s.key, { baseSha: base === "the delivered version" ? sha256(B(PLAIN)) : sha256(B(underneath)), bytes: B(next), route: "apply", ...claim });
    fs.writeFileSync(file, underneath); // the check runs in its worker now; this lands before the write
    await assert.rejects(w, (e) => e instanceof HttpError && e.status === 409 && e.extra.code === "conflict", base);
    assert.equal(fs.readFileSync(file).toString(), underneath, `${base}: not overwritten`);
  }
  // and the guarded write itself refuses HTML bytes that did not come through the check, whatever path calls it
  const { S, s, file, claim } = await htmlSession(PLAIN);
  assert.throws(() => S.agentWrite(s.key, { baseSha: sha256(B(PLAIN)), bytes: B(next), ...claim }), (e) => e instanceof HttpError && e.extra.code === "unchecked_write");
  assert.throws(() => S.agentWrite(s.key, { baseSha: sha256(B(PLAIN)), bytes: B(next), ...claim, htmlChecked: { from: sha256(B(PLAIN)), to: sha256(B(PLAIN)) } }), (e) => e.extra.code === "unchecked_write", "a check of other bytes is no check of these");
  assert.equal(fs.readFileSync(file).toString(), PLAIN);
  // a write the session refuses before any work costs no worker: the lease is checked first
  await assert.rejects(S.agentWriteChecked(s.key, { baseSha: sha256(B(PLAIN)), bytes: B(next), ...claim, holder: "B" }), (e) => e.extra.code === "not_lease_holder");
  const ok = await S.agentWriteChecked(s.key, { baseSha: sha256(B(PLAIN)), bytes: B(next), route: "apply", ...claim });
  assert.equal(ok.sha256, sha256(B(next)));
  assert.equal(fs.readFileSync(file).toString(), next);
});

// The outside review of 4d2b2fc (apply.js:429): a standalone commit checked the candidate against the bytes on disk, and its
// compare-and-swap compared against --base; a disk that differed from the base during the check and was put back before the write let a
// change the base forbids through. The check now runs only on bytes whose hash is the base, and the session's paths are held to the same.
test("the write check runs against exactly the bytes whose hash the compare-and-swap uses: a file swapped during the check never lets a forbidden change through", async () => {
  const base = page("<p>A</p>");
  const transient = page("<p>A</p>\n<script>x()</script>");
  const candidate = page("<p>A, edited</p>\n<script>x()</script>"); // no change to the script against `transient`; a new script against `base`
  const server = { healthy: async () => false, req: async () => ({ status: 503, text: "{}" }), json: JSON.parse };
  // standalone commit: the disk is `transient` when the commit starts and the base is put back while the worker checks
  let file = path.join(root, `swap${++n}.html`);
  let cand = path.join(root, `swap${n}-copy.html`);
  fs.writeFileSync(file, transient);
  fs.writeFileSync(cand, candidate);
  let calls = 0;
  const restoreDuringCheck = (f) => async (job) => {
    calls++;
    fs.writeFileSync(f, base);
    return htmlWriteOffThread(job);
  };
  let r = await commitCommand([file, "--from", cand, "--standalone", "--base", sha256(B(base))], server, { check: restoreDuringCheck(file) });
  assert.notEqual(r.exit, 0, JSON.stringify(r.report));
  assert.equal(r.report.written, false);
  assert.equal(r.report.status, "outside_change");
  assert.equal(calls, 0, "refused before any check: the disk is not the base");
  assert.notEqual(fs.readFileSync(file).toString(), candidate, "the candidate's script never reached the file");
  // the other way round: the disk is the base at the check, swapped during it and left so: the compare-and-swap after the await refuses
  file = path.join(root, `swap${++n}.html`);
  cand = path.join(root, `swap${n}-copy.html`);
  fs.writeFileSync(file, base);
  fs.writeFileSync(cand, page("<p>A, edited</p>"));
  r = await commitCommand([file, "--from", cand, "--standalone", "--base", sha256(B(base))], server, {
    check: async (job) => {
      fs.writeFileSync(file, transient);
      return htmlWriteOffThread(job);
    },
  });
  assert.equal(r.report.written, false);
  assert.equal(fs.readFileSync(file).toString(), transient, "not overwritten");
  // and with the disk the base throughout, written
  file = path.join(root, `swap${++n}.html`);
  cand = path.join(root, `swap${n}-copy.html`);
  fs.writeFileSync(file, base);
  fs.writeFileSync(cand, page("<p>A, edited</p>"));
  r = await commitCommand([file, "--from", cand, "--standalone", "--base", sha256(B(base))], server, { check: async (job) => htmlWriteOffThread(job) });
  assert.equal(r.exit, 0, JSON.stringify(r.report));
  assert.equal(fs.readFileSync(file).toString(), page("<p>A, edited</p>"));
  // the session (agent-write and commit): the disk is `transient` at the check and the base is put back during it; refused either way
  for (const commit of [false, true]) {
    const { S, s, file: f, claim } = await htmlSession(transient);
    if (commit) s.delivered.knownSha = sha256(B(base)); // a commit without --base compares against the version the server delivered
    calls = 0;
    await assert.rejects(
      S.agentWriteChecked(s.key, { baseSha: commit ? null : sha256(B(base)), bytes: B(candidate), ...(commit ? { label: "before agent commit" } : { route: "apply" }), ...claim }, restoreDuringCheck(f)),
      (e) => e instanceof HttpError && e.status === 409 && e.extra.code === "conflict",
      commit ? "commit" : "agent-write",
    );
    assert.equal(fs.readFileSync(f).toString(), base, `${commit ? "commit" : "agent-write"}: not written`);
  }
});

test("R10: the first non-ASCII write to a file that declares no charset also declares UTF-8 as head's first child; never twice, never when declared", async () => {
  const bare = "<!doctype html>\n<html>\n<head>\n<title>T</title>\n</head>\n<body>\n<p>Cafe</p>\n</body>\n</html>\n";
  const r = checkedHtmlWrite(B(bare), B(bare.replace("Cafe", "Café")));
  assert.equal(r.ok, true);
  assert.equal(r.charset_added, true);
  assert.equal(r.bytes.toString(), bare.replace("<head>", `<head>${CHARSET_META}`).replace("Cafe", "Café"));
  assert.equal(H.decodeHtml(r.bytes).declared, "utf-8");
  // the next write sees the declaration
  const r2 = checkedHtmlWrite(r.bytes, B(r.bytes.toString().replace("Café", "Crème")));
  assert.deepEqual([r2.ok, r2.charset_added], [true, false]);
  // through an op: the driver's output carries it, and the server's check of those bytes adds nothing more
  const o = await runOps({ bytes: B(bare), format: "html", name: "t.html", ops: [{ op: "set_text", target: { path: "/html[1]/body[1]/p[1]" }, expect: { quote: "Cafe" }, text: "Café" }] });
  assert.equal(o.bytes.toString(), r.bytes.toString());
  assert.equal(o.html.charset_added, true);
  assert.equal(checkedHtmlWrite(B(bare), o.bytes).charset_added, false);
  // declared already, a BOM, or non-ASCII text before: nothing added
  const declared = bare.replace("<head>", '<head><meta charset="utf-8">');
  assert.equal(checkedHtmlWrite(B(declared), B(declared.replace("Cafe", "Café"))).charset_added, false);
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), B(bare)]);
  assert.equal(checkedHtmlWrite(bom, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), B(bare.replace("Cafe", "Café"))])).charset_added, false);
  const already = bare.replace("Cafe", "Déjà");
  assert.equal(checkedHtmlWrite(B(already), B(already.replace("Déjà", "Déjà vu ☕"))).charset_added, false);
  // no head start tag: right after the html start tag, else at the very start, when that insertion proves
  const noHead = "<!doctype html><html><title>T</title><p>Cafe</p></html>";
  assert.equal(checkedHtmlWrite(B(noHead), B(noHead.replace("Cafe", "Café"))).bytes.toString(), `<!doctype html><html>${CHARSET_META}<title>T</title><p>Café</p></html>`);
  const fragmentOnly = "<p>Cafe</p>";
  assert.equal(checkedHtmlWrite(B(fragmentOnly), B("<p>Café</p>")).bytes.toString(), `${CHARSET_META}<p>Café</p>`);
  // no clean place: a comment first would move into head; a head past the first 1,024 bytes would not be seen by a browser
  const comment = "<!-- generated --><p>Cafe</p>";
  const c = checkedHtmlWrite(B(comment), B("<!-- generated --><p>Café</p>"));
  assert.deepEqual([c.ok, c.code], [false, "charset_needs_head"]);
  assert.match(c.reason, /character references/);
  const late = `<!doctype html><!-- ${"x".repeat(1100)} --><html><head><title>T</title></head><body><p>Cafe</p></body></html>`;
  assert.equal(checkedHtmlWrite(B(late), B(late.replace("Cafe", "Café"))).code, "charset_needs_head");
  // the op path says so to the agent
  const lo = await runOps({ bytes: B(comment), format: "html", name: "t.html", ops: [{ op: "set_text", target: { path: "/html[1]/body[1]/p[1]" }, expect: { quote: "Cafe" }, text: "Café" }] });
  assert.deepEqual([lo.bytes, lo.results[0].status, lo.results[0].code], [null, "refused", "charset_needs_head"]);
  // a plain ASCII write needs nothing
  assert.deepEqual([checkedHtmlWrite(B(comment), B("<!-- generated --><p>Cafe!</p>")).ok], [true]);
});

test("the person's own text edits (exported for Phase 2a): one source text each, proven, escaped, active content and charset as every write", () => {
  const src = page('<p>Second &amp; last.</p>\n<button id="b">Press</button>');
  const r = H.readHtml(B(src));
  const t = (v) => r.nodes.find((x) => x.nodeName === "#text" && x.value === v).__id;
  const ok = checkedHtmlWrite(B(src), null, { read: r, edits: [{ nodeId: t("First paragraph."), text: "First <changed> paragraph." }, { nodeId: t("Second & last."), text: "Second & final." }] });
  assert.equal(ok.ok, true);
  assert.equal(ok.bytes.toString(), src.replace("First paragraph.", "First &lt;changed&gt; paragraph.").replace("Second &amp; last.", "Second &amp; final."));
  // the bytes, when given, must be exactly the edits applied
  assert.equal(checkedHtmlWrite(B(src), ok.bytes, { read: r, edits: [{ nodeId: t("First paragraph."), text: "First <changed> paragraph." }, { nodeId: t("Second & last."), text: "Second & final." }] }).ok, true);
  assert.equal(checkedHtmlWrite(B(src), B(src), { read: r, edits: [{ nodeId: t("First paragraph."), text: "x" }] }).code, "edits_mismatch");
  // the text of a form control is the body of an element R1 does not allow: changing it is refused like adding one
  const btn = checkedHtmlWrite(B(src), null, { read: r, edits: [{ nodeId: t("Press"), text: "Go" }] });
  assert.deepEqual([btn.ok, btn.code, btn.reasons], [false, "active_content", ["form"]]);
  const scripted = H.readHtml(B(SCRIPTED));
  const tpl = checkedHtmlWrite(B(SCRIPTED), null, { read: scripted, edits: [{ nodeId: scripted.nodes.find((x) => x.value === "Last.").__id, text: "Hello {{ name }}" }] });
  assert.deepEqual([tpl.ok, tpl.reasons], [false, ["template"]]);
  assert.equal(checkedHtmlWrite(B(src), null, { read: r, edits: [{ nodeId: 0, text: "x" }] }).code, "not_addressable");
  assert.equal(checkedHtmlWrite(B(src), null, { read: r, edits: [{ nodeId: t("Press"), text: "a" }, { nodeId: t("Press"), text: "b" }] }).code, "overlapping_edit");
});

test("a whole new version that is not UTF-8, is past a limit, or replaces an unreadable file is refused with a plain code", async () => {
  assert.equal(checkedHtmlWrite(B(PLAIN), Buffer.concat([B("<p>caf"), Buffer.from([0xe9]), B("</p>")])).code, "not_utf8");
  assert.equal(checkedHtmlWrite(B(PLAIN), B(`<p>${"<br>".repeat(200_001)}`)).code, "too_large");
  assert.equal(checkedHtmlWrite(Buffer.from([0xff, 0xfe, 0x3c, 0x00]), B(PLAIN)).code, "before_unreadable");
  const s = await viaSession(PLAIN, `<p>${"<br>".repeat(200_001)}`);
  assert.deepEqual([s.ok, s.code, s.status], [false, "too_large", 422]);
});

test("apply on an .html file (standalone): a good op is written through the driver's checked bytes, a script op exits 3 with the file untouched, a dry run writes nothing", async () => {
  const server = { healthy: async () => false, req: async () => ({ status: 503, text: "{}" }), json: JSON.parse };
  const file = path.join(root, `apply${++n}.html`);
  fs.writeFileSync(file, PLAIN);
  const opsFile = (ops) => {
    const f = path.join(root, `ops${++n}.json`);
    fs.writeFileSync(f, JSON.stringify({ schema: "onionskin.ops/1", ops }));
    return f;
  };
  const e = { quote: "First paragraph" };
  const dry = await applyCommand([file, "--ops", opsFile([{ op: "replace_text", target: P1, expect: e, find: "First", replace: "Opening" }]), "--dry-run"], server);
  assert.deepEqual([dry.exit, dry.report.written, dry.report.would_write], [0, false, true]);
  assert.equal(fs.readFileSync(file, "utf8"), PLAIN);
  const bad = await applyCommand([file, "--ops", opsFile([{ op: "insert_html", target: P1, expect: e, where: "after", html: "<script>run()</script>" }]), "--standalone"], server);
  assert.deepEqual([bad.exit, bad.report.written, bad.report.results[0].code, bad.report.results[0].reasons], [3, false, "active_content", ["script"]]);
  assert.equal(fs.readFileSync(file, "utf8"), PLAIN);
  const good = await applyCommand([file, "--ops", opsFile([{ op: "replace_text", target: P1, expect: e, find: "First", replace: "Opening" }]), "--standalone"], server);
  assert.deepEqual([good.exit, good.report.written, good.report.format], [0, true, "html"]);
  assert.equal(fs.readFileSync(file, "utf8"), PLAIN.replace("First paragraph.", "Opening paragraph."));
  assert.equal(good.report.new_sha256, sha256(fs.readFileSync(file)));
});
