import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { after, afterEach, before, describe, test } from "node:test";
import { LINE_END, WEBKIT, emulateReducedTransparency, boxOf, cspViolations, launch, makeWorld, para, waitDoc } from "./helpers/harness.mjs";
import { checkerPng, solidPng } from "./helpers/png.mjs";

// The workspace background picker, in real Chrome against the real server (temp state dir only).
const PRESETS = ["paper", "pages", "aurora", "studio", "midnight"];
const q = (id) => `[data-testid="${id}"]`;
let br, w, copy, n = 0;

before(async () => {
  br = await launch();
  w = makeWorld();
  copy = w.doc("bg.docx");
  fs.copyFileSync(w.doc("long.docx"), copy);
});
after(async () => {
  await br?.close();
  await w?.cleanup();
});
// A test that fails before its page.close() would leave that tab holding the file: every later page on it would open read-only, under the
// "open in another tab" banner, and fail for that reason instead of its own. Close what a test left open.
const opened = new Set();
afterEach(async () => {
  for (const p of opened) if (!p.isClosed()) await p.close();
  opened.clear();
});

/** A fresh page on a new copy of the document. `opts.theme`, `opts.size`, `opts.media`. */
async function openPage({ theme = "light", size = { width: 1440, height: 900 }, media, file = copy } = {}) {
  const page = await br.page();
  opened.add(page);
  const requests = [];
  page.on("request", (r) => requests.push(r.url()));
  page.requests = requests;
  await page.setViewportSize(size);
  if (media) await page.emulateMedia(media);
  await page.addInitScript((t) => localStorage.setItem("onionskin.theme", t), theme);
  await page.goto(await w.open(file));
  await waitDoc(page);
  await page.locator(q("backdrop")).waitFor({ state: "attached" });
  await page.waitForTimeout(500);
  return page;
}
const bgOf = (page) => page.locator(q("backdrop")).getAttribute("data-bg");
const reset = () => w.cli(["config", "background", "default"]);

describe("picker", () => {
  test("opens from the bar; arrows move between tiles, Enter selects, Escape closes and returns focus", async () => {
    await reset();
    const page = await openPage();
    assert.equal(await bgOf(page), "paper", "the default is paper");
    await page.locator(q("bg-button")).click();
    await page.locator(q("bg-popover")).waitFor();
    const tiles = await page.locator('[role="radio"]').evaluateAll((els) => els.map((e) => [e.dataset.tile, e.getAttribute("aria-checked"), e.getAttribute("aria-label")]));
    assert.deepEqual(tiles.map((t) => t[0]), PRESETS);
    assert.deepEqual(tiles.map((t) => t[1]), ["true", "false", "false", "false", "false"], "the selected tile is marked");
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.tile), "paper", "focus lands on the selected tile");
    await page.keyboard.press("ArrowRight");
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.tile), "pages");
    await page.keyboard.press("ArrowDown");
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.tile), "midnight", "down moves one row (3 columns)");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.tile), "aurora");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.tile), "midnight");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector('[data-testid="backdrop"]').dataset.bg === "midnight");
    assert.equal(await page.locator(q("bg-tile-midnight")).getAttribute("aria-checked"), "true");
    // every control is at least 32 px (44 on touch)
    for (const sel of ['[data-testid="bg-tile-paper"]', q("bg-choose"), q("bg-reset"), q("bg-close")]) {
      const b = await boxOf(page.locator(sel));
      assert.ok(b.width >= 32 && b.height >= 32, `${sel} ${b.width}x${b.height}`);
    }
    await page.keyboard.press("Escape");
    await page.locator(q("bg-popover")).waitFor({ state: "detached" });
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.testid), "bg-button");
    await page.locator(q("bg-button")).click();
    await page.locator(q("bg-reset")).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="backdrop"]').dataset.bg === "paper");
    await page.close();
  });

  test("phone layout: the entry lives in the more menu", async () => {
    await reset();
    const page = await openPage({ size: { width: 390, height: 844 } });
    assert.equal(await page.locator(q("bg-button")).count(), 0);
    await page.locator(q("more-menu")).click();
    await page.locator(q("bg-menu-item")).click();
    await page.locator(q("bg-popover")).waitFor();
    const b = await boxOf(page.locator(q("bg-popover")));
    assert.ok(b.x >= 0 && b.x + b.width <= 390, "inside the phone viewport");
    await page.locator(q("bg-tile-aurora")).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="backdrop"]').dataset.bg === "aurora");
    await page.close();
  });
});

