import React, { useEffect, useRef, useState } from "react";
import { Icon } from "./Icons.jsx";
import { useFocusTrap } from "./hooks.js";
import { glass } from "./lens.js";
import { stageOf } from "./stage.js";

export function CopyButton({ text }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
      setTimeout(() => setDone(false), 1800);
    } catch {
      /* clipboard blocked: the command is selectable text, one click selects all of it */
    }
  };
  return (
    <button type="button" className="btn" onClick={copy} data-testid="copy-command" aria-label="Copy the command">
      <Icon name={done ? "check" : "copy"} size={14} /> {done ? "Copied" : "Copy"}
    </button>
  );
}

/** Where the held version went: the sentence, the copy's name, and what the person can do next. */
function CopyActions({ copy, copyError, canReveal, onShowCopy, onKeepMine }) {
  if (!copy?.name) {
    return (
      <>
        <p className="hint" data-testid="conflict-copy-failed">
          The copy could not be saved in this folder{copyError ? ` (${copyError})` : ""}. Download it instead.
        </p>
        <button type="button" className="btn primary" onClick={onKeepMine} data-testid="keep-mine">
          Download a copy
        </button>
      </>
    );
  }
  return canReveal ? (
    <button type="button" className="btn primary" onClick={() => onShowCopy(copy.path)} data-testid="show-in-folder">
      Show in folder
    </button>
  ) : (
    <span className="copy-path">
      <code data-testid="copy-path">{copy.path}</code> <CopyButton text={copy.path || ""} />
    </span>
  );
}

function ConflictDialog({ conflict, onReloadDisk, onKeepMine, onShowCopy, onClose }) {
  const ref = useRef(null);
  useFocusTrap(ref, true, onClose);
  useEffect(() => glass(ref.current), []);
  const { copy, copyError, canReveal, side } = conflict;
  const who = side === "agent" ? "the agent's edits" : "your edits";
  return (
    <div className="scrim" data-testid="conflict-scrim">
      <div ref={ref} className="dialog glass" data-lens="22 40" role="alertdialog" aria-modal="true" aria-labelledby="conflict-title" aria-describedby="conflict-body" tabIndex={-1} data-testid="banner-conflict">
        <div className="dialog-icon err" aria-hidden="true">
          <Icon name="alert" size={20} />
        </div>
        <h2 id="conflict-title">Someone changed this file outside Onionskin</h2>
        <p id="conflict-body" data-testid="conflict-body">
          Someone changed this file outside Onionskin. Your original file was left untouched.
          {copy?.name ? (
            <>
              {" "}
              A copy with {who} was saved as <strong data-testid="copy-name">{copy.name}</strong> in the same folder, so you can open both in Word and combine them yourself.
            </>
          ) : (
            <> Nothing was written over it.</>
          )}
        </p>
        <div className="dialog-actions">
          <CopyActions copy={copy} copyError={copyError} canReveal={canReveal} onShowCopy={onShowCopy} onKeepMine={onKeepMine} />
          <button type="button" className="btn" onClick={onReloadDisk} data-testid="reload-disk">
            Reload the changed file
          </button>
          <button type="button" className="btn" onClick={onClose} data-testid="conflict-close">
            Close
          </button>
        </div>
        <p className="hint">Reload shows the changed file. Your unsent comments and pins are kept and placed again; any that no longer fit are marked as moved or removed.</p>
      </div>
    </div>
  );
}

function CloseDialog({ edits, onKeepMine, onCloseAnyway, onCancel }) {
  const ref = useRef(null);
  useFocusTrap(ref, true, onCancel);
  useEffect(() => glass(ref.current), []);
  return (
    <div className="scrim" data-testid="close-scrim">
      <div ref={ref} className="dialog glass" data-lens="22 40" role="alertdialog" aria-modal="true" aria-labelledby="close-title" aria-describedby="close-body" tabIndex={-1} data-testid="close-dialog">
        <div className="dialog-icon err" aria-hidden="true">
          <Icon name="alert" size={20} />
        </div>
        <h2 id="close-title">Close with unsent edits?</h2>
        <p id="close-body">
          You typed {edits > 0 ? `${edits} edit${edits > 1 ? "s" : ""}` : "edits"} that were never sent. They live only in this page, so closing the session loses them.
        </p>
        <div className="dialog-actions">
          <button type="button" className="btn primary" onClick={onKeepMine} data-testid="close-download">
            Download my edits
          </button>
          <button type="button" className="btn" onClick={onCancel} data-testid="close-cancel">
            Keep editing
          </button>
          <button type="button" className="btn" onClick={onCloseAnyway} data-testid="close-anyway">
            Close anyway
          </button>
        </div>
      </div>
    </div>
  );
}

