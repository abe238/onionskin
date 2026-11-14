import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { cspViolations, launch, makeWorld, until, waitDoc } from "./helpers/harness.mjs";

// One editable tab per file: a second tab for the same file opens read-only with a clear banner.

describe("a second tab for the same file is read-only", () => {
  let w, br, file, one, two;
  before(async () => {
    w = makeWorld({ ONIONSKIN_NO_SOFFICE: "1" });
    br = await launch();
    file = w.doc("long.docx");
  });
  after(async () => {
    await br?.close();
    await w?.cleanup();
  });

  const attemptPost = (page, route, body) =>
    page.evaluate(async ([route, body]) => {
      const sid = new URLSearchParams(location.search).get("s") || window.__sid;
      const token = sessionStorage.getItem(`onionskin.token.${sid}`); // the page keeps its launch token in its own origin's sessionStorage
      const tok = await (await fetch(`/api/bootstrap?s=${sid}`, { headers: { "x-onionskin-token": token } })).json();
      const r = await fetch(`${route}?s=${tok.session.key}`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-onionskin-token": token, "x-onionskin-tab": "tabOtherForTest" }, body: JSON.stringify(body) });
      return { status: r.status, json: await r.json().catch(() => ({})) };
    }, [route, body]);

  test("the first tab edits; the second shows a banner, a locked toolbar and no way to send", async () => {
    one = await br.page();
    await one.goto(await w.open(file));
    await waitDoc(one);
    await one.locator('[data-testid="comment-card"], [data-testid="sidebar"]').first().waitFor();
    assert.equal(await one.locator('[data-testid="banner-readonly"]').count(), 0, "the first tab is the editor");
    await one.locator('[data-testid="mode-comment"]').click();
    const p = one.locator(".de-p", { hasText: "Paragraph 003" }).first();
    await p.scrollIntoViewIfNeeded();
    await p.click();
    await one.locator('[data-testid="comment-card"] textarea').last().fill("First tab comment.");

    two = await br.page();
    await two.goto(await w.open(file));
    await waitDoc(two);
    const banner = two.locator('[data-testid="banner-readonly"]');
    await banner.waitFor({ timeout: 15000 });
    assert.match(await banner.textContent(), /Read-only: this file is open for editing in another tab/);
    assert.match(await two.locator('[data-testid="sync-state"]').textContent(), /Read-only/);
    assert.equal(await two.locator('[data-testid="mode-comment"]').isDisabled(), true);
    assert.equal(await two.locator('[data-testid="mode-pin"]').isDisabled(), true);
    assert.equal(await two.locator('[data-testid="send"]').isDisabled(), true);
    assert.equal(await two.locator('[data-testid="overall-note"]').isDisabled(), true);
    assert.equal(await one.locator('[data-testid="banner-readonly"]').count(), 0, "the editing tab shows no banner");
    // what the editing tab saved shows up read-only here
    await until(async () => (await two.locator('[data-testid="comment-card"]').count()) === 1, "the draft comment of the first tab shown in the second");
    assert.equal(await two.locator('[data-testid="comment-card"] textarea').isDisabled(), true);
    assert.equal(await two.locator('[data-testid="docwrap"] [contenteditable="true"]').count(), 0, "the document is not editable in the read-only tab");
  });

  test("the server refuses changes from a tab that is not the editor", async () => {
    const draft = await attemptPost(two, "/api/draft", { comments: [], note: "overwrite" });
    assert.equal(draft.status, 409);
    assert.equal(draft.json.code, "not_editor");
    assert.equal((await attemptPost(two, "/api/send", { baseSha: "x", comments: [], note: "n", edits: [] })).status, 409);
    const st = JSON.parse((await w.cli(["status", file])).stdout);
    assert.equal(st.comments.total, 1, "the editing tab's draft was not overwritten");
  });

  test("Edit here instead moves the editor to this tab; reloading the editing tab keeps it", async () => {
    await two.locator('[data-testid="take-over"]').click();
    await until(async () => (await two.locator('[data-testid="banner-readonly"]').count()) === 0, "the second tab is the editor");
    await one.locator('[data-testid="banner-readonly"]').waitFor({ timeout: 10000 });
    assert.equal(await two.locator('[data-testid="mode-comment"]').isDisabled(), false);
    // a reload of the editing tab does not hand the file to another tab: it comes back as the editor
    await two.reload();
    await waitDoc(two);
    await two.waitForTimeout(1500);
    assert.equal(await two.locator('[data-testid="banner-readonly"]').count(), 0, "the reloaded editing tab is still the editor");
    assert.equal(await two.locator('[data-testid="comment-card"]').count(), 1, "its comment is still there");
    assert.deepEqual(cspViolations(br.log), []);
    assert.deepEqual(br.log.errors, []);
  });

  test("a new tab without a launch link has the cookie but no token: it says to reopen from the terminal and reads nothing", async () => {
    const launchUrl = new URL(await w.open(file));
    const bare = await br.page();
    await bare.goto(`${launchUrl.origin}/?s=${launchUrl.searchParams.get("s")}`); // same browser, same cookie, no nonce, empty sessionStorage
    await bare.locator('[data-testid="reopen"]').waitFor({ timeout: 15000 });
    assert.match(await bare.locator('[data-testid="reopen"]').textContent(), /Reopen from your terminal/);
    assert.match(await bare.locator('[data-testid="reopen"]').textContent(), /onionskin open/);
    assert.equal(await bare.locator('[data-testid="docwrap"]').count(), 0, "no document was loaded");
  });
});
