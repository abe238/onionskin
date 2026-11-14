import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { boxOf, cspViolations, launch, makeWorld, para, readZipText, relBox, scrollToPara, waitDoc } from "./helpers/harness.mjs";

// The agent side through ONE call per batch: `onionskin reply ... --then-poll`, two rounds, in a real browser.
describe("agent answers with `onionskin reply` (DOCX)", () => {
  let w, br, page, file, poll, batch, replyRun;

  const commentOn = async (prefix, text, dy = 12) => {
    const deep = await scrollToPara(page, prefix, 0.5);
    const db = await boxOf(deep);
    await page.mouse.dblclick(db.x + 150, db.y + dy);
    await page.locator('[data-testid="comment-chip"]').waitFor({ timeout: 5000 });
    await page.locator('[data-testid="comment-chip"]').click();
    await page.locator('[data-testid="comment-card"] textarea').last().fill(text);
    await page.waitForTimeout(700);
  };

  before(async () => {
    w = makeWorld({ ONIONSKIN_NO_SOFFICE: "1" });
    br = await launch();
    file = w.doc("long.docx");
  });
  after(async () => {
    await br?.close();
    await w?.cleanup();
  });

  test("Send delivers a complete first batch whose comments say which reply form fits", async () => {
    poll = w.spawnCli(["poll", file]);
    const url = await w.open(file);
    page = await br.page();
    await page.goto(url);
    await waitDoc(page);
    await page.locator('[data-testid="banner-listening"]').waitFor({ timeout: 20000 });
    await commentOn("Paragraph 148:", "Say 'brief note' instead of 'short note'.");
    await page.locator('[data-testid="send"]').click();
    const res = await Promise.race([poll.done, new Promise((r) => setTimeout(() => r(null), 20000))]);
    assert.ok(res, "poll did not return after Send");
    assert.equal(res.code, 0, res.stderr);
    batch = JSON.parse(res.stdout);
    assert.equal(batch.compact, undefined, "the first batch is complete");
    assert.ok(batch.how_to_apply);
    assert.equal(batch.instructions.comments[0].reply_with, "find_replace_or_text");
  });

  test("one reply call applies, finishes and waits; the page reloads at the same place with the result in the feed", async () => {
    const c = batch.instructions.comments[0];
    replyRun = w.spawnCli(["reply", file, "--lease", batch.lease_ticket, "--then-poll", "--json", JSON.stringify({ summary: "Brief note.", replies: [{ comment: c.id, find: "short note", replace: "brief note", note: "Reworded." }] })]);
    await page.locator('[data-testid="activity-entry"]').first().waitFor({ timeout: 20000 });
    await page.locator(".de-p", { hasText: "brief note" }).first().waitFor({ timeout: 30000 });
    assert.match(await readZipText(file, "word/document.xml"), /brief note/);
    assert.equal(await page.locator('[data-testid="comment-card"][data-status="done"]').count(), 1);
    assert.match(await page.locator('[data-testid="activity-summary"]').last().textContent(), /Brief note/);
    assert.ok((await page.locator('[data-testid="docwrap"] [contenteditable="true"]').count()) > 0, "document editable after done");
    const st = JSON.parse((await w.cli(["status", file])).stdout);
    assert.equal(st.state, "listening", "reply --then-poll is already waiting for the next round");
  });

  test("the second Send arrives as the second JSON line, compact, and is answered the same way", async () => {
    await page.waitForTimeout(1500);
    await commentOn("Paragraph 120:", "Make this start with Hello.");
    await page.locator('[data-testid="send"]').click();
    const out = await Promise.race([replyRun.done, new Promise((r) => setTimeout(() => r(null), 30000))]);
    assert.ok(out, "reply --then-poll did not return after the second Send");
    assert.equal(out.code, 0, out.stderr);
    assert.equal(out.stderr, "");
    const lines = out.stdout.trim().split("\n");
    assert.equal(lines.length, 2);
    const first = JSON.parse(lines[0]);
    assert.equal(first.ok, true);
    assert.deepEqual(first.applied, [batch.instructions.comments[0].id]);
    const next = JSON.parse(lines[1]);
    assert.equal(next.compact, true);
    assert.equal(next.how_to_apply, undefined);
    assert.match(next.next_step, /onionskin reply /);
    const c = next.instructions.comments[0];
    const anchor = next.untrusted_document_evidence.anchors.find((a) => a.id === c.anchor_id);
    assert.equal(c.reply_with, "find_replace_or_text");
    assert.ok(anchor.resolved && anchor.locator.text_hash);
    const r = await w.cli(["reply", file, "--lease", next.lease_ticket, "--json", JSON.stringify({ summary: "Hello.", replies: [{ comment: c.id, find: "Paragraph 120:", replace: "Hello 120:" }] })]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(JSON.parse(r.stdout).ok, true);
    await page.locator(".de-p", { hasText: "Hello 120:" }).first().waitFor({ timeout: 30000 });
    assert.equal(await page.locator('[data-testid="activity-entry"]').count() >= 2, true);
    assert.equal(await relBox(page, para(page, "Hello 120:")).then((b) => !!b), true);
  });

  test("a failed reply writes nothing and leaves the batch open for a corrected call", async () => {
    await page.waitForTimeout(1500);
    await commentOn("Paragraph 150:", "Fix the wording.");
    const p2 = w.spawnCli(["poll", file, "--ack", "--timeout", "30"]);
    await page.locator('[data-testid="send"]').click();
    const res = await Promise.race([p2.done, new Promise((r) => setTimeout(() => r(null), 30000))]);
    assert.ok(res, "poll did not return");
    const b = JSON.parse(res.stdout);
    const c = b.instructions.comments[0];
    const bad = await w.cli(["reply", file, "--lease", b.lease_ticket, "--json", JSON.stringify({ summary: "x", replies: [{ comment: c.id, find: "text that is not there", replace: "y" }] })]);
    assert.notEqual(bad.code, 0);
    const j = JSON.parse(bad.stdout);
    assert.equal(j.ok, false);
    assert.equal(j.lease_kept, true);
    assert.equal(j.problems[0].comment, c.id);
    assert.equal((await w.cli(["status", file])).stdout.includes('"state": "working"'), true, "the batch is still open");
    const good = await w.cli(["reply", file, "--lease", b.lease_ticket, "--json", JSON.stringify({ summary: "ok", replies: [{ comment: c.id, decline: true, note: "Leave it." }] })]);
    assert.equal(good.code, 0, good.stdout);
    await page.locator('[data-testid="comment-card"][data-status="declined"]').first().waitFor({ timeout: 20000 });
  });

  test("zero CSP violations and zero page errors", async () => {
    assert.deepEqual(cspViolations(br.log), []);
    assert.deepEqual(br.log.errors, []);
    assert.deepEqual(br.log.console.filter((m) => m.type === "error"), []);
  });
});
