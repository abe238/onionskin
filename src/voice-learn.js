// Learning at Send, stage 1 (code only), and the browser routes for it. The pure rules are in src/voice.js, the store in
// src/voice-store.js, the DOCX step in src/voice-worker.js; this module only joins them to the session and the server.
//
// What reaches the store from a Send: the five booleans per edit pair and the untrusted examples (from the worker, over three stored
// versions), and the trait ids that fixed English phrases in the person's own comments point at. Never a comment's text, a file name or a
// path. Everything here fails quietly: learning never stops a Send, and a step that fails learns nothing.
import { Worker } from "node:worker_threads";
import { buildVoiceBatch, printedSize } from "./batch.js";
import { env } from "./constants.js";
import { checkRegularOwned, readDoc, sha256 } from "./fsutil.js";
import { userText } from "./sanitize.js";
import { HttpError } from "./session.js"; // a cycle (session.js imports voiceJob from here): both only use each other inside functions
import { readStamps } from "./stamps.js";
import { BUILT_IN_STAMP_WORDS, STAMP_LANGUAGES } from "./stamp-words.js";
import { TRAITS, readStyle, styleNote, writeStyle } from "./style.js";
import { parseGuide } from "./voice-guide.js";
import { budget, pickRequests, pickRewrites, voiceBatchMax, voiceShares } from "./voice-samples.js";
import { VoiceError, appendRecords, discardDraft, forget, readDraft, readEvidence, readGuide, setAnswer, setLearning, writeGuide } from "./voice-store.js";
import { commentHits, suggestions } from "./voice.js";

const WORKER_TIMEOUT_MS = () => Number(env("VOICE_TIMEOUT_MS", 60_000));
const TRAIT_IDS = TRAITS.map((t) => t.id);

// The built-in stamps' words live in src/stamp-words.js (the server's copy of web/src/stamps.js); re-exported for test/voice-learn.test.js.
export { BUILT_IN_STAMP_WORDS, STAMP_LANGUAGES };

/**
 * Every text a stamp sends: the built-in words (each language for Translate) and the person's own stamps. A comment whose words are
 * exactly one of these was a tap, not typing, so its phrases are not counted ("Shorter" tapped four times is not four requests).
 * Ceiling: a stamp's words the person then edited before sending, or typed out by hand, count as typing.
 */
function stampTexts() {
  const out = new Set();
  for (const w of BUILT_IN_STAMP_WORDS) for (const l of w.includes("{language}") ? STAMP_LANGUAGES : [""]) out.add(w.replace("{language}", l));
  for (const s of readStamps()) out.add(s.words);
  return new Set([...out].map((w) => userText(w).trim()));
}

/**
 * What one Send gives learning, or null for nothing. `sent` are the comments that left draft in this Send (each counted once, when it
 * first goes out); `last` is the newest history update before this Send's own. The three versions are taken only when the file is a
 * Word document, this Send wrote the person's edits, the update before it is an agent run that ended on exactly the bytes this Send
 * started from, and all three versions are still stored: then pre (before the agent), post (what the agent wrote) and mine (what the
 * person sent) are linked through the agent's output. A Send after a Revert, an outside change or another Send of the person's has no
 * agent run right before it, so it gives no pair. Neither does a run done on this Mac (history kind `local`, src/local.js): its words are
 * the person's own, put in by a closed pattern, so edits on top of it say nothing about how a model writes. A quick fix's
 * "Use this" is the exception (`local` with `model: true`): the local writing model wrote that sentence, so edits on top of it are
 * rewrites of model text, the same reasoning as for an agent run. Nothing at all while learning is off.
 * Returns {key, versions: {pre, post, mine} (snapshot blob paths) | null, hits: [trait ids]}.
 */
export function voiceJob(s, { last = null, diskSha = null, writtenSha = null, sent = [] } = {}) {
  if (!readEvidence().learning) return null;
  const stamps = stampTexts();
  // a re-sent answered question carries the words already counted when it first went out
  const typed = sent.filter((c) => typeof c.text === "string" && !c.answer && !stamps.has(c.text.trim()));
  const hits = typed.flatMap((c) => commentHits(c.text));
  let versions = null;
  if (s.format === "docx" && diskSha && writtenSha && writtenSha !== diskSha && (last?.kind === "agent" || (last?.kind === "local" && last.model === true)) && last.after === diskSha && last.before !== diskSha) {
    const shas = [last.before, diskSha, writtenSha];
    if (shas.every((h) => s.snapshots.has(h))) versions = { pre: s.snapshots.blob(shas[0]), post: s.snapshots.blob(shas[1]), mine: s.snapshots.blob(shas[2]) };
  }
  if (!versions && !hits.length) return null;
  return { key: s.key, versions, hits };
}

