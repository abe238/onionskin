// Security pass: the ticket protocol, commit, and fail-closed apply (findings 2, 4, 5), against a real server and the real CLI.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { test, before, after } from "node:test";
import { fileURLToPath } from "node:url";
import { tmpdir, docxBytes } from "./helpers/zipbuild.js";

const root = tmpdir();
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE = path.join(root, "st");
process.env.ONIONSKIN_STATE_DIR = STATE;
process.env.ONIONSKIN_LEASE_MS = "60000";
process.env.ONIONSKIN_TICK_MS = "100000";
process.env.ONIONSKIN_NO_SOFFICE = "1";
delete process.env.ONIONSKIN_PYTHON;
const { startServer } = await import("../src/server.js");
const { sha256 } = await import("../src/fsutil.js");
const { socketPath } = await import("../src/paths.js");

let srv;
before(async () => {
  srv = await startServer();
});
after(() => srv.shutdown());

const paras = Array.from({ length: 6 }, (_, i) => `Paragraph ${i + 1}: some real sentence number ${i * 5 + 3} for the protocol tests.`);
const comment = (id, i) => ({ id, kind: "element", text: "fix", anchor: { location: { blockPath: [i] }, paraText: paras[i] } });
let n = 0;
const via = (method, p, body) =>
  new Promise((resolve, reject) => {
    const r = http.request({ socketPath: socketPath(), method, path: p, headers: body ? { "content-type": "application/json" } : {} }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString() || "{}") }));
    });
    r.on("error", reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
const cli = (args, env = {}) =>
  new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(repo, "src", "cli.js"), ...args], { env: { PATH: process.env.PATH, HOME: root, ONIONSKIN_STATE_DIR: STATE, ONIONSKIN_NO_SOFFICE: "1", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    c.stdout.on("data", (d) => (stdout += d));
    c.stderr.on("data", (d) => (stderr += d));
    c.on("exit", (status) => resolve({ status, stdout, stderr }));
  });
const reportOf = (r) => {
  try {
    return JSON.parse(r.stdout);
  } catch {
    return {};
  }
};

/** A file with a delivered batch held by holder `H`. Returns {file, key, batch, ticket}. */
async function delivered(holder = "H") {
  const file = path.join(root, `p${++n}.docx`);
  fs.writeFileSync(file, docxBytes(paras));
  const real = fs.realpathSync(file);
  const s = srv.sessions.open(real);
  const poll = srv.sessions.poll(s.key, { holder });
  srv.sessions.send(s.key, { baseSha: s.baseSha, comments: [comment("c1", 1)], note: "" });
  const batch = await poll.promise;
  return { file: real, s, key: s.key, batch, ticket: `${batch.batch_id}:${batch.lease.token}`, env: { ONIONSKIN_HOLDER: holder } };
}
const results = (path_) => {
  fs.writeFileSync(path_, JSON.stringify({ summary: "ok", results: [{ comment_id: "c1", status: "done", note: "" }] }));
  return path_;
};

// ---- finding 4 ------------------------------------------------------------------------------------------------------------
test("finding 4: agent-write, commit and apply-report refuse missing credentials with missing_lease, whatever else is sent", async () => {
  const d = await delivered();
  const bytes_b64 = docxBytes(["x"]).toString("base64");
  const base = sha256(fs.readFileSync(d.file));
  for (const [route, body] of [
    ["/cli/agent-write", { file: d.file, base_sha256: base, bytes_b64 }],
    ["/cli/commit", { file: d.file, bytes_b64 }],
    ["/cli/apply-report", { file: d.file, problems: [] }],
    ["/cli/agent-write", { file: d.file, base_sha256: base, bytes_b64, holder: "H" }],
    ["/cli/agent-write", { file: d.file, base_sha256: base, bytes_b64, holder: "H", batch_id: d.batch.batch_id }],
    ["/cli/commit", { file: d.file, bytes_b64, lease_token: d.batch.lease.token, batch_id: d.batch.batch_id }],
  ]) {
    const r = await via("POST", route, body);
    assert.equal(r.status, 400, `${route} ${JSON.stringify(Object.keys(body))}`);
    assert.equal(r.json.code, "missing_lease");
  }
  assert.equal(sha256(fs.readFileSync(d.file)), base, "nothing was written");
});

