import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";
import { docxBytes } from "./helpers/zipbuild.js";
import { MAX_MARKS, nfc } from "../src/nfc.js";
import { exactHash, normText, scanBudget, textHash } from "../src/text.js";
import { untrusted, userText } from "../src/sanitize.js";
import { readDocxParagraphs } from "../src/docx.js";
import { buildDurable, readAll, readUnits, resolveDurableAny } from "../src/anchors.js";
import { outlineOf, unitsOf } from "../src/review.js";
import { diffRaw, tokenize } from "../src/diff.js";
import { checkRewrite } from "../src/rewrite-check.js";
import { planDocxMerge } from "../src/merge.js";
import { locateChanges, survivesSanitizer } from "../web/src/writein.js";

// Unicode normalization stays linear in the text (src/nfc.js). An outside review: one Word paragraph of "a" and 120,000 combining marks
// (an 847-byte package) held the server's thread for 4 seconds while it was read, 13.65 s at 200,000 marks; resolving a comment on it
// by its paragraph id, 3.29 s. String.prototype.normalize sorts a run of marks in time quadratic in its length.

// ---- ordinary text is normalized exactly as before -----------------------------------------------------------------------------
const SAMPLES = {
  vietnamese: "Tiếng Việt có dấu: Nguyễn Thị Minh Khai, đường phố, người ở. Tiếng Việt decomposed: Tiếng Việt",
  arabic: "بِسْمِ ٱللَّٰهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ، اَلْحَمْدُ لِلَّٰهِ رَبِّ ٱلْعَٰلَمِينَ",
  hebrew: "בְּרֵאשִׁית בָּרָא אֱלֹהִים אֵת הַשָּׁמַיִם וְאֵת הָאָרֶץ",
  devanagari: "हिन्दी में क़लम, ज़रूरी, फ़िल्म और संस्कृत: क्षत्रिय, श्रीमान्",
  emoji: "Family 👨‍👩‍👧‍👦, waves 👋🏽 👋🏿, flags 🇺🇸 🏳️‍🌈, keycap 1️⃣, heart ❤️‍🔥",
  zalgo: "Z̴̛͈̺̈́a̷̧͉̓͂l̸̡̛̮̈́g̶̢̛͖o̵̺͗ ̷t̴̞̿e̷̡̓x̶̹̃t̸͙̀",
  "zalgo at the limit": `a${"̖̗̀́̕".repeat(6)} b`,
  "compatibility forms": "ﬁ ﬀ ① ² Ⅻ ｶﾞｷﾞ ㌀ Å Ω é Å",
  mixed: "Café́ naïve résumé coöperate, ˆ^ ́ ́ alone at the start",
};
const old = (s) => String(s ?? "").normalize("NFC").replace(/\s+/g, " ").trim(); // normText before src/nfc.js
const sha16 = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);

test("text in every script, emoji sequences and Zalgo text within the limit normalize exactly as plain normalize does; hashes do not change", () => {
  for (const [name, s] of Object.entries(SAMPLES)) {
    for (const form of ["NFC", "NFD", "NFKC", "NFKD"]) assert.equal(nfc(s, form), s.normalize(form), `${name} ${form}`);
    assert.equal(normText(s), old(s), name);
    assert.equal(textHash(s), sha16(old(s)), `${name}: a hash stored by an earlier version still matches`);
    assert.equal(exactHash(s), sha16(s.normalize("NFC")), name);
  }
  assert.equal(nfc(null), "");
  assert.equal(nfc(undefined), "");
  assert.equal(nfc(`x${"́".repeat(MAX_MARKS)}`), `x${"́".repeat(MAX_MARKS)}`.normalize("NFC"), "a run of exactly 30 marks is normalized whole");
});

test("a run past the limit is left as it is and the text around it normalized: deterministic, the same again when normalized again", () => {
  const run = "̀̕".repeat(MAX_MARKS); // 60 marks, whose order normalize would change
  const s = `Café a${run} é tail`;
  assert.equal(nfc(s), `Café a${run} é tail`);
  assert.equal(nfc(nfc(s)), nfc(s));
  assert.equal(nfc(s, "NFKC"), `Café a${run} é tail`);
  const astral = "\u{1D167}".repeat(20); // musical combining marks outside the BMP: 20 marks, 40 UTF-16 units: under the limit
  assert.equal(nfc(`a${astral}`), `a${astral}`.normalize("NFC"));
});

