import React, { useEffect, useRef, useState } from "react";
import { Icon } from "./Icons.jsx";
import { useFocusTrap } from "./hooks.js";
import { elapsedText, progressOf, stageOf, stopKind } from "./stage.js";

const APP_NAME = { docx: "Word", xlsx: "Excel", pptx: "PowerPoint", html: "your editor", markdown: "your editor" };
const appName = (format) => APP_NAME[format] || "your editor";

export function CopyButton({ text, label = "Copy", ariaLabel, testid = "copy-command" }) {
  const [done, setDone] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setBlocked(false);
      setDone(true);
      setTimeout(() => setDone(false), 1800);
    } catch {
      setBlocked(true); // clipboard blocked: the command is selectable text, one click selects all of it
    }
  };
  return (
    <button type="button" className="btn" onClick={copy} data-testid={testid} aria-label={ariaLabel || undefined}>
      <Icon name={done ? "check" : "copy"} size={14} /> {done ? "Copied" : blocked ? "Select it to copy" : label}
    </button>
  );
}

/** Where the held version went: the sentence, the copy's name, and what the person can do next. */
function CopyActions({ copy, copyError, canReveal, canDownload = true, onShowCopy, onKeepMine }) {
  if (!copy?.name) {
    return (
      <>
        <p className="hint" data-testid="conflict-copy-failed">
          The copy could not be saved in this folder{copyError ? ` (${copyError})` : ""}.{canDownload ? " Download it instead." : ""}
        </p>
        {canDownload && (
          <button type="button" className="btn primary" onClick={onKeepMine} data-testid="keep-mine">
            Download a copy
          </button>
        )}
      </>
    );
  }
  return canReveal ? (
    <button type="button" className="btn primary" onClick={() => onShowCopy(copy.path)} data-testid="show-in-folder">
      Show in folder
    </button>
  ) : (
    <span className="copy-path">
      <code data-testid="copy-path">{copy.path}</code> <CopyButton text={copy.path || ""} ariaLabel="Copy file path" />
    </span>
  );
}

