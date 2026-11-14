// Node entry for the Onionskin agent side (`onionskin apply`). Bundled by scripts/build-engine-node.mjs from the engine
// source at the vendored commit. DOM-free: the Engine class runs on the calling thread, no Worker, no React.
export { Engine } from './core/worker/engine'
export { paraSpec } from './core/docx/spec'

import { isNode, kidOf, local, parseRaw, rootEl, type RChild } from './core/raw'
import { protectReason } from './core/docx/protect'

/**
 * The engine's own protect classifier over a whole word/document.xml: one entry per paragraph in document order (a paragraph
 * nested inside another one, such as a text box, is part of its outer paragraph and not listed), the reason or null.
 * Onionskin's batch `protected` flag comes from here, so the batch and `apply` agree with the editor.
 */
export function protectReasons(documentXml: string): (string | null)[] {
  const out: (string | null)[] = []
  const visit = (n: RChild) => {
    if (!isNode(n)) return
    if (local(n.q) === 'p') {
      out.push(protectReason(n) ?? null)
      return
    }
    n.c.forEach(visit)
  }
  const body = kidOf(rootEl(parseRaw(documentXml)), 'body')
  if (body) visit(body)
  return out
}
