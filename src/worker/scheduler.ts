// Admission for isolated jobs: concurrency limits per token, per person and overall, with a fair queue.
// Waiting jobs are kept in one queue per token and served round-robin across tokens, so a flood from one token only ever
// occupies that token's own slots and its own queue; another token's job waits at most for a free global slot.

export interface SchedulerLimits {
  global: number
  perToken: number
  perPerson: number
  /** Jobs one token may have waiting; beyond this, new jobs are refused at once ("busy"). */
  maxQueuedPerToken: number
}

export class Busy extends Error {}
export class Aborted extends Error {}

interface Waiter { person: string; grant: () => void; cancel: () => void }

export class FairScheduler {
  private running = 0
  private byToken = new Map<string, number>()
  private byPerson = new Map<string, number>()
  private queues = new Map<string, Waiter[]>()
  /** tokens with waiters, in service order; the head is served next */
  private ring: string[] = []

  constructor(readonly limits: SchedulerLimits) {}

  get stats() {
    let queued = 0
    for (const q of this.queues.values()) queued += q.length
    return { running: this.running, queued }
  }

  /** Jobs this token is running now. */
  runningFor(token: string) { return this.byToken.get(token) ?? 0 }

  /** Resolves with a release function once the job may run. Throws Busy when the token's queue is full. */
  acquire(token: string, person: string, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new Aborted('aborted'))
    return new Promise((resolve, reject) => {
      let done = false
      const release = () => {
        if (done) return
        done = true
        this.running--
        dec(this.byToken, token)
        dec(this.byPerson, person)
        this.pump()
      }
      const w: Waiter = {
        person,
        grant: () => { signal?.removeEventListener('abort', onAbort); resolve(release) },
        cancel: () => reject(new Aborted('aborted')),
      }
      const onAbort = () => {
        const q = this.queues.get(token)
        const i = q?.indexOf(w) ?? -1
        if (i >= 0) { q!.splice(i, 1); if (!q!.length) this.dropToken(token); w.cancel() }
      }
      if (this.canRun(token, person) && !this.queues.has(token)) { this.take(token, person); w.grant(); return }
      const q = this.queues.get(token) ?? []
      if (q.length >= this.limits.maxQueuedPerToken) { reject(new Busy(`too many jobs waiting for this token (${q.length})`)); return }
      q.push(w)
      if (!this.queues.has(token)) { this.queues.set(token, q); this.ring.push(token) }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pump()
    })
  }

  private canRun(token: string, person: string) {
    return this.running < this.limits.global && (this.byToken.get(token) ?? 0) < this.limits.perToken && (this.byPerson.get(person) ?? 0) < this.limits.perPerson
  }
  private take(token: string, person: string) {
    this.running++
    inc(this.byToken, token)
    inc(this.byPerson, person)
  }
  private dropToken(token: string) {
    this.queues.delete(token)
    const i = this.ring.indexOf(token)
    if (i >= 0) this.ring.splice(i, 1)
  }

  /** Round-robin over tokens with waiters: each pass grants at most one job per token, then that token goes to the back. */
  private pump() {
    let progressed = true
    while (progressed && this.running < this.limits.global && this.ring.length) {
      progressed = false
      for (let n = this.ring.length; n > 0 && this.running < this.limits.global; n--) {
        const token = this.ring.shift()!
        const q = this.queues.get(token)!
        const w = q[0]!
        if (this.canRun(token, w.person)) {
          q.shift()
          this.take(token, w.person)
          w.grant()
          progressed = true
        }
        if (q.length) this.ring.push(token)
        else this.queues.delete(token)
      }
    }
  }
}

const inc = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1)
const dec = (m: Map<string, number>, k: string) => { const v = (m.get(k) ?? 1) - 1; if (v) m.set(k, v); else m.delete(k) }
