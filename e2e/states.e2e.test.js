import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { LINE_END, agentEdit, boxOf, cspViolations, launch, makeWorld, para, readZipText, waitDoc } from "./helpers/harness.mjs";

const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const pill = (page) => page.locator('[data-testid="state-pill"]');
const editable = (page) => page.locator('[data-testid="docwrap"] [contenteditable="true"]').count();

async function typeInPara(page, text, suffix) {
  const b = await boxOf(para(page, text));
  await page.mouse.click(b.x + b.width - 40, b.y + b.height - 10);
  await page.keyboard.press(LINE_END);
  await page.keyboard.type(suffix);
}

let br;
before(async () => {
  br = await launch();
});
after(async () => {
  await br?.close();
});

describe("(c) no poller, agent crash, take back", () => {
  let w;
  before(() => {
    w = makeWorld({ ONIONSKIN_LEASE_MS: "2500" });
  });
  after(() => w.cleanup());

  test("Send with no poller is stranded with a Start button; document stays editable; starting poll delivers", async () => {
    const file = w.doc("long.docx");
    const page = await br.page();
    await page.goto(await w.open(file));
    await waitDoc(page);
    await typeInPara(page, "Paragraph 003:", " STRANDED-EDIT");
    await page.locator('[data-testid="change-item"]').first().waitFor();
    await page.locator('[data-testid="overall-note"]').fill("Please check the tone.");
    await page.locator('[data-testid="send"]').click();
    await page.locator('[data-testid="banner-stranded"]').waitFor({ timeout: 10000 });
    assert.equal((await pill(page).textContent()).trim(), "No agent listening");
    assert.equal(await page.locator('[data-testid="agent-start"]').count(), 1, "the banner offers Start, not a command line");
    assert.equal(await page.locator('[data-testid="stranded-command"]').count(), 0);
    assert.ok((await editable(page)) > 0, "document stays editable while stranded");
    assert.match(await readZipText(file, "word/document.xml"), /STRANDED-EDIT/, "the batch is already on disk");
    const st = JSON.parse((await w.cli(["status", file])).stdout);
    assert.equal(st.state, "stranded");

    const poll = w.spawnCli(["poll", file]);
    const res = await Promise.race([poll.done, new Promise((r) => setTimeout(() => r(null), 15000))]);
    assert.ok(res && res.code === 0, "poll delivers the pending batch");
    assert.equal(JSON.parse(res.stdout).instructions.overall_note, "Please check the tone.");
    await page.locator('[data-testid="banner-working"]').waitFor();
    assert.ok((await editable(page)) > 0, "a Word document stays editable while the agent works");
  });

  test("agent crash: lease expiry flips to stranded; a re-poll delivers again; Take back editing works while locked", async () => {
    const file = w.doc("long.docx");
    const page = (await br.ctx.pages()).find((p) => p.url().includes("127.0.0.1"));
    // lease (2.5 s) expires with nobody calling done
    await page.locator('[data-testid="banner-stranded"]').waitFor({ timeout: 15000 });
    assert.ok((await editable(page)) > 0, "document unlocked after lease expiry");
    assert.match(await page.locator('[data-testid="panel-stack"]').textContent(), /stopped responding/);
    // a new poll gets the same batch again
    const again = w.spawnCli(["poll", file]);
    const res = await Promise.race([again.done, new Promise((r) => setTimeout(() => r(null), 15000))]);
    assert.ok(res && res.code === 0);
    await page.locator('[data-testid="banner-working"]').waitFor();
    // Take back editing, always available while locked
    await page.locator('[data-testid="take-back"]').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="state-pill"]').textContent.trim() === "Idle", null, { timeout: 10000 });
    assert.ok((await editable(page)) > 0);
    // the old agent finishing now is refused
    const results = w.doc("r.json");
    fs.writeFileSync(results, JSON.stringify({ summary: "late", results: [] }));
    const late = await w.cli(["done", file, "--results", results]);
    assert.equal(late.code, 1);
    assert.match(late.stderr, /no batch is in progress/);
  });
});

describe("(d) external change between load and Send", () => {
  let w;
  before(() => {
    w = makeWorld();
  });
  after(() => w.cleanup());

  test("409 conflict UI; nothing written; Reload from disk shows the external change", async () => {
    const file = w.doc("long.docx");
    const page = await br.page();
    await page.goto(await w.open(file));
    await waitDoc(page);
    await typeInPara(page, "Paragraph 004:", " MY-EDIT");
    await page.locator('[data-testid="change-item"]').first().waitFor();
    agentEdit([file, "replace", "short note", "EXTERNAL-NOTE", "Paragraph 006:"]);
    const diskBefore = sha(file);
    await page.locator('[data-testid="send"]').click();
    await page.locator('[data-testid="banner-conflict"]').waitFor({ timeout: 10000 });
    assert.equal(sha(file), diskBefore, "a conflicting Send must not write");
    assert.ok(!(await readZipText(file, "word/document.xml")).includes("MY-EDIT"));
    await page.locator('[data-testid="reload-disk"]').click();
    await page.locator(".de-p", { hasText: "EXTERNAL-NOTE" }).first().waitFor({ timeout: 20000 });
  });
});

