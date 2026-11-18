// The test page for web/src/HtmlViewer.jsx (e2e only, never in the app bundle): it mounts the component with a render copy made by the
// real render worker (serve.mjs) and records what the handle reports in window.__ev, so a browser test can drive and read it.
// ?f=<page name>&mode=edit|comment|pin&theme=light|dark
import React, { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import "../../../web/src/tokens.css";
import "../../../web/src/shell.css";
import { HtmlViewer } from "../../../web/src/HtmlViewer.jsx";

const q = new URLSearchParams(location.search);
document.documentElement.dataset.theme = q.get("theme") || "light";
const ev = (window.__ev = { sel: [], picks: [], blocked: [], edits: [], editEvents: [], lost: [], views: 0, marks: [], hosts: 0, plainAsked: [] });

async function fetchView(name, plain = false) {
  const meta = await (await fetch(`/meta?f=${encodeURIComponent(name)}${plain ? "&plain=1" : ""}`)).json();
  const copy = new Uint8Array(await (await fetch(`/copy?f=${encodeURIComponent(name)}${plain ? "&plain=1" : ""}`)).arrayBuffer());
  return { ...meta, copy, name };
}

function Demo() {
  const [v, setV] = useState(null);
  const [mode, setMode] = useState(q.get("mode") || "edit");
  const [marks, setMarks] = useState([]);
  const [readOnly, setReadOnly] = useState(false);
  const offs = useRef([]);
  // rendered at once, as a click on the app's own buttons is, so the next input in a test meets the new state
  window.__setMode = (m) => flushSync(() => setMode(m));
  window.__setMarks = (m) => flushSync(() => setMarks(m));
  window.__setReadOnly = (r) => flushSync(() => setReadOnly(r));
  // ?plain=<reason>: open the plain copy with that reason, as the app does when the render worker answers `plain`
  window.__load = async (name, plain = null) => setV({ ...(await fetchView(name, !!plain)), ...(plain ? { plain } : {}) });
  useEffect(() => {
    window.__load(q.get("f"), q.get("plain"));
  }, []);
  const onHost = (h) => {
    offs.current.forEach((off) => off());
    offs.current = [];
    window.__h = h;
    if (!h) return;
    ev.hosts++;
    offs.current.push(
      h.onSelectionChange((s) => ev.sel.push(s)),
      h.onPick((p) => ev.picks.push(p)),
      h.onBlocked((b) => ev.blocked.push(b)),
      h.onEditsChange((l) => ev.edits.push(l)),
      h.onEdit((e) => ev.editEvents.push(e)),
      h.onEditsLost((r) => ev.lost.push(r)),
      h.onViewChange(() => ev.views++),
      h.onMarkClick((id) => ev.marks.push(id))
    );
  };
  // "crash": the plain copy; null: the full view again
  const onPlain = async (reason) => {
    ev.plainAsked.push(reason);
    const p = await fetchView(v?.name || q.get("f"), !!reason);
    setV({ ...p, plain: reason });
  };
  if (!v) return <p>Loading</p>;
  return (
    <div style={{ height: "100vh", padding: 16, boxSizing: "border-box", display: "flex", flexDirection: "column", background: "var(--bg)" }}>
      <HtmlViewer copy={v.copy} texts={v.texts} stats={v.stats} plain={v.plain} version={v.version} editable={v.editable} ident={v.ident} mode={mode} marks={marks} readOnly={readOnly} onHost={onHost} onPlain={q.get("noplain") ? undefined : onPlain} />
    </div>
  );
}

createRoot(document.getElementById("root")).render(<Demo />);
