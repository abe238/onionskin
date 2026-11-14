import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseApplyArgs, parseCommitArgs } from "../src/apply.js";
import { parseReplyArgs } from "../src/reply.js";
import { FLAGS, parseArgs, parseConfigArgs } from "../src/cli.js";
import { parseSetupArgs } from "../src/setup.js";
import { validateOps } from "../src/ops/schema.js";

// The skill files are read by an agent that will type what they say. Every command, flag, op and batch field they name must exist in the code.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillDir = path.join(repo, "skills", "onionskin");
const files = [path.join(skillDir, "SKILL.md"), ...fs.readdirSync(path.join(skillDir, "reference")).map((f) => path.join(skillDir, "reference", f))];
const read = (f) => fs.readFileSync(f, "utf8");
const all = files.map((f) => ({ f: path.relative(repo, f), text: read(f) }));
const schema = (n) => JSON.parse(read(path.join(repo, "docs", "contracts", n)));

test("the skill has valid frontmatter and stays focused", () => {
  const skill = read(files[0]);
  const m = skill.match(/^---\nname: (.+)\ndescription: (.+)\n---\n/);
  assert.ok(m, "frontmatter with name and description");
  assert.equal(m[1], "onionskin");
  assert.match(m[2], /\/onionskin <file>/);
  for (const w of [".docx", ".xlsx", ".pptx"]) assert.ok(m[2].includes(w), w);
  assert.ok(skill.split("\n").length < 250, "SKILL.md under 250 lines");
  for (const { f, text } of all) {
    assert.ok(!text.includes("—"), `${f}: no em dashes`);
    for (const link of text.matchAll(/`(reference\/[a-z-]+\.md)`/g)) assert.ok(fs.existsSync(path.join(skillDir, link[1])), `${f}: ${link[1]} exists`);
  }
  for (const r of ["reference/ops.md", "reference/batch.md", "reference/troubleshooting.md"]) assert.ok(skill.includes(r), `SKILL.md links ${r}`);
});

/** `onionskin <subcommand> ...flags` on one line of a code span or block */
function commandLines() {
  const out = [];
  for (const { f, text } of all) {
    for (const line of text.split("\n")) {
      for (const span of [...line.matchAll(/`([^`]*\bonionskin [^`]*)`/g)].map((m) => m[1]).concat(/^\s{2,}onionskin |^onionskin /.test(line) ? [line.trim()] : [])) {
        const m = span.match(/\bonionskin (--?[\w-]+|[\w-]+)((?:\s+(?:--?[\w-]+|<[^>]+>|\[[^\]]*\]|[\w./-]+))*)/);
        if (m) out.push({ f, sub: m[1], rest: m[2].trim().split(/\s+/).filter(Boolean), span });
      }
    }
  }
  return out;
}

const TICKET = "b_0123456789ab:0123456789abcdef";
const VALUE_FLAGS = ["--slide", "--timeout", "--ops", "--results", "--batch", "--holder", "--lease", "--from", "--base", "--image", "--strength", "--json", "--file"];
function accepts(sub, flag, withValue) {
  if (sub === "doctor") withValue = false; // doctor's --json is a switch; reply's takes a value
  const argv = withValue ? [flag, flag === "--lease" ? TICKET : flag === "--base" ? "a".repeat(64) : flag === "--image" ? "bg.png" : flag === "--json" ? "{}" : flag === "--file" ? "r.json" : "5"] : [flag];
  if (sub === "config") return parseConfigArgs(["background", ...(flag === "--image" ? [] : ["--image", "bg.png"]), ...argv]);
  if (sub === "commit") return parseCommitArgs(["file.docx", ...(flag === "--from" ? [] : ["--from", "c.docx"]), ...argv]);
  if (sub === "apply") return parseApplyArgs(["file.docx", "--ops", "o.json", ...argv]);
  if (sub === "setup") return parseSetupArgs(argv);
  if (sub === "reply") return parseReplyArgs(["file.docx", ...(flag === "--timeout" ? ["--then-poll"] : []), ...argv]);
  if (sub === "done") return parseArgs([sub, "f.docx", "--results", "r.json", ...argv]);
  return parseArgs([sub, "f.docx", ...argv]);
}

