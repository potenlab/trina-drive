// Tables and columns Trina Cloud mode adds to the product database (workstream B1), run by src/migrations.ts. All
// additive and idempotent: a self-hosted install gets empty columns and tables it never reads; an older image keeps
// working on a database this one touched (it ignores them).
import { addColumns, type Migration } from '../migrations'

export const cloudMigrations: Migration[] = [
  // the console's name for a person (display only; people.name stays the unique handle used in rules and sign-in)
  { id: 'tdcloud.people_display_name', phase: 'core', up: (db) => addColumns(db, 'people', [['display_name', 'TEXT']]) },
  {
    id: 'tdcloud.accounts', phase: 'web', up: (db) => {
      // cloud_user: the console's users.public_id (assertion sub); cloud_invite: an open console invite (row made before
      // sign-up so it can be shared with); password_ok_until: `people reset-link --break-glass` lets this person use a
      // password while TDRIVE_SSO_ONLY is on (the console is down)
      addColumns(db, 'accounts', [['cloud_user', 'TEXT'], ['cloud_invite', 'TEXT'], ['password_ok_until', 'INTEGER']])
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS accounts_cloud_user ON accounts (cloud_user) WHERE cloud_user IS NOT NULL;
        CREATE INDEX IF NOT EXISTS accounts_cloud_invite ON accounts (cloud_invite) WHERE cloud_invite IS NOT NULL;`)
    },
  },
  // a session made by SSO is "fresh" from when the person last typed their console password (auth_time), not from
  // when the session was made (src/web/auth.ts freshLogin)
  { id: 'tdcloud.web_sessions_auth_at', phase: 'web', up: (db) => addColumns(db, 'web_sessions', [['auth_at', 'INTEGER']]) },
  {
    id: 'tdcloud.sso_tables', phase: 'web', up: (db) => db.exec(`
      -- assertion ids already used (single use); pruned after exp + 60 s
      CREATE TABLE IF NOT EXISTS sso_used (jti TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
      -- GET /api/sso/start: sha256 of the state, where to go after, whether this is a re-authentication (10 minutes)
      CREATE TABLE IF NOT EXISTS sso_states (state_hash TEXT PRIMARY KEY, return_to TEXT NOT NULL, reauth INTEGER NOT NULL, created_at INTEGER NOT NULL);
      -- a valid assertion of someone with a second factor on the drive: the sign-in ticket's hash → the rest of the sign-in
      CREATE TABLE IF NOT EXISTS sso_tickets (ticket_hash TEXT PRIMARY KEY, return_to TEXT NOT NULL, fresh_at INTEGER, auth_at INTEGER, created_at INTEGER NOT NULL);
      -- member-sync events already applied (idempotent by id), kept 30 days
      CREATE TABLE IF NOT EXISTS cloud_sync_events (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);`),
  },
]
