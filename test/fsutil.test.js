import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, afterEach, test } from "node:test";
import { tmpdir } from "./helpers/zipbuild.js";

const root = tmpdir();
process.env.ONIONSKIN_STATE_DIR = path.join(root, "st");
const { acquireLock, atomicReplace, aclOf, hooks, lockPathFor, LockBusy, replaceGuarded, sha256, WriteConflict, writeSiblingCopy } = await import("../src/fsutil.js");
const { ensureStateDir, writeFully, writeStateFile } = await import("../src/paths.js");
ensureStateDir();
after(() => fs.rmSync(root, { recursive: true, force: true }));
afterEach(() => Object.assign(hooks, { write: null, beforeRename: null, aclOf: null }));

const mk = (name, content = "original") => {
  const f = path.join(root, name);
  fs.writeFileSync(f, content);
  return f;
};
const leftovers = () => fs.readdirSync(root).filter((n) => n.endsWith(".tmp") || n.endsWith(".lock"));

// ---- finding 7: short writes -----------------------------------------------------------------------------------
test("writeFully loops over short writes until every byte is written, and rejects zero progress", () => {
  const f = path.join(root, "short.bin");
  const fd = fs.openSync(f, "w");
  const calls = [];
  const dribble = (fd2, buf, off, len) => {
    calls.push(len);
    return fs.writeSync(fd2, buf, off, Math.min(3, len)); // the device takes 3 bytes at a time
  };
  writeFully(fd, Buffer.from("0123456789abcdef"), dribble);
  fs.closeSync(fd);
  assert.equal(fs.readFileSync(f, "utf8"), "0123456789abcdef");
  assert.ok(calls.length >= 6, "called repeatedly");
  const fd2 = fs.openSync(f, "w");
  let n = 0;
  assert.throws(() => writeFully(fd2, Buffer.from("abcdefgh"), (a, b, o, l) => (n++ ? 0 : fs.writeSync(a, b, o, 2))), /short write/);
  fs.closeSync(fd2);
});

test("writeStateFile and atomicReplace never rename a truncated temp file over the target", () => {
  const target = path.join(root, "state.json");
  writeStateFile(target, "complete content", (fd, buf, off, len) => fs.writeSync(fd, buf, off, Math.min(4, len)));
  assert.equal(fs.readFileSync(target, "utf8"), "complete content");
  assert.throws(() => writeStateFile(target, "NEW CONTENT", (fd, buf, off) => (off ? 0 : fs.writeSync(fd, buf, off, 3))), /short write/);
  assert.equal(fs.readFileSync(target, "utf8"), "complete content", "the old content is intact");
  const doc = mk("short.docx", "original document");
  hooks.write = (fd, buf, off, len) => (off >= 5 ? 0 : fs.writeSync(fd, buf, off, Math.min(5, len)));
  assert.throws(() => atomicReplace(doc, Buffer.from("replacement document")), /short write/);
  assert.equal(fs.readFileSync(doc, "utf8"), "original document");
  hooks.write = (fd, buf, off, len) => fs.writeSync(fd, buf, off, Math.min(5, len));
  atomicReplace(doc, Buffer.from("replacement document"));
  assert.equal(fs.readFileSync(doc, "utf8"), "replacement document");
  assert.deepEqual(leftovers(), [], "no temp or lock files left");
});

// ---- finding 3: the replacement is covered by the compare-and-swap -------------------------------------------------
test("an external write between the compare and the rename is kept in a snapshot and the replace is refused", () => {
  const doc = mk("race.docx", "base version");
  const base = sha256(fs.readFileSync(doc));
  const kept = [];
  hooks.beforeRename = () => fs.writeFileSync(doc, "someone else saved this in the meantime");
  assert.throws(
    () => replaceGuarded(doc, Buffer.from("agent version"), { expectSha: base, snapshotNewer: (b) => kept.push(b.toString()) }),
    (e) => e instanceof WriteConflict && e.code === "CONFLICT" && e.raced === true
  );
  assert.equal(fs.readFileSync(doc, "utf8"), "someone else saved this in the meantime", "the newer bytes were not overwritten");
  assert.deepEqual(kept, ["someone else saved this in the meantime"], "and were handed to the snapshot");
  assert.deepEqual(leftovers(), []);
});

