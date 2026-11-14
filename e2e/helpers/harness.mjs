import crypto from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright-core";

export const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const cliPath = path.join(repo, "src", "cli.js");
import { python, ENGINE_SAMPLES, CORPUS, skipUnless, haveSamples, haveCorpus, havePython, VENV_HINT } from "../../scripts/fixtures.mjs";
export { python, ENGINE_SAMPLES, CORPUS, skipUnless, haveSamples, haveCorpus, havePython, VENV_HINT };

/** A throwaway world: state dir (short path, unix socket limit), documents dir, env for the CLI/server. */
export function makeWorld(extraEnv = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "da-"));
  const state = path.join(root, "st");
  const docs = path.join(root, "docs");
  fs.mkdirSync(docs);
  const env = { ...process.env, ONIONSKIN_STATE_DIR: state, ONIONSKIN_TICK_MS: "150", ONIONSKIN_LEASE_MS: "600000", ...extraEnv };
  if (!havePython()) throw new Error(`the E2E fixtures need the repo virtualenv (${python} is missing). Create it: ${VENV_HINT}`);
  execFileSync(python, [path.join(repo, "scripts", "make-fixtures.py"), docs]);
  const spawned = []; // CLI children of this world, ended at cleanup
  const world = {
    root, state, docs, env,
    doc: (name) => path.join(docs, name),
    copySample(name, as = name) {
      const src = path.join(ENGINE_SAMPLES, name);
      if (!fs.existsSync(src)) throw new Error(`missing sample ${src}: restore test/fixtures/engine or set ONIONSKIN_TEST_SAMPLES`);
      fs.copyFileSync(src, path.join(docs, as));
      return path.join(docs, as);
    },
    /**
     * Runs the CLI. `apply`, `commit` and `done` need the delivery's ticket (--lease) while a batch is delivered. A test that does not care
     * about the ticket gets it the way an agent that lost it would: `status --ticket` for the poller of this state dir. `ticket: false` runs it bare.
     */
    async cli(args, { ticket = true } = {}) {
      const run = (a) =>
        new Promise((resolve) => {
          const c = spawn(process.execPath, [cliPath, ...a], { env, stdio: ["ignore", "pipe", "pipe"] });
          let stdout = "", stderr = "";
          c.stdout.on("data", (d) => (stdout += d));
          c.stderr.on("data", (d) => (stderr += d));
          c.on("close", (code) => resolve({ code, stdout, stderr }));
        });
      const writes = ["done", "commit"].includes(args[0]) || (args[0] === "apply" && !args.includes("--dry-run") && !args.includes("--standalone"));
      if (ticket && writes && !args.includes("--lease")) {
        const st = await run(["status", args[1], "--ticket"]);
        let t = null;
        try {
          t = JSON.parse(st.stdout).ticket;
        } catch {}
        if (t) args = [...args, "--lease", t];
      }
      return run(args);
    },
    /** A long-running CLI process (poll). */
    spawnCli(args) {
      const c = spawn(process.execPath, [cliPath, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
      spawned.push(c);
      let stdout = "", stderr = "";
      c.stdout.on("data", (d) => (stdout += d));
      c.stderr.on("data", (d) => (stderr += d));
      const done = new Promise((resolve) => c.on("close", (code) => resolve({ code, stdout, stderr })));
      return { child: c, done, out: () => stdout, err: () => stderr };
    },
    async open(file) {
      const r = await world.cli(["open", "--no-open", file]);
      if (r.code !== 0) throw new Error(`open failed: ${r.stderr}`);
      const url = r.stdout.split("\n").find((l) => l.startsWith("http://"));
      return url;
    },
    async cleanup() {
      // a poll that is still waiting would see the server go and start it again in a state dir that is about to be removed: end them first
      for (const c of spawned) if (c.exitCode === null) c.kill("SIGKILL");
      await world.cli(["stop"]).catch(() => {});
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
  return world;
}

/**
 * A folder holding the stand-in Apple helper (fake-apple-helper.cjs) and its onionskin-fm.json, for ONIONSKIN_APPLE_HELPER_DIR. `mode` is "ok" or the
 * probe's reason for Apple's model not being available ("deviceNotEligible", "appleIntelligenceNotEnabled", "modelNotReady"). Remove the folder when done.
 */
export function fakeAppleHelper(mode = "ok") {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "da-fm-"));
  const bin = path.join(dir, "onionskin-fm");
  fs.writeFileSync(bin, `#!${process.execPath}\n${fs.readFileSync(path.join(repo, "e2e", "helpers", "fake-apple-helper.cjs"), "utf8")}`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "mode"), mode);
  fs.writeFileSync(path.join(dir, "onionskin-fm.json"), JSON.stringify({ sha256: crypto.createHash("sha256").update(fs.readFileSync(bin)).digest("hex") }));
  return dir;
}

