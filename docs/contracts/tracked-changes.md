# Contract: tracked-changes copy markup (DOCX, M4 Idea 16)

Status: frozen for the v1 build, from the Step 0 spike on 2026-11-11 (two runs: LibreOffice only, then Word). Built in `src/redline.js` (the copy), `src/redline-check.js` (the round trip in code) and `scripts/checker/check.py --redline` (the second resolver); section 9 lists where each rule lives. The builder's own output has passed Accept All and Reject All in LibreOffice only; the owner's Word gate on it is pending (section 8). Every rule carries one label:

- **verified in Word**: Microsoft Word 16.114.1 (macOS) opened the file and gave the expected result. "Accept" and "Reject" mean `accept all revisions` / `reject all revisions` through Word's AppleScript object model, then `save as` DOCX.
- **failed in Word**: Word opened the file but the result differed; what differed is stated.
- **verified in LibreOffice only**: LibreOffice 26.8.2.2 (headless, private profile) did so, and Word was not asked.
- **not verified**: read from a file or a spec, or assumed.

## 1. Read first: limits of this evidence

- Word was driven only through its AppleScript object model, never by keystrokes or clicks, and its window was never brought to the front. Edits were `set content of <range>`, `insert text .. at <range>` and `set style of paragraph`. Typing in Word may record differently: for example, Word put `w:ins` before `w:del` when a range's content was set.
- The first run failed: Word's sandbox showed "Grant File Access" for a file in a temp folder. The second run put every file Word opened or saved under Word's own container (`~/Library/Containers/com.microsoft.Word/Data/Documents/onionskin-spike/`, deleted afterwards). No dialog appeared; each check read the window list and saw only the document's own window.
- "Displays the revisions" means the object model listed them (`revisions of text object`) with the right author, text and date. Nobody looked at the Review pane on screen.
- Every input document was in Compatibility Mode, because the generator writes no `w:compat` settings. Word's own reference files were saved in that mode too.
- So that the owner's account name would not be stored, every Word save had `remove personal information` set on the document. Word therefore wrote `w:author="Author"` in its own references, empty `cp:lastModifiedBy` and `Company`, no `word/people.xml`, and `<w:removePersonalInformation/>` in `settings.xml`. Without that setting Word writes the account name; that output was not inspected.

## 2. Evidence

| Source | What it is | Where |
|---|---|---|
| Word references | `base.docx` edited by Word with Track Changes on, saved by Word. Seven files: replace-word, insert-mid (break typed at the end of the previous paragraph), insert-mid-own (paragraph typed at the start of the next one), delete-mid, cell-edit, insert-end, replace-bold | `test/fixtures/word-tracked/*.docx` |
| Word 2007 file | `delins.docx` (Apache POI, AppVersion 12.0000), 82 revisions, whole paragraphs added and removed | `test/fixtures/cache/delins.docx` (gitignored, `node scripts/fetch-fixtures.mjs`) |
| LibreOffice references | `base.docx` edited through the LibreOffice UNO harness with Record Changes on: replace-word, insert-mid, delete-mid, cell-edit, insert-end | `test/fixtures/lo-tracked/*.docx` (author "Unknown Author") |
| Hand-built files | `base.docx`, `after-<case>.docx`, `hand-<case>.docx` to the planned markup (six cases), plus the variants `insert-mid-prevmark`, `insert-end-prevmark`, `replace-word-idclash` | `node scripts/tracked-spike/make-fixtures.mjs <dir>` (deterministic) |
| LibreOffice harness | Accept All, Reject All and record mode, via UNO | `scripts/tracked-spike/lo-accept-reject.py` (usage in its header) |
| Comparison | Accept output vs `after-<case>`, Reject output vs `base`. Compares paragraph text, body path, style name, a per-paragraph bold summary and the text of every bold run outside `w:del`, and counts the revision elements left | `node scripts/tracked-spike/compare.mjs <results> <gen>` |

The base document has these parts:

- A Heading 1 with a bookmark (`w:id="1"`).
- Three body paragraphs: Normal, Note, then Normal with one bold word ("own").
- A 2 by 2 table.
- A last paragraph in the style Signoff.

Note is indented, italic and blue; Signoff is right-aligned caps. So a paragraph that takes a neighbor's properties on Accept or Reject shows up as a style difference.

The first draft named the last style "Closing". Word has a built-in "Closing", renamed ours to "Closing1" on open, and applied its own style when asked for "Closing". All results here use "Signoff".

