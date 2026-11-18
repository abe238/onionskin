// The acceptance test of the hostile-file round: a real server in a child process, a /health request from this process every 50 ms, and
// files past the readers' caps, and others well under them (at the caps: e2e/stall-cap.e2e.test.js), through open, Review, Send, delivery to an agent Onionskin started (poll with its outline), a
// queued comment, the agent's write, done, resolve and revert. /health must be answered within 2 s at every moment, the server must
// never exit, and a file past a cap gets a plain message (never "internal error"). Times are loose on purpose: the test Mac can be very
// busy; the worst measured here at a load average of 12 to 18 was 0.39 s.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { childServer, cpuWithin, everyPath, within } from "./helpers/stall.js";
import { docxAttrs, docxParas, pptxRuns, xlsxColumn, xlsxGrid, xlsxShared } from "./helpers/hostile.js";
import { docxBytes, xlsxBytes } from "./helpers/zipbuild.js";
import { openZip } from "../src/zip.js";
import { replaceEntry } from "../src/zip-write.js";

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const benign = { docx: () => docxBytes(["Hello there.", "Second paragraph."]), xlsx: () => xlsxGrid(3), pptx: () => pptxRuns(1, 2) };
const anchor = { docx: { location: { blockPath: [0] }, paraText: "a" }, xlsx: { location: { sheetIndex: 0, sheetName: "S1", range: "A1" } }, pptx: { location: { slideIndex: 0, shapeId: 2 }, quote: "a" } };

// Every path at sizes well under the caps here; at the caps they run in the slow group (e2e/stall-cap.e2e.test.js), one file at a time.
// Both of these failed on d731bab, before the hostile-file rounds: Word, done 3.1 s and resolve 6.1 s; Excel, review 2.9 s and poll 3.5 s.
test("a Word file of 10,000 paragraphs: every path keeps /health under 2 s", { timeout: 240_000 }, () => everyPath("docx", docxParas(10_000)));
test("an Excel file of 80,000 cells and 40,000 merged ranges: every path keeps /health under 2 s", { timeout: 240_000 }, () => everyPath("xlsx", xlsxGrid(80_000, 40_000)));

test("the reviewer's files past the caps: refused at open and at Send with a plain message, the file is not written, /health stays answered", { timeout: 240_000 }, async () => {
  const srv = await childServer();
  try {
    const files = {
      "a run of 3 million attributes (7.3 MB)": ["docx", docxAttrs(3_000_000), /(?:a tag in this file has more than 512 attributes|more than 32,000,000 characters of XML)/], // 37 MB of XML: the size cap counts first
      "100,000 cells and 100,000 merged ranges": ["xlsx", xlsxGrid(100_000, 100_000), /more than 50,000 merged ranges/],
      "3 slides of 2.85 million runs each": ["pptx", pptxRuns(3, 2_850_000), /this deck has more than (?:500,000 XML elements|32,000,000 characters of XML)/],
      // 517 KB, within every other cap: Review, delivery and done each held /health 4 to 6 s
      "249,000 cells showing one shared string of 20,000 characters": ["xlsx", xlsxShared(249_000, 20_000), /this workbook has more than 32,000,000 characters of text in its cells/],
      // a limit too, thrown as a plain error before: a swapped-in file of it was answered "internal error" (500)
      "XML nested 300 levels deep": ["docx", docxBytes([], {}, `${"<w:p>".repeat(300)}${"</w:p>".repeat(300)}`), /this file nests XML more than 256 levels deep/],
      "a sheet name of 100,000 characters": ["xlsx", xlsxColumn(3, 1, { name: "n".repeat(100_000) }), /a sheet in this workbook has a name longer than 255 characters/],
    };
    for (const [label, [format, bytes, reason]] of Object.entries(files)) {
      const hf = path.join(srv.root, `h-${format}.${format}`);
      fs.writeFileSync(hf, bytes);
      const o = await within(srv, `open ${label}`, () => srv.cli("POST", "/cli/open", { file: hf }));
      assert.equal(o.status, 400);
      assert.match(o.json.error, reason);
      // the file grew past a cap after it was opened: the page's Send of it is refused in plain words and nothing is written
      const f = path.join(srv.root, `d-${format}.${format}`);
      const b0 = benign[format]();
      fs.writeFileSync(f, b0);
      const { key } = await srv.openPage(f);
      const r = await within(srv, `send ${label}`, () => srv.api(key, "/api/send", { baseSha: sha(b0), bytesB64: bytes.toString("base64"), comments: [], note: "go" }));
      assert.equal(r.status, 422, JSON.stringify(r.json));
      assert.equal(r.json.code, "too_large");
      assert.match(r.json.error, new RegExp(`^Onionskin cannot read this file: .*${reason.source}.*\\.$`));
      assert.equal(sha(fs.readFileSync(f)), sha(b0), "the refused bytes were not written");
      // swapped on disk behind Onionskin: resolve reads only what its comments need (nothing of a workbook's sheets without one), and
      // what it cannot read it says plainly
      fs.writeFileSync(f, bytes);
      const res = await within(srv, `resolve ${label}`, () => srv.api(key, "/api/resolve", {}));
      assert.ok([200, 422].includes(res.status), `${res.status}`);
      if (res.status === 422) assert.match(res.json.error, reason);
      const rev = await within(srv, `review ${label}`, () => srv.api(key, "/api/review", { kind: "proofread" })); // never a 500
      if (rev.status === 422) assert.match(rev.json.error, reason);
    }
  } finally {
    await srv.stop();
  }
});

