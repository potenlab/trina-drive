// File-type pictures for lists and grids, as in a drive: a folder, or a page with a coloured band for its kind
// (pdf, doc, sheet, slides, image, archive, audio, video, code, text). Colours are fixed per kind (like the apps'
// own), readable on both themes.
const COLOR: Record<string, string> = {
  pdf: '#d93025', doc: '#2f6fde', sheet: '#1e8e3e', slides: '#e8710a', image: '#9334e6', archive: '#80868b',
  audio: '#d01884', video: '#c5221f', code: '#127c73', text: '#5f6368', other: '#5f6368',
}

export function FileGlyph({ type, size = 22 }: { type: string; size?: number }) {
  if (type === 'folder') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" className="glyph glyph-folder">
        <path d="M2.5 6.5A1.5 1.5 0 0 1 4 5h5.2l2 2H20a1.5 1.5 0 0 1 1.5 1.5v9.5A1.5 1.5 0 0 1 20 19.5H4A1.5 1.5 0 0 1 2.5 18z" fill="currentColor" />
      </svg>
    )
  }
  const c = COLOR[type] ?? COLOR.other
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" className="glyph">
      <path d="M6 2.5h8.5L19.5 7.5V20a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 20V4A1.5 1.5 0 0 1 6 2.5z" fill={c} />
      <path d="M14.5 2.5V6a1.5 1.5 0 0 0 1.5 1.5h3.5z" fill="#fff" fillOpacity=".45" />
      <rect x="7.5" y="12" width="9" height="1.6" rx=".8" fill="#fff" fillOpacity=".9" />
      <rect x="7.5" y="15.4" width="6" height="1.6" rx=".8" fill="#fff" fillOpacity=".9" />
    </svg>
  )
}
