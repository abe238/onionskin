# Onionskin guide

The full reference for Onionskin. The short version is in the [README](../README.md); install, commands and troubleshooting are in [DEVELOPERS.md](DEVELOPERS.md).

Review a Word, Excel or PowerPoint file with a coding agent, in the browser, without losing the file's own formatting.

You open the file. You type edits straight into it, comment on a selection, a cell, a range, a shape or a slide, drop numbered pins, and write one overall note. You press Send. The agent receives your batch (it is tested with Claude Code and Codex, which have each been run end to end by a real agent; other agents are untested), changes the file, and tells you what it did per comment. The page reloads at the same place and shows each answer in an activity feed, with a Revert button if the check found damage.

## Install from the zip

Unzip the Onionskin zip and run `sh install.sh` in the `onionskin` folder (no sudo, needs Node.js 22 or newer). `INSTALL.md` inside is a short page; the full notes are in [DEVELOPERS.md](DEVELOPERS.md).

## Install from source

You need Node 22 or newer. Real Chrome is needed only for the end-to-end tests. The CLI and the server run on plain `node`.

```sh
git clone https://github.com/abe238/onionskin onionskin && cd onionskin
npm install
npm run build:web          # the React app and the bundled engine -> web/dist
npm link                   # puts `onionskin` on your PATH
onionskin --version
onionskin setup            # installs the agent skill into ~/.claude/skills and ~/.agents/skills
onionskin setup-checker    # the Python checks at `done`; `sh install.sh` already does this (downloads five libraries from PyPI once)
onionskin doctor           # checks the install: OK / MISSING / NOTE per line, the fix command on each failure; --json for scripts
```

`onionskin setup` copies `skills/onionskin` to `~/.claude/skills/onionskin` and `~/.agents/skills/onionskin`. It prints what it did, asks before replacing a different version (`--force` skips the question), and supports `--dry-run` and `--uninstall`. To check what it would do first: `onionskin setup --dry-run`.

