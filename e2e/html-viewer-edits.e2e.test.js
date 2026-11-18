// The person's text edits in web/src/HtmlViewer.jsx, in a real browser with real key and mouse input (Chrome; ONIONSKIN_BROWSER=webkit
// for Playwright's WebKit): typing right after a click is never lost (the parts are editable before the click), one action that also
// reaches a link records nothing and puts the paragraph back, emptied text is an edit, pending edits follow a new version only to the one
// node with their identity (else they are listed with their text and a Copy button), and in Comment mode the focus comes back to the page.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import "../src/html-parser.js";
import * as H from "../src/html.js";
import { launch, until, WEBKIT } from "./helpers/harness.mjs";
import { startViewerPage } from "./helpers/html-viewer/serve.mjs";

const page = (body, style = "") => `<!doctype html><html lang="en"><head><title>T</title><style>body{font:15px/1.4 sans-serif;margin:12px}${style}</style></head><body>${body}</body></html>`;
const N = 100;
const MANY = page(Array.from({ length: N }, (_, i) => `<p id="q${i}">Line ${i} text</p>`).join(""), "p{display:inline-block;width:150px;margin:2px 4px}");
const LINK = page('<p id="x">abc <a href="https://example.com/">def ghi</a></p>\n<p id="y">abc <b>def ghi</b></p>\n<p id="z">Hello</p>\n<p id="t">Tail line</p>');
const V1 = page('<p id="original">Hello</p><p>Tail</p>');
const V2 = page('<p id="inserted">Hello</p><p id="original">Hello</p><p>Tail</p>');
const W1 = page("<p>Hello</p><p>Tail</p>");
const W2 = page("<p>Hello</p><p>Hello</p><p>Tail</p>");

let demo;
let b;
before(async () => {
  demo = await startViewerPage(Object.fromEntries(Object.entries({ many: MANY, link: LINK, v1: V1, v2: V2, w1: W1, w2: W2 }).map(([k, v]) => [k, { bytes: Buffer.from(v) }])));
  b = await launch();
});
after(async () => {
  await b?.close();
  demo?.close();
});

async function open(name) {
  const p = await b.page();
  await p.goto(demo.url(name));
  await p.waitForFunction(() => window.__h && document.querySelector('[data-testid="html-viewer"]')?.dataset.phase === "ready", null, { timeout: 20000 });
  return p;
}
const frameText = (p, sel) => p.evaluate((sel) => document.querySelector('[data-testid="html-frame"]').contentDocument.querySelector(sel).textContent, sel);
const frameHtml = (p, sel) => p.evaluate((sel) => document.querySelector('[data-testid="html-frame"]').contentDocument.querySelector(sel).innerHTML, sel);
const ev = (p) => p.evaluate(() => JSON.parse(JSON.stringify(window.__ev)));
/** Page coordinates of character `i` of the first text node of frame element `sel`. */
const charAt = (p, sel, i) =>
  p.evaluate(([sel, i]) => {
    const f = document.querySelector('[data-testid="html-frame"]');
    const d = f.contentDocument;
    const t = d.querySelector(sel).firstChild;
    const r = d.createRange();
    r.setStart(t, i);
    r.setEnd(t, i + 1);
    const b = r.getBoundingClientRect();
    const fr = f.getBoundingClientRect();
    return { x: b.left + fr.left + f.clientLeft, y: b.top + fr.top + f.clientTop + b.height / 2, w: b.width };
  }, [sel, i]);
const read = (src) => H.readHtml(Buffer.from(src));
const textNode = (r, text, n = 0) => r.nodes.filter((x) => x.nodeName === "#text" && x.value === text)[n].__id;