/** Status banners are an overlay docked to the bottom of the document area: they never take layout space, so nothing moves when one appears. */
/** The held-back banner's first line. Lines marked `check` are edits that are in the document with something to look at: they are not counted as missing. */
function heldTitle(items) {
  const missing = items.filter((x) => !x.check).length;
  if (missing) return missing === 1 ? "One edit you made while the agent worked is not in the document" : `${missing} edits you made while the agent worked are not in the document`;
  return items.length === 1 ? "One paragraph you moved while the agent worked is in its new place. Check its formatting" : `${items.length} paragraphs you moved while the agent worked are in their new places. Check their formatting`;
}

/** "3:40 PM", or "Tue 3:40 PM" when it is not today: when the plan's limit resets. */
function resetTime(ms) {
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  const day = d.toDateString() === new Date().toDateString() ? {} : { weekday: "short" };
  return d.toLocaleString([], { ...day, hour: "numeric", minute: "2-digit" });
}

/** The words and buttons for a background agent that stopped (section 5 of the design). The words never include a code, a path or the agent's own text. */
function failureCopy(f) {
  const at = resetTime(f.resetsAt);
  switch (f.code) {
    case "not_installed":
      if (f.update) return { text: "Claude Code on this Mac is too old for Onionskin. Update Claude Code, then press Try again.", buttons: [["Try again", "start", true]] };
      if (f.codex) return { text: "Codex is on this Mac. To work on this file, say to Codex: open this file in Onionskin. To start an agent from this page instead, install Claude Code, sign in, then press Try again.", buttons: [["Try again", "start", true]] };
      return { text: "No coding agent found on this Mac. Onionskin needs Claude Code. Install it and sign in, then press Try again.", buttons: [["Try again", "start", true]] };
    case "signed_out":
      return { text: "Claude Code is installed but not signed in. Sign in once in Terminal, then press Try again.", buttons: [["Open Terminal to sign in", "terminal"], ["Try again", "start", true]] };
    case "limit":
      return { text: `Your Claude plan's usage limit is reached, so the agent stopped. Your batch is saved. ${at ? `The limit resets at ${at}.` : "Try again later."}`, buttons: [["Try again", "start", true]] };
    case "too_many_restarts":
      return { text: "The agent keeps stopping, so Onionskin paused it. Your batch is saved.", buttons: [["Try again", "start", true]] };
    case "refused":
      return { text: "The agent tried to do something Onionskin does not allow, so it stopped. Nothing was written. Your batch is saved.", buttons: [["Send again", "start", true], ["Show what happened", "show"]] };
    default:
      return { text: "The agent stopped unexpectedly. Your batch is saved and nothing was lost.", buttons: [["Restart the agent", "start", true], ["Show what happened", "show"]] };
  }
}

