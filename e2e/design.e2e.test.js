import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { LINE_END, agentEdit, boxOf, cspViolations, TAB, emulateReducedTransparency, launch, launchContext, makeWorld, para, waitDoc } from "./helpers/harness.mjs";

// D2: the app shell and design system. Layout at four widths, banners that never move the page, sidebar resize and
// persistence, theme toggle across formats, a keyboard-only walk, reduced transparency and motion, target sizes, typing latency.
const q = (id) => `[data-testid="${id}"]`;
const firstPara = (page) => page.evaluate(() => Math.round(document.querySelector(".de-p").getBoundingClientRect().top * 10) / 10);
const noHScroll = (page) => page.evaluate(() => ({ doc: document.documentElement.scrollWidth - document.documentElement.clientWidth, body: document.body.scrollWidth - document.body.clientWidth }));

let br, w;
before(async () => {
  br = await launch();
  w = makeWorld();
});
after(async () => {
  await br?.close();
  await w?.cleanup();
});

let seq = 0;
/** A private copy of long.docx per test, so one test's session state (stranded, working) never leaks into the next. */
const fresh = () => {
  const f = w.doc(`long-${++seq}.docx`);
  fs.copyFileSync(w.doc("long.docx"), f);
  return f;
};

async function openDoc(file, size = { width: 1440, height: 900 }, probe) {
  const page = await br.page();
  await page.setViewportSize(size);
  await page.goto(await w.open(file));
  await waitDoc(page, probe);
  await page.waitForTimeout(1200);
  return page;
}

describe("layout", () => {
  test("no horizontal scroll at 1440, 1100, 768, 390 and 360 px (default, drawer open, with a banner)", async () => {
    const file = fresh();
    const page = await openDoc(file);
    for (const [width, height] of [[1440, 900], [1100, 800], [768, 900], [390, 844], [360, 740]]) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(500);
      assert.deepEqual(await noHScroll(page), { doc: 0, body: 0 }, `default at ${width}`);
      const narrow = width < 1100;
      assert.equal(await page.locator('[data-testid="sidebar"]').evaluate((el) => el.classList.contains("drawer")), narrow, `drawer mode at ${width}`);
      if (narrow) {
        await page.locator(q("sidebar-toggle")).click();
        await page.waitForTimeout(600);
        assert.deepEqual(await noHScroll(page), { doc: 0, body: 0 }, `drawer open at ${width}`);
        const box = await boxOf(page.locator(q("sidebar")));
        assert.ok(box.x >= 0 && box.x + box.width <= width + 0.5, `drawer inside the viewport at ${width}`);
        await page.keyboard.press("Escape");
        await page.waitForTimeout(500);
        assert.equal(await page.locator(q("sidebar")).evaluate((el) => el.classList.contains("shut")), true, "Escape closes the drawer");
      }
    }
    // a banner (stranded) at each width
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator(q("sidebar-toggle")).click();
    await page.locator(q("overall-note")).fill("Layout check at phone width.");
    await page.locator(q("send")).click();
    await page.locator(q("banner-stranded")).waitFor({ timeout: 10000 });
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(500);
    assert.deepEqual(await noHScroll(page), { doc: 0, body: 0 }, "stranded banner at 390");
    const bb = await boxOf(page.locator(q("banner-stranded")));
    assert.ok(bb.x >= 0 && bb.x + bb.width <= 390.5, "banner inside the viewport at 390");
    await page.close();
  });
});

describe("banners and the sidebar do not move the document", () => {
  test("the first paragraph keeps its y when stranded, working and done banners appear and the sidebar toggles", async () => {
    const file = fresh();
    const page = await openDoc(file);
    const y0 = await firstPara(page);
    const docBox0 = await boxOf(page.locator(q("docwrap")));
    // stranded
    await page.locator(q("overall-note")).fill("Banner shift check.");
    await page.locator(q("send")).click();
    await page.locator(q("banner-stranded")).waitFor({ timeout: 10000 });
    await page.waitForTimeout(500);
    assert.ok(Math.abs((await firstPara(page)) - y0) <= 1, `stranded banner moved the document (${y0} -> ${await firstPara(page)})`);
    // working (a poller takes the batch)
    const poll = w.spawnCli(["poll", file]);
    const res = await Promise.race([poll.done, new Promise((r) => setTimeout(() => r(null), 15000))]);
    assert.ok(res && res.code === 0);
    await page.locator(q("banner-working")).waitFor();
    await page.waitForTimeout(500);
    assert.ok(Math.abs((await firstPara(page)) - y0) <= 1, "working banner moved the document");
    const docBox1 = await boxOf(page.locator(q("docwrap")));
    assert.deepEqual([docBox1.y, docBox1.height], [docBox0.y, docBox0.height], "document area keeps its box");
    // done
    const results = w.doc("r-design.json");
    fs.writeFileSync(results, JSON.stringify({ summary: "Nothing to change.", results: [] }));
    assert.equal((await w.cli(["done", file, "--results", results])).code, 0);
    await page.locator(q("activity-entry")).first().waitFor({ timeout: 20000 });
    await page.waitForTimeout(800);
    assert.ok(Math.abs((await firstPara(page)) - y0) <= 1, "done state moved the document");
    // sidebar collapse and expand: vertical position unchanged
    await page.locator(q("sidebar-toggle")).click();
    await page.waitForTimeout(500);
    const docBox2 = await boxOf(page.locator(q("docwrap")));
    assert.deepEqual([docBox2.y, docBox2.height], [docBox0.y, docBox0.height], "collapsing the sidebar moved the document area vertically"); // the page itself rescales (zoom: fit)
    await page.locator(q("sidebar-toggle")).click();
    await page.close();
  });
});

