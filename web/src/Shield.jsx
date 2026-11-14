import React from "react";
import { Icon } from "./Icons.jsx";
import { SHIELD, shieldOf } from "./shield.js";
import "./shield.css";

// ShieldChip sits in the run header (so it shows when the run is folded); ShieldNote replaces the old fixed line in the run body.
// Both draw only fixed words and the reported count. The reported strings are never rendered.

export function ShieldChip({ a }) {
  const s = shieldOf(a);
  if (!s) return null;
  return (
    <span className="shield-chip" data-testid="shield-badge" data-count={s.n} data-more={s.more ? "1" : "0"} role="img" aria-label={s.aria} title={s.line}>
      <Icon name="shield" size={12} />
      <span aria-hidden="true">{s.chip}</span>
    </span>
  );
}

export function ShieldNote({ a }) {
  const s = shieldOf(a);
  if (!s) return null;
  return (
    <div className="shield-note" data-testid="activity-doc-instructions">
      <strong>{SHIELD.heading}</strong>
      <p>{s.line}</p>
      {s.checked && <p>{SHIELD.checked}</p>}
      <p>{SHIELD.hidden}</p>
      <p>{SHIELD.report}</p>
    </div>
  );
}
