# Isolated executor (`src/worker/`)

Untrusted work runs outside the server process: a `bash` tool command (just-bash), or the text extraction of a
document. A ReDoS, a memory bomb, an infinite loop or a malicious document can then only take down a short-lived
sandboxed process, never the server. **The permission decision stays in the server**: a shell worker has no access to
team files at all; it asks the server for every file operation, and the server answers from the permission-filtered
VFS (plan 4.1 R1, 5.1 "권한 걸린 가상 셸", 6, 7.1).

```
 server process                                              worker process (one token; jobs one at a time)
 ┌──────────────────────────────────────────┐   stdin       ┌───────────────────────────────────────────┐
 │ Executor.run(job, {token, person, ...})  │──frames──────▶│ entry.ts                                  │
 │  FairScheduler (token/person/global)     │               │  just-bash  ── ProxyFs ──┐                │
 │  warm pool (one job per process)         │◀──frames──────│  parent-run commands ────┤ fs / cmd calls │
 │  deadline · RSS watchdog · byte caps     │   stdout      │  extractor module (bytes → text)          │
 │  FsBackend (= VirtualFs) · ShellHooks    │               └───────────────────────────────────────────┘
 └──────────────────────────────────────────┘                 sandbox-exec (macOS) / bwrap (Linux)
                                                              no network · writes only its job dir · reads only
                                                              runtime, worker code, system libs, granted paths
```

## Using it

```ts
import { runShellIsolated, extractIsolated, Executor } from './worker'

// shell: backend is the permission-filtered VFS
const r = await runShellIsolated('grep -r 매출 / | head', vfs, { token, person, hooks, job: { wrap, parentCommands } })
// r.stdout / r.stderr / r.exitCode; r.run has status, isolation, timings

// extraction: bytes (preferred) or a path
const { status, text } = await extractIsolated(bytes, 'docx', { token, person })
```

The server itself extracts only through `extractDocument(name, bytes, who)` in `src/extract/run.ts` (next section).

`runIsolated(job, opts)` / `Executor.run` is the general form. It never throws for job failures; it returns
`RunResult.status`:

| status | meaning |
|---|---|
| `ok` | finished; `value` (JSON) and/or `body` (bytes) hold the result |
| `error` | the job threw inside the worker (`error.message`) |
| `timeout` / `memory` / `output` | killed for a limit (deadline, RSS cap, channel/log bytes) |
| `crashed` | the worker died or broke the protocol |
| `busy` | refused at admission: this token already has `maxQueuedPerToken` jobs waiting |
| `aborted` | the caller's `AbortSignal` |
| `refused` | isolation is required but not available (or `requireRunAs` and the user could not be applied) |

A backend call (fs or parent-run command) that throws something other than an fs error is a server bug: it is logged
(`setBackendErrorHandler`), counted in `stats.backendErrors`, and the shell sees a fixed `EIO` for that one call (never
the error's text, which may hold real paths). The job goes on, as it would in-process. (There used to be a `host-error`
status that aborted the whole command; an abort is a distinct answer, so it could tell a hidden path from a missing one
whenever the error depended on the path.)

`shellFailure(result)` turns the failure statuses into shell-like output (`timeout` → exit 124, `memory` → 137, ...).

## Wiring it into the server (src/shell.ts)

`FsBackend` is a subset of just-bash's `IFileSystem`, so `VirtualFs` is passed as is. The two things the in-process
shell did with closures become hooks:

