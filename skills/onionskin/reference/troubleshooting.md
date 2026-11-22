# Troubleshooting

Run `onionskin status <file>` first; it never blocks and says what state the file is in. When a command fails for a reason you do not understand (command not found, the server will not start, checks skipped), run `onionskin doctor` and relay its `MISSING` and `NOTE` lines, each of which ends with the command that fixes it, to the user. Its output holds no tokens or document names.

## The server is not running

`status` prints `{"state":"no-server"}` and `done` says the server is not running. `open` and `poll` start it automatically. After a machine restart or an idle shutdown (the server stops itself after about two hours with no poller, no delivered batch and no browser connected), run `onionskin open <file>` again; the user's saved comments are kept in the state directory (`~/.onionskin/`) and come back. A `done` for a batch that was lost this way fails with "no batch is in progress"; tell the user and start over with `open`.

## "no batch is in progress" at done, or apply says it will not write

The batch is no longer yours (`stale_batch` is the same condition seen by `done`, `apply` or a write: the delivery you hold is not the current one): the user used Take back, your hold on it (the lease, 15 minutes unless renewed) expired, or `done` already ran. `status` shows the state. If it is `stranded`, run `onionskin poll <file>` to receive the pending batch again and redo the work against the file as it is now. During long work, run `onionskin poll <file> --ack` in the background or call `apply` now and then; both renew the lease.

## 409 stale_batch

The delivery you act on is not the current one: your lease expired and the batch went to another poll, the user took it back, or `done` already ran. Do not retry. Run `onionskin poll <file>` for the current batch.

## 400 missing_lease, or "pass --lease <ticket>"

`reply`, `apply`, `commit` and `done` need the ticket of your delivery (`--lease <batch id>:<token>`, printed in the commands of the batch) while a batch is delivered. If you lost it, run `onionskin status <file> --ticket`: it answers only the agent whose poll received the batch (the same `ONIONSKIN_HOLDER`, or the same shell and file). If that fails too, run `onionskin poll <file>` again to take a fresh delivery.

## `reply` printed `"ok":false`

Read `problems`: each entry names the `comment`, what failed and a `fix`. Nothing was written and the batch is not finished (`"lease_kept":true` when the ticket is still valid), so correct those replies and call `reply` again with the whole set. `code` `stale_batch` or `no_batch` means the delivery is gone (taken back, expired or finished): run `onionskin poll <file>` for the current batch. `done_failed` means the edit is in the file but the batch was not finished: run `onionskin done` with the `results` the output carries. Codes are listed in `reference/ops.md`.

## 403 not_lease_holder

Another agent holds the batch. Set the same holder name for `poll` and `apply` (`ONIONSKIN_HOLDER=name`, or `--holder name` on `apply`), or stop: do not fight another agent over a file.

## 409 conflict, `outside_change`: the file changed outside Onionskin

Someone (another program or person) saved the file after you read it. Nothing was written over it. `apply` and `commit` report `"status": "outside_change"` with `outside_change.copy_path`: your version, saved next to the original as `<name> (Onionskin copy YYYY-MM-DD HHMM).<ext>` with the original's permissions. Do not retry, do not write the original, do not look for another way in. Report it in `done` (summary and the notes of the affected comments say the file changed outside and name the copy), then stop and wait for the next batch. The user sees a banner and an activity entry and can open both files in Word to combine them. If the folder is not writable the report says `copy_error` and no copy exists; say so in your results.

If `done` itself flags `file_changed_outside_onionskin` (error) the file changed during your turn by a path other than apply or commit: nothing extra was copied, the earlier version is stored, and the user is offered Revert.

## 409 write_busy, 409 acl_not_preserved

`write_busy`: another writer held the advisory lock next to the document for more than five seconds; retry. `acl_not_preserved`: the file has an access control list that could not be carried over to the replacement, so the write was refused and the file left alone; tell the user.

## `commit` or `apply` refuses with a session message (exit 5)

With a ticket they write only while that batch is delivered; a closed session, a Take back or a server that does not know the session means the write is refused, never done "standalone". `--standalone` exists for a file with no review session at all and is refused while one exists.

## The user asks about "Deeper checks are off" or "Deeper check skipped"

