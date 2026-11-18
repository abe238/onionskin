import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { DeeperChecks, NOT_SET_UP } from "./DeeperChecks.jsx";
import { diffParts, flagText, isProtected, labelFor, relTime, shownFlags } from "./lib.js";
import { Icon } from "./Icons.jsx";
import { SIDE_MAX, SIDE_MIN, useFocusTrap } from "./hooks.js";
import { History } from "./History.jsx";
import { MOD, commentNavDir } from "./keys.js";
import { StylePrefs } from "./StylePrefs.jsx";
import { ReviewDraftButton } from "./VoiceReviewButton.jsx";
import { pendingWords, stageOf } from "./stage.js";
import { buildStack } from "./stack.js";
import { Question } from "./Question.jsx";
import { QuickChange } from "./QuickChange.jsx";
import { ReviewDropped, ReviewRow, Suggestions } from "./Suggestions.jsx";
import { ShieldChip, ShieldNote } from "./Shield.jsx";
import { COMMENT_TEXT_MAX, NOTE_MAX } from "../../src/retain.js"; // pure: the boxes take what the server keeps, so nothing typed is cut

// A comment's own state: Waiting once the batch is out, then a check mark or a declined mark the moment its result is known.
const STATUS = { draft: "Draft", sent: "Waiting", queued: "Queued", done: "Done", declined: "Declined", asked: "Needs your answer" };
// A sent comment whose batch is no longer out got no answer from the agent: say so instead of pulsing forever.
const waitingOn = (c, session) => !c.batchId || c.batchId === session.deliveredBatchId || c.batchId === session.pendingBatchId;
const KIND = { text: "Text", cell: "Cell", format: "Formatting", undo: "Undo", redo: "Redo", "paragraph.insert": "New paragraph", "paragraph.delete": "Deleted paragraph", table: "Table", "table.insert": "New table", "table.delete": "Deleted table" };
const kindLabel = (k) => KIND[k] || k.replace(/^(sheet|book|shape|slide)\./, (m) => `${m.slice(0, -1)} `).replace(/^./, (c) => c.toUpperCase());

function Diff({ before, after }) {
  const d = diffParts(before, after);
  return (
    <p className="diff">
      {d.removed ? (
        <>
          <del className="before">{d.removed}</del>
          <Icon name="arrow" size={12} />
        </>
      ) : null}
      <ins className="after">{d.added || "(removed)"}</ins>
    </p>
  );
}

function Num({ n, pin, done }) {
  return (
    <span className={`num ${pin ? "pin2" : ""} ${done ? "done" : ""}`} aria-hidden="true">
      {n}
    </span>
  );
}

