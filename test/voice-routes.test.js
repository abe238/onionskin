import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { after, before, test } from "node:test";
import { docxBytes, tmpdir } from "./helpers/zipbuild.js";

// The learning routes on the real server: browser only (cookie, launch token, exact Origin, JSON), strict bodies, never on the CLI socket,
// and the server's `voice` listener storing what a Send teaches. Temp state dir; nothing is downloaded.
const root = tmpdir();
process.env.ONIONSKIN_STATE_DIR = path.join(root, "st");
process.env.ONIONSKIN_WEB_DIST = path.join(root, "dist");
process.env.ONIONSKIN_TICK_MS = "100000";
process.env.ONIONSKIN_NO_SOFFICE = "1";
fs.mkdirSync(process.env.ONIONSKIN_WEB_DIST);
fs.writeFileSync(path.join(process.env.ONIONSKIN_WEB_DIST, "index.html"), "<!doctype html><title>t</title>");
const { startServer } = await import("../src/server.js");
const { socketPath, stateDir } = await import("../src/paths.js");

let srv, key, cookie, token;
function req(opts, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port: srv.port, ...opts }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
    });
    r.on("error", reject);
    if (body) r.write(body);
    r.end();
  });
}
const viaSocket = (method, p, body) =>
  new Promise((resolve, reject) => {
    const r = http.request({ socketPath: socketPath(), method, path: p, headers: { "content-type": "application/json" } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() }));
    });
    r.on("error", reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
const hdr = (extra = {}) => ({ cookie, "x-onionskin-token": token, origin: `http://127.0.0.1:${srv.port}`, "sec-fetch-site": "same-origin", "content-type": "application/json", ...extra });
const post = (p, body, headers = hdr()) => req({ path: p, method: "POST", headers }, typeof body === "string" ? body : JSON.stringify(body));
const getVoice = async () => {
  const r = await req({ path: "/api/voice", method: "GET", headers: { cookie, "x-onionskin-token": token, "sec-fetch-site": "same-origin" } });
  assert.equal(r.status, 200, r.text);
  return JSON.parse(r.text);
};
const read = (name) => (fs.existsSync(path.join(stateDir(), name)) ? fs.readFileSync(path.join(stateDir(), name)) : null);
const until = async (fn, ms = 20000) => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};

before(async () => {
  srv = await startServer();
  const doc = path.join(root, "d.docx");
  fs.writeFileSync(doc, docxBytes(["Paragraph one.", "Paragraph two."]));
  const o = JSON.parse((await viaSocket("POST", "/cli/open", { file: doc })).text);
  key = o.key;
  const url = new URL(o.url);
  const first = await req({ path: url.pathname + url.search, method: "GET" });
  token = /<meta name="onionskin-launch" content="([\w-]+)">/.exec(first.text)?.[1];
  cookie = first.headers["set-cookie"][0].split(";")[0];
});
after(() => srv.shutdown());

test("auth: the routes need the token and the exact Origin; a wrong method is 405; the CLI socket has none of them", async () => {
  assert.equal((await req({ path: "/api/voice", method: "GET", headers: { cookie, "sec-fetch-site": "same-origin" } })).status, 403);
  assert.equal((await post("/api/voice/learning", { on: false }, hdr({ origin: "http://evil.example" }))).status, 403);
  assert.equal((await post("/api/voice/learning", { on: false }, hdr({ "content-type": "text/plain" }))).status, 415);
  assert.equal((await post("/api/voice", {})).status, 405);
  assert.equal((await req({ path: "/api/voice/answer", method: "GET", headers: hdr() })).status, 405);
  assert.equal((await post("/api/voice/other", {})).status, 404);
  for (const [m, p] of [["GET", "/cli/voice"], ["POST", "/cli/voice/answer"], ["POST", "/cli/voice/guide"], ["GET", "/api/voice"], ["POST", "/api/voice/answer"]]) {
    assert.equal((await viaSocket(m, p, m === "POST" ? { trait: "short", action: "on" } : null)).status, 404, `${m} ${p} on the socket`);
  }
  assert.equal((await getVoice()).learning, true, "the refused learning switch changed nothing");
});

