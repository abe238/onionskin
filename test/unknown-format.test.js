// Every per-format dispatch on the server ends in an explicit refusal (src/constants.js unknownFormat): a format a chain does not know
// throws a clear error there instead of running another format's code (a web page read as a deck or a sheet). "zzz" is a made-up format.
import assert from "node:assert/strict";
import { test } from "node:test";
import { byFormat, unknownFormat } from "../src/constants.js";
import { buildDurable, changedRegions, readUnits, resolveDurableAny } from "../src/anchors.js";
import { reanchor } from "../src/anchor-work.js";
import { cardFor, opFor, outlineOf, unitsOf } from "../src/review.js";
import { compareBytes } from "../src/history.js";
import { buildBatch, replyWithOf } from "../src/batch.js";
import { planReplies } from "../src/reply.js";
import { textsOf } from "../src/voice-sample-worker.js";
import { handBack, prepareMerge, proveMerge } from "../src/merge-proof.js";
import { mergeProven } from "../src/merge-worker.js";
import { previewAll, runOps } from "../src/ops/run.js";

const Z = "zzz";
const UNKNOWN = /unknown format "zzz"/;
const units = { format: Z };
const bytes = Buffer.from("not a document");

test("unknownFormat and byFormat: a clear error naming the chain; an own key only", () => {
  assert.throws(() => unknownFormat(Z, "here"), /unknown format "zzz" in here/);
  assert.throws(() => unknownFormat("x".repeat(500), "here"), (e) => e.message.length < 80);
  const t = { docx: 1 };
  assert.equal(byFormat(t, "docx", "t"), 1);
  assert.throws(() => byFormat(t, "constructor", "t"), /unknown format "constructor" in t/);
  assert.throws(() => byFormat(t, Z, "t"), UNKNOWN);
});

test("every server-side dispatcher refuses a made-up format instead of running deck, sheet or Word code", async () => {
  const sync = {
    readUnits: () => readUnits(Z, bytes),
    buildDurable: () => buildDurable(units, { location: { slideIndex: 0 } }),
    resolveDurableAny: () => resolveDurableAny(units, { format: Z }),
    changedRegions: () => changedRegions(Z, bytes, bytes),
    reanchor: () => reanchor(units, { durable: { format: Z } }),
    reanchorBuild: () => reanchor(units, { durable: null, anchor: { location: { slideIndex: 0 } } }),
    unitsOf: () => unitsOf(Z, bytes),
    outlineOf: () => outlineOf(Z, bytes),
    cardFor: () => cardFor({ unit: "u1", kind: "note", note: "n" }, units, { u1: { label: "x", protected: false } }, { reviewId: "r", format: Z }),
    opFor: () => opFor({}, Z, "g", { find: "a", replace: "b" }),
    compareBytes: () => compareBytes(Z, bytes, bytes),
    replyWithOf: () => replyWithOf({ resolved: true, locator: { text_hash: "0123456789abcdef" } }, Z),
    evidenceOf: () => buildBatch({ file: "/tmp/x.zzz", format: "docx", baseSha: "a".repeat(64), note: "", edits: [], comments: [{ id: "c1", kind: "element", text: "fix", durable: { format: Z } }] }),
    textsOf: () => textsOf(Z, bytes),
    prepareMerge: () => prepareMerge(Z, {}),
    proveMerge: () => proveMerge(Z, {}),
    handBack: () => handBack(Z, {}),
  };
  for (const [name, fn] of Object.entries(sync)) assert.throws(fn, UNKNOWN, name);
  for (const mode of [{ find: "a", replace: "b" }, { text: "b" }]) {
    const batch = { format: Z, instructions: { comments: [{ id: "c1", anchor_id: "a1" }] }, untrusted_document_evidence: { anchors: [{ id: "a1", resolved: true, locator: { text_hash: "0123456789abcdef" } }] } };
    assert.throws(() => planReplies(batch, { replies: [{ comment: "c1", ...mode }] }), UNKNOWN, `planReplies ${Object.keys(mode)[0]}`);
  }
  await assert.rejects(mergeProven({ format: Z, base: bytes, mine: bytes, theirs: bytes }), UNKNOWN, "mergeProven");
  await assert.rejects(runOps({ bytes, format: Z, name: "x.zzz", ops: [] }), UNKNOWN, "runOps");
  // the read-only count already answered a refusal for an unknown format; "constructor" is not a driver either
  for (const f of [Z, "constructor"]) assert.equal((await previewAll(bytes, f, { op: "replace_all_text" })).status, "refused");
});
