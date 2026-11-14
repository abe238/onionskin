// Where the Ask and Comment chip goes: beside the end of the selection, else below it, else above it, whichever covers the least text,
// and always inside the page. (Above only is how it used to go, and it sat on the line the person was reading above the selection.)
export const CHIP_W = 160; // the chip is about 150 px wide and 32 px tall; these leave room
export const CHIP_H = 36;
const GAP = 8;
const TEXT = ".de-p, .de-cell, [data-sid]"; // what the engine draws text in: Word paragraphs, spreadsheet cells, slide shapes

/** Square pixels of text under each rectangle (viewport coordinates) inside `root`. A glyph box is a little taller than its letters, so it is trimmed 3 px top and bottom. */
export function textUnder(root, rects) {
  const area = rects.map(() => 0);
  if (!root) return area;
  for (const el of root.querySelectorAll(TEXT)) {
    const b = el.getBoundingClientRect();
    if (!rects.some((c) => b.bottom > c.top && b.top < c.bottom && b.right > c.left && b.left < c.right)) continue;
    const r = document.createRange();
    r.selectNodeContents(el);
    for (const t of r.getClientRects()) {
      if (t.width < 1) continue;
      rects.forEach((c, i) => {
        const ox = Math.min(c.right, t.right) - Math.max(c.left, t.left);
        const oy = Math.min(c.bottom, t.bottom - 3) - Math.max(c.top, t.top + 3);
        if (ox > 0 && oy > 0) area[i] += ox * oy;
      });
    }
  }
  return area;
}

/**
 * `rs`: the selection's rectangles (viewport), `box`: the overlay's rectangle, `under(rects)`: the text under each. Returns the chip's left and top in the
 * viewport. A place is only a candidate when the whole chip is inside `box`; the least text under it wins, ties go to beside, then below, then above.
 * With no candidate that fits (a box too small) it goes above or below the last line, as before.
 */
export function placeChip(rs, box, under) {
  const first = rs[0];
  const last = rs[rs.length - 1];
  const x = Math.min(Math.max(box.left + 8, last.right + 6), Math.max(box.left + 8, box.right - CHIP_W));
  const spots = [];
  if (last.right + 6 + CHIP_W <= box.right - 8) spots.push({ x: last.right + 6, y: last.top + (last.bottom - last.top - CHIP_H) / 2 }); // beside the end of the last line
  spots.push({ x, y: last.bottom + GAP }); // below
  spots.push({ x, y: first.top - CHIP_H - 2 }); // above the first line (never on the selection's own lines)
  const fits = spots.filter((s) => s.y >= box.top + 4 && s.y + CHIP_H <= box.bottom - 4 && s.x >= box.left && s.x + CHIP_W <= box.right);
  if (!fits.length) return { x, y: last.top - box.top > 44 ? last.top - 38 : last.bottom + GAP };
  const area = under(fits.map((s) => ({ left: s.x, top: s.y, right: s.x + CHIP_W, bottom: s.y + CHIP_H })));
  let best = 0;
  for (let i = 1; i < fits.length; i++) if (area[i] < area[best] - 0.5) best = i;
  return fits[best];
}
