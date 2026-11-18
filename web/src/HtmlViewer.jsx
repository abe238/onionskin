import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createFrameView } from "./html-frame.js";
import { firstRunSeen, markFirstRunSeen, noticesFor, plainSentence, SAY } from "./html-view.js";
import { Icon } from "./Icons.jsx";
import { Overlay } from "./Overlay.jsx";
import "./html-view.css";

/**
 * The view of an HTML file (PLAN-html 3.2, R6, R14 to R18, R21): the render copy in `<iframe sandbox="allow-same-origin">`, set once per
 * version, a visible border and a label outside it, quiet notices above it, and the page's own layer over it for marks, hover and
 * clicks. The handle it passes to `onHost` is described in docs/contracts/engine-hooks.md ("HTML view").
 *
 * Props: copy (Uint8Array or string: the render copy, or the plain copy when `plain`), texts and stats (from the render worker), plain
 * (null, or why the plain copy is shown: "reparse", "nul", "lone_surrogate", "style_end", "crash"), version (the file's sha256), editable
 * (ids of the source text nodes the person may type in), ident (their identities: src/html.js editIdentities), mode ("edit" | "comment" | "pin"), marks ([{id, n, status, kind: "text" |
 * "element" | "pin", location, pin?: {xFrac, yFrac}}]), readOnly (no typing: a run is on, D5), onHost(handle | null), onPlain(reason) (asked
 * for the plain copy after a crash with "crash", and for the full view again with null).
 */
