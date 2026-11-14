import React, { useState } from "react";
import { VoiceDialog } from "./VoiceDialog.jsx";
import { buildVoiceMd } from "./voice-md.js";
import { EXAMPLE_MAX, traitSentences } from "./voice-ui.js";

const keep = (e) => e.preventDefault();

/** Hands the text to the browser as a download named voice.md (the browser decides the folder). */
function download(text) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "voice.md";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/**
 * "Save as voice.md". The file holds the preferences that are on, the person's own words and their saved guide. Examples are the one part
 * that came from a document: each shows both sides in full as plain text, none is ticked, at most three can be, and only ticked ones are
 * written (voice-md.js escapes them again). `style` is the page's current preferences; `voice` has the saved guide and the kept examples.
 */
export function VoiceExport({ voice, style }) {
  const [open, setOpen] = useState(false);
  const [ticked, setTicked] = useState([]); // example ids
  const examples = Array.isArray(voice.examples) ? voice.examples : [];
  const sentences = traitSentences(style?.traits);
  const words = style?.words || "";
  const guide = voice.guide?.text || "";
  const empty = !sentences.length && !words.trim() && !guide.trim() && !ticked.length;
  const full = ticked.length >= EXAMPLE_MAX;

  const close = () => {
    setOpen(false);
    setTicked([]);
  };
  const tick = (id) => setTicked((t) => (t.includes(id) ? t.filter((x) => x !== id) : t.length >= EXAMPLE_MAX ? t : [...t, id]));
  const save = () => {
    const chosen = examples.filter((e) => ticked.includes(e.id)).map((e) => ({ agent: e.agent, mine: e.mine }));
    download(buildVoiceMd({ traits: sentences, words, guide, examples: chosen, date: new Date() }));
    close();
  };

  return (
    <>
      <button type="button" className="btn sm" data-testid="voice-export-open" onMouseDown={keep} onClick={() => setOpen(true)}>
        Save as voice.md
      </button>
      {open && (
        <VoiceDialog title="Save your writing voice" testid="voice-export" onClose={close}>
          <p>This makes a file you can give to other AI tools. It stays on this Mac until you share it.</p>
          {examples.length > 0 && (
            <div className="vc-examples" role="group" aria-labelledby="vc-examples-h" data-testid="voice-examples">
              <p id="vc-examples-h" className="vc-legend" data-testid="voice-examples-heading">
                Add examples (optional)
              </p>
              <p className="vc-hint">Only tick examples you are happy to share. The agent's text came from your document.</p>
              <p className="vc-hint" data-testid="voice-example-cap">
                You can include up to 3 examples.
              </p>
              <ul className="vc-list">
                {examples.map((e, i) => {
                  const on = ticked.includes(e.id);
                  return (
                    <li key={e.id} className="vc-example" data-testid={`voice-example-${i}`}>
                      <p className="vc-side">
                        <span className="vc-who">The agent wrote</span>
                        <span className="vc-quote" data-testid={`voice-example-agent-${i}`}>
                          {e.agent}
                        </span>
                      </p>
                      <p className="vc-side">
                        <span className="vc-who">You changed it to</span>
                        <span className="vc-quote" data-testid={`voice-example-mine-${i}`}>
                          {e.mine}
                        </span>
                      </p>
                      <label className="vc-check">
                        <input type="checkbox" checked={on} disabled={!on && full} data-testid={`voice-example-tick-${i}`} onChange={() => tick(e.id)} />
                        <span>Include this example</span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          <p className="vc-hint">Your browser decides where the file goes, usually Downloads.</p>
          {empty && <p className="vc-hint" data-testid="voice-export-empty">There is nothing to save yet. Turn on a preference or write your own words first.</p>}
          <div className="dialog-actions">
            <button type="button" className="btn primary" data-testid="voice-export-save" disabled={empty} onClick={save}>
              Save file
            </button>
            <button type="button" className="btn" data-testid="voice-export-cancel" onClick={close}>
              Cancel
            </button>
          </div>
        </VoiceDialog>
      )}
    </>
  );
}
