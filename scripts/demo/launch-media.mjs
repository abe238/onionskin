#!/usr/bin/env node
// Regenerates the launch media (docs/media/*.png, demo.gif and the clips) from the REAL app with SYNTHETIC documents.
//   node scripts/demo/launch-media.mjs <outDir> [scene ...]       scenes: stills, demo, excel, all (default all); LAUNCH_PART=a|b|c|p runs a third of the stills
// Everything runs in a throwaway world (temp HOME, temp state folder, temp documents) and is recorded through Playwright (page video and page
// screenshots), never from the screen. The agent is a scripted stand-in that answers batches through the real `onionskin reply` command with
// text written below; Quick fixes use the stand-in helper the browser tests use (ONIONSKIN_APPLE_HELPER_DIR), so no model runs.
// The demo and excel scenes write demo.webm / excel.webm plus a .lead file (seconds of idle video before the first action). Make the mp4 and gif with:
//   ss=$(cat demo.lead); ffmpeg -ss $(( ss - 0.5 )) -i demo.webm -c:v libx264 -pix_fmt yuv420p -crf 20 -r 25 -movflags +faststart demo.mp4
//   ffmpeg -i demo.mp4 -vf "fps=10,scale=1200:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" demo.gif
// (excel: -t 15, fps=12, scale=1000). Needs: the repo virtualenv (python-docx, openpyxl, python-pptx), Chrome, and `npm run build:web` done. ffmpeg turns the video into mp4 and gif.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { boxOf, fakeAppleHelper, launchContext, makeWorld, python, repo, scrollToPara, waitDoc, LINE_END, openSheet, xlsxCell, xlsxScrollTo, center, shapeBox, slideBox, gotoSlide, until } from "../../e2e/helpers/harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(process.argv[2] || path.join(repo, "docs", "media"));
const scenes = new Set(process.argv.slice(3).length ? process.argv.slice(3) : ["all"]);
const want = (s) => scenes.has("all") || scenes.has(s);
fs.mkdirSync(OUT, { recursive: true });
const q = (id) => `[data-testid="${id}"]`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the words ------------------------------------------------------------------------------------------------------------------------
const FIRST = "Revenue grew to $1.39 million in the third quarter, which was well above the plan that the leadership team approved in July after a long and careful review of the pipeline.";
const TYPO = "We expect to recieve the final signed contracts from both logistics partners by the end of November.";
const DELAYS = "Supplier delays in August pushed several orders into September.";
const DELAYS_ADD = " The delays added about $18,000 in rush shipping.";
const NEXT = "In the fourth quarter we will open the second warehouse";
const TYPED = " Target date: December 12.";

// ---- a throwaway world ----------------------------------------------------------------------------------------------------------------
async function newWorld(extra = {}) {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "lm-home-"));
  const w = makeWorld({ HOME: home, ONIONSKIN_NO_SOFFICE: "1", ONIONSKIN_PYTHON: python, ...extra });
  execFileSync(python, [path.join(here, "launch-fixtures.py"), w.docs]);
  const clean = w.cleanup;
  w.cleanup = async () => (await clean(), fs.rmSync(home, { recursive: true, force: true }));
  return w;
}