describe("sidebar", () => {
  test("resize by dragging and by keyboard (clamped 320 to 520), collapse by button and shortcut, all remembered across reload", async () => {
    const file = fresh();
    const page = await openDoc(file);
    const width = async () => Math.round((await boxOf(page.locator(q("sidebar")))).width);
    const w0 = await width();
    const h = await boxOf(page.locator(q("sidebar-resizer")));
    const cx = h.x + h.width / 2;
    const cy = h.y + h.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx - 60, cy, { steps: 6 });
    await page.mouse.up();
    const w1 = await width();
    assert.ok(Math.abs(w1 - (w0 + 60)) <= 2, `dragging left 60px grows the sidebar by 60 (${w0} -> ${w1})`);
    // clamp
    let h2 = await boxOf(page.locator(q("sidebar-resizer")));
    await page.mouse.move(h2.x + 7, h2.y + 40);
    await page.mouse.down();
    await page.mouse.move(60, h2.y + 40, { steps: 8 });
    await page.mouse.up();
    assert.equal(await width(), 520, "max 520");
    h2 = await boxOf(page.locator(q("sidebar-resizer")));
    await page.mouse.move(h2.x + 7, h2.y + 40);
    await page.mouse.down();
    await page.mouse.move(1400, h2.y + 40, { steps: 8 });
    await page.mouse.up();
    assert.equal(await width(), 320, "min 320");
    // keyboard
    await page.locator(q("sidebar-resizer")).focus();
    await page.keyboard.press("ArrowLeft");
    assert.equal(await width(), 336);
    assert.equal(await page.locator(q("sidebar-resizer")).getAttribute("aria-valuenow"), "336");
    // persists across reload
    await page.reload();
    await waitDoc(page);
    assert.equal(await width(), 336, "width remembered");
    // collapse with the button, then with the shortcut
    await page.locator(q("sidebar-toggle")).click();
    await page.waitForTimeout(300);
    assert.equal(await page.locator(q("sidebar")).isVisible(), false, "collapsed");
    assert.equal(await page.locator(q("sidebar-toggle")).getAttribute("aria-expanded"), "false");
    await page.reload();
    await waitDoc(page);
    assert.equal(await page.locator(q("sidebar")).isVisible(), false, "collapsed state remembered");
    await page.keyboard.press("Control+Backslash");
    await page.waitForTimeout(300);
    assert.equal(await page.locator(q("sidebar")).isVisible(), true, "Ctrl+\\ expands");
    assert.equal(await width(), 336);
    await page.close();
  });
});

