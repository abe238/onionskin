// web/src/HtmlViewer.jsx in a real browser (Chrome; ONIONSKIN_BROWSER=webkit for Playwright's WebKit, where listeners the page adds inside
// the frame never fire): the test page (e2e/helpers/html-viewer) mounts the component with render copies made by the real render worker,
// served with the app's CSP. Selection by a real mouse drag, comment and pin clicks through the page's layer, typing in edit mode and the
// blocked actions of R11 and R17, marks through scroll and resize, the notices and full-pane states, the crash flag of R6, "Hide this in
// the view", a page whose element names and ids shadow DOM methods, no navigation on any click, no listener inside the frame, no CSP
// violation.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import "../src/html-parser.js";
import * as H from "../src/html.js";
import { plainSentence, SAY } from "../web/src/html-view.js";
import { cspViolations, launch, repo, until, WEBKIT } from "./helpers/harness.mjs";
import { makePng } from "./helpers/png.mjs";
import { startViewerPage } from "./helpers/html-viewer/serve.mjs";

const MAIN = `<!doctype html><html lang="en"><head><title>Fixture</title><style>body{font:16px/1.5 Georgia,serif;margin:16px} p{margin:8px 0}</style><script>evil()</script></head>
<body><h1 id="top">Quarterly report</h1>
<p id="p1">The quick <b>brown</b> fox jumps over the lazy dog.</p>
<p id="p2">Caf&eacute; prices rose &amp; fell; &#x1F600; smile here.</p>
<p id="p3">Read <a href="https://example.com/more">more here</a> or <a href="#p1">jump up</a> now.</p>
<div style="height:1400px"></div>
<p id="p4">Far down text to mark.</p><div style="height:600px"></div>
<img src="https://example.com/x.png" alt="remote picture"></body></html>`;
const SCRIPTS_ONLY = "<!doctype html><html><head><title>App</title></head><body><div id=root></div><script>render()</script></body></html>";
const HEAVY = `<!doctype html><html><head><style>${Array.from({ length: 201 }, (_, i) => `.c${i}:has(b){color:red}`).join("")}</style></head><body><p>Heavy styles here.</p></body></html>`;
const CLOBBER = `<!doctype html><html><head></head><body>
<img id="getSelection" name="getSelection" src="pic.png" alt="a"><img name="body" id="documentElement" src="pic.png" alt="b">
<form id="getAttribute" name="querySelectorAll"><input id="elementFromPoint" name="getRangeAt" value="v"><input name="parentNode"></form>
<p id="nodeType">Clobber text to select here.</p><p id="firstChild">Second clobber line.</p></body></html>`;

// the next version of MAIN: a paragraph added first (every id moves), p2's text rewritten, the rest as it was
const MAIN2 = MAIN.replace('<h1 id="top">', '<p id="new">A new first line.</p><h1 id="top">').replace("Caf&eacute; prices rose &amp; fell; &#x1F600; smile here.", "Prices were rewritten by the agent.");
const unstrip = (copy) =>
  copy
    .replace('<body data-osk-id="3">', '<body data-osk-id="3"><img name="body" alt=""><img name="createRange" alt=""><img name="elementFromPoint" alt=""><img name="querySelectorAll" alt=""><img name="createTreeWalker" alt="">')
    .replace('<div data-osk-id="8" id="getAttribute">', '<form data-osk-id="8" id="getAttribute" name="getSelection">')
    .replace('<input data-osk-id="9" id="elementFromPoint"', '<input data-osk-id="9" id="elementFromPoint" name="getAttribute"')
    .replace('<input data-osk-id="10" disabled="">', '<input data-osk-id="10" name="parentNode" disabled="">')
    .replace("</div>\n<p", "</form>\n<p");
const FX = path.join(repo, "test", "fixtures", "html");
/** The fixtures whose render copy has text to show (others are refused at read or are the scripts-only case). */
const FIXTURES = fs.readdirSync(FX).filter((f) => {
  if (!/\.html?$/.test(f)) return false;
  try {
    H.readHtml(fs.readFileSync(path.join(FX, f)));
    return true;
  } catch {
    return false;
  }
});
const read = (src) => H.readHtml(Buffer.from(src));
/** Source ids for the fixture: the element with id attribute `htmlId`, and the text node holding `needle`. */
const elId = (r, htmlId) => r.nodes.find((x) => x.attrs?.some((a) => a.name === "id" && a.value === htmlId)).__id;
const textId = (r, needle) => r.nodes.find((x) => x.nodeName === "#text" && x.value.includes(needle)).__id;

let demo;
let dir;
let b;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "da-hvp-"));
  fs.writeFileSync(path.join(dir, "pic.png"), makePng(40, 20, () => [200, 80, 40]));
  demo = await startViewerPage({
    main: { bytes: Buffer.from(MAIN), fileDir: dir },
    scripts: { bytes: Buffer.from(SCRIPTS_ONLY), fileDir: dir },
    heavy: { bytes: Buffer.from(HEAVY), fileDir: dir },
    clobber: { bytes: Buffer.from(CLOBBER), fileDir: dir },
    // the same copy with what the render strips put back (a named form with named controls, named images), so the frame's own properties
    // really are shadowed: the positive control for the prototype rule (R4)
    "clobber-raw": { bytes: Buffer.from(CLOBBER), fileDir: dir, transform: unstrip },
    main2: { bytes: Buffer.from(MAIN2), fileDir: dir },
  });
  for (const f of FIXTURES) demo.add(`fx:${f}`, { bytes: fs.readFileSync(path.join(FX, f)), fileDir: FX });
  b = await launch();
});
after(async () => {
  const v = b ? cspViolations(b.log) : [];
  await b?.close();
  demo?.close();
  fs.rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(v, [], "no CSP violation in any page of this file");
});