/** A browser window. `video` records the page; `cursor` draws a dot that follows the mouse and pulses on a click. */
async function window_({ w = 1440, h = 1000, dsf = 1, theme = "light", video = null, cursor = false } = {}) {
  const profile = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "lm-chrome-"));
  const ctx = await launchContext(profile, { viewport: { width: w, height: h }, deviceScaleFactor: dsf, colorScheme: theme, acceptDownloads: true, ...(video ? { recordVideo: { dir: video, size: { width: w, height: h } } } : {}) });
  await ctx.addInitScript(
    ([t, cur]) => {
      try {
        localStorage.setItem("onionskin.theme", t);
      } catch {}
      if (!cur) return;
      addEventListener("DOMContentLoaded", () => {
        const dot = document.createElement("div");
        dot.style.cssText = "position:fixed;left:-50px;top:-50px;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;background:rgba(255,80,60,.35);border:2px solid rgba(255,80,60,.95);box-shadow:0 0 0 1px rgba(255,255,255,.7);z-index:2147483647;pointer-events:none;transition:transform .12s,background .12s";
        document.documentElement.appendChild(dot);
        addEventListener("mousemove", (e) => ((dot.style.left = e.clientX + "px"), (dot.style.top = e.clientY + "px")), true);
        addEventListener("mousedown", () => ((dot.style.transform = "scale(.6)"), (dot.style.background = "rgba(255,80,60,.8)")), true);
        addEventListener("mouseup", () => ((dot.style.transform = "scale(1)"), (dot.style.background = "rgba(255,80,60,.35)")), true);
      });
    },
    [theme, cursor]
  );
  return {
    ctx,
    async close() {
      await ctx.close();
      fs.rmSync(profile, { recursive: true, force: true });
    },
  };
}

