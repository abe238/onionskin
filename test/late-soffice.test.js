import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test, after } from "node:test";
import { fileURLToPath } from "node:url";
import { tmpdir, docxBytes } from "./helpers/zipbuild.js";

// The LibreOffice conversion check runs after `done` returned. A stub soffice (a shell script) stands in for LibreOffice; temp dirs only.
const root = tmpdir();
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.ONIONSKIN_STATE_DIR = path.join(root, "st");
process.env.ONIONSKIN_LEASE_MS = "60000";
delete process.env.ONIONSKIN_NO_SOFFICE;
const { python, havePython, skipUnless, VENV_HINT } = await import("../scripts/fixtures.mjs");
const SKIP = skipUnless(havePython(), "needs .venv with the fixture libraries", VENV_HINT);
process.env.ONIONSKIN_PYTHON = python;
const stub = path.join(root, "soffice-stub.sh");
const marks = path.join(root, "marks");
fs.mkdirSync(marks);
// STUB_MODE: slow (converts after 0.3 s and logs its start and end) | ok (always converts) | failafter (converts the "before" file only) | hang (records its pid, then sleeps)
fs.writeFileSync(stub, `#!/bin/sh
out=""; prev=""; last=""
for a in "$@"; do [ "$prev" = "--outdir" ] && out="$a"; prev="$a"; last="$a"; done
echo "$$" >> "${marks}/invoked"
case "$STUB_MODE" in
  hang) echo "$$" > "${marks}/hang.pid"; sleep 300 ;;
  stopped_checker) echo "$$" > "${marks}/hang.pid"; sleep 0.1; kill -STOP "$PPID"; exec sleep 30 ;;
  slow) echo s >> "${marks}/conc"; sleep 0.3; echo e >> "${marks}/conc"; b=$(basename "$last"); printf PDF > "$out/\${b%.*}.pdf" ;;
  failafter) case "$last" in *before*) printf PDF > "$out/before.pdf" ;; esac ;;
  *) b=$(basename "$last"); printf PDF > "$out/\${b%.*}.pdf" ;;
esac
`, { mode: 0o755 });
process.env.ONIONSKIN_SOFFICE = stub;
const { Sessions } = await import("../src/session.js");
const { analyze } = await import("../src/analyze.js");
const { startLateSoffice } = await import("../src/checker.js");
const { checkPackages } = await import("../src/package.js");
const { sha256 } = await import("../src/fsutil.js");
const { ensureStateDir } = await import("../src/paths.js");
ensureStateDir();
after(() => fs.rmSync(root, { recursive: true, force: true }));

const paras = Array.from({ length: 6 }, (_, i) => `Paragraph ${i + 1}: some real sentence number ${i * 5 + 3} for the late check tests.`);
let n = 0;
const comment = (id, i) => ({ id, kind: "element", text: "fix", anchor: { location: { blockPath: [i] }, paraText: paras[i] } });
const invoked = () => (fs.existsSync(path.join(marks, "invoked")) ? fs.readFileSync(path.join(marks, "invoked"), "utf8").trim().split("\n").length : 0);
// The stub's pid. The file exists a moment before the shell writes the pid into it, so "exists" is not "readable": an empty read is 0, not a pid.
const stubPid = () => {
  try {
    return Number(fs.readFileSync(path.join(marks, "hang.pid"), "utf8").trim()) || 0;
  } catch {
    return 0;
  }
};
const alive = (pid) => {
  assert.ok(pid > 0, `a real pid (got ${pid}); kill(0) would signal our own process group and always look alive`);
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (fn, ms = 8000) => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};
const waitLate = (pre, post) => new Promise((resolve) => startLateSoffice(pre, post, "docx", resolve));

