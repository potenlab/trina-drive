# Running the server in Docker on Linux

`shelf` is a temporary codename (it comes from `package.json`). Plan 5.2: "리눅스 Docker" is the v0.2 way to self-host
on a Linux machine. The native macOS install (docs/INSTALL.md) stays the v0.1 path.

**Supported:** a Linux machine you control (a small server, a VM, a mini PC) with Docker Engine, x86-64 or arm64.
**Not supported: Docker inside the NAS** (Synology/QNAP Container Manager). Those kernels have user namespaces and
seccomp filters for unprivileged programs switched off, so the document and shell workers cannot be isolated, and the
server refuses to run them without isolation (plan 6). Run the server on another machine and mount the NAS shares
read-only into it (below).

## 1. Requirements

| | |
|---|---|
| Machine | Linux, kernel 5.10 or later with unprivileged user namespaces (every current distribution), 2+ CPU, 4 GB memory for a small team |
| Docker | Docker Engine 24+ with the compose plugin (developed with Engine 29.2, Compose 5.1) |
| Security module | AppArmor (Ubuntu, Debian, SUSE): load one profile, section 3. SELinux (Fedora, RHEL): see section 6.4 |
| NAS shares | mounted on the Docker host (SMB/NFS, read-only is enough), bound read-only into the container |
| Backups | a disk or mount that is not the Docker host's own disk |

## 2. What runs

One container, image `shelf:<version>` (built from `Dockerfile`, section 9):

- `/usr/bin/tini` (PID 1) → `shelf serve` (Bun 1.3.12 running the TypeScript sources in `/app`) as **uid 10001**, no
  capabilities, read-only root file system.
- Each bash command and each document extraction runs in a **worker** process inside a **bubblewrap (bwrap) sandbox**
  started by the server (src/worker/sandbox.ts): new user, mount, pid, network, IPC, UTS and cgroup namespaces; no
  network at all; its own `/proc` that shows only itself; an empty read-only root with only shared libraries,
  `/usr/share`, the runtime, the worker code and (for PDFs) `pdftotext`; its job folder in `/tmp` as the only writable
  place; no capabilities, no new privileges, killed with the server. The permission decision stays in the server: a
  worker sees team files only through the server (docs/worker.md).
- Tools: ripgrep 15.2.0 (`/usr/local/bin/rg`, the official static build, SHA-256 pinned in scripts/tools.json),
  pdftotext (Debian `poppler-utils`), bubblewrap, tini.

| Path in the container | What | |
|---|---|---|
| `/data` | the data directory, installed layout (src/layout.ts): `db/store.db` + `db/backup.json`, `drafts/`, `mirror/`, `backup-staging/`, `logs/`, `config/backup-recipient`, notify/outbox files | volume, owned by 10001, 0700 |
| `/data/shares/<name>` | a registered folder (a NAS share) | read-only bind mount |
| `/backup` | backup target (optional) | bind mount of another disk, writable by 10001 |
| `/tmp` | worker job folders | tmpfs, 256 MB, `noexec` |
| `/app` | code, `web/dist`, `node_modules`, `SHA256SUMS` | in the image, read-only |

