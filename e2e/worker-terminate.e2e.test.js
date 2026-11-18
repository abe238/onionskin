// Every worker thread the server starts, stopped after every millisecond from 0 to 150, 151 times each (test/helpers/terminate-workers.mjs
// in a child process, so an abort shows as its exit code). Before src/stop-gate.js, stopping a worker while a module of it was still being
// evaluated aborted the whole process with exit 133. About 900 workers started and stopped: in the slow group, one file at a time, so a
// loaded machine does not run it next to the unit suite; test/worker-terminate.test.js runs 0 to 30 ms in steps of 3.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const helper = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "test", "helpers", "terminate-workers.mjs");

test("each worker (check, history, redline, voice, voice samples, open, merge, ops, html render, anchors) stopped after 0 to 150 ms, 151 times each: the process lives", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "da-term-"));
  try {
    const child = spawn(process.execPath, [helper, dir, "150", "1", "0"], { env: { PATH: process.env.PATH, HOME: dir, ONIONSKIN_STATE_DIR: path.join(dir, "st"), ONIONSKIN_NO_SOFFICE: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const code = await new Promise((resolve) => child.on("exit", (c, sig) => resolve(c ?? sig)));
    assert.equal(code, 0, `the process ended with ${code}: ${err.slice(0, 600)}`);
    assert.match(out, /survived 1510/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
