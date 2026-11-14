# Contract: engine host hooks

Implemented in `onionskin-engine` (branch `onionskin`), `src/host/`, exported from the package root. Full user documentation: `docs/host.md` in the engine. This file is the contract the app and server lanes build against. If the engine differs, the engine's `src/host/types.ts` wins and this file gets fixed.

## Obtaining the handle

```ts
<DocViewer onHost={(host: DocHost | null) => void} editBarTarget={HTMLElement | null} toolbar={false} comments={false} allowOpen={false} fileMenu={false} />
```

`onHost` fires after a document is open (and again with a new handle when the document is replaced) and with `null` when it is closed. The handle is valid until then.

## Locations

```ts
interface DocxLocation { blockPath: number[]; paraId?: string; start?: number; end?: number }
interface XlsxLocation { sheetIndex: number; sheetName: string; range: string }          // A1: 'B2', 'B2:D9', '3:5', 'C:D', '' = sheet
interface PptxLocation { slideIndex: number; slideId?: string; shapeId?: number; shapeName?: string; cell?: { row: number; col: number } }
```

- DOCX `blockPath`: `[i]` or `[i, row, col, k]`. `i` is the index into the engine's `Block[]` as streamed by `docx:blocks` for those bytes (section breaks are blocks). It is NOT the index among `w:body` children, and engine `pid` is never exposed. The server must derive durable anchors by re-parsing the saved bytes with the same engine (headless) so the index means the same thing, or map `paraId`/text hash instead. `paraId` = `w14:paraId` when the source paragraph had one; absent for paragraphs created in the editor.
- `start`/`end`: character offsets into the paragraph text as shown (tracked deletions excluded, an inline object = 1 char).
- PPTX `shapeId`: `cNvPr id` of the element itself (children of a group keep their own; the group's id is the DOM `data-top`). `slideId`: `p:sldId id` (string).

## Handle

```ts
interface DocHost {
  readonly format: 'docx' | 'xlsx' | 'pptx'
  onEdit(listener: (e: EditEvent) => void): () => void
  flush(): Promise<void>
  saveBytes(): Promise<Blob>
  getViewState(): ViewState | null
  setViewState(state: ViewState): Promise<boolean>   // true = exact; false = fallback applied or nothing done
  hitTest(clientX: number, clientY: number): ElementAnchor | null
  rectsFor(location: HostLocation): DOMRect[]        // client coordinates; [] if not rendered
  scrollTo(location: HostLocation): Promise<boolean> // true = rendered afterwards
  selection(): HostSelection | null
  onSelectionChange(listener: (s: HostSelection | null) => void): () => void
  setReadOnly(readOnly: boolean): void
  readonly readOnly: boolean
}
```

## Edit events

```ts
interface EditEvent<F, K, L> { format: F; kind: K; before: string; after: string; location: L; detail?: Record<string, unknown> }
```

- Emitted after the engine applied the change; local edits only (not collaborators'); listeners are isolated (one throwing does not stop the rest).
- Typing emits one event per keystroke; `before`/`after` are the full paragraph (DOCX, PPTX shape: paragraphs joined `\n`) or cell. Coalesce in the consumer.
- DOCX kinds: `text format paragraph.insert paragraph.delete table table.insert table.delete undo redo`.
- XLSX kinds: `cell format replace import undo redo sheet.<op> book.<op>`. `cell`: `before` = previous formula (else value) read from the worker before the edit is sent; `after` = the input typed. A paste over more than 200 cells is ONE `cell` event over the bounding range with `detail.cells`.
- PPTX kinds: `text format undo redo shape.<insert|delete|transform|fill|line|order|duplicate|anchor> slide.<add|duplicate|delete|move|hide|background>`. `shape.delete`: `before` = the shape's text.

## View state

```ts
interface DocxViewState { format: 'docx'; blockPath: number[]; textHash: string; quote: string; offsetPx: number; zoom: number | 'fit'; fraction?: number }
interface XlsxViewState { format: 'xlsx'; sheetIndex: number; sheetName: string; topLeft: string; selection: string }
interface PptxViewState { format: 'pptx'; slideIndex: number; zoom: number | 'fit' }
```

- DOCX: `offsetPx` is unzoomed px of the paragraph that is above the view's top edge. `textHash` = `hashText(paragraph text)` (exported; FNV-1a 32 bit over white-space-collapsed text, 8 hex digits). `setViewState` waits (up to 8 s) for progressive pagination to reach the paragraph; if the path no longer holds that hash it searches by hash nearby, then by `quote` prefix, else scrolls to `fraction` and returns `false`.
- XLSX: sheet matched by name first, then index (`false` if only the index matched).

## Anchors and selection

```ts
interface ElementAnchor { format; kind: 'text'|'paragraph'|'image'|'table'|'cell'|'shape'|'slide'|'sheet-cell'|'region'; location; quote?: string; rect: DOMRect }
interface HostSelection { format; kind: 'text'|'shape'|'range'; location; quote: string; prefix: string; suffix: string; endLocation?: DocxLocation; collapsed: boolean }
```

- `hitTest` returns `null` outside the document viewport; inside it, never less than `'region'`. DOCX `text`: the word, with `start`/`end`. DOCX `region`: nearest block of the nearest page. XLSX header/corner: `region` with a row/column range. PPTX: empty slide area = `slide`; gap between slides = `region`.
- `quote` ≤ 500 chars; `prefix`/`suffix` ≤ 40 chars of the same paragraph/cell.
- DOCX `selection()` reads the browser selection; it is `null` once focus leaves the document. Consumers must capture from `onSelectionChange`.

## Chrome

- `toolbar={false}`: no engine top bar (name, File menu, Comments/Edit/Save buttons). `editBarTarget`: format toolbar rendered into that element (pass as state). `comments={false}`: no comments UI at all (button, panel, context-menu entry, Ctrl/Cmd+Alt+M, marks).
- `allowOpen={false}`: no File > New / Open. `fileMenu={false}`: no File menu and no Ctrl/Cmd+P/O. With the menu shown, `allowSave`/`allowDownload` remove Save/Download as/Print; **Rename and Document details cannot be hidden individually** (no prop exists). Use `fileMenu={false}` or `toolbar={false}` to hide the menu entirely.
- `setReadOnly(true)`: `contenteditable` off, toolbar gone, Edit button hidden; no remount, scroll and sheet/slide kept. Call `flush()` first if an edit may be open.

## Not in this lane

- The page reads the rendered DOCX paragraphs directly, outside this contract: `.de-p[data-bi]` elements and their `textContent` (`paragraphText`, `verifyBlock`, `historyLoc`, `changedPaint` in `App.jsx`, and "changes shown in place" in `writein-live.js`, which also takes `textContent` offsets as `rectsFor` `start`/`end` and confirms each place with `hitTest`). A change to that markup breaks these silently; the place falls back to the outline.
- Proposed for upstream, not built: `replaceSource(src: Blob, view: ViewState): Promise<boolean>` on the handle. Open `src` in a new client while the current pages stay painted, lay it out off screen until `view` is reached (the `setViewState` search rules), swap in one frame, fire `onHost` with the new handle, emit no `onEdit`, resolve `true` only when the view was kept exactly, refuse a non-Blob `src`. With it a refresh after an agent run would no longer remount the viewer; today it does.

- Writing `w14:paraId` on new/regenerated paragraphs (a later fork lane): events carry no `paraId` for paragraphs created in the editor, and a paragraph the worker regenerates after an edit keeps the id the model had.
- Existing in-file comments are not exposed through the handle (the engine comments UI can be hidden; `client.call('comments.list')` still returns them).
