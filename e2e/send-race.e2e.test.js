import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { boxOf, launch, makeWorld, scrollToPara, until, waitDoc } from "./helpers/harness.mjs";

// While a Send is in flight, what it carried is read only in the page (its comments and its note); a comment made meanwhile stays a draft
// and is saved after the answer; a reload during the wait starts from what the Send committed, so nothing is sent twice; a failed Send
// gives everything back as editable drafts; a quick Send never shows "Sending...". The server's anchor work is slowed by the test seam
// ONIONSKIN_TEST_ANCHOR_DELAY_MS to keep the Send in flight. Temp state folder and a fixture only; no agent.
const q = (id) => `[data-testid="${id}"]`;

let br;
before(async () => {
  br = await launch();
});
after(async () => {
  await br?.close();
});

async function comment(page, para, words) {
  const p = await scrollToPara(page, para, Number(para.match(/\d+/)[0]) / 300);
  const b = await boxOf(p);
  await page.mouse.dblclick(b.x + 150, b.y + 12);
  await page.locator(q("comment-chip")).waitFor({ timeout: 5000 });
  await page.locator(q("comment-chip")).click();
  await page.keyboard.type(words);
}
const cards = (page) =>
  page.locator(q("comment-card")).evaluateAll((els) => els.map((e) => ({ status: e.dataset.status, text: e.querySelector("textarea")?.value ?? "", readOnly: !!e.querySelector("textarea")?.readOnly })));
const shown = async (page) => (await cards(page)).map(({ status, text }) => ({ status, text }));
const sorted = (l) => [...l].sort((a, b) => a.text.localeCompare(b.text));
const same = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
/** The request goes to the server as the page sent it (route.fetch leaves out the browser's fetch metadata, which the server requires). */
const through = (route) => route.fetch({ headers: { ...route.request().headers(), "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" } });
const storedOf = (w) => () => {
  const dir = path.join(w.state, "sessions");
  return JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir).find((f) => f.endsWith(".json"))), "utf8"));
};

