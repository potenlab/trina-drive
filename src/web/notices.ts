// Notices (R9, R11): kind, count and a link only — never file, folder, draft or person names. Stored for the web
// (shown after sign-in) and mailed to the person's address right away.
import type { DB } from '../db'
import { NAME, PRODUCT } from '../config'
import { ensureWebSchema } from './schema'
import type { Mailer } from './mail'

export type NoticeKind =
  | 'self_grant'            // an admin put themselves in a group, rule, manage or NAS readers (R9)
  | 'no_ai_off'             // "no AI" was turned off on a folder (R9)
  | 'nas_readers_changed'   // NAS readers changed (R5)
  | 'rules_changed'         // AI readers / start-fresh changed by someone else (R7)
  | 'manage_changed'        // manage given or taken
  | 'personal_folder_changed' // personal folder unregistered or owner changed (R9)
  | 'former_personal_registered' // a folder that was personal is now a regular folder (R9)
  | 'password_reset'        // an admin started a password reset: tokens and sessions are cut (R9)
  | 'email_changed'         // the sign-in mail address changed (R9: told at the old address)
  | 'home_registered'       // a folder looking like someone's NAS home was registered (5.1)
  | 'second_factor_changed' // a passkey / authenticator app / recovery codes of yours changed
  | 'admin_added'           // someone became an admin (Trina Cloud sync or sign-in, or the People page): every admin and they hear of it
  | 'break_glass'           // an emergency sign-in link was made on the server (`people reset-link`): every admin and the person
  | 'shared'                // something was shared with you (src/share; O7: no file or folder names, ever)
  | 'widened'               // AI-draft copies were closed because a change let more people read them (R6, src/share/rejudge.ts)
  | 'former_member_files'   // My files of people who left moved to Former members (src/tdcloud/my-files.ts): every active admin

const SUBJECT: Record<NoticeKind, string> = {
  self_grant: 'An admin gave themselves access',
  no_ai_off: '"No AI" was turned off on a folder',
  nas_readers_changed: 'NAS readers changed on a folder',
  rules_changed: 'AI readers changed on a folder you manage',
  manage_changed: 'Folder management changed',
  personal_folder_changed: 'Your personal folder changed',
  former_personal_registered: 'A former personal folder was registered as a regular folder',
  password_reset: 'Your password is being reset; your tokens and sessions were cut',
  email_changed: 'Your sign-in address was changed',
  home_registered: 'A folder that may be your NAS home was registered',
  second_factor_changed: 'Your second factor (passkey, authenticator app or recovery codes) changed',
  admin_added: 'Someone became an admin of your team',
  break_glass: 'An emergency sign-in link was made for someone in your team',
  shared: 'Items were shared with you',
  widened: 'AI-draft copies need your review (a change let more people read them)',
  former_member_files: 'Files of a former member moved to Former members',
}

export interface NoticeCtx { db: DB; mailer: Mailer; baseUrl: string }

/** One notice to each person (deduplicated). `to` overrides the mail address (e.g. the old one on an address change). */
export async function notify(n: NoticeCtx, personIds: Iterable<number>, kind: NoticeKind, link: string, opts: { count?: number; to?: string; mail?: boolean } = {}) {
  ensureWebSchema(n.db)
  const count = opts.count ?? 1
  const url = n.baseUrl.replace(/\/$/, '') + link
  for (const id of new Set(personIds)) {
    n.db.query('INSERT INTO notices (person_id, kind, count, link, created_at) VALUES (?, ?, ?, ?, ?)').run(id, kind, count, link, Date.now())
    const to = opts.to ?? n.db.query<{ email: string }, [number]>('SELECT email FROM accounts WHERE person_id = ?').get(id)?.email
    if (!to || opts.mail === false) continue
    await n.mailer.send({ to, subject: `[${PRODUCT}] ${SUBJECT[kind]}`, text: `${SUBJECT[kind]} (${count}).\n\nDetails after sign-in: ${url}\n` })
      .catch((e) => console.error(`[${NAME}] mail failed:`, e))
  }
}

export function noticesOf(db: DB, personId: number, limit = 100) {
  ensureWebSchema(db)
  return db.query<{ id: number; kind: NoticeKind; count: number; link: string; created_at: number; read_at: number | null }, [number, number]>(
    'SELECT id, kind, count, link, created_at, read_at FROM notices WHERE person_id = ? ORDER BY id DESC LIMIT ?').all(personId, limit)
}
export function markNoticesRead(db: DB, personId: number) {
  db.query('UPDATE notices SET read_at = ? WHERE person_id = ? AND read_at IS NULL').run(Date.now(), personId)
}
