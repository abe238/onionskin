import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { agentEdit, boxOf, fakeAppleHelper, gotoSlide, launch, makeWorld, scrollToPara, shapeBox, until, waitDoc, wordPoint } from "./helpers/harness.mjs";

// Quick fixes through a real browser (the stub back end, ONIONSKIN_REWRITER_STUB: nothing is downloaded and no model runs): select one
// sentence, tap Shorter, read the card, Esc writes nothing, "Use this" writes through the local run, and a person without the helper set up
// gets today's stamp (the tap sends) plus the one-time offer. The document must not move on any click.
const q = (id) => `[data-testid="${id}"]`;
const SHORTER = "Make this shorter. Keep the meaning.";
const S1 = "Please note that the quarterly report is due on Friday at noon.";
const R1 = "The quarterly report is due on Friday at noon.";
const S2 = "Please note that the sketch shows <img src=x onerror=window.__pwned=1> here.";
const R2 = "The sketch shows <img src=x onerror=window.__pwned=1> here.";
const S3 = "Please note that the budget needs a second look.";
const S4 = "Please note that the lunch order closes on Thursday at noon.";
const R4 = "The lunch order closes on Thursday at noon.";
const S5 = "Please note that the model will not rewrite this sentence."; // the stand-in model refuses it
const S6 = 'Please note that the sign on the door says "Closd on Mondays" today.';
const R6 = 'Please note that the sign on the door says "Closed on Mondays" today.'; // a change inside quotes
const GRAMMAR = "Fix the grammar, spelling and punctuation here. Change nothing else.";
const REPEAT = "The report is ready. The report is ready."; // the first sentence cannot be told from the second by a find and replace: Use is refused
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");

