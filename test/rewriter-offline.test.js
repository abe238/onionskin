import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import { test } from "node:test";
import { sandboxed } from "../src/rewriter.js";

// The local rewriter's worker runs under /usr/bin/sandbox-exec with the network denied (src/rewriter.js). This proves the wrapper really cuts
// the network: a listener on 127.0.0.1, one process that connects to it plainly (the control: it must get through, or the probe proves
// nothing) and the same process wrapped by sandboxed() (it must not). Skips with the reason where sandbox-exec is missing; fails under CI.
const SANDBOX = "/usr/bin/sandbox-exec";
const skip = !fs.existsSync(SANDBOX) && !process.env.CI ? `${SANDBOX} is not on this machine` : false;
const connect = `const s = require("node:net").connect(Number(process.argv[1]), "127.0.0.1"); s.on("connect", () => { console.log("CONNECTED"); process.exit(0); }); s.on("error", (e) => { console.log("BLOCKED " + e.code); process.exit(2); });`;

test("a worker under the sandbox cannot reach a listener on 127.0.0.1; the same process outside it can", { skip }, async () => {
  assert.ok(fs.existsSync(SANDBOX), "sandbox-exec must exist on a CI machine");
  const hits = [];
  const srv = net.createServer((c) => (hits.push(1), c.end()));
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = String(srv.address().port);
  try {
    const plain = spawnSync(process.execPath, ["-e", connect, port], { encoding: "utf8", timeout: 20_000 });
    assert.match(plain.stdout, /CONNECTED/, `control failed: ${plain.stdout}${plain.stderr}`);
    await new Promise((r) => setTimeout(r, 100)); // spawnSync blocked this process: the listener sees the control's connection only now
    assert.equal(hits.length, 1, "the control reached the listener");
    const before = hits.length;
    const [cmd, args] = sandboxed(process.execPath, ["-e", connect, port]);
    assert.equal(cmd, SANDBOX);
    const boxed = spawnSync(cmd, args, { encoding: "utf8", timeout: 20_000 });
    assert.match(boxed.stdout, /BLOCKED (EPERM|EACCES)/, `the sandboxed process was not blocked: ${boxed.stdout}${boxed.stderr}`);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(hits.length, before, "the listener saw no connection from the sandboxed process");
  } finally {
    srv.close();
  }
});
