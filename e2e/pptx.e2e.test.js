import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, describe, test } from "node:test";
import { agentEdit, boxCenterDist, cspViolations, gotoSlide, launch, makeWorld, overlaps, shapeBox, slideBox, srcModule, until, visibleSlide, waitDoc, wordPoint } from "./helpers/harness.mjs";

// The whole review loop on a deck, twice: through `onionskin apply` (ops built from the batch) and with python-pptx directly (insert a
// slide before the commented one and change the commented shape's text).

const BODY = 3; // cNvPr id of the body placeholder on every slide of deck.pptx
const NOTE = 4; // the "Side note" text box on slide 4
const deckOf = async (file) => {
  const { parseDeck } = await srcModule("pptx.js");
  const d = parseDeck(fs.readFileSync(file));
  d.ensure();
  return d;
};
const shapeText = async (file, slideId, shapeId) => (await deckOf(file)).slides.find((s) => s.id === slideId).shapes.find((x) => x.id === shapeId)?.text;

async function commentOnShape(page, slide, sid, text, at = [0.5, 0.3]) {
  await page.locator('[data-testid="mode-comment"]').click();
  const b = await shapeBox(page, slide, sid);
  assert.ok(b, `shape ${sid} on slide ${slide} not rendered`);
  await page.mouse.click(b.x + b.w * at[0], b.y + b.h * at[1]);
  await page.locator('[data-testid="comment-card"] textarea').last().fill(text);
  await page.locator('[data-testid="mode-edit"]').click();
}

async function draftAndSend(w, br, file) {
  const poll = w.spawnCli(["poll", file]);
  const page = await br.page();
  await page.goto(await w.open(file));
  await waitDoc(page, ".de-slide");
  await page.locator('[data-testid="banner-listening"]').waitFor({ timeout: 20000 });
  await page.waitForTimeout(1200);

  // the user's own edit: text typed into the body of slide 2
  await gotoSlide(page, 2);
  const b2 = await shapeBox(page, 2, BODY);
  const year = await wordPoint(page, 2, BODY, "year", true);
  await page.mouse.click(year.x, year.y);
  await page.mouse.click(year.x, year.y); // the second click puts the caret at the end of the text
  await page.keyboard.type(" TYPED");
  await page.mouse.click(b2.x + b2.w * 0.5, b2.y + b2.h + 40); // blur flushes the text debounce
  await page.locator('[data-testid="change-item"]').first().waitFor({ timeout: 10000 });
  assert.match(await page.locator('[data-testid="change-label"]').first().textContent(), /^Slide 2/);
  assert.match(await page.locator('[data-testid="change-item"]').first().textContent(), /TYPED/);

  await gotoSlide(page, 4);
  // a comment on a text selection inside a shape (Edit mode: double-click selects the word, the chip offers the comment)
  const word = await wordPoint(page, 4, BODY, "March");
  assert.ok(word, "the word March is rendered");
  await page.mouse.click(word.x, word.y); // first click puts the caret in the text
  await page.mouse.dblclick(word.x, word.y);
  const chip = page.locator('[data-testid="comment-chip"]');
  await chip.waitFor({ timeout: 5000 });
  await chip.click();
  const textCard = page.locator('[data-testid="comment-card"][data-kind="text"]');
  await textCard.locator("textarea").fill("Which date in this month?");
  // the card quotes the selected words and says the outline is the whole shape (the host reports only the shape box)
  assert.equal((await textCard.locator('[data-testid="card-preview"]').textContent()).trim(), "March");
  assert.match(await textCard.locator('[data-testid="card-scope"]').textContent(), /Selected words in this shape.*whole shape/);
  // a comment on a shape, one on the slide itself, pins (one tied to a shape, one on empty slide area)
  await commentOnShape(page, 4, NOTE, "Who owns this?", [0.2, 0.5]);
  await page.locator('[data-testid="mode-comment"]').click();
  const s4 = await slideBox(page, 4);
  await page.mouse.click(s4.x + s4.w * 0.5, s4.y + s4.h * 0.96); // empty slide area below the body
  await page.locator('[data-testid="comment-card"][data-slide="4"]:not([data-shape])').last().locator("textarea").fill("Add the agenda link on this slide.");
  await page.locator('[data-testid="mode-pin"]').click();
  await page.mouse.click(s4.x + s4.w * 0.975, s4.y + s4.h * 0.5); // the empty right margin
  await page.locator('[data-testid="comment-card"][data-kind="pin"] textarea').last().fill("Move the logo here?");
  await page.locator('[data-testid="mode-edit"]').click();
  // another slide: a comment on its body, and a cross-slide jump
  await gotoSlide(page, 6);
  await commentOnShape(page, 6, BODY, "Name the owners here.");
  await gotoSlide(page, 1);
  assert.equal(await visibleSlide(page), 1);
  // thumbnail strip: count badges on the slides that have comments
  const badges = await until(async () => {
    const t = await page.locator('[data-testid="thumb-badge"]').evaluateAll((els) => els.map((e) => [e.dataset.slide, e.textContent.trim()]));
    return t.length >= 2 ? t : null;
  }, "thumbnail badges");
  assert.deepEqual(badges.sort(), [["4", "4"], ["6", "1"]]);
  const jump = page.locator('[data-testid="comment-card"][data-slide="6"] .locate');
  await jump.click();
  await until(async () => (await visibleSlide(page)) === 6, "card jumps to slide 6");
  await gotoSlide(page, 4);
  assert.equal(await visibleSlide(page), 4);
  await page.locator('[data-testid="overall-note"]').fill("Keep it short.");
  await page.waitForTimeout(700);
  await page.locator('[data-testid="send"]').click();
  const res = await Promise.race([poll.done, new Promise((r) => setTimeout(() => r(null), 20000))]);
  assert.ok(res, "poll did not return after Send");
  assert.equal(res.code, 0, res.stderr);
  return { page, batch: JSON.parse(res.stdout) };
}

