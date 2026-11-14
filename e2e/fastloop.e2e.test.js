import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, describe, test } from "node:test";
import { LINE_END, agentEdit, boxOf, launch, makeWorld, scrollToPara, srcModule, until, waitDoc } from "./helpers/harness.mjs";

// The fast loop through a real browser: Quick ask (select, shortcut, type, Cmd/Ctrl+Enter = comment + Send; Enter is a new line), the keyboard flow of the review panel,
// the agent's stage and each comment's own state, what changed after a run (pulse, or the "changes below" pill), the shortcuts popover.
const MAC = process.platform === "darwin";
const MODK = MAC ? "Meta" : "Control";
const QUICK = `${MODK}+Shift+K`;
const NEXT = MAC ? "Meta+Alt+ArrowDown" : "Alt+ArrowDown";
const PREV = MAC ? "Meta+Alt+ArrowUp" : "Alt+ArrowUp";
const q = (id) => `[data-testid="${id}"]`;

/** Double-click a word of the paragraph that starts with `text` (selects it; the comment chip appears). */
const selectWord = async (page, text, dx = 150) => {
  const p = await scrollToPara(page, text, Number(text.match(/\d+/)[0]) / 300);
  const b = await boxOf(p);
  await page.mouse.dblclick(b.x + dx, b.y + 12);
  await page.locator(q("comment-chip")).waitFor({ timeout: 5000 });
  return p;
};
const selectedText = (page) => page.evaluate(() => window.getSelection().toString());
const poll = async (p) => {
  const res = await Promise.race([p.done, new Promise((r) => setTimeout(() => r(null), 25000))]);
  assert.ok(res && res.code === 0, res?.stderr || "poll timed out");
  return JSON.parse(res.stdout);
};
const open = async (w, br, file) => {
  const url = await w.open(file);
  const page = await br.page();
  await page.goto(url);
  await waitDoc(page);
  return page;
};
/** Is the first paragraph that starts with `text` inside the document viewport? */
const inView = (page, text) =>
  page.evaluate((t) => {
    const el = [...document.querySelectorAll(".de-p")].find((e) => e.textContent.startsWith(t));
    const box = document.querySelector('[data-testid="docwrap"]').getBoundingClientRect();
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.bottom > box.top && r.top < box.bottom;
  }, text);

describe("Quick ask (DOCX)", () => {
  let w, br, file;
  before(async () => {
    w = makeWorld();
    br = await launch();
    file = w.doc("long.docx");
  });
  after(async () => {
    await br?.close();
    await w?.cleanup();
  });

  test("Esc closes the composer, returns the focus to the document and leaves the selection and the comments alone", async () => {
    const page = await open(w, br, file);
    await selectWord(page, "Paragraph 020:");
    const word = await selectedText(page);
    assert.ok(word.length > 2, "a word is selected");
    const chipBox = await boxOf(page.locator(q("comment-chip-group")));
    assert.ok(chipBox.width <= 165, `the chip stays about as wide as before (${chipBox.width}px)`);
    await page.keyboard.press(QUICK);
    const composer = page.locator(q("quick-ask"));
    await composer.waitFor({ timeout: 3000 });
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.testid), "quick-ask-text", "the text box has the focus");
    await page.locator(q("quick-outline")).waitFor({ timeout: 3000 }); // the asked-about words stay outlined
    await page.keyboard.type("A draft that is thrown away.");
    await page.keyboard.press("Enter");
    assert.match(await page.locator(q("quick-ask-text")).inputValue(), /away\.\n$/, "Enter adds a line and sends nothing");
    assert.equal(await page.locator(q("comment-card")).count(), 0, "Enter alone makes no comment");
    await page.keyboard.press("Escape");
    await composer.waitFor({ state: "detached", timeout: 3000 });
    await until(async () => (await selectedText(page)) === word, "the selection to come back");
    assert.equal(await page.evaluate(() => !!document.activeElement?.closest('[data-testid="docwrap"]')), true, "focus is back in the document");
    assert.equal(await page.locator(q("comment-card")).count(), 0, "no comment was made");
    assert.equal(await page.locator(q("send")).isDisabled(), true, "nothing is queued to send");
    await page.close();
  });

  test("a read-only tab says why nothing can be sent", async () => {
    const first = await open(w, br, file);
    const second = await open(w, br, file);
    await second.locator(q("banner-readonly")).waitFor({ timeout: 10000 });
    await selectWord(second, "Paragraph 025:");
    await second.keyboard.press(QUICK);
    const hint = second.locator(q("quick-ask-hint"));
    await hint.waitFor({ timeout: 3000 });
    assert.match(await hint.textContent(), /read-only/i);
    assert.equal(await second.locator(q("quick-ask")).getAttribute("data-blocked"), "1");
    assert.equal(await second.locator(q("quick-ask-text")).isDisabled(), true);
    await second.keyboard.press(`${MODK}+Enter`);
    await second.waitForTimeout(300);
    assert.equal(await second.locator(q("comment-card")).count(), 0, "Cmd/Ctrl+Enter in a blocked composer makes no comment");
    assert.equal(await second.locator(q("quick-ask")).count(), 1, "and the composer stays, with its reason");
    await second.keyboard.press("Escape");
    await second.locator(q("quick-ask")).waitFor({ state: "detached" });
    await second.close();
    await first.close();
  });

  test("select, shortcut, type, Cmd/Ctrl+Enter: the comment is made on the selection and the batch reaches the agent in one gesture", async () => {
    const p = w.spawnCli(["poll", file]);
    const page = await open(w, br, file);
    await page.locator(q("banner-listening")).waitFor({ timeout: 20000 });
    await selectWord(page, "Paragraph 030:");
    await page.keyboard.press(QUICK);
    await page.locator(q("quick-ask")).waitFor({ timeout: 3000 });
    await page.keyboard.type("Name an owner here.");
    await page.keyboard.press(`${MODK}+Enter`);
    const batch = await poll(p);
    assert.equal(batch.instructions.comments.length, 1);
    assert.equal(batch.instructions.comments[0].text, "Name an owner here.");
    assert.match(batch.untrusted_document_evidence.anchors[0].quote, /^\S+/);
    await page.locator(q("banner-working")).waitFor();
    await page.locator(q("quick-ask")).waitFor({ state: "detached" });
    assert.equal(await page.locator(q("comment-card")).count(), 1);
    // the new comment is in the panel as a sent comment, waiting for the agent
    assert.equal(await page.locator(`${q("comment-card")} ${q("card-state")}`).first().textContent(), "Waiting");
    // a second Quick ask while the agent works is queued, as the Send button would
    await selectWord(page, "Paragraph 031:");
    await page.keyboard.press(QUICK);
    await page.locator(q("quick-ask")).waitFor({ timeout: 3000 });
    await page.keyboard.type("Second, while you work.");
    await page.keyboard.press(`${MODK}+Enter`);
    await until(async () => /queued/i.test(await page.locator(q("state-pill")).textContent()), "the queued state");
    await page.close();
  });

  test("a comment the agent gave no result for says \"No answer\" and stops pulsing", async () => {
    const file = w.doc("noanswer.docx"); // its own file: the test before leaves a batch queued on `file`
    fs.copyFileSync(w.doc("long.docx"), file);
    const p = w.spawnCli(["poll", file]);
    const page = await open(w, br, file);
    await page.locator(q("banner-listening")).waitFor({ timeout: 20000 });
    await selectWord(page, "Paragraph 035:");
    await page.keyboard.press(QUICK);
    await page.locator(q("quick-ask")).waitFor({ timeout: 3000 });
    await page.keyboard.type("Look at this.");
    await page.keyboard.press(`${MODK}+Enter`);
    await poll(p);
    await page.locator(q("banner-working")).waitFor();
    const state = page.locator(`${q("comment-card")} ${q("card-state")}`).first();
    assert.equal(await state.textContent(), "Waiting");
    const results = w.doc("results.json");
    fs.writeFileSync(results, JSON.stringify({ summary: "Nothing to report.", results: [] }));
    const done = await w.cli(["done", file, "--results", results]);
    assert.equal(done.code, 0, done.stderr);
    await until(async () => (await state.textContent()) === "No answer", "the unanswered comment to stop saying Waiting");
    assert.equal(await state.locator(".wait-dot").count(), 0, "no pulsing dot");
    await page.close();
  });

  test("Cmd/Ctrl+K stays the engine's: the shortcut that opens Quick ask is Cmd/Ctrl+Shift+K", async () => {
    const page = await open(w, br, w.doc("long.docx"));
    await selectWord(page, "Paragraph 040:");
    await page.keyboard.press(`${MODK}+k`);
    await page.waitForTimeout(400);
    assert.equal(await page.locator(q("quick-ask")).count(), 0, "plain Cmd/Ctrl+K does not open Quick ask (the engine inserts a link with it)");
    await page.close();
  });
});