async function open(name, query = "") {
  const page = await b.page();
  await page.goto(demo.url(name, query));
  await page.waitForFunction(() => window.__h && document.querySelector('[data-testid="html-viewer"]')?.dataset.phase === "ready", null, { timeout: 20000 });
  return page;
}
/** Page coordinates of characters [i, j) of the first text in the frame element `sel` that holds `needle` (i, j relative to needle). */
const textBox = (page, sel, needle, i = 0, j = needle.length) =>
  page.evaluate(([sel, needle, i, j]) => {
    const f = document.querySelector('[data-testid="html-frame"]');
    const d = f.contentDocument;
    // through the page's prototypes: the positive-control page shadows the frame document's own methods
    const el = Document.prototype.querySelector.call(d, sel);
    const w = Document.prototype.createTreeWalker.call(d, el, 4);
    for (let t = w.nextNode(); t; t = w.nextNode()) {
      const k = t.data.indexOf(needle);
      if (k < 0) continue;
      const r = Document.prototype.createRange.call(d);
      r.setStart(t, k + i);
      r.setEnd(t, k + j);
      const b = r.getBoundingClientRect();
      const fr = f.getBoundingClientRect();
      return { x: b.left + fr.left + f.clientLeft, y: b.top + fr.top + f.clientTop, w: b.width, h: b.height };
    }
    return null;
  }, [sel, needle, i, j]);
const frameHtml = (page, sel) => page.evaluate((sel) => document.querySelector('[data-testid="html-frame"]').contentDocument.querySelector(sel).innerHTML, sel);
const ev = (page) => page.evaluate(() => JSON.parse(JSON.stringify(window.__ev)));
/** The last selection told once no new one came for 400 ms (a drag tells the selection along the way). */
async function settledSelection(page) {
  let n = -1;
  for (let i = 0; i < 60; i++) {
    const now = (await ev(page)).sel.length;
    if (now === n && now > 0) break;
    n = now;
    await page.waitForTimeout(400);
  }
  return (await ev(page)).sel.at(-1);
}

/** A drag with the button held: CDP in Chromium (Playwright's own move with a button down hangs over a sandboxed frame: spike S1). */
async function drag(page, x0, y0, x1, y1) {
  if (!WEBKIT) {
    const cdp = await page.context().newCDPSession(page);
    const send = (type, x, y, buttons) => cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons, clickCount: 1 });
    await send("mousePressed", x0, y0, 1);
    for (let k = 1; k <= 10; k++) await send("mouseMoved", x0 + ((x1 - x0) * k) / 10, y0 + ((y1 - y0) * k) / 10, 1);
    await send("mouseReleased", x1, y1, 0);
    await cdp.detach();
  } else {
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    await page.mouse.move(x1, y1, { steps: 10 });
    await page.mouse.up();
  }
}

test("a real mouse drag gives the page anchor: one text node, then across an inline element", async () => {
  const r = read(MAIN);
  const page = await open("main");
  // inside one text node: "lazy"
  const lz = await textBox(page, "#p1", "lazy");
  await drag(page, lz.x + 1, lz.y + lz.h / 2, lz.x + lz.w + 0.5, lz.y + lz.h / 2);
  const s1 = await settledSelection(page);
  assert.equal(s1.quote, "lazy");
  assert.equal(s1.location.nodeId, textId(r, "lazy"));
  assert.equal(r.nodes[s1.location.nodeId].value.slice(s1.location.start, s1.location.end), "lazy");
  // entity and astral text: offsets index the source node's decoded text
  const sm = await textBox(page, "#p2", "smile");
  await drag(page, sm.x + 1, sm.y + sm.h / 2, sm.x + sm.w + 0.5, sm.y + sm.h / 2);
  const s2 = await settledSelection(page);
  assert.equal(r.nodes[s2.location.nodeId].value.slice(s2.location.start, s2.location.end), "smile");
  assert.equal(s2.location.start, "Caf\u00e9 prices rose & fell; \u{1F600} ".length);
  // across <b>: the paragraph, offsets in its source text
  const q = await textBox(page, "#p1", "quick");
  const f = await textBox(page, "#p1", "fox");
  await drag(page, q.x + 1, q.y + q.h / 2, f.x + f.w + 0.5, f.y + f.h / 2);
  const s3 = await settledSelection(page);
  assert.equal(s3.quote, "quick brown fox");
  assert.equal(s3.location.nodeId, elId(r, "p1"));
  assert.deepEqual([s3.location.start, s3.location.end], [4, 19]);
  assert.equal(s3.prefix, "The ");
  // the handle reads the same, and its rects sit on the words
  const sel = await page.evaluate(() => window.__h.selection());
  assert.equal(sel.quote, "quick brown fox");
  const rects = await page.evaluate((loc) => window.__h.rectsFor(loc).map((r) => ({ x: r.x, y: r.y, w: r.width })), s3.location);
  assert.ok(rects.length >= 1 && Math.abs(rects[0].x - q.x) < 2 && Math.abs(rects[0].y - q.y) < 2, `rects on the words: ${JSON.stringify(rects)} vs ${JSON.stringify(q)}`);
  await page.close();
});

