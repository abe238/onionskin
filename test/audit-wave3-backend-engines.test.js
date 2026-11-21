import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildZip, contentTypes, docxBytes, tmpdir, xlsxBytes } from "./helpers/zipbuild.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = fs.realpathSync(tmpdir("audit-w3-"));
const state = path.join(root, "st");
const dist = path.join(root, "dist");
fs.mkdirSync(state, { recursive: true, mode: 0o700 });
fs.mkdirSync(dist, { recursive: true });
fs.writeFileSync(path.join(dist, "index.html"), "<!doctype html><title>t</title>");
fs.writeFileSync(path.join(dist, "app.js"), "console.log('ok');");

process.env.ONIONSKIN_STATE_DIR = state;
process.env.ONIONSKIN_WEB_DIST = dist;
process.env.ONIONSKIN_TICK_MS = "100000";
process.env.ONIONSKIN_NO_SOFFICE = "1";
process.env.ONIONSKIN_LEASE_MS = "5000";
delete process.env.ONIONSKIN_PYTHON;

const { ensureStateDir, socketPath } = await import("../src/paths.js");
await import("../src/html-parser.js");
const { startServer } = await import("../src/server.js");
const { req, stopServer, ensureServer, openBrowserArgs } = await import("../src/cli.js");
const { atomicReplace, writeSiblingCopy } = await import("../src/fsutil.js");
const { anchorsOffThread, startWorker } = await import("../src/offload.js");
const { TableEdit } = await import("../src/ops/docx-table.js");
const { attr, parse, serialize } = await import("../src/xml-tree.js");
const { parseWorkbook } = await import("../src/xlsx.js");
const { parseDeck } = await import("../src/pptx.js");
const { nodeChecks, partRels } = await import("../src/package.js");
const { openZip } = await import("../src/zip.js");
const { compareBytes } = await import("../src/history.js");
const { verifyTracked } = await import("../src/redline-check.js");
const { buildTracked } = await import("../src/redline.js");
const { SERVER_PROTOCOL } = await import("../src/constants.js");
ensureStateDir();

const children = [];
const servers = [];
after(async () => {
  if (sharedSrv) {
    try {
      sharedSrv.shutdown();
    } catch {}
  }
  for (const s of servers) {
    try {
      s.closeAllConnections?.();
      s.close();
    } catch {}
  }
  for (const c of children) {
    try {
      c.kill("SIGKILL");
    } catch {}
  }
  fs.rmSync(root, { recursive: true, force: true });
});

function httpReq(port, method, reqPath, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, method, path: reqPath, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    r.on("error", reject);
    if (body != null) r.write(body);
    r.end();
  });
}

async function openBrowserSession(srv, docPath) {
  const s = await srv.sessions.openAsync(docPath);
  const nonce = srv.auth.newNonce();
  const r1 = await httpReq(srv.port, "GET", `/?s=${s.key}&n=${nonce}`, { headers: { host: `127.0.0.1:${srv.port}` } });
  const cookie = r1.headers["set-cookie"]?.[0].split(";")[0];
  const m = /<meta name="onionskin-launch" content="([^"]+)">/.exec(r1.text);
  const token = m?.[1];
  const tab = "tab_w3_test_1";
  const r2 = await httpReq(srv.port, "GET", `/api/bootstrap?s=${s.key}`, {
    headers: { host: `127.0.0.1:${srv.port}`, cookie, "x-onionskin-token": token, "x-onionskin-tab": tab },
  });
  assert.equal(r2.status, 200);
  const headers = {
    host: `127.0.0.1:${srv.port}`,
    origin: `http://127.0.0.1:${srv.port}`,
    "sec-fetch-site": "same-origin",
    cookie,
    "x-onionskin-token": token,
    "x-onionskin-tab": tab,
    "content-type": "application/json",
  };
  return { s, headers, tab };
}

