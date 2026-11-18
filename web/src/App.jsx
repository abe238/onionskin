import React, { useCallback, useEffect, useRef, useState } from "react";
import { DocViewer, hashText } from "@engine";
import { SEND_MS, TAB, api, blobToBase64, coalesce, getToken, labelFor, locFromResolved, paragraphText, parseA1, pullSelectionIntoParagraphs, rangeHasCell, uid, unionRange, verifyBlock } from "./lib.js";
import { catchUpPlan, newestRun, retryDelay } from "./catchup.js";
import { mark, measure } from "./marks.js";
import { Drafts } from "./drafts.js";
import { useFrame, useMedia, useSidebar, useTheme, useVisualViewport } from "./hooks.js";
import { Sidebar } from "./Sidebar.jsx";
import { Dock, TopBar, Toolbar } from "./Chrome.jsx";
import { Backdrop } from "./Backdrop.jsx";
import { BackgroundPicker } from "./BackgroundPicker.jsx";
import { useBackground } from "./background.js";
import { Banners } from "./Banners.jsx";
import { AgentPanel } from "./AgentPanel.jsx";
import { Overlay } from "./Overlay.jsx";
import { useQuickPreview } from "./QuickChange.jsx";
import { placeChip, textUnder } from "./chip-place.js";
import { noteAlone, ridesAlong } from "./quick-send.js";
import { COMMENTS_MAX, TOO_MANY_COMMENTS } from "../../src/retain.js"; // pure, no imports: the server refuses the 501st comment in the same words
import { useStamps } from "./Stamps.jsx";
import { BUILT_IN, needsOneSentence, selectionShape, suggestEligible } from "./stamps.js";
import { AHEAD_MS, NONE_WORDS, aheadKey, cardFor, reusableAhead, useRefusal } from "./suggest.js";
import { MOD, isEditable, isQuickAsk } from "./keys.js";
import { createWriteIn } from "./writein-live.js";
import { HtmlHost } from "./HtmlHost.jsx";
import { fetchHtmlView, htmlLocFromResolved, htmlMarks, stamped } from "./html-host.js";

const FRESH_MS = 5000;
const SLOW_MS = 300; // a Send's "Sending..." shows only past this: the usual one (15 to 80 ms) does not flicker
const PILL_MS = 20_000; // how long the "changes below / above" pill may stay
const REDUCED_FRESH_MS = 2000; // reduced motion: a still outline for about two seconds instead of the fading pulse
const BUSY_WORDS = "Wait a moment: what you just pressed is still on its way. Then try again.";
const LOST_MS = 10_000; // a stream with errors and no open this long: the server is gone (see the server events effect)
const LOST_TEXT = "Onionskin on this Mac is not answering. Your comments and note are still here and the page keeps trying: if it does not come back, copy them, then open the file again.";
const plain = (e) => (/failed to fetch|networkerror|load failed/i.test(e.message) ? "Could not reach the Onionskin server. Your edits are still in this page, so try again in a moment." : e.message); // how long changed regions stay highlighted after an agent run lands

