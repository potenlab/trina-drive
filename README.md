# shelf (codename)

> Phase-0 prototype. "shelf" is a temporary name: it lives in `package.json` (`name`) and is read from there by
> `src/config.ts` (token prefix `shelf_pat_`, data dir `~/.shelf`, env `SHELF_HOME`).
>
> License: TBD (AGPL-3.0 server planned).

A permission-aware **read shell and draft box for AI agents** over a team's existing folders (in-place mode).
An agent (Claude Code, Codex, Cursor …) connects over remote MCP with a personal access token and gets a `bash`
tool over a virtual tree that holds **only what that person, narrowed by that token, may read**. Originals are never
written: agents write to `/drafts/`, every draft carries the folders it was derived from, and every call is in a
hash-chained audit log.

Plan: `research/plans/에이전트 팀 스토리지 기획.md` (§4.1 permission model R0–R11, §5.1 v0.1 scope, §11 phase-0
experiments). This repo is the ★ prototype of §11.

## Quickstart

Needs Bun 1.3, ripgrep and poppler (`brew install ripgrep poppler`).

```sh
bun install
bun run src/cli.ts --data ./.shelf demo seed      # sample company + people + rules; prints tokens for kim and boss
bun run src/cli.ts --data ./.shelf serve --port 8787
```

Try it without an AI client:

```sh
bun run src/cli.ts --data ./.shelf sh --token <kim token> -c 'ls /; grep -r 매출 /'     # kim: nothing from 경영
bun run src/cli.ts --data ./.shelf sh --token <boss token> -c 'grep -r 매출 /'          # boss: 경영/손익.csv, 손익_요약.xlsx
bun run src/cli.ts --data ./.shelf audit verify
```

Connect Claude Code (documentation only; the token goes to your user-scope config, never a project `.mcp.json`):

```sh
claude mcp add --transport http shelf http://127.0.0.1:8787/mcp --header "Authorization: Bearer shelf_pat_…"
```

The demo: people `dion` (admin), `kim` (member, not 경영), `boss` (경영), `lee` (인사), `park` (영업); folders
`경영`, `프로젝트`, `인사`, `영업`, `공용` and kim's personal folder `개인_kim`, with csv/md plus generated pdf, docx,
xlsx, hwpx and hwp files. `bun run sim/provenance-day.ts` replays an office day (plan ★8, see below).

## CLI

```
init | person add <name> [--admin] | group add <name> | group member <group> <person>
folder register <path> [--name N] [--personal-owner P] [--nas-readers all|unknown|p1,p2]
folder flag <path> no-ai|quarantine|widened-pending|inherit-break [--off]
rule set <path> <person|@group> none|read|write [--break]
manage grant <path> <person>
token create <person> [--name N] [--scope path1,path2] [--read-only] [--ttl 8h] | token revoke <id>
audit verify | demo seed | sh --token <pat> -c <command> | serve [--port] [--host] [--allow-origin] [--reconcile-every 5m|--no-reconcile]
share add <path> | share list | reconcile once [--json] | reconcile watch [--every 5m] [--no-watch-hint]
events list [--kind K] | quarantine list [--all] | quarantine release <id> --by <person> | widened list | widened rejudge
```

## MCP

`POST /mcp`, Streamable HTTP in its stateless JSON form (one JSON-RPC message per POST, `application/json` reply, no
SSE, no session). Protocol versions `2026-07-28` and `2025-11-25`. `Authorization: Bearer shelf_pat_…` only (cookies
are never read); foreign `Origin` headers are refused (DNS-rebinding guard); listens on 127.0.0.1 by default.

| tool | what |
|---|---|
| `bash` | `{command}` → stdout, stderr, exit code. just-bash over the virtual tree; `grep`/`egrep`/`fgrep`/`rg` are ripgrep |
| `read` | `{path, offset?, limit?}` text (office files: extracted); drafts also return their sha256 |
| `write` | `{path, content, expected_sha256?}` drafts only |
| `edit` | `{path, old_string, new_string, replace_all?, expected_sha256?}` own drafts only |
| `history` | `{path, action: list\|read\|restore, version?}` draft versions |

What the shell sees:

