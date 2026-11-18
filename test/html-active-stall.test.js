// urlKind and cssPlain (src/html-active.js) run on every write of an HTML file, inside the inventory: their time must be linear in the
// input. A 40,000-space run took them 0.86 s and 1.3 s before (500,000 ran for minutes): a regex that tried every start in a run. Each
// shape here, at 2,000,000 characters, must finish in under 100 ms of this thread's CPU, with the answer it gives on short input. Also the
// value-to-source map of the HTML ops (src/html-write.js sourceMap), which finds the length of a character reference.
import assert from "node:assert/strict";
import { test } from "node:test";
import "../src/html-parser.js";
import { cssPlain, urlKind } from "../src/html-active.js";
import { runOps } from "../src/ops/run.js";

const N = 2_000_000;
function cpuMs(fn) {
  const t0 = process.threadCpuUsage();
  const r = fn();
  const t = process.threadCpuUsage(t0);
  return { r, ms: (t.user + t.system) / 1000 };
}
const within = (name, fn, max = 100) => {
  const { r, ms } = cpuMs(fn);
  assert.ok(ms < max, `${name}: ${ms.toFixed(1)} ms of CPU`);
  return r;
};

test("urlKind: linear in a long whitespace run (inside, at the edges) and in long runs of one character", () => {
  const ws = " ".repeat(N);
  assert.equal(within("spaces then a path", () => urlKind(`${ws}a.png`)), "relative");
  assert.equal(within("a path then spaces", () => urlKind(`a.png${ws}`)), "relative");
  assert.equal(within("spaces inside", () => urlKind(`a${ws}b`)), "relative");
  assert.equal(within("tabs and newlines inside", () => urlKind(`a${"\t\n".repeat(N / 2)}b`)), "other");
  assert.equal(within("only whitespace", () => urlKind(ws)), "fragment");
  assert.equal(within("one letter", () => urlKind("a".repeat(N))), "relative");
  assert.equal(within("a scheme of one letter", () => urlKind(`${"a".repeat(N)}:x`)), "other");
  assert.equal(within("slashes", () => urlKind("/".repeat(N))), "other");
  assert.equal(within("backslashes", () => urlKind("\\".repeat(N))), "other");
  assert.equal(within("parentheses", () => urlKind("(".repeat(N))), "relative");
  assert.equal(within("a data image with many parameters", () => urlKind(`data:image/png${";a=b".repeat(N / 4)},x`)), "data-image");
  // short input: the same answers as before
  assert.deepEqual([" https://x.example/a ", "\n#top", "", "//evil.example", "javascript:x", "a\\b", "mailto:a@b", "pic.png", "data:image/png;base64,AA", "data:text/html,x"].map(urlKind), ["https", "fragment", "fragment", "other", "other", "other", "mailto", "relative", "data-image", "other"]);
});

test("cssPlain: linear in a long whitespace run after url( (closed or not) and in long runs of one character", () => {
  const ws = " ".repeat(N);
  assert.deepEqual(within("url( and spaces, never closed", () => cssPlain(`a{background:url(${ws}`)), { ok: false, loads: [] });
  assert.deepEqual(within("url( and spaces, then a path", () => cssPlain(`a{background:url(${ws}x.png`)), { ok: false, loads: [] });
  assert.deepEqual(within("url( spaces path spaces )", () => cssPlain(`a{background:url(${ws}x.png${ws})}`)), { ok: true, loads: ["x.png"] });
  assert.deepEqual(within("url( quoted, spaces inside", () => cssPlain(`a{background:url("x${ws}y.png")}`)), { ok: true, loads: [`x${ws}y.png`] }, "the value as written; urlKind reads it as relative");
  assert.deepEqual(within("spaces before (", () => cssPlain(`a{background:url${ws}(x.png)}`)), { ok: false, loads: [] });
  assert.equal(within("many url(", () => cssPlain("url(".repeat(N / 4))).ok, false);
  assert.equal(within("many url( quoted", () => cssPlain("url('".repeat(N / 5))).ok, false);
  assert.equal(within("one letter", () => cssPlain("a".repeat(N))).ok, true);
  assert.equal(within("parentheses", () => cssPlain("(".repeat(N))).ok, true);
  assert.equal(within("slashes", () => cssPlain("/".repeat(N))).ok, true);
  assert.equal(within("backslashes", () => cssPlain("\\".repeat(N))).ok, false);
  assert.equal(within("spaces before a src(", () => cssPlain(`src${ws}(`)).ok, false);
  assert.equal(within("only spaces", () => cssPlain(ws)).ok, true);
  // short input: the same answers as before
  const short = ['p{margin:0}', 'a{background:url(x.png)}', "a{background:url( 'img/a.png' )}", 'a{background:URL("https://x.example/a.png")}', "a{background:url(x.png}", "@import 'a.css';", "a{b:url(data:image/png;base64,AA)}", "a{b:url()}", "url(a) url(b)", "a{b:url(x y)}"];
  assert.deepEqual(short.map(cssPlain), [
    { ok: true, loads: [] },
    { ok: true, loads: ["x.png"] },
    { ok: true, loads: ["img/a.png"] },
    { ok: false, loads: ["https://x.example/a.png"] },
    { ok: false, loads: [] },
    { ok: false, loads: [] },
    { ok: true, loads: ["data:image/png;base64,AA"] },
    { ok: false, loads: [""] },
    { ok: true, loads: ["a", "b"] },
    { ok: false, loads: [] },
  ]);
});

test("the HTML ops' map from a text's value to its source: linear in a long character reference and in long text after an ampersand", async () => {
  const run = (body, find) => runOps({ bytes: Buffer.from(`<!doctype html><body><p id="p">${body}</p></body>`), format: "html", name: "t.html", ops: [{ op: "replace_text", target: { element_id: "p" }, expect: { quote: "" }, find, replace: "Y" }] });
  for (const [name, body, find, want] of [
    ["a numeric reference with many leading zeros", `x&#${"0".repeat(N)}65;z`, "z", `x&#${"0".repeat(N)}65;Y`],
    ["an ampersand and long text", `&${"a".repeat(N)} end`, "end", `&${"a".repeat(N)} Y`],
    ["an ampersand and a long whitespace run", `&${" ".repeat(N)}end`, "end", `&${" ".repeat(N)}Y`],
  ]) {
    const t0 = process.threadCpuUsage();
    const r = await run(body, find);
    const t = process.threadCpuUsage(t0);
    const ms = (t.user + t.system) / 1000;
    assert.equal(r.results[0].status, "applied", `${name}: ${JSON.stringify(r.results[0]).slice(0, 300)}`);
    assert.ok(r.bytes.toString().includes(`<p id="p">${want}</p>`), name);
    // the reading, the proof and the inventory of a 2 MB page are most of this; quadratic would be minutes
    assert.ok(ms < 5000, `${name}: ${ms.toFixed(0)} ms of CPU`);
  }
});
