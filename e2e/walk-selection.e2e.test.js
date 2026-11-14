import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { agentEdit, boxOf, haveSamples, launch, makeWorld, python, skipUnless, until, waitDoc, xlsxCell, xlsxScrollTo, openSheet } from "./helpers/harness.mjs";

// What a person sees when they select, comment and ask in a Word file whose pages end in a footer (the real-walk findings).
/** Waits until the paragraph is in view and has stopped moving (the engine draws the last pages as it scrolls to them and their heights settle a moment later). */
async function settle(page, p) {
  let last = null;
  let since = 0;
  await until(async () => {
    const top = (await boxOf(p)).y;
    const y = top + (await page.evaluate(() => document.querySelector(".de-scroll").scrollHeight)); // the paragraph's place and the length of the document it is in
    if (top <= 0 || last === null || Math.abs(y - last) > 1) {
      last = y;
      since = Date.now();
      return false;
    }
    return Date.now() - since > 600;
  }, "the paragraph to be in view and still");
}
const WORDS = ["Revenue for the third quarter reached $4.2 million.", "Maria Chen will present the hiring plan on March 14.", "Please send the signed forms to David Okafor.", "Teh warehouse in Reno shipped 2,900 orders last week."];

/** The engine's sample (header, footer, table) with a few plain paragraphs after its last one. */
function memo(w) {
  const file = w.copySample("sample.docx", "memo.docx");
  execFileSync(python, ["-", file, ...WORDS], { input: "import sys, docx\nd = docx.Document(sys.argv[1])\nfor t in sys.argv[2:]:\n    d.add_paragraph(t)\nd.save(sys.argv[1])\n" });
  return file;
}

