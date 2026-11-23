// Markdown files end to end (slice 1), in a real browser against the real server and CLI: open notes.md, select words in the preview
// with the mouse, comment, Send, the agent (`onionskin poll`, `onionskin reply`) replaces exactly that range, the preview shows it,
// Revert gives back the exact bytes; a selection across two blocks is not sent and says why. A hostile file (raw HTML, a script, a
// remote image, a javascript: link, front matter) is shown as text: the page makes no request outside its own server and runs nothing.
// Temp state, a temporary HOME and synthetic documents only.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { cspViolations, launch, makeWorld, until } from "./helpers/harness.mjs";

const q = (id) => `[data-testid="${id}"]`;
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

let br;
before(async () => {
  br = await launch();
});
after(async () => {
  await br?.close();
});

/** A world with a temporary HOME (its .local/bin first on PATH) and `text` at `name`. */
function world(name, text) {
  const w0 = makeWorld({ ONIONSKIN_NO_SOFFICE: "1" });
  const home = path.join(w0.root, "home");
  fs.mkdirSync(path.join(home, ".local", "bin"), { recursive: true });
  Object.assign(w0.env, { HOME: home, PATH: `${path.join(home, ".local", "bin")}:${w0.env.PATH}` });
  const file = w0.doc(name);
  fs.writeFileSync(file, text);
  return { w: w0, file: fs.realpathSync(file) };
}