describe("Quick fixes (DOCX)", () => {
  let w, br, stub;
  before(async () => {
    stub = path.join(fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || "/tmp"), "sg-stub-")), "stub.json");
    fs.writeFileSync(stub, JSON.stringify({ [`shorter\t${S1}`]: R1, [`shorter\t${S2}`]: R2, [`friendlier\t${S3}`]: S3, "shorter\tThe report is ready.": "Report ready.", [`grammar\t${S5}`]: { code: "refused" }, [`grammar\t${S6}`]: R6, [`shorter\t${S4}`]: R4 })); // a model that gives the sentence back as it was
    w = makeWorld({ ONIONSKIN_NO_SOFFICE: "1", ONIONSKIN_REWRITER_STUB: stub });
    br = await launch();
  });
  after(async () => {
    await br?.close();
    await w?.cleanup();
    if (stub) fs.rmSync(path.dirname(stub), { recursive: true, force: true });
  });

  /** A copy of long.docx with the sentences added as paragraphs of their own, so a triple-click selects exactly one sentence. */
  const make = (name) => {
    const f = w.doc(name);
    fs.copyFileSync(w.doc("long.docx"), f);
    agentEdit([f, "insert-before", "Paragraph 050:", S1]);
    agentEdit([f, "insert-before", "Paragraph 060:", S2]);
    agentEdit([f, "insert-before", "Paragraph 070:", S3]);
    agentEdit([f, "insert-before", "Paragraph 080:", REPEAT]);
    agentEdit([f, "insert-before", "Paragraph 090:", S4]);
    agentEdit([f, "insert-before", "Paragraph 100:", S5]);
    agentEdit([f, "insert-before", "Paragraph 110:", S6]);
    return f;
  };
  const open = async (file) => {
    const page = await br.page();
    await page.addInitScript(() => sessionStorage.setItem("onionskin.histCollapsed", "0")); // History starts folded; these tests read it open
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(await w.open(file));
    await waitDoc(page);
    return page;
  };
  const sid = (page) => new URL(page.url()).searchParams.get("s");
  const api = (page, p) =>
    page.evaluate(async ([s, route]) => {
      const r = await fetch(`${route}${route.includes("?") ? "&" : "?"}s=${s}`, { credentials: "same-origin", headers: { "x-onionskin-token": sessionStorage.getItem(`onionskin.token.${s}`) || "" } });
      return r.json();
    }, [sid(page), p]);
  const scroll = (page) => page.evaluate(() => ({ de: document.querySelector(".de-scroll").scrollTop, win: window.scrollY }));
  const near = (a, b, what) => {
    assert.ok(Math.abs(a.de - b.de) <= 2 && Math.abs(a.win - b.win) <= 2, `${what}: the document moved from ${JSON.stringify(a)} to ${JSON.stringify(b)}`);
  };
  /** The paragraph at the top of the reader's view (not the one being rewritten): its words and where it sits below the top of the scroll area. */
  const anchorOf = (page) =>
    page.evaluate(() => {
      const top = document.querySelector(".de-scroll").getBoundingClientRect().top;
      const p = [...document.querySelectorAll(".de-p")].find((e) => e.getBoundingClientRect().bottom > top + 1 && !/quarterly/.test(e.textContent));
      return { text: p.textContent.slice(0, 60), y: p.getBoundingClientRect().top - top };
    });
  /** Where that paragraph sits now: null while the page is being rebuilt (no scroll area, or the paragraph is not painted yet). */
  const anchorY = (page, a) =>
    page.evaluate((a) => {
      const sc = document.querySelector(".de-scroll");
      const p = sc && [...document.querySelectorAll(".de-p")].find((e) => e.textContent.slice(0, 60) === a.text);
      return p ? p.getBoundingClientRect().top - sc.getBoundingClientRect().top : null;
    }, a);
  /** The reader's place after a reload: the paragraph they were reading is back at the same height on screen (2 px) and STAYS there for half a
   *  second. The engine paints a rebuilt document in two steps (a first scroll, then the exact one a frame or two later), so the first frames
   *  are not the answer; the deadline is what fails a document that really moved. Measured by the paragraph, not by scrollTop, so a rewrite
   *  that changes the height of text above the reader does not count as a move. */
  const keptPlace = async (page, a, what) => {
    await until(async () => {
      const y = await anchorY(page, a);
      return y != null && Math.abs(y - a.y) <= 2;
    }, `${what}: the paragraph "${a.text}" back at ${Math.round(a.y)} px`, 8000);
    const end = Date.now() + 500;
    while (Date.now() < end) {
      const y = await anchorY(page, a);
      assert.ok(y != null && Math.abs(y - a.y) <= 2, `${what}: the paragraph moved from ${Math.round(a.y)} px to ${y == null ? "nowhere" : Math.round(y)} px after it was back`);
    }
  };
  /** Triple-click the paragraph that starts with `text` (one whole sentence), then press Ask in the chip. */
  const selectAndAsk = async (page, text, guess) => {
    const b = await boxOf(await scrollToPara(page, text, guess));
    await page.mouse.click(b.x + 40, b.y + 8, { clickCount: 3 });
    await page.locator(q("comment-chip")).waitFor({ timeout: 5000 });
    await page.locator(q("quick-ask-chip")).click();
    await page.locator(q("quick-ask")).waitFor({ timeout: 3000 });
  };
  /** A real mouse drag across characters [from, to) of the paragraph that starts with `text` (the chip appears as for any selection). */
  const dragChars = async (page, text, guess, from, to) => {
    const loc = await scrollToPara(page, text, guess);
    const pts = await loc.evaluate((el, [a, b]) => {
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const nodes = [];
      for (let n = w.nextNode(); n; n = w.nextNode()) nodes.push(n);
      const at = (i, edge) => {
        let k = i;
        for (const n of nodes) {
          if (k <= n.length) {
            const r = document.createRange();
            r.setStart(n, Math.max(0, edge === "right" ? k - 1 : k));
            r.setEnd(n, Math.max(0, edge === "right" ? k : k) + (edge === "right" ? 0 : 1));
            const x = r.getBoundingClientRect();
            return { x: edge === "right" ? x.right : x.left, y: x.top + x.height / 2 };
          }
          k -= n.length;
        }
        return null;
      };
      return [at(a, "left"), at(b, "right")];
    }, [from, to]);
    await page.mouse.move(pts[0].x + 0.5, pts[0].y);
    await page.mouse.down();
    await page.mouse.move((pts[0].x + pts[1].x) / 2, pts[1].y, { steps: 4 });
    await page.mouse.move(pts[1].x - 0.5, pts[1].y, { steps: 4 });
    await page.mouse.up();
    await page.locator(q("comment-chip")).waitFor({ timeout: 5000 });
    await page.locator(q("quick-ask-chip")).click();
    await page.locator(q("quick-ask")).waitFor({ timeout: 3000 });
  };
  const stamp = (page, label) => page.locator(q("stamp"), { hasText: new RegExp(`^${label}$`) });
  const state = async (page) => {
    const boot = await api(page, "/api/bootstrap");
    const hist = await api(page, "/api/history");
    return { comments: boot.session.comments.length, seq: boot.session.seq, history: JSON.stringify(hist), activity: JSON.stringify(boot.session.activity || []) };
  };

  test("tap Shorter on one sentence: a card with the old words struck through and the new ones underlined, and nothing is written", async () => {
    const file = make("card.docx");
    const page = await open(file);
    const hash = sha(file);
    await selectAndAsk(page, S1.slice(0, 40), 50 / 300);
    // the hint names the stamps on the server's list (the stand-in back end: all three), so it promises only cards that come
    assert.equal(await page.locator(".stamps-hint").textContent(), "Shorter, Friendlier and Fix grammar show a suggestion first on one sentence. Other taps go to the agent with your other changes.");
    const s0 = await scroll(page);
    const st0 = await state(page);
    await stamp(page, "Shorter").click();
    const card = page.locator(q("suggestion"));
    await card.waitFor({ timeout: 10000 });
    await page.locator(q("suggestion-use")).waitFor({ timeout: 10000 });
    assert.equal(await card.getAttribute("data-state"), "shown");
    assert.match(await card.textContent(), /Made on this Mac by Apple's writing model\. Nothing changes until you tap Use this\./);
    assert.match(await page.locator(q("suggestion-now")).textContent(), /Please note that/);
    assert.equal((await page.locator(q("suggestion-now")).textContent()).replace(/Removed: /g, ""), S1, "Now: is the sentence as it is in the file");
    assert.equal((await page.locator(q("suggestion-suggested")).textContent()).replace(/Added: /g, ""), R1);
    assert.ok((await page.locator(`${q("suggestion-now")} del`).count()) > 0, "removed words are struck through");
    assert.ok((await page.locator(`${q("suggestion-suggested")} ins`).count()) > 0, "added words are underlined");
    const deco = await page.evaluate(() => [getComputedStyle(document.querySelector('[data-testid="suggestion-now"] del')).textDecorationLine, getComputedStyle(document.querySelector('[data-testid="suggestion-suggested"] ins')).textDecorationLine]);
    assert.deepEqual(deco, ["line-through", "underline"]);
    assert.deepEqual(await page.locator(`${q("suggestion")} button`).allTextContents(), ["Use this", "Ask the agent instead"]);
    near(s0, await scroll(page), "after the stamp tap");
    // nothing was written: no comment, no history, no activity, the same bytes
    assert.deepEqual(await state(page), st0);
    assert.equal(sha(file), hash);
    await page.close();
  });

  test("a drag over a whole sentence except its period is that sentence: the card is for the whole sentence and Use this writes it with its end mark", async () => {
    const file = make("minus-period.docx");
    const page = await open(file);
    const hash = sha(file);
    await dragChars(page, S4.slice(0, 40), 90 / 300, 0, S4.length - 1);
    assert.equal(await page.locator(q("quick-ask-quote")).textContent(), S4.slice(0, -1), "the box shows what was selected");
    assert.equal(await page.locator(".stamps-hint").textContent(), "Shorter, Friendlier and Fix grammar show a suggestion first on one sentence. Other taps go to the agent with your other changes.", "no warning line: this selection is read as one sentence");
    await stamp(page, "Shorter").click();
    await page.locator(q("suggestion-use")).waitFor({ timeout: 10000 });
    assert.equal((await page.locator(q("suggestion-now")).textContent()).replace(/Removed: /g, ""), S4, "Now: is the whole sentence, its period included");
    assert.equal(sha(file), hash, "asking writes nothing");
    await page.locator(q("suggestion-use")).click();
    await until(() => sha(file) !== hash, "the file to change", 30000);
    await until(async () => (await page.locator(".de-p", { hasText: R4 }).count()) > 0, "the new sentence on screen", 30000);
    await until(async () => (await api(page, "/api/bootstrap")).session.comments[0]?.status === "done", "the local run to finish", 30000);
    const c = (await api(page, "/api/bootstrap")).session.comments[0];
    assert.equal(c.anchor.quote, S4, "the comment sits on the whole sentence");
    await page.close();
  });

  test("a selection that is not one sentence says so before the tap, then goes to the agent as before", async () => {
    const file = make("half.docx");
    const p = w.spawnCli(["poll", file]);
    const page = await open(file);
    await page.locator(q("banner-listening")).waitFor({ timeout: 20000 });
    await dragChars(page, S4.slice(0, 40), 90 / 300, 0, 30); // half a sentence
    assert.equal(await page.locator(q("stamps-hint")).textContent(), "Shorter, Friendlier and Fix grammar show a suggestion first on one sentence. Other taps go to the agent with your other changes.", "no notice before a stamp is under the pointer");
    await stamp(page, "Friendlier").hover();
    assert.equal(await page.locator(q("stamps-hint")).textContent(), "Select one whole sentence to get a suggestion first.");
    const tall = await page.locator(q("stamps-hint")).evaluate((el) => el.getBoundingClientRect().height);
    assert.ok(tall > 0);
    await stamp(page, "Friendlier").click();
    const res = await Promise.race([p.done, new Promise((r) => setTimeout(() => r(null), 25000))]);
    assert.ok(res && res.code === 0, res?.stderr || "poll timed out");
    assert.equal(JSON.parse(res.stdout).instructions.comments[0].text, "Make this sound friendlier. Keep the meaning.");
    assert.equal(await page.locator(q("suggestion")).count(), 0);
    await page.close();
  });

  test("Esc closes the card and writes nothing; the stamp row is back and a second tap shows the card again", async () => {
    const file = make("esc.docx");
    const page = await open(file);
    const hash = sha(file);
    await selectAndAsk(page, S1.slice(0, 40), 50 / 300);
    const st0 = await state(page);
    await stamp(page, "Shorter").click();
    await page.locator(q("suggestion-use")).waitFor({ timeout: 10000 });
    const s0 = await scroll(page);
    await page.keyboard.press("Escape");
    await page.locator(q("suggestion")).waitFor({ state: "detached", timeout: 3000 });
    assert.ok(await page.locator(q("quick-ask")).isVisible(), "the box is still open: Esc closed only the card");
    await stamp(page, "Shorter").waitFor({ timeout: 3000 });
    assert.deepEqual(await state(page), st0);
    assert.equal(sha(file), hash);
    near(s0, await scroll(page), "after Esc");
    await stamp(page, "Shorter").click();
    await page.locator(q("suggestion-use")).waitFor({ timeout: 10000 });
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.locator(q("quick-ask")).waitFor({ state: "detached", timeout: 3000 });
    assert.deepEqual(await state(page), st0);
    assert.equal(sha(file), hash);
    // nothing late: a draft autosave posts every comment the page holds, so once it has landed the server would hold a comment Esc let through
    await page.locator(q("overall-note")).fill("after Esc");
    await until(async () => (await api(page, "/api/bootstrap")).session.note === "after Esc", "the draft autosave", 10000);
    assert.equal((await state(page)).comments, 0, "no comment after Esc");
    assert.equal(sha(file), hash);
    await page.close();
  });

  test("Use this writes the sentence on this Mac: the file changes, the History row says so, and the document does not move", async () => {
    const file = make("use.docx");
    const page = await open(file);
    const hash = sha(file);
    await selectAndAsk(page, S1.slice(0, 40), 50 / 300);
    const s0 = await scroll(page);
    const a0 = await anchorOf(page);
    await stamp(page, "Shorter").click();
    await page.locator(q("suggestion-use")).waitFor({ timeout: 10000 });
    near(s0, await scroll(page), "after the stamp tap");
    await page.locator(q("suggestion-use")).click();
    near(s0, await scroll(page), "right after the click on Use this");
    await until(() => sha(file) !== hash, "the file to change", 30000);
    const row = page.locator(q("history-row")).first();
    await row.waitFor({ timeout: 30000 });
    assert.equal(await row.getAttribute("data-kind"), "local");
    assert.match(await row.textContent(), /Change made on this Mac/);
    await page.locator(q("quick-ask")).waitFor({ state: "detached", timeout: 3000 });
    // the document shows the new sentence and not the old one, and the reload kept the reader's place
    await until(async () => (await page.locator(".de-p", { hasText: R1 }).count()) > 0 && (await page.locator(".de-p", { hasText: "Please note that the quarterly" }).count()) === 0, "the new sentence on screen", 30000);
    await keptPlace(page, a0, "after the reload");
    const boot = await api(page, "/api/bootstrap");
    const c = boot.session.comments[0];
    assert.equal(c.status, "done");
    assert.equal(c.result, "Rewritten on this Mac. Nothing left this Mac.");
    await page.close();
  });

  test("Use this keeps the overall note: the box still holds it, and the next Send carries it to the agent", async () => {
    const NOTE = "Please also update the title on page 1";
    const file = make("note.docx");
    const page = await open(file);
    const hash = sha(file);
    await page.locator(q("overall-note")).fill(NOTE);
    await until(async () => (await api(page, "/api/bootstrap")).session.note === NOTE, "the note saved as a draft", 10000);
    await selectAndAsk(page, S1.slice(0, 40), 50 / 300);
    await stamp(page, "Shorter").click();
    await page.locator(q("suggestion-use")).click();
    await until(() => sha(file) !== hash, "the file to change", 30000);
    await until(async () => (await api(page, "/api/bootstrap")).session.comments[0]?.status === "done", "the local run to finish", 30000);
    assert.equal(await page.locator(q("overall-note")).inputValue(), NOTE, "the note box still holds the note after Use");
    // a later autosave (any comment or note change) posts what the box holds: it must still be the note
    await page.locator(q("overall-note")).press("End");
    await page.keyboard.type(".");
    await until(async () => (await api(page, "/api/bootstrap")).session.note === `${NOTE}.`, "the note autosaved with the person's words", 10000);
    const p = w.spawnCli(["poll", file]);
    await page.locator(q("send")).click();
    const res = await Promise.race([p.done, new Promise((r) => setTimeout(() => r(null), 25000))]);
    assert.ok(res && res.code === 0, res?.stderr || "poll timed out");
    assert.equal(JSON.parse(res.stdout).instructions.overall_note, `${NOTE}.`, "the next Send carries the note");
    await page.close();
  });

  test("a sentence with markup shows it as text: no image element, no script", async () => {
    const file = make("markup.docx");
    const page = await open(file);
    await selectAndAsk(page, "Please note that the sketch", 60 / 300);
    await stamp(page, "Shorter").click();
    await page.locator(q("suggestion-use")).waitFor({ timeout: 10000 });
    const card = page.locator(q("suggestion"));
    assert.equal(await card.locator("img").count(), 0, "no image element in the card");
    assert.equal(await card.locator("[onerror]").count(), 0);
    assert.match((await page.locator(q("suggestion-now")).textContent()).replace(/Removed: /g, ""), /<img src=x onerror=window\.__pwned=1>/);
    assert.match((await page.locator(q("suggestion-suggested")).textContent()).replace(/Added: /g, ""), /<img src=x onerror=window\.__pwned=1>/);
    assert.equal(await page.evaluate(() => window.__pwned), undefined);
    await page.close();
  });

  test("a sentence the model has nothing for shows one plain line and Ask the agent instead; there is no Try again", async () => {
    const file = make("none.docx");
    const page = await open(file);
    await selectAndAsk(page, S3.slice(0, 40), 70 / 300);
    await stamp(page, "Friendlier").click();
    const msg = page.locator(q("suggestion-message"));
    await msg.waitFor({ timeout: 10000 });
    assert.equal((await msg.textContent()).trim(), "No friendlier version this time.");
    assert.equal(await page.locator(q("suggestion-retry")).count(), 0);
    assert.deepEqual(await page.locator(`${q("suggestion")} button`).allTextContents(), ["Ask the agent instead"]);
    await page.close();
  });

  test("Fix grammar when Apple's model declines the sentence: one plain line, no Try again, Ask the agent instead", async () => {
    const file = make("refused.docx");
    const page = await open(file);
    await selectAndAsk(page, S5.slice(0, 40), 100 / 300);
    await stamp(page, "Fix grammar").click();
    const msg = page.locator(q("suggestion-message"));
    await msg.waitFor({ timeout: 10000 });
    assert.equal((await msg.textContent()).trim(), "No suggestion for this sentence.");
    assert.equal(await page.locator(q("suggestion-retry")).count(), 0);
    assert.deepEqual(await page.locator(`${q("suggestion")} button`).allTextContents(), ["Ask the agent instead"]);
    await page.close();
  });

  test("Fix grammar on a misspelling inside quotes: nothing is suggested, and the line says why", async () => {
    const file = make("quoted.docx");
    const page = await open(file);
    await selectAndAsk(page, S6.slice(0, 40), 110 / 300);
    await stamp(page, "Fix grammar").click();
    const msg = page.locator(q("suggestion-message"));
    await msg.waitFor({ timeout: 10000 });
    assert.equal((await msg.textContent()).trim(), "No suggestion here: the change is inside quoted text.");
    assert.equal(await page.locator(q("suggestion-use")).count(), 0, "no Use this for a change inside quotes");
    assert.deepEqual(await page.locator(`${q("suggestion")} button`).allTextContents(), ["Ask the agent instead"]);
    await page.close();
  });

  test("Ask the agent instead sends the stamp's words and not the suggestion", async () => {
    const file = make("agent.docx");
    const p = w.spawnCli(["poll", file]);
    const page = await open(file);
    await page.locator(q("banner-listening")).waitFor({ timeout: 20000 });
    await selectAndAsk(page, S1.slice(0, 40), 50 / 300);
    await stamp(page, "Shorter").click();
    await page.locator(q("suggestion-use")).waitFor({ timeout: 10000 });
    await page.locator(q("suggestion-agent")).click();
    const res = await Promise.race([p.done, new Promise((r) => setTimeout(() => r(null), 25000))]);
    assert.ok(res && res.code === 0, res?.stderr || "poll timed out");
    const batch = JSON.parse(res.stdout);
    assert.equal(batch.instructions.comments.length, 1);
    assert.equal(batch.instructions.comments[0].text, SHORTER);
    assert.ok(!JSON.stringify(batch).includes(R1), "the suggestion's text is not in the batch");
    await page.close();
  });

  test("a Use that cannot write leaves the comment as a draft with the hint, and the file as it was", async () => {
    const file = make("hint.docx");
    const page = await open(file);
    const hash = sha(file);
    await scrollToPara(page, "The report is ready. The report", 80 / 300);
    // drag over the first sentence only: from the start of the paragraph to the end of "ready."
    const span = await page.evaluate(() => {
      const el = [...document.querySelectorAll(".de-p")].find((p) => p.textContent.startsWith("The report is ready. The report"));
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const t = walker.nextNode();
      const r = document.createRange();
      r.setStart(t, 0);
      r.setEnd(t, "The report is ready.".length);
      const b = r.getBoundingClientRect();
      return { x0: b.left + 1, x1: b.right - 1, y: b.top + b.height / 2 };
    });
    await page.mouse.move(span.x0, span.y);
    await page.mouse.down();
    await page.mouse.move(span.x1, span.y, { steps: 6 });
    await page.mouse.up();
    await page.locator(q("comment-chip")).waitFor({ timeout: 5000 });
    await page.locator(q("quick-ask-chip")).click();
    await page.locator(q("quick-ask")).waitFor({ timeout: 3000 });
    await stamp(page, "Shorter").click();
    await page.locator(q("suggestion-use")).waitFor({ timeout: 10000 });
    const s0 = await scroll(page);
    await page.locator(q("suggestion-use")).click();
    const hint = page.locator(q("local-hint"));
    await hint.waitFor({ timeout: 10000 });
    assert.equal((await hint.textContent()).trim(), "This could not be changed on this Mac, so nothing was written. Press Send to ask the agent.");
    await page.locator(q("quick-ask")).waitFor({ state: "detached", timeout: 3000 });
    assert.equal(await page.locator(q("comment-card")).count(), 1, "one draft comment, not two");
    assert.equal(sha(file), hash);
    near(s0, await scroll(page), "after the refused Use");
    await page.close();
  });

  test("a selection that is not one sentence sends exactly as before: no card", async () => {
    const file = make("word.docx");
    const p = w.spawnCli(["poll", file]);
    const page = await open(file);
    await page.locator(q("banner-listening")).waitFor({ timeout: 20000 });
    const b = await boxOf(await scrollToPara(page, S1.slice(0, 40), 50 / 300));
    await page.mouse.dblclick(b.x + 60, b.y + 8); // one word
    await page.locator(q("comment-chip")).waitFor({ timeout: 5000 });
    await page.locator(q("quick-ask-chip")).click();
    await stamp(page, "Shorter").click();
    const res = await Promise.race([p.done, new Promise((r) => setTimeout(() => r(null), 25000))]);
    assert.ok(res && res.code === 0, res?.stderr || "poll timed out");
    assert.equal(JSON.parse(res.stdout).instructions.comments[0].text, SHORTER);
    assert.equal(await page.locator(q("suggestion")).count(), 0);
    await page.close();
  });

  // The stand-in back end reports all three tasks. Here the page is given the shipped default list (SUGGEST_TASKS from src/suggest.js, what a real
  // back end puts in the bootstrap): Fix grammar only, by the owner's decision (2026-11-12). Fix grammar on one eligible sentence shows the card;
  // Shorter and Friendlier go to the agent with the stamp's words and show no card.
  const shipped = async (name) => {
    const { SUGGEST_TASKS } = await import("../src/suggest.js");
    assert.deepEqual(SUGGEST_TASKS, ["grammar"]);
    const file = make(name);
    const page = await br.page();
    await page.route("**/api/bootstrap**", async (route) => {
      const r = await route.fetch();
      const j = await r.json();
      route.fulfill({ response: r, json: { ...j, suggest: { ...j.suggest, tasks: SUGGEST_TASKS } } });
    });
    const asked = [];
    page.on("request", (rq) => new URL(rq.url()).pathname === "/api/suggest" && asked.push(JSON.parse(rq.postData() || "{}").task));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(await w.open(file));
    await waitDoc(page);
    return { file, page, asked };
  };
  test("with the shipped default list, Fix grammar on one whole sentence asks for a suggestion and shows the card", async () => {
    const { file, page, asked } = await shipped("shipped-grammar.docx");
    const hash = sha(file);
    await selectAndAsk(page, S1.slice(0, 40), 50 / 300);
    assert.equal(await page.locator(q("stamps-hint")).textContent(), "Fix grammar shows a suggestion first on one sentence. Other taps go to the agent with your other changes.");
    await stamp(page, "Fix grammar").click();
    await until(async () => asked.includes("grammar"), "Fix grammar to ask for a suggestion", 10000);
    await page.locator(q("suggestion")).waitFor({ timeout: 10000 });
    assert.ok(asked.every((t) => t === "grammar"), `only Fix grammar is asked for: ${asked}`); // the head start asked when the box opened; this stand-in has no answer to hold, so the tap asked again
    assert.equal(sha(file), hash, "asking writes nothing");
    await page.close();
  });
  for (const [label, words] of [["Shorter", "Make this shorter. Keep the meaning."], ["Friendlier", "Make this sound friendlier. Keep the meaning."]]) {
    test(`with the shipped default list, ${label} on one whole sentence goes to the agent with its words and shows no card`, async () => {
      const { file, page, asked } = await shipped(`shipped-${label}.docx`);
      const p = w.spawnCli(["poll", file]);
      await page.locator(q("banner-listening")).waitFor({ timeout: 20000 });
      await selectAndAsk(page, S1.slice(0, 40), 50 / 300);
      await stamp(page, label).hover();
      assert.equal(await page.locator(q("stamps-hint")).textContent(), "Fix grammar shows a suggestion first on one sentence. Other taps go to the agent with your other changes.");
      await stamp(page, label).click();
      const res = await Promise.race([p.done, new Promise((r) => setTimeout(() => r(null), 25000))]);
      assert.ok(res && res.code === 0, res?.stderr || `${label}: the poll did not return`);
      assert.equal(JSON.parse(res.stdout).instructions.comments[0].text, words, `${label} was sent to the agent with the stamp's words`);
      assert.equal(await page.locator(q("suggestion")).count(), 0, "no card");
      assert.ok(asked.every((t) => t === "grammar"), `no ${label} suggestion was asked for (only Fix grammar's head start, when the box opened): ${asked}`);
      await page.close();
    });
  }
});

