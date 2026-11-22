#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import tty from "node:tty";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PRODUCT, SERVER_PROTOCOL } from "./constants.js";
import { holderFor, loadHolder, loadTicketRecord, parseTicket, saveHolder } from "./lease.js";
import { ensureStateDir, serverRecordPath, socketPath, stateDir } from "./paths.js";
import { ApplyError, applyCommand, commitCommand, summarizeReport } from "./apply.js";
import { ReplyError, replyCommand } from "./reply.js";
import { setupChecker } from "./checker.js";
import { runSetup } from "./setup.js";
import { expandShortcut, personOpenText, personPollText, pickAudience, shellQuote } from "./person.js";
import { NOT_YOUR_FILE, agentMayUse, findClaude, findCodex, isAgentHolder } from "./agent-detect.js";
import { BG_PRESETS, DEFAULT_BACKGROUND, MAX_IMAGE_BYTES, SettingsError, describeBackground, readSettings, saveCustomImage, writeBackground } from "./settings.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = PRODUCT.bin;
const HELP = `${PRODUCT.name}

  ${BIN} open <file.docx|xlsx|pptx|html|htm|md|markdown> [--no-open] [--no-agent|--agent]   Open the file in the browser editor (also: ${BIN} <file>). At a terminal it also starts Claude Code on it in the background; --no-agent only opens the page, --agent prints the agent's output
  ${BIN} poll <file> [--ack] [--full] [--timeout <secs>] [--agent]   Block until the user hits Send, print the batch as JSON (--full: the complete batch even when you already have the rules)
  ${BIN} status <file> [--ticket]                 Print session state without blocking (--ticket: re-read your delivery's ticket)
  ${BIN} apply <file> --ops <ops.json> --lease <ticket> [--dry-run] [--partial] [--summary] [--batch <batch.json>]
                                                  Make anchored edits through the same engine the browser uses
  ${BIN} reply <file> --lease <ticket> [--json '<json>' | --file <path>] [--partial] [--then-poll [--timeout <secs>]]
                                                  Answer the whole batch in ONE call: apply + done (JSON on stdin when no --json/--file); --then-poll waits for the next batch
  ${BIN} commit <file> --from <candidate> --lease <ticket> [--base <sha256>]
                                                  Submit a COPY edited with another tool through the checked write
  ${BIN} done <file> --results <results.json> --lease <ticket> [--summary]   Report the finished run
  ${BIN} setup [--dry-run] [--force] [--uninstall]  Install the agent skill into ~/.claude/skills and ~/.agents/skills
  ${BIN} setup-checker                            Create the Python venv for the deeper checks at \`done\` (uses the network once)
  ${BIN} setup-rewriter [--remove]                 Turn on quick fixes on this Mac: quick spelling and grammar fixes on one sentence, with Apple's built-in model (macOS 26 or later, Apple Intelligence on; nothing is downloaded); --remove turns them off
  ${BIN} doctor [--json] [--verbose]               Check the install (OK / MISSING / NOTE per line, fix command on each failure); exit 1 if a required check fails
  ${BIN} update [--check] [--yes] [--force]        Bring this copy to the latest release, the way it was installed (checks for a new version only when you run it)
                                                  --check: print this version and the latest one, change nothing. An npm copy gets the two npm commands (--yes runs them).
                                                  Refuses while a session has unsent edits, draft comments or a batch in flight (--force updates anyway)
  ${BIN} utf8-copy <file.html|htm>                Write a UTF-8 copy of a page saved as windows-1252 or ISO-8859-1 next to it (<name>.utf8.html, only when that name is free); the file itself is not changed
  ${BIN} shapes <file.pptx> [--slide <slide id>]   List the shapes of a slide (id, name, placeholder, text preview) as JSON; read-only
  ${BIN} config background <${BG_PRESETS.join("|")}|default>      Choose the background behind the editing UI (this machine)
  ${BIN} config background --image <file> [--strength 0-100] [--no-blur]   Use your own PNG, JPEG or WebP (max 15 MB, scaled by the page)
  ${BIN} config get background                    Print the current background choice
  ${BIN} stop                                     Stop the local server (and remove a leftover socket file nothing answers on)
  ${BIN} --version                                Print the version
`;

/** The flags each subcommand accepts (parseArgs and parseApplyArgs reject any other). */
export const FLAGS = {
  open: ["--no-open"],
  poll: ["--ack", "--full", "--timeout"],
  reply: ["--lease", "--json", "--file", "--partial", "--then-poll", "--timeout"],
  status: ["--ticket"],
  done: ["--results", "--lease", "--summary"],
  apply: ["--ops", "--dry-run", "--partial", "--batch", "--holder", "--lease", "--standalone", "--summary"],
  commit: ["--from", "--lease", "--base", "--standalone", "--holder"],
  setup: ["--dry-run", "--force", "--uninstall"],
  "setup-checker": [],
  "setup-rewriter": ["--model", "--remove", "--clean-old"],
  doctor: ["--json", "--verbose"],
  update: ["--check", "--yes", "--force"],
  shapes: ["--slide"],
  "utf8-copy": [],
  config: ["--image", "--strength", "--no-blur"],
  stop: [],
};

