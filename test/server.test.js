import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { after, before, test } from "node:test";
import { tmpdir, docxBytes } from "./helpers/zipbuild.js";

const root = tmpdir();
process.env.ONIONSKIN_STATE_DIR = path.join(root, "st");
process.env.ONIONSKIN_WEB_DIST = path.join(root, "dist");
process.env.ONIONSKIN_TICK_MS = "100000";
fs.mkdirSync(process.env.ONIONSKIN_WEB_DIST);
fs.writeFileSync(path.join(process.env.ONIONSKIN_WEB_DIST, "index.html"), "<!doctype html><title>t</title>");
fs.writeFileSync(path.join(process.env.ONIONSKIN_WEB_DIST, "app.js"), "export {}");
const { startServer } = await import("../src/server.js");
const { BrowserAuth, CSP, safeEqual } = await import("../src/auth.js");
const { ensureStateDir, socketPath } = await import("../src/paths.js");

let srv, key, nonceUrl, doc;
const base = () => ({ host: "127.0.0.1", port: srv.port });

function req(opts, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ ...base(), ...opts }, (res) => {
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
    const r = http.request({ socketPath: socketPath(), method, path: p, headers: body ? { "content-type": "application/json" } : {} }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, json: JSON.parse(Buffer.concat(chunks).toString() || "{}") }));
    });
    r.on("error", reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });

let cookie, token;
before(async () => {
  srv = await startServer();
  doc = path.join(root, "d.docx");
  fs.writeFileSync(doc, docxBytes(["Paragraph one.", "Paragraph two."]));
  const o = await viaSocket("POST", "/cli/open", { file: doc });
  key = o.json.key;
  nonceUrl = new URL(o.json.url);
});
after(() => srv.shutdown());

test("a poll disconnected during outline preparation leaves its batch pending", async (t) => {
  const file = path.join(root, "interrupted-poll.docx");
  fs.writeFileSync(file, docxBytes(["Read me."]));
  const s = srv.sessions.open(file);
  srv.sessions.send(s.key, { baseSha: s.baseSha, comments: [], note: "Check this file." });
  let release, started;
  const waiting = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  t.mock.method(srv.sessions, "outlineAhead", () => { started(); return gate; });
  const disconnected = new Promise((resolve) => srv.unix.once("request", (_req, res) => res.once("close", resolve)));
  const request = http.get({ socketPath: socketPath(), path: "/cli/poll?file=" + encodeURIComponent(file) });
  request.on("error", () => {});
  try {
    await waiting;
    request.destroy();
    await disconnected;
  } finally {
    release();
  }
  await viaSocket("GET", "/health");
  assert.ok(s.pending, "the next poller can still take the batch");
  assert.equal(s.delivered, null);
  assert.equal(s.pollers.length, 0);
});

test("state dir is 0700, socket 0600, server record 0600; a symlinked or foreign-mode state dir is not trusted", () => {
  const dir = process.env.ONIONSKIN_STATE_DIR;
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(socketPath()).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(dir, "server.json")).mode & 0o777, 0o600);
  const rec = JSON.parse(fs.readFileSync(path.join(dir, "server.json"), "utf8"));
  assert.deepEqual(Object.keys(rec).sort(), ["pid", "port", "protocol"], "no token in the server record");
  for (const sub of ["sessions", "snapshots"]) assert.equal(fs.statSync(path.join(dir, sub)).mode & 0o777, 0o700);
  const sessionFile = fs.readdirSync(path.join(dir, "sessions"))[0];
  assert.equal(fs.statSync(path.join(dir, "sessions", sessionFile)).mode & 0o777, 0o600);
  // permissive dir is tightened
  fs.chmodSync(dir, 0o755);
  ensureStateDir();
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  // symlinked dir refused
  const real = path.join(root, "real-state");
  fs.mkdirSync(real, { mode: 0o700 });
  const link = path.join(root, "link-state");
  fs.symlinkSync(real, link);
  const saved = process.env.ONIONSKIN_STATE_DIR;
  process.env.ONIONSKIN_STATE_DIR = link;
  assert.throws(() => ensureStateDir(), /not a plain directory/);
  process.env.ONIONSKIN_STATE_DIR = saved;
});

