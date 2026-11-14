import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { boxOf, launch, makeWorld, para, waitDoc } from "./helpers/harness.mjs";

// Engine popovers must be readable: opaque and above the toolbar and the comment chip (screens: node scripts/popovers.mjs).
describe("engine popovers", () => {
  let w, br;
  before(async () => {
    w = makeWorld();
    br = await launch();
  });
  after(async () => {
    await br?.close();
    await w?.cleanup();
  });

  test("the context menu opens above the toolbar and the comment chip, with every item reachable", async () => {
    const page = await br.page();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(await w.open(w.doc("long.docx")));
    await waitDoc(page);
    await page.waitForTimeout(1500);
    const b = await boxOf(para(page, "Paragraph 003:"));
    await page.mouse.dblclick(b.x + 120, b.y + 10); // a selection, so the comment chip is showing too
    await page.mouse.click(b.x + 120, b.y + 10, { button: "right" });
    const menu = page.locator(".de-ctx");
    await menu.waitFor();
    const covered = await page.evaluate(() => {
      const m = document.querySelector(".de-ctx").getBoundingClientRect();
      const bad = [];
      for (const [name, x, y] of [["top-left", m.left + 12, m.top + 12], ["top-right", m.right - 12, m.top + 12], ["bottom-left", m.left + 12, m.bottom - 12], ["bottom-right", m.right - 12, m.bottom - 12]]) {
        const hit = document.elementFromPoint(x, y);
        if (!hit?.closest(".de-ctx")) bad.push(`${name}: ${hit?.className || hit?.tagName}`);
      }
      return { bad, top: m.top };
    });
    assert.deepEqual(covered.bad, [], "something sits on top of the menu");
    assert.ok(covered.top >= 0, "the menu starts inside the window");
    assert.ok(await menu.getByText("Cut", { exact: true }).isVisible(), "the first item is shown");
    await page.close();
  });
});
