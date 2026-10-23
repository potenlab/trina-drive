// /llms-full.txt: the whole site's facts in one plain-text file (product, pricing, security promise and limits, FAQ).
import type { APIRoute } from 'astro'
import en from '../content/en-b'
import { llmsFullTxt } from '../seo'

export const GET: APIRoute = () => new Response(llmsFullTxt(en), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