function checkBatch(batch) {
  assert.equal(batch.format, "pptx");
  assert.equal(batch.instructions.overall_note, "Keep it short.");
  const cs = batch.instructions.comments;
  assert.equal(cs.length, 5);
  assert.deepEqual(cs.map((c) => c.kind).sort(), ["element", "element", "element", "pin", "text"]);
  assert.ok(!/Slide \d|headline|March|Product team|Welcome|Ship the/.test(JSON.stringify(batch.instructions)), "no document text inside `instructions`");
  const A = batch.untrusted_document_evidence.anchors;
  const of = (f) => A.find((a) => a.id === cs.find(f).anchor_id);
  const text = of((c) => c.kind === "text");
  assert.match(text.label, /^Slide 4 "Slide 4 headline", shape "Content Placeholder \d+"$/);
  assert.deepEqual({ slide_id: text.locator.slide_id, shape_id: text.locator.shape_id }, { slide_id: "259", shape_id: BODY });
  assert.equal(text.quote, "March");
  assert.ok(text.prefix.length + text.suffix.length > 0, "prefix/suffix carried");
  assert.match(text.locator.text_hash, /^[0-9a-f]{16}$/);
  const note = of((c) => c.text.startsWith("Who owns"));
  assert.equal(note.locator.shape_id, NOTE);
  assert.equal(note.quote, "Owner: Product team");
  const slide = of((c) => c.text.startsWith("Add the agenda"));
  assert.equal(slide.unit, "slide");
  assert.equal(slide.locator.shape_id, null);
  const pin = of((c) => c.kind === "pin");
  assert.ok(pin.pin.x_fraction > 0.95 && pin.pin.x_fraction < 1 && pin.pin.y_fraction > 0.4 && pin.pin.y_fraction < 0.6, JSON.stringify(pin.pin));
  assert.equal(pin.pin.on, "slide");
  const other = of((c) => c.text.startsWith("Name the owners"));
  assert.equal(other.locator.slide_id, "261");
  for (const a of A) for (const k of ["quote", "prefix", "suffix", "label"]) assert.ok([...a[k]].length <= 500, `${k} capped`);
  const ed = batch.untrusted_document_evidence.user_edits;
  assert.equal(ed.length, 1);
  assert.match(ed[0].after, /TYPED$/);
  assert.ok(!ed[0].before.includes("TYPED"));
  return { text, note, cs };
}