```ts
import { runShellIsolated } from './worker'

export async function runShell(s: Session, command: string): Promise<ShellResult> {
  const vfs = new VirtualFs(s)
  const greps = new Map(grepCommands(vfs).map((c) => [c.name, c]))
  const { stdout, stderr: rawErr, exitCode } = await runShellIsolated(command, vfs, {
    token: String(s.token.id), person: String(s.token.person_id), timeoutMs: LIMITS.commandMs,
    job: {
      cwd: '/', env: { HOME: '/drafts', PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', USER: 'agent' },
      wrap: Object.keys(MODES),                 // fs calls inside these carry the command line
      parentCommands: [...greps.keys()],        // grep/egrep/fgrep/rg run here, on real ripgrep
      bash: { executionLimitProfile: 'hardened', executionLimits: { maxOutputSize: LIMITS.stdoutBytes * 4 } },
      maxStdoutBytes: LIMITS.stdoutBytes * 4, maxStderrBytes: LIMITS.stderrBytes * 4,
    },
    hooks: {
      // read modes (raw bytes / weak provenance) are decided here, from the command line the worker reports
      withCommand: (cmd, fn) => { const m = cmd && MODES[cmd[0]!]; return m ? commandMode.run(m(cmd.slice(1)), fn) : fn() },
      runCommand: (name, args, ctx) => greps.get(name)!.execute(args, { cwd: ctx.cwd, stdin: Buffer.from(ctx.stdin).toString('latin1') } as never),
    },
  })
  // ...then the existing notes / "(extracted text: ...)" decoration and output caps, unchanged
}
```

Checked against main (commit c7034b5) with a differential script: 28 commands × 2 tokens (`ls`, `cat` of docx,
`grep -r`, `grep -rl | sort`, `wc -c` raw mode, `sha256sum`, `/.raw/`, drafts write + read, write to an original,
`find`, missing file, `du`) give **identical stdout, stderr, exit code and touched-file sets** in-process and isolated.
`MODES` needs to be exported from shell.ts; `s.notes` / `s.extracted` decoration happens after the call as today.

After the call returns, nothing more reaches the backend: the executor stops serving the moment it parses `done`
(or kills the worker) and waits for calls already running, so `s.commit()` sees the final state.

## Document extraction (`src/extract/run.ts`)

Every text extraction the server does goes through `extractDocument(name, bytes, who)`: the mirror's on-demand path
(`cat`/`head`/`read`/`grep` of an office file, `src/mirror.ts`) with `who` = the calling token and person, and the
reconciler's queue (`extractForIndex` in `src/inplace/extractq.ts`) with `who` = `@index`. It sends the bytes the server
read with its own no-follow checks (R1 ⑤ ⑦) to a worker, so the worker has no file access at all.

- **Its own executor** (`extractExecutor()`): one job per process (never kept), no shell engine loaded at boot
  (`WORKER_PRELOAD=0`), 1 warm worker, admission global = CPUs / 2, per token 2, per person 3, queue 256. Separate from
  the shell's on purpose: a shell command that reads an office file holds a shell slot while the server extracts, so
  extraction queued behind shell jobs would deadlock until the deadline.