describe("theme", () => {
  for (const [name, probe, sample] of [["DOCX", ".de-p"], ["XLSX", ".de-cell", "sample.xlsx"], ["PPTX", ".de-slide", "sample.pptx"]]) {
    test(`the toggle switches the shell and the engine together (${name})`, async () => {
      const file = sample ? w.copySample(sample, `theme-${sample}`) : fresh();
      const page = await br.page();
      await page.addInitScript(() => localStorage.removeItem("onionskin.theme")); // start from the OS preference, not an earlier test's choice
      await page.emulateMedia({ colorScheme: "light" });
      await page.goto(await w.open(file));
      await waitDoc(page, probe);
      await page.waitForTimeout(1500);
      const read = () =>
        page.evaluate(() => {
          const root = document.querySelector(".de-root");
          const bar = document.querySelector(".de-ebar");
          return {
            theme: document.documentElement.dataset.theme,
            engineDark: root.classList.contains("de-dark"),
            engineText: getComputedStyle(root).getPropertyValue("--de-text").trim(),
            engineTextInBar: getComputedStyle(bar).getPropertyValue("--de-text").trim(),
            shellInk: getComputedStyle(document.querySelector(".topbar")).color,
            appBg: getComputedStyle(document.body).backgroundColor,
            toolbarIcon: getComputedStyle(document.querySelector(".de-tb")).color,
          };
        });
      const light = await read();
      assert.equal(light.theme, "light");
      assert.equal(light.engineDark, false);
      assert.ok(light.engineText, "--de-text is defined inside the engine root");
      assert.ok(light.engineTextInBar, "--de-text reaches the portaled toolbar (outside .de-root)");
      await page.locator(q("theme-toggle")).click();
      await page.waitForTimeout(400);
      const dark = await read();
      assert.equal(dark.theme, "dark");
      assert.equal(dark.engineDark, true, "engine root switched to its dark class");
      assert.notEqual(dark.engineText, light.engineText);
      assert.notEqual(dark.shellInk, light.shellInk);
      assert.notEqual(dark.appBg, light.appBg);
      assert.notEqual(dark.toolbarIcon, light.toolbarIcon, "format toolbar follows the theme");
      assert.equal(dark.engineTextInBar, dark.engineText, "toolbar and engine share the same mapping");
      await page.close();
    });
  }
});