describe("(e) revert", () => {
  let w;
  before(() => {
    w = makeWorld();
  });
  after(() => w.cleanup());

  test("Revert restores the pre-agent bytes as a new version", async () => {
    const file = w.doc("long.docx");
    const poll = w.spawnCli(["poll", file]);
    const page = await br.page();
    await page.goto(await w.open(file));
    await waitDoc(page);
    await page.locator('[data-testid="banner-listening"]').waitFor({ timeout: 20000 });
    await typeInPara(page, "Paragraph 003:", " USER-EDIT");
    await page.locator('[data-testid="send"]').click();
    const res = await Promise.race([poll.done, new Promise((r) => setTimeout(() => r(null), 15000))]);
    const batch = JSON.parse(res.stdout);
    const preAgent = sha(file); // bytes the browser wrote at Send
    agentEdit([file, "replace", "short note", "AGENT-NOTE", "Paragraph 010:"]);
    const afterAgent = sha(file);
    assert.notEqual(preAgent, afterAgent);
    const results = w.doc("r.json");
    fs.writeFileSync(results, JSON.stringify({ summary: "Changed paragraph 10.", results: [] }));
    assert.equal((await w.cli(["done", file, "--results", results])).code, 0);
    await page.locator('[data-testid="revert"]').waitFor({ timeout: 20000 });
    await page.locator('[data-testid="revert"]').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="activity-entry"][data-kind="revert"]'), null, { timeout: 10000 });
    assert.equal(sha(file), preAgent, "file bytes equal the pre-agent version");
    assert.equal(await page.locator('[data-testid="revert"]').count(), 0, "revert button gone for the reverted run");
    // snapshots: a revert is a new version, the post-agent version is kept
    const snapDir = path.join(w.state, "snapshots");
    const idx = JSON.parse(fs.readFileSync(path.join(snapDir, fs.readdirSync(snapDir)[0], "index.json"), "utf8"));
    const labels = idx.map((e) => e.label);
    assert.ok(idx.some((e) => e.original), "original kept");
    assert.ok(labels.includes("before revert") && labels.includes("reverted"), labels.join(","));
    assert.ok(idx.some((e) => e.sha === afterAgent), "post-agent version retained");
    assert.ok(batch.batch_id);
  });
});

describe("(f) XLSX and PPTX open and emit one edit each", () => {
  let w;
  before(() => {
    w = makeWorld();
  });
  after(() => w.cleanup());

  test("XLSX: a typed cell appears in Changes with a sheet!cell label", async () => {
    const file = w.copySample("sample.xlsx");
    const page = await br.page();
    await page.goto(await w.open(file));
    await page.waitForSelector(".de-xlsx .de-cell", { timeout: 30000 });
    await page.waitForTimeout(1500);
    await page.mouse.click(740, 420);
    await page.keyboard.type("4242");
    await page.keyboard.press("Enter");
    await page.locator('[data-testid="change-item"]').first().waitFor({ timeout: 10000 });
    const label = await page.locator('[data-testid="change-label"]').first().textContent();
    assert.match(label, /^Sales!J\d+$|^Sales!\w+\d+$/, label);
    assert.match(await page.locator('[data-testid="change-item"]').first().textContent(), /4242/);
    assert.equal((await page.locator('[data-testid="format-badge"]').textContent()).trim(), "XLSX");
  });

  test("PPTX: a text edit appears in Changes with a slide label", async () => {
    const file = w.copySample("sample.pptx");
    const page = await br.page();
    await page.goto(await w.open(file));
    await page.waitForSelector(".de-slide", { timeout: 30000 });
    await page.waitForTimeout(1500);
    await page.mouse.click(550, 376);
    await page.keyboard.press("End");
    await page.keyboard.type("XYZ");
    await page.mouse.click(1000, 600); // blur flushes the text debounce
    await page.locator('[data-testid="change-item"]').first().waitFor({ timeout: 10000 });
    assert.match(await page.locator('[data-testid="change-label"]').first().textContent(), /^Slide 1/);
    assert.match(await page.locator('[data-testid="change-item"]').first().textContent(), /XYZ/);
  });
});

describe("(g) security posture in the browser", () => {
  let w;
  before(() => {
    w = makeWorld();
  });
  after(() => w.cleanup());

  test("nonce is single use; second use of the URL is rejected; no CSP violations or page errors across all of the above", async () => {
    const file = w.doc("long.docx");
    const url = await w.open(file);
    const page = await br.page();
    await page.goto(url);
    await waitDoc(page);
    assert.ok(!page.url().includes("n="));
    const second = await br.ctx.request.get(url); // same URL again, no cookie jar of its own: nonce must be spent
    const p2 = await br.page();
    const resp = await p2.goto(url);
    assert.equal(resp.status(), 403);
    assert.match(await p2.content(), /already used or has expired/);
    assert.equal(second.status(), 403);
    assert.deepEqual(page.log.console.filter((m) => ["error", "warning", "http"].includes(m.type)), [], "no console errors on the real page");
    assert.deepEqual(page.log.errors, []);
    // API without header token is refused even with the cookie
    const noTok = await page.evaluate(async () => (await fetch("/api/file?s=" + new URLSearchParams(location.search).get("s"), { credentials: "same-origin" })).status);
    assert.equal(noTok, 403);
  });
});

after(() => {
  // across every test in this file: no CSP violation and no uncaught page error, ever
  assert.deepEqual(cspViolations(br.log), []);
  assert.deepEqual(br.log.errors, []);
});