test("comment mode: the page's layer outlines the element under the pointer and a click gives its element anchor; pin mode gives fractions", async () => {
  const r = read(MAIN);
  const page = await open("main", "mode=comment");
  const p2 = await textBox(page, "#p2", "prices");
  await page.mouse.move(p2.x + 3, p2.y + p2.h / 2);
  await page.waitForSelector('[data-testid="html-hover"]');
  assert.equal(Number(await page.getAttribute('[data-testid="html-hover"]', "data-node")), elId(r, "p2"));
  await page.mouse.click(p2.x + 3, p2.y + p2.h / 2);
  const pick = await until(async () => (await ev(page)).picks.at(-1), "a pick");
  assert.equal(pick.mode, "comment");
  assert.equal(pick.anchor.hitKind, "element");
  assert.equal(pick.anchor.location.nodeId, elId(r, "p2"));
  assert.match(pick.anchor.quote, /^Caf\u00e9 prices rose & fell/);
  // the frame's own selection did not move: the click landed on the page's layer
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid="html-frame"]').contentDocument.getSelection().toString()), "");
  await page.evaluate(() => window.__setMode("pin"));
  const h1 = await textBox(page, "#top", "Quarterly");
  await page.mouse.click(h1.x + 2, h1.y + h1.h / 2);
  const pin = await until(async () => (await ev(page)).picks.find((p) => p.mode === "pin"), "a pin pick");
  assert.equal(pin.anchor.location.nodeId, elId(r, "top"));
  assert.ok(pin.pin.xFrac >= 0 && pin.pin.xFrac < 0.2 && pin.pin.yFrac > 0.2 && pin.pin.yFrac < 0.8, JSON.stringify(pin.pin));
  // the wheel over the layer scrolls the frame
  await page.mouse.wheel(0, 400);
  await until(() => page.evaluate(() => document.querySelector('[data-testid="html-frame"]').contentDocument.scrollingElement.scrollTop > 100), "the frame scrolled under the layer");
  await page.close();
});

test("edit mode: typing in a paragraph gives one pending edit on its text node, and undo puts it back", async () => {
  const r = read(MAIN);
  const page = await open("main");
  const lz = await textBox(page, "#p1", "lazy", 2, 3);
  await page.mouse.click(lz.x + 1, lz.y + lz.h / 2);
  await until(() => page.evaluate(() => document.querySelector('[data-testid="html-frame"]').contentDocument.querySelector("#p1").hasAttribute("contenteditable")), "the paragraph became editable");
  await page.keyboard.type("XY");
  const list = await until(async () => (await ev(page)).edits.at(-1)?.find((e) => e.newText.includes("XY")) && (await ev(page)).edits.at(-1), "a pending edit");
  assert.equal(list.length, 1);
  const e = list[0];
  const id = textId(r, "lazy");
  assert.equal(e.nodeId, id);
  assert.equal(e.newText.replace("XY", ""), r.nodes[id].value, "the source text with XY typed in it");
  assert.match(e.versionSha, /^[0-9a-f]{64}$/);
  assert.match(e.baseTextHash, /^[0-9a-f]{14}$/);
  assert.equal("baseText" in e, false, "the base text stays in the page");
  assert.deepEqual(await page.evaluate(() => window.__h.edits().length), 1);
  await page.evaluate(() => window.__h.undoEdit());
  assert.deepEqual(await page.evaluate(() => window.__h.edits()), []);
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid="html-frame"]').contentDocument.querySelector("#p1").textContent), "The quick brown fox jumps over the lazy dog.");
  // a link's text is not typed in: a click there says why
  const more = await textBox(page, "#p3", "more");
  await page.mouse.click(more.x + more.w / 2, more.y + more.h / 2); // inside the link's text, not on its edge (that is the text before it)
  await page.waitForSelector('[data-testid="html-hint"]');
  assert.equal(await page.textContent('[data-testid="html-hint"]'), SAY.readOnlyPart);
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid="html-frame"]').contentDocument.querySelector("#p3 [data-osk-href]").isContentEditable), false);
  // read-only during a run: no element becomes editable
  await page.evaluate(() => window.__setReadOnly(true));
  await page.waitForSelector('[data-testid="html-note-running"]');
  assert.equal(await page.textContent('[data-testid="html-note-running"]'), SAY.running);
  const dog = await textBox(page, "#p1", "dog", 1, 2);
  await page.mouse.click(dog.x + 1, dog.y + dog.h / 2);
  await page.keyboard.type("Q");
  await page.waitForTimeout(400);
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid="html-frame"]').contentDocument.querySelector("#p1").textContent), "The quick brown fox jumps over the lazy dog.");
  assert.deepEqual(await page.evaluate(() => window.__h.edits()), []);
  await page.close();
});

