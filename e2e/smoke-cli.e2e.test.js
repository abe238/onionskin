import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { CORPUS as CORPUS_DIR, skipUnless, cspViolations, launch, makeWorld, readZipText, until, waitDoc } from "./helpers/harness.mjs";

// The loop as a user runs it: the globally linked `onionskin` binary (npm link), a real Word file from the engine's corpus cache,
// a real Chrome. State and the document copy live in temp dirs; the real home and the corpus are only read.

const CORPUS = path.join(CORPUS_DIR, "60316.docx");
const bin = spawnSync("/bin/sh", ["-c", "command -v onionskin"], { encoding: "utf8" }).stdout.trim();
const skip = !bin ? "onionskin is not linked on PATH (run `npm link` in the repository)" : skipUnless(fs.existsSync(CORPUS), `${CORPUS} is missing`);
const FIRST = "Getting the perfect job might be challenging";

describe("smoke: the linked onionskin binary, a real Word file, a real browser", { skip }, () => {
  let w, br, file, page, batch, poll;
  // the commands in the batch end in the delivery's `--lease <ticket>`; a command run for a delivered batch carries it
  const withTicket = (args) => (batch && ["apply", "done"].includes(args[0]) && !args.includes("--dry-run") ? [...args, "--lease", batch.next_step.match(/--lease (\S+)/)[1]] : args);
  const cli = (args0) =>
    new Promise((resolve) => {
      const args = withTicket(args0);
      const c = spawn(bin, args, { env: w.env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      c.stdout.on("data", (d) => (stdout += d));
      c.stderr.on("data", (d) => (stderr += d));
      c.on("close", (code) => resolve({ code, stdout, stderr }));
    });

  before(async () => {
    w = makeWorld({ ONIONSKIN_NO_SOFFICE: "1" });
    br = await launch();
    file = w.doc("resume.docx");
    fs.copyFileSync(CORPUS, file);
  });
  after(async () => {
    await br?.close();
    await w?.cleanup();
  });

  test("onionskin --version answers and `open --no-open` prints the URL and the poll command", async () => {
    const v = await cli(["--version"]);
    assert.match(v.stdout.trim(), /^\d+\.\d+\.\d+/);
    const o = await cli(["open", "--no-open", file]);
    assert.equal(o.code, 0, o.stderr);
    const url = o.stdout.split("\n").find((l) => l.startsWith("http://"));
    assert.ok(url, o.stdout);
    assert.match(o.stdout, /onionskin poll /);
    page = await br.page();
    poll = spawn(bin, ["poll", file], { env: w.env, stdio: ["ignore", "pipe", "pipe"] });
    poll.out = "";
    poll.on("close", (code) => (poll.code = code));
    poll.stdout.on("data", (d) => (poll.out += d));
    await page.goto(url);
    await waitDoc(page);
    await page.locator('[data-testid="banner-listening"]').waitFor({ timeout: 20000 });
  });

  test("the user adds a comment in the browser and presses Send; the poll prints the batch", async () => {
    await page.locator('[data-testid="mode-comment"]').click();
    const p = page.locator(".de-p", { hasText: FIRST }).first();
    await p.waitFor({ timeout: 20000 });
    await p.scrollIntoViewIfNeeded();
    const b = await p.boundingBox();
    await page.mouse.click(b.x + Math.min(b.width / 2, 200), b.y + 8); // a click in Comment mode comments on the paragraph under it
    await page.locator('[data-testid="comment-card"] textarea').last().fill("Make this opening more direct.");
    await page.locator('[data-testid="overall-note"]').fill("Keep the tone friendly.");
    await page.locator('[data-testid="send"]').click();
    await until(() => poll.code !== undefined, "the poll returned", 20000);
    assert.equal(poll.code, 0);
    batch = JSON.parse(poll.out);
    assert.equal(batch.schema, "onionskin.batch/1");
    assert.equal(batch.format, "docx");
    assert.equal(batch.instructions.overall_note, "Keep the tone friendly.");
    assert.equal(batch.instructions.comments.length, 1);
    assert.equal(batch.instructions.comments[0].text, "Make this opening more direct.");
    const a = batch.untrusted_document_evidence.anchors.find((x) => x.id === batch.instructions.comments[0].anchor_id);
    assert.ok(a.quote.startsWith(FIRST), a.quote);
    assert.equal(a.protected ?? false, false);
  });

  test("the agent applies an op built from the batch, then done", async () => {
    const c = batch.instructions.comments[0];
    const a = batch.untrusted_document_evidence.anchors.find((x) => x.id === c.anchor_id);
    const word = "challenging";
    assert.equal(a.quote.split(word).length - 1, 1, "the word occurs once in the paragraph");
    const ops = w.doc("ops.json");
    fs.writeFileSync(ops, JSON.stringify({ schema: "onionskin.ops/1", ops: [{ op: "replace_text", id: c.id, target: { anchor_id: a.id }, expect: { text_hash: a.locator.text_hash }, find: word, replace: "hard" }] }));
    const dry = await cli(["apply", file, "--ops", ops, "--dry-run"]);
    assert.equal(dry.code, 0, dry.stdout + dry.stderr);
    const before = fs.readFileSync(file);
    const r = await cli(["apply", file, "--ops", ops]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const report = JSON.parse(r.stdout);
    assert.equal(report.results[0].status, "applied");
    assert.notDeepEqual(fs.readFileSync(file), before, "the file on disk changed");
    assert.match(await readZipText(file, "word/document.xml"), /might be hard/);
    const results = w.doc("results.json");
    fs.writeFileSync(results, JSON.stringify({ summary: "Replaced one word in the opening sentence.", results: [{ comment_id: c.id, status: "done", note: "Swapped challenging for hard." }] }));
    const d = await cli(["done", file, "--results", results]);
    assert.equal(d.code, 0, d.stderr);
    const out = JSON.parse(d.stdout);
    assert.deepEqual(out.flags.filter((f) => f.severity === "error"), []);
  });

  test("the page reloads with the change and shows the activity entry; the comment is answered", async () => {
    await page.locator('[data-testid="activity-entry"]').first().waitFor({ timeout: 25000 });
    assert.match(await page.locator('[data-testid="activity-summary"]').last().textContent(), /Replaced one word/);
    assert.equal(await page.locator('[data-testid="comment-card"][data-status="done"]').count(), 1);
    assert.match(await page.locator('[data-testid="agent-note"]').first().textContent(), /Swapped challenging for hard/);
    await until(async () => (await page.locator(".de-p", { hasText: "might be hard" }).count()) > 0, "the reloaded page shows the new wording");
    assert.equal(await page.locator('[data-testid="comment-card"]').first().getAttribute("data-status"), "done");
    assert.equal(await page.locator('[data-testid="comment-card"]').first().getAttribute("data-resolved"), "ok", "the comment found its paragraph again");
    const st = JSON.parse((await cli(["status", file])).stdout);
    assert.equal(st.activity, 1);
  });

  test("zero CSP violations and zero page errors", () => {
    assert.deepEqual(cspViolations(br.log), []);
    assert.deepEqual(br.log.errors, []);
    assert.deepEqual(br.log.console.filter((m) => m.type === "error"), []);
    assert.equal(path.dirname(file), w.docs);
  });
});
