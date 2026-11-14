// `onionskin stop` removes a socket file that nothing answers on, and only that (src/cli.js removeStaleSocket); `doctor` then reads it as not running.
// Real CLI processes against a temp state dir; nothing here touches ~/.onionskin.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { tmpdir } from "./helpers/zipbuild.js";

const root = tmpdir("da-stop-");
const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");
const children = [];
after(() => {
  for (const c of children) c.kill("SIGKILL");
  fs.rmSync(root, { recursive: true, force: true });
});
let n = 0;
const freshState = () => {
  const d = path.join(root, `st${++n}`);
  fs.mkdirSync(d, { mode: 0o700 });
  return d;
};
const run = (state, args) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: { ...process.env, ONIONSKIN_STATE_DIR: state, HOME: root }, timeout: 60000 });
/** A socket file with nothing listening: a process listens, then is killed. With `keep`, it stays alive and listening. */
async function socketIn(state, keep = false) {
  const sock = path.join(state, "s.sock");
  const c = spawn(process.execPath, ["-e", `require("net").createServer((s) => s.destroy()).listen(${JSON.stringify(sock)}, () => console.log("up"))`], { stdio: ["ignore", "pipe", "ignore"] });
  children.push(c);
  await new Promise((r) => c.stdout.once("data", r));
  if (!keep) {
    c.kill("SIGKILL");
    await new Promise((r) => c.on("exit", r));
  }
  return { sock, child: c };
}
const serverLine = (state) => JSON.parse(run(state, ["doctor", "--json"]).stdout).checks.find((c) => c.name === "server");

test("stop removes a leftover socket file that nothing answers on, and doctor then reads the server as not running", async () => {
  const state = freshState();
  const { sock } = await socketIn(state);
  assert.ok(fs.existsSync(sock), "the leftover is there");
  const before = serverLine(state);
  assert.match(before.detail, /^a leftover socket file exists but nothing answers$/);
  const r = run(state, ["stop"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "stopped\n");
  assert.equal(fs.existsSync(sock), false, "the leftover is gone");
  assert.match(serverLine(state).detail, /^not running/);
  assert.equal(run(state, ["stop"]).stdout, "stopped\n", "a second stop with nothing there is still fine");
});

test("stop leaves alone a socket something still listens on, one whose server record names a live process, and a file that is not a socket", async () => {
  const live = freshState();
  const { sock, child } = await socketIn(live, true);
  assert.equal(run(live, ["stop"]).status, 0);
  assert.ok(fs.existsSync(sock), "something is listening: not removed");
  child.kill("SIGKILL");
  await new Promise((r) => child.on("exit", r));
  // the listener is gone but the record names a process that is alive (this one): it may be starting up
  fs.writeFileSync(path.join(live, "server.json"), JSON.stringify({ pid: process.pid, port: 1, protocol: 5 }));
  run(live, ["stop"]);
  assert.ok(fs.existsSync(sock), "a live process in the record: not removed");
  fs.rmSync(path.join(live, "server.json"));
  const lock = path.join(live, "start.lock");
  fs.writeFileSync(lock, String(process.pid));
  run(live, ["stop"]);
  assert.ok(fs.existsSync(sock), "a live start lock: not removed");
  fs.rmSync(lock);
  run(live, ["stop"]);
  assert.equal(fs.existsSync(sock), false, "with nothing alive it goes");
  const plain = freshState();
  fs.writeFileSync(path.join(plain, "s.sock"), "not a socket");
  run(plain, ["stop"]);
  assert.equal(fs.readFileSync(path.join(plain, "s.sock"), "utf8"), "not a socket", "a file that is not a socket is never touched");
});
