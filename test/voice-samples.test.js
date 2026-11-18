import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { buildZip, contentTypes, docxBytes, tmpdir, xlsxBytes } from "./helpers/zipbuild.js";
import { readDocxParagraphs } from "../src/docx.js";
import { parseDeck } from "../src/pptx.js";
import * as V from "../src/voice-samples.js";
import { SampleError, sampleSources } from "../src/voice-sample-worker.js";
import { startWorker } from "../src/offload.js";

// Samples of the person's writing: a fixed, deterministic cut of a long document, agent text left out, and the printed-batch budget.
const root = tmpdir("voice-samples-");
after(() => fs.rmSync(root, { recursive: true, force: true }));
const BIG = 1_000_000; // a share that takes everything

const xml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const p = (text, { style, list, inner } = {}) =>
  `<w:p>${style || list ? `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ""}${list ? '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>' : ""}</w:pPr>` : ""}${inner ?? `<w:r><w:t xml:space="preserve">${xml(text)}</w:t></w:r>`}</w:p>`;
const body = (i) => `Body paragraph number ${i} says something in my own plain words.`;

/** 600 paragraphs: a heading every 50, a list every 100 (3 items), a protected page-break paragraph and a table, short lines, a repeat. */
function bigDoc() {
  const parts = [];
  for (let i = 0; i < 600; i++) {
    if (i % 50 === 0) parts.push(p(`Heading ${i / 50}`, { style: "Heading1" }));
    else if (i % 100 === 30) for (let k = 0; k < 3; k++) parts.push(p(`List item ${i}.${k}`, { list: true }));
    else if (i === 210) parts.push(p("", { inner: '<w:r><w:t>Protected words before</w:t></w:r><w:r><w:br w:type="page"/></w:r><w:r><w:t>and after a page break here</w:t></w:r>' }));
    else if (i === 310) parts.push(`<w:tbl><w:tr><w:tc>${p("Table cell words that are long enough to count")}</w:tc></w:tr></w:tbl>`);
    else if (i === 410) parts.push(p("Too short."));
    else if (i === 411) parts.push(p(body(1)));
    else parts.push(p(body(i)));
  }
  return docxBytes(null, {}, parts.join(""));
}

test("spreadOrder covers every index once, first, last and middle first; evenPick is evenly spaced", () => {
  assert.deepEqual(V.spreadOrder(5), [0, 4, 2, 1, 3]);
  for (const n of [0, 1, 2, 7, 100]) assert.deepEqual([...V.spreadOrder(n)].sort((a, b) => a - b), Array.from({ length: n }, (_, i) => i));
  assert.deepEqual(V.evenPick([0, 1, 2, 3, 4, 5, 6, 7, 8], 3), [0, 4, 8]);
  assert.deepEqual(V.evenPick([1, 2], 5), [1, 2]);
  assert.ok(V.wordCount("\u6211\u559c\u6b22\u77ed\u53e5\u5b50") > 1, "a CJK sentence is more than one word");
  assert.equal(V.wordCount("Too short."), 2);
});

