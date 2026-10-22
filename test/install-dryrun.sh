#!/bin/bash
# Installer test without root: build a test release (placeholder tools), run install-macos.sh --dry-run --prefix into a
# temporary folder, and check the tree, owners, modes, plists, setup token, backup key, repair run, tamper detection
# and the dry-run uninstall. Run: bash test/install-dryrun.sh   (also run by test/install.test.ts)
set -uo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd -P)
T=$(mktemp -d "${TMPDIR:-/tmp}/install-test.XXXXXX")
trap 'rm -rf "$T"' EXIT
FAILS=0
ok() { echo "ok   $*"; }
fail() { echo "FAIL $*"; FAILS=$((FAILS + 1)); }
check() { local what=$1; shift; if "$@" >/dev/null 2>&1; then ok "$what"; else fail "$what"; fi; }
eq() { if [ "$2" = "$3" ]; then ok "$1"; else fail "$1: got '$2', want '$3'"; fi; }
mode() { stat -f %Lp "$1"; }
owner() { awk -F'\t' -v p="$1" '$4 == p { o = $1 ":" $2 ":" $3 } END { print o }' "$P/.install-plan/owners.tsv"; }
pl() { plutil -extract "$2" raw -o - "$P/Library/LaunchDaemons/app.trina.drive.$1.plist" 2>/dev/null; }

NAME=trina-drive
CLI=tdrive
B="/Library/Application Support/$NAME"

# ---- a test release: real compiled binary (the backup CLI as entry), placeholder tools ----
(cd "$REPO" && bun scripts/build.ts --out "$T/dist" --entry src/backup/cli.ts --tools stub --daemons server,backup,worker --no-tar --version 0.0.1-test >/dev/null) \
  || { echo "FAIL build"; exit 1; }
REL="$T/dist/$NAME-0.0.1-test-darwin-$( [ "$(uname -m)" = arm64 ] && echo arm64 || echo x64 )"
check "release built" test -x "$REL/bin/$CLI"
check "release checksums verify" sh -c "cd '$REL' && shasum -a 256 -c --quiet SHA256SUMS"

# ---- refusals ----
OUT=$(bash "$REL/install-macos.sh" 2>&1); RC=$?
if [ "$(id -u)" != 0 ]; then
  eq "without root and without --dry-run it refuses" "$RC:$(echo "$OUT" | grep -c 'run as root')" "1:1"
fi
OUT=$(bash "$REL/install-macos.sh" --prefix "$T/x" 2>&1); RC=$?
eq "--prefix without --dry-run is refused" "$RC:$(echo "$OUT" | grep -c 'only for --dry-run')" "1:1"

# ---- dry run ----
P="$T/prefix"
OUT=$(bash "$REL/install-macos.sh" --dry-run --prefix "$P" --port 9000 --backup-dir /Volumes/TestDisk/trina-drive-backup 2>&1); RC=$?
eq "dry-run install exits 0" "$RC" 0
[ "$RC" = 0 ] || echo "$OUT"
F="$P$B"
for d in db drafts mirror backup-staging logs; do
  eq "$d/ mode 700" "$(mode "$F/$d")" 700
  eq "$d/ owned by _tdrive" "$(owner "$B/$d")" "_tdrive:_tdrive:700"
done
eq "base folder root 755" "$(owner "$B")" "root:wheel:755"
eq "config/ root:_tdrive 750" "$(owner "$B/config")" "root:_tdrive:750"
eq "setup/ root:admin 750" "$(owner "$B/setup")" "root:admin:750"
eq "work/ worker 700" "$(owner "$B/work")" "_tdrivework:_tdrivework:700"
eq "run/worker/ worker:server 750" "$(owner "$B/run/worker")" "_tdrivework:_tdrive:750"
eq "app/current -> versions/0.0.1-test" "$(readlink "$F/app/current")" "versions/0.0.1-test"
check "app binary present and executable" test -x "$F/app/versions/0.0.1-test/bin/$CLI"
check "app version owned by root (planned)" grep -qxF "chown -R root:wheel $(printf '%q' "$B/app/versions/0.0.1-test")" "$P/.install-plan/commands.txt"
eq "CLI link on PATH" "$(readlink "$P/usr/local/bin/$CLI")" "$B/app/current/bin/$CLI"
check "newsyslog config" grep -q "$B/logs/server.log _tdrive:_tdrive 600" "$P/etc/newsyslog.d/$NAME.conf"

# plists
for d in server backup worker; do
  f="$P/Library/LaunchDaemons/app.trina.drive.$d.plist"
  check "$d plist lints" plutil -lint "$f"
  eq "$d plist mode 644" "$(mode "$f")" 644
done
eq "server runs as _tdrive" "$(pl server UserName)" _tdrive
eq "server KeepAlive" "$(pl server KeepAlive)" true
eq "server ExitTimeOut" "$(pl server ExitTimeOut)" 30
eq "server program" "$(pl server ProgramArguments.0)" "$B/app/current/bin/$CLI"
eq "server port" "$(pl server ProgramArguments.7)" 9000
eq "server log" "$(pl server StandardErrorPath)" "$B/logs/server.log"
eq "server data env" "$(pl server EnvironmentVariables.TDRIVE_HOME)" "$B"
eq "server rg is the bundled one" "$(pl server EnvironmentVariables.TDRIVE_RG)" "$B/app/current/tools/bin/rg"
eq "server umask 077" "$(pl server Umask)" 63
eq "backup runs as _tdrive" "$(pl backup UserName)" _tdrive
eq "backup daily at 03:xx" "$(pl backup StartCalendarInterval.Hour)" 3
eq "backup command" "$(pl backup ProgramArguments.3) $(pl backup ProgramArguments.4) $(pl backup ProgramArguments.5)" "backup run --if-configured"
eq "worker runs as _tdrivework" "$(pl worker UserName)" _tdrivework
eq "worker log outside the server's folders" "$(pl worker StandardOutPath)" "$B/work/worker.log"
check "config parses" plutil -convert xml1 -o /dev/null "$F/config/server.json"
eq "config port" "$(plutil -extract listen.port raw -o - "$F/config/server.json")" 9000
eq "backup target" "$(plutil -extract target raw -o - "$F/db/backup.json")" /Volumes/TestDisk/trina-drive-backup
eq "backup.json owner" "$(owner "$B/db/backup.json")" "_tdrive:_tdrive:600"

