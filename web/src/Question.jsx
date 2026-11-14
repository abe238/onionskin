import React, { useEffect, useRef, useState } from "react";
import "./question.css";

/**
 * The agent's question on a comment card, and the person's answer once tapped. The question and options were written by an agent
 * after reading the document: React draws them as plain text (no HTML, no links, one line each, already cleaned and capped by the
 * server). A tap sends only the option's position; "Something else" always exists, so no option is forced.
 * Buttons keep the focus where it is on mouse down (as the selection chip does): Safari does not focus buttons on click anyway.
 * One tap at a time: a double click must not post twice (the second would find no open question and show an error).
 */
export function Question({ c, readOnly, onAnswer }) {
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    busyRef.current = false;
    setBusy(false);
  }, [c.status]);
  const tap = async (choice) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    if ((await onAnswer(c.id, choice)) === false) {
      busyRef.current = false; // refused: the buttons work again
      setBusy(false);
    }
  };
  const q = c.question;
  if (!q || !Array.isArray(q.options)) return null;
  if (c.status !== "asked") {
    const picked = Number.isInteger(c.answer?.choice) ? q.options[c.answer.choice] : null;
    return picked == null ? null : (
      <p className="q-answered" data-testid="question-answered">
        You answered: {picked}
      </p>
    );
  }
  const keep = (e) => e.preventDefault();
  return (
    <div className="question" role="group" aria-label="The agent asks" data-testid="question">
      <p className="q-head">The agent asks</p>
      <p className="q-text" data-testid="question-text">
        {q.text}
      </p>
      <div className="q-options">
        {q.options.map((o, i) => (
          <button key={i} type="button" className="btn sm q-option" data-testid="question-option" data-choice={i} disabled={readOnly || busy} onMouseDown={keep} onClick={() => tap(i)}>
            {o}
          </button>
        ))}
        <button type="button" className="btn sm quiet q-option" data-testid="question-else" disabled={readOnly || busy} onMouseDown={keep} onClick={() => tap(null)}>
          Something else
        </button>
      </div>
      <p className="q-hint">{readOnly ? "Answer from the tab that holds the file." : "Your answer goes to the agent and it carries on."}</p>
    </div>
  );
}
