// Security pass: parsing cost is linear in the size of a part, the readers have caps, and opening a file is read in a worker so a slow
// or hostile file never stalls the server (outside review: "a 1,666-byte crafted DOCX blocked synchronous document opening for 10.4 s").
// Timing asserts are loose on purpose (the test machine can be heavily loaded): growth from n to 4n is compared, quadratic is 16x.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { test, before, after } from "node:test";
import { tmpdir, buildZip, contentTypes, docxBytes, bodyDoc, xlsxBytes } from "./helpers/zipbuild.js";

const root = tmpdir("da-parse-");
process.env.ONIONSKIN_STATE_DIR = path.join(root, "st");
process.env.ONIONSKIN_LEASE_MS = "600000";
process.env.ONIONSKIN_TICK_MS = "100000";
process.env.ONIONSKIN_NO_SOFFICE = "1";
delete process.env.ONIONSKIN_PYTHON;
const { decodeEntities, walkXml } = await import("../src/xml.js");
const tree = await import("../src/xml-tree.js");
const { readAll, readUnits } = await import("../src/anchors.js");
const { validatePackage } = await import("../src/package.js");
const { MAX_PARAGRAPHS, MAX_ELEMENTS } = await import("../src/docx.js");
const { MAX_SHAPES } = await import("../src/pptx.js");
const { Sessions, HttpError } = await import("../src/session.js");
const { startServer } = await import("../src/server.js");
const { socketPath, ensureStateDir } = await import("../src/paths.js");
ensureStateDir();
let srv;
before(async () => {
  srv = await startServer();
});
after(() => {
  srv.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

// ---- the decoder keeps its exact output --------------------------------------------------------------------------------------------
/** The decoder as it was before the fix (quadratic on a run of "&"), kept as the reference for the output on short strings. */
function referenceDecode(s) {
  const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  if (!s.includes("&")) return s;
  let out = "";
  let i = 0;
  while (i < s.length) {
    const amp = s.indexOf("&", i);
    if (amp < 0) {
      out += s.slice(i);
      break;
    }
    out += s.slice(i, amp);
    const semi = s.indexOf(";", amp);
    if (semi < 0 || semi - amp > 10) {
      out += "&";
      i = amp + 1;
      continue;
    }
    const name = s.slice(amp + 1, semi);
    let rep;
    if (name in ENTITIES) rep = ENTITIES[name];
    else if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      if (Number.isInteger(code) && code > 0 && code <= 0x10ffff) rep = String.fromCodePoint(code);
    }
    if (rep === undefined) {
      out += "&";
      i = amp + 1;
    } else {
      out += rep;
      i = semi + 1;
    }
  }
  return out;
}

test("decodeEntities: same output as before on 200,000 random strings (entities, numeric ones, unknown and over-long names)", () => {
  const A = "&;#xX019amplgtquosAF "; // no letters that spell an Object.prototype name: the reference decoded "&toString;" wrongly
  let seed = 7;
  const rnd = (k) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % k;
  const fills = ["&amp;", "&#65;", "&#x1F600;", "&lt;", "&#0;", "&#x110000;", "&quot;", "&#00000065;", "&#000000065;"];
  for (let it = 0; it < 200_000; it++) {
    const len = rnd(30);
    let s = "";
    for (let k = 0; k < len; k++) s += A[rnd(A.length)];
    if (rnd(3) === 0) s = s.replace(/ /g, () => fills[rnd(fills.length)]);
    assert.equal(decodeEntities(s), referenceDecode(s), JSON.stringify(s));
  }
  assert.equal(decodeEntities("&#00000065;|&#000000065;"), "A|&#000000065;", "a name of 9 characters is read, 10 is not");
  assert.equal(decodeEntities("a &toString; &constructor; &__proto__;"), "a &toString; &constructor; &__proto__;", "only the five XML names");
});

// ---- linear growth -----------------------------------------------------------------------------------------------------------------
// CPU time of this process, in ms (user and system, every thread of it): the full unit suite runs its files in parallel processes, and on a
// loaded Mac wall time counts the time other files took the cores, while CPU time counts only the work. Each file is its own process.
const cpuMs = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
};
const best = (fn, x) => {
  let m = Infinity;
  for (let k = 0; k < 3; k++) {
    const t = cpuMs();
    fn(x);
    m = Math.min(m, cpuMs() - t);
  }
  return m;
};
/** CPU time at n and 4n (best of three): linear grows about 4x, quadratic 16x. Fails early when n alone is already slow. */
function assertLinear(label, fn, make, n) {
  const a = best(fn, make(n));
  assert.ok(a < 1500, `${label}: ${a.toFixed(0)} ms at n=${n}, already far too slow`);
  const b = best(fn, make(4 * n));
  assert.ok(b < 6000, `${label}: ${b.toFixed(0)} ms at 4n`);
  const ratio = b / Math.max(a, 5);
  assert.ok(ratio < 10, `${label}: ${a.toFixed(1)} ms -> ${b.toFixed(1)} ms at 4n (x${ratio.toFixed(1)})`);
}

