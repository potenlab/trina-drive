// bun test (inside website/). Ported from research/trina-drive/payments/integration/test/webhook.test.mjs (node:test → bun:test).
import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { handlePaddleWebhook, hmacHex, verifyPaddleSignature, parseSignatureHeader } from '../api/_lib/paddle-webhook-core.js';

const SECRET = 'pdl_ntfset_test_secret';
const NOW = 1_790_000_000_000; // 고정 시각(ms)

function memoryStore() {
  const seen = new Set();
  const events = [];
  const subs = new Map();
  return {
    seen, events, subs,
    async claimEvent(id) { if (seen.has(id)) return false; seen.add(id); return true; },
    async appendEvent(s) { events.push(s); },
    async upsertSubscriptionIfNewer(s) {
      const prev = subs.get(s.subscription_id);
      if (prev && Date.parse(prev.occurred_at) > Date.parse(s.occurred_at)) return;
      subs.set(s.subscription_id, s);
    },
  };
}

function event(type, { id = 'evt_1', occurred = '2026-10-23T00:00:00Z', status = 'active' } = {}) {
  return {
    event_id: id,
    event_type: type,
    occurred_at: occurred,
    notification_id: 'ntf_1',
    data: {
      id: type.startsWith('subscription.') ? 'sub_1' : 'txn_1',
      subscription_id: type.startsWith('transaction.') ? 'sub_1' : undefined,
      customer_id: 'ctm_1',
      status,
      currency_code: 'USD',
      items: [{ price: { id: 'pri_TEAM_MONTHLY' }, quantity: 1 }, { price: { id: 'pri_SEAT_TEAM_MONTHLY' }, quantity: 3 }],
      custom_data: { plan_id: 'team-monthly', extra_seats: '3' },
      details: { totals: { grand_total: '12600' } },
    },
  };
}

async function signedRequest(body, { secret = SECRET, tsSec = NOW / 1000 } = {}) {
  const raw = JSON.stringify(body);
  const ts = String(Math.floor(tsSec));
  const h1 = await hmacHex(secret, `${ts}:${raw}`);
  return new Request('https://drive.trina.app/api/paddle-webhook', {
    method: 'POST',
    headers: { 'paddle-signature': `ts=${ts};h1=${h1}`, 'content-type': 'application/json' },
    body: raw,
  });
}

const env = { PADDLE_WEBHOOK_SECRET: SECRET, PADDLE_ENV: 'sandbox' };
const quiet = { warn() {}, error() {}, log() {} };

test('header parsing keeps multiple h1 (secret rotation)', () => {
  assert.deepEqual(parseSignatureHeader('ts=1;h1=a;h1=b'), { ts: '1', h1: ['a', 'b'] });
});

test('valid signature → 200, stored, mail sent for subscription.created', async () => {
  const store = memoryStore();
  const mails = [];
  const res = await handlePaddleWebhook(await signedRequest(event('subscription.created')), {
    env, store, mailer: { async send(m) { mails.push(m); } }, now: () => NOW, log: quiet,
  });
  assert.equal(res.status, 200);
  assert.equal(store.events.length, 1);
  assert.equal(store.subs.get('sub_1').status, 'active');
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to, 'contact@trina.app');
  assert.match(mails[0].text, /pri_SEAT_TEAM_MONTHLY x3/);
});

test('wrong secret → 401', async () => {
  const res = await handlePaddleWebhook(await signedRequest(event('subscription.created'), { secret: 'nope' }), {
    env, store: memoryStore(), mailer: null, now: () => NOW, log: quiet,
  });
  assert.equal(res.status, 401);
});

test('stale timestamp → 401 (replay)', async () => {
  const res = await handlePaddleWebhook(await signedRequest(event('subscription.created'), { tsSec: NOW / 1000 - 60 }), {
    env, store: memoryStore(), mailer: null, now: () => NOW, log: quiet,
  });
  assert.equal(res.status, 401);
});

test('body tampered after signing → 401', async () => {
  const req = await signedRequest(event('subscription.created'));
  const tampered = new Request(req.url, { method: 'POST', headers: req.headers, body: (await req.text()).replace('active', 'canceled') });
  const res = await handlePaddleWebhook(tampered, { env, store: memoryStore(), mailer: null, now: () => NOW, log: quiet });
  assert.equal(res.status, 401);
});

test('duplicate event_id processed once', async () => {
  const store = memoryStore();
  const mails = [];
  const deps = { env, store, mailer: { async send(m) { mails.push(m); } }, now: () => NOW, log: quiet };
  await handlePaddleWebhook(await signedRequest(event('transaction.payment_failed', { id: 'evt_9' })), deps);
  const res = await handlePaddleWebhook(await signedRequest(event('transaction.payment_failed', { id: 'evt_9' })), deps);
  assert.equal(res.status, 200);
  assert.equal(store.events.length, 1);
  assert.equal(mails.length, 1);
});

test('out-of-order: older subscription.updated does not overwrite newer canceled', async () => {
  const store = memoryStore();
  const deps = { env, store, mailer: null, now: () => NOW, log: quiet };
  await handlePaddleWebhook(await signedRequest(event('subscription.canceled', { id: 'evt_b', occurred: '2026-10-23T10:00:00Z', status: 'canceled' })), deps);
  await handlePaddleWebhook(await signedRequest(event('subscription.updated', { id: 'evt_a', occurred: '2026-10-23T09:00:00Z', status: 'active' })), deps);
  assert.equal(store.subs.get('sub_1').status, 'canceled');
});

