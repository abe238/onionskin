import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { MAX_DOC_BYTES } from "./constants.js";
import { sub, writeFully, writeStateFile } from "./paths.js";

export const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

/** The file must be a regular file (not a symlink) owned by us. Returns lstat. */
export function checkRegularOwned(file) {
  const st = fs.lstatSync(file);
  if (st.isSymbolicLink()) throw Object.assign(new Error(`${file} is a symbolic link`), { code: "SYMLINK" });
  if (!st.isFile()) throw new Error(`${file} is not a regular file`);
  if (st.uid !== process.getuid()) throw new Error(`${file} is not owned by the current user`);
  return st;
}

/** Reads a document, refusing by size first (an oversized file is never pulled into memory). */
export function readDoc(file, max = MAX_DOC_BYTES) {
  const st = fs.statSync(file);
  if (st.size > max) throw Object.assign(new Error(`${path.basename(file)} is larger than ${Math.round(max / 1024 / 1024)} MB`), { code: "TOO_LARGE" });
  return fs.readFileSync(file);
}

function copyXattrs(from, to) {
  if (process.platform !== "darwin") return "not applicable";
  try {
    const names = execFileSync("/usr/bin/xattr", [from], { encoding: "utf8" }).split("\n").filter(Boolean);
    for (const n of names) {
      const hex = execFileSync("/usr/bin/xattr", ["-px", n, from], { encoding: "utf8" }).replace(/\s+/g, "");
      execFileSync("/usr/bin/xattr", ["-wx", n, hex, to]);
    }
    return `copied ${names.length}`;
  } catch (err) {
    return `failed: ${err.message.split("\n")[0]}`;
  }
}

/** Test seams (never set in production): inject a short-writing write, a hook between the last check and the rename, a fake ACL reader. */
export const hooks = { write: null, beforeRename: null, aclOf: null };

/** The write was refused because the file is not what the caller compared against (before the write, or in the last instant before the rename). */
export class WriteConflict extends Error {
  constructor(diskSha, baseSha, raced) {
    super(raced ? "the file changed while it was being replaced; the newer version was kept" : "the file changed on disk since it was loaded");
    this.code = "CONFLICT";
    this.diskSha = diskSha;
    this.baseSha = baseSha;
    this.raced = !!raced;
  }
}
export class LockBusy extends Error {
  constructor(file) {
    super(`another writer holds the lock for ${path.basename(file)}`);
    this.code = "LOCK_BUSY";
  }
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export const lockPathFor = (file) => path.join(path.dirname(file), `.${path.basename(file)}.onionskin.lock`);

/**
 * Advisory lock next to the document: created exclusively, holds our pid. Every Onionskin writer (Send, agent write, commit, revert,
 * standalone apply) holds it from the hash comparison through the rename. A lock whose pid is gone is stale and taken over.
 * Returns the release function. Ceiling: advisory only (an editor that does not look for the lock can still write; see the re-hash before
 * the rename in replaceGuarded), and the stale takeover itself is not atomic (two waiters finding the same dead lock).
 */
export function acquireLock(file, { waitMs = 5000 } = {}) {
  const lock = lockPathFor(file);
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = fs.openSync(lock, "wx", 0o600);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return () => {
        try {
          if (fs.readFileSync(lock, "utf8") === String(process.pid)) fs.unlinkSync(lock);
        } catch {}
      };
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }
    let stale = false;
    try {
      const pid = Number(fs.readFileSync(lock, "utf8"));
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
        } catch (e) {
          stale = e.code === "ESRCH";
        }
      } else stale = Date.now() - fs.statSync(lock).mtimeMs > 2000; // being created, or garbage
    } catch {
      continue; // released between our attempts
    }
    if (stale) {
      try {
        fs.unlinkSync(lock);
      } catch {}
      continue;
    }
    if (Date.now() > deadline) throw new LockBusy(file);
    sleepSync(20);
  }
}

/** The ACL entries of a file (macOS `ls -le`), "" when there are none or the platform has no such tool. */
export function aclOf(file) {
  if (hooks.aclOf) return hooks.aclOf(file);
  if (process.platform !== "darwin") return "";
  try {
    return execFileSync("/bin/ls", ["-led", file], { encoding: "utf8" })
      .split("\n")
      .filter((l) => /^\s*\d+: /.test(l))
      .join("\n");
  } catch {
    return "";
  }
}