// Apple's model only: one tap on "Turn on" turns quick fixes on (nothing is downloaded), and where Apple's model cannot answer the offer is replaced
// by the reason, with "No thanks" as the only button, and Fix grammar goes to the agent as it always did. The shipped helper is replaced by a stand-in
// (e2e/helpers/fake-apple-helper.cjs) through the test-only folder variable, and the macOS version by the test-only version variable.
describe("Quick fixes: turning on and not available (DOCX)", () => {
  let br;
  before(async () => {
    br = await launch();
  });
  after(async () => {
    await br?.close();
  });
  const stamp = (page, label) => page.locator(q("stamp"), { hasText: new RegExp(`^${label}$`) });
  /** A world (its own server) with this Apple setup; `helper` is a fakeAppleHelper mode, or null for no helper at all. Calls `run(page, w, poll)` with the Quick ask box open on S1. */
  const scenario = async ({ helper, macos }, run) => {
    const dir = helper ? fakeAppleHelper(helper) : fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || "/tmp"), "da-fm-empty-"));
    const w = makeWorld({ ONIONSKIN_NO_SOFFICE: "1", ONIONSKIN_REWRITER_STUB: "", ONIONSKIN_APPLE_HELPER_DIR: dir, ...(macos ? { ONIONSKIN_APPLE_HOST_MACOS: macos } : {}) });
    try {
      const file = w.doc("off.docx");
      fs.copyFileSync(w.doc("long.docx"), file);
      agentEdit([file, "insert-before", "Paragraph 050:", S1]);
      const poll = w.spawnCli(["poll", file]);
      const page = await br.page();
      const posts = []; // POST /api/suggest, from the first page load on
      page.on("request", (rq) => new URL(rq.url()).pathname === "/api/suggest" && posts.push(JSON.parse(rq.postData() || "{}").task));
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(await w.open(file));
      await waitDoc(page);
      await page.locator(q("banner-listening")).waitFor({ timeout: 20000 });
      const open = async () => {
        const b = await boxOf(await scrollToPara(page, S1.slice(0, 40), 50 / 300));
        await page.mouse.click(b.x + 40, b.y + 8, { clickCount: 3 });
        await page.locator(q("comment-chip")).waitFor({ timeout: 5000 });
        await page.locator(q("quick-ask-chip")).click();
        await page.locator(q("quick-ask")).waitFor({ timeout: 3000 });
      };
      await open();
      await run(page, w, poll, open, posts);
      await page.close();
    } finally {
      await w.cleanup();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
  const sentToAgent = async (page, poll, words) => {
    const res = await Promise.race([poll.done, new Promise((r) => setTimeout(() => r(null), 25000))]);
    assert.ok(res && res.code === 0, res?.stderr || "poll timed out");
    assert.equal(JSON.parse(res.stdout).instructions.comments[0].text, words, "the tap sent, as today");
    assert.equal(await page.locator(q("suggestion")).count(), 0, "no card");
  };

  test("one tap on Turn on turns quick fixes on: the done line, then Fix grammar asks Apple's model and a reload shows no offer", async () => {
    await scenario({ helper: "ok" }, async (page, w, poll, open, posts) => {
      const offer = page.locator(q("suggest-offer"));
      await offer.waitFor({ timeout: 5000 });
      assert.deepEqual(posts, [], "quick fixes off: the box opening asked for nothing");
      assert.equal((await page.locator(`${q("suggest-offer")} p`).textContent()).trim(), "Get quick fixes for one sentence, made by Apple's writing model on this Mac. Nothing you write leaves it.");
      assert.deepEqual(await page.locator(`${q("suggest-offer")} button`).allTextContents(), ["Turn on", "No thanks"]);
      const look = await offer.evaluate((el) => ({ padding: getComputedStyle(el).paddingTop, display: getComputedStyle(el).display }));
      assert.deepEqual(look, { padding: "6px", display: "flex" }, "the offer's own styles apply");
      await page.locator(q("suggest-offer-go")).click(); // one tap: no confirm step
      await page.locator(q("suggest-offer-done")).waitFor({ timeout: 20000 });
      assert.equal((await page.locator(q("suggest-offer-done")).textContent()).trim(), "Quick fixes are on. Select one sentence and tap Fix grammar.");
      assert.equal(JSON.parse(fs.readFileSync(path.join(w.state, "rewriter.json"), "utf8")).backend, "apple");
      await stamp(page, "Fix grammar").click();
      const msg = page.locator(q("suggestion-message"));
      await msg.waitFor({ timeout: 15000 });
      assert.match(await msg.textContent(), /found nothing to fix/, "the stand-in model gave the sentence back, so the card says so");
      assert.equal(await Promise.race([poll.done.then(() => "sent"), new Promise((r) => setTimeout(() => r("held"), 1500))]), "held", "Apple's model was asked first: nothing went to the agent");
      await page.reload();
      await waitDoc(page);
      await open();
      await stamp(page, "Fix grammar").waitFor({ timeout: 3000 });
      assert.equal(await page.locator(q("suggest-offer")).count(), 0, "on: no offer");
    });
  });

  const NOT_AVAILABLE = [
    ["macOS older than 26", { helper: "ok", macos: "25.4" }, "Quick fixes need macOS 26 or later."],
    ["a Mac that cannot run the model", { helper: "deviceNotEligible" }, "This Mac cannot run Apple's on-device writing model."],
    ["Apple Intelligence turned off", { helper: "appleIntelligenceNotEnabled" }, "Turn on Apple Intelligence in System Settings to get quick spelling and grammar fixes."],
    ["the model still getting ready", { helper: "modelNotReady" }, "Apple's writing model is still getting ready. Try again in a few minutes."],
    ["a helper that is missing", { helper: null }, "The small helper for quick fixes is missing or damaged in this copy of Onionskin. Install Onionskin again to fix it."],
  ];
  for (const [label, setup, line] of NOT_AVAILABLE) {
    // the three Apple reasons come from the helper's probe, so they show once the person taps Turn on; the other two are known from the start
    const known = !["deviceNotEligible", "appleIntelligenceNotEnabled", "modelNotReady"].includes(setup.helper);
    test(`${label}: the offer is replaced by the reason, nothing to press but No thanks, and Fix grammar goes to the agent`, async () => {
      await scenario(setup, async (page, w, poll) => {
        const offer = page.locator(q("suggest-offer"));
        await offer.waitFor({ timeout: 5000 });
        if (!known) {
          await page.locator(q("suggest-offer-go")).click();
          await page.locator(`${q("suggest-offer")}[data-step="unavailable"]`).waitFor({ timeout: 20000 });
        }
        assert.equal(await offer.getAttribute("data-step"), "unavailable");
        assert.equal((await page.locator(q("suggest-offer-unavailable")).textContent()).trim(), line);
        const buttons = await page.locator(`${q("suggest-offer")} button`).allTextContents();
        assert.deepEqual(buttons, setup.helper === "modelNotReady" ? ["Try again", "No thanks"] : ["No thanks"]);
        await stamp(page, "Fix grammar").click();
        await sentToAgent(page, poll, GRAMMAR);
        assert.equal(await page.locator(q("suggest-offer-go")).count(), 0, "no Turn on where it cannot work");
      });
    });
  }

  test("No thanks hides the offer, and Shorter and Friendlier go to the agent", async () => {
    await scenario({ helper: "ok" }, async (page, w, poll, open) => {
      await page.locator(q("suggest-offer")).waitFor({ timeout: 5000 });
      await stamp(page, "Shorter").click();
      await sentToAgent(page, poll, SHORTER);
      await page.reload();
      await waitDoc(page);
      await open();
      await page.locator(q("suggest-offer-no")).click();
      await page.locator(q("suggest-offer")).waitFor({ state: "detached", timeout: 3000 });
      await page.reload();
      await waitDoc(page);
      await open();
      await stamp(page, "Shorter").waitFor({ timeout: 3000 });
      assert.equal(await page.locator(q("suggest-offer")).count(), 0, "No thanks is remembered after a reload");
    });
  });
});