const SHAPES = {
  "a run of &": (n) => `<w:p><w:r><w:t>${"&".repeat(n)}</w:t></w:r></w:p>`,
  "a run of &#": (n) => `<w:p><w:r><w:t>${"&#".repeat(n / 2)}</w:t></w:r></w:p>`,
  "unterminated entities": (n) => `<w:p><w:r><w:t>${"&amp".repeat(n / 4)}</w:t></w:r></w:p>`,
  "a run of & in an attribute": (n) => `<w:p w:x="${"&".repeat(n)}"/>`,
  "tags with a name and no =": (n) => `<w:p>${"<w:r x/>".repeat(n / 8)}</w:p>`,
  // tags of 500 attributes each (the cap is 512 per tag): parsing attributes stays linear in their number
  "many attributes": (n) => Array.from({ length: Math.ceil(n / 5000) }, () => `<w:p ${Array.from({ length: 500 }, (_, i) => `a${i}="1"`).join(" ")}/>`).join(""),
  "one attribute repeated": (n) => Array.from({ length: Math.ceil(n / 3000) }, () => `<w:p ${'a="1" '.repeat(500)}/>`).join(""),
  "a huge text node": (n) => `<w:p><w:r><w:t>${"a".repeat(n)}</w:t></w:r></w:p>`,
  "many tiny nodes": (n) => `<w:p>${"<w:r/>".repeat(n / 6)}</w:p>`,
  "a long attribute value": (n) => `<w:p w:x="${"x".repeat(n)}"/>`,
  "CDATA sections": (n) => `<w:p><w:r><w:t>${"<![CDATA[x]]>".repeat(n / 13)}</w:t></w:r></w:p>`,
  "comments": (n) => `<w:p>${"<!--x-->".repeat(n / 8)}</w:p>`,
};
const N = 250_000;

test("walkXml and the element tree: linear in the part's size for every shape", () => {
  const walk = (x) => walkXml(x, { onOpen() {}, onText() {}, onClose() {} });
  const lossless = (x) => {
    const r = tree.parse(x);
    for (const el of tree.descendants(r)) {
      tree.attrs(el);
      for (const k of el.kids) tree.textOf(k);
    }
  };
  for (const [label, make] of Object.entries(SHAPES)) {
    assertLinear(`walkXml, ${label}`, walk, (n) => bodyDoc(make(n)), N);
    assertLinear(`xml-tree, ${label}`, lossless, (n) => bodyDoc(make(n)), N);
  }
});

const xlsxWith = (inner) =>
  buildZip({
    "[Content_Types].xml": contentTypes("xlsx"),
    "xl/workbook.xml": '<workbook xmlns:r="r"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels": '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    "xl/worksheets/sheet1.xml": `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is>${inner}</is></c><c r="B1" t="s"><v>0</v></c></row></sheetData></worksheet>`,
    "xl/sharedStrings.xml": `<sst><si>${inner}</si></sst>`,
  });
const pptxWith = (spTree) =>
  buildZip({
    "[Content_Types].xml": contentTypes("pptx"),
    "ppt/presentation.xml": '<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>',
    "ppt/_rels/presentation.xml.rels": '<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/></Relationships>',
    "ppt/slides/slide1.xml": `<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree>${spTree}</p:spTree></p:cSld></p:sld>`,
  });
const READERS = {
  docx: [(x) => readUnits("docx", docxBytes([], {}, x)), (x) => x],
  xlsx: [(b) => { const u = readUnits("xlsx", b); u.wb.sheetCells(u.wb.sheets[0]); }, (x) => xlsxWith(x.replace(/w:/g, ""))],
  pptx: [(b) => readUnits("pptx", b).deck.ensure(), (x) => pptxWith(`<p:sp><p:txBody>${x.replace(/w:/g, "a:")}</p:txBody></p:sp>`)],
};

test("the DOCX, XLSX and PPTX readers: linear on entity runs, attribute runs and tags without =", () => {
  for (const label of ["a run of &", "a run of &#", "unterminated entities", "a run of & in an attribute", "tags with a name and no ="]) {
    for (const [format, [read, wrap]] of Object.entries(READERS)) {
      assertLinear(`${format}, ${label}`, read, (n) => wrap(SHAPES[label](n)), N);
    }
  }
});

test("validatePackage: linear on a run of & in a content type attribute (the reported shape)", () => {
  const pkg = (n) => buildZip({ "[Content_Types].xml": contentTypes("docx").replace("<Default ", `<Default X="${"&".repeat(n)}" `) });
  assertLinear("[Content_Types].xml", (b) => validatePackage(b, "docx"), pkg, N);
});

test("walkXml: a closing tag with nothing open is refused (it let the depth limit drift while callers scanned their stack)", () => {
  assert.throws(() => walkXml("</a>".repeat(5) + "<a>".repeat(5), {}), /closing tag without an open element/);
  assert.throws(() => readUnits("docx", docxBytes([], {}, "</w:x></w:x></w:x><w:p/>")), /closing tag without an open element/);
});

// ---- caps --------------------------------------------------------------------------------------------------------------------------
test("readers: a document past the paragraph, element or shape cap is refused with a plain reason, without reading it all", () => {
  let t = performance.now();
  assert.throws(() => readUnits("docx", docxBytes([], {}, "<w:p/>".repeat(MAX_PARAGRAPHS + 1))), new RegExp(`more than ${MAX_PARAGRAPHS.toLocaleString("en-US")} paragraphs`));
  assert.throws(() => readUnits("docx", docxBytes([], {}, `<w:p>${"<w:r/>".repeat(MAX_ELEMENTS)}</w:p>`)), new RegExp(`more than ${MAX_ELEMENTS.toLocaleString("en-US")} XML elements`));
  assert.throws(() => readUnits("pptx", pptxWith("<p:sp/>".repeat(MAX_SHAPES + 1))).deck.ensure(), new RegExp(`more than ${MAX_SHAPES.toLocaleString("en-US")} shapes`));
  assert.ok(performance.now() - t < 30_000, `${(performance.now() - t).toFixed(0)} ms`);
  // just under the caps still reads
  t = performance.now();
  assert.equal(readUnits("docx", docxBytes([], {}, "<w:p/>".repeat(1000))).paragraphs.length, 1000);
  const deck = readUnits("pptx", pptxWith("<p:sp/>".repeat(1000))).deck;
  deck.ensure();
  assert.equal(deck.slides[0].shapes.length, 1000);
});

