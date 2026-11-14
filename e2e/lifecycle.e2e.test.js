import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { LINE_END, agentEdit, boxOf, launch, makeWorld, para, readZipText, scrollToPara, until, waitDoc } from "./helpers/harness.mjs";

// Milestone review fixes seen through a real browser: the overall note moves with its batch (7), Take back after the agent wrote (5),
// a comment added while the agent works lands on the right paragraph (6), unsent edits are not lost silently (8).
const textComment = async (page, text, body) => {
  const p = await scrollToPara(page, text, Number(text.match(/\d+/)[0]) / 300);
  const b = await boxOf(p);
  await page.mouse.dblclick(b.x + 150, b.y + 12);
  await page.locator('[data-testid="comment-chip"]').waitFor({ timeout: 5000 });
  await page.locator('[data-testid="comment-chip"]').click();
  await page.locator('[data-testid="comment-card"] textarea').last().fill(body);
};
const typeIntoParagraph = async (page, text, add) => {
  const p = await scrollToPara(page, text, Number(text.match(/\d+/)[0]) / 300);
  const b = await boxOf(p);
  await page.mouse.click(b.x + b.width - 40, b.y + b.height - 10);
  await page.keyboard.press(LINE_END);
  await page.keyboard.type(add);
};

describe("note lifecycle, take back after an agent write, queued comments (DOCX)", () => {
  let w, br, page, file, poll, batch;
  before(async () => {
    w = makeWorld();
    br = await launch();
    file = w.doc("long.docx");
  });
  after(async () => {
    await br?.close();
    await w?.cleanup();
  });

  test("the note box empties after Send, the Send count returns to zero, and Take back puts the note back", async () => {
    poll = w.spawnCli(["poll", file]);
    const url = await w.open(file);
    page = await br.page();
    await page.goto(url);
    await waitDoc(page);
    await page.locator('[data-testid="banner-listening"]').waitFor({ timeout: 20000 });
    await textComment(page, "Paragraph 030:", "Name an owner here.");
    await page.locator('[data-testid="overall-note"]').fill("Keep the tone formal.");
    await page.waitForTimeout(700);
    // Cmd+Enter (Ctrl+Enter on Windows) in a comment box sends, the same as the Send button
    await page.locator('[data-testid="comment-card"] textarea').last().press(process.platform === "darwin" ? "Meta+Enter" : "Control+Enter");
    const res = await Promise.race([poll.done, new Promise((r) => setTimeout(() => r(null), 20000))]);
    assert.ok(res && res.code === 0, res?.stderr);
    batch = JSON.parse(res.stdout);
    assert.equal(batch.instructions.overall_note, "Keep the tone formal.");
    assert.ok(batch.lease?.token && batch.lease?.holder, "poll prints the lease of this delivery");
    await page.locator('[data-testid="banner-working"]').waitFor();
    assert.equal(await page.locator('[data-testid="overall-note"]').inputValue(), "", "the note box is empty after Send");
    assert.equal(await page.locator('[data-testid="send"]').isDisabled(), true, "nothing left to send");
    assert.equal(await page.locator('[data-testid="send-counts"], .send-counts').count(), 0, "the Send count is back to zero");

    // the agent writes (here: straight into the file), then the user takes the batch back
    agentEdit([file, "replace", "regional leads", "regional managers", "Paragraph 010:"]);
    await page.locator('[data-testid="take-back"]').click();
    await page.locator(".de-p", { hasText: "regional managers" }).first().waitFor({ timeout: 30000 });
    const flag = page.locator('[data-testid="activity-flags"] [data-code="taken_back_mid_run"]');
    await flag.waitFor({ timeout: 10000 });
    assert.equal(await page.locator('[data-testid="overall-note"]').inputValue(), "Keep the tone formal.", "the withdrawn batch's note came back");
    assert.equal(await page.locator('[data-testid="comment-card"] textarea').last().inputValue(), "Name an owner here.");
    // the run can be reverted: the file returns to the version before the agent wrote
    await page.locator('[data-testid="revert"]').click();
    await page.locator(".de-p", { hasText: "Paragraph 010:" }).first().waitFor({ timeout: 30000 });
    await until(async () => !/regional managers/.test(await readZipText(file, "word/document.xml")), "the file to be reverted");
    assert.match(await readZipText(file, "word/document.xml"), /regional leads/);
  });
});

