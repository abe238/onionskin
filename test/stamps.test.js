import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// Everything here runs against a temp state dir; the real ~/.onionskin is never touched.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "os-stamp-"));
process.env.ONIONSKIN_STATE_DIR = path.join(root, "st");
const { readStamps, writeStamps } = await import("../src/stamps.js");
const { BUILT_IN, LANGUAGES, stampText } = await import("../web/src/stamps.js");
after(() => fs.rmSync(root, { recursive: true, force: true }));
const file = () => path.join(process.env.ONIONSKIN_STATE_DIR, "stamps.json");
const refused = (list) => assert.throws(() => writeStamps(list), (e) => e.status === 400);

test("a stored list reads back, and the file is private (0600)", () => {
  assert.deepEqual(readStamps(), [], "no file reads as an empty list");
  const stored = writeStamps([{ label: "Formal", words: "Make this more formal." }]);
  assert.deepEqual(stored, [{ label: "Formal", words: "Make this more formal." }]);
  assert.deepEqual(readStamps(), stored);
  assert.equal(fs.statSync(file()).mode & 0o777, 0o600);
});

test("a list that breaks a cap is refused whole (400) and the stored file does not change", () => {
  const before = fs.readFileSync(file(), "utf8");
  const ok = { label: "A", words: "B" };
  refused(Array.from({ length: 9 }, () => ok));
  refused([{ label: "x".repeat(25), words: "B" }]);
  refused([{ label: "A", words: "y".repeat(301) }]);
  refused([{ label: "A", words: "B", extra: "no" }]);
  refused([{ label: "A\nB", words: "B" }]);
  refused([{ label: "", words: "B" }]);
  refused([{ label: "A", words: "  " }]);
  refused([{ label: "A", words: 5 }]);
  refused("not a list");
  refused([null]);
  assert.equal(fs.readFileSync(file(), "utf8"), before);
  assert.equal(writeStamps(Array.from({ length: 8 }, () => ok)).length, 8, "8 is allowed");
  assert.equal(writeStamps([{ label: "x".repeat(24), words: "y".repeat(300) }]).length, 1, "the caps themselves are allowed");
});

test("control and bidirectional characters are stripped, and a line break in the words becomes a space", () => {
  const [s] = writeStamps([{ label: "Sh\u202eort\u0007", words: "Make\u200f it\nshort\u2066er.\u0000" }]);
  assert.deepEqual(s, { label: "Short", words: "Make it shorter." });
  assert.deepEqual(readStamps(), [s]);
});

test("a broken file, or a hand-edited bad entry, reads as empty and never reaches the page", () => {
  fs.writeFileSync(file(), "{ not json");
  assert.deepEqual(readStamps(), []);
  fs.writeFileSync(file(), JSON.stringify({ stamps: [{ label: "ok", words: "fine" }, { label: "x".repeat(40), words: "too long a name" }, { label: "bidi\u202e", words: "w", extra: 1 }, 7] }));
  assert.deepEqual(readStamps(), [{ label: "ok", words: "fine" }]);
  fs.writeFileSync(file(), JSON.stringify({ stamps: "nope" }));
  assert.deepEqual(readStamps(), []);
});

test("stampText gives exactly the sentences in the spec", () => {
  const by = (id) => BUILT_IN.find((s) => s.id === id);
  assert.deepEqual(BUILT_IN.map((s) => s.label), ["Shorter", "Friendlier", "Fix grammar", "Translate"], "no Make it a table");
  assert.equal(stampText(by("shorter")), "Make this shorter. Keep the meaning.");
  assert.equal(stampText(by("friendlier")), "Make this sound friendlier. Keep the meaning.");
  assert.equal(stampText(by("grammar")), "Fix the grammar, spelling and punctuation here. Change nothing else.");
  assert.deepEqual(LANGUAGES, ["Spanish", "French", "German", "Portuguese", "Italian", "Chinese", "Japanese", "Korean"]);
  for (const l of LANGUAGES) assert.equal(stampText(by("translate"), l), `Translate this into ${l}.`);
  assert.equal(stampText(by("translate"), "Klingon"), null, "a language off the list sends nothing");
  assert.equal(stampText(by("translate")), null, "so does no language");
});
