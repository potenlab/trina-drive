// Team slugs: the first label of https://<slug>.<domain>. One DNS label, lower-case letters, digits and single
// hyphens, 3–32 characters, not a reserved name. Unique forever: a deleted team's slug is not handed to someone else
// (old OAuth connections and bookmarks must never reach a different company).
export const RESERVED = new Set([
  'www', 'api', 'app', 'admin', 'administrator', 'root', 'console', 'control', 'cloud', 'dashboard', 'billing', 'pay',
  'paddle', 'mail', 'email', 'smtp', 'imap', 'pop', 'mx', 'ns', 'ns1', 'ns2', 'dns', 'status', 'help', 'support', 'docs',
  'blog', 'static', 'assets', 'cdn', 'auth', 'login', 'signup', 'oauth', 'sso', 'id', 'account', 'accounts', 'security',
  'drive', 'trina', 'team', 'teams', 'test', 'demo', 'internal', 'localhost', 'host', 'hosts', 'mcp', 'well-known',
  'webhook', 'webhooks', 'health', 'metrics', 'caddy', 'proxy', 'edge', 'vpn', 'git', 'ssh', 'ftp', 'abuse', 'postmaster',
])

export function slugProblem(slug: string): string | null {
  if (slug.length < 3 || slug.length > 32) return 'between 3 and 32 characters'
  if (!/^[a-z0-9](?:[a-z0-9]|-(?!-))*[a-z0-9]$/.test(slug)) return 'lower-case letters, digits and single hyphens, starting and ending with a letter or digit'
  if (/^xn--/.test(slug)) return 'not an internationalized (xn--) name'
  if (RESERVED.has(slug)) return 'that name is reserved'
  return null
}

/** A suggestion from a company name ("Acme Co." → "acme-co"). */
export const suggestSlug = (name: string) =>
  name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '')
