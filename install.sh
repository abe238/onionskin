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
APP=""
TMP=""
SETUP_OUT=""
LOCK="$STATE/install.lock"
LOCK_HELD=0
STATE_CREATED=0

cleanup() {
  [ -n "${TMP:-}" ] && rm -rf "$TMP"
  if [ -n "${APP:-}" ] && [ -e "$APP.old.$$" ] && [ ! -e "$APP" ]; then
    mv "$APP.old.$$" "$APP" 2>/dev/null || true
  fi
  [ -n "${LAUNCHER:-}" ] && rm -f "${LAUNCHER}.tmp.$$"
  [ -n "${SETUP_OUT:-}" ] && rm -f "$SETUP_OUT"
  [ "${LOCK_HELD:-0}" = 1 ] && [ "$(cat "$LOCK/pid" 2>/dev/null)" = "$$" ] && rm -rf "$LOCK"
  [ "${UNINSTALL:-0}" = 1 ] && [ "${STATE_CREATED:-0}" = 1 ] && rmdir "$STATE" 2>/dev/null || true
}
trap cleanup EXIT
trap 'cleanup; trap - EXIT; exit 1' INT TERM HUP

say() { printf '%s\n' "$*"; }
lock_busy() {
  say "Another Onionskin install or update is running. Try again when it finishes."
  say "If none is running, delete this folder and try again: $LOCK"
  exit 1
}
check_lock() {
  if [ "$(cat "$LOCK/pid" 2>/dev/null)" != "$$" ]; then
    LOCK_HELD=0
    lock_busy
  fi
}
take_lock() {
  [ "$DRY" = 1 ] && return 0
  if [ ! -d "$STATE" ]; then
    mkdir -p "$STATE" || exit 1
    STATE_CREATED=1
  fi
  chmod 700 "$STATE" 2>/dev/null || true
  if mkdir "$LOCK" 2>/dev/null; then
    LOCK_HELD=1
    printf '%s\n' "$$" > "$LOCK/pid"
    return 0
  fi
  TRIES=0
  while [ -d "$LOCK" ] && [ ! -s "$LOCK/pid" ] && [ "$TRIES" -lt 5 ]; do
    sleep 0.1
    TRIES=$((TRIES + 1))
  done
  LPID=$(cat "$LOCK/pid" 2>/dev/null || true)
  case "$LPID" in
    ''|*[!0-9]*) LPID="" ;;
  esac
  if [ -n "$LPID" ] && kill -0 "$LPID" 2>/dev/null; then
    lock_busy
  fi
  LPID2=$(cat "$LOCK/pid" 2>/dev/null || true)
  case "$LPID2" in
    ''|*[!0-9]*) LPID2="" ;;
  esac
  if [ "$LPID2" != "$LPID" ]; then
    lock_busy
  fi
  mv "$LOCK" "$LOCK.stale.$$" 2>/dev/null && rm -rf "$LOCK.stale.$$"
  if mkdir "$LOCK" 2>/dev/null; then
    LOCK_HELD=1
    { printf '%s\n' "$$" > "$LOCK/pid"; } 2>/dev/null || true
    sleep 0.2
    CURPID=$(cat "$LOCK/pid" 2>/dev/null || true)
    if [ "$CURPID" != "$$" ]; then
      LOCK_HELD=0
      lock_busy
    fi
    return 0
  fi
  lock_busy
}
do_() { # run a change unless --dry-run
  if [ "$DRY" = 1 ]; then say "  [dry run] $*"; else "$@"; fi
}
is_our_skill() { [ -d "$1" ] && [ ! -L "$1" ] && head -c 400 "$1/SKILL.md" 2>/dev/null | grep -q '^name:[[:space:]]*onionskin[[:space:]]*$'; }
is_our_launcher() { [ -f "$LAUNCHER" ] && [ ! -L "$LAUNCHER" ] && grep -q '/.onionskin/app/' "$LAUNCHER" 2>/dev/null; }
check_app() {
  if [ ! -f "$1/src/server-entry.js" ] || [ ! -f "$1/src/server.js" ] || ! node -e '
    const r = require("node:child_process").spawnSync(process.execPath, [process.argv[1], "--version"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000, killSignal: "SIGKILL"
    });
    const version = process.argv[2];
    process.exit(r.status === 0 && (r.stdout === version || r.stdout === version + "\n") ? 0 : 1);
  ' "$1/src/cli.js" "$2"; then
    say "  The new copy could not start. Any previous installation was kept."
    exit 1
  fi
}

# COPYFILE_EXCL refuses an occupied name and cleans up a destination opened by a failed copy.
save_guide() {
  node -e 'const fs = require("node:fs"); fs.copyFileSync(process.argv[1], process.argv[2], fs.constants.COPYFILE_EXCL)' "$1" "$2" || return 1
  cmp -s "$1" "$2" && return 0
  rm -f "$2"
  return 1
}

