// Two unconfirmed security findings, checked by running them (real server in-process, synthetic files in a temp dir, a temp state dir).
//
// Finding 1 (symlink swap after open): open() checks the file is a regular file the user owns, but most later reads go through
// readCapped -> readDoc (fs.statSync + fs.readFileSync), which follow a symbolic link. A document replaced by a link after it was opened
// would then be read as the link's target. Each read path gets its own fresh document, so one probe's side effects (a stored snapshot, a
// moved history tip) never change what the next one measures. The correct behavior asserted: the target's bytes are never returned to the
// page or the agent, never stored as a version, and the session's idea of the file (histTip, baseSha) does not move to them.
//
// Finding 2 (one launch credential covers every open document): BrowserAuth.check (src/auth.js) checks the cookie and a token minted for
// that cookie, and only then does the route pick the session by `?s=<key>` (src/server.js). The test records what a credential from
// launching A is allowed to do to B. Whether that is by design is answered in the report; the test documents the behavior and its controls.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { docxBytes, tmpdir } from "./helpers/zipbuild.js";

const root = tmpdir("osk-sec10-");
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE = path.join(root, "st");
process.env.ONIONSKIN_STATE_DIR = STATE;
process.env.ONIONSKIN_WEB_DIST = path.join(root, "dist");
process.env.ONIONSKIN_TICK_MS = "100000";
process.env.ONIONSKIN_LEASE_MS = "60000";
process.env.ONIONSKIN_NO_SOFFICE = "1";
process.env.ONIONSKIN_AGENT_CLI = "none"; // never start a real agent
delete process.env.ONIONSKIN_PYTHON;
fs.mkdirSync(process.env.ONIONSKIN_WEB_DIST);
fs.writeFileSync(path.join(process.env.ONIONSKIN_WEB_DIST, "index.html"), "<!doctype html><title>t</title>");
const { startServer } = await import("../src/server.js");
const { socketPath } = await import("../src/paths.js");
const { sha256 } = await import("../src/fsutil.js");
const { decodeHtmlView } = await import("../src/html-envelope.js");
const { bgHolder } = await import("../src/agent-detect.js");
const { analyzeOffThread } = await import("../src/offload.js");
const { MAX_DOC_BYTES } = await import("../src/constants.js");

const SAMPLE_HTML = fs.readFileSync(new URL("./fixtures/sample/sample.html", import.meta.url));
const MARKER = "Zanzibar quokka marker";
const DOC_PARAS = ["Ordinary first paragraph of the document", "Ordinary second paragraph"];
const TARGET_PARAS = [`${MARKER} private paragraph one`, `${MARKER} private paragraph two`];

let srv;
let cookie = "";
let seq = 0;

function req(opts, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port: srv.port, ...opts }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks), text: Buffer.concat(chunks).toString() }));
    });
    r.on("error", reject);
    if (body) r.write(body);
    r.end();
  });
}
/** The event stream never ends: resolve on the status and the first chunk, then drop the connection. */
function sseFirst(pathQ, headers) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port: srv.port, path: pathQ, method: "GET", headers }, (res) => {
      if (res.statusCode !== 200) {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() }));
        return;
      }
      res.once("data", (c) => {
        resolve({ status: res.statusCode, text: c.toString() });
        r.destroy();
      });
    });
    r.on("error", (e) => (e.code === "ECONNRESET" ? null : reject(e)));
    r.end();
  });
}
const viaSocket = (method, p, body) =>
  new Promise((resolve, reject) => {
    const r = http.request({ socketPath: socketPath(), method, path: p, headers: body ? { "content-type": "application/json" } : {} }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString() || "{}") }));
    });
    r.on("error", reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });

/** Exchanges a launch URL's nonce the way the browser does; keeps one cookie (one browser), returns that launch's token. */
async function exchange(url) {
  const u = new URL(url);
  const first = await req({ path: u.pathname + u.search, method: "GET", headers: cookie ? { cookie } : {} });
  assert.equal(first.status, 200, first.text);
  const set = first.headers["set-cookie"]?.[0];
  if (set) cookie = set.split(";")[0];
  const token = /<meta name="onionskin-launch" content="([\w-]+)">/.exec(first.text)?.[1];
  assert.ok(token, "the launch page carries a token");
  return token;
}
/** Opens `file` through the CLI socket (the way `onionskin open` does) and launches it: {key, token}. */
async function launch(file) {
  const o = await viaSocket("POST", "/cli/open", { file });
  assert.equal(o.status, 200, JSON.stringify(o.json));
  return { key: o.json.key, token: await exchange(o.json.url) };
}
const hdr = (token, extra = {}) => ({ cookie, "x-onionskin-token": token, origin: `http://127.0.0.1:${srv.port}`, "sec-fetch-site": "same-origin", "content-type": "application/json", ...extra });
const get = (token, p) => req({ path: p, method: "GET", headers: hdr(token) });
const post = (token, p, body) => req({ path: p, method: "POST", headers: hdr(token) }, JSON.stringify(body));