// ---- 1. BE-08 & BE-04: src/cli.js -----------------------------------------------------------------------------

test("BE-08: req() destroys request and rejects on timeout", async () => {
  const savedState = process.env.ONIONSKIN_STATE_DIR;
  const st = path.join(root, "st-req-to");
  fs.mkdirSync(st, { recursive: true, mode: 0o700 });
  process.env.ONIONSKIN_STATE_DIR = st;
  const sock = path.join(st, "s.sock");
  const srv = http.createServer((_req, _res) => {
    // never respond
  });
  servers.push(srv);
  await new Promise((resolve) => srv.listen(sock, resolve));
  try {
    await assert.rejects(() => req({ method: "GET", path: "/slow", timeout: 50 }), /request timed out/);
  } finally {
    process.env.ONIONSKIN_STATE_DIR = savedState;
    srv.closeAllConnections?.();
    srv.close();
  }
});

test("BE-04: stopServer() probes /health and stops protocol-mismatch servers", async () => {
  const savedState = process.env.ONIONSKIN_STATE_DIR;
  const st = path.join(root, "st-stop-mm");
  fs.mkdirSync(st, { recursive: true, mode: 0o700 });
  process.env.ONIONSKIN_STATE_DIR = st;
  const sock = path.join(st, "s.sock");
  const child = spawn(
    process.execPath,
    [
      "-e",
      `const http=require("http");const s=http.createServer((q,r)=>{if(q.url==="/health"){r.setHeader("content-type","application/json");r.end(JSON.stringify({ok:true,pid:process.pid,protocol:${SERVER_PROTOCOL + 99}}))}else if(q.method==="POST"&&q.url==="/cli/stop"){r.setHeader("content-type","application/json");r.end(JSON.stringify({ok:true}));setTimeout(()=>{s.close();process.exit(0)},30)}else{r.statusCode=404;r.end()}});s.listen(${JSON.stringify(sock)},()=>console.log("up"))`,
    ],
    { stdio: ["ignore", "pipe", "ignore"] }
  );
  children.push(child);
  await new Promise((r) => child.stdout.once("data", r));
  const exited = new Promise((r) => child.once("exit", (code) => r(code)));
  try {
    await stopServer();
    assert.equal(await exited, 0);
    assert.equal(fs.existsSync(sock), false);
  } finally {
    process.env.ONIONSKIN_STATE_DIR = savedState;
  }
});

test("BE-04: ensureServer() captures child.stderr in failure error", async () => {
  const savedState = process.env.ONIONSKIN_STATE_DIR;
  const st = path.join(root, "st-ensure-err");
  fs.mkdirSync(st, { recursive: true, mode: 0o700 });
  // Make s.sock a non-empty directory so server-entry fails to unlink it and logs to stderr
  const sockDir = path.join(st, "s.sock");
  fs.mkdirSync(sockDir);
  fs.writeFileSync(path.join(sockDir, "keep"), "x");
  process.env.ONIONSKIN_STATE_DIR = st;
  try {
    await assert.rejects(() => ensureServer(), (err) => {
      assert.match(err.message, /did not come up:/);
      return true;
    });
  } finally {
    process.env.ONIONSKIN_STATE_DIR = savedState;
  }
});

test("BE-04: openBrowserArgs() escapes '&' as '^&' on win32", () => {
  const [bin, args] = openBrowserArgs("http://127.0.0.1:4321/?s=abc&n=def&x=1", "win32");
  assert.equal(bin, "cmd");
  assert.deepEqual(args, ["/c", "start", "", "http://127.0.0.1:4321/?s=abc^&n=def^&x=1"]);
});

// ---- 2. BE-11 & BE-16: src/server.js, src/fsutil.js, src/offload.js ------------------------------------------

let sharedSrv = null;
async function getSharedSrv() {
  if (!sharedSrv) {
    process.env.ONIONSKIN_STATE_DIR = state;
    sharedSrv = await startServer({ port: 0 });
    servers.push(sharedSrv.tcp, sharedSrv.unix);
  }
  return sharedSrv;
}