/** After `done`: the same slide in view, cards re-attached by slide id, the shape's marker on the shape, thumbnail badges, changed regions. */
async function checkLanded(page, { slide, last }) {
  await page.locator('[data-testid="activity-entry"]').first().waitFor({ timeout: 25000 });
  await until(async () => (await visibleSlide(page)) === slide, `same slide in view (slide ${slide})`);
  const textCard = page.locator('[data-testid="comment-card"][data-kind="text"]');
  await until(async () => (await textCard.getAttribute("data-slide")) === String(slide), `the text comment re-attached to slide ${slide}`);
  assert.equal(await textCard.getAttribute("data-resolved"), "ok");
  assert.equal(await textCard.getAttribute("data-changed"), "1", "the card says the text changed");
  assert.equal(await page.locator(`[data-testid="comment-card"][data-slide="${last}"]`).count(), 1, "the comment on the last slide followed it");
  assert.equal(await page.locator('[data-testid="comment-card"][data-resolved="moved"]').count(), 0);
  const id = await textCard.getAttribute("data-comment-id");
  // the marker sits on the shape's top left corner, or at the left edge of its visible part when the view has scrolled the corner out of sight
  const body = await until(async () => {
    const shape = await shapeBox(page, slide, BODY);
    const m = page.locator(`[data-testid="marker"][data-comment-id="${id}"]`);
    if (!shape || !(await m.count())) return null;
    const mk = await m.boundingBox();
    const c = mk && { x: mk.x + mk.width / 2, y: mk.y + mk.height / 2 };
    return c && Math.abs(c.x - shape.x) < 20 && c.y >= shape.y - 20 && c.y <= shape.y + shape.h ? shape : null;
  }, "the marker of the shape comment on the commented shape");
  const chg = await until(async () => {
    const n = await page.locator('[data-testid="changed-region"]').count();
    return n ? page.locator('[data-testid="changed-region"]').evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, kind: e.dataset.kind }; })) : null;
  }, "changed regions");
  assert.ok(chg.some((r) => r.kind === "changed" && overlaps(r, body)), "the shape the agent changed is outlined as changed");
  // the changed / new tags are fully inside the document area, big enough to read, and drawn above the comment outlines
  const tags = await page.locator('[data-testid="changed-tag"]').evaluateAll((els) => {
    const box = document.querySelector('[data-testid="overlay"]').getBoundingClientRect();
    return els.map((e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return { kind: e.dataset.kind, w: r.width, h: r.height, inside: r.left >= box.left && r.top >= box.top && r.right <= box.right && r.bottom <= box.bottom, font: parseFloat(cs.fontSize), order: [...e.closest('[data-testid="overlay"]').children].indexOf(e.parentElement) , lastHl: Math.max(...[...document.querySelectorAll('[data-testid="highlight"]')].map((h) => [...h.parentElement.children].indexOf(h))) }; });
  });
  assert.ok(tags.length >= 1, "at least one changed or new tag");
  for (const t of tags) {
    assert.ok(t.inside, `a ${t.kind} tag is fully inside the document area ${JSON.stringify(t)}`);
    assert.ok(t.w >= 36 && t.h >= 16 && t.font >= 11, `a ${t.kind} tag is legible ${JSON.stringify(t)}`);
    assert.ok(t.order > t.lastHl, "tags are drawn after the comment outlines");
  }
  const card = page.locator('[data-testid="comment-card"][data-kind="text"]');
  assert.ok((await card.locator('[data-testid="card-preview"]').textContent()).trim().length > 0);
  assert.match(await card.locator('[data-testid="card-scope"]').textContent(), /words/);
  const badge = await page.locator(`[data-testid="thumb-badge"][data-slide="${slide}"]`).textContent();
  assert.equal(badge.trim(), "4", "the thumbnail of the commented slide still carries its count (the slide moved)");
  assert.equal(await page.locator('[data-testid="change-item"]').count(), 0, "the user's edits were sent: Changes is empty");
}

