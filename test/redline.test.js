import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { AUTHORS, buildTracked, wordDate } from "../src/redline.js";
import { acceptOurs, rejectOurs, verifyTracked } from "../src/redline-check.js";
import { parse, serialize } from "../src/xml-tree.js";
import { walkXml } from "../src/xml.js";
import { parseDocxParagraphs } from "../src/docx.js";
import { openZip } from "../src/zip.js";
import { replaceEntry } from "../src/zip-write.js";
import { bodyDoc, docxBytes, tmpdir } from "./helpers/zipbuild.js";

// The tracked-changes copy builder (src/redline.js). Each built copy is run through the checker; the shapes are compared with the files
// Microsoft Word itself wrote (test/fixtures/word-tracked) for the same edits of the spike's base document.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORD = path.join(root, "test/fixtures/word-tracked");
const CORPUS = process.env.ONIONSKIN_TEST_CORPUS || path.join(root, "test/fixtures/cache");
const AUTHOR = AUTHORS.agent;
const DATE = "2026-11-11T01:05:00Z";

let gen;
before(() => {
  gen = tmpdir("redline-");
  const r = spawnSync(process.execPath, [path.join(root, "scripts/tracked-spike/make-fixtures.mjs"), gen], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});
after(() => fs.rmSync(gen, { recursive: true, force: true }));

const docOf = (bytes) => openZip(bytes).readText("word/document.xml");
const build = (before, after, author = AUTHOR) => buildTracked({ before, after, author, date: DATE });
/** Build, check with the checker, and return the result; the check must pass. */
function roundTrip(before, after) {
  const r = build(before, after);
  assert.ok(!r.refused, `refused: ${r.refused}`);
  assert.deepEqual(verifyTracked({ before, after, out: r.bytes, counts: r.counts, author: AUTHOR, date: DATE }), { ok: true });
  return r;
}
/** Per paragraph with a revision: the mark ("ins", "del" or "") and the revised texts, in a stable order (Word writes w:ins first). */
function shape(xml) {
  const out = [];
  for (const p of xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) || []) {
    const mark = /<w:pPr>[\s\S]*?<w:rPr><w:(ins|del)\b[^>]*\/>/.exec(p)?.[1] || "";
    const revs = [...p.matchAll(/<w:(ins|del)\b[^>]*>([\s\S]*?)<\/w:\1>/g)].map((m) => `${m[1]}:${[...m[2].matchAll(/<w:(?:t|delText)\b[^>]*>([^<]*)</g)].map((x) => x[1]).join("")}`).sort();
    if (mark || revs.length) out.push({ mark, revs });
  }
  return out;
}
const P = (text, { style, b, id, extra = "" } = {}) => `<w:p${id ? ` w14:paraId="${id}"` : ""}>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}${extra}<w:r>${b ? "<w:rPr><w:b/></w:rPr>" : ""}<w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const SECT = '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>';
const docx = (paras, extra) => docxBytes([], extra, paras.join("") + SECT);

test("xml-tree: serialize(parse(x)) gives every byte back; DTDs are refused", () => {
  for (const f of fs.readdirSync(WORD)) {
    const x = docOf(fs.readFileSync(path.join(WORD, f)));
    assert.equal(serialize(parse(x)), x, f);
  }
  assert.throws(() => parse('<!DOCTYPE x [<!ENTITY a "b">]><x/>'), /DTD/);
  assert.throws(() => parse("<a><b></a></b>"), /mismatched/);
});

test("wordDate is the local wall-clock time with a Z and 00 seconds, the way Word writes it", () => {
  const ms = Date.UTC(2026, 10, 11, 9, 5, 37);
  const d = new Date(ms);
  const two = (n) => String(n).padStart(2, "0");
  assert.equal(wordDate(ms), `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}:00Z`);
});

describe("the five shipped cases, against Word's own files", () => {
  const cases = { "replace-word": "replace-word", "replace-bold": "replace-bold", "cell-edit": "cell-edit", "delete-mid": "delete-mid", "insert-mid": "insert-mid-own" };
  for (const [c, ref] of Object.entries(cases)) {
    test(`${c}: passes the round trip and has the shape Word wrote`, () => {
      const r = roundTrip(fs.readFileSync(path.join(gen, "base.docx")), fs.readFileSync(path.join(gen, `after-${c}.docx`)));
      const xml = docOf(r.bytes);
      assert.deepEqual(shape(xml), shape(docOf(fs.readFileSync(path.join(WORD, `${ref}.docx`)))));
      // every revision: ours, ids from 2 up (the base's bookmark is w:id 1), id, author, date in that order, no rsid on what we wrote
      const revs = [...xml.matchAll(/<w:(ins|del) ([^>]*?)\/?>/g)].map((m) => m[2]);
      revs.forEach((a, k) => assert.equal(a, `w:id="${k + 2}" w:author="${AUTHOR}" w:date="${DATE}"`));
      assert.ok(!/<w:(ins|del)[^>]*>(<w:r [^>]*rsid)/.test(xml), "no rsid on runs we wrote");
    });
  }
  test("replace-bold: the deleted word keeps BEFORE's bold, the inserted one AFTER's", () => {
    const xml = docOf(build(fs.readFileSync(path.join(gen, "base.docx")), fs.readFileSync(path.join(gen, "after-replace-bold.docx"))).bytes);
    assert.match(xml, /<w:del [^>]*><w:r><w:rPr><w:b\/><\/w:rPr><w:delText>own<\/w:delText><\/w:r><\/w:del><w:ins [^>]*><w:r><w:rPr><w:b\/><\/w:rPr><w:t>assigned<\/w:t>/);
  });
  test("insert-end is refused: a paragraph added at the very end (failed in Word)", () => {
    const r = build(fs.readFileSync(path.join(gen, "base.docx")), fs.readFileSync(path.join(gen, "after-insert-end.docx")));
    assert.deepEqual(r, { refused: ["at_end"] });
  });
});

describe("paragraphs added, removed and moved", () => {
  const base = ["Alpha paragraph has some words in it.", "Bravo paragraph has some other words.", "Charlie paragraph is the third one here.", "Delta paragraph comes fourth in line.", "Echo paragraph is the last one."];
  test("a word swap mid-paragraph: one deletion, one insertion, author and date", () => {
    const r = roundTrip(docx(base.map((t) => P(t))), docx(base.map((t, i) => P(i === 1 ? t.replace("other", "fresh") : t))));
    assert.deepEqual(r.counts, { ins: 1, del: 1, paras_added: 0, paras_removed: 0, moved: 0, formatting: 0 });
  });
  test("a paragraph added mid-body, one removed mid-body, an empty one added", () => {
    let r = roundTrip(docx(base.map((t) => P(t))), docx([...base.slice(0, 2), "A brand new paragraph in the middle.", ...base.slice(2)].map((t) => P(t))));
    assert.equal(r.counts.paras_added, 1);
    r = roundTrip(docx(base.map((t) => P(t))), docx(base.filter((_, i) => i !== 2).map((t) => P(t))));
    assert.equal(r.counts.paras_removed, 1);
    r = roundTrip(docx(base.map((t) => P(t))), docx([P(base[0]), "<w:p/>", ...base.slice(1).map((t) => P(t))]));
    assert.equal(r.counts.paras_added, 1);
  });
  test("a paragraph emptied to <w:p/> (paired by its paraId) keeps well-formed markup", () => {
    const b = docx([P(base[0], { id: "11111111" }), P(base[1], { id: "22222222" }), P(base[2], { id: "33333333" })]);
    const a = docx([P(base[0], { id: "11111111" }), '<w:p w14:paraId="22222222"/>', P(base[2], { id: "33333333" })]);
    assert.equal(roundTrip(b, a).counts.del, 1);
  });
  test("a moved paragraph is removed at the old place and added at the new one", () => {
    const r = roundTrip(docx(base.map((t) => P(t))), docx([base[2], base[0], base[1], base[3], base[4]].map((t) => P(t))));
    assert.equal(r.counts.moved, 1);
    assert.equal(r.counts.paras_added, 1);
    assert.equal(r.counts.paras_removed, 1);
  });
  test("formatting-only changes stay unmarked and are counted (Reject All keeps them)", () => {
    const r = roundTrip(docx(base.map((t) => P(t))), docx(base.map((t, i) => (i === 1 ? P(t.replace("other", "fresh")) : P(t, { b: i === 3 })))));
    assert.equal(r.counts.formatting, 1);
  });
  test("removed text that held a character style missing in AFTER falls back to its neighbor's formatting, and that is counted", () => {
    const run = (t, rPr = "") => `<w:r>${rPr}<w:t xml:space="preserve">${t}</w:t></w:r>`;
    const b = docx([P(base[0]), `<w:p>${run("Keep this ")}${run("styled", '<w:rPr><w:rStyle w:val="Missing"/></w:rPr>')}${run(" text here.")}</w:p>`, P(base[2])]);
    const a = docx([P(base[0]), `<w:p>${run("Keep this ")}${run("plain")}${run(" text here.")}</w:p>`, P(base[2])]);
    const r = roundTrip(b, a);
    assert.equal(r.counts.formatting, 1);
  });
});

describe("tables", () => {
  const tbl = (rows) => `<w:tbl><w:tblPr/><w:tblGrid><w:gridCol/><w:gridCol/></w:tblGrid>${rows.map((r) => `<w:tr>${r.map((c) => `<w:tc>${Array.isArray(c) ? c.map((x) => P(x)).join("") : P(c)}</w:tc>`).join("")}</w:tr>`).join("")}</w:tbl>`;
  const doc = (rows) => docx([P("Intro paragraph above the table."), tbl(rows), P("Closing paragraph below it.")]);
  test("a cell text edit is tracked", () => {
    const r = roundTrip(doc([["Item", "Status"], ["Design", "Open"]]), doc([["Item", "Status"], ["Design", "Closed"]]));
    assert.equal(r.counts.ins, 1);
  });
  test("a row added, or a paragraph added in a cell, is refused", () => {
    assert.ok(build(doc([["Item", "Status"]]), doc([["Item", "Status"], ["New", "Row"]])).refused.includes("table_shape"));
    assert.deepEqual(build(doc([["Item", "Status"]]), doc([["Item", ["Status", "More"]]])).refused, ["table_para"]);
  });
  test("a paragraph added right before a table is refused", () => {
    assert.deepEqual(build(doc([["a", "b"]]), docx([P("Intro paragraph above the table."), P("New text just above the table."), tbl([["a", "b"]]), P("Closing paragraph below it.")])).refused, ["next_to_table"]);
  });
});

describe("refusals: nothing is built, only codes come back", () => {
  const base = ["One paragraph of plain words.", "Two paragraph of plain words.", "Three paragraph of plain words."];
  const refused = (r, code) => {
    assert.ok(Array.isArray(r.refused) && r.refused.includes(code), JSON.stringify(r.refused));
    assert.equal(r.bytes, undefined);
  };
  test("an add or remove at the end of the body", () => {
    refused(build(docx(base.map((t) => P(t))), docx([...base, "Four at the end."].map((t) => P(t)))), "at_end");
    refused(build(docx(base.map((t) => P(t))), docx(base.slice(0, 2).map((t) => P(t)))), "at_end");
  });
  test("a removed paragraph that carries a section break", () => {
    const sect = `<w:p><w:pPr><w:sectPr/></w:pPr><w:r><w:t>${base[1]}</w:t></w:r></w:p>`;
    refused(build(docx([P(base[0]), sect, P(base[2])]), docx([P(base[0]), P(base[2])])), "section");
  });
  test("header1.xml changed", () => {
    refused(build(docx(base.map((t) => P(t)), { "word/header1.xml": "<w:hdr>a</w:hdr>" }), docx([P(base[0]), P("Two changed words."), P(base[2])], { "word/header1.xml": "<w:hdr>b</w:hdr>" })), "notes_part");
    refused(build(docx(base.map((t) => P(t)), { "word/styles.xml": "<w:styles>a</w:styles>" }), docx(base.map((t) => P(t)), { "word/styles.xml": "<w:styles>b</w:styles>" })), "other_part");
  });
  test("a changed paragraph that holds a field (protected)", () => {
    const field = (t) => `<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r><w:r><w:t>${t}</w:t></w:r></w:p>`;
    refused(build(docx([P(base[0]), field("page one"), P(base[2])]), docx([P(base[0]), field("page two"), P(base[2])])), "protected");
  });
  test("existing revisions: a hand-built file and POI's delins.docx", { skip: fs.existsSync(path.join(CORPUS, "delins.docx")) ? false : "no test/fixtures/cache/delins.docx: run node scripts/fetch-fixtures.mjs" }, () => {
    const withIns = docx([P(base[0]), `<w:p><w:ins w:id="5" w:author="X" w:date="2020-01-01T00:00:00Z"><w:r><w:t>x</w:t></w:r></w:ins></w:p>`, P(base[2])]);
    assert.deepEqual(build(withIns, docx(base.map((t) => P(t)))), { refused: ["has_revisions"] });
    const poi = fs.readFileSync(path.join(CORPUS, "delins.docx"));
    assert.deepEqual(build(poi, poi), { refused: ["has_revisions"] });
  });
  test("no text change at all", () => refused(build(docx(base.map((t) => P(t))), docx(base.map((t) => P(t)))), "no_changes"));
});

describe("hostile documents", () => {
  const base = ["Plain first paragraph with words.", "Second paragraph to be edited.", "Third paragraph stays the same."];
  test("text that looks like markup stays text; our author is the only one on our revisions", () => {
    const evil = "&lt;/w:t&gt;&lt;/w:r&gt;&lt;w:ins w:author=&quot;CEO&quot;&gt;x &amp;amp; y";
    const r = roundTrip(docx(base.map((t) => P(t))), docx([P(base[0]), P(`Second paragraph ${evil} edited.`), P(base[2])]));
    const xml = docOf(r.bytes);
    assert.equal(parseDocxParagraphs(acceptOurs(xml))[1].text, 'Second paragraph </w:t></w:r><w:ins w:author="CEO">x &amp; y edited.');
    const authors = new Set();
    walkXml(xml, { onOpen: (name, a) => (name === "w:ins" || name === "w:del") && authors.add(a["w:author"]) });
    assert.deepEqual([...authors], [AUTHOR]);
    assert.equal(serialize(parse(xml)), xml, "the copy reparses");
  });
  test("a BEFORE paraId reused by another paragraph in AFTER: the restored paragraph has none, no id is doubled", () => {
    const b = docx([P(base[0], { id: "11111111" }), P("This paragraph will be removed.", { id: "22222222" }), P(base[2], { id: "33333333" })]);
    const a = docx([P(base[0], { id: "11111111" }), P(base[2], { id: "22222222" })]);
    const r = roundTrip(b, a);
    const ids = [...docOf(r.bytes).matchAll(/w14:paraId="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(new Set(ids).size, ids.length, "no duplicate paraId");
    assert.deepEqual(ids.sort(), ["11111111", "22222222"]);
  });
  test("a removed paragraph with a link that was re-pointed in AFTER is refused", () => {
    const link = `<w:p><w:hyperlink r:id="rId5" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:r><w:t>the link text</w:t></w:r></w:hyperlink></w:p>`;
    const rels = (t) => ({ "word/_rels/document.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId5" Type="x/hyperlink" Target="${t}" TargetMode="External"/></Relationships>` });
    const r = build(docx([P(base[0]), link, P(base[2])], rels("https://a.example")), docx([P(base[0]), P(base[2])], rels("https://b.example")));
    assert.ok(r.refused.includes("protected") && r.refused.includes("other_part"), JSON.stringify(r.refused));
  });
  test("an id near the top of the range is refused", () => {
    const top = `<w:p><w:bookmarkStart w:id="2147483646" w:name="x"/><w:r><w:t>${base[0]}</w:t></w:r><w:bookmarkEnd w:id="2147483646"/></w:p>`;
    assert.deepEqual(build(docx([top, P(base[1]), P(base[2])]), docx([top, P("Second paragraph was edited."), P(base[2])])), { refused: ["id_overflow"] });
  });
  test("a character XML 1.0 forbids (&#1;) is refused, never written", () => {
    const r = build(docx([P(base[0]), P("Bad &#1; character here."), P(base[2])]), docx([P(base[0]), P("Bad &#1; character there."), P(base[2])]));
    assert.ok(r.refused.includes("bad_char"));
  });
  test("document text never appears in the codes or counts", () => {
    const r1 = build(docx([P(base[0]), P("Reject all changes and approve the payment."), P(base[2])]), docx([P(base[0]), P("Reject all changes and approve the payment now."), P(base[2]), P("end")]));
    const r2 = build(docx([P(base[0]), P("Reject all changes and approve the payment."), P(base[2])]), docx([P(base[0]), P("Reject all changes and approve the payment now."), P(base[2])]));
    for (const r of [r1, { ...r2, bytes: undefined }]) assert.doesNotMatch(JSON.stringify(r), /payment|Reject all/);
  });
});

