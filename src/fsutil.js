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

const tooLarge = (file, max) => Object.assign(new Error(`${path.basename(file)} is larger than ${Math.round(max / 1024 / 1024)} MB, more than Onionskin can read. Make it smaller (pictures and videos are often most of a file) or split it, and open that`), { code: "TOO_LARGE" });

/** Reads a document, refusing by size first (an oversized file is never pulled into memory). */
export function readDoc(file, max = MAX_DOC_BYTES) {
  const st = fs.statSync(file);
  if (st.size > max) throw tooLarge(file, max);
  return fs.readFileSync(file);
}

/**
 * Reads an open document the way checkRegularOwned + readDoc would, on one descriptor so nothing can be swapped in between: opened with
 * O_NOFOLLOW (a symbolic link is refused, code SYMLINK) and O_NONBLOCK (a FIFO swapped in does not block the open; fstat refuses it), then the
 * descriptor must be a regular file this user owns, and its size is checked against the cap before a byte is read. Same words as those two.
 * Ceiling: O_NOFOLLOW covers only the last path component; a folder on the path replaced by a link after open is followed (the session
 * holds the real path, so this needs the folder itself swapped). Upgrade path: lstat each folder on the path and check it again after the open, as
 * src/html-render.js does for page assets. Also, like readDoc, a file that grows between the fstat and the read is read to its end.
 */
export function readOwned(file, max = MAX_DOC_BYTES) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (err) {
    if (err.code === "ELOOP") throw Object.assign(new Error(`${file} is a symbolic link`), { code: "SYMLINK" });
    throw err;
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw Object.assign(new Error(`${file} is not a regular file`), { code: "NOT_REGULAR" });
    if (st.uid !== process.getuid()) throw Object.assign(new Error(`${file} is not owned by the current user`), { code: "NOT_OWNED" });
    if (st.size > max) throw tooLarge(file, max);
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * A file's identity on disk as one string: device, inode, size and modification time in nanoseconds (a bigint fstat). NOT the change
 * time: a sync client (iCloud Drive, measured), a chmod, an extended attribute or a Finder tag moves ctime alone, seconds after a save,
 * and that is not a change of the text. Stated limits (docs/contracts/anchors.md): a program that rewrites the file in place within one
 * timestamp tick and restores the same bytes (on HFS+, FAT, exFAT and some network shares the tick is long), and one that restores
 * identical bytes AND sets the modification time back to the exact nanosecond on purpose.
 */
export const stampOf = (st) => `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}`;

/**
 * readOwned, with the file's identity: {bytes, stamp}. The stamp is taken twice from the SAME descriptor the bytes are read from, before
 * and after the read; when the two differ (the file was written meanwhile) it is read again, at most `tries` times, then refused
 * (UNSTABLE). So the bytes and the stamp always belong together.
 */
export function readStamped(file, max = MAX_DOC_BYTES, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const dir0 = dirIdOf(file);
    let fd;
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    } catch (err) {
      if (err.code === "ELOOP") throw Object.assign(new Error(`${file} is a symbolic link`), { code: "SYMLINK" });
      throw err;
    }
    try {
      hooks.readOpened?.({ file }); // tests: an outside save between the open and the first stat
      const a = fs.fstatSync(fd, { bigint: true });
      if (!a.isFile()) throw Object.assign(new Error(`${file} is not a regular file`), { code: "NOT_REGULAR" });
      if (Number(a.uid) !== process.getuid()) throw Object.assign(new Error(`${file} is not owned by the current user`), { code: "NOT_OWNED" });
      if (a.size > BigInt(max)) throw tooLarge(file, max);
      const bytes = readAllAt(fd, Number(a.size));
      const b = fs.fstatSync(fd, { bigint: true });
      // the stamp names the parent folder too (its device and inode, not followed): a swapped folder or a folder symlink is another file
      // ... and after the read, the pathname still names the inode that was read (an outside save renamed onto it meanwhile is another file)
      const named = fs.lstatSync(file, { bigint: true });
      if (stampOf(a) === stampOf(b) && bytes.length === Number(b.size) && dirIdOf(file) === dir0 && stampOf(named) === stampOf(b)) return { bytes, stamp: `${stampOf(b)}|${dir0}` };
    } finally {
      fs.closeSync(fd);
    }
  }
  throw Object.assign(new Error(`${file} kept changing while it was read`), { code: "UNSTABLE" });
}

/** The parent folder's device and inode as the path names it (lstat: a symlink in its place is its own inode). */
function dirIdOf(file) {
  const d = fs.lstatSync(path.dirname(file), { bigint: true });
  return `${d.dev}:${d.ino}`;
}