## 3. Markup Word wrote (`test/fixtures/word-tracked/`)

rsid and `w14:paraId`/`w14:textId` attributes are left out of the quotes below. Each revision element carries:

`w:id="N" w:author="Author" w:date="2026-11-11T22:36:00Z" w16du:dateUtc="2026-11-12T06:36:00Z"`

- **Dates.** `w:date` is the Mac's LOCAL wall-clock time (22:36 PST) written with a `Z`. The true UTC goes in `w16du:dateUtc` (namespace `http://schemas.microsoft.com/office/word/2023/wordml/word16du`, listed in `mc:Ignorable`). Seconds are always `00`.
- **Ids.** One numbering for bookmarks and revisions. Word renumbered the bookmark from 1 to 0, then gave revisions 1, 2, 3 in document order. Paragraph-mark revisions and `w:pPrChange` take ids from the same sequence.
- **replace-word.** `..on </w:t></w:r><w:ins w:id="1"><w:r><w:t>Tuesday</w:t></w:r></w:ins><w:del w:id="2"><w:r w:rsidDel=".."><w:delText>Monday</w:delText></w:r></w:del><w:r><w:t>.</w:t></w:r>`. The inserted run comes before the deleted run.
- **replace-bold.** As above, and both runs carry the bold: `<w:ins><w:r><w:rPr><w:b/></w:rPr><w:t>assigned</w:t></w:r></w:ins><w:del><w:r><w:rPr><w:b/></w:rPr><w:delText>own</w:delText></w:r></w:del>`.
- **cell-edit.** The same run revisions inside the cell's paragraph. No `cellIns`/`cellDel`, no `trPr` revision.
- **delete-mid.** `<w:p w:rsidDel=".."><w:pPr><w:pStyle w:val="Note"/><w:rPr><w:del w:id="1"/></w:rPr></w:pPr><w:del w:id="2"><w:r w:rsidDel=".."><w:delText>Budget figures are due next week.</w:delText></w:r></w:del></w:p>`. The paragraph's own mark is deleted, and the mark's `w:del` comes before the runs' `w:del` in id order.
- **insert-mid-own** (the new paragraph's text plus a break typed at the start of the next paragraph): the new paragraph's own mark is inserted, `<w:pPr><w:pStyle w:val="Signoff"/><w:rPr><w:ins w:id="1"/></w:rPr><w:pPrChange w:id="2"><w:pPr><w:pStyle w:val="Note"/></w:pPr></w:pPrChange></w:pPr><w:ins w:id="3"><w:r>..</w:r></w:ins>`. The `pPrChange` is there because the style was set after typing: the new paragraph had first taken the next paragraph's style, Note.
- **insert-mid** (a break typed at the end of the previous paragraph, then the text): the PREVIOUS paragraph's mark is inserted (`<w:p><w:pPr><w:rPr><w:ins w:id="1"/></w:rPr></w:pPr>..Monday.</w:p>`). The new paragraph's mark is not, and it carries `<w:pPrChange w:id="2"><w:pPr/></w:pPrChange>` with the style it had before, Normal.
- **insert-end** (a break typed at the end of the last paragraph): the same form as insert-mid. The old last paragraph (Signoff) has the inserted mark, and the new last paragraph has `pPrChange` back to Signoff.
- **Word 2007** (`delins.docx`): the same deleted-paragraph form. It also has 13 inserted paragraphs in a row, each with its own mark inserted, followed by an unmarked paragraph. Dates have `00` seconds and no `w16du:dateUtc`.

LibreOffice recorded the same shapes for replace, delete and the two "break at the end of the previous paragraph" inserts, with no `pPrChange`. It did not record the style change on the new paragraph.

## 4. The frozen markup

Each revision element gets `w:id`, `w:author` and `w:date`, in that order.

| # | Rule | Status |
|---|---|---|
| M1 | `w:author` is the constant "Onionskin agent" or "Onionskin". Word lists that author for every revision. | verified in Word |
| M2 | `w:date` is the server's LOCAL wall-clock time with a `Z` (`2026-11-11T01:05:00Z` for 09:05 UTC on a PST Mac), which is Word's own convention. Word reads `w:date` as local time and ignores the offset. A hand-built file with `09:05:00Z` showed as 9:05 AM in Word; adding `w16du:dateUtc` did not change what Word reported. LibreOffice writes the value without the `Z` into ODT. Writing `w16du:dateUtc` too is optional. How Word shows it in the Review pane, or on a Mac in another time zone, was not checked. | verified in Word (as read through the object model) |
| M3 | `w:id` starts at 1 + the largest numeric `w:id` in any part, and increases by 1 per revision element, marks included. A file whose first revision reused the bookmark's `w:id` 1 (`hand-replace-word-idclash`) still listed 2 revisions and passed Accept and Reject, and Word renumbers ids on save. So a clash is tolerated, but the rule stays. | verified in Word |
| M4 | Inserted text: `<w:ins ..><w:r><w:rPr>AFTER rPr</w:rPr><w:t>..</w:t></w:r></w:ins>`, with `xml:space="preserve"` when the text starts or ends with white space. With `<w:rPr><w:b/></w:rPr>`, the bold survives Accept (`hand-replace-bold`). | verified in Word |
| M5 | Deleted text: `<w:del ..><w:r><w:rPr>BEFORE rPr</w:rPr><w:delText>..</w:delText></w:r></w:del>`. A deleted bold word comes back bold on Reject. | verified in Word |
| M6 | At a changed place, `w:del` comes before `w:ins`. Word itself wrote the other order, and both work in Word and LibreOffice. | verified in Word |
| M7 | Added paragraph mid-body: the new paragraph's own mark is inserted (`<w:pPr>..<w:rPr><w:ins ../></w:rPr></w:pPr>`, the empty `w:ins` first in `w:rPr`), every run is in `w:ins`, and the paragraph has its AFTER style with no `pPrChange`. Accept gives AFTER; Reject removes the paragraph and leaves the next paragraph's style (Note) as it was. | verified in Word |
| M8 | Removed paragraph mid-body: rebuilt from BEFORE, own mark deleted (`<w:rPr><w:del ../></w:rPr>` first in `w:rPr`), every run in `w:del` with `w:delText`, placed before the AFTER match of the next matched BEFORE paragraph. Accept leaves the next paragraph's style; Reject restores the Note paragraph. Word wrote the same form. | verified in Word |
| M9 | No `rsid*` attributes on new or rebuilt elements. No hand-built file has any; Word opened all of them without a repair prompt or any other window, and the M1 to M8 checks passed. | verified in Word |
| M10 | Paragraph added after the last body paragraph with its own mark inserted (M7 at the end). Accept leaves one revision, the inserted mark on the new last paragraph. Reject leaves an empty Note paragraph at the end, still carrying that inserted mark. | failed in Word (and in LibreOffice: Reject leaves the empty paragraph) |
| M11 | The "prevmark" form without `pPrChange`: the previous paragraph's mark is inserted and the new paragraph's mark is not. Accept is right. On Reject the merged paragraph takes the NEW paragraph's style: Signoff instead of Normal (`insert-mid-prevmark`), Note instead of Signoff (`insert-end-prevmark`). Word's own files avoid this with a `pPrChange` on the new paragraph. LibreOffice passed both. | failed in Word |
| M12 | `parseDocxParagraphs` lists a paragraph whose mark is deleted as its own paragraph with empty text. The checker's `acceptOurs` must merge it into the next paragraph before comparing with AFTER. | verified by running `readDocxParagraphs` |
| M13 | No `w:pPrChange`, `w:rPrChange`, `moveFrom`/`moveTo` or cell revisions are written, as in the spec. | design rule (Word's own insert files use `pPrChange`; ours pass without it, see M7) |

## 5. Results per file

Word ran on every hand-built file and, as a control, on its own references. LibreOffice ran on the same hand-built files. "Left" counts the revision elements still in the saved file.

| File | Word Accept | Word Reject | LibreOffice Accept | LibreOffice Reject |
|---|---|---|---|---|
| hand-replace-word | pass | pass | pass | pass |
| hand-replace-bold (rPr carry-over) | pass | pass | pass | pass |
| hand-replace-word-idclash | pass | pass | pass | pass |
| hand-cell-edit | pass | pass | pass | pass |
| hand-insert-mid (M7) | pass | pass | pass | pass |
| hand-delete-mid (M8) | pass | pass | pass | pass |
| hand-insert-end (M10) | **fail**: 1 left (inserted mark on the last paragraph) | **fail**: empty `[6] Note ""` paragraph with its inserted mark left | pass | **fail**: empty `[6] Note ""` left |
| hand-insert-mid-prevmark (M11) | pass | **fail**: `[1]` is Signoff, want Normal | pass | pass |
| hand-insert-end-prevmark (M11) | pass | **fail**: `[5]` is Note, want Signoff | pass | pass |

Word on its own references, as a control:

- Pass on Accept and Reject for replace-word, replace-bold, cell-edit, delete-mid, insert-mid and insert-mid-own.
- insert-end Accept: pass.
- insert-end Reject: **fail**, on Word's own markup. One `pPrChange` was left, and the old last paragraph stayed Note, not Signoff.

LibreOffice opened every hand-built file. The ODT export marks each change as a `text:changed-region`, with `dc:creator` "Onionskin agent" on every one, and the PDF export was valid for every file. Deleted text sits inside its region. Inserted text sits in the body between `text:change-start` and `text:change-end`.

## 6. Parts that change on an agent edit (tolerated-part list)

Measured with the repo's own apply path, `runOps` from `src/ops/run.js` (state dir and `ONIONSKIN_NO_SOFFICE=1` pointed at a temp dir). Each call compared the decompressed bytes of every zip entry, plus added and removed entries. Two sets were run:

- `test/fixtures/engine/sample.docx`, one op per call: `replace_text`, `insert_paragraph_before`, `insert_paragraph_after` with `style: "Heading 2"`, `format_text` (bold and a new color), `set_paragraph_style` ("Heading 2"), `delete_paragraph`, `set_table_cell_text` and `replace_all_text`. Then the first seven together in one call.
- POI `60316.docx`, `52449.docx`, the spike's `base.docx` (first-run version) and `sample.docx`, with `replace_text`, `insert_paragraph_after` and `delete_paragraph`.

Results:

- In all 21 runs (9 calls on `sample.docx` in the first set, 12 in the second set of 4 files by 3 ops), only `word/document.xml` changed, and no part was added or removed. `styles.xml`, `numbering.xml`, `settings.xml`, `[Content_Types].xml` and `docProps/*` kept the same decompressed bytes.
- Entry order was checked only in the 9 `sample.docx` runs of the first set: unchanged.
- Recompression was checked only in the 12 runs of the second set, by compression method and compressed size (not compressed bytes): no unchanged entry differed.

**Tolerated list for v1: empty. Any part other than `word/document.xml` that differs refuses the export.** This is tighter than the spec expected (`docProps/*`, `[Content_Types].xml`, `styles.xml`, `numbering.xml`). These were op runs on fixtures, not real agent sessions. An op that adds a style missing from `styles.xml` was not measured. Widen the list only when a real run shows another part changing.

## 7. Verdicts

- **replace-word (in-paragraph edit): ship in v1.** Passes Accept and Reject in Word and LibreOffice. Run formatting carries over both ways (replace-bold).
- **cell-edit: ship in v1.** Same in-paragraph markup inside a cell; passes in Word and LibreOffice.
- **insert-mid (whole paragraph added mid-body): ship in v1, with M7 only** (the new paragraph's own mark inserted). It passes in Word, and Word writes this form itself. The prevmark form (M11) fails Reject in Word and must not be used.
- **delete-mid (whole paragraph removed mid-body): ship in v1, with M8.** Passes in Word; Word writes this form itself.
- **insert-end: cut from v1, as 3(b) already refuses it.** The M7 form fails in Word on both Accept and Reject. The prevmark form fails Reject in Word. Even Word's own insert-end file leaves a revision and the wrong style after Reject All. Supporting it would need `pPrChange`, which v1 leaves out.

## 8. Re-running, and the owner's Word gate on the builder

1. Run `node scripts/tracked-spike/make-fixtures.mjs <dir>` for the hand-built files, or `node scripts/tracked-spike/make-outputs.mjs <dir>` for the builder's own copies (`out-<case>.docx` for the five spike cases, plus four forms the spike did not cover: `move-para`, `rewrite-para` (an added paragraph right before a removed one), `insert-two` and `delete-two`; it also writes the plain files). For Word, `<dir>` must be inside Word's container (`~/Library/Containers/com.microsoft.Word/Data/Documents/<folder>`), or Word asks for file access.
2. For each `hand-<case>.docx` or `out-<case>.docx`, run Accept All and save as `accept-<case>.docx`, then reopen the copy, run Reject All and save as `reject-<case>.docx`, in Word or with the LibreOffice harness.
3. Run `node scripts/tracked-spike/compare.mjs <results> <dir>`. It exits 1 on any FAIL; for the hand-built files, hand-insert-end and the two prevmark files fail in Word.

Builder outputs, 2026-11-11: all nine passed Accept All and Reject All in LibreOffice 26.8.2.2 through the harness (18 of 18 PASS, 0 revisions left): verified in LibreOffice only. **Word: done, all 18 pass; see section 10.**

## 9. Where the rules live

| Rule | Code |
|---|---|
| M1 author, M2 date (`wordDate`), M3 ids (1 + the largest `w:id` of any part in either version) | `src/redline.js` |
| M4 to M8 markup; M9 no rsid on written elements; M13 nothing else written | `src/redline.js` (`modifiedXml`, `addedXml`, `removedXml`) |
| M10 refused: an add or remove whose next sibling is `w:sectPr` or nothing (`at_end`), or not a paragraph (`next_to_table`) | `src/redline.js` (`gate`) |
| M11 never written: the new paragraph's own mark is the one inserted | `src/redline.js`; the checker fails the prevmark form |
| M12 a deleted-mark paragraph is merged away before comparing | `src/redline-check.js`, `check.py --redline` |
| Section 6, empty tolerated list: any other part that differs refuses (`notes_part` for headers, footers, notes and comments, `other_part` otherwise) | `src/redline.js`, again in `verifyTracked` |
| Order and attributes Word needs but the round trip cannot see (`xml:space` on edge spaces, `w:pPr` first, the mark first in its `w:rPr`, id, author, date in that order) | `src/redline-check.js` (`checkShape`) |

## 10. Word gate on the builder's output (2026-11-11)

Microsoft Word 16.114.1 (build 16.114.26102031), macOS, run by Claude through the AppleScript object model. The owner was away. Word was never brought to the front and got no keystrokes. No dialog appeared, so none was clicked: every check listed only the document's own window.

Setup:

- `node scripts/tracked-spike/make-outputs.mjs` wrote the nine copies into a folder inside Word's container, which was deleted afterwards.
- The builder reported 9 of 9 written, each passing `verifyTracked`.
- Every copy had `w:date="2026-11-11T23:48:00Z"`, the Mac's local time (PST).

For each `out-<case>.docx`, Word ran three steps:

1. Open the file and list its revisions (type, author, date, text) with `get revisions of text object`, before any accept. Word opened all nine without a repair prompt.
2. `accept all revisions`, then save as `accept-<case>.docx`.
3. Open the original output again, `reject all revisions`, then save as `reject-<case>.docx`.

Then `compare.mjs` compared each Accept result with `after-<case>.docx` and each Reject result with `base.docx`. A negative control, with Reject results renamed as Accept results, failed 9 of 9, so the comparison is not vacuous.

| Case | Form | Revisions Word listed (author "Onionskin agent", date 11:48 PM local, every one) | Accept vs after | Reject vs before |
|---|---|---|---|---|
| replace-word | M4 to M6 | delete "Monday", insert "Tuesday" | pass | pass |
| replace-bold | M4, M5 with bold | delete "own", insert "assigned" | pass (bold kept) | pass (bold kept) |
| cell-edit | M4 to M6 in a cell | delete "Open", insert "Closed" | pass | pass |
| insert-mid | M7 | 1 insert (the new paragraph) | pass | pass |
| delete-mid | M8 | 1 delete (the Note paragraph) | pass | pass |
| move-para | M8 at the old place, M7 at the new | delete and insert, both "The team will review the draft on Monday." | pass | pass |
| rewrite-para | M7 right before M8 | insert "Quarterly costs go to finance by Friday noon.", then delete "Budget figures are due next week." | pass | pass |
| insert-two | M7 twice in a row | 1 insert covering both paragraphs | pass | pass |
| delete-two | M8 twice in a row | 1 delete covering both paragraphs | pass | pass |

Every saved result had 0 revision elements left.

Word lists adjacent revisions of the same type and author as one: two paragraphs added in a row show as one insert, and two removed as one delete. That is how Word presents them, not a loss: Accept and Reject still gave the exact before and after. Someone accepting or rejecting one at a time in the Review pane gets the pair together.

Status of the forms, from this gate:

- **verified in Word:** M1 (author), M2 (local `w:date`: Word showed 11:48 PM, and the Mac's clock read 23:49 PST), M4, M5, M6, M7, M8 and M9 (no rsid; opened without a repair prompt).
- **verified in Word, new here:** a moved paragraph as a remove plus an add; a rewritten paragraph as an add right before a remove; two adds in a row; two removes in a row.
- **Not covered by this gate:** M3 ids (no other `w:id` in these files besides the bookmark, which the builder stepped over), the Review pane on screen, files not in Compatibility Mode, and a Mac in another time zone.

