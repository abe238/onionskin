// Writing preferences: <state>/style.json (0600), per machine. A closed set of fixed sentences plus the person's own typed words.
// The note sent to the agent is built here from those two things only: nothing from a document, a diff or an agent's text ever reaches it.
// Guard: this module keeps its own copy of what it last wrote (or first read) and re-reads the file on every read. A file changed by
// anything else while the server runs is put back from that copy and counted (styleChangedOutside). Ceiling: the copy lives in memory,
// so a change made while no server runs is trusted by the next server's first read.
import fs from "node:fs";
import path from "node:path";
import { ensureStateDir, stateDir, writeStateFile } from "./paths.js";
import { userText } from "./sanitize.js";
import { SettingsError } from "./settings.js";

export const MAX_WORDS = 280;

/** The eight fixed preferences. `label` is what the person sees, `sentence` is what the agent gets. */
export const TRAITS = [
  { id: "short", label: "Keep it short", sentence: "Keep new text short." },
  { id: "plain", label: "Plain words", sentence: "Use plain, everyday words." },
  { id: "formal", label: "More formal", sentence: "Use a formal tone." },
  { id: "relaxed", label: "More relaxed", sentence: "Use a relaxed, friendly tone." },
  { id: "minimal", label: "Change as little as possible", sentence: "Change as little of my wording as possible." },
  { id: "format", label: "Leave formatting alone", sentence: "Do not change formatting unless I ask." },
  { id: "short_sentences", label: "Short sentences", sentence: "Use short sentences." },
  { id: "no_exclaim", label: "No exclamation marks", sentence: "Do not use exclamation marks." },
];
const IDS = TRAITS.map((t) => t.id);
const EXCLUSIVE = ["formal", "relaxed"]; // switch each other off: the last one chosen stays

// a SettingsError, so the server answers it as a 400 with no new error path
export class StyleError extends SettingsError {
  constructor(message) {
    super(400, message);
  }
}

const file = () => path.join(stateDir(), "style.json");

/** Known ids once each, formal/relaxed reduced to the last one given. */
function cleanTraits(list) {
  const out = [];
  for (const id of list) if (IDS.includes(id) && !out.includes(id)) out.push(id);
  const last = [...out].reverse().find((id) => EXCLUSIVE.includes(id));
  return out.filter((id) => !EXCLUSIVE.includes(id) || id === last);
}

/** A missing or broken file reads as empty; an unknown id in it is dropped. */
function parse(text) {
  let raw = null;
  try {
    raw = JSON.parse(text);
  } catch {}
  const traits = cleanTraits(Array.isArray(raw?.traits) ? raw.traits.filter((x) => typeof x === "string") : []);
  const words = typeof raw?.words === "string" ? userText(raw.words, Infinity).replace(/\s+/g, " ").trim().slice(0, MAX_WORDS) : "";
  return { traits, words };
}

let known = null; // {raw, style}: the exact file text this server last wrote or first read (null = no file), and what it parses to
let outside = 0; // outside changes found and put back since this server started

/** Re-reads the file. The first read is trusted; after that, any other text (a missing file included) is put back from the copy. */
function check() {
  let raw = null;
  try {
    raw = fs.readFileSync(file(), "utf8");
  } catch {}
  if (!known) known = { raw, style: parse(raw) };
  else if (raw !== known.raw) {
    outside++;
    try {
      if (known.raw === null) fs.rmSync(file(), { force: true });
      else writeStateFile(file(), known.raw);
    } catch {} // the copy is still what counts, even when the file cannot be put back
  }
  return { traits: [...known.style.traits], words: known.style.words };
}

/** Read per call, through the guard: what this server last wrote, never a file someone else changed. */
export const readStyle = () => check();

/**
 * Checks the file now (putting it back if it changed) and returns how many outside changes this server has found and undone since it
 * started. It never resets: a caller keeps the number from when a batch was delivered and compares it at done.
 */
export function styleChangedOutside() {
  check();
  return outside;
}

/** Strict (length is counted after stripping and collapsing, never cut first): an unknown preference id, a non-array or more than 280 characters is a 400 and nothing is written. */
export function writeStyle(input) {
  const b = input && typeof input === "object" && !Array.isArray(input) ? input : null;
  check(); // an outside change is counted and undone even when this write is refused
  if (!b) throw new StyleError("style must be an object");
  if (!Array.isArray(b.traits) || b.traits.some((id) => typeof id !== "string" || !IDS.includes(id))) throw new StyleError(`traits must be a list of: ${IDS.join(", ")}`);
  if (b.words !== undefined && typeof b.words !== "string") throw new StyleError("words must be text");
  const words = userText(b.words ?? "", Infinity).replace(/\s+/g, " ").trim();
  if ([...words].length > MAX_WORDS) throw new StyleError(`words can be at most ${MAX_WORDS} characters`);
  ensureStateDir();
  const style = { traits: cleanTraits(b.traits), words };
  const raw = JSON.stringify(style, null, 2) + "\n";
  writeStateFile(file(), raw);
  known = { raw, style }; // only after the write succeeded
  return { traits: [...style.traits], words };
}

/** The text for `instructions.style_note`, or "" when nothing is chosen. About 540 characters at most by construction (cap 700). */
export function styleNote(style = readStyle()) {
  const fixed = TRAITS.filter((t) => style.traits.includes(t.id)).map((t) => t.sentence);
  if (!fixed.length && !style.words) return "";
  return ["How I like text written:", ...fixed, ...(style.words ? [`Also: ${style.words}`] : [])].join(" ");
}
