// Shared by test/html-render*.test.js: the structural check of a render copy (src/html-render.js), small image headers, an in-memory
// asset reader, and a generator of ordinary pages (seeded, so a failure names the page that made it).
import assert from "node:assert/strict";
import { parse } from "../../vendor/parse5/parse5.mjs";
import { PLACEHOLDER_LABELS, RENDER_CSP } from "../../src/html-render.js";

const HTML_NS = "http://www.w3.org/1999/xhtml";
const BANNED_ATTRS = new Set(["href", "action", "formaction", "ping", "background", "poster", "srcset", "usemap", "target", "name", "srcdoc", "download", "xlink:href"]);
const BANNED_ELEMENTS = new Set(["form", "meta", "link", "iframe", "frame", "frameset", "object", "embed", "applet", "base", "script", "noscript", "template", "svg", "math"]);
const OUR_DATA = new Set(["data-osk-id", "data-osk-href", "data-osk-placeholder"]);
const DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]*={0,2}$/;
const kids = (n) => (n.nodeName === "template" && n.content ? n.content.childNodes : n.childNodes || []);

/**
 * Parses a render copy (as the frame does: scripting off) and asserts what it must not hold, structurally: no attribute named in the
 * brief or starting with "on", no data-osk-* but ours, no banned element, no foreign element, one meta (the CSP, first in head), every
 * src a checked data: image, every url( in CSS a data: image. Returns {doc, elements: [copy element], texts: [copy text node]}.
 */
export function assertInert(bytes, label = "copy") {
  const s = Buffer.isBuffer(bytes) ? bytes.toString("utf8") : String(bytes);
  const doc = parse(s, { scriptingEnabled: false });
  const html = kids(doc).find((n) => n.tagName === "html");
  const head = kids(html).find((n) => n.tagName === "head");
  const first = kids(head).find((n) => n.tagName !== undefined);
  assert.equal(first?.tagName, "meta", `${label}: the first element in head is the CSP meta`);
  assert.deepEqual(first.attrs.map((a) => [a.name, a.value]), [["http-equiv", "Content-Security-Policy"], ["content", RENDER_CSP]], `${label}: the CSP meta is exactly the policy`);
  let metas = 0;
  const elements = [];
  const texts = [];
  const stack = [doc];
  while (stack.length) {
    const n = stack.pop();
    const ks = kids(n);
    for (let i = ks.length - 1; i >= 0; i--) stack.push(ks[i]);
    if (n.nodeName === "#text") {
      texts.push(n);
      if (n.parentNode?.tagName === "style") assertCss(n.value, label);
      continue;
    }
    if (n.tagName === undefined) continue;
    assert.equal(n.namespaceURI, HTML_NS, `${label}: a ${n.tagName} element in another namespace`);
    if (n.tagName === "meta") {
      metas++;
      continue;
    }
    assert.ok(!BANNED_ELEMENTS.has(n.tagName), `${label}: a ${n.tagName} element`);
    elements.push(n);
    for (const a of n.attrs) {
      const name = a.prefix ? `${a.prefix}:${a.name}` : a.name;
      assert.ok(!BANNED_ATTRS.has(name), `${label}: a ${name} attribute on ${n.tagName}`);
      assert.ok(!/^on/i.test(name), `${label}: an ${name} attribute on ${n.tagName}`);
      if (/^data-osk-/i.test(name)) assert.ok(OUR_DATA.has(name), `${label}: an incoming ${name}`);
      if (name === "data-osk-id") assert.match(a.value, /^\d+$/, `${label}: data-osk-id`);
      if (name === "data-osk-placeholder") assert.ok(Object.hasOwn(PLACEHOLDER_LABELS, a.value), `${label}: placeholder kind`);
      if (name === "src") assert.match(a.value.slice(0, 200000), DATA_IMAGE, `${label}: src on ${n.tagName}`);
      if (name === "style") assertCss(a.value, label);
    }
  }
  assert.equal(metas, 1, `${label}: one meta`);
  return { doc, elements, texts };
}

