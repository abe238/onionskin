// Browser and agent half of scripts/rehearse-clean-install.sh. TEST TOOLING ONLY, never shipped in the zip.
// Env in: REH_LAUNCHER (installed onionskin), REH_HOME (temp HOME), REH_PATH (reduced PATH), REH_SAMPLE (a COPY of sample.docx),
//         REH_PLAYWRIGHT (path to playwright-core/index.mjs). Prints one JSON line per step; exits 1 on the first failed step.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const { REH_LAUNCHER: bin, REH_HOME: home, REH_PATH: PATHV, REH_SAMPLE: sample, REH_PLAYWRIGHT: pw } = process.env;
for (const [k, v] of Object.entries({ REH_LAUNCHER: bin, REH_HOME: home, REH_PATH: PATHV, REH_SAMPLE: sample, REH_PLAYWRIGHT: pw })) if (!v) throw new Error(`${k} is not set`);
const { chromium } = await import(pathToFileURL(pw).href);
const env = { HOME: home, PATH: PATHV, ONIONSKIN_NO_SOFFICE: "1" };
const step = (name, ok, detail = "") => {
  console.log(JSON.stringify({ step: name, ok, detail }));
  if (!ok) throw new Error(`step failed: ${name} ${detail}`);
};
const cli = (args) =>
  new Promise((resolve) => {
    const c = spawn(bin, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    c.stdout.on("data", (d) => (stdout += d));
    c.stderr.on("data", (d) => (stderr += d));
    c.on("close", (code) => resolve({ code, stdout, stderr }));
  });
const until = async (fn, what, ms = 25000) => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out waiting for ${what}`);
};

let ctx, poll;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "reh-chrome-"));
try {
  const o = await cli(["open", sample, "--no-open"]);
  const url = o.stdout.split("\n").find((l) => l.startsWith("http://127.0.0.1"));
  step("open --no-open prints a 127.0.0.1 URL", o.code === 0 && !!url, url ? url.replace(/[?#].*/, "") : o.stderr);

  poll = spawn(bin, ["poll", sample], { env, stdio: ["ignore", "pipe", "pipe"] });
  poll.out = "";
  poll.on("close", (code) => (poll.code = code));
  poll.stdout.on("data", (d) => (poll.out += d));

  ctx = await chromium.launchPersistentContext(profile, { channel: "chrome", headless: true, viewport: { width: 1500, height: 900 } });
  const log = { console: [], errors: [] };
  const page = await ctx.newPage();
  page.on("console", (m) => log.console.push({ type: m.type(), text: m.text() }));
  page.on("pageerror", (e) => log.errors.push(e.message));
  page.on("response", (r) => r.status() >= 400 && log.console.push({ type: "http", text: `${r.status()} ${r.url().replace(/[?#].*/, "")}` }));
  await page.goto(url);
  await page.waitForSelector('[data-testid="docwrap"] .de-p', { timeout: 30000 });
  const first = await page.locator(".de-p").first().textContent();
  step("the page loads and the document is visible", first.trim().length > 0, `first paragraph: ${first.trim().slice(0, 50)}`);
  await page.locator('[data-testid="banner-listening"]').waitFor({ timeout: 20000 });
  step("the page shows an agent is listening", true);

  await page.locator('[data-testid="mode-comment"]').click();
  const p = page.locator(".de-p", { hasText: /\w{5,}/ }).first();
  await p.scrollIntoViewIfNeeded();
  const b = await p.boundingBox();
  await page.mouse.click(b.x + Math.min(b.width / 2, 200), b.y + 8);
  await page.locator('[data-testid="comment-card"] textarea').last().fill("Rehearsal comment: reword this.");
  await page.locator('[data-testid="overall-note"]').fill("Rehearsal overall note.");
  await page.locator('[data-testid="send"]').click();
  await until(() => poll.code !== undefined, "the poll to return");
  const batch = JSON.parse(poll.out);
  step("poll prints the batch after Send", poll.code === 0 && batch.schema === "onionskin.batch/1" && batch.instructions.comments.length === 1, `format ${batch.format}`);

  const lease = batch.next_step.match(/--lease (\S+)/)?.[1];
  const c = batch.instructions.comments[0];
  const a = batch.untrusted_document_evidence.anchors.find((x) => x.id === c.anchor_id);
  const word = (a.quote.match(/[A-Za-z]{5,}/g) || []).find((w) => a.quote.split(w).length - 1 === 1);
  let applied = false;
  if (word && lease) {
    const ops = path.join(path.dirname(sample), "ops.json");
    fs.writeFileSync(ops, JSON.stringify({ schema: "onionskin.ops/1", ops: [{ op: "replace_text", id: c.id, target: { anchor_id: a.id }, expect: { text_hash: a.locator.text_hash }, find: word, replace: "REHEARSED" }] }));
    const r = await cli(["apply", sample, "--ops", ops, "--lease", lease]);
    applied = r.code === 0 && JSON.parse(r.stdout).results[0].status === "applied";
    step("apply one op", applied, `replaced "${word}"; exit ${r.code} ${r.code ? r.stderr.slice(0, 200) : ""}`);
  } else step("apply one op", false, "no unique word or lease in the batch");
  const results = path.join(path.dirname(sample), "results.json");
  fs.writeFileSync(results, JSON.stringify({ summary: "Rehearsal: replaced one word.", results: [{ comment_id: c.id, status: "done", note: "Replaced one word." }] }));
  const d = await cli(["done", sample, "--results", results, "--lease", lease]);
  const dj = JSON.parse(d.stdout || "{}");
  step("done completes with no error flags", d.code === 0 && !(dj.flags || []).some((f) => f.severity === "error"), `exit ${d.code}; deeper check: ${JSON.stringify(dj.deeper_check ?? dj.checks ?? "n/a").slice(0, 120)}`);

  await page.locator('[data-testid="activity-entry"]').first().waitFor({ timeout: 25000 });
  step("the page reloads with the activity entry", /Rehearsal: replaced/.test(await page.locator('[data-testid="activity-summary"]').first().textContent()));
  await until(async () => (await page.locator(".de-p", { hasText: "REHEARSED" }).count()) > 0, "the new wording on the page");
  step("the reloaded page shows the edited text", true);

  const csp = log.console.filter((m) => /content security policy|refused to (load|execute|connect|create|apply)/i.test(m.text));
  const errs = log.console.filter((m) => m.type === "error");
  step("zero CSP violations, zero console errors, zero page errors", !csp.length && !errs.length && !log.errors.length, JSON.stringify({ csp: csp.length, consoleErrors: errs.length, pageErrors: log.errors.length, sample: [...errs, ...csp].slice(0, 2) }));
  await cli(["stop"]);
} catch (err) {
  console.log(JSON.stringify({ step: "ERROR", ok: false, detail: err.message }));
  process.exitCode = 1;
} finally {
  await ctx?.close().catch(() => {});
  if (poll && poll.code === undefined) poll.kill();
  fs.rmSync(profile, { recursive: true, force: true });
  process.exit(process.exitCode || 0);
}
