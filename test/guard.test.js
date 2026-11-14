import assert from "node:assert/strict";
import { test } from "node:test";
import { contrast, guardStrength, behindInk, extremesOf } from "../web/src/guard.js";

// light theme: neutral ground, weakest ink, a near-clear sidebar glass and a stronger bar glass
const light = { neutral: [245, 247, 250], ink: [74, 80, 91], bright: 1.06 };
const bar = { glass: [251, 252, 254], a: 0.62, lt: 0 };
const side = { glass: [251, 252, 254], a: 0.42, lt: 0 };
const dark = { neutral: [8, 12, 20], ink: [166, 171, 180], bright: 0.92 };
const dbar = { glass: [20, 24, 34], a: 0.6, lt: 0.07 };
const dside = { glass: [18, 22, 31], a: 0.5, lt: 0.03 };
const BLACK = [0, 0, 0];
const WHITE = [255, 255, 255];

test("guard: a pale image passes untouched on the light theme; a black one is cut, and the result really meets 4.8:1", () => {
  const pale = guardStrength({ ...light, want: 0.6, regions: [{ ...bar, extremes: [[220, 225, 232], [250, 250, 250]] }, { ...side, extremes: [[220, 225, 232], [250, 250, 250]] }] });
  assert.deepEqual([pale.s, pale.clamped], [0.6, false]);
  const regions = [{ ...bar, extremes: [BLACK, WHITE] }, { ...side, extremes: [BLACK, WHITE] }];
  const g = guardStrength({ ...light, want: 0.6, regions });
  assert.equal(g.clamped, true);
  assert.ok(g.s > 0 && g.s < 0.6, String(g.s));
  for (const r of regions) for (const p of r.extremes) assert.ok(contrast(light.ink, behindInk(p, g.s, { neutral: light.neutral, glass: r.glass, a: r.a, bright: light.bright })) >= 4.79);
});

test("guard: pure white on the dark theme is cut (including the glass's top light); the result meets 4.8:1; zero strength is always allowed", () => {
  const regions = [{ ...dbar, extremes: [BLACK, WHITE] }, { ...dside, extremes: [BLACK, WHITE] }];
  const g = guardStrength({ ...dark, want: 1, regions });
  assert.ok(g.clamped && g.s < 0.5, String(g.s));
  for (const r of regions) for (const lt of [0, r.lt]) assert.ok(contrast(dark.ink, behindInk(WHITE, g.s, { neutral: dark.neutral, glass: r.glass, a: r.a, bright: dark.bright, lt })) >= 4.79);
  assert.equal(guardStrength({ ...dark, want: 0, regions }).s, 0);
});

test("guard: when the plain tone itself misses the target the answer is 0, not a loop", () => {
  const g = guardStrength({ neutral: [128, 128, 128], ink: [128, 128, 128], bright: 1, want: 1, regions: [{ glass: [128, 128, 128], a: 0.1, extremes: [[128, 128, 128]] }] });
  assert.deepEqual([g.s, g.clamped], [0, true]);
});

test("extremesOf finds the darkest and lightest pixel", () => {
  const d = new Uint8ClampedArray([10, 10, 10, 255, 200, 200, 200, 255, 90, 90, 90, 255]);
  assert.deepEqual(extremesOf(d), [[10, 10, 10], [200, 200, 200]]);
  assert.deepEqual(extremesOf(new Uint8ClampedArray(0)), []);
});