test("finding 4: done, apply and commit without --lease are refused while a batch is delivered; there is no per-file fallback", async () => {
  const d = await delivered("H4");
  const cand = path.join(root, "cand4.docx");
  fs.writeFileSync(cand, docxBytes(["candidate"]));
  const ops = path.join(root, "ops4.json");
  fs.writeFileSync(ops, JSON.stringify({ schema: "onionskin.ops/1", ops: [{ op: "replace_text", target: { text_hash: "0123456789abcdef" }, expect: { quote: "x" }, find: "a", replace: "b" }] }));
  const before = sha256(fs.readFileSync(d.file));
  const done = await cli(["done", d.file, "--results", results(path.join(root, "r4.json"))], d.env);
  assert.equal(done.status, 1);
  assert.match(done.stderr, /pass --lease <ticket>/);
  const apply = await cli(["apply", d.file, "--ops", ops], d.env);
  assert.equal(apply.status, 5);
  assert.match(apply.stderr, /--lease/);
  const commit = await cli(["commit", d.file, "--from", cand], d.env);
  assert.equal(commit.status, 5);
  assert.match(commit.stderr, /--lease/);
  assert.equal(sha256(fs.readFileSync(d.file)), before);
  assert.equal(srv.sessions.state(d.s), "working", "the delivery is still live");
  // results.json fields are not credentials either
  fs.writeFileSync(path.join(root, "r4b.json"), JSON.stringify({ summary: "x", results: [], holder: "H4", lease_token: d.batch.lease.token, batch_id: d.batch.batch_id }));
  assert.equal((await cli(["done", d.file, "--results", path.join(root, "r4b.json")], d.env)).status, 1);
});

test("finding 4: the ticket is stored 0600 by batch id, `status --ticket` answers only the poller that holds it, and it is gone after done", async () => {
  const d = await delivered("HOLDER-A");
  const tf = path.join(STATE, "tickets", `${d.batch.batch_id}.json`);
  assert.equal(fs.statSync(tf).mode & 0o777, 0o600);
  const mine = await cli(["status", d.file, "--ticket"], { ONIONSKIN_HOLDER: "HOLDER-A" });
  assert.equal(mine.status, 0, mine.stderr);
  assert.equal(JSON.parse(mine.stdout).ticket, d.ticket);
  const other = await cli(["status", d.file, "--ticket"], { ONIONSKIN_HOLDER: "HOLDER-B" });
  assert.equal(other.status, 1);
  assert.ok(!other.stdout.includes(d.batch.lease.token) && !other.stderr.includes(d.batch.lease.token), "the other agent learns nothing");
  const plain = await cli(["status", d.file], { ONIONSKIN_HOLDER: "HOLDER-A" });
  assert.ok(!plain.stdout.includes(d.batch.lease.token), "plain status never prints the ticket");
  const ok = await cli(["done", d.file, "--results", results(path.join(root, "r4c.json")), "--lease", d.ticket], d.env.ONIONSKIN_HOLDER ? { ONIONSKIN_HOLDER: "HOLDER-A" } : {});
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(!fs.existsSync(tf), "the ticket file is removed when the delivery ends");
});