describe("review panel keyboard flow, send from outside the document (DOCX)", () => {
  let w, br, file, page;
  before(async () => {
    w = makeWorld();
    br = await launch();
    file = w.doc("long.docx");
    page = await open(w, br, file);
  });
  after(async () => {
    await br?.close();
    await w?.cleanup();
  });
  const activeIsCardBox = () => page.evaluate(() => document.activeElement?.tagName === "TEXTAREA" && !!document.activeElement.closest('[data-testid="comment-card"]'));
  const activeCardNo = () => page.evaluate(() => document.activeElement?.getAttribute("aria-label"));

  test("a new comment has the focus in its text box, whether it came from the chip, the shortcut or a click", async () => {
    // chip
    await selectWord(page, "Paragraph 010:");
    await page.locator(q("comment-chip")).click();
    await until(activeIsCardBox, "focus in the box after the chip");
    assert.match(await activeCardNo(), /Comment 1 text/);
    await page.keyboard.type("First.");
    // shortcut on a caret (the whole paragraph)
    const p2 = await scrollToPara(page, "Paragraph 120:", 120 / 300);
    const b2 = await boxOf(p2);
    await page.mouse.click(b2.x + 60, b2.y + 12);
    await page.keyboard.press(`${MODK}+Alt+KeyM`);
    await until(activeIsCardBox, "focus in the box after the shortcut");
    assert.match(await activeCardNo(), /Comment 2 text/);
    await page.keyboard.type("Second.");
    // click in Pin mode
    await page.locator(q("mode-pin")).click();
    const b3 = await boxOf(await scrollToPara(page, "Paragraph 210:", 210 / 300));
    await page.mouse.click(b3.x + 120, b3.y + 12);
    await until(activeIsCardBox, "focus in the box after a pin");
    assert.match(await activeCardNo(), /Pin 3 text/);
    await page.keyboard.type("Third.");
    await page.locator(q("mode-edit")).click();
    await page.waitForTimeout(500);
  });

  test("next / previous comment box move the focus and scroll the document to that comment; Esc goes back to the document there", async () => {
    await page.locator(q("comment-card")).nth(2).locator("textarea").focus();
    await page.keyboard.press(PREV);
    await until(async () => /Comment 2 text/.test(await activeCardNo()), "the previous box");
    await until(() => inView(page, "Paragraph 120:"), "the document to show comment 2's paragraph");
    await page.keyboard.press(PREV);
    await until(async () => /Comment 1 text/.test(await activeCardNo()), "the first box");
    await until(() => inView(page, "Paragraph 010:"), "the document to show comment 1's paragraph");
    await page.keyboard.press(NEXT);
    await until(async () => /Comment 2 text/.test(await activeCardNo()), "the next box");
    await page.keyboard.press(NEXT);
    await page.keyboard.press(NEXT);
    await until(async () => /Comment 1 text/.test(await activeCardNo()), "the order wraps around");
    await until(() => inView(page, "Paragraph 010:"), "the document to settle on the box the focus ended in");
    // Esc in a comment box: the caret goes to the document at that comment's place, the text stays
    await page.keyboard.press(NEXT);
    await until(async () => /Comment 2 text/.test(await activeCardNo()), "box 2");
    await page.keyboard.press("Escape");
    await until(async () => page.evaluate(() => !!document.activeElement?.closest('[data-testid="docwrap"]')), "focus in the document");
    await until(() => page.evaluate(() => (window.getSelection().anchorNode?.parentElement?.closest(".de-p")?.textContent || "").startsWith("Paragraph 120:")), "the caret to sit in comment 2's paragraph").catch(async (e) => {
      throw new Error(`${e.message} ${await page.evaluate(() => JSON.stringify({ a: document.activeElement?.tagName + "." + document.activeElement?.className, s: window.getSelection().anchorNode?.textContent?.slice(0, 30), v: [...document.querySelectorAll(".de-p")].map((x) => x.dataset.bi).slice(0, 3) }))}`);
    });
    assert.equal(await page.locator(q("comment-card")).nth(1).locator("textarea").inputValue(), "Second.");
  });

  test("Cmd/Ctrl+Enter inside the document is the engine's (no send); from a button outside it, it sends", async () => {
    const p = w.spawnCli(["poll", file]);
    await page.locator(q("banner-listening")).waitFor({ timeout: 20000 });
    await page.waitForTimeout(500);
    const b = await boxOf(await scrollToPara(page, "Paragraph 120:", 120 / 300));
    await page.mouse.click(b.x + 60, b.y + 12);
    await page.keyboard.press(`${MODK}+Enter`);
    const early = await Promise.race([p.done, new Promise((r) => setTimeout(() => r("quiet"), 1500))]);
    assert.equal(early, "quiet", "the document keeps Cmd/Ctrl+Enter: nothing was sent");
    await page.locator(q("theme-toggle")).focus();
    await page.keyboard.press(`${MODK}+Enter`);
    const batch = await poll(p);
    assert.equal(batch.instructions.comments.length, 3, "the three comments went out");
    await page.locator(q("banner-working")).waitFor();
  });
});

describe("a new comment on a narrow screen (DOCX)", () => {
  let w, br;
  before(async () => {
    w = makeWorld();
    br = await launch();
  });
  after(async () => {
    await br?.close();
    await w?.cleanup();
  });

  test("on a narrow screen the new comment still has the focus (the drawer does not take it)", async () => {
    const small = await br.page();
    await small.setViewportSize({ width: 1000, height: 800 });
    await small.goto(await w.open(w.doc("long.docx")));
    await waitDoc(small);
    const p = await scrollToPara(small, "Paragraph 070:", 70 / 300);
    const b = await boxOf(p);
    await small.mouse.dblclick(b.x + 150, b.y + 12);
    await small.locator(q("comment-chip")).click();
    await until(() => small.evaluate(() => document.activeElement?.tagName === "TEXTAREA" && !!document.activeElement.closest('[data-testid="comment-card"]')), "focus in the new box in the drawer");
    await small.close();
  });

});

