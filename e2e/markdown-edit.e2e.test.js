// Markdown slice 2 in a real browser against the real server and CLI: Preview is the default and looks selected; typing in the preview
// swaps to Edit with the key at the exact place; Preview shows the draft; a comment on the draft; Send writes the edit, then the
// agent's reply lands on the commented words and its "changed" mark sits on them; Revert. Keys that must not swap do not. A file
// changed on disk before Send keeps the draft and the comments and writes nothing. A caret at the end of a paragraph element is that
// paragraph. Temp state, a temporary HOME and synthetic documents only.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { WEBKIT, cspViolations, launch, makeWorld, until } from "./helpers/harness.mjs";

const q = (id) => `[data-testid="${id}"]`;
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

let br;
before(async () => {
  br = await launch();
});
after(async () => {
  await br?.close();
});

function world(name, text) {
  const w0 = makeWorld({ ONIONSKIN_NO_SOFFICE: "1" });
  const home = path.join(w0.root, "home");
  fs.mkdirSync(path.join(home, ".local", "bin"), { recursive: true });
  Object.assign(w0.env, { HOME: home, PATH: `${path.join(home, ".local", "bin")}:${w0.env.PATH}` });
  const file = w0.doc(name);
  fs.writeFileSync(file, text);
  return { w: w0, file: fs.realpathSync(file) };
}
async function openPage(w, file) {
  const page = await br.page();
  page.on("dialog", (d) => d.dismiss());
  await page.goto(await w.open(file));
  await page.waitForSelector(q("md-preview"), { timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('[data-testid="state-pill"]'), null, { timeout: 30000 });
  return page;
}
/** Puts the caret (or a selection) in the preview's text: the `nth` copy of `needle` in the runs, at offset `k` from its start (to `k2`). */
async function caretAt(page, needle, k, { nth = 0, k2 = null } = {}) {
  const ok = await page.evaluate(
    ([needle, k, nth, k2]) => {
      let seen = 0;
      for (const el of document.querySelectorAll('[data-testid="md-preview"] [data-r]')) {
        const t = el.firstChild;
        if (!t) continue;
        for (let i = t.data.indexOf(needle); i >= 0; i = t.data.indexOf(needle, i + 1)) {
          if (seen++ !== nth) continue;
          document.querySelector('[data-testid="md-preview"]').focus();
          const s = window.getSelection();
          s.removeAllRanges();
          const r = document.createRange();
          r.setStart(t, i + k);
          r.setEnd(t, i + (k2 ?? k));
          s.addRange(r);
          return true;
        }
      }
      return false;
    },
    [needle, k, nth, k2],
  );
  assert.ok(ok, `${needle} is in the preview`);
}
async function charBox(page, needle, nth = 0) {
  return page.evaluate(
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
            return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, y: b.top + b.height / 2 };
          };
          return { first: at(i), last: at(i + needle.length - 1) };
        }
      }
      return null;
    },
    [needle, nth],
  );
}
async function drag(page, a, b) {
  await page.mouse.move(a.left + 1, a.y);
  await page.mouse.down();
  await page.mouse.move(b.right - 1, b.y, { steps: 6 });
  await page.mouse.up();
}
const previewText = (page) => page.locator(q("md-preview")).textContent();
const source = (page) => page.locator(q("md-source")).inputValue();