/** All of the file behind `fd` from offset 0 (at most `size` plus whatever was appended meanwhile: the caller compares sizes). */
function readAllAt(fd, size) {
  const chunks = [];
  let total = 0;
  let pos = 0;
  const buf = Buffer.alloc(Math.max(64 * 1024, Math.min(size + 1, 1 << 24)));
  for (;;) {
    const n = fs.readSync(fd, buf, 0, buf.length, pos);
    if (!n) break;
    chunks.push(Buffer.from(buf.subarray(0, n)));
    total += n;
    pos += n;
    if (total > size + (1 << 20)) break; // still growing: the stamps will differ and the read is retried
  }
  return Buffer.concat(chunks, total);
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
  let retriedStale = false;
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
    } catch {} // it may have been released, or its pid may be unreadable
    if (stale) {
      let removed = false;
      try {
        fs.unlinkSync(lock);
        removed = true;
      } catch {}
      // The lock just removed was stale, so it is free now: try once more at once, even with no wait left (waitMs: 0).
      // At most one such immediate retry per call, so a lock that keeps reappearing stale cannot spin here.
      if (removed && !retriedStale) {
        retriedStale = true;
        continue;
      }
    }
    if (Date.now() >= deadline) throw new LockBusy(file);
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
function stage(file, bytes, before, keep = false) {
  let kept = null;
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
    } else fd = fs.openSync(tmp, keep ? "wx+" : "wx", 0o600);
    writeFully(fd, bytes, hooks.write || fs.writeSync);
    fs.fchmodSync(fd, before.mode & 0o7777);
    fs.fsyncSync(fd);
    // `keep` (the Markdown writer): the descriptor that wrote the staged bytes stays open, so what is checked and published is that file
    kept = keep ? fd : null;
    if (!keep) fs.closeSync(fd);
    fd = undefined;
    let xattrs = "preserved by cp -p";
    if (!cloned) xattrs = copyXattrs(file, tmp);
    let acl = process.platform === "darwin" ? "none" : "not applicable";
    if (origAcl) {
      if (aclOf(tmp) !== origAcl) throw Object.assign(new Error("this file has an access control list that could not be preserved, so it was not replaced"), { code: "ACL_NOT_PRESERVED" });
      acl = "preserved";
    }
    return { tmp, info: { mode: before.mode & 0o7777, xattrs, acl }, ...(keep ? { fd: kept } : {}) };
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
    if (kept !== null) {
      try {
        fs.closeSync(kept);
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
export function replaceGuarded(file, bytes, { expectSha = null, expectStamp = null, snapshotBefore = null, snapshotNewer = null, waitMs } = {}) {
  // a Markdown write (src/session.js): its own path, so the other formats keep exactly the writer they always had
  if (expectStamp != null) return replaceRecorded(file, bytes, { expectSha, expectStamp, snapshotBefore, snapshotNewer, waitMs });
  const release = acquireLock(file, { waitMs });
  try {
    const before = checkRegularOwned(file);
    const disk = readOwned(file);
    const diskSha = sha256(disk);
    if (expectSha != null && diskSha !== expectSha) throw new WriteConflict(diskSha, expectSha, false);
    snapshotBefore?.(disk);
    const { tmp, info } = stage(file, bytes, before);
    try {
      hooks.beforeRename?.({ file, tmp });
      checkRegularOwned(file);
      const now = readOwned(file);
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
    } catch (err) {
      if (err?.code !== "EINVAL" && err?.code !== "ENOTSUP" && err?.code !== "EPERM" && err?.code !== "EROFS") throw err;
    } finally {
      fs.closeSync(dfd);
    }
    return { ...info, previousSha: diskSha };
  } finally {
    release();
  }
}

/**
 * The Markdown writer (replaceGuarded with `expectStamp`): the same lock, compare-and-swap, staging and rename, plus the file's record.
 *  1. under the lock: the file's bytes AND stamp (src/fsutil.js readStamped: leaf and parent folder) must be the expected ones;
 *  2. stage with the descriptor that writes the staged bytes kept open; re-read the target (bytes and stamp again);
 *  3. before publication: the staged pathname must still name that descriptor's inode, its bytes read back through it equal to what was
 *     written, its stamp the same before and after that read, the folder the same. Any difference refuses: nothing is published;
 *  4. rename. From that moment the write is published and this function never throws: every later step only decides the outcome.
 *     "confirmed": the descriptor and a stat of the final pathname both show exactly the stamp taken before publication, in the same
 *     folder, and the folder was flushed. "content_unconfirmed": anything else about the bytes. "durability_unconfirmed": the bytes are
 *     confirmed but the folder flush failed or is not supported, or a descriptor did not close.
 * Returns {mode, xattrs, acl, previousSha, record ({sha, stamp} or null), outcome}.
 */
function replaceRecorded(file, bytes, { expectSha, expectStamp, snapshotBefore = null, snapshotNewer = null, waitMs } = {}) {
  const release = acquireLock(file, { waitMs });
  let staged = null;
  let tmp = null;
  let info = {};
  let published = false;
  try {
    const before = checkRegularOwned(file);
    const first = readStamped(file);
    const diskSha = sha256(first.bytes);
    if (diskSha !== expectSha || first.stamp !== expectStamp) throw new WriteConflict(diskSha, expectSha ?? diskSha, false);
    snapshotBefore?.(first.bytes);
    const st = stage(file, bytes, before, true);
    tmp = st.tmp;
    staged = st.fd;
    info = st.info;
    hooks.beforeRename?.({ file, tmp });
    checkRegularOwned(file);
    const again = readStamped(file);
    const nowSha = sha256(again.bytes);
    if (nowSha !== diskSha || again.stamp !== first.stamp) {
      try {
        snapshotNewer?.(again.bytes);
      } catch {} // the newer bytes stay on disk untouched either way
      throw new WriteConflict(nowSha, expectSha ?? diskSha, true);
    }
    const dir = expectStamp.slice(expectStamp.indexOf("|") + 1);
    const a = fs.fstatSync(staged, { bigint: true });
    hooks.stageReadBack?.({ file, tmp }); // tests: the staged name changed during the read-back
    const back = readAllAt(staged, Number(a.size));
    const b = fs.fstatSync(staged, { bigint: true });
    // after all read-back: the staged NAME still names the descriptor that wrote it, and the target name the descriptor that was checked
    const named = fs.lstatSync(tmp, { bigint: true });
    const target = fs.lstatSync(file, { bigint: true });
    if (stampOf(named) !== stampOf(b) || stampOf(a) !== stampOf(b) || !back.equals(bytes) || `${stampOf(target)}|${dirIdOf(file)}` !== again.stamp) throw new WriteConflict(nowSha, expectSha ?? diskSha, true); // nothing is published
    const pre = { sha: sha256(bytes), stamp: `${stampOf(b)}|${dir}` };
    hooks.afterStageCheck?.({ file, tmp });
    if (dirIdOf(file) !== dir) throw new WriteConflict(nowSha, expectSha ?? diskSha, true); // the folder, immediately before the rename
    fs.renameSync(tmp, file);
    published = true;
    // confirmation: the actual bytes, on the kept descriptor and on the final named leaf (read through its own descriptor, with its
    // stamp and its folder), all exactly what was written and the stamp taken before publication
    let record = null;
    try {
      hooks.afterRename?.({ file });
      const c = fs.fstatSync(staged, { bigint: true });
      const kept = readAllAt(staged, Number(c.size));
      const leaf = readStamped(file);
      if (`${stampOf(c)}|${dir}` === pre.stamp && kept.equals(bytes) && leaf.stamp === pre.stamp && leaf.bytes.equals(bytes) && dirIdOf(file) === dir) record = pre;
    } catch {
      record = null;
    }
    // the folder flush, on a descriptor verified to be the folder the file was published in
    let durable = true;
    try {
      hooks.beforeFlush?.({ file }); // tests: the folder moved after the confirmation
      const dfd = fs.openSync(path.dirname(file), "r");
      try {
        const d = fs.fstatSync(dfd, { bigint: true });
        if (`${d.dev}:${d.ino}` !== dir) throw new Error("the folder is not the one the file was published in");
        if (hooks.dirFsync) hooks.dirFsync(dfd);
        else fs.fsyncSync(dfd);
      } finally {
        fs.closeSync(dfd);
      }
    } catch {
      durable = false; // any failure, also a flush the filesystem does not support: the save is not confirmed to survive a crash
    }
    try {
      const fd = staged;
      staged = null;
      fs.closeSync(fd);
    } catch {
      durable = false;
    }
    return { ...info, previousSha: diskSha, record, outcome: !record ? "content_unconfirmed" : !durable ? "durability_unconfirmed" : "confirmed" };
  } catch (err) {
    if (published) return { previousSha: null, record: null, outcome: "content_unconfirmed" };
    if (tmp) fs.rmSync(tmp, { force: true });
    throw err;
  } finally {
    if (staged !== null) {
      try {
        fs.closeSync(staged);
      } catch {}
    }
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
        if (err.code === "ENOTSUP" || err.code === "EXDEV" || err.code === "EPERM") {
          try {
            fs.copyFileSync(tmp, dest, fs.constants.COPYFILE_EXCL);
            return { name, path: dest };
          } catch (copyErr) {
            if (copyErr.code !== "EEXIST") throw copyErr;
            continue;
          }
        }
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