// A test page can pretend the server names a stage: the event stream the app opens is wrapped so a test sets window.__stage and replays.
const stageHook = () => {
  const Native = window.EventSource;
  const hooks = [];
  window.EventSource = class extends Native {
    constructor(u, o) {
      super(u, o);
      const add = this.addEventListener.bind(this);
      this.addEventListener = (type, fn, opts) => {
        const wrap = (e) => {
          let ev = e;
          if (type === "state") window.__last = e.data;
          if ((type === "state" || type === "reload") && window.__stage !== undefined) ev = new MessageEvent(type, { data: JSON.stringify({ ...JSON.parse(e.data), stage: window.__stage }) });
          fn(ev);
        };
        if (type === "state") hooks.push(wrap);
        add(type, wrap, opts);
      };
    }
  };
  window.__replay = () => hooks.forEach((h) => h(new MessageEvent("state", { data: window.__last })));
};

describe("the agent's stage and each comment's own state (DOCX)", () => {
  let w, br, file;
  before(async () => {
    w = makeWorld();
    br = await launch();
    file = w.doc("long.docx");
  });
  after(async () => {
    await br?.close();
    await w?.cleanup();
  });

  test("delivered, writing, checking; then each card shows its result", async () => {
    const p = w.spawnCli(["poll", file]);
    const url = await w.open(file);
    const page = await br.page();
    await page.addInitScript(stageHook);
    await page.goto(url);
    await waitDoc(page);
    await page.locator(q("banner-listening")).waitFor({ timeout: 20000 });
    // two comments
    await selectWord(page, "Paragraph 015:");
    await page.locator(q("comment-chip")).click();
    await page.keyboard.type("Make this shorter.");
    await selectWord(page, "Paragraph 016:");
    await page.locator(q("comment-chip")).click();
    await page.keyboard.type("Add a figure.");
    await page.waitForTimeout(500);
    const sendBtn = page.locator(q("send"));
    await sendBtn.click();
    assert.equal(await sendBtn.getAttribute("data-busy"), "1", "the button answers before the network does");
    const batch = await poll(p);
    await page.locator(q("banner-working")).waitFor();
    await page.evaluate(() => (window.__stage = "delivered") && window.__replay());
    const stage = page.locator(q("stage-text"));
    await until(async () => (await stage.textContent()) === "The agent has your batch", "the delivered stage");
    const bar = page.locator(q("stage-bar"));
    assert.equal(await bar.getAttribute("aria-valuenow"), "1");
    assert.equal(await page.locator(q("banner-stage")).textContent(), "The agent has your batch");
    for (const [key, text, now] of [["writing", "Writing your changes", "2"], ["checking", "Checking the file", "3"]]) {
      await page.evaluate((k) => ((window.__stage = k), window.__replay()), key);
      await until(async () => (await stage.textContent()) === text, `the ${key} stage`);
      assert.equal(await bar.getAttribute("aria-valuenow"), now);
      assert.equal(await bar.getAttribute("aria-valuetext"), text);
      assert.equal(await bar.locator('i[data-on="1"]').count(), Number(now));
    }
    // while the agent has the batch every comment is waiting
    assert.deepEqual(await page.locator(q("card-state")).allTextContents(), ["Waiting", "Waiting"]);
    // without a stage the old words come back
    await page.evaluate(() => ((window.__stage = null), window.__replay()));
    await until(async () => (await stage.textContent()) === "Agent is working", "the fallback wording");
    // the result: a check mark on one card, a declined mark on the other
    const [c1, c2] = batch.instructions.comments;
    const results = w.doc("results.json");
    fs.writeFileSync(results, JSON.stringify({ summary: "One done, one declined.", results: [{ comment_id: c1.id, status: "done", note: "Shortened." }, { comment_id: c2.id, status: "declined", note: "No figure available." }] }));
    agentEdit([file, "replace", "regional leads", "regional managers", "Paragraph 015:"]);
    const done = await w.cli(["done", file, "--results", results]);
    assert.equal(done.code, 0, done.stderr);
    await until(async () => (await page.locator(q("card-state")).allTextContents()).join() === "Done,Declined", "the result marks");
    assert.equal(await page.locator(`${q("card-state")}.st-done .i`).count(), 1, "a check mark");
    assert.equal(await page.locator(`${q("card-state")}.st-declined .i`).count(), 1, "a declined mark");
    await page.close();
  });
});