test("every `onionskin <subcommand>` and flag in the skill files is accepted by the CLI", () => {
  const lines = commandLines();
  assert.ok(lines.length >= 12, `found ${lines.length} command mentions`);
  const subs = new Set(lines.map((l) => l.sub));
  for (const must of ["open", "poll", "status", "done", "apply", "commit", "setup-checker"]) assert.ok(subs.has(must), `the docs show \`${must}\``);
  const help = fs.readFileSync(path.join(repo, "src", "cli.js"), "utf8");
  for (const { f, sub, rest, span } of lines) {
    if (sub.startsWith("-")) {
      assert.ok(["--version", "--help"].includes(sub), `${f}: ${span}`);
      continue;
    }
    assert.ok(sub in FLAGS, `${f}: unknown subcommand \`${sub}\` in: ${span}`);
    assert.ok(help.includes(`\${BIN} ${sub}`), `${sub} is in the CLI help`);
    for (const flag of rest.filter((t) => t.startsWith("--"))) {
      assert.ok(FLAGS[sub].includes(flag), `${f}: \`${sub}\` has no ${flag} (in: ${span})`);
      assert.doesNotThrow(() => accepts(sub, flag, VALUE_FLAGS.includes(flag)), `${f}: ${sub} ${flag}`);
    }
  }
  // the doc table and the parsers agree for every flag the CLI knows
  for (const [sub, flags] of Object.entries(FLAGS)) for (const flag of flags) assert.doesNotThrow(() => accepts(sub, flag, VALUE_FLAGS.includes(flag)), `${sub} ${flag}`);
  assert.throws(() => parseArgs(["open", "f.docx", "--ack"]), /unknown option/, "flags are per subcommand");
});

test("flags named in prose (`--dry-run`, `--timeout <secs>` ...) belong to some subcommand", () => {
  const known = new Set(Object.values(FLAGS).flat().concat(["--version", "--help"]));
  const env = new Set(["--no-open"]);
  for (const { f, text } of all) for (const m of text.matchAll(/`(--[a-z][\w-]*)/g)) assert.ok(known.has(m[1]) || env.has(m[1]), `${f}: ${m[1]} is not a flag of any subcommand`);
});

test("ops: every op named in the docs is in ops.schema.json and every schema op is documented with a worked or described entry", () => {
  const s = schema("ops.schema.json");
  const schemaOps = new Set(s.$defs && Object.values(s.$defs).filter((d) => d.properties?.op?.const).map((d) => d.properties.op.const));
  assert.ok(schemaOps.size >= 19);
  const fromOneOf = new Set(s.properties.ops.items.oneOf.map((r) => s.$defs[r.$ref.split("/").pop()].properties.op.const));
  assert.deepEqual([...fromOneOf].sort(), [...schemaOps].sort(), "every op definition is in the oneOf");
  const ref = read(path.join(skillDir, "reference", "ops.md"));
  const headings = new Set([...ref.matchAll(/^### ([a-z_]+)$/gm)].map((m) => m[1]));
  assert.deepEqual([...headings].sort(), [...schemaOps].sort(), "ops.md has one heading per schema op");
  const used = new Set();
  for (const { text } of all) for (const m of text.matchAll(/"op":\s*"([a-z_]+)"/g)) used.add(m[1]);
  for (const o of used) assert.ok(schemaOps.has(o), `example uses unknown op ${o}`);
  for (const { f, text } of all) for (const m of text.matchAll(/`((?:insert|delete|replace|set|format|add|rename)_[a-z_]+)`/g)) assert.ok(schemaOps.has(m[1]) || ["set_table_cell_text"].includes(m[1]), `${f}: \`${m[1]}\` is not an op`);
  // one worked example per format
  const examples = [...ref.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1]));
  assert.ok(examples.length >= 3);
  const formats = new Set();
  for (const ex of examples) {
    const v = validateOps(ex);
    assert.ok(v.ok, `worked example does not validate: ${JSON.stringify(v.errors)}`);
    for (const op of ex.ops) formats.add(["set_cells", "format_cells"].includes(op.op) ? "xlsx" : op.op.endsWith("_in_shape") || op.op === "set_shape_text" ? "pptx" : "docx");
  }
  assert.deepEqual([...formats].sort(), ["docx", "pptx", "xlsx"]);
});

