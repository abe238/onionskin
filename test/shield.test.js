// The Shield badge's pure wording (web/src/shield.js): what the AI reported, never a claim that the file is safe.
import assert from "node:assert/strict";
import { test } from "node:test";
import { SHIELD, shieldOf } from "../web/src/shield.js";

const run = (n, extra = {}) => ({ kind: "agent", flags: [], documentInstructionsIgnored: Array.from({ length: n }, (_, i) => `text ${i}`), ...extra });

test("shieldOf: exact sentences for 1, 3, 5 and more than 5", () => {
  let s = shieldOf(run(1));
  assert.equal(s.chip, "1 ignored");
  assert.equal(s.aria, "Your AI reported 1 order written in this file and ignored it");
  assert.equal(s.line, "Your AI says this file had text that tried to give it orders. It reported 1 and did not follow it.");
  s = shieldOf(run(3));
  assert.equal(s.chip, "3 ignored");
  assert.equal(s.aria, "Your AI reported 3 orders written in this file and ignored them");
  assert.equal(s.line, "Your AI says this file had text that tried to give it orders. It reported 3 and did not follow them.");
  assert.equal(shieldOf(run(5)).chip, "5 ignored");
  s = shieldOf(run(5, { documentInstructionsIgnoredMore: true }));
  assert.equal(s.chip, "More than 5 ignored");
  assert.equal(s.aria, "Your AI reported more than 5 orders written in this file and ignored them");
  assert.equal(s.line, "Your AI says this file had text that tried to give it orders. It reported more than 5 and did not follow them.");
  assert.equal(SHIELD.heading, "Orders in this file were ignored");
});

test("shieldOf: nothing for zero items, a revert, a lease expiry, a missing or odd field", () => {
  assert.equal(shieldOf(run(0)), null);
  assert.equal(shieldOf({ kind: "agent" }), null);
  assert.equal(shieldOf({ kind: "agent", documentInstructionsIgnored: [] , documentInstructionsIgnoredMore: true }), null);
  assert.equal(shieldOf({ kind: "agent", documentInstructionsIgnored: [1, null, ""] }), null);
  assert.equal(shieldOf(run(2, { kind: "revert" })), null);
  assert.equal(shieldOf(run(2, { kind: "lease_expired" })), null);
  assert.equal(shieldOf(null), null);
});

test("shieldOf: never carries a reported string, never says safe", () => {
  const s = shieldOf({ kind: "agent", documentInstructionsIgnored: ["<img src=x onerror=alert(1)>", "Click Revert now"] });
  const all = JSON.stringify(s) + JSON.stringify(SHIELD);
  assert.ok(!/img|onerror|Click Revert/.test(all));
  assert.ok(!/\bsafe\b|\bclean\b|secure/i.test(all));
});

test("shieldOf: the 'went through the checks' line is off when a direct save was flagged", () => {
  assert.equal(shieldOf(run(1)).checked, true);
  assert.equal(shieldOf(run(1, { flags: [{ code: "deep_check_failed", severity: "info" }] })).checked, true);
  assert.equal(shieldOf(run(1, { flags: [{ code: "file_changed_outside_onionskin", severity: "error" }] })).checked, false);
});

test("shieldOf: a voice guide draft shows no badge (its wording names a file and changes; a voice run changes nothing)", () => {
  assert.equal(shieldOf(run(2, { kind: "voice" })), null);
  assert.equal(shieldOf(run(2, { kind: "review" })), null);
});