const running = new Set(); // live workers, ended by stopVoice
let epoch = 0; // moved on by Forget and the learning switch: a job that started before either stores nothing

/** Runs src/voice-worker.js over three blob paths. Resolves {pairs, examples}, or null when it fails, crashes or times out (then it is ended). */
function analyze(versions) {
  return new Promise((resolve) => {
    let worker;
    let settled = false;
    let timer = null;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      running.delete(worker);
      worker?.terminate();
      resolve(r);
    };
    try {
      worker = new Worker(new URL("./voice-worker.js", import.meta.url), { workerData: versions });
    } catch {
      return finish(null);
    }
    running.add(worker);
    timer = setTimeout(() => finish(null), WORKER_TIMEOUT_MS());
    worker.once("message", (m) => finish(m?.ok ? { pairs: m.pairs, examples: m.examples } : null));
    worker.once("error", () => finish(null));
    worker.once("exit", () => finish(null));
  });
}

/** The server's `voice` listener: stores the comment hits at once, then the worker's pairs and examples. Never throws. */
export async function learnFromSend(job) {
  try {
    const started = epoch;
    if (job.hits?.length) appendRecords({ hits: job.hits });
    if (!job.versions) return;
    const r = await analyze(job.versions);
    if (r && epoch === started) appendRecords({ pairs: r.pairs, examples: r.examples });
  } catch {} // learning is never worth a failed Send or a crashed server
}

/** Ends every running learning worker (the server is stopping). */
export function stopVoice() {
  for (const w of [...running]) w.terminate();
  running.clear();
}

// ---- browser routes (cookie, launch token, Origin: checked by the server before these run) ------------------------------------

export const VOICE_POSTS = ["/api/voice/answer", "/api/voice/guide", "/api/voice/forget", "/api/voice/learning", "/api/voice/draft/discard"];
/** The body cap of POST /api/voice/guide: a 7,000-character guide in a script of up to 4 UTF-8 bytes a character, plus the envelope. */
export const GUIDE_BODY_MAX = 32 * 1024;
const ANSWER_ACTIONS = ["on", "later", "never"];

/**
 * GET /api/voice. `suggestions` are fixed trait ids and whole numbers only (the page writes every sentence from its own templates);
 * `examples` are untrusted document-derived text, shown as text and exported only when ticked; `guide` and `style` are the person's own.
 */
export function voiceState() {
  const ev = readEvidence();
  const style = readStyle();
  const guide = readGuide();
  const draft = readDraft(); // re-checked on every read; agent text, shown as plain text and never saved without the person
  return {
    learning: ev.learning,
    suggestions: suggestions(ev, style),
    examples: ev.examples.map(({ id, agent, mine }) => ({ id, agent, mine })),
    examples_untrusted: true,
    examples_count: ev.examples.length,
    guide: { text: guide.text, on: guide.on, send: guide.send || "full", structured: parseGuide(guide.text).structured },
    draft: draft ? { text: draft.text, at: draft.at, batch_id: draft.batch_id } : null,
    draft_untrusted: true,
    style,
  };
}

/** Only these fields, nothing else: a page that sends any other field (text for a suggestion, say) gets a 400 and nothing is written. */
function only(body, keys) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new VoiceError("the request must be an object");
  const extra = Object.keys(body).filter((k) => !keys.includes(k));
  if (extra.length) throw new VoiceError(keys.length ? `only ${keys.join(" and ")} can be sent` : "nothing can be sent with this request");
}

/** POST /api/voice/*. Strict: a wrong shape is a 400 (VoiceError or StyleError) and writes nothing. Returns voiceState(). */
export function voicePost(p, body) {
  if (p === "/api/voice/answer") {
    only(body, ["trait", "action"]);
    const { trait, action } = body;
    if (typeof trait !== "string" || !TRAIT_IDS.includes(trait)) throw new VoiceError(`trait must be one of: ${TRAIT_IDS.join(", ")}`);
    if (typeof action !== "string" || !ANSWER_ACTIONS.includes(action)) throw new VoiceError(`action must be one of: ${ANSWER_ACTIONS.join(", ")}`);
    if (action === "on") {
      // the sentence that goes to the agent is the trait's constant in src/style.js; the person's own words stay as they are
      const cur = readStyle();
      writeStyle({ traits: [...cur.traits, trait], words: cur.words });
    } else setAnswer(trait, action);
  } else if (p === "/api/voice/guide") {
    only(body, ["text", "on", "send"]);
    writeGuide({ text: body.text, on: body.on, send: body.send }); // more than 7,000 characters is a 400, never a cut; no send is the full guide
  } else if (p === "/api/voice/forget") {
    only(body, []);
    epoch++;
    forget();
  } else if (p === "/api/voice/learning") {
    only(body, ["on"]);
    if (typeof body.on !== "boolean") throw new VoiceError("on must be true or false");
    epoch++;
    setLearning(body.on);
  } else if (p === "/api/voice/draft/discard") {
    // `at` names the draft that was on screen: a newer one that arrived meanwhile was never read, and stays
    only(body, ["at"]);
    if (!Number.isSafeInteger(body.at) || body.at < 0) throw new VoiceError("at must be the time of the draft on screen");
    if (readDraft()?.at === body.at) discardDraft();
  } else throw new VoiceError("unknown request");
  return voiceState();
}

