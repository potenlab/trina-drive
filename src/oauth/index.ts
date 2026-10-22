// The OAuth 2.1 authorization server for claude.ai and ChatGPT custom connectors (plan 5.2). See http.ts for the
// endpoints, tokens.ts for the token model, clients.ts + ssrf.ts for client metadata documents, consent.ts for the
// person's decision, and docs/CONNECT-CLAUDE-AI.md / docs/CONNECT-CHATGPT.md.
import type { DB } from '../db'
import type { McpOAuth } from '../mcp'
import type { OAuthRuntime } from './config'
import { ACCESS_PREFIX, verifyAccessToken } from './tokens'

export { makeOAuthRuntime, type OAuthOptions, type OAuthRuntime } from './config'
export { handleOAuth, isOAuthPath } from './http'
export { handleConsentApi } from './consent'

/** What /mcp needs to accept this server's access tokens. */
export const mcpOAuth = (rt: OAuthRuntime, db: DB): McpOAuth => ({
  prefix: ACCESS_PREFIX, resourceMetadataUrl: rt.prmUrl, verify: (raw, client) => verifyAccessToken(rt, db, raw, client),
})
