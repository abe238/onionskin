import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, describe, test } from "node:test";
import { LINE_END, agentEdit, boxOf, cspViolations, launch, makeWorld, scrollToPara, srcModule, until, waitDoc } from "./helpers/harness.mjs";

// Formatting and moves made in a Word document while the agent works, through a real browser: the user bolds a word, picks a heading,
// cuts a paragraph and pastes it elsewhere; the agent's run lands; the server merge (src/merge.js) carries them onto the agent's
// version when that is safe, and the banner says exactly what it did not carry and what to check. (Typing during a run: e2e/fastloop.e2e.test.js.)
const MAC = process.platform === "darwin";
const MODK = MAC ? "Meta" : "Control";
const QUICK = `${MODK}+Shift+K`;
const q = (id) => `[data-testid="${id}"]`;

describe("formatting and moves while the agent works (DOCX)", () => {
  let w, br, file, page, readDocxParagraphs;
  before(async () => {
    w = makeWorld();
    br = await launch();
    file = w.doc("long.docx");
    page = await br.page();
    await page.goto(await w.open(file));
    await waitDoc(page);
    ({ readDocxParagraphs } = await srcModule("docx.js"));
  });
  after(async () => {
    await br?.close();
    await w?.cleanup();
  });
  const disk = () => readDocxParagraphs(fs.readFileSync(file), { detail: true });
  const onDisk = (prefix) => disk().find((p) => p.text.startsWith(prefix));
  /** The paragraphs on disk from `from` to `to`, by their number. */
  const numbers = (from, to) => {
    const all = disk().map((p) => /^Paragraph (\d+):/.exec(p.text)?.[1] ?? (p.text.trim() ? "?" : ""));
    return all.slice(all.indexOf(from), all.indexOf(to) + 1).filter(Boolean);
  };
  /** The direct formatting of `word` in the paragraph on disk (it is one run, or the test fails). */
  const look = (prefix, word) => {
    const p = onDisk(prefix);
    const s = p.text.indexOf(word);
    let at = 0;
    const hit = p.spans.filter((x) => ((at += x.n), at > s && at - x.n < s + word.length));
    assert.equal(hit.length, 1, `"${word}" is one run on disk`);
    return hit[0].set;
  };
  const guess = (prefix) => Number(prefix.match(/\d+/)[0]) / 300;
  /** The box of the paragraph that starts with `prefix`, brought to the middle of the view: the banners at the edges would take the click. */
  const bring = async (prefix) => {
    const p = await scrollToPara(page, prefix, guess(prefix));
    await p.evaluate((e) => e.scrollIntoView({ block: "center" }));
    await page.waitForTimeout(250);
    return boxOf(p);
  };
  /** Double-click a word of the paragraph that starts with `prefix`; returns the word. */
  const selectWord = async (prefix, dx = 150) => {
    const b = await bring(prefix);
    await page.mouse.dblclick(b.x + dx, b.y + 12);
    await page.locator(q("comment-chip")).waitFor({ timeout: 5000 });
    return (await page.evaluate(() => window.getSelection().toString())).trim();
  };
  /** Comment on `prefix`, Send, and return the delivered batch: the agent now holds the file. */
  const deliver = async (prefix) => {
    const p = w.spawnCli(["poll", file]);
    await page.locator(q("banner-listening")).waitFor({ timeout: 20000 });
    await selectWord(prefix);
    await page.keyboard.press(QUICK);
    await page.locator(q("quick-ask")).waitFor({ timeout: 3000 });
    await page.keyboard.type("Please update.");
    await page.keyboard.press(`${MODK}+Enter`);
    const res = await Promise.race([p.done, new Promise((r) => setTimeout(() => r(null), 25000))]);
    assert.ok(res && res.code === 0, res?.stderr || "poll timed out");
    await page.locator(q("banner-working")).waitFor();
    return JSON.parse(res.stdout);
  };
  const finish = async (batch) => {
    const results = w.doc("results.json");
    fs.writeFileSync(results, JSON.stringify({ summary: "Updated.", results: [{ comment_id: batch.instructions.comments[0].id, status: "done", note: "Done." }] }));
    const done = await w.cli(["done", file, "--results", results]);
    assert.equal(done.code, 0, done.stderr);
  };
  /** The agent's text is in the page: the run landed and the page reloaded the merged file. */
  const landed = async (text) => {
    await page.locator(".de-p", { hasText: text }).first().waitFor({ timeout: 30000 });
    await until(async () => /No unsent edits/.test(await page.locator(".topbar").textContent()), "the merge to be written and the page to hold no unsent edits");
  };
  /** Cut the whole paragraph `prefix` and paste it as its own paragraph right under `under`, as a person does. */
  const cutAndPasteUnder = async (prefix, under) => {
    const b = await bring(prefix);
    await page.mouse.click(b.x + 5, b.y + 8, { clickCount: 3 });
    await until(async () => (await page.evaluate(() => window.getSelection().toString())).startsWith(prefix), "the whole paragraph to be selected");
    await page.keyboard.press(`${MODK}+x`);
    await until(async () => (await page.locator(".de-p", { hasText: prefix }).count()) === 0, "the paragraph to be cut");
    const u = await bring(under);
    await page.mouse.click(u.x + u.width - 40, u.y + u.height - 10);
    await page.keyboard.press(LINE_END);
    await page.keyboard.press("Enter");
    await page.keyboard.press(`${MODK}+v`);
    await page.locator(".de-p", { hasText: prefix }).first().waitFor({ timeout: 5000 });
  };

  test("a word made bold and a heading picked during the run are in the merged file, next to the agent's change, and nothing is reported", async () => {
    const batch = await deliver("Paragraph 020:");
    const word = await selectWord("Paragraph 024:");
    assert.ok(word.length > 2, `a word is selected (${word})`);
    await page.keyboard.press(`${MODK}+b`);
    // a heading level for another paragraph, from the formatting bar
    const b = await bring("Paragraph 026:");
    await page.mouse.click(b.x + 200, b.y + 12);
    await page.locator('[data-testid="editbar"] button[aria-label="Paragraph style"]').click();
    await page.locator(".de-dd-opt", { hasText: /^Heading 2/ }).first().click();
    await page.waitForTimeout(300);
    assert.equal(onDisk("Paragraph 024:").spans.length, 1, "nothing is on disk yet: the page holds it");
    agentEdit([file, "replace", "regional leads", "regional heads", "Paragraph 020:"]);
    await finish(batch);
    await landed("regional heads");
    assert.match(onDisk("Paragraph 020:").text, /regional heads/, "the agent's change is on disk");
    assert.equal(look("Paragraph 024:", word).b, true, "the word is bold on disk");
    assert.equal(onDisk("Paragraph 024:").spans.filter((x) => x.set.b).length, 1, "and only that word");
    assert.match(onDisk("Paragraph 026:").styleName || "", /^Heading 2$/i, "the heading is on disk");
    assert.match(onDisk("Paragraph 024:").text, /^Paragraph 024: .* annual cycle\.$/, "no text changed");
    assert.equal(await page.locator(q("banner-held-back")).count(), 0, "nothing was held back");
    // the reloaded page shows it
    await scrollToPara(page, "Paragraph 024:", guess("Paragraph 024:"));
    const weight = await page.evaluate((t) => [...document.querySelectorAll(".de-p")].find((e) => e.textContent.startsWith("Paragraph 024:")) && [...[...document.querySelectorAll(".de-p")].find((e) => e.textContent.startsWith("Paragraph 024:")).querySelectorAll("span")].find((s) => s.textContent.trim() === t)?.style.fontWeight, word);
    assert.equal(weight, "700", "the word is bold in the reloaded page");
  });

  test("a paragraph cut and pasted elsewhere during the run is moved in the merged file; the banner counts nothing as missing and asks to check its formatting", async () => {
    assert.deepEqual(numbers("043", "048"), ["043", "044", "045", "046", "047", "048"]);
    const batch = await deliver("Paragraph 040:");
    await cutAndPasteUnder("Paragraph 044:", "Paragraph 047:");
    agentEdit([file, "replace", "regional leads", "regional chiefs", "Paragraph 040:"]);
    await finish(batch);
    await landed("regional chiefs");
    assert.deepEqual(numbers("043", "048"), ["043", "045", "046", "047", "044", "048"], "the paragraph is under the one it was pasted under");
    assert.match(onDisk("Paragraph 040:").text, /regional chiefs/, "the agent's change is on disk");
    assert.equal(disk().filter((p) => p.text.startsWith("Paragraph 044:")).length, 1, "once, not twice");
    assert.deepEqual(onDisk("Paragraph 044:").spans.map((x) => x.set), [{}], "the agent's paragraph was moved as it is: the look the paste wrote out on the copy is not set on it");
    // the pasted copy reads differently from the original (the paste wrote its look out), and so would a copy restyled before the cut
    const held = page.locator(q("banner-held-back"));
    await held.waitFor({ timeout: 30000 });
    assert.match(await held.textContent(), /One paragraph you moved while the agent worked is in its new place\. Check its formatting/);
    assert.doesNotMatch(await held.textContent(), /not in the document/);
    assert.deepEqual(await held.locator(q("held-item")).allTextContents(), ["Your move was carried over. This paragraph has the formatting of the agent's version: if you changed its formatting too, set it again."]);
    await page.locator(q("held-dismiss")).click();
    await held.waitFor({ state: "detached" });
    const shown = await page.evaluate(() => [...document.querySelectorAll(".de-p")].map((e) => /^Paragraph (\d+):/.exec(e.textContent)?.[1]).filter(Boolean));
    assert.deepEqual(shown.slice(shown.indexOf("045"), shown.indexOf("045") + 4), ["045", "046", "047", "044"], "and the reloaded page shows it there");
  });

  test("a word made bold in a paragraph that is then cut and pasted: the move is in the merged file, the bold is not, and the banner says so", async () => {
    const batch = await deliver("Paragraph 080:");
    const word = await selectWord("Paragraph 084:");
    assert.ok(word.length > 2, `a word is selected (${word})`);
    await page.keyboard.press(`${MODK}+b`);
    await page.waitForTimeout(500);
    await cutAndPasteUnder("Paragraph 084:", "Paragraph 087:");
    agentEdit([file, "replace", "regional leads", "regional guides", "Paragraph 080:"]);
    await finish(batch);
    await landed("regional guides");
    const held = page.locator(q("banner-held-back"));
    await held.waitFor({ timeout: 30000 });
    assert.match(await held.textContent(), /One edit you made while the agent worked is not in the document/);
    assert.deepEqual(await held.locator(q("held-item")).allTextContents(), ["Your move was carried over. The bold you changed inside this paragraph was not: the paragraph has the formatting of the agent's version."]);
    assert.deepEqual(numbers("083", "088"), ["083", "085", "086", "087", "084", "088"], "the paragraph is under the one it was pasted under");
    assert.deepEqual(onDisk("Paragraph 084:").spans.map((x) => x.set), [{}], `"${word}" is not bold on disk: the agent's paragraph was moved as it is`);
    assert.match(onDisk("Paragraph 080:").text, /regional guides/, "the agent's change is on disk");
    await page.locator(q("held-dismiss")).click();
    await held.waitFor({ state: "detached" });
  });

  test("the agent rewrote what the user formatted and moved: its text stays where it is, and the banner says what was not carried over", async () => {
    const batch = await deliver("Paragraph 060:");
    const word = await selectWord("Paragraph 064:");
    await page.keyboard.press(`${MODK}+b`);
    await cutAndPasteUnder("Paragraph 066:", "Paragraph 069:");
    agentEdit([file, "replace", "regional leads", "regional rewrites", "Paragraph 064:"]);
    agentEdit([file, "replace", "regional leads", "regional movers", "Paragraph 066:"]);
    await finish(batch);
    const held = page.locator(q("banner-held-back"));
    await held.waitFor({ timeout: 30000 });
    assert.match(await held.textContent(), /2 edits you made while the agent worked are not in the document/);
    const items = await held.locator(q("held-item")).allTextContents();
    assert.ok(items.some((t) => /The agent rewrote this paragraph, so the bold you changed inside it was not carried over\./.test(t)), items.join(" | "));
    assert.ok(items.some((t) => /You moved this paragraph, but the agent changed or removed it, so the move was not carried over\./.test(t)), items.join(" | "));
    assert.equal(items.length, 2, "the look the paste wrote out on the copy is not reported as a formatting change");
    assert.match(onDisk("Paragraph 064:").text, /regional rewrites/);
    assert.ok(!onDisk("Paragraph 064:").spans.some((x) => x.set.b), `"${word}" is not bold: the agent's paragraph was left alone`);
    assert.deepEqual(numbers("065", "070"), ["065", "066", "067", "068", "069", "070"], "the paragraph is where the agent has it");
    assert.match(onDisk("Paragraph 066:").text, /regional movers/);
    await page.locator(q("held-dismiss")).click();
    await held.waitFor({ state: "detached" });
  });

  test("no Content-Security-Policy violation and no page error in the whole run", () => {
    assert.deepEqual(cspViolations(br.log), []);
    assert.deepEqual(br.log.errors, []);
  });
});

