# drive.trina.app — Trina Drive marketing site

Static site (Astro 7, no UI framework, no web fonts). English at `/`, Korean at `/ko`. Output: `website/dist`.

```sh
cd website
bun install
bun run dev        # http://localhost:4321
bun run build      # -> dist/
bun run preview    # serve dist/ locally
bun run test       # bun test: Paddle config/checkout routing + webhook (signature, dedup, ordering, adapters)
bun run og         # re-render public/og.png, og-ko.png and the PNG favicons (needs `brew install librsvg`)
```

## Layout

| | |
|---|---|
| `src/content/en.ts`, `ko.ts` | all copy, one object per locale (same shape). Korean follows `~/.claude/skills/korean-landing-copy` (명사형 제목, 해요체 본문). The security promise is plan §7.2 word for word |
| `src/site.ts` | links (GitHub, docs, security model, booking), company / business-registration lines |
| `src/checkout.ts` | `startCheckout(planId, { currency, lang, billing, people })` — the one function every pricing button calls. USD Team/Business → Paddle overlay (Paddle.js loaded from cdn.paddle.com on first click); KRW → bank-transfer + tax-invoice email; setup → email; no Paddle env → email |
| `src/paddle.ts`, `src/paddle-env.ts` | Paddle config from build-time `PUBLIC_PADDLE_*` env (pure helpers + the env reader). See `.env.example` |
| `src/legal/*.md` | Terms / Privacy / Refund, EN + KO, rendered by `Legal.astro` at build time. Draft — lawyer review pending. Source of truth: `research/trina-drive/payments/legal/` (placeholders filled here) |
| `api/paddle-webhook.js`, `api/_lib/` | Vercel function `POST /api/paddle-webhook` (signature, IP allowlist, dedup, alerts). `_lib` is not routed |
| `test/` | `bun test` suites |
| `src/components/` | `Landing.astro` (all sections), `Terminal.astro` (hero demo), `Pricing.astro`, `Nav`, `Footer`, `Legal`, `Thanks` (`/thanks`, Paddle's success page, noindex) |
| `src/scripts/main.ts` | theme toggle, mobile menu, copy button, KRW/USD and monthly/yearly toggles, checkout buttons, terminal replay |
| `public/` | favicon, OG images, `robots.txt`, `sitemap.xml`, `theme.js` (applies the saved theme before paint), `_headers` |
| `RESEARCH.md` | the YC-style landing page survey this design follows |

Prices come from `research/trina-drive/PRICING.md` (2026-10-23). Change them in `src/content/*.ts` — both currencies
are rendered and the toggle only switches which one shows.

## Payments (Paddle) and legal pages

Decision (`research/trina-drive/payments/README.md`): USD subscriptions through **Paddle Billing** (Merchant of
Record); KRW by **bank transfer + 전자세금계산서** today, card monthly billing through Payple later; setup & migration
is a quoted human service and never goes through Paddle.

- Without `PUBLIC_PADDLE_*` env the site behaves as before: every price button opens an email to contact@trina.app.
  Setting the env (and rebuilding) switches USD Team/Business buttons to the Paddle overlay. KRW stays email.
- The pricing cards have a monthly/yearly toggle and an "AI-connected people" field; people beyond the included
  10/40 are added as extra-seat quantity in the same checkout (seat price of the same cycle required).
- Paddle sends the buyer to `/thanks?plan=…` (or `/ko/thanks`). The webhook is the record of payment, not that page.
- Legal pages are live and indexable (in `sitemap.xml`). Each page carries an HTML comment
  `draft — lawyer review pending`. Effective date 2026-11-01, last updated 2026-10-23.
- CSP (`vercel.json` and `public/_headers`, keep them identical) allows exactly what Paddle.js v2 uses:
  `script-src https://cdn.paddle.com`; `frame-src https://buy.paddle.com https://sandbox-buy.paddle.com`;
  `style-src 'unsafe-inline' https://cdn.paddle.com https://sandbox-cdn.paddle.com` (the overlay sets inline
  `style` attributes and injects `<style>` elements — scripts stay `'self'`-only); `img-src` the two CDNs;
  `connect-src https://api.paddle.com https://sandbox-api.paddle.com`. `Permissions-Policy: payment=(self
  buy.paddle.com …)` for Apple/Google Pay inside the iframe, `Cross-Origin-Opener-Policy: same-origin-allow-popups`
  for PayPal / Apple Pay popups. Paddle Retain (profitwell.js) is not used and not allowed.

## Go live checklist

1. **Vercel env vars** (Settings → Environment Variables; names and comments in `.env.example`):
   - Build time, per environment (Preview = sandbox, Production = live): `PUBLIC_PADDLE_CLIENT_TOKEN`,
     `PUBLIC_PADDLE_ENV` (`sandbox` | `production`), `PUBLIC_PADDLE_PRICE_TEAM_MONTHLY`, `..._TEAM_YEARLY`,
     `..._BUSINESS_MONTHLY`, `..._BUSINESS_YEARLY`, `..._EXTRA_SEAT_TEAM`, `..._EXTRA_SEAT_BUSINESS`, and optionally
     `..._EXTRA_SEAT_TEAM_YEARLY`, `..._EXTRA_SEAT_BUSINESS_YEARLY`. No setup price (by decision). Redeploy after changes.
   - Runtime (webhook): `PADDLE_WEBHOOK_SECRET` (required), `PADDLE_ENV` (`sandbox` | `live`), `PADDLE_CHECK_IP=1`,
     `PADDLE_WEBHOOK_TOLERANCE_SEC=5`; optional `KV_REST_API_URL`/`KV_REST_API_TOKEN` (dedup + subscription state),
     `RESEND_API_KEY`, `NOTIFY_FROM`, `NOTIFY_EMAIL`. If you turn on storage or email, add those providers to
     `src/legal/privacy.*.md` §5 first (today it lists Vercel, "our email provider", Tailscale, Paddle).
2. **Paddle**: create products/prices in sandbox (then live): Team $99/mo + $990/yr (14-day trial), Business
   $349/mo + $3,490/yr, extra seat Team $9/mo + $90/yr, Business $7/mo + $70/yr. Developer tools → **Website
   approval / domain approval for `drive.trina.app`** (checkout only opens on approved domains; the live account
   review also reads `/terms`, `/privacy`, `/refund` and the pricing page). Set the **default payment link**
   (Checkout settings) to `https://drive.trina.app/` — pages load Paddle.js when the URL has `?_ptxn=` so links
   from invoices open the checkout there.
3. **Webhook**: Developer tools → Notifications → New destination `https://drive.trina.app/api/paddle-webhook`,
   events: `subscription.created`, `.activated`, `.trialing`, `.updated`, `.past_due`, `.paused`, `.resumed`,
   `.canceled`, `transaction.completed`, `transaction.payment_failed`. Copy its secret into `PADDLE_WEBHOOK_SECRET`.
   If `PADDLE_CHECK_IP=1`, exempt this path from Vercel bot protection / firewall challenges. Test with the sandbox
   webhook simulator, then replay once (should log `paddle_webhook_duplicate` when storage is on).
   Check on the first preview deploy that Vercel built `api/paddle-webhook.js` as a function (Deployments →
   Functions); the project uses the Astro preset without an adapter, so zero-config `/api` functions apply.
4. **DNS (Gabia)**: at the `trina.app` zone add `CNAME drive → cname.vercel-dns.com` (use the exact target Vercel
   shows), wait for the certificate, then check headers (below).
5. Sandbox end-to-end: Team monthly + 3 extra people with a test card → `/thanks` → webhook log line / email.
   Then live token + live price IDs + live secret, `PUBLIC_PADDLE_ENV=production`, `PADDLE_ENV=live`, one real
   payment and refund.
6. Legal: lawyer review (forum clause, overseas-transfer table), then remove the `draft — lawyer review pending`
   comment from `src/legal/*.md`. Once 통신판매업 is registered, put the number in `src/site.ts` (`COMPANY`) and
   `src/legal/terms.ko.md` / `terms.en.md` ("신고 진행 중" / "in progress").

## Other placeholders

- **Links** in `src/site.ts`: GitHub / docs / security model point at `github.com/potenlab/trina-drive`, which is not
  public yet (open-source release pending, license TBA). "Book a setup call" is a mailto until there is a booking link.

## Deploy (Vercel)

1. New Vercel project from this repo, **Root Directory = `website`**. `vercel.json` sets the framework (Astro),
   `bun install --frozen-lockfile`, `bun run build`, output `dist`, clean URLs (`/terms` serves `terms.html`, no
   trailing slash) and the security headers.
2. Domain: add `drive.trina.app` to the project, then at the `trina.app` DNS (Gabia) add
   `CNAME drive -> cname.vercel-dns.com` (Vercel shows the exact target). HTTPS is issued automatically.
3. Check: `curl -sI https://drive.trina.app | grep -iE 'content-security|strict-transport|x-frame'`.

Security headers: CSP with no inline script (`script-src 'self' https://cdn.paddle.com` — Astro is configured to emit
every script as a file; the only inline `<script>` is JSON-LD, which is data and not executed; `style-src` allows
inline styles only because the Paddle overlay needs them, see above), HSTS
(2 years, includeSubDomains), `X-Frame-Options: DENY` + `frame-ancestors 'none'`, nosniff,
`Referrer-Policy: strict-origin-when-cross-origin`, a `Permissions-Policy` closed except `payment` for Paddle. If you
add analytics or another widget, add its origin to the CSP or it will be blocked.

Cloudflare Workers Assets / Pages also works for the static pages (the `/api` webhook is Vercel-only; on Workers,
wrap `api/_lib/paddle-webhook-core.js` in a `fetch` handler): deploy `dist/` (it has `_headers` with the same headers); default
`html_handling` serves `/ko` from `ko.html` and `/terms` from `terms.html`.
