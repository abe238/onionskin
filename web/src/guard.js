// The legibility guard for a custom background image. Pure functions (no DOM), so a test can run them.
// The page composites: neutral ground, the image on top at strength s, then each glass surface over that, then ink on the glass.
//   pixel(s)  = s * image + (1 - s) * neutral
//   behind    = (pixel * brightness) * (1 - a) + glass * a      (a = the glass fill's alpha; backdrop-filter brightness is applied to what is behind)
//   lifted    = behind * (1 - lt) + 255 * lt                      (the glass's inner top light; only ever worse for light ink, so both cases are tried)
// The guard finds the largest s (<= what the user asked for) at which the weakest ink keeps `target` over the worst pixels of every glass region.
// Ceiling: sRGB-space mixing, gray-ish brightness factor, saturate() ignored (the target carries a 0.3 margin over AA 4.5).

const lin = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
export const luminance = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
export const contrast = (a, b) => {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
const mix = (a, b, t) => a.map((v, i) => v * (1 - t) + b[i] * t);
const clamp255 = (c) => c.map((v) => Math.max(0, Math.min(255, v)));

/** The colour the ink sits on, for one image pixel `p` at strength `s`. */
export function behindInk(p, s, { neutral, glass, a, bright = 1, lt = 0 }) {
  const pixel = clamp255(mix(neutral, p, s).map((v) => v * bright));
  const behind = mix(pixel, glass, a);
  return mix(behind, [255, 255, 255], lt);
}

/** Worst contrast of `ink` over the given extreme pixels of one region at strength s. */
export function regionContrast(extremes, s, ink, env) {
  let worst = Infinity;
  for (const p of extremes) for (const lt of env.lt ? [0, env.lt] : [0]) worst = Math.min(worst, contrast(ink, behindInk(p, s, { ...env, lt })));
  return worst;
}

/**
 * regions: [{ extremes: [[r,g,b] darkest, [r,g,b] lightest], glass: [r,g,b], a, lt }]
 * Returns the effective strength in [0, want] (0..1) and whether it was cut below `want`.
 */
export function guardStrength({ regions, neutral, ink, bright = 1, want, target = 4.8 }) {
  const ok = (s) => regions.every((r) => regionContrast(r.extremes, s, ink, { neutral, glass: r.glass, a: r.a, bright: r.bright ?? bright, lt: r.lt || 0 }) >= target);
  if (ok(want)) return { s: want, clamped: false };
  if (!ok(0)) return { s: 0, clamped: want > 0 }; // the plain tone already misses the target: nothing the image does can help
  let lo = 0;
  let hi = want;
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2;
    if (ok(mid)) lo = mid;
    else hi = mid;
  }
  return { s: lo, clamped: true };
}

/** Darkest and lightest pixel (as [r,g,b]) of an RGBA array. */
export function extremesOf(data) {
  let dark = null;
  let light = null;
  let dl = Infinity;
  let ll = -Infinity;
  for (let i = 0; i < data.length; i += 4) {
    const px = [data[i], data[i + 1], data[i + 2]];
    const l = luminance(px);
    if (l < dl) ((dl = l), (dark = px));
    if (l > ll) ((ll = l), (light = px));
  }
  return dark ? [dark, light] : [];
}
