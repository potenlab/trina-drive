# Connect claude.ai (and Claude Desktop, mobile, Claude Code over OAuth)

claude.ai talks to MCP servers **from Anthropic's cloud**, so it cannot reach a server that only listens on the office
LAN. Trina Drive therefore has a second, **public listener** that you put behind a Cloudflare tunnel. It serves only what
claude.ai and a person approving it need; the admin screens stay on the LAN address.

> **Menu names and plan rules change.** Every claude.ai menu path below was written in 2026-10 from Anthropic's docs and
> is marked *(verify at release)*. Check them against the live product before you publish these steps.

What you get: each person signs in to Trina Drive once from claude.ai, picks which folders the connection may read (read-only
by default) and for how long, and from then on Claude reads team files **as that person, narrowed by that choice** — the
same rules as a personal access token (plan 4.1). The connection shows up under **My tokens** and can be cut at once.

---

## 1. Admin: open the public address (once)

### 1.1 Before you start — the public exposure checklist

Do not open the public address until every line holds (plan 10 "v0.2 보안 관문", 7.1 "공개 노출"):

- [ ] You run a release that passed the **v0.2 security gate**: permission matrix including OAuth and the tunnel, CIMD SSRF and
      consent-screen tests, external review (2–3 days), `SECURITY.md` and a private advisory channel.
- [ ] **Every admin has a second factor** (passkey or authenticator app: web *Settings → Second factor*; `tdrive mfa status`).
      The gate checks this live and refuses to start the listener otherwise. Passkeys are bound to the public host name
      (their RP ID), so admins add their passkey on `https://files.example.com` once it is up (an authenticator app works
      before that).
- [ ] You own a domain on Cloudflare and will give Trina Drive its own host name (e.g. `files.example.com`). The address is
      fixed: OAuth tokens are bound to `https://<that host>/mcp`, so changing it later disconnects everyone.
- [ ] The tunnel points at the **public listener port (default 8788)**, never at the LAN port (8787).
- [ ] Folders that must never reach an AI company are marked **"No AI"**; people know that what Claude reads goes to Anthropic
      (plan 7.2). Team/Enterprise plans are recommended until the personal-plan terms are checked (plan 7.3).
- [ ] Sign-in passwords are strong; the sign-in page is now on the internet (rate limits: 5 failures per name and 50 attempts
      per address per 15 minutes — per real client address only with `--trusted-proxy`, below).
- [ ] You know where to revoke: **My tokens** (a person's own connections), and a password reset by an admin cuts all of a
      person's tokens and connections.

### 1.2 Configure Trina Drive

```sh
tdrive public enable --url https://files.example.com \
  --port 8788 --host 127.0.0.1 --trusted-proxy 127.0.0.1 \
  --confirm-security-gate --gate-version v0.2.0
tdrive public status          # every required line must be [x]
tdrive serve                  # prints "public listener: http://127.0.0.1:8788/ for the tunnel → https://files.example.com"
```

| option | meaning |
|---|---|
| `--url` | the public HTTPS origin (no path). OAuth issuer = this URL; MCP resource = `<url>/mcp` |
| `--port`, `--host` | where the public listener listens (keep it on loopback; the tunnel connector runs on this machine) |
| `--trusted-proxy` | the tunnel connector's address. Only from this peer are `CF-Connecting-IP` / `X-Forwarded-For` believed, so sign-in limits count real clients |
| `--client-host H` | also accept client metadata documents from host H (default: `claude.ai`, `chatgpt.com`); `--any-client` accepts any https host; `--default-clients` resets |
| `--allow-dcr` / `--no-dcr` | dynamic client registration (RFC 7591). Off by default: claude.ai and ChatGPT use client metadata documents; open registration lets anyone register a look-alike app |
| `public disable` | stop serving the public listener at the next restart (connections stay until revoked) |

If the gate does not pass, `serve` says which line is missing and starts only the LAN listener. `serve` uses the public
address as `--public-url` too (passkey RP ID, links in mails) unless you pass another one.

Besides AI connections, the public address serves the **approval inbox** and each person's **passkeys** (approvals need a
passkey, and passkeys work only on this https host): `#/approvals`, `#/second-factor`. Everything else — folders, people,
tokens, files, drafts, audit, TOTP setup — stays on the office address.

