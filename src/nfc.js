// Unicode normalization in time linear in the text. Pure and without imports: the server, the CLI and the page (web/src) normalize
// document text with this one function, so the same text hashes the same everywhere.
//
// String.prototype.normalize sorts each run of combining marks by combining class, in time quadratic in the run's length: one Word
// paragraph of "a" followed by 120,000 marks held the server's thread for 4 to 6 seconds (an outside review). Unicode's Stream-Safe
// Text Format (UAX #15) bounds a run at 30 non-starters, which no real text needs more of. A run of more than MAX_MARKS characters of
// general category M (every non-starter is one) is left as it is, and the text between such runs is normalized: one linear scan, no
// sort longer than MAX_MARKS. Text without such a run (every real script: Vietnamese, Arabic with harakat, Hebrew with niqqud,
// Devanagari, emoji sequences, Zalgo text within the limit) is normalized whole, exactly as before, so hashes stored by earlier
// versions of ordinary text do not change. The result depends on the text alone, and normalizing it again gives it back.
// Ceiling: an over-long run is not reordered or composed (its base letter stays apart from its first mark).
// Compatibility forms (NFKC, NFKD) too: U+FF9E and U+FF9F (halfwidth katakana voiced and semi-voiced sound marks) are not of category M
// but decompose to the combining marks U+3099 and U+309A, so "ﾞ̕" repeated built the same unbounded combining sequence out of what
// the run pattern did not see (2.4 s at 40,000 pairs, four times the 20,000's). They count as marks in a run. test/nfc.test.js scans
// every code point for another character whose compatibility decomposition starts with a mark: these two (and the Thai and Lao
// sara am, whose first character has combining class 0, so nothing to sort) are all there are.

export const MAX_MARKS = 30;
// at most CHUNK marks a match, joined into runs by the loop below: an unbounded match of 7.9 million marks overflowed the regex stack
// ("a" + "\u0315\u0300" x 3,949,999: Send answered 422 "Maximum call stack size exceeded")
const CHUNK = 4096;
const RUNS = new RegExp(`[\\p{M}\\uFF9E\\uFF9F]{1,${CHUNK}}`, "gu");

/** s.normalize(form), linear in the length of s (see above). Null and undefined read as "". */
export function nfc(s, form = "NFC") {
  s = String(s ?? "");
  let out = null;
  let from = 0;
  let start = -1; // the run being read: [start, end)
  let end = -1;
  const close = () => {
    // UTF-16 units first (never fewer than the marks), then the marks themselves (a mark outside the BMP is two units)
    if (start < 0 || end - start <= MAX_MARKS || (end - start <= 2 * MAX_MARKS && [...s.slice(start, end)].length <= MAX_MARKS)) return;
    (out ||= []).push(s.slice(from, start).normalize(form), s.slice(start, end));
    from = end;
  };
  RUNS.lastIndex = 0;
  for (let m; (m = RUNS.exec(s)); ) {
    if (m.index !== end) (close(), (start = m.index));
    end = m.index + m[0].length;
  }
  close();
  if (!out) return s.normalize(form);
  out.push(s.slice(from).normalize(form));
  return out.join("");
}
