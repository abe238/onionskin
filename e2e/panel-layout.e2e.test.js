import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium } from "playwright-core";
import { boxOf, cspViolations, launch, makeWorld, para, python, scrollToPara, until, waitDoc } from "./helpers/harness.mjs";

// The review panel's own scroll area: a new question is brought into view, nothing squeezes the card stack, and the document is never scrolled by the panel.
const q = (id) => `[data-testid="${id}"]`;

describe("review panel layout on a phone (390 x 844)", () => {
  let w, ctx, prof;
  before(async () => {
    w = makeWorld({ ONIONSKIN_NO_SOFFICE: "1" });
    prof = fs.mkdtempSync(path.join(os.tmpdir(), "da-pl-"));
    ctx = await chromium.launchPersistentContext(prof, { channel: "chrome", headless: true, hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
  });
  after(async () => {
    await ctx?.close();
    fs.rmSync(prof, { recursive: true, force: true });
    await w?.cleanup();
  });

  /** Comment, send, and let the agent ask. Returns the page. */
  const asked = async (name, closed = false) => {
    const file = w.doc(name);
    fs.copyFileSync(w.doc("long.docx"), file);
    const poll = w.spawnCli(["poll", file]);
    const page = await ctx.newPage();
    await page.goto(await w.open(file));
    await waitDoc(page);
    await page.locator(q("banner-listening")).waitFor({ timeout: 20000 });
    await page.waitForTimeout(1200);
    await page.locator(q("mode-comment")).tap();
    await para(page, "Paragraph 005:").scrollIntoViewIfNeeded();
    await page.waitForTimeout(250);
    const b = await boxOf(para(page, "Paragraph 005:"));
    await page.touchscreen.tap(b.x + 60, b.y + 12);
    await page.locator(`${q("comment-card")} textarea`).last().fill("Change the wording here.");
    await page.waitForTimeout(700);
    await page.locator(q("send")).tap();
    const res = await Promise.race([poll.done, new Promise((r) => setTimeout(() => r(null), 25000))]);
    assert.ok(res && res.code === 0, "poll returned after Send");
    const batch = JSON.parse(res.stdout);
    if (closed) {
      await page.keyboard.press("Escape"); // shut the sheet: the question arrives while nobody is looking
      await page.waitForFunction(() => document.querySelector('[data-testid="sidebar-toggle"]')?.getAttribute("aria-expanded") === "false", null, { timeout: 5000 });
    }
    const r = await w.cli(["reply", file, "--lease", batch.lease_ticket, "--json", JSON.stringify({ replies: [{ comment: batch.instructions.comments[0].id, ask: "Which word should replace short?", options: ["brief", "concise", "quick"] }] })]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    await page.locator(`${q("comment-card")}[data-status="asked"]`).waitFor({ state: "attached", timeout: 20000 });
    if (closed) await page.locator(q("sidebar-toggle")).tap();
    await page.locator(q("sheet-grab")).waitFor({ timeout: 5000 }); // the sheet opened for the comment and stays open
    await page.waitForTimeout(1500); // the panel's smooth scroll settles
    return page;
  };
  /** Where the question block sits against the panel's own scroll area, and whether the document moved. */
  const where = (page) =>
    page.evaluate(() => {
      const box = document.querySelector('[data-testid="sidebar"] .scroll').getBoundingClientRect();
      const head = document.querySelector('[data-testid="question"] .q-head').getBoundingClientRect();
      const doc = document.querySelector(".de-scroll");
      return { headTop: head.top - box.top, boxH: box.height, winY: scrollY, docTop: doc ? doc.scrollTop : 0 };
    });

  for (const closed of [false, true])
  test(`a new question shows its heading at the top of the panel (sheet ${closed ? "shut when it arrived" : "open"}); the document does not move`, async () => {
    const page = await asked(closed ? "ph-shut.docx" : "ph.docx", closed);
    const m = await where(page);
    assert.ok(m.headTop >= -1 && m.headTop < 60, `"The agent asks" is at the top of the panel's scroll area (${Math.round(m.headTop)} px from its top)`);
    assert.equal(m.winY, 0, "the page itself did not scroll");
    await page.close();
  });
});

describe("Writing preferences open (desktop)", () => {
  let w, br;
  before(async () => {
    w = makeWorld({ ONIONSKIN_NO_SOFFICE: "1" });
    br = await launch();
  });
  after(async () => {
    await br?.close();
    await w?.cleanup();
  });

  for (const [width, height] of [[1440, 900], [1100, 700], [1100, 560]])
    test(`at ${width}x${height} the card stack keeps 160 px and the preferences scroll inside themselves`, async () => {
      const file = w.doc(`prefs-${width}.docx`);
      fs.copyFileSync(w.doc("long.docx"), file);
      const page = await br.page();
      await page.setViewportSize({ width, height });
      await page.goto(await w.open(file));
      await waitDoc(page);
      for (const n of [10, 20, 30, 40, 50, 60]) {
        // a long stack: the panel must hold its height however much is in it
        const b = await boxOf(await scrollToPara(page, `Paragraph 0${n}:`, n / 300));
        await page.mouse.dblclick(b.x + 150, b.y + 12);
        await page.locator(q("comment-chip")).click();
        await page.locator(`${q("comment-card")} textarea`).last().fill(`Change paragraph ${n}.`);
      }
      await page.locator(q("style-change")).click();
      await page.locator(q("style-trait-short")).click();
      for (const t of ["plain", "formal", "minimal", "format"]) await page.locator(q(`style-trait-${t}`)).click(); // the longest summary line
      await page.locator(q("style-words")).fill("Use US spelling. No jargon.");
      await page.waitForTimeout(400);
      const m = await page.evaluate(() => {
        const r = (sel) => document.querySelector(sel).getBoundingClientRect();
        const side = r('[data-testid="sidebar"]');
        const panel = document.querySelector('[data-testid="style-panel"]');
        return { stack: document.querySelector('[data-testid="sidebar"] .scroll').clientHeight, sideBottom: side.bottom, sendBottom: r('[data-testid="send"]').bottom, sendTop: r('[data-testid="send"]').top, done: r('[data-testid="style-done"]'), panelBottom: panel.getBoundingClientRect().bottom, vh: innerHeight };
      });
      assert.ok(m.stack >= 160, `the card stack is ${m.stack} px tall (needs 160)`);
      assert.ok(m.sendBottom <= m.sideBottom && m.sendBottom <= m.vh, "the Send button stays inside the panel and the screen");
      assert.ok(m.panelBottom <= m.sendTop, "the preferences end above the Send button");
      await page.locator(q("style-done")).scrollIntoViewIfNeeded();
      const d = await boxOf(page.locator(q("style-done")));
      assert.ok(d.y >= 0 && d.y + d.height <= m.vh, "Done is reachable on the screen");
      await page.close();
    });
});

describe("a run that needs a look (DOCX, 1100 x 700): the Revert offer is brought above the composer", () => {
  let w, br;
  before(async () => {
    w = makeWorld({ ONIONSKIN_PYTHON: python });
    const stub = path.join(w.root, "soffice-stub.sh"); // converts the original, fails the agent's version: an error flag and a Revert offer
    fs.writeFileSync(stub, `#!/bin/sh
out=""; prev=""; last=""
for a in "$@"; do [ "$prev" = "--outdir" ] && out="$a"; prev="$a"; last="$a"; done
case "$last" in *before*) printf PDF > "$out/before.pdf" ;; esac
`, { mode: 0o755 });
    w.env.ONIONSKIN_SOFFICE = stub;
    delete w.env.ONIONSKIN_NO_SOFFICE;
    br = await launch();
  });
  after(async () => {
    await br?.close();
    await w?.cleanup();
  });

  test("the Revert button sits fully inside the panel's scroll area, above the composer; the page does not scroll", async () => {
    const file = w.doc("revert-view.docx");
    fs.copyFileSync(w.doc("long.docx"), file);
    const poll = w.spawnCli(["poll", file]);
    const page = await br.page();
    await page.setViewportSize({ width: 1100, height: 700 });
    await page.goto(await w.open(file));
    await waitDoc(page);
    await page.locator(q("banner-listening")).waitFor({ timeout: 20000 });
    const b = await boxOf(await scrollToPara(page, "Paragraph 050:", 0.17));
    await page.mouse.dblclick(b.x + 150, b.y + 12);
    await page.locator(q("comment-chip")).click();
    await page.locator(`${q("comment-card")} textarea`).last().fill("Say 'brief note' instead of 'short note'.");
    await page.waitForTimeout(700);
    await page.locator(q("send")).click();
    const batch = JSON.parse((await poll.done).stdout);
    const r = await w.cli(["reply", file, "--lease", batch.lease_ticket, "--json", JSON.stringify({ summary: "Brief note.", replies: [{ comment: batch.instructions.comments[0].id, find: "short note", replace: "brief note", note: "Reworded." }] })]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    await page.locator('[data-testid="check-revert"] [data-testid="revert"]').waitFor({ timeout: 25000 });
    await until(async () => page.evaluate(() => {
      const bt = document.querySelector('[data-testid="check-revert"] [data-testid="revert"]').getBoundingClientRect();
      const sc = document.querySelector(".sidebar .scroll").getBoundingClientRect();
      const comp = document.querySelector(".composer").getBoundingClientRect();
      return bt.top >= sc.top && bt.bottom <= sc.bottom - 4 && bt.bottom <= comp.top;
    }), "the Revert button fully visible above the composer");
    assert.equal(await page.evaluate(() => scrollY), 0, "the page itself did not scroll");
    assert.deepEqual(cspViolations(br.log), []);
    await page.close();
  });
});
