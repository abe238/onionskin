// The outline Onionskin adds for an agent it started itself, for HTML files: every entry's `target` and `expect`, copied as they are into
// an op, are accepted by the op schema and by the real `onionskin reply` (the batch rule tells the agent to copy them unchanged). Every
// fixture in test/fixtures/html that opens; the batch also validates against docs/contracts/batch.schema.json. Temp dirs only.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test, before, after } from "node:test";
import { fileURLToPath } from "node:url";
import { tmpdir } from "./helpers/zipbuild.js";
import { validate } from "./helpers/schema-lite.js";

const root = tmpdir();
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE = path.join(root, "st");
process.env.ONIONSKIN_STATE_DIR = STATE;
process.env.ONIONSKIN_LEASE_MS = "60000";
process.env.ONIONSKIN_TICK_MS = "100000";
process.env.ONIONSKIN_NO_SOFFICE = "1";
delete process.env.ONIONSKIN_PYTHON;
const { startServer } = await import("../src/server.js");
const { termHolder } = await import("../src/agent-detect.js");
const { validateOps } = await import("../src/ops/schema.js");
const schema = JSON.parse(fs.readFileSync(path.join(repo, "docs", "contracts", "batch.schema.json"), "utf8"));
const FX = path.join(repo, "test", "fixtures", "html");

let srv;
before(async () => {
  srv = await startServer();
});
after(() => {
  srv?.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

let n = 0;
const S = () => srv.sessions;
function reply(file, batch, holder, body, flags = []) {
  const W = fs.realpathSync(fs.mkdtempSync(path.join(root, "w-")));
  const rf = path.join(W, `reply-${batch.batch_id}.json`);
  fs.writeFileSync(rf, JSON.stringify(body));
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(repo, "src", "cli.js"), "reply", file, "--lease", batch.lease_ticket, "--file", rf, ...flags], { env: { PATH: process.env.PATH, HOME: root, ONIONSKIN_STATE_DIR: STATE, ONIONSKIN_NO_SOFFICE: "1", ONIONSKIN_HOLDER: holder, ONIONSKIN_AGENT_DIR: W }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    c.stdout.on("data", (d) => (stdout += d));
    c.on("close", (code) => resolve({ code, json: (() => { try { return JSON.parse(stdout.split("\n")[0]); } catch { return null; } })(), stdout }));
  });
}
/** A note-only Send delivered to Onionskin's own (terminal) agent, or null when the file does not open. */
async function deliver(name) {
  const f = path.join(root, `h${++n}-${name}`);
  fs.copyFileSync(path.join(FX, name), f);
  const file = fs.realpathSync(f);
  let s;
  try {
    s = await S().openAsync(file);
  } catch {
    return null; // refused at open (encoding, limits): nothing to outline
  }
  const holder = termHolder(s.key);
  const p = S().poll(s.key, { holder });
  await S().sendAsync(s.key, { baseSha: s.baseSha, comments: [], note: "Give every part a title." });
  return { file, holder, batch: await p.promise };
}

// about 50 real replies: measured 4 s alone, over a minute on a machine at a load average of 40
test("html: every outline target, copied as it is, is one form the op schema takes, and the real reply accepts the ops built from them", { timeout: 600_000 }, async () => {
  const names = fs.readdirSync(FX).filter((f) => /\.html?$/.test(f)).sort();
  let files = 0;
  let entries = 0;
  const refused = {};
  for (const name of names) {
    const d = await deliver(name);
    if (!d) continue;
    const ev = d.batch.untrusted_document_evidence;
    validate(d.batch, schema, schema, "$");
    assert.equal(d.batch.format, "html", name);
    const out = (ev.outline || []).filter((x) => x.target);
    if (!out.length) continue;
    files++;
    for (const e of out) {
      assert.equal(Object.keys(e.target).length, 1, `${name}: one addressing form: ${JSON.stringify(e.target)}`);
      for (const op of [
        { op: "set_attribute", id: "overall", target: e.target, expect: e.expect, name: "title", value: "Part" },
        { op: "replace_text", id: "overall", target: e.target, expect: e.expect, find: "x", replace: "y" },
      ]) {
        const v = validateOps({ schema: "onionskin.ops/1", ops: [op] });
        assert.deepEqual(v, { ok: true, errors: [] }, `${name}: ${JSON.stringify(op.target)}`);
      }
    }
    // the real reply, every entry at once: a title on each part
    const ops = out.map((e, i) => ({ op: "set_attribute", id: "overall", target: e.target, expect: e.expect, name: "title", value: `Part ${i}` }));
    // --partial: an op the page's content refuses is told and the rest written; what must never come back is a target or an expect that
    // does not find its element
    // a control: one op whose target finds nothing must come back in the list this filters
    const control = { op: "set_attribute", id: "overall", target: { path: "/html[1]/body[1]/nosuch[9]" }, expect: { quote: "" }, name: "title", value: "Nope" };
    const r = await reply(d.file, d.batch, d.holder, { summary: "Titled every part.", replies: [], ops: [...ops, control] }, ["--partial"]);
    assert.ok(r.json, `${name}: ${r.stdout.slice(0, 300)}`);
    // --partial: the ops not written are in not_applied, each with its status (the refusal code)
    // (all of them in `problems`, exit 3, when none was written: a page whose parts are all SVG)
    const problems = (r.json.not_applied || r.json.problems || []).map((p) => ({ ...p, code: p.code || p.status }));
    assert.equal(r.code, r.json.written === false ? 3 : 0, `${name}: ${r.stdout.slice(0, 600)}`);
    assert.deepEqual(problems.filter((p) => p.code === "anchor_not_found").length, 1, `${name}: the control is told: ${r.stdout.slice(0, 600)}`);
    // refused by the page's content, not by the target: an implied element or an SVG one (not_addressable), an element outside the write
    // allowlist such as a textarea or an option (active_content), a misnested <b>/<i> whose attributes the parser copies onto its clones
    // (proof_failed). A target or expect that finds nothing (anchor_not_found, expect_mismatch) is never one of them.
    const wrong = problems.filter((p) => !["not_addressable", "active_content", "proof_failed", "anchor_not_found"].includes(p.code));
    assert.deepEqual(wrong, [], `${name}: ${r.stdout.slice(0, 600)}`);
    // what was written: one title per op that was not refused
    const titled = (fs.readFileSync(d.file, "utf8").match(/\btitle\s*=\s*["']?Part \d+/gi) || []).length;
    const notWritten = problems.length - 1;
    assert.equal(titled, ops.length - notWritten, `${name}: ${titled} titles written for ${ops.length} ops, ${notWritten} refused`);
    for (const p of problems) if (p.code !== "anchor_not_found") refused[p.code] = (refused[p.code] || 0) + 1;
    entries += out.length;
  }
  assert.ok(files >= 20 && entries >= 200, `${files} files, ${entries} entries`);
  console.log(`# ${files} files, ${entries} outline entries, refused by the page's content (not by their target): ${JSON.stringify(refused)}`);
  const nRefused = Object.values(refused).reduce((a, b) => a + b, 0);
  assert.ok(nRefused < entries * 0.15, `most ops were written: ${nRefused} of ${entries} refused`);
});
