# Third-party logos: sources and terms

The SVGs in `public/logos/` are the companies' own files, copied byte-for-byte from their official brand pages
(downloaded 2026-10-23). They are self-hosted (no hotlinking, CSP stays `'self'`) and must not be edited: no recoloring,
no cropping, no changes to the viewBox or proportions. Trademarks belong to their owners; Trina Drive is not affiliated
with or endorsed by them. The site says so next to the logos.

| File | Mark | Source | SHA-256 |
| --- | --- | --- | --- |
| `openai-blossom-black.svg` | OpenAI Blossom, black (light backgrounds) | `OpenAI-logos/SVGs/OAI_OpenAI-Blossom_Black.svg` in https://cdn.openai.com/brand/openai-logos.zip, linked as "Download logos" on https://openai.com/brand/ | `75c1e9fffa5e8c437bec1d67197a73992bca45d166c6ff23215185dea8fae92a` |
| `openai-blossom-white.svg` | OpenAI Blossom, white (dark backgrounds) | `OpenAI-logos/SVGs/OAI_OpenAI-Blossom_White.svg` in the same zip | `01d158767c4eec0e47bd617e67759c33da0accd1438be1a8d29dfdb99ce87285` |
| `cursor-cube-2d-light.svg` | Cursor cube, 2D, light-theme version (dark fill `#26251e`) | `General Logos/Cube/SVG/CUBE_2D_LIGHT.svg` in https://ptht05hbb1ssoooe.public.blob.vercel-storage.com/assets/brand/cursor-brand-assets.zip, linked as "Download brand assets" on https://cursor.com/brand | `c483c02f78eb2619778fdd959e72a9adfac4844854472cd2653d4cbfd60e4d71` |
| `cursor-cube-2d-dark.svg` | Cursor cube, 2D, dark-theme version (light fill `#edecec`) | `General Logos/Cube/SVG/CUBE_2D_DARK.svg` in the same zip | `cd0e3e5d8991a4cdd4577f8896cd063105207665165c73e25a1ff918dd367eb7` |
| `zed-logomark-black.svg` | Zed logomark, full black (light backgrounds) | "SVG" button for the black logomark on https://zed.dev/brand (the page builds the file from the SVG markup in its own script; saved byte-for-byte, downloaded 2026-10-23) | `4cda36dfb35fef877595ebde187a26923194533acb25310f53c26d53fb0bf4d2` |
| `zed-logomark-white.svg` | Zed logomark, full white (dark backgrounds) | same, white logomark | `d2b75c63e8f18cfb24b4d8efa2f4531b5b3f5622ab0c1a6791b7a45b4cd5b021` |
| `cline-bot-light.svg` | Cline bot icon, LIGHT export (for light backgrounds, fill `#282524`) | `cline-brand-assets/General Logos/Bot/SVG/BOT_LIGHT.svg` in https://cline.bot/assets/branding/brand/cline-brand-assets.zip, linked from https://cline.bot/brand (downloaded 2026-10-23) | `267e6a8fdc37e3ad3ebedf843584ad1b6b0fe62cde28cfa4c5702006184970bb` |
| `cline-bot-dark.svg` | Cline bot icon, DARK export (for dark backgrounds, fill `#FDFCFC`) | `cline-brand-assets/General Logos/Bot/SVG/BOT_DARK.svg` in the same zip | `33a7e760026d2be27a27d6a360111c59014ff88cb50637899a68ccfe8eed131d` |
| `lmstudio-icon-color.svg` | LM Studio app icon, colour (gradient tile; used on light and dark) | `LM Studio Icon Color.svg` in https://lmstudio.ai/assets/marketing/brand/download/logos/lm-studio-logos.zip, linked from https://lmstudio.ai/brand (downloaded 2026-10-23) | `18950f44a1ba87eb6de782ed6c7691de21c1bfebf0000c7c896240aed104ffef` |

## Where they are used

