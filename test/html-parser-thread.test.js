// The HTML parser (vendor/parse5/parse5.mjs) runs in worker threads only: nothing the server's thread loads may import it. This walks
// the static import graph (and string-literal dynamic imports) from src/server.js and src/session.js and fails if the bundle is in it.
// A positive control first: the walker must report the bundle in a small temp graph that does reach it.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SPEC = [
  /(?:^|[\n;])\s*(?:import|export)\s[^'"`;]*?\sfrom\s*["']([^"']+)["']/g, // import x from "y", import {a,\n b} from "y", export * from "y"
  /(?:^|[\n;])\s*import\s*["']([^"']+)["']/g, // import "y"
  /\bimport\(\s*["']([^"']+)["']\s*\)/g, // import("y"): a literal dynamic import loads on the thread that runs it too
];

/** Every file reachable from `entries` through relative imports, as absolute paths. Bare and node: specifiers are left out. */
export function importGraph(entries) {
  const seen = new Set();
  const todo = entries.map((e) => path.resolve(e));
  while (todo.length) {
    const f = todo.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    if (!fs.existsSync(f)) continue;
    const src = fs.readFileSync(f, "utf8");
    for (const re of SPEC) for (const m of src.matchAll(re)) if (m[1].startsWith(".")) todo.push(path.resolve(path.dirname(f), m[1]));
  }
  return seen;
}

const BUNDLE = path.join(repo, "vendor", "parse5", "parse5.mjs");
const LOADER = path.join(repo, "src", "html-parser.js"); // the one module that imports the bundle, imported by worker entries only

test("positive control: the walker finds a bundle that a temp graph reaches through a multi-line import, a re-export and a dynamic import", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "osk-graph-"));
  try {
    fs.mkdirSync(path.join(d, "vendor"));
    fs.writeFileSync(path.join(d, "vendor", "p.mjs"), "export const x = 1;\n");
    fs.writeFileSync(path.join(d, "a.js"), 'import fs from "node:fs";\nimport {\n  b,\n  c,\n} from "./b.js";\n');
    fs.writeFileSync(path.join(d, "b.js"), 'export { c } from "./c.js";\nexport const b = 1;\n');
    fs.writeFileSync(path.join(d, "c.js"), 'export const c = () => import("./vendor/p.mjs");\n');
    fs.writeFileSync(path.join(d, "clean.js"), 'import { b } from "./b2.js";\n');
    fs.writeFileSync(path.join(d, "b2.js"), "export const b = 1;\n");
    assert.ok(importGraph([path.join(d, "a.js")]).has(path.join(d, "vendor", "p.mjs")));
    assert.ok(!importGraph([path.join(d, "clean.js")]).has(path.join(d, "vendor", "p.mjs")));
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test("the server's thread never loads the HTML parser: not from src/server.js, src/session.js or anything they import", () => {
  assert.ok(fs.existsSync(BUNDLE), "the vendored bundle is present");
  const g = importGraph([path.join(repo, "src", "server.js"), path.join(repo, "src", "session.js"), path.join(repo, "src", "cli.js")]);
  assert.ok(g.size > 40, `the graph was walked (${g.size} files)`);
  assert.ok(!g.has(BUNDLE), "vendor/parse5/parse5.mjs is reachable from the server's thread");
  assert.ok(!g.has(LOADER), "src/html-parser.js is reachable from the server's thread");
  // the modules that load the parser are worker entries only (src/worker-host.js runs them in a worker thread)
  const WORKER_ENTRIES = new Set(["anchor-worker.js", "html-parser.js", "ops-worker.js", "html-write-worker.js", "html-render-worker.js", "open-worker.js", "history-worker.js", "check-worker.js"]);
  for (const f of fs.readdirSync(path.join(repo, "src"))) if (f.endsWith(".js") && importGraph([path.join(repo, "src", f)]).has(LOADER)) assert.ok(WORKER_ENTRIES.has(f), `src/${f} loads the HTML parser but is not a worker entry`);
  // and nothing else in src imports the bundle directly: only the loader may
  for (const f of fs.readdirSync(path.join(repo, "src"))) {
    if (!f.endsWith(".js") || path.join(repo, "src", f) === LOADER) continue;
    assert.ok(!importGraph([path.join(repo, "src", f)]).has(BUNDLE) || importGraph([path.join(repo, "src", f)]).has(LOADER), `src/${f} imports the parser without the loader`);
  }
});
