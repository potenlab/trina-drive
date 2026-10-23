# Security model

What Trina Drive promises, how it keeps the promise, and where it does not. Report vulnerabilities as described in
[SECURITY.md](../SECURITY.md).

## Threat model in one page

AI agents are most useful when they can read private data, take in untrusted content, and send things out. That
combination (Simon Willison's *lethal trifecta*) is exactly what leaks data. Trina Drive does not try to make the agent
trustworthy; it limits what any one agent connection can reach and records everything it does.

| threat | what Trina Drive does | what it does not do |
|---|---|---|
| An agent reads files its person should not see | Every path (shell, `read`, `grep`, search, web) goes through one policy function: agent view = the person's AI rules ∩ the token's scope. Hidden files are indistinguishable from missing ones. | It cannot stop a person from pasting what they legitimately see into another tool. |
| Prompt injection inside a document makes the agent exfiltrate data | The agent sees only its token's slice, writes only to its own draft box, and drafts carry their sources; widening a draft needs a person with a passkey. Bulk-read alarms and per-token rate limits. | It cannot see what the AI client does with text after it leaves the server (the client's own network access is the client's policy). |
| An agent overwrites or deletes originals | Originals are read-only through Trina Drive. Agents write to `/drafts/`; promotion creates a new file, never overwrites. | Writes that bypass Trina Drive (someone's own NAS mount) are outside its reach; the reconciler records them after the fact. |
| A leaked token | Expiring personal tokens (8 h to 90 days), scoped and optionally read-only, stored in the OS keychain; new-client alerts; one-click revoke takes effect on the next request; tokens and secrets are redacted from audit rows. | — |
| A malicious document attacks the parser | Shell commands and document extraction run in sandboxed worker processes (`sandbox-exec` on macOS, `bwrap` on Linux) with deadlines and memory caps; without OS isolation they are refused. | ripgrep runs as a child of the server with a timeout and output caps, not in the sandbox. |
| Someone with server access rewrites the audit log | Hash chain plus signed anchors sent off the server (mail, another disk); `audit verify --against` catches rewritten history. | Truncation after the last anchor looks like rows never written. |
| A browser agent clicks "approve" in a signed-in session | Every approval needs a fresh passkey (or TOTP on LAN-only installs) bound to that request. | — |

Plain-language promise: *your AI agents see only the files each person is allowed to, never change originals through
Trina Drive, and every read and write is logged.* We do not claim "data never leaves": what an agent reads goes to the
AI provider that person chose.

## Permission model (plan §4.1, as implemented)

`src/policy.ts` is the only place that decides reads; shell, read tool, grep, mirror and drafts all go through it,
and the token's scope is computed inside it.

- **R0 effective rule**: folders are keyed by filesystem identity (dev+ino and birth time; path is only where it was
  last seen). The birth time matters on Linux: ext4 gives a deleted folder's inode number to the next new folder, which
  must not get the old folder's rules, flags or registration (a row whose birth time differs is another folder).
  Rule for person P on folder F = max over P and P's groups of `none < read < write` rules from F up to the nearest
  break (inclusive); registered folders, personal folders and `--break` folders are breaks. Personal folders: owner
  only. Flags (`no_ai`, `quarantine`, `widened_pending`) come down from every ancestor and cannot be cleared below.
- **R1 read**: inside a registered folder ∧ no flag on the path ∧ rule ≥ read ∧ under a token-scope folder ∧ no link
  anywhere (every step is lstat'ed, files opened with `O_NOFOLLOW`, link count must be 1, XSym link files closed) ∧ not a NAS/OS system entry
  (`#recycle`, `#snapshot`, `@Recycle`, `@Recently-Snapshot`, `.snapshot`, `~snapshot`, `@eaDir`, `.@__thumb`,
  `.Trashes`, `$RECYCLE.BIN`, `.TemporaryItems`, `.DS_Store`, `._*`, `~$*`) ∧ re-checked (identity of the file and of
  every folder up to the mount) after reading, right before content is returned. Names are compared on NFC and opened
  by their original bytes; two names equal after NFC in one folder are both closed. A folder you cannot read but that
  holds something you can is shown as a bare path (only that child is listed). Folder stat values are synthetic.
- **R3 provenance**: per token, a moving 8-hour window of folders touched — strong when content was output, weak when
  the command only looked (non-matching grep targets, `grep -l/-c/-q`, `ls`, `stat`, `wc`, `sha256sum`, `test`).
  A draft's sources = union of the writing token's window at each write; they never shrink; reading a draft brings its
  sources into the reader's window.
  **Provenance reset** ("출처 초기화", plan 5.1): the person, on the web (My tokens → "Reset provenance") or
  `POST /api/tokens/:id/provenance-reset` on their own token, after a fresh login (password typed within the last 5
  minutes: sign-in, `POST /api/me/reauth`, or `password` in the body), empties that token's window (its `touches` rows
  only — other tokens and every existing draft's sources stay). One audit row on that token; event `provenance_reset`
  to the admins and the person (kind, count, link; R11).
- **R4 draft visibility**: same person ∧ the token can read every source folder right now; no sources → only the token
  that wrote it. Other people and admins never see drafts.
- **R5/R6 widening** (`isWidening(src, target)`): target readers = rule readers ∪ NAS readers ("unknown" = everyone);
  source readers = rule readers (none if no-AI/quarantined) ∪ NAS readers ("unknown" = nobody); widening if some target
  reader is not a reader of some source S ≠ target. Function and tests only; no NAS watcher.
- **Audit**: every tool call (command line cut at 4 KB + sha256 of the whole, files touched, outcome), hash-chained;
  secrets in the command line, file names and outcome are redacted before storing (`src/redact.ts`: our tokens keep
  their 4-character hint, e.g. `tdrive_pat_AbCd…[REDACTED:token]`; setup tokens, AWS key ids and secrets, GitHub, GitLab,
  Slack tokens and webhooks, PEM private keys, `Authorization:`/Bearer/Basic values, JWTs, OpenAI/Stripe/Google keys,
  URL passwords, `password=`/`token=`-style assignments); the sha256 still covers the whole original line;
  touches, draft writes and the audit row commit in one transaction, so if the audit row cannot be written the call
  fails and nothing it wrote is kept.

## Alerts and audit

Plan §4.1 R9/R11, §5.1, §7.1 (token leak, audit forgery). Code in `src/notify/`.

**Events** (`src/notify/events.ts`, one `EventBus` per runtime):

| event | emitted by | goes to |
|---|---|---|
| `widened_draft` | reconciler (not in this branch): `rt.emit({kind, sourceFolderIds, targetFolderId, weakOnly})` | source-folder `manage` holders (detail); a source with none → admins, count only; target-folder `manage` → "1 item" only. Weak-provenance-only → daily digest |
| `original_write_attempt` | every committed call whose shell or `edit` tried to write an original | the token owner (detail), admins (count) |
| `bulk_read` | bulk-read alarm (below) | the token owner (detail), admins (count) |
| `quarantine` | reconciler: `{kind, folderId}` | admins and the folder's `manage` holders |
| `new_client` | MCP endpoint / CLI `sh`: first request from a client the token has not used | the token owner |
| `admin_self_grant` | admin API (not in this branch): `{kind, folderId, subjectPersonId}` | the folder's `manage` holders and the person concerned, at once |
| `password_reset` | admin API: `{kind, subjectPersonId}` | only that person (their own address) |
| `token_revoked` | `connections revoke`, `token revoke`, auto-suspend | the token owner |
| `audit_anchor` | anchor timer, `audit anchor` | admins (email carries the signed anchor) |
| `provenance_reset` | web: `POST /api/tokens/:id/provenance-reset` | admins (detail) and the person (if it was not them, their password is known) |
| `approval_pending` | `promote` (MCP or web) that widens | people who may approve it now (R8, detail) ; other managers of the target or a source: count only ("1 pending"). Link: `<baseUrl>/#/approvals` |
| `approval_decided` | approve / reject, or a request closed because no one can approve | the requester |

`manage` is inherited down (none inside personal folders); inactive people never receive anything.

**Payloads (R11).** Every channel message is rendered from the event kind, a count and a link only
(`messages.render`): `[Trina Drive] 2 widened drafts to review` / `[Trina Drive] 넓어진 초안 2건 확인 필요` plus
`<baseUrl>/alerts/<kind>` (detail level) or `<baseUrl>/inbox` (count level). No file, folder or draft names, no
provenance, no person names, no ids. The one addition: anchor emails carry the signed anchor (hash, row count, time,
key fingerprint, signature). Event details (ids) are stored in `notify_events` for the logged-in screen only, which must
apply R7. A property test generates random names for everything and checks no channel or inbox payload contains one.

**Channels.** In-app inbox (`notify_inbox`, one unread row per person × kind, counts add up), Slack incoming webhook
(`{"text": …}`) and email (`email.mode`: `outbox` = `.eml` files in `<data>/outbox` for development, `smtp` = a
minimal SMTP client, plain or implicit TLS, AUTH PLAIN; `$TDRIVE_SMTP_PASS` overrides the stored password, `off`).
Contacts per person: `notify contact kim --email kim@corp --slack https://hooks.slack.com/… --lang ko`. Delivery:
pending rows are flushed every `flushMs` (5 s) by `serve`; same kind to the same destination coalesces into one message
with the summed count; at most `perMinute` (6) messages per destination per minute, the rest waits and coalesces
further (password reset, self-grant and revocations go first); failures retry with backoff, 5 attempts.

**Bulk-read alarm.** Per token, a sliding window (`bulkRead.windowMs`, 10 min) over committed calls: files whose content
was output (cat, read, grep matches; `ls`/non-matching grep do not count), their original bytes, distinct folders.
Thresholds `bulkRead.files` 200, `bulkRead.bytes` 50 MB, `bulkRead.folders` 20 (0 = off); fires once per window.
`bulkRead.autoSuspend` (off by default) revokes the token when it fires (suspension = revocation; the owner makes a new
token). Example: `notify set bulkRead.files 500`.

**Connections.** Each authenticated MCP message records token × client: `clientInfo` name/version from `initialize`,
user-agent product (version stripped, so updates are not new clients) and source IP (`newClientByIp`, default on). CLI
`sh` records itself as `tdrive cli` from `local`. `connections list` shows token, person, client, IP, last used, request
count; `connections revoke <token-id>` (= `token revoke`) revokes at once. `mcp.ts` checks the token (revoked, expired,
inactive person) on every request, so the next request fails with 401; a test proves it in-process.

**Audit anchor (principle 6).** An Ed25519 key is made at `init` (or first use) in `<data>/anchor/` (private key 0600).
Every `anchor.intervalMs` (default daily; nothing is sent if the chain did not change) `serve` signs
`{count, head hash, time, key fingerprint}`, stores it (`audit anchors`), writes it to `anchor.dir` (put this on
another disk or a synced folder) and emails it to admins. `audit verify --against <file>` (the `.json` or the saved
email) checks the anchor's signature, that this install still has the same key, that the chain verifies, and that row
#count still has the anchored hash: an operator who rewrote or deleted earlier rows and recomputed every hash is caught,
because the anchor already left the server. Exit code 1 on mismatch. `audit anchor [--force]` anchors now.

**Settings** live in `<data>/notify.json` (`notify show`, `notify set <dotted.key> <json>`): `baseUrl`, `lang`
(`en`/`ko`), `email`, `perMinute`, `flushMs`, `digestHour` (local hour, 9), `bulkRead`, `newClientByIp`, `anchor`.

## Second factors (passkeys, TOTP)

`src/web/mfa.ts`, `src/web/totp.ts`, Settings → Second factor (`web/src/pages/SecondFactor.tsx`).

- **Passkeys** via `@simplewebauthn/server` (works under Bun): RP ID = host of `--public-url` when it is https (http only
  on `localhost`); attestation `none`; user verification required; algorithms ES256, EdDSA, RS256; counter kept.
  Challenges are single use, 5 minutes, bound to what they are for (`session:<hash>`, a sign-in ticket, or
  `approval:<id>:<sha256>:<session>`).
- **TOTP** RFC 6238 (SHA-1, 6 digits, 30 s, ±1 step); confirmed with a code before it counts; each step accepted once
  per person (`last_step`), so a code seen by someone else is useless. The secret is stored in the database (the same
  disk as everything else; documented).
- **Recovery codes**: 10, shown once, sha256 stored, single use, sign-in only; made when the first factor is added.
- **Sign-in**: a correct password of someone with a second factor gives a 5-minute ticket (sha256 stored, ≤ 5 tries),
  not a session; a reset link does the same (R9: a reset mail is no way around it). Second-step failures are limited per
  person (5 per 15 min) and per address.
- Adding or removing a factor needs the password typed within 5 minutes, is audited and tells the person (notice +
  mail). Lost everything: the operator runs `mfa reset <person>` on the server (audited, sessions end).
- **Admin 2FA gate** (for the public listener / OAuth): `adminHas2FA(db, personId)` (a passkey or a confirmed TOTP),
  `allAdminsHave2FA(db)` (every active admin, at least one), `requireAdmin2FA(db)` (throws `MfaError`
  `admin_2fa_required`, 403, with a count and no names) — all in `src/web/mfa.ts`. `serve` prints whether passkeys
  are available and warns about admins without a second factor.

Tables (created on demand): `mfa_passkeys`, `mfa_totp`, `mfa_recovery`, `mfa_challenges`, `mfa_tickets`,
`mfa_stepups` (`src/web/mfa.ts`); `promote_folders`, `approvals`, `promotions` (`src/promote.ts`).

## Remote access: OAuth and the public listener (v0.2)

Step-by-step: [CONNECT-CLAUDE-AI.md](CONNECT-CLAUDE-AI.md), [CONNECT-CHATGPT.md](CONNECT-CHATGPT.md).

- **Authorization server** (`src/oauth/`, MCP authorization 2025-11-25 and 2026-07-28): `/.well-known/oauth-protected-resource[/mcp]`
  (RFC 9728; the 401 on `/mcp` carries `resource_metadata`), `/.well-known/oauth-authorization-server` (RFC 8414),
  `/oauth/authorize`, `/oauth/token`, `/oauth/revoke` (RFC 7009), `/oauth/register` (RFC 7591, off unless `--allow-dcr`).
  PKCE S256 only, public clients only (`none`), `resource` bound to `<public url>/mcp` (RFC 8707), `iss` on every
  authorization response (RFC 9207). It is on when `public enable --url https://…` set an address (the issuer).
- **Clients**: Client ID Metadata Documents first. The `client_id` URL is fetched under an SSRF guard (`src/oauth/ssrf.ts`:
  https only, every resolved address must be public — no private, loopback, link-local/metadata, CGNAT, ULA or mapped
  ranges — and the socket connects to exactly the checked addresses; no redirects; 3 s; 8 KB; JSON), must name itself,
  must list the redirect URI (loopback ones match without the port), carries no secret, is cached 1 min–24 h. Trusted
  hosts: `claude.ai`, `chatgpt.com` (more with `--client-host`, or `--any-client`).
- **Consent** (`#/oauth/<id>` in the web app, decided through `/api/oauth/requests/<id>` with the session and its CSRF
  token): the app's domain in large type (checked, or "not verified" for self-registered apps), where the answer goes
  (warning for localhost), folders (admins must pick; nobody gets folders their AI cannot read), read-only by default,
  expiry 1/7/30/90 days. Audited.
- **Tokens**: an approval becomes a row in `tokens` with kind `oauth` (person, folder scope, read-only, expiry, client), so
  `Access.forToken`, provenance, drafts, audit and "No AI" treat it exactly like a PAT, and **My tokens** lists it (marked
  OAuth · domain) with Revoke. Access tokens (`tdrive_oat_`, 1 h) and refresh tokens (`tdrive_ort_`, rotated on every use;
  reuse after a 10 s grace revokes the connection) are stored as sha256 and looked up on every request, so a revoke stops
  the next call. Codes are single use (a second use revokes what the first made), 60 s, bound to client, redirect URI,
  PKCE challenge and resource.
- **Public listener** (`src/web/public.ts`): a second Bun listener (`public enable --port 8788 --host 127.0.0.1`) for a
  Cloudflare tunnel. Only `/mcp`, `/oauth/*`, `/.well-known/oauth-*`, the app shell and `/assets`, and the sign-in and
  consent API calls (`GET /api/state`, `POST /api/login`, `POST /api/logout`, `GET /api/session`, `/api/oauth/requests/*`);
  everything else — admin API, files, drafts, audit, `/health` — is 404. Requests are rebuilt on the public https URL
  (same-origin checks, Secure cookie, HSTS); `CF-Connecting-IP`/`X-Forwarded-For` are believed only from
  `--trusted-proxy`. `serve` starts it only when `public status` passes: https public URL, an admin, a second factor for
  every admin (`requireAdmin2FA`, src/web/mfa.ts, checked live) and the v0.2 security gate (`--confirm-security-gate`).
  It also serves the approval inbox and one's own passkeys (`/api/approvals*`, `/api/login/second`, `/api/me/2fa`,
  `/api/me/reauth`, `/api/me/passkeys*`): passkeys use the public host as RP ID, so approvals happen there. `serve`
  takes the public address as `--public-url` unless one is given.

## Known limits

- Promote / approvals: a name taken by a file the caller cannot see (a closed link, an NFC twin) is refused as
  "exists", which shows that something is there (principle 2's documented hole). The link-then-unlink placement leaves
  the file with two links for a moment (agents see it closed until the unlink); shares without hard links fall back to
  an exclusive create, where a reader may see a half-written new file. The folder chain is re-checked around the write,
  not atomically with it. Eligibility is computed per request on every inbox view (fine for a team, not for thousands
  of requests). Expired requests close lazily (on the next view). The web pages were checked end to end in headless
  Chrome with a virtual authenticator, not on real devices.

- Shell commands and document text extraction (on demand and in the reconciler's queue) run in the isolated executor
  (sandboxed worker processes; see [worker.md](worker.md)); without OS isolation both are refused.
  `TDRIVE_SHELL=inprocess` / `TDRIVE_EXTRACT=inprocess` run just-bash / the parsers in the server process (development
  and tests only). pdftotext runs inside a PDF's extraction worker; ripgrep is a child process of the server with a
  timeout and output caps but no sandbox.
- The draft quota is checked when a call writes, against what is committed: two calls of one token running at once
  can each pass it (by at most what those calls write). just-bash prints every read error as "No such file or
  directory"; the real reason (too large, cannot extract) is added to stderr as a `trina-drive:` note.
- just-bash lets some redirect failures (`echo x > /경영/a`) escape `exec()`; the server reports them like bash does
  (`bash: <path>: …`) but the rest of that command line does not run.
- `mkdir` inside `/drafts/` lasts only for the call (drafts are files; folders come from their paths). `/tmp` does not
  exist (by design: nothing outside `/drafts/` is writable).
- The reconciler (see [ARCHITECTURE.md](ARCHITECTURE.md#in-place-reconciler)) works after the fact, between passes: a
  move is closed from the moment an agent walks into it until the next pass judges it, but a brand-new file appears to
  agents before its first hash and extraction (R6 copy detection runs on the next pass).
- No trash or purge of drafts yet (deleted drafts keep their rows and blobs).
- grep: BRE/ERE are translated to Rust regex (no backreferences/lookaround — refused with ripgrep's message);
  `sed`/`awk` regexes run in just-bash (it uses re2js, a linear engine, for most of them). Output of `wc` with no flag
  counts extracted text. Extraction runs on first use (no background queue yet).
- Timing differences between hidden and nonexistent paths are not equalised. Audit tail truncation after the last anchor is not caught
  (rows removed since then look like rows never written); the anchor covers everything up to it.
- macOS and Linux only. On APFS two NFC/NFD spellings cannot coexist, so that case is tested with a simulated listing.
