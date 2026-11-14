import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { DocViewer } from "@engine";
import { Panel } from "./Panel.jsx";
import { findQuote, fromBase64, placeRanges, versionsMatch, workingPlan } from "./replay.js";

// The Try-it page: a replay of one recorded session. No server, no agent, no network: the letter's two versions and the recording are
// bundled into the page (scripts/demo/build.mjs scanned them first) and the page checks each version's SHA-256 before it shows anything.
// The engine is mounted read-only with every way in or out turned off, and only ever gets a File made from the bundled bytes (never an
// address it would fetch). Marks are drawn on an overlay above the document, never in it; nothing here scrolls the document.

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const ERROR = "This demo could not start in this browser. Try a recent Chrome, Safari or Firefox.";

/** Rectangles for a range of one paragraph, overlay-local, kept only where hitTest confirms the paragraph is what is shown there. */
function rangeRects(h, box, bi, start, end) {
  let rects = [];
  try {
    rects = h.rectsFor({ blockPath: [bi], start, end }) || [];
  } catch {
    return [];
  }
  const out = [];
  for (const r of rects) {
    if (!(r.width > 0 && r.height > 0) || r.bottom <= box.top || r.top >= box.bottom || r.right <= box.left || r.left >= box.right) continue;
    let hit = null;
    try {
      hit = h.hitTest(r.left + r.width / 2, r.top + r.height / 2);
    } catch {}
    if (hit?.location?.blockPath?.[0] !== bi) continue;
    out.push({ x: r.left - box.left, y: r.top - box.top, w: r.width, h: r.height });
  }
  return out;
}