test("Enter, a multi-line paste and deleting an element call the blocked action with the element's anchor and leave the frame as it was", async () => {
  const r = read(MAIN);
  const page = await open("main");
  if (!WEBKIT) await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: demo.base });
  const before2 = await frameHtml(page, "#p2");
  const pr = await textBox(page, "#p2", "prices", 3, 4);
  await page.mouse.click(pr.x + 1, pr.y + pr.h / 2);
  await until(() => page.evaluate(() => document.querySelector('[data-testid="html-frame"]').contentDocument.querySelector("#p2").hasAttribute("contenteditable")), "editable");
  await page.keyboard.press("Enter");
  const b1 = await until(async () => (await ev(page)).blocked[0], "the blocked action for Enter");
  assert.equal(b1.anchor.location.nodeId, elId(r, "p2"));
  assert.equal(b1.anchor.hitKind, "element");
  assert.ok(["newline", "structure"].includes(b1.reason), b1.reason);
  await until(async () => (await frameHtml(page, "#p2")) === before2, "the paragraph as it was after Enter");
  // multi-line paste
  await page.evaluate(() => navigator.clipboard.writeText("L1\nL2"));
  await page.keyboard.press("ControlOrMeta+V");
  await until(async () => (await ev(page)).blocked.length >= 2, "the blocked action for the paste");
  await until(async () => (await frameHtml(page, "#p2")) === before2, "the paragraph as it was after the paste");
  assert.deepEqual(await page.evaluate(() => window.__h.edits()), [], "no edit from either");
  // deleting across <b>: the element would go
  const before1 = await frameHtml(page, "#p1");
  const q = await textBox(page, "#p1", "quick", 1, 2);
  await page.mouse.click(q.x + 1, q.y + q.h / 2);
  await until(() => page.evaluate(() => document.querySelector('[data-testid="html-frame"]').contentDocument.querySelector("#p1").hasAttribute("contenteditable")), "p1 editable");
  for (let k = 0; k < 14; k++) await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Backspace");
  const b3 = await until(async () => (await ev(page)).blocked.find((x) => x.anchor.location.nodeId === elId(r, "p1")), "the blocked action for deleting <b>");
  assert.equal(b3.reason, "structure");
  await until(async () => (await frameHtml(page, "#p1")) === before1, "p1 as it was");
  assert.deepEqual(await page.evaluate(() => window.__h.edits()), []);
  await page.close();
});

// A wheel right after the view is ready, while the frame is still inert (its parts are being read: on a large page, or a loaded machine,
// that pass outlasts "ready"): the browser gives an inert frame no wheel, so the box under it takes the wheel and scrolls the frame; the
// app's scrollTo works then too (the flaky run of 4d2b2fc: {"sy":0}, a wheel that reached the frame while it was inert). The frame is put
// in that state here exactly as html-frame.js does (frame.inert) so the test does not depend on how fast this machine reads the parts.
test("a wheel and a scrollTo while the frame is still inert after opening scroll the frame; nothing is lost", async () => {
  const r = read(MAIN);
  const page = await open("main");
  const st = () => page.evaluate(() => {
    const f = document.querySelector('[data-testid="html-frame"]');
    return { inert: f.inert, sy: f.contentDocument.scrollingElement.scrollTop };
  });
  await page.evaluate(() => (document.querySelector('[data-testid="html-frame"]').inert = true));
  const fb = await page.locator('[data-testid="html-frame"]').boundingBox();
  await page.mouse.move(fb.x + 200, fb.y + 200);
  await page.mouse.wheel(0, 600);
  await until(async () => (await st()).sy > 0, "the wheel scrolled the inert frame", 10000);
  assert.equal((await st()).inert, true);
  await page.evaluate(() => (document.querySelector('[data-testid="html-frame"]').contentDocument.scrollingElement.scrollTop = 0));
  assert.equal(await page.evaluate((loc) => window.__h.scrollTo(loc, { flash: false }), { nodeId: elId(r, "p4") }), true);
  assert.ok((await st()).sy > 0, "scrollTo while inert");
  // typing still cannot reach the copy while it is inert
  await page.keyboard.type("x");
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid="html-frame"]').contentDocument.body.textContent.includes("xFar")), false);
  await page.evaluate(() => (document.querySelector('[data-testid="html-frame"]').inert = false));
  await page.close();
});

test("marks stay on their text when the frame scrolls and the window is resized", async () => {
  const r = read(MAIN);
  const page = await open("main");
  const loc = { nodeId: textId(r, "Far down"), start: 4, end: 8 };
  await page.evaluate((loc) => window.__setMarks([{ id: "c1", n: 1, kind: "text", status: "draft", location: loc }, { id: "c2", n: 2, kind: "pin", status: "draft", location: { nodeId: loc.nodeId }, pin: { xFrac: 0.5, yFrac: 0.5 } }]), { ...loc, nodeId: loc.nodeId });
  // both read in the same pass: a wheel scroll lands a moment after the call returns
  const check = async (what) => {
    let seen = null;
    await until(async () => {
      const t = await textBox(page, "#p4", "down");
      const b = await page.locator('[data-testid="highlight"]').first().boundingBox().catch(() => null);
      seen = { b, t };
      return b && Math.abs(b.x - t.x) < 1.5 && Math.abs(b.y - t.y) < 1.5 && Math.abs(b.width - t.w) < 2;
    }, `the highlight on "down" (${what})`, 5000).catch(async (e) =>
      assert.fail(`${e.message}: ${JSON.stringify(seen)} ${await page.evaluate((loc) => { const f = document.querySelector('[data-testid="html-frame"]'); const se = f.contentDocument.scrollingElement; return JSON.stringify({ sy: se.scrollTop, sh: se.scrollHeight, ch: se.clientHeight, fTop: f.getBoundingClientRect().top, rects: window.__h.rectsFor(loc).map((r) => Math.round(r.y)), items: document.querySelectorAll('[data-testid="highlight"]').length }); }, loc)}`)
    );
  };
  // far down: not drawn until scrolled into view
  assert.equal(await page.locator('[data-testid="highlight"]').count(), 0);
  const fb = await page.locator('[data-testid="html-frame"]').boundingBox();
  await page.mouse.move(fb.x + 200, fb.y + 200);
  await page.mouse.wheel(0, 1300);
  await check("after scrolling");
  await page.mouse.wheel(0, -120);
  await check("after scrolling back a little");
  // a wheel scroll animates for a while: let it end before the resize, or it lands after scrollTo below
  let y0 = -1;
  await until(async () => {
    const y = await page.evaluate(() => document.querySelector('[data-testid="html-frame"]').contentDocument.scrollingElement.scrollTop);
    const still = y === y0;
    y0 = y;
    return still;
  }, "the wheel scroll ended");
  const tall = await page.evaluate(() => document.querySelector('[data-testid="html-frame"]').clientHeight);
  await page.setViewportSize({ width: 900, height: 700 });
  await until(() => page.evaluate((h) => document.querySelector('[data-testid="html-frame"]').clientHeight < h, tall), "the frame laid out at the new size");
  // the frame got shorter: bring the words back into view through the handle, then the mark must sit on them again
  assert.equal(await page.evaluate((loc) => window.__h.scrollTo(loc, { flash: false }), loc), true);
  await check("after a resize");
  assert.equal(await page.locator('[data-testid="pin-mark"]').count(), 1);
  await page.locator('[data-testid="pin-mark"]').click({ force: true });
  await until(async () => (await ev(page)).marks.includes("c2"), "the pin's click reached the host");
  // scrollTo brings a place into view and flashes it
  assert.equal(await page.evaluate((loc) => window.__h.scrollTo(loc), { nodeId: elId(r, "top") }), true);
  await page.waitForSelector('[data-testid="html-flash"]');
  await page.close();
});