/**
 * Real Chrome by default. ONIONSKIN_BROWSER=webkit runs Playwright's WebKit build instead (the engine Safari uses, not the Safari app; `npm run test:webkit`).
 * ONIONSKIN_WEBKIT_EXECUTABLE points at another pw_run.sh when the build playwright-core expects is not installed.
 */
export const WEBKIT = process.env.ONIONSKIN_BROWSER === "webkit";
export const launchContext = (profile, opts = {}) =>
  WEBKIT
    ? webkit.launchPersistentContext(profile, { headless: true, ...(process.env.ONIONSKIN_WEBKIT_EXECUTABLE ? { executablePath: process.env.ONIONSKIN_WEBKIT_EXECUTABLE } : {}), ...opts })
    : chromium.launchPersistentContext(profile, { channel: "chrome", headless: true, ...opts });

/** The key that moves focus to the next control. Safari (and WebKit) skip buttons on plain Tab unless "Press Tab to highlight each item" is on; Option+Tab always reaches them. */
export const TAB = WEBKIT ? "Alt+Tab" : "Tab";

/**
 * Emulates prefers-reduced-transparency ("reduce" or "no-preference"). Only Chromium can (CDP); Playwright WebKit has no such switch, so this returns false
 * there and the caller skips the part that needs it.
 */
export async function emulateReducedTransparency(ctx, page, value) {
  if (WEBKIT) return false;
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-transparency", value }] });
  return true;
}

/** Fresh profile. Collects console messages and page errors. */
export async function launch() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "da-chrome-"));
  const ctx = await launchContext(profile, { viewport: { width: 1500, height: 900 }, acceptDownloads: true });
  const log = { console: [], errors: [] }; // all pages
  ctx.on("page", (p) => {
    p.log = { console: [], errors: [] }; // this page only
    const c = (type, text) => (log.console.push({ type, text }), p.log.console.push({ type, text }));
    p.on("console", (m) => c(m.type(), m.text()));
    p.on("pageerror", (e) => (log.errors.push(e.message), p.log.errors.push(e.message)));
    p.on("response", (r) => r.status() >= 400 && c("http", `${r.status()} ${r.url().replace(/n=[^&]*/, "n=<nonce>")}`));
  });
  return {
    ctx, log,
    async page() {
      const p = await ctx.newPage();
      return p;
    },
    async close() {
      await ctx.close();
      fs.rmSync(profile, { recursive: true, force: true });
    },
  };
}

export const cspViolations = (log) => log.console.filter((m) => /content security policy|refused to (load|execute|connect|create|apply)/i.test(m.text));

/** Wait until the engine host is up inside the page and the document is rendered. */
export async function waitDoc(page, probe = ".de-p, .de-sheet, .de-slide, [data-sid]") {
  await page.waitForSelector('[data-testid="docwrap"] ' + probe.split(",")[0].trim(), { timeout: 30000 }).catch(() => {});
  await page.waitForFunction(() => document.querySelector('[data-testid="state-pill"]'), null, { timeout: 30000 });
}

export function agentEdit(args) {
  return execFileSync(python, [path.join(repo, "e2e", "helpers", "agent_edit.py"), ...args], { encoding: "utf8" });
}