describe("PPTX loop, agent uses `onionskin apply`", () => {
  let w, br, page, file, batch;
  before(async () => {
    w = makeWorld({ ONIONSKIN_NO_SOFFICE: "1" });
    br = await launch();
    file = w.doc("deck.pptx");
  });
  after(async () => {
    await br?.close();
    await w?.cleanup();
  });

  test("edit, selection comment, shape, slide, pins, badges, cross-slide jump, Send: the batch separates instructions from evidence", async () => {
    ({ page, batch } = await draftAndSend(w, br, file));
    checkBatch(batch);
    assert.match(await shapeText(file, "257", BODY), /TYPED$/, "the file on disk contains the user's direct edit");
    await page.locator('[data-testid="banner-working"]').waitFor();
  });

  test("the agent builds ops from the batch (anchor ids, locator.text_hash), applies them through the session; done", async () => {
    const { text, note, cs } = checkBatch(batch);
    const word = text.quote; // "March"
    const ops = {
      schema: "onionskin.ops/1",
      ops: [
        { op: "replace_text_in_shape", id: cs.find((c) => c.kind === "text").id, target: { anchor_id: text.id }, expect: { text_hash: text.locator.text_hash }, find: word, replace: "REPLACED" },
        { op: "replace_text_in_shape", id: cs.find((c) => c.text.startsWith("Who owns")).id, target: { anchor_id: note.id }, expect: { text_hash: note.locator.text_hash }, find: "Product team", replace: "Platform team" },
      ],
    };
    const batchFile = w.doc("batch.json");
    const opsFile = w.doc("ops.json");
    fs.writeFileSync(batchFile, JSON.stringify(batch));
    fs.writeFileSync(opsFile, JSON.stringify(ops));
    const r = await w.cli(["apply", file, "--ops", opsFile]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).results.map((x) => x.status), ["applied", "applied"]);
    assert.match(await shapeText(file, "259", BODY), /REPLACED/);
    assert.equal(await shapeText(file, "259", NOTE), "Owner: Platform team");
    assert.match(await shapeText(file, "257", BODY), /TYPED$/, "the user's edit survived");
    const results = w.doc("results.json");
    fs.writeFileSync(results, JSON.stringify({ summary: "Changed the date word and the owner note.", results: cs.map((c) => ({ comment_id: c.id, status: "done", note: "ok" })) }));
    const done = await w.cli(["done", file, "--results", results]);
    assert.equal(done.code, 0, done.stderr);
    assert.deepEqual(JSON.parse(done.stdout).flags.filter((f) => f.severity === "error"), []);
  });

  test("after done: same slide in view, shape marker, cards, badges, changed regions, activity", async () => {
    await checkLanded(page, { slide: 4, last: 6 });
    assert.equal(await page.locator('[data-testid="comment-card"][data-status="done"]').count(), 5);
    // one stack on this format too: the cards, then the run that answered them as the newest thing
    const stack = await page.evaluate(() => [...document.querySelectorAll('[data-testid="panel-stack"] > li')].map((li) => li.dataset.testid));
    assert.equal(stack.filter((t) => t === "comment-card").length, 5, `every card is in the stack (${stack})`);
    assert.equal(stack.at(-1), "activity-entry", `the run is the newest thing in the stack (${stack})`);
    assert.ok(stack.indexOf("activity-entry") > stack.lastIndexOf("comment-card"), "the run sits under the cards it answered");
    assert.match(await page.locator('[data-testid="check-notice"]').first().textContent(), /Deeper check/);
    assert.equal(await page.locator('[data-testid="activity-flags"] li[data-severity="error"]').count(), 0);
  });

  test("zero CSP violations and zero page errors", async () => {
    assert.deepEqual(cspViolations(br.log), []);
    assert.deepEqual(br.log.errors, []);
    assert.deepEqual(br.log.console.filter((m) => m.type === "error"), []);
  });
});