/**
 * Stages the new content in a temp file next to `file`. On macOS the temp file is made with `cp -p` (mode, owner, flags, extended
 * attributes and ACLs travel with the inode) and its content is then replaced; a file that HAS an ACL is only replaced when the ACL is
 * verified to be on the temp file too, otherwise the replace is refused and nothing was touched. Elsewhere: O_EXCL temp file, fchmod,
 * xattrs best effort (there is no ACL support on those paths; reported as "not applicable").
 */
function stage(file, bytes, before) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  const origAcl = aclOf(file);
  let cloned = false;
  if (process.platform === "darwin") {
    try {
      execFileSync("/bin/cp", ["-pn", file, tmp], { stdio: "ignore" });
      cloned = true;
    } catch {
      fs.rmSync(tmp, { force: true });
      if (origAcl) throw Object.assign(new Error("this file has an access control list that could not be preserved, so it was not replaced"), { code: "ACL_NOT_PRESERVED" });
    }
  }
  let fd;
  try {
    if (cloned) {
      fs.chmodSync(tmp, 0o600); // keeps the ACL; lets us open a read-only original for writing
      fd = fs.openSync(tmp, "r+");
      fs.ftruncateSync(fd, 0);
    } else fd = fs.openSync(tmp, "wx", 0o600);
    writeFully(fd, bytes, hooks.write || fs.writeSync);
    fs.fchmodSync(fd, before.mode & 0o7777);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    let xattrs = "preserved by cp -p";
    if (!cloned) xattrs = copyXattrs(file, tmp);
    let acl = process.platform === "darwin" ? "none" : "not applicable";
    if (origAcl) {
      if (aclOf(tmp) !== origAcl) throw Object.assign(new Error("this file has an access control list that could not be preserved, so it was not replaced"), { code: "ACL_NOT_PRESERVED" });
      acl = "preserved";
    }
    return { tmp, info: { mode: before.mode & 0o7777, xattrs, acl } };
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * The one way a document gets replaced. Holds the advisory lock from the hash comparison through the rename:
 *  1. compare the disk hash with `expectSha` (when given) -> WriteConflict; `snapshotBefore(diskBytes)` stores what is about to be replaced;
 *  2. stage the new bytes (full write, fsync, mode, xattrs, ACL);
 *  3. re-hash the target right before the rename. If it changed, DO NOT overwrite: `snapshotNewer(newBytes)` keeps the newer version and
 *     WriteConflict (raced) is thrown;
 *  4. rename, fsync the directory.
 * Ceiling: a writer that ignores the lock can still land between step 3 and the rename (microseconds, one syscall); that version is replaced
 * without a snapshot. Upgrade path: none without kernel support (renameat2 RENAME_EXCHANGE is Linux only).
 */
export function replaceGuarded(file, bytes, { expectSha = null, snapshotBefore = null, snapshotNewer = null, waitMs } = {}) {
  const release = acquireLock(file, { waitMs });
  try {
    const before = checkRegularOwned(file);
    const disk = readDoc(file);
    const diskSha = sha256(disk);
    if (expectSha != null && diskSha !== expectSha) throw new WriteConflict(diskSha, expectSha, false);
    snapshotBefore?.(disk);
    const { tmp, info } = stage(file, bytes, before);
    try {
      hooks.beforeRename?.({ file, tmp });
      checkRegularOwned(file);
      const now = readDoc(file);
      const nowSha = sha256(now);
      if (nowSha !== diskSha) {
        try {
          snapshotNewer?.(now);
        } catch {} // the newer bytes stay on disk untouched either way
        throw new WriteConflict(nowSha, expectSha ?? diskSha, true);
      }
      fs.renameSync(tmp, file);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
    const dfd = fs.openSync(path.dirname(file), "r");
    try {
      fs.fsyncSync(dfd);
    } finally {
      fs.closeSync(dfd);
    }
    return { ...info, previousSha: diskSha };
  } finally {
    release();
  }
}

const two = (n) => String(n).padStart(2, "0");
/**
 * Item 12: the version Onionskin holds, saved NEXT TO the original when the original was changed by someone else. The name is built from
 * the session's own (already validated) file path, never from document content: `<name> (Onionskin copy YYYY-MM-DD HHMM).<ext>` in local time,
 * then ` 2`, ` 3` ... when that name exists. The copy gets the original's mode, extended attributes and ACL (staged like a replace) and is
 * linked into place with link(2), which fails if the name exists: an existing file is never overwritten. Throws (EACCES, EROFS ...) when the
 * folder is not writable; the caller then offers the browser download instead. `label` names the kind of copy ("tracked changes" for the
 * tracked-changes copy: `<name> (tracked changes YYYY-MM-DD HHMM).docx`); it is a constant of the caller, never document text.
 * Returns {name, path}.
 */
export function writeSiblingCopy(file, bytes, { now = new Date(), label = "Onionskin copy" } = {}) {
  const dir = path.dirname(file);
  const ext = path.extname(file);
  const stem = path.basename(file, ext);
  const stamp = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())} ${two(now.getHours())}${two(now.getMinutes())}`;
  let tmp;
  try {
    tmp = stage(file, bytes, checkRegularOwned(file)).tmp; // same permissions as the original
  } catch (err) {
    if (err.code === "ACL_NOT_PRESERVED") throw err;
    if (err.code === "ENOENT") {
      // the original was removed: a plain private copy
      tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
      const fd = fs.openSync(tmp, "wx", 0o600);
      try {
        writeFully(fd, bytes, hooks.write || fs.writeSync);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    } else throw err;
  }
  try {
    for (let n = 1; n <= 1000; n++) {
      const name = `${stem} (${label} ${stamp})${n > 1 ? ` ${n}` : ""}${ext}`;
      const dest = path.join(dir, name);
      try {
        fs.linkSync(tmp, dest);
        return { name, path: dest };
      } catch (err) {
        if (err.code !== "EEXIST") throw err;
      }
    }
    throw Object.assign(new Error("could not find a free name for the copy"), { code: "EEXIST" });
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Atomic replace without a compare (callers that have no base hash). Same lock, re-hash and staging as replaceGuarded. */
export const atomicReplace = (file, bytes, opts = {}) => replaceGuarded(file, bytes, opts);

// ---- snapshots ----------------------------------------------------------------------------------------------

const SNAPSHOT_KEEP = 20;
const SNAPSHOT_MAX_BYTES = 2 * 1024 ** 3;

export class Snapshots {
  constructor(key, { keep = SNAPSHOT_KEEP, maxBytes = SNAPSHOT_MAX_BYTES } = {}) {
    this.dir = sub("snapshots", key);
    this.keep = keep;
    this.maxBytes = maxBytes;
    this.indexFile = path.join(this.dir, "index.json");
  }
  index() {
    try {
      return JSON.parse(fs.readFileSync(this.indexFile, "utf8"));
    } catch {
      return [];
    }
  }
  blob(sha) {
    return path.join(this.dir, `${sha}.bin`);
  }
  has(sha) {
    return fs.existsSync(this.blob(sha));
  }
  read(sha) {
    return fs.readFileSync(this.blob(sha));
  }
  /** Content-addressed. `original` marks the first-ever version, which is never pruned. */
  add(bytes, label, { original = false } = {}) {
    const sha = sha256(bytes);
    const idx = this.index();
    const free = fs.statfsSync(this.dir);
    if (!this.has(sha) && free.bavail * free.bsize < bytes.length * 2 + 100 * 1024 * 1024) throw Object.assign(new Error("not enough free disk space for a snapshot"), { code: "ENOSPC_SNAP" });
    if (!this.has(sha)) writeStateFile(this.blob(sha), bytes);
    const existing = idx.find((e) => e.sha === sha);
    if (existing) {
      if (!existing.original) existing.label = label;
      existing.at = Date.now();
      if (original) existing.original = true;
    } else idx.push({ sha, at: Date.now(), label, size: bytes.length, original: !!original });
    this.save(this.prune(idx));
    return sha;
  }
  /** marks a stored version as the newest so pruning drops others first (the pre-agent version must outlive agent writes) */
  touch(sha) {
    const idx = this.index();
    const e = idx.find((x) => x.sha === sha);
    if (!e) return false;
    e.at = Date.now();
    this.save(idx);
    return true;
  }
  prune(idx) {
    const keepable = idx.filter((e) => !e.original).sort((a, b) => a.at - b.at);
    const drop = new Set();
    while (keepable.length - drop.size > this.keep) drop.add(keepable[drop.size].sha);
    let total = idx.reduce((n, e) => n + (drop.has(e.sha) ? 0 : e.size), 0);
    for (const e of keepable) {
      if (total <= this.maxBytes) break;
      if (!drop.has(e.sha)) {
        drop.add(e.sha);
        total -= e.size;
      }
    }
    for (const sha of drop) {
      try {
        fs.unlinkSync(this.blob(sha));
      } catch {}
    }
    return idx.filter((e) => !drop.has(e.sha));
  }
  save(idx) {
    writeStateFile(this.indexFile, JSON.stringify(idx, null, 2));
  }
}
