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

  // The server's folder watcher (src/watch.js) pushes changedOutside; the page raises the notice when that event arrives. No focus event is sent and
  // the /api/stale requests are counted, so these pass only through the push.
  const staleCalls = (page) => {
    const calls = [];
    page.on("request", (r) => r.url().includes("/api/stale") && calls.push(r.url()));
    return calls;
  };
  test("the watcher's push raises the notice with no focus and no Send; never in a read-only tab; a closed notice stays closed", async () => {
    const file = w.doc("pushed.docx");
    fs.copyFileSync(w.doc("pristine.docx"), file);
    const page = await br.page();
    await page.goto(await w.open(file));
    await waitDoc(page);
    const second = await br.page(); // a second tab of the same file: read-only
    await second.goto(await w.open(file));
    await second.locator('[data-testid="banner-readonly"]').waitFor({ timeout: 10000 });
    const calls = staleCalls(page);
    agentEdit([file, "replace", "short note", "EXTERNAL-NOTE", "Paragraph 006:"]);
    const outside = sha(file);
    await page.locator('[data-testid="banner-outside"]').waitFor({ timeout: 8000 });
    assert.deepEqual(calls, [], "raised by the pushed event, not by the stale check");
    assert.equal(sha(file), outside, "the file was not touched");
    await second.waitForTimeout(500);
    assert.equal(await second.locator('[data-testid="banner-outside"]').count(), 0, "never in a read-only tab");
    // closed: later state events still carry the flag, the notice does not come back
    await page.locator('[data-testid="outside-close"]').click();
    await page.locator('[data-testid="overall-note"]').fill("A note that is saved as a draft.");
    await page.waitForTimeout(2000);
    assert.equal(await page.locator('[data-testid="banner-outside"]').count(), 0, "a closed notice stays closed");
    await second.close();
    await page.close();
  });

  test("mid-run: an outside save while the agent holds the batch raises the notice at once, still locked; nothing is written", async () => {
    const file = w.doc("pushed-run.docx");
    fs.copyFileSync(w.doc("pristine.docx"), file);
    const page = await br.page();
    await page.goto(await w.open(file));
    await waitDoc(page);
    const poll = w.spawnCli(["poll", file]); // an agent that holds the batch and writes nothing
    await page.locator('[data-testid="overall-note"]').fill("Please tidy up.");
    await page.waitForTimeout(500);
    await page.locator('[data-testid="send"]').click();
    await page.locator('[data-testid="banner-working"]').waitFor({ timeout: 15000 });
    await typeInPara(page, "Paragraph 004:", " HELDEDIT"); // typed while the agent works: merged when it finishes
    await page.waitForTimeout(800);
    const calls = staleCalls(page);
    agentEdit([file, "replace", "short note", "EXTERNAL-NOTE", "Paragraph 006:"]);
    const outside = sha(file);
    await page.locator('[data-testid="banner-outside"]').waitFor({ timeout: 8000 });
    assert.equal(await page.locator('[data-testid="banner-working"]').count(), 1, "shown while the batch is still out");
    // no Reload while locked: it would replace what was typed during the run
    assert.equal(await page.locator('[data-testid="reload-disk-early"]').count(), 0, "no Reload while the agent works");
    assert.match(await page.locator('[data-testid="banner-outside"]').textContent(), /Your edits are merged when the agent finishes\./);
    assert.ok(!/press Send/.test(await page.locator('[data-testid="banner-outside"]').textContent()), "no Send promise while locked");
    assert.deepEqual(calls, [], "the stale check never runs while locked");
    assert.equal(sha(file), outside, "nothing was written over the outside version");
    assert.deepEqual(copiesOf(file), []);
    // the agent then commits a version made from the file it was sent: refused (the disk moved), its version goes to a copy and its own banner
    // says so; the first notice is not shown a second time beside it
    const res = await Promise.race([poll.done, new Promise((r) => setTimeout(() => r(null), 10000))]);
    const batch = JSON.parse(res.stdout);
    const candidate = path.join(w.root, "candidate-pushed.docx");
    fs.copyFileSync(w.doc("pristine.docx"), candidate);
    const commit = w.spawnCli(["commit", file, "--from", candidate, "--lease", batch.lease_ticket]);
    await Promise.race([commit.done, new Promise((r) => setTimeout(r, 20000))]);
    await page.locator('[data-testid="banner-agent-outside"]').waitFor({ timeout: 10000 });
    assert.equal(await page.locator('[data-testid="banner-outside"]').count(), 0, "one outside-change banner, the agent's, with its copy");
    assert.equal(sha(file), outside, "still the outside version");
    assert.equal(await page.locator('[data-testid="banner-working"]').count(), 1, "the refused commit leaves the batch with the agent: still locked");
    assert.equal(await page.locator('[data-testid="reload-disk-agent"]').count(), 0, "no Reload on the agent's banner while locked either");
    assert.equal(await page.locator(".de-p", { hasText: "HELDEDIT" }).count(), 1, "the edit typed during the run is still there");
    await page.close();
  });

  test("after Reload the changed file, the next outside save raises the notice again", async () => {
    const file = w.doc("pushed-reload.docx");
    fs.copyFileSync(w.doc("pristine.docx"), file);
    const page = await br.page();
    await page.goto(await w.open(file));
    await waitDoc(page);
    agentEdit([file, "replace", "short note", "EXTERNAL-ONE", "Paragraph 006:"]);
    await page.locator('[data-testid="banner-outside"]').waitFor({ timeout: 8000 });
    await page.locator('[data-testid="reload-disk-early"]').click();
    await page.locator(".de-p", { hasText: "EXTERNAL-ONE" }).first().waitFor({ timeout: 15000 });
    await page.locator('[data-testid="overall-note"]').fill("A draft, so a state event goes out."); // the field may still say true until now
    await page.waitForTimeout(2000);
    assert.equal(await page.locator('[data-testid="banner-outside"]').count(), 0, "the version the page took raises nothing");
    // the person's own typed Send after the Reload is not an outside change either
    await typeInPara(page, "Paragraph 004:", " MINE-AFTER-RELOAD");
    await page.waitForTimeout(500);
    await page.locator('[data-testid="send"]').click();
    await until(async () => (await readZipText(file, "word/document.xml")).includes("MINE-AFTER-RELOAD"), "the Send on disk", 15000);
    await page.waitForTimeout(2500); // past the watcher's settle
    assert.equal(await page.locator('[data-testid="banner-outside"]').count(), 0, "the person's own Send raises no outside notice");
    agentEdit([file, "replace", "EXTERNAL-ONE", "EXTERNAL-TWO", "Paragraph 006:"]);
    await page.locator('[data-testid="banner-outside"]').waitFor({ timeout: 8000 });
    await page.close();
  });
});
