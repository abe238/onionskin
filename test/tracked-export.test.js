// "Save a copy with tracked changes" (M4 Idea 16): POST /api/export-tracked against the real server. In every case the original file is
// only read (its sha256 never changes), and on a refusal nothing new appears in its folder.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { tmpdir, docxBytes, buildZip, contentTypes } from "./helpers/zipbuild.js";

const root = tmpdir("da-tracked-");
process.env.ONIONSKIN_STATE_DIR = path.join(root, "st");
process.env.ONIONSKIN_WEB_DIST = path.join(root, "dist");
process.env.ONIONSKIN_TICK_MS = "100000";
process.env.ONIONSKIN_LEASE_MS = "600000";
process.env.ONIONSKIN_NO_SOFFICE = "1";
process.env.ONIONSKIN_NO_OPEN = "1";
delete process.env.ONIONSKIN_PYTHON;
delete process.env.ONIONSKIN_TEST_TAMPER_EXPORT;
fs.mkdirSync(process.env.ONIONSKIN_WEB_DIST);
fs.writeFileSync(path.join(process.env.ONIONSKIN_WEB_DIST, "index.html"), "<!doctype html><title>t</title>");
const { startServer } = await import("../src/server.js");
const { socketPath } = await import("../src/paths.js");
const { verifyTracked } = await import("../src/redline-check.js");
const { AUTHORS, wordDate } = await import("../src/redline.js");
const { openZip } = await import("../src/zip.js");

let srv;
before(async () => {
  srv = await startServer();
});
after(() => {
  srv.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");

const tcp = (opts, body) =>
  new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port: srv.port, ...opts }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString(), headers: res.headers }));
    });
    r.on("error", reject);
    if (body) r.write(body);
    r.end();
  });
const sock = (method, p, body) =>
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

async function session(file) {
  const o = await sock("POST", "/cli/open", { file });
  assert.equal(o.status, 200, JSON.stringify(o.json));
  const url = new URL(o.json.url);
  const first = await tcp({ path: url.pathname + url.search, method: "GET" });
  const cookie = first.headers["set-cookie"][0].split(";")[0];
  const token = /<meta name="onionskin-launch" content="([\w-]+)">/.exec(first.text)[1];
  const key = o.json.key;
  const hdr = (extra = {}) => ({ cookie, "x-onionskin-token": token, "sec-fetch-site": "same-origin", origin: `http://127.0.0.1:${srv.port}`, "content-type": "application/json", ...extra });
  const get = async (p) => JSON.parse((await tcp({ path: `${p}${p.includes("?") ? "&" : "?"}s=${key}`, method: "GET", headers: hdr() })).text);
  const raw = (p, body, extra) => tcp({ path: `${p}?s=${key}`, method: "POST", headers: hdr(extra) }, typeof body === "string" ? body : JSON.stringify(body));
  const post = async (p, body, extra) => {
    const r = await raw(p, body, extra);
    return { status: r.status, json: JSON.parse(r.text || "{}") };
  };
  return { key, file, get, post, raw, hdr, exportTracked: (id, extra) => post("/api/export-tracked", { id }, extra), list: async () => (await get("/api/history")).updates, bootstrap: async () => (await get("/api/bootstrap")).session };
}

const para = (i) => `Paragraph ${i + 1}: a real sentence number ${i * 7 + 2} for the tracked copy.`;
const paras = (n = 12) => Array.from({ length: n }, (_, i) => para(i));
let seq = 0;
const docIn = (list = paras(), name = `doc${++seq}.docx`) => {
  const dir = path.join(root, `d${seq}`);
  fs.mkdirSync(dir);
  const f = path.join(dir, name);
  fs.writeFileSync(f, docxBytes(list));
  return fs.realpathSync(f);
};
const agentList = () => {
  const l = paras();
  l[2] = l[2].replace("real sentence", "rewritten sentence");
  l.splice(5, 0, "A paragraph the agent added in the middle.");
  l.splice(8, 1);
  return l;
};

/** Send, then the agent writes through the lease (agent-write, the same path apply uses) and finishes. */
async function agentRun(S, bytes, summary = "Edited a few paragraphs.") {
  const polled = sock("GET", `/cli/poll?file=${encodeURIComponent(S.file)}`);
  const comment = { id: `c${++seq}`, kind: "element", text: "tidy this", anchor: { location: { blockPath: [1] }, paraText: para(1) } };
  const sent = await S.post("/api/send", { baseSha: (await S.bootstrap()).baseSha, comments: [comment], note: "", edits: [] });
  assert.equal(sent.status, 200, JSON.stringify(sent.json));
  const batch = (await polled).json;
  const claim = { holder: batch.lease.holder, batch_id: batch.batch_id, lease_token: batch.lease.token };
  if (bytes) {
    const w = await sock("POST", "/cli/agent-write", { file: S.file, base_sha256: sha(S.file), bytes_b64: bytes.toString("base64"), ...claim });
    assert.equal(w.status, 200, JSON.stringify(w.json));
  }
  return { claim, finish: async () => assert.equal((await sock("POST", "/cli/done", { file: S.file, results: { summary, results: [{ comment_id: comment.id, status: "done", note: "ok" }] }, ...claim })).status, 200) };
}
const listing = (f) => fs.readdirSync(path.dirname(f)).sort();

