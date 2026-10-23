// What each plan gets on the shared hosts. Paid seats (AI-connected people) are billed by Paddle and not enforced here
// (Free's 3 people are: TDRIVE_MAX_PEOPLE); these are the resource limits of the team's container and its disk quota. Business can move to its own VM later
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
  /** host capacity it takes (TDCLOUD_MAX_TEAMS_PER_HOST slots per host); Free takes a fraction */
  slots: number
  /** room on /data beyond the files (database, drafts, logs) in diskGb */
  headroomGb: number
  /** TDRIVE_MAX_PEOPLE: active people the product allows (null = no limit; paid seats are billed by Paddle) */
  maxPeople: number | null
}

/** room on /data beyond the files: the database, drafts, the search mirror, logs */
export const DATA_HEADROOM_GB = 20

const plan = (id: PlanId, cpus: number, memoryMb: number, pids: number, storageGb: number, tmpMb: number, slots: number, o: { headroomGb?: number; maxPeople?: number } = {}): PlanLimits =>
  ({ id, cpus, memoryMb, pids, storageGb, headroomGb: o.headroomGb ?? DATA_HEADROOM_GB, diskGb: 2 * storageGb + (o.headroomGb ?? DATA_HEADROOM_GB), tmpMb, slots, maxPeople: o.maxPeople ?? null })

export const PLANS: Record<PlanId, PlanLimits> = {
  team: plan('team', 1, 2048, 512, 100, 256, 1),
  // twice the cpu and memory limits: two slots
  business: plan('business', 2, 4096, 1024, 1000, 512, 2),
  // to try it out: 1 GB, 3 people, half a vCPU, 768 MiB (an idle team uses ~170 MiB; one document extraction may take
  // up to 512 MiB), a quarter of a slot — so free teams fill what paid teams leave on a host. Paused after 7 days
  // without activity (free.ts).
  free: plan('free', 0.5, 768, 256, 1, 128, 0.25, { headroomGb: 4, maxPeople: 3 }),
}

/** SQL: the slots a team row takes (matches PLANS) */
export const SLOTS_SQL = "CASE plan WHEN 'business' THEN 2 WHEN 'free' THEN 0.25 ELSE 1 END"

/** slots as people read them: 1, 0.25, 3.75 */
export const fmtSlots = (n: number) => String(Math.round(n * 100) / 100)

export const planOf = (id: string | null | undefined): PlanLimits => PLANS[(id as PlanId) in PLANS ? (id as PlanId) : 'team']
