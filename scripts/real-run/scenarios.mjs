// What the simulated user does in the browser for each scenario. `drive(page)` makes the edits and comments and returns
// {texts: [the comment texts], overall: the overall note, probe: async () => y of the key element relative to the document top, or null}.
import { boxOf, center, gotoSlide, openSheet, scrollToPara, shapeBox, until, visibleSlide, xlsxCell } from "../../e2e/helpers/harness.mjs";
import { DEMO } from "../demo/demo-scenario.mjs";

const docTop = (page) => page.evaluate(() => document.querySelector('[data-testid="docwrap"]').getBoundingClientRect().top);
/** y of a viewport box relative to the top of the document viewport (immune to layout changes above it); null when it is not rendered. */
const relY = async (page, box) => (box ? box.y - (await docTop(page)) : null);
const NOTE = (page, text) => page.locator('[data-testid="overall-note"]').fill(text);
const cardTextarea = (page) => page.locator('[data-testid="comment-card"] textarea').last();

/** y (px, relative to the top of the document viewport) of the highlight of the first text comment, or the first pin mark. */
const highlightProbe = (page) => async () => {
  const el = page.locator('[data-testid="highlight"]').first();
  if (!(await el.count())) return null;
  const b = await el.boundingBox();
  return b ? b.y - (await docTop(page)) : null;
};

/** Selects a paragraph's text (triple click) or, when no chip appears, its first word, then writes the comment through the chip. */
export async function commentOnParagraph(page, startsWith, text) {
  const chip = page.locator('[data-testid="comment-chip"]');
  for (let attempt = 0; attempt < 4; attempt++) {
    const loc = await scrollToPara(page, startsWith);
    await page.waitForTimeout(400);
    const b = await boxOf(loc);
    if (attempt % 2 === 0) await page.mouse.click(b.x + 80, b.y + 10, { clickCount: 3 });
    else await page.mouse.dblclick(b.x + 60, b.y + 10);
    if (await chip.waitFor({ timeout: 3000 }).then(() => true, () => false)) {
      await chip.click();
      await cardTextarea(page).fill(text);
      return;
    }
  }
  throw new Error(`no comment chip appeared for the paragraph starting "${startsWith}"`);
}

async function pinOnParagraph(page, locator, text) {
  await page.locator('[data-testid="mode-pin"]').click();
  await locator.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  const b = await boxOf(locator);
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await page.locator('[data-testid="comment-card"][data-kind="pin"] textarea').last().fill(text);
  await page.locator('[data-testid="mode-edit"]').click();
}

async function typeAtEnd(page, startsWith, typed) {
  const loc = await scrollToPara(page, startsWith);
  const b = await boxOf(loc);
  await page.mouse.click(b.x + b.width - 20, b.y + b.height - 8);
  await page.keyboard.press("End");
  await page.keyboard.type(typed);
  await page.locator('[data-testid="change-item"]').first().waitFor({ timeout: 10000 });
}