export default function App({ sid, initial, product, settings, suggest }) {
  const [session, setSession] = useState(initial);
  const [comments, setComments] = useState(initial.comments || []);
  const [note, setNote] = useState(initial.note || "");
  const [changes, setChanges] = useState([]);
  const [mode, setMode] = useState("edit"); // edit | comment | pin
  const [doc, setDoc] = useState({ file: null, v: 0 });
  const [bar, setBar] = useState(null);
  const [hostTick, setHostTick] = useState(0);
  const [resolved, setResolved] = useState({}); // comment id -> {method, text, loc|null}
  const [paint, setPaint] = useState({ items: [], chip: null }); // overlay drawings, in overlay-local pixels
  const [chipSel, setChipSel] = useState(null);
  const [focusId, setFocusId] = useState(null);
  const [sending, setSending] = useState(false); // a Send is in flight (the button's data-busy); `slow` shows it, after SLOW_MS
  const [slow, setSlow] = useState(false);
  // while a Send is in flight: the drafts it carried (ids) and whether it carried the note. Those stay as sent until the answer: read only
  // in the page, and no autosave goes out meanwhile (the server applies a save after the Send anyway, src/session.js inTurn)
  const [held, setHeld] = useState(null);
  const [problem, setProblem] = useState(null); // {kind:'conflict'|'error', message}
  const [notice, setNotice] = useState(null); // short-lived status toast
  const [noticeAction, setNoticeAction] = useState(null);
  const [stopping, setStopping] = useState(false); // Stop was pressed and the server has not answered yet
  const [quickAgentFor, setQuickAgentFor] = useState(null); // the note the person chose to send to the agent instead of doing on this Mac
  const quickChangeRef = useRef(null); // {command, count, note, label} while the Send button shows a quick change
  const [quick, setQuick] = useState(null); // Quick ask composer: {kind, anchor, text, blocked, nudge} while open
  const [sg, setSg] = useState(null); // the quick fix card in the open Quick ask box (Suggestion.jsx), null when the stamp row shows
  const sgSeq = useRef(0); // a newer ask, Esc or a closed box makes an older answer drop
  const aheadRef = useRef(null); // {key, at, answer}: Fix grammar asked for when the Quick ask box opened (askAhead); never shown before the tap
  const suggestingRef = useRef(null); // the POST /api/suggest still running: the next one waits for it (the server takes one per file)
  const [suggestOn, setSuggestOn] = useState(!!suggest?.on && !suggest?.unavailable); // quick fixes are on and Apple's model can answer now (when it cannot, the tap goes to the agent as before)
  const [keysOpen, setKeysOpen] = useState(false); // the keyboard shortcuts popover
  const [heldBack, setHeldBack] = useState(null); // edits made while the agent worked that were not merged, or were merged with something to check: [{label, text, why, check}]
  const [heldCopy, setHeldCopy] = useState(null); // the name of the copy of the user's file the server kept with them, if any
  const [closeAsk, setCloseAsk] = useState(false); // Close session was pressed with unsent document edits
  // HTML (HtmlHost.jsx): the person's pending text edits live in the viewer (R9), counted here
  const [htmlEdits, setHtmlEdits] = useState(0);
  const htmlEditsRef = useRef(0);
  htmlEditsRef.current = htmlEdits;
  const [fresh, setFresh] = useState(false); // an agent run just landed: highlight what it touched, then fade
  const [theme, setTheme] = useTheme();
  const side = useSidebar();
  const narrow = useMedia("(max-width: 1099px)");
  const phone = useMedia("(max-width: 719px)");
  const phoneAtMount = useRef(phone).current; // zoom is an initial viewer setting: read it once
  useVisualViewport(phone);
  const [drawer, setDrawer] = useState(false);
  const sideOpen = narrow ? drawer : !side.collapsed;
  const bgc = useBackground(settings, { theme, layoutKey: `${phone}${narrow}${sideOpen}${side.width}` });
  const [bgOpen, setBgOpen] = useState(false);
  // Only one tab per file may edit: another tab holds it when the server names a different editor. This tab then looks but does not change anything.
  const ro = !!session.editor && session.editor !== TAB;
  const roRef = useRef(ro);
  roRef.current = ro;

  const hostRef = useRef(null);
  const docRef = useRef(null);
  const overlayRef = useRef(null);
  const sessionRef = useRef(session);
  const commentsRef = useRef(comments);
  const sendingRef = useRef(false); // true while a Send is in flight (send() reads it, not the state, so a retry in the same tick sees it)
  const sendAgainRef = useRef(false); // a Quick ask landed during a Send: send again when that one finishes
  const sendFnRef = useRef(null);
  const noteRef = useRef(note);
  const changesRef = useRef(changes);
  const resolvedRef = useRef(resolved);
  const chipSelRef = useRef(chipSel);
  const dirtyRef = useRef(false);
  const loadedShaRef = useRef(initial.baseSha);
  const editSeq = useRef(0); // counts edit events: tells "nothing was typed since" apart from "more was typed"
  const mergeDue = useRef(false); // the file changed under edits this page still holds: merge them before anything else reloads or sends
  const merging = useRef(false);
  const mergeHeldRef = useRef(null);
  const reloadNowRef = useRef(null);
  const restoreRef = useRef(false);
  const retries = useRef(0); // refreshes that failed in a row
  const retryTimer = useRef(null);
  const retryLaterRef = useRef(null);
  const syncedShaRef = useRef(initial.baseSha); // the session's version of the file this page last caught up with (see catchup.js)
  const syncedRunRef = useRef(newestRun(initial)); // ... and the newest run it had then
  const wantShaRef = useRef(null); // the version of the file a refresh was last started for (a state event for it is not a second refresh)
  const hereRef = useRef(null); // the view just before a refresh (getViewState of the document being replaced)
  const sentViewRef = useRef(null); // the view that went out with the last Send: the server keeps a durable anchor for it
  const offsRef = useRef([]);
  const infoRef = useRef({ slides: null, sheets: null }); // from /api/resolve: current slide ids / sheet ids
  const dragRef = useRef(null); // XLSX range drag in Comment mode: {start: ElementAnchor, cur: ElementAnchor}
  const freshRef = useRef(false);
  const showRef = useRef(null); // History's "Show": {loc} while the place is outlined (about two seconds)
  const showTimer = useRef(null);
  const deltaRef = useRef({ v: -1, d: 0 }); // DOCX: the engine's block index minus the file's body index, learned from a rendered paragraph (per loaded file)
  const [activeSheet, setActiveSheet] = useState(null);
  const saveTimer = useRef(null);
  const draftPendingRef = useRef(false); // a comment or note edit is waiting for its autosave
  // every draft save and Send is numbered: the server ignores a save the same tab sent before a newer one (an autosave sent just before
  // Send was pressed and landing after it would put the note back in the box)
  const revRef = useRef(0);
  const heldRef = useRef(null); // `held`, read by the handlers (a keystroke can land before the next render)
  // the revisions of the comments and the note, and what each request was sent with: server state goes into them only through
  // applyServer (web/src/drafts.js reconcile), which never replaces words typed here with words not based on them
  const draftsRef = useRef(null);
  if (!draftsRef.current) {
    draftsRef.current = new Drafts();
    draftsRef.current.loaded(initial.note, initial.comments || [], initial.seq ?? -1);
  }
  // Take back, Stop, Revert or Close in flight: no Send meanwhile, and the note is read only (their answer rewrites it), as during a Send
  const rewritingRef = useRef(0);
  const [rewriting, setRewriting] = useState(false);
  const outRef = useRef(0); // ... and its request is out (sent, not answered yet): saves leave the note out meanwhile
  const rewrite = (d) => {
    rewritingRef.current += d;
    setRewriting(rewritingRef.current > 0);
  };
  const savingRef = useRef(null); // the draft save in flight (a promise), so Take back, Stop, Revert and Close wait for it
  const applyRef = useRef(null); // applyServer, for the event stream's handlers
  const sentWaitRef = useRef(null);
  const handingRef = useRef(null); // null | "waiting" (for its Send) | "sending" | "failed": this tab lost editing with unsaved words (handOver) // {rev, resolve}: the Send in flight, settled by server state that shows it committed (applyServer)
  const mergeRef = useRef(null); // the event stream's merge: the answer of a Send is reconciled the same way, whichever arrives first
  const noticeTimer = useRef(null);
  const freshTimer = useRef(null);
  const quickRef = useRef(null);
  const sentChipRef = useRef(null); // the Quick ask comment whose Send waits for the one in flight: it gets its "Sent" chip when that goes through
  const loadPlacesRef = useRef(false); // an agent run landed: fetch its places once the new file is up
  const historyLocRef = useRef(null);
  const peekTimer = useRef(null);
  const awayRef = useRef(null); // {loc}: where the "changes below / above" pill jumps
  const quickBackRef = useRef(null); // where focus and the selection were when Quick ask opened
  const backDueRef = useRef(null); // a Quick ask box closed with the focus to come back on the next frame: {loc}, its words
  const quietRef = useRef({ until: 0, quote: null }); // right after a Quick ask the restored selection gets no comment chip
  const returnRef = useRef(null); // where the user was in the document when an agent run landed
  const placesRef = useRef({ list: [], until: 0, run: null }); // engine locations of the places the last agent run changed
  const modeRef = useRef(mode);
  const wiRef = useRef(null); // "changes shown in place" after an agent run (writein-live.js)
  sessionRef.current = session;
  commentsRef.current = comments;
  noteRef.current = note;
  changesRef.current = changes;
  resolvedRef.current = resolved;
  chipSelRef.current = chipSel;
  modeRef.current = mode;
  quickRef.current = quick;
  const stampsCtl = useStamps();
  freshRef.current = fresh;

  const say = useCallback((text, action = null) => {
    setNotice(text);
    setNoticeAction(action); // {label, ariaLabel, onClick}: a button in the same message (it stays longer, so it can be reached)
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => (setNotice(null), setNoticeAction(null)), action ? 10000 : 4500);
  }, []);

  // ---- file loading ----------------------------------------------------------------------------------------
  const loadFile = useCallback(async ({ plain = false } = {}) => {
    // Every refresh keeps the reader where they are NOW (never the top, never where they were at Send): the view is read from the
    // document that is about to be replaced and put back on the new one.
    const h = hostRef.current;
    if (h) {
      try {
        hereRef.current = h.getViewState();
      } catch {
        hereRef.current = null;
      }
      restoreRef.current = true;
    }
    mark("os:file-start");
    if (sessionRef.current.format === "html") {
      // an HTML file: its render copy, never its bytes (GET /api/html-view). A page that is not UTF-8 any more is shown refused, with
      // its UTF-8 copy offer; the pending text edits stay in the viewer and come along to the new version (R9)
      let v;
      try {
        v = await fetchHtmlView(sid, { plain });
      } catch (e) {
        if (e.code !== "not_utf8" && e.code !== "encoding") throw e;
        return setDoc((d) => ({ file: null, html: { error: e }, v: d.v + 1 }));
      }
      mark("os:file-fetched");
      loadedShaRef.current = v.version;
      return setDoc((d) => ({ file: null, html: { ...v, forced: plain }, v: d.v + 1 }));
    }
    const { buf, sha } = await api(`/api/file?s=${sid}`, { raw: true, timeout: SEND_MS });
    mark("os:file-fetched");
    measure("os:file-fetch", "os:file-start", "os:file-fetched");
    loadedShaRef.current = sha;
    dirtyRef.current = false;
    setChanges([]);
    setDoc((d) => ({ file: new File([buf], sessionRef.current.name), v: d.v + 1 }));
  }, [sid]);

  useEffect(() => {
    loadFile().catch((e) => setProblem({ kind: "error", message: `Could not load the file: ${e.message}` }));
  }, [loadFile]);

  // ---- early check: did someone change the file outside Onionskin? ------------------------------------------------
  // When the tab regains focus, and at most every 30 s while it is visible, ask the server whether the disk still holds the version this page loaded.
  const lastStale = useRef(0);
  // The server's watcher (src/watch.js) pushes a state event with changedOutside when the disk holds a version Onionskin does not know. The notice is
  // raised when that event arrives (see onState), never drawn from the field: the field can still say true after the page took the new version.
  const outsideSeen = useRef(false);
  useEffect(() => {
    const check = async (min) => {
      if (document.visibilityState !== "visible" || roRef.current || sessionRef.current.locked || sessionRef.current.state === "closed") return;
      if (Date.now() - lastStale.current < min) return;
      lastStale.current = Date.now();
      try {
        const r = await api(`/api/stale?s=${sid}&sha=${encodeURIComponent(loadedShaRef.current || "")}`);
        if (r.stale) setProblem((p) => (p && p.kind !== "outside" ? p : { kind: "outside" }));
      } catch {
        /* the event stream shows connection trouble; this check is only a hint */
      }
    };
    const onFocus = () => check(1500);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    const timer = setInterval(() => check(29_000), 30_000);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      clearInterval(timer);
    };
  }, [sid]);

  // ---- server events ---------------------------------------------------------------------------------------
  useEffect(() => {
    // The browser reconnects the stream by itself after a network error. A stream it gave up on (closed for good) is opened again
    // here: after its error (soon, then slowly, then no more: a server that refuses this tab is not asked forever), when the browser
    // is back online and when the tab is looked at again. Without this the page would stay on "Agent working" forever.
    // A server that is gone (stopped, crashed, upgraded) refuses the connection, and then the browser keeps the stream CONNECTING and retries by
    // itself forever: the CLOSED path below never runs. So a stream that has had errors and no open for LOST_MS says so too, whatever its state.
    // A short drop (laptop wake, one lost connection) reopens well within that time and shows nothing. Until the next open it is said again every
    // LOST_MS: a failed Send or save meanwhile replaces it with a plain error, and that would hide Copy my comments exactly when it is needed.
    let es = null;
    let streamTries = 0;
    let streamTimer = null;
    let lostTimer = null; // set at the first error after an open, cleared by the next open
    const lost = () => {
      setProblem((p) => (!p || (p.kind === "error" && !p.stream) ? { kind: "error", stream: true, message: LOST_TEXT } : p)); // an outside change or a conflict stays
      lostTimer = setTimeout(lost, LOST_MS);
    };
    const connect = () => {
      es?.close();
      es = new EventSource(`/api/events?s=${sid}&tab=${TAB}&t=${encodeURIComponent(getToken())}`);
      es.addEventListener("state", (e) => onState(JSON.parse(e.data)));
      es.addEventListener("reload", (e) => onReload(JSON.parse(e.data)));
      es.onopen = () => {
        streamTries = 0;
        clearTimeout(lostTimer);
        lostTimer = null;
        setProblem((p) => (p?.stream ? null : p)); // the stream is back: its "Connection lost" message goes
      };
      es.onerror = () => {
        lostTimer ??= setTimeout(lost, LOST_MS);
        if (es?.readyState !== EventSource.CLOSED) return; // the browser is reconnecting by itself
        const ms = retryDelay(streamTries++);
        clearTimeout(streamTimer);
        if (ms != null) streamTimer = setTimeout(ensureStream, ms);
        else {
          clearTimeout(lostTimer);
          lost(); // all retries used: say it now
        }
      };
    };
    const ensureStream = () => {
      if (es && es.readyState === EventSource.CLOSED && sessionRef.current.state !== "closed") connect();
    };
    // `at`: what the request this state answers was sent with (a Send's answer); none for an event
    const merge = (view, at = null) => {
      setSession(view);
      const roNext = !!view.editor && view.editor !== TAB;
      // this tab just lost editing ("Edit here instead" in another) holding words no save has confirmed: they are handed over to the server
      // first (POST /api/handover), and stay on screen until that went through; if it cannot, they stay, with Copy my comments
      if (roNext && !roRef.current && !handingRef.current && draftsRef.current.dirty(commentsRef.current)) {
        if (!sendingRef.current) return handOver();
        handingRef.current = "waiting"; // a Send of this tab is in flight: what it carries is its own; the rest is handed over once it is done
        return;
      }
      if (handingRef.current && !(!roNext && roRef.current)) return; // handing over, or it failed: the words stay as they are
      if (!roNext && roRef.current && handingRef.current) {
        // editing again with words that were never handed over: they stay, and the next autosave carries them
        handingRef.current = null;
        setProblem((p) => (p?.handover ? null : p));
        applyRef.current(view);
        return loadFile().catch((err) => setProblem({ kind: "error", message: `Could not reload: ${err.message}` }));
      }
      if (roNext || roRef.current) {
        // a read-only tab shows what the editing tab saved; one that just took over starts from it and reloads the file
        applyRef.current(view, null, { wholesale: true });
        if (!roNext && roRef.current) loadFile().catch((err) => setProblem({ kind: "error", message: `Could not reload: ${err.message}` }));
        return;
      }
      applyRef.current(view, at);
    };
    mergeRef.current = merge;
    // A page that holds another version of the file than the state says missed its refresh (see catchup.js): it catches up here.
    const catchUp = (view) => {
      if (view.baseSha === syncedShaRef.current) syncedRunRef.current = newestRun(view); // in step: runs that changed nothing are seen
      const plan = catchUpPlan(view, { syncedSha: syncedShaRef.current, syncedRun: syncedRunRef.current, wantSha: wantShaRef.current, busy: sendingRef.current || merging.current || mergeDue.current, dirty: dirtyRef.current, readOnly: roRef.current });
      if (plan === "reload" || plan === "merge") onReload(view);
      return plan === "reload" || plan === "merge";
    };
    const onState = (view) => {
      // raised on arrival, also while a batch is out (a mid-run outside edit shows only here: the stale check above skips a locked page), never in a
      // read-only tab. Only on the turn from false to true: the agent's activity pushes the same flag again and again, and a closed notice stays closed.
      // A tab that is read-only still follows the flag, so taking over editing does not raise an old notice. Ceiling: the flag is a boolean, so a
      // second outside save while it is still true is not raised again here; the focus and 30 s stale check above still catch it once unlocked.
      const out = !!view.changedOutside;
      const roNow = roRef.current || (!!view.editor && view.editor !== TAB);
      if (out && !outsideSeen.current && !roNow && view.state !== "closed") setProblem((p) => (p && p.kind !== "outside" ? p : { kind: "outside" }));
      outsideSeen.current = out;
      if (catchUp(view)) return;
      merge(view);
      if (mergeDue.current) mergeHeldRef.current?.(view); // the agent let go: carry the held edits over now
    };
    const onReload = (view) => {
      wantShaRef.current = view.baseSha;
      const go = () => {
        // The user kept editing while the agent worked. Those edits are merged onto the new file first (never reloaded away).
        if (!roRef.current && dirtyRef.current) {
          mergeDue.current = true;
          merge(view);
          mergeHeldRef.current?.(view);
          return;
        }
        reloadNow(view);
      };
      // XLSX, PPTX: a cell that is still being typed (no Enter yet), or text typed a moment ago in a shape (the focus may already
      // be elsewhere), has not reported an edit. Close it first, so it counts as one. (DOCX reports every keystroke.)
      const h = hostRef.current;
      if (h && sessionRef.current.format !== "docx" && !roRef.current && !dirtyRef.current) h.flush().then(go, go);
      else go();
    };
    // A refresh or a merge that did not reach the server is tried again (soon, then slowly) and when the browser is back online.
    const retry = () => {
      ensureStream();
      const view = sessionRef.current;
      if (mergeDue.current) mergeHeldRef.current?.(view);
      else catchUp(view);
    };
    const retryLater = () => {
      const ms = retryDelay(retries.current++);
      clearTimeout(retryTimer.current);
      if (ms != null) retryTimer.current = setTimeout(retry, ms);
    };
    retryLaterRef.current = retryLater;
    window.addEventListener("online", retry);
    window.addEventListener("focus", ensureStream);
    document.addEventListener("visibilitychange", ensureStream);
    const reloadNow = (view, { merged = false } = {}) => {
      wiRef.current?.begin({ merged, dirty: dirtyRef.current, seq: editSeq.current, run: newestRun(view) });
      wantShaRef.current = view.baseSha;
      restoreRef.current = true;
      rememberPlace();
      if (!retries.current) setProblem(null);
      mark("os:reload-start");
      const loaded = loadFile().then(
        () => {
          measure("os:reload-load", "os:reload-start"); // from the event to the new file being handed to the viewer
          syncedShaRef.current = view.baseSha;
          syncedRunRef.current = newestRun(view);
          if (retries.current) setProblem((p) => (p?.retrying ? null : p));
          retries.current = 0;
        },
        (err) => {
          wantShaRef.current = null; // nothing was loaded: this version is still owed
          setProblem({ kind: "error", retrying: true, message: `Could not reload: ${err.message}` });
          retryLater();
        }
      );
      merge(view);
      // an open Quick ask holds a place from the old file: keep the typed text, but ask for a fresh selection
      if (quickRef.current && !quickRef.current.blocked) setQuick((q) => (q ? { ...q, blocked: "The file changed. Close this and select the words again." } : q));
      setFresh(true);
      clearTimeout(freshTimer.current);
      freshTimer.current = setTimeout(() => setFresh(false), window.matchMedia("(prefers-reduced-motion: reduce)").matches ? REDUCED_FRESH_MS : FRESH_MS);
      return loaded;
    };
    reloadNowRef.current = reloadNow;
    connect();
    return () => {
      es.close();
      es = null;
      clearTimeout(streamTimer);
      clearTimeout(lostTimer);
      clearTimeout(retryTimer.current);
      window.removeEventListener("online", retry);
      window.removeEventListener("focus", ensureStream);
      document.removeEventListener("visibilitychange", ensureStream);
    };
  }, [sid, loadFile]);

  // ---- host handle -----------------------------------------------------------------------------------------
  const onHost = useCallback((h) => {
    offsRef.current.forEach((off) => off());
    offsRef.current = [];
    hostRef.current = h;
    if (!h) return;
    mark("os:doc-host");
    measure("os:file-render", "os:file-fetched", "os:doc-host"); // the viewer opening the file it was handed
    offsRef.current.push(
      h.onEdit((e) => {
        // an HTML file's typed text is held by the viewer as pending edits (no bytes leave the page): only the record of what was typed is kept
        if (h.format === "html") e = { ...e, location: { ...e.location, version: h.version } };
        else dirtyRef.current = true;
        editSeq.current++;
        wiRef.current?.cancel("edit");
        setChanges((list) => {
          const next = coalesce(list, e);
          const last = next[next.length - 1];
          // where the edit sits in the panel's stack: after the comment that was newest when the edit began
          if (last && last.afterId === undefined) last.afterId = commentsRef.current.at(-1)?.id || null;
          return next;
        });
      })
    );
    offsRef.current.push(h.onSelectionChange((sel) => showChip(sel)));
    if (h.format === "html") {
      // the viewer's own clicks: Comment and Pin modes pick an element (or, dragged in Comment mode, a text); a blocked action (Enter, a
      // new element, a read-only part) opens the comment box on its element (R17); edits that could not be placed again say so
      // through htmlOnRef: this callback is made once, the handlers read this render's state
      offsRef.current.push(
        h.onPick((p) => htmlOnRef.current.pick(p)),
        h.onBlocked((b) => htmlOnRef.current.blocked(b)),
        h.onEditsChange((l) => setHtmlEdits(l.length)),
        h.onEditsLost((r) => htmlOnRef.current.lost(r)),
        h.onMarkClick((id) => htmlOnRef.current.mark(id)),
        h.onViewChange(() => htmlOnRef.current.view()),
      );
      setHtmlEdits(h.edits().length);
    }
    h.setReadOnly(roRef.current, "tab"); // the reason is the HTML view's (another tab holds the file); the engine reads the first argument only
    setHostTick((t) => t + 1);
  }, []);

  useEffect(() => {
    hostRef.current?.setReadOnly(ro, "tab");
    if (ro) setMode("edit");
  }, [ro, hostTick]);

  // A reloaded editing tab leaves the file for a moment before its new page claims it: for the first seconds a tab that finds the file held keeps asking.
  useEffect(() => {
    if (!ro) return;
    const t0 = Date.now();
    const id = setInterval(() => {
      if (Date.now() - t0 > 4000) return clearInterval(id);
      api(`/api/claim?s=${sid}`, { method: "POST", body: {} }).catch(() => {});
    }, 500);
    return () => clearInterval(id);
  }, [ro, sid]);

  // a selection that ends past the last line of a page (a triple-click on a page's last paragraph, a drag below it) ends on the footer: pull it back into the words
  useEffect(() => {
    const fix = () => pullSelectionIntoParagraphs(docRef.current);
    document.addEventListener("selectionchange", fix);
    return () => document.removeEventListener("selectionchange", fix);
  }, []);

  function showChip(sel) {
    // Quick ask belongs to its words: other words selected while it is open close it (as scrolling them away does), and what was typed stays as an unsent comment
    const q = quickRef.current;
    if (q && !q.blocked && sel && !sel.collapsed && sel.kind === "text" && (sel.quote !== q.anchor.quote || JSON.stringify(sel.location) !== JSON.stringify(q.anchor.location))) {
      closeQuick(false);
      if (q.text.trim()) addComment(q.kind, q.anchor, null, { text: q.text.trim(), quiet: true });
    }
    if (!sel || sel.collapsed || sel.kind !== "text" || (Date.now() < quietRef.current.until && sel.quote === quietRef.current.quote)) return setChipSel(null);
    setChipSel(sel);
  }

  // The editor tells us about a selection only when it differs from the one it told us about last. After a Quick ask send the asked sentence stays selected (its chip is held back for a moment),
  // so selecting the same sentence again said nothing and no chip came. At the end of a click or a key press in the document, ask for the selection ourselves.
  useEffect(() => {
    const again = (e) => {
      const h = hostRef.current;
      if (!h || chipSelRef.current || !docRef.current?.contains(e.target) || e.target.closest?.(".qa")) return;
      const sel = h.selection();
      if (sel && !sel.collapsed && sel.kind === "text") showChip(sel);
    };
    document.addEventListener("mouseup", again, true);
    document.addEventListener("keyup", again, true);
    return () => {
      document.removeEventListener("mouseup", again, true);
      document.removeEventListener("keyup", again, true);
    };
  }, []);

  // After every (re)mount: map durable anchors to engine locations, restore the view if this was a reload.
  useEffect(() => {
    const h = hostRef.current;
    if (!h) return;
    let cancelled = false;
    (async () => {
      const r = await api(`/api/resolve?s=${sid}`, { method: "POST", body: {} });
      if (cancelled) return;
      infoRef.current = { slides: r.slides || null, sheets: r.sheets || null };
      const map = {};
      for (const [id, a] of Object.entries(r.anchors)) {
        if (a.method === "none") map[id] = { method: "none", loc: null };
        else if (h.format === "docx") {
          if (!a.path) map[id] = { method: a.method, text: a.text, loc: null, unlocatable: true };
          else {
            const bp = [a.path[0] + (a.engineDelta || 0), ...a.path.slice(1)];
            map[id] = { method: a.method, text: a.text, heading: a.heading, loc: { blockPath: bp, ...(a.start != null ? { start: a.start, end: a.end } : {}) } };
          }
        } else if (h.format === "html") map[id] = { method: a.method, text: a.text, heading: a.heading, loc: htmlLocFromResolved(a), changed: !!a.changed, quoteLost: !!a.quoteLost };
        else if (h.format === "xlsx" || h.format === "pptx") map[id] = { method: a.method, text: a.text, loc: withProtected(locFromResolved(h.format, a), commentsRef.current.find((c) => c.id === id)), changed: !!a.changed, moved: !!a.moved, quoteLost: !!a.quoteLost, tieLost: !!a.tieLost };
      }
      setResolved(map);
      let exact = false; // the view came back to the exact place (setViewState said so)
      if (restoreRef.current) {
        restoreRef.current = false;
        const here = hereRef.current;
        hereRef.current = null;
        // Not scrolled since Send: the server's durable anchor is the most exact (it follows text the agent moved or rewrote).
        // Scrolled since, or nothing stored: the engine finds the paragraph that was at the top by its text, else the same depth.
        const stayed = here && sentViewRef.current && viewKey(here) === viewKey(sentViewRef.current);
        const known = r.view && r.view.method !== "none";
        if (here && !(stayed && known)) exact = (await h.setViewState(here).catch(() => false)) === true;
        else if (known) exact = (await restoreView(h, r.view)) === true;
      }
      if (cancelled) return;
      wiRef.current?.up(exact);
      returnToPlace();
      if (loadPlacesRef.current) {
        loadPlacesRef.current = false;
        loadPlaces();
      }
    })().catch((e) => setProblem({ kind: "error", message: `Could not restore anchors: ${e.message}` }));
    return () => {
      cancelled = true;
    };
  }, [hostTick, sid]);

  // ---- overlay: highlights, markers, pins, changed regions and the selection chip, drawn from rectsFor -----------
  // One pass per animation frame, scheduled by scroll / resize / DOM change; a slow timer covers late engine paints.
  const redraw = useFrame(() => {
    const h = hostRef.current;
    const box = overlayRef.current?.getBoundingClientRect();
    if (!h || !box) return;
    const fmt = h.format;
    const lx = (x) => Math.round((x - box.left) * 10) / 10;
    const ly = (y) => Math.round((y - box.top) * 10) / 10;
    const clip = clipFor(fmt, docRef.current, box);
    const vs = fmt === "xlsx" ? h.getViewState() : null;
    const active = vs?.sheetName ?? null;
    setActiveSheet((a) => (a === active ? a : active));
    const items = [];
    const fz = fmt === "xlsx" ? frozenOf(h, docRef.current, clip) : null;
    const cut = (r, area = clip) => {
      const l = Math.max(r.left, area.left);
      const t = Math.max(r.top, area.top);
      const rt = Math.min(r.right, area.right);
      const b = Math.min(r.bottom, area.bottom);
      return rt > l && b > t ? { left: l, top: t, right: rt, bottom: b, width: rt - l, height: b - t } : null;
    };
    const local = (r) => ({ x: lx(r.left), y: ly(r.top), w: Math.round(r.width), h: Math.round(r.height) });
    commentsRef.current.forEach((c, idx) => {
      if (fmt === "html") return; // the HTML view draws its comments and pins itself, from `marks` (HtmlViewer)
      const rz = resolvedRef.current[c.id];
      let loc = null;
      let moved = false;
      if (rz) {
        if (rz.loc) {
          // DOCX: verify the mapped block once it is rendered; correct it if a neighbor shows the text
          if (rz.text && !rz.checked && rz.loc.blockPath) {
            const v = verifyBlock(rz.loc.blockPath, rz.text);
            if (v.verified) {
              rz.checked = true;
              rz.loc = { ...rz.loc, blockPath: v.path };
            }
          }
          loc = rz.loc;
        } else moved = true;
      } else loc = c.anchor?.location || null;
      if (!loc) return void items.push({ id: c.id, n: idx + 1, moved });
      const n = idx + 1;
      const prot = !!loc.protected;
      if (fmt === "xlsx" && loc.sheetName !== active) return; // only the shown sheet's markers; the card still lists it and jumps there
      const rects = h.rectsFor(loc);
      if (!rects.length) return;
      if (fmt === "docx") {
        const vis = rects.filter((r) => r.bottom > box.top && r.top < box.bottom);
        if (!vis.length) return;
        if (c.kind === "pin") {
          const r = rects[0];
          const x = r.left + (c.pin?.xFrac ?? 0) * r.width;
          const y = r.top + (c.pin?.yPx ?? 0);
          if (y > box.top && y < box.bottom && x > box.left && x < box.right) items.push({ id: c.id, n, ...pinPlace(x, y, box, lx, ly), status: c.status, prot });
        } else items.push({ id: c.id, n, rects: vis.map(local), whole: !(loc.start != null), status: c.status, prot });
        return;
      }
      if (fmt === "xlsx") {
        const r0 = rects[0];
        const q = parseA1(loc.range);
        // cells that scroll are drawn only below the frozen rows and right of the frozen columns; a frozen cell keeps its place
        const area = !fz || !q ? clip : { ...clip, top: q.r0 >= fz.rows ? Math.max(clip.top, fz.bottom) : clip.top, left: q.c0 >= fz.cols ? Math.max(clip.left, fz.right) : clip.left };
        const shown = cut(r0, area);
        if (!shown) return;
        if (!q) {
          // whole rows / columns / the sheet: outline only
          items.push({ id: c.id, n, rects: [local(shown)], whole: true, unit: "range", status: c.status, prot, mark: { x: lx(shown.left + 14), y: ly(Math.max(shown.top, area.top + 6)), xl: true } });
          return;
        }
        // The grid reports a rectangle even for a cell that is scrolled under the frozen panes. Ask it who is shown at the middle of what is visible.
        const probe = h.hitTest((shown.left + shown.right) / 2, (shown.top + shown.bottom) / 2);
        const pr = probe?.location?.range ? parseA1(probe.location.range) : null;
        if (!pr || !(pr.r0 >= q.r0 && pr.r1 <= q.r1 && pr.c0 >= q.c0 && pr.c1 <= q.c1)) return;
        if (c.kind === "pin") {
          const x = r0.left + (c.pin?.xFrac ?? 0.5) * r0.width;
          const y = r0.top + (c.pin?.yFrac ?? 0.5) * r0.height;
          if (x < area.left || x > area.right || y < area.top || y > area.bottom) return;
          const hit = h.hitTest(x, y);
          if (hit?.location?.range && !rangeHasCell(hit.location.range, q.r0, q.c0)) return;
          items.push({ id: c.id, n, ...pinPlace(x, y, area, lx, ly), status: c.status, prot });
          return;
        }
        const single = q.r0 === q.r1 && q.c0 === q.c1;
        // A cell's flag sits just right of its top-right corner and straddles the top border: the band between two rows of text is empty,
        // so the number is never covered. Ceiling: a tall wrapped cell with text hugging its top edge can still meet it.
        const mx = Math.min(shown.right + 10, area.right - 10);
        const my = Math.max(shown.top, area.top + 6);
        items.push({ id: c.id, n, rects: [local(shown)], whole: true, unit: single ? "cell" : "range", status: c.status, prot, mark: { x: lx(mx), y: ly(my), xl: true } });
        return;
      }
      // pptx
      const hasShape = loc.shapeId != null;
      if (c.kind === "pin") {
        let r = rects[0];
        let fx = c.pin?.xFrac ?? 0.5;
        let fy = c.pin?.yFrac ?? 0.5;
        if (hasShape && c.pin?.sxFrac != null) {
          fx = c.pin.sxFrac;
          fy = c.pin.syFrac;
        } else if (hasShape) r = h.rectsFor({ slideIndex: loc.slideIndex })[0] || r; // tied shape without a stored offset: the slide fractions still hold
        const x = r.left + fx * r.width;
        const y = r.top + fy * r.height;
        if (x < clip.left || x > clip.right || y < clip.top || y > clip.bottom) return;
        items.push({ id: c.id, n, ...pinPlace(x, y, clip, lx, ly), status: c.status, prot });
        return;
      }
      const shown = cut(rects[0]);
      if (!shown) return;
      const mx = hasShape ? shown.left : shown.left + 16;
      const my = hasShape ? shown.top : shown.top + 16;
      items.push({ id: c.id, n, rects: [local(shown)], whole: true, unit: hasShape ? "shape" : "slide", status: c.status, prot, mark: { x: lx(Math.min(Math.max(mx, clip.left + 10), clip.right - 10)), y: ly(Math.min(Math.max(my, clip.top + 10), clip.bottom - 10)) } });
    });

    // what the agent changed (found by comparing the file before and after), shown while the done highlight is fresh
    const writein = wiRef.current.paint(h, box, local); // first: a place it cannot confirm goes back to the outline below in this same pass
    const chg = freshRef.current ? changedPaint(h, fmt, sessionRef.current, infoRef.current, active, clip, cut, local, wiRef.current.skip()) : [];
    // History "Show": one outline on the place, drawn here over the document, never in it
    if (showRef.current) {
      const rs = h.rectsFor(showRef.current.loc);
      if (rs.length) {
        const u = { left: Math.min(...rs.map((r) => r.left)), top: Math.min(...rs.map((r) => r.top)), right: Math.max(...rs.map((r) => r.right)), bottom: Math.max(...rs.map((r) => r.bottom)) };
        const c = cut({ ...u, width: u.right - u.left, height: u.bottom - u.top });
        if (c) chg.push({ ...local(c), kind: "show" });
      }
    }
    // Quick ask: outline the words being asked about (the composer holds the focus, so the browser draws no selection) and place the composer beside them
    let quickAt = null;
    let quickGone = false;
    const qk = quickRef.current;
    if (qk) {
      const W = Math.min(360, box.width - 16);
      const H = 170; // room for the stamp row
      const rs = h.rectsFor(qk.anchor.location);
      if (rs.length) {
        const u = { left: Math.min(...rs.map((r) => r.left)), top: Math.min(...rs.map((r) => r.top)), right: Math.max(...rs.map((r) => r.right)), bottom: Math.max(...rs.map((r) => r.bottom)) };
        const c = cut({ ...u, width: u.right - u.left, height: u.bottom - u.top });
        if (c) chg.push({ ...local(c), kind: "ask" });
        else if (!qk.blocked) quickGone = true; // the words are off screen: the box would float over other text (a box whose place is stale stays, below)
        const last = rs[rs.length - 1];
        const below = ly(last.bottom) + 8;
        const y = below + H > box.height - 8 ? ly(rs[0].top) - H - 8 : below;
        quickAt = { x: Math.round(Math.min(Math.max(8, lx(u.left)), box.width - W - 8)), y: Math.round(Math.min(Math.max(8, y), box.height - H - 8)), w: W };
      } else if (!qk.blocked) quickGone = true; // the place scrolled out of the rendered part
      else quickAt = { x: Math.round((box.width - W) / 2), y: 12, w: W }; // the words are gone from the file: keep the box, and the typed text in it, reachable
    }
    // places the last agent run changed that are out of view: one small pill that jumps to the first
    const away = awayPill(h, fmt, clip, placesRef.current, awayRef);
    // thumbnail strip: a count badge on every slide that has comments
    const thumbs = fmt === "pptx" ? thumbBadges(docRef.current, commentsRef.current, resolvedRef.current, box, lx, ly) : [];
    // live rubber band while dragging a range
    let drag = null;
    const dr = dragRef.current;
    if (dr?.cur && dr.start) {
      const a = dr.start.rect;
      const b = dr.cur.rect;
      const l = Math.min(a.left, b.left);
      const t = Math.min(a.top, b.top);
      drag = { x: lx(l), y: ly(t), w: Math.round(Math.max(a.right, b.right) - l), h: Math.round(Math.max(a.bottom, b.bottom) - t) };
    }
    let chip = null;
    const sel = chipSelRef.current;
    if (sel) {
      const rs = h.rectsFor(sel.location);
      const r = rs[rs.length - 1];
      if (r && r.bottom > box.top && r.top < box.bottom) {
        const at = placeChip(rs, box, (cs) => textUnder(docRef.current, cs));
        chip = { x: Math.round(lx(at.x)), y: Math.round(ly(at.y)) };
      }
    }
    const next = { items, chip, chg, thumbs, drag, quickAt, quickGone, away, writein };
    setPaint((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
  });

  if (!wiRef.current) {
    wiRef.current = createWriteIn({
      sid,
      redraw,
      get: () => ({ host: hostRef.current, session: sessionRef.current, readOnly: roRef.current, dirty: dirtyRef.current, seq: editSeq.current, sending: sendingRef.current, box: overlayRef.current?.getBoundingClientRect() || null, locOf: (p) => historyLocRef.current?.(p) ?? null }),
    });
  }

  useEffect(() => {
    const el = docRef.current;
    if (!el) return;
    const onScroll = () => redraw();
    document.addEventListener("scroll", onScroll, true); // scroll events do not bubble: capture them from the engine's scroller
    window.addEventListener("resize", onScroll);
    const ro = new ResizeObserver(onScroll);
    ro.observe(el);
    const mo = new MutationObserver(onScroll);
    mo.observe(el, { childList: true, subtree: true });
    const slow = setInterval(onScroll, 700);
    return () => {
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
      ro.disconnect();
      mo.disconnect();
      clearInterval(slow);
    };
  }, [redraw]);
  useEffect(() => redraw(), [comments, resolved, chipSel, session.locked, doc.v, hostTick, side.width, sideOpen, redraw]);
  // Quick ask belongs to its words: when they scroll out of view the box closes instead of floating over other text. Typed text is never lost: it stays as an unsent comment on those words.
  // (The engine redraws a page for a moment after some clicks and then reports no place for the words: only words that are still gone a moment later close the box.)
  const goneRef = useRef(false);
  goneRef.current = !!paint.quickGone;
  useEffect(() => {
    if (!paint.quickGone || !quickRef.current) return;
    const t = setTimeout(() => {
      const q = quickRef.current;
      if (!q || !goneRef.current) return;
      closeQuick(false);
      if (q.text.trim()) addComment(q.kind, q.anchor, null, { text: q.text.trim() });
    }, 300);
    return () => clearTimeout(t);
  }, [paint.quickGone]); // eslint-disable-line react-hooks/exhaustive-deps

  // A plain click in the document outside the box and outside the words it asks about closes it too, and the typed words stay as an unsent comment (as when other words are selected).
  // It acts after the click, so the caret stays where the person clicked and nothing scrolls. A click that selects words (a drag, a double click) is the selection rule's.
  useEffect(() => {
    const onClick = (e) => {
      const q = quickRef.current;
      const h = hostRef.current;
      if (!q || q.blocked || !h || e.detail < 1 || !docRef.current?.contains(e.target) || e.target.closest?.(".qa")) return;
      if (!window.getSelection()?.isCollapsed) return;
      const onWords = h.rectsFor(q.anchor.location).some((r) => e.clientX >= r.left - 1 && e.clientX <= r.right + 1 && e.clientY >= r.top - 1 && e.clientY <= r.bottom + 1);
      if (onWords) return;
      closeQuick(false);
      if (q.text.trim()) addComment(q.kind, q.anchor, null, { text: q.text.trim(), quiet: true });
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  // ---- draft persistence -----------------------------------------------------------------------------------
  // "Saved" / "Not saved" on the draft cards: the newest autosave decides (an older answer arriving late changes nothing). A failed save is tried again,
  // soon and then slowly (retryDelay), and "Not saved" stays until one goes through. A draft the server refuses as too large (413
  // too_large_request) is not tried again: its words are shown once, and the next change to the comments tries again.
  const [ack, setAck] = useState(null); // null | "saved" | "failed"
  const saveSeq = useRef(0);
  const saveFails = useRef(0);
  /**
   * One draft save now: the comments and (unless a Send in flight carried it) the note, numbered. Its answer goes in through applyServer.
   * Returns the request (it never rejects), which savingRef holds while it is in flight. `keepalive`: the save on the way out of the page.
   */
  const saveNow = useCallback(({ seq = ++saveSeq.current, keepalive = false } = {}) => {
    clearTimeout(saveTimer.current);
    draftPendingRef.current = false;
    // the note goes with its revision: a save of the revision a Send already took leaves the server's note alone (the save on the way out
    // while that Send is in flight), so the note is never put back after a Send took it, and never lost if that Send did not arrive
    // while Take back, Stop, Revert or Close is in flight the note is left out (and read only): their answer joins the server's note with
    // the box
    const note = outRef.current ? undefined : noteRef.current;
    const noteRev = draftsRef.current.noteRev;
    const comments = commentsRef.current.map(toWire);
    const wire = ++revRef.current;
    const at = draftsRef.current.begin({ note, carriesNote: note !== undefined, wire, comments: commentsRef.current });
    let ok = false;
    const req = api(`/api/draft?s=${sid}`, { method: "POST", keepalive, body: { comments, note, noteRev, seen: draftsRef.current.seen, noteSeen: draftsRef.current.noteSeen, rev: wire } }).then(
      (out) => {
        ok = true;
        draftsRef.current.end(at, true);
        if (out?.session) applyRef.current?.(out.session, at);
        if (seq !== saveSeq.current) return;
        saveFails.current = 0;
        setAck("saved");
      },
      (err) => {
        draftsRef.current.end(at, false);
        if (keepalive) return saveFails.current > 0 && err?.status !== 413 && saveDraftSoonRef.current(retryDelay(saveFails.current) ?? 15000); // a tab that was only hidden (or stayed) keeps trying
        if (seq !== saveSeq.current) return;
        setAck("failed");
        if (err?.status === 413) {
          if (saveFails.current++ === 0) say(err.message); // once; still unsent, so the leave-page guard asks first
          return;
        }
        const ms = retryDelay(saveFails.current++);
        if (saveFails.current === 1) say("Your comments could not be saved yet. They are still here, and Onionskin keeps trying.");
        saveDraftSoonRef.current(ms ?? 15000); // past the quick retries, every 15 s: the words say "keeps trying" (and the leave-page guard counts the failure)
      }
    );
    const mine = req.then(() => ok, () => false).finally(() => savingRef.current === mine && (savingRef.current = null));
    savingRef.current = mine;
    return mine; // resolves to whether it went through
  }, [sid, say]);
  const saveDraftSoon = useCallback((delay = 350) => {
    clearTimeout(saveTimer.current);
    if (roRef.current) return;
    draftPendingRef.current = true;
    if (heldRef.current) return; // a Send is in flight: saved once its answer is in (send)
    setAck((a) => (a === "failed" ? a : null));
    const seq = ++saveSeq.current;
    saveTimer.current = setTimeout(() => saveNow({ seq }), delay);
  }, [saveNow]);
  const saveDraftSoonRef = useRef(saveDraftSoon);
  saveDraftSoonRef.current = saveDraftSoon;
  /** Before an action whose answer rewrites the drafts or the note (Take back, Stop, Revert, Close): what is typed is saved first, and a save in flight is waited for. */
  async function flushDrafts() {
    if (roRef.current) return true;
    while (savingRef.current) await savingRef.current; // every save in flight (one sent meanwhile too) lands before the action goes
    if (draftPendingRef.current && !heldRef.current) return (await saveNow()) && flushDrafts(); // false: not saved, so the action does not go
    return true;
  }
  /** This tab lost editing holding unsaved words: hand them over once (Sessions.handOver); they stay on screen until that went through. */
  function handOver() {
    const d = draftsRef.current;
    handingRef.current = "sending";
    clearTimeout(saveTimer.current);
    draftPendingRef.current = false;
    api(`/api/handover?s=${sid}`, { method: "POST", body: d.unsaved(commentsRef.current, noteRef.current) }).then(
      (out) => {
        if (handingRef.current !== "sending") return;
        handingRef.current = null;
        if (out?.session) applyRef.current(out.session, null, { wholesale: true }); // the other tab edits it now, with these words in it
        say("Another tab edits this file now. What you typed here was handed to it.");
      },
      () => {
        if (handingRef.current !== "sending") return;
        handingRef.current = "failed";
        setProblem({ kind: "error", handover: true, copy: true, message: "Another tab edits this file now, and what you typed here last could not be handed to it. It is still on this page: copy it before you close this tab." });
      }
    );
  }
  /** The one place server state goes into the comments and the note (web/src/drafts.js reconcile). `at`: what the request it answers was sent with. */
  const applyServer = (view, at = null, opts = {}) => {
    const wait = sentWaitRef.current; // a Send in flight: this state shows it committed
    if (wait && view.sent?.[TAB]?.rev >= wait.rev) wait.resolve(view);
    const r = draftsRef.current.reconcile({ comments: commentsRef.current, note: noteRef.current }, view, at, opts);
    commentsRef.current = r.comments;
    setComments(r.comments);
    if (r.note !== noteRef.current) {
      noteRef.current = r.note;
      setNote(r.note);
    }
    if (r.unsaved && !opts.wholesale && !draftPendingRef.current) saveDraftSoon(); // words the server does not hold yet: the next autosave carries them (one already due is not pushed back)
  };
  applyRef.current = applyServer;

  // ---- leaving the page --------------------------------------------------------------------------------------
  // Typed document edits live only in this page until Send. Leaving (refresh, tab close, navigation) asks first; a draft that has not
  // been autosaved yet is sent on the way out. (Persisting unsent document edits across a refresh is not done.)
  useEffect(() => {
    // a comment or the note is unsent until the answer of a save that carried it came back (web/src/drafts.js dirty): one waiting for its
    // autosave, one whose save is still on its way, one whose save failed, and one only the save on the way out (keepalive) carries
    const unsent = () => !roRef.current && (dirtyRef.current || (sessionRef.current.format === "html" ? htmlEditsRef.current > 0 || (hostRef.current?.lostEdits?.()?.length ?? 0) > 0 : changesRef.current.length > 0) || draftPendingRef.current || saveFails.current > 0 || !!savingRef.current || draftsRef.current.dirty(commentsRef.current));
    const flush = () => {
      // a Send in flight too: if it never arrives, this save holds what it carried
      if ((!draftPendingRef.current && !sendingRef.current) || roRef.current) return;
      saveNow({ keepalive: true });
    };
    const onBeforeUnload = (e) => {
      flush();
      if (!unsent()) return;
      e.preventDefault();
      e.returnValue = "";
    };
    const onHidden = () => document.visibilityState === "hidden" && flush();
    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onHidden);
    };
  }, [sid, saveNow]);
  const updateComments = (fn) => {
    // the ref moves first: Quick ask creates a comment and sends in the same breath, and send() reads the ref
    const prev = new Map(commentsRef.current.map((c) => [c.id, c]));
    const next = fn(commentsRef.current);
    for (const c of next) if (prev.get(c.id) !== c) draftsRef.current.typed(c.id); // a comment made or changed here: newer than the server's
    const kept = new Set(next.map((c) => c.id));
    for (const id of prev.keys()) if (!kept.has(id)) draftsRef.current.removed(id); // deleted here: an older copy from the server is not brought back
    commentsRef.current = next;
    setComments(next);
    saveDraftSoon();
  };
  const updateNote = (v) => {
    if (heldRef.current?.note || rewritingRef.current) return; // the Send in flight carried it; a Take back (or the like) in flight rewrites it
    draftsRef.current.typedNote();
    setNote(v);
    noteRef.current = v;
    saveDraftSoon();
  };

  /** After a reload: put the view back where the user had it. True when the engine says the view is exact. */
  async function restoreView(h, v) {
    if (!v || v.method === "none") return false;
    if (h.format === "docx") {
      if (v.path) {
        return h.setViewState({
          format: "docx",
          blockPath: [v.path[0] + (v.engineDelta || 0)],
          textHash: hashText(v.text || ""),
          quote: (v.text || "").slice(0, 80),
          offsetPx: v.offsetPx ?? 0,
          zoom: v.zoom ?? "fit",
          fraction: v.fraction ?? 0,
        });
      }
    } else if (h.format === "xlsx" && v.format === "xlsx") return h.setViewState({ format: "xlsx", sheetIndex: v.sheetIndex, sheetName: v.sheetName, topLeft: v.topLeft, selection: v.selection });
    else if (h.format === "pptx" && v.format === "pptx") return h.setViewState({ format: "pptx", slideIndex: v.slideIndex, zoom: v.zoom ?? "fit" });
    else if (h.format === "html" && v.raw?.format === "html") return h.setViewState(v.raw);
    return false;
  }

  // ---- after an agent run lands: keep the user's place, show what changed ----------------------------------------------
  /** Called as the new file starts loading: if the focus was in the document, note the paragraph and caret so the user can keep typing. */
  function rememberPlace() {
    returnRef.current = null;
    loadPlacesRef.current = true;
    const h = hostRef.current;
    // Use this reloads the file while its Quick ask box is still open, or just after it closed and before the focus is back (closeQuick): the box gives the focus
    // back to the document, so its words are the place
    const due = quickRef.current ? null : backDueRef.current;
    const qloc = quickRef.current ? quickRef.current.anchor.location : due?.loc;
    const asked = (quickRef.current || due) && qloc?.blockPath?.length === 1;
    if (asked && due) backDueRef.current = null; // the caret goes back on the new file (returnToPlace), not on the pages about to be replaced
    if (!h || ((quickRef.current || due) ? !asked : !docRef.current?.contains(document.activeElement))) return;
    const loc = asked ? qloc : h.selection()?.location || null;
    const bp = loc?.blockPath?.length === 1 ? loc.blockPath : null;
    returnRef.current = { bp, text: bp ? paragraphText(bp) : null, start: loc?.start ?? null };
  }

  /** The new document is up: if focus was in the document and nothing else took it, put the caret back in its paragraph (no scrolling). */
  function returnToPlace() {
    const r = returnRef.current;
    returnRef.current = null;
    if (!r) return;
    const a = document.activeElement;
    if (a && a !== document.body && !docRef.current?.contains(a)) return; // the user already moved on
    let para = null;
    let start = r.start ?? Infinity;
    if (r.bp && r.text) {
      const v = verifyBlock(r.bp, r.text);
      if (v.verified) para = document.querySelector(`.de-p[data-bi="${v.path[0]}"]`);
    }
    if (!para && r.bp) {
      // the words changed (Use this rewrites them): the paragraph at the same place holds the caret, at its start. A rebuilt editor puts its own caret at the top of the file, and the formatting bar would show the title's style
      para = document.querySelector(`.de-p[data-bi="${r.bp[0]}"]`);
      start = 0;
    }
    const surface = para?.closest('[contenteditable="true"]') || docRef.current?.querySelector('[contenteditable="true"], .de-scroll');
    surface?.focus({ preventScroll: true });
    if (!para) return;
    const place = () => {
      try {
        const w = document.createTreeWalker(para, NodeFilter.SHOW_TEXT);
        let left = start;
        let node = null;
        let at = 0;
        for (let t = w.nextNode(); t; t = w.nextNode()) {
          node = t;
          at = Math.min(left, t.length);
          if (left <= t.length) break;
          left -= t.length;
        }
        if (!node) return;
        const range = document.createRange();
        range.setStart(node, at);
        range.collapse(true);
        const ds = window.getSelection();
        ds.removeAllRanges();
        ds.addRange(range);
      } catch {
        /* the caret is a nicety: the focus is already back in the document */
      }
    };
    place();
    // The rebuilt editor reads the caret off the page on the next change of selection and keeps the formatting bar from that: after it has drawn its pages
    // (it puts a caret of its own at the top of the file then, and the bar shows the title's style) say again where the caret is
    for (const ms of [200, 700]) setTimeout(() => document.dispatchEvent(new Event("selectionchange")), ms);
  }

  /** Where the last agent run changed things, in engine locations (from History, the same places its Show button uses). Feeds the "changes below / above" pill. */
  async function loadPlaces(retry = 0) {
    try {
      const list = await api(`/api/history?s=${sid}`);
      const u = (list.updates || [])[0];
      if (!u || (u.kind !== "agent" && u.kind !== "local")) return retry < 2 ? void setTimeout(() => loadPlaces(retry + 1), 700) : undefined;
      const d = await api(`/api/history/${encodeURIComponent(u.id)}?s=${sid}`);
      if (!d.after_is_current) return;
      const locs = (d.places || []).filter((p) => p.locator && p.change !== "removed").map((p) => historyLocRef.current(p)).filter(Boolean).slice(0, 60);
      placesRef.current = { list: locs, until: Date.now() + PILL_MS, id: u.id };
      redraw();
      setTimeout(redraw, PILL_MS + 50); // the pill expires on a redraw: make sure one happens
    } catch {
      /* the pill is a convenience: the outlines in view and the History section still show the run */
    }
  }

  function openSidebar() {
    if (narrow) setDrawer(true);
    else side.setCollapsed(false);
  }

  /** The one way a comment or pin is created (chip, Ctrl+Alt+M, Comment and Pin modes, Quick ask). `text` pre-fills it; `quiet` leaves the panel and focus alone. */
  function addComment(kind, anchor, pin, { text = "", quiet = false } = {}) {
    if (roRef.current) return null;
    const list = commentsRef.current;
    if (list.length >= COMMENTS_MAX) {
      say(TOO_MANY_COMMENTS); // the server refuses the next one in the same words; none is made, so none is lost
      return null;
    }
    const pinNo = kind === "pin" ? list.filter((c) => c.kind === "pin").length + 1 : null;
    // an HTML anchor names a node of the version this page shows: it carries that version (a node id means nothing in another)
    if (sessionRef.current.format === "html") anchor = stamped(anchor, loadedShaRef.current);
    const c = { id: uid("c"), kind, text, status: "draft", anchor, pin: pin || null, pinNo };
    updateComments((l) => [...l, c]);
    setChipSel(null);
    if (!quiet) {
      setFocusId(c.id);
      openSidebar();
    }
    return c;
  }

  // the HTML view's events (onHost subscribes once and calls these, made on every render)
  const htmlOnRef = useRef(null);
  htmlOnRef.current = {
    pick: (p) => (p.mode === "pin" ? addComment("pin", { ...p.anchor, format: "html" }, p.pin) : addComment(p.kind === "text" ? "text" : "element", { ...p.anchor, format: "html" })),
    blocked: (b) => b.anchor && addComment("element", { ...b.anchor, format: "html" }),
    lost: () => {}, // the viewer lists edits that could not be placed, each with its text and a Copy button (HtmlViewer.jsx)
    mark: (id) => (setFocusId(id), openSidebar()),
    view: () => redraw(),
  };

  function onChip() {
    const s = chipSelRef.current;
    if (!s) return;
    addComment("text", { location: s.location, quote: s.quote, prefix: s.prefix, suffix: s.suffix, format: s.format });
  }

  /** What the selection or caret asks about: a text anchor for selected words, else an element anchor for the paragraph / cell / shape that holds the caret. */
  function anchorFromSelection(h, sel) {
    if (sel.kind === "text" && !sel.collapsed) return { kind: "text", anchor: { location: sel.location, quote: sel.quote, prefix: sel.prefix, suffix: sel.suffix, format: sel.format } };
    const { start, end, ...location } = sel.location; // collapsed caret: comment on the whole place
    const para = h.format === "docx" ? paragraphText(location.blockPath) : null;
    return { kind: "element", anchor: { location, quote: para || sel.quote || "", paraText: para || undefined, prefix: "", suffix: "", format: sel.format, hitKind: h.format === "docx" ? "paragraph" : "selection" } };
  }

  /** Keyboard path: comment on the selection, or on the paragraph / cell / shape that holds the caret. */
  function commentFromKeyboard() {
    const h = hostRef.current;
    if (!h) return;
    const sel = h.selection();
    if (!sel) return say("Click inside the document first, then press Ctrl+Alt+M (Cmd+Option+M on Mac) to comment.");
    const a = anchorFromSelection(h, sel);
    addComment(a.kind, a.anchor);
  }

  // ---- Quick ask: select, Cmd/Ctrl+Shift+K, type, Cmd/Ctrl+Enter = the comment is made on the selection and the batch is sent (Enter is a new line, as in every comment box) ----------------
  function openQuick() {
    const h = hostRef.current;
    if (!h) return;
    if (phone) return commentFromKeyboard(); // a phone has the review sheet, no floating box
    if (quickRef.current) return document.querySelector('[data-testid="quick-ask-text"]')?.focus();
    const sel = h.selection();
    if (!sel) return say(`Click inside the document first, then press ${MOD}+Shift+K to ask for a change.`);
    const a = anchorFromSelection(h, sel);
    const ds = window.getSelection();
    const inDoc = ds?.rangeCount && docRef.current?.contains(ds.getRangeAt(0).commonAncestorContainer);
    quickBackRef.current = { range: inDoc ? ds.getRangeAt(0).cloneRange() : null, el: docRef.current?.contains(document.activeElement) ? document.activeElement : null, host: h };
    const blocked = roRef.current ? "This tab is read-only. Ask from the tab that holds the file." : sessionRef.current.state === "closed" ? "This session is closed, so nothing can be sent." : commentsRef.current.length >= COMMENTS_MAX ? TOO_MANY_COMMENTS : null; // at the cap no words are typed that could not become a comment
    setChipSel(null);
    setQuick({ ...a, text: "", blocked, nudge: false });
    if (suggestOn && !blocked && (h.format === "docx" || h.format === "pptx")) {
      api(`/api/suggest/warm?s=${sid}`, { method: "POST", body: {} }).catch(() => {}); // starts a cold writing helper; carries no text
      askAhead(a, h.format);
    }
  }

  /** Close the composer; with `back`, return focus to the document with the selection as it was. */
  function closeQuick(back) {
    const b = quickBackRef.current;
    const loc = quickRef.current?.anchor.location ?? null;
    quickBackRef.current = null;
    aheadRef.current = null; // a held answer is for this box only
    sgSeq.current++;
    setSg(null);
    setQuick(null);
    quickRef.current = null;
    redraw();
    if (!back || !b) return;
    // Until the frame below the focus is in neither the box nor the document. A reload that starts then (Use this writes the file, and its reload can come first)
    // would find no place to keep, and the new editor's own caret at the top of the file would take the typing: it takes this place over instead (rememberPlace)
    const due = { loc };
    backDueRef.current = due;
    requestAnimationFrame(() => {
      if (backDueRef.current !== due) return; // a reload took the place over: it puts the caret back on the new file
      backDueRef.current = null;
      if (b.host !== hostRef.current) {
        // The file was reloaded while the box was open: the range and the element belong to the pages it replaced (a range on removed pages is left on their
        // container, outside the editor, where typing goes nowhere). The reload put the caret back, unless the focus was in the box then.
        if (!hostRef.current || returnRef.current || docRef.current?.contains(document.activeElement)) return;
        const bp = loc?.blockPath?.length === 1 ? loc.blockPath : null;
        if (bp) {
          returnRef.current = { bp, text: null, start: 0 };
          return returnToPlace();
        }
        return void docRef.current?.querySelector('[contenteditable="true"], .de-scroll')?.focus({ preventScroll: true });
      }
      const el = b.el?.isConnected ? b.el : docRef.current?.querySelector('[contenteditable="true"], .de-scroll');
      el?.focus({ preventScroll: true });
      if (b.range?.startContainer.isConnected) {
        const ds = window.getSelection();
        ds.removeAllRanges();
        ds.addRange(b.range);
      }
    });
  }

  function submitQuick(words) {
    const q = quickRef.current;
    if (!q || q.blocked) return;
    const text = typeof words === "string" ? words : q.text.trim(); // a stamp passes its fixed words
    if (!text) return setQuick({ ...q, nudge: true });
    quietRef.current = { until: Date.now() + 600, quote: q.anchor.quote }; // the selection comes back right after this: no comment chip over it
    closeQuick(true);
    const c = addComment(q.kind, q.anchor, null, { text, quiet: true });
    if (sendingRef.current) {
      sendAgainRef.current = true; // a Send is in flight: this comment goes out right after it, and the chip when that one went through
      sentChipRef.current = c?.id || null;
    } else Promise.resolve(send()).then((ok) => ok && c && sentChip(c.id));
  }

  /** The "Sent. Follow it in the review panel" chip: only once the Send went through (a failed one shows its own error instead). */
  function sentChip(id) {
    say("Sent. Follow it in the review panel", { label: "Show it", ariaLabel: "Show it in the review panel", onClick: () => followComment(id) });
  }

  /** The "Sent. Follow it in the review panel" chip: open the panel, bring that comment's card into view and put the keyboard focus on it (the card's own button: its textarea is off once it is sent). */
  function followComment(id) {
    openSidebar();
    let tries = 0;
    const go = () => {
      const card = document.querySelector(`[data-testid="sidebar"] [data-comment-id="${id}"]`);
      const open = card && !card.closest("[inert]"); // a drawer that is still opening is inert for a moment
      if (!open) return void (tries++ < 20 && requestAnimationFrame(go));
      card.scrollIntoView({ block: "nearest" });
      card.querySelector("button:not([hidden])")?.focus({ preventScroll: true });
    };
    requestAnimationFrame(go);
  }

  // ---- Quick fixes (src/suggest.js): a stamp tap on one sentence asks the small model first; only "Use this" writes ----------------
  /** The Quick ask selection as the suggestion rules read it: the anchor (a triple-click's quote ends with the paragraph's line break, which is not in the file's text) and the Word paragraph's text. */
  function selectionRead(q, format) {
    return { anchor: { ...q.anchor, quote: String(q.anchor.quote || "").replace(/[\r\n]+$/, "") }, paraText: format === "docx" ? paragraphText(q.anchor.location?.blockPath) : null };
  }

  /** A stamp tap. Anything that does not qualify does exactly what it always did: the comment is added and Send runs. */
  function stampTap(words, stamp) {
    const q = quickRef.current;
    const h = hostRef.current;
    if (!q || q.blocked) return;
    const busy = sendingRef.current || ["working", "queued"].includes(sessionRef.current.state);
    const { anchor, paraText: para } = selectionRead(q, h?.format);
    const el = suggestEligible({ stamp, on: suggestOn, tasks: suggest?.tasks, busy, format: h?.format, kind: q.kind, anchor, paraText: para });
    if (!el) return submitQuick(words);
    askSuggest({ ...el, words, anchor, maybe: selectionShape({ format: h?.format, kind: q.kind, anchor, paraText: para }).shape === "maybe" });
  }

  /** True while the Quick ask box holds a selection that is certainly not one whole sentence (suggestions on, nothing running): the stamp row says so before the tap. */
  function oneSentenceNote() {
    const q = quick;
    if (!q || q.blocked || sending || ["working", "queued"].includes(state)) return false;
    const { anchor, paraText } = selectionRead(q, session.format);
    return needsOneSentence({ on: suggestOn, tasks: suggest?.tasks, format: session.format, kind: q.kind, anchor, paraText });
  }

  /**
   * POST /api/suggest, one at a time: it starts when the one before it has answered, and not at all when `wanted()` is false by then (null).
   * Ceiling: this orders the asks of this page only. The model answers one sentence at a time for the whole server, so a head start in another
   * tab or file can still make a tap here answer "busy" (Try again) for about a second; a server-side queue would be the upgrade.
   */
  function postSuggest(req, wanted = () => true) {
    const { location, quote, prefix, suffix } = req.anchor;
    const body = { task: req.task, anchor: { location, quote, prefix, suffix }, wholeParagraph: req.wholeParagraph };
    const run = (suggestingRef.current || Promise.resolve()).then(() => (wanted() ? api(`/api/suggest?s=${sid}`, { method: "POST", body }) : null));
    const done = run.catch(() => {});
    suggestingRef.current = done;
    done.then(() => suggestingRef.current === done && (suggestingRef.current = null));
    return run;
  }

  /**
   * The head start: when the box opens on a selection Fix grammar would suggest for (the stamp tap's own rule), its answer is asked for now and
   * held, so the card is there at the tap. Nothing is shown before the tap; the server runs the same checks as for a tap (the model on this Mac
   * only). Held for exactly this selection and file version, used once, dropped when the box closes; a newer box's ask wins over a waiting one.
   */
  function askAhead(q, format) {
    aheadRef.current = null;
    const busy = sendingRef.current || ["working", "queued"].includes(sessionRef.current.state);
    const { anchor, paraText } = selectionRead(q, format);
    const el = suggestEligible({ stamp: BUILT_IN.find((s) => s.id === "grammar"), on: suggestOn, tasks: suggest?.tasks, busy, format, kind: q.kind, anchor, paraText });
    if (!el) return;
    const req = { ...el, anchor };
    const mine = { key: aheadKey(req, syncedShaRef.current), at: Date.now() };
    mine.answer = postSuggest(req, () => aheadRef.current === mine || mine.claimed); // a tap that took it over still wants it
    mine.answer.catch(() => {});
    aheadRef.current = mine;
  }

  async function askSuggest(req) {
    const q = quickRef.current;
    if (!q) return;
    const seq = ++sgSeq.current;
    setSg({ phase: "asking", seq, req });
    let card;
    try {
      const ahead = aheadRef.current;
      const mine = ahead && ahead.key === aheadKey(req, syncedShaRef.current) && Date.now() - ahead.at < AHEAD_MS;
      if (mine) {
        ahead.claimed = true; // the tap waits for this ask, even one not sent yet
        aheadRef.current = null; // used once: Try again and a second tap ask again
      }
      const held = mine ? await ahead.answer.catch(() => null) : null;
      const a = held && reusableAhead(held) ? held : await postSuggest(req);
      card = cardFor(a, req.task, req.maybe);
    } catch (e) {
      card = { kind: "none", text: /failed to fetch|networkerror|load failed/i.test(e.message) ? NONE_WORDS.failed : useRefusal(e), retry: true };
    }
    if (seq !== sgSeq.current || !quickRef.current) return; // Esc, a newer tap or a closed box: nothing is shown
    if (card.kind === "send") {
      setSg(null);
      return submitQuick(req.words); // the server does not suggest for this: the tap does what it always did
    }
    // the server read the whole sentence from the paragraph (the selection may have stopped short of its end mark): the comment goes on that anchor
    if (card.kind === "shown" && card.anchor) req = { ...req, anchor: { ...req.anchor, ...card.anchor } };
    setSg(card.kind === "shown" ? { phase: "shown", seq, req, card } : { phase: "none", seq, req, text: card.text, retry: card.retry });
  }

  /** "Use this": the stamp's comment is added quietly and goes to /api/suggest/use like a Send; the server writes its own stored text on this Mac. */
  async function useSuggestion() {
    const q = quickRef.current;
    const cur = sg;
    if (!q || q.blocked || cur?.phase !== "shown" || sendingRef.current) return;
    const c = addComment(q.kind, cur.req.anchor, null, { text: cur.req.words, quiet: true }); // the same anchor the suggestion was made for
    if (!c) return;
    quietRef.current = { until: Date.now() + 600, quote: q.anchor.quote }; // the selection comes back right after this: no comment chip over it
    let kept = false;
    const fail = (e) => {
      // the sentence is no longer there (or no longer allowed) in the bytes about to be written: nothing was written, and the server keeps the comment as a
      // draft with a hint (localHint), so the person can press Send to ask the agent. Any other refusal drops the comment: the tap was for the suggestion.
      kept = ["not_here", "not_eligible", "protected"].includes(e.code);
      if (kept) return;
      updateComments((l) => l.filter((x) => x.id !== c.id));
      const text = useRefusal(e);
      setSg((now) => (now ? (e.code === "busy" ? { ...now, error: text } : { phase: "none", seq: now.seq, req: now.req, text, retry: false }) : now));
    };
    const ok = await send({ suggestion: true, id: cur.card.id, commentId: c.id, fail });
    if (ok || kept) closeQuick(true);
  }

  useEffect(() => {
    const onKey = (e) => {
      const mod = e.metaKey || e.ctrlKey;
      // a modal (the close confirmation, the background picker, the shortcuts list) keeps its own keys: nothing global reaches past it
      const inModal = !!document.activeElement?.closest?.('.scrim, [role="dialog"]:not(.qa)') && !document.activeElement.closest(".qa");
      if (e.key === "Escape" && quickRef.current && !e.isComposing && !inModal && !e.target.closest?.(".qa, [role=\"dialog\"]") && (docRef.current?.contains(e.target) || e.target === document.body)) {
        // Esc closes the open card, then the box, wherever the focus is in the document (the box handles its own Esc). The reader keeps the place they are at now
        // (the box's own Esc is the one that returns to its words), and words typed into the box stay as an unsent comment
        e.preventDefault();
        e.stopPropagation();
        if (sg) {
          sgSeq.current++;
          setSg(null);
        } else {
          const q = quickRef.current;
          closeQuick(false);
          if (q.text.trim()) addComment(q.kind, q.anchor, null, { text: q.text.trim(), quiet: true });
        }
        return;
      }
      if (isQuickAsk(e) && inModal) return;
      if (isQuickAsk(e)) {
        e.preventDefault();
        e.stopPropagation(); // the engine reads Cmd/Ctrl+K (any other modifier too) as "insert a link": it must not see this
        openQuick();
      } else if (mod && e.altKey && e.code === "KeyM") {
        e.preventDefault();
        commentFromKeyboard();
      } else if (mod && !e.altKey && e.code === "Backslash") {
        e.preventDefault();
        toggleSidebar();
      } else if (e.code === "F6" && !mod && !e.altKey) {
        e.preventDefault();
        cycleRegion(e.shiftKey ? -1 : 1);
      } else if (e.key === "?" && !mod && !e.altKey && !phone && !isEditable(e.target) && !(session.format === "xlsx" && e.target.closest?.('[data-testid="docwrap"]')) && !e.target.closest?.(".scrim, .qa")) {
        e.preventDefault();
        setKeysOpen((o) => !o);
      } else if (e.key === "Enter" && mod && !e.altKey && !e.shiftKey && !e.isComposing && !isEditable(e.target) && !inModal && (!e.target.closest?.('[data-testid="docwrap"], .scrim, .qa, .shortcuts') || !!e.target.closest?.('[data-testid="html-catch"]'))) {
        // Cmd/Ctrl+Enter from anywhere outside the document and its text boxes (the engine keeps it inside the document: a page break in Word),
        // and from the HTML view's own layer in Comment and Pin modes (no engine there)
        e.preventDefault();
        if (!(sending || state === "closed" || ro || pendingSend === 0)) send();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  });

  /** F6 / Shift+F6: the engine's editing surface keeps Tab for itself, so landmarks are reached with F6 (as in Word and Excel). */
  function cycleRegion(dir) {
    const targets = [
      () => document.querySelector(".topbar button"),
      () => document.querySelector(".toolbar .mode.on"),
      () => document.querySelector('[data-testid="docwrap"] [contenteditable="true"], [data-testid="docwrap"] .de-scroll, [data-testid="docwrap"] [tabindex]'),
      () => (sideOpen ? document.querySelector("#review-panel button, #review-panel textarea") : null),
    ];
    const regions = [".topbar", ".toolbar", '[data-testid="docwrap"]', "#review-panel"];
    const cur = regions.findIndex((r) => document.activeElement?.closest(r));
    for (let step = 1; step <= targets.length; step++) {
      const i = (((cur < 0 ? (dir > 0 ? -1 : 0) : cur) + dir * step) % targets.length + targets.length) % targets.length;
      const el = targets[i]();
      if (el) {
        el.focus();
        // Chrome puts a caret in the document on focus; Safari leaves none, and Ctrl+Alt+M would have nothing to comment on
        const wrap = document.querySelector('[data-testid="docwrap"]');
        if (i === 2 && wrap?.contains(el) && !wrap.contains(window.getSelection()?.anchorNode)) {
          const text = document.createTreeWalker(wrap.querySelector(".de-p, .de-cell") || wrap, NodeFilter.SHOW_TEXT).nextNode();
          if (text) window.getSelection().collapse(text, 0);
        }
        return;
      }
    }
  }

  /** A History place -> the engine location to scroll to and outline, or null. DOCX learns the engine's block offset from a rendered paragraph with the same words. */
  function historyLoc(p) {
    const l = p.locator;
    const h = hostRef.current;
    if (!l || !h) return null;
    if (l.format === "docx") {
      if (!l.body_path) return null;
      if (deltaRef.current.v !== doc.v) deltaRef.current = { v: doc.v, d: 0 };
      let delta = deltaRef.current.d;
      if (l.text_start) {
        const want = l.body_path[0] + delta;
        let best = null;
        for (const el of document.querySelectorAll(".de-p[data-bi]")) {
          if (!opensWith(el.textContent, l.text_start)) continue;
          const bi = Number(el.dataset.bi);
          if (best == null || Math.abs(bi - want) < Math.abs(best - want)) best = bi;
        }
        if (best != null) deltaRef.current = { v: doc.v, d: (delta = best - l.body_path[0]) };
      }
      return { blockPath: [l.body_path[0] + delta, ...l.body_path.slice(1)] };
    }
    if (l.format === "xlsx") return l.range ? { sheetIndex: infoRef.current.sheets?.find((x) => x.name === l.sheet)?.index ?? 0, sheetName: l.sheet, range: l.range } : null;
    if (l.format === "pptx") return l.slide_index != null ? { slideIndex: l.slide_index, ...(l.shape_id != null ? { shapeId: l.shape_id } : {}) } : null;
    if (l.format === "html") return Number.isInteger(l.node_id) ? { nodeId: l.node_id } : null; // ids of the update's after version (History shows them only while it is current)
    return null;
  }
  const historyCanShow = (p) => !!hostRef.current && !!p.locator && (p.locator.format === "html" ? Number.isInteger(p.locator.node_id) : p.locator.format === "docx" ? !!p.locator.body_path : p.locator.format === "xlsx" ? !!p.locator.range && (!infoRef.current.sheets || infoRef.current.sheets.some((x) => x.name === p.locator.sheet)) : p.locator.format === "pptx" && p.locator.slide_index != null);
  historyLocRef.current = historyLoc;
  /** Scroll to a place and outline it for about two seconds (drawn over the document, never in it). */
  function showPlace(loc) {
    hostRef.current.scrollTo(loc);
    showRef.current = { loc };
    clearTimeout(showTimer.current);
    showTimer.current = setTimeout(() => {
      showRef.current = null;
      redraw();
    }, 2000);
    for (const ms of [0, 120, 350, 800]) setTimeout(redraw, ms); // the engine finishes scrolling and painting a little later
  }
  function historyShow(p) {
    const loc = historyLoc(p);
    if (!loc) return;
    showPlace(loc);
    if (narrow) setDrawer(false);
  }
  /** The "N changes below / above" pill: jump to the first of those places. */
  function awayGo() {
    const a = awayRef.current;
    if (!a || !hostRef.current) return;
    showPlace(a.loc);
  }

  /** The document at a comment's place, for the keyboard: scroll there, and with `focus` put the caret in it (Esc in a comment box). */
  async function peek(c, focus) {
    const loc = resolvedRef.current[c.id]?.loc || c.anchor?.location;
    const h = hostRef.current;
    if (!loc || !h) return;
    await h.scrollTo(loc);
    if (!focus) return;
    const bp = loc.blockPath?.length === 1 ? loc.blockPath : null;
    const para = bp ? document.querySelector(`.de-p[data-bi="${bp[0]}"]`) : null;
    const surface = para?.closest('[contenteditable="true"]') || docRef.current?.querySelector('[contenteditable="true"], .de-scroll, [tabindex]');
    surface?.focus({ preventScroll: true });
    if (!para) return;
    try {
      const w = document.createTreeWalker(para, NodeFilter.SHOW_TEXT);
      const node = w.nextNode();
      if (!node) return;
      const range = document.createRange();
      range.setStart(node, Math.min(loc.start ?? 0, node.length));
      range.collapse(true);
      const ds = window.getSelection();
      ds.removeAllRanges();
      ds.addRange(range);
    } catch {
      /* the focus is already in the document */
    }
  }

  function toggleSidebar() {
    if (narrow) setDrawer((d) => !d);
    else side.setCollapsed(!side.collapsed);
  }

  // click in Comment / Pin mode: capture before the engine sees it
  function anchorFrom(hit, h) {
    const { start, end, ...location } = hit.location; // element and pin anchors drop char offsets
    const para = h.format === "docx" ? paragraphText(location.blockPath) : null;
    return { location, quote: para || hit.quote || "", paraText: para || undefined, prefix: "", suffix: "", format: hit.format, hitKind: hit.kind };
  }

  /** Where a pin sits, as fractions of what it was dropped on (DOCX keeps pixels inside the paragraph, which do not change with zoom there). */
  function pinFor(h, hit, e) {
    const r = hit.rect;
    const fx = r.width ? (e.clientX - r.left) / r.width : 0;
    if (h.format === "pptx") {
      const sr = h.rectsFor({ slideIndex: hit.location.slideIndex })[0] || r;
      const pin = { xFrac: (e.clientX - sr.left) / sr.width, yFrac: (e.clientY - sr.top) / sr.height, yPx: 0, on: "slide" };
      if (hit.location.shapeId != null) Object.assign(pin, { sxFrac: fx, syFrac: r.height ? (e.clientY - r.top) / r.height : 0, on: "shape" });
      return pin;
    }
    if (h.format === "xlsx") return { xFrac: fx, yFrac: r.height ? (e.clientY - r.top) / r.height : 0, yPx: e.clientY - r.top, on: "cell" };
    if (h.format === "docx") return { xFrac: fx, yPx: e.clientY - r.top, on: "paragraph" };
    return null;
  }

  /** XLSX Comment mode: press on a cell and drag to another to comment on the range between them (a click is a one-cell range). */
  function dragRange(e, h) {
    if (e.type !== "mousedown" || e.button !== 0 || e.detail > 1) return; // the second press of a double click belongs to the first: one gesture, one comment
    const start = h.hitTest(e.clientX, e.clientY);
    if (!start) return;
    dragRef.current = { start, cur: start };
    const move = (ev) => {
      const x = hostRef.current?.hitTest(ev.clientX, ev.clientY);
      if (x && dragRef.current) {
        dragRef.current.cur = x;
        redraw();
      }
    };
    const up = (ev) => {
      document.removeEventListener("mousemove", move, true);
      document.removeEventListener("mouseup", up, true);
      const d = dragRef.current;
      dragRef.current = null;
      redraw();
      const end = hostRef.current?.hitTest(ev.clientX, ev.clientY) || d?.cur;
      if (!d || !end) return;
      const range = end.location.sheetName === start.location.sheetName ? unionRange(start.location.range, end.location.range) : start.location.range;
      const same = range === start.location.range;
      const quote = same ? start.quote || "" : [start.quote, end.quote].filter(Boolean).join(" ... ");
      addComment("element", { location: { ...start.location, range }, quote, prefix: "", suffix: "", format: "xlsx", hitKind: same ? start.kind : "range" });
    };
    document.addEventListener("mousemove", move, true);
    document.addEventListener("mouseup", up, true);
  }

  function capture(e) {
    if (modeRef.current === "edit") return; // comments and pins work while the agent holds the file: they are queued
    if (hostRef.current?.format === "html") return; // the HTML view takes its own clicks on its layer (HtmlViewer onPick)
    if (e.target.closest?.(".de-tabs, .de-zoom, .de-fx, .de-thumbs")) return; // navigation stays usable: sheet tabs, zoom, formula bar, slide thumbnails
    e.preventDefault();
    e.stopPropagation();
    const h = hostRef.current;
    if (!h) return;
    if (h.format === "xlsx" && modeRef.current === "comment") return dragRange(e, h);
    if (e.type !== "click") return;
    if (e.detail > 1) return; // the second and third click of a double or triple click belong to the first: one gesture, one comment
    const hit = h.hitTest(e.clientX, e.clientY);
    if (!hit) return;
    const anchor = anchorFrom(hit, h);
    if (modeRef.current === "pin") {
      const pin = pinFor(h, hit, e);
      if (pin) addComment("pin", anchor, pin); // null: a format with no pins
    } else addComment("element", anchor);
  }

  // ---- send / take back / revert ------------------------------------------------------------------------------
  async function send(use = null) {
    if (use && use.suggestion !== true) use = null; // a click handler passes its event
    wiRef.current?.cancel("send");
    const h = hostRef.current;
    // not while Take back, Stop, Revert or Close is in flight: their answer rewrites the note and drafts this Send would carry
    if (!h || sendingRef.current || roRef.current || rewritingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setProblem(null);
    // From the press until the answer, what the Send carries is read only here: its drafts (a Use: only its stamp) and its note. A new
    // comment can still be made; it stays here and is saved after the answer. The state shows only past SLOW_MS (a usual Send is 15 to
    // 80 ms), on the same button and cards, so nothing moves.
    const hold = (ids) => {
      heldRef.current = { ids, note: !use };
      setHeld(heldRef.current);
    };
    hold(new Set(use ? [use.commentId] : commentsRef.current.filter((c) => c.status === "draft").map((c) => c.id)));
    const slowTimer = setTimeout(() => setSlow(true), SLOW_MS);
    let failed = null;
    let at = null; // what it was sent with (web/src/drafts.js)
    let html = false;
    let htmlSent = [];
    try {
      clearTimeout(saveTimer.current);
      draftPendingRef.current = false; // the Send below carries the comments and the note
      saveSeq.current++; // an autosave still in flight no longer speaks for these comments
      saveFails.current = 0;
      setAck(null);
      if (mergeDue.current && !sessionRef.current.locked) {
        await mergeHeld(); // the page holds edits on an older file: they go onto the new one first
        if (mergeDue.current) return; // not merged (it failed and said so): nothing stale is sent
      }
      await h.flush();
      const locked = sessionRef.current.locked;
      const seq = editSeq.current;
      // an HTML file: its pending text edits go as edits (R9), never bytes; read only here until the answer, cleared only when it went through
      html = h.format === "html";
      htmlSent = html && !locked ? h.edits() : [];
      if (htmlSent.length) h.setReadOnly(true, "sending");
      const bytes = !html && !locked && dirtyRef.current ? await h.saveBytes() : null;
      const body = {
        baseSha: loadedShaRef.current,
        ...(bytes ? { bytesB64: await blobToBase64(bytes) } : {}),
        ...(htmlSent.length ? { htmlEdits: htmlSent } : {}),
        comments: commentsRef.current.map(toWire),
        note: noteRef.current,
        edits: locked ? [] : changesRef.current.map(({ kind, before, after, label, location }) => ({ kind, before, after, label, location })),
        viewState: (sentViewRef.current = h.getViewState()),
        rev: ++revRef.current,
        noteRev: draftsRef.current.noteRev,
        seen: draftsRef.current.seen, // the newest session state this page took
        noteSeen: draftsRef.current.noteSeen, // ... and whose note the box took: a note the server gave back since is merged, not overwritten
      };
      if (!use) hold(new Set(commentsRef.current.filter((c) => c.status === "draft").map((c) => c.id))); // one made while the file was flushed goes too
      if (!use) body.sends = [...heldRef.current.ids]; // what it delivers: what this page holds read only for it
      const q = quickChangeRef.current;
      if (!use && q && !bytes && !commentsRef.current.some(ridesAlong) && !body.edits.length && q.note === noteRef.current) body.quick = { command: q.command, count: q.count };
      at = draftsRef.current.begin({ note: body.note, carriesNote: true, sends: heldRef.current.ids, wire: body.rev, comments: commentsRef.current });
      let out;
      // its answer, or the server's state showing it committed (an event, any answer: `sent` names this Send), whichever comes first: an
      // answer that never arrives does not keep what it carried locked once the outcome is known
      const proof = new Promise((resolve) => (sentWaitRef.current = { rev: body.rev, resolve }));
      try {
        out = await Promise.race([api(use ? `/api/suggest/use?s=${sid}` : `/api/send?s=${sid}`, { method: "POST", timeout: SEND_MS, body: use ? { ...body, id: use.id, commentId: use.commentId } : body }), proof.then((session) => ({ session }))]); // Use this: the same body, plus the suggestion's id and the comment
      } catch (e) {
        if (e.status != null) throw e;
        // no answer (the connection dropped, or the page is being left): the Send may still have gone through. Until that is known what it
        // carried stays read only, saying so, and the server is asked again until it answers (GET /api/bootstrap waits for this file's
        // Send): `sent` names the newest Send of this tab that committed
        heldRef.current = { ...heldRef.current, checking: true };
        setHeld(heldRef.current);
        const view = await Promise.race([checkSent(), proof]);
        if (!(view.sent?.[TAB]?.rev >= body.rev)) throw e; // it did not go through: everything is a draft again
        out = { session: view }; // it went through: the same as its answer
      }
      if (!locked && html && htmlSent.length) {
        // the server wrote the text edits: they leave the viewer, and the page shows the new version (its bytes are the server's)
        h.clearEdits();
        setChanges([]);
        reloadNowRef.current?.(out.session);
      } else if (!locked) {
        loadedShaRef.current = out.session.baseSha;
        syncedShaRef.current = out.session.baseSha;
        // typed during the request: those edits are not in what was sent, so the page stays dirty and they are merged or sent later
        if (editSeq.current === seq) {
          dirtyRef.current = false;
          setChanges([]);
        }
      }
      // once: what it carried becomes sent (or queued) as the server says, and the note it carried leaves the box (applyServer: the box
      // could not change meanwhile, so the server's empty note is based on it); a comment made meanwhile stays a draft. A Use carries no
      // note to the agent (Sessions.useSuggestion keeps it), so the box keeps it. The event stream may have said the same already
      draftsRef.current.end(at, true);
      at.done = true;
      mergeRef.current?.(out.session, at);
      return true;
    } catch (e) {
      failed = e;
      use?.fail(e);
      if (e.code === "conflict") setProblem({ kind: "conflict", message: e.message, side: e.side || "user", copy: e.copy_name ? { name: e.copy_name, path: e.copy_path } : null, copyError: e.copy_error || null, canReveal: !!e.can_reveal });
      else setProblem({ kind: "error", message: plain(e) });
      // an HTML page whose edits were made on another version: it shows the file as it is now and places them again (by their text)
      if (html && e.code === "version_changed") loadFile().catch((err) => setProblem({ kind: "error", message: `Could not reload: ${err.message}` }));
    } finally {
      if (html && htmlSent.length) h.setReadOnly(false, "sending");
      if (handingRef.current === "waiting") setTimeout(handOver, 0); // this tab lost editing during the Send: now hand over what is left
      sentWaitRef.current = null;
      if (at && !at.done) draftsRef.current.end(at, false);
      // everything it carried is editable again: sent now, or a draft as before when it failed
      clearTimeout(slowTimer);
      heldRef.current = null;
      setHeld(null);
      setSlow(false);
      sendingRef.current = false;
      setSending(false);
      // saved now: a comment made during the wait, and after a Send that failed (a refusal changes nothing on the server), the drafts it carried
      if (draftPendingRef.current || failed) saveDraftSoon();
      if (sendAgainRef.current) {
        sendAgainRef.current = false;
        const chip = sentChipRef.current;
        sentChipRef.current = null;
        setTimeout(() => Promise.resolve(sendFnRef.current?.()).then((ok) => ok && chip && sentChip(chip)), 0);
      }
    }
  }
  /** After a request with no answer: the session as the server holds it once that request's turn is over, asked again (soon, then every 5 s) until it answers. */
  async function checkSent() {
    for (let i = 0; ; i++) {
      const view = await api(`/api/bootstrap?s=${sid}`).then((r) => r.session, () => null);
      if (view) return view;
      await new Promise((r) => setTimeout(r, Math.min(retryDelay(i) ?? 5000, 5000)));
    }
  }
  sendFnRef.current = send;


  /** A tap on a question card: the server checks the index and makes the comment a draft again; a picked option is sent at once. */
  async function answer(id, choice) {
    if (roRef.current) return;
    try {
      setProblem(null);
      const out = await api(`/api/answer?s=${sid}`, { method: "POST", body: { id, choice } });
      if (out.session) setSession(out.session);
    } catch (e) {
      setProblem({ kind: "error", message: plain(e) }); // nothing is sent without the answer
      return false;
    }
    if (choice === null) return updateComments((l) => l.map((c) => (c.id === id ? { ...c, status: "draft", question: undefined, answer: undefined, result: undefined, retry: true } : c)));
    if (sendingRef.current) sendAgainRef.current = true; // a Send is in flight: the answer goes out right after it
    else send();
  }

  /** A tap on a review button or a suggestion card (src/review.js): only a kind, or ids and a whole number, go to the server. False when refused. */
  async function act(path, body) {
    if (roRef.current) return false;
    try {
      setProblem(null);
      const out = await api(`/api/${path}?s=${sid}`, { method: "POST", body });
      if (out.session) setSession(out.session);
    } catch (e) {
      setProblem({ kind: "error", message: plain(e) });
      return false;
    }
  }
  /** A tap on one of the background agent's buttons: only an action name (and cli or on) goes to the server. */
  async function agentAct(action, extra = {}) {
    // Stop takes the batch back like Take back: its answer brings the withdrawn batch's note back with its comments, joined with the box as
    // the server held it (stopAgent saved it first); words typed since stay too (applyServer)
    const at = action === "stop" && extra.takeBack ? draftsRef.current.begin({ rewrites: true }) : null;
    if (at) outRef.current++;
    try {
      setProblem((p) => (p?.stream || p?.kind === "outside" ? p : null)); // a lost connection and an outside change are still true after a button press
      const out = await api(`/api/agent?s=${sid}`, { method: "POST", body: { action, ...extra } });
      if (at) draftsRef.current.end(at, true);
      if (out.session) setSession(out.session);
      if (at && out.session) applyServer(out.session, at);
      return true;
    } catch (e) {
      if (at) draftsRef.current.end(at, false);
      if (at && e.status == null) return afterLost(at); // no answer: what the server holds now goes in, before any save carries the note
      setProblem({ kind: "error", message: plain(e) });
      return false;
    } finally {
      if (at) outRef.current--;
    }
  }
  /** Stop (the working banner): one call takes the batch back and ends the agent; the comments come back as drafts. */
  async function stopAgent() {
    if (stopping || roRef.current) return;
    if (rewritingRef.current || sendingRef.current) return say(BUSY_WORDS); // one at a time, and not during a Send
    setStopping(true);
    rewrite(1);
    let ok = false;
    try {
      // what is typed is saved first, so the take back joins it with the withdrawn note; not saved: Stop does not go, and says so
      if (await flushDrafts()) ok = await agentAct("stop", { takeBack: true });
      else setProblem({ kind: "error", message: plain(new Error("Failed to fetch")) });
    } finally {
      rewrite(-1);
      setStopping(false);
    }
    if (ok) {
      say("Stopped. Your comments are drafts again.");
      setTimeout(() => document.querySelector('[data-testid="send"]')?.focus(), 0); // the Stop button goes with its banner: focus moves on (after the drafts render), not to the page body
    }
  }
  /** "Show me" on a note card: the same scroll and outline as History's Show; the place comes from the server's record, not from agent text. */
  function showSuggestion(g) {
    const at = g.at;
    if (!at) return;
    const start = at.format === "docx" && !g.before.startsWith("…") ? normTxt(g.before).slice(0, 160) : undefined;
    historyShow({ locator: { ...at, ...(start ? { text_start: start } : {}) } });
  }

  /**
   * The file on disk changed (an agent run landed) while this page holds edits made on the older version. The server
   * carries them onto the new file, then the page reloads it. Typing during the first pass is caught by a second, with the editor
   * paused for that moment. What cannot be placed is shown with its text (never dropped); when that list stands for more than it
   * shows, the server keeps a copy of this page's file and its name is shown too. While another batch is delivered the server
   * answers 423: the edits stay here and this runs again when the agent lets go.
   */
  async function mergeHeld(view = sessionRef.current) {
    const h = hostRef.current;
    // `view` is the session as the event just delivered it (the ref only follows on the next render)
    if (!h || merging.current || !mergeDue.current || view.locked) return;
    merging.current = true;
    try {
      let base = loadedShaRef.current;
      let sha = view.baseSha; // the session's version once the merge is written
      const back = [];
      let copy = null;
      for (let pass = 0; pass < 2; pass++) {
        if (pass === 1) h.setReadOnly(true);
        await h.flush();
        const seq = editSeq.current;
        // the kinds of edits this page saw: the server cannot read formatting, sizes or moved rows out of the file, and says they were not carried
        const edits = changesRef.current.map((c) => ({ kind: c.kind, sheet: c.location?.sheetName ?? null, slide: c.location?.slideIndex ?? null }));
        const r = await api(`/api/merge?s=${sid}`, { method: "POST", body: { baseSha: base, bytesB64: await blobToBase64(await h.saveBytes()), edits } });
        for (const u of r.unplaced || []) if (!back.some((x) => x.why === u.why && x.text === u.text)) back.push(u); // the second pass repeats what the first said
        if (r.copy_name) copy = r.copy_name; // the later copy holds everything the earlier one does
        if (r.sha) sha = r.sha;
        await h.flush(); // typed during the request and not reported yet (an open cell, a shape): it counts as typed since
        if (editSeq.current === seq) break;
        if (!r.mineSha) break;
        base = r.mineSha;
      }
      mergeDue.current = false;
      if (back.length) {
        setHeldBack(back);
        setHeldCopy(copy);
      }
      await reloadNowRef.current?.({ ...view, baseSha: sha }, { merged: true }); // a merge ran: the changes are not shown in place
    } catch (e) {
      h.setReadOnly(roRef.current);
      if (e.code === "locked") return; // the next batch is already with the agent: try again when it is done
      if (!e.status && !e.code) {
        // the server was not reached: the edits stay in this page and the merge is tried again
        setProblem({ kind: "error", retrying: true, message: "Could not reach Onionskin to merge what you typed. Your edits are still in this page. Trying again." });
        return retryLaterRef.current?.();
      }
      mergeDue.current = false;
      if (e.code === "conflict") setProblem({ kind: "conflict", message: e.message, side: e.side || "user", copy: e.copy_name ? { name: e.copy_name, path: e.copy_path } : null, copyError: e.copy_error || null, canReveal: !!e.can_reveal });
      else setProblem({ kind: "error", message: `What you typed while the agent worked could not be merged into its version (${plain(e)}). Your edits are still in this page: download them before you reload.` });
    } finally {
      merging.current = false;
    }
  }
  mergeHeldRef.current = mergeHeld;

  async function post(path, body = {}) {
    // Take back, Revert and Close: what is typed is saved first, and the answer (the withdrawn batch's note joined with the box, a run on this
    // Mac's request back in an empty box) goes in through applyServer, so words typed meanwhile stay
    const rewrites = path === "takeback" || path === "revert" || path === "close";
    if (rewrites && (rewritingRef.current || sendingRef.current)) return say(BUSY_WORDS); // one at a time, and not during a Send
    let at = null;
    if (rewrites) rewrite(1);
    try {
      setProblem(null);
      if (rewrites) {
        if (!(await flushDrafts())) throw new Error("Failed to fetch"); // not saved first: the action does not go, and the words stay here
        at = draftsRef.current.begin({ rewrites: true });
        outRef.current++;
      }
      const out = await api(`/api/${path}?s=${sid}`, { method: "POST", body });
      if (at) draftsRef.current.end(at, true);
      if (out.session) setSession(out.session);
      if (at && out.session) applyServer(out.session, at);
      // a run on this Mac was undone: its request comes back to an empty note box, and the next Send goes to the agent
      if (path === "revert" && out.session?.activity?.find((a) => a.id === body.id)?.by === "local") say("Undone. Press Send to ask the agent instead.");
    } catch (e) {
      if (at) draftsRef.current.end(at, false);
      if (at && e.status == null) await afterLost(at); // no answer: what the server holds now goes in, before any save carries the note
      else setProblem({ kind: "error", message: plain(e) });
    } finally {
      if (at) outRef.current--;
      if (rewrites) rewrite(-1);
    }
  }
  /**
   * Take back, Stop, Revert or Close got no answer: it may have changed the note. The note stays read only and out of every save until the
   * server's state is known (asked until it answers), which then goes in as that action's answer would have (applyServer).
   */
  async function afterLost(at) {
    const view = await checkSent();
    setSession(view);
    applyServer(view, at);
    return true;
  }

  // "Copy my comments" on the Connection lost banner: the note and every draft, as plain text. writeText is called synchronously in the click (Safari).
  function copyComments() {
    const drafts = commentsRef.current.filter((c) => c.status === "draft" && c.text.trim());
    const parts = [];
    if (noteRef.current.trim()) parts.push(`Overall instructions:\n${noteRef.current.trim()}`);
    drafts.forEach((c, i) => parts.push(`${i + 1}. ${c.anchor?.quote ? `On "${c.anchor.quote}":\n` : ""}${c.text.trim()}`));
    if (!parts.length) return say("There are no comments or note to copy.");
    const blocked = () => say("The browser did not allow copying. Select the words in each comment and copy them yourself.");
    let p = null;
    try {
      p = navigator.clipboard ? navigator.clipboard.writeText(parts.join("\n\n")) : null;
    } catch {
      p = null;
    }
    if (!p) return blocked();
    p.then(() => say(!drafts.length ? "Your note was copied." : drafts.length === 1 ? "1 comment copied." : `${drafts.length} comments copied.`), blocked);
  }

  async function keepMine() {
    const h = hostRef.current;
    if (!h || h.format === "html") return; // an HTML page holds no bytes of its own: its edits stay in the viewer
    const blob = await h.saveBytes();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = session.name.replace(/(\.[^.]+)$/, " (my edits)$1");
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  const counts = {
    comments: comments.filter((c) => c.kind !== "pin" && ["draft", "queued"].includes(c.status)).length,
    pins: comments.filter((c) => c.kind === "pin" && ["draft", "queued"].includes(c.status)).length,
    edits: session.format === "html" ? htmlEdits : changes.length, // an HTML file: the viewer's pending text edits (an undo takes one away)
  };
  // While a batch is delivered, typed edits are not something to send: they are merged when the agent finishes.
  const sendCounts = session.locked ? { ...counts, edits: 0 } : counts;
  const pendingSend = sendCounts.comments + sendCounts.pins + sendCounts.edits + (note.trim() ? 1 : 0);
  const state = session.state;
  // a quick change (src/quick-plan.js): only when the Send would be just the note. The button then shows the count the server found;
  // pressing it sends that number along, and the server counts again before it writes.
  const quickMatch = useQuickPreview({ sid, note, stamp: session.baseSha, enabled: !ro && !session.locked && state !== "closed" && noteAlone({ comments, edits: counts.edits, dirty: dirtyRef.current }) });
  const quickOn = !!quickMatch?.local && quickAgentFor !== note;
  quickChangeRef.current = quickOn ? { command: quickMatch.command, count: quickMatch.count, note, label: quickMatch.label } : null;

  return (
    <div className="app" data-state={state} data-theme-now={theme} data-testid="app" data-fresh={fresh ? "1" : "0"}>
      <Backdrop name={bgc.bg.kind === "custom" ? "custom" : bgc.bg.name} image={bgc.image} effective={bgc.effective} testid="backdrop" />
      <div className={`shell ${sideOpen && !narrow ? "side-open" : ""}`} style={{ "--side-w": `${side.width}px` }}>
        <main className="stage">
          <TopBar
            readOnly={ro}
            product={product}
            session={session}
            counts={counts}
            pending={pendingSend}
            sending={slow}
            theme={theme}
            onTheme={() => setTheme(theme === "dark" ? "light" : "dark")}
            bgOpen={bgOpen}
            onBackground={() => setBgOpen((o) => !o)}
            sideOpen={sideOpen}
            onSidebar={toggleSidebar}
            onClose={() => ((sessionRef.current.format === "html" ? htmlEditsRef.current > 0 || (hostRef.current?.lostEdits?.()?.length ?? 0) > 0 : changesRef.current.length > 0) || dirtyRef.current ? setCloseAsk(true) : post("close"))}
            keysOpen={keysOpen}
            onKeys={() => setKeysOpen((o) => !o)}
          />
          <Toolbar mode={mode} onMode={setMode} setBar={setBar} readOnly={ro} phone={phone} />
          <div className="docstage">
            <div className={`docwrap mode-${mode}`} ref={docRef} onMouseDownCapture={capture} onClickCapture={capture} data-testid="docwrap" data-working={state === "working" || state === "queued" ? "1" : "0"}>
              {session.format === "html" ? (
                doc.html ? (
                  <HtmlHost
                    view={doc.html}
                    mode={mode}
                    marks={htmlMarks(comments, resolved, doc.html.version)}
                    locked={!!session.locked}
                    edits={htmlEdits}
                    onHost={onHost}
                    onWant={(plainView) => loadFile({ plain: plainView }).catch((e) => setProblem({ kind: "error", message: `Could not load the file: ${e.message}` }))}
                  />
                ) : (
                  <p className="opening" role="status">
                    <span className="spinner" aria-hidden="true" /> Opening {session.name}
                  </p>
                )
              ) : doc.file ? (
                <DocViewer
                  key={doc.v}
                  src={doc.file}
                  name={session.name}
                  editable
                  toolbar={false}
                  comments={false}
                  allowOpen={false}
                  fileMenu={false}
                  allowSave={false}
                  allowDownload={false}
                  editBarTarget={bar}
                  zoom={phoneAtMount && session.format === "docx" ? 1 : "fit"} /* a phone reads a page at full size and pans; fit makes the text unreadably small */
                  theme={theme}
                  style={{ height: "100%" }}
                  onHost={onHost}
                  onError={(e) => setProblem({ kind: "error", message: `The viewer could not open this file: ${e.message}` })}
                />
              ) : (
                <p className="opening" role="status">
                  <span className="spinner" aria-hidden="true" /> Opening {session.name}
                </p>
              )}
            </div>
            <div className="sheen-edge" aria-hidden="true" data-on={state === "working" || state === "queued" ? "1" : "0"} />
            <Overlay
              boxRef={overlayRef}
              paint={paint}
              onChip={onChip}
              onQuickChip={openQuick}
              onPin={(id) => setFocusId(id)}
              onThumb={(i) => hostRef.current?.scrollTo({ slideIndex: i })}
              version={doc.v}
              fresh={fresh}
              quick={phone ? null : quick}
              onQuickText={(text) => setQuick((q) => (q ? { ...q, text, nudge: false } : q))}
              onQuickSubmit={submitQuick}
              stamps={session.format === "html" ? null /* PLAN-html D9: no stamps for an HTML file */ : { ...stampsCtl, suggest: { sg, busy: slow, on: suggestOn, oneSentence: oneSentenceNote(), tasks: suggest?.tasks, unavailable: suggest?.unavailable, format: session.format, onOn: () => setSuggestOn(true), onStamp: stampTap, onUse: useSuggestion, onAgent: () => submitQuick(sg?.req?.words), onRetry: () => sg?.req && askSuggest(sg.req), onCardClose: () => { sgSeq.current++; setSg(null); } } }}
              onQuickClose={closeQuick}
              onAway={awayGo}
              canQuick={!phone}
            />
          </div>
          <Banners
            readOnly={ro}
            onTakeOver={() => post("claim", { takeover: true })}
            session={session}
            heldBack={heldBack}
            heldCopy={heldCopy}
            onHeldBackDone={() => setHeldBack(null)}
            problem={problem}
            notice={notice}
            noticeAction={noticeAction}
            onStop={stopAgent}
            stopping={stopping}
            onTakeBack={() => post("takeback")}
            onAgent={agentAct}
            onShowCopy={(p) => api(`/api/show-copy?s=${sid}`, { method: "POST", body: { path: p } }).catch((e) => setProblem({ kind: "error", message: plain(e) }))}
            onDismissConflict={() => post("dismiss-conflict")}
            onReloadDisk={() => {
              setProblem(null);
              if (!sessionRef.current.locked) outsideSeen.current = false; // the server now knows the disk version (loadForPage), and says nothing: the next outside save is a new turn
              if (sessionRef.current.conflict) post("dismiss-conflict");
              restoreRef.current = true; // comments and pins are placed again on the changed file
              loadFile().catch((e) => setProblem({ kind: "error", message: `Could not reload: ${e.message}` }));
            }}
            onKeepMine={keepMine}
            onCopyComments={copyComments}
            unsentEdits={counts.edits}
            closeAsk={closeAsk}
            onCloseAnyway={() => (setCloseAsk(false), post("close"))}
            onCloseCancel={() => setCloseAsk(false)}
            onDismiss={() => setProblem(null)}
          />
        </main>
        {bgOpen && <BackgroundPicker ctl={bgc} onClose={(refocus) => (setBgOpen(false), refocus && document.querySelector('[data-testid="bg-button"], [data-testid="more-menu"]')?.focus())} />}
        {phone && <Dock mode={mode} onMode={setMode} readOnly={ro} counts={sendCounts} pending={pendingSend} sideOpen={sideOpen} onSidebar={toggleSidebar} sending={slow} />}
        <Sidebar
          readOnly={ro}
          open={sideOpen}
          narrow={narrow}
          phone={phone}
          width={side.width}
          onWidth={side.setWidth}
          onToggle={toggleSidebar}
          session={session}
          sid={sid}
          historyKey={`${session.seq}:${doc.v}`}
          historyCanShow={historyCanShow}
          onHistoryShow={historyShow}
          comments={comments}
          resolved={resolved}
          activeSheet={activeSheet}
          note={note}
          changes={changes}
          counts={sendCounts}
          heldEdits={session.locked && session.format === "docx" ? counts.edits : 0}
          pendingSend={pendingSend}
          sending={slow}
          busy={sending}
          held={held}
          rewriting={rewriting}
          focusId={focusId}
          onFocused={() => setFocusId(null)}
          ack={ack}
          onNote={updateNote}
          onText={(id, text) => !heldRef.current?.ids.has(id) && updateComments((l) => l.map((c) => (c.id === id ? { ...c, text } : c)))}
          onDelete={(id) => !heldRef.current?.ids.has(id) && !["sent", "queued"].includes(commentsRef.current.find((c) => c.id === id)?.status) && updateComments((l) => l.filter((c) => c.id !== id))}
          onAnswer={answer}
          agentPanel={<AgentPanel agent={session.agent} readOnly={ro} onAct={agentAct} />}
          onReview={(kind) => act("review", { kind })}
          onSuggest={(ids, choice) => act("suggestion", { ids, choice })}
          onShowSuggestion={showSuggestion}
          onSend={send}
          quickMatch={quickMatch}
          quickLabel={quickOn ? quickMatch.label : null}
          quickAgent={quickAgentFor === note}
          onQuickAgent={(agent) => setQuickAgentFor(agent ? note : null)}
          onPeek={(c) => {
            // holding the key runs through the boxes: the document scrolls once, to where the focus ended up (the engine does not like overlapping scrolls)
            clearTimeout(peekTimer.current);
            peekTimer.current = setTimeout(() => peek(c, false), 160);
          }}
          onBack={(c) => {
            clearTimeout(peekTimer.current);
            peek(c, true);
          }}
          onRevert={(id) => post("revert", { id })}
          onGoto={(c) => {
            const loc = resolved[c.id]?.loc || c.anchor?.location;
            if (loc) hostRef.current?.scrollTo(loc);
            if (narrow) setDrawer(false);
          }}
        />
      </div>
    </div>
  );
}

// ---- overlay helpers --------------------------------------------------------------------------------------------

/** The part of the overlay where a comment can be drawn: the page area (DOCX), the slide scroller (PPTX) or the cells below the headers (XLSX). Client coordinates. */
function clipFor(fmt, wrap, box) {
  const inter = (a, b) => ({ left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) });
  if (!wrap) return box;
  if (fmt === "pptx") {
    const sc = wrap.querySelector(".de-scroll");
    return sc ? inter(box, sc.getBoundingClientRect()) : box;
  }
  if (fmt === "xlsx") {
    const g = wrap.querySelector(".de-grid-view");
    const corner = wrap.querySelector(".de-corner")?.getBoundingClientRect();
    if (!g) return box;
    const r = g.getBoundingClientRect();
    return inter(box, { left: r.left + (corner?.width ?? 0), top: r.top + (corner?.height ?? 0), right: r.right - 12, bottom: r.bottom - 12 });
  }
  return box;
}

/** The frozen panes of the shown sheet: how many rows and columns, and where their edges are (client coordinates). The grid answers who sits just inside each edge. */
function frozenOf(h, wrap, clip) {
  const out = { rows: 0, cols: 0, bottom: clip.top, right: clip.left };
  const fh = wrap?.querySelector(".de-freeze-h")?.getBoundingClientRect();
  const fv = wrap?.querySelector(".de-freeze-v")?.getBoundingClientRect();
  if (fh) {
    const r = parseA1(h.hitTest(clip.left + 8, fh.top - 3)?.location?.range);
    if (r) Object.assign(out, { rows: r.r1 + 1, bottom: fh.bottom });
  }
  if (fv) {
    const r = parseA1(h.hitTest(fv.left - 3, clip.top + 8)?.location?.range);
    if (r) Object.assign(out, { cols: r.c1 + 1, right: fv.right });
  }
  return out;
}

const PIN_OFFSETS = [[16, -16], [-16, -16], [16, 16], [-16, 16]];
/**
 * A pin must not sit on the word it points at: the marker is drawn up and to the side of the point (the first free corner that stays
 * inside `area`) and a short leader with a dot marks the exact spot.
 */
function pinPlace(x, y, area, lx, ly) {
  const ok = ([dx, dy]) => x + dx > area.left + 14 && x + dx < area.right - 14 && y + dy > area.top + 14 && y + dy < area.bottom - 14;
  const [dx, dy] = PIN_OFFSETS.find(ok) || PIN_OFFSETS[0];
  return { pin: { x: lx(x + dx), y: ly(y + dy) }, dot: { x: lx(x), y: ly(y) } };
}

/**
 * The pill for places an agent run changed that are not in view: {n, dir} for the nearest direction with changes (below first), or null.
 * `ref.current` gets {loc}, the first such place, for the click. Ceiling: a DOCX paragraph the engine has not rendered is placed by its block
 * index against the rendered blocks, and an XLSX place on a sheet that is not shown is not counted.
 */
function awayPill(h, fmt, clip, pl, ref) {
  ref.current = null;
  if (!pl.list.length || Date.now() > pl.until) return null;
  let lo = Infinity;
  let hi = -Infinity;
  if (fmt === "docx") {
    for (const el of document.querySelectorAll(".de-p[data-bi]")) {
      const b = Number(el.dataset.bi);
      const r = el.getBoundingClientRect();
      if (r.bottom > clip.top && r.top < clip.bottom) (lo = Math.min(lo, b)), (hi = Math.max(hi, b));
    }
  }
  const slide = fmt === "pptx" ? h.getViewState()?.slideIndex : null;
  const above = [];
  const below = [];
  for (const loc of pl.list) {
    const rs = h.rectsFor(loc);
    let at = 0; // -1 above the view, 1 below it, 0 in view or unknown
    if (rs.length) {
      const top = Math.min(...rs.map((r) => r.top));
      const bottom = Math.max(...rs.map((r) => r.bottom));
      at = bottom <= clip.top ? -1 : top >= clip.bottom ? 1 : 0;
    } else if (fmt === "docx" && loc.blockPath && lo <= hi) at = loc.blockPath[0] < lo ? -1 : loc.blockPath[0] > hi ? 1 : 0;
    else if (fmt === "pptx" && slide != null && loc.slideIndex != null) at = loc.slideIndex < slide ? -1 : loc.slideIndex > slide ? 1 : 0;
    if (at < 0) above.push(loc);
    else if (at > 0) below.push(loc);
  }
  const list = below.length ? below : above;
  if (!list.length) return null;
  ref.current = { loc: list[0] };
  return { n: list.length, dir: below.length ? "below" : "above" };
}

/** The engine says at hit time that a PPTX shape is read-only (location.protected); the server does not know, so the flag is carried over to the re-resolved place. */
const withProtected = (loc, c) => (loc && c?.anchor?.location?.protected ? { ...loc, protected: true } : loc);

/** Two view states show the same place (same top paragraph and offset, same sheet corner, same slide). */
const viewKey = (v) => (v?.format === "html" ? `h|${v.version}|${Math.round((v.y || 0) / 8)}` : v?.format === "docx" ? `d|${v.blockPath?.[0]}|${v.textHash}|${Math.round((v.offsetPx || 0) / 8)}` : v?.format === "xlsx" ? `x|${v.sheetIndex}|${v.topLeft}` : v?.format === "pptx" ? `p|${v.slideIndex}` : "");
const normTxt = (t) => String(t || "").replace(/\s+/g, " ").trim();
/** A rendered paragraph starts with History's `text_start`: the server keeps 160 characters, cut to 148 plus "…[truncated]" when longer. */
const opensWith = (text, start) => (start.endsWith("…[truncated]") ? normTxt(text).startsWith(start.slice(0, -"…[truncated]".length)) : normTxt(text).slice(0, 160) === start);

const TAG_ROOM = 84; // a "changed" tag (about 64 px) plus its gap and a little air
/** Regions the server found changed (post-run diff), as overlay rectangles for whatever is rendered now. */
function changedPaint(h, fmt, session, info, active, clip, cut, local, skip) {
  const run = session.activity[0]; // only the newest entry, and only an agent run that stands: a revert puts the old bytes back, nothing there changed
  const items = run?.kind === "agent" && !run.reverted ? run.changes?.items : null;
  if (!items?.length) return [];
  const out = [];
  const add = (r, kind, tag) => {
    const c = cut(r);
    if (c && out.length < 80) out.push({ ...local(c), kind, tag });
  };
  if (fmt === "docx") {
    const els = [...document.querySelectorAll(".de-p[data-bi]")];
    const byText = new Map();
    for (const el of els) byText.set(normTxt(el.textContent).slice(0, 160), el);
    let tagged = 0;
    for (const it of items) {
      const el = byText.get(it.text);
      if (!el || !it.text || skip?.has(Number(el.dataset.bi))) continue; // drawn in place instead (writein-live.js)
      const r = el.getBoundingClientRect();
      // the tag goes in the page margin right of the paragraph, where there is no text; with no room there (a narrow page) it sits above
      const edge = Math.min(el.closest(".de-page")?.getBoundingClientRect().right ?? clip.right, clip.right);
      add(r, it.kind, tagged++ < 6 && (edge - r.right >= TAG_ROOM ? "side" : "above"));
    }
  } else if (fmt === "xlsx") {
    let tagged = 0;
    for (const it of items) {
      if (it.sheetName !== active) continue;
      const rs = h.rectsFor({ sheetIndex: info.sheets?.find((x) => x.name === it.sheetName)?.index ?? 0, sheetName: it.sheetName, range: it.range });
      if (rs[0]) add(rs[0], it.kind, tagged++ < 6);
    }
  } else if (fmt === "html") {
    // node ids of the version the run left: drawn only while the page shows exactly that version
    if (h.version !== run.postSha) return [];
    let tagged = 0;
    for (const it of items) {
      const rs = Number.isInteger(it.nodeId) ? h.rectsFor({ nodeId: it.nodeId }) : [];
      if (rs[0]) add(rs[0], it.kind, tagged++ < 6);
    }
  } else if (fmt === "pptx") {
    const idx = (id) => info.slides?.find((x) => String(x.id) === String(id))?.index;
    let tagged = 0;
    for (const it of items) {
      const si = idx(it.slideId);
      if (si == null) continue;
      const rs = h.rectsFor(it.shapeId != null ? { slideIndex: si, shapeId: it.shapeId } : { slideIndex: si });
      if (rs[0]) add(rs[0], it.kind, tagged++ < 6);
    }
  }
  return out;
}

/** A count badge on the thumbnail of every slide that has comments (the thumbnails are the engine's; the badge is drawn over them). */
function thumbBadges(wrap, comments, resolved, box, lx, ly) {
  const strip = wrap?.querySelector(".de-thumbs");
  if (!strip) return [];
  const sr = strip.getBoundingClientRect();
  const counts = new Map();
  for (const c of comments) {
    const rz = resolved[c.id];
    const loc = rz ? rz.loc : c.anchor?.location;
    if (loc?.slideIndex != null) counts.set(loc.slideIndex, (counts.get(loc.slideIndex) || 0) + 1);
  }
  const thumbs = [...strip.querySelectorAll(".de-thumb")];
  const out = [];
  for (const [index, count] of [...counts].sort((a, b) => a[0] - b[0])) {
    const r = thumbs[index]?.getBoundingClientRect();
    if (!r || r.bottom < sr.top + 8 || r.top > sr.bottom - 8) continue;
    out.push({ index, count, x: lx(r.right - 2), y: ly(Math.max(r.top, sr.top) + 2) });
  }
  return out;
}

/** Whether a Send that carried drafts `ids` and `note` went through, from a state the server gave after its turn. */

function toWire(c) {
  return { id: c.id, kind: c.kind, text: c.text, anchor: c.anchor, pin: c.pin, pinNo: c.pinNo };
}

export { labelFor };
