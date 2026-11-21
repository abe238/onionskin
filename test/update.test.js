// `onionskin update` (src/update.js): route detection, version comparison, the version.txt check and the refusal while work is open.
// Temp dirs only; the one network-shaped check is a server on 127.0.0.1 inside this process and file:// URLs. Nothing runs get.sh or npm.
import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { NPM_COMMANDS, baseUrlOk, compareVersions, detectRoute, fetchLatest, parseVersionText, runGetShDefault, updateCommand, workAtRisk } from "../src/update.js";
import { openWork } from "../src/local.js";
import { tmpdir } from "./helpers/zipbuild.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(repo, "src", "cli.js");
const root = fs.realpathSync(tmpdir("os-update-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const mk = (...p) => {
  const d = path.join(root, ...p);
  fs.mkdirSync(d, { recursive: true });
  return d;
};

test("route: the installer's folder, an npm install, a source checkout (a .git file, as in a worktree) and anything else", () => {
  const home = mk("home");
  const inst = mk("home", ".onionskin", "app", "0.0.3");
  assert.equal(detectRoute({ appRoot: inst, home }).route, "installer");
  // the same folder reached through a symlinked home still counts
  fs.symlinkSync(home, path.join(root, "home-link"));
  assert.equal(detectRoute({ appRoot: path.join(root, "home-link", ".onionskin", "app", "0.0.3"), home: path.join(root, "home-link") }).route, "installer");
  assert.equal(detectRoute({ appRoot: mk("prefix", "lib", "node_modules", "onionskin-cli"), home }).route, "npm");
  const src = mk("checkout");
  fs.writeFileSync(path.join(src, "package.json"), "{}");
  fs.writeFileSync(path.join(src, ".git"), "gitdir: elsewhere\n");
  assert.equal(detectRoute({ appRoot: src, home }).route, "source");
  assert.equal(detectRoute({ appRoot: mk("Downloads", "onionskin"), home }).route, "unknown", "an unzipped folder run directly");
  assert.equal(detectRoute({ appRoot: mk("home", ".onionskin", "app", "0.0.3", "deeper"), home }).route, "unknown");
  assert.equal(detectRoute({ appRoot: repo, home }).route, "source", "this repository");
});

test("versions: numbers compare as numbers, a pre-release is older than its release, version.txt is untrusted", () => {
  assert.equal(compareVersions("0.0.9", "0.0.10"), -1);
  assert.equal(compareVersions("0.1.0", "0.0.99"), 1);
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
  assert.equal(compareVersions("1.0.0-rc.1", "1.0.0"), -1);
  assert.equal(compareVersions("1.0.0-rc.2", "1.0.0-rc.10"), -1);
  assert.equal(compareVersions("1.0.0", "nonsense"), null);
  // pre-release numbers past 2^53 compare by their digits (outside review: Number() made the newer one older)
  assert.equal(compareVersions("1.0.0-9007199254740992", "1.0.0-9007199254740993"), -1);
  assert.equal(compareVersions("1.0.0-9007199254740993", "1.0.0-9007199254740992"), 1);
  assert.equal(compareVersions("1.0.0-rc.99999999999999999998", "1.0.0-rc.99999999999999999999"), -1);
  assert.equal(compareVersions("1.0.0-rc.01", "1.0.0-rc.1"), 0, "the same number written two ways is the same");
  // a version is 40 characters at most and a pre-release number 20 digits at most, on both sides of a comparison
  assert.equal(compareVersions("1.0.0-rc.123456789012345678901", "1.0.0"), null);
  assert.equal(compareVersions(`1.0.0-${"a".repeat(40)}`, "1.0.0"), null);
  assert.equal(parseVersionText("1.0.0-123456789012345678901"), null);
  assert.equal(parseVersionText("0.0.4\n"), "0.0.4");
  assert.equal(parseVersionText("0.0.4\nextra lines are ignored\n"), "0.0.4");
  for (const bad of ["", "latest", "0.0.4; rm -rf ~", "<html>", "1.2", "9".repeat(50)]) assert.equal(parseVersionText(bad), null, bad);
  for (const ok of ["https://github.com/x", "file:///tmp/rel", "http://127.0.0.1:8080/rel"]) assert.ok(baseUrlOk(ok), ok);
  for (const bad of ["http://example.com", "ftp://x", "/etc", "http://127.0.0.1.evil.example/", "https://a b", "http://127.0.0.1:80@evil.example/release"]) assert.ok(!baseUrlOk(bad), bad);
});

/** `onionskin update --check` from a temp working folder, with a temp HOME and state dir. */
function check(base) {
  const home = mk(`h${Math.random().toString(36).slice(2, 8)}`);
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [cli, "update", "--check"], { cwd: home, env: { HOME: home, PATH: process.env.PATH, ONIONSKIN_STATE_DIR: path.join(home, ".onionskin"), ONIONSKIN_BASE_URL: base }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (out += d));
    c.on("close", (status) => resolve({ status, out, home }));
  });
}

