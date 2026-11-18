#!/bin/sh
# Onionskin one-line installer for macOS. Downloads the release zip, checks its SHA-256, unzips it to a temp folder and runs the
# zip's own install.sh. No sudo (refuses to run as root). Touches nothing outside ~/.onionskin, ~/.local/bin and the two skill folders.
#   curl -fsSL <release url>/get.sh | sh
#   curl -fsSL <release url>/get.sh | sh -s -- --no-checker      (anything after -- goes to install.sh: --no-checker, --rewriter)
#   sh get.sh --dry-run     print what would happen; downloads nothing, changes nothing
# Pin a release with variables (plain URLs: https, or file:/// and http://127.0.0.1 for local tests; no user name in a URL):
#   ONIONSKIN_BASE_URL     the folder both files are fetched from (default: the latest release; the zip is onionskin.zip in it)
#   ONIONSKIN_ZIP_URL      the zip                      (default: the latest release's onionskin.zip)
#   ONIONSKIN_SHA256_URL   its checksum file            (default: the zip URL plus .sha256; "<hash>" or "<hash>  <name>")
#   ONIONSKIN_SHA256       the expected hash itself, instead of the checksum file (a hash typed into your own command is the
#                          strongest check: a checksum file from the same place only catches a damaged download)
# The whole script sits in one function that runs on the last line, so a download cut short runs nothing.
set -u

