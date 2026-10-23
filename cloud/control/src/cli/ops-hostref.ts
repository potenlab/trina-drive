// Is the host a team row names still there? `teams retry --reset-host` and `teams set-plan` ask before they act on it.
import type { Cloud } from '../cloud'
import type { TeamRow } from '../db'

export type HostPresence = 'present' | 'gone' | 'unknown'

/** present: the pool lists it (or the driver runs everything on one machine); gone: the pool does not (terminated,
 * replaced) or the cloud says there is no such instance; unknown: it could not be asked. */
export async function hostPresence(cloud: Cloud, t: Pick<TeamRow, 'host' | 'slug'>): Promise<HostPresence> {
  const host = t.host
  if (!host) return 'gone'
  if (cloud.scaler) {
    try {
      const st = await cloud.scaler.pool.status()
      const i = st.instances.find((x) => x.id === host)
      return i && i.lifecycle !== 'terminating' ? 'present' : 'gone'
    } catch { return 'unknown' }
  }
  // no pool: the local and fake drivers run every team on this one machine
  if (cloud.driver.name !== 'aws') return 'present'
  try {
    await cloud.driver.state(host, t.slug)
    return 'present'
  } catch (e) {
    const m = `${(e as Error).message} ${(e as { code?: string }).code ?? ''} ${(e as { detail?: string }).detail ?? ''}`
    return /InvalidInstanceId|not in a valid state|TargetNotConnected|does not exist/i.test(m) ? 'gone' : 'unknown'
  }
}
