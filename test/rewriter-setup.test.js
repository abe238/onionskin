import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { tmpdir } from "./helpers/zipbuild.js";
import { fileSha256, readRewriterConfig, rewriterPaths, rewriterStatus, stopRewriter } from "../src/rewriter.js";
import { DEFAULT_SETUP_MODEL, probeHelper, probeLaunch, setupRewriter } from "../src/rewriter-setup.js";

// `onionskin setup-rewriter` (src/rewriter-setup.js) with the helper, its probe and the test sentence faked: nothing is downloaded, installed,
// compiled or run, and only temp folders are written. What is checked is the order of the steps, what is verified, what a failure leaves
// behind and what the file says.
const root = tmpdir("rws-");
after(() => {
  stopRewriter();
  fs.rmSync(root, { recursive: true, force: true });
});
const here = path.dirname(fileURLToPath(import.meta.url));
let n = 0;
const freshState = () => {
  const d = path.join(root, `state${n++}`);
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  process.env.ONIONSKIN_STATE_DIR = d;
  delete process.env.ONIONSKIN_REWRITER_STUB;
  return d;
};
const probeOk = async () => ({ ok: true, text: "This is a test of the writing helper." });
/** A stand-in for the shipped helper and its onionskin-fm.json (never run: a script that leaves a file if it were). */
function shipped() {
  const dir = path.join(root, `helper${n++}`);
  fs.mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, "onionskin-fm");
  const ran = path.join(dir, "RAN");
  fs.writeFileSync(bin, `#!/bin/sh\necho ran > "${ran}"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "onionskin-fm.json"), JSON.stringify({ file: "onionskin-fm", sha256: fileSha256(bin) }));
  return { dir, bin, ran };
}
const NEW_MAC = { macos: "26.1", appleSilicon: true };
/** deps for setupRewriter, recording every step. */
function steps({ dir, probe = { status: 0, stdout: "available\n" }, sentence = probeOk, host = NEW_MAC, marked = () => false, clear = () => false } = {}) {
  const calls = [];
  return {
    calls,
    deps: {
      apple: { dir, host, quarantined: (f) => (calls.push(["quarantined?", f]), marked(f)) },
      clearQuarantine: (f) => (calls.push(["clear", f]), clear(f)),
      probeHelper: async (bin) => (calls.push(["--probe", bin]), probe),
      probe: async (launch) => (calls.push(["sentence", launch.cmd]), sentence(launch)),
      run: () => assert.fail("no command is run by setup any more (no compiler, no download)"),
    },
  };
}

test("apple is the default and the only choice: Granite and anything else are refused before anything runs", async () => {
  freshState();
  assert.equal(DEFAULT_SETUP_MODEL, "apple");
  const { dir } = shipped();
  for (const model of ["granite", "lfm", "../x"]) {
    const { deps, calls } = steps({ dir });
    await assert.rejects(setupRewriter({ model }, () => {}, deps), (e) => e.reason === "bad_model" && /Apple's built-in model/.test(e.message) && !/\u2014/.test(e.message));
    assert.deepEqual(calls, []);
  }
  const { deps } = steps({ dir });
  assert.equal((await setupRewriter({}, () => {}, deps)).name, "Apple's built-in model", "no --model means apple");
});

test("apple: the shipped helper is checked, asked whether the model is available, sent a test sentence, and only then rewriter.json is written", async () => {
  const state = freshState();
  const { dir, bin, ran } = shipped();
  const { deps, calls } = steps({ dir });
  const logs = [];
  const r = await setupRewriter({ model: "apple" }, (s) => logs.push(s), deps);
  assert.equal(r.name, "Apple's built-in model");
  assert.deepEqual(calls, [["quarantined?", bin], ["--probe", bin], ["sentence", bin]], "run in place from the app folder, in this order");
  assert.deepEqual(JSON.parse(fs.readFileSync(rewriterPaths().config, "utf8")), { backend: "apple", model: "apple", sha256: fileSha256(bin) });
  assert.equal(readRewriterConfig(undefined, deps.apple).ok, true);
  assert.equal(fs.existsSync(rewriterPaths().appleBin), false, "nothing is copied into the state folder");
  assert.match(logs[0], /Nothing is downloaded/);
  assert.equal(fs.existsSync(ran), false);
  // already in place and intact: not redone
  const again = steps({ dir });
  const logs2 = [];
  await setupRewriter({}, (s) => logs2.push(s), again.deps);
  assert.match(logs2[0], /already set up/);
  assert.ok(!again.calls.some((c) => c[0] === "--probe"));
  assert.ok(state);
});

test("apple: each reason the model is not available fails the setup with its plain line and leaves no config", async () => {
  freshState();
  const { dir } = shipped();
  const cases = [
    ["deviceNotEligible", "device_not_eligible", "This Mac cannot run Apple's on-device writing model."],
    ["appleIntelligenceNotEnabled", "apple_intelligence_not_enabled", "Turn on Apple Intelligence in System Settings to get quick spelling and grammar fixes."],
    ["modelNotReady", "model_not_ready", "Apple's writing model is still getting ready. Try again in a few minutes."],
    ["somethingNew", "model_unavailable", "Apple's built-in model is not available on this Mac."],
  ];
  for (const [said, reason, message] of cases) {
    const { deps, calls } = steps({ dir, probe: { status: 1, stdout: `unavailable: ${said}\n` } });
    await assert.rejects(setupRewriter({}, () => {}, deps), (e) => e.reason === reason && e.message === message, said);
    assert.ok(!calls.some((c) => c[0] === "sentence"), "no test sentence after a no");
    assert.equal(fs.existsSync(rewriterPaths().config), false);
  }
  // the test sentence itself fails
  const { deps } = steps({ dir, sentence: async () => ({ ok: false, code: "refused" }) });
  await assert.rejects(setupRewriter({}, () => {}, deps), (e) => e.reason === "probe_failed" && /refused/.test(e.message));
  assert.equal(fs.existsSync(rewriterPaths().config), false);
});

test("apple: macOS older than 26, an Intel Mac, and a missing or changed helper are refused before anything is started", async () => {
  freshState();
  const { dir, bin } = shipped();
  const check = async (o, reason, message) => {
    const { deps, calls } = steps({ dir, ...o });
    await assert.rejects(setupRewriter({}, () => {}, deps), (e) => e.reason === reason && (!message || e.message === message), reason);
    assert.ok(!calls.some((c) => c[0] === "--probe" || c[0] === "sentence"), `${reason}: nothing started`);
  };
  await check({ host: { macos: "15.6", appleSilicon: true } }, "macos_too_old", "Quick fixes need macOS 26 or later.");
  await check({ host: { macos: "26.0", appleSilicon: false } }, "device_not_eligible");
  await check({ dir: path.join(root, "nowhere") }, "helper_missing", "The small helper for quick fixes is missing or damaged in this copy of Onionskin. Install Onionskin again to fix it.");
  fs.appendFileSync(bin, "# changed\n");
  await check({}, "helper_missing");
  assert.equal(fs.existsSync(rewriterPaths().config), false);
});

test("apple: a helper that still carries the download mark is cleared once and then used; one that cannot be cleared is never started", async () => {
  freshState();
  const { dir, bin, ran } = shipped();
  let mark = true;
  const ok = steps({ dir, marked: () => mark, clear: () => ((mark = false), true) });
  await setupRewriter({}, () => {}, ok.deps);
  assert.deepEqual(ok.calls.map((c) => c[0]), ["quarantined?", "clear", "quarantined?", "--probe", "sentence"]);
  assert.deepEqual(ok.calls.find((c) => c[0] === "clear"), ["clear", bin], "exactly that one file");
  freshState();
  const stuck = steps({ dir, marked: () => true, clear: () => false });
  await assert.rejects(setupRewriter({}, () => {}, stuck.deps), (e) => e.reason === "quarantined" && /^macOS is holding back the small helper/.test(e.message));
  assert.ok(!stuck.calls.some((c) => c[0] === "--probe" || c[0] === "sentence"), "never started");
  assert.equal(fs.existsSync(rewriterPaths().config), false);
  assert.equal(fs.existsSync(ran), false);
});

test("--remove: the config and an older version's built helper go; an older Granite download is cleaned as always; the rest of the state folder stays", async () => {
  const state = freshState();
  for (const d of ["models/granite", "rewriter-venv", "bin", "venv", "models/other"]) fs.mkdirSync(path.join(state, d), { recursive: true });
  fs.writeFileSync(path.join(state, "models", "granite", "config.json"), "{}");
  fs.writeFileSync(path.join(state, "rewriter-venv", "pyvenv.cfg"), "home = x\n");
  fs.writeFileSync(path.join(state, "rewriter.json"), JSON.stringify({ backend: "apple", model: "apple" }));
  fs.writeFileSync(path.join(state, "bin", "onionskin-fm"), "x");
  fs.writeFileSync(path.join(state, "stamps.json"), "{}");
  const logs = [];
  const r = await setupRewriter({ remove: true }, (l) => logs.push(l), {});
  assert.equal(r.removed, true);
  for (const f of ["rewriter.json", "models/granite", "rewriter-venv", "bin/onionskin-fm"]) assert.equal(fs.existsSync(path.join(state, f)), false, f);
  assert.match(logs.join("\n"), /^Removed the old writing helper/);
  assert.ok(fs.existsSync(path.join(state, "stamps.json")), "someone else's files are not touched");
  assert.ok(fs.existsSync(path.join(state, "models", "other")), "a folder this version never made is not touched");
  assert.ok(fs.existsSync(path.join(state, "venv")), "the deeper-check environment is not touched");
  assert.deepEqual(rewriterStatus(), { on: false, reason: "not_set_up" });
  await setupRewriter({ remove: true }, () => {}, {}); // and again: nothing to remove is not an error
});

test("probeLaunch: a real round trip through a worker process; a worker that cannot start gives an answer, not a hang", async () => {
  const fake = path.join(here, "helpers", "fake-rewriter-worker.mjs");
  const ok = await probeLaunch({ cmd: process.execPath, args: [fake, "startup", "200"], env: { PATH: "/usr/bin:/bin" }, cwd: root }, { limitMs: 5000 });
  assert.deepEqual(ok, { ok: true, text: "THIS ARE A TEST OF THE WRITING HELPER." });
  const bad = await probeLaunch({ cmd: process.execPath, args: [fake, "notready"], env: { PATH: "/usr/bin:/bin" }, cwd: root }, { limitMs: 1500 });
  assert.equal(bad.ok, false);
});

test("probeHelper: runs <helper> --probe in the sandbox and returns its words, also before the state folder exists", async () => {
  process.env.ONIONSKIN_STATE_DIR = path.join(root, "not-made-yet");
  const fake = path.join(root, "probe-stand-in.sh"); // a stand-in written here, never a downloaded file
  fs.writeFileSync(fake, '#!/bin/sh\n[ "$1" = --probe ] && echo "unavailable: modelNotReady" && exit 1\nexit 5\n', { mode: 0o755 });
  assert.deepEqual(await probeHelper(fake), { status: 1, stdout: "unavailable: modelNotReady\n" });
  assert.equal(fs.existsSync(process.env.ONIONSKIN_STATE_DIR), false);
});

test("the command line: setup-rewriter takes --model, --remove and --clean-old and nothing else", async () => {
  const { parseArgs } = await import("../src/cli.js");
  assert.equal(parseArgs(["setup-rewriter", "--model", "apple"]).model, "apple");
  assert.equal(parseArgs(["setup-rewriter", "--model=apple"]).model, "apple");
  assert.equal(parseArgs(["setup-rewriter", "--remove"]).remove, true);
  assert.equal(parseArgs(["setup-rewriter", "--clean-old"]).cleanOld, true);
  assert.throws(() => parseArgs(["setup-rewriter", "--model", "apple", "--force"]), /unknown option/);
  assert.throws(() => parseArgs(["poll", "f.docx", "--model", "apple"]), /unknown option/, "the flag belongs to this command only");
});

test("nothing a person reads promises a download for quick fixes any more, and the feature is called quick fixes", async () => {
  const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
  const help = spawnSync(process.execPath, [path.join(here, "..", "src", "cli.js"), "--help"], { encoding: "utf8", env: { ...process.env, ONIONSKIN_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "help-")) } });
  const helpText = `${help.stdout}${help.stderr}`;
  assert.match(helpText, /setup-rewriter \[--remove\]/);
  for (const [f, text] of [["INSTALL.md", read("INSTALL.md")], ["install.sh", read("install.sh")], ["the command-line help", helpText], ["README.md", read("README.md")], ["NOTICE", read("NOTICE")], ["web/src/suggest.js", read("web/src/suggest.js")]]) {
    assert.ok(!/1\.3 GB|granite|\bMLX\b|Hugging ?Face/i.test(text), `${f} still offers or names Granite or its download`);
  }
  for (const f of ["INSTALL.md", "install.sh", "README.md", "NOTICE", "src/cli.js", "src/doctor.js", "src/rewriter-setup.js", "web/src/suggest.js"]) {
    assert.ok(!/900 MB|about 1 GB/.test(read(f)), `${f} still has an old size`);
    assert.ok(!/quick rewrites/i.test(read(f)), `${f} still says quick rewrites`);
  }
});
