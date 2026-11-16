// The faster outside-edit notice (src/watch.js): the folder of the open file is watched, and a settled change Onionskin did not make
// raises `changedOutside` in the view. Toy DOCX files in temp dirs only; real fs.watch except where a failure is injected.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { test, after } from "node:test";
import { tmpdir, docxBytes } from "./helpers/zipbuild.js";

const root = fs.realpathSync(tmpdir());
process.env.ONIONSKIN_STATE_DIR = path.join(root, "st");
process.env.ONIONSKIN_LEASE_MS = "600000";
process.env.ONIONSKIN_NO_SOFFICE = "1";
process.env.ONIONSKIN_NO_OPEN = "1";
delete process.env.ONIONSKIN_PYTHON;
const { Sessions } = await import("../src/session.js");
const { docWatcher } = await import("../src/watch.js");
const { sha256, writeSiblingCopy, lockPathFor } = await import("../src/fsutil.js");
const { ensureStateDir } = await import("../src/paths.js");
ensureStateDir();
after(() => fs.rmSync(root, { recursive: true, force: true }));

const SETTLE = 250; // short window for the suppression tests; the timing test uses the default
const paras = Array.from({ length: 4 }, (_, i) => `Paragraph ${i + 1}: a sentence for the watcher tests, number ${i * 7 + 2}.`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const comment = (id, i) => ({ id, kind: "element", text: "fix", anchor: { location: { blockPath: [i] }, paraText: paras[i] } });

/** A folder of its own with one opened document, a session store and a watcher on it, and every change event recorded. */
function setup(name, opts = { settleMs: SETTLE }) {
  const d = path.join(root, name);
  fs.mkdirSync(d);
  const file = path.join(d, `${name}.docx`);
  fs.writeFileSync(file, docxBytes(paras));
  const S = new Sessions();
  const W = docWatcher(S, opts);
  S.watch = W;
  const s = S.open(file);
  const events = [];
  S.on("change", (_s, ev) => events.push({ ev, outside: S.view(s).changedOutside, at: Date.now() }));
  return { d, file: s.file, S, W, s, events };
}
/** Saves like Word and most apps: a new file written next to it, then renamed over the document (a new inode). */
function saveLikeAnApp(file, bytes) {
  const tmp = path.join(path.dirname(file), `~$save-${Math.random().toString(16).slice(2)}.tmp`);
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, file);
}
async function waitFor(pred, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(25);
  }
  return pred();
}
const raised = (events) => events.some((e) => e.outside === true);

test("an outside save is noticed within the window (default settle), raises only the boolean, and writes nothing", async () => {
  const { file, S, W, s, events } = setup("timing", {});
  try {
    await sleep(300); // FSEvents may report the fixture's own creation just after the watch starts
    const before = S.view(s);
    assert.equal(before.changedOutside, false);
    const theirs = docxBytes(["Someone else rewrote this in Word."]);
    const t0 = Date.now();
    saveLikeAnApp(file, theirs);
    assert.ok(await waitFor(() => raised(events), 6000), "the outside change was raised");
    const ms = events.find((e) => e.outside).at - t0;
    console.log(`# outside change raised after ${ms} ms`);
    assert.ok(ms < 4000, `raised after ${ms} ms (target about 1.5 s; loose bound for a loaded machine)`);
    assert.equal(events.find((e) => e.outside).ev, "state", "a plain state event, never a reload");
    const now = S.view(s);
    assert.equal(now.changedOutside, true);
    const { changedOutside: _a, ...restBefore } = before;
    const { changedOutside: _b, ...restNow } = now;
    assert.deepEqual(restNow, restBefore, "nothing else in the view changed: no name, no path, no hash added");
    assert.ok(fs.readFileSync(file).equals(theirs), "the watcher wrote nothing");
    assert.equal(s.baseSha, sha256(docxBytes(paras)), "the base is not moved by the watcher");
    // the page takes the changed version ("Reload the changed file"): the notice clears
    S.loadForPage(s.key);
    assert.equal(S.view(s).changedOutside, false);
  } finally {
    W.close();
  }
});