describe("selecting in a Word file", { skip: skipUnless(haveSamples(), "the engine sample") }, () => {
  let w, br, page;
  before(async () => {
    w = makeWorld();
    br = await launch();
    page = await br.page();
    await page.goto(await w.open(memo(w)));
    await waitDoc(page);
  });
  after(async () => {
    await br?.close();
    await w?.cleanup();
  });

  /** The paragraph with these words, at the end of the file (the engine draws pages as they come into view). */
  const atEnd = async (words) => {
    const p = page.locator(".de-p", { hasText: words }).first();
    await until(async () => {
      await page.evaluate(() => (document.querySelector(".de-scroll").scrollTop = 1e9));
      return (await p.count()) > 0;
    }, `"${words}" to be drawn`);
    await p.evaluate((e) => e.scrollIntoView({ block: "center" }));
    await settle(page, p);
    return p;
  };
  const chips = () => page.locator('[data-testid="comment-chip"]').count();
  const clear = async () => {
    await page.keyboard.press("Escape");
    await page.evaluate(() => getSelection().removeAllRanges());
    await until(async () => (await chips()) === 0, "the chip to go");
  };

  for (const [name, i] of [["a middle", 1], ["the last", 3]]) {
    test(`triple-click on ${name} paragraph shows the chip`, async () => {
      const p = await atEnd(WORDS[i]);
      const b = await boxOf(p);
      await page.mouse.click(b.x + 30, b.y + b.height / 2, { clickCount: 3 });
      await until(async () => (await chips()) === 1, "the chip after a triple-click");
      assert.equal(await page.locator('[data-testid="quick-ask-chip"]').count(), 1, "Ask is there too");
      assert.ok((await page.evaluate(() => String(getSelection()))).includes(WORDS[i]), "the selection holds the whole paragraph the chip is for");
      await clear();
    });
  }

  test("dragging from the start of the last paragraph to past its end shows the chip", async () => {
    const p = await atEnd(WORDS[3]);
    const b = await boxOf(p);
    await page.mouse.move(b.x + 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width - 10, b.y + b.height + 30, { steps: 8 });
    await page.mouse.up();
    await until(async () => (await chips()) === 1, "the chip after a drag past the end");
    await clear();
  });

  test("one triple-click in Comment mode makes one comment, not three", async () => {
    const p = await atEnd(WORDS[1]);
    await page.locator('[data-testid="mode-comment"]').click();
    const b = await boxOf(p);
    const cards = page.locator('[data-testid="comment-card"]');
    const before = await cards.count();
    await page.mouse.click(b.x + 30, b.y + b.height / 2, { clickCount: 3 });
    await until(async () => (await cards.count()) > before, "the comment card");
    await page.waitForTimeout(700); // the extra clicks of the gesture are already in by now
    assert.equal((await cards.count()) - before, 1);
    // a later click, a new gesture, still comments
    const q = await atEnd(WORDS[2]);
    const c = await boxOf(q);
    await page.mouse.click(c.x + 30, c.y + c.height / 2);
    await until(async () => (await cards.count()) === before + 2, "a second comment from a second click");
  });

  /** The part of the chip's box that lies over any text of the document, in px squared, and whether the chip is inside the document's view. */
  const chipOverText = () =>
    page.evaluate(() => {
      const c = document.querySelector('[data-testid="comment-chip-group"]').getBoundingClientRect();
      const view = document.querySelector('[data-testid="docwrap"]').getBoundingClientRect();
      let area = 0;
      const over = [];
      for (const p of document.querySelectorAll('[data-testid="docwrap"] .de-p')) {
        const pb = p.getBoundingClientRect();
        if (pb.bottom < c.top || pb.top > c.bottom || pb.right < c.left || pb.left > c.right) continue;
        const r = document.createRange();
        r.selectNodeContents(p);
        for (const t of r.getClientRects()) {
          if (t.width < 1) continue;
          const ox = Math.min(c.right, t.right) - Math.max(c.left, t.left);
          const oy = Math.min(c.bottom, t.bottom - 3) - Math.max(c.top, t.top + 3); // a glyph box is a little taller than the letters
          if (ox > 0 && oy > 0) {
            area += ox * oy;
            over.push(p.textContent.slice(0, 20));
          }
        }
      }
      return { area, over, inside: c.left >= view.left && c.right <= view.right && c.top >= view.top && c.bottom <= view.bottom };
    });

  test("the chip does not sit on the text above a selected sentence when it can go beside or below it, and stays inside the page", async () => {
    await page.locator('[data-testid="mode-edit"]').click(); // the earlier test left Comment mode on
    const p = await atEnd(WORDS[0]);
    const b = await boxOf(p);
    await page.mouse.click(b.x + 30, b.y + b.height / 2, { clickCount: 3 });
    await until(async () => (await chips()) === 1, "the chip");
    await page.waitForTimeout(400); // placed on the next frames
    const m = await chipOverText();
    assert.equal(m.area, 0, `the chip covers text: ${JSON.stringify(m.over)}`);
    assert.ok(m.inside, "the chip is inside the page");
    await clear();
  });

  describe("the Quick ask box", () => {
    const box = () => page.locator('[data-testid="quick-ask"]');
    const open = async (words) => {
      const p = await atEnd(words);
      const b = await boxOf(p);
      await page.mouse.click(b.x + 30, b.y + b.height / 2, { clickCount: 3 });
      await until(async () => (await chips()) === 1, "the chip");
      await page.locator('[data-testid="quick-ask-chip"]').click();
      await box().waitFor();
      return p;
    };
    const closed = () => until(async () => (await box().count()) === 0, "the box to close");
    before(async () => {
      await page.locator('[data-testid="mode-edit"]').click(); // the earlier test left Comment mode on
    });

    test("Esc closes the box when the focus is in the document, not in the box", async () => {
      await open(WORDS[0]);
      const q = await atEnd(WORDS[0]);
      const b = await boxOf(q);
      await page.mouse.click(b.x + 40, b.y + b.height / 2); // a click on the asked words puts the focus in the document and leaves the box open
      await page.waitForTimeout(500);
      assert.equal(await box().count(), 1, "the box is still open after a click on its words");
      assert.equal(await page.evaluate(() => !!document.activeElement.closest('[data-testid="quick-ask"]')), false, "the focus is outside the box");
      await page.keyboard.press("Escape");
      await closed();
    });

    test("Esc from the document leaves the reader where they are and keeps what was typed as an unsent comment", async () => {
      await open(WORDS[0]);
      await page.locator('[data-testid="quick-ask-text"]').fill("make this formal");
      const cards = page.locator('[data-testid="comment-card"]');
      const before = await cards.count();
      const q = await atEnd(WORDS[0]);
      const b = await boxOf(q);
      await page.mouse.click(b.x + 40, b.y + b.height / 2); // a single click on the asked words: a caret, the box stays
      await page.waitForTimeout(500);
      assert.equal(await box().count(), 1, "the box is still open after a click on its words");
      await page.keyboard.press("Escape");
      await closed();
      await page.waitForTimeout(400); // the old code put the first words back on the next frame
      const sel = await page.evaluate(() => String(getSelection()));
      assert.ok(!sel.includes("Revenue for the third quarter"), `the first words were selected again: "${sel}"`);
      await until(async () => (await cards.count()) === before + 1, "the typed words to stay as a comment");
      assert.ok((await cards.last().innerText().catch(() => "")).includes("make this formal") || (await cards.last().locator("textarea").inputValue().catch(() => "")).includes("make this formal"));
    });

    test("Esc inside a dialog in the document or during text composition leaves the box open", async () => {
      await open(WORDS[0]);
      const dispatched = await page.evaluate(() => {
        const el = document.querySelector('[data-testid="docwrap"] .de-p');
        const d = document.createElement("div");
        d.setAttribute("role", "dialog");
        d.tabIndex = 0;
        el.closest('[data-testid="docwrap"]').appendChild(d);
        d.focus();
        d.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
        d.remove();
        el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, isComposing: true }));
        return true;
      });
      assert.ok(dispatched);
      await page.waitForTimeout(300);
      assert.equal(await box().count(), 1, "the box stayed");
      await page.locator('[data-testid="quick-ask-text"]').focus();
      await page.keyboard.press("Escape"); // the box's own Esc still works
      await closed();
    });

    test("selecting other words closes the box and keeps what was typed as an unsent comment, with the new words selected", async () => {
      await open(WORDS[0]);
      await page.locator('[data-testid="quick-ask-text"]').fill("Make it shorter please");
      // other words in view that the box does not cover (it floats beside the words it asks about)
      const other = await page.evaluate(() => {
        const qa = document.querySelector('[data-testid="quick-ask"]').getBoundingClientRect();
        const sc = document.querySelector(".de-scroll").getBoundingClientRect();
        for (const p of document.querySelectorAll(".de-p")) {
          const r = p.getBoundingClientRect();
          const clear = r.right < qa.left || r.left > qa.right || r.bottom < qa.top || r.top > qa.bottom;
          if (!p.closest(".de-hf") && p.textContent.trim().length > 15 && r.top > sc.top + 20 && r.bottom < sc.bottom - 20 && clear && !p.textContent.startsWith("Revenue")) return { x: r.left + 30, y: r.top + r.height / 2, words: p.textContent.slice(0, 12) };
        }
        return null;
      });
      assert.ok(other, "some other words are in view");
      const cards = page.locator('[data-testid="comment-card"]');
      const before = await cards.count();
      await page.mouse.click(other.x, other.y, { clickCount: 3 });
      await closed();
      await until(async () => (await cards.count()) === before + 1, `the typed text to stay as a comment (${before} cards before, ${await cards.count()} now)`);
      assert.ok((await cards.last().innerText()).includes("Make it shorter please") || (await cards.last().locator("textarea").inputValue().catch(() => "")).includes("Make it shorter please"));
      await until(async () => (await chips()) === 1, "the chip for the new words");
      assert.ok((await page.evaluate(() => String(getSelection()))).includes(other.words));
    });

    /** A point in other words that the box does not cover, away from the sentence the box asks about. */
    const otherPoint = () =>
      page.evaluate(() => {
        const qa = document.querySelector('[data-testid="quick-ask"]').getBoundingClientRect();
        const sc = document.querySelector(".de-scroll").getBoundingClientRect();
        for (const p of document.querySelectorAll(".de-p")) {
          const r = p.getBoundingClientRect();
          const clear = r.right < qa.left || r.left > qa.right || r.bottom < qa.top || r.top > qa.bottom;
          if (!p.closest(".de-hf") && p.textContent.trim().length > 15 && r.top > sc.top + 20 && r.bottom < sc.bottom - 20 && clear && !p.textContent.startsWith("Revenue")) return { x: r.left + 30, y: r.top + r.height / 2, words: p.textContent.slice(0, 12) };
        }
        return null;
      });
    /** Where the caret is: the paragraph's text before it, and the whole paragraph. */
    const caret = () =>
      page.evaluate(() => {
        const s = getSelection();
        const p = s.focusNode?.parentElement?.closest(".de-p");
        if (!p) return null;
        const r = document.createRange();
        r.setStart(p, 0);
        r.setEnd(s.focusNode, s.focusOffset);
        return { before: r.toString(), text: p.textContent, collapsed: s.isCollapsed };
      });

    test("a click inside the asked sentence, in the box, on the panel or on a toolbar control leaves the box open", async () => {
      const p = await open(WORDS[0]);
      await page.locator('[data-testid="quick-ask-text"]').fill("keep me");
      const inside = await page.evaluate(() => {
        const r = document.querySelector('[data-testid="quick-outline"]').getBoundingClientRect();
        return { x: r.left + Math.min(40, r.width / 2), y: r.top + r.height / 2 };
      });
      await page.mouse.click(inside.x, inside.y);
      await page.waitForTimeout(500);
      assert.equal(await box().count(), 1, "still open after a click inside the sentence");
      await page.locator('[data-testid="quick-ask-text"]').click();
      assert.equal(await box().count(), 1, "still open after a click in the box");
      await page.locator("#review-panel").click({ position: { x: 20, y: 20 } });
      await page.waitForTimeout(300);
      assert.equal(await box().count(), 1, "still open after a click on the panel");
      await page.locator('[data-testid="mode-edit"]').click();
      await page.waitForTimeout(300);
      assert.equal(await box().count(), 1, "still open after a click on a toolbar control");
      await page.locator('[data-testid="quick-ask-text"]').focus();
      await page.keyboard.press("Escape");
      await closed();
      assert.ok(p);
    });
    // last in the group: it types a letter, and the engine redraws its pages for a while after an edit, which would move the next test's scroll
    test("a plain click elsewhere in the document closes the box, keeps what was typed, leaves the caret where it was clicked and does not scroll", async () => {
      await open(WORDS[0]);
      await page.locator('[data-testid="quick-ask-text"]').fill("Make it warmer");
      const other = await otherPoint();
      assert.ok(other, "some other words are in view");
      const cards = page.locator('[data-testid="comment-card"]');
      const before = await cards.count();
      const top0 = await page.evaluate(() => document.querySelector(".de-scroll").scrollTop);
      await page.mouse.click(other.x, other.y);
      await closed();
      await until(async () => (await cards.count()) === before + 1, `the typed words to stay as an unsent comment (${before} cards before, ${await cards.count()} now)`);
      assert.ok((await cards.last().innerText().catch(() => "")).includes("Make it warmer") || (await cards.last().locator("textarea").inputValue().catch(() => "")).includes("Make it warmer"));
      await until(async () => (await page.locator('[data-testid="quick-outline"]').count()) === 0, "the highlight on the old sentence to go");
      const at = await caret();
      assert.ok(at && at.collapsed && at.text.startsWith(other.words), `the caret is in the paragraph that was clicked: ${JSON.stringify(at)}`);
      await page.keyboard.type("Z");
      const after = await caret();
      assert.equal(after.before, at.before + "Z", "the letter landed exactly at the click");
      assert.equal(after.text, at.text.slice(0, at.before.length) + "Z" + at.text.slice(at.before.length));
      const top1 = await page.evaluate(() => document.querySelector(".de-scroll").scrollTop);
      assert.ok(Math.abs(top1 - top0) <= 2, `the document scrolled from ${top0} to ${top1}`);
      await page.keyboard.press("Backspace");
    });

  });

  test("after Send with no agent listening and Take back, the first selection shows the Ask and Comment chip, twenty times in a row", async () => {
    await page.locator('[data-testid="mode-edit"]').click();
    const missed = [];
    const p = await atEnd(WORDS[1]);
    for (let i = 0; i < 20; i++) {
      await page.locator('[data-testid="overall-note"]').fill(`Check the tone ${i}.`);
      await page.locator('[data-testid="send"]').click();
      await page.locator('[data-testid="banner-stranded"]').waitFor({ timeout: 10000 });
      await page.locator('[data-testid="take-back"]').click();
      await page.waitForFunction(() => document.querySelector('[data-testid="state-pill"]').textContent.trim() === "Idle", null, { timeout: 10000 });
      const b = await boxOf(p); // no waiting for the page to settle: the person selects straight away
      await page.mouse.click(b.x + 30, b.y + b.height / 2, { clickCount: 3 }); // the very first selection after Take back, no reselecting
      const seen = await until(async () => (await chips()) === 1 && (await page.locator('[data-testid="quick-ask-chip"]').count()) === 1, "the chip", 3000).catch(() => false);
      if (!seen) missed.push(i);
      await clear();
    }
    assert.deepEqual(missed, [], `the chip did not show on the first selection after Take back in rounds ${missed}`);
  });

  test("Ask on a sentence, Send with no agent listening, Take back: selecting that sentence again shows the chip on the first try", async () => {
    // the editor reports a selection only when it differs from the one it reported last, and the sentence that was just asked about is still selected after the send
    const p = await atEnd(WORDS[2]);
    let b = await boxOf(p);
    await page.mouse.click(b.x + 30, b.y + b.height / 2, { clickCount: 3 });
    await until(async () => (await chips()) === 1, "the chip");
    await page.locator('[data-testid="quick-ask-chip"]').click();
    await page.locator('[data-testid="quick-ask-text"]').fill("Make it formal");
    await page.keyboard.press("ControlOrMeta+Enter");
    await page.locator('[data-testid="banner-stranded"]').waitFor({ timeout: 10000 });
    await until(async () => (await chips()) === 0 && (await page.locator('[data-testid="quick-ask"]').count()) === 0, "the box and the chip to be gone");
    await page.waitForTimeout(800); // longer than the short quiet time after a quick send
    await page.locator('[data-testid="take-back"]').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="state-pill"]').textContent.trim() === "Idle", null, { timeout: 10000 });
    b = await boxOf(p);
    await page.mouse.click(b.x + 30, b.y + b.height / 2, { clickCount: 3 });
    await until(async () => (await chips()) === 1, "the chip on the first selection after Take back", 3000);
    await clear();
  });
});