test("typing right after a click is never lost: 100 paragraphs, click and type with no delay, every character is an edit", async () => {
  const p = await open("many");
  // every editable part is editable before any click
  await until(() => p.evaluate((n) => [...document.querySelector('[data-testid="html-frame"]').contentDocument.querySelectorAll("p")].filter((x) => x.isContentEditable).length === n, N), "all paragraphs editable ahead");
  const at = [];
  for (let i = 0; i < N; i++) at.push(await charAt(p, `#q${i}`, 2));
  for (let i = 0; i < N; i++) {
    await p.mouse.click(at[i].x + 1, at[i].y); // inside "Line": after "Li" or "Lin"
    await p.keyboard.type(`[${i}]`); // no wait between the click and the keys, nor between paragraphs
  }
  await p.evaluate(() => window.__h.flush());
  const edits = await until(async () => {
    const l = await p.evaluate(() => window.__h.edits());
    return l.length === N && l;
  }, "one edit per paragraph").catch(async (e) => assert.fail(`${e.message}: ${(await p.evaluate(() => window.__h.edits())).length} edits`));
  const r = read(MANY);
  for (let i = 0; i < N; i++) {
    const t = await frameText(p, `#q${i}`);
    assert.equal(t.replace(`[${i}]`, ""), `Line ${i} text`, `paragraph ${i}: ${t}`);
    const e = edits.find((x) => x.nodeId === textNode(r, `Line ${i} text`));
    assert.ok(e, `an edit for paragraph ${i}`);
    assert.equal(e.newText, t, `paragraph ${i}: the edit holds what is shown`);
  }
  assert.equal((await p.evaluate(() => window.__h.stats())).reloads, 0, "nothing was set again");
  // read-only (a run): a click and a key right after it are put back, and nothing is recorded
  await p.evaluate(() => window.__setReadOnly(true));
  const q = await charAt(p, "#q5", 6);
  await p.mouse.click(q.x + 1, q.y);
  await p.keyboard.type("QQ");
  await until(async () => !(await frameText(p, "#q5")).includes("QQ"), "put back while read-only");
  assert.equal((await p.evaluate(() => window.__h.edits())).length, N);
  await p.close();
});

test("one action that deletes into a link records nothing: real Delete, Backspace, typing over and cut, and both slots changed at once", async () => {
  const p = await open("link");
  if (!WEBKIT) await p.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: demo.base });
  const before = await frameHtml(p, "#x");
  for (const how of ["Delete", "Backspace", "type", "cut"]) {
    const n0 = (await ev(p)).blocked.length;
    const c = await charAt(p, "#x", 1);
    await p.mouse.click(c.x + c.w - 0.5, c.y); // after "a"
    for (let k = 0; k < 5; k++) await p.keyboard.press("Shift+ArrowRight"); // "bc " and into the link
    if (how === "type") await p.keyboard.type("Z");
    else if (how === "cut") await p.keyboard.press("ControlOrMeta+X");
    else await p.keyboard.press(how);
    await until(async () => (await ev(p)).blocked.length > n0, `the blocked action for ${how}`);
    await until(async () => (await frameHtml(p, "#x")) === before, `the paragraph put back after ${how}`);
    await p.waitForTimeout(150);
    assert.equal((await ev(p)).blocked.length, n0 + 1, `told once for ${how}`);
    assert.deepEqual(await p.evaluate(() => window.__h.edits()), [], `nothing recorded for ${how}`);
  }
  // the case the outside review traced (html-frame.js:309): the browser keeps the link and changes the text before it AND the link's
  // text in one action. The text slot alone would be a valid edit; it must not be kept when the link part is refused.
  const n0 = (await ev(p)).blocked.length;
  await p.evaluate(() => {
    const x = document.querySelector('[data-testid="html-frame"]').contentDocument.querySelector("#x");
    x.firstChild.data = "ab";
    x.querySelector("[data-osk-href]").firstChild.data = "f ghi";
  });
  await until(async () => (await ev(p)).blocked.length > n0, "the blocked action");
  await until(async () => (await frameHtml(p, "#x")) === before, "put back");
  assert.equal((await ev(p)).blocked.at(-1).reason, "not_editable");
  assert.deepEqual(await p.evaluate(() => window.__h.edits()), []);
  // the same deletion into a <b> (text the person may type in): both slots are edits
  const c = await charAt(p, "#y", 1);
  await p.mouse.click(c.x + c.w - 0.5, c.y);
  for (let k = 0; k < 5; k++) await p.keyboard.press("Shift+ArrowRight");
  await p.keyboard.press("Delete");
  const l = await until(async () => {
    const e = await p.evaluate(() => window.__h.edits());
    return e.length === 2 && e;
  }, "two edits");
  assert.deepEqual(l.map((e) => e.newText).sort(), [" ghi", "ab"].sort());
  await p.close();
});