Environment (all optional): `TZ` (default UTC; set your office's, e.g. `Asia/Seoul`), `SHELF_WORKERS_GLOBAL`,
`_PER_TOKEN`, `_PER_PERSON`, `_QUEUE`, `SHELF_WORKERS_WARM`, `SHELF_EXTRACT_*` (docs/worker.md, Configuration),
`SHELF_DRAFT_MAX_FILES` / `_MAX_BYTES` / `_PERSON_MAX_BYTES`. Set by the image, do not change: `SHELF_HOME=/data`,
`SHELF_LAYOUT=installed`, `SHELF_RG`, `SHELF_PDFTOTEXT`, `SHELF_CONTAINER=docker`.

## 3. Install

```sh
git clone https://github.com/potenlab/shelf && cd shelf      # (no published image yet; build locally)

# 1) AppArmor hosts only (check: `docker info | grep apparmor`): load the worker profile, once per boot.
#    To keep it across reboots, also: sudo cp docker/apparmor-shelf-bwrap /etc/apparmor.d/
sudo apparmor_parser -r docker/apparmor-shelf-bwrap

# 2) build and create the data directory; prints the one-time web setup token
docker compose build
docker compose run --rm shelf init

# 3) start; check that it is healthy and that workers are isolated
docker compose up -d
docker compose ps                                   # STATUS ... (healthy)
docker compose logs shelf | grep isolation          # worker isolation: bwrap
```

If the log says `worker isolation: none` and `ERROR: bash commands and document text extraction are refused`, the
container is missing the settings of section 6 (the message says which part failed). The web app, sign-in and file
listings still work; agents get "commands cannot run" until it is fixed.

Then open `http://<host>:8787/setup` (see section 7 for which address to publish) and enter the token. Admin commands
run in the container:

```sh
alias shelfadm='docker compose exec shelf shelf'
shelfadm folder register /data/shares/projects --name 프로젝트 --nas-readers all
shelfadm rule set /data/shares/projects @전체 read
shelfadm audit verify
```

Try it with sample data instead: `docker compose run --rm shelf demo seed` on a fresh volume (people, rules, tokens
for kim and boss), then `docker compose up -d`.

## 4. Registered folders (NAS shares)

Mount each share on the Docker host (read-only is enough in v0.1/v0.2: the server never writes originals) and bind it
read-only, one line per share, in `docker-compose.yml`:

```yaml
    volumes:
      - shelf-data:/data
      - /srv/share:/data/shares/share:ro
      - /mnt/nas/경영:/data/shares/management:ro
```

then `shelfadm folder register /data/shares/share`. The database refers to folders by path and file identity, so keep
the container paths the same across restarts and upgrades. The NAS account used for the host mount is in effect the
server's account (plan 7.1): give it read access to the registered shares only. `docker compose restart` after
adding a bind.

## 5. Backup and restore

What is backed up and the format: docs/INSTALL.md section 6, docs/BACKUP-FORMAT.md. The originals (NAS shares) are not
backed up by this program.

```sh
# a backup disk on the host, writable by the container user
sudo mkdir -p /mnt/backup/shelf && sudo chown 10001:10001 /mnt/backup/shelf && sudo chmod 700 /mnt/backup/shelf
# add to docker-compose.yml volumes:  - /mnt/backup/shelf:/backup      then: docker compose up -d
shelfadm backup keygen --set              # prints the SECRET key once: store it away from the server
shelfadm backup target set /backup --keep 14
shelfadm backup run
shelfadm backup list
```

There is no scheduler in the container. Run the daily backup from the host, e.g. a crontab line of root or of a user
in the docker group:

```
17 3 * * *  cd /opt/shelf && docker compose exec -T shelf shelf backup run --if-configured >> /var/log/shelf-backup.log 2>&1
```

A target on the same disk as `/data` is refused (`--allow-same-disk` exists for tests). Verify monthly, on a computer
you trust with the secret key: `shelf backup verify <archive> --key-file -` (any install, or
`docker run --rm -i -v /mnt/backup/shelf:/backup:ro shelf:<version> backup verify /backup/<archive> --key-file -`).

Restore into a new volume, then switch to it:

```sh
docker compose down
docker volume create shelf_shelf-data-restored
docker run --rm -i -v shelf_shelf-data-restored:/data -v /mnt/backup/shelf:/backup:ro shelf:<version> \
  backup restore /backup/shelf-20261022T031700Z.bkp --into /data --key-file -      # paste the secret key, Ctrl-D
# point docker-compose.yml at the restored volume (volumes: shelf-data: {external: true, name: shelf_shelf-data-restored})
docker compose up -d && shelfadm backup target set /backup     # the target setting is not part of a backup
```

(A new, empty named volume mounted at `/data` takes the image's empty, uid-10001 `/data`, which is why the restore
runs there.)

## 6. Security settings

The server itself needs nothing beyond `cap_drop: [ALL]`, `no-new-privileges`, a read-only root and a tmpfs. Everything
else in `security_opt` is for bubblewrap, which builds each worker sandbox from **unprivileged user namespaces** and
mounts inside them. Docker's defaults forbid both, so with the defaults the server starts and refuses workers (tested
by scripts/docker-test.sh).