test("BE-11: malformed '%' throws 400 invalid URL encoding in serveStatic and /api/history/:id", async () => {
  const srv = await getSharedSrv();
  const doc = path.join(root, "doc-uri.docx");
  fs.writeFileSync(doc, docxBytes(["Hello world."]));
  const { s, headers } = await openBrowserSession(srv, doc);

  const rStatic = await httpReq(srv.port, "GET", "/%E0%A4%A", { headers });
  assert.equal(rStatic.status, 400);
  assert.equal(JSON.parse(rStatic.text).error, "invalid URL encoding");

  const rHist = await httpReq(srv.port, "GET", `/api/history/%ZZ?s=${s.key}`, { headers });
  assert.equal(rHist.status, 400);
  assert.equal(JSON.parse(rHist.text).error, "invalid URL encoding");
});

test("BE-11: metadata routes enforce 16 KB cap while document routes keep larger cap", async () => {
  const srv = await getSharedSrv();
  const doc = path.join(root, "doc-cap.docx");
  fs.writeFileSync(doc, docxBytes(["Hello world."]));
  const { s, headers } = await openBrowserSession(srv, doc);

  const over16k = JSON.stringify({ pad: "x".repeat(17 * 1024) });
  const metaRoutes = [
    "/api/claim",
    "/api/answer",
    "/api/review",
    "/api/suggestion",
    "/api/takeback",
    "/api/revert",
    "/api/show-copy",
    "/api/dismiss-conflict",
    "/api/close",
  ];
  for (const route of metaRoutes) {
    const r = await httpReq(srv.port, "POST", `${route}?s=${s.key}`, { headers, body: over16k });
    assert.equal(r.status, 413, `${route} should reject >16KB with 413, got ${r.status}`);
    assert.equal(JSON.parse(r.text).code, "too_large_request");
  }

  // Document-uploading routes must NOT reject 20 KB body with 413
  const body20k = JSON.stringify({ pad: "x".repeat(20 * 1024), baseSha: "0".repeat(64) });
  const rSend = await httpReq(srv.port, "POST", `/api/send?s=${s.key}`, { headers, body: body20k });
  assert.notEqual(rSend.status, 413);

  const rResolve = await httpReq(srv.port, "POST", `/api/resolve?s=${s.key}`, { headers, body: body20k });
  assert.notEqual(rResolve.status, 413);

  const rVoice = await httpReq(srv.port, "POST", `/api/voice/build?s=${s.key}`, { headers, body: body20k });
  assert.notEqual(rVoice.status, 413);
});

