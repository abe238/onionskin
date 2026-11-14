import React, { useEffect, useState } from "react";
import { api } from "./lib.js";
import "./quick-change.css";

const WAIT_MS = 600; // after typing stops

/**
 * What the server says about the note in the box ("Replace Acme with Initech"): null, or the match (see src/quick-plan.js quickPreview).
 * Read only. An answer counts for the exact note and file it was asked for: the moment either changes it is gone, so the Send button
 * never shows a number for words or a file it was not counted on. `enabled` is false when the Send would carry more than the note.
 */
export function useQuickPreview({ sid, note, stamp, enabled }) {
  const [out, setOut] = useState(null); // {note, stamp, match}
  const worth = enabled && !!note.trim() && note.length <= 200 && !/[\r\n]/.test(note);
  useEffect(() => {
    if (!worth) return undefined;
    let live = true;
    const timer = setTimeout(async () => {
      try {
        const r = await api(`/api/quick?s=${sid}`, { method: "POST", body: { note } });
        if (live) setOut({ note, stamp, match: r.match || null });
      } catch {
        if (live) setOut(null); // no preview: the Send is the ordinary one
      }
    }, WAIT_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [sid, note, stamp, worth]);
  return worth && out && out.note === note && out.stamp === stamp ? out.match : null;
}

/** The line under the note box. `agent` is true when the person chose to send this one to the agent. */
export function QuickChange({ match, agent, onAgent }) {
  if (!match) return null;
  if (!match.local) {
    return (
      <p className="qc qc-why" role="status" data-testid="quick-why">
        {match.why}
      </p>
    );
  }
  const skipped = match.protectedCount;
  return (
    <div className="qc" role="status" data-testid="quick-change" data-agent={agent ? "1" : "0"}>
      {agent ? (
        <p className="qc-line">The agent will do this one.</p>
      ) : (
        <p className="qc-line" data-testid="quick-line">
          Quick change: {match.text}. Runs on this Mac, no AI.
          {skipped > 0 && ` ${skipped} protected ${skipped === 1 ? "place" : "places"} will be skipped.`}
        </p>
      )}
      <button type="button" className="qc-link" data-testid="quick-agent" onClick={() => onAgent(!agent)}>
        {agent ? "Do it on this Mac" : "Ask the agent instead"}
      </button>
    </div>
  );
}
