import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, describe, test } from "node:test";
import { agentEdit, boxOf, center, launch, makeWorld, openSheet, scrollToPara, until, waitDoc, xlsxCell } from "./helpers/harness.mjs";

const MAC = process.platform === "darwin";
const MODK = MAC ? "Meta" : "Control";
const q = (id) => `[data-testid="${id}"]`;

const lin = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const lum = (r, g, b) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const contrastRatio = (c1, c2) => {
  const l1 = lum(c1.r, c1.g, c1.b);
  const l2 = lum(c2.r, c2.g, c2.b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
};
const parseRgb = (s) => {
  const m = s.match(/rgba?\(([^)]+)\)/);
  assert.ok(m, `expected rgb() color, got ${s}`);
  const [r, g, b] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
  return { r, g, b };
};

let br;
before(async () => {
  br = await launch();
});
after(async () => {
  await br?.close();
});

async function openDoc(name, { width = 1440, height = 900 } = {}) {
  const w = makeWorld();
  const file = w.doc(name);
  fs.copyFileSync(w.doc("long.docx"), file);
  const page = await br.page();
  await page.setViewportSize({ width, height });
  await page.goto(await w.open(file));
  await waitDoc(page);
  return {
    w,
    file,
    page,
    async end() {
      await page.close();
      await w.cleanup();
    },
  };
}

const poll = async (p) => {
  const res = await Promise.race([p.done, new Promise((r) => setTimeout(() => r(null), 25000))]);
  assert.ok(res && res.code === 0, res?.stderr || "poll timed out");
  return JSON.parse(res.stdout);
};

async function selectWord(page, para, dx = 150) {
  const p = await scrollToPara(page, para, Number(para.match(/\d+/)[0]) / 300);
  const b = await boxOf(p);
  await page.mouse.dblclick(b.x + dx, b.y + 12);
  await page.locator(q("comment-chip")).waitFor({ timeout: 5000 });
}

