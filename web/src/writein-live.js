// "Changes shown in place" in the page (milestone 3, idea 6a). The refresh after an agent run still happens underneath, as before: the
// new file is opened and the reader is put back where they were. Once it is up at the exact same place, this draws the agent's changed
// words in place on the overlay (a cover in the page's color wipes away over the new words, a "Was:" chip shows the old ones, then a
// green tint fades). It never types into the engine, never scrolls, never moves focus or the selection: it only reads the rendered page
// and the engine's rectsFor / hitTest, and draws over it.
//
// The safety decisions are the pure gate in writein.js (planWriteIn, locateChanges), used as is. This file feeds it what the page knows
// and adds the checks only the page can make:
//   - the paragraph at the place's block index (App's historyLoc) is the only rendered paragraph whose text hashes to the place's
//     text_hash (a twin with the same text refuses: the place could be either);
//   - the paragraph is in view when the plan is made (at most WRITEIN.maxShown places);
//   - the engine's rectangles lie inside that paragraph, and hitTest at the first one returns text in this paragraph, overlapping the range
//     (and, when the engine reports the word, the same word the page text has there).
// Anything else ends it at once, and the places fall back to today's fading outline: typing (in the document or anywhere on the page),
// scrolling (the scroller moved, a wheel or a touch move), a Send, a new refresh, the tab hidden, the view resized, or an error.
// A place that fails its own check keeps the outline; the others go on.
//
// Untrusted text: the old words come from History (sanitized on the server) and are only ever rendered by React as text, cut to
// WRITEIN.wasChars. The overlay root carries data-writein (what the newest refresh did, a short code) for tests; it is never shown.
import { nfc } from "../../src/nfc.js";
import { api } from "./lib.js";
import { WRITEIN, locateChanges, planWriteIn, sha256hex } from "./writein.js";

const normTxt = (t) => String(t || "").replace(/\s+/g, " ").trim();
const hashOf = (t) => sha256hex(nfc(t || "").replace(/\s+/g, " ").trim()).slice(0, 16); // as locateChanges (src/text.js textHash)
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const scroller = () => document.querySelector('[data-testid="docwrap"] .de-scroll') || document.querySelector(".de-scroll");
const TOL = 2; // px: a rectangle may stick out of its paragraph's box by this much (rounding) and still count as inside
const LIVE_MS = WRITEIN.wipeMs + WRITEIN.tintMs; // cover and chip are gone by then; the tint ends with it
const STILL_MS = 2000; // reduced motion: no wipe, no fade; the still tint and chip stay this long (as REDUCED_FRESH_MS in App.jsx)

/** The fields of the newest activity entry the gate reads (gateOpen in writein.js). */
const newestOf = (session) => {
  const a = session?.activity?.[0];
  return a ? { kind: a.kind, reverted: a.reverted, revertRecommended: a.revertRecommended, flags: a.flags } : null;
};

/**
 * One controller per page. `get()` returns what the page knows now: {host, session, readOnly, dirty, seq, sending, box, locOf} (box: the
 * overlay's client rectangle; locOf: App's historyLoc). `redraw()` schedules an overlay pass.
 */
