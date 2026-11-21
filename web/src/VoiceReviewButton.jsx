import React from "react";
import { reviewDraft, useDraftBatch, useGuidePending } from "./voice-bus.js";

// The text the server writes in an activity entry when it kept the agent's draft (src/session.js VOICE_KEPT): the button is only for that entry.
const KEPT = "The agent wrote a draft of your voice guide.";

/** "Review draft" in the activity entry of a voice run. It shows only on the entry of the batch whose draft is waiting. */
export function ReviewDraftButton({ a }) {
  const batch = useDraftBatch();
  const pending = useGuidePending();
  if (!batch || a.summary !== KEPT || a.batchId !== batch) return null;
  return (
    <button type="button" className="btn sm" data-testid="voice-review-draft-activity" disabled={pending} onMouseDown={(e) => e.preventDefault()} onClick={reviewDraft}>
      Review draft
    </button>
  );
}
