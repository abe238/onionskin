// Starts, restricts, supervises and stops one headless Claude Code agent per document: the "invisible" background agent that answers the
// person's Send when no agent of their own is listening. The agent runs the ordinary CLI (`onionskin poll`, `reply --file`, `status`) under
// the holder `onionskin-bg-<session key>`; the server treats it like any other agent, plus the guards in src/session.js and src/cli.js.
//
// Ownership: each agent is a detached process group (pgid = pid). Its record <state>/agents/<key>.json holds {pid, pgid, lstart, holder, key,
// cli, session_id}. A signal goes to the group only while `ps -o lstart=` of the pid still equals the recorded start time, so a pid the
// system reused is never signaled. A server that starts stops the groups its crashed predecessor left (reapOrphans).
//
// Lifecycle: started by an open from a person's terminal, by a Send that nobody took (at once for such a file, after a 20 s grace for any
// other and for any file open in Terminal), or by the page's Start button. Stopped on Close session, server stop, 20 minutes without a tab,
// or when an agent of the person's own polls the file (it supersedes the background one). A crash hands the batch back at once (Sessions.releaseAgent) and restarts with
// backoff 2, 4, 8, 16, 32 s, resuming the conversation; at most 5 starts per document per rolling hour. A sign-in, usage-limit or refusal
// failure never restarts by itself. At most 3 agents run at once (a ceiling, not a design limit: raise it when someone asks); a 4th waits.
//
// The stream (stream-json) is read line by line in memory for the page's activity list and kept as a private transcript
// <state>/agents/<key>/transcript.jsonl (0600). Close session removes the agent's folder and Claude Code's own copy of the conversation.
import { execFile as nodeExecFile, spawn as nodeSpawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env as cfg } from "./constants.js";
import { stateDir, sub, writeStateFile } from "./paths.js";
import * as settings from "./settings.js";
import { DEFAULT_MODEL, POLL_TIMEOUT, agentsDisabled, bgHolder, buildArgv, cleanEnv, findClaude, findCodex, isBgHolder, preflight } from "./agent-detect.js";
import { backgroundPrompt, readSkill, refDir, resumePrompt } from "./agent-prompt.js";

const cliJs = path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.js");

// The stream parser (src/agent-events.js) is built alongside this file; until it is present, a minimal parser with the same exports keeps
// the runner working (session id, the final result, a sign-in or limit failure; no activity lines).
const fallbackEvents = {
  parseLine(cli, line) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      return {};
    }
    const out = {};
    if (typeof e?.session_id === "string") out.sessionId = e.session_id;
    if (e?.type === "rate_limit_event" && e.rate_limit_info?.status === "rejected") out.failure = "limit";
    if (e?.type === "assistant" && e.error === "authentication_failed") out.failure = "signed_out";
    if (e?.type === "assistant" && (e.error === "rate_limit" || e.error === "billing_error")) out.failure = "limit";
    if (e?.type === "result") out.result = { ok: e.is_error !== true, turnsExhausted: e.subtype === "error_max_turns", denials: Array.isArray(e.permission_denials) ? e.permission_denials.length : 0 };
    return out;
  },
  classifyExit({ code = null, signal = null, sawResult = false, denials = 0, heldBatch = false, failure = null } = {}) {
    if (failure === "signed_out" || failure === "limit") return failure;
    if (denials > 0 && heldBatch) return "refused";
    if (code === 0 && !signal && sawResult && !heldBatch) return null;
    return "crashed";
  },
};
const loadedEvents = await import("./agent-events.js").catch(() => fallbackEvents);

const HOUR = 60 * 60 * 1000;
export const LIMITS = { maxAgents: 3, startsPerHour: 5, graceMs: 20_000, idleMs: 20 * 60 * 1000, killMs: 4000, closeGraceMs: 10_000, activity: 50 };
const backoffMs = (n) => 1000 * 2 ** Math.min(Math.max(n, 1), 5); // 2, 4, 8, 16, 32 s

