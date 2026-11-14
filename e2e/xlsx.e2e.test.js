import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { activeSheetName, agentEdit, boxCenterDist, center, cspViolations, launch, makeWorld, openSheet, overlaps, python, repo, srcModule, until, waitDoc, xlsxCell, xlsxFlagsCoveringText, xlsxScrollTo, xlsxTopRow } from "./helpers/harness.mjs";
import { execFileSync } from "node:child_process";

// The whole review loop on a workbook, twice: the agent edits through `onionskin apply` (ops built from the delivered batch), and the
// agent edits with openpyxl directly (insert a row above the commented cell and change the commented cell).

const cellsOf = async (file, sheet) => {
  const { parseWorkbook } = await srcModule("xlsx.js");
  const wb = parseWorkbook(fs.readFileSync(file));
  const s = wb.sheets.find((x) => x.name === sheet);
  return { wb, sd: wb.sheetCells(s), s };
};
const textAt = async (file, sheet, r, c) => (await cellsOf(file, sheet)).sd.cells.get(r * 16384 + c)?.text ?? "";

async function comment(page, rowText, col, text) {
  await page.locator('[data-testid="mode-comment"]').click();
  const b = await xlsxCell(page, rowText, col);
  assert.ok(b, `cell ${rowText}/${col} not rendered`);
  await page.mouse.click(center(b).x, center(b).y);
  await page.locator('[data-testid="comment-card"] textarea').last().fill(text);
  await page.locator('[data-testid="mode-edit"]').click();
  return b;
}

/** The draft every scenario sends: a user edit, a cell comment, a dragged range, a pin, a comment on another sheet; selection on D30. */
async function draftAndSend(w, br, file) {
  const poll = w.spawnCli(["poll", file]);
  const page = await br.page();
  await page.goto(await w.open(file));
  await waitDoc(page, ".de-sheet");
  await page.locator('[data-testid="banner-listening"]').waitFor({ timeout: 20000 });
  await openSheet(page, "Budget");
  await xlsxScrollTo(page, "Line item 029", 10);

  // the user's own edit: Q1 of line item 015 becomes 4242
  await until(() => xlsxCell(page, "Line item 015", "C"), "row 16 rendered");
  await page.waitForTimeout(400); // the grid may still settle after the scroll (seen on a loaded machine in WebKit: the click landed ten rows off); measure again just before clicking
  const e = await until(() => xlsxCell(page, "Line item 015", "C"), "row 16 rendered");
  await page.mouse.click(center(e).x, center(e).y);
  await page.keyboard.type("4242");
  await page.keyboard.press("Enter");
  await page.locator('[data-testid="change-item"]').first().waitFor({ timeout: 10000 });
  const changeLabel = await page.locator('[data-testid="change-label"]').first().textContent();
  assert.equal(changeLabel, "Budget!C16");
  assert.match(await page.locator('[data-testid="change-item"]').first().textContent(), /250.*4242/);

  const d30 = await comment(page, "Line item 029", "D", "Is this Q2 figure right?");
  // a dragged range
  await page.locator('[data-testid="mode-comment"]').click();
  const a = await xlsxCell(page, "Line item 026", "C");
  const z = await xlsxCell(page, "Line item 027", "D");
  await page.mouse.move(a.x + 10, a.y + 5);
  await page.mouse.down();
  await page.mouse.move(z.x + 20, z.y + 5, { steps: 6 });
  await until(async () => (await page.locator('[data-testid="drag-box"]').count()) === 1, "a rubber band is drawn while dragging"); // painted on the next animation frame
  await page.mouse.up();
  await page.locator('[data-testid="comment-card"] textarea').last().fill("Range check: do these two rows add up?");
  await until(async () => (await page.locator('[data-testid="drag-box"]').count()) === 0, "rubber band gone after the drop");
  // a pin on a cell
  await page.locator('[data-testid="mode-pin"]').click();
  const p = await xlsxCell(page, "Line item 023", "B");
  await page.mouse.click(p.x + p.w * 0.3, p.y + p.h * 0.4);
  await page.locator('[data-testid="comment-card"][data-kind="pin"] textarea').fill("Is the owner still correct?");
  await page.locator('[data-testid="mode-edit"]').click();
  // another sheet
  await openSheet(page, "Notes");
  await comment(page, "All figures are in thousands.", "A", "Say which currency.");
  assert.equal(await page.locator('[data-testid="marker"]').count(), 1, "only the shown sheet's markers are drawn");
  await openSheet(page, "Budget");
  const cards = page.locator('[data-testid="comment-card"]');
  assert.equal(await cards.count(), 4);
  assert.equal(await page.locator('[data-testid="comment-card"][data-sheet-active="0"]').count(), 1, "the Notes card is marked as being on another sheet");
  assert.equal(await page.locator('[data-testid="marker"]').count(), 2, "two Budget markers (D30, C27:D28) and the pin; Notes is hidden");
  assert.equal(await page.locator('[data-testid="pin-mark"]').count(), 1);

  // markers sit at the corner of their cell and the outline covers it
  const m1 = await page.locator('[data-testid="marker"]').first().boundingBox();
  const d30now = await xlsxCell(page, "Line item 029", "D");
  assert.ok(boxCenterDist({ x: m1.x, y: m1.y, w: m1.width, h: m1.height }, { x: d30now.x + d30now.w, y: d30now.y, w: 0, h: 0 }) < 14, "marker 1 at the top right corner of D30");
  const cover = await xlsxFlagsCoveringText(page);
  assert.ok(cover.flags >= 2, "the cell flags are drawn");
  assert.deepEqual(cover.hits, [], "no numbered flag covers the text of a cell");

  // frozen panes: a marker is never drawn over the frozen header row or the column headers while the sheet scrolls under them
  const band = await page.evaluate(() => document.querySelector(".de-freeze-h").getBoundingClientRect().bottom);
  let hidden = 0;
  for (let top = 520; top <= 640; top += 10) {
    await page.evaluate((t) => (document.querySelector(".de-grid").scrollTop = t), top);
    await page.waitForTimeout(250);
    const ys = await page.locator('[data-testid="marker"], [data-testid="pin-mark"]').evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return r.top + r.height / 2; }));
    assert.ok(ys.every((y) => y >= band - 2), `scrollTop ${top}: a marker is drawn over the frozen band (${ys.join(",")} vs ${band})`);
    if (!(await page.locator('[data-testid="marker"][data-comment-id]').count())) hidden++;
  }
  assert.ok(hidden >= 1, "at some scroll position every Budget marker is out of the visible cells");
  await xlsxScrollTo(page, "Line item 029", 10);
  await until(async () => (await page.locator('[data-testid="marker"]').count()) === 2, "markers back after scrolling back");

  // jump: the card of the Notes comment switches the sheet and shows its marker
  await page.locator('[data-testid="comment-card"][data-sheet="Notes"] .locate').click();
  await until(async () => (await activeSheetName(page)) === "Notes", "Notes sheet active");
  await until(async () => (await page.locator('[data-testid="marker"]').count()) === 1, "Notes marker");
  await openSheet(page, "Budget");
  await xlsxScrollTo(page, "Line item 029", 10);

  // view to restore: the selection on D30 and the scroll position
  const d30b = await until(() => xlsxCell(page, "Line item 029", "D"), "D30");
  await page.mouse.click(center(d30b).x, center(d30b).y);
  await page.locator('[data-testid="overall-note"]').fill("Keep the number formats.");
  await page.waitForTimeout(700);
  const view = { topRow: await xlsxTopRow(page), cellBefore: d30b, ref: await page.locator(".de-fx-ref").textContent() };
  assert.equal(view.ref.trim(), "D30");
  await page.locator('[data-testid="send"]').click();
  const res = await Promise.race([poll.done, new Promise((r) => setTimeout(() => r(null), 20000))]);
  assert.ok(res, "poll did not return after Send");
  assert.equal(res.code, 0, res.stderr);
  return { page, batch: JSON.parse(res.stdout), view, d30 };
}