describe("what changed after the refresh (DOCX)", () => {
  let w, br, file, page;
  before(async () => {
    w = makeWorld();
    br = await launch();
    file = w.doc("long.docx");
    page = await open(w, br, file);
  });
  after(async () => {
    await br?.close();
    await w?.cleanup();
  });
  /** One round: a comment on `para`, Send, the agent replaces text in each paragraph of `edits`, done. */
  const round = async (para, edits) => {
    const p = w.spawnCli(["poll", file]);
    await page.locator(q("banner-listening")).waitFor({ timeout: 20000 });
    await selectWord(page, para);
    await page.locator(q("comment-chip")).click();
    await page.keyboard.type("Please update.");
    await page.waitForTimeout(500);
    await page.locator(q("send")).click();
    const batch = await poll(p);
    for (const [prefix, from, to] of edits) agentEdit([file, "replace", from, to, prefix]);
    const results = w.doc("results.json");
    fs.writeFileSync(results, JSON.stringify({ summary: "Updated.", results: [{ comment_id: batch.instructions.comments[0].id, status: "done", note: "Done." }] }));
    const done = await w.cli(["done", file, "--results", results]);
    assert.equal(done.code, 0, done.stderr);
  };

  test("a place in view pulses; places out of view become one pill that jumps to the first, and the user stays where they are", async () => {
    await round("Paragraph 030:", [["Paragraph 030:", "regional leads", "regional managers"], ["Paragraph 029:", "regional leads", "regional managers"], ["Paragraph 250:", "regional leads", "regional managers"], ["Paragraph 270:", "regional leads", "regional managers"]]);
    await page.locator(".de-p", { hasText: "regional managers" }).first().waitFor({ timeout: 30000 });
    const region = page.locator(q("changed-region")).first();
    await region.waitFor({ timeout: 10000 });
    assert.equal(await region.evaluate((e) => getComputedStyle(e).animationName), "chgfade", "a soft fade, not a flash");
    // the "changed" tags sit in the page margin: they cover no paragraph's text (not the line above, not the changed text) and not each other
    const tagHits = await page.evaluate(() => {
      const hit = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
      const tags = [...document.querySelectorAll('[data-testid="changed-tag"]')].map((e) => e.getBoundingClientRect());
      const paras = [...document.querySelectorAll(".de-p")].map((e) => ({ r: e.getBoundingClientRect(), t: e.textContent.slice(0, 14) }));
      const out = [];
      tags.forEach((t, i) => {
        for (const p of paras) if (hit(t, p.r)) out.push(`tag ${i} covers "${p.t}"`);
        tags.forEach((u, j) => j > i && hit(t, u) && out.push(`tag ${i} covers tag ${j}`));
      });
      return { n: tags.length, out, regions: document.querySelectorAll('[data-testid="changed-region"]').length, seen: paras.filter((p) => /^Paragraph (029|030)/.test(p.t)).map((p) => `${p.t} ${Math.round(p.r.top)}`) };
    });
    assert.equal(tagHits.n, 2, `one tag for each of the two changed paragraphs in view ${JSON.stringify(tagHits)}`);
    assert.deepEqual(tagHits.out, [], "no tag covers text or another tag");
    const pill = page.locator(q("changes-away"));
    await pill.waitFor({ timeout: 10000 });
    assert.equal(await pill.getAttribute("data-dir"), "below");
    assert.match(await pill.textContent(), /2 changes below/);
    assert.equal(await inView(page, "Paragraph 030:"), true, "the user was not scrolled away");
    assert.equal(await inView(page, "Paragraph 250:"), false);
    await pill.click();
    await until(() => inView(page, "Paragraph 250:"), "the first place below to come into view");
    await page.locator(q("show-outline")).waitFor({ timeout: 5000 });
    await until(async () => (await page.locator(q("changes-away")).count()) === 1 && /1 change above|1 change below/.test(await page.locator(q("changes-away")).textContent()), "the pill to count what is left");
  });

  test("after a run lands, the focus is back in the document where the user was, so typing can go on", async () => {
    const p = w.spawnCli(["poll", file]);
    await page.locator(q("banner-listening")).waitFor({ timeout: 20000 });
    await selectWord(page, "Paragraph 060:");
    await page.keyboard.press(QUICK);
    await page.locator(q("quick-ask")).waitFor({ timeout: 3000 });
    await page.keyboard.type("Say which office.");
    await page.keyboard.press(`${MODK}+Enter`);
    const batch = await poll(p);
    await page.locator(q("banner-working")).waitFor();
    agentEdit([file, "replace", "regional leads", "regional heads", "Paragraph 060:"]);
    const results = w.doc("results.json");
    fs.writeFileSync(results, JSON.stringify({ summary: "Updated.", results: [{ comment_id: batch.instructions.comments[0].id, status: "done", note: "Done." }] }));
    const done = await w.cli(["done", file, "--results", results]);
    assert.equal(done.code, 0, done.stderr);
    await page.locator(".de-p", { hasText: "regional heads" }).first().waitFor({ timeout: 30000 });
    await until(() => page.evaluate(() => !!document.activeElement?.closest('[data-testid="docwrap"]')), "focus back in the document");
    await until(() => page.evaluate(() => (window.getSelection().anchorNode?.parentElement?.closest(".de-p")?.textContent || "").startsWith("Paragraph 060:")), "the caret back in its paragraph");
  });

  test("with reduced motion the outline is still, and gone after about two seconds", async () => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.evaluate(() => document.querySelector('[data-testid="docwrap"] .de-scroll')?.scrollTo(0, 0));
    await page.waitForFunction(() => document.querySelector('[data-testid="app"]').dataset.fresh === "0", null, { timeout: 8000 }); // an earlier run's highlight is over
    // time the app's own fresh flag (set by the reload, cleared by its timer), not when the test happened to see the outline
    await page.evaluate(() => {
      const app = document.querySelector('[data-testid="app"]');
      window.__fresh = {};
      new MutationObserver(() => {
        const t = performance.now();
        if (app.dataset.fresh === "1") window.__fresh.on ??= t;
        else if (window.__fresh.on != null) window.__fresh.off ??= t;
      }).observe(app, { attributes: true, attributeFilter: ["data-fresh"] });
    });
    await round("Paragraph 012:", [["Paragraph 012:", "regional leads", "regional staff"]]);
    const region = page.locator(q("changed-region")).first();
    await region.waitFor({ timeout: 10000 });
    assert.equal(await region.evaluate((e) => getComputedStyle(e).animationName), "none");
    await page.locator(q("changed-region")).first().waitFor({ state: "detached", timeout: 6000 });
    const fresh = await page.evaluate(() => window.__fresh);
    const gone = fresh.off - fresh.on;
    assert.ok(gone > 1500 && gone < 2600, `the still outline lasts about two seconds (${Math.round(gone)} ms from the reload)`);
    await page.emulateMedia({ reducedMotion: "no-preference" });
  });
});

describe("keyboard shortcuts popover (DOCX)", () => {
  let w, br, page;
  before(async () => {
    w = makeWorld();
    br = await launch();
    page = await open(w, br, w.doc("long.docx"));
  });
  after(async () => {
    await br?.close();
    await w?.cleanup();
  });

  test("the top bar button and the ? key open it, it lists every shortcut for this platform, Esc closes it and returns the focus", async () => {
    const btn = page.locator(q("shortcuts-button"));
    await btn.focus();
    await btn.click();
    const pop = page.locator(q("shortcuts"));
    await pop.waitFor({ timeout: 3000 });
    assert.equal(await btn.getAttribute("aria-expanded"), "true");
    const rows = await pop.locator(q("shortcut-row")).allTextContents();
    const all = rows.join("\n");
    assert.ok(rows.length >= 9, `${rows.length} rows`);
    for (const re of [/Quick ask/, /Send the batch/, /Comment on the selection/, /Next comment box/, /Previous comment box/, /Back to the document/, /Show or hide the panel/, /Move between/, /Show these shortcuts/]) assert.match(all, re);
    if (MAC) assert.match(all, /⌘⇧K/);
    else assert.match(all, /Ctrl\+Shift\+K/);
    assert.ok(!(MAC ? /Ctrl\+/ : /⌘/).test(all), "only this platform's key names are shown");
    await page.keyboard.press("Escape");
    await pop.waitFor({ state: "detached" });
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.testid), "shortcuts-button", "focus returned to the button");
    // ? from a place that is not editable
    await page.locator(q("theme-toggle")).focus();
    await page.keyboard.press("?");
    await pop.waitFor({ timeout: 3000 });
    await page.keyboard.press("Escape");
    await pop.waitFor({ state: "detached" });
    // ? in an editable place types a question mark
    await page.locator(q("overall-note")).focus();
    await page.keyboard.type("Why?");
    assert.equal(await page.locator(q("overall-note")).inputValue(), "Why?");
    assert.equal(await pop.count(), 0);
  });
});

describe("the Overall instructions box (DOCX)", () => {
  let w, br;
  before(async () => {
    w = makeWorld();
    br = await launch();
  });
  after(async () => {
    await br?.close();
    await w?.cleanup();
  });

  test("Enter adds a line and sends nothing; Cmd/Ctrl+Enter sends the note on its own, with no comment", async () => {
    const file = w.doc("long.docx");
    const p = w.spawnCli(["poll", file]);
    const page = await open(w, br, file);
    await page.locator(q("banner-listening")).waitFor({ timeout: 20000 });
    const box = page.locator(q("overall-note"));
    await box.focus();
    await page.keyboard.type("Keep the tone formal.");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Use short sentences.");
    const early = await Promise.race([p.done, new Promise((r) => setTimeout(() => r("quiet"), 1500))]);
    assert.equal(early, "quiet", "Enter alone sends nothing");
    assert.equal(await box.inputValue(), "Keep the tone formal.\nUse short sentences.");
    await page.keyboard.press(`${MODK}+Enter`);
    const batch = await poll(p);
    assert.equal(batch.instructions.overall_note, "Keep the tone formal.\nUse short sentences.");
    assert.equal(batch.instructions.comments.length, 0, "the note went out on its own");
    await page.locator(q("banner-working")).waitFor();
    assert.equal(await box.inputValue(), "", "the note box is empty after Send");
  });
});

