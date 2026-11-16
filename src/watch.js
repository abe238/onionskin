// A faster outside-edit notice. For each open session, the folder of the document's real path is watched (not recursive) and only
// events for the document's own name are kept. When the file settles (same size for `settleMs`) and its size, mtime or inode moved,
// it is hashed once. A hash Onionskin knows (the session's base, the version history knows, the last write of the run in flight) is
// one of its own saves and raises nothing; any other content raises the existing outside-change notice (`changedOutside` in the view).
// It never writes, never reads past a symlink, and never puts a name or a path anywhere: only a boolean reaches the view.
// A missed fs.watch event is caught by an lstat every POLL_MS (the same settle then runs).
// Ceiling: fs.watch can repeat or miss events on synced folders (iCloud Drive, Dropbox, network volumes), and hashing a file the sync
// client evicted forces it to download. The page's 30 s /api/stale poll stays the backstop; when fs.watch throws or reports an error,
// the watcher for that file stops silently and only the poll remains. Upgrade path: none needed for local folders.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { MAX_DOC_BYTES } from "./constants.js";

const SETTLE_MS = 1000;
// fs.watch drops an event now and then on a loaded Mac (measured: 1 of 60 saves gave none). A plain lstat every POLL_MS is the second
// signal: when the file's size, mtime or inode moved and no check is pending, the same settle runs. One lstat per open file, no read.
const POLL_MS = 2000;
// stands for content that is not a regular file we may read (a symlink, a folder, too large): never a hash Onionskin knows
const NOT_A_FILE = "not-a-regular-file";

/** The versions of the file Onionskin itself holds or wrote. Every write path sets one of these in the same tick as its rename. */
function known(s) {
  return new Set([s.baseSha, s.histTip, s.delivered?.knownSha, s.delivered?.preSha].filter(Boolean));
}

/** The hash of `file`, read without following a symlink and only when it is still the regular file lstat saw; NOT_A_FILE otherwise. */
async function hashOf(file, st) {
  let fh;
  try {
    // O_NONBLOCK: a FIFO swapped in after the lstat must not hold a threadpool thread forever (fstat below refuses it); no effect on a regular file
    fh = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const fst = await fh.stat();
    if (!fst.isFile() || fst.ino !== st.ino || fst.dev !== st.dev || fst.size > MAX_DOC_BYTES) return NOT_A_FILE;
    return crypto.createHash("sha256").update(await fh.readFile()).digest("hex");
  } catch (err) {
    if (err.code === "ELOOP" || err.code === "EISDIR") return NOT_A_FILE; // swapped for a symlink (or a folder) after the lstat
    return null; // gone (mid-rename) or unreadable: the next event or the poll decides
  } finally {
    await fh?.close().catch(() => {});
  }
}

/**
 * Starts a watcher for each open session and stops it when the session closes. Returns {outside(s), close()}. `watch` and `settleMs`
 * are test seams. `outside(s)` is true when the last settled content on disk is one Onionskin does not know.
 */