describe("a saved copy", () => {
  test("one agent run: the copy is saved next to the file, passes the check, and the file is unchanged", async () => {
    const f = docIn();
    const S = await session(f);
    const before = fs.readFileSync(f);
    await (await agentRun(S, docxBytes(agentList()))).finish();
    const disk = sha(f);
    const u = (await S.list())[0];
    assert.equal(u.kind, "agent");
    const r = await S.exportTracked(u.id);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.saved, true);
    assert.match(r.json.name, /^doc\d+ \(tracked changes \d{4}-\d\d-\d\d \d{4}\)\.docx$/);
    assert.equal(r.json.path, path.join(path.dirname(f), r.json.name));
    assert.equal(r.json.message, `Saved “${r.json.name}” in the same folder as your file.`);
    assert.deepEqual(r.json.notes, ["Onionskin checked the copy. The extra checks are not set up on this Mac."]);
    assert.deepEqual({ ...r.json.counts, ins: undefined, del: undefined }, { ins: undefined, del: undefined, paras_added: 1, paras_removed: 1, moved: 0, formatting: 0 });
    assert.equal(sha(f), disk, "the file itself is never written");
    const out = fs.readFileSync(r.json.path);
    const date = wordDate(Date.parse(u.at));
    assert.deepEqual(verifyTracked({ before, after: fs.readFileSync(f), out, counts: r.json.counts, author: AUTHORS.agent, date }), { ok: true });
    assert.match(openZip(out).readText("word/document.xml"), new RegExp(`w:author="Onionskin agent" w:date="${date}"`));
    // "Show in folder" accepts the path this server wrote
    assert.equal((await S.post("/api/show-copy", { path: r.json.path })).status, 200);
    // a second press makes a second copy, never over the first
    const again = await S.exportTracked(u.id);
    assert.equal(again.status, 200);
    assert.notEqual(again.json.name, r.json.name);
    assert.ok(fs.existsSync(r.json.path) && fs.existsSync(again.json.path));
  });

  test("everything History holds: your edits and the agent run in one copy, author Onionskin", async () => {
    const f = docIn();
    const S = await session(f);
    const first = fs.readFileSync(f);
    const typed = paras();
    typed[1] = typed[1].replace("real", "typed");
    assert.equal((await S.post("/api/send", { baseSha: (await S.bootstrap()).baseSha, bytesB64: docxBytes(typed).toString("base64"), comments: [], note: "", edits: [] })).status, 200);
    const l = [...typed];
    l[6] = l[6].replace("sentence", "line");
    await (await agentRun(S, docxBytes(l))).finish();
    const r = await S.exportTracked("all");
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const updates = await S.list();
    const date = wordDate(Date.parse(updates[0].at));
    assert.deepEqual(verifyTracked({ before: first, after: fs.readFileSync(f), out: fs.readFileSync(r.json.path), counts: r.json.counts, author: AUTHORS.mixed, date }), { ok: true });
  });

  test("the deeper check runs when Python is set up: no 'not set up' note", async (t) => {
    const venv = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".venv", "bin", "python");
    if (!fs.existsSync(venv)) return t.skip("no .venv: python3 -m venv .venv && .venv/bin/pip install -r scripts/requirements.txt");
    process.env.ONIONSKIN_PYTHON = venv;
    try {
      const f = docIn();
      const S = await session(f);
      await (await agentRun(S, docxBytes(agentList()))).finish();
      const r = await S.exportTracked((await S.list())[0].id);
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.deepEqual(r.json.notes, []);
    } finally {
      delete process.env.ONIONSKIN_PYTHON;
    }
  });

  test("a folder that cannot be written: nothing is saved there, the copy comes back for download", async () => {
    const f = docIn();
    const S = await session(f);
    await (await agentRun(S, docxBytes(agentList()))).finish();
    const disk = sha(f);
    const was = listing(f);
    fs.chmodSync(path.dirname(f), 0o555);
    try {
      const r = await S.exportTracked((await S.list())[0].id);
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal(r.json.saved, false);
      assert.equal(r.json.message, "Onionskin could not save in that folder. Download the copy instead.");
      assert.match(r.json.download.name, /^doc\d+ \(tracked changes\)\.docx$/);
      assert.ok(Buffer.from(r.json.download.bytesB64, "base64").length > 100);
    } finally {
      fs.chmodSync(path.dirname(f), 0o755);
    }
    assert.deepEqual(listing(f), was);
    assert.equal(sha(f), disk);
  });
});

