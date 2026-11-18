// A seeded property run of random HTML ops (batches of one to three, on places that do not nest) over the fixtures and generated pages,
// about 15 s of CPU (ONIONSKIN_TEST_PROPERTY_CPU_S changes it; at most 35 s of wall time on a busy machine). The property: zero silent mis-edits. Every write the driver makes is
// checked by an independent oracle: a fresh parse of the original, changed in memory the way the ops say (src/html.js is not used for
// it), must equal a fresh parse of the result, and the bytes outside the ops' places must be the original's. A refusal is fine; a
// write that differs from the oracle is a failure. Ordinary text and markup only; nothing is written to disk.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { P5 } from "../src/html-parser.js";
import * as H from "../src/html.js";
import { CHARSET_META } from "../src/html-write.js";
import { runOps } from "../src/ops/run.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIX = path.join(repo, "test", "fixtures", "html");
const CPU_S = Number(process.env.ONIONSKIN_TEST_PROPERTY_CPU_S || 15);
const SEED = 20261117;

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}
const pick = (r, a) => a[Math.floor(r() * a.length)];
const WORDS = ["alpha", "beta", "revenue", "Q3", "team", "café", "naïve", "report", "&", "<", ">", '"', "'", "a & b", "x < y", "über", "日本", "🙂", "  ", "\n", "tab\there", "&amp;", "{x}"];
const textOf = (r) => Array.from({ length: 1 + Math.floor(r() * 4) }, () => pick(r, WORDS)).join(pick(r, [" ", "", " "]));
function fragmentFor(ctx, r) {
  const t = ctx.tagName;
  if (t === "tr") return `<td>${esc(textOf(r))}</td>`;
  if (["table", "tbody", "thead", "tfoot"].includes(t)) return `<tr><td>${esc(textOf(r))}</td></tr>`;
  if (["ul", "ol", "menu"].includes(t)) return `<li>${esc(textOf(r))}</li>`;
  if (t === "dl") return `<dd>${esc(textOf(r))}</dd>`;
  if (["p", "span", "a", "b", "i", "em", "strong", "code", "h1", "h2", "h3", "h4", "h5", "h6", "small", "font", "sup", "sub", "td", "th", "li", "dt", "dd", "caption", "label", "q", "cite"].includes(t)) return pick(r, [`<span class="n">${esc(textOf(r))}</span>`, `<b>${esc(textOf(r))}</b>`, esc(textOf(r)), `<a href="https://example.com/${Math.floor(r() * 9)}">${esc(textOf(r))}</a>`]);
  return pick(r, [`<p>${esc(textOf(r))}</p>`, `<div><em>${esc(textOf(r))}</em> more</div>`, `<ul><li>${esc(textOf(r))}</li></ul>`, `<p>a <img src="pic.png" alt="${esc(textOf(r))}"> b</p>`]);
}
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ---- the oracle: a fresh parse changed in memory --------------------------------------------------------------------------------------
const kids = (x) => (x.nodeName === "template" && x.content ? x.content.childNodes : x.childNodes || []);
const at = (doc, p) => p.reduce((x, i) => kids(x)[i], doc);
/** Adjacent text merged and empty text dropped, everywhere (the parser never makes either, so this changes only what a mutation did). */
function normalize(doc) {
  const st = [doc];
  while (st.length) {
    const x = st.pop();
    const ks = kids(x);
    for (let k = ks.length - 1; k >= 0; k--) {
      if (ks[k].nodeName === "#text" && ks[k].value === "") ks.splice(k, 1);
      else if (k > 0 && ks[k].nodeName === "#text" && ks[k - 1].nodeName === "#text") {
        ks[k - 1] = { ...ks[k - 1], value: ks[k - 1].value + ks[k].value };
        ks.splice(k, 1);
      }
    }
    for (const c of ks) st.push(c);
  }
  return doc;
}
const fresh = (text) => P5.parse(text, { scriptingEnabled: true });

/** Text nodes under an element an op may search (not in script, style or other raw text, not template content). */
const RAW = new Set(["script", "style", "xmp", "iframe", "noembed", "noframes", "plaintext", "noscript"]);
function textsUnder(el) {
  const out = [];
  const st = [el];
  while (st.length) {
    const x = st.pop();
    if (x.nodeName === "#text") out.push(x);
    else if (!(x.tagName && (RAW.has(x.tagName) || x.tagName === "template"))) for (let i = kids(x).length - 1; i >= 0; i--) st.push(kids(x)[i]);
  }
  return out;
}

