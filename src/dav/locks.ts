// WebDAV write locks (RFC 4918 §6–7), the minimum Finder, Windows' mini-redirector and Office need: exclusive and
// shared write locks on a path, depth 0 or infinity, with a timeout (at most an hour; clients refresh). Locks live in
// memory (a restart drops them, which clients survive: they lock again) and belong to the person who took them: a lock
// token works only for its own person. Paths are compared the way managed storage compares names (NFC, case folded).
import crypto from 'node:crypto'
import type { DB } from '../db'
import { nfc } from '../names'

export interface Lock { token: string; path: string; key: string; personId: number; exclusive: boolean; deep: boolean; owner: string; expires: number; timeoutS: number }

export const LOCK_MAX_S = 3600
const key = (vpath: string) => nfc(vpath).toLowerCase().replace(/\/+$/, '') || '/'
const under = (k: string, top: string) => top === '/' || k === top || k.startsWith(top + '/')

export class Locks {
  private readonly all = new Map<string, Lock>()
  private gc() { const t = Date.now(); for (const [k, l] of this.all) if (l.expires <= t) this.all.delete(k) }

  /** Locks that cover `vpath` (on it, or depth-infinity on a folder above), and with `deep` also those below it. */
  covering(vpath: string, deep = false): Lock[] {
    this.gc()
    const k = key(vpath)
    return [...this.all.values()].filter((l) => k === l.key || (l.deep && under(k, l.key)) || (deep && under(l.key, k)))
  }

  /** The first lock that stops this person (holding `tokens`) from changing `vpath` (and below it, with `deep`). */
  blocking(vpath: string, personId: number, tokens: Set<string>, deep = false): Lock | null {
    for (const l of this.covering(vpath, deep)) if (!(tokens.has(l.token) && l.personId === personId)) {
      // a shared lock is satisfied by any of the shared locks on the same resource that the caller holds
      if (!l.exclusive && this.covering(vpath, deep).some((o) => !o.exclusive && tokens.has(o.token) && o.personId === personId)) continue
      return l
    }
    return null
  }

  create(vpath: string, personId: number, o: { exclusive: boolean; deep: boolean; owner: string; timeoutS: number }): Lock | null {
    const k = key(vpath)
    const clash = this.covering(vpath, o.deep).some((l) => o.exclusive || l.exclusive)
    if (clash) return null
    const l: Lock = { token: `opaquelocktoken:${crypto.randomUUID()}`, path: vpath, key: k, personId, ...o, expires: Date.now() + o.timeoutS * 1000 }
    this.all.set(l.token, l)
    return l
  }

  get(token: string): Lock | null { this.gc(); return this.all.get(token) ?? null }
  refresh(l: Lock, timeoutS: number) { l.timeoutS = timeoutS; l.expires = Date.now() + timeoutS * 1000 }
  remove(token: string) { return this.all.delete(token) }
  /** The resource (and what was below it) is gone or moved away: its locks go too. */
  dropUnder(vpath: string) { const k = key(vpath); for (const [t, l] of this.all) if (under(l.key, k)) this.all.delete(t) }
}

const byDb = new WeakMap<DB, Locks>()
export const locksOf = (db: DB) => { let l = byDb.get(db); if (!l) { l = new Locks(); byDb.set(db, l) } return l }

/** "Second-600, Infinite" → seconds (the first one we understand), capped at LOCK_MAX_S. */
export function parseTimeout(h: string | null): number {
  for (const part of (h ?? '').split(',').map((s) => s.trim())) {
    if (/^infinite$/i.test(part)) return LOCK_MAX_S
    const m = /^second-(\d+)$/i.exec(part)
    if (m) return Math.max(1, Math.min(LOCK_MAX_S, Number(m[1])))
  }
  return LOCK_MAX_S
}

// ---------- the If header (RFC 4918 §10.4), enough to evaluate it ----------
export interface IfCondition { not: boolean; token?: string; etag?: string }
export interface IfList { resource: string | null; conditions: IfCondition[] }

/** Parse an If header; null when it is malformed. */
export function parseIf(h: string): IfList[] | null {
  const lists: IfList[] = []
  let resource: string | null = null
  let i = 0
  const ws = () => { while (/\s/.test(h[i] ?? '')) i++ }
  while (i < h.length) {
    ws()
    if (i >= h.length) break
    if (h[i] === '<') { const e = h.indexOf('>', i); if (e < 0) return null; resource = h.slice(i + 1, e); i = e + 1; continue }
    if (h[i] !== '(') return null
    i++
    const conditions: IfCondition[] = []
    for (;;) {
      ws()
      if (h[i] === ')') { i++; break }
      let not = false
      if (/^not\b/i.test(h.slice(i, i + 4))) { not = true; i += 3; ws() }
      if (h[i] === '<') { const e = h.indexOf('>', i); if (e < 0) return null; conditions.push({ not, token: h.slice(i + 1, e) }); i = e + 1 }
      else if (h[i] === '[') { const e = h.indexOf(']', i); if (e < 0) return null; conditions.push({ not, etag: h.slice(i + 1, e).replace(/^W\//, '') }); i = e + 1 }
      else return null
    }
    if (!conditions.length) return null
    lists.push({ resource, conditions })
  }
  return lists.length ? lists : null
}

/** Every lock token named anywhere in the If header ("submitted", RFC 4918 §10.4.1). */
export const submittedTokens = (lists: IfList[] | null) => new Set((lists ?? []).flatMap((l) => l.conditions.filter((c) => c.token).map((c) => c.token!)))
