import type { PlanLimits } from '../plans'
import type { TeamNet } from '../teamnet'

/** Everything a driver needs to run one team's instance. */
export interface TeamSpec {
  slug: string
  /** the team's number (never reused); uid = uidBase + number */
  number: number
  uid: number
  /** https://<slug>.<domain>[:port] — OAuth issuer, passkey RP ID, base of mailed links */
  url: string
  plan: PlanLimits
  /** the team network's fixed subnet and addresses (Caddy's is the one trusted proxy) */
  net: TeamNet
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
  /** a new container from spec.image on the same data (product upgrade); pulls the image first */
  recreate(host: string, spec: TeamSpec): Promise<void>
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

/** One instance of the host pool as the pool sees it (AWS: the Auto Scaling group; local: a simulated count). */
export interface PoolInstance {
  id: string
  /** pending: launched, not in service yet; in_service: running (its bootstrap may not be done); terminating: going */
  lifecycle: 'pending' | 'in_service' | 'terminating' | 'other'
  /** reachable for commands (AWS: SSM agent online). Unknown = true. */
  online: boolean
}

export interface PoolStatus {
  /** how many hosts the pool is asked to run */
  desired: number
  /** the pool's own ceiling (AWS: the ASG's max size, from Terraform) */
  max: number
  instances: PoolInstance[]
}

export interface HostProbe {
  /** the host's bootstrap finished (AWS: /etc/tdcloud/ready, written as its last step) */
  ready: boolean
  /** team directories + team containers found on the host itself: any > 0 means team data is there */
  teams: number
  publicIp: string | null
}

/** The capacity side of a driver: how many team hosts run. The scaler (scaler.ts) is the only caller. */
export interface HostPool {
  readonly name: string
  /** how often a booting host is asked whether it is done (default PROBE_EVERY_MS: an SSM command each time) */
  readonly probeEveryMs?: number
  status(): Promise<PoolStatus>
  /** asks for this many hosts; only ever called to raise the count (scale-in terminates one named host) */
  setDesired(n: number): Promise<void>
  /** asks the host itself; null when it cannot be reached */
  probe(id: string): Promise<HostProbe | null>
  /** scale-in of one empty host: protection off, terminated with the desired count lowered by one. Returns what is left
   * to clean up once it is gone (AWS: its data volume, kept on termination by design). */
  terminate(id: string): Promise<{ volumes: string[] }>
  /** after terminate: deletes what is left; true when nothing is left */
  cleanup(id: string, volumes: string[]): Promise<boolean>
  /** each pass, before the desired count is raised to `desired`: resources new hosts need (AWS: one free Elastic IP per
   * host still to come; extra free ones are released) */
  maintain?(desired: number, status: PoolStatus): Promise<void>
}
