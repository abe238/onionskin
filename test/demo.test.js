import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { tmpdir } from "./helpers/zipbuild.js";

// The Try-it page's build guard (scripts/demo/build.mjs), its local server (serve.mjs) and the page's pure helpers (web/demo/replay.js).
// The recording is a TEST one (the stand-in agent, real: false) made in a temp folder by scripts/demo/test-recording.mjs. No page is
// built here (e2e/demo/demo.e2e.test.js does that): every refusal below happens before Vite starts, and nothing is written.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = tmpdir();
after(() => fs.rmSync(root, { recursive: true, force: true }));
const { havePython, skipUnless, VENV_HINT } = await import("../scripts/fixtures.mjs");
const opts = { skip: skipUnless(havePython(), "needs .venv with python-docx", VENV_HINT) };
const { BuildError, buildDemo, checkBuilt, loadRecording } = await import("../scripts/demo/build.mjs");
const { serve } = await import("../scripts/demo/serve.mjs");
const { dateText, findQuote, placeRanges, versionsMatch, workingPlan, workingText } = await import("../web/demo/replay.js");
const BUILD = path.join(repo, "scripts", "demo", "build.mjs");
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");

let rec = null;
if (havePython()) {
  rec = path.join(root, "rec");
  const r = spawnSync(process.execPath, [path.join(repo, "scripts", "demo", "test-recording.mjs"), rec], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
}
let nth = 0;
/** A copy of the test recording, changed by `mutate(dir)`. */
const variant = (mutate) => {
  const dir = path.join(root, `rec-${++nth}`);
  fs.cpSync(rec, dir, { recursive: true });
  mutate(dir);
  return dir;
};
const editJson = (dir, f) => {
  const p = path.join(dir, "recording.json");
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  f(j);
  fs.writeFileSync(p, JSON.stringify(j, null, 2));
};
const refused = async (args, re) => {
  const out = path.join(root, `out-${++nth}`);
  await assert.rejects(buildDemo({ out, ...args }), (e) => e instanceof BuildError && re.test(e.message));
  assert.equal(fs.existsSync(out), false, "nothing is built when a check fails");
};

// ---- the build guard -------------------------------------------------------------------------------------------------------------
test("a test recording (real: false) is refused without --test, by the command too, and nothing is built", opts, async () => {
  await refused({ recordingDir: rec }, /stand-in agent \(real: false\)/);
  const out = path.join(root, "cli-out");
  const r = spawnSync(process.execPath, [BUILD, "--recording", rec, "--out", out], { encoding: "utf8" });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /The page was not built/);
  assert.equal(fs.existsSync(out), false);
  // with --test it passes the guard (the browser test builds it)
  assert.equal(loadRecording(rec, { test: true }).recording.real, false);
});

test("a --test build may never go to dist-demo, and the default recording folder must hold a recording", opts, async () => {
  await assert.rejects(buildDemo({ recordingDir: rec, test: true }), /--test builds may not go to dist-demo/);
  const r = spawnSync(process.execPath, [BUILD, "--recording", path.join(root, "nothing-here"), "--out", path.join(root, "never")], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /recording\.json is missing/);
  assert.equal(fs.existsSync(path.join(root, "never")), false);
});

test("a recording that fails the scan is refused even with --test: markup in the agent's words, a changed version, an extra file", opts, async () => {
  await refused({ recordingDir: variant((d) => editJson(d, (j) => (j.result.summary = "<img src=x onerror=alert(1)>"))), test: true }, /result summary/);
  await refused({ recordingDir: variant((d) => editJson(d, (j) => (j.places[0].diff[1][1] = "javascript:alert(1)"))), test: true }, /place 1/);
  await refused({ recordingDir: variant((d) => fs.appendFileSync(path.join(d, "v1.docx"), Buffer.from("x"))), test: true }, /v1_sha256 does not match/);
  await refused({ recordingDir: variant((d) => fs.writeFileSync(path.join(d, "notes.txt"), "hello")), test: true }, /files that are not part of a recording/);
  // a recording that claims to be real but holds a stand-in's hash is still refused by the scan's checks on the versions
  await refused({ recordingDir: variant((d) => editJson(d, (j) => (j.v0_sha256 = sha256(Buffer.from("other"))))) }, /v0_sha256 does not match/);
});

test("an output folder that holds other files is refused and left as it was", opts, async () => {
  const out = path.join(root, "busy");
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, "keep.txt"), "mine");
  await assert.rejects(buildDemo({ recordingDir: rec, out, test: true }), /holds other files/);
  assert.deepEqual(fs.readdirSync(out), ["keep.txt"]);
});