main() {
  DEFAULT_BASE=${ONIONSKIN_BASE_URL:-https://github.com/abe238/onionskin/releases/latest/download}
  ZIP_URL=${ONIONSKIN_ZIP_URL:-$DEFAULT_BASE/onionskin.zip}
  SHA_URL=${ONIONSKIN_SHA256_URL:-$ZIP_URL.sha256}
  WANT=${ONIONSKIN_SHA256:-}
  DRY=0
  for a in "$@"; do [ "$a" = "--dry-run" ] && DRY=1; done
  if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then sed -n '2,14p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'; return 0; fi

  say() { printf '%s\n' "$*"; }
  die() { say "onionskin install: $*" >&2; return 1; }

  say "Onionskin one-line installer"
  [ "$(id -u)" != 0 ] || { die "do not run this as root or with sudo. Open a normal Terminal window and run it again."; return 1; }
  [ "$(uname -s)" = "Darwin" ] || { die "this installer supports macOS only (this is $(uname -s))."; return 1; }
  for t in curl unzip shasum; do command -v "$t" >/dev/null 2>&1 || { die "$t was not found, and macOS normally includes it."; return 1; }; done
  if ! command -v node >/dev/null 2>&1; then
    die "Node.js 22 or newer is required and was not found. Install it from https://nodejs.org/en/download (or: brew install node), open a new Terminal window, and run this again. Nothing was changed."; return 1
  fi
  NMAJ=$(node -v 2>/dev/null | sed 's/^v//; s/\..*//')
  [ "${NMAJ:-0}" -ge 22 ] 2>/dev/null || { die "Node.js $(node -v 2>/dev/null) is too old; 22 or newer is required. Update it from https://nodejs.org/en/download, open a new Terminal window, and run this again. Nothing was changed."; return 1; }

  # The one rule for a release URL (src/update.js baseUrlOk is the same rule): https://, file:///, or http:// to exactly 127.0.0.1 with
  # an optional port; no white space anywhere and no "@" or backslash before the first "/" after the scheme, so a user name cannot
  # hide the real host (http://127.0.0.1:80@evil.example/ is evil.example).
  url_ok() {
    case "$1" in *[[:space:]]*) return 1 ;; esac
    case "$1" in
      https://*) rest=${1#https://} ;;
      file:///*) return 0 ;;
      http://*) rest=${1#http://} ;;
      *) return 1 ;;
    esac
    auth=${rest%%/*}
    case "$auth" in *@*|*\\*) return 1 ;; esac
    case "$1" in http://*) ;; *) return 0 ;; esac
    case "$auth" in
      127.0.0.1) return 0 ;;
      127.0.0.1:*) port=${auth#127.0.0.1:}; case "$port" in ""|*[!0-9]*) return 1 ;; esac; return 0 ;;
    esac
    return 1
  }
  # curl may use only the scheme the rule allowed: plain http only for 127.0.0.1, and a redirect only to https
  proto() { case "$1" in http://*) printf '%s' "=https,file,http" ;; *) printf '%s' "=https,file" ;; esac; }
  for u in "$ZIP_URL" "$SHA_URL"; do
    url_ok "$u" || { die "refusing the URL $u (only https:// is accepted)"; return 1; }
  done
  if [ -n "$WANT" ]; then
    case "$WANT" in *[!0-9a-fA-F]*|"") die "ONIONSKIN_SHA256 must be 64 hex characters"; return 1 ;; esac
    [ "${#WANT}" = 64 ] || { die "ONIONSKIN_SHA256 must be 64 hex characters"; return 1; }
  fi

  say "  zip:      $ZIP_URL"
  if [ -n "$WANT" ]; then say "  checksum: the value in ONIONSKIN_SHA256"; else say "  checksum: $SHA_URL"; fi
  if [ "$DRY" = 1 ]; then
    say "  [dry run] would download the zip, check its SHA-256, unzip it to a temp folder, run its install.sh and delete the temp folder."
    say "Dry run finished. Nothing was downloaded or changed."
    return 0
  fi

  TMPD=$(mktemp -d "${TMPDIR:-/tmp}/onionskin-get.XXXXXX") || { die "could not make a temp folder"; return 1; }
  trap 'rm -rf "$TMPD"' EXIT INT TERM HUP
  CURL="curl -fsSL --connect-timeout 20 --max-time 300 --proto-redir =https"
  say "Downloading"
  $CURL --proto "$(proto "$ZIP_URL")" -o "$TMPD/onionskin.zip" "$ZIP_URL" || { die "could not download $ZIP_URL"; return 1; }
  if [ -z "$WANT" ]; then
    $CURL --proto "$(proto "$SHA_URL")" -o "$TMPD/onionskin.zip.sha256" "$SHA_URL" || { die "could not download $SHA_URL"; return 1; }
    WANT=$(awk 'NR==1 {print $1}' "$TMPD/onionskin.zip.sha256")
    case "$WANT" in *[!0-9a-fA-F]*|"") die "the checksum file does not start with a SHA-256 hash"; return 1 ;; esac
    [ "${#WANT}" = 64 ] || { die "the checksum file does not start with a SHA-256 hash"; return 1; }
  fi
  GOT=$(shasum -a 256 "$TMPD/onionskin.zip" | awk '{print $1}')
  WANT=$(printf '%s' "$WANT" | tr 'A-F' 'a-f')
  if [ "$GOT" != "$WANT" ]; then
    die "the checksum does not match, so nothing was unzipped or installed.
  expected $WANT
  got      $GOT"
    return 1
  fi
  say "  checksum ok ($GOT)"

  # The zip holds one top folder, onionskin/. Refuse anything that would unpack elsewhere.
  unzip -Z1 "$TMPD/onionskin.zip" > "$TMPD/list" 2>/dev/null || { die "the download is not a readable zip"; return 1; }
  if /usr/bin/grep -qv '^onionskin/' "$TMPD/list" || /usr/bin/grep -q '\.\./' "$TMPD/list"; then die "the zip holds files outside its onionskin/ folder; refusing to unpack it"; return 1; fi
  mkdir "$TMPD/x" && unzip -q "$TMPD/onionskin.zip" -d "$TMPD/x" || { die "could not unzip"; return 1; }
  [ -f "$TMPD/x/onionskin/install.sh" ] || { die "the zip has no install.sh"; return 1; }

  # stdin is closed for the installer: when this script arrives through a pipe, stdin is the script itself.
  sh "$TMPD/x/onionskin/install.sh" "$@" </dev/null
  RC=$?
  [ "$RC" = 0 ] || return "$RC"

  # The last lines are for the agent that ran this script: what was installed, and the one sentence to relay to the person.
  VER=$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$TMPD/x/onionskin/package.json" 2>/dev/null | head -n 1)
  say ""
  say "INSTALLED: Onionskin ${VER:-(version unknown)}. Command: ~/.local/bin/onionskin. Skill: set up for Claude Code and Codex (the setup lines above list the folders)."
  say "AGENT: run 'onionskin doctor' (use ~/.local/bin/onionskin if the command is not found yet), then tell the person this one sentence and nothing else:"
  say "Onionskin is installed. To use it, say: open <your file> in Onionskin"
}

main "$@"
