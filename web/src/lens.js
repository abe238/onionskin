/* Liquid Glass material, JavaScript half (the CSS half is in shell.css under [data-spec]).
 *
 * 1. Edge lensing, Chromium only. For each element with data-lens="bevel scale" it builds a convex-bevel displacement map
 *    (offsets point inward along the rounded-rect edge normal, neutral in the middle) and exposes it as --lens: url(#id) for
 *    `backdrop-filter`. Safari and Firefox do not render SVG filters in backdrop-filter, so they keep the blur + saturate + rim
 *    the CSS already draws. Off with ?lens=off, under prefers-reduced-transparency, or when the browser is not Chromium.
 * 2. Specular light: the rim highlight of every [data-spec] element follows the pointer (static under reduced motion).
 * 3. The drifting workspace field pauses while the tab is hidden and while the user types or scrolls.
 *
 * Elements register through the `glass` ref callback (React 19 runs the returned cleanup on unmount). No dependencies, no network. */

const root = document.documentElement;
const NS = "http://www.w3.org/2000/svg";
const off = /[?&]lens=off\b/.test(location.search);
const brands = navigator.userAgentData && navigator.userAgentData.brands;
const chromium = !!(brands && brands.some((b) => /Chromium/.test(b.brand)));
const lowTransparency = window.matchMedia("(prefers-reduced-transparency: reduce)").matches;
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const lensOn = !off && chromium && !lowTransparency && typeof ResizeObserver === "function";
root.dataset.lens = lensOn ? "1" : "0";

const tracked = new Set(); // every [data-spec] element, for the pointer light
let defs = null;
let ro = null;
let n = 0;

function ensureDefs() {
  if (defs) return;
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("width", "0");
  svg.setAttribute("height", "0");
  svg.setAttribute("aria-hidden", "true");
  svg.style.position = "absolute";
  defs = document.createElementNS(NS, "defs");
  svg.appendChild(defs);
  document.body.appendChild(svg);
}

/** A displacement map for a w x h rounded rect with corner radius r: red/green encode the inward direction, strongest at the rim. */
function bevelMap(w, h, r, bevel) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(w, h);
  const d = img.data;
  const hw = w / 2;
  const hh = h / 2;
  r = Math.min(r, hw, hh);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = x + 0.5 - hw;
      const py = y + 0.5 - hh;
      const qx = Math.abs(px) - (hw - r);
      const qy = Math.abs(py) - (hh - r);
      let nx, ny, dist;
      if (qx > 0 && qy > 0) {
        const len = Math.sqrt(qx * qx + qy * qy) || 1;
        dist = r - len;
        nx = qx / len;
        ny = qy / len;
      } else if (qx > qy) {
        dist = r - qx;
        nx = 1;
        ny = 0;
      } else {
        dist = r - qy;
        nx = 0;
        ny = 1;
      }
      const ix = -nx * (px < 0 ? -1 : 1);
      const iy = -ny * (py < 0 ? -1 : 1);
      const t = Math.max(0, Math.min(1, dist / bevel));
      const mag = dist < 0 ? 0 : Math.pow(1 - t, 2.4);
      const i = (y * w + x) * 4;
      d[i] = 128 + ix * mag * 127;
      d[i + 1] = 128 + iy * mag * 127;
      d[i + 2] = 128;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL();
}

