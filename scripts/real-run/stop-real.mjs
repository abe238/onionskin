#!/usr/bin/env node
// The opt-in real test of the Stop button (it spends the person's Claude plan, so nothing in CI runs it).
//   ONIONSKIN_REAL_AGENT=1 node scripts/real-run/stop-real.mjs [--out <dir>] [--deadline <secs>]
//   node scripts/real-run/stop-real.mjs --fake <new or empty dir> [--out <dir>]   (a free rehearsal of this script)
//
// One document (docx-basic, report.docx) opened with the background flag, so the server's own runner (src/agent-runner.js) starts a
// restricted headless Claude Code. This script plays the person in one Chrome page:
//   1. a comment and an overall note asking for a slow change (rewrite every paragraph in a formal register), then Send;
//   2. once the agent's poll has returned the batch (the trace's poll line, the server's delivered batch, the agent's transcript),
//      Stop the agent. Asserts: the comment is a draft again with its text, the note is back in its box, the page is unlocked, the agent's
//      pid is gone within about 10 s and its process group is empty, the file is byte for byte unchanged then and 15 s later (no late
//      write), and agent.startsLeft is still 4 (the start at open was the only counted one);
//   3. the same comment rewritten to one exact change ("three" to "four", the first round of bench-real.mjs), the note cleared, Send.
//      Asserts: a new agent (another pid, another session id), that exact change and nothing else in the document text, the page unlocked,
//      startsLeft still 4, and the new agent's part of the transcript holds nothing of the withdrawn instruction (a fresh conversation;
//      the first agent's part must hold it, or that check proves nothing);
//   4. Close session: both process groups are gone and the agent folder is removed (and, real only, Claude Code's copy is purged).
// Prints one PASS/FAIL row per assertion and writes <out>/stop-real.json with the timings.
//
// Onionskin's state lives in a temp dot folder under HOME (~/.osk-bgr-*, created and deleted here; never ~/.onionskin). Claude Code needs
// the real HOME (its sign-in is there); its data for the temp work folder is purged at Close and once more in `finally`.
//
// --fake <dir>: the script installs e2e/helpers/fake-claude.mjs there as `claude`, with its fixed edit pointed at this fixture's sentence,
// writes `mode` = hold for the first agent (it keeps the batch and, on the signal, tries a late reply into late.json) and removes it
// after Stop, so the second agent makes the change.
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { launch, readZipText, waitDoc } from "../../e2e/helpers/harness.mjs";
import { cliPath, deliveredBatch, log, prepare, repo, sleep } from "./lib.mjs";
import { commentOnParagraph } from "./scenarios.mjs";

const arg = (n, d) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1] : d);
const fake = arg("fake", "") ? path.resolve(arg("fake", "")) : "";
const outDir = arg("out", "");
const deadlineMs = Number(arg("deadline", "600")) * 1000;
if (!fake && process.env.ONIONSKIN_REAL_AGENT !== "1") {
  console.error("This test starts a real Claude Code agent and uses your Claude plan. Run it with ONIONSKIN_REAL_AGENT=1 (or --fake <dir> for a free rehearsal).");
  process.exit(2);
}

// what the person asks: first a slow change (withdrawn by Stop), then one exact word
const PARA = "Customer satisfaction held steady";
const MARK = "ceremonial"; // in both withdrawn texts, nowhere in the document, the skill or the prompt
const FIRST_COMMENT = "Rewrite this paragraph, and then every other paragraph of the document one by one, in a formal ceremonial register.";
const FIRST_NOTE = "Rewrite every paragraph of the document in a formal ceremonial register suitable for the board. Take your time and keep every number.";
const SECOND_COMMENT = 'Change "three" to "four".';
const FROM = "Customer satisfaction held steady across all three regions throughout the period.";
const TO = "Customer satisfaction held steady across all four regions throughout the period.";

