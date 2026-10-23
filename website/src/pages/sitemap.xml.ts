// /sitemap.xml, from the indexable page list in src/seo.ts (A/B variants, /thanks, 404 and /api are left out).
import type { APIRoute } from 'astro'
import { sitemapXml } from '../seo'

export const GET: APIRoute = () => new Response(sitemapXml(), { headers: { 'Content-Type': 'application/xml; charset=utf-8' } })