test("server listens on loopback only; CSP and Referrer-Policy on every response, including errors", async () => {
  assert.equal(srv.tcp.address().address, "127.0.0.1");
  const hit = [
    await req({ path: "/", method: "GET" }), // 403 no session
    await req({ path: "/nope", method: "GET" }),
    await req({ path: "/api/bootstrap?s=x", method: "GET" }),
    await req({ path: "/favicon.ico", method: "GET" }),
  ];
  const sock = await viaSocket("GET", "/health");
  for (const r of [...hit, sock]) {
    assert.equal(r.headers["content-security-policy"], CSP);
    assert.equal(r.headers["referrer-policy"], "no-referrer");
    assert.equal(r.headers["x-content-type-options"], "nosniff");
  }
  assert.match(CSP, /default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self' data:; connect-src 'self' blob:; worker-src 'self' blob:; frame-src 'self' blob:; base-uri 'none'; form-action 'none'/);
});

test("browser auth: wrong Host (DNS rebinding) is refused even with a valid nonce, and the nonce is not burned", async () => {
  const r = await req({ path: nonceUrl.pathname + nonceUrl.search, method: "GET", headers: { host: "evil.example:" + srv.port } });
  assert.equal(r.status, 403);
  assert.match(r.text, /bad host/);
});

test("browser auth: nonce exchange sets an HttpOnly SameSite=Strict cookie; a second use of the URL is rejected", async () => {
  const first = await req({ path: nonceUrl.pathname + nonceUrl.search, method: "GET" });
  assert.equal(first.status, 200);
  const sc = first.headers["set-cookie"][0];
  token = /<meta name="onionskin-launch" content="([\w-]+)">/.exec(first.text)?.[1]; // the launch token arrives once, inside the page
  assert.match(sc, new RegExp(`^onionskin_sid_${srv.port}=`));
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /SameSite=Strict/);
  cookie = sc.split(";")[0];
  const second = await req({ path: nonceUrl.pathname + nonceUrl.search, method: "GET" });
  assert.equal(second.status, 403);
  assert.match(second.text, /already used or has expired/);
  const forged = await req({ path: "/?s=" + key + "&n=forged", method: "GET" });
  assert.equal(forged.status, 403);
  // cookie alone serves the app without a nonce (reload)
  assert.equal((await req({ path: "/?s=" + key, method: "GET", headers: { cookie } })).status, 200);
  assert.equal((await req({ path: "/app.js", method: "GET", headers: { cookie } })).status, 200);
  assert.equal((await req({ path: "/app.js", method: "GET" })).status, 403, "assets need the cookie too");
  assert.equal((await req({ path: "/../../etc/passwd", method: "GET", headers: { cookie } })).status >= 400, true);
  assert.ok(token && token.length >= 40, "the exchange page carries the launch token");
  const boot = await req({ path: "/api/bootstrap?s=" + key, method: "GET", headers: { cookie, "x-onionskin-token": token, "sec-fetch-site": "same-origin" } });
  assert.equal(boot.status, 200);
  assert.ok(!("token" in JSON.parse(boot.text)), "bootstrap never hands out a token");
});

const hdr = (extra = {}) => ({ cookie, "x-onionskin-token": token, origin: `http://127.0.0.1:${srv.port}`, "sec-fetch-site": "same-origin", "content-type": "application/json", ...extra });