describe("a comment added while the agent works is anchored where the user put it (DOCX)", () => {
  let w, br, page, file;
  before(async () => {
    w = makeWorld();
    br = await launch();
    file = w.doc("long.docx");
  });
  after(async () => {
    await br?.close();
    await w?.cleanup();
  });

  test("the agent inserts a paragraph above; the queued comment's batch carries a resolved anchor on the right paragraph", async () => {
    const poll1 = w.spawnCli(["poll", file]);
    const url = await w.open(file);
    page = await br.page();
    await page.goto(url);
    await waitDoc(page);
    await page.locator('[data-testid="banner-listening"]').waitFor({ timeout: 20000 });
    await textComment(page, "Paragraph 030:", "First comment.");
    await page.locator('[data-testid="send"]').click();
    const first = JSON.parse((await Promise.race([poll1.done, new Promise((r) => setTimeout(() => r(null), 20000))])).stdout);
    await page.locator('[data-testid="banner-working"]').waitFor();
    // comment on another paragraph while the agent works
    await page.locator('[data-testid="mode-comment"]').click();
    const b = await boxOf(await scrollToPara(page, "Paragraph 060:", 60 / 300));
    await page.mouse.click(b.x + 120, b.y + 12);
    await page.locator('[data-testid="comment-card"] textarea').last().fill("Second comment, sent while the agent works.");
    await page.locator('[data-testid="mode-edit"]').click();
    await page.waitForTimeout(700);
    await page.locator('[data-testid="send"]').click();
    await until(async () => (await page.locator('[data-testid="state-pill"]').textContent()).match(/queued/i), "the queued state");
    // the agent inserts a paragraph near the top, answers the first comment and finishes
    agentEdit([file, "insert-before", "Paragraph 002:", "INSERTED BY THE AGENT: a new paragraph near the top of the document."]);
    const results = w.doc("results.json");
    fs.writeFileSync(results, JSON.stringify({ summary: "Inserted a paragraph.", results: [{ comment_id: first.instructions.comments[0].id, status: "done", note: "Done." }] }));
    const done = await w.cli(["done", file, "--results", results]);
    assert.equal(done.code, 0, done.stderr);
    const second = await w.cli(["poll", file, "--ack", "--timeout", "20"]);
    const batch2 = JSON.parse(second.stdout);
    assert.equal(batch2.instructions.comments.length, 1);
    const a = batch2.untrusted_document_evidence.anchors[0];
    assert.equal(a.resolved, true);
    assert.match(a.quote, /^Paragraph 060:/);
    assert.ok(a.locator.text_hash);
    const chip = page.locator('[data-testid="comment-card"][data-kind="element"]');
    await until(async () => (await chip.last().getAttribute("data-resolved-text"))?.startsWith("Paragraph 060:"), "the card to sit on Paragraph 060");
  });
});