// ---- page helpers --------------------------------------------------------------------------------------------
/**
 * The key that puts the caret at the end of its line. Not "End" on a Mac: there it means "scroll to the end of the document"
 * (the caret stays), and a test that types right after it races the scroll.
 */
export const LINE_END = process.platform === "darwin" ? "Meta+ArrowRight" : "End";

export const para = (page, text) => page.locator(".de-p", { hasText: text }).first();

/** Scroll the engine's scroller until a paragraph containing `text` is rendered, then return its locator. */
export async function scrollToPara(page, text, guess = 0.5) {
  const loc = para(page, text);
  for (let i = 0; i < 40; i++) {
    if ((await page.locator(".de-p", { hasText: text }).count()) > 0) {
      await loc.scrollIntoViewIfNeeded();
      await page.waitForTimeout(150);
      return loc;
    }
    await page.evaluate((g) => {
      const s = document.querySelector(".de-scroll");
      s.scrollTop = Math.max(0, s.scrollHeight * g - 300);
    }, guess);
    await page.waitForTimeout(400);
    guess += (i % 2 ? 1 : -1) * 0.004 * (i + 1);
  }
  throw new Error(`paragraph "${text}" never rendered`);
}

export async function boxOf(locator) {
  const b = await locator.boundingBox();
  if (!b) throw new Error("no bounding box");
  return b;
}

export async function readZipText(file, part) {
  const { openZip } = await import(path.join(repo, "src", "zip.js"));
  return openZip(fs.readFileSync(file)).readText(part);
}

/** Bounding box relative to the top of the document viewport (immune to banner/chrome layout changes above it). */
export async function relBox(page, locator) {
  const b = await boxOf(locator);
  const top = await page.evaluate(() => document.querySelector('[data-testid="docwrap"]').getBoundingClientRect().top);
  return { ...b, y: b.y - top };
}

// ---- XLSX / PPTX page helpers ---------------------------------------------------------------------------------
export const center = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
export const srcModule = (name) => import(path.join(repo, "src", name));

/** Open a sheet tab and wait until its cells are rendered. */
export async function openSheet(page, name) {
  await page.locator(".de-tab", { hasText: new RegExp(`^${name}$`) }).click();
  await page.waitForTimeout(900);
}

/** Viewport box of the cell in the row whose first cell reads `rowText`, at column letter `col`; null when that row is not rendered. */
export async function xlsxCell(page, rowText, col) {
  return page.evaluate(([rowText, col]) => {
    const regs = [...document.querySelectorAll(".de-grid-view .de-region")];
    const colRegion = regs.find((r) => [...r.children].some((e) => e.textContent === "A") && [...r.children].some((e) => e.textContent === "B"));
    const head = [...(colRegion?.children || [])].find((e) => e.textContent === col);
    const row = [...document.querySelectorAll(".de-cell")].find((e) => e.textContent === rowText);
    if (!head || !row) return null;
    const h = head.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    return { x: h.left, y: r.top, w: h.width, h: r.height };
  }, [rowText, col]);
}

/** Scroll the grid until the row labelled `rowText` is rendered, near the top (so a range below it fits too). */
export async function xlsxScrollTo(page, rowText, topRow) {
  await page.evaluate((top) => {
    const g = document.querySelector(".de-grid");
    g.scrollTop = top * 20;
  }, topRow);
  for (let i = 0; i < 20 && !(await xlsxCell(page, rowText, "A")); i++) await page.waitForTimeout(150);
}

/** The number of the first scrolling row shown (the row headers are the engine's own). */
export const xlsxTopRow = (page) =>
  page.evaluate(() => {
    const regs = [...document.querySelectorAll(".de-grid-view .de-region")];
    const g = document.querySelector(".de-grid-view").getBoundingClientRect();
    const rowRegion = regs.filter((r) => r.children.length > 8 && /^\d+$/.test(r.children[0]?.textContent || "")).sort((a, b) => b.children.length - a.children.length)[0];
    const rows = [...(rowRegion?.children || [])].filter((e) => e.textContent && e.getBoundingClientRect().top >= g.top + 30);
    return rows.length ? Number(rows[0].textContent) : null;
  });