/** A fresh document `<n>.docx` and, next to it, the target the swap will point at (a valid DOCX holding MARKER). */
function docPair(ext = "docx") {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(root, `d${++seq}-`)));
  const file = path.join(dir, `doc.${ext}`);
  const target = path.join(dir, `private.${ext}`);
  if (ext === "docx") {
    fs.writeFileSync(file, docxBytes(DOC_PARAS));
    fs.writeFileSync(target, docxBytes(TARGET_PARAS));
  } else {
    fs.writeFileSync(file, SAMPLE_HTML);
    const t = SAMPLE_HTML.toString().replace("Onion sets", MARKER);
    assert.notEqual(t, SAMPLE_HTML.toString(), "the HTML target differs from the document");
    fs.writeFileSync(target, t);
  }
  return { file, target, docSha: sha256(fs.readFileSync(file)), targetSha: sha256(fs.readFileSync(target)) };
}
/** Replaces `file` with a symbolic link to `target` (what the finding describes: an open document swapped for a link). */
function swap(file, target) {
  fs.rmSync(file);
  fs.symlinkSync(target, file);
  assert.ok(fs.lstatSync(file).isSymbolicLink());
}
/** The target never became a version of the session, and the session's file identity did not move to it. */
function notStored(s, targetSha, what) {
  assert.equal(s.snapshots.has(targetSha), false, `${what}: the link target's bytes must not be stored as a snapshot of this document`);
  assert.notEqual(s.histTip, targetSha, `${what}: history must not move to the link target`);
  assert.notEqual(s.baseSha, targetSha, `${what}: the base must not move to the link target`);
}

