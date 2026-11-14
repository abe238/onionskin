import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { after, before, describe, test } from "node:test";
import { cspViolations, launch, makeWorld, para, python, scrollToPara, until, waitDoc } from "./helpers/harness.mjs";
import { readDocxParagraphs } from "../src/docx.js";

// "Changes shown in place" (milestone 3, idea 6a) in a real browser. The refresh after an agent run still happens underneath; once the
// new document is up at the same place, the changed words are drawn over it (web/src/writein-live.js, gate in web/src/writein.js).
// The overlay root's data-writein says what the newest refresh did ("on", "done", or why it did not draw / stopped), so a test for
// "nothing drawn" also proves why, and never passes only because the feature is broken.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OV = '[data-testid="overlay"]';
const state = (page) => page.locator(OV).getAttribute("data-writein");
const scrollTop = (page) => page.evaluate(() => document.querySelector('[data-testid="docwrap"] .de-scroll').scrollTop);
const TERMINAL = new Set(["on", "done", "type", "edit", "scroll", "send", "reload", "hidden", "resize", "error", "not-located", "not-confirmed", "no-page", "late", "unavailable", "detail", "too-many", "no-places", "merged", "dirty", "inexact", "reduced-motion", "read-only", "format", "newest", "revert-recommended", "flags", "edited", "sending", "run-moved", "no-gates"]);

let br;
before(async () => {
  br = await launch();
});
after(async () => {
  await br?.close();
});

const refreshes = async (page) => Number((await page.locator(OV).getAttribute("data-writein-n")) || 0);
/**
 * Waits (in the page, every frame) until a refresh after the `n0`th settled on drawing or on a reason not to. Returns {state, snap}:
 * when the state is "on", snap is read in that same frame (the drawing lasts about two seconds, so nothing is read later by round
 * trips): the drawn items, the status line, today's outlines, the paragraph whose text includes `want`, and the scroller position.
 * With `scroll`, the scroller is then moved by 120 px in that same frame.
 */
async function settled(page, n0, { want = null, scroll = false } = {}) {
  const h = await page.waitForFunction(
    ([all, n, want, scroll]) => {
      const o = document.querySelector('[data-testid="overlay"]');
      const s = o?.dataset.writein;
      if (!(Number(o?.dataset.writeinN || 0) > n && s && all.includes(s))) return null;
      if (s !== "on") return { state: s, snap: null };
      const ob = o.getBoundingClientRect();
      const rel = (e) => {
        const r = e.getBoundingClientRect();
        return { x: r.left - ob.left, y: r.top - ob.top, w: r.width, h: r.height };
      };
      const all2 = (q) => [...document.querySelectorAll(q)];
      const sc = document.querySelector('[data-testid="docwrap"] .de-scroll');
      const p = want ? all2(".de-p[data-bi]").find((x) => x.textContent.includes(want)) : null;
      const layer = o.querySelector(".wi-layer");
      const snap = {
        ins: all2('[data-testid="writein-ins"]').map(rel),
        covers: all2('[data-testid="writein-cover"]').length,
        was: all2('[data-testid="writein-was"]').map((e) => ({ t: e.textContent, ...rel(e) })),
        status: document.querySelector('[data-testid="writein-status"]')?.textContent ?? null,
        outlines: all2('[data-testid="changed-region"]').map(rel),
        para: p ? rel(p) : null,
        paraText: p ? p.textContent : null,
        top: sc.scrollTop,
        imgs: o.querySelectorAll("img").length,
        layer: layer ? { hidden: layer.getAttribute("aria-hidden"), pe: getComputedStyle(layer).pointerEvents } : null,
      };
      if (scroll) sc.scrollTop += 120;
      return { state: s, snap };
    },
    [[...TERMINAL], n0, want, scroll],
    { timeout: 30000, polling: "raf" }
  );
  return h.jsonValue();
}

/**
 * Send what the page holds (a note, so there is always something to send), run `during` while the agent holds the batch, write
 * `edits` ([find, replace, paragraph prefix]) as the agent does, through `onionskin apply` (a direct save would be flagged as a change
 * from outside Onionskin, and such a run is never drawn in place), then `done`. Returns the body of the /api/send request and the
 * refresh count before the run (for settled).
 */
