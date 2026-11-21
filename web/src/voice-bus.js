import { useSyncExternalStore } from "react";

// Two small things the activity list and the Writing preferences share without passing props through the whole page: whether a draft of the
// voice guide is waiting (the preferences publish it each time they load the voice state), and a request to open the draft ("Review draft"
// in the activity list). A draft is agent text: only the fact that one exists travels here, never its words.
let ready = "";
const subs = new Set();
const openers = new Set();
const subscribe = (fn) => (subs.add(fn), () => subs.delete(fn));
const notify = () => subs.forEach((fn) => fn());
let pendingRequests = 0;

// The request can outlive its dialog and the preferences panel that opened it.
export function beginGuideRequest() {
  pendingRequests++;
  notify();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    pendingRequests--;
    notify();
  };
}
export const useGuidePending = () => useSyncExternalStore(subscribe, () => pendingRequests > 0, () => false);

/** The id of the batch whose draft is waiting, or "" (the page keeps only this id). */
export function setDraftReady(batchId) {
  const next = typeof batchId === "string" ? batchId : "";
  if (next === ready) return;
  ready = next;
  notify();
}
export const useDraftBatch = () =>
  useSyncExternalStore(
    subscribe,
    () => ready,
    () => ""
  );

/** The editor registers itself while the preferences are on the page. */
export const onReviewDraft = (fn) => (openers.add(fn), () => openers.delete(fn));
export const reviewDraft = () => {
  if (pendingRequests > 0) return;
  openers.forEach((f) => f());
};
