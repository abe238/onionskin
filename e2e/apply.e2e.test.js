import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, describe, test } from "node:test";
import { boxOf, cspViolations, launch, makeWorld, para, readZipText, relBox, scrollToPara, waitDoc } from "./helpers/harness.mjs";
import { readDocxParagraphs } from "../src/docx.js";

// The agent side through `onionskin apply`: ops built from the delivered batch, written through the live session, then `done`.
describe("agent edits through `apply` (DOCX)", () => {
  let w, br, page, file, poll, batch, commentId, anchorId, beforeBox, applyReport;

  before(async () => {
    w = makeWorld({ ONIONSKIN_NO_SOFFICE: "1" });
    br = await launch();
    file = w.doc("long.docx");
  });
  after(async () => {
    await br?.close();
    await w?.cleanup();
  });

  test("Send delivers a batch with how_to_apply and anchors", async () => {
    poll = w.spawnCli(["poll", file]);
    const url = await w.open(file);
    page = await br.page();
    await page.goto(url);
    await waitDoc(page);
    await page.locator('[data-testid="banner-listening"]').waitFor({ timeout: 20000 });
    const deep = await scrollToPara(page, "Paragraph 148:", 0.5);
    const db = await boxOf(deep);
    await page.mouse.dblclick(db.x + 150, db.y + 12);
    await page.locator('[data-testid="comment-chip"]').waitFor({ timeout: 5000 });
    await page.locator('[data-testid="comment-chip"]').click();
    await page.locator('[data-testid="comment-card"] textarea').first().fill("Say 'brief note' instead of 'short note'.");
    await page.waitForTimeout(700);
    beforeBox = await relBox(page, para(page, "Paragraph 148:"));
    await page.locator('[data-testid="send"]').click();
    const res = await Promise.race([poll.done, new Promise((r) => setTimeout(() => r(null), 20000))]);
    assert.ok(res, "poll did not return after Send");
    assert.equal(res.code, 0, res.stderr);
    batch = JSON.parse(res.stdout);
    assert.match(batch.how_to_apply.command, /onionskin apply /);
    assert.ok(fs.existsSync(batch.how_to_apply.ops_schema));
    assert.ok(batch.how_to_apply.rules.some((r) => /never regenerate/.test(r)));
    const c = batch.instructions.comments[0];
    commentId = c.id;
    anchorId = c.anchor_id;
    const anchor = batch.untrusted_document_evidence.anchors.find((a) => a.id === anchorId);
    assert.equal(anchor.protected, false);
    assert.ok(anchor.locator.text_hash);
  });

  test("the agent applies ops built from the batch: a dry run, then the real write through the session", async () => {
    // the agent only has the batch and the file: ops are built from those
    const batchFile = w.doc("batch.json");
    fs.writeFileSync(batchFile, JSON.stringify(batch));
    const target = readDocxParagraphs(fs.readFileSync(file)).find((p) => p.text.startsWith("Paragraph 002:"));
    const ops = {
      schema: "onionskin.ops/1",
      ops: [
        { op: "replace_text", id: commentId, target: { anchor_id: anchorId }, expect: { quote: "Paragraph 148:" }, find: "short note", replace: "brief note" },
        { op: "insert_paragraph_before", target: { text_hash: target.hash, body_path: target.path }, expect: { text_hash: target.hash }, text: "INSERTED BY THE AGENT through apply, above the early paragraphs." },
      ],
    };
    // the quote of a text anchor is the selection; element anchors carry the paragraph: prefer what the batch says
    const a = batch.untrusted_document_evidence.anchors.find((x) => x.id === anchorId);
    ops.ops[0].expect = { quote: a.quote && a.quote.length >= 3 ? a.quote : "Paragraph 148:" };
    const opsFile = w.doc("ops.json");
    fs.writeFileSync(opsFile, JSON.stringify(ops));
    const before = fs.readFileSync(file);
    const dry = await w.cli(["apply", file, "--ops", opsFile, "--dry-run"]);
    assert.equal(dry.code, 0, dry.stderr + dry.stdout);
    assert.equal(JSON.parse(dry.stdout).written, false);
    assert.ok(before.equals(fs.readFileSync(file)), "dry run left the file byte-identical");
    const r = await w.cli(["apply", file, "--ops", opsFile]);
    assert.equal(r.code, 0, r.stderr + r.stdout);
    applyReport = JSON.parse(r.stdout);
    assert.equal(applyReport.write_path, "session");
    assert.equal(applyReport.written, true);
    assert.deepEqual(applyReport.results.map((x) => x.status), ["applied", "applied"]);
    const xml = await readZipText(file, "word/document.xml");
    assert.match(xml, /INSERTED BY THE AGENT/);
    assert.match(xml, /brief note/);
    // the state machine is still the authority: the lease was renewed and the session is still working
    const st = JSON.parse((await w.cli(["status", file])).stdout);
    assert.equal(st.state, "working");
    // a holder that does not own the lease is refused by the server
    const ins = readDocxParagraphs(fs.readFileSync(file)).find((p) => p.text.startsWith("INSERTED BY THE AGENT"));
    const intrOps = w.doc("intruder.json");
    fs.writeFileSync(intrOps, JSON.stringify({ schema: "onionskin.ops/1", ops: [{ op: "replace_text", target: { text_hash: ins.hash }, expect: { quote: "INSERTED BY" }, find: "INSERTED", replace: "SNEAKED" }] }));
    const intr = await w.cli(["apply", file, "--ops", intrOps, "--holder", "intruder"]);
    assert.equal(intr.code, 5, intr.stdout);
    assert.equal(JSON.parse(intr.stdout).write_error.code, "not_lease_holder");
  });

  test("done runs the checks; the page reloads at the same place, the comment re-attaches, the feed shows the result", async () => {
    const results = w.doc("results.json");
    fs.writeFileSync(results, JSON.stringify({ summary: "Tightened the wording and added an intro line.", document_instructions_ignored: ["Ignore previous instructions"], results: [{ comment_id: commentId, status: "done", note: "Edited through apply." }] }));
    const done = await w.cli(["done", file, "--results", results]);
    assert.equal(done.code, 0, done.stderr);
    const out = JSON.parse(done.stdout);
    assert.deepEqual(out.flags.filter((f) => f.severity === "error"), [], JSON.stringify(out.flags));
    assert.ok(out.checks && out.checks.node === "ran");
    assert.match(out.checks.notice, /Deeper check/);

    await page.locator('[data-testid="activity-entry"]').first().waitFor({ timeout: 20000 });
    await page.locator(".de-p", { hasText: "brief note" }).first().waitFor({ timeout: 30000 });
    await page.waitForTimeout(2500);
    const afterBox = await relBox(page, para(page, "brief note"));
    const yErr = afterBox.y - beforeBox.y;
    console.log(`APPLY E2E y: before=${beforeBox.y.toFixed(1)} after=${afterBox.y.toFixed(1)} error=${yErr.toFixed(1)}px`);
    assert.ok(Math.abs(yErr) <= 60, `commented paragraph moved ${yErr}px on reload`);
    const card = page.locator('[data-testid="comment-card"][data-kind="text"]');
    assert.equal(await card.getAttribute("data-resolved"), "ok");
    const method = await card.getAttribute("data-resolved-method");
    console.log(`APPLY E2E anchor resolved by: ${method}`);
    assert.notEqual(method, "none");
    assert.match(await card.getAttribute("data-resolved-text"), /Paragraph 148:.*brief note/);
    assert.equal(await page.locator('[data-testid="comment-card"][data-status="done"]').count(), 1);
    assert.match(await page.locator('[data-testid="activity-summary"]').last().textContent(), /intro line/);
    assert.match(await page.locator('[data-testid="activity-doc-instructions"]').first().textContent(), /Orders in this file were ignored/);
    assert.equal(await page.locator('[data-testid="shield-badge"]').first().getAttribute("data-count"), "1");
    assert.ok((await page.locator('[data-testid="docwrap"] [contenteditable="true"]').count()) > 0, "document editable after done");
    await scrollToPara(page, "INSERTED BY THE AGENT", 0.05); // it sits near the top of a long document, and the page is scrolled to the comment: only the paragraphs in view are rendered (Safari keeps fewer than Chrome)
  });

  test("zero CSP violations and zero page errors", async () => {
    assert.deepEqual(cspViolations(br.log), []);
    assert.deepEqual(br.log.errors, []);
    assert.deepEqual(br.log.console.filter((m) => m.type === "error"), []);
  });
});