test("during a Send: what it carried is read only, a new comment stays a draft and is saved after, and a reload starts from the commit", { timeout: 240_000 }, async () => {
  const w = makeWorld({ ONIONSKIN_TEST_ANCHOR_DELAY_MS: "2500" });
  const page = await br.page();
  page.on("dialog", (d) => d.accept()); // the leave-page question at the reload (a comment made during the wait is not saved yet)
  try {
    const file = w.doc("send-race.docx");
    fs.copyFileSync(w.doc("long.docx"), file);
    const stored = storedOf(w);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(await w.open(file));
    await waitDoc(page);
    await comment(page, "Paragraph 015:", "Original comment");
    await page.locator(q("overall-note")).fill("First note");
    await page.waitForTimeout(600); // the autosave goes first, as it would for a person
    const send = page.locator(q("send"));
    await send.click();
    await until(async () => (await send.getAttribute("data-busy")) === "1", "the Send to be in flight");
    // what it carried is read only: typing into it changes nothing
    const first = page.locator(q("comment-card")).first();
    const box = first.locator("textarea");
    const note = page.locator(q("overall-note"));
    assert.equal(await box.evaluate((e) => e.readOnly), true, "the comment the Send carried is read only");
    assert.equal(await note.evaluate((e) => e.readOnly), true, "so is the note");
    await box.focus();
    await page.keyboard.type(" and more");
    await note.focus();
    await page.keyboard.type(" and more");
    assert.equal(await box.inputValue(), "Original comment", "typing changed nothing");
    assert.equal(await note.inputValue(), "First note");
    // past about 300 ms the button and the card say so
    await until(async () => (await send.textContent()).includes("Sending..."), "the button to say Sending...");
    assert.equal(await first.locator(q("card-state")).textContent(), "Sending...");
    // a new comment can still be made, and it is editable
    await comment(page, "Paragraph 020:", "Added during Send");
    assert.equal(await send.getAttribute("data-busy"), "1", "all of this happened while the Send was in flight");
    assert.ok((await cards(page)).some((c) => c.text === "Added during Send" && !c.readOnly), "the new comment is editable");
    await until(async () => (await send.getAttribute("data-busy")) === "0", "the Send to finish", 60_000);
    const want = [
      { status: "sent", text: "Original comment" },
      { status: "draft", text: "Added during Send" },
    ];
    await until(async () => same(await shown(page), want), "the page to show the sent comment and the new draft");
    assert.ok((await cards(page)).every((c) => !c.readOnly), "nothing is read only after the answer");
    assert.equal(await note.inputValue(), "", "the note went with the Send");
    const rows = () => stored().comments.map((c) => ({ status: c.status, text: c.text }));
    await until(() => same(rows(), want) && stored().note === "", "the stored session to hold the sent comment and the new draft, saved after the answer");
    assert.equal(stored().pending.instructions.overall_note, "First note");
    assert.deepEqual(stored().pending.instructions.comments.map((c) => c.text), ["Original comment"]);

    // a second Send (no agent: it replaces the waiting batch, which keeps its note), and a reload while it is in flight
    await note.fill("Second note");
    await page.waitForTimeout(600);
    await send.click();
    await until(async () => (await send.getAttribute("data-busy")) === "1", "the second Send to be in flight");
    await comment(page, "Paragraph 025:", "Made just before the reload");
    await page.reload(); // the Send's request is cut off by it: the page cannot tell whether it went through, so no save carries the note
    await waitDoc(page);
    const later = [
      { status: "sent", text: "Original comment" },
      { status: "sent", text: "Added during Send" },
      { status: "draft", text: "Made just before the reload" },
    ];
    await until(async () => same(await shown(page), later), "the reloaded page to show the committed Send and the comment saved on the way out");
    assert.equal(await note.inputValue(), "", "the reloaded page's note box is empty: the note is not sent twice");
    assert.equal(stored().note, "", "and so is the stored one");
    assert.equal(stored().pending.instructions.overall_note, "First note\n\nSecond note", "each note once, in order");
    assert.deepEqual(stored().pending.instructions.comments.map((c) => c.text), ["Original comment", "Added during Send"]);
    // the reloaded page can edit its draft, and the edit reaches the stored session
    const boxes = page.locator(`${q("comment-card")} textarea`);
    for (let i = 0; i < (await boxes.count()); i++) if ((await boxes.nth(i).inputValue()) === "Made just before the reload") await boxes.nth(i).fill("Edited after reload");
    await until(() => stored().comments.some((c) => c.status === "draft" && c.text === "Edited after reload"), "the edit after the reload to be saved");
  } finally {
    await page.close();
    await w.cleanup();
  }
});

test("words added to an existing blank draft during Send survive reload", { timeout: 240_000 }, async () => {
  const w = makeWorld();
  const page = await br.page();
  try {
    await page.goto(await w.open(w.doc("long.docx")));
    await waitDoc(page);
    await comment(page, "Paragraph 015:", "");
    await page.locator(q("overall-note")).fill("Check the date.");
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    await page.route("**/api/send?*", async (route) => { await gate; await route.continue(); });
    const request = page.waitForRequest((r) => new URL(r.url()).pathname === "/api/send");
    await page.locator(q("send")).click();
    assert.equal((await request).postDataJSON().comments[0].text, "");
    const box = page.locator(`${q("comment-card")} textarea`);
    // A save on the way out consumes the pending timer even if the page stays and that request is lost.
    await page.route("**/api/draft?*", (route) => route.abort("failed"), { times: 1 });
    await box.fill("Keep the last sentence.");
    const lost = page.waitForEvent("requestfailed", (r) => new URL(r.url()).pathname === "/api/draft");
    await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
    await lost;
    release();
    await until(() => storedOf(w)().comments.some((c) => c.status === "draft" && c.text === "Keep the last sentence."), "the draft autosave");
    await page.reload();
    await waitDoc(page);
    assert.equal(await box.inputValue(), "Keep the last sentence.");
  } finally {
    await page.close();
    await w.cleanup();
  }
});

