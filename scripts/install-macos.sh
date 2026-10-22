#!/bin/bash
# Server installer for macOS (an office Mac mini). Run it from an unpacked release folder (scripts/build.ts output):
#
#   sudo ./install-macos.sh [--listen ADDR] [--port N] [--backup-dir DIR] [--new-backup-key] [--no-power]
#        ./install-macos.sh --dry-run [--prefix DIR] [...]     no root: everything is written below DIR instead of /,
#                                                               privileged steps are only listed (DIR/.install-plan/)
#
#   --from DIR          release folder (default: the folder this script is in)
#   --listen ADDR       address the server listens on (default 0.0.0.0 = every interface: office LAN and VPN such as
#                       Tailscale). v0.1 is for LAN/VPN only: never forward a public port to it.
#   --port N            HTTP port (default 8787)
#   --backup-dir DIR    folder for scheduled encrypted backups, on an external disk (e.g. /Volumes/Backup/shelf);
#                       can be set later with `<name> backup target set`
#   --new-backup-key    make a new backup key even if one exists (older backups keep needing the old secret key)
#   --no-power          leave sleep and restart-after-power-failure settings alone (laptops, test installs)
#   --dry-run           change nothing on the system; with --prefix DIR (default: a new temporary folder)
#
# Idempotent: running it again repairs the install or switches to the release's version; data is kept.
#
# What it does (see docs/INSTALL.md):
#   1. checks the release (release.json, every file against SHA256SUMS, no unlisted files, CPU type, macOS version)
#   2. role accounts _shelf (server) and _shelfwork (workers): hidden, no login shell, no password (macos/common.sh)
#   3. /Library/Application Support/<name>/: app/ (root), config/ (root, readable by the server), setup/ (root:admin),
#      db, drafts, mirror, backup-staging, logs (server account, 0700), work/ and run/worker/ (worker account)
#   4. the app version folder (root-owned, so the server account cannot change what root or admins run) and the CLI
#      on PATH: /usr/local/bin/<name> -> app/current/bin/<name>
#   5. external tools: the release's pinned ripgrep and pdftotext; Homebrew's only as a fallback (with a warning)
#   6. the one-time first-setup token (there is no trusted loopback: first setup only with this token), and a backup
#      key pair whose SECRET half is printed once and never stored
#   7. LaunchDaemons <label>.server (KeepAlive), <label>.backup (daily), <label>.worker (when the release has one),
#      log rotation, Time Machine exclusions for caches, power settings, the application firewall
# shellcheck source-path=SCRIPTDIR
set -euo pipefail
umask 022
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
SCRIPT=install
HERE=$(cd "$(dirname "$0")" && pwd -P)
# shellcheck source=macos/common.sh
. "$HERE/macos/common.sh"

FROM="" DRY=0 PREFIX="" LISTEN=0.0.0.0 PORT=$DEFAULT_PORT BACKUP_DIR="" NEW_BACKUP_KEY=0 POWER=1
val() { [ $# -ge 2 ] && [ -n "$2" ] || die "$1 needs a value"; }
while [ $# -gt 0 ]; do
  case "$1" in
    --from) val "$@"; FROM=$2; shift 2 ;;
    --prefix) val "$@"; PREFIX=$2; shift 2 ;;
    --listen) val "$@"; LISTEN=$2; shift 2 ;;
    --port) val "$@"; PORT=$2; shift 2 ;;
    --backup-dir) val "$@"; BACKUP_DIR=$2; shift 2 ;;
    --new-backup-key) NEW_BACKUP_KEY=1; shift ;;
    --no-power) POWER=0; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"; exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
done

# ---- arguments and host ----
[ "$(uname -s)" = Darwin ] || die "macOS only"
if [ "$DRY" = 1 ]; then
  if [ -z "$PREFIX" ]; then PREFIX=$(mktemp -d "${TMPDIR:-/tmp}/$NAME-dry-run.XXXXXX"); fi
  mkdir -p "$PREFIX"
  PREFIX=$(cd "$PREFIX" && pwd -P)
  [ "$PREFIX" != / ] || die "--prefix / is not a dry run"
  PLAN_DIR="$PREFIX/.install-plan"
  mkdir -p "$PLAN_DIR"
  : > "$PLAN_DIR/commands.txt"
  : > "$PLAN_DIR/owners.tsv"
