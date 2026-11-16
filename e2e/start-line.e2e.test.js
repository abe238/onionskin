import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, test } from "node:test";
import { boxOf, launch, makeWorld, waitDoc } from "./helpers/harness.mjs";

// The "no agent is listening" banner offers a Start button (it runs the background agent) and says how to use Claude Code yourself. No command line.
// It fits at phone width.
const q = (id) => `[data-testid="${id}"]`;
let br, w;
before(async () => {
  br = await launch();
  w = makeWorld();
});
after(async () => {
  await br?.close();
  await w?.cleanup();
});

test("stranded banner: a Start button and the /onionskin way, no command line; no overflow at 390 px", async () => {
  const file = w.doc("start-line.docx");
  fs.copyFileSync(w.doc("long.docx"), file);
  const page = await br.page();
  await page.goto(await w.open(file));
  await waitDoc(page);
  await page.locator(q("overall-note")).fill("Start line check.");
  await page.locator(q("send")).click();
  await page.locator(q("banner-stranded")).waitFor({ timeout: 10000 });
  const start = page.locator(q("agent-start"));
  assert.equal((await start.textContent()).trim(), "Start the agent");
  const text = await page.locator(q("banner-stranded")).textContent();
  assert.match(text, /Press Start and Onionskin runs an agent in the background for you\. Using Claude Code yourself\? Type \/onionskin \/[^\n]*\/start-line\.docx there\./, "the full path: a Claude Code session is rarely in the file's folder");
  assert.ok(!/onionskin poll|onionskin '/.test(text), "no command line");
  assert.equal(await page.locator(q("stranded-command")).count() + (await page.locator(q("stranded-start")).count()) + (await page.locator(q("copy-command")).count()), 0);
  for (const [width, height] of [[390, 844], [360, 740]]) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(500);
    const scroll = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth - document.documentElement.clientWidth, body: document.body.scrollWidth - document.body.clientWidth }));
    assert.deepEqual(scroll, { doc: 0, body: 0 }, `no horizontal scroll at ${width}`);
    const b = await boxOf(page.locator(q("banner-stranded")));
    const s = await boxOf(start);
    assert.ok(b.x >= 0 && b.x + b.width <= width + 0.5, `banner inside the viewport at ${width}`);
    assert.ok(s.x >= b.x && s.x + s.width <= b.x + b.width + 0.5, `the Start button inside the banner at ${width}`);
  }
  await page.close();
});
