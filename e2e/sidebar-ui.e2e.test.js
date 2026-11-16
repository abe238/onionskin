import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, describe, test } from "node:test";
import { WEBKIT, agentEdit, boxOf, launch, makeWorld, scrollToPara, until, waitDoc } from "./helpers/harness.mjs";
import { startFakeSide } from "./helpers/fake-side.mjs";

// The wait made visible: Stop in the working banner, "Saved" on a draft card, the "Sent. Follow it in the review panel" chip, the words for the pending
// window, the progress line and the local counter. Runs against a stand-in for the server half of the background agent (helpers/fake-side.mjs, which also
// answers Stop the way the contract says). Temp state folder and a copy of a fixture only; no real agent.
const MAC = process.platform === "darwin";
const MODK = MAC ? "Meta" : "Control";
const q = (id) => `[data-testid="${id}"]`;
const text = async (page, id) => (await page.locator(q(id)).textContent()).trim();
const at = Date.now();
const line = (t, ago = 0) => ({ at: at - ago, text: t });

let br;
before(async () => {
  br = await launch();
});
after(async () => {
  await br?.close();
});

async function world(name, env = {}) {
  const w = makeWorld(env);
  const file = w.doc(name);
  fs.copyFileSync(w.doc("long.docx"), file);
  const side = await startFakeSide(w);
  const page = await br.page();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(side.url(await w.open(file)));
  await waitDoc(page);
  return {
    w, file, side, page,
    async end() {
      await page.close();
      await side.stop();
      await w.cleanup();
    },
  };
}
const selectWord = async (page, para, dx = 150) => {
  const p = await scrollToPara(page, para, Number(para.match(/\d+/)[0]) / 300);
  const b = await boxOf(p);
  await page.mouse.dblclick(b.x + dx, b.y + 12);
  await page.locator(q("comment-chip")).waitFor({ timeout: 5000 });
};
async function addComment(page, para, words) {
  await selectWord(page, para);
  await page.locator(q("comment-chip")).click();
  await page.keyboard.type(words);
}
/** One comment, Send, and an agent that polls and so holds the batch (the page then shows the working banner). */
async function deliver(t, words = "Make this shorter.", para = "Paragraph 015:") {
  const poll = t.w.spawnCli(["poll", t.file]);
  if (!(await t.page.locator(q("comment-card")).count())) await addComment(t.page, para, words);
  await t.page.waitForTimeout(500);
  await t.page.locator(q("send")).click();
  await t.page.locator(q("banner-working")).waitFor({ timeout: 15000 });
  return poll;
}
const WORKING = { state: "working", cli: "claude", show: false, failure: null, startsLeft: 4, activity: [line("Waiting for you to press Send", 9000), line("Got your batch: 1 comment", 3000), line("Reading the instructions", 2000)] };

