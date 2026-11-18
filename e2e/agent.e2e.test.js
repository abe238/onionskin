import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { launch, makeWorld, readZipText, waitDoc } from "./helpers/harness.mjs";
import { fakeClaudeDir, startFakeSide } from "./helpers/fake-side.mjs";

// The invisible (background) agent as the page shows it. Part 1 puts a small stand-in for the server half in front of the real server (helpers/fake-side.mjs)
// and drives the page through every state and a whole round with a fake `claude` binary. Part 2 runs the same round against the real runner and is skipped
// until src/agent-runner.js exists. Temp state folder and a copy of a fixture only.
const q = (id) => `[data-testid="${id}"]`;
const text = (page, id) => page.locator(q(id)).textContent();
const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const pidsOf = (dir) => (fs.existsSync(path.join(dir, "pids")) ? fs.readFileSync(path.join(dir, "pids"), "utf8").split("\n").filter(Boolean).map(Number) : []);

let br;
before(async () => {
  br = await launch();
});
after(async () => {
  await br?.close();
});

async function world(name) {
  const w = makeWorld();
  const file = w.doc(name);
  fs.copyFileSync(w.doc("long.docx"), file);
  const dir = fakeClaudeDir(w.root);
  const side = await startFakeSide(w);
  const page = await br.page();
  await page.goto(side.url(await w.open(file)));
  await waitDoc(page);
  return {
    w, file, dir, side, page,
    async end() {
      await page.close();
      await side.stop();
      await w.cleanup();
    },
  };
}
async function sendNote(page, note = "Please tidy up.") {
  await page.locator(q("overall-note")).fill(note);
  await page.locator(q("send")).click();
}

