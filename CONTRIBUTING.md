# Contributing to Onionskin

Thanks for looking. Bug reports, ideas and pull requests are welcome. For anything bigger than a small fix, open an issue first so we can agree on the shape before you spend time on it.

## Before you report a bug

Run `onionskin doctor` and paste its whole output into the issue. It checks the install and prints one line per check. Its output is safe to paste. Also say which agent you use (Claude Code or Codex), which file type (Word, Excel or PowerPoint) and what you expected.

Please use only documents you are happy to share, or a synthetic one that shows the same problem.

## Build and run from source

You need Node.js 22 or newer. Real Google Chrome is needed only for the browser tests. The command and the server run on plain `node`.

```sh
git clone https://github.com/abe238/onionskin onionskin && cd onionskin
npm install
npm run build:web          # the React app and the bundled engine -> web/dist
npm link                   # puts `onionskin` on your PATH
onionskin setup            # installs the agent skill into ~/.claude/skills and ~/.agents/skills
onionskin doctor
```

State (sessions, snapshots) lives in `~/.onionskin/`. Set `ONIONSKIN_STATE_DIR` to point elsewhere, for example while testing.

Python is used for test fixtures and the optional deeper check:

```sh
python3 -m venv .venv && .venv/bin/pip install -r scripts/requirements.txt
```

## Run the tests

While you work, run only the tests for the code you changed:

```sh
node --test --test-force-exit test/quick.test.js            # one unit file
node --test --test-force-exit test/merge.test.js test/history.test.js
node --test --test-force-exit --test-timeout=240000 e2e/apply.e2e.test.js   # one browser test (build the web app first)
```

The suite has over 1,000 unit tests and 300 browser tests. Run the full suite once, on your final code, before you open a pull request:

```sh
npm test    # verifies the vendored engine, builds the web app, runs unit then browser tests, then fails if any repo file changed
```

Useful variants: `node scripts/run-tests.mjs unit` for unit tests only, `node scripts/run-tests.mjs e2e` for browser tests only. The real Office sample files the tests use are downloaded by checksum with `node scripts/fetch-fixtures.mjs`; a missing one is a skip with a printed reason locally and a failure under `CI`.

## How the agent starts (developer notes)

People start Onionskin with `onionskin report.docx` in a terminal or by saying "open report.docx in Onionskin" to Claude Code or Codex. Underneath, an agent runs `onionskin open <file>` and then `onionskin poll <file>` to wait for the person's Send; the commands are in [docs/GUIDE.md](docs/GUIDE.md) and `skills/onionskin/SKILL.md`. From a terminal, `src/agent-runner.js` starts a background Claude Code agent (Claude Code only); `src/agent-detect.js` finds Claude Code and Codex. Tests never start a real agent unless they opt in with `ONIONSKIN_AGENT_PATH`; `ONIONSKIN_AGENT_CLI=none` turns the background agent off.

## Conventions found in this repo

- Plain JavaScript as ES modules (`"type": "module"`), on Node 22 or newer. The command and server have no run-time dependencies; if you think you need one, say why in the issue.
- Tests use the built-in `node:test` runner and `node:assert/strict`, one file per area in `test/` and `e2e/`. A non-trivial change comes with a test that fails if the logic breaks.
- Tests write only to temporary folders, never to tracked files or to your real `~/.onionskin`. `npm test` ends by failing if any repo file changed, so check `git status` before and after.
- The product name and binary name live in `src/constants.js` only.
- The page makes no outside requests and runs under a strict content security policy. A browser test fails on any policy violation or uncaught page error. Do not add a script, font or image from another host.
- Anything the agent skill (`skills/onionskin`) names, such as a command, a flag or a field, is checked against the code by `test/skill-docs.test.js`. Change them together.
- Never overwrite a user's file in place. Writes go through the checked write path in `src/fsutil.js` and `src/apply.js`, with a lock and a snapshot.
- Words people read (page text, errors, docs) use plain US English and short sentences.
- The vendored engine under `vendor/` is never edited by hand. `npm run verify:vendor` checks it against `vendor/engine.lock.json`. If you need an engine change, open an issue first.

## Pull requests

1. Branch from `main`.
2. Keep the change small and focused. Do not reformat code you did not change.
3. Run the targeted tests while you work and the full suite once at the end.
4. Fill in the pull request template: what changed, why, and how you checked it.

## Code of conduct

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
