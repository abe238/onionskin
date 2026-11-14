#!/bin/sh
# Rehearses the zip install in a throwaway HOME with a reduced PATH. Not a truly clean Mac: see docs in the report.
# Usage: sh scripts/rehearse-clean-install.sh [path/to/onionskin-*.zip]
# Env:   REH_PLAYWRIGHT = path to playwright-core/index.mjs (test tooling, not shipped); default <repo>/node_modules/playwright-core/index.mjs
# The rehearsal never uses the network: every install.sh run passes --no-checker, except the one that points the base Python at a stub that fails.
# Writes dist-zip/rehearsal.log. Exit 0 only when every check passed.
set -u
REPO=$(cd "$(dirname "$0")/.." && pwd -P)
ZIP=${1:-$(ls -t "$REPO"/dist-zip/onionskin-*.zip 2>/dev/null | head -1)}
[ -f "$ZIP" ] || { echo "no zip: run node scripts/package.mjs first" >&2; exit 2; }
PW=${REH_PLAYWRIGHT:-$REPO/node_modules/playwright-core/index.mjs}
[ -f "$PW" ] || { echo "playwright-core not found at $PW (set REH_PLAYWRIGHT)" >&2; exit 2; }
NODE=$(command -v node) || { echo "node not found" >&2; exit 2; }
LOG="$REPO/dist-zip/rehearsal.log"
FAILS=0
W=$(mktemp -d "${TMPDIR:-/tmp}/onionskin-rehearsal.XXXXXX") || exit 2
trap 'rm -rf "$W"' EXIT
exec >"$LOG" 2>&1
say() { printf '%s\n' "$*"; }
check() { # check "name" command...
  name=$1; shift
  if "$@" >"$W/out" 2>&1; then say "PASS  $name"; else say "FAIL  $name"; sed 's/^/        /' "$W/out"; FAILS=$((FAILS+1)); fi
}
SYS=/usr/bin:/bin:/usr/sbin:/sbin
mkdir -p "$W/nodebin" && ln -s "$NODE" "$W/nodebin/node"
RPATH="$W/nodebin:$SYS"
say "rehearsal of $(basename "$ZIP") at $(date -u +%FT%TZ)"
say "node $("$NODE" -v), macOS $(sw_vers -productVersion), reduced PATH = <dir with only node>:$SYS"
say "sha256 $(shasum -a 256 "$ZIP" | cut -d' ' -f1)"
say ""

# 1. Node missing: install.sh must refuse, say how to fix it, and change nothing.
say "== node missing"
H0="$W/home-nonode"; mkdir -p "$H0"; mkdir "$W/unz0"; unzip -q "$ZIP" -d "$W/unz0"
env -i HOME="$H0" PATH="$SYS" /bin/sh "$W/unz0/onionskin/install.sh" >"$W/nonode.out" 2>&1; RC=$?
sed 's/^/    | /' "$W/nonode.out"
if [ "$RC" -ne 0 ] && grep -q 'nodejs.org' "$W/nonode.out" && grep -q 'brew install node' "$W/nonode.out"; then say "PASS  node missing: exit $RC with both install choices"; else say "FAIL  node missing: exit $RC"; FAILS=$((FAILS+1)); fi
if [ -z "$(find "$H0" -mindepth 1 | head -1)" ]; then say "PASS  node missing: nothing was created in HOME"; else say "FAIL  node missing: HOME changed:"; find "$H0"; FAILS=$((FAILS+1)); fi

