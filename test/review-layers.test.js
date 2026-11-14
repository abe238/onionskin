import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test, after } from "node:test";
import { fileURLToPath } from "node:url";
import { tmpdir } from "./helpers/zipbuild.js";

// XLSX and PPTX through the session (Send -> batch -> agent edit -> done -> resolve) and through `apply` by anchor id. Temp dirs only.
const root = tmpdir();
process.env.ONIONSKIN_STATE_DIR = path.join(root, "st");
process.env.ONIONSKIN_LEASE_MS = "60000";
process.env.ONIONSKIN_NO_SOFFICE = "1";
delete process.env.ONIONSKIN_PYTHON;
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { python, havePython, skipUnless, VENV_HINT } = await import("../scripts/fixtures.mjs");
const HAVE_PY = havePython();
const fx = path.join(root, "fx");
fs.mkdirSync(fx);
if (HAVE_PY) execFileSync(python, [path.join(repo, "scripts", "make-anchor-fixtures.py"), fx]);
const opts = { skip: skipUnless(HAVE_PY, "needs .venv with openpyxl and python-pptx", VENV_HINT) };
after(() => fs.rmSync(root, { recursive: true, force: true }));

const { Sessions } = await import("../src/session.js");
const { ensureStateDir } = await import("../src/paths.js");
const { runOps } = await import("../src/ops/run.js");
const { validateOps } = await import("../src/ops/schema.js");
const { parseWorkbook } = await import("../src/xlsx.js");
const { parseDeck } = await import("../src/pptx.js");
const { diffSeq, changedRegions } = await import("../src/anchors.js");
ensureStateDir();

const copy = (name, as) => {
  const f = path.join(root, as);
  fs.copyFileSync(path.join(fx, name), f);
  return fs.realpathSync(f);
};
const sha = (f) => import("../src/fsutil.js").then((m) => m.sha256(fs.readFileSync(f)));

async function runFlow(S, file, comments, edit, viewState) {
  const s = S.open(file);
  const baseSha = await sha(file);
  const poll = S.poll(s.key);
  S.send(s.key, { baseSha, comments, note: "Please check these.", edits: [], viewState });
  const batch = await poll.promise;
  edit();
  const done = S.done(s.key, { summary: "ok", results: batch.instructions.comments.map((c) => ({ comment_id: c.id, status: "done", note: "" })) });
  return { s, batch, done };
}

test("xlsx session: the batch carries Sheet!A1 anchors (instructions vs evidence), and after the agent inserts a row and edits the cell the anchor, the view and the changed regions follow", opts, async () => {
  const S = new Sessions();
  const file = copy("budget.xlsx", "b1.xlsx");
  const loc = { sheetIndex: 1, sheetName: "Budget", range: "D30" };
  const view = { format: "xlsx", sheetIndex: 1, sheetName: "Budget", topLeft: "A20", selection: "D30" };
  const comments = [
    { id: "c1", kind: "element", text: "Is this right?", anchor: { location: loc, quote: "345", hitKind: "sheet-cell" } },
    { id: "c2", kind: "element", text: "Range check", anchor: { location: { ...loc, range: "C30:D31" }, quote: "" } },
    { id: "c3", kind: "pin", text: "pin", anchor: { location: loc, quote: "345", hitKind: "sheet-cell" }, pin: { xFrac: 0.4, yFrac: 0.6, yPx: 9, on: "cell" } },
  ];
  const { s, batch } = await runFlow(S, file, comments, () => fs.copyFileSync(path.join(fx, "x_rowabove_changed.xlsx"), file), view);
  assert.equal(batch.format, "xlsx");
  const a = (id) => batch.untrusted_document_evidence.anchors.find((x) => x.id === batch.instructions.comments.find((c) => c.id === id).anchor_id);
  assert.equal(a("c1").label, "Budget!D30");
  assert.equal(a("c1").unit, "cell");
  assert.equal(a("c1").quote, "345");
  assert.deepEqual(a("c1").locator.sheet, "Budget");
  assert.equal(a("c1").locator.range, "D30");
  assert.equal(a("c1").locator.sheet_id, "2");
  assert.match(a("c1").locator.text_hash, /^[0-9a-f]{16}$/);
  assert.equal(a("c1").context.row_header, "Line item 029");
  assert.equal(a("c1").context.column_header, "Q2");
  assert.deepEqual(a("c2").values, [["390", "345"], ["400", "350"]]);
  assert.equal(a("c2").unit, "range");
  assert.deepEqual(a("c3").pin, { x_fraction: 0.4, y_offset: 9, y_fraction: 0.6, on: "cell" });
  const instr = JSON.stringify(batch.instructions);
  assert.ok(!/Line item|345|Budget/.test(instr), "no document text in instructions");
  assert.ok(batch.how_to_apply.examples.some((e) => e.format === "xlsx" && e.op.target.anchor_id));
  // after done: the commented cell moved down one row and its value changed
  const r = S.resolveAll(s.key);
  assert.equal(r.anchors.c1.range, "D31");
  assert.equal(r.anchors.c1.method, "context");
  assert.equal(r.anchors.c1.changed, true);
  assert.equal(r.anchors.c1.sheetName, "Budget");
  assert.equal(r.anchors.c2.range, "C31:D32");
  assert.equal(r.view.format, "xlsx");
  assert.equal(r.view.sheetName, "Budget");
  assert.equal(r.view.topLeft, "A21", "the same top-left cell by identity (the row inserted above pushed it down)");
  assert.equal(r.view.selection, "D31");
  // the activity entry says what the agent changed
  const entry = s.activity[0];
  assert.ok(entry.changes.items.some((c) => c.kind === "changed" && c.range === "D31" && c.sheetName === "Budget"), JSON.stringify(entry.changes.items.slice(0, 5)));
  assert.deepEqual(entry.changes.items.map((c) => `${c.kind}:${c.sheetName}!${c.range}`), ["changed:Budget!D31"], "the empty inserted row and the rows that merely moved are not reported");
});