export function docWatcher(sessions, { watch = fs.watch, settleMs = SETTLE_MS, pollMs = POLL_MS } = {}) {
  const entries = new Map(); // key -> {file, base, handle, timer, eventSize, last, observed, hashing, again, failed, hashes}
  const stopHandle = (e) => {
    clearTimeout(e.timer);
    e.timer = null;
    clearInterval(e.poll);
    e.poll = null;
    try {
      e.handle?.close();
    } catch {}
    e.handle = null;
  };
  // Whether a version is Onionskin's own is decided when it is seen (`foreign`): the base moves on (a merge, a Send, done) before the next
  // settle sees the new file, and the agent's own earlier version must not read as an outside change in that window. Once Onionskin takes
  // the version in (the page's Reload, a run's done), it is its own for good: `taken` is called then, so the next own write, which moves the
  // base past it before the next settle, does not raise it again.
  const outside = (s) => {
    const e = entries.get(s.key);
    return !!(e?.observed && e.foreign && !s.closed && !known(s).has(e.observed));
  };
  const taken = (s) => {
    const e = entries.get(s.key);
    if (e?.foreign && known(s).has(e.observed)) e.foreign = false;
  };
  const statOf = (file) => {
    try {
      return fs.lstatSync(file);
    } catch {
      return null;
    }
  };
  const later = (key, ms) => {
    const e = entries.get(key);
    clearTimeout(e.timer);
    e.timer = setTimeout(() => settle(key).catch(() => {}), ms).unref(); // a failing listener must never take the server down
  };
  async function settle(key) {
    const e = entries.get(key);
    const s = sessions.map.get(key);
    if (!e || !e.handle || !s || s.closed) return;
    e.timer = null;
    if (e.hashing) {
      e.again = true; // one hash at a time: this check runs again when the current one ends
      return;
    }
    const st = statOf(e.file);
    if (!st) return; // gone for now (an app saving by rename): its next event brings it back
    let observed;
    if (st.isSymbolicLink() || !st.isFile()) observed = NOT_A_FILE;
    else {
      if (st.size !== e.eventSize) {
        // still being written: wait until the size holds for a whole window
        e.eventSize = st.size;
        return later(key, settleMs);
      }
      if (e.last && st.size === e.last.size && st.mtimeMs === e.last.mtimeMs && st.ino === e.last.ino && st.dev === e.last.dev) return; // nothing moved
      e.hashes++;
      e.hashing = true;
      try {
        observed = await hashOf(e.file, st);
      } finally {
        e.hashing = false;
      }
      if (entries.get(key) !== e || !e.handle) return; // closed while hashing
      if (e.again || e.timer) {
        // the file moved again while it was hashed: this result may be old, the next check decides
        e.again = false;
        if (!e.timer) later(key, 0);
        return;
      }
      if (observed == null) return;
      e.last = { size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, dev: st.dev };
    }
    const was = outside(s);
    const prev = e.observed;
    e.observed = observed;
    e.foreign = !known(s).has(observed);
    const now = outside(s);
    // told when the notice turns on or off, and again for each new version Onionskin does not know (a second outside save)
    if (now !== was || (now && observed !== prev)) sessions.emit("change", s, "state");
  }
  function start(s) {
    const e0 = entries.get(s.key);
    if (e0 && (e0.handle || e0.failed) && e0.file === s.file) return;
    if (e0) stopHandle(e0);
    const st = statOf(s.file);
    // the identity at open: an event that leaves it as it is (same size, mtime, inode) is not hashed
    const e = { file: s.file, base: path.basename(s.file).normalize("NFC"), handle: null, timer: null, poll: null, eventSize: null, last: st?.isFile() ? { size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, dev: st.dev } : null, observed: null, foreign: false, hashing: false, again: false, failed: false, hashes: 0 };
    entries.set(s.key, e);
    const fail = () => {
      stopHandle(e);
      e.failed = true; // the page's poll is the only check for this file from now on
    };
    try {
      e.handle = watch(path.dirname(s.file), { persistent: false, recursive: false }, (_type, name) => {
        // macOS may report the name decomposed (NFD); a null name means "something in the folder changed"
        if (name != null && String(name).normalize("NFC") !== e.base) return;
        e.eventSize = statOf(e.file)?.size ?? null;
        later(s.key, settleMs);
      });
      e.handle.on?.("error", fail);
      e.poll = setInterval(() => {
        if (e.timer || e.hashing) return; // a check is already on its way
        const now = statOf(e.file);
        if (!now || (e.last && now.size === e.last.size && now.mtimeMs === e.last.mtimeMs && now.ino === e.last.ino && now.dev === e.last.dev)) return;
        e.eventSize = now.size;
        later(s.key, settleMs);
      }, pollMs).unref();
    } catch {
      fail();
    }
  }
  function stop(key) {
    const e = entries.get(key);
    if (!e) return;
    stopHandle(e);
    entries.delete(key);
  }
  const onChange = (s) => {
    if (s.closed) return stop(s.key);
    taken(s); // a run's done took the disk version in as its base
    start(s);
  };
  const onClosed = (s) => stop(s.key);
  sessions.on("change", onChange);
  sessions.on("closed", onClosed);
  return {
    outside,
    /** Sessions.loadForPage: the page took the version on disk (it sends no change event) */
    taken,
    /** test seam: whether a live watcher handle is open for this key */
    watching: (key) => !!entries.get(key)?.handle,
    /** test seam: how many times this key's file was hashed */
    hashes: (key) => entries.get(key)?.hashes ?? 0,
    close() {
      sessions.off("change", onChange);
      sessions.off("closed", onClosed);
      for (const key of [...entries.keys()]) stop(key);
    },
  };
}
