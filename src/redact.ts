// Secrets an agent (or a person) pastes into a command line or a tool argument must not be kept in the audit log in
// clear text (plan 7.1 "토큰 유출"). The audit keeps the redacted line plus the sha256 of the whole original line, so
// the row still proves what was run without storing the secret.
//
// Our own tokens keep their stored hint (prefix + 4 characters, the same as `tokens.hint`) so an admin can tell which
// token leaked; everything else is replaced by a marker naming the kind of secret.
import { SECRET_TAG, TOKEN_PREFIX } from './config'

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const R = (kind: string) => `[REDACTED:${kind}]`

/** Rules applied in order; each is a global regex and a replacement. */
const RULES: [RegExp, string | ((...m: string[]) => string)][] = [
  // PEM private keys (an unterminated block is redacted to the end)
  [/-----BEGIN ([A-Z0-9 ]*)PRIVATE KEY( BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----|$)/g, R('private-key')],
  // our personal access tokens: keep the hint (as stored in tokens.hint)
  [new RegExp(`${esc(TOKEN_PREFIX)}([A-Za-z0-9_-]{4})[A-Za-z0-9_-]+`, 'g'), (_m, hint) => `${TOKEN_PREFIX}${hint}…${R('token')}`],
  // our other secrets (web setup token, …): <name>_<kind>_<random>
  [new RegExp(`\\b${esc(SECRET_TAG)}_(setup|[a-z]+)_[A-Za-z0-9_-]{12,}`, 'g'), (_m, kind) => `${SECRET_TAG}_${kind}_${R('token')}`],
  // Authorization headers and bare Bearer/Basic credentials
  [/\b(authorization\s*[:=]\s*["']?)(?:(bearer|basic|token|digest)\s+)?[^\s"',;]{6,}/gi, (_m, head, scheme) => `${head}${scheme ? scheme + ' ' : ''}${R('credential')}`],
  [/\b(bearer|basic)(\s+)(?!\[REDACTED)[A-Za-z0-9._~+/=-]{12,}/gi, (_m, scheme, sp) => `${scheme}${sp}${R('credential')}`],
  // GitHub
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, R('github-token')],
  [/\bgithub_pat_[A-Za-z0-9_]{22,}\b/g, R('github-token')],
  // Slack tokens and incoming webhooks
  [/\bxox[abposre]-[A-Za-z0-9-]{10,}/g, R('slack-token')],
  [/\bxapp-[0-9]-[A-Za-z0-9-]{10,}/g, R('slack-token')],
  [/https:\/\/hooks\.slack\.com\/(services|workflows|triggers)\/[A-Za-z0-9/_-]+/g, R('slack-webhook')],
  // AWS access key ids and secret keys (by their usual names)
  [/\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ABIA|ACCA)[A-Z0-9]{16}\b/g, R('aws-key-id')],
  [/\b(aws_secret_access_key|secret_access_key|aws_session_token|secretaccesskey)(["']?\s*[:=]\s*["']?|\s+)[A-Za-z0-9/+=]{16,}/gi, (_m, k, sep) => `${k}${sep}${R('aws-secret')}`],
  // other common API keys
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g, R('api-key')],
  [/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g, R('api-key')],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, R('api-key')],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, R('gitlab-token')],
  [/\bnpm_[A-Za-z0-9]{36}\b/g, R('npm-token')],
  // JSON Web Tokens
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, R('jwt')],
  // passwords in URLs: scheme://user:password@host
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, (_m, head) => `${head}${R('password')}@`],
  // key = value assignments with a secret-sounding key (env files, curl -d, CLI flags)
  [/\b((?:[A-Za-z0-9]+[_-])*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)\b["']?\s*[:=]\s*["']?)(?!\[REDACTED)[^\s"'&;]{6,}/gi,
    (_m, head) => `${head}${R('secret')}`],
  [/(--(?:password|passwd|token|api-key|secret|client-secret)[= ])(?!\[REDACTED)[^\s"']{6,}/gi, (_m, head) => `${head}${R('secret')}`],
]

/** The text with every recognised secret replaced. Idempotent. */
export function redactSecrets(text: string): string {
  let out = text
  for (const [re, rep] of RULES) out = out.replace(re, rep as string)
  return out
}