/** The lines of HELP that belong to one subcommand: its usage line(s) and the indented lines that continue them. */
export function commandHelp(cmd) {
  const keep = [];
  let on = false;
  for (const line of HELP.split("\n").slice(2)) {
    if (line.startsWith(`  ${BIN} `)) on = line.startsWith(`  ${BIN} ${cmd} `) || line === `  ${BIN} ${cmd}`;
    else if (!/^\s{10,}\S/.test(line)) on = false; // a continuation line is indented deeper than a usage line
    if (on) keep.push(line);
  }
  return keep.length ? keep.join("\n") + "\n" : HELP;
}

// a flag's value is never a request for help: `reply --json '-h'`
const TAKES_VALUE = ["--json", "--file", "--results", "--ops", "--batch", "--from", "--lease", "--base", "--holder", "--model", "--image", "--timeout", "--slide", "--strength"];
export const asksForHelp = (argv) => argv[0] in FLAGS && argv.slice(1).some((x, i) => (x === "--help" || x === "-h") && !TAKES_VALUE.includes(argv[i]));

export { shellQuote };

function req(options, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ socketPath: socketPath(), ...options, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(options.headers || {}) } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
      res.on("aborted", () => reject(new Error("server connection closed")));
      res.on("close", () => !res.complete && reject(new Error("server connection closed")));
    });
    r.on("error", reject);
    if (options.timeout) r.on("timeout", () => r.destroy(new Error("request timed out")));
    if (options.signal) options.signal.addEventListener("abort", () => r.destroy(new Error("aborted")), { once: true });
    // `deadline` (ms): the whole request, answer included, or it ends with `deadlineError`
    if (options.deadline) {
      const t = setTimeout(() => r.destroy(new Error(options.deadlineError || "the server did not answer in time")), options.deadline);
      r.on("close", () => clearTimeout(t));
    }
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}
// Opening reads the file in a worker first: up to 60 s waiting for a free reader and 60 s reading (src/offload.js), so the CLI waits longer.
// ONIONSKIN_CLI_OPEN_DEADLINE_MS shortens it in tests.
const openRequest = (body) => {
  const ms = Number(process.env[`${PRODUCT.envPrefix}_CLI_OPEN_DEADLINE_MS`]) || 150_000;
  return req({ method: "POST", path: "/cli/open", deadline: ms, deadlineError: `Onionskin did not finish opening ${path.basename(String(body.file))} within ${Math.round(ms / 1000)} seconds. It may be very large or damaged, or this Mac is very busy. Try again, or open a smaller file` }, body);
};
const json = (t) => {
  try {
    return JSON.parse(t);
  } catch {
    return { error: t.slice(0, 200) };
  }
};

async function healthy({ reportMismatch = false } = {}) {
  try {
    const r = await req({ method: "GET", path: "/health", timeout: 1500 });
    const j = json(r.text);
    if (r.status === 200 && j?.protocol === SERVER_PROTOCOL) return true;
    return reportMismatch && r.status === 200 ? "incompatible" : false;
  } catch {
    return false;
  }
}

/**
 * `stop` leaves no dead socket behind: the socket file in our own state folder that nothing listens on (a server that crashed or was killed
 * leaves it) is removed. It stays when anything could hold it: a connect that is not refused, a server record or a start lock whose
 * process is still alive, a file that is not a socket or not ours. Returns true when a file was removed.
 */
async function removeStaleSocket() {
  const sock = socketPath();
  let st;
  try {
    st = fs.lstatSync(sock);
  } catch {
    return false;
  }
  if (!st.isSocket() || st.uid !== process.getuid() || path.dirname(sock) !== stateDir()) return false;
  const refused = await new Promise((resolve) => {
    const c = net.connect(sock);
    c.setTimeout(1500, () => (c.destroy(), resolve(false)));
    c.once("connect", () => (c.destroy(), resolve(false)));
    c.once("error", (e) => resolve(e.code === "ECONNREFUSED"));
  });
  if (!refused) return false;
  for (const f of [serverRecordPath(), path.join(stateDir(), "start.lock")]) {
    let pid;
    try {
      pid = Number.parseInt(JSON.parse(fs.readFileSync(f, "utf8")).pid ?? fs.readFileSync(f, "utf8"), 10);
    } catch {
      try {
        pid = Number.parseInt(fs.readFileSync(f, "utf8"), 10); // the start lock holds the bare pid
      } catch {
        continue;
      }
    }
    if (!Number.isInteger(pid) || pid <= 0) {
      if (f.endsWith("start.lock")) {
        try {
          if (Date.now() - fs.statSync(f).mtimeMs <= 2000) return false;
        } catch {}
      }
      continue;
    }
    try {
      process.kill(pid, 0);
      return false; // that process is alive: it may be starting up on this socket
    } catch (e) {
      if (e.code === "EPERM") return false;
    }
  }
  try {
    fs.unlinkSync(sock);
    return true;
  } catch {
    return false;
  }
}