test("stopping the checker before it records the process group cannot start LibreOffice", { skip: SKIP }, async () => {
  const groupFile = path.join(marks, "unreported.pid");
  const pause = path.join(root, "pause-after-spawn.py");
  fs.writeFileSync(pause, `import os, pathlib, runpy, signal, subprocess, sys
popen = subprocess.Popen
def pause(*args, **kwargs):
    child = popen(*args, **kwargs)
    pathlib.Path(${JSON.stringify(groupFile)}).write_text(str(child.pid))
    os.kill(os.getpid(), signal.SIGSTOP)
    return child
subprocess.Popen = pause
sys.argv = sys.argv[2:]
runpy.run_path(sys.argv[0], run_name='__main__')
`);
  const wrapper = path.join(root, "paused-python");
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${python}" -I "${pause}" "$@"\n`, { mode: 0o755 });
  const prevTo = process.env.ONIONSKIN_CHECK_TIMEOUT_MS;
  process.env.ONIONSKIN_PYTHON = wrapper;
  process.env.ONIONSKIN_CHECK_TIMEOUT_MS = "1500";
  process.env.STUB_MODE = "hang";
  const before = invoked();
  try {
    const { runDeepCheck } = await import("../src/checker.js");
    const bytes = fs.readFileSync(path.join(repo, "test", "fixtures", "engine", "sample.docx"));
    assert.equal(runDeepCheck(bytes, bytes, "docx").code, "timed_out");
    const pid = Number(fs.readFileSync(groupFile, "utf8"));
    assert.equal(invoked(), before, "LibreOffice never started");
    assert.ok(await until(() => !alive(pid), 2000), "the unreported group exited");
  } finally {
    if (fs.existsSync(groupFile)) {
      const pid = Number(fs.readFileSync(groupFile, "utf8"));
      if (pid > 1 && alive(pid)) process.kill(-pid, "SIGKILL");
    }
    process.env.ONIONSKIN_PYTHON = python;
    if (prevTo === undefined) delete process.env.ONIONSKIN_CHECK_TIMEOUT_MS;
    else process.env.ONIONSKIN_CHECK_TIMEOUT_MS = prevTo;
    delete process.env.STUB_MODE;
  }
});

test("a hard-stopped checker leaves no LibreOffice process group", { skip: SKIP }, async () => {
  const { runDeepCheck, deepRedline } = await import("../src/checker.js");
  const bytes = fs.readFileSync(path.join(repo, "test", "fixtures", "engine", "sample.docx"));
  const before = process.env.ONIONSKIN_CHECK_TIMEOUT_MS;
  process.env.ONIONSKIN_CHECK_TIMEOUT_MS = "1500";
  process.env.STUB_MODE = "stopped_checker";
  try {
    for (const check of [() => runDeepCheck(bytes, bytes, "docx"), () => waitLate(bytes, bytes), () => deepRedline(bytes, bytes, bytes)]) {
      fs.rmSync(path.join(marks, "hang.pid"), { force: true });
      try {
        await check();
        const pid = stubPid();
        assert.ok(pid > 1, "the checker started LibreOffice");
        assert.ok(await until(() => !alive(pid), 6500), "the hard stop also stopped LibreOffice");
      } finally {
        const pid = stubPid();
        if (pid > 1 && alive(pid)) process.kill(-pid, "SIGKILL");
      }
    }
  } finally {
    if (before === undefined) delete process.env.ONIONSKIN_CHECK_TIMEOUT_MS;
    else process.env.ONIONSKIN_CHECK_TIMEOUT_MS = before;
    delete process.env.STUB_MODE;
  }
});

/** A finished run whose done used the deferred check; returns what the server would hand to startLateSoffice. */
async function finishedRun(S, name) {
  const f = path.join(root, `${name}${++n}.docx`);
  fs.writeFileSync(f, docxBytes(paras));
  const s = S.open(fs.realpathSync(f));
  const poll = S.poll(s.key, { holder: "A" });
  S.send(s.key, { baseSha: s.baseSha, comments: [comment("c1", 1)], note: "" });
  const batch = await poll.promise;
  const claim = { holder: "A", token: batch.lease.token, batchId: batch.batch_id };
  S.agentWrite(s.key, { baseSha: sha256(fs.readFileSync(s.file)), bytes: docxBytes(["The agent's text."]), ...claim });
  const inputs = S.analysisInputs(s.key, claim);
  assert.equal(inputs.deferSoffice, true);
  const analysis = { postSha: inputs.postSha, batchId: inputs.batchId, ...analyze(inputs.pre, inputs.post, "docx", { deferSoffice: true }) };
  const done = S.done(s.key, { summary: "x", results: [{ comment_id: "c1", status: "done", note: "ok" }] }, claim, analysis);
  return { s, inputs, analysis, done };
}