test("emptying a text is an edit the server accepts: select all of it and delete, type again, undo", async () => {
  const p = await open("link");
  const r = read(LINK);
  const c = await charAt(p, "#z", 0);
  await p.mouse.click(c.x + 1, c.y);
  await p.keyboard.press("Home");
  for (let k = 0; k < 5; k++) await p.keyboard.press("Shift+ArrowRight");
  await p.keyboard.press("Delete");
  const e = await until(async () => (await p.evaluate(() => window.__h.edits()))[0], "an edit");
  assert.deepEqual([e.nodeId, e.newText], [textNode(r, "Hello"), ""]);
  assert.equal((await ev(p)).blocked.length, 0, "not a structure change");
  assert.equal(await frameHtml(p, "#z"), "", "the text node is kept, empty (no <br>)");
  // the server's own check takes it (src/html-write.js checkedHtmlWrite with the person's edits)
  const { checkedHtmlWrite } = await import("../src/html-write.js");
  const w = checkedHtmlWrite(Buffer.from(LINK), null, { edits: [{ nodeId: e.nodeId, text: "", baseTextHash: e.baseTextHash }] });
  assert.equal(w.ok, true, JSON.stringify(w));
  assert.ok(w.bytes.toString().includes('<p id="z"></p>'));
  await p.keyboard.type("New");
  await until(async () => (await p.evaluate(() => window.__h.edits()))[0]?.newText === "New", "typed into the emptied paragraph");
  await p.evaluate(() => window.__h.undoEdit());
  assert.equal(await frameText(p, "#z"), "Hello");
  assert.deepEqual(await p.evaluate(() => window.__h.edits()), []);
  await p.close();
});

test("a new version: the edit goes to the one node with its identity (the outside review's case), else it is listed with its text and a Copy button", async () => {
  const p = await open("v1");
  if (!WEBKIT) await p.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: demo.base });
  const typeAlice = async () => {
    const c = await charAt(p, "p", 4);
    await p.mouse.click(c.x + c.w - 0.5, c.y);
    await p.keyboard.press("End");
    await p.keyboard.type(" Alice");
    await until(async () => (await p.evaluate(() => window.__h.edits()))[0]?.newText === "Hello Alice", "the edit");
  };
  await typeAlice();
  await p.evaluate(() => window.__load("v2"));
  await p.waitForFunction(() => window.__ev.hosts === 2, null, { timeout: 20000 });
  const r2 = read(V2);
  const e = await p.evaluate(() => window.__h.edits());
  assert.deepEqual(e.map((x) => [x.nodeId, x.newText]), [[textNode(r2, "Hello", 1), "Hello Alice"]], "on #original, not on the inserted twin");
  assert.equal(await frameText(p, "#original"), "Hello Alice");
  assert.equal(await frameText(p, "#inserted"), "Hello");
  assert.equal(await p.locator('[data-testid="html-lost"]').count(), 0);
  await p.close();
  // no ids: nothing tells the two "Hello" apart, so the edit is not placed; it is listed with its text
  const q = await open("w1");
  if (!WEBKIT) await q.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: demo.base });
  const c = await charAt(q, "p", 4);
  await q.mouse.click(c.x + c.w - 0.5, c.y);
  await q.keyboard.press("End");
  await q.keyboard.type(" Alice");
  await until(async () => (await q.evaluate(() => window.__h.edits()))[0]?.newText === "Hello Alice", "the edit");
  await q.evaluate(() => window.__load("w2"));
  await q.waitForFunction(() => window.__ev.hosts === 2, null, { timeout: 20000 });
  assert.deepEqual(await q.evaluate(() => window.__h.edits()), [], "nothing left to send at a guessed place");
  await q.waitForSelector('[data-testid="html-lost"]');
  assert.match(await q.textContent('[data-testid="html-lost"]'), /could not be placed/);
  assert.equal(await q.textContent('[data-testid="html-lost-edit"] .hv-lost-text'), "Hello Alice");
  assert.deepEqual(await q.evaluate(() => [...document.querySelector('[data-testid="html-frame"]').contentDocument.querySelectorAll("p")].map((x) => x.textContent)), ["Hello", "Hello", "Tail"], "the view shows the file as it is");
  if (!WEBKIT) {
    await q.click('[data-testid="html-lost-copy"]');
    await until(async () => (await q.textContent('[data-testid="html-lost-copy"]')) === "Copied", "copied");
    assert.equal(await q.evaluate(() => navigator.clipboard.readText()), "Hello Alice");
  }
  await q.click('[data-testid="html-lost-done"]');
  await until(async () => (await q.locator('[data-testid="html-lost"]').count()) === 0, "the list closes");
  assert.equal((await q.evaluate(() => window.__h.lostEdits())).length, 0);
  await q.close();
});

