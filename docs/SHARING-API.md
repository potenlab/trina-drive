# Sharing API (share dialog, Shared with me, directory)

Folder sharing for managed storage (Trina Cloud v1). Types for the web app: `src/share/api-types.ts` (import it; it
has no server dependency, and `shareClient(call)` wraps the calls below). Security rules: [SECURITY-MODEL.md](SECURITY-MODEL.md#sharing-trina-cloud-v1-the-share-dialog-owner-decision-o1).

All routes need a signed-in web session (cookie + `X-CSRF-Token` on changes, like every `/api` route). Bearer tokens are
never read here: agents cannot share. Errors are `{ error, message }`. **Hidden == nonexistent**: a path the caller
cannot see answers `404 { error: 'not_found' }`, byte for byte like a path that does not exist — on GET and POST.

Roles: **Viewer** (rule read), **Editor** (write), **Manager** (write + manage). Paths are the virtual paths the files
view uses (`/Projects/비밀`). A path that is a **file** you can see is file-level sharing: see [Files](#files) below.

## `GET /api/share?path=…`

```jsonc
{ "mode": "managed",                 // NAS (in place) folders: { "mode": "inplace", "item": … } → use the folder page
  "item": { "path": "/Projects/비밀", "kind": "folder", "name": "비밀", "id": 12 },
  "my_role": "editor",               // viewer | editor | manager | 'admin' (admin without a role) | null (bare path)
  "can_share": true,                 // show the controls at all
  "can_manage": false,               // manager or admin
  "can_grant_manager": false,        // admin only
  "can_ai_off": false,               // admin only ("No AI" on: anyone who can_share)
  "can_restrict_here": false,        // managers/admins, subfolders only
  "can_toggle_editors": false,       // managers/admins
  "can_invite": false,               // admin, when the team can invite by mail (Trina Cloud)
  "full_list": true,                 // false: the caller sees this folder only as a path → entries = their own only
  "general": { "effective": { "role": "viewer", "from_path": "/Projects" }, "own": null,
               "restricted_here": false, "editor_step_up": true },   // Editors need a step-up to open wider to the team
  "editors_can_share": { "effective": true, "own": null, "off_above": false },
  "entries": [ { "subject": { "type": "person", "id": 3, "name": "boss" }, "role": "manager", "source": "inherited",
                 "from_path": "/Projects", "editable": false },
               { "subject": { "type": "group", "id": 6, "name": "재무", "members": 2 }, "role": "editor", "source": "direct", "editable": true },
               { "subject": { "type": "person", "id": 4, "name": "lee" }, "role": "manager", "note": "cannot_open", … } ],
  "ai": { "no_ai": false },          // inherited_no_ai_from: "/…" when it comes from above
  "path_names_visible": true,        // say: "people you add see the folder names on the path to it"
  "warnings": [ { "code": "draft_copies", "count": 1 }, { "code": "editors_off_above" }, { "code": "manager_cannot_open", "count": 1 } ] }
```

The Everyone group is never an entry: it is `general` ("Anyone in Trina"). `email` appears on person subjects for the
admin only. "Restrict access here" preview: the entries with `source: "inherited"` and role ≠ manager lose access unless
kept (Keep: people ticked, Anyone in Trina unticked by default); managers above always stay.

## `POST /api/share`

```jsonc
{ "path": "/Projects/비밀",
  "add":  [ { "subject": { "type": "person", "id": 7 }, "role": "viewer" },
            { "subject": { "email": "new@x.com" }, "role": "editor" } ],   // non-member: admin only (invite flow)
  "set":  [ { "subject": { "type": "group", "id": 6 }, "role": "remove" } ],
  "general": { "mode": "team", "role": "viewer" },        // or { "mode": "restricted" }
  "restrict_here": { "on": true, "keep": [ { "type": "person", "id": 2 } ] },
  "ai_access": false,                // false = "No AI" on; true = off (admin)
  "editors_can_share": false,        // managers/admins
  "notify": true,                    // default true: new readers get "Items were shared with you" (no names)
  "confirm_widening": true,          // after a 409 widening (see below)
  "step_up": "…" }                   // Editor opening the folder wider to the team (see step-up)
```

All parts apply in one transaction (with the audit row and the R6 re-check) or none do.

| Answer | When |
|---|---|
| `200` the GET shape + `{ widens, invited: [{ email, status, granted }] }` | done |
| `202 { status: 'approval_pending', approval_id, widens }` | an Editor's widening change sent with `confirm_widening`: it waits in the approval inbox for a manager of the sources (or the admin). `status: 'closed'` = nobody can approve it |
| `409 { error: 'widening', count, people, sources, sources_hidden, can_confirm, needs_approval }` | AI-draft copies here would reach people who cannot read their sources. `sources` = paths the caller can read, `sources_hidden` = how many they cannot ("N folders you cannot see"). Managers/admins: send again with `confirm_widening` (the copies close until a source manager confirms, or are confirmed at once if the caller manages the sources). Editors: `confirm_widening` asks for approval (202) |
| `403 not_manager` | visible, but the caller cannot share here |
| `403 editors_cannot_share` | the caller is an Editor and the toggle is off here or above |
| `403 manager_only` / `admin_only` / `invite_admin_only` | that part needs a manager / an admin |
| `403 step_up_required` | an Editor opening wider to the team without a valid step-up assertion for this folder and this `general` |
| `400 inherited` / `inherited_general` / `inherited_no_ai` | it comes from a folder above: change it there (or restrict access here) |
| `400 group_manager`, `top_folder`, `inplace`, `bad_*`, `duplicate`, `invite_role` | the request cannot be done here |
| `409 invites_unavailable` / `skill_library` | no invite flow on this server / a skill library keeps "Editors can share" off |

The approval of a share request uses the existing inbox: `GET /api/approvals` items have `kind: 'share'`;
`GET /api/approvals/:id` gives `{ kind: 'share', change, sources, hidden_sources, gainers: { count } }`; step-up and
approve/reject are the same calls as for promote requests (`sha256` = the request's `sha256` field).

## Step-up (Editor → Anyone in Trina)

1. `POST /api/share/step-up/options { path, general }` → `{ method: 'passkey', options }` or `{ method: 'totp' }`;
   `409 passkey_required | totp_required` when the person has no factor (send them to Settings).
2. `POST /api/share/step-up { path, general, response }` (passkey assertion) or `{ …, code }` (TOTP) →
   `{ assertion, expires_at }` (2 minutes, single use, bound to this session, folder and `general`). Rate limited.
3. `POST /api/share { path, general, step_up: assertion }`.

## `GET /api/shared-with-me`

`{ items: [{ path, kind: 'folder', name, role, shared_by: { id, name } | null, shared_at | null }] }` — folders given to
the caller or one of their groups (not Anyone in Trina), that they can open now, newest first. Judged again on every
request (a revoked share is gone at once).

Files shared with the caller are merged into the same list (see [Files](#files)):
`{ kind: 'file', path, name, role: 'viewer' | 'editor', shared_by, shared_at, size, mtime }`.

## `GET /api/directory`

`{ people: [{ id, name, display_name?, email? }], groups: [{ id, name, size, everyone? }] }` — for the picker. Names for
every member; `email` for the admin only. The Everyone group is named "Anyone in Trina" and flagged `everyone: true`.

## `me.share`

`GET /api/session` → `me.share = { api: 1, can_invite }`.

## Hooks for other workstreams

- **Inviting non-members**: in Trina Cloud mode the share API (admin only) asks the console to invite the address
  (`src/tdcloud/invite.ts`, member role); the person arrives with the next member sync, so `invited[].granted` is
  `false` and the share is given once they are a member. Another flow can be plugged in with `setInviteHandler(…)` in
  `src/share/invite.ts` (returning `personId` grants at once). Self-hosted installs answer `409 invites_unavailable`.
- **R6 re-check** (any change of readers): wrap the change in `withRejudge(db, () => { …change… }, { mode:
  'membership' })` (`src/share/rejudge.ts`) — one transaction with the re-check. The People page, the member sync
  (`cloud sync-members`: members, invites as rows, removals, Everyone) and the SSO sign-in (JIT person, reactivation,
  Everyone) all do. After the commit, `notifyWidened(emit, j)` (notify bus) or `tellWidened(ctx, j)` (inbox + mail)
  tells the source managers.
- **Everyone in cloud mode** is a system group: kept by the member sync (`syncEveryone`), never deleted or edited on
  the People page (`409 managed_by_console`).

## Files

File-level sharing in managed storage (workstream A2; rules in [SECURITY-MODEL.md](SECURITY-MODEL.md#file-shares-managed-storage-trina-cloud-v1-workstream-a2)).
The same routes take a file's path; types: `FileShareView`, `FileShareChange`, `FileSharedItem`, `RecentItem` in
`src/share/api-types.ts`. A file you cannot see answers exactly like one that does not exist (404), on GET and POST.

### `GET /api/share?path=<file>`

```jsonc
{ "mode": "managed",                       // "inplace": NAS files are not shared one by one;
                                            // "personal": { mode, item, my_role, can_manage: false } → "Move it to a team folder to share"
  "item": { "path": "/경영/결산/2026-Q3.xlsx", "kind": "file", "name": "2026-Q3.xlsx" },
  "my_role": "editor",                      // viewer | editor | manager | admin | null
  "can_manage": true,                       // false (Viewers, Editors with the toggle off): entries [] and general null
  "manage_as": "admin" | "manager" | "editor",
  "can_grant_manager": false, "can_ai_off": false,
  "can_invite": false,                      // admin only (S16: non-members by mail)
  "can_confirm_widening": false,            // managers and admins
  "editors_can_share": { "effective": true, "from_path": null },     // from_path: where it was turned off
  "general": { "effective": { "role": "viewer", "from_path": "/경영" } | null,   // the file's own path when set here
               "own": "viewer" | null,
               "can_restrict": false,       // false: General access comes from the folder (a file cannot be narrower)
               "editor_step_up": true },    // Editors need the step-up to open the file to the whole team
  "entries": [
    { "subject": { "type": "person", "id": 12, "name": "mina", "email": null }, "role": "viewer", "source": "direct",
      "granted_by": { "id": 3, "name": "dion" }, "granted_at": 1761234567000, "editable": true },
    { "subject": { "type": "group", "id": 4, "name": "finance", "members": 5 }, "role": "editor", "source": "inherited",
      "from_path": "/경영/결산", "editable": false } ],
  "inherited": "shown" | "hidden",          // hidden: the caller reads only this file (a file-only Editor): direct entries only
  "ai": { "no_ai": false, "inherited_no_ai_from": null },            // a file follows its folder's "No AI"
  "path_names_visible": "/경영/결산",        // say: "People you add will see the folder names /경영/결산"
  "warnings": [ { "code": "draft_copy" } ] } // this file is a copy of an AI draft
```

`email` is filled for the admin only. A direct entry whose subject also has a role from the folder carries
`inherited_role`.

### `POST /api/share` with a file path

```jsonc
{ "path": "/경영/결산/2026-Q3.xlsx",
  "add":  [ { "subject": { "type": "person", "id": 12 } | { "type": "group", "id": 4 } | { "email": "x@y" }, "role": "viewer" | "editor" } ],
  "set":  [ { "subject": { "type": "person", "id": 12 }, "role": "viewer" | "editor" | "remove" } ],
  "general": { "mode": "restricted" } | { "mode": "team", "role": "viewer" | "editor" },
  "leave": true,                            // remove my own share on this file (anyone who sees it)
  "notify": true, "confirm_widening": false, "step_up": "<assertion>" }
```

| Answer | When |
|---|---|
| `200` the GET shape + `{ widens, invited: [{ email, status, granted }] }` | done (one transaction, one audit row per change: `share <path> (file) person:12 none→viewer by editor widens:0`) |
| `409 { code: 'widening', count, people, sources, sources_hidden, can_confirm, needs_approval }` | the file is a copy of an AI draft and new readers cannot read its sources; managers/admins send `confirm_widening` |
| `409 inplace` / `personal` | NAS file / a file in a personal folder ("Move it to a team folder to share") |
| `403 not_manager` / `editors_cannot_share` / `invite_admin_only` / `step_up_required` / `editors_cannot_confirm` | as for folders; an Editor's `confirm_widening` is refused |
| `400 not_for_files` | `role: 'manager'`, `restrict_here`, `ai_access`, `editors_can_share` (folder settings) |
| `400 inherited` / `inherited_general` | lower than the folder gives / Restricted while General access comes from the folder |
| `400 too_many` | more than 200 people and groups on one file |
| `400 nothing_to_leave` / `bad_subject` / `not_a_member` / `duplicate` | — |

Step-up for a file: the same two calls as for folders (`POST /api/share/step-up/options` and `/step-up` with the
file's `path` and `general`); the assertion is bound to that file.

Non-members by mail (admin only) go through the invite flow; when the flow hands back the invited person's row the file
is shared with them at once (`granted: true`), otherwise `granted: false` — applying pending file invites when the person
joins (S16) is **not in this version** (cut, memo §12).

### Other routes

- `GET /api/shared-with-me` lists files given to the caller or one of their groups (not Anyone in Trina) that they can
  open now, newest first, next to folders (`kind: 'file'`, with `size` and `mtime`).
- `GET /api/recent?limit=50` (max 100) → `{ items: [{ path, name, kind: 'file', at, action: 'opened' | 'edited', size,
  mtime }], partial }`: the caller's own opens (download, text, versions) and changes (upload, new version, restore,
  copy, WebDAV PUT) on the web and the mounted drive, newest first, each path judged again now (a file renamed, moved
  or no longer visible drops out). Agent reads are not listed.
- `GET /api/files/versions?path=` adds `writable` (true for a file Editor: show "Upload new version") and
  `history: 'all' | 'editors_only'` (a file-only Viewer gets the current version only; older version downloads 404).
- `POST /api/files/move` results add `shared_with: n` (grants on what moved: its grantees now see the new folder
  names) and `unshared: n` (moved into a personal folder: those shares were removed).
- File Editors upload a new version with `POST /api/files/upload?path=<folder>&conflict=replace`, `POST /api/uploads`
  `{ …, conflict: 'replace' }`, or WebDAV `PUT` on the file; restore with `POST /api/files/versions/restore`. Anything
  else in the folder answers 403.
