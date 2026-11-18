#!/usr/bin/env node
// Rehearses both public install routes against LOCAL stand-ins, in a throwaway HOME. Nothing is published, nothing is installed for real.
//   node scripts/rehearse-install-path.mjs <zip> <log-file>
// <zip> is a built dist-zip/onionskin-<version>-<sha>.zip. Route 1 serves it from a 127.0.0.1 server that lives only inside this process,
// runs scripts/get.sh against it, then runs `onionskin --version` and `onionskin doctor`. Route 2 runs `npm pack`, installs the tarball
// into a temp prefix, runs `onionskin setup` and the same two checks. Exit 1 if any check fails.
import { spawnSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [zipArg, logArg] = process.argv.slice(2);
if (!zipArg || !logArg) {
  console.error("usage: node scripts/rehearse-install-path.mjs <zip> <log-file>");
  process.exit(2);
}
const zip = path.resolve(zipArg);
const log = path.resolve(logArg);
fs.mkdirSync(path.dirname(log), { recursive: true });
fs.writeFileSync(log, `rehearsal ${new Date().toISOString()}\nzip ${zip}\n\n`);
const say = (s) => {
  fs.appendFileSync(log, s + "\n");
  console.log(s);
};
let fails = 0;
const check = (name, ok, detail = "") => {
  say(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : detail ? "\n" + detail.replace(/^/gm, "        ") : ""}`);
  if (!ok) fails++;
};
const shown = (h) => (s) => s.split(h).join("<TEMP-HOME>"); // keep the temp path out of the log's meaning, not its evidence
const sha = crypto.createHash("sha256").update(fs.readFileSync(zip)).digest("hex");

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "os-rehearse-")));
const rel = path.join(tmp, "release");
fs.mkdirSync(rel);
fs.copyFileSync(zip, path.join(rel, "onionskin.zip"));
fs.writeFileSync(path.join(rel, "onionskin.zip.sha256"), `${sha}  ${path.basename(zip)}\n`);
const nodeDir = path.dirname(process.execPath);
const envFor = (home, extra = {}) => ({ HOME: home, TMPDIR: path.join(tmp, "tmpdir"), PATH: `${nodeDir}:/usr/bin:/bin:/usr/sbin:/sbin`, ...extra });
fs.mkdirSync(path.join(tmp, "tmpdir"));
const exec = (cmd, args, opts) => new Promise((res) => {
  const c = spawn(cmd, args, { encoding: "utf8", ...opts });
  let out = "";
  c.stdout.on("data", (d) => (out += d));
  c.stderr.on("data", (d) => (out += d));
  c.on("close", (code) => res({ status: code, out }));
});

// ---- route 1: get.sh against a local server -----------------------------------------------------------------------
const server = http.createServer((req, res) => {
  const f = path.join(rel, path.basename(req.url));
  if (fs.existsSync(f)) {
    res.writeHead(200, { "content-length": fs.statSync(f).size });
    fs.createReadStream(f).pipe(res);
  } else {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const H1 = path.join(tmp, "home1");
fs.mkdirSync(H1);
say("== route 1: curl one-liner (get.sh), zip and checksum served from this process on 127.0.0.1");
const dry = await exec("/bin/sh", [path.join(root, "scripts", "get.sh"), "--dry-run"], { env: envFor(H1, { ONIONSKIN_ZIP_URL: `${base}/onionskin.zip` }) });
say(dry.out);
check("get.sh --dry-run exits 0 and leaves HOME empty", dry.status === 0 && fs.readdirSync(H1).length === 0, dry.out);
// the real shape: the script is piped into sh, as in the README
const piped = await exec("/bin/sh", ["-c", `/bin/cat "${path.join(root, "scripts", "get.sh")}" | /bin/sh -s -- --no-checker`], { env: envFor(H1, { ONIONSKIN_ZIP_URL: `${base}/onionskin.zip` }) });
say(shown(H1)(piped.out));
check("piped into sh: exit 0", piped.status === 0, piped.out);
check("piped into sh: checksum ok line", /checksum ok/.test(piped.out));
const L1 = path.join(H1, ".local", "bin", "onionskin");
check("launcher written", fs.existsSync(L1));
for (const d of [".claude/skills/onionskin/SKILL.md", ".agents/skills/onionskin/SKILL.md"]) check(`skill installed: ${d}`, fs.existsSync(path.join(H1, d)));
check("no voice.md in the installed skill", !fs.existsSync(path.join(H1, ".claude/skills/onionskin/voice.md")));
const q = spawnSync("/usr/bin/xattr", ["-p", "com.apple.quarantine", path.join(H1, ".onionskin/app")], { encoding: "utf8" });
check("nothing under the app folder carries a download mark (curl does not set one)", spawnSync("/usr/bin/xattr", ["-lr", path.join(H1, ".onionskin/app")], { encoding: "utf8" }).stdout.indexOf("com.apple.quarantine") < 0);
void q;
check("temp folder removed", fs.readdirSync(path.join(tmp, "tmpdir")).length === 0, fs.readdirSync(path.join(tmp, "tmpdir")).join(","));
const ver = await exec(L1, ["--version"], { env: envFor(H1) });
say(`$ onionskin --version\n${ver.out}`);
check("onionskin --version prints a version", ver.status === 0 && /^\d+\.\d+\.\d+/.test(ver.out.trim()), ver.out);
const doc = await exec(L1, ["doctor"], { env: envFor(H1) });
say(`$ onionskin doctor\n${shown(H1)(doc.out)}`);
check("onionskin doctor exits 0", doc.status === 0, doc.out);
// a damaged download must stop before install
fs.writeFileSync(path.join(rel, "onionskin.zip.sha256"), `${"0".repeat(64)}  x\n`);
const H1b = path.join(tmp, "home1b");
fs.mkdirSync(H1b);
const bad = await exec("/bin/sh", [path.join(root, "scripts", "get.sh")], { env: envFor(H1b, { ONIONSKIN_ZIP_URL: `${base}/onionskin.zip` }) });
say(bad.out);
check("wrong checksum: exit 1 and HOME untouched", bad.status === 1 && fs.readdirSync(H1b).length === 0, bad.out);
fs.writeFileSync(path.join(rel, "onionskin.zip.sha256"), `${sha}  ${path.basename(zip)}\n`);
// a URL whose user name hides another host, and a look-alike host: refused before anything is downloaded
for (const u of [`${base}@evil.invalid/onionskin.zip`, `http://127.0.0.1.evil.invalid:${server.address().port}/onionskin.zip`]) {
  const H1c = fs.mkdtempSync(path.join(tmp, "home1c-"));
  const r = await exec("/bin/sh", [path.join(root, "scripts", "get.sh")], { env: envFor(H1c, { ONIONSKIN_ZIP_URL: u }) });
  check(`refused URL ${u.replace(String(server.address().port), "<port>")}: exit 1, nothing downloaded, HOME untouched`, r.status === 1 && /refusing the URL/.test(r.out) && fs.readdirSync(H1c).length === 0, r.out);
}
// update path: run again
const again = await exec("/bin/sh", [path.join(root, "scripts", "get.sh"), "--no-checker"], { env: envFor(H1, { ONIONSKIN_ZIP_URL: `${base}/onionskin.zip` }) });
check("running it again (update path) exits 0", again.status === 0, again.out);
// uninstall path
const un = await exec("/bin/sh", ["-c", `/bin/sh "$HOME"/.onionskin/app/*/install.sh --uninstall`], { env: envFor(H1) });
say(shown(H1)(un.out));
check("uninstall from the installed copy: exit 0, launcher and skills gone", un.status === 0 && !fs.existsSync(L1) && !fs.existsSync(path.join(H1, ".claude/skills/onionskin")) && !fs.existsSync(path.join(H1, ".agents/skills/onionskin")), un.out);
await new Promise((r) => server.close(r));

// ---- route 2: npm pack, install the tarball into a temp prefix -----------------------------------------------------
say("\n== route 2: npm pack, then npm install -g into a temp prefix");
const packDir = path.join(tmp, "pack");
fs.mkdirSync(packDir);
const pack = await exec("npm", ["pack", "--json", "--pack-destination", packDir], { cwd: root, env: { ...process.env, HOME: process.env.HOME } });
const jsonStart = pack.out.search(/^\[\n/m);
let info = null;
try { info = JSON.parse(pack.out.slice(jsonStart))[0]; } catch { /* reported below */ }
check("npm pack produced a tarball", !!info && pack.status === 0, pack.out.slice(-1500));
if (info) {
  const names = info.files.map((f) => f.path);
  say(`tarball ${info.filename}: ${info.files.length} files, ${(info.size / 1048576).toFixed(2)} MB packed, ${(info.unpackedSize / 1048576).toFixed(2)} MB unpacked`);
  const must = ["src/cli.js", "web/dist/index.html", "vendor/engine/index.js", "skills/onionskin/SKILL.md", "scripts/rewriter/apple/onionskin-fm", "docs/contracts/ops.schema.json", "LICENSE", "package.json"];
  for (const m of must) check(`tarball holds ${m}`, names.includes(m));
  check("tarball has no voice.md", !names.some((n) => n.endsWith("voice.md")));
  check("tarball has no tests, e2e, dotfiles or node_modules", !names.some((n) => /^(test|e2e)\//.test(n) || /(^|\/)\./.test(n) || /node_modules/.test(n)));
  const home = os.homedir();
  const tar = path.join(packDir, info.filename);
  const grep = spawnSync("/usr/bin/tar", ["-xzOf", tar], { maxBuffer: 256 * 1024 * 1024 });
  check("no home directory path inside the tarball's files", !grep.stdout.includes(Buffer.from(home)), "the maintainer's home path was found in a packed file");
  const H2 = path.join(tmp, "home2");
  const PFX = path.join(tmp, "prefix");
  fs.mkdirSync(H2);
  const inst = await exec("npm", ["install", "-g", "--prefix", PFX, "--no-audit", "--no-fund", tar], { env: envFor(H2, { npm_config_cache: path.join(tmp, "npmcache") }) });
  say(shown(H2)(inst.out));
  check("npm install -g of the tarball exits 0", inst.status === 0, inst.out);
  const BIN = path.join(PFX, "bin", "onionskin");
  const v2 = await exec(BIN, ["--version"], { env: envFor(H2, { PATH: `${PFX}/bin:${nodeDir}:/usr/bin:/bin` }) });
  say(`$ onionskin --version\n${v2.out}`);
  check("onionskin --version works from the npm install", v2.status === 0 && /^\d+\.\d+\.\d+/.test(v2.out.trim()), v2.out);
  const su = await exec(BIN, ["setup"], { env: envFor(H2, { PATH: `${PFX}/bin:${nodeDir}:/usr/bin:/bin` }) });
  say(shown(H2)(su.out));
  check("onionskin setup installs both skill folders", su.status === 0 && fs.existsSync(path.join(H2, ".claude/skills/onionskin/SKILL.md")) && fs.existsSync(path.join(H2, ".agents/skills/onionskin/SKILL.md")), su.out);
  const d2 = await exec(BIN, ["doctor"], { env: envFor(H2, { PATH: `${PFX}/bin:${nodeDir}:/usr/bin:/bin` }) });
  say(`$ onionskin doctor\n${shown(H2)(d2.out)}`);
  check("onionskin doctor exits 0 from the npm install", d2.status === 0, d2.out);
  const mark = spawnSync("/usr/bin/xattr", ["-lr", path.join(PFX, "lib", "node_modules", "onionskin-cli")], { encoding: "utf8" });
  check("npm-installed files carry no download mark", mark.stdout.indexOf("com.apple.quarantine") < 0);
  const un2 = await exec(BIN, ["setup", "--uninstall"], { env: envFor(H2, { PATH: `${PFX}/bin:${nodeDir}:/usr/bin:/bin` }) });
  say(shown(H2)(un2.out));
  check("onionskin setup --uninstall removes the skill folders", un2.status === 0 && !fs.existsSync(path.join(H2, ".claude/skills/onionskin")), un2.out);
  const rm = await exec("npm", ["uninstall", "-g", "--prefix", PFX, "onionskin-cli"], { env: envFor(H2, { npm_config_cache: path.join(tmp, "npmcache") }) });
  check("npm uninstall -g removes the command", rm.status === 0 && !fs.existsSync(BIN), rm.out);
}
fs.rmSync(tmp, { recursive: true, force: true });
say(`\n${fails === 0 ? "ALL PASS" : `${fails} FAILED`}`);
process.exit(fails === 0 ? 0 : 1);
