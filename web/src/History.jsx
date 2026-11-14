import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, store } from "./lib.js";
import { Icon } from "./Icons.jsx";
import { ChangeNote } from "./ChangeNote.jsx";
import { PLACES_FIRST, countText, kindOf, placeView, rowTitle, timeText } from "./history-view.js";
import { TrackedExport } from "./TrackedExport.jsx";
import { Nodes } from "./DiffNodes.jsx";

// The History section of the review panel: the last 20 updates to the file, one line each, one open at a time. A view only: it never
// writes the file, and red and green live here, never in the document. "Show" scrolls the document and outlines the place for a moment.

const COLLAPSE_KEY = "onionskin.histCollapsed";

function Cell({ c }) {
  return c.formula ? <code>{c.formula}</code> : <span>{c.text || "(empty)"}</span>;
}

function Change({ place }) {
  const v = placeView(place);
  if (v.kind === "diff")
    return (
      <p className="h-diff" data-testid="history-diff">
        <Nodes nodes={v.nodes} />
        {v.truncated && <span className="h-gap"> …</span>}
      </p>
    );
  if (v.kind === "cell")
    return (
      <p className="h-diff h-cell" data-testid="history-cell">
        <del>
          <span className="sr-only">Removed: </span>
          <Cell c={v.before} />
        </del>
        <Icon name="arrow" size={12} />
        <ins>
          <span className="sr-only">Added: </span>
          <Cell c={v.after} />
        </ins>
        {v.after.formula && v.after.text && <span className="h-val">value {v.after.text}</span>}
      </p>
    );
  return (
    <p className="h-line" data-testid="history-line">
      {v.line}
    </p>
  );
}

/** The agent's own summary: two lines, then "more". */
function Summary({ text }) {
  const [all, setAll] = useState(false);
  const [clipped, setClipped] = useState(false);
  const ref = useRef(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && !all) setClipped(el.scrollHeight > el.clientHeight + 1);
  }, [text, all]);
  if (!text) return null;
  return (
    <div className="h-sum">
      <p ref={ref} className={all ? "" : "clamp"} data-testid="history-summary">
        {text}
      </p>
      {clipped && !all && (
        <button type="button" className="h-link" onClick={() => setAll(true)}>
          more
        </button>
      )}
    </div>
  );
}

function Places({ detail, canShow, onShow }) {
  const [all, setAll] = useState(false);
  const places = detail.places;
  const shown = all ? places : places.slice(0, PLACES_FIRST);
  const hidden = places.length - shown.length;
  return (
    <>
      {places.length === 0 && <p className="h-line">{detail.unavailable ? "This update could not be compared." : "No places changed."}</p>}
      {places.length > 0 && !detail.after_is_current && (
        <p className="h-line h-stale" data-testid="history-stale">
          The file has changed since this update, so its places cannot be shown in the document.
        </p>
      )}
      <ul className="h-places">
        {shown.map((p, i) => {
          const located = !!p.locator && p.change !== "removed";
          const can = located && detail.after_is_current && canShow(p);
          return (
            <li key={i} className="h-place" data-testid="history-place" data-change={p.change}>
              <div className="h-lab">
                <span className="h-label" title={p.label}>
                  {p.protected && <Icon name="lock" size={11} />}
                  {p.label}
                </span>
                {can && (
                  <button type="button" className="h-link" data-testid="history-show" onClick={() => onShow(p)} aria-label={`Show ${p.label} in the document`}>
                    Show
                  </button>
                )}
              </div>
              <Change place={p} />
              {located && !can && detail.after_is_current && <p className="h-line h-stale">This place has changed since.</p>}
            </li>
          );
        })}
      </ul>
      {hidden > 0 && (
        <button type="button" className="h-link h-more" data-testid="history-more" onClick={() => setAll(true)}>
          Show {hidden} more
        </button>
      )}
      {hidden === 0 && detail.more > 0 && (
        <p className="h-line" data-testid="history-notshown">
          and {detail.more} more not shown
        </p>
      )}
    </>
  );
}