test("API: header token, exact Origin, Sec-Fetch-Site same-origin and JSON content type are all required on POST", async () => {
  const draft = (headers) => req({ path: "/api/draft?s=" + key, method: "POST", headers }, JSON.stringify({ comments: [], note: "n" }));
  assert.equal((await draft(hdr())).status, 200);
  assert.equal((await draft(hdr({ "x-onionskin-token": "wrong" }))).status, 403, "bad token");
  const noTok = hdr();
  delete noTok["x-onionskin-token"];
  assert.equal((await draft(noTok)).status, 403, "missing token");
  assert.equal((await draft(hdr({ origin: "http://evil.example" }))).status, 403, "foreign origin");
  assert.equal((await draft(hdr({ origin: `http://localhost:${srv.port}` }))).status, 403, "origin must match exactly");
  const noOrigin = hdr();
  delete noOrigin.origin;
  assert.equal((await draft(noOrigin)).status, 403, "origin required on POST");
  assert.equal((await draft(hdr({ "sec-fetch-site": "cross-site" }))).status, 403);
  assert.equal((await draft(hdr({ "sec-fetch-site": "same-site" }))).status, 403);
  const noSfs = hdr();
  delete noSfs["sec-fetch-site"];
  assert.equal((await draft(noSfs)).status, 403, "Sec-Fetch-Site required on POST");
  assert.equal((await draft(hdr({ "content-type": "text/plain" }))).status, 415);
  assert.equal((await draft(hdr({ cookie: cookie.replace(/=.*/, "=bogus") }))).status, 401, "forged cookie");
  assert.equal((await req({ path: "/api/draft?s=" + key, method: "POST", headers: hdr() }, "{not json")).status, 400);
  // GET with cookie but without token
  assert.equal((await req({ path: "/api/file?s=" + key, method: "GET", headers: { cookie, "sec-fetch-site": "same-origin" } })).status, 403);
  const file = await req({ path: "/api/file?s=" + key, method: "GET", headers: { cookie, "x-onionskin-token": token, "sec-fetch-site": "same-origin" } });
  assert.equal(file.status, 200);
  assert.match(file.headers["x-sha256"], /^[0-9a-f]{64}$/);
});

test("the CLI socket is not reachable over TCP and browser routes are not reachable over the socket", async () => {
  assert.equal((await req({ path: "/cli/open", method: "POST", headers: { "content-type": "application/json" } }, "{}")).status, 404);
  assert.equal((await viaSocket("GET", "/api/file?s=" + key)).status, 404);
});

test("safeEqual is constant-time shaped and length safe; nonce expires after 60 s; nonce is single use", () => {
  assert.ok(safeEqual("abc", "abc"));
  assert.ok(!safeEqual("abc", "abd"));
  assert.ok(!safeEqual("abc", "abcd"));
  assert.ok(!safeEqual("", "x"));
  let t = 0;
  const a = new BrowserAuth(1234, { now: () => t });
  const n1 = a.newNonce();
  t += 59_000;
  assert.ok(a.exchange(n1));
  assert.equal(a.exchange(n1), null, "single use");
  const n2 = a.newNonce();
  t += 61_000;
  assert.equal(a.exchange(n2), null, "expired");
  assert.equal(a.exchange(undefined), null);
  assert.equal(a.cookieName, "onionskin_sid_1234", "cookie name carries the port: cookies are shared across ports on one host");
  // a second launch link in a browser that already has a session keeps that session: the first tab's API token stays valid
  const first = a.exchange((t = 0, a.newNonce()));
  const req = { headers: { cookie: first.cookie.split(";")[0], host: a.host, "x-onionskin-token": first.token } };
  assert.equal(a.check(req), null);
  const second = a.exchange(a.newNonce(), req);
  assert.equal(second.cookie.split(";")[0], first.cookie.split(";")[0], "same cookie value");
  assert.equal(a.check(req), null, "the first tab's token stays valid after a second launch");
  assert.equal(a.check({ headers: { ...req.headers, "x-onionskin-token": second.token } }), null, "and the second tab has its own");
  assert.notEqual(second.token, first.token);
  assert.notEqual(a.exchange(a.newNonce(), { headers: { cookie: "onionskin_sid_1234=bogus" } }).cookie.split(";")[0], first.cookie.split(";")[0], "an unknown cookie gets a fresh session");
});

