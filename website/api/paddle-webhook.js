// Vercel Node.js function: POST https://drive.trina.app/api/paddle-webhook
// Web-handler signature (export function POST(request) → Response), see
// https://vercel.com/docs/functions/functions-api-reference. website/package.json has "type": "module".
// Files under api/_lib/ are helpers, not routes (Vercel skips paths that start with "_").
//
// Env (Vercel → Settings → Environment Variables; see website/.env.example):
//   PADDLE_WEBHOOK_SECRET (required), PADDLE_ENV, PADDLE_WEBHOOK_TOLERANCE_SEC, PADDLE_CHECK_IP,
//   optional storage KV_REST_API_URL/TOKEN (or UPSTASH_REDIS_REST_URL/TOKEN), optional email RESEND_API_KEY,
//   NOTIFY_FROM, NOTIFY_EMAIL. Without storage/email every event is logged as one JSON line.

import { handlePaddleWebhook } from './_lib/paddle-webhook-core.js';
import { makeMailer, makeStore } from './_lib/adapters.js';

export const config = { maxDuration: 10 };

export async function POST(request) {
  const env = process.env;
  return handlePaddleWebhook(request, { env, store: makeStore(env), mailer: makeMailer(env) });
}

export function GET() {
  return new Response('method not allowed', { status: 405, headers: { Allow: 'POST' } });
}
