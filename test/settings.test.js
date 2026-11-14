import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

// Everything here runs against a temp state dir (ONIONSKIN_STATE_DIR); the real ~/.onionskin is never touched.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "os-set-"));
process.env.ONIONSKIN_STATE_DIR = path.join(root, "st");
const S = await import("../src/settings.js");
const { configCommand, parseConfigArgs } = await import("../src/cli.js");
const { formatDoctor, runDoctor } = await import("../src/doctor.js");
after(() => fs.rmSync(root, { recursive: true, force: true }));

function png(w = 2, h = 2) {
  const crc = (b) => {
    let c, x = ~0;
    for (const v of b) {
      c = (x ^ v) & 255;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      x = (x >>> 8) ^ c;
    }
    return ~x >>> 0;
  };
  const chunk = (t, d) => {
    const body = Buffer.concat([Buffer.from(t), d]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(d.length);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.concat(Array.from({ length: h }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 200)])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40)]);
const webp = () => Buffer.concat([Buffer.from("RIFF"), Buffer.from([40, 0, 0, 0]), Buffer.from("WEBPVP8 "), Buffer.alloc(40)]);
const mode = (f) => fs.statSync(f).mode & 0o777;

test("settings: the default is paper; a missing or broken file reads as the default", () => {
  assert.deepEqual(S.readSettings().background, { kind: "preset", name: "paper", strength: 60, blur: true });
  fs.mkdirSync(process.env.ONIONSKIN_STATE_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(process.env.ONIONSKIN_STATE_DIR, "settings.json"), "{not json");
  assert.equal(S.readSettings().background.name, "paper");
});

test("settings: write and read back, 0600, nothing but the four fields is stored", () => {
  S.writeBackground({ kind: "preset", name: "aurora", strength: 30, blur: false, path: "/etc/passwd", extra: 1 });
  const f = path.join(process.env.ONIONSKIN_STATE_DIR, "settings.json");
  assert.equal(mode(f), 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(f, "utf8")), { background: { kind: "preset", name: "aurora", strength: 30, blur: false } });
  assert.deepEqual(S.readSettings().background, { kind: "preset", name: "aurora", strength: 30, blur: false });
});

test("settings: validation refuses unknown presets, bad strength and blur, and custom without an image", () => {
  const bad = (b, status) => assert.throws(() => S.writeBackground(b), (e) => e instanceof S.SettingsError && e.status === status, JSON.stringify(b));
  bad(null, 400);
  bad({ kind: "preset", name: "../../etc" }, 400);
  bad({ kind: "preset", name: "nope" }, 400);
  bad({ kind: "preset", name: "paper", strength: 101 }, 400);
  bad({ kind: "preset", name: "paper", strength: "5" }, 400);
  bad({ kind: "preset", name: "paper", blur: "yes" }, 400);
  bad({ kind: "image", name: "x" }, 400);
  bad({ kind: "custom" }, 409);
});

