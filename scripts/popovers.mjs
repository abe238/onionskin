#!/usr/bin/env node
// Captures every engine popover (Style, Font, Text color, More tools, context menu, XLSX number format, PPTX Insert) open, light and dark, into docs/screens/popover-*.png.
// Not part of npm test. Usage: node scripts/popovers.mjs [outDir]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boxOf, launch, makeWorld, para, waitDoc } from "../e2e/helpers/harness.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(process.argv[2] || path.join(root, "docs", "screens"));
fs.mkdirSync(OUT, { recursive: true });
const br = await launch();
const w = makeWorld();
const bar = (page, label) => page.locator(`[data-testid="editbar"] [aria-label^="${label}"]`).first();

async function session(file, theme) {
  const page = await br.page();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript((t) => localStorage.setItem("onionskin.theme", t), theme);
  await page.goto(await w.open(w.doc(file)));
  await waitDoc(page);
  await page.waitForTimeout(1800);
  return page;
}
const shot = async (page, name) => {
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, `popover-${name}.png`) });
  console.log("  ", name);
  await page.keyboard.press("Escape");
  await page.mouse.click(700, 600); // close anything still open
  await page.keyboard.press("Escape");
};

for (const theme of ["light", "dark"]) {
  console.log(theme);
  let page = await session("long.docx", theme);
  await para(page, "Paragraph 003:").scrollIntoViewIfNeeded();
  const b = await boxOf(para(page, "Paragraph 003:"));
  await page.mouse.click(b.x + 80, b.y + 10);
  await page.mouse.dblclick(b.x + 120, b.y + 10); // a word selected, so the format controls are live
  for (const [name, label] of [["docx-style", "Paragraph style"], ["docx-font", "Font"], ["docx-color", "Text color"], ["docx-more", "More tools"]]) {
    await bar(page, label).click();
    await shot(page, `${name}-${theme}`);
  }
  await page.mouse.click(b.x + 120, b.y + 10, { button: "right" });
  await shot(page, `docx-context-${theme}`);
  await page.close();

  page = await session("budget.xlsx", theme);
  await bar(page, "Number format").click();
  await shot(page, `xlsx-numberformat-${theme}`);
  await bar(page, "More tools").click();
  await shot(page, `xlsx-more-${theme}`);
  await page.close();

  page = await session("deck.pptx", theme);
  await bar(page, "Insert").click();
  await shot(page, `pptx-insert-${theme}`);
  await bar(page, "Slide").first().click();
  await shot(page, `pptx-slide-${theme}`);
  await page.close();
}
await br.close();
await w.cleanup();
