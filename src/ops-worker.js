import { env } from "./constants.js";
import "./html-parser.js"; // an HTML file's ops run here, never on the server's or the CLI's thread (test/html-parser-thread.test.js)
import { previewAll, runOps } from "./ops/run.js";

// The engine's work for a quick change, off the server's thread (src/offload.js opsOffThread), run by src/worker-host.js within a time
// and memory limit: the count a quick preview and a quick plan show (`preview`: previewAll) and the change itself made on this Mac
// (`run`: runOps, which the local runner's apply calls through src/local.js). An outside review: a 12,538-byte document of one
// paragraph of 8 million characters held the server's thread for 4 s while its matches were counted. One message back: {ok: true, p} |
// {ok: true, r: runOps' answer}. ONIONSKIN_TEST_OPS_DELAY_MS (tests only) blocks this thread for that long first, the way a slow count
// would.
export async function work({ kind, bytes, format, op, ops, name, partial, anchors }) {
  const delay = Number(env("TEST_OPS_DELAY_MS", 0));
  if (delay > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (kind === "preview") return { ok: true, p: await previewAll(b, format, op, { name }) };
  return { ok: true, r: await runOps({ bytes: b, format, name, ops, partial, anchors: new Map(anchors || []) }) };
}
