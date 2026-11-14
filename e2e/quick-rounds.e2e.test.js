import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { ENGINE_SAMPLES, cspViolations, haveSamples, launch, para, readZipText, skipUnless, waitDoc } from "./helpers/harness.mjs";
import { rezip } from "../test/helpers/zipbuild.js";

// A quick change on a file that already has comments from earlier rounds. The Send button may promise "Runs on this Mac, no AI" only
// when the Send really is done on this Mac: a comment the agent finished does not stop it, a comment still waiting for an agent does.
// The server runs in this process; no agent polls unless the test says so.
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

describe("a quick change after earlier rounds", { skip: SKIP }, () => {
  let srv, br, readDocxParagraphs;

  before(async () => {
    const { startServer } = await import("../src/server.js");
    ({ readDocxParagraphs } = await import("../src/docx.js"));
    srv = await startServer();
    fs.mkdirSync(path.join(root, "docs"));
    br = await launch();
  });
  after(async () => {
    await br?.close();
    srv?.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const swap = { "Revenue grew 24%": "Acme grew 24%", "Two new regions launched": "Acme opened two new regions", "Customer churn fell to 3.1%": "Acme churn fell to 3.1%" };
  /** a file with three Acme, open in a session, and a comment on its first Acme paragraph (not sent) */
  function acmeFile(name) {
    let file = path.join(root, "docs", name);
    fs.writeFileSync(file, rezip(fs.readFileSync(path.join(ENGINE_SAMPLES, "sample.docx")), { "word/document.xml": (x) => Object.entries(swap).reduce((t, [a, b]) => t.replace(a, b), x) }));
    file = fs.realpathSync(file);
    const s = srv.sessions.open(file);
    const p = readDocxParagraphs(fs.readFileSync(file)).find((x) => x.text.startsWith("Acme grew 24%"));
    const comment = { id: "c1", kind: "element", text: "Make this punchier", anchor: { location: { blockPath: p.path }, paraText: p.text } };
    return { file, s, comment };
  }
  async function openPage(s) {
    const page = await br.page();
    await page.goto(`${srv.auth.origin}/?s=${s.key}&n=${srv.auth.newNonce()}`);
    await waitDoc(page);
    await para(page, "Acme grew 24%").waitFor({ timeout: 30000 });
    return page;
  }
  const labelOf = async (page) => (await page.locator(`${q("send")} .send-label`).textContent()).trim();

  test("a comment the agent finished in an earlier round: the quick change is offered and pressing Send does it on this Mac", async () => {
    const { file, s, comment } = acmeFile("done.docx");
    const poll = srv.sessions.poll(s.key, { holder: "H1" });
    srv.sessions.send(s.key, { baseSha: s.baseSha, comments: [comment], note: "" });
    const b = await poll.promise;
    srv.sessions.done(s.key, { summary: "Looked at it.", results: [{ comment_id: "c1", status: "done", note: "Made it punchier." }] }, { holder: "H1", token: b.lease.token, batchId: b.batch_id });
    assert.equal(s.comments[0].status, "done");
    const page = await openPage(s);
    await page.locator(q("overall-note")).fill(NOTE);
    await page.locator(q("quick-line")).waitFor({ timeout: 15000 });
    assert.equal(await labelOf(page), "Replace in 3 places");
    await page.locator(q("send")).click();
    // before the fix the page left the count out (it sent the finished comment along), so the note sat waiting for an agent
    await page.locator(q("activity-entry"), { hasText: "Done on this Mac" }).first().waitFor({ timeout: 30000 });
    await para(page, "Initech grew 24%").waitFor({ timeout: 30000 });
    const xml = await readZipText(file, "word/document.xml");
    assert.equal((xml.match(/Initech/g) || []).length, 3);
    assert.equal(s.activity[0].by, "local");
    assert.equal(s.pending, null, "nothing waits for an agent");
    assert.deepEqual(cspViolations(br.log), []);
    assert.deepEqual(page.log.errors, []);
    await page.close();
  });

  test("a comment still waiting for an agent: no quick change is offered, and Send gives the agent the comment and the note", async () => {
    const { file, s, comment } = acmeFile("waiting.docx");
    const disk = fs.readFileSync(file);
    srv.sessions.send(s.key, { baseSha: s.baseSha, comments: [comment], note: "" }); // no agent listening: it waits
    assert.equal(s.comments[0].status, "sent");
    const page = await openPage(s);
    const asked = [];
    const sent = [];
    page.on("request", (r) => {
      const where = new URL(r.url()).pathname;
      if (where === "/api/quick") asked.push(where);
      if (where === "/api/send") sent.push(r.postDataJSON());
    });
    await page.evaluate(() => {
      window.__sawQuick = false;
      new MutationObserver(() => {
        if (document.querySelector('[data-testid="quick-line"]') || /^Replace in/.test(document.querySelector('[data-testid="send"] .send-label')?.textContent || "")) window.__sawQuick = true;
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    await page.locator(q("overall-note")).fill(NOTE);
    await until(() => s.note === NOTE, "the note to reach the server");
    // the page's gate (web/src/quick-send.js) and the server's preview (test/local.test.js) are unit-tested; here: what the Send carries
    assert.equal(await labelOf(page), "Send to Agent");
    await page.locator(q("send")).click();
    await until(() => s.pending?.instructions.overall_note === NOTE, "the Send to wait for an agent");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].quick, undefined, "the Send asks for no change on this Mac");
    assert.equal(asked.length, 0, "the page holds a comment that goes with the Send, so it never asked for a preview");
    assert.equal(await page.locator(q("quick-line")).count(), 0);
    assert.deepEqual(s.pending.instructions.comments.map((c) => c.id), ["c1"]);
    assert.equal(s.delivered, null, "nothing was done on this Mac");
    assert.ok(fs.readFileSync(file).equals(disk), "the file is unchanged");
    assert.equal(await page.evaluate(() => window.__sawQuick), false, "the page did not offer a quick change at any point");
    assert.deepEqual(page.log.errors, []);
    await page.close();
  });
});
