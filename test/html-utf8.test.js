// The UTF-8 copy of a page saved as windows-1252 or ISO-8859-1 (PLAN-html R10, R18; src/html-utf8.js): `onionskin open` prints the fixed
// sentence and the exact command, `onionskin utf8-copy <file>` writes <name>.utf8.html next to it only when that name is free and leaves
// the original untouched, and the copy opens. Through the real CLI against a real server. Temp dirs only.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { tmpdir } from "./helpers/zipbuild.js";

const root = tmpdir();
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE = path.join(root, "st");
process.env.ONIONSKIN_STATE_DIR = STATE;
process.env.ONIONSKIN_NO_SOFFICE = "1";
const { startServer } = await import("../src/server.js");
const { NOT_UTF8, NOT_READABLE_ENCODING } = await import("../src/html.js");
const { copyPath, utf8Bytes, writeUtf8Copy } = await import("../src/html-utf8.js");

let srv;
after(() => {
  srv?.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

const cli = (args) =>
  new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(repo, "src", "cli.js"), ...args], { env: { PATH: process.env.PATH, HOME: root, ONIONSKIN_STATE_DIR: STATE, ONIONSKIN_NO_SOFFICE: "1", ONIONSKIN_AGENT_CLI: "none" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    c.stdout.on("data", (d) => (stdout += d));
    c.stderr.on("data", (d) => (stderr += d));
    c.on("close", (code) => resolve({ code, stdout, stderr }));
  });
// "Café crème, 5 €" in windows-1252: é = e9, è = e8, € = 80
const latin = (meta) => Buffer.concat([Buffer.from(`<!doctype html><html><head>${meta}<title>T</title></head><body><p>Caf`), Buffer.from([0xe9]), Buffer.from(" cr"), Buffer.from([0xe8]), Buffer.from("me, 5 "), Buffer.from([0x80]), Buffer.from("</p></body></html>")]);

test("the copy's bytes: windows-1252 and ISO-8859-1 decoded, the declaration said as utf-8, refused for what it cannot read", () => {
  for (const meta of ['<meta charset="windows-1252">', '<meta http-equiv="Content-Type" content="text/html; charset=ISO-8859-1">', "<META CHARSET=latin1>"]) {
    const r = utf8Bytes(latin(meta));
    assert.equal(r.ok, true, meta);
    const t = r.bytes.toString("utf8");
    assert.ok(t.includes("Café crème, 5 €"), t);
    assert.doesNotMatch(t, /1252|8859|latin1/i);
    assert.match(t, /charset=["']?utf-8/i);
  }
  assert.equal(utf8Bytes(Buffer.from("<p>already fine</p>")).ok, false);
  assert.deepEqual(utf8Bytes(Buffer.from('<meta charset="shift_jis"><p>x</p>')), { ok: false, reason: NOT_READABLE_ENCODING });
});

test("onionskin open prints the sentence and the command; utf8-copy writes the copy next to the file once, the original untouched; the copy opens", async () => {
  srv = await startServer({ port: 0 });
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(root, "pages-")));
  const file = path.join(dir, "old page.html");
  const bytes = latin('<meta charset="windows-1252">');
  fs.writeFileSync(file, bytes);
  const o = await cli(["open", file, "--no-open"]);
  assert.equal(o.code, 1, o.stdout + o.stderr);
  assert.ok(o.stderr.includes(NOT_UTF8), o.stderr);
  const cmd = o.stderr.split("\n").find((l) => l.includes(" utf8-copy "))?.trim();
  assert.equal(cmd, `onionskin utf8-copy '${file}'`);
  // the command as printed (the program name aside)
  const w = await cli(["utf8-copy", file]);
  assert.equal(w.code, 0, w.stderr);
  const copy = copyPath(file);
  assert.equal(copy, path.join(dir, "old page.utf8.html"));
  assert.ok(w.stdout.includes(copy) && w.stdout.includes("onionskin open"), w.stdout);
  assert.ok(fs.readFileSync(file).equals(bytes), "the original is untouched");
  assert.ok(fs.readFileSync(copy, "utf8").includes("Café crème, 5 €"));
  // again: the name is taken, nothing is written
  fs.writeFileSync(copy, "mine");
  const again = await cli(["utf8-copy", file]);
  assert.equal(again.code, 1);
  assert.match(again.stderr, /exists already, so nothing was written/);
  assert.equal(fs.readFileSync(copy, "utf8"), "mine");
  assert.deepEqual(writeUtf8Copy(file), { ok: false, reason: `${copy} exists already, so nothing was written. Open that file, or move it away and run this again.` });
  fs.rmSync(copy);
  assert.equal((await cli(["utf8-copy", file])).code, 0);
  const opened = await cli(["open", copy, "--no-open"]);
  assert.equal(opened.code, 0, opened.stderr);
  assert.match(opened.stdout, /^Opened /);
  // a page Onionskin cannot read at all gets no command
  const sjis = path.join(dir, "jp.html");
  fs.writeFileSync(sjis, '<meta charset="shift_jis"><p>x</p>');
  const n = await cli(["open", sjis, "--no-open"]);
  assert.equal(n.code, 1);
  assert.ok(!n.stderr.includes("utf8-copy"), n.stderr);
});