/** One random op on a random element of the reading, with how the oracle applies it and the source window it may change; or null. */
function makeOp(read, r) {
  const els = read.nodes.filter((x) => x.tagName && x.namespaceURI === H.HTML_NS && x.sourceCodeLocation?.startTag && !x.__hidden && !RAW.has(x.tagName) && !["html", "head", "body", "template"].includes(x.tagName));
  if (!els.length) return null;
  const el = pick(r, els);
  const loc = el.sourceCodeLocation;
  const p = H.pathOf(el);
  const target = { path: H.pathString(H.elementPath(el)) };
  const expect = { text_hash: H.ownHash(el) };
  const kind = pick(r, ["replace_text", "replace_text", "set_text", "set_attribute", "set_attribute", "remove_attribute", "insert_html", "insert_html", "replace_element", "delete_element"]);
  const base = { el, start: loc.startOffset, end: loc.endOffset };
  if (kind === "replace_text") {
    const ts = textsUnder(el).filter((x) => /[A-Za-z]{3,}/.test(x.value));
    if (!ts.length) return null;
    const t = pick(r, ts);
    const word = pick(r, t.value.match(/[A-Za-z]{3,}/g));
    // exactly once in the element's texts and its visible text, so the op and the oracle mean the same place
    if (textsUnder(el).reduce((n, x) => n + x.value.split(word).length - 1, 0) !== 1 || H.visibleText(read, el).split(word).length !== 2) return null;
    const repl = textOf(r);
    const tp = H.pathOf(t);
    // the window is the text's own source (an adoption-agency clone carries another element's location)
    return { ...base, win: H.textRange(t, read.text), op: { op: "replace_text", target, expect, find: word, replace: repl }, mutate: (doc) => (at(doc, tp).value = at(doc, tp).value.replace(word, () => repl)) };
  }
  if (kind === "set_text") {
    const ks = kids(el);
    if (ks.length !== 1 || ks[0].nodeName !== "#text") return null;
    const text = textOf(r);
    return { ...base, win: H.textRange(ks[0], read.text), op: { op: "set_text", target, expect, text }, mutate: (doc) => (kids(at(doc, p))[0].value = text) };
  }
  if (kind === "set_attribute" || kind === "remove_attribute") {
    const name = kind === "remove_attribute" ? el.attrs[0]?.name : pick(r, ["class", "title", "lang", "id", "align"]);
    if (!name || !/^[a-z][a-z0-9_.-]*$/.test(name)) return null;
    const value = textOf(r);
    const op = kind === "set_attribute" ? { op: kind, target, expect, name, value } : { op: kind, target, expect, name };
    return {
      ...base,
      win: [loc.startTag.startOffset, loc.startTag.endOffset],
      op,
      mutate: (doc) => {
        const x = at(doc, p);
        const i = x.attrs.findIndex((a) => a.name === name);
        if (kind === "remove_attribute") x.attrs.splice(i, 1);
        else if (i >= 0) x.attrs[i] = { ...x.attrs[i], value };
        else x.attrs.push({ name, value });
      },
    };
  }
  if (kind === "delete_element") return { ...base, win: [loc.startOffset, loc.endOffset], op: { op: kind, target, expect }, mutate: (doc) => kids(at(doc, p.slice(0, -1))).splice(p[p.length - 1], 1) };
  const where = kind === "replace_element" ? null : pick(r, ["before", "after", "first_child", "last_child"]);
  const inside = where === "first_child" || where === "last_child";
  const ctx = inside ? el : el.__par;
  if (!ctx?.tagName) return null;
  const html = fragmentFor(ctx, r);
  const into = (doc, parentPath, i, j) => {
    const parent = at(doc, parentPath);
    kids(parent).splice(i, j - i, ...P5.parseFragment(parent, html, { scriptingEnabled: true }).childNodes);
  };
  if (kind === "replace_element") return { ...base, win: [loc.startOffset, loc.endOffset], op: { op: kind, target, expect, html }, mutate: (doc) => into(doc, p.slice(0, -1), p[p.length - 1], p[p.length - 1] + 1) };
  const i = where === "before" ? p[p.length - 1] : where === "after" ? p[p.length - 1] + 1 : where === "first_child" ? 0 : kids(el).length;
  const point = where === "before" ? loc.startOffset : where === "after" ? loc.endOffset : where === "first_child" ? loc.startTag.endOffset : (loc.endTag?.startOffset ?? -1);
  if (point < 0) return null;
  return { ...base, win: [point, point], op: { op: kind, target, expect, where, html }, mutate: (doc) => into(doc, inside ? p : p.slice(0, -1), i, i) };
}

const nests = (a, b) => {
  for (let x = a; x; x = x.__par) if (x === b) return true;
  for (let x = b; x; x = x.__par) if (x === a) return true;
  return false;
};