`src/content/brands.ts` maps a product name to a mark; `src/components/ClientMark.astro` draws it. ChatGPT, Codex,
Codex app and Codex CLI use the OpenAI Blossom (OpenAI's brand kit has no separate ChatGPT or Codex mark), Cursor uses
the Cursor cube, Zed its logomark, Cline its bot icon, LM Studio its app icon. The product name is always written next
to the mark as text. `test/brands.test.ts` checks every file listed in `brands.ts` against the SHA-256 in this table.

## The "Works with any AI that speaks MCP" marquee (checked 2026-10-23)

Trina Drive is a remote MCP server (streamable HTTP + OAuth), so the list is every AI client whose official docs say
it can add a remote MCP server by URL. `src/content/en.ts` → `clients.any`, drawn by `src/components/Marquee.astro`
on / and /a (credibility band) and /b (band under the hero).

| Item | Remote MCP support (official docs) | Mark |
| --- | --- | --- |
| Claude Code | `claude mcp add --transport http` (also local stdio) | neutral terminal icon (Anthropic: approval needed) |
| Claude (claude.ai, desktop, mobile) | custom connectors = remote MCP by URL; our OAuth flow ships in v0.2 | neutral chat icon (Anthropic: approval needed) |
| Codex | Codex app, CLI and IDE extension: streamable HTTP servers with OAuth (learn.chatgpt.com/docs/extend/mcp) | OpenAI Blossom |
| ChatGPT | remote MCP only, as a custom connector / app in developer mode on eligible plans; v0.2 | OpenAI Blossom |
| Cursor | `mcp.json` with `url` (remote) or `command` (local) | Cursor cube |
| Grok | grok.com/connectors → New Connector → Custom (public URL only); also the xAI API "Remote MCP Tools" (streamable HTTP, SSE) | text only, see below |
| Gemini CLI | `httpUrl` (streamable HTTP) / `url` (SSE) / stdio. Note: Google moved individual users to Antigravity CLI on 2026-06-18; Gemini CLI stays for Code Assist Standard/Enterprise and API-key users | text only (Google: approval needed) |
| Devin Desktop (Windsurf) | Cascade/Devin MCP config `serverUrl` (streamable HTTP, SSE) or stdio. Windsurf was renamed Devin Desktop in June 2026; windsurf.com now redirects to devin.ai/desktop | text only, see below |
| VS Code + Copilot | Copilot agent mode, `mcp.json` server `type: "http"` (remote) or stdio | text only (Microsoft / GitHub) |
| Zed | Settings → AI → MCP Servers → Add Remote Server (`url`, MCP OAuth) | Zed logomark |
| Cline | remote servers (`streamableHttp`, SSE) and stdio | Cline bot icon |
| goose | remote extensions over streamable HTTP, and stdio | text only (Linux Foundation: written permission) |
| LM Studio | MCP host since 0.3.17; `mcp.json` entries with `url` (remote) or `command` (local) | LM Studio icon |

None of the listed products had to be dropped: all of them can connect to a remote MCP server today.

## Zed (https://zed.dev/brand)

"The Zed logo and wordmark can be used in three colors: brand blue, full white, and full black." "You may not use the
Zed name or logos in any way that could mistakenly imply any official connection with or endorsement of Zed
Industries, Inc." Customer-confusing use and merchandise (without written consent) are not allowed. How we comply:
full black on light, full white on dark, unmodified files, no implied endorsement, non-affiliation note next to them.

## Cline (https://cline.bot/brand)

The brand page offers the kit ("Download official Cline brand assets") and says "Use the horizontal lockup where
possible. Vertical lockups, bot icons, and wordmarks are also included." It publishes no further usage terms; the kit's
README says "LIGHT/DARK export names indicate the intended background". The Apache-2.0 code license does not grant
trademark rights. Treated like Cursor: unmodified official bot icon, LIGHT export on light and DARK on dark, name
written next to it ("Cline"). We use the bot icon because a marquee row needs a square mark; the kit includes it.

## LM Studio (https://lmstudio.ai/brand)

"We grant permission to use our Marks subject to the following conditions: Any use of our Marks must conform to the
brand guidelines set out on this page." "Use LM Studio logo when referring to LM Studio, our products, or
partnerships." "Don't imply sponsorship, endorsement, or a formal partnership without approval." No recoloring,
stretching, cropping or effects; leave clear space; choose "the color, monochrome, or outline variant that gives the
best contrast". How we comply: the official colour app icon (a self-contained tile, readable on both themes) at the
same size as the other marks, with space around it.

## Text only (no logo) and why

- **Grok (xAI / SpaceXAI)**: https://x.ai/legal/brand-guidelines allows accurate reference with logos used "exactly as
  provided at the download link", but the current kit (https://data.x.ai/logos/SpaceXAI_Grok_Assets.zip) is behind a
  Cloudflare check we could not pass from a script, and the company has rebranded since the older xAI kit. Until
  someone downloads the current kit by hand and records it here, Grok is text only.
- **Gemini CLI (Google)**: Google Brand Features need approval: "To use Google logos or products in your work, click
  here to submit a request" (https://partnermarketinghub.withgoogle.com/brands/google/trademarks-and-terms/terms-and-conditions/).
- **VS Code + GitHub Copilot**: https://code.visualstudio.com/brand: "Not OK Using the icon to identify or promote your
  own product, service, application"; GitHub (https://brand.github.com/foundations/logo): "Do not use GitHub
  trademarks, logos, or artwork without GitHub's prior written permission", and Copilot has no standalone logo since 2025.
- **Devin Desktop (Windsurf)**: windsurf.com/brand still offers Windsurf symbols, but the product was renamed and
  windsurf.com redirects to devin.ai/desktop; https://devin.ai/brand offers only Devin and Cognition marks with no
  usage terms and no Devin Desktop mark. Text only rather than an outdated or unlicensed mark.
- **goose**: a Series of LF Projects, LLC; https://lfprojects.org/policies/trademark-policy/: "Do not use a logo of LF
  Projects on posters, brochures, signs, websites, or other marketing materials to promote your events, products or
  services without written permission from LF Projects." Text "compatible with goose" is fine. Requests:
  trademarks@lfprojects.org.

## OpenAI (https://openai.com/brand/)

Terms that apply to us (quoted or closely paraphrased from the page, checked 2026-10-23):

- "By using our logos, you agree to our Marks usage terms." Permission is limited: only use the Marks in line with the
  brand guidelines; non-exclusive, non-transferable; "Do not feature our Marks more prominently than your own company's
  name or marks"; OpenAI may update the guide (we must follow within a reasonable time), review our use and require
  changes, and terminate permission at any time ("usage must stop promptly").
- Do: "Use the logo only when it directly relates to OpenAI services" (we show it only next to ChatGPT/Codex, the
  OpenAI products Trina Drive connects to); use the logo exactly as provided and acknowledge it belongs to OpenAI.
- Don't: use the logo without permission or outside OpenAI's terms; misrepresent the relationship, imply endorsement or
  confuse users about sponsorship; use it more prominently than our own or in unrelated contexts; put it on
  merchandise; modify it; incorporate it into our branding.
- Blossom: "DON'T add any colors to the Blossom", "DON'T use the Blossom as the primary branding", "DON'T add any
  unauthorized elements", "DON'T use the Blossom over a busy image", "DO use the established spacing rules", "DO use
  the Blossom with lots of open space". The official SVG carries its clear space inside its 716×716 viewBox (the mark
  is about half the box); we always render the whole box and never crop or overlap it.
