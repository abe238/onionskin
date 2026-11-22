// The agent's progress on a delivered batch, as the server names it (session.stage). A missing stage (an older server, or a
// state with no delivery) falls back to the plain "working" wording and no progress line.

export const STAGES = [
  ["delivered", "The agent has your batch"],
  ["writing", "Writing your changes"],
  ["checking", "Checking the file"],
];

export const LOCAL_STAGE = "Doing this on your Mac";
export const VOICE_STAGE = "The agent is writing your voice guide.";

/** {text, step, of}: step is 1..3 while a stage is known, 0 when it is not (then the caller draws no progress). */
export function stageOf(session) {
  const i = STAGES.findIndex(([k]) => k === session?.stage);
  const working = session?.state === "working" || session?.state === "queued";
  if (!working) return { text: "", step: 0, of: STAGES.length, key: null };
  if (session.runKind === "voice") return { text: VOICE_STAGE, step: 0, of: STAGES.length, key: "voice" }; // a draft of the voice guide: no progress line
  if (session.local || session.stage === "local") return { text: LOCAL_STAGE, step: 0, of: STAGES.length, key: "local" }; // a run on this Mac: no agent, no progress line
  if (i < 0) return { text: "Agent is working", step: 0, of: STAGES.length, key: null };
  return { text: STAGES[i][1], step: i + 1, of: STAGES.length, key: STAGES[i][0] };
}

/**
 * The top bar's line while a run holds the batch (session.locked). Word, Excel and PowerPoint take typing then, merged when the run ends:
 * the stage's words and "keep editing". An HTML file is read-only during a run (comments still go in), so it says that instead.
 */
export function lockedSyncText(session) {
  if (session?.format === "html") return "Agent working: comment now, fix text after";
  if (session?.format === "markdown") return "Agent working: comment now";
  const st = stageOf(session); // the banner's own words while an agent has the batch ("The agent has your batch")
  return session?.local ? "Working on this Mac: keep editing" : `${["delivered", "writing", "checking"].includes(st.key) ? st.text : "Agent working"}: keep editing`;
}

// ---- the wait, in words (the banner, the top bar and the review panel read these) --------------------------------------

/**
 * Words for the window after Send when a batch is saved but no agent has it yet (session state "stranded"): the agent is starting, is waiting for a
 * free slot, or nobody is listening yet. "" in every other state. The server names no grace countdown, so none is claimed here.
 */
export function pendingWords(session) {
  if (session?.state !== "stranded") return "";
  const a = session.agent;
  if (a?.state === "starting") return a.busy ? "Waiting for a free agent. Another document's agent is busy" : "Starting the agent for your batch";
  if (a?.state === "external" || a?.state === "handover") return "";
  return "Your batch is saved. Waiting for an agent";
}

/**
 * The newest fixed-words line of the agent's current turn, or "". The list is a rolling log, so lines from an earlier batch must not show as this
 * one's progress: a line counts only from the last "Got your batch" on, and once "Done." or "Waiting for you to press Send" follows it, nothing counts
 * until the next batch is got.
 */
export function progressOf(agent) {
  const items = agent?.activity;
  if (!Array.isArray(items) || !["working", "ready"].includes(agent.state)) return "";
  const texts = items.map((it) => String(it?.text || ""));
  const from = texts.findLastIndex((t) => t.startsWith("Got your batch"));
  if (from < 0) return "";
  const after = texts.slice(from);
  if (after.some((t) => t.startsWith("Done.") || t === "Waiting for you to press Send")) return ""; // that batch is over: what follows belongs to the next one
  return after.findLast((t) => t) || "";
}

/** "12 s", "1 min 05 s": the local wait counter. */
export function elapsedText(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
}

/** Whether Stop belongs in the banner, and which kind: "stop" for the background agent this page can cancel, "takeback" for the person's own agent session (nothing is signaled; with "stop" the banner shows no separate Take back), null for none. */
export function stopKind(session, readOnly) {
  if (readOnly || !(session?.state === "working" || session?.state === "queued") || session.local) return null;
  const a = session.agent?.state;
  if (a === "external" || a === "handover") return "takeback";
  return ["starting", "ready", "working"].includes(a) ? "stop" : null;
}

/** The note box after Stop: the withdrawn batch's note, then a note typed and not saved yet, unless it is already there as whole paragraphs (src/notes.js). */
export { joinNote as noteAfterStop } from "../../src/notes.js";