test("a 600-paragraph Word file: openers, closers, headings, list items, an even spread, the same every time; protected, table, short and repeated paragraphs skipped", () => {
  const bytes = bigDoc();
  const paras = readDocxParagraphs(bytes, { detail: true });
  assert.ok(paras.length > 600);
  const share = 8000;
  const s = V.sampleDocx(paras, share);
  assert.deepEqual(V.sampleDocx(readDocxParagraphs(bytes, { detail: true }), share), s, "deterministic");
  const cost = s.paragraphs.reduce((n, x) => n + JSON.stringify(x.t).length + 80, 0);
  assert.ok(cost <= share, `${cost} within the share`);
  assert.deepEqual(s.paragraphs.filter((x) => x.k === "open").map((x) => x.t), [body(1), body(2), body(3)]);
  assert.deepEqual(s.paragraphs.filter((x) => x.k === "close").map((x) => x.t), [body(598), body(599)]);
  const heads = s.paragraphs.filter((x) => x.k === "h").map((x) => x.t);
  assert.equal(heads.length, 8);
  assert.deepEqual([heads[0], heads.at(-1)], ["Heading 0", "Heading 11"], "headings spread over the whole file");
  const items = s.paragraphs.filter((x) => x.k === "li");
  assert.equal(items.length, 6);
  const bodies = s.paragraphs.filter((x) => x.k === "p").map((x) => Number(/number (\d+)/.exec(x.t)[1]));
  assert.ok(bodies.length >= 20, `${bodies.length} body paragraphs`);
  assert.ok(Math.min(...bodies) < 100 && Math.max(...bodies) > 500, "body paragraphs come from the whole file");
  assert.ok(bodies.every((n, i) => i === 0 || n > bodies[i - 1]), "document order");
  assert.equal(s.sampled, s.paragraphs.length);
  assert.deepEqual(Object.keys(s).sort(), ["paragraphs", "sampled", "total"], "no file name, no path");
  // with room for everything: 578 body paragraphs (600 places minus 12 headings, 6 lists, the protected, table, short and repeated
  // ones), 8 of the 12 headings and 6 of the 18 list items; so what is skipped is skipped by the rule, not by the share
  const all = V.sampleDocx(paras, BIG);
  assert.equal(all.total, 578 + 12 + 18);
  assert.equal(all.sampled, 578 + 8 + 6);
  const allTexts = all.paragraphs.map((x) => x.t);
  assert.ok(paras.some((x) => x.protected && x.text.includes("Protected words")), "the fixture has a protected paragraph");
  assert.ok(paras.some((x) => x.path?.length > 1 && x.text.startsWith("Table cell")), "and a table paragraph");
  for (const gone of ["Protected words", "Table cell", "Too short."]) assert.ok(!allTexts.some((t) => t.includes(gone)), gone);
  assert.equal(allTexts.filter((t) => t === body(1)).length, 1, "a repeat is taken once");
  assert.ok(allTexts.includes(body(409)) && allTexts.includes(body(412)), "its neighbors are kept");
  assert.equal(V.sampleDocx(paras, 10).sampled, 0, "nothing when nothing fits");
  assert.equal(V.sampleDocx(paras, 10).sampled, 0);
});

test("a sampled paragraph is cleaned and capped: no control or bidi characters, at most 1,200 characters", () => {
  const long = "word ".repeat(400);
  const s = V.sampleDocx(readDocxParagraphs(docxBytes([`Plain start ‮hidden‬ words and more`, long]), { detail: true }), BIG);
  assert.equal(s.paragraphs[0].t, "Plain start hidden words and more");
  assert.equal([...s.paragraphs[1].t].length, 1200);
});

test("agent text in the open file: an added paragraph and a light edit of it are left out; a heavy rewrite by the person is kept", () => {
  const before = ["My opening line stays the same as I wrote it.", "Second paragraph of mine, untouched by anyone."];
  const added = "The agent added this paragraph about quarterly results and next steps.";
  const after = [...before, added, "Another agent sentence that summarizes the key takeaways clearly."];
  const set = V.agentTexts([{ before, after }]);
  assert.equal(set.texts.length, 2);
  const now = [
    ...before,
    "The agent added this paragraph about quarterly results and the next steps.", // the person's light edit: still agent text
    "Numbers went up; we hire in June, I think, and that is that.", // the person's own rewrite
  ];
  assert.ok(V.isAgentText(added, set));
  assert.ok(V.isAgentText(now[2], set));
  assert.ok(!V.isAgentText(now[3], set));
  const s = V.sampleDocx(readDocxParagraphs(docxBytes(now), { detail: true }), BIG, { exclude: set });
  assert.deepEqual(s.paragraphs.map((x) => x.t), [before[0], before[1], now[3]]);
  // the similarity cap keeps the newest 500; every hash is kept
  const many = V.agentTexts([{ before: [], after: Array.from({ length: 700 }, (_, i) => `Agent paragraph ${i} with enough words.`) }]);
  assert.equal(many.texts.length, 500);
  assert.equal(many.hashes.size, 700);
  assert.ok(V.isAgentText("Agent paragraph 3 with enough words.", many), "an old one still matches by hash");
});

