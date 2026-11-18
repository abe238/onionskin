// An agent Onionskin started (the background holder onionskin-bg-<key>, or its Terminal form) is bound to its one file. Asked about
// another open document with a ticket that is not its own (garbage, well-formed but wrong, its own file's, or none), every command it may
// run (`poll`, `reply`, `status`) refuses in plain words and prints nothing of that document: no text, no comment, no batch id, no state,
// and the same words whether that document is open or not. Authorization comes first: the server checks the binding and the lease before
// the CLI reads or parses the file. Real server and real CLI, synthetic documents in a temp dir.
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
const { bgHolder, termHolder } = await import("../src/agent-detect.js");

let srv;
after(() => {
  srv?.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

// what B says, and what nothing run by A's agent may ever print
const B_TEXT = ["Zebra Falcon merger closes on the ninth of March", "Board vote is unanimous on Kestrel pricing"];
const B_COMMENT = "Quietly drop the Osprey clause";
const B_COMMENT_ID = "cBsecret77";
const CANARIES = ["Zebra", "Falcon", "Kestrel", "Osprey", "ninth of March", B_COMMENT_ID];

const written = (name, paras) => {
  const f = path.join(root, name);
  fs.writeFileSync(f, docxBytes(paras));
  return fs.realpathSync(f);
};
const comment = (id, i, paraText, text) => ({ id, kind: "element", text, anchor: { location: { blockPath: [i] }, paraText } });

/** A file with a batch delivered to `holderOf(key)`. */
async function deliver(file, holderOf, comments) {
  const s = srv.sessions.open(file);
  const holder = holderOf(s.key);
  const p = srv.sessions.poll(s.key, { holder });
  srv.sessions.send(s.key, { baseSha: s.baseSha, comments, note: "" });
  return { s, holder, batch: await p.promise };
}

/** The real CLI with the environment the background agent gets (src/agent-detect.js cleanEnv). `body` goes to <work dir>/reply-<batch id>.json. */
function agentCli(args, { holder, workDir, env = {} }) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(repo, "src", "cli.js"), ...args], { env: { PATH: process.env.PATH, HOME: root, ONIONSKIN_STATE_DIR: STATE, ONIONSKIN_NO_SOFFICE: "1", ...(holder ? { ONIONSKIN_HOLDER: holder } : {}), ...(workDir ? { ONIONSKIN_AGENT_DIR: workDir } : {}), ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    c.stdout.on("data", (d) => (stdout += d));
    c.stderr.on("data", (d) => (stderr += d));
    c.on("close", (code) => resolve({ code, stdout, stderr, all: stdout + stderr }));
  });
}
const replyFile = (workDir, ticket, body) => {
  const f = path.join(workDir, `reply-${ticket.split(":")[0]}.json`);
  fs.writeFileSync(f, JSON.stringify(body));
  return f;
};
const noLeak = (r, what, extra = []) => {
  for (const c of [...CANARIES, ...extra]) assert.ok(!r.all.includes(c), `${what}: printed ${JSON.stringify(c)} of the other document:\n${r.all}`);
};

let A, B, C, workA, holderA;
before(async () => {
  srv = await startServer();
  const fa = written("a-own.docx", ["Alpha paragraph one about apples", "Alpha paragraph two about pears"]);
  const fb = written("b-other.docx", B_TEXT);
  C = written("c-closed.docx", ["Gamma text nobody opened"]);
  A = await deliver(fa, bgHolder, [comment("cA1", 0, "Alpha paragraph one about apples", "say oranges")]);
  B = await deliver(fb, () => "h_person0001", [comment(B_COMMENT_ID, 0, B_TEXT[0], B_COMMENT)]);
  holderA = A.holder;
  workA = fs.realpathSync(fs.mkdtempSync(path.join(root, "w-")));
});