test("opens at once: at most two files are read at a time, the rest wait or are told the server is busy; /health stays answered", { timeout: 240_000 }, async () => {
  const srv = await childServer({ env: { ONIONSKIN_TEST_OPEN_DELAY_MS: "1500" } });
  try {
    const files = Array.from({ length: 20 }, (_, i) => {
      const f = path.join(srv.root, `many-${i}.docx`);
      fs.writeFileSync(f, docxBytes([`Document number ${i}.`]));
      return f;
    });
    const r = await within(srv, "20 opens at once", () => Promise.all(files.map((file) => srv.cli("POST", "/cli/open", { file }))));
    const busy = r.filter((x) => x.status === 503);
    assert.equal(r.filter((x) => x.status === 200).length + busy.length, 20, JSON.stringify(r.map((x) => x.status)));
    assert.equal(busy.length, 2, "two past the 2 reading and the 16 waiting");
    for (const b of busy) assert.match(b.json.error, /^Onionskin is busy opening other files: .*Try again in a minute\.$/);
  } finally {
    await srv.stop();
  }
});

test("a file refused at open is refused again at once when an agent polls it again and again (each poll opens a file that is not open)", { timeout: 240_000 }, async () => {
  const srv = await childServer({ env: { ONIONSKIN_TEST_OPEN_DELAY_MS: "1500" } });
  try {
    const hf = path.join(srv.root, "hostile.docx");
    fs.writeFileSync(hf, docxAttrs(100_000));
    const times = [];
    for (let i = 0; i < 4; i++) {
      const t = performance.now();
      const r = await within(srv, `poll ${i}`, () => srv.cli("GET", `/cli/poll?file=${encodeURIComponent(hf)}`));
      times.push(performance.now() - t);
      assert.equal(r.status, 400);
      assert.match(r.json.error, /more than 512 attributes/);
    }
    assert.ok(times[0] >= 1400, `the first poll read the file in the worker (${times[0].toFixed(0)} ms)`);
    for (const t of times.slice(1)) assert.ok(t < times[0], `a later poll was answered from the remembered refusal (${times.map((x) => x.toFixed(0)).join(", ")} ms)`);
  } finally {
    await srv.stop();
  }
});