describe("Markdown edit: type in the preview, Edit, Preview, comment on the draft, Send, the agent's reply, Revert", () => {
  const TEXT = "﻿# Fruit\r\n\r\nA banana and a mango split.\r\n\r\nSecond **bold** line here.\r\n";
  let w, file, page;
  before(async () => {
    ({ w, file } = world("notes.md", TEXT));
    page = await openPage(w, file);
  });
  after(async () => {
    await page?.close();
    await w?.cleanup();
  });

  test("Preview is the default and is what looks selected; keys that must not swap leave the preview alone", async () => {
    assert.equal(await page.locator(q("mode-preview")).getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator(q("mode-edit")).getAttribute("aria-pressed"), "false");
    await caretAt(page, "banana", 2);
    for (const k of [`${process.platform === "darwin" ? "Meta" : "Control"}+c`, "Control+a", "ArrowLeft", "ArrowRight", "Backspace", "Delete", "Tab", "Escape"]) {
      await caretAt(page, "banana", 2);
      await page.keyboard.press(k);
      assert.equal(await page.locator(q("md-host")).getAttribute("data-view"), "preview", `${k} does not swap`);
    }
    // composition (an IME) does not swap either
    await caretAt(page, "banana", 2);
    await page.evaluate(() => document.querySelector('[data-testid="md-preview"]').dispatchEvent(new KeyboardEvent("keydown", { key: "a", isComposing: true, bubbles: true })));
    assert.equal(await page.locator(q("md-host")).getAttribute("data-view"), "preview");
    assert.ok(fs.readFileSync(file).equals(Buffer.from(TEXT)), "nothing written");
  });

  test("one Send: a key typed in the preview, a comment on the edited text (an ordinary card), the edit written and the reply landing on exactly those words; a comment on the file and one on an earlier draft say Select again; Revert", async () => {
    const commentOn = async (word, text) => {
      const b = await charBox(page, word);
      await drag(page, b.first, b.last);
      await page.locator(q("comment-chip")).click();
      const card = page.locator(q("comment-card")).last();
      await card.waitFor();
      await card.locator("textarea").fill(text);
      await page.waitForTimeout(400);
      return card;
    };
    const AGAIN = "You edited the text after making this comment, so it no longer points at a place. Select the words again, or send it as it is.";
    // a comment on the file as it is: an ordinary Draft
    const onFile = await commentOn("Fruit", "A better title.");
    assert.equal(await onFile.locator(q("select-again")).count(), 0);
    await caretAt(page, "banana", 3);
    await page.keyboard.press("Z");
    await page.locator(q("md-source")).waitFor();
    assert.equal(await page.locator(q("mode-edit")).getAttribute("aria-pressed"), "true");
    const typed = await source(page);
    assert.equal(typed, "# Fruit\n\nA banZana and a mango split.\n\nSecond **bold** line here.\n", "the key once, at the caret, LF in the textarea");
    await page.keyboard.type("!");
    assert.match(await source(page), /banZ!ana/, "the caret was after the key");
    // the text changed after the file comment was made: it says so, and the line above Send appears
    await onFile.locator(q("select-again")).waitFor();
    assert.equal((await onFile.locator(q("select-again")).textContent()).trim(), AGAIN);
    assert.equal((await page.locator(q("md-send-no-places")).textContent()).trim(), "Your edit is written first, so comments without a place go to the agent as words only.");
    await page.keyboard.press("Escape");
    await until(async () => /A banZ!ana and a mango split\./.test(await previewText(page)), "Preview shows the draft");
    assert.equal(await page.locator(q("mode-preview")).getAttribute("aria-pressed"), "true");
    // the leave guard counts the draft
    assert.equal(await page.evaluate(() => { const e = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; }), true);
    // (d) a comment on the draft, then one more key: that comment says Select again, at once
    const early = await commentOn("bold", "Make this stronger.");
    assert.equal(await early.locator(q("select-again")).count(), 0, "an ordinary card on the draft");
    await caretAt(page, "line here", 4);
    await page.keyboard.press("S");
    await page.locator(q("md-source")).waitFor();
    await early.locator(q("select-again")).waitFor();
    await page.keyboard.press("Escape");
    await until(async () => /Second bold lineS here\./.test(await previewText(page)), "Preview shows the new draft");
    // a comment on the edited text in front of the person: an ordinary card, highlighted where it was made
    const onDraft = await commentOn("banZ!ana", "Say mango instead.");
    assert.equal(await onDraft.locator(q("select-again")).count(), 0);
    // highlighted where it was made: its outline covers "banZ!ana" in the draft's preview
    await page.evaluate(() => window.getSelection().removeAllRanges());
    const id = await onDraft.getAttribute("data-comment-id");
    let covers = "";
    await until(async () => (covers = await page.evaluate((id) => {
      const hl = document.querySelector(`[data-testid="highlight"][data-comment-id="${id}"]`)?.getBoundingClientRect();
      if (!hl) return "no highlight";
      for (const el of document.querySelectorAll('[data-testid="md-preview"] [data-r]')) {
        const t = el.firstChild;
        const i = t?.data?.indexOf("banZ!ana") ?? -1;
        if (i < 0) continue;
        const rg = document.createRange();
        rg.setStart(t, i);
        rg.setEnd(t, i + 8);
        const w = rg.getBoundingClientRect();
        return Math.abs(w.left - hl.left) < 4 && Math.abs(w.width - hl.width) < 6 ? "ok" : `highlight at ${hl.left},${hl.width} word at ${w.left},${w.width}`;
      }
      return "no word";
    }, id)) === "ok", `the comment is highlighted on its words (${covers})`, 10000).catch(() => {});
    assert.equal(covers, "ok");
    const poll = w.spawnCli(["poll", file, "--timeout", "120"]);
    await page.locator(q("send")).click();
    const got = await Promise.race([poll.done, new Promise((r) => setTimeout(() => r(null), 40000))]);
    assert.ok(got, "poll printed the batch");
    const written = "\uFEFF# Fruit\r\n\r\nA banZ!ana and a mango split.\r\n\r\nSecond **bold** lineS here.\r\n";
    assert.ok(fs.readFileSync(file).equals(Buffer.from(written)), `the file holds the edit, CRLF and BOM kept: ${JSON.stringify(fs.readFileSync(file).toString())}`);
    const batch = JSON.parse(got.stdout);
    assert.equal(batch.base_sha256, sha(Buffer.from(written)));
    assert.equal(batch.untrusted_document_evidence.user_edits.length, 1);
    const anchorOf = (c) => batch.untrusted_document_evidence.anchors.find((x) => x.id === c.anchor_id);
    const byText = (t) => batch.instructions.comments.find((c) => c.text === t);
    assert.equal(anchorOf(byText("A better title.")).resolved, false, "the file comment has no place after the edit");
    assert.equal(anchorOf(byText("Make this stronger.")).resolved, false, "the comment on the earlier draft has no place");
    const cNew = byText("Say mango instead.");
    assert.equal(anchorOf(cNew).locator.source, "banZ!ana", "the comment on the edited text is on the written revision, exact");
    assert.equal(cNew.reply_with, "text_or_ops");
    const r = await w.cli(["reply", file, "--lease", batch.lease_ticket, "--json", JSON.stringify({ summary: "s", replies: batch.instructions.comments.map((c) => (c.id === cNew.id ? { comment: c.id, text: "papaya" } : { comment: c.id, decline: true, note: "No place." })) })]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    await until(async () => /A papaya and a mango split\./.test(await previewText(page)), "the preview shows the agent's change on exactly those words");
    // the handled comment shows Done with no claim about its place: no "Moved or removed", no "select again"
    const done = page.locator(`${q("comment-card")}[data-status="done"]`);
    await done.waitFor({ timeout: 15000 });
    await page.waitForTimeout(500);
    assert.doesNotMatch(await done.textContent(), /Moved or removed|no longer in the file|Select again/);
    assert.match((await page.locator(q("run-changes")).first().textContent()).trim(), /^1 place changed/);
    // the "changed" mark's region is the replaced word, not the start of its paragraph
    const markAt = () => page.evaluate(() => {
      const box = document.querySelector(".chg-tagbox")?.getBoundingClientRect();
      if (!box) return "no mark";
      for (const el of document.querySelectorAll('[data-testid="md-preview"] [data-r]')) {
        const t = el.firstChild;
        const i = t?.data?.indexOf("papaya") ?? -1;
        if (i < 0) continue;
        const rg = document.createRange();
        rg.setStart(t, i);
        rg.setEnd(t, i + 6);
        const w = rg.getBoundingClientRect();
        return Math.abs(w.left - box.left) < 3 && Math.abs(w.width - box.width) < 3 ? "ok" : `mark at ${box.left},${box.width} word at ${w.left},${w.width}`;
      }
      return "no word";
    });
    let hit = "";
    await until(async () => (hit = await markAt()) === "ok", `the changed mark sits on the replaced word (${hit})`, 15000).catch(() => {});
    assert.equal(hit, "ok");
    const revert = page.locator(`${q("revert")}:visible, ${q("revert-folded")}:visible`).first();
    await revert.waitFor({ timeout: 20000 });
    await revert.click();
    await until(async () => fs.readFileSync(file).equals(Buffer.from(written)), "Revert gives back the bytes that held the typed edit", 20000);
    assert.deepEqual(cspViolations(page.log), []);
    assert.deepEqual(page.log.errors, []);
  });
});

describe("Markdown edit: the file changed on disk before Send, and a parked draft", () => {
  const TEXT = "first para\r\n\r\nsecond para\r\n";
  let w, file, page;
  before(async () => {
    ({ w, file } = world("change.md", TEXT));
    page = await openPage(w, file);
  });
  after(async () => {
    await page?.close();
    await w?.cleanup();
  });

  test("a caret at the end of a paragraph element is that paragraph; a changed file keeps the draft and the comment and writes nothing", async () => {
    // a caret on the paragraph element's own end boundary (not in its text): Ctrl+Alt+M comments on THAT paragraph
    await page.evaluate(() => {
      const p = document.querySelector('[data-testid="md-preview"] p');
      document.querySelector('[data-testid="md-preview"]').focus();
      const s = window.getSelection();
      s.removeAllRanges();
      const r = document.createRange();
      r.setStart(p, p.childNodes.length);
      s.addRange(r);
    });
    await page.keyboard.press(process.platform === "darwin" ? "Meta+Alt+KeyM" : "Control+Alt+KeyM");
    const card = page.locator(q("comment-card")).last();
    await card.waitFor();
    assert.match(await card.textContent(), /first para/, "the caret's own paragraph");
    assert.doesNotMatch(await card.textContent(), /second para/);
    await card.locator("textarea").fill("Check this.");
    await page.waitForTimeout(400);
    await caretAt(page, "second", 6);
    await page.keyboard.type("X");
    await page.locator(q("md-source")).waitFor();
    await page.keyboard.press("Escape");
    const outside = Buffer.from("first para\n\nsecond para\n\nadded outside\n"); // LF now: the parked draft keeps CRLF
    fs.writeFileSync(file, outside);
    await page.locator(q("send")).click();
    await until(async () => /The file changed since this page loaded it, so your edit was not written/.test(await page.locator("body").textContent()), "the page says why");
    assert.ok(fs.readFileSync(file).equals(outside), "nothing written");
    assert.equal(await page.locator(q("md-draft-bar")).count(), 1, "the draft is kept");
    assert.equal(await page.locator(q("comment-card")).count(), 1, "the comment is kept");
    assert.equal(await page.locator(q("comment-card")).first().getAttribute("data-status"), "draft");
    await page.locator(q("mode-edit")).click();
    assert.match(await source(page), /secondX para/);
    await page.keyboard.press("Escape");
    // the changed file is loaded: the draft, typed on the old version, is parked (kept, not shown, not sent)
    await page.locator('[aria-label="Dismiss this message"]').first().click().catch(() => {});
    await page.waitForTimeout(1700);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.locator(q("reload-disk-early")).click({ timeout: 15000 });
    await page.locator(q("md-parked")).waitFor();
    await until(async () => /added outside/.test(await previewText(page)), "the changed file is shown");
    // typing in the fresh preview does not start a new draft over the parked one, and says so
    await caretAt(page, "added", 2);
    await page.keyboard.press("Z");
    await page.locator(q("md-type-note")).waitFor();
    assert.equal((await page.locator(q("md-type-note")).textContent()).trim(), "You have an unsent edit from an earlier version of this file. Copy or discard it before you type here.");
    assert.equal(await page.locator(q("md-parked")).count(), 1, "the parked draft stays");
    // Copy gives the parked draft with its own line endings (CRLF), not the LF of the file shown now
    await page.evaluate(() => {
      window.__copied = null;
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: (t) => ((window.__copied = t), Promise.resolve()) } });
    });
    await page.locator(`${q("md-parked")} ${q("md-copy-draft")}`).click();
    assert.equal(await page.evaluate(() => window.__copied), "first para\r\n\r\nsecondX para\r\n");
    // the parked draft's own text is shown read-only, for copying by hand when the browser blocks the clipboard
    assert.equal(await page.locator(q("md-parked-text")).evaluate((el) => el.textContent), "first para\r\n\r\nsecondX para\r\n");
    assert.ok(fs.readFileSync(file).equals(outside), "nothing written");
  });
});