test("Comment mode: the focus leaves the frame for the page's own layer, so the app's keyboard shortcuts reach the page", async () => {
  const p = await open("link");
  const c = await charAt(p, "#t", 2);
  await p.mouse.click(c.x + 1, c.y); // the caret, and the focus, in the frame
  await until(() => p.evaluate(() => document.activeElement?.dataset.testid === "html-frame"), "the frame has the focus");
  await p.evaluate(() => {
    window.__keys = [];
    document.addEventListener("keydown", (e) => window.__keys.push(e.key), true);
  });
  await p.keyboard.press("k");
  assert.deepEqual(await p.evaluate(() => window.__keys), [], "in Edit mode the frame has the keys");
  await p.evaluate(() => window.__setMode("comment"));
  await until(() => p.evaluate(() => document.activeElement?.dataset.testid === "html-catch"), "the page's layer has the focus");
  await p.keyboard.press("?");
  assert.deepEqual(await p.evaluate(() => window.__keys), ["?"]);
  assert.ok(!(await frameText(p, "#t")).includes("?"), "nothing typed into the page in Comment mode");
  await p.close();
});

test("a part changed in a way the view cannot put back from what it holds: the same version is set again, pending edits kept, the blocked action told", async () => {
  const p = await open("link");
  const errors0 = b.log.errors.length;
  // a pending edit in one part
  const c = await charAt(p, "#t", 3);
  await p.mouse.click(c.x + c.w - 0.5, c.y);
  await p.keyboard.type("Q");
  await until(async () => (await p.evaluate(() => window.__h.edits())).length === 1, "the edit");
  await p.evaluate(() => window.__h.flush());
  // another part, never visited: its <b> taken away (a structure change no one typed under the view's eyes)
  const n0 = (await ev(p)).blocked.length;
  const hosts0 = (await ev(p)).hosts;
  await p.evaluate(() => {
    const y = document.querySelector('[data-testid="html-frame"]').contentDocument.querySelector("#y");
    y.removeChild(y.querySelector("b"));
  });
  await until(async () => (await ev(p)).hosts > hosts0 && (await p.evaluate(() => window.__h?.stats().reloads)) === 1, "set again");
  await p.waitForFunction(() => document.querySelector('[data-testid="html-viewer"]')?.dataset.phase === "ready");
  assert.equal((await ev(p)).blocked.length, n0 + 1, "told once");
  assert.equal((await ev(p)).blocked.at(-1).reason, "structure");
  assert.match(await frameHtml(p, "#y"), /^abc <b [^>]*>def ghi<\/b>$/, "the part as the version has it");
  const kept = await p.evaluate(() => window.__h.edits());
  assert.equal(kept.length, 1);
  assert.equal(kept[0].newText.replace("Q", ""), "Tail line");
  assert.equal(await frameText(p, "#t"), kept[0].newText, "the pending edit is shown again");
  // typing still works after it
  const d = await charAt(p, "#z", 4);
  await p.mouse.click(d.x + d.w - 0.5, d.y);
  await p.keyboard.type("!");
  await until(async () => (await p.evaluate(() => window.__h.edits())).length === 2, "a second edit");
  assert.deepEqual(b.log.errors.slice(errors0), [], "no page error");
  await p.close();
});
