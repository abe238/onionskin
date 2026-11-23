# Onionskin

> Review and edit Word, Excel, PowerPoint, HTML and Markdown files with Claude Code or Codex. Comment in a browser editor on your computer, press Send, and the agent changes the real file. Open source (MIT).

**Status:** Onionskin 1.0 is available now. Open source under the MIT license. Version 1.0.3.

## Edit Office, HTML and Markdown files with your coding agent.

Type onionskin report.docx in a terminal, or tell Claude Code or Codex: open report.docx in Onionskin. Edit the file, comment on anything in it, and press Send: your agent changes the real file, and the page updates in place.

- Star on GitHub: https://github.com/abe238/onionskin
- Watch the demo (a 30 second recording of the real editor, no install): https://onionskin.abediaz.ai/try/
- Follow the author, abe238: https://x.com/abe238 and https://github.com/abe238

## Install (for AI coding agents)

Install steps for AI coding agents.

1. Install once: paste this sentence into Claude Code or Codex: Install Onionskin from https://github.com/abe238/onionskin
2. Open a file: say "open report.docx in Onionskin" (use the real file name), or run onionskin report.docx in a terminal.
3. The editor opens in the user's browser. When the user presses Send, apply their edits, comments, pins and overall note to that file.

## New in 1.0: Markdown files

Open notes.md the same way you open a Word file. You read it as a rendered preview, with headings, lists, tables and code. Select words and comment, or just start typing: the page switches to the Markdown source, with your key where you pressed it. Press Send, and the agent changes exactly the words you pointed at.

- **Point at the words.** Select words in the preview and comment, or drop a pin. The comment goes to your agent tied to those exact words in the file.
- **Start typing to edit.** The page swaps to Edit, a plain text box on the file's Markdown source. Esc goes back to the preview, which shows your edit.
- **One Send for both.** Your typed edit and the comments you made on it go to the agent together. The changed words are marked, History shows what changed, and Revert undoes the agent's last run.
- **Nothing in the file runs.** Nothing in the file runs or loads. Links cannot be followed, and images and raw HTML are shown as the text they are written as.

Files up to 1 MB, saved as UTF-8. Onionskin checks the file right before every write.

## How it works

1. **Open a file.** In a terminal, type onionskin report.docx. Or tell Claude Code or Codex: open report.docx in Onionskin. The file opens in a browser editor on your computer, with the document on the left and a review panel on the right.
2. **Mark it up.** Edit text directly. Comment on a selection, cell, range, shape or slide, drop numbered pins, tap a one-tap request like Shorter or Friendlier, or write one overall note.
3. **Press Send.** The agent changes the real file. The page reloads in place and keeps your position, shows what changed, and lets you revert the last run.

## What you can do

- **Edit directly.** Type in the file like any editor.
- **Comment on anything.** A sentence, a cell, a shape, a slide or part of a page.
- **Pins and one overall note.** For a spot on the page, or a change across the whole file.
- **One-tap stamps.** Shorter, Friendlier, Fix grammar, Translate.
- **Review first.** The agent suggests changes as cards. Nothing changes until you accept.
- **History and revert.** See what changed. Undo the last run in one click.
- **Real tracked changes.** Export a Word file with tracked changes, checked in Microsoft Word.
- **HTML pages.** A still view: scripts never run and nothing loads from the internet.

## How the pieces fit

The editor and the server run on your computer, and your coding agent edits the file on disk.

1. You press Send. The editor hands your edits, comments, pins and overall note to the Onionskin server on your computer.
2. Your coding agent picks up that batch: Onionskin's own background agent (Claude Code) when you started from a terminal, or the agent you are talking to when you started from inside Claude Code or Codex.
3. The agent edits the real file on disk.
4. The agent reports back, and Onionskin checks the file against the snapshot it took before the run.
5. The editor reloads in place and keeps your position, with a feed of what changed and a revert button.

## Keep working while the agent works

You do not have to wait for a run to finish. In Word, Excel and PowerPoint, keep typing, and your edits are merged with the agent's version when it is done. An HTML page is read only while the agent works; you can still add comments. In a Markdown file, typing is off while the agent works, and comments still work.

- **Word.** Your edits and the agent's are combined paragraph by paragraph, including formatting and moved paragraphs.
- **Excel and PowerPoint.** Your edit is carried over only onto a place the agent did not touch.

## Quick fixes, answered on your Mac

Select one sentence in a Word or PowerPoint file and ask for Fix grammar. Apple's built-in on-device model answers on your Mac. Nothing is downloaded, and nothing changes until you tap Use this.

- **Usually ready by the time you tap.** The fix starts as soon as the Quick ask box opens, so the answer is usually waiting when you tap.
- **Plain commands use no AI.** Replace in N places and other plain quick commands run on your Mac with no AI at all. In a Markdown file they go to your agent.

Quick fixes need macOS 26 or later, Apple silicon and Apple Intelligence turned on. Without them, Fix grammar goes to your coding agent.

## The editor runs on your machine

The editor and its small server run on your computer, on the loopback address only, and the page makes no outside requests. When you press Send, your document goes to the coding agent you already use, Claude Code or Codex. Every batch carries the text of the whole document, not only the part you commented on, because the agent needs it to find the right place.