describe("the page, with a stand-in for the server half", () => {
  test("a Send with nobody listening shows Start (no command line); Start runs the agent, which answers; Show the agent lists what it did", async () => {
    const t = await world("agent-flow.docx");
    try {
      const { page, side, w, file, dir } = t;
      side.useRunner(dir, fs.realpathSync(file));
      await sendNote(page);
      await page.locator(q("banner-stranded")).waitFor({ timeout: 10000 });
      const banner = await text(page, "banner-stranded");
      assert.match(banner, /Your batch is saved, but no agent is listening/);
      assert.ok(!/onionskin poll|stranded-command/.test(banner) && (await page.locator(q("stranded-command")).count()) === 0, "the old command line is gone");
      assert.equal(await page.locator(q("agent-panel")).count(), 0, "no panel before there is a background agent");
      await page.locator(q("agent-start")).click();
      // the fake claude polls, gets the batch, replies; the page shows the change and goes back to listening
      await page.waitForFunction(() => document.body.textContent.includes("Paragraph THREE:"), null, { timeout: 30000 });
      assert.match(await readZipText(file, "word/document.xml"), /Paragraph THREE:/);
      await page.locator(q("banner-listening")).waitFor({ timeout: 15000 });
      assert.equal(await page.locator(q("agent-panel")).count(), 1);
      assert.equal((await text(page, "agent-status")).trim(), "Listening");
      assert.equal(await page.locator(q("agent-activity")).count(), 0, "the list is hidden until the switch is on");
      await page.locator(q("agent-show-label")).click();
      const list = page.locator(q("agent-activity"));
      await list.waitFor();
      const lines = (await page.locator(q("agent-line")).allTextContents()).join("\n");
      for (const want of ["Reading the instructions", "Waiting for you to press Send", "Got your batch", "Writing the changes", "Making the changes", "Done. The page shows what changed"]) assert.ok(lines.includes(want), `"${want}" in the list:\n${lines}`);
      assert.ok(!/Paragraph|tidy/.test(lines), "no document text in the list");
      assert.match(await text(page, "agent-transcript"), /saved on this Mac, private to you, and removed when you close this session/);
      assert.match(await text(page, "agent-terminal-hint"), /with the same limits, where it keeps listening for your Send\. Claude Code may first ask whether you trust the folder: choose Yes\. The background agent stops while it is open/);
      await page.locator(q("agent-terminal")).click();
      assert.deepEqual(side.actions.map((a) => a.action), ["start", "show", "terminal"]);
      assert.deepEqual(side.actions[1], { action: "show", on: true });
      await page.locator(q("agent-show-label")).click();
      await page.locator(q("agent-activity")).waitFor({ state: "detached" });
      // the agent is stopped with the session
      const pids = pidsOf(dir);
      assert.ok(pids.length >= 1);
      side.runner.stop();
      await page.waitForTimeout(800);
      assert.ok(pids.every((p) => !pidAlive(p)), "the fake agent is gone");
    } finally {
      await t.end();
    }
  });

  test("Show the agent: a pointer click on the switch itself (its track) turns it on and off", async () => {
    const t = await world("agent-track.docx");
    try {
      const { page, side } = t;
      side.setAgent({ state: "ready" });
      const track = page.locator(".agent-panel .ap-track");
      await track.waitFor();
      const click = async () => {
        const b = await track.boundingBox();
        await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2); // where a person clicks: the drawn switch, not the hidden input
      };
      await click();
      await page.waitForFunction(() => document.querySelector('[data-testid="agent-show-switch"]').checked, null, { timeout: 5000 });
      assert.deepEqual(side.actions, [{ action: "show", on: true }]);
      await click();
      await page.waitForFunction(() => !document.querySelector('[data-testid="agent-show-switch"]').checked, null, { timeout: 5000 });
      assert.deepEqual(side.actions.at(-1), { action: "show", on: false });
      assert.equal(side.actions.length, 2, "one action per click");
    } finally {
      await t.end();
    }
  });

  test("Show the agent: only the editing tab can use the switch", async () => {
    const t = await world("agent-ro.docx");
    try {
      t.side.setAgent({ state: "ready" });
      await t.page.locator(q("agent-show-switch")).waitFor({ state: "attached" });
      const other = await br.page();
      await other.goto(t.side.url(await t.w.open(t.file)));
      await other.locator(q("banner-readonly")).waitFor({ timeout: 10000 });
      assert.equal(await other.locator(q("agent-show-switch")).isDisabled(), true);
      await other.close();
    } finally {
      await t.end();
    }
  });

  const WORDS = {
    not_installed: [/No coding agent found on this Mac\. Onionskin needs Claude Code\. Install it and sign in, then press Try again\./, ["Try again"]],
    signed_out: [/Claude Code is installed but not signed in\. Sign in once in Terminal, then press Try again\./, ["Open Terminal to sign in", "Try again"]],
    limit: [/Your Claude plan's usage limit is reached, so the agent stopped\. Your batch is saved\. Try again later\./, ["Try again"]],
    crashed: [/The agent stopped unexpectedly\. Your batch is saved and nothing was lost\./, ["Restart the agent", "Show what happened"]],
    too_many_restarts: [/The agent keeps stopping, so Onionskin paused it\. Your batch is saved\./, ["Try again"]],
    refused: [/The agent tried to do something Onionskin does not allow, so it stopped\. Nothing was written\. Your batch is saved\./, ["Send again", "Show what happened"]],
  };
  test("every failure shows its plain words and its buttons; each button posts one action", async () => {
    const t = await world("agent-fail.docx");
    try {
      const { page, side } = t;
      for (const [code, [words, buttons]] of Object.entries(WORDS)) {
        side.setAgent({ state: "failed", failure: { code } });
        const b = page.locator(q(`banner-agent-${code}`));
        await b.waitFor({ timeout: 5000 });
        const t1 = await b.textContent();
        assert.match(t1, words, code);
        assert.deepEqual(await b.locator("button").allTextContents(), buttons, code);
        assert.ok(!/\b(exit code|pid|holder|signed_out|too_many_restarts|json|ENOENT)\b/i.test(t1), `no technical words in ${code}: ${t1}`);
      }
      side.setAgent({ state: "failed", failure: { code: "not_installed", codex: true } });
      await page.waitForFunction(() => /Codex is on this Mac\. To work on this file, say to Codex: open this file in Onionskin\./.test(document.querySelector('[data-testid="banner-agent-not_installed"]')?.textContent || ""), null, { timeout: 5000 });
      side.setAgent({ state: "failed", failure: { code: "not_installed", update: true } });
      await page.waitForFunction(() => /too old for Onionskin\. Update Claude Code, then press Try again\./.test(document.querySelector('[data-testid="banner-agent-not_installed"]')?.textContent || ""), null, { timeout: 5000 });
      side.setAgent({ state: "failed", failure: { code: "limit", resetsAt: Date.now() + 3600e3 } });
      assert.match(await page.locator(q("banner-agent-limit")).textContent(), /The limit resets at .*\d:\d\d/);
      assert.ok(!/Try again later/.test(await page.locator(q("banner-agent-limit")).textContent()));
      side.actions.length = 0;
      side.setAgent({ state: "failed", failure: { code: "crashed" } });
      await page.locator(q("agent-start")).click();
      await page.locator(q("agent-show")).click();
      assert.deepEqual(side.actions, [{ action: "start" }, { action: "show", on: true }]);
      side.setAgent({ state: "failed", failure: { code: "signed_out" } });
      side.actions.length = 0;
      await page.locator(q("agent-terminal")).click();
      assert.deepEqual(side.actions, [{ action: "terminal" }]);
    } finally {
      await t.end();
    }
  });

  test("starting, handover and a session without a background agent", async () => {
    const t = await world("agent-states.docx");
    try {
      const { page, side } = t;
      side.setAgent({ state: "starting" });
      assert.match(await page.locator(q("banner-agent-starting")).textContent(), /^Getting the agent ready\.\.\.$/);
      await sendNote(page);
      await page.waitForFunction(() => /Starting the agent for your batch/.test(document.querySelector('[data-testid="banner-agent-starting"]')?.textContent || ""), null, { timeout: 10000 });
      assert.match(await page.locator(q("banner-agent-starting")).textContent(), /^Starting the agent for your batch\.\.\.$/);
      assert.equal(await page.locator(q("banner-stranded")).count(), 0, "one message, not two");
      side.setAgent({ state: "starting", busy: true });
      await page.waitForFunction(() => /^Getting the agent ready\.\.\. Another document's agent is busy\.$/.test(document.querySelector('[data-testid="banner-agent-starting"]')?.textContent || ""), null, { timeout: 5000 });
      side.setAgent({ state: "handover" });
      assert.match(await page.locator(q("banner-agent-handover")).textContent(), /The agent is open in Terminal\. If Claude Code asks whether you trust the folder, choose Yes: it is Onionskin's own folder for this file\. The agent then keeps working from there\./);
      assert.equal(await page.locator(q("agent-terminal")).count(), 0);
      side.setAgent({ state: "external" });
      await page.locator(q("agent-panel")).waitFor({ state: "detached" });
    } finally {
      await t.end();
    }
  });
});

describe("the real runner with a fake claude on PATH", { skip: !fs.existsSync(new URL("../src/agent-runner.js", import.meta.url)) && "src/agent-runner.js is not in this tree yet" }, () => {
  // Same file as the design's section 9.4: the fake answers `auth status --json` and, in -p mode, prints stream-json while it runs the real poll and reply.
  async function real(name, mode = "") {
    const w = makeWorld({ ONIONSKIN_AGENT_CLI: "claude", ONIONSKIN_AGENT_PATH: "" });
    const dir = fakeClaudeDir(w.root);
    w.env.ONIONSKIN_AGENT_PATH = dir;
    const home = path.join(w.root, "home"); // a temp HOME: the runner passes it to the agent, and nothing reaches the real one
    fs.mkdirSync(home);
    w.env.HOME = home;
    w.env.ONIONSKIN_OPEN_STUB = path.join(w.root, "opened.txt"); // Open in Terminal records the file instead of opening Terminal
    if (mode) fs.writeFileSync(path.join(dir, "mode"), mode);
    const file = w.doc(name);
    fs.copyFileSync(w.doc("long.docx"), file);
    const page = await br.page();
    await page.goto(await w.open(file));
    await waitDoc(page);
    return { w, file, dir, page, end: async () => (await page.close(), await w.cleanup()) };
  }
  test("Start runs the agent, the change shows, Close session ends it", async () => {
    const t = await real("agent-real.docx");
    try {
      await sendNote(t.page);
      await t.page.locator(q("agent-start")).click();
      await t.page.waitForFunction(() => document.body.textContent.includes("Paragraph THREE:"), null, { timeout: 40000 });
      await t.page.locator(q("agent-show-label")).click();
      await t.page.locator(q("agent-line")).first().waitFor({ timeout: 5000 });
      const lines = (await t.page.locator(q("agent-line")).allTextContents()).join("\n");
      assert.ok(!/Paragraph|tidy/.test(lines), "no document text in the list");
      assert.match(lines, /Waiting for you to press Send/);
      assert.match(lines, /Making the changes/);
      const pids = pidsOf(t.dir);
      assert.ok(pids.length >= 1, "the fake was started");
      await t.page.locator(q("close")).click();
      const ask = t.page.locator(q("close-anyway")); // the page asks first when edits are unsent
      if (await ask.isVisible().catch(() => false)) await ask.click();
      await t.page.locator(q("banner-closed")).waitFor({ timeout: 10000 });
      for (let i = 0; i < 40 && pids.some(pidAlive); i++) await t.page.waitForTimeout(250);
      assert.ok(pids.every((p) => !pidAlive(p)), "the fake's pid is gone after Close session");
      const agents = path.join(t.w.env.ONIONSKIN_STATE_DIR, "agents");
      for (let i = 0; i < 40 && fs.readdirSync(agents).some((n) => /^[0-9a-f]{16}$/.test(n)); i++) await t.page.waitForTimeout(250);
      assert.deepEqual(fs.readdirSync(agents).filter((n) => /^[0-9a-f]{16}(\.json)?$/.test(n)), [], "its folder (transcript) and record are removed");
      for (let i = 0; i < 40 && !fs.existsSync(path.join(t.dir, "purged")); i++) await t.page.waitForTimeout(250);
      assert.ok(fs.existsSync(path.join(t.dir, "purged")), "Claude Code's own copy is purged");
    } finally {
      await t.end();
    }
  });
  test("Stop on the real server: drafts back, one signal, the late write refused, the file unchanged, the next Send starts a fresh conversation without a counted start", async () => {
    const t = await real("agent-real-stop.docx", "hold");
    const crypto = await import("node:crypto");
    const sha = () => crypto.createHash("sha256").update(fs.readFileSync(t.file)).digest("hex");
    const lines = (f) => (fs.existsSync(path.join(t.dir, f)) ? fs.readFileSync(path.join(t.dir, f), "utf8").split("\n").filter(Boolean) : []);
    // the agent's view as the page's own request reads it (the page does not show startsLeft)
    const agentView = () =>
      t.page.evaluate(async () => {
        const sid = new URLSearchParams(location.search).get("s");
        const token = sessionStorage.getItem(`onionskin.token.${sid}`) || "";
        const r = await fetch(`/api/bootstrap?s=${sid}`, { headers: { "x-onionskin-token": token } });
        return (await r.json()).session.agent;
      });
    try {
      const before = sha();
      // one comment and the note
      await t.page.locator(q("mode-comment")).click();
      const p8 = t.page.locator(".de-p", { hasText: "Paragraph 008:" }).first();
      await p8.scrollIntoViewIfNeeded();
      const b8 = await p8.boundingBox();
      await t.page.mouse.click(b8.x + Math.min(b8.width / 2, 200), b8.y + 8);
      await t.page.locator(q("comment-card") + " textarea").last().fill("Is this still current?");
      await t.page.waitForTimeout(500);
      await sendNote(t.page, "Please tidy up.");
      await t.page.locator(q("agent-start")).click();
      for (let i = 0; i < 160 && !fs.existsSync(path.join(t.dir, "held")); i++) await t.page.waitForTimeout(250);
      assert.ok(fs.existsSync(path.join(t.dir, "held")), "the fake holds the batch");
      await t.page.locator(q("agent-stop")).waitFor({ timeout: 10000 });
      assert.equal(await t.page.locator(q("take-back")).count(), 0, "no Take back beside Stop for the background agent");
      const left = (await agentView()).startsLeft;
      assert.equal(left, 4, "one counted start so far");
      const pids = pidsOf(t.dir);
      await t.page.locator(q("agent-stop")).click();
      await t.page.locator(q("banner-working")).waitFor({ state: "detached", timeout: 10000 });
      await t.page.waitForFunction(() => document.querySelector('[data-testid="overall-note"]')?.value === "Please tidy up.", null, { timeout: 10000 }); // the note is back in the box
      await t.page.waitForFunction(() => document.querySelector('[data-testid="comment-card"]')?.dataset.status === "draft", null, { timeout: 10000 }); // the comment is a draft again
      assert.equal(await t.page.locator(q("comment-card") + " textarea").first().inputValue(), "Is this still current?");
      for (let i = 0; i < 80 && !fs.existsSync(path.join(t.dir, "late.json")); i++) await t.page.waitForTimeout(250);
      const late = JSON.parse(fs.readFileSync(path.join(t.dir, "late.json"), "utf8"));
      assert.notEqual(late.status, 0, `the late write is refused: ${late.stdout}${late.stderr}`);
      assert.equal(JSON.parse(late.stdout).code, "stale_batch", "refused because the batch was taken back");
      for (let i = 0; i < 40 && pids.some(pidAlive); i++) await t.page.waitForTimeout(250);
      assert.ok(pids.every((p) => !pidAlive(p)), "the held agent is gone");
      await t.page.waitForTimeout(5000); // longer than the runner's kill delay: a second signal would land in this window
      assert.deepEqual(lines("signals"), ["SIGTERM"], "exactly one termination signal");
      assert.equal(sha(), before, "the file is unchanged");
      assert.ok(!(await readZipText(t.file, "word/document.xml")).includes("Paragraph LATE:"));
      assert.equal((await agentView()).state, "none");
      // the next Send: a fresh conversation (the stopped one held the withdrawn batch), at once, not counted
      fs.rmSync(path.join(t.dir, "mode"));
      await t.page.locator(q("send")).click();
      await t.page.waitForFunction(() => document.body.textContent.includes("Paragraph THREE:"), null, { timeout: 40000 });
      assert.deepEqual(lines("starts"), ["fresh", "fresh"]);
      assert.equal((await agentView()).startsLeft, left, "the restart after Stop used no counted start");
    } finally {
      await t.end();
    }
  });
  test("signed out: the signed_out banner", async () => {
    const t = await real("agent-real-so.docx", "signed_out");
    try {
      await sendNote(t.page);
      await t.page.locator(q("agent-start")).click();
      await t.page.locator(q("banner-agent-signed_out")).waitFor({ timeout: 20000 });
    } finally {
      await t.end();
    }
  });
  test("the agent exits mid-batch: the batch is handed back and the page unlocks within 5 s", async () => {
    const t = await real("agent-real-crash.docx", "crash");
    try {
      await sendNote(t.page);
      await t.page.locator(q("agent-start")).click();
      // the fake exits the moment the batch arrives (the working banner may show for only a moment): the durable outcome is the batch back
      // and the page unlocked within 5 s of that exit, not after the 15-minute lease
      for (let i = 0; i < 80 && !pidsOf(t.dir).length; i++) await t.page.waitForTimeout(250);
      assert.ok(pidsOf(t.dir).length >= 1, "the fake was started");
      const t0 = Date.now();
      await t.page.waitForFunction(() => document.body.textContent.includes("The agent stopped responding"), null, { timeout: 15000 });
      await t.page.locator(q("banner-working")).waitFor({ state: "detached", timeout: 5000 });
      assert.ok(Date.now() - t0 < 15000);
      await t.page.locator(q("banner-agent-starting")).waitFor({ timeout: 5000 }); // and it is starting again (backoff), not silent
    } finally {
      await t.end();
    }
  });
  test("the plan's limit is reached mid-batch: the limit words with the reset time, the batch is kept, Try again finishes it", async () => {
    const t = await real("agent-real-limit.docx", "limit");
    try {
      await sendNote(t.page);
      await t.page.locator(q("agent-start")).click();
      const b = t.page.locator(q("banner-agent-limit"));
      await b.waitFor({ timeout: 20000 });
      assert.match(await b.textContent(), /Your Claude plan's usage limit is reached, so the agent stopped\. Your batch is saved\. The limit resets at .*\d:\d\d/);
      await t.page.locator(q("banner-working")).waitFor({ state: "detached", timeout: 5000 }); // the page is not left locked
      const before = pidsOf(t.dir).length;
      await t.page.waitForTimeout(4000);
      assert.equal(pidsOf(t.dir).length, before, "a limit never restarts by itself");
      fs.rmSync(path.join(t.dir, "mode")); // the limit has reset
      await b.getByRole("button", { name: "Try again" }).click();
      await t.page.waitForFunction(() => document.body.textContent.includes("Paragraph THREE:"), null, { timeout: 40000 }); // the saved batch is done
      await b.waitFor({ state: "detached", timeout: 5000 });
    } finally {
      await t.end();
    }
  });
  test("a second agent polling with another holder: the fake is not started", async () => {
    const t = await real("agent-real-foreign.docx");
    try {
      const poll = t.w.spawnCli(["poll", t.file, "--timeout", "20"]);
      await t.page.locator(q("banner-listening")).waitFor({ timeout: 10000 });
      await t.page.waitForTimeout(1500);
      assert.deepEqual(pidsOf(t.dir), [], "no fake started");
      poll.child.kill("SIGKILL");
    } finally {
      await t.end();
    }
  });
});