if (fake) {
  // the stand-in, from the e2e helper; its fixed edits are rewritten to this fixture's sentence (fails loudly if the helper changed)
  fs.mkdirSync(fake, { recursive: true });
  let src = fs.readFileSync(path.join(repo, "e2e", "helpers", "fake-claude.mjs"), "utf8");
  for (const [a, b] of [["Paragraph 003:", "all three regions"], ["Paragraph THREE:", "all four regions"], ["Paragraph LATE:", "all late regions"]]) {
    if (!src.includes(`"${a}"`)) (console.error(`e2e/helpers/fake-claude.mjs no longer holds "${a}"; update stop-real.mjs`), process.exit(1));
    src = src.replaceAll(`"${a}"`, `"${b}"`);
  }
  fs.writeFileSync(path.join(fake, "fake-claude.mjs"), src);
  fs.writeFileSync(path.join(fake, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${path.join(fake, "fake-claude.mjs")}" "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(fake, "onionskin"), `#!/bin/sh\nexec "${process.execPath}" "${cliPath}" "$@"\n`, { mode: 0o755 });
  for (const f of ["mode", "held", "late.json", "signals", "pids", "starts", "purged"]) fs.rmSync(path.join(fake, f), { force: true });
  fs.writeFileSync(path.join(fake, "mode"), "hold");
}

const t0 = Date.now();
const wd = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), ".osk-bgr-")));
const info = prepare("docx-basic", wd);
const env = { ...process.env, ONIONSKIN_STATE_DIR: info.state_dir, ONIONSKIN_NO_SOFFICE: "1", ONIONSKIN_TRACE: path.join(wd, "trace.jsonl") };
for (const k of ["NODE_TEST_CONTEXT", "ONIONSKIN_AGENT_CLI", "ONIONSKIN_HOLDER", "ONIONSKIN_AGENT_DIR"]) delete env[k];
if (fake) env.ONIONSKIN_AGENT_PATH = fake;
else delete env.ONIONSKIN_AGENT_PATH;

const rows = [];
const row = (name, ok, detail = "") => (rows.push({ name, ok: !!ok, detail: String(detail).slice(0, 300) }), log("row", `${ok ? "PASS" : "FAIL"} ${name}`), ok);
const sock = path.join(info.state_dir, "s.sock");
const post = (p, body) =>
  new Promise((resolve, reject) => {
    const r = http.request({ socketPath: sock, method: "POST", path: p, headers: { "content-type": "application/json" } }, (res) => {
      let t = "";
      res.on("data", (d) => (t += d));
      res.on("end", () => resolve(JSON.parse(t)));
    });
    r.on("error", reject);
    r.end(JSON.stringify(body));
  });
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};
const groupEmpty = (pgid) => {
  try {
    process.kill(-pgid, 0);
    return false;
  } catch (e) {
    return e.code === "ESRCH";
  }
};
const lstart = (pid) => {
  try {
    return execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
};
const shaOf = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const decode = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
/** The text of every paragraph (table cells included) of a .docx, in order. */
const paras = async (f) =>
  (await readZipText(f, "word/document.xml"))
    .split("</w:p>")
    .slice(0, -1)
    .map((p) => decode([...p.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join("")));
const pastDeadline = () => Date.now() - t0 > deadlineMs;
/** Polls fn() every `every` ms until it returns a truthy value or `ms` pass (or the overall deadline); returns the value or null. */
async function until(fn, ms, every = 100) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end || pastDeadline()) return null;
    await sleep(every);
  }
}
const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return null;
  }
};
const lines = (s) =>
  s
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
const toolText = (c) => (typeof c?.content === "string" ? c.content : (c?.content || []).map((x) => x.text || "").join("\n"));

let srv = null, srvStart = null, br = null, page = null, key = null, W = null, rec1 = null, rec2 = null, watch = null, trFd = null;
const result = { fake: !!fake, scenario: "docx-basic", workdir: wd, timings: {} };
const firstSha = shaOf(info.file);
let changedAt = null;
let cleaned = false;