### 6.1 What docker-compose.yml sets, and why each line is needed

| Setting | Needed for | Without it |
|---|---|---|
| `seccomp=./docker/seccomp-bwrap.json` | Docker's default profile (moby/profiles v0.1.0, Docker 29) **plus**: `clone` and `unshare` **only with `CLONE_NEWUSER`** in the flags, and `mount`, `umount2`, `pivot_root` | `bwrap: No permissions to create a new namespace` |
| `apparmor=shelf-bwrap` | Docker's `docker-default` rules **plus** `userns`, `mount`, `pivot_root` (docker/apparmor-shelf-bwrap) | docker-default: `Failed to make / slave: Permission denied`; `apparmor=unconfined` on Ubuntu 23.10+: `setting up uid map: Permission denied` (Ubuntu's `apparmor_restrict_unprivileged_userns`) |
| `systempaths=unconfined` | the kernel lets a user namespace mount a new `/proc` only if the container's `/proc` is not partly hidden; Docker hides `/proc/kcore`, `/proc/keys`, `/proc/timer_list` … with bind mounts | `bwrap: Can't mount proc on /proc: Operation not permitted` |
| `cap_drop: [ALL]`, `no-new-privileges:true`, `read_only: true`, tmpfs `/tmp` `noexec,nosuid,nodev` | hardening (not needed by bwrap, kept on) | |

Found by trying each step on Docker 29.2.1 / Ubuntu 24.04 kernel 6.8 (colima, arm64): every row above is necessary,
and together they are sufficient. `seccomp=unconfined` is not needed.

### 6.2 Trade-offs

- **User namespaces are kernel attack surface.** Inside one, a process is "root" over its own namespaces and can reach
  kernel code (file system mounting, netfilter, …) that an unprivileged process otherwise cannot; several local
  privilege escalations of recent years needed exactly this. That is why Docker blocks them by default. The worker
  sandbox is built on them; the alternative was no isolation (refused, plan 6). The seccomp additions are as narrow as
  seccomp can express: new namespaces only together with a new user namespace; `mount`/`pivot_root` are still refused
  by the kernel in the container's own namespaces (no `CAP_SYS_ADMIN` there).
- **`systempaths=unconfined`** un-hides those `/proc` and `/sys/firmware` entries for the whole container. The server
  runs as uid 10001 without capabilities, so the root-only ones (`kcore`, `sysrq-trigger`, `/proc/sys` writes) stay
  closed by permissions; world-readable ones (e.g. `/proc/timer_list` on older kernels, `/proc/sched_debug`) become
  readable by the server process. Workers get a fresh `/proc` of their own pid namespace in any case.
- **The custom AppArmor profile** is docker-default with three rules added, so it must be loaded on the host and
  kept in sync with Docker's template when you update Docker (diff it against
  `github.com/moby/profiles/apparmor/template.go`). AppArmor 3 hosts (Debian 12, Ubuntu 22.04): delete the `abi` line
  and `userns,` from the file.
- With these settings a compromised **server** process could create user namespaces too (the settings apply to the
  container, not just to bwrap). It still has no capabilities in the container and no network beyond the container's.

### 6.3 What the sandbox was checked to block (in this container, tests/worker.test.ts)

Network (fetch and raw TCP to the internet and to a server on the container's 127.0.0.1); writes outside the job folder
(`/`, `/usr`, `/tmp`, home, a sibling folder); reads and listings outside the grants (`/etc/passwd`, `/etc/shadow`,
`/var`, `/data`, `/srv`, a sibling secret file, `/proc/1/root/...`); starting `/bin/sh` or `curl`; seeing other
processes (its `/proc` lists only bwrap's init and itself; the test runner's environment canary is not readable from any
`/proc/<pid>/environ`); signalling anything outside the sandbox (every pid up to 32768 tried); `NoNewPrivs: 1`,
`CapEff` and `CapBnd` zero; memory bomb, infinite loop, output floods, forged protocol frames, zip bombs and a
quadratic-regex docx are killed per worker while another token's commands stay fast.

### 6.4 Other hosts

- **No AppArmor** (Fedora, RHEL, Arch …): remove the `apparmor=` line. Not tested here.
- **SELinux** (Fedora/RHEL with `container_t`): mounts inside the user namespace may be denied by policy; if workers
  are refused, try `label=type:container_engine_t` (made for nested container tools) before `label=disable`. Not
  tested here.
- **Rootless Docker / Podman**: the container already runs in a user namespace; nested ones work on most kernels.
  Not tested here.
- **`kernel.unprivileged_userns_clone=0`** (old Debian) or `user.max_user_namespaces=0`: workers cannot be isolated;
  enable user namespaces or the server refuses shell and extraction.

## 7. Exposure: LAN or VPN only

- Publish the port on the server's **LAN address** or its **VPN (Tailscale) address**, e.g. `"192.168.0.10:8787:8787"`
  or `"100.101.102.103:8787:8787"`. The compose file's default `127.0.0.1:8787` reaches only the Docker host itself.
  Do not use a bare `"8787:8787"` on a machine with a public address: Docker's port publishing bypasses host
  firewalls such as ufw.
- **No public address, no router port forward.** Public access (claude.ai and ChatGPT connectors) is the v0.2 tunnel
  with its own listener and public path list, enabled only after the v0.2 security gate (plan 5.2, 7.1, 7.4).
- Plain HTTP: prefer Tailscale even in the office (tokens are Bearer tokens). A TLS reverse proxy in front is fine;
  pass `--allow-origin https://<name>` to `serve` (in `command:`) when the web app is used through it.

