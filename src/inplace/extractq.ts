// Background reading of originals the reconciler found new or changed: hash, text extraction into the mirror,
// widened-draft matching. Small files first, a fixed number at a time.
import fs from 'node:fs'
import { extractText } from '../extract'

/**
 * The one call that turns original bytes into text for the index. Another stream moves extraction into an isolated
 * worker: swap the body of this function, nothing else here calls an extractor.
 */
export async function extractForIndex(name: string, bytes: Uint8Array): Promise<string> {
  return extractText(name, bytes)
}

export class IdentityChanged extends Error {}

/**
 * Open an original without following links and check it is still the file the walk saw (identity, size, mtime) and
 * a regular file with one link. Returns the fd; the caller closes it.
 */
export function openOriginal(real: string, want: { dev: string; ino: string; size?: number; mtimeNs?: string }): number {
  const fd = fs.openSync(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
  const st = fs.fstatSync(fd, { bigint: true })
  if (!st.isFile() || String(st.dev) !== want.dev || String(st.ino) !== want.ino ||
    (want.size !== undefined && Number(st.size) !== want.size) || (want.mtimeNs !== undefined && String(st.mtimeNs) !== want.mtimeNs)) {
    fs.closeSync(fd)
    throw new IdentityChanged(real)
  }
  return fd
}

export function readAll(fd: number, size: number): Uint8Array {
  const buf = Buffer.alloc(size)
  let off = 0
  while (off < size) { const n = fs.readSync(fd, buf, off, size - off, off); if (n <= 0) break; off += n }
  return buf.subarray(0, off)
}

interface Job { size: number; run: () => Promise<void> }

/** Small jobs first, at most `concurrency` running. Errors are counted, never thrown at the producer. */
export class ExtractQueue {
  private readonly jobs: Job[] = []
  private running = 0
  private idle: (() => void)[] = []
  errors = 0
  done = 0

  constructor(readonly concurrency = 2) {}

  push(job: Job) {
    // keep sorted by size (binary insert)
    let lo = 0, hi = this.jobs.length
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.jobs[mid]!.size <= job.size) lo = mid + 1; else hi = mid }
    this.jobs.splice(lo, 0, job)
    this.pump()
  }

  get pending() { return this.jobs.length + this.running }

  private pump() {
    while (this.running < this.concurrency && this.jobs.length) {
      const job = this.jobs.shift()!
      this.running++
      job.run().catch(() => { this.errors++ }).finally(() => {
        this.running--
        this.done++
        this.pump()
        if (!this.running && !this.jobs.length) { const w = this.idle; this.idle = []; w.forEach((f) => f()) }
      })
    }
  }

  /** Resolves when nothing is queued or running. */
  drain(): Promise<void> {
    if (!this.running && !this.jobs.length) return Promise.resolve()
    return new Promise((r) => this.idle.push(r))
  }
}
