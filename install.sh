#!/bin/sh
# Onionskin installer for macOS. No sudo. Copies this folder to ~/.onionskin/app/<version>/, writes the launcher
# ~/.local/bin/onionskin, installs the agent skill (onionskin setup), and sets up the deeper checks. Touches nothing else.
#   sh install.sh               install or upgrade (safe to re-run); downloads five small libraries from PyPI once, for the deeper checks
#   sh install.sh --no-checker  the same, without that download (deeper checks can be turned on later from the review panel)
#   sh install.sh --rewriter    also turn on quick fixes on this Mac: quick spelling and grammar fixes with Apple's built-in
#                               model (macOS 26 or later with Apple Intelligence on; nothing is downloaded). Off unless you ask. A failure
#                               never fails the install, and Fix grammar then goes to the agent.
#   sh install.sh --dry-run     show what would happen, change nothing
#   sh install.sh --uninstall   remove the launcher, the app copy and both skill folders (keeps ~/.onionskin snapshots)
#   sh install.sh --uninstall --purge   also delete ~/.onionskin (snapshots, checker venv)
set -u

DRY=0 UNINSTALL=0 PURGE=0 NOCHECKER=0 REWRITER=
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --purge) PURGE=1 ;;
    --no-checker) NOCHECKER=1 ;;
    --rewriter|--rewriter=apple) REWRITER=apple ;;
    --rewriter*) echo "--rewriter takes no value: quick fixes use Apple's built-in model (try --help)" >&2; exit 2 ;;
    -h|--help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $a (try --help)" >&2; exit 2 ;;
  esac
done
if [ "$PURGE" = 1 ] && [ "$UNINSTALL" = 0 ]; then echo "--purge only makes sense with --uninstall" >&2; exit 2; fi

SRC=$(cd "$(dirname "$0")" && pwd -P)
HOME_DIR=${HOME:?HOME is not set}
STATE="$HOME_DIR/.onionskin"
APPS="$STATE/app"
BINDIR="$HOME_DIR/.local/bin"
LAUNCHER="$BINDIR/onionskin"
SKILLS="$HOME_DIR/.claude/skills/onionskin $HOME_DIR/.agents/skills/onionskin"

say() { printf '%s\n' "$*"; }
do_() { # run a change unless --dry-run
  if [ "$DRY" = 1 ]; then say "  [dry run] $*"; else "$@"; fi
}
is_our_skill() { [ -d "$1" ] && [ ! -L "$1" ] && head -c 400 "$1/SKILL.md" 2>/dev/null | grep -q '^name:[[:space:]]*onionskin[[:space:]]*$'; }
is_our_launcher() { [ -f "$LAUNCHER" ] && [ ! -L "$LAUNCHER" ] && grep -q '/.onionskin/app/' "$LAUNCHER" 2>/dev/null; }

[ "$DRY" = 1 ] && say "Dry run: nothing will be changed."

# ---- uninstall ----------------------------------------------------------------------------------------------------
if [ "$UNINSTALL" = 1 ]; then
  say "Uninstalling Onionskin"
  if is_our_launcher && command -v node >/dev/null 2>&1 && [ "$DRY" = 0 ]; then "$LAUNCHER" stop >/dev/null 2>&1 || true; fi
  if is_our_launcher; then do_ rm -f "$LAUNCHER"; say "  removed $LAUNCHER"; elif [ -e "$LAUNCHER" ]; then say "  left alone: $LAUNCHER (not made by this installer)"; else say "  not present: $LAUNCHER"; fi
  if [ -d "$APPS" ]; then do_ rm -rf "$APPS"; say "  removed $APPS"; else say "  not present: $APPS"; fi
  for s in $SKILLS; do
    if is_our_skill "$s"; then do_ rm -rf "$s"; say "  removed $s"; elif [ -e "$s" ]; then say "  left alone: $s (not an onionskin skill folder)"; else say "  not present: $s"; fi
  done
  if [ "$PURGE" = 1 ]; then
    if [ -d "$STATE" ]; then do_ rm -rf "$STATE"; say "  removed $STATE (snapshots and checker environment included)"; fi
  elif [ -d "$STATE" ]; then
    say "  kept $STATE (your snapshots and the checker environment); delete it with: sh install.sh --uninstall --purge"
  fi
  say "Your documents were not touched."
  exit 0