describe("Audit regression & UX fixes (browser)", () => {
  test("R4a & R4b: narrow drawer (1000x800) supports Cmd/Ctrl+\\, F6, and Esc inside a comment box returns focus to document", async () => {
    const t = await openDoc("narrow-drawer.docx", { width: 1000, height: 800 });
    try {
      const { page } = t;
      // Add a comment -> opens the narrow drawer (role="dialog") with focus in the comment textarea
      await selectWord(page, "Paragraph 015:");
      await page.locator(q("comment-chip")).click();
      const side = page.locator(q("sidebar"));
      await until(async () => (await side.getAttribute("class")).includes("open"), "drawer to open");
      assert.equal(await side.getAttribute("role"), "dialog");

      const ta = page.locator(`${q("comment-card")} textarea`).first();
      await ta.waitFor({ timeout: 3000 });
      await ta.fill("Keep this comment");

      // R4b: Esc inside a comment box returns focus to the document and keeps the drawer & text intact
      await page.keyboard.press("Escape");
      await until(async () => page.evaluate(() => !!document.activeElement?.closest('[data-testid="docwrap"]')), "focus to return to document");
      assert.equal((await side.getAttribute("class")).includes("open"), true, "drawer stayed open when Esc returned focus to document");
      assert.equal(await ta.inputValue(), "Keep this comment");

      // R4a: With focus inside the narrow drawer, F6 cycles focus out of the drawer
      await page.locator(q("overall-note")).focus();
      assert.equal(await page.evaluate(() => !!document.activeElement?.closest("#review-panel")), true);
      await page.keyboard.press("F6");
      await until(async () => page.evaluate(() => !document.activeElement?.closest("#review-panel")), "F6 to leave drawer");

      // R4a: With focus inside the narrow drawer, Cmd/Ctrl+\ closes the drawer
      await page.locator(q("overall-note")).focus();
      assert.equal(await page.evaluate(() => !!document.activeElement?.closest("#review-panel")), true);
      await page.keyboard.press(`${MODK}+Backslash`);
      await until(async () => (await side.getAttribute("class")).includes("shut"), "Cmd/Ctrl+\\ to close drawer");
    } finally {
      await t.end();
    }
  });

  test("R4c, UX-01, UX-07, R11: QuickAsk z-index layering, close keeps draft, send submits, and Stamps Cancel discards edits", async () => {
    const t = await openDoc("quick-stamps.docx", { width: 1000, height: 800 });
    try {
      const { page, w, file } = t;
      const p = w.spawnCli(["poll", file]);
      await page.locator(q("banner-listening")).waitFor({ timeout: 20000 });

      // Open QuickAsk via chip
      await selectWord(page, "Paragraph 018:");
      await page.locator(q("quick-ask-chip")).click();
      await page.locator(q("quick-ask")).waitFor({ timeout: 3000 });

      // R4c: .overlay:has(.qa) z-index must be strictly above .banners (40) and strictly below .drawer-scrim (50) and .sidebar.drawer (52),
      // verified with both computed z-index and real elementFromPoint hit tests
      const z = await page.evaluate(() => {
        const overlayZ = Number(getComputedStyle(document.querySelector(".overlay")).zIndex);
        const bannerZ = Number(getComputedStyle(document.querySelector(".banners")).zIndex);
        const drawerZ = Number(getComputedStyle(document.querySelector(".sidebar.drawer")).zIndex);
        const qa = document.querySelector('[data-testid="quick-ask"]');
        const r = qa.getBoundingClientRect();
        const hitQa = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return { overlayZ, bannerZ, drawerZ, hitInQa: !!hitQa?.closest('[data-testid="quick-ask"]') };
      });
      assert.ok(z.overlayZ > z.bannerZ, `overlay z-index (${z.overlayZ}) > banners (${z.bannerZ})`);
      assert.ok(z.overlayZ < 50 && z.overlayZ < z.drawerZ, `overlay z-index (${z.overlayZ}) < scrim (50) & drawer (${z.drawerZ})`);
      assert.equal(z.hitInQa, true, "elementFromPoint hits QuickAsk above page & banners");

      // UX-07: Stamps edit + Cancel discards unsaved stamp
      await page.locator(q("stamp-edit")).click();
      await page.locator(q("stamps-edit")).waitFor({ timeout: 3000 });
      await page.locator(q("stamp-add")).click();
      await page.locator(q("stamp-name")).last().fill("TempStamp");
      await page.locator(q("stamp-words")).last().fill("Discard me");
      await page.locator(q("stamp-cancel")).click();
      await page.locator(q("stamps-edit")).waitFor({ state: "detached", timeout: 3000 });
      const stampTexts = await page.locator(q("stamp")).allTextContents();
      assert.equal(stampTexts.includes("TempStamp"), false, "unsaved stamp was discarded by Cancel");

      // QuickAsk Esc cancels without creating a comment (preserving fastloop.e2e.test.js contract)
      await page.locator(q("quick-ask-text")).fill("Cancelled on Escape key");
      await page.keyboard.press("Escape");
      await page.locator(q("quick-ask")).waitFor({ state: "detached", timeout: 3000 });
      assert.equal(await page.locator(q("comment-card")).count(), 0, "Esc cancels QuickAsk without making a comment");

      // R11 / UX-01: quick-ask-close (x) closes QuickAsk and keeps typed text as an unsent comment
      await selectWord(page, "Paragraph 018:");
      await page.locator(q("quick-ask-chip")).click();
      await page.locator(q("quick-ask")).waitFor({ timeout: 3000 });
      await page.locator(q("quick-ask-text")).fill("Saved on close button");
      await page.locator(q("quick-ask-close")).click();
      await page.locator(q("quick-ask")).waitFor({ state: "detached", timeout: 3000 });
      assert.equal(await page.locator(q("comment-card")).count(), 1, "typed words kept as draft comment on x");
      assert.equal(await page.locator(`${q("comment-card")} textarea`).first().inputValue(), "Saved on close button");

      // UX-01: quick-ask-send submits the comment
      await selectWord(page, "Paragraph 019:");
      await page.locator(q("quick-ask-chip")).click();
      await page.locator(q("quick-ask")).waitFor({ timeout: 3000 });
      await page.locator(q("quick-ask-text")).fill("Sent via Send button");
      await page.locator(q("quick-ask-send")).click();
      await page.locator(q("quick-ask")).waitFor({ state: "detached", timeout: 3000 });
      const batch = await poll(p);
      assert.ok(batch.instructions.comments.some((c) => c.text === "Sent via Send button"), "quick-ask-send delivered the comment");
    } finally {
      await t.end();
    }
  });

  test("UX-08, UX-09, FE-02, FE-08, R11: ChangeNote close, Shortcuts close, Pin opens collapsed sidebar, dark done badge contrast, and StylePrefs rapid double-toggle", async () => {
    const t = await openDoc("ux-fe-checks.docx", { width: 1440, height: 900 });
    try {
      const { page, w, file } = t;

      // UX-09: Shortcuts popover opens and shortcuts-close closes it
      await page.locator(q("shortcuts-button")).click();
      await page.locator(q("shortcuts")).waitFor({ timeout: 3000 });
      await page.locator(q("shortcuts-close")).click();
      await page.locator(q("shortcuts")).waitFor({ state: "detached", timeout: 3000 });

      // R11: StylePrefs rapid double-toggle preserves both chips
      await page.locator(q("style-change")).click();
      await page.locator(q("style-panel")).waitFor({ timeout: 3000 });
      const chipA = page.locator(q("style-trait-short"));
      const chipB = page.locator(q("style-trait-plain"));
      // Fire both clicks back-to-back in the same tick before the first POST can resolve
      await page.evaluate(() => {
        document.querySelector('[data-testid="style-trait-short"]').click();
        document.querySelector('[data-testid="style-trait-plain"]').click();
      });
      await until(
        async () => (await chipA.getAttribute("aria-pressed")) === "true" && (await chipB.getAttribute("aria-pressed")) === "true",
        "both chips pressed"
      );
      await page.locator(q("style-done")).click();
      await page.locator(q("style-panel")).waitFor({ state: "detached", timeout: 3000 });
      // Reload page to verify the server persisted BOTH traits
      await page.reload();
      await waitDoc(page);
      const summary = await page.locator(q("style-summary")).textContent();
      assert.match(summary, /Keep it short/i);
      assert.match(summary, /Plain words/i);

      // FE-02: Drop a DOCX pin, collapse sidebar, click pin -> sidebar opens
      await page.locator(q("mode-pin")).click();
      const p10 = await scrollToPara(page, "Paragraph 010:", 10 / 300);
      const b10 = await boxOf(p10);
      await page.mouse.click(b10.x + 80, b10.y + 12);
      await page.locator(".pinmark").first().waitFor({ timeout: 5000 });
      await page.locator(q("sidebar-hide")).click();
      const side = page.locator(q("sidebar"));
      await until(async () => (await side.getAttribute("class")).includes("shut"), "sidebar to collapse");
      await page.locator(".pinmark").first().click();
      await until(async () => (await side.getAttribute("class")).includes("open"), "clicking pin to open collapsed sidebar");

      // Send a comment, have the agent edit the doc and mark comment done -> tests UX-08 (ChangeNote) & FE-08 (dark mode done badge contrast)
      const p2 = w.spawnCli(["poll", file]);
      await page.locator(q("banner-listening")).waitFor({ timeout: 20000 });
      await page.locator(`${q("comment-card")} textarea`).first().fill("Update paragraph 10");
      await page.waitForTimeout(400);
      await page.locator(q("send")).click();
      const batch = await poll(p2);
      const cid = batch.instructions.comments[0].id;

      agentEdit([file, "replace", "regional leads", "regional managers", "Paragraph 010:"]);
      const resultsPath = w.doc("results.json");
      fs.writeFileSync(resultsPath, JSON.stringify({ summary: "Updated paragraph 10.", results: [{ comment_id: cid, status: "done", note: "Done." }] }));
      const doneRes = await w.cli(["done", file, "--results", resultsPath]);
      assert.equal(doneRes.code, 0, doneRes.stderr);

      // UX-08: ChangeNote opens and change-note-close closes it
      const cnBtn = page.locator(q("change-note-button"));
      await cnBtn.waitFor({ timeout: 15000 });
      await cnBtn.click();
      await page.locator(q("change-note")).waitFor({ timeout: 5000 });
      await page.locator(q("change-note-close")).click();
      await page.locator(q("change-note")).waitFor({ state: "detached", timeout: 3000 });

      // FE-08: Dark-mode done badge contrast >= 4.5:1
      if ((await page.locator(q("app")).getAttribute("data-theme-now")) !== "dark") {
        await page.locator(q("theme-toggle")).click();
        await until(async () => (await page.locator(q("app")).getAttribute("data-theme-now")) === "dark", "dark theme");
      }
      const doneNum = page.locator(".card.st-done .num, .pinmark.st-done > span").first();
      await doneNum.waitFor({ timeout: 5000 });
      const colors = await doneNum.evaluate((el) => {
        const cs = getComputedStyle(el);
        return { fg: cs.color, bg: cs.backgroundColor };
      });
      const ratio = contrastRatio(parseRgb(colors.fg), parseRgb(colors.bg));
      assert.ok(ratio >= 4.5, `dark-mode done badge contrast ${ratio.toFixed(2)}:1 must be >= 4.5:1 (${colors.fg} on ${colors.bg})`);
    } finally {
      await t.end();
    }
  });

  test("UX-04: mobile dock Review button, compact overflow menu sync status & shortcuts, zero horizontal overflow at 390px and 360px", async () => {
    const t = await openDoc("ux04-mobile.docx", { width: 390, height: 844 });
    try {
      const { page } = t;
      const noOverflow = () => page.evaluate(() => ({
        doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        body: document.body.scrollWidth - document.body.clientWidth,
      }));
      assert.deepEqual(await noOverflow(), { doc: 0, body: 0 }, "zero horizontal overflow at 390px");

      const reviewBtn = page.locator('.dock [data-testid="sidebar-toggle"]');
      await reviewBtn.waitFor({ timeout: 5000 });
      assert.equal(await reviewBtn.getAttribute("data-mobile-review"), "1");
      assert.equal((await reviewBtn.textContent()).trim(), "Review");
      const rb = await boxOf(reviewBtn);
      assert.ok(rb.height >= 43.5 && rb.width >= 43.5, `mobile Review button touch target ${Math.round(rb.width)}x${Math.round(rb.height)} >= 44px`);

      // Compact overflow menu shows sync status (valid ARIA: no role="status" inside role="menu") and supports arrow-key navigation
      await page.locator(q("more-menu")).click();
      const syncRow = page.locator(q("menu-sync-state"));
      await syncRow.waitFor({ timeout: 3000 });
      assert.equal(await syncRow.getAttribute("role"), "presentation", "menu status row uses role=presentation, not role=status");
      assert.equal(await page.locator('[role="menu"] [role="status"]').count(), 0, "no role=status inside role=menu");
      assert.match((await syncRow.textContent()).trim(), /No unsent edits/);

      // ArrowDown / ArrowUp / Home / End navigate across [role="menuitem"]
      const firstId = await page.evaluate(() => document.activeElement?.dataset?.testid);
      assert.equal(firstId, "shortcuts-menu-item", "opening menu focuses first menuitem");
      await page.keyboard.press("ArrowDown");
      assert.equal(await page.evaluate(() => document.activeElement?.dataset?.testid), "theme-toggle");
      await page.keyboard.press("End");
      assert.equal(await page.evaluate(() => document.activeElement?.dataset?.testid), "close");
      await page.keyboard.press("Home");
      assert.equal(await page.evaluate(() => document.activeElement?.dataset?.testid), "shortcuts-menu-item");
      await page.keyboard.press("ArrowUp");
      assert.equal(await page.evaluate(() => document.activeElement?.dataset?.testid), "close");
      await page.keyboard.press("Home");

      const keysItem = page.locator(q("shortcuts-menu-item"));
      await keysItem.waitFor({ timeout: 3000 });
      await keysItem.click();
      await page.locator(q("shortcuts")).waitFor({ timeout: 3000 });
      await page.locator(q("shortcuts-close")).click();
      await page.locator(q("shortcuts")).waitFor({ state: "detached", timeout: 3000 });

      // UX-05 phone mode-pill hides "Esc for Edit" at 390px
      await page.locator('.dock [data-testid="mode-pin"]').click();
      const mobilePill = page.locator(q("mode-pill"));
      await mobilePill.waitFor({ timeout: 3000 });
      assert.equal(await page.locator(".mode-pill-esc").isVisible(), false, "Esc for Edit hidden on phone width");
      await page.locator('.dock [data-testid="mode-edit"]').click();
      await mobilePill.waitFor({ state: "detached", timeout: 3000 });

      // Mobile Review button opens the Review drawer
      await reviewBtn.click();
      const side = page.locator(q("sidebar"));
      await until(async () => (await side.getAttribute("class")).includes("open"), "mobile review drawer to open");
      assert.deepEqual(await noOverflow(), { doc: 0, body: 0 }, "zero horizontal overflow with drawer open at 390px");
      await page.keyboard.press("Escape");
      await until(async () => (await side.getAttribute("class")).includes("shut"), "mobile review drawer to close");

      // Also verify 360px has zero horizontal overflow
      await page.setViewportSize({ width: 360, height: 740 });
      await page.waitForTimeout(300);
      assert.deepEqual(await noOverflow(), { doc: 0, body: 0 }, "zero horizontal overflow at 360px");
    } finally {
      await t.end();
    }
  });

  test("UX-05: hovering sidebar card highlights document marker, Comment/Pin mode shows mode-pill without shifting doc, and Esc returns to Edit", async () => {
    const t = await openDoc("ux05-hover-mode.docx", { width: 1440, height: 900 });
    try {
      const { page } = t;
      const firstParaY = () => page.evaluate(() => Math.round(document.querySelector(".de-p").getBoundingClientRect().top * 10) / 10);
      const y0 = await firstParaY();

      // Comment mode -> mode-pill shown, zero document y shift, AA contrast in light & dark
      await page.locator(q("mode-comment")).click();
      const pill = page.locator(q("mode-pill"));
      await pill.waitFor({ timeout: 3000 });
      assert.match((await pill.textContent()).trim(), /Comment mode.*Esc for Edit/);
      assert.ok(Math.abs((await firstParaY()) - y0) <= 1, "mode-pill did not shift document y");

      for (const theme of ["light", "dark"]) {
        if ((await page.locator(q("app")).getAttribute("data-theme-now")) !== theme) {
          await page.locator(q("theme-toggle")).click();
          await until(async () => (await page.locator(q("app")).getAttribute("data-theme-now")) === theme, `${theme} theme`);
        }
        const colors = await pill.evaluate((el) => {
          const cs = getComputedStyle(el);
          return { fg: cs.color, bg: cs.backgroundColor };
        });
        const r = contrastRatio(parseRgb(colors.fg), parseRgb(colors.bg));
        assert.ok(r >= 4.5, `mode-pill ${theme} contrast ${r.toFixed(2)}:1 >= 4.5:1`);
      }

      // Esc returns to Edit mode
      await page.keyboard.press("Escape");
      await pill.waitFor({ state: "detached", timeout: 3000 });
      assert.equal(await page.locator(q("mode-edit")).getAttribute("aria-pressed"), "true");

      // Pin mode -> drop a pin, hover sidebar card -> pinmark gets .hovered
      await page.locator(q("mode-pin")).click();
      await pill.waitFor({ timeout: 3000 });
      assert.match((await pill.textContent()).trim(), /Pin mode.*Esc for Edit/);
      const p10 = await scrollToPara(page, "Paragraph 010:", 10 / 300);
      const b10 = await boxOf(p10);
      await page.mouse.click(b10.x + 80, b10.y + 12);
      const pinMark = page.locator(".pinmark").first();
      await pinMark.waitFor({ timeout: 5000 });
      const card = page.locator(q("comment-card")).first();
      await card.locator("textarea").fill("Pin hover test");

      // Bidirectional hover: card -> pinmark AND pinmark -> card AND keyboard focus on card -> pinmark
      await card.hover();
      await until(async () => (await pinMark.getAttribute("class")).includes("hovered"), "pinmark to gain .hovered");
      await page.locator(".topbar").hover();
      await until(async () => !(await pinMark.getAttribute("class")).includes("hovered"), "pinmark to lose .hovered");

      // Reverse hover: pinmark -> card
      await pinMark.hover();
      await until(async () => (await card.getAttribute("class")).includes("hovered"), "card to gain .hovered on marker hover");
      await page.locator(".topbar").hover();
      await until(async () => !(await card.getAttribute("class")).includes("hovered"), "card to lose .hovered");

      // Keyboard focus on card -> pinmark highlights (blur textarea first so focus fires fresh)
      await page.locator(q("mode-pin")).focus();
      await card.locator("textarea").focus();
      await until(async () => (await pinMark.getAttribute("class")).includes("hovered"), "pinmark to gain .hovered on card focus");
      await page.locator(q("mode-pin")).focus();
      await until(async () => !(await pinMark.getAttribute("class")).includes("hovered"), "pinmark to lose .hovered on card blur");

      // Focus topbar (outside textarea) and press Esc -> returns to Edit mode
      await page.keyboard.press("Escape");
      await pill.waitFor({ state: "detached", timeout: 3000 });
      assert.equal(await page.locator(q("mode-edit")).getAttribute("aria-pressed"), "true");
    } finally {
      await t.end();
    }
  });

  test("UX-06: blank draft guard excludes whitespace-only drafts from Send and toggle-resolved collapses/expands all resolved cards", async () => {
    const t = await openDoc("ux06-draft-fold.docx", { width: 1440, height: 900 });
    try {
      const { page, w, file } = t;
      // Create an empty draft comment
      await selectWord(page, "Paragraph 012:");
      await page.locator(q("comment-chip")).click();
      const card1 = page.locator(q("comment-card")).first();
      await card1.waitFor({ timeout: 5000 });
      await card1.locator(q("empty-draft-hint")).waitFor({ timeout: 3000 });
      assert.equal(await page.locator(q("send")).isDisabled(), true, "empty draft keeps Send disabled");

      // Whitespace-only draft still keeps Send disabled
      await card1.locator("textarea").fill("   \n  ");
      assert.equal(await page.locator(q("send")).isDisabled(), true, "whitespace-only draft keeps Send disabled");

      // Typing real text enables Send and hides empty-draft-hint
      await card1.locator("textarea").fill("First real comment.");
      await card1.locator(q("empty-draft-hint")).waitFor({ state: "detached", timeout: 3000 });
      assert.equal(await page.locator(q("send")).isDisabled(), false, "non-empty draft enables Send");

      // Add a second comment and resolve both via agent
      await selectWord(page, "Paragraph 016:");
      await page.locator(q("comment-chip")).click();
      await page.locator(`${q("comment-card")} textarea`).nth(1).fill("Second real comment.");

      const p = w.spawnCli(["poll", file]);
      await page.locator(q("banner-listening")).waitFor({ timeout: 20000 });
      await page.waitForTimeout(400);
      await page.locator(q("send")).click();
      const batch = await poll(p);
      const ids = batch.instructions.comments.map((c) => c.id);
      assert.equal(ids.length, 2);

      const resultsPath = w.doc("ux06-results.json");
      fs.writeFileSync(
        resultsPath,
        JSON.stringify({
          summary: "Handled both comments.",
          results: ids.map((id) => ({ comment_id: id, status: "done", note: "Updated." })),
        })
      );
      const doneRes = await w.cli(["done", file, "--results", resultsPath]);
      assert.equal(doneRes.code, 0, doneRes.stderr);

      // Toggle-resolved appears for >= 2 resolved cards and exposes aria-expanded
      const toggleBtn = page.locator(q("toggle-resolved"));
      await toggleBtn.waitFor({ timeout: 15000 });
      assert.equal((await toggleBtn.textContent()).trim(), "Collapse all");
      assert.equal(await toggleBtn.getAttribute("aria-expanded"), "true");

      await toggleBtn.click();
      await until(
        async () => (await page.locator(`${q("comment-card")}[data-open="0"]`).count()) === 2,
        "both resolved cards to collapse"
      );
      assert.equal((await toggleBtn.textContent()).trim(), "Expand all");
      assert.equal(await toggleBtn.getAttribute("aria-expanded"), "false");

      await toggleBtn.click();
      await until(
        async () => (await page.locator(`${q("comment-card")}[data-open="1"]`).count()) === 2,
        "both resolved cards to expand"
      );
      assert.equal((await toggleBtn.textContent()).trim(), "Collapse all");
      assert.equal(await toggleBtn.getAttribute("aria-expanded"), "true");
    } finally {
      await t.end();
    }
  });

  test("S6 & S7: mixed blank drafts excluded from Send payload & stays draft; bare pin IS sendable when Overall note has words", async () => {
    const t = await openDoc("s6-s7-drafts.docx", { width: 1440, height: 900 });
    try {
      const { page, w, file } = t;
      const p1 = w.spawnCli(["poll", file]);
      await page.locator(q("banner-listening")).waitFor({ timeout: 20000 });

      // 1. Blank text comment ("   ")
      await selectWord(page, "Paragraph 010:");
      await page.locator(q("comment-chip")).click();
      await page.locator(`${q("comment-card")} textarea`).nth(0).fill("   ");

      // 2. Bare pin ("")
      await page.locator(q("mode-pin")).click();
      const para12 = await scrollToPara(page, "Paragraph 012:", 12 / 300);
      const b12 = await boxOf(para12);
      await page.mouse.click(b12.x + 80, b12.y + 12);
      await page.locator(q("mode-edit")).click();

      // 3. Real comment
      await selectWord(page, "Paragraph 014:");
      await page.locator(q("comment-chip")).click();
      await page.locator(`${q("comment-card")} textarea`).nth(2).fill("Real comment only");

      // Topbar sync-state must NOT say "No unsent edits" while draft comment exists
      await until(async () => /1 comment unsent/.test(await page.locator(q("sync-state")).textContent()), "sync-state shows 1 comment unsent");

      // Send button shows "1 comment" (not 3), and agent receives ONLY the 1 real comment
      assert.match(await page.locator(q("send")).textContent(), /1 comment/);
      await page.waitForTimeout(300);
      await page.locator(q("send")).click();
      const batch1 = await poll(p1);
      assert.equal(batch1.instructions.comments.length, 1, "S6: only the real comment was delivered");
      assert.equal(batch1.instructions.comments[0].text, "Real comment only");

      // Blank comment & bare pin MUST remain draft cards in the UI
      await until(
        async () => (await page.locator(`${q("comment-card")}[data-status="draft"]`).count()) === 2,
        "blank comment and bare pin remain drafts"
      );

      // Finish first run so we can test T4 reload survival + agreement and S7 (bare pin + Overall note)
      const res1 = w.doc("s6-res1.json");
      fs.writeFileSync(res1, JSON.stringify({ summary: "Handled real comment.", results: [{ comment_id: batch1.instructions.comments[0].id, status: "done", note: "Done." }] }));
      const done1 = await w.cli(["done", file, "--results", res1]);
      assert.equal(done1.code, 0, done1.stderr);

      // T4: Top bar and beforeunload leave-page guard agree (both say nothing unsent/dirty), and reload keeps both blank drafts
      await until(async () => /No unsent edits/.test(await page.locator(q("sync-state")).textContent()), "sync-state shows No unsent edits after run completes");
      const guardBeforeReload = await page.evaluate(() => {
        const ev = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(ev);
        return ev.defaultPrevented;
      });
      assert.equal(guardBeforeReload, false, "T4: beforeunload agrees with top bar (no unsaved local-only blank drafts)");

      await page.reload();
      await waitDoc(page);
      await until(
        async () => (await page.locator(`${q("comment-card")}[data-status="draft"]`).count()) === 2,
        "T4: both blank drafts survive page reload after Send"
      );

      // S7: With empty Overall note, bare pin shows "Empty draft" and Send is disabled
      const pinCard = page.locator(`${q("comment-card")}[data-kind="pin"][data-status="draft"]`);
      await pinCard.locator(q("empty-draft-hint")).waitFor({ timeout: 3000 });
      assert.equal(await page.locator(q("send")).isDisabled(), true);

      // Type into Overall note -> bare pin is now sendable, loses "Empty draft", counts as 1 pin, while blank text comment stays excluded
      await page.locator(q("overall-note")).fill("Move the pinned paragraph up");
      await pinCard.locator(q("empty-draft-hint")).waitFor({ state: "detached", timeout: 3000 });
      const blankTextCard = page.locator(`${q("comment-card")}[data-kind="text"][data-status="draft"]`);
      assert.equal(await blankTextCard.locator(q("empty-draft-hint")).count(), 1, "blank text comment still Empty draft");
      assert.match(await page.locator(q("send")).textContent(), /1 pin/);

      const p2 = w.spawnCli(["poll", file]);
      await page.locator(q("banner-listening")).waitFor({ timeout: 20000 });
      await page.locator(q("send")).click();
      const batch2 = await poll(p2);
      assert.equal(batch2.instructions.overall_note, "Move the pinned paragraph up");
      assert.equal(batch2.instructions.comments.length, 1, "S7: bare pin delivered with Overall note (blank text comment still excluded)");
      assert.equal(batch2.instructions.comments[0].kind, "pin");
    } finally {
      await t.end();
    }
  });

  test("S12: Shortcuts paints above open drawer at 1000px (elementFromPoint), R4d stacked Esc, Cmd+Alt+M, and modal blocks shortcuts", async () => {
    const t = await openDoc("s12-stacking-keys.docx", { width: 1000, height: 800 });
    try {
      const { page } = t;
      // Open narrow Review drawer and wait for its slide-in transition to settle
      await page.locator(q("sidebar-toggle")).click();
      const side = page.locator(q("sidebar"));
      await until(async () => (await side.getAttribute("class")).includes("open"), "drawer to open");
      await until(async () => page.evaluate(() => {
        const d = document.querySelector('[data-testid="sidebar"]').getBoundingClientRect();
        return d.right <= 1000 && d.left < 950;
      }), "drawer slide-in to settle");

      // Open Shortcuts popover via "?" while drawer is open at 1000px
      await page.locator(q("sidebar-hide")).focus();
      await page.keyboard.press("?");
      const sc = page.locator(q("shortcuts"));
      await sc.waitFor({ timeout: 3000 });

      // Real elementFromPoint hit test in the overlapping region with the drawer
      const hit = await page.evaluate(() => {
        const s = document.querySelector('[data-testid="shortcuts"]').getBoundingClientRect();
        const d = document.querySelector('[data-testid="sidebar"]').getBoundingClientRect();
        const x = (Math.max(s.left, d.left) + Math.min(s.right, d.right)) / 2;
        const y = Math.max(s.top, d.top) + 40;
        const el = document.elementFromPoint(x, y);
        return { overlap: s.right > d.left && s.left < d.right, hitShortcuts: !!el?.closest('[data-testid="shortcuts"]'), tag: el?.tagName };
      });
      assert.equal(hit.overlap, true, "Shortcuts popover overlaps the open drawer at 1000px");
      assert.equal(hit.hitShortcuts, true, "elementFromPoint hits Shortcuts popover ABOVE the open drawer");

      // Modal blocks global shortcuts (Cmd/Ctrl+\ must not close drawer while Shortcuts is open)
      await page.keyboard.press(`${MODK}+Backslash`);
      await page.waitForTimeout(200);
      assert.equal((await side.getAttribute("class")).includes("open"), true, "drawer stayed open while Shortcuts modal had focus");

      // R4d: Stacked Esc closes one layer per press (first Esc closes Shortcuts, drawer stays open; second Esc closes drawer)
      await page.keyboard.press("Escape");
      await sc.waitFor({ state: "detached", timeout: 3000 });
      assert.equal((await side.getAttribute("class")).includes("open"), true, "first Esc kept drawer open");
      await page.keyboard.press("Escape");
      await until(async () => (await side.getAttribute("class")).includes("shut"), "second Esc closed drawer");

      // Cmd/Ctrl+Alt+M creates a comment card from selected text
      await selectWord(page, "Paragraph 010:");
      await page.keyboard.press(`${MODK}+Alt+KeyM`);
      await page.locator(q("comment-card")).first().waitFor({ timeout: 5000 });
      assert.equal(await page.locator(q("comment-card")).count(), 1, "Cmd/Ctrl+Alt+M created a comment card");
    } finally {
      await t.end();
    }
  });

  test("S12: XLSX cell .hl.unit-cell.hovered computed box-shadow is visually distinct from unhovered", async () => {
    const w = makeWorld();
    const file = w.doc("budget.xlsx");
    const page = await br.page();
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(await w.open(file));
      await waitDoc(page, ".de-sheet");
      await openSheet(page, "Budget");
      const cb = await until(() => xlsxCell(page, "Line item 001", "C"), "XLSX cell rendered");

      await page.locator(q("mode-comment")).click();
      await page.mouse.click(center(cb).x, center(cb).y);
      const card = page.locator(q("comment-card")).first();
      await card.waitFor({ timeout: 5000 });
      const hl = page.locator(".hl.unit-cell").first();
      await hl.waitFor({ timeout: 5000 });

      // Blur the auto-focused card first so we measure the true unhovered state
      await page.locator(q("mode-edit")).focus();
      await until(async () => !(await hl.getAttribute("class")).includes("hovered"), "cell highlight to be unhovered");
      const unhoveredShadow = await hl.evaluate((el) => getComputedStyle(el).boxShadow);
      await card.hover();
      await until(async () => (await hl.getAttribute("class")).includes("hovered"), "cell highlight to gain .hovered");
      const hoveredShadow = await hl.evaluate((el) => getComputedStyle(el).boxShadow);
      assert.notEqual(hoveredShadow, unhoveredShadow, "hovered XLSX cell highlight has a distinct accent box-shadow");
    } finally {
      await page.close();
      await w.cleanup();
    }
  });

  test("S12 & R5: HTML still-badge, Esc leaves Comment mode from HTML iframe, hidden-tab edit counting, and conflict dialog hides Download a copy", async () => {
    const w = makeWorld();
    const file = w.doc("audit-sample.html");
    fs.writeFileSync(file, '<!doctype html><html><body><h1 id="h1">Quarterly Update</h1><p id="p1">Original paragraph text.</p></body></html>');
    const page = await br.page();
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(await w.open(file));
      await waitDoc(page, q("html-frame"));
      await until(
        async () => page.evaluate(() => !!document.querySelector('[data-testid="html-frame"]')?.contentDocument?.querySelector("#p1")?.isContentEditable),
        "HTML paragraph editable"
      );

      // html-still-badge is visible and readable
      const badge = page.locator(q("html-still-badge"));
      await badge.waitFor({ timeout: 3000 });
      assert.match((await badge.textContent()).trim(), /Still view.*scripts off/);

      // T6: Esc leaves Comment mode even when real contentWindow.focus() moves focus into the HTML iframe
      await page.locator(q("mode-comment")).click();
      const pill = page.locator(q("mode-pill"));
      await pill.waitFor({ timeout: 3000 });
      await page.evaluate(() => {
        const f = document.querySelector('[data-testid="html-frame"]');
        f.contentWindow.focus();
      });
      await until(
        async () => page.evaluate(() => document.activeElement?.dataset?.testid === "html-catch"),
        "T6: html-frame.js backstop returns focus from iframe to html-catch"
      );
      await page.keyboard.press("Escape");
      await pill.waitFor({ state: "detached", timeout: 3000 });
      assert.equal(await page.locator(q("mode-edit")).getAttribute("aria-pressed"), "true");

      // R5: real browser HTML hidden-tab edit counting (polling continues when document.hidden is true)
      await page.evaluate(() => {
        Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
        const p = document.querySelector('[data-testid="html-frame"]').contentDocument.querySelector("#p1");
        p.textContent = "Edited while tab hidden.";
      });
      const editsBar = page.locator(q("html-edits-bar"));
      await editsBar.waitFor({ timeout: 5000 });
      assert.match((await editsBar.textContent()).trim(), /1 unsent text edit/);

      // Real HTML conflict dialog appears and hides "Download a copy" / "Download my edits", and blocks shortcuts
      await page.route("**/api/send*", async (route) => {
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ error: "Someone changed this file outside Onionskin.", code: "conflict", side: "user" }),
        });
      });
      await page.locator(q("send")).click();
      const conflictDialog = page.locator(q("banner-conflict"));
      await conflictDialog.waitFor({ timeout: 5000 });
      assert.equal(await page.locator(q("keep-mine")).count(), 0, "HTML conflict dialog never shows Download a copy / Download my edits");
      await page.keyboard.press("?");
      await page.waitForTimeout(150);
      assert.equal(await page.locator(q("shortcuts")).count(), 0, "Shortcuts blocked while conflict dialog is open");
      await page.unroute("**/api/send*");
    } finally {
      await page.close();
      await w.cleanup();
    }
  });

  test("T5, T12, T13 & CloseDialog shortcuts: .hl .num click passes through in Edit mode, QuickAsk says Esc discards, Overall note updates top bar, Close dialog blocks shortcuts", async () => {
    const t = await openDoc("t5-t12-t13-close.docx", { width: 1440, height: 900 });
    try {
      const { page } = t;

      // T12: QuickAsk hint says "Esc discards."
      await selectWord(page, "Paragraph 010:");
      await page.locator(q("quick-ask-chip")).click();
      const qaHint = page.locator(q("quick-ask-hint"));
      await qaHint.waitFor({ timeout: 3000 });
      assert.match((await qaHint.textContent()).trim(), /Esc discards\./);
      await page.keyboard.press("Escape");
      await page.locator(q("quick-ask")).waitFor({ state: "detached", timeout: 3000 });

      // T5: clicking directly on .hl .num in Edit mode puts the caret in the document text
      await selectWord(page, "Paragraph 010:");
      await page.locator(q("comment-chip")).click();
      await page.locator(q("comment-card")).first().waitFor({ timeout: 5000 });
      await page.locator(q("mode-edit")).click();
      const num = page.locator(".hl .num").first();
      await num.waitFor({ timeout: 5000 });
      assert.equal(await num.evaluate((el) => getComputedStyle(el).pointerEvents), "none", "T5: .hl .num does not swallow clicks");
      const nb = await boxOf(num);
      await page.mouse.click(nb.x + nb.width / 2, nb.y + nb.height / 2);
      const caretInDoc = await page.evaluate(() => {
        const s = window.getSelection();
        if (!s || !s.anchorNode) return false;
        const el = s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentElement;
        return !!el?.closest(".de-page");
      });
      assert.equal(caretInDoc, true, "T5: clicking .hl .num in Edit mode places caret in document text");

      // Delete the draft comment so we can test T13 (ONLY Overall note unsent)
      await page.locator(`${q("comment-card")} ${q("delete-comment")}`).first().click();
      await until(async () => /No unsent edits/.test(await page.locator(q("sync-state")).textContent()), "sync-state resets to No unsent edits");

      // T13: typing ONLY an Overall note updates top bar so it does NOT say "No unsent edits"
      await page.locator(q("overall-note")).fill("Tighten the opening section");
      const guardOnNote = await page.evaluate(() => {
        const ev = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(ev);
        return ev.defaultPrevented;
      });
      assert.equal(guardOnNote, true, "T13: beforeunload guard active for unsaved Overall note");
      await until(async () => !/No unsent edits/.test(await page.locator(q("sync-state")).textContent()), "T13: top bar does not say No unsent edits when Overall note has text");
      assert.match((await page.locator(q("sync-state")).textContent()).trim(), /Overall note unsent/);

      // Close dialog blocks global shortcuts (?, Cmd/Ctrl+\)
      await page.mouse.click(nb.x + nb.width / 2 + 12, nb.y + nb.height / 2 + 8);
      await page.keyboard.type("X");
      await until(async () => /unsent edit/.test(await page.locator(q("sync-state")).textContent()), "unsent edit registered");
      await page.locator(q("close")).click();
      const closeDialog = page.locator(q("close-dialog"));
      await closeDialog.waitFor({ timeout: 3000 });
      await page.keyboard.press("?");
      await page.waitForTimeout(150);
      assert.equal(await page.locator(q("shortcuts")).count(), 0, "Shortcuts blocked while Close dialog is open");
      await page.keyboard.press("Escape");
      await closeDialog.waitFor({ state: "detached", timeout: 3000 });
    } finally {
      await t.end();
    }
  });

  test("T11: ErrorBoundary moves focus into crash screen, keeps beforeunload guard, says will be lost, and reports clipboard failure/success", async () => {
    const t = await openDoc("t11-error-boundary.docx", { width: 1440, height: 900 });
    try {
      const { page } = t;
      // Trigger a real render crash inside App while an unsent Overall note is present
      await page.route("**/api/send*", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ session: { format: null, state: "idle", comments: [], note: "Rescue this note", seq: 9999 } }),
        });
      });
      await page.locator(q("overall-note")).fill("Rescue this note");
      await page.locator(q("send")).click();
      const eb = page.locator(q("error-boundary"));
      await eb.waitFor({ timeout: 5000 });

      // 1. Focus moved into crash screen
      assert.equal(await page.evaluate(() => document.activeElement?.dataset?.testid), "error-boundary", "T11: focus moved into ErrorBoundary");
      // 2. Copy says "will be lost" (not "may be lost")
      assert.match((await eb.textContent()).trim(), /unsent edits on this page will be lost/);
      // 3. beforeunload guard is active while crashed with unsent comments/note
      const guarded = await page.evaluate(() => {
        const ev = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(ev);
        return ev.defaultPrevented;
      });
      assert.equal(guarded, true, "T11: beforeunload leave-page guard active while crashed with unsent note");
      // 4. Failed clipboard write shows visible failure message
      await page.evaluate(() => {
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: { writeText: () => Promise.reject(new Error("denied")) },
        });
      });
      await page.locator(q("error-copy-comments")).click();
      await page.locator(q("error-copy-failed")).waitFor({ timeout: 3000 });
      assert.match((await page.locator(q("error-copy-failed")).textContent()).trim(), /Could not copy/);
      const manual = eb.getByRole("textbox", { name: "Unsent comments" });
      assert.equal(await manual.inputValue(), "Overall instructions: Rescue this note");
      assert.equal(await manual.evaluate((el) => el.readOnly), true);
      // 5. Working clipboard write copies the unsent note and updates button label
      await page.evaluate(() => {
        window.__copied = null;
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: { writeText: (txt) => { window.__copied = txt; return Promise.resolve(); } },
        });
      });
      await page.locator(q("error-copy-comments")).click();
      await until(async () => /Copied unsent comments/.test(await page.locator(q("error-copy-comments")).textContent()), "copy button updates");
      assert.match(await page.evaluate(() => window.__copied || ""), /Rescue this note/);
      await page.unroute("**/api/send*");
    } finally {
      await t.end();
    }
  });
});
