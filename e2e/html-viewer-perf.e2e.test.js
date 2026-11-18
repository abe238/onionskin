// HtmlViewer at the size limits, measured in the browser (Chrome by default; ONIONSKIN_BROWSER=webkit too, where there is no longtask API
// and the timer gap is the measure). 1: a render copy of about 43 MB (a 9 MB page with 180,000 elements and 30 MB of inlined images, the
// most the render copy holds) mounts with no main-thread task over 1 second. 2: on a page with about 200,000 elements, one tick of the
// selection poll costs under 1 ms, with a selection held and while typing. The numbers are printed as `# perf:` lines.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { launch, WEBKIT } from "./helpers/harness.mjs";
import { makePng } from "./helpers/png.mjs";
import { startViewerPage } from "./helpers/html-viewer/serve.mjs";

let demo;
let dir;
let b;
const BIG_ROWS = 90_000; // two elements each: 180,000, under the 200,000 limit with room for the rest
const POLL_ROWS = 99_990; // 199,980 elements

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "da-hvperf-"));
  // three noise images, 7.3 MB each: 22 MB raw, 29.3 MB as base64 in the copy (the copy's cap is 30 MB)
  for (const n of [1, 2, 3]) {
    const noise = crypto.randomBytes(2600 * 940 * 3); // random pixels do not compress
    fs.writeFileSync(path.join(dir, `img${n}.png`), makePng(2600, 940, (x, y) => noise.subarray((y * 2600 + x) * 3, (y * 2600 + x) * 3 + 3)));
  }
  const rows = [];
  for (let i = 0; i < BIG_ROWS; i++) rows.push(`<p class="row">Row ${i} of the report, with enough words to read like a sentence in a table. <b>bold</b></p>\n`);
  const big = `<!doctype html><html><head><title>Big</title></head><body><img src="img1.png" alt="1"><img src="img2.png" alt="2"><img src="img3.png" alt="3">\n${rows.join("")}</body></html>`;
  const prow = [];
  for (let i = 0; i < POLL_ROWS; i++) prow.push(`<p>Line ${i} <i>it</i></p>`);
  const poll = `<!doctype html><html><head><title>Poll</title></head><body>${prow.join("")}</body></html>`;
  demo = await startViewerPage({ big: { bytes: Buffer.from(big), fileDir: dir }, poll: { bytes: Buffer.from(poll), fileDir: dir } });
  b = await launch();
});
after(async () => {
  await b?.close();
  demo?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A page that records long tasks (Chromium) and the longest gap of a 10 ms timer (both engines) from before the page's own code runs. */
async function measuredPage() {
  const page = await b.page();
  await page.addInitScript(() => {
    window.__perf = { long: 0, gap: 0 };
    try {
      new PerformanceObserver((l) => l.getEntries().forEach((e) => (window.__perf.long = Math.max(window.__perf.long, e.duration)))).observe({ type: "longtask", buffered: true });
    } catch {
      /* WebKit: no longtask entries */
    }
    let last = performance.now();
    setInterval(() => {
      const now = performance.now();
      window.__perf.gap = Math.max(window.__perf.gap, now - last - 10);
      last = now;
    }, 10);
  });
  return page;
}

test("a render copy of about 43 MB mounts with no main-thread task over 1 second", async () => {
  const meta = await (await fetch(`${demo.base}/meta?f=big`)).json();
  const size = Number((await fetch(`${demo.base}/copy?f=big`)).headers.get("content-length"));
  assert.equal(meta.stats.assets.shown, 3, `the three images are in the copy: ${JSON.stringify(meta.stats.assets)}`);
  assert.ok(size > 40 * 1024 * 1024, `the copy is ${(size / 1048576).toFixed(1)} MB`);
  const page = await measuredPage();
  const t0 = Date.now();
  await page.goto(demo.url("big"));
  await page.waitForFunction(() => window.__h && document.querySelector('[data-testid="html-viewer"]')?.dataset.phase === "ready", null, { timeout: 120000 });
  const ready = Date.now() - t0;
  await page.waitForTimeout(1500); // the paint and the first ticks after load
  const p = await page.evaluate(() => ({ ...window.__perf, ...window.__h.stats() }));
  console.log(`# perf: ${WEBKIT ? "webkit" : "chromium"} copy ${(size / 1048576).toFixed(1)} MB, ready in ${ready} ms; longest task ${WEBKIT ? "n/a" : `${Math.round(p.long)} ms`}, longest 10 ms timer gap ${Math.round(p.gap)} ms; decode ${Math.round(p.decodeMs)} ms, srcdoc set ${Math.round(p.srcdocMs)} ms, text index ${Math.round(p.indexMs)} ms`);
  if (!WEBKIT) assert.ok(p.long < 1000, `longest task ${p.long} ms`);
  assert.ok(p.gap < 1000, `longest timer gap ${p.gap} ms`);
  await page.close();
});

test("the selection poll costs under 1 ms per tick on a page with about 200,000 elements", async () => {
  const page = await measuredPage();
  await page.goto(demo.url("poll"));
  await page.waitForFunction(() => window.__h && document.querySelector('[data-testid="html-viewer"]')?.dataset.phase === "ready", null, { timeout: 120000 });
  const count = await page.evaluate(() => document.querySelector('[data-testid="html-frame"]').contentDocument.getElementsByTagName("*").length);
  assert.ok(count >= 199_000, `${count} elements in the frame`);
  // a selection across two paragraphs (its anchor is the body: the costliest mapping), held while the poll runs
  await page.evaluate(() => {
    const d = document.querySelector('[data-testid="html-frame"]').contentDocument;
    const ps = d.getElementsByTagName("p");
    const r = d.createRange();
    r.setStart(ps[50_000].firstChild, 2);
    r.setEnd(ps[50_001].firstChild, 3);
    const s = d.getSelection();
    s.removeAllRanges();
    s.addRange(r);
  });
  await page.waitForFunction(() => window.__ev.sel.some((s) => s && s.quote), null, { timeout: 10000 });
  const s0 = await page.evaluate(() => window.__h.stats());
  await page.waitForTimeout(2000);
  const held = await page.evaluate(() => window.__h.stats());
  // typing in a paragraph: the element is compared on every tick
  const pos = await page.evaluate(() => {
    const f = document.querySelector('[data-testid="html-frame"]');
    const p = f.contentDocument.getElementsByTagName("p")[3];
    const r = p.getBoundingClientRect();
    const fr = f.getBoundingClientRect();
    return { x: fr.left + f.clientLeft + r.left + 10, y: fr.top + f.clientTop + r.top + r.height / 2 };
  });
  await page.mouse.click(pos.x, pos.y);
  await page.waitForFunction(() => document.querySelector('[data-testid="html-frame"]').contentDocument.getElementsByTagName("p")[3].isContentEditable, null, { timeout: 5000 });
  const before = await page.evaluate(() => window.__h.stats());
  await page.keyboard.type("typing here", { delay: 60 });
  await page.waitForTimeout(500);
  const typed = await page.evaluate(() => window.__h.stats());
  const edits = await page.evaluate(() => window.__h.edits().length);
  const avg = (a, z) => (z.tickSum - a.tickSum) / Math.max(1, z.ticks - a.ticks);
  const heldAvg = avg(s0, held);
  const typedAvg = avg(before, typed);
  console.log(`# perf: ${WEBKIT ? "webkit" : "chromium"} ${count} elements; text index ${Math.round(held.indexMs)} ms; poll tick with a selection held: mean ${heldAvg.toFixed(3)} ms over ${held.ticks - s0.ticks} ticks; while typing: mean ${typedAvg.toFixed(3)} ms over ${typed.ticks - before.ticks} ticks; slowest tick of the run ${typed.tickMax.toFixed(2)} ms; mapping the cross-paragraph selection once ${held.anchorMax.toFixed(1)} ms; making the text editable ahead ${Math.round(typed.armMs)} ms of work, done ${typed.armDoneMs ? `${Math.round(typed.armDoneMs)} ms after load` : "not yet"}; slowest compare under the caret ${typed.hostMax.toFixed(2)} ms, of the others ${typed.scanMax.toFixed(2)} ms`);
  assert.equal(edits, 1);
  assert.ok(heldAvg < 1, `poll tick with a selection held: ${heldAvg} ms`);
  assert.ok(typedAvg < 1, `poll tick while typing: ${typedAvg} ms`);
  await page.close();
});
