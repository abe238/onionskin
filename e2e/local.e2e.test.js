import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { ENGINE_SAMPLES, boxOf, cspViolations, haveSamples, launch, para, readZipText, skipUnless, waitDoc } from "./helpers/harness.mjs";

// A whole Send done on this Mac (src/local.js), in a real browser. The server runs in this process so the test can add a stub
// planner: one comment "stub: A => B" becomes a find/replace on its own anchor. Production code has no planner yet (ideas 8 and 10 add theirs).
const SKIP = skipUnless(haveSamples(), `engine samples not found in ${ENGINE_SAMPLES}`, "restore test/fixtures/engine or set ONIONSKIN_TEST_SAMPLES");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "da-"));
process.env.ONIONSKIN_STATE_DIR = path.join(root, "st");
process.env.ONIONSKIN_NO_SOFFICE = "1";
process.env.ONIONSKIN_TICK_MS = "150";
process.env.ONIONSKIN_LEASE_MS = "600000";
delete process.env.ONIONSKIN_PYTHON;
delete process.env.ONIONSKIN_HOLDER;

/** waits for a condition with a deadline (never a fixed sleep) */
async function until(fn, what, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`timed out waiting for ${what}`);
}

describe("a Send done on this Mac", { skip: SKIP }, () => {
  let srv, br, page, file, key;
  const STUB = "stub: 24% => 40%";

  before(async () => {
    const { startServer } = await import("../src/server.js");
    srv = await startServer();
    srv.local.planners.push({
      name: "stub",
      wants: (s, b) => b.instructions.comments.length === 1 && b.instructions.comments[0].text.startsWith("stub: "),
      plan: async (s, b) => {
        const c = b.instructions.comments[0];
        const [find, replace] = c.text.slice(6).split(" => ");
        return { reply: { summary: `Replaced "${find}" with "${replace}".`, replies: [{ comment: c.id, find, replace }] } };
      },
    });
    fs.mkdirSync(path.join(root, "docs"));
    file = path.join(root, "docs", "report.docx");
    fs.copyFileSync(path.join(ENGINE_SAMPLES, "sample.docx"), file);
    file = fs.realpathSync(file);
    key = srv.sessions.open(file).key;
    br = await launch();
  });
  after(async () => {
    await br?.close();
    srv?.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("the run is titled Done on this Mac, the file changed, History says Change made on this Mac", async () => {
    page = await br.page();
    await page.goto(`${srv.auth.origin}/?s=${key}&n=${srv.auth.newNonce()}`);
    await waitDoc(page);
    const p = para(page, "Revenue grew 24%");
    await p.waitFor({ timeout: 30000 });
    const b = await boxOf(p);
    await page.mouse.dblclick(b.x + 40, b.y + b.height / 2);
    await page.locator('[data-testid="comment-chip"]').click({ timeout: 5000 });
    await page.locator('[data-testid="comment-card"] textarea').last().fill(STUB);
    const s = srv.sessions.get(key);
    await until(() => s.comments.some((c) => c.text === STUB), "the draft to reach the server");
    await page.locator('[data-testid="send"]').click();
    const entry = page.locator('[data-testid="activity-entry"]', { hasText: "Done on this Mac" });
    await entry.first().waitFor({ timeout: 30000 });
    await para(page, "Revenue grew 40%").waitFor({ timeout: 30000 });
    assert.match(await readZipText(file, "word/document.xml"), /Revenue grew 40%/);
    assert.equal(s.activity[0].by, "local");
    assert.equal(await page.locator('[data-testid="comment-card"][data-status="done"]').count(), 1);
    await page.locator('[data-testid="history-row"][data-kind="local"]').first().waitFor({ state: "attached", timeout: 30000 });
    assert.equal((await page.locator('[data-testid="history-row"][data-kind="local"] .h-title').first().textContent()).trim(), "Change made on this Mac");
  });

  test("Revert says Press Send to ask the agent instead, and the next Send goes to the agent", async () => {
    const s = srv.sessions.get(key);
    const revert = page.locator('[data-testid="activity-entry"][data-reverted="0"]').first().locator('[data-testid="revert-folded"], [data-testid="revert"]').first();
    await revert.click({ timeout: 10000 });
    await page.locator('[data-testid="notice"]', { hasText: "Undone. Press Send to ask the agent instead." }).waitFor({ timeout: 15000 });
    await para(page, "Revenue grew 24%").waitFor({ timeout: 30000 });
    await page.locator('[data-testid="activity-entry"]', { hasText: "Done on this Mac (reverted)" }).first().waitFor({ timeout: 15000 });
    // no agent was involved: the revert entry and the History row say so in their own words
    const rev = page.locator('[data-testid="activity-entry"][data-kind="revert"]').first();
    await rev.waitFor({ timeout: 15000 });
    assert.match(await rev.textContent(), /Reverted to the version before this change\./);
    assert.doesNotMatch(await rev.textContent(), /agent/i);
    await page.locator('[data-testid="history-row"][data-kind="revert"]').first().waitFor({ state: "attached", timeout: 30000 });
    assert.equal((await page.locator('[data-testid="history-row"][data-kind="revert"] .h-title').first().textContent()).trim(), "Reverted change made on this Mac");
    assert.equal(s.comments[0].skipLocal, true);
    const poll = srv.sessions.poll(key, { holder: "H1" });
    await until(async () => page.locator('[data-testid="send"]').isEnabled(), "Send to be enabled");
    await page.locator('[data-testid="send"]').click();
    const batch = await Promise.race([poll.promise, new Promise((r) => setTimeout(() => r(null), 30000))]);
    assert.ok(batch, "the agent's poll got nothing");
    assert.equal(batch.lease.holder, "H1");
    assert.deepEqual(batch.instructions.comments.map((c) => c.text), [STUB]);
    assert.deepEqual(cspViolations(br.log), []);
    assert.deepEqual(page.log.errors, []);
    srv.sessions.takeBack(key);
  });

  // The page is handed the session as the server sees it while a run on this Mac is going (a fast run cannot be held still), with an agent's
  // run next to it: every line a person reads about the local one says this Mac, and the agent's keeps the agent's words.
  test("while a change is made on this Mac, the pill, the lock line, the stage and the outside-change banner say so; an agent's run keeps the agent's words", async () => {
    await page.close(); // only one tab edits: the earlier tests' page makes way
    const lines = async (local) => {
      srv.sessions.setDraft(key, { comments: [], note: "" }); // the earlier tests' comments are not part of this one
      const pg = await br.page();
      await pg.setViewportSize({ width: 1440, height: 900 });
      await pg.goto(`${srv.auth.origin}/?s=${key}&n=${srv.auth.newNonce()}`);
      await waitDoc(pg);
      const p = para(pg, "Revenue grew");
      await p.waitFor({ timeout: 30000 });
      const b = await boxOf(p);
      await pg.mouse.dblclick(b.x + 40, b.y + b.height / 2);
      await pg.locator('[data-testid="comment-chip"]').click({ timeout: 5000 });
      const words = local ? "stub: 24% => 40%" : "please check this";
      await pg.locator('[data-testid="comment-card"] textarea').last().fill(words);
      const s = srv.sessions.get(key);
      await until(() => s.comments.some((c) => c.text === words), "the draft to reach the server");
      const real = srv.local.run;
      let poll = null;
      if (local) srv.local.run = () => ((srv.local.run = real), Promise.resolve("held")); // the run on this Mac never starts: the page sees it as it is mid-run
      else poll = srv.sessions.poll(key, { holder: "H2" }); // an agent is listening: it gets the batch
      await pg.locator('[data-testid="send"]').click();
      await pg.locator('[data-testid="banner-working"]').waitFor({ timeout: 15000 });
      await until(async () => (await pg.locator('[data-testid="state-pill"]').textContent()).includes("working") || (await pg.locator('[data-testid="state-pill"]').textContent()).includes("Working"), "the working pill");
      const out = {
        pill: (await pg.locator('[data-testid="state-pill"]').textContent()).trim(),
        pillLabel: await pg.locator('[data-testid="state-pill"]').getAttribute("aria-label"),
        sync: (await pg.locator('[data-testid="sync-state"]').textContent()).trim(),
        stage: (await pg.locator('[data-testid="banner-stage"]').textContent()).trim(),
        lock: (await pg.locator('[data-testid="banner-lock-line"]').textContent()).trim(),
        bars: await pg.locator('[role="progressbar"]').count(),
      };
      srv.local.run = real;
      if (poll) await Promise.race([poll.promise, new Promise((r) => setTimeout(r, 5000))]);
      srv.sessions.takeBack(key);
      await until(() => s.state !== "working", "the run to be taken back");
      await pg.close();
      srv.sessions.setDraft(key, { comments: [], note: "" });
      return out;
    };
    const mac = await lines(true);
    assert.deepEqual(mac, { pill: "Working on this Mac", pillLabel: "State: Working on this Mac", sync: "Working on this Mac: keep editing", stage: "Doing this on your Mac", lock: "Keep editing. What you type is merged with this change when it finishes.", bars: 0 });
    const agent = await lines(false);
    assert.deepEqual([agent.pill, agent.sync, agent.stage, agent.lock], ["Agent working", "Agent working: keep editing", "The agent has your batch", "Keep editing. What you type is merged with the agent's changes when it finishes."]);
    assert.equal(agent.bars, 1, "an agent's run keeps its progress bar and its label");
    // the outside-change banner and the entry for a run that stopped
    const sess = srv.sessions.get(key);
    sess.activity.unshift({ id: "r_lease", kind: "lease_expired", at: Date.now(), by: "local", summary: "The change on this Mac did not finish. Your request is waiting for an agent.", flags: [], results: [] });
    sess.conflict = { side: "agent", local: true, copyName: "report Onionskin copy.docx", copyPath: "/tmp/x", at: Date.now() }; // what the server records when a run on this Mac meets an outside change
    const pg = await br.page();
    await pg.setViewportSize({ width: 1440, height: 900 });
    await pg.goto(`${srv.auth.origin}/?s=${key}&n=${srv.auth.newNonce()}`);
    await waitDoc(pg);
    const banner = pg.locator('[data-testid="banner-agent-outside"]');
    await banner.waitFor({ timeout: 15000 });
    assert.equal((await banner.textContent()).includes("agent"), false, await banner.textContent());
    assert.match(await banner.textContent(), /A copy with the change was saved as report Onionskin copy\.docx/);
    const entry = pg.locator('[data-testid="activity-entry"][data-kind="lease_expired"]');
    await entry.waitFor({ timeout: 15000 });
    assert.match(await entry.locator("strong").textContent(), /^Stopped on this Mac$/);
    await pg.close();
  });
});