test("positive control: the oracle tells a correct write from one corrupted in the text, in the markup, and outside the edited place", async () => {
  const src = '<!doctype html><html><head><title>t</title></head><body><p id="a">One two three.</p><p id="b">Four.</p></body></html>';
  const read = H.readHtml(Buffer.from(src));
  const el = read.byId.get("a");
  const res = await runOps({ bytes: Buffer.from(src), format: "html", name: "c.html", ops: [{ op: "replace_text", target: { element_id: "a" }, expect: { text_hash: H.ownHash(el) }, find: "two", replace: "2" }] });
  const md = normalize(fresh(src));
  at(md, H.pathOf(kids(el)[0])).value = "One 2 three.";
  const out = res.bytes.toString();
  assert.ok(H.deepEqual(md, fresh(out)), "the correct write matches");
  for (const bad of [out.replace("One 2", "One 3"), out.replace("<p id=\"a\">", "<p id=\"a\"><b>"), out.replace("Four.", "Four!")]) assert.ok(!H.deepEqual(md, fresh(bad)), bad);
});

test("property: random HTML ops over the fixtures and generated pages, about 15 s of CPU, zero silent mis-edits", async () => {
  const files = JSON.parse(fs.readFileSync(path.join(FIX, "manifest.json"), "utf8")).files.map((f) => fs.readFileSync(path.join(FIX, f.file)));
  for (let k = 0; k < 6; k++) files.push(Buffer.from(`<!doctype html><html><head><title>Page ${k}</title></head><body>\n${Array.from({ length: 30 }, (_, i) => `<p id="p${i}" class="c${i % 3}">Paragraph ${i} with <b>bold ${i}</b> and <a href="#p${i}">a link</a> &amp; more text here.</p>\n<ul><li>Item ${i}</li><li>Other ${i}</li></ul>`).join("\n")}\n<table><tr><td>Cell</td><td>Value</td></tr></table></body></html>`));
  const readable = files.map((b) => {
    try {
      return { bytes: b, read: H.readHtml(b) };
    } catch {
      return null;
    }
  }).filter(Boolean);
  const r = rng(SEED);
  const t0 = process.threadCpuUsage();
  const used = () => {
    const t = process.threadCpuUsage(t0);
    return (t.user + t.system) / 1e6;
  };
  const tally = { batches: 0, written: 0, ops: 0, refused: {}, silent: 0 };
  const silent = [];
  // CPU_S of this thread's CPU, but at most 35 s of wall time: under a parallel suite on a busy Mac the test must end inside its 60 s timeout
  const w0 = performance.now();
  while (used() < CPU_S && performance.now() - w0 < 35_000) {
    const f = pick(r, readable);
    const want = 1 + Math.floor(r() * 3);
    const made = [];
    for (let tries = 0; made.length < want && tries < 20; tries++) {
      const m = makeOp(f.read, r);
      if (m && !made.some((x) => nests(x.el, m.el) || x.el.__par === m.el.__par)) made.push(m);
    }
    if (!made.length) continue;
    tally.batches++;
    tally.ops += made.length;
    const res = await runOps({ bytes: f.bytes, format: "html", name: "p.html", ops: made.map((m) => m.op) });
    for (const x of res.results) if (x.status !== "applied") tally.refused[x.code || x.status] = (tally.refused[x.code || x.status] || 0) + 1;
    if (!res.bytes) continue;
    tally.written++;
    const bom = f.read.bomLen;
    let out = res.bytes.subarray(bom).toString("utf8");
    if (res.html?.charset_added) out = out.replace(CHARSET_META, "");
    // the oracle tree: the original changed in memory, later places (in tree order) first so earlier paths stay valid
    const md = fresh(f.read.text);
    const later = (a, b) => {
      const pa = H.pathOf(a.el);
      const pb = H.pathOf(b.el);
      for (let i = 0; i < Math.min(pa.length, pb.length); i++) if (pa[i] !== pb[i]) return pb[i] - pa[i];
      return pb.length - pa.length;
    };
    for (const m of [...made].sort(later)) m.mutate(md);
    normalize(md);
    const sameTree = H.deepEqual(md, fresh(out));
    // the bytes outside the windows: what is outside every op's window is the original's
    const src = f.read.text;
    const wins = made.map((m) => m.win).sort((a, b) => a[0] - b[0]);
    let ok = out.startsWith(src.slice(0, wins[0][0])) && out.endsWith(src.slice(wins[wins.length - 1][1]));
    let cursor = 0;
    for (let i = 0; i < wins.length && ok; i++) {
      const gap = src.slice(i ? wins[i - 1][1] : 0, wins[i][0]);
      const found = out.indexOf(gap, cursor);
      ok = found >= 0;
      cursor = found + gap.length;
    }
    if (!sameTree || !ok) {
      tally.silent++;
      if (silent.length < 3) silent.push({ ops: made.map((m) => m.op), sameTree, outside: ok });
    }
  }
  console.log(`property: ${JSON.stringify(tally)} in ${used().toFixed(1)} s of CPU`);
  assert.equal(tally.silent, 0, `silent mis-edits: ${JSON.stringify(silent).slice(0, 2000)}`);
  assert.ok(tally.written >= 100, `enough writes were checked (${tally.written})`);
});
