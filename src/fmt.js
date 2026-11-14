// Formatting signatures for History. A paragraph (DOCX) or shape (PPTX) is reduced to one value per property over its text runs, so how a
// writer splits a paragraph into runs does not matter: "all runs bold" is the same signature however many runs there are. Two signatures
// are compared by property and reported in plain words. Pure functions; nothing here reads or writes a document.

/** run property key -> the word used in a note */
export const FMT_WORDS = { b: "bold", i: "italic", u: "underline", strike: "strikethrough", color: "color", size: "size", font: "font", hl: "highlight", rs: "character style" };
const NOTE_CAP = 4; // properties named in one note; the rest is "and more"

/** [{b:"1", color:"FF0000", ...}] (one object per text run, "" or missing = not set) -> {b: "1" | "" | "~1,", ...}; a mixed property is "~" plus its sorted values */
export function summarizeRuns(runs) {
  const seen = {};
  for (const run of runs) for (const k of Object.keys(FMT_WORDS)) (seen[k] ||= new Set()).add(run[k] || "");
  if (!runs.length) return {};
  const out = {};
  for (const [k, set] of Object.entries(seen)) {
    const v = [...set].sort();
    if (v.length === 1 ? v[0] : true) out[k] = v.length === 1 ? v[0] : `~${v.join(",")}`;
  }
  return out;
}

/** Plain words for what differs between two signatures: "bold, color", "style: Heading 2 → Heading 1, alignment"; null when nothing differs. `a` and `b` are {props, style, styleName, align}. */
export function fmtNote(a, b) {
  const notes = [];
  if ((a.style || "") !== (b.style || "")) notes.push(`style: ${a.styleName || a.style || "Normal"} → ${b.styleName || b.style || "Normal"}`);
  if ((a.align || "") !== (b.align || "")) notes.push("alignment");
  for (const [k, word] of Object.entries(FMT_WORDS)) if ((a.props?.[k] || "") !== (b.props?.[k] || "")) notes.push(word);
  if (!notes.length) return null;
  return notes.slice(0, NOTE_CAP).join(", ") + (notes.length > NOTE_CAP ? ", and more" : "");
}
