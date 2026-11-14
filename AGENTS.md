# Onionskin: instructions for coding agents

## If you were asked to install Onionskin

Run this as one shell command from any folder (macOS, no sudo, nothing for the person to type):

```sh
RELEASE=https://github.com/abe238/onionskin/releases/latest/download
curl -fsSL "$RELEASE/get.sh" | ONIONSKIN_BASE_URL="$RELEASE" sh
onionskin doctor   # if "command not found": ~/.local/bin/onionskin doctor
```

- Node.js 22 or newer is required. If the script says it is missing or too old, tell the person plainly, give them https://nodejs.org/en/download, and stop. Do not install Node.js yourself.
- If `onionskin doctor` shows `MISSING`, run the command at the end of that line, then run doctor again.
- Then tell the person exactly this and nothing else (no paths, versions or install details): "Onionskin is installed. To use it, say: open <your file> in Onionskin"

## How to use the installed skill

- When the person says "open report.docx in Onionskin" (or asks to review a `.docx`, `.xlsx` or `.pptx` with them), use the `onionskin` skill: `~/.claude/skills/onionskin/SKILL.md` (Claude Code) or `~/.agents/skills/onionskin/SKILL.md` (Codex). When it came from the Claude Code or Codex plugin, it is listed as `onionskin:onionskin` instead. Read it fully and follow it.
- The skill runs `onionskin open <file>`, waits for the person to press Send, edits the real file, and waits for the next round. Do not narrate those commands to the person.
- If the skill is not listed in this session, read the SKILL.md file above and follow it.

Developer notes for this repository are in docs/DEVELOPERS.md and CONTRIBUTING.md.
