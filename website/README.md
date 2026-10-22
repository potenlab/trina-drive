# drive.trina.app — Trina Drive marketing site

Static site (Astro 7, no UI framework, no web fonts). English at `/`, Korean at `/ko`. Output: `website/dist`.

```sh
cd website
bun install
bun run dev        # http://localhost:4321
bun run build      # -> dist/
bun run preview    # serve dist/ locally
bun run og         # re-render public/og.png, og-ko.png and the PNG favicons (needs `brew install librsvg`)
```

## Layout

| | |
|---|---|
| `src/content/en.ts`, `ko.ts` | all copy, one object per locale (same shape). Korean follows `~/.claude/skills/korean-landing-copy` (명사형 제목, 해요체 본문). The security promise is plan §7.2 word for word |
| `src/site.ts` | links (GitHub, docs, security model, booking), company / business-registration lines |
| `src/checkout.ts` | `startCheckout(planId, { currency, lang })` — the one function every pricing button calls |
| `src/components/` | `Landing.astro` (all sections), `Terminal.astro` (hero demo), `Pricing.astro`, `Nav`, `Footer`, `Legal` (placeholder pages) |
| `src/scripts/main.ts` | theme toggle, mobile menu, copy button, KRW/USD toggle, checkout buttons, terminal replay |
| `public/` | favicon, OG images, `robots.txt`, `sitemap.xml`, `theme.js` (applies the saved theme before paint), `_headers` |
| `RESEARCH.md` | the YC-style landing page survey this design follows |

Prices come from `research/trina-drive/PRICING.md` (2026-10-23). Change them in `src/content/*.ts` — both currencies
are rendered and the toggle only switches which one shows.

## Placeholders (TODO before launch)

- **Legal pages** `/terms`, `/privacy`, `/refund` (+ `/ko/...`) show a "coming soon" notice and are `noindex`, left out of
  `sitemap.xml`. Payments: put the final text in `src/components/Legal.astro` (or give each page its own content), drop
  `noindex`, add them to `public/sitemap.xml`.
- **Checkout**: `src/checkout.ts` opens `mailto:contact@trina.app` with the plan in the subject. Swap the body of
  `startCheckout` for the payment provider; keep its signature and the `data-plan` ids (`team`, `business`, `setup`).
  Add the provider's origins to the CSP in `vercel.json` **and** `public/_headers` (`script-src`, `connect-src`,
  `frame-src`, `form-action`).
- **Links** in `src/site.ts`: GitHub / docs / security model point at `github.com/potenlab/trina-drive`, which is not
  public yet (open-source release pending, license TBA). "Book a setup call" is a mailto until there is a booking link.
- **통신판매업신고** is "(신고 예정)" in the footer business line — update `COMPANY` in `src/site.ts` once registered.

## Deploy (Vercel)

1. New Vercel project from this repo, **Root Directory = `website`**. `vercel.json` sets the framework (Astro),
   `bun install --frozen-lockfile`, `bun run build`, output `dist`, clean URLs (`/terms` serves `terms.html`, no
   trailing slash) and the security headers.
2. Domain: add `drive.trina.app` to the project, then at the `trina.app` registrar/DNS add
   `CNAME drive -> cname.vercel-dns.com` (Vercel shows the exact target). HTTPS is issued automatically.
3. Check: `curl -sI https://drive.trina.app | grep -iE 'content-security|strict-transport|x-frame'`.

Security headers: CSP without `unsafe-inline` (`script-src 'self'; style-src 'self'` — Astro is configured to emit
every script and stylesheet as a file; the only inline `<script>` is JSON-LD, which is data and not executed), HSTS
(2 years, includeSubDomains), `X-Frame-Options: DENY` + `frame-ancestors 'none'`, nosniff,
`Referrer-Policy: strict-origin-when-cross-origin`, a closed `Permissions-Policy`. If you add analytics or a payment
widget, add its origin to the CSP or it will be blocked.

Cloudflare Workers Assets / Pages also works: deploy `dist/` (it has `_headers` with the same headers); default
`html_handling` serves `/ko` from `ko.html` and `/terms` from `terms.html`.
