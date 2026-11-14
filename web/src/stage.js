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
