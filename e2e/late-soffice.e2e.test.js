import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { boxOf, cspViolations, launch, makeWorld, python, readZipText, scrollToPara, waitDoc } from "./helpers/harness.mjs";

// A LibreOffice conversion problem found AFTER `reply` returned reaches the open page, with Revert offered for that run.
// A stub soffice converts the original but fails the agent's version after a delay, so the flag is genuinely late.
describe("the LibreOffice check finishes after done (DOCX)", () => {
  let w, br, page, file, poll, batch;

  before(async () => {
    w = makeWorld({ ONIONSKIN_PYTHON: python, STUB_MODE: "failafter" });
    const stub = path.join(w.root, "soffice-stub.sh");
    fs.writeFileSync(stub, `#!/bin/sh
out=""; prev=""; last=""
for a in "$@"; do [ "$prev" = "--outdir" ] && out="$a"; prev="$a"; last="$a"; done
case "$last" in *before*) printf PDF > "$out/before.pdf" ;; *) sleep 2 ;; esac
`, { mode: 0o755 });
    w.env.ONIONSKIN_SOFFICE = stub;
    delete w.env.ONIONSKIN_NO_SOFFICE;
    br = await launch();
    file = w.doc("long.docx");
  });
  after(async () => {
    await br?.close();
    await w?.cleanup();
  });

  test("reply returns at once saying the LibreOffice check is pending; the flag and Revert arrive later", async () => {
    poll = w.spawnCli(["poll", file]);
    const url = await w.open(file);
    page = await br.page();
    await page.goto(url);
    await waitDoc(page);
    await page.locator('[data-testid="banner-listening"]').waitFor({ timeout: 20000 });
    const deep = await scrollToPara(page, "Paragraph 148:", 0.5);
    const db = await boxOf(deep);
    await page.mouse.dblclick(db.x + 150, db.y + 12);
    await page.locator('[data-testid="comment-chip"]').click();
    await page.locator('[data-testid="comment-card"] textarea').last().fill("Say 'brief note' instead of 'short note'.");
    await page.waitForTimeout(700);
    await page.locator('[data-testid="send"]').click();
    const res = await Promise.race([poll.done, new Promise((r) => setTimeout(() => r(null), 20000))]);
    assert.ok(res, "poll did not return after Send");
    batch = JSON.parse(res.stdout);
    const c = batch.instructions.comments[0];
    const t0 = Date.now();
    const r = await w.cli(["reply", file, "--lease", batch.lease_ticket, "--json", JSON.stringify({ summary: "Brief note.", replies: [{ comment: c.id, find: "short note", replace: "brief note", note: "Reworded." }] })]);
    const took = Date.now() - t0;
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const j = JSON.parse(r.stdout);
    assert.match(j.checks_notice, /LibreOffice conversion check is still running \(pending\)/);
    assert.ok(took < 1900, `reply did not wait for the 2 s LibreOffice stub (took ${took} ms)`);
    // at reply time nothing is flagged yet; the notice says pending
    await page.locator('[data-testid="activity-entry"]').first().waitFor({ timeout: 20000 });
    assert.equal(await page.locator('[data-testid="check-revert"]').count(), 0);
    assert.match(await page.locator('[data-testid="check-notice"]').first().textContent(), /pending/);
    // then the late flag arrives and the existing Revert is offered
    await page.locator('[data-testid="activity-flags"] [data-code="soffice_convert_failed"]').waitFor({ timeout: 20000 });
    await page.locator('[data-testid="check-revert"]').waitFor({ timeout: 5000 });
    assert.doesNotMatch(await page.locator('[data-testid="check-notice"]').first().textContent().catch(() => ""), /pending/);
    assert.match(await readZipText(file, "word/document.xml"), /brief note/);
    await page.locator('[data-testid="revert"]').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="activity-entry"][data-kind="revert"]'), null, { timeout: 10000 });
    assert.doesNotMatch(await readZipText(file, "word/document.xml"), /brief note/);
  });

  test("zero CSP violations and zero page errors", async () => {
    assert.deepEqual(cspViolations(br.log), []);
    assert.deepEqual(br.log.errors, []);
  });
});