export function Banners({ readOnly, onTakeOver, session, heldBack = null, heldCopy = null, onHeldBackDone, problem, notice, onTakeBack, onAgent = () => {}, onReloadDisk, onKeepMine, onShowCopy, onDismissConflict, onDismiss, unsentEdits = 0, closeAsk = false, onCloseAnyway, onCloseCancel }) {
  const s = session.state;
  const agent = session.agent || null;
  const failed = agent?.state === "failed" && agent.failure ? failureCopy(agent.failure) : null;
  const starting = agent?.state === "starting" && !failed;
  const handover = agent?.state === "handover" && !failed;
  const stranded = s === "stranded" && !failed && !starting && !handover;
  return (
    <>
      <div className="banners">
        {readOnly && (
          <div className="banner warn glass" data-lens="14 26" ref={glass} role="status" data-testid="banner-readonly">
            <Icon name="lock" size={18} />
            <span className="banner-text">
              <strong>Read-only: this file is open for editing in another tab</strong>
              <span>You can look around here. Edits, comments and Send work in the other tab, so nothing gets overwritten.</span>
            </span>
            <button type="button" className="btn" onClick={onTakeOver} data-testid="take-over">
              Edit here instead
            </button>
          </div>
        )}
        {failed && (
          <div className="banner warn glass agent-banner" data-lens="14 26" ref={glass} role="alert" data-testid={`banner-agent-${agent.failure.code}`}>
            <Icon name="alert" size={18} />
            <span className="banner-text">
              <strong data-testid="agent-failure-text">{failed.text}</strong>
            </span>
            <span className="banner-actions">
              {failed.buttons.map(([label, action, primary]) => (
                <button key={action} type="button" className={`btn ${primary ? "primary" : ""}`} disabled={readOnly} onClick={() => onAgent(action, action === "show" ? { on: true } : {})} data-testid={`agent-${action}`}>
                  {label}
                </button>
              ))}
              {s === "stranded" && (
                <button type="button" className="btn" onClick={onTakeBack} data-testid="take-back">
                  Take back
                </button>
              )}
            </span>
          </div>
        )}
        {starting && (
          <div className="banner info glass" data-lens="14 26" ref={glass} role="status" data-testid="banner-agent-starting">
            <span className="working-mark" aria-hidden="true" />
            <span>{agent.busy ? "Getting the agent ready... Another document's agent is busy." : s === "stranded" ? "Starting the agent for your batch..." : "Getting the agent ready..."}</span>
          </div>
        )}
        {handover && (
          <div className="banner info glass" data-lens="14 26" ref={glass} role="status" data-testid="banner-agent-handover">
            <Icon name="panel" size={16} />
            <span>The agent is open in Terminal. It keeps working from there.</span>
          </div>
        )}
        {s === "listening" && !failed && !starting && !handover && (
          <div className="banner ok glass" data-lens="14 26" ref={glass} role="status" data-testid="banner-listening">
            <span className="dot" aria-hidden="true" />
            <span>An agent is listening. Hit Send to Agent when you are ready.</span>
          </div>
        )}
        {(s === "working" || s === "queued") && (
          <div className="banner info glass" data-lens="14 26" ref={glass} role="status" data-testid="banner-working">
            <span className="working-mark" aria-hidden="true" />
            <span className="banner-text">
              <strong data-testid="banner-stage">{stageOf(session).text || "Agent is working"}</strong>
              <span data-testid="banner-lock-line">{session.local ? "Keep editing. What you type is merged with this change when it finishes." : "Keep editing. What you type is merged with the agent's changes when it finishes."}</span>
            </span>
            <button type="button" className="btn" onClick={onTakeBack} data-testid="take-back">
              Take back editing
            </button>
          </div>
        )}
        {stranded && (
          <div className="banner warn glass agent-banner" data-lens="14 26" ref={glass} role="status" data-testid="banner-stranded">
            <Icon name="alert" size={18} />
            <span className="banner-text">
              <strong>Your batch is saved, but no agent is listening</strong>
              <span>Press Start and Onionskin runs an agent in the background for you. Using Claude Code yourself? Type /onionskin {session.name} there.</span>
            </span>
            <span className="banner-actions">
              <button type="button" className="btn primary" disabled={readOnly} onClick={() => onAgent("start")} data-testid="agent-start">
                Start the agent
              </button>
              <button type="button" className="btn" onClick={onTakeBack} data-testid="take-back">
                Take back
              </button>
            </span>
          </div>
        )}
        {s === "closed" && (
          <div className="banner muted glass" data-lens="14 26" ref={glass} role="status" data-testid="banner-closed">
            <Icon name="lock" size={16} />
            <span>
              This session is closed. Run <code>onionskin open</code> again to continue.
            </span>
            {unsentEdits > 0 && (
              <button type="button" className="btn" onClick={onKeepMine} data-testid="closed-download">
                Download my edits
              </button>
            )}
          </div>
        )}
        {problem?.kind === "outside" && (
          <div className="banner warn glass" data-lens="14 26" ref={glass} role="alert" data-testid="banner-outside">
            <Icon name="alert" size={18} />
            <span className="banner-text">
              <strong>Someone changed this file outside Onionskin</strong>
              <span>Your original file was left untouched. Your unsent edits are still here: when you press Send they are saved as a copy next to the file, never over it.</span>
            </span>
            <button type="button" className="btn" onClick={onReloadDisk} data-testid="reload-disk-early">
              Reload the changed file
            </button>
            <button type="button" className="iconbtn sm" onClick={onDismiss} aria-label="Close this message" data-testid="outside-close">
              <Icon name="close" size={14} />
            </button>
          </div>
        )}
        {session.conflict?.side === "agent" && (
          <div className="banner warn glass" data-lens="14 26" ref={glass} role="alert" data-testid="banner-agent-outside">
            <Icon name="alert" size={18} />
            <span className="banner-text">
              <strong>Someone changed this file outside Onionskin</strong>
              <span>
                Your original file was left untouched.{" "}
                {session.conflict.copyName ? `A copy with ${session.conflict.local ? "the change" : "the agent's edits"} was saved as ${session.conflict.copyName} in the same folder, so you can open both in Word and combine them yourself.` : session.conflict.local ? "The change made on this Mac was not applied." : "The agent's write was not applied."}
              </span>
            </span>
            {session.conflict.copyName && session.canReveal && (
              <button type="button" className="btn" onClick={() => onShowCopy(session.conflict.copyPath)} data-testid="agent-show-in-folder">
                Show in folder
              </button>
            )}
            {session.conflict.copyName && !session.canReveal && <CopyButton text={session.conflict.copyPath || ""} />}
            <button type="button" className="btn" onClick={onReloadDisk} data-testid="reload-disk-agent">
              Reload the changed file
            </button>
            <button type="button" className="iconbtn sm" onClick={onDismissConflict} aria-label="Close this message" data-testid="agent-outside-close">
              <Icon name="close" size={14} />
            </button>
          </div>
        )}
        {problem?.kind === "error" && (
          <div className="banner err glass" data-lens="14 26" ref={glass} role="alert" data-testid="banner-error">
            <Icon name="alert" size={18} />
            <span className="banner-text">{problem.message}</span>
            {unsentEdits > 0 && (
              <button type="button" className="btn" onClick={onKeepMine} data-testid="error-download">
                Download my edits
              </button>
            )}
            <button type="button" className="iconbtn sm" onClick={onDismiss} aria-label="Dismiss this message">
              <Icon name="close" size={14} />
            </button>
          </div>
        )}
        {heldBack?.length > 0 && (
          <div className="banner warn glass held-back" data-lens="14 26" ref={glass} role="status" data-testid="banner-held-back">
            <Icon name="alert" size={18} />
            <span className="banner-text">
              <strong>
                {heldTitle(heldBack)}
              </strong>
              <ul className="held-list">
                {heldBack.slice(0, 5).map((x, i) => (
                  <li key={i} data-testid="held-item">
                    <span>{x.why}</span>
                    {x.text && (
                      <span className="held-text">
                        <q>{x.text}</q>
                        <CopyButton text={x.text} />
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              {heldBack.length > 5 && <span>and {heldBack.length - 5} more</span>}
              {heldCopy && <span data-testid="held-copy">Your version of the file, with everything you changed, was saved as {heldCopy} in the same folder.</span>}
            </span>
            <button type="button" className="iconbtn sm" onClick={onHeldBackDone} aria-label="Dismiss this message" data-testid="held-dismiss">
              <Icon name="close" size={14} />
            </button>
          </div>
        )}
        {notice && (
          <div className="banner toast glass" data-lens="14 26" ref={glass} role="status" data-testid="notice">
            <span>{notice}</span>
          </div>
        )}
      </div>
      {closeAsk && <CloseDialog edits={unsentEdits} onKeepMine={onKeepMine} onCloseAnyway={onCloseAnyway} onCancel={onCloseCancel} />}
      {problem?.kind === "conflict" && <ConflictDialog conflict={problem} onReloadDisk={onReloadDisk} onKeepMine={onKeepMine} onShowCopy={onShowCopy} onClose={onDismiss} />}
    </>
  );
}
