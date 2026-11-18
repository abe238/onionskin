import { nfc } from "../nfc.js";
import { exactHash, normText, textHash } from "../text.js";
import { untrusted } from "../sanitize.js";

export { normText, textHash };

/** Result helpers. Statuses: applied, skipped_protected, refused, anchor_not_found, expect_mismatch (and not_applied, set by the runner). */
export const fail = (status, reason, extra = {}) => ({ ok: false, status, reason, ...extra });
export const refused = (code, reason) => fail("refused", reason, { code });

/** Code of an engine error: the engine attaches `code` to its refusals; anything else is a plain failure. */
export const engineFailure = (err) => ({ ...refused(typeof err?.code === "string" ? err.code : "engine_error", String(err?.message || err).split("\n")[0].slice(0, 300)), dirty: true }); // dirty: the engine may be half-way through the edit

export const excerpt = (text) => untrusted(text, 200);

/**
 * `expect` against the target's text. mode "contains": quote must occur in the text (DOCX, PPTX). mode "exact": the text must equal it character for character after NFC (XLSX regions).
 * Returns null when it holds, else an expect_mismatch failure carrying a short excerpt of what is really there.
 */

export function checkExpect(expect, text, mode = "contains") {
  const exact = mode === "exact";
  const hash = exact ? exactHash(text) : textHash(text);
  if ("quote" in expect) {
    const ok = exact ? nfc(text) === nfc(expect.quote) : normText(text).includes(normText(expect.quote));
    if (!ok) return fail("expect_mismatch", "the target no longer says what `expect.quote` says", { actual_excerpt: excerpt(text) });
  }
  if ("text_hash" in expect && expect.text_hash !== hash) return fail("expect_mismatch", "the target's text hash differs from `expect.text_hash`", { actual_excerpt: excerpt(text), actual_text_hash: hash });
  return null;
}

export const colLetters = (n) => {
  let s = "";
  for (n += 1; n; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};
export const colIndex = (letters) => [...letters.toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

/** "B2" or "B2:D9" -> {r0,c0,r1,c1} (0-based, inclusive), normalized so r0<=r1 and c0<=c1 */
export function parseA1(a1) {
  const m = /^([A-Za-z]{1,3})([0-9]{1,7})(?::([A-Za-z]{1,3})([0-9]{1,7}))?$/.exec(a1);
  if (!m) return null;
  const r0 = Number(m[2]) - 1;
  const c0 = colIndex(m[1]);
  const r1 = m[4] ? Number(m[4]) - 1 : r0;
  const c1 = m[3] ? colIndex(m[3]) : c0;
  if (r0 < 0 || r1 < 0) return null;
  return { r0: Math.min(r0, r1), c0: Math.min(c0, c1), r1: Math.max(r0, r1), c1: Math.max(c0, c1) };
}
