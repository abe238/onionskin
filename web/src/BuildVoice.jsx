import React, { useRef, useState } from "react";
import { api, blobToBase64 } from "./lib.js";
import { VoiceDialog } from "./VoiceDialog.jsx";

const keep = (e) => e.preventDefault();
const FILE_MAX = 20 * 1024 * 1024;
const PASTE_MAX = 20_000;
const ADDED_MAX = 5;
const FORMATS = { docx: "docx", pptx: "pptx", txt: "text", md: "text" };
const NO_SAMPLE = "Choose at least one sample of your writing.";
const UNREADABLE = "That file could not be read. Choose a Word, PowerPoint or text file.";
// the server's own plain messages for this request; anything else is shown as a general failure
const KNOWN = [NO_SAMPLE, UNREADABLE, "Each file can be up to 20 MB.", "You can add up to 5 in all.", "Pasted text can be up to 20,000 characters.", "Wait for the agent to finish, then try again.", "Excel files are not used as writing samples.", "HTML pages are not used as writing samples.", "Another voice guide is being built right now. Wait a moment, then try again."];
const chars = (s) => [...s].length;

/**
 * "Build my voice guide": the request. The person ticks what the agent may read, adds files (read here in the browser; the server never
 * sees a path) or pastes text, and presses "Ask the agent". Nothing leaves the Mac until then, and what is sent is only what is ticked or
 * added. `examples` is how many of their rewrites are kept; `saved` whether a guide is saved. Calls `onSent` once the request is accepted.
 */
export function BuildVoice({ sid, session, examples, saved, onClose, onSent }) {
  const xlsx = session.format === "xlsx";
  const html = session.format === "html"; // PLAN-html D9: an HTML page is never a writing sample, and the choice is not shown
  const [openFile, setOpenFile] = useState(false);
  const [edits, setEdits] = useState(false);
  const [comments, setComments] = useState(true);
  const [improve, setImprove] = useState(saved);
  const [files, setFiles] = useState([]); // {name, format, bytesB64}
  const [paste, setPaste] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef(null);
  const [reading, setReading] = useState(false);
  const hasPaste = paste.trim().length > 0;
  const count = files.length + (hasPaste ? 1 : 0);
  const pasteOver = chars(paste) > PASTE_MAX;

  async function add(list) {
    setError("");
    if (count + list.length > ADDED_MAX) return setError("You can add up to 5 in all.");
    setReading(true);
    try {
      const added = [];
      for (const f of list) {
        const format = FORMATS[(f.name.split(".").pop() || "").toLowerCase()];
        if (!format) return setError(UNREADABLE);
        if (f.size > FILE_MAX) return setError("Each file can be up to 20 MB.");
        added.push({ name: f.name, format, bytesB64: await blobToBase64(f) });
      }
      setFiles((current) => [...current, ...added]);
    } catch {
      setError(UNREADABLE);
    } finally {
      setReading(false);
      if (input.current) input.current.value = ""; // the same file can be chosen again
    }
  }

  async function ask() {
    setError("");
    if (!openFile && !files.length && !hasPaste && !(edits && examples > 0)) return setError(NO_SAMPLE);
    if (pasteOver) return setError("Pasted text can be up to 20,000 characters.");
    setBusy(true);
    try {
      await api(`/api/voice/build?s=${sid}`, {
        method: "POST",
        body: { open_file: openFile && !xlsx && !html, edits: edits && examples > 0, comments, improve: improve && saved, texts: hasPaste ? [paste] : [], files: files.map((f) => ({ format: f.format, bytesB64: f.bytesB64 })) },
      });
      onSent();
    } catch (e) {
      setError(KNOWN.includes(e.message) ? e.message : "Could not send that. Try again.");
      setBusy(false);
    }
  }

  return (
    <VoiceDialog title="Build my voice guide" testid="voice-build" onClose={onClose}>
      <p>The agent reads samples of your writing and drafts a guide to how you write. You read and edit every word before anything is saved.</p>
      <div className="vb-body">
        {!html && <div className="vb-group">
          <label className="vc-check">
            <input type="checkbox" checked={openFile && !xlsx} disabled={xlsx || busy} data-testid="voice-build-open-file" onChange={(e) => setOpenFile(e.target.checked)} />
            <span>This file is my own writing</span>
          </label>
          <p className="vc-hint" data-testid="voice-build-open-help">
            {xlsx ? "Excel files are not used as writing samples." : "Only tick this if you wrote it. Text the agent added here is left out. Uses the last saved version of this file."}
          </p>
        </div>}
        <div className="vb-group">
          <h3 className="vb-h">Add more of my writing</h3>
          <div className="vb-row">
            <button type="button" className="btn sm" data-testid="voice-build-choose" disabled={busy || reading || count >= ADDED_MAX} onMouseDown={keep} onClick={() => input.current?.click()}>
              Choose files
            </button>
            <span className="vc-hint">Word, PowerPoint or text files. Up to 5 in all.</span>
          </div>
          <input ref={input} type="file" multiple hidden disabled={busy || reading} accept=".docx,.pptx,.txt,.md" data-testid="voice-build-file-input" aria-label="Choose files" onChange={(e) => add([...(e.target.files || [])])} />
          {files.length > 0 && (
            <ul className="vc-list" data-testid="voice-build-files">
              {files.map((f, i) => (
                <li key={`${f.name}-${i}`} className="vb-file" data-testid={`voice-build-file-${i}`}>
                  <span className="vb-name">{f.name}</span>
                  <button type="button" className="btn quiet sm" data-testid={`voice-build-remove-${i}`} aria-label={`Remove ${f.name}`} disabled={busy} onMouseDown={keep} onClick={() => setFiles((current) => current.filter((_, k) => k !== i))}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          <label htmlFor="voice-build-paste">Paste some of my writing</label>
          <textarea id="voice-build-paste" className="vc-text" data-testid="voice-build-text" rows={4} value={paste} disabled={busy} aria-invalid={pasteOver} onChange={(e) => setPaste(e.target.value)} />
          {pasteOver && (
            <p className="vc-err" role="alert">
              Pasted text can be up to 20,000 characters.
            </p>
          )}
        </div>
        <div className="vb-group">
          <label className="vc-check">
            <input type="checkbox" checked={edits && examples > 0} disabled={examples === 0 || busy} data-testid="voice-build-edits" onChange={(e) => setEdits(e.target.checked)} />
            <span>{examples > 0 ? `Use the changes I made to the agent's text (${examples} kept)` : "No changes kept yet"}</span>
          </label>
          <label className="vc-check">
            <input type="checkbox" checked={comments} disabled={busy} data-testid="voice-build-comments" onChange={(e) => setComments(e.target.checked)} />
            <span>Use the comments I typed in this file</span>
          </label>
          {saved && (
            <label className="vc-check">
              <input type="checkbox" checked={improve} disabled={busy} data-testid="voice-build-improve" onChange={(e) => setImprove(e.target.checked)} />
              <span>Improve my saved guide instead of starting over</span>
            </label>
          )}
        </div>
        <p className="vc-hint" data-testid="voice-build-privacy">
          Your agent's AI service reads this writing, as it reads any request.
        </p>
      </div>
      {error && (
        <p className="vc-err" role="alert" data-testid="voice-build-error">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button type="button" className="btn primary" data-testid="voice-build-ask" disabled={busy || reading} onClick={ask}>
          Ask the agent
        </button>
        <button type="button" className="btn" data-testid="voice-build-cancel" onClick={onClose}>
          Cancel
        </button>
      </div>
    </VoiceDialog>
  );
}
