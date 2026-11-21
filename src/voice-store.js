// Learning evidence and the saved voice guide, per machine, in the state dir (all 0600, written with writeStateFile).
//   voice-evidence.json: {v:1, learning, pairs:[{at, short, sentences, exclaim, restored, fmt}] (last 30, booleans only),
//     hits:[{at, trait}] (last 40, comment-phrase trait ids only), examples:[{id, at, agent, mine}] (last 30, untrusted, each side at most
//     400 characters), answers:{<trait>: {later: <pairs kept at the time>} | {never: true}}}. It never holds a file name or a comment.
//   voice-guide.json: {v:1, text, on, send?: "short"}: the person's own saved guide, at most 7,000 characters. `send: "short"` sends only
//     its "In short" section (src/voice-guide.js); no `send` means the full guide.
//   voice-draft.json: {v:1, at, batch_id, text}: the agent's latest draft of a guide, waiting for the person's review. Agent text: it is
//     checked by cleanVoiceDraft on the way in and again on every read, and nothing copies it into the guide (only the person's Save does).
// Reads are strict: anything that does not fit the shape is dropped record by record. A missing evidence file reads as empty with
// learning on (the default); a file that is there but cannot be trusted as a whole (oversized, a link, not a regular file, someone else's,
// unreadable, not JSON, the wrong version, no boolean switch) reads as empty with learning OFF, so a switch the person turned off never
// fails open and nothing new is recorded until they turn it on again. Every write goes through the validation below, so a bad call
// changes nothing.
// Guard on voice-guide.json (the same pattern as style.json in src/style.js): this module keeps the exact file text it last wrote or first
// read, and re-reads the file on every read. A file changed by anything else while the server runs is put back from that copy and
// counted (guideChangedOutside). Ceiling: the copy lives in memory, so a change made while no server runs (an agent with a shell can stop
// it) is trusted by the next server's first read.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkRegularOwned } from "./fsutil.js";
import { ensureStateDir, stateDir, writeStateFile } from "./paths.js";
import { userText } from "./sanitize.js";
import { SettingsError } from "./settings.js";
import { TRAITS } from "./style.js";
import { COMMENT_TRAITS, SIGNALS, exampleSide } from "./voice.js";
import { GUIDE_MAX, cleanVoiceDraft, shortForm } from "./voice-guide.js";

export { GUIDE_MAX };
export const MAX_PAIRS = 30;
export const MAX_HITS = 40;
export const MAX_EXAMPLES = 30;
export const SENDS = ["full", "short"];
const MAX_FILE_BYTES = 256 * 1024; // the largest valid evidence file is far below this; a bigger file is not ours

const TRAIT_IDS = TRAITS.map((t) => t.id);
const ANSWERS = ["later", "never"];
const ID = /^[0-9a-f]{12}$/;

export class VoiceError extends SettingsError {
  constructor(message) {
    super(400, message);
  }
}

const evidenceFile = () => path.join(stateDir(), "voice-evidence.json");
const guideFile = () => path.join(stateDir(), "voice-guide.json");
const draftFile = () => path.join(stateDir(), "voice-draft.json");
const emptyEvidence = () => ({ v: 1, learning: true, pairs: [], hits: [], examples: [], answers: {} });

/**
 * Parsed version-1 JSON object from a plain file of ours; "missing" when nothing is there (lstat ENOENT only: a dangling link is there);
 * null for anything else (link, not a regular file, someone else's, too big, unreadable, not an object, another version).
 */
function readObject(file) {
  try {
    if (checkRegularOwned(file).size > MAX_FILE_BYTES) return null;
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) && raw.v === 1 ? raw : null;
  } catch (err) {
    return err?.code === "ENOENT" ? "missing" : null;
  }
}
const at = (x) => Number.isSafeInteger(x) && x >= 0;
const plain = (x) => x && typeof x === "object" && !Array.isArray(x);

