# Connect ChatGPT

ChatGPT reaches MCP servers from OpenAI's cloud, so Trina Drive must be reachable at its **public address** (the separate
public listener behind a Cloudflare tunnel). The server side is the same as for claude.ai: do sections 1.1–1.3 of
[CONNECT-CLAUDE-AI.md](CONNECT-CLAUDE-AI.md) first (exposure checklist, `tdrive public enable`, the tunnel).

> **Menu names, plan rules and ChatGPT's OAuth behaviour change often.** Everything about ChatGPT's screens below was
> written in 2026-10 from OpenAI's developer docs and is marked *(verify at release)*.

## 1. Admin

### 1.1 Trina Drive side

```sh
tdrive public status        # gate passes; CIMD clients from: claude.ai, chatgpt.com
```

`chatgpt.com` is on the default client trust list. ChatGPT identifies itself with a client metadata document at
`https://chatgpt.com/oauth/client.json` (or `https://chatgpt.com/oauth/<callback id>/client.json`) and redirects to
`https://chatgpt.com/connector_platform_oauth_redirect` — the stable address it uses when the authorization server
advertises RFC 9207 issuer identification, which Trina Drive does (`authorization_response_iss_parameter_supported: true`).
Trina Drive accepts whatever redirect URIs ChatGPT's own document lists, so a per-connector `…/connector/oauth/<id>` callback
works too. Dynamic registration is not needed; leave it off unless ChatGPT is set to use it (`--allow-dcr`).

### 1.2 ChatGPT side *(verify at release)*

- Plan: custom MCP connectors with **write** actions need **Business / Enterprise / Edu**, and a workspace admin must turn
  on **developer mode** (*Workspace settings → Apps / Connectors → Advanced → Developer mode*). Plus/Pro developer mode
  and its read/write limits: check at release (plan 7.3 lists them as "?"). Trina Drive only needs read; drafts are writes.
- Create the connector (app): *Settings → Apps & Connectors → Create* (in some versions *Connectors → Add custom
  connector*). Name `Trina Drive`; MCP server URL `https://files.example.com/mcp`; Authentication **OAuth**; if asked how the
  client registers, choose the **client metadata document (CIMD)** option; leave client ID/secret empty.
- Publish it to the workspace (Business/Enterprise) so members see it, or keep it personal for a test.

## 2. Member *(verify at release)*

1. In ChatGPT open the connector (*Apps & Connectors → Trina Drive → Connect*, or the prompt from a chat that uses it).
2. Sign in to Trina Drive in the window that opens. The consent page shows **chatgpt.com** as the app address, where the answer
   goes, the folders to grant (read-only by default) and how long the connection lasts. Click **Allow**.
3. In a chat, enable Trina Drive for that conversation (developer mode chats show its tools) and ask.

To stop: Trina Drive web → **My tokens** → **OAuth · chatgpt.com** → **Revoke** (cuts it at the next request), and remove the
connection in ChatGPT.

## 3. Public exposure checklist (short form)

Same list as [CONNECT-CLAUDE-AI.md §1.1](CONNECT-CLAUDE-AI.md#11-before-you-start--the-public-exposure-checklist):
v0.2 security gate passed · every admin has a second factor (checked live by the gate) · fixed
public host name on Cloudflare · the tunnel points at the public listener (8788), never the LAN port · "No AI" set on
folders that must not reach OpenAI · `--trusted-proxy` set · people know where to revoke. What ChatGPT reads goes to
OpenAI (plan 7.2).

## 4. Notes on ChatGPT's OAuth client (from OpenAI's docs, 2026-10; not tested against a live ChatGPT)

- It requires `code_challenge_methods_supported` with `S256` (Trina Drive: `["S256"]`) and sends `resource` in the
  authorization and token requests (Trina Drive binds tokens to `<url>/mcp` and refuses others).
- Its CIMD document supports `none` and `private_key_jwt`; it picks from what the server advertises. Trina Drive advertises
  only `none` (public client + PKCE). A request that still carries a client secret or assertion is refused.
- Advertised OIDC scopes (`openid`, `email` …) would be requested by default; Trina Drive advertises none of them, only
  `files:read`, `drafts:write` and `offline_access`.
- Workspace domain restrictions in ChatGPT need `openid`/`email` and a UserInfo endpoint — not supported by Trina Drive (it is
  not an OpenID provider); do not turn that restriction on for this connector.
- ChatGPT can present an OpenAI client certificate (mTLS) — Trina Drive does not check it; Cloudflare could, as an extra layer.
- How ChatGPT handles refresh-token rotation is not documented; Trina Drive rotates on every refresh and allows a 10 s grace for
  two refreshes racing, after which a reused refresh token revokes the connection.
