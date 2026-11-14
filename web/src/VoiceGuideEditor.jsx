import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "./lib.js";
import { VoiceDialog } from "./VoiceDialog.jsx";
import { GUIDE_MAX, SECTIONS, addSpan, chars, composeGuide, covered, hasHeadingLine, lineDiff, parseGuide } from "./voice-guide.js";

const keep = (e) => e.preventDefault();
const STATUS = { same: "Same as saved", changed: "Changed", new: "New" };
const norm = (s) => String(s ?? "").trim();
const PRIVATE_HINT = ["examples", "calibration"];

/**
 * A box that grows with its text (no inner scroll). `field-sizing` is not everywhere, so the height is set here, again when the window
 * changes size (the lines wrap differently).
 */
function AutoText({ value, shown, ...rest }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !shown) return;
    const fit = () => {
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight + 2}px`;
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [value, shown]);
  return <textarea ref={ref} value={value} {...rest} />;
}

/**
 * One section. It reports `onSeen` once every part of its text box has been on screen, top to bottom, at some moment while it was open:
 * only then can a changed section be used. A box taller than the window has to be scrolled through; its top in view, or a jump past
 * its middle to the end, is not enough. When the box changes height (the person types a line), what was covered so far is forgotten.
 * Ceiling: "on screen" is the box's place inside the window and the editor's scroll area, not whether the person's eyes read it.
 */
function Block({ spec, saved, text, open, tick, locked, over, hashLine, diffOpen, onText, onTick, onOpen, onDiff, onSeen }) {
  const wrap = useRef(null);
  const status = saved === undefined ? "new" : norm(saved) === norm(text) ? "same" : "changed";
  useEffect(() => {
    const box = wrap.current;
    const el = box?.querySelector("textarea");
    if (!open || !el) return;
    const scroller = box.closest(".vg-scroll");
    let spans = [];
    let height = 0;
    let done = false;
    const check = () => {
      if (done) return;
      if (el.scrollHeight > el.clientHeight + 2) return; // lines cut off at the bottom of the box: nothing counts until it fits again
      const r = el.getBoundingClientRect();
      if (Math.abs(r.height - height) > 1) {
        spans = [];
        height = r.height;
      }
      let top = Math.max(r.top, 0);
      let bottom = Math.min(r.bottom, window.innerHeight || document.documentElement.clientHeight);
      if (scroller) {
        const v = scroller.getBoundingClientRect();
        top = Math.max(top, v.top);
        bottom = Math.min(bottom, v.bottom);
      }
      spans = addSpan(spans, top - r.top, bottom - r.top);
      if (covered(spans, height)) {
        done = true;
        onSeen(spec.id);
      }
    };
    check();
    // a fold elsewhere can move the box into view with no scroll: the observer only says when to look again
    const io = typeof IntersectionObserver === "function" ? new IntersectionObserver(check, { threshold: [0, 0.25, 0.5, 0.75, 1] }) : null;
    io?.observe(el);
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(check) : null;
    ro?.observe(el);
    window.addEventListener("scroll", check, { passive: true, capture: true }); // capture: the editor's own scroll area too
    window.addEventListener("resize", check);
    return () => {
      io?.disconnect();
      ro?.disconnect();
      window.removeEventListener("scroll", check, { capture: true });
      window.removeEventListener("resize", check);
    };
  }, [open, spec.id, onSeen]);
  const n = chars(text);
  const id = spec.id;
  return (
    <section className="vg-sec" data-testid={`vg-section-${id}`} data-status={status} data-open={open ? "1" : "0"} aria-labelledby={`vg-h-${id}`}>
      <div className="vg-head">
        <h3 id={`vg-h-${id}`}>{spec.title}</h3>
        <span className={`vg-status ${status}`} data-testid={`vg-status-${id}`}>
          {STATUS[status]}
        </span>
      </div>
      <div className="vg-controls">
        <button type="button" className="btn quiet sm" data-testid={`vg-fold-${id}`} aria-expanded={open} onMouseDown={keep} onClick={() => onOpen(!open)}>
          {open ? "Hide" : "Show"}
        </button>
        {status !== "same" && (
          <button type="button" className="btn quiet sm" data-testid={`vg-changes-toggle-${id}`} aria-expanded={diffOpen} onMouseDown={keep} onClick={() => onDiff(!diffOpen)}>
            {diffOpen ? "Hide changes" : "Show changes"}
          </button>
        )}
        <label className="vc-check vg-tick">
          <input type="checkbox" checked={tick} disabled={locked} data-testid={`vg-tick-${id}`} onChange={(e) => onTick(e.target.checked)} />
          <span>Use this section</span>
        </label>
      </div>
      {locked && (
        <p className="vc-hint" data-testid={`vg-locked-${id}`}>
          Open this section and read it before you use it.
        </p>
      )}
      <div ref={wrap} className="vg-box" hidden={!open}>
        {PRIVATE_HINT.includes(id) && <p className="vc-hint">Examples are quoted from your files. Check they hold nothing private.</p>}
        <AutoText className="vc-text vg-text" data-testid={`vg-text-${id}`} aria-labelledby={`vg-h-${id}`} aria-invalid={over} value={text} shown={open} spellCheck={false} onChange={(e) => onText(e.target.value)} />
        <p className={`vc-count ${over ? "over" : ""}`} data-testid={`vg-count-${id}`}>
          {n} of {spec.max} characters
        </p>
        {over && (
          <p className="vc-err" role="alert" data-testid={`vg-over-${id}`}>
            This is too long. Trim it to {spec.max} characters, then save.
          </p>
        )}
        {hashLine && (
          <p className="vc-err" role="alert" data-testid={`vg-hash-${id}`}>
            A line in a section cannot start with #.
          </p>
        )}
      </div>
      {diffOpen && status !== "same" && (
        <ul className="vg-diff" data-testid={`vg-diff-${id}`} aria-label={`Changes in ${spec.title}`}>
          {lineDiff(saved ?? "", text).map((d, i) => (
            <li key={i} className={`vg-line ${d.t}`} data-t={d.t}>
              <span className="vg-mark" aria-hidden="true">
                {d.t === "add" ? "+" : d.t === "del" ? "-" : " "}
              </span>
              <span className="vg-linetext">{d.text || " "}</span>
              <span className="vg-sr">{d.t === "add" ? " (added)" : d.t === "del" ? " (removed)" : ""}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * "Your voice guide": the agent's draft (or the saved guide, from "Open guide") one section at a time, in plain text boxes, nothing
 * rendered. A section that differs from the saved guide can be used only after it has been open on screen; the Save button is after the
 * last section, so every section is passed on the way. Save sends the text this page composes from the boxes (never a draft id), then
 * the draft is discarded. `voice` is the page's voice state; `draft` is null when the saved guide is opened for editing.
 */
export function VoiceGuideEditor({ voice, draft, onVoice, onClose, onSaved }) {
  const saved = voice.guide || { text: "", on: false };
  const savedParsed = useMemo(() => parseGuide(saved.text), []); // eslint-disable-line react-hooks/exhaustive-deps -- a snapshot at open
  const base = useMemo(() => (draft ? parseGuide(draft.text) : savedParsed), []); // eslint-disable-line react-hooks/exhaustive-deps
  const savedBody = useMemo(() => new Map(savedParsed.sections.map((s) => [s.id, s.body])), [savedParsed]);
  const specs = SECTIONS.filter((s) => base.sections.some((b) => b.id === s.id));
  const init = useMemo(() => {
    const texts = {};
    const open = {};
    const ticks = {};
    for (const b of base.sections) {
      texts[b.id] = b.body;
      const same = savedBody.has(b.id) && norm(savedBody.get(b.id)) === norm(b.body);
      open[b.id] = !same;
      ticks[b.id] = same;
    }
    return { texts, open, ticks };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [texts, setTexts] = useState(init.texts);
  const [open, setOpen] = useState(init.open);
  const [ticks, setTicks] = useState(init.ticks);
  const [seen, setSeen] = useState({});
  const [diffs, setDiffs] = useState({});
  const [on, setOn] = useState(saved.text ? saved.on : true);
  const [send, setSend] = useState(saved.send === "short" ? "short" : "full");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false); // "close without saving?"
  const [askSave, setAskSave] = useState(false); // "save without the typing in unticked boxes?"
  const [askDiscard, setAskDiscard] = useState(false); // "discard the draft and the typing?"
  const seenRef = useRef(seen);
  seenRef.current = seen;

  const onSeen = useMemo(
    () => (id) => {
      if (!seenRef.current[id]) setSeen((s) => (s[id] ? s : { ...s, [id]: true }));
    },
    []
  );
  const statusOf = (id) => (!savedBody.has(id) ? "new" : norm(savedBody.get(id)) === norm(texts[id]) ? "same" : "changed");
  const lockedOf = (id) => statusOf(id) !== "same" && !seen[id];

  const composed = composeGuide(texts, ticks, savedParsed.sections);
  const total = chars(composed);
  const problems = specs.filter((s) => ticks[s.id] && (chars(texts[s.id]) > s.max || hasHeadingLine(texts[s.id])));
  const sections = parseGuide(composed).sections;
  const hasShort = sections.some((s) => s.id === "short" && chars(s.body) <= SECTIONS[0].max);
  const sendMode = hasShort ? send : "full";
  const fromDraft = specs.filter((s) => ticks[s.id] && norm(texts[s.id]) && statusOf(s.id) !== "same").length; // what the draft adds or changes
  const already = sections.length - fromDraft;
  const dirty = specs.some((s) => texts[s.id] !== init.texts[s.id] || ticks[s.id] !== init.ticks[s.id]);
  const canSave = !busy && composed !== "" && total <= GUIDE_MAX && problems.length === 0;
  // typing in a box that is not ticked is left out of the save: Save asks first, so it is never lost without a word
  const untickedEdits = specs.filter((s) => !ticks[s.id] && texts[s.id] !== init.texts[s.id]);

  // typing does not count as reading: one key pressed at the top of a tall box would unlock the lines far below it
  const setText = (id, v) => setTexts((t) => ({ ...t, [id]: v }));
  const tryClose = () => (dirty ? setAsking(true) : onClose());
  const useAll = () => setTicks((t) => Object.fromEntries(specs.map((s) => [s.id, t[s.id] || !lockedOf(s.id)])));

  async function save() {
    setAskSave(false);
    setBusy(true);
    setError("");
    try {
      let v = await api("/api/voice/guide", { method: "POST", body: { text: composed, on, send: sendMode } });
      // the server discards the draft only when it is still the one on screen (`at`): a newer draft that arrived meanwhile stays
      if (draft) v = await api("/api/voice/draft/discard", { method: "POST", body: { at: draft.at } }).catch(() => v);
      onVoice(v);
      onSaved(on);
    } catch {
      setError("Could not save that. Try again.");
      setBusy(false);
    }
  }

  async function discard() {
    setAskDiscard(false);
    try {
      onVoice(await api("/api/voice/draft/discard", { method: "POST", body: { at: draft.at } })); // only this draft, never a newer one
      onClose();
    } catch {
      setError("Could not discard that. Try again.");
    }
  }

  return (
    <VoiceDialog title="Your voice guide" testid="voice-guide-editor" onClose={tryClose}>
      {draft && (
        <p>
          <span className="vg-badge" data-testid="vg-badge">
            Draft from the agent
          </span>
        </p>
      )}
      {draft && (
        <p className="vc-hint vg-warn" data-testid="vg-warning">
          The agent wrote this after reading your writing. Read every section. Nothing is used until you save it.
        </p>
      )}
      <div className="vg-scroll" data-testid="vg-scroll">
        {draft && saved.text && !savedParsed.structured && (
          <div className="vg-old" data-testid="vg-unstructured">
            <p className="vc-hint">Your saved guide is not in sections. Saving replaces it.</p>
            <AutoText className="vc-text vg-text" aria-label="Your saved guide" readOnly value={saved.text} shown spellCheck={false} />
          </div>
        )}
        {specs.map((s) => (
          <Block
            key={s.id}
            spec={s}
            saved={savedBody.get(s.id)}
            text={texts[s.id]}
            open={!!open[s.id]}
            tick={!!ticks[s.id]}
            locked={lockedOf(s.id) && !ticks[s.id]}
            over={chars(texts[s.id]) > s.max}
            hashLine={hasHeadingLine(texts[s.id])}
            diffOpen={!!diffs[s.id]}
            onText={(v) => setText(s.id, v)}
            onTick={(v) => setTicks((t) => ({ ...t, [s.id]: v }))}
            onOpen={(v) => setOpen((o) => ({ ...o, [s.id]: v }))}
            onDiff={(v) => setDiffs((d) => ({ ...d, [s.id]: v }))}
            onSeen={onSeen}
          />
        ))}
        <div className="vg-end" data-testid="vg-end">
          <p className={`vc-count ${total > GUIDE_MAX ? "over" : ""}`} data-testid="vg-total">
            {total} of 7,000 characters
          </p>
          {total > GUIDE_MAX && (
            <p className="vc-err" role="alert" data-testid="vg-total-over">
              This is too long. Trim it to 7,000 characters, then save.
            </p>
          )}
          <p className="vc-hint" data-testid="vg-summary">
            This saves {sections.length} sections: {fromDraft} from the draft and {already} you already had.
          </p>
          <label className="vc-check">
            <input type="checkbox" checked={on} data-testid="vg-send" onChange={(e) => setOn(e.target.checked)} />
            <span>Send my guide with every request</span>
          </label>
          {hasShort && (
            <div className="vg-choice" role="radiogroup" aria-label="What to send">
              <label className="vc-check">
                <input type="radio" name="vg-send-mode" checked={sendMode === "full"} data-testid="vg-send-full" onChange={() => setSend("full")} />
                <span>Full guide</span>
              </label>
              <label className="vc-check">
                <input type="radio" name="vg-send-mode" checked={sendMode === "short"} data-testid="vg-send-short" onChange={() => setSend("short")} />
                <span>Short form only</span>
              </label>
            </div>
          )}
          {error && (
            <p className="vc-err" role="alert" data-testid="vg-error">
              {error}
            </p>
          )}
          {askDiscard && !asking ? (
            <div className="vg-ask" role="group" aria-label="Discard your changes" data-testid="vg-ask-discard">
              <p>You have changes that are not saved. Discarding the draft loses them.</p>
              <div className="dialog-actions">
                <button type="button" className="btn" data-testid="vg-discard-keep" onClick={() => setAskDiscard(false)}>
                  Keep editing
                </button>
                <button type="button" className="btn" data-testid="vg-discard-anyway" disabled={busy} onClick={discard}>
                  Discard anyway
                </button>
              </div>
            </div>
          ) : askSave && untickedEdits.length > 0 && !asking ? (
            <div className="vg-ask" role="group" aria-label="Save without your changes" data-testid="vg-ask-save">
              <p>
                You changed {untickedEdits.map((s) => s.title).join(", ")} but did not tick "Use this section". Saving leaves those changes out.
              </p>
              <div className="dialog-actions">
                <button type="button" className="btn" data-testid="vg-save-keep" onClick={() => setAskSave(false)}>
                  Keep editing
                </button>
                <button type="button" className="btn" data-testid="vg-save-anyway" disabled={!canSave} onClick={save}>
                  Save without them
                </button>
              </div>
            </div>
          ) : asking ? (
            <div className="vg-ask" role="group" aria-label="Close without saving" data-testid="vg-ask">
              <p>You have changes that are not saved.</p>
              <div className="dialog-actions">
                <button type="button" className="btn" data-testid="vg-keep-editing" onClick={() => setAsking(false)}>
                  Keep editing
                </button>
                <button type="button" className="btn" data-testid="vg-close-anyway" onClick={onClose}>
                  Close without saving
                </button>
              </div>
            </div>
          ) : (
            <div className="dialog-actions">
              <button type="button" className="btn" data-testid="vg-use-all" onClick={useAll}>
                Use all sections
              </button>
              <button type="button" className="btn primary" data-testid="vg-save" disabled={!canSave} onClick={() => (untickedEdits.length ? setAskSave(true) : save())}>
                Save guide
              </button>
              {draft && (
                <button
                  type="button"
                  className="btn"
                  data-testid="vg-discard"
                  disabled={busy}
                  onClick={() => (dirty ? setAskDiscard(true) : discard())}
                >
                  Discard draft
                </button>
              )}
              <button type="button" className="btn" data-testid="vg-cancel" onClick={tryClose}>
                Cancel
              </button>
            </div>
          )}
        </div>
      </div>
    </VoiceDialog>
  );
}