test("Onionskin's own saves raise nothing (Send, an agent's write during a run), and an outside save mid-run is still noticed", async () => {
  const { file, S, W, s, events } = setup("own");
  try {
    await sleep(SETTLE + 300);
    events.length = 0;
    // Send with the page's bytes: a new file renamed over the document, a new inode
    const ino0 = fs.statSync(file).ino;
    const mine = docxBytes([...paras.slice(0, 3), "Paragraph 4: edited in the page."]);
    S.send(s.key, { baseSha: s.baseSha, bytes: mine, comments: [] });
    assert.notEqual(fs.statSync(file).ino, ino0, "the own save changed the inode");
    await sleep(SETTLE * 4 + 300);
    assert.equal(raised(events), false, "an own Send raised nothing");
    assert.ok(W.hashes(s.key) <= 1, `hashed at most once for one save (${W.hashes(s.key)})`);
    // an agent's write through the server during a run
    const poll = S.poll(s.key, { holder: "A" });
    S.send(s.key, { baseSha: s.baseSha, comments: [comment("c1", 1)] });
    const batch = await poll.promise;
    const claim = { holder: "A", token: batch.lease.token, batchId: batch.batch_id };
    const agentBytes = docxBytes(["The agent's rewrite."]);
    S.agentWrite(s.key, { baseSha: sha256(mine), bytes: agentBytes, ...claim });
    await sleep(SETTLE * 4 + 300);
    assert.equal(raised(events), false, "an agent write through the server raised nothing");
    assert.equal(S.view(s).changedOutside, false);
    // positive control, mid-run: another program saves while the agent holds the batch
    const theirs = docxBytes(["Someone else saved while the agent worked."]);
    saveLikeAnApp(file, theirs);
    assert.ok(await waitFor(() => raised(events), 5000), "an outside save mid-run is raised");
    const v = S.view(s);
    assert.equal(v.locked, true, "the run is still on: nothing was taken back or forced");
    assert.ok(fs.readFileSync(file).equals(theirs), "the outside version stays on disk untouched");
    // the agent's next write meets the existing guarded replace: refused, its version saved as a sibling copy
    assert.throws(
      () => S.agentWrite(s.key, { bytes: docxBytes(["The agent's second rewrite."]), ...claim }),
      (e) => e.status === 409 && e.extra.code === "conflict" && !!e.extra.copy_name
    );
    assert.ok(fs.readFileSync(file).equals(theirs), "still untouched after the refused write");
  } finally {
    W.close();
  }
});

test("lock, temp, sibling-copy and other files in the folder are ignored: nothing is sent", async () => {
  const { d, file, S, W, s, events } = setup("siblings");
  try {
    await sleep(SETTLE + 300);
    events.length = 0;
    const lock = lockPathFor(file);
    fs.writeFileSync(lock, String(process.pid));
    fs.rmSync(lock);
    fs.writeFileSync(path.join(d, `.${path.basename(file)}.${process.pid}.abcdef012345.tmp`), "staging");
    writeSiblingCopy(file, docxBytes(["The held version."]));
    fs.writeFileSync(path.join(d, "other.docx"), docxBytes(["Another document."]));
    fs.writeFileSync(path.join(d, `~$${path.basename(file)}`), "owner file of Word");
    await sleep(SETTLE * 4 + 300);
    assert.deepEqual(events, [], "no change event at all");
    // macOS may also report the document's own name in a burst of folder events; the size, mtime and inode gate keeps that from a hash
    assert.equal(W.hashes(s.key), 0, "the document was not even hashed");
    assert.equal(S.view(s).changedOutside, false);
    // positive control in the same folder
    saveLikeAnApp(file, docxBytes(["The real outside edit."]));
    assert.ok(await waitFor(() => raised(events), 5000), "the document's own change is raised");
  } finally {
    W.close();
  }
});

test("the name filter: another file's names are dropped before any check; the document's own name (NFD too) and a null name are not", async () => {
  let cb;
  const watch = (_dir, _opts, fn) => ((cb = fn), Object.assign(new EventEmitter(), { close() {} }));
  const { d, file, S, W, s, events } = setup("résumé", { settleMs: SETTLE, watch, pollMs: 600000 }); // the lstat fallback is off here: only names decide
  try {
    saveLikeAnApp(file, docxBytes(["Changed, but only other names are reported."]));
    const base = path.basename(file);
    const others = [path.basename(lockPathFor(file)), `.${base}.${process.pid}.abcdef012345.tmp`, `${path.basename(file, ".docx")} (Onionskin copy 2026-11-14 1200).docx`, "~$" + base, "other.docx", path.basename(d)];
    for (const n of others) cb("rename", n);
    await sleep(SETTLE * 3 + 200);
    assert.equal(W.hashes(s.key), 0, "no hash for another file's name");
    assert.deepEqual(events, []);
    cb("rename", base.normalize("NFD")); // macOS can spell the name decomposed
    assert.ok(await waitFor(() => raised(events), 3000), "the document's own name, decomposed, is matched");
    events.length = 0;
    saveLikeAnApp(file, docxBytes(["A second outside save."]));
    cb("change", null); // no name: something in the folder changed
    assert.ok(await waitFor(() => raised(events), 3000), "a null name is checked, and a second unknown version is told again");
  } finally {
    W.close();
  }
});