describe("Markdown edit: a file with mixed line endings, and a read-only second tab", () => {
  const TEXT = "one line\nanother line\r\nlast line\n";
  let w, file, page, page2;
  before(async () => {
    ({ w, file } = world("mixed.md", TEXT));
    page = await openPage(w, file);
  });
  after(async () => {
    await page2?.close();
    await page?.close();
    await w?.cleanup();
  });

  test("mixed endings: Edit is off and a key says why, while the preview and comments still work; a read-only tab cannot type", async () => {
    assert.equal(await page.locator(q("mode-edit")).isDisabled(), true);
    assert.match(await page.locator(q("mode-edit")).getAttribute("title"), /^This file mixes line endings/);
    await caretAt(page, "another", 3);
    await page.keyboard.press("x");
    const note = page.locator(q("md-type-note"));
    await note.waitFor();
    assert.match(await note.textContent(), /^This file mixes line endings, so it opens for reading and comments only\./);
    assert.equal(await page.locator(q("md-source")).count(), 0);
    await caretAt(page, "another", 0, { k2: 7 });
    await page.mouse.move(1, 1);
    await page.keyboard.press(process.platform === "darwin" ? "Meta+Alt+KeyM" : "Control+Alt+KeyM");
    const card = page.locator(q("comment-card")).last();
    await card.waitFor();
    assert.match(await card.textContent(), /another/);
    // a second tab on the same file is read-only: a key in its preview types nothing and says why
    page2 = await openPage(w, file);
    await page2.locator(q("readonly-note")).waitFor({ timeout: 15000 });
    await caretAt(page2, "last", 2);
    await page2.keyboard.press("y");
    await page2.locator(q("md-type-note")).waitFor();
    assert.match(await page2.locator(q("md-type-note")).textContent(), /^This tab is read-only\./);
    assert.equal(await page2.locator(q("md-source")).count(), 0);
    assert.ok(fs.readFileSync(file).equals(Buffer.from(TEXT)));
  });
});