test("BE-11 / R10: /api/review and /api/suggestion serialize through sessions.inTurn while /api/merge (incl. 423), /api/voice/build and /api/close do not block behind it", async () => {
  const srv = await getSharedSrv();
  const doc = path.join(root, "doc-turn.docx");
  fs.writeFileSync(doc, docxBytes(["Hello world."]));
  const { s, headers } = await openBrowserSession(srv, doc);

  const withTimeout = (promise, ms, label) =>
    Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms (blocked behind inTurn)`)), ms)),
    ]);

  const inTurnKeys = [];
  const origInTurn = srv.sessions.inTurn.bind(srv.sessions);
  srv.sessions.inTurn = (key, fn) => {
    inTurnKeys.push(key);
    return origInTurn(key, fn);
  };

  let releaseGate;
  const gate = new Promise((r) => (releaseGate = r));
  const held = origInTurn(s.key, () => gate);

  const reviewReq = httpReq(srv.port, "POST", `/api/review?s=${s.key}`, { headers, body: JSON.stringify({ kind: "clarity" }) });
  const sugReq = httpReq(srv.port, "POST", `/api/suggestion?s=${s.key}`, { headers, body: JSON.stringify({ ids: [], choice: 1 }) });

  try {
    // 1. /api/merge must not wait for inTurn; while s.merging is set it immediately returns 423 locked
    s.merging = true;
    const mergeLocked = await withTimeout(
      httpReq(srv.port, "POST", `/api/merge?s=${s.key}`, { headers, body: JSON.stringify({ baseSha: s.sha }) }),
      5000,
      "/api/merge (423)"
    );
    assert.equal(mergeLocked.status, 423, "/api/merge returns 423 while another merge is active without waiting for inTurn");
    assert.equal(JSON.parse(mergeLocked.text).code, "locked");
    s.merging = false;

    const mergeUnqueued = await withTimeout(
      httpReq(srv.port, "POST", `/api/merge?s=${s.key}`, { headers, body: JSON.stringify({ baseSha: s.sha }) }),
      5000,
      "/api/merge"
    );
    assert.notEqual(mergeUnqueued.status, 423);

    // 2. /api/voice/build must not wait for inTurn
    const voiceRes = await withTimeout(
      httpReq(srv.port, "POST", `/api/voice/build?s=${s.key}`, { headers, body: JSON.stringify({ files: [] }) }),
      5000,
      "/api/voice/build"
    );
    assert.ok(voiceRes.status >= 200 && voiceRes.status < 500, `/api/voice/build completed immediately (status ${voiceRes.status})`);

    // 3. /api/close must not wait for inTurn
    await withTimeout(
      httpReq(srv.port, "POST", `/api/close?s=${s.key}`, { headers, body: "{}" }),
      5000,
      "/api/close"
    );
    assert.equal(s.closed, true, "/api/close completes immediately without waiting for inTurn gate (R10)");
  } finally {
    s.merging = false;
    releaseGate();
    await held;
    await Promise.all([reviewReq, sugReq]);
    srv.sessions.inTurn = origInTurn;
  }
  assert.ok(inTurnKeys.filter((k) => k === s.key).length >= 2);
});

test("BE-11: SSE handles write errors and deletes empty Set on disconnect", async () => {
  const srv = await getSharedSrv();
  const doc = path.join(root, "doc-sse.docx");
  fs.writeFileSync(doc, docxBytes(["Hello world."]));
  const { s, headers } = await openBrowserSession(srv, doc);
  const tok = headers["x-onionskin-token"];

  const sseConn = await new Promise((resolve, reject) => {
    const r = http.request(
      { host: "127.0.0.1", port: srv.port, method: "GET", path: `/api/events?s=${s.key}&t=${encodeURIComponent(tok)}&tab=tab_sse_1`, headers: { host: `127.0.0.1:${srv.port}`, cookie: headers.cookie } },
      (res) => {
        res.once("data", () => resolve({ req: r, res }));
      }
    );
    r.on("error", reject);
    r.end();
  });

  const openBefore = await httpReq(srv.port, "GET", `/api/bootstrap?s=${s.key}`, { headers });
  assert.equal(openBefore.status, 200);
  // Destroy socket abruptly and emit a session change
  sseConn.res.destroy();
  sseConn.req.destroy();
  await new Promise((r) => setTimeout(r, 40));
  assert.doesNotThrow(() => srv.sessions.emit("change", s, "reload"));
});

test("BE-16: atomicReplace ignores EINVAL/ENOTSUP/EPERM/EROFS on directory fsyncSync", () => {
  const dir = path.join(root, "fsync-dir");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "doc.txt");
  fs.writeFileSync(file, "v0");

  const origFsync = fs.fsyncSync;
  try {
    for (const code of ["EINVAL", "ENOTSUP", "EPERM", "EROFS"]) {
      let calls = 0;
      fs.fsyncSync = (fd) => {
        calls++;
        // First fsync is file fd (stage), second is directory fd
        if (calls === 2) throw Object.assign(new Error(code), { code });
        return origFsync(fd);
      };
      atomicReplace(file, Buffer.from(`v-${code}`));
      assert.equal(fs.readFileSync(file, "utf8"), `v-${code}`);
    }
    fs.fsyncSync = (fd) => {
      throw Object.assign(new Error("EIO"), { code: "EIO" });
    };
    assert.throws(() => atomicReplace(file, Buffer.from("fail")), /EIO/);
  } finally {
    fs.fsyncSync = origFsync;
  }
});

test("BE-16: writeSiblingCopy falls back to copyFileSync on EXDEV/ENOTSUP/EPERM", () => {
  const dir = path.join(root, "sibling-dir");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "notes.docx");
  fs.writeFileSync(file, "orig");

  const origLink = fs.linkSync;
  try {
    for (const code of ["EXDEV", "ENOTSUP", "EPERM"]) {
      fs.linkSync = () => {
        throw Object.assign(new Error(code), { code });
      };
      const out = writeSiblingCopy(file, Buffer.from(`copy-${code}`), { now: new Date(2026, 0, 2, 3, 4) });
      assert.ok(fs.existsSync(out.path));
      assert.equal(fs.readFileSync(out.path, "utf8"), `copy-${code}`);
    }
  } finally {
    fs.linkSync = origLink;
  }
});

test("BE-16: startWorker().terminate() unrefs timer and enforces 10s ceiling", async () => {
  const origSetTimeout = globalThis.setTimeout;
  const unreffed = [];
  const callbacks = [];
  let fakeNow = 1000;
  const origNow = Date.now;
  Date.now = () => fakeNow;
  globalThis.setTimeout = (fn, ms, ...args) => {
    if (ms === 2 || ms === 10) {
      callbacks.push(fn);
      const fake = { unrefCalled: false, unref() { this.unrefCalled = true; unreffed.push(this); return this; } };
      return fake;
    }
    return origSetTimeout(fn, ms, ...args);
  };
  let w;
  try {
    // Pass a valid worker script that stays open briefly; terminate before flag[0]===1 and advance fakeNow past 10s
    w = startWorker("anchor-worker.js");
    const termP = w.terminate();
    assert.ok(unreffed.length >= 1 && unreffed.every((t) => t.unrefCalled), "tryStop timer must be unref'd");
    fakeNow += 11_000;
    const cb = callbacks.shift();
    if (cb) cb();
    await termP;
  } finally {
    globalThis.setTimeout = origSetTimeout;
    Date.now = origNow;
    await w?.terminate().catch(() => {});
  }
});

test("BE-16: anchorsOffThread catches synchronous postMessage errors without leaving worker stuck", async () => {
  const r = await anchorsOffThread({
    format: "docx",
    source: { bytes: Buffer.from("x") },
    check: null,
    tasks: [],
    outline: false,
    uncloneable: () => {},
  });
  assert.equal(r.failed, "crashed");
  assert.ok(r.why.length > 0);
});

// ---- 3. ENG-08: Engine hygiene fixes -------------------------------------------------------------------------

test("ENG-08: docx-table rejects lone surrogates and skips width scaling when total===0", () => {
  const tbl = parse(
    `<w:tbl><w:tblGrid><w:gridCol w:w="0"/><w:gridCol w:w="0"/></w:tblGrid>` +
      `<w:tr><w:tc><w:tcPr><w:tcW w:w="0" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>a</w:t></w:r></w:p></w:tc>` +
      `<w:tc><w:tcPr><w:tcW w:w="0" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>b</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`
  ).kids[0];
  const ed = new TableEdit(tbl);
  ed.insertColumn(0, "after", ["mid"]);
  const gridCols = tbl.kids.find((k) => k.name === "w:tblGrid").kids;
  assert.equal(gridCols.length, 3);
  for (const gc of gridCols) assert.notEqual(attr(gc, "w:w"), "NaN");
  assert.doesNotMatch(serialize(tbl), /NaN/);

  assert.throws(() => ed.insertRow(0, "after", ["bad\uD800"]), { code: "bad_text" });
  assert.throws(() => ed.insertRow(0, "after", ["bad\uDC00"]), { code: "bad_text" });
  assert.doesNotThrow(() => ed.insertRow(0, "after", ["good\uD83D\uDE00", "ok", "ok"]));
});

test("ENG-08: xlsx handles omitted <c r>, rejects out-of-range rows, and treats empty t='b' as empty", () => {
  const sheetXml =
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>` +
    `<row><c><v>10</v></c><c r="C1"><v>30</v></c><c><v>40</v></c></row>` +
    `<row r="2"><c t="b"/><c t="b"><v>0</v></c><c t="b"><v>1</v></c></row>` +
    `<row r="1048576"><c r="A1048576"><v>last</v></c></row>` +
    `<row r="1048577"><c r="A1048577"><v>tooHigh</v></c></row>` +
    `<row r="1"><c r="A0"><v>tooLow</v></c></row>` +
    `</sheetData></worksheet>`;
  const bytes = buildZip({
    "[Content_Types].xml": contentTypes("xlsx"),
    "_rels/.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="x/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    "xl/workbook.xml": '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="x/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    "xl/worksheets/sheet1.xml": sheetXml,
  });
  const wb = parseWorkbook(bytes);
  const sc = wb.sheetCells(wb.sheets[0]);
  const at = (r, c) => sc.cells.get(r * 16384 + c)?.text;

  assert.equal(at(0, 0), "10"); // A1 omitted r
  assert.equal(at(0, 2), "30"); // C1 explicit r
  assert.equal(at(0, 3), "40"); // D1 omitted r after C1
  assert.equal(at(1, 0), undefined); // empty t="b" -> not "FALSE"
  assert.equal(at(1, 1), "FALSE"); // t="b" v=0
  assert.equal(at(1, 2), "TRUE"); // t="b" v=1
  assert.equal(at(1_048_575, 0), "last"); // max valid row
  assert.equal(sc.cells.has(1_048_576 * 16384), false); // row 1048577 rejected
  assert.equal(sc.cells.has(-1 * 16384), false); // row 0 rejected
});

