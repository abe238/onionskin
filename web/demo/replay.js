// The Try-it page's pure helpers: no React, no engine, no network. test/demo.test.js runs them in node.
// Everything the recording holds is untrusted data (the agent's words, the letter's words): it is only compared as plain strings and
// handed to React as text, never built into a RegExp, markup or an address.
import { findOnce, needlesFor } from "../src/writein.js";

export const SCHEMA = "onionskin.demo/1";
/** A recorded wait over LONG_MS is shown in SHORT_MS, and the page says so. */
export const LONG_MS = 12_000;
export const SHORT_MS = 6_000;

/** How long the working state runs: {ms, shortened, seconds} (seconds = the real wait, rounded, for the sentence). */
export function workingPlan(resultMs) {
  const real = Number.isFinite(resultMs) && resultMs > 0 ? resultMs : 0;
  const shortened = real > LONG_MS;
  return { ms: shortened ? SHORT_MS : real, shortened, seconds: Math.round(real / 1000) };
}

/** The working line, exactly as the design gives it. */
export function workingText(plan) {
  return plan.shortened ? "Agent working. This replay is shortened." : "Agent working. This replay runs at the real speed.";
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** "2026-11-12" -> "November 12, 2026", read as written (a Date would parse it as UTC and show the day before in America). */
export function dateText(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof day === "string" ? day : "");
  if (!m || +m[2] < 1 || +m[2] > 12) return "";
  return `${MONTHS[+m[2] - 1]} ${+m[3]}, ${m[1]}`;
}

/** base64 -> bytes, with atob (the CSP allows no fetch of a data: address). */
export function fromBase64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");

/**
 * The page loads only the bundled letter: each version's SHA-256 must equal the recording's. `digest(bytes)` resolves an ArrayBuffer
 * (crypto.subtle.digest in the page). Any doubt is false: the page then shows the error line and mounts nothing.
 */
export async function versionsMatch(recording, v0, v1, digest) {
  try {
    if (!recording || recording.schema !== SCHEMA || recording.format !== "docx") return false;
    const want = [recording.v0_sha256, recording.v1_sha256];
    if (!want.every((h) => typeof h === "string" && /^[0-9a-f]{64}$/.test(h))) return false;
    const got = [hex(await digest(v0)), hex(await digest(v1))];
    return got[0] === want[0] && got[1] === want[1];
  } catch {
    return false;
  }
}

/** One page of the letter as the engine shows it: [{bi, text}] for each top-level paragraph. */
const only = (paras, test) => {
  const hits = paras.filter(test);
  return hits.length === 1 ? hits[0] : null;
};

/**
 * Where a prepared comment's words sit: {bi, start, end} when exactly one paragraph holds the quote exactly once, else null (the page
 * then outlines nothing).
 */
export function findQuote(paras, quote) {
  if (!Array.isArray(paras) || typeof quote !== "string" || !quote.trim()) return null;
  const p = only(paras, (x) => !!findOnce(x.text, quote));
  if (!p) return null;
  const f = findOnce(p.text, quote);
  return { bi: p.bi, start: f.start, end: f.end };
}

const flat = (s) => s.replace(/\s+/g, " ").trim();

/**
 * Where one recorded place's new words sit in the letter after the agent: {bi, ranges: [{start, end, was}]} or null (all or nothing).
 * The paragraph is the only one that opens with the place's text_start and holds every unchanged and new piece of the diff, in order
 * (the diff may skip text, marked with a gap); each change's words must then be found exactly once in it. start === end for a pure
 * deletion (where the words went).
 */
export function placeRanges(paras, place) {
  try {
    if (!Array.isArray(paras) || !place || !Array.isArray(place.diff) || typeof place.text_start !== "string") return null;
    const opening = flat(place.text_start);
    if (!opening) return null;
    // the pieces the agent left, joined across each run of steps with no gap between them
    const pieces = [];
    let run = "";
    for (const op of place.diff) {
      if (!Array.isArray(op) || op[0] === "…") (pieces.push(run), (run = ""));
      else if (op[0] === "=" || op[0] === "+") run += String(op[1]);
    }
    pieces.push(run);
    const holds = (text) => {
      const t = flat(text);
      if (!t.startsWith(opening)) return false;
      let from = 0;
      for (const piece of pieces.map(flat).filter(Boolean)) {
        const at = t.indexOf(piece, from);
        if (at < 0) return false;
        from = at + piece.length;
      }
      return true;
    };
    const p = only(paras, (x) => typeof x.text === "string" && holds(x.text));
    const changes = needlesFor(place);
    if (!p || !changes) return null;
    const ranges = [];
    let prevEnd = -1;
    for (const c of changes) {
      const f = findOnce(p.text, c.needle);
      if (!f) return null;
      const start = f.at(c.insStart);
      const end = c.insEnd === c.insStart ? start : f.at(c.insEnd - 1) + 1;
      if (start <= prevEnd || end < start || end > p.text.length) return null;
      ranges.push({ start, end, was: c.was });
      prevEnd = Math.max(start, end);
    }
    return { bi: p.bi, ranges };
  } catch {
    return null;
  }
}

/** The "Done" / "Declined" word for an answered comment. */
export const statusText = (s) => (s === "declined" ? "Declined" : "Done");