export const activeSheetName = (page) => page.evaluate(() => document.querySelector(".de-tab[aria-selected=\"true\"]")?.textContent ?? null);

/** Slide frame / shape boxes in the viewport. */
export const gotoSlide = async (page, n) => {
  for (let attempt = 0; attempt < 4; attempt++) {
    await page.locator(".de-thumb").nth(n - 1).click();
    for (let i = 0; i < 12; i++) {
      await page.waitForTimeout(250);
      if ((await visibleSlide(page)) === n) {
        await page.waitForTimeout(400);
        return;
      }
    }
  }
  throw new Error(`could not bring slide ${n} into view`);
};
export const slideBox = (page, n) =>
  page.evaluate((n) => {
    const f = document.querySelector(`.de-slide-frame[data-slide="${n}"] .de-slide`);
    if (!f) return null;
    const r = f.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }, n);
export const shapeBox = (page, n, sid) =>
  page.evaluate(([n, sid]) => {
    const e = document.querySelector(`.de-slide-frame[data-slide="${n}"] [data-sid="${sid}"]`);
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }, [n, sid]);
export const visibleSlide = (page) =>
  page.evaluate(() => {
    const sc = document.querySelector(".de-scroll").getBoundingClientRect();
    let cur = null;
    for (const f of document.querySelectorAll(".de-slide-frame")) if (f.getBoundingClientRect().top <= sc.top + sc.height / 3 + 1) cur = Number(f.dataset.slide);
    return cur;
  });

export const boxCenterDist = (a, b) => Math.hypot(a.x + a.w / 2 - (b.x + b.w / 2), a.y + a.h / 2 - (b.y + b.h / 2));
export const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Waits until `fn` returns truthy (polling in node, so it can use any helper above). */
export async function until(fn, what, ms = 25000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${what}${last instanceof Error ? `: ${last.message}` : ""}`);
}

/** Viewport point at the middle of `word` (or just past its right edge with `edge`) inside shape `sid` of slide `n` (the first text node that holds it). */
export const wordPoint = (page, n, sid, word, edge = false) =>
  page.evaluate(([n, sid, word, edge]) => {
    const root = document.querySelector(`.de-slide-frame[data-slide="${n}"] [data-sid="${sid}"]`);
    if (!root) return null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      const i = t.textContent.indexOf(word);
      if (i < 0) continue;
      const r = document.createRange();
      r.setStart(t, i);
      r.setEnd(t, i + word.length);
      const b = r.getBoundingClientRect();
      return { x: edge ? b.right + 2 : b.left + b.width / 2, y: b.top + b.height / 2 };
    }
    return null;
  }, [n, sid, word, edge]);

/**
 * XLSX: the numbered cell flags that overlap the text of a rendered cell. Glyph boxes are the text ranges' client rects, shrunk 3 px
 * top and bottom (a range box is the font's content area, a little taller than the digits). Empty list = no flag covers cell text.
 */
export const xlsxFlagsCoveringText = (page) =>
  page.evaluate(() => {
    const boxes = [...document.querySelectorAll('[data-testid="marker"].xl > span')].map((e) => ({ n: e.textContent, r: e.getBoundingClientRect() }));
    const hits = [];
    for (const cell of document.querySelectorAll(".de-cell")) {
      if (!cell.textContent.trim()) continue;
      const rg = document.createRange();
      rg.selectNodeContents(cell);
      for (const t of rg.getClientRects()) {
        if (t.width < 1) continue;
        for (const b of boxes) {
          const ox = Math.min(b.r.right, t.right) - Math.max(b.r.left, t.left);
          const oy = Math.min(b.r.bottom, t.bottom - 3) - Math.max(b.r.top, t.top + 3);
          if (ox > 0.5 && oy > 0.5) hits.push({ flag: b.n, cell: cell.textContent.slice(0, 20) });
        }
      }
    }
    return { flags: boxes.length, hits };
  });
