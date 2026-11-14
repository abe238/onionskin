import React from "react";
import { Icon } from "./Icons.jsx";
import { QuickAsk } from "./QuickAsk.jsx";
import { IS_MAC } from "./keys.js";
import { WriteIn } from "./WriteIn.jsx";

/** Highlights, numbered markers, pins, changed regions, thumbnail badges and the selection chip. Positions are overlay-local pixels computed once per frame by App. */
export function Overlay({ boxRef, paint, onChip, onQuickChip, onPin, onThumb, version, fresh, quick, onQuickText, onQuickSubmit, onQuickClose, onAway, stamps, canQuick = true }) {
  const { items, chip, chg = [], thumbs = [], drag = null, quickAt = null, away = null, writein = null } = paint;
  const pins = items.filter((it) => it.pin);
  return (
    <div className="overlay" ref={boxRef} data-testid="overlay" data-v={version} data-writein={writein?.state} data-writein-n={writein?.n}>
      {pins.some((it) => it.dot) && (
        <svg className="leaders" aria-hidden="true">
          {pins.filter((it) => it.dot).map((it) => (
            <g key={it.id} data-testid="pin-leader" data-comment-id={it.id}>
              <line x1={it.dot.x} y1={it.dot.y} x2={it.pin.x} y2={it.pin.y} />
              <circle cx={it.dot.x} cy={it.dot.y} r="3" />
            </g>
          ))}
        </svg>
      )}
      {chg.map((q, i) => (
        <div key={`chg-${i}`} className={`chg ${q.kind} ${fresh && q.kind !== "show" && q.kind !== "ask" ? "fresh" : ""}`} data-testid={q.kind === "show" ? "show-outline" : q.kind === "ask" ? "quick-outline" : "changed-region"} data-kind={q.kind} style={{ left: q.x, top: q.y, width: q.w, height: q.h }} />
      ))}
      <WriteIn items={writein?.items} />
      {items.map((it) =>
        it.rects ? (
          <React.Fragment key={it.id}>
            {it.rects.map((q, i) => (
              <div
                key={`${it.id}-${i}`}
                className={`hl ${it.whole ? "whole" : ""} ${it.unit ? `unit-${it.unit}` : ""} st-${it.status} ${fresh && it.status === "done" ? "fresh" : ""} ${it.prot ? "prot" : ""}`}
                data-testid="highlight"
                data-comment-id={it.id}
                data-unit={it.unit || undefined}
                style={{ left: q.x, top: q.y, width: q.w, height: q.h }}
              >
                {i === 0 && !it.mark && (
                  <span className={`num ${q.x < 44 ? "inset" : ""}`} aria-hidden="true">
                    {it.n}
                    {it.prot && <Icon name="lock" size={9} />}
                  </span>
                )}
              </div>
            ))}
            {it.mark && (
              <button type="button" className={`mk st-${it.status} ${it.prot ? "prot" : ""} ${it.mark.xl ? "xl" : ""}`} data-testid="marker" data-comment-id={it.id} style={{ left: it.mark.x, top: it.mark.y }} onClick={() => onPin(it.id)} aria-label={`Comment ${it.n}: show its card`}>
                <span>{it.n}</span>
              </button>
            )}
          </React.Fragment>
        ) : it.pin ? (
          <button
            key={it.id}
            type="button"
            className={`pinmark st-${it.status} ${it.prot ? "prot" : ""}`}
            data-testid="pin-mark"
            data-comment-id={it.id}
            data-at-x={it.dot ? Math.round(it.dot.x) : undefined}
            data-at-y={it.dot ? Math.round(it.dot.y) : undefined}
            style={{ left: it.pin.x, top: it.pin.y }}
            onClick={() => onPin(it.id)}
            aria-label={`Pin ${it.n}: show its comment`}
          >
            <span>{it.n}</span>
          </button>
        ) : null
      )}
      {chg.filter((q) => q.tag).map((q, i) => (
        // the tag is drawn after the comment outlines so nothing crosses it, in the page margin beside a paragraph when there is room (side), otherwise above the region, or inside its top right corner when the region touches the top edge
        <div key={`tag-${i}`} className={`chg-tagbox ${fresh ? "fresh" : ""}`} style={{ left: q.x, top: q.y, width: q.w, height: q.h }} aria-hidden="true">
          <span className={`chg-tag ${q.tag === "side" ? "side" : q.y < 24 ? "in" : ""}`} data-testid="changed-tag" data-kind={q.kind}>
            {q.kind === "added" ? "new" : "changed"}
          </span>
        </div>
      ))}
      {drag && <div className="dragbox" data-testid="drag-box" style={{ left: drag.x, top: drag.y, width: drag.w, height: drag.h }} />}
      {thumbs.map((t) => (
        <button key={t.index} type="button" className="thumbbadge" data-testid="thumb-badge" data-slide={t.index + 1} style={{ left: t.x, top: t.y }} onClick={() => onThumb(t.index)} aria-label={`Slide ${t.index + 1} has ${t.count} comment${t.count > 1 ? "s" : ""}: go to it`}>
          <span className="tbpill">
            <Icon name="comment" size={10} />
            {t.count}
          </span>
        </button>
      ))}
      {chip && (
        <div className="chip glass" data-testid="comment-chip-group" role="group" aria-label="Selection actions" style={{ left: chip.x, top: chip.y }}>
          <button type="button" className="chip-b" data-testid="comment-chip" onMouseDown={(e) => e.preventDefault()} onClick={onChip} aria-keyshortcuts="Control+Alt+M Meta+Alt+M" title={`Comment (${IS_MAC ? "\u2318\u2325M" : "Ctrl+Alt+M"})`}>
            <Icon name="comment" size={14} /> Comment
          </button>
          {canQuick && (
          <button type="button" className="chip-b chip-ask" data-testid="quick-ask-chip" onMouseDown={(e) => e.preventDefault()} onClick={onQuickChip} aria-keyshortcuts="Control+Shift+K Meta+Shift+K" title={`Quick ask: comment and send in one step (${IS_MAC ? "\u2318\u21E7K" : "Ctrl+Shift+K"})`}>
            Ask
          </button>
          )}
        </div>
      )}
      {quick && quickAt && <QuickAsk q={quick} at={quickAt} onText={onQuickText} onSubmit={onQuickSubmit} onClose={onQuickClose} stamps={stamps} />}
      <div role="status" className="away-live">
      {writein?.say && <span className="sr-only" data-testid="writein-status">{writein.say}</span>}
      {away && (
        <button type="button" className={`away glass-pop ${away.dir}`} data-testid="changes-away" data-dir={away.dir} onClick={onAway}>
          <Icon name="arrow" size={13} className={away.dir === "above" ? "up" : "down"} />
          {away.n} change{away.n > 1 ? "s" : ""} {away.dir}
        </button>
      )}
      </div>
    </div>
  );
}
