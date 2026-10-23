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
  reader is not a reader of some source S ≠ target. On the NAS the reconciler judges copies on every pass; every rule,
  sharing and membership change re-judges copies (NAS and managed) in its own transaction — see "Sharing" below.
- **Audit**: every tool call (command line cut at 4 KB + sha256 of the whole, files touched, outcome), hash-chained;
  secrets in the command line, file names and outcome are redacted before storing (`src/redact.ts`: our tokens keep
  their 4-character hint, e.g. `tdrive_pat_AbCd…[REDACTED:token]`; setup tokens, AWS key ids and secrets, GitHub, GitLab,
  Slack tokens and webhooks, PEM private keys, `Authorization:`/Bearer/Basic values, JWTs, OpenAI/Stripe/Google keys,
  URL passwords, `password=`/`token=`-style assignments); the sha256 still covers the whole original line;
  touches, draft writes and the audit row commit in one transaction, so if the audit row cannot be written the call
  fails and nothing it wrote is kept.

## Managed storage (cloud mode)

Plan 2.2 "관리 모드": the server owns the folders and people change files through the web (details:
[ARCHITECTURE.md](ARCHITECTURE.md#managed-storage-cloud-mode)). What changes in the model:

- **"Person's permission" is this product's.** No NAS readers: R5's readers are the rule readers; `read` = can view
  (and their AI reads), `write` = can edit. Principle 3 holds exactly (an agent = its person's rules ∩ token scope).
- **One decision point for writes too.** Every write resolves with `Access.forPerson` (R1) and needs effective rule
  `write` on each folder it changes. Hidden == missing for every path, source or target (same status, body, headers).
  A folder is moved or deleted only by someone who can see and write everything in it. Agents still write drafts only.
- **Reversible.** Replace keeps the old bytes as a version; delete is a trash with a restore; both are audited.
- **Widening by people is logged, not held** (R6/R10): a person may move or copy into a folder more people read; the
  audit row says so. Draft copies uploaded by a person pass the draft's sources on to agents that read them (R3/R4).
- **Atomic.** Readers see the old file or the new one, never a half-written one; an audit row that cannot be written
  undoes the change.

Known limits: a name taken by an item you cannot see (a hidden subfolder in a folder you can write) answers "exists",
and `has_hidden` tells a person that a folder holds something they cannot see (principle 2's documented hole); the
operator of the server (in Trina Cloud: us) can read the disk — encrypt what must stay unreadable to them before
uploading, or self-host. File sizes and usage are not secret from the admin. The quota is checked when bytes arrive,
not reserved atomically across processes (one server process writes). Only exact (sha256) draft copies are matched on
upload (no paragraph matching), and copies made outside this server (download, edit, upload) are not tracked.
Backups (`tdrive backup`) do not yet include the managed root: back it up with the data directory's disk.

## Sharing (Trina Cloud v1: the share dialog, owner decision O1)

Google-Drive-like folder sharing on the same rules — `src/policy.ts` is unchanged; the dialog only writes rules,
manage grants and flags (`src/share/`, API in [SHARING-API.md](SHARING-API.md)).

- **Roles are a view of the rules.** Viewer = rule `read`, Editor = `write`, Manager = `write` + `manage` (R7). This is
  how the dialog shows and writes them; stored data is not migrated (a `manage` holder below `write` shows as "Manager
  (can't open files)" and is never raised silently — not by an upgrade, not by restrict-here). Team admins (console
  owner/admin) change sharing everywhere but do not read files by that alone (giving themselves access tells the
  folder's managers and themselves, R9).
- **General access** "Anyone in Trina" = a rule for the Everyone group (`meta.everyone_group`; in cloud mode a system
  group: exactly the active console members — not invites — kept by the member sync; the People page cannot delete it
  or edit its members).
  Restricted = no Everyone rule here and none from above. Rules only add downward (R0); **Restrict access here** =
  `inherit_break` on a subfolder: the entries the manager ticks are written here at their *current* level first, and
  every manager above keeps their *current* level (copied, never raised; 0 stays 0), all in one transaction.
- **Who may change what.** Admin: everything (Manager grants and removals, "No AI" off, restrict-here, the toggle,
  sharing with a non-member = the console's invite flow). Manager (not admin): Viewers/Editors, General access,
  restrict-here, "No AI" on, the toggle. **Editor (O1)**, where "Editors can change permissions and share" is on for the
  folder and every folder above (stored per folder, `NULL` = as above, `0` turns it off there and below and cannot be
  turned back on below; skill libraries keep it off): add or raise Viewers/Editors, change General access, remove
  entries given directly on this folder, turn "No AI" on. Never Manager, restrict-here, "No AI" off, the toggle,
  invitations, or confirming a widening. **Opening a folder wider to the whole team needs the Editor's step-up** for that
  folder and that change (passkey where the server has its public https address, else an authenticator code; single
  use, 2 minutes) — the one widest change is proven by a person, not a script driving their session.
- **Agents never share.** `/api` reads only the session cookie (a PAT or OAuth Bearer gets 401 on every sharing route),
  MCP has no sharing tool, WebDAV has no ACL method and refuses protected properties (`test/share-agents.test.ts`).
- **R6 on every change of readers (review finding 1).** Before: rules changed on the web never re-judged AI-draft
  copies, and copies in managed storage were never located, so an Editor could narrow a folder, let their AI promote
  a draft there (not widening: written at once), then open it to the team. Now every sharing, rule, flag, people and
  membership change (the People page, the console's member sync, an SSO sign-in that creates or reactivates someone) runs, in its own transaction: locate every live copy (NAS: the index; managed: the copy's file row
  and its last path checked by identity, else a walk of the managed folders), compute its *excess readers* (target
  readers who cannot read some source) before and after, and treat growth as widening (people and membership changes:
  only a tracked copy that had none before — someone joining an audience a source manager confirmed, or a copy a
  person placed wide on purpose, is not reopened). A widening change: the share API answers 409 `widening` (sources
  the caller cannot read are counted, never named); a manager or admin may send `confirm_widening` — the copies then
  close to agents and people until a manager of every source (or the admin) confirms them, unless the actor is such a
  person (confirmed at once); an Editor's request goes to the approval inbox and is applied, as the requester, only
  when a manager of every source (or the admin) approves it with a step-up. Source managers hear "N widened drafts"
  (kind, count, link). The audit row of the change says `widens: N`.
- **Hidden == nonexistent** holds for the dialog (a folder you cannot see is the same 404, also on POST), Shared with
  me (judged again on every request) and the directory (names for members, addresses for the admin only). The dialog's
  list is for people who open the folder, its managers and the admin; someone who sees the folder only as a path to
  something below gets their own entries only. **Known exposure:** people given a subfolder see the names of the folders
  on its path (not their contents) — the dialog says so.
- **Notices without names (O7):** "Items were shared with you" carries kind, count and a link to `/#/shared` only.
- **Audit:** every change is one row in the same transaction (`share /Projects: person:12 viewer→editor, general
  team:viewer by editor widens: 3`, `restrict-here keep=2 drop=1`), flags also in `folder_history`.

### File shares (managed storage, Trina Cloud v1 workstream A2)

A file in a team folder can be shared with a person or group (Viewer/Editor) or with the team (General access = a
grant to the Everyone group). level(P, f) = max(folder rule, file share); never inside a personal folder; never on
in-place (NAS) folders. A file share opens only the file whose identity (dev, ino, size, mtime) matches its record
(`mfiles.uid`, random, never reused); its remembered location (`mfiles.folder_id/name`) only helps find it and never
opens anything by itself. The folders above a shared file are shown as bare paths: **their names are visible to the
people it is shared with** (nothing else: no siblings, sizes, times — WebDAV shows one synthetic date for such folders —
or readers). Agents see shared files like their person (∩ token scope; "No AI", quarantine and widening flags on the
folder close them); content read through a file share counts its folder as a source (R3, `via_file`), so drafts made
from it need approval to reach readers of other folders (R6/R8), and the agent sees such a draft only while it still
reads some file shared with its person in that folder (R4). A file-only Viewer sees the current version, not earlier
ones; a file-only Editor may upload a new version or restore one, nothing else (rename, move, delete and new files need
the folder). Revoking applies to the next request on every path.

- **Who shares a file** (`src/share/file-grants.ts`): the admin and the folder's managers; folder Editors and file
  Editors where "Editors can change permissions and share" is on (Viewer/Editor, removing direct entries, General
  access with a step-up for "Anyone in Trina"; never a widening, never an invitation); anyone may `leave` their own
  share. The actor must see the file through their own view (else the same 404 as a missing path) — admins too.
  Managers, restrict-here and "No AI" are folder settings (400 `not_for_files`); a file cannot be narrower than its
  folder (400 `inherited_general`); at most 200 grants per file. Agents never share (Bearer → 401).
- **Lifecycle.** Rename, move within team folders, new version, restore version and trash → restore keep the share;
  copy makes a new file with none; moving a file or folder into a personal folder removes its shares (audited
  `unshared: n`; moving it back out does not share it again); purge, trash expiry and rescan delete the rows and their
  grants together (`dropRow`, no foreign key, so a delete never fails on grants — also for an older image). A trashed
  file is gone for its grantees (its location is inert) until restored. A file changed by hand on the server disk loses
  its shares (fail closed). Group grants keep the group's `uid`: a group deleted and another made with the same id gets
  nothing.
- **Rolling back** to an image without file sharing: the new tables and columns are ignored; people lose files shared
  with them only until the new image is back. Files moved by the older image are found again by the boot relocate
  (closed until then). Drafts made from shared files are sealed on the older image (fail closed).
- **R6 for a shared file:** its readers are the folder's plus its grantees: promote overwrite of a shared file counts
  them (W1); sharing a file that is an AI-draft copy with people who cannot read its sources is a widening (409;
  managers and admins confirm, Editors cannot).
- **Known exposure:** the names of the folders above a shared file (the dialog says "People you add will see the folder
  names …"), also after a move (the move response says `shared_with: n`). A draft from one shared file stays visible to
  the agent while any other file in that folder is still shared with its person (over-retention, bounded to one folder).

### Mounting (WebDAV) and Google Drive import

- **A mounted drive is a person, not an agent.** `/dav/` signs in with an app password (one per computer, shown once,
  sha256 kept, revocable, revoked on a password reset, useless for an inactive person) over HTTPS only; agent tokens are
  never accepted there, and app passwords are never accepted on `/mcp` or `/api`. It sees what `Access.forPerson`
  allows, only managed folders (in-place NAS folders are hidden on the mount), hidden == missing, and writes through
  the same `Managed` path (write rule, quota, versions, trash, audit with tool `webdav`). An app password skips the
  second factor (like any app password); making one needs the password typed within 5 minutes.
  **A mount is not an AI connection (review finding 16):** "No AI" closes AI connections only, and a mounted drive is
  the person, so an AI tool running on a computer with the drive mounted (Claude Code, Codex, …) reads and changes
  what that person can, No AI folders included, originals included (not drafts). Connect AI through MCP for the
  AI rules; mount only on computers where that is acceptable.
- **Google Drive** (`drive.file`): Trina sees only the files a person picks. Refresh and access tokens are sealed with
  the install's data key (`TDRIVE_SECRET_KEY` or `<data>/keys/data.key`, 0600; not in backups), bound to the person.
  The OAuth round trip is bound to the browser that started it (state once + a SameSite=Lax cookie + PKCE). Imported
  files land only where the person may write and are then team files under Trina's rules (Drive's sharing is not
  copied). Disconnect revokes the grant at Google.

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

**Connections.** Each authenticated MCP message records token × client: `clientInfo` name/version from `initialize` (2025-11-25) or from each request's `_meta` (2026-07-28),
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

- WebDAV: locks live in memory (a restart drops them; clients lock again); dead properties (PROPPATCH) are answered but
  not kept; a `MOVE` of a file over a file leaves the source in the trash; Windows' WebClient limits files to 50 MB by
  default; timing of hidden vs missing paths is not equalised (as elsewhere). Google Drive import: one-shot (no change
  polling yet), jobs in memory, `drive.readonly` folder mode only for design partners; a restored backup without the
  data key needs people to connect Google Drive again.

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
