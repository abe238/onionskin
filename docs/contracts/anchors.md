# Contract: durable anchors (DOCX, XLSX, PPTX)

Source: `src/docx.js` (DOCX), `src/xlsx.js`, `src/pptx.js`, glued by `src/anchors.js`. Engine paragraph ids are per-parse counters and are never stored. Everything the agent sees, and everything kept across a reload, is derived by the server by parsing `word/document.xml` of the bytes it holds (the bytes written at Send, or the bytes on disk after `done`). The server does not depend on the engine for this: `src/xml.js` is a small streaming tokenizer (no DTDs, depth limit 256, prefix-based names `w:` `w14:` `m:` as written by Word, python-docx and the engine).

## Paragraph listing

`parseDocxParagraphs(xml)` lists every `w:p` in document order (flat `ordinal`, starting at 0):

| field | meaning |
|---|---|
| `path` | body ordinal path. `[i]` for a body-level paragraph (`i` counts body-level `w:p` and `w:tbl`; `w:sdt` content is flattened into the same sequence). `[i,row,col,k]` for a paragraph directly in a table cell (`k` = index of the paragraph in the cell). `null` for nested tables. |
| `paraId` | `w14:paraId` (8 hex, upper-cased) or `null` (python-docx and the engine do not write one yet) |
| `text` | concatenated `w:t`, `w:tab` -> `\t`, `w:br` -> `\n`, `w:drawing` / `w:pict` -> U+FFFC (one char, like the engine); text inside `w:del` excluded |
| `hash` | sha256 (first 16 hex) of the NFC, whitespace-collapsed text |

## Durable anchor

```json
{ "format": "docx", "paraId": "0ABC1234|null", "path": [146], "ordinal": 146,
  "textHash": "62bdc1889c113bff", "prevHash": "...", "nextHash": "...",
  "paraText": "<normalized paragraph text, up to 2000 chars; server side only>",
  "quote": "reviews proposal", "prefix": "<=40 chars", "suffix": "<=40 chars",
  "start": 21, "end": 37, "engineDelta": 0 }
```