test("ordinary files open well under a second; the CLI's open has a deadline and says so in plain words", { timeout: 240_000 }, async () => {
  const srv = await childServer();
  try {
    const samples = path.join(path.dirname(new URL(import.meta.url).pathname), "fixtures", "engine");
    for (const name of ["sample.docx", "sample.xlsx", "sample.pptx"]) {
      const f = path.join(srv.root, name);
      fs.copyFileSync(path.join(samples, name), f);
      const t = performance.now();
      assert.equal((await srv.cli("POST", "/cli/open", { file: f })).status, 200);
      const ms = performance.now() - t;
      assert.ok(ms < 3000, `${name} opened in ${ms.toFixed(0)} ms`); // about 100 to 250 ms here at a load average of 20
    }
  } finally {
    await srv.stop();
  }
  const slow = await childServer({ env: { ONIONSKIN_TEST_OPEN_DELAY_MS: "5000" } });
  try {
    const f = path.join(slow.root, "slow.docx");
    fs.writeFileSync(f, docxBytes(["slow to read"]));
    const { spawn } = await import("node:child_process");
    const cli = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "src", "cli.js");
    const c = spawn(process.execPath, [cli, "open", f, "--no-open"], { env: { PATH: process.env.PATH, HOME: slow.root, ONIONSKIN_STATE_DIR: slow.state, ONIONSKIN_NO_SOFFICE: "1", ONIONSKIN_AGENT_CLI: "none", ONIONSKIN_CLI_OPEN_DEADLINE_MS: "1500" }, stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    c.stderr.on("data", (d) => (err += d));
    const code = await new Promise((resolve) => c.on("exit", (x) => resolve(x)));
    assert.notEqual(code, 0);
    assert.match(err, /Onionskin did not finish opening slow\.docx within 2 seconds\. It may be very large or damaged, or this Mac is very busy\. Try again, or open a smaller file/);
    assert.equal(slow.exit, null, "the server lives on");
  } finally {
    await slow.stop();
  }
});

test("an agent's write past a cap is refused in plain words and not written; a file swapped past a cap behind Onionskin gets its outline left out with the reason", { timeout: 240_000 }, async () => {
  const srv = await childServer();
  try {
    const hostile = xlsxShared(249_000, 20_000);
    const reason = /^Onionskin cannot read this file: this workbook has more than 32,000,000 characters of text in its cells, more than Onionskin can read\. Split it into smaller workbooks and open those\.$/;
    const f = path.join(srv.root, "w.xlsx");
    const b0 = benign.xlsx();
    fs.writeFileSync(f, b0);
    const { key } = await srv.openPage(f);
    const real = fs.realpathSync(f);
    const c1 = { id: "c1", kind: "element", text: "check this", anchor: anchor.xlsx };
    await srv.api(key, "/api/send", { baseSha: sha(b0), comments: [c1], note: "a note" });
    const holder = `onionskin-term-${key}`;
    const polled = await srv.cli("GET", `/cli/poll?file=${encodeURIComponent(real)}&holder=${holder}`);
    const [batchId, token] = polled.json.lease_ticket.split(":");
    const w = await within(srv, "agent write past the cap", () => srv.cli("POST", "/cli/commit", { file: real, holder, batch_id: batchId, lease_token: token, base_sha256: sha(b0), bytes_b64: hostile.toString("base64") }));
    assert.equal(w.status, 422, JSON.stringify(w.json));
    assert.equal(w.json.code, "too_large");
    assert.match(w.json.error, reason);
    assert.equal(sha(fs.readFileSync(f)), sha(b0), "the refused bytes were not written");
    // bytes the readers find damaged (a closing tag with nothing open in the sheet): an invalid package in plain words, never a 500
    const grid = xlsxGrid(3);
    const damaged = replaceEntry(grid, "xl/worksheets/sheet1.xml", openZip(grid).readText("xl/worksheets/sheet1.xml").replace("<sheetData>", "<sheetData></row>"));
    const dw = await within(srv, "agent write of damaged bytes", () => srv.cli("POST", "/cli/commit", { file: real, holder, batch_id: batchId, lease_token: token, base_sha256: sha(b0), bytes_b64: damaged.toString("base64") }));
    assert.equal(dw.status, 422, JSON.stringify(dw.json));
    assert.equal(dw.json.code, "invalid_package");
    assert.match(dw.json.error, /^refusing to write: closing tag without an open element$/);
    assert.equal(sha(fs.readFileSync(f)), sha(b0));
    assert.equal((await within(srv, "done", () => srv.cli("POST", "/cli/done", { file: real, holder, batch_id: batchId, lease_token: token, results: [] }))).status, 200);
    // the next batch is delivered while the file on disk is past the cap (written by another program): no outline, and the reason
    await srv.api(key, "/api/send", { baseSha: sha(b0), comments: [{ ...c1, id: "c2" }], note: "again" });
    fs.writeFileSync(f, hostile);
    const p2 = await within(srv, "poll of a file past the cap", () => srv.cli("GET", `/cli/poll?file=${encodeURIComponent(real)}&holder=${holder}`));
    assert.equal(p2.status, 200, JSON.stringify(p2.json));
    const ev = p2.json.untrusted_document_evidence;
    assert.equal(ev.outline, undefined);
    assert.match(ev.outline_unavailable, reason);
  } finally {
    await srv.stop();
  }
});

test("a comment on one of 248,000 equal cells under a 20,000-character header, the cell edited on disk: resolve keeps /health under 2 s (4 s of resolving before)", { timeout: 240_000 }, async () => {
  const srv = await childServer();
  try {
    const f = path.join(srv.root, "col.xlsx");
    const b0 = xlsxColumn(248_000, 20_000);
    fs.writeFileSync(f, b0);
    const { key } = await srv.openPage(f);
    const c1 = { id: "c1", kind: "element", text: "check this", anchor: { location: { sheetIndex: 0, sheetName: "S1", range: "A2" } } };
    assert.equal((await within(srv, "send", () => srv.api(key, "/api/send", { baseSha: sha(b0), comments: [c1], note: "" }))).status, 200);
    fs.writeFileSync(f, xlsxColumn(248_000, 20_000, { a2: "2" }));
    assert.equal((await within(srv, "resolve after the cell changed", () => srv.api(key, "/api/resolve", {}))).status, 200);
  } finally {
    await srv.stop();
  }
});

// Round 8, HIGH 1: 50 comments on A1:B1 through A1:AY1 of a cell of 31 million "é" (within every reader cap) took 6.85 s on the server's
// thread at Send: each distinct range joined and hashed the cell, and an anchor being made was charged whatever was left and went on.
// Now the anchors the budget cannot pay for go out weaker (the address and context, no text hash) and the Send carries all 50; the
// anchors are made in the anchor worker, so the server's thread does none of it.
test("round 8 HIGH 1: a Send of 50 comments on ranges of one cell of 31 million \"é\" carries all 50, keeps /health answered and uses under 1 s of server CPU", { timeout: 240_000 }, async () => {
  const colName = (n) => (n < 26 ? String.fromCharCode(65 + n) : String.fromCharCode(64 + Math.floor(n / 26)) + String.fromCharCode(65 + (n % 26)));
  const srv = await childServer();
  try {
    const f = path.join(srv.root, "big.xlsx");
    const b0 = xlsxBytes({ S: { A1: "é".repeat(31_000_000), A2: "below" } });
    fs.writeFileSync(f, b0);
    const { key, status } = await srv.openPage(f);
    assert.equal(status, 200);
    const real = fs.realpathSync(f);
    const comments = Array.from({ length: 50 }, (_, i) => ({ id: `c${i}`, kind: "element", text: `check ${i}`, anchor: { location: { sheetIndex: 0, sheetName: "S", range: `A1:${colName(i + 1)}1` } } }));
    // the server reads the workbook for the Send (about 0.4 s of it here); the 50 anchors were 6.6 s more before
    const sent = await cpuWithin(srv, "send of 50 comments", () => srv.api(key, "/api/send", { baseSha: sha(b0), comments, note: "" }), 1000);
    assert.equal(sent.status, 200, JSON.stringify(sent.json).slice(0, 300));
    const polled = await within(srv, "poll", () => srv.cli("GET", `/cli/poll?file=${encodeURIComponent(real)}&holder=onionskin-term-${key}`));
    const batch = polled.json;
    assert.equal(batch.instructions.comments.length, 50, "every comment is in the batch");
    const anchors = new Map(batch.untrusted_document_evidence.anchors.map((a) => [a.id, a]));
    // the anchor worker's budget (src/anchor-worker.js, ten times the server's) pays for the first few hashes of the cell; the rest go
    // out weaker, the address and context with no hash, and the agent is offered full ops for them
    let hashed = 0;
    for (const [i, c] of batch.instructions.comments.entries()) {
      const a = anchors.get(c.anchor_id);
      assert.deepEqual([a.resolved, a.locator.range], [true, `A1:${colName(i + 1)}1`], `comment ${i}`);
      assert.equal(c.reply_with, a.locator.text_hash ? "set" : "ops", `comment ${i}: a set only against a hash it has`);
      if (a.locator.text_hash) hashed++;
    }
    assert.ok(hashed < 50, `${hashed} of 50 hashed: the budget still bounds the work`);
    assert.ok(JSON.stringify(batch).length < 2_000_000, `the batch is ${JSON.stringify(batch).length} characters`);
    const r = await cpuWithin(srv, "resolve of 50 comments", () => srv.api(key, "/api/resolve", {}), 1000);
    assert.equal(r.status, 200);
    // found in place, by its address or (a hash the worker's budget paid for) by its text there
    assert.equal(Object.entries(r.json.anchors).filter(([id, x]) => x.method !== "none" && x.range === `A1:${colName(Number(id.slice(1)) + 1)}1` && !x.moved && !x.changed).length, 50, "each still at its address (its neighbor below is there)");
  } finally {
    await srv.stop();
  }
});