function checkBatch(batch, file) {
  assert.equal(batch.format, "xlsx");
  assert.equal(batch.instructions.overall_note, "Keep the number formats.");
  const cs = batch.instructions.comments;
  assert.equal(cs.length, 4);
  assert.deepEqual(cs.map((c) => c.kind).sort(), ["element", "element", "element", "pin"]);
  const instr = JSON.stringify(batch.instructions);
  assert.ok(!/Line item|\b345\b|Budget|Eli|Dee|thousands/.test(instr), "no document text inside `instructions`");
  const A = batch.untrusted_document_evidence.anchors;
  const anchorOf = (c) => A.find((a) => a.id === c.anchor_id);
  const c1 = cs.find((c) => c.text.startsWith("Is this Q2"));
  const a1 = anchorOf(c1);
  assert.equal(a1.label, "Budget!D30");
  assert.equal(a1.unit, "cell");
  assert.equal(a1.resolved, true);
  assert.equal(a1.quote, "345");
  assert.deepEqual({ sheet: a1.locator.sheet, sheet_id: a1.locator.sheet_id, range: a1.locator.range }, { sheet: "Budget", sheet_id: "2", range: "D30" });
  assert.match(a1.locator.text_hash, /^[0-9a-f]{16}$/);
  assert.equal(a1.context.row_header, "Line item 029");
  assert.equal(a1.context.column_header, "Q2");
  const a2 = anchorOf(cs.find((c) => c.text.startsWith("Range check")));
  assert.equal(a2.unit, "range");
  assert.equal(a2.locator.range, "C27:D28");
  assert.equal(a2.values.length, 2);
  assert.equal(a2.values[0].length, 2);
  const a3 = anchorOf(cs.find((c) => c.kind === "pin"));
  assert.equal(a3.label, "Budget!B24");
  assert.equal(a3.pin.on, "cell");
  assert.ok(a3.pin.y_fraction > 0 && a3.pin.y_fraction < 1);
  const a4 = anchorOf(cs.find((c) => c.text.startsWith("Say which")));
  assert.equal(a4.label, "Notes!A2");
  for (const a of A) for (const k of ["quote", "prefix", "suffix", "label"]) assert.ok([...a[k]].length <= 500, `${k} capped`);
  const ed = batch.untrusted_document_evidence.user_edits;
  assert.equal(ed.length, 1);
  assert.deepEqual({ label: ed[0].label, before: ed[0].before, after: ed[0].after }, { label: "Budget!C16", before: "250", after: "4242" });
  return { c1, a1, cs };
}