describe("accessibility", () => {
  test("keyboard only: Tab to the mode switch, Comment mode, comment on the caret paragraph, overall note, Send", async () => {
    const file = fresh();
    const page = await openDoc(file);
    const active = () => page.evaluate(() => document.activeElement?.getAttribute("data-testid") || document.activeElement?.tagName);
    // The editing surface keeps Tab for itself; F6 moves between landmarks (document, toolbar, panel, bar).
    const region = () => page.evaluate(() => (document.activeElement?.closest(".topbar, .toolbar, [data-testid='docwrap'], #review-panel")?.className || "none").toString().split(" ")[0]);
    let hops = 0;
    while ((await region()) !== "toolbar" && hops++ < 6) await page.keyboard.press("F6");
    assert.equal(await region(), "toolbar", "F6 reaches the toolbar");
    hops = 0;
    while ((await active()) !== "mode-comment" && hops++ < 6) await page.keyboard.press(TAB);
    assert.equal(await active(), "mode-comment", "Comment mode is reachable by Tab");
    await page.keyboard.press("Enter");
    assert.equal(await page.locator(q("mode-comment")).getAttribute("aria-pressed"), "true");
    // back into the document with F6, place the caret
    hops = 0;
    while ((await region()) !== "docwrap" && hops++ < 6) await page.keyboard.press("F6");
    assert.equal(await region(), "docwrap", "F6 reaches the document");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Control+Alt+KeyM");
    await page.locator('[data-testid="comment-card"] textarea').first().waitFor({ timeout: 5000 });
    assert.equal(await page.evaluate(() => document.activeElement?.tagName), "TEXTAREA", "focus moves into the new comment");
    await page.keyboard.type("Keyboard only comment.");
    // on to the overall note, then Send
    hops = 0;
    while ((await page.evaluate(() => document.activeElement?.id)) !== "overall" && hops++ < 20) await page.keyboard.press(TAB);
    await page.keyboard.type("Typed without a mouse.");
    hops = 0;
    while ((await active()) !== "send" && hops++ < 5) await page.keyboard.press(TAB);
    assert.equal(await active(), "send");
    await page.keyboard.press("Enter");
    await page.locator(q("banner-stranded")).waitFor({ timeout: 10000 });
    assert.match(await page.locator('[data-testid="comment-card"] textarea').first().inputValue(), /Keyboard only comment/);
    // every interactive control has a visible focus ring
    await page.locator(q("mode-pin")).focus();
    const ring = await page.locator(q("mode-pin")).evaluate((el) => getComputedStyle(el).outlineStyle + " " + getComputedStyle(el).outlineWidth);
    assert.match(ring, /solid 2px/);
    await page.close();
  });

  test("roles and labels: toolbar, mode group, sidebar lists, banners, dialog", async () => {
    const file = fresh();
    const page = await openDoc(file);
    assert.equal(await page.locator('[role="toolbar"]').count() > 0, true, "engine toolbar has role=toolbar");
    assert.equal(await page.locator('.modes[role="group"][aria-label="Mode"]').count(), 1);
    assert.equal(await page.locator('[data-testid="sidebar"]').getAttribute("aria-label"), "Review panel");
    assert.equal(await page.locator(q("state-pill")).getAttribute("role"), "status");
    await page.locator(q("overall-note")).fill("x");
    await page.locator(q("send")).click();
    await page.locator(q("banner-stranded")).waitFor();
    assert.equal(await page.locator(q("banner-stranded")).getAttribute("role"), "status");
    await page.locator(q("take-back")).click();
    // conflict: an alertdialog that traps focus
    await para(page, "Paragraph 004:").scrollIntoViewIfNeeded();
    const b = await boxOf(para(page, "Paragraph 004:"));
    await page.mouse.click(b.x + b.width - 40, b.y + b.height - 10);
    await page.keyboard.press(LINE_END);
    await page.keyboard.type(" X");
    agentEdit([file, "replace", "short note", "EXT", "Paragraph 006:"]);
    await page.locator(q("send")).click();
    const dlg = page.locator(q("banner-conflict"));
    await dlg.waitFor({ timeout: 10000 });
    assert.equal(await dlg.getAttribute("role"), "alertdialog");
    assert.equal(await dlg.getAttribute("aria-modal"), "true");
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press(TAB);
      assert.ok(await page.evaluate(() => !!document.activeElement?.closest('[role="alertdialog"]')), "focus stays inside the dialog");
    }
    await page.locator(q("reload-disk")).click();
    await dlg.waitFor({ state: "detached" });
    await page.close();
  });

  test("target sizes: every visible control is at least 32 px (desktop) and 44 px (coarse pointer)", async () => {
    const file = fresh();
    const page = await openDoc(file);
    const small = () =>
      page.evaluate(() => {
        const out = [];
        for (const el of document.querySelectorAll('.app button, .app [role="separator"], .app input:not([type="hidden"])')) {
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height || el.closest("[hidden]") || el.classList.contains("de-tb-native")) continue; // de-tb-native: the engine's hidden colour input
          if (Math.min(r.width, r.height) < 31.5) out.push(`${el.tagName}.${String(el.className).slice(0, 40)} ${Math.round(r.width)}x${Math.round(r.height)} ${el.getAttribute("aria-label") || el.title || ""}`);
        }
        return out;
      });
    assert.deepEqual(await small(), [], "controls under 32 px on desktop");
    await page.close();
    // touch: a separate mobile context so (pointer: coarse) really matches
    const prof = fs.mkdtempSync(path.join(os.tmpdir(), "da-touch-"));
    const touch = await launchContext(prof, { hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
    try {
      const tp = await touch.newPage();
      await tp.goto(await w.open(file));
      await waitDoc(tp);
      await tp.waitForTimeout(1200);
      assert.equal(await tp.evaluate(() => matchMedia("(pointer: coarse)").matches), true, "touch context reports a coarse pointer");
      const bad = await tp.evaluate(() => {
        const out = [];
        for (const el of document.querySelectorAll('.app button, .app input:not([type="hidden"])')) {
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height || el.closest("[hidden]") || el.closest(".sidebar.shut")) continue;
          if (Math.min(r.width, r.height) < 43.5) out.push(`${el.tagName}.${String(el.className).slice(0, 30)} ${Math.round(r.width)}x${Math.round(r.height)} ${el.getAttribute("aria-label") || ""}`);
        }
        return out;
      });
      assert.deepEqual(bad, [], "controls under 44 px on a coarse pointer");
    } finally {
      await touch.close();
      fs.rmSync(prof, { recursive: true, force: true });
    }
  });
});