test("the notices come from the copy's stats: scripts off, remote count, styles too heavy, first run; plain view and the scripts-only message", async () => {
  const page = await open("main");
  const meta = await page.evaluate(() => fetch(`/meta?f=main`).then((x) => x.json()));
  assert.ok(meta.stats.scripts > 0 && meta.stats.remote > 0);
  assert.equal(await page.textContent('[data-testid="html-note-scripts"]'), SAY.scripts);
  assert.equal(await page.textContent('[data-testid="html-note-remote"]'), SAY.remote(meta.stats.remote));
  assert.equal(await page.locator('[data-testid="html-note-heavy"]').count(), 0);
  assert.equal(await page.locator('[data-testid="html-note-folder"]').count(), 0);
  assert.equal(await page.textContent('[data-testid="html-note-first-run"] span'), SAY.firstRun);
  assert.equal(await page.textContent('[data-testid="html-label"]'), SAY.label);
  const frameBorder = await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="html-frame"]')).borderTopWidth);
  assert.equal(frameBorder, "1px");
  await page.click('[data-testid="html-first-run-ok"]');
  assert.equal(await page.locator('[data-testid="html-note-first-run"]').count(), 0);
  await page.close();
  const again = await open("main");
  assert.equal(await again.locator('[data-testid="html-note-first-run"]').count(), 0, "dismissed once, gone for good");
  await again.close();
  const heavy = await open("heavy");
  assert.equal(await heavy.textContent('[data-testid="html-note-heavy"]'), SAY.heavy);
  await heavy.close();
  const plain = await open("main", "plain=reparse");
  assert.equal(await plain.textContent('[data-testid="html-note-plain"]'), plainSentence("reparse"));
  assert.ok((await plain.evaluate(() => document.querySelector('[data-testid="html-frame"]').contentDocument.body.textContent)).includes("Quarterly report"));
  await plain.close();
  const page2 = await b.page();
  await page2.goto(demo.url("scripts"));
  await page2.waitForSelector('[data-testid="html-full-scripts"]');
  assert.equal(await page2.textContent('[data-testid="html-full-scripts"] p'), SAY.scriptsOnly);
  await page2.close();
  // dark theme: the notices and label read in the dark tokens (no hard-coded light colors)
  const dark = await open("main", "theme=dark");
  const ink = await dark.evaluate(() => getComputedStyle(document.querySelector('[data-testid="html-label"]')).color);
  assert.notEqual(ink, "rgb(0, 0, 0)");
  await dark.close();
});

test("the crash flag (R6): found set for this version at start, the view asks for the plain copy and shows why; without a plain copy, a retry", async () => {
  const meta = await (await fetch(`${demo.base}/meta?f=main`)).json();
  const page = await b.page();
  await page.addInitScript((v) => localStorage.setItem("onionskin.html.crash", JSON.stringify({ [v]: Date.now() })), meta.version);
  await page.goto(demo.url("main"));
  await page.waitForFunction(() => window.__h && document.querySelector('[data-testid="html-viewer"]')?.dataset.phase === "ready", null, { timeout: 20000 });
  assert.deepEqual((await ev(page)).plainAsked, ["crash"]);
  assert.equal(await page.textContent('[data-testid="html-note-plain"] span'), plainSentence("crash"));
  await page.click('[data-testid="html-full-again"]');
  await until(async () => (await ev(page)).plainAsked.includes(null), "the host asked for the full view");
  await page.waitForFunction(() => document.querySelector('[data-testid="html-viewer"]')?.dataset.phase === "ready" && !document.querySelector('[data-testid="html-note-plain"]'));
  await page.close();
  const p2 = await b.page();
  await p2.addInitScript((v) => sessionStorage.getItem("once") || (sessionStorage.setItem("once", "1"), localStorage.setItem("onionskin.html.crash", JSON.stringify({ [v]: Date.now() }))), meta.version);
  await p2.goto(demo.url("main", "noplain=1"));
  await p2.waitForSelector('[data-testid="html-full-crashed"]');
  assert.equal(await p2.textContent('[data-testid="html-full-crashed"] p'), `${SAY.crashed}.`);
  await p2.click('[data-testid="html-retry"]');
  await p2.waitForFunction(() => document.querySelector('[data-testid="html-viewer"]')?.dataset.phase === "ready");
  await until(() => p2.evaluate((v) => !JSON.parse(localStorage.getItem("onionskin.html.crash") || "{}")[v], meta.version), "the flag cleared after the load");
  // a normal load sets and clears it: nothing left behind
  await p2.reload();
  await p2.waitForFunction(() => document.querySelector('[data-testid="html-viewer"]')?.dataset.phase === "ready");
  await until(() => p2.evaluate(() => localStorage.getItem("onionskin.html.crash") === "{}"), "no flag after a good load");
  await p2.close();
});