- Built at Send by `durableFromEngine(paragraphs, engineLocation, {quote, prefix, suffix, paraText})` from the WRITTEN bytes. The browser sends its engine location (`blockPath`, `paraId`, `start`, `end`) plus what it saw (selection quote/prefix/suffix, or the paragraph text for element and pin anchors).
- `engineDelta` = engine `blockPath[0]` minus our body ordinal at capture time (section breaks and similar make the engine's `Block[]` index differ). The browser adds it back after a reload, then verifies the block by its rendered text and looks a few blocks around if it does not match.
- `paraText`, `prevHash`, `nextHash` never go to the agent. The batch gets `quote`, `prefix`, `suffix`, `locator {para_id, body_path, text_hash, start, end}` (all sanitized, see batch.schema.json). For element and pin anchors the batch `quote` is the paragraph text (capped at 500 chars).
- Element and pin anchors have `quote: ""` and rely on `paraText`.

## Re-resolution (`resolveDurable`)

Tried in order against the new paragraph list; the first step that yields a candidate wins and its name is reported as `method`:

1. `id`: exactly one paragraph with the same `w14:paraId`.
2. `hash`: paragraphs with the same text hash; among duplicates prefer the one whose neighbors are unchanged, then the nearest path. Text that shared its hash with another paragraph when the anchor was captured (`dupCount` > 1; for older anchors, normalized text under 20 characters) is only accepted when a hit has an agreeing neighbor; otherwise the step is skipped, the same paragraphs are excluded from the fuzzy step, and the anchor ends as `none` ("moved or removed") unless the neighbor slot or the quote decides.
   A selected quote that occurs more than once in its paragraph keeps its occurrence: the engine's `start`/`end` when they hold the quote, else the occurrence whose surroundings match `prefix`/`suffix`; `nth` stores which one and resolving looks for the same `nth`, guarded by prefix and suffix.
   `protected` comes from the engine's own classifier (`protectReasons` in `scripts/engine-node/entry.ts`), never from a second list.
3. `neighbors`: the paragraph whose previous and next paragraphs both still have the remembered hashes (an in-place edit), if it is the only one and still similar (Dice >= 0.3) or contains the quote.
4. `quote`: the exact normalized quote. If the quote occurs in several paragraphs and the prefix does not disambiguate, this step does not guess.
5. `fuzzy`: Dice similarity over character bigrams to `paraText` >= 0.6, neighbors count +0.1 each, and the best must beat the runner-up by >= 0.04 (templated text makes a deleted paragraph look like its siblings; the answer is then "none").
6. `none`: unresolved. The UI shows "moved or removed" and draws no highlight. Nothing is ever attached by bare position after a reload. (At Send time, with fresh bytes, a bare engine position is accepted as a last resort, method `path`.)

Result: `{method, ordinal, path, paraId, textHash, prevHash, nextHash, text, start, end, engineDelta}`; `start/end` are the offsets of the remembered quote inside the paragraph, or null.

## View anchor

At Send the browser also sends `getViewState()`. The server turns `{blockPath, quote}` of the top visible paragraph into a durable anchor and stores it with `offsetPx`, `zoom`, `fraction`. After a reload the page asks `POST /api/resolve`, builds `{format:'docx', blockPath:[path[0]+engineDelta], textHash: hashText(text), quote, offsetPx, zoom, fraction}` and calls `host.setViewState`.

## XLSX (`src/xlsx.js`)

Read from the written bytes by parsing `xl/workbook.xml` (sheets in order with `sheetId`, name and part, defined names), the sheet parts and the shared strings; no engine involved. Cell text is what the formula bar shows and what `apply` checks `expect` against: the formula with a leading `=` when the cell has one, else the stored value (numbers as JS prints them). A shared-formula child with no formula text of its own falls back to its cached value.

Durable anchor `{format:"xlsx", sheetId, sheetName, sheetIndex, range, cell, r0,c0,r1,c1, text, values, textHash, rangeHash, ctx, names}`:

- `range`: `B2`, `B2:D9`, whole rows `3:5`, columns `C:D`, or `""` (the sheet); the last three have `cell:false` and are position only.
- `text` / `rangeHash`: typed text of the range (cells joined by TAB, rows by LF; kept to what the batch can show: each cell cut at 1,000 characters, 4,000 in all) and the hash of the whole text (sha256, 16 hex, NFC, no whitespace folding: the hash `apply` computes for an XLSX `expect.text_hash`). `values`: the top-left 20 x 10 cells, each cut at 1,000 characters (the batch's `values`). `textHash`: hash of the top-left cell, the identity. Both hashes are made within the request's budget (src/text.js scanBudget, as resolving is); one it cannot pay for is null, and the anchor goes out without it (the batch's `locator.text_hash` is null and the comment's `reply_with` is `ops`). Such an anchor is resolved by its context, or by its address when it has none.
- `ctx` (server side): `rowHeader` (the leftmost non-empty cell left of the range), `colHeader` (the topmost non-empty cell of its column), `left/right/up/down` neighbor texts, `rowCells` (hashes of the row's other cells, at most 64).
- `names`: defined names that pointed at exactly this range.

Re-resolution (`resolveXlsx`), first hit wins, reported as `method`:

1. **sheet**: `sheetId` when it agrees with the name. Otherwise the name, then the id, and the better cell match decides: openpyxl renumbers `sheetId` by position, so an id alone can point at another sheet after a reorder. Neither found: the cell is looked for by text and context in every sheet and only a single clear winner counts.
2. `position`: the same address holds the same text and the row still matches (at least 60% of the remembered other cells are in the row, or its leftmost cell is unchanged).
3. `value`: the same text elsewhere in the sheet (a row or column was inserted or deleted). A single other cell counts only when its row or column header agree with the anchor's (or the anchor never had any), so an edited cell is not stolen by an unrelated cell that holds the old text; several equal values are separated by row match, column header and neighbors, and no clear winner means `none`.
4. `position` with `changed: true`: the text differs (the agent edited the cell) but the row and the column header still say it is the same cell.
5. `context` with `changed: true`: the text changed and the cell moved: the row is found by its other cells (or its leftmost cell), the column by its header; both must be unique.
6. `name`: a defined name that pointed at it. A name that moved is trusted (the writer updated it); one that still points at the old address is stale unless the cell checks out, because openpyxl does not shift names.
7. `none`: moved or removed. A deleted row, a deleted sheet and a row that no longer matches all end here; nothing is attached by bare position.

Result `{method, sheetId, sheetName, sheetIndex, range, changed, moved, text, r0,c0,r1,c1}`. Ranges resolve by their top-left cell and keep their size. Tables are not parsed: a table's header row serves as the column header context. A file past one of the readers' caps (docs/GUIDE.md, "Size limits": for example more than 1,000,000 cells in a workbook, 50,000 paragraphs in a Word document or 50,000 shapes in a deck) is refused with that reason when it is opened or sent; it is never read in part.

The view: the top-left cell and the selection are stored as cell anchors; after a reload `resolveView` returns `{sheetIndex, sheetName, topLeft, selection}` where the cells are the re-resolved ones (the same logical cell, one row down after a row was inserted above), falling back to the stored addresses.

## PPTX (`src/pptx.js`)

Read from `ppt/presentation.xml` (`p:sldIdLst`), its relationships and each slide part. Shape text is the paragraphs joined by LF (`a:br` is LF, field text is included), hashed like DOCX text (NFC, whitespace folded).

Durable anchor `{format:"pptx", slideId, slidePart, slideIndex, slideTitle, titleHash, shapeId, shapeName, ordinal, kind, text, textHash, quote, prefix, suffix, start, end, cell}`: `slideId` is the `p:sldId` id, stable across reorder, insert and delete (python-pptx renames slide parts, so `slidePart` is only a hint); `shapeId` is the `cNvPr` id with `shapeName` and `ordinal` among shapes with the same id; `kind` is slide, shape, image, table, group or line. `quote` is set for a text selection inside a shape and empty for whole-shape and pin anchors (which use `text`).

Re-resolution (`resolvePptx`):

1. slide: by `slideId`; else the slide part together with the same title; else the title alone when unique. None: `none`.
2. shape (when the anchor has one): `id` (exactly one shape with that id, or among duplicates the one with the same ordinal and name or text); else `name+text`; else `text` (unique); else `name` (unique, only when the anchor remembered text). A deleted shape is `none`.

Result `{method, slideId, slideIndex, shapeId, shapeName, start, end, changed, quoteLost, text}`; `changed` says the shape text differs, `quoteLost` that the quoted words are gone (the whole shape is then drawn). Pins: `{xFrac, yFrac}` are fractions of the slide, `sxFrac/syFrac` of the shape the pin was dropped on. A pin dropped on a shape keeps a slide-only fallback anchor, so deleting the shape leaves the pin on its slide (`tieLost`).

View: the slide id of the slide in view and the zoom; `resolveView` returns the slide's current index.

## HTML (`src/html.js`; `.html` and `.htm` files)

Read in a worker only (the parser, `vendor/parse5`, is loaded by `src/html-parser.js`, which only worker entries import). One parse with source locations and scripting on. Located nodes (elements, text, comments, the doctype; never an implied `html`, `head`, `body` or `tbody`) are numbered in source order; that number is a node's id for one version (`nodes[id]`), and the page names nodes by it. The visible text (`flat`) leaves out raw text (script, style, and the other raw-text elements, in any namespace for script and style) and template content, folds whitespace runs to one space and puts a space at block edges; each element has its range in it.

Page anchor `{location: {nodeId, start?, end?}, quote, prefix, suffix, cut?, hitKind?}`: `nodeId` is a located node (a text node anchors to its element; an implied element to its nearest located ancestor), `start`/`end` the quote in the element's visible text (a hint; the quote is searched for when it is not there).

Durable anchor `{format:"html", nodeId, path, tag, elementId, kind, textHash, text, quote, prefix, suffix, start, end, heading, flatAt, weak?}`: `path` is `["html:0", "body:0", "p:3", ...]` (tag and index among same-tag siblings, tag names that do not match `[a-z0-9-]{1,32}` replaced by `t-` and a hash); `elementId` the `id` attribute when it matches `[a-z0-9-]{1,32}` and is unique in the file; `textHash` the hash of the element's own text (its direct text children; an edit inside a nested element leaves it); `text` 2,000 characters of its visible text; `flatAt` where it starts in the visible text. A spent budget gives a weak anchor (`weak: true`, the path and the page's context, no hash).

Re-resolution (`resolveHtml`): the unique id; else the same path with the same own-text hash (weak: the same path and tag); else the quote (or the start of the element's text) searched near its old place in the visible text, then everywhere, the occurrence whose context matches best and then the nearest; all within the budget. Result `{method: id | path | quote | none, nodeId, path (/html[1]/body[1]/p[4]), tag, elementId, start, end, changed, quoteLost, text, heading}`.

Batch locator `{path, element_id, text_hash, start, end}` (docs/contracts/batch.schema.json). `reply_with` is `find_replace_or_text` for an element that holds text (the shorthand `find`/`replace` becomes `replace_text`, `text` becomes `set_text`: src/reply.js) and `ops` for an image or a container; `decline_or_ops` when the anchor was not resolved or is protected. An op target names the element by exactly one of `element_id` (when unique) or `path`; the outline's `target` is that one form, ready to copy.

## Markdown (`src/markdown.js`, `src/anchors.js`; `.md` and `.markdown` files)

The page reads the file's bytes (GET /api/file, with the id of the server's record of them in the `X-Revision` header) with the same pure reader as the server, so both agree on every offset. A page anchor is `{location: {from, to, version, rev}, quote, prefix, suffix, format: "markdown", hitKind?}`: the exact source range a selection in the preview stands for (`sourceRange`), or a whole block (a click in Comment or Pin mode, a caret, the explicit "Comment on the whole block"; then `hitKind`). `version` is the sha256 of the bytes the page showed and `rev` the opaque id of the server's record of them. Every Markdown page anchor also carries `evidence`: the sha256 (hex) of `identity + "\n" + from + "\n" + to + "\n" + source`, made when the selection, the caret's block or the whole-block offer is captured, where identity is the record id (`rev`) or the draft state id (`draftId`) it was made on and source the exact text of its range then. The source itself is never stored with the comment. The server gives a place only when that digest, recomputed over the anchor's own identity and range and the text at that range of the bytes it reads, matches: at a fresh Send, a draft-made comment's Send, a queued comment's delivery and every resolve; otherwise the comment keeps its words and has no place. A range moved to another copy of the same words under the same identity therefore has no place. A draft-made comment, once its Send binds it, gets new evidence made by the server under the record that Send wrote. A whole-block offer is withdrawn when the preview's content changes under it, and a click on a stale offer anchors nothing; the selection chip's buttons (Comment, Ask) act on the selection the chip captured, and are withdrawn with the same sentence when the file record or draft id it was captured on is no longer the one on screen (the keyboard shortcut reads the live selection). Two comments with the same id in one request are refused (`duplicate_comment_id`) before anything is saved or sent. A selection across blocks is refused in the page with a sentence and never sent. One Send can hold the person's typed edit and comments made on the edited text. A comment made in the preview while a draft exists has `location: {from, to, draftSha, draftId}`: its exact range in the draft's text (the text the Send's splice writes, same offsets), the sha256 of the bytes that Send will write, and the random id of the draft state it was made on (the page gives every state of its draft a fresh id, on every change, undo included); never a record id (this is exactly what the page sends). The server binds it only in the Send that performs that write, in the same locked step, when ALL hold: the comment is submitted for the first time (one that was ever sent, queued or delivered never gains a place later), the Send carries an edit whose splice declares that same draft id, `draftSha` is the sha256 of the bytes actually written, and the range passes the checks of any anchor on that text. It then becomes an anchor of the record that write makes, with its exact source. Stated limit: a page that fabricates every field of a selection (range, draftSha, draftId) cannot be told from a real one; the page is the person's own browser. Anything else (the draft changed after the comment was made, a Send without that edit, a parked draft, a forged value) leaves the comment without a place. A comment made on the file before the person typed has no place once the edit is written. Every range a batch gives is on the file as it is now.

Revision records (src/session.js). A record is {id, sha256, stamp}: the stamp is the file's device, inode, size and modification time in nanoseconds, and the parent folder's device and inode (not followed: a swapped folder or a folder symlink is another record) (`src/fsutil.js` `stampOf`; not ctime, which sync clients such as iCloud Drive move alone seconds after a save), read from the same descriptor as the bytes, before and after the read (`readStamped`). The server mints a new random id whenever it reads the file and finds other bytes or another stamp than the current record's; the page only ever holds the id. Records live in the server's memory: after a restart no old id is known, so everything made before it is unresolved or refused. Every anchor, batch, Send splice and history entry names the id of its record, and every Markdown write (the person's Send edit, an agent's write, Revert) checks, under the document lock, immediately before the bytes are replaced, that the file's sha256 AND its whole stamp equal the named record; any difference refuses. Onionskin's own write takes the new record from the staged file BEFORE it is published (after its last byte is written and flushed: its bytes read back and its stamp), publishes it by rename, then confirms that the same descriptor still shows exactly that stamp and that the path names that inode in the same folder. A write has one of three outcomes, told apart to the page, the CLI and the run: refused before the rename (nothing changed); published but its content not confirmed; published and confirmed but the folder flush failed (durability not confirmed). After either unconfirmed outcome no record is current (later work is refused), the page keeps the person's draft to copy, and no comment of that run is marked done. Strict on purpose: a touch or an identical re-save (same bytes, new modification time, or a new inode) costs a "select again"; a change of ctime alone (an extended attribute, chmod, a Finder tag, a sync client) does not. Stated limits: a program that rewrites the file in place within one timestamp tick and restores the same bytes (on HFS+, FAT, exFAT and some network shares the tick is long); one that restores identical bytes and sets the modification time back to the exact nanosecond on purpose (no ordinary editor or sync client does); and a save by another program between that check and the rename (the window every Onionskin writer has). A place is valid only on its exact record: the same sha256 as another record does NOT give the same range.

The durable anchor is `{format: "markdown", kind: "text" | "block", from, to, sha256, rev, label, quote}`, built only when the location names the record being read (sha256 and id) and both ends are on boundaries (`offsetAllowed`); otherwise none (unresolved). Re-resolution is identity on the exact revision; on any other revision the anchor is unresolved, nothing is moved by arithmetic and nothing searches for the quote. A batch is bound to the revision it was made on: delivery shows its blocks only on that revision, the write is refused on any other (`stale_base`), and a batch is written once. An unresolved, protected or too-long anchor is delivered with `reply_with: "decline"`, and only a decline (or a question) answers it. The quote is display evidence only. The batch's locator is `{format, from, to, sha256, source}`, `source` being the exact text of the range from the base version (absent past 100,000 characters: then `decline`). The run's changed places are the exact ranges its checked write replaced, in the after version; History places are leaf blocks of the after version, `{from, to}` (History: `{format, from, to, version}`), drawn only while the page shows that version.

## Pins

`pin = {xFrac, yPx, yFrac?, on, sxFrac?, syFrac?}`; `on` is `paragraph` (DOCX: `yPx` pixels into the paragraph), `cell` (XLSX: fractions of the cell), `shape` or `slide` (PPTX). The batch carries `pin: {x_fraction, y_offset, y_fraction?, on?}`. In the page the marker is drawn up and to the side of the point with a short leader and a dot at the exact spot, so a pin never covers the word it points at.

## What the agent gets (batch)

XLSX anchor: `unit` (cell, range, rows, columns, sheet), `label` `Sheet!D30`, `locator {sheet, sheet_id, range, text_hash}`, `quote` (typed text), `values` (rows of typed cell texts for a range, at most 20 x 10), `context {row_header, column_header, left, right, above, below}`. PPTX anchor: `unit`, `label` `Slide 4 "Title", shape "Name"`, `locator {slide_id, shape_id, text_hash, start, end}` (`shape_id` null for a slide-level anchor), `quote`, `prefix`, `suffix`. The locator names are the names the `apply` targets use, and an op target can be `{anchor_id}` alone (see ops.md). All of it is evidence: sanitized, capped at 500 characters. Locator fields are validated on top of that: `sheet` is sanitized and capped at 100 characters, `sheet_id` and `slide_id` must be digits (else null), `range` must be a cell, rectangle, rows or columns (else null, a whole-sheet anchor), `shape_id` an integer.

## Changed regions (`changedRegions` in `src/anchors.js`)

At `done` the server compares the pre-agent bytes with the new bytes and stores `activity[].changes = {items, truncated}` (at most 300). DOCX: a longest-common-subsequence over paragraph hashes; unmatched new paragraphs are `changed` (paired with an unmatched old one in the same gap) or `added`, each with the first 160 characters of its text. XLSX: per sheet (matched by name, else by id), an LCS over row signatures, then a cell diff inside paired rows; an empty inserted row has no cells and is not reported; rows that only moved are not. PPTX: slides matched by id, shapes by id and ordinal, compared by text hash. The page draws a region only when it is rendered; it labels it `changed` or `new` and only while the done highlight is fresh, and never for a reverted run (a revert puts the old bytes back). Ceiling: a LCS middle larger than 4 million cells falls back to a multiset comparison that can only say `added`.

## Not done

Images (rel id + part + ordinal) and tables by first-cell text in DOCX, nested-table paragraphs (`path: null`, found by hash or quote only), SDT-aware ordinals, writing `w14:paraId`, XLSX tables as an anchor relation (header context stands in), PPTX table cells beyond the `cell` hint, text-range rectangles inside a PPTX shape (the host returns the shape box, so the whole shape is outlined).