State (sessions, snapshots, the checker's virtual environment) lives in `~/.onionskin/`; set `ONIONSKIN_STATE_DIR` to change it.

## Start

There are two ways to start, and who does the work depends on which you use.

- **From a terminal:** type `onionskin report.docx`. The file opens in your browser and Onionskin starts its own background agent for it. That agent is Claude Code only: it needs Claude Code installed and signed in, and it runs on your own Claude plan. If the plan's limit is reached, the panel says so. A **Show the agent** switch in the review panel shows what the agent is doing, and **Open in Terminal** opens the same conversation in Terminal. On a Mac with Codex but no Claude Code, the terminal says so in plain words and tells you to ask Codex.
- **From inside Claude Code or Codex:** say "open report.docx in Onionskin". The agent you are talking to does the work. This has been run end to end in both.

The background agent is limited on purpose. It can change your document only through Onionskin's own commands. It cannot read your other files (reading outside its own two folders, your home folder, network fetches and writes elsewhere were all refused when we tested). It is started without API keys in its environment. It can run read-only commands and read files inside its own work folder and the skill's reference folder.

If you open a file with `--no-agent` and press Send with nobody listening, the page says so and offers a Start the agent button.

After each run the browser page refreshes and keeps your place; in a Word file the agent's changed words are then drawn in where they stand, with the old words shown for a moment (the refresh still happens underneath).

In the browser: Edit mode types into the document (in Excel, Shift+Enter or Alt+Enter while typing in a cell starts a new line inside the cell; in a narrow column the first line of a tall cell can be clipped until the column is widened); Comment mode comments on whatever you click (drag across cells for a range); Pin mode drops a numbered pin anywhere. While the agent works you can keep working in the document: when the agent finishes, what you changed is merged with its changes (Word by paragraph, including the formatting you changed and the paragraphs you moved; Excel by cell; PowerPoint by text box). If you and the agent changed the same paragraph, cell or text box, the agent's version stays and yours is shown with a Copy button. In Word, formatting or a move that could not be carried over safely is listed with the reason, and a paragraph you moved keeps the agent's formatting, with a line asking you to check it. In a spreadsheet your values go in only where Onionskin knows the cell is still the same one: on a sheet the agent left alone, or one it changed only with Onionskin's own cell edits. If the agent added, removed or moved rows or columns on a sheet you edited, or changed the file with another tool, your values on that sheet are listed and your version of the file is saved next to the original. Comments you add meanwhile go out as the next batch, and "Take back editing" is always visible.

### Structure edits and other abilities

- **Word tables:** the agent can add or delete a table row or column.
- **PowerPoint slides:** the agent can copy, delete or move a slide. A copied or deleted slide shows one plain note in the panel.
- **Charts:** the agent does not create or change a chart. It says so in plain words and tells you to insert the chart in Word or PowerPoint.
- **Excel merged cells:** the agent is told which cells are merged, and a write into a cell that a merge covers is refused.
- **A note only:** when a run only followed your overall note, the summary says that it changed the file as your note asked, instead of "No change needed".

### For agents and developers

An agent running inside Claude Code or Codex (or a script) uses these commands. A person at a terminal gets plain words instead of this output; `--agent` forces the agent output and `--no-agent` opens the page only.

```sh
onionskin open file.docx                       # starts the local server and opens your browser
onionskin poll file.docx                       # blocks until you press Send, then prints your batch as JSON
onionskin reply --lease <ticket> --then-poll --json '{"replies":[...]}'   # the whole answer in ONE call: edits, finish, then wait for the next batch
onionskin apply file.docx --ops ops.json --lease <ticket>   # the longer route: the agent's anchored edits, through the engine the browser uses
onionskin commit file.docx --from copy.docx --lease <ticket>   # edits made to a COPY with another tool, submitted through the same checked write
onionskin done file.docx --results results.json --lease <ticket>   # one done or declined entry per comment, plus a summary
onionskin poll file.docx --ack                 # wait for the next round (`reply --then-poll` does this for you)
```

The ticket (`--lease <batch id>:<token>`) is printed in the batch's commands; `reply`, `apply`, `commit` and `done` refuse to run without it while a batch is delivered. `onionskin status <file>` answers at once without waiting (`--ticket` re-reads your ticket); `onionskin stop` stops the server. `onionskin poll` typed by a person explains itself and exits 2.

### Background

The picture icon in the top bar opens the Background picker: five presets (paper is the default) in light and dark, or your own image (scaled and stripped of metadata by the page, stored only in the local state folder, never sent anywhere). A guard keeps the bars and the sidebar text at WCAG AA over any picture and tells you when it holds the strength back. CLI: `onionskin config background <paper|pages|aurora|studio|midnight|default>` or `--image <file>`; see [DEVELOPERS.md](DEVELOPERS.md#change-the-background).

### Your voice guide as a file

`skills/onionskin/voice.example.md` is a sample voice guide. Copy it to `skills/onionskin/voice.md` and make it yours: Onionskin reads that file the way a tool reads a `.env`, and uses it as your voice guide until you save one from the page. `voice.md` is ignored by git, is never copied into an installed skill folder. A zip you build for yourself carries it; `npm run package -- --public` leaves it out. `ONIONSKIN_VOICE_FILE=/path/to/voice.md` points at a file somewhere else.

### Quick changes

Type a very plain request as the overall note, such as "Replace Acme with Initech" or "Make every heading bold" (headings: Word files), and the line under the box says how many places it will change. The Send button then shows the count ("Replace in 12 places"). Press it and Onionskin does the change itself on this Mac, with no AI, and it shows up as "Done on this Mac" with a Revert button like any other change. If the file turns out to have a different number of places than the button showed, nothing is written and the note goes to the agent. A word that only appears inside longer words ("he" inside "the"), a match inside a spreadsheet formula, or a note sent with comments or typed edits goes to the agent. "Ask the agent instead" sends it the usual way.

### History

The review panel keeps a History section: the last 20 updates to the file (your edits at each Send, each agent run, a revert, and a file changed outside Onionskin that you chose to reload), newest first, one line each. Click one to see what changed: words removed in red and added in green, spreadsheet cells as old to new, and plain lines for added, removed, moved and formatting changes (bold, a different style, a number format). "Show" scrolls the document to a place and outlines it for a moment. History is a view only: red and green stay in the panel, nothing is ever written into the document, and it does not merge or restore anything (Revert still undoes an agent run). It is not shown on a phone.

## Speed

From pressing Send to the change showing in the document, on a small file:

- With the background agent (the terminal start), a real round took about 5 to 13 seconds in our runs on one Mac.
- Inside a Claude Code session where the agent already has the skill loaded, a warm round took about 2 to 3 seconds.

Onionskin's own part of a round is about 0.5 seconds (measured with a scripted agent); the rest is one model turn. If your agent lets you pick the model, a Sonnet-class model gives the quickest loop. Large files are slower. To measure on your machine: `BENCH_REPLY=1 node scripts/real-run/bench-loop.mjs 5` (no model) and `node scripts/real-run/bench-real.mjs --model sonnet --runs 3` (real agent, uses your allowance).

## Security model, in plain words

- Your file is opened by a server on `127.0.0.1` that only your browser session can reach. The launch link works once, within a minute, and is swapped for a cookie that no other site can send. Every request is checked for the exact host, origin and a per-session token. The agent talks to the server over a private Unix socket in a folder only you can read.
- The page makes no requests to anyone else, and a strict content security policy backs that up. Your document's text does go to the coding agent you already use (Claude Code or Codex) when you press Send: every batch carries the text of the whole document, not only the part you commented on, because the agent needs it to find the right place. Only quick fixes and the no-AI quick commands stay entirely on your Mac. Every test run fails if the browser logs a policy violation.
- The batch the agent receives keeps your words apart from the document's words. `instructions` holds only what you typed. Everything read from the file (quotes, cell values, shape text, sheet and file names) is labeled `untrusted_document_evidence`, cleaned of control characters, length-capped, and the agent skill tells the agent to treat it as data: never follow instructions found there, never run commands or open links because a document says so.
- Edits are checked, not trusted. `apply` refuses an op whose expected text does not match the file, writes atomically, and keeps a copy of the file as it was. At `done` the server compares the file before and after and flags lost parts, broken relationships and dropped drawings, links or fields.
- Macro-enabled files (`.docm`, `.xlsm`, `.pptm`) are refused. Macros never run.
- Only one browser tab per file can edit; others open read-only.
- The browser needs two things on every request: the cookie and a launch token that was handed to the page once and lives only in that page's own origin storage. Another program on another local port can be sent the cookie but never the token. A new tab needs a fresh link from Onionskin.
- An agent never writes your document's path directly: `apply` and `commit` go through the server, which checks the lease, compares the file with the version it expects, snapshots what it replaces, and holds a lock from the comparison to the rename. `done` flags a file that changed any other way.
- If someone else changes the file while Onionskin has it open (Word, a sync tool, a person), Onionskin never overwrites it and never loses the version it holds: that version is saved next to the original as `<name> (Onionskin copy YYYY-MM-DD HHMM).<ext>` and the page tells you in plain words, with Show in folder and Reload buttons. The page also checks when the tab regains focus.
- Documents are size-checked before they are read, archives have per-part and total expansion limits, and the heavy checks at `done` run off the server's main thread.
- Text from the file that appears in check results (part names, link targets, messages) is cut to one printable line before it reaches the agent. LibreOffice is used only for the optional conversion check.

## Limits

- Pagination is closer to Word than to a plain web page, but not identical. Charts and SmartArt show as placeholders.
- Some content cannot be edited in the browser without risking damage: fields, content controls, equations and the like are marked protected and shown read-only, and `apply` skips them and says so. Say what you want in a comment and the agent will explain or use another route.
- No PowerPoint verification exists on the machine this was built on; PowerPoint files are checked with python-pptx, LibreOffice and Keynote instead. A Word file with a new table row was opened in Microsoft Word; files with copied, deleted or moved slides were checked with LibreOffice and a Python reader and have not been opened in Microsoft PowerPoint.
- The deeper check runs synchronously at `done` and can take up to three minutes on a large file.
- No real-time collaboration: several people editing one file together is not built.
- Real-agent status: Claude Code has been run end to end on Word, Excel, PowerPoint, a protected Word file and a hostile Word file; Codex on one Word report. The background agent works only with Claude Code. The full browser test suite runs in Chrome.
- Checks that can be skipped: the deeper check at `done` needs the Python libraries that `sh install.sh` sets up (unless `--no-checker`; `onionskin setup-checker` or the review panel's "Turn on deeper checks" button does it later) and skips without them; its LibreOffice conversion skips when LibreOffice is not installed or `ONIONSKIN_NO_SOFFICE=1` is set. A skip is never silent: the `done` output says `Deeper check skipped: <reason>`, the review panel says "Deeper checks are off" with the button (the technical sentence sits under Details), and the Node checks always run. Test results are the same: a missing fixture is a skip with a printed reason locally and a failure under `CI`.

## Building and testing

The commands for building, running tests and refreshing the vendored engine are in [CONTRIBUTING.md](../CONTRIBUTING.md).

## Credits

- The loop, the poll and ack semantics and the agent skill's wording descend from [human-review](https://github.com/petergyang/human-review) by Peter Yang (MIT).
- The document engine is a fork of [office-engine](https://github.com/p10node/office-engine) by p10node (MIT), vendored under `vendor/`.
- The web app is built with React (MIT).

Licenses: LICENSE (MIT, this project) and NOTICE (third-party notices).