export function History({ sid, refreshKey, canShow, onShow, fileName }) {
  const [list, setList] = useState(null); // {updates} | null (not loaded) | {error: true}
  const [openId, setOpenId] = useState(null);
  const [details, setDetails] = useState({}); // id -> detail | {error: true}
  const [collapsed, setCollapsedState] = useState(() => store.get("sessionStorage", COLLAPSE_KEY) !== "0") // folded until asked for: it sits above the stack;
  const listSeq = useRef(0);
  const openRef = useRef(null);
  openRef.current = openId;
  const listEl = useRef(null);

  const setCollapsed = (c) => {
    store.set("sessionStorage", COLLAPSE_KEY, c ? "1" : "0");
    setCollapsedState(c);
  };

  const loadDetail = useCallback(
    (id) => {
      api(`/api/history/${encodeURIComponent(id)}?s=${sid}`)
        .then((d) => setDetails((m) => ({ ...m, [id]: d })))
        .catch((e) => setDetails((m) => (m[id] && !m[id].error ? m : { ...m, [id]: { error: true, gone: e.status === 404 } })));
    },
    [sid]
  );

  // The list is refreshed whenever the session changes (Send, done, revert, reload of an outside change). An open entry stays open
  // unless it disappeared; its detail is fetched again quietly (it was computed for a version that may not be the current one any more).
  useEffect(() => {
    const n = ++listSeq.current;
    api(`/api/history?s=${sid}`)
      .then((r) => {
        if (n !== listSeq.current) return;
        setList({ updates: r.updates || [] });
        const cur = openRef.current;
        if (cur && !(r.updates || []).some((u) => u.id === cur)) setOpenId(null);
        else if (cur) loadDetail(cur);
      })
      .catch(() => n === listSeq.current && setList((l) => (l && !l.error ? l : { error: true })));
  }, [sid, refreshKey, loadDetail]);

  const toggle = (id) => {
    if (openId === id) return setOpenId(null);
    setOpenId(id);
    if (!details[id] || details[id].error) loadDetail(id);
  };

  const onKey = (e) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key) || !e.target.classList?.contains("h-row")) return;
    const rows = [...(listEl.current?.querySelectorAll(".h-row") || [])];
    const at = rows.indexOf(e.target);
    const next = e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1 : Math.min(rows.length - 1, Math.max(0, at + (e.key === "ArrowDown" ? 1 : -1)));
    e.preventDefault();
    rows[next]?.focus();
  };

  const updates = list?.updates || [];
  const now = new Date();
  return (
    <section className="sec hist" data-testid="panel-history" aria-labelledby="h-history" data-collapsed={collapsed ? "1" : "0"}>
      <div className="sec-h">
        <h3 id="h-history">
          History
          <span className="count h-hint">last 20</span>
        </h3>
        <ChangeNote sid={sid} fileName={fileName} refreshKey={refreshKey} onOpen={() => setCollapsed(false)} />
        <button type="button" className="iconbtn sm" data-testid="history-collapse" aria-expanded={!collapsed} aria-controls="history-body" aria-label={collapsed ? "Show History" : "Hide History"} title={collapsed ? "Show History" : "Hide History"} onClick={() => setCollapsed(!collapsed)}>
          <Icon name="chev" size={14} className={collapsed ? "" : "h-down"} />
        </button>
      </div>
      <div id="history-body" hidden={collapsed}>
        {list?.error && <p className="empty">History is not available right now.</p>}
        {list && !list.error && updates.length === 0 && <p className="empty">Updates to this file will appear here.</p>}
        {updates.length > 0 && (
          <ul className="h-list" ref={listEl} onKeyDown={onKey} data-testid="history-list">
            {updates.map((u) => {
              const k = kindOf(u.kind);
              const open = openId === u.id;
              const n = countText(u.counts);
              const d = details[u.id];
              return (
                <li key={u.id} className="h-item" data-open={open ? "1" : "0"}>
                  <button type="button" className="h-row" id={`hr-${u.id}`} data-testid="history-row" data-kind={u.kind} data-id={u.id} aria-expanded={open} aria-controls={`hb-${u.id}`} onClick={() => toggle(u.id)}>
                    <Icon name="chev" size={12} className={`h-chev ${open ? "h-down" : ""}`} />
                    <span className={`h-badge k-${u.kind}`} aria-hidden="true">
                      {k.mark}
                    </span>
                    <span className="h-title">{rowTitle(u)}</span>
                    {n && (
                      <span className="h-count" data-testid="history-count">
                        {n}
                      </span>
                    )}
                    <time className="h-time" dateTime={u.at} title={new Date(u.at).toLocaleString()}>
                      {timeText(u.at, now)}
                    </time>
                  </button>
                  {open && (
                    <div className="h-body" id={`hb-${u.id}`} role="region" aria-labelledby={`hr-${u.id}`} data-testid="history-body">
                      {!d && (
                        <div className="shimmer" data-testid="history-loading" role="status" aria-label="Loading this update">
                          <i />
                        </div>
                      )}
                      {d?.error && <p className="h-line">{d.gone ? "This update is no longer stored." : "This update could not be loaded."}</p>}
                      {d && !d.error && (
                        <>
                          <Summary text={d.summary} />
                          <Places detail={d} canShow={canShow} onShow={onShow} />
                          {(u.kind === "agent" || u.kind === "local") && d.format === "docx" && d.after_is_current && <TrackedExport sid={sid} id={u.id} />}
                        </>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
