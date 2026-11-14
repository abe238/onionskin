import assert from "node:assert/strict";
import fs from "node:fs";
import zlib from "node:zlib";
import { after, before, describe, test } from "node:test";
import { LINE_END, agentEdit, boxOf, fakeAppleHelper, launch, makeWorld, para, waitDoc } from "./helpers/harness.mjs";

// WCAG contrast of real text against the real rendered backdrop. For each sample the element's own text is hidden
// (color: transparent), the element's box is screenshotted, and the text colour is compared with the pixels that were
// actually painted behind it (glass over the wash included). The worst pixel in the box decides the ratio.

// ---- minimal PNG decoder (8-bit RGB / RGBA, non-interlaced), enough for Chrome screenshots ----
function decodePng(buf) {
  let p = 8;
  let w = 0, h = 0, ct = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString("ascii", p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") (w = data.readUInt32BE(0)), (h = data.readUInt32BE(4)), (ct = data[9]);
    else if (type === "IDAT") idat.push(data);
    p += 12 + len;
  }
  const bpp = ct === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0;
      let v = src[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + x] = v & 255;
    }
  }
  return { w, h, bpp, px: out };
}
const lin = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const lum = (r, g, b) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (l1, l2) => (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
const parseColor = (s) => {
  const m = s.match(/rgba?\(([^)]+)\)/);
  const [r, g, b, a = 1] = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number);
  return { r, g, b, a };
};

let br, w, fm;
const results = [];
const failures = []; // collected, not thrown: one run lists every failing pair
before(async () => {
  br = await launch();
  fm = fakeAppleHelper("ok"); // the offer to turn on quick fixes needs a helper that could be turned on
  w = makeWorld({ ONIONSKIN_APPLE_HELPER_DIR: fm });
});
after(async () => {
  await br?.close();
  await w?.cleanup();
  if (fm) fs.rmSync(fm, { recursive: true, force: true });
  const worst = [...results].sort((a, b) => a.ratio - b.ratio).slice(0, 8);
  console.log("CONTRAST (lowest 8 of " + results.length + "):\n" + worst.map((r) => `  ${r.ratio.toFixed(2)}:1  ${r.theme.padEnd(5)} ${r.name}`).join("\n"));
  if (process.env.CONTRAST_FULL) console.log(results.map((r) => `${r.theme}\t${r.name}\t${r.ratio.toFixed(2)}`).join("\n"));
});

/** Measure one element: returns the worst-case contrast of its text colour over the pixels painted behind it. */
async function measure(page, theme, name, selector, { pseudo = "", min = 4.5, nth = 0 } = {}) {
  const loc = page.locator(selector).nth(nth);
  if (!(await loc.count()) || !(await loc.isVisible())) return void results.push({ theme, name: name + " (not shown)", ratio: 99 });
  const color = await loc.evaluate((el, ps) => getComputedStyle(el, ps || undefined).color, pseudo);
  const fg = parseColor(color);
  await page.addStyleTag({ content: "*, *::before, *::after { transition: none !important; animation: none !important; } .topbar *, .toolbar *, .sidebar *, .banners *, .dialog *, .dock *, .qa *, .de-dd-pop *, .menu * { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; } ::placeholder { color: transparent !important; -webkit-text-fill-color: transparent !important; } .banner code, .sidebar textarea { -webkit-text-fill-color: transparent !important; } .pill::before, .dot, .working-mark, .spinner, .chipn b { visibility: hidden !important; }" }).then(async (h) => {
    await loc.scrollIntoViewIfNeeded();
    await page.waitForTimeout(80);
    const b = await boxOf(loc);
    const inset = Math.min(3, b.height / 4, b.width / 4);
    const clip = { x: Math.max(0, b.x + inset), y: Math.max(0, b.y + inset), width: Math.max(2, b.width - 2 * inset), height: Math.max(2, b.height - 2 * inset) };
    const png = decodePng(await page.screenshot({ clip }));
    await h.evaluate((el) => el.remove());
    await page.waitForTimeout(220); // let colour transitions settle before the next sample reads computed colours
    const ratios = [];
    for (let i = 0; i < png.w * png.h; i++) {
      const o = i * png.bpp;
      const bg = { r: png.px[o], g: png.px[o + 1], b: png.px[o + 2] };
      const mix = { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a) };
      ratios.push(ratio(lum(mix.r, mix.g, mix.b), lum(bg.r, bg.g, bg.b)));
    }
    ratios.sort((a, b) => a - b);
    const worst = ratios[Math.floor(ratios.length * 0.02)]; // ignore the 2 % of pixels that are antialiasing at the box edge
    results.push({ theme, name, ratio: worst, min });
    if (worst < min) failures.push(`${theme} ${name}: ${worst.toFixed(2)}:1 < ${min}:1 (text ${color})`);
  });
}

