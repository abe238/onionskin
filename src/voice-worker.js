import fs from "node:fs";
import { readDocxParagraphs } from "./docx.js";
import { documentRuns, editPairs, exampleOf, pairSignals } from "./voice.js";

/**
 * The learning step for one Send: three DOCX versions linked through the agent's output (pre, post, mine) in, the per-pair signals and the
 * export examples out. Pure over bytes. {pairs: [{short, sentences, exclaim, restored, fmt}], examples: [{agent, mine}]}; nothing else
 * from the document leaves it (the examples are untrusted document-derived text, already sanitized and capped by exampleOf).
 */
export function analyzeVoice(preBytes, postBytes, mineBytes) {
  const pre = readDocxParagraphs(preBytes);
  const post = readDocxParagraphs(postBytes);
  const found = editPairs(pre, post, readDocxParagraphs(mineBytes));
  const runs = documentRuns([...pre, ...post]); // an example's "mine" side may not be text either version already holds
  return { pairs: found.map(pairSignals), examples: found.map((p) => exampleOf(p, runs)).filter(Boolean) };
}

// Run in a worker thread by src/worker-host.js: data = {pre, post, mine}, three snapshot blob paths. One message back,
// {ok: true, pairs, examples} or {ok: false, error}. A version that cannot be read or parsed fails the whole job and learns nothing.
export function work({ pre, post, mine }) {
  try {
    return { ok: true, ...analyzeVoice(fs.readFileSync(pre), fs.readFileSync(post), fs.readFileSync(mine)) };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}