describe("Markdown edit: a whole-block offer that went stale, and a save that could not be confirmed", () => {
  const TEXT = "OTHER77\n\n*aa* bb\n";
  let w, file, page;
  before(async () => {
    ({ w, file } = world("stale.md", TEXT));
    page = await openPage(w, file);
  });
  after(async () => {
    try {
      fs.chmodSync(path.dirname(file), 0o755);
    } catch {}
    await page?.close();
    await w?.cleanup();
  });

  test("the offer is withdrawn when the preview changes under it (an agent picks up a batch); a click anchors nothing", async () => {
    // a batch waiting for an agent: one comment on the file
    const first = await charBox(page, "OTHER77");
    await drag(page, first.first, first.last);
    await page.locator(q("comment-chip")).click();
    await page.locator(q("comment-card")).last().locator("textarea").fill("Earlier comment.");
    await page.waitForTimeout(400);
    await page.locator(q("send")).click();
    await until(async () => (await page.locator(`${q("comment-card")}[data-status="sent"]`).count()) === 1, "the first batch waits");
    // a draft (the first paragraph deleted), then a selection across formatting: the whole-block offer
    await page.locator(q("mode-edit")).click();
    await page.locator(q("md-source")).fill("*aa* bb\n");
    await page.keyboard.press("Escape");
    await until(async () => !/OTHER77/.test(await previewText(page)), "Preview shows the draft");
    const a = await charBox(page, "aa");
    const b = await charBox(page, "bb");
    await drag(page, a.first, b.last);
    await page.locator(q("md-whole-block")).waitFor();
    const cards = await page.locator(q("comment-card")).count();
    // an agent picks up the earlier batch: the file is locked, the preview shows the file again
    const poll = w.spawnCli(["poll", file, "--timeout", "120"]);
    await Promise.race([poll.done, new Promise((r) => setTimeout(r, 20000))]);
    await until(async () => /OTHER77/.test(await previewText(page)), "the preview shows the file again", 20000);
    const offer = page.locator(q("md-whole-block"));
    if (await offer.count()) await offer.click();
    await page.waitForTimeout(500);
    assert.equal(await page.locator(q("comment-card")).count(), cards, "nothing was anchored");
  });
});

