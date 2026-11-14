import React from "react";

/** The ground behind the glass. One preset at a time, drawn with CSS only (gradients and transforms: no bitmap, no filter animation).
 *  `thumb` renders the same layers inside a scaled, static stage for the picker tiles. */
export function Backdrop({ name, image, effective = 1, thumb = false, testid }) {
  let layers = null;
  if (name === "pages")
    layers = (
      <>
        <i className="sheet doc" />
        <i className="sheet grid" />
        <i className="sheet slide" />
        <i className="sheet note" />
        <i className="sheet grid2" />
      </>
    );
  else if (name === "paper")
    layers = (
      <>
        <i className="leaf l1" />
        <i className="leaf l2" />
        <i className="leaf l3" />
        <i className="leaf l4" />
      </>
    );
  else if (name === "aurora")
    layers = (
      <>
        <i className="wash w1" />
        <i className="wash w2" />
        <i className="wash w3" />
      </>
    );
  else if (name === "midnight")
    layers = (
      <>
        <i className="pool p1" />
        <i className="pool p2" />
        <i className="pool p3" />
      </>
    );
  else if (name === "custom" && image) layers = <i className="bgimg" style={{ backgroundImage: `url(${image.url})`, opacity: effective }} />;
  const el = (
    <div className={`backdrop ${thumb ? "thumb" : ""}`} data-bg={name} data-testid={thumb ? undefined : testid} data-effective={name === "custom" ? effective.toFixed(3) : undefined} aria-hidden="true">
      {layers}
    </div>
  );
  return thumb ? (
    <span className="bgthumb" aria-hidden="true">
      <span className="bgstage">{el}</span>
    </span>
  ) : (
    el
  );
}