describe("typing while the agent works (DOCX)", () => {
  let w, br, file, page, readDocxParagraphs;
  before(async () => {
    w = makeWorld();
    br = await launch();
    file = w.doc("long.docx");
    page = await open(w, br, file);
    ({ readDocxParagraphs } = await srcModule("docx.js"));
  });
  after(async () => {
    await br?.close();
    await w?.cleanup();
  });
  const onDisk = (prefix) => readDocxParagraphs(fs.readFileSync(file)).find((p) => p.text.startsWith(prefix))?.text;
  const typeAtEnd = async (prefix, add) => {
    const b = await boxOf(await scrollToPara(page, prefix, Number(prefix.match(/\d+/)[0]) / 300));
    await page.mouse.click(b.x + b.width - 40, b.y + b.height - 10);
    await page.keyboard.press(LINE_END);
    await page.keyboard.type(add);
  };
  /** Comment on `prefix`, Send, and return the delivered batch: the agent now holds the file. */
  const deliver = async (prefix) => {
    const p = w.spawnCli(["poll", file]);
    await page.locator(q("banner-listening")).waitFor({ timeout: 20000 });
    await selectWord(page, prefix);
    await page.keyboard.press(QUICK);
    await page.locator(q("quick-ask")).waitFor({ timeout: 3000 });
    await page.keyboard.type("Please update.");
    await page.keyboard.press(`${MODK}+Enter`);
    const batch = await poll(p);
    await page.locator(q("banner-working")).waitFor();
    return batch;
  };
  /** The agent's text is in the page. On a timeout, say what the page and the file show, so a failure carries its own evidence. */
  const landed = (text) =>
    page
      .locator(".de-p", { hasText: text })
      .first()
      .waitFor({ timeout: 30000 })
      .catch(async (e) => {
        const state = await page.evaluate((t) => {
          const ps = [...document.querySelectorAll(".de-p")];
          const sc = document.querySelector(".de-scroll");
          return { paras: ps.length, has: ps.some((p) => p.textContent.includes(t)), first: ps[0]?.textContent.slice(0, 20), scroll: sc ? [sc.scrollTop, sc.scrollHeight] : null, banners: [...document.querySelectorAll("[data-testid^=banner]")].map((b) => `${b.dataset.testid}: ${b.innerText}`), top: document.querySelector(".topbar")?.innerText };
        }, text);
        const disk = readDocxParagraphs(fs.readFileSync(file)).some((p) => p.text.includes(text));
        console.error(`"${text}" did not show.\npage: ${JSON.stringify(state)}\non disk: ${disk}\nlog: ${JSON.stringify(page.log).slice(-2000)}`); // printed: the runner does not show an edited message
        throw e;
      });
  const finish = async (batch) => {
    const results = w.doc("results.json");
    fs.writeFileSync(results, JSON.stringify({ summary: "Updated.", results: [{ comment_id: batch.instructions.comments[0].id, status: "done", note: "Done." }] }));
    const done = await w.cli(["done", file, "--results", results]);
    assert.equal(done.code, 0, done.stderr);
  };

  test("the document is not locked: what the user types in another paragraph is merged with the agent's change, in the page and on disk", async () => {
    const batch = await deliver("Paragraph 020:");
    assert.match(await page.locator(q("banner-lock-line")).textContent(), /Keep editing/);
    assert.equal(await page.locator(q("editbar")).isHidden(), false, "the formatting bar stays");
    assert.equal(await page.locator(".locked-note").count(), 0, "no locked note");
    await typeAtEnd("Paragraph 024:", " TYPED-WHILE-WORKING");
    assert.match(await page.locator(".de-p", { hasText: "Paragraph 024:" }).first().textContent(), /TYPED-WHILE-WORKING/, "the typing shows at once");
    agentEdit([file, "replace", "regional leads", "regional heads", "Paragraph 020:"]);
    await finish(batch);
    await landed("regional heads");
    await until(async () => /TYPED-WHILE-WORKING/.test((await page.locator(".de-p", { hasText: "Paragraph 024:" }).first().textContent().catch(() => "")) || ""), "the typed text to be in the reloaded page");
    assert.match(onDisk("Paragraph 020:"), /regional heads/, "the agent's change is on disk");
    assert.match(onDisk("Paragraph 024:"), /TYPED-WHILE-WORKING$/, "the user's typing is on disk");
    assert.equal(await page.locator(q("banner-held-back")).count(), 0, "nothing was held back");
    assert.match(await page.locator(".topbar").textContent(), /No unsent edits/, "the merged edit is saved, not pending");
  });

  test("the user and the agent change the same paragraph: the agent's text stays and the user's text is shown with a Copy button", async () => {
    const batch = await deliver("Paragraph 040:");
    await typeAtEnd("Paragraph 040:", " MINE-TOO");
    agentEdit([file, "replace", "regional leads", "regional chiefs", "Paragraph 040:"]);
    await finish(batch);
    const held = page.locator(q("banner-held-back"));
    await held.waitFor({ timeout: 30000 });
    assert.match(await held.textContent(), /One edit you made while the agent worked is not in the document/);
    assert.match(await held.locator(q("held-item")).first().textContent(), /agent changed this paragraph too[\s\S]*MINE-TOO/);
    assert.match(onDisk("Paragraph 040:"), /regional chiefs/);
    assert.ok(!/MINE-TOO/.test(onDisk("Paragraph 040:")), "the agent's paragraph was not overwritten");
    await page.locator(q("held-dismiss")).click();
    await held.waitFor({ state: "detached" });
  });

  test("a new line typed while the agent works lands under its paragraph", async () => {
    const batch = await deliver("Paragraph 050:");
    await typeAtEnd("Paragraph 052:", "");
    await page.keyboard.press("Enter");
    await page.keyboard.type("A line typed during the run.");
    agentEdit([file, "replace", "regional leads", "regional peers", "Paragraph 050:"]);
    await finish(batch);
    await landed("regional peers");
    await until(() => !!onDisk("A line typed during the run."), "the new line to be on disk");
    const texts = readDocxParagraphs(fs.readFileSync(file)).map((p) => p.text);
    const at = texts.findIndex((t) => t.startsWith("A line typed during the run."));
    assert.match(texts[at - 1], /^Paragraph 052:/, "right under the paragraph it was typed after");
    assert.match(texts[at + 1], /^Paragraph 053:/);
    assert.equal(await page.locator(q("banner-held-back")).count(), 0);
  });
  test("typed edits are not a batch, and a second ask queued during the run still ends with both agent changes and the typing on disk", async () => {
    const batch = await deliver("Paragraph 070:");
    await typeAtEnd("Paragraph 074:", " TYPED-IN-RUN-ONE");
    await page.waitForTimeout(300);
    assert.equal(await page.locator(q("send")).isDisabled(), true, "typing alone is nothing to queue");
    assert.match(await page.locator("#send-hint").textContent(), /merged when the agent finishes/);
    // a second ask while the first is with the agent
    await selectWord(page, "Paragraph 078:");
    await page.keyboard.press(QUICK);
    await page.locator(q("quick-ask")).waitFor({ timeout: 3000 });
    await page.keyboard.type("And this one.");
    await page.keyboard.press(`${MODK}+Enter`);
    await until(async () => (await page.locator(q("comment-card")).count()) >= 1 && /queued|Waiting/i.test(await page.locator(".sidebar").textContent()), "the second ask to be queued");
    agentEdit([file, "replace", "regional leads", "regional ones", "Paragraph 070:"]);
    await finish(batch);
    // the agent comes straight back for the queued batch, as `reply --then-poll` does
    const second = await poll(w.spawnCli(["poll", file]));
    assert.equal(second.instructions.comments.length, 1);
    agentEdit([file, "replace", "regional leads", "regional twos", "Paragraph 078:"]);
    fs.writeFileSync(w.doc("results.json"), JSON.stringify({ summary: "Updated.", results: [{ comment_id: second.instructions.comments[0].id, status: "done", note: "Done." }] }));
    const done = await w.cli(["done", file, "--results", w.doc("results.json")]);
    assert.equal(done.code, 0, done.stderr);
    await until(() => /TYPED-IN-RUN-ONE$/.test(onDisk("Paragraph 074:") || ""), "the typing to reach the disk after both runs");
    assert.match(onDisk("Paragraph 070:"), /regional ones/);
    assert.match(onDisk("Paragraph 078:"), /regional twos/);
    await landed("regional twos");
    assert.equal(await page.locator(q("banner-held-back")).count(), 0);
    await until(async () => /No unsent edits/.test(await page.locator(".topbar").textContent()), "the page to hold no unsent edits");
  });
  test("a refresh never takes the reader back to the top or to where they were at Send: scrolled away during the run, they stay there", async () => {
    const batch = await deliver("Paragraph 100:");
    const far = await scrollToPara(page, "Paragraph 230:", 230 / 300);
    await page.waitForTimeout(400);
    const y0 = (await boxOf(far)).y;
    await page.waitForFunction(() => document.querySelector('[data-testid="app"]').dataset.fresh === "0", null, { timeout: 8000 });
    agentEdit([file, "replace", "regional leads", "regional crews", "Paragraph 100:"]);
    await finish(batch);
    await page.waitForFunction(() => document.querySelector('[data-testid="app"]').dataset.fresh === "1", null, { timeout: 30000 });
    await until(() => inView(page, "Paragraph 230:"), "the paragraph the reader was on to be in view after the refresh", 8000);
    await page.waitForTimeout(600);
    const y1 = (await boxOf(page.locator(".de-p", { hasText: "Paragraph 230:" }).first())).y;
    assert.ok(Math.abs(y1 - y0) < 40, `the paragraph is where it was (${Math.round(y0)} -> ${Math.round(y1)})`);
    assert.equal(await inView(page, "Paragraph 100:"), false, "not pulled back to the place of the Send");
    assert.match(onDisk("Paragraph 100:"), /regional crews/);
  });
});