// A merge that runs out of time (here: the merge worker is held for 20 s and the limit is 1 s): nothing is written, the error banner says
// so with the copy's name, Download my edits is offered, and the typed edit is still in the page. The server answers throughout.
describe("a merge past its time limit (DOCX)", () => {
  let w, br;
  before(async () => {
    w = makeWorld({ ONIONSKIN_MERGE_TIMEOUT_MS: "1000", ONIONSKIN_TEST_MERGE_DELAY_MS: "20000" });
    br = await launch();
  });
  after(async () => {
    await br?.close();
    await w?.cleanup();
  });

  test("the banner says nothing was written and where the copy is, offers the download, and the typed edit stays in the page", async () => {
    const file = w.doc("long.docx");
    const poll = w.spawnCli(["poll", file]);
    const page = await br.page();
    await page.goto(await w.open(file));
    await waitDoc(page);
    await page.locator(q("banner-listening")).waitFor({ timeout: 20000 });
    await page.locator(q("overall-note")).fill("Please update.");
    await page.locator(q("send")).click();
    const res = await Promise.race([poll.done, new Promise((r) => setTimeout(() => r(null), 25000))]);
    assert.ok(res && res.code === 0, res?.stderr || "poll timed out");
    await page.locator(q("banner-working")).waitFor();
    // the person types while the agent works
    const p = await scrollToPara(page, "Paragraph 030:", 0.1);
    const b = await boxOf(p);
    await page.mouse.click(b.x + b.width - 40, b.y + b.height - 10);
    await page.keyboard.press(LINE_END);
    await page.keyboard.type(" TYPED-WHILE-WORKING");
    agentEdit([file, "replace", "regional leads", "regional heads", "Paragraph 020:"]);
    const results = w.doc("results.json");
    fs.writeFileSync(results, JSON.stringify({ summary: "Updated.", results: [] }));
    const agentDisk = fs.readFileSync(file);
    const done = await w.cli(["done", file, "--results", results]);
    assert.equal(done.code, 0, done.stderr);
    const banner = page.locator(q("banner-error"));
    await banner.waitFor({ timeout: 30000 });
    assert.match(await banner.textContent(), /could not be merged into its version \(it took longer than 1 second; nothing was written, and a copy of your version was saved as long \(.+\)\.docx next to the file\)\. Your edits are still in this page/);
    assert.equal(await page.locator(q("error-download")).count(), 1, "Download my edits is offered");
    assert.ok(await page.locator(".de-p", { hasText: "TYPED-WHILE-WORKING" }).count(), "the typed edit is still in the page");
    assert.deepEqual(fs.readFileSync(file), agentDisk, "the file is the agent's version, untouched");
    const copies = fs.readdirSync(w.docs).filter((n) => /^long \(.+\)\.docx$/.test(n));
    assert.equal(copies.length, 1, `one copy next to the file (${fs.readdirSync(w.docs).join(", ")})`);
    const { readDocxParagraphs } = await srcModule("docx.js");
    assert.ok(readDocxParagraphs(fs.readFileSync(`${w.docs}/${copies[0]}`)).some((x) => x.text.includes("TYPED-WHILE-WORKING")), "the copy holds the typed edit");
    // the server kept answering while the worker was held
    const st = await w.cli(["status", file]);
    assert.equal(st.code, 0, st.stderr);
    await page.close();
  });

  test("the page's saved file keeps Word's paragraph ids, which the merge places the person's edits by", async () => {
    const { docxBytes } = await import("../test/helpers/zipbuild.js");
    const { readDocxParagraphs } = await srcModule("docx.js");
    const file = `${w.docs}/ids.docx`;
    const texts = Array.from({ length: 6 }, (_, i) => `Paragraph ${String(i + 1).padStart(3, "0")}: a sentence long enough to type into.`);
    fs.writeFileSync(file, docxBytes(texts.map((text, i) => ({ text, paraId: (0x1000 + i).toString(16).toUpperCase().padStart(8, "0") }))));
    const page = await br.page();
    await page.goto(await w.open(file));
    await waitDoc(page);
    const p = page.locator(".de-p", { hasText: "Paragraph 003:" }).first();
    const b = await boxOf(p);
    await page.mouse.click(b.x + b.width - 40, b.y + b.height - 10);
    await page.keyboard.press(LINE_END);
    await page.keyboard.type(" TYPED");
    await page.locator(q("overall-note")).fill("Look at this.");
    await page.locator(q("send")).click();
    await until(() => readDocxParagraphs(fs.readFileSync(file)).some((x) => x.text.includes("TYPED")), "the page's version to be written at Send");
    const ids = readDocxParagraphs(fs.readFileSync(file)).map((x) => [x.paraId, x.text.includes("TYPED")]);
    assert.deepEqual(ids, texts.map((_, i) => [(0x1000 + i).toString(16).toUpperCase().padStart(8, "0"), i === 2]));
    await page.close();
  });
});
