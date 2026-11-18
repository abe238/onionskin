// The cross-document rule with an HTML file (test/agent-binding.test.js for Word, extended): with one Word and one HTML session open, an
// agent Onionskin started for one of them is refused every command it may run against the other (reply, status, status --ticket, poll,
// apply, commit) before anything of it is read: the same refusal, no text, no comment, no batch id, and both files
// byte-identical. Both directions. Real server and real CLI, synthetic documents in a temp dir.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test, before, after } from "node:test";
import { fileURLToPath } from "node:url";
import { docxBytes, tmpdir } from "./helpers/zipbuild.js";

const root = tmpdir();
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE = path.join(root, "st");
process.env.ONIONSKIN_STATE_DIR = STATE;
process.env.ONIONSKIN_LEASE_MS = "60000";
process.env.ONIONSKIN_TICK_MS = "100000";
process.env.ONIONSKIN_NO_SOFFICE = "1";
delete process.env.ONIONSKIN_PYTHON;
const { startServer } = await import("../src/server.js");
const { bgHolder } = await import("../src/agent-detect.js");

let srv;
after(() => {
  srv?.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

const H_TEXT = "Zebra Falcon merger closes on the ninth of March";
const H_PAGE = `<!doctype html><html><head><title>Kestrel</title></head><body><h1>Kestrel pricing</h1><p>${H_TEXT}</p><p>Board vote is unanimous.</p></body></html>`;
const D_TEXT = ["Osprey clause is dropped quietly", "Heron numbers for the second quarter"];
const CANARIES_H = ["Zebra", "Falcon", "Kestrel", "ninth of March", "cHsecret77"];
const CANARIES_D = ["Osprey", "Heron", "second quarter", "cDsecret88"];

function agentCli(args, { holder, workDir }) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(repo, "src", "cli.js"), ...args], { env: { PATH: process.env.PATH, HOME: root, ONIONSKIN_STATE_DIR: STATE, ONIONSKIN_NO_SOFFICE: "1", ONIONSKIN_HOLDER: holder, ...(workDir ? { ONIONSKIN_AGENT_DIR: workDir } : {}) }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    c.stdout.on("data", (d) => (stdout += d));
    c.stderr.on("data", (d) => (stderr += d));
    c.on("close", (code) => resolve({ code, stdout, stderr, all: stdout + stderr }));
  });
}
const noLeak = (r, what, canaries) => {
  for (const c of canaries) assert.ok(!r.all.includes(c), `${what}: printed ${JSON.stringify(c)} of the other document:\n${r.all}`);
};

let H, D, workH, workD;
async function deliver(file, holder, comments) {
  const s = await srv.sessions.openAsync(file);
  const p = srv.sessions.poll(s.key, { holder: holder(s.key) });
  await srv.sessions.sendAsync(s.key, { baseSha: s.baseSha, comments, note: "" });
  return { s, holder: holder(s.key), batch: await p.promise };
}

before(async () => {
  srv = await startServer();
  const fh = path.join(root, "h-page.html");
  fs.writeFileSync(fh, H_PAGE);
  const fd = path.join(root, "d-doc.docx");
  fs.writeFileSync(fd, docxBytes(D_TEXT));
  H = await deliver(fs.realpathSync(fh), bgHolder, [{ id: "cHsecret77", kind: "element", text: "Say April", anchor: { location: { nodeId: 0 }, quote: H_TEXT, hitKind: "element" } }]);
  D = await deliver(fs.realpathSync(fd), bgHolder, [{ id: "cDsecret88", kind: "element", text: "Keep it", anchor: { location: { blockPath: [0] }, paraText: D_TEXT[0] } }]);
  workH = fs.realpathSync(fs.mkdtempSync(path.join(root, "wh-")));
  workD = fs.realpathSync(fs.mkdtempSync(path.join(root, "wd-")));
});

for (const [name, me, other, work, canaries] of [["the HTML file's agent, against the Word file", () => H, () => D, () => workH, CANARIES_D], ["the Word file's agent, against the HTML file", () => D, () => H, () => workD, CANARIES_H]]) {
  test(`${name}: every command it may run is refused before anything is read; both files unchanged`, async () => {
    const A = me();
    const B = other();
    const before = { a: fs.readFileSync(A.s.file), b: fs.readFileSync(B.s.file) };
    // the reply file of a lease is named by that lease's batch id (the background agent's rule): the id the caller passed is not a leak
    const replyFor = (lease) => {
      const f = path.join(work(), `reply-${lease.split(":")[0]}.json`);
      fs.writeFileSync(f, JSON.stringify({ summary: "x", replies: [{ comment: B.batch.instructions.comments[0].id, find: "no such words", replace: "y" }] }));
      return f;
    };
    const ops = path.join(work(), "ops.json");
    fs.writeFileSync(ops, JSON.stringify({ schema: "onionskin.ops/1", ops: [{ op: "replace_text", target: { path: "/html[1]/body[1]/p[1]" }, expect: { text_hash: "0000000000000000" }, find: "a", replace: "b" }] }));
    const lease = `${B.batch.batch_id}:0123456789abcdef`;
    const cmds = [
      ["reply", B.s.file, "--lease", lease, "--file", replyFor(lease)],
      ["reply", B.s.file, "--lease", A.batch.lease_ticket, "--file", replyFor(A.batch.lease_ticket)],
      ["status", B.s.file],
      ["status", B.s.file, "--ticket"],
      ["poll", B.s.file, "--timeout", "2"],
      ["apply", B.s.file, "--ops", ops, "--lease", lease],
      ["apply", B.s.file, "--ops", ops, "--dry-run"],
      ["commit", B.s.file, "--from", A.s.file, "--lease", lease],
    ];
    for (const args of cmds) {
      const r = await agentCli(args, { holder: A.holder, workDir: work() });
      const what = args.slice(0, 2).join(" ");
      assert.notEqual(r.code, 0, `${what} must fail: ${r.all}`);
      noLeak(r, what, args.includes(lease) ? canaries : [...canaries, B.batch.batch_id]);
      assert.match(r.all, /only on the file it was started for|not_your_file/, `${what}: ${r.all}`);
    }
    assert.ok(fs.readFileSync(A.s.file).equals(before.a) && fs.readFileSync(B.s.file).equals(before.b), "both files byte-identical");
    assert.equal(srv.sessions.state(B.s), "working", "the other delivery is untouched");
  });
}

test("the rightful HTML agent still works on its own file (status with its ticket)", async () => {
  const r = await agentCli(["status", H.s.file, "--ticket"], { holder: H.holder });
  assert.equal(r.code, 0, r.all);
  assert.equal(JSON.parse(r.stdout).ticket, H.batch.lease_ticket);
});
