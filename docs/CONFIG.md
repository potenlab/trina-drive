# Configuration

Trina Drive is configured with command-line flags, a few environment variables, and settings stored in its data
directory. Run `tdrive` with no arguments for the full command list (reproduced below).

## Names

Every name the product uses comes from [`src/brand.ts`](../src/brand.ts):

| what | value | used for |
|---|---|---|
| product | `Trina Drive` | page titles, email and Slack subjects (`[Trina Drive] …`), consent screen, passkey and authenticator labels |
| machine name | `trina-drive` | package, data directory `~/.trina-drive`, macOS `/Library/Application Support/trina-drive`, MCP entry and OAuth/MCP server name, Docker image and compose service, AppArmor profile `trina-drive-bwrap`, backup files `trina-drive-<time>.bkp`, Keychain service `trina-drive-mcp` |
| command | `tdrive` | the CLI, `/usr/local/bin/tdrive` |
| secret tag | `tdrive_` | personal tokens `tdrive_pat_…`, setup tokens `tdrive_setup_…`, OAuth `tdrive_oac_` / `tdrive_oat_` / `tdrive_ort_`, backup keys `tdrive_bksec1_…`, session cookie `tdrive_session` |
| environment prefix | `TDRIVE_` | every variable below |
| macOS | `_tdrive`, `_tdrivework`, `app.trina.drive.{server,backup,worker}` | service accounts and LaunchDaemons (`scripts/macos/common.sh`) |

Secrets carry a fixed, distinctive prefix so secret scanners (GitHub push protection, gitleaks, trufflehog) can match
them with a simple pattern such as `\btdrive_(pat|setup|oat|ort|oac)_[A-Za-z0-9_-]{16,}` and
`\btdrive_bksec1_[A-Za-z0-9_-]{49}`. The audit log redacts them to their 4-character hint (`tdrive_pat_AbCd…[REDACTED:token]`).

**Renaming from the `shelf` codename.** The product was developed as `shelf` (`SHELF_*` variables, `shelf_pat_` tokens,
`~/.shelf`). Nothing was released under that name, so the rename is clean: the old names are **not** accepted as
aliases. If you ran a development build, rename `~/.shelf` to `~/.trina-drive`, `SHELF_*` variables to `TDRIVE_*`,
and make new tokens (old `shelf_pat_` tokens no longer match the token format).

## Data directory

`--data DIR`, else `$TDRIVE_HOME`, else `~/.trina-drive`. It must not be inside a registered folder. Two layouts:
**flat** (development: everything in one folder) and **installed** (`db/`, `drafts/`, `mirror/`, `logs/`, `config/`,
used by the macOS installer and the Docker image). Both keep managed storage in `files/` (team folders, and
`files/.trina-drive/` for the trash, earlier versions and upload staging). See [INSTALL.md](INSTALL.md) for who owns what on a Mac.

## Environment variables

