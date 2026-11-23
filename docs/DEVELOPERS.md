# Onionskin for developers

Everything beyond the short [README](../README.md): the ways to install, the command-line reference, what is built and tested, and the full install, test and troubleshooting notes. The long reference for using the editor is [GUIDE.md](GUIDE.md). How to build and test the code is in [CONTRIBUTING.md](../CONTRIBUTING.md); how to report a security problem is in [SECURITY.md](../SECURITY.md). Bugs and ideas are welcome there too.

## Ways to install

1. **One sentence to your agent** (what the README shows): "Install Onionskin from https://github.com/abe238/onionskin". The agent follows the README's agent block, which runs `scripts/get.sh`.
2. **The one-line installer**, by hand: `curl -fsSL <release url>/get.sh | sh`. It downloads the release zip, checks its SHA-256, unzips it to a temp folder and runs the zip's own `install.sh`. `sh scripts/get.sh --dry-run` prints what would happen. Pin a release with `ONIONSKIN_ZIP_URL`, `ONIONSKIN_SHA256_URL` or `ONIONSKIN_SHA256`; `ONIONSKIN_BASE_URL` changes the folder both files are fetched from (https only, or `http://127.0.0.1` and `file://` for local tests).
3. **npm**: `npm install -g onionskin-cli`, then `onionskin setup` to install the two skill folders. The package is the same app without `install.sh`; the deeper checks are turned on later with `onionskin setup-checker`. If an installer copy also exists in `~/.local/bin`, whichever comes first on PATH answers; `onionskin doctor` prints the copy it runs from and a `NOTE` for each other copy.
4. **Claude Code plugin**: `/plugin marketplace add abe238/onionskin`, then `/plugin install onionskin@onionskin`. `.claude-plugin/marketplace.json` lists one plugin whose source is `./skills/onionskin`, so only the skill folder is copied into Claude Code's plugin cache. It needs no `plugin.json`: the marketplace entry is the manifest (a `plugin.json` inside the skill folder would also be copied into `~/.claude/skills/onionskin` by `setup`, where Claude Code would load it as a second plugin). The skill shows as `onionskin:onionskin`.
5. **Codex plugin**: `codex plugin marketplace add abe238/onionskin`, then `codex plugin add onionskin@onionskin`. Codex reads `.agents/plugins/marketplace.json` (it prefers it to the Claude Code file); the plugin root is `skills/`, with its manifest in `skills/.codex-plugin/plugin.json` and `"skills": "./onionskin/"`. Codex lists the skill only through that path: a plugin root with `SKILL.md` at the top installs but shows no skill.
6. **The zip**: unzip it and run `sh install.sh` in the `onionskin` folder (no sudo, needs Node.js 22 or newer).
7. **From source**: see [GUIDE.md](GUIDE.md#install-from-source).

A plugin brings the skill only, not the `onionskin` command. When the command is missing, the skill tells the agent to run the agent install command from the README, then `onionskin doctor`. To keep one copy of the skill in Claude Code, `onionskin setup` skips `~/.claude/skills/onionskin` when `~/.claude/plugins/installed_plugins.json` records a user-scope `onionskin@...` install that `~/.claude/settings.json` does not turn off. It removes its own earlier copy there when that copy is identical, and a different one only with `--force` or a yes (`install.sh` passes `--force` when every skill folder is Onionskin's). Anything else installs the folder as before. `doctor` applies the same rule and compares the plugin's copy with the app's; a difference is a `NOTE`, because the plugin follows the repository and the app follows the release. The Codex plugin gets no such skip, because `~/.agents/skills` is shared with other agents, so a Codex user with both sees the skill twice.

Updating: `onionskin update` (`src/update.js`) finds how the running copy was installed. An installer copy (it runs from `~/.onionskin/app/<version>/`) runs the release's `get.sh` exactly as the README one-liner does, so the SHA-256 check stays in `get.sh`; an npm copy prints `npm install -g onionskin-cli` and `onionskin setup --force` (`--yes` runs them); a Homebrew copy (it runs from a keg, `…/Cellar/<formula>/<version>/libexec/lib/node_modules/onionskin-cli`) is told to run `brew upgrade onionskin` and `onionskin setup --force`, with no network request and no flag that updates it, because Homebrew manages its versions; a source checkout (a `.git` beside `package.json`) is told to use git; anything else changes nothing. It first reads `<ONIONSKIN_BASE_URL>/version.txt` (one request; the same URL rule as `get.sh`), so an installed latest version changes nothing, and `--check` stops there. Releases up to 0.0.3 have no `version.txt`: `--check` then says it cannot tell, and `update` installs nothing, since it cannot tell an update from a reinstall or a downgrade (an npm copy still gets its two commands printed). A release must upload `version.txt` beside `get.sh`, `onionskin.zip` and `onionskin.zip.sha256`; `scripts/package.mjs` writes it to `dist-zip/version.txt`. Before installing, it asks a running server for `GET /cli/open-work` (counts of sessions with a tab open now or in the last 20 minutes, unsent edits, draft comments and batches in flight, no file names; edits typed in a tab stay in the tab until Send, so the open tab is the only sign of them) and refuses while any is open, unless `--force`; a server that does not count open tabs is refused like one without the route; otherwise it stops the server as `onionskin stop` does. Nothing checks for an update by itself, and `doctor` never uses the network.

Updating the plugins: `claude plugin marketplace update onionskin`, then `claude plugin update onionskin@onionskin` (a plain `plugin update` alone reports "already at the latest version" until the marketplace is refreshed); `codex plugin marketplace upgrade onionskin` refreshes the Codex copy.

## Commands

`onionskin <file>` (the same as `onionskin open <file>`) opens the file in your browser. A person at a terminal gets Onionskin's own background agent (Claude Code only, on their own Claude plan), started with no question; `--no-agent` only opens the page. `onionskin doctor` checks the install (`--json` for scripts), `onionskin setup` installs the agent skill (`--dry-run`, `--uninstall`, `--force`), `onionskin setup-checker` sets up the deeper checks, `onionskin setup-rewriter [--remove]` turns quick fixes on or off, `onionskin config background ...` changes the page background, `onionskin status <file>` answers at once, `onionskin stop` stops the server. The commands an agent runs in a review (`open`, `poll`, `reply`, `apply`, `commit`, `done`, with the `--lease` ticket) are described in [GUIDE.md](GUIDE.md#install-from-source) and in `skills/onionskin/SKILL.md`. State (sessions, snapshots, the checker's virtual environment) lives in `~/.onionskin/`; `ONIONSKIN_STATE_DIR` changes it. `ONIONSKIN_VOICE_FILE=/path/to/voice.md` points at a voice guide file; the sample is `skills/onionskin/voice.example.md`.

## Feature tour

**Review**
- Comment on a selection, a cell, a range, a shape or a slide. Pins and one overall note go in the same batch.
- Review first: the agent reads the file and suggests changes as cards. Nothing changes until you accept.
- The agent can ask you a question as a card in the panel, and you answer in place.

**Edit while the agent works**
- Word files are merged paragraph by paragraph, including formatting and moved paragraphs. Excel and PowerPoint use a stricter merge that carries your edit only onto a place the agent did not touch.
- Stamps are one-tap requests on a selection: Shorter, Friendlier, Fix grammar, Translate. You can edit them.

**See and undo changes**
- After a run, the new words are drawn in where they stand and the old words show briefly.
- History keeps the last 20 updates with a red and green change view and a "What changed" note. Revert undoes the last run.
- Export a Word file with real tracked changes (checked by opening it in Microsoft Word).

**Work on your Mac**
- Plain quick commands such as "Replace Acme with Initech" run on your Mac with no AI at all, and the Send button shows "Replace in N places".
- Quick fixes: Fix grammar on one sentence is answered on the Mac by Apple's built-in on-device model. It is usually ready by the time you tap. It is shown as a card, and nothing changes until you tap "Use this". Text inside quotation marks, numbers, dates and names are guarded: a suggestion that changes them is withheld. In a small in-house benchmark of 160 sentences we wrote (96 with errors, 64 correct), 72 of the 96 errors got a good fix shown and 3 of the 64 correct sentences got a wrong change shown.

**Make it sound like you**
- Writing preferences, and "Build my voice guide": the agent drafts a 12-section guide, you review it, and nothing is saved without your approval.
- You can also keep your voice guide as a file, `skills/onionskin/voice.md`. It is read like a `.env` file and is never checked in. A sample ships as `voice.example.md`.

The long reference is in [GUIDE.md](GUIDE.md).

## Requirements and limits

- macOS only so far, the only platform tested. Node.js 22 or newer. A browser (the full browser test suite runs in Chrome).
- Claude Code or Codex, already installed and signed in. Onionskin does not include an agent.
- Quick fixes need macOS 26 or later, Apple silicon and Apple Intelligence turned on. Without them, Fix grammar goes to the agent.
- Version 1.0.3. No Windows, no Linux, no real-time collaboration.
- Charts and SmartArt show as placeholders. Fields, content controls and equations are shown read-only. Macro-enabled files (`.docm`, `.xlsm`, `.pptm`) are refused.
- HTML pages (`.html`, `.htm`) open in a still view: scripts never run and nothing loads from the internet; the person edits text and the agent changes structure. Up to 10 MB and 200,000 elements, UTF-8 only. Details in [GUIDE.md](GUIDE.md#html-files).
- Markdown files (`.md`, `.markdown`) open as a preview built from fixed elements (nothing in the file runs or loads), with an Edit mode on the source; every change names an exact range of the source. Up to 1 MB and 20,000 lines, UTF-8 only. Details in [GUIDE.md](GUIDE.md#markdown-files).
- Tests: over 1,800 unit tests and 430 browser tests pass (2026-11-22). A clean-machine test on a second Mac passed: install by the pasted sentence, `onionskin doctor`, and one real round.

## Install, use and test in detail

The full install notes. (The INSTALL.md in the zip is now a short page; everything it used to say is here.)

### What you need

**Required. Onionskin does not work without these:**

| You need | Why | How to check |
|---|---|---|
| A Mac with macOS 13.1 or newer (Safari 16.2+) | Onionskin runs only on macOS (the editor uses `color-mix()`, which needs macOS 13.1 / Safari 16.2 or newer). | Apple menu, About This Mac |
| Node.js 22 or newer | Onionskin is a Node program. The zip contains everything it runs on. The installer downloads one more thing, the deeper-check libraries below, unless you pass `--no-checker`. | `node -v` prints `v22` or higher |
| A web browser | The editor is a web page on your own Mac. | Chrome is the primary tested browser; WebKit/Safari is checked for Office files (`npm run test:webkit`, `npm run test:safari`). HTML files on Safari are untested. |
| Claude Code or Codex, already installed and signed in | The agent makes the edits. Onionskin does not include one. | `claude --version` or `codex --version` prints a version |

**Set up by the installer, and optional to keep:**

| Piece | What it gives you | How it is handled |
|---|---|---|
| Python 3 (3.10 or newer recommended; 3.9, the version Apple's tools provide, was tested and works) | A deeper check of the file after the agent edits it. | `sh install.sh` sets it up for you. It downloads five small Python libraries (lxml, python-docx, openpyxl, python-pptx, defusedxml) from PyPI, the public Python package index, once, into a private folder, `~/.onionskin/venv`. This takes about a minute and does not change your system Python. Nothing from your documents is sent. If it fails (no Python 3, no internet), the installer prints one line saying Onionskin works without deeper checks, keeps the detail in `~/.onionskin/setup-checker.log`, and still finishes. Pass `sh install.sh --no-checker` to skip the download. On a Mac with no developer tools, the installer skips this step instead of opening Apple's install prompt. |
| Quick fixes (optional, off unless you ask) | Quick spelling and grammar fixes for one sentence (the Fix grammar stamp), made on this Mac by Apple's built-in on-device model, without sending anything anywhere. | A Mac with Apple silicon, macOS 26 or newer and Apple Intelligence turned on (System Settings, Apple Intelligence & Siri). Nothing is downloaded: `sh install.sh --rewriter` turns it on, or ask your agent to run `onionskin setup-rewriter`; `onionskin setup-rewriter --remove` turns it off. On any other Mac, or when it is off, Fix grammar goes to the agent as before, and `onionskin doctor` says why. A failure never fails the install. |
| LibreOffice (optional, not installed for you) | A second check that the edited file still opens. | `brew install --cask libreoffice` |

If the deeper checks are off (you used `--no-checker`, or the setup failed), everything still works. The review panel shows "Basic checks passed. Deeper checks are off." under the newest agent run, with a "Turn on deeper checks" button that downloads the same five libraries. You can also ask your agent to turn them on.

**What was tested:** the install was rehearsed on macOS 27.2 with Node 26.13 and Google Chrome, signing in nothing and using a fresh empty home folder. macOS 13.1 to 26, Node 22 to 25, and other browsers are expected to work but have not been tried. Claude Code and Codex have each been run end to end by a real agent (Claude Code: Word, Excel, PowerPoint, a protected Word file and a hostile Word file; Codex: real runs, most recently on build 8, where a table row was added about 26 s after Send, in one run). WebKit (`npm run test:webkit`) and a real Safari smoke check (`npm run test:safari`) are run for Office files; HTML files on Safari are untested.

#### Installing Node.js (only if `node -v` fails or prints less than v22)

Pick one route.

- **Official installer:** go to https://nodejs.org/en/download, download the macOS Installer (.pkg), open it and click through. Then open a new Terminal window.
- **Homebrew** (only if you already use it): `brew install node`

You should see: `node -v` prints a version starting with `v22` or higher.

### Install

1. Unzip the release zip. Double-click it in Finder; a folder named `onionskin` appears next to it.
2. Open Terminal (press Command-Space, type `Terminal`, press Return).
3. Go into the folder. Replace the path with wherever the folder is (dragging the folder onto the Terminal window types its path for you):

   ```sh
   cd ~/Downloads/onionskin
   ```

4. Run the installer:

   ```sh
   sh install.sh
   ```

   You should see: `node: v... ok`, then `Installing Onionskin ...`, lines saying the two skill folders were installed, a `Deeper checks` step (`done`, `already set up`, or one line saying Onionskin works without them), and `Done.` at the end.

   It needs no password and no `sudo`. It copies the app to `~/.onionskin/app/<version>/`, creates one small command at `~/.local/bin/onionskin`, and installs the agent skill into `~/.claude/skills/onionskin` and `~/.agents/skills/onionskin`. It changes nothing else. The last step downloads the five deeper-check libraries from PyPI (about a minute; skip it with `sh install.sh --no-checker`). To preview without changing anything: `sh install.sh --dry-run`. To upgrade later: run `onionskin update` (or unzip the new zip and run `sh install.sh` again). If Onionskin is still running, the installer stops it first; your open sessions are kept and it starts again on the next command.

5. Optional: if the installer said `~/.local/bin` is not on your PATH, your agent still finds Onionskin by its full location. To type `onionskin` yourself, paste the `echo ... >> ~/.zshrc` line it showed, then open a new Terminal window. (Until then, use the full path, `~/.local/bin/onionskin`, wherever this guide says `onionskin`.)

### Check that it works

In a new Terminal window:

1. ```sh
   onionskin --version
   ```
   You should see: a version number such as `1.0.3`.

2. ```sh
   onionskin setup --dry-run
   ```
   You should see: `node ...: ok`, and for each of the two skill folders `already up to date`.

3. ```sh
   onionskin ~/.onionskin/app/*/samples/sample.docx
   ```
   You should see: your browser opens a page with a Word document in it, and the Terminal prints `Opened sample.docx in your browser.`, a `http://127.0.0.1:...` link, and one line: `Claude Code is starting in the background to work on this file with you. Press Send in the page when you are ready.` (or where to get Claude Code if it is not installed). There is no question to answer. For this check you do not need to press Send. (`samples/` also holds `sample.xlsx`, `sample.pptx` and `sample.html`.) Close the browser tab when done, then run `onionskin stop` (it also stops the background agent).

4. For a full status report (versions, skill folders, optional parts):

   ```sh
   onionskin doctor
   ```
   You should see a list of lines starting with `OK`, `MISSING` or `NOTE`. `MISSING` on a required item needs fixing, and the line ends with the command that fixes it (the command also exits 1 then). `NOTE` on an optional item is fine. `onionskin doctor --json` prints the same result for scripts.

### Use it

**In a terminal:** type `onionskin` and the file:

```sh
onionskin path/to/your-file.docx
```

The file opens in your browser, and Onionskin starts its own background agent on it (Claude Code, on your own Claude plan; it needs Claude Code installed and signed in). On a Mac with Codex but no Claude Code, the terminal says so and tells you to ask Codex. (Add `--no-agent` to only open the page.)

**Already in Claude Code:** say:

```
open path/to/your-file.docx in Onionskin
```

**Already in Codex:** say the same:

```
open path/to/your-file.docx in Onionskin
```

(Codex has been run end to end in real agent runs, most recently on build 8, where a table row was added about 26 s after Send, in one run. If it does not pick the skill up, tell it to read `~/.agents/skills/onionskin/SKILL.md` first.)

What happens next:

1. Your browser opens with the file. Use the mode buttons: **Edit** types straight into the document, **Comment** comments on whatever you click (drag across cells for a range), **Pin** drops a numbered pin. Write one overall instruction in the note box if you like.
2. Press **Send to Agent**. The page shows what the agent is doing (with a server that reports stages: it has your batch, writing your changes, checking the file; otherwise "Agent is working"). You can keep editing: what you change is merged with the agent's changes when it finishes.
3. The agent changes the file and reports back. The page reloads at the same place with an activity entry, an answer for each comment, and a **Revert** button if the check found damage.

Your original is kept: Onionskin saves a copy before the agent writes, and the folder `~/.onionskin` holds those snapshots.

### Try it

Use `samples/sample.docx`, `samples/sample.xlsx`, `samples/sample.pptx` or `samples/sample.html` (inside `~/.onionskin/app/<version>/`), or a copy of one of your own files (work on copies).

1. Open the file with `onionskin <file>` in a terminal, or say "open <file> in Onionskin" in Claude Code or Codex.
2. Make a typed edit in the document, comment on a selection (or click a cell or a shape in Comment mode), drop a pin, and type an overall instruction in the note box.
3. Press **Send to Agent**. The page reloads with an answer for each comment.
4. Open the edited file in Word, Excel, PowerPoint or a browser to see the result. Press **Revert** to put the file back as it was.
5. When you are done, close the page and run `onionskin stop`.

If the page says **no agent is listening**, the agent has not started waiting for you. Press **Start the agent** in that message and Onionskin starts its background agent (Claude Code only, on your own Claude plan; it also starts by itself about 20 seconds after a Send nobody took). Or go to your Claude Code or Codex session and say "open <file> in Onionskin". Your comments are kept: the agent picks up the batch you already sent.

If something looks wrong, run `onionskin doctor` (it holds no tokens or document names, and shows your home folder as `~`) and open an issue with its output.

### Change the background

Click the picture icon in the top bar (on a phone: the three dots, then Background). Pick a preset, or "Choose image..." for one of your own pictures (PNG, JPEG, WebP, up to 15 MB; you can also drop a file on the picker). The light and dark themes keep working with every choice. The choice is saved on this computer and shows in every document.

From Terminal: `onionskin config background midnight`, `onionskin config background default`, `onionskin config background --image ~/Pictures/desk.jpg --strength 50`, `onionskin config get background`. Reload the page to see a change made this way.

### Troubleshooting

| What you see | What to do |
|---|---|
| `onionskin: command not found` | `~/.local/bin` is not on your PATH. Run `echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc`, open a new Terminal window. Or run `~/.local/bin/onionskin` directly. |
| The installer says Node is missing or too old | Follow "Installing Node.js" above, open a new Terminal window, run `sh install.sh` again. Nothing was changed by the failed run. |
| The browser did not open | Copy the `http://127.0.0.1:...` link from Terminal into your browser. The link works once, within a minute; if it expired, run `onionskin <file>` again. |
| `could not start the Onionskin server` or a socket error | Run `onionskin stop`, then try again. If it keeps happening, check that `~/.onionskin` belongs to you (`ls -ld ~/.onionskin`) and that your home folder is not on a network drive. |
| The review panel says "Deeper checks are off." | The setup was skipped or could not finish. Press "Turn on deeper checks" under the newest agent run (it needs internet once), or ask your agent to turn them on. `~/.onionskin/setup-checker.log` has the detail from the installer run. |
| A `.docm`, `.xlsm` or `.pptm` file is refused | By design: macro files are not opened. Save a copy as `.docx`, `.xlsx` or `.pptx`. |
| A `.mhtml`, `.webarchive`, `.xhtml` or `.svg` file, or a page not saved as UTF-8, is refused | The sentence says what to do. The full list is in [GUIDE.md](GUIDE.md#files-that-are-refused). |
| The agent does not know Onionskin | Run `onionskin setup`, then start a new agent session. Check `ls ~/.claude/skills/onionskin` (Claude Code) or `ls ~/.agents/skills/onionskin`. |
| Something else | Run `onionskin doctor` and send back the output. Each failing line ends with the command that fixes it. (The old `scripts/install-check.mjs` still works and does the same.) |

### Uninstall

```sh
sh ~/.onionskin/app/*/install.sh --uninstall
```

(Or `sh install.sh --uninstall` from the unzipped `onionskin` folder.) This removes the `onionskin` command, the app copy, and the two skill folders. It keeps `~/.onionskin` (snapshots of your files and the optional checker environment) and never touches your documents. To remove those too, add `--purge`. Node.js, Python and LibreOffice are not removed.

An npm install is removed with `onionskin setup --uninstall`, then `npm uninstall -g onionskin-cli`. The plugins are removed with `claude plugin uninstall onionskin@onionskin` and `codex plugin remove onionskin@onionskin`; that removes the skill only, not the command.

### The helper for quick fixes

The zip carries one small program, `scripts/rewriter/apple/onionskin-fm`, that talks to Apple's on-device model for the Fix grammar stamp. macOS marks programs that come from a download and would stop this one, so the installer clears that mark on this one file, and on nothing else. Nothing is downloaded for this feature: the model is Apple's and is part of macOS. If an earlier version of Onionskin downloaded a writing helper into `~/.onionskin`, the installer (or `onionskin setup-rewriter`) removes that download once, only the folders and the settings file it created, and prints one line saying how much space that freed. If quick fixes were on, they are off after that until you turn them on again with `sh install.sh --rewriter` or `onionskin setup-rewriter`.

### Privacy

The editor and the Onionskin server run on this Mac. The server listens on 127.0.0.1 only (not reachable from other computers), and the page makes no requests to any other site. Onionskin has no account, no telemetry and no automatic update check: it looks for a new release only when you run `onionskin update`. Your document's text goes to the coding agent you already use (Claude Code or Codex) when you press Send, under that agent's own privacy terms, and every batch carries the text of the whole document, not only the part you commented on, because the agent needs it to find the right place. Only quick fixes and the no-AI quick commands stay entirely on this Mac. Quick fixes use the model built into macOS, through a small helper that runs with the network cut off: the sentence goes to Apple's on-device model on this Mac and nowhere else. Onionskin itself uses the network only to download the five Python libraries listed above from PyPI, by `install.sh` (unless `--no-checker`), by `onionskin setup-checker`, or by the "Turn on deeper checks" button, and, when you run `onionskin update`, to read the latest release's `version.txt` (one request that sends nothing about you or your files) and download that release. Nothing from your documents goes with either download.

### What still runs on the server's thread

Opening a file, the checks at the end of a run, History, the tracked-changes copy, learning and merging what you typed while the agent worked run in worker threads with time and memory limits (`src/offload.js`). So does the document reading and anchor work of a request (`src/anchor-work.js`, in warm workers: `src/anchor-worker.js`, `anchorsOffThread`): reading the bytes of a Send within the readers' caps, building every anchor of a Send and of a comment queued during a run, moving queued and waiting comments onto a new version at `done` and Revert, a review's cards, `POST /api/resolve`, a quick fix's placement (`/api/suggest`) and its Use, and the outline an agent Onionskin started receives (built at Send, `done` and before a poll's delivery). The server's routes call the async methods (`sendAsync`, `doneAsync`, `revertAsync`, `resolveAllAsync`, `useSuggestionAsync`): the worker first, then the synchronous method commits with what came back and reads nothing itself. At most three such workers run at once, one is kept warm, a job has 60 s, and one that does not finish leaves its comments weaker (an Excel anchor keeps its sheet and address with no hash, a Word or PowerPoint one is "unresolved location" with the selected words), never lost. The synchronous methods tests call still do this work on the caller's thread, under the request budget (`scanBudget`, 40 million); the worker has ten times that budget as a second line (all of it took 0.4 to 1.3 s of CPU at a load average of 20).

What one request keeps is cut where it is stored (`src/retain.js`): 20,000 characters per string field of an anchor, 48 KB per anchor, 128 KB per comment, 64 MB per session file (the writer cuts further past it), 32 MB for a request's own comments, note and edits (refused past it, with a plain message). Measured ordinary use stays far under them: 500 comments on 1,000 x 20 Excel ranges make a 9.4 MB session (11 KB per anchor), 500 whole-paragraph Word comments on paragraphs of 3,000 to 6,000 characters 6.2 MB (15 KB per comment).

This is the work proportional to the size of a document that still runs on the server's own thread, with its worst case at the readers' caps. "This round" numbers are this thread's CPU time (`process.threadCpuUsage`) measured on 2026-11-17 at a load average of about 20; the others are /health waits measured in earlier rounds of review.

| Work on the thread | Where | Worst case measured | What bounds it |
|---|---|---|---|
| What a request's anchors still cost here: matching the worker's answers to their tasks, the batch (each anchor's evidence sanitized), writing the session file | Send, `done`, Revert, resolve, quick fixes | The stress matrix at the reviews' sizes (e2e/stress-matrix.e2e.test.js, 500 comments each): at most 243 ms (a comment queued on 500 overlapping 1,000 x 40 ranges of long labels), 208 ms (1,000-character number formats), under 35 ms for every Word and PowerPoint case. This round | The stored caps above; 500 comments |
| Reading a version whole when it is not the one read last (`unitsFor`, `readWhole`) | Review, an agent's write, a local reply, the quick preview and quick change; the outline at a delivery when it was not built ahead (a synchronous caller, or a file changed in between) | A Word file at the text cap (8 million CJK characters): 1.2 s (earlier round). A 1,600-page Word Send, before Send moved: /health waited 0.39 s (earlier) | The readers' caps; a version read once is reused for a minute. Upgrade path: the anchor worker's pattern |
| The editing engine | Quick preview, a quick change on this Mac, a local `apply` (`src/local.js`) | One paragraph of 199,995 runs: /health waited 1.1 to 1.3 s (earlier) | The caps; loops yield every 40 ms. Upgrade path: the merge worker's pattern |
| Hashing, the package check and the write (`cp -p`, the ACL check), copying a Send's bytes to the anchor worker | Send, open, revert, an agent write, a merge's result | A 200 MB file: Send 0.85 s, revert 0.6 s, open 0.23 s of /health waiting (earlier) | 200 MB per file |
| What a merge still does on the thread: decoding the page's bytes, three hashes, the package check, copying the three versions to the worker, writing the result | `POST /api/merge` | The reviewer's three merges at the caps (Word 3,900 x 2,000 characters, Excel 1,000,000 cells, a deck shape of 25,000 lines): /health waited 14 to 50 ms (earlier, e2e/stall-cap.e2e.test.js) | 200 MB per file |

### What the merge proof compares

After every merge, `src/merge-proof.js` checks the result from the bytes of the four versions (`src/merge-package.js` reads them): every difference between the base and the person's version is in the result or handed back by name, else nothing is written. The table lists every place where that reading does not compare content as written, and why that cannot hide a person's change. "Mutation" names the test in `test/merge-proof-mutation.test.js` (round 7) that changes exactly that content: in the person's version, where the proof must see it and the merge must say it; in a correct result, for an equivalence, where the proof must accept it.

One rule for VOLATILE content (xml:space, `a:rPr` lang and dirty, `calcPr` fullCalcOnLoad: what the engine rewrites on its own when it writes a unit), written once in `sameVolatile`: a difference in it between base and mine is the person's, and only the same counts in the result; the engine's rewrite is allowed only where the person left it as base had it (between mine and the result on what the merge wrote for them, and between the agent's version and the result). A character the person typed takes the run properties of the text it was typed into.

| Place | What was abstracted | What it is now | Mutation |
|---|---|---|---|
| `walkCanonical`: names | namespace prefixes | Equivalence: a name is its namespace URI and local name (XML Namespaces) | accepted |
| `walkCanonical`: attributes | their order | Equivalence: attribute order is not content in XML | accepted |
| `walkCanonical`: text | entities | Equivalence: decoded, the same characters | accepted |
| `walkCanonical`: comments, processing instructions | dropped | Equivalence: no Office program reads them inside a package part | accepted |
| `walkCanonical`: white space between elements | dropped | Equivalence in OOXML (no mixed content); kept as written in custom data (`customXml/`), which may be mixed content | caught |
| `walkCanonical`: xml:space | dropped everywhere | Kept, the VOLATILE rule; a `w:t` that does not keep an edge space is a token of its paragraph | caught (header text; body text) |
| `walkCanonical`: `a:rPr` lang, dirty | dropped | Kept, the VOLATILE rule (a proofing language en-US to fr-FR is the person's) | caught (lang; dirty) |
| `walkCanonical`: `calcPr` fullCalcOnLoad | dropped | Kept, the VOLATILE rule | caught |
| `walkCanonical`: an empty `w:rPr`, `a:rPr`, `calcPr` | read as absent | Equivalence: an empty property list sets nothing; a `calcPr` without attributes holds the defaults | accepted |
| `walkCanonical`: `w:proofErr` | dropped | Exemption, kept: the spell checker's marks, no text or formatting, recomputed by Word on open; the engine moves them differently for two edits that give the same text (measured on delins.docx and 52449.docx), so counting them would hand back ordinary typing | exemption (not handed back) |
| `keyedUnits`: the root's own text | dropped | A unit by where it stands (an outside review: custom data's value was lost) | caught |
| `keyedUnits`: order of children without an identity | not compared | A unit, `@order` (a header's paragraph and table swapped) | caught |
| `keyedUnits`: order of children with an identity, in the collections named in `UNORDERED`: a `.rels` part's `Relationship` and `[Content_Types].xml`'s `Default` and `Override` (OPC: found by Id, extension or part name; neither list has an order), `w:style` in styles.xml, `w:abstractNum` and `w:num` in numbering.xml, `w:comment`, `w:footnote`, `w:endnote` in their parts (the body names each by its id), `w:font` in fontTable.xml (found by name) | not compared | Equivalence: each is found by its identity wherever it stands | accepted |
| `keyedUnits`: order of children with an identity anywhere else (custom data's `<item id="a">`, `<item name="a">`) | not compared (round 8: custom data reversed was merged as no change) | Kept in `@order` like any other child: in custom data the order is the data's own | caught (id; name) |
| `walkCanonical`: on/off spellings of a `w:rPr` or `w:pPr` property (`w:b`, `w:i`, `w:strike`, `w:caps`, the others of CT_OnOff in `ON_OFF`) and `a:rPr` `b` and `i` | compared as written (round 8: `<w:b w:val="true"/>` against the merge's `<w:b/>` refused an ordinary merge) | Equivalence: on is no `w:val`, `true`, `1` or `on`; off is `false`, `0` or `off`, written one way each. Written off stays an element, never read as absent (a style may turn the property on) | accepted (true, 1, on); caught (off where the style is bold) |
| `keyedUnits`, `readPackage`: a unit, a binary part, a part that is not well-formed XML | a SHA-1 of it | Literal: the hash of all of it | (existing: pictures, parts) |
| `partsCheck`: parts stored the same | not read | Literal: the same stored bytes are the same content | n/a |
| `partsCheck`: `sldIdLst` | skipped | Which slides and their order: the slide checks; each `p:sldId`'s attributes: compared | through the sheet list row (same code) |
| `partsCheck`: the workbook's `sheets` | skipped | Name, id, state: the sheet checks (state as written: hidden and very hidden are two); anything else on a `<sheet>`: compared | caught (state; another attribute) |
| `partsCheck`: the style lists (fonts, fills, borders, numFmts, cellStyleXfs, cellXfs) | read only through cells | Resolved at every place that uses them (cells, rows, columns, a phonetic run's font); a definition changed in place or removed is handed back whatever references it (the engine only appends to these lists, measured) | caught (column; row) |
| `docxUnits`: a counted tab or line break | its tag dropped | Its attributes are a token where it stands (`w:br w:clear="all"`) | caught |
| `docxUnits`: run boundaries | not compared | Equivalence: two runs with the same properties side by side read as one | accepted |
| `docxUnits`: a run without text | its properties count nowhere | Equivalence: no character, nothing shown | n/a |
| `docxUnits`: `w14:paraId`; a paragraph's own attributes for added paragraphs and in the agent's direction | not compared | Identity and revision stamps (rsid, textId): none is shown | n/a |
| `proveDocx`: a paragraph's style | its name, lowercased | The `w:pStyle` as written (the definitions are compared in styles.xml) | caught |
| `proveDocx`: alignment | the reader's value | The `w:jc` as written | (existing alignment tests) |
| `proveDocx`: a list | its kind and level | The `w:numPr` as written, its numId as the definition it names; numId 0 as "off" | caught (definition; numId 0) |
| `proveDocx`: a list's numbering continuity | not compared | Ceiling, not fixed: it depends on the other side's lists (a numbered paragraph the agent adds above renumbers the person's; comparing it refused that ordinary merge, measured), so a list restarted on the same definition is not seen. Upgrade path: compare it against the list paragraphs base, mine and the result all have | missed (known) |
| `docxUnits`, `slideUnits`: runs of paragraphs or top-level shapes in the skeleton | one mark | Each paragraph and shape is a unit of its own, in order | n/a |
| `slideUnits`: shapes in a group | one mark, deduplicated | One mark per shape with its id | caught (also on 3f29ce5, by order) |
| `sharedRich`: a shared string's text | its length | The value check reads the main text; a phonetic run's text is compared as written, its font resolved | caught (reading; font) |
| `sheetUnits`: a cell's value, formula text, storage (`t`) | not in the residue | The value check compares kind and text | n/a |
| `sheetUnits`: a formula's cached value | not compared | Exemption: never typed; the page computes it when it saves (measured on a real page save: `<v></v>` became `<v>4517</v>`) | n/a |
| `proveXlsx`: a shared formula's child | "shared" | Exemption: no text of its own; the group's formula is compared at its first cell and its `si` in the residue | n/a |
| `sheetUnits`: an absent cell | style 0 | The style it shows: its row's (customFormat), else its column's, else 0 | caught |
| `sheetUnits`: a cell written twice | the last one | Both | caught (also on 3f29ce5) |
| `sheetUnits`: row and column styles | the index | The definition it names | caught (also on 3f29ce5) |
| `sameResidue`: a token inside a changed span | anywhere in that span on both sides | Ceiling, not fixed: where the texts differ, which side of a retyped span a mark stands on is not defined by the texts; a mark the person moved inside a span they also retyped is not seen. Upgrade path: compare the marks' order against the typed characters | missed (known) |
| `handedBack`: a text cut at 2,000 characters | its start | Counts only with a copy of the person's file; the merge keeps one whenever a text was cut | caught |
| `handedBack`: an entry naming a unit covers its formatting | any entry | Kept: the person is told about that unit | n/a |
| `handBack`: a change an entry already names for its whole slide or sheet, without a copy | a second line | The copy is kept instead, only when that entry speaks of the same kind (formatting, layout, shapes): a browser test found a bold said twice; a column width next to it is still said | browser regression and same-kind tests |
| `provePptx`, `proveXlsx`: slides and sheets only the agent has | text and values | Their parts compared whole but for VOLATILE | caught |
| `account`, `runsCheck`: mine's run properties in the result | equal only | Also the engine's paired properties (b with bCs, i with iCs, sz with szCs, rFonts with eastAsia and cs) where they act on nothing: mine has the first alone, the twin is added at its value, the run says no rtl, cs or eastAsia hint, the character is below U+0590 | LOW 5 tests (Latin merged; Hebrew handed back) |

41 places in all: 21 changes of the person's version, 8 equivalences and 2 exemptions run as mutations; 17 of the 21 were missed on 3f29ce5. Known misses: a list's numbering continuity and the changed-span ceiling of `sameResidue`.
