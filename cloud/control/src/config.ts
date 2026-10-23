// Control-plane configuration, all from the environment (cloud/README.md, "Configuration"). Nothing here is a secret
// except PADDLE_WEBHOOK_SECRET, TDCLOUD_CADDY_ASK_KEY and the master key file: those come from env files (0600) or,
// on AWS, SSM Parameter Store SecureStrings that the control host's systemd unit reads at start. The Resend API key is
// not in the environment at all: only the name of its SecureString (or of a 0600 file), read when mail goes out.
import path from 'node:path'
import { resendSettings, type ResendSettings } from './resend'
import { smtpSettings, type SmtpSettings } from './smtp'
import { parsePool } from './teamnet'

/** 10.128.0.0–10.159.255.255: clear of the VPC (10.42.0.0/16), Docker's default pools and the dev network */
export const DEFAULT_TEAM_SUBNETS = '10.128.0.0/11'

export type DriverName = 'local' | 'aws' | 'fake'
export type MailerName = 'outbox' | 'resend' | 'ses' | 'smtp'
/** how team instances send mail (invites, password resets, notifications): through the host's mail relay (SES on AWS,
 * a file sink in dev), into a file inside the team's volume, or not at all */
export type TeamMailerName = 'relay' | 'outbox' | 'off'

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
  /** the scaler (scaler.ts): hosts are launched when a team finds no room and terminated when empty. Off: a fixed pool
   * (AWS: every SSM-online host; local: one host 'local'). */
  autoscale: boolean
  /** the most hosts the scaler runs (also bounded by the ASG's max size) */
  maxHosts: number
  /** free slots kept ready ahead of demand (0: hosts start only when a paid team needs one) */
  spareSlots: number
  /** a host without any team for this long is terminated (its data volume deleted) */
  emptyHostGraceMs: number
  /** a launched host whose bootstrap has not finished by then is replaced */
  hostBootTimeoutMs: number
  /** ops are told when a paid team has waited this long for a host */
  hostWaitAlertMs: number
  /** how often the scaler looks at the pool when nothing is happening (more often while a team waits or a host boots) */
  scalerEveryMs: number
  /** local driver: how long a simulated host takes to "boot" */
  localHostBootMs: number
  /** first uid for team containers (each team gets its own uid: uidBase + team number) */
  uidBase: number
  mailer: MailerName
  mailFrom: string
  /** TDCLOUD_MAILER=resend: where the API key is (SSM parameter or 0600 file) and the API's URL */
  resend: ResendSettings
  /** TDCLOUD_MAILER=smtp */
  smtp: SmtpSettings
  /** where operator alerts go (failed provisioning, unlinked payments) */
  opsEmail: string
  teamMailer: TeamMailerName
  /** From of every team instance's mail (one SES identity; the relay and the host role's IAM allow only this address) */
  teamMailFrom: string
  /** the relay's port on each team network's gateway (the host) */
  mailRelayPort: number
  /** the pool every team network's /28 comes from (teamnet.ts); the same on every host and in the relay */
  teamSubnets: string
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
    /** the team hosts' Auto Scaling group */
    asgName: string
  }
  /** metrics: disk usage poll interval (minutes) */
  metricsEveryMinutes: number
  /** the Free plan (free.ts; README "Free plan") */
  free: FreeConfig
  /** Trina Cloud SSO (docs/SSO-CONTRACT.md): teams get the TDRIVE_CLOUD_* env and TDRIVE_SSO_ONLY, the "ready" mail
   * links to the console instead of carrying a setup token, membership is synced to each drive. TDCLOUD_SSO=0 is the
   * pre-console behaviour (a rollback with an older product image). Default: on, except with the test driver. */
  sso: boolean
}