describe("Markdown edit: a save that could not be confirmed", () => {
  const TEXT = "one two\n";
  let w, file, page;
  before(async () => {
    ({ w, file } = world("unconfirmed.md", TEXT));
    page = await openPage(w, file);
  });
  after(async () => {
    try {
      fs.chmodSync(path.dirname(file), 0o755);
    } catch {}
    await page?.close();
    await w?.cleanup();
  });

  test("the folder cannot be flushed: the page does not report success, keeps the draft to copy and says so", async () => {
    await caretAt(page, "two", 3);
    await page.keyboard.type("!");
    await page.locator(q("md-source")).waitFor();
    await page.keyboard.press("Escape");
    fs.chmodSync(path.dirname(file), 0o300); // the owner can write and enter the folder, not list it: its flush cannot be confirmed
    await page.locator(q("send")).click();
    await until(async () => fs.readFileSync(file, "utf8") === "one two!\n", "the edit is in the file");
    fs.chmodSync(path.dirname(file), 0o755);
    const why = page.locator(q("md-parked-why"));
    await why.waitFor({ timeout: 15000 });
    assert.equal((await why.textContent()).trim(), "Your edit was written to the file, but Onionskin could not confirm the save. Check the file; your edit is kept here to copy.");
    assert.equal(await page.locator(q("md-parked-text")).evaluate((el) => el.textContent), "one two!\n");
  });
});

