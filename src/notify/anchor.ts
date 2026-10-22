// External anchor for the audit chain (plan principle 6, 7.1 "audit forgery"). Periodically the chain head (hash of
// the last row), the row count and the time are signed with an Ed25519 key made at first use and kept in the data
// directory, then sent out (admin email, an outside directory). Someone with the server can rewrite history and
// recompute every hash, but cannot change an anchor that already left: the row at that position no longer matches.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { verifyAudit } from '../audit'
import { NAME } from '../config'
import { ANCHOR_LABEL } from './messages'
import type { DB } from '../db'
import type { SignedAnchor } from './events'
import { ensureNotifySchema } from './schema'

const GENESIS = '0'.repeat(64)

export interface AnchorKey { privateKey: crypto.KeyObject; publicKey: crypto.KeyObject; fingerprint: string }

const keyDir = (dataDir: string) => path.join(dataDir, 'anchor')
export const fingerprintOf = (pub: crypto.KeyObject) => crypto.createHash('sha256').update(pub.export({ type: 'spki', format: 'der' })).digest('hex')

/** The install's anchor key; generated (0600) on first use. */
export function anchorKey(dataDir: string, create = true): AnchorKey | null {
  const dir = keyDir(dataDir)
  const priv = path.join(dir, 'ed25519.key'), pub = path.join(dir, 'ed25519.pub')
  if (!fs.existsSync(priv)) {
    if (!create) return null
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const k = crypto.generateKeyPairSync('ed25519')
    fs.writeFileSync(priv, k.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' })
    fs.writeFileSync(pub, k.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o644 })
  }
  const privateKey = crypto.createPrivateKey(fs.readFileSync(priv))
  const publicKey = crypto.createPublicKey(privateKey)
  return { privateKey, publicKey, fingerprint: fingerprintOf(publicKey) }
}

const canonical = (a: SignedAnchor['anchor']) => Buffer.from(JSON.stringify([a.v, a.product, a.at, a.count, a.head, a.key]))

export interface AnchorRow { id: number; at: number; count: number; head: string; key: string; signature: string; file: string | null }

export class AnchorError extends Error {}

/** Sign the current chain head. Refuses when the chain does not verify (anchoring a broken chain would bless it). */
export function makeAnchor(db: DB, dataDir: string, at = Date.now()): SignedAnchor {
  ensureNotifySchema(db)
  const v = verifyAudit(db)
  if (!v.ok) throw new AnchorError(`audit chain broken at row ${v.brokenAt}; not anchoring`)
  const key = anchorKey(dataDir)!
  const anchor: SignedAnchor['anchor'] = { v: 1, product: NAME, at, count: v.rows, head: v.head, key: key.fingerprint }
  const signature = crypto.sign(null, canonical(anchor), key.privateKey).toString('base64')
  const signed: SignedAnchor = { anchor, publicKey: key.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), signature }
  db.query('INSERT INTO audit_anchors (at, count, head, key, signature) VALUES (?, ?, ?, ?, ?)').run(at, anchor.count, anchor.head, anchor.key, signature)
  return signed
}

export const lastAnchor = (db: DB) => { ensureNotifySchema(db); return db.query<AnchorRow, []>('SELECT * FROM audit_anchors ORDER BY id DESC LIMIT 1').get() }
export const listAnchors = (db: DB) => { ensureNotifySchema(db); return db.query<AnchorRow, []>('SELECT * FROM audit_anchors ORDER BY id').all() }

/** Write an anchor to an outside directory as <name>-anchor-<time>-<count>.json. Returns the file path. */
export function writeAnchorFile(db: DB, dir: string, a: SignedAnchor): string {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${NAME}-anchor-${new Date(a.anchor.at).toISOString().replace(/[:.]/g, '-')}-${a.anchor.count}.json`)
  fs.writeFileSync(file, JSON.stringify(a, null, 2) + '\n', { flag: 'wx' })
  db.query('UPDATE audit_anchors SET file = ? WHERE signature = ?').run(file, a.signature)
  return file
}

/** An anchor from a JSON file, or from any text holding the anchor block (an email, also base64 .eml bodies). */
export function parseAnchor(text: string): SignedAnchor {
  try { const j = JSON.parse(text) as SignedAnchor; if (j?.anchor && j.signature) return j } catch {}
  const block = (t: string) => new RegExp(`-----BEGIN ${ANCHOR_LABEL}-----\\s*([\\s\\S]*?)\\s*-----END`).exec(t)?.[1]
  let b = block(text)
  if (!b && /Content-Transfer-Encoding:\s*base64/i.test(text)) {
    const body = text.split(/\r?\n\r?\n/).slice(1).join('\n').replace(/\s+/g, '')
    b = block(Buffer.from(body, 'base64').toString('utf8'))
  }
  if (!b) throw new AnchorError('no audit anchor found in that file')
  return JSON.parse(b) as SignedAnchor
}

export interface AnchorCheck { ok: boolean; problems: string[]; anchor: SignedAnchor['anchor'] }

/**
 * Check the local audit log against an anchor that was sent out earlier: the anchor's own signature, that it was made
 * by this install's key, that the chain verifies, and that row #count still has the anchored hash.
 */
export function verifyAgainst(db: DB, dataDir: string, a: SignedAnchor): AnchorCheck {
  const problems: string[] = []
  let pub: crypto.KeyObject | null = null
  try { pub = crypto.createPublicKey({ key: Buffer.from(a.publicKey, 'base64'), format: 'der', type: 'spki' }) } catch { problems.push('anchor public key unreadable') }
  if (pub) {
    if (!crypto.verify(null, canonical(a.anchor), pub, Buffer.from(a.signature, 'base64'))) problems.push('anchor signature does not verify (the anchor file was altered)')
    if (fingerprintOf(pub) !== a.anchor.key) problems.push('anchor key fingerprint does not match its public key')
  }
  const local = anchorKey(dataDir, false)
  if (!local) problems.push('this install has no anchor key (data directory replaced?)')
  else if (local.fingerprint !== a.anchor.key) problems.push('anchor was signed by a different key than this install has now (key replaced?)')
  const v = verifyAudit(db)
  if (!v.ok) problems.push(`audit chain broken at row ${v.brokenAt}`)
  const total = db.query<{ n: number }, []>('SELECT count(*) AS n FROM audit').get()!.n
  if (total < a.anchor.count) problems.push(`audit log has ${total} rows but the anchor covers ${a.anchor.count} (rows were removed)`)
  else {
    const at = a.anchor.count === 0 ? GENESIS : db.query<{ hash: string }, [number]>('SELECT hash FROM audit ORDER BY id LIMIT 1 OFFSET ?').get(a.anchor.count - 1)?.hash
    if (at !== a.anchor.head) problems.push(`row ${a.anchor.count} no longer has the anchored hash (history before the anchor was rewritten)`)
  }
  return { ok: problems.length === 0, problems, anchor: a.anchor }
}