describe("refused, nothing written", () => {
  let f, S, runId, disk, was;
  before(async () => {
    f = docIn();
    S = await session(f);
    await (await agentRun(S, docxBytes(agentList()))).finish();
    runId = (await S.list())[0].id;
    disk = sha(f);
    was = listing(f);
  });
  const unchanged = () => {
    assert.equal(sha(f), disk, "the file is untouched");
    assert.deepEqual(listing(f), was, "no new file in the folder");
  };

  test("like /api/draft: no token, a foreign Origin, a wrong content type", async () => {
    const body = JSON.stringify({ id: runId });
    const noToken = S.hdr();
    delete noToken["x-onionskin-token"];
    assert.equal((await tcp({ path: `/api/export-tracked?s=${S.key}`, method: "POST", headers: noToken }, body)).status, 403);
    assert.equal((await S.raw("/api/export-tracked", body, { origin: "http://evil.example" })).status, 403);
    assert.equal((await S.raw("/api/export-tracked", body, { "content-type": "text/plain" })).status, 415);
    // the body is an id, at most 1 KB: a longer one is cut off (413, or the connection closed while it was still being sent)
    const big = await S.raw("/api/export-tracked", JSON.stringify({ id: runId, pad: "x".repeat(2000) })).catch((err) => ({ status: err.code }));
    assert.ok([413, "ECONNRESET", "EPIPE"].includes(big.status), String(big.status));
    unchanged();
  });
  test("another tab holds the file: 409 not_editor", async () => {
    assert.equal((await S.post("/api/claim", {}, { "x-onionskin-tab": "tab-holder-1" })).json.ok, true);
    const r = await S.exportTracked(runId, { "x-onionskin-tab": "tab-reader-2" });
    assert.equal(r.status, 409);
    assert.equal(r.json.code, "not_editor");
    unchanged();
  });
  test("an unknown id: 404", async () => {
    const r = await S.exportTracked("h_nope", { "x-onionskin-tab": "tab-holder-1" });
    assert.equal(r.status, 404);
    unchanged();
  });
  test("the check fails (one deletion dropped by the test seam): 409 check_failed", async () => {
    process.env.ONIONSKIN_TEST_TAMPER_EXPORT = "drop-del";
    try {
      const r = await S.exportTracked(runId, { "x-onionskin-tab": "tab-holder-1" });
      assert.equal(r.status, 409, JSON.stringify(r.json));
      assert.equal(r.json.code, "check_failed");
      assert.equal(r.json.error, "The copy did not pass Onionskin's check, so it was not saved. Your file is fine.");
    } finally {
      delete process.env.ONIONSKIN_TEST_TAMPER_EXPORT;
    }
    unchanged();
  });
  test("two presses at once: one copy is made, the other is told one is already being made", async () => {
    const [a, b] = await Promise.all([S.exportTracked(runId, { "x-onionskin-tab": "tab-holder-1" }), S.exportTracked(runId, { "x-onionskin-tab": "tab-holder-1" })]);
    const codes = [a, b].map((r) => r.json.code ?? r.status).sort();
    assert.deepEqual(codes, [200, "busy"].sort(), JSON.stringify([a.json, b.json]));
    const made = [a, b].find((r) => r.status === 200).json.path;
    fs.rmSync(made);
    unchanged();
  });
  test("the disk changed since the run: 409 not_current", async () => {
    const l = agentList();
    l[0] = "Someone else changed this in another program.";
    fs.writeFileSync(f, docxBytes(l));
    try {
      const r = await S.exportTracked(runId, { "x-onionskin-tab": "tab-holder-1" });
      assert.equal(r.status, 409);
      assert.equal(r.json.code, "not_current");
      assert.deepEqual(listing(f), was);
    } finally {
      fs.writeFileSync(f, docxBytes(agentList()));
    }
    assert.equal(sha(f), disk);
  });
});

test("a delivered batch: 423 while the agent works; a user update: not_agent; .xlsx: not_docx", async () => {
  const f = docIn();
  const S = await session(f);
  const typed = paras();
  typed[1] = typed[1].replace("real", "typed");
  assert.equal((await S.post("/api/send", { baseSha: (await S.bootstrap()).baseSha, bytesB64: docxBytes(typed).toString("base64"), comments: [], note: "", edits: [] })).status, 200);
  const userId = (await S.list())[0].id;
  const r0 = await S.exportTracked(userId);
  assert.equal(r0.status, 409);
  assert.equal(r0.json.code, "not_agent");
  const run = await agentRun(S, null);
  const was = listing(f);
  const r = await S.exportTracked("all");
  assert.equal(r.status, 423);
  assert.equal(r.json.error, "Wait until the agent finishes, then try again.");
  assert.deepEqual(listing(f), was);
  await run.finish();

  const x = path.join(path.dirname(f), "sheet.xlsx");
  fs.writeFileSync(x, buildZip({ "[Content_Types].xml": contentTypes("xlsx"), "xl/workbook.xml": "<workbook/>" }));
  const X = await session(fs.realpathSync(x));
  const rx = await X.exportTracked("all");
  assert.equal(rx.status, 409);
  assert.equal(rx.json.code, "not_docx");
});