// the replies that, run on B, would make the engine describe B's text: a find that misses, a quote that does not match, an unknown comment
const PROBES = () => [
  { summary: "x", replies: [{ comment: B_COMMENT_ID, find: "no such words here", replace: "y" }] },
  { summary: "x", replies: [], ops: [{ op: "replace_text", target: { body_path: [0] }, expect: { quote: "Q-not-there" }, find: "a", replace: "b" }, { op: "replace_text", target: { body_path: [1] }, expect: { text_hash: "0000000000000000" }, text: "z" }] },
  { summary: "x", replies: [{ comment: "nope", decline: true }] },
];

test("reply on another open document refuses before reading it: garbage, wrong and own tickets, --partial and --then-poll", async () => {
  const bId = B.batch.batch_id;
  const leases = { wrong_token: `${bId}:0123456789abcdef`, own_ticket: A.batch.lease_ticket, other_batch: "b_000000000000:0000000000000000" };
  const before = fs.readFileSync(B.s.file);
  for (const [kind, lease] of Object.entries(leases)) {
    for (const [i, body] of PROBES().entries()) {
      for (const extra of [[], ["--partial"], ["--then-poll", "--timeout", "1"]]) {
        const rf = replyFile(workA, lease, body);
        const r = await agentCli(["reply", B.s.file, "--lease", lease, "--file", rf, ...extra], { holder: holderA, workDir: workA });
        const what = `reply ${kind} probe ${i} ${extra.join(" ")}`;
        assert.notEqual(r.code, 0, `${what} must fail: ${r.all}`);
        noLeak(r, what, kind === "wrong_token" ? [] : [bId]);
        const j = JSON.parse(r.stdout.split("\n")[0]);
        assert.equal(j.ok, false, what);
        assert.equal(j.code, "not_your_file", `${what}: ${r.stdout}`);
        assert.equal(j.problems, undefined, what);
        assert.equal(j.not_applied, undefined, what);
      }
    }
  }
  assert.ok(before.equals(fs.readFileSync(B.s.file)), "B is byte-identical");
  assert.equal(srv.sessions.state(B.s), "working", "B's delivery is untouched");
});

test("the refusal is the same whether the other document is open or not, and a closed file is not opened", async () => {
  const lease = "b_000000000000:0000000000000000";
  const rf = replyFile(workA, lease, PROBES()[1]);
  const rb = await agentCli(["reply", B.s.file, "--lease", lease, "--file", rf], { holder: holderA, workDir: workA });
  const rc = await agentCli(["reply", C, "--lease", lease, "--file", rf], { holder: holderA, workDir: workA });
  assert.equal(rb.stdout.replaceAll(B.s.file, "<F>"), rc.stdout.replaceAll(C, "<F>"));
  const sb = await agentCli(["status", B.s.file], { holder: holderA });
  const sc = await agentCli(["status", C], { holder: holderA });
  assert.notEqual(sb.code, 0, sb.all);
  assert.equal(sb.all.replaceAll(B.s.file, "<F>"), sc.all.replaceAll(C, "<F>"));
  const keys = new Set(srv.sessions.map.keys());
  const pc = await agentCli(["poll", C, "--timeout", "2"], { holder: holderA });
  const pb = await agentCli(["poll", B.s.file, "--timeout", "2"], { holder: holderA });
  assert.notEqual(pc.code, 0, pc.all);
  assert.equal(pb.all.replaceAll(B.s.file, "<F>"), pc.all.replaceAll(C, "<F>"));
  assert.deepEqual(new Set(srv.sessions.map.keys()), keys, "poll by a bound agent never opens another file");
});

test("status, status --ticket and poll of another document print nothing of it", async () => {
  const bId = B.batch.batch_id;
  for (const holder of [holderA, termHolder(A.s.key)]) {
    for (const args of [["status", B.s.file], ["status", B.s.file, "--ticket"], ["poll", B.s.file, "--timeout", "2"], ["poll", B.s.file, "--ack", "--full", "--timeout", "2"]]) {
      const r = await agentCli(args, { holder });
      const what = `${args.join(" ")} as ${holder.slice(0, 14)}`;
      assert.notEqual(r.code, 0, `${what} must fail: ${r.all}`);
      noLeak(r, what, [bId, "working", "delivered_batch", B.s.key]);
      assert.match(r.all, /only on the file it was started for/, what);
    }
  }
  assert.equal(srv.sessions.state(B.s), "working");
  assert.equal(B.s.delivered.lease.holder, "h_person0001", "B's lease is untouched");
});

