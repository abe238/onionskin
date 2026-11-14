// Pure helpers for the History section (no React, no DOM): turn what GET /api/history sends into what the panel draws.
// Red and green exist only in the panel: nothing here, and nothing the panel does, writes text, color or marks into the document.

/** Row title and badge per update kind. `mark` is one character: the badge is decorative, the title is the accessible name. */
export const KIND = {
  agent: { title: "Agent run", mark: "A" },
  user: { title: "Your edits", mark: "Y" },
  outside: { title: "Changed outside", mark: "!" },
  revert: { title: "Reverted agent run", mark: "↺" },
  local: { title: "Change made on this Mac", mark: "M" },
};
export const kindOf = (k) => KIND[k] || { title: "Update", mark: "·" };
/** The row's title: a revert of a change made on this Mac says so (the server's title; no agent was involved), every other row uses its kind's. */
export const rowTitle = (u) => (u?.kind === "revert" && u.title === "Reverted change made on this Mac" ? u.title : kindOf(u?.kind).title);

/** "3 places", "1 place", "" when nothing changed (the row then shows no count). */
export function countText(counts) {
  const n = counts ? counts.changed + counts.added + counts.removed : 0;
  return n > 0 ? `${n} place${n > 1 ? "s" : ""}` : "";
}

/** Today: HH:MM (24 h, no seconds). Another day of this year: "Nov 8". Another year: "Nov 8, 2025". Empty for a bad date. */
export function timeText(iso, now = new Date()) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const same = d.toDateString() === now.toDateString();
  if (same) return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const md = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return d.getFullYear() === now.getFullYear() ? md : `${md}, ${d.getFullYear()}`;
}

/**
 * Diff ops ([["=", text], ["-", text], ["+", text], ["…"]]) -> render nodes [{t: "eq" | "del" | "ins" | "gap", text}].
 * Empty texts are dropped, unknown ops are ignored. The caller draws "del" as <del>, "ins" as <ins>, "gap" as an ellipsis.
 */
export function diffNodes(ops) {
  const out = [];
  for (const op of Array.isArray(ops) ? ops : []) {
    if (!Array.isArray(op)) continue;
    if (op[0] === "…") out.push({ t: "gap", text: "…" });
    else if (typeof op[1] === "string" && op[1]) {
      const t = op[0] === "=" ? "eq" : op[0] === "-" ? "del" : op[0] === "+" ? "ins" : null;
      if (t) out.push({ t, text: op[1] });
    }
  }
  return out;
}

/** The plain muted line for a place that has no word diff ("Added paragraph", "Removed", "Moved", "Formatting changed: bold", "An image was added"). */
export function placeLine(p) {
  if (p.too_large) return "Too long to compare here";
  if (p.change === "added") return p.note ? sentence(p.note) : p.format === "docx" ? "Added paragraph" : "Added";
  if (p.change === "removed") return p.note ? sentence(p.note) : p.format === "docx" ? "Removed paragraph" : "Removed";
  if (p.change === "moved") return p.note && /^slide moved/.test(p.note) ? sentence(p.note) : "Moved";
  if (p.change === "formatting") return p.note && p.note !== "spacing changed" ? `Formatting changed: ${p.note}` : "Formatting changed";
  return p.note ? sentence(p.note) : "Changed";
}
const sentence = (s) => String(s).replace(/^./, (c) => c.toUpperCase());

/** What to draw for one place: {kind: "diff", nodes} for a text change, {kind: "cell", before, after} for a spreadsheet cell with stored values, else {kind: "note", line}. */
export function placeView(p) {
  if (p.change === "modified" && Array.isArray(p.diff) && p.diff.length) return { kind: "diff", nodes: diffNodes(p.diff), truncated: !!p.truncated };
  if (p.change === "modified" && p.before && p.after) return { kind: "cell", before: cellText(p.before), after: cellText(p.after) };
  return { kind: "note", line: placeLine(p) };
}

/** A cell as {text, formula}: the stored value, and the formula (`=SUM(B2:B3)`, or "") so the panel can set it in monospace. */
export function cellText(c) {
  if (!c) return { text: "", formula: "" };
  return { text: c.value == null ? "" : String(c.value), formula: c.formula ? `=${c.formula}` : "" };
}

/** Places shown before "Show N more". */
export const PLACES_FIRST = 8;

