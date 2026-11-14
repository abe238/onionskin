/* The drifting workspace field pauses while the tab is hidden and while the user types or scrolls (:root[data-calm], read by
 * shell.css and backgrounds.css). No dependencies, no network. */

const root = document.documentElement;

const setPaused = (p) => {
  if (p) {
    if (root.dataset.calm !== "1") root.dataset.calm = "1";
  } else delete root.dataset.calm;
};
document.addEventListener("visibilitychange", () => setPaused(document.hidden));
let calmTimer = 0;
const calm = () => {
  if (document.hidden) return;
  setPaused(true);
  clearTimeout(calmTimer);
  calmTimer = setTimeout(() => setPaused(false), 1400);
};
document.addEventListener("keydown", calm, { capture: true, passive: true });
document.addEventListener("scroll", calm, { capture: true, passive: true });
