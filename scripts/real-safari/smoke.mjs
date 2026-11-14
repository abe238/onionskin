// A short smoke test in the real Safari app (not Playwright WebKit): one journey per format, driven over W3C WebDriver with /usr/bin/safaridriver.
// Needs Safari > Develop > Allow Remote Automation (a one-time switch the owner turns on; this script never enables it). Run: npm run test:safari
// Everything lives in temp dirs. Screenshots go to ONIONSKIN_SAFARI_SHOTS (default: a temp folder, printed at the end).
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { agentEdit, makeWorld } from "../../e2e/helpers/harness.mjs";
import { rezip } from "../../test/helpers/zipbuild.js";

const SHOTS = process.env.ONIONSKIN_SAFARI_SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), "da-safari-shots-"));
fs.mkdirSync(SHOTS, { recursive: true });
const q = (id) => `[data-testid="${id}"]`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

/** Polls `fn` until it returns something truthy. */
async function until(fn, what, ms = 25000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}${last instanceof Error ? `: ${last.message}` : ""}`);
}

// ---- W3C WebDriver over fetch ---------------------------------------------------------------------------------
class Driver {
  constructor(port) {
    this.base = `http://127.0.0.1:${port}`;
    this.sid = null;
  }
  async call(method, p, body) {
    const r = await fetch(`${this.base}${p}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.value?.error) throw new Error(`${method} ${p.replace(/\/session\/[^/]+/, "")}: ${j.value?.error || r.status}: ${j.value?.message || ""}`.trim());
    return j.value;
  }
  async start() {
    const v = await this.call("POST", "/session", { capabilities: { alwaysMatch: { browserName: "safari" } } });
    this.sid = v.sessionId;
  }
  s(p) {
    return `/session/${this.sid}${p}`;
  }
  async end() {
    if (!this.sid) return;
    const sid = this.sid;
    this.sid = null;
    await this.call("DELETE", `/session/${sid}`).catch(() => {}); // closes the windows this session opened
  }
  get(url) {
    return this.call("POST", this.s("/url"), { url });
  }
  /** Runs a function in the page; `args` arrive as its arguments. */
  run(fn, ...args) {
    return this.call("POST", this.s("/execute/sync"), { script: `return (${fn.toString()}).apply(null, arguments)`, args });
  }
  async shot(file) {
    fs.writeFileSync(file, Buffer.from(await this.call("GET", this.s("/screenshot")), "base64"));
  }
  actions(sources) {
    return this.call("POST", this.s("/actions"), { actions: sources });
  }
  mouse(steps) {
    return this.actions([{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: steps }]);
  }
  move(x, y) {
    return { type: "pointerMove", duration: 0, origin: "viewport", x: Math.round(x), y: Math.round(y) };
  }
  async click(x, y) {
    await this.mouse([this.move(x, y), { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }]);
  }
  async dblclick(x, y) {
    const tap = [{ type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }];
    await this.mouse([this.move(x, y), ...tap, ...tap]);
  }
  /** Types into whatever has the focus. "\n" is Enter. */
  async type(text) {
    const keys = [];
    for (const ch of text) {
      const k = ch === "\n" ? "" : ch;
      keys.push({ type: "keyDown", value: k }, { type: "keyUp", value: k });
    }
    await this.actions([{ type: "key", id: "kb", actions: keys }]);
  }
  async find(selector) {
    const v = await this.call("POST", this.s("/element"), { using: "css selector", value: selector });
    return Object.values(v)[0];
  }
  /** Types into a text box (click it to focus, then send the keys to the element itself). */
  async fill(selector, text) {
    const id = await this.find(selector);
    await this.call("POST", this.s(`/element/${id}/click`), {});
    await this.call("POST", this.s(`/element/${id}/value`), { text });
  }
  async clickSel(selector) {
    const id = await this.find(selector);
    await this.call("POST", this.s(`/element/${id}/click`), {});
  }
  count(selector) {
    return this.run((s) => document.querySelectorAll(s).length, selector);
  }
}

// ---- page probes (run inside Safari) ----------------------------------------------------------------------------
/** Viewport rect of the first element matching `sel` whose text starts with `prefix`, scrolled into view. */
const rectOf = (d, sel, prefix) =>
  d.run(
    (sel, prefix) => {
      const el = [...document.querySelectorAll(sel)].find((e) => !prefix || e.textContent.startsWith(prefix));
      if (!el) return null;
      el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    },
    sel,
    prefix || null
  );
const paraText = (d, prefix) => d.run((p) => [...document.querySelectorAll(".de-p")].find((e) => e.textContent.startsWith(p))?.textContent ?? null, prefix);
const hasCellText = (d, text) => d.run((t) => [...document.querySelectorAll(".de-cell")].some((e) => e.textContent.trim() === t), text);
/** Viewport box of the cell in the row whose first cell reads `rowText`, at column letter `col` (same geometry as xlsxCell in e2e/helpers/harness.mjs). */
const xlsxCell = (d, rowText, col) =>
  d.run(
    (rowText, col) => {
      const regs = [...document.querySelectorAll(".de-grid-view .de-region")];
      const colRegion = regs.find((r) => [...r.children].some((e) => e.textContent === "A") && [...r.children].some((e) => e.textContent === "B"));
      const head = [...(colRegion?.children || [])].find((e) => e.textContent === col);
      const row = [...document.querySelectorAll(".de-cell")].find((e) => e.textContent === rowText);
      if (!head || !row) return null;
      const h = head.getBoundingClientRect();
      const r = row.getBoundingClientRect();
      return { x: h.left, y: r.top, w: h.width, h: r.height };
    },
    rowText,
    col
  );
/** The document is virtualized: scroll toward where the paragraph should be (guess = fraction of the page) until it renders, then give its box (same idea as scrollToPara in e2e/helpers/harness.mjs). */
async function rectOfFar(d, prefix, guess) {
  let g = guess;
  for (let i = 0; i < 40; i++) {
    const b = await rectOf(d, ".de-p", prefix);
    if (b) return b;
    await d.run((g) => { const s = document.querySelector(".de-scroll"); s.scrollTop = Math.max(0, s.scrollHeight * g - 300); }, g);
    await sleep(400);
    g += (i % 2 ? 1 : -1) * 0.004 * (i + 1);
  }
  throw new Error(`paragraph "${prefix}" never rendered`);
}
const mid = (b) => [b.x + b.w / 2, b.y + b.h / 2];

// ---- steps and the table ----------------------------------------------------------------------------------------
const rows = [];
let shotNo = 0;

/** Runs one step: records pass or fail, saves a screenshot either way. A failed step ends its journey (the rest are skipped). */
async function step(j, d, name, fn) {
  if (j.failed) return rows.push({ journey: j.name, step: name, result: "skip", note: "an earlier step failed", shot: "" });
  let result = "pass", note = "";
  try {
    await fn();
  } catch (e) {
    result = "FAIL";
    note = String(e.message || e).split("\n")[0].slice(0, 300);
    j.failed = true;
  }
  let shot = "";
  try {
    shot = path.join(SHOTS, `${String(++shotNo).padStart(2, "0")}-${j.name}-${name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${result.toLowerCase()}.png`);
    await d.shot(shot);
  } catch (e) {
    shot = `(no screenshot: ${String(e.message).slice(0, 80)})`;
  }
  rows.push({ journey: j.name, step: name, result, note, shot });
}

/** Opens a file in Onionskin and waits for the editor. Returns the poll process the fake agent reads from. */
async function openDoc(w, d, file, probe) {
  const poll = w.spawnCli(["poll", file]);
  await d.get(await w.open(file));
  await until(() => d.run((p) => !!document.querySelector(p) && !!document.querySelector('[data-testid="state-pill"]'), `[data-testid="docwrap"] ${probe}`), "the editor to show the document", 40000);
  await until(() => d.count(q("banner-listening")), "the agent link to be ready");
  await sleep(1000);
  return poll;
}

/** The fake agent: takes the batch the poll returns, runs `edit` on the file, finishes with `done`. */
async function agentRound(w, file, poll, edit, summary) {
  const res = await Promise.race([poll.done, sleep(30000).then(() => null)]);
  if (!res || res.code !== 0) throw new Error(`the agent got no batch: ${res?.stderr || "poll timed out"}`);
  const batch = JSON.parse(res.stdout);
  edit();
  const results = w.doc(`results-${path.basename(file)}.json`);
  fs.writeFileSync(results, JSON.stringify({ summary, results: batch.instructions.comments.map((c) => ({ comment_id: c.id, status: "done", note: "Done." })) }));
  const done = await w.cli(["done", file, "--results", results]);
  if (done.code !== 0) throw new Error(`done failed: ${done.stderr}`);
}

const send = async (d) => {
  await until(async () => !(await d.run(() => document.querySelector('[data-testid="send"]')?.disabled ?? true)), "Send to be ready");
  await d.clickSel(q("send"));
  await until(() => d.count(q("banner-working")), "the page to say the agent is working");
};
const runCard = (d) => until(() => d.count(q("activity-entry")), "the run card", 30000);

// ---- journeys ---------------------------------------------------------------------------------------------------
async function docx(w, d) {
  const j = { name: "docx" };
  const file = w.doc("long.docx");
  let poll;
  await step(j, d, "open and wait for the editor", async () => (poll = await openDoc(w, d, file, ".de-p")));
  await step(j, d, "type a word at the end of a paragraph", async () => {
    const b = await until(() => rectOf(d, ".de-p", "Paragraph 003:"), "paragraph 003");
    await d.click(b.x + b.w - 6, b.y + b.h - 8); // right of the last line puts the caret at the end of it
    await d.type(" TYPED");
    await until(async () => /TYPED$/.test((await paraText(d, "Paragraph 003:")) || ""), "the typed word in the paragraph");
  });
  await step(j, d, "select a word and add a comment", async () => {
    const b = await until(() => rectOf(d, ".de-p", "Paragraph 005:"), "paragraph 005");
    await d.dblclick(b.x + 150, b.y + 12);
    await until(() => d.count(q("comment-chip")), "the comment chip");
    await d.clickSel(q("comment-chip"));
    await until(() => d.count(`${q("comment-card")} textarea`), "the comment box");
    await d.fill(`${q("comment-card")} textarea`, "Say managers here.");
    await sleep(700);
  });
  await step(j, d, "press Send", () => send(d));
  await step(j, d, "the agent applies one change; the page shows it and the run card", async () => {
    await agentRound(w, file, poll, () => agentEdit([file, "replace", "regional leads", "regional managers", "Paragraph 005:"]), "Changed leads to managers.");
    await until(async () => /regional managers/.test((await paraText(d, "Paragraph 005:")) || ""), "the change on the page", 40000);
    await runCard(d);
  });
  await step(j, d, "What changed: the note box fills with the changed words", async () => {
    await d.clickSel(q("change-note-button"));
    const text = await until(() => d.run(() => document.querySelector('[data-testid="change-note-text"]')?.value || ""), "the What changed box to fill", 15000);
    if (!/^What changed in long\.docx since /.test(text) || !/regional managers/.test(text)) throw new Error(`unexpected note text: ${text.slice(0, 160)}`);
  });
  await step(j, d, "press Revert; the text is back", async () => {
    await until(() => d.count(`${q("revert")}, ${q("revert-folded")}`), "a Revert button");
    await d.run(() => (document.querySelector('[data-testid="revert"]') || document.querySelector('[data-testid="revert-folded"]')).click());
    await until(async () => /regional leads/.test((await paraText(d, "Paragraph 005:")) || ""), "the original text", 40000);
  });
}

async function xlsx(w, d) {
  const j = { name: "xlsx" };
  const file = w.doc("budget.xlsx");
  let poll;
  await step(j, d, "open and wait for the editor", async () => (poll = await openDoc(w, d, file, ".de-grid")));
  await step(j, d, "change one cell", async () => {
    await d.run(() => [...document.querySelectorAll(".de-tab")].find((t) => t.textContent === "Budget").click());
    await sleep(1000);
    await d.run(() => (document.querySelector(".de-grid").scrollTop = 200));
    await until(() => xlsxCell(d, "Line item 015", "C"), "row 16 rendered");
    await sleep(500); // the grid may still settle after the scroll: measure again just before clicking
    const c = await until(() => xlsxCell(d, "Line item 015", "C"), "row 16 rendered");
    await d.click(...mid(c));
    await d.type("4242\n");
    await until(() => d.count(q("change-item")), "the change in the panel");
    await until(() => hasCellText(d, "4242"), "4242 in the cell");
  });
  await step(j, d, "press Send", () => send(d));
  await step(j, d, "the agent changes another cell; both show", async () => {
    await agentRound(w, file, poll, () => agentEdit([file, "xlsx-set", "Budget", "D30", "9999"]), "Set D30.");
    await runCard(d);
    await until(async () => {
      await d.run(() => (document.querySelector(".de-grid").scrollTop = 200));
      await sleep(400);
      return (await hasCellText(d, "9999")) && (await hasCellText(d, "4242"));
    }, "both cells on the page", 40000);
  });
}

async function pptx(w, d) {
  const j = { name: "pptx" };
  const file = w.doc("deck.pptx");
  const NOTE = 4; // the "Side note" text box on slide 4
  const note = `.de-slide-frame[data-slide="4"] [data-sid="${NOTE}"]`;
  let poll;
  await step(j, d, "open and wait for the editor", async () => (poll = await openDoc(w, d, file, ".de-slide")));
  await step(j, d, "add a comment on a shape", async () => {
    await d.run(() => document.querySelectorAll(".de-thumb")[3].click());
    await until(() => rectOf(d, note), "slide 4");
    await sleep(1200);
    await d.clickSel(q("mode-comment"));
    const b = await until(() => rectOf(d, note), "the side note");
    await d.click(b.x + b.w * 0.2, b.y + b.h * 0.5);
    await until(() => d.count(`${q("comment-card")} textarea`), "the comment box");
    await d.fill(`${q("comment-card")} textarea`, "Who owns this?");
    await d.clickSel(q("mode-edit"));
    await sleep(700);
  });
  await step(j, d, "press Send", () => send(d));
  await step(j, d, "the agent edits the shape text; the page shows it", async () => {
    await agentRound(w, file, poll, () => agentEdit([file, "pptx-set-text", "3", "Side note", "Owner: Design team"]), "Changed the owner.");
    await runCard(d);
    await until(() => d.run((sel) => /Design team/.test(document.querySelector(sel)?.textContent || ""), note), "the new shape text", 40000);
  });
}

/** Select a word, press Ask, tap Shorter: the fixed words reach the agent as one ordinary comment. */
async function stamp(w, d) {
  const j = { name: "stamp" };
  const file = w.doc("long.docx");
  let poll;
  await step(j, d, "open and wait for the editor", async () => (poll = await openDoc(w, d, file, ".de-p")));
  await step(j, d, "select a word and press Ask", async () => {
    await rectOfFar(d, "Paragraph 020:", 20 / 300);
    await sleep(300);
    const b = await rectOf(d, ".de-p", "Paragraph 020:");
    await d.dblclick(b.x + 150, b.y + 12);
    await until(() => d.count(q("comment-chip")), "the comment chip");
    await d.clickSel(q("quick-ask-chip"));
    await until(() => d.count(q("quick-ask")), "the Ask box");
    const labels = await d.run(() => [...document.querySelectorAll('[data-testid="stamp"]')].map((e) => e.textContent));
    if (labels[0] !== "Shorter") throw new Error(`stamps: ${labels.join(", ")}`);
  });
  await step(j, d, "tap Shorter: a comment with the stamp's words is queued and sent", async () => {
    await d.run(() => [...document.querySelectorAll('[data-testid="stamp"]')].find((e) => e.textContent === "Shorter").click());
    const res = await Promise.race([poll.done, sleep(30000).then(() => null)]);
    if (!res || res.code !== 0) throw new Error(`the agent got no batch: ${res?.stderr || "poll timed out"}`);
    const c = JSON.parse(res.stdout).instructions.comments;
    if (c.length !== 1 || c[0].text !== "Make this shorter. Keep the meaning.") throw new Error(`comments: ${JSON.stringify(c).slice(0, 200)}`);
    await until(async () => (await d.count(q("quick-ask"))) === 0, "the Ask box to close", 5000);
  });
}

/** "Replace Acme with Initech" in Overall instructions: the Send button shows the count and the change lands on this Mac (no agent polls). */
async function quick(w, d) {
  const j = { name: "quick" };
  const file = w.copySample("sample.docx", "deal.docx");
  const swap = { "Revenue grew 24%": "Acme grew 24%", "Two new regions launched": "Acme opened two new regions", "Customer churn fell to 3.1%": "Acme churn fell to 3.1%" };
  fs.writeFileSync(file, rezip(fs.readFileSync(file), { "word/document.xml": (x) => Object.entries(swap).reduce((t, [a, b]) => t.replace(a, b), x) }));
  const label = () => d.run(() => document.querySelector('[data-testid="send"] .send-label')?.textContent.trim());
  await step(j, d, "open and wait for the editor", async () => {
    await d.get(await w.open(file));
    await until(() => d.run(() => [...document.querySelectorAll(".de-p")].some((e) => e.textContent.includes("Acme grew 24%")) && !!document.querySelector('[data-testid="state-pill"]')), "the editor to show the document", 40000);
    await sleep(1000);
  });
  await step(j, d, "type the quick command: the line and the count show on Send", async () => {
    await d.fill(q("overall-note"), "Replace Acme with Initech");
    const line = await until(() => d.run(() => document.querySelector('[data-testid="quick-line"]')?.textContent.trim() || ""), "the quick line", 15000);
    if (line !== 'Quick change: replace "Acme" with "Initech" in 3 places. Runs on this Mac, no AI.') throw new Error(`line: ${line}`);
    await until(async () => (await label()) === "Replace in 3 places", "the Send label to show the count");
  });
  await step(j, d, "press Send: Done on this Mac, three places changed", async () => {
    await d.clickSel(q("send"));
    await until(() => d.run(() => [...document.querySelectorAll('[data-testid="activity-entry"]')].some((e) => e.textContent.includes("Done on this Mac"))), "Done on this Mac", 30000);
    await until(() => d.run(() => [...document.querySelectorAll(".de-p")].some((e) => e.textContent.includes("Initech grew 24%"))), "Initech on the page", 30000);
    const left = await d.run(() => [...document.querySelectorAll(".de-p")].filter((e) => /Acme/.test(e.textContent)).length);
    if (left) throw new Error(`${left} paragraphs still say Acme`);
  });
}

// ---- main ---------------------------------------------------------------------------------------------------------
const port = await freePort();
const driver = spawn("/usr/bin/safaridriver", ["-p", String(port)], { stdio: "ignore" });
const d = new Driver(port);
const worlds = [];
let fatal = null;
try {
  await until(async () => (await fetch(`http://127.0.0.1:${port}/status`).catch(() => null))?.ok, "safaridriver to listen", 10000);
  await d.start(); // fails with safaridriver's own words when Allow Remote Automation is off or a macOS prompt is waiting
  await d.call("POST", d.s("/window/rect"), { width: 1500, height: 950, x: 20, y: 20 }).catch(() => {});
  for (const journey of [docx, xlsx, pptx, stamp, quick]) {
    const w = makeWorld({ ONIONSKIN_NO_SOFFICE: "1" });
    worlds.push(w);
    await journey(w, d);
  }
} catch (e) {
  fatal = String(e.message || e);
} finally {
  await d.end();
  driver.kill(); // the driver this script started, by its own child pid
  for (const w of worlds) await w.cleanup().catch(() => {});
}

if (rows.length) {
  console.log("\njourney  result  step");
  for (const r of rows) console.log(`${r.journey.padEnd(8)} ${r.result.padEnd(7)} ${r.step}${r.note ? `  <- ${r.note}` : ""}`);
  console.log(`\nscreenshots: ${SHOTS}`);
}
const failed = rows.filter((r) => r.result === "FAIL").length;
if (fatal) console.error(`\nSafari smoke test could not run: ${fatal}`);
console.log(`\n${rows.filter((r) => r.result === "pass").length} passed, ${failed} failed, ${rows.filter((r) => r.result === "skip").length} skipped`);
process.exit(fatal || failed ? 1 : 0);