function cleanPair(p) {
  if (!plain(p) || !at(p.at) || SIGNALS.some((s) => typeof p[s] !== "boolean")) return null;
  return { at: p.at, ...Object.fromEntries(SIGNALS.map((s) => [s, p[s]])) };
}
const cleanHit = (h) => (plain(h) && at(h.at) && typeof h.trait === "string" && COMMENT_TRAITS.includes(h.trait) ? { at: h.at, trait: h.trait } : null);
const exampleId = (agent, mine) => crypto.createHash("sha256").update(`${agent}\0${mine}`).digest("hex").slice(0, 12);
function cleanExample(e) {
  if (!plain(e) || !at(e.at) || typeof e.agent !== "string" || typeof e.mine !== "string") return null;
  // the same side rule as exampleOf: empty, too long, an invisible character or a link is refused, never cleaned or cut
  const agent = exampleSide(e.agent);
  const mine = exampleSide(e.mine);
  if (agent == null || mine == null) return null;
  return { id: exampleId(agent, mine), at: e.at, agent, mine };
}
function cleanAnswers(a) {
  const out = {};
  if (!plain(a)) return out;
  for (const trait of TRAIT_IDS) {
    if (!Object.hasOwn(a, trait) || !plain(a[trait])) continue;
    if (a[trait].never === true) out[trait] = { never: true };
    else if (Number.isSafeInteger(a[trait].later) && a[trait].later >= 0) out[trait] = { later: a[trait].later };
  }
  return out;
}
const list = (x, clean, max) => (Array.isArray(x) ? x.map(clean).filter(Boolean).slice(-max) : []);

/** The stored evidence, validated. No file reads as empty with learning on; a broken file reads as empty with learning off (fail closed). */
export function readEvidence() {
  const raw = readObject(evidenceFile());
  if (raw === "missing") return emptyEvidence();
  if (!raw || typeof raw.learning !== "boolean") return { ...emptyEvidence(), learning: false };
  const pairs = list(raw.pairs, cleanPair, MAX_PAIRS);
  const examples = list(raw.examples, cleanExample, Infinity);
  const unique = examples.filter((e, i) => examples.findLastIndex((x) => x.id === e.id) === i).slice(-MAX_EXAMPLES);
  const totalPairs = Number.isSafeInteger(raw.totalPairs) && raw.totalPairs >= pairs.length ? raw.totalPairs : undefined;
  return {
    v: 1,
    learning: raw.learning,
    pairs,
    ...(totalPairs !== undefined ? { totalPairs } : {}),
    hits: list(raw.hits, cleanHit, MAX_HITS),
    examples: unique,
    answers: cleanAnswers(raw.answers),
  };
}

function save(ev) {
  ensureStateDir();
  writeStateFile(evidenceFile(), JSON.stringify(ev, null, 2) + "\n");
  return ev;
}

/**
 * Appends one Send's records and returns the stored evidence. `pairs` are the worker's signal objects, `hits` trait ids from commentHits,
 * `examples` the worker's {agent, mine}; `now` stamps them. Anything that does not validate is dropped, not stored. Does nothing (and writes
 * nothing) while learning is off. The newest records are kept, older ones fall off the front.
 */
export function appendRecords({ pairs = [], hits = [], examples = [] } = {}, now = Date.now()) {
  const ev = readEvidence();
  if (!ev.learning) return ev;
  const add = (items, clean) => (Array.isArray(items) ? items.map((x) => clean(plain(x) ? { ...x, at: now } : x)).filter(Boolean) : []);
  const newPairs = add(pairs, cleanPair);
  const newHits = add((Array.isArray(hits) ? hits : []).map((trait) => ({ trait })), cleanHit);
  const prevTotal = Number.isSafeInteger(ev.totalPairs) && ev.totalPairs >= ev.pairs.length ? ev.totalPairs : ev.pairs.length;
  const next = {
    ...ev,
    pairs: [...ev.pairs, ...newPairs].slice(-MAX_PAIRS),
    totalPairs: prevTotal + newPairs.length,
    hits: [...ev.hits, ...newHits].slice(-MAX_HITS),
    examples: [...ev.examples, ...add(examples, cleanExample)],
  };
  next.examples = next.examples.filter((e, i) => next.examples.findLastIndex((x) => x.id === e.id) === i).slice(-MAX_EXAMPLES);
  return save(next);
}

/** "Not now" ({later: total pairs seen so far}) or "Don't suggest this" ({never}) for one trait. An unknown trait or action is a 400, nothing written. */
export function setAnswer(trait, action) {
  if (typeof trait !== "string" || !TRAIT_IDS.includes(trait)) throw new VoiceError(`trait must be one of: ${TRAIT_IDS.join(", ")}`);
  if (typeof action !== "string" || !ANSWERS.includes(action)) throw new VoiceError(`action must be one of: ${ANSWERS.join(", ")}`);
  const ev = readEvidence();
  const total = Number.isSafeInteger(ev.totalPairs) && ev.totalPairs >= ev.pairs.length ? ev.totalPairs : ev.pairs.length;
  return save({ ...ev, answers: { ...ev.answers, [trait]: action === "never" ? { never: true } : { later: total } } });
}