// ---- "Build my voice guide" (stage 2): the request ------------------------------------------------------------------------------

export const MAX_ADDED = 5; // added sources in all: files plus pasted texts
export const ADDED_FILE_MAX = 20 * 1024 * 1024;
export const PASTE_MAX = 20_000;
const FILE_FORMATS = ["docx", "pptx", "text"];
const BUILD_FIELDS = ["open_file", "edits", "comments", "improve", "texts", "files"];
const AGENT_PAIRS_MAX = 20; // the newest agent runs whose two versions are read to leave their text out
/** The body cap of POST /api/voice/build (instead of MAX_BODY): five 20 MB files in base64, plus 1 MB. */
export const VOICE_BUILD_MAX_BODY = Math.ceil((MAX_ADDED * ADDED_FILE_MAX * 4) / 3) + 1024 * 1024;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const SAMPLE_TIMEOUT_MS = () => Number(env("VOICE_SAMPLE_TIMEOUT_MS", 60_000));

const NO_SAMPLE = "Choose at least one sample of your writing.";
const UNREADABLE = "That file could not be read. Choose a Word, PowerPoint or text file.";

const httpError = (status, message, code) => new HttpError(status, message, { code });

/** One added file {format, bytesB64}: exact fields, a known format, strict base64 (Buffer.from never fails on bad input), 1 byte to 20 MB. */
function addedFile(f) {
  if (!f || typeof f !== "object" || Array.isArray(f)) throw new VoiceError(UNREADABLE);
  if (Object.keys(f).some((k) => k !== "format" && k !== "bytesB64")) throw new VoiceError("a file is only {format, bytesB64}");
  if (!FILE_FORMATS.includes(f.format) || typeof f.bytesB64 !== "string") throw new VoiceError(UNREADABLE);
  if (f.bytesB64.length > Math.ceil((ADDED_FILE_MAX * 4) / 3) + 4) throw new VoiceError("Each file can be up to 20 MB.");
  if (!f.bytesB64 || f.bytesB64.length % 4 !== 0 || !BASE64.test(f.bytesB64)) throw new VoiceError(UNREADABLE);
  const bytes = Buffer.from(f.bytesB64, "base64");
  if (bytes.length > ADDED_FILE_MAX) throw new VoiceError("Each file can be up to 20 MB.");
  return { format: f.format, bytes };
}

/** The person's typed comments in this file (stamp taps left out: they are not typing), oldest first. */
function typedComments(s) {
  const stamps = stampTexts();
  return (s.comments || []).filter((c) => typeof c.text === "string" && c.text.trim() && !stamps.has(c.text.trim())).map((c) => c.text);
}

/** The stored version pairs of the agent and local runs on this file, newest last, for leaving what they wrote out of the open file's sample. */
function agentPairs(s) {
  const runs = (s.history || []).filter((u) => (u.kind === "agent" || u.kind === "local") && s.snapshots.has(u.before) && s.snapshots.has(u.after));
  return runs.slice(-AGENT_PAIRS_MAX).map((u) => ({ before: s.snapshots.blob(u.before), after: s.snapshots.blob(u.after) }));
}

/** Runs src/voice-sample-worker.js. Resolves {sources} or {error: code}; a crash or a timeout (60 s) is "unreadable" and the worker is ended. */
function sampleInWorker(job) {
  return new Promise((resolve) => {
    let worker;
    let settled = false;
    let timer = null;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      running.delete(worker);
      worker?.terminate();
      resolve(r);
    };
    try {
      worker = new Worker(new URL("./voice-sample-worker.js", import.meta.url), { workerData: job });
    } catch {
      return finish({ error: "unreadable" });
    }
    running.add(worker);
    timer = setTimeout(() => finish({ error: "unreadable" }), SAMPLE_TIMEOUT_MS());
    worker.once("message", (m) => finish(m?.ok && Array.isArray(m.sources) ? { sources: m.sources } : { error: m?.code || "unreadable" }));
    worker.once("error", () => finish({ error: "unreadable" }));
    worker.once("exit", () => finish({ error: "unreadable" }));
  });
}

