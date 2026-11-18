import React, { useEffect, useRef } from "react";
import "./agent.css";

const VISIBLE = ["starting", "ready", "working", "handover"]; // only a background agent that exists gets a panel: someone using their own agent never sees it
const STATUS = { starting: "Getting ready", ready: "Listening", working: "Working on your batch", handover: "Open in Terminal", failed: "Stopped" };
// a stopped agent keeps its panel so "Show what happened" has somewhere to show; with no agent to look at (not installed, not signed in) there is nothing to show
const visible = (a) => VISIBLE.includes(a.state) || (a.state === "failed" && !["not_installed", "signed_out"].includes(a.failure?.code));
const when = (at) => (Number.isFinite(at) ? new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "");

/**
 * The background agent in the review panel: its status in plain words, the "Show the agent" switch, and, with the switch on, the live list of what
 * it is doing (fixed words from the server, never document text) and the Open in Terminal button. Every button posts to /api/agent through `onAct`.
 */
export function AgentPanel({ agent, readOnly, onAct }) {
  const listRef = useRef(null);
  const items = (agent?.activity || []).slice(-50);
  const show = !!agent?.show;
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items.length, show]);
  if (!agent || !visible(agent)) return null;
  const handed = agent.state === "handover";
  return (
    <section className="agent-panel" data-testid="agent-panel" aria-label="Background agent">
      <div className="ap-head">
        <span className="ap-title">Background agent</span>
        <span className="ap-status" data-state={agent.state} data-testid="agent-status">
          {STATUS[agent.state]}
        </span>
      </div>
      <label className="ap-switch" data-testid="agent-show-label">
        <input type="checkbox" role="switch" checked={show} disabled={readOnly} onChange={(e) => onAct("show", { on: e.target.checked })} data-testid="agent-show-switch" />
        <span className="ap-track" aria-hidden="true" />
        <span>Show the agent</span>
      </label>
      {show && (
        <>
          {items.length === 0 ? (
            <p className="ap-empty" data-testid="agent-empty">Nothing yet. What the agent does will appear here.</p>
          ) : (
            <ol className="ap-list" ref={listRef} role="log" aria-live="polite" aria-label="What the agent is doing, newest last" data-testid="agent-activity" tabIndex={0}>
              {items.map((it, i) => (
                <li key={`${it.at}:${i}`} data-testid="agent-line">
                  <span className="ap-at">{when(it.at)}</span>
                  <span className="ap-text">{it.text}</span>
                </li>
              ))}
            </ol>
          )}
          <p className="ap-note" data-testid="agent-transcript">The full conversation is saved on this Mac, private to you, and removed when you close this session.</p>
          {!handed && agent.state !== "failed" && (
            <div className="ap-term">
              <button type="button" className="btn sm" disabled={readOnly} onClick={() => onAct("terminal")} data-testid="agent-terminal">
                Open in Terminal
              </button>
              <p className="ap-note" data-testid="agent-terminal-hint">Opens this agent's conversation in Terminal, with the same limits, where it keeps listening for your Send. Claude Code may first ask whether you trust the folder: choose Yes. The background agent stops while it is open.</p>
            </div>
          )}
        </>
      )}
    </section>
  );
}