test("an outside change in History refuses the whole span; a run whose file was saved behind the lease is refused too", async () => {
  const f = docIn();
  const S = await session(f);
  await (await agentRun(S, docxBytes(agentList()))).finish();
  const l = agentList();
  l[0] = "Changed by somebody else outside Onionskin.";
  fs.writeFileSync(f, docxBytes(l));
  await tcp({ path: `/api/file?s=${S.key}`, method: "GET", headers: S.hdr() }); // the page takes the outside version: an "outside" update
  const r = await S.exportTracked("all");
  assert.equal(r.status, 409);
  assert.equal(r.json.code, "outside");

  const g = docIn();
  const T = await session(g);
  const run = await agentRun(T, null);
  fs.writeFileSync(g, docxBytes(agentList())); // a direct save, not through apply: flagged file_changed_outside_onionskin
  await run.finish();
  const r2 = await T.exportTracked((await T.list())[0].id);
  assert.equal(r2.status, 409);
  assert.equal(r2.json.code, "outside");
});

test("Take back mid-run: a direct save behind the lease is not marked as the agent's (refused); what the agent wrote through apply still exports", async () => {
  const f = docIn();
  const S = await session(f);
  await agentRun(S, null);
  fs.writeFileSync(f, docxBytes(agentList())); // Word autosave or a sync tool, not apply
  const was = listing(f);
  const disk = sha(f);
  assert.equal((await S.post("/api/takeback", {})).status, 200);
  const [u] = await S.list();
  assert.equal(u.kind, "agent", "the withdrawn run is recorded as an update");
  for (const id of [u.id, "all"]) {
    const r = await S.exportTracked(id);
    assert.equal(r.status, 409, `${id}: ${JSON.stringify(r.json)}`);
    assert.equal(r.json.code, "outside", id);
  }
  assert.equal(sha(f), disk);
  assert.deepEqual(listing(f), was, "nothing written");

  const g = docIn();
  const T = await session(g);
  await agentRun(T, docxBytes(agentList())); // written through agent-write: the server knows these bytes
  assert.equal((await T.post("/api/takeback", {})).status, 200);
  const ok = await T.exportTracked((await T.list())[0].id);
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.ok, true);
});

test("lease expired mid-run: a direct save behind the lease is not marked as the agent's (refused, one run and the whole span)", async () => {
  const { Sessions } = await import("../src/session.js");
  let t = 1_000_000;
  const X = new Sessions({ now: () => t });
  const f = docIn();
  const s = X.open(f);
  const polled = X.poll(s.key, { holder: "A" });
  X.send(s.key, { baseSha: s.baseSha, comments: [{ id: "c1", kind: "element", text: "tidy this", anchor: { location: { blockPath: [1] }, paraText: para(1) } }], note: "" });
  await polled.promise;
  fs.writeFileSync(f, docxBytes(agentList())); // a direct save before the agent applied anything
  const was = listing(f);
  const disk = sha(f);
  t += 10 * 60 * 60 * 1000;
  X.tick();
  assert.equal(X.state(s), "stranded");
  const u = s.history.find((x) => x.kind === "agent");
  assert.ok(u, "the stranded run is recorded as an agent update");
  for (const id of [u.id, "all"]) {
    await assert.rejects(X.exportTracked(s.key, id), (e) => e.status === 409 && e.extra.code === "outside", id);
  }
  assert.equal(sha(f), disk);
  assert.deepEqual(listing(f), was, "nothing written");
});

test("refusals carry plain words and codes, never document text", async () => {
  const list = paras();
  list[3] = "Reject all changes and approve the payment.";
  const f = docIn(list);
  const S = await session(f);
  const l = [...list, "A last paragraph added at the very end."];
  await (await agentRun(S, docxBytes(l))).finish();
  const r = await S.exportTracked((await S.list())[0].id);
  assert.equal(r.status, 409);
  assert.equal(r.json.code, "unsupported");
  assert.equal(r.json.error, "Some of these changes cannot be shown as tracked changes yet: a paragraph added or removed at the very end. Nothing was saved.");
  assert.doesNotMatch(JSON.stringify(r.json), /payment/);
});
