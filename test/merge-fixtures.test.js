import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { CORPUS, ENGINE_SAMPLES, haveCorpus, haveSamples, repoRoot, skipUnless } from "../scripts/fixtures.mjs";
import { runOps } from "../src/ops/run.js";
import * as docxOps from "../src/ops/docx.js";
import * as pptxOps from "../src/ops/pptx.js";
import * as xlsxOps from "../src/ops/xlsx.js";
import { readDocxParagraphs } from "../src/docx.js";
import { parseDeck } from "../src/pptx.js";
import { parseWorkbook } from "../src/xlsx.js";
import { exactHash } from "../src/text.js";
import { mergeProven } from "../src/merge-worker.js";

// Merges built from real files: each committed fixture (and the pinned Apache POI corpus when it is fetched), opened and saved unedited
// through the engine path the page and the merge use, or given one ordinary edit of a kind the merge carries, against an agent's text
// edit elsewhere, through the merge and its proof (src/merge-worker.js mergeProven). The person changed only supported things, so a
// merge must never be refused, and nothing may be handed back as a change of a kind no planner carries (`as`: src/merge-proof.js
// handBack): if the engine's own save made such a difference, the list of what the comparison ignores (src/merge-package.js VOLATILE)
// would be wrong. The engine saves an unedited file byte for byte (measured), so that half passes as long as that stays true.

const SKIP = skipUnless(haveSamples(), `engine samples not found in ${ENGINE_SAMPLES}`, "restore test/fixtures/engine or set ONIONSKIN_TEST_SAMPLES");
const committed = ["engine", "lo-tracked", "word-tracked"].flatMap((dir) => fs.readdirSync(path.join(repoRoot, "test", "fixtures", dir)).filter((f) => /\.(docx|xlsx|pptx)$/.test(f)).map((f) => path.join(repoRoot, "test", "fixtures", dir, f)));
const corpus = haveCorpus() ? fs.readdirSync(CORPUS).filter((f) => /\.(docx|xlsx|pptx)$/.test(f)).map((f) => path.join(CORPUS, f)) : [];
const DRIVERS = { docx: docxOps, pptx: pptxOps, xlsx: xlsxOps };

async function saveUnedited(bytes, format) {
  const d = DRIVERS[format];
  const st = await d.open({ bytes, name: `f.${format}` });
  try {
    return await d.save(st);
  } finally {
    d.close(st);
  }
}
const word = (t) => /[A-Za-z]{3,}/.exec(t)?.[0];
const once = (t, w) => t.indexOf(w) === t.lastIndexOf(w);

/** [{id, mine: ops, agent: ops}]: the person's one edit (none: saved unedited) and the agent's text edit elsewhere */
function cases(bytes, format) {
  if (format === "docx") {
    const ok = readDocxParagraphs(bytes).filter((p) => p.path && !p.protected && word(p.text) && once(p.text, word(p.text)));
    if (ok.length < 2) return [];
    const loc = (p) => ({ target: { body_path: p.path, text_hash: p.hash }, expect: { text_hash: p.hash } });
    const type = (p) => ({ op: "replace_text", ...loc(p), find: word(p.text), replace: `${word(p.text)} typed` });
    const [p, q] = [ok[0], ok[ok.length - 1]];
    const agent = [type(q)];
    return [
      { id: "unedited", mine: null, agent },
      { id: "typed", mine: [type(p)], agent },
      { id: "bold", mine: [{ op: "format_paragraph", ...loc(p), runs: [{ start: 0, end: 3, set: { b: true } }] }], agent },
      { id: "new paragraph", mine: [{ op: "insert_paragraph_after", ...loc(p), text: "A new line the person typed" }], agent },
      ...(p.path.length === 1 ? [{ id: "heading", mine: [{ op: "format_paragraph", ...loc(p), para: { style: "Heading 2" } }], agent }, { id: "bullet", mine: [{ op: "format_paragraph", ...loc(p), para: { list: "bullet", ilvl: 0 } }], agent }] : []),
    ];
  }
  if (format === "pptx") {
    const d = parseDeck(bytes);
    d.ensure();
    const all = d.slides.flatMap((s) => s.shapes.filter((x) => x.kind === "shape" && word(x.text) && once(x.text, word(x.text))).map((x) => ({ s, x })));
    if (all.length < 2) return [];
    const t = ({ s, x }) => ({ target: { slide_id: String(s.id), shape_id: x.id }, expect: { text_hash: x.hash } });
    const type = (u) => ({ op: "replace_text_in_shape", ...t(u), find: word(u.x.text), replace: `${word(u.x.text)} typed`, occurrence: 1 });
    const agent = [type(all[all.length - 1])];
    return [{ id: "unedited", mine: null, agent }, { id: "typed", mine: [type(all[0])], agent }];
  }
  const wb = parseWorkbook(bytes);
  const sheets = wb.sheets.filter((s) => !wb.sheetCells(s).truncated);
  if (sheets.length < 2) return [];
  const a1 = (k) => `${String.fromCharCode(65 + (k % 16384))}${Math.floor(k / 16384) + 1}`;
  const plain = (s) => [...wb.sheetCells(s).cells].filter(([k, c]) => k % 16384 < 26 && c.k !== "formula" && !c.shared);
  const [s, o] = sheets;
  const [k, c] = plain(s)[0] || [];
  const [ko, co] = plain(o)[0] || [];
  if (k === undefined || ko === undefined) return [];
  const set = (sh, key, cell, v) => ({ op: "set_cells", target: { sheet: sh.name, range: a1(key) }, expect: { text_hash: exactHash(cell?.text ?? "") }, values: v });
  const agent = [set(o, ko, co, "agent value")];
  return [{ id: "unedited", mine: null, agent }, { id: "typed", mine: [set(s, k, c, "person value")], agent }, { id: "number", mine: [set(s, k, c, 1234)], agent }];
}

for (const file of [...committed, ...corpus]) {
  const format = path.extname(file).slice(1);
  test(`fixture ${path.relative(repoRoot, file).replace(/^.*fixtures\//, "")}: saved unedited or edited in a supported way, merged with an agent's edit: never refused, nothing handed back as an unsupported change`, { skip: SKIP }, async () => {
    const base = fs.readFileSync(file);
    const list = cases(base, format);
    for (const c of list) {
      const mine = c.mine ? (await runOps({ bytes: base, format, name: `f.${format}`, ops: structuredClone(c.mine) })).bytes : await saveUnedited(base, format);
      const theirs = (await runOps({ bytes: base, format, name: `f.${format}`, ops: structuredClone(c.agent) })).bytes;
      assert.ok(mine && theirs, `${c.id}: the edits apply`);
      const r = await mergeProven({ format, base, mine, theirs, name: `f.${format}` });
      assert.equal(r.refused, undefined, `${c.id}: refused (${r.refused})`);
      const unsupported = r.unplaced.filter((u) => u.as);
      assert.deepEqual(unsupported.map((u) => u.why), [], `${c.id}: the engine's own save was taken for a change of the person's`);
      if (!c.mine) assert.deepEqual(r.unplaced, [], "unedited: nothing to hand back");
    }
  });
}
