import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { cspViolations, launch, makeWorld, until, waitDoc } from "./helpers/harness.mjs";
import { readDocxParagraphs } from "../src/docx.js";
import { verifyTracked } from "../src/redline-check.js";
import { AUTHORS, wordDate } from "../src/redline.js";

// "Save a copy with tracked changes" in a real browser: an agent run through `onionskin apply`, then the button in its History card writes
// a Word copy next to the file, and the file itself stays byte for byte as it was. No clipboard reads, no focus asserts.
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = (page) => page.locator('[data-testid="history-row"]');

let br;
before(async () => {
  br = await launch();
});
after(async () => {
  await br?.close();
});

/** Send with a note, let the agent apply `ops` through the session (or nothing), then `done`. */
async function agentRun(w, page, file, ops) {
  const poll = w.spawnCli(["poll", file]);
  await page.locator('[data-testid="banner-listening"]').waitFor({ timeout: 20000 });
  await page.locator('[data-testid="overall-note"]').fill("Please tidy this up.");
  await page.waitForTimeout(700);
  await page.locator('[data-testid="send"]').click();
  const res = await Promise.race([poll.done, sleep(20000).then(() => null)]);
  assert.ok(res && res.code === 0, res?.stderr);
  if (ops) {
    const opsFile = w.doc(`ops-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(opsFile, JSON.stringify({ schema: "onionskin.ops/1", ops }));
    const r = await w.cli(["apply", file, "--ops", opsFile]);
    assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.equal(JSON.parse(r.stdout).write_path, "session");
  }
  const rj = w.doc(`r-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(rj, JSON.stringify({ summary: "Reworded one note and added a paragraph.", results: [] }));
  assert.equal((await w.cli(["done", file, "--results", rj])).code, 0);
  await page.locator('[data-testid="activity-entry"]').first().waitFor({ timeout: 20000 });
}

describe("Save a copy with tracked changes (DOCX)", () => {
  let w, file, page, stub, before0;
  before(async () => {
    w = makeWorld({ ONIONSKIN_NO_SOFFICE: "1" });
    stub = path.join(w.root, "open-stub.txt");
    w.env.ONIONSKIN_OPEN_STUB = stub; // "Show in folder" records the path instead of opening Finder
    file = w.doc("long.docx");
  });
  after(() => w?.cleanup());

  test("after an agent run, the card's button saves the copy next to the file; the file is unchanged", async () => {
    page = await br.page();
    await page.addInitScript(() => sessionStorage.setItem("onionskin.histCollapsed", "0"));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(await w.open(file));
    await waitDoc(page);
    before0 = fs.readFileSync(file);
    const ps = readDocxParagraphs(before0);
    const p5 = ps.find((p) => p.text.startsWith("Paragraph 005:"));
    const p9 = ps.find((p) => p.text.startsWith("Paragraph 009:"));
    await agentRun(w, page, file, [
      { op: "replace_text", target: { text_hash: p5.hash }, expect: { quote: "short note" }, find: "short note", replace: "brief note" },
      { op: "insert_paragraph_before", target: { text_hash: p9.hash }, expect: { text_hash: p9.hash }, text: "A paragraph the agent added before paragraph nine." },
    ]);
    await until(async () => (await rows(page).count()) === 1, "one history row");
    await rows(page).nth(0).click();
    const button = page.locator('[data-testid="tracked-export-button"]');
    await button.waitFor({ timeout: 15000 });
    assert.match(await page.locator('[data-testid="tracked-export"]').textContent(), /For Word: each change can be accepted or rejected there\. Your file stays as it is\./);
    const disk = sha(file);
    const listed = fs.readdirSync(w.docs);
    await button.click();
    const saved = page.locator('[data-testid="tracked-export-saved"]');
    await saved.waitFor({ timeout: 30000 });
    const m = /^Saved “(long \(tracked changes \d{4}-\d\d-\d\d \d{4}\)\.docx)” in the same folder as your file\.$/.exec((await saved.textContent()).trim());
    assert.ok(m, await saved.textContent());
    const copy = path.join(w.docs, m[1]);
    assert.ok(fs.existsSync(copy), "the copy is next to the file");
    assert.deepEqual(fs.readdirSync(w.docs).filter((n) => !listed.includes(n)), [m[1]], "one new file, nothing else");
    assert.equal(sha(file), disk, "the file itself is unchanged");
    // the copy is checked again here, from outside the server
    const at = await rows(page).nth(0).locator("time").getAttribute("datetime");
    assert.deepEqual(verifyTracked({ before: before0, after: fs.readFileSync(file), out: fs.readFileSync(copy), counts: { formatting: 0 }, author: AUTHORS.agent, date: wordDate(Date.parse(at)) }), { ok: true });
    // Show in folder reveals that path (recorded by the stub)
    await page.locator('[data-testid="tracked-export-show"]').click();
    await until(async () => fs.existsSync(stub) && fs.readFileSync(stub, "utf8").includes(copy), "Show in folder to reveal the copy");
    assert.deepEqual(cspViolations(page.log), []);
    assert.deepEqual(page.log.errors, []);
  });

  test("a read-only tab says to save from the tab that holds the file, and saves nothing", async () => {
    const ro = await br.page();
    await ro.addInitScript(() => sessionStorage.setItem("onionskin.histCollapsed", "0"));
    await ro.goto(await w.open(file));
    await waitDoc(ro);
    await ro.locator('[data-testid="banner-readonly"]').waitFor({ timeout: 15000 });
    const listed = fs.readdirSync(w.docs).sort();
    await rows(ro).nth(0).click();
    await ro.locator('[data-testid="tracked-export-button"]').click();
    const err = ro.locator('[data-testid="tracked-export-error"]');
    await err.waitFor({ timeout: 15000 });
    assert.equal((await err.textContent()).trim(), "Save the copy from the tab that holds the file.");
    assert.deepEqual(fs.readdirSync(w.docs).sort(), listed);
    await ro.close();
  });

  test("the card fits a narrow review panel: no sideways scroll", async () => {
    await page.setViewportSize({ width: 900, height: 800 });
    await page.waitForTimeout(300);
    const over = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="tracked-export"]');
      const box = el.closest(".h-body");
      return { el: el.scrollWidth - el.clientWidth, body: box.scrollWidth - box.clientWidth };
    });
    assert.ok(over.el <= 1 && over.body <= 1, JSON.stringify(over));
  });

  test("the What changed box offers the copy for every change History holds; the file is unchanged", async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('[data-testid="change-note-button"]').click();
    const box = page.locator('[data-testid="change-note"]');
    await box.locator('[data-testid="change-note-text"]').waitFor({ timeout: 15000 });
    const button = box.locator('[data-testid="tracked-export-button"]');
    await button.waitFor({ timeout: 15000 });
    assert.match(await box.locator('[data-testid="tracked-export"]').textContent(), /Covers every change listed here\./);
    const disk = sha(file);
    const listed = fs.readdirSync(w.docs);
    await button.click();
    const saved = box.locator('[data-testid="tracked-export-saved"]');
    await saved.waitFor({ timeout: 30000 });
    const m = /^Saved “(long \(tracked changes \d{4}-\d\d-\d\d \d{4}\)(?: \d+)?\.docx)” in the same folder as your file\.$/.exec((await saved.textContent()).trim());
    assert.ok(m, await saved.textContent());
    assert.deepEqual(fs.readdirSync(w.docs).filter((n) => !listed.includes(n)), [m[1]], "one new file, nothing else");
    assert.equal(sha(file), disk, "the file itself is unchanged");
    assert.deepEqual(cspViolations(page.log), []);
    assert.deepEqual(page.log.errors, []);
  });
});