test("Vite run directly on the demo config refuses: the scan cannot be skipped", () => {
  const vite = path.join(repo, "node_modules", "vite", "bin", "vite.js");
  const out = path.join(root, "direct");
  const r = spawnSync(process.execPath, [vite, "build", "--config", path.join(repo, "web", "vite.demo.config.js"), "--outDir", out], { encoding: "utf8", cwd: root });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /node scripts\/demo\/build\.mjs/);
  assert.equal(fs.existsSync(out), false);
});

test("the built page is checked: CSP meta first, no inline script, no Office file or source map", () => {
  const csp = "default-src 'none'; object-src 'none'";
  const page = (head, body = "") => {
    const dir = path.join(root, `built-${++nth}`);
    fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
    fs.writeFileSync(path.join(dir, "index.html"), `<!doctype html><html><head>${head}</head><body>${body}</body></html>`);
    return dir;
  };
  const meta = `<meta http-equiv="Content-Security-Policy" content="${csp}" />`;
  const ok = page(`<meta charset="utf-8" />${meta}<script type="module" src="./assets/a.js"></script>`);
  assert.deepEqual(checkBuilt(ok, csp), []);
  assert.deepEqual(checkBuilt(page(`<meta charset="utf-8" />`), csp), ["the page has no CSP meta tag"]);
  assert.deepEqual(checkBuilt(page(`<script src="./x.js"></script>${meta}`), csp), ["something loads before the CSP meta tag"]);
  assert.deepEqual(checkBuilt(page(meta, "<script>alert(1)</script>"), csp), ["the page has an inline script"]);
  const withDoc = page(meta);
  fs.writeFileSync(path.join(withDoc, "assets", "v0.docx"), "x");
  fs.writeFileSync(path.join(withDoc, "assets", "a.js.map"), "x");
  assert.equal(checkBuilt(withDoc, csp).length, 2);
});

