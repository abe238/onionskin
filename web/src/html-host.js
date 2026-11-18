// What App.jsx needs to show an HTML file (PLAN-html Phase 2a), kept out of App.jsx: fetching the view (GET /api/html-view, one binary
// body: src/html-envelope.js), the marks the viewer draws from the comments, and the page location of a resolved anchor. Pure except
// fetchHtmlView.
import { decodeHtmlView } from "../../src/html-envelope.js";
import { TAB, getToken } from "./lib.js";

/**
 * The view of the file as it is on disk now: {version, plain, reason, stats, texts, editable, copy}. `plain`: the plain copy (asked after
 * the view stopped responding, R6). A refusal throws an Error with the server's words and fields (`code`, `copyable` for a page that is
 * not UTF-8 any more), and `status`.
 */
export async function fetchHtmlView(sid, { plain = false } = {}) {
  const res = await fetch(`/api/html-view?s=${encodeURIComponent(sid)}${plain ? "&plain=1" : ""}`, { credentials: "same-origin", headers: { "x-onionskin-token": getToken(), "x-onionskin-tab": TAB } });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw Object.assign(new Error(j.error || `HTTP ${res.status}`), { status: res.status, ...j });
  }
  return decodeHtmlView(await res.arrayBuffer());
}

/**
 * The location a comment is drawn at in the version `version` the page shows: the server's resolved place (its `page` location, in the
 * page's own offsets), or the comment's own page anchor when it was made on this version; null when neither (it was made on another
 * version and is not resolved yet: never drawn at a node id of another version).
 */
export function htmlLocOf(c, rz, version) {
  if (rz) return rz.loc || null;
  const loc = c.anchor?.location;
  return loc && Number.isInteger(loc.nodeId) && (!loc.version || loc.version === version) ? loc : null;
}

/** The marks HtmlViewer draws: one per comment and pin with a place in this version, numbered as the review panel numbers them. */
export function htmlMarks(comments, resolved, version) {
  const out = [];
  comments.forEach((c, i) => {
    const loc = htmlLocOf(c, resolved[c.id], version);
    if (!loc) return;
    out.push({ id: c.id, n: i + 1, status: c.status, kind: c.kind === "pin" ? "pin" : c.kind === "text" ? "text" : "element", location: loc, ...(c.kind === "pin" && c.pin ? { pin: { xFrac: c.pin.xFrac ?? 0.5, yFrac: c.pin.yFrac ?? 0.5 } } : {}) });
  });
  return out;
}

/** The server's re-resolved HTML anchor (src/html.js resolveHtml) -> the page location: its `page` place, else the whole element. */
export function htmlLocFromResolved(a) {
  if (!a || a.method === "none") return null;
  if (a.page && Number.isInteger(a.page.nodeId)) return a.page.start != null ? { nodeId: a.page.nodeId, start: a.page.start, end: a.page.end } : { nodeId: a.page.nodeId };
  return Number.isInteger(a.nodeId) ? { nodeId: a.nodeId } : null;
}

/** A page anchor or location stamped with the version it was made on (a node id means nothing in another version). */
export const stamped = (anchor, version) => (anchor?.location && version ? { ...anchor, location: { ...anchor.location, version } } : anchor);
