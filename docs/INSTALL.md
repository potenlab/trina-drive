# Installing the server on a Mac

Every name below (accounts `_tdrive`/`_tdrivework`, labels `app.trina.drive.*`, the command `tdrive`) comes from
`scripts/macos/common.sh`, which must agree with `src/brand.ts` (the build checks it).

v0.1 has one supported install: **natively on an office Mac (a Mac mini), with a release folder and
`install-macos.sh`.** Linux/Docker (v0.2): [DOCKER.md](DOCKER.md).

## 1. Requirements

| | |
|---|---|
| Machine | Apple silicon Mac (a Mac mini M1 or later is the target). 8 GB memory works for a small team, 16 GB recommended. Intel Macs have a `darwin-x64` build, but its `pdftotext` is not bundled (see section 9). |
| macOS | 14 Sonoma or later (the installer checks `minMacOS` in `release.json`). Developed on macOS 26. |
| Disk | The release needs about 100 MB; the data grows with drafts, the database and the text mirror (roughly the size of the text in your documents). |
| Network | A fixed LAN address (DHCP reservation) and wired Ethernet are recommended. The Mac must stay on. |
| Backups | An external disk (USB/Thunderbolt) or, from a later version, S3-compatible storage. Not the server's own disk, not the NAS that holds the originals. |
| People | A macOS administrator account to run the installer (`sudo`). |

Turn on FileVault on the server Mac and lock its screen: the server's NAS account and the database are on it.

## 2. What gets installed, and what runs as which user

| Account | What it runs | What it can read and write |
|---|---|---|
| `root` | only the installer and uninstaller, and launchd itself | owns the app, config and LaunchDaemon files, so the server account cannot change what root or administrators run |
| `_tdrive` (server) | the server (HTTP API, MCP endpoint, web), the daily backup job | the data folders below (0700), the registered folders it is given read access to, the backup folder |
| `_tdrivework` (worker) | text extraction and shell workers, in a `sandbox-exec` profile (when the release has a worker) | only `work/` and the bytes the server hands it; no data folder, no NAS mount, no network |

Both role accounts are hidden, have no password and `/usr/bin/false` as their shell, and take the first free UID/GID
in 450-499.

Files (`/Library/Application Support/trina-drive/` unless the path is absolute):

| Path | Owner : group, mode | Contents |
|---|---|---|
| `app/versions/<version>/` | root : wheel, 755 | `bin/tdrive` (the compiled server and CLI), `tools/` (pinned ripgrep, pdftotext and its libraries), `release.json`, `tools.json`, `docs/` |
| `app/current` | link | the running version (the previous one is kept next to it) |
| `config/server.json` | root : _tdrive, 640 | listen address and port, data folder, tool paths, worker account |
| `config/backup-recipient` | root : _tdrive, 644 | the backup PUBLIC key |
| `setup/first-setup-token` | root : admin, 640 | the one-time first-setup token (until first setup is done) |
| `db/` | _tdrive, 700 | `store.db` (SQLite), `backup.json` (backup target), `setup-token.sha256` |
| `drafts/` | _tdrive, 700 | draft version contents |
| `mirror/` | _tdrive, 700 | extracted text (cache; excluded from Time Machine) |
| `backup-staging/` | _tdrive, 700 | short-lived database snapshot while a backup runs (excluded from Time Machine) |
| `logs/` | _tdrive, 700 | `server.log`, `backup.log` (launchd output; rotated by `/etc/newsyslog.d/trina-drive.conf`) |
| `work/` | _tdrivework, 700 | worker scratch space, `worker.log` |
| `run/worker/` | _tdrivework : _tdrive, 750 | the worker socket (only the server can connect) |
| `/Library/LaunchDaemons/app.trina.drive.server.plist` | root, 644 | server: `RunAtLoad`, `KeepAlive`, `ExitTimeOut` 30 s, umask 077, 8192 open files |
| `/Library/LaunchDaemons/app.trina.drive.backup.plist` | root, 644 | daily backup at 03:17 (`backup run --if-configured`) |
| `/Library/LaunchDaemons/app.trina.drive.worker.plist` | root, 644 | worker (only when the release lists a `worker` daemon) |
| `/usr/local/bin/tdrive` | link | `app/current/bin/tdrive`, the CLI on PATH |

The installer also: sets `pmset sleep 0 autorestart 1` (skip with `--no-power`), adds the binary to the application
firewall when it is on, and excludes `mirror/` and `backup-staging/` from Time Machine.

## 3. Install

```sh
# 1) get the release for your Mac and check it
shasum -a 256 -c trina-drive-<version>-darwin-arm64.tar.gz.sha256
tar -xzf trina-drive-<version>-darwin-arm64.tar.gz
cd trina-drive-<version>-darwin-arm64

# 2) see what it would do (no root; writes only into a temporary folder and prints its path)
./install-macos.sh --dry-run

# 3) install (an external disk for backups is optional now, see section 6)
sudo ./install-macos.sh --backup-dir /Volumes/Backup/trina-drive-backup
```

