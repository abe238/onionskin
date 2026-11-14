import React, { useEffect, useRef, useState } from "react";
import { Icon } from "./Icons.jsx";
import { useMedia } from "./hooks.js";
import { Shortcuts } from "./Shortcuts.jsx";

const STATE_TEXT = {
  idle: "Idle",
  listening: "Agent listening",
  working: "Agent working",
  queued: "Agent working, batch queued",
  stranded: "No agent listening",
  closed: "Closed",
};
const STATE_TEXT_MAC = { working: "Working on this Mac", queued: "Working on this Mac, batch queued" }; // a run done on this Mac (session.stage "local"): no agent in it
const STATE_SHORT = { idle: "Idle", listening: "Listening", working: "Working", queued: "Working", stranded: "No agent", closed: "Closed" };

function syncText(session, counts, sending, readOnly) {
  if (readOnly) return { text: "Read-only: open for editing in another tab", tone: "muted", icon: "lock" };
  if (session.state === "closed") return { text: "Session closed", tone: "muted", icon: "lock" };
  if (sending) return { text: "Sending to the agent", tone: "busy", icon: "sync" };
  if (session.locked) return { text: session.local ? "Working on this Mac: keep editing" : "Agent working: keep editing", tone: "busy", icon: "sync" };
  if (counts.edits) return { text: `${counts.edits} unsent edit${counts.edits > 1 ? "s" : ""}`, tone: "warn", icon: "edit" };
  return { text: "No unsent edits", tone: "ok", icon: "check" };
}

/** The site's mark: two onionskin sheets, one behind the other. */
function Mark() {
  return (
    <span className="mark" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 3.5h6.5L19 7v10.5a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1Z" opacity=".55" />
        <path d="M5.8 6h6.4l3.3 3.3v10.2a1 1 0 0 1-1 1H5.8a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1Z" fill="currentColor" fillOpacity=".12" />
        <path d="M12 6v3.5h3.5M7.5 13h5M7.5 16h3.5" />
      </svg>
    </span>
  );
}

