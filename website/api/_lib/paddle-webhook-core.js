// Trina Drive — Paddle webhook core (framework-free, Web-standard APIs only: crypto.subtle, fetch, Request).
// Runs unchanged on Vercel Node.js functions, Cloudflare Workers and Bun. Ported from
// research/trina-drive/payments/integration/lib/paddle-webhook-core.js; tests: website/test/paddle-webhook.test.js.
//
// Storage and email are optional (api/_lib/adapters.js, enabled by env). Without them every handled event is still
// written to the function log as one structured JSON line, so nothing is lost while those are not set up.
//
// 근거:
//  - 서명: https://developer.paddle.com/webhooks/about/signature-verification.md
//    헤더 `Paddle-Signature: ts=<unix>;h1=<hex>` / 서명 대상 `${ts}:${rawBody}` / HMAC-SHA256(엔드포인트 비밀키)
//    비밀키 교체 중에는 h1 이 여러 개 올 수 있다. 본문은 절대 파싱·가공 전에 검증한다.
//  - 전달: https://developer.paddle.com/webhooks/about/how-webhooks-work.md
//    최소 1회 전달(중복 가능) → event_id 로 중복 제거, 순서 보장 없음 → occurred_at 으로 최신 판단.
//  - 응답: https://developer.paddle.com/webhooks/about/respond-to-webhooks.md
//    5초 안에 200. 아니면 지수 백오프로 재시도(라이브 최대 60회 / 약 2일).

export const DEFAULT_TOLERANCE_SEC = 5; // Paddle SDK 기본값과 같음

// Paddle 웹훅 발신 IP (2026-10 문서 기준). 선택적으로 확인한다.
export const PADDLE_IPS = {
  sandbox: ['34.194.127.46', '54.234.237.108', '3.208.120.145', '44.226.236.210', '44.241.183.62', '100.20.172.113'],
  live: ['34.232.58.13', '34.195.105.136', '34.237.3.244', '35.155.119.135', '52.11.166.252', '34.212.5.7'],
};

// 우리가 구독하는 이벤트(Paddle 대시보드 Notifications 에서 이것만 체크)
export const HANDLED_EVENTS = new Set([
  'subscription.created',
  'subscription.activated',
  'subscription.trialing',
  'subscription.updated',
  'subscription.past_due',
  'subscription.paused',
  'subscription.resumed',
  'subscription.canceled',
  'transaction.completed',
  'transaction.payment_failed',
]);

// 사람이 바로 알아야 하는 이벤트 → contact@trina.app 메일
export const isLiveEnv = (env) => env.PADDLE_ENV === 'live' || env.PADDLE_ENV === 'production';

export const NOTIFY_EVENTS = new Set([
  'subscription.created',
  'subscription.canceled',
  'subscription.past_due',
  'transaction.payment_failed',
]);

const enc = new TextEncoder();

function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function parseSignatureHeader(header) {
  const out = { ts: null, h1: [] };
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k === 'ts') out.ts = v;
    else if (k === 'h1') out.h1.push(v);
  }
  return out;
}

export async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

/**
 * @returns {Promise<{ok: true} | {ok: false, reason: string}>}
 */
export async function verifyPaddleSignature({ rawBody, header, secret, nowSec = Date.now() / 1000, toleranceSec = DEFAULT_TOLERANCE_SEC }) {
  if (!secret) return { ok: false, reason: 'no_secret_configured' };
  const { ts, h1 } = parseSignatureHeader(header);
  if (!ts || h1.length === 0) return { ok: false, reason: 'malformed_header' };
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return { ok: false, reason: 'malformed_header' };
  if (Math.abs(nowSec - tsNum) > toleranceSec) return { ok: false, reason: 'timestamp_out_of_tolerance' };
  const expected = await hmacHex(secret, `${ts}:${rawBody}`);
  return h1.some((sig) => constantTimeEqual(expected, sig)) ? { ok: true } : { ok: false, reason: 'bad_signature' };
}

// 이벤트에서 우리가 보관할 최소 정보만 뽑는다(카드 정보는 Paddle 에만 있고 우리에게 오지 않는다).
export function summarize(event) {
  const d = event.data || {};
  const isSub = event.event_type.startsWith('subscription.');
  const items = (d.items || []).map((it) => ({
    price_id: it.price?.id ?? it.price_id ?? null,
    quantity: it.quantity ?? null,
  }));
  return {
    event_id: event.event_id,
    event_type: event.event_type,
    occurred_at: event.occurred_at,
    subscription_id: isSub ? d.id : d.subscription_id ?? null,
    transaction_id: isSub ? null : d.id ?? null,
    customer_id: d.customer_id ?? null,
    status: d.status ?? null,
    currency: d.currency_code ?? null,
    items,
    next_billed_at: d.next_billed_at ?? null,
    scheduled_change: d.scheduled_change ?? null,
    custom_data: d.custom_data ?? null,
    // transaction 합계(최소 단위 문자열, 예: "9900" = $99.00)
    total: d.details?.totals?.grand_total ?? null,
  };
}

/**
 * 웹훅 요청 하나를 처리한다. 의존성(store, mailer)은 주입한다.
 * @param {Request} request
 * @param {{ env: Record<string,string|undefined>, store: Store|null, mailer: Mailer|null, now?: () => number, log?: Console }} deps
 * @returns {Promise<Response>}
 */
