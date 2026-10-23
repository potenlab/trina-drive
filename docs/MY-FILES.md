# My files (Trina Cloud mode)

Each active member of a Trina Cloud team has a private folder called **My files**. Code: `src/tdcloud/my-files.ts`
(workstream B2). Tests: `test/my-files.test.ts` (S50, drive side). A self-hosted install (no `TDRIVE_CLOUD_*`) has none of
this. Nothing changes there: no folder is made, `me` has no `myFilesPath`, and `cloud my-files` answers `not_cloud`.

## What it is

- **A managed personal folder.** It is a top folder in managed storage named `<handle> (personal)`, for example
  `/mina (personal)`. The person is its `personal_owner`. If that name is taken, it becomes `… (personal) 2`, `… 3`, and so on.
  The app calls it "My files". Admins see the real name in the folder list.
- **Owner only (R0).** Nobody else reads it. That includes admins: they see that the folder exists in the admin folder
  list, but they cannot open its files.
  - It has no rules, managers or General access.
  - The share API refuses it. For the folder, `POST /api/share` returns 403; A1's error code there is currently
    `editors_cannot_share`. For files, A2 returns 409 `personal`.
  - `GET /api/files/who` returns `can_share: false` and `personal_owner: <handle>`.
  - v1 has **no sharing out** of My files (A2 memo §4/§14; O6 = v1.1). To share something, move it to a team folder.
- **Team quota.** Its files, versions and trash count toward the team's storage like any team folder. A full team refuses
  uploads into My files too (507 `quota_exceeded`).
- **The person's AI.** Their agents read it like any folder of theirs:
  - An unscoped token sees it.
  - A token scoped to other folders does not.
  - Turning on "No AI" for the folder closes it to agents. The owner can turn it on and off.
  - Other people's agents never see it.
  - AI drafts are never promoted into a personal folder (as before).

## When it is made

`reconcileMyFiles()` is idempotent. It runs after each member sync (applied or stale), after each SSO sign-in, and from
the backfill CLI. For each **active console member** (`people.active = 1` and `accounts.cloud_user` set), it keeps the
first of these that applies:

1. Their tracked My files.
2. Otherwise, a managed personal folder an admin already made for them. It is **adopted**, so they never get two.
3. Otherwise, their old folder, if it is still somewhere in Former members. It is **restored** (see below).
4. Otherwise, a **new** empty folder.

Open invites (`status: invited`) get nothing until they accept.

A sign-in never fails because of My files. Neither does a sync, and the sync's JSON output is unchanged. Errors are logged
and repaired on the next run.

The table `cloud_my_files(folder_id, person_id, mount_name, state, created_at, former_at, former_name)` tracks each
folder by its `folders` row, whose id stays the same through moves. `state` is one of these values:

| `state` | Meaning |
|---|---|
| `mine` | The person's My files now. A unique index allows only one per person, even when the server and the sync CLI race. |
| `former` | In Former members. |
| `gone` | An admin released it, by unregistering it or giving it another owner (R9). The person gets a new one next time. |

## When the person leaves: Former members

Leaving means the member sync deactivates the person: removed in the console, or the invite withdrawn. Their My files is
**kept and handed to the admins**, much as Google Drive transfers a deleted user's files:

- The folder moves to **`/Former members/<handle>`**. If that name is taken inside Former members, it becomes
  `<handle> 2`, and so on.
  - Former members is a managed team folder, made the first time it is needed (as `Former members 2` if that name is taken).
  - Its id is kept in `meta.cloud_former_members_folder`.
- The move is a rename on disk. Files keep their identities, versions, history and trash entries. The `folders` row
  becomes an ordinary (unregistered) folder inside Former members.
- Audit row: `my files of <handle> (left the team): /<old> moved to /Former members/<handle>`. Folder history records the
  owner change.
- **Who reads Former members:**
  - Every active admin is an **Editor**: they can read, move files out, and delete.
  - The rule is kept in step with the console's admins. A new admin gets it. Someone who stops being an admin loses the
    rule this module gave them. Rules an admin added by hand are left alone.
  - Members see nothing.
  - **"No AI" is on** for Former members, so no agent, the admins' included, reads a former member's files unless an admin
    turns it off (R9 tells the managers).
  - "Editors can share" is off.
- **AI-draft copies (R6).** The move runs in the same transaction as the R6 re-check (mode `rules`). Take a promoted
  copy that the person had moved into their My files: if the admins cannot read that copy's sources, it **closes**
  (pending) until a source manager confirms. Source managers are told afterwards. The admin-rule changes run the same
  re-check.

### Coming back (re-invite)

If a person who left becomes active again (through the sync, or a newer SSO assertion), their last folder moves back as
their My files, under its old name if that is free. This happens only if the folder is still at or below Former members
and is still the same folder on disk.

- It comes back with whatever the admins left in it.
- Any rules or manage grants an admin put on it are cleared, because a personal folder has none.
- The person gets a notice: `personal_folder_changed`, link `/#/my`. As R11 requires, it carries the kind and link only.

If the admins moved the folder out of Former members, for example to an archive team folder, or deleted it, the person
gets a **new, empty** My files. Their old files stay where the admins put them.

### Renames

The folder is tracked by person id, never by name.

- A new display name or email from the console keeps the same folder and the same path.
- So does a changed handle (`people.name`). The folder keeps its name. `me.myFilesPath` follows the folder.
- If someone leaves after a handle change, their folder in Former members gets the handle they had at that time.

## API (for C2)

`GET /api/session` returns `me.myFilesPath`:

```jsonc
{ "me": { "...": "...", "myFilesPath": "/mina (personal)" } }   // or null, before the first sync or sign-in made it
```

- The key is present only in cloud mode. On a self-hosted install it is **absent**, so do not show "My files" there.
- It is the folder's virtual path. Use it as is with the files API, for example
  `GET /api/files?path=/mina%20(personal)` and `POST /api/files/upload?path=…`. Show it as "My files" at `#/my`.
- Leave its own entry out of the regular folder list. It is a top folder like the team folders.
- Do not show Share in it. Inside My files, show "Move it to a team folder to share" instead; tell it apart by the path
  prefix or by `GET /api/files/who` → `personal_owner`. Do not rely on the error code: `POST /api/share` answers 403
  (`editors_cannot_share` today), and A2's file branch answers 409 `personal`.
- Admins see a regular team folder named `Former members`, as long as at least one person has left.

## Operating

```sh
trina-drive cloud my-files --dry-run   # {"ok":true,"dry_run":true,"without_my_files":[…],"to_former_members":[…]}
trina-drive cloud my-files             # {"ok":true,"created":N,"adopted":N,"restored":N,"transferred":N,"failed":[]}
```

Run `cloud my-files` once after upgrading a team that existed before My files. The next member sync does the same.
Running it again does nothing. Exit code 1 means some person failed; the reasons are listed in `failed`.

## Rollback

Everything here is additive: one table and two `meta` keys. An older image ignores them.

- My files folders stay ordinary personal managed folders, which older images already understand.
- Former members stays an ordinary team folder with person rules.

Nothing needs undoing.
