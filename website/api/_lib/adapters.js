// 저장소·메일 어댑터. 둘 다 HTTP API 라서 의존성 패키지가 없다.
//
// 저장소: Upstash Redis REST (Vercel Marketplace 에서 "Upstash for Redis" 추가하면 환경변수가 자동으로 들어온다)
//   - 문서: https://upstash.com/docs/redis/features/restapi  (POST <url> 본문 ["SET","k","v",...])
//   - 변수명: KV_REST_API_URL / KV_REST_API_TOKEN (옛 Vercel KV 이름) 또는 UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
// 메일: Resend (https://resend.com/docs/api-reference/emails/send-email). 보내는 주소 도메인(trina.app) 인증 필요.
//   다른 메일 API 를 쓰면 makeMailer 만 바꾸면 된다.

import { isLiveEnv } from './paddle-webhook-core.js';

const EVENT_TTL_SEC = 60 * 60 * 24 * 90; // 중복 제거 키 90일 보관(Paddle 재시도는 최대 약 2일)

export function makeStore(env, fetchImpl = fetch) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null; // 저장소 없이도 동작(메일만 감). 단 중복 제거가 안 된다.
  const prefix = `trina-drive:${isLiveEnv(env) ? 'live' : 'sandbox'}:`;

  async function cmd(args) {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) throw new Error(`redis ${args[0]} failed: ${res.status}`);
    return (await res.json()).result;
  }

  return {
    async claimEvent(eventId) {
      return (await cmd(['SET', `${prefix}evt:${eventId}`, '1', 'NX', 'EX', String(EVENT_TTL_SEC)])) === 'OK';
    },
    async appendEvent(summary) {
      // 최근 이벤트 목록(최대 5000개). 정산 대조는 Paddle 대시보드/리포트가 원본이다.
      await cmd(['LPUSH', `${prefix}events`, JSON.stringify(summary)]);
      await cmd(['LTRIM', `${prefix}events`, '0', '4999']);
    },
    async upsertSubscriptionIfNewer(summary) {
      // 고객 수가 적어 GET→비교→SET 으로 충분(동시 경합은 드묾). 커지면 Lua(EVAL)로 원자화.
      const key = `${prefix}sub:${summary.subscription_id}`;
      const prevRaw = await cmd(['GET', key]);
      const prev = prevRaw ? JSON.parse(prevRaw) : null;
      if (prev && Date.parse(prev.occurred_at) > Date.parse(summary.occurred_at)) return;
      await cmd(['SET', key, JSON.stringify(summary)]);
      await cmd(['SADD', `${prefix}subs`, summary.subscription_id]);
    },
  };
}

export function makeMailer(env, fetchImpl = fetch) {
  if (!env.RESEND_API_KEY) return null; // no email provider configured → structured log only
  return {
    async send({ to, subject, text }) {
      const res = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: env.NOTIFY_FROM || 'Trina Drive Billing <billing@trina.app>', to: [to], subject, text }),
        signal: AbortSignal.timeout(2500), // Paddle 은 5초 안에 200 을 기대한다
      });
      if (!res.ok) throw new Error(`resend failed: ${res.status} ${await res.text()}`);
    },
  };
}