describe("Stop and the working banner", () => {
  test("Stop takes the batch back: one POST, comments are drafts again, editing and Send work, the counter and the progress line show", async () => {
    const t = await world("sidebar-stop.docx");
    try {
      const { page, side } = t;
      side.setAgent(WORKING);
      await deliver(t);
      // the banner: stage words, the newest fixed-words line of THIS batch, a local counter outside the live speech, Stop named for what it does
      assert.equal(await text(page, "banner-stage"), "The agent has your batch");
      assert.equal(await text(page, "banner-progress-line"), "Reading the instructions");
      assert.equal(await page.locator(q("banner-elapsed")).getAttribute("aria-hidden"), "true");
      assert.match(await text(page, "banner-elapsed"), /^\d+ s$/);
      const first = await text(page, "banner-elapsed");
      await until(async () => (await text(page, "banner-elapsed")) !== first, "the counter to tick");
      const stop = page.locator(q("agent-stop"));
      assert.equal(await page.locator(q("take-back")).count(), 0, "with Stop shown there is no Take back that would leave the agent running");
      assert.equal(await stop.getAttribute("aria-label"), "Stop the agent and take back your comments");
      // top bar and review panel use the banner's words while the agent has the batch
      assert.equal(await text(page, "sync-state"), "The agent has your batch: keep editing");
      assert.equal(await text(page, "side-sub"), "The agent has your batch");
      assert.equal(await page.locator("#send-hint").textContent(), "The agent has your batch. Nothing new to send yet.");
      await page.locator(q("overall-note")).fill("Also keep it formal."); // typed while the agent has the first batch: it queues
      await until(async () => (await page.locator("#send-hint").textContent()) === "The agent has your batch. Your next batch waits until it finishes.", "the queue hint");
      await stop.click();
      await until(() => side.actions.some((a) => a.action === "stop"), "the stop request");
      assert.deepEqual(side.actions.filter((a) => a.action === "stop"), [{ action: "stop", takeBack: true }]);
      await page.locator(q("banner-working")).waitFor({ state: "detached", timeout: 10000 });
      const card = page.locator(q("comment-card")).first();
      await until(async () => (await card.getAttribute("data-status")) === "draft", "the comment to be a draft again");
      assert.match(await page.locator(q("overall-note")).inputValue(), /Also keep it formal\./, "the note typed while the agent worked is still in the box");
      // said once, and the keyboard focus moves on from the Stop button that went with its banner
      await until(async () => (await page.locator(`${q("notice")} > span`).textContent().catch(() => "")).trim() === "Stopped. Your comments are drafts again.", "the Stop notice");
      await until(() => page.evaluate(() => document.activeElement?.dataset?.testid === "send"), "focus on Send");
      const box = card.locator("textarea");
      assert.equal(await box.isDisabled(), false, "editable again");
      await box.fill("Make this much shorter.");
      // Stop, then restart: Send again reaches an agent that polls again
      const poll2 = t.w.spawnCli(["poll", t.file]);
      side.setAgent(WORKING);
      await page.waitForTimeout(500);
      await page.locator(q("send")).click();
      await page.locator(q("banner-working")).waitFor({ timeout: 15000 });
      assert.equal(await card.getAttribute("data-status"), "sent");
      poll2.child.kill("SIGKILL");
    } finally {
      await t.end();
    }
  });

  test("no restarts line, whatever startsLeft says; a refused Stop says so and the comments stay sent", async () => {
    const t = await world("sidebar-left.docx");
    try {
      const { page, side } = t;
      side.setAgent({ ...WORKING, startsLeft: 0 }); // a restart after Stop is not counted, so the count is never the person's business
      await deliver(t);
      assert.equal(await page.locator(q("agent-stop")).count(), 1);
      assert.ok(!/restart/i.test(await text(page, "banner-working")), "no restarts wording in the working banner");
      const { startsLeft, ...none } = WORKING; // an older server: the field is absent
      side.setAgent(none);
      await page.waitForTimeout(300);
      assert.equal(await page.locator(q("agent-stop")).count(), 1, "Stop still there");
      side.refuseStop = 409; // the real refusal: not_editor
      await page.locator(q("agent-stop")).click();
      await page.locator(q("banner-error")).waitFor({ timeout: 5000 });
      assert.equal(await page.locator(q("banner-working")).count(), 1, "nothing was taken back");
      assert.equal(await page.locator(q("comment-card")).first().getAttribute("data-status"), "sent");
    } finally {
      await t.end();
    }
  });

  test("Stop while the agent is writing: the stage shows, Stop still works", async () => {
    const t = await world("sidebar-write.docx");
    try {
      const { page, side } = t;
      side.setAgent(WORKING);
      await deliver(t);
      side.sessionPatch = { stage: "writing" };
      side.refresh();
      await until(async () => (await text(page, "banner-stage")) === "Writing your changes", "the writing stage");
      assert.equal(await text(page, "sync-state"), "Writing your changes: keep editing");
      side.sessionPatch = null;
      await page.locator(q("agent-stop")).click();
      await page.locator(q("banner-working")).waitFor({ state: "detached", timeout: 10000 });
      assert.deepEqual(side.actions.filter((a) => a.action === "stop"), [{ action: "stop", takeBack: true }]);
    } finally {
      await t.end();
    }
  });

  test("a session driven by the person's own agent: no Stop, the take back button only; nothing is signaled", async () => {
    const t = await world("sidebar-external.docx");
    try {
      const { page, side } = t;
      side.setAgent({ state: "external", cli: "claude", show: false, failure: null, activity: [] });
      await deliver(t);
      assert.equal(await page.locator(q("agent-stop")).count(), 0);
      assert.equal((await text(page, "take-back")), "Take back editing");
      await page.locator(q("take-back")).click();
      await page.locator(q("banner-working")).waitFor({ state: "detached", timeout: 10000 });
      assert.equal(side.actions.filter((a) => a.action === "stop").length, 0, "no stop request");
      assert.equal(await page.locator(q("comment-card")).first().getAttribute("data-status"), "draft");
    } finally {
      await t.end();
    }
  });

  test("a read-only second tab: no Stop and no Saved mark", async () => {
    const t = await world("sidebar-ro.docx");
    try {
      const { page, side } = t;
      side.setAgent(WORKING);
      await deliver(t);
      const second = await br.page();
      await second.setViewportSize({ width: 1440, height: 900 });
      await second.goto(side.url(await t.w.open(t.file)));
      await second.locator(q("banner-readonly")).waitFor({ timeout: 10000 });
      await second.locator(q("banner-working")).waitFor({ timeout: 10000 });
      assert.equal(await second.locator(q("agent-stop")).count(), 0, "no Stop in a read-only tab");
      assert.equal(await second.locator(q("card-ack")).count(), 0);
      assert.equal(await page.locator(q("agent-stop")).count(), 1, "the editing tab has it");
      await second.close();
    } finally {
      await t.end();
    }
  });

  test("lease expired: the batch is pending again, the top bar and the panel say so in words, no Stop and no counter", async () => {
    const t = await world("sidebar-lease.docx", { ONIONSKIN_LEASE_MS: "2500" });
    try {
      const { page, side } = t;
      side.setAgent({ state: "none", cli: "claude", show: false, activity: [], failure: null });
      const poll = await deliver(t);
      poll.child.kill("SIGKILL"); // the agent is gone and never renews
      await page.locator(q("banner-working")).waitFor({ state: "detached", timeout: 20000 });
      // not drafts (the plan said they were): the batch is pending again for the next poll, so the card still says Waiting
      assert.equal(await page.locator(q("comment-card")).first().getAttribute("data-status"), "sent");
      assert.equal(await text(page, "card-state"), "Waiting");
      assert.equal(await page.locator(q("agent-stop")).count(), 0);
      assert.equal(await text(page, "sync-state"), "Your batch is saved. Waiting for an agent");
      assert.equal(await text(page, "side-sub"), "Your batch is saved. Waiting for an agent");
      side.setAgent({ state: "starting", cli: "claude", show: false, activity: [], failure: null });
      await until(async () => (await text(page, "side-sub")) === "Starting the agent for your batch", "cold start words");
      side.setAgent({ state: "starting", busy: true, cli: "claude", show: false, activity: [], failure: null });
      await until(async () => (await text(page, "side-sub")).startsWith("Waiting for a free agent"), "slot full words");
    } finally {
      await t.end();
    }
  });
});

