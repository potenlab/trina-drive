// Search and AI-search plumbing, built from the same copy the pages show (src/content/en.ts), so prices, FAQ answers
// and facts can never drift from the visible text: the indexable page list (sitemap.xml), JSON-LD (schema.org) and
// /llms.txt + /llms-full.txt. Pure functions; the pages and endpoints call them at build time.
import type { Copy } from './content/en'
import { CLOUD_LIVE, CONTACT_EMAIL, LINKS, SITE_URL } from './site'

/** Indexable pages, in sitemap order. /a, /b (A/B variants, noindex), /thanks (noindex), /404 and /api are left out. */
export const PAGES: { path: string; lastmod: string }[] = [
  { path: '/', lastmod: '2026-10-23' },
  { path: '/security', lastmod: '2026-10-23' },
  { path: '/compare/google-drive', lastmod: '2026-10-23' },
  { path: '/terms', lastmod: '2026-10-23' },
  { path: '/privacy', lastmod: '2026-10-23' },
  { path: '/refund', lastmod: '2026-10-23' },
]

export const abs = (path: string) => new URL(path, SITE_URL).href

export function sitemapXml(pages = PAGES): string {
  const urls = pages.map((p) => `  <url>\n    <loc>${abs(p.path)}</loc>\n    <lastmod>${p.lastmod}</lastmod>\n  </url>`)
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`
}

/** "$3,490" → "3490" (schema.org wants a plain number). */
export const usd = (s: string) => s.replace(/[$,\s]/g, '')

const ORG_ID = `${SITE_URL}/#org`
const SITE_ID = `${SITE_URL}/#website`
const APP_ID = `${SITE_URL}/#app`

type Plan = Copy['pricing']['plans'][number]

/** One Offer per price the pricing section shows (monthly and yearly), plus self-hosting. Enterprise has no list price. */
export function offers(t: Pick<Copy, 'pricing'>) {
  const p = t.pricing
  const url = abs('/#pricing')
  // Trina Cloud is in early access while CLOUD_LIVE is false: the plans are announced, not yet for sale.
  const availability = CLOUD_LIVE ? 'https://schema.org/InStock' : 'https://schema.org/PreOrder'
  const offer = (plan: Plan, price: string, period: 'P1M' | 'P1Y', label: string) => ({
    '@type': 'Offer',
    name: `Trina Cloud ${plan.name} (${label})`,
    description: `${plan.kind}: ${plan.features.map((f) => f.replace('{extra}', period === 'P1M' ? plan.extra?.monthly ?? '' : plan.extra?.yearly ?? '')).join(', ')}`,
    price: usd(price),
    priceCurrency: 'USD',
    availability,
    url,
    priceSpecification: {
      '@type': 'UnitPriceSpecification',
      price: usd(price),
      priceCurrency: 'USD',
      billingDuration: period,
      unitText: period === 'P1M' ? 'month' : 'year',
    },
  })
  const list: object[] = []
  for (const plan of p.plans) {
    if (!plan.price.startsWith('$')) continue // Enterprise: "Custom"
    list.push(offer(plan, plan.price, 'P1M', 'monthly'))
    if (plan.yearly) list.push(offer(plan, plan.yearly.price, 'P1Y', 'yearly'))
  }
  list.push({
    '@type': 'Offer',
    name: `${p.self.name} (open source)`,
    description: p.self.body,
    price: usd(p.self.price),
    priceCurrency: 'USD',
    availability: 'https://schema.org/InStock',
    url: LINKS.github,
  })
  return list
}

/** FAQ answers exactly as the page shows them (a trailing link is part of the visible answer, so it is kept as <a>). */
export function faqPage(t: Pick<Copy, 'faq'>) {
  return {
    '@type': 'FAQPage',
    '@id': `${SITE_URL}/#faq`,
    mainEntity: t.faq.items.map((i) => ({
      '@type': 'Question',
      name: i.q,
      acceptedAnswer: { '@type': 'Answer', text: i.link ? `${i.a} <a href="${abs(i.link.href)}">${i.link.text}</a>` : i.a },
    })),
  }
}

export const organization = () => ({
  '@type': 'Organization',
  '@id': ORG_ID,
  name: 'Trina Inc.',
  url: SITE_URL,
  email: CONTACT_EMAIL,
  logo: { '@type': 'ImageObject', url: abs('/icon-512.png'), width: 512, height: 512 },
  sameAs: [LINKS.github],
})

export const website = () => ({
  '@type': 'WebSite',
  '@id': SITE_ID,
  name: 'Trina Drive',
  url: abs('/'),
  inLanguage: 'en',
  publisher: { '@id': ORG_ID },
})

export function homeJsonLd(t: Copy) {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      organization(),
      website(),
      {
        '@type': 'SoftwareApplication',
        '@id': APP_ID,
        name: 'Trina Drive',
        url: abs('/'),
        description: t.meta.long,
        applicationCategory: 'BusinessApplication',
        applicationSubCategory: 'AI knowledge base, team file drive, MCP server',
        operatingSystem: 'Web, macOS, Linux (Docker)',
        isAccessibleForFree: true,
        license: 'https://www.apache.org/licenses/LICENSE-2.0',
        image: abs(t.meta.ogImage),
        publisher: { '@id': ORG_ID },
        offers: offers(t),
      },
      {
        '@type': 'SoftwareSourceCode',
        name: 'Trina Drive',
        codeRepository: LINKS.github,
        programmingLanguage: 'TypeScript',
        license: 'https://www.apache.org/licenses/LICENSE-2.0',
        author: { '@id': ORG_ID },
        targetProduct: { '@id': APP_ID },
      },
      faqPage(t),
    ],
  }
}

