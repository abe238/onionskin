// The workspace background: the saved choice (per machine, kept by the server), the custom image pipeline and the legibility guard.
// Nothing leaves this machine: the picture is read here, scaled in a canvas (which drops EXIF/GPS and every other metadata block), and only the
// re-encoded result is sent to the local server. The server hands it back over the authenticated API; it is shown from a blob: URL (img-src allows it).
import { useCallback, useEffect, useRef, useState } from "react";
import { api, blobToBase64 } from "./lib.js";
import { extremesOf, guardStrength } from "./guard.js";

export const PRESETS = [
  { id: "paper", label: "Paper" },
  { id: "pages", label: "Pages" },
  { id: "aurora", label: "Aurora" },
  { id: "studio", label: "Studio" },
  { id: "midnight", label: "Midnight" },
];
export const DEFAULT_BG = { kind: "preset", name: "paper", strength: 60, blur: true };
export const MAX_BYTES = 15 * 1024 * 1024;
const LONG_SIDE = 2560; // stored image
const BLUR_SIDE = 640; // shown when "Blur image" is on: a small copy scaled up is a soft blur that costs nothing per frame
const SHOW_SIDE = 1920;
const NEUTRAL_FALLBACK = [245, 247, 250];

/** png | jpeg | webp | heic from the first bytes, else null. The file name and the claimed type are not trusted. */
export function sniff(b) {
  const s = (i, n) => String.fromCharCode(...b.slice(i, i + n));
  if (b.length >= 8 && b[0] === 0x89 && s(1, 3) === "PNG") return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 12 && s(0, 4) === "RIFF" && s(8, 4) === "WEBP") return "webp";
  if (b.length >= 12 && s(4, 4) === "ftyp" && /^(heic|heix|hevc|heim|heis|mif1|msf1)/.test(s(8, 4))) return "heic";
  return null;
}

const toBlob = (canvas, type, q) => new Promise((res) => canvas.toBlob(res, type, q));

/** Validates a picked file and returns the scaled, re-encoded JPEG (Blob). Throws an Error whose message is shown to the user as it is. */
export async function normalizeImage(file) {
  if (file.size > MAX_BYTES) throw new Error("That picture is larger than 15 MB. Choose a smaller one.");
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const kind = sniff(head);
  if (!kind) throw new Error("That file is not a PNG, JPEG, WebP or HEIC picture.");
  let bmp;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error(kind === "heic" ? "This browser cannot open HEIC pictures. Export it as JPEG or PNG and try again." : "That picture could not be read. It may be damaged.");
  }
  const k = Math.min(1, LONG_SIDE / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(bmp.width * k));
  c.height = Math.max(1, Math.round(bmp.height * k));
  const ctx = c.getContext("2d");
  ctx.fillStyle = "rgb(245, 247, 250)"; // a transparent PNG is flattened onto the plain tone (JPEG has no alpha)
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  const blob = await toBlob(c, "image/jpeg", 0.88);
  if (!blob) throw new Error("That picture could not be prepared.");
  return stripJpegMetadata(blob);
}

/** Drops the EXIF (APP1) and Photoshop (APP13) segments. Chrome writes none; Safari's encoder adds both, and what is stored should carry no metadata block at all. */
async function stripJpegMetadata(blob) {
  const b = new Uint8Array(await blob.arrayBuffer());
  const keep = [b.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= b.length && b[i] === 0xff && b[i + 1] !== 0xda) {
    const end = i + 2 + ((b[i + 2] << 8) | b[i + 3]);
    if (b[i + 1] !== 0xe1 && b[i + 1] !== 0xed) keep.push(b.subarray(i, end));
    i = end;
  }
  keep.push(b.subarray(i));
  return new Blob(keep, { type: "image/jpeg" });
}

async function makeDisplay(blob, blur) {
  const bmp = await createImageBitmap(blob);
  const long = blur ? BLUR_SIDE : SHOW_SIDE;
  const k = Math.min(1, long / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(bmp.width * k));
  c.height = Math.max(1, Math.round(bmp.height * k));
  const ctx = c.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  const out = await toBlob(c, "image/jpeg", 0.9);
  return { url: URL.createObjectURL(out), canvas: c };
}