describe("PPTX loop, agent edits with python-pptx directly", () => {
  let w, br, page, file, batch;
  before(async () => {
    w = makeWorld({ ONIONSKIN_NO_SOFFICE: "1" });
    br = await launch();
    file = w.doc("deck.pptx");
  });
  after(async () => {
    await br?.close();
    await w?.cleanup();
  });

  test("Send", async () => {
    ({ page, batch } = await draftAndSend(w, br, file));
    checkBatch(batch);
    assert.match(await shapeText(file, "257", BODY), /TYPED$/);
  });

  test("python-pptx inserts a slide before the commented one and changes the commented shape's text; the page lands on the same slide", async () => {
    agentEdit([file, "pptx-insert-slide-before", "3", "Inserted slide"]);
    agentEdit([file, "pptx-set-text", "4", "Content Placeholder", "Ship the release in April and gather user input"]); // slide 4 is the inserted one's neighbor: index 4 is the old slide 4
    assert.match(await shapeText(file, "257", BODY), /TYPED$/, "the user's direct edit is still in the file");
    const results = w.doc("results.json");
    fs.writeFileSync(results, JSON.stringify({ summary: "Inserted a slide and changed the date.", results: batch.instructions.comments.map((c) => ({ comment_id: c.id, status: "done", note: "ok" })) }));
    const done = await w.cli(["done", file, "--results", results]);
    assert.equal(done.code, 0, done.stderr);
    await checkLanded(page, { slide: 5, last: 7 });
    const textCard = page.locator('[data-testid="comment-card"][data-kind="text"]');
    assert.equal(await textCard.getAttribute("data-resolved-method"), "id");
    assert.match(await textCard.locator(".locate").textContent(), /^\s*Slide 5, shape/);
    assert.equal(await page.locator('[data-testid="comment-card"][data-status="done"]').count(), 5);
  });

  test("zero CSP violations and zero page errors", async () => {
    assert.deepEqual(cspViolations(br.log), []);
    assert.deepEqual(br.log.errors, []);
    assert.deepEqual(br.log.console.filter((m) => m.type === "error"), []);
  });
});

describe("PPTX: the commented shape is deleted", () => {
  let w, br;
  before(async () => {
    w = makeWorld({ ONIONSKIN_NO_SOFFICE: "1" });
    br = await launch();
  });
  after(async () => {
    await br?.close();
    await w?.cleanup();
  });

  test("a deleted shape is moved or removed; a pin that sat on it stays on its slide; the other comments follow", async () => {
    const file = w.doc("deck.pptx");
    const poll = w.spawnCli(["poll", file]);
    const page = await br.page();
    await page.goto(await w.open(file));
    await waitDoc(page, ".de-slide");
    await page.locator('[data-testid="banner-listening"]').waitFor({ timeout: 20000 });
    await page.waitForTimeout(1200);
    await gotoSlide(page, 4);
    await commentOnShape(page, 4, NOTE, "Who owns this?", [0.2, 0.5]);
    await commentOnShape(page, 4, BODY, "Which month?");
    await page.locator('[data-testid="mode-pin"]').click();
    const nb = await shapeBox(page, 4, NOTE);
    await page.mouse.click(nb.x + nb.w * 0.8, nb.y + nb.h * 0.5);
    await page.locator('[data-testid="comment-card"][data-kind="pin"] textarea').fill("Pin on the note.");
    await page.locator('[data-testid="mode-edit"]').click();
    await page.locator('[data-testid="send"]').click();
    const batch = JSON.parse((await poll.done).stdout);
    agentEdit([file, "pptx-delete-shape", "3", "Side note"]);
    const results = w.doc("results.json");
    fs.writeFileSync(results, JSON.stringify({ summary: "Removed the side note.", results: batch.instructions.comments.map((c) => ({ comment_id: c.id, status: "done", note: "" })) }));
    assert.equal((await w.cli(["done", file, "--results", results])).code, 0);
    await page.locator('[data-testid="activity-entry"]').first().waitFor({ timeout: 25000 });
    const moved = page.locator('[data-testid="comment-card"][data-resolved="moved"]');
    await until(async () => (await moved.count()) === 1, "one moved card");
    assert.match(await moved.first().textContent(), /Who owns/);
    const pin = page.locator('[data-testid="comment-card"][data-kind="pin"]');
    assert.equal(await pin.getAttribute("data-resolved"), "ok", "the pin stays on its slide when the shape it sat on is gone");
    await until(async () => (await page.locator('[data-testid="pin-mark"]').count()) === 1, "the pin is still drawn");
    await until(async () => (await page.locator('[data-testid="marker"]').count()) === 1, "only the surviving shape comment has a marker");
    assert.deepEqual(cspViolations(br.log), []);
    assert.deepEqual(br.log.errors, []);
  });
});