test("a save whose fs.watch event never arrives is still raised, by the lstat fallback", async () => {
  // a watch that reports nothing at all (measured on a loaded Mac: fs.watch drops about 1 event in 60)
  const watch = () => Object.assign(new EventEmitter(), { close() {} });
  const { file, S, W, s, events } = setup("dropped", { settleMs: SETTLE, watch, pollMs: 300 });
  try {
    await sleep(700);
    assert.deepEqual(events, [], "an unchanged file raises nothing, however often it is checked");
    assert.equal(W.hashes(s.key), 0);
    saveLikeAnApp(file, docxBytes(["Saved outside, and the watch stayed silent."]));
    assert.ok(await waitFor(() => raised(events), 5000), "raised without any watch event");
    assert.equal(S.view(s).changedOutside, true);
    const n = W.hashes(s.key);
    await sleep(1000);
    assert.equal(W.hashes(s.key), n, "the same version is not hashed again on later checks");
  } finally {
    W.close();
  }
});

test("after the page takes an outside version, the next outside save is raised again; an in-place write is noticed too", async () => {
  const { file, S, W, s, events } = setup("again");
  try {
    await sleep(SETTLE + 300);
    events.length = 0;
    saveLikeAnApp(file, docxBytes(["First outside save."]));
    assert.ok(await waitFor(() => raised(events), 5000), "first outside save raised");
    S.loadForPage(s.key); // "Reload the changed file": this version is now known
    assert.equal(S.view(s).changedOutside, false);
    events.length = 0;
    // an app that writes in place (same inode, truncate and write)
    const ino = fs.statSync(file).ino;
    fs.writeFileSync(file, docxBytes(["Second outside save, written in place by another program."]));
    assert.equal(fs.statSync(file).ino, ino, "same inode");
    assert.ok(await waitFor(() => raised(events), 5000), "the second outside save is raised");
    assert.equal(S.view(s).changedOutside, true);
  } finally {
    W.close();
  }
});

test("the document swapped for a symlink is not followed: raised as an outside change, no crash", async () => {
  const { d, file, S, W, s, events } = setup("symlink");
  try {
    await sleep(SETTLE + 300);
    events.length = 0;
    // the link points at a file with the SAME bytes Onionskin knows: following it would look like no change at all
    const elsewhere = path.join(d, "elsewhere.bin");
    fs.writeFileSync(elsewhere, docxBytes(paras));
    const link = path.join(d, "link.tmp");
    fs.symlinkSync(elsewhere, link);
    fs.renameSync(link, file);
    assert.ok(fs.lstatSync(file).isSymbolicLink());
    assert.ok(await waitFor(() => raised(events), 5000), "a symlink in place of the document is raised, not read through");
    assert.equal(S.view(s).changedOutside, true);
    // a folder in its place: no crash either
    fs.rmSync(file);
    fs.mkdirSync(file);
    await sleep(SETTLE * 4 + 300);
    assert.equal(S.view(s).changedOutside, true);
    assert.equal(W.watching(s.key), true, "the watcher is still alive");
  } finally {
    W.close();
  }
});

test("the watcher is closed when the session closes and when it is closed itself (no handle left)", async () => {
  // real fs.watch handles, counted (a non-persistent watch does not show in process.getActiveResourcesInfo)
  let live = 0;
  const watch = (...a) => {
    const h = fs.watch(...a);
    live++;
    const close = h.close.bind(h);
    h.close = () => (live--, close());
    return h;
  };
  const { file, S, W, s, events } = setup("closing", { settleMs: SETTLE, watch });
  try {
    assert.equal(W.watching(s.key), true);
    assert.equal(live, 1, "one watch handle for the open file");
    S.close(s.key);
    assert.equal(W.watching(s.key), false);
    assert.equal(live, 0, "the handle is gone with the session");
    events.length = 0;
    saveLikeAnApp(file, docxBytes(["Changed after the close."]));
    await sleep(SETTLE * 4 + 300);
    assert.equal(raised(events), false, "a closed session is not watched");
    S.open(file); // opened again: watched again
    assert.equal(W.watching(s.key), true);
    assert.equal(live, 1);
  } finally {
    W.close();
  }
  assert.equal(W.watching(s.key), false);
  assert.equal(live, 0, "close() leaves no handle");
});

