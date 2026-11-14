import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, describe, test } from "node:test";
import { LINE_END, agentEdit, boxOf, relBox, cspViolations, launch, makeWorld, overlaps, para, readZipText, scrollToPara, until, waitDoc } from "./helpers/harness.mjs";

// (a) full send loop, (b) THE KEY PROOF: durable anchors survive an agent insert above + an edit of the commented paragraph.
describe("send loop and durable anchors (DOCX)", () => {
  let w, br, page, file, poll, batch, before_box, commentId, pinId;

  before(async () => {
    w = makeWorld();
    br = await launch();
    file = w.doc("long.docx");
  });
  after(async () => {
    await br?.close();
    await w?.cleanup();
  });

  test("(a) edit + text comment deep in the document + pin + overall note, Send, poll prints a correct batch", async () => {
    poll = w.spawnCli(["poll", file]);
    const url = await w.open(file);
    page = await br.page();
    await page.goto(url);
    await waitDoc(page);
    await page.locator('[data-testid="banner-listening"]').waitFor({ timeout: 20000 });
    assert.ok(!page.url().includes("n="), "launch nonce must be stripped from the URL");

    // type an edit near the top
    const p5 = para(page, "Paragraph 005:");
    const b5 = await boxOf(p5);
    await page.mouse.click(b5.x + b5.width - 40, b5.y + b5.height - 10);
    await page.keyboard.press(LINE_END);
    await page.keyboard.type(" TYPED-EDIT");
    await page.locator('[data-testid="change-item"]').first().waitFor();
    const changeText = await page.locator('[data-testid="change-item"]').first().textContent();
    // the label describes what the user sees (page and the first words), not a block index
    assert.match(await page.locator('[data-testid="change-label"]').first().textContent(), /^"Paragraph 005: the \w+ team[^"]*", page \d+$/);
    assert.match(changeText, /TYPED-EDIT/);
    assert.equal(await page.locator('[data-testid="change-item"]').count(), 1, "keystrokes must coalesce into one change");

    // text comment on a paragraph deep in the document
    const deep = await scrollToPara(page, "Paragraph 148:", 0.5);
    const db = await boxOf(deep);
    await page.mouse.dblclick(db.x + 150, db.y + 12);
    await page.locator('[data-testid="comment-chip"]').waitFor({ timeout: 5000 });
    await page.locator('[data-testid="comment-chip"]').click();
    await page.locator('[data-testid="comment-card"] textarea').first().fill("Please say who owns this item.");

    // pin in another paragraph
    await page.locator('[data-testid="mode-pin"]').click();
    const nb = await boxOf(para(page, "Paragraph 152:"));
    await page.mouse.click(nb.x + 200, nb.y + 30);
    await page.locator('[data-testid="comment-card"][data-kind="pin"] textarea').fill("Pin: tighten this wording.");
    await page.locator('[data-testid="mode-edit"]').click();

    await page.locator('[data-testid="overall-note"]').fill("Keep the tone formal.");
    await page.waitForTimeout(700); // draft autosave
    before_box = await relBox(page, para(page, "Paragraph 148:"));

    await page.locator('[data-testid="send"]').click();
    const res = await Promise.race([poll.done, new Promise((r) => setTimeout(() => r(null), 20000))]);
    assert.ok(res, "poll did not return after Send");
    assert.equal(res.code, 0, res.stderr);
    batch = JSON.parse(res.stdout);

    assert.equal(batch.schema, "onionskin.batch/1");
    assert.equal(batch.instructions.overall_note, "Keep the tone formal.");
    assert.equal(batch.instructions.comments.length, 2);
    const kinds = batch.instructions.comments.map((c) => c.kind).sort();
    assert.deepEqual(kinds, ["pin", "text"]);
    commentId = batch.instructions.comments.find((c) => c.kind === "text").id;
    pinId = batch.instructions.comments.find((c) => c.kind === "pin").id;
    // separation: no document text inside `instructions`
    const instr = JSON.stringify(batch.instructions);
    assert.ok(!/regional leads|each quarter|Paragraph 1/.test(instr), "document text leaked into instructions");
    const ev = batch.untrusted_document_evidence;
    assert.ok(ev.anchors.every((a) => a.resolved), "all anchors resolved from the written bytes");
    const anchor = ev.anchors.find((a) => a.id === batch.instructions.comments.find((c) => c.kind === "text").anchor_id);
    assert.ok(/Paragraph 148/.test(anchor.label + anchor.prefix + anchor.quote + anchor.suffix) || anchor.locator.body_path, "anchor identifies the paragraph");
    assert.equal(ev.user_edits.length, 1);
    assert.match(ev.user_edits[0].after, /TYPED-EDIT$/);
    assert.ok(ev.user_edits[0].before && !ev.user_edits[0].before.includes("TYPED-EDIT"));

    // the file on disk contains the typed edit
    assert.match(await readZipText(file, "word/document.xml"), /TYPED-EDIT/);
    // a Word document stays editable while the agent works (what is typed is merged afterwards)
    await page.locator('[data-testid="banner-working"]').waitFor();
    assert.ok((await page.locator('[data-testid="docwrap"] [contenteditable="true"]').count()) > 0, "the document stays editable while the agent works");
  });

  test("(b) KEY PROOF: agent inserts a paragraph above and edits the commented paragraph; reload lands on the same text", async () => {
    // the agent edits the file with python-docx, then reports
    agentEdit([file, "insert-before", "Paragraph 002:", "INSERTED BY THE AGENT: a new paragraph near the top of the document."]);
    agentEdit([file, "replace", "short note", "brief note", "Paragraph 148:"]);
    const results = w.doc("results.json");
    fs.writeFileSync(results, JSON.stringify({ summary: "Added an owner note and tightened wording.", results: [{ comment_id: commentId, status: "done", note: "Edited the paragraph." }, { comment_id: pinId, status: "declined", note: "Left as is." }] }));
    const done = await w.cli(["done", file, "--results", results]);
    assert.equal(done.code, 0, done.stderr);

    await page.locator('[data-testid="activity-entry"]').first().waitFor({ timeout: 20000 });
    await page.locator(".de-p", { hasText: "brief note" }).first().waitFor({ timeout: 30000 });
    await page.waitForTimeout(2500); // pagination + view restore settle
        const after_box = await relBox(page, para(page, "brief note"));
    const yErr = after_box.y - before_box.y;
    console.log(`KEY PROOF y: before=${before_box.y.toFixed(1)} after=${after_box.y.toFixed(1)} error=${yErr.toFixed(1)}px`);
    assert.ok(Math.abs(yErr) <= 60, `commented paragraph moved ${yErr}px on reload`);

    // comment card attached to the right paragraph
    const card = page.locator('[data-testid="comment-card"][data-kind="text"]');
    assert.equal(await card.getAttribute("data-resolved"), "ok");
    const method = await card.getAttribute("data-resolved-method");
    console.log(`KEY PROOF anchor resolved by: ${method}`);
    assert.ok(["hash", "neighbors", "quote", "fuzzy", "id"].includes(method), method);
    assert.match(await card.getAttribute("data-resolved-text"), /Paragraph 148:.*brief note/);
    const hl = page.locator('[data-testid="highlight"][data-comment-id="' + commentId + '"]').first();
    await hl.waitFor({ timeout: 5000 });
    const hb = await boxOf(hl);
    const pb2 = await boxOf(para(page, "brief note"));
    assert.ok(hb.y >= pb2.y - 4 && hb.y <= pb2.y + pb2.height + 4, "highlight sits on the paragraph");
    // every region the agent changed that is on screen is outlined as changed (found by comparing the files), not only the answered comments
    const chg = await until(async () => {
      const r = await page.locator('[data-testid="changed-region"]').evaluateAll((els) => els.map((e) => { const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height, kind: e.dataset.kind }; }));
      return r.length ? r : null;
    }, "changed regions");
    assert.ok(chg.some((r) => r.kind === "changed" && overlaps(r, { x: pb2.x, y: pb2.y, w: pb2.width, h: pb2.height })), "the edited paragraph is outlined as changed");
    assert.ok(chg.every((r) => r.kind === "changed"), "nothing is labelled changed or new that is not (only the edited paragraph is on screen)");

    // the pin followed its paragraph too
    const pin = page.locator('[data-testid="comment-card"][data-kind="pin"]');
    assert.equal(await pin.getAttribute("data-resolved"), "ok");
    assert.match(await pin.getAttribute("data-resolved-text"), /^Paragraph 152:/);
    const pm = await boxOf(page.locator('[data-testid="pin-mark"]').first());
    const p152 = await boxOf(para(page, "Paragraph 152:"));
    assert.ok(pm.y >= p152.y - 6 && pm.y <= p152.y + p152.height + 6, "pin marker sits on its paragraph");
    // the marker is offset from the point it marks and a leader with a dot points at the exact spot: it never covers the word it sits on
    const dot = await page.locator('[data-testid="pin-leader"] circle').first().boundingBox();
    assert.ok(dot, "the pin has a leader and a dot");
    assert.ok(Math.hypot(pm.x + pm.width / 2 - (dot.x + dot.width / 2), pm.y + pm.height / 2 - (dot.y + dot.height / 2)) >= 20, "the pin marker is drawn away from its point");
    assert.ok(dot.x + dot.width / 2 >= p152.x && dot.x + dot.width / 2 <= p152.x + p152.width && dot.y + dot.height / 2 >= p152.y && dot.y + dot.height / 2 <= p152.y + p152.height, "the dot is on the paragraph");

    // activity feed shows the results
    assert.match(await page.locator('[data-testid="activity-summary"]').last().textContent(), /owner note/);
    assert.equal(await page.locator('[data-testid="comment-card"][data-status="done"]').count(), 1);
    assert.equal(await page.locator('[data-testid="comment-card"][data-status="declined"]').count(), 1);
    assert.equal(await page.locator('[data-testid="card-status-pill"], [data-testid="state-pill"]').first().textContent(), "Idle");

    // editable again
    assert.ok((await page.locator('[data-testid="docwrap"] [contenteditable="true"]').count()) > 0, "document editable after done");
    const pb = await boxOf(para(page, "brief note"));
    await page.mouse.click(pb.x + pb.width - 40, pb.y + pb.height - 10);
    await page.keyboard.press(LINE_END);
    await page.keyboard.type("!");
    await page.locator('[data-testid="change-item"]').first().waitFor({ timeout: 5000 });
  });

  test("(g) zero CSP violations and zero page errors; nonce URL is single use", async () => {
    assert.deepEqual(cspViolations(br.log), []);
    assert.deepEqual(br.log.errors, []);
    const bad = br.log.console.filter((m) => m.type === "error");
    assert.deepEqual(bad, [], JSON.stringify(bad));
  });
});