test("ENG-08: pptx skips mc:Fallback elements and parses cNvPr id strictly", () => {
  const slideXml =
    `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">` +
    `<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>` +
    `<mc:AlternateContent><mc:Choice Requires="p14">` +
    `<p:sp><p:nvSpPr><p:cNvPr id="42" name="Choice"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:txBody><a:p><a:r><a:t>Keep me</a:t></a:r></a:p></p:txBody></p:sp>` +
    `</mc:Choice><mc:Fallback>` +
    `<p:sp><p:nvSpPr><p:cNvPr id="99" name="Fallback"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:txBody><a:p><a:r><a:t>Skip fallback</a:t></a:r></a:p></p:txBody></p:sp>` +
    `</mc:Fallback></mc:AlternateContent>` +
    `<p:sp><p:nvSpPr><p:cNvPr id="bad_id" name="BadId"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:txBody><a:p><a:r><a:t>Bad id shape</a:t></a:r></a:p></p:txBody></p:sp>` +
    `</p:spTree></p:cSld></p:sld>`;
  const bytes = buildZip({
    "[Content_Types].xml": contentTypes("pptx"),
    "_rels/.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="x/officeDocument" Target="ppt/presentation.xml"/></Relationships>',
    "ppt/presentation.xml": '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>',
    "ppt/_rels/presentation.xml.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>',
    "ppt/slides/slide1.xml": slideXml,
  });
  const deck = parseDeck(bytes);
  deck.ensure();
  assert.equal(deck.slides[0].shapes.length, 2);
  assert.equal(deck.slides[0].shapes[0].id, 42);
  assert.equal(deck.slides[0].shapes[0].text, "Keep me");
  assert.equal(deck.slides[0].shapes[1].id, -1);
});

