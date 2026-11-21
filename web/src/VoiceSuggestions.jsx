import React, { useRef, useState } from "react";
import { api } from "./lib.js";
import { suggestionView } from "./voice-ui.js";

const keep = (e) => e.preventDefault(); // a tap must not move the focus or the reader's place
const SAVE_ERR = "Could not save that. Try again.";

/**
 * "Suggested from your edits", inside the Writing preferences panel. The server sends a trait id, a source and two numbers; the label and
 * the evidence sentence come from voice-ui.js. Nothing is turned on except by a tap on "Turn on".
 */
export function VoiceSuggestions({ voice, onVoice }) {
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const shown = (voice.suggestions || []).map(suggestionView).filter(Boolean);

  async function answer(trait, action) {
    if (busy) return;
    setBusy(true);
    setErr("");
    try {
      const next = await api("/api/voice/answer", { method: "POST", body: { trait, action } });
      onVoice(next);
      setNote(action === "on" ? "Turned on. This goes to the agent with every request." : "");
    } catch {
      setErr(SAVE_ERR);
    }
    setBusy(false);
  }

  return (
    <section className="vc-block" aria-labelledby="vc-sug-h" data-testid="voice-suggestions">
      <h3 id="vc-sug-h">Suggested from your edits</h3>
      {shown.length === 0 && (
        <p className="vc-hint" data-testid="voice-empty">
          No suggestions yet. They come from the changes you make to the agent's text in Word documents.
        </p>
      )}
      <ul className="vc-list">
        {shown.map((s) => (
          <li key={s.trait} className="vc-sug" data-testid={`voice-suggestion-${s.trait}`}>
            <strong>{s.label}</strong>
            <span className="vc-evidence" data-testid={`voice-evidence-${s.trait}`}>
              {s.text}
            </span>
            <span className="vc-row">
              <button type="button" className="btn sm" data-testid={`voice-on-${s.trait}`} disabled={busy} onMouseDown={keep} onClick={() => answer(s.trait, "on")}>
                Turn on
              </button>
              <button type="button" className="btn quiet sm" data-testid={`voice-later-${s.trait}`} disabled={busy} onMouseDown={keep} onClick={() => answer(s.trait, "later")}>
                Not now
              </button>
              <button type="button" className="btn quiet sm" data-testid={`voice-never-${s.trait}`} disabled={busy} onMouseDown={keep} onClick={() => answer(s.trait, "never")}>
                Don't suggest this
              </button>
            </span>
          </li>
        ))}
      </ul>
      {note && (
        <p className="vc-ok" role="status" data-testid="voice-turned-on">
          {note}
        </p>
      )}
      {err && (
        <p className="vc-err" role="alert">
          {err}
        </p>
      )}
    </section>
  );
}

/** The "Learn from my edits" switch and "Forget my edits". Off keeps what is stored and stops new records; Forget empties it. */
export function VoiceLearning({ voice, onVoice }) {
  const [asking, setAsking] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const post = async (path, body) => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setErr("");
    try {
      onVoice(await api(path, { method: "POST", body }));
      return true;
    } catch {
      setErr(SAVE_ERR);
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  return (
    <section className="vc-block" aria-label="Learning" data-testid="voice-learning">
      <label className="vc-switch">
        <input type="checkbox" role="switch" checked={!!voice.learning} disabled={busy} data-testid="voice-learning-switch" onChange={(e) => post("/api/voice/learning", { on: e.target.checked })} />
        <span>Learn from my edits</span>
      </label>
      <p className="vc-hint">Onionskin keeps a few of your recent edits on this Mac to make suggestions. Nothing is sent anywhere.</p>
      {!asking ? (
        <button type="button" className="btn quiet sm vc-self" disabled={busy} data-testid="voice-forget" onMouseDown={keep} onClick={() => setAsking(true)}>
          Forget my edits
        </button>
      ) : (
        <div className="vc-confirm" role="group" aria-label="Forget my edits" data-testid="voice-forget-ask">
          <p>Forget the edits Onionskin has kept? Your preferences stay.</p>
          <span className="vc-row">
            <button type="button" className="btn sm" disabled={busy} data-testid="voice-forget-yes" onMouseDown={keep} onClick={async () => (await post("/api/voice/forget", {})) && setAsking(false)}>
              Forget
            </button>
            <button type="button" className="btn quiet sm" disabled={busy} data-testid="voice-forget-no" onMouseDown={keep} onClick={() => setAsking(false)}>
              Cancel
            </button>
          </span>
        </div>
      )}
      {err && (
        <p className="vc-err" role="alert">
          {err}
        </p>
      )}
    </section>
  );
}