test("deferred: done's checks say the LibreOffice check is pending, never passed, and soffice is not started", { skip: SKIP }, () => {
  const pre = docxBytes(paras);
  const before = invoked();
  const r = checkPackages(pre, pre, "docx", { deferSoffice: true });
  assert.equal(r.checks.deep.status, "ran");
  assert.equal(r.checks.deep.soffice, "pending");
  assert.ok(!r.checks.deep.checks.includes("soffice-convert"));
  assert.match(r.checks.notice, /still running \(pending\)/);
  assert.equal(invoked(), before, "the stub was not started");
  const sync = checkPackages(pre, pre, "docx");
  assert.ok(sync.checks.deep.checks.includes("soffice-convert"), "without the switch it runs inline as before");
  assert.equal(sync.checks.deep.soffice, undefined);
});

test("deferred with LibreOffice absent is the plain skipped notice, not pending", { skip: SKIP }, () => {
  process.env.ONIONSKIN_SOFFICE = "/nonexistent/soffice";
  try {
    const pre = docxBytes(paras);
    const r = checkPackages(pre, pre, "docx", { deferSoffice: true });
    assert.equal(r.checks.deep.soffice, undefined);
    assert.ok(r.checks.deep.skipped.some((x) => x.check === "soffice-convert"));
  } finally {
    process.env.ONIONSKIN_SOFFICE = stub;
  }
});

test("ONIONSKIN_SOFFICE_SYNC=1 makes analysisInputs ask for the old inline check", { skip: SKIP }, async () => {
  const S = new Sessions();
  const { s } = await finishedRun(S, "sync-probe");
  process.env.ONIONSKIN_SOFFICE_SYNC = "1";
  try {
    const f = path.join(root, `sync${++n}.docx`);
    fs.writeFileSync(f, docxBytes(paras));
    const s2 = S.open(fs.realpathSync(f));
    const poll = S.poll(s2.key, { holder: "B" });
    S.send(s2.key, { baseSha: s2.baseSha, comments: [comment("c1", 1)], note: "" });
    const b = await poll.promise;
    assert.equal(S.analysisInputs(s2.key, { holder: "B", token: b.lease.token, batchId: b.batch_id }).deferSoffice, false);
  } finally {
    delete process.env.ONIONSKIN_SOFFICE_SYNC;
  }
  assert.ok(s);
});

test("late result, clean: the entry records that the check ran", { skip: SKIP }, async () => {
  process.env.STUB_MODE = "ok";
  const S = new Sessions();
  const events = [];
  S.on("change", (s) => events.push(s.seq));
  const { s, inputs, analysis, done } = await finishedRun(S, "clean");
  assert.equal(done.checks.deep.soffice, "pending");
  const entry = s.activity[0];
  const seq = s.seq;
  const result = await waitLate(inputs.pre, inputs.post);
  assert.equal(result.ran, true);
  assert.equal(S.recordLateCheck(s.key, { batchId: analysis.batchId, postSha: analysis.postSha, result }), true);
  assert.equal(entry.checks.deep.soffice, undefined);
  assert.ok(entry.checks.deep.checks.includes("soffice-convert"));
  assert.doesNotMatch(entry.checks.notice, /pending/);
  assert.equal(entry.revertRecommended, false);
  assert.ok(s.seq > seq, "the page is told");
  assert.equal(S.recordLateCheck(s.key, { batchId: analysis.batchId, postSha: analysis.postSha, result }), false, "settled once");
});

