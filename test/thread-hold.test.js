// Round 11 of the outside reviews (60ebb04): three inputs inside the documented size limits that held the server's thread for seconds or
// wrote hundreds of MB of session data through Sessions, as the server runs it. Main-thread CPU (process.threadCpuUsage: work in a
// worker thread is not counted) and the session file are measured. Temp state dir only.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, after } from "node:test";
import { buildZip, contentTypes, docxBytes, tmpdir } from "./helpers/zipbuild.js";

const root = tmpdir();
process.env.ONIONSKIN_STATE_DIR = path.join(root, "st");
process.env.ONIONSKIN_NO_SOFFICE = "1";
const { Sessions } = await import("../src/session.js");
const { ensureStateDir } = await import("../src/paths.js");
const { STAMP_WORDS } = await import("../src/stamp-words.js");
ensureStateDir();
after(() => fs.rmSync(root, { recursive: true, force: true }));

// this thread only, where the platform says (Node 23.9+); else the whole process, which only overstates
const cpuMs = () => {
  const u = process.threadCpuUsage ? process.threadCpuUsage() : process.cpuUsage();
  return (u.user + u.system) / 1000;
};
const sessionBytes = (s) => fs.statSync(path.join(process.env.ONIONSKIN_STATE_DIR, "sessions", `${s.key}.json`)).size;
const S_NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const col = (n) => {
  let s = "";
  for (n++; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

// (a) src/suggest-reply.js: one paragraph of q.repeat(10000), q = "A ".repeat(149) + "A." (three million characters). Use of a quick fix
// on the first q (the model wrote "An" + q.slice(1)) widened the changed span a word at a time and counted every overlapping occurrence of
// it in the whole paragraph at each step: 8.3 s of CPU before it answered "not here".
test("(a) Use of a quick fix on a sentence repeated 10,000 times in its paragraph answers in under a second of this thread's CPU", { timeout: 120_000 }, () => {
  const q = "A ".repeat(149) + "A.";
  const f = path.join(root, "repeat.docx");
  fs.writeFileSync(f, docxBytes([q.repeat(10_000)]));
  const S = new Sessions();
  const s = S.open(f);
  const location = { blockPath: [0], start: 0, end: q.length };
  const rec = { task: "grammar", quote: q, location, before: q, after: "An" + q.slice(1) };
  const comments = [{ id: "c1", kind: "text", text: STAMP_WORDS.grammar, anchor: { location, quote: q } }];
  const t = cpuMs();
  let code = "written";
  try {
    S.useSuggestion(s.key, { suggestion: rec, commentId: "c1", comments, baseSha: s.baseSha });
  } catch (err) {
    code = err?.extra?.code ?? String(err);
  }
  const ms = cpuMs() - t;
  assert.equal(code, "not_here", "the sentence repeats in its paragraph, so nothing is written");
  assert.ok(ms < 1000, `Use took ${ms.toFixed(0)} ms of CPU`);
  assert.equal(s.comments.find((c) => c.id === "c1")?.status, "draft", "the comment is kept, as a draft");
});

// (b) src/xlsx.js cellMeta, src/batch.js: A1:J20 of numeric 1 whose style has a custom number format of 1,000 decomposed "é". Every
// anchor kept the whole format string per cell, and the batch sanitized each again: 500 comments on A1:J20 took 4.5 s and 323 MB.
test("(b) 500 comments on a range whose cells carry a 1,000-character number format: under a second, and the session file stays small", { timeout: 120_000 }, () => {
  const rows = [];
  for (let r = 1; r <= 20; r++) rows.push(`<row r="${r}">${Array.from({ length: 10 }, (_, c) => `<c r="${col(c)}${r}" s="0"><v>1</v></c>`).join("")}</row>`);
  const code = "é".repeat(1000);
  const f = path.join(root, "format.xlsx");
  fs.writeFileSync(f, buildZip({
    "[Content_Types].xml": contentTypes("xlsx").replace("</Types>", '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'),
    "_rels/.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    "xl/workbook.xml": `<?xml version="1.0"?><workbook ${S_NS}><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    "xl/styles.xml": `<?xml version="1.0"?><styleSheet ${S_NS}><numFmts count="1"><numFmt numFmtId="164" formatCode="${code}"/></numFmts><cellXfs count="1"><xf numFmtId="164"/></cellXfs></styleSheet>`,
    "xl/worksheets/sheet1.xml": `<?xml version="1.0"?><worksheet ${S_NS}><sheetData>${rows.join("")}</sheetData></worksheet>`,
  }));
  const S = new Sessions();
  const s = S.open(f);
  const comments = Array.from({ length: 500 }, (_, i) => ({ id: `c${i}`, kind: "element", text: `comment ${i}`, anchor: { location: { sheetIndex: 0, sheetName: "Sheet1", range: "A1:J20" } } }));
  const t = cpuMs();
  S.send(s.key, { baseSha: s.baseSha, comments, note: "" });
  const ms = cpuMs() - t;
  const size = sessionBytes(s);
  assert.equal(s.pending.instructions.comments.length, 500, "every comment is in the batch");
  assert.ok(s.comments.every((c) => c.durable?.range === "A1:J20"), "every comment keeps its anchor");
  // each anchor keeps 100 characters of each cell's format (200 cells): about 29 MB with the batch. 500 ordinary comments on 1,000 x 20
  // ranges make 9.4 MB; the cap of a session file is 64 MB (src/retain.js)
  assert.ok(size < 32_000_000, `session file ${(size / 1e6).toFixed(1)} MB`);
  assert.ok(ms < 1000, `the Send took ${ms.toFixed(0)} ms of CPU`);
});

// (c) Sessions.setDraft stored the page's anchors as they came: 50 comments each quoting a paragraph of 7.9 million characters took
// 1.3 s and wrote a session file of about 400 MB on every draft save.
test("(c) a draft of 50 comments each quoting 7.9 million characters is kept small, in under a second, and no comment is lost", { timeout: 120_000 }, () => {
  const f = path.join(root, "draft.docx");
  fs.writeFileSync(f, docxBytes(["One short paragraph."]));
  const S = new Sessions();
  const s = S.open(f);
  const big = "word ".repeat(1_580_000);
  const comments = Array.from({ length: 50 }, (_, i) => ({ id: `c${i}`, kind: "text", text: `comment ${i}`, anchor: { location: { blockPath: [0], start: 0, end: big.length }, quote: big } }));
  const t = cpuMs();
  S.setDraft(s.key, { comments, note: "" });
  const ms = cpuMs() - t;
  const size = sessionBytes(s);
  assert.equal(s.comments.length, 50, "every comment is kept");
  assert.ok(size < 20_000_000, `session file ${(size / 1e6).toFixed(1)} MB`);
  assert.ok(ms < 1000, `the draft save took ${ms.toFixed(0)} ms of CPU`);
});