fi

# ---- checks ---------------------------------------------------------------------------------------------------------
say "Onionskin installer"
if [ "$(uname -s)" != "Darwin" ]; then
  say "This installer supports macOS only (this is $(uname -s))."; exit 1
fi
MACV=$(sw_vers -productVersion 2>/dev/null || echo unknown)
case "$MACV" in
  unknown) say "macOS: version unknown (continuing)" ;;
  *) MAJ=${MACV%%.*}; if [ "$MAJ" -lt 13 ] 2>/dev/null; then say "macOS $MACV: older than 13, which was not tested. Continuing anyway."; else say "macOS $MACV: ok"; fi ;;
esac

NODE_HELP="
Node.js 22 or newer is required, and it was not found (or is too old).
Pick ONE way to install it, then run this installer again:

  (a) Official installer: open https://nodejs.org/en/download, choose the macOS Installer (.pkg) for the
      current LTS or newer version (22 or higher), run it, then open a NEW Terminal window.
  (b) Homebrew:  brew install node        $( command -v brew >/dev/null 2>&1 && echo '(Homebrew was found on this Mac)' || echo '(Homebrew was NOT found; use (a), or see https://brew.sh)' )

Check with:  node -v      (it must print v22 or higher)
Nothing was changed on this Mac."
if ! command -v node >/dev/null 2>&1; then
  say "node: not found"; say "$NODE_HELP"; exit 1
fi
NODEV=$(node -v 2>/dev/null || echo v0)
NMAJ=${NODEV#v}; NMAJ=${NMAJ%%.*}
if ! [ "$NMAJ" -ge 22 ] 2>/dev/null; then
  say "node: $NODEV is too old"; say "$NODE_HELP"; exit 1
fi
say "node: $NODEV ok"

[ -f "$SRC/src/cli.js" ] && [ -f "$SRC/package.json" ] && [ -f "$SRC/web/dist/index.html" ] || { say "This folder is not a complete Onionskin package (src/cli.js, package.json or web/dist is missing). Unzip the zip again."; exit 1; }
VERSION=$(node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).version))" "$SRC/package.json" 2>/dev/null)
case "$VERSION" in ""|*[!0-9A-Za-z.+-]*) say "Could not read a sane version from package.json ($VERSION)"; exit 1 ;; esac
APP="$APPS/$VERSION"

# ---- install ------------------------------------------------------------------------------------------------------------
say "Installing Onionskin $VERSION"
# A server left running by the copy that is about to be replaced would keep the old code in memory. Stop it: open sessions are kept
# on disk and the server starts again on the next command.
if is_our_launcher && [ "$DRY" = 0 ]; then "$LAUNCHER" stop >/dev/null 2>&1 || true; fi
if [ "$SRC" = "$APP" ]; then
  say "  app folder: already running from $APP"
else
  say "  app folder: $APP"
  if [ "$DRY" = 0 ]; then
    mkdir -p "$APPS" || exit 1
    chmod 700 "$STATE" 2>/dev/null || true
    TMP="$APPS/.incoming-$$"
    rm -rf "$TMP"
    cp -R "$SRC" "$TMP" || { rm -rf "$TMP"; say "copy failed"; exit 1; }
    rm -rf "$TMP/.git"
    rm -rf "$APP"
    mv "$TMP" "$APP" || exit 1
  else
    say "  [dry run] copy $SRC to $APP"
  fi
fi

