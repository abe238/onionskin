import React, { useEffect, useState } from "react";
import { Nodes } from "./DiffNodes.jsx";
import { WORDS } from "./suggest.js";

const keep = (e) => e.preventDefault(); // a tap must not move the focus out of the text box, and nothing here scrolls the document
const SLOW_MS = 150; // nothing flashes for a quick answer
const WARM_MS = 1500; // the server does not say when the model is still starting: a long wait reads as that

/**
 * The quick fix card, which takes the place of the stamp row in the Quick ask box. `sg` is
 *   {phase: "asking"}                                       waiting for the answer
 *   {phase: "shown", card, error?}                          card = cardFor(...) of a shown suggestion; error = a refused Use, in words
 *   {phase: "none", text, retry}                            one line, "Ask the agent instead", and "Try again" only when `retry`
 * The sentence and the rewrite are untrusted text and only ever drawn as plain text. Esc is handled by the Quick ask box (it closes the card
 * and writes nothing).
 */
export function Suggestion({ sg, busy, onUse, onAgent, onRetry }) {
  const [late, setLate] = useState(0); // 0 nothing yet, 1 "Writing a suggestion...", 2 "Getting the writing helper ready..."
  useEffect(() => {
    setLate(0);
    if (sg.phase !== "asking") return;
    const a = setTimeout(() => setLate(1), SLOW_MS);
    const b = setTimeout(() => setLate(2), WARM_MS);
    return () => {
      clearTimeout(a);
      clearTimeout(b);
    };
  }, [sg.phase, sg.seq]);

  const agent = (
    <button type="button" className="btn sm quiet" data-testid="suggestion-agent" onMouseDown={keep} onClick={onAgent}>
      {WORDS.agent}
    </button>
  );

  if (sg.phase === "asking")
    return (
      <div className="qsg" data-testid="suggestion" data-state="asking" role="status" aria-live="polite">
        {late > 0 && (
          <p className="qsg-wait" data-testid="suggestion-working">
            <span className="spinner" aria-hidden="true" />
            {late === 2 ? WORDS.warming : WORDS.working}
          </p>
        )}
      </div>
    );

  if (sg.phase === "none")
    return (
      <div className="qsg" data-testid="suggestion" data-state="none">
        <p className="qsg-msg" role="status" data-testid="suggestion-message">
          {sg.text}
        </p>
        <div className="qsg-actions">
          {sg.retry && (
            <button type="button" className="btn sm primary" data-testid="suggestion-retry" onMouseDown={keep} onClick={onRetry}>
              {WORDS.retry}
            </button>
          )}
          {agent}
        </div>
      </div>
    );

  const { card } = sg;
  return (
    <div className="qsg" data-testid="suggestion" data-state="shown">
      <p className="qsg-h">{WORDS.header}</p>
      <p className="qsg-sub">{WORDS.sub}</p>
      <div className="qsg-lines">
        <span className="qsg-label">{WORDS.now}</span>
        <p className="h-diff qsg-text" data-testid="suggestion-now">
          <Nodes nodes={card.now} />
        </p>
        <span className="qsg-label">{WORDS.suggested}</span>
        <p className="h-diff qsg-text" data-testid="suggestion-suggested">
          <Nodes nodes={card.suggested} />
        </p>
      </div>
      {card.checks.map((line, i) => (
        <p key={i} className="qsg-check" data-testid="suggestion-check">
          {line}
        </p>
      ))}
      {sg.error && (
        <p className="qsg-error" role="alert" data-testid="suggestion-error">
          {sg.error}
        </p>
      )}
      <div className="qsg-actions">
        <button type="button" className="btn sm primary" data-testid="suggestion-use" disabled={busy} onMouseDown={keep} onClick={onUse}>
          {WORDS.use}
        </button>
        {agent}
      </div>
    </div>
  );
}