describe("Markdown edit (slice 9): the chip's Ask acts on the selection it captured; a confirmed save the reload contradicts keeps the draft", () => {
  /**
   * The moment the preview shows text matching `shows` (a new record or the file again), before the overlay repaints: the live caret lands
   * in the other block (`caretIn`, as it did in the review), then the old chip's Ask is clicked. What the page says afterwards is collected.
   */
  const armStaleAsk = (page, shows, caretIn) =>
    page.evaluate(
      ([shows, caretIn]) => {
        window.__askClicked = null;
        window.__said = new Set(); // every sentence the page says after the click (a later notice may replace it)
        const mo = new MutationObserver(() => {
          if (window.__askClicked) for (const m of document.body.textContent.matchAll(/(The text changed under that offer[^.]*\.|Click inside the document first[^.]*\.)/g)) window.__said.add(m[0]);
          const pv = document.querySelector('[data-testid="md-preview"]'); // (the preview element may be a new one)
          if (window.__askClicked !== null || !new RegExp(shows).test(pv?.textContent ?? "")) return;
          window.__askClicked = false;
          setTimeout(() => {
            const b = document.querySelector('[data-testid="quick-ask-chip"]');
            const t = [...document.querySelectorAll('[data-testid="md-preview"] [data-r]')].map((el) => el.firstChild).find((n) => n?.data?.includes(caretIn));
            if (t) {
              const r = document.createRange();
              r.setStart(t, 2);
              r.setEnd(t, 2);
              window.getSelection().removeAllRanges();
              window.getSelection().addRange(r);
            }
            window.__askClicked = !!b && !!t;
            b?.click();
          }, 0);
        });
        mo.observe(document.body, { childList: true, subtree: true, characterData: true });
      },
      [shows.source, caretIn],
    );
  async function staleAskOpensNothing(page) {
    await until(async () => (await page.evaluate(() => window.__askClicked)) !== null, "the preview changed", 20000);
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => window.__askClicked), true, "the old Ask button was still there to click, with the caret in the other block");
    await page.waitForTimeout(400);
    assert.equal(await page.locator(q("quick-ask-text")).count(), 0, "no Quick ask box opened (on 23793cd it opened on the other block)");
    assert.deepEqual(await page.evaluate(() => [...window.__said]), ["The text changed under that offer, so it was withdrawn and nothing was anchored."]);
  }

  test("the review's case: an agent picks up the earlier batch between the selection on the draft and the click on Ask; Ask opens nothing", async () => {
    const { w, file } = world("askpickup.md", "OTHER77\n\n*aa* bb\n");
    const page = await openPage(w, file);
    try {
      const first = await charBox(page, "OTHER77");
      await drag(page, first.first, first.last);
      await page.locator(q("comment-chip")).click();
      await page.locator(q("comment-card")).last().locator("textarea").fill("Earlier comment.");
      await page.waitForTimeout(400);
      await page.locator(q("send")).click();
      await until(async () => (await page.locator(`${q("comment-card")}[data-status="sent"]`).count()) === 1, "the first batch waits");
      await page.locator(q("mode-edit")).click();
      await page.locator(q("md-source")).fill("*aa* bb\n");
      await page.keyboard.press("Escape");
      await until(async () => !/OTHER77/.test(await previewText(page)), "Preview shows the draft");
      const a = await charBox(page, "aa");
      await drag(page, a.first, a.last);
      await page.locator(q("quick-ask-chip")).waitFor();
      await armStaleAsk(page, /OTHER77/, "OTHER77");
      const poll = w.spawnCli(["poll", file, "--timeout", "120"]);
      await Promise.race([poll.done, new Promise((r) => setTimeout(r, 20000))]);
      await staleAskOpensNothing(page);
    } finally {
      await page.close();
      await w.cleanup();
    }
  });

  test("the chip's Ask clicked after the file on screen changed (another record) and before the overlay repaints: Ask opens nothing", async () => {
    const { w, file } = world("askchip.md", "red x\n\nOTHER77\n");
    const page = await openPage(w, file);
    try {
      const a = await charBox(page, "red");
      await drag(page, a.first, a.last);
      await page.locator(q("quick-ask-chip")).waitFor();
      await armStaleAsk(page, /BLUE/, "OTHER77");
      fs.writeFileSync(file, "BLUE x\n\nOTHER77\n"); // another program saves the file
      // the page offers to load it; a click with no pointer (the selection and its chip stay as they were)
      await page.locator(q("reload-disk-early")).waitFor({ timeout: 15000 });
      await page.evaluate(() => document.querySelector('[data-testid="reload-disk-early"]').click());
      await staleAskOpensNothing(page);
    } finally {
      await page.close();
      await w.cleanup();
    }
  });

  test("Send is confirmed, but the page's own reload already shows other bytes: the draft stays, with the warning", async () => {
    const { w, file } = world("reloadother.md", "one two\n");
    const page = await openPage(w, file);
    try {
      await caretAt(page, "two", 3);
      await page.keyboard.type("!");
      await page.locator(q("md-source")).waitFor();
      await page.keyboard.press("Escape");
      let swapped = false;
      await page.route("**/api/file?*", async (route) => {
        if (!swapped && fs.readFileSync(file, "utf8") === "one two!\n") {
          swapped = true;
          fs.writeFileSync(file, "one two?\n"); // another program, after the confirmed write and before the page's reload
        }
        await route.continue();
      });
      await page.locator(q("send")).click();
      await until(async () => swapped, "the reload after Send");
      await page.locator(q("md-parked-text")).waitFor({ timeout: 15000 });
      assert.equal(await page.locator(q("md-parked-text")).evaluate((el) => el.textContent), "one two!\n");
      assert.equal(fs.readFileSync(file, "utf8"), "one two?\n");
    } finally {
      await page.close();
      await w.cleanup();
    }
  });

  test("a key typed after the confirmed receipt and before the page's reload is kept", async () => {
    const { w, file } = world("typedwindow.md", "one two\n");
    const page = await openPage(w, file);
    try {
      await caretAt(page, "two", 3);
      await page.keyboard.type("!");
      await page.locator(q("md-source")).waitFor();
      await page.keyboard.press("Escape");
      let release;
      const gate = new Promise((r) => (release = r));
      let held = false;
      await page.route("**/api/file?*", async (route) => {
        if (!held && fs.readFileSync(file, "utf8") === "one two!\n") {
          held = true;
          await gate; // the reload waits while the person types
        }
        await route.continue();
      });
      await page.locator(q("send")).click();
      await until(async () => held, "the reload after Send");
      await page.locator(q("mode-edit")).click();
      await page.locator(q("md-source")).press("End");
      await page.locator(q("md-source")).pressSequentially("Z");
      const typed = await source(page);
      release();
      await page.waitForTimeout(1500);
      const kept = (await page.locator(q("md-parked-text")).count()) ? await page.locator(q("md-parked-text")).evaluate((el) => el.textContent) : await source(page).catch(() => "");
      assert.match(typed, /Z/);
      assert.match(kept, /Z/, "the key typed in that window is still in the page");
    } finally {
      await page.close();
      await w.cleanup();
    }
  });
});