function Card({ ack, live, mac, readOnly, held, checking, slow, c, n, rz, focus, onFocused, onText, onDelete, onGoto, onBack, onAnswer, format, activeSheet, open, canFold, onToggle }) {
  const ta = useRef(null);
  const li = useRef(null);
  useEffect(() => {
    // a folded card that is asked for is opened by the panel first; this runs again once it is open
    if (focus && open) {
      ta.current?.focus();
      li.current?.scrollIntoView({ block: "nearest" });
      onFocused();
    }
  }, [focus, open]); // eslint-disable-line react-hooks/exhaustive-deps
  const editable = c.status === "draft" && !c.answer && !readOnly; // an answered comment keeps the words the question was about
  const moved = rz && !rz.loc;
  const loc = rz?.loc || c.anchor?.location;
  const state = moved ? "moved" : rz ? "ok" : "local";
  const pin = c.kind === "pin";
  const prot = isProtected(loc);
  const label = labelFor(format, loc, { text: rz?.text, heading: rz?.heading });
  const otherSheet = format === "xlsx" && !!loc?.sheetName && !!activeSheet && loc.sheetName !== activeSheet;
  // A comment on selected words inside a PPTX shape: the host reports only the shape box, so the card quotes the words and says the outline is the whole shape.
  const inShape = format === "pptx" && c.kind === "text" && !!c.anchor?.quote && loc?.shapeId != null;
  const unitText = format === "xlsx" || format === "pptx"; // the card quotes the server's text of the cell or shape (another format: the page's own quote)
  const preview = inShape ? c.anchor.quote : rz && unitText ? rz.text : c.anchor?.quote;
  return (
    <li
      ref={li}
      className={`card st-${c.status} ${moved ? "moved" : ""} ${prot ? "prot" : ""}`}
      data-testid="comment-card"
      data-comment-id={c.id}
      data-kind={c.kind}
      data-status={c.status}
      data-resolved={state}
      data-resolved-method={rz?.method || ""}
      data-resolved-text={(rz?.text || "").slice(0, 160)}
      data-block={loc?.blockPath ? loc.blockPath[0] : ""}
      data-sheet={loc?.sheetName || undefined}
      data-range={loc?.range || undefined}
      data-sheet-active={format === "xlsx" ? (otherSheet ? "0" : "1") : undefined}
      data-slide={loc?.slideIndex != null ? loc.slideIndex + 1 : undefined}
      data-shape={loc?.shapeId ?? undefined}
      data-changed={rz?.changed ? "1" : undefined}
      data-open={open ? "1" : "0"}
      data-held={held ? "1" : undefined}
    >
      <div className="card-h">
        <Num n={n} pin={pin} />
        {!open && (
          <button type="button" className="locate peek" data-testid="card-open" aria-expanded="false" onClick={onToggle} aria-label={`${pin ? "Pin" : "Comment"} ${n}: show it`}>
            {c.text || label}
          </button>
        )}
        <button type="button" className="locate" hidden={!open} onClick={() => onGoto(c)} aria-label={moved ? `${pin ? "Pin" : "Comment"} ${n}: moved or removed` : `${pin ? "Pin" : "Comment"} ${n}: go to ${label}${otherSheet ? " (another sheet)" : ""}`}>
          {moved ? (
            <>
              <Icon name="alert" size={13} /> Moved or removed
            </>
          ) : (
            <>
              {prot && <Icon name="lock" size={12} />} {label}
              {otherSheet && <span className="aside">other sheet</span>}
            </>
          )}
        </button>
        {rz?.changed && !moved && (
          <span className="tag" data-testid="card-changed" title={format === "xlsx" ? "The value in this place is different now" : "The text here is different now"}>
            changed
          </span>
        )}
        <span className={`badge st-${c.status}`} data-testid="card-state">
          {c.status === "done" && <Icon name="check" size={11} />}
          {c.status === "declined" && <Icon name="close" size={11} />}
          {(c.status === "sent" || c.status === "queued") && live && <span className="wait-dot" aria-hidden="true" />}
          {held && checking ? "Checking whether this was sent..." : held && slow ? "Sending..." : c.status === "sent" && !live ? "No answer" : STATUS[c.status] || c.status}
        </span>
        {canFold && open && (
          <button type="button" className="iconbtn sm" data-testid="card-fold" aria-expanded="true" onClick={onToggle} aria-label={`${pin ? "Pin" : "Comment"} ${n}: fold it`} title="Fold">
            <Icon name="chev" size={12} className="h-down" />
          </button>
        )}
      </div>
      <div className="card-b" hidden={!open}>
      {moved && <p className="moved-note">This place is no longer in the file. Your comment is still sent.</p>}
      {((!pin && c.anchor?.quote) || (unitText && preview)) && !moved && (
        <blockquote data-testid="card-preview" data-in-shape={inShape ? "1" : undefined}>
          <span>{String(unitText ? preview : c.anchor.quote).slice(0, 140)}</span>
        </blockquote>
      )}
      {inShape && !moved && (
        <p className="scope-note" data-testid="card-scope">
          {rz?.quoteLost ? "These words are no longer in the shape. The outline marks the whole shape." : "Selected words in this shape. The editor marks the whole shape, not just these words."}
        </p>
      )}
      <textarea
        ref={ta}
        rows={2}
        value={c.text}
        placeholder={c.retry ? "Say what you meant, then send." : pin ? "What should change here?" : "Write a comment"}
        disabled={!editable}
        readOnly={held} // a Send in flight carried it: the words stay as sent until its answer (no visual change, so a quick one does not flicker)
        maxLength={COMMENT_TEXT_MAX}
        onChange={(e) => onText(c.id, e.target.value)}
        onKeyDown={(e) => {
          // Esc: back to the document at this comment's place (the caret goes there; nothing is lost, the text is kept)
          if (e.key === "Escape" && !e.nativeEvent.isComposing && !e.metaKey && !e.ctrlKey && !e.altKey) {
            e.preventDefault();
            e.stopPropagation();
            onBack(c);
          }
        }}
        aria-label={`${pin ? "Pin" : "Comment"} ${n} text`}
      />
      <Question c={c} readOnly={readOnly} onAnswer={onAnswer} />
      {c.result && (
        <p className="agentnote" data-testid="agent-note">
          {mac ? c.result : `Agent: ${c.result}`}
        </p>
      )}
      {c.localHint && c.status === "draft" && (
        <p className="local-hint" data-testid="local-hint">
          {c.localHint}
        </p>
      )}
      <div className="card-f">
        {ack && editable && c.text.trim() && (
          <span className="ack" data-testid="card-ack" data-ack={ack}>
            {ack === "saved" ? <Icon name="check" size={11} /> : <Icon name="alert" size={11} />} {ack === "saved" ? "Saved" : "Not saved"}
          </span>
        )}
        <button type="button" className="iconbtn sm danger" onClick={() => onDelete(c.id)} data-testid="delete-comment" disabled={readOnly || c.status === "sent" || c.status === "queued"} aria-label={`Delete ${pin ? "pin" : "comment"} ${n}`} title={c.status === "sent" || c.status === "queued" ? "On its way to the agent: Take back to change it" : "Delete"}>
          <Icon name="trash" size={14} />
        </button>
      </div>
      </div>
    </li>
  );
}