test("ENG-08: package relTargets and partRels resolve percent-encoded ZIP entry targets", () => {
  const bytes = buildZip({
    "[Content_Types].xml": contentTypes("docx"),
    "_rels/.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    "word/document.xml": '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>hi</w:t></w:r></w:p></w:body></w:document>',
    "word/_rels/document.xml.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/my%20pic.png"/></Relationships>',
    "word/media/my pic.png": Buffer.from([137, 80, 78, 71]),
  });
  const flags = nodeChecks(bytes, bytes, "docx");
  assert.equal(flags.some((f) => f.code === "relationship_target_missing"), false);
  const z = openZip(bytes);
  const rels = partRels(z, "word/document.xml");
  assert.equal(rels[0].target, "word/media/my pic.png");
});

test("ENG-08: history compareBytes('html') pairs same-tag units in gap via Map", () => {
  const before = Buffer.from(
    `<!doctype html><html><body>` +
      `<p>keep 1</p><p>old a</p><h2>old h</h2><p>old b</p><div>only old</div><p>keep 2</p>` +
      `</body></html>`
  );
  const after = Buffer.from(
    `<!doctype html><html><body>` +
      `<p>keep 1</p><p>new a</p><p>new b</p><h2>new h</h2><span>only new</span><p>keep 2</p>` +
      `</body></html>`
  );
  const diff = compareBytes("html", before, after, { places: true });
  assert.equal(diff.counts.changed, 3);
  assert.equal(diff.counts.added, 1);
  assert.equal(diff.counts.removed, 1);
  const modified = diff.places.filter((p) => p.change === "modified");
  assert.equal(modified.length, 3);
  assert.deepEqual(modified[0].diff, [["-", "old"], ["+", "new"], ["=", " a"]]);
});