describe("PPTX: the deck stays open while the agent works; what the user types is merged shape by shape", () => {
  let w, br, page, file;
  const q = (id) => `[data-testid="${id}"]`;
  before(async () => {
    w = makeWorld({ ONIONSKIN_NO_SOFFICE: "1" });
    br = await launch();
    file = w.doc("deck.pptx");
    page = await br.page();
    await page.goto(await w.open(file));
    await waitDoc(page, ".de-slide");
    await page.waitForTimeout(1200);
  });
  after(async () => {
    await br?.close();
    await w?.cleanup();
  });
  const body = (slideId) => shapeText(file, slideId, BODY);
  /** Comment on the title of a slide, Send, and return the delivered batch: the agent now holds the file. */
  const deliver = async (slide) => {
    const poll = w.spawnCli(["poll", file]);
    await page.locator(q("banner-listening")).waitFor({ timeout: 20000 });
    await gotoSlide(page, slide);
    await commentOnShape(page, slide, 2, "Please check this slide.");
    await page.locator(q("send")).click();
    const res = await Promise.race([poll.done, new Promise((r) => setTimeout(() => r(null), 20000))]);
    assert.ok(res, "poll did not return after Send");
    await page.locator(q("banner-working")).waitFor();
    return JSON.parse(res.stdout);
  };
  /** Type at the end of the body of a slide (after its last word); with `blur`, click below the shape so the editor reports the text. */
  const typeAtEnd = async (slide, lastWord, add, blur = true) => {
    await gotoSlide(page, slide);
    const at = await until(() => wordPoint(page, slide, BODY, lastWord, true), `"${lastWord}" on slide ${slide}`);
    await page.mouse.click(at.x, at.y);
    await page.mouse.click(at.x, at.y); // the second click puts the caret at the end of the text
    await page.keyboard.type(add);
    if (!blur) return;
    const b = await shapeBox(page, slide, BODY);
    await page.mouse.click(b.x + b.w * 0.5, b.y + b.h + 40);
  };
  const finish = async (batch) => {
    const results = w.doc("results.json");
    fs.writeFileSync(results, JSON.stringify({ summary: "Updated.", results: batch.instructions.comments.map((c) => ({ comment_id: c.id, status: "done", note: "Done." })) }));
    const done = await w.cli(["done", file, "--results", results]);
    assert.equal(done.code, 0, done.stderr);
  };
  /** The page is quiet again: the run is over, the new file is up and nothing is waiting to be merged (the next test clicks into it). */
  const settled = async () => {
    await until(async () => (await page.locator(q("state-pill")).first().textContent()) === "Idle" && (await page.locator(".de-slide").count()) > 0 && /No unsent edits/.test(await page.locator(".topbar").textContent()), "the page to be idle with no unsent edits", 30000);
    await page.waitForTimeout(600);
  };

  test("the deck is not locked: text typed in one shape during the run is merged with the agent's change to another, in the page and on disk", async () => {
    const batch = await deliver(4);
    assert.match(await page.locator(q("banner-lock-line")).textContent(), /Keep editing/);
    assert.equal(await page.locator(q("editbar")).isHidden(), false, "the formatting bar stays");
    assert.equal(await page.locator(".locked-note").count(), 0, "no locked note");
    await typeAtEnd(2, "year", " TYPED-WHILE-WORKING");
    assert.equal(await page.locator(q("send")).isDisabled(), true, "an edit alone is nothing to queue");
    agentEdit([file, "pptx-set-text", "3", "Content Placeholder", "Ship the release in April"]);
    const answer = page.waitForResponse((r) => r.url().includes("/api/merge"));
    await finish(batch);
    const merged = await (await answer).json();
    assert.deepEqual({ merged: merged.merged, unplaced: merged.unplaced }, { merged: 1, unplaced: [] }, "the deck the page saved differs from the one it loaded in exactly the typed shape");
    await until(async () => /year TYPED-WHILE-WORKING$/.test(await body("257")), "the typed text to be on disk");
    assert.equal(await body("259"), "Ship the release in April", "the agent's change is on disk");
    await until(async () => (await page.locator(`.de-slide-frame[data-slide="2"] [data-sid="${BODY}"]`, { hasText: "TYPED-WHILE-WORKING" }).count()) > 0, "the typed text in the reloaded page");
    assert.equal(await page.locator(q("banner-held-back")).count(), 0, "nothing was held back");
    await settled();
  });

  test("the user and the agent change the same text box: the agent's text stays and the user's text is shown with a Copy button", async () => {
    const batch = await deliver(1);
    await typeAtEnd(3, "slightly", " MINE-TOO");
    agentEdit([file, "pptx-set-text", "2", "Content Placeholder", "Costs fell"]);
    await finish(batch);
    const held = page.locator(q("banner-held-back"));
    await held.waitFor({ timeout: 30000 });
    assert.match(await held.textContent(), /One edit you made while the agent worked is not in the document/);
    assert.match(await held.locator(q("held-item")).first().textContent(), /The agent changed "Content Placeholder 2" on slide 3 too[\s\S]*slightly MINE-TOO/);
    assert.equal(await body("258"), "Costs fell", "the agent's text box was not overwritten");
    await page.locator(q("held-dismiss")).click();
    await held.waitFor({ state: "detached" });
    await settled();
  });

  test("text typed a moment before the agent finishes (the editor has not reported it yet) is not lost", async () => {
    const batch = await deliver(1);
    agentEdit([file, "pptx-set-text", "0", "Content Placeholder", "Welcome"]);
    await typeAtEnd(5, "market", " LATE", false);
    await finish(batch);
    await until(async () => /market LATE$/.test(await body("260")), "the text that was being typed to be on disk");
    assert.equal(await body("256"), "Welcome");
    assert.equal(await page.locator(q("banner-held-back")).count(), 0);
    await settled();
  });

  test("the agent inserts a slide: text typed on another slide still lands on that slide, by its id", async () => {
    const batch = await deliver(1);
    await typeAtEnd(6, "Friday", " AT-NOON");
    agentEdit([file, "pptx-insert-slide-before", "1", "Inserted slide"]);
    await finish(batch);
    await until(async () => /Friday AT-NOON$/.test(await body("261")), "the typed text to be on disk");
    const deck = await deckOf(file);
    assert.equal(deck.slides.length, 7, "the agent's new slide is there");
    assert.equal(deck.slides[1].title, "Inserted slide");
    assert.equal(deck.slides.findIndex((s) => s.id === "261"), 6, "the slide the user typed on is one further down");
    assert.equal(await page.locator(q("banner-held-back")).count(), 0);
    await settled();
  });

  test("zero CSP violations and zero page errors", async () => {
    assert.deepEqual(cspViolations(br.log), []);
    assert.deepEqual(br.log.errors, []);
    assert.deepEqual(br.log.console.filter((m) => m.type === "error"), []);
  });
});
