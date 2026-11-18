let token = "";
export const getToken = () => token;

/**
 * The launch token reaches this page once, as a <meta> in the response to the launch link (see BrowserAuth). It is kept in memory and in this
 * origin's sessionStorage (the origin includes the port, so a server on another port cannot read it) so a reload keeps working. A new tab or
 * a page without storage has none and must be reopened from the terminal. Returns "" when there is none.
 */
export function loadLaunchToken(sid) {
  const meta = document.querySelector('meta[name="onionskin-launch"]');
  const key = `onionskin.token.${sid}`;
  let t = meta?.getAttribute("content") || "";
  meta?.remove();
  if (t) {
    try {
      window.sessionStorage.setItem(key, t);
    } catch {
      /* no storage: the token lives in memory for this page load only */
    }
  } else {
    try {
      t = window.sessionStorage.getItem(key) || "";
    } catch {
      t = "";
    }
  }
  token = t;
  return t;
}

/** Identifies this page load to the server: one tab per file may edit; the others open read-only (see Sessions.claimEditor). */
export const TAB = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

/**
 * How long the page waits for an answer before it treats the request as unanswered (as a dropped connection: no `status`). Longer than the
 * server can take on purpose: a draft save or a page load waits for a Send of the file in flight (Sessions.settled: twice the anchor worker's
 * 60 s limit, plus 5 s). A Send (and a file download) gets more: it can carry a document of up to 200 MB and plan its worker job twice.
 */
export const REQUEST_MS = 150_000;
export const SEND_MS = 300_000;