const open = async (win, world, file, probe) => {
  const page = await win.ctx.newPage();
  page.createdAt = Date.now(); // the video starts here; the scenes save how long the page took to be ready, so the clip can start at the first action
  await page.goto(await world.open(file));
  await waitDoc(page, probe);
  await page.locator(q("banner-listening")).waitFor({ timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1200);
  return page;
};

// ---- human-paced input -------------------------------------------------------------------------------------------------------------------
const mouse = { x: 700, y: 300 };
async function moveTo(page, x, y, steps = 22) {
  await page.mouse.move(x, y, { steps });
  mouse.x = x;
  mouse.y = y;
}
async function clickAt(page, x, y, o = {}) {
  await moveTo(page, x, y);
  await page.waitForTimeout(120);
  await page.mouse.click(x, y, o);
}
async function clickOn(page, loc) {
  const b = await boxOf(loc);
  await clickAt(page, b.x + b.width / 2, b.y + b.height / 2);
}
const typeSlow = (page, text, delay = 28) => page.keyboard.type(text, { delay });

/** Screen points at character offsets `a` (left edge) and `b` (right edge) of the paragraph that starts with `text`. */
async function charPoints(page, text, a, b) {
  const loc = page.locator(".de-p", { hasText: text.slice(0, 30) }).first();
  await loc.scrollIntoViewIfNeeded();
  return loc.evaluate((el, [a, b]) => {
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const nodes = [];
    for (let n = w.nextNode(); n; n = w.nextNode()) nodes.push(n);
    const at = (i, edge) => {
      let k = i;
      for (const n of nodes) {
        if (k <= n.length) {
          const r = document.createRange();
          r.setStart(n, Math.max(0, edge === "right" ? k - 1 : k));
          r.setEnd(n, Math.max(0, k) + (edge === "right" ? 0 : 1));
          const x = r.getBoundingClientRect();
          return { x: edge === "right" ? x.right : x.left, y: x.top + x.height / 2 };
        }
        k -= n.length;
      }
      return null;
    };
    return [at(a, "left"), at(b, "right")];
  }, [a, b]);
}
/** Drag across `sentence` inside its paragraph (a real mouse drag), then wait for the chip. */
async function selectSentence(page, paraStart, sentence) {
  const full = await page.locator(".de-p", { hasText: paraStart.slice(0, 30) }).first().textContent();
  const from = full.indexOf(sentence);
  if (from < 0) throw new Error("sentence not found: " + sentence.slice(0, 30));
  const [p0, p1] = await charPoints(page, paraStart, from, from + sentence.length - 1);
  await moveTo(page, p0.x + 0.5, p0.y);
  await page.waitForTimeout(150);
  await page.mouse.down();
  await page.mouse.move((p0.x + p1.x) / 2, p1.y, { steps: 14 });
  await page.mouse.move(p1.x - 0.5, p1.y, { steps: 16 });
  await page.mouse.up();
  await page.locator(q("comment-chip")).waitFor({ timeout: 5000 });
}
/** Triple-click a paragraph that is one sentence. */
async function selectWhole(page, text) {
  const loc = page.locator(".de-p", { hasText: text.slice(0, 30) }).first();
  await loc.scrollIntoViewIfNeeded();
  const b = await boxOf(loc);
  await moveTo(page, b.x + 60, b.y + b.height / 2);
  await page.mouse.click(b.x + 60, b.y + b.height / 2, { clickCount: 3 });
  await page.locator(q("comment-chip")).waitFor({ timeout: 5000 });
}
const paraBox = async (page, text) => {
  const loc = page.locator(".de-p", { hasText: text.slice(0, 30) }).first();
  await loc.scrollIntoViewIfNeeded();
  return boxOf(loc);
};

// ---- the stand-in agent ----------------------------------------------------------------------------------------------------------------
/**
 * Waits for the person's Send, then answers the batch through the real `onionskin reply` after `delay` ms and keeps polling for the next one
 * (`reply --then-poll`), the way SKILL.md has a real agent do it. `answer(batch)` returns the reply JSON; it is plain text written in this file.
 */
function standIn(w, file, answer, { delay = 1500 } = {}) {
  const poll = w.spawnCli(["poll", file]);
  const finished = poll.done.then(async (res) => {
    if (res.code !== 0) throw new Error("stand-in poll failed: " + res.stderr);
    const batch = JSON.parse(res.stdout);
    await sleep(delay);
    const body = answer(batch);
    const run = w.spawnCli(["reply", file, "--lease", batch.lease_ticket, "--then-poll", "--timeout", "120", "--json", JSON.stringify(body)]);
    return { batch, run };
  });
  finished.catch(() => {}); // a poll that is cut off at cleanup is not an error
  return { poll, finished, batch: () => poll.done.then((r) => JSON.parse(r.stdout)) };
}

const byText = (batch, start) => batch.instructions.comments.find((c) => c.text.startsWith(start));

// ---- scene pieces: the draft the person makes in the first half of the story ------------------------------------------------------------------
async function comment(page) {
  await selectSentence(page, "Revenue grew to", FIRST);
  await page.waitForTimeout(300);
  await clickOn(page, page.locator(q("comment-chip")));
  const ta = page.locator(`${q("comment-card")} textarea`).last();
  await ta.waitFor();
  await page.waitForTimeout(300);
  await typeSlow(page, "Make this shorter.");
  await page.waitForTimeout(450);
}
async function pin(page) {
  await clickOn(page, page.locator(q("mode-pin")));
  const b = await paraBox(page, DELAYS);
  await clickAt(page, b.x + b.width - 70, b.y + b.height / 2);
  await page.locator(`${q("comment-card")}[data-kind="pin"] textarea`).last().waitFor();
  await page.waitForTimeout(300);
  await typeSlow(page, "Add what the delays cost.");
  await page.waitForTimeout(350);
  await clickOn(page, page.locator(q("mode-edit")));
}
async function typedEdit(page) {
  const b = await paraBox(page, NEXT);
  await clickAt(page, b.x + b.width - 30, b.y + b.height - 10);
  await page.keyboard.press(LINE_END);
  await page.waitForTimeout(150);
  await typeSlow(page, TYPED, 32);
  await page.waitForTimeout(500);
}

// the agent's answer to the draft above (docx)
function docxAnswer(batch) {
  const c = byText(batch, "Make this shorter");
  const p = batch.instructions.comments.find((x) => x.text.startsWith("Add what the delays cost"));
  return {
    summary: "Shortened the revenue sentence and added the cost of the supplier delays.",
    replies: [
      { comment: c.id, find: FIRST.slice(FIRST.indexOf(", which"), -1), replace: ", well above the plan", note: "Cut the second half and kept the $1.39 million." },
      { comment: p.id, ops: [{ op: "replace_text", id: p.id, target: { anchor_id: p.anchor_id }, expect: { text_hash: batch.untrusted_document_evidence.anchors.find((a) => a.id === p.anchor_id).locator.text_hash }, find: DELAYS, replace: DELAYS + DELAYS_ADD }], note: "Added one sentence with the rush shipping cost." },
    ],
  };
}

const world = await newWorld();
try {
  if (want("stills")) {
    const shot = async (page, name, wait = 500, top = false) => {
      await page.waitForTimeout(wait);
      await page.evaluate(() => document.activeElement?.blur?.());
      if (top) await page.evaluate(() => document.querySelectorAll('[data-testid="sidebar"] .scroll').forEach((e) => (e.scrollTop = 0)));
      await page.mouse.move(1400, 880); // park the pointer on empty space
      await page.waitForTimeout(150);
      await page.screenshot({ path: path.join(OUT, `${name}.png`) });
      console.log("  ", name);
    };
    const reviewAnswer = (batch) => {
      const u = (t) => batch.untrusted_document_evidence.units.find((x) => x.text.startsWith(t));
      return {
        suggest: [
          { unit: u("We expect to recieve").id, find: "recieve", replace: "receive", why: "Spelling" },
          { unit: u("Revenue grew to").id, note: "The $1.39 million here matches the 1,385 ($K) in the table, and so do the 57 new customers." },
          { unit: u("Supplier delays").id, note: "This does not say how many orders were delayed." },
        ],
      };
    };

    // LAUNCH_PART=a|b|c runs one third of the stills (each stays under about two minutes); unset runs all
    const part = (k) => !process.env.LAUNCH_PART || process.env.LAUNCH_PART === k;
    // ---- Word: the draft (hero, comment, pins) and the same draft in the dark theme
    if (part("a")) for (const theme of ["light", "dark"]) {
      const win = await window_({ dsf: 2, theme });
      const w = await newWorld();
      try {
        const file = w.doc("quarterly-update.docx");
        const sa = standIn(w, file, docxAnswer);
        const page = await open(win, w, file);
        await selectSentence(page, "Revenue grew to", FIRST);
        if (theme === "light") {
          await clickOn(page, page.locator(q("comment-chip")));
          await page.locator(`${q("comment-card")} textarea`).last().waitFor();
          await typeSlow(page, "Make this shorter.", 5);
          await shot(page, "comment-selection", 500, true);
        } else {
          await clickOn(page, page.locator(q("comment-chip")));
          await page.locator(`${q("comment-card")} textarea`).last().waitFor();
          await typeSlow(page, "Make this shorter.", 5);
        }
        await pin(page);
        await typedEdit(page);
        await page.locator(q("overall-note")).fill("Keep it plain and short.");
        await page.waitForTimeout(700);
        await shot(page, theme === "light" ? "hero" : "hero-dark", 500, true);
        if (theme === "light") {
          // the run, and History
          await clickOn(page, page.locator(q("send")));
          const { run } = await sa.finished;
          await page.waitForTimeout(5500);
          await page.locator(q("panel-history")).scrollIntoViewIfNeeded();
          await clickOn(page, page.locator(q("history-collapse")));
          await page.waitForTimeout(400);
          await clickOn(page, page.locator(q("history-row")).first());
          await page.locator(q("history-diff")).first().waitFor();
          await shot(page, "history-change-view", 900);
          run.child.kill("SIGKILL");
        }
      } finally {
        await win.close();
        await w.cleanup();
      }
    }

    // ---- Word: two pins
    if (part("b") || process.env.LAUNCH_PART === "p") {
      const win = await window_({ dsf: 2 });
      const w = await newWorld();
      try {
        const page = await open(win, w, w.doc("quarterly-update.docx"));
        await pin(page);
        await clickOn(page, page.locator(q("mode-pin")));
        const b = await paraBox(page, "Prepared by the Operations");
        await clickAt(page, b.x + b.width - 60, b.y + b.height / 2);
        await page.locator(`${q("comment-card")}[data-kind="pin"] textarea`).last().waitFor();
        await typeSlow(page, "Add the name of who signed this off.", 5);
        await clickOn(page, page.locator(q("mode-edit")));
        await shot(page, "pins", 600, true);
      } finally {
        await win.close();
        await w.cleanup();
      }
    }

    // ---- Word: the Quick fix card (stand-in Apple helper)
    if (part("b")) {
      const helper = fakeAppleHelper("fix");
      const w = await newWorld({ ONIONSKIN_REWRITER_STUB: "", ONIONSKIN_APPLE_HELPER_DIR: helper });
      const win = await window_({ dsf: 2 });
      try {
        fs.mkdirSync(w.state, { recursive: true, mode: 0o700 });
        const { sha256 } = JSON.parse(fs.readFileSync(path.join(helper, "onionskin-fm.json"), "utf8"));
        fs.writeFileSync(path.join(w.state, "rewriter.json"), JSON.stringify({ backend: "apple", model: "apple", sha256 }), { mode: 0o600 });
        const file = w.doc("quarterly-update.docx");
        const sa = standIn(w, file, docxAnswer);
        const page = await open(win, w, file);
        await selectWhole(page, TYPO);
        await clickOn(page, page.locator(q("quick-ask-chip")));
        await page.locator(q("quick-ask")).waitFor();
        await page.waitForTimeout(1100);
        await clickOn(page, page.locator(q("stamp"), { hasText: /^Fix grammar$/ }));
        await page.locator(`${q("suggestion")}[data-state="shown"]`).waitFor({ timeout: 10000 });
        await shot(page, "quick-fix-card", 900);
      } finally {
        await win.close();
        await w.cleanup();
        fs.rmSync(helper, { recursive: true, force: true });
      }
    }

    // ---- Word: the agent's question, and Review first
    if (part("b")) {
      const win = await window_({ dsf: 2 });
      const w = await newWorld();
      try {
        const file = w.doc("quarterly-update.docx");
        const sa = standIn(w, file, (b) => ({ replies: [{ comment: b.instructions.comments[0].id, ask: "Which of the three should get a date?", options: ["All three", "The warehouse only"] }] }), { delay: 600 });
        const page = await open(win, w, file);
        await selectSentence(page, NEXT, "In the fourth quarter we will open the second warehouse, hire two dispatchers, and finish the new ordering page.");
        await clickOn(page, page.locator(q("comment-chip")));
        await page.locator(`${q("comment-card")} textarea`).last().waitFor();
        await typeSlow(page, "Make this more specific.", 5);
        await clickOn(page, page.locator(q("send")));
        const { run } = await sa.finished;
        await page.locator(`${q("comment-card")}[data-status="asked"]`).waitFor({ timeout: 20000 });
        await shot(page, "agent-question", 900, true);
        run.child.kill("SIGKILL");
      } finally {
        await win.close();
        await w.cleanup();
      }
      const w2 = await newWorld();
      const win2 = await window_({ dsf: 2 });
      try {
        const file = w2.doc("quarterly-update.docx");
        const poll = w2.spawnCli(["poll", file]);
        const page = await open(win2, w2, file);
        await clickOn(page, page.locator(q("review-button"), { hasText: "Proofread" }));
        const res = await poll.done;
        const batch = JSON.parse(res.stdout);
        await sleep(900);
        const r = await w2.cli(["reply", file, "--lease", batch.lease_ticket, "--json", JSON.stringify(reviewAnswer(batch))]);
        if (r.code !== 0) throw new Error(r.stdout + r.stderr);
        await page.locator(q("suggestion")).nth(2).waitFor({ timeout: 20000 });
        await shot(page, "review-first-cards", 900, true);
      } finally {
        await win2.close();
        await w2.cleanup();
      }
    }

    // ---- Excel: a comment on a range
    if (part("c")) {
      const win = await window_({ dsf: 2 });
      const w = await newWorld();
      try {
        const file = w.doc("quarterly-numbers.xlsx");
        const page = await open(win, w, file, ".de-sheet");
        const e = await until(() => xlsxCell(page, "Standard crate", "F"), "row rendered");
        await page.mouse.click(e.x + 10, e.y + 200); // an empty cell, so the title cell is not outlined
        await clickOn(page, page.locator(q("mode-comment")));
        const a = await until(() => xlsxCell(page, "Standard crate", "C"), "row rendered");
        const z = await xlsxCell(page, "Strapping kit", "C");
        await page.mouse.move(a.x + 10, a.y + 5);
        await page.mouse.down();
        await page.mouse.move(z.x + 20, z.y + 5, { steps: 8 });
        await page.mouse.up();
        await page.locator(`${q("comment-card")} textarea`).last().fill("Raise these prices by 5 percent.");
        await clickOn(page, page.locator(q("mode-edit")));
        await shot(page, "excel-range-comment", 800);
      } finally {
        await win.close();
        await w.cleanup();
      }
    }

    // ---- PowerPoint: a comment on a shape
    if (part("c")) {
      const win = await window_({ dsf: 2 });
      const w = await newWorld();
      try {
        const file = w.doc("q3-review.pptx");
        const page = await open(win, w, file, ".de-slide");
        await gotoSlide(page, 2);
        await clickOn(page, page.locator(q("mode-comment")));
        await page.evaluate(() => document.querySelector('.de-slide-frame[data-slide="2"]').scrollIntoView({ block: "center" }));
        await page.waitForTimeout(500);
        const sids = await page.evaluate(() => [...document.querySelectorAll('.de-slide-frame[data-slide="2"] [data-sid]')].map((e) => [e.dataset.sid, e.textContent.slice(0, 30)]));
        console.log("   slide 2 shapes", JSON.stringify(sids));
        const body = sids.find((x) => x[1].startsWith("Revenue of"));
        const bx = await shapeBox(page, 2, body[0]);
        await clickAt(page, bx.x + bx.w * 0.4, bx.y + bx.h * 0.15);
        await page.locator(`${q("comment-card")} textarea`).last().fill("Cut this to three bullets.");
        await clickOn(page, page.locator(q("mode-edit")));
        await shot(page, "powerpoint-shape-comment", 800);
      } finally {
        await win.close();
        await w.cleanup();
      }
    }
  }

  if (want("excel")) {
    const vdir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "lm-video-"));
    const w3 = await newWorld();
    try {
      const win = await window_({ w: 1440, h: 900, video: vdir, cursor: true });
      const file = w3.doc("quarterly-numbers.xlsx");
      const sa = standIn(w3, file, (b) => ({
        summary: "Raised the five prices by 5 percent and rounded to cents.",
        replies: [{ comment: b.instructions.comments[0].id, set: [[25.2], [40.43], [9.71], [14.7], [32.55]], note: "Raised each price by 5 percent." }],
      }), { delay: 1300 });
      const page = await open(win, w3, file, ".de-sheet");
      const t0 = Date.now();
      const mark = (n) => console.log(`t=${((Date.now() - t0) / 1000).toFixed(1)}s ${n}`);
      fs.writeFileSync(path.join(OUT, "excel.lead"), String((t0 - page.createdAt) / 1000));
      await page.mouse.click(560, 420); // an empty cell
      await clickOn(page, page.locator(q("mode-comment")));
      const a = await until(() => xlsxCell(page, "Standard crate", "C"), "row rendered");
      const z = await xlsxCell(page, "Strapping kit", "C");
      await moveTo(page, a.x + 12, a.y + 6);
      await page.waitForTimeout(150);
      await page.mouse.down();
      await page.mouse.move(z.x + 20, (a.y + z.y) / 2, { steps: 12 });
      await page.mouse.move(z.x + 20, z.y + 6, { steps: 12 });
      await page.mouse.up();
      await page.locator(`${q("comment-card")} textarea`).last().waitFor();
      await typeSlow(page, "Raise these prices by 5 percent.", 28);
      await page.waitForTimeout(500);
      mark("commented");
      await clickOn(page, page.locator(q("send")));
      const { run } = await sa.finished;
      mark("agent replied");
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(OUT, "_excel-1.png") });
      await page.waitForTimeout(3800);
      mark("values changed");
      await page.screenshot({ path: path.join(OUT, "_excel-2.png") });
      await page.waitForTimeout(5000);
      await page.screenshot({ path: path.join(OUT, "_excel-3.png") });
      run.child.kill("SIGKILL");
      const vp = await page.video().path();
      await win.close();
      fs.copyFileSync(vp, path.join(OUT, "excel.webm"));
    } finally {
      await w3.cleanup();
      fs.rmSync(vdir, { recursive: true, force: true });
    }
  }

  if (want("demo")) {
    const vdir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "lm-video-"));
    const helper = fakeAppleHelper("fix");
    const w2 = await newWorld({ ONIONSKIN_REWRITER_STUB: "", ONIONSKIN_APPLE_HELPER_DIR: helper });
    try {
      fs.mkdirSync(w2.state, { recursive: true, mode: 0o700 });
      const { sha256 } = JSON.parse(fs.readFileSync(path.join(helper, "onionskin-fm.json"), "utf8"));
      fs.writeFileSync(path.join(w2.state, "rewriter.json"), JSON.stringify({ backend: "apple", model: "apple", sha256 }), { mode: 0o600 });
      const win = await window_({ w: 1440, h: 900, video: vdir, cursor: true });
      const file = w2.doc("quarterly-update.docx");
      const sa = standIn(w2, file, docxAnswer, { delay: 1400 });
      const t0 = Date.now();
      const mark = (n) => console.log(`t=${((Date.now() - t0) / 1000).toFixed(1)}s ${n}`);
      const page = await open(win, w2, file);
      fs.writeFileSync(path.join(OUT, "demo.lead"), String((Date.now() - page.createdAt) / 1000));
      const snap = (n) => page.screenshot({ path: path.join(OUT, `_demo-${n}.png`) });
      mark("open");
      await comment(page); mark("comment"); await snap("1comment");
      await pin(page); mark("pin"); await snap("2pin");
      await typedEdit(page); mark("typed"); await snap("3typed");
      await clickOn(page, page.locator(q("send"))); mark("send");
      const { run } = await sa.finished; mark("agent replied");
      await page.waitForTimeout(900); await snap("4changes");
      await page.waitForTimeout(2200); mark("changes shown");
      // History: the newest update, the red and green words
      const hist = page.locator(q("panel-history"));
      await hist.scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      await clickOn(page, page.locator(q("history-collapse")));
      await page.waitForTimeout(500);
      await clickOn(page, page.locator(q("history-row")).first());
      await page.locator(q("history-diff")).first().waitFor({ timeout: 10000 });
      await page.waitForTimeout(2300); mark("history"); await snap("5history");
      // Quick fix
      await selectWhole(page, TYPO);
      await page.waitForTimeout(300);
      await clickOn(page, page.locator(q("quick-ask-chip")));
      await page.locator(q("quick-ask")).waitFor();
      await page.waitForTimeout(1000);
      await clickOn(page, page.locator(q("stamp"), { hasText: /^Fix grammar$/ }));
      await page.locator(`${q("suggestion")}[data-state="shown"]`).waitFor({ timeout: 10000 });
      await page.waitForTimeout(1900); mark("card"); await snap("6card");
      await clickOn(page, page.locator(q("suggestion-use")));
      await page.locator(".de-p", { hasText: "receive the final signed" }).first().waitFor({ timeout: 30000 });
      await page.waitForTimeout(2000); mark("used"); await snap("7used");
      run.child.kill("SIGKILL");
      const vp = await page.video().path();
      await win.close();
      fs.copyFileSync(vp, path.join(OUT, "demo.webm"));
    } finally {
      await w2.cleanup();
      fs.rmSync(helper, { recursive: true, force: true });
      fs.rmSync(vdir, { recursive: true, force: true });
    }
  }
} finally {
  await world.cleanup();
}
