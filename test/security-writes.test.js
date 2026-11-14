// Security pass: write protections of the session (findings 2, 3, 4).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, after } from "node:test";
import { tmpdir, docxBytes } from "./helpers/zipbuild.js";

const root = tmpdir();
process.env.ONIONSKIN_STATE_DIR = path.join(root, "st");
process.env.ONIONSKIN_LEASE_MS = "60000";
delete process.env.ONIONSKIN_PYTHON;
process.env.ONIONSKIN_NO_SOFFICE = "1";
const { Sessions, HttpError } = await import("../src/session.js");
const { hooks, sha256 } = await import("../src/fsutil.js");
const { ensureStateDir } = await import("../src/paths.js");
ensureStateDir();
after(() => fs.rmSync(root, { recursive: true, force: true }));

const paras = Array.from({ length: 6 }, (_, i) => `Paragraph ${i + 1}: some real sentence number ${i * 5 + 3} for the write tests.`);
const comment = (id, i) => ({ id, kind: "element", text: "fix", anchor: { location: { blockPath: [i] }, paraText: paras[i] } });
let n = 0;
const rejects = (fn, status, code) => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof HttpError, String(e));
    assert.equal(e.status, status, e.message);
    if (code) assert.equal(e.extra.code, code);
    return e;
  }
  assert.fail("expected HttpError");
};
/** A session with a delivered batch: returns {S, s, file, claim, batch}. */
async function delivered(text = paras) {
  const S = new Sessions();
  const file = path.join(root, `w${++n}.docx`);
  fs.writeFileSync(file, docxBytes(text));
  const real = fs.realpathSync(file);
  const s = S.open(real);
  const poll = S.poll(s.key, { holder: "A" });
  S.send(s.key, { baseSha: s.baseSha, comments: [comment("c1", 1)], note: "" });
  const batch = await poll.promise;
  return { S, s, file: real, batch, claim: { holder: "A", token: batch.lease.token, batchId: batch.batch_id } };
}

test("finding 3: an external save between the compare and the rename is snapshotted and the agent write is refused with the conflict code", async () => {
  const { S, s, file, claim } = await delivered();
  const base = sha256(fs.readFileSync(file));
  const external = docxBytes(["edited elsewhere while the agent was writing"]);
  hooks.beforeRename = () => fs.writeFileSync(file, external);
  try {
    const e = rejects(() => S.agentWrite(s.key, { baseSha: base, bytes: docxBytes(["agent version"]), ...claim }), 409, "conflict");
    assert.equal(e.extra.diskSha, sha256(external));
  } finally {
    hooks.beforeRename = null;
  }
  assert.ok(fs.readFileSync(file).equals(external), "the newer bytes were not overwritten");
  assert.ok(s.snapshots.has(sha256(external)), "and are kept in a snapshot");
  assert.deepEqual(fs.readdirSync(root).filter((x) => x.endsWith(".tmp") || x.endsWith(".lock")), []);
});

test("finding 3: the same race on Send", async () => {
  const S = new Sessions();
  const file = path.join(root, `w${++n}.docx`);
  fs.writeFileSync(file, docxBytes(paras));
  const real = fs.realpathSync(file);
  const s = S.open(real);
  const external = docxBytes(["saved by another editor"]);
  hooks.beforeRename = () => fs.writeFileSync(real, external);
  try {
    rejects(() => S.send(s.key, { baseSha: s.baseSha, bytes: docxBytes(["page version"]), comments: [], note: "" }), 409, "conflict");
  } finally {
    hooks.beforeRename = null;
  }
  assert.ok(fs.readFileSync(real).equals(external));
  assert.ok(s.snapshots.has(sha256(external)));
});

test("finding 3: two agent writes from the same base, exactly one wins", async () => {
  const { S, s, file, claim } = await delivered();
  const base = sha256(fs.readFileSync(file));
  const results = await Promise.all(
    [docxBytes(["writer one"]), docxBytes(["writer two"])].map(
      (bytes) => new Promise((resolve) => setImmediate(() => { try { resolve({ ok: S.agentWrite(s.key, { baseSha: base, bytes, ...claim }) }); } catch (e) { resolve({ err: e }); } }))
    )
  );
  assert.equal(results.filter((r) => r.ok).length, 1, "one write landed");
  const lost = results.find((r) => r.err);
  assert.equal(lost.err.status, 409);
  assert.equal(lost.err.extra.code, "conflict");
});