function build(el) {
  const w = Math.round(el.offsetWidth);
  const h = Math.round(el.offsetHeight);
  if (!w || !h) return;
  const cs = getComputedStyle(el);
  const key = `${w}x${h}${root.dataset.theme || ""}${cs.borderTopLeftRadius}`;
  if (el._lensKey === key) return;
  el._lensKey = key;
  ensureDefs();
  const parts = (el.getAttribute("data-lens") || "").split(/\s+/);
  const bevel = parseFloat(parts[0]) || 16;
  const scale = parseFloat(parts[1]) || 36;
  const r = parseFloat(cs.borderTopLeftRadius) || 0;
  const id = el._lensId || (el._lensId = `lens-${++n}`);
  let f = document.getElementById(id);
  if (!f) {
    f = document.createElementNS(NS, "filter");
    f.id = id;
    f.setAttribute("filterUnits", "userSpaceOnUse");
    f.setAttribute("color-interpolation-filters", "sRGB");
    f.innerHTML =
      '<feGaussianBlur in="SourceGraphic" result="b" edgeMode="duplicate"/><feImage result="m" preserveAspectRatio="none"/><feDisplacementMap in="b" in2="m" xChannelSelector="R" yChannelSelector="G" result="d"/><feColorMatrix in="d" type="saturate" result="s"/><feComponentTransfer in="s"><feFuncR type="linear"/><feFuncG type="linear"/><feFuncB type="linear"/></feComponentTransfer>';
    defs.appendChild(f);
  }
  f.setAttribute("x", "0");
  f.setAttribute("y", "0");
  f.setAttribute("width", w);
  f.setAttribute("height", h);
  const blur = parseFloat(cs.getPropertyValue("--g-blur")) || 8;
  const sat = parseFloat(cs.getPropertyValue("--g-sat")) || 1.5;
  const bri = parseFloat(cs.getPropertyValue("--g-bri")) || 1;
  f.querySelector("feGaussianBlur").setAttribute("stdDeviation", blur);
  f.querySelector("feColorMatrix").setAttribute("values", sat);
  f.querySelectorAll("feComponentTransfer > *").forEach((fn) => fn.setAttribute("slope", bri));
  const fi = f.querySelector("feImage");
  // big frames get a half-resolution map (the bevel is smooth, the canvas loop is per pixel)
  const q = w * h > 160000 ? 0.5 : 1;
  fi.setAttribute("href", bevelMap(Math.max(2, Math.round(w * q)), Math.max(2, Math.round(h * q)), r * q, bevel * q));
  fi.setAttribute("x", "0");
  fi.setAttribute("y", "0");
  fi.setAttribute("width", w);
  fi.setAttribute("height", h);
  f.querySelector("feDisplacementMap").setAttribute("scale", scale);
  el.style.setProperty("--lens", `url(#${id})`);
}

const pending = new Set();
let raf = 0;
function flush() {
  raf = 0;
  for (const el of pending) if (el.isConnected) build(el);
  pending.clear();
}
function queue(el) {
  pending.add(el);
  if (!raf) raf = requestAnimationFrame(flush); // a resize drag rebuilds at most once per frame
}

function start() {
  if (ro || !lensOn) return;
  ro = new ResizeObserver((entries) => entries.forEach((e) => queue(e.target)));
  // theme flips change the frost values: rebuild everything that carries a lens
  new MutationObserver(() => document.querySelectorAll("[data-lens]").forEach((el) => ((el._lensKey = ""), queue(el)))).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
}

/** Ref callback for a glass element: <div data-spec data-lens="14 30" ref={glass}>. */
export function glass(el) {
  if (!el) return;
  tracked.add(el);
  const lens = lensOn && el.hasAttribute("data-lens");
  if (lens) {
    start();
    ro.observe(el);
    queue(el);
  }
  return () => {
    tracked.delete(el);
    if (lens) ro.unobserve(el);
    pending.delete(el);
    if (el._lensId) document.getElementById(el._lensId)?.remove();
  };
}

// ---- specular light follows the pointer; it stands still under reduced motion -------------------------------------
if (!reduceMotion.matches && window.matchMedia("(pointer: fine)").matches) {
  let ev = null;
  let tick = 0;
  const move = () => {
    tick = 0;
    const rects = [...tracked].map((el) => [el, el.getBoundingClientRect()]); // all reads first, then all writes
    for (const [el, r] of rects) {
      if (!r.width || !r.height) continue;
      const x = Math.max(-0.5, Math.min(1.5, (ev.clientX - r.left) / r.width));
      const y = Math.max(-0.5, Math.min(1.5, (ev.clientY - r.top) / r.height));
      el.style.setProperty("--lx", `${(x * 100).toFixed(1)}%`);
      el.style.setProperty("--ly", `${(y * 100).toFixed(1)}%`);
    }
  };
  window.addEventListener(
    "pointermove",
    (e) => {
      ev = e;
      if (!tick) tick = requestAnimationFrame(move);
    },
    { passive: true }
  );
}

// ---- the workspace field: pause while hidden, and while the user is typing or scrolling ---------------------------
const setPaused = (p) => {
  if (p) {
    if (root.dataset.calm !== "1") root.dataset.calm = "1";
  } else delete root.dataset.calm;
};
document.addEventListener("visibilitychange", () => setPaused(document.hidden));
let calmTimer = 0;
const calm = () => {
  if (document.hidden) return;
  setPaused(true);
  clearTimeout(calmTimer);
  calmTimer = setTimeout(() => setPaused(false), 1400);
};
document.addEventListener("keydown", calm, { capture: true, passive: true });
document.addEventListener("scroll", calm, { capture: true, passive: true });