/** True when `pid` exists (EPERM also means it exists, owned by another user). */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

/** True when a Unix socket or TCP endpoint accepts a connection within `timeoutMs`. */
function canConnect(opts, timeoutMs = 400) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      try {
        s.destroy();
      } catch {}
      resolve(ok);
    };
    const s = net.createConnection(opts);
    const t = setTimeout(() => finish(false), timeoutMs);
    t.unref?.();
    s.once("connect", () => finish(true));
    s.once("error", () => finish(false));
  });
}

/** True when `pid`'s command line looks like an Onionskin server process. */
function looksLikeOnionskinPid(pid) {
  const r = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 1000 });
  if (r.status !== 0) return false;
  return /server-entry\.js|onionskin/i.test((r.stdout || "").trim());
}

/**
 * Inspects server.json / start.lock when /health did not answer.
 * Treats a recorded pid as the server ONLY when identity is confirmed (the socket or recorded port accepts
 * connections, or the process command matches Onionskin); otherwise removes the stale record(s).
 */
async function inspectRecordedServer() {
  let staleRemoved = false;
  let sockAccepts = null;
  const checkSock = async () => {
    if (sockAccepts === null) sockAccepts = await canConnect({ path: socketPath() });
    return sockAccepts;
  };
  for (const f of [serverRecordPath(), path.join(stateDir(), "start.lock")]) {
    let raw;
    try {
      raw = fs.readFileSync(f, "utf8");
    } catch {
      continue;
    }
    let pid = null;
    let port = null;
    try {
      const obj = JSON.parse(raw);
      pid = Number.parseInt(obj?.pid ?? raw, 10);
      if (Number.isInteger(obj?.port) && obj.port > 0 && obj.port <= 65535) port = obj.port;
    } catch {
      pid = Number.parseInt(raw, 10);
    }
    if (Number.isInteger(pid) && pid > 0 && pidAlive(pid)) {
      const confirmed =
        (await checkSock()) ||
        (port !== null && (await canConnect({ host: "127.0.0.1", port }))) ||
        looksLikeOnionskinPid(pid);
      if (confirmed) return { pid, staleRemoved };
      // If a socket file is still present alongside a live PID, leave both untouched (a server may be starting up; test/stop.test.js)
      // while still returning pid: null so `stop` does not wait 5s or report an unrelated process as stuck.
      if (fs.existsSync(socketPath())) continue;
    }
    try {
      if (f.endsWith("start.lock") && Date.now() - fs.statSync(f).mtimeMs <= 2000) continue;
      fs.unlinkSync(f);
      staleRemoved = true;
    } catch {}
  }
  return { pid: null, staleRemoved };
}

/** `stop` (and `update`): asks a running server to stop, waits for its process to end, then removes a leftover socket. */
async function stopServer({ waitMs = 5000 } = {}) {
  let pid = null;
  let staleRemoved = false;
  let shouldStop = await healthy();
  if (shouldStop) {
    pid = json((await req({ method: "GET", path: "/health", timeout: 1500 }).catch(() => ({ text: "" }))).text).pid;
  } else {
    const r = await req({ method: "GET", path: "/health", timeout: 1500 }).catch(() => null);
    const j = r?.status === 200 ? json(r.text) : null;
    if (j && Number.isInteger(j.pid) && j.pid > 0) {
      pid = j.pid;
      shouldStop = true;
    }
  }
  if (!Number.isInteger(pid) || pid <= 0) {
    const rec = await inspectRecordedServer();
    staleRemoved = rec.staleRemoved;
    if (rec.pid) {
      pid = rec.pid;
      shouldStop = true;
    }
  }
  if (shouldStop) {
    await req({ method: "POST", path: "/cli/stop", timeout: 2000 }, {}).catch(() => {});
    // the server answers first and exits a moment later: "stopped" is printed only once its process is gone (waits at most waitMs)
    const gone = () => !pidAlive(pid);
    const steps = Math.max(1, Math.ceil(waitMs / 50));
    for (let i = 0; i < steps && Number.isInteger(pid) && pid > 0 && !gone(); i++) await new Promise((r) => setTimeout(r, 50));
    if (Number.isInteger(pid) && pid > 0 && !gone()) {
      throw new Error(`server (pid ${pid}) did not stop within ${Math.round(waitMs / 1000)}s`);
    }
  }
  await removeStaleSocket(); // a socket file nothing answers on is no use to anyone, and `doctor` would keep reporting it
  return { staleRemoved, stopped: shouldStop };
}