- Language: we are not an official partner, so never write "collaborated with", "worked with" or "partnered with"
  OpenAI. Our copy only says Trina Drive connects to / works in ChatGPT and Codex.
- Contact for permission requests or anything beyond these cases: partnercomms@openai.com.

How we comply: black Blossom on light backgrounds, white Blossom on dark (both official files, no other colors, no
opacity or filter effects), no hover recoloring, never larger than the Trina Drive logo, a non-affiliation note next to
the logos.

## Cursor (https://cursor.com/brand)

The brand page offers the kit for download ("Resources to represent Cursor consistently and accurately"): logos in 2D
(default) and 2.5D, as horizontal lockup (preferred), vertical lockup, or separately as cube or wordmark, each in light
and dark versions. Its only written rule: "Refer to us as Cursor. Not Cursor AI or Cursor Code." It states no clear
space, color or permission terms; we treat it like the others: unmodified official files, light version on light
backgrounds and dark version on dark, reasonable space around the cube, name written "Cursor".

## Anthropic / Claude: not used

https://www.anthropic.com/legal/trademark-guidelines: "You may only use our trademarks as specifically permitted by us
and only in materials we approve beforehand." Anthropic supplies the images itself, "No alterations of our trademarks
(changes to color, font, proportion, or otherwise) are permitted", and no use that implies sponsorship, endorsement or
affiliation. Requests go to marketing@anthropic.com. There is no public logo kit and we have no approval, so Claude,
Claude Code and claude.ai are shown as text only, with a neutral generic icon (terminal or chat bubble) that is not
the Claude mark. Add the Claude mark only after Anthropic approves the use and supplies the files.
