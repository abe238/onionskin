import assert from "node:assert/strict";
import { test } from "node:test";
import { docxBytes } from "./helpers/zipbuild.js";
import { mergeDocx, minimalReplace, runPatches } from "../src/merge.js";
import { readDocxParagraphs } from "../src/docx.js";
import { runOps } from "../src/ops/run.js";

// What the user typed while the agent worked is carried onto the agent's version (src/merge.js). Real DOCX bytes, the real op engine.
const P = Array.from({ length: 8 }, (_, i) => `Paragraph ${i + 1}: the team reviews item ${i * 7 + 3} each quarter and files a short note.`);
const texts = (bytes) => readDocxParagraphs(bytes).map((p) => p.text);
const merge = (mine, theirs) => mergeDocx({ base: docxBytes(P), mine: docxBytes(mine), theirs: docxBytes(theirs), name: "t.docx", runOps });
const edit = (list, i, from, to) => list.map((t, k) => (k === i ? t.replace(from, to) : t));

test("minimalReplace: the find text occurs once and is never empty", () => {
  assert.deepEqual(minimalReplace("the cat sat on the mat", "the cat sat on a mat"), { find: " the", replace: " a" });
  assert.deepEqual(minimalReplace("abc", "abcd"), { find: "c", replace: "cd" });
  assert.deepEqual(minimalReplace("aaa", "aaaa"), { find: "aaa", replace: "aaaa" });
  assert.equal(minimalReplace("", "x"), null);
  assert.deepEqual(minimalReplace("hello world", "hello"), { find: " world", replace: "" });
});

test("the user and the agent edit different paragraphs: both edits are in the result", async () => {
  const r = await merge(edit(P, 5, "short note", "short written note"), edit(P, 1, "reviews", "audits"));
  assert.equal(r.merged, 1);
  assert.deepEqual(r.unplaced, []);
  assert.deepEqual(texts(r.bytes), edit(edit(P, 5, "short note", "short written note"), 1, "reviews", "audits"));
});

test("both edit the same paragraph: the agent's text stays and the user's text is handed back, never dropped", async () => {
  const mine = edit(P, 2, "each quarter", "every month");
  const theirs = edit(P, 2, "reviews", "audits");
  const r = await merge(mine, theirs);
  assert.equal(r.merged, 0);
  assert.equal(r.bytes, null, "nothing is written when nothing could be carried");
  assert.equal(r.unplaced.length, 1);
  assert.equal(r.unplaced[0].text, mine[2]);
  assert.match(r.unplaced[0].why, /agent changed this paragraph too/);
});

test("new paragraphs typed after an untouched one land after it, in order, while the agent inserts elsewhere", async () => {
  const mine = [...P.slice(0, 4), "First new line.", "Second new line.", ...P.slice(4)];
  const theirs = [P[0], "The agent added this.", ...P.slice(1)];
  const r = await merge(mine, theirs);
  assert.equal(r.merged, 2);
  assert.deepEqual(r.unplaced, []);
  assert.deepEqual(texts(r.bytes), [P[0], "The agent added this.", ...P.slice(1, 4), "First new line.", "Second new line.", ...P.slice(4)]);
});

test("a paragraph the user split in two: both halves are in the result", async () => {
  const [head, tail] = [P[3].slice(0, 30), P[3].slice(30)];
  const mine = [...P.slice(0, 3), head, tail, ...P.slice(4)];
  const r = await merge(mine, edit(P, 6, "reviews", "audits"));
  assert.deepEqual(r.unplaced, []);
  assert.deepEqual(texts(r.bytes), [...P.slice(0, 3), head, tail, ...P.slice(4, 6), P[6].replace("reviews", "audits"), P[7]]);
});

test("a paragraph the user deleted is deleted; one the agent changed meanwhile is kept and reported", async () => {
  const mine = P.filter((_, i) => i !== 4 && i !== 6);
  const theirs = edit(P, 6, "reviews", "audits");
  const r = await merge(mine, theirs);
  assert.equal(r.merged, 1);
  assert.deepEqual(texts(r.bytes), theirs.filter((_, i) => i !== 4));
  assert.equal(r.unplaced.length, 1);
  assert.match(r.unplaced[0].why, /You deleted this paragraph, but the agent changed it/);
});

test("a new paragraph next to one the agent rewrote still lands near it, by the nearest untouched paragraph", async () => {
  const mine = [...P.slice(0, 3), "Typed under paragraph three.", ...P.slice(3)];
  const theirs = edit(P, 2, "reviews", "audits");
  const r = await merge(mine, theirs);
  assert.equal(r.merged, 1);
  assert.deepEqual(texts(r.bytes), [...theirs.slice(0, 2), "Typed under paragraph three.", ...theirs.slice(2)]);
});