describe("Save a copy with tracked changes: a run done on this Mac", () => {
  let w;
  before(() => {
    w = makeWorld({ ONIONSKIN_NO_SOFFICE: "1" });
  });
  after(() => w?.cleanup());
  test("a quick change (history kind local) offers the button on its card and the copy is saved; the file is unchanged", async () => {
    const file = w.doc("long.docx");
    const page = await br.page();
    await page.addInitScript(() => sessionStorage.setItem("onionskin.histCollapsed", "0"));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(await w.open(file));
    await waitDoc(page);
    await page.locator('[data-testid="overall-note"]').fill("Replace Paragraph 005 with Paragraph five");
    await page.locator('[data-testid="quick-line"]').waitFor({ timeout: 15000 });
    await page.locator('[data-testid="send"]').click();
    await page.locator('[data-testid="activity-entry"]', { hasText: "Done on this Mac" }).first().waitFor({ timeout: 30000 });
    await until(async () => (await rows(page).count()) === 1, "one history row");
    await rows(page).nth(0).click();
    const button = page.locator('[data-testid="tracked-export-button"]');
    await button.waitFor({ timeout: 15000 });
    const disk = sha(file);
    const listed = fs.readdirSync(w.docs);
    await button.click();
    const saved = page.locator('[data-testid="tracked-export-saved"]');
    await saved.waitFor({ timeout: 30000 });
    const m = /^Saved “(long \(tracked changes \d{4}-\d\d-\d\d \d{4}\)(?: \d+)?\.docx)” in the same folder as your file\.$/.exec((await saved.textContent()).trim());
    assert.ok(m, await saved.textContent());
    assert.deepEqual(fs.readdirSync(w.docs).filter((n) => !listed.includes(n)), [m[1]], "one new file, nothing else");
    assert.equal(sha(file), disk, "the file itself is unchanged");
    assert.deepEqual(page.log.errors, []);
    await page.close();
  });
});

describe("Save a copy with tracked changes: not offered for a spreadsheet", () => {
  let w;
  before(() => {
    w = makeWorld({ ONIONSKIN_NO_SOFFICE: "1" });
  });
  after(() => w?.cleanup());
  test("an agent run on an .xlsx file has no button", async () => {
    const file = w.doc("budget.xlsx");
    const page = await br.page();
    await page.addInitScript(() => sessionStorage.setItem("onionskin.histCollapsed", "0"));
    await page.goto(await w.open(file));
    await waitDoc(page, ".de-tab"); // the default probe (a Word paragraph) never appears in a spreadsheet, and waits out its 30 s
    await agentRun(w, page, file, null);
    await until(async () => (await rows(page).count()) === 1, "one history row");
    await rows(page).nth(0).click();
    await page.locator('[data-testid="history-body"] .h-line, [data-testid="history-body"] [data-testid="history-summary"]').first().waitFor({ timeout: 15000 });
    await page.waitForTimeout(500);
    assert.equal(await page.locator('[data-testid="tracked-export-button"]').count(), 0);
    await page.locator('[data-testid="change-note-button"]').click();
    await page.locator('[data-testid="change-note"]').waitFor({ timeout: 15000 });
    await page.waitForTimeout(300);
    assert.equal(await page.locator('[data-testid="tracked-export-button"]').count(), 0, "the What changed box offers no copy for a spreadsheet");
    await page.close();
  });
});