test("late result, problem: the error flag lands on that run and Revert is recommended", { skip: SKIP }, async () => {
  process.env.STUB_MODE = "failafter";
  const S = new Sessions();
  const { s, inputs, analysis } = await finishedRun(S, "bad");
  const result = await waitLate(inputs.pre, inputs.post);
  assert.equal(S.recordLateCheck(s.key, { batchId: analysis.batchId, postSha: analysis.postSha, result }), true);
  const entry = s.activity[0];
  const flag = entry.flags.find((f) => f.code === "soffice_convert_failed");
  assert.equal(flag?.severity, "error");
  assert.equal(entry.revertRecommended, true);
  const reverted = S.revert(s.key, entry.id);
  assert.equal(reverted.activity.find((a) => a.id === entry.id).reverted, true, "the existing Revert works on it");
});

test("late result after a newer write: recorded on its own version, a warning, nothing recommended", { skip: SKIP }, async () => {
  process.env.STUB_MODE = "failafter";
  const S = new Sessions();
  const { s, inputs, analysis } = await finishedRun(S, "stale");
  const entry = s.activity[0];
  // a newer write lands (the user's own save), so the file is no longer the checked version
  s.baseSha = "f".repeat(64);
  const result = await waitLate(inputs.pre, inputs.post);
  assert.equal(S.recordLateCheck(s.key, { batchId: analysis.batchId, postSha: analysis.postSha, result }), true);
  const flag = entry.flags.find((f) => f.code === "soffice_convert_failed");
  assert.equal(flag.severity, "warn");
  assert.match(flag.detail, /changed since/);
  assert.equal(entry.revertRecommended, false);
});

test("late result while the next batch is delivered but unwritten: still an error, Revert still recommended", { skip: SKIP }, async () => {
  process.env.STUB_MODE = "failafter";
  const S = new Sessions();
  const { s, inputs, analysis } = await finishedRun(S, "next");
  const entry = s.activity[0];
  // comments queued during the run reached a poller at once: the next batch is delivered on the file this run left
  S.send(s.key, { baseSha: s.baseSha, comments: [comment("c2", 2)], note: "" });
  const p = S.poll(s.key, { holder: "A" });
  await p.promise;
  assert.ok(s.delivered, "a batch is delivered");
  const result = await waitLate(inputs.pre, inputs.post);
  assert.equal(S.recordLateCheck(s.key, { batchId: analysis.batchId, postSha: analysis.postSha, result }), true);
  const flag = entry.flags.find((f) => f.code === "soffice_convert_failed");
  assert.equal(flag.severity, "error");
  assert.equal(entry.revertRecommended, true);
});

test("late result after the next batch's agent wrote: a warning", { skip: SKIP }, async () => {
  process.env.STUB_MODE = "failafter";
  const S = new Sessions();
  const { s, inputs, analysis } = await finishedRun(S, "next2");
  const entry = s.activity[0];
  S.send(s.key, { baseSha: s.baseSha, comments: [comment("c2", 2)], note: "" });
  const b = await S.poll(s.key, { holder: "A" }).promise;
  S.agentWrite(s.key, { baseSha: sha256(fs.readFileSync(s.file)), bytes: docxBytes(["Another text."]), holder: "A", token: b.lease.token, batchId: b.batch_id });
  const result = await waitLate(inputs.pre, inputs.post);
  S.recordLateCheck(s.key, { batchId: analysis.batchId, postSha: analysis.postSha, result });
  assert.equal(entry.flags.find((f) => f.code === "soffice_convert_failed").severity, "warn");
});

test("a session reloaded after a hard kill settles a pending check and a stuck stage", { skip: SKIP }, async () => {
  process.env.STUB_MODE = "ok";
  const S = new Sessions();
  const { s } = await finishedRun(S, "reload");
  assert.equal(s.activity[0].checks.deep.soffice, "pending");
  S.send(s.key, { baseSha: s.baseSha, comments: [comment("c2", 2)], note: "" });
  await S.poll(s.key, { holder: "A" }).promise;
  S.setStage(s.key, "checking");
  const S2 = new Sessions();
  const r = S2.open(s.file);
  const e = r.activity[0];
  assert.equal(e.checks.deep.soffice, undefined);
  assert.ok(e.checks.deep.skipped.some((x) => x.check === "soffice-convert" && /stopped/.test(x.reason)));
  assert.doesNotMatch(e.checks.notice, /pending/);
  assert.equal(r.delivered.stage, "writing");
});