## 8. Upgrade and roll back

```sh
shelfadm backup run                                  # first
git pull && docker compose build                     # or: a new release tag
docker compose up -d                                 # recreates the container; the data volume stays
docker compose logs shelf | grep -E 'isolation|ERROR'
```

Roll back by building/running the previous tag with the same volume (`image: shelf:<previous>`). There are no
down-migrations: if the previous version does not accept the data, restore the backup taken before the upgrade
(section 5). Base image
updates (security fixes in Debian packages) arrive by rebuilding; rebuild monthly and when Debian announces a fix in
`poppler` or `bubblewrap`.

## 9. Building, supply chain

```sh
docker build -t shelf:dev .                                             # this machine's CPU
docker buildx build --platform linux/amd64,linux/arm64 -t shelf:dev .   # both (amd64 under emulation on arm64 is slow)
scripts/docker/sbom.sh shelf:dev                                        # SBOM: dist/sbom/shelf-<version>.{spdx,cdx}.json
docker run --rm --entrypoint sh shelf:dev -c 'cd /app && sha256sum -c --quiet SHA256SUMS && echo ok'
```

- **Pinned:** base images by digest (`BUN_IMAGE`, `DEBIAN_IMAGE` in the Dockerfile; multi-arch indexes), npm packages by
  `bun.lock` (`--frozen-lockfile`, lifecycle scripts never run), ripgrep by SHA-256 (scripts/tools.json `linux-*`
  targets, checked by scripts/docker/tools.ts through scripts/build.ts `vendorDownload`), the seccomp profile's
  upstream by SHA-256 (scripts/docker/seccomp.ts regenerates it).
