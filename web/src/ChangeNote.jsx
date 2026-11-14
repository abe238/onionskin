import React, { useEffect, useRef, useState } from "react";
import { api } from "./lib.js";
import { Icon } from "./Icons.jsx";
import { changeNote } from "./history-view.js";
import { TrackedExport } from "./TrackedExport.jsx";
import "./change-note.css";

// "What changed": one click builds a plain-text note of the net change since the oldest stored version, shown in a read-only box with a
// Copy button. The note itself is read-only (GET /api/history/all); for a Word file the box also offers "Save a copy with tracked changes" for everything it covers (TrackedExport, id "all"), which writes a copy next to the file, never the file. The text is document text, so it is only ever a textarea value (React text), never HTML.
// Copy is a second click on purpose: the clipboard write must happen synchronously inside that click (Safari refuses it after an await).

const MESSAGES = {
  empty: "Nothing has changed in this file yet.",
  error: "The changes could not be compared right now.",
};

export function ChangeNote({ sid, fileName, refreshKey, onOpen }) {
  const [view, setView] = useState(null); // {text, docx} | {msg} | null
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(null); // "yes" | "blocked" | null
  const seq = useRef(0);
  const box = useRef(null);
  const timer = useRef(0);

  // the note describes the file as it was when the button was pressed: a new version of the session makes it stale
  useEffect(() => {
    seq.current++;
    setView(null);
    setCopied(null);
    setBusy(false);
  }, [sid, refreshKey]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const press = () => {
    const n = ++seq.current;
    onOpen?.();
    setBusy(true);
    setCopied(null);
    api(`/api/history/all?s=${sid}`)
      .then((d) => {
        if (n !== seq.current) return;
        const text = changeNote(d, fileName);
        setView(text ? { text, docx: d.format === "docx" } : { msg: d.unavailable ? MESSAGES.error : MESSAGES.empty });
      })
      .catch(() => n === seq.current && setView({ msg: MESSAGES.error }))
      .finally(() => n === seq.current && setBusy(false));
  };

  const copy = () => {
    box.current?.select(); // also the fallback: the text is already selected for Cmd+C
    let p = null;
    try {
      p = navigator.clipboard ? navigator.clipboard.writeText(view.text) : null; // called synchronously in the click
    } catch {
      p = null;
    }
    if (!p) return setCopied("blocked");
    p.then(() => {
      setCopied("yes");
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(null), 1800);
    }).catch(() => setCopied("blocked"));
  };

  return (
    <>
      <button type="button" className="cn-btn" data-testid="change-note-button" disabled={busy} onMouseDown={(e) => e.preventDefault()} onClick={press}>
        What changed
      </button>
      {view && (
        <div className="cn-box" data-testid="change-note">
          {view.text ? (
            <>
              <label className="cn-label" htmlFor="change-note-text">
                A note you can paste into an email
              </label>
              <textarea id="change-note-text" ref={box} className="cn-text" data-testid="change-note-text" readOnly rows={8} value={view.text} onFocus={(e) => e.target.select()} />
              <div className="cn-actions">
                <button type="button" className="btn sm" data-testid="change-note-copy" onMouseDown={(e) => e.preventDefault()} onClick={copy}>
                  <Icon name={copied === "yes" ? "check" : "copy"} size={14} /> {copied === "yes" ? "Copied" : "Copy"}
                </button>
                <span className="cn-status" data-testid="change-note-status" role="status">
                  {copied === "blocked" ? "Select the text and press Cmd+C." : ""}
                </span>
              </div>
              {view.docx && <TrackedExport sid={sid} id="all" />}
            </>
          ) : (
            <p className="cn-msg" data-testid="change-note-msg" role="status">
              {view.msg}
            </p>
          )}
        </div>
      )}
    </>
  );
}
