# Landing redesign v2 — visual references (2026-10-23)

Five YC-backed companies with strong landing pages, picked from eleven candidates (Supabase, PostHog, Resend,
Trigger.dev, Mintlify, Infisical, Greptile, Vapi, Browser Use, Firecrawl, Pylon). YC batch checked on
ycombinator.com/companies/&lt;slug&gt; on 2026-10-23. Each page was fetched with curl (HTML/CSS) and captured with headless
Chromium at 1440×900 (fold + full page). We take patterns, not assets, and we make no YC claim ourselves.

Screenshots: `/private/tmp/claude-501/-Users-dion-dea/a01281aa-b40b-4035-b3ca-2a0f5b472d61/scratchpad/refs/<name>-fold.jpg`
and `…/refs/<name>-full.jpg` (scratchpad, not committed).

| # | Site | YC | What we borrowed | Where it shows up |
|---|---|---|---|---|
| 1 | [supabase.com](https://supabase.com) | S20 | Two-tone hero line (plain + accent colour); feature **bento** where every card carries a small, real-looking UI fragment (auth list, `functions deploy` pill, globe); calm white surfaces, hairline borders, one green accent | Split H1 with gradient accent; bento cards with mini-UIs (`Bento.astro`) |
| 2 | [mintlify.com](https://www.mintlify.com) | W22 | A **product window** placed just under the hero copy, cropped at the fold so the page invites scrolling; soft generated line-art / light behind it; mint→teal→lime gradient as the brand highlight; product stats in mono | Hero "stage": Files-view mock + terminal on a glass plate with a glow; mint→teal→sky gradient token `--accent-grad` |
| 3 | [infisical.com](https://infisical.com) | W23 | Security product told through **stacked product panels** (secrets table + permissions popover) instead of illustrations; a full-bleed **dark section** with a flow diagram ("Agents shouldn't see your secrets": agent → proxy → vault) | "Who can see finance" panel in the mock; always-dark Promises & limits panel; animated MCP flow diagram (`Flow.astro`) |
| 4 | [firecrawl.dev](https://www.firecrawl.dev) | S22 | Centred hero over a **hairline grid** with corner markers; "It's also open source" placed as a quiet line, not a badge; install/command element right under the CTAs | Masked 64px grid over the hero key visual; install command pill under the CTAs; pill "Open-source release coming soon" |
| 5 | [resend.com](https://resend.com) | W23 | One **3D key visual** (glass/metal object, rim light) on near-black; large, tight display type; restrained dark CTA band | Higgsfield glass-folder key visuals (hero light/dark), glass vault in the security panel, light-streak image behind the final CTA |

Also looked at: Trigger.dev (W23, "copy setup prompt" CTA, logo/category tabs), Vapi (W21, full-bleed blurred photo
hero), Pylon (W23, motion-blur gradient band), Browser Use (W25, illustrated hero card), Greptile (W24, technical
frame lines), PostHog (W20). Not used: Warp's YC entry is a different company (employee management), Dub and Cal.com
have no YC company page.

## Patterns applied

- **Hero:** centred, big tight headline (Geist 600, −0.048em) with the second half in the accent gradient; one-line
  subline; two CTAs; install command; product stage below the fold line (Mintlify/Firecrawl).
- **Background:** generated glass-folder key visual (light and dark variants) + masked hairline grid + radial glow.
  Dark sections (security, final CTA) use their own images so both themes look intentional.
- **Product UI as proof:** HTML/CSS mocks, not screenshots — the Files view, the retrieval terminal, and mini-UIs in
  every card. They stay crisp, follow the theme and cost no image bytes.
- **Type & colour:** self-hosted Geist / Geist Mono (OFL); near-white / near-black surfaces; one accent family.
- **Rhythm:** 120px sections alternating white and tint; eyebrow chip → H2 → cards.
- **Honesty blocks:** promises next to limits (Infisical/Tailscale style), a dedicated `/security` page.

## Assets generated (Higgsfield)

| File (public/img) | Model | Prompt gist | Credits |
|---|---|---|---|
| `hero-light-{960,2400}.{avif,webp}` | nano_banana_pro 21:9 2k | frosted-glass folder panels, mint/teal light, airy off-white | 2 |
| `hero-dark-{960,2400}.{avif,webp}` | nano_banana_pro 21:9 2k | same, near-black with mint glow | 2 |
| `vault-{560,1120}.{avif,webp}` | gpt_image_2_5 4:3 2k high | glass folder with metal keyhole, rim light | 2.75 |
| `streaks-{960,2000}.{avif,webp}` | nano_banana_pro 21:9 2k | long-exposure mint light ribbons on black | 2 |

Four generations, ≈8.75 credits. All images together are ≈350 KB on disk; a page load fetches one hero variant
(≈17–57 KB AVIF) plus the two lazy section images.
