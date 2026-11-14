// Own stamps: <state>/stamps.json (0600), a list of {label, words} the person typed. Per machine, like settings.json.
// The words are sent later as the text of an ordinary comment. Onionskin writes this file only from a guarded browser POST. A process running as the same OS user could still write it directly; the reader checks the shape, not the origin.
import fs from "node:fs";
import path from "node:path";
import { ensureStateDir, stateDir, writeStateFile } from "./paths.js";
import { SettingsError } from "./settings.js";

export const MAX_STAMPS = 8;
export const MAX_LABEL = 24;
export const MAX_WORDS = 300;
// C0 and C1 controls (this includes line breaks and tabs), and the bidirectional marks that can make text read in a different order than it is stored
const HIDDEN = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
const LINE_BREAK = /[\r\n\u2028\u2029]/u;
const len = (s) => Array.from(s).length;

const clean = (s) => s.replace(HIDDEN, "").trim();

/** One stamp, strictly: a wrong shape, an unknown field or a length outside the cap is a 400 and nothing is trimmed to fit. */
function checkStamp(s) {
  if (!s || typeof s !== "object" || Array.isArray(s)) throw new SettingsError(400, "Each stamp needs a name and words.");
  if (Object.keys(s).some((k) => k !== "label" && k !== "words")) throw new SettingsError(400, "A stamp has only a name and words.");
  if (typeof s.label !== "string" || typeof s.words !== "string") throw new SettingsError(400, "Each stamp needs a name and words.");
  if (LINE_BREAK.test(s.label)) throw new SettingsError(400, "A stamp name has to fit on one line.");
  const label = clean(s.label);
  const words = clean(s.words.replace(/[\r\n\t\u2028\u2029]+/gu, " "));
  if (!label || len(label) > MAX_LABEL) throw new SettingsError(400, `A stamp name needs 1 to ${MAX_LABEL} characters.`);
  if (!words) throw new SettingsError(400, "A stamp needs words to send.");
  if (len(words) > MAX_WORDS) throw new SettingsError(400, `That is too long. Keep it under ${MAX_WORDS} characters.`);
  return { label, words };
}

/** Read per call. A missing or broken file, or a bad entry in it, reads as nothing: a hand-edited file can never reach the page unchecked. */
export function readStamps() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(stateDir(), "stamps.json"), "utf8"));
  } catch {
    return [];
  }
  if (!Array.isArray(raw?.stamps)) return [];
  const out = [];
  for (const s of raw.stamps) {
    try {
      out.push(checkStamp(s));
    } catch {}
    if (out.length === MAX_STAMPS) break;
  }
  return out;
}

/** Validates the whole list (all or nothing) and stores it. Returns the stored list. */
export function writeStamps(list) {
  if (!Array.isArray(list)) throw new SettingsError(400, "stamps must be a list");
  if (list.length > MAX_STAMPS) throw new SettingsError(400, `You can keep up to ${MAX_STAMPS} stamps.`);
  const stamps = list.map(checkStamp);
  ensureStateDir();
  writeStateFile(path.join(stateDir(), "stamps.json"), JSON.stringify({ stamps }, null, 2) + "\n");
  return stamps;
}