// The review of 3c7d3a6 (H2): a note typed after a Send and Take back pressed within the 350 ms autosave delay lost the new words: the
// answer carried the stored older note and the page put it in the box. Take back now saves what is typed first, then joins.
test("a note typed just before Take back stays in the box with the withdrawn note, and survives a reload", { timeout: 240_000 }, async () => {
  const w = makeWorld();
  const page = await br.page();
  try {
    const file = w.doc("takeback-note.docx");
    fs.copyFileSync(w.doc("long.docx"), file);
    const stored = storedOf(w);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(await w.open(file));
    await waitDoc(page);
    await comment(page, "Paragraph 015:", "Fix the heading");
    const note = page.locator(q("overall-note"));
    await note.fill("First instruction");
    await page.waitForTimeout(600);
    await page.locator(q("send")).click();
    await until(() => stored().pending?.instructions?.overall_note === "First instruction", "the Send to wait for an agent");
    await until(async () => (await note.inputValue()) === "" && (await page.locator(q("take-back")).count()) > 0, "the note box to empty and Take back to show");
    await note.focus();
    const back = page.locator(q("take-back")).first();
    await back.waitFor();
    await page.keyboard.insertText("Also correct the spelling."); // one input event, then the press at once: well within the autosave's delay
    await page.evaluate(() => document.querySelector('[data-testid="take-back"]').click()); // a pointer click waits for actionability, past the delay
    const want = "First instruction\n\nAlso correct the spelling.";
    await until(async () => (await shown(page)).every((c) => c.status === "draft") && stored().pending == null, "the batch to come back");
    await page.waitForTimeout(1000); // any autosave scheduled before the press has run by now
    assert.equal(await note.inputValue(), want, "the withdrawn note and the words typed just before");
    await until(() => stored().note === want, "the stored note to hold both");
    await page.reload();
    await waitDoc(page);
    assert.equal(await page.locator(q("overall-note")).inputValue(), want, "after a reload too");
  } finally {
    await page.close();
    await w.cleanup();
  }
});

// The review of 3c7d3a6 (H3): a Send whose answer and the check that followed were both lost, with the event stream down, unlocked its
// comment; a correction typed then was replaced by the frozen original on the next save's answer. The comment now stays locked, saying
// it is being checked, until the outcome is known.
test("a Send whose answer and check are lost stays locked while it is checked, then shows what happened, and nothing typed is lost", { timeout: 240_000 }, async () => {
  const w = makeWorld();
  const page = await br.page();
  try {
    const file = w.doc("send-lost.docx");
    fs.copyFileSync(w.doc("long.docx"), file);
    const stored = storedOf(w);
    await page.route("**/api/events?*", (route) => route.abort("failed")); // the event stream is down from the start
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(await w.open(file));
    await waitDoc(page);
    await comment(page, "Paragraph 015:", "Original comment");
    await page.waitForTimeout(600);
    await until(() => stored().comments.some((c) => c.text === "Original comment"), "the autosave");
    // the Send reaches the server and commits; its answer and the check after it are lost
    await page.route("**/api/bootstrap?*", (route) => route.abort("failed"));
    let reached = 0;
    await page.route("**/api/send?*", async (route) => {
      const r = await through(route);
      reached = r.status();
      await route.abort("failed");
    });
    const send = page.locator(q("send"));
    await send.click();
    await until(() => reached === 200 && stored().comments.some((c) => c.status === "sent"), "the Send to commit on the server");
    const card = page.locator(q("comment-card")).first();
    await until(async () => /Checking/.test(await card.locator(q("card-state")).textContent()), "the card to say it is being checked", 15_000);
    assert.equal(await card.locator("textarea").evaluate((e) => e.readOnly || e.disabled), true, "the comment stays locked");
    await card.locator("textarea").focus();
    await page.keyboard.type(" corrected");
    assert.equal(await card.locator("textarea").inputValue(), "Original comment", "typing changes nothing while it is checked");
    await page.waitForTimeout(2500); // past a retry or two of the check
    assert.match(await card.locator(q("card-state")).textContent(), /Checking/, "still checking while the server cannot be asked");
    await page.unroute("**/api/send?*");
    await page.unroute("**/api/bootstrap?*");
    await until(async () => (await card.getAttribute("data-status")) === "sent" && (await send.getAttribute("data-busy")) === "0", "the outcome to be learned", 60_000);
    assert.deepEqual(await shown(page), [{ status: "sent", text: "Original comment" }]);
    await page.unroute("**/api/events?*");
    assert.deepEqual(stored().pending.instructions.comments.map((c) => c.text), ["Original comment"], "sent once");
  } finally {
    await page.close();
    await w.cleanup();
  }
});

