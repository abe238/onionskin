// Stopping a worker thread while it is inside zlib aborts the whole server process on Node 26: terminating it between the creation of a
// zlib handle and its init leaves a handle the worker's cleanup closes uninitialized ("CompressionStream::Close() Assertion failed:
// init_done_ && \"close before init\"", SIGABRT). src/offload.js startWorker therefore never stops a worker inside a zlib call: the
// worker marks each call in a word it shares with its parent, and the parent, before it terminates the worker, marks that it is stopping
// it and waits for the call in progress to end. The worker never starts another call once its parent is stopping it.
// The word: bit 1 = the worker is inside a call, bit 2 = the parent is stopping it. Imports nothing, so src/worker-host.js stays
// synchronous to evaluate. On the server's own thread no word is set and gated(fn) just runs fn.

const INSIDE = 1;
export const STOPPING = 2;
let word = null;
let depth = 0;

/** Called once by src/worker-host.js with the worker's shared word (an Int32Array over a SharedArrayBuffer, index 1). */
export function setStopGate(arr) {
  word = arr;
}

/** Runs fn (a zlib call) where the worker cannot be stopped; when the parent is stopping it, waits here until it is stopped. */
export function gated(fn) {
  if (!word) return fn();
  if (depth === 0 && Atomics.compareExchange(word, 1, 0, INSIDE) !== 0) {
    for (;;) Atomics.wait(word, 1, STOPPING); // the parent is stopping this worker: never enter zlib again, terminate() ends this wait
  }
  depth++;
  try {
    return fn();
  } finally {
    if (--depth === 0) {
      Atomics.and(word, 1, ~INSIDE);
      Atomics.notify(word, 1);
    }
  }
}
