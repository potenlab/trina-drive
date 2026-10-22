// How the server turns an original's bytes into text: always in an isolated worker (plan 6 "추출·셸 작업자는 모두
// 격리한다"), never in the server process. A zip bomb, a parser loop or a huge allocation then only kills a sandboxed
// process with a deadline and an RSS cap; other tokens' commands keep running. The worker gets the bytes the server read
// with its own no-follow checks (R1 ⑤ ⑦), so it has no file access at all; a PDF's worker may also run pdftotext.
// <PREFIX>_EXTRACT=inprocess runs the parsers in this process instead (development and tests only).
import { ENV_PREFIX, LIMITS } from '../config'
import { ext } from '../names'
import { extractExecutor, extractIsolated, type Executor } from '../worker'
import { ExtractError, extractText, TOOLS } from './index'

/** Text cannot be had right now (no isolation, queue full, worker did not start): not a property of the document, never cached. */
export class ExtractUnavailable extends ExtractError {}

/** Whose work this is, for the executor's fair admission (per token / per person). */
export interface ExtractWho { token: string; person: string }
/** The reconciler's background indexing. */
export const INDEX_WHO: ExtractWho = { token: '@index', person: '@index' }

export function extractMode(): 'isolated' | 'inprocess' {
  return process.env[`${ENV_PREFIX}_EXTRACT`] === 'inprocess' ? 'inprocess' : 'isolated'
}

const prefix = (m: string) => m.startsWith('cannot extract text') ? m : `cannot extract text: ${m}`

/**
 * Text of one document. Throws ExtractError when the document cannot be turned into text (the mirror records that), or
 * ExtractUnavailable when extraction cannot run now (refused without isolation, too many waiting, worker did not start).
 */
export async function extractDocument(name: string, bytes: Uint8Array, who: ExtractWho, opts: { executor?: Executor } = {}): Promise<string> {
  if (!opts.executor && extractMode() === 'inprocess') return extractText(name, bytes)
  const kind = ext(name) || 'txt'
  const pdftotext = kind === 'pdf' ? TOOLS.pdftotext : null
  if (kind === 'pdf' && !pdftotext) throw new ExtractError('cannot extract text: pdftotext is not installed on the server')
  const r = await extractIsolated(bytes, kind, {
    executor: opts.executor ?? extractExecutor(), token: who.token, person: who.person,
    timeoutMs: LIMITS.extractMs, maxRssBytes: LIMITS.extractRssBytes,
    // only a PDF's worker may start pdftotext (a fresh worker with that one exec grant)
    ...(pdftotext ? { execPaths: [pdftotext], options: { pdftotext } } : {}),
  })
  switch (r.status) {
    case 'ok': return r.text ?? ''
    case 'error': throw new ExtractError(prefix(String(r.error ?? 'the extractor failed').slice(0, 300)))
    case 'timeout': throw new ExtractError(`cannot extract text: the document took too long to read (over ${Math.round(LIMITS.extractMs / 1000)} s) and was stopped`)
    case 'memory': throw new ExtractError(`cannot extract text: reading the document needed too much memory (over ${LIMITS.extractRssBytes >> 20} MB) and was stopped`)
    case 'output': throw new ExtractError('cannot extract text: the document produced too much text')
    case 'crashed':
      if (!r.run.stats.pid) throw new ExtractUnavailable('cannot extract text right now: the extraction worker did not start; try again shortly')
      throw new ExtractError('cannot extract text: the extractor crashed on this document')
    case 'refused': throw new ExtractUnavailable('cannot extract text: the server has no isolated executor available (documents are only parsed in a sandbox)')
    case 'busy': throw new ExtractUnavailable('cannot extract text right now: too many documents are waiting to be read; try again shortly')
    default: throw new ExtractUnavailable(`cannot extract text right now (${r.status})`)
  }
}
