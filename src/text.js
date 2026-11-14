import crypto from "node:crypto";

/** NFC, whitespace collapsed, trimmed: the text every anchor, hash and comparison is built on. Null and undefined read as "". */
export const normText = (s) => String(s ?? "").normalize("NFC").replace(/\s+/g, " ").trim();

const sha16 = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);
/** 16-hex hash of the normalized text (DOCX paragraphs, PPTX shapes) */
export const textHash = (s) => sha16(normText(s));
/** 16-hex hash of the NFC text with whitespace kept (XLSX cells and regions compare character for character) */
export const exactHash = (s) => sha16(String(s ?? "").normalize("NFC"));

function bigrams(s) {
  const m = new Map();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    m.set(g, (m.get(g) || 0) + 1);
  }
  return m;
}
/** Dice coefficient over character bigrams of the normalized, lowercased strings (0..1). */
export function similarity(a, b) {
  a = normText(a).toLowerCase();
  b = normText(b).toLowerCase();
  if (!a && !b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const A = bigrams(a);
  const B = bigrams(b);
  let hit = 0;
  for (const [g, c] of A) hit += Math.min(c, B.get(g) || 0);
  return (2 * hit) / (a.length - 1 + b.length - 1);
}