/** Home → page, for subpages. */
export function breadcrumbJsonLd(name: string, path: string) {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Trina Drive', item: abs('/') },
          { '@type': 'ListItem', position: 2, name, item: abs(path) },
        ],
      },
    ],
  }
}

// ---------- /llms.txt and /llms-full.txt (https://llmstxt.org) ----------

const plainPlan = (plan: Plan) => {
  const price = plan.price.startsWith('$') ? `${plan.price}${plan.unit ? ` ${plan.unit}` : ''}` : plan.price
  const yearly = plan.yearly ? ` or ${plan.yearly.price} ${plan.yearly.unit}` : ''
  const feats = plan.features.map((f) => f.replace('{extra}', plan.extra ? `${plan.extra.monthly} (${plan.extra.yearly})` : ''))
  return `- ${plan.name === 'Enterprise' ? plan.name : `Trina Cloud ${plan.name}`}: ${price}${yearly}. ${plan.kind}. ${feats.join('; ')}.`
}

function pricingLines(t: Copy) {
  const p = t.pricing
  return [
    ...p.plans.map(plainPlan),
    `- ${p.self.name}: ${p.self.price} ${p.self.unit}. ${p.self.body}`,
    `- ${p.sub} ${p.usdNote} ${CLOUD_LIVE ? p.trialNote : p.earlyNote}`,
  ]
}

const links = (t: Copy) => [
  `- [Home](${abs('/')}): product, pricing and FAQ`,
  `- [Pricing](${abs('/#pricing')}): Free, Team, Business, Enterprise and free self-hosting`,
  `- [Trina Cloud console](${LINKS.signUp()}): request early access; existing teams sign in at ${LINKS.signIn}`,
  `- [Security](${abs('/security')}): ${t.securityPage.description}`,
  `- [Trina Drive vs Google Drive](${abs('/compare/google-drive')}): ${t.compareGd.description}`,
  `- [Source code on GitHub](${LINKS.github}): Apache-2.0`,
  `- [Self-hosting guide](${LINKS.installGuide})`,
  `- [Security model](${LINKS.securityModel}): the full technical guarantees and limits`,
]