export async function api(path, { method = "GET", body, raw = false, keepalive = false, timeout = REQUEST_MS } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(path, {
      method,
      keepalive, // a page that is going away can still finish a small request
      credentials: "same-origin",
      headers: { "x-onionskin-token": token, "x-onionskin-tab": TAB, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });
    if (raw) {
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
      return { buf: await res.arrayBuffer(), sha: res.headers.get("x-sha256") };
    }
    const json = await res.json().catch((err) => {
      if (ctl.signal.aborted) throw err;
      return {};
    });
    if (!res.ok) throw Object.assign(new Error(json.error || `HTTP ${res.status}`), { status: res.status, ...json });
    return json;
  } catch (err) {
    if (ctl.signal.aborted) throw new Error("Failed to fetch: no answer in time"); // no status: the caller treats it as a lost answer
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export const uid = (p) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

// ---- A1 helpers (the host speaks A1; everything here is client-side and tiny) ---------------------------------
const colLetters = (n) => {
  let s = "";
  for (n += 1; n; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};
const colIndex = (letters) => [...letters.toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
/** "B2" or "B2:D9" -> {r0,c0,r1,c1} (0-based); null for whole rows / columns / the sheet */
export function parseA1(a1) {
  const m = /^([A-Za-z]{1,3})(\d{1,7})(?::([A-Za-z]{1,3})(\d{1,7}))?$/.exec(a1 || "");
  if (!m) return null;
  const r0 = Number(m[2]) - 1;
  const c0 = colIndex(m[1]);
  const r1 = m[4] ? Number(m[4]) - 1 : r0;
  const c1 = m[3] ? colIndex(m[3]) : c0;
  return { r0: Math.min(r0, r1), c0: Math.min(c0, c1), r1: Math.max(r0, r1), c1: Math.max(c0, c1) };
}
const a1Range = (q) => (q.r0 === q.r1 && q.c0 === q.c1 ? `${colLetters(q.c0)}${q.r0 + 1}` : `${colLetters(q.c0)}${q.r0 + 1}:${colLetters(q.c1)}${q.r1 + 1}`);
/** the smallest range holding both (a drag from one cell to another); whole-row / column hits keep the first */
export function unionRange(a, b) {
  const p = parseA1(a);
  const q = parseA1(b);
  if (!p || !q) return a;
  return a1Range({ r0: Math.min(p.r0, q.r0), c0: Math.min(p.c0, q.c0), r1: Math.max(p.r1, q.r1), c1: Math.max(p.c1, q.c1) });
}
export const rangeHasCell = (range, r, c) => {
  const q = parseA1(range);
  return !!q && r >= q.r0 && r <= q.r1 && c >= q.c0 && c <= q.c1;
};

const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
const words = (t, n = 7, max = 48) => {
  const w = clean(t).split(" ").slice(0, n).join(" ");
  return w.length > max ? `${w.slice(0, max - 1)}...` : w + (clean(t).split(" ").length > n ? "..." : "");
};

/** The page a rendered DOCX paragraph sits on, read from the engine's page container (the host API has no page). */
function docxPageOf(blockPath) {
  if (!blockPath || blockPath.length !== 1) return null;
  const el = document.querySelector(`.de-p[data-bi="${blockPath[0]}"]`);
  const n = el?.closest(".de-page")?.dataset.page;
  return n ? Number(n) : null;
}

/**
 * A place in words the user can read. DOCX: the heading it is under (from the server once re-resolved), the first words of the paragraph and
 * the page when rendered. XLSX: Sheet!A1. PPTX: Slide N, shape "name". `ctx` = {text, heading, page}.
 */
export function labelFor(format, loc, ctx = {}) {
  if (!loc) return "unknown place";
  if (format === "docx") {
    const bp = loc.blockPath || [];
    const text = ctx.text ?? paragraphText(bp);
    const parts = [];
    if (ctx.heading) parts.push(`Under "${words(ctx.heading, 5, 32)}"`);
    parts.push(text ? `"${words(text)}"` : bp.length >= 4 ? `Table ${bp[0] + 1}, row ${bp[1] + 1}, col ${bp[2] + 1}` : `Paragraph ${bp[0] + 1}`);
    const page = ctx.page ?? docxPageOf(bp);
    if (page) parts.push(`page ${page}`);
    return parts.join(", ");
  }
  if (format === "xlsx") return `${loc.sheetName || `Sheet ${loc.sheetIndex + 1}`}!${loc.range || ""}`.replace(/!$/, "");
  // HTML: the words of the element (the server's text once re-resolved), under its heading
  if (format === "html") return [ctx.heading ? `Under "${words(ctx.heading, 5, 32)}"` : null, ctx.text ? `"${words(ctx.text)}"` : "A part of the page"].filter(Boolean).join(", ");
  if (format !== "pptx") return "unknown place"; // a format this page does not know: no deck words for it
  const cell = loc.cell ? `, row ${loc.cell.row + 1} col ${loc.cell.col + 1}` : "";
  return `Slide ${loc.slideIndex + 1}${loc.shapeId != null ? `, shape ${loc.shapeName ? `"${loc.shapeName}"` : loc.shapeId}` : ""}${cell}`;
}

/** The server's re-resolved anchor (see anchors.md) -> the engine location to draw and jump to. */
export function locFromResolved(format, a) {
  if (!a || a.method === "none") return null;
  if (format === "xlsx") return { sheetIndex: a.sheetIndex, sheetName: a.sheetName, range: a.range };
  if (format === "pptx") return { slideIndex: a.slideIndex, slideId: a.slideId, ...(a.shapeId != null ? { shapeId: a.shapeId, shapeName: a.shapeName } : {}) };
  return null;
}

const locKey = (format, loc) => {
  if (format === "html") return `${loc?.nodeId}`; // one source text node: typing in it is one change
  if (format === "docx") return JSON.stringify(loc.blockPath);
  if (format === "xlsx") return `${loc.sheetIndex}:${loc.range}`;
  if (format !== "pptx") return `?:${JSON.stringify(loc ?? null)}`; // a format this page does not know: the place as it came
  return `${loc.slideIndex}:${loc.shapeId ?? ""}:${loc.cell ? loc.cell.row + "," + loc.cell.col : ""}`;
};

/** Typing sends one event per keystroke: merge consecutive events on the same place into one change (first before, last after). */
export function coalesce(list, e) {
  const key = `${e.kind}|${locKey(e.format, e.location)}`;
  const last = list[list.length - 1];
  if (last && last.key === key && ["text", "cell"].includes(e.kind)) {
    const merged = { ...last, after: e.after };
    const rest = list.slice(0, -1);
    return merged.after === merged.before ? rest : [...rest, merged];
  }
  return [...list, { id: uid("e"), key, kind: e.kind, format: e.format, location: e.location, label: labelFor(e.format, e.location), before: e.before, after: e.after }];
}

/** The engine renders DOCX body blocks as .de-p[data-bi=<blockPath[0]>]. Internal to the engine: used only to read a paragraph's text and to verify a re-resolved location. */
export function paragraphText(blockPath) {
  if (!blockPath || blockPath.length !== 1) return null;
  const el = document.querySelector(`.de-p[data-bi="${blockPath[0]}"]`);
  return el ? clean(el.textContent) : null;
}

/** After a reload: confirm the mapped block index shows the expected text, else look a few blocks around it. Returns a blockPath, or null if not rendered/unverifiable. */
export function verifyBlock(blockPath, expected) {
  if (!blockPath || blockPath.length !== 1 || !expected) return { path: blockPath, verified: false };
  const want = clean(expected).slice(0, 30);
  for (const d of [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6, 7, -7, 8, -8]) {
    const t = paragraphText([blockPath[0] + d]);
    if (t && t.startsWith(want)) return { path: [blockPath[0] + d], verified: true };
  }
  return { path: blockPath, verified: false };
}

/** Compact before -> after view: the changed middle with a little context either side. */
export function diffParts(before = "", after = "") {
  let p = 0;
  while (p < before.length && p < after.length && before[p] === after[p]) p++;
  let s = 0;
  while (s < before.length - p && s < after.length - p && before[before.length - 1 - s] === after[after.length - 1 - s]) s++;
  const cut = (t, n) => (t.length > n ? `${t.slice(0, n)}...` : t);
  return {
    pre: (p > 24 ? "..." : "") + before.slice(Math.max(0, p - 24), p),
    removed: cut(before.slice(p, before.length - s), 80),
    added: cut(after.slice(p, after.length - s), 80),
    post: cut(before.slice(before.length - s), 24),
  };
}

/** Per-viewer conveniences (theme, sidebar width). Storage can be blocked or throw: every access is guarded. */
export const store = {
  get(area, key) {
    try {
      return window[area].getItem(key);
    } catch {
      return null;
    }
  },
  set(area, key, value) {
    try {
      window[area].setItem(key, String(value));
    } catch {
      /* private window or blocked storage: the page works without it */
    }
  },
};

export function relTime(at, now = Date.now()) {
  const t = typeof at === "number" ? at : Date.parse(at);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

/** The flags worth a line in the panel. A new part's link file says nothing its part does not, and a removed slide is one line, not one per file. */
const SLIDE_PART = /^ppt\/slides\/slide\d+\.xml$/;
export const shownFlags = (flags) => {
  const seen = new Set(); // the quick check and the deeper check can both report the same slide
  return (flags || []).filter((f) => {
    if (f.code === "part_added" && /\/_rels\/[^/]+\.rels$/.test(f.part || "")) return false;
    if (f.code !== "slide_removed") return true;
    if (!SLIDE_PART.test(f.part || "") || seen.has(f.part)) return false;
    return !!seen.add(f.part);
  });
};

/** Package-check flags from the server, in words. Unknown codes fall back to the raw code so nothing is hidden. */
export function flagText(f) {
  switch (f.code) {
    case "part_removed":
      return `A part of the file was removed: ${f.part}`;
    case "part_added":
      return SLIDE_PART.test(f.part || "") ? "A slide was added to the deck." : `A new part appeared in the file: ${f.part}`;
    case "slide_removed":
      return "A slide was removed from the deck. Revert this run brings it back.";
    case "relationship_target_missing":
      return `A link points at a part that is missing: ${f.target || f.part || ""}`.trim();
    case "count_decreased":
      return `Fewer ${f.element} than before (${f.before} to ${f.after})`;
    case "no_result_for_comment":
      return "The agent did not answer one of the comments";
    case "bad_question":
      return "The agent asked a question that could not be shown. That comment is marked declined.";
    case "apply_not_applied":
      return `${f.op || "An edit"} was not applied${f.reason_code ? ` (${f.reason_code})` : ""}${f.detail ? `: ${f.detail}` : ""}`;
    case "apply_skipped_protected":
      return `${f.op || "An edit"} skipped a protected place${f.detail ? `: ${f.detail}` : ""}`;
    case "soffice_convert_failed":
      return `LibreOffice could not open and convert the file after this run${f.detail ? `: ${f.detail}` : ""}`;
    case "deep_check_failed":
      return "The deeper check could not finish. Open Details for more.";
    case "taken_back_mid_run":
      return "Taken back while the agent was writing. The file keeps what the agent had written so far; Revert goes back to your version.";
    case "lease_expired_mid_run":
      return "The agent stopped responding after writing to the file. The file keeps what was written; Revert goes back to the version before.";
    case "file_changed_outside_onionskin":
      return "The file was saved by something other than Onionskin while the agent worked. The earlier version is stored; Revert restores it.";
    case "style_changed_outside_onionskin":
      return "Your writing preferences were changed outside Onionskin, so they were put back.";
    case "bad_voice_draft":
      return "The agent's draft broke the rules for a guide (links, hidden characters or the wrong layout), so it was not kept.";
    case "voice_guide_changed_outside_onionskin":
      return "Your voice guide was changed outside Onionskin, so it was put back.";
    case "voice_draft_not_saved":
      return "The agent's draft could not be saved, so it was not kept.";
    case "voice_draft_not_allowed":
      return "The agent sent a voice guide draft that nobody asked for, so it was ignored.";
    case "voice_request_replaced":
      return "Your Send replaced the voice guide request that was waiting for the agent. Build it again when you are ready.";
    case "voice_run_changed_file":
      return "The file changed while the agent drafted your voice guide. Revert goes back to the version before.";
    case "queued_reanchor_failed":
      return `A comment sent while the agent worked could not be matched to the new file${f.detail ? `: ${f.detail}` : ""}`;
    case "invalid_package":
      return `The file may not open cleanly: ${f.detail || ""}`.trim();
    default:
      return [f.code, f.element, f.part, f.target].filter(Boolean).join(" ");
  }
}

/** Engine hosts may mark read-only places (location.protected); older engines never set it. */
export const isProtected = (loc) => !!(loc && (loc.protected === true || loc.readOnly === true));

/**
 * A triple-click or a drag that runs past the end of a page leaves the browser selection ending on the page's footer or the page itself, not in
 * a paragraph, and the editor engine then reports no selection at all (no Ask or Comment chip). Moves such an end back to the nearest paragraph
 * edge (the end of the paragraph before it, or the start of the one after it) and returns true when it did. Only an end that is on a page but in no
 * paragraph is moved; the other end and anything outside `root` are left alone.
 */
export function pullSelectionIntoParagraphs(root) {
  const ds = window.getSelection();
  if (!root || !ds || ds.isCollapsed || !ds.rangeCount) return false;
  const el = (n) => (n.nodeType === 1 ? n : n.parentElement);
  const onPage = (n) => !!n && root.contains(n) && !!el(n)?.closest(".de-pages");
  const stray = (n) => onPage(n) && !el(n).closest(".de-p");
  const { anchorNode, anchorOffset, focusNode, focusOffset } = ds;
  const a = stray(anchorNode);
  const f = stray(focusNode);
  if (a === f || !onPage(anchorNode) || !onPage(focusNode)) return false; // both fine, or both stray: nothing to anchor a paragraph to
  const bad = a ? anchorNode : focusNode;
  const body = [...root.querySelectorAll(".de-p")].filter((p) => !p.closest(".de-hf"));
  let target = null;
  let atEnd = true;
  for (const p of body) {
    if (p.compareDocumentPosition(bad) & Node.DOCUMENT_POSITION_FOLLOWING) target = p; // the last paragraph that comes before it
  }
  if (!target) {
    target = body.find((p) => bad.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING) || null; // none before it: the first after
    atEnd = false;
  }
  if (!target) return false;
  const w = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
  let node = null;
  for (let t = w.nextNode(); t; t = w.nextNode()) {
    node = t;
    if (!atEnd) break;
  }
  if (!node) return false;
  const at = atEnd ? node.length : 0;
  if (a) ds.setBaseAndExtent(node, at, focusNode, focusOffset);
  else ds.setBaseAndExtent(anchorNode, anchorOffset, node, at);
  return true;
}
