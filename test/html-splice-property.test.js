// The byte-splice round trip of spike S2 (E3), ported at a size that runs in about 20 s of CPU, seeded: random text, attribute and
// element splices on the HTML fixtures (test/fixtures/html) and on generated pages. For every op the proof (src/html.js proveSplice)
// is checked against an independent oracle: a fresh parse of the old text, changed in memory the way the op says, compared node by node
// (its own serializer, not html.js) with a fresh parse of the new bytes, and the bytes outside the splice unchanged. Pass: no op the
// proof accepts is wrong (0 silent mis-splices), no op it refuses is right, and every deliberately corrupted splice that changes the tree
// is refused. ONIONSKIN_TEST_HTML_OPS sets the number of random ops. Nothing is written to disk.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import "../src/html-parser.js";
import { parse, parseFragment, serialize } from "../vendor/parse5/parse5.mjs";
import * as H from "../src/html.js";

const SEED = 20261117;
const OPS = Number(process.env.ONIONSKIN_TEST_HTML_OPS || 16000);
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "html");
const HTMLNS = "http://www.w3.org/1999/xhtml";
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr", "param", "keygen", "image", "basefont", "bgsound", "frame"]);
const FROZEN = new Set(["script", "style", "xmp", "iframe", "noembed", "noframes", "plaintext", "noscript", "title", "textarea", "template"]);

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
const WORDS = ["alpha", "beta", "revenue", "Q3", "team", "café", "naïve", "report"];
const SPECIAL = ["<", ">", "&", "&amp;", '"', "'", "</p>", "<b>x</b>", " ", "\u{1F600}", "é", "\n", "  ", "\t", "</title>", "</textarea>", "&#60;", "<!--", "-->", "]]>", "{{x}}", "&copy", "‍", "</script>"];
function randText(r) {
  const x = r();
  if (x < 0.04) return "";
  if (x < 0.08) return pick(r, [" ", "\n", "  \n "]);
  let s = r() < 0.06 ? "\n" : "";
  const k = 1 + Math.floor(r() * 7);
  for (let i = 0; i < k; i++) s += (r() < 0.35 ? pick(r, SPECIAL) : pick(r, WORDS)) + (r() < 0.7 ? " " : "");
  if (r() < 0.03) s += "\r";
  return s;
}

// ---- the oracle: an independent canonical form of a tree, and the op applied in memory ---------------------------------------------
const kidsOf = (n) => (n.nodeName === "template" && n.content ? n.content.childNodes : n.childNodes || []);
function canon(root) {
  const out = [];
  const st = [root];
  while (st.length) {
    const n = st.pop();
    if (n === null) {
      out.push(")");
      continue;
    }
    if (n.nodeName === "#text") out.push(`t${JSON.stringify(n.value)}`);
    else if (n.nodeName === "#comment") out.push(`c${JSON.stringify(n.data)}`);
    else if (n.nodeName === "#documentType") out.push(`d${JSON.stringify([n.name, n.publicId, n.systemId])}`);
    else if (n.tagName !== undefined) out.push(`e${JSON.stringify([n.namespaceURI, n.tagName, n.attrs.map((a) => [a.name, a.value, a.namespace || "", a.prefix || ""])])}(`);
    else out.push(`${n.nodeName}(`);
    if (n.nodeName.startsWith("#") && n.nodeName !== "#document" && n.nodeName !== "#document-fragment") continue;
    st.push(null);
    const ks = kidsOf(n);
    for (let i = ks.length - 1; i >= 0; i--) st.push(ks[i]);
  }
  return out.join("\n");
}
const at = (doc, p) => p.reduce((n, i) => (n ? kidsOf(n)[i] : null), doc);
/** Is the new file exactly the old one with the op applied? {tree, bytes} */
function oracle(oldText, op, newBytes, oldBytes, b0, b1, insLen) {
  const bytes = newBytes.subarray(0, b0).equals(oldBytes.subarray(0, b0)) && newBytes.subarray(b0 + insLen).equals(oldBytes.subarray(b1));
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(newBytes.subarray(op.bomLen));
  } catch {
    return { tree: false, bytes };
  }
  const want = parse(oldText);
  if (op.attrs) at(want, op.path).attrs = op.attrs.map((a) => ({ ...a }));
  else {
    const list = kidsOf(at(want, op.parentPath));
    list.splice(op.i, op.j - op.i, ...op.nodes());
    for (let k = list.length - 1; k >= 0; k--) {
      if (list[k].nodeName === "#text" && list[k].value === "") list.splice(k, 1);
      else if (k > 0 && list[k].nodeName === "#text" && list[k - 1].nodeName === "#text") (list[k - 1] = { nodeName: "#text", value: list[k - 1].value + list[k].value }), list.splice(k, 1);
    }
  }
  return { tree: canon(want) === canon(parse(text)), bytes };
}