describe("Saved, Not saved, and the Quick ask chip", () => {
  test("a draft card says Saved after the autosave; a failed save says Not saved, tells you once, and tries again", async () => {
    const t = await world("sidebar-ack.docx");
    try {
      const { page } = t;
      await addComment(page, "Paragraph 015:", "First words.");
      const ack = page.locator(`${q("card-ack")}[data-ack]`);
      await until(async () => (await ack.getAttribute("data-ack").catch(() => null)) === "saved", "Saved");
      assert.equal((await ack.textContent()).trim(), "Saved");
      let fail = true;
      let hits = 0;
      await page.route("**/api/draft*", (r) => (fail ? (hits++, r.abort()) : r.continue()));
      await page.locator(`${q("comment-card")} textarea`).first().fill("Changed words.");
      await until(async () => (await ack.getAttribute("data-ack").catch(() => null)) === "failed", "Not saved");
      assert.equal((await ack.textContent()).trim(), "Not saved");
      assert.match(await text(page, "notice"), /could not be saved yet/);
      // leaving now asks first: the draft that failed to save is still unsent
      await page.locator(`${q("comment-card")} textarea`).first().click(); // a real click: the browser asks only after the person used the page
      const asked = new Promise((r) => page.once("dialog", (d) => (r(d.type()), d.dismiss())));
      await page.close({ runBeforeUnload: true });
      assert.equal(await Promise.race([asked, new Promise((r) => setTimeout(() => r("no dialog"), 5000))]), "beforeunload");
      fail = false;
      await until(async () => (await ack.getAttribute("data-ack").catch(() => null)) === "saved", "Saved again after the retry", 15000);
      assert.ok(hits >= 1);
    } finally {
      await t.end();
    }
  });

  test("Quick ask: after Cmd/Ctrl+Enter a chip says Sent; pressing it opens the panel, shows that card and puts the focus on it", async () => {
    const t = await world("sidebar-chip.docx");
    try {
      const { page } = t;
      const poll = t.w.spawnCli(["poll", t.file]);
      const shut = () => page.locator(q("sidebar")).evaluate((e) => e.inert);
      if (!(await shut())) await page.locator(q("sidebar-toggle")).click(); // the panel is shut when the box sends
      await until(shut, "the panel to shut");
      await selectWord(page, "Paragraph 020:");
      await page.keyboard.press(`${MODK}+Shift+K`);
      await page.locator(q("quick-ask")).waitFor({ timeout: 3000 });
      await page.keyboard.type("Tighten this.");
      await page.keyboard.press(`${MODK}+Enter`);
      await page.locator(q("notice-action")).waitFor({ timeout: 10000 });
      assert.equal((await page.locator(`${q("notice")} > span`).textContent()).trim(), "Sent. Follow it in the review panel");
      assert.equal(await page.locator(q("notice-action")).getAttribute("aria-label"), "Show it in the review panel");
      assert.equal(await shut(), true, "the panel was left alone until the chip is pressed");
      await page.locator(q("notice-action")).click();
      await until(async () => !(await shut()), "the panel to open");
      await until(() => page.evaluate(() => !!document.activeElement?.closest('[data-testid="comment-card"]')), "the focus to land on the card");
      const card = page.locator(q("comment-card")).first();
      assert.equal(await card.evaluate((e) => e.contains(document.activeElement)), true);
      const cb = await boxOf(card);
      const sb = await boxOf(page.locator(q("sidebar")));
      assert.ok(cb.y >= sb.y && cb.y + cb.height <= sb.y + sb.height + 2, "the card is inside the panel's view");
      poll.child.kill("SIGKILL");
    } finally {
      await t.end();
    }
  });
});

