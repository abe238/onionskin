import React, { useEffect, useRef, useState } from "react";
import { splitChange } from "./suggestion-diff.js";
import "./suggestions.css";

// The agent reviews first (src/review.js). Everything the agent wrote reaches this file as plain strings: React draws them as text (no HTML,
// no links), already refused by the server unless short, one line and link free. A tap sends only card ids and a whole number (0 = Accept or
// "Show me" never leaves the page, 1 = Reject or Dismiss). Was and Now are cut from the file by the server; only Now holds agent words.

export const REVIEW_BUTTONS = [
  { kind: "proofread", label: "Proofread" },
  { kind: "skeptical_cfo", label: "Read like a skeptical CFO" },
  { kind: "check_numbers", label: "Check every number" },
];
const keep = (e) => e.preventDefault(); // buttons keep the focus where it is (Safari does not focus them on click anyway)

/** One call at a time: a double click must not post twice. `run` resolves false when refused (the buttons work again). */
function useOnce(resetOn) {
  const ref = useRef(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    ref.current = false;
    setBusy(false);
  }, [resetOn]);
  const once = async (fn) => {
    if (ref.current) return;
    ref.current = true;
    setBusy(true);
    try {
      if ((await fn()) === false) {
        ref.current = false;
        setBusy(false);
      }
    } catch {
      ref.current = false;
      setBusy(false);
    }
  };
  return [busy, once];
}

/** The row in the composer: three fixed requests. `why` is a plain reason the buttons are off, or null. */
export function ReviewRow({ why, readOnly, resetOn, onReview }) {
  const [busy, once] = useOnce(resetOn);
  const off = readOnly || !!why || busy;
  return (
    <div className="rv" role="group" aria-label="Review first" data-testid="review-row">
      <span className="rv-h">Review first</span>
      <div className="rv-btns">
        {REVIEW_BUTTONS.map((b) => (
          <button key={b.kind} type="button" className="rv-btn" data-testid="review-button" data-kind={b.kind} disabled={off} onMouseDown={keep} onClick={() => once(() => onReview(b.kind))}>
            {b.label}
          </button>
        ))}
      </div>
      <p className={`rv-hint ${readOnly || why ? "" : "rv-info"}`} data-testid="review-hint">
        {readOnly ? "Answer from the tab that holds the file." : why || "The agent reads the file and suggests changes. Nothing changes until you accept."}
      </p>
    </div>
  );
}

const SETTLED = { accepted: "Accepted", rejected: "Rejected", dismissed: "Dismissed", stale: "The text here changed, so this was not applied." };

function Card({ g, off, onChoose, onShow }) {
  const open = g.status === "open";
  const note = g.kind === "note";
  const d = note ? null : splitChange(g.before, g.after);
  return (
    <li className="sg" data-testid="suggestion" data-kind={g.kind} data-status={g.status}>
      <span className="sg-loc" data-testid="suggestion-label">
        {g.label}
      </span>
      {note ? (
        <>
          <p className="sg-note" data-testid="suggestion-note">
            {g.note}
          </p>
          <p className="sg-quote" data-testid="suggestion-quote">
            {g.before.replace(/…\[truncated\]$/, "…")}
          </p>
        </>
      ) : (
        <>
          <p className="sg-line" data-testid="suggestion-was">
            <b className="sg-tag">Was</b>
            <span>
              {d.pre}
              {d.del ? <del>{d.del}</del> : null}
              {d.post}
            </span>
          </p>
          <p className="sg-line" data-testid="suggestion-now">
            <b className="sg-tag">Now</b>
            <span>
              {d.pre}
              {d.ins ? <ins>{d.ins}</ins> : null}
              {d.post}
            </span>
          </p>
          {g.why ? (
            <p className="sg-why" data-testid="suggestion-why">
              {g.why}
            </p>
          ) : null}
        </>
      )}
      {open ? (
        <div className="sg-btns">
          {note ? (
            <button type="button" className="btn sm" data-testid="suggestion-show" onMouseDown={keep} onClick={() => onShow(g)}>
              Show me
            </button>
          ) : (
            <button type="button" className="btn sm primary" data-testid="suggestion-accept" disabled={off} onMouseDown={keep} onClick={() => onChoose([g.id], 0)}>
              Accept
            </button>
          )}
          <button type="button" className="btn sm quiet" data-testid="suggestion-reject" disabled={off} onMouseDown={keep} onClick={() => onChoose([g.id], 1)}>
            {note ? "Dismiss" : "Reject"}
          </button>
        </div>
      ) : (
        <p className="sg-state" data-testid="suggestion-state" data-state={g.status}>
          {SETTLED[g.status] || ""}
        </p>
      )}
    </li>
  );
}

/**
 * The cards of the newest review (the newest "review" entry of the activity), one block at the end of the stack. Cards of an older review
 * are not drawn: the ones left open are "replaced" on the server, the settled ones are done with. `waiting` is true while a batch is pending or delivered: Accept would be refused, so it says so instead.
 */
export function Suggestions({ cards, reviewId, readOnly, waiting, resetOn, onChoose, onShow }) {
  const [busy, once] = useOnce(resetOn);
  const shown = cards.filter((g) => g.status !== "replaced" && g.reviewId === reviewId);
  if (!shown.length) return null;
  const open = shown.filter((g) => g.status === "open");
  const edits = open.filter((g) => g.kind === "edit");
  const off = readOnly || busy;
  const choose = (ids, choice) => once(() => onChoose(ids, choice));
  return (
    <li className="sgs" data-testid="suggestions">
      <h3 className="sgs-h">Suggested by the agent</h3>
      <p className="sgs-line">From the agent, after reading your file. Check it before you accept.</p>
      <ul className="sgs-list">
        {shown.map((g) => (
          <Card key={g.id} g={g} off={off || (waiting && g.kind === "edit")} onChoose={choose} onShow={onShow} />
        ))}
      </ul>
      {open.length > 0 && (
        <div className="sgs-all">
          {edits.length > 1 && (
            <button type="button" className="btn sm" data-testid="suggestions-accept-all" disabled={off || waiting} onMouseDown={keep} onClick={() => choose(edits.map((g) => g.id), 0)}>
              Accept all
            </button>
          )}
          {open.length > 1 && (
            <button type="button" className="btn sm quiet" data-testid="suggestions-reject-all" disabled={off} onMouseDown={keep} onClick={() => choose(open.map((g) => g.id), 1)}>
              Reject all
            </button>
          )}
        </div>
      )}
      {waiting && edits.length > 0 && !readOnly && (
        <p className="sgs-wait" data-testid="suggestions-wait">
          Wait for the agent to finish, then try again.
        </p>
      )}
      {readOnly && open.length > 0 && <p className="sgs-wait">Answer from the tab that holds the file.</p>}
    </li>
  );
}

/** In the review's activity entry: how many suggestions the server dropped (it never says why in the page). */
export function ReviewDropped({ a }) {
  const n = a.kind === "review" ? a.suggestionsDropped || 0 : 0;
  return n > 0 ? (
    <p className="summary" data-testid="review-dropped">
      {n} {n === 1 ? "suggestion" : "suggestions"} could not be shown.
    </p>
  ) : null;
}
