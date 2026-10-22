// Public surface of the isolated executor. See docs/worker.md.
import fs from 'node:fs'
import path from 'node:path'
import { defaultExecutor, type CommandResult, type Executor, type FsBackend, type RunOptions, type RunResult, type ShellHooks } from './pool'
import type { ShellJob } from './protocol'

export { closeDefaultExecutor, defaultCodePaths, discardKept, defaultExecutor, Executor, extractExecutor, runIsolated, setBackendErrorHandler, toolReadPaths } from './pool'
export type { BackendDirent, BackendStat, CommandResult, ExecutorConfig, FsBackend, JobLimits, RunOptions, RunResult, RunStats, RunStatus, ShellHooks } from './pool'
export { PROTOCOL_VERSION } from './protocol'
export type { ExtractJob, JobSpec, ShellJob } from './protocol'
export type { Isolation } from './sandbox'
export type { SchedulerLimits } from './scheduler'

type Common = Omit<RunOptions, 'backend' | 'hooks' | 'body' | 'readPaths'> & { executor?: Executor }

/** How a failed run reads in the shell (exit codes follow timeout(1) / a SIGKILLed process). */
export function shellFailure(r: RunResult, name = 'bash'): CommandResult {
  const s = (msg: string, exitCode: number) => ({ stdout: '', stderr: `${name}: ${msg}\n`, exitCode })
  switch (r.status) {
    case 'timeout': return s('the command took too long and was stopped', 124)
    case 'memory': return s('the command used too much memory and was stopped', 137)
    case 'output': return s('the command produced too much output and was stopped', 137)
    case 'busy': return s('too many commands are running for this token; try again shortly', 1)
    case 'aborted': return s('the command was cancelled', 130)
    case 'refused': return s('commands cannot run: the server has no isolated executor available', 1)
    case 'error': return s(`internal error: ${r.error?.message ?? 'unknown'}`, 1)
    default: return s('the command failed unexpectedly', 1)
  }
}

/**
 * Runs one shell command line in an isolated worker against `backend` (the permission-filtered VFS).
 * Returns the shell's result; limit breaches are turned into a shell-like error (see shellFailure).
 * A backend call that throws something other than an fs error is answered with EIO (see FsBackend); the job goes on.
 */
export async function runShellIsolated(
  command: string,
  backend: FsBackend,
  opts: Common & { hooks?: ShellHooks; job?: Omit<ShellJob, 'kind' | 'command'> },
): Promise<CommandResult & { run: RunResult<CommandResult> }> {
  const job: ShellJob = { kind: 'shell', command, ...opts.job }
  const run = await (opts.executor ?? defaultExecutor()).run<CommandResult>(job, { ...opts, backend, hooks: opts.hooks })
  const r = run.status === 'ok' && run.value ? run.value : shellFailure(run)
  return { ...r, run }
}

/** The extractor shipped with the server (main: src/extract/index.ts, export extractText(name, bytes)). */
export const DEFAULT_EXTRACTOR = path.resolve(import.meta.dir, '../extract/index.ts')

/**
 * Extracts the text of one document in an isolated worker.
 *   input = bytes (preferred: the parent opens the file with its no-follow checks; the worker gets no file access, and a
 *           warm worker can be used) or a path (read-granted to that one worker's sandbox; always a fresh worker).
 *   kind  = extension ('pdf', 'docx', ...) or a file name; it picks the parser.
 */
export async function extractIsolated(
  input: string | Uint8Array,
  kind: string,
  opts: Common & { module?: string; fn?: string; options?: Record<string, string> },
): Promise<{ status: RunResult['status']; text?: string; error?: string; run: RunResult }> {
  const name = kind.includes('.') ? kind : `document.${kind}`
  const module = opts.module ?? DEFAULT_EXTRACTOR
  const byPath = typeof input === 'string'
  const run = await (opts.executor ?? defaultExecutor()).run(
    { kind: 'extract', module, fn: opts.fn, name, path: byPath ? fs.realpathSync(input) : undefined, options: opts.options },
    { ...opts, body: byPath ? undefined : input, readPaths: byPath ? [input] : undefined },
  )
  if (run.status === 'ok') return { status: 'ok', text: new TextDecoder().decode(run.body ?? new Uint8Array()), run }
  return { status: run.status, error: run.error?.message ?? run.status, run }
}
