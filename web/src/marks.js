// Timing marks for the refresh after a run and for the file load. They exist so scripts/real-run/bench-real.mjs can read where the time goes
// (performance.getEntriesByType("measure")). Off unless this is a dev build or the page was started with window.__onionskinMarks = true (the bench
// sets it before the page loads). Nothing is logged or sent anywhere; a mark carries only a fixed name.

const on = () => !!(import.meta.env?.DEV || globalThis.__onionskinMarks === true);

export function mark(name) {
  if (!on()) return;
  try {
    performance.mark(name);
  } catch {
    /* a browser without the User Timing API: no marks */
  }
}

/** A measure named `name` from the latest mark `from` to the latest mark `to` (to now when `to` is omitted). */
export function measure(name, from, to) {
  if (!on()) return;
  try {
    performance.measure(name, from, to);
  } catch {
    /* a mark that was never made: no measure */
  }
}