before(async () => {
  srv = await startServer();
});
after(() => {
  srv?.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Finding 1
// ---------------------------------------------------------------------------------------------------------------------------------

test("finding 1, comparison: open() on a symbolic link resolves it (realpath) and opens the real file under the real file's key; it does not refuse", async () => {
  const { file, target, targetSha } = docPair();
  const link = path.join(path.dirname(file), "link.docx");
  fs.symlinkSync(target, link);
  const viaLink = await viaSocket("POST", "/cli/open", { file: link });
  assert.equal(viaLink.status, 200, JSON.stringify(viaLink.json));
  const s = srv.sessions.get(viaLink.json.key);
  assert.equal(s.file, target, "the session is the target's own, by its real path");
  assert.equal(s.baseSha, targetSha);
  const direct = await viaSocket("POST", "/cli/open", { file: target });
  assert.equal(direct.json.key, viaLink.json.key, "the same session as opening the target directly");
});

test("finding 1: GET /api/file after the document is swapped for a link must not return the link target's bytes or store them", async () => {
  const { file, target, docSha, targetSha } = docPair();
  const { key, token } = await launch(file);
  const s = srv.sessions.get(key);
  const pre = await get(token, `/api/file?s=${key}`);
  assert.equal(pre.status, 200, "control: the route answers before the swap");
  assert.equal(sha256(pre.buf), docSha, "control: the document's own bytes");
  swap(file, target);
  const r = await get(token, `/api/file?s=${key}`);
  assert.notEqual(r.status === 200 && sha256(r.buf) === targetSha, true, `GET /api/file returned the link target's bytes (status ${r.status}, X-Sha256 ${r.headers["x-sha256"]})`);
  notStored(s, targetSha, "GET /api/file");
});

test("finding 1: GET /api/history after a swapped /api/file must not show the link target's text", async () => {
  const { file, target } = docPair();
  const { key, token } = await launch(file);
  assert.equal((await get(token, `/api/file?s=${key}`)).status, 200, "control");
  swap(file, target);
  await get(token, `/api/file?s=${key}`);
  const list = await get(token, `/api/history?s=${key}`);
  assert.equal(list.status, 200, list.text);
  const texts = [list.text];
  for (const u of JSON.parse(list.text).updates || []) texts.push((await get(token, `/api/history/${encodeURIComponent(u.id)}?s=${key}`)).text);
  assert.equal(texts.some((t) => t.includes(MARKER)), false, `History shows the link target's text: ${texts.find((t) => t.includes(MARKER))?.slice(0, 300)}`);
});

test("finding 1: GET /api/html-view after an HTML document is swapped for a link must not render the link target", async () => {
  const { file, target, docSha, targetSha } = docPair("html");
  const { key, token } = await launch(file);
  const s = srv.sessions.get(key);
  const pre = await get(token, `/api/html-view?s=${key}`);
  assert.equal(pre.status, 200, `control: ${pre.text.slice(0, 200)}`);
  assert.equal(pre.headers["x-sha256"], docSha);
  swap(file, target);
  const r = await get(token, `/api/html-view?s=${key}`);
  let rendered = "";
  if (r.status === 200) rendered = Buffer.from(decodeHtmlView(r.buf).copy).toString();
  assert.equal(r.status === 200 && (r.headers["x-sha256"] === targetSha || rendered.includes(MARKER)), false, `GET /api/html-view rendered the link target (status ${r.status}, X-Sha256 ${r.headers["x-sha256"]})`);
  notStored(s, targetSha, "GET /api/html-view");
});

test("finding 1: the agent's end of run (done) after a swap must not take the link target as the run's result", async (t) => {
  const { file, target, targetSha } = docPair();
  const s = srv.sessions.open(file);
  const poll = srv.sessions.poll(s.key, { holder: "agent" });
  srv.sessions.send(s.key, { baseSha: s.baseSha, comments: [{ id: "c1", kind: "element", text: "tighten this", anchor: { location: { blockPath: [0] }, paraText: DOC_PARAS[0] } }], note: "" });
  const batch = await poll.promise;
  const claim = { holder: batch.lease.holder, token: batch.lease.token, batchId: batch.batch_id };
  swap(file, target);
  let inputs = null;
  try {
    inputs = srv.sessions.analysisInputs(s.key, claim);
  } catch {}
  const analysedTarget = !!inputs && inputs.postSha === targetSha;
  // as the server's finishRun does it: the checks off the thread, then done
  let out = null;
  let doneErr = null;
  try {
    const analysis = inputs ? await analyzeOffThread(inputs) : null;
    out = await srv.sessions.doneAsync(s.key, { summary: "done", results: [{ comment_id: "c1", status: "done", note: "ok" }] }, claim, analysis, { inline: false });
  } catch (err) {
    doneErr = err;
  }
  const entry = s.activity.find((a) => a.kind === "agent" && a.batchId === batch.batch_id);
  const toAgent = JSON.stringify(out) || "";
  t.diagnostic(`done after the swap: ${doneErr ? `threw ${doneErr.status} ${doneErr.message}` : "completed"}; analysis read the target: ${analysedTarget}; entry postSha is the target: ${entry?.postSha === targetSha}; flags ${JSON.stringify(entry?.flags?.map((f) => f.code))}; done's answer to the agent holds the target's text: ${toAgent.includes(MARKER)}`);
  // whatever done did, a Revert never writes through the link: the target is untouched (run before the finding's assertions, so it always runs)
  let revertErr = null;
  if (entry) {
    try {
      await srv.sessions.revertAsync(s.key, entry.id);
    } catch (err) {
      revertErr = err;
    }
  }
  t.diagnostic(`Revert of that run: ${entry ? (revertErr ? `refused ${revertErr.status} (${revertErr.extra?.code ?? ""})` : "completed") : "no entry"}`);
  assert.equal(sha256(fs.readFileSync(target)), targetSha, "the link target was never written");
  assert.equal(toAgent.includes(MARKER), false, "done's answer to the agent carries the link target's text");
  assert.equal(analysedTarget, false, "done's checks were handed the link target's bytes as the run's result");
  assert.notEqual(entry?.postSha, targetSha, "done recorded the link target as the run's result");
  notStored(s, targetSha, "done");
});

test("finding 1: Take back of a delivered run after a swap must not record the link target as the agent's partial write", async () => {
  const { file, target, targetSha } = docPair();
  const s = srv.sessions.open(file);
  const poll = srv.sessions.poll(s.key, { holder: "agent" });
  srv.sessions.send(s.key, { baseSha: s.baseSha, comments: [{ id: "c1", kind: "element", text: "tighten this", anchor: { location: { blockPath: [0] }, paraText: DOC_PARAS[0] } }], note: "" });
  await poll.promise;
  swap(file, target);
  try {
    srv.sessions.takeBack(s.key);
  } catch {}
  notStored(s, targetSha, "Take back");
});

test("finding 1, paths that return no bytes (recorded): stale check and resolve return no bytes (they answer 409 since the fix); a Send and the agent's outline refuse the link", async (t) => {
  const { file, target, targetSha } = docPair();
  const { key, token } = await launch(file);
  const s = srv.sessions.get(key);
  // a Send made before the swap waits for an agent; the agent's poll after the swap delivers it
  srv.sessions.send(key, { baseSha: s.baseSha, comments: [{ id: "c8", kind: "element", text: "x", anchor: { location: { blockPath: [0] }, paraText: DOC_PARAS[0] } }], note: "" });
  swap(file, target);
  const delivered = await srv.sessions.poll(key, { holder: bgHolder(key) }).promise;
  t.diagnostic(`agent poll after the swap: outline_unavailable=${JSON.stringify(delivered.untrusted_document_evidence?.outline_unavailable)}`);
  assert.equal(JSON.stringify(delivered).includes(MARKER), false, "the delivered batch carries none of the target's text");
  srv.sessions.takeBack(key); // ends the delivery (its own snapshot side effect is the Take back test's subject, not this one's)
  const stale = await get(token, `/api/stale?s=${key}&sha=${s.baseSha}`);
  t.diagnostic(`/api/stale after the swap: ${stale.status} diskSha is the target's hash: ${JSON.parse(stale.text).diskSha === targetSha}`);
  assert.equal(stale.text.includes(MARKER), false);
  const refusal = { error: `cannot read the file: ${file} is a symbolic link`, code: "gone" };
  assert.equal(stale.status, 409, stale.text);
  assert.deepEqual(JSON.parse(stale.text), refusal, "the stale check refuses the link (no hash of the target)");
  const resolve = await post(token, `/api/resolve?s=${key}`, {});
  t.diagnostic(`/api/resolve after the swap: ${resolve.status} baseSha is the target's hash: ${resolve.status === 200 && JSON.parse(resolve.text).baseSha === targetSha}`);
  assert.equal(resolve.text.includes(MARKER), false);
  assert.equal(resolve.status, 409, resolve.text);
  assert.deepEqual(JSON.parse(resolve.text), refusal, "resolve refuses the link (no hash of the target)");
  assert.equal(sha256(fs.readFileSync(target)), targetSha, "the link target was never written");
  // a Send made after the swap, on a document of its own
  const two = docPair();
  const s2 = srv.sessions.open(two.file);
  swap(two.file, two.target);
  let sendErr = null;
  try {
    await srv.sessions.sendAsync(s2.key, { baseSha: s2.baseSha, comments: [{ id: "c9", kind: "element", text: "x", anchor: { location: { blockPath: [0] }, paraText: DOC_PARAS[0] } }], note: "" });
  } catch (err) {
    sendErr = err;
  }
  t.diagnostic(`Send after the swap: ${sendErr ? `refused ${sendErr.status} (${sendErr.extra?.code ?? ""}) symbolic link named: ${/symbolic link/.test(sendErr.message)}` : "accepted"}`);
  assert.ok(sendErr, "a Send after the swap is refused");
  assert.equal(sha256(fs.readFileSync(two.target)), two.targetSha, "the link target was never written");
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Finding 2
// ---------------------------------------------------------------------------------------------------------------------------------

// A documented limit (the cookie and launch token row of the security table): a launch token is per browser and server, not per document.
test("finding 2, documented limit: a credential from launching A is honored for B's key (read, write, event stream); controls refuse a wrong token, no cookie, an unknown key and a cross-site request", async (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(root, "two-")));
  const fa = path.join(dir, "a.docx");
  const fb = path.join(dir, "b.docx");
  fs.writeFileSync(fa, docxBytes(["Alpha paragraph"]));
  fs.writeFileSync(fb, docxBytes(["Bravo paragraph"]));
  const A = await launch(fa); // only A is launched; B is opened (it is "another known open key") but its nonce is never exchanged
  const ob = await viaSocket("POST", "/cli/open", { file: fb });
  const B = ob.json.key;
  const B_NOTE = "Bravo private note canary";
  srv.sessions.setDraft(B, { comments: [], note: B_NOTE });
  const tok = A.token;

  // controls: what "allowed" is measured against
  assert.equal((await get("x".repeat(43), `/api/bootstrap?s=${B}`)).status, 401, "control: a wrong token is refused");
  assert.equal((await req({ path: `/api/bootstrap?s=${B}`, method: "GET", headers: { "x-onionskin-token": tok, "sec-fetch-site": "same-origin" } })).status, 401, "control: no cookie is refused");
  assert.equal((await get(tok, `/api/bootstrap?s=0000000000000000`)).status, 404, "control: an unknown key is not found");
  assert.equal((await req({ path: `/api/bootstrap?s=${B}`, method: "GET", headers: { ...hdr(tok), origin: "http://evil.example", "sec-fetch-site": "cross-site" } })).status, 403, "control: a cross-site request is refused");
  assert.equal((await get(tok, `/api/bootstrap?s=${A.key}`)).status, 200, "control: A's own key");

  // what A's credential may do to B
  const boot = await get(tok, `/api/bootstrap?s=${B}`);
  const file = await get(tok, `/api/file?s=${B}`);
  const draft = await post(tok, `/api/draft?s=${B}`, { comments: [], note: "written with A's credential" });
  const ev = await sseFirst(`/api/events?s=${B}&tab=tsec10tab&t=${encodeURIComponent(tok)}`, { cookie, "sec-fetch-site": "same-origin" });
  t.diagnostic(`with A's credential on B: bootstrap ${boot.status} (B's note visible: ${boot.text.includes(B_NOTE)}), file ${file.status} (B's bytes: ${sha256(file.buf) === sha256(fs.readFileSync(fb))}), draft write ${draft.status} (stored: ${srv.sessions.get(B).note === "written with A's credential"}), events ${ev.status}`);
  // the documented limit: the credential is per browser for this server, not per document
  assert.equal(boot.status, 200);
  assert.ok(boot.text.includes(B_NOTE), "B's session view is readable");
  assert.equal(file.status, 200);
  assert.equal(draft.status, 200);
  assert.equal(ev.status, 200);
});

test("finding 2, evidence for the report (not an assertion of the finding): `onionskin open` run by an agent bound to A, on another file B", async (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(root, "bound-")));
  const fa = path.join(dir, "a.docx");
  const fb = path.join(dir, "b.docx");
  fs.writeFileSync(fa, docxBytes(["Alpha paragraph"]));
  fs.writeFileSync(fb, docxBytes(["Bravo paragraph"]));
  const a = await viaSocket("POST", "/cli/open", { file: fa });
  const holder = bgHolder(a.json.key);
  const run = (args) =>
    new Promise((resolve) => {
      const c = spawn(process.execPath, [path.join(repo, "src", "cli.js"), ...args], { env: { PATH: process.env.PATH, HOME: root, ONIONSKIN_STATE_DIR: STATE, ONIONSKIN_NO_SOFFICE: "1", ONIONSKIN_AGENT_CLI: "none", ONIONSKIN_HOLDER: holder }, stdio: ["ignore", "pipe", "pipe"] });
      let all = "";
      c.stdout.on("data", (d) => (all += d));
      c.stderr.on("data", (d) => (all += d));
      c.on("close", (code) => resolve({ code, all }));
    });
  const ob = await viaSocket("POST", "/cli/open", { file: fb });
  const bKey = ob.json.key;
  const LINK = /http:\/\/127\.0\.0\.1:\d+\/\?s=[0-9a-f]+&n=[\w-]+/;
  // control: the binding does refuse `status` on B
  const status = await run(["status", fb]);
  assert.notEqual(status.code, 0, `control: status on B is refused: ${status.all}`);
  assert.ok(status.all.includes("This agent works only on the file"), "control: the not-your-file words");
  // (a) `open` on B: refused since the fix (no link)
  const openB = await run(["open", fb, "--no-open", "--no-agent"]);
  const urlB = LINK.exec(openB.all)?.[0] || "";
  t.diagnostic(`bound agent: open on B exit ${openB.code}, printed a launch link for B: ${!!urlB}`);
  if (urlB) t.diagnostic(`(a) B's own link exchanged: bootstrap of B ${(await get(await exchange(urlB), `/api/bootstrap?s=${bKey}`)).status}`);
  // (b) `open` on its own file A, whose link is then used for B: the chain finding 2 itself enables
  const openA = await run(["open", fa, "--no-open", "--no-agent"]);
  const urlA = LINK.exec(openA.all)?.[0] || "";
  t.diagnostic(`bound agent: open on its own A exit ${openA.code}, printed a launch link for A: ${!!urlA}`);
  if (urlA) t.diagnostic(`(b) A's link exchanged, used on B: bootstrap of B ${(await get(await exchange(urlA), `/api/bootstrap?s=${bKey}`)).status}`);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Same as before: the one reader (src/fsutil.js readOwned) reads ordinary documents exactly as readDoc did
// ---------------------------------------------------------------------------------------------------------------------------------

test("same as before: a regular file is read as it is (/api/file, the stale check, an agent's run and done)", async () => {
  const { file, docSha } = docPair();
  const { key, token } = await launch(file);
  const r = await get(token, `/api/file?s=${key}`);
  assert.equal(r.status, 200);
  assert.equal(sha256(r.buf), docSha);
  assert.equal(r.headers["x-sha256"], docSha);
  const stale = await get(token, `/api/stale?s=${key}&sha=${docSha}`);
  assert.equal(stale.status, 200);
  assert.deepEqual(JSON.parse(stale.text), { stale: false, diskSha: docSha });
  // a normal run: the agent writes through Onionskin, then done records its bytes as the run's result
  const s = srv.sessions.get(key);
  const poll = srv.sessions.poll(key, { holder: "agent" });
  srv.sessions.send(key, { baseSha: s.baseSha, comments: [{ id: "n1", kind: "element", text: "tighten this", anchor: { location: { blockPath: [0] }, paraText: DOC_PARAS[0] } }], note: "" });
  const batch = await poll.promise;
  const claim = { holder: batch.lease.holder, token: batch.lease.token, batchId: batch.batch_id };
  const agentBytes = docxBytes(["Tightened first paragraph", DOC_PARAS[1]]);
  srv.sessions.agentWrite(key, { baseSha: docSha, bytes: agentBytes, ...claim });
  const inputs = srv.sessions.analysisInputs(key, claim);
  assert.equal(inputs.postSha, sha256(agentBytes), "done's checks get the agent's bytes");
  await srv.sessions.doneAsync(key, { summary: "done", results: [{ comment_id: "n1", status: "done", note: "ok" }] }, claim, await analyzeOffThread(inputs), { inline: false });
  const entry = s.activity.find((a) => a.kind === "agent" && a.batchId === batch.batch_id);
  assert.equal(entry.postSha, sha256(agentBytes));
  assert.equal(entry.preSha, docSha);
  assert.equal(entry.flags.some((f) => f.code === "file_changed_outside_onionskin"), false, JSON.stringify(entry.flags));
  assert.equal(s.histTip, sha256(agentBytes));
});

test("same as before: an atomic save by another editor (a new file renamed over the document) is read and recorded as an outside change", async () => {
  const { file, docSha } = docPair();
  const { key, token } = await launch(file);
  const s = srv.sessions.get(key);
  assert.equal((await get(token, `/api/file?s=${key}`)).status, 200, "control");
  const saved = docxBytes(["Saved by another editor", DOC_PARAS[1]]);
  const tmp = path.join(path.dirname(file), ".doc.docx.editor-tmp");
  fs.writeFileSync(tmp, saved);
  fs.renameSync(tmp, file);
  const r = await get(token, `/api/file?s=${key}`);
  assert.equal(r.status, 200, r.text);
  assert.equal(sha256(r.buf), sha256(saved));
  assert.equal(s.histTip, sha256(saved));
  assert.ok(s.snapshots.has(sha256(saved)), "the outside version is stored");
  assert.ok(s.snapshots.has(docSha), "the version before it is still stored");
  const list = JSON.parse((await get(token, `/api/history?s=${key}`)).text);
  assert.ok(list.updates.some((u) => u.kind === "outside"), JSON.stringify(list.updates.map((u) => u.kind)));
});

test("same as before: a document with a second hard link is read, and a save in place through the other name is read as an outside change", async () => {
  const { file, docSha } = docPair();
  const other = path.join(path.dirname(file), "other-name.docx");
  fs.linkSync(file, other);
  const { key, token } = await launch(file);
  const r = await get(token, `/api/file?s=${key}`);
  assert.equal(r.status, 200, r.text);
  assert.equal(sha256(r.buf), docSha);
  const saved = docxBytes(["Saved through the other name"]);
  fs.writeFileSync(other, saved); // same inode
  const r2 = await get(token, `/api/file?s=${key}`);
  assert.equal(r2.status, 200, r2.text);
  assert.equal(sha256(r2.buf), sha256(saved));
  assert.equal(srv.sessions.get(key).histTip, sha256(saved));
});

test("same as before: a document grown past the cap after open answers 413 too_large in the same words, and nothing is read", async () => {
  const { file } = docPair();
  const { key, token } = await launch(file);
  fs.truncateSync(file, MAX_DOC_BYTES + 1); // sparse: no disk space used
  const r = await get(token, `/api/file?s=${key}`);
  assert.equal(r.status, 413);
  const j = JSON.parse(r.text);
  assert.equal(j.code, "too_large");
  assert.equal(j.error, `Onionskin cannot read this file: doc.docx is larger than ${MAX_DOC_BYTES / 1024 / 1024} MB, more than Onionskin can read. Make it smaller (pictures and videos are often most of a file) or split it, and open that.`);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Finding 1, other things swapped in
// ---------------------------------------------------------------------------------------------------------------------------------

test("finding 1: a FIFO swapped in for the document is refused at once (409 gone), the server does not hang, nothing is stored", async () => {
  const { file, docSha } = docPair();
  const { key, token } = await launch(file);
  const s = srv.sessions.get(key);
  fs.rmSync(file);
  execFileSync("/usr/bin/mkfifo", [file]);
  const r = await get(token, `/api/file?s=${key}`);
  assert.equal(r.status, 409, r.text);
  const j = JSON.parse(r.text);
  assert.equal(j.code, "gone");
  assert.equal(j.error, `cannot read the file: ${file} is not a regular file`);
  const stale = await get(token, `/api/stale?s=${key}&sha=${docSha}`);
  assert.equal(stale.status, 409, stale.text);
  assert.equal(s.histTip, docSha);
  assert.equal(s.baseSha, docSha);
});

test("finding 1: GET /api/file of a document swapped for a link answers with the words and code a Send gives (409 gone, symbolic link)", async () => {
  const { file, target } = docPair();
  const { key, token } = await launch(file);
  swap(file, target);
  const r = await get(token, `/api/file?s=${key}`);
  assert.equal(r.status, 409, r.text);
  assert.deepEqual(JSON.parse(r.text), { error: `cannot read the file: ${file} is a symbolic link`, code: "gone" });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Item 2: `onionskin open` is bound like every other command
// ---------------------------------------------------------------------------------------------------------------------------------

test("binding: an agent bound to A is refused `open B` with the not-your-file words and gets no link; `open A` still works, and with no holder `open B` still works", async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(root, "openbind-")));
  const fa = path.join(dir, "a.docx");
  const fb = path.join(dir, "b.docx");
  fs.writeFileSync(fa, docxBytes(["Alpha paragraph"]));
  fs.writeFileSync(fb, docxBytes(["Bravo paragraph"]));
  const a = await viaSocket("POST", "/cli/open", { file: fa });
  const run = (args, holder) =>
    new Promise((resolve) => {
      const env = { PATH: process.env.PATH, HOME: root, ONIONSKIN_STATE_DIR: STATE, ONIONSKIN_NO_SOFFICE: "1", ONIONSKIN_AGENT_CLI: "none", ...(holder ? { ONIONSKIN_HOLDER: holder } : {}) };
      const c = spawn(process.execPath, [path.join(repo, "src", "cli.js"), ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
      let all = "";
      c.stdout.on("data", (d) => (all += d));
      c.stderr.on("data", (d) => (all += d));
      c.on("close", (code) => resolve({ code, all }));
    });
  const LINK = /http:\/\/127\.0\.0\.1:\d+\/\?s=[0-9a-f]+&n=[\w-]+/;
  const openCount = [...srv.sessions.map.keys()].length;
  const openB = await run(["open", fb, "--no-open", "--no-agent"], bgHolder(a.json.key));
  assert.notEqual(openB.code, 0, openB.all);
  assert.equal(openB.all.trim(), "This agent works only on the file it was started for. Nothing was read or written.");
  assert.equal(LINK.test(openB.all), false, "no launch link for B");
  assert.equal([...srv.sessions.map.keys()].length, openCount, "B was not opened");
  // the same words for a file that does not exist
  const missing = await run(["open", path.join(dir, "nope.docx"), "--no-open", "--no-agent"], bgHolder(a.json.key));
  assert.equal(missing.all.trim(), "This agent works only on the file it was started for. Nothing was read or written.");
  // same as before: a bound agent opening its own file
  const openA = await run(["open", fa, "--no-open", "--no-agent"], bgHolder(a.json.key));
  assert.equal(openA.code, 0, openA.all);
  assert.ok(LINK.test(openA.all), openA.all);
  // same as before: no holder in the environment (a person, or their own agent) opens any file
  const person = await run(["open", fb, "--no-open", "--no-agent"], null);
  assert.equal(person.code, 0, person.all);
  assert.ok(LINK.test(person.all), person.all);
});

test("finding 1, at the real entry point: POST /cli/done after a swap is refused, nothing of the target is recorded or returned, the run stays delivered", async () => {
  for (const bound of [false, true]) {
    const { file, target, targetSha } = docPair();
    const o = await viaSocket("POST", "/cli/open", { file });
    const s = srv.sessions.get(o.json.key);
    const poll = srv.sessions.poll(s.key, { holder: bound ? bgHolder(s.key) : "agent" });
    srv.sessions.send(s.key, { baseSha: s.baseSha, comments: [{ id: "c1", kind: "element", text: "tighten this", anchor: { location: { blockPath: [0] }, paraText: DOC_PARAS[0] } }], note: "" });
    const batch = await poll.promise;
    swap(file, target);
    const r = await viaSocket("POST", "/cli/done", { file, results: { summary: "done", results: [{ comment_id: "c1", status: "done", note: "ok" }] }, holder: batch.lease.holder, lease_token: batch.lease.token, batch_id: batch.batch_id });
    // the path now leads to the target, which is not this session's file: a bound agent gets not_your_file, any other caller finds no session there
    if (bound) assert.deepEqual([r.status, r.json.code], [403, "not_your_file"], JSON.stringify(r.json));
    else assert.equal(r.status, 404, JSON.stringify(r.json));
    assert.equal(JSON.stringify(r.json).includes(MARKER), false);
    assert.ok(s.delivered, "the run is still delivered (Take back or the lease ends it)");
    assert.equal(s.activity.some((a) => a.kind === "agent" && a.postSha === targetSha), false, "no run recorded with the target's bytes");
    notStored(s, targetSha, `/cli/done (${bound ? "bound" : "unbound"})`);
    assert.equal(sha256(fs.readFileSync(target)), targetSha, "the link target was never written");
    srv.sessions.takeBack(s.key);
  }
});

test("binding at the server: POST /cli/open with a bound holder refuses another file (not_your_file) and gives no link; its own file and no holder still open", async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(root, "srvbind-")));
  const fa = path.join(dir, "a.docx");
  const fb = path.join(dir, "b.docx");
  fs.writeFileSync(fa, docxBytes(["Alpha paragraph"]));
  fs.writeFileSync(fb, docxBytes(["Bravo paragraph"]));
  const a = await viaSocket("POST", "/cli/open", { file: fa });
  const holder = bgHolder(a.json.key);
  const count = srv.sessions.map.size;
  const b = await viaSocket("POST", "/cli/open", { file: fb, holder });
  assert.deepEqual([b.status, b.json.code, b.json.url], [403, "not_your_file", undefined], JSON.stringify(b.json));
  assert.equal(b.json.error, "This agent works only on the file it was started for. Nothing was read or written.");
  assert.equal(srv.sessions.map.size, count, "B was not opened");
  // a link that leads to B: refused by the real file it would open
  const link = path.join(dir, "alias.docx");
  fs.symlinkSync(fb, link);
  const viaLink = await viaSocket("POST", "/cli/open", { file: link, holder });
  assert.equal(viaLink.status, 403, JSON.stringify(viaLink.json));
  const own = await viaSocket("POST", "/cli/open", { file: fa, holder });
  assert.equal(own.status, 200, JSON.stringify(own.json));
  assert.equal(own.json.key, a.json.key);
  const none = await viaSocket("POST", "/cli/open", { file: fb });
  assert.equal(none.status, 200, JSON.stringify(none.json));
});

test("encoding refusal: the server's 400 carries the open worker's copyable answer, and `onionskin open` offers the copy from it without reading the file again", async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(root, "enc-")));
  const yes = path.join(dir, "latin.html");
  const no = path.join(dir, "sjis.html");
  fs.writeFileSync(yes, Buffer.from('<!doctype html><html><head><meta charset="windows-1252"><title>t</title></head><body><p>caf\xe9</p></body></html>', "latin1"));
  fs.writeFileSync(no, Buffer.from('<!doctype html><html><head><meta charset="shift_jis"><title>t</title></head><body><p>\x82\xa0</p></body></html>', "latin1"));
  const ry = await viaSocket("POST", "/cli/open", { file: yes });
  assert.deepEqual([ry.status, ry.json.code, ry.json.copyable], [400, "not_utf8", true], JSON.stringify(ry.json));
  const rn = await viaSocket("POST", "/cli/open", { file: no });
  assert.deepEqual([rn.status, rn.json.code, rn.json.copyable], [400, "not_utf8", false], JSON.stringify(rn.json));
  const run = (file) =>
    new Promise((resolve) => {
      const c = spawn(process.execPath, [path.join(repo, "src", "cli.js"), "open", file, "--no-open", "--no-agent"], { env: { PATH: process.env.PATH, HOME: root, ONIONSKIN_STATE_DIR: STATE, ONIONSKIN_NO_SOFFICE: "1", ONIONSKIN_AGENT_CLI: "none" }, stdio: ["ignore", "pipe", "pipe"] });
      let all = "";
      c.stdout.on("data", (d) => (all += d));
      c.stderr.on("data", (d) => (all += d));
      c.on("close", (code) => resolve({ code, all }));
    });
  const cy = await run(yes);
  assert.notEqual(cy.code, 0);
  assert.ok(cy.all.includes("utf8-copy"), cy.all);
  const cn = await run(no);
  assert.notEqual(cn.code, 0);
  assert.equal(cn.all.includes("utf8-copy"), false, cn.all);
  assert.equal(cn.all.trim(), rn.json.error.trim());
});