describe("the review panel is one stack, oldest at the top, newest right above the Send area", () => {
  let w, br, file, page;
  before(async () => {
    w = makeWorld();
    br = await launch();
    file = w.doc("long.docx");
    page = await open(w, br, file);
  });
  after(async () => {
    await br?.close();
    await w?.cleanup();
  });
  /** One whole round: Quick ask on `prefix`, the agent answers `note`. */
  const round = async (prefix, note) => {
    const p = w.spawnCli(["poll", file]);
    await page.locator(q("banner-listening")).waitFor({ timeout: 20000 });
    await selectWord(page, prefix);
    await page.keyboard.press(QUICK);
    await page.locator(q("quick-ask")).waitFor({ timeout: 3000 });
    await page.keyboard.type(`Ask about ${prefix}`);
    await page.keyboard.press(`${MODK}+Enter`);
    const batch = await poll(p);
    const results = w.doc("results.json");
    fs.writeFileSync(results, JSON.stringify({ summary: `Run for ${prefix}`, results: [{ comment_id: batch.instructions.comments[0].id, status: "done", note }] }));
    const done = await w.cli(["done", file, "--results", results]);
    assert.equal(done.code, 0, done.stderr);
    await until(async () => (await page.locator(`${q("activity-entry")} >> text=Run for ${prefix}`).count()) > 0, `the run for ${prefix} to land`);
    // the page reloads the file after a run: wait until the document is back before touching it again
    await until(async () => (await page.locator(".topbar").textContent()).includes("Agent listening") === false && (await page.locator(".de-scroll .de-p").count()) > 0, "the document to be back");
    await page.waitForTimeout(600);
  };
  /** The stack as the reader sees it: one word per card, top to bottom. */
  const order = () => page.evaluate(() => [...document.querySelectorAll('[data-testid="panel-stack"] > li')].map((li) => `${li.dataset.testid}:${li.dataset.open ?? ""}`));
  /** The space between the newest card and the Send area, and how far the list is from its bottom. */
  const bottom = () =>
    page.evaluate(() => {
      const box = document.querySelector('[data-testid="sidebar"] .scroll');
      const last = document.querySelector('[data-testid="panel-stack"] > li:last-child').getBoundingClientRect();
      const send = document.querySelector('[data-testid="sidebar"] .composer').getBoundingClientRect();
      return { gap: send.top - last.bottom, fromEnd: box.scrollHeight - box.clientHeight - box.scrollTop };
    });

  test("cards stay in the order they were sent, answered ones fold, and a new card lands right above the Send area with room under it", async () => {
    const sendEnd = async () => { const c = await boxOf(page.locator(".composer")); return c.y + c.height; };
    const end0 = await sendEnd();
    await round("Paragraph 010:", "First answer.");
    await round("Paragraph 012:", "Second answer.");
    // the newest round is the newest thing in the stack: it is open, with the answer on the card it answers; the older round is folded
    assert.deepEqual(await order(), ["comment-card:0", "activity-entry:0", "comment-card:1", "activity-entry:1"]);
    const cards = page.locator(q("comment-card"));
    assert.match(await cards.nth(1).locator(q("agent-note")).innerText(), /Second answer\./);
    assert.equal(await cards.nth(0).locator(q("agent-note")).isVisible(), false, "the older answer is folded away");
    assert.equal(await page.locator(q("activity-result")).count(), 0, "answers are not repeated in the run card");
    // a third comment, not sent: it lands at the bottom and everything finished above it folds to one line
    await selectWord(page, "Paragraph 014:");
    await page.locator(q("comment-chip")).click();
    await page.keyboard.type("A draft");
    await until(async () => (await order()).length === 5, "five cards in the stack");
    assert.deepEqual(await order(), ["comment-card:0", "activity-entry:0", "comment-card:0", "activity-entry:0", "comment-card:1"], "comment, its run, comment, its run, the draft, in the order they were sent");
    const heights = await page.evaluate(() => [...document.querySelectorAll('[data-testid="panel-stack"] > li[data-open="0"]')].map((li) => li.offsetHeight));
    assert.ok(heights.every((h) => h <= 48), `a folded card is one line (${heights})`);
    // the newest card sits right above the Send area, with room for the next one, and the Send area has not moved
    await until(async () => (await bottom()).fromEnd < 4, "the list to rest at its bottom");
    const b = await bottom();
    assert.ok(b.gap >= 24 && b.gap <= 90, `room under the newest card (${Math.round(b.gap)}px)`);
    assert.ok(Math.abs((await sendEnd()) - end0) < 2, "the Send area stays pinned at the bottom");
    // a folded card opens on a click and folds again
    await cards.nth(0).locator(q("card-open")).click();
    assert.match(await cards.nth(0).locator(q("agent-note")).innerText(), /First answer\./);
    await cards.nth(0).locator(q("card-fold")).click();
    assert.equal(await cards.nth(0).getAttribute("data-open"), "0");
  });

  test("a typed edit joins the stack under the newest card, and History is a folded row above everything", async () => {
    const para = await scrollToPara(page, "Paragraph 016:", 16 / 300);
    const pb = await boxOf(para);
    await page.mouse.click(pb.x + 60, pb.y + 10);
    await page.keyboard.type("EDIT ");
    await until(async () => (await order()).at(-1) === "change-item:", "the edit to be the newest card");
    await until(async () => (await bottom()).fromEnd < 4, "the list to follow the new card");
    const tops = await page.evaluate(() => ["panel-history", "panel-stack"].map((id) => document.querySelector(`[data-testid="${id}"]`).getBoundingClientRect().top));
    assert.ok(tops[0] < tops[1], "History is above the stack");
    assert.equal(await page.locator(q("history-collapse")).getAttribute("aria-expanded"), "false", "History starts folded");
  });

  test("an answered pin is folded; clicking its mark in the document opens its card and brings it into view; the last run can still be reverted from its folded card", async () => {
    await page.locator(q("mode-pin")).click();
    const pb = await boxOf(await scrollToPara(page, "Paragraph 018:", 18 / 300));
    await page.mouse.click(pb.x + 120, pb.y + 12);
    await page.keyboard.type("Pin this");
    await page.locator(q("mode-edit")).click();
    const p = w.spawnCli(["poll", file]);
    await page.locator(q("banner-listening")).waitFor({ timeout: 20000 });
    await page.locator(q("send")).click();
    const batch = await poll(p);
    const results = w.doc("results-pin.json");
    fs.writeFileSync(results, JSON.stringify({ summary: "Pin round", results: batch.instructions.comments.map((c) => ({ comment_id: c.id, status: "done", note: "Ok." })) }));
    assert.equal((await w.cli(["done", file, "--results", results])).code, 0);
    await until(async () => (await page.locator(`${q("activity-entry")} >> text=Pin round`).count()) > 0, "the pin round to land");
    await until(async () => (await page.locator(".de-scroll .de-p").count()) > 0, "the document to be back");
    await page.waitForTimeout(600);
    // something newer: the round folds
    await selectWord(page, "Paragraph 020:");
    await page.locator(q("comment-chip")).click();
    await page.keyboard.type("Newer");
    const pin = page.locator(`${q("comment-card")}[data-kind="pin"]`);
    await until(async () => (await pin.getAttribute("data-open")) === "0", "the answered pin to fold");
    // many cards now: scroll the panel to its top so the pin is out of view, then click the mark in the document
    await page.evaluate(() => (document.querySelector('[data-testid="sidebar"] .scroll').scrollTop = 0));
    await scrollToPara(page, "Paragraph 018:", 18 / 300);
    await page.locator(q("pin-mark")).first().click();
    await until(async () => (await pin.getAttribute("data-open")) === "1", "the pin card to open");
    await until(
      () =>
        page.evaluate(() => {
          const box = document.querySelector('[data-testid="sidebar"] .scroll').getBoundingClientRect();
          const r = document.querySelector('[data-testid="comment-card"][data-kind="pin"]').getBoundingClientRect();
          return r.top >= box.top - 1 && r.bottom <= box.bottom + 1;
        }),
      "the pin card to be in view"
    );
    // the last run is folded under the newer card, and Revert is still on its folded line: never a click further away
    const run = page.locator(q("activity-entry")).last();
    assert.equal(await run.getAttribute("data-open"), "0");
    assert.equal(await run.locator(q("revert")).isVisible(), false);
    assert.equal(await run.locator(q("revert-folded")).isVisible(), true, "Revert shows on the folded line");
    await run.locator(q("run-fold")).click();
    assert.equal(await run.locator(q("revert")).isVisible(), true);
    assert.equal(await run.locator(q("revert-folded")).count(), 0, "one Revert button at a time");
    await run.locator(q("run-fold")).click();
    await run.locator(q("revert-folded")).click();
    await page.locator(`${q("activity-entry")}[data-kind="revert"]`).waitFor({ timeout: 20000 });
    assert.equal(await page.locator(`${q("activity-entry")}[data-reverted="1"] ${q("revert-folded")}`).count(), 0, "a reverted run offers no second Revert");
  });

  test("on a phone the sheet holds the same stack in the same order, the newest card above the Send area, nothing wider than the screen", async () => {
    const wide = await order();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator(q("sidebar-toggle")).click();
    await page.locator(q("sheet-grab")).waitFor({ timeout: 5000 });
    await page.waitForTimeout(900);
    assert.deepEqual(await order(), wide, "the same cards, in the same order, folded the same way");
    const half = await bottom();
    assert.ok(half.fromEnd < 4, "the half-height sheet rests on the newest card");
    await page.locator(q("sheet-grab")).click();
    await page.waitForTimeout(900);
    const m = await page.evaluate(() => {
      const side = document.querySelector('[data-testid="sidebar"]');
      const box = side.querySelector(".scroll");
      const last = document.querySelector('[data-testid="panel-stack"] > li:last-child').getBoundingClientRect();
      const send = side.querySelector(".composer").getBoundingClientRect();
      return { lastBottom: last.bottom, sendTop: send.top, sendBottom: send.bottom, vh: innerHeight, wide: [box.scrollWidth - box.clientWidth, side.scrollWidth - side.clientWidth, document.documentElement.scrollWidth - innerWidth] };
    });
    assert.ok(m.lastBottom <= m.sendTop, `the newest card ends above the Send area (${Math.round(m.lastBottom)} <= ${Math.round(m.sendTop)})`);
    assert.ok(m.sendBottom <= m.vh, "the Send area is on the screen");
    assert.ok(m.wide.every((d) => d <= 0), `nothing scrolls sideways (${m.wide})`);
  });
});

