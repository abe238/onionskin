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

## poll returns superseded or closed

`superseded`: a newer poll of yours took over; stop this one. `closed`: the user ended the review; stop.

## The page still says "Agent working" after `reply` or `done` returned

The page follows the session by itself: it catches up from the next state it receives, opens a new event stream when the old one died, and retries a reload that failed. Run `onionskin status path/to/file.docx`; if the state is not `working`, ask the user to click the browser tab once (that reconnects it at once). A tab opened from a server that has since been replaced (an upgrade) has to be opened again with `onionskin open`.

## An agent edit lost something

`done` reports flags such as `part_removed` or a drawing count that dropped, with severity `error`. Tell the user and recommend the Revert button on that run's card in the page's review panel (it restores the version from before your run as a new version). Then redo the change with `onionskin apply`, or with a library call that edits in place.