describe("Markdown edit (slice 10): the person's text while a Send is in flight", () => {
  test("an undo to the old text while Send is in flight stays an unsent edit after the answer, guarded, and a second Send writes it", async () => {
    const OLD = "one\n\ntwo\n";
    const { w, file } = world("undoinflight.md", OLD);
    const page = await openPage(w, file);
    try {
      await caretAt(page, "two", 3);
      await page.keyboard.type("!");
      await page.locator(q("md-source")).waitFor();
      let release;
      const gate = new Promise((r) => (release = r));
      let held = false;
      await page.route("**/api/send?*", async (route) => {
        if (!held) {
          held = true;
          await gate; // the Send waits while the person undoes
        }
        await route.continue();
      });
      // the page's reload after the answer is held too: the review's window (answered, not yet reloaded)
      let releaseLoad;
      const loadGate = new Promise((r) => (releaseLoad = r));
      let loadHeld = false;
      await page.route("**/api/file?*", async (route) => {
        if (!loadHeld && fs.readFileSync(file, "utf8") === "one\n\ntwo!\n") {
          loadHeld = true;
          await loadGate;
        }
        await route.continue();
      });
      const guardArmed = () =>
        page.evaluate(() => {
          const ev = new Event("beforeunload", { cancelable: true });
          window.dispatchEvent(ev);
          return ev.defaultPrevented;
        });
      await page.locator(q("send")).click();
      await until(async () => held, "the Send is in flight");
      await page.locator(q("md-source")).fill(OLD); // the undo: the textarea is the file's old text again
      release();
      await until(async () => loadHeld, "the answer came and the page asked for the file");
      await page.waitForTimeout(300);
      assert.equal(await page.locator(q("md-draft-bar")).count(), 1, "answered, not reloaded: the undo is an unsent edit");
      assert.equal(await guardArmed(), true, "answered, not reloaded: the leave guard is armed");
      releaseLoad();
      await page.waitForTimeout(1500); // the page's reload
      assert.doesNotMatch(await previewText(page), /!/, "the undo is still what the page shows");
      // the draft bar says the edit is unsent (the state pill names the batch waiting for an agent first, as for any unsent edit then)
      assert.match(await page.locator(q("md-draft-bar")).textContent(), /Your edit is not sent yet\./);
      assert.equal(await page.locator(q("md-parked")).count(), 0, "a live draft on the new record, not parked");
      assert.equal(await guardArmed(), true, "the leave guard is armed");
      await page.unroute("**/api/send?*");
      await page.unroute("**/api/file?*");
      await page.locator(q("send")).click();
      await until(async () => fs.readFileSync(file, "utf8") === OLD, "the second Send writes the old text back");
    } finally {
      await page.close();
      await w.cleanup();
    }
  });
});

