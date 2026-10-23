// Control-plane configuration, all from the environment (cloud/README.md, "Configuration"). Nothing here is a secret
// except PADDLE_WEBHOOK_SECRET, TDCLOUD_CADDY_ASK_KEY and the master key file: those come from env files (0600) or,
// on AWS, SSM Parameter Store SecureStrings that the control host's systemd unit reads at start.
import path from 'node:path'

export type DriverName = 'local' | 'aws' | 'fake'
export type MailerName = 'outbox' | 'ses'

export interface Config {
  /** production: refuses dev-only pieces (outbox mailer, local master key, http control URL) unless explicitly allowed */
  production: boolean
  /** teams live at https://<slug>.<domain>[:publicPort] — e.g. cloud.trina.app, or cloud.localhost in dev */
  domain: string
  /** the HTTPS port people use (443 in production: omitted from URLs) */
  publicPort: number
  /** the control plane's own public URL (signup, dashboard, Paddle webhook), e.g. https://cloud.trina.app */
  controlUrl: string
  listenHost: string
  listenPort: number
  /** the peer whose X-Forwarded-For is believed (the Caddy in front of the control plane) */
  trustedProxies: string[]
  stateDir: string
  dbFile: string
  driver: DriverName
  /** the Trina Drive image every team runs (pinned tag or digest in production) */
  image: string
  /** docker/seccomp-bwrap.json (read by the docker CLI) and the AppArmor profile name ('' = host without AppArmor) */
  seccompProfile: string
  apparmorProfile: string
  /** the Caddy container the local driver connects to each team network */
  caddyContainer: string
  /** this control plane's own image: hosts run it as a short-lived helper to seal backups and secret outputs */
  helperImage: string
  /** AWS driver: slots per host before a new host is needed (a Team-plan team takes 1, Business 2) */
  maxTeamsPerHost: number
  /** first uid for team containers (each team gets its own uid: uidBase + team number) */
  uidBase: number
  mailer: MailerName
  mailFrom: string
  /** where operator alerts go (failed provisioning, unlinked payments) */
  opsEmail: string
  masterKeyFile: string | null
  kmsKeyId: string | null
  /** dir:/path or s3://bucket/prefix */
  backupTarget: string
  backupKeep: number
  /** hours between automatic backups of each active team */
  backupEveryHours: number
  pastDueGraceDays: number
  canceledGraceDays: number
  deleteAfterDays: number
  /** Caddy's on-demand TLS `ask` must carry ?key=<this> (empty = only from trustedProxies / loopback) */
  caddyAskKey: string
  paddle: {
    env: 'sandbox' | 'live'
    webhookSecret: string
    clientToken: string
    checkIp: boolean
    toleranceSec: number
    /** price id → plan id */
    prices: Record<string, PlanId>
    /** checkout price per plan and cycle (the dashboard's Subscribe buttons) */
    checkout: Partial<Record<`${PlanId}_${'monthly' | 'yearly'}`, string>>
  }
  aws: {
    region: string
    /** SSM-managed hosts carrying this tag value (key tdcloud:role) */
    hostTag: string
    route53ZoneId: string | null
    /** SSM Parameter Store prefix for team env files */
    ssmPrefix: string
  }
  /** metrics: disk usage poll interval (minutes) */
  metricsEveryMinutes: number
}

export type PlanId = 'team' | 'business'

export class ConfigError extends Error {}

const int = (v: string | undefined, dflt: number, name: string) => {
  if (v === undefined || v === '') return dflt
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) throw new ConfigError(`${name} must be a non-negative number`)
  return n
}

