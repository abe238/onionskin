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

## HTML view (`web/src/HtmlViewer.jsx`)

HTML files are not opened by the engine. `HtmlViewer` shows the server's render copy (src/html-render.js) in `<iframe sandbox="allow-same-origin">` and passes a handle to `onHost` that keeps the engine's names where the meaning is the same, so App.jsx can treat it like the others in most places. It is built on PLAN-html R14: no listener is ever added inside the frame (WebKit never fires them); the page polls the frame's selection and scroll every 50 ms, covers the frame with its own layer in comment and pin modes (`elementFromPoint` on the frame's document; in comment mode a press that moves selects the frame's text from the press to the pointer with `caretRangeFromPoint`, and the release picks that text), and shows a copy whose parts the person may type in are already `contenteditable="plaintext-only"` as the frame parses it (src/html.js editHosts: the element right above each editable text node, outermost first, unless its subtree holds more than 400 nodes; links, placeholders and controls inside one are `contenteditable="false"`), so a key pressed right after a click is never lost. The frame is `inert` from setting its content until the page has read each part's shape and text (a few hundred ms at the limits); the page compares the part under the caret on every tick, the others in turn (500 nodes a tick) and all of them at `flush()`, each against the text it last knew (so typing the view has not seen yet is still a change). An element too big to be a part gets `contenteditable` at the click, as before (a key in the 50 ms after that click is lost there). Every call on a frame node goes through getters and methods of the page's own realm (R4).

```ts
<HtmlViewer copy={Uint8Array | string} texts={number[]} stats={RenderStats} plain={null | 'reparse' | 'nul' | 'lone_surrogate' | 'style_end' | 'crash'}
  version={string /* the file's sha256 */} editable={number[] /* source text-node ids */} ident={Int32Array /* 6 per editable id */} mode={'edit' | 'comment' | 'pin'}
  marks={HtmlMark[]} readOnly={boolean} onHost={(h: HtmlHost | null) => void} onPlain={(reason: 'crash' | null) => void} />

interface HtmlLocation { nodeId: number; start?: number; end?: number }   // PHASE-1A page anchor location
interface HtmlAnchor { location: HtmlLocation; quote: string; prefix: string; suffix: string; hitKind?: 'element' }
interface HtmlMark { id: string; n: number; status?: string; kind: 'text' | 'element' | 'pin'; location: HtmlLocation; pin?: { xFrac: number; yFrac: number } }
interface HtmlEdit { nodeId: number; versionSha: string; baseTextHash: string; newText: string }
```