test("reply without a file: a ticket naming another document's batch does not reveal its file name", async () => {
  const lease = `${B.batch.batch_id}:0123456789abcdef`;
  const rf = replyFile(workA, lease, PROBES()[0]);
  const r = await agentCli(["reply", "--lease", lease, "--file", rf], { holder: holderA, workDir: workA });
  assert.notEqual(r.code, 0);
  noLeak(r, "reply without a file", ["b-other", B.s.file]);
  // an ordinary caller with B's batch id but not its token learns no file name either
  const p = await agentCli(["reply", "--lease", lease, "--json", "{}"], {});
  assert.notEqual(p.code, 0);
  noLeak(p, "reply without a file, no agent holder", ["b-other", B.s.file]);
});

test("an ordinary caller with B's batch id and a wrong token gets a content-free refusal before the engine runs", async () => {
  const lease = `${B.batch.batch_id}:0123456789abcdef`;
  for (const body of PROBES()) {
    const r = await agentCli(["reply", B.s.file, "--lease", lease, "--json", JSON.stringify(body)], { holder: "h_person0001" });
    assert.notEqual(r.code, 0, r.all);
    noLeak(r, "reply with B's holder and a wrong token", []);
    const j = JSON.parse(r.stdout.split("\n")[0]);
    assert.equal(j.problems, undefined);
    assert.equal(j.code, "stale_batch", r.stdout);
  }
});

test("the rightful agent keeps its helpful diagnostics on its own file and lease", async () => {
  const st = await agentCli(["status", A.s.file], { holder: holderA });
  assert.equal(st.code, 0, st.all);
  assert.equal(JSON.parse(st.stdout).delivered_batch, A.batch.batch_id);
  const tk = await agentCli(["status", A.s.file, "--ticket"], { holder: holderA });
  assert.equal(tk.code, 0, tk.all);
  assert.equal(JSON.parse(tk.stdout).ticket, A.batch.lease_ticket);
  const rf = replyFile(workA, A.batch.lease_ticket, { summary: "x", replies: [], ops: [{ op: "replace_text", target: { body_path: [1] }, expect: { quote: "Q-not-there" }, find: "a", replace: "b" }] });
  const r = await agentCli(["reply", A.s.file, "--lease", A.batch.lease_ticket, "--file", rf, "--partial"], { holder: holderA, workDir: workA });
  assert.notEqual(r.code, 0);
  const j = JSON.parse(r.stdout.split("\n")[0]);
  assert.equal(j.problems[0].status, "expect_mismatch", r.stdout);
  assert.match(j.problems[0].actual_excerpt, /Alpha paragraph two/, "its own file's excerpt is still shown");
  assert.equal(srv.sessions.state(A.s), "working", "a not-applied reply keeps the lease");
});