| variable | default | meaning |
|---|---|---|
| `TDRIVE_HOME` | `~/.trina-drive` | data directory (when `--data` is not given) |
| `TDRIVE_LAYOUT` | detected | `installed` or `flat` (installed when the directory has `db/`) |
| `TDRIVE_RG`, `TDRIVE_PDFTOTEXT` | `PATH` lookup | absolute paths of ripgrep and pdftotext (the installer and the image pin them) |
| `TDRIVE_ISOLATION` | `auto` | worker isolation: `auto`, `sandbox-exec` (macOS), `bwrap` (Linux), `none` |
| `TDRIVE_REQUIRE_ISOLATION` | `1` | `0` lets shell commands and extraction run without OS isolation (never in production) |
| `TDRIVE_WORKER_USER` | — | run workers as this account (`_tdrivework` on an installed Mac; the server must start them) |
| `TDRIVE_WORKERS_GLOBAL`, `_PER_TOKEN`, `_PER_PERSON`, `_QUEUE` | CPUs − 2 (at least 2), 2, 3, 64 | concurrent shell commands ([worker.md](worker.md)) |
| `TDRIVE_WORKERS_WARM`, `TDRIVE_WORKER_REUSE` | see worker.md, on | pre-started shell workers; `0` turns reuse per token off |
| `TDRIVE_EXTRACT_WARM`, `TDRIVE_EXTRACT_GLOBAL`, `_PER_TOKEN`, `_PER_PERSON`, `_QUEUE` | 1, … | document extraction workers |
| `TDRIVE_DRAFT_MAX_FILES`, `TDRIVE_DRAFT_MAX_BYTES`, `TDRIVE_DRAFT_PERSON_MAX_BYTES` | 500, 200 MB, 1 GB | draft quota per token and per person |
| `TDRIVE_STORAGE` | `inplace` | `managed`: the web makes team folders in managed storage and offers uploads (also `tdrive init --managed` / `storage mode`) |
| `TDRIVE_FILES_DIR` | `<data>/files` | the managed root |
| `TDRIVE_STORAGE_QUOTA` | none | the team's total (files, trash, earlier versions, unfinished uploads), e.g. `50GB` (also `tdrive storage quota`) |
| `TDRIVE_MAX_FILE_BYTES`, `TDRIVE_VERSIONS_KEPT`, `TDRIVE_TRASH_DAYS` | 10 GB, 10, 30 | largest file, earlier versions kept per file, days in the trash |
| `TDRIVE_WEBDAV` | on (managed storage) | `off` turns the `/dav/` mount off ([ARCHITECTURE.md](ARCHITECTURE.md#mount-as-a-drive-webdav)) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_API_KEY` | — | Google Drive import: all three set (and managed storage) turns it on; otherwise it is hidden. `GOOGLE_APP_ID` (Cloud project number) defaults to the client id's prefix |
| `TDRIVE_GDRIVE_READONLY` | off | `1` also asks for `drive.readonly` so whole folders import recursively (restricted scope: unverified-app screen, 100 users per Cloud project for life; design partners only) |
| `TDRIVE_SECRET_KEY` | `<data>/keys/data.key` | 32-byte data key (hex or base64) sealing people's Google tokens; made on first use when unset. Not in backups: keep it with the data disk or set it from your secret store |
| `TDRIVE_SMTP_PASS` | — | overrides the SMTP password stored in `notify.json` |
| `TDRIVE_MAILER` | — (`notify.json`) | `smtp`, `ses`, `outbox` or `off`: the mailer for notifications **and** the web's invites and password resets, instead of `notify.json`'s `email` (a hosted instance gets it from its env file) |
| `TDRIVE_MAIL_FROM` | — | From address (required for `smtp` / `ses`) |
| `TDRIVE_SMTP_HOST`, `_PORT`, `_TLS`, `_USER` | —, 587, `starttls` (`tls` on 465) | SMTP submission; `_TLS` is `starttls` (required, never a plain-text fallback), `tls` (implicit) or `none` |
| `TDRIVE_SES_REGION`, `_ENDPOINT`, `_CONFIGURATION_SET` | `AWS_REGION`, `https://email.<region>.amazonaws.com`, — | Amazon SES v2; credentials from `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` or the EC2 instance role (IMDSv2). In Trina Cloud the endpoint is the host's mail relay, which sends on through Resend ([cloud/README.md](../cloud/README.md#mail-resend)) |
| `TDRIVE_TRUSTED_PROXY` | — | `serve --trusted-proxy`: addresses / CIDR ranges of reverse proxies whose `X-Forwarded-For` is believed on the main listener |
| `TDRIVE_CLIENT_IP_HEADER` | `x-forwarded-for` | `cf-connecting-ip` when cloudflared (not a generic proxy) is the trusted peer |
| `TDRIVE_BACKUP_KEY` | — | backup secret key for `backup verify` / `restore` (or `--key-file`) |
| `TDRIVE_CONTAINER` | — | `docker` in the image (start-up errors then point to the compose security settings) |
| `TDRIVE_HEALTH_URL` | `http://127.0.0.1:8787/health` | the image's health check target |
| `TDRIVE_SHELL`, `TDRIVE_EXTRACT` | `isolated` | `inprocess` runs just-bash / the parsers in the server process. **Development and tests only.** |

On a person's computer (`tdrive mcp add`):

| variable | meaning |
|---|---|
| `TDRIVE_PASSWORD` | sign-in password for `mcp add` (else `--password-stdin` or a no-echo prompt) |
| `TDRIVE_TOKEN_CODEX`, `TDRIVE_TOKEN_CURSOR` | set by `~/.config/trina-drive/env.sh`; Codex and Cursor read the token from them |

Development: `TDRIVE_API` (where `bun run dev:web` proxies `/api` and `/mcp`), `TDRIVE_TEST_HWP` (a real Hangul file
for the extractor test), `TDRIVE_TIMING_RUNS`, `TDRIVE_EXPECT_ISOLATION`, `TDRIVE_TEST_CANARY` (test suite).

## Notification settings

`<data>/notify.json`, edited with `tdrive notify show` and `tdrive notify set <dotted.key> <json>`: `baseUrl`, `lang`
(`en`/`ko`), `email` (`mode`: `outbox` | `smtp` | `off`, `from`, SMTP host/port/user), `perMinute`, `flushMs`,
`digestHour`, `bulkRead` (`windowMs`, `files`, `bytes`, `folders`, `autoSuspend`), `newClientByIp`, `anchor`
(`intervalMs`, `dir`, `email`). Details: [SECURITY-MODEL.md](SECURITY-MODEL.md#alerts-and-audit).

## Command reference

```
usage: tdrive [--data DIR] <command>

  init [--managed]                       create the data directory; prints the one-time web setup token
                                         (--managed: managed storage, the server owns the team folders; see storage)
  person add <name> [--admin]
  group add <name>
  group member <group> <person>
  folder register <path> [--name N] [--personal-owner P] [--nas-readers all|unknown|p1,p2]
  folder create <name> [--personal-owner P]   a team folder in managed storage (the server makes and owns it)
  folder flag <path> no-ai|quarantine|widened-pending|inherit-break [--off]
  rule set <path> <person|@group> none|read|write [--break]
  manage grant <path> <person>
  token create <person> [--name N] [--scope path1,path2] [--read-only] [--ttl 8h]
  token revoke <id>                      (same as connections revoke)
  audit verify
  folder promote <path> [--off]          let drafts be promoted into this folder and below (new files only; admin)
  mfa status                             who has a second factor (passkey, authenticator app), recovery codes left
  mfa reset <person>                     remove all of a person's second factors (they lost them); ends their sessions
  audit verify --against <anchor-file>   check the log against an anchor sent out earlier (.json or the email)
  audit anchor [--force]                 sign the audit chain head now and send it out
  audit anchors                          anchors made so far
  connections list [--all]               token, person, client, IP, last used (--all: revoked tokens too)
  connections revoke <token-id>          revoke now: the next request with that token fails
  notify contact <person> [--email E] [--slack WEBHOOK_URL] [--lang en|ko]
  notify inbox <person> [--all] [--read] in-app notifications (--read marks them read)
  notify show | notify set <key> <json>  settings in <data>/notify.json (e.g. notify set bulkRead.files 500)
  notify flush                           send pending notifications now
  demo seed                              sample company tree, people, rules and tokens
  sh --token <pat> -c <command>          run one shell command as that token (audited)
  serve [--port 8787] [--host 127.0.0.1] [--allow-origin URL] [--public-url URL]   web admin at /, MCP at /mcp
  backup …                 (encrypted backups; see: backup help)
  public enable --url https://HOST [--port 8788] [--host 127.0.0.1] [--trusted-proxy 127.0.0.1]
                [--confirm-security-gate [--gate-version V]] [--allow-dcr | --no-dcr]
                [--client-host H]… [--any-client] [--default-clients]
                                         public address for claude.ai / ChatGPT through a tunnel (OAuth issuer = URL)
  public status                          settings and the public gate
  public disable                         stop serving the public listener (OAuth connections stay; revoke them on the web)

on your own computer (talks to the server; writes only user-scope client settings):
  mcp add claude|codex|cursor --server URL [--login NAME] [--password-stdin | --token-stdin]
        [--name trina-drive] [--token-name N] [--ttl 8h|1d|7d|30d|90d] [--scope folder1,folder2 | --all-folders] [--read-only]
        [--store keychain|file|inline] [--auto-approve] [--force] [--dry-run]
                                         connect an AI client on this computer (user scope; token in the Keychain)

managed storage (people upload, rename, move, delete to the trash, versions; src/managed):
  storage show                           mode, root, quota and what is used (files, trash, versions, uploads)
  storage mode managed|inplace           what the web offers new folders as (env TDRIVE_STORAGE wins)
  storage quota <size|none>              the team's total (e.g. 50GB; env TDRIVE_STORAGE_QUOTA wins)
  storage rescan                         file rows in line with the disk (files put in by hand, restored databases)

in-place reconciler (outside changes, R1 ⑤–⑦, R6, R10):
  share add <path> | share list          also index this whole share (identity + hash only), not just registered folders
  reconcile once [--json]                one pass: walk, diff, quarantine, hash, mirror, widened drafts
  reconcile watch [--every 5m] [--no-watch-hint]
  events list [--kind K] [--limit N]
  quarantine list [--all] | quarantine release <id> --by <person>   (moved/lost: admin; widened: admin or source manager)
  widened list | widened rejudge         NAS copies of drafts; re-judge after rule / group / NAS-reader changes
```

Backups: `tdrive backup help` ([BACKUP-FORMAT.md](BACKUP-FORMAT.md), [INSTALL.md](INSTALL.md) section 6).
