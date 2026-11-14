// `onionskin setup-rewriter [--remove]`: turns on quick fixes on this Mac (milestone 2, idea 10), with Apple's built-in
// model. Nothing is downloaded and nothing is compiled: the helper ships ready-made in this app copy (scripts/rewriter/apple/onionskin-fm, built
// by scripts/build-apple-helper.mjs) and runs from there. Setup checks it the way the server does before every start (src/rewriter.js
// appleHelperState: macOS 26 or later, Apple silicon, the shipped hash, no quarantine mark; it clears a mark install.sh could not), asks it
// whether Apple's model is available, and sends it one test sentence. rewriter.json is written LAST, so a half setup reads as off.
// Every run first removes what the older Granite download left in the state folder (src/rewriter-cleanup.js).
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureStateDir, writeStateFile } from "./paths.js";
import { PROBE_REASONS, appleHelperState, appleStateLine, clearQuarantine, createWorker, readRewriterConfig, rewriterPaths, sandboxed, workerEnv } from "./rewriter.js";
import { cleanOldHelper } from "./rewriter-cleanup.js";

const PROBE_MS = 120_000;
const AVAILABILITY_MS = 30_000;
export const SETUP_MODELS = ["apple"];
export const DEFAULT_SETUP_MODEL = "apple";

const fail = (reason, message) => Object.assign(new Error(message), { reason });

/** A real sentence through the worker that was just set up. Resolves {ok:true,text} or {ok:false,code}. Replaceable in tests. */
export async function probeLaunch(launch, { text = "This are a test of the writing helper.", limitMs = PROBE_MS } = {}) {
  const worker = createWorker(launch, { startMs: limitMs });
  try {
    const until = Date.now() + limitMs;
    for (;;) {
      const r = await worker.rewrite("grammar", text, { timeoutMs: 20_000 });
      if (r.code !== "warming_up") return r;
      if (Date.now() > until) return { ok: false, code: "timeout" };
      await new Promise((res) => setTimeout(res, 250));
    }
  } finally {
    worker.close();
  }
}

async function removeAll() {
  const p = rewriterPaths();
  fs.rmSync(p.config, { force: true }); // first: from here on the rewriter reads as off
  fs.rmSync(p.appleBin, { force: true }); // what an older version built here
}

/** `onionskin-fm --probe`, in the sandbox the worker gets: {status, stdout}. Replaceable in tests. */
export function probeHelper(bin) {
  const [cmd, args] = sandboxed(bin, ["--probe"]);
  return new Promise((resolve) => {
    const state = path.dirname(rewriterPaths().config);
    const cwd = fs.existsSync(state) ? state : os.tmpdir(); // the doctor may ask before the state folder exists
    execFile(cmd, args, { encoding: "utf8", timeout: AVAILABILITY_MS, env: workerEnv(), cwd }, (err, stdout) => resolve({ status: err ? (typeof err.code === "number" ? err.code : null) : 0, stdout: String(stdout || "") }));
  });
}

async function setupApple(log, probe, deps) {
  log("Setting up quick fixes with Apple's built-in model. Nothing is downloaded.");
  let h = appleHelperState(deps.apple);
  // install.sh clears the download mark; a copy it did not (unzipped and run in place, or copied by hand) is cleared here, on this one file
  if (h.reason === "quarantined") {
    if ((deps.clearQuarantine ?? clearQuarantine)(h.bin)) h = appleHelperState(deps.apple); // the very file that was checked
  }
  if (!h.ok) throw fail(h.reason === "helper_changed" ? "helper_missing" : h.reason, appleStateLine(h.reason));
  const pr = await (deps.probeHelper ?? probeHelper)(h.bin);
  if (pr.status !== 0) {
    const reason = PROBE_REASONS[/^unavailable: (\w+)/.exec(String(pr.stdout || "").trim())?.[1]] ?? "model_unavailable";
    throw fail(reason, appleStateLine(reason) ?? "Apple's built-in model is not available on this Mac.");
  }
  const config = { backend: "apple", model: "apple", sha256: h.sha256 };
  await finish(config, log, probe, { cmd: h.bin, args: [] });
  return "Apple's built-in model";
}

/** The real test sentence, then rewriter.json (0600, atomic). A failed test leaves the setup off. */
async function finish(config, log, probe, launch) {
  fs.rmSync(rewriterPaths().config, { force: true }); // a setup that fails below must not leave the old one standing
  log("Trying it once on a test sentence...");
  const r = await probe(launch);
  if (!r?.ok) throw fail("probe_failed", `the writing helper did not answer a test sentence (${r?.code || "no answer"})`);
  writeStateFile(rewriterPaths().config, JSON.stringify(config, null, 2) + "\n");
}

/**
 * Returns {name, removed?}. Throws an Error with `reason` (a key of APPLE_STATES in src/rewriter.js, model_unavailable, probe_failed, bad_model)
 * and a plain message on failure; nothing is configured then. deps (tests): probe(launch) -> {ok}; probeHelper(bin) -> {status, stdout};
 * apple (goes to appleHelperState: dir, host, quarantined); clearQuarantine(file) -> boolean.
 */
export async function setupRewriter({ model = DEFAULT_SETUP_MODEL, remove = false } = {}, log = (s) => process.stderr.write(s + "\n"), deps = {}) {
  const probe = deps.probe ?? probeLaunch;
  ensureStateDir();
  const old = cleanOldHelper(); // the older Granite download, once; the one plain line says what was freed
  if (old.line) log(old.line);
  if (remove) {
    await removeAll();
    return { removed: true };
  }
  if (!SETUP_MODELS.includes(model)) throw fail("bad_model", `There is no "${model}" writing helper any more. Quick fixes use Apple's built-in model, so run setup-rewriter without --model.`);
  const have = readRewriterConfig(undefined, deps.apple);
  if (have.ok && have.model === model) {
    log("Quick fixes are already set up.");
    return { name: have.name };
  }
  fs.mkdirSync(path.dirname(rewriterPaths().config), { recursive: true, mode: 0o700 });
  const name = await setupApple(log, probe, deps);
  return { name };
}
