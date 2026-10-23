import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import en from '../src/content/en'
import enB from '../src/content/en-b'
import { PAGES, faqPage, homeJsonLd, llmsFullTxt, llmsTxt, offers, sitemapXml, usd } from '../src/seo'

const root = join(import.meta.dir, '..')

describe('titles and descriptions', () => {
  const pages: [string, string, string][] = [
    ['home', enB.meta.title, enB.meta.description],
    ['/a', en.meta.title, en.meta.description],
    ['security', en.securityPage.title, en.securityPage.description],
    ['compare', en.compareGd.title, en.compareGd.description],
    ...(['terms', 'privacy', 'refund'] as const).map((p): [string, string, string] => [p, `${en.legal[p].title} — Trina Drive`, en.legal[p].description]),
  ]
  test.each(pages)('%s: title ≤ 60, description ≤ 155', (_, title, description) => {
    expect(title.length).toBeLessThanOrEqual(60)
    expect(description.length).toBeGreaterThan(50)
    expect(description.length).toBeLessThanOrEqual(155)
  })
  test('indexable titles are unique', () => {
    const titles = pages.filter(([p]) => p !== '/a').map(([, t]) => t)
    expect(new Set(titles).size).toBe(titles.length)
  })
})

describe('structured data', () => {
  test('one offer per price the pricing section shows, in USD, same numbers', () => {
    const shown = en.pricing.plans.flatMap((p) => (p.price.startsWith('$') ? [p.price, ...(p.yearly ? [p.yearly.price] : [])] : []))
    const list = offers(en) as { price: string; priceCurrency: string }[]
    expect(list.map((o) => o.price)).toEqual([...shown.map(usd), usd(en.pricing.self.price)])
    expect(list.map((o) => o.price)).toEqual(['0', '99', '990', '349', '3490', '0'])
    for (const o of list) expect(o.priceCurrency).toBe('USD')
  })

  test('FAQPage questions and answers are the visible FAQ text', () => {
    const faq = faqPage(en)
    expect(faq.mainEntity.length).toBe(en.faq.items.length)
    faq.mainEntity.forEach((q, i) => {
      const item = en.faq.items[i]
      expect(q.name).toBe(item.q)
      const visible = q.acceptedAnswer.text.replace(/<[^>]+>/g, '')
      expect(visible).toBe(item.link ? `${item.a} ${item.link.text}` : item.a)
    })
  })

  test('home graph is valid JSON with the expected types and the GitHub sameAs', () => {
    const g = JSON.parse(JSON.stringify(homeJsonLd(en)))
    expect(g['@context']).toBe('https://schema.org')
    const types = g['@graph'].map((n: { '@type': string }) => n['@type'])
    expect(types).toEqual(['Organization', 'WebSite', 'SoftwareApplication', 'SoftwareSourceCode', 'FAQPage'])
    expect(g['@graph'][0].name).toBe('Trina Inc.')
    expect(g['@graph'][0].sameAs).toContain('https://github.com/potenlab/trina-drive')
    expect(g['@graph'][2].applicationCategory).toBe('BusinessApplication')
  })
})

describe('crawling', () => {
  test('sitemap lists the indexable pages only', () => {
    const xml = sitemapXml()
    for (const p of PAGES) expect(xml).toContain(`<loc>https://drive.trina.app${p.path}</loc>`)
    for (const p of ['/a', '/b', '/thanks', '/404', '/api']) expect(xml).not.toContain(`trina.app${p}<`)
    expect(xml).not.toMatch(/trina\.app\/[^<]+\/<\/loc>/) // no trailing slashes
  })

  test('robots.txt allows AI search bots, hides /api and names the sitemap', () => {
    const robots = readFileSync(join(root, 'public/robots.txt'), 'utf8')
    for (const bot of ['GPTBot', 'OAI-SearchBot', 'ClaudeBot', 'Claude-SearchBot', 'PerplexityBot', 'Google-Extended']) {
      expect(robots).toContain(`User-agent: ${bot}`)
    }
    expect(robots).not.toMatch(/Disallow: \/\s*$/m)
    expect(robots).toContain('Disallow: /api/')
    expect(robots).toContain('Sitemap: https://drive.trina.app/sitemap.xml')
  })

  test('llms.txt and llms-full.txt carry every price and the key links', () => {
    for (const txt of [llmsTxt(en), llmsFullTxt(en)]) {
      for (const p of en.pricing.plans) {
        expect(txt).toContain(p.price)
        if (p.yearly) expect(txt).toContain(p.yearly.price)
      }
      expect(txt).toContain('https://github.com/potenlab/trina-drive')
      expect(txt).toContain('https://drive.trina.app/security')
      expect(txt).not.toMatch(/\{extra\}|undefined/)
    }
    expect(llmsFullTxt(en)).toContain(en.security.promise[0])
  })

  test('vercel.json and public/_headers set the same cache rules', () => {
    const vercel = readFileSync(join(root, 'vercel.json'), 'utf8')
    const headers = readFileSync(join(root, 'public/_headers'), 'utf8')
    for (const v of [...vercel.matchAll(/"Cache-Control", "value": "([^"]+)"/g)].map((m) => m[1])) expect(headers).toContain(`Cache-Control: ${v}`)
  })
})
