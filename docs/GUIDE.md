# Onionskin guide

The full reference for Onionskin. The short version is in the [README](../README.md); install, commands and troubleshooting are in [DEVELOPERS.md](DEVELOPERS.md).

Review a Word, Excel, PowerPoint, HTML or Markdown file with a coding agent, in the browser, without losing the file's own formatting.

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

In the browser: Edit mode types into the document (in Excel, Shift+Enter or Alt+Enter while typing in a cell starts a new line inside the cell; in a narrow column the first line of a tall cell can be clipped until the column is widened); Comment mode comments on whatever you click (drag across cells for a range); Pin mode drops a numbered pin anywhere. While the agent works you can keep working in a Word, Excel or PowerPoint document (an HTML page is read-only during a run, see [HTML files](#html-files), and a Markdown file takes comments only, see [Markdown files](#markdown-files)): when the agent finishes, what you changed is merged with its changes (Word by paragraph, including the formatting you changed and the paragraphs you moved; Excel by cell; PowerPoint by text box). If you and the agent changed the same paragraph, cell or text box, the agent's version stays and yours is shown with a Copy button. In Word, your edit goes only into the paragraph you edited: Word gives each paragraph an id, and when the agent changed, split, merged or removed that paragraph, or Onionskin cannot tell which paragraph it is now, your text is shown with a Copy button instead of being written elsewhere. If merging takes longer than two minutes, nothing is written, a copy of your version is saved next to the file, and your edits stay in the page. In Word, formatting or a move that could not be carried over safely is listed with the reason, and a paragraph you moved keeps the agent's formatting, with a line asking you to check it. In a spreadsheet your values go in only where Onionskin knows the cell is still the same one: on a sheet the agent left alone, or one it changed only with Onionskin's own cell edits. If the agent added, removed or moved rows or columns on a sheet you edited, or changed the file with another tool, your values on that sheet are listed and your version of the file is saved next to the original. Comments you add meanwhile go out as the next batch. While Onionskin's background agent works, the banner has **Stop the agent**: it takes your batch back (comments become drafts again, the note goes back to its box, anything the agent already wrote can be reverted), then stops the agent; a late write from it is refused. The next Send starts a new agent at once, in a fresh conversation that never saw the request you took back, and that start does not count toward the hourly limit. With your own agent (or one open in Terminal) the banner has "Take back editing" instead, which takes the batch back and leaves the agent alone.

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

Type a very plain request as the overall note, such as "Replace Acme with Initech" or "Make every heading bold" (headings: Word files), and the line under the box says how many places it will change. The Send button then shows the count ("Replace in 12 places"). Press it and Onionskin does the change itself on this Mac, with no AI, and it shows up as "Done on this Mac" with a Revert button like any other change. If the file turns out to have a different number of places than the button showed, nothing is written and the note goes to the agent. A word that only appears inside longer words ("he" inside "the"), a match inside a spreadsheet formula, or a note sent with comments or typed edits goes to the agent. "Ask the agent instead" sends it the usual way. In a Markdown file a quick change is never offered: the note goes to the agent.

### History

The review panel keeps a History section: the last 20 updates to the file (your edits at each Send, each agent run, a revert, and a file changed outside Onionskin that you chose to reload), newest first, one line each. Click one to see what changed: words removed in red and added in green, spreadsheet cells as old to new, and plain lines for added, removed, moved and formatting changes (bold, a different style, a number format). "Show" scrolls the document to a place and outlines it for a moment. History is a view only: red and green stay in the panel, nothing is ever written into the document, and it does not merge or restore anything (Revert still undoes an agent run). It is not shown on a phone. In a Markdown file History compares block by block, so two changes in one paragraph count as one place.

## HTML files

Onionskin opens `.html` and `.htm` pages: reports, newsletters, saved articles, exported documents and other pages that do not need scripts to show their content. You comment, drop pins, write an overall note and fix text, then press Send. The agent changes the real file, History shows what changed, and Revert undoes a run. Your text fixes and the agent's edits made with Onionskin's ops are made in place in the file's own source, so everything outside them (formatting, comments in the markup, line endings, how characters are spelled) stays exactly as it was. To try it, open `samples/sample.html` in the app folder (`~/.onionskin/app/<version>/samples/`).

Review first, stamps, quick fixes and the tracked-changes copy are not offered for HTML files in this version.

### What the view shows

The view is a still picture of your page. It sits in a frame with a border and the label "Your page (still view)", so nothing in the page can pass for Onionskin's own buttons. The first time, the page says: "This is a still view of your page: scripts are off and nothing loads from the internet."

- **Scripts never run.** A page with scripts shows "Scripts are off in this view." A page with no text until a script builds it shows one message across the whole view: "This page is built by scripts, which Onionskin never runs, so there is nothing to show."
- **Nothing loads from the internet.** Remote images, stylesheets and fonts are not loaded, and a line counts them ("3 things from the internet were not loaded."). Links are shown and never followed.
- **Forms** are shown with their controls turned off. Nothing can be submitted.
- **Placeholders:** an image that is not shown is "[image not shown]"; video, audio and canvas are "[media not shown]"; inline SVG and MathML are "[graphic not shown]". Frames, embedded objects, `noscript` and `template` contents are left out.
- **Heavy styles:** when the page's styles add up to more than 2 MB, 20,000 rules or 200 `:has(` selectors, all of them are left out: "This page's styles are too heavy to show; the text is shown plain."
- **Plain text view:** when a page cannot be shown safely as it is (its markup does not read back the same, its styles cannot be shown safely, or it holds characters that cannot be shown), the view shows its text plain, with one sentence saying why, such as "This page's markup could not be shown safely, so it is shown as plain text." A page that made the view stop responding opens in the plain text view the next time, with "Try the full view again". Typing is off in the plain text view; comments work.
- **Overlays:** in Comment mode, a clicked part of the page offers "Hide this in the view", for cookie banners and newsletter pop-ups. It hides that part in the view only, never in the file, and a line brings it back.

### Pictures and styles next to the page

Onionskin shows pictures and stylesheets that sit next to the page, by these rules:

- In the page's folder, or up to 3 folders below it. Never above it, never at an absolute path or a web address, never in a folder whose name starts with a dot or a folder named `Library`, and never through a symbolic link.
- Pictures: PNG, JPEG, GIF or WebP, recognized by their content, not their name. SVG pictures are not shown. One picture at most 10 MB and 16,000 pixels a side (64 million pixels); at most 500 pictures and 30 MB in all. Pictures written into the page itself (`data:` images) are shown too.
- Stylesheets linked with `<link rel="stylesheet">`: at most 2 MB each, `@import` at most 5 levels deep.
- When the page sits directly in your home folder or at the top of a disk, nothing next to it is shown: "Pictures and styles next to this page are not shown, because the page is in your home folder or at the top of a disk." Move the page and its files into a folder of their own.

What the view shows from those files is never sent to the agent.

### What you can edit

In Edit mode you fix text where it stands: type, delete, replace words. Your fixes stay in the page as unsent edits and are written into the file when you press Send. You can type as soon as you click. One exception: on a very large element (more than 400 text parts), the first keystroke right after a click can be missed.

If the file changes outside Onionskin, the view reloads and puts your unsent text fixes back only where it can identify the same text for certain. Any fix it cannot place is listed as "could not be placed", with its text and a Copy button, and is not applied.

In Comment and Pin modes every keyboard shortcut works while you point at the page. In Edit mode, while the cursor is in the page, Onionskin's shortcuts do not work; use the toolbar's mode buttons, the selection's Comment and Ask buttons, the panel button and Send, or click outside the page first.

Some text is shown but cannot be edited here: text inside a link, a form control or the page title, text made only of spaces, and text that the browser shows somewhere other than where the source has it (text around a table, for example). Clicking it says "This part of the page cannot be edited here; comment on it instead." Pressing Return, or a change that would add or remove an element, opens the comment box on that place: "New lines and elements are the agent's job: say what you want in the comment."

In Comment mode, select text or click a part of the page; in Pin mode, drop a pin anywhere.

While the agent works, the view is read-only: "The agent is working; comment now and fix text when it is done." New comments are kept and go out with the next Send. A second tab on the same file says "This file is open for editing in another tab, so typing is off here; comments still work."

### What the agent can and cannot change

The agent can change text and structure: headings, paragraphs, lists, tables, text formatting (bold, italic, code and the like), pictures from a relative path or a `data:` image, and links to web addresses, email addresses, phone numbers, nearby files or places in the page. It can set a short list of attributes, such as `class`, `id`, `title`, `lang` and `style` (a style may load only a relative path or a `data:` image).

It cannot add or change code that runs in a browser: scripts, event handlers such as `onclick`, frames and embedded objects, forms and their controls, stylesheet links, anything loaded from the internet, `data-` attributes, or a link of any other kind (such as `javascript:`). It cannot change a `script` or `style` element at all. When the page loads a script, text containing `{{`, `{%`, `<%` or `${` is refused too, because a script could read it as a template. Such a change is refused whole, and nothing of it is written: "The agent tried to add code that runs in a browser, so nothing was written." The agent tells you in its summary.

Link targets can change. History lists every changed link and picture target in plain text ("now points to ...", "no longer points to ...").

The first time the agent writes a character outside plain ASCII into a page that does not declare its encoding, Onionskin also adds `<meta charset="utf-8">` at the top of the page, so browsers read it the same way.

### Encodings

Onionskin opens pages saved as UTF-8, with or without a byte order mark. Others are refused:

- A page that declares windows-1252, ISO-8859-1 or US-ASCII, and whose accented letters do not already read as UTF-8: "This file is not saved as UTF-8; Onionskin can save a UTF-8 copy and open that." `onionskin open` prints that sentence and the command that makes the copy: `onionskin utf8-copy page.html`. The copy is written next to the page as `page.utf8.html`, only if that name is free, and the original is not changed. Then open the copy.
- A page that declares any other encoding (UTF-16, Shift_JIS and the like), a page that declares one of the three above but whose accented letters already read as UTF-8, or one that holds bytes that are not valid UTF-8: "This file is not saved as UTF-8, and Onionskin cannot tell how it is saved, so it cannot open it." Save the page as UTF-8 in your editor and open that.

### Files that are refused

| File | What Onionskin says |
| --- | --- |
| `.mhtml`, `.mht`, `.webarchive` | "Onionskin cannot open this kind of saved page; in Chrome choose Save As, Webpage, Complete." |
| `.xhtml` | "Onionskin cannot open .xhtml pages; save the page as .html and open that." |
| `.svg` | "Onionskin cannot open .svg pictures; it opens .html and .htm pages." |
| Any other kind | "Only .docx, .xlsx, .pptx, .html, .htm, .md and .markdown files are supported" |

### Not in this version

One file per session: a linked stylesheet or script file is never edited. Pages built by scripts show nothing to edit. Chrome is the tested browser; Safari has not been tested with HTML files.

## Markdown files

Onionskin opens `.md` and `.markdown` files: notes, READMEs, drafts and other text written in Markdown. The file's source is the document. You read it as a rendered preview, comment on words, type edits, and press Send. The agent changes the exact words you pointed at, History shows what changed, and Revert undoes the agent's last run. Everything outside a change stays byte for byte as it was: line endings, the final newline and a byte order mark.

### What the preview shows

The preview shows headings, paragraphs, bold and italic, code and code blocks, block quotes, bullet and numbered lists, tables, links and rules. It is built from Onionskin's own page elements, so nothing in the file runs or loads:

- Links are styled text. They cannot be clicked or followed.
- Images are shown as the text they are written as (`![alt](picture.png)`). Nothing is loaded.
- Raw HTML and front matter (the block between `---` lines at the very top) are shown as written, in a box of their own.
- Also shown as written: reference links, links in angle brackets, task boxes (`[ ]`), headings underlined with `===` or `---`, strikethrough and footnotes.

### Comment

Select words in the preview, then press Comment or Ask on the button that appears, or click a block in Comment mode, or drop a pin in Pin mode. The comment points at exactly the words you selected in the file's source, and goes to the agent when you press Send.

- A selection that runs across two blocks is refused: "A comment can point at words inside one block only. Select within one paragraph, heading, list item, table cell or code block."
- Words that cross formatting the preview hides (part of a link and the text after it, for example) do not map to one exact place: "These words do not map to one exact place in the file: they cross formatting the preview hides. You can comment on the whole block instead." The block's source is shown as written, with a "Comment on the whole block" button. If the preview changes before you press it, the offer is withdrawn: "The text changed under that offer, so it was withdrawn and nothing was anchored. Select the words again."

### Edit

The toolbar has Preview, Edit, Comment and Pin. Edit is a plain text box on the file's Markdown source. You can also just start typing in the preview: the page switches to Edit with your key typed at that spot. Where a spot does not map to one exact place in the file, the key is not typed: "That spot does not map to one exact place in the file, so the key was not typed. The editor opened at the start of that block." In an empty file the first key always lands. Esc goes back to Preview, which then shows your edit. Typing works in files whose line endings are LF or CRLF; an edit keeps the line endings of the file it was typed on, so Copy and Send give the same bytes.

You can comment on your edited text in the preview before you send. Send writes your edit into the file first, then the agent gets the batch: comments on the edited text point at the exact words in the file as it is now. The agent is told that your edit is already in the file.

A comment points at one exact version of the file. A comment you made before typing, or one still waiting when the file changed (an agent's write, Revert, a save in another program), no longer has a place. Its card says "You edited the text after making this comment, so it no longer points at a place. Select the words again, or send it as it is." (or "The file changed after you made this comment, ..."). Sent as it is, it reaches the agent as words only: the agent can decline it with a note or ask you a question, but cannot change the file for it.

If the file changes outside Onionskin while you have an unsent edit, the edit is kept but not sent: "Your unsent edit was typed on an earlier version of the file, so it is not shown or sent. Copy it to keep it, then discard it." Typing stays off until you discard it.

Typing is off:

- while the agent works: "The agent is working on this file. You can type again when it is done." Comments still work and go out with the next Send.
- in a second tab on the same file: "This tab is read-only. Edit from the tab that holds the file."
- in a file with mixed line endings: "This file mixes line endings, so it opens for reading and comments only. Save it with one kind of line ending to edit it here."
- in a file whose line endings are carriage returns alone: "This file uses old-style line endings (a carriage return alone), which this version does not edit, so it opens for reading and comments only. Save it with LF or CRLF line endings to edit it here."
- in a file whose text holds an invisible byte order mark character. An edit that adds one is not sent: "Your edit was not sent: it contains an invisible byte order mark character (U+FEFF), which would change how the file is read. Remove it in Edit, then send again."

When Onionskin wrote your edit but could not confirm the save (some network shares and external disks cannot confirm one), it says "Your edit was written to the file, but Onionskin could not confirm the save. Check the file; your edit is kept here to copy."

### What the agent can change

The agent changes text only by naming an exact range of the source and its exact old text. If the file is not the version the batch was made on, nothing is written. If the old text of one replacement differs by one character, that replacement is refused; in an ordinary reply nothing is written, while a reply sent with `--partial` still writes the other replacements that check out. The agent cannot change front matter a file already has; in a file with none, it can still add a block at the very top that then reads as front matter. You can edit front matter yourself in Edit. Revert is off when the file was changed outside Onionskin after the agent's write: "Revert is off for this run: the file was changed outside Onionskin after the agent's checked write, and reverting would erase that change."

### Not in this version

Review first, Quick changes, Download my edits, using the open file as a writing sample, and merging your typing with an agent's run (typing is off while it works). Files that are not saved as UTF-8 are refused: "This Markdown file is not saved as UTF-8, so Onionskin cannot read it. Save it as UTF-8 (in most editors: Save As, Encoding, UTF-8) and open it again." Files over 1 MB, over 20,000 lines, or nested more than 32 levels deep are refused with a sentence that names the limit.

## Speed

From pressing Send to the change showing in the document, on a small file:

- With the background agent (the terminal start), a real round took about 5 to 13 seconds in our runs on one Mac.
- Inside a Claude Code session where the agent already has the skill loaded, a warm round took about 2 to 3 seconds.

Onionskin's own part of a round is about 0.5 seconds (measured with a scripted agent); the rest is one model turn. If your agent lets you pick the model, a Sonnet-class model gives the quickest loop. Large files are slower. To measure on your machine: `BENCH_REPLY=1 node scripts/real-run/bench-loop.mjs 5` (no model) and `node scripts/real-run/bench-real.mjs --model sonnet --runs 3` (real agent, uses your allowance).

## Size limits

Onionskin reads a whole file at Send, at each hand-off to an agent and for a review (a review on its own thread, the others in a worker thread), so it refuses a file it could not read quickly, with the number and what to do ("Onionskin cannot read this file: this workbook has more than 1,000,000 cells, more than Onionskin can read. Split it into smaller workbooks and open those."). A file is refused whole, never read in part. Each Office and HTML limit was set from measurement: a plain file at the limit kept Onionskin's other requests waiting at most about 0.9 seconds (Excel), 0.8 seconds (Word) and 0.3 seconds (PowerPoint) on a busy test Mac (load average 15 to 28; an idle Mac is faster), and the hostile files in the tests under 2 seconds.

| What | Limit | Why this number |
| --- | --- | --- |
| Any file | 200 MB on disk | Hashing and writing it once kept Onionskin waiting 0.85 s. Pictures and videos are usually most of a large file. |
| Any file | 20,000 parts; 64 MB for one unpacked XML part, 512 MB for any part; 256 MB unpacked in all | Real files have a few hundred parts and a few MB of XML. Past these a file is most likely made to fill memory. |
| Any file | 32 million characters of XML in one reading (64 million for a workbook); 512 attributes on one tag; XML 256 levels deep | About 1,600 Word pages are 18 million characters; a workbook of 999,000 cells, half of them short texts, 48 to 62 million. Two sheets of one 31-million-character attribute each (the worst shape for this limit) kept Onionskin waiting 0.43 s. |
| Word | 50,000 paragraphs, 400,000 XML elements, 800,000 attributes, 8 million characters of text | About 1,600 pages. 49,000 paragraphs as Word writes them: 0.51 s at most. Twice these limits: 0.8 s for a plain file, but one paragraph of 400,000 runs took 1.7 s for a quick change preview, and the change itself would pass 2 s (estimated: 1.1 to 1.3 s at half that size). |
| Excel | 1,000,000 cells, 1,000,000 shared strings, 50,000 merged ranges, 20,000 named ranges, 1,000 sheets, 3.2 million XML elements, 6.4 million attributes, 32 million characters of text, 32 million characters of text the cells show from shared strings, sheet names of 255 characters | 50,000 rows by 20 columns. 999,000 cells: 0.74 to 0.83 s at most, the server at 1.5 GB (Onionskin 0.0.3 took 3.1 s at 1,000,000); with longer texts, 0.86 s and 1.6 GB. 2,000,000 cells would be about twice that, past the aim; a higher limit needs the Send's reading moved off Onionskin's thread. The others are far above ordinary files and hold the worst shapes down: 999,000 cells with 49,000 merged ranges 0.64 s, 999,000 cells all showing one shared string 0.57 s, one string of 31 million characters 0.41 s. Excel itself allows 31 characters in a sheet name. |
| PowerPoint | 50,000 shapes, 500,000 XML elements, 1,000,000 attributes, 8 million characters of text | A deck of 5,000 slides (20,000 shapes) took 0.3 s at most. |
| HTML | 10 MB on disk; 200,000 elements, 400,000 attributes, 8 million characters of text, elements 512 levels deep, 1 MB for one attribute value (a `data:` value counts against the 10 MB instead) | Memory runs out first, at about 2.5 to 3 KB per element while a write is checked. A 10 MB page of 200,000 elements took 1.2 to 1.5 s to read; a 20 MB page of 400,000 elements ran out of memory in a worker thread. No real page tried came near these limits. The view has its own caps on pictures and styles (see [HTML files](#html-files)). |
| Markdown | 1 MB on disk (1,048,576 bytes), 20,000 lines, quotes, lists or emphasis nested 32 levels deep | A batch carries the file's blocks whole, in order, until the next block would pass 200,000 characters (UTF-16 code units); the rest is not shown to the agent, so one paragraph longer than that is not shown at all. A comment carries its own selected words (up to 100,000 characters each, 2,000,000 for all comments of one batch together) wherever they are; past that a comment goes as words only. |

A file that grows past a limit after it was opened is refused at Send, and nothing is written. To open a larger file, split it (by chapter, by sheet, by section of slides) and open the parts.

## Security model, in plain words

- Your file is opened by a server on `127.0.0.1` that only your browser session can reach. The launch link works once, within a minute, and is swapped for a cookie that no other site can send. Every request is checked for the exact host, origin and a per-session token. The agent talks to the server over a private Unix socket in a folder only you can read.
- The page makes no requests to anyone else, and a strict content security policy backs that up. Your document's text does go to the coding agent you already use (Claude Code or Codex) when you press Send: every batch carries the text of the whole document, not only the part you commented on, because the agent needs it to find the right place. Only quick fixes and the no-AI quick commands stay entirely on your Mac. Every test run fails if the browser logs a policy violation.
- The batch the agent receives keeps your words apart from the document's words. `instructions` holds only what you typed. Everything read from the file (quotes, cell values, shape text, sheet and file names) is labeled `untrusted_document_evidence`, cleaned of control characters, length-capped, and the agent skill tells the agent to treat it as data: never follow instructions found there, never run commands or open links because a document says so.
- Edits are checked, not trusted. `apply` refuses an op whose expected text does not match the file, writes atomically, and keeps a copy of the file as it was. At `done` the server compares the file before and after and flags lost parts, broken relationships and dropped drawings, links or fields.
- Macro-enabled files (`.docm`, `.xlsm`, `.pptm`) are refused. Macros never run.
- HTML pages: three separate rules keep code in a page from running or reaching the network, and each holds even if another fails. The view's frame runs no script. The content rules of the frame and of the page block every load. The copy of the page the view shows holds no network address at all (no link target, no remote picture, no stylesheet link). Every write to an HTML file, from the agent or from your own text fixes, is checked against the list of what may change, and a change made by ops or by your fixes is also proven: the file is read again and must be the same everywhere outside the change, or nothing is written. Revert puts back the earlier version exactly as it was. The page is read in worker threads, never on the server's main thread. Pictures and styles next to the page never reach the agent.
- Only one browser tab per file can edit; others open read-only.
- The browser needs two things on every request: the cookie and a launch token that was handed to the page once and lives only in that page's own origin storage. Another program on another local port can be sent the cookie but never the token. A new tab needs a fresh link from Onionskin.
- An agent never writes your document's path directly: `apply` and `commit` go through the server, which checks the lease, compares the file with the version it expects, snapshots what it replaces, and holds a lock from the comparison to the rename. `done` flags a file that changed any other way.
- If someone else changes the file while Onionskin has it open (Word, a sync tool, a person), Onionskin checks the file right before every write and does not write over a change it finds there, and it keeps the version it holds: that version is saved next to the original as `<name> (Onionskin copy YYYY-MM-DD HHMM).<ext>` and the page tells you in plain words, with Show in folder and Reload buttons. (In a Markdown file, your own unsent edit is not saved as a copy: it stays in the page to copy.) The limit: a save by another program in the instant between that check and the write is not seen, and is overwritten; in a Markdown file, a program writing into Onionskin's temporary file while it is checked can have those bytes published, and the save is then reported as not confirmed. Onionskin watches the file's folder, so the page says so within about 1 to 2 seconds of the outside save, also while the agent works; it also checks when the tab regains focus. A tab that is read-only shows nothing. A file in a synced folder (iCloud, Dropbox) may be noticed only by the focus and 30-second checks.
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