// ---- ops -------------------------------------------------------------------------------------------------------------------------------
function fragmentFor(ctx, r) {
  const t = ctx.tagName;
  if (ctx.namespaceURI === "http://www.w3.org/2000/svg") return "<text>new</text>";
  if (ctx.namespaceURI === "http://www.w3.org/1998/Math/MathML") return "<mi>x</mi>";
  if (t === "tr") return "<td>new cell</td>";
  if (["table", "tbody", "thead", "tfoot"].includes(t)) return "<tr><td>new row</td></tr>";
  if (["ul", "ol", "menu"].includes(t)) return "<li>new item</li>";
  if (t === "dl") return "<dd>new def</dd>";
  if (["select", "optgroup", "datalist"].includes(t)) return "<option>new option</option>";
  if (t === "head") return '<meta name="osk" content="x">';
  if (["html", "frameset", "colgroup"].includes(t) || FROZEN.has(t)) return null;
  if (["p", "span", "a", "b", "i", "em", "strong", "code", "h1", "h2", "h3", "h4", "h5", "h6", "label", "small", "font", "sup", "sub"].includes(t)) return '<span class="osk">new &amp; text</span>';
  return pick(r, ["<p>new paragraph</p>", '<span class="osk">new</span>', "<div><b>new</b> block</div>", "<p>a <em>b</em> c</p>"]);
}
const quoteOf = (src) => {
  const eq = src.indexOf("=");
  if (eq < 0) return null;
  const c = src.slice(eq + 1).trimStart()[0];
  return c === '"' || c === "'" ? c : "";
};

/** One random op on a reading: {splice: {s, e, repl}, edit (for the proof), oracle op} or {skip}. */
function makeOp(R, r) {
  const { text } = R;
  const roll = r();
  const texts = R.nodes.filter((x) => x.nodeName === "#text" && x.__ok === true);
  const els = R.nodes.filter((x) => x.tagName !== undefined && x.sourceCodeLocation?.startTag && x.__ctx && !["html", "head", "body"].includes(x.tagName));
  const base = { bomLen: R.bomLen };
  if (roll < 0.5) {
    if (!texts.length) return { skip: "no-text" };
    const x = pick(r, texts);
    return { kind: "text", node: x, newText: randText(r).replace(/\u0000/g, "") };
  }
  if (roll < 0.53) {
    const ws = R.nodes.filter((x) => x.nodeName === "#text" && x.sourceCodeLocation && !/\S/.test(x.value) && x.__ctx && H.textContext(x) === "normal");
    if (!ws.length) return { skip: "no-ws" };
    const x = pick(r, ws);
    const t = pick(r, WORDS);
    const [s, e] = H.textRange(x, text);
    return { kind: "text_ws", splice: { s, e, repl: t }, edit: H.editText(x, t), o: { ...base, parentPath: H.pathOf(x.__par), i: x.__idx, j: x.__idx + 1, nodes: () => [{ nodeName: "#text", value: t }] } };
  }
  if (roll < 0.78) {
    const pool = els.filter((x) => x.namespaceURI === HTMLNS);
    if (!pool.length) return { skip: "no-element" };
    const x = pick(r, pool);
    const st = x.sourceCodeLocation.startTag;
    const sub = x.attrs.length ? pick(r, ["set", "add", "remove"]) : "add";
    let attrs;
    let splice;
    if (sub === "add") {
      const name = pick(r, ["title", "class", "alt", "lang"]);
      if (x.attrs.some((a) => a.name === name)) return { skip: "attr-exists" };
      const v = randText(r);
      const q = H.escapeAttr(v, '"');
      let pos = st.startOffset + 1 + x.tagName.length;
      for (const a of Object.values(st.attrs || {})) if (a.endOffset > pos) pos = a.endOffset;
      splice = { s: pos, e: pos, repl: ` ${name}=${q.out}` };
      attrs = [...x.attrs, { name, value: v }];
    } else {
      const a = pick(r, x.attrs);
      const l = st.attrs?.[a.name];
      if (!l) return { skip: "attr-no-location" };
      if (sub === "set") {
        const v = randText(r);
        const src = text.slice(l.startOffset, l.endOffset);
        const q = H.escapeAttr(v, quoteOf(src) ?? '"');
        splice = { s: l.startOffset, e: l.endOffset, repl: `${src.slice(0, a.name.length)}=${q.out}` };
        attrs = x.attrs.map((y) => (y === a ? { ...y, value: v } : y));
      } else {
        let s = l.startOffset;
        while (s > 0 && /[\t\n\f\r ]/.test(text[s - 1])) s--;
        splice = { s, e: l.endOffset, repl: "" };
        attrs = x.attrs.filter((y) => y !== a);
      }
    }
    return { kind: `attr_${sub}`, splice, edit: H.editAttributes(x, attrs), o: { ...base, path: H.pathOf(x), attrs } };
  }
  if (!els.length) return { skip: "no-element" };
  const x = pick(r, els);
  if (!H.elementAddressable(R, x.__id)) return { skip: "element-not-addressable" };
  const kind = pick(r, ["delete", "insert_before", "insert_after", "insert_first", "insert_last", "replace"]);
  const loc = x.sourceCodeLocation;
  if (kind === "delete") return { kind, splice: { s: loc.startOffset, e: loc.endOffset, repl: "" }, edit: H.editChildren(x.__par, x.__idx, x.__idx + 1, () => []), o: { ...base, parentPath: H.pathOf(x.__par), i: x.__idx, j: x.__idx + 1, nodes: () => [] } };
  let ctx;
  let parent;
  let i;
  let pos;
  if (kind === "insert_before" || kind === "insert_after" || kind === "replace") [ctx, parent, i, pos] = [x.__ctx, x.__par, x.__idx + (kind === "insert_after" ? 1 : 0), kind === "insert_after" ? loc.endOffset : loc.startOffset];
  else {
    if (VOID.has(x.tagName) || FROZEN.has(x.tagName)) return { skip: "void-or-frozen" };
    if (kind === "insert_last" && !loc.endTag) return { skip: "no-end-tag" };
    [ctx, parent] = [x, x];
    [i, pos] = kind === "insert_first" ? [0, loc.startTag.endOffset] : [H.kids(x).length, loc.endTag.startOffset];
  }
  const frag = fragmentFor(ctx, r);
  if (!frag) return { skip: "no-fragment" };
  if (serialize(parseFragment(ctx, frag)) !== frag) return { skip: "fragment-not-well-formed" };
  const make = () => parseFragment(ctx, frag).childNodes;
  const j = kind === "replace" ? i + 1 : i;
  return { kind, splice: kind === "replace" ? { s: loc.startOffset, e: loc.endOffset, repl: frag } : { s: pos, e: pos, repl: frag }, edit: H.editChildren(parent, i, j, make), o: { ...base, parentPath: H.pathOf(parent), i, j, nodes: make } };
}

