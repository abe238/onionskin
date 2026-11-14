import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { boxOf, cspViolations, launch, makeWorld, readZipText, scrollToPara, waitDoc } from "./helpers/harness.mjs";

// The agent asks instead of declining: a question card in a real browser, a tap, and the answer in the next batch.
describe("question cards (DOCX)", () => {
  let w, br, page, file, batch, replyRun;
  const HOSTILE = "<img src=x onerror=alert(1)>"; // 28 characters: a valid option, drawn as text
  const askedCard = () => page.locator('[data-testid="comment-card"][data-status="asked"]');

  const commentOn = async (prefix, text, dy = 12) => {
    const deep = await scrollToPara(page, prefix, 0.5);
    const db = await boxOf(deep);
    await page.mouse.dblclick(db.x + 150, db.y + dy);
    await page.locator('[data-testid="comment-chip"]').waitFor({ timeout: 5000 });
    await page.locator('[data-testid="comment-chip"]').click();
    await page.locator('[data-testid="comment-card"] textarea').last().fill(text);
    await page.waitForTimeout(700);
  };
  const lines = async (run, ms = 30000) => {
    const out = await Promise.race([run.done, new Promise((r) => setTimeout(() => r(null), ms))]);
    assert.ok(out, "reply --then-poll did not return");
    assert.equal(out.code, 0, out.stdout + out.stderr);
    return out.stdout.trim().split("\n").map((l) => JSON.parse(l));
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

  test("the agent's question shows on the card as plain text, with the person's comment above it", async () => {
    const poll = w.spawnCli(["poll", file]);
    const url = await w.open(file);
    page = await br.page();
    await page.goto(url);
    await waitDoc(page);
    await page.locator('[data-testid="banner-listening"]').waitFor({ timeout: 20000 });
    await commentOn("Paragraph 148:", "Change the wording here.");
    await page.locator('[data-testid="send"]').click();
    const res = await Promise.race([poll.done, new Promise((r) => setTimeout(() => r(null), 20000))]);
    assert.ok(res, "poll did not return after Send");
    batch = JSON.parse(res.stdout);
    const c = batch.instructions.comments[0];
    replyRun = w.spawnCli(["reply", file, "--lease", batch.lease_ticket, "--then-poll", "--json", JSON.stringify({ replies: [{ comment: c.id, ask: "Which word should replace short?", options: ["brief", HOSTILE] }] })]);
    const card = askedCard();
    await card.waitFor({ timeout: 20000 });
    assert.equal(await card.getAttribute("data-comment-id"), c.id);
    assert.equal((await card.locator('[data-testid="card-state"]').textContent()).trim(), "Needs your answer");
    assert.match(await card.locator(".q-head").textContent(), /^The agent asks$/);
    assert.equal(await card.locator('[data-testid="question-text"]').textContent(), "Which word should replace short?");
    assert.deepEqual(await card.locator('[data-testid="question-option"]').allTextContents(), ["brief", HOSTILE]);
    assert.equal((await card.locator('[data-testid="question-else"]').textContent()).trim(), "Something else");
    assert.match(await card.locator(".q-hint").textContent(), /Your answer goes to the agent and it carries on\./);
    assert.equal(await card.locator("img, a, script, iframe").count(), 0, "no element is made from the agent's text");
    assert.equal(await card.locator("textarea").inputValue(), "Change the wording here.");
    assert.equal(await card.locator("textarea").isDisabled(), true);
    assert.equal(await card.locator('[data-testid="agent-note"]').count(), 0);
    assert.deepEqual(cspViolations(br.log), []);
  });

  test("a tap delivers the next batch as the second line: the original words, the index, the question as evidence", async () => {
    // a double click (or a slow page) taps twice: the second tap finds no open question and must stay quiet
    await askedCard().locator('[data-testid="question-option"]').first().dblclick();
    const [first, next] = await lines(replyRun);
    assert.deepEqual(first.asked, [batch.instructions.comments[0].id]);
    const c = next.instructions.comments[0];
    assert.equal(c.id, batch.instructions.comments[0].id);
    assert.equal(c.text, "Change the wording here.");
    assert.deepEqual(c.answer, { choice: 0 });
    const instr = JSON.stringify(next.instructions);
    assert.ok(!instr.includes("brief") && !instr.includes("onerror") && !instr.includes("Which word"), "no agent text in instructions");
    assert.deepEqual(next.untrusted_document_evidence.questions, [{ comment_id: c.id, question: "Which word should replace short?", options: ["brief", HOSTILE] }]);
    await page.waitForTimeout(500);
    assert.equal(await page.locator('[data-testid="banner-error"]').count(), 0, "no error after a double tap");
    batch = next;
  });

  test("the agent applies the chosen reading, and the card says what the person answered", async () => {
    const c = batch.instructions.comments[0];
    replyRun = w.spawnCli(["reply", file, "--lease", batch.lease_ticket, "--then-poll", "--json", JSON.stringify({ replies: [{ comment: c.id, find: "short note", replace: "brief note", note: "Used brief." }] })]);
    const card = page.locator(`[data-testid="comment-card"][data-comment-id="${c.id}"][data-status="done"]`);
    await card.waitFor({ timeout: 30000 });
    assert.match(await readZipText(file, "word/document.xml"), /brief note/);
    assert.equal(await card.locator('[data-testid="question-answered"]').textContent(), "You answered: brief");
    assert.equal(await card.locator('[data-testid="question"]').count(), 0);
  });

  test("Something else gives an editable draft with no question", async () => {
    await page.waitForTimeout(1500);
    await commentOn("Paragraph 120:", "Make this friendlier.");
    await page.locator('[data-testid="send"]').click();
    const [, next] = await lines(replyRun);
    const c = next.instructions.comments.find((x) => x.text === "Make this friendlier.");
    assert.ok(c, "the second comment arrived");
    const r = await w.cli(["reply", file, "--lease", next.lease_ticket, "--json", JSON.stringify({ replies: next.instructions.comments.map((x) => (x.id === c.id ? { comment: x.id, ask: "Friendlier how?", options: ["Warmer", "Shorter"] } : { comment: x.id, decline: true })) })]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const card = page.locator(`[data-testid="comment-card"][data-comment-id="${c.id}"]`);
    await card.and(askedCard()).waitFor({ timeout: 20000 });
    await card.locator('[data-testid="question-else"]').click();
    await page.locator(`[data-testid="comment-card"][data-comment-id="${c.id}"][data-status="draft"]`).waitFor({ timeout: 10000 });
    assert.equal(await card.locator('[data-testid="question"]').count(), 0);
    assert.equal(await card.locator('[data-testid="question-answered"]').count(), 0);
    const ta = card.locator("textarea");
    assert.equal(await ta.isDisabled(), false);
    assert.equal(await ta.getAttribute("placeholder"), "Say what you meant, then send.");
    await ta.fill("Make this warmer, please.");
    assert.equal(await ta.inputValue(), "Make this warmer, please.");
  });

  test("zero CSP violations and zero page errors", async () => {
    assert.deepEqual(cspViolations(br.log), []);
    assert.deepEqual(br.log.errors, []);
    assert.deepEqual(br.log.console.filter((m) => m.type === "error"), []);
  });
});
