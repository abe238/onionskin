import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { LINE_END, agentEdit, boxOf, cspViolations, launch, makeWorld, scrollToPara, until, waitDoc } from "./helpers/harness.mjs";

// Learning at Send with bytes the real editor saves: the agent lengthens a paragraph, the person deletes words from it in the page and
// sends, and the server's worker stores one edit pair (booleans only) in the state dir. No panel is involved (the page part is a later
// step). Never reads the clipboard, never asserts focus.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WORD_BACK = process.platform === "darwin" ? "Alt+Backspace" : "Control+Backspace";

describe("learning from an edit of the agent's text (DOCX)", () => {
  let w, br;
  before(async () => {
    w = makeWorld({ ONIONSKIN_NO_SOFFICE: "1" });
    br = await launch();
  });
  after(async () => {
    await br?.close();
    await w?.cleanup();
  });

  test("one real chain: the agent lengthens a paragraph, the person shortens it and sends, one pair is stored", async () => {
    const file = w.doc("long.docx");
    const evidence = path.join(w.state, "voice-evidence.json");
    const page = await br.page();
    await page.setViewportSize({ width: 1440, height: 900 });
    const poll = w.spawnCli(["poll", file]);
    await page.goto(await w.open(file));
    await waitDoc(page);
    await page.locator('[data-testid="banner-listening"]').waitFor({ timeout: 20000 });
    await page.locator('[data-testid="overall-note"]').fill("Please expand paragraph 020.");
    await page.waitForTimeout(700);
    await page.locator('[data-testid="send"]').click();
    const res = await Promise.race([poll.done, sleep(25000).then(() => null)]);
    assert.ok(res && res.code === 0, res?.stderr || "poll timed out");
    await page.locator('[data-testid="banner-working"]').waitFor();
    const added = "annual cycle, which in practice means that every office has to wait for nearly twelve full months before it can learn anything useful about its own results.";
    agentEdit([file, "replace", "annual cycle.", added, "Paragraph 020:"]);
    const rj = w.doc("r-1.json");
    fs.writeFileSync(rj, JSON.stringify({ summary: "Expanded.", results: [] }));
    assert.equal((await w.cli(["done", file, "--results", rj])).code, 0);
    await page.locator('[data-testid="activity-entry"]').first().waitFor({ timeout: 20000 });
    assert.ok(!fs.existsSync(evidence) || JSON.parse(fs.readFileSync(evidence, "utf8")).pairs.length === 0, "nothing learned from the agent's run alone");

    // the person deletes most of what the agent added, from the paragraph's end, word by word
    const p = await until(() => scrollToPara(page, "nearly twelve full months", 20 / 300), "the agent's text in the page");
    const b = await boxOf(p);
    await page.mouse.click(b.x + b.width - 40, b.y + b.height - 10);
    await page.keyboard.press(LINE_END);
    for (let i = 0; i < 30; i++) await page.keyboard.press(WORD_BACK);
    await page.keyboard.type(" cycle.");
    await page.locator('[data-testid="overall-note"]').fill("Thanks.");
    await page.waitForTimeout(700);
    await page.locator('[data-testid="send"]').click();

    const ev = await until(() => {
      if (!fs.existsSync(evidence)) return null;
      const e = JSON.parse(fs.readFileSync(evidence, "utf8"));
      return e.pairs.length ? e : null;
    }, "a stored edit pair", 30000);
    assert.equal(ev.pairs.length, 1, JSON.stringify(ev.pairs));
    assert.equal(ev.pairs[0].short, true);
    assert.deepEqual(Object.keys(ev.pairs[0]).sort(), ["at", "exclaim", "fmt", "restored", "sentences", "short"], "booleans and a time only");
    assert.equal(fs.statSync(evidence).mode & 0o777, 0o600);
    assert.ok(!fs.readFileSync(evidence, "utf8").includes("long.docx"), "no file name is kept");
    assert.deepEqual(cspViolations(br.log), []);
  });
});
