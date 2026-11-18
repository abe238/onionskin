import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, after } from "node:test";
import { tmpdir, buildZip, contentTypes } from "./helpers/zipbuild.js";

// A Send through Sessions, as the server runs it: the CPU of the whole request and the session file it writes.
const root = tmpdir();
process.env.ONIONSKIN_STATE_DIR = path.join(root, "st");
process.env.ONIONSKIN_NO_SOFFICE = "1";
const { Sessions } = await import("../src/session.js");
const { ensureStateDir } = await import("../src/paths.js");
ensureStateDir();
after(() => fs.rmSync(root, { recursive: true, force: true }));

const cpuMs = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
};
const S_NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const col = (n) => {
  let s = "";
  for (n++; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

// The eighth outside review of 7eb624d: Sheet1 of 2,000 rows x 499 columns of "a", 20,000 defined names of 250 characters all on
// Sheet1!$A$1, and a Send of 500 comments (80 on A1, 420 on ranges of 2,000 x 201 cells) held the server's thread 2.8 to 3.1 s and wrote
// a session file of 400 MB: the range walk was charged 3 units a cell for about 50 ns of work, the hash a unit for 125 ns, and every A1
// anchor kept all 20,000 names, uncharged.
test("round 9: 500 comments on large overlapping ranges and on a cell with 20,000 names: a Send is bounded by the budget, and the session file by what an anchor keeps", { timeout: 300_000 }, () => {
  const cells = Array.from({ length: 499 }, (_, c) => col(c));
  const rows = [];
  for (let r = 1; r <= 2000; r++) rows.push(`<row r="${r}">${cells.map((L) => `<c r="${L}${r}" t="inlineStr"><is><t>a</t></is></c>`).join("")}</row>`);
  const names = Array.from({ length: 20_000 }, (_, i) => `<definedName name="N${String(i).padStart(5, "0")}${"x".repeat(244)}">Sheet1!$A$1</definedName>`).join("");
  const f = path.join(root, "names.xlsx");
  fs.writeFileSync(f, buildZip({
    "[Content_Types].xml": contentTypes("xlsx").replace("</Types>", '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'),
    "_rels/.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    "xl/workbook.xml": `<?xml version="1.0"?><workbook ${S_NS}><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets><definedNames>${names}</definedNames></workbook>`,
    "xl/_rels/workbook.xml.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    "xl/worksheets/sheet1.xml": `<?xml version="1.0"?><worksheet ${S_NS}><sheetData>${rows.join("")}</sheetData></worksheet>`,
  }));
  const S = new Sessions();
  const s = S.open(f);
  const comments = Array.from({ length: 500 }, (_, i) => ({ id: `c${i}`, kind: "element", text: `comment ${i}`, anchor: { location: { sheetIndex: 0, sheetName: "Sheet1", range: i < 80 ? "A1" : `${col(i % 299)}1:${col((i % 299) + 200)}2000` } } }));
  S.send(s.key, { baseSha: s.baseSha, comments, note: "" }); // the first Send also reads the workbook (54 million characters of XML)
  const t = cpuMs();
  S.send(s.key, { baseSha: s.baseSha, comments, note: "" }); // the same Send again, on the reading kept: the anchors' own work
  const ms = cpuMs() - t;
  const size = fs.statSync(path.join(process.env.ONIONSKIN_STATE_DIR, "sessions", `${s.key}.json`)).size;
  const a1 = s.comments[0].durable;
  assert.ok(a1.names.length > 0 && a1.names.length <= 8, `${a1.names.length} names kept`);
  assert.equal(s.comments.length, 500);
  assert.ok(s.comments.every((c) => c.durable && c.durable.range), "every comment still has its anchor");
  assert.ok(size < 50_000_000, `session file ${(size / 1e6).toFixed(1)} MB`);
  assert.ok(ms < 1000, `the Send took ${ms.toFixed(0)} ms of CPU`);
});

// Round 10: ordinary values (numbers and short labels, about 10 characters a cell) on 50 distinct ranges of 1,000 x 20 cells in one
// Send. On d4ecd1e the 50th went out without its range hash (the budget ran out at 40.25 million units), and resolve then called it
// unchanged after its cells were edited; 7eb624d said changed. The page's "changed" tag reads resolve's `changed`.
test("round 10: 50 ordinary ranges of 1,000 x 20 cells in one Send all keep their hash, and an edit under the last one reads as changed", { timeout: 300_000 }, async () => {
  const { xlsxBytes } = await import("./helpers/zipbuild.js");
  const { checkExpect } = await import("../src/ops/common.js");
  const cellsOf = (edit) => {
    const cells = {};
    for (let r = 1; r <= 1000; r++) for (let c = 0; c < 70; c++) cells[`${col(c)}${r}`] = c % 2 ? Number(`${(r * 131 + c) % 9973}.${r % 100}`) : `Item ${r}-${c} ok`;
    return { ...cells, ...edit };
  };
  const f = path.join(root, "ordinary.xlsx");
  fs.writeFileSync(f, xlsxBytes({ Sheet1: cellsOf({}) }));
  const S = new Sessions();
  const s = S.open(f);
  const ranges = Array.from({ length: 50 }, (_, i) => `${col(i)}1:${col(i + 19)}1000`);
  const comments = ranges.map((range, i) => ({ id: `c${i}`, kind: "element", text: `comment ${i}`, anchor: { location: { sheetIndex: 0, sheetName: "Sheet1", range } } }));
  S.send(s.key, { baseSha: s.baseSha, comments, note: "" });
  const hashless = s.comments.filter((c) => c.durable?.rangeHash == null).map((c) => c.durable?.range);
  assert.deepEqual(hashless, [], "every range keeps its hash at Send");
  const batch = s.pending;
  assert.deepEqual(batch.instructions.comments.map((c) => c.reply_with).filter((w) => w !== "set"), [], "the agent may answer every comment with `set`");
  const last = batch.untrusted_document_evidence.anchors.find((a) => a.id === batch.instructions.comments[49].anchor_id);
  assert.ok(last.locator.text_hash, "the last range's locator carries its text hash");
  // the person edits a cell under the last range only (BQ is column 68: AX1:BQ1000 holds it, AW1:BP1000 does not), past the quoted text
  fs.writeFileSync(f, xlsxBytes({ Sheet1: cellsOf({ BQ500: "edited" }) }));
  const r = S.resolveAll(s.key);
  const changed = Object.entries(r.anchors).filter(([, a]) => a.changed).map(([id]) => id);
  assert.deepEqual(changed, ["c49"], "only the edited range reads as changed");
  assert.ok(Object.values(r.anchors).every((a) => a.method === "position"), "every range resolves in place");
  // a `set` checked against the hash the agent was given is refused on the edited range (apply compares the exact text)
  const { parseWorkbook, rangeText } = await import("../src/xlsx.js");
  const wb = parseWorkbook(fs.readFileSync(f));
  const now = rangeText(wb.sheetCells(wb.sheets[0]), { r0: 0, c0: 49, r1: 999, c1: 68 });
  assert.equal(checkExpect({ text_hash: last.locator.text_hash }, now, "exact")?.status, "expect_mismatch");
});
