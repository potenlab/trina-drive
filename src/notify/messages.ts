// Channel text. R11: a payload is built from the event kind, a count and a link, nothing else — the render functions
// cannot see names because they are never given them.
import { PRODUCT } from '../config'

/** The armor around a signed audit anchor in mail: -----BEGIN TRINA DRIVE AUDIT ANCHOR----- */
export const ANCHOR_LABEL = `${PRODUCT.toUpperCase()} AUDIT ANCHOR`
import type { EventKind, SignedAnchor } from './events'

export type Lang = 'en' | 'ko'
export type Level = 'detail' | 'count'

const LINES: Record<EventKind, Record<Lang, (n: number) => string>> = {
  widened_draft: { en: (n) => `${n} widened draft${n === 1 ? '' : 's'} to review`, ko: (n) => `넓어진 초안 ${n}건 확인 필요` },
  original_write_attempt: { en: (n) => `${n} attempt${n === 1 ? '' : 's'} to write originals (refused)`, ko: (n) => `원본 쓰기 시도 ${n}건 (거부됨)` },
  bulk_read: { en: (n) => `${n} bulk-read alert${n === 1 ? '' : 's'}`, ko: (n) => `대량 읽기 경보 ${n}건` },
  quarantine: { en: (n) => `${n} folder${n === 1 ? '' : 's'} quarantined`, ko: (n) => `격리된 폴더 ${n}건` },
  new_client: { en: (n) => `${n} new client${n === 1 ? '' : 's'} used your access token`, ko: (n) => `액세스 토큰에 새 클라이언트 연결 ${n}건` },
  admin_self_grant: { en: (n) => `${n} admin self-grant${n === 1 ? '' : 's'}`, ko: (n) => `관리자 자기 부여 ${n}건` },
  password_reset: { en: (n) => `${n} password reset${n === 1 ? '' : 's'} on your account; your tokens and sessions were ended`, ko: (n) => `계정 비밀번호 재설정 ${n}건, 토큰과 세션이 끊겼습니다` },
  token_revoked: { en: (n) => `${n} access token${n === 1 ? '' : 's'} revoked`, ko: (n) => `액세스 토큰 ${n}개가 끊겼습니다` },
  audit_anchor: { en: (n) => `Audit anchor: ${n} rows`, ko: (n) => `감사 기준점: ${n}행` },
  provenance_reset: { en: (n) => `${n} provenance reset${n === 1 ? '' : 's'} on an access token`, ko: (n) => `액세스 토큰 출처 초기화 ${n}건` },
  approval_pending: { en: (n) => `${n} promote request${n === 1 ? '' : 's'} pending approval`, ko: (n) => `반영 승인 대기 ${n}건` },
  approval_decided: { en: (n) => `${n} of your promote requests ${n === 1 ? 'was' : 'were'} decided`, ko: (n) => `반영 요청 결과 ${n}건` },
}
const DIGEST: Record<Lang, string> = { en: 'Daily summary: ', ko: '하루 요약: ' }
const FOOT: Record<Lang, string> = { en: 'Details after sign-in:', ko: '로그인 뒤 상세 보기:' }

/** The only thing a channel ever carries (plus, for audit_anchor email, the signed anchor itself). */
export interface Payload { kind: EventKind; count: number; link: string; subject: string; text: string }

export function render(kind: EventKind, count: number, link: string, lang: Lang, digest = false): Payload {
  const line = (digest ? DIGEST[lang] : '') + LINES[kind][lang](count)
  return { kind, count, link, subject: `[${PRODUCT}] ${line}`, text: `[${PRODUCT}] ${line}\n${FOOT[lang]} ${link}` }
}

/** Links carry only the kind (an enum) — never ids that could be guessed into names, never names. */
export function linkFor(baseUrl: string, kind: EventKind, level: Level): string {
  const base = baseUrl.replace(/\/+$/, '')
  // the approval inbox decides per person what they see (R8: detail for eligible approvers, a count for other managers)
  if (kind === 'approval_pending' || kind === 'approval_decided') return `${base}/#/approvals`
  return level === 'detail' ? `${base}/alerts/${kind}` : `${base}/inbox`
}

/** The audit anchor block appended to anchor emails: hash, count, time, key fingerprint, signature (no names). */
export function anchorBlock(a: SignedAnchor): string {
  return `\n\n-----BEGIN ${ANCHOR_LABEL}-----\n${JSON.stringify(a)}\n-----END ${ANCHOR_LABEL}-----\n`
}
