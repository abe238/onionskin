import React, { useEffect, useLayoutEffect, useRef } from "react";
import { Icon } from "./Icons.jsx";
import { MOD } from "./keys.js";
import { Stamps } from "./Stamps.jsx";
import { Suggestion } from "./Suggestion.jsx";
import { COMMENT_TEXT_MAX } from "../../src/retain.js"; // the comment it makes takes no more

/**
 * The Quick ask composer: a small glass box at the selection. Cmd/Ctrl+Enter sends the comment and the batch in one gesture, Enter adds a line
 * (the same rule as every comment box), Esc closes it (while a quick fix card is up, the first Esc closes the card and writes nothing). When nothing can be sent (read-only tab, closed session) it says why and the box stays off.
 */
export function QuickAsk({ q, at, onText, onSubmit, onClose, stamps }) {
  const sug = stamps?.suggest; // quick fixes (App.jsx): {sg, on, format, onOn, onStamp, onUse, onAgent, onRetry, onCardClose, busy}
  const ta = useRef(null);
  const box = useRef(null);
  useEffect(() => {
    (q.blocked ? box.current : ta.current)?.focus({ preventScroll: true });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // The box grows with the stamp row and edit mode. Keep all of it inside the page: slide up when it would run past the bottom (the CSS caps its height and scrolls inside).
  const atY = useRef(at.y);
  atY.current = at.y;
  const fit = () => {
    const el = box.current;
    const host = el?.offsetParent;
    if (!el || !host) return;
    el.style.top = `${Math.round(Math.max(8, Math.min(atY.current, host.clientHeight - el.offsetHeight - 8)))}px`;
  };
  useLayoutEffect(fit); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (typeof ResizeObserver === "undefined" || !box.current) return;
    const ro = new ResizeObserver(fit);
    ro.observe(box.current);
    return () => ro.disconnect();
  }, [at.y]); // eslint-disable-line react-hooks/exhaustive-deps
  const key = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (sug?.sg) return sug.onCardClose();
      return onClose(true, false);
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && !e.nativeEvent.isComposing && e.target.tagName === "TEXTAREA") {
      e.preventDefault(); // one rule everywhere: Cmd/Ctrl+Enter sends, Enter is a new line
      e.stopPropagation();
      onSubmit();
    }
  };
  const quote = (q.anchor.quote || "").replace(/\s+/g, " ").trim();
  return (
    <div ref={box} className="qa glass-pop" role="dialog" aria-label="Quick ask" aria-describedby="qa-hint" tabIndex={-1} data-testid="quick-ask" data-blocked={q.blocked ? "1" : "0"} style={{ left: at.x, top: at.y, width: at.w }} onKeyDown={key}>
      <div className="qa-head">
        {quote ? (
          <p className="qa-quote" data-testid="quick-ask-quote">
            {quote.slice(0, 90)}
            {quote.length > 90 ? "..." : ""}
          </p>
        ) : (
          <span />
        )}
        <button type="button" className="iconbtn qa-close" onClick={() => onClose(true, true)} aria-label="Close" data-testid="quick-ask-close">
          <Icon name="close" size={14} />
        </button>
      </div>
      {stamps && sug?.sg ? (
        <Suggestion sg={sug.sg} busy={sug.busy} onUse={sug.onUse} onAgent={sug.onAgent} onRetry={sug.onRetry} />
      ) : (
        stamps && <Stamps load={stamps.load} dirtyRef={stamps.dirtyRef} own={stamps.own} save={stamps.save} disabled={!!q.blocked} onStamp={sug?.onStamp || onSubmit} suggest={sug} />
      )}
      <textarea ref={ta} rows={2} value={q.text} readOnly={!!sug?.sg} disabled={!!q.blocked} maxLength={COMMENT_TEXT_MAX} onChange={(e) => onText(e.target.value)} placeholder="What should change here?" aria-label="What should change here?" data-testid="quick-ask-text" />
      <div className="qa-foot">
        <p className="qa-hint" id="qa-hint" role="status" data-testid="quick-ask-hint" data-tone={q.blocked || q.nudge ? "warn" : "info"}>
          {q.blocked ? (
            <>
              <Icon name="lock" size={12} /> {q.blocked}
            </>
          ) : q.nudge ? (
            `Write what should change, then press ${MOD}+Enter.`
          ) : (
            <>
              {MOD}+Enter sends with your other changes. Enter adds a line. Esc discards.
            </>
          )}
        </p>
        <button type="button" className="btn primary sm qa-send" disabled={!q.text.trim() || !!q.blocked} onClick={() => onSubmit()} data-testid="quick-ask-send">
          Send
        </button>
      </div>
    </div>
  );
}