else
  [ -z "$PREFIX" ] || die "--prefix is only for --dry-run"
  [ "$(id -u)" = 0 ] || die "run as root (sudo), or with --dry-run to see what it would do"
fi
[[ "$LISTEN" =~ ^[0-9a-fA-F.:]{2,45}$ ]] || die "--listen takes an IP address (0.0.0.0, a LAN or Tailscale address)"
[[ "$PORT" =~ ^[0-9]{2,5}$ ]] && [ "$PORT" -ge 1024 ] && [ "$PORT" -le 65535 ] || die "--port must be 1024-65535"
for u in "$SRV_USER" "$WRK_USER"; do valid_account "$u" || die "bad account name $u (macos/common.sh)"; done
[ "$SRV_USER" != "$WRK_USER" ] || die "server and worker accounts must differ"

# ---- the release ----
[ -n "$FROM" ] || FROM=$HERE
[ -f "$FROM/release.json" ] || die "$FROM is not a release folder (no release.json); build one with: bun scripts/build.ts"
FROM=$(cd "$FROM" && pwd -P)
jget() { plutil -extract "$1" raw -o - "$FROM/release.json" 2>/dev/null || true; }
R_NAME=$(jget name) VERSION=$(jget version) TARGET=$(jget target) MIN_MACOS=$(jget minMacOS)
[ "$R_NAME" = "$NAME" ] || die "this release is for \"$R_NAME\", the installer is for \"$NAME\""
[[ "$VERSION" =~ ^[0-9A-Za-z][0-9A-Za-z.+_-]{0,49}$ ]] || die "bad version in release.json"
DAEMONS=" "
i=0
while D=$(plutil -extract "daemons.$i" raw -o - "$FROM/release.json" 2>/dev/null); do DAEMONS="$DAEMONS$D "; i=$((i + 1)); done
case "$DAEMONS" in *" server "*) ;; *) die "release.json lists no server daemon" ;; esac
[ -f "$FROM/SHA256SUMS" ] || die "$FROM/SHA256SUMS missing"
(cd "$FROM" && shasum -a 256 -c --quiet SHA256SUMS >/dev/null 2>&1) || die "the release does not match its SHA256SUMS (damaged or changed download); get it again"
EXTRA=$(cd "$FROM" && find . -type f ! -name SHA256SUMS ! -name .DS_Store | sed 's|^\./||' | sort | comm -23 - <(sed 's/^[0-9a-f]*  //' SHA256SUMS | sort))
[ -z "$EXTRA" ] || die "files in the release that SHA256SUMS does not list: $(echo "$EXTRA" | tr '\n' ' ')"
[ -x "$FROM/bin/$NAME" ] || die "$FROM/bin/$NAME missing"
if grep -q '"source": "stub"' "$FROM/tools.json" 2>/dev/null; then
  [ "$DRY" = 1 ] || die "this is a test build with placeholder tools (--tools stub); build a real release"
  warn "test build with placeholder tools"
fi
MACH=$(uname -m)
case "$TARGET:$MACH" in
  darwin-arm64:arm64|darwin-x64:x86_64) ;;
  *) if [ "$DRY" = 1 ]; then warn "release is $TARGET, this Mac is $MACH"; else die "release is $TARGET, this Mac is $MACH: use the matching release"; fi ;;
esac
OSV=$(sw_vers -productVersion)
if [ -n "$MIN_MACOS" ] && [ "$(printf '%s\n%s\n' "$MIN_MACOS" "$OSV" | sort -t. -k1,1n -k2,2n -k3,3n | head -n 1)" != "$MIN_MACOS" ]; then
  if [ "$DRY" = 1 ]; then warn "macOS $OSV is older than $MIN_MACOS"; else die "macOS $MIN_MACOS or later is needed (this Mac: $OSV)"; fi
fi