export interface FreeConfig {
  /** free teams that may exist at once (not deleted); verified sign-ups beyond it join the waitlist */
  maxTeams: number
  /** the share of each host's slots free teams may take (the rest stays for paid teams) */
  hostShare: number
  /** free teams never make the scaler launch the last this-many hosts the limit allows (they are for paid teams) */
  reserveHosts: number
  /** how long a free sign-up's confirmation link works */
  verifyTtlMs: number
  /** free sign-up requests per client address: per hour and per day */
  signupsPerIpHour: number
  signupsPerIpDay: number
  /** extra disposable-mail domains refused (on top of the built-in list) */
  blockedDomains: string[]
  /** Cloudflare Turnstile on the free sign-up form; off when the secret is empty */
  turnstileSecret: string
  turnstileSiteKey: string
  /** how often a running free team is asked when people last used it (`tdrive activity`) */
  activityEveryMs: number
  /** no activity for this long: the owner is warned; then the team is paused (container stopped, data kept) */
  idleWarnMs: number
  idlePauseMs: number
  /** a team woken from the paused page that nobody then uses is paused again after this (no mail) */
  wakeGraceMs: number
  /** paused this long: deleted after a final backup; the owner is warned at each of deleteWarnMs */
  deleteAfterMs: number
  deleteWarnMs: number[]
  /** a deleted free team's final backup is kept this long */
  finalBackupKeepMs: number
  /** daily backups kept per free team (paid: backupKeep) */
  backupKeep: number
}

export type PlanId = 'team' | 'business' | 'free'

export class ConfigError extends Error {}

const int = (v: string | undefined, dflt: number, name: string) => {
  if (v === undefined || v === '') return dflt
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) throw new ConfigError(`${name} must be a non-negative number`)
  return n
}

const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3600_000, d: 86400_000 }
/** "6h", "30m", "45s", "500ms", "2d"; a bare number is in `bareUnit` */
export function parseDuration(v: string | undefined, dflt: string, name: string, bareUnit: keyof typeof UNITS = 'h'): number {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?\s*$/.exec(v === undefined || v === '' ? dflt : v)
  if (!m) throw new ConfigError(`${name} must be a duration like 6h, 30m or 45s`)
  return Math.round(Number(m[1]) * UNITS[m[2] ?? bareUnit]!)
}

