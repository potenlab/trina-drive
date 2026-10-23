// Where the scenarios run: the local stack (cloud/dev/up.sh: Caddy with its own CA on https://*.cloud.localhost:8443,
// operator steps through `docker exec`, mail in .state/outbox.log and .state/team-mail.log) or AWS
// (https://cloud.trina.app and https://<team>.cloud.trina.app with real certificates, a test team given in env).
//
// AWS env (all optional except E2E_TEAM; nothing is printed):
//   E2E_TARGET=aws               choose this target (or --target aws)
//   E2E_DOMAIN=cloud.trina.app   team addresses are https://<team>.<E2E_DOMAIN>
//   E2E_CONTROL=https://cloud.trina.app
//   E2E_TEAM=<slug>              the test team (never trina); its people come from E2E_PEOPLE
//   people: console accounts that are already members of the test team (shape: cloud/dev/e2e/aws-people.example.json;
//                                admin = owner/admin with its console authenticator secret). Like cloud/scripts/aws-smoke.ts,
//                                never from argv or plain env values: E2E_PEOPLE=<file, 0600>, else
//                                ~/.config/trina-drive/e2e/people.json (0600), else the SSM SecureString /tdcloud/e2e/people
//   E2E_OTHER_TEAM=<slug>        a second running team for isolation checks (default: none → those checks skip)
//   E2E_OPS=ssm                  operator steps over SSM Run Command on the control instance (tag tdcloud:role=control,
//                                profile E2E_AWS_PROFILE=tdcloud), as aws-smoke.ts does (cloud/dev/e2e/ops-ssm.ts);
//                                or "<command prefix>"; unset → operator steps skip
//   E2E_STATE_DIR                where run state goes (default: $TMPDIR/trina-e2e-<team>)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type TargetKind = 'local' | 'aws'

export interface Mail { to: string; from?: string; subject: string; text: string; team?: number }

export interface Target {
  kind: TargetKind
  domain: string
  control: string
  teamUrl: (slug: string) => string
  /** fetch TLS options (the local CA) */
  tls: { ca?: string }
  /** PEM of the local CA (NODE_EXTRA_CA_CERTS for real clients) */
  caFile?: string
  stateDir: string
  /** control-plane mail (sign-up, invites, ready) and the teams' own mail; null where it cannot be read (AWS) */
  outbox: (() => Mail[]) | null
  teamMail: (() => Mail[]) | null
  /** the control-plane CLI; null where there is none */
  ops: ((...args: string[]) => Sh) | null
  /** the product CLI inside a team container; null where there is none */
  tdrive: ((slug: string, ...args: string[]) => Sh) | null
  /** a command inside a team container (local only) */
  inTeam: ((slug: string, argv: string[]) => Sh) | null
  /** dev.env of the local stack */
  devEnv: Record<string, string>
  /** the fixture team's slug (the fixture may move it to <base>-<n>: slugs are never reused after a delete) */
  team: string
  otherTeam?: string
}

export interface Sh { code: number; out: string; err: string }

export function sh(argv: string[], input?: string): Sh {
  const p = Bun.spawnSync(argv, { stdin: input !== undefined ? new TextEncoder().encode(input) : 'ignore', stdout: 'pipe', stderr: 'pipe' })
  return { code: p.exitCode ?? -1, out: p.stdout.toString(), err: p.stderr.toString() }
}

const DEV = path.resolve(import.meta.dir, '../..')
export const LOCAL_STATE = path.join(DEV, '.state')

const jsonl = (file: string) => () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Mail) : [])

export function localTarget(team = process.env.E2E_TEAM || 'e2e-h1'): Target {
  const envFile = path.join(LOCAL_STATE, 'dev.env')
  if (!fs.existsSync(envFile)) throw new Error(`the local stack is not up (${envFile} missing): run cloud/dev/up.sh --no-teams (or cloud/dev/up.sh)`)
  const devEnv = Object.fromEntries(fs.readFileSync(envFile, 'utf8').trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
  const domain = devEnv.TDCLOUD_DOMAIN!, port = devEnv.TDCLOUD_PUBLIC_PORT!
  const caFile = path.join(LOCAL_STATE, 'caddy-root.crt')
  const stateDir = path.join(LOCAL_STATE, 'e2e')
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  return {
    kind: 'local', domain, control: `https://${domain}:${port}`, teamUrl: (slug) => `https://${slug}.${domain}:${port}`,
    tls: { ca: fs.readFileSync(caFile, 'utf8') }, caFile, stateDir,
    outbox: jsonl(path.join(LOCAL_STATE, 'outbox.log')), teamMail: jsonl(path.join(LOCAL_STATE, 'team-mail.log')),
    ops: (...args) => sh(['docker', 'exec', 'tdc-control', 'bun', '/app/src/main.ts', ...args]),
    tdrive: (slug, ...args) => sh(['docker', 'exec', `tdc-${slug}`, '/usr/local/bin/tdrive', ...args]),
    inTeam: (slug, argv) => sh(['docker', 'exec', `tdc-${slug}`, ...argv]),
    devEnv, team, otherTeam: process.env.E2E_OTHER_TEAM,
  }
}

export function awsTarget(): Target {
  const team = process.env.E2E_TEAM
  if (!team) throw new Error('AWS target: set E2E_TEAM to the test team slug (and E2E_PEOPLE to its people file)')
  if (team === 'trina') throw new Error('AWS target: never run the scenarios against the dogfood team trina; make a test team')
  const domain = process.env.E2E_DOMAIN || 'cloud.trina.app'
  const control = process.env.E2E_CONTROL || `https://${domain}`
  const stateDir = process.env.E2E_STATE_DIR || path.join(os.tmpdir(), `trina-e2e-${team}`)
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const opsPrefix = process.env.E2E_OPS?.trim() === 'ssm' ? `bun ${path.join(import.meta.dir, '../ops-ssm.ts')}` : process.env.E2E_OPS?.trim()
  return {
    kind: 'aws', domain, control, teamUrl: (slug) => `https://${slug}.${domain}`, tls: {}, stateDir,
    outbox: null, teamMail: null,
    ops: opsPrefix ? (...args) => sh([...opsPrefix.split(/\s+/), ...args]) : null,
    tdrive: opsPrefix ? (slug, ...args) => sh([...opsPrefix.split(/\s+/), 'teams', 'exec', slug, '--', ...args]) : null,
    inTeam: null, devEnv: {}, team, otherTeam: process.env.E2E_OTHER_TEAM,
  }
}

export function makeTarget(kind: TargetKind): Target {
  return kind === 'aws' ? awsTarget() : localTarget()
}