async function openPage(w, file, requests = []) {
  const page = await br.page();
  page.on("request", (r) => requests.push(r.url()));
  page.on("dialog", (d) => (requests.push(`dialog:${d.message()}`), d.dismiss()));
  await page.goto(await w.open(file));
  await page.waitForSelector(q("md-preview"), { timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('[data-testid="state-pill"]'), null, { timeout: 30000 });
  return page;
}

/** Viewport points of the first and last character of the `nth` copy (0-based, in reading order) of `needle` in the preview's runs. */
async function charBox(page, needle, nth = 0) {
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
  assert.ok(r, `${needle} (#${nth}) is in the preview`);
  return r;
}
async function drag(page, a, b) {
  await page.mouse.move(a.left + 1, a.y);
  await page.mouse.down();
  await page.mouse.move((a.left + b.right) / 2, (a.y + b.y) / 2, { steps: 4 });
  await page.mouse.move(b.right - 1, b.y, { steps: 4 });
  await page.mouse.up();
}
const previewText = (page) => page.locator(q("md-preview")).textContent();

describe("Markdown: open, select, comment, Send, the agent's exact replacement, Revert", () => {
  const TEXT = "# Fruit\r\n\r\nA banana and a banana split.\r\n\r\nSecond **bold** line.\r\n";
  let w, file, page;
  const requests = [];
  before(async () => {
    ({ w, file } = world("notes.md", TEXT));
    page = await openPage(w, file, requests);
  });
  after(async () => {
    await page?.close();
    await w?.cleanup();
  });

  test("the preview shows the file; a selection across two blocks is not sent and says why in one sentence", async () => {
    assert.match(await previewText(page), /A banana and a banana split\./);
    assert.equal(await page.locator(`${q("md-preview")} h1`).count(), 1);
    assert.equal(await page.locator(q("review-row")).count(), 0, "no Review first for Markdown in this version");
    await drag(page, (await charBox(page, "banana", 1)).first, (await charBox(page, "bold")).last);
    const note = page.locator(q("md-refused"));
    await note.waitFor();
    assert.match(await note.textContent(), /^A comment can point at words inside one block only\./);
    await until(async () => (await page.locator(q("comment-chip")).count()) === 0, "no comment chip for it", 3000);
    await page.evaluate(() => window.getSelection().removeAllRanges());
    await note.waitFor({ state: "detached" });
  });

  test("the second banana: comment, Send, poll, reply; exactly that copy changes, the preview shows it, Revert restores the bytes", async () => {
    const poll = w.spawnCli(["poll", file, "--timeout", "120"]);
    const b = await charBox(page, "banana", 1);
    await drag(page, b.first, b.last);
    await page.locator(q("comment-chip")).click();
    const card = page.locator(q("comment-card")).last();
    await card.waitFor();
    await card.locator("textarea").fill("Say mango here.");
    await page.waitForTimeout(400);
    await page.locator(q("send")).click();
    const got = await Promise.race([poll.done, new Promise((r) => setTimeout(() => r(null), 40000))]);
    assert.ok(got, "poll printed the batch");
    const batch = JSON.parse(got.stdout); // poll prints one batch, pretty-printed, and exits
    assert.equal(batch.instructions.comments.length, 1, JSON.stringify(batch.untrusted_document_evidence.anchors));
    const a = batch.untrusted_document_evidence.anchors[0];
    const body = TEXT; // no BOM: offsets are of the text as it is
    const want = body.indexOf("banana", body.indexOf("banana") + 1);
    assert.deepEqual([a.locator.from, a.locator.to, a.locator.source, a.locator.sha256], [want, want + 6, "banana", sha(Buffer.from(TEXT))]);
    assert.equal(batch.untrusted_document_evidence.markdown.base_sha256, sha(Buffer.from(TEXT)));
    const r = await w.cli(["reply", file, "--lease", batch.lease_ticket, "--json", JSON.stringify({ summary: "s", replies: [{ comment: batch.instructions.comments[0].id, text: "mango" }] })]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const after1 = fs.readFileSync(file);
    assert.ok(after1.equals(Buffer.from(TEXT.slice(0, want) + "mango" + TEXT.slice(want + 6))), "exactly that range, CRLF kept");
    await until(async () => /A banana and a mango split\./.test(await previewText(page)), "the preview shows the change");
    const revert = page.locator(`${q("revert")}:visible, ${q("revert-folded")}:visible`).first();
    await revert.waitFor({ timeout: 20000 });
    await revert.click();
    await until(async () => fs.readFileSync(file).equals(Buffer.from(TEXT)), "Revert restores the bytes exactly", 20000);
    await until(async () => /A banana and a banana split\./.test(await previewText(page)), "the preview shows the restored text");
    assert.deepEqual(cspViolations(page.log), []);
    assert.deepEqual(page.log.errors, []);
    const origin = new URL(page.url()).origin;
    assert.deepEqual(requests.filter((u) => !u.startsWith(origin)), [], "no request outside the page's own server");
  });
});

describe("Markdown: a hostile file is shown as text", () => {
  const HOSTILE = [
    "---",
    "title: x",
    "onload: alert(1)",
    "---",
    "",
    "# Hostile",
    "",
    "<script>window.__pwned = 1; fetch('https://evil.example/s')</script>",
    "",
    '<img src="https://evil.example/raw.png" onerror="window.__pwned = 2">',
    "",
    "Inline <img src=https://evil.example/inline.png> and <b onclick=\"window.__pwned=3\">bold</b> html.",
    "",
    "![remote](https://evil.example/md.png) and [click me](javascript:window.__pwned=4) and <https://evil.example/auto>.",
    "",
    '<iframe src="https://evil.example/frame"></iframe>',
    "",
    "<style>body{background:url(https://evil.example/bg.png)}</style>",
    "",
    "Plain **strong words** end.",
    "",
  ].join("\n");
  let w, file, page;
  const requests = [];
  before(async () => {
    ({ w, file } = world("hostile.md", HOSTILE));
    page = await openPage(w, file, requests);
  });
  after(async () => {
    await page?.close();
    await w?.cleanup();
  });

  test("no request leaves the page's server, nothing runs, no element of the file is made: its HTML, images and links are literal text", async () => {
    await page.waitForTimeout(1500); // anything the file could load or run has had time to
    const origin = new URL(page.url()).origin;
    assert.deepEqual(requests.filter((u) => !u.startsWith(origin)), [], "zero network requests outside the page's own server");
    assert.ok(!requests.some((u) => /evil\.example/.test(u)));
    assert.equal(await page.evaluate(() => window.__pwned), undefined, "nothing in the file ran");
    const made = await page.evaluate(() => [...document.querySelectorAll('[data-testid="md-preview"] img, [data-testid="md-preview"] a, [data-testid="md-preview"] script, [data-testid="md-preview"] iframe, [data-testid="md-preview"] style, [data-testid="md-preview"] [onclick], [data-testid="md-preview"] [href], [data-testid="md-preview"] [src]')].length);
    assert.equal(made, 0, "no image, link, script, frame or style element, and no href, src or handler");
    const t = await previewText(page);
    for (const s of ["<script>window.__pwned = 1;", '<img src="https://evil.example/raw.png"', "![remote](https://evil.example/md.png)", "<iframe", "title: x", "<https://evil.example/auto>"]) assert.ok(t.includes(s), `shown as written: ${s}`);
    assert.ok(t.includes("click me"), "a link label is shown");
    // clicking the link does nothing
    const before1 = page.url();
    await page.locator(`${q("md-preview")} .md-link`).first().click();
    await page.waitForTimeout(300);
    assert.equal(page.url(), before1);
    assert.equal(await page.evaluate(() => window.__pwned), undefined);
    assert.deepEqual(cspViolations(page.log), []);
    assert.deepEqual(page.log.errors, []);
  });

  test("a selection across formatting the preview hides is offered as a comment on its whole block, only when pressed", async () => {
    await drag(page, (await charBox(page, "Plain")).first, (await charBox(page, "strong")).last);
    const note = page.locator(q("md-refused"));
    await note.waitFor();
    assert.match(await note.textContent(), /do not map to one exact place in the file/);
    assert.equal(await page.locator(q("comment-card")).count(), 0, "nothing is made until the button is pressed");
    await page.locator(q("md-whole-block")).click();
    const card = page.locator(q("comment-card")).last();
    await card.waitFor();
    assert.match(await card.textContent(), /Plain strong words end/);
  });
});

describe("Markdown: the preview reads in both themes", () => {
  // The preview page once kept the light paper color in the dark theme while its text took the dark theme's light ink: unreadable.
  test("the preview's text has strong contrast on its page in light and in dark", async () => {
    const { w, file } = world("theme.md", "# Title\n\nA line of body text.\n");
    try {
      const page = await openPage(w, file);
      for (const theme of ["light", "dark"]) {
        await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
        const ratio = await page.evaluate(() => {
          const lum = (css) => {
            const c = document.createElement("canvas").getContext("2d");
            c.fillStyle = css; c.fillRect(0, 0, 1, 1);
            const [r, g, b] = [...c.getImageData(0, 0, 1, 1).data].slice(0, 3).map((v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4));
            return 0.2126 * r + 0.7152 * g + 0.0722 * b;
          };
          const doc = document.querySelector(".md-doc");
          const a = lum(getComputedStyle(doc).backgroundColor), b = lum(getComputedStyle(doc.querySelector("p")).color);
          return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        });
        assert.ok(ratio >= 7, `${theme}: body text contrast on the preview page is ${ratio.toFixed(1)}, expected at least 7`);
      }
      await page.close();
    } finally {
      await w.cleanup();
    }
  });
});
