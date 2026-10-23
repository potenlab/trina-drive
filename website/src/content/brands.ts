// Which mark to draw next to a supported AI app's name. Only official, unmodified files from the companies' brand
// pages (public/logos/, see public/logos/SOURCES.md). Anthropic's trademark guidelines require prior approval for any
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
} satisfies Record<string, BrandLogo>

export type Mark = { kind: 'logo'; brand: keyof typeof LOGOS } | { kind: 'icon'; icon: string }

export function markFor(name: string): Mark {
  const n = name.toLowerCase()
  if (n.includes('chatgpt') || n.includes('codex')) return { kind: 'logo', brand: 'openai' }
  if (n.includes('cursor')) return { kind: 'logo', brand: 'cursor' }
  if (n.includes('code') || n.includes('cli')) return { kind: 'icon', icon: 'shell' }
  return { kind: 'icon', icon: 'chat' }
}