// ---- security pass, finding 1: the cookie alone is never enough ---------------------------------------------------------------
test("finding 1: a valid cookie without the launch token is refused on bootstrap (401) and on every API route; replay from another port fails", async () => {
  const same = { "sec-fetch-site": "same-origin" };
  const boot = await req({ path: "/api/bootstrap?s=" + key, method: "GET", headers: { cookie, ...same } });
  assert.equal(boot.status, 401);
  assert.equal(JSON.parse(boot.text).code, "token_required");
  assert.ok(!boot.text.includes(token));
  for (const [method, p] of [["GET", "/api/file"], ["GET", "/api/events"], ["POST", "/api/draft"], ["POST", "/api/answer"], ["POST", "/api/send"], ["POST", "/api/claim"], ["POST", "/api/takeback"], ["POST", "/api/revert"], ["POST", "/api/resolve"], ["POST", "/api/close"]]) {
    const r = await req({ path: `${p}?s=${key}`, method, headers: { cookie, ...same, ...(method === "POST" ? { origin: `http://127.0.0.1:${srv.port}`, "content-type": "application/json" } : {}) } }, method === "POST" ? "{}" : undefined);
    assert.ok([401, 403].includes(r.status), `${method} ${p} refused without a token, got ${r.status}`);
    assert.equal(JSON.parse(r.text).code, "token_required", `${p} says why`);
  }
  // a wrong token does not help either
  assert.equal((await req({ path: "/api/bootstrap?s=" + key, method: "GET", headers: { cookie, ...same, "x-onionskin-token": "x".repeat(43) } })).status, 401);
  // a server on another port received the cookie (cookies are not port-scoped) and replays it by plain HTTP: it has the cookie, not the token, and its Host/Origin are not ours
  const other = http.createServer((q, r) => r.end("attacker"));
  await new Promise((r) => other.listen(0, "127.0.0.1", r));
  try {
    const attackerPort = other.address().port;
    const seen = { cookie }; // what the browser sent to the attacker's port
    const replay = await req({ path: "/api/bootstrap?s=" + key, method: "GET", headers: { ...seen, host: `127.0.0.1:${attackerPort}`, origin: `http://127.0.0.1:${attackerPort}` } });
    assert.equal(replay.status, 403, "wrong host");
    const spoof = await req({ path: "/api/bootstrap?s=" + key, method: "GET", headers: { ...seen, ...same, origin: `http://127.0.0.1:${attackerPort}` } });
    assert.equal(spoof.status, 403, "wrong origin");
    const spoofHeaders = await req({ path: "/api/bootstrap?s=" + key, method: "GET", headers: { ...seen, ...same } });
    assert.equal(spoofHeaders.status, 401, "right Host and headers forged, still no token: nothing comes back");
    assert.ok(!spoofHeaders.text.includes("token\":\""));
  } finally {
    other.close();
  }
});