# ---- paths: logical (what the system and the files name) and on disk (below PREFIX in a dry run) ----
BASE="/Library/Application Support/$NAME"
LD=/Library/LaunchDaemons
BINLINK=/usr/local/bin/$NAME
NEWSYSLOG=/etc/newsyslog.d/$NAME.conf
F_BASE="$PREFIX$BASE" F_LD="$PREFIX$LD" F_BINLINK="$PREFIX$BINLINK" F_NEWSYSLOG="$PREFIX$NEWSYSLOG"
APP_CUR="$BASE/app/current"
ENVP=$(printf '%s' "$NAME" | tr 'a-z-' 'A-Z_')
SAFE_ROOTS=("$F_BASE" "$F_LD" "$PREFIX/usr/local/bin" "$PREFIX/etc/newsyslog.d")
say "installing $NAME $VERSION ($TARGET) from $FROM$([ "$DRY" = 1 ] && echo " -- DRY RUN into $PREFIX")"

# ---- role accounts ----
used_ids() { { dscl . -list /Users UniqueID; dscl . -list /Groups PrimaryGroupID; } | awk '{print $2}' | sort -n -u; }
free_id() {
  local used n
  used=$(used_ids)
  for n in $(seq "$UID_MIN" "$UID_MAX"); do
    if ! echo "$used" | grep -qx "$n"; then echo "$n"; return 0; fi
  done
  return 1
}
uattr() { dscl -plist . -read "/Users/$1" "$2" 2>/dev/null | plutil -extract "$3.0" raw -o - - 2>/dev/null || true; }
ensure_account() {  # name, description, home
  local name=$1 desc=$2 home=$3 uid gid
  if [ "$DRY" = 1 ]; then
    if dscl . -read "/Users/$name" UniqueID >/dev/null 2>&1; then priv "# account $name exists (would be checked: UID $UID_MIN-$UID_MAX, shell /usr/bin/false)"
    else priv "dscl . -create /Users/$name  # UID/GID = first free in $UID_MIN-$UID_MAX, UserShell /usr/bin/false, NFSHomeDirectory $home, IsHidden 1, Password '*'; group $name"; fi
    return 0
  fi
  if dscl . -read "/Users/$name" UniqueID >/dev/null 2>&1; then
    # an existing record is only checked: macOS asks the logged-in administrator to approve changes to it
    uid=$(uattr "$name" UniqueID dsAttrTypeStandard:UniqueID)
    [ -n "$uid" ] && [ "$uid" -ge "$UID_MIN" ] && [ "$uid" -le "$UID_MAX" ] || die "$name exists with UID $uid outside $UID_MIN-$UID_MAX; refusing to use it"
    [ "$(uattr "$name" UserShell dsAttrTypeStandard:UserShell)" = /usr/bin/false ] || die "$name exists with a login shell; refusing to use it"
  else
    uid=$(free_id) || die "no free UID in $UID_MIN-$UID_MAX"
    gid=$uid
    if dscl . -read "/Groups/$name" PrimaryGroupID >/dev/null 2>&1; then gid=$(dscl . -read "/Groups/$name" PrimaryGroupID | awk '{print $2}'); fi
    # dscl, not sysadminctl -roleAccount: unattended sysadminctl has ignored -UID and waited for approvals
    dscl . -create "/Users/$name" || die "could not create $name"
    dscl . -create "/Users/$name" UniqueID "$uid"
    dscl . -create "/Users/$name" PrimaryGroupID "$gid"
    dscl . -create "/Users/$name" UserShell /usr/bin/false
    dscl . -create "/Users/$name" NFSHomeDirectory "$home"
    dscl . -create "/Users/$name" RealName "$desc"
    dscl . -create "/Users/$name" IsHidden 1
    dscl . -create "/Users/$name" Password '*'
    say "created role account $name ($uid)"
  fi
  gid=$(dscl . -read "/Users/$name" PrimaryGroupID | awk '{print $2}')
  if ! dscl . -read "/Groups/$name" PrimaryGroupID >/dev/null 2>&1; then
    dseditgroup -o create -i "$gid" -r "$desc" "$name" || die "could not create group $name"
  fi
  [ "$(dscl . -read "/Groups/$name" PrimaryGroupID | awk '{print $2}')" = "$gid" ] || die "group $name does not have GID $gid"
}
ensure_account "$SRV_USER" "$NAME server" "$BASE/db"
ensure_account "$WRK_USER" "$NAME worker" /var/empty
SRV_GRP=$SRV_USER WRK_GRP=$WRK_USER

