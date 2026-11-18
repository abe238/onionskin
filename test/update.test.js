// `onionskin update` (src/update.js): route detection, version comparison, the version.txt check and the refusal while work is open.
// Temp dirs only; the one network-shaped check is a server on 127.0.0.1 inside this process and file:// URLs. Nothing runs get.sh or npm.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
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

test("curl is asked for https and file only (plain http only for 127.0.0.1), and redirects to https only, for version.txt and for get.sh", () => {
  const seen = [];
  const run = (cmd, args) => (seen.push(args), { status: 0, stdout: "0.0.4\n", stderr: "" });
  fetchLatest("https://example.invalid/rel", { run });
  fetchLatest("http://127.0.0.1:9/rel", { run });
  const flag = (args, f) => args[args.indexOf(f) + 1];
  assert.deepEqual(seen.map((a) => [flag(a, "--proto"), flag(a, "--proto-redir")]), [["=https,file", "=https"], ["=https,file,http", "=https"]]);
  // the installer download: a curl on PATH that records its arguments and fails, so nothing is run
  const bin = mk("curl-shim");
  const log = path.join(bin, "args.txt");
  fs.writeFileSync(path.join(bin, "curl"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${log}"\nexit 22\n`, { mode: 0o755 });
  assert.notEqual(runGetShDefault("https://example.invalid/rel/", { PATH: `${bin}:/usr/bin:/bin` }), 0);
  const args = fs.readFileSync(log, "utf8").trim().split("\n");
  assert.deepEqual([flag(args, "--proto"), flag(args, "--proto-redir"), args.at(-1)], ["=https,file", "=https", "https://example.invalid/rel/get.sh"]);
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