test("the user changed nothing: nothing to write", async () => {
  const r = await merge(P, edit(P, 1, "reviews", "audits"));
  assert.deepEqual({ bytes: r.bytes, merged: r.merged, unplaced: r.unplaced }, { bytes: null, merged: 0, unplaced: [] });
});

test("the session merge: refused while a batch is delivered, refused for a base that is not a hash, a no-op when the file did not change", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "os-merge-"));
  process.env.ONIONSKIN_STATE_DIR = path.join(root, "st");
  try {
    const { Sessions } = await import("../src/session.js");
    const { ensureStateDir } = await import("../src/paths.js");
    const { sha256 } = await import("../src/fsutil.js");
    ensureStateDir();
    const file = path.join(root, "m.docx");
    fs.writeFileSync(file, docxBytes(P));
    const S = new Sessions();
    const s = S.open(file);
    const base = sha256(fs.readFileSync(file));
    const mine = docxBytes(edit(P, 5, "short note", "short written note"));
    await assert.rejects(S.mergeUserEdits(s.key, { baseSha: "../../etc/passwd", bytes: mine }), /sha256/);
    assert.equal((await S.mergeUserEdits(s.key, { baseSha: base, bytes: mine })).same, true, "the disk still holds the page's version");
    s.delivered = { batch: { batch_id: "b1" } };
    await assert.rejects(S.mergeUserEdits(s.key, { baseSha: base, bytes: mine }), (e) => /agent is working/.test(e.message));
    assert.deepEqual(texts(fs.readFileSync(file)), P, "nothing was written");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---- formatting and moves -------------------------------------------------------------------------------------------
// The user's version (`mine`) is made the way the page makes it: the engine edits the base and saves. The agent's version too.
const pid = (n) => String(n).padStart(8, "0");
const xp = (n, inner, ppr = "") => `<w:p w14:paraId="${pid(n)}">${ppr ? `<w:pPr>${ppr}</w:pPr>` : ""}${inner}</w:p>`;
const xr = (text, rpr = "") => `<w:r>${rpr ? `<w:rPr>${rpr}</w:rPr>` : ""}<w:t xml:space="preserve">${text}</w:t></w:r>`;
const T = (n) => `Section ${n}: the group meets on day ${n * 3 + 1} and writes a short summary.`;
const RICH_BODY = [
  xp(1, xr(T(1))),
  xp(2, xr(T(2))),
  xp(3, xr("Section 3: ", '<w:b/><w:bCs/><w:lang w:val="en-US"/>') + xr("the group meets on day 10 and writes a short summary.", '<w:lang w:val="en-US"/>')),
  xp(4, xr(T(4))),
  xp(5, xr("Page ") + '<w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple>' + xr(" of the quarterly report, a protected paragraph.")),
  xp(6, xr(T(6))),
  `<w:tbl><w:tr><w:tc>${xp(20, xr("First cell paragraph, long enough to count as moved."))}${xp(21, xr("Second cell paragraph, long enough to count as moved."))}</w:tc></w:tr></w:tbl>`,
  xp(7, xr("Section 7: this paragraph ends a section of the document."), '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>'),
  xp(8, '<w:bookmarkStart w:id="5" w:name="open"/>' + xr("Section 8: a bookmark starts here and ends in the next paragraph.")),
  xp(9, xr("Section 9: the bookmark that started above ends in this one.") + '<w:bookmarkEnd w:id="5"/>'),
  xp(10, xr(T(10))),
  '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>',
].join("");
const RICH = docxBytes([], {}, RICH_BODY);
const read = (bytes) => readDocxParagraphs(bytes, { detail: true });
const find = (bytes, starts) => read(bytes).find((p) => p.text.startsWith(starts));
const loc = (bytes, starts) => ({ text_hash: find(bytes, starts).hash });
/** `ops` run by the engine on `bytes`: every op must apply */
const edited = async (bytes, ops) => {
  const r = await runOps({ bytes, format: "docx", name: "t.docx", ops });
  assert.ok(r.bytes && r.results.every((x) => x.status === "applied"), JSON.stringify(r.results));
  return r.bytes;
};
const retext = (bytes, starts, from, to) => ({ op: "replace_text", target: loc(bytes, starts), expect: loc(bytes, starts), find: from, replace: to });
const fmt = (bytes, starts, { para, words = {} } = {}) => {
  const p = find(bytes, starts);
  const runs = Object.entries(words).map(([w, set]) => ({ start: p.text.indexOf(w), end: p.text.indexOf(w) + w.length, set }));
  return { op: "format_paragraph", target: { text_hash: p.hash }, expect: { text_hash: p.hash }, ...(para ? { para } : {}), ...(runs.length ? { runs } : {}) };
};
const mv = (bytes, starts, where, anchor) => ({ op: "move_paragraph", target: loc(bytes, starts), expect: loc(bytes, starts), to: loc(bytes, anchor), where });
const rich = (mine, theirs, run = runOps) => mergeDocx({ base: RICH, mine, theirs, name: "t.docx", runOps: run });
const order = (bytes) => read(bytes).map((p) => (/^Section (\d+)/.exec(p.text)?.[1] ?? p.text.slice(0, 12)));
const BASE_ORDER = order(RICH);
/** the formatting of the characters of `word` in the paragraph: one object when it is uniform */
const look = (bytes, starts, word) => {
  const p = find(bytes, starts);
  let at = 0;
  const hit = p.spans.filter((x) => ((at += x.n), at > p.text.indexOf(word) && at - x.n < p.text.indexOf(word) + word.length));
  assert.equal(hit.length, 1, `"${word}" is one run`);
  return hit[0].set;
};
const paraXml = (bytes, id) => new RegExp(`<w:p w14:paraId="${pid(id)}"[\\s\\S]*?</w:p>`).exec(new TextDecoder().decode(zipText(bytes)))?.[0];
const { openZip } = await import("../src/zip.js");
const zipText = (bytes) => Buffer.from(openZip(bytes).readText("word/document.xml"));

test("the merge's own ops are not in the ops schema: an agent's ops file cannot format or move through them", async () => {
  const { validateOps } = await import("../src/ops/schema.js");
  const h = "0123456789abcdef";
  for (const op of [{ op: "move_paragraph", target: { text_hash: h }, expect: { text_hash: h }, to: { text_hash: h }, where: "after" }, { op: "format_paragraph", target: { text_hash: h }, expect: { text_hash: h }, para: { align: "center" } }]) {
    const v = validateOps({ schema: "onionskin.ops/1", ops: [op] });
    assert.equal(v.ok, false);
    assert.match(v.errors.join(" "), /unknown op/);
  }
});

test("runPatches: the difference between two readings of the same text, by character, as maximal ranges", () => {
  const plain = [{ n: 10, set: {}, rest: "" }];
  assert.deepEqual(runPatches(plain, [{ n: 3, set: {}, rest: "" }, { n: 2, set: { b: true }, rest: "" }, { n: 2, set: { b: true }, rest: "" }, { n: 3, set: {}, rest: "" }]), { ranges: [{ start: 3, end: 7, set: { b: true } }], other: false });
  assert.deepEqual(runPatches([{ n: 4, set: { b: true, color: "#ff0000" }, rest: "" }, { n: 6, set: {}, rest: "" }], plain), { ranges: [{ start: 0, end: 4, set: { b: null, color: null } }], other: false });
  assert.deepEqual(runPatches(plain, [{ n: 10, set: { i: true }, rest: "w:rStyle{w:val=Strong}" }]), { ranges: [], other: true }, "a stretch with a property that cannot be set gets no patch");
  assert.equal(runPatches(plain, [{ n: 9, set: {}, rest: "" }]), null);
  assert.equal(runPatches(null, plain), null);
});

test("the reader's detail: runs as engine values, list kind, section end, a range with one end in the paragraph", () => {
  const ps = read(RICH);
  assert.deepEqual(ps[2].spans, [{ n: 11, set: { b: true }, rest: "w:lang{w:val=en-US}" }, { n: 53, set: {}, rest: "w:lang{w:val=en-US}" }]);
  assert.equal(ps[4].protected, true);
  assert.deepEqual([find(RICH, "Section 7").sect, find(RICH, "Section 8").loose, find(RICH, "Section 9").loose, find(RICH, "Section 6").loose], [true, true, true, false]);
  assert.equal("spans" in readDocxParagraphs(RICH)[0], false, "nothing extra is collected for the other readers");
});

test("a moved paragraph is moved in the agent's version, with its formatting and its id, while the agent edits elsewhere", async () => {
  const mine = await edited(RICH, [mv(RICH, "Section 3", "after", "Section 6")]);
  assert.deepEqual(order(mine), ["1", "2", "4", "Page 1 of th", "6", "3", "First cell p", "Second cell ", "7", "8", "9", "10"]);
  const theirs = await edited(RICH, [retext(RICH, "Section 1:", "short", "brief")]);
  const r = await rich(mine, theirs);
  assert.deepEqual(r.unplaced, []);
  assert.equal(r.merged, 1);
  assert.deepEqual(order(r.bytes), order(mine));
  assert.match(find(r.bytes, "Section 1:").text, /brief summary/, "the agent's edit is there");
  assert.equal(paraXml(r.bytes, 3), paraXml(RICH, 3), "the moved paragraph is the original, byte for byte");
});

test("a paragraph moved to the top, two moved together with a new line typed between them: the user's order", async () => {
  const top = await edited(RICH, [mv(RICH, "Section 10", "before", "Section 1:")]);
  const r1 = await rich(top, await edited(RICH, [retext(RICH, "Section 4", "short", "brief")]));
  assert.deepEqual(r1.unplaced, []);
  assert.deepEqual(order(r1.bytes), ["10", "1", "2", "3", "4", "Page 1 of th", "6", "First cell p", "Second cell ", "7", "8", "9"]);
  // 3 and 4 go under 6 (4 first, then 3 above it), and a line is typed between them
  const block = await edited(RICH, [mv(RICH, "Section 4", "after", "Section 6"), mv(RICH, "Section 3", "after", "Section 6"), { op: "insert_paragraph_after", target: loc(RICH, "Section 3"), expect: loc(RICH, "Section 3"), text: "Typed between the two." }]);
  assert.deepEqual(order(block), ["1", "2", "Page 1 of th", "6", "3", "Typed betwee", "4", "First cell p", "Second cell ", "7", "8", "9", "10"]);
  const theirs = await edited(RICH, [retext(RICH, "Section 10", "short", "brief"), { op: "insert_paragraph_after", target: loc(RICH, "Section 1:"), expect: loc(RICH, "Section 1:"), text: "The agent added this line." }]);
  const r2 = await rich(block, theirs);
  assert.deepEqual(r2.unplaced, []);
  assert.equal(r2.merged, 3);
  assert.deepEqual(order(r2.bytes), ["1", "The agent ad", "2", "Page 1 of th", "6", "3", "Typed betwee", "4", "First cell p", "Second cell ", "7", "8", "9", "10"]);
});

test("a move is not carried, and said so, when the agent edited, removed or also moved the paragraph, or changed its new neighbors", async () => {
  const mine = await edited(RICH, [mv(RICH, "Section 3", "after", "Section 6")]);
  const cases = [
    [[retext(RICH, "Section 3", "short", "brief")], /agent changed or removed it/],
    [[{ op: "delete_paragraph", target: loc(RICH, "Section 3"), expect: loc(RICH, "Section 3") }], /agent changed or removed it/],
    [[mv(RICH, "Section 3", "before", "Section 1:")], /so did the agent\. It is where the agent put it/],
    [[retext(RICH, "Section 6", "short", "brief"), { op: "delete_paragraph", target: loc(RICH, "Section 4"), expect: loc(RICH, "Section 4") }], /agent changed the paragraphs next to its new place/],
  ];
  for (const [agent, why] of cases) {
    const theirs = await edited(RICH, agent);
    const r = await rich(mine, theirs);
    assert.equal(r.bytes, null, "nothing is written");
    assert.equal(r.merged, 0);
    assert.equal(r.unplaced.length, 1, JSON.stringify(r.unplaced));
    assert.match(r.unplaced[0].why, why);
    assert.equal(r.unplaced[0].text, "", "nothing to copy: the text is in the document");
  }
});

test("formatting changed on a paragraph that was also moved: the move is carried, the formatting is not, and the report says which", async () => {
  const theirs = await edited(RICH, [retext(RICH, "Section 1:", "short", "brief")]);
  const cases = [
    [{ words: { group: { b: true } } }, /^Your move was carried over\. The bold you changed inside this paragraph was not: the paragraph has the formatting of the agent's version\.$/, undefined],
    [{ para: { style: "Heading 2", align: "center" }, words: { summary: { i: true, color: "#ff0000" } } }, /^Your move was carried over\. The italic and color you changed inside this paragraph was not: the paragraph has the formatting of the agent's version\.$/, undefined],
    // a heading, an alignment or a list alone: the copy of a pasted paragraph can differ in these without the user's doing
    [{ para: { style: "Heading 2", align: "center" } }, /^Your move was carried over\. This paragraph has the formatting of the agent's version: if you changed its formatting too, set it again\.$/, true],
    [{ para: { list: "bullet" } }, /^Your move was carried over\. This paragraph has the formatting of the agent's version: if you changed its formatting too, set it again\.$/, true],
  ];
  for (const [change, why, check] of cases) {
    const styled = await edited(RICH, [fmt(RICH, "Section 2", change)]);
    const mine = await edited(styled, [mv(styled, "Section 2", "after", "Section 6")]);
    const r = await rich(mine, theirs);
    assert.equal(r.merged, 1, "the move is carried");
    assert.deepEqual(order(r.bytes), order(mine));
    assert.equal(paraXml(r.bytes, 2), paraXml(RICH, 2), "the paragraph is the agent's, byte for byte: nothing of the user's formatting is set");
    assert.equal(r.unplaced.length, 1, JSON.stringify(r.unplaced));
    assert.match(r.unplaced[0].why, why);
    assert.equal(r.unplaced[0].text, "", "nothing to copy: the text is in the document");
    assert.equal(r.unplaced[0].check, check, "a line that names a change is a loss; one that asks to look is not");
  }
  // the move could not be made: one line about the move, not a second one about the formatting
  const styled = await edited(RICH, [fmt(RICH, "Section 2", { words: { group: { b: true } } })]);
  const mine = await edited(styled, [mv(styled, "Section 2", "after", "Section 6")]);
  const r = await rich(mine, await edited(RICH, [retext(RICH, "Section 2", "short", "brief")]));
  assert.deepEqual(r.unplaced.map((x) => x.why), ["You moved this paragraph, but the agent changed or removed it, so the move was not carried over."]);
});

test("a moved paragraph is the agent's paragraph, as it is: what a paste did to the user's copy is never set, and the report says to check the formatting", async () => {
  // what the editor's paste leaves (seen in the real editor): no style, no alignment, no list, the look written out on every run
  const spelled = '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:b/><w:bCs/><w:i w:val="0"/><w:iCs w:val="0"/><w:color w:val="4F81BD"/><w:sz w:val="26"/><w:szCs w:val="26"/>';
  const head = xp(2, xr(T(2)), '<w:pStyle w:val="Heading2"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr><w:jc w:val="center"/>');
  const six = xp(6, xr(T(6)));
  const body = RICH_BODY.replace(xp(2, xr(T(2))), head);
  assert.ok(body.includes(head) && body.includes(six));
  const base = docxBytes([], {}, body);
  const mine = docxBytes([], {}, body.replace(head, "").replace(six, six + xp(2, xr(T(2), spelled))));
  const go = (theirs) => mergeDocx({ base, mine, theirs, name: "t.docx", runOps });
  // the agent rewrote it: one line about the move, nothing about bold or color
  let r = await go(await edited(base, [retext(base, "Section 2", "short", "brief")]));
  assert.equal(r.bytes, null);
  assert.deepEqual(r.unplaced.map((x) => x.why), ["You moved this paragraph, but the agent changed or removed it, so the move was not carried over."]);
  // the agent left it alone: it is moved with its heading style, its list and its alignment. A paste and a heading the user took off
  // before pasting look the same, so the report does not claim either: it says what the paragraph has and what to check.
  const theirs = await edited(base, [retext(base, "Section 1:", "short", "brief")]);
  r = await go(theirs);
  assert.equal(r.merged, 1);
  assert.deepEqual(r.unplaced, [{ label: `"${T(2).split(" ").slice(0, 8).join(" ")}..."`, text: "", why: "Your move was carried over. This paragraph has the formatting of the agent's version: if you changed its formatting too, set it again.", check: true }]);
  assert.deepEqual(order(r.bytes), order(mine));
  assert.equal(paraXml(r.bytes, 2), head, "byte for byte the paragraph the agent has");
  // one word of the pasted copy is italic where the original has one look from end to end: that is the user's, and it is said
  const cut = T(2).indexOf("meets");
  const word = docxBytes([], {}, body.replace(head, "").replace(six, six + xp(2, xr(T(2).slice(0, cut), spelled) + xr("meets", spelled.replace('<w:i w:val="0"/><w:iCs w:val="0"/>', "<w:i/><w:iCs/>")) + xr(T(2).slice(cut + 5), spelled))));
  r = await mergeDocx({ base, mine: word, theirs, name: "t.docx", runOps });
  assert.equal(r.merged, 1);
  assert.deepEqual(r.unplaced.map((x) => [x.why, x.check]), [["Your move was carried over. The italic you changed inside this paragraph was not: the paragraph has the formatting of the agent's version.", undefined]]);
  assert.equal(paraXml(r.bytes, 2), head);
});

test("the move op itself refuses what must not move, whoever asks: a table cell, a section end, half a bookmark, a protected paragraph or neighbor, itself", async () => {
  const to = loc(RICH, "Section 2");
  const tryMove = async (starts, anchor = to) => (await runOps({ bytes: RICH, format: "docx", name: "t.docx", ops: [{ op: "move_paragraph", target: loc(RICH, starts), expect: loc(RICH, starts), to: anchor, where: "after" }] })).results[0];
  assert.equal((await tryMove("First cell paragraph")).code, "move_not_in_body");
  assert.equal((await tryMove("Section 6", loc(RICH, "First cell paragraph"))).code, "move_not_in_body");
  assert.equal((await tryMove("Section 7")).code, "move_section_break");
  assert.equal((await tryMove("Section 8")).code, "move_open_range");
  assert.equal((await tryMove("Section 9")).code, "move_open_range");
  assert.equal((await tryMove("Page 1")).status, "skipped_protected");
  assert.equal((await tryMove("Section 6", loc(RICH, "Page 1"))).status, "skipped_protected");
  assert.equal((await tryMove("Section 2")).code, "move_onto_itself");
  const wrong = (await runOps({ bytes: RICH, format: "docx", name: "t.docx", ops: [{ op: "move_paragraph", target: loc(RICH, "Section 6"), expect: { text_hash: "0000000000000000" }, to, where: "after" }] })).results[0];
  assert.equal(wrong.status, "expect_mismatch");
});

test("a move that cannot be made safely is reported and nothing moves: a table cell, a section end, half a bookmark, a protected paragraph", async () => {
  const theirs = await edited(RICH, [retext(RICH, "Section 1:", "short", "brief")]);
  // the engine itself moves these when asked (the user's page did): the merge must not
  const raw = (from, to) => docxBytes([], {}, RICH_BODY.replace(from, "").replace(to, to + from));
  const cell = xp(20, xr("First cell paragraph, long enough to count as moved."));
  const sect = xp(7, xr("Section 7: this paragraph ends a section of the document."), '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>');
  const open = xp(8, '<w:bookmarkStart w:id="5" w:name="open"/>' + xr("Section 8: a bookmark starts here and ends in the next paragraph."));
  const prot = xp(5, xr("Page ") + '<w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple>' + xr(" of the quarterly report, a protected paragraph."));
  const two = xp(2, xr(T(2)));
  for (const [mine, why] of [
    [raw(cell, two), /in or out of a table/],
    [raw(sect, two), /ends a section/],
    [raw(open, two), /comment or bookmark starts or ends inside it/],
    [raw(prot, two), /protected paragraph/],
  ]) {
    assert.notDeepEqual(order(mine), BASE_ORDER, "the user's version has the move");
    const r = await rich(mine, theirs);
    assert.equal(r.bytes, null, `nothing is written (${why})`);
    assert.equal(r.unplaced.length, 1, JSON.stringify(r.unplaced));
    assert.match(r.unplaced[0].why, why);
  }
});

test("formatting inside a paragraph the agent left alone is carried exactly: bold, italic, underline, color, size, font, highlight, and bold taken off", async () => {
  const mine = await edited(RICH, [
    fmt(RICH, "Section 2", { words: { group: { b: true, i: true }, summary: { u: "single", color: "#c00000", sz: 14, font: "Georgia", hl: "#ffff00" } } }),
    fmt(RICH, "Section 3", { words: { "Section 3: ": { b: null } } }),
  ]);
  assert.deepEqual(look(mine, "Section 2", "group"), { b: true, i: true });
  const theirs = await edited(RICH, [retext(RICH, "Section 6", "short", "brief")]);
  const r = await rich(mine, theirs);
  assert.deepEqual(r.unplaced, []);
  assert.equal(r.merged, 2);
  for (const s of ["Section 2", "Section 3"]) assert.deepEqual(runPatches(find(mine, s).spans, find(r.bytes, s).spans), { ranges: [], other: false }, `${s} is formatted as the user has it`);
  assert.deepEqual(look(r.bytes, "Section 2", "summary"), { u: "single", color: "#c00000", sz: 14, font: "Georgia", hl: "#ffff00" });
  assert.deepEqual(read(r.bytes).map((p) => p.text), read(theirs).map((p) => p.text), "no text changed");
  assert.match(paraXml(r.bytes, 3), /w:lang w:val="en-US"/, "what the paragraph had besides is kept");
});

test("a heading level, an alignment and a list set by the user are carried; so is a style set on a paragraph the user also typed in", async () => {
  const mine = await edited(RICH, [
    fmt(RICH, "Section 2", { para: { style: "Heading 2", align: "center" } }),
    fmt(RICH, "Section 4", { para: { list: "bullet" } }),
    fmt(RICH, "Section 6", { para: { style: "Heading 1" } }),
    retext(RICH, "Section 6", "short", "one-page"),
  ]);
  const theirs = await edited(RICH, [retext(RICH, "Section 1:", "short", "brief")]);
  const r = await rich(mine, theirs);
  assert.deepEqual(r.unplaced, []);
  assert.equal(r.merged, 4);
  const got = (s) => (({ styleName, align, list }) => ({ styleName, align, list: list && `${list.kind} ${list.ilvl}` }))(find(r.bytes, s));
  assert.deepEqual(got("Section 2"), { styleName: "Heading 2", align: "center", list: null });
  assert.deepEqual(got("Section 4"), { styleName: undefined, align: "", list: "bullet 0" });
  assert.deepEqual(got("Section 6"), { styleName: "Heading 1", align: "", list: null });
  assert.match(find(r.bytes, "Section 6").text, /one-page summary/);
  assert.match(find(r.bytes, "Section 1:").text, /brief summary/);
  // and back again: the user takes the heading, the alignment and the list off
  const off = await edited(mine, [fmt(mine, "Section 2", { para: { style: null, align: "" } }), fmt(mine, "Section 4", { para: { list: "none" } })]);
  const r2 = await mergeDocx({ base: mine, mine: off, theirs: r.bytes, name: "t.docx", runOps });
  assert.deepEqual(r2.unplaced, []);
  assert.deepEqual([find(r2.bytes, "Section 2").style, find(r2.bytes, "Section 2").align, find(r2.bytes, "Section 4").list], [null, "", null]);
});

test("the agent rewrote the paragraph: the user's heading and alignment are set on the agent's text, the bold inside it is reported", async () => {
  const mine = await edited(RICH, [fmt(RICH, "Section 4", { para: { style: "Heading 2", align: "right" }, words: { group: { b: true } } })]);
  const theirs = await edited(RICH, [retext(RICH, "Section 4", "writes a short summary", "files a full report")]);
  const r = await rich(mine, theirs);
  assert.equal(r.merged, 1);
  const p = find(r.bytes, "Section 4");
  assert.equal(p.text, T(4).replace("writes a short summary", "files a full report"), "the agent's text is untouched");
  assert.deepEqual([p.styleName, p.align], ["Heading 2", "right"]);
  assert.deepEqual(p.spans.map((x) => x.set), [{}], "no run formatting was guessed onto the new text");
  assert.equal(r.unplaced.length, 1);
  assert.equal(r.unplaced[0].why, "Your style and alignment change was carried over. The agent rewrote this paragraph, so the bold you changed inside it was not carried over.");
});

test("formatting is not carried, and said so, when the agent changed the same thing, removed the paragraph, or the kind cannot be set", async () => {
  // the same property on both sides: the agent's stays
  const mine = await edited(RICH, [fmt(RICH, "Section 2", { para: { style: "Heading 2" }, words: { group: { b: true } } })]);
  let theirs = await edited(RICH, [fmt(RICH, "Section 2", { para: { style: "Heading 1" }, words: { summary: { i: true } } })]);
  let r = await rich(mine, theirs);
  assert.equal(r.bytes, null);
  assert.equal(r.unplaced.length, 1);
  assert.equal(r.unplaced[0].why, "The agent changed the style here too, so yours was not carried over. The agent changed formatting inside this paragraph too, so the bold you changed was not carried over.");
  // the agent removed it
  theirs = await edited(RICH, [{ op: "delete_paragraph", target: loc(RICH, "Section 2"), expect: loc(RICH, "Section 2") }]);
  r = await rich(mine, theirs);
  assert.equal(r.bytes, null);
  assert.match(r.unplaced[0].why, /You changed formatting here \(style and bold\), but the agent changed, moved or removed this paragraph/);
  // a character style and paragraph spacing: compared, never set; the bold next to them is carried
  const odd = docxBytes([], {}, RICH_BODY.replace(xp(2, xr(T(2))), xp(2, xr(T(2).slice(0, 20), '<w:rStyle w:val="Strong"/>') + xr(T(2).slice(20, 30), "<w:b/><w:bCs/>") + xr(T(2).slice(30)), '<w:spacing w:before="480"/>')));
  theirs = await edited(RICH, [retext(RICH, "Section 6", "short", "brief")]);
  r = await rich(odd, theirs);
  assert.equal(r.merged, 1);
  assert.equal(r.unplaced.length, 1);
  assert.equal(r.unplaced[0].why, "Your bold change was carried over. Changes to spacing, indent and other paragraph settings and character styles and text effects are not carried over.");
  const p = find(r.bytes, "Section 2");
  assert.deepEqual(p.spans.map((x) => [x.n, x.set, x.rest]), [[20, {}, ""], [10, { b: true }, ""], [T(2).length - 30, {}, ""]]);
  assert.equal(p.ppr, "");
});

test("formatting changed in a protected paragraph is reported, and the paragraph is left as the agent has it", async () => {
  const prot = xp(5, xr("Page ") + '<w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple>' + xr(" of the quarterly report, a protected paragraph."));
  const mine = docxBytes([], {}, RICH_BODY.replace(prot, prot.replace("<w:r><w:t", '<w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t')));
  assert.equal(find(mine, "Page 1").align, "center");
  const theirs = await edited(RICH, [retext(RICH, "Section 6", "short", "brief")]);
  const r = await rich(mine, theirs);
  assert.equal(r.bytes, null);
  assert.equal(r.unplaced.length, 1);
  assert.match(r.unplaced[0].why, /^This is a protected paragraph .* so the alignment you changed here was not carried over\.$/);
});

test("one run with everything: typing, a deletion, new formatting and a move, next to the agent's edit", async () => {
  const mine = await edited(RICH, [
    retext(RICH, "Section 1:", "short", "one-line"),
    fmt(RICH, "Section 2", { para: { align: "center" }, words: { summary: { i: true } } }),
    mv(RICH, "Section 3", "after", "Section 6"),
    { op: "delete_paragraph", target: loc(RICH, "Section 4"), expect: loc(RICH, "Section 4") },
  ]);
  const theirs = await edited(RICH, [retext(RICH, "Section 10", "short", "brief")]);
  const r = await rich(mine, theirs);
  assert.deepEqual(r.unplaced, []);
  assert.equal(r.merged, 4);
  assert.deepEqual(order(r.bytes), order(mine));
  const p = find(r.bytes, "Section 2");
  assert.equal(p.align, "center");
  assert.deepEqual(runPatches(find(mine, "Section 2").spans, p.spans), { ranges: [], other: false });
  assert.match(find(r.bytes, "Section 1:").text, /one-line summary/);
  assert.match(find(r.bytes, "Section 10").text, /brief summary/);
  // a second pass from the user's version changes nothing more
  const again = await mergeDocx({ base: mine, mine, theirs: r.bytes, name: "t.docx", runOps });
  assert.deepEqual({ bytes: again.bytes, merged: again.merged, unplaced: again.unplaced }, { bytes: null, merged: 0, unplaced: [] });
});

test("a move or a formatting change that does not come out as planned is not written: the merge runs again without them and says so", async () => {
  const mine = await edited(RICH, [retext(RICH, "Section 1:", "short", "one-line"), fmt(RICH, "Section 2", { words: { group: { b: true } } }), mv(RICH, "Section 3", "after", "Section 6")]);
  const theirs = await edited(RICH, [retext(RICH, "Section 10", "short", "brief")]);
  // an engine that reports "applied" but colors the word as well, and one that puts the moved paragraph on the wrong side
  const wrong = [
    (op) => (op.op === "format_paragraph" ? { ...op, runs: op.runs.map((x) => ({ ...x, set: { ...x.set, color: "#ff0000" } })) } : op),
    (op) => (op.op === "move_paragraph" ? { ...op, where: "before" } : op),
  ];
  for (const bend of wrong) {
    const calls = [];
    const r = await rich(mine, theirs, (o) => (calls.push(o.ops.map((x) => x.op)), runOps({ ...o, ops: o.ops.map(bend) })));
    assert.deepEqual(calls, [["replace_text", "format_paragraph", "move_paragraph"], ["replace_text"]]);
    assert.equal(r.merged, 1);
    const shape = (bytes, typed) => read(bytes).map((p) => [typed && p.text.startsWith("Section 1:") ? p.text.replace("short", "one-line") : p.text, p.spans.map((x) => x.set)]);
    assert.deepEqual(shape(r.bytes), shape(theirs, true), "only the typing was written: the agent's order and formatting are as they were");
    assert.deepEqual(r.unplaced.map((x) => x.why), ["The bold you changed here could not be set on the agent's version.", "You moved this paragraph, but the move could not be made on the agent's version."]);
  }
});