/** Forget the kept edits, comment hits and examples. The learning switch stays; "never" answers stay (a choice, not evidence); "later" goes (it counted kept pairs). */
export function forget() {
  const ev = readEvidence();
  const answers = Object.fromEntries(Object.entries(ev.answers).filter(([, a]) => a.never === true));
  return save({ ...emptyEvidence(), learning: ev.learning, answers });
}

/** The "Learn from my edits" switch. Turning it off keeps what is stored (Forget empties it) and stops new records. */
export function setLearning(on) {
  if (typeof on !== "boolean") throw new VoiceError("learning must be true or false");
  return save({ ...readEvidence(), learning: on });
}

// Characters the person cannot see in the guide box (tag characters, variation selectors, zero-width spaces, U+206A to U+206F, CGJ, soft
// hyphen, U+180E, format characters such as U+FFF9): stripped from the guide, which goes to the agent. A lone zero-width non-joiner or
// joiner (U+200C, U+200D) stays: Persian and several Indic scripts need it to spell a word, and emoji sequences use it; two or more in a
// row, which spell nothing, go. Private-use and unassigned code points stay (they show as a box, and a newer emoji would otherwise vanish).
// Cost: an emoji written with U+FE0F can show in its plain text style.
const GUIDE_HIDDEN = /[\p{Default_Ignorable_Code_Point}\p{Cf}]/gu;
const JOINERS = /[\u200C\u200D]{2,}/g;
const guideText = (value) =>
  userText(value, Infinity)
    .replace(GUIDE_HIDDEN, (c) => (c === "\u200C" || c === "\u200D" ? c : ""))
    .replace(JOINERS, "");

const NO_GUIDE = () => ({ text: "", on: false });

/** What a guide file's text says: {text, on} plus `send: "short"` when chosen and possible. Broken, the wrong shape or over the cap is no guide. */
function parseGuideFile(raw) {
  let obj = null;
  try {
    obj = raw == null ? null : JSON.parse(raw);
  } catch {}
  if (!plain(obj) || obj.v !== 1 || typeof obj.text !== "string" || typeof obj.on !== "boolean") return NO_GUIDE();
  const text = guideText(obj.text);
  if ([...text].length > GUIDE_MAX) return NO_GUIDE();
  // a short form the text no longer holds (a hand-edited file) sends the full guide, which the person also approved
  return obj.send === "short" && shortForm(text) ? { text, on: obj.on, send: "short" } : { text, on: obj.on };
}

// The guide as a file beside the skill, read the way a .env is: skills/onionskin/voice.md in this app's folder (never in git, never in the
// zip; voice.example.md beside it is the sample). It is the guide, switched on, while nothing is saved in the state folder; a guide saved
// from the page is stored there and wins from then on. ONIONSKIN_VOICE_FILE names another file ("" turns this off). A custom state folder
// (ONIONSKIN_STATE_DIR, as every test uses) reads no file unless ONIONSKIN_VOICE_FILE is set, so an isolated state stays isolated.
const VOICE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "skills", "onionskin", "voice.md");
function fileGuide() {
  const named = process.env.ONIONSKIN_VOICE_FILE;
  if (named === "" || (named === undefined && process.env.ONIONSKIN_STATE_DIR)) return NO_GUIDE();
  try {
    const file = named ?? VOICE_FILE;
    if (checkRegularOwned(file).size > MAX_FILE_BYTES) return NO_GUIDE();
    const text = guideText(fs.readFileSync(file, "utf8")).trim();
    return text && [...text].length <= GUIDE_MAX ? { text, on: true } : NO_GUIDE();
  } catch {
    return NO_GUIDE(); // no file is the usual case
  }
}

const NOT_OURS = Symbol("not ours"); // a link, not a regular file, someone else's, too big or unreadable: never read, never written through
/** The guide file's exact text; null when there is none (lstat ENOENT only: a dangling link is there); NOT_OURS for anything else. */
function rawGuideFile() {
  try {
    if (checkRegularOwned(guideFile()).size > MAX_FILE_BYTES) return NOT_OURS;
    return fs.readFileSync(guideFile(), "utf8");
  } catch (err) {
    return err?.code === "ENOENT" ? null : NOT_OURS;
  }
}

let known = null; // {raw, guide}: the guide file text this server last wrote or first read (null = no file), and what it parses to
let outside = 0; // outside changes found and put back since this server started

/**
 * Re-reads the guide file. The first read is trusted; after that, any other text (a missing file or a link included) is put back from
 * the copy: the copy is written again (writeStateFile renames over a link, never through it), or the file removed when there was none.
 * A first read that found a file that is not ours reads as no guide and leaves that file alone.
 */
