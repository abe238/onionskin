// The Shield badge: what a finished run shows when the AI reported ignoring orders written in the file.
// Pure. The count is the AI's own report (`document_instructions_ignored`, cleaned by the server), so every sentence says "your AI reported"
// and none says the file is safe. Nothing here ever takes a reported string: only its number, so document words cannot reach the page.

export const SHIELD = {
  heading: "Orders in this file were ignored",
  checked: "Every change it made still went through Onionskin's checks.",
  hidden: "Onionskin does not show that text here.",
  report: "This count comes from your AI's own report, so the real number may be different.",
};

/** Null for any entry that should show nothing (zero reported, a revert, an expired lease). */
export function shieldOf(a) {
  if (!a || a.kind !== "agent") return null;
  const items = Array.isArray(a.documentInstructionsIgnored) ? a.documentInstructionsIgnored.filter((x) => typeof x === "string" && x) : [];
  if (!items.length) return null;
  const more = a.documentInstructionsIgnoredMore === true;
  const n = Math.min(items.length, 5);
  const num = more ? "more than 5" : String(n);
  const one = !more && n === 1;
  return {
    n,
    more,
    chip: more ? "More than 5 ignored" : `${n} ignored`,
    aria: `Your AI reported ${num} order${one ? "" : "s"} written in this file and ignored ${one ? "it" : "them"}`,
    line: `Your AI says this file had text that tried to give it orders. It reported ${num} and did not follow ${one ? "it" : "them"}.`,
    // true only when no direct save was flagged: otherwise "still went through the checks" would be false
    checked: !(a.flags || []).some((f) => f?.code === "file_changed_outside_onionskin"),
  };
}