// ---- the local server ------------------------------------------------------------------------------------------------------------
test("serve.mjs serves the folder on 127.0.0.1 only: GET and HEAD, no dotfiles, no way out of the folder, the query ignored", async () => {
  const site = path.join(root, "site");
  fs.mkdirSync(path.join(site, "assets"), { recursive: true });
  fs.writeFileSync(path.join(site, "index.html"), "<!doctype html><title>t</title>");
  fs.writeFileSync(path.join(site, "assets", "a.js"), "export {};");
  fs.writeFileSync(path.join(site, ".onionskin-demo-build"), "x");
  fs.writeFileSync(path.join(root, "secret.txt"), "outside");
  fs.symlinkSync(path.join(root, "secret.txt"), path.join(site, "assets", "link.js"));
  const s = await serve(site);
  try {
    assert.match(s.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    const get = (p, init) => fetch(s.url + p, init);
    const home = await get("?src=https://example.invalid/x.docx");
    assert.equal(home.status, 200);
    assert.match(home.headers.get("content-type"), /^text\/html/);
    const js = await get("assets/a.js");
    assert.equal(js.status, 200);
    assert.match(js.headers.get("content-type"), /^text\/javascript/);
    assert.equal(js.headers.get("x-content-type-options"), "nosniff");
    for (const p of [".onionskin-demo-build", "assets/", "assets", "%2e%2e/secret.txt", "assets/%2e%2e/%2e%2e/secret.txt", "assets/link.js", "nope.html", "%E0%A4%A"]) assert.equal((await get(p)).status, p === "%E0%A4%A" ? 400 : 404, p);
    assert.equal((await get("", { method: "POST" })).status, 405);
    assert.equal((await get("", { method: "HEAD" })).status, 200);
  } finally {
    await s.close();
  }
  assert.throws(() => serve(path.join(root, "rec-none-built")), /no index\.html|ENOENT/);
});

// ---- the page's pure helpers -----------------------------------------------------------------------------------------------------
test("the working state runs at the real speed up to 12 seconds, and is shown in 6 seconds, said plainly, above that", () => {
  assert.deepEqual(workingPlan(8000), { ms: 8000, shortened: false, seconds: 8 });
  assert.deepEqual(workingPlan(12000), { ms: 12000, shortened: false, seconds: 12 });
  assert.deepEqual(workingPlan(95400), { ms: 6000, shortened: true, seconds: 95 });
  assert.deepEqual(workingPlan(undefined), { ms: 0, shortened: false, seconds: 0 });
  assert.equal(workingText(workingPlan(95400)), "Agent working. The real agent took 95 seconds. This replay shows it in 6 seconds.");
  assert.equal(workingText(workingPlan(8000)), "Agent working. This replay runs at the real speed.");
});

test("the run's day is shown as written, never moved by time zone", () => {
  assert.equal(dateText("2026-11-12"), "November 12, 2026");
  assert.equal(dateText("2026-01-01"), "January 1, 2026");
  for (const bad of ["2026-13-01", "11/12/2026", "", null, "2026-11-12T00:00:00Z"]) assert.equal(dateText(bad), "");
});

test("the page loads only the bundled letter: both hashes must match, or nothing is shown", async () => {
  const digest = async (b) => crypto.createHash("sha256").update(b).digest().buffer;
  const a = new Uint8Array([1, 2, 3]);
  const b = new Uint8Array([4, 5, 6]);
  const r = { schema: "onionskin.demo/1", format: "docx", v0_sha256: sha256(a), v1_sha256: sha256(b) };
  assert.equal(await versionsMatch(r, a, b, digest), true);
  assert.equal(await versionsMatch(r, b, a, digest), false);
  assert.equal(await versionsMatch({ ...r, v1_sha256: sha256(a) }, a, b, digest), false);
  assert.equal(await versionsMatch({ ...r, schema: "x" }, a, b, digest), false);
  assert.equal(await versionsMatch({ ...r, v0_sha256: "" }, a, b, digest), false);
  assert.equal(await versionsMatch(r, a, b, () => Promise.reject(new Error("no crypto"))), false);
  assert.equal(await versionsMatch(null, a, b, digest), false);
});

const LETTER = [
  { bi: 0, text: "Dear new neighbor," },
  { bi: 1, text: "Welcome to Maple Court. We are glad you are here." },
  { bi: 2, text: "Our Welcome Desk team looks forward to meeting you." },
  { bi: 3, text: "Our Welcome Desk team looks forward to meeting you." },
];

test("a comment's place is found only when exactly one paragraph holds its words exactly once", () => {
  assert.deepEqual(findQuote(LETTER, "glad you are here"), { bi: 1, start: 31, end: 48 });
  assert.equal(findQuote(LETTER, "Welcome Desk"), null, "in two paragraphs");
  assert.equal(findQuote(LETTER, "Our"), null);
  assert.equal(findQuote(LETTER, "not in the letter"), null);
  assert.equal(findQuote(LETTER, "   "), null);
  assert.equal(findQuote([{ bi: 0, text: "a b a b" }], "a b"), null, "twice in one paragraph");
});

test("the agent's new words are placed only in the one paragraph the diff describes, all or nothing", () => {
  const place = { change: "modified", diff: [["…"], ["=", "Maple Court. We are "], ["-", "delighted"], ["+", "glad"], ["=", " you are here."]], text_start: "Welcome to Maple Court. We are glad" };
  assert.deepEqual(placeRanges(LETTER, place), { bi: 1, ranges: [{ start: 31, end: 35, was: "delighted" }] });
  // a deletion: the place where the words went
  const del = { change: "modified", diff: [["=", "Dear new neighbor"], ["-", " and friend"], ["=", ","]], text_start: "Dear new neighbor," };
  assert.deepEqual(placeRanges(LETTER, del), { bi: 0, ranges: [{ start: 17, end: 17, was: "and friend" }] });
  // two paragraphs read the same: refused
  assert.equal(placeRanges(LETTER, { change: "modified", diff: [["=", "Our "], ["-", "front office"], ["+", "Welcome Desk"], ["=", " team"], ["…"]], text_start: "Our Welcome Desk team" }), null);
  // the opening matches but a piece of the diff is not in the paragraph: refused
  assert.equal(placeRanges(LETTER, { ...place, diff: [["=", "Maple Court. We are "], ["+", "so"], ["=", " glad"]] }), null);
  // odd input never throws
  for (const bad of [null, {}, { diff: "x", text_start: "a" }, { diff: [[1, 2]], text_start: "Dear" }, { ...place, text_start: "" }]) assert.equal(placeRanges(LETTER, bad), null);
  assert.equal(placeRanges(null, place), null);
  // hostile words in the recorded diff come back only as plain strings
  const hostile = { change: "modified", diff: [["=", "Maple Court. We are "], ["-", "javascript:alert(1)"], ["+", "glad"], ["=", " you are here."]], text_start: "Welcome to Maple Court." };
  assert.deepEqual(placeRanges(LETTER, hostile), { bi: 1, ranges: [{ start: 31, end: 35, was: "javascript:alert(1)" }] });
});
