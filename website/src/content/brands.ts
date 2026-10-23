// Which mark to draw next to a supported AI app's name. Only official, unmodified files from the companies' brand
// pages (public/logos/, sources and terms in LOGO-SOURCES.md). Anthropic's trademark guidelines require prior approval for any
// use of its marks, so Claude products get a neutral generic icon (not the Claude mark) until Anthropic approves.
export interface BrandLogo {
  /** For light backgrounds / for dark backgrounds (the brand's own light and dark versions). */
  light: string
  dark: string
  /** viewBox aspect (width / height) of the file. */
  aspect: number
  /** The file already carries the brand's clear space inside its viewBox: draw the whole box at slot size. */
  padded: boolean
}

export const LOGOS = {
  openai: { light: '/logos/openai-blossom-black.svg', dark: '/logos/openai-blossom-white.svg', aspect: 1, padded: true },
  cursor: { light: '/logos/cursor-cube-2d-light.svg', dark: '/logos/cursor-cube-2d-dark.svg', aspect: 466.73 / 532.09, padded: false },
  zed: { light: '/logos/zed-logomark-black.svg', dark: '/logos/zed-logomark-white.svg', aspect: 1, padded: false },
  cline: { light: '/logos/cline-bot-light.svg', dark: '/logos/cline-bot-dark.svg', aspect: 1, padded: false },
  // One full-colour app icon (gradient tile) reads on both themes; the brand page says to pick the best-contrast variant.
  lmstudio: { light: '/logos/lmstudio-icon-color.svg', dark: '/logos/lmstudio-icon-color.svg', aspect: 1, padded: false },
} satisfies Record<string, BrandLogo>

export type Mark = { kind: 'logo'; brand: keyof typeof LOGOS } | { kind: 'icon'; icon: string } | { kind: 'none' }

/** Names shown as plain text, with no mark at all: the brand's guideline doesn't let us use its logo (or we haven't
 *  cleared it). Matched on the start of the lower-cased name. Reasons per brand: LOGO-SOURCES.md. */
export const TEXT_ONLY = ['grok', 'gemini', 'devin', 'windsurf', 'vs code', 'visual studio', 'github copilot', 'goose']

export function markFor(name: string): Mark {
  const n = name.toLowerCase()
  if (TEXT_ONLY.some((p) => n.startsWith(p))) return { kind: 'none' }
  if (n.includes('chatgpt') || n.includes('codex')) return { kind: 'logo', brand: 'openai' }
  if (n.includes('cursor')) return { kind: 'logo', brand: 'cursor' }
  if (n.startsWith('zed')) return { kind: 'logo', brand: 'zed' }
  if (n.startsWith('cline')) return { kind: 'logo', brand: 'cline' }
  if (n.startsWith('lm studio')) return { kind: 'logo', brand: 'lmstudio' }
  if (n.includes('code') || n.includes('cli')) return { kind: 'icon', icon: 'shell' }
  return { kind: 'icon', icon: 'chat' }
}
