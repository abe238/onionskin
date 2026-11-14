// Quick fixes, the page's side (no UI code, so unit tests load it): an answer of POST /api/suggest becomes a card, the "Check:" lines come
// from fixed templates, and the diff ops split into the "Now:" and "Suggested:" lines. Everything the server sends is untrusted text (the
// sentence from the document, the rewrite from the model): it is only ever drawn as plain text, and the words in a "Check:" line are cut to 30
// characters and stripped of control characters here again.
import { diffNodes } from "./history-view.js";
import { BUILT_IN, SELECT_ONE_SENTENCE, SUGGEST_TASKS } from "./stamps.js";

export const WORDS = {
  working: "Writing a suggestion on this Mac...",
  warming: "Getting the writing helper ready.",
  header: "Suggestion",
  sub: "Made on this Mac by Apple's writing model. Nothing changes until you tap Use this.",
  now: "Now:",
  suggested: "Suggested:",
  use: "Use this",
  agent: "Ask the agent instead",
  retry: "Try again",
  whole: "Check the whole sentence carefully.",
  question: "Check: this now reads as a question.",
  statement: "Check: this no longer reads as a question.",
  numberMoved: "Check: a number is now next to different words.",
};

const NONE = {
  facts: "No suggestion this time: the writing helper changed a number, date or name.",
  notClean: "No suggestion this time: the writing helper did not give a clean rewrite of this sentence.",
  notShorter: "No shorter version this time.",
  notFriendlier: "No friendlier version this time.",
  nothingToFix: "The writing helper found nothing to fix. It can miss mistakes, so ask the agent if you are not sure.",
  timeout: "No suggestion this time. The writing helper took too long.",
  busy: "The writing helper is busy with another sentence. Try again in a moment.",
  stillWarming: "The writing helper is still starting. Try again in a moment, or ask the agent.",
  protected: "This part of the file is protected, so it cannot be changed here.",
  addressesAi: "No suggestion for this sentence. It reads like instructions for an AI.",
  expired: "This suggestion is out of date. Tap the stamp again.",
  agentStarted: "The agent started working on this file, so nothing was written. Ask the agent instead, or try again when it is done.",
  refused: "No suggestion for this sentence.", // Apple's model declined the sentence
  quoted: "No suggestion here: the change is inside quoted text.", // the same words as QUOTED_LINE in src/suggest.js
  failed: "No suggestion this time. The writing helper did not answer.", // not in the design's list: a model that errors out
};
export const NONE_WORDS = NONE;

/** A word of a warning, safe for a "Check:" line: no control characters, at most 30 characters, never empty. */
export function cleanWord(w) {
  const s = String(w ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, "").trim();
  return [...s].slice(0, 30).join("");
}

const list = (a) => (Array.isArray(a) ? a.map(cleanWord).filter(Boolean) : []);

/** One "Check:" line for one warning, or "" when it has nothing to say. */
function checkLine(w) {
  if (!w || typeof w !== "object") return "";
  if (w.code === "question") return w.now === "question" ? WORDS.question : WORDS.statement;
  if (w.code === "number_moved") return WORDS.numberMoved;
  const dropped = list(w.dropped);
  const added = list(w.added);
  if (dropped.length && added.length) return `Check: "${dropped[0]}" became "${added[0]}".`;
  if (added.length) return `Check: "${added[0]}" was added.`;
  if (dropped.length) return `Check: "${dropped[0]}" was taken out.`;
  return "";
}

/** Up to two "Check:" lines, in the server's order; with more than two warnings a third line says to read the whole sentence. */
export function warningLines(warnings) {
  const all = (Array.isArray(warnings) ? warnings : []).map(checkLine).filter(Boolean);
  return all.length > 2 ? [all[0], all[1], WORDS.whole] : all;
}

/** diffText ops -> {now, suggested}: render nodes for the original (removed words marked) and for the rewrite (added words marked). */
export function splitDiff(ops) {
  const nodes = diffNodes(ops).filter((n) => n.t !== "gap");
  return { now: nodes.filter((n) => n.t !== "ins"), suggested: nodes.filter((n) => n.t !== "del") };
}

/**
 * An answer of POST /api/suggest -> what the card shows.
 *   {kind: "shown", id, before, after, now, suggested, checks, anchor}   anchor: the whole sentence the suggestion is for (the selection, completed by the server), or null
 *   {kind: "none", text, retry}       one line, "Ask the agent instead", and "Try again" only when `retry`
 *   (`maybe`: the page could not judge the selection before the tap; a "not one sentence" answer then says so instead of sending)
 *   {kind: "send"}                    the server does not agree that this can be suggested (or it is off): the tap does what it always did
 */