describe("Markdown edit (slice 11): a kept draft's line endings; the first key in an empty file", () => {
  test("CRLF file, the whole file replaced by one line, the original restored while Send is in flight: the next Send writes CRLF", async () => {
    const OLD = "one\r\n\r\ntwo\r\n";
    const { w, file } = world("crlfkept.md", OLD);
    const page = await openPage(w, file);
    try {
      await page.locator(q("mode-edit")).click();
      await page.locator(q("md-source")).fill("x");
      let release;
      const gate = new Promise((r) => (release = r));
      let held = false;
      await page.route("**/api/send?*", async (route) => {
        if (!held) {
          held = true;
          await gate;
        }
        await route.continue();
      });
      await page.locator(q("send")).click();
      await until(async () => held, "the Send is in flight");
      await page.locator(q("md-source")).fill("one\n\ntwo\n"); // the original, restored (the textarea holds LF)
      release();
      await until(async () => fs.readFileSync(file, "utf8") === "x", "the submitted line is in the file");
      await until(async () => (await page.locator(q("md-draft-bar")).count()) === 1 && /two/.test(await previewText(page)), "the restore is an unsent edit");
      await page.waitForTimeout(1000); // the page's reload settles
      await page.unroute("**/api/send?*");
      await page.locator(q("send")).click();
      await until(async () => fs.readFileSync(file, "utf8") !== "x", "the second Send wrote");
      assert.equal(JSON.stringify(fs.readFileSync(file, "utf8")), JSON.stringify(OLD), "the original bytes, CRLF");
    } finally {
      await page.close();
      await w.cleanup();
    }
  });

  test("1.0.1: a printable key typed with Option held (the euro sign) is typed at the caret, once, with no notice, and Send writes it", async () => {
    const { w, file } = world("option.md", "one two\n");
    const page = await openPage(w, file);
    try {
      await page.evaluate(() => {
        window.__keys = [];
        document.addEventListener("keydown", (e) => window.__keys.push({ key: e.key, alt: e.altKey }), true);
      });
      await caretAt(page, "two", 0);
      // Option-Shift-2 as Chrome receives it from a US Mac keyboard: key "€" with its text, Alt and Shift held (Playwright's own keyboard
      // has no "€" key). The text would be inserted by the browser too unless the page takes the key: typed twice would show here.
      if (WEBKIT) {
        // no CDP in WebKit: the same keydown, dispatched (it carries no text the browser would insert)
        await page.evaluate(() => document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "€", code: "Digit2", altKey: true, shiftKey: true, bubbles: true, cancelable: true })));
      } else {
        const cdp = await page.context().newCDPSession(page);
        const k = { modifiers: 1 | 8, key: "€", code: "Digit2", windowsVirtualKeyCode: 50, nativeVirtualKeyCode: 50 };
        await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...k, text: "€", unmodifiedText: "@" });
        await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...k });
        await cdp.detach();
      }
      assert.ok((await page.evaluate(() => window.__keys)).some((k) => k.key === "€" && k.alt), "the browser saw € with Option held");
      await page.locator(q("md-source")).waitFor({ timeout: 5000 });
      assert.equal(await source(page), "one €two\n", "typed once, at the caret");
      assert.equal(await page.locator(q("md-edit-note")).count(), 0);
      await page.keyboard.press("Escape");
      await page.locator(q("send")).click();
      await until(async () => fs.readFileSync(file, "utf8") !== "one two\n", "written");
      assert.equal(fs.readFileSync(file, "utf8"), "one €two\n");
    } finally {
      await page.close();
      await w.cleanup();
    }
  });

  test("1.0.1: a dead key in the preview opens Edit focused at the caret (or on the selection) with nothing typed, so the composed character lands there once", async () => {
    // the browser cannot press a real dead key here: the keydown is dispatched as macOS sends it for Option-e, and the composed
    // character is then inserted as the finished composition inserts it
    const dead = (page) => page.evaluate(() => {
      const e = new KeyboardEvent("keydown", { key: "Dead", code: "KeyE", altKey: true, bubbles: true, cancelable: true });
      document.activeElement.dispatchEvent(e);
      const ta = document.querySelector('[data-testid="md-source"]');
      // read inside the same task as the keydown: the text box must already have the focus when the composition goes on
      return { prevented: e.defaultPrevented, focused: !!ta && document.activeElement === ta, value: ta?.value, sel: ta ? [ta.selectionStart, ta.selectionEnd] : null };
    });
    for (const [name, k2, after] of [["caret", null, "one étwo\n"], ["selection", 3, "one é\n"]]) {
      const { w, file } = world(`dead-${name}.md`, "one two\n");
      const page = await openPage(w, file);
      try {
        await caretAt(page, "two", 0, { k2 });
        const r = await dead(page);
        assert.deepEqual(r, { prevented: false, focused: true, value: "one two\n", sel: [4, k2 == null ? 4 : 7] }, name);
        assert.equal(await page.locator(q("md-edit-note")).count(), 0, "no notice: nothing was lost");
        await page.keyboard.insertText("é");
        assert.equal(await source(page), after, `${name}: the composed character, once`);
        await page.keyboard.press("Escape");
        await page.locator(q("send")).click();
        await until(async () => fs.readFileSync(file, "utf8") !== "one two\n", "written");
        assert.equal(fs.readFileSync(file, "utf8"), after);
      } finally {
        await page.close();
        await w.cleanup();
      }
    }
  });

  for (const [name, bytes] of [["an empty file", ""], ["a file that holds only a BOM", "﻿"]]) {
    test(`${name}: the first key typed in the preview lands, once, and Send writes it`, async () => {
      const { w, file } = world(`empty${bytes.length}.md`, bytes);
      const page = await openPage(w, file);
      try {
        await page.locator(q("md-preview")).focus();
        await page.keyboard.press("H");
        await page.locator(q("md-source")).waitFor();
        assert.equal(await source(page), "H");
        assert.equal(await page.locator(q("md-edit-note")).count(), 0, "no 'does not map to one exact place' notice");
        await page.keyboard.press("Escape");
        await page.locator(q("send")).click();
        await until(async () => fs.readFileSync(file, "utf8") !== bytes, "written");
        assert.equal(fs.readFileSync(file, "utf8"), `${bytes}H`);
      } finally {
        await page.close();
        await w.cleanup();
      }
    });
  }
});
