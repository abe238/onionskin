import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { tmpdir } from "./helpers/zipbuild.js";
import { cleanOldHelper, sizeWords } from "../src/rewriter-cleanup.js";
import { setupRewriter } from "../src/rewriter-setup.js";

// The one-time cleanup of the older Granite download (src/rewriter-cleanup.js), on temp state folders built to look like an old install.
// Nothing here touches a real state folder: every path is under one temp root, and the "outside" folders are in it too.
const root = fs.realpathSync(tmpdir("rwc-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = () => {
  const d = path.join(root, `state${n++}`);
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
};
const put = (f, bytes = 0) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, "x".repeat(bytes));
};
/** What the old version left: the model, its venv, a half download and the settings file that names Granite. */
function oldInstall(state, { mb = 3 } = {}) {
  put(path.join(state, "models", "granite", "config.json"), 10);
  put(path.join(state, "models", "granite", "model.safetensors"), mb * 1_000_000);
  put(path.join(state, "models", ".granite.partial", "part"), 5);
  put(path.join(state, "rewriter-venv", "pyvenv.cfg"), 20);
  put(path.join(state, "rewriter-venv", "bin", "python"), 7);
  fs.writeFileSync(path.join(state, "rewriter.json"), JSON.stringify({ backend: "mlx", model: "granite", dir: path.join(state, "models", "granite"), sha256: "0" }));
  put(path.join(state, "stamps.json"), 2); // not ours
  put(path.join(state, "venv", "bin", "python"), 3); // the deeper checks' environment: not ours
}

test("an old install: the model, the venv, the half download and the settings file go; the line says what was freed; nothing else is touched", () => {
  const state = fresh();
  oldInstall(state, { mb: 1300 / 100 }); // 13 MB stands in for 1.3 GB
  const r = cleanOldHelper(state);
  assert.deepEqual(r.removed.sort(), ["models/.granite.partial", "models/granite", "rewriter-venv", "rewriter.json"]);
  for (const f of ["models", "rewriter-venv", "rewriter.json"]) assert.equal(fs.existsSync(path.join(state, f)), false, f);
  assert.ok(fs.existsSync(path.join(state, "stamps.json")) && fs.existsSync(path.join(state, "venv", "bin", "python")));
  assert.equal(r.line, "Removed the old writing helper download (13 MB). Quick fixes now use Apple's model already on this Mac.");
  assert.deepEqual(cleanOldHelper(state), { bytes: 0, removed: [] }, "a second run finds nothing and says nothing");
});

test("sizeWords", () => {
  assert.equal(sizeWords(1_284_000_000), "1.3 GB");
  assert.equal(sizeWords(42_400_000), "42 MB");
  assert.equal(sizeWords(500), "under 1 MB");
});

test("Apple's own settings file and a state folder with nothing old are left alone", () => {
  const state = fresh();
  fs.writeFileSync(path.join(state, "rewriter.json"), JSON.stringify({ backend: "apple", model: "apple", sha256: "ab" }));
  assert.deepEqual(cleanOldHelper(state), { bytes: 0, removed: [] });
  assert.ok(fs.existsSync(path.join(state, "rewriter.json")));
  assert.deepEqual(cleanOldHelper(path.join(root, "no-such-folder")), { bytes: 0, removed: [] });
});

test("only what the old version made: a models/granite without its config.json, a folder named rewriter-venv that is not a venv, and other model folders stay", () => {
  const state = fresh();
  put(path.join(state, "models", "granite", "notes.txt"), 4);
  put(path.join(state, "models", "mine", "keep.txt"), 4);
  put(path.join(state, "rewriter-venv", "important.txt"), 4);
  assert.deepEqual(cleanOldHelper(state), { bytes: 0, removed: [] });
  for (const f of ["models/granite/notes.txt", "models/mine/keep.txt", "rewriter-venv/important.txt"]) assert.ok(fs.existsSync(path.join(state, f)), f);
  // with the models folder holding something else, the folder itself stays after the known part is removed
  put(path.join(state, "models", "granite", "config.json"), 4);
  assert.deepEqual(cleanOldHelper(state).removed, ["models/granite"]);
  assert.ok(fs.existsSync(path.join(state, "models", "mine", "keep.txt")));
});

