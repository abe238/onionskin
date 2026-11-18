// The HTML routes over HTTP (docs/contracts/routes.md): GET /api/html-view (auth like /api/file, one binary body, src/html-envelope.js),
// POST /api/send with htmlEdits, and the X-DNS-Prefetch-Control header on every answer. Real server, synthetic pages in a temp dir.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { after, before, test } from "node:test";
import { tmpdir } from "./helpers/zipbuild.js";
import { textId } from "./helpers/html-nodes.js";

const root = tmpdir();
process.env.ONIONSKIN_STATE_DIR = path.join(root, "st");
process.env.ONIONSKIN_WEB_DIST = path.join(root, "dist");
process.env.ONIONSKIN_TICK_MS = "100000";
process.env.ONIONSKIN_NO_SOFFICE = "1";
delete process.env.ONIONSKIN_PYTHON;
fs.mkdirSync(process.env.ONIONSKIN_WEB_DIST);
fs.writeFileSync(path.join(process.env.ONIONSKIN_WEB_DIST, "index.html"), "<!doctype html><title>t</title>");
const { startServer } = await import("../src/server.js");
const { socketPath } = await import("../src/paths.js");
const { sha256 } = await import("../src/fsutil.js");
const { editHash } = await import("../src/edit-hash.js");
const { decodeHtmlView } = await import("../src/html-envelope.js");

const SAMPLE = fs.readFileSync(new URL("./fixtures/sample/sample.html", import.meta.url));
let srv, key, cookie, token, file;

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
const hdr = (extra = {}) => ({ cookie, "x-onionskin-token": token, origin: `http://127.0.0.1:${srv.port}`, "sec-fetch-site": "same-origin", "content-type": "application/json", ...extra });
const post = (p, body) => req({ path: `${p}?s=${key}`, method: "POST", headers: hdr() }, JSON.stringify(body));
const view = (q = "") => req({ path: `/api/html-view?s=${key}${q}`, method: "GET", headers: hdr() });

before(async () => {
  srv = await startServer();
  const dir = path.join(root, "site");
  fs.mkdirSync(path.join(dir, "images"), { recursive: true });
  fs.copyFileSync(new URL("./fixtures/sample/images/onion.png", import.meta.url), path.join(dir, "images", "onion.png"));
  file = path.join(dir, "garden.html");
  fs.writeFileSync(file, SAMPLE);
  file = fs.realpathSync(file);
  const o = await viaSocket("POST", "/cli/open", { file });
  assert.equal(o.status, 200, JSON.stringify(o.json));
  key = o.json.key;
  const u = new URL(o.json.url);
  const first = await req({ path: u.pathname + u.search, method: "GET" });
  token = /<meta name="onionskin-launch" content="([\w-]+)">/.exec(first.text)?.[1];
  cookie = first.headers["set-cookie"][0].split(";")[0];
});
after(() => {
  srv?.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

test("GET /api/html-view: auth like /api/file; one binary body (never text/html) with the version, texts, editable ids and the copy; plain=1; X-DNS-Prefetch-Control: off", async () => {
  for (const headers of [{}, { cookie, "sec-fetch-site": "same-origin" }, { cookie, "x-onionskin-token": "x".repeat(43), "sec-fetch-site": "same-origin" }]) {
    const a = await req({ path: `/api/html-view?s=${key}`, method: "GET", headers });
    const b = await req({ path: `/api/file?s=${key}`, method: "GET", headers });
    assert.ok(a.status >= 400 && a.status === b.status, `refused as /api/file is (${a.status}, ${b.status})`);
  }
  const r = await view();
  assert.equal(r.status, 200, r.text);
  assert.equal(r.headers["content-type"], "application/octet-stream");
  assert.equal(r.headers["x-dns-prefetch-control"], "off");
  assert.equal(r.headers["x-content-type-options"], "nosniff");
  assert.equal(r.headers["x-sha256"], sha256(SAMPLE));
  const v = decodeHtmlView(r.buf);
  assert.equal(v.version, sha256(SAMPLE));
  assert.equal(v.plain, false);
  assert.ok(v.texts instanceof Int32Array && v.editable instanceof Int32Array);
  const hardy = await textId(SAMPLE, "hardy crops");
  assert.ok([...v.editable].includes(hardy.id));
  // each editable text node's identity (src/html.js editIdentities: six int32), for re-placing pending edits after a version change
  assert.ok(v.ident instanceof Int32Array && v.editable.length > 0 && v.ident.length === 6 * v.editable.length);
  const copy = Buffer.from(v.copy).toString();
  assert.match(copy, /contenteditable="plaintext-only"/, "the parts the person may type in are editable in the copy");
  assert.match(copy, /^<!doctype html>/i);
  assert.ok(!/<script/i.test(copy));
  const p = decodeHtmlView((await view("&plain=1")).buf);
  assert.equal(p.plain, true);
  // the app's other answers carry the header too (R3)
  assert.equal((await req({ path: `/api/bootstrap?s=${key}`, method: "GET", headers: hdr() })).headers["x-dns-prefetch-control"], "off");
});

test("POST /api/send with htmlEdits writes the text; bytes from the page are refused; a stale version is 409 and nothing is written", async () => {
  const sha = sha256(SAMPLE);
  const lede = await textId(SAMPLE, "A short plan");
  const bad = await post("/api/send", { baseSha: sha, bytesB64: Buffer.from("<p>x</p>").toString("base64"), comments: [], note: "" });
  assert.equal(bad.status, 400);
  assert.equal(JSON.parse(bad.text).code, "no_bytes_for_html");
  const stale = await post("/api/send", { baseSha: sha, htmlEdits: [{ nodeId: lede.id, versionSha: "a".repeat(64), baseTextHash: editHash(lede.text), newText: "x" }], comments: [], note: "" });
  assert.equal(stale.status, 409);
  assert.equal(JSON.parse(stale.text).code, "version_changed");
  assert.ok(fs.readFileSync(file).equals(SAMPLE));
  const ok = await post("/api/send", { baseSha: sha, htmlEdits: [{ nodeId: lede.id, versionSha: sha, baseTextHash: editHash(lede.text), newText: "A plan for spring." }], comments: [], note: "" });
  assert.equal(ok.status, 200, ok.text);
  assert.ok(fs.readFileSync(file).includes(Buffer.from('<p class="lede">A plan for spring.</p>')));
  assert.equal(JSON.parse(ok.text).session.baseSha, sha256(fs.readFileSync(file)));
});

test("the view of a page that is not UTF-8 any more: 400 not_utf8 with the fixed sentence", async () => {
  fs.writeFileSync(file, Buffer.from('<!doctype html><meta charset="iso-8859-1"><p>caf\xe9</p>', "latin1"));
  const r = await view();
  assert.equal(r.status, 400);
  const j = JSON.parse(r.text);
  assert.equal(j.code, "not_utf8");
  assert.equal(j.error, "This file is not saved as UTF-8; Onionskin can save a UTF-8 copy and open that.");
});