/** "Name <a@b.c>" or "a@b.c" → a@b.c (lower case), or null. */
export function mailAddress(from: string): string | null {
  const m = /<([^<>\s]+@[^<>\s]+)>\s*$/.exec(from) ?? /^\s*([^<>\s]+@[^<>\s]+)\s*$/.exec(from)
  return m ? m[1]!.toLowerCase() : null
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
  if (!['outbox', 'resend', 'ses', 'smtp'].includes(mailer)) throw new ConfigError('TDCLOUD_MAILER must be outbox, resend, ses or smtp')
  let resend: ResendSettings, smtp: SmtpSettings
  try { resend = resendSettings(env); smtp = smtpSettings(env) } catch (e) { throw new ConfigError((e as Error).message) }
  const teamMailer = (env.TDCLOUD_TEAM_MAILER || 'relay') as TeamMailerName
  if (!['relay', 'outbox', 'off'].includes(teamMailer)) throw new ConfigError('TDCLOUD_TEAM_MAILER must be relay, outbox or off')
  const teamSubnets = env.TDCLOUD_TEAM_SUBNETS || DEFAULT_TEAM_SUBNETS
  try { parsePool(teamSubnets) } catch (e) { throw new ConfigError((e as Error).message) }

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
    maxTeamsPerHost: Math.max(1, int(env.TDCLOUD_MAX_TEAMS_PER_HOST, 20, 'TDCLOUD_MAX_TEAMS_PER_HOST')),
    autoscale: env.TDCLOUD_AUTOSCALE !== undefined && env.TDCLOUD_AUTOSCALE !== '' ? env.TDCLOUD_AUTOSCALE === '1' : driver !== 'fake',
    maxHosts: int(env.TDCLOUD_MAX_HOSTS, 3, 'TDCLOUD_MAX_HOSTS'),
    spareSlots: int(env.TDCLOUD_SPARE_SLOTS, 0, 'TDCLOUD_SPARE_SLOTS'),
    emptyHostGraceMs: parseDuration(env.TDCLOUD_EMPTY_HOST_GRACE, '6h', 'TDCLOUD_EMPTY_HOST_GRACE'),
    hostBootTimeoutMs: parseDuration(env.TDCLOUD_HOST_BOOT_TIMEOUT, '15m', 'TDCLOUD_HOST_BOOT_TIMEOUT', 'm'),
    hostWaitAlertMs: parseDuration(env.TDCLOUD_HOST_WAIT_ALERT, '15m', 'TDCLOUD_HOST_WAIT_ALERT', 'm'),
    scalerEveryMs: parseDuration(env.TDCLOUD_SCALER_EVERY, '60s', 'TDCLOUD_SCALER_EVERY', 's'),
    localHostBootMs: parseDuration(env.TDCLOUD_LOCAL_HOST_BOOT, '5s', 'TDCLOUD_LOCAL_HOST_BOOT', 's'),
    uidBase: int(env.TDCLOUD_UID_BASE, 20000, 'TDCLOUD_UID_BASE'),
    mailer,
    mailFrom: env.TDCLOUD_MAIL_FROM || 'Trina Cloud <cloud@trina.app>',
    resend, smtp,
    opsEmail: env.TDCLOUD_OPS_EMAIL || 'contact@trina.app',
    teamMailer,
    teamMailFrom: env.TDCLOUD_TEAM_MAIL_FROM || 'Trina Drive <drive@trina.app>',
    mailRelayPort: int(env.TDCLOUD_MAIL_RELAY_PORT, 8025, 'TDCLOUD_MAIL_RELAY_PORT'),
    teamSubnets,
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
      asgName: env.TDCLOUD_ASG_NAME || 'tdcloud-hosts',
    },
    metricsEveryMinutes: int(env.TDCLOUD_METRICS_EVERY_MINUTES, 15, 'TDCLOUD_METRICS_EVERY_MINUTES'),
    free: freeConfig(env),
    sso: env.TDCLOUD_SSO !== undefined && env.TDCLOUD_SSO !== '' ? env.TDCLOUD_SSO === '1' : driver !== 'fake',
  }

  if (!mailAddress(cfg.teamMailFrom)) throw new ConfigError(`TDCLOUD_TEAM_MAIL_FROM is not a mail address: ${cfg.teamMailFrom}`)
  if (production) {
    const problems: string[] = []
    if (!cfg.controlUrl.startsWith('https://')) problems.push('TDCLOUD_CONTROL_URL must be https')
    if (cfg.mailer === 'outbox') problems.push('TDCLOUD_MAILER=outbox writes setup links to a file: use resend (or ses)')
    if (cfg.mailer === 'resend' && !cfg.resend.keyParam) problems.push('TDCLOUD_MAILER=resend needs TDCLOUD_RESEND_API_KEY_PARAM (the SSM SecureString with the key)')
    if (cfg.teamMailer === 'outbox') problems.push('TDCLOUD_TEAM_MAILER=outbox keeps invites inside the team volume: use relay')
    if (!cfg.kmsKeyId && !cfg.masterKeyFile) problems.push('set TDCLOUD_KMS_KEY_ID (or TDCLOUD_MASTER_KEY_FILE)')
    if (!cfg.paddle.webhookSecret) problems.push('PADDLE_WEBHOOK_SECRET is required')
    if (cfg.driver === 'fake') problems.push('TDCLOUD_DRIVER=fake is for tests')
    if (!cfg.caddyAskKey) problems.push('TDCLOUD_CADDY_ASK_KEY is required (Caddy on the hosts reaches the control plane over the VPC)')
    if (problems.length) throw new ConfigError(`production config:\n  - ${problems.join('\n  - ')}`)
  }
  return cfg
}