// ---- finding 5 ------------------------------------------------------------------------------------------------------------
test("finding 5: with a ticket, apply and commit fail closed when the session is closed, was taken back, or the server no longer knows it", async () => {
  const cand = path.join(root, "cand5.docx");
  fs.writeFileSync(cand, docxBytes(["candidate five"]));
  const refused = async (d, why) => {
    const before = sha256(fs.readFileSync(d.file));
    const c = await cli(["commit", d.file, "--from", cand, "--lease", d.ticket], d.env);
    assert.equal(c.status, 5, `${why}: ${c.stderr}${c.stdout}`);
    assert.equal(sha256(fs.readFileSync(d.file)), before, `${why}: file untouched`);
    const ops = path.join(root, `o5-${why.replace(/\W/g, "")}.json`);
    fs.writeFileSync(ops, JSON.stringify({ schema: "onionskin.ops/1", ops: [{ op: "replace_text", target: { text_hash: "0123456789abcdef" }, expect: { quote: "x" }, find: "a", replace: "b" }] }));
    const a = await cli(["apply", d.file, "--ops", ops, "--lease", d.ticket], d.env);
    assert.equal(a.status, 5, `${why}: apply ${a.stderr}`);
  };
  const closed = await delivered("H5a");
  srv.sessions.close(closed.key);
  await refused(closed, "closed");
  const revoked = await delivered("H5b");
  srv.sessions.takeBack(revoked.key);
  await refused(revoked, "taken back");
  const forgotten = await delivered("H5c");
  srv.sessions.map.delete(forgotten.key); // a server that restarted without loading the session
  await refused(forgotten, "unknown to the server");
  const ok = await delivered("H5d");
  const good = await cli(["commit", ok.file, "--from", cand, "--lease", ok.ticket], ok.env);
  assert.equal(good.status, 0, good.stderr + good.stdout);
});

test("finding 5: a standalone write needs --standalone and is refused while a live session or a saved delivery exists", async () => {
  const cand = path.join(root, "cand5s.docx");
  fs.writeFileSync(cand, docxBytes(["candidate standalone"]));
  const plain = path.join(root, "plain.docx");
  fs.writeFileSync(plain, docxBytes(paras));
  const base = sha256(fs.readFileSync(plain));
  // no session, no flag: refused
  const noFlag = await cli(["commit", plain, "--from", cand, "--base", base]);
  assert.equal(noFlag.status, 5);
  assert.match(noFlag.stderr, /--standalone/);
  assert.equal(sha256(fs.readFileSync(plain)), base);
  // explicit flag works, but only against a base that still matches
  const stale = await cli(["commit", plain, "--from", cand, "--standalone", "--base", "0".repeat(64)]);
  assert.equal(stale.status, 5);
  const noBase = await cli(["commit", plain, "--from", cand, "--standalone"]);
  assert.equal(noBase.status, 2, "a standalone commit without --base is invalid");
  const okc = await cli(["commit", plain, "--from", cand, "--standalone", "--base", base]);
  assert.equal(okc.status, 0, okc.stderr + okc.stdout);
  assert.equal(reportOf(okc).write_path, "standalone");
  assert.ok(fs.readFileSync(plain).equals(fs.readFileSync(cand)));
  // a live session for the file: --standalone is refused
  const live = await delivered("H5e");
  const refusedLive = await cli(["commit", live.file, "--from", cand, "--standalone", "--base", sha256(fs.readFileSync(live.file))], live.env);
  assert.equal(refusedLive.status, 5);
  assert.match(refusedLive.stderr, /session is open/);
  // a saved delivery whose session is gone: --standalone is refused too
  srv.sessions.map.delete(live.key);
  const refusedSaved = await cli(["commit", live.file, "--from", cand, "--standalone", "--base", sha256(fs.readFileSync(live.file))], live.env);
  assert.equal(refusedSaved.status, 5);
  assert.match(refusedSaved.stderr, /delivery is saved/);
  // --lease and --standalone together make no sense
  assert.equal((await cli(["commit", live.file, "--from", cand, "--standalone", "--lease", live.ticket])).status, 2);
});