export async function handlePaddleWebhook(request, { env, store, mailer, now = () => Date.now(), log = console }) {
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });

  // (선택) 발신 IP 확인. Vercel 은 x-forwarded-for / x-real-ip 를 채운다.
  if (env.PADDLE_CHECK_IP === '1') {
    const ip = (request.headers.get('x-real-ip') || request.headers.get('x-forwarded-for') || '').split(',')[0].trim();
    const allowed = PADDLE_IPS[isLiveEnv(env) ? 'live' : 'sandbox'];
    if (!allowed.includes(ip)) {
      log.warn('[paddle] rejected ip', ip);
      return new Response('forbidden', { status: 403 });
    }
  }

  const rawBody = await request.text(); // 파싱 전에 원문 그대로
  const verdict = await verifyPaddleSignature({
    rawBody,
    header: request.headers.get('paddle-signature'),
    secret: env.PADDLE_WEBHOOK_SECRET,
    nowSec: now() / 1000,
    toleranceSec: Number(env.PADDLE_WEBHOOK_TOLERANCE_SEC) || DEFAULT_TOLERANCE_SEC,
  });
  if (!verdict.ok) {
    log.warn('[paddle] signature rejected:', verdict.reason);
    return new Response('invalid signature', { status: 401 });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return new Response('bad json', { status: 400 });
  }
  if (!event?.event_id || !event?.event_type) return new Response('bad event', { status: 400 });

  // 구독하지 않은 이벤트는 받기만 한다(200 을 안 주면 Paddle 이 이틀간 재시도한다).
  if (!HANDLED_EVENTS.has(event.event_type)) return new Response('ignored', { status: 200 });

  const summary = summarize(event);

  if (store) {
    // 1) 중복 제거: 처음 본 event_id 만 처리
    const fresh = await store.claimEvent(event.event_id);
    if (!fresh) {
      log.log(JSON.stringify({ msg: 'paddle_webhook_duplicate', event_id: event.event_id, event_type: event.event_type }));
      return new Response('duplicate', { status: 200 });
    }
    // 2) 이벤트 로그(감사·세무 대조용)
    await store.appendEvent(summary);
    // 3) 구독 최신 상태: occurred_at 이 더 새로울 때만 덮어씀(순서 뒤바뀜 대비)
    if (summary.subscription_id && event.event_type.startsWith('subscription.')) {
      await store.upsertSubscriptionIfNewer(summary);
    }
  }

  // Always one structured log line per handled event (the only record when no store is configured; with a store it
  // makes the function log searchable too). Card data never reaches us; the summary holds ids, status and totals.
  log.log(JSON.stringify({ msg: 'paddle_webhook', env: isLiveEnv(env) ? 'live' : 'sandbox', stored: !!store, ...summary }));

  if (mailer && NOTIFY_EVENTS.has(event.event_type)) {
    try {
      await mailer.send({
        to: env.NOTIFY_EMAIL || 'contact@trina.app',
        subject: `[Trina Drive 결제] ${event.event_type} ${summary.subscription_id ?? summary.transaction_id ?? ''}`.trim(),
        text: mailBody(summary, env),
      });
    } catch (e) {
      // 메일 실패로 Paddle 재시도를 유발하지 않는다(이미 저장됨). 로그만 남긴다.
      log.error('[paddle] notify mail failed', e?.message || e);
    }
  }

  return new Response('ok', { status: 200 });
}

function mailBody(s, env) {
  const dash = isLiveEnv(env) ? 'https://vendors.paddle.com' : 'https://sandbox-vendors.paddle.com';
  const lines = [
    `이벤트: ${s.event_type}`,
    `발생: ${s.occurred_at}`,
    `구독: ${s.subscription_id ?? '-'}`,
    `거래: ${s.transaction_id ?? '-'}`,
    `고객: ${s.customer_id ?? '-'}`,
    `상태: ${s.status ?? '-'}`,
    `항목: ${s.items.map((i) => `${i.price_id} x${i.quantity}`).join(', ') || '-'}`,
    `금액: ${s.total ?? '-'} ${s.currency ?? ''}`,
    `다음 청구: ${s.next_billed_at ?? '-'}`,
    `custom_data: ${JSON.stringify(s.custom_data)}`,
    '',
    `Paddle 대시보드: ${dash}`,
  ];
  if (s.event_type === 'transaction.payment_failed' || s.event_type === 'subscription.past_due') {
    lines.push('', '할 일: 고객에게 결제수단 갱신 안내(Paddle 이 자동 재시도·안내 메일을 보내지만, 관리형 고객이면 직접 연락).');
  }
  if (s.event_type === 'subscription.created') {
    lines.push('', '할 일: 설치 일정 잡기 → 관리형 인스턴스 운영 대장에 등록.');
  }
  if (s.event_type === 'subscription.canceled') {
    lines.push('', '할 일: 종료일까지 운영 유지, 데이터 반출 안내, 원격 접속 권한 회수 일정 잡기.');
  }
  return lines.join('\n');
}

/**
 * @typedef {{
 *   claimEvent(eventId: string): Promise<boolean>,
 *   appendEvent(summary: object): Promise<void>,
 *   upsertSubscriptionIfNewer(summary: object): Promise<void>,
 * }} Store
 * @typedef {{ send(msg: {to: string, subject: string, text: string}): Promise<void> }} Mailer
 */