# ---- repair run: stop our daemons and every process of the role accounts before touching their folders ----
for d in server backup worker; do priv launchctl bootout "system/$LABEL.$d" >/dev/null 2>&1 || true; done
if [ "$DRY" = 0 ]; then
  for u in "$SRV_USER" "$WRK_USER"; do
    uid=$(id -u "$u")
    launchctl bootout "user/$uid" >/dev/null 2>&1 || true
    for i in 1 2 3 4 5; do pkill -KILL -u "$uid" >/dev/null 2>&1 || true; pgrep -u "$uid" >/dev/null 2>&1 || break; sleep 0.2; done
    ! pgrep -u "$uid" >/dev/null 2>&1 || die "processes of $u keep running; stop them and run the installer again"
  done
fi

# ---- folders ----
mkdir -p "$(dirname "$F_BASE")"
mk root wheel 755 "$F_BASE"
ITMP="$F_BASE/.install-tmp"
rm -rf "$ITMP"; mkdir -m 700 "$ITMP"; [ "$DRY" = 1 ] || chown root:wheel "$ITMP"
trap 'rm -rf "$ITMP"' EXIT
# data kept by an earlier uninstall was given to root: hand it back (folders and single-link files only, so a hard
# link a role account made to another file is never chowned)
for d in $DATA_DIRS; do
  if [ "$DRY" = 0 ] && [ -d "$F_BASE/$d" ] && [ ! -L "$F_BASE/$d" ] && [ "$(stat -f %Su "$F_BASE/$d")" != "$SRV_USER" ]; then
    find "$F_BASE/$d" \( -type d -o \( -type f -links 1 \) \) \( -user root -o -nouser \) -exec chown -h "$SRV_USER:$SRV_GRP" {} +
    say "gave the kept $d/ back to $SRV_USER"
  fi
  mk "$SRV_USER" "$SRV_GRP" 700 "$F_BASE/$d"
done
mk root wheel 755 "$F_BASE/app"
mk root wheel 755 "$F_BASE/app/versions"
mk root "$SRV_GRP" 750 "$F_BASE/config"
mk root admin 750 "$F_BASE/setup"
mk "$WRK_USER" "$WRK_GRP" 700 "$F_BASE/work"
mk root wheel 755 "$F_BASE/run"
# the worker creates its socket here; group = server, so only the server can connect
mk "$WRK_USER" "$SRV_GRP" 750 "$F_BASE/run/worker"

# ---- app version (root-owned: the server account must not be able to change what root and admins run) ----
DEST="$F_BASE/app/versions/$VERSION"
nolink "$DEST"
rm -rf "$DEST.partial"; mkdir -p "$DEST.partial"
for p in bin tools release.json tools.json docs; do [ -e "$FROM/$p" ] && cp -R "$FROM/$p" "$DEST.partial/"; done
find "$DEST.partial" -type d -exec chmod 755 {} +
find "$DEST.partial" -type f -exec chmod 644 {} +
chmod 755 "$DEST.partial/bin/$NAME"
[ -d "$DEST.partial/tools/bin" ] && chmod 755 "$DEST.partial/tools/bin/"*
if [ "$DRY" = 1 ]; then priv chown -R root:wheel "$BASE/app/versions/$VERSION"; else chown -R root:wheel "$DEST.partial"; fi
rm -rf "$DEST"; mv "$DEST.partial" "$DEST"
PREV=$(readlink "$F_BASE/app/current" 2>/dev/null || true)
ln -sfn "versions/$VERSION" "$ITMP/current"
mv -f "$ITMP/current" "$F_BASE/app/" # rename over the old link: never a moment without app/current
[ "$DRY" = 1 ] && printf 'root\twheel\tlink\t%s\n' "$BASE/app/current" >> "$PLAN_DIR/owners.tsv"
# keep the running version and the one before it (to go back: run the older release's installer)
for v in "$F_BASE/app/versions/"*; do
  b=$(basename "$v")
  [ "$b" = "$VERSION" ] || [ "versions/$b" = "$PREV" ] || rm -rf "$v"
done
[ -n "$PREV" ] && [ "$PREV" != "versions/$VERSION" ] && say "switched ${PREV#versions/} -> $VERSION (${PREV#versions/} kept in app/versions)"
APP_BIN="$F_BASE/app/versions/$VERSION/bin/$NAME"

