// CLI for the server operator: the promote switch per folder, who has a second factor, and resetting the factors of
// someone who lost them all (passkeys, authenticator app and recovery codes). Audited; the person's sessions end.
import { appendAudit } from '../audit'
import type { DB } from '../db'
import { promoteFolderIds, setPromote } from '../promote'
import { folderAt, person, StoreError } from '../store'
import { revokeSessionsOf } from './auth'
import { adminsWithout2FA, ensureMfaSchema, has2FA, passkeyConfig, passkeysOf, recoveryRemaining, totpEnabled } from './mfa'

export const MFA_HELP = `  folder promote <path> [--off]          let drafts be promoted into this folder and below (new files only; admin)
  mfa status                             who has a second factor (passkey, authenticator app), recovery codes left
  mfa reset <person>                     remove all of a person's second factors (they lost them); ends their sessions`

export function mfaCommand(db: DB, cmd: string, rest: string[]): boolean {
  switch (cmd) {
    case 'folder promote': {
      const off = rest.includes('--off')
      const dir = rest.find((a) => a !== '--off')
      if (!dir) throw new StoreError('path required')
      const f = folderAt(db, dir)
      if (f.personal_owner != null) throw new StoreError('drafts are not promoted into personal folders')
      setPromote(db, f.id, !off, null)
      appendAudit(db, { personId: null, tokenId: null, tool: 'cli', command: `folder ${f.path} promote=${off ? 0 : 1}`, files: [], outcome: 'ok' })
      console.log(`promote ${off ? 'off' : 'on'} for ${f.path} (folders with promote: ${promoteFolderIds(db).size})`)
      return true
    }
    case 'mfa status': {
      ensureMfaSchema(db)
      for (const p of db.query<{ id: number; name: string; admin: number }, []>('SELECT id, name, admin FROM people WHERE active = 1 ORDER BY name').all()) {
        console.log(`${p.name}${p.admin ? ' (admin)' : ''}\tpasskeys ${passkeysOf(db, p.id).length}\tauthenticator ${totpEnabled(db, p.id) ? 'yes' : 'no'}\trecovery codes ${recoveryRemaining(db, p.id)}\t${has2FA(db, p.id) ? 'ok' : 'NO SECOND FACTOR'}`)
      }
      return true
    }
    case 'mfa reset': {
      ensureMfaSchema(db)
      const p = person(db, rest[0] ?? '')
      db.transaction(() => {
        db.query('DELETE FROM mfa_passkeys WHERE person_id = ?').run(p.id)
        db.query('DELETE FROM mfa_totp WHERE person_id = ?').run(p.id)
        db.query('DELETE FROM mfa_recovery WHERE person_id = ?').run(p.id)
        revokeSessionsOf(db, p.id)
        appendAudit(db, { personId: p.id, tokenId: null, tool: 'cli', command: `mfa reset ${p.name}: all second factors removed, sessions ended`, files: [], outcome: 'ok' })
      })()
      console.log(`removed every second factor of ${p.name} and ended their sessions; they set a new one up after signing in`)
      return true
    }
  }
  return false
}

/** At `serve`: say when a public https address is set and some admin has no second factor (plan 5.2). */
export function mfaServeNotice(db: DB, publicUrl: string | undefined) {
  const cfg = passkeyConfig(publicUrl)
  console.log(cfg ? `passkeys: RP ID ${cfg.rpId} (approvals step up with a passkey on ${cfg.origin})` : 'passkeys: unavailable (no public https address); approvals step up with an authenticator app')
  const missing = adminsWithout2FA(db).length
  if (missing) console.error(`warning: ${missing} admin${missing === 1 ? '' : 's'} without a second factor; a public address needs every admin on one (Settings → Second factor)`)
}
