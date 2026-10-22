import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db'
import { seedDemo } from '../src/demo'
import { makeCtx, Session } from '../src/session'
import { runShell } from '../src/shell'
import { createToken, verifyToken, type TokenRow } from '../src/store'
import { callTool } from '../src/tools'

export type Who = 'kim' | 'boss' | 'bossNarrow' | string

/** A fresh data dir with the demo company seeded. */
export function setup() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-test-')))
  const db = openDb(dir)
  const { root, tokens } = seedDemo(db, dir)
  const ctx = makeCtx(db, dir)
  const secrets: Record<string, string> = { kim: tokens.kim.token, boss: tokens.boss.token, bossNarrow: tokens.bossNarrow.token }
  const tok = (who: Who): TokenRow => {
    const t = verifyToken(db, secrets[who]!)
    if (!t) throw new Error(`no live token for ${who}`)
    return t
  }
  const addToken = (who: Who, person: string, opts: Parameters<typeof createToken>[2] = {}) => { secrets[who] = createToken(db, person, opts).token }
  const sh = async (who: Who, cmd: string, readdir?: (p: string) => string[]) => {
    const s = new Session(ctx, tok(who), readdir)
    const r = await runShell(s, cmd)
    s.commit('bash', cmd, `exit ${r.exitCode}`)
    return r
  }
  const tool = (who: Who, name: string, args: Record<string, unknown>) => callTool(ctx, tok(who), name, args)
  const folderId = (rel: string) => db.query<{ id: number }, [string]>('SELECT id FROM folders WHERE path = ?').get(path.join(root, rel))!.id
  const draftSrc = (who: Who, rel: string) => new Map(db.query<{ folder_id: number; strong: number }, [number, string]>(
    'SELECT s.folder_id, s.strong FROM draft_src s JOIN drafts d ON d.id = s.draft_id WHERE d.token_id = ? AND d.path = ? AND d.deleted_at IS NULL')
    .all(tok(who).id, rel).map((r) => [r.folder_id, !!r.strong]))
  const cleanup = () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }) }
  return { dir, db, ctx, root, secrets, tok, addToken, sh, tool, folderId, draftSrc, cleanup }
}
export type Env = ReturnType<typeof setup>
export const textOf = (r: { content: { text: string }[] }) => r.content.map((c) => c.text).join('\n')