# ---- external tools: bundled (pinned, verified above) or Homebrew's as a fallback ----
TOOL=""
find_tool() {  # name -> TOOL = logical path, or empty (not a $(...) call: warnings must reach WARNINGS)
  TOOL=""
  if [ -x "$F_BASE/app/versions/$VERSION/tools/bin/$1" ]; then TOOL="$APP_CUR/tools/bin/$1"; return 0; fi
  local d
  for d in /opt/homebrew/bin /usr/local/bin; do
    if [ -x "$d/$1" ]; then
      warn "$1 is not in this release: using Homebrew's $d/$1 (not pinned, and replaceable by whoever owns Homebrew; build a release with bundled tools for production)"
      TOOL="$d/$1"; return 0
    fi
  done
  return 0
}
find_tool rg; RG=$TOOL
find_tool pdftotext; PDFTOTEXT=$TOOL
[ -n "$RG" ] || warn "ripgrep (rg) not found: search will not work until a release with tools is installed (or brew install ripgrep)"
[ -n "$PDFTOTEXT" ] || warn "pdftotext not found: PDFs will not be readable (or brew install poppler)"

# ---- config (root-owned, the server reads it) ----
jstr() { printf '"%s"' "$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')"; }
cat > "$ITMP/server.json" <<EOF
{
  "name": $(jstr "$NAME"),
  "version": $(jstr "$VERSION"),
  "dataDir": $(jstr "$BASE"),
  "layout": "installed",
  "listen": { "host": $(jstr "$LISTEN"), "port": $PORT },
  "tools": { "rg": $(jstr "$RG"), "pdftotext": $(jstr "$PDFTOTEXT") },
  "workerUser": $(jstr "$WRK_USER"),
  "workerSocket": $(jstr "$BASE/run/worker/worker.sock")
}
EOF
plutil -convert xml1 -o /dev/null "$ITMP/server.json" || die "server.json does not parse" # (plutil reads JSON)
put "$ITMP/server.json" root "$SRV_GRP" 640 "$F_BASE/config/server.json"

# ---- backup target (optional now; `<name> backup target set` later) ----
if [ -n "$BACKUP_DIR" ]; then
  case "$BACKUP_DIR" in /*) ;; *) die "--backup-dir must be an absolute path" ;; esac
  case "$BACKUP_DIR" in *'"'*|*\\*) die "--backup-dir may not contain quotes or backslashes" ;; esac
  case "$BACKUP_DIR/" in "$BASE/"*) die "--backup-dir cannot be inside $BASE" ;; esac
  case "$BACKUP_DIR" in /Volumes/*) ;; *) warn "--backup-dir $BACKUP_DIR is not on an external volume (/Volumes/...): a backup on the server's own disk does not survive losing that disk" ;; esac
  if [ "$DRY" = 1 ]; then priv "mkdir -p '$BACKUP_DIR' && chown $SRV_USER:$SRV_GRP '$BACKUP_DIR' && chmod 700 '$BACKUP_DIR'"
  else
    [ -d "$(dirname "$BACKUP_DIR")" ] || die "$(dirname "$BACKUP_DIR") does not exist (is the disk connected?)"
    mkdir -p "$BACKUP_DIR"; chown "$SRV_USER:$SRV_GRP" "$BACKUP_DIR"; chmod 700 "$BACKUP_DIR"
  fi
  printf '{\n  "target": %s,\n  "keep": %s\n}\n' "$(jstr "$BACKUP_DIR")" "$BACKUP_KEEP" > "$ITMP/backup.json"
  put "$ITMP/backup.json" "$SRV_USER" "$SRV_GRP" 600 "$F_BASE/db/backup.json"
fi

# ---- one-time first-setup token (plan 7.1: loopback is not trusted; first setup only with this token) ----
# setup/first-setup-token: for the Mac's administrators (root:admin 0640); db/setup-token.sha256: what the server
# checks, deleted by the server once the first account exists. Not made again after setup is done.
NEW_SETUP_TOKEN=""
if [ ! -f "$F_BASE/db/store.db" ] || [ -f "$F_BASE/db/setup-token.sha256" ]; then
  if [ -f "$F_BASE/setup/first-setup-token" ] && [ -f "$F_BASE/db/setup-token.sha256" ]; then
    say "first setup still pending: the token made earlier stays valid ($BASE/setup/first-setup-token)"
  else
    NEW_SETUP_TOKEN="${NAME}_setup_$(openssl rand -hex 24)"
    (umask 077 && printf '%s\n' "$NEW_SETUP_TOKEN" > "$ITMP/token")
    printf '%s' "$NEW_SETUP_TOKEN" | shasum -a 256 | awk '{print $1}' > "$ITMP/token.sha256"
    put "$ITMP/token" root admin 640 "$F_BASE/setup/first-setup-token"
    put "$ITMP/token.sha256" "$SRV_USER" "$SRV_GRP" 600 "$F_BASE/db/setup-token.sha256"
    rm -f "$ITMP/token" "$ITMP/token.sha256"
  fi
fi

# ---- backup key: public half on the server, secret half printed once (never written anywhere) ----
BACKUP_SECRET="" BACKUP_FPR=""
if [ ! -f "$F_BASE/config/backup-recipient" ] || [ "$NEW_BACKUP_KEY" = 1 ]; then
  # the release's own binary (root-owned copy), from the root-only staging folder, with no inherited environment
  if OUT=$(cd "$ITMP" && env -i PATH=/usr/bin:/bin HOME="$ITMP" TMPDIR="$ITMP" "$APP_BIN" backup keygen --recipient-out "$ITMP/recipient" 2>"$ITMP/keygen.err") \
     && [ -s "$ITMP/recipient" ]; then
    BACKUP_SECRET=$(printf '%s\n' "$OUT" | grep '_bksec1_' | head -n 1)
    BACKUP_FPR=$(sed -n 's/^backup key \([0-9a-f-]*\)\..*/\1/p' "$ITMP/keygen.err" | head -n 1)
    [ -n "$BACKUP_SECRET" ] || die "backup keygen printed no secret key"
    put "$ITMP/recipient" root "$SRV_GRP" 644 "$F_BASE/config/backup-recipient"
  else
    warn "could not make the backup key ($(head -c 300 "$ITMP/keygen.err" 2>/dev/null)); later: sudo $NAME --data \"$BASE\" backup keygen --set"
  fi
  rm -f "$ITMP/recipient" "$ITMP/keygen.err"
  unset OUT