test("finding 1: reload keeps working from the page's stored token; a second tab needs its own launch and does not disturb the first; the token is delivered only in the exchange page", async () => {
  const withTok = { cookie, "x-onionskin-token": token, "sec-fetch-site": "same-origin" };
  assert.equal((await req({ path: "/api/bootstrap?s=" + key, method: "GET", headers: withTok })).status, 200, "a reload re-presents the stored token");
  assert.equal((await req({ path: "/?s=" + key, method: "GET", headers: { cookie } })).text.includes(token), false, "a reload of the page does not carry the token again");
  const o = await viaSocket("POST", "/cli/open", { file: doc });
  const u = new URL(o.json.url);
  const second = await req({ path: u.pathname + u.search, method: "GET", headers: { cookie } });
  assert.equal(second.status, 200);
  assert.equal(second.headers["set-cookie"][0].split(";")[0], cookie, "the browser's cookie is kept");
  const token2 = /content="([\w-]+)"/.exec(second.text)[1];
  assert.notEqual(token2, token);
  const tab = (t, id) => req({ path: "/api/claim?s=" + key, method: "POST", headers: { cookie, "x-onionskin-token": t, origin: `http://127.0.0.1:${srv.port}`, "sec-fetch-site": "same-origin", "content-type": "application/json", "x-onionskin-tab": id } }, "{}");
  const a = JSON.parse((await tab(token, "tabAAAAAA")).text);
  const b = JSON.parse((await tab(token2, "tabBBBBBB")).text);
  assert.equal(a.ok, true, "the first tab is the editor");
  assert.equal(b.ok, false, "the second tab, with its own launch token, opens read-only");
  // a read-only tab cannot answer a question card (checked before the comment is even looked up)
  const ans = await req({ path: "/api/answer?s=" + key, method: "POST", headers: { cookie, "x-onionskin-token": token2, origin: `http://127.0.0.1:${srv.port}`, "sec-fetch-site": "same-origin", "content-type": "application/json", "x-onionskin-tab": "tabBBBBBB" } }, JSON.stringify({ id: "c1", choice: 0 }));
  assert.equal(ans.status, 409);
  assert.equal(JSON.parse(ans.text).code, "not_editor");
  // the page's Stop (stop with takeBack) is refused from the read-only tab, and answered from the editing one (nothing in flight: no error)
  const agentPost = (t, id, body) => req({ path: "/api/agent?s=" + key, method: "POST", headers: { cookie, "x-onionskin-token": t, origin: `http://127.0.0.1:${srv.port}`, "sec-fetch-site": "same-origin", "content-type": "application/json", "x-onionskin-tab": id } }, JSON.stringify(body));
  const roStop = await agentPost(token2, "tabBBBBBB", { action: "stop", takeBack: true });
  assert.equal(roStop.status, 409);
  assert.equal(JSON.parse(roStop.text).code, "not_editor");
  assert.equal((await agentPost(token, "tabAAAAAA", { action: "stop", takeBack: "yes" })).status, 400);
  assert.equal((await agentPost(token, "tabAAAAAA", { action: "start", takeBack: true })).status, 400);
  const edStop = await agentPost(token, "tabAAAAAA", { action: "stop", takeBack: true });
  assert.equal(edStop.status, 200);
  assert.equal(JSON.parse(edStop.text).ok, true);
  assert.equal((await req({ path: "/api/bootstrap?s=" + key, method: "GET", headers: withTok })).status, 200, "the first tab's token still works");
  // a new tab with no launch link has the cookie but no token: refused
  assert.equal((await req({ path: "/api/bootstrap?s=" + key, method: "GET", headers: { cookie, "sec-fetch-site": "same-origin" } })).status, 401);
  // the event stream takes the token in the query (EventSource cannot set headers) and refuses without it
  assert.equal((await req({ path: `/api/events?s=${key}&tab=tabAAAAAA`, method: "GET", headers: { cookie, "sec-fetch-site": "same-origin" } })).status, 403);
});

test("stamps routes: token, Origin and JSON are required; the list is validated server-side and an unknown field is refused", async () => {
  const same = { cookie, "x-onionskin-token": token, origin: `http://127.0.0.1:${srv.port}`, "sec-fetch-site": "same-origin", "content-type": "application/json" };
  const post = (body, headers = same) => req({ path: "/api/stamps", method: "POST", headers }, typeof body === "string" ? body : JSON.stringify(body));
  const get = (headers = { cookie, "x-onionskin-token": token, "sec-fetch-site": "same-origin" }) => req({ path: "/api/stamps", method: "GET", headers });
  const list = [{ label: "Formal", words: "Make this more formal." }];
  assert.equal((await get({ cookie, "sec-fetch-site": "same-origin" })).status, 403, "no token");
  assert.equal((await post({ stamps: list }, { cookie, origin: same.origin, "sec-fetch-site": "same-origin", "content-type": "application/json" })).status, 403, "no token on a write");
  assert.equal((await post({ stamps: list }, { ...same, origin: "http://evil.example" })).status, 403, "wrong Origin");
  assert.equal((await post({ stamps: list }, { ...same, "content-type": "text/plain" })).status, 415, "not JSON");
  assert.deepEqual(JSON.parse((await get()).text), { stamps: [] }, "nothing was stored by the refused writes");
  const ok = await post({ stamps: list });
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(JSON.parse((await get()).text).stamps, list);
  assert.equal((await post({ stamps: Array.from({ length: 9 }, () => list[0]) })).status, 400);
  assert.equal((await post({ stamps: [{ label: "A", words: "x".repeat(301) }] })).status, 400);
  assert.equal((await post({ stamps: list, path: "/etc/passwd" })).status, 400, "an unknown top-level field");
  assert.equal((await post({ stamps: [{ label: "A", words: "B", id: 1 }] })).status, 400, "an unknown stamp field");
  // over the 16 KB cap the server answers 413 or drops the connection (it stops reading); either way nothing is stored
  const big = await post(JSON.stringify({ stamps: [{ label: "A", words: "B" }], pad: "x".repeat(17 * 1024) })).catch((e) => ({ status: e.code }));
  assert.ok([413, "ECONNRESET"].includes(big.status), `over the cap: ${big.status}`);
  assert.deepEqual(JSON.parse((await get()).text).stamps, list, "the refused writes changed nothing");
  assert.equal((await post({ stamps: [] })).status, 200);
});