// The general rule: text the person typed is never replaced by text from the server unless the server's text is based on it. A save whose
// answer comes back late carries older words for the comment and the note than the page now shows.
test("words typed while a save is in flight are kept when its answer carries the older words", { timeout: 240_000 }, async () => {
  const w = makeWorld();
  const page = await br.page();
  try {
    const file = w.doc("save-late.docx");
    fs.copyFileSync(w.doc("long.docx"), file);
    const stored = storedOf(w);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(await w.open(file));
    await waitDoc(page);
    await comment(page, "Paragraph 015:", "Draft one");
    await page.waitForTimeout(600);
    let late = 0;
    await page.route("**/api/draft?*", async (route) => {
      const r = await through(route); // the server has it; the answer comes back late
      assert.equal(r.status(), 200);
      late++;
      await new Promise((ok) => setTimeout(ok, 1500));
      await route.fulfill({ response: r });
    });
    const box = page.locator(`${q("comment-card")} textarea`).first();
    const note = page.locator(q("overall-note"));
    await box.focus();
    await page.keyboard.press("End");
    await page.keyboard.type(" A");
    await note.focus();
    await page.keyboard.type("Note A");
    await until(() => late > 0, "a save to be in flight");
    await box.focus();
    await page.keyboard.press("End");
    await page.keyboard.type(" B");
    await note.focus();
    await page.keyboard.press("End");
    await page.keyboard.type(" B");
    await page.waitForTimeout(2500); // the late answer (older words) has arrived
    assert.equal(await box.inputValue(), "Draft one A B");
    assert.equal(await note.inputValue(), "Note A B");
    await page.unroute("**/api/draft?*");
    await until(() => stored().comments.some((c) => c.text === "Draft one A B") && stored().note === "Note A B", "the newer words to be stored");
  } finally {
    await page.close();
    await w.cleanup();
  }
});

test("a Send that fails gives back every comment and the note as editable drafts, with the error; a quick Send never shows Sending...", { timeout: 240_000 }, async () => {
  const w = makeWorld();
  const page = await br.page();
  try {
    const file = w.doc("send-fail.docx");
    fs.copyFileSync(w.doc("long.docx"), file);
    const stored = storedOf(w);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(await w.open(file));
    await waitDoc(page);
    // a quick Send: the state never shows (it would flicker)
    await comment(page, "Paragraph 015:", "Quick one");
    await page.waitForTimeout(600);
    // the page's own clock: when the button's data-busy turned on and off, and whether "Sending..." was ever drawn
    await page.evaluate(() => {
      const t = (window.__t = { saw: false, on: null, off: null });
      const look = () => {
        const b = document.querySelector('[data-testid="send"]');
        if (b?.dataset.busy === "1" && t.on == null) t.on = performance.now();
        if (b?.dataset.busy === "0" && t.on != null && t.off == null) t.off = performance.now();
        if (b?.textContent.includes("Sending...") || [...document.querySelectorAll('[data-testid="card-state"]')].some((e) => e.textContent === "Sending...")) t.saw = true;
      };
      new MutationObserver(look).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    });
    const send = page.locator(q("send"));
    await send.click();
    await until(async () => (await send.getAttribute("data-busy")) === "0" && (await page.locator(q("card-state")).first().textContent()) !== "Draft", "the quick Send to finish", 30_000);
    const t = await page.evaluate(() => window.__t);
    const took = Math.round(t.off - t.on);
    assert.ok(t.on != null && t.off != null, "the Send was seen in flight and done");
    if (took < 280) assert.equal(t.saw, false, `a Send of ${took} ms showed Sending...`);
    else console.log(`# the quick Send took ${took} ms here, so the no-flicker check was not made`);
    // a Send that fails at the server (503, as a read past the worker's limit answers) and one that never reaches it
    await comment(page, "Paragraph 040:", "Will fail");
    const note = page.locator(q("overall-note"));
    await note.fill("Kept note");
    await page.waitForTimeout(600);
    // "both": no answer, and the check of whether it went through fails too: it stays locked until the check is answered
    for (const how of ["503", "network", "both"]) {
      if (how === "both") await page.route("**/api/bootstrap?*", (route) => route.abort("failed"));
      await page.route("**/api/send?*", async (route) => {
        await new Promise((r) => setTimeout(r, 700)); // long enough for the Sending... state
        if (how === "503") await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Onionskin could not finish reading the file in time, so nothing was sent. Your comments are kept. Try again in a moment.", code: "read_timeout" }) });
        else await route.abort("failed");
      });
      await send.click();
      await until(async () => (await send.getAttribute("data-busy")) === "1", `the ${how} Send to be in flight`);
      assert.equal(await note.evaluate((e) => e.readOnly), true, `${how}: the note is read only while it is in flight`);
      if (how === "both") {
        // the outcome cannot be learned: it stays locked, saying so, and asks again until the server answers (it never got this Send)
        await until(async () => /Checking/.test(await page.locator(`[data-held="1"] ${q("card-state")}`).textContent()), "the both Send to say it is being checked", 30_000);
        assert.equal(await note.evaluate((e) => e.readOnly), true, "both: the note stays read only while it is checked");
        await page.unroute("**/api/bootstrap?*");
      }
      await until(async () => (await send.getAttribute("data-busy")) === "0", `the ${how} Send to fail`, 30_000);
      await page.unroute("**/api/send?*");
      const draft = (await cards(page)).find((c) => c.text.startsWith("Will fail"));
      assert.deepEqual([draft.status, draft.readOnly], ["draft", false], `${how}: the comment is an editable draft again`);
      assert.equal(await note.inputValue(), "Kept note", `${how}: the note is back`);
      assert.equal(await note.evaluate((e) => e.readOnly), false);
      const error = await page.locator(q("banner-error")).textContent();
      assert.match(error, how === "503" ? /could not finish reading the file in time/ : /Could not reach the Onionskin server/, `${how}: the error is shown`);
    }
    // and it is editable for real: an edit of the comment and of the note is saved (after "both" too)
    const boxes = page.locator(`${q("comment-card")} textarea`);
    for (let i = 0; i < (await boxes.count()); i++) if ((await boxes.nth(i).inputValue()) === "Will fail") await boxes.nth(i).fill("Will fail, edited");
    await note.fill("Kept note, and more");
    await until(() => stored().comments.some((c) => c.status === "draft" && c.text === "Will fail, edited") && stored().note === "Kept note, and more", "the edit and the note to be stored");
  } finally {
    await page.close();
    await w.cleanup();
  }
});

