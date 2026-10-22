# Shared by install-macos.sh and uninstall-macos.sh (bash 3.2, sourced). Every name the installation uses is here.
# shellcheck shell=bash disable=SC2034,SC2154
# (names are used by the scripts that source this; SCRIPT, PREFIX, PLAN_DIR, SAFE_ROOTS, ITMP come from them)
# NAME, CLI and LABEL must equal NAME, CLI and LAUNCHD_LABEL in src/brand.ts (scripts/build.ts checks them).
NAME=trina-drive           # data folder /Library/Application Support/$NAME, newsyslog file, release folder names
CLI=tdrive                 # the command: bin/$CLI in a release, /usr/local/bin/$CLI; also TDRIVE_* and tdrive_setup_
SRV_USER=_tdrive           # runs the server (HTTP, database, drafts, backups); owns the data folders
WRK_USER=_tdrivework       # runs extraction and shell workers in a sandbox; sees no data folder and no NAS mount
LABEL=app.trina.drive      # LaunchDaemons: $LABEL.server, $LABEL.backup, $LABEL.worker
DEFAULT_PORT=8787
UID_MIN=450                # role accounts take the first free UID/GID in this range (hidden, no login)
UID_MAX=499
DATA_DIRS="db drafts mirror backup-staging logs" # owned by $SRV_USER, mode 0700
BACKUP_HOUR=3              # daily scheduled backup (skipped until a target and key are configured)
BACKUP_MINUTE=17
BACKUP_KEEP=14

# ---- output ----
WARNINGS=()
die() { echo "$SCRIPT: $*" >&2; exit 1; }
say() { echo "$SCRIPT: $*"; }
warn() { WARNINGS+=("$*"); echo "$SCRIPT: warning: $*" >&2; }

# ---- privileged actions: run for real, or (dry run) only written to the plan ----
# DRY=1 and PLAN_DIR must be set by the caller for a dry run.
priv() {
  if [ "${DRY:-0}" = 1 ]; then
    # one argument: a description written as is; several: the command, quoted so it can be pasted
    local line="$1"
    if [ $# -gt 1 ]; then line=$(printf '%q ' "$@"); line=${line% }; fi
    printf '%s\n' "$line" >> "$PLAN_DIR/commands.txt"
    return 0
  fi
  "$@"
}

# own OWNER GROUP MODE FSPATH: set mode always, owner for real (dry run: recorded in owners.tsv by logical path)
own() {
  chmod -h "$3" "$4" 2>/dev/null || chmod "$3" "$4"
  if [ "${DRY:-0}" = 1 ]; then
    printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "${4#"$PREFIX"}" >> "$PLAN_DIR/owners.tsv"
  else
    chown -h "$1:$2" "$4"
  fi
}

# nolink FSPATH: inside SAFE_ROOTS and no component is a symbolic link. Root works in folders the role accounts own;
# a link planted there must never turn a root write or chown into one somewhere else.
nolink() {
  local cur="" part r ok=0
  for r in "${SAFE_ROOTS[@]}"; do case "$1" in "$r"|"$r"/*) ok=1 ;; esac; done
  [ "$ok" = 1 ] || die "internal: $1 is outside the install folders"
  local -a parts
  IFS=/ read -ra parts <<< "${1#/}"
  for part in "${parts[@]}"; do
    [ -n "$part" ] || continue
    [ "$part" != .. ] || die "$1: '..' in a path"
    cur="$cur/$part"
    if [ -L "$cur" ]; then die "$cur is a symbolic link; refusing to continue (was the install changed by another account?)"; fi
  done
  return 0
}

# mk OWNER GROUP MODE FSPATH: a folder with a fixed owner and mode
mk() { nolink "$4"; mkdir -p "$4"; nolink "$4"; own "$1" "$2" "$3" "$4"; }

# put SRC OWNER GROUP MODE FSDEST: write in the root-only staging folder, set owner and mode there, rename into place
# (a rename replaces a planted link instead of writing through it)
put() {
  local t
  nolink "$(dirname "$5")"
  if [ -d "$5" ] && [ ! -L "$5" ]; then die "$5 is a folder"; fi
  t=$(mktemp "$ITMP/put.XXXXXX")
  cat "$1" > "$t"
  chmod "$4" "$t"
  if [ "${DRY:-0}" = 1 ]; then
    printf '%s\t%s\t%s\t%s\n' "$2" "$3" "$4" "${5#"$PREFIX"}" >> "$PLAN_DIR/owners.tsv"
  else
    chown "$2:$3" "$t"
  fi
  if [ -L "$5" ]; then rm -f "$5"; fi
  mv -f "$t" "$5"
}

xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

# role accounts may only be the names above (or test names of the same shape)
valid_account() { [[ "$1" =~ ^_[a-z][a-z0-9]{2,30}$ ]]; }