// ---- finding 2 ------------------------------------------------------------------------------------------------------------
test("finding 2: commit submits a copy through the checked write: lease, compare-and-swap, snapshot, atomic replace", async () => {
  const d = await delivered("H2");
  const before = fs.readFileSync(d.file);
  const copy = path.join(root, "copy2.docx");
  fs.copyFileSync(d.file, copy);
  fs.writeFileSync(copy, docxBytes([...paras.slice(0, 1), "The agent's rewritten paragraph.", ...paras.slice(2)]));
  const r = await cli(["commit", d.file, "--from", copy, "--lease", d.ticket], d.env);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const rep = reportOf(r);
  assert.equal(rep.written, true);
  assert.equal(rep.new_sha256, sha256(fs.readFileSync(copy)));
  assert.ok(fs.readFileSync(d.file).equals(fs.readFileSync(copy)));
  assert.ok(d.s.snapshots.has(sha256(before)), "the version it replaced is snapshotted");
  // the file moved behind the agent's back after the commit: a second commit from the old base is refused with conflict
  const external = docxBytes(["saved by another program"]);
  fs.writeFileSync(d.file, external);
  const late = path.join(root, "late2.docx");
  fs.writeFileSync(late, docxBytes(["stale candidate"]));
  const refused = await cli(["commit", d.file, "--from", late, "--lease", d.ticket], d.env);
  assert.equal(refused.status, 5);
  assert.equal(reportOf(refused).write_error.code, "conflict");
  assert.ok(fs.readFileSync(d.file).equals(external), "the newer bytes survive");
  // the original path is not a candidate; a wrong ticket is refused by the server
  assert.equal((await cli(["commit", d.file, "--from", d.file, "--lease", d.ticket], d.env)).status, 2);
  fs.writeFileSync(d.file, before);
  const wrongTicket = `${d.batch.batch_id}:${"0".repeat(16)}`;
  const bad = await cli(["commit", d.file, "--from", late, "--lease", wrongTicket], d.env);
  assert.equal(bad.status, 5);
  assert.equal(reportOf(bad).write_error.code, "stale_batch");
});

test("finding 2: done flags, at error severity with Revert recommended, a file changed during the turn by any path other than apply or commit", async () => {
  const d = await delivered("H2b");
  const before = fs.readFileSync(d.file);
  fs.writeFileSync(d.file, docxBytes(["the agent saved this straight over the document with its own library"]));
  const out = srv.sessions.done(d.key, { summary: "direct save", results: [{ comment_id: "c1", status: "done", note: "" }] }, { holder: "H2b", token: d.batch.lease.token, batchId: d.batch.batch_id, strict: true });
  const flag = out.flags.find((f) => f.code === "file_changed_outside_onionskin");
  assert.ok(flag, JSON.stringify(out.flags));
  assert.equal(flag.severity, "error");
  const entry = d.s.activity[0];
  assert.equal(entry.revertRecommended, true);
  srv.sessions.revert(d.key, entry.id);
  assert.ok(fs.readFileSync(d.file).equals(before), "Revert restores the pre-agent bytes");
  // through commit there is no such flag
  const e = await delivered("H2c");
  const cand = path.join(root, "cand2c.docx");
  fs.writeFileSync(cand, docxBytes(["through commit"]));
  assert.equal((await cli(["commit", e.file, "--from", cand, "--lease", e.ticket], e.env)).status, 0);
  const out2 = srv.sessions.done(e.key, { summary: "ok", results: [{ comment_id: "c1", status: "done", note: "" }] }, { holder: "H2c", token: e.batch.lease.token, batchId: e.batch.batch_id, strict: true });
  assert.ok(!out2.flags.some((f) => f.code === "file_changed_outside_onionskin"));
});

test("finding 2: the batch tells the agent to edit a copy and commit it, with its own ticket filled in", async () => {
  const d = await delivered("H2d");
  const rule = d.batch.how_to_apply.rules.find((r) => /commit/.test(r));
  assert.ok(rule, "a commit rule is in how_to_apply");
  assert.ok(rule.includes(`--lease ${d.ticket}`) && !rule.includes("<ticket>"));
  assert.match(rule, /never write the document's own path/);
  assert.match(d.batch.how_to_apply.command, new RegExp(`--lease ${d.ticket}`));
});