// ---- the crafted file and opening off the server's thread --------------------------------------------------------------------------
const RELS = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="x/officeDocument" Target="word/document.xml"/></Relationships>';
/** A DOCX of about 1,666 bytes whose [Content_Types].xml inflates to an attribute of 880,000 "&": the size the review reported. */
function craftedDocx() {
  const ct = contentTypes("docx").replace("<Default ", `<Default X="${"&".repeat(880_000)}" `);
  return buildZip({ "[Content_Types].xml": ct, "_rels/.rels": RELS, "word/document.xml": bodyDoc("<w:p/>") });
}

test("the crafted 1,666-byte DOCX opens promptly through the server's open path and the direct one (was 20 s here, 10.4 s for the review)", async () => {
  const bytes = craftedDocx();
  assert.ok(bytes.length < 2000, `${bytes.length} bytes`);
  const file = path.join(root, "crafted.docx");
  fs.writeFileSync(file, bytes);
  let t = performance.now();
  const s = await srv.sessions.openAsync(file);
  assert.ok(s.key);
  const viaWorker = performance.now() - t;
  t = performance.now();
  new Sessions().open(file);
  const direct = performance.now() - t;
  assert.ok(viaWorker < 8000 && direct < 3000, `worker ${viaWorker.toFixed(0)} ms, direct ${direct.toFixed(0)} ms`);
});

const viaSocket = (method, p, body) =>
  new Promise((resolve, reject) => {
    const r = http.request({ socketPath: socketPath(), method, path: p, headers: body ? { "content-type": "application/json" } : {} }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, at: performance.now(), json: JSON.parse(Buffer.concat(chunks).toString() || "{}") }));
    });
    r.on("error", reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });

test("while a file is being read for opening, the server answers health and another session's status; a read past the time or memory limit is refused", async () => {
  const other = path.join(root, "other.docx");
  fs.writeFileSync(other, docxBytes(["another document"]));
  assert.equal((await viaSocket("POST", "/cli/open", { file: other })).status, 200);
  const slow = path.join(root, "slow.docx");
  fs.writeFileSync(slow, docxBytes(["a document that takes long to read"]));
  // the worker blocks its thread for 2 s, as a slow parse would; the env is read when the worker starts
  process.env.ONIONSKIN_TEST_OPEN_DELAY_MS = "2000";
  try {
    const opening = viaSocket("POST", "/cli/open", { file: slow });
    await new Promise((r) => setTimeout(r, 300)); // the request is in, its worker started
    const health = await viaSocket("GET", "/health");
    const status = await viaSocket("GET", `/cli/status?file=${encodeURIComponent(fs.realpathSync(other))}`);
    const opened = await opening;
    assert.equal(health.status, 200);
    assert.equal(status.status, 200, JSON.stringify(status.json));
    assert.equal(opened.status, 200, JSON.stringify(opened.json));
    assert.ok(health.at < opened.at && status.at < opened.at, "health and status were answered before the slow open finished");
    // past the time limit: refused in plain words, and the server goes on answering
    process.env.ONIONSKIN_OPEN_TIMEOUT_MS = "1000";
    const slower = path.join(root, "slower.docx");
    fs.writeFileSync(slower, docxBytes(["never read in time"]));
    const refused = await viaSocket("POST", "/cli/open", { file: slower });
    assert.equal(refused.status, 400);
    assert.equal(refused.json.code, "open_timeout");
    assert.match(refused.json.error, /could not be opened: reading it took longer than 1 second\. It may be damaged/);
    assert.equal((await viaSocket("GET", "/health")).status, 200);
    // past the memory limit: the worker is stopped by its own heap limit, the server goes on
    delete process.env.ONIONSKIN_TEST_OPEN_DELAY_MS;
    delete process.env.ONIONSKIN_OPEN_TIMEOUT_MS;
    process.env.ONIONSKIN_OPEN_HEAP_MB = "24";
    const heavy = path.join(root, "heavy.docx");
    fs.writeFileSync(heavy, docxBytes([], {}, "<w:p><w:r><w:t>words</w:t></w:r></w:p>".repeat(MAX_PARAGRAPHS - 1))); // within every cap
    const oom = await viaSocket("POST", "/cli/open", { file: heavy });
    assert.equal(oom.status, 400, JSON.stringify(oom.json));
    assert.match(oom.json.error, /could not be opened: reading it needs more memory than Onionskin allows\. It may be damaged/);
    assert.equal((await viaSocket("GET", "/health")).status, 200);
  } finally {
    delete process.env.ONIONSKIN_TEST_OPEN_DELAY_MS;
    delete process.env.ONIONSKIN_OPEN_TIMEOUT_MS;
    delete process.env.ONIONSKIN_OPEN_HEAP_MB;
  }
});

test("opening through the server: a file past a reader's cap or not a package is refused with the reason, nothing is stored", async () => {
  const big = path.join(root, "many-paragraphs.docx");
  fs.writeFileSync(big, docxBytes([], {}, "<w:p/>".repeat(MAX_PARAGRAPHS + 1)));
  const r = await viaSocket("POST", "/cli/open", { file: big });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /could not be opened: this document has more than 50,000 paragraphs/);
  assert.equal([...srv.sessions.map.values()].some((s) => s.file === fs.realpathSync(big)), false, "no session was made for it");
  const bad = path.join(root, "bad.docx");
  fs.writeFileSync(bad, buildZip({ "[Content_Types].xml": "<!DOCTYPE x [<!ENTITY a 'b'>]><Types/>" }));
  const b = await viaSocket("POST", "/cli/open", { file: bad });
  assert.equal(b.status, 400);
  assert.match(b.json.error, /Not a valid \.docx: DTD or entity declarations are not allowed/);
  await assert.rejects(srv.sessions.openAsync(bad), (e) => e instanceof HttpError && e.status === 400);
});

// ---- round 2: lookups inside loops over cells, paragraphs and shapes are linear ----------------------------------------------------
const { unitsOf } = await import("../src/review.js");
const { resolveDurable } = await import("../src/docx.js");
const { compareBytes } = await import("../src/history.js");
const { changedRegions } = await import("../src/anchors.js");
const { xlsxGrid } = await import("./helpers/hostile.js");

