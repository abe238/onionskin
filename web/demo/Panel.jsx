import React, { useEffect, useRef } from "react";
import { diffNodes } from "../src/history-view.js";
import { dateText, statusText, workingText } from "./replay.js";

// The Try-it page's side panel. Every string from the recording is rendered as React text: never as markup, a link or an address.

const short = (s, n = 90) => {
  const cps = [...String(s)];
  return cps.length > n ? cps.slice(0, n - 1).join("") + "…" : cps.join("");
};

export function Intro({ recording }) {
  return (
    <header className="demo-intro">
      <h1>Try Onionskin</h1>
      <p>Add the comments, press Send, and watch the changes a real AI agent made to this letter.</p>
      {recording.real === true ? (
        <p className="demo-who" data-testid="demo-who">
          The comments were written for this demo. The agent that answered them was real: {recording.agent}, on {dateText(recording.date)}.
        </p>
      ) : (
        <p className="demo-who demo-test" data-testid="demo-who">
          This replay uses a test agent, not a real one.
        </p>
      )}
    </header>
  );
}

export function Panel({ recording, phase, added, plan, onAdd, onSend, onRevert, onStartOver }) {
  const n = recording.comments.length;
  const allAdded = added.length === n;
  const asking = phase === "ready";
  // The panel is taller than a short window: bring the new state into view inside the panel (on a narrow screen the panel does not scroll by itself, so nothing moves).
  const box = useRef(null);
  useEffect(() => {
    const el = box.current;
    if (phase !== "ready" && el && el.scrollHeight > el.clientHeight) el.scrollTop = el.scrollHeight;
  }, [phase]);
  return (
    <aside className="demo-panel" ref={box} data-testid="demo-panel" aria-label="Review panel">
      <Intro recording={recording} />
      <ol className="demo-cards">
        {recording.comments.map((c) => {
          const on = added.includes(c.n);
          return (
            <li key={c.n} className={`demo-card ${on ? "on" : ""}`} data-testid="demo-card" data-n={c.n}>
              <span className="demo-num" aria-hidden="true">
                {c.n}
              </span>
              <div className="demo-card-body">
                <p className="demo-quote">“{short(c.quote)}”</p>
                <p className="demo-text">{c.text}</p>
                <button type="button" className="demo-btn" data-testid="demo-add" disabled={on || !asking} aria-pressed={on} onClick={() => onAdd(c.n)}>
                  {on ? "Added" : "Add this comment"}
                </button>
              </div>
            </li>
          );
        })}
      </ol>
      <div className="demo-overall">
        <p className="demo-label">Overall instructions</p>
        <p className="demo-text">{recording.overall_note}</p>
      </div>

      {asking && (
        <div className="demo-send">
          {!allAdded && (
            <p className="demo-hint" data-testid="demo-hint">
              Add all {n} comments to send. This replay only has the answer to all of them together.
            </p>
          )}
          <button type="button" className="demo-btn primary" data-testid="demo-send" disabled={!allAdded} onClick={onSend}>
            Send
          </button>
        </div>
      )}

      {phase === "working" && (
        <p className="demo-working" role="status" data-testid="demo-working">
          <span className="demo-spin" aria-hidden="true" /> {workingText(plan)}
        </p>
      )}

      {phase === "finished" && (
        <section className="demo-result" data-testid="demo-result" aria-labelledby="demo-finished">
          <h2 id="demo-finished">Agent finished</h2>
          <p className="demo-label">What the agent said</p>
          <p className="demo-text" data-testid="demo-summary">
            {recording.result.summary}
          </p>
          <ol className="demo-notes">
            {recording.result.notes.map((x) => (
              <li key={x.n} data-testid="demo-note">
                <span className="demo-label">
                  Comment {x.n}: {statusText(x.status)}
                </span>{" "}
                <span className="demo-text">{x.note}</span>
              </li>
            ))}
          </ol>
          {recording.places.length > 0 && (
            <>
              <p className="demo-label">What changed</p>
              <ul className="demo-places" data-testid="demo-places">
                {recording.places.map((p, i) => (
                  <li key={i}>
                    {diffNodes(p.diff).map((d, j) =>
                      d.t === "del" ? <del key={j}>{d.text}</del> : d.t === "ins" ? <ins key={j}>{d.text}</ins> : <span key={j}>{d.text}</span>,
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
          <button type="button" className="demo-btn" data-testid="demo-revert" onClick={onRevert}>
            Revert
          </button>
        </section>
      )}

      {phase === "reverted" && (
        <section className="demo-result" data-testid="demo-reverted">
          <p role="status">Reverted. The letter is back to how it was, the same way the real Revert put it back.</p>
          <button type="button" className="demo-btn" data-testid="demo-again" onClick={onStartOver}>
            Start over
          </button>
        </section>
      )}
    </aside>
  );
}