for (const theme of ["light", "dark"]) {
  describe(`contrast, ${theme} theme`, () => {
    test("shell, toolbar and sidebar text in the idle state with content", async () => {
      const file = w.doc("long.docx");
      const copy = w.doc(`c-${theme}.docx`);
      fs.copyFileSync(file, copy);
      const page = await br.page();
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.addInitScript((t) => localStorage.setItem("onionskin.theme", t), theme);
      await page.goto(await w.open(copy));
      await waitDoc(page);
      await page.waitForTimeout(1500);
      // an edit (warn sync text, a change row), a comment and a pin (cards), a note
      const b3 = await boxOf(para(page, "Paragraph 003:"));
      await page.mouse.click(b3.x + b3.width - 40, b3.y + b3.height - 10);
      await page.keyboard.press(LINE_END);
      await page.keyboard.type(" (owner: Dana)");
      await page.locator('[data-testid="mode-comment"]').click();
      await para(page, "Paragraph 005:").scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      const b5 = await boxOf(para(page, "Paragraph 005:"));
      await page.mouse.click(b5.x + 60, b5.y + 12);
      await page.locator('[data-testid="comment-card"] textarea').first().fill("Say who owns this item.");
      await page.locator('[data-testid="mode-edit"]').click();
      await page.locator('[data-testid="comment-card"] textarea').first().fill("Say who owns this item.");
      // put the caret back in the document so the format toolbar is live
      await page.mouse.click(b3.x + 100, b3.y + 10);
      await page.waitForTimeout(500);
      const M = (n, s, o) => measure(page, theme, n, s, o);
      await M("top bar: file name", ".topbar .fname");
      await M("top bar: product name", ".topbar .brand");
      await M("top bar: format badge", ".topbar .badge.format");
      await M("top bar: sync (unsent edit)", ".topbar .sync");
      await M("top bar: state pill (idle)", ".topbar .pill");
      await M("top bar: Close session", '[data-testid="close"]');
      await M("toolbar: mode (inactive)", '[data-testid="mode-comment"]');
      await M("toolbar: mode (active)", '[data-testid="mode-edit"]');
      await M("toolbar: style dropdown", ".de-ebar .de-dd", { min: 4.5 });
      await M("toolbar: icon button", ".de-ebar .de-tb:not(:disabled)", { min: 3 });
      await M("sidebar: title", ".side-h h2");
      await M("sidebar: subtitle", ".side-sub");
      await M("sidebar: section heading", ".sec-h h3");
      await M("sidebar: count", ".sec-h .count");
      await M("sidebar: change location", ".change .loc");
      await M("sidebar: change kind", ".change .kind");
      await M("sidebar: diff after", ".change .diff ins");
      await M("sidebar: card locate link", ".card .locate");
      await M("sidebar: card comment number", ".card .num");
      await M("sidebar: card status badge", ".card .badge");
      await M("sidebar: card quote", ".card blockquote");
      await M("sidebar: card text", ".card textarea");
      await M("sidebar: overall label", ".composer label");
      await M("sidebar: overall placeholder", "#overall", { pseudo: "::placeholder" });
      await M("sidebar: send hint", ".send-hint");
      await M("sidebar: send button", '[data-testid="send"]');
      await M("sidebar: send count chip", ".send-counts");
      // a menu (the paragraph style list) and a dialog (Close with unsent edits), on their own panes
      await page.locator(".de-ebar .de-dd").first().click();
      await page.locator(".de-dd-pop .de-dd-opt").first().waitFor({ timeout: 5000 });
      await M("menu: style option", ".de-dd-pop .de-dd-opt");
      await page.keyboard.press("Escape");
      await page.locator('[data-testid="close"]').first().click();
      await page.locator('[data-testid="close-dialog"]').waitFor({ timeout: 5000 });
      await page.waitForTimeout(300);
      await M("dialog: title", "#close-title");
      await M("dialog: body", "#close-body");
      await M("dialog: primary button", '[data-testid="close-download"]');
      await M("dialog: button", '[data-testid="close-cancel"]');
      await page.locator('[data-testid="close-cancel"]').click();

      // stranded
      await page.locator('[data-testid="overall-note"]').fill("Keep the tone formal.");
      await page.locator('[data-testid="send"]').click();
      await page.locator('[data-testid="banner-stranded"]').waitFor({ timeout: 10000 });
      await page.waitForTimeout(700);
      await M("banner stranded: title", ".banner.warn .banner-text strong");
      await M("banner stranded: body", ".banner.warn .banner-text > span");
      await M("banner stranded: Start button", '[data-testid="agent-start"]');
      await M("banner stranded: Take back button", '[data-testid="take-back"]');
      await M("top bar: state pill (stranded)", ".topbar .pill");

      // working
      const poll = w.spawnCli(["poll", copy]);
      const res = await Promise.race([poll.done, new Promise((r) => setTimeout(() => r(null), 15000))]);
      assert.ok(res);
      await page.locator('[data-testid="banner-working"]').waitFor();
      await page.waitForTimeout(700);
      const batch = JSON.parse(res.stdout);
      await M("banner working: title", ".banner.info .banner-text strong");
      await M("banner working: body", ".banner.info .banner-text > span");
      await M("banner working: Take back", '[data-testid="take-back"]');
      await M("top bar: state pill (working)", ".topbar .pill");
      await M("sidebar: subtitle (working)", ".side-sub");

      // done: results, a declined chip, a warning flag, a moved card
      agentEdit([copy, "replace", "short note", "owner note", "Paragraph 005:"]);
      const ids = batch.instructions.comments.map((c) => c.id);
      const rj = w.doc(`r-${theme}.json`);
      fs.writeFileSync(rj, JSON.stringify({ summary: "Named the owner in paragraph 5.", results: ids.length ? [{ comment_id: ids[0], status: "declined", note: "Needs the Q3 report, which I cannot see." }] : [] }));
      await w.cli(["done", copy, "--results", rj]);
      await page.locator('[data-testid="activity-entry"]').first().waitFor({ timeout: 20000 });
      await page.waitForTimeout(6500); // let the fresh highlight settle
      await M("activity: run title", ".run-h strong");
      await M("activity: time", ".run-h time");
      await M("activity: summary", ".summary");
      await M("card: state (declined)", ".card .badge.st-declined");
      // folded lines: an answered card and a finished run
      if (ids.length) {
        await page.locator('[data-testid="card-fold"]').first().click();
        await M("card: folded line", ".card .peek");
        await page.locator('[data-testid="card-open"]').first().click();
      }
      await page.locator('[data-testid="run-fold"]').last().click();
      await M("activity: folded summary", ".run-peek");
      await page.locator('[data-testid="run-fold"]').last().click();
      await M("activity: agent note", ".agentnote");
      await M("top bar: state pill (idle after run)", ".topbar .pill");
      await M("sidebar: Revert button", '[data-testid="revert"]');
      // History: the row, a place with red removed and green added words on the card surface, the Show action, the plain lines
      await page.locator('[data-testid="history-collapse"]').click(); // History starts folded
      await page.locator('[data-testid="history-row"]').first().click();
      await page.locator('[data-testid="history-place"] del').first().waitFor({ timeout: 10000 });
      await M("history: hint", ".h-hint");
      await M("history: row title", ".h-title");
      await M("history: row count", ".h-count");
      await M("history: row time", ".h-time");
      await M("history: summary", ".h-sum p");
      await M("history: place label", ".h-label");
      await M("history: Show action", '[data-testid="history-show"]');
      await M("history: removed words (red)", ".h-diff del");
      await M("history: added words (green)", ".h-diff ins");
      await M("history: plain line", ".h-line");
      await page.close();
    });

    test("Quick ask stamps: row, edit mode, enabled and disabled", async () => {
      const copy = w.doc(`stamps-${theme}.docx`);
      fs.copyFileSync(w.doc("long.docx"), copy);
      const page = await br.page();
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.addInitScript((t) => localStorage.setItem("onionskin.theme", t), theme);
      await page.goto(await w.open(copy));
      await waitDoc(page);
      await page.waitForTimeout(1500);
      const b = await boxOf(para(page, "Paragraph 003:"));
      await page.mouse.dblclick(b.x + 150, b.y + 12);
      await page.locator('[data-testid="quick-ask-chip"]').click();
      await page.locator('[data-testid="quick-ask"]').waitFor({ timeout: 3000 });
      await page.waitForTimeout(500);
      const M = (n, s, o) => measure(page, theme, n, s, o);
      await M("stamps: a stamp", '[data-testid="stamp"]');
      await M("stamps: Edit stamps", '[data-testid="stamp-edit"]');
      // the one-time offer (quick fixes are not turned on in this world) on its own tint
      await page.locator('[data-testid="suggest-offer-go"]').waitFor({ timeout: 5000 });
      await M("suggest offer: line", '[data-testid="suggest-offer"] p');
      await M("suggest offer: Turn on", '[data-testid="suggest-offer-go"]');
      await M("suggest offer: No thanks", '[data-testid="suggest-offer-no"]');
      await page.locator('[data-testid="stamp-edit"]').click();
      await page.waitForTimeout(300);
      await M("stamps edit: Save", '[data-testid="stamp-save"]');
      await M("stamps edit: Done", '[data-testid="stamp-done"]');
      await M("stamps edit: Add a stamp", '[data-testid="stamp-add"]');
      await page.locator('[data-testid="stamp-save"]').evaluate((el) => (el.disabled = true)); // what a Save in flight looks like
      await page.waitForTimeout(300);
      await M("stamps edit: Save (disabled)", '[data-testid="stamp-save"]');
      await page.locator('[data-testid="stamp-done"]').click();
      await page.locator('[data-testid="stamp"]').first().evaluate((el) => (el.disabled = true)); // a blocked box (read-only tab)
      await page.waitForTimeout(300);
      await M("stamps: a stamp (disabled)", '[data-testid="stamp"]');
      await page.close();
    });
  });
}