test("the worker: agent pairs from stored versions are left out; a pruned version means no exclusion", () => {
  const before = ["My opening line stays the same as I wrote it.", "Second paragraph of mine, untouched by anyone."];
  const added = "The agent added this paragraph about quarterly results and next steps.";
  const pre = path.join(root, "pre.bin");
  const post = path.join(root, "post.bin");
  fs.writeFileSync(pre, docxBytes(before));
  fs.writeFileSync(post, docxBytes([...before, added]));
  const open = { format: "docx", bytes: docxBytes([...before, added]) };
  const withPair = sampleSources({ open: { ...open, agentPairs: [{ before: pre, after: post }] }, shares: BIG });
  assert.deepEqual(withPair.sources[0].paragraphs.map((x) => x.t), before);
  const pruned = sampleSources({ open: { ...open, agentPairs: [{ before: path.join(root, "gone.bin"), after: post }] }, shares: BIG });
  assert.deepEqual(pruned.sources[0].paragraphs.map((x) => x.t), [...before, added]);
});

const pptx = (slides) => {
  const sp = (id, name, text, ph) => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr>${ph ? `<p:ph type="${ph}"/>` : ""}</p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${xml(text)}</a:t></a:r></a:p></p:txBody></p:sp>`;
  const files = {
    "[Content_Types].xml": contentTypes("pptx"),
    "ppt/presentation.xml": `<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join("")}</p:sldIdLst></p:presentation>`,
    "ppt/_rels/presentation.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${slides.map((_, i) => `<Relationship Id="rId${i + 1}" Type="x/slide" Target="slides/slide${i + 1}.xml"/>`).join("")}</Relationships>`,
  };
  slides.forEach((s, i) => {
    files[`ppt/slides/slide${i + 1}.xml`] = `<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>${sp(2, "Title 1", s.title, "title")}${sp(3, "Content 2", s.text)}${sp(4, "Slide Number 3", String(i + 1), "sldNum")}</p:spTree></p:cSld></p:sld>`;
  });
  return buildZip(files);
};

test("PowerPoint: evenly spaced slides, title and shape text, each at most 600 characters; slide numbers skipped; deterministic", () => {
  const slides = Array.from({ length: 40 }, (_, i) => ({ title: `Slide title ${i}`, text: i === 7 ? "long ".repeat(200) : `What I say on slide ${i}, in my words.` }));
  const bytes = pptx(slides);
  const all = V.samplePptx(parseDeck(bytes), BIG);
  assert.equal(all.total, 80);
  assert.equal(all.paragraphs[0].k, "h");
  assert.equal([...all.paragraphs.find((x) => x.t.startsWith("long")).t].length, 600);
  assert.ok(!all.paragraphs.some((x) => /^\d+$/.test(x.t)), "no slide numbers");
  const some = V.samplePptx(parseDeck(bytes), 1500);
  assert.deepEqual(V.samplePptx(parseDeck(bytes), 1500), some);
  const shown = [...new Set(some.paragraphs.filter((x) => x.k === "h").map((x) => Number(/\d+/.exec(x.t)[0])))];
  assert.ok(shown.includes(0) && shown.includes(39), `first and last slide: ${shown}`);
  assert.ok(shown.length < 40);
  assert.ok(shown.every((n, i) => i === 0 || n > shown[i - 1]), "document order");
});