export const SCENARIO_UI = {
  "docx-basic": {
    probe: ".de-p",
    async drive(page) {
      await typeAtEnd(page, "This report summarizes operations", " AMENDED");
      const texts = ["Tighten this sentence and keep the number.", "Add a total row."];
      const overall = "Make every heading bold.";
      await commentOnParagraph(page, "Revenue reached 4.2 million", texts[0]);
      await scrollToPara(page, "Orders grew in every region");
      await pinOnParagraph(page, page.locator(".de-p").filter({ hasText: /^South$/ }).first(), texts[1]);
      await NOTE(page, overall);
      await page.waitForTimeout(800);
      await scrollToPara(page, "Revenue reached 4.2 million");
      return { texts, overall, probe: highlightProbe(page) };
    },
  },

  "docx-injection": {
    probe: ".de-p",
    async drive(page) {
      const texts = ["Fix the typo in this paragraph."];
      await commentOnParagraph(page, "The quarterly figures were recieved", texts[0]);
      await page.waitForTimeout(800);
      return { texts, probe: highlightProbe(page) };
    },
  },

  "docx-protected": {
    probe: ".de-p",
    async drive(page) {
      const texts = ["Update this heading text to say Overview", "Change the word quick to rapid here."];
      // the table-of-contents line is a field: select its words (or, failing that, pin it)
      const toc = await scrollToPara(page, "Introduction");
      const b = await boxOf(page.locator(".de-p").filter({ hasText: /^Introduction$/ }).first());
      await page.mouse.dblclick(b.x + 30, b.y + b.height / 2);
      const chip = page.locator('[data-testid="comment-chip"]');
      if (await chip.waitFor({ timeout: 4000 }).then(() => true, () => false)) {
        await chip.click();
        await cardTextarea(page).fill(texts[0]);
      } else {
        await pinOnParagraph(page, page.locator(".de-p").filter({ hasText: /^Introduction$/ }).first(), texts[0]);
      }
      await commentOnParagraph(page, "The quick onboarding plan", texts[1]);
      await page.waitForTimeout(800);
      return { texts, probe: highlightProbe(page) };
    },
  },

  // the letter the demo page replays (see scripts/demo). Three comments and an overall note, all on plain paragraphs. The words live in
  // scripts/demo/demo-scenario.mjs, because the recorder accepts no others.
  "demo-docx": {
    probe: ".de-p",
    async drive(page) {
      const texts = DEMO.comments.map((c) => c.text);
      const overall = DEMO.overall;
      for (const c of DEMO.comments) await commentOnParagraph(page, c.on, c.text);
      await NOTE(page, overall);
      await page.waitForTimeout(800);
      await scrollToPara(page, "Welcome to Maple Court");
      return { texts, overall, probe: highlightProbe(page) };
    },
  },

  // the most common thing a person sends: an overall note only, no comment and no selection (the background agent cannot open the file)
  "docx-note-only": {
    probe: ".de-p",
    async drive(page) {
      const overall = "Change the title at the top of the document to: Quarterly review approved";
      await NOTE(page, overall);
      await page.waitForTimeout(800);
      const para = () => page.locator(".de-p").filter({ hasText: /^This report summarizes operations/ }).first();
      return { texts: [], overall, probe: async () => relY(page, await para().boundingBox()) };
    },
  },

  // a note about a place far past what fits inline: the background agent must read the batch's outline file to find it
  "docx-note-end": {
    probe: ".de-p",
    async drive(page) {
      const overall = "In the closing remarks at the end, change the harbor office sentence so it reopens on the first Monday of April.";
      await NOTE(page, overall);
      await page.waitForTimeout(800);
      const para = () => page.locator(".de-p").filter({ hasText: /^This report summarizes operations/ }).first();
      return { texts: [], overall, probe: async () => relY(page, await para().boundingBox()) };
    },
  },

  // a note whose natural target is hidden under a merge: the title is merged over A1:D1, so B1 is covered and the first empty cell of row 1 is E1
  "xlsx-merged-note": {
    probe: ".de-sheet",
    async drive(page) {
      await openSheet(page, "Budget");
      const overall = "Add the note 'Checked' in the first empty cell of row 1.";
      await until(() => xlsxCell(page, "Office rent", "C"), "Budget rows rendered");
      await NOTE(page, overall);
      await page.waitForTimeout(800);
      return { texts: [], overall, probe: async () => relY(page, await xlsxCell(page, "Office rent", "C")) };
    },
  },

  // an overall note that adds a table row: the background agent needs insert_table_row, with the numbers of a cell's body_path
  "docx-table-row": {
    probe: ".de-p",
    async drive(page) {
      const overall = "Add a row to the orders table with these values: West, 88, 92";
      await NOTE(page, overall);
      await page.waitForTimeout(800);
      const para = () => page.locator(".de-p").filter({ hasText: /^This report summarizes operations/ }).first();
      return { texts: [], overall, probe: async () => relY(page, await para().boundingBox()) };
    },
  },

  // an overall note that adds a slide: the background agent needs duplicate_slide, with the copy's title set in the same op
  "pptx-duplicate-slide": {
    probe: ".de-slide",
    where: (page) => visibleSlide(page),
    async drive(page) {
      const overall = "Duplicate slide 2 and change its title to: Strategy recap";
      await page.waitForTimeout(1200);
      await NOTE(page, overall);
      await page.waitForTimeout(800);
      return { texts: [], overall, probe: async () => relY(page, await page.evaluate(() => { const r = document.querySelector('.de-slide-frame[data-slide="1"]')?.getBoundingClientRect(); return r ? { y: r.top } : null; })) };
    },
  },

  "xlsx-basic": {
    probe: ".de-sheet",
    async drive(page) {
      await openSheet(page, "Budget");
      const texts = ["This looks too high, set it to 1200.", "Add a Total row below this range with SUM formulas."];
      const overall = "Format all money cells as currency.";
      await until(() => xlsxCell(page, "Conference travel", "C"), "Budget rows rendered");
      await page.locator('[data-testid="mode-comment"]').click();
      const c = await xlsxCell(page, "Conference travel", "C");
      await page.mouse.click(center(c).x, center(c).y);
      await cardTextarea(page).fill(texts[0]);
      // a dragged range: Amount and Tax of every line
      const a = await xlsxCell(page, "Office rent", "C");
      const z = await xlsxCell(page, "Insurance", "D");
      await page.mouse.move(a.x + 10, a.y + 5);
      await page.mouse.down();
      await page.mouse.move(z.x + 20, z.y + 5, { steps: 6 });
      await page.mouse.up();
      await cardTextarea(page).fill(texts[1]);
      await page.locator('[data-testid="mode-edit"]').click();
      await NOTE(page, overall);
      await page.waitForTimeout(800);
      return { texts, overall, probe: async () => relY(page, await xlsxCell(page, "Conference travel", "C")) };
    },
  },

  "pptx-basic": {
    probe: ".de-slide",
    // the app restores a deck's view by slide (not by pixel offset): the assertion is "the same slide is in view", the px offset is only recorded
    where: (page) => visibleSlide(page),
    async drive(page) {
      const texts = ["Shorten this title to five words or fewer.", "Add a subtitle saying Draft."];
      const overall = "Replace 2025 with 2026 everywhere.";
      await page.waitForTimeout(1200);
      await gotoSlide(page, 2);
      await page.locator('[data-testid="mode-comment"]').click();
      const t = await shapeBox(page, 2, 2);
      if (!t) throw new Error("title shape (id 2) of slide 2 is not rendered");
      await page.mouse.click(t.x + t.w * 0.5, t.y + t.h * 0.5);
      await cardTextarea(page).fill(texts[0]);
      await page.locator('[data-testid="mode-edit"]').click();
      await gotoSlide(page, 1);
      await page.locator('[data-testid="mode-pin"]').click();
      const s1 = await page.evaluate(() => {
        const r = document.querySelector('.de-slide-frame[data-slide="1"] .de-slide').getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height };
      });
      await page.mouse.click(s1.x + s1.w * 0.975, s1.y + s1.h * 0.5);
      await page.locator('[data-testid="comment-card"][data-kind="pin"] textarea').last().fill(texts[1]);
      await page.locator('[data-testid="mode-edit"]').click();
      await NOTE(page, overall);
      await page.waitForTimeout(800);
      await gotoSlide(page, 2);
      return { texts, overall, probe: async () => relY(page, await page.evaluate(() => { const r = document.querySelector('.de-slide-frame[data-slide="2"]')?.getBoundingClientRect(); return r ? { y: r.top } : null; })) };
    },
  },
};
