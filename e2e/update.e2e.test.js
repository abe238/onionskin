// `onionskin update` end to end: two releases built from this tree by the repo's own packager (scripts/package.mjs, run in a temp copy),
// the old one installed into a temp HOME through get.sh, then `update --check` and `update` run from another folder with
// ONIONSKIN_BASE_URL=file://<new release>. A real server with a real session shows the refusal while a draft comment or the page is open.
// Temp dirs only, a minimal environment for every command (never the real HOME), no network (the PyPI step is skipped, no agent starts).
// In the e2e group because the packager compiles the helper for Apple's model twice (about 10 s each); it needs swiftc.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { docxBytes } from "../test/helpers/zipbuild.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skip = spawnSync("/usr/bin/xcode-select", ["-p"]).status === 0 ? false : "the macOS developer tools (swiftc) are missing: scripts/package.mjs cannot build the helper";
const nodeDir = path.dirname(process.execPath);

describe("onionskin update: an installer copy goes from one release to the next", { skip }, () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "os-update-e2e-")));
  const HOME = path.join(tmp, "home");
  const ELSEWHERE = path.join(tmp, "elsewhere"); // the working folder of every command: not the app, not HOME
  const launcher = path.join(HOME, ".local", "bin", "onionskin");
  const env = (extra = {}) => ({
    HOME, TMPDIR: path.join(tmp, "tmpdir"), PATH: `${nodeDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
    ONIONSKIN_BASE_PYTHON: "onionskin-no-python-here", // install.sh's PyPI step finds no python and skips: no network
    ONIONSKIN_AGENT_CLI: "none", // no background agent
    ...extra,
  });
  const exec = (cmd, args, extra = {}, cwd = ELSEWHERE) =>
    new Promise((resolve) => {
      const c = spawn(cmd, args, { cwd, env: env(extra), stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      c.stdout.on("data", (d) => (out += d));
      c.stderr.on("data", (d) => (out += d));
      c.on("close", (status) => resolve({ status, out }));
    });
  let oldV, newV, nextV, relOld, relNew, relNext;
  const COMMENT = { id: "c1", kind: "text", text: "Make this shorter.", anchor: { location: { blockPath: [0] }, quote: "First paragraph.", prefix: "", suffix: "" } };

  /** The page's side of a session opened at `url` (the launch URL `open` prints): the nonce exchange, then draft and bootstrap calls. */
  async function pageOf(url) {
    const page = (opts, body) =>
      new Promise((resolve, reject) => {
        const r = http.request({ host: "127.0.0.1", port: url.port, ...opts }, (res) => {
          let t = "";
          res.on("data", (d) => (t += d));
          res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: t }));
        });
        r.on("error", reject);
        if (body) r.write(body);
        r.end();
      });
    const first = await page({ path: url.pathname + url.search, method: "GET" });
    const cookie = first.headers["set-cookie"][0].split(";")[0];
    const token = /<meta name="onionskin-launch" content="([\w-]+)">/.exec(first.text)?.[1];
    assert.ok(token, "the page carries its launch token");
    const s = url.searchParams.get("s");
    const hdr = { cookie, "x-onionskin-token": token, origin: `http://127.0.0.1:${url.port}`, "sec-fetch-site": "same-origin", "content-type": "application/json" };
    return {
      draft: (comments) => page({ path: `/api/draft?s=${s}`, method: "POST", headers: hdr }, JSON.stringify({ comments, note: "" })),
      bootstrap: () => page({ path: `/api/bootstrap?s=${s}`, method: "GET", headers: hdr }),
      close: () => page({ path: `/api/close?s=${s}`, method: "POST", headers: hdr }, "{}"), // the page's Close session
    };
  }

  /** Copies this tree (tracked and new files, never ignored ones) to a temp folder, stamps `version`, runs the packager there, lays out a release folder. */
  function release(version) {
    const copy = path.join(tmp, `src-${version}`);
    const files = spawnSync("/usr/bin/git", ["-C", repo, "ls-files", "-co", "--exclude-standard", "-z"], { encoding: "utf8" }).stdout.split("\0").filter(Boolean);
    for (const f of files) {
      const from = path.join(repo, f);
      if (!fs.existsSync(from) || fs.lstatSync(from).isSymbolicLink() || !fs.statSync(from).isFile()) continue;
      fs.mkdirSync(path.dirname(path.join(copy, f)), { recursive: true });
      fs.copyFileSync(from, path.join(copy, f));
    }
    // the built web app when there is one (npm test builds it first); otherwise a one-line page, enough for install.sh's check
    const dist = path.join(repo, "web", "dist");
    if (fs.existsSync(path.join(dist, "index.html"))) fs.cpSync(dist, path.join(copy, "web", "dist"), { recursive: true });
    else (fs.mkdirSync(path.join(copy, "web", "dist"), { recursive: true }), fs.writeFileSync(path.join(copy, "web", "dist", "index.html"), "<!doctype html><title>t</title>"));
    const pj = path.join(copy, "package.json");
    fs.writeFileSync(pj, JSON.stringify({ ...JSON.parse(fs.readFileSync(pj, "utf8")), version }, null, 2) + "\n");
    const p = spawnSync(process.execPath, [path.join(copy, "scripts", "package.mjs"), "--skip-build"], { cwd: copy, encoding: "utf8", env: { HOME: path.join(tmp, "pack-home"), TMPDIR: path.join(tmp, "tmpdir"), PATH: process.env.PATH } });
    assert.equal(p.status, 0, p.stdout + p.stderr);
    const out = path.join(copy, "dist-zip");
    const zip = fs.readdirSync(out).find((n) => /^onionskin-.*\.zip$/.test(n));
    const rel = path.join(tmp, `release-${version}`);
    fs.mkdirSync(rel);
    fs.copyFileSync(path.join(out, zip), path.join(rel, "onionskin.zip"));
    fs.copyFileSync(path.join(out, `${zip}.sha256`), path.join(rel, "onionskin.zip.sha256"));
    fs.copyFileSync(path.join(out, "version.txt"), path.join(rel, "version.txt"));
    fs.copyFileSync(path.join(repo, "scripts", "get.sh"), path.join(rel, "get.sh"));
    assert.equal(fs.readFileSync(path.join(rel, "version.txt"), "utf8"), `${version}\n`, "the packager writes version.txt");
    return rel;
  }

  before(() => {
    for (const d of [HOME, ELSEWHERE, path.join(tmp, "tmpdir"), path.join(tmp, "pack-home")]) fs.mkdirSync(d, { recursive: true });
    oldV = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")).version;
    const [a, b, c] = oldV.split(/[.-]/).map(Number);
    newV = `${a}.${b}.${c + 1}`;
    nextV = `${a}.${b}.${c + 2}`;
    relOld = release(oldV);
    relNew = release(newV);
    relNext = release(nextV);
  });
  after(async () => {
    if (fs.existsSync(launcher)) await exec(launcher, ["stop"]); // no server outlives the test
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("install the old release, then --check, a refusal while a draft comment is open, the update, and a second update that changes nothing", async () => {
    // 1. the old release, installed as the README says (the script piped into sh)
    const inst = await exec("/bin/sh", ["-c", `/bin/cat "${relOld}/get.sh" | ONIONSKIN_BASE_URL="file://${relOld}" sh`]);
    assert.equal(inst.status, 0, inst.out);
    assert.match(inst.out, /checksum ok/);
    assert.equal((await exec(launcher, ["--version"])).out, `${oldV}\n`);

    // 2. state to keep: a real session (server running), and a file of the person's own in the state folder
    const doc = path.join(ELSEWHERE, "report.docx");
    fs.writeFileSync(doc, docxBytes(["First paragraph.", "Second paragraph."]));
    const open = await exec(launcher, ["open", doc, "--no-open"]);
    assert.equal(open.status, 0, open.out);
    const url = new URL(open.out.split("\n")[1]);
    const keep = path.join(HOME, ".onionskin", "keep-me.txt");
    fs.writeFileSync(keep, "snapshot stand-in");
    const sessionsDir = path.join(HOME, ".onionskin", "sessions");
    const sessionFiles = fs.readdirSync(sessionsDir);
    assert.equal(sessionFiles.length, 1);

    // 3. --check
    const check = await exec(launcher, ["update", "--check"], { ONIONSKIN_BASE_URL: `file://${relNew}` });
    console.log(`$ onionskin update --check\n${check.out}`);
    assert.equal(check.status, 0, check.out);
    assert.equal(check.out, `This copy: Onionskin ${oldV}\nLatest release: ${newV}\nAn update is available: run onionskin update\n`);

    // 4. a draft comment in the page: update refuses and changes nothing
    const { draft, bootstrap, close } = await pageOf(url);
    assert.equal((await draft([COMMENT])).status, 200);
    const refused = await exec(launcher, ["update"], { ONIONSKIN_BASE_URL: `file://${relNew}` });
    console.log(`$ onionskin update   (a draft comment is open)\n${refused.out}`);
    assert.equal(refused.status, 1, refused.out);
    assert.match(refused.out, /Not updated: Onionskin is running with open work that the update would cut off: 1 file open in a browser tab now or in the last 20 minutes \(edits typed there stay in the tab until Send\), 1 draft comment\..*press Close session in the file's page \(or close its tab and wait 20 minutes\).*onionskin update --force\. Nothing was changed\.\n$/);
    assert.equal((await exec(launcher, ["--version"])).out, `${oldV}\n`, "still the old copy");
    assert.equal((await bootstrap()).status, 200, "the server and the page's session are still up");

    // 5. the comment is gone (deleted in the page): the page is still open, so update still refuses; after Close session in the page, update
    // stops the server, runs get.sh from the new release, reports old and new
    assert.equal((await draft([])).status, 200);
    const stillOpen = await exec(launcher, ["update"], { ONIONSKIN_BASE_URL: `file://${relNew}` });
    assert.equal(stillOpen.status, 1, stillOpen.out);
    assert.match(stillOpen.out, /cut off: 1 file open in a browser tab now or in the last 20 minutes/);
    assert.equal((await close()).status, 200);
    const up = await exec(launcher, ["update"], { ONIONSKIN_BASE_URL: `file://${relNew}` });
    console.log(`$ onionskin update\n${up.out}`);
    assert.equal(up.status, 0, up.out);
    assert.match(up.out, /Stopped the Onionskin server for the update\.\n/);
    assert.match(up.out, /checksum ok/, "get.sh checked the new zip");
    assert.ok(up.out.trimEnd().endsWith(`UPDATED: Onionskin ${oldV} -> ${newV}. Snapshots and settings in ~/.onionskin were kept.\nThe server was stopped; it starts again on the next onionskin command. Open your file again to keep working.\nAGENT: this was an update. Tell the person this one sentence, and not the installer's sentence above: Onionskin is updated to ${newV}.`), up.out.slice(-600));
    assert.equal((await exec(launcher, ["--version"])).out, `${newV}\n`, "the installed launcher runs the new copy");
    assert.deepEqual(fs.readdirSync(path.join(HOME, ".onionskin", "app")), [newV], "the old app folder was replaced");
    assert.equal(fs.readFileSync(keep, "utf8"), "snapshot stand-in", "the state folder kept the person's file");
    assert.deepEqual(fs.readdirSync(sessionsDir), sessionFiles, "the session was kept");
    assert.equal(fs.existsSync(path.join(HOME, ".onionskin", "s.sock")), false, "the old server is gone");
    for (const d of [".claude/skills/onionskin/SKILL.md", ".agents/skills/onionskin/SKILL.md"]) assert.ok(fs.existsSync(path.join(HOME, d)), d);

    // 6. once more: already up to date, nothing runs
    const again = await exec(launcher, ["update"], { ONIONSKIN_BASE_URL: `file://${relNew}` });
    console.log(`$ onionskin update   (again)\n${again.out}`);
    assert.equal(again.status, 0, again.out);
    assert.equal(again.out, `This copy: Onionskin ${newV}\nLatest release: ${newV}\nAlready up to date: Onionskin ${newV} is the latest release. Nothing was changed.\n`);

    // 7. --force, as the refusal says: the file open again with a draft comment, and a newer release out. It updates, and the draft is kept on disk
    const reopen = await exec(launcher, ["open", doc, "--no-open"]);
    assert.equal(reopen.status, 0, reopen.out);
    const p2 = await pageOf(new URL(reopen.out.split("\n")[1]));
    assert.equal((await p2.draft([COMMENT])).status, 200);
    assert.equal((await exec(launcher, ["update"], { ONIONSKIN_BASE_URL: `file://${relNext}` })).status, 1, "refused first");
    const forced = await exec(launcher, ["update", "--force"], { ONIONSKIN_BASE_URL: `file://${relNext}` });
    console.log(`$ onionskin update --force   (a draft comment is open)\n${forced.out}`);
    assert.equal(forced.status, 0, forced.out);
    assert.match(forced.out, /Stopped the Onionskin server for the update \(--force: open work that the update would cut off: 1 file open in a browser tab now or in the last 20 minutes \(edits typed there stay in the tab until Send\), 1 draft comment\)\./);
    assert.equal((await exec(launcher, ["--version"])).out, `${nextV}\n`);
    const saved = JSON.parse(fs.readFileSync(path.join(sessionsDir, sessionFiles[0]), "utf8"));
    assert.deepEqual(saved.comments.map((c) => [c.id, c.status, c.text]), [["c1", "draft", "Make this shorter."]], "the draft comment is still in the session on disk");
  });
});
