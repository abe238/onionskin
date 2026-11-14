import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { TAB, boxOf, cspViolations, launch, makeWorld, python, scrollToPara, waitDoc } from "./helpers/harness.mjs";

// "Turn on deeper checks": the review panel's one quiet line and its one button, from a fresh state dir with no checker.
// A stub script stands in for the base Python (no network): it makes a venv whose python passes the library probe and runs the real
// checker script with the repo's own Python. A flag file makes its pip step fail like a lost connection.
const SHOTS = process.env.DEEPER_SHOTS || ""; // set to a directory to keep a screenshot of each state
const FORBIDDEN = /python|lxml|venv|\bpip\b|ONIONSKIN_|setup-checker/i;

describe("deeper checks are turned on from the review panel", () => {
  let w, br, page, file, flag;

  before(async () => {
    w = makeWorld({ ONIONSKIN_PYTHON: "", ONIONSKIN_NO_SOFFICE: "1" });
    flag = path.join(w.root, "no-internet");
    const stub = path.join(w.root, "base-python.sh");
    fs.writeFileSync(stub, `#!/bin/sh
if [ "$1" = "-m" ] && [ "$2" = "venv" ]; then
  mkdir -p "$3/bin"
  cat > "$3/bin/python" <<'INNER'
#!/bin/sh
case "$*" in
  *"-m pip"*)
    if [ -f "${flag}" ]; then sleep 3; echo "WARNING: Failed to establish a new connection: Name or service not known" >&2; exit 1; fi
    sleep 3; touch "$(dirname "$0")/libs-installed"; exit 0 ;;
  *"-c import"*) [ -f "$(dirname "$0")/libs-installed" ]; exit $? ;;
esac
exec "${python}" "$@"
INNER
  chmod +x "$3/bin/python"
  exit 0
fi
exit 1
`, { mode: 0o755 });
    w.env.ONIONSKIN_BASE_PYTHON = stub;
    fs.writeFileSync(flag, "");
    br = await launch();
    file = w.doc("long.docx");
  });
  after(async () => {
    await br?.close();
    await w?.cleanup();
  });

  const shot = (name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `deeper-${name}.png`) });

  async function agentRound(text, find, replace) {
    const poll = w.spawnCli(["poll", file]);
    if (!page) {
      const url = await w.open(file);
      page = await br.page();
      await page.goto(url);
      await waitDoc(page);
    }
    await page.locator('[data-testid="banner-listening"]').waitFor({ timeout: 20000 });
    const before = await page.locator('[data-testid="activity-entry"]').count();
    const deep = await scrollToPara(page, "Paragraph 148:", 0.5);
    const db = await boxOf(deep);
    await page.mouse.dblclick(db.x + 150, db.y + 12);
    await page.locator('[data-testid="comment-chip"]').click();
    await page.locator('[data-testid="comment-card"] textarea').last().fill(text);
    await page.waitForTimeout(700);
    await page.locator('[data-testid="send"]').click();
    const res = await Promise.race([poll.done, new Promise((r) => setTimeout(() => r(null), 20000))]);
    assert.ok(res, "poll did not return after Send");
    const batch = JSON.parse(res.stdout);
    const c = batch.instructions.comments.at(-1);
    const r = await w.cli(["reply", file, "--lease", batch.lease_ticket, "--json", JSON.stringify({ summary: "Done.", replies: [{ comment: c.id, find, replace, note: "Reworded." }] })]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    await page.waitForFunction((n) => document.querySelectorAll('[data-testid="activity-entry"]').length > n, before, { timeout: 20000 });
    return JSON.parse(r.stdout);
  }

  test("a run without a checker shows one quiet line and one button, with no technical words, and the raw sentence only under Details", async () => {
    const out = await agentRound("Say 'brief note' instead of 'short note'.", "short note", "brief note");
    assert.match(out.checks_notice, /Deeper check skipped/, "agents still get the technical sentence");
    const box = page.locator('[data-testid="activity-entry"]').last().locator('[data-testid="deeper-checks"]');
    await box.waitFor({ timeout: 10000 });
    assert.equal((await box.locator('[data-testid="deeper-status"]').textContent()).trim(), "Basic checks passed. Deeper checks are off.");
    assert.equal(await box.locator('[data-testid="deeper-turn-on"]').textContent(), "Turn on deeper checks");
    assert.match(await box.locator('[data-testid="deeper-note"]').textContent(), /five small libraries once, about a minute\. Nothing from your documents is sent/);
    const visible = await page.locator('[data-testid="run-checks"]').last().innerText();
    assert.doesNotMatch(visible, FORBIDDEN, `visible text: ${visible}`);
    assert.equal(await page.locator('[data-testid="check-details"]').first().evaluate((d) => d.open), false, "Details is collapsed");
    assert.match(await page.locator('[data-testid="check-notice"]').first().textContent(), /Deeper check skipped/);
    assert.equal(await box.locator('[data-testid="deeper-status"]').getAttribute("role"), "status");
    await box.locator('[data-testid="deeper-note"]').scrollIntoViewIfNeeded();
    await shot("off");
  });

  test("the button is a real, focusable button with a visible focus ring", async () => {
    const btn = page.locator('[data-testid="deeper-turn-on"]');
    assert.equal(await btn.evaluate((b) => b.tagName), "BUTTON");
    await page.locator('[data-testid="check-details"] summary').first().focus();
    await page.keyboard.press("Shift+" + TAB);
    assert.ok(await btn.evaluate((b) => b === document.activeElement && b.matches(":focus-visible")), "reachable with Tab");
    const outline = await btn.evaluate((b) => getComputedStyle(b).outlineStyle + " " + getComputedStyle(b).outlineWidth);
    assert.match(outline, /solid [1-9]/);
  });

  test("Python missing: plain words and a Try again button", async () => {
    await page.route("**/api/setup-checker", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ state: "failed", reason: "no_python", detail: "python3 -m venv failed (spawn python3 ENOENT)" }) }));
    await page.locator('[data-testid="deeper-turn-on"]').click();
    const st = page.locator('[data-testid="deeper-status"]');
    await page.waitForFunction(() => /Python 3 was not found on this Mac/.test(document.querySelector('[data-testid="deeper-status"]')?.textContent || ""), null, { timeout: 5000 });
    assert.match(await st.textContent(), /Ask your agent to set it up, then try again/);
    assert.equal(await page.locator('[data-testid="deeper-turn-on"]').textContent(), "Try again");
    assert.equal(await page.locator('[data-testid="check-details"]').count(), 1, "one Details disclosure, not two");
    assert.equal(await page.locator('[data-testid="check-details"]').evaluate((d) => d.open), false);
    assert.match(await page.locator('[data-testid="deeper-details"]').textContent(), /ENOENT/);
    assert.doesNotMatch(await page.locator('[data-testid="deeper-checks"]').innerText(), /ENOENT/, "the technical text is not visible while Details is closed");
    await shot("failed-python");
    await page.unroute("**/api/setup-checker");
  });

  test("it fits a 320 px wide screen and reads in dark mode", async () => {
    await page.route("**/api/setup-checker", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ state: "failed", reason: "no_python", detail: "x" }) }));
    await page.setViewportSize({ width: 320, height: 640 });
    const theme = await page.evaluate(() => document.documentElement.dataset.theme || "");
    await page.evaluate(() => (document.documentElement.dataset.theme = "dark"));
    await page.waitForTimeout(400);
    if (!(await page.locator('[data-testid="sidebar"].open').count())) await page.locator('[data-testid="sidebar-toggle"]').first().click();
    await page.locator('[data-testid="sidebar"].open').waitFor();
    await page.waitForTimeout(500);
    const btn = page.locator('[data-testid="deeper-turn-on"]');
    await btn.scrollIntoViewIfNeeded();
    const b = await btn.boundingBox();
    assert.ok(b.x >= 0 && b.x + b.width <= 320, `button inside 320 px: ${JSON.stringify(b)}`);
    const box = await page.locator('[data-testid="deeper-checks"]').boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 320, `line inside 320 px: ${JSON.stringify(box)}`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= 320), true, "no horizontal page scroll");
    await shot("failed-320-dark");
    await page.evaluate((t) => (t ? (document.documentElement.dataset.theme = t) : delete document.documentElement.dataset.theme), theme);
    if (await page.locator('[data-testid="sidebar"].open').count()) await page.locator('[data-testid="sidebar-hide"]').click().catch(() => {});
    await page.setViewportSize({ width: 1500, height: 900 });
    await page.unroute("**/api/setup-checker");
    await page.waitForTimeout(300);
  });

  test("no internet: working state while it runs, then plain words; Try again succeeds once the connection is back", async () => {
    await page.locator('[data-testid="deeper-turn-on"]').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="deeper-checks"]')?.dataset.state === "working", null, { timeout: 5000 });
    assert.match(await page.locator('[data-testid="deeper-status"]').textContent(), /Setting up deeper checks, about a minute/);
    assert.equal(await page.locator('[data-testid="deeper-status"] .spinner').count(), 1);
    assert.equal(await page.locator('[data-testid="deeper-turn-on"]').count(), 0, "no second button while it runs");
    await shot("working");
    await page.waitForFunction(() => document.querySelector('[data-testid="deeper-checks"]')?.dataset.state === "failed", null, { timeout: 20000 });
    assert.match(await page.locator('[data-testid="deeper-status"]').textContent(), /no internet connection\. Connect, then try again/);
    await shot("failed-network");
    const visible = await page.locator('[data-testid="deeper-checks"]').innerText();
    assert.doesNotMatch(visible.replace(/Python 3 was not found on this Mac/, ""), FORBIDDEN, visible);
    fs.rmSync(flag);
    await page.locator('[data-testid="deeper-turn-on"]').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="deeper-checks"]')?.dataset.state === "on", null, { timeout: 30000 });
    assert.match(await page.locator('[data-testid="deeper-status"]').textContent(), /Deeper checks are on\. They run from your next Send\./);
    await shot("on");
  });

  test("the next run uses the deeper check with no restart, and neither run shows the line any more", async () => {
    const out = await agentRound("Say 'plain note' instead of 'brief note'.", "brief note", "plain note");
    assert.match(out.checks_notice, /Deeper check ran/, JSON.stringify(out));
    assert.equal(await page.locator('[data-testid="deeper-checks"]').count(), 0, "newest run ran the deeper check; the older run is not the newest");
  });

  test("zero CSP violations and zero page errors", async () => {
    assert.deepEqual(cspViolations(br.log), []);
    assert.deepEqual(br.log.errors, []);
  });
});