/** After `done`: same sheet, same top-left row (shifted by the inserted row), selection and the commented cell with its marker on the right cell. */
async function checkLanded(page, view, { newRange, method }) {
  await page.locator('[data-testid="activity-entry"]').first().waitFor({ timeout: 25000 });
  await until(async () => (await page.locator('[data-testid="comment-card"][data-comment-id]').first().getAttribute("data-range")) === newRange, `card re-attached to ${newRange}`);
  assert.equal(await activeSheetName(page), "Budget", "same sheet after the reload");
  await until(async () => (await xlsxTopRow(page)) === view.topRow + 1, "same top-left cell (one row down: the row inserted above)");
  await until(async () => (await page.locator(".de-fx-ref").textContent()).trim() === newRange, `selection ${newRange}`);
  const card = page.locator('[data-testid="comment-card"]').first();
  assert.equal(await card.getAttribute("data-resolved"), "ok");
  assert.equal(await card.getAttribute("data-resolved-method"), method);
  assert.equal(await card.getAttribute("data-changed"), "1", "the card says the value changed");
  // The marker is painted by the overlay's redraw (a frame after a scroll or DOM change, or its 700 ms timer), the cell comes straight from
  // the DOM, so the two are measured together and retried until they agree. A marker that never lands on the corner still fails here.
  const cell = await until(async () => {
    const c = await xlsxCell(page, "Line item 029", "D");
    const mk = c && (await page.locator('[data-testid="marker"][data-comment-id]').first().boundingBox());
    return mk && boxCenterDist({ x: mk.x, y: mk.y, w: mk.width, h: mk.height }, { x: c.x + c.w, y: c.y, w: 0, h: 0 }) < 14 ? c : null;
  }, `marker at the top right corner of ${newRange}`, 10000);
  const hl = await page.locator('[data-testid="highlight"][data-unit="cell"]').first().boundingBox();
  assert.ok(overlaps({ x: hl.x, y: hl.y, w: hl.width, h: hl.height }, cell), "outline on the commented cell");
  // every card re-attached by id: the range comment moved one row down too
  assert.equal(await page.locator('[data-testid="comment-card"][data-range="C28:D29"]').count(), 1);
  assert.equal(await page.locator('[data-testid="comment-card"][data-sheet="Notes"][data-range="A2"]').count(), 1);
  assert.equal(await page.locator('[data-testid="comment-card"][data-resolved="moved"]').count(), 0);
  // the changed regions are found by comparing the files and shown while fresh
  const chg = await until(async () => {
    const n = await page.locator('[data-testid="changed-region"]').count();
    return n ? page.locator('[data-testid="changed-region"]').evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, kind: e.dataset.kind }; })) : null;
  }, "changed regions");
  assert.ok(chg.some((r) => r.kind === "changed" && overlaps(r, cell)), "the cell the agent changed is outlined as changed");
  assert.equal(await page.locator('[data-testid="change-item"]').count(), 0, "the user's edits were sent: Changes is empty");
  return cell;
}