test("ENG-08: verifyTracked skips inflating identical raw parts and handles >150k inputIds without stack overflow", () => {
  const before = docxBytes(["Alpha paragraph.", "Beta paragraph."]);
  const after = docxBytes(["Alpha updated.", "Beta paragraph."]);
  // Add an identical compressed non-document part to before/after so verifyTracked compares raw bytes first
  const extraPart = Buffer.alloc(1024, 0x41);
  const withMedia = (b) => {
    const z = openZip(b);
    const map = Object.fromEntries(z.names.map((n) => [n, z.read(n)]));
    map["word/media/big.bin"] = extraPart;
    return buildZip(map);
  };
  const b2 = withMedia(before);
  const a2 = withMedia(after);
  const res = buildTracked({ before: b2, after: a2, author: "Test", date: "2026-01-01T00:00:00Z" });
  const v1 = verifyTracked({ before: b2, after: a2, out: res.bytes, counts: res.counts, author: "Test", date: "2026-01-01T00:00:00Z" });
  assert.equal(v1.ok, true, v1.why);

  // Stress maxIn loop with >150,000 numeric w:id attributes in an auxiliary XML part
  const manyIds = Array.from({ length: 160_000 }, (_, i) => `<w:p w:id="${i + 1}"/>`).join("");
  const withManyIds = (b) => {
    const z = openZip(b);
    const map = Object.fromEntries(z.names.map((n) => [n, z.read(n)]));
    map["word/extraIds.xml"] = `<w:root xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${manyIds}</w:root>`;
    return buildZip(map);
  };
  const b3 = withManyIds(before);
  const a3 = withManyIds(after);
  const res3 = buildTracked({ before: b3, after: a3, author: "Test", date: "2026-01-01T00:00:00Z" });
  const v3 = verifyTracked({ before: b3, after: a3, out: res3.bytes, counts: res3.counts, author: "Test", date: "2026-01-01T00:00:00Z" });
  assert.equal(v3.ok, true, v3.why);
});