export function llmsTxt(t: Copy): string {
  return [
    '# Trina Drive',
    '',
    `> ${t.meta.long}`,
    '',
    `Trina Drive is an AI knowledge base for teams: a shared team drive whose files each person's AI app (Claude, ChatGPT, Codex, Cursor or any MCP client) can search and read through MCP, with that person's permissions. Made by Trina Inc. Hosted on Trina Cloud (one isolated instance per team, hosted in the US), or self-hosted for free from the open-source code (Apache-2.0).`,
    '',
    '## Key facts',
    '',
    ...t.product.items.map((i) => `- ${i.title.replace(/\.$/, '')}${i.beta ? ' (beta)' : ''}: ${i.body}`),
    `- Works with: ${t.clients.any.join(', ')}. ${t.clients.rollout}`,
    `- ${t.security.limitsTitle}: ${t.security.limits.join(' ')}`,
    '',
    '## Pricing (USD)',
    '',
    ...pricingLines(t),
    '',
    '## Links',
    '',
    ...links(t),
    `- [Full text for LLMs](${abs('/llms-full.txt')})`,
    '',
    '## Contact',
    '',
    `- ${CONTACT_EMAIL} (sales and support), ${t.securityPage.reportEmail} (vulnerabilities)`,
    '',
  ].join('\n')
}

export function llmsFullTxt(t: Copy): string {
  const sp = t.securityPage
  const nl = (s: string) => s.replace(/\n/g, ' ')
  return [
    '# Trina Drive — full summary',
    '',
    `> ${t.meta.long}`,
    '',
    `${t.hero.title} ${t.hero.titleAccent} ${t.hero.sub}`,
    '',
    `## ${nl(t.product.title)}`,
    '',
    ...t.product.items.map((i) => `- ${i.title.replace(/\.$/, '')}${i.beta ? ' (beta)' : ''}: ${i.body}${i.chips ? ` (${i.chips.join(', ')})` : ''}`),
    '',
    `## Works with`,
    '',
    `${t.clients.any.join(', ')}. ${t.clients.rollout} ${t.clients.trademarks}`,
    '',
    `## ${nl(t.how.title)}`,
    '',
    ...t.how.steps.map((s, i) => `${i + 1}. ${s.title}: ${s.body}`),
    '',
    `## Trina Cloud: ${nl(t.cloud.title)}`,
    '',
    ...t.cloud.items.map((i) => `- ${i.title}: ${i.body}`),
    `- ${t.cloud.note} ${t.cloud.region}`,
    '',
    `## ${nl(t.openSource.title)}`,
    '',
    t.openSource.sub,
    ...t.openSource.points.map((p) => `- ${p}`),
    `- Repository: ${LINKS.github} (${t.openSource.license}, ${t.openSource.lang})`,
    `- Docker: ${t.openSource.cmds.join(' && ')}`,
    `- ${t.openSource.dev} \`${t.openSource.devCmd}\``,
    '',
    '## Pricing (USD)',
    '',
    ...pricingLines(t),
    '',
    `## Security: ${sp.h1}`,
    '',
    sp.lead,
    '',
    `### ${sp.guaranteesTitle}`,
    '',
    ...sp.guarantees.map((g, i) => `${i + 1}. ${g.title} ${g.why}`),
    '',
    `### ${sp.promiseTitle}`,
    '',
    ...t.security.promise,
    '',
    `### ${sp.limitsTitle}`,
    '',
    ...sp.limits.map((l) => `- ${l}`),
    '',
    `### ${sp.boundaryTitle}`,
    '',
    ...sp.boundary.map((b) => `- ${b.title}: ${b.body}`),
    '',
    `### ${sp.reviewTitle}`,
    '',
    ...sp.review.map((b) => `- ${b.title}: ${b.body}`),
    '',
    '## FAQ',
    '',
    ...t.faq.items.flatMap((i) => [`### ${i.q}`, '', `${i.a}${i.link ? ` ${i.link.text}: ${abs(i.link.href)}` : ''}`, '']),
    '## Links',
    '',
    ...links(t),
    '',
    '## Company',
    '',
    `Trina Inc. ${CONTACT_EMAIL}. Security reports: ${sp.reportEmail}.`,
    '',
  ].join('\n')
}
