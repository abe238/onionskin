import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { after, before, describe, test } from "node:test";
import { LINE_END, agentEdit, boxOf, cspViolations, launch, makeWorld, para, scrollToPara, until, waitDoc } from "./helpers/harness.mjs";

// The History section of the review panel, in a real browser: what the last updates show, one open at a time, red and green only in the
// panel (never in the document), "Show" that outlines without touching the text, widths that never scroll sideways, phone layout without it.
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const rows = (page) => page.locator('[data-testid="history-row"]');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let br;
before(async () => {
  br = await launch();
});
after(async () => {
  await br?.close();
});

async function typeInto(page, text, add) {
  const p = await scrollToPara(page, text, Number(text.match(/\d+/)[0]) / 300);
  const b = await boxOf(p);
  await page.mouse.click(b.x + b.width - 40, b.y + b.height - 10);
  await page.keyboard.press(LINE_END);
  await page.keyboard.type(add);
}

/** Send what the page holds (with a note so there is always something to send), let `edits` happen as the agent's work, then `done`. */
async function agentRun(w, page, file, poll, edits, summary) {
  await page.locator('[data-testid="overall-note"]').fill("Please tidy this up.");
  await page.waitForTimeout(700);
  await page.locator('[data-testid="send"]').click();
  const res = await Promise.race([poll.done, sleep(20000).then(() => null)]);
  assert.ok(res && res.code === 0, res?.stderr);
  await page.locator('[data-testid="banner-working"]').waitFor();
  for (const e of edits) agentEdit([file, ...e]);
  const rj = w.doc(`r-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(rj, JSON.stringify({ summary, results: [] }));
  assert.equal((await w.cli(["done", file, "--results", rj])).code, 0);
  await page.locator('[data-testid="activity-entry"]').first().waitFor({ timeout: 20000 });
}

describe("History (DOCX)", () => {
  let w, file, page, poll;
  before(async () => {
    w = makeWorld({ ONIONSKIN_NO_SOFFICE: "1" });
    file = w.doc("long.docx");
  });
  after(() => w?.cleanup());

  test("no history yet: one quiet line, and the section is there", async () => {
    poll = w.spawnCli(["poll", file]);
    page = await br.page();
    await page.addInitScript(() => sessionStorage.setItem("onionskin.histCollapsed", "0")); // History starts folded; these tests read it open
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(await w.open(file));
    await waitDoc(page);
    await page.locator('[data-testid="banner-listening"]').waitFor({ timeout: 20000 });
    const sec = page.locator('[data-testid="panel-history"]');
    await sec.waitFor();
    assert.match(await sec.textContent(), /Updates to this file will appear here\./);
    assert.match(await sec.textContent(), /last 20/);
    // it sits above the stack of edits, comments and runs, which hangs from the pinned Overall instructions
    const order = await page.evaluate(() => ["panel-history", "stack-empty"].map((id) => document.querySelector(`[data-testid="${id}"]`).getBoundingClientRect().top));
    assert.ok(order[0] < order[1], JSON.stringify(order));
    assert.ok(await page.evaluate(() => document.querySelector('[data-testid="panel-history"]').closest(".scroll") != null), "inside the scrolling list, above the composer");
  });

  test("a Send with a typed edit, then an agent run (replace, add, bold): two updates, newest first, with counts", async () => {
    await typeInto(page, "Paragraph 003:", " (owner: Dana)");
    await agentRun(w, page, file, poll, [["replace", "short note", "owner note", "Paragraph 005:"], ["insert-before", "Paragraph 007:", "A brand new paragraph the agent added here."], ["bold", "Part 2"]], "Reworded one note, added a paragraph and bolded a heading.");
    await until(async () => (await rows(page).count()) === 2, "two history rows");
    const r = rows(page);
    assert.deepEqual(await r.evaluateAll((els) => els.map((e) => e.dataset.kind)), ["agent", "user"]);
    assert.match(await r.nth(0).textContent(), /Agent run/);
    assert.equal((await r.nth(0).locator('[data-testid="history-count"]').textContent()).trim(), "3 places");
    assert.match(await r.nth(1).textContent(), /Your edits/);
    assert.equal((await r.nth(1).locator('[data-testid="history-count"]').textContent()).trim(), "1 place");
    // each row is one line and the time is a real time (today: HH:MM)
    assert.match((await r.nth(0).locator(".h-time").textContent()).trim(), /^\d\d:\d\d$/);
    for (const i of [0, 1]) assert.ok((await r.nth(i).boundingBox()).height <= 40, "one line");
    assert.equal(await page.locator('[data-testid="history-body"]').count(), 0, "all collapsed");
  });

  test("What changed: one press fills a read-only box with the changed words; Copy says Copied or shows the fallback line; the file is untouched", async () => {
    const disk = sha(file);
    const btn = page.locator('[data-testid="change-note-button"]');
    await btn.click();
    const box = page.locator('[data-testid="change-note-text"]');
    await box.waitFor({ timeout: 15000 });
    const text = await box.inputValue();
    assert.match(text, /^What changed in long\.docx since [A-Z][a-z]{2} \d{1,2}, \d\d:\d\d\n\n1\. /);
    assert.match(text, /Was: .*short.*\n   Now: .*owner note/);
    assert.match(text, /owner: Dana/);
    assert.match(text, /Added paragraph\n   Now: A brand new paragraph the agent added here\./);
    assert.match(text, /Formatting changed: bold/);
    assert.equal(await box.getAttribute("readonly"), "");
    assert.match(await page.locator('[data-testid="change-note"]').textContent(), /A note you can paste into an email/);
    // Copy is a second click on a note that is already on screen. The clipboard may be blocked in the test browser: either line is right.
    const copy = page.locator('[data-testid="change-note-copy"]');
    await copy.click();
    await until(async () => /Copied|Select the text and press Cmd\+C\./.test(await page.locator('[data-testid="change-note"]').textContent()), "Copied or the fallback line");
    // the box never overflows the panel
    const m = await page.evaluate(() => {
      const sb = document.querySelector('[data-testid="sidebar"]');
      return { sbScroll: sb.scrollWidth, sbClient: sb.clientWidth, over: [...sb.querySelectorAll(".cn-box, .cn-box *")].filter((e) => e.getBoundingClientRect().right > sb.getBoundingClientRect().right + 0.5).length };
    });
    assert.equal(m.sbScroll, m.sbClient);
    assert.equal(m.over, 0);
    assert.equal(sha(file), disk, "the file on disk is untouched");
  });

  test("expanding the agent run: summary, red and green words, Added paragraph, Formatting changed; only one open at a time", async () => {
    const r = rows(page);
    await r.nth(0).click();
    const body = page.locator('[data-testid="history-body"]');
    await body.waitFor();
    assert.equal(await r.nth(0).getAttribute("aria-expanded"), "true");
    const places = body.locator('[data-testid="history-place"]');
    await until(async () => (await places.count()) === 3, "three places");
    assert.match(await body.textContent(), /Reworded one note, added a paragraph and bolded a heading\./);
    const diff = body.locator('[data-testid="history-diff"]');
    assert.match(await diff.locator("del").first().textContent(), /short/);
    assert.match(await diff.locator("ins").first().textContent(), /owner/);
    // not color alone: strikethrough on removed words, underline on added ones
    const deco = await diff.evaluate((el) => [getComputedStyle(el.querySelector("del")).textDecorationLine, getComputedStyle(el.querySelector("ins")).textDecorationLine]);
    assert.deepEqual(deco, ["line-through", "underline"]);
    const lines = (await body.locator('[data-testid="history-line"]').allTextContents()).map((t) => t.trim());
    assert.ok(lines.includes("Added paragraph"), lines.join(" | "));
    assert.ok(lines.some((l) => /^Formatting changed: bold$/.test(l)), lines.join(" | "));
    assert.equal(await body.locator('[data-testid="history-show"]').count(), 3, "every place of the newest update can be shown");
    // only one open: opening the second closes the first
    await r.nth(1).click();
    await until(async () => (await page.locator('[data-testid="history-body"]').count()) === 1, "one body");
    assert.equal(await r.nth(0).getAttribute("aria-expanded"), "false");
    assert.equal(await r.nth(1).getAttribute("aria-expanded"), "true");
    const user = page.locator('[data-testid="history-body"] [data-testid="history-diff"]');
    await user.waitFor();
    assert.match(await user.locator("ins").first().textContent(), /owner: Dana/);
    await r.nth(0).click();
    await page.locator('[data-testid="history-body"] [data-testid="history-place"]').nth(2).waitFor();
  });

  test("Show scrolls and outlines the place, never touching document text; no ins or del and no red or green in the document", async () => {
    const before = sha(file);
    const textOf = (probe) => page.evaluate((probe) => Object.fromEntries([...document.querySelectorAll(`[data-testid="docwrap"] .de-p[data-bi]`)].filter((e) => probe(e.textContent)).map((e) => [e.dataset.bi, e.textContent])), null).catch(() => ({}));
    void textOf;
    const snap = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-testid="docwrap"] .de-p[data-bi]')].map((e) => [e.dataset.bi, e.textContent])));
    // put the replaced paragraph on screen, remember what is rendered, then go far away and use Show to come back
    const target = await scrollToPara(page, "Paragraph 005:", 5 / 300);
    await target.waitFor();
    const textBefore = await snap();
    await page.evaluate(() => (document.querySelector(".de-scroll").scrollTop = 0));
    await page.waitForTimeout(500);
    const place = page.locator('[data-testid="history-body"] [data-testid="history-place"]', { hasText: "Paragraph 005" }).first();
    await place.locator('[data-testid="history-show"]').click();
    const outline = page.locator('[data-testid="show-outline"]');
    await outline.first().waitFor({ timeout: 5000 });
    // the engine scrolls smoothly and the outline follows: once it settles the outline sits on the paragraph
    await until(async () => {
      const ob = await outline.first().boundingBox();
      const tb = await para(page, "Paragraph 005:").boundingBox();
      return ob && tb && Math.abs(ob.y - tb.y) < 30 && ob.height >= tb.height - 6;
    }, "the outline to sit on the paragraph", 1800);
    const dw = page.locator('[data-testid="docwrap"]');
    assert.equal(await dw.locator("ins, del, mark").count(), 0, "no ins or del in the document area");
    const textAfter = await snap();
    for (const k of Object.keys(textBefore)) if (k in textAfter) assert.equal(textAfter[k], textBefore[k], `paragraph ${k} unchanged`);
    assert.ok(Object.keys(textBefore).filter((k) => k in textAfter).length > 3, "compared more than a couple of paragraphs");
    const col = await outline.first().evaluate((el) => getComputedStyle(el).boxShadow);
    assert.doesNotMatch(col, /rgb\(\s*(1[6-9]\d|2\d\d),\s*\d{1,2},\s*\d{1,2}\)/, "not red");
    await until(async () => (await page.locator('[data-testid="show-outline"]').count()) === 0, "the outline to go away after about two seconds", 6000);
    assert.equal(sha(file), before, "the file on disk is untouched");
    // the red and green are not in the document at any time: scan every element of the document for a red or green fill
    const marks = await dw.evaluate((root) => {
      const bad = [];
      for (const el of root.querySelectorAll("*")) {
        const cs = getComputedStyle(el);
        for (const c of [cs.backgroundColor, cs.textDecorationColor]) {
          const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(c);
          if (!m || (m[4] != null && Number(m[4]) === 0)) continue;
          const [r, g, b] = [m[1], m[2], m[3]].map(Number);
          if ((r > 150 && g < 90 && b < 90) || (g > 120 && r < 90 && b < 120 && g - r > 60)) bad.push(el.className);
        }
      }
      return bad;
    });
    assert.deepEqual(marks, [], "no red or green fills in the document");
  });

  test("keyboard: Down and Up move between rows, Enter and Space toggle", async () => {
    const r = rows(page);
    await r.nth(0).focus();
    await page.keyboard.press("ArrowDown");
    assert.ok(await r.nth(1).evaluate((e) => e === document.activeElement), "Down moves to the next row");
    await page.keyboard.press("ArrowUp");
    assert.ok(await r.nth(0).evaluate((e) => e === document.activeElement), "Up moves back");
    const was = await r.nth(0).getAttribute("aria-expanded");
    await page.keyboard.press("Enter");
    assert.notEqual(await r.nth(0).getAttribute("aria-expanded"), was);
    await page.keyboard.press("Space");
    assert.equal(await r.nth(0).getAttribute("aria-expanded"), was);
  });

  test("the section collapses and remembers it for the session", async () => {
    const btn = page.locator('[data-testid="history-collapse"]');
    await btn.click();
    assert.equal(await btn.getAttribute("aria-expanded"), "false");
    assert.equal(await rows(page).first().isVisible(), false);
    assert.equal(await page.evaluate(() => sessionStorage.getItem("onionskin.histCollapsed")), "1");
    await btn.click();
    assert.equal(await rows(page).first().isVisible(), true);
  });

  test("the panel never scrolls sideways at 320, 372 and 520 px, and every row stays on one line with its time showing", async () => {
    for (const width of [320, 372, 520]) {
      await page.evaluate((w) => sessionStorage.setItem("onionskin.sideW", String(w)), width);
      await page.reload();
      await waitDoc(page);
      await rows(page).first().waitFor({ timeout: 15000 });
      await rows(page).nth(0).click();
      await page.locator('[data-testid="history-place"]').nth(2).waitFor();
      const m = await page.evaluate(() => {
        const sb = document.querySelector('[data-testid="sidebar"]');
        const sc = sb.querySelector(".scroll");
        const rs = [...sb.querySelectorAll(".h-row")].map((r) => ({ h: r.getBoundingClientRect().height, wide: r.scrollWidth > r.clientWidth + 1, time: r.querySelector(".h-time").scrollWidth <= r.querySelector(".h-time").clientWidth + 1, tr: r.querySelector(".h-time").getBoundingClientRect().right <= r.getBoundingClientRect().right + 0.5 }));
        const wideInside = [...sb.querySelectorAll(".h-body *")].filter((e) => e.getBoundingClientRect().right > sb.getBoundingClientRect().right + 0.5).length;
        return { sbw: sb.getBoundingClientRect().width, scrollW: sc.scrollWidth, clientW: sc.clientWidth, sbScroll: sb.scrollWidth, sbClient: sb.clientWidth, rs, wideInside };
      });
      assert.ok(Math.abs(m.sbw - width) < 2, `sidebar is ${width} wide, got ${m.sbw}`);
      assert.equal(m.scrollW, m.clientW, `no horizontal scroll in the list at ${width}`);
      assert.equal(m.sbScroll, m.sbClient, `no horizontal scroll in the panel at ${width}`);
      assert.equal(m.wideInside, 0, `nothing in the open update sticks out at ${width}`);
      for (const row of m.rs) assert.ok(row.h <= 40 && row.time && row.tr, `row fits at ${width}: ${JSON.stringify(row)}`);
    }
  });

  test("the phone layout does not have the section", async () => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.waitForTimeout(600);
    assert.equal(await page.locator('[data-testid="panel-history"]').count(), 0);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(600);
    assert.equal(await page.locator('[data-testid="panel-history"]').count(), 1);
  });

  test("an outside change that is reloaded appears as a Changed outside entry that expands like the others", async () => {
    // the session is idle (the agent run is done): someone else saves the file, the user takes it
    agentEdit([file, "replace", "short note", "EXTERNAL-NOTE", "Paragraph 012:"]);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.locator('[data-testid="banner-outside"]').waitFor({ timeout: 10000 });
    const before = await rows(page).count();
    await page.locator('[data-testid="reload-disk-early"]').click();
    await until(async () => (await rows(page).count()) === before + 1, "the outside entry");
    const first = rows(page).first();
    assert.equal(await first.getAttribute("data-kind"), "outside");
    assert.match(await first.textContent(), /Changed outside/);
    assert.equal((await first.locator('[data-testid="history-count"]').textContent()).trim(), "1 place");
    await first.click();
    const d = page.locator('[data-testid="history-body"] [data-testid="history-diff"]');
    await d.waitFor();
    assert.match(await d.locator("ins").first().textContent(), /EXTERNAL-NOTE/);
  });

  test("zero CSP violations and page errors", () => {
    assert.deepEqual(cspViolations(br.log), []);
    assert.deepEqual(br.log.errors, []);
  });
});

describe("History (XLSX and PPTX)", () => {
  let w;
  before(() => {
    w = makeWorld({ ONIONSKIN_NO_SOFFICE: "1" });
  });
  after(() => w?.cleanup());

  test("XLSX: a changed cell reads old to new", async () => {
    const file = w.doc("budget.xlsx");
    const poll = w.spawnCli(["poll", file]);
    const page = await br.page();
    await page.addInitScript(() => sessionStorage.setItem("onionskin.histCollapsed", "0")); // History starts folded; these tests read it open
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(await w.open(file));
    await waitDoc(page, ".de-sheet, .de-grid");
    await page.locator('[data-testid="banner-listening"]').waitFor({ timeout: 20000 });
    await agentRun(w, page, file, poll, [["xlsx-set", "Budget", "C3", "999"]], "Raised one figure.");
    await rows(page).first().click();
    const cell = page.locator('[data-testid="history-cell"]').first();
    await cell.waitFor({ timeout: 10000 });
    const t = (await cell.textContent()).replace(/\s+/g, " ");
    assert.match(t, /120/);
    assert.match(t, /999/);
    assert.match(await page.locator('[data-testid="history-place"]').first().textContent(), /Budget!C3/);
    assert.equal(await cell.locator("del").count(), 1);
    assert.equal(await cell.locator("ins").count(), 1);
    await page.close();
  });

  test("PPTX: a shape's text change is a word diff", async () => {
    const file = w.doc("deck.pptx");
    const poll = w.spawnCli(["poll", file]);
    const page = await br.page();
    await page.addInitScript(() => sessionStorage.setItem("onionskin.histCollapsed", "0")); // History starts folded; these tests read it open
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(await w.open(file));
    await waitDoc(page, ".de-slide");
    await page.locator('[data-testid="banner-listening"]').waitFor({ timeout: 20000 });
    await agentRun(w, page, file, poll, [["pptx-set-text", "0", "Content", "Welcome and plan for the planning review"]], "Changed the agenda line.");
    await rows(page).first().click();
    const d = page.locator('[data-testid="history-diff"]').first();
    await d.waitFor({ timeout: 10000 });
    assert.match(await d.locator("del").first().textContent(), /agenda/);
    assert.match(await d.locator("ins").first().textContent(), /plan/);
    assert.match(await page.locator('[data-testid="history-place"]').first().textContent(), /Slide 1/);
    await page.close();
  });

  test("zero CSP violations and page errors", () => {
    assert.deepEqual(cspViolations(br.log), []);
    assert.deepEqual(br.log.errors, []);
  });
});

describe("a run whose comment was deleted", () => {
  let w;
  before(() => {
    w = makeWorld({ ONIONSKIN_NO_SOFFICE: "1" });
  });
  after(() => w?.cleanup());

  test("the run's list says plainly that the comment was deleted by the person", async () => {
    const file = w.doc("long.docx");
    const poll = w.spawnCli(["poll", file]);
    const page = await br.page();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(await w.open(file));
    await waitDoc(page);
    await page.locator('[data-testid="banner-listening"]').waitFor({ timeout: 20000 });
    const p = await scrollToPara(page, "Paragraph 010:", 10 / 300);
    const b = await boxOf(p);
    await page.mouse.dblclick(b.x + 150, b.y + 12);
    await page.locator('[data-testid="comment-chip"]').click();
    await page.keyboard.type("Make this clearer");
    await page.locator('[data-testid="send"]').click();
    const res = await Promise.race([poll.done, sleep(20000).then(() => null)]);
    assert.ok(res && res.code === 0, res?.stderr);
    const id = JSON.parse(res.stdout).instructions.comments[0].id;
    agentEdit([file, "replace", "regional leads", "regional managers", "Paragraph 010:"]);
    const rj = w.doc("r-deleted.json");
    fs.writeFileSync(rj, JSON.stringify({ summary: "Rewrote it.", results: [{ comment_id: id, status: "done", note: "Rewritten." }] }));
    assert.equal((await w.cli(["done", file, "--results", rj])).code, 0);
    await page.locator('[data-testid="activity-entry"]').first().waitFor({ timeout: 20000 });
    await page.locator('[data-testid="delete-comment"]').first().click();
    await until(async () => (await page.locator('[data-testid="comment-card"]').count()) === 0, "the card to go");
    const run = page.locator('[data-testid="activity-entry"]').first();
    if ((await run.getAttribute("data-open")) !== "1") await run.locator('[data-testid="run-fold"]').click();
    const line = run.locator('[data-testid="activity-result"]');
    await line.waitFor();
    const text = (await line.innerText()).replace(/\s+/g, " ");
    assert.ok(text.includes("A comment you deleted"), `the line reads: ${text}`);
    assert.ok(text.includes("Rewritten."), "and keeps the agent's note");
  });
});
