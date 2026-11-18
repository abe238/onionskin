// Retained size (src/retain.js): hostile inputs of every kind the page or a file can carry, generated in random combinations, through
// a draft save and a Send on the real Sessions object; the session file and the batch the agent receives stay under the caps, and no
// comment is lost. Then the draft route over HTTP: a draft past the cap of a request is a JSON refusal the page can show, not a cut
// connection. Temp dirs only.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, after } from "node:test";
import { buildZip, contentTypes, docxBytes, tmpdir, xlsxBytes } from "./helpers/zipbuild.js";
import { childServer } from "./helpers/stall.js";

const root = tmpdir();
process.env.ONIONSKIN_STATE_DIR = path.join(root, "st");
process.env.ONIONSKIN_NO_SOFFICE = "1";
const { Sessions } = await import("../src/session.js");
const { ensureStateDir } = await import("../src/paths.js");
const { REQUEST_MAX, SESSION_MAX, COMMENT_MAX, COMMENTS_MAX, NOTE_MAX, cleanEdit, cleanPageAnchor, cutText } = await import("../src/retain.js");
ensureStateDir();
after(() => fs.rmSync(root, { recursive: true, force: true }));

let seed = 20261117;
const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = (a) => a[Math.floor(rnd() * a.length)];
const col = (n) => {
  let s = "";
  for (n++; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};
const S_NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

// long texts of each kind V8 and the readers treat differently: ASCII, decomposed letters, CJK, emoji
const LONG = {
  ascii: "word ".repeat(1_600_000),
  decomposed: "é".repeat(1_000_000),
  cjk: "中文字".repeat(700_000),
  emoji: "😀".repeat(500_000),
};
const long = () => LONG[pick(Object.keys(LONG))];

// the files: one paragraph of 2 million characters, ordinary cells with 1,000-character values and a 1,000-character number format, a deck
const BIG_PARA = "A sentence of the long paragraph. ".repeat(60_000);
const FILES = {
  docx: () => docxBytes([BIG_PARA, "A short paragraph.", ...Array.from({ length: 50 }, (_, i) => `Paragraph ${i} of ordinary text.`)]),
  xlsx: () => {
    const rows = [];
    for (let r = 1; r <= 40; r++) rows.push(`<row r="${r}">${Array.from({ length: 20 }, (_, c) => `<c r="${col(c)}${r}" s="0" t="inlineStr"><is><t>${col(c)}${r}-${"x".repeat(996)}</t></is></c>`).join("")}</row>`);
    return buildZip({
      "[Content_Types].xml": contentTypes("xlsx").replace("</Types>", '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'),
      "_rels/.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
      "xl/workbook.xml": `<?xml version="1.0"?><workbook ${S_NS}><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets><definedNames>${Array.from({ length: 50 }, (_, i) => `<definedName name="N${i}${"x".repeat(200)}">Sheet1!$A$1:$J$20</definedName>`).join("")}</definedNames></workbook>`,
      "xl/_rels/workbook.xml.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
      "xl/styles.xml": `<?xml version="1.0"?><styleSheet ${S_NS}><numFmts count="1"><numFmt numFmtId="164" formatCode="${"é".repeat(1000)}"/></numFmts><cellXfs count="1"><xf numFmtId="164"/></cellXfs></styleSheet>`,
      "xl/worksheets/sheet1.xml": `<?xml version="1.0"?><worksheet ${S_NS}><sheetData>${rows.join("")}</sheetData></worksheet>`,
    });
  },
  pptx: () => {
    const P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
    const sp = (id, text) => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Shape ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;
    return buildZip({
      "[Content_Types].xml": contentTypes("pptx"),
      "ppt/presentation.xml": `<?xml version="1.0"?><p:presentation ${P} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>`,
      "ppt/_rels/presentation.xml.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>',
      "ppt/slides/slide1.xml": `<?xml version="1.0"?><p:sld ${P}><p:cSld><p:spTree>${sp(2, BIG_PARA)}${sp(3, "A short shape.")}</p:spTree></p:cSld></p:sld>`,
    });
  },
};

// one hostile comment of a kind, for a format
const GEN = {
  longQuote: (f) => (f === "docx" ? { kind: "text", anchor: { location: { blockPath: [0], start: 0, end: 10 }, quote: long(), prefix: long(), suffix: long() } } : f === "pptx" ? { kind: "text", anchor: { location: { slideIndex: 0, slideId: 256, shapeId: 2 }, quote: long(), prefix: long(), suffix: long() } } : { kind: "element", anchor: { location: { sheetIndex: 0, sheetName: "Sheet1", range: "A1:J20" }, quote: long() } }),
  longParaText: (f) => ({ kind: "element", anchor: { location: f === "docx" ? { blockPath: [0] } : f === "pptx" ? { slideIndex: 0, shapeId: 2 } : { sheetIndex: 0, sheetName: "Sheet1", range: "A1" }, quote: long(), paraText: long(), hitKind: "paragraph", format: long() } }),
  longNames: (f) => ({ kind: "element", id: long(), anchor: { location: f === "xlsx" ? { sheetIndex: 0, sheetName: long(), range: long() } : f === "pptx" ? { slideIndex: 0, shapeId: 2, shapeName: long(), extra: long() } : { blockPath: [0], paraId: long() }, quote: "x" } }),
  deepLocation: () => {
    let o = { v: long() };
    for (let i = 0; i < 2000; i++) o = { o, a: Array.from({ length: 200 }, () => i) };
    return { kind: "element", anchor: { location: o, quote: "x" } };
  },
  deepRange: (f) => ({ kind: "element", anchor: { location: f === "xlsx" ? { sheetIndex: 0, sheetName: "Sheet1", range: pick(["A1:XFD1048576", "A:XFD", "1:1048576", "A1:J20", "B2:K21"]) } : { blockPath: Array.from({ length: 100_000 }, () => 0) }, quote: "" } }),
  longText: () => ({ kind: "text", text: long(), anchor: null }),
  pin: (f) => ({ kind: "pin", anchor: { location: f === "pptx" ? { slideIndex: 0, shapeId: 2 } : f === "xlsx" ? { sheetIndex: 0, sheetName: "Sheet1", range: "C3" } : { blockPath: [1] }, quote: long() }, pin: { xFrac: 1e308, yPx: long(), on: long(), sxFrac: { a: long() } } }),
  ordinary: (f) => ({ kind: "element", anchor: { location: f === "xlsx" ? { sheetIndex: 0, sheetName: "Sheet1", range: "A1:J20" } : f === "pptx" ? { slideIndex: 0, shapeId: 3 } : { blockPath: [1] }, quote: "A short paragraph." } }),
};
// arbitrary nested junk, put into every object the page sends: none of it is a field Onionskin reads, so none of it may be stored
const makeJunk = (depth) => {
  const r = rnd();
  if (depth === 0 || r < 0.2) return pick([long(), 1e308, -0, null, true, "x".repeat(900)]);
  if (r < 0.5) return Array.from({ length: pick([1, 32, 200]) }, () => makeJunk(depth - 1));
  return Object.fromEntries(Array.from({ length: pick([1, 31, 64]) }, (_, i) => [pick([`k${i}`, "__proto__", "constructor", long().slice(0, 50)]), makeJunk(depth - 1)]));
};
// a pool made once and shared (the generator alone would not fit in memory otherwise); each value is up to 64 x 200 x 200 nodes
const JUNK = Array.from({ length: 12 }, () => makeJunk(3));
const junk = () => pick(JUNK);
const salt = (o) => (o && typeof o === "object" && !Array.isArray(o) ? { ...o, junk: junk(), [`x${Math.floor(rnd() * 1e6)}`]: junk() } : o);
const withJunk = (c) => ({ ...salt(c), anchor: c.anchor && salt({ ...c.anchor, location: salt(c.anchor.location) }), pin: salt(c.pin) });
// what the server reads of a location (src/retain.js cleanLocation): anything else stored would be the page's junk
const LOCATION_KEYS = new Set(["blockPath", "paraId", "start", "end", "protected", "protectedReason", "sheetIndex", "sheetName", "range", "slideIndex", "slideId", "shapeId", "shapeName", "cell"]);
const onlyKnown = (loc, label) => {
  if (loc == null) return;
  for (const k of Object.keys(loc)) assert.ok(LOCATION_KEYS.has(k), `${label}: a stored location keeps "${k.slice(0, 20)}"`);
  if (loc.cell) assert.deepEqual(Object.keys(loc.cell).sort(), ["col", "row"]);
};
const EDIT = () => ({ kind: long(), before: long(), after: long(), label: long(), location: { blockPath: [0], sheetName: long(), deep: { deeper: { deepest: { v: long() } } } } });
const VIEW = () => ({ format: pick(["docx", "xlsx", "pptx"]), sheetIndex: 0, sheetName: long(), topLeft: long(), selection: long(), blockPath: [0], quote: long(), zoom: long(), raw: { x: long() } });

const bytes = (v) => Buffer.byteLength(JSON.stringify(v));
const sessionBytes = (s) => fs.statSync(path.join(process.env.ONIONSKIN_STATE_DIR, "sessions", `${s.key}.json`)).size;

test("property: hostile comments, edits, notes and view states through draft save and Send keep the session file and the batch under the caps, and every comment", { timeout: 600_000 }, () => {
  const S = new Sessions();
  const kinds = Object.keys(GEN);
  for (let round = 0; round < 12; round++) {
    const format = ["docx", "xlsx", "pptx"][round % 3];
    const f = path.join(root, `r${round}.${format}`);
    fs.writeFileSync(f, FILES[format]());
    const s = S.open(f);
    const n = pick([1, 50, 500, 600]);
    const mix = kinds.filter(() => rnd() < 0.5);
    if (!mix.length) mix.push("longQuote");
    const all = Array.from({ length: n }, (_, i) => {
      const g = GEN[mix[i % mix.length]](format);
      const c = { id: g.id ?? `c${round}-${i}`, kind: g.kind, text: g.text ?? `comment ${i}`, anchor: g.anchor, pin: g.pin ?? null };
      return rnd() < 0.5 ? withJunk(c) : c;
    });
    const label = `round ${round} (${format}, ${n} comments: ${mix.join(", ")})`;
    let note = rnd() < 0.5 ? long() : "";
    // past the count or the note's cap a save is refused in words and nothing changes (the page itself stops there); then the page's own
    // limits: the first 500 comments and a note at its cap
    let comments = all;
    if (n > COMMENTS_MAX || note.length > NOTE_MAX) {
      assert.throws(() => S.setDraft(s.key, { comments, note }), (e) => e.status === 413 && ["too_many_comments", "note_too_long"].includes(e.extra?.code), label);
      assert.equal(s.comments.length, 0, `${label}: a refused save changes nothing`);
      comments = all.slice(0, COMMENTS_MAX);
      note = cutText(note, NOTE_MAX);
    }
    S.setDraft(s.key, { comments, note });
    let size = sessionBytes(s);
    assert.ok(size < SESSION_MAX, `${label}: draft session file ${(size / 1e6).toFixed(1)} MB`);
    assert.equal(s.comments.length, comments.length, `${label}: every comment of the draft is kept`);
    for (const c of s.comments) assert.ok(bytes(c) <= COMMENT_MAX, `${label}: one comment of ${bytes(c)} bytes`);
    for (const c of s.comments) onlyKnown(c.anchor?.location, label);
    const edits = rnd() < 0.5 ? Array.from({ length: pick([1, 20, 3000]) }, () => (rnd() < 0.5 ? { ...salt(EDIT()), location: salt(EDIT().location), kind: junk(), label: junk() } : EDIT())) : [];
    S.send(s.key, { baseSha: s.baseSha, comments, note, edits, viewState: rnd() < 0.5 ? salt(VIEW()) : undefined });
    size = sessionBytes(s);
    const batch = bytes(s.pending);
    assert.ok(size < SESSION_MAX, `${label}: session file ${(size / 1e6).toFixed(1)} MB after Send`);
    assert.ok(batch < SESSION_MAX, `${label}: batch ${(batch / 1e6).toFixed(1)} MB`);
    assert.equal(s.pending.instructions.comments.length, s.comments.length, `${label}: every comment is in the batch`);
    for (const c of s.comments) assert.ok(bytes(c) <= COMMENT_MAX, `${label}: one comment of ${bytes(c)} bytes after Send`);
    for (const e of s.edits) {
      onlyKnown(e.location, label);
      assert.ok(e.kind === null || typeof e.kind === "string", `${label}: an edit's kind is a string or null`);
      assert.ok(e.label === null || typeof e.label === "string", `${label}: an edit's label is a string or null`);
    }
    if (s.view?.raw) assert.ok(bytes(s.view.raw) < 4096, `${label}: the stored view is ${bytes(s.view.raw)} bytes`);
    assert.ok(!JSON.stringify(s.pending).includes('"junk"'), `${label}: no junk reaches the batch`);
    S.close(s.key);
  }
});

// CJK is 3 bytes a character in the file: 500 comments each at the cap of a field in every field reach the cap of a session file in bytes
// (about 70 MB) while staying under it in characters, so the writer's last-line cut is what holds it
test("500 comments and 2,000 typed edits of CJK text at every field's cap: the session file stays under its cap in bytes, every comment kept", { timeout: 300_000 }, () => {
  const S = new Sessions();
  const f = path.join(root, "cjk.docx");
  fs.writeFileSync(f, FILES.docx());
  const s = S.open(f);
  const t = "中".repeat(40_000);
  const comments = Array.from({ length: 500 }, (_, i) => ({ id: `k${i}`, kind: "element", text: t, anchor: { location: { blockPath: [0] }, quote: t, paraText: t, prefix: t, suffix: t, hitKind: "paragraph" } }));
  S.setDraft(s.key, { comments, note: t.slice(0, NOTE_MAX) }); // a note at its cap (one longer is refused, test/send-race.test.js)
  let size = sessionBytes(s);
  assert.ok(size < SESSION_MAX, `session file ${(size / 1e6).toFixed(1)} MB`);
  assert.equal(s.comments.length, 500);
  assert.ok(s.comments.every((c) => c.anchor?.cut), "each page anchor says it was cut");
  // 2,000 typed edits of 20,000 CJK characters before and after, each within a field's cap: 240 MB in all, so the writer cuts them
  const e = "文".repeat(20_000);
  S.send(s.key, { baseSha: s.baseSha, comments, note: "", edits: Array.from({ length: 2000 }, () => ({ kind: "text", before: e, after: e, label: "edit", location: { blockPath: [1] } })) });
  size = sessionBytes(s);
  assert.ok(size < SESSION_MAX, `session file ${(size / 1e6).toFixed(1)} MB after Send`);
  assert.equal(s.pending.instructions.comments.length, 500, "every comment is in the batch");
  assert.ok(s.edits.length === 2000 && s.edits.every((x) => x.cut && x.before.length === 2000), "the session writer cut every edit");
  S.close(s.key);
});

test("over HTTP: a draft past the cap of a request is a JSON refusal with a code the page shows (the connection is not cut); a draft under it is saved", { timeout: 300_000 }, async () => {
  const srv = await childServer({ prefix: "da-retain-" });
  try {
    const f = path.join(srv.root, "d.docx");
    fs.writeFileSync(f, docxBytes(["One short paragraph."]));
    const { key } = await srv.openPage(f);
    const big = "word ".repeat(Math.ceil(REQUEST_MAX / 5 / 4) + 10);
    const comments = Array.from({ length: 4 }, (_, i) => ({ id: `c${i}`, kind: "text", text: "hi", anchor: { location: { blockPath: [0], start: 0, end: 3 }, quote: big } }));
    const r = await srv.api(key, "/api/draft", { comments, note: "" });
    assert.equal(r.status, 413);
    assert.equal(r.json?.code, "too_large_request");
    assert.match(r.json.error, /larger than Onionskin takes/);
    const ok = await srv.api(key, "/api/draft", { comments: [{ id: "c1", kind: "text", text: "hi", anchor: { location: { blockPath: [0], start: 0, end: 3 }, quote: "One" } }], note: "" });
    assert.equal(ok.status, 200, "the same connection pool still works, and a draft under the cap is saved");
    assert.equal(ok.json.session.comments.length, 1);
  } finally {
    await srv.stop();
  }
});

// The review of 99d3c98: a location of blockPath [0] and 31 named children of 32 children of 32 strings of 900 characters makes a 28.85 MB
// comment under the 32 MiB request cap; seven Sends made a 202 MB session file and 3.9 s of the server's own CPU. Each object is now
// rebuilt from the fields Onionskin reads, so the file stays small and the request's own thread does little.
test("seven Sends of the review's 28 MB nested location keep a small session file and under a second of the server thread's CPU each", { timeout: 300_000 }, async () => {
  const S = new Sessions();
  const f = path.join(root, "nested.docx");
  fs.writeFileSync(f, docxBytes(["One ordinary paragraph."]));
  const s = await S.openAsync(f);
  const leaf = "x".repeat(900);
  const location = { blockPath: [0] };
  for (let i = 0; i < 31; i++) location[`k${i}`] = Object.fromEntries(Array.from({ length: 32 }, (_, j) => [`j${j}`, Array.from({ length: 32 }, () => leaf)]));
  const earlier = [];
  for (let n = 0; n < 7; n++) {
    const body = JSON.stringify({ baseSha: s.baseSha, comments: [...earlier, { id: `n${n}`, kind: "element", text: `comment ${n}`, anchor: { location, quote: "One ordinary paragraph." } }], note: "" });
    assert.ok(body.length > 28e6 && body.length < REQUEST_MAX, `request ${n}: ${(body.length / 1e6).toFixed(2)} MB`);
    const t = process.threadCpuUsage();
    const b = JSON.parse(body); // the server parses the body on its thread too
    await S.sendAsync(s.key, b);
    const cpu = process.threadCpuUsage(t);
    const ms = (cpu.user + cpu.system) / 1000;
    assert.ok(ms < 1000, `Send ${n}: ${ms.toFixed(0)} ms of this thread's CPU`);
    earlier.push({ id: `n${n}` }); // sent comments by id only, as in the review
  }
  const size = sessionBytes(s);
  assert.ok(size < 1e6, `session file ${(size / 1e6).toFixed(2)} MB after seven Sends`);
  assert.equal(s.comments.length, 7);
  for (const c of s.comments) assert.deepEqual(c.anchor.location, { blockPath: [0] });
  assert.ok(bytes(s.pending) < 1e6, `batch ${(bytes(s.pending) / 1e6).toFixed(2)} MB`);
  S.close(s.key);
});

// Every cut keeps whole characters: an emoji (two UTF-16 units) is never split, whichever side of a field is kept
test("property: every cut keeps whole characters, with astral characters at every cut boundary", () => {
  const astral = ["😀", "𝒜", "🇺", "𠀀"];
  const wellFormed = (v, label) => {
    if (typeof v === "string" && !v.isWellFormed()) assert.fail(`${label}: ${JSON.stringify(v.slice(0, 4))}...${JSON.stringify(v.slice(-4))}`);
  };
  for (let i = 0; i < 400; i++) {
    const max = pick([40, 64, 100, 200, 1000, 2000, 20_000]);
    const a = pick(astral);
    const pad = (k) => Array.from({ length: k }, () => (rnd() < 0.3 ? pick(astral) : "x")).join("");
    // an astral character straddling the boundary, from the start and from the end
    const head = "x".repeat(max - 1) + a + pad(Math.floor(rnd() * 5));
    const tail = pad(Math.floor(rnd() * 5)) + a + "x".repeat(max - 1);
    for (const v of [head, tail, pad(max + Math.floor(rnd() * 4))]) {
      const t = cutText(v, max);
      wellFormed(t, `cutText ${max}`);
      assert.ok(t.length <= max && v.startsWith(t));
      const anchor = cleanPageAnchor({ location: { blockPath: [0], sheetName: v, shapeName: v, paraId: v, range: v }, quote: v, paraText: v, prefix: v, suffix: v, format: v, hitKind: v });
      for (const [k, x] of Object.entries(anchor)) wellFormed(x, `anchor.${k} ${max}`);
      for (const [k, x] of Object.entries(anchor.location)) wellFormed(x, `location.${k} ${max}`);
      if (v.length > 1000) assert.ok(v.endsWith(anchor.prefix) && v.startsWith(anchor.suffix), "the prefix keeps its end, the suffix its start");
      const e = cleanEdit({ kind: v, before: v, after: v, label: v, location: { sheetName: v } });
      for (const [k, x] of Object.entries(e)) wellFormed(x, `edit.${k} ${max}`);
    }
  }
  // the review's case
  const p = cleanPageAnchor({ prefix: "😀" + "x".repeat(999) }).prefix;
  assert.ok(p.isWellFormed(), "no lone low surrogate at the start of the prefix");
  assert.equal(p, "x".repeat(999));
});

// Past the session cap even after the writer's cuts (typed edits and quotes of control characters are six bytes each as JSON), a Send is
// refused with the plain 413 before anything is written or changed
test("a Send whose session would not fit its file even after the cuts is refused (413) and changes nothing", { timeout: 300_000 }, () => {
  const S = new Sessions();
  const f = path.join(root, "over.docx");
  fs.writeFileSync(f, docxBytes(["One ordinary paragraph."]));
  const s = S.open(f);
  const ctl = "\u0001".repeat(20_000);
  const comments = Array.from({ length: 500 }, (_, i) => ({ id: `o${i}`, kind: "element", text: "fix", anchor: { location: { blockPath: [0] }, quote: ctl, paraText: ctl, prefix: ctl, suffix: ctl } }));
  S.setDraft(s.key, { comments, note: "" });
  const before = fs.readFileSync(f);
  const seq = s.seq;
  const edits = Array.from({ length: 2000 }, () => ({ kind: "text", before: ctl, after: ctl, label: ctl.slice(0, 1000), location: { blockPath: [0] } })); // about 78 MB once cut
  const changed = [{ ...comments[0], text: "fix, changed" }, ...comments.slice(1)]; // a save before the refusal would show
  assert.throws(() => S.send(s.key, { baseSha: s.baseSha, bytes: docxBytes(["Changed by the page."]), comments: changed, note: "a note", edits }), (err) => err.status === 413 && err.extra?.code === "too_large_request" && /larger than Onionskin takes/.test(err.message));
  assert.ok(fs.readFileSync(f).equals(before), "the file was not written");
  assert.equal(s.seq, seq, "nothing changed, not even the drafts the Send carried (test/refusal-atomic.test.js)");
  assert.equal(s.comments[0].text, "fix");
  assert.equal(s.note, "");
  assert.equal(s.edits.length, 0);
  assert.ok(s.comments.every((c) => c.status === "draft"), "the comments are still drafts");
  assert.equal(s.pending, null);
  S.close(s.key);
});
