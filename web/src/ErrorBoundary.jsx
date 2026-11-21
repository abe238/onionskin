import React from "react";

let rescueSnapshot = { comments: [], note: "", hasEdits: false };

/** Lightweight in-memory snapshot of unsent comments, overall note, and unsent edits so ErrorBoundary can let the user copy them and guard reload after App unmounts. */
export function setRescueSnapshot(comments, note, hasEdits = false) {
  rescueSnapshot = {
    comments: Array.isArray(comments) ? comments : [],
    note: typeof note === "string" ? note : "",
    hasEdits: !!hasEdits,
  };
}

function formatRescueText() {
  const lines = [];
  const drafts = rescueSnapshot.comments.filter((c) => c && c.status === "draft" && (c.text || "").trim());
  for (let i = 0; i < drafts.length; i++) {
    const c = drafts[i];
    const kind = c.kind === "pin" ? "Pin" : "Comment";
    const quote = (c.anchor?.quote || "").replace(/\s+/g, " ").trim();
    lines.push(`${kind} ${i + 1}${quote ? ` ("${quote.slice(0, 80)}")` : ""}: ${c.text.trim()}`);
  }
  const note = rescueSnapshot.note.trim();
  if (note) lines.push(`Overall instructions: ${note}`);
  return lines.join("\n\n");
}

/** Top-level error boundary so an unexpected render failure shows a recovery option instead of a blank page. */
export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, copied: false, copyError: false };
    this.boxRef = React.createRef();
    this.guardBound = false;
  }

  static getDerivedStateFromError(error) {
    return { error: error || new Error("Unexpected error") };
  }

  componentDidCatch(error, info) {
    console.error(error, info);
  }

  componentDidMount() {
    if (this.state.error) this.activateCrashState();
  }

  componentDidUpdate(_, prevState) {
    if (this.state.error && !prevState.error) this.activateCrashState();
    else if (!this.state.error && prevState.error) this.clearGuard();
  }

  componentWillUnmount() {
    this.clearGuard();
  }

  onBeforeUnload = (e) => {
    if (!this.state.error) return;
    if (!formatRescueText() && !rescueSnapshot.hasEdits) return;
    e.preventDefault();
    e.returnValue = "";
  };

  activateCrashState() {
    this.boxRef.current?.focus();
    if (!this.guardBound) {
      window.addEventListener("beforeunload", this.onBeforeUnload);
      this.guardBound = true;
    }
  }

  clearGuard() {
    if (this.guardBound) {
      window.removeEventListener("beforeunload", this.onBeforeUnload);
      this.guardBound = false;
    }
  }

  copyUnsent = () => {
    const text = formatRescueText();
    if (!text) return;
    if (!navigator.clipboard?.writeText) {
      this.setState({ copied: false, copyError: true });
      return;
    }
    navigator.clipboard.writeText(text).then(
      () => this.setState({ copied: true, copyError: false }),
      () => this.setState({ copied: false, copyError: true })
    );
  };

  render() {
    if (this.state.error) {
      const unsentText = formatRescueText();
      return (
        <div ref={this.boxRef} tabIndex={-1} className="fatal" role="alert" data-testid="error-boundary" style={{ display: "grid", gap: "12px", justifyItems: "start", outline: "none" }}>
          <h2>Something went wrong</h2>
          <p>The page ran into an unexpected problem. Reloading opens the last saved version; unsent edits on this page will be lost.</p>
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            <button type="button" className="btn primary" onClick={() => window.location.reload()}>
              Reload page
            </button>
            {unsentText && (
              <button type="button" className="btn" data-testid="error-copy-comments" onClick={this.copyUnsent}>
                {this.state.copied ? "Copied unsent comments" : "Copy unsent comments"}
              </button>
            )}
          </div>
          {this.state.copyError && (
            <>
              <p role="status" data-testid="error-copy-failed">Could not copy. Select and copy manually.</p>
              <textarea aria-label="Unsent comments" rows={5} readOnly value={unsentText} />
            </>
          )}
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
