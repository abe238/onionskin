import { changedRegions } from "./anchors.js";
import { checkPackages } from "./package.js";

/**
 * What `done` learns from the before and after bytes: package checks (Node always, the deeper Python/LibreOffice check when set up) and the
 * changed regions. Pure and synchronous, so the server can run it in a worker thread (src/offload.js) and keep answering while it works.
 */
export function analyze(pre, post, format, opts = {}) {
  const { flags, checks } = checkPackages(pre, post, format, opts);
  let changes = null;
  try {
    changes = changedRegions(format, pre, post);
  } catch {
    changes = null; // unreadable: say nothing rather than guess
  }
  return { flags, checks, changes };
}
