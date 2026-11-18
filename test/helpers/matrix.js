// The stress matrix (test/stress-matrix.test.js at small sizes, e2e/stress-matrix.e2e.test.js at the sizes the outside reviews used): a
// table of hostile files and comment sets, each sent through every route that reads the document or its anchors, on the real Sessions
// object the server runs, through the same async methods its routes call. For each request: this thread's CPU (process.threadCpuUsage;
// work in the anchor worker is not counted) under 1 s, the request completes, and every comment is still delivered.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildZip, contentTypes, docxBytes, xlsxBytes } from "./zipbuild.js";
import { xlsxGrid } from "./hostile.js";
import { analyzeOffThread } from "../../src/offload.js";

const S_NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const P_NS = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
const col = (n) => {
  let s = "";
  for (n++; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

function workbook(sheetXml, { styles = null, names = "" } = {}) {
  return buildZip({
    "[Content_Types].xml": contentTypes("xlsx").replace("</Types>", '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'),
    "_rels/.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    "xl/workbook.xml": `<?xml version="1.0"?><workbook ${S_NS}><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>${names ? `<definedNames>${names}</definedNames>` : ""}</workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>${styles ? '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' : ""}</Relationships>`,
    ...(styles ? { "xl/styles.xml": styles } : {}),
    "xl/worksheets/sheet1.xml": `<?xml version="1.0"?><worksheet ${S_NS}><sheetData>${sheetXml}</sheetData></worksheet>`,
  });
}
const deck = (text) =>
  buildZip({
    "[Content_Types].xml": contentTypes("pptx"),
    "ppt/presentation.xml": `<?xml version="1.0"?><p:presentation ${P_NS} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>`,
    "ppt/_rels/presentation.xml.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>',
    "ppt/slides/slide1.xml": `<?xml version="1.0"?><p:sld ${P_NS}><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="Body"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
  });

// comments: n at most 500, cycling over `anchors`
const many = (n, anchors, kind = "text") => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, kind: anchors[i % anchors.length].kind ?? kind, text: `comment ${i}`, anchor: anchors[i % anchors.length].anchor ?? anchors[i % anchors.length] }));
// text anchors on `len` characters of `unit` at a few offsets (Word: a paragraph path; PowerPoint: a shape)
const spans = (unit, len, where, n = 7) => Array.from({ length: n }, (_, k) => {
  const at = Math.floor(((unit.length - len) * k) / n);
  return { location: { ...where, start: at, end: at + len }, quote: unit.slice(at, at + len), prefix: unit.slice(Math.max(0, at - 40), at), suffix: unit.slice(at + len, at + len + 40) };
});
const W = { blockPath: [0] };
const P = { slideIndex: 0, slideId: 256, shapeId: 2, shapeName: "Body" };

/** The table: each row a file and its comments; `scale` 1 is the size an outside review used, smaller ones run in the unit group. */
export function generators(scale) {
  const n = (x) => Math.max(1, Math.round(x * scale));
  const q = "A ".repeat(149) + "A.";
  const rep = q.repeat(n(10_000));
  const giant = "word ".repeat(n(1_580_000));
  const decomposed = "é".repeat(n(3_900_000));
  const cjk = "中文".repeat(n(3_900_000));
  const needles = "ab".repeat(n(3_900_000));
  const sentence = { location: { ...W, start: 0, end: q.length }, quote: q };
  return [
    { name: "repeated text (Word)", format: "docx", bytes: () => docxBytes([rep]), comments: () => many(500, spans(rep, q.length, W)), select: sentence },
    { name: "repeated text (PowerPoint)", format: "pptx", bytes: () => deck(rep), comments: () => many(500, spans(rep, q.length, P)), select: { ...sentence, location: { ...P, start: 0, end: q.length } } },
    { name: "one giant paragraph", format: "docx", bytes: () => docxBytes([giant]), comments: () => many(500, [...spans(giant, 30, W), { kind: "element", anchor: { location: W, quote: giant, paraText: giant, hitKind: "paragraph" } }]), select: { location: { ...W, start: 0, end: 29 }, quote: giant.slice(0, 29) } },
    { name: "one giant shape", format: "pptx", bytes: () => deck(giant), comments: () => many(500, [...spans(giant, 30, P), { kind: "element", anchor: { location: P, quote: giant, hitKind: "shape" } }]) },
    { name: "decomposed letters", format: "docx", bytes: () => docxBytes([decomposed]), comments: () => many(500, spans(decomposed, 4, W)) },
    { name: "CJK text", format: "docx", bytes: () => docxBytes([cjk]), comments: () => many(500, spans(cjk, 3, W)) },
    { name: "repeated short needles", format: "docx", bytes: () => docxBytes([needles]), comments: () => many(500, spans(needles, 2, W, 50)) },
    {
      name: "long number formats",
      format: "xlsx",
      bytes: () => workbook(Array.from({ length: 20 }, (_, r) => `<row r="${r + 1}">${Array.from({ length: 10 }, (_, c) => `<c r="${col(c)}${r + 1}" s="0"><v>1</v></c>`).join("")}</row>`).join(""), { styles: `<?xml version="1.0"?><styleSheet ${S_NS}><numFmts count="1"><numFmt numFmtId="164" formatCode="${"é".repeat(1000)}"/></numFmts><cellXfs count="1"><xf numFmtId="164"/></cellXfs></styleSheet>` }),
      comments: () => many(500, [{ location: { sheetIndex: 0, sheetName: "Sheet1", range: "A1:J20" } }], "element"),
    },
    {
      name: "many defined names",
      format: "xlsx",
      bytes: () => workbook(Array.from({ length: n(2000) }, (_, r) => `<row r="${r + 1}">${Array.from({ length: Math.min(499, n(499)) }, (_, c) => `<c r="${col(c)}${r + 1}" t="inlineStr"><is><t>a</t></is></c>`).join("")}</row>`).join(""), { names: Array.from({ length: n(20_000) }, (_, i) => `<definedName name="N${String(i).padStart(5, "0")}${"x".repeat(244)}">Sheet1!$A$1</definedName>`).join("") }),
      comments: () => many(500, [{ location: { sheetIndex: 0, sheetName: "Sheet1", range: "A1" } }, { location: { sheetIndex: 0, sheetName: "Sheet1", range: `B1:${col(Math.min(200, n(200)))}${n(2000)}` } }], "element"),
    },
    { name: "many merged ranges", format: "xlsx", bytes: () => xlsxGrid(n(200_000), n(49_000)), comments: () => many(500, Array.from({ length: 20 }, (_, i) => ({ location: { sheetIndex: 0, sheetName: "S1", range: `A${i * 50 + 1}:B${i * 50 + 40}` } })), "element") },
    {
      name: "overlapping large ranges, long cells",
      format: "xlsx",
      bytes: () => {
        const cells = {};
        for (let r = 1; r <= n(1000); r++) for (let c = 0; c < 40; c++) cells[`${col(c)}${r}`] = `${col(c)}${r} ${"long label text ".repeat(4)}`;
        return xlsxBytes({ Sheet1: cells });
      },
      comments: () => many(500, Array.from({ length: 20 }, (_, i) => ({ location: { sheetIndex: 0, sheetName: "Sheet1", range: `${col(i)}1:${col(i + 19)}${n(1000)}` } })), "element"),
    },
  ];
}

const cpuMs = () => {
  const u = process.threadCpuUsage();
  return (u.user + u.system) / 1000;
};

/**
 * Every route on one row of the table, on a file of its own in `dir`. `S` is a Sessions; `SG` src/suggest.js. Returns
 * [{route, ms}] (this thread's CPU per request) after asserting each request completed under 1 s and lost no comment.
 */
export async function runRow(S, SG, dir, row, { maxMs = 1000 } = {}) {
  const out = [];
  const f = path.join(dir, `${row.name.replace(/\W+/g, "-")}.${row.format}`);
  fs.writeFileSync(f, row.bytes());
  const timed = async (route, fn) => {
    const t = cpuMs();
    const r = await fn();
    const ms = cpuMs() - t;
    out.push({ route, ms: Math.round(ms) });
    assert.ok(ms < maxMs, `${row.name}, ${route}: ${ms.toFixed(0)} ms of this thread's CPU`);
    return r;
  };
  const ids = (list) => list.map((c) => c.id).sort().join(",");

  // a quick fix's selection and Use, on a copy of its own (a Use that writes starts a run on this Mac)
  if (row.select) {
    const g = f.replace(/(\.\w+)$/, "-use$1");
    fs.copyFileSync(f, g);
    const u = await S.openAsync(g);
    const rewriter = () => ({ rewrite: async (task, text) => ({ ok: true, text: `An${text.slice(1)}` }) });
    const shown = await timed("suggest", () => SG.suggest(S, u.key, { task: "grammar", anchor: row.select }, { rewriter }));
    assert.ok(shown && typeof shown.state === "string", `${row.name}, suggest: answered`);
    if (shown.state === "shown") {
      const words = (await import("../../src/stamp-words.js")).STAMP_WORDS.grammar;
      const comments = [{ id: "u1", kind: "text", text: words, anchor: shown.anchor }];
      await timed("suggest/use", async () => {
        try {
          await SG.useSuggestion(S, u.key, { id: shown.id, commentId: "u1", comments, baseSha: u.baseSha });
        } catch (err) {
          assert.ok(["not_here", "not_eligible", "protected"].includes(err?.extra?.code), `${row.name}, suggest/use: ${err?.message}`);
        }
      });
      assert.ok(u.comments.some((c) => c.id === "u1"), `${row.name}, suggest/use: the comment is kept`);
    }
    S.close(u.key);
  }

  const s = await S.openAsync(f);
  const comments = row.comments().slice(0, 498); // two more are queued during the run: a session holds 500
  await timed("draft", () => S.setDraft(s.key, { comments, note: "a note" }));
  assert.equal(s.comments.length, comments.length, `${row.name}, draft: every comment kept`);
  await timed("send", () => S.sendAsync(s.key, { baseSha: s.baseSha, comments, note: "a note" }));
  assert.equal(ids(s.pending.instructions.comments), ids(comments), `${row.name}, send: every comment in the batch`);
  await timed("resolve", () => S.resolveAllAsync(s.key));

  // an agent takes the batch; two more comments are queued while it works; it finishes; the queued batch is anchored on its file
  const got = await S.poll(s.key, { holder: "agent-matrix" }).promise;
  assert.equal(got.batch_id, s.delivered.batch.batch_id);
  const extra = comments.slice(0, 2).map((c, i) => ({ ...c, id: `q${i}` }));
  await timed("send (queued during a run)", () => S.sendAsync(s.key, { baseSha: s.baseSha, comments: [...s.comments.map(({ id, kind, text, anchor, pin }) => ({ id, kind, text, anchor, pin })), ...extra], note: "" }));
  assert.equal(s.comments.filter((c) => c.status === "queued").length, 2, `${row.name}: the two comments are queued`);
  const results = { summary: "done", results: comments.map((c) => ({ comment_id: c.id, status: "done", note: "ok" })) };
  // as the server's finishRun does it: the checks in their worker, then done with the anchors in the anchor worker
  const claim = { holder: "agent-matrix", token: got.lease.token };
  await timed("done", async () => {
    const inputs = S.analysisInputs(s.key, claim);
    const analysis = inputs ? await analyzeOffThread(inputs) : null;
    return S.doneAsync(s.key, results, claim, analysis, { inline: false });
  });
  assert.equal(ids(s.pending?.instructions.comments ?? []), "q0,q1", `${row.name}, done: the queued comments are the next batch`);
  const entry = s.activity.find((a) => a.kind === "agent");
  await timed("revert", () => S.revertAsync(s.key, entry.id));
  assert.equal(ids(s.pending?.instructions.comments ?? []), "q0,q1", `${row.name}, revert: the waiting batch keeps its comments`);
  S.close(s.key);
  return out;
}

// ---- HTML rows (PLAN-html 4: the stall matrix extended to html) -----------------------------------------------------------------------
// HTML files have no open path yet (Phase 2a), so these rows drive the anchor worker the routes use (src/offload.js anchorsOffThread)
// directly with a page's bytes, as a Send (build every comment's anchor, with the outline an agent gets) and the page's resolve after it
// do. The page anchors name located nodes by id, the way the page will (src/html.js `nodes`): each page is built so its ids are known
// (doctype 0, html 1, head 2, title 3, its text 4, body 5, then the body's nodes in order). A row's first anchor must land on a `p`, so
// an id this gets wrong fails the row instead of passing it vacuously.
const htmlPage = (body) => Buffer.from(`<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`);
const htmlSpans = (unit, len, nodeId, n = 7) => Array.from({ length: n }, (_, k) => {
  const at = Math.floor(((unit.length - len) * k) / n);
  return { location: { nodeId, start: at, end: at + len }, quote: unit.slice(at, at + len), prefix: unit.slice(Math.max(0, at - 40), at), suffix: unit.slice(at + len, at + len + 40) };
});
/** The html rows at the sizes the plan names: one giant text node, 200,000 elements, repeated text, 100,000 unique ids. */
export function htmlRows() {
  const giant = "word ".repeat(1_580_000).trim();
  const q = "A ".repeat(149) + "A.";
  const rep = Array.from({ length: 10_000 }, () => q).join(" ");
  const P = 66_000; // <p>wN <b>b</b><i>i</i></p>: 3 elements and 6 located nodes each; with html, head, title and body, 198,004 elements
  return [
    { name: "one giant text node (HTML)", bytes: () => htmlPage(`<p>${giant}</p>`), anchors: () => [...htmlSpans(giant, 30, 6, 499), { location: { nodeId: 6 }, quote: giant, hitKind: "element" }] },
    { name: "200,000 elements (HTML)", bytes: () => htmlPage(Array.from({ length: P }, (_, k) => `<p>w${k} <b>b</b><i>i</i></p>`).join("")), anchors: () => Array.from({ length: 500 }, (_, k) => ({ location: { nodeId: 6 + 6 * Math.floor((k * (P - 1)) / 499) }, quote: "" })) },
    { name: "repeated text (HTML)", bytes: () => htmlPage(`<p>${rep}</p>`), anchors: () => htmlSpans(rep, q.length, 6, 500) },
    { name: "100,000 unique ids (HTML)", bytes: () => htmlPage(Array.from({ length: 100_000 }, (_, k) => `<p id="i${k}">text ${k}</p>`).join("")), anchors: () => Array.from({ length: 500 }, (_, k) => ({ location: { nodeId: 6 + 2 * k * 199 }, quote: "text" })) },
  ];
}

/**
 * One HTML row through the anchor worker: a Send (every anchor built, the outline made) and the page's resolve of what it built, each
 * under `maxMs` of this thread's CPU, each anchor built (weak is allowed, lost is not), and the first one on a `p`. Returns [{route, ms}].
 */
export async function runHtmlRow(anchorsOffThread, row, { maxMs = 1000 } = {}) {
  const out = [];
  const bytes = row.bytes();
  const anchors = row.anchors();
  const timed = async (route, fn) => {
    const keep = setInterval(() => {}, 1000); // the anchor workers do not keep the process alive (src/offload.js unref): this test does
    const t = cpuMs();
    try {
      const r = await fn();
      const ms = cpuMs() - t;
      out.push({ route, ms: Math.round(ms) });
      assert.ok(ms < maxMs, `${row.name}, ${route}: ${ms.toFixed(0)} ms of this thread's CPU`);
      return r;
    } finally {
      clearInterval(keep);
    }
  };
  const send = await timed("send", () => anchorsOffThread({ format: "html", source: { bytes }, check: true, outline: true, tasks: anchors.map((anchor) => ({ op: "build", anchor })) }));
  assert.ok(send.ok, `${row.name}, send: ${send.failed} ${send.why}`);
  assert.deepEqual(send.r.read, { ok: true }, `${row.name}, send: the page was read`);
  const built = send.r.results;
  assert.equal(built.filter((d) => d && d.format === "html").length, anchors.length, `${row.name}, send: every anchor built`);
  assert.equal(built[0].tag, "p", `${row.name}: the first anchor is on a paragraph`);
  assert.ok(send.r.outline?.outline.length > 0, `${row.name}, send: the outline`);
  const comments = built.map((durable, i) => ({ id: `c${i}`, durable }));
  const res = await timed("resolve", () => anchorsOffThread({ format: "html", source: { bytes, sha: send.sha }, tasks: [{ op: "resolveAll", comments, view: null }] }));
  assert.ok(res.ok, `${row.name}, resolve: ${res.failed} ${res.why}`);
  const found = Object.values(res.r.results[0].anchors);
  assert.equal(found.length, anchors.length, `${row.name}, resolve: every comment answered`);
  console.log(JSON.stringify({ row: row.name, cpuMs: out, resolved: found.filter((r) => r.method !== "none").length }));
  return out;
}