const nums = (s) => (String(s).match(/-?\d*\.?\d+/g) || []).map(Number);
/**
 * A color token as {rgb, a}. The browser resolves it first (hex, names and color-mix(), which the banner fills use: read as text, its first
 * hex color is not the fill). Chrome serializes the result as rgb()/rgba() with 0-255 channels, or color(srgb r g b / a) with 0-1 channels
 * for a color-mix in srgb. Ceiling: a token mixed in another space (oklab(), lab()) is not parsed and falls back to `fb`.
 */
const colorOf = (s, fb) => {
  const probe = document.createElement("i");
  probe.style.color = String(s).trim();
  if (!probe.style.color) return fb; // not a color
  probe.style.display = "none";
  document.body.append(probe);
  const c = getComputedStyle(probe).color;
  probe.remove();
  const n = nums(c);
  if (n.length < 3) return fb;
  if (/^color\(srgb\b/.test(c)) return { rgb: n.slice(0, 3).map((v) => Math.round(v * 255)), a: n.length > 3 ? n[3] : 1 };
  return /^rgba?\(/.test(c) ? { rgb: n.slice(0, 3), a: n.length > 3 ? n[3] : 1 } : fb;
};

/** Measures what the glass will sit on and returns the strength the image may have. Reads the live tokens, so every preset-independent tweak is honored. */
function measure(canvas, want) {
  const root = getComputedStyle(document.documentElement);
  const neutral = colorOf(root.getPropertyValue("--bg"), { rgb: NEUTRAL_FALLBACK, a: 1 }).rgb;
  const ink = colorOf(root.getPropertyValue("--ink-3"), { rgb: [74, 80, 91], a: 1 }).rgb;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const q = 1 / 8;
  const cw = Math.max(1, Math.ceil(vw * q));
  const ch = Math.max(1, Math.ceil(vh * q));
  const c = document.createElement("canvas");
  c.width = cw;
  c.height = ch;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  const sc = Math.max(cw / canvas.width, ch / canvas.height); // cover, centered: the same fit as the page's background-size: cover
  const dw = canvas.width * sc;
  const dh = canvas.height * sc;
  ctx.drawImage(canvas, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
  const regions = [];
  for (const el of document.querySelectorAll(".glass:not(.glass-pop)")) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.right < 0 || r.top > vh || r.left > vw) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none") continue;
    const x = Math.max(0, Math.floor(r.left * q));
    const y = Math.max(0, Math.floor(r.top * q));
    const w = Math.max(1, Math.min(cw - x, Math.ceil(r.width * q)));
    const h = Math.max(1, Math.min(ch - y, Math.ceil(r.height * q)));
    const fill = colorOf(cs.getPropertyValue("--g-fill"), { rgb: neutral, a: 0.6 });
    const lt = colorOf(cs.getPropertyValue("--g-light-top"), { rgb: [255, 255, 255], a: 0 }).a;
    regions.push({ extremes: extremesOf(ctx.getImageData(x, y, w, h).data), glass: fill.rgb, a: fill.a, lt, bright: parseFloat(cs.getPropertyValue("--g-bri")) || 1 });
  }
  return guardStrength({ regions: regions.filter((r) => r.extremes.length), neutral, ink, want });
}

export function useBackground(initial, { theme, layoutKey }) {
  const [bg, setBg] = useState(initial?.background || DEFAULT_BG);
  const [version, setVersion] = useState(initial?.customVersion ?? null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [src, setSrc] = useState(null); // the stored image as a Blob
  const [disp, setDisp] = useState(null); // { url, canvas }: what is painted
  const [guard, setGuard] = useState({ s: 1, clamped: false });
  const saveTimer = useRef(0);

  useEffect(() => {
    document.documentElement.dataset.bg = bg.kind === "custom" ? "custom" : bg.name;
  }, [bg.kind, bg.name]);

  const persist = useCallback((next, delay = 0) => {
    clearTimeout(saveTimer.current);
    const go = () => api("/api/settings", { method: "POST", body: { background: next } }).then((r) => (setVersion(r.customVersion ?? null), setMessage("")), () => setMessage("The background choice could not be saved."));
    if (delay) saveTimer.current = setTimeout(go, delay);
    else go();
  }, []);

  // fetch the stored image whenever the custom choice or its version changes
  useEffect(() => {
    if (version == null) return setSrc(null);
    let live = true;
    api("/api/background", { raw: true }).then(
      ({ buf }) => live && setSrc(new Blob([buf])),
      () => live && (setSrc(null), setMessage("The saved image could not be loaded."))
    );
    return () => void (live = false);
  }, [version]);

  // the painted copy: blurred (small, scaled up) or sharp
  useEffect(() => {
    if (!src) return setDisp(null);
    let live = true;
    let made = null;
    makeDisplay(src, bg.blur).then(
      (d) => {
        made = d;
        if (live) setDisp(d);
        else URL.revokeObjectURL(d.url);
      },
      () => live && (setDisp(null), setMessage("The saved image could not be read."))
    );
    return () => {
      live = false;
      if (made) setTimeout(() => URL.revokeObjectURL(made.url), 1000);
    };
  }, [src, bg.blur]);

  // the guard: re-measured when the picture, the theme, the slider or the layout changes
  const want = bg.strength / 100;
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let t = 0;
    const f = () => (clearTimeout(t), (t = setTimeout(() => setTick((n) => n + 1), 150)));
    window.addEventListener("resize", f);
    return () => (window.removeEventListener("resize", f), clearTimeout(t));
  }, []);
  useEffect(() => {
    if (!disp || bg.kind !== "custom") return setGuard({ s: want, clamped: false });
    const t = setTimeout(() => {
      try {
        setGuard(measure(disp.canvas, want));
      } catch {
        setGuard({ s: Math.min(want, 0.25), clamped: want > 0.25 }); // cannot measure: stay far inside the safe range
      }
    }, 120);
    return () => clearTimeout(t);
  }, [disp, theme, want, layoutKey, tick, bg.blur, bg.kind]);

  const choosePreset = useCallback((name) => {
    setMessage("");
    setBg((b) => {
      const next = { ...b, kind: "preset", name };
      persist(next);
      return next;
    });
  }, [persist]);
  const useImage = useCallback(() => {
    if (version == null) return;
    setBg((b) => {
      const next = { ...b, kind: "custom", name: "custom" };
      persist(next);
      return next;
    });
  }, [persist, version]);
  const setStrength = useCallback((n) => setBg((b) => {
    const next = { ...b, strength: n };
    persist(next, 250);
    return next;
  }), [persist]);
  const setBlur = useCallback((on) => setBg((b) => {
    const next = { ...b, blur: on };
    persist(next);
    return next;
  }), [persist]);

  const upload = useCallback(async (file) => {
    if (!file) return;
    setMessage("");
    setBusy(true);
    try {
      const blob = await normalizeImage(file);
      const r = await api("/api/background", { method: "POST", body: { bytesB64: await blobToBase64(blob), background: { strength: bg.strength, blur: bg.blur } } });
      setBg(r.background);
      setVersion(r.customVersion ?? null);
    } catch (err) {
      setMessage(err?.message || "That picture could not be used.");
    } finally {
      setBusy(false);
    }
  }, [bg.strength, bg.blur]);

  const remove = useCallback(async () => {
    setMessage("");
    try {
      const r = await api("/api/background/remove", { method: "POST", body: {} });
      setBg(r.background);
      setVersion(null);
    } catch {
      setMessage("The image could not be removed.");
    }
  }, []);

  const reset = useCallback(() => {
    setMessage("");
    setBg(DEFAULT_BG);
    persist(DEFAULT_BG);
  }, [persist]);

  return { bg, hasImage: version != null, image: bg.kind === "custom" ? disp : null, thumbImage: disp, effective: guard.s, clamped: guard.clamped, message, busy, choosePreset, useImage, setStrength, setBlur, upload, remove, reset };
}
