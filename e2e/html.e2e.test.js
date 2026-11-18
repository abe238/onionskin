// HTML files end to end (PLAN-html Phase 2a), in a real browser against the real server and CLI, with the fake agent
// (e2e/helpers/fake-claude.mjs, mode "html") running the real `onionskin poll` and `onionskin reply`: open the sample, select a sentence in
// Comment mode and comment, Send, the agent's replace_text lands and nothing else in the file changes, the view reloads, History shows
// it, Revert restores the bytes; a typed fix (typed right after the click) goes out with Send; a reply that adds a script is refused
// with the fixed sentence. Temp state and documents only.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { cspViolations, launch, makeWorld, repo, until, waitDoc } from "./helpers/harness.mjs";
import { fakeClaudeDir } from "./helpers/fake-side.mjs";

const q = (id) => `[data-testid="${id}"]`;
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const SAMPLE_DIR = path.join(repo, "test", "fixtures", "sample");
const SAMPLE = fs.readFileSync(path.join(SAMPLE_DIR, "sample.html"));
const ACTIVE_REFUSED = "The agent tried to add code that runs in a browser, so nothing was written.";

let br;
before(async () => {
  br = await launch();
});
after(async () => {
  await br?.close();
});

/** A world with the sample page (and its image folder) at `name`. */
function world(name = "garden.html", bytes = SAMPLE) {
  const w = makeWorld({ ONIONSKIN_NO_SOFFICE: "1" });
  fs.mkdirSync(w.doc("images"), { recursive: true });
  fs.copyFileSync(path.join(SAMPLE_DIR, "images", "onion.png"), w.doc(path.join("images", "onion.png")));
  const file = w.doc(name);
  fs.writeFileSync(file, bytes);
  return { w, file: fs.realpathSync(file) };
}

/** The fake agent (fake-claude.mjs, mode "html") polling `file` with `want` ({find, replace} or {add}); ended by its pid at the end. */
function startAgent(w, file, want) {
  const dir = fakeClaudeDir(w.root);
  fs.writeFileSync(path.join(dir, "mode"), "html");
  fs.writeFileSync(path.join(dir, "html-op.json"), JSON.stringify(want));
  const c = spawn(process.execPath, [path.join(dir, "fake-claude.mjs"), "-p", `You are the agent for one document: \`${file}\`.`, "--session-id", "11111111-1111-4111-8111-111111111111"], {
    cwd: w.root,
    stdio: ["ignore", "pipe", "pipe"],
    env: { HOME: process.env.HOME, PATH: `${dir}:${path.dirname(process.execPath)}:/usr/bin:/bin`, ONIONSKIN_STATE_DIR: w.state, ONIONSKIN_AGENT_DIR: w.root, ONIONSKIN_TICK_MS: "150", ONIONSKIN_NO_SOFFICE: "1" },
  });
  let out = "";
  c.stdout.on("data", (d) => (out += d));
  c.stderr.on("data", (d) => (out += d));
  return { stop: () => c.exitCode === null && process.kill(c.pid, "SIGKILL"), out: () => out };
}

async function openPage(w, file) {
  const page = await br.page();
  await page.addInitScript(() => sessionStorage.setItem("onionskin.histCollapsed", "0")); // History starts folded; these tests read it open
  await page.goto(await w.open(file));
  await waitDoc(page, q("html-frame"));
  await page.waitForFunction(() => document.querySelector('[data-testid="html-viewer"]')?.dataset.phase === "ready", null, { timeout: 30000 });
  return page;
}

/** The page coordinates of `needle` in the frame: its start and end points (the middle of the first and last character's box). */
async function textBox(page, needle) {
  const frameEl = await page.$(q("html-frame"));
  const frame = await frameEl.contentFrame();
  const r = await frame.evaluate((needle) => {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let t = w.nextNode(); t; t = w.nextNode()) {
      const i = t.data.indexOf(needle);
      if (i < 0) continue;
      t.parentElement.scrollIntoView({ block: "center" });
      const at = (k) => {
        const rg = document.createRange();
        rg.setStart(t, k);
        rg.setEnd(t, k + 1);
        const b = rg.getBoundingClientRect();
        return { x: b.left + b.width / 2, y: b.top + b.height / 2, left: b.left, right: b.right };
      };
      return { first: at(i), last: at(i + needle.length - 1) };
    }
    return null;
  }, needle);
  assert.ok(r, `${needle} is in the view`);
  const fb = await frameEl.boundingBox();
  const off = (p) => ({ x: fb.x + 1 + p.x, y: fb.y + 1 + p.y, left: fb.x + 1 + p.left, right: fb.x + 1 + p.right });
  return { first: off(r.first), last: off(r.last) };
}
const frameText = async (page) => (await (await page.$(q("html-frame"))).contentFrame()).evaluate(() => document.body.textContent);

/** Comment mode: drag from the first to the last character of `needle`, then type `words` in the new comment. */
async function commentOn(page, needle, words) {
  await page.locator(q("mode-comment")).click();
  const b = await textBox(page, needle);
  await page.mouse.move(b.first.left + 1, b.first.y);
  await page.mouse.down();
  await page.mouse.move((b.first.left + b.last.right) / 2, b.last.y, { steps: 4 });
  await page.mouse.move(b.last.right - 1, b.last.y, { steps: 4 });
  await page.mouse.up();
  const card = page.locator(q("comment-card")).last();
  await card.waitFor();
  await card.locator("textarea").fill(words);
  await page.locator(q("mode-edit")).click();
  return card;
}

