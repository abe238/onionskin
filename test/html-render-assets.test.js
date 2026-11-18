// src/html-render.js makeAssetReader against a real folder (R5): the traps a person's folder can hold, read the src/watch.js way. Every
// file is made in a temp folder and removed after.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import "../src/html-parser.js";
import * as H from "../src/html.js";
import { makeAssetReader, renderCopy } from "../src/html-render.js";
import { assertInert, gifHeader, pngHeader } from "./helpers/html-render-check.js";

const PNG = pngHeader(4, 3);

function folder() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "osk-render-")));
  const site = path.join(root, "site");
  const outside = path.join(root, "outside");
  fs.mkdirSync(path.join(site, "img", "a", "b", "c"), { recursive: true });
  fs.mkdirSync(path.join(site, ".private"));
  fs.mkdirSync(path.join(site, "Library"));
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "secret.png"), PNG);
  fs.writeFileSync(path.join(site, "real.png"), PNG);
  fs.writeFileSync(path.join(site, "img", "a", "b", "three.png"), PNG);
  fs.writeFileSync(path.join(site, "img", "a", "b", "c", "four.png"), PNG);
  fs.writeFileSync(path.join(site, ".private", "x.png"), PNG);
  fs.writeFileSync(path.join(site, "Library", "x.png"), PNG);
  fs.writeFileSync(path.join(site, "empty.png"), Buffer.alloc(0));
  fs.writeFileSync(path.join(site, "lies.png"), gifHeader(3, 3));
  fs.writeFileSync(path.join(site, "huge.png"), pngHeader(60_000, 60_000));
  fs.writeFileSync(path.join(site, "style.css"), "p { background: url(real.png) }");
  fs.symlinkSync(path.join(outside, "secret.png"), path.join(site, "link.png"));
  fs.symlinkSync(path.join(site, "loop.png"), path.join(site, "loop.png"));
  fs.symlinkSync(outside, path.join(site, "linkdir"));
  execFileSync("/usr/bin/mkfifo", [path.join(site, "fifo.png")]);
  return { root, site, outside };
}

const REFS = {
  "real.png": "shown",
  "img/a/b/three.png": "shown",
  "lies.png": "shown",
  "link.png": "symlink",
  "loop.png": "symlink",
  "linkdir/secret.png": "symlink",
  "fifo.png": "not_regular",
  "../outside/secret.png": "outside",
  "img/../../outside/secret.png": "outside",
  "empty.png": "empty",
  "huge.png": "dimensions",
  "img/a/b/c/four.png": "too_deep",
  ".private/x.png": "hidden",
  "Library/x.png": "library",
  "REAL.PNG": "not_found",
  "Real.png": "not_found",
  "missing.png": "not_found",
};