test("xlsx session: the commented row deleted is moved or removed after done", opts, async () => {
  const S = new Sessions();
  const file = copy("budget.xlsx", "b2.xlsx");
  const { s } = await runFlow(S, file, [{ id: "c1", kind: "element", text: "x", anchor: { location: { sheetIndex: 1, sheetName: "Budget", range: "D30" }, quote: "345", hitKind: "sheet-cell" } }], () => fs.copyFileSync(path.join(fx, "x_rowdeleted.xlsx"), file));
  assert.equal(S.resolveAll(s.key).anchors.c1.method, "none");
});

test("pptx session: slide-id anchors in the batch; after a slide is inserted before and the text changed they follow; the view lands on the same slide", opts, async () => {
  const S = new Sessions();
  const file = copy("deck.pptx", "d1.pptx");
  const deck = parseDeck(fs.readFileSync(file));
  deck.ensure();
  const body = deck.slides[3].shapes.find((x) => x.name.startsWith("Content"));
  const shapeLoc = { slideIndex: 3, slideId: "259", shapeId: body.id, shapeName: body.name };
  const comments = [
    { id: "c1", kind: "text", text: "Which month?", anchor: { location: shapeLoc, quote: "in March", prefix: "Ship the beta ", suffix: " and collect" } },
    { id: "c2", kind: "element", text: "Slide note", anchor: { location: { slideIndex: 3, slideId: "259" }, quote: "", hitKind: "slide" } },
    { id: "c3", kind: "pin", text: "pin", anchor: { location: shapeLoc, quote: body.text, hitKind: "shape" }, pin: { xFrac: 0.2, yFrac: 0.3, on: "shape" } },
  ];
  const { s, batch } = await runFlow(S, file, comments, () => fs.copyFileSync(path.join(fx, "p_inserted_changed.pptx"), file), { format: "pptx", slideIndex: 3, zoom: "fit" });
  const a = (id) => batch.untrusted_document_evidence.anchors.find((x) => x.id === batch.instructions.comments.find((c) => c.id === id).anchor_id);
  assert.match(a("c1").label, /^Slide 4 "Slide 4 headline", shape "Content Placeholder \d+"$/);
  assert.equal(a("c1").locator.slide_id, "259");
  assert.equal(a("c1").locator.shape_id, body.id);
  assert.equal(a("c1").quote, "in March");
  assert.equal(a("c2").unit, "slide");
  assert.equal(a("c2").locator.shape_id, null);
  assert.equal(a("c3").quote, "Ship the beta in March and collect customer feedback");
  assert.ok(batch.how_to_apply.examples.some((e) => e.format === "pptx"));
  const r = S.resolveAll(s.key);
  assert.equal(r.anchors.c1.slideIndex, 4);
  assert.equal(r.anchors.c1.slideId, "259");
  assert.equal(r.anchors.c1.changed, true);
  assert.equal(r.anchors.c1.quoteLost, true);
  assert.equal(r.anchors.c2.slideIndex, 4);
  assert.equal(r.anchors.c3.shapeId, body.id);
  assert.deepEqual({ format: r.view.format, slideIndex: r.view.slideIndex, slideId: r.view.slideId, zoom: r.view.zoom }, { format: "pptx", slideIndex: 4, slideId: "259", zoom: "fit" });
  assert.ok(s.activity[0].changes.items.some((c) => c.kind === "changed" && c.slideId === "259" && c.shapeId === body.id));
  assert.ok(s.activity[0].changes.items.some((c) => c.kind === "added" && c.slideId !== "259"), "the inserted slide is reported as added");
});

