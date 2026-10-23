// A/B test on the home page (Vercel Routing Middleware; runs before the static files are served).
// Visitors get variant A (/) or B (/b) at random and keep it via a cookie; ?v=a / ?v=b forces one (and sticks).
// Crawlers always get A, so search engines never index the noindex variant at /.
import { next, rewrite } from '@vercel/functions'

export const config = { matcher: ['/'] }

const COOKIE = 'td_ab'
const BOT = /bot|crawl|spider|slurp|bingpreview|facebookexternalhit|embedly|quora link preview|whatsapp|telegram|slack|discord|linkedin/i

export default function middleware(request: Request): Response {
  const url = new URL(request.url)
  if (BOT.test(request.headers.get('user-agent') ?? '')) return next()
  const forced = url.searchParams.get('v')
  const saved = /(?:^|;\s*)td_ab=(a|b)(?:;|$)/.exec(request.headers.get('cookie') ?? '')?.[1]
  const variant = forced === 'a' || forced === 'b' ? forced : saved ?? (Math.random() < 0.5 ? 'a' : 'b')
  const headers = saved === variant ? undefined : { 'Set-Cookie': `${COOKIE}=${variant}; Path=/; Max-Age=7776000; SameSite=Lax; Secure` }
  return variant === 'b' ? rewrite(new URL('/b', url), { headers }) : next({ headers })
}