export function cardFor(answer, task, maybe = false) {
  const a = answer && typeof answer === "object" ? answer : {};
  const none = (text, retry = false) => ({ kind: "none", text, retry });
  switch (a.state) {
    case "shown": {
      if (typeof a.id !== "string" || typeof a.before !== "string" || typeof a.after !== "string") return none(NONE.failed, true);
      const { now, suggested } = splitDiff(a.diff);
      const an = a.anchor && typeof a.anchor === "object" && typeof a.anchor.quote === "string" && a.anchor.location && typeof a.anchor.location === "object" && !Array.isArray(a.anchor.location) ? { location: a.anchor.location, quote: a.anchor.quote, prefix: String(a.anchor.prefix ?? ""), suffix: String(a.anchor.suffix ?? "") } : null;
      return { kind: "shown", anchor: an, id: a.id, before: a.before, after: a.after, now: now.length ? now : [{ t: "eq", text: a.before }], suggested: suggested.length ? suggested : [{ t: "eq", text: a.after }], checks: warningLines(a.warnings) };
    }
    case "unchanged":
      return none(task === "grammar" ? NONE.nothingToFix : task === "friendlier" ? NONE.notFriendlier : NONE.notShorter);
    case "withheld":
      if (a.why === "facts") return none(NONE.facts);
      if (a.why === "quoted") return none(NONE.quoted);
      if (a.why === "not_shorter") return none(NONE.notShorter);
      if (a.why === "not_friendlier") return none(NONE.notFriendlier);
      return none(NONE.notClean);
    case "addresses_ai":
      return none(NONE.addressesAi);
    case "protected":
      return none(NONE.protected);
    case "timeout":
      return none(NONE.timeout, true);
    case "busy":
      return none(NONE.busy, true);
    case "warming":
      return none(NONE.stillWarming, true);
    case "failed":
      return a.why === "refused" ? none(NONE.refused) : none(NONE.failed, true); // a refusal would come again: no "Try again"
    case "not_eligible":
      if (a.why === "working") return none(NONE.agentStarted);
      return maybe ? none(SELECT_ONE_SENTENCE) : { kind: "send" }; // a selection the page could not judge (PowerPoint) and the server says is not one sentence: say so, never send silently
    default: // off, or an answer this page does not know
      return { kind: "send" };
  }
}

// ---- the head start (App.jsx askAhead): Fix grammar is asked for when the Quick ask box opens, and the answer waits for the tap -------------
/** What a held answer is for: the task, the selection exactly (location, quote, the words around it, whole paragraph) and the file's version. */
export const aheadKey = (req, sha) => {
  const a = req?.anchor || {};
  return JSON.stringify([req?.task, a.location ?? null, a.quote ?? null, a.prefix ?? "", a.suffix ?? "", !!req?.wholeParagraph, sha ?? null]);
};
export const AHEAD_MS = 5 * 60_000; // well inside the server's 10 minutes for a kept suggestion, so a held card can still be used
/**
 * May an answer asked for before the tap be the tap's answer? Only one that would come again: a suggestion, nothing to fix, withheld, reads
 * like instructions, protected, or the model declining. Busy, still starting, too slow, failed, off and not eligible are asked again at the tap.
 */
export function reusableAhead(answer) {
  const s = answer?.state;
  return ["shown", "unchanged", "withheld", "addresses_ai", "protected"].includes(s) || (s === "failed" && answer.why === "refused");
}

/** The line for a refused Use (the server's own sentences, or ours when it sent none). */
export function useRefusal(err) {
  if (err?.code === "expired") return NONE.expired;
  if (err?.code === "busy") return NONE.agentStarted;
  return typeof err?.message === "string" && err.message ? err.message : NONE.failed;
}

// The one-time offer (SuggestOffer.jsx): one tap turns quick fixes on; nothing is downloaded
export const OFFER = {
  line: "Get quick fixes for one sentence, made by Apple's writing model on this Mac. Nothing you write leaves it.",
  turnOn: "Turn on",
  no: "No thanks",
  working: "Turning on quick fixes.",
  failed: "Quick fixes could not be turned on. Nothing was changed. Try again, or ask your agent to look into it.",
};

// The design's two lines name Shorter, Friendlier and Fix grammar. Only the stamps on the server's list (`suggest.tasks` in the bootstrap) show a
// suggestion first, so the lines name exactly those, in the stamp row's order; the words of the list itself never reach the screen.
const named = (tasks) => {
  const t = tasks === undefined ? SUGGEST_TASKS : Array.isArray(tasks) ? tasks : []; // as suggestEligible reads it: no list is the default, junk is none
  return BUILT_IN.filter((s) => !s.language && t.includes(s.id)).map((s) => s.label);
};
const join = (l, last) => (l.length < 2 ? l.join("") : `${l.slice(0, -1).join(", ")} ${last} ${l[l.length - 1]}`);

/** The stamp row's line while quick fixes are on. With nothing on the list it says what the stamps do when off. */
export function stampHintOn(tasks) {
  const l = named(tasks);
  if (!l.length) return "Tap a stamp to send it with your other changes.";
  return `${join(l, "and")} ${l.length === 1 ? "shows" : "show"} a suggestion first on one sentence. Other taps go to the agent with your other changes.`;
}

/** The offer's line once the setup it started has finished. */
export function offerDone(tasks) {
  const l = named(tasks);
  return l.length ? `Quick fixes are on. Select one sentence and tap ${join(l, "or")}.` : "Quick fixes are on.";
}