export function TopBar({ readOnly, product, session, counts, pending, sending, theme, onTheme, onBackground, bgOpen, sideOpen, onSidebar, onClose, keysOpen, onKeys }) {
  const compact = useMedia("(max-width: 719px)");
  const [menu, setMenu] = useState(false);
  const menuRef = useRef(null);
  useEffect(() => {
    if (!menu) return;
    const away = (e) => !menuRef.current?.contains(e.target) && setMenu(false);
    const esc = (e) => e.key === "Escape" && setMenu(false);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [menu]);
  const state = session.state;
  const stateText = (session.local && STATE_TEXT_MAC[state]) || STATE_TEXT[state] || state;
  const sync = syncText(session, counts, sending, readOnly);
  const nextTheme = theme === "dark" ? "light" : "dark";
  const themeBtn = (
    <button type="button" className="iconbtn" onClick={onTheme} data-testid="theme-toggle" aria-label={`Switch to ${nextTheme} theme`} title={`Switch to ${nextTheme} theme`}>
      <Icon name={theme === "dark" ? "sun" : "moon"} />
    </button>
  );
  return (
    <header className="topbar glass" data-busy={sending ? "1" : "0"} aria-label={`${product} document bar`}>
      <Mark />
      <span className="brand">{product}</span>
      <span className="fname" data-testid="file-name" title={session.name}>{session.name}</span>
      <span className="badge format" data-testid="format-badge">{session.format.toUpperCase()}</span>
      {!compact && (
        <span className={`sync sync-${sync.tone}`} data-testid="sync-state" role="status">
          <Icon name={sync.icon} size={14} />
          {sync.text}
        </span>
      )}
      <span className="spacer" />
      <span className={`pill pill-${state}`} data-testid="state-pill" role="status" aria-label={`${session.local ? "State" : "Agent state"}: ${stateText}`}>
        {compact ? STATE_SHORT[state] || state : stateText}
      </span>
      {!compact && (
        <span className="menuwrap">
          <button type="button" className={`iconbtn ${keysOpen ? "on" : ""}`} onClick={onKeys} data-testid="shortcuts-button" aria-label="Keyboard shortcuts" aria-haspopup="dialog" aria-expanded={!!keysOpen} title="Keyboard shortcuts (?)">
            <Icon name="keyboard" />
          </button>
          {keysOpen && <Shortcuts onClose={onKeys} />}
        </span>
      )}
      {!compact && (
        <button type="button" className={`iconbtn ${bgOpen ? "on" : ""}`} onClick={onBackground} data-bgopener="1" data-testid="bg-button" aria-label="Background" aria-haspopup="dialog" aria-expanded={!!bgOpen} title="Choose the background">
          <Icon name="image" />
        </button>
      )}
      {!compact && themeBtn}
      {!compact && <span className="togglewrap">
        <button type="button" className={`iconbtn ${sideOpen ? "on" : ""}`} onClick={onSidebar} data-testid="sidebar-toggle" aria-label={`${sideOpen ? "Hide" : "Show"} the review panel${!sideOpen && pending ? `, ${pending} to send` : ""}`} aria-expanded={sideOpen} aria-controls="review-panel" title="Review panel (Ctrl or Cmd + \)">
          <Icon name="panel" />
        </button>
        {!sideOpen && pending > 0 && (
          <span className="pending-dot" aria-hidden="true">
            {pending}
          </span>
        )}
      </span>}
      {compact ? (
        <span className="menuwrap" ref={menuRef}>
          <button type="button" className="iconbtn" onClick={() => setMenu((m) => !m)} aria-label="More actions" aria-haspopup="menu" aria-expanded={menu} data-testid="more-menu">
            <Icon name="more" size={18} />
          </button>
          {menu && (
            <div className="menu glass-pop" role="menu">
              <button type="button" role="menuitem" className="menuitem" onClick={() => (onTheme(), setMenu(false))} data-testid="theme-toggle">
                <Icon name={theme === "dark" ? "sun" : "moon"} /> {theme === "dark" ? "Light theme" : "Dark theme"}
              </button>
              <button type="button" role="menuitem" className="menuitem" onClick={() => (onBackground(), setMenu(false))} data-bgopener="1" data-testid="bg-menu-item">
                <Icon name="image" /> Background
              </button>
              <button type="button" role="menuitem" className="menuitem" onClick={onClose} data-testid="close">
                <Icon name="close" /> Close session
              </button>
            </div>
          )}
        </span>
      ) : (
        <button type="button" className="btn quiet" onClick={onClose} data-testid="close">
          Close session
        </button>
      )}
    </header>
  );
}

const MODES = [
  ["edit", "Edit", "edit", "Type in the document"],
  ["comment", "Comment", "comment", "Click a paragraph, cell or shape to comment on it"],
  ["pin", "Pin", "pin", "Drop a numbered pin anywhere"],
];

function Modes({ mode, onMode, readOnly }) {
  return (
    <div className="modes" role="group" aria-label="Mode">
      {MODES.map(([m, label, icon, hint]) => (
        <button key={m} type="button" className={`mode ${mode === m ? "on" : ""}`} onClick={() => onMode(m)} disabled={readOnly && m !== "edit"} data-testid={`mode-${m}`} aria-pressed={mode === m} title={hint}>
          <Icon name={icon} size={16} />
          <span className="mode-label">{label}</span>
        </button>
      ))}
    </div>
  );
}

/** Desktop and tablet: the mode switch and the format toolbar share one glass bar. Phone: only the format strip (it shows in Edit mode); the modes live in the dock. */
export function Toolbar({ mode, onMode, setBar, readOnly, phone }) {
  return (
    <div className="toolbar glass" data-hidden={phone && mode !== "edit" ? "1" : "0"}>
      {!phone && <Modes mode={mode} onMode={onMode} readOnly={readOnly} />}
      {!phone && <span className="tb-sep" aria-hidden="true" />}
      {readOnly && (
        <span className="locked-note" role="status" data-testid="readonly-note">
          <Icon name="lock" size={14} /> Read-only in this tab
        </span>
      )}
      <div className="editbar" ref={setBar} data-testid="editbar" aria-label="Formatting" hidden={readOnly} />
    </div>
  );
}

/** Phone only: a floating glass dock at the thumb. Edit / Comment / Pin, and the button that opens the review sheet where Send is pinned. Counts are what would be sent. */
export function Dock({ mode, onMode, readOnly, counts, pending, sideOpen, onSidebar, sending }) {
  const parts = counts.comments + counts.pins + counts.edits;
  return (
    <nav className="dock glass" aria-label="Actions">
      <Modes mode={mode} onMode={onMode} readOnly={readOnly} />
      <button type="button" className="send-pill" data-testid="sidebar-toggle" data-empty={pending ? "0" : "1"} onClick={onSidebar} aria-expanded={sideOpen} aria-controls="review-panel" aria-label={`Review and send${pending ? `, ${parts || 1} to send` : ""}`}>
        <span>{sending ? "Sending" : "Send"}</span>
        {pending > 0 && <span className="cnt" aria-hidden="true">{parts || 1}</span>}
      </button>
    </nav>
  );
}