test("a late result for a session or entry that is gone is dropped without throwing", { skip: SKIP }, () => {
  const S = new Sessions();
  assert.equal(S.recordLateCheck("nope", { batchId: "b", postSha: "p", result: { ran: true, flags: [] } }), false);
});

test("cancel kills the soffice process and settles once with ran:false", { skip: SKIP }, async () => {
  process.env.STUB_MODE = "hang";
  fs.rmSync(path.join(marks, "hang.pid"), { force: true });
  const pre = docxBytes(paras);
  let result;
  let calls = 0;
  const h = startLateSoffice(pre, pre, "docx", (r) => ((result = r), calls++));
  assert.ok(await until(() => stubPid() > 0), "the stub started");
  const pid = stubPid();
  h.cancel("closed");
  h.cancel("again");
  assert.equal(calls, 1);
  assert.equal(result.ran, false);
  assert.match(result.reason, /closed/);
  assert.ok(await until(() => !alive(pid), 5000), "soffice is gone after cancel");
});

test("a server that dies hard leaves no soffice behind", { skip: SKIP }, async () => {
  process.env.STUB_MODE = "hang";
  fs.rmSync(path.join(marks, "hang.pid"), { force: true });
  const script = path.join(root, "orphan.mjs");
  fs.writeFileSync(script, `import { startLateSoffice } from ${JSON.stringify(path.join(repo, "src", "checker.js"))};
import { docxBytes } from ${JSON.stringify(path.join(repo, "test", "helpers", "zipbuild.js"))};
const b = docxBytes(["x"]);
startLateSoffice(b, b, "docx", () => {});
setInterval(() => {}, 1000);
`);
  const c = spawn(process.execPath, [script], { env: process.env, stdio: "ignore" });
  assert.ok(await until(() => stubPid() > 0), "the stub started");
  const pid = stubPid();
  c.kill("SIGKILL");
  assert.ok(await until(() => !alive(pid), 8000), "soffice exits when the process that started the check is gone");
});

// ---- a real server process with a real CLI `reply`, then a closed session or a stopped server while LibreOffice is still running ------------
async function serverWithRunningCheck(name) {
  process.env.STUB_MODE = "hang";
  fs.rmSync(path.join(marks, "hang.pid"), { force: true });
  const f = path.join(root, `${name}${++n}.docx`);
  fs.writeFileSync(f, docxBytes(paras));
  const script = path.join(root, `${name}-server.mjs`);
  fs.writeFileSync(script, `import { startServer } from ${JSON.stringify(path.join(repo, "src", "server.js"))};
const srv = await startServer();
const s = srv.sessions.open(${JSON.stringify(fs.realpathSync(f))});
const poll = srv.sessions.poll(s.key, { holder: "H" });
srv.sessions.send(s.key, { baseSha: s.baseSha, comments: [${JSON.stringify(comment("c1", 1))}], note: "" });
const batch = await poll.promise;
console.log(JSON.stringify({ ticket: batch.lease_ticket, key: s.key }));
process.stdin.on("data", (d) => { if (String(d).includes("close")) { srv.sessions.close(s.key); console.log("closed"); } });
`);
  const server = spawn(process.execPath, [script], { env: process.env, stdio: ["pipe", "pipe", "ignore"] });
  const lines = [];
  server.stdout.on("data", (d) => lines.push(...String(d).split("\n").filter(Boolean)));
  assert.ok(await until(() => lines.length >= 1), "the server child delivered a batch");
  const { ticket } = JSON.parse(lines[0]);
  const cliEnv = { ...process.env, ONIONSKIN_HOLDER: "H" };
  const run = (args) => new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(repo, "src", "cli.js"), ...args], { env: cliEnv, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.on("close", (code) => resolve({ code, out }));
  });
  const t0 = Date.now();
  const r = await run(["reply", fs.realpathSync(f), "--lease", ticket, "--json", JSON.stringify({ summary: "x", replies: [{ comment: "c1", decline: true, note: "no" }] })]);
  assert.equal(r.code, 0, r.out);
  assert.match(JSON.parse(r.out).checks_notice, /pending/);
  assert.ok(Date.now() - t0 < 5000, "reply did not wait for the hanging soffice");
  assert.ok(await until(() => stubPid() > 0), "soffice is running in the background");
  return { server, lines, run, pid: stubPid() };
}