async function agentRun(w, page, file, edits, { during, summary = "Tidied the wording." } = {}) {
  const n0 = await refreshes(page);
  const poll = w.spawnCli(["poll", file]);
  await page.locator('[data-testid="banner-listening"]').waitFor({ timeout: 20000 });
  await page.locator('[data-testid="overall-note"]').fill("Please tidy this up.");
  await page.waitForTimeout(700);
  const sent = page.waitForRequest((r) => r.url().includes("/api/send") && r.method() === "POST");
  await page.locator('[data-testid="send"]').click();
  const body = JSON.parse((await sent).postData() || "{}");
  const res = await Promise.race([poll.done, sleep(20000).then(() => null)]);
  assert.ok(res && res.code === 0, res?.stderr);
  await page.locator('[data-testid="banner-working"]').waitFor();
  if (during) await during();
  const paras = readDocxParagraphs(fs.readFileSync(file));
  const ops = edits.map(([find, replace, prefix]) => {
    const t = paras.find((p) => p.text.startsWith(prefix) && p.text.includes(find));
    assert.ok(t, `a paragraph starting "${prefix}" with "${find}"`);
    return { op: "replace_text", target: { text_hash: t.hash, body_path: t.path }, expect: { text_hash: t.hash }, find, replace };
  });
  const opsFile = w.doc(`ops-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(opsFile, JSON.stringify({ schema: "onionskin.ops/1", ops }));
  const ap = await w.cli(["apply", file, "--ops", opsFile]);
  assert.equal(ap.code, 0, ap.stderr + ap.stdout);
  const rj = w.doc(`r-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(rj, JSON.stringify({ summary, results: [] }));
  const before = await page.locator('[data-testid="activity-entry"]').count();
  assert.equal((await w.cli(["done", file, "--results", rj])).code, 0);
  await until(async () => (await page.locator('[data-testid="activity-entry"]').count()) > before, "a new activity entry");
  return { body, n0 };
}

const inside = (a, b, tol = 3) => a.x >= b.x - tol && a.y >= b.y - tol && a.x + a.w <= b.x + b.w + tol && a.y + a.h <= b.y + b.h + tol;

describe("Changes shown in place (DOCX)", () => {
  let w, file, page;
  before(async () => {
    w = makeWorld({ ONIONSKIN_NO_SOFFICE: "1" });
    file = w.doc("long.docx");
    page = await br.page();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(await w.open(file));
    await waitDoc(page);
  });
  after(() => w?.cleanup());

  test("a replaced word in view: the new word is written in where it stands, the old one shows as Was:, the place stays put, nothing is typed into the page", async () => {
    await scrollToPara(page, "Paragraph 003:", 0);
    const { n0 } = await agentRun(w, page, file, [["short note", "brief note", "Paragraph 003:"]]);
    const { state: s, snap } = await settled(page, n0, { want: "Paragraph 003:" });
    assert.equal(s, "on", `drawn in place (got ${s})`);
    // the page shows the agent's version (the refresh happened); the old word is only in the chip, drawn over the page
    assert.match(snap.paraText, /brief note/);
    assert.doesNotMatch(snap.paraText, /short note/);
    assert.ok(snap.ins.length >= 1, "the new words are tinted");
    assert.ok(snap.covers >= 1, "a cover in the page's color wipes away over them");
    for (const b of snap.ins) assert.ok(inside(b, snap.para), `inside the paragraph ${JSON.stringify(b)} ${JSON.stringify(snap.para)}`);
    assert.equal(snap.was.length, 1);
    assert.equal(snap.was[0].t.trim(), "Was: short");
    assert.ok(snap.was[0].x >= snap.para.x - 3 && snap.was[0].x <= snap.para.x + snap.para.w, "the chip sits over the paragraph's columns");
    // decoration only: hidden from screen readers, never in the way of a click; the status line says it in words
    assert.deepEqual(snap.layer, { hidden: "true", pe: "none" });
    assert.equal(snap.status.trim(), "The agent's changes are in. 1 place changed.");
    assert.ok(!snap.outlines.some((b) => inside(b, snap.para, 6) && inside(snap.para, b, 6)), "no outline over the paragraph drawn in place");
    // it ends by itself, and the reader's place never moved
    await until(async () => (await state(page)) === "done", "the animation ended", 15000);
    assert.equal(await page.locator('[data-testid="writein-ins"], [data-testid="writein-was"], [data-testid="writein-cover"]').count(), 0, "nothing left drawn");
    assert.equal(await scrollTop(page), snap.top, "the scroller did not move");
  });

  test("the next Send carries no document bytes (nothing was typed into the engine), and typing stops the drawing at once", async () => {
    const p = para(page, "Paragraph 006:");
    const { body, n0 } = await agentRun(w, page, file, [["short note", "quick note", "Paragraph 004:"]], {
      // the caret goes in a paragraph while the agent works (no typing): the refresh puts it back, so one key press follows the drawing
      during: async () => {
        const b = await p.boundingBox();
        await page.mouse.click(b.x + 30, b.y + b.height / 2);
      },
    });
    assert.equal(body.bytesB64, undefined, "the Send after a drawn-in-place refresh carries no bytes");
    assert.equal((await settled(page, n0)).state, "on");
    await page.keyboard.type("x");
    await until(async () => ["type", "edit"].includes(await state(page)), "stopped by typing", 5000);
    assert.equal(await page.locator('[data-testid="writein-ins"], [data-testid="writein-was"], [data-testid="writein-cover"]').count(), 0);
  });

  test("a merge in this refresh (typed while the agent worked): nothing is drawn, the outline shows", async () => {
    // the typed "x" above went out with this Send; more is typed while the agent works, so the refresh merges
    const { n0 } = await agentRun(w, page, file, [["short note", "small note", "Paragraph 005:"]], {
      during: async () => {
        const p = para(page, "Paragraph 007:");
        const b = await p.boundingBox();
        await page.mouse.click(b.x + 30, b.y + b.height / 2);
        await page.keyboard.type("y");
        await page.waitForTimeout(300);
      },
    });
    assert.equal((await settled(page, n0)).state, "merged");
    assert.equal(await page.locator('[data-testid="writein-ins"]').count(), 0);
    await until(async () => (await page.locator('[data-testid="changed-region"]').count()) > 0, "today's outline");
  });

  test("scrolling stops the drawing at once", async () => {
    const { n0 } = await agentRun(w, page, file, [["short note", "fine note", "Paragraph 006:"]]);
    assert.equal((await settled(page, n0, { scroll: true })).state, "on");
    await until(async () => (await state(page)) === "scroll", "stopped by scrolling", 5000);
    assert.equal(await page.locator('[data-testid="writein-ins"], [data-testid="writein-was"]').count(), 0);
  });

  test("hostile old words: a tag in the replaced text shows as plain text in the chip, no image, no blocked script", async () => {
    // the reader is still near the top (the scroll above moved 120 px): Paragraph 003 is in view
    const first = await agentRun(w, page, file, [["brief note", "<img src=x onerror=alert(1)> note", "Paragraph 003:"]]);
    assert.equal((await settled(page, first.n0)).state, "on");
    await until(async () => ["done", "scroll", "type"].includes(await state(page)), "first run ended", 15000);
    const { n0 } = await agentRun(w, page, file, [["<img src=x onerror=alert(1)>", "plain", "Paragraph 003:"]]);
    const { state: s, snap } = await settled(page, n0, { want: "Paragraph 003:" });
    assert.equal(s, "on");
    assert.equal(snap.was.length, 1);
    assert.match(snap.was[0].t, /^Was: <img src=x onerror=alert\(1\)>/);
    assert.equal(snap.imgs, 0, "no image element in the overlay");
    assert.deepEqual(cspViolations(page.log), []);
    assert.deepEqual(page.log.errors, []);
  });

  test("a pure deletion: the old words show as Was: where they were", async () => {
    await until(async () => ["done", "scroll", "type"].includes(await state(page)), "the run before ended", 15000);
    const { n0 } = await agentRun(w, page, file, [["a short note", "a note", "Paragraph 002:"]]);
    const { state: s, snap } = await settled(page, n0, { want: "Paragraph 002:" });
    assert.equal(s, "on", `drawn in place (got ${s})`);
    assert.equal(snap.was.length, 1);
    assert.equal(snap.was[0].t.trim(), "Was: short");
    assert.equal(snap.ins.length, 0, "nothing new to tint");
  });

  test("reduced motion: the new words and the Was: chip show still (no cover, no animation), then go by themselves", async () => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    try {
      const { n0 } = await agentRun(w, page, file, [["short note", "plain note", "Paragraph 008:"]]);
      const { state: s, snap } = await settled(page, n0, { want: "Paragraph 008:" });
      assert.equal(s, "on", `drawn still (got ${s})`);
      assert.ok(snap.ins.length >= 1 && snap.was.length === 1, "tint and chip are shown");
      assert.equal(snap.covers, 0, "no wipe");
      assert.equal(await page.evaluate(() => document.querySelector(".wi-layer").getAnimations({ subtree: true }).length), 0, "nothing is animating");
      await until(async () => (await state(page)) === "done", "ended by itself", 15000);
      assert.equal(await page.locator(".wi-layer").count(), 0);
    } finally {
      await page.emulateMedia({ reducedMotion: "no-preference" });
    }
  });

  test("a Send stops the drawing at once", async () => {
    const { n0 } = await agentRun(w, page, file, [["short note", "neat note", "Paragraph 009:"]], {
      during: () => page.locator('[data-testid="overall-note"]').fill("One more thing."), // something to send right after
    });
    assert.equal((await settled(page, n0)).state, "on");
    await page.locator('[data-testid="send"]').click();
    await until(async () => (await state(page)) === "send", "stopped by the Send", 5000);
    assert.equal(await page.locator('[data-testid="writein-ins"], [data-testid="writein-was"]').count(), 0);
  });
});