export function HtmlViewer({ copy, texts, stats, plain = null, version, editable, ident, mode = "edit", marks = [], onHost, onPlain, readOnly = false }) {
  const frameRef = useRef(null);
  const layerRef = useRef(null);
  const catchRef = useRef(null);
  const boxRef = useRef(null);
  const overlayBox = useRef(null);
  const pressing = useRef(false); // a press on the layer that has not been released yet
  const [ui, setUi] = useState({ phase: "loading", paint: { items: [], chip: null }, hover: null, hint: null, hideAt: null, flash: null, hiddenCount: 0, locked: false, lost: [] });
  const [copied, setCopied] = useState(-1);
  const ctlRef = useRef(null);
  if (!ctlRef.current) ctlRef.current = createFrameView({ ui: (patch) => setUi((u) => (Object.keys(patch).every((k) => JSON.stringify(u[k]) === JSON.stringify(patch[k])) ? u : { ...u, ...patch })) });
  const ctl = ctlRef.current;
  const [firstRun, setFirstRun] = useState(() => !firstRunSeen());
  const [attempt, setAttempt] = useState(0); // "Try the full view again" after a crash
  const scriptsOnly = !plain && stats?.bodyText === 0;

  useLayoutEffect(() => {
    if (scriptsOnly || !frameRef.current) return;
    // comment and pin modes: the focus goes back to the page's own layer, where the app's shortcuts work (R14: no listener in the frame)
    ctl.attach(frameRef.current, layerRef.current, () => catchRef.current?.focus({ preventScroll: true }));
    ctl.load({ copy, texts, editable, ident, plain, version, onHost, onPlain, attempt });
  }, [version, copy, plain, scriptsOnly, attempt]); // eslint-disable-line react-hooks/exhaustive-deps
  // layout effects: the controller has the new mode before the next input reaches the page's layer
  useLayoutEffect(() => ctl.setMode(mode), [mode, ctl]);
  useLayoutEffect(() => ctl.setMarks(marks), [marks, ctl]);
  useLayoutEffect(() => ctl.setLocked(readOnly), [readOnly, ctl]);
  useEffect(() => () => ctl.destroy(), [ctl]);

  // the wheel over the page's layer scrolls the frame: a non-passive listener on the page's own element
  useEffect(() => {
    const el = catchRef.current;
    if (!el) return;
    const onWheel = (e) => {
      e.preventDefault();
      ctl.wheel(e.deltaX, e.deltaY);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [mode, ui.phase, ctl]);
  // while the frame is inert (its parts are being read, right after a version loads) the browser gives it no wheel: the box under it gets
  // the wheel, and scrolls the frame, so a scroll right after opening is not lost (the layer's own wheel, above, is handled there)
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const onWheel = (e) => {
      if (e.defaultPrevented || !frameRef.current?.inert) return;
      e.preventDefault();
      ctl.wheel(e.deltaX, e.deltaY);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [ctl]);

  const notices = noticesFor({ stats, plain, locked: ui.locked, firstRun, hiddenCount: ui.hiddenCount, mismatch: ui.mismatch });
  const local = (e) => {
    const r = catchRef.current.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const full = scriptsOnly ? "scripts" : ui.phase === "crashed" && !plain ? "crashed" : null;
  const FACTS = ["scripts", "remote", "folder"];
  const facts = notices.filter((n) => FACTS.includes(n.id));
  const rows = notices.filter((n) => !FACTS.includes(n.id));
  const note = (n) => (
    <li key={n.id} className={`hv-note hv-note-${n.id}`} data-testid={`html-note-${n.id}`}>
      <Icon name={n.id === "running" ? "lock" : n.id === "hidden" ? "doc" : "info"} size={14} />
      {n.id === "hidden" ? (
        <button type="button" className="hv-link" onClick={() => ctl.showHidden()} data-testid="html-show-hidden">
          {n.text}
        </button>
      ) : (
        <span>{n.text}</span>
      )}
      {n.id === "plain" && plain === "crash" && onPlain && (
        // the plain view after a crash is not for good: the host is asked for the full view again
        <button type="button" className="btn hv-ok" onClick={() => (ctl.clearCrash(version), onPlain(null))} data-testid="html-full-again">
          {SAY.crashedRetry}
        </button>
      )}
      {n.id === "first-run" && (
        <button type="button" className="btn hv-ok" onClick={() => (markFirstRunSeen(), setFirstRun(false))} data-testid="html-first-run-ok">
          {SAY.firstRunOk}
        </button>
      )}
    </li>
  );

  return (
    <div className="hv" data-testid="html-viewer" data-mode={mode} data-phase={full || ui.phase} data-version={version}>
      {notices.length > 0 && (
        <ul className="hv-notes" aria-label="About this view" data-testid="html-notes">
          {rows.filter((n) => n.id === "first-run").map((n) => note(n))}
          {facts.length > 0 && (
            // the plain facts about what the view leaves out share one quiet line
            <li className="hv-note hv-note-facts">
              <Icon name="info" size={14} />
              <span>
                {facts.map((n) => (
                  <span key={n.id} className="hv-fact" data-testid={`html-note-${n.id}`}>
                    {n.text}
                  </span>
                ))}
              </span>
            </li>
          )}
          {rows.filter((n) => n.id !== "first-run").map((n) => note(n))}
        </ul>
      )}
      {ui.lost?.length > 0 && (
        // edits that could not be placed on a new version: their text, to copy and type again (R9: never dropped silently)
        <div className="hv-lost" role="alert" data-testid="html-lost">
          <p>
            <strong>{SAY.lostTitle(ui.lost.length)}.</strong> {SAY.lostWhy}
          </p>
          <ul>
            {ui.lost.map((e, i) => (
              <li key={i} data-testid="html-lost-edit">
                <span className="hv-lost-text">{e.newText || "(empty)"}</span>
                <button
                  type="button"
                  className="btn"
                  data-testid="html-lost-copy"
                  onClick={() => navigator.clipboard?.writeText(e.newText).then(() => setCopied(i), () => setCopied(-1))}
                >
                  {copied === i ? SAY.copied : SAY.copy}
                </button>
              </li>
            ))}
          </ul>
          <button type="button" className="btn" data-testid="html-lost-done" onClick={() => (setCopied(-1), ctl.handle?.dismissLost())}>
            {SAY.dismiss}
          </button>
        </div>
      )}
      <div className="hv-label" data-testid="html-label">
        {SAY.label}
      </div>
      {full && (
        <div className="hv-full" role="status" data-testid={`html-full-${full}`}>
          <Icon name={full === "scripts" ? "info" : "alert"} size={20} />
          <p>{full === "scripts" ? SAY.scriptsOnly : `${SAY.crashed}.`}</p>
          {full === "crashed" && !onPlain && (
            <button type="button" className="btn" onClick={() => (ctl.clearCrash(version), setAttempt((a) => a + 1))} data-testid="html-retry">
              {SAY.crashedRetry}
            </button>
          )}
        </div>
      )}
      {/* the frame stays mounted under a full-pane message, so a later load has an element to set */}
      <div className="hv-box" ref={boxRef} hidden={!!full}>
          <iframe ref={frameRef} className="hv-frame" sandbox="allow-same-origin" title={SAY.label} onLoad={() => ctl.loaded()} data-testid="html-frame" />
          <div className="hv-layer" ref={layerRef}>
            <Overlay boxRef={overlayBox} paint={ui.paint} onPin={(id) => ctl.markClick(id)} onChip={() => {}} onQuickChip={() => {}} canQuick={false} />
            {ui.flash && <div className="hv-flash" data-testid="html-flash" style={{ left: ui.flash.x, top: ui.flash.y, width: ui.flash.w, height: ui.flash.h }} />}
            {mode !== "edit" && ui.phase === "ready" && (
              <div
                ref={catchRef}
                tabIndex={-1}
                className={`hv-catch hv-catch-${mode}`}
                data-testid="html-catch"
                // a press that moves selects text (comment mode: a text anchor), a press that does not is a click on the element
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  pressing.current = true;
                  e.currentTarget.setPointerCapture?.(e.pointerId);
                  ctl.press(...local(e));
                }}
                onPointerMove={(e) => (pressing.current ? ctl.dragTo(...local(e)) : ctl.hover(...local(e)))}
                onPointerUp={(e) => {
                  if (!pressing.current) return;
                  pressing.current = false;
                  if (!ctl.release(...local(e))) ctl.pick(...local(e));
                }}
                onPointerCancel={() => (pressing.current = false)}
                onPointerLeave={() => !pressing.current && setUi((u) => ({ ...u, hover: null }))}
                onAuxClick={(e) => e.preventDefault()}
              />
            )}
            {ui.hover && mode !== "edit" && <div className="hv-hover" data-testid="html-hover" data-node={ui.hover.id} style={{ left: ui.hover.x, top: ui.hover.y, width: ui.hover.w, height: ui.hover.h }} />}
            {ui.hideAt && mode === "comment" && (
              <button type="button" className="btn hv-hide" style={{ left: ui.hideAt.x, top: ui.hideAt.y }} onClick={() => ctl.hide(ui.hideAt.id)} data-testid="html-hide">
                {SAY.hide}
              </button>
            )}
            {ui.hint && (
              <div className="hv-hint" role="status" data-testid="html-hint" style={{ left: ui.hint.x, top: ui.hint.y }}>
                {ui.hint.text}
              </div>
            )}
          </div>
      </div>
    </div>
  );
}

export { plainSentence };