// ---- apply by anchor id ---------------------------------------------------------------------------------------

test("apply: XLSX and PPTX ops take the anchors exactly as delivered (anchor_id + locator.text_hash)", opts, async () => {
  const S = new Sessions();
  const xf = copy("budget.xlsx", "b3.xlsx");
  const px = copy("deck.pptx", "d3.pptx");
  const deck = parseDeck(fs.readFileSync(px));
  deck.ensure();
  const body = deck.slides[3].shapes.find((x) => x.name.startsWith("Content"));
  const mk = async (file, comments) => {
    const s = S.open(file);
    const poll = S.poll(s.key);
    S.send(s.key, { baseSha: await sha(file), comments, note: "", edits: [] });
    return poll.promise;
  };
  const xb = await mk(xf, [{ id: "c1", kind: "element", text: "t", anchor: { location: { sheetIndex: 1, sheetName: "Budget", range: "D30" }, quote: "345", hitKind: "sheet-cell" } }]);
  const xa = xb.untrusted_document_evidence.anchors[0];
  const xops = { schema: "onionskin.ops/1", ops: [{ op: "set_cells", id: "c1", target: { anchor_id: xa.id }, expect: { text_hash: xa.locator.text_hash }, values: 1400 }] };
  assert.deepEqual(validateOps(xops).errors, []);
  const anchors = (b) => new Map(b.untrusted_document_evidence.anchors.map((x) => [x.id, x]));
  const xr = await runOps({ bytes: fs.readFileSync(xf), format: "xlsx", name: "b3.xlsx", ops: xops.ops, anchors: anchors(xb) });
  assert.equal(xr.results[0].status, "applied", JSON.stringify(xr.results));
  const wb = parseWorkbook(xr.bytes);
  assert.equal(wb.sheetCells(wb.sheets[1]).cells.get(29 * 16384 + 3).text, "1400");
  // a stale expectation fails closed
  const stale = await runOps({ bytes: fs.readFileSync(path.join(fx, "x_changed.xlsx")), format: "xlsx", name: "b3.xlsx", ops: xops.ops, anchors: anchors(xb) });
  assert.equal(stale.results[0].status, "expect_mismatch");
  assert.equal(stale.bytes, null);
  // both target forms at once, or none, are rejected by the schema
  assert.ok(validateOps({ schema: "onionskin.ops/1", ops: [{ ...xops.ops[0], target: { anchor_id: "a1", sheet: "Budget", range: "D30" } }] }).errors.length);
  assert.ok(validateOps({ schema: "onionskin.ops/1", ops: [{ ...xops.ops[0], target: { sheet: "Budget" } }] }).errors.length);

  const pb = await mk(px, [{ id: "c1", kind: "element", text: "t", anchor: { location: { slideIndex: 3, slideId: "259", shapeId: body.id, shapeName: body.name }, quote: body.text, hitKind: "shape" } }]);
  const pa = pb.untrusted_document_evidence.anchors[0];
  const pops = { schema: "onionskin.ops/1", ops: [{ op: "replace_text_in_shape", id: "c1", target: { anchor_id: pa.id }, expect: { text_hash: pa.locator.text_hash }, find: "in March", replace: "in April" }] };
  assert.deepEqual(validateOps(pops).errors, []);
  const pr = await runOps({ bytes: fs.readFileSync(px), format: "pptx", name: "d3.pptx", ops: pops.ops, anchors: anchors(pb) });
  assert.equal(pr.results[0].status, "applied", JSON.stringify(pr.results));
  const d2 = parseDeck(pr.bytes);
  d2.ensure();
  assert.match(d2.slides[3].shapes.find((x) => x.id === body.id).text, /in April/);
  // a slide-level anchor cannot name a shape
  const slideOnly = { ...pa, locator: { ...pa.locator, shape_id: null } };
  const sr = await runOps({ bytes: fs.readFileSync(px), format: "pptx", name: "d3.pptx", ops: pops.ops, anchors: new Map([[pa.id, slideOnly]]) });
  assert.equal(sr.results[0].status, "anchor_not_found");
});