/** Starts the detached server and waits (event-based) for its "ready" line. */
async function ensureServer() {
  ensureStateDir();
  if (await healthy()) return;
  const child = spawn(process.execPath, [path.join(here, "server-entry.js")], { detached: true, stdio: ["ignore", "pipe", "pipe"], env: process.env });
  const errChunks = [];
  let errLen = 0;
  child.stderr.on("data", (d) => {
    if (errLen >= 4096) return;
    const slice = d.length > 4096 - errLen ? d.subarray(0, 4096 - errLen) : d;
    errChunks.push(slice);
    errLen += slice.length;
  });
  const detail = () => {
    const s = Buffer.concat(errChunks).toString("utf8").trim();
    return s ? `: ${s}` : "";
  };
  try {
    await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error(`could not start the ${PRODUCT.name} server${detail()}`)), 15000);
      child.stdout.once("data", () => (clearTimeout(to), resolve()));
      child.once("exit", () => (clearTimeout(to), resolve())); // lost a race to another server: it is healthy now
      child.once("error", (e) => (clearTimeout(to), reject(new Error(`${e.message}${detail()}`))));
    });
    if (!(await healthy())) {
      if (child.exitCode !== null && !child.stderr.readableEnded) {
        await Promise.race([new Promise((r) => child.stderr.once("end", r)), new Promise((r) => setTimeout(r, 50))]);
      }
      throw new Error(`the ${PRODUCT.name} server did not come up${detail()}`);
    }
  } finally {
    child.stdout.destroy();
    child.stderr.destroy();
    child.unref();
  }
}

export function openBrowserArgs(url, platform = process.platform) {
  if (platform === "darwin") return ["open", [url]];
  if (platform === "win32") return ["cmd", ["/c", "start", "", url.replace(/&/g, "^&")]];
  return ["xdg-open", [url]];
}

function openBrowser(url) {
  const [bin, args] = openBrowserArgs(url);
  const c = spawn(bin, args, { detached: true, stdio: "ignore" });
  c.on("error", () => {});
  c.unref();
}

export { req, stopServer, ensureServer };

/** `config background <preset|default>`, `config background --image <file> [--strength N] [--no-blur]`, `config get background` */
export function parseConfigArgs(args) {
  const a = { action: "", key: "", value: "", image: "", strength: null, blur: null };
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    const x = args[i];
    if (x === "--no-blur") a.blur = false;
    else if (x === "--image" || x.startsWith("--image=")) {
      a.image = x.includes("=") ? x.slice(x.indexOf("=") + 1) : args[++i];
      if (!a.image) throw new Error("--image wants a file path");
    } else if (x === "--strength" || x.startsWith("--strength=")) {
      const v = x.includes("=") ? x.split("=")[1] : args[++i];
      a.strength = /^\d{1,3}$/.test(v || "") ? Number(v) : NaN;
      if (!(a.strength >= 0 && a.strength <= 100)) throw new Error("--strength wants a whole number from 0 to 100");
    } else if (x.startsWith("-")) throw new Error(`unknown option ${x}`);
    else pos.push(x);
  }
  if (pos[0] === "get") {
    if (pos[1] !== "background" || pos.length > 2) throw new Error(`Usage: ${BIN} config get background`);
    return { ...a, action: "get", key: "background" };
  }
  if (pos[0] !== "background") throw new Error(`Usage: ${BIN} config background <${BG_PRESETS.join("|")}|default> | --image <file> [--strength N] [--no-blur]   or   ${BIN} config get background`);
  if (a.image) {
    if (pos.length > 1) throw new Error("--image and a preset name cannot be combined");
    return { ...a, action: "set", key: "background", value: "custom" };
  }
  if (pos.length !== 2 || ![...BG_PRESETS, "default"].includes(pos[1])) throw new Error(`background wants one of ${BG_PRESETS.join(", ")}, default, or --image <file>`);
  return { ...a, action: "set", key: "background", value: pos[1] === "default" ? DEFAULT_BACKGROUND.name : pos[1], reset: pos[1] === "default" };
}

/** Writes <state>/settings.json (and copies the image) directly: no server needs to be running, and a running one re-reads the file per page load. */
export function configCommand(args) {
  const a = parseConfigArgs(args);
  ensureStateDir();
  if (a.action === "get") return `${describeBackground(readSettings().background)}\n`;
  const cur = readSettings().background;
  const keep = a.reset ? { strength: DEFAULT_BACKGROUND.strength, blur: DEFAULT_BACKGROUND.blur } : { strength: a.strength ?? cur.strength, blur: a.blur ?? cur.blur }; // `default` resets the sliders too
  if (a.image) {
    let st;
    try {
      st = fs.statSync(a.image);
    } catch {
      throw new Error(`cannot read ${a.image}`);
    }
    if (!st.isFile()) throw new Error(`${a.image} is not a file`);
    if (st.size > MAX_IMAGE_BYTES) throw new Error("that image is larger than 15 MB");
    try {
      saveCustomImage(fs.readFileSync(a.image));
    } catch (err) {
      if (err instanceof SettingsError) throw new Error(err.message);
      throw err;
    }
    writeBackground({ kind: "custom", ...keep });
    return `Background set to your image. It is copied as it is; the page scales it (and the copy keeps its metadata on disk). Reload the page to see it.\n`;
  }
  writeBackground({ kind: "preset", name: a.value, ...keep });
  return `Background set to ${a.reset ? `the default (${a.value})` : a.value}. Reload the page to see it.\n`;
}

