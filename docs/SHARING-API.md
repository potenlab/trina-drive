# Sharing API (share dialog, Shared with me, directory)

Folder sharing for managed storage (Trina Cloud v1). Types for the web app: `src/share/api-types.ts` (import it; it
has no server dependency, and `shareClient(call)` wraps the calls below). Security rules: [SECURITY-MODEL.md](SECURITY-MODEL.md#sharing-trina-cloud-v1-the-share-dialog-owner-decision-o1).

All routes need a signed-in web session (cookie + `X-CSRF-Token` on changes, like every `/api` route). Bearer tokens are
never read here: agents cannot share. Errors are `{ error, message }`. **Hidden == nonexistent**: a path the caller
cannot see answers `404 { error: 'not_found' }`, byte for byte like a path that does not exist — on GET and POST.

Roles: **Viewer** (rule read), **Editor** (write), **Manager** (write + manage). Paths are the virtual paths the files
view uses (`/Projects/비밀`). Folders only in this version (a visible file → `400 folders_only`).

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

## `GET /api/directory`

`{ people: [{ id, name, display_name?, email? }], groups: [{ id, name, size, everyone? }] }` — for the picker. Names for
every member; `email` for the admin only. The Everyone group is named "Anyone in Trina" and flagged `everyone: true`.

## `me.share`

`GET /api/session` → `me.share = { api: 1, can_invite }`.

## Hooks for other workstreams

- **Inviting non-members** (B1/D1): `setInviteHandler(async (w, { email, role: 'member', by }) => ({ status, personId? }))`
  in `src/share/invite.ts`. The share API calls it (admin only) after its change committed; when it returns the invited
  person's id the share is given to them at once.
- **R6 re-check** (B1's member sync, any other change of readers): wrap the change in
  `withRejudge(db, () => { …change… }, { mode: 'membership' })` (`src/share/rejudge.ts`) — one transaction with the
  re-check; `notifyWidened(emit, judgement)` after the commit tells the source managers.
- **Everyone in cloud mode**: `fillEveryone(db)` (`src/share/schema.ts`) runs at start when `TDRIVE_CLOUD_TEAM` is set.
