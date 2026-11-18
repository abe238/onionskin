// The located nodes of an HTML file, read in a worker thread (the parser is never loaded on a test's own thread either, so the code under
// test runs as on the server's thread). Test-only. Returns [{id, text: value of a text node | null, tag: an element's tag | null,
// parent: the parent element's tag}], in source order.
import { Worker } from "node:worker_threads";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CODE = `
import { parentPort, workerData } from "node:worker_threads";
await import(${JSON.stringify(path.join(repo, "src", "html-parser.js"))});
const H = await import(${JSON.stringify(path.join(repo, "src", "html.js"))});
const read = H.readHtml(Buffer.from(workerData));
parentPort.postMessage(read.nodes.map((x) => ({ id: x.__id, text: x.nodeName === "#text" ? x.value : null, tag: x.tagName ?? null, parent: x.__par?.tagName ?? null })));
`;

export function htmlNodes(bytes) {
  return new Promise((resolve, reject) => {
    const w = new Worker(CODE, { eval: true, workerData: new Uint8Array(bytes) });
    w.once("message", (m) => (resolve(m), w.terminate()));
    w.once("error", reject);
  });
}

/** The id of the first text node whose text holds `needle`. */
export async function textId(bytes, needle) {
  const n = (await htmlNodes(bytes)).find((x) => x.text !== null && x.text.includes(needle));
  if (!n) throw new Error(`no text node holds ${JSON.stringify(needle)}`);
  return n;
}