test("style route: token, Origin and JSON are required; only the fixed ids and 280 typed characters are accepted", async () => {
  const same = { cookie, "x-onionskin-token": token, origin: `http://127.0.0.1:${srv.port}`, "sec-fetch-site": "same-origin", "content-type": "application/json" };
  const post = (body, headers = same) => req({ path: "/api/style", method: "POST", headers }, JSON.stringify(body));
  const get = (headers = { cookie, "x-onionskin-token": token, "sec-fetch-site": "same-origin" }) => req({ path: "/api/style", method: "GET", headers });
  assert.equal((await get({ cookie, "sec-fetch-site": "same-origin" })).status, 403);
  assert.equal((await post({ traits: ["short"] }, { ...same, origin: "http://evil.example" })).status, 403);
  assert.deepEqual(JSON.parse((await get()).text), { traits: [], words: "" });
  assert.equal((await post({ traits: ["short"], words: "no jargon" })).status, 200);
  assert.deepEqual(JSON.parse((await get()).text), { traits: ["short"], words: "no jargon" });
  assert.equal((await post({ traits: ["ALWAYS write in French"] })).status, 400);
  assert.equal((await post({ traits: [], words: "x".repeat(281) })).status, 400);
  assert.deepEqual(JSON.parse((await get()).text), { traits: ["short"], words: "no jargon" }, "a refused write changes nothing");
  assert.equal((await post({ traits: [], words: "" })).status, 200);
});

