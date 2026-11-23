import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { readMarkdown } from "../../src/markdown.js";
import { caretBlock, hitOf, rectsOf, runPoint, selectionOf } from "./md-host.js";
import { MD_OFFER_STALE, composeKey, draftRefusal, draftSplice, editability, firstKey, fromTextarea, toTextarea, toTextareaOffset, typedKey } from "./md-edit.js";
import { sha256hex } from "./writein.js";
import "./md-view.css";

/**
 * A Markdown file in the page: a preview of src/markdown.js's tree (Preview, the default) or a plain textarea on the file's source
 * (Edit). The preview is built from fixed React elements and text nodes only: nothing from the file becomes markup, an attribute that
 * loads or runs anything, or a URL (no dangerouslySetInnerHTML, no href or src from the document; a link is styled text, an image its
 * literal source). Every run is one span[data-r] whose only child is a text node equal to run.display (md-host.js maps DOM offsets
 * through that), every leaf block an element with data-b.
 *
 * Props: doc ({tree, version, rev}: the file as loaded, its sha256 and the session's revision number of it), draft (the textarea's text, LF only, or null: what the person typed and has not
 * sent), view ("preview" | "edit"), edit ({ok, why}: may the person type now; App.jsx decides: the file's line endings, a read-only tab,
 * an agent run), onDraft(text), onView(view), onHost(host | null). With a draft, Preview shows the draft read by the same reader, as a
 * version of its own (the SHA-256 of the bytes Send would write, with the file's BOM): comments made on it point at that version.
 *
 * Typing in the preview swaps to Edit: a printable key (Option held too) or Enter, no Cmd or Ctrl, the focus in the preview. The key
 * goes in at the exact source place of the caret, or replaces the selection's exact range, once (md-edit.js firstKey); with no exact
 * place nothing is typed and the editor opens at the start of the block, saying so. A dead key or the start of a composition opens Edit
 * focused at the exact place with nothing typed, so the composition goes on in the text box.
 *
 * The host is what App.jsx drives for the engine formats (selection, rectsFor, hitTest, scrollTo, getViewState, setViewState) plus onPick
 * (the explicit "comment on the whole block"). `version` is the version shown, `baseVersion` the file's, `rev` the shown revision number
 * (the file's, or the next one for a draft: the revision its Send would write). Every location the host makes carries version and rev;
 * rectsFor draws only a location of exactly the shown revision. Nothing is moved from one revision to another.
 */
/** The Markdown view on screen now (one per page; MarkdownHost's layout effect keeps it). */
const onScreen = { current: null };

