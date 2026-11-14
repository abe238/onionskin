import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { tmpdir } from "./helpers/zipbuild.js";

// Server start race and shutdown (finding 14): real server processes against a state dir that holds a stale socket from a crash.
const root = tmpdir("da-start-");
const state = path.join(root, "st");
fs.mkdirSync(state, { mode: 0o700 });
const entry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "server-entry.js");
const sock = path.join(state, "s.sock");
const env = { ...process.env, ONIONSKIN_STATE_DIR: state, ONIONSKIN_TICK_MS: "100000" };
const children = [];
after(() => {
  for (const c of children) c.kill("SIGKILL");
  fs.rmSync(root, { recursive: true, force: true });
});

const health = () =>
  new Promise((resolve) => {
    const r = http.get({ socketPath: sock, path: "/health", timeout: 1000 }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString())));
    });
    r.on("error", () => resolve(null));
  });

function startEntry() {
  const c = spawn(process.execPath, [entry], { env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(c);
  let out = "";
  c.stdout.on("data", (d) => (out += d));
  const exited = new Promise((r) => c.on("exit", (code) => r(code)));
  const ready = new Promise((r) => {
    const t = setInterval(() => out.includes("ready") && (clearInterval(t), r(true)), 20);
    exited.then(() => (clearInterval(t), r(out.includes("ready"))));
  });
  return { c, exited, ready };
}

test("two servers starting at once over a stale socket: exactly one wins, the other leaves the live socket alone; shutdown unlinks only its own files", async () => {
  // a socket file left behind by a crashed server
  const dead = spawn(process.execPath, ["-e", `require("net").createServer().listen(${JSON.stringify(sock)}, () => console.log("up"))`], { stdio: ["ignore", "pipe", "ignore"] });
  await new Promise((r) => dead.stdout.once("data", r));
  dead.kill("SIGKILL");
  await new Promise((r) => dead.on("exit", r));
  assert.ok(fs.existsSync(sock), "stale socket present");

  const a = startEntry();
  const b = startEntry();
  const [readyA, readyB] = await Promise.all([a.ready, b.ready]);
  assert.equal([readyA, readyB].filter(Boolean).length, 1, "exactly one server came up");
  const winner = readyA ? a : b;
  const loser = readyA ? b : a;
  assert.equal(await loser.exited, 0, "the loser exits quietly");
  const record = JSON.parse(fs.readFileSync(path.join(state, "server.json"), "utf8"));
  assert.equal(record.pid, winner.c.pid);
  assert.equal((await health()).pid, winner.c.pid, "the live socket belongs to the winner");
  assert.ok(!fs.existsSync(path.join(state, "start.lock")), "the lock is released");

  // a server that no longer owns the record must not unlink the files of whoever does
  fs.writeFileSync(path.join(state, "server.json"), JSON.stringify({ pid: 1, port: 1, protocol: 1 }));
  await new Promise((resolve, reject) => {
    const r = http.request({ socketPath: sock, method: "POST", path: "/cli/stop", headers: { "content-type": "application/json" } }, (res) => (res.resume(), res.on("end", resolve)));
    r.on("error", reject);
    r.end("{}");
  });
  await winner.exited;
  assert.ok(fs.existsSync(path.join(state, "server.json")), "foreign record kept");
  assert.ok(fs.existsSync(sock), "foreign socket path kept");
  // the next start finds a dead socket and takes over cleanly
  fs.rmSync(path.join(state, "server.json"));
  const c = startEntry();
  assert.equal(await c.ready, true);
  assert.equal((await health()).pid, c.c.pid);
  c.c.kill("SIGTERM");
  await c.exited;
});

test("a running server from another version (an upgrade) is asked to stop and replaced; the same version is left alone", async () => {
  // end whatever the earlier test left running, then stand in an older server: /health says protocol 1, /cli/stop makes it exit
  for (const c of children) c.kill("SIGKILL");
  await new Promise((r) => setTimeout(r, 200));
  fs.rmSync(sock, { force: true });
  fs.rmSync(path.join(state, "server.json"), { force: true });
  const old = spawn(process.execPath, ["-e", `const http=require("http");const s=http.createServer((q,r)=>{if(q.url==="/health"){r.setHeader("content-type","application/json");r.end(JSON.stringify({ok:true,pid:process.pid,protocol:1}))}else if(q.url==="/cli/stop"){r.end("{}");setTimeout(()=>{s.close();process.exit(0)},50)}else{r.statusCode=404;r.end()}});s.listen(${JSON.stringify(sock)},()=>console.log("up"))`], { stdio: ["ignore", "pipe", "ignore"] });
  children.push(old);
  await new Promise((r) => old.stdout.once("data", r));
  const oldExited = new Promise((r) => old.on("exit", r));
  assert.equal((await health()).protocol, 1);
  const next = startEntry();
  assert.equal(await next.ready, true, "the new server came up");
  await oldExited;
  const h = await health();
  assert.equal(h.pid, next.c.pid, "the socket belongs to the new server");
  assert.notEqual(h.protocol, 1);
  // a second server of the same version leaves the running one alone
  const dup = startEntry();
  assert.equal(await dup.ready, false);
  assert.equal(await dup.exited, 0);
  assert.equal((await health()).pid, next.c.pid);
});
