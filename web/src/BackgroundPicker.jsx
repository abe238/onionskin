import React, { useEffect, useRef, useState } from "react";
import { Backdrop } from "./Backdrop.jsx";
import { Icon } from "./Icons.jsx";
import { PRESETS } from "./background.js";

/** The Background popover: live thumbnails of every preset in the current theme, a Choose image tile, and (with a custom image) strength and blur. */
export function BackgroundPicker({ ctl, onClose }) {
  const { bg, hasImage, thumbImage, effective, clamped, message, busy } = ctl;
  const ref = useRef(null);
  const fileRef = useRef(null);
  const [drag, setDrag] = useState(false);
  const tiles = [...PRESETS.map((p) => ({ id: p.id, label: p.label })), ...(hasImage ? [{ id: "custom", label: "Your image" }] : [])];
  const selected = bg.kind === "custom" ? "custom" : bg.name;
  const [focusId, setFocusId] = useState(selected);

  useEffect(() => {
    ref.current?.querySelector(`[data-tile="${selected}"]`)?.focus();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const away = (e) => !ref.current?.contains(e.target) && !e.target.closest?.("[data-bgopener]") && onClose(false);
    const esc = (e) => e.key === "Escape" && (e.preventDefault(), onClose(true));
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [onClose]);

  const choose = (id) => (id === "custom" ? ctl.useImage() : ctl.choosePreset(id));
  const keys = (e) => {
    const i = tiles.findIndex((t) => t.id === focusId);
    const to = { ArrowRight: i + 1, ArrowDown: i + 3, ArrowLeft: i - 1, ArrowUp: i - 3, Home: 0, End: tiles.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    const n = Math.min(tiles.length - 1, Math.max(0, to));
    setFocusId(tiles[n].id);
    ref.current?.querySelector(`[data-tile="${tiles[n].id}"]`)?.focus();
  };
  const drop = (e) => {
    e.preventDefault();
    setDrag(false);
    ctl.upload(e.dataTransfer?.files?.[0]);
  };

  return (
    <div
      className={`bgpop glass-pop ${drag ? "drag" : ""}`}
      ref={ref}
      role="dialog"
      aria-label="Background"
      data-testid="bg-popover"
      onDragOver={(e) => (e.preventDefault(), setDrag(true))}
      onDragLeave={(e) => !ref.current?.contains(e.relatedTarget) && setDrag(false)}
      onDrop={drop}
    >
      <div className="bgpop-h">
        <h2>Background</h2>
        <button type="button" className="iconbtn" onClick={() => onClose(true)} aria-label="Close" data-testid="bg-close">
          <Icon name="close" size={16} />
        </button>
      </div>
      <div className="bgtiles" role="radiogroup" aria-label="Background" onKeyDown={keys}>
        {tiles.map((t) => (
          <button
            key={t.id}
            type="button"
            role="radio"
            aria-checked={selected === t.id}
            aria-label={t.label}
            className="bgtile"
            data-tile={t.id}
            data-testid={`bg-tile-${t.id}`}
            tabIndex={focusId === t.id ? 0 : -1}
            onFocus={() => setFocusId(t.id)}
            onClick={() => choose(t.id)}
          >
            <Backdrop name={t.id} thumb image={t.id === "custom" ? thumbImage : null} effective={t.id === "custom" ? effective : 1} />
            <span className="bglabel">{t.label}</span>
          </button>
        ))}
        <button type="button" className="bgtile bgchoose" onClick={() => fileRef.current?.click()} disabled={busy} data-testid="bg-choose" aria-label="Choose image">
          <span className="bgthumb">
            <Icon name="image" size={22} />
          </span>
          <span className="bglabel">{busy ? "Preparing" : "Choose image…"}</span>
        </button>
      </div>
      <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/heic,image/heif" hidden data-testid="bg-file" onChange={(e) => (ctl.upload(e.target.files?.[0]), (e.target.value = ""))} />
      {bg.kind === "custom" && hasImage && (
        <div className="bgctl">
          <label className="bgrow">
            <span>Image strength</span>
            <input type="range" min="0" max="100" step="1" value={bg.strength} onChange={(e) => ctl.setStrength(Number(e.target.value))} data-testid="bg-strength" aria-label="Image strength" aria-valuetext={`${bg.strength} percent`} />
            <output>{bg.strength}</output>
          </label>
          {clamped && (
            <p className="bghint" data-testid="bg-hint" role="status">
              Held at {Math.round(effective * 100)} so the text stays readable on this picture.
            </p>
          )}
          <label className="bgrow check">
            <input type="checkbox" checked={bg.blur} onChange={(e) => ctl.setBlur(e.target.checked)} data-testid="bg-blur" />
            <span>Blur image</span>
          </label>
        </div>
      )}
      <p className="bgerr" role="alert" data-testid="bg-error" hidden={!message}>
        {message}
      </p>
      <div className="bgfoot">
        <span className="bgnote">PNG, JPEG, WebP or HEIC, up to 15 MB. Stays on this computer.</span>
        {hasImage && (
          <button type="button" className="btn quiet" onClick={ctl.remove} data-testid="bg-remove">
            Remove image
          </button>
        )}
        <button type="button" className="btn quiet" onClick={ctl.reset} data-testid="bg-reset">
          Reset to default
        </button>
      </div>
    </div>
  );
}
