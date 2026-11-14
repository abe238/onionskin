import React, { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { glass } from "./lens.js";

const FOCUSABLE = 'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

/**
 * The window of "Save your writing voice" and "Load a voice guide". It is drawn on the page itself (not inside the side panel, whose glass
 * would clip it). Escape and the Cancel button close it; Tab stays inside while it is open. The keys are taken on the window, before the
 * phone drawer's own handlers (which would otherwise close the whole drawer on Escape, or pull Tab back into it), so a key pressed here
 * only ever affects this window.
 */
export function VoiceDialog({ title, testid, onClose, children }) {
  const ref = useRef(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => glass(ref.current), []);
  useEffect(() => {
    const el = ref.current;
    const ae = document.activeElement;
    const opener = ae && ae !== document.body ? ae : null;
    const items = () => [...el.querySelectorAll(FOCUSABLE)].filter((n) => n.offsetParent !== null);
    if (!el.contains(document.activeElement)) (items()[0] || el).focus({ preventScroll: true });
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        e.preventDefault();
        return close.current?.();
      }
      if (e.key !== "Tab") return;
      e.stopPropagation();
      const f = items();
      if (!f.length) return e.preventDefault();
      const out = !el.contains(document.activeElement);
      if (e.shiftKey && (out || document.activeElement === f[0])) {
        e.preventDefault();
        f[f.length - 1].focus();
      } else if (!e.shiftKey && (out || document.activeElement === f[f.length - 1])) {
        e.preventDefault();
        f[0].focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  return createPortal(
    <div className="scrim" data-testid={`${testid}-scrim`}>
      <div ref={ref} className="dialog glass vc-dialog" data-lens="22 40" role="dialog" aria-modal="true" aria-labelledby={`${testid}-title`} tabIndex={-1} data-testid={testid}>
        <h2 id={`${testid}-title`}>{title}</h2>
        {children}
      </div>
    </div>,
    document.body
  );
}
