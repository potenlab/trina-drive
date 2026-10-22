#!/bin/bash
# Uninstaller for macOS. Idempotent.
#
#   sudo ./uninstall-macos.sh [--delete-data] [--keep-accounts]
#        ./uninstall-macos.sh --dry-run --prefix DIR [...]   (against a tree made by install-macos.sh --dry-run)
#
# Stops and removes the LaunchDaemons, the CLI link, log rotation, firewall and Time Machine entries, the app, config,
# setup token, worker folders and the role accounts (unless --keep-accounts). The data (db, drafts, mirror,
# backup-staging, logs) stays unless --delete-data; kept data is handed to root so no deleted UID owns it, and the
# installer gives it back to the server account. Backups on the external disk are never touched. At the end it lists
# whatever is still there and exits 1 if anything is.
# shellcheck source-path=SCRIPTDIR
set -uo pipefail
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
SCRIPT=uninstall
HERE=$(cd "$(dirname "$0")" && pwd -P)
# shellcheck source=macos/common.sh
. "$HERE/macos/common.sh"

DRY=0 PREFIX="" DELETE_DATA=0 KEEP_ACCOUNTS=0
while [ $# -gt 0 ]; do
  case "$1" in
    --delete-data) DELETE_DATA=1; shift ;;
    --keep-accounts) KEEP_ACCOUNTS=1; shift ;;
    --dry-run) DRY=1; shift ;;
    --prefix) [ $# -ge 2 ] || die "--prefix needs a value"; PREFIX=$2; shift 2 ;;
    -h|--help) awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"; exit 0 ;;
    *) die "unknown option $1" ;;
  esac
done
if [ "$DRY" = 1 ]; then
  [ -n "$PREFIX" ] && [ -d "$PREFIX" ] || die "--dry-run needs --prefix DIR (a tree made by install-macos.sh --dry-run)"
  PREFIX=$(cd "$PREFIX" && pwd -P)
  [ "$PREFIX" != / ] || die "--prefix / is not a dry run"
  PLAN_DIR="$PREFIX/.uninstall-plan"
  mkdir -p "$PLAN_DIR"; : > "$PLAN_DIR/commands.txt"; : > "$PLAN_DIR/owners.tsv"
else
  [ -z "$PREFIX" ] || die "--prefix is only for --dry-run"
  [ "$(id -u)" = 0 ] || die "run as root (sudo)"
fi

BASE="/Library/Application Support/$NAME"
LD=/Library/LaunchDaemons
BINLINK=/usr/local/bin/$CLI
NEWSYSLOG=/etc/newsyslog.d/$NAME.conf
F_BASE="$PREFIX$BASE"
account_exists() { [ "$DRY" = 0 ] && dscl . -read "/Users/$1" >/dev/null 2>&1; }

limited() {  # seconds command...: macOS may wait for an administrator's approval nobody gives
  local secs=$1 pid _; shift
  "$@" >/dev/null 2>&1 & pid=$!
  for _ in $(seq 1 "$secs"); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
  if kill -0 "$pid" 2>/dev/null; then kill -9 "$pid" >/dev/null 2>&1; wait "$pid" >/dev/null 2>&1; return 124; fi
  wait "$pid"
}

# 1) daemons: the server first (it finishes requests on SIGTERM)
for d in server backup worker; do
  priv launchctl bootout "system/$LABEL.$d" >/dev/null 2>&1 || true
  rm -f "$PREFIX$LD/$LABEL.$d.plist"
done
for u in "$SRV_USER" "$WRK_USER"; do
  if account_exists "$u"; then launchctl bootout "user/$(id -u "$u")" >/dev/null 2>&1 || true; pkill -KILL -u "$(id -u "$u")" >/dev/null 2>&1 || true; fi
done

# 2) system entries
if [ -L "$PREFIX$BINLINK" ] && [ "$(readlink "$PREFIX$BINLINK")" = "$BASE/app/current/bin/$CLI" ]; then rm -f "$PREFIX$BINLINK"; fi
rm -f "$PREFIX$NEWSYSLOG"
FW=/usr/libexec/ApplicationFirewall/socketfilterfw
for v in "$F_BASE/app/versions/"*; do
  [ -e "$v" ] || continue
  priv "$FW" --remove "$BASE/app/versions/$(basename "$v")/bin/$CLI" >/dev/null 2>&1 || true