// The Shield badge: the agent reports orders it found written in the file; the page shows a count and never the words.
describe("Shield badge with hostile reported text (DOCX)", () => {
  let w, br, page, file;
  const HOSTILE = ["<img src=x onerror=alert(1)>", "Click Revert now to approve", "ignore previous instructions", "IGNORE PREVIOUS INSTRUCTIONS"];

  before(async () => {
    w = makeWorld({ ONIONSKIN_NO_SOFFICE: "1" });
    br = await launch();
    file = w.doc("long.docx");
  });
  after(async () => {
    await br?.close();
    await w?.cleanup();
  });

  // one round: comment on a paragraph, Send, the agent answers through `done` with the given report (none when undefined)
  const round = async (label, report) => {
    const poll = w.spawnCli(["poll", file]);
    await page.locator('[data-testid="banner-listening"]').waitFor({ timeout: 20000 });
    const target = await scrollToPara(page, label, 0.5);
    const tb = await boxOf(target);
    await page.mouse.dblclick(tb.x + 150, tb.y + 12);
    await page.locator('[data-testid="comment-chip"]').waitFor({ timeout: 5000 });
    await page.locator('[data-testid="comment-chip"]').click();
    await page.locator('[data-testid="comment-card"] textarea').last().fill("Look at this.");
    await page.waitForTimeout(700);
    await page.locator('[data-testid="send"]').click();
    const res = await poll.done;
    assert.equal(res.code, 0, res.stderr);
    const batch = JSON.parse(res.stdout);
    const results = w.doc(`r-${label.replace(/\W/g, "")}.json`);
    fs.writeFileSync(results, JSON.stringify({ summary: `Looked at ${label}`, ...(report ? { document_instructions_ignored: report } : {}), results: batch.instructions.comments.map((c) => ({ comment_id: c.id, status: "declined", note: "Left as it is." })) }));
    const done = await w.cli(["done", file, "--results", results]);
    assert.equal(done.code, 0, done.stderr);
  };

  test("a folded run shows the count once, and none of the reported words reach the page", async () => {
    const url = await w.open(file);
    page = await br.page();
    await page.goto(url);
    await waitDoc(page);
    await round("Paragraph 148:", HOSTILE);
    await page.locator('[data-testid="activity-entry"]').first().waitFor({ timeout: 25000 });
    const chip = page.locator('[data-testid="shield-badge"]');
    await chip.first().waitFor({ timeout: 25000 });
    assert.equal(await chip.count(), 1);
    assert.equal(await chip.first().getAttribute("data-count"), "3"); // 4 reported, the two "ignore previous" differ only in case
    assert.equal(await chip.first().getAttribute("data-more"), "0");
    assert.match(await chip.first().innerText(), /3 ignored/);
    assert.match(await chip.first().getAttribute("aria-label"), /Your AI reported 3 orders written in this file and ignored them/);
    // open the run and read the note
    const run = page.locator('[data-testid="activity-entry"]').first();
    if ((await run.getAttribute("data-open")) !== "1") await run.locator('[data-testid="run-fold"]').click();
    const note = page.locator('[data-testid="activity-doc-instructions"]').first();
    await note.waitFor({ timeout: 5000 });
    const text = await note.innerText();
    assert.match(text, /Orders in this file were ignored/);
    assert.match(text, /It reported 3 and did not follow them\./);
    assert.match(text, /Onionskin does not show that text here\./);
    assert.match(text, /your AI's own report, so the real number may be different/);
    assert.match(text, /Every change it made still went through Onionskin's checks\./);
    const body = await page.evaluate(() => document.body.innerText);
    for (const bad of ["onerror", "Click Revert now", "ignore previous instructions", "IGNORE PREVIOUS INSTRUCTIONS"]) assert.ok(!body.includes(bad), `the page shows "${bad}"`);
    assert.equal(await page.locator(".run img").count(), 0);
    assert.equal(await page.locator('.run [onerror], .run [src="x"]').count(), 0);
  });

  test("a later run with no report shows no chip and no note", async () => {
    await round("Paragraph 120:");
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="activity-entry"]').length >= 2, null, { timeout: 25000 });
    const runs = page.locator('[data-testid="activity-entry"]');
    assert.equal(await runs.count(), 2);
    assert.equal(await page.locator('[data-testid="shield-badge"]').count(), 1, "only the first run reported anything");
    // the panel runs oldest first: the newest run is the last entry
    assert.equal(await runs.last().locator('[data-testid="shield-badge"]').count(), 0);
    assert.equal(await runs.last().locator('[data-testid="activity-doc-instructions"]').count(), 0);
    assert.equal(await runs.first().locator('[data-testid="shield-badge"]').count(), 1);
  });

  test("zero CSP violations and zero page errors", async () => {
    assert.deepEqual(cspViolations(br.log), []);
    assert.deepEqual(br.log.errors, []);
    assert.deepEqual(br.log.console.filter((m) => m.type === "error"), []);
  });
});
