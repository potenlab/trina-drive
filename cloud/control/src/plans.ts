// What each plan gets on the shared hosts. Seats (AI-connected people) are billed by Paddle and not enforced here;
// these are the resource limits of the team's container and its disk quota. Business can move to its own VM later
// (cloud/README.md, "Upgrade path"), with the same container and the same limits as a floor.
import type { PlanId } from './config'

export interface PlanLimits {
  id: PlanId
  /** docker --cpus */
  cpus: number
  /** docker --memory (and --memory-swap: no swap) */
  memoryMb: number
  /** docker --pids-limit */
  pids: number
  /** what the customer buys (the website's pricing): the product's own storage quota, TDRIVE_STORAGE_QUOTA — files,
   * trash, earlier versions and unfinished uploads. The product refuses uploads past it. */
  storageGb: number
  /** the hard cap on the team's directory (XFS project quota on AWS hosts; measured and flagged locally): the files
   * (storageGb), the database, drafts and logs (DATA_HEADROOM_GB), and backup staging — the sealed copy of the files
   * a backup writes before it is shipped (another storageGb at most). A full team can still be backed up. */
  diskGb: number
  /** /tmp tmpfs for worker job folders */
  tmpMb: number
}

/** room on /data beyond the files: the database, drafts, the search mirror, logs */
export const DATA_HEADROOM_GB = 20

const plan = (id: PlanId, cpus: number, memoryMb: number, pids: number, storageGb: number, tmpMb: number): PlanLimits =>
  ({ id, cpus, memoryMb, pids, storageGb, diskGb: 2 * storageGb + DATA_HEADROOM_GB, tmpMb })

export const PLANS: Record<PlanId, PlanLimits> = {
  team: plan('team', 1, 2048, 512, 100, 256),
  business: plan('business', 2, 4096, 1024, 1000, 512),
}

export const planOf = (id: string | null | undefined): PlanLimits => PLANS[(id as PlanId) in PLANS ? (id as PlanId) : 'team']