// ---- linear time ------------------------------------------------------------------------------------------------------------------
// CPU time of this process (best of three), as test/parse-limits.test.js measures it: a loaded Mac does not change it.
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
/** CPU time at n and 4n: linear grows about 4x, quadratic 16x. Fails early when n alone is already slow. */
function assertLinear(label, fn, make, n) {
  const a = best(fn, make(n));
  assert.ok(a < 1500, `${label}: ${a.toFixed(0)} ms at n=${n}, already far too slow`);
  const b = best(fn, make(4 * n));
  assert.ok(b < 6000, `${label}: ${b.toFixed(0)} ms at 4n`);
  const ratio = b / Math.max(a, 5);
  assert.ok(ratio < 10, `${label}: ${a.toFixed(1)} ms -> ${b.toFixed(1)} ms at 4n (x${ratio.toFixed(1)})`);
}
const N = 12_000; // pairs of marks: 24,000 marks at n (0.5 s through plain normalize), 96,000 at 4n
const zalgo = (n) => `a${"̀̕".repeat(n)}`;
const doc = (n) => docxBytes([{ text: zalgo(n), paraId: "ABCD1234" }, "A second paragraph."]);

test("normalizing, hashing and sanitizing a run of combining marks is linear", () => {
  assertLinear("nfc", (s) => nfc(s), zalgo, N);
  assertLinear("nfc NFKC", (s) => nfc(s, "NFKC"), zalgo, N);
  assertLinear("textHash", textHash, zalgo, N);
  assertLinear("exactHash", exactHash, zalgo, N);
  assertLinear("untrusted", (s) => untrusted(s, Number.MAX_SAFE_INTEGER), zalgo, N);
  assertLinear("userText", (s) => userText(s, Number.MAX_SAFE_INTEGER), zalgo, N);
});

// U+FF9E and U+FF9F are not of category M, but under NFKC and NFKD they become the combining marks U+3099 and U+309A: a run of them
// (with a mark between, so no pair composes) built a combining sequence the run pattern never saw, and sorting it was quadratic.
const halfwidth = (n) => "\uFF9E\u0315".repeat(n);
test("compatibility forms: a long run of characters that decompose to combining marks is linear too, and a short one normalizes as before", () => {
  assertLinear("nfc NFKC, halfwidth sound marks", (s) => nfc(s, "NFKC"), halfwidth, N);
  assertLinear("nfc NFKD, halfwidth sound marks", (s) => nfc(s, "NFKD"), halfwidth, N);
  assertLinear("textHash of the same", textHash, (n) => `a${"\uFF9F\u0315".repeat(n)}`, N);
  for (const form of ["NFC", "NFD", "NFKC", "NFKD"]) {
    for (const s of ["ｶﾞ".repeat(10), "ﾊﾟﾊﾞ".repeat(5), `x${halfwidth(10)}y`, "ﾞ", "ﾟ̕ﾞ"]) assert.equal(nfc(s, form), s.normalize(form), `${form} ${JSON.stringify(s)}`);
  }
  // the run is bounded the same way: past MAX_MARKS it is left as it is, the text around it is normalized
  const long = halfwidth(MAX_MARKS);
  assert.equal(nfc(`ｶ${long}ｷ`, "NFKC"), `カ${long}キ`);
});

