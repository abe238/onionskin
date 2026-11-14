// Per-machine settings: <state>/settings.json (0600) and the one custom background image <state>/backgrounds/custom.<ext> (0600).
// The page never names a path: it uploads bytes, the server sniffs the type from the magic bytes and picks the file name itself.
import fs from "node:fs";
import path from "node:path";
import { ensureStateDir, stateDir, sub, writeStateFile } from "./paths.js";

export const BG_PRESETS = ["pages", "paper", "aurora", "studio", "midnight"];
export const DEFAULT_BACKGROUND = { kind: "preset", name: "paper", strength: 60, blur: true };
export const AGENT_CLIS = ["claude"]; // the background agent is Claude Code only in this build
export const DEFAULT_AGENT = { cli: "claude", model: "sonnet", show: false };
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const EXT = { png: ".png", jpeg: ".jpg", webp: ".webp" };
const MIME = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" };

export class SettingsError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** "png" | "jpeg" | "webp" from the leading bytes, or null. The file name and the claimed type are never trusted. */
export function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "webp";
  return null;
}

const bgDir = () => path.join(stateDir(), "backgrounds");
function customFile() {
  for (const e of ["png", "jpeg", "webp"]) {
    try {
      const f = path.join(bgDir(), `custom${EXT[e]}`);
      const st = fs.lstatSync(f);
      if (st.isFile()) return { file: f, type: e, version: Math.floor(st.mtimeMs) };
    } catch {}
  }
  return null;
}
export const hasCustom = () => !!customFile();

/** Whatever is in `input`, reduced to a valid {kind,name,strength,blur}. Unknown or out-of-range parts fall back to the default; nothing is thrown. */
export function normalizeBackground(input) {
  const d = DEFAULT_BACKGROUND;
  const b = input && typeof input === "object" ? input : {};
  const kind = b.kind === "custom" ? "custom" : "preset";
  const n = Number(b.strength);
  return {
    kind,
    name: kind === "custom" ? "custom" : BG_PRESETS.includes(b.name) ? b.name : d.name,
    strength: Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : d.strength,
    blur: typeof b.blur === "boolean" ? b.blur : d.blur,
  };
}

/** Whatever is in `input`, reduced to a valid {cli,model,show}: a value outside the fixed lists falls back to the default. */
export function normalizeAgent(input) {
  const a = input && typeof input === "object" ? input : {};
  const d = DEFAULT_AGENT;
  return {
    cli: AGENT_CLIS.includes(a.cli) ? a.cli : d.cli,
    model: typeof a.model === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(a.model) ? a.model : d.model,
    show: typeof a.show === "boolean" ? a.show : d.show,
  };
}

function rawSettings() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(stateDir(), "settings.json"), "utf8"));
    return j && typeof j === "object" && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}
/** One settings file holds every group: a write replaces its own group and keeps the rest. */
function writeGroup(name, value) {
  ensureStateDir();
  writeStateFile(path.join(stateDir(), "settings.json"), JSON.stringify({ ...rawSettings(), [name]: value }, null, 2) + "\n");
}

/** Read per call (the CLI may have changed the file). A missing, broken or custom-without-image file reads as the default. */
export function readSettings() {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(path.join(stateDir(), "settings.json"), "utf8"));
  } catch {}
  let background = normalizeBackground(raw?.background);
  if (background.kind === "custom" && !hasCustom()) background = { ...DEFAULT_BACKGROUND, strength: background.strength, blur: background.blur };
  const c = customFile();
  return { background, customVersion: c ? c.version : null, agent: normalizeAgent(raw?.agent) };
}

/** Validates (strictly: a bad value is an error here, unlike a read) and stores the background choice. */
export function writeBackground(input) {
  const b = input && typeof input === "object" ? input : null;
  if (!b) throw new SettingsError(400, "background must be an object");
  if (b.kind !== "preset" && b.kind !== "custom") throw new SettingsError(400, "background.kind must be preset or custom");
  if (b.kind === "preset" && !BG_PRESETS.includes(b.name)) throw new SettingsError(400, `background.name must be one of ${BG_PRESETS.join(", ")}`);
  if (b.strength !== undefined && !(Number.isFinite(b.strength) && b.strength >= 0 && b.strength <= 100)) throw new SettingsError(400, "background.strength must be 0 to 100");
  if (b.blur !== undefined && typeof b.blur !== "boolean") throw new SettingsError(400, "background.blur must be true or false");
  if (b.kind === "custom" && !hasCustom()) throw new SettingsError(409, "no custom image is stored");
  writeGroup("background", normalizeBackground(b));
  return readSettings();
}

/** Validates (strictly) and stores a change to the background agent's settings: any of cli, model, show. The other settings are kept. */
export function writeAgent(input) {
  const a = input && typeof input === "object" ? input : null;
  if (!a) throw new SettingsError(400, "agent must be an object");
  if (a.cli !== undefined && !AGENT_CLIS.includes(a.cli)) throw new SettingsError(400, `agent.cli must be one of ${AGENT_CLIS.join(", ")}`);
  if (a.model !== undefined && normalizeAgent({ model: a.model }).model !== a.model) throw new SettingsError(400, "agent.model must be a model name such as sonnet");
  if (a.show !== undefined && typeof a.show !== "boolean") throw new SettingsError(400, "agent.show must be true or false");
  writeGroup("agent", normalizeAgent({ ...rawSettings().agent, ...a }));
  return readSettings();
}

/** Stores the bytes as the one custom image (the older one is removed). Returns the settings. */
export function saveCustomImage(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length) throw new SettingsError(400, "no image data");
  if (bytes.length > MAX_IMAGE_BYTES) throw new SettingsError(413, "image is larger than 15 MB");
  const type = sniffImage(bytes);
  if (!type) throw new SettingsError(415, "not a PNG, JPEG or WebP image");
  ensureStateDir();
  const dir = sub("backgrounds");
  removeFiles(dir);
  writeStateFile(path.join(dir, `custom${EXT[type]}`), bytes);
  return readSettings();
}
function removeFiles(dir) {
  for (const e of Object.values(EXT)) fs.rmSync(path.join(dir, `custom${e}`), { force: true });
}

/** Deletes the custom image; a custom choice falls back to the default preset. */
export function removeCustomImage() {
  removeFiles(bgDir());
  const cur = readSettings().background;
  const raw = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(stateDir(), "settings.json"), "utf8"));
    } catch {
      return null;
    }
  })();
  if (raw?.background?.kind === "custom") writeBackground({ ...DEFAULT_BACKGROUND, strength: cur.strength, blur: cur.blur });
  return readSettings();
}

/** { bytes, mime, version } of the stored image, or null. */
export function readCustomImage() {
  const c = customFile();
  if (!c) return null;
  const bytes = fs.readFileSync(c.file);
  return { bytes, mime: MIME[sniffImage(bytes) || c.type], version: c.version };
}

/** The CLI's `config background`: same validation, the file is copied as it is (the page scales it when it is shown). */
export function describeBackground(b) {
  return b.kind === "custom" ? `custom image (strength ${b.strength}, blur ${b.blur ? "on" : "off"})` : `${b.name}${b.name === DEFAULT_BACKGROUND.name ? " (default)" : ""}`;
}
