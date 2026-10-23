# Third-party logos: sources and terms

The SVGs in this folder are the companies' own files, copied byte-for-byte from their official brand pages
(downloaded 2026-10-23). They are self-hosted (no hotlinking, CSP stays `'self'`) and must not be edited: no recoloring,
no cropping, no changes to the viewBox or proportions. Trademarks belong to their owners; Trina Drive is not affiliated
with or endorsed by them. The site says so next to the logos.

| File | Mark | Source | SHA-256 |
| --- | --- | --- | --- |
| `openai-blossom-black.svg` | OpenAI Blossom, black (light backgrounds) | `OpenAI-logos/SVGs/OAI_OpenAI-Blossom_Black.svg` in https://cdn.openai.com/brand/openai-logos.zip, linked as "Download logos" on https://openai.com/brand/ | `75c1e9fffa5e8c437bec1d67197a73992bca45d166c6ff23215185dea8fae92a` |
| `openai-blossom-white.svg` | OpenAI Blossom, white (dark backgrounds) | `OpenAI-logos/SVGs/OAI_OpenAI-Blossom_White.svg` in the same zip | `01d158767c4eec0e47bd617e67759c33da0accd1438be1a8d29dfdb99ce87285` |
| `cursor-cube-2d-light.svg` | Cursor cube, 2D, light-theme version (dark fill `#26251e`) | `General Logos/Cube/SVG/CUBE_2D_LIGHT.svg` in https://ptht05hbb1ssoooe.public.blob.vercel-storage.com/assets/brand/cursor-brand-assets.zip, linked as "Download brand assets" on https://cursor.com/brand | `c483c02f78eb2619778fdd959e72a9adfac4844854472cd2653d4cbfd60e4d71` |
| `cursor-cube-2d-dark.svg` | Cursor cube, 2D, dark-theme version (light fill `#edecec`) | `General Logos/Cube/SVG/CUBE_2D_DARK.svg` in the same zip | `cd0e3e5d8991a4cdd4577f8896cd063105207665165c73e25a1ff918dd367eb7` |

## Where they are used

`src/content/brands.ts` maps a product name to a mark; `src/components/ClientMark.astro` draws it. ChatGPT, Codex,
Codex app and Codex CLI use the OpenAI Blossom (OpenAI's brand kit has no separate ChatGPT or Codex mark), Cursor uses
the Cursor cube. The product name is always written next to the mark as text.

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