function ConflictDialog({ conflict, format, canDownload = true, onReloadDisk, onKeepMine, onShowCopy, onClose }) {
  const ref = useRef(null);
  useFocusTrap(ref, true, onClose);
  const { copy, copyError, canReveal, side } = conflict;
  const who = side === "agent" ? "the agent's edits" : "your edits";
  return (
    <div className="scrim" data-testid="conflict-scrim">
      <div ref={ref} className="dialog glass" role="alertdialog" aria-modal="true" aria-labelledby="conflict-title" aria-describedby="conflict-body" tabIndex={-1} data-testid="banner-conflict">
        <div className="dialog-icon err" aria-hidden="true">
          <Icon name="alert" size={20} />
        </div>
        <h2 id="conflict-title">Someone changed this file outside Onionskin</h2>
        <p id="conflict-body" data-testid="conflict-body">
          Someone changed this file outside Onionskin. Your original file was left untouched.
          {copy?.name ? (
            <>
              {" "}
              A copy with {who} was saved as <strong data-testid="copy-name">{copy.name}</strong> in the same folder, so you can open both in {appName(format)} and combine them yourself.
            </>
          ) : (
            <> Nothing was written over it.</>
          )}
        </p>
        <div className="dialog-actions">
          <CopyActions copy={copy} copyError={copyError} canReveal={canReveal} canDownload={canDownload} onShowCopy={onShowCopy} onKeepMine={onKeepMine} />
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

function CloseDialog({ edits, canDownload = true, onKeepMine, onCloseAnyway, onCancel }) {
  const ref = useRef(null);
  useFocusTrap(ref, true, onCancel);
  return (
    <div className="scrim" data-testid="close-scrim">
      <div ref={ref} className="dialog glass" role="alertdialog" aria-modal="true" aria-labelledby="close-title" aria-describedby="close-body" tabIndex={-1} data-testid="close-dialog">
        <div className="dialog-icon err" aria-hidden="true">
          <Icon name="alert" size={20} />
        </div>
        <h2 id="close-title">Close with unsent edits?</h2>
        <p id="close-body">
          You typed {edits > 0 ? `${edits} edit${edits > 1 ? "s" : ""}` : "edits"} that were never sent. They live only in this page, so closing the session loses them.
        </p>
        <div className="dialog-actions">
          {canDownload && (
            <button type="button" className="btn primary" onClick={onKeepMine} data-testid="close-download">
              Download my edits
            </button>
          )}
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

/**
 * The local wait counter: seconds since this page first saw the batch that is out (it starts from zero when the page is opened mid-run; the server sends
 * no start time). It sits outside the speech of the status region (aria-hidden): a counter that spoke every second would be noise.
 */
function Elapsed({ batch }) {
  const t0 = useRef({ batch: null, at: 0 });
  if (t0.current.batch !== batch) t0.current = { batch, at: Date.now() };
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <span className="elapsed" aria-hidden="true" data-testid="banner-elapsed">
      {elapsedText(Date.now() - t0.current.at)}
    </span>
  );
}

export function Banners({ readOnly, onTakeOver, session, canDownload = session.format !== "html" && session.format !== "markdown", heldBack = null, heldCopy = null, onHeldBackDone, problem, notice, noticeAction = null, onStop = () => {}, stopping = false, onTakeBack, onAgent = () => {}, onReloadDisk, onKeepMine, onShowCopy, onDismissConflict, onDismiss, onCopyComments, unsentEdits = 0, closeAsk = false, onCloseAnyway, onCloseCancel }) {
  const s = session.state;
  const agent = session.agent || null;
  const failed = agent?.state === "failed" && agent.failure ? failureCopy(agent.failure) : null;
  const starting = agent?.state === "starting" && !failed;
  const handover = agent?.state === "handover" && !failed;
  const stranded = s === "stranded" && !failed && !starting && !handover;
  const stop = stopKind(session, readOnly) === "stop";
  const progress = progressOf(agent);
  return (
    <>
      <div className="banners">
        {readOnly && (
          <div className="banner warn glass" role="status" data-testid="banner-readonly">
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
          <div className="banner warn glass agent-banner" role="alert" data-testid={`banner-agent-${agent.failure.code}`}>
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
          <div className="banner info glass" role="status" data-testid="banner-agent-starting">
            <span className="working-mark" aria-hidden="true" />
            <span>{agent.busy ? "Getting the agent ready... Another document's agent is busy." : s === "stranded" ? "Starting the agent for your batch..." : "Getting the agent ready..."}</span>
          </div>
        )}
        {handover && (
          <div className="banner info glass" role="status" data-testid="banner-agent-handover">
            <Icon name="panel" size={16} />
            <span>The agent is open in Terminal. If Claude Code asks whether you trust the folder, choose Yes: it is Onionskin's own folder for this file. The agent then keeps working from there.</span>
          </div>
        )}
        {s === "listening" && !failed && !starting && !handover && (
          <div className="banner ok glass" role="status" data-testid="banner-listening">
            <span className="dot" aria-hidden="true" />
            <span>An agent is listening. Hit Send to Agent when you are ready.</span>
          </div>
        )}
        {(s === "working" || s === "queued") && (
          <div className="banner info glass agent-banner" role="status" data-testid="banner-working">
            <span className="working-mark" aria-hidden="true" />
            <span className="banner-text">
              <span className="banner-head">
                <strong data-testid="banner-stage">{stageOf(session).text || "Agent is working"}</strong>
                {!session.local && <Elapsed batch={session.deliveredBatchId || session.pendingBatchId} />}
              </span>
              <span data-testid="banner-lock-line">{session.format === "html" ? "Comment now, and fix text when it is done. An HTML page is read only while the agent works." : session.format === "markdown" ? "Comment now: your comments go to the agent next. You can type in the file again when the agent is done." : session.local ? "Keep editing. What you type is merged with this change when it finishes." : "Keep editing. What you type is merged with the agent's changes when it finishes."}</span>
              {progress && <span data-testid="banner-progress-line">{progress}</span>}
            </span>
            <span className="banner-actions">
              {stop && (
                <button type="button" className="btn" onClick={onStop} disabled={stopping} data-testid="agent-stop" aria-label={stopping ? undefined : "Stop the agent and take back your comments"}>
                  {stopping ? "Stopping..." : "Stop the agent"}
                </button>
              )}
              {/* with Stop shown, Take back alone would leave the background agent running: Stop takes the batch back too */}
              {!stop && (
                <button type="button" className="btn" onClick={onTakeBack} data-testid="take-back">
                  Take back editing
                </button>
              )}
            </span>
          </div>
        )}
        {stranded && (
          <div className="banner warn glass agent-banner" role="status" data-testid="banner-stranded">
            <Icon name="alert" size={18} />
            <span className="banner-text">
              <strong>Your batch is saved, but no agent is listening</strong>
              <span>Press Start and Onionskin runs an agent in the background for you. Using Claude Code yourself? Type /onionskin {session.file || session.name} there.</span>
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
          <div className="banner muted glass" role="status" data-testid="banner-closed">
            <Icon name="lock" size={16} />
            {session.reopen ? (
              <span className="banner-text">
                <span>This session is closed. To continue, paste this in a terminal:</span>
                <span className="banner-cmd">
                  <code data-testid="reopen-command">{session.reopen}</code>
                  <CopyButton text={session.reopen} label="Copy command" testid="copy-reopen" />
                </span>
              </span>
            ) : (
              <span>
                This session is closed. To continue, run <code>onionskin {/^[\w.-]+$/.test(session.name || "") ? session.name : `"${session.name || "<file>"}"`}</code> in a terminal, in the folder that holds the file.
              </span>
            )}
            {unsentEdits > 0 && canDownload && (
              <button type="button" className="btn" onClick={onKeepMine} data-testid="closed-download">
                Download my edits
              </button>
            )}
          </div>
        )}
        {problem?.kind === "outside" && session.conflict?.side !== "agent" && ( // the agent's conflict banner below already says it, with its copy
          <div className="banner warn glass" role="alert" data-testid="banner-outside">
            <Icon name="alert" size={18} />
            <span className="banner-text">
              <strong>Someone changed this file outside Onionskin</strong>
              {/* while the agent works, a reload would replace what the person typed during the run (it is merged only when the agent finishes) */}
              <span>{session.locked ? "Your original file was left untouched. Your edits are merged when the agent finishes." : session.format === "html" ? "Your original file was left untouched. Your unsent text edits stay in this page: reload, and they are placed on the changed file where their text still is." : session.format === "markdown" ? "Your original file was left untouched. Reload it to see the changed file; a comment made on the old version must be made again on the new one." : "Your original file was left untouched. Your unsent edits are still here: when you press Send they are saved as a copy next to the file, never over it."}</span>
            </span>
            {!session.locked && (
              <button type="button" className="btn" onClick={onReloadDisk} data-testid="reload-disk-early">
                Reload the changed file
              </button>
            )}
            <button type="button" className="iconbtn sm" onClick={onDismiss} aria-label="Close this message" data-testid="outside-close">
              <Icon name="close" size={14} />
            </button>
          </div>
        )}
        {session.conflict?.side === "agent" && (
          <div className="banner warn glass" role="alert" data-testid="banner-agent-outside">
            <Icon name="alert" size={18} />
            <span className="banner-text">
              <strong>Someone changed this file outside Onionskin</strong>
              <span>
                Your original file was left untouched.{" "}
                {session.conflict.copyName ? `A copy with ${session.conflict.local ? "the change" : "the agent's edits"} was saved as ${session.conflict.copyName} in the same folder, so you can open both in ${appName(session.format)} and combine them yourself.` : session.conflict.local ? "The change made on this Mac was not applied." : "The agent's write was not applied."}
              </span>
            </span>
            {session.conflict.copyName && session.canReveal && (
              <button type="button" className="btn" onClick={() => onShowCopy(session.conflict.copyPath)} data-testid="agent-show-in-folder">
                Show in folder
              </button>
            )}
            {session.conflict.copyName && !session.canReveal && <CopyButton text={session.conflict.copyPath || ""} ariaLabel="Copy file path" />}
            {!session.locked && (
              <button type="button" className="btn" onClick={onReloadDisk} data-testid="reload-disk-agent">
                Reload the changed file
              </button>
            )}
            <button type="button" className="iconbtn sm" onClick={onDismissConflict} aria-label="Close this message" data-testid="agent-outside-close">
              <Icon name="close" size={14} />
            </button>
          </div>
        )}
        {problem?.kind === "error" && (
          <div className="banner err glass" role="alert" data-testid="banner-error">
            <Icon name="alert" size={18} />
            <span className="banner-text">{problem.message}</span>
            {(problem.stream || problem.copy) && onCopyComments && (
              <button type="button" className="btn" onClick={onCopyComments} data-testid="copy-comments">
                Copy my comments
              </button>
            )}
            {unsentEdits > 0 && canDownload && (
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
          <div className="banner warn glass held-back" role="status" data-testid="banner-held-back">
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
                        <CopyButton text={x.text} ariaLabel="Copy edited text" />
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
          <div className="banner toast glass" role="status" data-testid="notice" data-has-action={noticeAction ? "1" : "0"}>
            <span>{notice}</span>
            {noticeAction && (
              <button type="button" className="btn sm" onClick={() => noticeAction.onClick()} aria-label={noticeAction.ariaLabel || noticeAction.label} data-testid="notice-action">
                {noticeAction.label}
              </button>
            )}
          </div>
        )}
      </div>
      {closeAsk && <CloseDialog edits={unsentEdits} canDownload={canDownload} onKeepMine={onKeepMine} onCloseAnyway={onCloseAnyway} onCancel={onCloseCancel} />}
      {problem?.kind === "conflict" && <ConflictDialog conflict={problem} format={session.format} canDownload={canDownload} onReloadDisk={onReloadDisk} onKeepMine={onKeepMine} onShowCopy={onShowCopy} onClose={onDismiss} />}
    </>
  );
}