describe("Changes shown in place: long paragraphs after page and section breaks", () => {
  let w, file, page;
  before(async () => {
    w = makeWorld({ ONIONSKIN_NO_SOFFICE: "1" });
    file = w.doc("breaks.docx");
    // the engine counts a page break and a section break as blocks of their own, so its paragraph numbers run ahead of the file's;
    // the paragraphs are longer than the 160 characters History keeps of their opening words
    execFileSync(python, ["-c", "import sys\nfrom docx import Document\nfrom docx.enum.section import WD_SECTION\nd = Document()\nd.add_paragraph('Title line.')\nd.add_page_break()\nd.add_section(WD_SECTION.CONTINUOUS)\nfor i in range(1, 9):\n    d.add_paragraph(f'Long paragraph {i}: ' + 'the regional office reviews the quarterly figures with the finance team and files a short note so that every lead can compare the results without waiting for the annual cycle.')\nd.save(sys.argv[1])", file]);
    page = await br.page();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(await w.open(file));
    await waitDoc(page);
  });
  after(() => w?.cleanup());

  test("a replaced word in a long paragraph after the breaks is drawn inside that paragraph", async () => {
    await scrollToPara(page, "Long paragraph 3:", 0.3);
    const { n0 } = await agentRun(w, page, file, [["short note", "brief note", "Long paragraph 3:"]]);
    const { state: s, snap } = await settled(page, n0, { want: "Long paragraph 3:" });
    assert.equal(s, "on", `drawn in place (got ${s})`);
    assert.ok(snap.ins.length >= 1);
    for (const b of snap.ins) assert.ok(inside(b, snap.para), "inside the changed paragraph");
    assert.equal(snap.was[0].t.trim(), "Was: short");
  });
});