export function MarkdownHost({ doc, draft = null, draftId = null, draftEol = null, view = "preview", edit = { ok: false, why: "" }, onDraft = () => {}, onView = () => {}, onHost }) {
  const rootRef = useRef(null);
  const areaRef = useRef(null);
  const runEls = useRef([]);
  const [note, setNote] = useState(null); // {reason, block?} for a refused selection or a key that could not be typed
  const [editNote, setEditNote] = useState(null); // the sentence above the textarea after a key that found no exact place
  const noteRef = useRef(null);
  noteRef.current = note;
  const hostRef = useRef(null);
  const caretRef = useRef(null); // where the textarea's caret goes when Edit opens
  const editRef = useRef(edit);
  editRef.current = edit;
  const cb = useRef({ onDraft, onView });
  cb.current = { onDraft, onView };
  const base = doc.tree;
  const bom = base.bom ? "\uFEFF" : "";
  const ed = useMemo(() => editability(base), [base]);
  const eol = draftEol ?? ed.eol; // a draft's own line endings (web/src/md-edit.js draftEolOf), else the file's
  // the preview's version: the file, or the draft as it was when Preview was last shown (typing in Edit does not read it every key)
  // the draft as Preview last showed it, with the id of that draft state (a comment made on it names that id)
  const lastDraft = useRef(draft);
  const lastDraftId = useRef(draftId);
  if (view !== "edit") (lastDraft.current = draft), (lastDraftId.current = draftId);
  // while the person cannot type (an agent run, a read-only tab) Preview shows the file: a comment there is on bytes that exist
  const previewDraft = edit.ok ? lastDraft.current : null;
  const previewDraftId = edit.ok ? lastDraftId.current : null;
  const shown = useMemo(() => {
    const same = { tree: base, version: doc.version, text: base.text, splice: null, error: null };
    if (previewDraft == null || !ed.ok) return same;
    const source = fromTextarea(previewDraft, eol);
    if (source === base.text) return same;
    // a draft that holds U+FEFF is not read (its offsets would not be the file's): it opens in Edit as it is, with the sentence
    const refused = draftRefusal(source);
    if (refused) return { ...same, error: refused };
    let tree;
    try {
      tree = readMarkdown(bom + source);
    } catch (e) {
      return { ...same, error: `Your edit cannot be shown or sent: ${e.message}.` };
    }
    const splice = draftSplice(base.text, source, base, tree);
    if (!splice.ok) return { ...same, error: `Your edit cannot be shown or sent: ${splice.reason}.` };
    return { tree, version: sha256hex(bom + source), text: source, splice, error: null, draft: true, draftId: previewDraftId };
  }, [base, doc.version, previewDraft, previewDraftId, ed, eol, bom]);
  // the shown revision number: the file's (a draft has none: no place is made on it)
  const rev = typeof doc.rev === "string" && !shown.draft ? doc.rev : null; // the opaque record id the server gave with the file
  const body = useMemo(() => renderBlocks(shown.tree, shown.tree.blocks), [shown.tree]);
  // what is on screen, as of the last commit (a layout effect: before any click can land on the new DOM, while the host object below is
  // made again only after paint, and a reload mounts a new host): a captured selection is checked against this, never an older host's view
  useLayoutEffect(() => {
    const mine = { shown, rev };
    onScreen.current = mine;
    return () => {
      if (onScreen.current === mine) onScreen.current = null;
    };
  });

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const tree = shown.tree;
    runEls.current = [];
    for (const el of root.querySelectorAll("[data-r]")) runEls.current[Number(el.dataset.r)] = el;
    const subs = { sel: new Set(), pick: new Set() };
    const sub = (set) => (fn) => (set.add(fn), () => set.delete(fn));
    let last = "";
    // every location made here names what it was made on. On the file: its sha256 and the session's revision number. On a draft: the
    // range in the draft's text (the text the Send's splice writes, same offsets) and `draftSha`, the sha256 of the bytes that Send will
    // write; no revision number (only the Send that writes those bytes binds it: src/session.js #mdSendAnchor)
    const at = (l) => (shown.draft ? { from: l.from, to: l.to, draftSha: shown.version, draftId: shown.draftId } : { ...l, rev });
    // the selection's evidence: sha256 over its identity (record id or draft state id), offsets and exact source, made when it is captured
    // (src/anchors.js mdEvidence checks it); `source` stays in the page only, for the check on a later click (isCurrent)
    const evidenceOf = (l, source) => {
      const identity = l.rev ?? l.draftId;
      return typeof identity === "string" && typeof source === "string" ? sha256hex(`${identity}\n${l.from}\n${l.to}\n${source}`) : undefined;
    };
    const withRev = (x) => {
      if (!x?.location) return x;
      const location = at(x.location);
      return { ...x, location, evidence: evidenceOf(location, x.source) };
    };
    const ident = `${shown.version}|${shown.draftId ?? ""}|${rev ?? ""}`; // what is on screen now
    /** Is a captured selection still exactly on screen: the same identity, and its source still the text at its range? */
    const isCurrent = (sel) => {
      const l = sel?.location;
      const now = onScreen.current;
      if (!l || typeof sel.source !== "string" || !now) return false;
      const v = now.shown;
      const same = l.draftSha ? v.draft && l.draftSha === v.version && l.draftId === v.draftId : !v.draft && l.version === v.version && l.rev === now.rev;
      return same && v.tree.text.slice(l.from, l.to) === sel.source;
    };
    const current = () => {
      const s = selectionOf(root, tree, shown.version, runEls.current);
      return s && s.kind === "refused" ? null : withRev(s);
    };
    // while the mouse button is down the selection is still being made: it is reported once the button is up (as the engine does), so no
    // chip pops up under the pointer mid-drag and takes the end of the selection
    let pressing = false;
    const onDown = (e) => (pressing = e.button === 0 && root.contains(e.target));
    const onUp = () => {
      if (!pressing) return;
      pressing = false;
      onSel();
    };
    const onSel = () => {
      if (pressing) return;
      const s = selectionOf(root, tree, shown.version, runEls.current);
      setNote((n) => {
        // a whole-block offer captures, when it is shown, its place on what is on screen now (range, exact source, and the identity:
        // the file's record id or the draft's state id); a click later is accepted only on that same identity (pickBlock)
        const next = s?.kind === "refused" ? { reason: s.reason, block: s.block ? { ...s.block, ident, location: at({ from: s.block.from, to: s.block.to, version: shown.version }) } : null } : n?.key ? n : null;
        return JSON.stringify(n) === JSON.stringify(next) ? n : next;
      });
      const out = s && s.kind !== "refused" ? withRev(s) : null;
      const key = JSON.stringify(out);
      if (key === last) return;
      last = key;
      for (const fn of subs.sel) fn(out);
    };
    // the first key typed in the preview: Edit opens with it typed at its exact place, once (or not typed, with the sentence)
    const onKey = (e) => {
      const k = typedKey(e);
      // a dead key or the start of a composition: nothing is typed here; Edit opens focused at the mapped place, in this same keydown,
      // and the browser goes on, so the composition lands in the text box (md-edit.js composeKey)
      const compose = k == null && composeKey(e);
      if (k == null && !compose) return;
      if (!compose) e.preventDefault();
      e.stopPropagation();
      const can = editRef.current;
      if (!can.ok) {
        if (compose) e.preventDefault();
        return setNote({ reason: can.why, key: true });
      }
      // a draft the preview cannot show: Edit opens on it as it is, and nothing is typed over it
      if (shown.error) {
        if (compose) e.preventDefault();
        setEditNote(shown.error);
        return cb.current.onView("edit");
      }
      const sel = window.getSelection();
      const r = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
      const inText = (node) => node?.nodeType === 3 && !!node.parentElement?.closest("[data-r]");
      let at = null;
      if (r && root.contains(r.startContainer) && root.contains(r.endContainer)) {
        const start = runPoint(root, r.startContainer, r.startOffset, runEls.current);
        const end = r.collapsed ? start : runPoint(root, r.endContainer, r.endOffset, runEls.current, { end: true });
        if (start && end) at = { start, end, collapsed: r.collapsed, exact: inText(r.startContainer) && inText(r.endContainer) };
        // a caret in an empty block or between runs: no run point is exact there; the editor opens at that block's start
        if (!at || !at.exact) {
          const b = caretBlock(root, tree, r.startContainer);
          if (b) at = { start: { run: tree.runs.findIndex((x) => x.block === b.id) }, exact: false, blockFrom: b.from };
        }
      }
      // a composition types nothing: firstKey only maps the place (its empty text is never spliced in, so a selection is not deleted)
      const out = firstKey(tree, at ?? null, compose ? "" : k, eol);
      if (at?.blockFrom != null && out.reason) out.caret = at.blockFrom;
      const text = shown.text;
      if (compose && !out.reason) {
        // the text box opens with the mapped caret or selection, as a text box holds it; the composed character replaces a selection
        // there only when the person finishes the composition, like typing in any text box
        caretRef.current = [toTextareaOffset(text, out.from), toTextareaOffset(text, out.to)];
        setEditNote(null);
        flushSync(() => cb.current.onView("edit")); // the text box exists and has the focus before this keydown ends
        return;
      }
      if (compose) e.preventDefault(); // no exact place: the dead key is not typed, and the sentence says so
      if (out.reason) {
        caretRef.current = toTextareaOffset(text, out.caret);
        setEditNote(out.reason);
        cb.current.onDraft(toTextarea(text));
      } else {
        const src = text.slice(0, out.from) + out.text + text.slice(out.to);
        caretRef.current = toTextareaOffset(src, out.from + out.text.length);
        setEditNote(null);
        cb.current.onDraft(toTextarea(src));
      }
      cb.current.onView("edit");
    };
    document.addEventListener("selectionchange", onSel);
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("pointerup", onUp, true);
    root.addEventListener("keydown", onKey);
    // a location is drawn only on exactly the revision it names (a resolved one from the server names the file's sha256 and was checked
    // against the revision number there); one of the file's version is not drawn on a draft
    const onShown = (loc) => {
      if (!loc) return null;
      if (loc.draftSha) return shown.draft && loc.draftSha === shown.version && loc.draftId === shown.draftId ? { from: loc.from, to: loc.to, version: shown.version } : null; // a draft-made place, on that draft only
      return !shown.draft && loc.version === shown.version && (loc.rev == null || loc.rev === rev) ? loc : null;
    };
    const host = {
      format: "markdown",
      version: shown.version,
      baseVersion: doc.version,
      rev,
      shownText: shown.text,
      onEdit: () => () => {}, // the person's typing is the draft App.jsx holds (onDraft), never a change record
      onSelectionChange: sub(subs.sel),
      onPick: sub(subs.pick),
      pickBlock: () => {
        const b = noteRef.current?.block;
        if (!b) return;
        // the preview changed under the offer (an agent run, the draft, a reload): it is withdrawn, nothing is anchored
        if (b.ident !== ident || tree.text.slice(b.from, b.to) !== b.source) return setNote({ reason: MD_OFFER_STALE, key: true });
        for (const fn of subs.pick) fn({ anchor: { location: b.location, quote: b.quote, evidence: evidenceOf(b.location, b.source), prefix: "", suffix: "", format: "markdown", hitKind: "block" } });
        window.getSelection()?.removeAllRanges();
        setNote(null);
      },
      selection: () => (pressing ? null : current()),
      rectsFor: (loc) => {
        const l = onShown(loc);
        return l ? rectsOf(tree, shown.version, runEls.current, l) : [];
      },
      hitTest: (x, y) => withRev(hitOf(root, tree, shown.version, x, y)),
      isCurrent,
      scrollTo: async (loc) => {
        const l = onShown(loc);
        const rs = l ? rectsOf(tree, shown.version, runEls.current, l) : [];
        if (!rs.length) return false;
        const box = root.getBoundingClientRect();
        root.scrollTop += rs[0].top - box.top - box.height / 3;
        return true;
      },
      getViewState: () => ({ format: "markdown", version: shown.version, y: root.scrollTop }),
      setViewState: async (v) => {
        if (!v || v.format !== "markdown") return false;
        root.scrollTop = Number(v.y) || 0;
        return true;
      },
      setReadOnly: () => {}, // App.jsx passes `edit` (a read-only tab, an agent run): the preview itself never takes typing
      flush: async () => {},
    };
    hostRef.current = host;
    onHost(host);
    return () => {
      document.removeEventListener("selectionchange", onSel);
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("pointerup", onUp, true);
      root.removeEventListener("keydown", onKey);
      // what is on screen changes: a whole-block offer made on it is withdrawn
      setNote((n) => (n?.block ? null : n));
      hostRef.current = null;
      onHost(null);
    };
  }, [shown, doc.version, base, ed, eol, onHost, rev]);

  // Edit opened: the caret where the key went (or the block's start), the focus in the textarea
  useLayoutEffect(() => {
    if (view !== "edit") return;
    const ta = areaRef.current;
    if (!ta) return;
    ta.focus({ preventScroll: true });
    if (caretRef.current != null) {
      const [a, b] = Array.isArray(caretRef.current) ? caretRef.current : [caretRef.current, caretRef.current];
      const c = Math.min(a, ta.value.length);
      ta.setSelectionRange(c, Math.min(b, ta.value.length));
      caretRef.current = null;
      // the caret's line in view: the textarea scrolls to it
      const lines = ta.value.slice(0, c).split("\n").length;
      const lh = parseFloat(getComputedStyle(ta).lineHeight) || 20;
      ta.scrollTop = Math.max(0, (lines - 3) * lh);
    }
  }, [view]);

  const value = draft ?? (ed.ok ? toTextarea(base.text) : "");
  return (
    <div className="md" data-testid="md-host" data-view={view}>
      {view === "edit" && (
        <div className="md-edit">
          {editNote && (
            <div className="md-note md-note-flow" role="status" data-testid="md-edit-note">
              <span>{editNote}</span>
            </div>
          )}
          {!edit.ok && (
            <div className="md-note md-note-flow" role="status" data-testid="md-edit-off">
              <span>{edit.why}</span>
            </div>
          )}
          <textarea
            ref={areaRef}
            className="md-source"
            data-testid="md-source"
            aria-label="Markdown source"
            spellCheck={false}
            readOnly={!edit.ok}
            value={value}
            onChange={(e) => {
              setEditNote(null);
              onDraft(e.target.value); // exactly as typed or pasted: nothing is dropped
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                e.stopPropagation();
                onView("preview");
              }
            }}
          />
        </div>
      )}
      {/* the preview stays mounted while Edit shows (the host App.jsx drives lives with it), hidden */}
      <div className="md-pv" hidden={view === "edit"}>
          {note && (
            <div className="md-note" role="status" data-testid={note.key ? "md-type-note" : "md-refused"}>
              <span>{note.reason}</span>
              {note.block && (
                // the exact source the whole-block comment would point at, hidden marks and link destinations included, seen before it is made
                <pre className="md-note-src" data-testid="md-whole-block-source">
                  {note.block.source}
                </pre>
              )}
              {note.block && (
                <button type="button" className="btn sm" data-testid="md-whole-block" onMouseDown={(e) => e.preventDefault()} onClick={() => hostRef.current?.pickBlock()}>
                  Comment on the whole block
                </button>
              )}
            </div>
          )}
          {shown.error && (
            <div className="md-note md-note-flow" role="alert" data-testid="md-draft-error">
              <span>{shown.error}</span>
            </div>
          )}
          <div className="md-scroll" ref={rootRef} tabIndex={0} data-testid="md-preview" aria-label="Markdown preview" data-version={shown.version}>
            <article className="md-doc">{body}</article>
          </div>
      </div>
    </div>
  );
}

