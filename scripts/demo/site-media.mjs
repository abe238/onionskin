#!/usr/bin/env node
// Website media for Markdown and HTML, recorded from the REAL app with SYNTHETIC files.
//   node scripts/demo/site-media.mjs <outDir> [md-stills] [html-stills] [md-demo]      (no scene names: all three)
// Same rules as launch-media.mjs: a throwaway world (temp HOME, temp state folder, temp documents), the worktree's own CLI (never the installed
// one), Playwright page video and page screenshots only, headless Chrome, a stand-in agent that answers through the real `onionskin reply`.
// The Markdown reply is NOT written here: it is <outDir>/md-demo-reply.json, written by a real agent after reading <outDir>/md-demo-batch.json.
//   1. md-demo with no md-demo-reply.json: a rehearsal. It makes the same comment and typed edit, presses Send, saves the delivered batch as
//      md-demo-batch.json and stops (no video, nothing replied).
//   2. an agent reads that batch and writes md-demo-reply.json (the reply JSON for `onionskin reply`).
//   3. md-demo with the reply present: the recorded run, answering with exactly that reply; the stills reuse it too.
// The mp4 and the poster come from the webm (see MAKE below, run by this script when ffmpeg is on the PATH).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { boxOf, launchContext, makeWorld, repo } from "../../e2e/helpers/harness.mjs";

const OUT = path.resolve(process.argv[2] || path.join(repo, "docs", "media"));
const given = process.argv.slice(3);
const scenes = new Set(given.length ? given : ["md-stills", "html-stills", "md-demo"]);
fs.mkdirSync(OUT, { recursive: true });
const q = (id) => `[data-testid="${id}"]`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the fixtures (synthetic) -----------------------------------------------------------------------------------------------------------
const NOTES_MD = `# Harbor 2.4 release notes

Harbor is the scheduling tool the support team uses to plan shifts and hand off open tickets. This release focuses on speed and clearer handoffs.

## What is new

The shift planner now loads in under a second, even for teams with several hundred agents. Handoff notes can be pinned to a ticket, so the next person reads them before anything else.

We also rewrote the weekly summary email. It lists open tickets first and leaves out anything that was closed more than a week ago.

- Faster shift planner
- Pinned handoff notes
- A shorter weekly summary email
- CSV export from every report

## Rollout plan

The release goes to the pilot teams first. Everyone else gets it two weeks later, once the pilot feedback is in.

| Phase | Date | Owner |
| --- | --- | --- |
| Pilot | March 4 | Support |
| Everyone | March 18 | Platform |

A team can keep the old email with one setting:

\`\`\`
summary_email: classic
\`\`\`

Questions go to the #harbor-help channel.
`;

const PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Cedar Street Community Garden</title>
<style>
  body { font-family: Georgia, "Times New Roman", serif; background: #faf7f0; color: #2b2a26; margin: 0; }
  main { max-width: 640px; margin: 0 auto; padding: 56px 28px 72px; line-height: 1.65; }
  h1 { font-size: 2.2rem; line-height: 1.2; margin: 0 0 6px; color: #2f5233; }
  .tag { margin: 0 0 28px; color: #6b6658; font-style: italic; }
  p { font-size: 1.1rem; margin: 0 0 18px; }
  h2 { font-size: 1.3rem; margin: 34px 0 10px; color: #2f5233; }
  ul { margin: 0 0 18px; padding-left: 22px; font-size: 1.1rem; }
  li { margin: 4px 0; }
  .note { border-left: 4px solid #c9a227; background: #f3ecd2; padding: 10px 16px; margin-top: 28px; font-size: 1rem; }
</style>
</head>
<body>
<main>
  <h1>Cedar Street Community Garden</h1>
  <p class="tag">Grown by neighbors since 2016</p>
  <p>Our garden sits behind the library and is open to everyone on the block. Beds are shared, tools are free to borrow, and the compost bins are always welcome to your kitchen scraps.</p>
  <p>The spring planting day is the first Saturday of April. We start at nine, and by noon the new beds are usually planted and the coffee is gone.</p>
  <h2>What to bring</h2>
  <ul>
    <li>Gloves and a hat</li>
    <li>A water bottle</li>
    <li>Seeds or seedlings to share</li>
  </ul>
  <p class="note">Rain or shine: if the weather is bad, we move the planting day to the next Saturday.</p>
</main>
</body>
</html>
`;

// ---- a throwaway world ---------------------------------------------------------------------------------------------------------------------
function newWorld() {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sm-home-"));
  fs.mkdirSync(path.join(home, ".local", "bin"), { recursive: true });
  const w = makeWorld({ HOME: home, ONIONSKIN_NO_SOFFICE: "1" }, { fixtures: false });
  fs.writeFileSync(w.doc("notes.md"), NOTES_MD);
  fs.writeFileSync(w.doc("page.html"), PAGE_HTML);
  const clean = w.cleanup;
  w.cleanup = async () => (await clean(), fs.rmSync(home, { recursive: true, force: true }));
  return w;
}

/** A browser window (same as launch-media.mjs: light or dark, optional page video, optional cursor dot that follows the mouse). */
async function window_({ w = 1440, h = 900, theme = "light", video = null, cursor = false } = {}) {
  const profile = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sm-chrome-"));
  const ctx = await launchContext(profile, { viewport: { width: w, height: h }, deviceScaleFactor: 1, colorScheme: theme, acceptDownloads: true, ...(video ? { recordVideo: { dir: video, size: { width: w, height: h } } } : {}) });
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
    [theme, cursor],
  );
  return {
    ctx,
    async close() {
      await ctx.close();
      fs.rmSync(profile, { recursive: true, force: true });
    },
  };
}

async function open(win, world, file, ready) {
  const page = await win.ctx.newPage();
  page.createdAt = Date.now(); // the video starts here; the demo saves how long the page took to be ready, so the clip can start at the first action
  const errors = (page.errors = []);
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(await world.open(file));
  await page.waitForSelector(ready, { timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('[data-testid="state-pill"]'), null, { timeout: 30000 });
  await page.locator(q("banner-listening")).waitFor({ timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1200);
  return page;
}

// ---- human-paced input ---------------------------------------------------------------------------------------------------------------
async function moveTo(page, x, y, steps = 24) {
  await page.mouse.move(x, y, { steps });
}
async function clickAt(page, x, y) {
  await moveTo(page, x, y);
  await page.waitForTimeout(140);
  await page.mouse.click(x, y);
}
async function clickOn(page, loc) {
  const b = await boxOf(loc);
  await clickAt(page, b.x + b.width / 2, b.y + b.height / 2);
}
/** One key at a time, 60 to 90 ms apart (a fixed sequence, so every run types the same way). */
async function typeHuman(page, text) {
  let s = 7;
  for (const ch of text) {
    await page.keyboard.type(ch);
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    await page.waitForTimeout(60 + (s % 31));
  }
}

/** Viewport points of the first and last character of the `nth` copy of `needle` in the Markdown preview's text runs. */
async function mdChars(page, needle, nth = 0) {
  const r = await page.evaluate(
    ([needle, nth]) => {
      let seen = 0;
      for (const el of document.querySelectorAll('[data-testid="md-preview"] [data-r]')) {
        const t = el.firstChild;
        if (!t) continue;
        for (let i = t.data.indexOf(needle); i >= 0; i = t.data.indexOf(needle, i + 1)) {
          if (seen++ !== nth) continue;
          el.scrollIntoView({ block: "center" });
          const at = (k) => {
            const rg = document.createRange();
            rg.setStart(t, k);
            rg.setEnd(t, k + 1);
            const b = rg.getBoundingClientRect();
            return { left: b.left, right: b.right, y: b.top + b.height / 2 };
          };
          return { first: at(i), last: at(i + needle.length - 1) };
        }
      }
      return null;
    },
    [needle, nth],
  );
  if (!r) throw new Error(`not in the preview: ${needle}`);
  return r;
}
/** A real mouse drag across `needle` in the preview, then the Comment chip, then the request typed in the card. Returns the card. */
async function mdComment(page, needle, words, { human = true } = {}) {
  const b = await mdChars(page, needle);
  await moveTo(page, b.first.left + 1, b.first.y);
  await page.waitForTimeout(150);
  await page.mouse.down();
  await page.mouse.move((b.first.left + b.last.right) / 2, b.last.y, { steps: 16 });
  await page.mouse.move(b.last.right - 1, b.last.y, { steps: 16 });
  await page.mouse.up();
  const chip = page.locator(q("comment-chip"));
  await chip.waitFor({ timeout: 5000 });
  await page.waitForTimeout(human ? 500 : 150);
  await clickOn(page, chip);
  const card = page.locator(q("comment-card")).last();
  await card.waitFor();
  await page.waitForTimeout(human ? 300 : 100);
  if (human) await typeHuman(page, words);
  else await card.locator("textarea").fill(words);
  await page.waitForTimeout(human ? 400 : 200);
  return card;
}
/** A click at the end of the paragraph that holds `needle`, then the sentence typed: the page swaps to Edit by itself. */
async function mdTypeAtEnd(page, needle, sentence, { human = true } = {}) {
  const b = await mdChars(page, needle);
  const pb = await page.evaluate((needle) => {
    for (const el of document.querySelectorAll('[data-testid="md-preview"] p[data-b]')) {
      if (!el.textContent.includes(needle)) continue;
      const r = el.getBoundingClientRect();
      return { right: r.right, bottom: r.bottom, top: r.top, left: r.left };
    }
    return null;
  }, needle);
  if (!pb) throw new Error("paragraph not found: " + needle);
  // the end of the paragraph's last line: a click just past the last character puts the caret there
  const end = await page.evaluate((needle) => {
    for (const el of document.querySelectorAll('[data-testid="md-preview"] p[data-b]')) {
      if (!el.textContent.includes(needle)) continue;
      const runs = [...el.querySelectorAll("[data-r]")];
      const t = runs[runs.length - 1].firstChild;
      const rg = document.createRange();
      rg.setStart(t, t.data.length - 1);
      rg.setEnd(t, t.data.length);
      const b = rg.getBoundingClientRect();
      return { x: b.right, y: b.top + b.height / 2 };
    }
  }, needle);
  void b;
  await clickAt(page, end.x + 2, end.y);
  await page.waitForTimeout(human ? 350 : 100);
  if (human) await typeHuman(page, sentence);
  else await page.keyboard.type(sentence);
  await page.locator(q("md-source")).waitFor();
}

// ---- the stand-in agent: answers with a reply written by a real agent --------------------------------------------------------------------------
/** Waits for Send, then (after `delay` ms) answers the batch through the real `onionskin reply`. `reply(batch)` returns the reply JSON. */
function standIn(w, file, reply, { delay = 1500 } = {}) {
  const poll = w.spawnCli(["poll", file]);
  const finished = poll.done.then(async (res) => {
    if (res.code !== 0) throw new Error("stand-in poll failed: " + res.stderr);
    const batch = JSON.parse(res.stdout);
    await sleep(delay);
    const run = w.spawnCli(["reply", file, "--lease", batch.lease_ticket, "--then-poll", "--timeout", "120", "--json", JSON.stringify(reply(batch))]);
    return { batch, run };
  });
  finished.catch(() => {});
  return { poll, finished };
}

const REPLY_FILE = path.join(OUT, "md-demo-reply.json");
const BATCH_FILE = path.join(OUT, "md-demo-batch.json");
// the commented words are on ONE line at the start of their paragraph: the product's "changed" tag sits above the start of the words, so it falls in
// the gap between two paragraphs (on a later line it sits over the line above), and the changed mark outlines the first line of a range only
const COMMENT_ON = "We also rewrote the weekly summary email";
const COMMENT_TEXT = "Make this friendlier";
const TYPED_IN = "This release focuses on speed and clearer handoffs.";
const TYPED = " Thanks to everyone who tested the beta.";
/** The reply written by the agent, with the comment id of THIS run (ids are not promised to repeat) put in place of the one in the file. */
function mdReply(batch) {
  const r = JSON.parse(fs.readFileSync(REPLY_FILE, "utf8"));
  const ids = batch.instructions.comments.map((c) => c.id);
  if (ids.length !== 1) throw new Error("the demo batch should hold one comment, it holds " + ids.length);
  for (const x of r.replies || []) if (x.comment !== undefined) x.comment = ids[0];
  return r;
}

const paraLoc = (page, text) => page.locator(`${q("md-preview")} p[data-b]`, { hasText: text }).first();

// ---- the Markdown story up to Send (shared by the rehearsal, the video and the stills) -----------------------------------------------------------
async function mdDraft(page, { human }) {
  await mdTypeAtEnd(page, TYPED_IN, TYPED, { human });
  await toPreview(page);
  return mdComment(page, COMMENT_ON, COMMENT_TEXT, { human });
}
const toPreview = async (page) => {
  await page.keyboard.press("Escape");
  await page.locator(`${q("md-host")}[data-view="preview"]`).waitFor();
};

const parkPointer = (page) => page.mouse.move(1580, 960);

// ---- scenes --------------------------------------------------------------------------------------------------------------------------------
const MAKE = (webm, lead, mp4) => ["-y", "-loglevel", "error", "-ss", String(Math.max(0, lead - 0.5)), "-i", webm, "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "24", "-r", "25", "-movflags", "+faststart", mp4];

async function mdDemo() {
  const rehearsal = !fs.existsSync(REPLY_FILE);
  const vdir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sm-video-"));
  const w = newWorld();
  try {
    const win = await window_({ w: 1440, h: 900, video: rehearsal ? null : vdir, cursor: true });
    const file = fs.realpathSync(w.doc("notes.md"));
    const before = fs.readFileSync(file, "utf8");
    const sa = rehearsal ? { finished: null } : standIn(w, file, mdReply, { delay: 1500 });
    const poll = rehearsal ? w.spawnCli(["poll", file]) : null;
    const page = await open(win, w, file, q("md-preview"));
    const t0 = Date.now();
    const mark = (n) => console.log(`t=${((Date.now() - t0) / 1000).toFixed(1)}s ${n}`);
    const snap = (n) => (rehearsal ? null : page.screenshot({ path: path.join(OUT, `_md-demo-${n}.png`) }));
    if (!rehearsal) fs.writeFileSync(path.join(OUT, "demo-md.lead"), String((t0 - page.createdAt) / 1000));
    // 1. the file open in Preview
    await page.waitForTimeout(2000);
    mark("open");
    await snap("1preview");
    // 2. a click at the end of a paragraph and a typed sentence: the page swaps to Edit by itself
    // (the typing comes BEFORE the comment on purpose: a comment made before an edit loses its place, the card says "Select again" and the agent
    // may only decline it. That is the product's rule, so the story follows it: type, back to Preview, then comment on the draft.)
    await mdTypeAtEnd(page, TYPED_IN, TYPED);
    await page.waitForTimeout(1800);
    mark("typed in Edit");
    await snap("2edit");
    // 3. Esc: back in Preview, the sentence rendered
    await toPreview(page);
    await page.waitForTimeout(2000);
    mark("preview again");
    await snap("3preview");
    // 4. a comment on a phrase of the draft
    await mdComment(page, COMMENT_ON, COMMENT_TEXT);
    await page.waitForTimeout(1800);
    mark("commented");
    await snap("4comment");
    // 5. Send
    await clickOn(page, page.locator(q("send")));
    mark("send");
    if (rehearsal) {
      const res = await poll.done;
      if (res.code !== 0) throw new Error("poll failed: " + res.stderr);
      fs.writeFileSync(BATCH_FILE, JSON.stringify(JSON.parse(res.stdout), null, 2) + "\n");
      console.log("rehearsal: batch saved to", BATCH_FILE, "(no reply sent; write md-demo-reply.json)");
      await win.close();
      return;
    }
    const { run } = await sa.finished;
    mark("agent replied");
    await page.waitForTimeout(900);
    await snap("5replied");
    // 6. the changed words, Done, the Agent finished card
    await page.locator(q("changed-tag")).first().waitFor({ timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2600);
    mark("changes shown");
    await snap("6changes");
    // 7. History: before and after
    await page.locator(q("panel-history")).scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    const col = page.locator(q("history-collapse"));
    if (await col.count()) await clickOn(page, col);
    await page.waitForTimeout(500);
    await clickOn(page, page.locator(q("history-row")).first());
    await page.locator(q("history-diff")).first().waitFor({ timeout: 10000 });
    await page.waitForTimeout(2600);
    mark("history");
    await snap("7history");
    run.child.kill("SIGKILL");
    const vp = await page.video().path();
    if (page.errors.length) console.log("PAGE ERRORS", JSON.stringify(page.errors));
    await win.close();
    const after = fs.readFileSync(file, "utf8");
    fs.writeFileSync(path.join(OUT, "_md-demo-final.md"), after);
    void before;
    fs.copyFileSync(vp, path.join(OUT, "demo-md.webm"));
    const lead = Number(fs.readFileSync(path.join(OUT, "demo-md.lead"), "utf8"));
    execFileSync("ffmpeg", MAKE(path.join(OUT, "demo-md.webm"), lead, path.join(OUT, "demo-md.mp4")));
  } finally {
    await w.cleanup();
    fs.rmSync(vdir, { recursive: true, force: true });
  }
}

async function mdStills() {
  if (!fs.existsSync(REPLY_FILE)) throw new Error("md-stills needs md-demo-reply.json: run the md-demo rehearsal first");
  for (const theme of ["light", "dark"]) {
    // after the reply: Preview, one comment Done, the changed mark, the Agent finished card
    {
      const win = await window_({ w: 1600, h: 1000, theme });
      const w = newWorld();
      try {
        const file = fs.realpathSync(w.doc("notes.md"));
        const sa = standIn(w, file, mdReply, { delay: 600 });
        const page = await open(win, w, file, q("md-preview"));
        await mdDraft(page, { human: false });
        await clickOn(page, page.locator(q("send")));
        const { run } = await sa.finished;
        await page.locator(q("changed-tag")).first().waitFor({ timeout: 20000 });
        await page.waitForTimeout(3000);
        await page.evaluate(() => document.activeElement?.blur?.());
        await parkPointer(page);
        await page.waitForTimeout(300);
        await page.screenshot({ path: path.join(OUT, `md-${theme}.png`) });
        console.log("  md-" + theme);
        run.child.kill("SIGKILL");
        fs.writeFileSync(path.join(OUT, `_md-${theme}-final.md`), fs.readFileSync(file, "utf8"));
      } finally {
        await win.close();
        await w.cleanup();
      }
    }
    // Edit with a typed sentence and one draft comment
    {
      const win = await window_({ w: 1600, h: 1000, theme });
      const w = newWorld();
      try {
        const file = fs.realpathSync(w.doc("notes.md"));
        const listen = w.spawnCli(["poll", file]); // an agent is listening, as in the other stills
        void listen;
        const page = await open(win, w, file, q("md-preview"));
        // Edit with the typed sentence and one draft comment: the comment is made on the file first (a draft on the file as it is), then the sentence
        // is typed. The card would say "Select again", so instead: type, Preview, comment, then back to Edit (the toggle) with the draft kept.
        await mdDraft(page, { human: false });
        await clickOn(page, page.locator(q("mode-edit")));
        await page.locator(`${q("md-host")}[data-view="edit"]`).waitFor();
        await page.waitForTimeout(600);
        await parkPointer(page);
        await page.waitForTimeout(300);
        await page.screenshot({ path: path.join(OUT, `md-edit-${theme}.png`) });
        console.log("  md-edit-" + theme);
      } finally {
        await win.close();
        await w.cleanup();
      }
    }
  }
}

const HTML_SEL = "the compost bins are always welcome to your kitchen scraps";
const HTML_FIND = "are always welcome to";
const HTML_REPLACE = "happily take";
const HTML_COMMENT = "Shorter, please";

async function htmlStills() {
  for (const theme of ["light", "dark"]) {
    const win = await window_({ w: 1600, h: 1000, theme });
    const w = newWorld();
    try {
      const file = fs.realpathSync(w.doc("page.html"));
      const sa = standIn(w, file, (b) => ({ summary: "Tightened the compost sentence.", replies: [{ comment: b.instructions.comments[0].id, find: HTML_FIND, replace: HTML_REPLACE, note: "Same meaning in fewer words." }] }), { delay: 600 });
      const page = await open(win, w, file, q("html-frame"));
      await page.waitForFunction(() => document.querySelector('[data-testid="html-viewer"]')?.dataset.phase === "ready", null, { timeout: 30000 });
      await clickOn(page, page.locator(q("mode-pin")));
      const got = page.locator(q("html-first-run-ok"));
      if (await got.count()) await clickOn(page, got); // the one-time "still view" notice, dismissed the way a person does
      await page.waitForTimeout(300);
      const frameEl = await page.$(q("html-frame"));
      const frame = await frameEl.contentFrame();
      // a pin on the paragraph (a place, not a quoted selection): the card keeps its place when the agent changes words inside it
      const r = await frame.evaluate((needle) => {
        const wk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let t = wk.nextNode(); t; t = wk.nextNode()) {
          if (!t.data.includes(needle)) continue;
          t.parentElement.scrollIntoView({ block: "center" });
          const b = t.parentElement.getBoundingClientRect();
          return { x: b.right - 60, y: b.bottom - 14 }; // empty space after the last line, so the pin covers no words
        }
        return null;
      }, HTML_SEL);
      if (!r) throw new Error("html phrase not found");
      const fb = await frameEl.boundingBox();
      await clickAt(page, fb.x + 1 + r.x, fb.y + 1 + r.y);
      const card = page.locator(q("comment-card")).last();
      await card.waitFor();
      await card.locator("textarea").fill(HTML_COMMENT);
      await clickOn(page, page.locator(q("mode-edit")));
      await page.waitForTimeout(500);
      await clickOn(page, page.locator(q("send")));
      const { run } = await sa.finished;
      await page.locator(q("changed-tag")).first().waitFor({ timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(3500);
      await page.evaluate(() => document.activeElement?.blur?.());
      await parkPointer(page);
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(OUT, `html-${theme}.png`) });
      console.log("  html-" + theme, "html changed:", fs.readFileSync(file, "utf8").includes(HTML_REPLACE));
      run.child.kill("SIGKILL");
    } finally {
      await win.close();
      await w.cleanup();
    }
  }
}

if (scenes.has("md-demo")) await mdDemo();
if (scenes.has("md-stills")) await mdStills();
if (scenes.has("html-stills")) await htmlStills();
