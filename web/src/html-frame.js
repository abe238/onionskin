// The HTML view's controller (PLAN-html R14): the one interaction path, the same in every browser, with NO listener inside the frame
// (WebKit never fires listeners the page adds there: spike S1). The page
//  - polls the frame's selection and scroll on a timer (and its own rAF for marks),
//  - in comment and pin modes covers the frame with a transparent layer of its own and asks the frame's document what is under the
//    pointer (elementFromPoint),
//  - shows a copy whose parts the person may type in are editable as the frame parses it (src/html.js editHosts), so a key pressed
//    right after a click is never lost, and reads what was typed by comparing with the last text it knew, on the timer and at flush:
//    the part under the caret on every tick, and the others in turn.
// Every call on a frame node goes through realmDom (getters and methods of the page's own realm, R4). Nothing reads a property of a
// frame object. No `addEventListener` call in this file targets a frame node, document or window (test/html-frame-listeners.test.js).

import { anchorFromElement, anchorFromRange, buildIndex, canType, crashFlag, createEdits, editableSet, editHash, emptiedSlots, identities, locatedOf, rangeOfLocation, realmDom, registerSlot, replaceHidden, restoreShape, SAY, shapeOf, slotNodes, slotOfNode, slotText, typedChange } from "./html-view.js";

const TICK_MS = 50;
// The parts the person may type in come editable in the copy (src/html.js editHosts). An element with more than EDIT_HOST_MAX nodes in
// it is not a part: its own text (text right in a `body` of a long page, say) is made editable at the click, as before, so a key pressed
// in the 50 ms after that click is lost, and that element is compared whole on every tick while typed in. Ceiling of that path only.
const ARM_MS = 8; // one task of the pass that reads the parts, at most (a page at the limits takes several)
// Nodes of editable parts compared per tick besides the one under the caret (a click elsewhere and typing within one tick is seen
// there). A page with more than this is compared in turn: such typing is seen within (its nodes / SCAN_NODES) ticks, and at flush.
const SCAN_NODES = 500;
const HINT_MS = 4500;
const FLASH_MS = 1600;
const DRAG_PX = 4; // comment mode: a press that moves this far selects text instead of picking the element

/**
 * `ui(patch)`: the React shell's state setter (phase, paint, hover, hint, hideAt, flash, hiddenCount, locked).
 * `flag`: the crash flag store (html-view.js crashFlag), injectable for tests.
 */
