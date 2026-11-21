import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { ENGINE_SAMPLES, cspViolations, haveSamples, launch, para, readZipText, skipUnless, waitDoc } from "./helpers/harness.mjs";
import { rezip } from "../test/helpers/zipbuild.js";

// A quick change ("Replace Acme with Initech") through a real browser: the preview line, the Send button's count, the run on this Mac,
// Revert. The server runs in this process; no agent polls, so anything that wrongly went to the agent would just sit and the test would time out.
const SKIP = skipUnless(haveSamples(), `engine samples not found in ${ENGINE_SAMPLES}`, "restore test/fixtures/engine or set ONIONSKIN_TEST_SAMPLES");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "da-"));
process.env.ONIONSKIN_STATE_DIR = path.join(root, "st");
process.env.ONIONSKIN_NO_SOFFICE = "1";
process.env.ONIONSKIN_TICK_MS = "150";
process.env.ONIONSKIN_LEASE_MS = "600000";
delete process.env.ONIONSKIN_PYTHON;
delete process.env.ONIONSKIN_HOLDER;

const q = (id) => `[data-testid="${id}"]`;
const NOTE = "Replace Acme with Initech";

/** waits for a condition with a deadline (never a fixed sleep) */
async function until(fn, what, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`timed out waiting for ${what}`);
}

describe("a quick change, start to finish", { skip: SKIP }, () => {
  let srv, br, page, file, key;

  before(async () => {
    const { startServer } = await import("../src/server.js");
    srv = await startServer();
    fs.mkdirSync(path.join(root, "docs"));
    file = path.join(root, "docs", "deal.docx");
    const swap = { "Revenue grew 24%": "Acme grew 24%", "Two new regions launched": "Acme opened two new regions", "Customer churn fell to 3.1%": "Acme churn fell to 3.1%" };
    fs.writeFileSync(file, rezip(fs.readFileSync(path.join(ENGINE_SAMPLES, "sample.docx")), { "word/document.xml": (x) => Object.entries(swap).reduce((t, [a, b]) => t.replace(a, b), x) }));
    file = fs.realpathSync(file);
    key = srv.sessions.open(file).key;
    br = await launch();
  });
  after(async () => {
    await br?.close();
    srv?.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const note = () => page.locator(q("overall-note"));
  const label = async () => (await page.locator(`${q("send")} .send-label`).textContent()).trim();

  test("typing the note shows the line and the count on the Send button; other notes do not", async () => {
    page = await br.page();
    await page.goto(`${srv.auth.origin}/?s=${key}&n=${srv.auth.newNonce()}`);
    await waitDoc(page);
    await para(page, "Acme grew 24%").waitFor({ timeout: 30000 });
    await note().fill("Make the intro friendlier");
    assert.equal(await label(), "Send to Agent");
    await note().fill("Replace Zorblax with Initech");
    await page.locator(q("quick-why"), { hasText: 'No "Zorblax" in this file. The agent will look into it.' }).waitFor({ timeout: 15000 });
    assert.equal(await label(), "Send to Agent");
    await note().fill(NOTE);
    const line = page.locator(q("quick-line"));
    await line.waitFor({ timeout: 15000 });
    assert.equal((await line.textContent()).trim(), 'Quick change: replace "Acme" with "Initech" in 3 places. Runs on this Mac, no AI.');
    assert.equal(await label(), "Replace in 3 places");
    // the label never outlives the words it was counted for
    await note().fill(`${NOTE} and more`);
    await until(async () => (await label()) === "Send to Agent", "the label to go back");
  });

  test("Ask the agent instead sends the ordinary label; Do it on this Mac brings the count back", async () => {
    await note().fill(NOTE);
    await page.locator(q("quick-line")).waitFor({ timeout: 15000 });
    await page.locator(q("quick-agent")).click();
    assert.equal(await label(), "Send to Agent");
    assert.equal((await page.locator(q("quick-change")).textContent()).includes("The agent will do this one."), true);
    await page.locator(q("quick-agent")).click();
    assert.equal(await label(), "Replace in 3 places");
  });

  test("pressing it does the change on this Mac: Done on this Mac, three places changed, nothing for an agent to do", async () => {
    const s = srv.sessions.get(key);
    await page.locator(q("send")).click();
    await page.locator(q("activity-entry"), { hasText: "Done on this Mac" }).first().waitFor({ timeout: 30000 });
    await para(page, "Initech grew 24%").waitFor({ timeout: 30000 });
    const xml = await readZipText(file, "word/document.xml");
    assert.equal((xml.match(/Initech/g) || []).length, 3);
    assert.ok(!xml.includes("Acme"));
    assert.equal(s.activity[0].by, "local");
    assert.equal(s.activity[0].summary, 'Replaced "Acme" with "Initech" in 3 places. No AI was used.');
    assert.equal(s.pollers.length, 0);
    assert.equal(await note().inputValue(), "", "the note travelled with the Send");
    assert.equal(await label(), "Send to Agent");
  });

  test("Revert brings the file and the note back, and the button no longer offers a quick change for those words", async () => {
    const revert = page.locator('[data-testid="activity-entry"][data-reverted="0"]').first().locator('[data-testid="revert-folded"], [data-testid="revert"]').first();
    await revert.click({ timeout: 10000 });
    await page.locator(q("notice"), { hasText: "Undone. Press Send to ask the agent instead." }).waitFor({ timeout: 15000 });
    await para(page, "Acme grew 24%").waitFor({ timeout: 30000 });
    assert.equal(await note().inputValue(), NOTE);
    await page.locator(q("quick-why"), { hasText: "You undid this change, so the agent will do it." }).waitFor({ timeout: 15000 });
    assert.equal(await label(), "Send to Agent");
    assert.deepEqual(cspViolations(br.log), []);
    assert.deepEqual(page.log.errors, []);
  });

  test("V4: leave-page guard warns with Quick ask text, not when empty, closed, or discarded with Esc", async () => {
    const file2 = path.join(root, "docs", "quick-guard.docx");
    fs.copyFileSync(file, file2);
    const key2 = srv.sessions.open(fs.realpathSync(file2)).key;
    const p = await br.page();
    await p.setViewportSize({ width: 1440, height: 900 });
    try {
      await p.goto(`${srv.auth.origin}/?s=${key2}&n=${srv.auth.newNonce()}`);
      await waitDoc(p);
      await para(p, "Acme grew 24%").waitFor({ timeout: 30000 });
      const prevented = () => p.evaluate(() => {
        const e = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(e);
        return e.defaultPrevented;
      });
      assert.equal(await prevented(), false, "closed box: not prevented");
      const box = await para(p, "Acme grew 24%").boundingBox();
      await p.mouse.dblclick(box.x + 80, box.y + 10);
      await p.locator(q("comment-chip")).waitFor({ timeout: 5000 });
      await p.locator(q("quick-ask-chip")).click();
      await p.locator(q("quick-ask")).waitFor({ timeout: 3000 });
      assert.equal(await prevented(), false, "open empty box: not prevented");
      const ta = p.locator(q("quick-ask-text"));
      await ta.fill("   ");
      assert.equal(await prevented(), false, "whitespace-only box: not prevented");
      await ta.fill("Please keep these typed words");
      assert.equal(await prevented(), true, "open box with text: prevented");
      await ta.press("Escape");
      await p.locator(q("quick-ask")).waitFor({ state: "detached", timeout: 3000 });
      assert.equal(await prevented(), false, "after Esc: not prevented");
    } finally {
      await p.close();
    }
  });
});
