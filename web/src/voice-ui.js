import { useEffect, useState } from "react";
import { api } from "./lib.js";

// What the page knows about the writing preferences and learning. Pure data and one hook; the components are VoiceSuggestions.jsx,
// VoiceExport.jsx and VoiceImport.jsx. The traits mirror src/style.js (TRAITS): test/voice-ui.test.js checks that both lists stay the same.
export const TRAITS = [
  { id: "short", label: "Keep it short", sentence: "Keep new text short." },
  { id: "plain", label: "Plain words", sentence: "Use plain, everyday words." },
  { id: "formal", label: "More formal", sentence: "Use a formal tone." },
  { id: "relaxed", label: "More relaxed", sentence: "Use a relaxed, friendly tone." },
  { id: "minimal", label: "Change as little as possible", sentence: "Change as little of my wording as possible." },
  { id: "format", label: "Leave formatting alone", sentence: "Do not change formatting unless I ask." },
  { id: "short_sentences", label: "Short sentences", sentence: "Use short sentences." },
  { id: "no_exclaim", label: "No exclamation marks", sentence: "Do not use exclamation marks." },
];

export const GUIDE_MAX = 7000;
export const EXAMPLE_MAX = 3;

// The evidence sentence of a suggestion. The server sends a trait id, a source and two whole numbers; every word the person reads comes
// from this table, never from the server. A trait and source with no entry here is not shown at all.
const EVIDENCE = {
  "short:edits": (n, m) => `You shortened the agent's text in ${n} of your last ${m} edits.`,
  "short_sentences:edits": (n, m) => `You made the agent's sentences shorter in ${n} of your last ${m} edits.`,
  "no_exclaim:edits": (n) => `You took out the agent's exclamation marks ${n} times.`,
  "minimal:edits": (n, m) => `You put back your own wording in ${n} of your last ${m} edits.`,
  "format:edits": (n) => `You undid the agent's formatting changes ${n} times.`,
  "short:comments": (n) => `You asked for shorter text in ${n} comments.`,
  "plain:comments": (n) => `You asked for plainer words in ${n} comments.`,
  "formal:comments": (n) => `You asked for a more formal tone in ${n} comments.`,
  "relaxed:comments": (n) => `You asked for a more relaxed tone in ${n} comments.`,
  "minimal:comments": (n) => `You asked the agent to keep your wording in ${n} comments.`,
};

const whole = (x) => Number.isSafeInteger(x) && x >= 0;

/** {trait, label, text} for a suggestion the page can word, or null (unknown trait, source or numbers: it is not shown). */
export function suggestionView(s) {
  if (!s || typeof s !== "object") return null;
  const trait = TRAITS.find((t) => t.id === s.trait);
  const make = typeof s.source === "string" && Object.hasOwn(EVIDENCE, `${s.trait}:${s.source}`) ? EVIDENCE[`${s.trait}:${s.source}`] : null;
  if (!trait || !make || !whole(s.n) || !whole(s.m)) return null;
  return { trait: trait.id, label: trait.label, text: make(s.n, s.m) };
}

/** The sentences of the preferences that are on, in the list's order: what voice.md says under "Preferences". */
export const traitSentences = (ids) => TRAITS.filter((t) => Array.isArray(ids) && ids.includes(t.id)).map((t) => t.sentence);

/** [voice, setVoice]: GET /api/voice, loaded each time `active` or `again` changes. null until it has loaded (or when it could not). */
export function useVoice(active, again = "") {
  const [voice, setVoice] = useState(null);
  useEffect(() => {
    if (!active) return;
    let live = true;
    api("/api/voice")
      .then((v) => live && setVoice(v))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [active, again]);
  return [voice, setVoice];
}