### 1.3 Run the Cloudflare tunnel (doc only — Trina Drive never runs cloudflared)

A named tunnel (quick `trycloudflare.com` tunnels change address and drop; the address must stay fixed):

```sh
brew install cloudflared
cloudflared tunnel login                              # pick the zone of files.example.com
cloudflared tunnel create trina-drive                        # prints the tunnel UUID and writes ~/.cloudflared/<UUID>.json
cloudflared tunnel route dns trina-drive files.example.com
```

`~/.cloudflared/config.yml`:

```yaml
tunnel: <UUID>
credentials-file: /Users/<you>/.cloudflared/<UUID>.json
ingress:
  - hostname: files.example.com
    service: http://127.0.0.1:8788      # the PUBLIC listener, not 8787
  - service: http_status:404
```

```sh
cloudflared tunnel run trina-drive          # or: sudo cloudflared service install (runs at boot)
```

Check from outside the office:

```sh
curl -s https://files.example.com/.well-known/oauth-protected-resource/mcp     # resource = https://files.example.com/mcp
curl -s https://files.example.com/.well-known/oauth-authorization-server        # S256, "none", client_id_metadata_document_supported
curl -si -X POST https://files.example.com/mcp -H 'content-type: application/json' -d '{}' | grep -i www-authenticate
#   WWW-Authenticate: Bearer realm="trina-drive", resource_metadata="https://files.example.com/.well-known/oauth-protected-resource/mcp"
curl -s -o /dev/null -w '%{http_code}\n' https://files.example.com/api/people   # 404: the admin API is not public
```

Optional: Cloudflare Access may wrap the **browser** pages (`/`, `/assets/*`, `/api/*`, `/oauth/authorize`) — never
`/mcp`, `/oauth/token`, `/oauth/revoke` or `/.well-known/*`, which claude.ai calls from its servers. Anthropic's traffic
comes from `160.79.104.0/21` *(verify at release)*.

### 1.4 Add the connector in claude.ai *(verify at release)*

- **Team / Enterprise**: an **Owner** adds it once for the organization: *Admin settings → Connectors → Add custom
  connector* (in some versions *Customize → Connectors → Add custom connector*). Name: `Trina Drive` (or your product name).
  URL: `https://files.example.com/mcp` — exactly this, with `/mcp`. Leave the advanced OAuth client ID / secret empty:
  Claude identifies itself with its own client metadata document (CIMD) because Trina Drive advertises
  `client_id_metadata_document_supported` and `none`.
- **Pro / Max (personal)**: each person adds it themselves under *Customize → Connectors → Add custom connector*. Check
  the personal-plan terms first (plan 7.3).

---

## 2. Member: connect and approve *(verify menu names at release)*

