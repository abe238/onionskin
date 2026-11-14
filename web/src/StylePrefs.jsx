import React, { useEffect, useRef, useState } from "react";
import { api } from "./lib.js";
import { VoiceExport } from "./VoiceExport.jsx";
import { VoiceImport } from "./VoiceImport.jsx";
import { VoiceGuideBlock } from "./VoiceGuideBlock.jsx";
import { VoiceLearning, VoiceSuggestions } from "./VoiceSuggestions.jsx";
import { TRAITS, useVoice } from "./voice-ui.js";
import "./style-prefs.css";
import "./voice.css";
import "./voice-guide.css";

const EXCLUSIVE = ["formal", "relaxed"];
const MAX_WORDS = 280;

const toggled = (traits, id) => {
  if (traits.includes(id)) return traits.filter((t) => t !== id);
  return [...traits.filter((t) => !(EXCLUSIVE.includes(id) && EXCLUSIVE.includes(t))), id];
};

/**
 * The composer's "Writing preferences" line, its panel, and the one offer after a Revert. A preference is only ever switched on by a tap
 * (or by the person's typing): nothing from the document or the agent's answer is read here.
 */
export function StylePrefs({ sid, session, readOnly }) {
  const [style, setStyle] = useState({ traits: [], words: "" });
  const [open, setOpen] = useState(false);
  const [offer, setOffer] = useState(false);
  const [words, setWords] = useState("");
  const [err, setErr] = useState("");
  // learning and the guide: loaded with the page, again when the panel opens and when the agent finishes a draft (a new voice entry)
  const [voice, setVoice] = useVoice(true, `${open}:${session.activity?.find((a) => a.kind === "voice")?.id || ""}`);
  const latest = useRef(style);
  latest.current = style;
  const offered = useRef(false); // the offer shows once per page load
  const seenRevert = useRef(undefined);

  useEffect(() => {
    api(`/api/style?s=${sid}`)
      .then((s) => {
        setStyle(s);
        setWords(s.words || "");
      })
      .catch(() => {});
  }, [sid]);

  // A Revert that happens while this page is open (not one already in the list when the page loaded) offers the unused preferences once.
  const revertId = session.activity?.find((a) => a.kind === "revert")?.id || null;
  useEffect(() => {
    if (seenRevert.current === undefined) {
      seenRevert.current = revertId;
      return;
    }
    if (revertId && revertId !== seenRevert.current && !offered.current && !readOnly) {
      offered.current = true;
      setOffer(true);
    }
    seenRevert.current = revertId;
  }, [revertId, readOnly]);

  async function save(next) {
    setErr("");
    try {
      const saved = await api(`/api/style?s=${sid}`, { method: "POST", body: next });
      setStyle(saved);
      return saved;
    } catch (e) {
      setErr("Could not save that. Try again.");
      return null;
    }
  }
  const tap = (id) => save({ traits: toggled(latest.current.traits, id), words: latest.current.words });
  const saveWords = () => (words.trim() === latest.current.words ? null : save({ traits: latest.current.traits, words }));
  const clearAll = async () => {
    const s = await save({ traits: [], words: "" });
    if (s) setWords("");
  };
  const done = async () => {
    await saveWords();
    setOpen(false);
  };

  // every voice answer carries the preferences as they are now (a suggestion turned on changes them)
  const onVoice = (v) => {
    setVoice(v);
    if (v?.style) setStyle(v.style);
  };

  const on = TRAITS.filter((t) => style.traits.includes(t.id));
  const summary = [...on.map((t) => t.label), ...(style.words ? ["your own words"] : [])];
  const keep = (e) => e.preventDefault();

  return (
    <div className="style-prefs" data-testid="style-prefs">
      <div className="sp-line">
        <span className="sp-sum" data-testid="style-summary">
          Writing preferences: {summary.length ? summary.join(", ") : "none"}
        </span>
        {!readOnly && !open && (
          <button type="button" className="btn quiet sm" data-testid="style-change" onMouseDown={keep} onClick={() => { setOffer(false); setOpen(true); }}>
            Change
          </button>
        )}
      </div>
      {offer && !open && (
        <div className="sp-offer" role="group" aria-label="Writing preferences" data-testid="style-offer">
          <p>Want the agent to do it differently next time?</p>
          <div className="sp-chips">
            {TRAITS.filter((t) => !style.traits.includes(t.id)).map((t) => (
              <button key={t.id} type="button" className="btn sm" data-testid={`style-offer-${t.id}`} onMouseDown={keep} onClick={() => tap(t.id)}>
                {t.label}
              </button>
            ))}
            <button type="button" className="btn quiet sm" data-testid="style-offer-no" onMouseDown={keep} onClick={() => setOffer(false)}>
              Not now
            </button>
          </div>
        </div>
      )}
      {!open && <VoiceGuideBlock sid={sid} session={session} voice={voice} onVoice={onVoice} readOnly={readOnly} />}
      {open && (
        <div className="sp-panel" role="group" aria-label="Writing preferences" data-testid="style-panel">
          <div className="sp-chips">
            {TRAITS.map((t) => (
              <button key={t.id} type="button" className="btn sm sp-trait" aria-pressed={style.traits.includes(t.id)} data-testid={`style-trait-${t.id}`} onMouseDown={keep} onClick={() => tap(t.id)}>
                {t.label}
              </button>
            ))}
          </div>
          <label htmlFor="style-words">In your own words (optional)</label>
          <textarea id="style-words" data-testid="style-words" rows={2} maxLength={MAX_WORDS} value={words} onChange={(e) => setWords(e.target.value)} onBlur={saveWords} />
          <p className="sp-hint">These go to the agent with every request.</p>
          {voice && (
            <>
              <VoiceSuggestions voice={voice} onVoice={onVoice} />
              <VoiceLearning voice={voice} onVoice={onVoice} />
              <VoiceGuideBlock sid={sid} session={session} voice={voice} onVoice={onVoice} readOnly={readOnly} panel>
                <div className="vc-files">
                  <VoiceExport voice={voice} style={style} />
                  <VoiceImport voice={voice} onVoice={onVoice} />
                </div>
              </VoiceGuideBlock>
            </>
          )}
          {err && <p className="sp-err" role="alert">{err}</p>}
          <div className="sp-actions">
            <button type="button" className="btn quiet sm" data-testid="style-clear" onMouseDown={keep} onClick={clearAll}>
              Clear preferences
            </button>
            <button type="button" className="btn primary sm" data-testid="style-done" onMouseDown={keep} onClick={done}>
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