- **Not pinned:** Debian packages (bubblewrap, poppler-utils, tini, tzdata, ca-certificates) come from Debian 13 with
  the security updates current at build time, on purpose. The exact versions are in `/usr/share/shelf/packages.txt`
  and in the SBOM.
- **In the image:** `/usr/share/shelf/tools.json` (ripgrep origin URL, pinned archive SHA-256, SHA-256 of the installed
  binary), `/usr/share/shelf/licenses/` (ripgrep's license files; Debian packages keep theirs in
  `/usr/share/doc/<package>/copyright`), `/app/SHA256SUMS` (every file of `/app`, same format and code as the macOS
  release manifest, scripts/build.ts `writeChecksums`). There is no single compiled binary: workers start
  `bun src/worker/entry.ts` inside bwrap, so the image ships the sources.
- **SBOM** (`scripts/docker/sbom.sh`, syft 1.54.1): 157 Debian packages, 77 npm packages and the Bun binary for the
  arm64 image. syft does not recognise the static ripgrep binary (a Rust build without embedded dependency data);
  its origin and hashes are in `/usr/share/shelf/tools.json`.
- **Labels:** `org.opencontainers.image.version`, `.revision` (git commit, `--build-arg REVISION=…`), `.created`,
  `.source`, `.licenses` (`NOASSERTION` until the license is decided; AGPL-3.0 planned), `.base.name`.
- **Not yet:** a published image, image signatures (cosign) and provenance attestations; they come with the first
  public release (plan 7.1 "서명된 릴리스·이미지").

## 10. Tests

`scripts/docker-test.sh` builds the image and the test image (`--target test`), then:

1. **Smoke** through `docker-compose.yml` (a throwaway project and volume, random local port): demo seed, healthy,
   `worker isolation: bwrap`, uid 10001 / read-only root / no capabilities, `/health`, the web app (200), MCP
   `initialize` and `tools/list`, the bash tool as kim (`ls /` without 경영; `ls /경영` "No such file or directory";
   `grep -rl 매출 /` finds nothing of 경영; a docx read as text), as boss (경영 visible, a PDF through pdftotext), and
   `/app/SHA256SUMS`.
2. **Refusal** with Docker's default security settings on a fresh volume: the start-up `ERROR` names the compose
   settings, the bash tool answers "commands cannot run", a docx read answers "cannot extract text".
3. **`bun test`** (the whole suite) inside the test image under the compose security settings, with
   `SHELF_EXPECT_ISOLATION=bwrap` (a missing sandbox fails the suite instead of skipping it) and a canary in the test
   runner's environment. The log is kept in `dist/docker-test.log`.

Platform-specific tests: the macOS installer, Homebrew vendoring and `sandbox-exec` profile tests skip on Linux; the
bwrap sandbox tests (`/proc` scan, signal scan, privileges, arguments) skip on macOS.

## 11. Known gaps

- **OCR: none on Linux** (and none on macOS yet: Apple Vision / RapidOCR are v0.3 candidates). A scanned PDF reads as
  empty text.
- **No per-job cgroup.** Memory is watched by polling `/proc` (20 ms) and a worker is killed above its cap; there is no
  hard `memory.max`/`pids.max` per job (a cgroup v2 delegation would need more container privileges). The container's
  `mem_limit` and `pids_limit` bound the total.
- **No separate worker user.** Workers run as uid 10001 like the server; their own pid namespace and `/proc` already
  hide the server's environment and file descriptors (the macOS "same-uid procargs" gap does not exist here).
- Executables under `/usr/lib` (e.g. helper programs of Debian packages) can be started by a worker; there is no shell
  and no network in the sandbox, and `/tmp` is `noexec`, so it cannot run a program it wrote.
- amd64: the image builds (`docker buildx build --platform linux/amd64`, 1 min 53 s under QEMU on an M1; 129 MB) and
  Bun, ripgrep and bwrap start in it, but the smoke and the test suite ran on arm64 only.
- NAS-internal Docker: not supported (section intro). SELinux and rootless hosts: not tested.
