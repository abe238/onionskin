import React, { useRef, useState } from "react";
import { api } from "./lib.js";
import { VoiceDialog } from "./VoiceDialog.jsx";
import { SECTIONS, parseGuide } from "./voice-guide.js";
import { GUIDE_MAX } from "./voice-ui.js";

const keep = (e) => e.preventDefault();
const READ_MAX = 64 * 1024; // at most this much of a file is read
const BAD_FILE = "That file could not be read as text. Choose a .md or .txt file.";
const chars = (s) => [...s.trim()].length;

/**
 * "Load a voice guide": paste or load a .md or .txt file (read here in the browser; the server never sees a path), edit it, and save it.
 * Nothing is stored until "Save guide". More than 7,000 characters is refused, never cut: Save stays off until the person trims it.
 */
export function VoiceImport({ voice, onVoice }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [on, setOn] = useState(true);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef(null);
  const readId = useRef(0);
  const [reading, setReading] = useState(false);
  const stored = voice.guide || { text: "", on: false };

  // the box starts with what is saved; set in the same step that opens it, so the first paint already shows it
  const show = () => {
    setText(stored.text);
    setOn(stored.text ? stored.on : true);
    setError("");
    setSaved("");
    setOpen(true);
  };

  // "Short form only" stays chosen while the text still has an "In short" section the server will take; a save never quietly turns it off
  const short = stored.send === "short";
  const shortBody = parseGuide(text.trim()).sections.find((s) => s.id === "short")?.body || "";
  const keepsShort = short && shortBody !== "" && [...shortBody].length <= SECTIONS[0].max;
  const n = chars(text);
  const tooLong = n > GUIDE_MAX;
  const close = () => {
    readId.current++;
    setReading(false);
    setOpen(false);
  };

  async function load(file) {
    setError("");
    if (!file) return;
    const id = ++readId.current;
    setReading(true);
    try {
      const bytes = new Uint8Array(await file.slice(0, READ_MAX).arrayBuffer());
      if (id !== readId.current) return;
      const s = new TextDecoder("utf-8").decode(bytes);
      if (bytes.includes(0) || s.includes("�")) throw new Error("not text");
      setText(s.replace(/\r\n?/g, "\n"));
    } catch {
      if (id !== readId.current) return;
      setError(BAD_FILE);
    }
    setReading(false);
    if (input.current) input.current.value = ""; // the same file can be chosen again
  }

  async function send(body, message) {
    setBusy(true);
    setError("");
    try {
      onVoice(await api("/api/voice/guide", { method: "POST", body }));
      setSaved(message);
      setOpen(false);
    } catch {
      setError("Could not save that. Try again.");
    }
    setBusy(false);
  }

  return (
    <>
      <button type="button" className="btn sm" data-testid="voice-import-open" onMouseDown={keep} onClick={show}>
        Load a voice guide
      </button>
      {saved && (
        <p className="vc-ok" role="status" data-testid="voice-import-saved">
          {saved}
        </p>
      )}
      {open && (
        <VoiceDialog title="Load a voice guide" testid="voice-import" onClose={close}>
          <p>Paste or load your own voice.md. You can edit it before you save.</p>
          <label htmlFor="voice-guide-text">Your voice guide</label>
          <textarea id="voice-guide-text" className="vc-text" data-testid="voice-import-text" rows={8} value={text} disabled={busy || reading} onChange={(e) => setText(e.target.value)} aria-invalid={tooLong} aria-describedby="voice-guide-count" />
          <p id="voice-guide-count" className={`vc-count ${tooLong ? "over" : ""}`} data-testid="voice-import-count">
            {n} of 7,000 characters
          </p>
          {tooLong && (
            <p className="vc-err" role="alert" data-testid="voice-import-toolong">
              This is too long. Trim it to 7,000 characters, then save.
            </p>
          )}
          {error && (
            <p className="vc-err" role="alert" data-testid="voice-import-error">
              {error}
            </p>
          )}
          <input ref={input} type="file" accept=".md,.txt,text/markdown,text/plain" data-testid="voice-import-file" aria-label="Choose a .md or .txt file" disabled={busy} onChange={(e) => load(e.target.files?.[0])} />
          <label className="vc-check">
            <input type="checkbox" checked={on} disabled={busy} data-testid="voice-import-send" onChange={(e) => setOn(e.target.checked)} />
            <span>Send my guide with every request</span>
          </label>
          {short && (
            <p className="vc-hint" data-testid="voice-import-short">
              {keepsShort ? 'Only the "In short" section is sent with every request.' : 'This text has no "In short" section, so the whole guide will be sent.'}
            </p>
          )}
          <div className="dialog-actions">
            <button type="button" className="btn primary" data-testid="voice-import-save" disabled={busy || reading || tooLong || n === 0} onClick={() => send({ text: text.trim(), on, send: keepsShort ? "short" : "full" }, on ? "Saved. Your guide goes to the agent with every request." : "Saved.")}>
              Save guide
            </button>
            {stored.text && (
              <button type="button" className="btn" data-testid="voice-import-remove" disabled={busy || reading} onClick={() => send({ text: "", on: false }, "")}>
                Remove guide
              </button>
            )}
            <button type="button" className="btn" data-testid="voice-import-cancel" onClick={close}>
              Cancel
            </button>
          </div>
        </VoiceDialog>
      )}
    </>
  );
}
