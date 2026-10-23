import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Cloud } from '../src/cloud'
import { loadConfig, type Config } from '../src/config'
import { openDb } from '../src/db'
import { DirTarget } from '../src/backup'
import { FakeDriver, FakePool } from '../src/drivers/fake'
import { LocalKeyWrapper } from '../src/keys'
import { MemoryMailer } from '../src/mailer'
import { makeHandler } from '../src/web'
import { paddleHeader } from '../src/paddle'
import crypto from 'node:crypto'

export const SECRET = 'pdl_ntfset_test_secret'

export function setup(env: Record<string, string> = {}, o: { pool?: boolean; clock?: () => number } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdcloud-test-'))
  const cfg: Config = loadConfig({
    TDCLOUD_STATE_DIR: dir, TDCLOUD_DOMAIN: 'cloud.example.com', TDCLOUD_CONTROL_URL: 'https://cloud.example.com', TDCLOUD_DRIVER: 'fake',
    PADDLE_WEBHOOK_SECRET: SECRET, PADDLE_PRICE_TEAM_MONTHLY: 'pri_team_m', PADDLE_PRICE_BUSINESS_MONTHLY: 'pri_biz_m', ...env,
  })
  const driver = new FakeDriver(path.join(dir, 'fake'))
  const mailer = new MemoryMailer()
  const pool = new FakePool()
  const cloud = new Cloud({ cfg, db: openDb(cfg.dbFile), driver, mailer, keys: new LocalKeyWrapper(crypto.randomBytes(32)), target: new DirTarget(path.join(dir, 'backups')), log: () => {}, pool: o.pool ? pool : null, clock: o.clock })
  const handle = makeHandler(cloud)
  const call = (method: string, p: string, o: { body?: unknown; headers?: Record<string, string>; ip?: string; raw?: string } = {}) =>
    handle(new Request(`https://cloud.example.com${p}`, {
      method, headers: { ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}), ...o.headers },
      body: o.raw ?? (o.body !== undefined ? JSON.stringify(o.body) : undefined),
    }), o.ip ?? '203.0.113.9')
  return { dir, cfg, cloud, driver, pool, mailer, handle, call, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

export type Env = ReturnType<typeof setup>

let n = 0
export function event(type: string, data: Record<string, unknown>, occurredAt = new Date().toISOString()) {
  return { event_id: `evt_${Date.now()}_${n++}`, event_type: type, occurred_at: occurredAt, notification_id: 'ntf_1', data }
}

export async function webhook(env: Env, ev: unknown, secret = SECRET) {
  const raw = JSON.stringify(ev)
  return env.call('POST', '/paddle/webhook', { raw, headers: { 'paddle-signature': paddleHeader(secret, raw), 'content-type': 'application/json' } })
}

/** signup → verify → login → team; returns the session cookie, csrf and team */
export async function signedUpTeam(env: Env, email = 'buyer@acme.test', slug = 'acme') {
  await env.call('POST', '/api/signup', { body: { email, password: 'correct horse battery' } })
  const link = env.mailer.sent.filter((m) => m.to === email).at(-1)!.text.match(/verify\?token=(\S+)/)![1]!
  const v = await env.call('POST', '/api/verify', { body: { token: link } })
  if (v.status !== 200) throw new Error(`verify ${v.status}`)
  const l = await env.call('POST', '/api/login', { body: { email, password: 'correct horse battery' } })
  const cookie = l.headers.get('set-cookie')!.split(';')[0]!
  const { csrf } = await l.json() as { csrf: string }
  const t = await env.call('POST', '/api/teams', { body: { name: 'Acme Inc', slug }, headers: { cookie, 'x-csrf-token': csrf } })
  if (t.status !== 201) throw new Error(`team ${t.status} ${await t.text()}`)
  const { team } = await t.json() as { team: { id: string; slug: string; url: string } }
  return { cookie, csrf, team }
}
