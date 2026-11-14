import React, { useState } from "react";
import { api } from "./lib.js";
import { CopyButton } from "./Banners.jsx";
import "./tracked-export.css";

// "Save a copy with tracked changes" (M4 Idea 16): one button that asks the server to write a Word copy next to the file, with each change
// marked so it can be accepted or rejected in Word. The file itself is never changed. `id` is an agent run's id, or "all" for every change
// History holds. Every sentence shown here comes from the server, which only ever uses plain words of its own (never document text).

const HINTS = {
  run: "For Word: each change can be accepted or rejected there. Your file stays as it is.",
  all: "Covers every change listed here.",
};
// the one refusal the server words for any route (another tab edits the file); this button says it the way the person needs it here
const NOT_EDITOR = "Save the copy from the tab that holds the file.";

function download({ name, bytesB64 }) {
  const bin = atob(bytesB64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export function TrackedExport({ sid, id }) {
  const [state, setState] = useState({ phase: "idle" }); // idle | busy | done {result} | error {message}
  const run = async () => {
    setState({ phase: "busy" });
    try {
      const r = await api(`/api/export-tracked?s=${sid}`, { method: "POST", body: { id } });
      setState({ phase: "done", result: r });
    } catch (e) {
      setState({ phase: "error", message: e.code === "not_editor" ? NOT_EDITOR : e.error || e.message || "Something went wrong. Nothing was saved." });
    }
  };
  const showInFolder = (p) => api(`/api/show-copy?s=${sid}`, { method: "POST", body: { path: p } }).catch(() => {});
  const r = state.result;
  return (
    <div className="tx" data-testid="tracked-export">
      <button type="button" className="btn sm" data-testid="tracked-export-button" onClick={run} disabled={state.phase === "busy"}>
        Save a copy with tracked changes
      </button>
      {state.phase === "idle" && <p className="h-line tx-hint">{HINTS[id === "all" ? "all" : "run"]}</p>}
      {state.phase === "busy" && (
        <p className="h-line" role="status" data-testid="tracked-export-busy">
          Making the copy and checking it
        </p>
      )}
      {state.phase === "error" && (
        <p className="h-line tx-err" role="alert" data-testid="tracked-export-error">
          {state.message}
        </p>
      )}
      {state.phase === "done" && (
        <div role="status" data-testid="tracked-export-result">
          <p className="h-line tx-ok" data-testid="tracked-export-saved">
            {r.message}
          </p>
          {r.saved && r.can_reveal && (
            <button type="button" className="btn sm" data-testid="tracked-export-show" onClick={() => showInFolder(r.path)}>
              Show in folder
            </button>
          )}
          {r.saved && !r.can_reveal && (
            <span className="copy-path tx-path">
              <code data-testid="tracked-export-path">{r.path}</code> <CopyButton text={r.path || ""} />
            </span>
          )}
          {!r.saved && r.download && (
            <button type="button" className="btn sm" data-testid="tracked-export-download" onClick={() => download(r.download)}>
              Download the copy
            </button>
          )}
          {(r.notes || []).map((n, i) => (
            <p key={i} className="h-line" data-testid="tracked-export-note">
              {n}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