function freeConfig(env: Record<string, string | undefined>): FreeConfig {
  const share = int(env.TDCLOUD_FREE_HOST_SHARE, 0.5, 'TDCLOUD_FREE_HOST_SHARE')
  if (share <= 0 || share > 1) throw new ConfigError('TDCLOUD_FREE_HOST_SHARE must be more than 0 and at most 1')
  const d = (k: string, dflt: string) => parseDuration(env[k], dflt, k, 'd')
  const warns = (env.TDCLOUD_FREE_DELETE_WARNINGS || '60d,83d').split(',').map((x) => x.trim()).filter(Boolean)
    .map((x) => parseDuration(x, x, 'TDCLOUD_FREE_DELETE_WARNINGS', 'd')).sort((a, b) => a - b)
  const f: FreeConfig = {
    // 0 = public free sign-up closed (owner decision O2, plan 10.1): confirmed sign-ups join the waitlist
    maxTeams: int(env.TDCLOUD_MAX_FREE_TEAMS, 0, 'TDCLOUD_MAX_FREE_TEAMS'),
    hostShare: share,
    reserveHosts: int(env.TDCLOUD_FREE_RESERVE_HOSTS, 1, 'TDCLOUD_FREE_RESERVE_HOSTS'),
    verifyTtlMs: parseDuration(env.TDCLOUD_FREE_VERIFY_TTL, '24h', 'TDCLOUD_FREE_VERIFY_TTL'),
    signupsPerIpHour: int(env.TDCLOUD_FREE_SIGNUPS_PER_IP_HOUR, 5, 'TDCLOUD_FREE_SIGNUPS_PER_IP_HOUR'),
    signupsPerIpDay: int(env.TDCLOUD_FREE_SIGNUPS_PER_IP_DAY, 20, 'TDCLOUD_FREE_SIGNUPS_PER_IP_DAY'),
    blockedDomains: (env.TDCLOUD_FREE_BLOCKED_DOMAINS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean),
    turnstileSecret: env.TDCLOUD_TURNSTILE_SECRET || '',
    turnstileSiteKey: env.TDCLOUD_TURNSTILE_SITE_KEY || '',
    activityEveryMs: parseDuration(env.TDCLOUD_FREE_ACTIVITY_EVERY, '1h', 'TDCLOUD_FREE_ACTIVITY_EVERY'),
    idleWarnMs: d('TDCLOUD_FREE_IDLE_WARN', '6d'),
    idlePauseMs: d('TDCLOUD_FREE_IDLE_PAUSE', '7d'),
    wakeGraceMs: parseDuration(env.TDCLOUD_FREE_WAKE_GRACE, '1h', 'TDCLOUD_FREE_WAKE_GRACE'),
    deleteAfterMs: d('TDCLOUD_FREE_DELETE_AFTER', '90d'),
    deleteWarnMs: warns,
    finalBackupKeepMs: d('TDCLOUD_FREE_FINAL_BACKUP_KEEP', '30d'),
    backupKeep: Math.max(1, int(env.TDCLOUD_FREE_BACKUP_KEEP, 3, 'TDCLOUD_FREE_BACKUP_KEEP')),
  }
  if (f.idleWarnMs >= f.idlePauseMs) throw new ConfigError('TDCLOUD_FREE_IDLE_WARN must be shorter than TDCLOUD_FREE_IDLE_PAUSE')
  if (f.deleteWarnMs.some((w) => w >= f.deleteAfterMs)) throw new ConfigError('TDCLOUD_FREE_DELETE_WARNINGS must come before TDCLOUD_FREE_DELETE_AFTER')
  if (!!f.turnstileSecret !== !!f.turnstileSiteKey) throw new ConfigError('set both TDCLOUD_TURNSTILE_SECRET and TDCLOUD_TURNSTILE_SITE_KEY (or neither)')
  return f
}

/** https://<slug>.<domain>[:port] */
export const teamUrl = (cfg: Pick<Config, 'domain' | 'publicPort'>, slug: string) =>
  `https://${slug}.${cfg.domain}${cfg.publicPort === 443 ? '' : `:${cfg.publicPort}`}`