// The Quick ask card and the formatting bar, with the stand-in for the small writing model (nothing is downloaded and no model runs).
const SHORTER = "Make this shorter. Keep the meaning.";
const SENTS = ["Please note that the quarterly report is due on Friday at noon.", "Please note that the budget needs a second look from finance.", "Please note that the new pricing starts on the first of March."];
const SENT = SENTS[0];
const CELL = "Please note that this whole sentence sits in a table cell.";
const RACE = "Please note that the office closes early on the last Friday."; // for the reload that comes in the frame before the focus is back
const shorter = (s) => s.replace("Please note that t", "T");

describe("a suggestion card and the formatting bar", { skip: skipUnless(haveSamples(), "the engine sample") }, () => {
  let w, br, stub, page, file;
  before(async () => {
    stub = path.join(fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || "/tmp"), "ws-stub-")), "stub.json");
    fs.writeFileSync(stub, JSON.stringify(Object.fromEntries([...SENTS, RACE].map((x) => [`shorter\t${x}`, shorter(x)]))));
    w = makeWorld({ ONIONSKIN_NO_SOFFICE: "1", ONIONSKIN_REWRITER_STUB: stub });
    br = await launch();
    file = memo(w);
    execFileSync(python, ["-", file, ...SENTS, RACE, CELL], { input: "import sys, docx\nd = docx.Document(sys.argv[1])\nfor t in sys.argv[2:-1]:\n    d.add_paragraph(t)\nd.add_table(rows=1, cols=1).cell(0, 0).text = sys.argv[-1]\nd.save(sys.argv[1])\n" });
    page = await br.page();
    await page.addInitScript(() => sessionStorage.setItem("onionskin.histCollapsed", "0"));
    // Inert unless a test sets window.__race: it holds the answer to Use this and hands the file's reload event to the test
    await page.addInitScript(() => {
      const add = EventSource.prototype.addEventListener;
      EventSource.prototype.addEventListener = function (type, fn, ...rest) {
        const f = type === "reload" ? (e) => (window.__race?.reload ? window.__race.reload(() => fn.call(this, e)) : fn.call(this, e)) : fn;
        return add.call(this, type, f, ...rest);
      };
      const fetch0 = window.fetch;
      window.fetch = async (...a) => {
        const race = window.__race;
        const r = await fetch0(...a);
        if (race && String(a[0]).includes("/api/suggest/use")) await race.answer;
        return r;
      };
    });
    await page.goto(await w.open(file));
    await waitDoc(page);
  });
  after(async () => {
    await br?.close();
    await w?.cleanup();
    if (stub) fs.rmSync(path.dirname(stub), { recursive: true, force: true });
  });

  const bar = () => page.evaluate(() => [...document.querySelectorAll(".de-dd, .de-fs")].map((b) => b.textContent).join(" / "));
  const q = (id) => `[data-testid="${id}"]`;
  const atEnd = async (words) => {
    const p = page.locator(".de-p", { hasText: words }).first();
    await until(async () => {
      await page.evaluate(() => (document.querySelector(".de-scroll").scrollTop = 1e9));
      return (await p.count()) > 0;
    }, `"${words}" to be drawn`);
    await p.evaluate((e) => e.scrollIntoView({ block: "center" }));
    await settle(page, p);
    return p;
  };
  const toCard = async (sent = SENT) => {
    const b = await boxOf(await atEnd(sent));
    await page.mouse.click(b.x + 40, b.y + b.height / 2, { clickCount: 3 });
    await page.locator(q("quick-ask-chip")).click();
    await page.locator(q("quick-ask")).waitFor();
    await page.locator(q("stamp"), { hasText: /^Shorter$/ }).click();
    await page.locator(q("suggestion-use")).waitFor({ timeout: 10000 });
  };

  /** Selects characters [from, to) of the drawn paragraph with these words, as a drag would (a DOM range over its text). */
  const selectRange = (words, from, to) =>
    page.evaluate(([words, from, to]) => {
      const p = [...document.querySelectorAll(".de-p")].find((e) => e.textContent.includes(words));
      const tw = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
      const at = (n) => {
        let left = n;
        for (let t = tw.nextNode(); t; t = tw.nextNode()) {
          if (left <= t.length) return [t, left];
          left -= t.length;
        }
        return null;
      };
      tw.currentNode = p;
      const a = at(from);
      tw.currentNode = p;
      const b = at(to);
      const r = document.createRange();
      r.setStart(a[0], a[1]);
      r.setEnd(b[0], b[1]);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
      p.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    }, [words, from, to]);
  // the notice is for a stamp that can suggest, so it shows while the pointer is on one (the shipped list: Fix grammar)
  const hint = async () => {
    await page.locator(q("stamp"), { hasText: /^Fix grammar$/ }).hover();
    return page.locator(q("stamps-hint")).innerText();
  };
  const ONE = "Select one whole sentence to get a suggestion first.";

  test("re-selecting the same sentence without its end mark: one box at a time, the typed words kept, the notice for the box's own selection", async () => {
    const sent = SENTS[1];
    const cards = page.locator(q("comment-card"));
    const before = await cards.count();
    const b = await boxOf(await atEnd(sent));
    await page.mouse.click(b.x + 40, b.y + b.height / 2, { clickCount: 3 });
    await page.locator(q("quick-ask-chip")).click();
    await page.locator(q("quick-ask")).waitFor();
    assert.notEqual(await hint(), ONE, "a whole sentence needs no notice");
    await page.locator(q("quick-ask-text")).fill("keep it formal");
    // the same sentence, selected without its period
    await selectRange(sent, 0, sent.length - 1);
    await page.waitForTimeout(400);
    assert.ok((await page.locator(q("quick-ask")).count()) <= 1, "never two boxes");
    const inBox = (await page.locator(q("quick-ask")).count()) === 1 ? await page.locator(q("quick-ask-text")).inputValue() : "";
    const asComment = (await cards.count()) === before + 1 ? (await cards.last().innerText()) + (await cards.last().locator("textarea").inputValue().catch(() => "")) : "";
    assert.ok(inBox.includes("keep it formal") || asComment.includes("keep it formal"), `the typed words were lost (box: "${inBox}", cards ${before} -> ${await cards.count()})`);
    if ((await page.locator(q("quick-ask")).count()) === 0) {
      await until(async () => (await page.locator(q("comment-chip")).count()) === 1, "the chip for the new selection");
      await page.locator(q("quick-ask-chip")).click();
      await page.locator(q("quick-ask")).waitFor();
    }
    assert.equal(await page.locator(q("quick-ask")).count(), 1);
    assert.notEqual(await hint(), ONE, "the sentence without its end mark counts as the sentence");
    // half of it: the box now asks about that half, and the notice is for that half
    await selectRange(sent, 0, Math.floor(sent.length / 2));
    await until(async () => (await page.locator(q("quick-ask")).count()) === 0, "the box for the whole sentence to close");
    await until(async () => (await page.locator(q("comment-chip")).count()) === 1, "the chip for the half");
    await page.locator(q("quick-ask-chip")).click();
    await page.locator(q("quick-ask")).waitFor();
    assert.equal(await page.locator(q("quick-ask")).count(), 1);
    assert.equal(await hint(), ONE, "half a sentence: the notice shows for the selection the box holds");
    await page.keyboard.press("Escape");
    await page.locator(q("quick-ask-text")).focus().catch(() => {});
    if (await page.locator(q("quick-ask")).count()) await page.keyboard.press("Escape");
    await until(async () => (await page.locator(q("quick-ask")).count()) === 0, "the box to close");
  });

  test("the one-sentence line shows for half a sentence but never for words in a table cell, where selecting more cannot help", async () => {
    const ask = async (words, from, to) => {
      await atEnd(words);
      await selectRange(words, from, to);
      await until(async () => (await page.locator(q("comment-chip")).count()) === 1, "the chip");
      await page.locator(q("quick-ask-chip")).click();
      await page.locator(q("quick-ask")).waitFor();
    };
    const close = async () => {
      await page.locator(q("quick-ask-text")).focus();
      await page.keyboard.press("Escape");
      await until(async () => (await page.locator(q("quick-ask")).count()) === 0, "the box to close");
    };
    await ask(SENTS[2], 0, Math.floor(SENTS[2].length / 2));
    assert.equal(await hint(), ONE, "half a sentence in a paragraph: the line shows (the probe works)");
    await close();
    for (const [from, to] of [[0, CELL.length], [12, 16]]) {
      await ask(CELL, from, to);
      const line = await hint();
      assert.notEqual(line, ONE, `selection ${from}-${to} in a table cell shows the line that selecting more cannot satisfy`);
      await close();
    }
  });

  test("Esc closes the card, then the box, with the focus in the document", async () => {
    await toCard();
    const b = await boxOf(await atEnd(SENT));
    const hit = await page.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); return e.className + "/" + e.tagName; }, [b.x + 40, b.y + b.height / 2]);
    await page.mouse.click(b.x + 40, b.y + b.height / 2);
    await page.waitForTimeout(500);
    assert.equal(await page.locator(q("quick-ask")).count(), 1, `the box is still open after a click on its words (${hit})`);
    await page.keyboard.press("Escape");
    await until(async () => (await page.locator(q("suggestion")).count()) === 0, "the card to close");
    assert.equal(await page.locator(q("quick-ask")).count(), 1, "the first Esc leaves the box");
    await page.keyboard.press("Escape");
    await until(async () => (await page.locator(q("quick-ask")).count()) === 0, "the box to close");
  });

  test("after Use this the formatting bar shows the paragraph that holds the caret, never another one's style", async () => {
    // the title first: the caret was there last. Three sentences in a row: the old bug came and went with the timing of the reload
    await page.evaluate(() => (document.querySelector(".de-scroll").scrollTop = 0));
    const t = page.locator(".de-p", { hasText: /^Quarterly Report/ }).first();
    let n = 0;
    await until(async () => {
      await t.click({ position: { x: 20 + 37 * n++, y: 20 } }); // somewhere else each time, so it is never a double click
      await page.waitForTimeout(500);
      return /Title/.test(await bar());
    }, "the bar to show the title's style");
    const titleNow = () => page.evaluate(() => document.querySelector('.de-pages .de-p[data-bi="0"]')?.textContent ?? null);
    const title = await titleNow();
    assert.match(title, /^Quarterly Report/, "the probe reads the title");
    for (const sent of SENTS) {
      await toCard(sent);
      await page.locator(q("suggestion-use")).click();
      await until(async () => (await page.locator(".de-p", { hasText: shorter(sent) }).count()) > 0 && (await page.locator(".de-p", { hasText: sent }).count()) === 0, "the new sentence on screen", 30000);
      await page.waitForTimeout(1500); // the reload has settled
      const shown = await bar();
      assert.ok(!/Title|Heading|Subtitle/.test(shown), `after "${sent.slice(0, 30)}" the bar shows another paragraph's style: ${shown}`);
      // The caret is where typing goes: in the rewritten sentence's paragraph, in the editable pages (App.jsx returnToPlace). The reload used to
      // come between the box closing and the focus coming back, and the caret stayed where the new editor put its own, in the title
      const caret = await page.evaluate(() => {
        const s = getSelection();
        const n = s.anchorNode && (s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentElement);
        return { text: n?.closest(".de-p")?.textContent ?? null, collapsed: s.isCollapsed, editing: !!document.activeElement?.closest('[contenteditable="true"]') };
      });
      assert.ok(caret.text?.includes(shorter(sent)) && caret.collapsed && caret.editing, `after "${sent.slice(0, 30)}" the caret is not in the rewritten sentence: ${JSON.stringify(caret)}`);
      assert.match(shown, /^Normal text/, `after "${sent.slice(0, 30)}" the bar does not show the style of the paragraph with the caret`);
    }
    // what a person does next: types. The words go at the start of the last rewritten sentence (the paragraph at the place Use this asked about), never into the title
    await page.keyboard.type("Also, ");
    let landed = []; // the paragraphs on the pages (not the engine's hidden measuring copy)
    await until(async () => (landed = await page.evaluate(() => [...document.querySelectorAll(".de-pages .de-p[data-bi]")].filter((p) => p.textContent.includes("Also, ")).map((p) => p.textContent))).length > 0, "the typed words on the page", 5000).catch(() => {});
    assert.deepEqual(landed, ["Also, " + shorter(SENTS.at(-1))], "where the typed words landed");
    await until(async () => {
      await page.evaluate(() => (document.querySelector(".de-scroll").scrollTop = 0)); // the first page is drawn again
      return (await titleNow()) !== null;
    }, "the title to be drawn");
    assert.equal(await titleNow(), title, "the title is unchanged");
  });

  test("a reload that comes after the box closes but before the focus is back still puts the caret in the rewritten sentence, and typing goes there", async () => {
    // The order that put typing into the title: Use this is answered, the box closes (the focus comes back to the document on the next frame),
    // and the file's reload arrives in between. The test makes that order certain: the answer waits for the reload, the reload waits for the box to go.
    await page.evaluate(() => {
      let open;
      const race = (window.__race = { answer: new Promise((r) => (open = r)) });
      race.reload = (deliver) => {
        race.reload = null;
        const mo = new MutationObserver(() => {
          if (document.querySelector('[data-testid="quick-ask"]')) return;
          mo.disconnect();
          race.delivered = true;
          deliver();
        });
        mo.observe(document.body, { childList: true, subtree: true });
        open();
      };
    });
    try {
      await toCard(RACE);
      await page.locator(q("suggestion-use")).click();
      await until(async () => (await page.locator(".de-pages .de-p", { hasText: shorter(RACE) }).count()) > 0 && (await page.locator(".de-pages .de-p", { hasText: RACE }).count()) === 0, "the new sentence on screen", 30000);
      assert.equal(await page.evaluate(() => window.__race?.delivered), true, "the reload came after the box closed (the probe worked)");
    } finally {
      await page.evaluate(() => (window.__race = null));
    }
    await page.waitForTimeout(1500); // the reload has settled
    await page.keyboard.type("Kindly ");
    let landed = [];
    await until(async () => (landed = await page.evaluate(() => [...document.querySelectorAll(".de-pages .de-p[data-bi]")].filter((p) => p.textContent.includes("Kindly ")).map((p) => p.textContent))).length > 0, "the typed words on the page", 5000).catch(() => {});
    assert.deepEqual(landed, ["Kindly " + shorter(RACE)], "where the typed words landed");
    assert.match(await bar(), /^Normal text/, "the bar shows the style of the paragraph with the caret");
  });
});

describe("Comment mode in a spreadsheet", () => {
  test("a double-click on a cell makes one comment", async () => {
    const w = makeWorld({ ONIONSKIN_NO_SOFFICE: "1" });
    const br = await launch();
    try {
      const page = await br.page();
      await page.goto(await w.open(w.doc("budget.xlsx")));
      await waitDoc(page, ".de-sheet");
      await openSheet(page, "Budget");
      await xlsxScrollTo(page, "Line item 029", 10);
      await page.locator('[data-testid="mode-comment"]').click();
      await page.waitForTimeout(400);
      const c = await until(() => xlsxCell(page, "Line item 029", "D"), "a cell to be drawn");
      const cards = page.locator('[data-testid="comment-card"]');
      await page.mouse.dblclick(c.x + c.w / 2, c.y + c.h / 2);
      await until(async () => (await cards.count()) >= 1, "the comment card");
      await page.waitForTimeout(700);
      assert.equal(await cards.count(), 1);
    } finally {
      await br.close();
      await w.cleanup();
    }
  });
});
