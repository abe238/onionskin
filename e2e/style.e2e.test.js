import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { agentEdit, launch, makeWorld, waitDoc } from "./helpers/harness.mjs";

// Writing preferences in a real browser: a tap puts the fixed sentence in the next batch, the offer after a Revert shows only fixed labels,
// "Clear all" removes the field, and the choice survives a server restart. Never reads the clipboard, never asserts focus.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let w, br;
before(async () => {
  w = makeWorld();
  br = await launch();
});
after(async () => {
  await br?.close();
  await w?.cleanup();
});

const T = (page, id) => page.locator(`[data-testid="${id}"]`);

/** Start the agent's poll, send a note from the page, and return the batch the agent gets. */
async function sendAndPoll(page, file, note) {
  const poll = w.spawnCli(["poll", file]);
  await T(page, "banner-listening").waitFor({ timeout: 20000 });
  await T(page, "overall-note").fill(note);
  await page.waitForTimeout(700);
  await T(page, "send").click();
  const res = await Promise.race([poll.done, sleep(25000).then(() => null)]);
  assert.ok(res && res.code === 0, res?.stderr);
  await T(page, "banner-working").waitFor();
  return JSON.parse(res.stdout);
}
async function finish(file, tag) {
  const rj = w.doc(`r-${tag}.json`);
  fs.writeFileSync(rj, JSON.stringify({ summary: "ok", results: [] }));
  assert.equal((await w.cli(["done", file, "--results", rj])).code, 0);
}

describe("writing preferences", () => {
  test("tap, send, offer after Revert, clear all, restart", async () => {
    const file = w.doc("long.docx");
    const page = await br.page();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(await w.open(file));
    await waitDoc(page);
    assert.match(await T(page, "style-summary").innerText(), /Writing preferences: none/);

    await T(page, "style-change").click();
    await T(page, "style-trait-short").click();
    await T(page, "style-done").click();
    await page.locator('[data-testid="style-summary"]', { hasText: /Writing preferences: Keep it short$/ }).waitFor({ timeout: 5000 });

    const b1 = await sendAndPoll(page, file, "Please tidy this up.");
    assert.equal(b1.instructions.style_note, "How I like text written: Keep new text short.");
    agentEdit([file, "replace", "regional leads", "regional managers", "Paragraph 010:"]);
    await finish(file, "1");

    // the Revert offers only the fixed labels not yet on; the own-words box is empty
    await T(page, "revert").click();
    await T(page, "style-offer").waitFor();
    const offered = await T(page, "style-offer").locator("button").allInnerTexts();
    assert.deepEqual(offered, ["Plain words", "More formal", "More relaxed", "Change as little as possible", "Leave formatting alone", "Short sentences", "No exclamation marks", "Not now"]);
    await T(page, "style-offer-plain").click();
    await page.locator('[data-testid="style-summary"]', { hasText: "Keep it short, Plain words" }).waitFor({ timeout: 5000 });
    await T(page, "style-change").click();
    assert.equal(await T(page, "style-words").inputValue(), "");
    await T(page, "style-done").click();

    // clear all removes the field from the next batch
    await T(page, "style-change").click();
    await T(page, "style-clear").click();
    await T(page, "style-done").click();
    const b2 = await sendAndPoll(page, file, "Again please.");
    assert.ok(!("style_note" in b2.instructions));
    await finish(file, "2");

    // the choice survives a server restart
    await T(page, "style-change").click();
    await T(page, "style-trait-formal").click();
    await page.locator('[data-testid="style-summary"]', { hasText: "More formal" }).waitFor({ timeout: 5000 });
    await T(page, "style-done").click();
    await w.cli(["stop"]);
    const page2 = await br.page();
    await page2.setViewportSize({ width: 1440, height: 900 });
    await page2.goto(await w.open(file));
    await waitDoc(page2);
    assert.match(await T(page2, "style-summary").innerText(), /Writing preferences: More formal/);
  });

  test("Clear preferences leaves a saved voice guide alone, and the guide has its own Remove control with a confirm", async () => {
    const file = w.doc("long.docx");
    for (const old of br.ctx.pages()) await old.close(); // a second tab on the same file would be read-only
    const page = await br.page();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(await w.open(file));
    await waitDoc(page);
    const guideFile = path.join(w.state, "voice-guide.json");
    const stored = () => JSON.parse(fs.readFileSync(guideFile, "utf8")).text;
    await T(page, "style-change").click();
    await T(page, "style-trait-short").click();
    await T(page, "voice-import-open").click();
    await T(page, "voice-import-text").fill("Write like a neighbor. Short lines.");
    await T(page, "voice-import-save").click();
    await T(page, "voice-import").waitFor({ state: "detached" });
    const status = () => T(page, "voice-guide-status").innerText();
    assert.equal(await status(), "Voice guide: saved, sent with every request");

    // the button says what it clears, and the guide stays
    assert.equal((await T(page, "style-clear").innerText()).trim(), "Clear preferences");
    await T(page, "style-clear").click();
    await page.locator('[data-testid="style-summary"]', { hasText: "Writing preferences: none" }).waitFor({ timeout: 5000 });
    assert.equal(await status(), "Voice guide: saved, sent with every request", "Clear preferences does not touch the guide");
    assert.equal(stored(), "Write like a neighbor. Short lines.");

    // the guide's own control sits in its block, at least 32 px tall, and asks first
    const rm = T(page, "voice-guide-remove");
    assert.equal((await rm.innerText()).trim(), "Remove guide");
    assert.ok((await rm.boundingBox()).height >= 32, "a comfortable target");
    await rm.click();
    const dlg = T(page, "voice-remove");
    await dlg.waitFor();
    assert.match(await dlg.innerText(), /Remove your voice guide\? This cannot be undone\./);
    await T(page, "voice-remove-cancel").click();
    await dlg.waitFor({ state: "detached" });
    assert.equal(stored(), "Write like a neighbor. Short lines.", "Cancel keeps the guide");
    await rm.click();
    await T(page, "voice-remove-confirm").click();
    await dlg.waitFor({ state: "detached" });
    await page.locator('[data-testid="voice-guide-status"]', { hasText: "Voice guide: none" }).waitFor({ timeout: 5000 });
    assert.equal(stored(), "");
    assert.equal(await T(page, "voice-guide-remove").count(), 0, "nothing left to remove");
  });
});