export function Demo({ recording, v0, v1 }) {
  const [state, setState] = useState("checking"); // checking | ok | broken
  const [phase, setPhase] = useState("ready"); // ready | working | finished | reverted
  const [added, setAdded] = useState([]);
  const [marks, setMarks] = useState([]);
  const bytes = useMemo(() => {
    try {
      return { v0: fromBase64(v0), v1: fromBase64(v1) };
    } catch {
      return null;
    }
  }, [v0, v1]);
  const plan = useMemo(() => workingPlan(recording?.timing?.result_ms), [recording]);
  const hostRef = useRef(null);
  const docRef = useRef(null);
  const overlayRef = useRef(null);
  const timer = useRef(null);
  const frame = useRef(0);
  const live = useRef({ phase, added });
  live.current = { phase, added };

  useEffect(() => {
    let gone = false;
    const digest = (b) => crypto.subtle.digest("SHA-256", b);
    (bytes ? versionsMatch(recording, bytes.v0, bytes.v1, digest) : Promise.resolve(false)).then((ok) => !gone && setState(ok ? "ok" : "broken"));
    return () => {
      gone = true;
    };
  }, [recording, bytes]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const files = useMemo(() => (state === "ok" ? { v0: new File([bytes.v0], "welcome.docx", { type: DOCX }), v1: new File([bytes.v1], "welcome.docx", { type: DOCX }) } : null), [state, bytes]);
  const shown = phase === "finished" ? "v1" : "v0";

  // ---- overlay: the added comments' places on v0, the agent's new words on v1 ------------------------------------------------------
  const draw = useCallback(() => {
    frame.current = 0;
    const h = hostRef.current;
    const box = overlayRef.current?.getBoundingClientRect();
    if (!h || !box || !docRef.current) return setMarks((m) => (m.length ? [] : m));
    const paras = Array.from(docRef.current.querySelectorAll(".de-p[data-bi]"), (el) => ({ bi: Number(el.getAttribute("data-bi")), text: el.textContent || "" })).filter((p) => Number.isInteger(p.bi));
    const next = [];
    const { phase: ph, added: on } = live.current;
    if (ph === "ready" || ph === "working") {
      for (const c of recording.comments) {
        if (!on.includes(c.n)) continue;
        const at = findQuote(paras, c.quote);
        if (!at) continue;
        rangeRects(h, box, at.bi, at.start, at.end).forEach((r, i) => next.push({ kind: "spot", n: i === 0 ? c.n : null, ...r }));
      }
    } else if (ph === "finished") {
      for (const p of recording.places) {
        const at = placeRanges(paras, p);
        if (!at) continue;
        for (const g of at.ranges) if (g.end > g.start) rangeRects(h, box, at.bi, g.start, g.end).forEach((r) => next.push({ kind: "ins", n: null, ...r }));
      }
    }
    setMarks((m) => (JSON.stringify(m) === JSON.stringify(next) ? m : next));
  }, [recording]);
  const redraw = useCallback(() => {
    if (!frame.current) frame.current = requestAnimationFrame(draw);
  }, [draw]);
  useLayoutEffect(redraw, [phase, added, redraw]);
  useEffect(() => {
    const el = docRef.current;
    if (!el) return;
    const mo = new MutationObserver(redraw);
    // a zoom change (the letter fitting a narrow window) moves the words by style, not by new nodes: watch those too
    mo.observe(el, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["style", "class"] });
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(redraw) : null;
    ro?.observe(el);
    el.addEventListener("scroll", redraw, { capture: true, passive: true });
    window.addEventListener("resize", redraw);
    return () => {
      mo.disconnect();
      ro?.disconnect();
      el.removeEventListener("scroll", redraw, { capture: true });
      window.removeEventListener("resize", redraw);
      cancelAnimationFrame(frame.current);
      frame.current = 0;
    };
  }, [state, redraw]);

  const onHost = useCallback(
    (h) => {
      hostRef.current = h || null;
      if (h) h.setReadOnly(true);
      redraw();
    },
    [redraw],
  );

  const onSend = () => {
    if (added.length !== recording.comments.length || phase !== "ready") return;
    setPhase("working");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setPhase("finished"), plan.ms);
  };
  const onRevert = () => setPhase("reverted");
  const onStartOver = () => {
    setAdded([]);
    setPhase("ready");
  };

  if (state === "broken")
    return (
      <div className="app demo">
        <Banner />
        <p className="demo-error" role="alert" data-testid="demo-error">
          {ERROR}
        </p>
      </div>
    );

  return (
    <div className="app demo">
      <Banner />
      <main className="demo-main">
        <div className="demo-doc" ref={docRef} data-testid="demo-doc" data-shown={shown}>
          {files && (
            <DocViewer
              key={shown}
              src={files[shown]}
              name="welcome.docx"
              editable={false}
              allowEdit={false}
              toolbar={false}
              comments={false}
              allowOpen={false}
              fileMenu={false}
              allowSave={false}
              allowDownload={false}
              zoom="fit"
              style={{ height: "100%" }}
              onHost={onHost}
              onError={() => setState("broken")}
            />
          )}
          <div className="demo-overlay" ref={overlayRef} aria-hidden="true" data-testid="demo-overlay">
            {marks.map((m, i) => (
              <div key={i} className={`demo-mark ${m.kind}`} data-testid={`mark-${m.kind}`} style={{ left: m.x, top: m.y, width: m.w, height: m.h }}>
                {m.n != null && <span className="demo-mark-n">{m.n}</span>}
              </div>
            ))}
          </div>
        </div>
        {state === "ok" && <Panel recording={recording} phase={phase} added={added} plan={plan} onAdd={(n) => setAdded((a) => (a.includes(n) ? a : [...a, n]))} onSend={onSend} onRevert={onRevert} onStartOver={onStartOver} />}
      </main>
      <footer className="demo-foot">Onionskin runs on your own Mac. This page is only a replay.</footer>
    </div>
  );
}

function Banner() {
  return (
    <p className="demo-banner" role="note" data-testid="demo-banner">
      This is a replay of one real session. No AI is running here, and nothing you do leaves this page.
    </p>
  );
}
