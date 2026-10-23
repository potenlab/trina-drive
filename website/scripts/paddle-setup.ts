// One-time Paddle setup for the landing site: products, prices, webhook destination, client-side token.
// Idempotent: finds what already exists by `custom_data.key` and only creates what is missing.
//
//   PADDLE_API_KEY=... bun scripts/paddle-setup.ts [--env-out FILE]
//
// The API key decides the environment (pdl_sdbx_apikey_… → sandbox, pdl_live_apikey_… → live). Nothing secret is
// printed: the webhook secret and the client token go only into --env-out (default .env.paddle, mode 0600), and the
// script prints which variables it wrote.
import fs from 'node:fs'

const key = process.env.PADDLE_API_KEY?.trim()
if (!key) { console.error('PADDLE_API_KEY is not set'); process.exit(2) }
const sandbox = key.includes('_sdbx_')
const base = sandbox ? 'https://sandbox-api.paddle.com' : 'https://api.paddle.com'
const envOut = process.argv.includes('--env-out') ? process.argv[process.argv.indexOf('--env-out') + 1]! : '.env.paddle'
const site = 'https://drive.trina.app'

async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(base + path, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'Paddle-Version': '1' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const j = await r.json().catch(() => ({})) as any
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${j?.error?.code ?? ''} ${j?.error?.detail ?? ''}`.trim())
  return j.data as T
}

async function all(path: string): Promise<any[]> {
  const out: any[] = []
  let next: string | null = `${path}${path.includes('?') ? '&' : '?'}per_page=200`
  while (next) {
    const r = await fetch(next.startsWith('http') ? next : base + next, { headers: { Authorization: `Bearer ${key}`, 'Paddle-Version': '1' } })
    const j = await r.json() as any
    if (!r.ok) throw new Error(`GET ${path} → ${r.status} ${j?.error?.detail ?? ''}`)
    out.push(...j.data)
    next = j.meta?.pagination?.has_more ? j.meta.pagination.next : null
  }
  return out
}

const PRODUCTS = [
  { key: 'team', name: 'Trina Drive Team', description: 'Managed Trina Drive on your office Mac mini: install, monitoring, updates, backups, security fixes. Up to 10 AI-connected people.' },
  { key: 'business', name: 'Trina Drive Business', description: 'Managed Trina Drive for up to 40 AI-connected people, 4-business-hour response, quarterly permission and audit review.' },
  { key: 'seat-team', name: 'Trina Drive Team — extra AI-connected person', description: 'One more AI-connected person on the Team plan.' },
  { key: 'seat-business', name: 'Trina Drive Business — extra AI-connected person', description: 'One more AI-connected person on the Business plan.' },
] as const

type Interval = 'month' | 'year'
// krw: what a buyer in Korea pays (KRW has no minor unit in Paddle), set as a KR country override on the USD price.
const PRICES: { env: string; product: string; cents: number; krw: number; interval: Interval; trial?: boolean; seats?: boolean; label: string }[] = [
  { env: 'PUBLIC_PADDLE_PRICE_TEAM_MONTHLY', product: 'team', cents: 9900, krw: 129000, interval: 'month', trial: true, label: 'Team — monthly' },
  { env: 'PUBLIC_PADDLE_PRICE_TEAM_YEARLY', product: 'team', cents: 99000, krw: 1290000, interval: 'year', trial: true, label: 'Team — yearly' },
  { env: 'PUBLIC_PADDLE_PRICE_BUSINESS_MONTHLY', product: 'business', cents: 34900, krw: 449000, interval: 'month', label: 'Business — monthly' },
  { env: 'PUBLIC_PADDLE_PRICE_BUSINESS_YEARLY', product: 'business', cents: 349000, krw: 4490000, interval: 'year', label: 'Business — yearly' },
  { env: 'PUBLIC_PADDLE_PRICE_EXTRA_SEAT_TEAM', product: 'seat-team', cents: 900, krw: 12000, interval: 'month', seats: true, label: 'Team extra person — monthly' },
  { env: 'PUBLIC_PADDLE_PRICE_EXTRA_SEAT_TEAM_YEARLY', product: 'seat-team', cents: 9000, krw: 120000, interval: 'year', seats: true, label: 'Team extra person — yearly' },
  { env: 'PUBLIC_PADDLE_PRICE_EXTRA_SEAT_BUSINESS', product: 'seat-business', cents: 700, krw: 9000, interval: 'month', seats: true, label: 'Business extra person — monthly' },
  { env: 'PUBLIC_PADDLE_PRICE_EXTRA_SEAT_BUSINESS_YEARLY', product: 'seat-business', cents: 7000, krw: 90000, interval: 'year', seats: true, label: 'Business extra person — yearly' },
]

const EVENTS = ['subscription.created', 'subscription.trialing', 'subscription.activated', 'subscription.updated', 'subscription.past_due',
  'subscription.paused', 'subscription.resumed', 'subscription.canceled', 'transaction.completed', 'transaction.payment_failed']

const env: Record<string, string> = { PUBLIC_PADDLE_ENV: sandbox ? 'sandbox' : 'production', PADDLE_ENV: sandbox ? 'sandbox' : 'production' }

// products
const products = await all('/products?status=active')
const productId: Record<string, string> = {}
for (const p of PRODUCTS) {
  const found = products.find((x) => x.custom_data?.key === p.key)
  productId[p.key] = found?.id ?? (await api('POST', '/products', { name: p.name, description: p.description, tax_category: 'saas', custom_data: { key: p.key, app: 'trina-drive' } })).id
  console.log(`${found ? 'found  ' : 'created'} product ${p.name}`)
}

// prices
const prices = await all('/prices?status=active')
for (const p of PRICES) {
  const found = prices.find((x) => x.custom_data?.env === p.env)
  const id = found?.id ?? (await api('POST', '/prices', {
    product_id: productId[p.product],
    description: p.label,
    name: p.label,
    unit_price: { amount: String(p.cents), currency_code: 'USD' },
    billing_cycle: { interval: p.interval, frequency: 1 },
    ...(p.trial ? { trial_period: { interval: 'day', frequency: 14 } } : {}),
    quantity: p.seats ? { minimum: 1, maximum: 200 } : { minimum: 1, maximum: 1 },
    tax_mode: 'account_setting',
    custom_data: { env: p.env, app: 'trina-drive' },
  })).id
  env[p.env] = id
  const override = { country_codes: ['KR'], unit_price: { amount: String(p.krw), currency_code: 'KRW' } }
  const current = found?.unit_price_overrides ?? []
  const hasKr = current.some((o: any) => o.country_codes?.includes('KR') && o.unit_price?.currency_code === 'KRW' && o.unit_price?.amount === String(p.krw))
  if (!hasKr) await api('PATCH', `/prices/${id}`, { unit_price_overrides: [...current.filter((o: any) => !o.country_codes?.includes('KR')), override] })
  console.log(`${found ? 'found  ' : 'created'} price ${p.label}${hasKr ? '' : ' (+ KRW for KR)'}`)
}

// webhook destination
const dest = `${site}/api/paddle-webhook`
const settings = await all('/notification-settings')
let setting = settings.find((s) => s.destination === dest)
if (!setting) {
  setting = await api('POST', '/notification-settings', { description: 'Trina Drive site webhook', type: 'url', destination: dest, subscribed_events: EVENTS, api_version: 1, include_sensitive_fields: false })
  console.log(`created webhook destination ${dest}`)
} else console.log(`found   webhook destination ${dest}`)
if (setting.endpoint_secret_key) env.PADDLE_WEBHOOK_SECRET = setting.endpoint_secret_key

// client-side token (API support varies by account; fall back to the dashboard)
try {
  const tokens = await all('/client-tokens')
  const t = tokens.find((x) => x.name === 'trina-drive-site' && x.status === 'active') ?? await api('POST', '/client-tokens', { name: 'trina-drive-site', description: 'drive.trina.app checkout' })
  if (t?.token) env.PUBLIC_PADDLE_CLIENT_TOKEN = t.token
  console.log('client-side token: ok')
} catch (e) {
  console.log(`client-side token: create it in Developer tools → Authentication (${(e as Error).message})`)
}

fs.writeFileSync(envOut, Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 })
console.log(`\nwrote ${Object.keys(env).length} variables to ${envOut}: ${Object.keys(env).join(', ')}`)
console.log(`environment: ${sandbox ? 'sandbox' : 'live'}`)