const out = (text) => new Promise((r) => process.stdout.write(text, r));

const realOrSame = (file) => {
  try {
    return fs.realpathSync(file);
  } catch {
    return file;
  }
};

/**
 * Waits for the user's next Send on `file` and returns the batch (or the {status} object). Shared by `poll` and `reply --then-poll`.
 * a = {ack, full, compact, timeout}; `quiet` skips the human line on STDERR.
 */
async function pollFor(file, a, { quiet = false } = {}) {
  // an agent Onionskin started is bound to its one file: refused before anything about another file is asked
  if (!agentMayUse(process.env[`${PRODUCT.envPrefix}_HOLDER`], file)) throw new Error(NOT_YOUR_FILE);
  // an agent Onionskin started (in the background or in Terminal) never starts a server, and never reconnects to one: a server that stopped means its review ended
  const bg = isAgentHolder(process.env[`${PRODUCT.envPrefix}_HOLDER`]); // the background agent, or the same agent opened in Terminal
  const serverGone = { status: "closed", reason: "the server stopped" };
  if (bg) {
    if (!(await healthy())) return serverGone;
  } else await ensureServer();
  if (!quiet) process.stderr.write(`Waiting for the user to hit Send on ${path.basename(file)}...\n`);
  const deadline = a.timeout ? Date.now() + a.timeout * 1000 : Infinity;
  let ack = a.ack;
  const realFile = realOrSame(file);
  const holder = holderFor(realFile, process.env[`${PRODUCT.envPrefix}_HOLDER`]);
  for (let failures = 0; ; ) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { status: "timeout", waited_seconds: a.timeout, next_step: "Run the same poll command again to keep waiting." };
    const ac = new AbortController();
    const timer = Number.isFinite(remaining) ? setTimeout(() => ac.abort(), remaining) : null;
    try {
      const r = await req({ method: "GET", path: `/cli/poll?file=${encodeURIComponent(file)}${ack ? "&ack=1" : ""}${a.full ? "&full=1" : ""}${a.compact ? "&compact=1" : ""}&holder=${encodeURIComponent(holder)}`, signal: ac.signal });
      clearTimeout(timer);
      if (r.status !== 200) throw new Error(json(r.text).error || `server answered ${r.status}`);
      const batch = json(r.text);
      // remember only the holder id (so `poll --ack` renews the same lease). The ticket is printed in the batch's commands; the server keeps a copy
      // for `status --ticket`. No per-file credential is stored here: a later poll must not be able to replace it.
      // (not the background agent's reserved holder: the person's own agent would then load it and poll as the background agent)
      if (batch.lease?.holder && batch.batch_id && !isAgentHolder(batch.lease.holder)) saveHolder(realFile, batch.lease.holder);
      return batch;
    } catch (err) {
      clearTimeout(timer);
      if (ac.signal.aborted) continue; // deadline reached: loop returns the timeout
      if (/not found|no such session/i.test(err.message) || err.message === NOT_YOUR_FILE) throw err;
      if (bg) return serverGone;
      if (++failures > 5) throw err;
      process.stderr.write(`Lost the connection (${err.message}); reconnecting.\n`);
      await new Promise((r) => setTimeout(r, 1000 * failures));
      await ensureServer();
      // the session lives in the server's state dir; re-open it so the poll can register
      await openRequest({ file });
      ack = false;
    }
  }
}

/** `done`: reports `results` for the delivery named by `lease` (a ticket string) and returns the server's answer. Shared by `done` and `reply`. */
async function finishBatch(file, results, lease) {
  const envHolder = process.env[`${PRODUCT.envPrefix}_HOLDER`];
  if (!agentMayUse(envHolder, file)) throw new Error(NOT_YOUR_FILE);
  if (!(await healthy())) throw new Error(`the ${PRODUCT.name} server is not running`);
  const realFile = realOrSame(file);
  // the only credential is the ticket printed in the batch's `done` command; a delivery without it is refused, with no per-file fallback
  const ticket = parseTicket(lease);
  const st = json((await req({ method: "GET", path: `/cli/status?file=${encodeURIComponent(realFile)}${envHolder ? `&holder=${encodeURIComponent(envHolder)}` : ""}` })).text);
  if (!ticket && st.delivered_batch) throw new Error(`a batch is delivered for this file: pass --lease <ticket> (it is printed in the batch's done command; run \`${BIN} status <file> --ticket\` if you lost it, only the agent that polled gets it back)`);
  const claim = ticket ? { holder: envHolder || loadTicketRecord(ticket.batch_id)?.holder, lease_token: ticket.token, batch_id: ticket.batch_id } : envHolder ? { holder: envHolder } : {};
  const r = await req({ method: "POST", path: "/cli/done" }, { file, results, ...claim });
  const j = json(r.text);
  if (r.status !== 200) throw new Error(j.error || "done failed");
  return j;
}