describe("a refresh the page missed is caught up when the connection is back (DOCX)", () => {
  let w, br, file, page, readDocxParagraphs;
  before(async () => {
    w = makeWorld();
    br = await launch();
    file = w.doc("long.docx");
    page = await open(w, br, file);
    ({ readDocxParagraphs } = await srcModule("docx.js"));
  });
  after(async () => {
    await br?.close();
    await w?.cleanup();
  });
  const onDisk = (prefix) => readDocxParagraphs(fs.readFileSync(file)).find((p) => p.text.startsWith(prefix))?.text;
  const typeAtEnd = async (prefix, add) => {
    const b = await boxOf(await scrollToPara(page, prefix, Number(prefix.match(/\d+/)[0]) / 300));
    await page.mouse.click(b.x + b.width - 40, b.y + b.height - 10);
    await page.keyboard.press(LINE_END);
    await page.keyboard.type(add);
  };
  /**
   * Send a comment on `prefix`; while the agent holds the batch `during` runs; then the network goes away, the agent changes "leads"
   * to `word` and finishes, and the network comes back. `dropStream` also cuts the event stream, so the page never hears of the run.
   */
  const missedRun = async (prefix, word, { during = async () => {}, dropStream = false } = {}) => {
    const p = w.spawnCli(["poll", file]);
    await page.locator(q("banner-listening")).waitFor({ timeout: 20000 });
    await selectWord(page, prefix);
    await page.keyboard.press(QUICK);
    await page.locator(q("quick-ask")).waitFor({ timeout: 3000 });
    await page.keyboard.type("Please update.");
    await page.keyboard.press(`${MODK}+Enter`);
    const batch = await poll(p);
    await page.locator(q("banner-working")).waitFor();
    await during();
    await page.context().setOffline(true);
    if (dropStream) await page.evaluate(() => window.stop());
    agentEdit([file, "replace", "regional leads", `regional ${word}`, prefix]);
    const results = w.doc("results.json");
    fs.writeFileSync(results, JSON.stringify({ summary: "Updated.", results: [{ comment_id: batch.instructions.comments[0].id, status: "done", note: "Done." }] }));
    const done = await w.cli(["done", file, "--results", results]);
    assert.equal(done.code, 0, done.stderr);
    await page.waitForTimeout(1500);
    assert.equal(await page.locator(".de-p", { hasText: `regional ${word}` }).count(), 0, "the page does not have the change yet");
    if (dropStream) assert.equal(await page.locator(q("banner-working")).count(), 1, "the page never heard that the agent finished");
    else await page.locator(q("banner-error")).waitFor({ timeout: 5000 }); // it heard, and its reload did not get through
    await page.context().setOffline(false);
  };
  /** The agent's text is in the page (the paragraph is brought into view first: only the pages near the view are rendered). */
  const shows = (prefix, text) =>
    until(async () => {
      try {
        return (await (await scrollToPara(page, prefix, Number(prefix.match(/\d+/)[0]) / 300)).textContent()).includes(text);
      } catch {
        return false; // the document is being replaced
      }
    }, `"${text}" to show in ${prefix}`, 40000);
  /** The page is quiet again: the document is back and no refresh is under way (the next test clicks into it). */
  const settled = async () => {
    await until(async () => (await page.locator(".de-scroll .de-p").count()) > 0 && (await page.locator(q("state-pill")).first().textContent()) === "Idle", "the document to be back");
    await page.waitForTimeout(600);
  };
  const calm = async () => {
    await until(async () => (await page.locator(q("banner-error")).count()) === 0, "the error message to go away");
    assert.equal(await page.locator(q("banner-outside")).count(), 0, "not reported as a change from outside");
    assert.equal(await page.locator(q("banner-held-back")).count(), 0, "nothing held back");
    await settled();
  };

  test("the reload fails when the agent finishes: it is tried again and the change shows, with no message left behind", async () => {
    await missedRun("Paragraph 020:", "heads");
    await shows("Paragraph 020:", "regional heads");
    await until(async () => (await page.locator(`${q("comment-card")}[data-status="done"]`).count()) === 1, "the card to show its answer");
    await calm();
  });

  test("the event stream is down when the agent finishes: the page catches up from the next state it sees", async () => {
    await missedRun("Paragraph 030:", "crews", { dropStream: true });
    await shows("Paragraph 030:", "regional crews");
    await until(async () => (await page.locator(`${q("comment-card")}[data-status="done"]`).count()) === 2, "both cards to show their answers");
    await calm();
  });

  test("the same with typing in between: what the user typed is merged, not lost", async () => {
    await missedRun("Paragraph 040:", "chiefs", { dropStream: true, during: () => typeAtEnd("Paragraph 044:", " TYPED-WHILE-CUT-OFF") });
    await shows("Paragraph 040:", "regional chiefs");
    await until(() => /TYPED-WHILE-CUT-OFF$/.test(onDisk("Paragraph 044:") || ""), "the typed text to reach the disk");
    assert.match(onDisk("Paragraph 040:"), /regional chiefs/);
    await calm();
  });

  test("typing in between and the merge does not get through: it is tried again, and the typing is kept", async () => {
    await missedRun("Paragraph 050:", "peers", { during: () => typeAtEnd("Paragraph 054:", " TYPED-THEN-RETRIED") });
    await shows("Paragraph 050:", "regional peers");
    await until(() => /TYPED-THEN-RETRIED$/.test(onDisk("Paragraph 054:") || ""), "the typed text to reach the disk");
    await calm();
  });
});