// ---- the diff behind "changed" --------------------------------------------------------------------------------------

test("diffSeq: unchanged is same, edited is changed (paired), inserted is added, moved-by-insertion rows stay same", () => {
  const k = (a, b) => diffSeq(a, b).kind;
  assert.deepEqual(k(["a", "b", "c"], ["a", "b", "c"]), ["same", "same", "same"]);
  assert.deepEqual(k(["a", "b", "c"], ["a", "X", "c"]), ["same", "changed", "same"]);
  assert.deepEqual(k(["a", "b", "c"], ["a", "N", "b", "c"]), ["same", "added", "same", "same"]);
  assert.deepEqual(k(["a", "b", "c", "d"], ["a", "N", "b", "X", "d"]), ["same", "added", "same", "changed", "same"]);
  assert.deepEqual(k(["a", "b"], ["a", "b", "z"]), ["same", "same", "added"]);
  assert.deepEqual(k([], ["a"]), ["added"]);
});

test("changedRegions: a deck where only one slide moved reports nothing; an untouched workbook reports nothing", opts, () => {
  const r = changedRegions("pptx", fs.readFileSync(path.join(fx, "deck.pptx")), fs.readFileSync(path.join(fx, "p_reordered.pptx")));
  assert.deepEqual(r.items, []);
  const x = changedRegions("xlsx", fs.readFileSync(path.join(fx, "budget.xlsx")), fs.readFileSync(path.join(fx, "budget.xlsx")));
  assert.deepEqual(x.items, []);
});

// ---- apply refusals and protected anchors reach the user ---------------------------------------------------------------

test("done: what apply could not do shows up as flags with the run; only the lease holder may report; a protected PPTX anchor says so in the batch", opts, async () => {
  const S = new Sessions();
  const file = copy("deck.pptx", "d5.pptx");
  const deck = parseDeck(fs.readFileSync(file));
  deck.ensure();
  const body = deck.slides[3].shapes.find((x) => x.name.startsWith("Content"));
  const s = S.open(file);
  const poll = S.poll(s.key);
  S.send(s.key, { baseSha: await sha(file), comments: [{ id: "c1", kind: "element", text: "t", anchor: { location: { slideIndex: 3, slideId: "259", shapeId: body.id, shapeName: body.name, protected: true }, quote: body.text, hitKind: "shape" } }], note: "", edits: [] });
  const batch = await poll.promise;
  assert.equal(batch.untrusted_document_evidence.anchors[0].protected, true);
  const claim = { holder: "agent", token: batch.lease.token, batchId: batch.batch_id };
  assert.throws(() => S.noteApply(s.key, { ...claim, holder: "intruder", problems: [] }), (e) => e.extra.code === "not_lease_holder");
  S.noteApply(s.key, { ...claim, problems: [{ op: "set_cells", status: "refused", code: "xlsx-table", reason: "a table cannot be shifted" }, { op: "replace_text", status: "skipped_protected", reason: "the paragraph holds a field" }, { op: "x", status: "not_applied", reason: "cascade" }] });
  const out = S.done(s.key, { summary: "s", results: [{ comment_id: "c1", status: "declined", note: "" }] });
  const f = (code) => out.flags.find((x) => x.code === code);
  assert.deepEqual({ severity: f("apply_not_applied").severity, reason_code: f("apply_not_applied").reason_code, op: f("apply_not_applied").op }, { severity: "warn", reason_code: "xlsx-table", op: "set_cells" });
  assert.equal(f("apply_skipped_protected").severity, "info");
  assert.equal(out.flags.filter((x) => x.code.startsWith("apply_")).length, 3, "every reported problem is shown, in order");
  assert.ok(out.checks.notice, "the deeper-check notice is always present");
});
