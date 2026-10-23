// The little XML WebDAV needs: a strict, small parser for request bodies (PROPFIND, PROPPATCH, LOCK; ≤ 64 KB) with
// namespaces resolved, and escaping for the answers. No DTDs, no entities beyond the five predefined and character
// references: a body with <!DOCTYPE or <!ENTITY is refused (no entity expansion of any kind).
export interface XNode { ns: string; local: string; children: XNode[]; text: string; /** the element's source text (LOCK owner is echoed back) */ raw: string }

export class XmlError extends Error {}

const NAME = /^[A-Za-z_][\w.\-]*(?::[A-Za-z_][\w.\-]*)?/
const decode = (s: string) => s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (_m, e: string) =>
  e === 'lt' ? '<' : e === 'gt' ? '>' : e === 'amp' ? '&' : e === 'quot' ? '"' : e === 'apos' ? "'"
    : String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)))

export function parseXml(src: string): XNode {
  if (/<!DOCTYPE|<!ENTITY/i.test(src)) throw new XmlError('DTDs are not accepted')
  let i = 0
  const s = src.replace(/^﻿/, '')
  const stack: { node: XNode; ns: Map<string, string>; start: number }[] = []
  let root: XNode | null = null
  const resolve = (qname: string, ns: Map<string, string>, isAttr = false) => {
    const c = qname.indexOf(':')
    const prefix = c >= 0 ? qname.slice(0, c) : ''
    const local = c >= 0 ? qname.slice(c + 1) : qname
    if (isAttr && !prefix) return { ns: '', local }
    const uri = ns.get(prefix)
    if (uri === undefined && prefix) throw new XmlError(`unknown namespace prefix ${prefix}`)
    return { ns: uri ?? '', local }
  }
  while (i < s.length) {
    const lt = s.indexOf('<', i)
    const text = lt < 0 ? s.slice(i) : s.slice(i, lt)
    if (stack.length) stack[stack.length - 1]!.node.text += decode(text)
    else if (text.trim()) throw new XmlError('text outside the root element')
    if (lt < 0) break
    i = lt
    if (s.startsWith('<?', i)) { const e = s.indexOf('?>', i); if (e < 0) throw new XmlError('unclosed processing instruction'); i = e + 2; continue }
    if (s.startsWith('<!--', i)) { const e = s.indexOf('-->', i); if (e < 0) throw new XmlError('unclosed comment'); i = e + 3; continue }
    if (s.startsWith('<![CDATA[', i)) {
      const e = s.indexOf(']]>', i); if (e < 0 || !stack.length) throw new XmlError('bad CDATA')
      stack[stack.length - 1]!.node.text += s.slice(i + 9, e); i = e + 3; continue
    }
    if (s.startsWith('</', i)) {
      const m = NAME.exec(s.slice(i + 2)); const top = stack.pop()
      if (!m || !top) throw new XmlError('unexpected closing tag')
      const end = s.indexOf('>', i); if (end < 0) throw new XmlError('unclosed tag')
      const r = resolve(m[0], top.ns)
      if (r.ns !== top.node.ns || r.local !== top.node.local) throw new XmlError('mismatched closing tag')
      top.node.raw = s.slice(top.start, end + 1)
      i = end + 1
      if (!stack.length) { root = top.node; if (s.slice(i).replace(/<!--[\s\S]*?-->/g, '').trim()) throw new XmlError('content after the root element') ; break }
      continue
    }
    const m = NAME.exec(s.slice(i + 1))
    if (!m) throw new XmlError('bad tag')
    let j = i + 1 + m[0].length
    const attrs: [string, string][] = []
    for (;;) {
      while (/\s/.test(s[j] ?? '')) j++
      if (s[j] === '>' || s.startsWith('/>', j)) break
      const a = NAME.exec(s.slice(j)); if (!a) throw new XmlError('bad attribute')
      j += a[0].length
      while (/\s/.test(s[j] ?? '')) j++
      if (s[j] !== '=') throw new XmlError('bad attribute')
      j++
      while (/\s/.test(s[j] ?? '')) j++
      const q = s[j]; if (q !== '"' && q !== "'") throw new XmlError('bad attribute value')
      const e = s.indexOf(q, j + 1); if (e < 0) throw new XmlError('unclosed attribute value')
      attrs.push([a[0], decode(s.slice(j + 1, e))]); j = e + 1
    }
    const parentNs = stack.length ? stack[stack.length - 1]!.ns : new Map<string, string>()
    const ns = new Map(parentNs)
    for (const [k, v] of attrs) { if (k === 'xmlns') ns.set('', v); else if (k.startsWith('xmlns:')) ns.set(k.slice(6), v) }
    const r = resolve(m[0], ns)
    const node: XNode = { ns: r.ns, local: r.local, children: [], text: '', raw: '' }
    if (stack.length) stack[stack.length - 1]!.node.children.push(node)
    else if (root) throw new XmlError('two root elements')
    if (stack.length > 64) throw new XmlError('nested too deep')
    if (s.startsWith('/>', j)) {
      node.raw = s.slice(i, j + 2); i = j + 2
      if (!stack.length) { root = node; break }
      continue
    }
    stack.push({ node, ns, start: i })
    i = j + 1
  }
  if (stack.length || !root) throw new XmlError('incomplete document')
  return root
}

export const DAV = 'DAV:'
export const kids = (n: XNode, local: string, ns = DAV) => n.children.filter((c) => c.ns === ns && c.local === local)
export const kid = (n: XNode, local: string, ns = DAV) => kids(n, local, ns)[0]

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** An element for any namespace in an answer (the namespace declared on the element itself when it is not DAV:). */
export function el(ns: string, local: string, inner = ''): string {
  if (ns === DAV) return inner ? `<d:${local}>${inner}</d:${local}>` : `<d:${local}/>`
  const attr = ns ? ` xmlns:x="${esc(ns)}"` : ' xmlns=""'
  const tag = ns ? `x:${local}` : local
  return inner ? `<${tag}${attr}>${inner}</${tag}>` : `<${tag}${attr}/>`
}

export const XML_HEAD = '<?xml version="1.0" encoding="utf-8"?>\n'