describe("contrast, phone (390 x 844): dock, bottom sheet, toast, dialog", () => {
  for (const theme of ["light", "dark"]) {
    test(`dock, sheet and toast text over the field and the document (${theme})`, async () => {
      const file = w.doc("long.docx");
      const copy = w.doc(`p-${theme}.docx`);
      fs.copyFileSync(file, copy);
      const poll = w.spawnCli(["poll", copy]);
      const page = await br.page();
      await page.setViewportSize({ width: 390, height: 844 });
      await page.addInitScript((t) => localStorage.setItem("onionskin.theme", t), theme);
      await page.goto(await w.open(copy));
      await waitDoc(page);
      await page.locator('[data-testid="banner-listening"]').waitFor({ timeout: 20000 });
      await page.waitForTimeout(1200);
      const M = (n, s, o) => measure(page, theme, `phone ${n}`, s, o);
      await M("toast: listening", '[data-testid="banner-listening"]');
      await M("dock: mode (active)", ".dock .mode.on");
      await M("dock: Send pill (empty)", ".dock .send-pill");
      await M("top bar: file name", ".topbar .fname");
      await M("top bar: state pill", ".topbar .pill");
      // open the sheet at half height, then full
      await page.locator('[data-testid="sidebar-toggle"]').click();
      await page.waitForTimeout(900);
      await M("sheet: title", ".side-h h2");
      await M("sheet: subtitle", ".side-sub");
      await M("sheet: section heading", ".sec-h h3");
      await M("sheet: empty text", ".empty");
      await M("sheet: overall label", ".composer label");
      await page.locator('[data-testid="sheet-grab"]').click();
      await page.waitForTimeout(900);
      await M("sheet (full): section heading", ".sec-h h3");
      await M("sheet (full): overall label", ".composer label");
      // a note makes something to send: the count chip inside the blue Send pill of the dock
      await page.locator('[data-testid="overall-note"]').fill("Keep the tone formal.");
      await page.keyboard.press("Escape");
      await page.waitForTimeout(900);
      await M("dock: Send pill count", ".dock .send-pill .cnt");
      poll.child.kill();
      await page.close();
    });
  }
});

describe("contrast, verdict", () => {
  test("every measured pair meets AA (4.5:1 text, 3:1 icons)", async () => {
    assert.ok(results.length > 70, `${results.length} samples measured`);
    assert.deepEqual(failures, [], "text below its WCAG AA ratio on the real rendered backdrop");
  });
});