export function createFrameView({ ui, flag = crashFlag(), focusPage = null }) {
  const subs = { sel: new Set(), edit: new Set(), pick: new Set(), blocked: new Set(), view: new Set(), mark: new Set(), lost: new Set() };
  const emit = (k, v) => {
    for (const f of subs[k]) {
      try {
        f(v);
      } catch {
        /* a listener that throws does not stop the others */
      }
    }
  };
  const on = (k) => (f) => (subs[k].add(f), () => subs[k].delete(f));
  const edits = createEdits();

  let D = null; // realmDom(window), made at attach
  let frame = null; // the <iframe> (a page element)
  let layer = null; // the page element laid over the frame's content box
  let doc = null; // the frame's document, once loaded
  let ver = null; // {version, texts, editable, plain, text}
  let ix = null;
  let bySource = null; // source text-node id -> slot n
  let byId = null; // data-osk-id -> element (built on first need)
  let mode = "edit";
  let locked = false;
  let host = null; // the element being typed in: {el, snap (its last good state), slotN, lazy (made editable at the click)}
  // the parts made editable ahead: info (element -> {key, n0, count}: its last good shape and its slots), known[n] (the text slot n
  // last held as far as the view knows), list (in tree order, compared in turn from `scan`), next (the pass's next slot)
  let arm = null;
  let last = null; // the last selection read
  let pendingSel = false;
  let selTicks = 0;
  let selNow = null; // the anchor told to listeners
  let hidden = []; // [{nodeId, tag, hash}]
  let marks = [];
  let timer = null;
  let raf = 0;
  let scrollKey = "";
  let paintDue = true;
  let lastPaint = 0;
  let onHost = null;
  let onPlain = null;
  let handle = null;
  let hintTimer = null;
  let flashTimer = null;
  let flashLoc = null;
  let drag = null; // comment mode: {x, y, moved, from} from the press on the page's layer
  const stats = { reloads: 0, armMs: 0, armDoneMs: 0, scanMax: 0, hostMax: 0, slots: 0, ticks: 0, tickMax: 0, tickSum: 0, anchorMax: 0, indexMs: 0, srcdocMs: 0, decodeMs: 0 };

  const ctx = () => ({ D, ix, texts: ver.texts, root: doc, editable: ver.editable });
  const ready = () => !!(doc && ix);

  // ---- loading ---------------------------------------------------------------------------------------------------------------------
  function attach(iframe, over, focus = null) {
    frame = iframe;
    layer = over;
    if (focus) focusPage = focus;
    D ||= realmDom(window);
  }

  /** A version (or the plain view of one): its content is set once; a flag set before it and found set later means "show plain" (R6). */
  function load({ copy, texts, editable, ident, plain, version, onHost: oh, onPlain: op, attempt = 0 }) {
    onHost = oh;
    onPlain = op;
    // once per version (R12): the same version fetched again is not set again; the plain view and a retry are
    if (ver && ver.version === version && ver.plain === (plain || null) && ver.attempt === attempt) return;
    finishHost();
    if (ver && !ver.loaded && !ver.plain) flag.clear(ver.version); // replaced before it loaded: not a crash
    stopArming();
    doc = null;
    ix = null;
    byId = null;
    bySource = null;
    ver = { version, texts: texts || [], editable: editableSet(editable), ids: identities(editable, ident), plain: plain || null, copy, attempt, loaded: false };
    if (!plain && flag.isSet(version)) {
      ui({ phase: "crashed" });
      onPlain?.("crash");
      return;
    }
    let t0 = performance.now();
    const text = typeof copy === "string" ? copy : new TextDecoder("utf-8").decode(copy);
    stats.decodeMs = performance.now() - t0;
    ui({ phase: "loading", paint: { items: [], chip: null }, hover: null, hideAt: null });
    if (!plain) flag.set(version);
    frame.inert = !plain; // until the parts' text is read (startArming): no key reaches the copy before that
    t0 = performance.now();
    frame.srcdoc = text; // set once per version (R12); the frame element is the page's own
    stats.srcdocMs = performance.now() - t0;
  }

  /**
   * The same version set again (a part changed in a way the view cannot put back from what it holds: see adopt). The person's pending
   * edits are put back in it as they were and the place in the page is kept.
   */
  function reloadSame() {
    const v = ver;
    stats.reloads++;
    const view = getViewState();
    finishHostQuiet();
    stopArming();
    doc = null;
    ix = null;
    byId = null;
    bySource = null;
    ver = { ...v, loaded: false, again: view || {} };
    ui({ phase: "loading" });
    if (!v.plain) flag.set(v.version);
    frame.inert = !v.plain;
    frame.srcdoc = typeof v.copy === "string" ? v.copy : new TextDecoder("utf-8").decode(v.copy);
  }

  /** The iframe element's load event (a listener on the page's own element, not inside the frame). */
  function loaded() {
    if (!ver || ver.loaded || !frame) return;
    const d = D.frameDoc(frame);
    if (!d || D.url(d) !== "about:srcdoc") return; // the frame's first about:blank
    ver.loaded = true;
    doc = d;
    // forced scrolling (R15): the page's own inline styles, set from here, win over the page's overflow: hidden
    const de = D.docElement(doc);
    const body = D.body(doc);
    if (de) D.setStyle(D.style(de), "overflow", "auto", "important");
    if (body) D.setStyle(D.style(body), "overflow", "visible", "important");
    const v = ver;
    // cleared once the content has been laid out and painted: two frames after load
    // two frames, or one second where frames do not run (a hidden tab): the heavy work of a page (its styles) is done before load
    let cleared = false;
    const clear = () => !cleared && ((cleared = true), !v.plain && flag.clear(v.version));
    requestAnimationFrame(() => requestAnimationFrame(clear));
    setTimeout(clear, 1000);
    setTimeout(() => afterLoad(v), 0);
  }

  function afterLoad(v) {
    if (v !== ver || !doc) return;
    const t0 = performance.now();
    ix = buildIndex(D, doc);
    bySource = new Map();
    ver.texts.forEach((src, n) => src >= 0 && bySource.set(src, n));
    stats.indexMs = performance.now() - t0;
    stats.slots = ix.count;
    // the frame's text must line up with the copy's: if not, no anchor or edit could be trusted, so selecting and typing are off
    ver.mismatch = ix.count !== ver.texts.length;
    if (ver.again) {
      // the same version set again: the pending edits go back on the same nodes
      for (const e of edits.list()) setSourceText(e.nodeId, e.newText);
    } else if (edits.has()) {
      // the person's unsent edits come along to the new version (R9), each on the one node with its identity; what cannot be placed is
      // told and kept with its text (lostEdits), never dropped silently and never put at a guessed place
      const report = edits.replace(ver.version, {
        ids: ver.ids,
        textOf: (id) => (!ver.mismatch && ver.editable.has(id) && bySource.has(id) ? slotText(D, ix.firsts[bySource.get(id)]) : null),
      });
      for (const e of report.placed) setSourceText(e.nodeId, e.newText);
      if (report.lost.length || report.applied.length) emit("lost", report);
    }
    if (!ver.plain) startArming(v);
    else frame.inert = false;
    if (hidden.length) {
      hidden = replaceHidden(hidden, {
        at: (id) => {
          const el = elementById(id);
          return el ? { tag: D.tag(el), hash: hashOf(el) } : null;
        },
        find: (tag, hash) => [...allElements()].filter(([, el]) => D.tag(el) === tag && hashOf(el) === hash).map(([id]) => id),
      });
      for (const h of hidden) hideEl(elementById(h.nodeId));
    }
    ui({ phase: "ready", hiddenCount: hidden.length, locked, mismatch: !!ver.mismatch, lost: edits.lost() });
    start();
    if (ver.again) {
      setViewState(ver.again);
      ver.again = null;
    }
    handle = makeHandle();
    onHost?.(handle);
  }

  // ---- reading the frame ------------------------------------------------------------------------------------------------------------
  function allElements() {
    if (!byId) {
      byId = new Map();
      const list = D.qsaDoc(doc, "[data-osk-id]");
      const n = D.listLength(list);
      for (let i = 0; i < n; i++) {
        const el = D.listItem(list, i);
        byId.set(D.oskId(el), el);
      }
    }
    return byId;
  }
  const elementById = (id) => (doc ? allElements().get(id) || null : null);
  const hashOf = (el) => editHash((anchorFromElement(el, ctx())?.quote || "").slice(0, 200));

  /** The frame's position in the page: its content box (inside the border), in page client coordinates. */
  function frameBox() {
    const r = frame.getBoundingClientRect();
    return { left: r.left + frame.clientLeft, top: r.top + frame.clientTop, width: frame.clientWidth, height: frame.clientHeight };
  }
  const toPage = (b, fb = frameBox()) => new DOMRect(b.left + fb.left, b.top + fb.top, b.width, b.height);

  function readSelection() {
    const s = D.getSelection(doc);
    if (!s || D.rangeCount(s) === 0) return null;
    const r = D.rangeAt(s, 0);
    return { startContainer: D.startContainer(r), startOffset: D.startOffset(r), endContainer: D.endContainer(r), endOffset: D.endOffset(r) };
  }
  const sameSel = (a, b) => a === b || (!!a && !!b && a.startContainer === b.startContainer && a.startOffset === b.startOffset && a.endContainer === b.endContainer && a.endOffset === b.endOffset);
  const collapsed = (s) => s.startContainer === s.endContainer && s.startOffset === s.endOffset;

  /** Rects of a location in frame viewport coordinates (plain objects); [] when not in this version. */
  function frameRects(loc) {
    if (!ready() || (ver.mismatch && bySource.has(loc?.nodeId))) return [];
    const spec = rangeOfLocation(loc, { ...ctx(), slotOfSource: bySource, elementById });
    if (!spec) return [];
    if (spec.element) return [D.box(D.rect(spec.element))].filter((b) => b.width > 0 || b.height > 0);
    const r = D.createRange(doc);
    D.setStart(r, spec.startNode, spec.startOffset);
    D.setEnd(r, spec.endNode, spec.endOffset);
    return D.boxes(D.rangeRects(r)).map(D.box).filter((b) => b.width > 0 && b.height > 0);
  }

  // ---- the timer: selection, typing, scroll ------------------------------------------------------------------------------------------
  function start() {
    clearInterval(timer);
    timer = setInterval(tick, TICK_MS);
    cancelAnimationFrame(raf);
    const loop = () => {
      raf = requestAnimationFrame(loop);
      frameLoop();
    };
    raf = requestAnimationFrame(loop);
  }

  function tick() {
    if (!ready()) return;
    const t0 = performance.now();
    const sel = readSelection();
    const same = sameSel(sel, last);
    if (!same) {
      last = sel;
      pendingSel = true;
      selTicks = 0;
      if (!ver.plain && !ver.mismatch) followCaret(sel);
    } else selTicks++;
    const h0 = performance.now();
    if (host) checkHost();
    const s0 = performance.now();
    if (arm && ready()) scanSome();
    stats.hostMax = Math.max(stats.hostMax, s0 - h0);
    stats.scanMax = Math.max(stats.scanMax, performance.now() - s0);
    if (!ready()) return; // the version was set again in this tick (reloadSame): nothing of the old document is read any more
    // comment and pin modes: the page's keys work only while the page has the focus, so the frame never keeps it there
    if (mode !== "edit" && focusPage && document.activeElement === frame) focusPage();
    // a selection is told once it held still for a tick: a drag is not mapped at every step
    if (pendingSel && selTicks >= 1) {
      pendingSel = false;
      const a0 = performance.now();
      const a = sel && !collapsed(sel) && !ver.mismatch ? anchorFromRange(sel, ctx()) : null;
      stats.anchorMax = Math.max(stats.anchorMax, performance.now() - a0);
      const was = selNow;
      selNow = a;
      if (JSON.stringify(a) !== JSON.stringify(was)) emit("sel", a ? { format: "html", kind: "text", ...a, collapsed: false } : null);
    }
    const dt = performance.now() - t0;
    stats.ticks++;
    stats.tickSum += dt;
    stats.tickMax = Math.max(stats.tickMax, dt);
  }

  // ---- the parts the person may type in ----------------------------------------------------------------------------------------------
  /**
   * The parts are editable as the frame parses the copy (`contenteditable="plaintext-only"` from the server, src/html.js editHosts):
   * making them editable from here costs a full layout of the page per batch (measured: seconds at 100,000 paragraphs). This pass reads
   * each part's shape and the text of its slots while the frame is `inert` (set with its content, lifted at the end of this pass), so
   * nothing the person types can be taken for the version's text. Runs in tasks of ARM_MS; the first one at once. A view whose text does
   * not line up with the copy (mismatch) takes no typing: its parts are made plain instead.
   */
  function startArming(v) {
    const list = D.qsaDoc(doc, '[contenteditable="plaintext-only"]');
    const n = D.listLength(list);
    arm = { info: new Map(), known: new Array(ix.count), list: [], next: 0, scan: 0, timer: 0, keys: new Map(), t0: performance.now() };
    const a = arm;
    const step = () => {
      if (a !== arm || v !== ver || !ready()) return;
      const t0 = performance.now();
      while (a.next < n) {
        const el = D.listItem(list, a.next++);
        if (v.mismatch) D.removeAttr(el, "contenteditable");
        else armEl(el);
        if ((a.next & 63) === 0 && performance.now() - t0 > ARM_MS) break;
      }
      stats.armMs += performance.now() - t0;
      if (a.next < n) a.timer = setTimeout(step, 0);
      else {
        stats.armDoneMs = performance.now() - a.t0;
        frame.inert = false;
      }
    };
    step();
  }
  function stopArming() {
    if (arm) clearTimeout(arm.timer);
    arm = null;
  }
  /** One part: its shape and slots as they are now (before any typing: the frame is inert); a part that does not line up is made plain. */
  function armEl(P) {
    const sh = shapeOf(D, P);
    const n0 = sh.slots.length ? slotOfNode(ix, D, sh.slots[0])?.n : undefined;
    if (n0 === undefined || sh.slots.some((t, k) => slotOfNode(ix, D, t)?.n !== n0 + k)) return D.removeAttr(P, "contenteditable");
    if (!D.editableNow(P)) D.setAttr(P, "contenteditable", "true"); // a browser without plaintext-only: the shape check still holds
    sh.slots.forEach((t, k) => (arm.known[n0 + k] = sh.texts[k]));
    let key = arm.keys.get(sh.key);
    if (key === undefined) arm.keys.set(sh.key, (key = sh.key));
    arm.info.set(P, { key, n0, count: sh.slots.length });
    arm.list.push(P);
  }
  /** The outermost editable part at or above `node` (the browser's editing host), or null. */
  function armedAt(node) {
    let out = null;
    if (!arm) return null;
    for (let x = node; x && D.type(x) !== 9; x = D.parent(x)) if (D.type(x) === 1 && arm.info.has(x)) out = x;
    return out;
  }
  /**
   * A host for an editable part from what the view knows of it (its shape and the text of its slots before anything was typed), not
   * from what it holds now: what was typed before the view looked (a key right after the click) is then a change like any other. When
   * its shape is not the known one either and the change is not only emptied text, nothing the view holds can put it back: the version
   * is set again (reloadSame) and the blocked action is told. Returns the host, or null.
   */
  function adopt(el, now = shapeOf(D, el)) {
    const info = arm.info.get(el);
    const slotN = Array.from({ length: info.count }, (_, k) => info.n0 + k);
    const known = slotN.map((n) => arm.known[n]);
    if (now.key !== info.key && !emptiedSlots(info.key, now.key)) {
      const anchor = anchorFromElement(el, ctx());
      const rect = toPage(D.box(D.rect(el)));
      reloadSame();
      hint(SAY.blocked, null);
      emit("blocked", { reason: "structure", anchor, rect });
      return null;
    }
    if (now.key !== info.key) return { el, snap: null, info, slotN, known };
    // the last good state: the elements and Text objects there now, holding the known text (the first node of a slot all of it)
    const datas = [];
    now.slots.forEach((first, k) => slotNodes(D, first).forEach((t, i) => datas.push([t, i === 0 ? known[k] : ""])));
    return { el, snap: { ...now, datas, texts: known }, slotN };
  }
  /** Compares up to SCAN_NODES nodes of editable parts other than the one under the caret, in turn (a page under that: all of them). */
  function scanSome(budget = SCAN_NODES) {
    const a = arm;
    const total = a.list.length;
    for (let seen = 0; seen < total && budget > 0 && a === arm && ready(); seen++) {
      const el = a.list[a.scan];
      a.scan = (a.scan + 1) % total;
      if (!a.info.has(el) || (host && host.el === el)) continue;
      budget -= check(el);
    }
  }
  /** Every editable part compared (at flush, before Send takes the edits), in tasks so a page at the limits does not hold the page. */
  async function scanAll() {
    const a = arm;
    if (!a) return;
    for (let i = 0; i < a.list.length && a === arm && ready(); ) {
      const t0 = performance.now();
      for (; i < a.list.length && performance.now() - t0 < ARM_MS; i++) if (a.info.has(a.list[i]) && !(host && host.el === a.list[i])) check(a.list[i]);
      if (i < a.list.length) await new Promise((r) => setTimeout(r, 0));
    }
  }
  /** One editable part compared with what the view knows; a change is taken (or refused) as if it was typed under the caret. Returns its node count. */
  function check(el) {
    const info = arm.info.get(el);
    const now = shapeOf(D, el);
    const cost = now.datas.length + now.kids.length;
    if (now.key === info.key && now.texts.every((t, k) => t === arm.known[info.n0 + k])) return cost;
    const outer = host;
    const d0 = doc;
    host = adopt(el, now);
    if (host) checkHost();
    host = doc === d0 ? outer : null; // set again (reloadSame): the old host is gone with its document
    return cost;
  }

  /** A caret placed in an editable part makes it the host (R14); a caret in other text the person may type in, the click path. */
  function followCaret(sel) {
    if (!sel || !collapsed(sel)) {
      if (host && sel && !(D.contains(host.el, sel.startContainer) && D.contains(host.el, sel.endContainer))) finishHost();
      return;
    }
    const node = sel.startContainer;
    if (host && D.contains(host.el, node)) return;
    finishHost();
    const H = armedAt(node);
    if (H) {
      host = adopt(H);
      if (host) checkHost();
      if (ready() && D.type(node) === 3 && !canType(node, ctx())) hint(SAY.readOnlyPart, locatedOf(D, node));
      return;
    }
    if (guarded() || D.type(node) !== 3) return;
    if (canType(node, ctx())) beginHost(D.parent(node), node, sel.startOffset);
    else {
      const el = locatedOf(D, node);
      if (el) hint(SAY.readOnlyPart, el);
    }
  }

  /** The click path, for text in an element too big to be made editable ahead: editable now, its state taken now. */
  function beginHost(el, node, offset) {
    D.setAttr(el, "contenteditable", "plaintext-only");
    if (!D.editableNow(el)) D.setAttr(el, "contenteditable", "true");
    D.focus(el, { preventScroll: true });
    const s = D.getSelection(doc);
    D.collapse(s, node, offset);
    last = readSelection();
    const snap = shapeOf(D, el);
    host = { el, snap, slotN: snap.slots.map((t) => slotOfNode(ix, D, t)?.n ?? -1), lazy: true };
  }

  function finishHost() {
    if (!host) return;
    checkHost();
    finishHostQuiet();
  }

  /** Typing is not taken now: a run, a Send in flight, another tab (setReadOnly), or Comment and Pin modes. */
  const guarded = () => locked || mode !== "edit";

  /**
   * Compares the host with its last good state. Every changed slot of the one action is checked first (a slot from the source, that the
   * person may type in, no line break); only when ALL pass are they recorded as pending edits, so a deletion that also reaches a link is
   * not half kept (outside review 029e51b, html-frame.js:309). Any other change, or any change while typing is not taken, is put back
   * (R11, R17). Emptied text is a change of text (6b): the emptied Text node is put back holding nothing.
   */
  function checkHost() {
    let now = shapeOf(D, host.el);
    if (!host.snap) {
      // adopt found emptied text in a part whose nodes the view did not hold yet
      if (host.info.key === "T" && /^(<br>)*$/.test(now.key)) {
        // a part that held one text, emptied before the view held its nodes: the empty text node is made again
        const t = D.createText(doc, "");
        D.replaceChildren(host.el, t);
        registerSlot(ix, D, t, host.slotN[0]);
        host.snap = { key: "T", slots: [t], kids: [[host.el, [t]]], datas: [[t, host.known[0]]], texts: [host.known[0]] };
        D.collapse(D.getSelection(doc), t, 0);
        last = readSelection();
        now = shapeOf(D, host.el);
      } else {
        // emptied before the view held this part's nodes, in a part with more in it: set again from the copy (adopt's last resort)
        const el = host.el;
        const anchor = anchorFromElement(el, ctx());
        const rect = toPage(D.box(D.rect(el)));
        host = null;
        reloadSame();
        emit("blocked", { reason: "structure", anchor, rect });
        return;
      }
    }
    if (now.key !== host.snap.key) {
      const gone = emptiedSlots(host.snap.key, now.key);
      if (!gone) return blocked("structure");
      // the slots that still hold text, in order, take their new text; the gone ones hold ""
      const kept = now.texts.slice();
      const texts = host.snap.texts.map((_, k) => (gone.includes(k) ? "" : kept.shift()));
      const sel = readSelection();
      const inHost = sel && D.contains(host.el, sel.startContainer);
      restoreShape(D, host.snap);
      host.snap.slots.forEach((first, k) => {
        const nodes = slotNodes(D, first);
        D.setData(nodes[0], texts[k]);
        for (const t of nodes.slice(1)) D.setData(t, "");
      });
      now = shapeOf(D, host.el);
      if (inHost && gone.length) D.collapse(D.getSelection(doc), host.snap.slots[gone[0]], 0);
      last = readSelection();
    }
    const changes = [];
    for (let k = 0; k < now.texts.length; k++) {
      if (now.texts[k] === host.snap.texts[k]) continue;
      const n = host.slotN[k];
      const src = n >= 0 ? ver.texts[n] : -1;
      if (src < 0 || !canTypeSlot(now.slots[k], n)) return blocked("not_editable");
      const ch = typedChange(host.snap.texts[k], now.texts[k]);
      if (ch.newline) return blocked("newline");
      changes.push({ k, n, src, ch, before: host.snap.texts[k] });
    }
    if (!changes.length) return;
    if (guarded()) return refuse();
    for (const c of changes) {
      const base = edits.get(c.src)?.baseText ?? c.before;
      edits.set({ nodeId: c.src, versionSha: ver.version, baseText: base, newText: c.ch.text, ident: ver.ids.of(c.src) });
      emit("edit", { format: "html", kind: "text", before: c.before, after: c.ch.text, location: { nodeId: c.src } });
    }
    host.snap = now;
    now.slots.forEach((first, k) => {
      const n = host.slotN[k];
      if (n < 0) return;
      registerSlot(ix, D, first, n);
      if (arm) arm.known[n] = now.texts[k];
    });
  }
  const canTypeSlot = (first, n) => {
    registerSlot(ix, D, first, n);
    return canType(first, ctx());
  };

  /** Puts the host back as it was (its last good state) and puts the caret at the end of its text. */
  function putBack() {
    restoreShape(D, host.snap);
    host.snap.slots.forEach((first, k) => host.slotN[k] >= 0 && registerSlot(ix, D, first, host.slotN[k]));
    const sel = readSelection();
    const lastSlot = host.snap.slots[host.snap.slots.length - 1];
    if (lastSlot && sel && D.contains(host.el, sel.startContainer)) {
      const nodes = slotNodes(D, lastSlot);
      const t = nodes[nodes.length - 1];
      D.collapse(D.getSelection(doc), t, D.data(t).length);
    }
    last = readSelection();
  }

  function blocked(reason) {
    const el = host.el;
    putBack();
    hint(SAY.blocked, el);
    emit("blocked", { reason, anchor: anchorFromElement(el, ctx()), rect: toPage(D.box(D.rect(el))) });
  }

  /** Typing while it is not taken: put back, with the sentence that says why. */
  function refuse() {
    const el = host.el;
    putBack();
    hint(locks.has("run") ? SAY.running : locks.has("sending") ? SAY.sending : locks.has("tab") ? SAY.otherTab : SAY.notEditMode, el);
  }

  /** Puts `text` in a source text node's slot (an undo, a re-placed edit). */
  function setSourceText(src, text) {
    const n = bySource?.get(src);
    if (n === undefined) return false;
    const nodes = slotNodes(D, ix.firsts[n]);
    D.setData(nodes[0], text);
    for (const t of nodes.slice(1)) {
      ix.slotOf.delete(t);
      D.removeChild(D.parent(t), t);
    }
    registerSlot(ix, D, nodes[0], n);
    if (arm) arm.known[n] = text;
    if (host && D.contains(host.el, nodes[0])) host.snap = shapeOf(D, host.el);
    return true;
  }

  // ---- marks, hover, flash: drawn in the page's layer from frame rects --------------------------------------------------------------
  function frameLoop() {
    if (!ready()) return;
    const sc = D.scroller(doc);
    const key = sc ? `${D.scrollTop(sc)}|${D.scrollLeft(sc)}|${frame.clientWidth}|${frame.clientHeight}` : "";
    if (key !== scrollKey) {
      scrollKey = key;
      paintDue = true;
      ui({ hover: null, hideAt: null });
      emit("view", null);
    }
    const now = performance.now();
    if (paintDue || now - lastPaint > 700) paint(now);
  }

  function paint(now = performance.now()) {
    paintDue = false;
    lastPaint = now;
    const w = frame.clientWidth;
    const h = frame.clientHeight;
    const r1 = (x) => Math.round(x * 10) / 10;
    const items = [];
    for (const m of marks) {
      const rs = frameRects(m.location).filter((b) => b.bottom > 0 && b.top < h && b.right > 0 && b.left < w);
      if (!rs.length) continue;
      if (m.kind === "pin") {
        const b = rs[0];
        items.push({ id: m.id, n: m.n, status: m.status || "draft", pin: { x: r1(b.left + (m.pin?.xFrac ?? 0.5) * b.width), y: r1(b.top + (m.pin?.yFrac ?? 0.5) * b.height) } });
      } else items.push({ id: m.id, n: m.n, status: m.status || "draft", whole: !Number.isInteger(m.location?.start), rects: rs.map((b) => ({ x: r1(b.left), y: r1(b.top), w: Math.round(b.width), h: Math.round(b.height) })) });
    }
    const flash = flashLoc ? frameRects(flashLoc).slice(0, 1).map((b) => ({ x: r1(b.left), y: r1(b.top), w: Math.round(b.width), h: Math.round(b.height) }))[0] || null : null;
    ui({ paint: { items, chip: null }, flash });
  }

  function hint(text, el) {
    clearTimeout(hintTimer);
    const b = el && doc ? D.box(D.rect(el)) : null;
    ui({ hint: { text, x: b ? Math.max(8, b.left) : 8, y: b ? Math.max(8, b.bottom + 6) : 8 } });
    hintTimer = setTimeout(() => ui({ hint: null }), HINT_MS);
  }

  // ---- comment and pin modes: the page's own layer over the frame --------------------------------------------------------------------
  /** The located element under a point of the layer (frame viewport coordinates). */
  function elementAt(x, y) {
    if (!ready()) return null;
    const hit = D.elementFromPoint(doc, x, y);
    return hit ? locatedOf(D, hit) : null;
  }
  function hover(x, y) {
    const el = elementAt(x, y);
    if (!el) return ui({ hover: null });
    const b = D.box(D.rect(el));
    ui({ hover: { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height), id: D.oskId(el) } });
  }
  function pick(x, y) {
    const el = elementAt(x, y);
    if (!el) return;
    const b = D.box(D.rect(el));
    const anchor = anchorFromElement(el, ctx());
    const pin = { xFrac: b.width ? Math.min(1, Math.max(0, (x - b.left) / b.width)) : 0.5, yFrac: b.height ? Math.min(1, Math.max(0, (y - b.top) / b.height)) : 0.5 };
    if (mode === "comment") ui({ hideAt: { x: Math.round(Math.min(Math.max(8, b.right - 180), frame.clientWidth - 188)), y: Math.round(Math.max(8, b.top + 6)), id: anchor.location.nodeId } });
    emit("pick", { mode, anchor, pin, rect: toPage(b) });
  }
  /**
   * Comment mode, the main flow (select a sentence, comment on it): a press on the page's layer that moves selects the frame's text from
   * the press to the pointer (caret positions from the frame's document, set as its selection), and the release picks that text as a text
   * anchor; a press that does not move is a click, which picks the element under it.
   */
  function press(x, y) {
    if (!ready() || mode !== "comment") return;
    drag = { x, y, moved: false, from: D.caretAt(doc, x, y) };
  }
  function dragTo(x, y) {
    if (!drag || !ready()) return;
    if (!drag.moved && Math.hypot(x - drag.x, y - drag.y) < DRAG_PX) return;
    drag.moved = true;
    const to = D.caretAt(doc, x, y);
    if (!drag.from || !to) return;
    D.setBaseAndExtent(D.getSelection(doc), drag.from.node, drag.from.offset, to.node, to.offset);
    ui({ hover: null, hideAt: null });
  }
  /** The end of a press: true when it selected text (and picked it), false when it was a click (the caller picks the element). */
  function release(x, y) {
    const d = drag;
    drag = null;
    if (!d || !d.moved || !ready()) return false;
    dragTo(x, y);
    const sel = readSelection();
    const a = sel && !collapsed(sel) && !ver.mismatch ? anchorFromRange(sel, ctx()) : null;
    if (!a) return true; // a drag over no text of the page: no comment
    const r = frameRects(a.location)[0];
    emit("pick", { mode, anchor: a, pin: null, rect: r ? toPage(r) : null, kind: "text" });
    return true;
  }

  /** The wheel over the layer scrolls the frame (the layer would otherwise swallow it). */
  function wheel(dx, dy) {
    const sc = ready() ? D.scroller(doc) : null;
    if (!sc) return;
    if (dy) D.setScrollTop(sc, D.scrollTop(sc) + dy);
    if (dx) D.setScrollLeft(sc, D.scrollLeft(sc) + dx);
  }

  // ---- hide in the view (R15) -----------------------------------------------------------------------------------------------------
  function hideEl(el) {
    if (el) D.setStyle(D.style(el), "display", "none", "important");
  }
  function hide(nodeId) {
    const el = elementById(nodeId);
    if (!el || hidden.some((h) => h.nodeId === nodeId)) return false;
    if (host && D.contains(el, host.el)) finishHost();
    hidden.push({ nodeId, tag: D.tag(el), hash: hashOf(el) });
    hideEl(el);
    ui({ hiddenCount: hidden.length, hideAt: null, hover: null });
    paintDue = true;
    return true;
  }
  function showHidden() {
    for (const h of hidden) {
      const el = elementById(h.nodeId);
      if (el) D.removeStyle(D.style(el), "display");
    }
    hidden = [];
    ui({ hiddenCount: 0 });
    paintDue = true;
  }

  // ---- view state ----------------------------------------------------------------------------------------------------------------
  function getViewState() {
    if (!ready()) return null;
    const sc = D.scroller(doc);
    const x = sc ? D.scrollLeft(sc) : 0;
    const y = sc ? D.scrollTop(sc) : 0;
    const height = sc ? D.scrollHeight(sc) : 0;
    const el = elementAt(Math.max(1, frame.clientWidth / 2), 2);
    const top = el ? { nodeId: D.oskId(el), quote: (anchorFromElement(el, ctx())?.quote || "").slice(0, 80), offsetPx: Math.round(D.box(D.rect(el)).top) } : null;
    return { format: "html", version: ver.version, x, y, fraction: height ? y / height : 0, top, hidden: hidden.map((h) => ({ ...h })) };
  }
  async function setViewState(s) {
    if (!ready() || !s || s.format !== "html") return false;
    if (Array.isArray(s.hidden) && s.hidden.length && !hidden.length) {
      hidden = replaceHidden(s.hidden, { at: (id) => (elementById(id) ? { tag: D.tag(elementById(id)), hash: hashOf(elementById(id)) } : null), find: (tag, hash) => [...allElements()].filter(([, el]) => D.tag(el) === tag && hashOf(el) === hash).map(([id]) => id) });
      for (const h of hidden) hideEl(elementById(h.nodeId));
      ui({ hiddenCount: hidden.length });
    }
    const sc = D.scroller(doc);
    if (!sc) return false;
    if (s.version === ver.version) {
      D.setScrollTop(sc, s.y || 0);
      D.setScrollLeft(sc, s.x || 0);
      return true;
    }
    const el = s.top ? elementById(s.top.nodeId) : null;
    if (el && (anchorFromElement(el, ctx())?.quote || "").slice(0, 80) === s.top.quote) {
      D.setScrollTop(sc, D.scrollTop(sc) + D.box(D.rect(el)).top - (s.top.offsetPx || 0));
      return true;
    }
    D.setScrollTop(sc, (s.fraction || 0) * D.scrollHeight(sc));
    return false;
  }

  async function scrollTo(loc, { flash = true } = {}) {
    const rs = frameRects(loc);
    const sc = ready() ? D.scroller(doc) : null;
    if (!rs.length || !sc) return false;
    const top = rs[0].top;
    if (top < 0 || top > frame.clientHeight - 40) D.setScrollTop(sc, D.scrollTop(sc) + top - frame.clientHeight / 3);
    if (flash) flashAt(loc);
    paintDue = true;
    return true;
  }
  function flashAt(loc) {
    clearTimeout(flashTimer);
    flashLoc = loc;
    paintDue = true;
    flashTimer = setTimeout(() => ((flashLoc = null), (paintDue = true)), FLASH_MS);
  }

  // ---- the handle (docs/contracts/engine-hooks.md, "HTML view") ---------------------------------------------------------------------
  function makeHandle() {
    const version = ver.version;
    return {
      format: "html",
      version,
      get readOnly() {
        return locked;
      },
      setReadOnly: (b, reason = "run") => setLocked(b, reason),
      get mode() {
        return mode;
      },
      setMode: (m) => setMode(m),
      selection: () => (selNow ? { format: "html", kind: "text", ...selNow, collapsed: false } : null),
      onSelectionChange: on("sel"),
      hitTest(clientX, clientY) {
        const fb = frameBox();
        const x = clientX - fb.left;
        const y = clientY - fb.top;
        if (x < 0 || y < 0 || x > fb.width || y > fb.height) return null;
        const el = elementAt(x, y);
        if (!el) return null;
        return { format: "html", kind: "element", ...anchorFromElement(el, ctx()), rect: toPage(D.box(D.rect(el)), fb) };
      },
      rectsFor: (loc) => {
        const fb = frameBox();
        return frameRects(loc).map((b) => toPage(b, fb));
      },
      scrollTo,
      flash: flashAt,
      getViewState,
      setViewState,
      edits: () => edits.list().map(({ baseText, ident, ...e }) => e),
      onEditsChange: (f) => edits.subscribe((l) => f(l.map(({ baseText, ident, ...e }) => e))),
      onEdit: on("edit"),
      undoEdit(nodeId) {
        const e = edits.undo(nodeId);
        if (e) setSourceText(e.nodeId, e.baseText);
        return !!e;
      },
      undoAllEdits() {
        for (const e of edits.undoAll()) setSourceText(e.nodeId, e.baseText);
      },
      clearEdits: () => edits.clear(), // the lost ones stay listed until the person dismisses them
      lostEdits: () => edits.lost(),
      dismissLost: () => (edits.dismissLost(), ui({ lost: [] })),
      onEditsLost: on("lost"),
      async flush() {
        if (host) checkHost();
        await scanAll();
      },
      onPick: on("pick"),
      onBlocked: on("blocked"),
      onViewChange: on("view"),
      onMarkClick: on("mark"),
      hide,
      showHidden,
      hidden: () => hidden.map((h) => ({ ...h })),
      stats: () => ({ ...stats, tickAvg: stats.ticks ? stats.tickSum / stats.ticks : 0 }),
    };
  }

  function setMode(m) {
    if (!["edit", "comment", "pin"].includes(m) || m === mode) return;
    if (m !== "edit") finishHost();
    mode = m;
    drag = null;
    ui({ hover: null, hideAt: null });
  }
  // why the view is read only: a run (D5), another tab holding the file, a Send in flight carrying the edits. Read only while any is set;
  // each caller sets and clears its own reason, so lifting one never lifts another
  const locks = new Set();
  function setLocked(b, reason = "run") {
    if (b) locks.add(reason);
    else locks.delete(reason);
    locked = locks.size > 0;
    if (locked) finishHost();
    ui({ locked: locks.has("run") ? "run" : locks.has("sending") ? "sending" : locks.has("tab") ? "tab" : false });
  }
  function setMarks(list) {
    marks = Array.isArray(list) ? list : [];
    paintDue = true;
  }

  function destroy() {
    clearInterval(timer);
    cancelAnimationFrame(raf);
    clearTimeout(hintTimer);
    clearTimeout(flashTimer);
    stopArming();
    if (ver && !ver.loaded && !ver.plain) flag.clear(ver.version);
    finishHostQuiet();
    onHost?.(null);
  }
  function finishHostQuiet() {
    if (host && doc && host.lazy && !arm?.info.has(host.el)) D.removeAttr(host.el, "contenteditable");
    host = null;
  }

  return { attach, load, loaded, setMode, setLocked, setMarks, hover, pick, press, dragTo, release, wheel, hide, showHidden, destroy, clearCrash: (v) => flag.clear(v), markClick: (id) => emit("mark", id), get handle() {
    return handle;
  } };
}