test("hostile layout: a link out of the state folder is never followed and nothing outside is deleted", () => {
  const state = fresh();
  const outside = path.join(root, `outside${n++}`);
  put(path.join(outside, "granite", "config.json"), 10);
  put(path.join(outside, "precious.txt"), 10);
  put(path.join(outside, "venv", "pyvenv.cfg"), 10);
  oldInstall(state);
  // 1. the whole models folder and the venv are links to a folder outside
  fs.rmSync(path.join(state, "models"), { recursive: true });
  fs.rmSync(path.join(state, "rewriter-venv"), { recursive: true });
  fs.symlinkSync(outside, path.join(state, "models"));
  fs.symlinkSync(path.join(outside, "venv"), path.join(state, "rewriter-venv"));
  let r = cleanOldHelper(state);
  assert.deepEqual(r.removed, ["rewriter.json"], "only the settings file, which is a plain file in the state folder");
  assert.ok(fs.lstatSync(path.join(state, "models")).isSymbolicLink() && fs.lstatSync(path.join(state, "rewriter-venv")).isSymbolicLink(), "the links themselves are left as they are");
  for (const f of ["granite/config.json", "precious.txt", "venv/pyvenv.cfg"]) assert.ok(fs.existsSync(path.join(outside, f)), `outside ${f}`);
  // 2. models is a real folder, but models/granite is a link out
  fs.rmSync(path.join(state, "models"));
  fs.mkdirSync(path.join(state, "models"));
  fs.symlinkSync(path.join(outside, "granite"), path.join(state, "models", "granite"));
  r = cleanOldHelper(state);
  assert.deepEqual(r.removed, []);
  assert.ok(fs.existsSync(path.join(outside, "granite", "config.json")));
  // 3. a link INSIDE a real old model folder points out: the link is unlinked, what it points at stays
  fs.rmSync(path.join(state, "models", "granite"));
  put(path.join(state, "models", "granite", "config.json"), 4);
  fs.symlinkSync(outside, path.join(state, "models", "granite", "escape"));
  r = cleanOldHelper(state);
  assert.deepEqual(r.removed, ["models/granite"]);
  assert.ok(fs.existsSync(path.join(outside, "precious.txt")), "not followed through an inner link");
  // 4. the settings file is a link to a file elsewhere: never read through, never deleted through
  const elsewhere = path.join(root, `elsewhere${n++}.json`);
  fs.writeFileSync(elsewhere, JSON.stringify({ backend: "mlx", model: "granite" }));
  fs.symlinkSync(elsewhere, path.join(state, "rewriter.json"));
  assert.deepEqual(cleanOldHelper(state).removed, []);
  assert.ok(fs.existsSync(elsewhere));
});

test("a state folder that is itself a link is not cleaned", () => {
  const real = fresh();
  oldInstall(real);
  const link = path.join(root, `link${n++}`);
  fs.symlinkSync(real, link);
  assert.deepEqual(cleanOldHelper(link), { bytes: 0, removed: [] });
  assert.ok(fs.existsSync(path.join(real, "models", "granite", "config.json")));
});

test("setup-rewriter runs it first and logs the one line, also when the setup then says the helper is not ready", async () => {
  const state = fresh();
  oldInstall(state);
  process.env.ONIONSKIN_STATE_DIR = state;
  const logs = [];
  await assert.rejects(setupRewriter({}, (l) => logs.push(l), { apple: { dir: path.join(root, "no-helper"), host: { macos: "26.1", appleSilicon: true }, quarantined: () => false } }), (e) => e.reason === "helper_missing");
  assert.equal(logs[0], "Removed the old writing helper download (3 MB). Quick fixes now use Apple's model already on this Mac.");
  assert.equal(fs.existsSync(path.join(state, "models")), false);
  assert.equal(fs.existsSync(path.join(state, "rewriter.json")), false);
});
