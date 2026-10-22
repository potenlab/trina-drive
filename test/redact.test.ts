// Audit redaction (plan 7.1 token leak): secrets pasted into a command line are not kept in clear text.
import { describe, expect, test } from 'bun:test'
import { appendAudit, verifyAudit } from '../src/audit'
import { TOKEN_PREFIX } from '../src/config'
import { redactSecrets } from '../src/redact'
import { sha256 } from '../src/store'
import { setup } from './helpers'

// Secret-shaped strings are assembled at run time so this file does not trip secret scanners itself.
const j = (...p: string[]) => p.join('')
const PAT = j(TOKEN_PREFIX, 'AbCd', 'x'.repeat(28))
const SECRETS: [string, string][] = [
  ['tdrive pat', PAT],
  ['tdrive setup', j('tdrive_setup_', 'Q'.repeat(32))],
  ['AWS key id', j('AKIA', 'IOSFODNN7EXAMPLE')],
  ['AWS secret', j('aws_secret_access_key=', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY')],
  ['GitHub classic', j('ghp_', 'a1B2'.repeat(9))],
  ['GitHub fine-grained', j('github_pat_', '11ABCDEFG0', 'x'.repeat(40))],
  ['Slack bot', j('xoxb-', '1234567890-', 'abcdefABCDEF1234')],
  ['Slack webhook', j('https://hooks.slack.com/services/', 'T000/B000/', 'XXXXXXXXXXXXXXXX')],
  ['private key', j('-----BEGIN OPENSSH ', 'PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH ', 'PRIVATE KEY-----')],
  ['Bearer header', j('Authorization: Bearer ', 'eyAbc123def456ghi789')],
  ['bare Bearer', j('Bearer ', 'abcdefghijklmnop1234')],
  ['OpenAI-style', j('sk-', 'proj-', 'Z'.repeat(40))],
  ['JWT', j('eyJhbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiIxMjM0In0', '.', 'abcdefghijkl')],
  ['URL password', j('postgres://app:', 'hunter2hunter2', '@db.local/x')],
  ['password=', j('PASSWORD=', 'correct-horse-9')],
]

describe('redactSecrets', () => {
  test.each(SECRETS)('%s is removed', (_label, secret) => {
    const line = `curl -s -H 'x: y' ${secret} https://example.com | head`
    const out = redactSecrets(line)
    expect(out).toContain('[REDACTED')
    // nothing long of the secret survives (our own tokens keep their 4-character hint)
    const tail = secret.slice(-12)
    expect(out).not.toContain(tail)
    expect(redactSecrets(out)).toBe(out) // idempotent
  })
  test('our token keeps the stored hint so the admin knows which token leaked', () => {
    expect(redactSecrets(`echo ${PAT}`)).toBe(`echo ${TOKEN_PREFIX}AbCd…[REDACTED:token]`)
  })
  test('ordinary commands are left alone', () => {
    for (const c of ['grep -r 매출 /경영', 'cat /drafts/password_list.md', 'write /drafts/a.md (12 bytes, sha256 ' + 'a'.repeat(64) + ')',
      'ls -l /공용 | sort -k5', 'awk -F, \'{print $2}\' /영업/c.csv', 'read /프로젝트/token.md offset=1 limit=2000']) {
      expect(redactSecrets(c)).toBe(c)
    }
  })
})

describe('audit rows', () => {
  test('the stored command line is redacted; the hash covers the original line; the chain verifies', () => {
    const e = setup()
    try {
      const cmd = `echo ${PAT} ${SECRETS[4]![1]} > /drafts/x.md`
      appendAudit(e.db, { personId: null, tokenId: null, tool: 'bash', command: cmd, files: [`/drafts/${PAT}.md`], outcome: 'ok' })
      const row = e.db.query<{ command: string; command_sha256: string; files: string }, []>('SELECT command, command_sha256, files FROM audit ORDER BY id DESC LIMIT 1').get()!
      expect(row.command).not.toContain(PAT)
      expect(row.command).not.toContain(SECRETS[4]![1])
      expect(row.files).not.toContain(PAT)
      expect(row.command_sha256).toBe(sha256(cmd))
      expect(verifyAudit(e.db).ok).toBe(true)
    } finally { e.cleanup() }
  })
  test('a secret straddling the 4 KB cut is redacted before cutting', () => {
    const e = setup()
    try {
      const cmd = 'x'.repeat(4096 - 20) + ' ' + PAT
      appendAudit(e.db, { personId: null, tokenId: null, tool: 'bash', command: cmd, files: [], outcome: 'ok' })
      const row = e.db.query<{ command: string }, []>('SELECT command FROM audit ORDER BY id DESC LIMIT 1').get()!
      expect(row.command).not.toContain(PAT.slice(0, TOKEN_PREFIX.length + 8))
    } finally { e.cleanup() }
  })
})