| path / command | sees |
|---|---|
| `/<registered folder>/…` | originals the token may read; hidden = nonexistent (same output, error text, exit code) |
| `cat head tail grep rg sed awk wc -l`, `read` | extracted text for pdf/docx/xlsx/pptx/hwp/hwpx (stderr notes "(extracted text …)" once) |
| `ls -l stat du wc -c sha256sum md5sum od base64 file` | original bytes |
| `/.raw/<path>` | original bytes of any visible file (not listed at `/`) |
| `/drafts/` | this token's drafts (writable, `.md`/`.csv`/text only); other tokens' visible drafts under `/drafts/@<token>/` (read-only) |
| any other write | refused: "Originals are read-only. Write to /drafts/ and a person will move it." |

## Permission model (summary of plan §4.1, as implemented)

`src/policy.ts` is the only place that decides reads; shell, read tool, grep, mirror and drafts all go through it,
and the token's scope is computed inside it.

- **R0 effective rule**: folders are keyed by filesystem identity (dev+ino, path is only where it was last seen).
  Rule for person P on folder F = max over P and P's groups of `none < read < write` rules from F up to the nearest
  break (inclusive); registered folders, personal folders and `--break` folders are breaks. Personal folders: owner
  only. Flags (`no_ai`, `quarantine`, `widened_pending`) come down from every ancestor and cannot be cleared below.
