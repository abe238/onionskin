// The answer of GET /api/html-view (docs/contracts/routes.md): one binary body the page reads without parsing a large JSON. Pure, no
// imports: the server encodes it (src/server.js) and the page decodes it (web/src/HtmlHost.jsx), from this same file.
//
// Layout (little-endian):
//   0  4 bytes  "OSKV"
//   4  u32      length of the header JSON in bytes (H)
//   8  H bytes  header JSON (UTF-8): {version, plain, reason, stats, texts: n, editable: m, ident: k}
//      padding to a multiple of 4
//      n x i32  texts: the copy's n-th text node is source text node texts[n], or -1 (src/html-render.js)
//      m x i32  editable: the source text nodes the person may type in (src/html.js editableTextIds)
//      k x i32  ident: their identities, 6 per editable node in the same order (src/html.js editIdentities), or none (k = 0)
//      rest     the copy (UTF-8): set once as the frame's srcdoc
// `texts` and `editable` hold one entry per text node (200,000 at the limits), so they travel as Int32Arrays: the page takes views on the
// one ArrayBuffer it received, nothing is copied or parsed.

const MAGIC = [0x4f, 0x53, 0x4b, 0x56]; // "OSKV"

/** The parts of the body: [prefix (magic, header, padding, both arrays), copy]. The server writes them in turn (no 40 MB concatenation). */
export function encodeHtmlView({ version, plain, reason, stats, texts, editable, ident = [], copy }) {
  const head = new TextEncoder().encode(JSON.stringify({ version, plain: !!plain, reason: reason ?? null, stats: stats ?? null, texts: texts.length, editable: editable.length, ident: ident.length }));
  const at = (8 + head.length + 3) & ~3;
  const count = texts.length + editable.length + ident.length;
  const prefix = new Uint8Array(at + 4 * count);
  prefix.set(MAGIC, 0);
  new DataView(prefix.buffer).setUint32(4, head.length, true);
  prefix.set(head, 8);
  const ints = new Int32Array(prefix.buffer, at, count);
  ints.set(texts, 0);
  ints.set(editable, texts.length);
  ints.set(ident, texts.length + editable.length);
  return [prefix, copy];
}

/** The page's side: {version, plain, reason, stats, texts, editable, ident (Int32Arrays), copy (Uint8Array)}; throws on a bad body. */
export function decodeHtmlView(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u8.length < 8 || MAGIC.some((b, i) => u8[i] !== b)) throw new Error("not an HTML view");
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const len = dv.getUint32(4, true);
  if (8 + len > u8.length) throw new Error("a cut HTML view");
  const head = JSON.parse(new TextDecoder().decode(u8.subarray(8, 8 + len)));
  const at = (8 + len + 3) & ~3;
  const n = head.texts;
  const m = head.editable;
  const k = head.ident ?? 0;
  const end = at + 4 * (n + m + k);
  if (!Number.isInteger(n) || !Number.isInteger(m) || !Number.isInteger(k) || end > u8.length) throw new Error("a cut HTML view");
  // an Int32Array view needs an aligned offset in its buffer: copied only when the body's own offset is not (it is for a fetched body)
  const ints = (u8.byteOffset + at) % 4 === 0 ? new Int32Array(u8.buffer, u8.byteOffset + at, n + m + k) : new Int32Array(u8.slice(at, end).buffer);
  return { version: head.version, plain: head.plain, reason: head.reason, stats: head.stats, texts: ints.subarray(0, n), editable: ints.subarray(n, n + m), ident: ints.subarray(n + m), copy: u8.subarray(end) };
}