// The head start: when the Quick ask box opens on one sentence and quick fixes are on, Fix grammar is asked for right away and held; the tap
// shows it. Apple's model is the stand-in helper in "fix" mode (it corrects "recieve"), and every model call is counted where the helper gets it.
describe("Quick fixes: the head start (DOCX)", () => {
  let br;
  before(async () => {
    br = await launch();
  });
  after(async () => {
    await br?.close();
  });
  const G1 = "Our office will recieve the signed form before Friday.";
  const G2 = "The team should recieve the new laptops on Monday morning.";
  const stamp = (page, label) => page.locator(q("stamp"), { hasText: new RegExp(`^${label}$`) });
  /** A world with quick fixes on (Apple's model, the stand-in), the two sentences as paragraphs of their own, and the page open. */
  const scenario = async (delayMs, run) => {
    const dir = fakeAppleHelper("fix");
    if (delayMs) fs.writeFileSync(path.join(dir, "delay"), String(delayMs));
    const w = makeWorld({ ONIONSKIN_NO_SOFFICE: "1", ONIONSKIN_REWRITER_STUB: "", ONIONSKIN_APPLE_HELPER_DIR: dir });
    try {
      fs.mkdirSync(w.state, { recursive: true, mode: 0o700 });
      const { sha256 } = JSON.parse(fs.readFileSync(path.join(dir, "onionskin-fm.json"), "utf8"));
      fs.writeFileSync(path.join(w.state, "rewriter.json"), JSON.stringify({ backend: "apple", model: "apple", sha256 }), { mode: 0o600 });
      const file = w.doc("ahead.docx");
      fs.copyFileSync(w.doc("long.docx"), file);
      agentEdit([file, "insert-before", "Paragraph 050:", G1]);
      agentEdit([file, "insert-before", "Paragraph 060:", G2]);
      const page = await br.page();
      await page.addInitScript(() => {
        // every card the box shows, as it shows it: a stale card that flashes and goes is caught too
        window.__cards = [];
        new MutationObserver(() => {
          const c = document.querySelector('[data-testid="suggestion"][data-state="shown"]');
          if (c && window.__cards[window.__cards.length - 1] !== c.textContent) window.__cards.push(c.textContent);
        }).observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
      });
      const posts = []; // POST /api/suggest, with the time it was sent
      page.on("request", (rq) => new URL(rq.url()).pathname === "/api/suggest" && posts.push({ at: Date.now(), body: JSON.parse(rq.postData() || "{}") }));
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(await w.open(file));
      await waitDoc(page);
      const open = async (text, guess) => {
        const b = await boxOf(await scrollToPara(page, text.slice(0, 30), guess));
        await page.mouse.click(b.x + 40, b.y + 8, { clickCount: 3 });
        await page.locator(q("comment-chip")).waitFor({ timeout: 5000 });
        await page.locator(q("quick-ask-chip")).click();
        await page.locator(q("quick-ask")).waitFor({ timeout: 3000 });
      };
      const calls = () => {
        const f = path.join(dir, "asked.jsonl");
        return fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
      };
      await run({ page, file, open, calls, posts });
      await page.close();
    } finally {
      await w.cleanup();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  test("the box opening asks once; nothing shows before the tap; the tap shows the card with no second model call", async () => {
    await scenario(0, async ({ page, file, open, calls, posts }) => {
      const hash = sha(file);
      await open(G1, 50 / 300);
      await until(async () => calls().length === 1, "the head start to reach the model", 10000);
      assert.deepEqual(calls(), [G1], "asked for the selected sentence, once");
      await page.waitForTimeout(400); // the answer is back by now (the stand-in answers at once): it must still not show
      assert.equal(await page.locator(q("suggestion")).count(), 0, "nothing is shown before the tap");
      assert.equal(await stamp(page, "Fix grammar").count(), 1, "the stamp row is still there");
      const sent = posts.length;
      const t0 = Date.now();
      await stamp(page, "Fix grammar").click();
      const card = page.locator(`${q("suggestion")}[data-state="shown"]`);
      await card.waitFor({ timeout: 5000 });
      const tapToCard = Date.now() - t0;
      assert.match(await card.textContent(), /receive the signed form/, "the card is the held suggestion for this sentence");
      assert.deepEqual(calls(), [G1], "no second model call after the tap");
      assert.equal(posts.length, sent, "no request after the tap");
      assert.ok(tapToCard < 1500, `the card came from the held answer (${tapToCard} ms)`);
      assert.equal(sha(file), hash, "asking writes nothing");
    });
  });

  test("a changed selection never shows the old sentence's result: one model call at a time, the newest selection wins, and its in-flight answer is the card", async () => {
    await scenario(1200, async ({ page, open, calls, posts }) => {
      await open(G1, 50 / 300);
      await until(async () => calls().length === 1, "the head start for the first sentence to reach the model", 10000);
      await page.keyboard.press("Escape"); // closes the box while the model is still working on the first sentence
      await page.locator(q("quick-ask")).waitFor({ state: "detached", timeout: 3000 });
      await open(G2, 60 / 300);
      await until(async () => calls().length === 2, "the second sentence's head start to reach the model, after the first answered", 10000);
      await stamp(page, "Fix grammar").click(); // while the model is still working on it: the tap waits for that answer
      const card = page.locator(`${q("suggestion")}[data-state="shown"]`);
      await card.waitFor({ timeout: 10000 });
      assert.match(await card.textContent(), /receive the new laptops/, "the card is for the sentence selected now");
      const cards = await page.evaluate(() => window.__cards);
      assert.ok(cards.length >= 1 && cards.every((t) => !/signed form/.test(t)), `the first sentence's result was never shown: ${JSON.stringify(cards)}`);
      assert.deepEqual(calls(), [G1, G2], "each sentence reached the model once: the tap used the answer already on its way");
      assert.deepEqual(posts.map((p) => p.body.anchor.quote), [G1, G2], "two asks in all");
      assert.ok(posts[1].at - posts[0].at >= 1000, `the second ask waited for the first answer (${posts[1].at - posts[0].at} ms apart, the model takes 1200 ms)`);
    });
  });
});

// PowerPoint: the page cannot tell part of a sentence from a sentence without its end mark (it has no paragraph text), so the server decides.
// When it says "not one sentence", the person is told so and nothing goes to the agent until they choose it.
describe("Quick fixes (PPTX)", () => {
  let w, br, stub;
  before(async () => {
    stub = path.join(fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || "/tmp"), "sg-stub-")), "stub.json");
    fs.writeFileSync(stub, "{}");
    w = makeWorld({ ONIONSKIN_NO_SOFFICE: "1", ONIONSKIN_REWRITER_STUB: stub });
    br = await launch();
  });
  after(async () => {
    await br?.close();
    await w?.cleanup();
    if (stub) fs.rmSync(path.dirname(stub), { recursive: true, force: true });
  });

  test("part of a sentence in a text box: the tap is never silent, the card says to select one whole sentence, and the agent gets it only on request", async () => {
    const file = w.doc("deck.pptx");
    const p = w.spawnCli(["poll", file]);
    const page = await br.page();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(await w.open(file));
    await waitDoc(page, ".de-slide");
    await page.locator(q("banner-listening")).waitFor({ timeout: 20000 });
    await gotoSlide(page, 2);
    const word = await wordPoint(page, 2, 3, "Revenue"); // the first word of the sentence: part of it, from its start
    await page.mouse.click(word.x, word.y); // the first click puts the caret in the text
    await page.mouse.dblclick(word.x, word.y);
    await page.locator(q("comment-chip")).waitFor({ timeout: 5000 });
    await page.locator(q("quick-ask-chip")).click();
    await page.locator(q("quick-ask")).waitFor({ timeout: 3000 });
    await page.locator(q("stamp"), { hasText: /^Shorter$/ }).click();
    const card = page.locator(`${q("suggestion")}[data-state="none"]`);
    await card.waitFor({ timeout: 10000 });
    assert.match(await card.textContent(), /Select one whole sentence to get a suggestion first\./);
    assert.deepEqual(await page.locator(`${q("suggestion")} button`).allTextContents(), ["Ask the agent instead"]);
    assert.equal(await Promise.race([p.done.then(() => "sent"), new Promise((r) => setTimeout(() => r("held"), 1500))]), "held", "nothing went to the agent by itself");
    await page.locator(q("suggestion")).locator("button", { hasText: "Ask the agent instead" }).click();
    const res = await Promise.race([p.done, new Promise((r) => setTimeout(() => r(null), 25000))]);
    assert.ok(res && res.code === 0, res?.stderr || "poll timed out");
    assert.equal(JSON.parse(res.stdout).instructions.comments[0].text, SHORTER);
    await page.close();
  });
});