# privileged steps are only planned
C="$P/.install-plan/commands.txt"
check "planned: create _tdrive" grep -q "dscl . -create /Users/_tdrive " "$C"
check "planned: create _tdrivework" grep -q "dscl . -create /Users/_tdrivework " "$C"
for d in server backup worker; do check "planned: bootstrap $d" grep -q "launchctl bootstrap system /Library/LaunchDaemons/app.trina.drive.$d.plist" "$C"; done
check "planned: backup folder" grep -q "/Volumes/TestDisk/trina-drive-backup" "$C"
check "nothing installed on this Mac" test ! -e "/Library/LaunchDaemons/app.trina.drive.server.plist"

# setup token: printed once, kept for admins, the server gets only its hash
TOKEN=$(cat "$F/setup/first-setup-token")
check "token format" sh -c "echo '$TOKEN' | grep -Eq '^tdrive_setup_[0-9a-f]{48}$'"
eq "token readable by admins only" "$(owner "$B/setup/first-setup-token")" "root:admin:640"
eq "server has the token's hash" "$(cat "$F/db/setup-token.sha256")" "$(printf '%s' "$TOKEN" | shasum -a 256 | awk '{print $1}')"
eq "token printed" "$(echo "$OUT" | grep -c "$TOKEN")" 1

# backup key: the secret is printed and stored nowhere; the public key opens nothing but encrypts for it
SECRET=$(echo "$OUT" | grep -Eo 'tdrive_bksec1_[A-Za-z0-9_-]{49}' | head -n 1)
check "backup secret printed" test -n "$SECRET"
check "backup secret not stored under the prefix" sh -c "! grep -rqF '$SECRET' '$P'"
eq "recipient owner" "$(owner "$B/config/backup-recipient")" "root:_tdrive:644"
D="$T/data"; mkdir -p "$D/db"
bun -e "import { openDb } from '$REPO/src/db.ts'; openDb('$D/db').close()"
mkdir -p "$T/bk"
check "backup with the installed public key" bun "$REPO/src/backup/cli.ts" --data "$D" run --to "$T/bk" --recipient "$F/config/backup-recipient" --allow-same-disk
printf '%s\n' "$SECRET" > "$T/secret"
check "the printed secret verifies it" bun "$REPO/src/backup/cli.ts" --data "$D" verify "$(ls "$T"/bk/*.bkp)" --key-file "$T/secret"

# ---- repair run: same token, same key ----
OUT2=$(bash "$REL/install-macos.sh" --dry-run --prefix "$P" --port 9000 2>&1); RC=$?
eq "second run exits 0" "$RC" 0
eq "token kept" "$(cat "$F/setup/first-setup-token")" "$TOKEN"
eq "no new secret on a repair run" "$(echo "$OUT2" | grep -c '_bksec1_')" 0
check "backup key kept" grep -q "kept from the earlier install" <<< "$OUT2"

# ---- tampered releases are refused ----
cp -R "$REL" "$T/bad1"; printf 'x' >> "$T/bad1/tools/bin/rg"
OUT=$(bash "$T/bad1/install-macos.sh" --dry-run --prefix "$T/p1" 2>&1); RC=$?
eq "changed file refused" "$RC:$(echo "$OUT" | grep -c SHA256SUMS)" "1:1"
cp -R "$REL" "$T/bad2"; echo evil > "$T/bad2/tools/bin/extra"
OUT=$(bash "$T/bad2/install-macos.sh" --dry-run --prefix "$T/p2" 2>&1); RC=$?
eq "unlisted file refused" "$RC:$(echo "$OUT" | grep -c 'does not list')" "1:1"

# ---- uninstall (dry run) ----
OUT=$(bash "$REL/uninstall-macos.sh" --dry-run --prefix "$P" 2>&1); RC=$?
eq "dry-run uninstall exits 0" "$RC" 0
[ "$RC" = 0 ] || echo "$OUT"
for p in app config setup run work; do check "removed $p/" test ! -e "$F/$p"; done
check "plists removed" sh -c "! ls '$P/Library/LaunchDaemons/'*.plist"
check "CLI link removed" test ! -L "$P/usr/local/bin/$CLI"
for d in db drafts mirror backup-staging logs; do check "kept $d/" test -d "$F/$d"; done
check "planned: delete accounts" grep -q "dscl . -delete /Users/_tdrive" "$P/.uninstall-plan/commands.txt"
OUT=$(bash "$REL/uninstall-macos.sh" --dry-run --prefix "$P" --delete-data 2>&1); RC=$?
eq "uninstall --delete-data exits 0" "$RC" 0
check "data removed with --delete-data" test ! -e "$F"

echo
if [ "$FAILS" -gt 0 ]; then echo "$FAILS check(s) failed"; exit 1; fi
echo "all checks passed"