Options: `--listen ADDR` (default `0.0.0.0`; give the Tailscale address to serve only over the VPN), `--port N`
(default 8787), `--backup-dir DIR`, `--new-backup-key`, `--no-power`, `--from DIR` (release folder, default: the
installer's own folder). `./install-macos.sh --help` lists them.

Before changing anything, the installer checks every file of the release against `SHA256SUMS`, refuses files the
list does not name, and refuses a release for another CPU type or an older macOS. Running it again repairs the
install (data, the setup token and the backup key are kept); running a newer release's installer switches to that
version and keeps the previous one in `app/versions/`.

At the end it prints, once:

1. **the first-setup token** (also kept in `setup/first-setup-token` for Mac administrators until setup is done);
2. **the backup SECRET key**, which is stored nowhere. Save it now (password manager, or printed and locked away),
   away from the server. Without it no backup can be restored.

Releases are not yet signed with a Developer ID. A release downloaded with a browser carries the quarantine flag;
remove it before installing: `xattr -dr com.apple.quarantine trina-drive-<version>-darwin-arm64`.

## 4. First setup

Open `http://<this Mac's name>.local:8787/setup` from a computer on the office network and enter the token. It creates
the first administrator. The server deletes the token's hash when that is done, so the token cannot be used twice.

There is no "trusted loopback": a request from the server Mac itself (for example a browser or an AI agent running on
it) gets no special treatment, and first setup is impossible without the token. Lost the token before setup? Read it
with `sudo cat "/Library/Application Support/trina-drive/setup/first-setup-token"`.

## 5. Exposure (v0.1: LAN or VPN only)

- Use the server from the office LAN or over a VPN such as Tailscale. **Do not forward a router port to it and do not
  give it a public address.** Public access (a tunnel with its own listener) is a v0.2 feature behind a security gate.
- v0.1 serves plain HTTP. Tokens sent over shared office Wi-Fi can be observed; prefer Tailscale (encrypted) even in
  the office, or `--listen <tailscale address>` to serve only there.
- Agent tokens are Bearer tokens: treat them like passwords (short expiry, read-only and folder-scoped by default).

## 6. Backup and restore

What is backed up: the SQLite database (people, rules, tokens, drafts index, versions, trash, audit chain) and the
draft contents, encrypted (format: [BACKUP-FORMAT.md](BACKUP-FORMAT.md)).

**Not backed up: the original files in your registered folders (the NAS shares).** They stay on the NAS; use the
NAS's own backup (for example Synology Hyper Backup or snapshots). The text mirror and logs are not backed up either.

The admin commands run as the server account. For short, define in your shell:

```sh
tdriveadm() { sudo -H -u _tdrive tdrive --data "/Library/Application Support/trina-drive" "$@"; }
```

Set a target (an external disk; formatted APFS, encrypted if you like):

```sh
sudo mkdir -p /Volumes/Backup/trina-drive-backup && sudo chown _tdrive /Volumes/Backup/trina-drive-backup && sudo chmod 700 /Volumes/Backup/trina-drive-backup
tdriveadm backup target set /Volumes/Backup/trina-drive-backup --keep 14
tdriveadm backup target show
```

The daily job (03:17) then writes one archive and keeps the newest 14. A target on the server's own disk is refused
(`--allow-same-disk` exists for tests only). S3-compatible storage (`s3://bucket/prefix`) is recognised but not
available in v0.1.

By hand:

```sh
tdriveadm backup run                     # one backup now
tdriveadm backup list
tdrive backup verify /Volumes/Backup/trina-drive-backup/trina-drive-20261022T031700Z.bkp --key-file -   # paste the secret key, then Ctrl-D
```

`verify` needs the secret key, so run it on a computer you trust with the key (it does not need the server), decrypts
everything and checks it: every byte authenticated, all checksums, SQLite integrity, the audit chain head, every draft
version present. Do this monthly, and after changing the backup disk.

Restore (into a NEW folder; the restore never overwrites data):

```sh
sudo launchctl bootout system/app.trina.drive.server
sudo launchctl bootout system/app.trina.drive.backup
cd "/Library/Application Support"
sudo tdrive backup restore /Volumes/Backup/trina-drive-backup/trina-drive-20261022T031700Z.bkp --into "/Library/Application Support/trina-drive-restored" --key-file -
# move the current data aside and the restored data in
sudo mkdir trina-drive-old
for d in db drafts mirror backup-staging logs; do sudo mv "trina-drive/$d" trina-drive-old/ ; sudo mv "trina-drive-restored/$d" trina-drive/ ; done
sudo rmdir trina-drive-restored
# from the installed version's release folder: rerun its installer; it gives the restored files back to _tdrive
# and starts the daemons
cd ~/trina-drive-<version>-darwin-arm64 && sudo ./install-macos.sh
tdriveadm backup target set /Volumes/Backup/trina-drive-backup   # the target setting is not part of a backup
```

On a new Mac: install first, stop the daemons, then restore as above. The registered folders must be reachable at the
same paths (the database refers to them by path and file identity).

Key rotation: `sudo ./install-macos.sh --new-backup-key` (or `sudo tdrive --data "/Library/Application Support/trina-drive"
backup keygen --set`). Archives made before keep needing the old secret key.

## 7. Update and roll back

Run the newer release's `sudo ./install-macos.sh`. It stops the daemons, installs the new version next to the old one,
points `app/current` at it and starts again; data, token and keys stay. To go back, run the previous release's
installer (the previous version folder is still there, so this is quick). Take a backup before updating.

## 8. Uninstall

```sh
sudo ./uninstall-macos.sh                 # keeps the data (db, drafts, mirror, backup-staging, logs)
sudo ./uninstall-macos.sh --delete-data   # removes /Library/Application Support/trina-drive entirely
```

It stops and removes the LaunchDaemons, the CLI link, log rotation, the firewall and Time Machine entries, `app/`,
`config/`, `setup/`, `work/`, `run/` and the two role accounts (`--keep-accounts` keeps them). Kept data is handed to
root so no deleted UID owns it; a later install gives it back to the server account. Backups on external disks are
never touched. macOS may ask the logged-in administrator to approve deleting the accounts; if nobody approves, they
are left locked and the uninstaller says so. `./uninstall-macos.sh --dry-run --prefix DIR` works on a tree made by
`install-macos.sh --dry-run --prefix DIR`.

## 9. External tools: bundled and pinned

| Tool | How it gets into a release | Why |
|---|---|---|
| ripgrep 15.2.0 (`rg`) | the official macOS binary from GitHub, accepted only with the SHA-256 pinned in `scripts/tools.json` | linear-time regex search over the text mirror |
| poppler 26.04.0 (`pdftotext`) | Poppler publishes no macOS binaries: the build host's Homebrew bottle is copied with its library closure (22 libraries, about 15 MB) into `tools/lib`, relinked to `@rpath` and ad-hoc signed; the build refuses another Homebrew version unless `--accept-tool-drift` | PDF text |

Decision: **bundle, do not depend on Homebrew at run time.** Homebrew's prefix is writable by the user who installed
Homebrew, so a program the server runs from there could be replaced without `sudo`; the bundled copies are root-owned
and listed in `SHA256SUMS`/`tools.json`. Homebrew is only a fallback when a release lacks a tool (a development build,
or `pdftotext` on Intel): the installer then uses `/opt/homebrew/bin/<tool>` and prints a warning. License texts of all
bundled tools and libraries are in `tools/licenses/`.

## 10. Building a release

```sh
bun install
bun scripts/build.ts                                   # dist/trina-drive-<version>-darwin-arm64/ and .tar.gz(.sha256)
bun scripts/build.ts --targets darwin-arm64,darwin-x64
bun scripts/build.ts --tools none                      # without tools (installer falls back to Homebrew, warns)
bun scripts/build.ts --tools stub --entry src/backup/cli.ts --no-tar   # what the installer test uses
```

Each release has `release.json` (name, version, target, daemons, minimum macOS, Bun version, commit), `tools.json`
(each tool's version, origin and file hashes) and `SHA256SUMS`. `--daemons server,backup,worker` adds the worker
LaunchDaemon once the server has a `worker` command.

Signing and notarization are hooks only (no Developer ID yet): with `CODESIGN_IDENTITY` set, `bin/` and `tools/` are
signed with the hardened runtime and a timestamp; with `NOTARY_PROFILE` too (`xcrun notarytool store-credentials`),
the folder is submitted for notarization. Without them the build ad-hoc signs what it compiled or relinked, which Apple
silicon requires to run at all. (Bun 1.3.12's `--compile` output carries a signature `codesign` rejects; the build
replaces it.)

## 11. Tests

```sh
bun run test                    # includes the backup tests and the installer dry-run
bash test/install-dryrun.sh     # the installer test alone: builds a test release, installs into a temp folder
```

The installer test never needs root and never touches the system: it checks the tree, owners and modes it would set,
the plists (`plutil -lint` and their keys), the setup token, that the printed backup secret decrypts a backup made with
the installed public key and is stored nowhere, a repair run, refusal of changed or extra release files, and the
dry-run uninstall.

## 12. Not yet verified on a real, clean Mac

The installer's privileged steps have only been exercised as a dry run. Before v0.1 ships, on a clean Mac mini:
account creation with `dscl` on macOS 14/15/26 and the approval prompts on deletion; launchd starting the daemons
as the role accounts and creating the log files in folders those accounts own; `ExitTimeOut` and `KeepAlive`
behaviour; the application firewall prompt for an ad-hoc-signed binary; Gatekeeper with a quarantined, unsigned
release; the vendored `pdftotext` on a Mac without Homebrew (fontconfig without its config file); a backup to a real
external disk owned by `_tdrive` and a restore swap as in section 6; `newsyslog` picking up the rotation file.