describe("the Sent chip waits for the Send", () => {
  test("a Send that fails shows its error and no chip", async () => {
    const t = await world("sidebar-nochip.docx");
    try {
      const { page } = t;
      await page.route("**/api/send*", (r) => r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "The server could not take it." }) }));
      await selectWord(page, "Paragraph 020:");
      await page.keyboard.press(`${MODK}+Shift+K`);
      await page.locator(q("quick-ask")).waitFor({ timeout: 3000 });
      await page.keyboard.type("Tighten this.");
      await page.keyboard.press(`${MODK}+Enter`);
      await page.locator(q("banner-error")).waitFor({ timeout: 10000 });
      assert.equal(await page.locator(q("notice-action")).count(), 0, "nothing was sent: no chip");
      assert.equal(await page.locator(q("comment-card")).first().getAttribute("data-status"), "draft");
    } finally {
      await t.end();
    }
  });
});

describe("agent text stays text", () => {
  test("a note with an image tag and a markdown link renders literally: no element, no link, no script", async () => {
    const t = await world("sidebar-inject.docx");
    try {
      const { page, w, file } = t;
      const dialogs = [];
      page.on("dialog", (d) => (dialogs.push(d.message()), d.dismiss()));
      const poll = await deliver(t);
      const batch = JSON.parse((await Promise.race([poll.done, new Promise((r) => setTimeout(() => r({ stdout: "{}" }), 15000))])).stdout);
      const id = batch.instructions.comments[0].id;
      const note = "<img src=x onerror=alert(1)> and [x](https://example.invalid/?d=1)";
      const results = w.doc("inject.json");
      fs.writeFileSync(results, JSON.stringify({ summary: note, results: [{ comment_id: id, status: "declined", note }] }));
      const done = await w.cli(["done", file, "--results", results]);
      assert.equal(done.code, 0, done.stderr);
      const el = page.locator(q("agent-note")).first();
      await el.waitFor({ timeout: 10000 });
      assert.equal(await el.textContent(), `Agent: ${note}`);
      assert.equal(await page.locator(`${q("sidebar")} img, ${q("sidebar")} a[href*="example.invalid"]`).count(), 0, "no image or link came out of agent text");
      assert.equal(await page.locator(`${q("comment-card")} [onerror], ${q("comment-card")} img`).count(), 0);
      assert.equal(await page.evaluate(() => document.body.innerHTML.includes("<img src=\"x\"")), false);
      await page.waitForTimeout(500);
      assert.deepEqual(dialogs, [], "no script ran");
    } finally {
      await t.end();
    }
  });
});