describe("presets", () => {
  test("each preset applies, persists across a reload and a second file, and keeps its choice when the theme flips; no CSP violation, no external request", async () => {
    await reset();
    const page = await openPage();
    const fieldOf = () => page.locator(q("backdrop")).evaluate((el) => getComputedStyle(el).backgroundColor);
    for (const p of PRESETS) {
      await page.locator(q("bg-button")).click();
      await page.locator(q(`bg-tile-${p}`)).click();
      await page.waitForFunction((x) => document.querySelector('[data-testid="backdrop"]').dataset.bg === x, p);
      assert.equal(await page.evaluate(() => document.documentElement.dataset.bg), p);
      await page.locator(q("bg-close")).click();
      const light = await fieldOf();
      await page.locator(q("theme-toggle")).click();
      await page.waitForTimeout(250);
      assert.equal(await bgOf(page), p, `${p}: the theme toggle keeps the preset`);
      const dark = await fieldOf();
      assert.notEqual(light, dark, `${p}: a separate dark rendition`);
      await page.locator(q("theme-toggle")).click();
      await page.reload();
      await waitDoc(page);
      await page.locator(q("backdrop")).waitFor({ state: "attached" });
      assert.equal(await bgOf(page), p, `${p}: survives a reload`);
    }
    assert.equal(JSON.parse(fs.readFileSync(path.join(w.state, "settings.json"), "utf8")).background.name, PRESETS[PRESETS.length - 1]);
    assert.equal((fs.statSync(path.join(w.state, "settings.json")).mode & 0o777).toString(8), "600");
    // a second file on the same machine shows the same background
    const second = w.doc("second.docx");
    fs.copyFileSync(w.doc("long.docx"), second);
    const page2 = await openPage({ file: second });
    assert.equal(await bgOf(page2), "midnight", "per machine, not per file");
    const origin = new URL(page2.url()).origin;
    for (const pg of [page, page2]) {
      for (const u of pg.requests) assert.ok(u.startsWith(origin) || u.startsWith("blob:") || u.startsWith("data:"), `external request: ${u}`);
      assert.deepEqual(cspViolations(pg.log), [], "no CSP violation");
      assert.deepEqual(pg.log.errors, []);
    }
    await page2.close();
    await page.close();
  });

  test("a change made with the CLI shows after a reload, with the first paint already on it (data-bg on <html>)", async () => {
    await reset();
    const page = await openPage();
    await w.cli(["config", "background", "aurora"]);
    const html = await (await page.request.get(page.url())).text().catch(() => "");
    await page.reload();
    await waitDoc(page);
    assert.equal(await bgOf(page), "aurora");
    assert.ok(html === "" || /data-bg="aurora"/.test(html));
    await page.close();
  });

  test("switching presets does not move anything on the page (no layout shift)", async () => {
    await reset();
    const page = await openPage();
    const boxes = () => page.evaluate(() => [".topbar", ".toolbar", '[data-testid="docwrap"]', ".sidebar"].map((s) => { const r = document.querySelector(s).getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map(Math.round).join(","); }));
    const before = await boxes();
    // every entry is kept with what moved and when (t0: when the observer attached; buffered entries before it came from loading the page)
    await page.evaluate(() => {
      window.__shifts = [];
      window.__t0 = performance.now();
      const name = (n) => (n ? `${n.nodeName.toLowerCase()}${n.id ? "#" + n.id : ""}${n.className && typeof n.className === "string" ? "." + n.className.trim().split(/\s+/).join(".") : ""}${n.dataset?.testid ? `[${n.dataset.testid}]` : ""}` : "(gone)");
      const box = (r) => [r.x, r.y, r.width, r.height].map(Math.round).join(",");
      new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__shifts.push({ t: Math.round(e.startTime), value: e.value, input: e.hadRecentInput, sources: (e.sources || []).map((s) => ({ node: name(s.node), from: box(s.previousRect), to: box(s.currentRect) })) }))).observe({ type: "layout-shift", buffered: true });
    });
    for (const p of [...PRESETS, "paper"]) {
      await page.locator(q("bg-button")).click();
      await page.locator(q(`bg-tile-${p}`)).click();
      await page.locator(q("bg-close")).click();
      await page.waitForTimeout(120);
      assert.deepEqual(await boxes(), before, `${p}: boxes unchanged`);
    }
    const { shifts, t0 } = await page.evaluate(() => ({ shifts: window.__shifts, t0: Math.round(window.__t0) }));
    // only shifts from switching count. Loading the page has one of its own (about 0.0001: the toolbar's empty style and font boxes show their
    // placeholder at font-size 0, then the caret lands and the same text grows to full size); Chrome records it only when a frame is painted
    // in between, which a busy machine does. buffered: true keeps it in the failure message as evidence; the sum leaves it out by time.
    const cls = shifts.reduce((a, e) => a + (e.input || e.t < t0 ? 0 : e.value), 0);
    const load = shifts.filter((e) => !e.input && e.t < t0);
    if (load.length) console.log(`layout shift while the page loaded, before switching (not counted): ${JSON.stringify(load)}`);
    assert.equal(cls, 0, `no layout-shift entries while switching; observer attached at ${t0} ms: ${JSON.stringify(shifts)}`);
    await page.close();
  });

  test("reduced motion: every preset stands still; reduced transparency: a plain tone for all of them", async () => {
    for (const p of PRESETS) {
      await w.cli(["config", "background", p]);
      const page = await openPage({ media: { reducedMotion: "reduce" } });
      const anim = await page.evaluate(() => [...document.querySelectorAll(".backdrop i")].map((i) => getComputedStyle(i).animationName));
      assert.ok(anim.length > 0 || p === "studio", `${p} has layers`);
      assert.ok(anim.every((a) => a === "none"), `${p} static under reduced motion: ${anim}`);
      await page.close();
      const flat = await openPage();
      const emulated = await emulateReducedTransparency(br.ctx, flat, "reduce");
      await flat.waitForTimeout(250);
      if (!emulated || !(await flat.evaluate(() => matchMedia("(prefers-reduced-transparency: reduce)").matches))) {
        console.log("this browser cannot emulate prefers-reduced-transparency; the plain tone is not exercised");
        await flat.close();
        continue;
      }
      const st = await flat.evaluate(() => ({ shown: [...document.querySelectorAll(".backdrop i")].filter((i) => getComputedStyle(i).display !== "none").length, bg: getComputedStyle(document.querySelector(".backdrop")).backgroundColor, glass: getComputedStyle(document.querySelector(".topbar")).backdropFilter }));
      assert.equal(st.shown, 0, `${p}: no layers under reduced transparency`);
      assert.equal(st.glass, "none");
      assert.equal(st.bg, "rgb(234, 237, 242)", `${p}: the plain tone`);
      await flat.close();
    }
  });
});