test("a review of a sheet with merged ranges: linear in cells and ranges (was a scan of every range per cell: 18 s on the reviewer's file)", () => {
  // n cells and n ranges, then 4n of each (within the 50,000-range cap)
  assertLinear("unitsOf, xlsx cells x merged ranges", (b) => unitsOf("xlsx", b), (n) => xlsxGrid(n, n), 10_000);
});

test("resolving a Word anchor among many identical paragraphs: linear (was quadratic, and a stack overflow past about 120,000)", () => {
  const paras = (n) => readUnits("docx", docxBytes(Array.from({ length: n }, () => "Same words in every paragraph."))).paragraphs;
  // the neighbors agree for every hit (they are the same words), so every hit is weighed by its neighbors
  const assertResolves = (ps) => {
    const d = { paraText: "Same words in every paragraph.", prevHash: ps[0].hash, nextHash: ps[0].hash, dupCount: 3, path: [1] };
    assert.equal(resolveDurable(ps, d).method, "hash");
  };
  assertLinear("resolveDurable, identical paragraphs", assertResolves, paras, 10_000);
});

/** A deck of one slide with n named text shapes; `shift` changes every shape id, so no shape pairs by id. */
const shapesDeck = (n, shift) =>
  pptxWith(Array.from({ length: n }, (_, i) => `<p:sp><p:nvSpPr><p:cNvPr id="${i + 2 + shift}" name="Box ${i}"/></p:nvSpPr><p:txBody><a:p><a:r><a:t>text ${i}</a:t></a:r></a:p></p:txBody></p:sp>`).join(""));
test("history and the changed regions of a slide with many shapes: linear (pairing by name scanned every shape per shape)", () => {
  assertLinear("compareBytes, pptx shapes by name", ([a, b]) => compareBytes("pptx", a, b, { places: false }), (n) => [shapesDeck(n, 0), shapesDeck(n, 100_000)], 4000);
  assertLinear("changedRegions, pptx shapes", ([a, b]) => changedRegions("pptx", a, b), (n) => [shapesDeck(n, 0), shapesDeck(n, 0)], 4000);
});

test("a tag with more than 512 attributes is refused at once, in the walker and in the element tree, with a plain reason", () => {
  const t = performance.now();
  const big = `<w:p><w:r ${Array.from({ length: 3_000_000 / 10 }, (_, i) => `a${i}="1"`).join(" ")}><w:t>x</w:t></w:r></w:p>`;
  assert.throws(() => walkXml(bodyDoc(big), {}), /a tag in this file has more than 512 attributes/);
  assert.throws(() => tree.attrs([...tree.descendants(tree.parse(bodyDoc(big)))].find((e) => e.name === "w:r")), /more than 512 attributes/);
  assert.ok(performance.now() - t < 10_000, `${(performance.now() - t).toFixed(0)} ms`);
  walkXml(bodyDoc(`<w:p ${Array.from({ length: 512 }, (_, i) => `a${i}="1"`).join(" ")}/>`), {}); // 512 still reads
});

const { scanBudget } = await import("../src/text.js");
const { resolveDurableAny } = await import("../src/anchors.js");
test("many comments whose text moved, on a long document: one request's scans stay within its budget (50 took 10 s before)", () => {
  const u = readUnits("docx", docxBytes(Array.from({ length: 20_000 }, (_, i) => `The quarterly report shows revenue grew by eleven percent this year, customer number ${i}.`)));
  const moved = (k) => ({ format: "docx", paraId: "ABCDEF01", path: [k], paraText: `The quarterly report shows revenue fell by nine percent last year, old customers ${k} zz`, quote: "nowhere", prefix: "", suffix: "", prevHash: "x", nextHash: "y", dupCount: 1 });
  const t = performance.now();
  const methods = scanBudget(40_000_000, () => Array.from({ length: 500 }, (_, k) => resolveDurableAny(u, moved(k)).method));
  const ms = performance.now() - t;
  assert.ok(ms < 3000, `500 moved anchors took ${ms.toFixed(0)} ms`);
  assert.ok(methods.every((m) => m === "none"));
  // an edited paragraph is still found by its text while the budget lasts
  const small = readUnits("docx", docxBytes(["Intro words here.", "The budget for the coming year was approved by the board in March.", "Closing remarks."]));
  assert.equal(scanBudget(40_000_000, () => resolveDurableAny(small, { ...moved(1), paraText: "The budget for the coming year was approved by the full board in March." })).method, "fuzzy");
});

test("a one-letter quote repeated through a long paragraph: placing it by its prefix and suffix is linear and inside the request's budget", () => {
  // outside review: 100,000 "a", quote "a", prefix and suffix "aa", offsets 2..3: 10.3 s inside the budget (each occurrence normalized
  // the whole text before and after it)
  const run = (n) => readUnits("docx", docxBytes(["a".repeat(n)])).paragraphs;
  const d = (ps) => ({ format: "docx", paraId: ps[0].paraId, path: ps[0].path, paraText: "a".repeat(2000), quote: "a", prefix: "aa", suffix: "aa", start: 2, end: 3, nth: 2, prevHash: null, nextHash: null, dupCount: 1 });
  assertLinear("resolveDurable, a repeated one-letter quote", (ps) => assert.equal(scanBudget(40_000_000, () => resolveDurable(ps, d(ps))).start, 2), run, 25_000);
  // past the budget, no offset (the anchor is still the paragraph). The budget covers reading the paragraph once (its normalization is
  // counted too), not every occurrence. Without a remembered occurrence: the remembered one is read first and alone, so it is placed
  const ps = run(100_000);
  const r = scanBudget(300_000, () => resolveDurable(ps, { ...d(ps), nth: null }));
  assert.deepEqual([r.method === "none", r.start], [false, null]);
  assert.equal(scanBudget(300_000, () => resolveDurable(ps, d(ps))).start, 2);
});