test("settings: magic bytes decide the type; the claimed name or extension never matters", () => {
  assert.equal(S.sniffImage(png()), "png");
  assert.equal(S.sniffImage(jpeg()), "jpeg");
  assert.equal(S.sniffImage(webp()), "webp");
  assert.equal(S.sniffImage(Buffer.from("just some text, not an image at all")), null);
  assert.equal(S.sniffImage(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>")), null, "svg is not accepted");
  assert.equal(S.sniffImage(Buffer.from("GIF89a" + "x".repeat(20))), null);
  assert.equal(S.sniffImage(Buffer.alloc(3)), null);
});

test("custom image: stored as backgrounds/custom.<ext> 0600, one file, replaced on change, size capped, removable", () => {
  const dir = path.join(process.env.ONIONSKIN_STATE_DIR, "backgrounds");
  assert.throws(() => S.saveCustomImage(Buffer.from("hello world, definitely text")), (e) => e.status === 415);
  assert.throws(() => S.saveCustomImage(Buffer.concat([png(), Buffer.alloc(S.MAX_IMAGE_BYTES)])), (e) => e.status === 413);
  assert.throws(() => S.saveCustomImage(Buffer.alloc(0)), (e) => e.status === 400);
  assert.deepEqual(fs.existsSync(dir) ? fs.readdirSync(dir) : [], [], "a refused upload leaves nothing");
  S.saveCustomImage(png());
  assert.deepEqual(fs.readdirSync(dir), ["custom.png"]);
  assert.equal(mode(path.join(dir, "custom.png")), 0o600);
  assert.equal(mode(dir), 0o700);
  S.saveCustomImage(jpeg());
  assert.deepEqual(fs.readdirSync(dir), ["custom.jpg"], "one file: the PNG was replaced");
  assert.equal(S.readCustomImage().mime, "image/jpeg");
  S.writeBackground({ kind: "custom", strength: 40, blur: true });
  assert.equal(S.readSettings().background.kind, "custom");
  S.removeCustomImage();
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.equal(S.readSettings().background.kind, "preset", "removing the image drops the custom choice");
  assert.equal(S.readSettings().background.strength, 40, "the sliders are kept");
});

test("custom image: a settings file that names custom without an image reads as the default", () => {
  fs.writeFileSync(path.join(process.env.ONIONSKIN_STATE_DIR, "settings.json"), JSON.stringify({ background: { kind: "custom", name: "x", strength: 70, blur: true } }));
  assert.equal(S.readSettings().background.kind, "preset");
});

test("CLI parse: presets, default, --image with --strength and --no-blur, get; everything else is refused", () => {
  assert.equal(parseConfigArgs(["background", "studio"]).value, "studio");
  assert.equal(parseConfigArgs(["background", "default"]).value, "paper");
  const a = parseConfigArgs(["background", "--image", "/x/y.png", "--strength", "45", "--no-blur"]);
  assert.deepEqual([a.image, a.strength, a.blur], ["/x/y.png", 45, false]);
  assert.equal(parseConfigArgs(["get", "background"]).action, "get");
  for (const bad of [[], ["background"], ["background", "neon"], ["background", "paper", "--image", "a.png"], ["background", "--image", "a.png", "--strength", "101"], ["background", "--image", "a.png", "--strength", "x"], ["get", "other"], ["background", "paper", "--wat"]])
    assert.throws(() => parseConfigArgs(bad), Error, JSON.stringify(bad));
});

test("CLI config: set a preset, get it, copy an image, refuse a text file and a 15 MB+ file, with a temp state dir", () => {
  const st = path.join(root, "cli-state");
  const run = (...args) => spawnSync(process.execPath, [path.join(repo, "src", "cli.js"), "config", ...args], { env: { ...process.env, ONIONSKIN_STATE_DIR: st }, encoding: "utf8" });
  assert.match(run("get", "background").stdout, /^paper \(default\)\n$/);
  assert.equal(run("background", "midnight").status, 0);
  assert.match(run("get", "background").stdout, /^midnight\n$/);
  const good = path.join(root, "bg.png");
  fs.writeFileSync(good, png());
  const r = run("background", "--image", good, "--strength", "35", "--no-blur");
  assert.equal(r.status, 0, r.stderr);
  assert.match(run("get", "background").stdout, /custom image \(strength 35, blur off\)/);
  assert.deepEqual(fs.readdirSync(path.join(st, "backgrounds")), ["custom.png"]);
  assert.equal(mode(path.join(st, "settings.json")), 0o600);
  const txt = path.join(root, "bg.png.txt");
  fs.writeFileSync(txt, "not an image");
  const t = run("background", "--image", txt);
  assert.equal(t.status, 1);
  assert.match(t.stderr, /not a PNG, JPEG or WebP/);
  const big = path.join(root, "big.png");
  fs.writeFileSync(big, Buffer.concat([png(), Buffer.alloc(S.MAX_IMAGE_BYTES)]));
  assert.match(run("background", "--image", big).stderr, /larger than 15 MB/);
  assert.match(run("background", "default").stdout, /paper/);
  assert.match(run("get", "background").stdout, /^paper \(default\)\n$/);
  run("background", "studio", "--strength", "20", "--no-blur");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(st, "settings.json"), "utf8")).background, { kind: "preset", name: "studio", strength: 20, blur: false }, "a preset keeps what you set");
  run("background", "default");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(st, "settings.json"), "utf8")).background, { kind: "preset", name: "paper", strength: 60, blur: true }, "default resets the sliders too");
  assert.match(run("get", "background").stdout, /^paper \(default\)\n$/);
});

test("doctor shows the background line", async () => {
  const r = await runDoctor({ home: root, env: { HOME: root, PATH: "/usr/bin:/bin", ONIONSKIN_STATE_DIR: process.env.ONIONSKIN_STATE_DIR }, probes: { defaultBrowser: () => null, browsers: () => ["Google Chrome"], freeBytes: () => 50 * 1024 ** 3 } });
  assert.ok(r.checks.some((c) => c.name === "background"), "a background check");
  assert.match(formatDoctor(r), /NOTE\s+background: /);
});

test("agent settings: defaults, validated writes, and the background group is kept", () => {
  const f = path.join(process.env.ONIONSKIN_STATE_DIR, "settings.json");
  fs.rmSync(f, { force: true });
  assert.deepEqual(S.readSettings().agent, { cli: "claude", model: "sonnet", show: false });
  S.writeBackground({ kind: "preset", name: "aurora", strength: 30, blur: false });
  S.writeAgent({ show: true });
  assert.deepEqual(S.readSettings().agent, { cli: "claude", model: "sonnet", show: true });
  assert.equal(S.readSettings().background.name, "aurora", "writing the agent keeps the background");
  S.writeBackground({ kind: "preset", name: "studio", strength: 10, blur: true });
  assert.equal(S.readSettings().agent.show, true, "writing the background keeps the agent");
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  S.writeAgent({ model: "opus" });
  assert.deepEqual(S.readSettings().agent, { cli: "claude", model: "opus", show: true });
  for (const bad of [{ cli: "codex" }, { cli: "rm" }, { show: "yes" }, { model: "a b" }, { model: "x".repeat(80) }, { model: "-rf" }, null, "x"]) assert.throws(() => S.writeAgent(bad), S.SettingsError, JSON.stringify(bad));
  assert.deepEqual(S.readSettings().agent, { cli: "claude", model: "opus", show: true }, "a refused write changes nothing");
  fs.writeFileSync(f, JSON.stringify({ agent: { cli: "other", model: 5, show: "x" } }));
  assert.deepEqual(S.readSettings().agent, { cli: "claude", model: "sonnet", show: false }, "a bad file reads as the default");
});