describe("typing after scrolling away from the cursor (DOCX)", () => {
  let w, br, page;
  before(async () => {
    w = makeWorld();
    br = await launch();
    page = await open(w, br, w.doc("long.docx"));
  });
  after(async () => {
    await br?.close();
    await w?.cleanup();
  });

  test("click in a paragraph, scroll far away, type: the text lands in that paragraph, not at the top of the document, and the view comes back to it", async () => {
    const b = await boxOf(await scrollToPara(page, "Paragraph 044:", 44 / 300));
    await page.mouse.click(b.x + b.width - 40, b.y + b.height - 10);
    await page.waitForTimeout(400);
    for (let i = 0; i < 12; i++) {
      await page.mouse.wheel(0, 1500);
      await page.waitForTimeout(100);
    }
    await page.waitForTimeout(600);
    assert.equal(await inView(page, "Paragraph 044:"), false, "the paragraph with the cursor is far out of view");
    await page.keyboard.type(" TYPED-AFTER-SCROLL");
    await until(() => inView(page, "Paragraph 044:"), "the view to come back to the cursor", 8000);
    const where = await page.evaluate(() => [...document.querySelectorAll(".de-p")].filter((p) => p.textContent.includes("TYPED-AFTER-SCROLL")).map((p) => p.textContent.slice(0, 14)));
    assert.deepEqual(where, ["Paragraph 044:"], "the text is in the paragraph that held the cursor");
    assert.match(await page.locator(".de-p", { hasText: "Paragraph 044:" }).first().textContent(), /TYPED-AFTER-SCROLL$/);
    await page.evaluate(() => (document.querySelector(".de-scroll").scrollTop = 0));
    await page.waitForTimeout(500);
    assert.ok(!/TYPED/.test(await page.locator(".de-p").first().textContent()), "the title is untouched");
  });

  test("the End key, then typing: on a Mac End scrolls to the end of the document, and the text still goes where the cursor is", async () => {
    const b = await boxOf(await scrollToPara(page, "Paragraph 060:", 60 / 300));
    await page.mouse.click(b.x + b.width - 40, b.y + b.height - 10);
    await page.waitForTimeout(400);
    await page.keyboard.press("End");
    await page.waitForTimeout(1500); // a Mac has scrolled to the end by now; elsewhere the caret went to the end of its line
    await page.keyboard.type(" TYPED-AFTER-END");
    await until(() => inView(page, "Paragraph 060:"), "the view to be on the cursor", 8000);
    const where = await page.evaluate(() => [...document.querySelectorAll(".de-p")].filter((p) => p.textContent.includes("TYPED-AFTER-END")).map((p) => p.textContent.slice(0, 14)));
    assert.deepEqual(where, ["Paragraph 060:"], "the text is in the paragraph that held the cursor");
  });
});
