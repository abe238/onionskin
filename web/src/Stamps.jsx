import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "./lib.js";
import { BUILT_IN, LANGUAGES, SELECT_ONE_SENTENCE, SUGGEST_TASKS, stampText } from "./stamps.js";
import { SuggestOffer } from "./SuggestOffer.jsx";
import { stampHintOn } from "./suggest.js";
import "./stamps.css";

const keep = (e) => e.preventDefault(); // a tap must not move the focus out of the text box (Safari does not focus buttons on click anyway)
const MAX_OWN = 8;

/** The person's own stamps, loaded once. `save` resolves to the stored list or rejects with a plain message to show. */
export function useStamps() {
  const [own, setOwn] = useState([]);
  const [load, setLoad] = useState("loading");
  useEffect(() => {
    api("/api/stamps")
      .then((r) => {
        if (!Array.isArray(r.stamps)) return setLoad("failed");
        setOwn(r.stamps);
        setLoad("ready");
      })
      .catch(() => setLoad("failed"));
  }, []);
  const save = useCallback(async (list) => {
    const r = await api("/api/stamps", { method: "POST", body: { stamps: list } });
    setOwn(r.stamps);
    setLoad("ready");
    return r.stamps;
  }, []);
  return { own, save, load };
}


/**
 * The stamp row of the Quick ask box. Two taps from a selection: Ask, then a stamp. Translate asks for a language first.
 * Tapping a stamp calls onStamp(words, stamp); the page sends it as an ordinary comment, exactly as if the person had typed those words, or
 * (quick fixes on, one sentence selected, a built-in Shorter, Friendlier or Fix grammar) shows a suggestion first. `suggest` =
 * {on, format, onOn, oneSentence}: whether quick fixes are set up, what the one-time offer needs, and whether the selection is certainly not one sentence.
 */
export function Stamps({ own, save, load, dirtyRef, disabled, onStamp, suggest }) {
  const [mode, setMode] = useState("row"); // row | language | edit
  const [pending, setPending] = useState(null); // the stamp waiting for a language
  const [draft, setDraft] = useState([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [hot, setHot] = useState(null); // the stamp under the pointer or focus: the one-sentence notice is for a stamp that can suggest
  const keyRef = useRef(0);
  const stripKeys = (list) => list.map(({ _key, ...s }) => s);

  const tap = (stamp) => {
    if (stamp.language) {
      setPending(stamp);
      return setMode("language");
    }
    onStamp(stampText(stamp), stamp);
  };
  const edit = () => {
    setDraft(own.map((s) => ({ ...s, _key: ++keyRef.current })));
    setError("");
    setMode("edit");
  };
  const change = (i, k, v) => setDraft((d) => d.map((s, j) => (j === i ? { ...s, [k]: v } : s)));
  const add = () => {
    if (draft.length >= MAX_OWN) return setError("You can keep up to 8 stamps.");
    setError("");
    setDraft((d) => [...d, { label: "", words: "", _key: ++keyRef.current }]);
  };
  const cancel = () => {
    setDraft([]);
    setError("");
    setMode("row");
  };
  const dirty = mode === "edit" && JSON.stringify(stripKeys(draft)) !== JSON.stringify(own);
  useLayoutEffect(() => {
    dirtyRef.current = dirty;
    return () => { dirtyRef.current = false; };
  }, [dirtyRef, dirty]);
  const saveAll = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await save(stripKeys(draft));
      setError("");
      setMode("row");
    } catch (e) {
      setError(e?.message || "That did not save. Try again.");
    } finally {
      setBusy(false);
    }
  };

  if (mode === "language")
    return (
      <div className="stamps" data-testid="stamps">
        <p className="stamps-h">Translate into</p>
        <div className="stamps-row" role="group" aria-label="Languages">
          {LANGUAGES.map((l) => (
            <button key={l} type="button" className="stamp" disabled={disabled} data-testid="stamp-language" onMouseDown={keep} onClick={() => onStamp(stampText(pending, l))}>
              {l}
            </button>
          ))}
          <button type="button" className="stamp stamp-quiet" data-testid="stamp-back" onMouseDown={keep} onClick={() => setMode("row")}>
            Back
          </button>
        </div>
      </div>
    );

  if (mode === "edit")
    return (
      <div className="stamps" data-testid="stamps-edit">
        {load === "failed" && <p className="stamps-err" role="alert">Could not load your stamps. Saving will replace any saved stamps.</p>}
        {draft.map((s, i) => (
          <div className="stamp-edit" key={s._key ?? i}>
            <input type="text" value={s.label} disabled={busy} aria-label="Name" placeholder="Name" data-testid="stamp-name" onChange={(e) => change(i, "label", e.target.value)} />
            <input type="text" value={s.words} disabled={busy} aria-label="What it asks for" placeholder="What it asks for" data-testid="stamp-words" onChange={(e) => change(i, "words", e.target.value)} />
            <button type="button" className="stamp stamp-quiet" disabled={busy} data-testid="stamp-remove" onClick={() => setDraft((d) => d.filter((_, j) => j !== i))}>
              Remove
            </button>
          </div>
        ))}
        {error && (
          <p className="stamps-err" role="alert" data-testid="stamps-error">
            {error}
          </p>
        )}
        <div className="stamps-row">
          <button type="button" className="stamp" disabled={busy} data-testid="stamp-add" onClick={add}>
            Add a stamp
          </button>
          <button type="button" className="stamp stamp-go" disabled={!dirty || busy} data-testid="stamp-save" onClick={saveAll}>
            Save
          </button>
          <button type="button" className="stamp stamp-quiet" disabled={busy} data-testid="stamp-done" onClick={dirty ? saveAll : () => setMode("row")}>
            Done
          </button>
          <button type="button" className="stamp stamp-quiet" disabled={busy} data-testid="stamp-cancel" onClick={cancel}>
            Cancel
          </button>
        </div>
      </div>
    );

  return (
    <div className="stamps" data-testid="stamps">
      <div className="stamps-row" role="group" aria-label="Stamps">
        {[...BUILT_IN, ...own].map((s, i) => (
          <button key={s.id || `own-${i}`} type="button" className="stamp" disabled={disabled} data-testid="stamp" title={s.language ? undefined : s.words} onMouseDown={keep} onMouseEnter={() => setHot(s.id)} onMouseLeave={() => setHot(null)} onFocus={() => setHot(s.id)} onBlur={() => setHot(null)} onClick={() => tap(s)}>
            {s.label}
          </button>
        ))}
        <button type="button" className="stamp stamp-quiet" data-testid="stamp-edit" disabled={load === "loading"} onClick={edit}>
          Edit stamps
        </button>
      </div>
      {suggest && <SuggestOffer format={suggest.format} on={suggest.on} onOn={suggest.onOn} tasks={suggest.tasks} unavailable={suggest.unavailable} />}
      <p className="stamps-hint" data-testid="stamps-hint">{suggest?.on ? (suggest.oneSentence && hot && (suggest.tasks ?? SUGGEST_TASKS).includes(hot) ? SELECT_ONE_SENTENCE : stampHintOn(suggest.tasks)) : "Tap a stamp to send it with your other changes."}</p>
    </div>
  );
}