test("--check: version.txt present (newer, same), missing (file:// and a 404 over http), and unreachable", async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")).version;
  const rel = mk("rel-new");
  fs.writeFileSync(path.join(rel, "version.txt"), "99.0.0\n");
  const newer = await check(`file://${rel}`);
  assert.equal(newer.status, 0, newer.out);
  assert.equal(newer.out, `This copy: Onionskin ${pkg}\nLatest release: 99.0.0\nAn update is available: run onionskin update\n`);
  assert.deepEqual(fs.readdirSync(newer.home), [], "a check writes nothing, not even the state folder");
  const same = mk("rel-same");
  fs.writeFileSync(path.join(same, "version.txt"), `${pkg}\n`);
  assert.match((await check(`file://${same}`)).out, /\nUp to date\.\n$/);

  const missing = await check(`file://${mk("rel-0.0.3")}`);
  assert.equal(missing.status, 0, missing.out);
  assert.match(missing.out, /Latest release: unknown \(the release has no version\.txt, as releases up to 0\.0\.3 do not\)\nCould not tell whether an update exists\. Nothing was changed\.\n$/);

  const seen = [];
  const srv = http.createServer((req, res) => (seen.push({ url: req.url, method: req.method, body: req.headers["content-length"] || "0" }), res.writeHead(404).end()));
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  const r404 = await check(`http://127.0.0.1:${port}/rel`);
  assert.equal(r404.status, 0, r404.out);
  assert.match(r404.out, /has no version\.txt/);
  assert.deepEqual(seen, [{ url: "/rel/version.txt", method: "GET", body: "0" }], "one GET of version.txt, with no query and no body");
  await new Promise((r) => srv.close(r));

  const down = await check(`http://127.0.0.1:${port}/rel`); // nothing listens there now
  assert.equal(down.status, 1, down.out);
  assert.match(down.out, /Latest release: unknown \(could not reach http:\/\/127\.0\.0\.1:\d+\/rel\/version\.txt: .+\)\nCould not check for an update\. Nothing was changed\.\n$/);

  const bad = mk("rel-bad");
  fs.writeFileSync(path.join(bad, "version.txt"), "<html>not a version</html>\n");
  assert.match((await check(`file://${bad}`)).out, /does not hold a version\)\nCould not tell/);
  assert.equal((await check("http://example.com/rel")).status, 1, "plain http elsewhere is refused before anything is fetched");
});