test("closing the session while LibreOffice runs ends the process; the server stays up", { skip: SKIP }, async () => {
  const { server, lines, pid } = await serverWithRunningCheck("close");
  try {
    server.stdin.write("close\n");
    assert.ok(await until(() => !alive(pid), 5000), "soffice is gone after the session closed");
    assert.ok(await until(() => lines.includes("closed"), 5000), "the server reported the close"); // its line can arrive after the process is seen gone
    assert.equal(server.exitCode, null, "the server did not crash");
  } finally {
    server.kill("SIGKILL");
  }
});

test("stopping the server while LibreOffice runs leaves no soffice behind", { skip: SKIP }, async () => {
  const { server, run, pid } = await serverWithRunningCheck("stop");
  try {
    await run(["stop"]);
    assert.ok(await until(() => !alive(pid), 5000), "soffice is gone after the server stopped");
    assert.ok(await until(() => server.exitCode !== null, 5000), "the server exited");
  } finally {
    server.kill("SIGKILL");
  }
});

test("a burst of checks runs one LibreOffice at a time, in order, and every one reports", { skip: SKIP }, async () => {
  process.env.STUB_MODE = "slow";
  fs.rmSync(path.join(marks, "conc"), { force: true });
  const pre = docxBytes(paras);
  const order = [];
  const results = [];
  for (let i = 0; i < 4; i++) startLateSoffice(pre, pre, "docx", (r) => (order.push(i), results.push(r)));
  assert.ok(await until(() => results.length === 4, 30000), `all four reported (${results.length})`);
  assert.deepEqual(order, [0, 1, 2, 3], "first in, first out");
  assert.ok(results.every((r) => r.ran === true), JSON.stringify(results));
  let live = 0;
  let most = 0;
  for (const l of fs.readFileSync(path.join(marks, "conc"), "utf8").trim().split("\n")) most = Math.max(most, (live += l === "s" ? 1 : -1));
  assert.equal(most, 1, "never two LibreOffice processes at once");
});

test("a waiting check that is cancelled never starts LibreOffice; one past the waiting limit is recorded as not run", { skip: SKIP }, async () => {
  process.env.STUB_MODE = "hang";
  fs.rmSync(path.join(marks, "hang.pid"), { force: true });
  const pre = docxBytes(paras);
  const got = new Map();
  const start = (i) => startLateSoffice(pre, pre, "docx", (r) => got.set(i, [...(got.get(i) || []), r]));
  const first = start(0);
  assert.ok(await until(() => stubPid() > 0), "the first one runs");
  const before = invoked();
  const waiting = Array.from({ length: 8 }, (_, k) => start(k + 1));
  start(9);
  assert.equal(got.get(9)?.length, 1, "the one past the limit reports at once");
  assert.equal(got.get(9)[0].ran, false);
  assert.match(got.get(9)[0].reason, /already waiting/);
  for (const h of waiting) h.cancel("closed");
  for (let i = 1; i <= 8; i++) {
    assert.equal(got.get(i)?.length, 1, `waiting check ${i} reported once`);
    assert.equal(got.get(i)[0].ran, false);
  }
  const pid = stubPid();
  first.cancel("closed");
  assert.ok(await until(() => !alive(pid), 5000), "the running one is gone");
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(invoked(), before, "no cancelled waiting check started LibreOffice");
  // the line is free again: a new check runs
  process.env.STUB_MODE = "ok";
  let later;
  startLateSoffice(pre, pre, "docx", (r) => (later = r));
  assert.ok(await until(() => later, 15000), "a later check gets its turn");
  assert.equal(later.ran, true, JSON.stringify(later));
});
