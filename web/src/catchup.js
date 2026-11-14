// Every state the server sends carries the session's version of the file (baseSha) and its runs, newest first. The page remembers the
// version and the newest run it last caught up with. When both have moved, a run (or a revert) changed the file and the page did not
// load it: the event stream was down when the agent finished, or the reload itself failed. The page catches up from the state, so no
// refresh depends on one event arriving once.
// A version that moved with no new run is not this: the file was changed outside Onionskin and opened again. That stays with the
// outside-change message and the copy made at Send; nothing is reloaded or merged for it here.

/** The id of the newest run in a session view (agent run, revert, a run that stopped), or null. */
export const newestRun = (view) => view.activity?.[0]?.id ?? null;

/**
 * What a page should do about the file version in `view`.
 *   "none":   it holds that version, no run moved it, a refresh for it is already under way, or the page is itself writing (Send, merge)
 *   "reload": load the new file
 *   "merge":  unsent edits: carry them onto the new file (POST /api/merge), then load it
 *   "wait":   unsent edits in a tab that may not write (read-only): never reloaded away
 */
export function catchUpPlan(view, { syncedSha, syncedRun, wantSha, busy, dirty, readOnly }) {
  if (!view.baseSha || !syncedSha || view.baseSha === syncedSha || view.baseSha === wantSha || busy) return "none";
  if (newestRun(view) === syncedRun) return "none";
  if (!dirty) return "reload";
  return readOnly ? "wait" : "merge";
}

/** Milliseconds before try number `n` (0-based) of a refresh that failed: 1, 2, 4, 8 s, then every 15 s; null when it is time to stop. */
export const retryDelay = (n) => (n >= 8 ? null : Math.min(15000, 1000 * 2 ** n));