function checkGuide() {
  const raw = rawGuideFile();
  if (!known) known = { raw, guide: raw === NOT_OURS ? NO_GUIDE() : raw === null ? fileGuide() : parseGuideFile(raw) };
  else if (raw !== known.raw) {
    outside++;
    try {
      if (known.raw === null) fs.rmSync(guideFile(), { force: true });
      else if (known.raw !== NOT_OURS) writeStateFile(guideFile(), known.raw);
    } catch {} // the copy is still what counts, even when the file cannot be put back
  }
  return { ...known.guide };
}

/** The saved guide, through the guard: {text, on} and `send: "short"` when the person chose the short form. No guide reads as {text: "", on: false}. */
export const readGuide = () => checkGuide();

/**
 * Checks the guide file now (putting it back if it changed) and returns how many outside changes this server has found and undone since
 * it started. It never resets: a caller keeps the number from when a batch was delivered and compares it at done.
 */
export function guideChangedOutside() {
  checkGuide();
  return outside;
}

/**
 * Strict: exactly what the box showed, control, bidi and invisible characters stripped. More than 7,000 characters (counted after
 * stripping) is a 400 and nothing is written, never a cut. `send` is "full" (the default) or "short"; "short" needs an "In short" section
 * of at most 700 characters, or it is a 400.
 */
export function writeGuide({ text, on, send = "full" } = {}) {
  checkGuide(); // an outside change is counted and undone even when this write is refused
  if (typeof text !== "string") throw new VoiceError("the guide must be text");
  if (typeof on !== "boolean") throw new VoiceError("on must be true or false");
  if (typeof send !== "string" || !SENDS.includes(send)) throw new VoiceError(`send must be one of: ${SENDS.join(", ")}`);
  const clean = guideText(text).trim();
  if ([...clean].length > GUIDE_MAX) throw new VoiceError(`the guide can be at most ${GUIDE_MAX} characters`);
  if (send === "short" && !shortForm(clean)) throw new VoiceError('the short form needs an "In short" section of at most 700 characters');
  ensureStateDir();
  const raw = JSON.stringify({ v: 1, text: clean, on, ...(send === "short" ? { send } : {}) }, null, 2) + "\n";
  writeStateFile(guideFile(), raw);
  known = { raw, guide: parseGuideFile(raw) }; // only after the write succeeded
  return { ...known.guide };
}

/** The guide text for `instructions.voice_guide`: "" unless a guide is saved and switched on; only "In short" when the person chose the short form. */
export const voiceGuide = () => {
  const g = readGuide();
  if (!g.on) return "";
  return g.send === "short" ? shortForm(g.text) : g.text;
};

// ---- the agent's draft ---------------------------------------------------------------------------------------------------------

const BATCH_ID = /^b_[0-9a-f]{12}$/;

/**
 * The draft waiting for review: {at, batch_id, text, sections}, or null. Re-checked on every read with cleanVoiceDraft: a file that is
 * missing, not ours, the wrong shape, or holds a draft that would be refused now reads as no draft.
 */
export function readDraft() {
  const raw = readObject(draftFile());
  if (!plain(raw) || !at(raw.at) || typeof raw.batch_id !== "string" || !BATCH_ID.test(raw.batch_id) || typeof raw.text !== "string") return null;
  const d = cleanVoiceDraft(raw.text);
  return d.code ? null : { at: raw.at, batch_id: raw.batch_id, text: d.text, sections: d.sections };
}

/**
 * Stores an agent's draft in place of any earlier one. Strict: a batch id that is not one, more than 32 KB, or a draft that
 * cleanVoiceDraft refuses throws a VoiceError carrying `code` and writes nothing. Returns what readDraft will return.
 */
export function writeDraft({ batch_id, text } = {}, now = Date.now()) {
  if (typeof batch_id !== "string" || !BATCH_ID.test(batch_id)) throw new VoiceError("batch_id must be a batch id");
  const d = cleanVoiceDraft(text); // not text is bad_structure, over 32 KB too_long, before anything else runs
  if (d.code) throw Object.assign(new VoiceError(d.reason), { code: d.code });
  ensureStateDir();
  writeStateFile(draftFile(), JSON.stringify({ v: 1, at: now, batch_id, text: d.text }, null, 2) + "\n");
  return { at: now, batch_id, text: d.text, sections: d.sections };
}

/** "Discard draft": removes the draft file (a link is removed as a link, its target untouched). Nothing there is fine. */
export function discardDraft() {
  fs.rmSync(draftFile(), { force: true });
}