function pages() {
  const files = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")).files.map((f) => fs.readFileSync(path.join(dir, f.file)));
  const gen = [];
  for (let k = 0; k < 6; k++) {
    let body = `<h1 id="t${k}">Title ${k}</h1>`;
    for (let i = 0; i < 40; i++) body += i % 7 === 0 ? `<table><tr><td>${i} &amp; a</td><td title='q${i}' class=c${i}>cell</td></tr></table>` : `<p class="p${i}">Paragraph ${i} with <b>bold</b>, <a href="#x">link</a> and café.</p>\r\n`;
    gen.push(Buffer.from(`<!doctype html><html><head><meta charset="utf-8"><title>Page ${k}</title></head><body>${body}<pre>\ncode</pre><textarea>\nbox</textarea></body></html>`));
  }
  const out = [];
  for (const b of [...files, ...gen]) {
    try {
      out.push(H.readHtml(b));
    } catch {} // a fixture that is refused (not UTF-8): not part of this test
  }
  return out;
}

test(`splice round trip: ${OPS} seeded random ops on the HTML fixtures, 0 silent mis-splices, 0 false refusals, every corrupted splice that changes the tree refused`, { timeout: 600_000 }, () => {
  const R = pages();
  assert.ok(R.length >= 40, `${R.length} pages open`);
  const t = { ops: 0, accepted: 0, refusedRight: 0, policy: 0, silent: [], falseRefusals: [], skipped: {}, refusedBefore: {}, controls: { total: 0, changed: 0, caught: 0, missed: [] }, kinds: {} };
  const cpu0 = process.cpuUsage();
  for (let n = 0; n < OPS; n++) {
    const r = rng((SEED + n * 7919) >>> 0);
    r();
    const read = R[Math.floor(r() * R.length)];
    let op = makeOp(read, r);
    if (op.skip) {
      t.skipped[op.skip] = (t.skipped[op.skip] || 0) + 1;
      continue;
    }
    if (op.kind === "text") {
      // the public API: spliceText escapes and proves; the same splice is rebuilt here for the oracle and the controls
      const x = op.node;
      const res = H.spliceText(read, x.__id, op.newText);
      const [s, e] = H.textRange(x, read.text);
      const pst = x.__ctx.sourceCodeLocation?.startTag;
      const esc = H.escapeText(op.newText, H.textContext(x), { atStartOfLeadingLf: ["pre", "listing", "textarea"].includes(x.__ctx.tagName) && x.__ctx.namespaceURI === HTMLNS && !!pst && s === pst.endOffset });
      if (!esc.ok) {
        assert.equal(res.ok, false);
        t.refusedBefore[esc.code] = (t.refusedBefore[esc.code] || 0) + 1;
        continue;
      }
      op = { ...op, splice: { s, e, repl: esc.out }, edit: H.editText(x, op.newText), o: { bomLen: read.bomLen, parentPath: H.pathOf(x.__par), i: x.__idx, j: x.__idx + 1, nodes: () => (op.newText === "" ? [] : [{ nodeName: "#text", value: op.newText }]) }, viaApi: res };
    }
    t.ops++;
    const k = (t.kinds[op.kind] ||= { ops: 0, accepted: 0, refused: 0 });
    k.ops++;
    const bytes = H.spliceBytes(read, op.splice.s, op.splice.e, op.splice.repl);
    const proof = H.proveSplice(read, bytes, op.edit);
    if (op.viaApi) assert.equal(op.viaApi.ok, proof.ok, "spliceText answers what the proof answers");
    if (op.viaApi?.ok) assert.ok(op.viaApi.bytes.equals(bytes), "spliceText wrote the same bytes");
    const b0 = read.toByte(op.splice.s);
    const b1 = read.toByte(op.splice.e);
    const o = oracle(read.text, op.o, bytes, read.bytes, b0, b1, Buffer.byteLength(op.splice.repl));
    const good = o.tree && o.bytes;
    const ex = () => ({ n, kind: op.kind, repl: op.splice.repl.slice(0, 60), around: read.text.slice(Math.max(0, op.splice.s - 30), op.splice.e + 30).slice(0, 120), proof: proof.code || "ok" });
    if (proof.ok) {
      if (good) (t.accepted++, k.accepted++);
      else t.silent.push(ex());
    } else if (good && proof.code === "decode" && H.decodeHtml(bytes).code === "not_utf8") t.policy++; // a charset changed away from UTF-8: refused by design (R10)
    else if (good) t.falseRefusals.push(ex());
    else (t.refusedRight++, k.refused++);
    // positive controls on every 10th text op: corrupt the splice on purpose
    if ((op.kind === "text" || op.kind === "text_ws") && n % 10 === 0) {
      const variants = [];
      if (op.splice.s > 0) variants.push({ ...op.splice, s: op.splice.s - 1 });
      if (op.newText && op.newText !== op.splice.repl) variants.push({ ...op.splice, repl: op.newText });
      variants.push({ ...op.splice, s: op.splice.s + 1, e: Math.min(op.splice.e + 1, read.text.length) });
      for (const v of variants) {
        let cb;
        try {
          cb = H.spliceBytes(read, v.s, v.e, v.repl);
        } catch {
          continue; // an offset inside a surrogate pair: no such splice
        }
        t.controls.total++;
        const co = oracle(read.text, op.o, cb, read.bytes, read.toByte(v.s), read.toByte(v.e), Buffer.byteLength(v.repl));
        if (co.tree) continue; // the corruption left the tree as the op said (harmless)
        t.controls.changed++;
        if (!H.proveSplice(read, cb, op.edit).ok) t.controls.caught++;
        else t.controls.missed.push({ n, v: v.repl.slice(0, 40) });
      }
    }
  }
  const c = process.cpuUsage(cpu0);
  const summary = { ops: t.ops, accepted: t.accepted, refusedRight: t.refusedRight, policy: t.policy, silent: t.silent.length, falseRefusals: t.falseRefusals.length, controls: { ...t.controls, missed: t.controls.missed.length }, cpuS: Math.round((c.user + c.system) / 1e5) / 10, kinds: t.kinds, skipped: t.skipped, refusedBefore: t.refusedBefore };
  console.log(JSON.stringify(summary));
  assert.deepEqual(t.silent, [], "silent mis-splices");
  assert.deepEqual(t.falseRefusals, [], "refused although right");
  assert.deepEqual(t.controls.missed, [], "corrupted splices the proof missed");
  assert.ok(t.ops >= OPS * 0.6 && t.accepted > t.ops / 2 && t.controls.changed > 50, JSON.stringify(summary));
  for (const kind of ["text", "text_ws", "attr_set", "attr_add", "attr_remove", "delete", "insert_before", "insert_after", "insert_first", "insert_last", "replace"]) assert.ok(t.kinds[kind]?.ops > 0, `no ${kind} op ran`);
});
