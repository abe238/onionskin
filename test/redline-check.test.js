import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { acceptOurs, rejectOurs, verifyTracked } from "../src/redline-check.js";
import { parseDocxParagraphs } from "../src/docx.js";
import { openZip } from "../src/zip.js";
import { replaceEntry } from "../src/zip-write.js";
import { tmpdir } from "./helpers/zipbuild.js";

// The checker of the tracked-changes copy, against references it did not make: the files Microsoft Word itself saved with Track Changes on
// (test/fixtures/word-tracked) and the hand-built files of the spike (scripts/tracked-spike/make-fixtures.mjs), whose Word results are
// recorded in docs/contracts/tracked-changes.md section 5.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORD = path.join(root, "test/fixtures/word-tracked");
const AUTHOR = "Onionskin agent";
const DATE = "2026-11-11T09:05:00Z"; // the spike's fixed date

let gen;
before(() => {
  gen = tmpdir("redline-check-");
  const r = spawnSync(process.execPath, [path.join(root, "scripts/tracked-spike/make-fixtures.mjs"), gen], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});
after(() => fs.rmSync(gen, { recursive: true, force: true }));

const doc = (bytes) => openZip(bytes).readText("word/document.xml");
const file = (name) => fs.readFileSync(path.join(gen, name));
const sig = (xml) => parseDocxParagraphs(xml).map((p) => [JSON.stringify(p.path), p.style || "", p.text].join(" | "));

describe("acceptOurs / rejectOurs on Word's own tracked files", () => {
  // Word's files hold only Word's revisions; with no input ids, every revision counts. insert-mid-own also has Word's pPrChange, which
  // the checker refuses in a copy; the test strips it (the paragraph's AFTER style is already its current one).
  const cases = { "replace-word": "replace-word", "replace-bold": "replace-bold", "cell-edit": "cell-edit", "delete-mid": "delete-mid", "insert-mid-own": "insert-mid" };
  for (const [ref, c] of Object.entries(cases)) {
    test(`${ref}: Accept gives the after file, Reject gives the base`, () => {
      let xml = doc(fs.readFileSync(path.join(WORD, `${ref}.docx`)));
      xml = xml.replace(/<w:pPrChange\b[^>]*>[\s\S]*?<\/w:pPrChange>/g, "");
      assert.deepEqual(sig(acceptOurs(xml)), sig(doc(file(`after-${c}.docx`))));
      assert.deepEqual(sig(rejectOurs(xml)), sig(doc(file("base.docx"))));
    });
  }
  test("Word's insert-mid (the previous paragraph's mark inserted) is refused: that paragraph keeps text on Reject", () => {
    const xml = doc(fs.readFileSync(path.join(WORD, "insert-mid.docx"))).replace(/<w:pPrChange\b[^>]*>[\s\S]*?<\/w:pPrChange>/g, "");
    assert.throws(() => rejectOurs(xml), /still has text/);
  });
  test("a pPrChange in a copy fails the check", () => {
    assert.throws(() => acceptOurs(doc(fs.readFileSync(path.join(WORD, "insert-mid-own.docx")))), /never uses: w:pPrChange/);
  });
});

describe("verifyTracked on the spike's hand-built files", () => {
  const check = (name, base = "base.docx", aft) => verifyTracked({ before: file(base), after: file(aft || `after-${name.replace(/^hand-|-(prevmark|idclash)$/g, "")}.docx`), out: file(`${name}.docx`), counts: { formatting: 0 }, author: AUTHOR, date: DATE });
  for (const c of ["replace-word", "replace-bold", "cell-edit", "insert-mid", "delete-mid"]) {
    test(`hand-${c} (passed Accept and Reject in Word) passes`, () => assert.deepEqual(check(`hand-${c}`), { ok: true }));
  }
  test("hand-insert-end (failed in Word) fails", () => assert.match(check("hand-insert-end").why, /no paragraph after it/));
  test("the two prevmark files (failed Reject in Word) fail", () => {
    assert.match(check("hand-insert-mid-prevmark").why, /still has text/);
    assert.match(check("hand-insert-end-prevmark").why, /still has text/);
  });
  test("a revision id that is already in the file fails", () => assert.equal(check("hand-replace-word-idclash").ok, false));

  const tamper = (name, edit) => {
    const bytes = file(`hand-${name}.docx`);
    return verifyTracked({ before: file("base.docx"), after: file(`after-${name}.docx`), out: replaceEntry(bytes, "word/document.xml", edit(doc(bytes))), counts: { formatting: 0 }, author: AUTHOR, date: DATE });
  };
  test("one deleted run dropped from the copy fails (Reject would lose the word)", () => {
    const r = tamper("replace-word", (x) => x.replace(/<w:del [^>]*><w:r><w:delText>Monday.<\/w:delText><\/w:r><\/w:del>/, ""));
    assert.equal(r.ok, false);
    assert.match(r.why, /Reject All: paragraph 2 text differs/);
  });
  test("another author, another date, or attributes in another order fail", () => {
    assert.match(tamper("replace-word", (x) => x.replace('w:author="Onionskin agent"', 'w:author="CEO"')).why, /another author/);
    assert.match(tamper("replace-word", (x) => x.replace('w:date="2026-11-11T09:05:00Z"', 'w:date="2020-01-01T00:00:00Z"')).why, /another date/);
    assert.match(tamper("replace-word", (x) => x.replace(/<w:ins w:id="(\d+)" w:author="([^"]+)"/, '<w:ins w:author="$2" w:id="$1"')).why, /in that order/);
  });
  test("a text piece with an edge space and no xml:space fails (Word would drop the space)", () => {
    const r = tamper("replace-word", (x) => x.replace('<w:t xml:space="preserve">The team will review the draft on </w:t>', "<w:t>The team will review the draft on </w:t>"));
    assert.match(r.why, /keep them/);
  });
  test("a paragraph mark revision that is not first in the mark properties fails", () => {
    const r = tamper("delete-mid", (x) => x.replace(/<w:rPr>(<w:del [^>]*\/>)<\/w:rPr>/, "<w:rPr><w:b/>$1</w:rPr>"));
    assert.match(r.why, /not first/);
  });
  test("deleted text left in w:t fails", () => {
    const r = tamper("replace-word", (x) => x.replace("<w:delText>Monday.</w:delText>", "<w:t>Monday.</w:t>"));
    assert.equal(r.ok, false);
  });
  test("a wrong formatting count fails", () => {
    const r = verifyTracked({ before: file("base.docx"), after: file("after-replace-word.docx"), out: file("hand-replace-word.docx"), counts: { formatting: 1 }, author: AUTHOR, date: DATE });
    assert.match(r.why, /formatting/);
  });
  test("a part other than the main text that differs fails", () => {
    const bytes = file("hand-replace-word.docx");
    const styles = openZip(bytes).readText("word/styles.xml").replace("Signoff", "Signoff2");
    const r = verifyTracked({ before: file("base.docx"), after: file("after-replace-word.docx"), out: replaceEntry(bytes, "word/styles.xml", styles), counts: { formatting: 0 }, author: AUTHOR, date: DATE });
    assert.match(r.why, /other than the main text/);
  });
  test("garbage never throws: it is a failed check", () => {
    const r = verifyTracked({ before: file("base.docx"), after: file("after-replace-word.docx"), out: Buffer.from("not a zip"), counts: { formatting: 0 }, author: AUTHOR, date: DATE });
    assert.equal(r.ok, false);
  });
});