test("a stale base is refused before anything is staged; a matching base replaces and returns the previous hash", () => {
  const doc = mk("cas.docx", "v1");
  assert.throws(() => replaceGuarded(doc, Buffer.from("v2"), { expectSha: "0".repeat(64) }), (e) => e instanceof WriteConflict && !e.raced && /^[0-9a-f]{64}$/.test(e.diskSha));
  assert.equal(fs.readFileSync(doc, "utf8"), "v1");
  const before = [];
  const r = replaceGuarded(doc, Buffer.from("v2"), { expectSha: sha256(Buffer.from("v1")), snapshotBefore: (b) => before.push(b.toString()) });
  assert.equal(fs.readFileSync(doc, "utf8"), "v2");
  assert.deepEqual(before, ["v1"]);
  assert.equal(r.previousSha, sha256(Buffer.from("v1")));
});

test("the lock: exclusive while held, released after the write, stale (dead pid) locks are taken over", () => {
  const doc = mk("lock.docx", "x");
  const release = acquireLock(doc);
  assert.ok(fs.existsSync(lockPathFor(doc)));
  assert.equal(fs.readFileSync(lockPathFor(doc), "utf8"), String(process.pid));
  assert.throws(() => replaceGuarded(doc, Buffer.from("y"), { waitMs: 100 }), (e) => e instanceof LockBusy && e.code === "LOCK_BUSY");
  assert.equal(fs.readFileSync(doc, "utf8"), "x", "a busy lock means no write");
  release();
  assert.ok(!fs.existsSync(lockPathFor(doc)));
  // a lock left by a process that is gone
  const dead = execFileSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  fs.writeFileSync(lockPathFor(doc), dead);
  replaceGuarded(doc, Buffer.from("z"), { waitMs: 500 });
  assert.equal(fs.readFileSync(doc, "utf8"), "z");
  assert.deepEqual(leftovers(), []);
});

test("acquireLock with waitMs 0 takes a stale lock it just removed (dead pid, or an old empty lock), and still refuses a live one", () => {
  const doc = mk("lock-zero.docx", "x");
  const dead = execFileSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  fs.writeFileSync(lockPathFor(doc), dead);
  const r1 = acquireLock(doc, { waitMs: 0 });
  assert.equal(fs.readFileSync(lockPathFor(doc), "utf8"), String(process.pid));
  r1();
  // an empty lock older than two seconds is garbage
  fs.writeFileSync(lockPathFor(doc), "");
  const old = new Date(Date.now() - 10_000);
  fs.utimesSync(lockPathFor(doc), old, old);
  const r2 = acquireLock(doc, { waitMs: 0 });
  assert.equal(fs.readFileSync(lockPathFor(doc), "utf8"), String(process.pid));
  r2();
  assert.ok(!fs.existsSync(lockPathFor(doc)));
  // a live holder (this process) is respected at once
  const held = acquireLock(doc);
  assert.throws(() => acquireLock(doc, { waitMs: 0 }), (e) => e instanceof LockBusy && e.code === "LOCK_BUSY");
  assert.equal(fs.readFileSync(lockPathFor(doc), "utf8"), String(process.pid), "the live lock is left in place");
  held();
});

test("a second process holding the lock blocks this writer until it lets go", async () => {
  const doc = mk("lock2.docx", "x");
  const { spawn } = await import("node:child_process");
  const code = `const fs=require("fs");fs.writeFileSync(${JSON.stringify(lockPathFor(doc))},String(process.pid));process.stdout.write("held\\n");setTimeout(()=>{fs.unlinkSync(${JSON.stringify(lockPathFor(doc))});},400);`;
  const child = spawn(process.execPath, ["-e", code], { stdio: ["ignore", "pipe", "ignore"] });
  await new Promise((r) => child.stdout.once("data", r));
  const t0 = Date.now();
  replaceGuarded(doc, Buffer.from("after"), { waitMs: 3000 });
  assert.ok(Date.now() - t0 >= 300, "waited for the other holder");
  assert.equal(fs.readFileSync(doc, "utf8"), "after");
  await new Promise((r) => child.on("exit", r));
});