# The small helper for quick fixes (scripts/rewriter/apple/onionskin-fm) is a program from a download: macOS marks it, and would stop it
# with a dialog the server never sees. Clear that mark on this one file only, in the copy that runs. src/rewriter.js never starts it while marked.
QHELPER="$APP/scripts/rewriter/apple/onionskin-fm"
if [ "$DRY" = 1 ]; then
  say "  [dry run] would remove macOS's download mark from one file, the small helper that talks to Apple's on-device model"
elif [ -f "$QHELPER" ]; then
  /usr/bin/xattr -d com.apple.quarantine "$QHELPER" 2>/dev/null || true # "No such xattr" is fine: nothing to clear
  if /usr/bin/xattr -p com.apple.quarantine "$QHELPER" >/dev/null 2>&1; then
    say "  quick fixes: macOS still marks the small helper as downloaded, so Onionskin will not start it and Fix grammar goes to the agent"
  else
    say "  quick fixes: removed macOS's download mark from one file, if it had one: the small helper that talks to Apple's on-device model, so macOS does not stop it"
  fi
fi

# An earlier version downloaded a writing helper into the state folder. Remove that once (only the known folders and its settings file, inside
# the state folder, never through a link); prints one line saying what was freed, or nothing when there was none. A failure is never fatal.
if [ "$DRY" = 1 ]; then
  say "  [dry run] would remove the old writing helper download from $STATE, if an earlier version left one"
elif [ -d "$STATE" ]; then
  node "$APP/src/cli.js" setup-rewriter --clean-old 2>/dev/null | sed 's/^/  /' || true
fi

say "  launcher:   $LAUNCHER"
if [ -e "$LAUNCHER" ] && ! is_our_launcher; then
  say "  $LAUNCHER already exists and was not made by this installer. Not touching it."
  say "  Move it away, or run the app directly: node $APP/src/cli.js"
  exit 1