# 2. Real install into a fresh HOME.
say ""; say "== dry run, then install"
H="$W/home"; mkdir -p "$H"; mkdir "$W/unz"; unzip -q "$ZIP" -d "$W/unz"
P="$W/unz/onionskin"
env -i HOME="$H" PATH="$RPATH" /bin/sh "$P/install.sh" --dry-run --no-checker >"$W/dry.out" 2>&1; RC=$?
sed 's/^/    | /' "$W/dry.out"
if [ "$RC" -eq 0 ] && [ -z "$(find "$H" -mindepth 1 | head -1)" ]; then say "PASS  --dry-run exits 0 and changes nothing"; else say "FAIL  --dry-run (exit $RC)"; find "$H"; FAILS=$((FAILS+1)); fi
env -i HOME="$H" PATH="$RPATH" /bin/sh "$P/install.sh" --no-checker >"$W/inst.out" 2>&1; RC=$?
sed 's/^/    | /' "$W/inst.out"
[ "$RC" -eq 0 ] && say "PASS  install.sh exit 0" || { say "FAIL  install.sh exit $RC"; FAILS=$((FAILS+1)); }
grep -q 'Optional: to type' "$W/inst.out" && ! grep -q 'One more step' "$W/inst.out" && say "PASS  install.sh printed the PATH line only as optional (~/.local/bin is not on this PATH)" || { say "FAIL  PATH line missing or still a required step"; FAILS=$((FAILS+1)); }
VERSION=$("$NODE" -e "process.stdout.write(require('$P/package.json').version)")
L="$H/.local/bin/onionskin"
RUN() { env -i HOME="$H" PATH="$RPATH:$H/.local/bin" "$@"; }
check "launcher exists and is 2 lines" test -x "$L" -a "$(wc -l <"$L" | tr -d ' ')" = 2
check "onionskin --version is $VERSION" test "$(RUN onionskin --version)" = "$VERSION"
check "onionskin setup --dry-run says both skills are up to date" sh -c "env -i HOME='$H' PATH='$RPATH:$H/.local/bin' onionskin setup --dry-run | grep -c ': already up to date$' | grep -qx 2"
check "skill dir for Claude Code" test -f "$H/.claude/skills/onionskin/SKILL.md"
check "skill dir for Codex/agents" test -f "$H/.agents/skills/onionskin/SKILL.md"
check "app copy exists with samples" test -f "$H/.onionskin/app/$VERSION/samples/sample.docx"
check "re-running install.sh is idempotent (exit 0, skills up to date)" sh -c "env -i HOME='$H' PATH='$RPATH' /bin/sh '$P/install.sh' --no-checker | grep -c ': already up to date$' | grep -qx 2"
say ""; say "== onionskin doctor"
RUN onionskin doctor > "$W/doctor.out" 2>&1; RC=$?
sed 's/^/    | /' "$W/doctor.out"
[ "$RC" -eq 0 ] && say "PASS  onionskin doctor exits 0 after install" || { say "FAIL  onionskin doctor exit $RC after install"; FAILS=$((FAILS+1)); }
grep -q "^Copy everything above when reporting a problem.$" "$W/doctor.out" && say "PASS  doctor ends with the copy line" || { say "FAIL  doctor copy line missing"; FAILS=$((FAILS+1)); }
mv "$H/.claude/skills/onionskin" "$W/skill-held-aside"
RUN onionskin doctor > "$W/doctor-broken.out" 2>&1; RC=$?
grep '^MISSING.*skill for Claude Code' "$W/doctor-broken.out" | grep -q 'Fix: onionskin setup$' && [ "$RC" -eq 1 ] && say "PASS  broken skill dir: doctor exits 1 with a MISSING line and its fix command" || { say "FAIL  doctor after breaking the skill dir (exit $RC)"; FAILS=$((FAILS+1)); }
mv "$W/skill-held-aside" "$H/.claude/skills/onionskin"

# 2b. The deeper checks. --no-checker made no venv; without it, a base Python that fails must not fail the install (and no pip output is dumped).
say ""; say "== deeper checks (no network)"
check "--no-checker made no venv" test ! -e "$H/.onionskin/venv"
printf '#!/bin/sh\nexit 1\n' > "$W/badpy"; chmod +x "$W/badpy"
HF="$W/home-badpy"; mkdir -p "$HF"
env -i HOME="$HF" PATH="$RPATH" ONIONSKIN_BASE_PYTHON="$W/badpy" /bin/sh "$P/install.sh" >"$W/badpy.out" 2>&1; RC=$?
sed 's/^/    | /' "$W/badpy.out"
[ "$RC" -eq 0 ] && say "PASS  install.sh exits 0 when the deeper-check setup fails" || { say "FAIL  install.sh exit $RC when the deeper-check setup fails"; FAILS=$((FAILS+1)); }
grep -q 'Onionskin works without deeper checks' "$W/badpy.out" && grep -q 'review panel' "$W/badpy.out" && say "PASS  the failure is one plain line that says Onionskin works without deeper checks" || { say "FAIL  no plain 'works without deeper checks' line"; FAILS=$((FAILS+1)); }
check "the failure detail went to a log file, not to the screen" sh -c "test -s '$HF/.onionskin/setup-checker.log' && ! grep -q 'Traceback\|ERROR' '$W/badpy.out'"
env -i HOME="$HF" PATH="$RPATH" /bin/sh "$P/install.sh" --uninstall --purge >/dev/null 2>&1