const SEV = { error: 0, warn: 1, info: 2 };
const SEV_ICON = { error: "alert", warn: "alert", info: "info" };

/** What the file check found after an agent run, calmly: errors first, one quiet line (newest run only) when the deeper check is not set up, and a Revert offer next to errors. */
function RunChecks({ a, canRevert, onRevert, newest }) {
  const flags = shownFlags(a.flags).sort((x, y) => (SEV[x.severity] ?? 1) - (SEV[y.severity] ?? 1));
  const hasError = flags.some((f) => f.severity === "error");
  const notice = a.checks?.notice;
  const [setupDetail, setSetupDetail] = useState("");
  const notSetUp = newest && NOT_SET_UP.includes(a.checks?.deep?.code);
  if (!flags.length && !notice && !a.changes?.items?.length) return null;
  return (
    <div className="checks" data-testid="run-checks" data-has-error={hasError ? "1" : "0"}>
      {a.changes?.items?.length > 0 && (
        <p className="check-changes" data-testid="run-changes">
          {a.changes.items.length}
          {a.changes.truncated ? "+" : ""} place{a.changes.items.length > 1 ? "s" : ""} changed in the file
        </p>
      )}
      {flags.length > 0 && (
        <ul className={`flags ${hasError ? "has-error" : ""}`} data-testid="activity-flags" aria-label="Notes from the file check">
          {flags.map((f, i) => (
            <li key={i} title={f.code} data-code={f.code} data-severity={f.severity || "warn"} className={`sev-${f.severity || "warn"}`}>
              <Icon name={SEV_ICON[f.severity] || "alert"} size={13} />
              <span>
                <b className="sev-word">{f.severity === "error" ? "Needs a look" : f.severity === "info" ? "Note" : "Check"}</b> {flagText(f)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {hasError && (
        <div className="check-revert" data-testid="check-revert">
          <p>{a.by === "local" ? "The check found something this change may have broken. You can go back to the file as it was before it." : "The check found something the agent may have broken. You can go back to the file as it was before this run."}</p>
          {canRevert && (
            <button type="button" className="btn sm" onClick={() => onRevert(a.id)} data-testid="revert">
              <Icon name="undo" size={13} /> Revert this run
            </button>
          )}
        </div>
      )}
      {notSetUp && <DeeperChecks clean={!flags.some((f) => f.severity !== "info")} onDetail={setSetupDetail} />}
      {notice && (
        <details className="check-details" data-testid="check-details">
          <summary>Details</summary>
          <p className="check-notice" data-testid="check-notice">
            {notice}
          </p>
          {setupDetail && (
            <p className="check-notice" data-testid="deeper-details">
              {setupDetail}
            </p>
          )}
          {flags.filter((f) => f.code === "deep_check_failed" && f.detail).map((f, i) => (
            <p key={i} className="check-notice" data-testid="check-detail">
              {f.detail}
            </p>
          ))}
        </details>
      )}
    </div>
  );
}

function Resizer({ width, onWidth }) {
  const drag = useRef(null);
  const down = (e) => {
    drag.current = { x: e.clientX, w: width };
    e.currentTarget.setPointerCapture(e.pointerId);
    document.body.classList.add("resizing");
  };
  const move = (e) => {
    if (drag.current) onWidth(drag.current.w + (drag.current.x - e.clientX));
  };
  const up = (e) => {
    drag.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    document.body.classList.remove("resizing");
  };
  const key = (e) => {
    const step = e.shiftKey ? 48 : 16;
    if (e.key === "ArrowLeft") onWidth(width + step);
    else if (e.key === "ArrowRight") onWidth(width - step);
    else if (e.key === "Home") onWidth(SIDE_MAX);
    else if (e.key === "End") onWidth(SIDE_MIN);
    else return;
    e.preventDefault();
  };
  return (
    <div
      className="resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the review panel"
      aria-valuemin={SIDE_MIN}
      aria-valuemax={SIDE_MAX}
      aria-valuenow={width}
      tabIndex={0}
      data-testid="sidebar-resizer"
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onKeyDown={key}
    />
  );
}

/** Phone bottom sheet: a drag handle. Tap or Enter toggles half and full height; dragging follows the finger and snaps to half, full, or closes. */
function Grab({ sheet, snap, onSnap, onClose }) {
  const st = useRef(null);
  const just = useRef(false); // a drag ends in a click event; it must not also toggle the height
  const down = (e) => {
    const el = sheet.current;
    if (!el) return;
    st.current = { y: e.clientY, h: el.getBoundingClientRect().height, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
    el.dataset.dragging = "1";
  };
  const vh = () => window.visualViewport?.height || window.innerHeight;
  const move = (e) => {
    const d = st.current;
    if (!d) return;
    const dy = e.clientY - d.y;
    if (Math.abs(dy) > 4) d.moved = true;
    if (d.moved) sheet.current.style.height = `${Math.max(120, Math.min(vh() - 10, d.h - dy))}px`;
  };
  const up = (e) => {
    const d = st.current;
    st.current = null;
    const el = sheet.current;
    if (!d || !el) return;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    delete el.dataset.dragging;
    if (!d.moved) return; // a plain tap is handled by the click
    const h = el.getBoundingClientRect().height;
    el.style.height = "";
    const half = vh() * 0.56;
    const full = vh() - 10;
    just.current = true;
    setTimeout(() => (just.current = false), 0);
    if (h < half * 0.62) onClose();
    else onSnap(h > (half + full) / 2 ? "full" : "half");
  };
  return (
    <button
      type="button"
      className="sheet-grab"
      data-testid="sheet-grab"
      aria-label={snap === "full" ? "Review panel is full height. Make it half height" : "Review panel is half height. Make it full height"}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onClick={() => !just.current && onSnap(snap === "full" ? "half" : "full")}
    />
  );
}

function Run({ a, open, canFold, onToggle, newest, canRevert, onRevert, nOf, byId }) {
  const done = a.by === "local" ? "Done on this Mac" : "Agent finished"; // a run on this Mac (src/local.js)
  const title = a.kind === "review" ? "Agent review" : a.kind === "voice" ? "Voice guide draft" : a.kind === "revert" ? "Reverted" : a.kind === "lease_expired" ? (a.by === "local" ? "Stopped on this Mac" : "Agent stopped") : a.reverted ? `${done} (reverted)` : done;
  // each answer is shown on its own comment card; only answers whose comment is gone are listed here
  const orphans = a.results.filter((r) => !byId.has(r.comment_id));
  return (
    <li className={`run run-${a.kind}`} data-testid="activity-entry" data-run-id={a.id} data-kind={a.kind} data-reverted={a.reverted ? "1" : "0"} data-open={open ? "1" : "0"}>
      <div className="run-h">
        <span className={`run-ic ${a.kind}`} aria-hidden="true">
          <Icon name={a.kind === "revert" ? "undo" : a.kind === "lease_expired" ? "alert" : "check"} size={13} />
        </span>
        <strong>{title}</strong>
        <ShieldChip a={a} />
        {!open && <span className="excerpt run-peek">{a.summary}</span>}
        {/* the folded line of the run that can be reverted gives the time's place to Revert, so the summary keeps its room */}
        {(open || !canRevert) && <time>{relTime(a.at)}</time>}
        {!open && canRevert && (
          <button type="button" className="btn quiet sm run-revert" onClick={() => onRevert(a.id)} data-testid="revert-folded" aria-label="Revert this run">
            <Icon name="undo" size={13} /> Revert
          </button>
        )}
        {canFold && (
          <button type="button" className="iconbtn sm" data-testid="run-fold" aria-expanded={open} onClick={onToggle} aria-label={open ? `Fold this entry: ${title}` : `Show this entry: ${title}`} title={open ? "Fold" : "Show"}>
            <Icon name="chev" size={12} className={open ? "h-down" : ""} />
          </button>
        )}
      </div>
      <div className="run-b" hidden={!open}>
        <p className="summary" data-testid="activity-summary">
          {a.summary}
        </p>
        <ShieldNote a={a} />
        {a.kind === "voice" && <ReviewDraftButton a={a} />}
        <ReviewDropped a={a} />
        {orphans.length > 0 && (
          <div className="results">
            {orphans.map((r) => (
              <p key={r.comment_id} className="result" data-testid="activity-result" data-status={r.status}>
                <span className={`chipn st-${r.status}`}>{r.status}</span>
                <span className="excerpt">A comment you deleted</span>
                {r.note ? <span className="rnote">{r.note}</span> : null}
              </p>
            ))}
          </div>
        )}
        <RunChecks a={a.kind === "review" ? { ...a, flags: (a.flags || []).filter((f) => f.code !== "bad_suggestion") } : a} newest={newest} canRevert={canRevert} onRevert={onRevert} />
        {canRevert && !(a.flags || []).some((f) => f.severity === "error") && (
          <button type="button" className="btn quiet sm" onClick={() => onRevert(a.id)} data-testid="revert">
            <Icon name="undo" size={13} /> Revert this run
          </button>
        )}
      </div>
    </li>
  );
}

export function Sidebar(p) {
  const { session, comments, resolved, open, narrow, phone } = p;
  const [snap, setSnap] = useState("half");
  const byId = new Map(comments.map((c) => [c.id, c]));
  const macBatches = new Set(session.activity.filter((a) => a.by === "local").map((a) => a.batchId)); // answers written on this Mac: no agent said them
  const nOf = new Map(comments.map((c, i) => [c.id, i + 1]));
  const latest = session.activity.find((a) => a.kind === "agent" && !a.reverted);
  const parts = [];
  if (p.counts.comments) parts.push(`${p.counts.comments} comment${p.counts.comments > 1 ? "s" : ""}`);
  if (p.counts.pins) parts.push(`${p.counts.pins} pin${p.counts.pins > 1 ? "s" : ""}`);
  if (p.counts.edits) parts.push(`${p.counts.edits} edit${p.counts.edits > 1 ? "s" : ""}`);
  const closed = session.state === "closed";
  const working = session.state === "working" || session.state === "queued";
  const stage = stageOf(session);
  const waitingBatch = working || !!session.pendingBatchId || !!session.deliveredBatchId; // a review or an Accept would be refused (409/423)
  const ref = useRef(null);
  const boxRef = useRef(null);
  const stack = buildStack(comments, p.changes, session, working);
  const newestRun = session.activity[0];
  // Answered comments and finished runs fold to one line. The newest round stays open only while it is the newest thing in the stack:
  // the moment a new card sits below it, it folds too. A run whose check found an error stays open while it can still be reverted.
  // A click opens or folds any of them; a card that is not answered (a draft, or a draft again after a revert) is always open.
  const [manual, setManual] = useState({});
  const toggle = (id, now) => setManual((m) => ({ ...m, [id]: !now }));
  const tailRun = stack[stack.length - 1]?.t === "run" ? stack[stack.length - 1].a : null;
  const hasError = (a) => (a.flags || []).some((f) => f.severity === "error");
  const cardFold = (c) => ["done", "declined"].includes(c.status);
  const cardOpen = (c) => !cardFold(c) || (manual[c.id] ?? (!!tailRun && c.batchId === tailRun.batchId));
  const runOpen = (a) => manual[a.id] ?? (a === tailRun || (a === latest && hasError(a)) || (a.kind === "voice" && a === session.activity.find((x) => x.kind === "voice"))); // the newest voice entry holds "Review draft"
  useEffect(() => {
    // a folded card that is asked for (its mark was clicked in the document) opens; a draft is open already and is not remembered as opened by hand
    const c = p.focusId && byId.get(p.focusId);
    if (c && cardFold(c)) setManual((m) => (m[c.id] === true ? m : { ...m, [c.id]: true }));
  }, [p.focusId]); // eslint-disable-line react-hooks/exhaustive-deps
  // The stack grows upward from the Send area: a new card, a new run or the start of a run brings the bottom of the stack into view.
  const lastKey = stack[stack.length - 1]?.key;
  const lastRun = newestRun?.id;
  const first = useRef(true);
  const seenRun = useRef(lastRun);
  // A check that finishes after the run (LibreOffice) can add the error and the Revert offer to a run that is already on screen: that is owed a look too.
  const errRun = newestRun && hasError(newestRun) ? newestRun.id : null;
  const seenErr = useRef(errRun);
  // A card that turns "Needs your answer" has the question the person must read: it is owed one look at the top of that block, even if the panel was shut when it arrived.
  const askedIds = comments.filter((c) => c.status === "asked").map((c) => c.id);
  const askedKey = askedIds.join(",");
  const seenAsked = useRef(new Set(askedIds));
  const owed = useRef(null); // the newest asked card not yet brought into view
  for (const id of askedIds) if (!seenAsked.current.has(id)) owed.current = id;
  seenAsked.current = new Set(askedIds);
  if (owed.current && !askedIds.includes(owed.current)) owed.current = null;
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    if (first.current) {
      first.current = false;
      box.scrollTop = box.scrollHeight;
      return;
    }
    const id = requestAnimationFrame(() => {
      // a new run that is taller than the panel starts at its top, so its summary is read first
      // a new run with an error must be seen even when newer cards sit below it
      const fresh = lastRun && lastRun !== seenRun.current;
      seenRun.current = lastRun;
      const lateErr = !fresh && errRun && errRun !== seenErr.current;
      seenErr.current = errRun;
      const ask = open && owed.current ? box.querySelector(`[data-comment-id="${owed.current}"] [data-testid="question"]`) : null;
      if (ask) {
        owed.current = null;
        const at = ask.getBoundingClientRect().top - box.getBoundingClientRect().top;
        const seen = at >= 0 && ask.getBoundingClientRect().bottom <= box.getBoundingClientRect().bottom;
        // scroll the panel's own area only (never scrollIntoView, which can move the document too)
        if (!seen) box.scrollTo({ top: Math.max(0, box.scrollTop + at - 8), behavior: "smooth" });
        return; // visible already, or now on its way: the newest-card scroll below must not take it away
      }
      const entry = fresh ? box.querySelector(`[data-run-id="${lastRun}"]`) : null;
      if (entry && (entry.offsetHeight > box.clientHeight - 24 || (newestRun && hasError(newestRun) && lastKey !== lastRun))) {
        // the run starts at the top of the panel; when its Revert offer would then sit below the panel, the panel goes on down until the offer is fully in view
        // (the panel's own area only: scrollIntoView can move the document too, and it never looked at the Revert offer)
        const b = box.getBoundingClientRect();
        let shift = entry.getBoundingClientRect().top - b.top - 8;
        const rev = hasError(newestRun) ? entry.querySelector('[data-testid="check-revert"]') : null;
        if (rev) shift = Math.max(shift, rev.getBoundingClientRect().bottom - (b.bottom - 16));
        box.scrollTo({ top: Math.max(0, box.scrollTop + shift), behavior: "smooth" });
      } else if (lateErr) {
        const rev = box.querySelector(`[data-run-id="${errRun}"] [data-testid="check-revert"]`);
        const over = rev ? rev.getBoundingClientRect().bottom - (box.getBoundingClientRect().bottom - 16) : 0;
        if (over > 0) box.scrollTo({ top: box.scrollTop + over, behavior: "smooth" });
      } else box.scrollTo({ top: box.scrollHeight, behavior: "smooth" });
    });
    return () => cancelAnimationFrame(id);
  }, [lastKey, lastRun, working, open, askedKey, errRun]);
  useFocusTrap(ref, narrow && open, p.onToggle);
  useEffect(() => {
    if (open) setSnap("half"); // the sheet always opens at half height
  }, [open]);
  const label = p.held?.checking ? "Checking..." : p.sending ? "Sending..." : working ? "Queue for the agent" : p.quickLabel || "Send to Agent";
  const canSend = !(p.sending || closed || p.readOnly || p.pendingSend === 0);
  // Cmd+Enter (Mac) or Ctrl+Enter (Windows, Linux) in any comment, pin or note box sends the batch, the same as the Send button.
  const sendKey = (e) => {
    // Next / previous comment box (Alt+Down / Alt+Up; Cmd+Option on a Mac): the document scrolls to that comment's place
    const dir = commentNavDir(e);
    if (dir && e.target.tagName === "TEXTAREA" && e.target.closest('[data-testid="comment-card"]')) {
      const boxes = [...ref.current.querySelectorAll('[data-testid="comment-card"] textarea:not(:disabled)')];
      const at = boxes.indexOf(e.target);
      if (at < 0 || boxes.length < 2) return;
      e.preventDefault();
      const to = boxes[(at + dir + boxes.length) % boxes.length];
      to.focus();
      to.scrollIntoView({ block: "nearest" });
      const c = byId.get(to.closest("[data-comment-id]")?.dataset.commentId);
      if (c) p.onPeek(c);
      return;
    }
    if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.target.tagName !== "TEXTAREA" || e.nativeEvent.isComposing) return;
    e.preventDefault();
    if (canSend) p.onSend();
  };
  return (
    <>
      {narrow && open && <div className="drawer-scrim" onClick={p.onToggle} aria-hidden="true" />}
      <aside
        id="review-panel"
        ref={ref}
        className={`sidebar glass ${narrow ? "drawer" : ""} ${open ? "open" : "shut"}`}
        data-snap={phone ? snap : undefined}
        data-testid="sidebar"
        aria-label="Review panel"
        role={narrow ? "dialog" : "complementary"}
        aria-modal={narrow && open ? "true" : undefined}
        inert={!open}
        tabIndex={-1}
        onKeyDown={sendKey}
      >
        {!narrow && open && <Resizer width={p.width} onWidth={p.onWidth} />}
        {phone && <Grab sheet={ref} snap={snap} onSnap={setSnap} onClose={p.onToggle} />}
        <div className="pane main">
        <div className="side-h">
          <h2>Review</h2>
          <span className="side-sub" data-testid="side-sub">{working ? stage.text : pendingWords(session) || "Edit, comment, then send"}</span>
          <button type="button" className="iconbtn" onClick={p.onToggle} aria-label="Hide the review panel" title="Hide (Ctrl or Cmd + \)" data-testid="sidebar-hide">
            <Icon name={narrow ? "close" : "panel"} />
          </button>
        </div>
        <div className="scroll" ref={boxRef}>
          {!phone && <History sid={p.sid} refreshKey={p.historyKey} canShow={p.historyCanShow} onShow={p.onHistoryShow} fileName={session.name} />}
          {p.agentPanel}
          {stack.length === 0 && (
            <p className="empty stack-empty" data-testid="stack-empty">
              Edit the document, or select text and press Comment. Each thing you do lands here, newest at the bottom, with the agent's answers.
            </p>
          )}
          <ul className="list stack" data-testid="panel-stack" aria-label="Your edits and comments and the agent's answers, oldest first">
            {stack.map((it) =>
              it.t === "comment" ? (
                <Card key={it.key} ack={p.ack} mac={macBatches.has(it.c.batchId)} live={waitingOn(it.c, session)} readOnly={p.readOnly} held={!!p.held?.ids.has(it.c.id)} checking={!!p.held?.checking} slow={p.sending} c={it.c} n={nOf.get(it.c.id)} rz={resolved[it.c.id]} focus={p.focusId === it.c.id} onFocused={p.onFocused} onText={p.onText} onDelete={p.onDelete} onGoto={p.onGoto} onBack={p.onBack} onAnswer={p.onAnswer} format={session.format} activeSheet={p.activeSheet} open={cardOpen(it.c)} canFold={cardFold(it.c)} onToggle={() => toggle(it.c.id, cardOpen(it.c))} />
              ) : it.t === "edit" ? (
                <li key={it.key} className="change" data-testid="change-item" data-kind={it.e.kind}>
                  <div className="change-h">
                    <span className="loc" data-testid="change-label">
                      {isProtected(it.e.location) && <Icon name="lock" size={12} />}
                      {it.e.label}
                    </span>
                    <span className="kind">{kindLabel(it.e.kind)}</span>
                  </div>
                  {(it.e.before || it.e.after) && <Diff before={it.e.before} after={it.e.after} />}
                </li>
              ) : it.t === "working" ? (
                <li key={it.key} className="run run-working" data-testid="activity-working" role="status">
                  <div className="run-h">
                    <span className="run-ic working" aria-hidden="true" />
                    <strong data-testid="stage-text">{stage.text}</strong>
                  </div>
                  {stage.step > 0 ? (
                    <div className="stagebar" role="progressbar" aria-label="Agent progress" aria-valuemin={0} aria-valuemax={stage.of} aria-valuenow={stage.step} aria-valuetext={stage.text} data-testid="stage-bar" data-stage={stage.key}>
                      {Array.from({ length: stage.of }, (_, i) => (
                        <i key={i} data-on={i < stage.step ? "1" : "0"} data-now={i === stage.step - 1 ? "1" : "0"} />
                      ))}
                    </div>
                  ) : (
                    <div className="shimmer" aria-hidden="true">
                      <i />
                      <i />
                    </div>
                  )}
                </li>
              ) : (
                <Run key={it.key} a={it.a} open={runOpen(it.a)} canFold onToggle={() => toggle(it.a.id, runOpen(it.a))} newest={it.a === latest} canRevert={it.a === latest && !session.locked && !p.readOnly} onRevert={p.onRevert} nOf={nOf} byId={byId} />
              )
            )}
            <Suggestions cards={session.suggestions || []} reviewId={session.activity.find((a) => a.kind === "review")?.batchId} readOnly={p.readOnly} waiting={waitingBatch} resetOn={`${session.seq}`} onChoose={p.onSuggest} onShow={p.onShowSuggestion} />
          </ul>
        </div>
        </div>
        <div className="pane composer">
          {session.format !== "html" && <ReviewRow why={closed ? "This session is closed." : waitingBatch ? "Wait for the agent to finish, then try again." : p.counts.edits > 0 ? "Send your edits first, so the agent reads your latest text." : null} readOnly={p.readOnly} resetOn={`${session.seq}`} onReview={p.onReview} />}
          <label htmlFor="overall">Overall instructions</label>
          <textarea id="overall" data-testid="overall-note" rows={3} value={p.note} disabled={p.readOnly} readOnly={!!p.held?.note || !!p.rewriting} maxLength={NOTE_MAX} onChange={(e) => p.onNote(e.target.value)} placeholder="Anything the agent should know about this whole batch" />
          <QuickChange match={p.quickMatch} agent={p.quickAgent} onAgent={p.onQuickAgent} />
          <StylePrefs sid={p.sid} session={session} readOnly={p.readOnly} />
          <button type="button" className="btn primary send" data-testid="send" disabled={!canSend} onClick={p.onSend} title={`${label} (${MOD}+Enter)`} aria-keyshortcuts="Meta+Enter Control+Enter" aria-describedby="send-hint" data-busy={p.busy ? "1" : "0"} data-slow={p.sending ? "1" : "0"}>
            <Icon name="send" size={16} />
            <span className="send-label">{label}</span>
            {parts.length > 0 && <span className="send-counts">{parts.join(", ")}</span>}
          </button>
          <p className="send-hint" id="send-hint">
            {closed ? "This session is closed." : p.quickLabel ? "Onionskin does this itself on this Mac. You can undo it." : p.readOnly ? "This tab is read-only. Use the other tab to send." : p.pendingSend === 0 && p.heldEdits > 0 ? "What you type now is merged when the agent finishes." : p.pendingSend === 0 ? (working ? `${stage.text || "The agent is working"}. Nothing new to send yet.` : "Nothing to send yet. Edit, comment or write a note.") : working ? `${stage.text || "The agent is working"}. Your next batch waits until it finishes.` : `The agent gets your edits, comments, pins and note as one batch. ${MOD}+Enter sends from any comment box.`}
          </p>
        </div>
      </aside>
    </>
  );
}