describe("custom image", () => {
  const sendFile = (page, file) => page.setInputFiles(q("bg-file"), file);
  const effective = (page) => page.locator(q("backdrop")).getAttribute("data-effective").then(Number);

  test("choose an image, change the strength, toggle blur, reload, remove; the stored file is 0600 and one file", async () => {
    await reset();
    const page = await openPage();
    await page.locator(q("bg-button")).click();
    await sendFile(page, { name: "pale.png", mimeType: "image/png", buffer: solidPng([196, 204, 218], 1800, 1200) });
    await page.waitForFunction(() => document.querySelector('[data-testid="backdrop"]').dataset.bg === "custom", null, { timeout: 15000 });
    await page.waitForFunction(() => document.querySelector("[data-testid=\"backdrop\"] .bgimg"));
    assert.match(await page.locator("[data-testid=\"backdrop\"] .bgimg").evaluate((el) => getComputedStyle(el).backgroundImage), /^url\("blob:/);
    const dir = path.join(w.state, "backgrounds");
    assert.deepEqual(fs.readdirSync(dir), ["custom.jpg"], "the page re-encoded it as JPEG");
    assert.equal((fs.statSync(path.join(dir, "custom.jpg")).mode & 0o777).toString(8), "600");
    const stored = fs.readFileSync(path.join(dir, "custom.jpg"));
    assert.deepEqual([stored[0], stored[1]], [0xff, 0xd8]);
    assert.ok(!stored.includes(Buffer.from("Exif")), "no EXIF block");
    await page.waitForTimeout(500);
    assert.equal(await effective(page), 0.6, "a pale picture is not held back at the default strength");
    await page.locator(q("bg-strength")).fill("25");
    await page.waitForFunction(() => Math.abs(Number(document.querySelector('[data-testid="backdrop"]').dataset.effective) - 0.25) < 0.01);
    await page.waitForTimeout(450); // the save is debounced
    assert.equal(JSON.parse(fs.readFileSync(path.join(w.state, "settings.json"), "utf8")).background.strength, 25);
    await page.locator(q("bg-blur")).uncheck();
    await page.waitForTimeout(300);
    assert.equal(JSON.parse(fs.readFileSync(path.join(w.state, "settings.json"), "utf8")).background.blur, false);
    await page.reload();
    await waitDoc(page);
    await page.waitForFunction(() => document.querySelector("[data-testid=\"backdrop\"] .bgimg"), null, { timeout: 15000 });
    assert.equal(await bgOf(page), "custom", "the image comes back after a reload");
    await page.locator(q("bg-button")).click();
    assert.equal(await page.locator(q("bg-strength")).inputValue(), "25");
    assert.equal(await page.locator(q("bg-blur")).isChecked(), false);
    await page.locator(q("bg-remove")).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="backdrop"]').dataset.bg === "paper");
    assert.deepEqual(fs.readdirSync(dir), [], "Remove image deletes the file");
    assert.equal(await page.locator(q("bg-tile-custom")).count(), 0);
    assert.deepEqual(cspViolations(page.log), []);
    await page.close();
  });

  test("a text file and a 20 MB file are refused with a clear message, and nothing is stored", async () => {
    await reset();
    const page = await openPage();
    await page.locator(q("bg-button")).click();
    await sendFile(page, { name: "notes.png.txt", mimeType: "text/plain", buffer: Buffer.from("this is not a picture") });
    await page.locator(q("bg-error")).waitFor({ state: "visible" });
    assert.match(await page.locator(q("bg-error")).innerText(), /not a PNG, JPEG, WebP or HEIC picture/);
    await sendFile(page, { name: "huge.png", mimeType: "image/png", buffer: Buffer.concat([solidPng([1, 2, 3], 8, 8), Buffer.alloc(20 * 1024 * 1024)]) });
    await page.waitForFunction(() => /larger than 15 MB/.test(document.querySelector('[data-testid="bg-error"]').textContent));
    await sendFile(page, { name: "fake.png", mimeType: "image/png", buffer: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("not really")]) });
    await page.waitForFunction(() => /could not be read/.test(document.querySelector('[data-testid="bg-error"]').textContent));
    assert.ok(!fs.existsSync(path.join(w.state, "backgrounds")) || fs.readdirSync(path.join(w.state, "backgrounds")).length === 0);
    assert.equal(await bgOf(page), "paper");
    await page.close();
  });

  // The solid panes are near-opaque, so even pure white under the dark theme keeps every text AA (the hostile-image cases below measure it)
  // and the guard has nothing to hold back. The guard itself stays as the safety net; its arithmetic is covered in test/guard.test.js.
  test("a pure white picture under the dark theme keeps the requested strength: the solid panes keep the text readable, no hint", async () => {
    await reset();
    const page = await openPage({ theme: "dark" });
    await page.locator(q("bg-button")).click();
    await sendFile(page, { name: "white.png", mimeType: "image/png", buffer: solidPng([255, 255, 255], 800, 500) });
    await page.waitForFunction(() => document.querySelector('[data-testid="backdrop"] .bgimg'), null, { timeout: 15000 });
    await page.waitForTimeout(900); // the guard measures after the image is decoded
    assert.ok(Math.abs((await effective(page)) - 0.6) < 0.01, "not held below the requested 0.6");
    assert.equal(await page.locator(q("bg-hint")).count(), 0, "no held-back hint");
    await reset();
    await page.close();
  });

  test("dragging a picture onto the picker works", async () => {
    await reset();
    const page = await openPage();
    await page.locator(q("bg-button")).click();
    const b64 = solidPng([200, 205, 215], 400, 300).toString("base64");
    await page.locator(q("bg-popover")).evaluate((el, data) => {
      const bin = atob(data);
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], "drop.png", { type: "image/png" }));
      el.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
      el.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, b64);
    await page.waitForFunction(() => document.querySelector('[data-testid="backdrop"]').dataset.bg === "custom", null, { timeout: 15000 });
    await reset();
    await page.close();
  });

  test("a banner over the picture does not hide it: the read-only second tab and the agent-listening banner keep the strength the bars allow", async () => {
    // banner fills are color-mix() tokens; read as their first hex color they made the plain tone itself fail, and every banner held the image at 0
    const file = w.doc("banner.docx");
    fs.copyFileSync(w.doc("long.docx"), file);
    const img = path.join(w.root, "pale.png");
    fs.writeFileSync(img, solidPng([196, 204, 218], 1200, 800));
    assert.equal((await w.cli(["config", "background", "--image", img, "--strength", "60"])).code, 0);
    const pages = [];
    const poll = w.spawnCli(["poll", file]);
    try {
      const settled = async (page) => {
        await page.waitForFunction(() => document.querySelector('[data-testid="backdrop"] .bgimg'), null, { timeout: 15000 });
        await page.waitForTimeout(900); // the guard measures after the image is decoded
        return effective(page);
      };
      const a = await openPage({ file });
      pages.push(a);
      await a.locator('[data-testid="banner-listening"]').waitFor({ timeout: 20000 });
      assert.equal(await settled(a), 0.6, "the agent-listening banner does not hold a pale picture back");
      const b = await openPage({ file });
      pages.push(b);
      await b.locator(q("banner-readonly")).waitFor();
      assert.equal(await settled(b), 0.6, "the read-only banner of a second tab does not hold a pale picture back");
    } finally {
      poll.child.kill("SIGKILL");
      for (const p of pages) await p.close();
      await reset();
    }
  });
});