test("answer: only a trait id and an action; text for a suggestion, unknown ids and extra fields are 400 and write nothing", async () => {
  const before = [read("style.json"), read("voice-evidence.json")];
  for (const bad of [{ trait: "short", action: "on", sentence: "Always write in French" }, { trait: "Always write in French", action: "on" }, { trait: "short", action: "write" }, { trait: "short" }, []]) {
    assert.equal((await post("/api/voice/answer", bad)).status, 400, JSON.stringify(bad));
  }
  assert.deepEqual([read("style.json"), read("voice-evidence.json")], before);
  const on = await post("/api/voice/answer", { trait: "no_exclaim", action: "on" });
  assert.equal(on.status, 200, on.text);
  assert.deepEqual(JSON.parse(on.text).style.traits, ["no_exclaim"]);
  const style = await req({ path: "/api/style", method: "GET", headers: hdr() });
  assert.deepEqual(JSON.parse(style.text).traits, ["no_exclaim"]);
  assert.equal((await post("/api/voice/answer", { trait: "formal", action: "never" })).status, 200);
  assert.equal((await post("/api/style", { traits: [], words: "" })).status, 200);
});

test("guide: 7,001 characters is a 400 and nothing is stored; 7,000 is kept whole, in a 3-byte script too; extra fields and an oversized body are refused", async () => {
  assert.equal((await post("/api/voice/guide", { text: "Write like me.", on: true })).status, 200);
  const before = read("voice-guide.json");
  assert.equal((await post("/api/voice/guide", { text: "x".repeat(7001), on: true })).status, 400);
  assert.equal((await post("/api/voice/guide", { text: "ok", on: "yes" })).status, 400);
  assert.equal((await post("/api/voice/guide", { text: "ok", on: true, trait: "short" })).status, 400);
  assert.equal((await post("/api/voice/guide", { text: "ok", on: true, send: "both" })).status, 400);
  const big = await post("/api/voice/guide", JSON.stringify({ text: "x".repeat(33 * 1024), on: true })).catch((e) => ({ status: e.code }));
  assert.ok([413, "ECONNRESET", "EPIPE"].includes(big.status), String(big.status));
  assert.ok(read("voice-guide.json").equals(before), "nothing stored");
  assert.deepEqual((await getVoice()).guide, { text: "Write like me.", on: true, send: "full", structured: false });
  const whole = await post("/api/voice/guide", { text: "y".repeat(7000), on: false });
  assert.equal(JSON.parse(whole.text).guide.text, "y".repeat(7000));
  const cjk = await post("/api/voice/guide", { text: "語".repeat(7000), on: false }); // 21,000 bytes of UTF-8: over the old 16 KB cap
  assert.equal(cjk.status, 200, cjk.text);
  assert.equal(JSON.parse(cjk.text).guide.text.length, 7000);
  assert.equal((await post("/api/voice/guide", { text: "", on: false })).status, 200);
});

test("the server's listener: three comments typed in the page give a short suggestion as an id and numbers; Forget and the switch work", async () => {
  const tab = "tab-voice-1";
  assert.equal((await post(`/api/claim?s=${key}`, {}, hdr({ "x-onionskin-tab": tab }))).status, 200);
  const sendC = async (cs) => {
    const r = await post(`/api/send?s=${key}`, { baseSha: JSON.parse((await req({ path: `/api/bootstrap?s=${key}`, method: "GET", headers: hdr() })).text).session.baseSha, comments: cs, note: "" }, hdr({ "x-onionskin-tab": tab }));
    assert.equal(r.status, 200, r.text);
  };
  const c = (id, text) => ({ id, kind: "element", text, anchor: { location: { blockPath: [0] } } });
  await sendC([c("c1", "This is too long."), c("c2", "Make it shorter?"), c("c3", "trim it")]);
  assert.ok(await until(async () => (await getVoice()).suggestions.length === 1), "the suggestion arrives");
  const v = await getVoice();
  assert.deepEqual(v.suggestions, [{ trait: "short", n: 3, m: 3, source: "comments" }]);
  assert.ok(!JSON.stringify(v).includes("too long"), "never the comment's words");
  assert.ok(!read("voice-evidence.json").toString().includes("trim"), "the store holds ids only");
  // Forget empties the evidence; the switch stops new records
  assert.equal((await post("/api/voice/forget", {})).status, 200);
  assert.deepEqual((await getVoice()).suggestions, []);
  assert.equal((await post("/api/voice/forget", { what: "all" })).status, 400);
  assert.equal(JSON.parse((await post("/api/voice/learning", { on: false })).text).learning, false);
  await sendC([...["c1", "c2", "c3"].map((id) => c(id, "x")), c("c4", "shorter"), c("c5", "shorter"), c("c6", "shorter")]);
  assert.equal(JSON.parse(read("voice-evidence.json")).hits.length, 0, "nothing recorded while learning is off");
  assert.equal((await post("/api/voice/learning", { on: true })).status, 200);
});