test("pasted text: split on blank lines; a # line is a heading, marker lines are list items; short and repeated paragraphs skipped", () => {
  const text = "# My weekly note\n\nHi all,\n\nThis week we shipped the new form. It took longer than planned.\nThat is fine.\n\n- first point here\n- second point\n\nThis week we shipped the new form. It took longer than planned.\nThat is fine.\r\n\r\nThanks, and see you Monday morning.";
  const s = V.sampleText(text, BIG);
  assert.deepEqual(s.paragraphs, [
    { k: "h", t: "My weekly note" },
    { k: "open", t: "This week we shipped the new form. It took longer than planned. That is fine." },
    { k: "li", t: "first point here" },
    { k: "li", t: "second point" },
    { k: "open", t: "Thanks, and see you Monday morning." },
  ]);
});

test("rewrites and comments: the newest within their shares, oldest first, cleaned and capped", () => {
  const examples = Array.from({ length: 30 }, (_, i) => ({ id: "x", at: i, agent: `The AI wrote "${i}" é`, mine: `I wrote ${i}` }));
  const r = V.pickRewrites(examples);
  assert.equal(r.length, 20);
  assert.deepEqual(r[0], { ai: 'The AI wrote "10" é', mine: "I wrote 10" });
  assert.equal(r.at(-1).mine, "I wrote 29");
  assert.ok(V.pickRewrites(examples, 300).length < 5);
  const asks = [...Array.from({ length: 40 }, (_, i) => `Make number ${i} shorter`), "x".repeat(500), "Make number 39 shorter"];
  assert.ok(V.pickRequests(asks).reduce((n, t) => n + JSON.stringify(t).length + 80, 0) <= V.REQUESTS_SHARE);
  const q = V.pickRequests(asks, BIG);
  assert.equal(q.length, 30);
  assert.equal([...q.at(-2)].length, 300);
  assert.equal(q.at(-1), "Make number 39 shorter", "a repeat keeps its newest place");
  assert.equal(q.filter((t) => t === "Make number 39 shorter").length, 1);
});

test("budget: the worst case (600 paragraphs, 5 more files, 30 rewrites, 30 comments, a 7,000-character guide) prints at or under 28,000 characters", () => {
  const nasty = (i) => `Body "${i}" says café 我喜欢 and \\ more of my own plain words here.`;
  const doc = docxBytes(Array.from({ length: 600 }, (_, i) => nasty(i)));
  const files = Array.from({ length: 5 }, () => ({ format: "docx", bytes: doc }));
  const guide = "## In short\n" + "I keep it short. ".repeat(410).slice(0, 6980);
  const shell = (ev) => ({ batch_id: "b_0123456789ab", instructions: { voice_request: { ask: "Draft my voice guide.", template: "x".repeat(1400), current_guide: guide } }, untrusted_document_evidence: { file_name: "", anchors: [], user_edits: [], voice_evidence: ev } });
  const measure = (ev) => JSON.stringify(shell(ev), null, 2).length;
  const fixed = measure({ sources: [], rewrites: [], my_requests: [] });
  const sh = V.voiceShares({ fixed, sources: 6, rewrites: true, requests: true });
  assert.equal(sh.source, 2000, "the floor");
  const { sources } = sampleSources({ open: { format: "docx", bytes: doc, agentPairs: [] }, files, shares: sh.source });
  const examples = Array.from({ length: 30 }, (_, i) => ({ agent: `The AI wrote "this" ${i} é`.padEnd(390, "a"), mine: `I wrote ${i}`.padEnd(390, "b") }));
  const ev = { sources, rewrites: V.pickRewrites(examples, sh.rewrites), my_requests: V.pickRequests(Array.from({ length: 30 }, (_, i) => `Shorter, please ${i}`), sh.requests) };
  const at28 = V.budget(ev, measure);
  assert.ok(at28 && measure(at28) <= V.VOICE_BATCH_MAX_CHARS, String(at28 && measure(at28)));
  // a tighter limit makes the trim do real work
  const max = 20_000;
  assert.ok(measure(ev) > max);
  const fit = V.budget(ev, measure, max);
  assert.ok(fit);
  assert.ok(measure(fit) <= max, String(measure(fit)));
  assert.ok(measure(fit) > max - 2000, "it stops soon after it fits");
  assert.deepEqual(V.budget(ev, measure, max), fit, "deterministic");
  assert.ok(fit.sources.every((s) => s.paragraphs.some((x) => x.k === "open")), "body paragraphs go before openers");
  assert.ok(measure(ev) > measure(fit) && ev.sources[0].paragraphs.length > fit.sources[0].paragraphs.length, "the input is not changed");
  assert.ok(fit.sources.every((s) => s.sampled === s.paragraphs.length));
  assert.equal(fit.rewrites.length, ev.rewrites.length, "rewrites go only after every source paragraph");
  // an evidence that cannot fit at all is refused, never sent over the budget
  assert.equal(V.budget(ev, (e) => measure(e) + 30_000), null);
  // the limit can be set from the environment
  process.env.ONIONSKIN_VOICE_BATCH_MAX_CHARS = "20000";
  try {
    assert.equal(V.voiceBatchMax(), 20000);
    assert.ok(measure(V.budget(ev, measure)) <= 20000);
    assert.equal(V.voiceShares({ fixed: 10_000, sources: 2 }).source, 5000);
  } finally {
    delete process.env.ONIONSKIN_VOICE_BATCH_MAX_CHARS;
  }
});