- **pdftotext only where needed**: a PDF goes to a fresh worker whose profile may exec pdftotext (per-job `execPaths`,
  path passed in the job: the worker does not share the server's environment); docx/xlsx/pptx/hwp/hwpx workers may
  exec nothing.
- **Limits**: `LIMITS.extractMs` (20 s) and `LIMITS.extractRssBytes` (512 MB) per document; text over 32 MB (the frame
  cap) is `output`.
- **Errors**: a parser error, deadline, memory or output kill, or a crash is an `ExtractError` ("cannot extract text:
  …"); the mirror remembers it for that file version, so a malicious document costs one worker, not one per read.
  `refused` (no isolation and `requireIsolation`), `busy` and a worker that did not start are `ExtractUnavailable`: the
  read fails with that message and nothing is remembered. There is no in-process fallback.
- `SHELF_EXTRACT=inprocess` runs the parsers in the server process (development and tests only).

## Protocol (v1, `protocol.ts`)

Transport: the worker's stdin (server → worker) and stdout (worker → server); the worker redirects `console.*` to
stderr, which the server keeps as a capped log. Frame = `u32 header length | u32 body length | header JSON | body`.
The body carries bytes (file contents, stdin of a parent-run command, extracted text) without base64.

| direction | message | notes |
|---|---|---|
| W → S | `{t:'ready', v}` | after boot; the server checks `v` |
| S → W | `{t:'job', v, job}` (+ body) | one at a time; another only after `done`, only of the same token; `job.kind` = `shell` or `extract` |
| W → S | `{t:'fs', id, op, args, cmd?}` (+ body for write/append) | `op` ∈ stat lstat exists readdir read write append mkdir rm cp mv chmod utimes symlink link readlink realpath |
| W → S | `{t:'cmd', id, name, args, cwd, cmd?}` (+ body = stdin) | only names in `job.parentCommands` |
| S → W | `{t:'reply', id, ok, value \| error}` (+ body for `read`) | errors are `{code, message, path}` |
| W → S | `{t:'done', ok, result \| error}` (+ body) | the server ignores everything after it |

The server treats the worker as hostile: header ≤ 1 MB and body ≤ `maxFrameBytes` are checked from the length prefix
before buffering; total bytes ≤ `maxChannelBytes`; ≤ 256 requests in flight; shapes, op names, argument types and
path lengths are validated; an unknown command or malformed frame kills the job (`crashed`). Backend errors with a
string `code` (or just-bash's `ENOENT: ...` message convention) go back to the shell; any other error is a server
bug, logged and answered with a fixed `EIO`.

`cmd` is the command line of the innermost command listed in `job.wrap` (just-bash's `origCommand` wrapped in an
AsyncLocalStorage). It is a **label from the untrusted worker**: it may choose raw bytes vs extracted text and
strong vs weak provenance, both of which the agent can choose anyway (`/.raw/`, and R3 treats weak and strong the same),
so it can never widen what is read.

The worker answers `/bin`, `/usr`, `/dev`, `/proc` itself from just-bash's stub layout (no team data; just-bash stats
`/usr/bin/<name>` before every command), so a typical command costs 2–10 round trips.

## Process lifecycle and limits (`pool.ts`)

- **One token per process.** A warm pool (default 2) keeps processes that have booted and loaded code — including a
  warm-up run of common commands on a throwaway in-memory filesystem, because just-bash loads each command on first
  use (~35 ms) — but have never seen a job. If the pool is empty the job starts a fresh worker (cold).
- **Kept for the same token** (`reuse`, default on; `SHELF_WORKER_REUSE=0` turns it off). After a *clean* shell job
  (`done` received, no limit breach, no abort, RSS below half the cap) the process waits up to `idleMs` (5 s) for the
  same token's next shell command, at most `maxJobs` (32) jobs, at most `perToken` kept per token and `maxIdle` (4)
  overall. It is keyed by token **and** person and never given to anyone else; extraction jobs and jobs with read
  grants are never kept. Why this is safe: whatever a job could leave behind in the process (even after an exploit),
  the same token saw in that job's output anyway, and its touches are already in the token's provenance window (R3)
  when the next call commits. If a call's audit row cannot be written (so its touches are not recorded), the token's
  kept workers are killed (`discardKept`). Everything else is killed after its job and its job dir deleted.
  Without it every command pays a process start (~80–120 ms); with it a token's command sequence costs ~2–5 ms each.
- **Warm reserve.** The last warm worker (default 1) goes only to a token with nothing else running; a token that is
  already busy starts cold. A flood cannot drain the pool and slow everyone else's next command.
- **Deadline** (`timeoutMs`, default 20 s, from job start, not counting the queue) → SIGKILL.
- **Memory**: a watchdog polls every 20 ms while jobs run (libproc via `bun:ffi` on macOS, a few µs per process;
  `/proc` on Linux) and sums the worker's process tree (descendants + its process group); above `maxRssBytes`
  (default 512 MB) → SIGKILL.
- **Bytes**: frames ≤ `maxFrameBytes` (32 MB), channel ≤ `maxChannelBytes` (256 MB), stderr kept to `maxLogBytes`
  (16 KB) and killed past 16× that. Shell output is also cut by the worker (`maxStdoutBytes` / `maxStderrBytes`).
- **Back-pressure on reads**: at most 2 `read` calls per worker are served at once, and each keeps its slot until its
  reply has left the pipe (`FileSink.flush()`). A worker that asks for many large files and stops reading its stdin
  holds at most two replies in the server; everything it does take in counts against its own RSS cap. The server's
  VirtualFs also caps what one call may read: 64 MB per file, 128 MB per call (`LIMITS.fileBytes`, `callReadBytes`),
  checked from the size before anything is read (EFBIG; hidden paths never reach the check, so they still answer
  ENOENT like missing ones).
- **Kill** = SIGKILL to the process group (workers start with `setsid`) **and** to every descendant found by the probe
  (in case one left the group), at the breach and again after exit. Tests check that no worker or child survives.
- **Job dir**: `mkdtemp` under `$TMPDIR/shelf-work-<uid>/` (0700; 0711 with a worker user), the worker's cwd, HOME
  and TMPDIR, the only writable place; removed when the process is killed (after its job, or its last job when kept).
- **Environment**: the worker gets only `PATH HOME TMPDIR LANG NO_COLOR TZ` (+ `WORKER_PREWARM`), never the server's.
  `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0`: a shared transpiler cache would be state shared between jobs.
- **Server death**: a worker exits when its stdin closes; bwrap also uses `--die-with-parent`.

## Admission (`scheduler.ts`)

Limits per token (default 2), per person (3) and overall (CPU count − 2, at least 2), plus at most 64 waiting jobs per
token (beyond: `busy`); env `SHELF_WORKERS_GLOBAL`, `_PER_TOKEN`, `_PER_PERSON`, `_QUEUE` (read when the process-wide
executor starts). `info()` reports `limits` and `runningBy` (per token / per person); test/security/resource.test.ts
checks all four through the `bash` tool. Extraction has its own scheduler (above). Waiting jobs sit in one queue per token, served round-robin across tokens; a person's tokens
share the person limit. So one token's flood only fills its own slots and its own queue, and another token's job
waits at most for one global slot.

## Isolation (`sandbox.ts`)

`Executor.isolation` / `RunResult.isolation` is `"sandbox-exec" | "bwrap" | "none"`. With `requireIsolation`
(default **true**, plan 6: "격리를 못 하면 추출·셸을 거부한다") the executor refuses (`refused`) when it is `none`.

**macOS — `sandbox-exec`, deny-by-default profile** (generated per worker, `macProfile()`):

- exec: only the Bun runtime, plus `execPaths` (e.g. `pdftotext` for PDFs; then `process-fork` too). Children inherit
  the sandbox.
- read: system libraries and data (`/usr/lib`, `/usr/share`, `/System/Library`, dyld cache, time zones), the runtime,
  the worker code (`src/`, `node_modules/`, `package.json`, `tsconfig.json` — not the whole checkout, which may hold a
  data dir), tool install dirs, and per-job grants. Metadata only for the ancestors of those; listing (names only) of
  the folder holding `node_modules` (Bun's resolver needs it). Never a folder of team files.
- write: only the job dir (+ `/dev/null`).
- network: denied by `(deny default)` + `(deny network*)` (tests try `fetch` and raw TCP to the internet and to a
  server on 127.0.0.1). `mach-lookup` denied. Signals only to itself. `sysctl` reads limited to machine information.
- Verified here (macOS 26 / Darwin 25.3, Bun 1.3.12): blocked network, writes outside the job dir (home, `/tmp`, a
  sibling dir), reads and listings outside the grants (home, `~/.zshrc`, a sibling secret file), exec of `/bin/sh`
  and `curl`, signals to the server. No server file descriptors are inherited.

**Linux — `bwrap`** (`bwrapArgs()`): `--unshare-all` (so no network), `--die-with-parent --new-session --cap-drop ALL`,
read-only binds of `/usr /lib /lib64 /bin` + the same grants, the job dir read-write, fresh `/proc /dev /tmp`.
Detection runs bwrap once (user namespaces may be off). **Not tested on this Mac.** Without bwrap: plain subprocess,
`isolation: "none"`, refused unless `requireIsolation: false`. A cgroup per job (`Bun.spawn({cgroup})`, `memory.max`,
`pids.max`) is the natural next step there.

**Dedicated worker user** (`runAs`, env `SHELF_WORKER_USER`, e.g. `_shelfwork`): workers are spawned with that
uid/gid. This needs the spawning process to be root; there is no sudo and no setuid helper. When the server is not
root the executor runs workers as the server user, reports `user: null` and adds a warning (or refuses with
`requireRunAs`). The intended deployment (installer, later): a root launchd daemon that starts a tiny spawner which
keeps root only to start workers as `_shelfwork`, while the server itself runs as `_shelf`; code and runtime installed
in a world-readable place (not under a 0700 home). This is what closes the gap below.

## Measured on this Mac (M1 Pro, 10 cores, under load from other sessions)

| | |
|---|---|
| warm pool, `cat f \| wc -l` end to end | median **5 ms**, max 9 ms (target < 50 ms) |
| cold (spawn + sandbox + boot + first command) | median **117–125 ms** (boot ≈ 90 ms + first exec ≈ 35 ms) |
| pool worker boot incl. warm-up | ≈ 250 ms (refill, off the request path) |
| bare `bun` spawn / under `sandbox-exec` | ≈ 20 ms / ≈ 28 ms |
| infinite loop, 700 ms deadline | killed at 704 ms |
| memory bomb, 268 MB cap | killed 50–75 ms after start; peak 272–358 MB (20 ms polling overshoot) |
| token B `ls \| wc -l` during token A's 50 × 400 ms CPU jobs (global 4, per-token 2) | p50 10–20 ms, p99 165–300 ms over 10 runs (assert < 500) |
| main's VirtualFs, 28 commands back to back (pool drained) | median 117 ms |
| 30 commands of one token back to back, `cat f \| wc -l` over the server VFS | one job per process: 2.4 s (≈ 80 ms each, the warm pool cannot refill fast enough); kept worker: 0.28 s (≈ 2 ms each) |
| extraction of a ~1 MB document, in-process parser → worker (median; pool refilled / back to back) | docx 6 → 29 / 43 ms, hwp 8 → 29 / 46 ms, pdf (pdftotext) 97 → 137 / 134 ms (a PDF always starts a fresh worker) |
| read flood: 64 reads of 16 MB requested, worker stops reading | before: all 64 served, server RSS +1.3 GB; now 2 served, +38 MB |

A pre-built single-file bundle of the worker did not start faster (4.5 MB to parse), so workers run the sources.

## Known limitations

- **Same-uid process arguments.** `sandbox-exec` does not mediate `sysctl(KERN_PROCARGS2)`: a worker that gains code
  execution (a just-bash or parser bug) can read the argv and *initial environment* of the server and of any other
  process of the same user (tested: the canary variable is visible), and could put it in its output. Mitigations: the
  dedicated worker user (only root can read another uid's arguments), and no secrets in the server's environment.
  The process list (pids) is also visible.
- `sandbox-exec` is deprecated by Apple, though still present and working on macOS 26. The profile is tested only here.
- Memory is polled, so a fast allocator overshoots the cap by up to ~100 MB; there is no hard RLIMIT on macOS
  (`RLIMIT_AS` breaks Bun's address-space reservation). No CPU-time limit beyond the wall-clock deadline.
- `cmd` (the command line used for read modes) is reported by the worker; it can only pick between views the agent
  may see anyway.
- A worker can make the server do work within its limits (fs calls, parent-run commands, writes of up to
  `maxChannelBytes` into the session's pending drafts). Set `maxChannelBytes` per job type as needed.
- Linux (bwrap, `/proc` probe) is written but untested here; Windows is not supported.
- With a worker user, the memory probe needs the server to be root (libproc refuses other uids otherwise; `ps` would
  be the fallback).
- Extraction by path grants that one file to a fresh worker (no warm pool). The server always passes bytes it read
  with its own no-follow checks (R1 ⑤ ⑦); then the worker has no file access at all. A PDF always starts a fresh
  worker (its own exec grant), ≈ 60–100 ms more than a warm one.
- The reconciler's extractions share the extraction executor with on-demand reads (as token `@index`, at most 2 at a
  time); the round-robin queue keeps a token's read from waiting behind a whole indexing backlog, but not behind the
  2 indexing jobs already running.
- A remembered extraction failure (deadline, memory) stays until the file changes, also when it was caused by load.

## Configuration

`new Executor(config)`, `defaultExecutor()` for shell commands (env: `SHELF_ISOLATION=auto|sandbox-exec|bwrap|none`,
`SHELF_REQUIRE_ISOLATION=0`, `SHELF_WORKER_USER=_shelfwork`, `SHELF_WORKERS_WARM=2`, `SHELF_WORKER_REUSE=0`,
`SHELF_WORKERS_GLOBAL/_PER_TOKEN/_PER_PERSON/_QUEUE`) and `extractExecutor()` for extraction (same isolation settings,
`SHELF_EXTRACT_WARM=1`, `SHELF_EXTRACT_GLOBAL/_PER_TOKEN/_PER_PERSON/_QUEUE`). Config
fields: `isolation`, `requireIsolation`, `runAs`, `requireRunAs`, `tmpRoot`, `warm`, `warmReserve`, `reuse`
(`false` or `{idleMs, maxJobs, maxIdle}`), `limits` (scheduler), `defaults` (job limits), `codePaths`, `execPaths`,
`runtime`, `entry`, `pollMs`, `bootTimeoutMs`, `preloadShell`. `closeDefaultExecutor()` stops the process-wide executor (a one-shot
process such as `cli sh` calls it so the warm pool does not keep it alive). Per run: `token`, `person`,
any `JobLimits` field, `backend`, `hooks`, `body`, `readPaths`, `execPaths`, `signal`.

## Tests

`bun test tests/worker.test.ts` (36 tests, ~12 s; the macOS sandbox tests are skipped elsewhere). Hostile fixtures in
`tests/fixtures/hostile.ts` run inside workers: infinite loop, memory bomb, stderr flood, junk on the channel, forged
protocol frames (un-offered command, requests after `done`), child-process spawn + spin (no survivors, job dir gone),
network/write/read/list/exec/signal attempts, and the procargs probe. Plus: just-bash over a proxied in-memory backend
(ls, cat, pipes, globs, `/drafts` writes, backend errors, wrapped-command labels, grep/rg run in the parent),
extraction through `src/extract` (docx from bytes; pdf via `pdftotext` from a granted path), latency, fairness under a
flood, the scheduler and frame decoding, a backend bug answered with EIO, and kept workers (same token only; not
after a failure, an extraction, `maxJobs` or `idleMs`; `discardKept`, `close`).
A read flood (`readFlood`: 64 requests for a 16 MB file, then never reading stdin) is held to 2 reads.

`bun test test/extract-isolation.test.ts`: the server's extraction path with malicious documents
(`test/hostile-docs.ts`): a docx and an xlsx zip bomb, a docx whose text run makes the tag-stripping regex quadratic
(minutes of synchronous work), and a 1 KB .hwp whose self-referencing DIFAT chain makes the CFB reader build a > 1 GB
FAT. Each `cat` is refused with the reason while another token's `ls` keeps p99 < 200 ms, the failure is remembered,
the reconciler path is isolated too, and without isolation extraction is refused. In-process the same files block the
server for 1.2 s (docx bomb, 850 MB), 29 s (xlsx bomb, 1.6 GB), 6 s (hwp, 1.8 GB) and ~10 min (regex).