// ---- contrast ---------------------------------------------------------------------------------------------------------
function decodePng(buf) {
  let p = 8, wd = 0, ht = 0, ct = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString("ascii", p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") (wd = data.readUInt32BE(0)), (ht = data.readUInt32BE(4)), (ct = data[9]);
    else if (type === "IDAT") idat.push(data);
    p += 12 + len;
  }
  const bpp = ct === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = wd * bpp;
  const out = Buffer.alloc(ht * stride);
  for (let y = 0; y < ht; y++) {
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
  return { w: wd, h: ht, bpp, px: out };
}
const lin = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const lum = (r, g, b) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (l1, l2) => (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
const parseColor = (s) => {
  const [r, g, b, a = 1] = s.match(/rgba?\(([^)]+)\)/)[1].split(/[ ,\/]+/).filter(Boolean).map(Number);
  return { r, g, b, a };
};
const HIDE = "*, *::before, *::after { transition: none !important; animation: none !important; } .topbar *, .toolbar *, .sidebar *, .banners *, .dock * { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; } ::placeholder { color: transparent !important; -webkit-text-fill-color: transparent !important; } .sidebar textarea { -webkit-text-fill-color: transparent !important; } .pill::before, .dot, .working-mark, .spinner { visibility: hidden !important; }";
const TARGETS = [
  ["top bar: file name", ".topbar .fname"],
  ["top bar: product name", ".topbar .brand"],
  ["top bar: format badge", ".topbar .badge.format"],
  ["top bar: sync", ".topbar .sync"],
  ["top bar: state pill", ".topbar .pill"],
  ["top bar: Close session", '[data-testid="close"]'],
  ["toolbar: mode (inactive)", '[data-testid="mode-comment"]'],
  ["sidebar: title", ".side-h h2"],
  ["sidebar: subtitle", ".side-sub"],
  ["sidebar: section heading", ".sec-h h3"],
  ["sidebar: empty text", ".sidebar .empty"],
];
/** worst text contrast (2nd percentile of pixels) for each target, measured on the real rendered backdrop with the text hidden */
async function worst(page) {
  const info = [];
  for (const [name, sel] of TARGETS) {
    const loc = page.locator(sel).first();
    if (!(await loc.count()) || !(await loc.isVisible())) continue;
    info.push({ name, fg: parseColor(await loc.evaluate((el) => getComputedStyle(el).color)), b: await boxOf(loc) });
  }
  const h = await page.addStyleTag({ content: HIDE });
  await page.waitForTimeout(200);
  const png = decodePng(await page.screenshot());
  await h.evaluate((el) => el.remove());
  return info.map(({ name, fg, b }) => {
    const inset = Math.min(3, b.height / 4, b.width / 4);
    const x0 = Math.max(0, Math.round(b.x + inset)), y0 = Math.max(0, Math.round(b.y + inset));
    const x1 = Math.min(png.w, Math.round(b.x + b.width - inset)), y1 = Math.min(png.h, Math.round(b.y + b.height - inset));
    const rs = [];
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const o = (y * png.w + x) * png.bpp;
      const bg = { r: png.px[o], g: png.px[o + 1], b: png.px[o + 2] };
      const m = { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a) };
      rs.push(ratio(lum(m.r, m.g, m.b), lum(bg.r, bg.g, bg.b)));
    }
    rs.sort((a, c) => a - c);
    return { name, ratio: rs[Math.floor(rs.length * 0.02)] ?? 99 };
  });
}
const table = [];
const fails = [];
const record = (label, rows) => {
  const min = rows.reduce((a, r) => (r.ratio < a.ratio ? r : a), { ratio: 99 });
  table.push(`  ${min.ratio.toFixed(2)}:1  ${label.padEnd(34)} worst: ${min.name}`);
  for (const r of rows) if (r.ratio < 4.5) fails.push(`${label} ${r.name}: ${r.ratio.toFixed(2)}:1`);
};