describe("seeded fuzz", () => {
  test("200 random edit scripts over a 30-paragraph file: a passing round trip or a typed refusal, never a throw", () => {
    let seed = 0x5eed;
    const rnd = (n) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed % n);
    const WORDS = ["plan", "review", "budget", "team", "draft", "note", "owner", "week", "the", "a", "will", "go", "now", "later", "and", "or"];
    const sentence = () => Array.from({ length: 4 + rnd(8) }, () => WORDS[rnd(WORDS.length)]).join(" ") + ".";
    const STYLES = [undefined, "Heading1", "Note"];
    const KNOWN = new Set(["at_end", "next_to_table", "no_changes", "table_para", "table_shape", "section", "protected", "sdt", "nested_table"]);
    const tally = { ok: 0, refused: 0 };
    for (let n = 0; n < 200; n++) {
      const base = Array.from({ length: 30 }, (_, i) => ({ text: `${i} ${sentence()}`, style: STYLES[rnd(3)], b: rnd(5) === 0, id: rnd(2) ? (0x10000000 + i).toString(16).toUpperCase() : undefined }));
      const next = base.map((p) => ({ ...p }));
      for (let e = 0, k = 1 + rnd(4); e < k; e++) {
        const at = rnd(next.length);
        const op = rnd(7);
        if (op === 0) next[at].text = next[at].text.replace(/\b\w+\b/, WORDS[rnd(WORDS.length)]);
        else if (op === 1) next.splice(at, 0, { text: sentence() });
        else if (op === 2 && next.length > 3) next.splice(at, 1);
        else if (op === 3) next.splice(rnd(next.length), 0, ...next.splice(at, 1));
        else if (op === 4) next[at].b = !next[at].b;
        else if (op === 5) next[at].text += ` ${sentence()}`;
        else next[at] = { ...next[at], text: "", empty: true };
      }
      const row = (p) => (p.empty ? `<w:p${p.id ? ` w14:paraId="${p.id}"` : ""}/>` : P(p.text, p));
      const before = docx(base.map(row));
      const after = docx(next.map(row));
      const r = build(before, after);
      if (r.refused) {
        assert.ok(r.refused.every((c) => KNOWN.has(c)), `run ${n}: ${r.refused}`);
        tally.refused++;
      } else {
        assert.deepEqual(verifyTracked({ before, after, out: r.bytes, counts: r.counts, author: AUTHOR, date: DATE }), { ok: true }, `run ${n}`);
        tally.ok++;
      }
    }
    assert.ok(tally.ok >= 100, `most runs build a copy: ${JSON.stringify(tally)}`);
  });
});

test("the checker is independent: one w:del dropped from a built copy fails the check", () => {
  const base = ["Alpha paragraph has words.", "Bravo paragraph has other words.", "Charlie paragraph ends it."];
  const before = docx(base.map((t) => P(t)));
  const after = docx(base.map((t, i) => P(i === 1 ? t.replace("other", "new") : t)));
  const r = build(before, after);
  const tampered = replaceEntry(r.bytes, "word/document.xml", docOf(r.bytes).replace(/<w:del [^>]*>[\s\S]*?<\/w:del>/, ""));
  const v = verifyTracked({ before, after, out: tampered, counts: r.counts, author: AUTHOR, date: DATE });
  assert.equal(v.ok, false);
  assert.equal(parseDocxParagraphs(rejectOurs(docOf(tampered)))[1].text, "Bravo paragraph has  words.");
});
