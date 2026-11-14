// Item 12: a file changed by someone else is never overwritten; the version Onionskin holds is saved as a sibling copy.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test, before, after } from "node:test";
import { fileURLToPath } from "node:url";
import { tmpdir, docxBytes } from "./helpers/zipbuild.js";

const root = tmpdir();
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE = path.join(root, "st");
process.env.ONIONSKIN_STATE_DIR = STATE;
process.env.ONIONSKIN_LEASE_MS = "600000";
process.env.ONIONSKIN_TICK_MS = "100000";
process.env.ONIONSKIN_NO_SOFFICE = "1";
process.env.ONIONSKIN_NO_OPEN = "1"; // never launch Finder from a test
delete process.env.ONIONSKIN_PYTHON;
const { startServer } = await import("../src/server.js");
const { writeSiblingCopy, sha256 } = await import("../src/fsutil.js");
const { HttpError } = await import("../src/session.js");
let srv;
before(async () => {
  srv = await startServer();
});
after(() => srv.shutdown());

const paras = Array.from({ length: 5 }, (_, i) => `Paragraph ${i + 1}: some real sentence number ${i * 5 + 3} for the outside-change tests.`);
const dirIn = (n) => {
  const d = path.join(root, n);
  fs.mkdirSync(d);
  return fs.realpathSync(d);
};
const cli = (args, env = {}) =>
  new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(repo, "src", "cli.js"), ...args], { env: { PATH: process.env.PATH, HOME: root, ONIONSKIN_STATE_DIR: STATE, ONIONSKIN_NO_SOFFICE: "1", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    c.stdout.on("data", (d) => (stdout += d));
    c.stderr.on("data", (d) => (stderr += d));
    c.on("exit", (status) => resolve({ status, stdout, stderr }));
  });

test("copy naming: local time stamp, ` 2`, ` 3` on collision, never overwrites an existing file, mode preserved", () => {
  const d = dirIn("naming");
  const orig = path.join(d, "Quarterly report.docx");
  fs.writeFileSync(orig, docxBytes(paras));
  fs.chmodSync(orig, 0o640);
  const now = new Date(2026, 10, 10, 14, 32, 5); // local time
  const a = writeSiblingCopy(orig, Buffer.from("copy one"), { now });
  assert.equal(a.name, "Quarterly report (Onionskin copy 2026-11-10 1432).docx");
  assert.equal(a.path, path.join(d, a.name));
  const b = writeSiblingCopy(orig, Buffer.from("copy two"), { now });
  assert.equal(b.name, "Quarterly report (Onionskin copy 2026-11-10 1432) 2.docx");
  const c = writeSiblingCopy(orig, Buffer.from("copy three"), { now });
  assert.equal(c.name, "Quarterly report (Onionskin copy 2026-11-10 1432) 3.docx");
  assert.equal(fs.readFileSync(a.path, "utf8"), "copy one", "the first copy was not overwritten");
  assert.equal(fs.readFileSync(c.path, "utf8"), "copy three");
  assert.equal(fs.statSync(a.path).mode & 0o777, 0o640, "same permissions as the original");
  const later = writeSiblingCopy(orig, Buffer.from("later"), { now: new Date(2026, 10, 10, 14, 33) });
  assert.equal(later.name, "Quarterly report (Onionskin copy 2026-11-10 1433).docx");
  assert.deepEqual(fs.readdirSync(d).filter((n) => n.endsWith(".tmp")), [], "no staging files left");
  assert.ok(fs.readFileSync(orig).equals(docxBytes(paras)), "the original is untouched");
});

async function opened(name, text = paras) {
  const d = dirIn(name);
  const file = path.join(d, `${name}.docx`);
  fs.writeFileSync(file, docxBytes(text));
  const real = fs.realpathSync(file);
  return { dir: d, real, s: srv.sessions.open(real) };
}

test("user Send conflict: the original is not touched, the page's bytes are saved as a copy, the 409 names it; showCopy only reveals what the server wrote", async () => {
  const { dir, real, s } = await opened("userconflict");
  const outside = docxBytes(["saved by someone else in Word"]);
  fs.writeFileSync(real, outside);
  const mine = docxBytes([...paras.slice(0, 2), "MY UNSENT EDIT"]);
  let err;
  try {
    srv.sessions.send(s.key, { baseSha: s.baseSha, bytes: mine, comments: [], note: "" });
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof HttpError);
  assert.equal(err.status, 409);
  assert.equal(err.extra.code, "conflict");
  assert.equal(err.extra.side, "user");
  assert.match(err.extra.copy_name, /^userconflict \(Onionskin copy \d{4}-\d\d-\d\d \d{4}\)\.docx$/);
  assert.equal(err.extra.copy_path, path.join(dir, err.extra.copy_name));
  assert.ok(fs.readFileSync(real).equals(outside), "the original is byte-identical to the outside version");
  assert.ok(fs.readFileSync(err.extra.copy_path).equals(mine), "the copy holds the user's edits");
  assert.equal(srv.sessions.showCopy(err.extra.copy_path).opened, false, "NO_OPEN: nothing launched");
  assert.throws(() => srv.sessions.showCopy(real), (e) => e.status === 404, "the original is not a server-made copy");
  assert.throws(() => srv.sessions.showCopy(path.join(dir, "elsewhere.docx")), (e) => e.status === 404);
  assert.throws(() => srv.sessions.showCopy("/etc/hosts"), (e) => e.status === 404);
  // the cheap early check sees it too, and reload (the page loads what is on disk) clears it
  assert.equal(srv.sessions.staleCheck(s.key, s.baseSha).stale, true);
  assert.equal(srv.sessions.staleCheck(s.key, sha256(outside)).stale, false);
});

