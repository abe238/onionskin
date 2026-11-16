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
- Version 0.0.3, an early release. One person has tested it. No Windows, no Linux, no real-time collaboration.
- Charts and SmartArt show as placeholders. Fields, content controls and equations are shown read-only. Macro-enabled files (`.docm`, `.xlsm`, `.pptm`) are refused.
- Tests: over 1,000 unit tests and 300 browser tests pass (2026-11-13). A clean-machine test on a second Mac passed: install by the pasted sentence, `onionskin doctor`, and one real round.

## Install, use and test in detail

The full install notes. (The INSTALL.md in the zip is now a short page; everything it used to say is here.)

### What you need

**Required. Onionskin does not work without these:**

| You need | Why | How to check |
|---|---|---|
| A Mac with macOS 13 or newer | Onionskin runs only on macOS. | Apple menu, About This Mac |
| Node.js 22 or newer | Onionskin is a Node program. The zip contains everything it runs on. The installer downloads one more thing, the deeper-check libraries below, unless you pass `--no-checker`. | `node -v` prints `v22` or higher |
| A web browser | The editor is a web page on your own Mac. | Chrome is the browser that was tested. Safari and others are untested. |
| Claude Code or Codex, already installed and signed in | The agent makes the edits. Onionskin does not include one. | `claude --version` or `codex --version` prints a version |

**Set up by the installer, and optional to keep:**

| Piece | What it gives you | How it is handled |
|---|---|---|
| Python 3 (3.10 or newer recommended; 3.9, the version Apple's tools provide, was tested and works) | A deeper check of the file after the agent edits it. | `sh install.sh` sets it up for you. It downloads five small Python libraries (lxml, python-docx, openpyxl, python-pptx, defusedxml) from PyPI, the public Python package index, once, into a private folder, `~/.onionskin/venv`. This takes about a minute and does not change your system Python. Nothing from your documents is sent. If it fails (no Python 3, no internet), the installer prints one line saying Onionskin works without deeper checks, keeps the detail in `~/.onionskin/setup-checker.log`, and still finishes. Pass `sh install.sh --no-checker` to skip the download. On a Mac with no developer tools, the installer skips this step instead of opening Apple's install prompt. |
| Quick fixes (optional, off unless you ask) | Quick spelling and grammar fixes for one sentence (the Fix grammar stamp), made on this Mac by Apple's built-in on-device model, without sending anything anywhere. | A Mac with Apple silicon, macOS 26 or newer and Apple Intelligence turned on (System Settings, Apple Intelligence & Siri). Nothing is downloaded: `sh install.sh --rewriter` turns it on, or ask your agent to run `onionskin setup-rewriter`; `onionskin setup-rewriter --remove` turns it off. On any other Mac, or when it is off, Fix grammar goes to the agent as before, and `onionskin doctor` says why. A failure never fails the install. |
| LibreOffice (optional, not installed for you) | A second check that the edited file still opens. | `brew install --cask libreoffice` |

If the deeper checks are off (you used `--no-checker`, or the setup failed), everything still works. The review panel shows "Basic checks passed. Deeper checks are off." under the newest agent run, with a "Turn on deeper checks" button that downloads the same five libraries. You can also ask your agent to turn them on.

**What was tested:** the install was rehearsed on macOS 27.2 with Node 26.13 and Google Chrome, signing in nothing and using a fresh empty home folder. macOS 13 to 26, Node 22 to 25, and other browsers are expected to work but have not been tried. Claude Code and Codex have each been run end to end by a real agent (Claude Code: Word, Excel, PowerPoint, a protected Word file and a hostile Word file; Codex: real runs, most recently on build 8, where a table row was added about 26 s after Send, in one run). Safari is untested.

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

   It needs no password and no `sudo`. It copies the app to `~/.onionskin/app/<version>/`, creates one small command at `~/.local/bin/onionskin`, and installs the agent skill into `~/.claude/skills/onionskin` and `~/.agents/skills/onionskin`. It changes nothing else. The last step downloads the five deeper-check libraries from PyPI (about a minute; skip it with `sh install.sh --no-checker`). To preview without changing anything: `sh install.sh --dry-run`. To upgrade later: unzip the new zip and run `sh install.sh` again. If Onionskin is still running, the installer stops it first; your open sessions are kept and it starts again on the next command.

5. Optional: if the installer said `~/.local/bin` is not on your PATH, your agent still finds Onionskin by its full location. To type `onionskin` yourself, paste the `echo ... >> ~/.zshrc` line it showed, then open a new Terminal window. (Until then, use the full path, `~/.local/bin/onionskin`, wherever this guide says `onionskin`.)

### Check that it works

In a new Terminal window:

1. ```sh
   onionskin --version
   ```
   You should see: a version number such as `0.0.3`.

2. ```sh
   onionskin setup --dry-run
   ```
   You should see: `node ...: ok`, and for each of the two skill folders `already up to date`.

3. ```sh
   onionskin ~/.onionskin/app/*/samples/sample.docx
   ```
   You should see: your browser opens a page with a Word document in it, and the Terminal prints `Opened sample.docx in your browser.`, a `http://127.0.0.1:...` link, and one line: `Claude Code is starting in the background to work on this file with you. Press Send in the page when you are ready.` (or where to get Claude Code if it is not installed). There is no question to answer. For this check you do not need to press Send. (`samples/` also holds `sample.xlsx` and `sample.pptx`.) Close the browser tab when done, then run `onionskin stop` (it also stops the background agent).

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

Use `samples/sample.docx`, `samples/sample.xlsx` or `samples/sample.pptx` (inside `~/.onionskin/app/<version>/`), or a copy of one of your own files (work on copies).

1. Open the file with `onionskin <file>` in a terminal, or say "open <file> in Onionskin" in Claude Code or Codex.
2. Make a typed edit in the document, comment on a selection (or click a cell or a shape in Comment mode), drop a pin, and type an overall instruction in the note box.
3. Press **Send to Agent**. The page reloads with an answer for each comment.
4. Open the edited file in Word, Excel or PowerPoint to see the result. Press **Revert** to put the file back as it was.
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

The editor and the Onionskin server run on this Mac. The server listens on 127.0.0.1 only (not reachable from other computers), and the page makes no requests to any other site. Onionskin has no account, no telemetry and no update check. Your document's text goes to the coding agent you already use (Claude Code or Codex) when you press Send, under that agent's own privacy terms, and every batch carries the text of the whole document, not only the part you commented on, because the agent needs it to find the right place. Only quick fixes and the no-AI quick commands stay entirely on this Mac. Quick fixes use the model built into macOS, through a small helper that runs with the network cut off: the sentence goes to Apple's on-device model on this Mac and nowhere else. Onionskin itself uses the network only to download the five Python libraries listed above from PyPI, by `install.sh` (unless `--no-checker`), by `onionskin setup-checker`, or by the "Turn on deeper checks" button. Nothing from your documents goes with that download.
