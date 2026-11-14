// Security pass: hostile archives, oversized input, and a server that stays responsive during a heavy check (findings 6, 7 partly).
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import zlib from "node:zlib";
import { test, before, after } from "node:test";
import { tmpdir, buildZip, docxBytes } from "./helpers/zipbuild.js";

const root = tmpdir();
process.env.ONIONSKIN_STATE_DIR = path.join(root, "st");
process.env.ONIONSKIN_LEASE_MS = "600000";
process.env.ONIONSKIN_TICK_MS = "100000";
process.env.ONIONSKIN_NO_SOFFICE = "1";
// a stand-in "deeper checker" that takes two seconds, so `done` has something slow to run
const slowPy = path.join(root, "slow-python");
fs.writeFileSync(slowPy, '#!/bin/sh\nsleep 2\necho \'{"flags":[],"ran":["slow"],"skipped":[]}\'\n', { mode: 0o755 });
process.env.ONIONSKIN_PYTHON = slowPy;
const { openZip, ZipError, MAX_TOTAL_EXPANSION } = await import("../src/zip.js");
const { validatePackage, nodeChecks } = await import("../src/package.js");
const { Sessions, HttpError } = await import("../src/session.js");
const { startServer } = await import("../src/server.js");
const { socketPath, ensureStateDir } = await import("../src/paths.js");
ensureStateDir();
let srv;
before(async () => {
  srv = await startServer();
});
after(() => srv.shutdown());

/** a ZIP with entries given as {name: {method, data(raw)}}; the central directory declares what we say (sizes are what a hostile archive would lie about) */
function rawZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, { data, method = 8, declaredSize }] of Object.entries(entries)) {
    const comp = method === 8 ? zlib.deflateRawSync(data) : data;
    const nameBuf = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(declaredSize ?? data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(declaredSize ?? data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

test("finding 6: a stored entry is bounded by the per-entry cap exactly like an inflated one", () => {
  const z = openZip(rawZip({ "a.xml": { method: 0, data: Buffer.alloc(16, 0x41) }, "b.xml": { method: 8, data: Buffer.alloc(16, 0x41) } }));
  assert.throws(() => z.read("a.xml", 4), ZipError, "a 16-byte stored entry with cap=4");
  assert.throws(() => z.read("b.xml", 4), ZipError, "the inflated twin too");
  assert.equal(z.read("a.xml", 16).length, 16);
});

test("finding 6: a cumulative expansion budget per archive stops thousands of individually allowed parts", () => {
  const entries = {};
  for (let i = 0; i < 300; i++) entries[`r${i}/_rels/.rels`] = { data: Buffer.alloc(1024 * 1024, 0x20) }; // 300 x 1 MB of spaces, a few hundred bytes each compressed
  const buf = rawZip(entries);
  assert.ok(buf.length < 1024 * 1024, "the archive itself is small");
  const z = openZip(buf);
  const t0 = Date.now();
  assert.throws(() => {
    for (const n of z.names) z.read(n);
  }, /expansion budget exceeded/);
  assert.ok(Date.now() - t0 < 10_000, `stopped promptly (${Date.now() - t0} ms)`);
  assert.ok(MAX_TOTAL_EXPANSION <= 256 * 1024 * 1024);
});

test("finding 6: thousands of small relationship parts are refused by the checks, not scanned", () => {
  const base = docxBytes(["x"]);
  const zin = openZip(base);
  const entries = {};
  for (const n of zin.names) entries[n] = { data: zin.read(n) };
  for (let i = 0; i < 6000; i++) entries[`word/p${i}/_rels/x.rels`] = { data: Buffer.from('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>') };
  const hostile = rawZip(entries);
  const t0 = Date.now();
  const flags = nodeChecks(base, hostile, "docx");
  assert.ok(Date.now() - t0 < 5000);
  assert.ok(flags.some((f) => f.code === "invalid_package" && f.severity === "error" && /too many relationship parts/.test(f.detail)), JSON.stringify(flags));
});

test("finding 6: an oversized input is refused by size before it is read", () => {
  const big = path.join(root, "big.docx");
  fs.writeFileSync(big, "");
  fs.truncateSync(big, 201 * 1024 * 1024); // sparse: reading it would allocate 201 MB
  const S = new Sessions();
  const before = process.memoryUsage().rss;
  try {
    S.open(big);
    assert.fail("expected a refusal");
  } catch (e) {
    assert.ok(e instanceof HttpError);
    assert.equal(e.status, 413);
  }
  assert.ok(process.memoryUsage().rss - before < 100 * 1024 * 1024, "the file was not pulled into memory");
});

const viaSocket = (method, p, body) =>
  new Promise((resolve, reject) => {
    const t0 = Date.now();
    const r = http.request({ socketPath: socketPath(), method, path: p, headers: body ? { "content-type": "application/json" } : {} }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, ms: Date.now() - t0, json: JSON.parse(Buffer.concat(chunks).toString() || "{}") }));
    });
    r.on("error", reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });

test("finding 6: while `done` runs a large check (a 20 MB main part, a slow deeper checker) the server still answers status within 500 ms", async () => {
  const paraXml = '<w:p><w:r><w:t>Filler paragraph with some words in it to make the main part large enough.</w:t></w:r></w:p>';
  const body = paraXml.repeat(Math.ceil((20 * 1024 * 1024) / paraXml.length));
  const file = path.join(root, "large.docx");
  fs.writeFileSync(file, docxBytes([], {}, body));
  const real = fs.realpathSync(file);
  const s = srv.sessions.open(real);
  const poll = srv.sessions.poll(s.key, { holder: "L" });
  srv.sessions.send(s.key, { baseSha: s.baseSha, comments: [], note: "go" });
  const batch = await poll.promise;
  const done = viaSocket("POST", "/cli/done", { file: real, results: { summary: "ok", results: [] }, holder: "L", lease_token: batch.lease.token, batch_id: batch.batch_id });
  const latencies = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 1500) {
    latencies.push((await viaSocket("GET", `/cli/status?file=${encodeURIComponent(real)}`)).ms);
    await new Promise((r) => setTimeout(r, 100));
  }
  const d = await done;
  assert.equal(d.status, 200, JSON.stringify(d.json).slice(0, 300));
  assert.equal(d.json.checks.deep.status, "ran", "the slow deeper check really ran");
  assert.ok(latencies.length >= 8, `${latencies.length} status requests answered while done was running`);
  assert.ok(Math.max(...latencies) < 500, `slowest status answer ${Math.max(...latencies)} ms`);
});