- `copy` is set as `srcdoc` once per `version` (and once more for the plain copy). Do not key the component by version: the pending edits and the hidden elements carry over to the next version inside it, and `onHost` is called again with a new handle when each version has loaded.
- `editable`: ids (in the reading's `nodes`) of the source text nodes the person may type in, as the view route sends them (src/html.js editableTextIds: a text node with `__ok === true` (R8), in normal or RCDATA context, not inside `a`, `button`, `select`, `option`, `optgroup`, `textarea`, `datalist`, `output`, `title` or `head`). An Array or an Int32Array. The page refuses a link's text, a control's label and a placeholder on its own as well.
- `ident`: the identity of each `editable` node, six int32 in the same order (src/html.js editIdentities): a 64-bit key of its neighbors (the parent's tag, its index among the parent's text nodes, and the text hashes of the shown non-blank text nodes just before and after it), a 64-bit key of its parent's unique `id` (0 0 when none), its twin count (text nodes with exactly its text) and how many of those are under that parent (0 when none). A pending edit is re-placed only on the one node with its base text and either the same neighbors with that text unique in the page, or the same parent id with that text unique under it, before and after. Without it (or with the wrong length) pending edits are never re-placed on a new version: they are all listed as lost.
- `plain`: the copy is the plain copy (src/html-render.js plainCopy) and the notice says why. Typing is off in the plain view; comments work.
- Crash flag (R6): set in `localStorage` (key `onionskin.html.crash`, through lib.js `store`) for `version` before `srcdoc` is set, cleared two frames after load (or one second after, where frames do not run). Found set at start: no content is set, `onPlain('crash')` is called (the host fetches the plain copy and renders again with `plain: 'crash'`); that view has a "Try the full view again" button, which clears the flag and calls `onPlain(null)` (the host renders the render copy again). Without `onPlain`, a full-pane message with the same button.
- Text check: after load the frame's text slots (a run of adjacent Text nodes is one) must number `texts.length`. If not, selecting and typing are off for that version, with one notice; element clicks still anchor (they use `data-osk-id`).
- `stats.bodyText === 0` (and not plain): the full-pane R16 message, nothing is loaded.

```ts
interface HtmlHost {
  readonly format: 'html'
  readonly version: string
  readonly readOnly: boolean; setReadOnly(b: boolean, reason?: 'run' | 'tab' | 'sending'): void   // read only while any reason is set; each its own sentence
  readonly mode: 'edit' | 'comment' | 'pin'; setMode(m): void
  selection(): (HtmlAnchor & { format: 'html'; kind: 'text'; collapsed: false }) | null
  onSelectionChange(f: (s | null) => void): () => void              // told once the selection held still for one tick
  hitTest(clientX, clientY): (HtmlAnchor & { format: 'html'; kind: 'element'; rect: DOMRect }) | null
  rectsFor(loc: HtmlLocation): DOMRect[]                              // page client coordinates, clipped by nothing
  scrollTo(loc, opts?: { flash?: boolean }): Promise<boolean>
  flash(loc): void
  getViewState(): HtmlViewState | null; setViewState(s): Promise<boolean>
  edits(): HtmlEdit[]; onEditsChange(f: (l: HtmlEdit[]) => void): () => void
  onEdit(f: (e: { format: 'html'; kind: 'text'; before: string; after: string; location: { nodeId } }) => void): () => void
  undoEdit(nodeId?: number): boolean; undoAllEdits(): void           // put the text back in the view too
  clearEdits(): void                                                  // after the server took them (Send or Save)
  lostEdits(): HtmlEdit[]; onEditsLost(f: (r: { placed; applied; lost }) => void): () => void
  dismissLost(): void                                                 // the person copied or let go of the lost edits (the list closes)
  flush(): Promise<void>                                              // compare every editable part now (in tasks); call it before taking edits()
  onPick(f: (p: { mode: 'comment' | 'pin'; anchor: HtmlAnchor; pin: { xFrac; yFrac } | null; rect: DOMRect | null; kind?: 'text' }) => void): () => void   // kind 'text': a text dragged in comment mode
  onBlocked(f: (b: { reason: 'newline' | 'structure' | 'not_editable'; anchor: HtmlAnchor; rect: DOMRect }) => void): () => void
  onViewChange(f: () => void): () => void                             // the frame scrolled or changed size
  onMarkClick(f: (id: string) => void): () => void
  hide(nodeId: number): boolean; showHidden(): void; hidden(): { nodeId; tag; hash }[]
  stats(): { ticks; tickMax; tickAvg; anchorMax; indexMs; srcdocMs; decodeMs; armMs; armDoneMs; hostMax; scanMax; reloads }   // diagnostics
}
interface HtmlViewState { format: 'html'; version: string; x: number; y: number; fraction: number; top: { nodeId; quote; offsetPx } | null; hidden: { nodeId; tag; hash }[] }
```

What differs from the engine's handle:
- No `saveBytes`: the browser never sends HTML bytes (3.1). The person's text edits are `edits()`, sent with Send and spliced by the server (R9). After a version change the component re-places each on the ONE node of the new version with its identity (`ident`), never by its numeric id: exactly one node with its base text and either its neighbors with that text unique in the page, or its parent's unique id with that text unique under that parent, before and after (twins are never told apart by content). A node there that already holds the new text is `applied`. None or several: it is not put anywhere, it is reported through `onEditsLost`, kept in `lostEdits()` and listed above the view with its text and a Copy button until the person dismisses it (`dismissLost()`; `clearEdits()` after a Send leaves the list alone). The server's write check refuses an edit whose node does not hash to its `baseTextHash`, on the version it names (`version_changed`).
- Offsets: in a selection inside one text node, `nodeId` is the SOURCE TEXT NODE and `start`/`end` count UTF-16 code units of its decoded text (what src/html-write.js textEdit takes). Across several text nodes, `nodeId` is their nearest located element and the offsets count the joined text of its source text nodes (text the copy added, such as a placeholder's label, is left out). The server converts both ways exactly (src/html.js hintOf and pageLocation, test/html-anchors.test.js): htmlDurable turns them into its whitespace-folded offsets, and a resolved anchor carries `page: {nodeId, start, end}` in these offsets, which the host draws. Whitespace at the ends of a selection is not kept (the stored quote is trimmed, as in the other formats).
- Version: a page anchor names a node of ONE version. The host stamps every anchor it makes with `location.version` (the view's sha256); the server makes an anchor durable on its own version and moves it onto later bytes (src/session.js #htmlAnchorWork), and the host draws a draft at its own location only while the view shows that version.
- `hitTest` and `onPick` give an element anchor with `hitKind: 'element'` and the element's text as `quote` (at most 500 characters; htmlDurable ignores the quote of a hitKind anchor).
- Comment and pin clicks do not reach the host as DOM events: they come through `onPick`. A blocked action (Enter, a multi-line paste, deleting an element, typing where the text is read-only) puts the element back as it was and calls `onBlocked` with its element anchor, so the host opens the comment box there (R17). Every changed text of one action is checked before any is recorded: when one part of it is refused (a deletion that also reaches a link), nothing of it is kept. Emptying a text is an edit like any other (`newText: ""`). Typing while read only or in Comment or Pin mode is put back with its sentence. A part changed in a way the view cannot put back from what it holds (its structure changed before the view first looked at it) makes the view set the same version again, pending edits kept, and calls `onBlocked`.
- Marks for comments and pins are drawn by the component from the `marks` prop with the app's own `Overlay`. `rectsFor` is there for the host's chip and outlines; call it again on `onViewChange`, since scrolls inside the frame raise no event in the page.
- `baseTextHash` is `editHash` of src/edit-hash.js (web/src/html-view.js re-exports it): cyrb53 over the exact text, 14 hex digits; the server's write check compares it with the node's text (test vectors in test/html-view.test.js).
- Keys pressed while the focus is in the frame do not reach the page (no listener in the frame, R14). In Comment and Pin modes the page keeps the focus on its own layer over the frame (a click there takes it; the poll moves it back from the frame), so every app shortcut works there, Cmd/Ctrl+Enter (Send) included. In Edit mode the frame must have the focus to take typing, so no app shortcut works while the caret is in the page (Cmd/Ctrl+Shift+K, Cmd/Ctrl+Alt+M, Cmd/Ctrl+\\, F6, ?, Esc, Cmd/Ctrl+Enter, Cmd/Ctrl+Option+Up/Down); the toolbar's mode buttons, the selection chip's Comment and Ask buttons, the panel button and Send cover them.