# 3. Open, browser, agent round (real Chrome via playwright-core from the main repo; test tooling only).
say ""; say "== open, real Chrome, agent round"
mkdir -p "$W/docs"; cp "$H/.onionskin/app/$VERSION/samples/sample.docx" "$W/docs/sample.docx"
env -i HOME="$H" PATH="$RPATH:$H/.local/bin" TMPDIR="${TMPDIR:-/tmp}" REH_LAUNCHER="$L" REH_HOME="$H" REH_PATH="$RPATH:$H/.local/bin" REH_SAMPLE="$W/docs/sample.docx" REH_PLAYWRIGHT="$PW" "$NODE" "$REPO/scripts/rehearse-clean-install.mjs" >"$W/browser.out" 2>&1; RC=$?
sed 's/^/    | /' "$W/browser.out"
[ "$RC" -eq 0 ] && say "PASS  browser and agent round" || { say "FAIL  browser and agent round (exit $RC)"; FAILS=$((FAILS+1)); }
RUN onionskin stop >/dev/null 2>&1

# 3b. Install again over a running server (an upgrade): the old server must be gone, so the next command runs the new code.
say ""; say "== install over a running server"
RUN onionskin open "$W/docs/sample.docx" --no-open >/dev/null 2>&1
OLDPID=$("$NODE" -e "try{process.stdout.write(String(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).pid))}catch{}" "$H/.onionskin/server.json")
check "a server is running before the upgrade" sh -c "[ -n '$OLDPID' ] && kill -0 '$OLDPID'"
env -i HOME="$H" PATH="$RPATH" /bin/sh "$P/install.sh" --no-checker >"$W/up.out" 2>&1; RC=$?
[ "$RC" -eq 0 ] && say "PASS  install.sh over a running server exits 0" || { say "FAIL  install.sh over a running server (exit $RC)"; sed 's/^/        /' "$W/up.out"; FAILS=$((FAILS+1)); }
check "the old server is gone after the upgrade" sh -c "[ -n '$OLDPID' ] && ! kill -0 '$OLDPID' 2>/dev/null"
RUN onionskin open "$W/docs/sample.docx" --no-open >/dev/null 2>&1
NEWPID=$("$NODE" -e "try{process.stdout.write(String(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).pid))}catch{}" "$H/.onionskin/server.json")
check "the next command starts a new server" sh -c "[ -n '$NEWPID' ] && [ '$NEWPID' != '$OLDPID' ] && kill -0 '$NEWPID'"
RUN onionskin stop >/dev/null 2>&1

# 4. Uninstall.
say ""; say "== uninstall"
env -i HOME="$H" PATH="$RPATH" /bin/sh "$P/install.sh" --uninstall >"$W/un.out" 2>&1; RC=$?
sed 's/^/    | /' "$W/un.out"
[ "$RC" -eq 0 ] && say "PASS  --uninstall exit 0" || { say "FAIL  --uninstall exit $RC"; FAILS=$((FAILS+1)); }
check "launcher removed" test ! -e "$L"
check "app dir removed" test ! -e "$H/.onionskin/app"
check "both skill dirs removed" test ! -e "$H/.claude/skills/onionskin" -a ! -e "$H/.agents/skills/onionskin"
check "state (~/.onionskin) kept without --purge" test -d "$H/.onionskin"
env -i HOME="$H" PATH="$RPATH" /bin/sh "$P/install.sh" --uninstall --purge >/dev/null 2>&1
LEFT=$(find "$H" -type f -o -type l | head)
[ -z "$LEFT" ] && say "PASS  after --uninstall --purge no file is left in HOME (empty folders may remain)" || { say "FAIL  files left in HOME:"; say "$LEFT"; FAILS=$((FAILS+1)); }
check "idempotent: --uninstall on a clean HOME exits 0" env -i HOME="$H" PATH="$RPATH" /bin/sh "$P/install.sh" --uninstall

say ""
[ "$FAILS" -eq 0 ] && say "RESULT: all checks passed" || say "RESULT: $FAILS check(s) FAILED"
[ "$FAILS" -eq 0 ]