test("an unreadable lock times out without changing the file or removing the lock", () => {
  const doc = mk("unreadable.docx");
  fs.mkdirSync(lockPathFor(doc)); // exclusive create sees EEXIST, reading the pid fails
  try {
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { acquireLock } from "./src/fsutil.js";
      try { acquireLock(process.argv[1], { waitMs: 50 }); }
      catch (err) { process.stdout.write(err.code); }
    `, doc], { encoding: "utf8", timeout: 2000 });
    assert.ifError(child.error);
    assert.equal(child.stdout, "LOCK_BUSY");
    assert.equal(fs.readFileSync(doc, "utf8"), "original");
    assert.ok(fs.statSync(lockPathFor(doc)).isDirectory());
  } finally {
    fs.rmdirSync(lockPathFor(doc));
  }
});

// ---- finding 8: ACLs ---------------------------------------------------------------------------------------------
const hasChmodAcl = process.platform === "darwin" && fs.existsSync("/bin/chmod");
test("macOS: a file's ACL and extended attributes survive a replace", { skip: hasChmodAcl ? false : "needs macOS /bin/chmod +a (ACLs)" }, () => {
  const doc = mk("acl.docx", "with acl");
  fs.chmodSync(doc, 0o644);
  execFileSync("/bin/chmod", ["+a", "user:nobody deny read,write", doc]);
  execFileSync("/usr/bin/xattr", ["-w", "com.example.onionskin-test", "kept", doc]);
  const acl = aclOf(doc);
  assert.match(acl, /deny read,write/, "the ACL is on the file before the replace");
  const info = atomicReplace(doc, Buffer.from("new content"));
  assert.equal(fs.readFileSync(doc, "utf8"), "new content");
  assert.equal(aclOf(doc), acl, "same ACL after the replace");
  assert.equal(info.acl, "preserved");
  assert.equal(execFileSync("/usr/bin/xattr", ["-p", "com.example.onionskin-test", doc], { encoding: "utf8" }).trim(), "kept");
  assert.equal(fs.statSync(doc).mode & 0o777, 0o644);
  assert.deepEqual(leftovers(), []);
});

test("a file whose ACL cannot be carried over is refused and left untouched", { skip: hasChmodAcl ? false : "needs macOS /bin/chmod +a (ACLs)" }, () => {
  const doc = mk("acl2.docx", "protected");
  execFileSync("/bin/chmod", ["+a", "user:nobody deny read,write", doc]);
  const real = aclOf(doc);
  hooks.aclOf = (f) => (f === doc ? real : ""); // the staged copy reports no ACL
  assert.throws(() => atomicReplace(doc, Buffer.from("changed")), (e) => e.code === "ACL_NOT_PRESERVED" && /access control list/.test(e.message));
  assert.equal(fs.readFileSync(doc, "utf8"), "protected");
  assert.deepEqual(leftovers(), []);
});

// ---- the tracked-changes copy's name ------------------------------------------------------------------------------
test("writeSiblingCopy with a label: the label names the copy, a taken name gets 2, the mode is copied, the original is untouched", () => {
  const f = mk("Plan.docx", "the original");
  fs.chmodSync(f, 0o640);
  const now = new Date(2026, 10, 11, 9, 5);
  const a = writeSiblingCopy(f, Buffer.from("tracked one"), { now, label: "tracked changes" });
  assert.equal(a.name, "Plan (tracked changes 2026-11-11 0905).docx");
  const b = writeSiblingCopy(f, Buffer.from("tracked two"), { now, label: "tracked changes" });
  assert.equal(b.name, "Plan (tracked changes 2026-11-11 0905) 2.docx");
  assert.equal(fs.readFileSync(a.path, "utf8"), "tracked one");
  assert.equal(fs.statSync(a.path).mode & 0o777, 0o640);
  assert.equal(fs.readFileSync(f, "utf8"), "the original");
  assert.equal(writeSiblingCopy(f, Buffer.from("x"), { now }).name, "Plan (Onionskin copy 2026-11-11 0905).docx", "the default name is unchanged");
  assert.deepEqual(leftovers(), []);
});