describe("HTML: the whole loop", () => {
  let w, file, page, agent;
  before(async () => {
    ({ w, file } = world());
    agent = startAgent(w, file, { find: "hardy crops", replace: "cold-hardy crops" });
    page = await openPage(w, file);
  });
  after(async () => {
    agent?.stop();
    await page?.close();
    await w?.cleanup();
  });

  test("the sample opens in the still view: its text, its image, the scripts-off line, no Review button, no network", async () => {
    const t = await frameText(page);
    assert.match(t, /The soil warms slowly in the north bed/);
    assert.equal(await page.locator(q("html-note-scripts")).count(), 1, "the scripts-off line shows (the sample has one script)");
    assert.equal(await page.locator(q("review-row")).count(), 0, "no Review first for HTML (D9)");
    const img = await (await (await page.$(q("html-frame"))).contentFrame()).evaluate(() => document.querySelector("img")?.src.slice(0, 22));
    assert.equal(img, "data:image/png;base64,");
    assert.deepEqual(cspViolations(page.log), []);
  });

  test("select a sentence in Comment mode, comment, Send: the agent's replace_text changes only that text; the view reloads; History shows it; Revert restores the bytes", async () => {
    const card = await commentOn(page, "the hardy crops go there first", "Say cold-hardy.");
    assert.match(await card.textContent(), /hardy crops go there first/, "the card quotes exactly the selected words");
    await page.waitForTimeout(500);
    await page.locator(q("send")).click();
    await until(async () => fs.readFileSync(file).includes("cold-hardy crops"), "the agent's change on disk", 40000);
    const after1 = fs.readFileSync(file);
    const at = SAMPLE.indexOf("hardy crops");
    assert.ok(after1.subarray(0, at).equals(SAMPLE.subarray(0, at)), "bytes before the edit are unchanged");
    assert.ok(after1.subarray(at + Buffer.byteLength("cold-hardy crops")).equals(SAMPLE.subarray(at + Buffer.byteLength("hardy crops"))), "bytes after the edit are unchanged");
    await until(async () => /cold-hardy crops go there first/.test(await frameText(page)), "the view shows the new text");
    await page.locator(q("activity-entry")).first().waitFor({ timeout: 20000 });
    // History lists the run with the changed text
    await page.locator(q("panel-history")).scrollIntoViewIfNeeded();
    const row = page.locator(q("history-row")).first();
    await row.waitFor();
    await row.click();
    await until(async () => /cold-hardy/.test(await page.locator(q("panel-history")).textContent()), "History shows the change");
    assert.equal(await page.locator(q("tracked-export")).count(), 0, "no tracked-changes export for HTML (D9)");
    // Revert
    const revert = page.locator(`${q("revert")}:visible, ${q("revert-folded")}:visible`).first();
    await revert.click();
    await until(async () => fs.readFileSync(file).equals(SAMPLE), "Revert restores the bytes exactly", 20000);
    await until(async () => /the hardy crops go there first/.test(await frameText(page)), "the view shows the restored text");
  });
});

describe("HTML: the person's text edits", () => {
  let w, file, page;
  before(async () => {
    ({ w, file } = world("edits.html"));
    page = await openPage(w, file);
  });
  after(async () => {
    await page?.close();
    await w?.cleanup();
  });

  test("a typed fix counts as unsent and Send writes exactly it", async () => {
    const b = await textBox(page, "every other morning");
    await page.mouse.click(b.last.right - 1, b.last.y);
    // the paragraph becomes editable on the poll tick after the click (a key within 50 ms of it can be lost: not addressed in this phase)
    await until(async () => (await (await page.$(q("html-frame"))).contentFrame()).evaluate(() => !!document.querySelector("[contenteditable]")), "the paragraph is editable");
    await page.keyboard.type(" gently");
    await page.locator(q("html-edits-bar")).waitFor();
    assert.match(await page.locator(q("html-edits-bar")).textContent(), /1 unsent text edit/);
    await until(async () => /every other morning gently until/.test(await frameText(page)), "the frame shows what was typed");
    await page.locator(q("send")).click();
    await until(async () => fs.readFileSync(file).includes("every other morning gently until"), "the fix is in the file");
    const now = fs.readFileSync(file);
    const at = SAMPLE.indexOf("every other morning") + "every other morning".length;
    assert.ok(now.subarray(0, at).equals(SAMPLE.subarray(0, at)) && now.subarray(at + " gently".length).equals(SAMPLE.subarray(at)), "nothing else changed");
    await until(async () => (await page.locator(q("html-edits-bar")).count()) === 0, "the edit is no longer unsent");
  });
});

describe("HTML: the agent's limits and the run", () => {
  let w, file, page, agent;
  before(async () => {
    ({ w, file } = world("limits.html"));
    agent = startAgent(w, file, { add: "<script>alert(1)</script>" });
    page = await openPage(w, file);
  });
  after(async () => {
    agent?.stop();
    await page?.close();
    await w?.cleanup();
  });

  test("a reply that adds a script is refused: the file is unchanged and the run's result shows the fixed sentence", async () => {
    await commentOn(page, "Onions and peas can go in", "Add a reminder script here.");
    await page.waitForTimeout(400);
    await page.locator(q("send")).click();
    await page.locator(q("activity-entry")).first().waitFor({ timeout: 40000 }).catch((e) => {
      throw new Error(`${e.message}\nthe fake agent said:\n${agent.out().slice(-3000)}`);
    });
    assert.ok(fs.readFileSync(file).equals(SAMPLE), "nothing was written");
    await until(async () => (await page.locator(q("activity-entry")).first().textContent()).includes(ACTIVE_REFUSED), "the fixed sentence in the run's result");
    assert.ok(!(await frameText(page)).includes("alert(1)"));
  });
});