/**
 * POST /api/voice/build?s=<key> {open_file, edits, comments, improve, texts, files}: the person pressed "Ask the agent". Every field is
 * required and checked exactly; anything else is a 400 and nothing is sent. Only what they ticked or added goes in, and only as untrusted
 * evidence: the open file's saved version (`open_file`, not for Excel), their rewrites of the agent's text (`edits`), their typed comments
 * (`comments`), up to 5 added files (Word, PowerPoint or UTF-8 text, at most 20 MB each, parsed in a worker with a 60 s limit) and pasted
 * texts (at most 20,000 characters each). `improve` sends the guide they saved. Nothing is stored apart from the batch. The batch is
 * trimmed to fit what `poll` prints (src/voice-samples.js budget) and handed to Sessions.requestVoice. Returns the session.
 */
export async function buildVoiceRequest(sessions, key, body) {
  only(body, BUILD_FIELDS);
  for (const k of ["open_file", "edits", "comments", "improve"]) if (typeof body[k] !== "boolean") throw new VoiceError(`${k} must be true or false`);
  if (!Array.isArray(body.texts) || !Array.isArray(body.files)) throw new VoiceError("texts and files must be lists");
  if (body.texts.length + body.files.length > MAX_ADDED) throw new VoiceError("You can add up to 5 in all.");
  for (const t of body.texts) {
    if (typeof t !== "string" || !t.trim()) throw new VoiceError(NO_SAMPLE);
    if ([...t].length > PASTE_MAX) throw new VoiceError("Pasted text can be up to 20,000 characters.");
  }
  const files = body.files.map(addedFile);
  const s = sessions.get(key);
  if (s.closed) throw httpError(409, "session closed", "closed");
  if (s.pending || s.delivered) throw httpError(409, "Wait for the agent to finish, then try again.", "busy");
  if (body.open_file && s.format === "xlsx") throw new VoiceError("Excel files are not used as writing samples.");
  const examples = body.edits ? readEvidence().examples : [];
  if (!body.open_file && !files.length && !body.texts.length && !examples.length) throw new VoiceError(NO_SAMPLE);
  const saved = readGuide();
  if (body.improve && !saved.text) throw new VoiceError("There is no saved guide to improve.");

  let open = null;
  if (body.open_file) {
    let bytes;
    try {
      checkRegularOwned(s.file);
      bytes = readDoc(s.file);
    } catch {
      throw httpError(409, "This file could not be read. Reload it, then try again.", "gone");
    }
    if (sha256(bytes) !== s.baseSha) throw httpError(409, "The file changed outside Onionskin. Reload it, then try again.", "changed_since");
    open = { format: s.format, bytes, agentPairs: agentPairs(s) };
  }
  const baseSha = s.baseSha;
  const style = styleNote();
  const currentGuide = body.improve ? saved.text : "";
  const batch = buildVoiceBatch({ format: s.format, baseSha, style, currentGuide });
  const max = voiceBatchMax();
  const sources = (open ? 1 : 0) + files.length + body.texts.length;
  const shares = voiceShares({ fixed: printedSize(batch), sources, rewrites: body.edits, requests: body.comments, max });
  let sampled = { sources: [] };
  if (sources) {
    sampled = await sampleInWorker({ open, files, texts: body.texts, shares: shares.source });
    if (sampled.error) throw new VoiceError(UNREADABLE);
  }
  const evidence = {
    sources: sampled.sources,
    rewrites: body.edits ? pickRewrites(examples, shares.rewrites) : [],
    my_requests: body.comments ? pickRequests(typedComments(s), shares.requests) : [],
  };
  const withEvidence = (e) => ({ ...batch, untrusted_document_evidence: { ...batch.untrusted_document_evidence, voice_evidence: e } });
  const fitted = budget(evidence, (e) => printedSize(withEvidence(e)), max);
  if (!fitted) throw new VoiceError("This request is too large to send.");
  // requestVoice checks again: the worker took time, and a Send, a review or an outside change may have come in meanwhile
  if (s.baseSha !== baseSha) throw httpError(409, "The file changed. Try again.", "changed_since");
  sessions.requestVoice(key, withEvidence(fitted));
  return s;
}
