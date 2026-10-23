// A unified line diff for the approval screen (what changed between the approved skill and the pending one). Plain
// LCS on the part between the common head and tail; very large changes are shown as a whole replacement.
const CONTEXT = 3
const MAX_CELLS = 4_000_000

type Op = { k: ' ' | '-' | '+'; line: string; a: number; b: number }

function ops(a: string[], b: string[]): Op[] {
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  const A = a.slice(head, a.length - tail), B = b.slice(head, b.length - tail)
  const out: Op[] = []
  for (let i = 0; i < head; i++) out.push({ k: ' ', line: a[i]!, a: i, b: i })
  if (A.length * B.length > MAX_CELLS) {
    A.forEach((l, i) => out.push({ k: '-', line: l, a: head + i, b: head }))
    B.forEach((l, j) => out.push({ k: '+', line: l, a: head + A.length, b: head + j }))
  } else {
    const n = A.length, m = B.length
    const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i]![j] = A[i] === B[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!)
    let i = 0, j = 0
    while (i < n || j < m) {
      if (i < n && j < m && A[i] === B[j]) { out.push({ k: ' ', line: A[i]!, a: head + i, b: head + j }); i++; j++ }
      else if (i < n && (j === m || L[i + 1]![j]! >= L[i]![j + 1]!)) { out.push({ k: '-', line: A[i]!, a: head + i, b: head + j }); i++ }
      else { out.push({ k: '+', line: B[j]!, a: head + i, b: head + j }); j++ }
    }
  }
  for (let t = 0; t < tail; t++) out.push({ k: ' ', line: a[a.length - tail + t]!, a: a.length - tail + t, b: b.length - tail + t })
  return out
}

const lines = (t: string) => { const l = t.split('\n'); if (l.at(-1) === '') l.pop(); return l }

/** `--- a` / `+++ b` and hunks with 3 lines of context; '' when the texts are equal. */
export function unifiedDiff(before: string, after: string, labelA: string, labelB: string): string {
  const all = ops(lines(before), lines(after))
  if (!all.some((o) => o.k !== ' ')) return ''
  const out = [`--- ${labelA}`, `+++ ${labelB}`]
  let i = 0
  while (i < all.length) {
    if (all[i]!.k === ' ') { i++; continue }
    let start = Math.max(0, i - CONTEXT), end = i
    // extend the hunk while changes are within 2*CONTEXT of each other
    for (;;) {
      while (end < all.length && all[end]!.k !== ' ') end++
      let next = end
      while (next < all.length && all[next]!.k === ' ' && next - end < 2 * CONTEXT) next++
      if (next < all.length && all[next]!.k !== ' ') { end = next; continue }
      break
    }
    const stop = Math.min(all.length, end + CONTEXT)
    const h = all.slice(start, stop)
    const aLen = h.filter((o) => o.k !== '+').length, bLen = h.filter((o) => o.k !== '-').length
    const aStart = h[0]!.a + (aLen ? 1 : 0), bStart = h[0]!.b + (bLen ? 1 : 0)
    out.push(`@@ -${aStart},${aLen} +${bStart},${bLen} @@`)
    for (const o of h) out.push(o.k + o.line)
    i = stop
    start = stop
  }
  return out.join('\n')
}
