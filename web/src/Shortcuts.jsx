import React, { useEffect, useRef } from "react";
import { Icon } from "./Icons.jsx";
import { useFocusTrap } from "./hooks.js";
import { SHORTCUTS } from "./keys.js";

/** The keyboard shortcuts popover: every shortcut the app adds, with the keys written for this platform. Esc or a click elsewhere closes it and focus returns to where it was. */
export function Shortcuts({ onClose }) {
  const ref = useRef(null);
  useFocusTrap(ref, true, onClose);
  useEffect(() => {
    const away = (e) => !ref.current?.contains(e.target) && !e.target.closest?.('[data-testid="shortcuts-button"]') && onClose?.();
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [onClose]);
  return (
    <div ref={ref} className="menu glass-pop shortcuts" role="dialog" aria-label="Keyboard shortcuts" tabIndex={-1} data-testid="shortcuts">
      {onClose && (
        <div className="bgpop-h">
          <h2>Keyboard shortcuts</h2>
          <button type="button" className="iconbtn" aria-label="Close" data-testid="shortcuts-close" onClick={() => onClose?.()}>
            <Icon name="close" size={16} />
          </button>
        </div>
      )}
      {SHORTCUTS.map(([group, rows]) => (
        <section key={group} aria-label={group}>
          <h3>{group}</h3>
          <ul>
            {rows.map(([what, keys]) => (
              <li key={what} data-testid="shortcut-row">
                <span>{what}</span>
                <kbd>{keys}</kbd>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