// ---- the "What changed" note: plain text for pasting into an email ----------------------------------------------------------------
// Everything here is document text (untrusted). The note is returned as a plain string and drawn as a textarea value, never as HTML.

export const NOTE_PLACES = 10;
export const NOTE_CHARS = 2000;
const FIELD_CHARS = 200;
// built from escaped strings so no raw control characters live in this source file: C0, DEL, C1, bidi controls, zero-width and BOM
const NOISE = new RegExp("[\\u0000-\\u001F\\u007F-\\u009F\\u061C\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF]+", "g");
/** One line of plain characters, cut at `max` with an ellipsis. The server already cleaned the text; this keeps the note safe on its own. */
const flat = (v, max = FIELD_CHARS) => {
  const cps = [...String(v ?? "").replace(NOISE, " ").replace(/ {2,}/g, " ").trim()];
  return cps.length > max ? `${cps.slice(0, max - 1).join("")}…` : cps.join("");
};

/** A spreadsheet label `Sales!D30` or `Sales!D30:F30` -> "Sales, cell D30" / "Sales, cells D30:F30"; every other label is kept as it is. */
export function plainLabel(place) {
  const label = String(place?.label ?? "");
  const m = place?.format === "xlsx" && /^(.*)!([A-Z]{1,3}\d+)(:[A-Z]{1,3}\d+)?$/.exec(label);
  return flat(m ? `${m[1]}, ${m[3] ? "cells" : "cell"} ${m[2]}${m[3] || ""}` : label, 140);
}

/** Was and Now from diff ops: Was keeps "=" and "-", Now keeps "=" and "+"; a gap is an ellipsis. */
export function wasNow(ops) {
  let was = "";
  let now = "";
  for (const op of Array.isArray(ops) ? ops : []) {
    if (!Array.isArray(op)) continue;
    if (op[0] === "…") (was += "…", (now += "…"));
    else if (typeof op[1] === "string") {
      if (op[0] === "=" || op[0] === "-") was += op[1];
      if (op[0] === "=" || op[0] === "+") now += op[1];
    }
  }
  return { was: flat(was), now: flat(now) };
}

const cellValue = (c) => flat(c.formula || c.text || "(empty)");

/** The lines under one place's heading. */
function placeLines(p) {
  const v = placeView(p);
  if (v.kind === "diff") {
    const { was, now } = wasNow(p.diff);
    return [`Was: ${was}`, `Now: ${now}`];
  }
  if (v.kind === "cell") return [`Was: ${cellValue(v.before)}`, `Now: ${cellValue(v.after)}`];
  const lines = [flat(v.line)];
  if (p.change === "added" && p.text) lines.push(`Now: ${flat(p.text)}`);
  if (p.change === "removed" && p.text) lines.push(`Was: ${flat(p.text)}`);
  return lines;
}

/** "Nov 11, 09:05" (24 h), empty for a bad date. */
function sinceText(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const md = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${md}, ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * The note for GET /api/history/all: "" when there is nothing to say (nothing changed, or the versions could not be compared).
 * At most NOTE_PLACES places and NOTE_CHARS characters; what is left out is one closing line, "and N more places."
 */
export function changeNote(detail, fileName) {
  const places = Array.isArray(detail?.places) ? detail.places : [];
  if (!places.length || detail.unavailable) return "";
  const when = sinceText(detail.since?.at);
  const title = `What changed in ${flat(fileName, 80) || "this file"}${when ? ` since ${when}` : ""}`;
  const total = places.length + (Number(detail.more) > 0 ? Number(detail.more) : 0);
  const moreLine = (n) => `and ${n} more place${n > 1 ? "s" : ""}.`;
  const blocks = [];
  let used = title.length;
  for (let i = 0; i < Math.min(places.length, NOTE_PLACES); i++) {
    const block = [`${i + 1}. ${plainLabel(places[i])}`, ...placeLines(places[i]).map((l) => `   ${l}`)].join("\n");
    if (blocks.length && used + block.length + 2 + moreLine(total).length + 2 > NOTE_CHARS) break;
    blocks.push(block);
    used += block.length + 1;
  }
  const left = total - blocks.length;
  return `${title}\n\n${blocks.join("\n")}${left > 0 ? `\n\n${moreLine(left)}` : ""}`;
}