/** Stops everything this script started: the server (by its CLI), then each recorded agent group whose pid still has its recorded start time. */
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  if (watch) clearInterval(watch);
  try {
    execFileSync(process.execPath, [cliPath, "stop"], { env, stdio: "ignore", timeout: 15_000 });
  } catch {}
  for (const r of [rec1, rec2]) {
    if (r && r.lstart && lstart(r.pid) === r.lstart) {
      try {
        process.kill(-r.pgid, "SIGKILL");
      } catch {}
      row("cleanup: an agent group had to be killed by the test", false, `pid ${r.pid}`);
    }
  }
  // `onionskin stop` returns while the server is still exiting: up to 5 s for it to go before it counts as left over
  // (it is this script's child: once it exits it stays a zombie until Node reaps it, which this synchronous wait never lets happen)
  const srvLeft = () => {
    if (!srv || !srvStart) return false;
    let stat = "";
    try {
      stat = execFileSync("/bin/ps", ["-o", "stat=", "-p", String(srv.pid)], { encoding: "utf8" }).trim();
    } catch {}
    return !!stat && !stat.startsWith("Z") && lstart(srv.pid) === srvStart;
  };
  for (let i = 0; i < 50 && srvLeft(); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  if (srvLeft()) {
    try {
      process.kill(srv.pid, "SIGKILL");
    } catch {}
    row("cleanup: the server had to be killed by the test", false, `pid ${srv.pid}`);
  }
  if (W && !fake) {
    try {
      const claudeBin = execFileSync("/bin/sh", ["-c", "command -v claude"], { env: { PATH: `${os.homedir()}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin` }, encoding: "utf8" }).trim();
      if (claudeBin) execFileSync(claudeBin, ["purge", W, "--yes"], { stdio: "ignore", timeout: 15_000 });
    } catch {}
  }
}
function report() {
  result.rows = rows;
  result.ok = rows.length > 0 && rows.every((r) => r.ok);
  result.seconds = Math.round((Date.now() - t0) / 1000);
  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    for (const f of ["transcript.jsonl", "trace.jsonl", "after-stop.png", "after-second.png", "fatal.png"]) if (fs.existsSync(path.join(wd, f))) fs.copyFileSync(path.join(wd, f), path.join(outDir, f));
    if (fake && fs.existsSync(path.join(fake, "late.json"))) fs.copyFileSync(path.join(fake, "late.json"), path.join(outDir, "late.json"));
    fs.writeFileSync(path.join(outDir, "stop-real.json"), JSON.stringify(result, null, 2));
  }
  fs.rmSync(wd, { recursive: true, force: true });
  for (const r of rows) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? `  (${r.detail})` : ""}`);
  console.log(`${result.ok ? "ALL PASS" : "FAILED"} in ${result.seconds} s${fake ? " (stand-in agent, not real)" : ""}`);
}
// a hang past the deadline must not hold the browser lock or leave an agent polling
setTimeout(() => {
  row("the run finished before the hard deadline", false, `${deadlineMs / 1000} s + 60 s`);
  cleanup();
  report();
  process.exit(1);
}, deadlineMs + 60_000).unref();

// the agent's view as the page's own request reads it (the page does not show startsLeft)
const agentView = () =>
  page.evaluate(async () => {
    const sid = new URLSearchParams(location.search).get("s");
    const token = sessionStorage.getItem(`onionskin.token.${sid}`) || "";
    const r = await fetch(`/api/bootstrap?s=${sid}`, { headers: { "x-onionskin-token": token } });
    return (await r.json()).session.agent;
  });
const q = (id) => `[data-testid="${id}"]`;
const traceLines = () => (fs.existsSync(env.ONIONSKIN_TRACE) ? lines(fs.readFileSync(env.ONIONSKIN_TRACE, "utf8")) : []);
const transcriptText = () => (W && fs.existsSync(path.join(W, "transcript.jsonl")) ? fs.readFileSync(path.join(W, "transcript.jsonl"), "utf8") : "");

try {
  // 1. the server, then the file opened with the background flag (what `onionskin <file>` at a person's terminal sends); the open starts the agent
  srv = spawn(process.execPath, [path.join(repo, "src", "server-entry.js")], { env, detached: true, stdio: ["ignore", "pipe", "ignore"] });
  await new Promise((r) => srv.stdout.once("data", r));
  srv.stdout.destroy();
  srv.unref();
  srvStart = lstart(srv.pid);
  const opened = await post("/cli/open", { file: info.file, agent: "background" });
  key = opened.key;
  W = path.join(fs.realpathSync(info.state_dir), "agents", key);
  const recFile = path.join(info.state_dir, "agents", `${key}.json`);
  log("stop", `opened with the background flag (session ${key})`);
  rec1 = await until(() => {
    const r = readJson(recFile);
    return r?.pid && r.lstart ? r : null;
  }, 30_000);
  row("the runner started the first agent at open (a record with pid and start time)", !!rec1, rec1 ? `pid ${rec1.pid}` : "no record within 30 s");
  if (!rec1) throw new Error("no agent record");
  watch = setInterval(() => {
    try {
      if (!changedAt && shaOf(info.file) !== firstSha) changedAt = Date.now();
    } catch {}
  }, 100);

  // 2. the person: a comment and a note asking for a slow change, then Send once the agent listens
  br = await launch();
  page = await br.page();
  await page.goto(opened.url);
  await waitDoc(page, ".de-p");
  await page.waitForTimeout(1500);
  await commentOnParagraph(page, PARA, FIRST_COMMENT);
  await page.locator(q("overall-note")).fill(FIRST_NOTE);
  await page.waitForTimeout(800);
  const listening = await page.locator(q("banner-listening")).waitFor({ timeout: 180_000 }).then(() => true, () => false);
  row("the agent was listening before Send", listening);
  const leftBefore = (await agentView()).startsLeft;
  row("startsLeft is 4 before Send (the start at open was counted)", leftBefore === 4, `startsLeft ${leftBefore}`);
  const sendAt = Date.now();
  await page.locator(q("send")).click();
  log("stop", "Send clicked");
  const stopShown = await page.locator(q("agent-stop")).waitFor({ timeout: 60_000 }).then(() => true, () => false);
  row("the page shows the working state with the Stop button", stopShown && (await page.locator(q("banner-working")).count()) > 0);

  // 3. the agent has the batch: its poll returned (trace, code 0, after Send), the server delivered it, and the agent's transcript shows the result
  const polled = await until(() => traceLines().find((l) => l.cmd === "poll" && l.code === 0 && l.end > sendAt), 120_000);
  const delivered = await until(async () => (await deliveredBatch(info))?.batch || null, 10_000);
  const batchId = delivered?.batch_id || delivered?.id || null;
  const inTranscript = await until(
    () =>
      lines(transcriptText()).some((e) => e.type === "user" && (e.message?.content || []).some((c) => c.type === "tool_result" && /onionskin\.batch\/1/.test(toolText(c)) && toolText(c).includes(MARK))),
    20_000,
    200,
  );
  result.timings.send_to_poll_returned_ms = polled ? polled.end - sendAt : null;
  row("the agent's poll returned the batch (trace and delivered batch)", !!polled && !!delivered, `poll ${polled ? "returned" : "not seen"}, delivered ${delivered ? "yes" : "no"}`);
  row("the agent's transcript shows the batch it received", !!inTranscript);
  // Stop must land mid-run: had the agent already answered, the rows below would test nothing (a script timing failure, not the product's)
  const midRun = !changedAt && (await page.locator(q("activity-entry")).count()) === 0 && (await page.locator(q("agent-stop")).count()) > 0;
  row("Stop is pressed while the agent is still working (file untouched, no result yet)", midRun, changedAt ? "the file had already changed" : "");
  if (!midRun) throw new Error("the agent finished before Stop could be pressed");

  // 4. Stop
  const stopAt = Date.now();
  result.timings.send_to_stop_pressed_ms = stopAt - sendAt;
  await page.locator(q("agent-stop")).click();
  log("stop", "Stop clicked");
  const unlocked = await page.locator(q("banner-working")).waitFor({ state: "detached", timeout: 15_000 }).then(() => Date.now(), () => null);
  result.timings.stop_pressed_to_unlocked_ms = unlocked ? unlocked - stopAt : null;
  const pidGone = await until(() => (!alive(rec1.pid) ? Date.now() : null), 12_000, 50);
  result.timings.stop_to_pid_gone_ms = pidGone ? pidGone - stopAt : null;
  row("the page is unlocked after Stop (no working banner)", !!unlocked, unlocked ? `${unlocked - stopAt} ms` : "still working after 15 s");
  const noteBack = await page.waitForFunction((n) => document.querySelector('[data-testid="overall-note"]')?.value === n, FIRST_NOTE, { timeout: 10_000 }).then(() => true, () => false);
  row("the note text is back in its box", noteBack, noteBack ? "" : `box holds: ${await page.locator(q("overall-note")).inputValue().catch(() => "?")}`);
  const draft = await page.waitForFunction(() => document.querySelector('[data-testid="comment-card"]')?.dataset.status === "draft", null, { timeout: 10_000 }).then(() => true, () => false);
  const cardText = await page.locator(q("comment-card") + " textarea").first().inputValue().catch(() => null);
  row("the comment is a draft again with its text", draft && cardText === FIRST_COMMENT, `status ${draft ? "draft" : "not draft"}, text ${cardText === FIRST_COMMENT ? "kept" : JSON.stringify(cardText)}`);
  row("the first agent's pid is gone within 10 s of Stop", !!pidGone && pidGone - stopAt <= 10_000, pidGone ? `${pidGone - stopAt} ms` : "still alive after 12 s");
  row("the first agent's process group is empty", groupEmpty(rec1.pgid), `pgid ${rec1.pgid}`);
  await page.screenshot({ path: path.join(wd, "after-stop.png") });
  const shaAtStop = shaOf(info.file);
  row("the file is unchanged after Stop", shaAtStop === firstSha);
  await sleep(15_000);
  row("the file is still unchanged 15 s later (no late write landed)", shaOf(info.file) === firstSha && !changedAt);
  const v1 = await agentView();
  row("startsLeft is still 4 after Stop", v1.startsLeft === 4, `startsLeft ${v1.startsLeft}, state ${v1.state}`);
  if (fake) {
    const late = readJson(path.join(fake, "late.json"));
    let code = null;
    try {
      code = JSON.parse(late.stdout).code;
    } catch {}
    row("(stand-in) its late reply was refused with stale_batch", late && late.status !== 0 && code === "stale_batch", late ? `exit ${late.status}, code ${code}` : "no late.json");
  }
  // what the first agent tried after the batch (informational: a real agent signaled mid-thought usually tries nothing)
  const t1 = lines(transcriptText());
  result.first_agent_tools = t1.flatMap((e) => (e.type === "assistant" ? (e.message?.content || []).filter((c) => c.type === "tool_use").map((c) => (c.name === "Bash" ? `Bash: ${String(c.input?.command || "").split(" ").slice(0, 2).join(" ")}` : `${c.name}: ${path.basename(c.input?.file_path || "")}`)) : []));
  result.first_batch_id = batchId;

  // 5. one exact change in the same comment, the note cleared, Send: a fresh agent at once, not counted
  if (fake) fs.rmSync(path.join(fake, "mode"), { force: true });
  const trOffset = Buffer.byteLength(transcriptText());
  const firstSession = rec1.session_id;
  await page.locator(q("comment-card") + " textarea").first().fill(SECOND_COMMENT);
  await page.locator(q("overall-note")).fill("");
  await page.waitForTimeout(1000);
  const send2At = Date.now();
  await page.locator(q("send")).click();
  log("stop", "second Send clicked");
  rec2 = await until(() => {
    const r = readJson(recFile);
    return r?.pid && r.lstart && r.pid !== rec1.pid ? r : null;
  }, 60_000);
  row("a new agent started for the second Send (another pid)", !!rec2, rec2 ? `pid ${rec1.pid} then ${rec2.pid}` : "no new record within 60 s");
  if (!rec2) throw new Error("no second agent");
  row("the new agent has another conversation id", !!rec2.session_id && rec2.session_id !== firstSession);
  const trFile = path.join(W, "transcript.jsonl");
  trFd = fs.existsSync(trFile) ? fs.openSync(trFile, "r") : null; // held across Close, which deletes the folder
  const changed = await until(() => changedAt, 300_000, 200);
  result.timings.second_send_to_file_change_ms = changed ? changed - send2At : null;
  row("the file changed after the second Send", !!changed, changed ? `${changed - send2At} ms` : "no change within 5 minutes");
  const entry = await page.locator(q("activity-entry")).first().waitFor({ timeout: 120_000 }).then(() => true, () => false);
  const unlocked2 = await page.locator(q("banner-working")).waitFor({ state: "detached", timeout: 60_000 }).then(() => true, () => false);
  row("the page shows the result and is unlocked", entry && unlocked2, `result ${entry ? "shown" : "not shown"}, working banner ${unlocked2 ? "gone" : "still there"}`);
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(wd, "after-second.png") });
  const before = await paras(info.original);
  const after = await paras(info.file);
  const want = before.map((p) => (p === FROM ? TO : p));
  const diffs = after.length === want.length ? after.map((p, i) => (p === want[i] ? null : { i, want: want[i], got: p })).filter(Boolean) : [{ count: `${before.length} paragraphs then ${after.length}` }];
  row('the exact change landed ("all three regions" to "all four regions")', after.includes(TO) && !after.includes(FROM));
  row("nothing else changed in the document text", diffs.length === 0 && before.includes(FROM), JSON.stringify(diffs).slice(0, 280));
  const v2 = await agentView();
  row("startsLeft is still 4 after the second Send (the fresh start was not counted)", v2.startsLeft === 4, `startsLeft ${v2.startsLeft}`);

  // 6. Close session in the page: the agent stops and its traces go
  const projects = path.join(os.homedir(), ".claude", "projects", W.replace(/[^a-zA-Z0-9]/g, "-"));
  const projectsBefore = fs.existsSync(projects); // the purge row proves something only if the copy was there
  const closeBtn = page.locator(`${q("close")}:visible`).first();
  await closeBtn.click();
  if (await page.locator(q("close-dialog")).waitFor({ timeout: 2000 }).then(() => true, () => false)) await page.locator(q("close-anyway")).click();
  await page.locator(q("banner-closed")).waitFor({ timeout: 15_000 }).catch(() => {});
  const gone2 = await until(() => !alive(rec2.pid), 16_000);
  row("after Close session no process of either agent's group is left", !!gone2 && groupEmpty(rec2.pgid) && groupEmpty(rec1.pgid), `pid ${rec2.pid} ${gone2 ? "gone" : "alive"}, groups ${groupEmpty(rec1.pgid) && groupEmpty(rec2.pgid) ? "empty" : "have members"}`);
  const folderGone = await until(() => !fs.existsSync(W), 5_000);
  row("the agent's folder (its transcript and reply files) was removed", !!folderGone);

  // the whole transcript, both agents, up to the second one's exit, through the descriptor opened before Close
  let full = transcriptText();
  if (trFd !== null) {
    const all = [];
    const buf = Buffer.alloc(1 << 16);
    for (let n, pos = 0; (n = fs.readSync(trFd, buf, 0, buf.length, pos)) > 0; pos += n) all.push(Buffer.from(buf.subarray(0, n)));
    fs.closeSync(trFd);
    trFd = null;
    full = Buffer.concat(all).toString("utf8");
  }
  fs.writeFileSync(path.join(wd, "transcript.jsonl"), full);
  const buf = Buffer.from(full, "utf8");
  const firstPart = buf.subarray(0, trOffset).toString("utf8");
  const secondPart = buf.subarray(trOffset).toString("utf8");
  const ofSecond = lines(full).filter((e) => e.session_id === rec2.session_id);
  result.transcript = { bytes_first: trOffset, bytes_second: buf.length - trOffset, events_second_session: ofSecond.length, sessions: [...new Set(lines(full).map((e) => e.session_id).filter(Boolean))].length };
  row("control: the first agent's transcript holds the withdrawn instruction", firstPart.includes(MARK));
  row("the new agent's transcript holds nothing of the withdrawn instruction (a fresh conversation)", secondPart.length > 0 && ofSecond.length > 0 && !secondPart.includes(MARK) && !ofSecond.some((e) => JSON.stringify(e).includes(MARK)), `${ofSecond.length} events of the new session, ${secondPart.length} bytes after the second Send`);
  result.second_agent_tools = lines(secondPart).flatMap((e) => (e.type === "assistant" ? (e.message?.content || []).filter((c) => c.type === "tool_use").map((c) => (c.name === "Bash" ? `Bash: ${String(c.input?.command || "").split(" ").slice(0, 2).join(" ")}` : `${c.name}: ${path.basename(c.input?.file_path || "")}`)) : []));
  result.cost_usd_api_equivalent = lines(full).filter((e) => e.type === "result").reduce((s, e) => s + (e.total_cost_usd || 0), 0);
  result.console_errors = br.log.console.filter((m) => m.type === "error" || m.type === "http").map((m) => m.text);
  result.page_errors = br.log.errors;
  if (fake) row("(stand-in) Claude Code's copy was purged at Close", fs.existsSync(path.join(fake, "purged")));
  else {
    const purged = await until(() => !fs.existsSync(projects), 10_000);
    row("Claude Code's own copy of the conversation existed, and was purged at Close", projectsBefore && !!purged, `${projectsBefore ? "existed" : "NOT FOUND before Close"}: ${projects}`);
  }
} catch (err) {
  row("the run completed without an error", false, err.stack || err.message);
  try {
    if (page) await page.screenshot({ path: path.join(wd, "fatal.png") });
  } catch {}
} finally {
  if (trFd !== null) {
    try {
      fs.closeSync(trFd);
    } catch {}
  }
  if (br) await br.close().catch(() => {});
  cleanup();
  report();
  process.exit(result.ok ? 0 : 1);
}
