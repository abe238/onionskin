import React, { useEffect, useState } from "react";
import { BuildVoice } from "./BuildVoice.jsx";
import { api } from "./lib.js";
import { VoiceDialog } from "./VoiceDialog.jsx";
import { VoiceGuideEditor } from "./VoiceGuideEditor.jsx";
import { onReviewDraft, setDraftReady, useGuidePending } from "./voice-bus.js";

const keep = (e) => e.preventDefault();

/** The one line that says where the voice guide stands. Fixed wording; the draft is only ever named, never quoted. */
export function guideStatus(voice) {
  if (voice.draft) return "Voice guide: draft ready to review";
  const g = voice.guide || { text: "", on: false };
  if (!g.text) return "Voice guide: none";
  if (!g.on) return "Voice guide: saved, not sent";
  return g.send === "short" ? "Voice guide: saved, short form sent with every request" : "Voice guide: saved, sent with every request";
}

/**
 * The voice guide in the Writing preferences: its status, "Build my voice guide", "Open guide" and "Review draft", and the two windows
 * they open. It stays on the page while the panel is closed (so "Review draft" in the activity list can open the draft), and draws its
 * buttons only when `panel` is on. `children` are the Load and Save as voice.md buttons of the panel.
 */
export function VoiceGuideBlock({ sid, session, voice, onVoice, readOnly, panel, children, dirtyRef }) {
  const [dialog, setDialog] = useState(null); // {kind: "build" | "draft" | "guide", draft}: the draft as it was when the window opened, so a newer one never replaces what is being edited
  const [note, setNote] = useState("");
  const [removing, setRemoving] = useState(false); // the confirm window of "Remove guide"
  const [removeError, setRemoveError] = useState("");
  const draft = voice?.draft || null;
  const pending = useGuidePending();
  const busy = !!(session.pendingBatchId || session.deliveredBatchId);
  const voiceRun = busy && session.runKind === "voice"; // a voice request is out: the one line says where it stands, instead of the busy refusal and the note together
  const writing = voiceRun && !!session.deliveredBatchId; // only an agent that has taken the batch is writing; until then it is waiting
  const structured = !!voice?.guide?.structured && !!voice?.guide?.text;

  useEffect(() => setDraftReady(draft?.batch_id || ""), [draft]);
  useEffect(() => {
    if (!busy) return;
    return () => setNote(""); // when the agent finishes, "Sent to your agent." is no longer true
  }, [busy]);
  useEffect(() => () => setDraftReady(""), []);
  // "Review draft" in the activity list
  useEffect(() => onReviewDraft(() => voice?.draft && !readOnly && setDialog({ kind: "draft", draft: voice.draft })), [voice, readOnly]);

  if (!voice) return null;
  const status = guideStatus(voice);
  const close = () => setDialog((current) => current === dialog ? null : current);
  // the same route the "Load a voice guide" window's Remove guide uses: an empty text takes the saved guide away
  async function removeGuide() {
    setRemoveError("");
    try {
      onVoice(await api("/api/voice/guide", { method: "POST", body: { text: "", on: false } }));
      setRemoving(false);
      setNote("Your voice guide was removed.");
    } catch {
      setRemoveError("Could not remove it. Try again.");
    }
  }

  return (
    <>
      {panel ? (
        <div className="vc-block vg-block" data-testid="voice-guide-block">
          <p className="vg-status-line" data-testid="voice-guide-status">
            {status}
          </p>
          <div className="vc-row">
            <button type="button" className="btn sm" data-testid="voice-build-open" disabled={busy} onMouseDown={keep} onClick={() => (setNote(""), setDialog({ kind: "build" }))}>
              Build my voice guide
            </button>
            {draft && (
              <button type="button" className="btn sm" data-testid="voice-review-draft" disabled={pending} onMouseDown={keep} onClick={() => setDialog({ kind: "draft", draft })}>
                Review draft
              </button>
            )}
            {structured && (
              <button type="button" className="btn sm" data-testid="voice-guide-open" disabled={pending} onMouseDown={keep} onClick={() => setDialog({ kind: "guide", draft: null })}>
                Open guide
              </button>
            )}
            {voice.guide?.text && (
              <button type="button" className="btn sm" data-testid="voice-guide-remove" disabled={busy} onMouseDown={keep} onClick={() => (setRemoveError(""), setRemoving(true))}>
                Remove guide
              </button>
            )}
          </div>
          {voiceRun && (
            <p className="vc-ok" role="status" data-testid="voice-guide-note">
              {writing ? (note ? "Sent to your agent. It is writing your guide." : "The agent is writing your voice guide.") : note ? "Sent to your agent." : "Your request is waiting for an agent."}
            </p>
          )}
          {busy && !voiceRun && (
            <p className="vc-hint" data-testid="voice-build-busy">
              Wait for the agent to finish, then try again.
            </p>
          )}
          {note && !voiceRun && (
            <p className="vc-ok" role="status" data-testid="voice-guide-note">
              {note}
            </p>
          )}
          {children}
        </div>
      ) : (
        (draft || readOnly || note) && (
          <p className="vg-status-line vg-outside" data-testid="voice-guide-line">
            {readOnly ? "Build it from the tab that holds the file." : note || status}
            {draft && !readOnly && (
              <button type="button" className="btn quiet sm" data-testid="voice-review-draft-line" disabled={pending} onMouseDown={keep} onClick={() => setDialog({ kind: "draft", draft })}>
                Review draft
              </button>
            )}
          </p>
        )
      )}
      {removing && (
        <VoiceDialog title="Remove your voice guide?" testid="voice-remove" onClose={() => setRemoving(false)}>
          <p>Remove your voice guide? This cannot be undone.</p>
          {removeError && (
            <p className="vc-err" role="alert" data-testid="voice-remove-error">
              {removeError}
            </p>
          )}
          <div className="dialog-actions">
            <button type="button" className="btn primary" data-testid="voice-remove-confirm" onClick={removeGuide}>
              Remove
            </button>
            <button type="button" className="btn" data-testid="voice-remove-cancel" onClick={() => setRemoving(false)}>
              Cancel
            </button>
          </div>
        </VoiceDialog>
      )}
      {dialog?.kind === "build" && (
        <BuildVoice
          sid={sid}
          session={session}
          examples={voice.examples_count || 0}
          saved={!!voice.guide?.text}
          onClose={close}
          onSent={() => {
            close();
            setNote("Sent to your agent.");
          }}
        />
      )}
      {(dialog?.kind === "draft" || dialog?.kind === "guide") && (
        <VoiceGuideEditor
          dirtyRef={dirtyRef}
          voice={voice}
          draft={dialog.draft}
          onVoice={onVoice}
          onClose={close}
          onSaved={(sent) => {
            close();
            setNote(sent ? "Saved. Your guide goes to the agent with every request." : "Saved. It is not sent until you switch it on.");
          }}
        />
      )}
    </>
  );
}