1. In claude.ai open *Customize → Connectors* (or *Settings → Connectors*), find **Trina Drive**, click **Connect**.
2. A window opens on `https://files.example.com`. Sign in with your Trina Drive name (or mail address) and password.
3. The consent page shows:
   - the **app address** in large type (`claude.ai`) — the host the app's details were fetched from over HTTPS. A name can
     be faked; this cannot. An app that registered itself (only possible if your admin turned on dynamic registration) is
     marked *not verified*;
   - where the answer goes (`claude.ai`), with a warning if it goes to a program on your own computer;
   - **Folders**: pick the folders this connection may read (admins must pick; others may also choose "everything my AI may
     read"). Folders marked "No AI" stay closed whatever you pick;
   - **Read only (recommended)** is ticked. Untick it only if Claude should also write drafts to `/drafts` (originals are never
     changed; the app must have asked for it);
   - **Connection ends after** 1, 7, 30 (default) or 90 days.
4. Click **Allow**. The window returns to claude.ai and the connector shows as connected. In a chat, turn the connector on in
   the tools menu if it is not already, then ask, e.g. "Trina Drive에서 2026년 견적 찾아 줘".

To stop: Trina Drive web → **My tokens** → the row marked **OAuth · claude.ai** → **Revoke**. The next request from Claude fails
and claude.ai asks you to connect again. Disconnecting in claude.ai alone may leave the grant alive until it expires —
revoke it in Trina Drive too.

---

## 3. Claude Code over OAuth (instead of a personal access token)

Claude Code uses the same flow with its own metadata document (`https://claude.ai/oauth/claude-code-client-metadata`) and
a loopback redirect on a random port, which Trina Drive matches without the port (RFC 8252):

```sh
claude mcp add --transport http --scope user trina-drive https://files.example.com/mcp
claude    # then /mcp → trina-drive → Authenticate: the browser opens the consent page
```

The consent page warns that the answer goes to a program on this computer — expected for Claude Code. PATs
(`tdrive mcp add claude`, [CONNECT-CLIENTS.md](CONNECT-CLIENTS.md)) keep working for the LAN address and automation.

---

## 4. What happens underneath

| step | endpoint | notes |
|---|---|---|
| Claude calls `/mcp` without a token | `POST /mcp` → **401** `WWW-Authenticate: Bearer realm="trina-drive", resource_metadata="…/.well-known/oauth-protected-resource/mcp"` | RFC 9728 §5.1; no error code when no token was sent |
| discovery | `GET /.well-known/oauth-protected-resource/mcp` (also at the root), `GET /.well-known/oauth-authorization-server` | `resource = <url>/mcp`, one authorization server (itself) |
| authorize | `GET /oauth/authorize?client_id=<CIMD URL>&redirect_uri=…&code_challenge=…&code_challenge_method=S256&resource=<url>/mcp&state=…` | fetches the client's metadata document (SSRF-guarded), checks the redirect URI, then sends the browser to `/#/oauth/<request>` |
| consent | `GET/POST /api/oauth/requests/<id>[/approve\|/deny]` | needs the web session + CSRF; back to `redirect_uri?code=…&state=…&iss=<url>` (RFC 9207) |
| token | `POST /oauth/token` (form) `grant_type=authorization_code` + `code_verifier` | access token (1 h) + refresh token |
| refresh | `POST /oauth/token` `grant_type=refresh_token` | rotation: a new refresh token each time; an old one used again (after a 10 s grace for racing refreshes) revokes the whole connection |
| revoke | `POST /oauth/revoke` (RFC 7009), or **My tokens** on the web | next request fails |

Tokens are opaque (`tdrive_oat_…`, `tdrive_ort_…`), stored as sha256 only, and bound to `<url>/mcp` (RFC 8707): a token
issued for another address is refused. The connection is a row in the same token table as a PAT (kind `oauth`), so the
permission function, provenance windows, drafts, audit and "No AI" apply unchanged.

## 5. Troubleshooting

| symptom | check |
|---|---|
| claude.ai: "Couldn't reach the MCP server" | `tdrive public status` passes; `cloudflared` is running and points at 8788; the three `curl` checks in 1.3 work from outside |
| page "This app cannot connect: clients from X are not allowed" | the app's metadata host is not trusted. If it is genuinely Anthropic's, add it: `tdrive public enable --client-host X` |
| page "The redirect address is not one the app registered" | the app's metadata document does not list that redirect URI; usually an outdated or look-alike client |
| "This connection request is used or expired" | requests last 10 minutes and are decided once; start again from claude.ai |
| works, then asks to reconnect | the connection expired (its expiry), was revoked, the person was deactivated or reset, or the public URL changed |
| sign-in "too many attempts" for everyone at once | set `--trusted-proxy 127.0.0.1` so limits count the real client, not the tunnel |

## 6. What was verified, and what was not

Verified against the published specs (2026-10-23): MCP authorization 2025-11-25 and 2026-07-28 (PRM, AS metadata, PKCE
S256, CIMD preferred, DCR deprecated, RFC 8707 resource, RFC 9207 `iss`, refresh rotation for public clients) and
Anthropic's connector authentication page (401 + `resource_metadata`, first `authorization_servers` entry only, CIMD only
when `client_id_metadata_document_supported` and `none` are both advertised, callback
`https://claude.ai/api/mcp/auth_callback`, Claude Code's CIMD and port-agnostic loopback, form-encoded token requests,
`invalid_grant` on dead refresh tokens, 10 s / 30 s endpoint limits). The official MCP TypeScript SDK client runs the full
flow against Trina Drive in `test/oauth-sdk.test.ts`.

Not verified (no live claude.ai connection was made from this build): the exact menu paths above, the URL of the hosted
claude.ai apps' own metadata document (assumed to be on `claude.ai`; if not, the error page names the host to add),
and whether disconnecting in claude.ai calls the revocation endpoint.