test("fs.watch failing (throws, or reports an error later) falls back silently to the poll", async () => {
  {
    let calls = 0;
    const { file, S, W, s } = setup("throws", {
      settleMs: SETTLE,
      watch: () => {
        calls++;
        throw Object.assign(new Error("too many open files"), { code: "EMFILE" });
      },
    });
    try {
      assert.equal(W.watching(s.key), false);
      S.setDraft(s.key, { comments: [], note: "a change event" }); // more change events do not retry a failed watch
      assert.equal(calls, 1);
      assert.equal(S.view(s).changedOutside, false);
      fs.writeFileSync(file, docxBytes(["Changed outside."]));
      assert.equal(S.staleCheck(s.key, s.baseSha).stale, true, "the poll still sees it");
    } finally {
      W.close();
    }
  }
  {
    let handle;
    let closed = 0;
    let calls = 0;
    const { S, W, s } = setup("errors", {
      settleMs: SETTLE,
      watch: () => {
        calls++;
        handle = Object.assign(new EventEmitter(), { close: () => closed++ });
        return handle;
      },
    });
    try {
      assert.equal(W.watching(s.key), true);
      handle.emit("error", Object.assign(new Error("watch failed"), { code: "EPERM" }));
      assert.equal(closed, 1, "the failed handle is closed");
      assert.equal(W.watching(s.key), false);
      S.setDraft(s.key, { comments: [], note: "another change event" });
      assert.equal(calls, 1, "not retried");
      assert.equal(S.view(s).changedOutside, false);
    } finally {
      W.close();
    }
  }
});

test("an own version seen by the watcher stays own when the base moves past it before the next settle (merge, Send)", async () => {
  const { file, S, W, s, events } = setup("own-then-base-moves");
  try {
    await sleep(SETTLE + 300);
    // an agent's write through the server: seen and known
    const poll = S.poll(s.key, { holder: "A" });
    S.send(s.key, { baseSha: s.baseSha, comments: [comment("c1", 1)] });
    const batch = await poll.promise;
    const agentBytes = docxBytes(["The agent's rewrite."]);
    S.agentWrite(s.key, { baseSha: s.baseSha, bytes: agentBytes, holder: "A", token: batch.lease.token, batchId: batch.batch_id });
    await waitFor(() => W.hashes(s.key) >= 1, 4000);
    await sleep(SETTLE + 200);
    events.length = 0;
    // the run ends and the base moves on to a version the watcher has not seen yet (what a merge or a Send does, in the same tick as the write)
    S.takeBack(s.key);
    s.baseSha = s.histTip = sha256(docxBytes(["The page's merged version."]));
    assert.equal(S.view(s).changedOutside, false, "the agent's own version on disk is not an outside change");
    // positive control: a real outside save is still raised
    saveLikeAnApp(file, docxBytes(["Someone else saved this."]));
    assert.ok(await waitFor(() => raised(events), 6000), "a real outside save is raised");
  } finally {
    W.close();
  }
});

test("an outside version the page took (Reload) stays taken: the person's own Send after it raises nothing", async () => {
  const { file, S, W, s, events } = setup("taken-reload");
  try {
    await sleep(SETTLE + 300);
    saveLikeAnApp(file, docxBytes(["Someone else rewrote this."]));
    assert.ok(await waitFor(() => raised(events), 5000), "outside save raised");
    const { diskSha } = S.loadForPage(s.key); // "Reload the changed file": no event follows
    events.length = 0;
    S.send(s.key, { baseSha: diskSha, bytes: docxBytes(["The person's own edit after reload."]), comments: [] });
    assert.ok(events.length > 0, "the Send told the page");
    assert.ok(!raised(events), "the person's own Send is not an outside change");
  } finally {
    W.close();
  }
});

test("an outside version a finished run took in (done) stays taken: the next Send with typed bytes raises nothing", async () => {
  const { file, S, W, s, events } = setup("taken-done");
  try {
    await sleep(SETTLE + 300);
    const poll = S.poll(s.key, { holder: "A" });
    S.send(s.key, { baseSha: s.baseSha, comments: [comment("c1", 1)] });
    const batch = await poll.promise;
    saveLikeAnApp(file, docxBytes(["Outside, mid-run."]));
    assert.ok(await waitFor(() => S.view(s).changedOutside, 5000), "mid-run outside save raised");
    S.done(s.key, { results: [] }, { holder: "A", token: batch.lease.token, batchId: batch.batch_id });
    assert.equal(S.view(s).changedOutside, false, "done took the disk version in");
    events.length = 0;
    S.send(s.key, { baseSha: sha256(fs.readFileSync(file)), bytes: docxBytes(["My edit after the run."]), comments: [comment("c2", 0)] });
    assert.ok(events.length > 0, "the Send told the page");
    assert.ok(!raised(events), "the person's own Send is not an outside change");
  } finally {
    W.close();
  }
});

test("an outside save that puts back an older version from History is still raised", async () => {
  const { file, S, W, s, events } = setup("restore-old");
  try {
    await sleep(SETTLE + 300);
    const opened = fs.readFileSync(file);
    S.send(s.key, { baseSha: s.baseSha, bytes: docxBytes(["The person's edit."]), comments: [] });
    await sleep(SETTLE + 300);
    assert.ok(!raised(events), "own Send raised nothing");
    events.length = 0;
    saveLikeAnApp(file, opened); // someone restores the version the file was opened with
    assert.ok(await waitFor(() => raised(events), 5000), "the restore is raised");
  } finally {
    W.close();
  }
});
