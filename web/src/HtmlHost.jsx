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
export function HtmlHost({ view, mode, marks, hoverId, onHover, locked, edits, onHost, onWant }) {
  if (view.error) {
    const e = view.error;
    return (
      <div className="hv-full hh-refused" role="alert" data-testid="html-refused" data-code={e.code || ""}>
        <Icon name="alert" size={20} />
        <p>{e.message}</p>
      </div>
    );
  }
  const plain = view.forced ? "crash" : view.plain ? view.reason : null;
  return (
    <div className="hh" data-testid="html-host">
      {edits > 0 && !locked && (
        <div className="hh-bar" role="status" data-testid="html-edits-bar">
          <span>{edits === 1 ? "1 unsent text edit" : `${edits} unsent text edits`}: Send takes them with your comments.</span>
        </div>
      )}
      <HtmlViewer copy={view.copy} texts={view.texts} stats={view.stats} plain={plain} version={view.version} editable={view.editable} ident={view.ident} mode={mode} marks={marks} hoverId={hoverId} onHover={onHover} readOnly={!!locked} onHost={onHost} onPlain={(why) => onWant(why === "crash")} />
    </div>
  );
}
