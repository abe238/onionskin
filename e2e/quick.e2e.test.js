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

  // ---- the 500-comment limit: a box that holds words never closes unless a comment took them (or the person pressed Esc in it) ----
  const seeded = (n) => Array.from({ length: n }, (_, i) => ({ id: `seed${i}`, kind: "element", text: `seed ${i}`, anchor: { location: { blockPath: [1] }, paraText: "" } }));
  /** A copy of the file with `n` unsent comments, open in a new page with Quick ask on a word of the first paragraph. */
  const boxAt = async (name, n) => {
    const f = path.join(root, "docs", name);
    fs.copyFileSync(file, f);
    const k = srv.sessions.open(fs.realpathSync(f)).key;
    srv.sessions.setDraft(k, { comments: seeded(n), note: "" });
    const p = await br.page();
    await p.setViewportSize({ width: 1440, height: 900 });
    const sends = [];
    p.on("request", (r) => new URL(r.url()).pathname === "/api/send" && sends.push(r));
    await p.goto(`${srv.auth.origin}/?s=${k}&n=${srv.auth.newNonce()}`);
    await waitDoc(p);
    await para(p, "Acme grew 24%").waitFor({ timeout: 30000 });
    const b = await para(p, "Acme grew 24%").boundingBox();
    await p.mouse.dblclick(b.x + 80, b.y + 10);
    await p.locator(q("comment-chip")).waitFor({ timeout: 5000 });
    await p.locator(q("quick-ask-chip")).click();
    await p.locator(q("quick-ask")).waitFor({ timeout: 3000 });
    return { p, k, sends, count: () => srv.sessions.get(k).comments.length, ids: () => srv.sessions.get(k).comments.map((c) => c.id) };
  };
  /** The list reaches the limit while the box is open: another window of the same file adds the last one. */
  const fill = async ({ p, k }) => {
    const s = srv.sessions.get(k);
    srv.sessions.setDraft(k, { comments: [...s.comments, { id: "other1", kind: "element", text: "from another window", anchor: { location: { blockPath: [1] }, paraText: "" } }], note: s.note, tab: "other-window" });
    await until(async () => (await p.locator(`${q("sidebar")} [data-comment-id]`).count()) === 500, "comment 500 on the page");
    await p.locator(q("quick-ask-text")).focus();
  };
  const WORDS = "Keep the date.";
  const FULL = "This file has 500 comments waiting; send or delete some before adding more.";

  test("A1: Send at the 500-comment limit keeps the box and its words, says why, and sends nothing", async () => {
    const t = await boxAt("full-send.docx", 499);
    try {
      await t.p.locator(q("quick-ask-text")).fill(WORDS);
      await fill(t);
      await t.p.locator(q("quick-ask-send")).click();
      await t.p.locator(q("quick-ask-hint"), { hasText: FULL }).waitFor({ timeout: 5000 });
      assert.equal(await t.p.locator(q("quick-ask-text")).inputValue(), WORDS, "the words are still in the box");
      assert.equal(await t.p.locator(q("quick-ask-text")).isEditable(), true, "and can be changed or copied");
      assert.equal(t.sends.length, 0, "nothing was sent");
    } finally {
      await t.p.close();
    }
  });

  /** The box is open with the words in it, editable, its hint says why, and the server holds no comment with them. */
  const held = async (t, what) => {
    await t.p.waitForTimeout(700); // past the 300 ms scroll rule and a frame or two
    assert.equal(await t.p.locator(q("quick-ask")).count(), 1, `${what}: the box is still open`);
    const r = await t.p.locator(q("quick-ask")).boundingBox();
    const vp = t.p.viewportSize();
    assert.ok(r && r.x >= 0 && r.y >= 0 && r.x + r.width <= vp.width && r.y + r.height <= vp.height, `${what}: and inside the window (${JSON.stringify(r)})`);
    assert.equal(await t.p.locator(q("quick-ask-text")).inputValue(), WORDS, `${what}: the words are in it`);
    assert.equal(await t.p.locator(q("quick-ask-text")).isEditable(), true, `${what}: and can be changed`);
    assert.match(await t.p.locator(q("quick-ask-hint")).textContent(), /500 comments waiting.*Your words stay in this box/, `${what}: the box says why`);
    assert.deepEqual(t.ids(), [...seeded(499).map((c) => c.id), "other1"], `${what}: the list is as it was, comment by comment`);
    assert.equal(t.sends.length, 0, `${what}: nothing was sent`);
  };

  test("A1: the X at the limit keeps the box and its words", async () => {
    const t = await boxAt("full-x.docx", 499);
    try {
      await t.p.locator(q("quick-ask-text")).fill(WORDS);
      await fill(t);
      await t.p.locator(q("quick-ask-close")).click();
      await held(t, "X");
      await t.p.locator(q("notice"), { hasText: FULL }).waitFor({ timeout: 3000 });
    } finally {
      await t.p.close();
    }
  });

  test("A1: Esc, a click and other words selected in the document at the limit keep the box and its words", async () => {
    const t = await boxAt("full-doc.docx", 499);
    try {
      await t.p.locator(q("quick-ask-text")).fill(WORDS);
      await fill(t);
      const at = await para(t.p, "Acme grew 24%").boundingBox();
      await t.p.mouse.click(at.x + 80, at.y + 10); // on the asked words: the focus goes to the document, the box stays (as before)
      await t.p.waitForTimeout(400);
      const inBox = () => t.p.evaluate(() => !!document.activeElement.closest('[data-testid="quick-ask"]'));
      assert.equal(await inBox(), false, "the focus is in the document");
      await t.p.keyboard.press("Escape");
      await held(t, "Esc in the document");
      await t.p.locator(q("notice"), { hasText: FULL }).waitFor({ timeout: 3000 }); // Esc is a press: the notice says why too
      // other words in view that the box does not cover (the way e2e/walk-selection.e2e.test.js finds them)
      const other = await t.p.evaluate(() => {
        const qa = document.querySelector('[data-testid="quick-ask"]').getBoundingClientRect();
        const sc = document.querySelector(".de-scroll").getBoundingClientRect();
        for (const p of document.querySelectorAll(".de-p")) {
          const r = p.getBoundingClientRect();
          const clear = r.right < qa.left || r.left > qa.right || r.bottom < qa.top || r.top > qa.bottom;
          if (!p.closest(".de-hf") && p.textContent.trim().length > 15 && r.top > sc.top + 20 && r.bottom < sc.bottom - 20 && clear && !p.textContent.includes("Acme grew 24%")) return { x: r.left + 30, y: r.top + r.height / 2, words: p.textContent.trim().slice(0, 12) };
        }
        return null;
      });
      assert.ok(other, "some other words are in view");
      const asked = (await t.p.locator(q("quick-ask-quote")).textContent()).trim();
      await t.p.mouse.click(other.x, other.y);
      assert.equal(await inBox(), false, "the click went to the document");
      await held(t, "a click elsewhere");
      await t.p.mouse.click(other.x, other.y, { clickCount: 3 });
      const picked = await t.p.evaluate(() => String(getSelection()).trim());
      assert.ok(picked.includes(other.words), `the other paragraph is selected: "${picked}"`);
      await t.p.locator(q("notice"), { hasText: "Quick ask is still open on the words you asked about before." }).waitFor({ timeout: 3000 });
      await held(t, "other words selected");
      assert.equal(await t.p.locator(q("comment-chip")).count(), 0, "no chip on the other words: its Ask would type into this box");
      await t.p.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+Shift+K`); // the shortcut on the other words goes to the held box
      await until(inBox, "the focus to be in the held box");
      assert.equal((await t.p.locator(q("quick-ask-quote")).textContent()).trim(), asked, "which still shows its own words");
      await held(t, "the shortcut on other words");
    } finally {
      await t.p.close();
    }
  });

  test("A1: the asked words scrolled out of view at the limit: the box stays on screen with its words", async () => {
    const t = await boxAt("full-scroll.docx", 499);
    try {
      await t.p.locator(q("quick-ask-text")).fill(WORDS);
      await fill(t);
      await t.p.setViewportSize({ width: 1440, height: 420 });
      const moved = await t.p.evaluate(() => {
        const el = document.querySelector(".de-scroll");
        el.scrollTo(0, el.scrollHeight);
        return el.scrollTop;
      });
      assert.ok(moved > 150, `the document scrolled (${moved}px)`);
      await until(async () => (await t.p.locator(q("quick-outline")).count()) === 0, "the asked words to leave the view");
      await held(t, "scrolled away");
    } finally {
      await t.p.close();
    }
  });

  test("A1: a stamp tap with an empty box at the limit sends nothing and makes no comment", async () => {
    const t = await boxAt("full-stamp.docx", 499);
    try {
      await fill(t);
      await t.p.locator(q("stamp"), { hasText: /^Shorter$/ }).click();
      await t.p.locator(q("notice"), { hasText: FULL }).waitFor({ timeout: 3000 });
      await t.p.waitForTimeout(500);
      assert.equal(await t.p.locator(q("quick-ask")).count(), 1, "the box is still open");
      assert.equal(t.count(), 500);
      assert.equal(t.sends.length, 0, "nothing was sent");
    } finally {
      await t.p.close();
    }
  });

  test("A1: once a comment is deleted the same Send goes through with the words", async () => {
    const t = await boxAt("full-freed.docx", 499);
    try {
      await t.p.locator(q("quick-ask-text")).fill(WORDS);
      await fill(t);
      await t.p.locator(q("quick-ask-send")).click();
      await held(t, "Send");
      await t.p.locator(q("delete-comment")).first().click();
      await until(async () => (await t.p.locator(`${q("sidebar")} [data-comment-id]`).count()) === 499, "one comment fewer");
      await until(async () => !/500 comments/.test(await t.p.locator(q("quick-ask-hint")).textContent()), "the hint to go back");
      await t.p.locator(q("quick-ask-send")).click();
      await t.p.locator(q("quick-ask")).waitFor({ state: "detached", timeout: 5000 });
      await until(() => srv.sessions.get(t.k).comments.some((c) => c.text === WORDS && c.status !== "draft"), "the words to be sent as a comment");
      const mine = srv.sessions.get(t.k).comments.find((c) => c.text === WORDS);
      assert.ok(t.sends[0].postDataJSON().sends.includes(mine.id), "the Send named that comment");
      assert.equal(t.sends.length, 1, "one Send");
    } finally {
      await t.p.close();
    }
  });

  test("A1 same as before: one below the limit, Send makes comment 500 and sends it", async () => {
    const t = await boxAt("under-send.docx", 499);
    try {
      await t.p.locator(q("quick-ask-text")).fill(WORDS);
      await t.p.locator(q("quick-ask-send")).click();
      await t.p.locator(q("quick-ask")).waitFor({ state: "detached", timeout: 5000 });
      await until(() => srv.sessions.get(t.k).comments.some((c) => c.text === WORDS && c.status !== "draft"), "the words to be sent as a comment");
      const mine = srv.sessions.get(t.k).comments.find((c) => c.text === WORDS);
      assert.ok(t.sends[0].postDataJSON().sends.includes(mine.id), "the Send named that comment");
      assert.equal(t.sends.length, 1);
    } finally {
      await t.p.close();
    }
  });

  // ---- A2: another tab takes over editing while this one holds Quick ask words ----
  const RO = /This tab is read-only/;
  /** Tab A with Quick ask open on a copy of the file; then tab B opens the same file and takes over, so A is read-only. */
  const takenOver = async (name, words) => {
    const a = await boxAt(name, 0);
    if (words) await a.p.locator(q("quick-ask-text")).fill(words);
    const b = await br.page();
    await b.setViewportSize({ width: 1440, height: 900 });
    await b.goto(`${srv.auth.origin}/?s=${a.k}&n=${srv.auth.newNonce()}`);
    await waitDoc(b);
    await b.locator(q("take-over")).click();
    await a.p.locator(q("banner-readonly")).waitFor({ timeout: 10000 });
    return { ...a, b };
  };
  const leaveAsks = (p) => p.evaluate(() => {
    const e = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(e);
    return e.defaultPrevented;
  });
  /** On the read-only tab the box is open with the words in it, editable, and says why. */
  const heldRo = async (t, what) => {
    await t.p.waitForTimeout(600);
    assert.equal(await t.p.locator(q("quick-ask")).count(), 1, `${what}: the box is still open`);
    assert.equal(await t.p.locator(q("quick-ask-text")).inputValue(), WORDS, `${what}: the words are in it`);
    assert.equal(await t.p.locator(q("quick-ask-text")).isEditable(), true, `${what}: and can be selected and copied`);
    assert.match(await t.p.locator(q("quick-ask-hint")).textContent(), RO, `${what}: the box says why`);
    assert.equal(srv.sessions.get(t.k).comments.length, 0, `${what}: no comment was made`);
    assert.equal(t.sends.length, 0, `${what}: nothing was sent`);
  };

  test("A2: after another tab takes over, Send, the X, a click and Esc in the document keep the box and its words, and leaving asks", async () => {
    const t = await takenOver("ro-held.docx", WORDS);
    try {
      await heldRo(t, "after the takeover");
      assert.equal(await leaveAsks(t.p), true, "leaving the read-only tab asks: the words are only here");
      await t.p.locator(q("quick-ask-send")).click();
      await heldRo(t, "Send");
      await t.p.locator(q("quick-ask-close")).click();
      await heldRo(t, "X");
      const at = await para(t.p, "Acme grew 24%").boundingBox();
      await t.p.mouse.click(at.x + 80, at.y + 10);
      await t.p.waitForTimeout(300);
      await t.p.keyboard.press("Escape");
      await heldRo(t, "Esc in the document");
      await t.p.locator(q("quick-ask-text")).focus();
      await t.p.keyboard.press("Escape"); // Esc in the box still discards, as its hint always said
      await t.p.locator(q("quick-ask")).waitFor({ state: "detached", timeout: 3000 });
      assert.equal(await leaveAsks(t.p), false, "nothing left to lose");
    } finally {
      await t.b.close();
      await t.p.close();
    }
  });

  test("A2: when the other tab closes and editing comes back, the words are still there and can be sent or kept", async () => {
    const t = await takenOver("ro-back.docx", WORDS);
    try {
      await heldRo(t, "after the takeover");
      await t.b.close();
      await t.p.locator(q("banner-readonly")).waitFor({ state: "detached", timeout: 15000 });
      await t.p.waitForTimeout(800);
      assert.equal(await t.p.locator(q("quick-ask")).count(), 1, "the box is still open");
      assert.equal(await t.p.locator(q("quick-ask-text")).inputValue(), WORDS, "with the words");
      await t.p.locator(q("quick-ask-close")).click(); // X keeps the words as an unsent comment, as on any editing tab
      await t.p.locator(q("quick-ask")).waitFor({ state: "detached", timeout: 3000 });
      await until(() => srv.sessions.get(t.k).comments.some((c) => c.text === WORDS && c.status === "draft"), "the words to be an unsent comment");
    } finally {
      await t.p.close();
    }
  });

  test("A2: a stamp tap with an empty box on a tab that became read-only makes nothing and says why", async () => {
    const t = await takenOver("ro-stamp.docx", "");
    try {
      await t.p.locator(q("stamp"), { hasText: /^Shorter$/ }).click();
      await t.p.locator(q("notice"), { hasText: RO }).waitFor({ timeout: 3000 });
      assert.equal(await t.p.locator(q("quick-ask")).count(), 1, "the box is still open");
      assert.equal(t.sends.length, 0);
    } finally {
      await t.b.close();
      await t.p.close();
    }
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
