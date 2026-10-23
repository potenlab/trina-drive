// When people last used this server: the newest of the signals the server already keeps — a web session seen
// (web_sessions.last_seen_at, refreshed at most once a minute on any signed-in request), an access token used (MCP,
// personal or OAuth: tokens.last_used_at) and an app password used (WebDAV: app_passwords.last_used_at). Nothing new is
// written per request. Trina Cloud reads it through `tdrive activity --json` (docker exec on the host, never over the
// network) to pause Free workspaces nobody has used for a week.
import type { DB } from './db'

export interface Activity {
  /** newest of the three, ms since the epoch; null = never */
  last_activity_at: number | null
  web: number | null
  mcp: number | null
  dav: number | null
}

/** max(column) of a table that may not exist yet (the web and WebDAV tables are made when those parts first run) */
function newest(db: DB, sql: string): number | null {
  try { return db.query<{ at: number | null }, []>(sql).get()?.at ?? null } catch { return null }
}

export function lastActivity(db: DB): Activity {
  const web = newest(db, 'SELECT max(last_seen_at) AS at FROM web_sessions')
  const mcp = newest(db, 'SELECT max(last_used_at) AS at FROM tokens')
  const dav = newest(db, 'SELECT max(last_used_at) AS at FROM app_passwords')
  const all = [web, mcp, dav].filter((x): x is number => x != null)
  return { last_activity_at: all.length ? Math.max(...all) : null, web, mcp, dav }
}