const readStdin = async () => {
  if (process.stdin.isTTY) throw new ReplyError("no reply JSON: pass --json '<json>' or --file <path>, or pipe it on stdin");
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
};


export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const a = { cmd, file: "", noOpen: false, ack: false, timeout: 0, results: "", lease: "" };
  for (let i = 0; i < rest.length; i++) {
    const x = rest[i];
    if (x.startsWith("--") && !(FLAGS[cmd] || []).includes(x.split("=")[0])) throw new Error(`unknown option ${x}`);
    if (x === "--no-open") a.noOpen = true;
    else if (x === "--ack") a.ack = true;
    else if (x === "--full") a.full = true;
    else if (x === "--ticket") a.ticket = true;
    else if (x === "--summary") a.summary = true;
    else if (x === "--slide" || x.startsWith("--slide=")) {
      a.slide = x.includes("=") ? x.split("=")[1] : rest[++i];
      if (!/^\d{1,10}$/.test(a.slide || "")) throw new Error("--slide wants a slide id (digits, the locator.slide_id of an anchor)");
    }
    else if (x === "--json" || x === "--verbose") a[x.slice(2)] = true; // doctor
    else if (x === "--remove") a.remove = true; // setup-rewriter
    else if (x === "--check" || x === "--yes" || x === "--force") a[x.slice(2)] = true; // update
    else if (x === "--clean-old") a.cleanOld = true; // setup-rewriter, from install.sh: only removes what the older Granite download left
    else if (x === "--model" || x.startsWith("--model=")) a.model = x.includes("=") ? x.split("=")[1] : rest[++i]; // setup-rewriter
    else if (x === "--timeout" || x.startsWith("--timeout=")) {
      const v = x.includes("=") ? x.split("=")[1] : rest[++i];
      a.timeout = Number(v);
      if (!Number.isFinite(a.timeout) || a.timeout <= 0) throw new Error("--timeout wants a number of seconds, e.g. --timeout 300");
    } else if (x === "--results" || x.startsWith("--results=")) {
      a.results = x.includes("=") ? x.split("=")[1] : rest[++i];
      if (!a.results) throw new Error("--results wants a JSON file path");
    } else if (x === "--lease" || x.startsWith("--lease=")) {
      a.lease = x.includes("=") ? x.slice(x.indexOf("=") + 1) : rest[++i];
      if (!parseTicket(a.lease)) throw new Error("--lease wants the value printed in the batch's commands (<batch id>:<token>)");
    } else if (x.startsWith("-")) throw new Error(`unknown option ${x}`);
    else if (!a.file) a.file = x;
    else throw new Error(`unexpected argument ${x}`);
  }
  if (["open", "poll", "status", "done", "shapes", "utf8-copy"].includes(cmd) && !a.file) throw new Error(`Usage: ${BIN} ${cmd} <file>`);
  if (cmd === "done" && !a.results) throw new Error(`Usage: ${BIN} done <file> --results <results.json>`);
  return a;
}