// ---- round 5: the windows around an occurrence, for any script -------------------------------------------------------------------------
const { cuttable, endsWithNorm, startsWithNorm } = await import("../src/docx.js");
const { normText } = await import("../src/text.js");
test("a window is cut only where the text normalizes the same on both sides: every code point, after every character it composes with", () => {
  // every character that NFD puts after another (a combining mark, or a starter that composes with the one before it) is a place no
  // window may start, after the characters it follows there; a window cut before any other character changes nothing
  const bad = [];
  for (let cp = 0x300; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const d = String.fromCodePoint(cp).normalize("NFD");
    const parts = [...d];
    for (let k = 1; k < parts.length; k++) {
      const head = parts.slice(0, k).join("");
      const text = head + parts.slice(k).join("");
      if (cuttable(text, head.length) && normText(text) !== normText(head) + normText(text.slice(head.length))) bad.push(cp.toString(16));
    }
  }
  assert.deepEqual(bad.slice(0, 10), []);
});

test("endsWithNorm and startsWithNorm answer as the whole text does, on random text of CJK, Hangul jamo, combining marks and decomposed pairs", () => {
  const A = ["a", " ", "\u00e9", "e\u0301", "\u0301", "\u0316", "\u4e2d", "\u6587", "\u1100", "\u1161", "\u11a8", "\uac00", "\ud834\udd5e", "\u0915\u093c", "\u3099", "\u304b", "\u{16d63}", "\u{16d67}", "\t"];
  const r = rng(11);
  for (let k = 0; k < 20_000; k++) {
    const parts = Array.from({ length: 1 + Math.floor(r() * 60) }, () => A[Math.floor(r() * A.length)]);
    const text = parts.join("");
    const cut = parts.slice(0, Math.floor(r() * (parts.length + 1))).join("").length; // at a character, as occurrences are
    const want = normText(text.slice(0, cut));
    const pre = want.slice(-(1 + Math.floor(r() * 6)));
    const sufWant = normText(text.slice(cut));
    const suf = sufWant.slice(0, 1 + Math.floor(r() * 6));
    // give or take one space where a window was cut (the windows do not see the space trimmed at their edge)
    const ok = (got, a, b) => got === a || got === b;
    assert.ok(ok(endsWithNorm(text, cut, pre), want.endsWith(pre), want.endsWith(pre.trimStart())), JSON.stringify({ text, cut, pre }));
    assert.ok(ok(startsWithNorm(text, cut, suf), sufWant.startsWith(suf), sufWant.startsWith(suf.trimEnd())), JSON.stringify({ text, cut, suf }));
  }
});

test("a repeated CJK quote placed by its prefix, suffix and remembered occurrence: well under a second (3.65 s before), and the budget counts every character read", () => {
  // outside review: "中" x 30,000, quote "中", prefix and suffix of 40, nth 15,000: no character below U+0300, so every window grew to the
  // whole paragraph. The same with 300,000 "a" and nth 150,000 lost its offsets under the server's budget
  for (const [ch, n] of [["\u4e2d", 30_000], ["a", 300_000]]) {
    const ps = readUnits("docx", docxBytes([ch.repeat(n)])).paragraphs;
    const d = { format: "docx", paraId: ps[0].paraId, path: ps[0].path, paraText: ch.repeat(2000), quote: ch, prefix: ch.repeat(40), suffix: ch.repeat(40), nth: n / 2, prevHash: null, nextHash: null, dupCount: 1 };
    const ms = best(() => assert.equal(scanBudget(40_000_000, () => resolveDurable(ps, d)).start, n / 2));
    assert.ok(ms < 300, `${ch}: ${ms.toFixed(0)} ms`);
  }
  // combining marks have no place to cut at all: the windows read the whole run, within the budget, and stop without an offset past it
  const marks = readUnits("docx", docxBytes([`a${"\u0301".repeat(2_000)}`])).paragraphs;
  const dm = { format: "docx", paraId: marks[0].paraId, path: marks[0].path, paraText: "", quote: "\u0301", prefix: "\u0301".repeat(40), suffix: "\u0301", nth: null, prevHash: null, nextHash: null, dupCount: 1 };
  const t = cpuMs();
  const r = scanBudget(2_000_000, () => resolveDurable(marks, dm));
  assert.ok(cpuMs() - t < 1000, `${(cpuMs() - t).toFixed(0)} ms`);
  assert.deepEqual([r.method === "none", r.start], [false, null]);
});

// ---- round 3: text a workbook's cells take from shared strings ---------------------------------------------------------------------
const { CapError } = await import("../src/xml.js");
const { outlineOf } = await import("../src/review.js");
const { xlsxShared } = await import("./helpers/hostile.js");
test("cells pointing at one long shared string: the work is bounded, past 32 million characters the workbook is refused (was cells x length)", () => {
  // the reviewer's file: 249,000 cells, one shared string of 20,000 characters, 517 KB, within every other cap: 4 to 6 s per path
  const t = performance.now();
  assert.throws(() => readAll(readUnits("xlsx", xlsxShared(249_000, 20_000))), (e) => e instanceof CapError && /^this workbook has more than 32,000,000 characters of text in its cells, more than Onionskin can read\. Split it into smaller workbooks and open those$/.test(e.message));
  assert.ok(performance.now() - t < 5000, `refused in ${(performance.now() - t).toFixed(0)} ms`);
  // the same 249,000 cells showing a string of 32 characters (read) and of 20,000 (625 times the text, refused): the work no longer
  // grows with the string (it was cells x length: x16 and 4.4 s here before the cap)
  const outline = (b) => {
    try {
      const u = readAll(readUnits("xlsx", b));
      unitsOf("xlsx", b, u);
      outlineOf("xlsx", b, 2000, u);
    } catch (err) {
      if (!(err instanceof CapError)) throw err;
    }
  };
  const a = best(outline, xlsxShared(249_000, 32));
  const b = best(outline, xlsxShared(249_000, 20_000));
  assert.ok(a < 3000 && b < 3000 && b / a < 3, `string of 32: ${a.toFixed(0)} ms, of 20,000: ${b.toFixed(0)} ms`);
  // at the cap: 249,000 cells of 128 characters (31,872,000) still read
  const { wb } = readAll(readUnits("xlsx", xlsxShared(249_000, 128)));
  assert.equal(wb.sheetCells(wb.sheets[0]).cells.size, 249_000);
});

