import type { PlanLimits } from '../plans'

/** Everything a driver needs to run one team's instance. */
export interface TeamSpec {
  slug: string
  /** the team's number (never reused); uid = uidBase + number */
  number: number
  uid: number
  /** https://<slug>.<domain>[:port] — OAuth issuer, passkey RP ID, base of mailed links */
  url: string
  plan: PlanLimits
  image: string
  /** extra environment for the team container (written to a 0600 env file / SSM SecureString, never on a command line) */
  env: Record<string, string>
}

export interface ExecResult { code: number; stdout: string; stderr: string }

export interface CreateResult {
  /** printed once by `tdrive init`; mailed to the buyer, never stored */
  setupToken: string
  /** the product's backup SECRET key (`backup keygen`); wrapped by the master key before it is stored */
  productBackupSecret: string
  /** the address the team's DNS record points at (AWS: the host's Elastic IP; local: none) */
  publicIp: string | null
}

export interface BackupArtifact {
  /** product-db: the product's own encrypted archive (database + drafts); files: the sealed tar of the volume */
  part: 'product-db' | 'files'
  name: string
  bytes: number
  sha256: string
  /** local driver: where the file is now (the control plane uploads it to the target, then removes it) */
  localPath?: string
  /** AWS driver: already uploaded by the host to this object key */
  objectKey?: string
}

export type InstanceState = 'running' | 'stopped' | 'missing'

export interface Driver {
  readonly name: string
  /** where a new team goes (local: 'local'; AWS: the least-loaded online host) */
  pickHost(): Promise<string>
  /** network, volume, uid, data directory (init, OAuth address, backup key), container; started and healthy */
  create(host: string, spec: TeamSpec): Promise<CreateResult>
  start(host: string, spec: TeamSpec): Promise<void>
  stop(host: string, slug: string): Promise<void>
  /** container, network and data are removed (call only after the final export) */
  destroy(host: string, slug: string): Promise<void>
  /** apply the plan's limits to the running container */
  setLimits(host: string, spec: TeamSpec): Promise<void>
  /** a new setup token while no admin has finished setup (the mail was lost); null when setup is done */
  reissueSetupToken(host: string, spec: TeamSpec): Promise<string | null>
  state(host: string, slug: string): Promise<InstanceState>
  diskUsage(host: string, slug: string): Promise<number | null>
  /** product archive + sealed files, to `keyPrefix` (AWS: uploaded from the host) */
  backup(host: string, spec: TeamSpec, o: { filesRecipient: string; stamp: string; keyPrefix: string }): Promise<BackupArtifact[]>
  /** the product CLI inside the running container (admin CLI passthrough, the end-to-end test) */
  exec(host: string, slug: string, args: string[]): Promise<ExecResult>
}

export class DriverError extends Error {
  constructor(message: string, readonly detail?: string) { super(message) }
}