test("a malformed or missing ticket, apply and commit (not on the agent's allow-list) and --holder of another are refused without content", async () => {
  const rf = replyFile(workA, B.batch.lease_ticket, PROBES()[1]);
  for (const args of [["reply", B.s.file, "--lease", "garbage", "--file", rf], ["reply", B.s.file, "--file", rf], ["reply", B.s.file, "--lease", "", "--file", rf]]) {
    const r = await agentCli(args, { holder: holderA, workDir: workA });
    assert.notEqual(r.code, 0, `${args.join(" ")}: ${r.all}`);
    noLeak(r, args.join(" "), [B.batch.batch_id]);
  }
  const ops = path.join(workA, "ops.json");
  fs.writeFileSync(ops, JSON.stringify({ schema: "onionskin.ops/1", ops: PROBES()[1].ops }));
  for (const args of [["apply", B.s.file, "--ops", ops, "--dry-run"], ["apply", B.s.file, "--ops", ops, "--dry-run", "--partial", "--summary"], ["apply", B.s.file, "--ops", ops, "--lease", `${B.batch.batch_id}:0123456789abcdef`], ["apply", B.s.file, "--ops", ops, "--standalone"], ["commit", B.s.file, "--from", A.s.file, "--lease", `${B.batch.batch_id}:0123456789abcdef`]]) {
    const r = await agentCli(args, { holder: holderA });
    assert.notEqual(r.code, 0, `${args.join(" ")}: ${r.all}`);
    noLeak(r, args.join(" "));
    assert.match(r.all, /only on the file it was started for/, args.join(" "));
  }
  // its own file, but as another holder
  const own = await agentCli(["apply", A.s.file, "--ops", ops, "--lease", A.batch.lease_ticket, "--holder", "h_person0001"], { holder: holderA });
  assert.notEqual(own.code, 0);
  assert.match(own.all, /--holder cannot name another holder/);
  // an ordinary caller with a wrong token: refused before any op runs on B
  const p = await agentCli(["apply", B.s.file, "--ops", ops, "--lease", `${B.batch.batch_id}:0123456789abcdef`], { holder: "h_person0001" });
  assert.notEqual(p.code, 0);
  noLeak(p, "apply with a wrong token");
  assert.ok(fs.readFileSync(B.s.file).equals(docxBytes(B_TEXT)), "B untouched");
});

test("the socket routes: /cli/batch and /cli/batch-file give nothing without the binding and the whole ticket", async () => {
  const { default: http } = await import("node:http");
  const { socketPath } = await import("../src/paths.js");
  const get = (p) => new Promise((resolve, reject) => http.get({ socketPath: socketPath(), path: p }, (res) => { let t = ""; res.on("data", (d) => (t += d)); res.on("end", () => resolve({ status: res.statusCode, text: t })); }).on("error", reject));
  const f = encodeURIComponent(B.s.file);
  for (const p of [`/cli/batch?file=${f}&holder=${holderA}`, `/cli/batch?file=${f}&holder=${holderA}&batch_id=${B.batch.batch_id}&lease_token=${B.batch.lease.token}`, `/cli/status?file=${f}&holder=${holderA}`]) {
    const r = await get(p);
    assert.equal(r.status, 403, p);
    assert.equal(JSON.parse(r.text).code, "not_your_file");
    noLeak({ all: r.text }, p, [B.batch.batch_id]);
  }
  const wrong = await get(`/cli/batch?file=${f}&holder=h_person0001&batch_id=${B.batch.batch_id}&lease_token=0123456789abcdef`);
  assert.equal(wrong.status, 409);
  noLeak({ all: wrong.text }, "wrong token");
  const right = await get(`/cli/batch?file=${f}&holder=h_person0001&batch_id=${B.batch.batch_id}&lease_token=${B.batch.lease.token}`);
  assert.equal(JSON.parse(right.text).batch.batch_id, B.batch.batch_id, "the lease holder still gets its batch");
  assert.equal(JSON.parse((await get(`/cli/batch-file?batch_id=${B.batch.batch_id}`)).text).file, null);
  assert.equal(JSON.parse((await get(`/cli/batch-file?batch_id=${B.batch.batch_id}&lease_token=0123456789abcdef`)).text).file, null);
  assert.equal(JSON.parse((await get(`/cli/batch-file?batch_id=${B.batch.batch_id}&lease_token=${B.batch.lease.token}&holder=${holderA}`)).text).file, null, "not for another file's agent");
  assert.equal(JSON.parse((await get(`/cli/batch-file?batch_id=${B.batch.batch_id}&lease_token=${B.batch.lease.token}`)).text).file, B.s.file);
});