export function createWriteIn({ sid, get, redraw }) {
  let st = null; // the newest refresh: {snap, detail, detailAt, upAt, exact, host, places, ended, say}
  let last = "idle";
  let n = 0; // refreshes begun: tests wait for the state of their own refresh
  let offs = [];
  let timer = null;

  const unlisten = () => {
    offs.forEach((f) => f());
    offs = [];
    clearTimeout(timer);
    timer = null;
  };
  /** Stop drawing now. "done" keeps the places out of the outline (they were shown); any other reason gives them the outline back. */
  function end(why) {
    if (!st || st.ended) return;
    st.ended = why;
    last = why;
    unlisten();
    redraw();
  }
  const on = (target, type, fn) => {
    target.addEventListener(type, fn, true);
    offs.push(() => target.removeEventListener(type, fn, true));
  };

  /** Both halves are in (the document is up, the detail arrived): ask the gate, then find the places in the rendered page. */
  function tryPlan(cur) {
    if (cur !== st || cur.ended || cur.places || cur.upAt == null || cur.detailAt == null) return;
    try {
      const now = get();
      const h = now.host;
      const gates = {
        format: h?.format,
        newest: newestOf(now.session),
        readOnly: now.readOnly,
        merged: cur.snap.merged,
        dirtyAtStart: cur.snap.dirty,
        exact: cur.exact,
        visible: document.visibilityState === "visible",
        reducedMotion: reducedMotion(),
        edited: now.seq !== cur.snap.seq || now.dirty !== false,
        sending: now.sending,
        runAtStart: cur.snap.run,
        runNow: now.session?.activity?.[0]?.id ?? null,
        docUpAt: cur.upAt,
        detailAt: cur.detailAt,
      };
      const plan = planWriteIn(cur.detail, gates);
      if (!plan.go) return stop(cur, plan.why);
      const box = now.box;
      const sc = scroller();
      if (!h || h !== cur.host || !box || !sc) return stop(cur, "no-page");
      const places = [];
      const byHash = new Map(); // every rendered paragraph's text hash, once per plan
      for (const el of document.querySelectorAll(".de-p[data-bi]")) {
        const k = hashOf(el.textContent);
        byHash.set(k, [...(byHash.get(k) || []), el]);
      }
      for (const p of plan.places) {
        if (places.length >= WRITEIN.maxShown) break;
        const found = locate(p, box, byHash);
        if (found) places.push(found);
      }
      if (!places.length) return stop(cur, "not-located");
      cur.places = places;
      cur.box = { w: Math.round(box.width), h: Math.round(box.height) };
      cur.scrollTop = sc.scrollTop;
      const n = cur.detail.places.length;
      cur.say = n === 1 ? "The agent's changes are in. 1 place changed." : `The agent's changes are in. ${n} places changed.`;
      last = "on";
      // the person does something: stop at once
      on(window, "keydown", () => end("type"));
      on(window, "wheel", () => end("scroll"));
      on(window, "touchmove", () => end("scroll"));
      on(document, "visibilitychange", () => document.visibilityState !== "visible" && end("hidden"));
      cur.still = reducedMotion();
      timer = setTimeout(() => end("done"), cur.still ? STILL_MS : LIVE_MS);
      redraw();
    } catch {
      stop(cur, "error");
    }
  }
  /** Nothing is drawn for this refresh (it never started): say why, for the tests. */
  function stop(cur, why) {
    cur.ended = last = why;
    redraw();
  }

  /** One planned place in the rendered page: {bi, text, ranges, bg} or null (it keeps the outline). */
  function locate(p, box, byHash) {
    const loc = get().locOf({ locator: p.locator }); // historyLoc: the engine's block index for the file's body index
    const bi = loc?.blockPath?.length === 1 ? loc.blockPath[0] : null;
    if (!Number.isInteger(bi)) return null;
    const els = document.querySelectorAll(`.de-p[data-bi="${bi}"]`);
    if (els.length !== 1) return null;
    const el = els[0];
    const text = el.textContent;
    // a second rendered paragraph with the same text as the server's after text is a twin: the place could be either one, refuse
    const twins = byHash.get(p.locator.text_hash) || [];
    if (twins.length !== 1 || twins[0] !== el) return null;
    if (el.querySelector("[data-obj]")) return null;
    const r = el.getBoundingClientRect();
    if (!(r.bottom > box.top && r.top < box.bottom)) return null; // only places in view; the "changes below" pill covers the rest
    const ranges = locateChanges(text, p.changes, p.locator.text_hash);
    if (!ranges) return null;
    const page = el.closest(".de-page") || el;
    const bg = getComputedStyle(page).backgroundColor;
    return { bi, text, ranges, bg: /^rgba?\(/.test(bg) && !/,\s*0\)$/.test(bg) ? bg : null, checked: false, failed: false };
  }

  /** The engine's rectangles for one range, and whether they pass the checks (run once per place, the first time it is drawn). */
  function rangeRects(h, pl, rg, para) {
    const len = pl.text.length;
    const del = rg.start === rg.end;
    const s = del ? (rg.start < len ? rg.start : rg.start - 1) : rg.start;
    const e = del ? s + 1 : rg.end;
    if (s < 0 || e > len) return null;
    const rects = h.rectsFor({ blockPath: [pl.bi], start: s, end: e }).filter((q) => q.width > 0 && q.height > 0);
    if (!rects.length) return null;
    if (!rects.every((q) => q.left >= para.left - TOL && q.right <= para.right + TOL && q.top >= para.top - TOL && q.bottom <= para.bottom + TOL)) return null;
    if (!pl.checked) {
      const q = rects[0];
      const hit = h.hitTest((q.left + q.right) / 2, (q.top + q.bottom) / 2);
      const l = hit?.location;
      if (hit?.kind !== "text" || !l || !Array.isArray(l.blockPath) || l.blockPath.length !== 1 || l.blockPath[0] !== pl.bi) return null;
      if (!Number.isInteger(l.start) || !Number.isInteger(l.end) || !(l.start < e && l.end > s)) return null;
      if (typeof hit.quote === "string" && hit.quote && normTxt(hit.quote) !== normTxt(pl.text.slice(l.start, l.end))) return null; // the engine counts characters differently: the range would be shifted
    }
    return { rects, del };
  }

  return {
    /** A refresh after an agent run starts (reloadNow): what held when it began, and the History detail fetched alongside the file. */
    begin({ merged, dirty, seq, run }) {
      if (st && !st.ended) end("reload");
      unlisten();
      const cur = { snap: { merged: merged === true, dirty: dirty === true, seq, run }, detail: null, detailAt: null, upAt: null, exact: false, host: null, places: null, ended: null, say: null };
      st = cur;
      last = "waiting";
      n++;
      redraw();
      (async () => {
        try {
          const list = await api(`/api/history?s=${sid}`);
          const u = (list.updates || [])[0];
          cur.detail = u && u.kind === "agent" ? await api(`/api/history/${encodeURIComponent(u.id)}?s=${sid}`) : { unavailable: true };
        } catch {
          cur.detail = { unavailable: true };
        }
        cur.detailAt = Date.now();
        tryPlan(cur);
      })();
    },
    /** The new document is up and the view restore finished: `exact` is what setViewState answered (false when nothing was restored). */
    up(exact) {
      const cur = st;
      if (!cur || cur.ended || cur.upAt != null) return;
      cur.upAt = Date.now();
      cur.exact = exact === true;
      cur.host = get().host;
      tryPlan(cur);
    },
    cancel(why) {
      if (st && !st.ended) {
        if (st.places) end(why);
        else stop(st, why);
      }
    },
    /** Paragraph block indexes drawn in place now (or shown to the end): today's outline leaves them out. */
    skip() {
      const out = new Set();
      if (st?.places && (!st.ended || st.ended === "done")) for (const pl of st.places) if (!pl.failed) out.add(pl.bi);
      return out;
    },
    /** Overlay items for this frame (no time values in them: CSS runs the animation, one timer ends it). */
    paint(h, box, local) {
      const cur = st;
      if (!cur?.places || cur.ended) return { items: [], say: cur?.ended === "done" ? cur.say : null, state: last, n };
      try {
        const sc = scroller();
        if (h !== cur.host || !sc) return end("reload"), { items: [], say: null, state: last, n };
        if (sc.scrollTop !== cur.scrollTop) return end("scroll"), { items: [], say: null, state: last, n };
        if (Math.round(box.width) !== cur.box.w || Math.round(box.height) !== cur.box.h) return end("resize"), { items: [], say: null, state: last, n };
        const items = [];
        cur.places.forEach((pl, pi) => {
          if (pl.failed) return;
          const els = document.querySelectorAll(`.de-p[data-bi="${pl.bi}"]`);
          const para = els.length === 1 && els[0].textContent === pl.text ? els[0].getBoundingClientRect() : null;
          const got = para && pl.ranges.map((rg) => rangeRects(h, pl, rg, para));
          if (!got || got.some((g) => !g)) {
            pl.failed = true; // this place keeps today's outline
            return;
          }
          pl.checked = true;
          got.forEach((g, ri) => {
            const first = local(g.rects[0]);
            const was = pl.ranges[ri].was;
            if (was) items.push({ k: "was", key: `${pi}-${ri}-was`, x: first.x, y: first.y, t: was });
            if (g.del) return;
            // one line at a time: rectangles that share a top edge are one line
            const tops = [...new Set(g.rects.map((q) => Math.round(q.top)))].sort((a, b) => a - b);
            const step = Math.round(WRITEIN.wipeMs / tops.length);
            g.rects.forEach((q, qi) => {
              const line = tops.indexOf(Math.round(q.top));
              const at = local(q);
              items.push({ k: "ins", key: `${pi}-${ri}-ins-${qi}`, ...at });
              if (pl.bg && !cur.still) items.push({ k: "cover", key: `${pi}-${ri}-cover-${qi}`, ...at, bg: pl.bg, delay: line * step, dur: step });
            });
          });
        });
        if (cur.places.every((pl) => pl.failed)) return end("not-confirmed"), { items: [], say: null, state: last, n };
        return { items, say: cur.say, state: last, n };
      } catch {
        end("error");
        return { items: [], say: null, state: last, n };
      }
    },
  };
}