fi

# ---- LaunchDaemons ----
plist_env() {  # key=value ... -> <dict> body
  local kv
  for kv in "$@"; do printf '<key>%s</key><string>%s</string>' "$(xml "${kv%%=*}")" "$(xml "${kv#*=}")"; done
}
write_plist() {  # name user group log extra-xml envxml args...
  local name=$1 user=$2 group=$3 log=$4 extra=$5 envxml=$6 a; shift 6
  local f="$ITMP/$LABEL.$name.plist"
  {
    echo '<?xml version="1.0" encoding="UTF-8"?>'
    echo '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
    echo '<plist version="1.0"><dict>'
    echo "  <key>Label</key><string>$LABEL.$name</string>"
    echo "  <key>UserName</key><string>$user</string>"
    echo "  <key>GroupName</key><string>$group</string>"
    echo '  <key>ProgramArguments</key><array>'
    for a in "$@"; do printf '    <string>%s</string>\n' "$(xml "$a")"; done
    echo '  </array>'
    echo "  <key>EnvironmentVariables</key><dict>$envxml</dict>"
    echo "  <key>Umask</key><integer>63</integer>"
    echo "  <key>StandardOutPath</key><string>$(xml "$log")</string>"
    echo "  <key>StandardErrorPath</key><string>$(xml "$log")</string>"
    printf '%s\n' "$extra"
    echo '</dict></plist>'
  } > "$f"
  plutil -lint "$f" >/dev/null || { cat "$f" >&2; die "bad plist for $LABEL.$name"; }
  nolink "$F_LD"
  mkdir -p "$F_LD"
  put "$f" root wheel 644 "$F_LD/$LABEL.$name.plist"
  rm -f "$f"
}
COMMON_ENV=("PATH=/usr/bin:/bin:/usr/sbin:/sbin" "${ENVP}_HOME=$BASE" "${ENVP}_CONFIG=$BASE/config/server.json" "${ENVP}_LAYOUT=installed"
  "${ENVP}_RG=$RG" "${ENVP}_PDFTOTEXT=$PDFTOTEXT" "${ENVP}_WORKER_USER=$WRK_USER" "LANG=en_US.UTF-8")
LIMITS='  <key>SoftResourceLimits</key><dict><key>NumberOfFiles</key><integer>8192</integer></dict>
  <key>HardResourceLimits</key><dict><key>NumberOfFiles</key><integer>8192</integer></dict>'
# server: always up; launchd waits ExitTimeOut seconds after SIGTERM before SIGKILL (finish requests, close the DB)
write_plist server "$SRV_USER" "$SRV_GRP" "$BASE/logs/server.log" \
  "  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>ExitTimeOut</key><integer>30</integer>
  <key>ProcessType</key><string>Standard</string>
  <key>WorkingDirectory</key><string>$(xml "$BASE/db")</string>
$LIMITS" \
  "$(plist_env "${COMMON_ENV[@]}" "HOME=$BASE/db")" \
  "$APP_CUR/bin/$NAME" --data "$BASE" serve --host "$LISTEN" --port "$PORT"
# backup: once a day; does nothing until a target and a key are configured
if [[ "$DAEMONS" == *" backup "* ]]; then
  write_plist backup "$SRV_USER" "$SRV_GRP" "$BASE/logs/backup.log" \
    "  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>$BACKUP_HOUR</integer><key>Minute</key><integer>$BACKUP_MINUTE</integer></dict>
  <key>RunAtLoad</key><false/>
  <key>ExitTimeOut</key><integer>120</integer>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>Nice</key><integer>10</integer>
  <key>WorkingDirectory</key><string>$(xml "$BASE/db")</string>" \
    "$(plist_env "${COMMON_ENV[@]}" "HOME=$BASE/db")" \
    "$APP_CUR/bin/$NAME" --data "$BASE" backup run --if-configured
fi
# worker (only when the release has it): extraction and shell commands, sandboxed, as the worker account
if [[ "$DAEMONS" == *" worker "* ]]; then
  write_plist worker "$WRK_USER" "$WRK_GRP" "$BASE/work/worker.log" \
    "  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>ExitTimeOut</key><integer>10</integer>
  <key>ProcessType</key><string>Standard</string>
  <key>WorkingDirectory</key><string>$(xml "$BASE/work")</string>
$LIMITS" \
    "$(plist_env "PATH=/usr/bin:/bin" "HOME=$BASE/work" "TMPDIR=$BASE/work/" "${ENVP}_RG=$RG" "${ENVP}_PDFTOTEXT=$PDFTOTEXT" "LANG=en_US.UTF-8")" \
    "$APP_CUR/bin/$NAME" worker --socket "$BASE/run/worker/worker.sock"
else
  rm -f "$F_LD/$LABEL.worker.plist"
fi

# ---- log rotation (launchd output only; newsyslog runs as root) ----
cat > "$ITMP/newsyslog.conf" <<EOF
# $NAME daemon output. logfilename [owner:group] mode count size(KB) when flags
$BASE/logs/server.log $SRV_USER:$SRV_GRP 600 7 10240 * NZ
$BASE/logs/backup.log $SRV_USER:$SRV_GRP 600 7 1024 * NZ
$BASE/work/worker.log $WRK_USER:$WRK_GRP 600 3 10240 * NZ
EOF
mkdir -p "$(dirname "$F_NEWSYSLOG")"
put "$ITMP/newsyslog.conf" root wheel 644 "$F_NEWSYSLOG"

# ---- the CLI on PATH ----
mkdir -p "$(dirname "$F_BINLINK")"
if [ -e "$F_BINLINK" ] || [ -L "$F_BINLINK" ]; then
  [ -L "$F_BINLINK" ] && [ "$(readlink "$F_BINLINK")" = "$APP_CUR/bin/$NAME" ] || die "$BINLINK exists and is not this installer's link; move it away first"
fi
ln -sfn "$APP_CUR/bin/$NAME" "$ITMP/cli-link"
mv -f "$ITMP/cli-link" "$F_BINLINK"
[ "$DRY" = 1 ] && printf 'root\twheel\tlink\t%s\n' "$BINLINK" >> "$PLAN_DIR/owners.tsv"

# ---- caches out of Time Machine, power, firewall ----
for d in mirror backup-staging; do priv tmutil addexclusion -p "$BASE/$d" >/dev/null 2>&1 || warn "Time Machine exclusion of $d failed"; done
if [ "$POWER" = 1 ]; then priv pmset -a sleep 0 autorestart 1 >/dev/null 2>&1 || warn "pmset failed (sleep / restart after power failure unchanged)"; fi
FW=/usr/libexec/ApplicationFirewall/socketfilterfw
REAL_BIN="$BASE/app/versions/$VERSION/bin/$NAME"
if [ "$DRY" = 1 ]; then
  priv "$FW --add '$REAL_BIN' && $FW --unblockapp '$REAL_BIN'  # only when the firewall is on"
elif "$FW" --getglobalstate 2>/dev/null | grep -qi enabled; then
  if ! { "$FW" --add "$REAL_BIN" >/dev/null 2>&1 && "$FW" --unblockapp "$REAL_BIN" >/dev/null 2>&1; }; then warn "could not allow $REAL_BIN in the application firewall; allow incoming connections for it in System Settings > Network > Firewall"; fi
fi

# ---- start ----
for d in worker server backup; do
  [ -f "$F_LD/$LABEL.$d.plist" ] || continue
  priv launchctl enable "system/$LABEL.$d"
  priv launchctl bootstrap system "$LD/$LABEL.$d.plist" || die "launchctl bootstrap $LABEL.$d failed"
done
if [ "$DRY" = 0 ]; then
  ok=0
  for i in $(seq 1 30); do if nc -z -G 1 127.0.0.1 "$PORT" >/dev/null 2>&1; then ok=1; break; fi; sleep 1; done
  [ "$ok" = 1 ] || warn "the server does not answer on port $PORT yet; see $BASE/logs/server.log (sudo tail)"
fi

# ---- next steps ----
HOSTNAME_LOCAL="$(scutil --get LocalHostName 2>/dev/null || echo this-mac).local"
echo
say "installed $NAME $VERSION: server as $SRV_USER, workers as $WRK_USER, data in $BASE"
echo
echo "Next steps"
echo "  1. First setup: open http://$HOSTNAME_LOCAL:$PORT/setup from a computer on the office network."
if [ -n "$NEW_SETUP_TOKEN" ]; then
  echo "     One-time setup token (also readable by Mac administrators: sudo cat \"$BASE/setup/first-setup-token\"):"
  echo
  echo "        $NEW_SETUP_TOKEN"
  echo
fi
echo "     Nobody, not even a request from this Mac itself, can do first setup without this token."
if [ -n "$BACKUP_SECRET" ]; then
  echo "  2. BACKUP SECRET KEY (key ${BACKUP_FPR:-?}). Shown ONCE, stored NOWHERE. Without it no backup can be restored."
  echo "     Write it down or save it in a password manager now, away from this Mac:"
  echo
  echo "        $BACKUP_SECRET"
  echo
  unset BACKUP_SECRET
else
  echo "  2. Backup key: kept from the earlier install (to make a new one: rerun with --new-backup-key)."
fi
if [ -n "$BACKUP_DIR" ]; then
  echo "  3. Backups: daily at $(printf '%02d:%02d' "$BACKUP_HOUR" "$BACKUP_MINUTE") to $BACKUP_DIR (newest $BACKUP_KEEP kept)."
else
  echo "  3. Backups are on but have no target yet. Connect an external disk, then:"
  echo "        sudo mkdir -p /Volumes/<disk>/$NAME-backup && sudo chown $SRV_USER /Volumes/<disk>/$NAME-backup"
  echo "        sudo -u $SRV_USER $NAME --data \"$BASE\" backup target set /Volumes/<disk>/$NAME-backup"
fi
echo "     NOT backed up by $NAME: the original files in your registered folders (NAS shares). Use the NAS's own"
echo "     backup (e.g. Synology Hyper Backup / snapshots) for those."
echo "  4. Exposure: LAN or VPN (e.g. Tailscale) only. Do not forward a router port to this Mac or give it a public address."
echo "  5. Status: sudo launchctl print system/$LABEL.server | grep -E 'state|pid'   logs: sudo tail \"$BASE/logs/server.log\""
if [ "$DRY" = 1 ]; then
  echo
  say "DRY RUN: files are below $PREFIX; privileged commands that would run: $PLAN_DIR/commands.txt; owners: $PLAN_DIR/owners.tsv"
fi
if [ ${#WARNINGS[@]} -gt 0 ]; then echo; say "${#WARNINGS[@]} warning(s):"; printf '  %s\n' "${WARNINGS[@]}"; fi
exit 0