test("Hide this in the view: hides the clicked element in the view only, and it can be shown again", async () => {
  const r = read(MAIN);
  const page = await open("main", "mode=comment");
  const p3 = await textBox(page, "#p3", "Read");
  await page.mouse.click(p3.x + 2, p3.y + p3.h / 2);
  await page.waitForSelector('[data-testid="html-hide"]');
  assert.equal(await page.textContent('[data-testid="html-hide"]'), SAY.hide);
  await page.click('[data-testid="html-hide"]');
  const display = () => page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="html-frame"]').contentDocument.querySelector("#p3")).display);
  assert.equal(await display(), "none");
  assert.deepEqual((await page.evaluate(() => window.__h.hidden())).map((h) => h.nodeId), [elId(r, "p3")]);
  assert.equal(await page.textContent('[data-testid="html-show-hidden"]'), SAY.showHidden(1));
  const vs = await page.evaluate(() => window.__h.getViewState());
  assert.deepEqual(vs.hidden.map((h) => h.nodeId), [elId(r, "p3")], "the view state carries it");
  await page.keyboard.press("Tab"); // the button is reachable by keyboard
  await page.click('[data-testid="html-show-hidden"]');
  assert.equal(await display(), "block");
  assert.equal(await page.locator('[data-testid="html-note-hidden"]').count(), 0);
  await page.close();
});

test("element names and ids that shadow DOM methods do not break selection, clicks or typing", async () => {
  const r = read(CLOBBER);
  const page = await open("clobber");
  // the copy keeps the ids (they are shown), and drops `name` (R4)
  assert.ok(await page.evaluate(() => !!document.querySelector('[data-testid="html-frame"]').contentDocument.querySelector("img#getSelection")));
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid="html-frame"]').contentDocument.querySelectorAll("[name]").length), 0);
  const t = await textBox(page, "#nodeType", "select");
  await drag(page, t.x + 1, t.y + t.h / 2, t.x + t.w + 0.5, t.y + t.h / 2);
  const s = await settledSelection(page);
  assert.equal(s.quote, "select");
  assert.equal(s.location.nodeId, textId(r, "Clobber text"));
  const c = await textBox(page, "#firstChild", "clobber", 2, 3);
  await page.mouse.click(c.x + 1, c.y + c.h / 2);
  await until(() => page.evaluate(() => document.querySelector('[data-testid="html-frame"]').contentDocument.querySelector("#firstChild").isContentEditable), "editable");
  await page.keyboard.type("Z");
  const ed = await until(async () => (await ev(page)).edits.at(-1)?.[0], "an edit").catch(async (e) =>
    assert.fail(`${e.message}: ${await page.evaluate(() => { const d = document.querySelector('[data-testid="html-frame"]').contentDocument; const s = d.getSelection(); return JSON.stringify({ text: d.querySelector("#firstChild").textContent, ce: [...d.querySelectorAll("[contenteditable]")].map((x) => x.id), sel: [s.anchorNode?.nodeName, s.anchorOffset, s.isCollapsed, s.toString()], hint: document.querySelector('[data-testid="html-hint"]')?.textContent || null }); })}`)
  );
  assert.equal(ed.nodeId, textId(r, "Second clobber"));
  await page.evaluate(() => window.__setMode("comment"));
  await page.mouse.click(t.x + 2, t.y + t.h / 2);
  const pick = await until(async () => (await ev(page)).picks.at(-1), "a pick");
  assert.equal(pick.anchor.location.nodeId, elId(r, "nodeType"));
  assert.deepEqual(b.log.errors.filter((m) => !/ResizeObserver/.test(m)), [], "no page error");
  await page.close();
});

test("nothing in the frame navigates or opens a page: plain, modifier and middle clicks on link text, in edit and comment modes", async () => {
  for (const mode of ["edit", "comment"]) {
    const page = await open("main", `mode=${mode}`);
    const top = page.url();
    const popups = [];
    const onPage = (p) => popups.push(p);
    page.context().on("page", onPage);
    for (const needle of ["more", "jump"]) {
      const l = await textBox(page, "#p3", needle);
      for (const opts of [{}, { modifiers: ["Meta"] }, { modifiers: ["Shift"] }, { button: "middle" }]) await page.mouse.click(l.x + 3, l.y + l.h / 2, opts);
    }
    await page.waitForTimeout(800);
    page.context().off("page", onPage);
    assert.equal(popups.length, 0, `${mode}: no new page`);
    assert.equal(page.url(), top, `${mode}: the page stayed`);
    assert.equal(page.frames().find((f) => f !== page.mainFrame())?.url(), "about:srcdoc", `${mode}: the frame stayed`);
    assert.equal(await page.evaluate(() => document.querySelector('[data-testid="html-frame"]').contentDocument.querySelectorAll("[href]").length), 0, "no link target in the copy");
    for (const p of popups) await p.close();
    await page.close();
  }
});