test("curl is asked for https and file only (plain http only for 127.0.0.1), and redirects to https only, for version.txt and for get.sh", async () => {
  const seen = [];
  const run = (cmd, args) => (seen.push(args), { status: 0, stdout: "0.0.4\n", stderr: "" });
  fetchLatest("https://example.invalid/rel", { run });
  fetchLatest("http://127.0.0.1:9/rel", { run });
  const flag = (args, f) => args[args.indexOf(f) + 1];
  assert.deepEqual(seen.map((a) => [flag(a, "--proto"), flag(a, "--proto-redir")]), [["=https", "=https"], ["=http", "=https"]]);
  // the installer download: a curl on PATH that records its arguments and fails, so nothing is run
  const bin = mk("curl-shim");
  const log = path.join(bin, "args.txt");
  fs.writeFileSync(path.join(bin, "curl"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${log}"\nexit 22\n`, { mode: 0o755 });
  assert.notEqual(await runGetShDefault("https://example.invalid/rel/", { PATH: `${bin}:/usr/bin:/bin` }), 0);
  const args = fs.readFileSync(log, "utf8").trim().split("\n");
  assert.deepEqual([flag(args, "--proto"), flag(args, "--proto-redir"), args.at(-1)], ["=https", "=https", "https://example.invalid/rel/get.sh"]);
});

test("fetchLatest reads only the first line and names the URL it asked", () => {
  const rel = mk("rel-fetch");
  fs.writeFileSync(path.join(rel, "version.txt"), "0.0.4\n");
  assert.deepEqual(fetchLatest(`file://${rel}/`), { version: "0.0.4", url: `file://${rel}/version.txt` });
});

/** updateCommand with every acting part recorded instead of run. */
function harness({ route = "installer", version = "0.0.3", latest = { version: "0.0.4" }, healthy = false, work = { status: 200, body: { sessions: 0, open_sessions: 0, unsent_edits: 0, draft_comments: 0, batches: 0 } }, getSh = 0, after = "0.0.4" } = {}) {
  const home = mk(`hh${Math.random().toString(36).slice(2, 8)}`);
  const appRoot = route === "installer" ? mk(path.relative(root, home), ".onionskin", "app", version) : route === "npm" ? mk(path.relative(root, home), "prefix", "lib", "node_modules", "onionskin-cli") : mk(path.relative(root, home), "loose", "onionskin");
  const calls = [];
  const lines = [];
  const d = {
    version, appRoot, home, env: {}, print: (l) => lines.push(l),
    fetchLatest: (base) => (calls.push(["fetch", base]), { ...latest, url: `${base}/version.txt` }),
    server: { healthy: async () => healthy, openWork: async () => (calls.push(["open-work"]), work) },
    stop: async () => calls.push(["stop"]),
    runGetSh: (base) => (calls.push(["get.sh", base]), getSh),
    launcherVersion: (r) => (calls.push(["version", r]), after),
    run: (cmd, args) => (calls.push(["run", cmd, ...args.map((a) => (a.endsWith("cli.js") ? "<cli.js>" : a))]), 0),
  };
  return { d, calls, lines, out: () => lines.join("\n") };
}

test("update refuses while a session holds unsent edits, draft comments or a batch, names what is at risk, and changes nothing; --force goes on", async () => {
  const work = { status: 200, body: { sessions: 2, open_sessions: 0, unsent_edits: 3, draft_comments: 1, batches: 1 } };
  const h = harness({ healthy: true, work });
  assert.equal(await updateCommand([], h.d), 1);
  assert.match(h.out(), /Not updated: Onionskin is running with open work that the update would cut off: 3 unsent edits, 1 draft comment, 1 batch that was sent and is not finished\. The update restarts Onionskin, and a browser tab that is open now cannot reconnect to it, so anything not sent from it would be lost\..*run onionskin update --force\. Nothing was changed\.$/);
  assert.deepEqual(h.calls.map((c) => c[0]), ["fetch", "open-work"], "no stop, no installer");

  const f = harness({ healthy: true, work });
  assert.equal(await updateCommand(["--force"], f.d), 0, f.out());
  assert.deepEqual(f.calls.map((c) => c[0]), ["fetch", "open-work", "stop", "get.sh", "version"], "stopped before the installer ran");
  assert.match(f.out(), /Stopped the Onionskin server for the update \(--force: open work/);

  // an older server without /cli/open-work: with sessions it cannot vouch for, refuse; with none, stop and go on
  const old = harness({ healthy: true, work: { status: 404, body: { error: "not found" } } });
  old.d.server.openWork = async () => ({ status: 404, body: { error: "not found" } });
  assert.equal(await updateCommand([], old.d), 1);
  assert.match(old.out(), /a server from an older version that cannot say whether its open sessions hold unsent work/);

  // sessions with no tab for 20 minutes (or closed) hold nothing back: a forgotten session does not block updates forever
  const idle = harness({ healthy: true, work: { status: 200, body: { sessions: 2, open_sessions: 0, unsent_edits: 0, draft_comments: 0, batches: 0 } } });
  assert.equal(await updateCommand([], idle.d), 0, idle.out());
  assert.deepEqual(idle.calls.map((c) => c[0]), ["fetch", "open-work", "stop", "get.sh", "version"]);
  // a server that answers open-work but does not count open tabs cannot vouch for edits typed in a tab: refused like an older one
  const noTabs = harness({ healthy: true, work: { status: 200, body: { sessions: 2, unsent_edits: 0, draft_comments: 0, batches: 0 } } });
  assert.equal(await updateCommand([], noTabs.d), 1);
  assert.match(noTabs.out(), /a server from an older version that cannot say whether its open sessions hold unsent work/);
  assert.deepEqual(workAtRisk({ unsent_edits: 1, draft_comments: 2, batches: 0 }), ["1 unsent edit", "2 draft comments"]);
});

test("update refuses while a file is open in a browser tab (typed edits stay in the tab until Send, so they count nowhere else) and says what to do; --force and --check stop nothing", async () => {
  // outside review: edits typed and not sent are held only by the page, so open-work said nothing was open and the update cut the tab off
  const work = { status: 200, body: { sessions: 1, open_sessions: 1, unsent_edits: 0, draft_comments: 0, batches: 0 } };
  const h = harness({ healthy: true, work });
  assert.equal(await updateCommand([], h.d), 1);
  assert.equal(h.lines.at(-1), "Not updated: Onionskin is running with open work that the update would cut off: 1 file open in a browser tab now or in the last 20 minutes (edits typed there stay in the tab until Send). The update restarts Onionskin, and a browser tab that is open now cannot reconnect to it, so anything not sent from it would be lost. Send or finish that work, then press Close session in the file's page (or close its tab and wait 20 minutes), and run onionskin update again. To update anyway, run onionskin update --force. Nothing was changed.");
  assert.deepEqual(h.calls.map((c) => c[0]), ["fetch", "open-work"], "no stop, no installer");
  const f = harness({ healthy: true, work });
  assert.equal(await updateCommand(["--force"], f.d), 0, f.out());
  assert.deepEqual(f.calls.map((c) => c[0]), ["fetch", "open-work", "stop", "get.sh", "version"]);
  const c = harness({ healthy: true, work });
  assert.equal(await updateCommand(["--check"], c.d), 0);
  assert.deepEqual(c.calls.map((x) => x[0]), ["fetch"], "--check asks the release only: it never asks the server, stops it or installs");
  assert.deepEqual(workAtRisk({ open_sessions: 2 }), ["2 files open in a browser tab now or in the last 20 minutes (edits typed there stay in the tab until Send)"]);
});

test("GET /cli/open-work: a session counts as open while its tab is open or for 20 minutes after, never once closed", () => {
  const T = 20 * 60 * 1000;
  const now = 10 * T;
  const sess = (key, o = {}) => ({ key, file: "/secret/x.docx", comments: [], edits: [], activity: [], ...o });
  const map = new Map([["tab", sess("tab")], ["recent", sess("recent")], ["stale", sess("stale")], ["never", sess("never")], ["closedTab", sess("closedTab", { closed: true })]]);
  const sessions = { map, view: () => ({ state: "x", locked: false, pollers: 0, pendingBatchId: null, deliveredBatchId: null, leaseExpiresAt: null }) };
  const tabs = (k) => (k === "tab" || k === "closedTab" ? 1 : 0);
  const seen = (k) => ({ tab: now - 5 * T, recent: now - T + 1000, stale: now - T - 1000, closedTab: now })[k] ?? null;
  assert.equal(openWork(sessions, { tabs, seen, now }).open_sessions, 2, "the open tab and the one gone 19 minutes; not 21 minutes, never, or closed");
  assert.equal(openWork(sessions).open_sessions, 0, "without the server's tab record nothing counts as open");
});

test("update on the installer copy: runs get.sh from the base URL, prints old and new; up to date or newer changes nothing; a failed or short install is a failure", async () => {
  const h = harness();
  assert.equal(await updateCommand([], h.d), 0, h.out());
  assert.deepEqual(h.calls, [["fetch", "https://github.com/abe238/onionskin/releases/latest/download"], ["get.sh", "https://github.com/abe238/onionskin/releases/latest/download"], ["version", "installer"]]);
  assert.equal(h.lines.at(-1), "AGENT: this was an update. Tell the person this one sentence, and not the installer's sentence above: Onionskin is updated to 0.0.4.");
  assert.ok(h.lines.includes("UPDATED: Onionskin 0.0.3 -> 0.0.4. Snapshots and settings in ~/.onionskin were kept."));

  const same = harness({ latest: { version: "0.0.3" }, healthy: true });
  assert.equal(await updateCommand([], same.d), 0);
  assert.equal(same.lines.at(-1), "Already up to date: Onionskin 0.0.3 is the latest release. Nothing was changed.");
  assert.deepEqual(same.calls.map((c) => c[0]), ["fetch"], "not even the server is touched");
  const ahead = harness({ version: "0.0.5" });
  assert.equal(await updateCommand([], ahead.d), 0);
  assert.match(ahead.lines.at(-1), /is newer than the latest release \(0\.0\.4\)\. Nothing was changed\./);

  const failed = harness({ getSh: 1, after: "0.0.3" });
  assert.equal(await updateCommand([], failed.d), 1);
  assert.match(failed.lines.at(-1), /^Not updated: the installer stopped \(exit 1/);
  const short = harness({ after: "0.0.3" }); // the installer said 0 but the command still runs the old copy
  assert.equal(await updateCommand([], short.d), 1);
  assert.match(short.lines.at(-1), /says 0\.0\.3, not 0\.0\.4/);

  // the release has no version.txt: an update, a reinstall and a downgrade look the same, so nothing is installed
  const unknown = harness({ latest: { missing: true }, healthy: true });
  assert.equal(await updateCommand([], unknown.d), 1, unknown.out());
  assert.match(unknown.lines.at(-1), /^Not updated: the release does not say its version.*run the install command from the README again\.$/);
  assert.deepEqual(unknown.calls.map((c) => c[0]), ["fetch"], "no server stop, no installer");
  const unreachable = harness({ latest: { unreachable: "timeout" } });
  assert.equal(await updateCommand([], unreachable.d), 1);
  assert.deepEqual(unreachable.calls.map((c) => c[0]), ["fetch"]);

  const env = harness();
  env.d.env = { ONIONSKIN_BASE_URL: "file:///somewhere/rel" };
  await updateCommand([], env.d);
  assert.deepEqual(env.calls[1], ["get.sh", "file:///somewhere/rel"], "ONIONSKIN_BASE_URL is the release folder");
});

test("update on an npm copy prints the README's two commands and runs nothing; --yes runs them; a source checkout or an unknown copy changes nothing", async () => {
  const readme = fs.readFileSync(path.join(repo, "README.md"), "utf8");
  for (const c of NPM_COMMANDS) assert.ok(readme.includes(`\`${c}\``), `README names \`${c}\``);
  const h = harness({ route: "npm" });
  assert.equal(await updateCommand([], h.d), 0);
  assert.deepEqual(h.lines.slice(-4), ["This copy was installed with npm. To update it, run these two commands:", "  npm install -g onionskin-cli", "  onionskin setup --force", "Or run onionskin update --yes to have them run for you."]);
  assert.deepEqual(h.calls.map((c) => c[0]), ["fetch"]);
  const y = harness({ route: "npm" });
  assert.equal(await updateCommand(["--yes"], y.d), 0, y.out());
  assert.deepEqual(y.calls.filter((c) => c[0] === "run"), [["run", "npm", "install", "-g", "onionskin-cli"], ["run", process.execPath, "<cli.js>", "setup", "--force"]]);
  assert.match(y.out(), /UPDATED: Onionskin 0\.0\.3 -> 0\.0\.4 \(npm\)\./);
  const lag = harness({ route: "npm", after: "0.0.3" }); // the registry did not have the release yet
  assert.equal(await updateCommand(["--yes"], lag.d), 1);
  assert.match(lag.lines.at(-1), /^Not updated as expected: npm finished, but this copy now says 0\.0\.3, not 0\.0\.4/);

  const src = harness({ route: "unknown" });
  fs.writeFileSync(path.join(src.d.appRoot, "package.json"), "{}");
  fs.mkdirSync(path.join(src.d.appRoot, ".git"));
  assert.equal(await updateCommand([], src.d), 0);
  assert.match(src.lines.at(-1), /^This is a source checkout \(~\/loose\/onionskin\)\. Update it with git: git pull, npm install, npm run build:web, then onionskin setup --force for the skill folders\. Nothing was changed\.$/);
  const loose = harness({ route: "unknown" });
  assert.equal(await updateCommand([], loose.d), 1);
  assert.match(loose.lines.at(-1), /cannot tell how to update it\. Nothing was changed\./);
  for (const x of [src, loose]) assert.ok(!x.calls.some((c) => ["stop", "get.sh", "run"].includes(c[0])));
  await assert.rejects(updateCommand(["--now"], harness().d), /unknown option --now/);
});

test("GET /cli/open-work sums every session's unsent edits, draft comments and batches in flight, and names no file", () => {
  const sess = (o) => ({ file: "/secret/name.docx", comments: o.comments || [], edits: o.edits || [], activity: [], ...o });
  const map = new Map([
    ["a", sess({ edits: [1, 2], comments: [{ status: "draft" }, { status: "sent" }] })],
    ["b", sess({ pending: "b_1" })],
    ["c", sess({ delivered: "b_2", comments: [{ status: "draft" }] })],
    ["d", sess({})],
  ]);
  const sessions = { map, view: (s) => ({ state: "x", locked: !!s.delivered, pollers: 0, pendingBatchId: s.pending || null, deliveredBatchId: s.delivered || null, leaseExpiresAt: null }) };
  const w = openWork(sessions);
  assert.deepEqual(w, { sessions: 4, open_sessions: 0, unsent_edits: 2, draft_comments: 2, batches: 2 });
  assert.ok(!JSON.stringify(w).includes("name.docx"));
});

test("npm update waits for the command and reports its 10 minute timeout before running setup", async () => {
  const h = harness({ route: "npm" });
  const commands = [];
  h.d.run = async (cmd, args, opts) => {
    commands.push(cmd);
    await Promise.resolve();
    assert.equal(opts.totalTimeout, 600_000);
    assert.ok(opts.timeout > 0 && opts.timeout <= opts.totalTimeout);
    opts.onTimeout(opts.timeout);
    return 1;
  };
  assert.equal(await updateCommand(["--yes"], h.d), 1);
  assert.deepEqual(commands, ["npm"]);
  assert.match(h.lines.at(-1), /npm.*timed out after 10 minutes/i);
});

/** Builds a local release folder served over file:// with the real scripts/get.sh and a fake install.sh. */
function makeFileRelease(name, installSh) {
  const rel = mk(name);
  const stage = mk(`${name}-stage`, "onionskin");
  fs.writeFileSync(path.join(stage, "package.json"), JSON.stringify({ name: "onionskin", version: "0.0.9" }) + "\n");
  fs.writeFileSync(path.join(stage, "install.sh"), installSh, { mode: 0o755 });
  const zipPath = path.join(rel, "onionskin.zip");
  const z = spawnSync("/usr/bin/zip", ["-X", "-r", "-q", zipPath, "onionskin"], { cwd: path.dirname(stage) });
  assert.equal(z.status, 0, z.stderr);
  const hash = crypto.createHash("sha256").update(fs.readFileSync(zipPath)).digest("hex");
  fs.writeFileSync(`${zipPath}.sha256`, `${hash}  onionskin.zip\n`);
  fs.copyFileSync(path.join(repo, "scripts", "get.sh"), path.join(rel, "get.sh"));
  return rel;
}

const baseEnv = (extra = {}) => ({
  HOME: mk("get-home"),
  TMPDIR: root,
  PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
  ...extra,
});

test("installer update passes the existing deeper-check choice through get.sh", async () => {
  const rel = makeFileRelease("checker-choice", '#!/bin/sh\nprintf "%s\\n" "$@" > "$HOME/installer-args"\n');
  for (const installation of ["absent", "plain file", "working", "dangling"]) {
    const h = harness();
    const noChecker = installation === "absent" || installation === "plain file";
    if (installation === "plain file") fs.writeFileSync(path.join(h.d.home, ".onionskin", "venv"), "");
    if (!noChecker) {
      const bin = path.join(h.d.home, ".onionskin", "venv", "bin");
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(path.join(bin, "..", "pyvenv.cfg"), "home = /old/python\n");
      if (installation === "dangling") fs.symlinkSync("removed-python", path.join(bin, "python"));
      else fs.writeFileSync(path.join(bin, "python"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    }
    h.d.env.ONIONSKIN_BASE_URL = `file://${rel}`;
    h.d.runGetSh = (base, opts) => runGetShDefault(base, baseEnv({ HOME: h.d.home }), opts);
    assert.equal(await updateCommand([], h.d), 0, h.out());
    assert.equal(fs.readFileSync(path.join(h.d.home, "installer-args"), "utf8").trim(), noChecker ? "--no-checker" : "", installation);
  }
});

test("CLI update requires --force when a running server answers with an older protocol", async () => {
  const { d } = harness();
  fs.cpSync(path.join(repo, "src"), path.join(d.appRoot, "src"), { recursive: true });
  for (const name of ["docs", "vendor", "node_modules"]) fs.symlinkSync(path.join(repo, name), path.join(d.appRoot, name));
  fs.writeFileSync(path.join(d.appRoot, "package.json"), JSON.stringify({ type: "module", version: d.version }));
  const rel = mk("old-protocol-release");
  fs.writeFileSync(path.join(rel, "version.txt"), "99.0.0\n");
  fs.writeFileSync(path.join(rel, "get.sh"), 'touch "$HOME/installer-ran"\nexit 23\n');
  const state = path.join(d.home, ".onionskin");
  const env = baseEnv({ HOME: d.home, ONIONSKIN_STATE_DIR: state, ONIONSKIN_BASE_URL: `file://${rel}` });
  const stopped = [];
  const srv = http.createServer((req, res) => {
    if (req.url === "/cli/stop") stopped.push(req.method);
    res.end(JSON.stringify({ protocol: 1, pid: 2147483647, sessions: 0, open_sessions: 0 }));
  });
  await new Promise((resolve, reject) => srv.once("error", reject).listen(path.join(state, "s.sock"), resolve));
  try {
    const run = (...args) => promisify(execFile)(process.execPath, [path.join(d.appRoot, "src", "cli.js"), "update", ...args], { env, timeout: 10_000 });
    await assert.rejects(run(), (err) => {
      assert.match(err.stdout, /^A running Onionskin server from another version may hold unsent work: run onionskin stop, or onionskin update --force\.$/m, err.stderr || err.stdout);
      return err.code === 1;
    });
    assert.deepEqual(stopped, []);
    assert.equal(fs.existsSync(path.join(d.home, "installer-ran")), false);
    await assert.rejects(run("--force"), (err) => err.code === 1 && /installer stopped \(exit 23/.test(err.stdout));
    assert.deepEqual(stopped, ["POST"]);
    assert.ok(fs.existsSync(path.join(d.home, "installer-ran")));
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }
});

test("S8/T3: real scripts/get.sh over file:// — timeout kills process group including TERM-ignoring grandchild", async () => {
  const pidFile = path.join(root, "t3-timeout-child.pid");
  const doneFile = path.join(root, "t3-timeout-done");
  const rel = makeFileRelease(
    "t3-rel-timeout",
    `#!/bin/sh
trap '' TERM
sh -c 'trap "" TERM; echo $$ > ${JSON.stringify(pidFile)}; exec sleep 30'
touch ${JSON.stringify(doneFile)}
`,
  );
  let timedOutWith = 0;
  const t0 = Date.now();
  const rc = await runGetShDefault(`file://${rel}`, baseEnv(), {
    timeout: 1200,
    graceMs: 250,
    onTimeout: (ms) => {
      timedOutWith = ms;
    },
  });
  const elapsed = Date.now() - t0;
  assert.notEqual(rc, 0, "timed-out real get.sh must return non-zero");
  assert.equal(timedOutWith, 1200, "onTimeout must report the configured timeout");
  assert.ok(elapsed < 5000, `expected timeout + grace < 5000ms, took ${elapsed}ms`);
  assert.equal(fs.existsSync(doneFile), false, "install.sh must not continue after timeout");
  assert.equal(fs.existsSync(pidFile), true, "grandchild pidFile must have been written before timeout");
  const cpid = Number(fs.readFileSync(pidFile, "utf8").trim());
  assert.ok(cpid > 0);
  await new Promise((r) => setTimeout(r, 100));
  assert.throws(() => process.kill(cpid, 0), /ESRCH/, `TERM-ignoring grandchild ${cpid} must be SIGKILLed`);
});

test("T3: real scripts/get.sh over file:// — Ctrl-C (SIGINT) to parent forwards to installer group and stops it", async () => {
  const pidFile = path.join(root, "t3-sigint-child.pid");
  const doneFile = path.join(root, "t3-sigint-done");
  const rel = makeFileRelease(
    "t3-rel-sigint",
    `#!/bin/sh
sh -c 'echo $$ > ${JSON.stringify(pidFile)}; exec sleep 30'
touch ${JSON.stringify(doneFile)}
`,
  );
  const runner = path.join(root, "t3-sigint-runner.mjs");
  fs.writeFileSync(
    runner,
    `import { runGetShDefault } from ${JSON.stringify(path.join(repo, "src", "update.js"))};
const rc = await runGetShDefault(${JSON.stringify(`file://${rel}`)}, process.env, { timeout: 20000, graceMs: 250 });
process.exit(rc);
`,
  );
  const proc = spawn(process.execPath, [runner], { env: baseEnv(), stdio: ["ignore", "pipe", "pipe"] });
  try {
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(pidFile) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 30));
    assert.equal(fs.existsSync(pidFile), true, "install.sh child must start and write pidFile before SIGINT");
    const cpid = Number(fs.readFileSync(pidFile, "utf8").trim());
    assert.ok(cpid > 0);

    const t0 = Date.now();
    proc.kill("SIGINT");
    const exitCode = await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("parent did not exit after SIGINT")), 5000);
      proc.once("exit", (code) => {
        clearTimeout(to);
        resolve(code);
      });
    });
    assert.notEqual(exitCode, 0, "parent must exit non-zero on SIGINT");
    assert.ok(Date.now() - t0 < 4000, "parent must exit promptly on SIGINT");
    await new Promise((r) => setTimeout(r, 100));
    assert.throws(() => process.kill(cpid, 0), /ESRCH/, `installer child ${cpid} must be killed when parent gets SIGINT`);
    assert.equal(fs.existsSync(doneFile), false, "install.sh must not finish after SIGINT");
  } finally {
    try { proc.kill("SIGKILL"); } catch {}
    try {
      const cpid = Number(fs.readFileSync(pidFile, "utf8").trim());
      if (cpid > 0) process.kill(cpid, "SIGKILL");
    } catch {}
  }
});

test("T3: real scripts/get.sh over file:// — background child holding stdout still returns 0 quickly", async () => {
  const bgPidFile = path.join(root, "t3-bgpipe.pid");
  const rel = makeFileRelease(
    "t3-rel-bgpipe",
    `#!/bin/sh
sleep 30 &
echo $! > ${JSON.stringify(bgPidFile)}
exit 0
`,
  );
  try {
    const t0 = Date.now();
    const rc = await runGetShDefault(`file://${rel}`, baseEnv(), { timeout: 10_000, graceMs: 200 });
    const elapsed = Date.now() - t0;
    assert.equal(rc, 0, "install that exits 0 with background child holding stdout must return 0");
    assert.ok(elapsed < 4000, `must finish quickly after exit+grace, took ${elapsed}ms`);
    assert.equal(fs.existsSync(bgPidFile), true, "background child must have been spawned");
  } finally {
    try {
      const pid = Number(fs.readFileSync(bgPidFile, "utf8").trim());
      if (pid > 0) process.kill(pid, "SIGKILL");
    } catch {}
  }
});

test("T3: updateCommand prints a clear timeout message and handles split-chunk SKILL_SETUP_FAILED without showing raw token", async () => {
  // 1) Timeout message says it timed out and after how long
  const hTo = harness();
  hTo.d.runGetSh = (base, opts) => {
    hTo.calls.push(["get.sh", base]);
    opts?.onTimeout?.(360_000);
    return 1;
  };
  assert.equal(await updateCommand([], hTo.d), 1);
  assert.match(hTo.out(), /Not updated: the installer timed out after 6 minutes\./);

  // 2) Split-chunk SKILL_SETUP_FAILED is buffered by line in updateCommand
  const hSplit = harness();
  hSplit.d.runGetSh = (base, opts) => {
    hSplit.calls.push(["get.sh", base]);
    opts?.onOutput?.("  SKILL_SET");
    opts?.onOutput?.("UP_FAILED: warning: skill setup exited 1\n");
    return 0;
  };
  assert.equal(await updateCommand([], hSplit.d), 0);
  assert.match(hSplit.out(), /UPDATED \(with warning\):.*skill setup failed.*onionskin setup/);

  // 3) Real scripts/get.sh emitting split SKILL_SETUP_FAILED: onOutput sees it, user stdout gets plain sentence without raw token
  const rel = makeFileRelease(
    "t3-rel-skill",
    `#!/bin/sh
printf '  SKILL_SET'
sleep 0.05
printf 'UP_FAILED: warning: skill setup exited 1\\n'
exit 0
`,
  );
  const runner = path.join(root, "t3-skill-runner.mjs");
  const seenFile = path.join(root, "t3-skill-seen.txt");
  fs.writeFileSync(
    runner,
    `import fs from "node:fs";
import { runGetShDefault } from ${JSON.stringify(path.join(repo, "src", "update.js"))};
let seen = "";
const rc = await runGetShDefault(${JSON.stringify(`file://${rel}`)}, process.env, {
  timeout: 10000,
  graceMs: 200,
  onOutput: (s) => { seen += s; },
});
fs.writeFileSync(${JSON.stringify(seenFile)}, seen);
process.exit(rc);
`,
  );
  const r = spawnSync(process.execPath, [runner], { env: baseEnv(), encoding: "utf8", timeout: 15_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(seenFile, "utf8"), /SKILL_SETUP_FAILED/, "onOutput must receive the full buffered line");
  assert.doesNotMatch(r.stdout, /SKILL_SETUP_FAILED/, "raw SKILL_SETUP_FAILED token must not be printed to the user");
  assert.match(r.stdout, /Warning: skill setup did not finish/, "plain warning sentence must be printed to the user");
});

test("S9: update catches stop() failure and prints standard Not updated + Nothing was changed + AGENT line", async () => {
  const h = harness({ healthy: true });
  h.d.stop = async () => {
    throw new Error("server (pid 42424) did not stop within 5s");
  };
  assert.equal(await updateCommand([], h.d), 1);
  assert.match(h.out(), /Not updated:.*42424.*Nothing was changed\./);
  assert.match(h.out(), /^AGENT:/m);
  assert.ok(!h.calls.some((c) => c[0] === "get.sh"), "installer must not run when stop fails");
});

test("S14: update reports failed skill setup when installer emits SKILL_SETUP_FAILED", async () => {
  const h = harness();
  h.d.runGetSh = (base, opts) => {
    h.calls.push(["get.sh", base]);
    opts?.onOutput?.("  SKILL_SETUP_FAILED: warning: skill setup exited 1\n");
    return 0;
  };
  assert.equal(await updateCommand([], h.d), 0);
  assert.match(h.out(), /UPDATED \(with warning\):.*skill setup failed.*onionskin setup/);
  assert.match(h.out(), /^AGENT:.*SKILL_SETUP_FAILED.*onionskin setup/m);
});