describe("timing marks", () => {
  const measures = (page) => page.evaluate(() => performance.getEntriesByType("measure").map((m) => m.name).filter((n) => n.startsWith("os:")));

  test("off on a normal page; with the flag the file load and the reload after a run are marked (no network call, nothing logged)", async () => {
    const t = await world("sidebar-marks.docx");
    try {
      assert.deepEqual(await measures(t.page), [], "a normal page makes no marks");
      await t.page.close();
      const seen = [];
      const page = await br.page();
      t.page = page;
      page.on("request", (r) => seen.push(r.url()));
      page.on("console", (m) => /os:/.test(m.text()) && seen.push(`console: ${m.text()}`));
      await page.addInitScript(() => (window.__onionskinMarks = true));
      await page.goto(t.side.url(await t.w.open(t.file)));
      await waitDoc(page);
      assert.ok((await measures(page)).includes("os:file-fetch"), "the first load is marked");
      const poll = await deliver(t, "Say it differently.", "Paragraph 015:");
      const batch = JSON.parse((await Promise.race([poll.done, new Promise((r) => setTimeout(() => r({ stdout: "{}" }), 15000))])).stdout);
      agentEdit([t.file, "replace", "regional leads", "regional managers", "Paragraph 015:"]);
      const results = t.w.doc("marks.json");
      fs.writeFileSync(results, JSON.stringify({ summary: "Done.", results: [{ comment_id: batch.instructions.comments[0].id, status: "done", note: "Changed." }] }));
      assert.equal((await t.w.cli(["done", t.file, "--results", results])).code, 0);
      await until(async () => (await measures(page)).includes("os:reload-load"), "the reload to be marked");
      await until(async () => (await measures(page)).includes("os:file-render"), "the viewer opening to be marked");
      assert.deepEqual(seen.filter((u) => /os:/.test(u)), [], "no mark name leaves the page or reaches the console");
    } finally {
      await t.end();
    }
  });
});