test("no listener is registered inside the frame (Chromium: DevTools listener lookup on the frame's window, document and elements)", { skip: WEBKIT && "the listener lookup is a Chromium DevTools call; the static check in test/html-view.test.js covers both" }, async () => {
  const page = await open("main");
  // exercise every path first: selection, typing, comment and pin clicks, hide, marks
  const lz = await textBox(page, "#p1", "lazy");
  await drag(page, lz.x + 1, lz.y + lz.h / 2, lz.x + lz.w - 1, lz.y + lz.h / 2);
  await page.mouse.click(lz.x + 2, lz.y + lz.h / 2);
  await page.keyboard.type("k");
  await page.evaluate(() => window.__setMode("comment"));
  await page.mouse.click(lz.x + 2, lz.y + lz.h / 2);
  await page.evaluate(() => window.__setMarks([{ id: "m", n: 1, kind: "text", location: window.__ev.picks.at(-1).anchor.location }]));
  await page.waitForTimeout(300);
  const cdp = await page.context().newCDPSession(page);
  const counts = {};
  for (const [name, expr] of [
    ["window", 'document.querySelector("[data-testid=html-frame]").contentWindow'],
    ["document", 'document.querySelector("[data-testid=html-frame]").contentDocument'],
    ["html", 'document.querySelector("[data-testid=html-frame]").contentDocument.documentElement'],
    ["body", 'document.querySelector("[data-testid=html-frame]").contentDocument.body'],
    ["p1", 'document.querySelector("[data-testid=html-frame]").contentDocument.querySelector("#p1")'],
  ]) {
    const { result } = await cdp.send("Runtime.evaluate", { expression: expr });
    const { listeners } = await cdp.send("DOMDebugger.getEventListeners", { objectId: result.objectId, depth: name === "document" ? -1 : 0, pierce: true });
    counts[name] = listeners.length;
  }
  // a positive control: the page's own layer in comment mode does have listeners (React's root and the wheel listener)
  const { result: own } = await cdp.send("Runtime.evaluate", { expression: 'document.querySelector("[data-testid=html-catch]")' });
  const ownCount = (await cdp.send("DOMDebugger.getEventListeners", { objectId: own.objectId })).listeners.length;
  await cdp.detach();
  assert.deepEqual(counts, { window: 0, document: 0, html: 0, body: 0, p1: 0 });
  assert.ok(ownCount >= 1, `the probe sees listeners where there are some (${ownCount})`);
  await page.close();
});

test("every fixture: the frame's text, as this browser parsed the copy, lines up with the copy's texts array (the anchor's foundation)", async () => {
  const page = await b.page();
  let checked = 0;
  for (const f of FIXTURES) {
    const meta = await (await fetch(`${demo.base}/meta?f=${encodeURIComponent(`fx:${f}`)}`)).json();
    if (meta.plain || meta.stats.bodyText === 0) continue;
    const r = H.readHtml(fs.readFileSync(path.join(FX, f)));
    const want = meta.texts.map((src) => (src >= 0 ? r.nodes[src].value : null));
    await page.goto(demo.url(`fx:${f}`));
    await page.waitForFunction(() => window.__h && document.querySelector('[data-testid="html-viewer"]')?.dataset.phase === "ready", null, { timeout: 20000 });
    // the browser's own text nodes, a run of adjacent ones as one (a long text may be split), in tree order
    const got = await page.evaluate(() => {
      const d = document.querySelector('[data-testid="html-frame"]').contentDocument;
      const out = [];
      const w = d.createTreeWalker(d, 4);
      for (let t = w.nextNode(); t; t = w.nextNode()) {
        if (t.previousSibling && t.previousSibling.nodeType === 3) out[out.length - 1] += t.data;
        else out.push(t.data);
      }
      return out;
    });
    assert.equal(got.length, want.length, `${f}: text slots`);
    want.forEach((v, n) => v !== null && assert.equal(got[n], v, `${f}: slot ${n}`));
    assert.equal(await page.evaluate(() => window.__h.stats().slots), want.length, `${f}: the view's own count`);
    assert.equal(await page.locator('[data-testid="html-note-mismatch"]').count(), 0, `${f}: no mismatch notice`);
    checked++;
  }
  assert.ok(checked >= 30, `fixtures checked: ${checked}`);
  await page.close();
});