/** A DNS name of 2+ labels, lower case, no trailing dot. */
export function checkDomain(d: string): string {
  const v = d.trim().toLowerCase().replace(/\.$/, '')
  if (!/^(?=.{3,200}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(v)) throw new ConfigError(`bad domain: ${d}`)
  return v
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const production = env.TDCLOUD_ENV === 'production'
  const stateDir = path.resolve(env.TDCLOUD_STATE_DIR || '.tdcloud')
  const domain = checkDomain(env.TDCLOUD_DOMAIN || 'cloud.localhost')
  const publicPort = int(env.TDCLOUD_PUBLIC_PORT, 443, 'TDCLOUD_PUBLIC_PORT')
  const port = publicPort === 443 ? '' : `:${publicPort}`
  const controlUrl = (env.TDCLOUD_CONTROL_URL || `https://${domain}${port}`).replace(/\/$/, '')
  const driver = (env.TDCLOUD_DRIVER || 'local') as DriverName
  if (!['local', 'aws', 'fake'].includes(driver)) throw new ConfigError('TDCLOUD_DRIVER must be local, aws or fake')
  const mailer = (env.TDCLOUD_MAILER || 'outbox') as MailerName
  if (!['outbox', 'ses'].includes(mailer)) throw new ConfigError('TDCLOUD_MAILER must be outbox or ses')

  const prices: Record<string, PlanId> = {}
  const checkout: Config['paddle']['checkout'] = {}
  for (const plan of ['team', 'business'] as const) {
    for (const cycle of ['monthly', 'yearly'] as const) {
      const id = env[`PADDLE_PRICE_${plan.toUpperCase()}_${cycle.toUpperCase()}`]
      if (id) { prices[id] = plan; checkout[`${plan}_${cycle}`] = id }
    }
  }

  const cfg: Config = {
    production, domain, publicPort, controlUrl,
    listenHost: env.TDCLOUD_LISTEN_HOST || '127.0.0.1',
    listenPort: int(env.TDCLOUD_LISTEN_PORT, 8790, 'TDCLOUD_LISTEN_PORT'),
    trustedProxies: (env.TDCLOUD_TRUSTED_PROXIES || '').split(',').map((s) => s.trim()).filter(Boolean),
    stateDir,
    dbFile: env.TDCLOUD_DB || path.join(stateDir, 'control.db'),
    driver,
    image: env.TDCLOUD_IMAGE || 'trina-drive:dev',
    seccompProfile: env.TDCLOUD_SECCOMP || path.resolve(import.meta.dir, '../../../docker/seccomp-bwrap.json'),
    apparmorProfile: env.TDCLOUD_APPARMOR ?? 'trina-drive-bwrap',
    caddyContainer: env.TDCLOUD_CADDY_CONTAINER || 'tdc-caddy',
    helperImage: env.TDCLOUD_HELPER_IMAGE || 'tdcloud-control:dev',
    maxTeamsPerHost: int(env.TDCLOUD_MAX_TEAMS_PER_HOST, 20, 'TDCLOUD_MAX_TEAMS_PER_HOST'),
    uidBase: int(env.TDCLOUD_UID_BASE, 20000, 'TDCLOUD_UID_BASE'),
    mailer,
    mailFrom: env.TDCLOUD_MAIL_FROM || 'Trina Cloud <cloud@trina.app>',
    opsEmail: env.TDCLOUD_OPS_EMAIL || 'contact@trina.app',
    masterKeyFile: env.TDCLOUD_MASTER_KEY_FILE || null,
    kmsKeyId: env.TDCLOUD_KMS_KEY_ID || null,
    backupTarget: env.TDCLOUD_BACKUP_TARGET || `dir:${path.join(stateDir, 'backups')}`,
    backupKeep: int(env.TDCLOUD_BACKUP_KEEP, 14, 'TDCLOUD_BACKUP_KEEP'),
    backupEveryHours: int(env.TDCLOUD_BACKUP_EVERY_HOURS, 24, 'TDCLOUD_BACKUP_EVERY_HOURS'),
    pastDueGraceDays: int(env.TDCLOUD_PAST_DUE_GRACE_DAYS, 7, 'TDCLOUD_PAST_DUE_GRACE_DAYS'),
    canceledGraceDays: int(env.TDCLOUD_CANCELED_GRACE_DAYS, 3, 'TDCLOUD_CANCELED_GRACE_DAYS'),
    deleteAfterDays: int(env.TDCLOUD_DELETE_AFTER_DAYS, 30, 'TDCLOUD_DELETE_AFTER_DAYS'),
    caddyAskKey: env.TDCLOUD_CADDY_ASK_KEY || '',
    paddle: {
      env: env.PADDLE_ENV === 'live' || env.PADDLE_ENV === 'production' ? 'live' : 'sandbox',
      webhookSecret: env.PADDLE_WEBHOOK_SECRET || '',
      clientToken: env.PADDLE_CLIENT_TOKEN || '',
      checkIp: env.PADDLE_CHECK_IP === '1',
      toleranceSec: int(env.PADDLE_WEBHOOK_TOLERANCE_SEC, 5, 'PADDLE_WEBHOOK_TOLERANCE_SEC'),
      prices, checkout,
    },
    aws: {
      region: env.AWS_REGION || env.AWS_DEFAULT_REGION || 'ap-northeast-2',
      hostTag: env.TDCLOUD_AWS_HOST_TAG || 'host',
      route53ZoneId: env.TDCLOUD_ROUTE53_ZONE_ID || null,
      ssmPrefix: (env.TDCLOUD_SSM_PREFIX || '/tdcloud').replace(/\/$/, ''),
    },
    metricsEveryMinutes: int(env.TDCLOUD_METRICS_EVERY_MINUTES, 15, 'TDCLOUD_METRICS_EVERY_MINUTES'),
  }

  if (production) {
    const problems: string[] = []
    if (!cfg.controlUrl.startsWith('https://')) problems.push('TDCLOUD_CONTROL_URL must be https')
    if (cfg.mailer === 'outbox') problems.push('TDCLOUD_MAILER=outbox writes setup links to a file: use ses')
    if (!cfg.kmsKeyId && !cfg.masterKeyFile) problems.push('set TDCLOUD_KMS_KEY_ID (or TDCLOUD_MASTER_KEY_FILE)')
    if (!cfg.paddle.webhookSecret) problems.push('PADDLE_WEBHOOK_SECRET is required')
    if (cfg.driver === 'fake') problems.push('TDCLOUD_DRIVER=fake is for tests')
    if (!cfg.caddyAskKey) problems.push('TDCLOUD_CADDY_ASK_KEY is required (Caddy on the hosts reaches the control plane over the VPC)')
    if (problems.length) throw new ConfigError(`production config:\n  - ${problems.join('\n  - ')}`)
  }
  return cfg
}

/** https://<slug>.<domain>[:port] */
export const teamUrl = (cfg: Pick<Config, 'domain' | 'publicPort'>, slug: string) =>
  `https://${slug}.${cfg.domain}${cfg.publicPort === 443 ? '' : `:${cfg.publicPort}`}`