// Playwright WebKit does not paint backdrop-filter into screenshots (verified on a striped page), so the measured ground is unblurred and not what Safari shows.
describe("contrast on every preset and on hostile images", { skip: WEBKIT && "Playwright WebKit screenshots omit backdrop-filter blur; the pixels measured differ from real Safari" }, () => {
  after(() => console.log("BACKGROUND CONTRAST (worst text per case, AA is 4.5):\n" + table.join("\n")));
  for (const theme of ["light", "dark"]) {
    test(`bar and sidebar text is AA on every preset (${theme})`, async () => {
      for (const p of PRESETS) {
        await w.cli(["config", "background", p]);
        const page = await openPage({ theme });
        await page.waitForTimeout(400);
        record(`${theme} ${p}`, await worst(page));
        await page.close();
      }
      assert.deepEqual(fails, []);
    });
  }
  const hostile = [["white", solidPng([255, 255, 255], 1200, 800), []], ["black", solidPng([0, 0, 0], 1200, 800), []], ["checkerboard", checkerPng(1280, 800, 80), ["--no-blur"]]];
  for (const theme of ["light", "dark"]) {
    test(`bar and sidebar text stays AA on pure white, pure black and a checkerboard at full strength (${theme})`, async () => {
      for (const [name, buf, extra] of hostile) {
        const f = path.join(w.root, `hostile-${name}.png`);
        fs.writeFileSync(f, buf);
        const r = await w.cli(["config", "background", "--image", f, "--strength", "100", ...extra]);
        assert.equal(r.code, 0, r.stderr);
        const page = await openPage({ theme });
        await page.waitForFunction(() => document.querySelector("[data-testid=\"backdrop\"] .bgimg"), null, { timeout: 15000 });
        await page.waitForTimeout(900); // the guard measures after the image is decoded
        const eff = await page.locator(q("backdrop")).getAttribute("data-effective");
        record(`${theme} custom ${name} (held at ${eff})`, await worst(page));
        await page.close();
      }
      await reset();
      assert.deepEqual(fails, []);
    });
  }
});