carry_guide() {
  guide=$1
  dest=$2
  if [ -e "$dest" ] || [ -L "$dest" ]; then
    for copy in "$dest" "$STATE/voice.md.kept" "$STATE"/voice.md.kept.[0-9]*; do
      # Only numbered backups count, even if an unrelated filename starts with a digit.
      case "$copy" in "$STATE"/voice.md.kept.*[!0-9]*) continue ;; esac
      if [ ! -L "$copy" ] && [ -f "$copy" ] && cmp -s "$guide" "$copy"; then return 0; fi
    done
    dest="$STATE/voice.md.kept"
    n=0
    while [ -e "$dest" ] || [ -L "$dest" ]; do
      n=$((n + 1))
      dest="$STATE/voice.md.kept.$n"
    done
  fi
  if ! save_guide "$guide" "$dest" 2>/dev/null; then
    say "  Left $guide in place because it could not be saved to $dest."
    return 1
  fi
  [ "$dest" = "$2" ] || say "  Kept your voice guide at $dest."
}

[ "$DRY" = 1 ] && say "Dry run: nothing will be changed."

# ---- uninstall ----------------------------------------------------------------------------------------------------
if [ "$UNINSTALL" = 1 ]; then
  say "Uninstalling Onionskin"
  take_lock
  if is_our_launcher && command -v node >/dev/null 2>&1 && [ "$DRY" = 0 ]; then "$LAUNCHER" stop >/dev/null 2>&1 || true; fi
  if is_our_launcher; then do_ rm -f "$LAUNCHER"; say "  removed $LAUNCHER"; elif [ -e "$LAUNCHER" ]; then say "  left alone: $LAUNCHER (not made by this installer)"; else say "  not present: $LAUNCHER"; fi
  if [ -d "$APPS" ]; then do_ rm -rf "$APPS"; say "  removed $APPS"; else say "  not present: $APPS"; fi
  for s in "$HOME_DIR/.claude/skills/onionskin" "$HOME_DIR/.agents/skills/onionskin"; do
    if is_our_skill "$s"; then do_ rm -rf "$s"; say "  removed $s"; elif [ -e "$s" ]; then say "  left alone: $s (not an onionskin skill folder)"; else say "  not present: $s"; fi
  done
  if [ "$PURGE" = 1 ]; then
    if [ "$STATE_CREATED" = 0 ] && [ -d "$STATE" ]; then
      do_ rm -rf "$STATE"; say "  removed $STATE (snapshots and checker environment included)"
    else
      say "  not present: $STATE"
    fi
  elif [ "$STATE_CREATED" = 0 ] && [ -d "$STATE" ]; then
    say "  kept $STATE (your snapshots and the checker environment); to delete it: rm -rf $STATE"
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
  *) MAJ=${MACV%%.*}; REST=${MACV#*.}; MIN=${REST%%.*}; [ "$REST" = "$MACV" ] && MIN=0
     if [ "$MAJ" -lt 13 ] 2>/dev/null || { [ "$MAJ" -eq 13 ] 2>/dev/null && [ "$MIN" -lt 1 ] 2>/dev/null; }; then
       say "macOS $MACV: older than 13.1, which was not tested. Continuing anyway."
     else
       say "macOS $MACV: ok"
     fi ;;
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
if { [ -e "$LAUNCHER" ] || [ -L "$LAUNCHER" ]; } && ! is_our_launcher; then
  say "  $LAUNCHER already exists and was not made by this installer. Not touching it."
  say "  Move it away, or run the app directly: node $SRC/src/cli.js"
  exit 1
fi
take_lock
# A server left running by the copy that is about to be replaced would keep the old code in memory. Stop it: open sessions are kept
# on disk and the server starts again on the next command.
if is_our_launcher && [ "$DRY" = 0 ]; then "$LAUNCHER" stop >/dev/null 2>&1 || true; fi
if [ "$SRC" = "$APP" ]; then
  say "  app folder: already running from $APP"
  [ "$DRY" = 1 ] || check_app "$APP" "$VERSION"
else
  say "  app folder: $APP"
  if [ "$DRY" = 0 ]; then
    mkdir -p "$APPS" || exit 1
    chmod 700 "$STATE" 2>/dev/null || true
    TMP="$APPS/.incoming-$$"
    rm -rf "$TMP"
    cp -R "$SRC" "$TMP" || { rm -rf "$TMP"; TMP=""; say "copy failed"; exit 1; }
    rm -rf "$TMP/.git"
    # Check the staged copy before even a same-version launcher could point at it.
    check_app "$TMP" "$VERSION"
    if [ -e "$APP" ]; then
      if [ -e "$APP.old.$$" ] || [ -L "$APP.old.$$" ]; then say "  Could not set aside the old copy. $APP.old.$$ already exists."; exit 1; fi
      check_lock
      mv "$APP" "$APP.old.$$" || exit 1
      if mv "$TMP" "$APP"; then
        TMP=""
      else
        mv "$APP.old.$$" "$APP" 2>/dev/null || true
        exit 1
      fi
    else
      mv "$TMP" "$APP" || exit 1
      TMP=""
    fi
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
if [ "$DRY" = 0 ]; then
  mkdir -p "$BINDIR" || exit 1
  APP_SQ=$(printf '%s' "$APP" | sed "s/'/'\\\\''/g")
  printf "#!/bin/sh\nexec node '%s/src/cli.js' \"\$@\"\n" "$APP_SQ" > "$LAUNCHER.tmp.$$" && chmod 755 "$LAUNCHER.tmp.$$" || exit 1
  check_lock
  mv "$LAUNCHER.tmp.$$" "$LAUNCHER" || exit 1
  # older copies of the app are not needed any more
  check_lock
  for d in "$APPS"/*; do
    [ -d "$d" ] && [ "$d" != "$APP" ] || continue
    guide="$d/skills/onionskin/voice.md"
    if [ -L "$guide" ] || [ -f "$guide" ]; then
      dest="$APP/skills/onionskin/voice.md"
      if [ -L "$guide" ] || [ -L "$d" ] || [ -L "$d/skills" ] || [ -L "$d/skills/onionskin" ] ||
         [ -L "$APP" ] || [ -L "$APP/skills" ] || [ -L "$APP/skills/onionskin" ]; then
        say "  Left $guide in place because its source or destination uses a link."
        continue
      elif ! carry_guide "$guide" "$dest"; then
        continue
      fi
    fi
    rm -rf "$d"
  done
else
  say "  [dry run] write the 2-line launcher"
fi

# ---- skill ------------------------------------------------------------------------------------------------------------
# Replace an existing skill folder without asking only when every existing one is ours (an upgrade); otherwise setup asks.
FORCE=""
ALL_OURS=1
for s in "$HOME_DIR/.claude/skills/onionskin" "$HOME_DIR/.agents/skills/onionskin"; do { [ -e "$s" ] || [ -L "$s" ]; } && ! is_our_skill "$s" && ALL_OURS=0; done
[ "$ALL_OURS" = 1 ] && FORCE="--force"
say "Installing the agent skill (onionskin setup)"
SETUP_OUT=$(mktemp "${TMPDIR:-/tmp}/onionskin-setup.XXXXXX") || exit 1
if [ "$DRY" = 1 ]; then
  node "$SRC/src/cli.js" setup --dry-run $FORCE > "$SETUP_OUT"
else
  node "$APP/src/cli.js" setup $FORCE > "$SETUP_OUT"
fi
SETUP_RC=$?
sed 's/^/  /' "$SETUP_OUT"
rm -f "$SETUP_OUT"
SETUP_OUT=""
if [ "$SETUP_RC" != 0 ]; then
  say "  SKILL_SETUP_FAILED: warning: skill setup exited $SETUP_RC; the app is installed. Run 'onionskin setup' to finish installing the skill."
fi

# ---- deeper checks ---------------------------------------------------------------------------------------------------
# The one step that uses the network (pip, from PyPI). A failure is never fatal: Onionskin works without it, and the review panel can turn it on later.
CHECKER_LOG="$STATE/setup-checker.log"
say "Deeper checks"
if [ "$NOCHECKER" = 1 ]; then
  say "  skipped (--no-checker). You can turn them on later from the review panel."
elif [ "$DRY" = 1 ]; then
  say "  [dry run] would download five small Python libraries from PyPI once into $STATE/venv (about a minute; the system Python is left alone)"
else
  say "  Checking the Python libraries in $STATE/venv and installing them if needed."
  if ONIONSKIN_SETUP_IF_NEEDED=1 ONIONSKIN_STATE_DIR="$STATE" node "$APP/src/cli.js" setup-checker > "$CHECKER_LOG" 2>&1 && [ -x "$STATE/venv/bin/python" ]; then
    say "  done"
  else
    if grep -Fxq 'Deeper check setup timed out.' "$CHECKER_LOG"; then say "  Deeper check setup timed out."; fi
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
say "  $CMD setup --dry-run       should say the skill folders are already up to date"
say "  $CMD $APP/samples/sample.docx"
say "                                  opens it in your browser and starts Claude Code on it in the background"
say "  $CMD doctor                prints a status report you can send back if something is wrong"
say ""
say "Install check (onionskin doctor):"
node "$APP/src/cli.js" doctor | sed 's/^/  /'
say ""
say "To start: type onionskin your-file.docx in a terminal, or tell Claude Code or Codex: open your-file.docx in Onionskin"
