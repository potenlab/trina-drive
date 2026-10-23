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
  /** data + files on the team volume (XFS project quota on AWS hosts; soft check by the metrics loop locally) */
  diskGb: number
  /** /tmp tmpfs for worker job folders */
  tmpMb: number
}

export const PLANS: Record<PlanId, PlanLimits> = {
  team: { id: 'team', cpus: 1, memoryMb: 2048, pids: 512, diskGb: 50, tmpMb: 256 },
  business: { id: 'business', cpus: 2, memoryMb: 4096, pids: 1024, diskGb: 200, tmpMb: 512 },
}

export const planOf = (id: string | null | undefined): PlanLimits => PLANS[(id as PlanId) in PLANS ? (id as PlanId) : 'team']
