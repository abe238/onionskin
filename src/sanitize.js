// Built with new RegExp from escaped strings so no raw separator characters live in this source file.
// C0 (\n \t \r become spaces first), DEL, C1, bidi controls (LRM/RLM/ALM, embeddings, overrides, isolates), zero-width and BOM.
import { nfc } from "./nfc.js";
const STRIP = new RegExp("[\\u0000-\\u001F\\u007F-\\u009F\\u061C\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF]", "g");
const WS = new RegExp("[\\t\\n\\r\\u2028\\u2029]+", "g");
// the user's own words keep newlines (\u000A) and tabs; everything else control/bidi is dropped
const USER_STRIP = new RegExp("[\\u0000-\\u0008\\u000B-\\u001F\\u007F-\\u009F\\u061C\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069\\uFEFF]", "g");
const MAX_UNTRUSTED = 500;
const MARK = "…[truncated]";

/** Untrusted document-derived text: strip control and bidi characters, NFC, collapse whitespace, cap at 500 chars including the marker. */
// Of a longer value only the first READ_PER_KEPT x max characters are cleaned: what is kept is at most `max` characters, and cleaning all
// of a paragraph of 7.9 million characters, for each of 50 comments quoting it, held the server's thread 2.5 s at Send.
const READ_PER_KEPT = 16;
export function untrusted(value, max = MAX_UNTRUSTED) {
  if (value == null) return "";
  let raw = String(value);
  const cut = raw.length > READ_PER_KEPT * max;
  if (cut) raw = raw.slice(0, READ_PER_KEPT * max);
  let s = nfc(raw.replace(WS, " ").replace(STRIP, ""));
  s = s.replace(/ {2,}/g, " ").trim();
  const cps = [...s];
  if (cps.length > max) s = cps.slice(0, max - [...MARK].length).join("") + MARK;
  else if (cut) s = cps.slice(0, Math.max(0, max - [...MARK].length)).join("") + MARK; // cut before it was cleaned: still says so
  return s;
}

/** The user's own words: keep newlines, strip other control and bidi characters, cap generously. */
// Of a longer value only the first READ_PER_KEPT x max characters are read, as in untrusted(): 50 comments of 7.9 million characters
// each were normalized whole at every draft save.
export function userText(value, max = 5000) {
  if (value == null) return "";
  let raw = String(value);
  const cut = raw.length > READ_PER_KEPT * max;
  if (cut) raw = raw.slice(0, READ_PER_KEPT * max);
  const s = nfc(raw.replace(/\r\n?/g, "\n").replace(USER_STRIP, ""));
  const cps = [...s];
  return cps.length > max ? cps.slice(0, max).join("") + MARK : cut ? s + MARK : s;
}

const FLAG_KEEP = new Set(["code", "severity"]);
/**
 * The one chokepoint for flags that leave the package checks, the session or apply. Every string except `code` and `severity` came from
 * the document (a part name, a relationship target, an error message) or from an agent, so it passes through `untrusted()` (no control
 * or bidi characters, one line, at most 200 characters). Arrays are cleaned element by element; numbers and booleans pass unchanged.
 */
export function cleanFlag(flag) {
  const clean = (v) => (typeof v === "string" ? untrusted(v, 200) : Array.isArray(v) ? v.map(clean) : v);
  const out = {};
  for (const [k, v] of Object.entries(flag)) out[k] = FLAG_KEEP.has(k) ? v : clean(v);
  return out;
}

/** True when `value` holds a control, bidi or zero-width character (the set `untrusted()` strips, newlines included). */
export const hasControlChars = (value) => new RegExp(STRIP.source).test(String(value)) || new RegExp(WS.source).test(String(value));