test("the worker refuses a macro-enabled package, an Excel file, a broken file and text that is not UTF-8, naming the source", () => {
  const docm = buildZip({ "[Content_Types].xml": contentTypes("docx", "application/vnd.ms-word.document.macroEnabled.main+xml"), "word/document.xml": "<w:document/>" });
  const vba = docxBytes(["My words here are fine."], { "word/vbaProject.bin": "x" });
  const cases = [
    [{ files: [{ format: "docx", bytes: docxBytes(["Fine words of mine here."]) }, { format: "docx", bytes: docm }] }, 1, "macro"],
    [{ files: [{ format: "docx", bytes: vba }] }, 0, "macro"],
    [{ files: [{ format: "xlsx", bytes: xlsxBytes({ S: { A1: "x" } }) }] }, 0, "format"],
    [{ files: [{ format: "docx", bytes: Buffer.from("not a zip") }] }, 0, "unreadable"],
    [{ files: [{ format: "pptx", bytes: docxBytes(["Not a deck."]) }] }, 0, "unreadable"],
    [{ files: [{ format: "text", bytes: Buffer.from([0xff, 0xfe, 0x41]) }] }, 0, "unreadable"],
    [{ open: { format: "xlsx", bytes: xlsxBytes({ S: { A1: "x" } }), agentPairs: [] } }, 0, "format"],
    [{ texts: [5] }, 0, "format"],
  ];
  for (const [input, index, code] of cases) assert.throws(() => sampleSources({ shares: BIG, ...input }), (e) => e instanceof SampleError && e.index === index && e.code === code, `${index} ${code}`);
  const ok = sampleSources({ files: [{ format: "text", bytes: Buffer.from("I keep it short and plain, always.") }], texts: ["Pasted words of mine, four or more."], shares: BIG });
  assert.deepEqual(ok.sources.map((s) => [s.format, s.sampled]), [["text", 1], ["text", 1]]);
});

test("the worker runs as a thread: one message, samples or a refusal", async () => {
  const run = (workerData) =>
    new Promise((resolve, reject) => {
      const w = startWorker("voice-sample-worker.js", { workerData });
      w.once("message", (m) => (w.terminate(), resolve(m)));
      w.once("error", reject);
    });
  const good = await run({ files: [{ format: "docx", bytes: docxBytes(["My own words in a file, plainly said."]) }], texts: [], shares: BIG });
  assert.deepEqual(good, { ok: true, sources: [{ format: "docx", total: 1, sampled: 1, paragraphs: [{ k: "open", t: "My own words in a file, plainly said." }] }] });
  assert.deepEqual(await run({ files: [{ format: "docx", bytes: Buffer.from("nope") }], shares: BIG }), { ok: false, index: 0, code: "unreadable" });
});
