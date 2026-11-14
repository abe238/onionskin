// Keyboard facts shared by the app: which platform's names to show, which keys are taken, and the list the shortcuts popover draws.
// Taken by the engine (vendor/engine, checked 2026-11-10): Cmd/Ctrl+K inserts a link and Cmd/Ctrl+Enter inserts a page break in Word
// documents, Enter (with or without a modifier) commits a spreadsheet cell, so Quick ask uses Cmd/Ctrl+Shift+K and the document is left alone for Cmd/Ctrl+Enter.

export const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD = IS_MAC ? "Cmd" : "Ctrl";

/** True when typing here types text: a text box, a select, or a contenteditable surface. */
export function isEditable(el) {
  if (!el || el.nodeType !== 1) return false;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || !!el.isContentEditable || !!el.closest?.('[contenteditable="true"]');
}

/** Quick ask: Cmd+Shift+K (Mac), Ctrl+Shift+K (Windows, Linux). */
export const isQuickAsk = (e) => (e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.code === "KeyK";

/**
 * Next / previous comment box in the review panel. Option+Up/Down moves the caret by paragraph in a Mac text box, so Mac uses Cmd+Option;
 * on Windows and Linux plain Alt+Up/Down is free in a text box. Returns 1, -1, or 0.
 */
export function commentNavDir(e) {
  if (e.code !== "ArrowDown" && e.code !== "ArrowUp") return 0;
  const ok = IS_MAC ? e.metaKey && e.altKey && !e.ctrlKey : e.altKey && !e.ctrlKey && !e.metaKey;
  return ok && !e.shiftKey ? (e.code === "ArrowDown" ? 1 : -1) : 0;
}

const G = IS_MAC ? { mod: "⌘", shift: "⇧", alt: "⌥", enter: "↵", down: "↓", up: "↑", join: "" } : { mod: "Ctrl", shift: "Shift", alt: "Alt", enter: "Enter", down: "Down", up: "Up", join: "+" };
const combo = (...parts) => parts.map((p) => G[p] ?? p).join(G.join);

/** What the popover lists: [group, [[what it does, keys], ...]]. The keys are written for this platform. */
export const SHORTCUTS = [
  [
    "Ask and send",
    [
      ["Quick ask on the selection or caret", combo("mod", "shift", "K")],
      ["Send the batch (from a comment box or outside the document)", combo("mod", "enter")],
      ["Comment on the selection", combo("mod", "alt", "M")],
    ],
  ],
  [
    "Review panel",
    [
      ["Next comment box", IS_MAC ? combo("mod", "alt", "down") : combo("alt", "down")],
      ["Previous comment box", IS_MAC ? combo("mod", "alt", "up") : combo("alt", "up")],
      ["Back to the document at that comment", "Esc"],
      ["Show or hide the panel", combo("mod", "\\")],
    ],
  ],
  [
    "Anywhere",
    [
      ["Move between the bar, tools, document and panel", "F6"],
      ["Show these shortcuts", "?"],
    ],
  ],
];
