import React from "react";

/**
 * Diff render nodes (history-view.js diffNodes, suggest.js splitDiff) as plain text: removed words in <del>, added words in <ins>, each with a
 * label for screen readers, and "…" for text left out. Used by History and by the quick fix card, so the colors and the labels match.
 * Text only: nothing here is HTML.
 */
export function Nodes({ nodes }) {
  return nodes.map((n, i) =>
    n.t === "del" ? (
      <del key={i}>
        <span className="sr-only">Removed: </span>
        {n.text}
      </del>
    ) : n.t === "ins" ? (
      <ins key={i}>
        <span className="sr-only">Added: </span>
        {n.text}
      </ins>
    ) : n.t === "gap" ? (
      <span key={i} className="h-gap" aria-label="unchanged text left out">
        …
      </span>
    ) : (
      <span key={i}>{n.text}</span>
    )
  );
}