test("a new version: the frame is set again, unsent edits are re-placed by text hash or reported, hidden parts stay hidden; the same version is never set twice", async () => {
  const r1 = read(MAIN);
  const r2 = read(MAIN2);
  const page = await open("main");
  const frameDoc = () => page.evaluate(() => document.querySelector('[data-testid="html-frame"]').contentDocument);
  await page.evaluate(() => (document.querySelector('[data-testid="html-frame"]').contentDocument.__marker = 1));
  // an edit in p1 (its text stays in the next version) and one in p2 (rewritten there)
  for (const [sel, needle] of [["#p1", "lazy"], ["#p2", "prices"]]) {
    const at = await textBox(page, sel, needle, 2, 3);
    await page.mouse.click(at.x + 1, at.y + at.h / 2);
    await until(() => page.evaluate((sel) => document.querySelector('[data-testid="html-frame"]').contentDocument.querySelector(sel).isContentEditable, sel), "editable");
    await page.keyboard.type("XY");
  }
  await until(() => page.evaluate(() => window.__h.edits().length === 2), "two edits");
  await page.evaluate(() => window.__h.flush());
  // hide p3 and scroll a little; the view state carries both
  await page.evaluate(() => window.__setMode("comment"));
  const p3 = await textBox(page, "#p3", "Read");
  await page.mouse.click(p3.x + 2, p3.y + p3.h / 2);
  await page.click('[data-testid="html-hide"]');
  // mode, marks and lock changes and the same version fetched again leave the frame's document alone
  await page.evaluate(() => window.__setMarks([{ id: "m", n: 1, kind: "element", location: { nodeId: 0 } }]));
  await page.evaluate(() => window.__setReadOnly(true));
  await page.evaluate(() => window.__setReadOnly(false));
  await page.evaluate(() => window.__setMode("edit"));
  await page.evaluate(() => window.__load("main"));
  await page.waitForTimeout(400);
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid="html-frame"]').contentDocument.__marker), 1, "the frame was not set again");
  assert.equal(await page.evaluate(() => window.__ev.hosts), 1);
  // hitTest and the view state on this version
  const h1 = await textBox(page, "#top", "Quarterly");
  const hit = await page.evaluate(([x, y]) => window.__h.hitTest(x, y), [h1.x + 3, h1.y + h1.h / 2]);
  assert.equal(hit.location.nodeId, elId(r1, "top"));
  assert.equal(hit.hitKind, "element");
  assert.equal(await page.evaluate(() => window.__h.hitTest(1, 1)), null, "outside the frame");
  await page.evaluate(() => (document.querySelector('[data-testid="html-frame"]').contentDocument.scrollingElement.scrollTop = 300));
  const vs = await page.evaluate(() => window.__h.getViewState());
  assert.equal(vs.y, 300);
  await page.evaluate(() => (document.querySelector('[data-testid="html-frame"]').contentDocument.scrollingElement.scrollTop = 0));
  assert.equal(await page.evaluate((vs) => window.__h.setViewState(vs), vs), true, "same version: exact");
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid="html-frame"]').contentDocument.scrollingElement.scrollTop), 300);
  // the next version
  await page.evaluate(() => window.__load("main2"));
  await page.waitForFunction(() => window.__ev.hosts === 2 && window.__h.version !== undefined, null, { timeout: 20000 });
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid="html-frame"]').contentDocument.__marker), undefined, "a new document for the new version");
  const edits = await page.evaluate(() => window.__h.edits());
  assert.equal(edits.length, 1);
  assert.equal(edits[0].nodeId, textId(r2, "lazy"), "moved to the node's id in the new version");
  assert.notEqual(edits[0].nodeId, textId(r1, "lazy"));
  assert.equal(edits[0].newText.replace("XY", ""), r2.nodes[edits[0].nodeId].value);
  assert.ok((await page.evaluate(() => document.querySelector('[data-testid="html-frame"]').contentDocument.querySelector("#p1").textContent)).includes("XY"), "the edit is shown in the new version");
  const lost = await page.evaluate(() => window.__ev.lost.at(-1));
  assert.equal(lost.lost.length, 1);
  assert.equal(lost.lost[0].nodeId, textId(r1, "prices"));
  assert.equal((await page.evaluate(() => window.__h.lostEdits())).length, 1, "kept until cleared");
  assert.deepEqual((await page.evaluate(() => window.__h.hidden())).map((h) => h.nodeId), [elId(r2, "p3")]);
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="html-frame"]').contentDocument.querySelector("#p3")).display), "none");
  assert.equal(await page.evaluate((vs) => window.__h.setViewState(vs), vs), false, "another version: not exact");
  await page.evaluate(() => window.__h.clearEdits());
  assert.deepEqual(await page.evaluate(() => [window.__h.edits().length, window.__h.lostEdits().length]), [0, 1], "a Send takes the pending edits; the lost ones stay listed");
  await page.evaluate(() => window.__h.dismissLost());
  assert.deepEqual(await page.evaluate(() => window.__h.lostEdits().length), 0);
  await page.close();
});

test("positive control for R4: in a copy whose names really shadow the frame's own properties, selection, typing and clicks still work", async () => {
  const r = read(CLOBBER);
  const page = await open("clobber-raw");
  const shadowed = await page.evaluate(() => {
    const d = document.querySelector('[data-testid="html-frame"]').contentDocument;
    const form = d.getElementById("getAttribute");
    return { getSelection: typeof d.getSelection, body: d.body?.tagName, createRange: typeof d.createRange, parentNode: form.parentNode?.tagName, getAttribute: typeof form.getAttribute };
  });
  assert.deepEqual(shadowed, { getSelection: "object", body: "IMG", createRange: "object", parentNode: "INPUT", getAttribute: "object" }, "the frame's own reads are shadowed");
  assert.equal(await page.evaluate(() => window.__h.stats().slots), (await (await fetch(`${demo.base}/meta?f=clobber-raw`)).json()).texts.length);
  const t = await textBox(page, "#nodeType", "select");
  await drag(page, t.x + 1, t.y + t.h / 2, t.x + t.w + 0.5, t.y + t.h / 2);
  const s = await settledSelection(page);
  assert.equal(s.quote, "select");
  assert.equal(s.location.nodeId, textId(r, "Clobber text"));
  const c = await textBox(page, "#firstChild", "clobber", 2, 3);
  await page.mouse.click(c.x + 1, c.y + c.h / 2);
  await until(() => page.evaluate(() => Element.prototype.hasAttribute.call(document.querySelector('[data-testid="html-frame"]').contentDocument.getElementById("firstChild"), "contenteditable")), "editable");
  await page.keyboard.type("Z");
  const ed = await until(async () => (await ev(page)).edits.at(-1)?.[0], "an edit");
  assert.equal(ed.nodeId, textId(r, "Second clobber"));
  await page.evaluate(() => window.__setMode("comment"));
  await page.mouse.click(t.x + 2, t.y + t.h / 2);
  const pick = await until(async () => (await ev(page)).picks.at(-1), "a pick");
  assert.equal(pick.anchor.location.nodeId, elId(r, "nodeType"));
  assert.deepEqual(b.log.errors, [], "no page error");
  await page.close();
});
