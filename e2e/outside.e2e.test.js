import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { LINE_END, agentEdit, boxOf, cspViolations, launch, makeWorld, para, readZipText, until, waitDoc } from "./helpers/harness.mjs";

// Item 12: a file changed outside Onionskin is never overwritten; the version Onionskin holds goes to a copy next to it.
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
async function typeInPara(page, text, suffix) {
  const b = await boxOf(para(page, text));
  await page.mouse.click(b.x + b.width - 40, b.y + b.height - 10);
  await page.keyboard.press(LINE_END);
  await page.keyboard.type(suffix);
}
const copiesOf = (file) => fs.readdirSync(path.dirname(file)).filter((n) => n.startsWith(`${path.basename(file, ".docx")} (`) && /\(Onionskin copy \d{4}-\d\d-\d\d \d{4}\)/.test(n));

let br;
before(async () => {
  br = await launch();
});
after(async () => {
  await br?.close();
});

describe("outside change", () => {
  let w, stub;
  before(() => {
    w = makeWorld({ ONIONSKIN_NO_SOFFICE: "1" });
    stub = path.join(w.root, "open-stub.txt");
    fs.copyFileSync(w.doc("long.docx"), w.doc("pristine.docx")); // each test edits its own copy
    w.env.ONIONSKIN_OPEN_STUB = stub; // `Show in folder` records the path here instead of opening Finder
  });
  after(() => w.cleanup());

  test("the focus check shows the notice without clicking Send; nothing is written", async () => {
    const file = w.doc("long.docx");
    const page = await br.page();
    await page.goto(await w.open(file));
    await waitDoc(page);
    await typeInPara(page, "Paragraph 004:", " MY-EDIT");
    agentEdit([file, "replace", "short note", "EXTERNAL-NOTE", "Paragraph 006:"]);
    const outside = sha(file);
    await page.evaluate(() => window.dispatchEvent(new Event("focus"))); // the tab regained focus
    await page.locator('[data-testid="banner-outside"]').waitFor({ timeout: 10000 });
    assert.match(await page.locator('[data-testid="banner-outside"]').textContent(), /Someone changed this file outside Onionskin/);
    assert.match(await page.locator('[data-testid="banner-outside"]').textContent(), /original file was left untouched/);
    assert.equal(sha(file), outside, "the file was not touched");
    assert.deepEqual(copiesOf(file), [], "no copy until a Send would have overwritten something");
    await page.close();
  });

  test("user Send conflict: new dialog, a copy with the typed edit next to the original, the original untouched, Show in folder, Reload keeps the comment", async () => {
    const file = w.doc("long2.docx");
    fs.copyFileSync(w.doc("pristine.docx"), file);
    const page = await br.page();
    await page.goto(await w.open(file));
    await waitDoc(page);
    await typeInPara(page, "Paragraph 004:", " MY-EDIT");
    await page.locator('[data-testid="change-item"]').first().waitFor();
    await page.locator('[data-testid="mode-comment"]').click();
    const p = para(page, "Paragraph 008:");
    await p.scrollIntoViewIfNeeded();
    const b = await boxOf(p);
    await page.mouse.click(b.x + Math.min(b.width / 2, 200), b.y + 8);
    await page.locator('[data-testid="comment-card"] textarea').last().fill("Is this still current?");
    agentEdit([file, "replace", "short note", "EXTERNAL-NOTE", "Paragraph 006:"]);
    const outside = sha(file);
    await page.locator('[data-testid="send"]').click();
    const dlg = page.locator('[data-testid="banner-conflict"]');
    await dlg.waitFor({ timeout: 10000 });
    const text = await dlg.textContent();
    assert.match(text, /Someone changed this file outside Onionskin\. Your original file was left untouched\. A copy with your edits was saved as long2 \(Onionskin copy \d{4}-\d\d-\d\d \d{4}\)\.docx in the same folder, so you can open both in Word and combine them yourself\./);
    for (const id of ["show-in-folder", "reload-disk", "conflict-close"]) assert.equal(await page.locator(`[data-testid="${id}"]`).count(), 1, id);
    assert.equal(await page.locator('[data-testid="keep-mine"]').count(), 0, "the old Keep mine button is gone");
    assert.equal(sha(file), outside, "the original is byte-identical to the outside version");
    const copies = copiesOf(file);
    assert.equal(copies.length, 1);
    const copyFile = path.join(path.dirname(file), copies[0]);
    assert.ok((await readZipText(copyFile, "word/document.xml")).includes("MY-EDIT"), "the copy has the user's typed edit");
    assert.ok(!(await readZipText(file, "word/document.xml")).includes("MY-EDIT"));
    assert.equal(await page.locator('[data-testid="copy-name"]').textContent(), copies[0]);
    await page.locator('[data-testid="show-in-folder"]').click();
    await until(() => fs.existsSync(stub) && fs.readFileSync(stub, "utf8").trim().endsWith(copies[0]), "the server was asked to reveal the copy");
    await page.locator('[data-testid="reload-disk"]').click();
    await dlg.waitFor({ state: "detached" });
    await page.locator(".de-p", { hasText: "EXTERNAL-NOTE" }).first().waitFor({ timeout: 20000 });
    assert.equal(await page.locator('[data-testid="comment-card"]').count(), 1, "the unsent comment was kept");
    assert.deepEqual(cspViolations(br.log), []);
    await page.close();
  });

  test("Close leaves the page as it was; a second conflict makes a second copy without overwriting the first", async () => {
    const file = w.doc("long3.docx");
    fs.copyFileSync(w.doc("pristine.docx"), file);
    const page = await br.page();
    await page.goto(await w.open(file));
    await waitDoc(page);
    await typeInPara(page, "Paragraph 004:", " ONE");
    agentEdit([file, "replace", "short note", "EXTERNAL-ONE", "Paragraph 006:"]);
    await page.locator('[data-testid="send"]').click();
    await page.locator('[data-testid="banner-conflict"]').waitFor({ timeout: 10000 });
    await page.locator('[data-testid="conflict-close"]').click();
    await page.locator('[data-testid="banner-conflict"]').waitFor({ state: "detached" });
    await page.locator('[data-testid="send"]').click();
    await page.locator('[data-testid="banner-conflict"]').waitFor({ timeout: 10000 });
    await page.waitForTimeout(1500);
    assert.equal(copiesOf(file).length, 2, JSON.stringify(copiesOf(file)));
    await page.close();
  });
});