test("no other character is a non-starter in disguise: every code point whose compatibility decomposition starts with a mark is in the run pattern or sorts nothing", () => {
  const M = /\p{M}/u;
  const found = [];
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const ch = String.fromCodePoint(cp);
    if (M.test(ch)) continue;
    const d = ch.normalize("NFKD");
    if (d !== ch && M.test(String.fromCodePoint(d.codePointAt(0)))) found.push(cp);
  }
  // U+0E33 and U+0EB3 (Thai and Lao sara am) start with a mark of combining class 0, which no sort moves; U+FF9E and U+FF9F are class 8
  assert.deepEqual(found.map((c) => c.toString(16)), ["e33", "eb3", "ff9e", "ff9f"]);
  const cc0 = (cp) => { const d = String.fromCodePoint(cp).normalize("NFKD"); return d.length === 2 && d.normalize("NFKD") === d && (`\u0301${d[0]}\u0323`).normalize("NFD") === `\u0301${d[0]}\u0323`; };
  assert.ok(cc0(0xe33) && cc0(0xeb3), "the first character of their decomposition does not reorder");
});

test("reading the paragraph is linear: the package read, its units read whole (as a Send is checked), review units and the outline", () => {
  assertLinear("readDocxParagraphs", (b) => readDocxParagraphs(b), doc, N);
  assertLinear("readDocxParagraphs detail", (b) => readDocxParagraphs(b, { detail: true }), doc, N);
  assertLinear("readAll(readUnits)", (b) => readAll(readUnits("docx", b)), doc, N);
  assertLinear("review units", (b) => unitsOf("docx", b), doc, N);
  assertLinear("outline", (b) => outlineOf("docx", b), doc, N);
});

test("a comment on the paragraph by its id with an empty quote: building and resolving its anchor is linear", () => {
  const anchor = (b) => {
    const units = readUnits("docx", b);
    return { units, d: scanBudget(40_000_000, () => buildDurable(units, { location: { blockPath: [0], paraId: "ABCD1234", start: 0, end: 0 }, quote: "", prefix: "", suffix: "" })) };
  };
  assertLinear("build and resolve", (b) => {
    const { units, d } = anchor(b);
    assert.ok(d, "the anchor is built");
    assert.equal(scanBudget(40_000_000, () => resolveDurableAny(units, d)).method, "id");
  }, doc, N);
});

test("planning a merge around the paragraph is linear", () => {
  const read = (b) => readDocxParagraphs(b, { detail: true });
  assertLinear("planDocxMerge", (n) => planDocxMerge(read(doc(n)), read(docxBytes([{ text: zalgo(n), paraId: "ABCD1234" }, "A second paragraph, edited."])), read(doc(n))), (n) => n, N);
});

test("the page: placing a change in place over the paragraph is linear (the browser normalizes with the same function)", () => {
  const para = (n) => `${zalgo(n)} closing words here`;
  assertLinear("locateChanges", (t) => locateChanges(t, [{ needle: "closing", insStart: 0, insEnd: 7 }], textHash(t)), para, N);
  assertLinear("survivesSanitizer", survivesSanitizer, para, N);
});

test("round 9: a run of 7.9 million marks (\"a\" + \"\\u0315\\u0300\" x 3,949,999, within the limits) is left as it is, without overflowing the stack (Send answered 422 \"Maximum call stack size exceeded\")", () => {
  const s = `a${"̀̕".repeat(3_949_999)}`;
  assert.equal(nfc(s), s);
  assert.equal(nfc(`é${s}x́`), `é${s}x́`.slice(0, 1) + s + "x́".normalize("NFC"));
  const t = performance.now();
  const u = readUnits("docx", docxBytes([s, "Next."]));
  const d = scanBudget(40_000_000, () => buildDurable(u, { location: { blockPath: [1] }, quote: "Next", prefix: "", suffix: "" }));
  assert.ok(d, "an anchor next to it is made");
  assert.ok(performance.now() - t < 20_000);
  // runs split across the scan's chunks are still one run: 31 marks after 4,096 others are a run of 4,127, left as they are
  const long = `o${"́".repeat(4096 + 31)}`;
  assert.equal(nfc(long), long);
  assert.equal(nfc(`o${"́".repeat(MAX_MARKS)}`), `o${"́".repeat(MAX_MARKS)}`.normalize("NFC"));
  // found while testing: the diff (History, the tracked-changes copy) and the rewrite check overflowed on the same run
  assert.ok(tokenize(s).length > 1);
  assert.ok(diffRaw(s, `${s} b`).length > 0);
  assert.doesNotThrow(() => checkRewrite("grammar", s, `${s} b`));
});
