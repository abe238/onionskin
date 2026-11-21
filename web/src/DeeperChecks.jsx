import { useEffect, useRef, useState } from "react";
import { api } from "./lib.js";

// Why the deeper check did not run, as the server reports it (checks.deep.code): nothing is set up yet, as opposed to "it ran and broke".
export const NOT_SET_UP = ["not_set_up", "libraries_missing"];

// The one plain sentence per failure, and the one next step. The technical text (a command's own message) is only in "Details".
const FAILED = {
  no_network: "Deeper checks could not be turned on: there is no internet connection. Connect, then try again.",
  no_python: "Deeper checks could not be turned on: Python 3 was not found on this Mac. Ask your agent to set it up, then try again.",
  unsupported_python: "Deeper checks could not be turned on: this Python version or platform is not supported. Ask your agent to set up a supported Python, then try again.",
  failed: "Deeper checks could not be turned on. Try again, or ask your agent to look into it.",
};
function failedSentence(st) {
  if (st.reason === "unsupported_python") {
    const m = typeof st.detail === "string" && st.detail.match(/\bPython\s+\d+(?:\.\d+)+/i);
    if (m) return `Deeper checks could not be turned on: ${m[0]} is not supported. Ask your agent to set up a supported Python, then try again.`;
  }
  return FAILED[st.reason] || FAILED.failed;
}
const POLL_MS = 1500;

/**
 * The review panel's line about the deeper check, shown on the newest run only when the deeper check did not run because it is not set up.
 * One button turns it on (POST /api/setup-checker); the page then polls the status until the server's single setup job ends.
 * `clean` = the built-in checks found nothing to flag, so "Basic checks passed" is true. `onDetail(text)` hands the technical text of a failed
 * setup to the run's single Details disclosure (empty when there is none).
 */
export function DeeperChecks({ clean, onDetail }) {
  const [st, setSt] = useState(null); // {state: off|working|on|failed, reason?, detail?}; null until the first answer
  const alive = useRef(true);
  const timer = useRef(null);

  const read = async () => {
    let next;
    try {
      next = await api("/api/setup-checker");
    } catch (err) {
      next = { state: "failed", reason: "failed", detail: err.message };
    }
    if (!alive.current) return;
    setSt(next);
    clearTimeout(timer.current);
    if (next.state === "working") timer.current = setTimeout(read, POLL_MS);
  };
  useEffect(() => {
    alive.current = true;
    read();
    return () => {
      alive.current = false;
      clearTimeout(timer.current);
    };
  }, []);

  useEffect(() => {
    onDetail?.(st?.state === "failed" ? st.detail || "" : "");
  }, [st]);

  const turnOn = async () => {
    setSt({ state: "working" });
    try {
      await api("/api/setup-checker", { method: "POST", body: {} });
    } catch (err) {
      if (alive.current) setSt({ state: "failed", reason: "failed", detail: err.message });
      return;
    }
    read();
  };

  if (!st) return null;
  const { state } = st;
  return (
    <div className="deeper" data-testid="deeper-checks" data-state={state}>
      <div role="status" data-testid="deeper-status">
        {state === "working" ? (
          <p className="deeper-working">
            <span className="spinner" aria-hidden="true" />
            Setting up deeper checks, about a minute
          </p>
        ) : state === "on" ? (
          <p>Deeper checks are on. They run from your next Send.</p>
        ) : state === "failed" ? (
          <p>{failedSentence(st)}</p>
        ) : (
          <p>{clean ? "Basic checks passed. Deeper checks are off." : "Deeper checks are off."}</p>
        )}
      </div>
      {(state === "off" || state === "failed") && (
        <>
          <button type="button" className="btn sm" onClick={turnOn} data-testid="deeper-turn-on">
            {state === "failed" ? "Try again" : "Turn on deeper checks"}
          </button>
          {state === "off" && (
            <p className="deeper-note" data-testid="deeper-note">
              Downloads five small libraries once, about a minute. Nothing from your documents is sent.
            </p>
          )}
        </>
      )}
    </div>
  );
}
