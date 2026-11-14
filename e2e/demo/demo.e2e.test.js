import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { cspViolations, havePython, launch, repo, skipUnless, until, VENV_HINT, WEBKIT } from "../helpers/harness.mjs";

// The Try-it page (web/demo), built from a TEST recording (the stand-in agent, real: false) into a temp folder and served with
// scripts/demo/serve.mjs. Opt-in: node scripts/run-tests.mjs demo (it builds its own page, which takes a while). One test also builds
// the committed real recording (web/demo/recording) the release way, so this file fails when that folder is missing or does not scan.
// The hostile and broken pages are copies of the built folder with the bundled recording edited afterwards: build.mjs itself refuses
// both (the scan refuses markup, and a hash that does not match), so there is no way to build them, only to tamper with a copy.
const BANNER = "This is a replay of one real session. No AI is running here, and nothing you do leaves this page.";
const ERROR = "This demo could not start in this browser. Try a recent Chrome, Safari or Firefox.";
const HOSTILE = "<img src=x onerror=alert(1)>";
const opts = { skip: skipUnless(havePython(), "needs .venv with python-docx", VENV_HINT) };
const flat = (s) => s.replace(/\s+/g, " ").trim();

describe("Try-it page", opts, () => {
  let root, rec, br, sites, v0Text, v1Text, summary, day, realRec;
  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "os-demo-e2e-"));
    rec = path.join(root, "rec");
    const made = spawnSync(process.execPath, [path.join(repo, "scripts", "demo", "test-recording.mjs"), rec], { encoding: "utf8" });
    assert.equal(made.status, 0, made.stderr);
    const { buildDemo } = await import("../../scripts/demo/build.mjs");
    const good = await buildDemo({ recordingDir: rec, out: path.join(root, "good"), test: true });
    const { readDocxParagraphs } = await import("../../src/docx.js");
    v0Text = readDocxParagraphs(fs.readFileSync(path.join(rec, "v0.docx"))).map((p) => flat(p.text));
    v1Text = readDocxParagraphs(fs.readFileSync(path.join(rec, "v1.docx"))).map((p) => flat(p.text));
    const recording = JSON.parse(fs.readFileSync(path.join(rec, "recording.json"), "utf8"));
    summary = recording.result.summary;
    day = recording.date;
    // tampered copies: swap strings inside the built bundle
    const tamper = (name, swaps) => {
      const dir = path.join(root, name);
      fs.cpSync(good, dir, { recursive: true });
      const js = fs.readdirSync(path.join(dir, "assets")).find((f) => f.endsWith(".js"));
      let src = fs.readFileSync(path.join(dir, "assets", js), "utf8");
      for (const [from, to] of swaps) {
        assert.equal(src.split(from).length, 2, `the bundle holds ${from.slice(0, 40)} exactly once`);
        src = src.replace(from, () => to);
      }
      fs.writeFileSync(path.join(dir, "assets", js), src);
      return dir;
    };
    const kept = recording.places[0].diff.find((op) => op[0] === "-")[1];
    // the bundler writes the recording's strings as template literals
    const hostile = tamper("hostile", [
      [`\`${summary}\``, `\`${HOSTILE}\``],
      [`[\`-\`,\`${kept}\`]`, "[`-`,`javascript:alert(1)`]"],
    ]);
    const sha = recording.v0_sha256;
    const broken = tamper("broken", [[sha, sha.slice(0, -1) + (sha.at(-1) === "0" ? "1" : "0")]]);
    // how a real recording reads with the test recording's words: only the copy's bundled flag is flipped (the committed real recording is built below)
    const realOne = tamper("real", [["real:!1,agent:`Test agent`", "real:!0,agent:`Test agent`"]]);
    // a recorded wait over 12 seconds: only the copy's bundled timing is changed (the page shortens it and says so)
    const slow = tamper("slow", [["result_ms:8e3", "result_ms:2e4"]]);
    // the committed real recording, built the release way (no --test) into a temp folder
    const { DEFAULT_RECORDING } = await import("../../scripts/demo/build.mjs");
    const release = await buildDemo({ recordingDir: DEFAULT_RECORDING, out: path.join(root, "release") });
    const committed = JSON.parse(fs.readFileSync(path.join(DEFAULT_RECORDING, "recording.json"), "utf8"));
    realRec = { recording: committed, v0Text: readDocxParagraphs(fs.readFileSync(path.join(DEFAULT_RECORDING, "v0.docx"))).map((p) => flat(p.text)) };
    const { serve } = await import("../../scripts/demo/serve.mjs");
    sites = { good: await serve(good), hostile: await serve(hostile), broken: await serve(broken), real: await serve(realOne), slow: await serve(slow), release: await serve(release) };
    br = await launch();
  });
  after(async () => {
    await br?.close();
    for (const s of Object.values(sites || {})) await s.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  /** A page that records every request and whether a file picker or an editable element ever appeared. */
  async function open(site, { query = "", media } = {}) {
    const page = await br.page();
    if (media) await page.emulateMedia(media);
    const requests = [];
    page.on("request", (r) => requests.push(r.url()));
    const dialogs = [];
    page.on("dialog", (d) => (dialogs.push(d.message()), d.dismiss()));
    await page.addInitScript(() => {
      window.__seen = { picker: 0, editable: 0 };
      const look = () => {
        if (document.querySelector('input[type="file" i]')) window.__seen.picker++;
        if (document.querySelector('[contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]')) window.__seen.editable++;
      };
      new MutationObserver(look).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["type", "contenteditable"] });
    });
    await page.goto(site.url + query);
    return { page, requests, dialogs };
  }
  const paras = (page) => page.evaluate(() => Array.from(document.querySelectorAll('[data-testid="demo-doc"] .de-p[data-bi]'), (el) => el.textContent.replace(/\s+/g, " ").trim()));
  const waitText = (page, want, what) => until(async () => JSON.stringify(await paras(page)) === JSON.stringify(want), what, 60000);
  const seen = (page) => page.evaluate(() => window.__seen);

  test("the replay runs end to end with no request after load, no file picker, nothing editable and no CSP violation", async () => {
    const { page, requests, dialogs } = await open(sites.good, { query: "?src=https://example.invalid/x.docx#src=https://example.invalid/y.docx" });
    await waitText(page, v0Text, "the letter before the agent");
    assert.equal(await page.getByTestId("demo-banner").textContent(), BANNER);
    assert.equal(await page.getByTestId("demo-who").textContent(), "This replay uses a test agent, not a real one.");
    const origin = new URL(sites.good.url).origin;
    const atLoad = requests.length;
    assert.deepEqual(requests.filter((u) => !u.startsWith(origin + "/") && !u.startsWith("blob:") && !u.startsWith("data:")), [], "every request is the page's own");
    assert.equal(requests.some((u) => /^https?:/.test(u) && new URL(u).hostname === "example.invalid"), false, "the address in the query is never fetched");

    // Send waits for every comment
    const send = page.getByTestId("demo-send");
    const adds = page.getByTestId("demo-add");
    assert.equal(await adds.count(), 3);
    for (let i = 0; i < 3; i++) {
      assert.equal(await send.isDisabled(), true, `Send is disabled with ${i} of 3 added`);
      assert.match(await page.getByTestId("demo-hint").textContent(), /^Add all 3 comments to send\. This replay only has the answer to all of them together\.$/);
      await adds.nth(i).click();
      assert.equal(await adds.nth(i).textContent(), "Added");
      // the added comment's place is outlined, on the overlay only
      await until(async () => (await page.locator('[data-testid="mark-spot"] .demo-mark-n').allTextContents()).includes(String(i + 1)), `the outline of comment ${i + 1}`);
    }
    assert.equal(await send.isDisabled(), false);
    await send.click();
    assert.equal(await page.getByTestId("demo-working").textContent(), " Agent working. This replay runs at the real speed.");
    await page.getByTestId("demo-result").waitFor({ timeout: 30000 });
    await waitText(page, v1Text, "the letter after the agent");
    assert.equal(await page.locator("#demo-finished").textContent(), "Agent finished");
    assert.equal(await page.getByTestId("demo-summary").textContent(), summary);
    await until(async () => (await page.getByTestId("mark-ins").count()) > 0, "the agent's new words tinted");
    // in "What changed", an added run never touches the removed run before it
    const gaps = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="demo-places"] del + ins')].map((ins) => {
        const a = ins.previousElementSibling.getClientRects();
        const b = ins.getClientRects();
        const last = a[a.length - 1];
        return b[0].top < last.bottom && b[0].bottom > last.top ? b[0].left - last.right : null; // null: wrapped to another line
      }),
    );
    assert.ok(gaps.length > 0, "the list has a removed run followed by an added one");
    for (const g of gaps) assert.ok(g === null || g >= 2, `a removed and an added run keep a gap (${g}px)`);
    await page.getByTestId("demo-revert").click();
    await waitText(page, v0Text, "the letter back as it was");
    assert.equal(await page.getByTestId("demo-reverted").locator("p").textContent(), "Reverted. The letter is back to how it was, the same way the real Revert put it back.");
    await page.getByTestId("demo-again").click();
    assert.equal(await page.getByTestId("demo-add").first().textContent(), "Add this comment");

    assert.deepEqual(requests.slice(atLoad).filter((u) => !u.startsWith("blob:") && !u.startsWith("data:")), [], "no request after load");
    assert.deepEqual(await seen(page), { picker: 0, editable: 0 }, "no file picker and nothing editable at any time");
    assert.equal(await page.locator('input[type="file" i], [contenteditable="true"]').count(), 0);
    assert.deepEqual(cspViolations(page.log), []);
    assert.deepEqual(page.log.errors, []);
    assert.deepEqual(dialogs, []);
    // the CSP is in force: an inline script does not run
    await page.evaluate(() => {
      const s = document.createElement("script");
      s.textContent = "window.__ran = 1";
      document.head.append(s);
    });
    assert.equal(await page.evaluate(() => window.__ran), undefined);
    await page.close();
  });

  test("a dropped Word file and a paste change nothing", async () => {
    const { page, requests } = await open(sites.good);
    await waitText(page, v0Text, "the letter");
    const atLoad = requests.length;
    const r = await page.evaluate(() => {
      const target = document.querySelector('[data-testid="demo-doc"] .de-p');
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array([0x50, 0x4b, 3, 4])], "visitor.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }));
      const fire = (type) => target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
      const drag = ["dragenter", "dragover", "drop"].map(fire);
      const pd = new DataTransfer();
      pd.setData("text/plain", "Pasted words");
      pd.items.add(new File([new Uint8Array([0x50, 0x4b, 3, 4])], "pasted.docx"));
      const paste = target.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: pd }));
      return { drag, paste };
    });
    assert.deepEqual(r, { drag: [false, false, false], paste: false }, "every drag, drop and paste is stopped");
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))); // two frames: anything the events started has drawn
    assert.deepEqual(await paras(page), v0Text);
    assert.equal(await page.getByTestId("demo-doc").getAttribute("data-shown"), "v0");
    assert.deepEqual(requests.slice(atLoad).filter((u) => !u.startsWith("data:")), [], "no request, not even a blob, after the drop");
    assert.deepEqual(await seen(page), { picker: 0, editable: 0 });
    await page.close();
  });

  test("with reduced motion nothing animates; without it the working state does", async () => {
    const running = async (media) => {
      const { page } = await open(sites.good, { media: { reducedMotion: media } });
      await waitText(page, v0Text, "the letter");
      for (const b of await page.getByTestId("demo-add").all()) await b.click();
      await page.getByTestId("demo-send").click();
      await page.getByTestId("demo-working").waitFor();
      const n = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running").length);
      await page.close();
      return n;
    };
    assert.equal(await running("reduce"), 0);
    assert.ok((await running("no-preference")) > 0, "the probe sees the spinner when motion is allowed");
  });

  test("typing, keys, a right-click and the viewer's own buttons change nothing in the letter", async () => {
    const { page, requests } = await open(sites.good);
    await waitText(page, v0Text, "the letter");
    const atLoad = requests.length;
    const b = await page.locator('[data-testid="demo-doc"] .de-p').nth(1).boundingBox();
    await page.mouse.click(b.x + 100, b.y + 8);
    await page.keyboard.type("zz");
    // Playwright's WebKit takes Backspace outside a text field as "go back" and leaves the page (Safari does not), so it is skipped there
    for (const k of [...(WEBKIT ? [] : ["Backspace"]), "Delete", "Enter", "Tab", "ControlOrMeta+x", "ControlOrMeta+v", "ControlOrMeta+z", "ControlOrMeta+b", "ControlOrMeta+o", "ControlOrMeta+s"]) await page.keyboard.press(k);
    await page.mouse.click(b.x + 100, b.y + 8, { button: "right" });
    await page.keyboard.press("Escape");
    for (const btn of await page.locator('[data-testid="demo-doc"] button').all()) if (await btn.isVisible()) await btn.click();
    // zoom lays the pages out again: wait (with a deadline) for the letter to read as before, not for a fixed time
    await waitText(page, v0Text, "the letter unchanged after typing and clicks");
    assert.deepEqual(await seen(page), { picker: 0, editable: 0 });
    assert.deepEqual(requests.slice(atLoad).filter((u) => !u.startsWith("data:")), [], "no request");
    assert.deepEqual(page.log.errors, []);
    await page.close();
  });

  test("a real recording names the agent and the day under the intro", async () => {
    const { page } = await open(sites.real);
    await waitText(page, v0Text, "the letter");
    const [y, m, d] = day.split("-").map(Number);
    const month = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][m - 1];
    assert.equal(await page.getByTestId("demo-who").textContent(), `The comments were written for this demo. The agent that answered them was real: Test agent, on ${month} ${d}, ${y}.`);
    await page.close();
  });

  test("the release build of the committed real recording loads and names the real agent under the replay banner", async () => {
    const { recording, v0Text: letter } = realRec;
    assert.equal(recording.real, true);
    const { page } = await open(sites.release);
    await waitText(page, letter, "the real recording's letter");
    assert.equal(await page.getByTestId("demo-banner").textContent(), BANNER);
    const who = await page.getByTestId("demo-who").textContent();
    assert.match(who, new RegExp(`^The comments were written for this demo\\. The agent that answered them was real: ${recording.agent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}, on `));
    assert.deepEqual(page.log.errors, []);
    await page.close();
  });

  test("a recording with markup in the agent's words and a script address in a change shows them as plain text", async () => {
    const { page, dialogs } = await open(sites.hostile);
    await waitText(page, v0Text, "the letter");
    for (const b of await page.getByTestId("demo-add").all()) await b.click();
    await page.getByTestId("demo-send").click();
    await page.getByTestId("demo-result").waitFor({ timeout: 30000 });
    assert.equal(await page.getByTestId("demo-summary").textContent(), HOSTILE);
    assert.equal(await page.getByTestId("demo-panel").locator("img, a, script, iframe").count(), 0);
    assert.match(await page.getByTestId("demo-places").textContent(), /javascript:alert\(1\)/);
    assert.equal(await page.getByTestId("demo-places").locator("del").first().textContent(), "javascript:alert(1)");
    assert.deepEqual(dialogs, []);
    await page.close();
  });

  test("a version that does not match its hash mounts nothing and shows the error line", async () => {
    const { page, requests } = await open(sites.broken);
    await page.getByTestId("demo-error").waitFor({ timeout: 30000 });
    assert.equal(await page.getByTestId("demo-error").textContent(), ERROR);
    assert.equal(await page.getByTestId("demo-banner").textContent(), BANNER);
    assert.equal(await page.locator(".de-root, .de-p, [data-testid=demo-doc]").count(), 0);
    assert.equal(requests.some((u) => u.startsWith("blob:")), false, "the engine never got a file");
    await page.close();
  });

  test("a long recorded wait is shortened to 6 seconds and the page says so", async () => {
    const { page } = await open(sites.slow);
    await waitText(page, v0Text, "the letter");
    for (const b of await page.getByTestId("demo-add").all()) await b.click();
    await page.getByTestId("demo-send").click();
    assert.equal(await page.getByTestId("demo-working").textContent(), " Agent working. This replay is shortened.");
    await page.getByTestId("demo-result").waitFor({ timeout: 30000 });
    await page.close();
  });

  test("it follows the system's dark setting, and a phone-width window has no sideways scroll and shows the result after Send", async () => {
    for (const scheme of ["light", "dark"]) {
      const { page } = await open(sites.good, { media: { colorScheme: scheme } });
      await page.setViewportSize({ width: 390, height: 844 });
      await waitText(page, v0Text, "the letter");
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), scheme);
      const panelBg = await page.getByTestId("demo-card").first().evaluate((el) => getComputedStyle(el).backgroundColor);
      const lum = panelBg.match(/\d+/g).slice(0, 3).map(Number).reduce((a, b) => a + b, 0) / 3;
      assert.ok(scheme === "dark" ? lum < 80 : lum > 180, `the cards are ${scheme} (${panelBg})`);
      for (const b of await page.getByTestId("demo-add").all()) await b.click();
      await page.getByTestId("demo-send").click();
      await page.getByTestId("demo-result").waitFor({ timeout: 30000 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "no sideways scroll");
      await page.close();
    }
  });
});
