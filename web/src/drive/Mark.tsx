// The Star Pillar mark (brand/mark.svg), inline so it follows the theme: sides in var(--logo-ink), top in var(--logo-top).
import { useId } from 'react'

export function Mark({ size = 24, className }: { size?: number; className?: string }) {
  const id = useId().replace(/:/g, '')
  const top = 'M16 19.028L11.497 13.85L2.528 11.25L11.497 8.65L16 3.472L20.503 8.65L29.472 11.25L20.503 13.85Z'
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <defs>
        <mask id={`m${id}`} maskUnits="userSpaceOnUse" x="-8" y="-8" width="48" height="48">
          <rect x="-8" y="-8" width="48" height="48" fill="#fff" />
          <path d={top} fill="#000" stroke="#000" strokeWidth="3" strokeLinejoin="round" />
          <path d="M16 19.028L16 29.528" stroke="#000" strokeWidth="1.65" />
        </mask>
      </defs>
      <g fill="var(--logo-ink)" stroke="var(--logo-ink)" strokeWidth="0.25" strokeLinejoin="round" mask={`url(#m${id})`}>
        <path d="M29.472 11.25L20.503 13.85L20.503 23.35L29.472 20.75Z" />
        <path d="M11.497 13.85L2.528 11.25L2.528 20.75L11.497 23.35Z" />
        <path d="M16 19.028L11.497 13.85L11.497 23.35L16 28.528Z" />
        <path d="M20.503 13.85L16 19.028L16 28.528L20.503 23.35Z" />
      </g>
      <path d={top} fill="var(--logo-top)" />
    </svg>
  )
}