// ---- rendering: fixed elements only ---------------------------------------------------------------------------------------------
const ALIGN = { left: "md-al", right: "md-ar", center: "md-ac" };

function renderBlocks(tree, blocks) {
  return blocks.map((b) => renderBlock(tree, b));
}

function renderBlock(tree, b) {
  switch (b.type) {
    case "blank":
      return null;
    case "paragraph":
      return (
        <p key={b.id} data-b={b.id}>
          {renderInline(b.inline)}
        </p>
      );
    case "heading": {
      const H = `h${Math.min(6, Math.max(1, b.level))}`;
      return (
        <H key={b.id} data-b={b.id}>
          {renderInline(b.inline)}
        </H>
      );
    }
    case "code":
      return (
        <div key={b.id} className="md-code" data-b={b.id}>
          {b.infoRun && <span className="md-info">{run(b.infoRun)}</span>}
          <pre>
            <code>{renderInline(b.inline)}</code>
          </pre>
        </div>
      );
    case "literal":
      return (
        <pre key={b.id} className={`md-lit md-${b.what === "frontmatter" ? "frontmatter" : "html"}`} data-b={b.id} title={b.what === "frontmatter" ? "Front matter, shown as written" : "HTML, shown as written"}>
          {renderInline(b.inline)}
        </pre>
      );
    case "hr":
      return <hr key={b.id} data-b={b.id} />;
    case "quote":
      return <blockquote key={b.id}>{renderBlocks(tree, b.children)}</blockquote>;
    case "list": {
      const items = b.items.map((it) => (
        <li key={it.id} className={it.task ? "md-task" : undefined}>
          {renderBlocks(tree, it.children)}
        </li>
      ));
      return b.ordered ? (
        <ol key={b.id} start={Number.isInteger(b.start) ? b.start : undefined} className={b.tight ? "md-tight" : undefined}>
          {items}
        </ol>
      ) : (
        <ul key={b.id} className={b.tight ? "md-tight" : undefined}>
          {items}
        </ul>
      );
    }
    case "table":
      return (
        <div key={b.id} className="md-table" data-b={b.id}>
          <table>
            {b.rows.some((r) => r.header) && (
              <thead>
                {b.rows.filter((r) => r.header).map((r, i) => (
                  <tr key={i}>{r.cells.map((c, j) => <th key={j} className={ALIGN[b.align[j]]}>{renderInline(c.inline)}</th>)}</tr>
                ))}
              </thead>
            )}
            <tbody>
              {b.rows.filter((r) => !r.header).map((r, i) => (
                <tr key={i}>{r.cells.map((c, j) => <td key={j} className={ALIGN[b.align[j]]}>{renderInline(c.inline)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    default:
      return null; // a block type this page does not know is not drawn (its runs are not selectable)
  }
}

const run = (r) => (
  <span key={`r${r.id}`} data-r={r.id} className={`md-r md-${r.kind}`}>
    {r.display}
  </span>
);

function renderInline(nodes) {
  return nodes.map((x, i) => {
    if (x.type === "run") return run(x);
    const kids = renderInline(x.children || []);
    if (x.type === "em") return <em key={i}>{kids}</em>;
    if (x.type === "strong") return <strong key={i}>{kids}</strong>;
    if (x.type === "code") return <code key={i}>{kids}</code>;
    // a link is styled text, never an anchor: nothing is navigable, and its destination is not shown as a target the browser knows
    if (x.type === "link") return <span key={i} className="md-link">{kids}</span>;
    // an image is its literal source text: nothing is loaded
    if (x.type === "image") return <span key={i} className="md-image">{kids}</span>;
    return <span key={i}>{kids}</span>;
  });
}