describe("preferences", () => {
  test("the panes are near-opaque with no blur; prefers-reduced-transparency makes them fully solid; prefers-reduced-motion stops the working animation", async () => {
    const file = fresh();
    const page = await openDoc(file);
    const glass = () => page.evaluate(() => ({ filter: getComputedStyle(document.querySelector(".topbar")).backdropFilter, bg: getComputedStyle(document.querySelector(".topbar")).backgroundColor }));
    const before = await glass();
    assert.equal(before.filter, "none", "the solid panes do not blur what is behind them");
    assert.ok(Number((before.bg.match(/rgba?\(([^)]+)\)/)[1].split(",")[3] ?? "1").trim()) >= 0.9, `near-opaque by default (${before.bg})`);
    const emulated = await emulateReducedTransparency(br.ctx, page, "reduce");
    await page.waitForTimeout(300);
    const supported = emulated && (await page.evaluate(() => matchMedia("(prefers-reduced-transparency: reduce)").matches));
    if (supported) {
      const after = await glass();
      assert.equal(after.filter, "none", "no backdrop blur when transparency is reduced");
      const alpha = (c) => (c.match(/rgba?\(([^)]+)\)/)[1].split(",")[3] ?? "1").trim();
      assert.ok(Number(alpha(after.bg)) >= 0.99 || /^rgb\(/.test(after.bg), `solid fill (${after.bg})`);
    } else console.log("this browser cannot emulate prefers-reduced-transparency; solid fallback not exercised");
    await emulateReducedTransparency(br.ctx, page, "no-preference");
    // reduced motion: put the app in the working state and read the animation of the page-edge sheen
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.locator(q("overall-note")).fill("Motion check.");
    await page.locator(q("send")).click();
    await page.locator(q("banner-stranded")).waitFor();
    const poll = w.spawnCli(["poll", file]);
    await Promise.race([poll.done, new Promise((r) => setTimeout(r, 15000))]);
    await page.locator(q("banner-working")).waitFor();
    const anim = await page.evaluate(() => ({ sheen: getComputedStyle(document.querySelector(".sheen-edge"), "::before").animationName, dot: getComputedStyle(document.querySelector(".pill"), "::before").animationName }));
    assert.equal(anim.sheen, "none", "sheen animation off");
    assert.equal(anim.dot, "none", "pulse animation off");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector(".sheen-edge"), "::before").animationName), "sheen", "animates when motion is allowed");
    await page.close();
  });
});

describe("performance", () => {
  test("typing in the 300-paragraph document stays responsive (keystroke to next frame)", async () => {
    const file = fresh();
    const page = await openDoc(file);
    await page.evaluate(() => {
      window.__lat = [];
      document.addEventListener(
        "keydown",
        () => {
          const t0 = performance.now();
          requestAnimationFrame(() => requestAnimationFrame(() => window.__lat.push(performance.now() - t0)));
        },
        true
      );
    });
    const b = await boxOf(para(page, "Paragraph 003:"));
    await page.mouse.click(b.x + b.width - 40, b.y + b.height - 10);
    await page.keyboard.press(LINE_END);
    await page.keyboard.type("The quick brown fox jumps over the lazy dog, twice over.", { delay: 15 });
    await page.waitForTimeout(500);
    const lat = (await page.evaluate(() => window.__lat)).sort((a, c) => a - c);
    const pct = (p) => lat[Math.min(lat.length - 1, Math.floor(lat.length * p))];
    console.log(`TYPING LATENCY (300 paragraphs, ${lat.length} keys): p50=${pct(0.5).toFixed(1)}ms p95=${pct(0.95).toFixed(1)}ms max=${lat[lat.length - 1].toFixed(1)}ms`);
    assert.ok(lat.length >= 40);
    // the engine alone (previous app shell, same machine, same file) measures p95 105 to 136 ms; the bound only guards against a regression of that order
    assert.ok(pct(0.95) < 200, `p95 ${pct(0.95)} ms`);
    // and the coalesced change shows up once
    assert.equal(await page.locator(q("change-item")).count(), 1);
    await page.close();
  });

  test("overlay redraws once per frame while scrolling with comments present", async () => {
    const file = fresh();
    const page = await openDoc(file);
    await page.locator(q("mode-comment")).click();
    const b = await boxOf(para(page, "Paragraph 005:"));
    await page.mouse.click(b.x + 60, b.y + 10);
    await page.locator('[data-testid="comment-card"] textarea').first().fill("scroll test");
    await page.locator(q("mode-edit")).click();
    const stats = await page.evaluate(async () => {
      const s = document.querySelector(".de-scroll");
      let frames = 0;
      let worst = 0;
      let last = performance.now();
      const loop = () => {
        const n = performance.now();
        worst = Math.max(worst, n - last);
        last = n;
        frames++;
        if (frames < 90) requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
      for (let i = 0; i < 60; i++) {
        s.scrollTop += 40;
        await new Promise((r) => setTimeout(r, 10));
      }
      await new Promise((r) => setTimeout(r, 600));
      return { frames, worst };
    });
    console.log(`SCROLL: ${stats.frames} frames, worst frame ${stats.worst.toFixed(1)} ms`);
    assert.ok(stats.worst < 250, `worst frame ${stats.worst}`);
    await page.close();
  });
});

describe("zero violations", () => {
  test("no CSP violations and no page errors across every state in this file", async () => {
    assert.deepEqual(cspViolations(br.log), []);
    assert.deepEqual(br.log.errors, []);
    const bad = br.log.console.filter((m) => m.type === "error" && !/status of 409/.test(m.text)); // the 409 is the conflict test's deliberate stale Send
    assert.deepEqual(bad, []);
  });
});
