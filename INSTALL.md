# Installing Onionskin

Paste this sentence into Claude Code or Codex:

> Install Onionskin from https://github.com/abe238/onionskin

Your agent does the rest. Prefer to do it yourself? Open a terminal in this folder and run `sh install.sh`. Other ways to install (npm, Claude Code and Codex plugins) are in the README.

## Check it worked

Run `onionskin doctor` (or `~/.local/bin/onionskin doctor` if the command is not found). A line that starts with `MISSING` ends with the command that fixes it.

## Start

Say to your agent: **open report.docx in Onionskin**. Or type `onionskin report.docx` in a terminal. Onionskin opens `.docx`, `.xlsx`, `.pptx`, `.html`, `.htm`, `.md` and `.markdown` files.

Your file opens in the browser. Edit, comment, drop a pin, then press **Send to Agent**. The changes appear in the document.

## Update

Run `onionskin update` (or `~/.local/bin/onionskin update`). It downloads the latest release, checks it and installs it. While a file is open in a browser tab (or was in the last 20 minutes) it stops and says so: press Close session in the file's page (or close its tab and wait 20 minutes), or run `onionskin update --force`. Your snapshots are kept. `onionskin update --check` only says whether there is a newer one.

## Uninstall

Run `sh ~/.onionskin/app/*/install.sh --uninstall`. Your snapshots stay in `~/.onionskin`; add `--purge` to delete them too.

## What you need

A Mac, Node.js 22 or newer (https://nodejs.org/en/download), a browser, and Claude Code or Codex already installed and signed in.