describe("Changes shown in place: look-alike paragraphs", () => {
  let w, file, page;
  // paragraphs that share their first 160 characters (where a History place is found again by its opening words) and differ near the end
  const same = "This paragraph appears twice in the file on purpose, word for word, so that its opening words cannot tell the two apart when the page looks for the place again later on.";
  before(async () => {
    w = makeWorld({ ONIONSKIN_NO_SOFFICE: "1" });
    file = w.doc("twins.docx");
    execFileSync(python, ["-c", "import sys\nfrom docx import Document\nd = Document()\nd.add_paragraph('Intro line.')\nfor e in ('Ending one.', 'Ending one.', 'Ending two.'):\n    d.add_paragraph(sys.argv[2] + ' ' + e)\nd.add_paragraph('Last line.')\nd.save(sys.argv[1])", file, same]);
    page = await br.page();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(await w.open(file));
    await waitDoc(page);
  });
  after(() => w?.cleanup());

  test("one of two identical paragraphs changed: drawn only inside the one that changed (its new text is unique)", async () => {
    const { n0 } = await agentRun(w, page, file, [["Ending one.", "Ending three.", ""]]);
    const { state: s, snap } = await settled(page, n0, { want: "Ending three." });
    assert.equal(s, "on");
    assert.ok(snap.ins.length >= 1);
    for (const b of snap.ins) assert.ok(inside(b, snap.para), "inside the changed paragraph, not its twin");
    await until(async () => (await state(page)) === "done", "ended", 15000);
  });

  test("a change that makes two paragraphs identical: the place could be either, so nothing is drawn and the outline shows", async () => {
    const { n0 } = await agentRun(w, page, file, [["Ending two.", "Ending one.", ""]]);
    assert.equal((await settled(page, n0)).state, "not-located");
    assert.equal(await page.locator('[data-testid="writein-ins"]').count(), 0);
    await until(async () => (await page.locator('[data-testid="changed-region"]').count()) > 0, "today's outline");
  });
});