describe("XLSX loop, agent uses `onionskin apply`", () => {
  let w, br, page, file, batch, view, preSha;
  before(async () => {
    w = makeWorld({ ONIONSKIN_NO_SOFFICE: "1" });
    br = await launch();
    file = w.doc("budget.xlsx");
  });
  after(async () => {
    await br?.close();
    await w?.cleanup();
  });

  test("edit, cell comment, range drag, pin, other-sheet comment, card jump, Send: the batch separates instructions from evidence", async () => {
    ({ page, batch, view } = await draftAndSend(w, br, file));
    checkBatch(batch, file);
    assert.equal(await textAt(file, "Budget", 15, 2), "4242", "the file on disk contains the user's direct edit");
    await page.locator('[data-testid="banner-working"]').waitFor();
  });

  test("the agent builds ops from the batch (anchor ids, locator.text_hash) and applies them through the session; `done` reports", async () => {
    const { c1, a1 } = checkBatch(batch, file);
    const ops = {
      schema: "onionskin.ops/1",
      ops: [
        { op: "set_cells", id: c1.id, target: { anchor_id: a1.id }, expect: { text_hash: a1.locator.text_hash }, values: 1400 },
        { op: "insert_rows", target: { sheet: "Budget", at: 5 }, expect: { quote: await (async () => { const { sd } = await cellsOf(file, "Budget"); const { rangeText } = await srcModule("xlsx.js"); return rangeText(sd, { r0: 4, c0: 0, r1: 4, c1: 4 }); })() } },
      ],
    };
    const batchFile = w.doc("batch.json");
    const opsFile = w.doc("ops.json");
    fs.writeFileSync(batchFile, JSON.stringify(batch));
    fs.writeFileSync(opsFile, JSON.stringify(ops));
    preSha = (await srcModule("fsutil.js")).sha256(fs.readFileSync(file));
    const dry = await w.cli(["apply", file, "--ops", opsFile, "--dry-run"]);
    assert.equal(dry.code, 0, dry.stdout + dry.stderr);
    assert.equal((await srcModule("fsutil.js")).sha256(fs.readFileSync(file)), preSha, "dry run left the file byte-identical");
    const r = await w.cli(["apply", file, "--ops", opsFile]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const report = JSON.parse(r.stdout);
    assert.deepEqual(report.results.map((x) => x.status), ["applied", "applied"]);
    assert.equal(report.write_path, "session");
    assert.equal(await textAt(file, "Budget", 30, 3), "1400", "D30 moved to D31 and holds the agent's value");
    assert.match(await textAt(file, "Budget", 15 + 1, 2), /4242/, "the user's edit survived and moved down one row");
    const results = w.doc("results.json");
    fs.writeFileSync(results, JSON.stringify({ summary: "Corrected the Q2 figure and added a spacer row.", results: batch.instructions.comments.map((c) => ({ comment_id: c.id, status: c.id === c1.id ? "done" : "declined", note: c.id === c1.id ? "Set to 1400." : "Not needed." })) }));
    const done = await w.cli(["done", file, "--results", results]);
    assert.equal(done.code, 0, done.stderr);
    const out = JSON.parse(done.stdout);
    assert.deepEqual(out.flags.filter((f) => f.severity === "error"), [], JSON.stringify(out.flags));
  });

  test("after done: same sheet and top-left row, the commented cell on screen with its marker, cards re-attached, activity and checks shown", async () => {
    const cell = await checkLanded(page, view, { newRange: "D31", method: "context" });
    assert.ok(cell);
    assert.equal(await page.locator('[data-testid="comment-card"][data-status="done"]').count(), 1);
    assert.equal(await page.locator('[data-testid="comment-card"][data-status="declined"]').count(), 3);
    // one stack on this format too: the cards, then the run that answered them as the newest thing
    const stack = await page.evaluate(() => [...document.querySelectorAll('[data-testid="panel-stack"] > li')].map((li) => li.dataset.testid));
    assert.equal(stack.filter((t) => t === "comment-card").length, 4, `every card is in the stack (${stack})`);
    assert.equal(stack.at(-1), "activity-entry", `the run is the newest thing in the stack (${stack})`);
    assert.ok(stack.indexOf("activity-entry") > stack.lastIndexOf("comment-card"), "the run sits under the cards it answered");
    assert.match(await page.locator('[data-testid="activity-summary"]').last().textContent(), /Q2 figure/);
    assert.match(await page.locator('[data-testid="check-notice"]').first().textContent(), /Deeper check/);
    assert.match(await page.locator('[data-testid="run-changes"]').first().textContent(), /place/);
    assert.equal(await page.locator('[data-testid="activity-flags"] li[data-severity="error"]').count(), 0);
    assert.ok((await page.locator('[data-testid="docwrap"] .de-cell').count()) > 0);
    assert.equal(await page.locator('[data-testid="state-pill"]').first().textContent(), "Idle");
  });

  test("Revert puts the pre-agent bytes back as a new version and the page reloads on them", async () => {
    await page.locator('[data-testid="revert"]').click();
    await until(() => (async () => (await srcModule("fsutil.js")).sha256(fs.readFileSync(file)) === preSha)(), "file reverted");
    assert.equal(await textAt(file, "Budget", 29, 3), "345");
    await until(async () => (await page.locator('[data-testid="comment-card"][data-comment-id]').first().getAttribute("data-range")) === "D30", "card back on D30");
    await page.locator('[data-testid="activity-entry"][data-kind="revert"]').first().waitFor();
    // Seen once with two browser test files running at the same time: 34 regions still painted right after the revert entry showed. Not
    // reproduced since (also not with the CPU throttled 8x and 20x). Lead, unconfirmed: the overlay redraws on a DOM change or its 700 ms
    // timer, not with the activity entry. So wait, and print the lag when it is long; a run whose regions never clear still fails here.
    const t0 = Date.now();
    await until(async () => (await page.locator('[data-testid="changed-region"]').count()) === 0, "a reverted run to paint no changed regions over the restored file", 10000);
    if (Date.now() - t0 > 300) console.log(`changed regions cleared ${Date.now() - t0} ms after the revert entry showed`);
  });

  test("zero CSP violations and zero page errors", async () => {
    assert.deepEqual(cspViolations(br.log), []);
    assert.deepEqual(br.log.errors, []);
    assert.deepEqual(br.log.console.filter((m) => m.type === "error"), []);
  });
});

describe("XLSX loop, agent edits with openpyxl directly", () => {
  let w, br, page, file, batch, view;
  before(async () => {
    w = makeWorld({ ONIONSKIN_NO_SOFFICE: "1" });
    br = await launch();
    file = w.doc("budget.xlsx");
  });
  after(async () => {
    await br?.close();
    await w?.cleanup();
  });

  test("Send", async () => {
    ({ page, batch, view } = await draftAndSend(w, br, file));
    checkBatch(batch, file);
    assert.equal(await textAt(file, "Budget", 15, 2), "4242", "the file on disk contains the user's direct edit");
  });

  test("openpyxl inserts a row above and changes the commented cell; the page lands on the same sheet, row and cell", async () => {
    agentEdit([file, "xlsx-insert-row", "Budget", "5"]);
    agentEdit([file, "xlsx-set", "Budget", "D31", "1400"]);
    assert.match(await textAt(file, "Budget", 15 + 1, 2), /4242/, "the user's direct edit is still in the file (one row down)");
    const c1 = batch.instructions.comments.find((c) => c.text.startsWith("Is this Q2"));
    const results = w.doc("results.json");
    fs.writeFileSync(results, JSON.stringify({ summary: "Changed the Q2 figure; inserted a row.", results: batch.instructions.comments.map((c) => ({ comment_id: c.id, status: "done", note: c.id === c1.id ? "Set to 1400." : "Fine." })) }));
    const done = await w.cli(["done", file, "--results", results]);
    assert.equal(done.code, 0, done.stderr);
    await checkLanded(page, view, { newRange: "D31", method: "context" });
    assert.equal(await page.locator('[data-testid="comment-card"][data-status="done"]').count(), 4);
    assert.match(await page.locator('[data-testid="check-notice"]').first().textContent(), /Deeper check/);
  });

  test("zero CSP violations and zero page errors", async () => {
    assert.deepEqual(cspViolations(br.log), []);
    assert.deepEqual(br.log.errors, []);
    assert.deepEqual(br.log.console.filter((m) => m.type === "error"), []);
  });
});

describe("XLSX: the commented row is deleted; openpyxl drops a part", () => {
  let w, br;
  before(async () => {
    w = makeWorld({ ONIONSKIN_NO_SOFFICE: "1" });
    br = await launch();
  });
  after(async () => {
    await br?.close();
    await w?.cleanup();
  });

  test("a deleted row is moved or removed: the card says so, no marker is drawn, the other comments follow", async () => {
    const file = w.doc("budget.xlsx");
    const poll = w.spawnCli(["poll", file]);
    const page = await br.page();
    await page.goto(await w.open(file));
    await waitDoc(page, ".de-sheet");
    await page.locator('[data-testid="banner-listening"]').waitFor({ timeout: 20000 });
    await openSheet(page, "Budget");
    await xlsxScrollTo(page, "Line item 029", 10);
    await comment(page, "Line item 029", "D", "Check this one.");
    await comment(page, "Line item 024", "C", "And this one.");
    await page.locator('[data-testid="send"]').click();
    const batch = JSON.parse((await poll.done).stdout);
    agentEdit([file, "xlsx-delete-row", "Budget", "30"]);
    const results = w.doc("results.json");
    fs.writeFileSync(results, JSON.stringify({ summary: "Removed line item 029.", results: batch.instructions.comments.map((c) => ({ comment_id: c.id, status: "done", note: "" })) }));
    assert.equal((await w.cli(["done", file, "--results", results])).code, 0);
    await page.locator('[data-testid="activity-entry"]').first().waitFor({ timeout: 25000 });
    const moved = page.locator('[data-testid="comment-card"][data-resolved="moved"]');
    await until(async () => (await moved.count()) === 1, "one moved card");
    assert.match(await moved.first().textContent(), /Moved or removed/);
    const keep = page.locator('[data-testid="comment-card"][data-resolved="ok"]');
    assert.equal(await keep.count(), 1);
    assert.equal(await keep.first().getAttribute("data-range"), "C25");
    await until(async () => (await page.locator('[data-testid="marker"]').count()) === 1, "only the surviving comment has a marker");
    assert.deepEqual(cspViolations(br.log), []);
    assert.deepEqual(br.log.errors, []);
  });

  test("the direct-library path flags what openpyxl dropped (a part the file had), with a Revert offer next to the error", async () => {
    const file = w.doc("lossy.xlsx");
    execFileSync(python, [path.join(repo, "e2e", "helpers", "lossy_xlsx.py"), file]);
    const before = (await srcModule("fsutil.js")).sha256(fs.readFileSync(file));
    const poll = w.spawnCli(["poll", file]);
    const page = await br.page();
    await page.goto(await w.open(file));
    await waitDoc(page, ".de-sheet");
    await page.locator('[data-testid="banner-listening"]').waitFor({ timeout: 20000 });
    await comment(page, "Line item 005", "D", "Double check.");
    await page.locator('[data-testid="send"]').click();
    const batch = JSON.parse((await poll.done).stdout);
    agentEdit([file, "xlsx-set", "Budget", "D6", "999"]);
    const results = w.doc("results2.json");
    fs.writeFileSync(results, JSON.stringify({ summary: "Changed D6.", results: [{ comment_id: batch.instructions.comments[0].id, status: "done", note: "" }] }));
    await page.setViewportSize({ width: 1500, height: 640 }); // a short panel: the new entry must still be brought fully into view
    const done = await w.cli(["done", file, "--results", results]);
    const out = JSON.parse(done.stdout);
    const dropped = out.flags.find((f) => f.code === "part_removed" && /printerSettings/.test(f.part));
    assert.ok(dropped, JSON.stringify(out.flags));
    assert.equal(dropped.severity, "error");
    const li = page.locator('[data-testid="activity-flags"] li[data-code="part_removed"][data-severity="error"]', { hasText: /printerSettings/ });
    await li.first().waitFor({ timeout: 25000 });
    assert.match(await li.first().textContent(), /Needs a look.*printerSettings/);
    await page.locator('[data-testid="check-revert"]').waitFor();
    // the Revert control is scrolled above the pinned composer, not hidden under it
    await until(async () => page.evaluate(() => {
      const b = document.querySelector('[data-testid="check-revert"] [data-testid="revert"]').getBoundingClientRect();
      const sc = document.querySelector(".sidebar .scroll").getBoundingClientRect();
      const comp = document.querySelector(".composer").getBoundingClientRect();
      return b.top >= sc.top && b.bottom <= sc.bottom - 4 && b.bottom <= comp.top;
    }), "the Revert button fully visible above the composer");
    await page.locator('[data-testid="check-revert"] [data-testid="revert"]').click();
    await until(async () => (await page.locator('[data-testid="revert"]').count()) === 0, "no Revert button is left on a reverted run");
    await until(async () => (await srcModule("fsutil.js")).sha256(fs.readFileSync(file)) === before, "reverted to the bytes before the run");
    assert.deepEqual(cspViolations(br.log), []);
    assert.deepEqual(br.log.errors, []);
  });
});

describe("XLSX: the workbook stays open while the agent works; what the user changes is merged cell by cell", () => {
  let w, br, page, file;
  const q = (id) => `[data-testid="${id}"]`;
  before(async () => {
    w = makeWorld({ ONIONSKIN_NO_SOFFICE: "1" });
    br = await launch();
    file = w.doc("budget.xlsx");
    page = await br.page();
    await page.goto(await w.open(file));
    await waitDoc(page, ".de-sheet");
    await openSheet(page, "Budget");
  });
  after(async () => {
    await br?.close();
    await w?.cleanup();
  });
  const cell = (ref) => textAt(file, "Budget", Number(ref.slice(1)) - 1, ref.charCodeAt(0) - 65);
  /** The agent changes the file through `onionskin apply`: checked ops, so the server can tell later that every address held (or not). */
  const agentApply = async (op) => {
    const ops = w.doc("ops.json");
    fs.writeFileSync(ops, JSON.stringify({ schema: "onionskin.ops/1", ops: [op] }));
    const r = await w.cli(["apply", file, "--ops", ops]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
  };
  const agentSet = async (ref, value) => agentApply({ op: "set_cells", target: { sheet: "Budget", range: ref }, expect: { quote: await cell(ref) }, values: value });
  /** Comment on a cell, Send, and return the delivered batch: the agent now holds the file. */
  const deliver = async (rowText) => {
    const poll = w.spawnCli(["poll", file]);
    await page.locator(q("banner-listening")).waitFor({ timeout: 20000 });
    await comment(page, rowText, "D", "Please check this figure.");
    await page.locator(q("send")).click();
    const res = await Promise.race([poll.done, new Promise((r) => setTimeout(() => r(null), 20000))]);
    assert.ok(res, "poll did not return after Send");
    await page.locator(q("banner-working")).waitFor();
    return JSON.parse(res.stdout);
  };
  const type = async (rowText, col, text, enter = true) => {
    const b = await until(() => xlsxCell(page, rowText, col), `${rowText}/${col} rendered`);
    await page.mouse.click(center(b).x, center(b).y);
    await page.keyboard.type(text);
    if (enter) await page.keyboard.press("Enter");
  };
  const finish = async (batch) => {
    const results = w.doc("results.json");
    fs.writeFileSync(results, JSON.stringify({ summary: "Updated.", results: batch.instructions.comments.map((c) => ({ comment_id: c.id, status: "done", note: "Done." })) }));
    const done = await w.cli(["done", file, "--results", results]);
    assert.equal(done.code, 0, done.stderr);
  };
  const shows = (text) => until(async () => (await page.locator(".de-cell", { hasText: new RegExp(`^${text}$`) }).count()) > 0, `a cell reading ${text} in the page`, 30000);
  /** The page is quiet again: the run is over, the new file is up and nothing is waiting to be merged (the next test clicks into it). */
  const settled = async () => {
    await until(async () => (await page.locator(q("state-pill")).first().textContent()) === "Idle" && (await page.locator(".de-cell").count()) > 0 && /No unsent edits/.test(await page.locator(".topbar").textContent()), "the page to be idle with no unsent edits", 30000);
    await page.waitForTimeout(600);
  };

  test("the sheet is not locked: a cell typed during the run is merged with the agent's change, in the page and on disk", async () => {
    const batch = await deliver("Line item 029");
    assert.match(await page.locator(q("banner-lock-line")).textContent(), /Keep editing/);
    assert.equal(await page.locator(q("editbar")).isHidden(), false, "the formatting bar stays");
    assert.equal(await page.locator(".locked-note").count(), 0, "no locked note");
    await type("Line item 015", "C", "4242");
    await shows("4242");
    assert.equal(await page.locator(q("send")).isDisabled(), true, "an edit alone is nothing to queue");
    await agentSet("D30", 1400);
    const answer = page.waitForResponse((r) => r.url().includes("/api/merge"));
    await finish(batch);
    const merged = await (await answer).json();
    assert.deepEqual({ merged: merged.merged, unplaced: merged.unplaced }, { merged: 1, unplaced: [] }, "the file the page saved differs from the one it loaded in exactly the typed cell");
    await until(async () => (await cell("C16")) === "4242", "the typed value to be on disk");
    assert.equal(await cell("D30"), "1400", "the agent's change is on disk");
    await shows("1400");
    await shows("4242");
    assert.equal(await page.locator(q("banner-held-back")).count(), 0, "nothing was held back");
    await settled();
  });

  test("the user and the agent change the same cell: the agent's value stays and the user's value is shown with a Copy button", async () => {
    const batch = await deliver("Line item 005");
    await type("Line item 020", "D", "777");
    await agentSet("D21", 888);
    await finish(batch);
    const held = page.locator(q("banner-held-back"));
    await held.waitFor({ timeout: 30000 });
    assert.match(await held.textContent(), /One edit you made while the agent worked is not in the document/);
    assert.match(await held.locator(q("held-item")).first().textContent(), /The agent changed Budget!D21 too[\s\S]*777/);
    assert.equal(await held.locator(q("held-copy")).count(), 0, "one value, shown in full: no copy of the file is needed");
    assert.equal(await cell("D21"), "888", "the agent's cell was not overwritten");
    await shows("888");
    await page.locator(q("held-dismiss")).click();
    await held.waitFor({ state: "detached" });
    await settled();
  });

  test("a cell still being typed when the agent finishes (no Enter yet) is not lost", async () => {
    const batch = await deliver("Line item 006");
    await type("Line item 025", "C", "555", false);
    await agentSet("D7", 901);
    await finish(batch);
    await until(async () => (await cell("C26")) === "555", "the value that was being typed to be on disk");
    assert.equal(await cell("D7"), "901");
    assert.equal(await page.locator(q("banner-held-back")).count(), 0);
    await settled();
  });

  test("a cell still being typed when the agent finishes is not lost when the focus has moved to the note box", async () => {
    const batch = await deliver("Line item 004");
    await type("Line item 026", "C", "556", false);
    await page.locator(q("overall-note")).click();
    await agentSet("D10", 904);
    await finish(batch);
    await until(async () => (await cell("C27")) === "556", "the value that was being typed to be on disk");
    assert.equal(await cell("D10"), "904");
    assert.equal(await page.locator(q("banner-held-back")).count(), 0);
    await settled();
  });

  test("a cell typed while the merge itself is under way goes in with a second pass", async () => {
    const batch = await deliver("Line item 007");
    await type("Line item 010", "C", "111");
    let hold;
    const held = new Promise((r) => (hold = r));
    let merges = 0;
    await page.route("**/api/merge*", async (route) => {
      if (++merges === 1) await held; // the first merge request waits here, with the page's file already in it
      await route.continue();
    });
    await agentSet("D8", 902);
    await finish(batch);
    await until(() => merges === 1, "the page to ask for the merge");
    await type("Line item 011", "C", "222");
    await type("Line item 021", "C", "223", false); // and one more cell that is still open when the first pass comes back
    hold();
    await until(async () => (await cell("C12")) === "222" && (await cell("C22")) === "223", "the values typed during the merge to be on disk");
    assert.equal(await cell("C11"), "111");
    assert.equal(await cell("D8"), "902");
    assert.equal(merges, 2, "one more pass for what was typed during the first");
    await page.unroute("**/api/merge*");
    assert.equal(await page.locator(q("banner-held-back")).count(), 0);
    await settled();
  });

  test("the agent inserts a row: nothing is placed by address on that sheet; the values are shown and the user's file is kept next to the original", async () => {
    const batch = await deliver("Line item 008");
    await type("Line item 012", "C", "333");
    await type("Line item 013", "C", "334");
    const { sd } = await cellsOf(file, "Budget");
    const { rangeText } = await srcModule("xlsx.js");
    await agentApply({ op: "insert_rows", target: { sheet: "Budget", at: 5 }, expect: { quote: rangeText(sd, { r0: 4, c0: 0, r1: 4, c1: 4 }) } });
    await finish(batch);
    const held = page.locator(q("banner-held-back"));
    await held.waitFor({ timeout: 30000 });
    assert.match(await held.locator(q("held-item")).first().textContent(), /The agent added, removed or moved rows or columns on the sheet "Budget"[\s\S]*C13: 333\s*C14: 334/);
    const name = (await held.locator(q("held-copy")).textContent()).match(/saved as (budget \(Onionskin copy [^)]*\)\.xlsx)/)?.[1];
    assert.ok(name, "the message names the copy");
    assert.equal(await textAt(w.doc(name), "Budget", 12, 2), "333", "the copy is the user's version");
    assert.equal(await textAt(w.doc(name), "Budget", 13, 2), "334");
    assert.equal(await cell("C14"), "220", "the agent's file is as the agent left it: row 13 moved to row 14 with its own value");
    assert.equal(await cell("C13"), "222", "row 12 (typed in the test before this one) moved to row 13");
    await page.locator(q("held-dismiss")).click();
    await settled();
  });

  test("formatting changed during the run is reported as not carried over; the value typed next to it still merges", async () => {
    const batch = await deliver("Line item 009");
    const b = await until(() => xlsxCell(page, "Line item 014", "A"), "A16 rendered");
    await page.mouse.click(center(b).x, center(b).y);
    await page.keyboard.press(process.platform === "darwin" ? "Meta+b" : "Control+b");
    await type("Line item 014", "C", "444");
    await agentSet("D11", 903);
    await finish(batch);
    const held = page.locator(q("banner-held-back"));
    await held.waitFor({ timeout: 30000 });
    assert.match(await held.locator(q("held-item")).first().textContent(), /You changed formatting on the sheet "Budget"\. Formatting is not carried over\./);
    assert.equal(await held.locator(q("held-item")).count(), 1);
    assert.equal(await cell("C16"), "444", "the typed value is on disk (row 15 is row 16 since the agent's inserted row)");
    assert.equal(await cell("D11"), "903");
    await page.locator(q("held-dismiss")).click();
    await settled();
  });

  test("the agent changes one cell with another tool and commits the copy: Onionskin cannot check where cells went, so the value is handed back with the user's file", async () => {
    const batch = await deliver("Line item 010");
    await type("Line item 016", "C", "445");
    const copy = w.doc("agent-copy.xlsx");
    fs.copyFileSync(file, copy);
    agentEdit([copy, "xlsx-set", "Budget", "D12", "905"]);
    const committed = await w.cli(["commit", file, "--from", copy]);
    assert.equal(committed.code, 0, committed.stdout + committed.stderr);
    await finish(batch);
    const held = page.locator(q("banner-held-back"));
    await held.waitFor({ timeout: 30000 });
    assert.match(await held.locator(q("held-item")).first().textContent(), /The agent changed the sheet "Budget" in a way Onionskin cannot check cell by cell[\s\S]*C18: 445/);
    const name = (await held.locator(q("held-copy")).textContent()).match(/saved as (budget \(Onionskin copy [^)]*\)(?: \d+)?\.xlsx)/)?.[1]; // a second copy in the same minute is numbered
    assert.ok(name, "the message names the copy");
    assert.equal(await textAt(w.doc(name), "Budget", 17, 2), "445", "the copy is the user's version");
    assert.equal(await cell("D12"), "905", "the agent's file is as the agent left it");
    assert.notEqual(await cell("C18"), "445", "the value was not written by address");
    await page.locator(q("held-dismiss")).click();
    await settled();
  });

  test("zero CSP violations and zero page errors", async () => {
    assert.deepEqual(cspViolations(br.log), []);
    assert.deepEqual(br.log.errors, []);
    assert.deepEqual(br.log.console.filter((m) => m.type === "error"), []);
  });
});