test("batch: every field path named in the docs exists in batch.schema.json, and every top-level field is documented", () => {
  const s = schema("batch.schema.json");
  const step = (node, key) => {
    if (!node) return null;
    if (key === "[]") return node.items || null;
    return node.properties?.[key] || null;
  };
  const resolve = (p) => p.replace(/\[\]/g, ".[]").split(".").reduce((n, k) => step(n, k), s);
  const top = new Set(Object.keys(s.properties));
  const seen = new Set();
  for (const { f, text } of all) {
    for (const m of text.matchAll(/`([a-z_]+(?:\[\])?(?:\.[a-z_]+(?:\[\])?)*)`/g)) {
      const p = m[1];
      if (!top.has(p.split(/[.[]/)[0]) || p.split(/[.[]/)[0] === "schema" && !p.includes(".")) continue;
      assert.ok(resolve(p), `${f}: batch field \`${p}\` does not exist in batch.schema.json`);
      seen.add(p.split(/[.[]/)[0]);
    }
  }
  // locators are written as `.locator.x` continuations in batch.md: check each against the schema's locator
  const batchMd = read(path.join(skillDir, "reference", "batch.md"));
  const locator = resolve("untrusted_document_evidence.anchors[].locator").properties;
  for (const m of batchMd.matchAll(/`\.(?:locator\.)?([a-z_]+)`|`\.locator\.([a-z_]+)`|`untrusted_document_evidence\.anchors\[\]\.locator\.([a-z_]+)`/g)) {
    const k = m[1] || m[2] || m[3];
    assert.ok(locator[k] || ["locator"].includes(k), `locator field ${k}`);
  }
  for (const m of batchMd.matchAll(/`\.locator\.([a-z_]+)`/g)) assert.ok(locator[m[1]], `locator field ${m[1]}`);
  for (const t of top) assert.ok(batchMd.includes(`\`${t}\``), `reference/batch.md documents top-level \`${t}\``);
  assert.deepEqual([...top].sort(), [...Object.keys(s.properties)].sort());
  // the field paths used in the batch table cover every property of the evidence anchors
  const anchorProps = Object.keys(resolve("untrusted_document_evidence.anchors[]").properties);
  for (const k of anchorProps) assert.ok(batchMd.includes(`untrusted_document_evidence.anchors[].${k}`), `anchors[].${k} is documented`);
  for (const k of Object.keys(resolve("instructions.comments[]").properties)) assert.ok(batchMd.includes(`instructions.comments[].${k}`), `comments[].${k} is documented`);
  for (const k of Object.keys(resolve("untrusted_document_evidence.user_edits[]").properties)) assert.ok(batchMd.includes(`user_edits[].${k}`), `user_edits[].${k} is documented`);
});

test("result and status words in the docs match the code", async () => {
  const { APPLY_EXIT } = await import("../src/apply.js");
  assert.deepEqual(APPLY_EXIT, { ok: 0, error: 1, invalid: 2, not_applied: 3, partial: 4, write_refused: 5 });
  const skill = read(files[0]);
  for (const code of ["applied", "anchor_not_found", "expect_mismatch", "skipped_protected", "refused", "not_applied"]) assert.ok(skill.includes(`\`${code}\``), code);
  const { summarize } = await import("../src/ops/run.js");
  for (const code of Object.keys(summarize([]))) assert.ok(skill.includes(`\`${code}\``), `SKILL.md covers ${code}`);
  for (const state of ["idle", "listening", "working", "queued", "stranded", "closed"]) assert.ok(skill.includes(`\`${state}\``), state);
});

test("lease and delivery words in the docs match the code: error codes, the `lease` batch field, `--lease`, `lease_token`, `batch_id`", () => {
  const src = ["session.js", "server.js", "cli.js", "apply.js", "lease.js"].map((n) => read(path.join(repo, "src", n))).join("\n");
  const docs = all.map((d) => d.text).join("\n") + read(path.join(repo, "docs", "contracts", "routes.md"));
  // every `## <status> <code>` heading of the troubleshooting page names a code the server really sends
  const troubleshooting = read(path.join(skillDir, "reference", "troubleshooting.md"));
  const codes = [...troubleshooting.matchAll(/^## (\d{3}) ([a-z_]+)/gm)].map((m) => m[2]);
  assert.ok(codes.includes("stale_batch") && codes.includes("not_lease_holder"), `codes: ${codes}`);
  for (const code of codes) assert.ok(src.includes(`"${code}"`), `${code} is sent by the code`);
  assert.ok(src.includes('"missing_lease"') && docs.includes("missing_lease"), "missing_lease is documented and sent");
  for (const word of ["lease_token", "batch_id", "stale_batch", "--lease"]) assert.ok(docs.includes(word), `${word} is documented`);
  assert.ok(src.includes("lease_token") && src.includes("batch_id"), "the CLI and server use both fields");
  assert.ok(Object.keys(schema("batch.schema.json").properties).includes("lease"), "the batch schema has `lease`");
});

test("every `apply` (without --dry-run), `commit` and `done` example in the skill files shows --lease; the new fields and flags are documented", () => {
  let checked = 0;
  for (const { f, sub, rest, span } of commandLines()) {
    if (!["apply", "commit", "done"].includes(sub) || span.includes("`")) continue;
    if (sub === "apply" && rest.includes("--dry-run")) continue; // a dry run writes nothing and needs no ticket
    // a prose mention such as "`onionskin apply`" has no file argument: only full examples are checked
    if (!rest.some((t) => /\.(docx|xlsx|pptx)$/.test(t) || t === "<file>")) continue;
    checked++;
    assert.ok(rest.includes("--lease"), `${f}: this example needs --lease: ${span}`);
  }
  assert.ok(checked >= 5, `checked ${checked} examples`);
  const docs = all.map((d) => d.text).join("\n");
  for (const word of ["lease_ticket", "protected_reason", "cell_types", "number_formats", "would_write", "would_write_partial", "--summary", "onionskin shapes", "FIRST in the ops file"]) assert.ok(docs.includes(word), `${word} is documented`);
  const ops = read(path.join(repo, "src", "apply.js"));
  assert.ok(ops.includes("would_write_partial"));
});

test("the skill tells the agent, near the top, to use the full location when `onionskin` is not on the PATH", () => {
  const top = read(files[0]).split("\n").slice(0, 12).join("\n");
  assert.match(top, /`onionskin` when `command -v onionskin` finds it, otherwise by its full location `~\/\.local\/bin\/onionskin`/);
  assert.ok(!/Needs `onionskin` on PATH/.test(read(files[0])), "the old 'needs it on PATH' rule is gone");
});

test("README.md and AGENTS.md agent blocks no longer send the agent or the person to edit the PATH, and still relay the one sentence", () => {
  for (const f of ["README.md", "AGENTS.md"]) {
    const t = read(path.join(repo, f));
    assert.ok(!/One more step/.test(t), `${f} still names a "One more step" PATH instruction`);
    assert.match(t, /tell the person exactly this and nothing else/i, `${f} keeps the one-sentence instruction`);
  }
});