// The review of d8e6707 (H2): typed words whose save on the way out never arrives, or whose autosave is still on its way, left the page with
// no question: the flag was cleared before the leave-page check, and saves in flight were not counted. A word is unsaved until the answer of
// a save that carried it comes back (web/src/drafts.js dirty).
test("leaving with words no save has confirmed asks first: before the autosave, and while it is on its way", { timeout: 240_000 }, async () => {
  const w = makeWorld();
  try {
    for (const how of ["pending", "outstanding"]) {
      const page = await br.page();
      const file = w.doc(`leave-${how}.docx`);
      fs.copyFileSync(w.doc("long.docx"), file);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(await w.open(file));
      await waitDoc(page);
      const held = [];
      // pending: every save fails (the one on the way out too); outstanding: the autosave reaches nobody and never answers
      await page.route("**/api/draft?*", (route) => (how === "pending" ? route.abort("failed") : held.push(route)));
      await comment(page, "Paragraph 015:", `Unsaved words ${how}`);
      if (how === "outstanding") {
        await until(() => held.length > 0, "the autosave to be on its way");
      } else await page.locator(q("overall-note")).fill("Unsaved note"); // typed just now: younger than the autosave
      const seen = [];
      page.on("dialog", (d) => (seen.push(d.type()), d.dismiss()));
      await page.close({ runBeforeUnload: true });
      await until(() => seen.length > 0, `the leave-page question (${how})`, 8000);
      assert.deepEqual(seen, ["beforeunload"], how);
      assert.equal(page.isClosed(), false, "dismissing it keeps the page and the words");
      assert.ok((await shown(page)).some((c) => c.text === `Unsaved words ${how}`));
      for (const r of held.splice(0)) await r.abort("failed").catch(() => {});
      await page.unroute("**/api/draft?*");
      await page.close();
    }
  } finally {
    await w.cleanup();
  }
});