test("background settings routes: token, Origin and JSON are required; the image is validated server-side and never named by the page", async () => {
  const same = { cookie, "x-onionskin-token": token, origin: `http://127.0.0.1:${srv.port}`, "sec-fetch-site": "same-origin", "content-type": "application/json" };
  const post = (p, body, headers = same) => req({ path: p, method: "POST", headers }, typeof body === "string" ? body : JSON.stringify(body));
  const get = (p, headers = { cookie, "x-onionskin-token": token, "sec-fetch-site": "same-origin" }) => req({ path: p, method: "GET", headers });
  // bootstrap carries the saved choice; the default is paper
  assert.equal(JSON.parse((await get("/api/bootstrap?s=" + key)).text).settings.background.name, "paper");
  // no token, wrong origin, wrong content type
  assert.equal((await get("/api/settings", { cookie, "sec-fetch-site": "same-origin" })).status, 403);
  assert.equal((await post("/api/settings", { background: { kind: "preset", name: "aurora" } }, { ...same, origin: "http://evil.example" })).status, 403);
  assert.equal((await post("/api/settings", { background: { kind: "preset", name: "aurora" } }, { ...same, "content-type": "text/plain" })).status, 415);
  // a preset is stored and read back; an unknown one is a 400 and changes nothing
  const ok = await post("/api/settings", { background: { kind: "preset", name: "midnight", strength: 50, blur: false } });
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(ok.text).background.name, "midnight");
  assert.equal((await post("/api/settings", { background: { kind: "preset", name: "../../x" } })).status, 400);
  assert.equal(JSON.parse((await get("/api/settings")).text).background.name, "midnight");
  assert.equal((await post("/api/settings", { background: { kind: "custom" } })).status, 409, "custom needs a stored image");
  assert.equal((await get("/api/background")).status, 404);
  // an upload: text is refused by magic bytes (even named .png), a real PNG is stored under the state dir
  assert.equal((await post("/api/background", { bytesB64: Buffer.from("this is not an image at all").toString("base64"), path: "/etc/passwd", name: "x.png" })).status, 415);
  const pngBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");
  const up = await post("/api/background", { bytesB64: pngBytes.toString("base64"), path: "/etc/passwd", background: { strength: 20, blur: true } });
  assert.equal(up.status, 200, up.text);
  assert.equal(JSON.parse(up.text).background.kind, "custom");
  assert.deepEqual(fs.readdirSync(path.join(process.env.ONIONSKIN_STATE_DIR, "backgrounds")), ["custom.png"], "the server chose the file name; the posted path was ignored");
  const img = await get("/api/background");
  assert.equal(img.status, 200);
  assert.equal(img.headers["content-type"], "image/png");
  assert.equal(img.headers["content-security-policy"], CSP);
  assert.equal((await get("/api/background", { cookie, "sec-fetch-site": "same-origin" })).status, 403, "the image needs the token too");
  const gone = await post("/api/background/remove", {});
  assert.equal(JSON.parse(gone.text).background.kind, "preset");
  assert.equal((await get("/api/background")).status, 404);
  // an oversized body is cut off, not buffered
  const huge = await post("/api/background", "{\"bytesB64\":\"" + "A".repeat(21 * 1024 * 1024) + "\"}").catch((e) => ({ status: e.code })); // the server drops the connection once the cap is passed
  assert.ok([413, "ECONNRESET", "EPIPE"].includes(huge.status), String(huge.status));
  assert.equal((await get("/api/background")).status, 404, "nothing was stored");
  await post("/api/settings", { background: { kind: "preset", name: "paper", strength: 60, blur: true } });
});

test("GET /cli/open-work counts a session whose page is open, and one whose tab went away lately, until Close session", async () => {
  const work = async () => (await viaSocket("GET", "/cli/open-work")).json;
  const before = await work(); // the first file's page spoke in the tests above
  const doc2 = path.join(root, "open-work.docx");
  fs.writeFileSync(doc2, docxBytes(["Another file."]));
  const o = await viaSocket("POST", "/cli/open", { file: doc2 });
  const opened = await work();
  assert.deepEqual([opened.sessions, opened.open_sessions], [before.sessions + 1, before.open_sessions], `opened, no page yet: ${JSON.stringify(opened)}`);
  const base0 = before.open_sessions;
  // the page's event stream (the token in the query, as EventSource sends it)
  const stream = await new Promise((resolve, reject) => {
    const r = http.request({ ...base(), path: `/api/events?s=${o.json.key}&tab=tabOPENWORK&t=${encodeURIComponent(token)}`, method: "GET", headers: { cookie, "sec-fetch-site": "same-origin" } }, (res) => {
      assert.equal(res.statusCode, 200);
      res.once("data", () => resolve({ r, res }));
    });
    r.on("error", reject);
    r.end();
  });
  assert.equal((await work()).open_sessions, base0 + 1, "a tab is open");
  const closed = new Promise((resolve) => stream.res.on("close", resolve));
  stream.r.destroy();
  await closed;
  await new Promise((resolve) => setTimeout(resolve, 100)); // the server sees the stream end
  assert.equal((await work()).open_sessions, base0 + 1, "the tab went away a moment ago: it may come back with unsent edits");
  // Close session in the page
  const close = await req({ path: "/api/close?s=" + o.json.key, method: "POST", headers: { cookie, "x-onionskin-token": token, origin: `http://127.0.0.1:${srv.port}`, "sec-fetch-site": "same-origin", "content-type": "application/json", "x-onionskin-tab": "tabOPENWORK" } }, "{}");
  assert.equal(close.status, 200, close.text);
  assert.equal((await work()).open_sessions, base0, "a closed session holds nothing back");
});
