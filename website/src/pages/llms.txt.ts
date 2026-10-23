// /llms.txt (https://llmstxt.org): what Trina Drive is, pricing, security and links, for AI search and assistants.
// Built from the page copy (src/content/en.ts) so it always matches the site.
import type { APIRoute } from 'astro'
import en from '../content/en-b'
import { llmsTxt } from '../seo'

export const GET: APIRoute = () => new Response(llmsTxt(en), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