describe("the event stream", () => {
  const LOST = /Onionskin on this Mac is not answering\. Your comments and note are still here and the page keeps trying: if it does not come back, copy them, then open the file again\./;
  test("after every retry is used the page says Connection lost; when the stream comes back the message goes", async () => {
    const t = await world("sidebar-down.docx");
    try {
      await t.page.close();
      const page = await br.page();
      t.page = page;
      await page.clock.install(); // the retries wait 1, 2, 4, 8 s and then 15 s: run that time at once
      let down = true;
      await page.route("**/api/events*", (r) => (down ? r.fulfill({ status: 503, body: "down" }) : r.continue()));
      await page.goto(t.side.url(await t.w.open(t.file)));
      await waitDoc(page);
      assert.equal(await page.locator(q("banner-error")).count(), 0, "not yet: the retries are still running");
      for (let i = 0; i < 14; i++) {
        await page.clock.runFor(16_000); // each try needs a real round trip to fail, so the time is run in steps
        await page.waitForTimeout(150);
      }
      await page.locator(q("banner-error")).waitFor({ timeout: 10000 });
      assert.match(await text(page, "banner-error"), LOST);
      down = false;
      await page.evaluate(() => window.dispatchEvent(new Event("online")));
      await page.locator(q("banner-error")).waitFor({ state: "detached", timeout: 10000 });
    } finally {
      await t.end();
    }
  });

  // The real server stops (`onionskin stop`, as a crash or an upgrade would): the port refuses, and Chrome keeps the stream CONNECTING and retries by
  // itself, so the "all retries used" path above never runs. The page must still say so, without advice to reload (a restarted server listens on a new
  // port with a new token: a reload shows a browser error and loses the unsaved comments), and hand the comments over as text.
  test("the server stops: the not answering message shows within 20 s, a new comment says Not saved, Copy my comments puts every draft on the clipboard", async () => {
    const w = makeWorld();
    const file = w.doc("sidebar-stopped.docx");
    fs.copyFileSync(w.doc("long.docx"), file);
    const page = await br.page();
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      const url = await w.open(file); // the real server, no stand-in in front of it
      if (!WEBKIT) await br.ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(url).origin }); // Playwright WebKit has no clipboard permission to grant
      await page.goto(url);
      await waitDoc(page);
      await page.locator(q("overall-note")).fill("Keep the tone friendly.");
      await addComment(page, "Paragraph 015:", "First comment before the stop.");
      await page.locator(`${q("card-ack")}[data-ack="saved"]`).waitFor({ timeout: 10000 });
      assert.equal((await w.cli(["stop"])).code, 0);
      const t0 = Date.now();
      await page.locator(q("banner-error"), { hasText: "not answering" }).waitFor({ timeout: 20000 });
      const banner = await text(page, "banner-error");
      assert.match(banner, LOST, `the banner says what happened and what to do (after ${Date.now() - t0} ms)`);
      assert.doesNotMatch(banner, /reload/i, "no advice to reload");
      await addComment(page, "Paragraph 030:", "Second comment after the stop.");
      await page.locator(`${q("card-ack")}[data-ack="failed"]`, { hasText: "Not saved" }).first().waitFor({ timeout: 10000 });
      await page.locator(q("copy-comments")).click();
      if (WEBKIT) await page.locator(q("notice"), { hasText: /comments copied|did not allow copying/ }).waitFor({ timeout: 5000 }); // the clipboard may be blocked there: either toast is right
      else {
        await page.locator(q("notice"), { hasText: "2 comments copied." }).waitFor({ timeout: 5000 });
        const clip = await page.evaluate(() => navigator.clipboard.readText());
        assert.match(clip, /Keep the tone friendly\./);
        assert.match(clip, /First comment before the stop\./);
        assert.match(clip, /Second comment after the stop\./);
        const quote = (await page.locator(q("card-preview")).first().textContent()).trim();
        assert.ok(quote && clip.includes(`"${quote}"`) && clip.indexOf(`"${quote}"`) < clip.indexOf("First comment"), `the quoted words come before their comment:\n${clip}`);
      }
      // Send fails while the server is gone and says so in its own words; the not answering message and its button come back, they are not lost
      await page.locator(q("send")).click();
      await page.locator(q("banner-error")).filter({ hasNotText: "not answering" }).waitFor({ timeout: 10000 });
      await page.locator(q("banner-error"), { hasText: "not answering" }).waitFor({ timeout: 15000 });
      assert.equal(await page.locator(q("copy-comments")).count(), 1);
    } finally {
      await page.close();
      await w.cleanup();
    }
  });

  test("the port refuses for a while and comes back: the banner goes and the failed draft save goes through", async () => {
    const t = await world("sidebar-refused.docx");
    try {
      const { page, side } = t;
      await addComment(page, "Paragraph 015:", "Before the outage.");
      await page.locator(`${q("card-ack")}[data-ack="saved"]`).waitFor({ timeout: 10000 });
      await side.down(); // nothing listens on the page's port: connections are refused, as when the server is gone
      await page.locator(q("banner-error"), { hasText: "not answering" }).waitFor({ timeout: 20000 });
      await addComment(page, "Paragraph 030:", "During the outage.");
      await page.locator(`${q("card-ack")}[data-ack="failed"]`).first().waitFor({ timeout: 10000 });
      await side.up(); // the same port answers again, the same server behind it
      await page.locator(q("banner-error")).waitFor({ state: "detached", timeout: 20000 });
      await page.locator(`${q("card-ack")}[data-ack="saved"]`).first().waitFor({ timeout: 20000 });
      assert.equal(await page.locator(`${q("card-ack")}[data-ack="failed"]`).count(), 0, "no card still says Not saved");
    } finally {
      await t.end();
    }
  });

  test("a stream that drops and reopens within a few seconds raises nothing", async () => {
    const t = await world("sidebar-blip.docx");
    try {
      const { page, side } = t;
      let seen = false;
      await page.exposeFunction("__bannerSeen", () => (seen = true));
      await page.evaluate(() => new MutationObserver(() => document.querySelector('[data-testid="banner-error"]') && window.__bannerSeen()).observe(document.body, { childList: true, subtree: true }));
      await side.down();
      await page.waitForTimeout(4000);
      await side.up();
      await page.waitForTimeout(12000); // past the 10 s mark of the first error
      assert.equal(seen, false, "no not answering message for a short drop");
    } finally {
      await t.end();
    }
  });
});