test("an unwritable folder: the original is still untouched and the 409 says the copy could not be saved (the page offers the download)", async () => {
  const { dir, real, s } = await opened("readonlydir");
  const outside = docxBytes(["outside again"]);
  fs.writeFileSync(real, outside);
  fs.chmodSync(dir, 0o555);
  try {
    let err;
    try {
      srv.sessions.send(s.key, { baseSha: s.baseSha, bytes: docxBytes(["mine"]), comments: [], note: "" });
    } catch (e) {
      err = e;
    }
    assert.equal(err.extra.code, "conflict");
    assert.equal(err.extra.copy_name, null);
    assert.equal(err.extra.copy_path, null);
    assert.match(err.extra.copy_error, /could not be saved/);
  } finally {
    fs.chmodSync(dir, 0o755);
  }
  assert.ok(fs.readFileSync(real).equals(outside));
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes("Onionskin copy")), []);
});

test("agent side: commit after an outside change reports outside_change with the copy path, exits non-zero, leaves the original alone; done reports it and the batch goes back to the user", async () => {
  const { dir, real, s } = await opened("agentconflict");
  const poll = srv.sessions.poll(s.key, { holder: "OC" });
  srv.sessions.send(s.key, { baseSha: s.baseSha, comments: [{ id: "c1", kind: "element", text: "fix", anchor: { location: { blockPath: [1] }, paraText: paras[1] } }], note: "" });
  const batch = await poll.promise;
  const ticket = `${batch.batch_id}:${batch.lease.token}`;
  const outside = docxBytes(["someone else saved this while the agent was working"]);
  fs.writeFileSync(real, outside);
  const candidate = path.join(root, "agent-candidate.docx");
  const candBytes = docxBytes([...paras.slice(0, 1), "The agent's version of paragraph two.", ...paras.slice(2)]);
  fs.writeFileSync(candidate, candBytes);
  const r = await cli(["commit", real, "--from", candidate, "--lease", ticket], { ONIONSKIN_HOLDER: "OC" });
  assert.equal(r.status, 5, r.stderr);
  const rep = JSON.parse(r.stdout);
  assert.equal(rep.status, "outside_change");
  assert.equal(rep.written, false);
  assert.equal(rep.outside_change.copy_path, path.join(dir, rep.outside_change.copy_name));
  assert.match(rep.outside_change.instruction, /Do not retry and do not write the original/);
  assert.ok(fs.readFileSync(real).equals(outside), "the original is byte-identical to the outside version");
  assert.ok(fs.readFileSync(rep.outside_change.copy_path).equals(candBytes), "the copy equals the agent's candidate bytes");
  const v = srv.sessions.view(s);
  assert.equal(v.conflict.side, "agent");
  assert.equal(v.conflict.copyName, rep.outside_change.copy_name);
  assert.equal(v.activity[0].kind, "outside_change");
  assert.match(v.activity[0].summary, /Your original file was left untouched|original file was left untouched/);
  // the agent reports and stops: done works, flags it, and the conflict banner clears with the run
  fs.writeFileSync(path.join(root, "oc-results.json"), JSON.stringify({ summary: `File changed outside Onionskin; my version is in ${rep.outside_change.copy_name}`, results: [{ comment_id: "c1", status: "declined", note: "file changed outside" }] }));
  const d = await cli(["done", real, "--results", path.join(root, "oc-results.json"), "--lease", ticket], { ONIONSKIN_HOLDER: "OC" });
  assert.equal(d.status, 0, d.stderr);
  const out = JSON.parse(d.stdout);
  assert.ok(out.flags.some((f) => f.code === "outside_change" && f.severity === "warn"));
  assert.equal(srv.sessions.view(s).conflict, null);
  assert.equal(srv.sessions.state(s), "idle", "back with the user, not stranded");
});

test("a conflict found at done after the agent wrote says nothing extra was copied and Revert exists", async () => {
  const { real, s } = await opened("doneconflict");
  const poll = srv.sessions.poll(s.key, { holder: "DC" });
  srv.sessions.send(s.key, { baseSha: s.baseSha, comments: [], note: "go" });
  const batch = await poll.promise;
  fs.writeFileSync(real, docxBytes(["changed behind the lease"]));
  const out = srv.sessions.done(s.key, { summary: "x", results: [] }, { holder: "DC", token: batch.lease.token, batchId: batch.batch_id, strict: true });
  const f = out.flags.find((x) => x.code === "file_changed_outside_onionskin");
  assert.equal(f.severity, "error");
  assert.match(f.detail, /Nothing extra was copied/);
  assert.match(f.detail, /Revert/);
});