- **R1 read**: inside a registered folder ∧ no flag on the path ∧ rule ≥ read ∧ under a token-scope folder ∧ no link
  anywhere (every step is lstat'ed, files opened with `O_NOFOLLOW`, link count must be 1) ∧ not a NAS/OS system entry
  (`#recycle`, `#snapshot`, `@Recycle`, `@Recently-Snapshot`, `.snapshot`, `~snapshot`, `@eaDir`, `.@__thumb`,
  `.Trashes`, `$RECYCLE.BIN`, `.TemporaryItems`, `.DS_Store`, `._*`, `~$*`) ∧ re-checked (identity of the file and of
  every folder up to the mount) after reading, right before content is returned. Names are compared on NFC and opened
  by their original bytes; two names equal after NFC in one folder are both closed. A folder you cannot read but that
  holds something you can is shown as a bare path (only that child is listed). Folder stat values are synthetic.
- **R3 provenance**: per token, a moving 8-hour window of folders touched — strong when content was output, weak when
  the command only looked (non-matching grep targets, `grep -l/-c/-q`, `ls`, `stat`, `wc`, `sha256sum`, `test`).
  A draft's sources = union of the writing token's window at each write; they never shrink; reading a draft brings its
  sources into the reader's window.
- **R4 draft visibility**: same person ∧ the token can read every source folder right now; no sources → only the token
  that wrote it. Other people and admins never see drafts.
- **R5/R6 widening** (`isWidening(src, target)`): target readers = rule readers ∪ NAS readers ("unknown" = everyone);
  source readers = rule readers (none if no-AI/quarantined) ∪ NAS readers ("unknown" = nobody); widening if some target
  reader is not a reader of some source S ≠ target. Function and tests only; no NAS watcher.
- **Audit**: every tool call (command line cut at 4 KB + sha256 of the whole, files touched, outcome), hash-chained;
  touches, draft writes and the audit row commit in one transaction, so if the audit row cannot be written the call
  fails and nothing it wrote is kept.

## Layout

```
src/config.ts      name, limits, protocol versions          src/policy.ts   R0 R1 R4 R5 R6 (the one decision point)
src/db.ts          SQLite schema (bun:sqlite)               src/session.ts  one call: touches, pending drafts, commit+audit
src/store.ts       people, groups, folders, rules, tokens   src/vfs.ts      just-bash IFileSystem over the policy
src/names.ts       NFC, system names, office extensions     src/grep.ts     grep/egrep/fgrep/rg → ripgrep --json
src/mirror.ts      text mirror keyed by content sha256      src/shell.ts    Bash instance, read modes, caps
src/drafts.ts      draft box, versions, R4                  src/tools.ts    the five MCP tools
src/audit.ts       hash-chained audit log                   src/mcp.ts      POST /mcp endpoint
src/extract/       pdf (pdftotext), docx/xlsx/pptx, hwpx, hwp (own CFB reader), zip
src/samples.ts     generated sample office files            src/demo.ts     demo seed       src/cli.ts  CLI
sim/provenance-day.ts   plan ★8 replay                      test/           bun test
```

## Known limits

- **No isolated executor yet.** just-bash runs in the server process with its `hardened` limits (command count,
  loop iterations, output size) and a wall-clock deadline; ripgrep and pdftotext are child processes with timeouts and
  output caps but no sandbox (`sandbox-exec`/bwrap is planned for dev weeks 3–4). The deadline is cooperative: a
  pathological in-process step could overrun it.
- just-bash lets some redirect failures (`echo x > /경영/a`) escape `exec()`; the server reports them like bash does
  (`bash: <path>: …`) but the rest of that command line does not run.
- `mkdir` inside `/drafts/` lasts only for the call (drafts are files; folders come from their paths). `/tmp` does not
  exist (by design: nothing outside `/drafts/` is writable).
- Reconciler (below) is after the fact between passes: a move is closed from the moment an agent walks into it until
  the next pass judges it, but a brand-new file appears to agents before its first hash/extraction (R6 copy detection
  runs on the next pass). No notifications (R11; events carry the recipients), no `manage` enforcement beyond storing
  grants, no web UI, no trash/purge of drafts (deleted drafts keep their rows and blobs).
- grep: BRE/ERE are translated to Rust regex (no backreferences/lookaround — refused with ripgrep's message);
  `sed`/`awk` regexes run in just-bash (it uses re2js, a linear engine, for most of them). Output of `wc` with no flag
  counts extracted text. Extraction runs on first use (no background queue yet).
- Timing differences between hidden and nonexistent paths are not equalised. Audit tail truncation is only caught with
  an external anchor (not built).
- macOS and Linux only. On APFS two NFC/NFD spellings cannot coexist, so that case is tested with a simulated listing.

## In-place reconciler (plan 2.2, R1 ⑤–⑦, R6, R10, 11-9)

`src/inplace/`. Walks the registered folders (and `share add` roots: the whole share, identity + hash only) with lstat,
never following links and skipping NAS system folders; diffs against the last walk by identity (dev+ino, birth time).

| finding | what happens |
|---|---|
| rename (same identity, same parent), move that does not widen | rules follow the identity; folder paths updated |
| move whose new readers (R5 target) are wider than the old location's (R5 source) | identity quarantined (`quarantine` kind `moved`) + event for admins and old-location managers |
| a rule-bearing folder's identity vanished | its last path stays closed for any other identity (`lost`), rules stay on the lost id |
| symlink, hard link, identity at 2+ paths, XSym file, Mac alias (data or AppleDouble Finder info), NFC collision | closed (`fs_index.closed`) + one `closed` event per reason per pass |
| new/changed file | sha256 (small first), text mirror filled (queue, 2 at a time), compared with every draft version: same sha256 or ≥ 30% paragraph overlap → `widened` row; if `isWidening(Src(d), folder)` → `pending` (closed to agents) until the admin or a manager of every source confirms; confirmed/tracked copies pass Src(d) on to readers |
| any outside change | one `outside-change` row in the audit chain (`~$*`, `.~lock.*#`, `~WRL*.tmp`, `.DS_Store`, `._*` filtered) |

Between passes the policy closes anything the index saw at another path (moved since) and asks for a pass; XSym/alias
bytes are refused at read time. `serve` reconciles on start, every 5 min (`--reconcile-every`) and on fs.watch hints.
10k small files on a local SSD: first pass ≈ 0.8 s (identity + sha256), ≈ 4 s with the text mirror; unchanged pass ≈ 0.2 s
(`bun test test/reconcile-bench.test.ts` prints it).

## Dependencies and licenses (plan ★1)

| | license | how |
|---|---|---|
| just-bash 3.6.0 (vercel-labs) | Apache-2.0 | runtime; its runtime tree is MIT/ISC/Apache-2.0/BSD, plus optional native `node-liblzma` (LGPL-3.0) and `@mongodb-js/zstd` |
| ripgrep | MIT / Unlicense | external binary |
| poppler `pdftotext` | GPL-2.0/3.0 | external binary, separate process (not linked) |
| HWP/HWPX extractor | own code (adapted from Team AX `server/src/files/hwp.ts`, same owner) | the CFB reader replaces SheetJS |
| @modelcontextprotocol/sdk 1.32 | MIT | tests only (as the HTTP client); the server endpoint is hand-written because 1.32 does not know protocol 2026-07-28 |
| typescript, @types/bun | Apache-2.0, MIT | dev |

## Tests

```sh
bun test                 # SHELF_TEST_HWP=/path/to/real.hwp also checks a Hangul-made file
bunx tsc --noEmit
```
