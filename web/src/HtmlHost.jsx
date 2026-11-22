import React from "react";
import { HtmlViewer } from "./HtmlViewer.jsx";
import { Icon } from "./Icons.jsx";

/**
 * An HTML file in the page (PLAN-html Phase 2a): the view App.jsx loaded (src/html-envelope.js, web/src/html-host.js fetchHtmlView) in
 * HtmlViewer, a line while the person has pending text edits (R9, Send takes them), and the refusal of a page that is not UTF-8 any
 * more (R10, its sentence). App.jsx keeps the handle, the comments and the Send; this only lays the view out.
 *
 * Props: view ({version, plain, reason, stats, texts, editable, ident, copy, forced} or {error}), mode, marks, locked (a run: D5), edits (how
 * many pending text edits), onHost, onWant(plain: boolean) (the plain copy after a crash, or the full view again).
 */
export function HtmlHost({ view, mode, marks, hoverId, onHover, locked, edits, onHost, onWant, onKeptDone }) {
  // text edits that were not sent when a reload was refused (App.jsx keeps them): shown until the person says Done
  const kept = view.kept?.length > 0 && (
    <div className="hv-lost" role="alert" data-testid="html-kept">
      <p>
        <strong>{view.kept.length === 1 ? "1 text edit was not sent" : `${view.kept.length} text edits were not sent`}.</strong> The file changed and could not be read, so they are kept here for you to copy.
      </p>
      <ul>
        {view.kept.map((t, i) => (
          <li key={i} data-testid="html-kept-edit">
            <span className="hv-lost-text">{t}</span>
            <button type="button" className="btn sm" data-testid="html-kept-copy" onClick={() => navigator.clipboard?.writeText(t).catch(() => {})}>
              Copy
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="btn" data-testid="html-kept-done" onClick={onKeptDone}>
        Done
      </button>
    </div>
  );
  if (view.error) {
    const e = view.error;
    return (
      <div className="hv-full hh-refused" role="alert" data-testid="html-refused" data-code={e.code || ""}>
        <Icon name="alert" size={20} />
        <p>{e.message}</p>
        {kept}
      </div>
    );
  }
  const plain = view.forced ? "crash" : view.plain ? view.reason : null;
  return (
    <div className="hh" data-testid="html-host">
      {kept}
      {edits > 0 && !locked && (
        <div className="hh-bar" role="status" data-testid="html-edits-bar">
          <span>{edits === 1 ? "1 unsent text edit" : `${edits} unsent text edits`}: Send takes them with your comments.</span>
        </div>
      )}
      <HtmlViewer copy={view.copy} texts={view.texts} stats={view.stats} plain={plain} version={view.version} editable={view.editable} ident={view.ident} mode={mode} marks={marks} hoverId={hoverId} onHover={onHover} readOnly={!!locked} onHost={onHost} onPlain={(why) => onWant(why === "crash")} />
    </div>
  );
}