test("a real folder: symlinks (to a file, a loop, a folder), a FIFO, .., absolute, empty, a lying extension, huge header, too deep, dot and Library folders, case variants", () => {
  const { root, site, outside } = folder();
  try {
    const refs = { ...REFS, [path.join(outside, "secret.png")]: "absolute" };
    for (const [ref, want] of Object.entries(refs)) {
      const r = renderCopy(H.readHtml(Buffer.from(`<img src="${ref}">`)), { fileDir: site, readAsset: makeAssetReader() });
      assertInert(r.bytes, ref);
      if (want === "shown") assert.equal(r.stats.assets.shown, 1, ref);
      else assert.deepEqual(r.stats.assets.refused, { [want]: 1 }, ref);
    }
    // the lying extension is shown as what its bytes are
    const lies = renderCopy(H.readHtml(Buffer.from('<img src="lies.png">')), { fileDir: site, readAsset: makeAssetReader() });
    assert.match(lies.bytes.toString(), /src="data:image\/gif;base64,/);
    // a linked stylesheet in the folder, its url() too
    const css = renderCopy(H.readHtml(Buffer.from('<link rel="stylesheet" href="style.css"><p>x</p>')), { fileDir: site, readAsset: makeAssetReader() });
    assert.match(css.bytes.toString(), /<style data-osk-id="\d+">p \{ background: url\("data:image\/png;base64,/);
    // the home folder is never a source of assets, whatever it holds
    const home = renderCopy(H.readHtml(Buffer.from('<img src="real.png">')), { fileDir: os.homedir(), readAsset: makeAssetReader() });
    assert.equal(home.stats.folder, "home_or_root");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a FIFO named like an image never blocks: the render returns within a second", async () => {
  const { root, site } = folder();
  try {
    // in a worker, so a blocked open would show as a timeout here instead of hanging the test run
    const url = new URL("../src/html-render.js", import.meta.url).href;
    const parser = new URL("../src/html-parser.js", import.meta.url).href;
    const html = new URL("../src/html.js", import.meta.url).href;
    const code = `const { parentPort, workerData } = require("node:worker_threads");
(async () => {
  await import(${JSON.stringify(parser)});
  const H = await import(${JSON.stringify(html)});
  const R = await import(${JSON.stringify(url)});
  const t = Date.now();
  const r = R.renderCopy(H.readHtml(Buffer.from('<img src="fifo.png"><p style="background:url(fifo.png)">x</p><link rel=stylesheet href=fifo.png>')), { fileDir: workerData, readAsset: R.makeAssetReader() });
  parentPort.postMessage({ ms: Date.now() - t, refused: r.stats.assets.refused });
})();`;
    const w = new Worker(code, { eval: true, workerData: site });
    const res = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => (w.terminate(), reject(new Error("the render did not return within 5 s"))), 5000);
      w.once("message", (m) => (clearTimeout(timer), resolve(m)));
      w.once("error", (e) => (clearTimeout(timer), reject(e)));
    });
    await w.terminate();
    assert.ok(res.ms < 1000, `${res.ms} ms`);
    assert.deepEqual(res.refused, { not_regular: 3 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the reader itself: a file swapped for a FIFO after its listing is refused, never read", () => {
  const { root, site } = folder();
  try {
    const read = makeAssetReader();
    assert.equal(read(["real.png"], { fileDir: site, max: 1024 }).ok, true);
    fs.rmSync(path.join(site, "real.png"));
    execFileSync("/usr/bin/mkfifo", [path.join(site, "real.png")]);
    const t = Date.now();
    assert.deepEqual(read(["real.png"], { fileDir: site, max: 1024 }), { ok: false, code: "not_regular" });
    assert.ok(Date.now() - t < 1000);
    assert.deepEqual(read(["huge.png"], { fileDir: site, max: 10 }), { ok: false, code: "too_large" });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the reader itself: a folder on the way swapped for a symlink to outside between its check and the open is refused (029e51b, html-render.js:211)", () => {
  const { root, site, outside } = folder();
  try {
    // outside holds a file at the same names, with other bytes
    fs.mkdirSync(path.join(outside, "img", "a", "b"), { recursive: true });
    fs.writeFileSync(path.join(outside, "img", "a", "b", "three.png"), gifHeader(9, 9));
    const swap = () => {
      fs.renameSync(path.join(site, "img"), path.join(site, "img.real"));
      fs.symlinkSync(path.join(outside, "img"), path.join(site, "img"));
    };
    const back = () => {
      fs.rmSync(path.join(site, "img"));
      fs.renameSync(path.join(site, "img.real"), path.join(site, "img"));
    };
    const ref = ["img", "a", "b", "three.png"];
    assert.equal(makeAssetReader()(ref, { fileDir: site, max: 1024 }).ok, true, "the real folder is read");
    // swapped after the folders were checked, before the file's lstat and open: the open follows the symlinked folder
    const r1 = makeAssetReader({ hooks: { beforeFile: swap } })(ref, { fileDir: site, max: 1024 });
    assert.deepEqual(r1, { ok: false, code: "changed" });
    back();
    // swapped, then put back right after the open: the path no longer leads to the open file
    const r2 = makeAssetReader({ hooks: { beforeFile: swap, afterOpen: back } })(ref, { fileDir: site, max: 1024 });
    assert.deepEqual(r2, { ok: false, code: "changed" });
    // and the render: the outside bytes are never in the copy
    const copy = renderCopy(H.readHtml(Buffer.from('<img src="img/a/b/three.png">')), { fileDir: site, readAsset: makeAssetReader({ hooks: { beforeFile: swap } }) });
    back();
    assert.ok(!copy.bytes.toString().includes(gifHeader(9, 9).toString("base64").slice(0, 16)), "no outside image in the copy");
    assert.equal(copy.stats.assets.shown, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