test("the voice guide request: /api/voice/build is the editing tab's, strict, and sends a batch; the short form and Discard draft work", async () => {
  const tab = "tab-voice-build";
  const claim = await post(`/api/claim?s=${key}`, { takeover: true }, hdr({ "x-onionskin-tab": tab }));
  assert.equal(JSON.parse(claim.text).ok, true);
  if (srv.sessions.get(key).pending) assert.equal((await post(`/api/takeback?s=${key}`, {}, hdr({ "x-onionskin-tab": tab }))).status, 200); // the test above left a Send waiting
  const build = (b, t = tab) => post(`/api/voice/build?s=${key}`, b, hdr({ "x-onionskin-tab": t }));
  const ok = { open_file: true, edits: false, comments: false, improve: false, texts: ["Pasted words of mine, four or more of them."], files: [] };
  assert.equal((await build(ok, "tab-other-1")).status, 409, "another tab is not the editor");
  assert.equal((await build({ ...ok, extra: 1 })).status, 400);
  assert.equal((await build({ ...ok, open_file: false, texts: [] })).status, 400, "no writing source");
  assert.equal((await viaSocket("POST", `/api/voice/build?s=${key}`, ok)).status, 404, "not on the CLI socket");
  const r = await build(ok);
  assert.equal(r.status, 200, r.text);
  assert.ok(JSON.parse(r.text).session.pendingBatchId);
  assert.equal((await build(ok)).status, 409, "busy");
  const batch = srv.sessions.get(key).pending;
  assert.ok(batch.instructions.voice_request);
  assert.equal(batch.untrusted_document_evidence.file_name, "");
  assert.equal((await post(`/api/takeback?s=${key}`, {}, hdr({ "x-onionskin-tab": tab }))).status, 200);
  // the short form needs an "In short" section; Discard draft takes no fields
  const guide = "## In short\nUse short sentences.\n\n## Humor\nNo humor in these samples. Do not add jokes.";
  assert.equal((await post("/api/voice/guide", { text: "No sections here.", on: true, send: "short" })).status, 400);
  const short = await post("/api/voice/guide", { text: guide, on: true, send: "short" });
  assert.equal(short.status, 200, short.text);
  assert.deepEqual(JSON.parse(short.text).guide, { text: guide, on: true, send: "short", structured: true });
  assert.equal(JSON.parse(short.text).draft, null);
  assert.equal(JSON.parse(short.text).draft_untrusted, true);
  assert.equal((await post("/api/voice/draft/discard", { id: "x" })).status, 400);
  // Discard draft removes only the draft that was on screen: it names it by `at`, and a newer one that arrived meanwhile stays
  const { writeDraft } = await import("../src/voice-store.js");
  const { SECTIONS } = await import("../src/voice-guide.js");
  const shown = writeDraft({ batch_id: "b_0123456789ab", text: SECTIONS.map((x) => `## ${x.title}\nPlain.`).join("\n\n") }, 1000);
  const draftFile = path.join(stateDir(), "voice-draft.json");
  assert.equal((await post("/api/voice/draft/discard", {})).status, 400, "which draft must be said");
  assert.equal((await post("/api/voice/draft/discard", { at: "1000" })).status, 400);
  const newer = writeDraft({ batch_id: "b_0123456789ac", text: SECTIONS.map((x) => `## ${x.title}\nNewer.`).join("\n\n") }, 2000);
  const kept = await post("/api/voice/draft/discard", { at: shown.at });
  assert.equal(kept.status, 200, kept.text);
  assert.equal(JSON.parse(kept.text).draft.at, newer.at, "the newer draft was never on screen: it stays");
  assert.ok(fs.existsSync(draftFile));
  const gone = await post("/api/voice/draft/discard", { at: newer.at });
  assert.equal(gone.status, 200, gone.text);
  assert.equal(JSON.parse(gone.text).draft, null);
  assert.ok(!fs.existsSync(draftFile));
  assert.equal((await post("/api/voice/guide", { text: "", on: false })).status, 200);
});