const { previewAll, runOps } = await import("../src/ops/run.js");
const { mergeDocx } = await import("../src/merge.js");
test("a quick change's preview and the merge of a Word file of many equal paragraphs: linear (5.6 s and 6.3 s at 50,000 before)", async () => {
  // both open the file through src/ops/docx.js, which grouped paragraphs by text with a copy of the group per paragraph
  const bold = { op: "format_all", scope: "headings", set: { bold: true } }; // "make the headings bold" (src/quick.js)
  const same = (n, k = -1, w = "") => docxBytes([], {}, Array.from({ length: n }, (_, i) => `<w:p><w:r><w:t>${i === k ? w : "hello world"}</w:t></w:r></w:p>`).join(""));
  const timed = async (fn) => {
    let m = Infinity;
    for (let k = 0; k < 3; k++) {
      const t = cpuMs();
      await fn();
      m = Math.min(m, cpuMs() - t);
    }
    return m;
  };
  for (const [label, run] of [
    ["quick preview", (n) => { const b = same(n); return () => previewAll(b, "docx", bold); }],
    ["merge", (n) => { const [base, theirs, mine] = [same(n), same(n, 0, "Changed by the agent"), same(n, n - 1, "Changed by me")]; return () => mergeDocx({ base, mine, theirs, name: "f.docx", runOps }); }],
  ]) {
    const a = await timed(run(10_000));
    const b = await timed(run(40_000));
    assert.ok(b < 6000 && b / Math.max(a, 20) < 10, `${label}: ${a.toFixed(0)} ms -> ${b.toFixed(0)} ms at 4n`);
  }
});

const { buildDurable } = await import("../src/anchors.js");
const { xlsxColumn } = await import("./helpers/hostile.js");
test("resolving a cell among many equal cells under a long column header: the header is read once, not once per equal cell (4 s before)", () => {
  // a comment on A2 of a column of 62,000 equal numbers under a header of 2,000 then 20,000 characters; A2 then changes
  const resolveWith = (len) => {
    const d = buildDurable(readAll(readUnits("xlsx", xlsxColumn(62_000, len))), { location: { sheetIndex: 0, sheetName: "S1", range: "A2" } });
    const after = readAll(readUnits("xlsx", xlsxColumn(62_000, len, { a2: "2" })));
    return () => assert.equal(scanBudget(40_000_000, () => resolveDurableAny(after, d)).method, "position");
  };
  const a = best((f) => f(), resolveWith(2_000));
  const b = best((f) => f(), resolveWith(20_000));
  assert.ok(b < 3000 && b / Math.max(a, 20) < 3, `header of 2,000: ${a.toFixed(0)} ms, of 20,000: ${b.toFixed(0)} ms`);
});

test("a sheet name longer than 255 characters is refused with a plain reason (a 100,000-character name made each outline 1.8 s)", () => {
  assert.throws(() => readUnits("xlsx", xlsxColumn(3, 1, { name: "n".repeat(100_000) })), (e) => e instanceof CapError && /^a sheet in this workbook has a name longer than 255 characters, more than Onionskin can read\. Rename it in Excel, which allows 31, and open it again$/.test(e.message));
  assert.equal(readUnits("xlsx", xlsxColumn(3, 1, { name: "n".repeat(255) })).wb.sheets[0].name.length, 255);
});