// The review of d8e6707 (L1): a Send that committed but whose answer never came kept what it carried locked, and Take back blocked, even
// after the event stream showed it committed. That event now settles it.
test("a Send whose answer never comes is settled by the event that shows it committed: unlocked, and Take back works", { timeout: 240_000 }, async () => {
  const w = makeWorld();
  const page = await br.page();
  try {
    const file = w.doc("send-hung.docx");
    fs.copyFileSync(w.doc("long.docx"), file);
    const stored = storedOf(w);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(await w.open(file));
    await waitDoc(page);
    await comment(page, "Paragraph 015:", "Sent, no answer");
    await page.locator(q("overall-note")).fill("A note");
    await page.waitForTimeout(600);
    const hung = [];
    await page.route("**/api/send?*", async (route) => {
      await through(route); // the server has it and commits; the answer is held open
      hung.push(route);
    });
    const send = page.locator(q("send"));
    await send.click();
    await until(() => hung.length > 0 && stored().pending?.instructions?.overall_note === "A note", "the Send to commit with its answer held");
    await until(async () => (await send.getAttribute("data-busy")) === "0", "the event to settle the Send", 20_000);
    assert.deepEqual(await shown(page), [{ status: "sent", text: "Sent, no answer" }]);
    assert.equal(await page.locator(q("overall-note")).inputValue(), "");
    await page.locator(q("take-back")).first().click();
    await until(async () => (await shown(page)).every((c) => c.status === "draft") && stored().pending == null, "Take back to work");
    assert.equal(await page.locator(q("overall-note")).inputValue(), "A note");
    for (const r of hung.splice(0)) await r.abort("failed").catch(() => {});
  } finally {
    await page.close();
    await w.cleanup();
  }
});

// The review of d8e6707 (H1): words typed in one window and not saved yet were replaced by the stored text when another window took over
// editing ("Edit here instead"). The window that loses editing now hands them over first; when that cannot be delivered they stay on its
// page, with Copy my comments.
test("Edit here instead in a second window: the first window's unsaved words are handed over, or kept on its page with Copy", { timeout: 240_000 }, async () => {
  const w = makeWorld();
  try {
    for (const how of ["handed over", "kept"]) {
      const file = w.doc(`handover-${how.replace(" ", "-")}.docx`);
      fs.copyFileSync(w.doc("long.docx"), file);
      const stored = () => {
        const dir = path.join(w.state, "sessions");
        return fs.readdirSync(dir).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))).find((s) => s.file.endsWith(path.basename(file)));
      };
      const a = await br.page();
      await a.setViewportSize({ width: 1440, height: 900 });
      await a.goto(await w.open(file));
      await waitDoc(a);
      await comment(a, "Paragraph 015:", "Saved comment");
      await until(() => stored()?.comments.some((c) => c.text === "Saved comment"), "the first words to be saved");
      // from now on window A's autosaves reach nobody
      const held = [];
      await a.route("**/api/draft?*", (route) => held.push(route));
      if (how === "kept") await a.route("**/api/handover?*", (route) => route.abort("failed"));
      await a.locator(`${q("comment-card")} textarea`).first().fill("Unsaved correction");
      await a.locator(q("overall-note")).fill("Unsaved instruction");
      const b = await br.page();
      await b.setViewportSize({ width: 1440, height: 900 });
      await b.goto(await w.open(file));
      await waitDoc(b);
      await b.locator(q("take-over")).click();
      await a.locator('[data-testid="banner-readonly"]').waitFor({ timeout: 10_000 });
      if (how === "handed over") {
        await until(() => stored().comments.some((c) => c.text === "Unsaved correction") && stored().note.includes("Unsaved instruction"), "the words to be handed over");
        // nobody changed that comment since this window saved it: the newer words replace it (another window's change would stay, next to them)
        assert.deepEqual(stored().comments.map((c) => c.text), ["Unsaved correction"]);
        await until(async () => (await shown(b)).some((c) => c.text === "Unsaved correction") && (await b.locator(q("overall-note")).inputValue()).includes("Unsaved instruction"), "the window that edits now to show them");
      } else {
        await a.locator(q("copy-comments")).waitFor({ timeout: 10_000 });
        assert.match(await a.locator(q("banner-error")).textContent(), /could not be handed/);
        await a.waitForTimeout(1000);
        assert.ok((await shown(a)).some((c) => c.text === "Unsaved correction"), "the words stay on the page");
        assert.equal(await a.locator(q("overall-note")).inputValue(), "Unsaved instruction");
      }
      for (const r of held.splice(0)) await r.abort("failed").catch(() => {});
      await a.close();
      await b.close();
    }
  } finally {
    await w.cleanup();
  }
});