fi
if [ "$DRY" = 0 ]; then
  mkdir -p "$BINDIR" || exit 1
  printf '#!/bin/sh\nexec node "%s/src/cli.js" "$@"\n' "$APP" > "$LAUNCHER.tmp.$$" && chmod 755 "$LAUNCHER.tmp.$$" && mv "$LAUNCHER.tmp.$$" "$LAUNCHER" || exit 1
  # older copies of the app are not needed any more
  for d in "$APPS"/*; do [ -d "$d" ] && [ "$d" != "$APP" ] && rm -rf "$d"; done
else
  say "  [dry run] write the 2-line launcher"
fi

# ---- skill ------------------------------------------------------------------------------------------------------------
# Replace an existing skill folder without asking only when every existing one is ours (an upgrade); otherwise setup asks.
FORCE=""
ALL_OURS=1
for s in $SKILLS; do [ -e "$s" ] && ! is_our_skill "$s" && ALL_OURS=0; done
[ "$ALL_OURS" = 1 ] && FORCE="--force"
say "Installing the agent skill (onionskin setup)"
if [ "$DRY" = 1 ]; then
  node "$SRC/src/cli.js" setup --dry-run $FORCE | sed 's/^/  /'
else
  node "$APP/src/cli.js" setup $FORCE | sed 's/^/  /'
fi

# ---- deeper checks ---------------------------------------------------------------------------------------------------
# The one step that uses the network (pip, from PyPI). A failure is never fatal: Onionskin works without it, and the review panel can turn it on later.
CHECKER_LOG="$STATE/setup-checker.log"
CHECKER_LIBS="import lxml, docx, openpyxl, pptx, defusedxml"
say "Deeper checks"
if [ "$NOCHECKER" = 1 ]; then
  say "  skipped (--no-checker). You can turn them on later from the review panel."
elif [ "$DRY" = 1 ]; then
  say "  [dry run] would download five small Python libraries from PyPI once into $STATE/venv (about a minute; the system Python is left alone)"
elif [ -x "$STATE/venv/bin/python" ] && "$STATE/venv/bin/python" -c "$CHECKER_LIBS" >/dev/null 2>&1; then
  say "  already set up"
else
  say "  Downloading five small Python libraries once into $STATE/venv. This takes about a minute and leaves the system Python alone."
  PY3=$(command -v "${ONIONSKIN_BASE_PYTHON:-python3}" 2>/dev/null || true)
  if [ -z "$PY3" ]; then
    CHECKER_OK=0; printf 'no python3 was found on this Mac\n' > "$CHECKER_LOG"
  elif [ -z "${ONIONSKIN_BASE_PYTHON:-}" ] && [ "$PY3" = /usr/bin/python3 ] && ! xcode-select -p >/dev/null 2>&1; then
    # on a Mac without the developer tools, running that python3 pops up an installer window; do not start it from here
    CHECKER_OK=0; printf '/usr/bin/python3 needs the macOS developer tools, which are not installed; not started\n' > "$CHECKER_LOG"
  else
    mkdir -p "$STATE" && chmod 700 "$STATE" 2>/dev/null
    if node "$APP/src/cli.js" setup-checker > "$CHECKER_LOG" 2>&1 && [ -x "$STATE/venv/bin/python" ] && "$STATE/venv/bin/python" -c "$CHECKER_LIBS" >/dev/null 2>&1; then CHECKER_OK=1; else CHECKER_OK=0; fi
  fi
  if [ "${CHECKER_OK:-0}" = 1 ]; then
    say "  done"
  else
    say "  Onionskin works without deeper checks. You can turn them on later from the review panel. (Details: $CHECKER_LOG)"
  fi
fi

# ---- quick fixes (opt in) ---------------------------------------------------------------------------------------------
# Off unless --rewriter. Apple's built-in model, through the helper in the app folder: nothing is downloaded. A failure is never fatal.
if [ -n "$REWRITER" ]; then
  REWRITER_LOG="$STATE/setup-rewriter.log"
  say "Quick fixes"
  if [ "$DRY" = 1 ]; then
    say "  [dry run] would check that Apple's built-in model is available on this Mac and try it on one test sentence (nothing is downloaded)"
  else
    mkdir -p "$STATE" && chmod 700 "$STATE" 2>/dev/null
    if node "$APP/src/cli.js" setup-rewriter > "$REWRITER_LOG" 2>&1; then
      say "  done"
    else
      say "  Onionskin works without quick fixes. You can turn them on later by asking your agent. (Details: $REWRITER_LOG)"
    fi
  fi
fi

# ---- PATH ------------------------------------------------------------------------------------------------------------
case ":$PATH:" in
  *":$BINDIR:"*) ONPATH=1 ;;
  *) ONPATH=0 ;;
esac
say ""
if [ "$DRY" = 1 ]; then say "Dry run finished. Run without --dry-run to install."; exit 0; fi
say "Done. Onionskin $VERSION is installed."
CMD=onionskin
if [ "$ONPATH" = 0 ]; then
  CMD="$LAUNCHER"
  say ""
  say "Your agent finds Onionskin by its full location ($LAUNCHER), so you do not need to do anything."
  say "Optional: to type 'onionskin' yourself in Terminal, paste this line, then open a NEW Terminal window:"
  say ""
  say "  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zshrc"
fi
say ""
say "Check that it works:"
say "  $CMD --version             should print $VERSION"
say "  $CMD setup --dry-run       should say both skill folders are already up to date"
say "  $CMD $APP/samples/sample.docx"
say "                                  opens it in your browser and starts Claude Code on it in the background"
say "  $CMD doctor                prints a status report you can send back if something is wrong"
say ""
say "Install check (onionskin doctor):"
node "$APP/src/cli.js" doctor | sed 's/^/  /'
say ""
say "To start: type onionskin your-file.docx in a terminal, or tell Claude Code or Codex: open your-file.docx in Onionskin"