async function main() {
  // isatty, not process.stdin.isTTY: the stdin stream is never created, so an agent started on this terminal gets it untouched.
  // a person at a terminal gets plain words for `open` and `poll` (src/person.js); an agent or a script gets the output below, unchanged
  const aud = pickAudience(expandShortcut(process.argv.slice(2), FLAGS), { env: process.env, stdinTTY: tty.isatty(0), stdoutTTY: tty.isatty(1) });
  const argv = aud.argv;
  if (!argv.length || ["-h", "--help", "help"].includes(argv[0])) return out(HELP);
  if (asksForHelp(argv)) return out(commandHelp(argv[0])); // one path for every subcommand, before any of them parses its flags or runs
  if (["-v", "--version", "version"].includes(argv[0])) return out(`${JSON.parse(fs.readFileSync(path.join(here, "..", "package.json"), "utf8")).version}\n`);
  if (argv[0] === "setup") {
    const r = await runSetup(argv.slice(1));
    await out(r.lines.join("\n") + "\n");
    process.exit(r.exit);
  }
  if (argv[0] === "setup-checker") {
    const py = await setupChecker();
    return out(`checker ready: ${py}\n`);
  }
  if (argv[0] === "setup-rewriter") {
    const a = parseArgs(argv);
    if (a.file) throw new Error(`unexpected argument ${a.file}`);
    if (a.cleanOld) {
      const { cleanOldHelper } = await import("./rewriter-cleanup.js");
      const old = cleanOldHelper();
      // the install path: the old settings file is gone, so quick fixes that were on are off until the person turns them on again
      return out(old.line ? `${old.removed.includes("rewriter.json") ? `${old.freed} Quick fixes are off until you run: onionskin setup-rewriter` : old.line}\n` : "");
    }
    const { setupRewriter } = await import("./rewriter-setup.js");
    const r = await setupRewriter({ model: a.model, remove: !!a.remove });
    return out(r.removed ? "quick fixes are off\n" : `quick fixes are on (${r.name})\n`);
  }
  if (argv[0] === "config") return out(configCommand(argv.slice(1)));
  if (argv[0] === "doctor") {
    const a = parseArgs(argv);
    if (a.file) throw new Error(`unexpected argument ${a.file}`);
    const { runDoctor, formatDoctor } = await import("./doctor.js");
    const r = await runDoctor({ verbose: !!a.verbose });
    await out(a.json ? JSON.stringify(r, null, 2) + "\n" : formatDoctor(r));
    process.exit(r.ok ? 0 : 1);
  }
  if (argv[0] === "update") {
    const a = parseArgs(argv);
    if (a.file) throw new Error(`unexpected argument ${a.file}`);
    // everything update needs is loaded before the installer runs: install.sh deletes the app folder this process runs from
    const { updateCommand, runGetShDefault } = await import("./update.js");
    const appRoot = path.resolve(here, "..");
    const home = os.homedir();
    const versionOf = (cmd, args) => {
      const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "ignore"] });
      return r.status === 0 ? r.stdout.trim().split("\n")[0] || null : null;
    };
    const code = await updateCommand(argv.slice(1), {
      version: JSON.parse(fs.readFileSync(path.join(appRoot, "package.json"), "utf8")).version,
      appRoot,
      home,
      env: process.env,
      print: (line) => process.stdout.write(line + "\n"),
      server: { healthy, openWork: async () => { const r = await req({ method: "GET", path: "/cli/open-work", timeout: 3000 }); return { status: r.status, body: json(r.text) }; } },
      stop: stopServer,
      runGetSh: (base, opts) => runGetShDefault(base, process.env, opts),
      launcherVersion: (route, root) => (route === "npm" ? versionOf(process.execPath, [path.join(root, "src", "cli.js"), "--version"]) : versionOf(path.join(home, ".local", "bin", BIN), ["--version"])),
    });
    process.exit(code);
  }
  if (argv[0] === "reply") {
    // JSON on STDOUT only (also for failures), so an agent parses one stream; the exit code says whether the batch was finished
    let r;
    try {
      r = await replyCommand(argv.slice(1), { server: { healthy, req, json }, finish: finishBatch, pollNext: (file, timeout) => pollFor(file, { ack: true, timeout, compact: true }, { quiet: true }), readStdin, emitBody: (b) => out(JSON.stringify(b) + "\n") });
    } catch (err) {
      const body = err instanceof ReplyError ? err.body : { code: "reply_failed", error: String(err?.message || err).slice(0, 300) };
      await out(JSON.stringify(body) + "\n");
      process.exit(err instanceof ReplyError ? err.exit : 1);
    }
    await out((r.emitted ? "" : JSON.stringify(r.body) + "\n") + (r.next ? JSON.stringify(r.next) + "\n" : ""));
    process.exit(r.exit);
  }
  if (argv[0] === "apply" || argv[0] === "commit") {
    let r;
    try {
      r = await (argv[0] === "apply" ? applyCommand : commitCommand)(argv.slice(1), { healthy, req, json });
    } catch (err) {
      if (!(err instanceof ApplyError)) throw err;
      await out(JSON.stringify(err.report ? { ...err.report, error: err.message } : { schema: `onionskin.${argv[0]}-report/1`, status: "error", written: false, error: err.message }, null, 2) + "\n");
      process.stderr.write(err.message + "\n");
      process.exit(err.exit);
    }
    await out(JSON.stringify(argv[0] === "apply" && argv.includes("--summary") ? summarizeReport(r.report, r.exit) : r.report, null, argv.includes("--summary") ? 0 : 2) + "\n");
    process.exit(r.exit);
  }
  const a = parseArgs(argv);
  const file = a.file ? path.resolve(a.file) : "";
  if (a.cmd === "shapes") {
    const { readDoc } = await import("./fsutil.js");
    const { parseDeck, listShapes } = await import("./pptx.js");
    const real = fs.realpathSync(file);
    if (path.extname(real).toLowerCase() !== ".pptx") throw new Error("shapes reads a .pptx file");
    return out(JSON.stringify({ file: path.basename(real), slides: listShapes(parseDeck(readDoc(real)), a.slide ?? null) }, null, 2) + "\n");
  }
  if (a.cmd === "utf8-copy") {
    const { writeUtf8Copy } = await import("./html-utf8.js");
    const r = writeUtf8Copy(file);
    if (!r.ok) throw new Error(r.reason);
    return out(`Wrote a UTF-8 copy of ${a.file}:\n  ${r.path}\nThe file itself is not changed. Open the copy with:\n  ${BIN} open ${shellQuote(r.path)}\n`);
  }
  if (a.cmd === "poll" && aud.person) {
    await out(personPollText(file));
    process.exit(2);
  }
  if (a.cmd === "open") {
    // a bound agent gets no launch link for another file: refused before the server is asked, the same words as status and poll
    if (!agentMayUse(process.env[`${PRODUCT.envPrefix}_HOLDER`], file)) throw new Error(NOT_YOUR_FILE);
    await ensureServer();
    // a person at a terminal (not --no-agent): the server starts its background agent on the file
    // the holder goes along so the server checks the binding against the file it actually opens
    const holder = process.env[`${PRODUCT.envPrefix}_HOLDER`];
    const r = await openRequest({ file, ...(aud.offer ? { agent: "background" } : {}), ...(holder ? { holder } : {}) });
    const j = json(r.text);
    if (r.status !== 200 && j.code === "not_utf8" && j.copyable === true && /\.html?$/i.test(file)) {
      // a page saved as windows-1252 or ISO-8859-1: the fixed sentence (R18) and the command that makes the copy it offers. Whether a copy
      // can be made is the open worker's answer for the bytes it read (the server's refusal carries it); the file is not read again here
      const { openRefusal } = await import("./html-utf8.js");
      throw new Error(openRefusal(BIN, file, shellQuote));
    }
    if (r.status !== 200) throw new Error(j.error || "could not open that file");
    const realPath = fs.realpathSync(file);
    if (!a.noOpen) openBrowser(j.url);
    if (aud.person) return out(personOpenText({ name: path.basename(realPath), url: j.url, realPath, browser: !a.noOpen, found: !!findClaude(process.env), codex: !!findCodex(process.env), offer: aud.offer }));
    const typed = a.file;
    await out(`Opened ${typed}${realPath !== path.resolve(typed) ? ` (real path ${realPath})` : ""}\n${j.url}\n\nTo receive the user's batch, run:\n  ${BIN} poll ${shellQuote(realPath)}\nAny path form of this file (as typed or the real path) works in later commands.\nIt can run in the background (Claude Code) or in the foreground with --timeout <secs> (see the skill).\n`);
  } else if (a.cmd === "poll") {
    return out(JSON.stringify(await pollFor(file, a), null, 2) + "\n");
  } else if (a.cmd === "status") {
    const envHolder = process.env[`${PRODUCT.envPrefix}_HOLDER`];
    if (!agentMayUse(envHolder, file)) throw new Error(NOT_YOUR_FILE); // the same words whether that file is open or not
    if (!(await healthy())) return out(JSON.stringify({ state: "no-server" }, null, 2) + "\n");
    const r = await req({ method: "GET", path: `/cli/status?file=${encodeURIComponent(file)}${envHolder ? `&holder=${encodeURIComponent(envHolder)}` : ""}` });
    if (r.status !== 200) throw new Error(json(r.text).error || "no such session");
    const st = json(r.text);
    if (a.ticket) {
      // only the agent whose holder id matches the delivery's gets the ticket back (a second agent on the same file does not)
      const realFile = fs.realpathSync(file);
      const rec = st.delivered_batch ? loadTicketRecord(st.delivered_batch) : null;
      const holder = process.env[`${PRODUCT.envPrefix}_HOLDER`] || loadHolder(realFile);
      if (!rec) throw new Error("no batch is delivered for this file, so there is no ticket. Run poll.");
      if (!holder || rec.holder !== holder) throw new Error("the delivered batch belongs to another poller; only that agent can read its ticket. Run poll to take your own delivery.");
      st.ticket = `${rec.batch_id}:${rec.token}`;
    }
    return out(JSON.stringify(st, null, 2) + "\n");
  } else if (a.cmd === "done") {
    let results;
    try {
      results = JSON.parse(fs.readFileSync(a.results, "utf8"));
    } catch (err) {
      throw new Error(`cannot read ${a.results}: ${err.message}`);
    }
    const j = await finishBatch(file, results, a.lease);
    if (a.summary) return out(JSON.stringify({ ok: !!j.ok, flags: (j.flags || []).map((f) => ({ code: f.code, severity: f.severity })), ...(j.checks?.notice ? { checks_notice: j.checks.notice } : {}) }) + "\n");
    return out(JSON.stringify(j, null, 2) + "\n");
  } else if (a.cmd === "stop") {
    const res = await stopServer();
    return out(res?.staleRemoved ? "no running server (stale record removed)\n" : res?.stopped ? "stopped\n" : "no server was running\n");
  } else throw new Error(`unknown command ${a.cmd}\n${HELP}`);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // ONIONSKIN_TRACE=<file>: one JSON line per command (name, start, end, exit code) for the loop benchmarks. Off unless set.
  if (process.env.ONIONSKIN_TRACE) {
    const start = Date.now();
    process.on("exit", (code) => {
      try {
        fs.appendFileSync(process.env.ONIONSKIN_TRACE, JSON.stringify({ cmd: process.argv[2], flags: process.argv.slice(3).filter((x) => x.startsWith("--")), start, end: Date.now(), code }) + "\n");
      } catch {}
    });
  }
  main().then(
    () => process.exit(0),
    (err) => {
      console.error(err.message || String(err));
      process.exit(1);
    }
  );
}