test("binding pinned before the read: a holder bound to A opening a path that resolves to B causes no read, no snapshot, no saved state and no session for B; a pinned open of a path swapped for a link is refused before it reads", async () => {
  const { sessionKey } = await import("../src/paths.js");
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(root, "pin-")));
  const fa = path.join(dir, "a.docx");
  const fb = path.join(dir, "b.docx");
  fs.writeFileSync(fa, docxBytes(["Alpha paragraph"]));
  fs.writeFileSync(fb, docxBytes(["Bravo paragraph"]));
  const a = await viaSocket("POST", "/cli/open", { file: fa });
  const holder = bgHolder(a.json.key);
  const bKey = sessionKey(fb);
  const traces = () => ({
    session: srv.sessions.map.has(bKey),
    snapshots: fs.existsSync(path.join(STATE, "snapshots", bKey)),
    state: fs.existsSync(path.join(STATE, "sessions", `${bKey}.json`)),
  });
  const none = { session: false, snapshots: false, state: false };
  const changes = [];
  const onChange = (s) => changes.push(s.key);
  srv.sessions.on("change", onChange);
  try {
    const link = path.join(dir, "looks-like-a.docx");
    fs.symlinkSync(fb, link);
    const fbAtime = fs.statSync(fb).atimeMs;
    for (const [route, call] of [
      ["open", () => viaSocket("POST", "/cli/open", { file: link, holder })],
      ["poll", () => viaSocket("GET", `/cli/poll?file=${encodeURIComponent(link)}&holder=${encodeURIComponent(holder)}`)],
    ]) {
      const r = await call();
      assert.deepEqual([r.status, r.json.code], [403, "not_your_file"], `${route}: ${JSON.stringify(r.json)}`);
      assert.deepEqual(traces(), none, `${route}: nothing of B`);
    }
    assert.equal(changes.includes(bKey), false, "no change event for B");
    assert.equal(fs.statSync(fb).atimeMs, fbAtime, "B was not read (its access time did not move)");
    // the pin itself: a path the route resolved, swapped for a link before the open reads it, is refused and never opens the link's target
    const fc = path.join(dir, "c.docx");
    fs.writeFileSync(fc, docxBytes(["Charlie paragraph"]));
    fs.rmSync(fc);
    fs.symlinkSync(fb, fc);
    await assert.rejects(srv.sessions.openAsync(fc, { pinned: true }), (err) => err.status === 409 && err.extra?.code === "moved_while_opening");
    assert.deepEqual(traces(), none, "pinned open: nothing of B");
  } finally {
    srv.sessions.off("change", onChange);
  }
});
