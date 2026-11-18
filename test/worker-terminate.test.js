// Every worker thread the server starts can be stopped at any moment without taking the server down. On Node 26, terminating a worker while
// a module of it was still being evaluated asynchronously (src/docx.js awaits at its top level) aborted the whole process with exit 133;
// the check worker did its whole job in that state, so its 4-minute time limit could end the server. The workers run in a child process
// here, so an abort shows as that child's exit code instead of ending the test runner. Stopping a worker inside zlib aborted it too
// (SIGABRT, "close before init"): the second test stops the open worker 300 times while it inflates a part every few hundred microseconds.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { tmpdir } from "./helpers/zipbuild.js";

const here = path.dirname(fileURLToPath(import.meta.url));

async function stops(args) {
  const dir = tmpdir("da-term-");
  try {
    const child = spawn(process.execPath, [path.join(here, "helpers", "terminate-workers.mjs"), dir, ...args], { env: { PATH: process.env.PATH, HOME: dir, ONIONSKIN_STATE_DIR: path.join(dir, "st"), ONIONSKIN_NO_SOFFICE: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    const kill = () => child.kill("SIGKILL"); // a timed-out test never reaches its finally: the child goes with this process
    process.once("exit", kill);
    child.once("exit", () => process.off("exit", kill));
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const code = await new Promise((resolve) => child.on("exit", (c, sig) => resolve(c ?? sig)));
    assert.equal(code, 0, `the process ended with ${code}: ${err.slice(0, 600)}`);
    return out;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// 0 to 30 ms in steps of 3 here (this run aborted the process before src/stop-gate.js, 3 times in 3 on bec67b0); every millisecond from 0
// to 150 runs in the slow group (e2e/worker-terminate.e2e.test.js), one file at a time.
test("each worker (check, history, redline, voice, voice samples, open, merge, ops, html render, anchors) stopped after 0 to 30 ms, 11 times each: the process lives", async () => {
  assert.match(await stops(["30", "3", "0"]), /survived 110/);
});

test("the open worker stopped 300 times while it inflates the parts of a 1,000-sheet workbook: the process lives (it aborted in zlib)", async () => {
  assert.match(await stops(["0", "1", "300"]), /survived 310/);
});