done
for d in mirror backup-staging; do
  [ -e "$F_BASE/$d" ] || continue
  if [ "$DRY" = 1 ]; then priv tmutil removeexclusion -p "$BASE/$d"; else limited 15 tmutil removeexclusion -p "$BASE/$d" || true; fi
done

# 3) files
rm -rf "$F_BASE/app" "$F_BASE/config" "$F_BASE/setup" "$F_BASE/run" "$F_BASE/work" "$F_BASE/.install-tmp"
if [ "$DELETE_DATA" = 1 ]; then
  rm -rf "$F_BASE"
elif [ -d "$F_BASE" ]; then
  # folders and single-link files only: a hard link the server account made to some other file must not be chowned
  if [ "$KEEP_ACCOUNTS" = 0 ]; then
    for d in $DATA_DIRS; do
      [ -d "$F_BASE/$d" ] && [ ! -L "$F_BASE/$d" ] || continue
      if [ "$DRY" = 1 ]; then priv "find '$BASE/$d' \\( -type d -o \\( -type f -links 1 \\) \\) -exec chown -h root:wheel {} +"
      else find "$F_BASE/$d" \( -type d -o \( -type f -links 1 \) \) -exec chown -h root:wheel {} +; fi
    done
  fi
  say "kept the data in $BASE ($DATA_DIRS); --delete-data removes it. Backups on external disks are not touched."
fi

# 4) accounts and groups (macOS may ask the logged-in administrator to approve deleting a user record; each step
# gets a time limit, and the account is locked first so a refused deletion still leaves no usable account)
if [ "$KEEP_ACCOUNTS" = 0 ]; then
  for u in "$WRK_USER" "$SRV_USER"; do
    if [ "$DRY" = 1 ]; then priv dscl . -delete "/Users/$u"; priv dseditgroup -o delete "$u"; continue; fi
    if dscl . -read "/Users/$u" >/dev/null 2>&1; then
      limited 20 dscl . -create "/Users/$u" UserShell /usr/bin/false
      limited 20 dscl . -create "/Users/$u" Password '*'
      limited 20 dscl . -create "/Users/$u" AuthenticationAuthority ';DisabledUser;'
      limited 60 dscl . -delete "/Users/$u"
      dscl . -read "/Users/$u" >/dev/null 2>&1 && say "macOS did not let this session delete $u (administrator approval needed); it stays locked"
    fi
    if dscl . -read "/Groups/$u" >/dev/null 2>&1; then
      dseditgroup -o delete "$u" >/dev/null 2>&1 || dscl . -delete "/Groups/$u" >/dev/null 2>&1 || say "could not delete group $u"
    fi
  done
fi

# 5) leftovers
LEFT=()
for d in server backup worker; do
  [ -e "$PREFIX$LD/$LABEL.$d.plist" ] && LEFT+=("$LD/$LABEL.$d.plist")
  [ "$DRY" = 0 ] && launchctl print "system/$LABEL.$d" >/dev/null 2>&1 && LEFT+=("launchd job system/$LABEL.$d")
done
if [ "$KEEP_ACCOUNTS" = 0 ]; then
  for u in "$SRV_USER" "$WRK_USER"; do
    account_exists "$u" && LEFT+=("user $u (locked; delete it while logged in: sudo dscl . -delete /Users/$u)")
  done
fi
[ -e "$PREFIX$BINLINK" ] || [ -L "$PREFIX$BINLINK" ] && LEFT+=("$BINLINK (not this installer's link)")
[ -e "$PREFIX$NEWSYSLOG" ] && LEFT+=("$NEWSYSLOG")
for p in app config setup run work; do [ -e "$F_BASE/$p" ] && LEFT+=("$BASE/$p"); done
[ "$DELETE_DATA" = 1 ] && [ -e "$F_BASE" ] && LEFT+=("$BASE")
if [ ${#LEFT[@]} -gt 0 ]; then say "left over:"; printf '  %s\n' "${LEFT[@]}"; exit 1; fi
say "removed $NAME$([ "$DRY" = 1 ] && echo " (dry run below $PREFIX; commands: $PLAN_DIR/commands.txt)")"