function assertCss(css, label) {
  for (const m of css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s]*))\s*\)/gi)) assert.match(m[1] ?? m[2] ?? m[3] ?? "", DATA_IMAGE, `${label}: url() in CSS`);
  assert.ok(!/url\s*\((?!\s*"data:image\/)/i.test(css), `${label}: a url( that is not a data: image`);
  assert.ok(!/@import/i.test(css), `${label}: @import in CSS`);
}

// ---- images -----------------------------------------------------------------------------------------------------------------------------
export function pngHeader(w, h, pad = 32) {
  const b = Buffer.alloc(33 + pad);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  b[24] = 8;
  b[25] = 2;
  return b;
}
export function gifHeader(w, h) {
  const b = Buffer.alloc(32);
  b.write("GIF89a", 0, "latin1");
  b.writeUInt16LE(w, 6);
  b.writeUInt16LE(h, 8);
  return b;
}
export function jpegHeader(w, h) {
  // SOI, an APP0 segment, then a baseline frame header
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.alloc(19);
  sof[0] = 0xff;
  sof[1] = 0xc0;
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(h, 5);
  sof.writeUInt16BE(w, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(16)]);
}
export function webpHeader(w, h) {
  const b = Buffer.alloc(40);
  b.write("RIFF", 0, "latin1");
  b.writeUInt32LE(32, 4);
  b.write("WEBP", 8, "latin1");
  b.write("VP8X", 12, "latin1");
  b.writeUInt32LE(10, 16);
  b.writeUIntLE(w - 1, 24, 3);
  b.writeUIntLE(h - 1, 27, 3);
  return b;
}

/** An asset reader over an object {"a/b.png": Buffer}: no file is touched. */
export function memReader(files) {
  return (segs, { max }) => {
    const k = segs.join("/");
    const b = files[k];
    if (!b) return { ok: false, code: "not_found" };
    if (b.length === 0) return { ok: false, code: "empty" };
    if (b.length > max) return { ok: false, code: "too_large" };
    return { ok: true, bytes: b, key: k };
  };
}

// ---- generated pages ----------------------------------------------------------------------------------------------------------------
/** A seeded random page of ordinary HTML features, nested a few levels. */
export function genPage(seed) {
  let x = seed >>> 0 || 1;
  const rnd = (n) => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) % n;
  };
  const words = ["alpha", "beta", "gamma & delta", "<tag>", "quote \"x\"", "na\u00efve", "\u{1f600} smile", "a\u00a0b"];
  const w = () => words[rnd(words.length)];
  const leaf = [
    () => `<script>document.title = "x"</script>`,
    () => `<button onclick="go()">${w()}</button>`,
    () => `<img src="https://example.invalid/p${rnd(9)}.png" alt="${w()}">`,
    () => `<img src="img/local.png" srcset="img/local.png 2x" alt="local">`,
    () => `<a href="https://example.invalid/${rnd(9)}" target="_blank" ping="https://example.invalid/p">${w()}</a>`,
    () => `<a href="#sec${rnd(9)}" name="n${rnd(9)}">${w()}</a>`,
    () => `<iframe src="https://example.invalid/f"></iframe>`,
    () => `<span style="font-weight: bold; background: url(https://example.invalid/b.png)">${w()}</span>`,
    () => `<span style="background-image: url(img/local.png)">${w()}</span>`,
    () => `<noscript><img src="https://example.invalid/n.png"></noscript>`,
    () => `<template><p>${w()}</p></template>`,
    () => `<svg width="10" height="10"><circle r="4"/><a href="https://example.invalid"><text>${w()}</text></a></svg>`,
    () => `<math><mi>x</mi></math>`,
    () => `<input name="q" formaction="https://example.invalid" type="text" value="${w()}">`,
    () => `<input type="image" src="https://example.invalid/i.png">`,
    () => `<video poster="https://example.invalid/p.png" src="v.mp4"></video>`,
    () => `<object data="https://example.invalid/o"></object><embed src="e.swf">`,
    () => `<x-widget data-osk-id="999" data-x="1">${w()}</x-widget>`,
    () => `<p data-osk-href="javascript:alert(1)">${w()}</p>`,
    () => `<table background="bg.png"><tr><td usemap="#m">${w()}</td></tr></table>`,
    () => `<figure><img src="img/local.png" alt="fig"><figcaption>${w()}</figcaption></figure>`,
    () => `${w()}<!-- comment -->${w()}`,
    () => `<pre>\n${w()}</pre>`,
    () => `<textarea name="t">\n${w()}</textarea>`,
    () => `<xmp><b>${w()}</b></xmp>`,
    () => `<a download href="file.zip">${w()}</a>`,
  ];
  const wrap = [
    (s) => `<div class="c${rnd(3)}" id="d${rnd(99)}">${s}</div>`,
    (s) => `<p>${s}</p>`,
    (s) => `<form action="https://example.invalid/s" method="post">${s}<button>Send</button></form>`,
    (s) => `<section><h2>${w()}</h2>${s}</section>`,
    (s) => `<ul><li>${s}</li><li>${w()}</li></ul>`,
    (s) => `<table><tr><td>${s}</td><td>${w()}</td></tr></table>`,
    (s) => `<b>${s}</b>`,
    (s) => `<a href="https://example.invalid/w">${s}</a>`,
    (s) => `<details open><summary>${w()}</summary>${s}</details>`,
  ];
  const piece = (depth) => {
    let s = "";
    const n = 1 + rnd(4);
    for (let i = 0; i < n; i++) s += depth > 0 && rnd(2) ? wrap[rnd(wrap.length)](piece(depth - 1)) : leaf[rnd(leaf.length)]();
    return s;
  };
  const head = [`<meta charset="utf-8">`, `<meta http-equiv="refresh" content="0;url=https://example.invalid">`, `<base href="https://example.invalid/">`, `<link rel="stylesheet" href="https://example.invalid/s.css">`, `<link rel="stylesheet" href="css/site.css">`, `<link rel="preconnect" href="https://example.invalid">`, `<style>@import url(https://example.invalid/i.css); p { margin: 4px }</style>`, `<script src="https://example.invalid/a.js"></script>`];
  let h = "";
  for (let i = 0; i < 3; i++) h += head[rnd(head.length)];
  return `<!DOCTYPE html><html lang="en"><head><title>${w()}</title>${h}</head><body onload="init()" background="bg.png">${piece(3)}</body></html>`;
}
