import fs from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "../constants.js";

const here = path.dirname(fileURLToPath(import.meta.url));
/** The DOM-free engine core bundled for Node (scripts/build-engine-node.mjs). ONIONSKIN_ENGINE_NODE points tests at a scratch build. */
export const engineNodePath = () => env("ENGINE_NODE", path.join(here, "..", "..", "vendor", "engine-node", "engine-node.mjs"));

let loaded;
export function loadEngine() {
  return (loaded ??= import(pathToFileURL(engineNodePath()).href));
}

const LOAD_TIMEOUT_MS = 120_000;

/**
 * Opens bytes in a headless engine (same Engine class the browser's worker runs, on this thread).
 * Returns {engine, info, events, waitFor(pred)}: waitFor resolves from the engine's own events, no polling.
 */
export async function openEngine(bytes, name) {
  const { Engine } = await loadEngine();
  const events = [];
  const waiters = new Set();
  const engine = new Engine((event, data) => {
    events.push({ event, data });
    for (const w of [...waiters]) if (w.pred(event, data)) (waiters.delete(w), w.resolve(data));
  });
  const info = await engine.open(new Blob([bytes]), { name });
  const waitFor = (pred) => {
    const seen = events.find((e) => pred(e.event, e.data));
    if (seen) return Promise.resolve(seen.data);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve: (d) => (clearTimeout(timer), resolve(d)) };
      const timer = setTimeout(() => (waiters.delete(w), reject(new Error("the engine did not finish loading in time"))), LOAD_TIMEOUT_MS);
      waiters.add(w);
    });
  };
  return { engine, info, events, waitFor };
}