const agentsDir = () => sub("agents");
const recordFile = (key) => path.join(agentsDir(), `${key}.json`);

/**
 * deps: {spawn, execFile, kill(pid, sig), now, setTimeout, env, events, tabs(key) -> number of open tabs, open(file) -> opens a .command
 * file in Terminal, limits}. Everything that starts, signals or waits is injectable, so tests run with no process and a fake clock.
 */
export function agentRunner(sessions, deps = {}) {
  const spawn = deps.spawn || nodeSpawn;
  const execFile = deps.execFile || nodeExecFile;
  const kill = deps.kill || ((pid, sig) => process.kill(pid, sig));
  const now = deps.now || Date.now;
  const later = deps.setTimeout || setTimeout;
  const env = deps.env || process.env;
  const events = deps.events || loadedEvents;
  const tabs = deps.tabs || (() => 0);
  const L = { ...LIMITS, ...(deps.limits || {}) };
  const entries = new Map(); // key -> entry
  let stoppingAll = false;

  const entry = (key) => {
    let e = entries.get(key);
    if (!e) {
      e = { key, holder: bgHolder(key), child: null, state: "none", failure: null, activity: [], starts: [], crashes: 0, nextStartAt: 0, strandedAt: 0, idleSince: 0, waiting: false, external: false, sessionId: null, resumable: false, lastBatch: null, resumeNext: false };
      entries.set(key, e);
    }
    return e;
  };
  const sessionOf = (key) => sessions.map.get(key) || null;
  const notify = (key) => {
    const s = sessionOf(key);
    if (s) sessions.emit("change", s, "state");
  };
  const foreign = (s, holder) => !!s && (s.pollers.some((p) => p.holder !== holder) || (!!s.delivered && !s.delivered.local && s.delivered.lease.holder !== holder));
  const holds = (s, holder) => !!s?.delivered && !s.delivered.local && s.delivered.lease.holder === holder;
  const resident = () => [...entries.values()].filter((e) => e.child || e.state === "starting" && !e.waiting && !e.nextStartAt).length;
  const fail = (e, code, extra = {}) => {
    e.failure = { code, ...extra };
    e.state = "failed";
    e.waiting = false;
    e.nextStartAt = 0;
    notify(e.key);
  };

  // ---- process ownership --------------------------------------------------------------------------------
  const lstartOf = (pid) =>
    new Promise((resolve) => execFile("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { timeout: 5000 }, (err, out) => resolve(err ? null : String(out).trim() || null)));

  /** SIGTERM to the group, SIGKILL after 4 s; each only while the pid still started at `lstart`. Resolves after the first signal (or none). */
  async function signalGroup(rec) {
    if (!rec?.pgid || !rec.lstart || rec.pgid !== rec.pid) return false; // our agents lead their own group; any other record is not ours
    if ((await lstartOf(rec.pid)) !== rec.lstart) return false;
    try {
      kill(-rec.pgid, "SIGTERM");
    } catch {
      return false;
    }
    const t = later(async () => {
      if ((await lstartOf(rec.pid)) !== rec.lstart) return;
      try {
        kill(-rec.pgid, "SIGKILL");
      } catch {}
    }, L.killMs);
    t?.unref?.();
    return true;
  }

  /** Stops the groups a crashed server left behind (their records match a live pid and start time), and deletes every record. */
  async function reapOrphans() {
    let names = [];
    try {
      names = fs.readdirSync(agentsDir()).filter((n) => /^[0-9a-f]{16}\.json$/.test(n));
    } catch {}
    const out = [];
    for (const n of names) {
      let rec = null;
      try {
        rec = JSON.parse(fs.readFileSync(path.join(agentsDir(), n), "utf8"));
      } catch {}
      const stopped = rec ? await signalGroup(rec) : false;
      out.push({ key: n.slice(0, -5), stopped });
      fs.rmSync(path.join(agentsDir(), n), { force: true });
    }
    return out;
  }

  // ---- start ------------------------------------------------------------------------------------------------
  /** One agent per document: does nothing when one runs, is starting, waits for a slot or backs off; never while another agent polls. */
  function ensure(key, { now: immediate = false } = {}) {
    if (agentsDisabled(env) || stoppingAll) return;
    const s = sessionOf(key);
    if (!s || s.closed) return;
    const e = entry(key);
    if (foreign(s, e.holder)) {
      e.external = true;
      notify(key);
      return;
    }
    e.external = false;
    if (e.child || e.launching || (e.state === "failed" && !immediate)) return;
    if (e.nextStartAt && !immediate) return; // a restart is already scheduled
    e.nextStartAt = 0;
    e.state = "starting";
    if (resident() > L.maxAgents) {
      e.waiting = true; // started by tick() when a slot frees
      notify(key);
      return;
    }
    e.waiting = false;
    launch(e, { counted: true });
  }

  async function launch(e, { counted, resume = false }) {
    const s = sessionOf(e.key);
    if (!s || s.closed) {
      e.state = "none";
      return;
    }
    // the first start after a person's Stop (stopAndTakeBack): a fresh conversation (the stopped one still holds the withdrawn batch), and not
    // one of the hourly starts
    if (e.resumeNext) {
      e.resumeNext = false;
      counted = false;
      resume = false;
    }
    e.launching = true;
    e.state = "starting";
    e.failure = null;
    notify(e.key);
    try {
      if (counted) {
        e.starts = e.starts.filter((t) => now() - t < HOUR);
        if (e.starts.length >= L.startsPerHour) return fail(e, "too_many_restarts");
        e.starts.push(now());
      }
      const bin = findClaude(env);
      if (!bin) return fail(e, "not_installed", findCodex(env) ? { codex: true } : {});
      const workDir = ensureWorkDir(e.key);
      const binDir = ensureBin();
      const childEnv = cleanEnv({ binDir, stateDir: fs.realpathSync(stateDir()), holder: e.holder, workDir, env });
      const pre = await preflight(bin, { env: childEnv, execFile });
      if (pre) return fail(e, pre.code, pre.update ? { update: true } : {});
      if (!sessionOf(e.key) || sessionOf(e.key).closed || stoppingAll) {
        e.state = "none";
        return;
      }
      if (foreign(sessionOf(e.key), e.holder)) {
        e.external = true;
        e.state = "none";
        return notify(e.key);
      }
      if (!resume || !e.sessionId) e.sessionId = crypto.randomUUID();
      const model = settings.readSettings?.().agent?.model || DEFAULT_MODEL;
      const argv = buildArgv({ prompt: backgroundPrompt({ file: s.file, workDir, timeout: POLL_TIMEOUT }), skill: readSkill(), model, sessionId: e.sessionId, resume: resume && e.resumable, workDir, refDir: refDir() });
      const child = spawn(bin, argv, { cwd: workDir, env: childEnv, stdio: ["ignore", "pipe", "pipe"], detached: true });
      attach(e, child, workDir, { resumed: resume && e.resumable });
    } catch (err) {
      fail(e, "crashed");
    } finally {
      e.launching = false;
    }
  }

  function ensureWorkDir(key) {
    const dir = path.join(agentsDir(), key);
    fs.mkdirSync(path.join(dir, "outline"), { recursive: true, mode: 0o700 }); // the outline files the session writes, the one folder it may read
    fs.chmodSync(dir, 0o700);
    fs.chmodSync(path.join(dir, "outline"), 0o700);
    return fs.realpathSync(dir); // a real path: --restricted compares paths literally
  }

  /** <state>/agents/bin/onionskin runs exactly this server's CLI, whatever `onionskin` is on the person's PATH. */
  function ensureBin() {
    const dir = path.join(agentsDir(), "bin");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const q = (x) => `'${String(x).replace(/'/g, `'\\''`)}'`;
    const body = `#!/bin/sh\nexec ${q(process.execPath)} ${q(cliJs)} "$@"\n`;
    const f = path.join(dir, "onionskin");
    let cur = null;
    try {
      cur = fs.readFileSync(f, "utf8");
    } catch {}
    if (cur !== body) {
      writeStateFile(f, body);
      fs.chmodSync(f, 0o700);
    }
    return fs.realpathSync(dir);
  }

  function attach(e, child, workDir, { resumed = false } = {}) {
    e.child = child;
    e.spawned = true;
    e.run = { sawResult: false, denials: 0, failure: null, resetsAt: null, turnsExhausted: false, lines: 0, resumed };
    e.idleSince = 0;
    const rec = { pid: child.pid, pgid: child.pid, lstart: null, holder: e.holder, key: e.key, cli: "claude", session_id: e.sessionId };
    e.record = rec;
    const saveRec = () => {
      try {
        writeStateFile(recordFile(e.key), JSON.stringify(rec));
      } catch {}
    };
    saveRec();
    e.lstartReady = lstartOf(child.pid).then((l) => {
      rec.lstart = l;
      if (e.child === child) saveRec();
    });
    let transcript = null;
    try {
      transcript = fs.openSync(path.join(workDir, "transcript.jsonl"), "a", 0o600);
    } catch {}
    let buf = "";
    child.stdout?.on("data", (d) => {
      if (transcript !== null) {
        try {
          fs.writeSync(transcript, d);
        } catch {}
      }
      buf += d.toString("utf8");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        onLine(e, line);
      }
    });
    child.stderr?.on("data", () => {}); // drained; Claude Code writes nothing there that the page needs
    child.on("error", () => {});
    child.on("exit", (code, signal) => {
      if (transcript !== null) {
        try {
          fs.closeSync(transcript);
        } catch {}
      }
      if (buf) onLine(e, buf);
      if (e.child === child) onExit(e, code, signal);
    });
    e.state = "starting";
    notify(e.key);
  }

  function onLine(e, line) {
    if (!line.trim()) return;
    e.run.lines++;
    const r = events.parseLine("claude", line) || {};
    if (r.sessionId) e.resumable = true; // the conversation exists on disk: a restart can resume it
    if (r.failure) {
      e.run.failure = r.failure;
      if (r.resetsAt) e.run.resetsAt = r.resetsAt;
    }
    if (r.result) {
      e.run.sawResult = true;
      e.run.denials += r.result.denials || 0;
      e.run.turnsExhausted = !!r.result.turnsExhausted;
    }
    if (r.activity) {
      e.activity.push({ at: now(), text: r.activity });
      if (e.activity.length > L.activity) e.activity.splice(0, e.activity.length - L.activity);
      notify(e.key);
    }
  }

  /** This agent's polls still registered are answered closed and removed, so no Send is delivered to a process that is going away. */
  function dropPolls(e, s) {
    if (!s) return;
    const mine = s.pollers.filter((p) => p.holder === e.holder);
    if (!mine.length) return;
    s.pollers.splice(0, s.pollers.length, ...s.pollers.filter((p) => p.holder !== e.holder));
    for (const p of mine) p.resolve({ status: "closed", reason: "the agent was stopped" });
  }

  function onExit(e, code, signal) {
    e.child = null;
    fs.rmSync(recordFile(e.key), { force: true });
    const s = sessionOf(e.key);
    // its `onionskin poll` child may outlive it (same group, still connected): that poll is answered closed, so a Send never goes to nobody
    dropPolls(e, s);
    const held = holds(s, e.holder);
    if (held && !s.closed) {
      try {
        sessions.releaseAgent(e.key, e.holder); // the page unlocks now, not after the 15-minute lease
      } catch {}
    }
    const why = e.stopping;
    e.stopping = null;
    if (e.cleanupOnExit) {
      e.cleanupOnExit = false;
      cleanup(e.key);
    }
    if (why) {
      e.state = why === "handover" ? "handover" : "none";
      startWaiting();
      notify(e.key);
      // a Send that came while the stopped agent was still exiting found it running and started nothing (its polls are answered closed, see
      // alive()): start for it now. After a person's Stop, and after an idle stop of a file opened for the background agent (no grace there).
      // An idle stop does not drop its polls, so a poll it had waiting may have taken a Send and handed it back just now (releaseAgent,
      // which tells nothing): on any other file that Send gets the usual stranded grace here, then tick() starts an agent.
      const restart = why === "stop" ? e.resumeNext : why === "idle" && s?.openedFor === "background";
      const left = s && !s.closed && sessions.state(s) === "stranded" && !s.pollers.length;
      if (restart && left) ensure(e.key);
      else if (why === "idle" && left && !e.strandedAt) e.strandedAt = now();
      return;
    }
    if (!s || s.closed || e.external || stoppingAll) {
      e.state = "none";
      startWaiting();
      return notify(e.key);
    }
    if (e.run.turnsExhausted) {
      // the turn cap of one process: a fresh conversation, not a crash, and it does not count toward the hourly cap
      e.resumable = false;
      e.sessionId = null;
      launch(e, { counted: false });
      return;
    }
    const code2 = events.classifyExit({ code, signal, sawResult: e.run.sawResult, denials: e.run.denials, heldBatch: held, failure: e.run.failure });
    if (code2 === "signed_out" || code2 === "limit" || code2 === "refused") {
      fail(e, code2, code2 === "limit" && e.run.resetsAt ? { resetsAt: e.run.resetsAt } : {});
      return startWaiting();
    }
    // crashed, or ended its turn on its own while it should keep listening: restart with backoff, resuming the conversation
    if (e.run.resumed && !e.run.lines) e.resumable = false; // the resume itself failed (no stream at all): the next start is a fresh conversation
    e.crashes++;
    e.nextStartAt = now() + backoffMs(e.crashes);
    e.state = "starting";
    notify(e.key);
    startWaiting();
  }

  function startWaiting() {
    for (const w of entries.values()) {
      if (!w.waiting || resident() >= L.maxAgents) continue;
      w.waiting = false;
      launch(w, { counted: true });
    }
  }

  // ---- stop -------------------------------------------------------------------------------------------------
  /** Stops this document's agent (`why`: closed, stop, idle, superseded, handover, shutdown). Resolves once the first signal went out. */
  async function stop(key, why = "stop") {
    const e = entries.get(key);
    if (!e) return false;
    e.waiting = false;
    e.nextStartAt = 0;
    e.strandedAt = 0;
    if (!e.child) {
      if (why !== "superseded") e.state = why === "handover" ? "handover" : "none";
      notify(key);
      return false;
    }
    e.stopping = why;
    await e.lstartReady;
    return signalGroup(e.record);
  }

  /**
   * The page's Stop (POST /api/agent {action: "stop", takeBack: true}). The batch is taken back FIRST: the delivery and its lease are gone,
   * so a later agent-write, apply-report or done from the stopping agent is refused (stale or no batch), and its exit has nothing to hand
   * back (stopping first would put the batch back to pending). A run that already wrote stays as a Revert-able entry (Sessions.takeBack).
   * Only then is the agent stopped, and only when this runner's agent held that batch: an agent of the person's own, a run on this Mac,
   * or an agent that is only starting or listening gets no signal. The next start is a fresh conversation, at once and not counted (launch).
   */
  async function stopAndTakeBack(key) {
    const s = sessions.get(key);
    const e = entries.get(key);
    const ours = !!e?.child && holds(s, e.holder); // decided before the take back clears the delivery
    if (s.delivered || s.pending) sessions.takeBack(key); // nothing in flight (it just finished): nothing to take back, and no error
    if (!ours) return false;
    e.resumeNext = true; // the next start: at once, uncounted, and a fresh conversation (launch)
    e.resumable = false;
    e.sessionId = null;
    dropPolls(e, s);
    return stop(key, "stop");
  }

  /** Server shutdown: every agent's group is signaled; resolves when they all exited or after the kill delay. */
  async function stopAll() {
    stoppingAll = true;
    const live = [...entries.values()].filter((e) => e.child);
    const exits = live.map((e) => new Promise((r) => (e.child.once("exit", r), later(r, L.killMs + 500)?.unref?.())));
    await Promise.all(live.map((e) => stop(e.key, "shutdown")));
    await Promise.all(exits);
  }

  // ---- what the server tells it ------------------------------------------------------------------------------
  sessions.on("stranded", (s) => {
    const e = entry(s.key);
    // open in Terminal: its agent may still be starting (Claude Code, then its first poll) or be between two polls, so a background agent
    // started now would run beside it. The grace first; if the Terminal agent never polls (its window was closed), tick() starts one.
    if (e.state === "handover") {
      if (!e.strandedAt) e.strandedAt = now();
      return;
    }
    if (s.openedFor === "background" || e.resumeNext) return ensure(s.key); // after a Stop, our own agent was the one working: no grace
    if (!e.strandedAt) e.strandedAt = now(); // someone's own agent may be between two polls: wait the grace first (tick)
  });
  sessions.on("superseded", (s, holder) => {
    if (holder !== bgHolder(s.key)) return;
    const e = entry(s.key);
    e.external = true;
    e.resumeNext = false; // another agent serves the file now: a later start is an ordinary one
    stop(s.key, "superseded");
    notify(s.key);
  });
  sessions.on("closed", (s) => {
    const e = entries.get(s.key);
    if (e?.child) {
      // its poll was answered "closed", so it ends by itself (and writes its last result); the group is stopped only if it has not after 10 s.
      // The cleanup runs after the process is gone, so nothing writes into the folder again.
      const child = e.child;
      e.cleanupOnExit = true;
      e.stopping = "closed";
      e.waiting = false;
      e.nextStartAt = 0;
      later(() => e.child === child && stop(s.key, "closed"), L.closeGraceMs)?.unref?.();
    } else cleanup(s.key);
  });
  sessions.on("change", (s) => {
    const e = entries.get(s.key);
    if (!e) return;
    if (e.resumeNext && !e.child && foreign(s, e.holder)) e.resumeNext = false; // another agent took over after the Stop: no shortcut past its grace
    // a new delivery to this agent: older reply files are not needed any more (each batch writes a new one)
    const id = holds(s, e.holder) ? s.delivered.batch.batch_id : null;
    if (id && id !== e.lastBatch) {
      e.lastBatch = id;
      e.crashes = 0; // it got as far as a batch: the next crash backs off from the start again
      try {
        const dir = path.join(agentsDir(), s.key);
        for (const n of fs.readdirSync(dir)) if (/^reply-.*\.json$/.test(n) && n !== `reply-${id}.json`) fs.rmSync(path.join(dir, n), { force: true });
      } catch {}
    }
  });

  /** Close session: the agent's folder (transcript, reply files) and Claude Code's own copy of the conversation are removed. */
  function cleanup(key) {
    const e = entries.get(key);
    const dir = path.join(agentsDir(), key);
    let real = null;
    try {
      real = fs.realpathSync(dir);
    } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
    if (e) {
      e.activity = [];
      e.sessionId = null;
      e.resumable = false;
      e.resumeNext = false;
    }
    // also when this runner never started it (the server restarted since): Claude Code's copy of that conversation goes too
    const bin = real && !agentsDisabled(env) ? findClaude(env) : null;
    if (bin) execFile(bin, ["purge", real, "--yes"], { env: cleanEnv({ binDir: path.join(agentsDir(), "bin"), stateDir: stateDir(), holder: bgHolder(key), workDir: real, env }), timeout: 15000 }, () => {});
  }

  /** Called every server tick: the stranded grace, the backoff, the slot queue, the idle stop. */
  function tick() {
    for (const e of entries.values()) {
      const s = sessionOf(e.key);
      if (!s) continue;
      if (e.strandedAt) {
        if (s.pollers.length || sessions.state(s) !== "stranded") e.strandedAt = 0;
        else if (now() - e.strandedAt >= L.graceMs) {
          e.strandedAt = 0;
          if (e.state === "handover") e.state = "none"; // the Terminal agent did not poll in time: the background agent may start again
          ensure(e.key);
        }
      }
      if (e.nextStartAt && now() >= e.nextStartAt && !e.child) {
        e.nextStartAt = 0;
        if (foreign(s, e.holder) || s.closed) {
          e.state = "none";
          notify(e.key);
        } else launch(e, { counted: true, resume: true });
      }
      if (e.child) {
        if (tabs(e.key) > 0 || holds(s, e.holder)) e.idleSince = 0;
        else if (!e.idleSince) e.idleSince = now();
        else if (now() - e.idleSince >= L.idleMs) stop(e.key, "idle");
      }
    }
    startWaiting();
  }

  /** The page's buttons (POST /api/agent). Returns nothing; the session view carries the result. */
  async function action(key, { action: a, on, cli, takeBack = false }) {
    const s = sessions.get(key);
    if (a === "start") {
      const e = entry(key);
      e.failure = null;
      e.starts = []; // Try again: the person asked, so the hourly window starts over
      e.crashes = 0;
      if (e.state === "failed" || e.state === "handover") e.state = "none";
      if (agentsDisabled(env)) return;
      return ensure(key, { now: true });
    }
    if (a === "stop") return takeBack ? stopAndTakeBack(key) : stop(key, "stop");
    if (a === "use") {
      settings.writeAgent?.({ cli });
      return;
    }
    if (a === "show") {
      settings.writeAgent?.({ show: on });
      return notify(key);
    }
    if (a === "terminal") return handover(s);
  }

  /** Open in Terminal: the background agent stops and the same conversation opens in Terminal with the same limits. */
  async function handover(s) {
    const e = entry(s.key);
    const bin = findClaude(env);
    if (!bin || agentsDisabled(env)) return fail(e, "not_installed");
    if (e.state === "failed" && e.failure?.code === "signed_out") return signIn(e, bin);
    // the background process is gone before Terminal opens the same conversation (two processes never share one), at most 5 s
    const gone = e.child ? new Promise((r) => (e.child.once("exit", r), later(r, L.killMs + 1000)?.unref?.())) : null;
    await stop(s.key, "handover");
    if (gone) await gone;
    e.state = "handover";
    e.resumeNext = false; // the conversation goes to Terminal: the background agent must not resume it by itself
    const workDir = ensureWorkDir(s.key);
    const binDir = ensureBin();
    const holder = `onionskin-term-${s.key}`; // a foreign holder: the runner stays down while it polls
    const childEnv = cleanEnv({ binDir, stateDir: fs.realpathSync(stateDir()), holder, workDir, env });
    const resume = !!(e.sessionId && e.resumable);
    if (!resume) e.sessionId = crypto.randomUUID();
    const model = settings.readSettings?.().agent?.model || DEFAULT_MODEL;
    // its first message: the background prompt for a new conversation, a short "go on" for a resumed one (it already holds that prompt)
    const prompt = resume ? resumePrompt({ file: s.file, timeout: POLL_TIMEOUT }) : backgroundPrompt({ file: s.file, workDir, timeout: POLL_TIMEOUT });
    const argv = buildArgv({ prompt, skill: readSkill(), model, sessionId: e.sessionId, resume, workDir, refDir: refDir(), print: false });
    const q = (x) => `'${String(x).replace(/'/g, `'\\''`)}'`;
    const f = path.join(workDir, "open-agent.command");
    writeStateFile(f, `#!/bin/sh\ncd ${q(workDir)} || exit 1\nexec /usr/bin/env -i ${Object.entries(childEnv).map(([k, v]) => q(`${k}=${v}`)).join(" ")} ${q(bin)} ${argv.map(q).join(" ")}\n`);
    fs.chmodSync(f, 0o700);
    (deps.open || openInTerminal)(f);
    // a batch already waiting (the stopped agent handed it back): the Terminal agent takes it with its first poll; the grace keeps the
    // fallback for a Terminal that never polls (tick)
    if (sessions.state(s) === "stranded" && !s.pollers.length) e.strandedAt = now();
    notify(s.key);
  }

  /** "Open Terminal to sign in": a Terminal window runs `claude auth login` (no agent, no conversation, no key); the page keeps Try again. */
  function signIn(e, bin) {
    const q = (x) => `'${String(x).replace(/'/g, `'\\''`)}'`;
    const dir = ensureWorkDir(e.key);
    const vars = { HOME: env.HOME || "", USER: env.USER || "", LANG: "en_US.UTF-8", PATH: "/usr/bin:/bin" };
    const f = path.join(dir, "sign-in.command");
    writeStateFile(f, `#!/bin/sh\nexec /usr/bin/env -i ${Object.entries(vars).map(([k, v]) => q(`${k}=${v}`)).join(" ")} ${q(bin)} 'auth' 'login'\n`);
    fs.chmodSync(f, 0o700);
    (deps.open || openInTerminal)(f);
    notify(e.key);
  }

  function openInTerminal(f) {
    const stub = cfg("OPEN_STUB"); // tests: record the path instead of opening Terminal
    if (stub) return fs.appendFileSync(stub, `${f}\n`);
    execFile("/usr/bin/open", ["-a", "Terminal", f], () => {});
  }

  /** What the page sees (docs/contracts/routes.md, the `agent` field of the session). */
  function viewFor(key) {
    const s = sessionOf(key);
    const e = entries.get(key);
    let show = false;
    try {
      show = settings.readSettings?.().agent?.show === true;
    } catch {}
    // startsLeft: the counted starts still allowed in the rolling hour (not shown by the page); read only, the list is pruned at launch
    const used = e ? e.starts.filter((t) => now() - t < HOUR).length : 0;
    const startsLeft = Math.max(L.startsPerHour - used, 0);
    const base = { cli: e ? "claude" : null, show, activity: e ? e.activity.slice() : [], failure: e?.failure ? { ...e.failure } : null, startsLeft };
    let state = "none";
    if (e?.state === "failed") state = "failed";
    else if (e?.state === "handover") state = "handover";
    else if (s && foreign(s, bgHolder(key))) state = "external";
    else if (e?.child && e.stopping === "stop" && e.resumeNext) state = "none"; // a Stop's agent still exiting: shown stopped at once
    else if (e?.child) state = holds(s, e.holder) ? "working" : s?.pollers.some((p) => p.holder === e.holder) ? "ready" : "starting";
    else if (e && (e.launching || e.waiting || e.nextStartAt || e.state === "starting")) state = "starting";
    if (state !== "failed") base.failure = null;
    // waiting for one of the agent slots (LIMITS.maxAgents): the page adds "Another document's agent is busy."
    return state === "starting" && e?.waiting ? { state, ...base, busy: true } : { state, ...base };
  }

  /**
   * False when this runner started an agent for the file and no process of it runs now: src/session.js answers such a background poll
   * "closed" (a poll child that outlived its agent). A file this runner never started an agent for is left to the other guards.
   */
  const alive = (key) => {
    const e = entries.get(key);
    return !e?.spawned || (!!e.child && !e.stopping); // a stopping agent's next poll is answered closed too: it never takes a new Send
  };

  return { ensure, stop, stopAll, reapOrphans, viewFor, handover, tick, action, alive, isBgHolder, entries };
}