The review panel says "Basic checks passed. Deeper checks are off." with a "Turn on deeper checks" button, and `done` prints `checks_notice` with `Deeper check skipped`. It means the optional extra check of the file (a second look at the document's structure after your edit) is not set up. The built-in checks always ran.

When the user asks what it means, or asks to turn it on, do it for them:

1. Say in one or two plain sentences what it is: an extra check that needs a one-time download of a few small libraries (about a minute, nothing from their documents is sent).
2. Run `onionskin setup-checker` yourself, in the foreground. It creates a private environment in the state directory and uses the network once. It prints `checker ready: <path>` on success, and the next `done` uses it with no restart. Do not tell the user to run it, and do not use the words Python, venv or pip with them unless they ask.
3. If it fails, tell them in plain words: no internet (connect and you will retry), or Python 3 is not installed on this Mac (offer to help install it, for example with the Command Line Tools or python.org). The built-in checks keep working either way. `ONIONSKIN_PYTHON` can point at a Python that already has lxml, defusedxml, python-docx, openpyxl and python-pptx instead.

LibreOffice (a conversion check) is a separate optional install; do not raise it unless the user asks.

## "macro-enabled files are refused"

`.docm`, `.xlsm` and `.pptm` are refused by design; macros never run here. Ask the user for a macro-free copy.

## Not a valid .docx / .xlsx / .pptx

The file is not a package of that type (wrong extension, truncated, or a different format saved under that name). Tell the user; do not try to repair it.

## An HTML page will not open

Tell the user the sentence Onionskin printed; do not convert or repair the file yourself.

- "Onionskin cannot open this kind of saved page; in Chrome choose Save As, Webpage, Complete." (`.mhtml`, `.mht`, `.webarchive`), "Onionskin cannot open .xhtml pages; save the page as .html and open that.", "Onionskin cannot open .svg pictures; it opens .html and .htm pages.": these kinds are refused by design.
- "This file is not saved as UTF-8; Onionskin can save a UTF-8 copy and open that." (a page that declares windows-1252, ISO-8859-1 or US-ASCII and whose accented bytes do not already read as UTF-8; `onionskin open` also prints the command `onionskin utf8-copy <file>`, which writes `<name>.utf8.html` next to the page, only if that name is free, and leaves the original unchanged: run it, then open the copy) and "This file is not saved as UTF-8, and Onionskin cannot tell how it is saved, so it cannot open it." (a page that declares another encoding, one that declares windows-1252 or its aliases while its accented bytes already read as UTF-8, where no copy is offered, or one that holds bytes that are not valid UTF-8): only UTF-8 pages open.
- "This file could not be opened: this page is 10.5 MB, more than the 10 MB Onionskin can read. Split it into smaller pages and open those." The same form names the other limits: 200,000 elements, 400,000 attributes, 8 million characters of text, 512 levels of nesting, 1 MB for one attribute value.

## HTML op codes

Each comes with `status: "refused"` and a `reason`. Nothing of the batch was written in atomic mode.

- `active_content`: the write would add or change code that runs in a browser (`reasons` names the kinds: `script`, `event_handler`, `frame`, `form`, `element`, `attribute`, `link_url`, `load_url`, `css`, `template`), or the target is a `script` or `style` element. Do not retry with another spelling of the same thing. Decline that comment and say in one plain line of the `summary` that Onionskin does not let an agent add code that runs in a browser.
- `spans_markup`: the `find` text, or the element's text, runs across an element's edge (a link, bold text). Use `replace_element` with the element's new markup.
- `not_addressable`: the element or text is not written as such in the source (the parser implied it, moved it, or the tag holds an attribute twice). Target its nearest written ancestor, usually with `replace_element`.
- `not_well_formed`: the markup does not read back the same in that place (an unclosed or misplaced tag, a NUL character). Fix the markup.
- `proof_failed`: after the change the page would also read differently somewhere else. Use a smaller change, or `replace_element` on the parent.
- `overlapping_edit`: two ops of the file change the same place. Give one op per place, or one `replace_element`.
- `charset_needs_head`: the page does not declare UTF-8 and has no place near its top to add the declaration. Write the characters as references (`&eacute;`) or decline.
- `too_large`, `not_utf8`: the page is past a limit or is not UTF-8. Decline and tell the user the reason.

## A Markdown file will not open, or a replacement is refused

- "This Markdown file is not saved as UTF-8, so Onionskin cannot read it. Save it as UTF-8 (in most editors: Save As, Encoding, UTF-8) and open it again.": only UTF-8 files open. Tell the user; do not convert the file yourself.
- "This Markdown file is 1,153,433 bytes, more than the 1,048,576 bytes (1 MB) Onionskin can read. Split it into smaller files and open those." (with the file's own size), and "This file could not be opened: this Markdown file has more than 20,000 lines, more than Onionskin can read. Split it into smaller files and open those." The same form names the other limit: 32 levels of nested quotes, lists or emphasis.
- `stale_base`, `old_text_differs`, `not_a_boundary`, `bad_range`, `overlap` (`reference/ops.md`, "Markdown ops"): nothing was written and the batch is still yours. Copy `from`, `to` and the old text again from the batch (never from a `quote`) and send the whole reply again; after `stale_base` (the file changed outside this batch) do not poll again: decline the comments it affects, say why in their notes and run done; the user sends again on the new version. `op_not_on_anchor`: an op inside a comment's reply names another range; put that change in the top-level `ops`. `protected`: the range touches the front matter, or the new text would end it (text added right after its closing `---` must start with a new line); start such an addition with a new line, or decline the comment.
- "A Markdown file is changed only by exact replacements (replace_source ops, through onionskin reply or apply): commit and other writes are not available for it.": by design. Use `reply` or `apply`.
- "Review first is not available for Markdown files in this version. Select words in the preview, comment and press Send.": by design.

## The HTML view is empty, plain or missing pictures

These are what the user sees; explain them in a sentence if they ask.

- "This page is built by scripts, which Onionskin never runs, so there is nothing to show.": the page has no text without its scripts. It cannot be reviewed in Onionskin.
- "This page's styles are too heavy to show; the text is shown plain.": its styles are past 2 MB, 20,000 rules or 200 `:has(` selectors.
- A sentence ending "so it is shown as plain text.": the page could not be shown safely as it is. Comments still work; typing is off.
- "Pictures and styles next to this page are not shown, because the page is in your home folder or at the top of a disk.": move the page and its files into a folder of their own.
- "Review first is not available for HTML files in this version. Comment on the page and press Send.": by design.

## poll returns superseded or closed

`superseded`: a newer poll of yours took over; stop this one. `closed`: the user ended the review; stop.

## The page still says "Agent working" after `reply` or `done` returned

The page follows the session by itself: it catches up from the next state it receives, opens a new event stream when the old one died, and retries a reload that failed. Run `onionskin status path/to/file.docx`; if the state is not `working`, ask the user to click the browser tab once (that reconnects it at once). A tab opened from a server that has since been replaced (an upgrade) has to be opened again with `onionskin open`.

## An agent edit lost something

`done` reports flags such as `part_removed` or a drawing count that dropped, with severity `error`. Tell the user and recommend the Revert button on that run's card in the page's review panel (it restores the version from before your run as a new version). Then redo the change with `onionskin apply`, or with a library call that edits in place.