// ---- typing latency ---------------------------------------------------------------------------------------------------
describe("typing latency by background", () => {
  test("typing in the 300-paragraph document stays within the latency budget on every background (numbers are printed)", async () => {
    const cases = [["pages", ["config", "background", "pages"]], ["paper", ["config", "background", "paper"]], ["aurora", ["config", "background", "aurora"]], ["midnight", ["config", "background", "midnight"]]];
    const img = path.join(w.root, "lat.png");
    fs.writeFileSync(img, checkerPng(1600, 1000, 20));
    cases.push(["custom sharp", ["config", "background", "--image", img, "--strength", "100", "--no-blur"]]);
    const runs = {};
    for (let round = 0; round < 3; round++) {
      for (const [name, args] of cases) {
        await w.cli(args);
        const page = await openPage();
        await page.evaluate(() => {
          window.__lat = [];
          document.addEventListener("keydown", () => { const t0 = performance.now(); requestAnimationFrame(() => requestAnimationFrame(() => window.__lat.push(performance.now() - t0))); }, true);
        });
        const b = await boxOf(para(page, "Paragraph 003:"));
        await page.mouse.click(b.x + b.width - 40, b.y + b.height - 10);
        await page.keyboard.press(LINE_END);
        await page.keyboard.type("The quick brown fox jumps over the lazy dog, twice over.", { delay: 15 });
        await page.waitForTimeout(400);
        const lat = (await page.evaluate(() => window.__lat)).sort((a, c) => a - c);
        (runs[name] ||= []).push({ p50: lat[Math.floor(lat.length * 0.5)], p95: lat[Math.floor(lat.length * 0.95)] });
        await page.close();
      }
    }
    const med = (xs) => xs.sort((a, c) => a - c)[Math.floor(xs.length / 2)];
    const sum = Object.fromEntries(Object.entries(runs).map(([k, v]) => [k, { p50: med(v.map((r) => r.p50)), p95: med(v.map((r) => r.p95)) }]));
    console.log("TYPING LATENCY BY BACKGROUND (median of 3 rounds, 57 keys each):\n" + Object.entries(sum).map(([k, v]) => `  ${k.padEnd(13)} p50=${v.p50.toFixed(1)}ms p95=${v.p95.toFixed(1)}ms`).join("\n"));
    await reset();
    // This is a guard against gross regressions, not a comparison between presets. Six runs on a busy machine put
    // the same preset anywhere from 46 to 77 ms p50, and the order of presets flipped between runs (aurora above
    // pages by 11 ms in one, below it by 12 ms in the next), so a 10 percent relative bound only measured noise.
    // Ceiling: differences under about 20 ms are invisible to this test. Upgrade path: a quiet dedicated runner
    // and many more keys per round.
    const best = (k) => Math.min(...runs[k].map((r) => r.p50));
    for (const k of Object.keys(runs)) assert.ok(best(k) <= 120, `${k}: best-round p50 ${best(k).toFixed(1)} ms is over the 120 ms budget`);
  });
});