// ---- one pass over a paragraph's runs for every match (round 4) ---------------------------------------------------------------------
// The one-pass helpers against the per-match ones they replace (kept as the reference): the same runs on random paragraphs, then linear.
const runsLib = await import("../src/ops/runs.js");
const pptxOps = await import("../src/ops/pptx.js");
function rng(seed) {
  let x = seed >>> 0;
  return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
/** A random paragraph of engine runs: text (some empty), a tracked deletion now and then, an object now and then (`objects`). */
function randomRuns(r, { objects = true } = {}) {
  const n = 1 + Math.floor(r() * 8);
  return Array.from({ length: n }, (_, i) => {
    const k = r();
    if (objects && k < 0.08) return { t: "img", id: i };
    const text = Array.from({ length: Math.floor(r() * 6) }, () => "ab "[Math.floor(r() * 3)]).join("");
    return k < 0.16 ? { t: "text", text, tc: { k: "del" } } : { t: "text", text, s: { b: k < 0.5 } };
  });
}
const outcome = (fn) => {
  try {
    return fn();
  } catch (err) {
    return err instanceof RangeError ? "RangeError" : `${err}`;
  }
};
test("replaceRanges, splitForRanges and replaceAllInRuns: the same runs as one match at a time, on 20,000 random paragraphs", () => {
  const r = rng(7);
  for (let k = 0; k < 20_000; k++) {
    const runs = randomRuns(r);
    const { text } = runsLib.layout(runs);
    const find = ["a", "ab", "b a", " "][k % 4];
    const starts = runsLib.findAll(text, find);
    const rep = ["", "X", "yy"][k % 3];
    const oneByOne = () => [...starts].sort((a, b) => b - a).reduce((acc, s) => runsLib.replaceRange(acc, s, s + find.length, rep), runs);
    if (starts.length) assert.deepEqual(outcome(() => runsLib.replaceRanges(runs, starts, find.length, rep)), outcome(oneByOne), JSON.stringify({ runs, find, rep }));
    const ranges = starts.map((s) => ({ start: s, end: s + find.length }));
    const patches = ranges.map((_, j) => ({ b: j % 2 === 0, i: true }));
    const split = runsLib.splitForRanges(runs, ranges);
    const seq = [...ranges].reverse().reduce((acc, g, j) => {
      const sp = runsLib.splitForRange(acc, g.start, g.end);
      return runsLib.applySet(sp.runs, sp.covered, patches[ranges.length - 1 - j]);
    }, runs);
    assert.deepEqual(runsLib.applySets(split.runs, split.covered, patches), seq, JSON.stringify({ runs, find }));
    // a slide's runs: plain text and fields, no tracked deletions
    const slide = randomRuns(r, { objects: false }).map((x, i) => (x.tc ? { text: x.text, src: i, fld: true } : { text: x.text, src: i }));
    const all = slide.map((x) => x.text).join("");
    const at = runsLib.findAll(all, find);
    const seqSlide = () => [...at].sort((a, b) => b - a).reduce((acc, s) => pptxOps.replaceInRuns(acc, s, s + find.length, rep), slide);
    if (at.length) assert.deepEqual(outcome(() => pptxOps.replaceAllInRuns(slide, at, find.length, rep)), outcome(seqSlide), JSON.stringify({ slide, find, rep }));
  }
});

test("replacing or formatting every match in one paragraph of many runs: linear in the runs (a pass over the runs per match before)", () => {
  const para = (n) => Array.from({ length: n }, (_, i) => ({ t: "text", text: "Acme ", s: { b: i % 2 === 0 } }));
  const work = (n) => {
    const runs = para(n);
    const starts = runsLib.findAll(runsLib.layout(runs).text, "Acme");
    const slide = runs.map((x, i) => ({ text: x.text, src: i }));
    return () => {
      runsLib.replaceRanges(runs, starts, 4, "Initech");
      const sp = runsLib.splitForRanges(runs, starts.map((s) => ({ start: s, end: s + 4 })));
      runsLib.applySet(sp.runs, sp.covered.flat(), { b: true });
      pptxOps.replaceAllInRuns(slide, starts, 4, "Initech");
    };
  };
  const a = best((f) => f(), work(25_000));
  const b = best((f) => f(), work(100_000));
  assert.ok(b < 3000 && b / Math.max(a, 20) < 10, `${a.toFixed(0)} ms -> ${b.toFixed(0)} ms at 4n`);
});

test("a reader that failed once fails again: a deck, a workbook's shared strings and its number formats past a cap are never accepted on a retry", async () => {
  // outside review: a slide of 8,000,001 characters was refused, then the same bytes passed the write check (the deck was marked read
  // before the reading finished, and the cached reading was reused)
  const { readChecked } = await import("../src/session.js");
  const { parseDeck } = await import("../src/pptx.js");
  const deck = pptxWith(`<p:sp><p:txBody><a:p><a:r><a:t>${"x".repeat(8_000_001)}</a:t></a:r></a:p></p:txBody></p:sp>`);
  const over = (e) => e instanceof CapError;
  for (let k = 0; k < 3; k++) assert.throws(() => readChecked("pptx", deck), over, `write check, try ${k + 1}`);
  const d = parseDeck(deck);
  for (let k = 0; k < 2; k++) assert.throws(() => d.ensure(), over, `ensure, try ${k + 1}`);
  // a tag of 513 attributes in the shared strings and in the styles: refused at every reading of them
  const tag = `<x ${Array.from({ length: 513 }, (_, i) => `a${i}="1"`).join(" ")}/>`;
  const shared = buildZip({
    "[Content_Types].xml": contentTypes("xlsx"),
    "xl/workbook.xml": '<workbook xmlns:r="r"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels": '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    "xl/worksheets/sheet1.xml": '<worksheet><sheetData><row r="1"><c r="A1" t="s" s="1"><v>0</v></c></row></sheetData></worksheet>',
    "xl/sharedStrings.xml": `<sst><si><t>first</t></si>${tag}</sst>`,
    "xl/styles.xml": `<styleSheet><numFmts><numFmt numFmtId="164" formatCode="0.0"/></numFmts><cellXfs><xf numFmtId="164"/>${tag}</cellXfs></styleSheet>`,
  });
  for (let k = 0; k < 2; k++) assert.throws(() => readChecked("xlsx", shared), over, `xlsx write check, try ${k + 1}`);
  const wb = readUnits("xlsx", shared).wb;
  for (let k = 0; k < 2; k++) assert.throws(() => wb.sheetCells(wb.sheets[0]), over, `shared strings, try ${k + 1}`);
  for (let k = 0; k < 2; k++) assert.throws(() => wb.numberFormat(0), over, `number formats, try ${k + 1}`);
});

// ---- round 5: merge planning (the at-the-cap versions are in e2e/stall-cap.e2e.test.js) -----------------------------------------------
const { planPptxMerge, MAX_LINE_OPS } = await import("../src/merge-pptx.js");
const { planXlsxMerge } = await import("../src/merge-xlsx.js");
const { parseDeck } = await import("../src/pptx.js");
const { parseWorkbook } = await import("../src/xlsx.js");
const bestAsync = async (fn) => {
  let m = Infinity;
  for (let k = 0; k < 3; k++) {
    const t = cpuMs();
    await fn();
    m = Math.min(m, cpuMs() - t);
  }
  return m;
};

test("a Word merge of 1,000 paragraphs of 2,000 \"a\" with one letter typed in each: the find texts share one budget (5 s at 3,900 before)", async () => {
  const pid8 = (i) => (0x10000000 + i).toString(16).toUpperCase();
  const a = "a".repeat(2000);
  const doc = (f) => docxBytes(Array.from({ length: 1000 }, (_, i) => ({ text: f(i), paraId: pid8(i) })));
  const [base, mine, theirs] = [doc(() => a), doc(() => `${a.slice(0, 1000)}b${a.slice(1001)}`), doc((i) => (i === 0 ? `c${a.slice(1)}` : a))];
  let r;
  const ms = await bestAsync(async () => (r = await mergeDocx({ base, mine, theirs, name: "f.docx", runOps })));
  assert.equal(r.merged, 999);
  assert.ok(ms < 800, `${ms.toFixed(0)} ms`);
});

test("a PowerPoint merge of one shape of many changed lines: planned in one pass and carried as the shape's text (4 s to plan 25,000 before, hours to apply)", () => {
  const deck = (n, t) => {
    const d = parseDeck(pptxWith(`<p:sp><p:nvSpPr><p:cNvPr id="2" name="T"/></p:nvSpPr><p:txBody>${Array.from({ length: n }, (_, i) => `<a:p><a:r><a:t>${t(i)}</a:t></a:r></a:p>`).join("")}</p:txBody></p:sp>`));
    d.ensure();
    return d;
  };
  const plan = (n, k) => {
    const [b, m] = [deck(n, () => "a"), deck(n, (i) => (i % k === 0 ? "b" : "a"))];
    return () => planPptxMerge(b, m, b, []);
  };
  const every = plan(25_000, 1)();
  assert.deepEqual(every.items[0].ops.map((o) => [o.op, o.paragraphs.length]), [["set_shape_text", 25_000]], "one op for the whole shape");
  const few = plan(400, 40)().items[0].ops;
  assert.deepEqual(few.map((o) => [o.op, o.occurrence]), Array.from({ length: 10 }, (_, j) => ["replace_text_in_shape", 400 - 40 * (j + 1) + 1]), "a few lines: one replace each, counted right");
  assert.equal(MAX_LINE_OPS, 100);
  const x = best((f) => f(), plan(6_000, 1));
  const y = best((f) => f(), plan(24_000, 1));
  assert.ok(y < 2000 && y / Math.max(x, 20) < 10, `${x.toFixed(0)} ms -> ${y.toFixed(0)} ms at 4n`);
});

test("an Excel merge plan reads each sheet's rows and columns once: under 6 times the reading of one version (8 times before, 11 s at 1,000,000 cells)", () => {
  const cells = {};
  for (let r = 0; r < 12_500; r++) for (let c = 0; c < 20; c++) cells[`${String.fromCharCode(65 + c)}${r + 1}`] = r * 20 + c;
  const bytes = [xlsxBytes({ S: cells }), xlsxBytes({ S: { ...cells, A1: 1000001 } }), xlsxBytes({ S: { ...cells, A2: 1000002 } })];
  let read = Infinity;
  let planned = Infinity;
  let plan;
  for (let k = 0; k < 3; k++) {
    const t = cpuMs();
    const wbs = bytes.map((b) => {
      const wb = parseWorkbook(b);
      wb.sheetCells(wb.sheets[0]);
      return wb;
    });
    read = Math.min(read, (cpuMs() - t) / 3);
    const u = cpuMs();
    plan = planXlsxMerge(wbs[0], wbs[1], wbs[2], [], { of: () => "stable" });
    planned = Math.min(planned, cpuMs() - u);
  }
  assert.deepEqual([plan.items.map((x) => x.label), plan.unplaced], [["S!A1"], []]);
  assert.ok(planned < 6 * read, `plan ${planned.toFixed(0)} ms, one reading ${read.toFixed(0)} ms (x${(planned / read).toFixed(1)})`);
});

test("placing 50 comments on one text box of 2 million characters normalizes its text once (each comment normalized all of it before: 5.6 s at 8 million)", () => {
  const u = readAll(readUnits("pptx", pptxWith(`<p:sp><p:nvSpPr><p:cNvPr id="2" name="T"/></p:nvSpPr><p:txBody><a:p><a:r><a:t>${"word ".repeat(400_000)}</a:t></a:r></a:p></p:txBody></p:sp>`)));
  const sl = u.deck.slides[0];
  const d = { format: "pptx", slideId: sl.id, slidePart: sl.part, titleHash: sl.titleHash, shapeId: 2, ordinal: 0, shapeName: "T", textHash: "x", quote: "nowhere" };
  const ms = best(() => scanBudget(40_000_000, () => Array.from({ length: 50 }, () => resolveDurableAny(u, d))));
  assert.ok(ms < 300, `${ms.toFixed(0)} ms`);
  assert.equal(resolveDurableAny(u, d).text, "word ".repeat(40));
});

test("50 comments on one paragraph of 2 million characters with a one-letter quote: every scan is spent from the request's budget (13 s by id and 56 s by neighbors at 8 million before)", () => {
  const big = "ab cd ".repeat(333_000);
  const u = readUnits("docx", docxBytes([{ text: "Before.", paraId: "00000001" }, { text: big, paraId: "00000002" }, { text: "After.", paraId: "00000003" }]));
  const [p0, p1, p2] = u.paragraphs;
  const base = { format: "docx", path: p1.path, quote: "a", prefix: "cd ", suffix: "b cd", nth: 1000, dupCount: 1 };
  for (const d of [{ ...base, paraId: "00000002", paraText: big.slice(0, 2000) }, { ...base, paraId: null, paraText: "something else entirely ".repeat(20), prevHash: p0.hash, nextHash: p2.hash }]) {
    let first;
    const ms = best(() => (first = scanBudget(40_000_000, () => Array.from({ length: 50 }, () => resolveDurableAny(u, d)))[0]));
    assert.ok(ms < 1500, `${d.paraId ? "by id" : "by neighbors"}: ${ms.toFixed(0)} ms`);
    assert.deepEqual([first.ordinal, first.start, first.nth, first.text.length], [1, 6000, 1000, 2000], "the first is placed, offsets and its text too");
  }
});
