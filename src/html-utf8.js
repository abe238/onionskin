import fs from "node:fs";
import path from "node:path";
import { decodeHtml, NOT_READABLE_ENCODING, NOT_UTF8 } from "./html.js";

// The UTF-8 copy of an HTML file saved as windows-1252 or ISO-8859-1 (PLAN-html R10, R18: "Onionskin can save a UTF-8 copy and open
// that"). A CLI action, never the page's: `onionskin open` on such a file prints the sentence and the command, `onionskin utf8-copy
// <file>` writes `<name>.utf8.html` next to it (only when that name is free), the original untouched. No parser: decoding only.

/** The command that makes the copy, as `open` prints it. */
export const copyCommand = (bin, file, quote) => `${bin} utf8-copy ${quote(file)}`;

/** What `open` prints for a file Onionskin can make a UTF-8 copy of: the fixed sentence and the exact command. */
export const openRefusal = (bin, file, quote) => `${NOT_UTF8}\nMake the copy with:\n  ${copyCommand(bin, file, quote)}\nThen open the file it names.`;

/** Can this file's bytes be copied to UTF-8 (a declared windows-1252 or ISO-8859-1 file)? */
export const copyable = (bytes) => {
  const d = decodeHtml(bytes);
  return !d.ok && d.copyable === true;
};

/**
 * The UTF-8 bytes of a copyable file: decoded as windows-1252 (what a browser reads for both labels), its charset declaration in the
 * first 1,024 bytes said as utf-8 (else the copy would say one thing and be another). Returns {ok: true, bytes} or {ok: false, reason}.
 */
export function utf8Bytes(bytes) {
  const d = decodeHtml(bytes);
  if (d.ok) return { ok: false, reason: "This file is saved as UTF-8 already; open it as it is." };
  if (!d.copyable) return { ok: false, reason: d.sentence || NOT_READABLE_ENCODING };
  let text = new TextDecoder("windows-1252").decode(bytes);
  // the declaration sits in the first 1,024 bytes (src/html.js declaredCharset); those are one byte a character in windows-1252
  const head = text.slice(0, 1024).replace(/<!--[\s\S]*?(?:-->|$)|(<meta\b[^>]*?\bcharset\s*=\s*["']?\s*)([A-Za-z0-9_.:-]+)/gi, (m, pre) => (pre ? `${pre}utf-8` : m));
  text = head + text.slice(1024);
  const out = Buffer.from(text, "utf8");
  const check = decodeHtml(out);
  if (!check.ok) return { ok: false, reason: "Onionskin could not make a UTF-8 copy of this file that it can read." };
  return { ok: true, bytes: out };
}

/** The copy's path: `report.html` -> `report.utf8.html` (also for .htm), in the same folder. */
export const copyPath = (file) => path.join(path.dirname(file), `${path.basename(file, path.extname(file))}.utf8.html`);

/**
 * Writes the copy of `file` next to it, only when its name is free (exclusive create), the original untouched. Returns {ok: true,
 * path} or {ok: false, reason}.
 */
export function writeUtf8Copy(file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return { ok: false, reason: `There is no file at ${file}.` };
  }
  if (!st.isFile()) return { ok: false, reason: `${file} is not a regular file.` };
  if (!/\.html?$/i.test(file)) return { ok: false, reason: "utf8-copy makes a copy of an .html or .htm file." };
  const r = utf8Bytes(fs.readFileSync(file));
  if (!r.ok) return r;
  const to = copyPath(file);
  try {
    fs.writeFileSync(to, r.bytes, { flag: "wx" });
  } catch (err) {
    if (err?.code === "EEXIST") return { ok: false, reason: `${to} exists already, so nothing was written. Open that file, or move it away and run this again.` };
    return { ok: false, reason: `Could not write ${to}: ${err.message}` };
  }
  return { ok: true, path: to };
}
