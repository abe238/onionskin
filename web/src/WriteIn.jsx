import React from "react";
import "./writein.css";

/**
 * "Changes shown in place": the agent's new words drawn over the refreshed page (see writein-live.js). A cover in the page's color
 * wipes away over the new words, a "Was:" chip shows the old words struck through, and the new words keep a green tint that fades.
 * Everything here is decoration over the document: hidden from screen readers (the History panel is the record), never focusable,
 * never in the way of a click. The old words are untrusted text and are only rendered as React text.
 */
export function WriteIn({ items = [] }) {
  if (!items.length) return null;
  return (
    <div className="wi-layer" aria-hidden="true">
      {items.map((it) =>
        it.k === "was" ? (
          <div key={it.key} className="wi-was" data-testid="writein-was" style={{ "--wx": `${it.x}px`, "--ww": `${Math.min(420, 14 + 7 * (it.t.length + 5))}px`, top: it.y }}>
            Was: <s>{it.t}</s>
          </div>
        ) : it.k === "ins" ? (
          <div key={it.key} className="wi-ins" data-testid="writein-ins" style={{ left: it.x, top: it.y, width: it.w, height: it.h }} />
        ) : (
          <div key={it.key} className="wi-cover" data-testid="writein-cover" style={{ left: it.x, top: it.y, width: it.w, height: it.h, background: it.bg, animationDelay: `${it.delay}ms`, animationDuration: `${it.dur}ms` }} />
        )
      )}
    </div>
  );
}