test('unhandled event type → 200 without storing', async () => {
  const store = memoryStore();
  const res = await handlePaddleWebhook(await signedRequest(event('address.created')), { env, store, mailer: null, now: () => NOW, log: quiet });
  assert.equal(res.status, 200);
  assert.equal(store.events.length, 0);
});

test('mail failure still returns 200 (no Paddle retry storm)', async () => {
  const store = memoryStore();
  const res = await handlePaddleWebhook(await signedRequest(event('subscription.canceled')), {
    env, store, mailer: { async send() { throw new Error('smtp down'); } }, now: () => NOW, log: quiet,
  });
  assert.equal(res.status, 200);
});

test('IP allowlist on → unknown IP rejected', async () => {
  const req = await signedRequest(event('subscription.created'));
  const withIp = new Request(req.url, { method: 'POST', headers: { ...Object.fromEntries(req.headers), 'x-real-ip': '1.2.3.4' }, body: await req.text() });
  const res = await handlePaddleWebhook(withIp, { env: { ...env, PADDLE_CHECK_IP: '1' }, store: memoryStore(), mailer: null, now: () => NOW, log: quiet });
  assert.equal(res.status, 403);
});

test('verifyPaddleSignature without secret fails closed', async () => {
  const r = await verifyPaddleSignature({ rawBody: '{}', header: 'ts=1;h1=x', secret: '' });
  assert.equal(r.ok, false);
});

// ---- added for the website port ----
import { makeMailer, makeStore } from '../api/_lib/adapters.js';

function captureLog() {
  const lines = [];
  return { lines, log: { warn() {}, error() {}, log(s) { lines.push(s); } } };
}

test('no store and no mailer → 200 and one structured JSON log line', async () => {
  const { lines, log } = captureLog();
  const res = await handlePaddleWebhook(await signedRequest(event('transaction.completed', { id: 'evt_log', status: 'completed' })), {
    env, store: null, mailer: null, now: () => NOW, log,
  });
  expect(res.status).toBe(200);
  expect(lines.length).toBe(1);
  const entry = JSON.parse(lines[0]);
  expect(entry).toMatchObject({
    msg: 'paddle_webhook', env: 'sandbox', stored: false, event_id: 'evt_log', event_type: 'transaction.completed',
    transaction_id: 'txn_1', subscription_id: 'sub_1', total: '12600', currency: 'USD',
  });
});

test('subscription.updated and transaction.completed are stored without an email', async () => {
  const store = memoryStore();
  const mails = [];
  const deps = { env, store, mailer: { async send(m) { mails.push(m); } }, now: () => NOW, log: quiet };
  await handlePaddleWebhook(await signedRequest(event('subscription.updated', { id: 'evt_u' })), deps);
  await handlePaddleWebhook(await signedRequest(event('transaction.completed', { id: 'evt_t' })), deps);
  expect(store.events.map((e) => e.event_type)).toEqual(['subscription.updated', 'transaction.completed']);
  expect(mails.length).toBe(0);
});

test('PADDLE_ENV=production uses the live IP list', async () => {
  const req = await signedRequest(event('subscription.created'));
  const fromLive = new Request(req.url, { method: 'POST', headers: { ...Object.fromEntries(req.headers), 'x-real-ip': '34.232.58.13' }, body: await req.text() });
  const res = await handlePaddleWebhook(fromLive, {
    env: { ...env, PADDLE_ENV: 'production', PADDLE_CHECK_IP: '1' }, store: null, mailer: null, now: () => NOW, log: quiet,
  });
  expect(res.status).toBe(200);
});

test('GET-like methods → 405', async () => {
  const res = await handlePaddleWebhook(new Request('https://drive.trina.app/api/paddle-webhook'), { env, store: null, mailer: null, log: quiet });
  expect(res.status).toBe(405);
});

test('adapters are off without env', () => {
  expect(makeStore({})).toBeNull();
  expect(makeMailer({})).toBeNull();
});

test('store adapter: SET NX for dedup, prefixed by environment', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ result: calls.length === 1 ? 'OK' : null }), { status: 200 });
  };
  const store = makeStore({ KV_REST_API_URL: 'https://kv.example', KV_REST_API_TOKEN: 't', PADDLE_ENV: 'live' }, fakeFetch);
  expect(await store.claimEvent('evt_1')).toBe(true);
  expect(await store.claimEvent('evt_1')).toBe(false);
  expect(calls[0].slice(0, 4)).toEqual(['SET', 'trina-drive:live:evt:evt_1', '1', 'NX']);
});

test('mail adapter posts to the email API with the configured sender', async () => {
  let sent;
  const fakeFetch = async (url, init) => { sent = { url, body: JSON.parse(init.body) }; return new Response('{}', { status: 200 }); };
  const mailer = makeMailer({ RESEND_API_KEY: 'k', NOTIFY_FROM: 'Billing <billing@trina.app>' }, fakeFetch);
  await mailer.send({ to: 'contact@trina.app', subject: 's', text: 't' });
  expect(sent.url).toBe('https://api.resend.com/emails');
  expect(sent.body).toMatchObject({ from: 'Billing <billing@trina.app>', to: ['contact@trina.app'] });
});

test('Vercel entry point wires env → handler (no secret → 401)', async () => {
  const saved = process.env.PADDLE_WEBHOOK_SECRET;
  delete process.env.PADDLE_WEBHOOK_SECRET;
  const errors = console.warn;
  console.warn = () => {};
  try {
    const { POST, GET } = await import('../api/paddle-webhook.js');
    const res = await POST(await signedRequest(event('subscription.created')));
    expect(res.status).toBe(401);
    expect(GET().status).toBe(405);
  } finally {
    console.warn = errors;
    if (saved !== undefined) process.env.PADDLE_WEBHOOK_SECRET = saved;
  }
});