- **No Onionskin cloud.** Onionskin itself does not upload your files. There is no Onionskin account and no Onionskin cloud.
- **Loopback only.** The local server listens on loopback, so other machines on your network cannot reach it.
- **Snapshots before changes.** Onionskin keeps snapshots of your file, including the original, so a revert is one click.
- **Some things never leave the Mac.** Quick fixes and the plain quick commands are answered on your Mac and go nowhere else.

Your coding agent works the way it already does. Whatever it normally sends to its model provider still applies.

## Formats

- Word (.docx): Documents and reports
- Excel (.xlsx): Workbooks and sheets
- PowerPoint (.pptx): Decks and slides
- HTML (.html): Static web pages
- Markdown (.md): Notes, READMEs and drafts

## FAQ

### Can I see it without installing anything?

Yes. The demo page plays a 30 second recording of the real editor on a Markdown file. No install, and nothing runs in your browser except the video.

### Which coding agents does it work with?

Claude Code and Codex, in two different ways. Type onionskin report.docx in a terminal and Onionskin starts its own background agent, which is Claude Code only and runs on your Claude plan. Or tell Claude Code or Codex: open report.docx in Onionskin, and the agent you are talking to does the work.

### Does my file leave my computer?

The editor and its small server run on your computer, and the page makes no outside requests. When you press Send, your document goes to the coding agent you already use, Claude Code or Codex, so whatever that agent normally sends to its model provider still applies. Every batch carries the text of the whole document, not only the part you commented on, because the agent needs it to find the right place. Only quick fixes and the plain quick commands stay entirely on your Mac. The background agent can change your document only through Onionskin's own commands. In our tests it could not read your other files or reach the network, and it is started without API keys in its environment.

### What happens with HTML and Markdown files?

Both open as a view where nothing in the file runs and nothing loads from the internet. In an HTML page you edit text directly, and structure changes, such as a new paragraph, go to the agent as comments. Onionskin refuses any agent change that would add code that runs in a browser. A Markdown file opens as a rendered preview: select words and comment, or start typing and the page switches to Edit, a plain text box on the file's Markdown source. Not in this version for Markdown: Review first, Quick changes and Download my edits. HTML pages up to 10 MB and Markdown files up to 1 MB, saved as UTF-8.

### What does it need, and how do I update it?

Claude Code or Codex already installed: Onionskin is for people who already use one of them. macOS only so far, because it is the only platform tested, and Node.js 22 or newer. There is no Windows or Linux version and no real-time collaboration. Quick fixes also need macOS 26 or later, Apple silicon and Apple Intelligence turned on. If something is off, run onionskin doctor to check the install. Onionskin is also on npm: run npm install -g onionskin-cli, then onionskin setup. To update later, tell your agent "update Onionskin" or run onionskin update.

### Can the agent add table rows or slides? What about charts?

Yes to the first two: it can add or delete a table row or column in Word, and copy, delete or move a slide in PowerPoint. Charts are declined with a plain message that says to insert the chart in Word or PowerPoint.

### How is this different from pasting a document into a chat?

A chat hands you text back, and you copy it into the file yourself. With Onionskin, each note is anchored to the exact spot in the document, your agent edits the real file, and you see every change land in place with a revert button.

### Who made it, and what is the license?

abe238. You can find him at abediaz.com, on GitHub as abe238 and on X as @abe238. The license is MIT. Onionskin builds on a fork of the office-engine document engine by p10node (MIT) and on ideas from Peter Yang's human-review (MIT).

## Why Onionskin?

Onionskin is a thin, strong paper you can see through. From the 1920s to the 1970s, offices typed carbon copies on it because it was light, cheap to mail and easy to file.

Artists and animators found another use for it. They laid a sheet over a drawing, saw the original through it, and traced the next version on top. A new idea took minutes, and it started from work that already existed.

This tool works the same way. It lays a thin layer over your Word, Excel, PowerPoint, HTML or Markdown file. You mark what you want on that layer, and your coding agent (Claude Code or Codex) makes the change in the real file. The page updates in place and you keep going.

We built it because we believe the age of AI makes fast edits and fast creation possible, and a lot of today's tools are too heavy for that. A quick change should feel quick. You and your agent should be able to work on the same page, one thin sheet apart.

Sources:

- [CAMEO, Museum of Fine Arts, Boston](https://cameo.mfa.org/wiki/Onionskin_paper)
- [American Jewish Historical Society, HIAS archives project](https://ontherescuefront.wordpress.com/2016/03/04/old-office-document-formats-from-the-hias-archive/)
- [Wikipedia: Onion skinning](https://en.wikipedia.org/wiki/Onion_skinning)

## Credits

- [office-engine](https://github.com/p10node/office-engine) by p10node (MIT): the document engine that renders and edits .docx, .xlsx and .pptx in the browser; Onionskin builds on a fork of it.
- [human-review](https://github.com/petergyang/human-review) by Peter Yang (MIT): the human review loop idea: a command line tool and local server your agent waits on while you mark things up.

## Author

Onionskin is made by abe238: https://abediaz.com, https://github.com/abe238, https://x.com/abe238. License: MIT.