describe("unsent edits are not lost silently", () => {
  let w, br, file;
  before(async () => {
    w = makeWorld();
    br = await launch();
    file = w.doc("long.docx");
  });
  after(async () => {
    await br?.close();
    await w?.cleanup();
  });

  test("leaving the page asks first when there are typed edits, a pending draft is flushed, and a clean page leaves quietly", async () => {
    const url = await w.open(file);
    const page = await br.page();
    await page.goto(url);
    await waitDoc(page);
    // clean page: no prompt
    const dialogs = [];
    page.on("dialog", (d) => (dialogs.push(d.type()), d.dismiss()));
    await page.close({ runBeforeUnload: true });
    await new Promise((r) => setTimeout(r, 800));
    assert.deepEqual(dialogs, [], "no prompt without edits");
    assert.equal(page.isClosed(), true);

    const p2 = await br.page();
    await p2.goto(await w.open(file));
    await waitDoc(p2);
    await typeIntoParagraph(p2, "Paragraph 005:", " TYPED-EDIT");
    await p2.locator('[data-testid="change-item"]').first().waitFor();
    await textComment(p2, "Paragraph 020:", "flush me");
    const seen = [];
    p2.on("dialog", (d) => (seen.push(d.type()), d.dismiss()));
    await p2.close({ runBeforeUnload: true }); // the comment text is younger than the 350 ms autosave
    await p2.waitForTimeout(500);
    assert.deepEqual(seen, ["beforeunload"], "a prompt appears while typed edits are unsent");
    assert.equal(p2.isClosed(), false, "dismissing the prompt keeps the page");
    const sessionsDir = path.join(w.state, "sessions");
    const saved = fs.readdirSync(sessionsDir).map((f) => fs.readFileSync(path.join(sessionsDir, f), "utf8")).join("");
    assert.match(saved, /flush me/, "the draft reached the server on the way out");

    // a refresh asks too, and dismissing it keeps the typed edits
    seen.length = 0;
    await p2.evaluate(() => setTimeout(() => location.reload(), 0));
    await until(() => seen.length > 0, "the beforeunload prompt on refresh", 8000);
    assert.deepEqual(seen, ["beforeunload"]);
    await p2.waitForTimeout(800);
    assert.equal(await p2.locator('[data-testid="change-item"]').count(), 1, "the typed edit is still there after dismissing the refresh");

    // Close session with unsent edits: a dialog that offers the download
    await p2.locator('[data-testid="close"]').click();
    await p2.locator('[data-testid="close-dialog"]').waitFor();
    const [dl] = await Promise.all([p2.waitForEvent("download"), p2.locator('[data-testid="close-download"]').click()]);
    assert.match(dl.suggestedFilename(), /\(my edits\)\.docx$/);
    await p2.locator('[data-testid="close-cancel"]').click();
    assert.equal(await p2.locator('[data-testid="close-dialog"]').count(), 0);
    assert.notEqual((await p2.locator('[data-testid="state-pill"]').textContent()).trim(), "Closed");
    await p2.locator('[data-testid="close"]').click();
    await p2.locator('[data-testid="close-anyway"]').click();
    await p2.locator('[data-testid="banner-closed"]').waitFor();
    assert.match(await p2.locator('[data-testid="banner-closed"] code').textContent(), /^onionskin "?[^<>]+\.docx"?$/, "the closed banner names the real file, a command that runs as written");
    assert.equal(await p2.locator('[data-testid="closed-download"]').count(), 1, "the closed banner still offers the edits");

    // reopen the same file while the closed tab is still on screen: the new tab edits, it is not locked out by the old one
    const p3 = await br.page();
    await p3.goto(await w.open(file));
    await waitDoc(p3);
    await p3.waitForTimeout(1200);
    assert.equal(await p3.locator('[data-testid="banner-readonly"]').count(), 0, "the reopened tab is not read-only");
    assert.equal(await p3.locator('[data-testid="banner-closed"]').count(), 0);
  });

  test("when the server is gone the error banner offers the edits as a download", async () => {
    const w2 = makeWorld();
    try {
      const f = w2.doc("long.docx");
      const page = await br.page();
      await page.goto(await w2.open(f));
      await waitDoc(page);
      await typeIntoParagraph(page, "Paragraph 005:", " TYPED-EDIT");
      await page.locator('[data-testid="change-item"]').first().waitFor();
      await w2.cli(["stop"]);
      await page.locator('[data-testid="overall-note"]').fill("anything");
      await page.locator('[data-testid="send"]').click();
      await page.locator('[data-testid="banner-error"]').waitFor({ timeout: 15000 });
      const [dl] = await Promise.all([page.waitForEvent("download"), page.locator('[data-testid="error-download"]').click()]);
      assert.match(dl.suggestedFilename(), /\(my edits\)\.docx$/);
      page.removeAllListeners("dialog");
      await page.close();
    } finally {
      await w2.cleanup();
    }
  });
});

describe("a late done from an agent whose lease expired (CLI level)", () => {
  let w, br;
  before(async () => {
    w = makeWorld({ ONIONSKIN_LEASE_MS: "1500" });
    br = await launch();
  });
  after(async () => {
    await br?.close();
    await w?.cleanup();
  });

  test("done with the old delivery's --lease is refused (stale_batch); the current agent's done goes through", async () => {
    const file = w.doc("long.docx");
    const pollA = w.spawnCli(["poll", file]);
    const page = await br.page();
    await page.goto(await w.open(file));
    await waitDoc(page);
    await page.locator('[data-testid="banner-listening"]').waitFor({ timeout: 20000 });
    await textComment(page, "Paragraph 030:", "Check this.");
    await page.locator('[data-testid="send"]').click();
    const batchA = JSON.parse((await pollA.done).stdout);
    const ticket = (b) => b.next_step.match(/--lease (b_[0-9a-f]{12}:[0-9a-f]{16})/)?.[1];
    assert.ok(ticket(batchA), "the printed done command carries a lease ticket");
    assert.match(batchA.how_to_apply.command, /--lease b_[0-9a-f]{12}:[0-9a-f]{16}/);
    await until(async () => JSON.parse((await w.cli(["status", file])).stdout).state === "stranded", "the lease to expire", 15000);
    const batchB = JSON.parse((await w.cli(["poll", file, "--timeout", "20"])).stdout);
    assert.equal(batchB.batch_id, batchA.batch_id, "the same batch is delivered again");
    assert.notEqual(ticket(batchB), ticket(batchA));
    const results = w.doc("results.json");
    fs.writeFileSync(results, JSON.stringify({ summary: "late", results: [{ comment_id: batchA.instructions.comments[0].id, status: "done", note: "late" }] }));
    const late = await w.cli(["done", file, "--results", results, "--lease", ticket(batchA)]);
    assert.notEqual(late.code, 0, "the stale done must fail");
    assert.match(late.stderr, /not your delivery/);
    assert.equal(JSON.parse((await w.cli(["status", file])).stdout).state, "working", "agent B still holds the batch");
    const ok = await w.cli(["done", file, "--results", results, "--lease", ticket(batchB)]);
    assert.equal(ok.code, 0, ok.stderr);
  });
});
