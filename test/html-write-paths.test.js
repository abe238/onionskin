// Every path that can write a file, read from the source (in the spirit of test/html-parser-thread.test.js): an HTML file reaches the
// guarded write (src/fsutil.js replaceGuarded) only through its write check (src/html-write.js checkedHtmlWrite, in a worker), or a path
// refuses HTML outright. The check of the behavior itself is in test/html-write.test.js; this one fails when a new caller appears.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (f) => fs.readFileSync(path.join(repo, "src", f), "utf8");
/** The body of a class method (two-space indent) or a top-level function, from its first line to its closing brace. */
function body(text, name, { method = true } = {}) {
  const lines = text.split("\n");
  const head = method ? new RegExp(`^  (?:async )?${name.replace(/[#$]/g, "\\$&")}\\(`) : new RegExp(`^(?:export )?(?:async )?function ${name}\\(`);
  const start = lines.findIndex((l) => head.test(l));
  assert.ok(start >= 0, `${name} is defined`);
  const end = lines.findIndex((l, i) => i > start && (method ? /^  \}$/ : /^\}$/).test(l));
  return lines.slice(start, end + 1).join("\n");
}
/** The names of the class methods (two-space indent) and top-level functions whose bodies contain `needle`, once per line that does. */
function callers(text, needle) {
  const out = [];
  let cur = null;
  for (const l of text.split("\n")) {
    const m = /^  (?:async |static |get )?(#?[A-Za-z_$][\w$]*)\(.*\{\s*$/.exec(l) || /^(?:export )?(?:async )?function ([A-Za-z_$][\w$]*)\(/.exec(l);
    if (m) cur = m[1];
    if (l.includes(needle) && !/^\s*(\/\/|\*)/.test(l)) out.push(cur);
  }
  return out;
}

test("positive control: the extractors see a guarded write in a temp class and a function", () => {
  const t = "class X {\n  #replace(s) {\n    return replaceGuarded(s);\n  }\n  agentWrite(k) {\n    this.#replace(k, { htmlChecked });\n  }\n}\nfunction w() {\n  replaceGuarded(1);\n}\n";
  assert.deepEqual(callers(t, "replaceGuarded("), ["#replace", "w"]);
  assert.deepEqual(callers(t, "this.#replace("), ["agentWrite"]);
  assert.match(body(t, "#replace"), /replaceGuarded/);
});

test("only src/session.js and src/apply.js call the guarded write, each from one place", () => {
  const users = fs.readdirSync(path.join(repo, "src"), { recursive: true }).filter((f) => f.endsWith(".js") && f !== "fsutil.js" && /\b(replaceGuarded|atomicReplace)\(/.test(src(f)));
  assert.deepEqual(users.sort(), ["apply.js", "session.js"]);
  assert.deepEqual(callers(src("session.js"), "replaceGuarded("), ["#replace"]);
  assert.deepEqual(callers(src("apply.js"), "replaceGuarded("), ["standaloneWrite"]);
});

test("src/session.js: #replace refuses HTML bytes without a check of exactly those bytes; every caller either passes one made after the write check in a worker, restores a snapshot by identity, or refuses HTML", () => {
  const s = src("session.js");
  const replace = body(s, "#replace");
  const guard = replace.indexOf('s.format === "html" && htmlChecked?.to !== sha256(bytes)');
  assert.ok(guard > 0 && guard < replace.indexOf("replaceGuarded("), "the guard comes before the write");
  // every caller of #replace. A new caller fails here: decide its check.
  const calls = callers(s, "this.#replace(");
  assert.deepEqual([...new Set(calls)].sort(), ["#takePage", "agentWrite", "mergeUserEdits", "revert"].sort(), `callers: ${calls}`);
  const lines = s.split("\n").filter((l) => l.includes("this.#replace("));
  assert.deepEqual(lines.filter((l) => l.includes("htmlChecked")).length, 3, "all but mergeUserEdits hand a check on");
  // mergeUserEdits refuses an HTML file before anything else reads it (its view is read only during a run, D5)
  const merge = body(s, "mergeUserEdits");
  assert.ok(merge.indexOf('if (s.format === "html") throw') > 0 && merge.indexOf('if (s.format === "html") throw') < merge.indexOf("this.#replace("));
  const aw = body(s, "agentWrite");
  assert.match(aw, /if \(s\.format === "html"\) \{\s*\/\/[^\n]*\n\s*if \(htmlChecked\?\.to !== newSha\) throw/);
  assert.match(aw, /s\.format === "html" && htmlChecked\.from !== diskSha\) throw this\.#outsideChange/, "the compare-and-swap after the await");
  // a token is made only right after the write check's answer (agentWriteChecked, a Send's edits) ...
  for (const [name, made] of [["agentWriteChecked", "htmlChecked: { from: sha256(disk), to: sha256(c.bytes) }"], ["#htmlSendWork", "htmlChecked: { from: diskSha, to: target.sha }"]]) {
    const b = body(s, name);
    const check = Math.max(b.indexOf("await htmlWriteOffThread("), name === "agentWriteChecked" ? b.indexOf("await check({ before: disk, after: args.bytes })") : -1);
    assert.ok(check > 0 && check < b.indexOf(made), `${name}: the check runs before the token is made`);
    assert.ok(b.indexOf("if (!c.ok)") > check && b.indexOf("if (!c.ok)") < b.indexOf(made), `${name}: a refusal stops it`);
  }
  // ... or by identity in revert: the stored bytes hash to the run's preSha (never the inventory: undoing a run that removed a script)
  const rv = body(s, "revert");
  assert.ok(rv.indexOf("if (sha256(pre) !== entry.preSha) throw") > 0 && rv.indexOf("if (sha256(pre) !== entry.preSha) throw") < rv.indexOf("htmlChecked = { from: entry.postSha, to: entry.preSha }"));
  assert.equal(s.split("htmlChecked: {").length - 1, 2, "no other place makes a token");
  // #takePage writes a Send's bytes only with the token #htmlSendWork made, and compares the disk with what it checked against
  const tp = body(s, "#takePage");
  assert.match(tp, /htmlChecked && htmlChecked\.from !== diskSha/);
  assert.match(tp, /if \(htmlChecked\?\.to !== sha256\(payload\.bytes\)\) throw/);
});

test("src/server.js and src/local.js: the agent-write and commit routes call agentWriteChecked, never agentWrite", () => {
  for (const f of ["server.js", "local.js"]) {
    const t = src(f);
    assert.ok(!/\.agentWrite\(/.test(t), `${f} calls agentWrite directly`);
  }
  const server = src("server.js");
  for (const route of ["/cli/agent-write", "/cli/commit"]) {
    const at = server.indexOf(`p === "${route}"`);
    const next = server.indexOf("if (req.method", at + 1);
    assert.match(server.slice(at, next), /await sessions\.agentWriteChecked\(/, route);
  }
  assert.match(src("local.js"), /POST \/cli\/agent-write[\s\S]{0,400}sessions\.agentWriteChecked\(/);
});

test("src/apply.js: a standalone write of an HTML file carries checked bytes (ops: the driver's finish; commit: the worker's check)", () => {
  const a = src("apply.js");
  assert.deepEqual(callers(a, "standaloneWrite(").filter((x) => x !== "standaloneWrite"), ["applyCommand", "commitCommand"]);
  const commit = body(a, "commitCommand", { method: false });
  const check = commit.indexOf("await check({ before: disk, after: candidate })");
  assert.ok(check > 0 && check < commit.indexOf("standaloneWrite("), "a standalone commit is checked before it is written");
  // the check is the worker's unless a test injects one: its default, and no caller in src passes another
  assert.match(a, /export async function commitCommand\(rest, server, \{ check = htmlWriteOffThread \} = \{\}\)/);
  assert.match(src("session.js"), /async agentWriteChecked\(key, args, check = htmlWriteOffThread\)/);
  assert.match(src("cli.js"), /commitCommand\)\(argv\.slice\(1\), \{ healthy, req, json \}\)/);
  for (const f of ["server.js", "local.js"]) {
    const calls = src(f).split("\n").filter((l) => l.includes("agentWriteChecked("));
    assert.ok(calls.length > 0 && calls.every((l) => /\.\.\.leaseOf\(body\) \}\)/.test(l)), `${f}: the routes pass their one argument object, no check of their own`);
  }
  assert.match(commit, /standaloneWrite\(real, disk, out,/, "and writes the checked bytes");
  // apply writes what runOps returns; for HTML that is the driver's finish, which ends in the write check
  const run = src(path.join("ops", "run.js"));
  assert.match(run, /if \(driver\.finish\) return await driver\.finish\(st, results, \{ partial \}\);/);
  const fin = body(src(path.join("ops", "html.js")), "finish", { method: false });
  assert.ok(fin.indexOf("checkedHtmlWrite(") > fin.indexOf("proveEdits("), "the driver proves, then checks");
  assert.match(fin, /return done\(c\.bytes/, "and returns only the checked bytes");
});
