import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import { api, loadLaunchToken } from "./lib.js";
import "./lens.js";
import "./tokens.css";
import "./engine.css";
import "./shell.css";
import "./backgrounds.css";

// 1. the launch nonce has already been exchanged for the cookie by the server: strip it from the URL right away
const params = new URLSearchParams(location.search);
const key = params.get("s") || "";
history.replaceState(null, "", `/?s=${encodeURIComponent(key)}`);

async function boot() {
  const root = createRoot(document.getElementById("root"));
  try {
    const have = loadLaunchToken(key);
    const res = await fetch(`/api/bootstrap?s=${encodeURIComponent(key)}`, { credentials: "same-origin", headers: { "x-onionskin-token": have } });
    if (res.status === 401 || res.status === 403) {
      const j = await res.json().catch(() => ({}));
      if (j.code === "token_required" || res.status === 401) {
        root.render(
          <p className="fatal" data-testid="reopen">
            Reopen from your terminal. This page has no launch token (it is a new tab, or the browser cleared its storage), so it cannot read the document. Run <code>onionskin open &lt;file&gt;</code> to get a fresh link.
          </p>
        );
        return;
      }
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { session, product, settings, suggest } = await res.json();
    document.title = `${session.name} - ${product}`;
    root.render(<App sid={key} initial={session} product={product} settings={settings} suggest={suggest} />);
  } catch (err) {
    root.render(<p className="fatal">Could not open this session ({String(err.message)}). Run <code>onionskin open &lt;file&gt;</code> again.</p>);
  }
}
boot();
export { api };
