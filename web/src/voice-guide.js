// The voice guide's sections on the page. Pure. SECTIONS mirrors src/voice-guide.js (test/voice-guide-web.test.js checks both lists
// stay the same). The page never trusts the server's text for a heading: every heading the person reads comes from this table.

export const SECTIONS = [
  { id: "short", title: "In short", max: 700 },
  { id: "identity", title: "Who I am as a writer", max: 500 },
  { id: "priorities", title: "What matters most", max: 600 },
  { id: "tone", title: "Tone by situation", max: 700 },
  { id: "rhythm", title: "Sentences and rhythm", max: 450 },
  { id: "words", title: "Words I use and avoid", max: 600 },
  { id: "humor", title: "Humor", max: 400 },
  { id: "structure", title: "How I build a piece", max: 500 },
  { id: "punctuation", title: "Punctuation and formatting", max: 400 },
  { id: "rules", title: "Always and never", max: 600 },
  { id: "examples", title: "Before and after", max: 900 },
  { id: "calibration", title: "Sounds like me, does not sound like me", max: 600 },
];
export const GUIDE_MAX = 7000;

export const chars = (s) => [...String(s ?? "")].length;
const HEADING = new Map(SECTIONS.map((s) => [`## ${s.title}`, s.id]));

/**
 * The sections of a guide or draft text: `{structured, sections: [{id, title, body}]}`. A line that is one of the twelve headings
 * starts a section (so does one with trailing spaces); the optional "# My voice guide" line before the first is skipped. Any other line
 * starting with # (or text before the first heading) makes the text not structured, and then `sections` is empty. This mirrors the
 * server's parseGuide; the server stays the judge of what is stored.
 */
export function parseGuide(text) {
  const none = { structured: false, sections: [] };
  if (typeof text !== "string" || !text.trim()) return none;
  const found = [];
  let cur = null;
  let last = -1;
  let title = false;
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const t = line.trimEnd();
    if (/^\s*#/u.test(t.normalize("NFKC"))) {
      if (!cur && !title && t === "# My voice guide") {
        title = true;
        continue;
      }
      const id = HEADING.get(t);
      const i = SECTIONS.findIndex((s) => s.id === id);
      if (id === undefined || i <= last) return none;
      last = i;
      cur = { id, title: SECTIONS[i].title, lines: [] };
      found.push(cur);
    } else if (cur) cur.lines.push(line);
    else if (t.trim()) return none;
  }
  if (!found.length) return none;
  return { structured: true, sections: found.map((f) => ({ id: f.id, title: f.title, body: f.lines.join("\n").replace(/^\s*\n/, "").trimEnd() })) };
}

/**
 * The text to save. `texts` is {id: the body as it stands in the box}, `ticks` {id: true when the person uses that section}, `saved` the
 * saved guide's parsed sections. A ticked section is written from its box (left out when the box is empty); an unticked one keeps the
 * saved body when there is one, and otherwise is left out. The order is always the fixed order.
 */
export function composeGuide(texts, ticks, saved = []) {
  const kept = new Map(saved.map((s) => [s.id, s.body]));
  const parts = [];
  for (const s of SECTIONS) {
    const body = ticks[s.id] ? String(texts[s.id] ?? "").trim() : (kept.get(s.id) ?? "").trim();
    if (body) parts.push(`## ${s.title}\n${body}`);
  }
  return parts.join("\n\n");
}

/** True when a line of a section's text starts with # (it would be read as a heading or break the layout). */
export const hasHeadingLine = (body) => String(body ?? "").split("\n").some((l) => /^\s*#/u.test(l.normalize("NFKC")));

/**
 * A line diff of two texts: [{t: "same" | "add" | "del", text}], the shortest edit by longest common subsequence. A text over 400 lines
 * is compared as a whole (all removed, all added) so the cost stays small.
 */
export function lineDiff(a, b) {
  const x = String(a ?? "") === "" ? [] : String(a).split("\n");
  const y = String(b ?? "") === "" ? [] : String(b).split("\n");
  if (x.length > 400 || y.length > 400) return [...x.map((text) => ({ t: "del", text })), ...y.map((text) => ({ t: "add", text }))];
  const n = x.length;
  const m = y.length;
  const L = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      out.push({ t: "same", text: x[i] });
      i++;
      j++;
    } else if (L[i + 1][j] >= L[i][j + 1]) out.push({ t: "del", text: x[i++] });
    else out.push({ t: "add", text: y[j++] });
  }
  while (i < n) out.push({ t: "del", text: x[i++] });
  while (j < m) out.push({ t: "add", text: y[j++] });
  return out;
}

/**
 * The parts of a box that have been on screen, as sorted, merged [top, bottom] spans in px from the box's top. `addSpan` adds one; an
 * empty span adds nothing. `covered` is true once the spans reach from the top to the bottom of a box `height` px tall, with a pixel of
 * rounding at each end. A box with no height was never read.
 */
export function addSpan(spans, a, b) {
  if (!(b > a)) return spans;
  const out = [];
  let cur = [a, b];
  for (const s of spans) {
    if (s[1] < cur[0]) out.push(s);
    else if (s[0] > cur[1]) {
      out.push(cur);
      cur = s;
    } else cur = [Math.min(cur[0], s[0]), Math.max(cur[1], s[1])];
  }
  out.push(cur);
  return out;
}
export const covered = (spans, height) => height > 0 && spans.some(([a, b]) => a <= 1 && b >= height - 1);
