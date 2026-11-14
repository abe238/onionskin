import { useSyncExternalStore } from "react";

// Two small things the activity list and the Writing preferences share without passing props through the whole page: whether a draft of the
// voice guide is waiting (the preferences publish it each time they load the voice state), and a request to open the draft ("Review draft"
// in the activity list). A draft is agent text: only the fact that one exists travels here, never its words.
let ready = "";
const subs = new Set();
const openers = new Set();

/** The id of the batch whose draft is waiting, or "" (the page keeps only this id). */
export function setDraftReady(batchId) {
  const next = typeof batchId === "string" ? batchId : "";
  if (next === ready) return;
  ready = next;
  subs.forEach((f) => f());
}
export const useDraftBatch = () =>
  useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => ready,
    () => ""
  );

/** The editor registers itself while the preferences are on the page. */
export const onReviewDraft = (fn) => (openers.add(fn), () => openers.delete(fn));
export const reviewDraft = () => openers.forEach((f) => f());
