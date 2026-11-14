import React from "react";
import { createRoot } from "react-dom/client";
import { recording, v0, v1 } from "virtual:onionskin-demo-recording";
import { Demo } from "./Demo.jsx";
import "../src/tokens.css";
import "../src/engine.css";
import "./demo.css";

// A visitor's file can never be loaded. Before anything else mounts, in the capture phase so the engine never sees them:
//   - a dragged or dropped file is stopped (and the browser does not open it in place of the page);
//   - a paste is stopped (the page has no field to paste into, and the document is read-only);
//   - any file picker that appears is removed before it can be clicked.
// The page also never reads its own address: a ?src= or #... does nothing.
const stop = (e) => {
  e.preventDefault();
  e.stopImmediatePropagation();
};
for (const type of ["dragenter", "dragover", "drop", "paste"]) window.addEventListener(type, stop, { capture: true });
const noPickers = (root) => root.querySelectorAll?.('input[type="file" i]').forEach((el) => el.remove());
new MutationObserver((list) => list.forEach((m) => m.addedNodes.forEach((n) => (n.matches?.('input[type="file" i]') ? n.remove() : noPickers(n))))).observe(document.documentElement, { childList: true, subtree: true });

// The page has no theme switch: it follows the system setting (the tokens and the engine read data-theme, not the media query).
const dark = window.matchMedia("(prefers-color-scheme: dark)");
const theme = () => (document.documentElement.dataset.theme = dark.matches ? "dark" : "light");
theme();
dark.addEventListener("change", theme);

createRoot(document.getElementById("root")).render(<Demo recording={recording} v0={v0} v1={v1} />);
